import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  buildPartialCalibrationPack,
  type PartialCalibrationPack,
} from "./calibrationPack";
import type { PartialEvaluationPack } from "./evaluationPack";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";

const SAFE_PACK_ID = /^calibration-smoke-[a-f0-9]{16}$/;
const SAFE_CALIBRATION_PACK_ID = /^calibration-pack-[a-f0-9]{16}$/;
type ImmutableCalibrationRecord = PartialEvaluationPack | PartialCalibrationPack;

export interface PersistContentAddressedJsonInput<T> {
  readonly artifact: T;
  readonly outputDirectory: string;
  readonly filenamePrefix: string;
  readonly expectedArtifactId: string;
}

export interface PersistWriteOnceFileInput {
  readonly filePath: string;
  readonly bytes: string | Uint8Array;
  readonly assertExistingMatches: (filePath: string) => Promise<void>;
  readonly assertPublishedFile?: (filePath: string) => Promise<void>;
  readonly requireTemporaryCleanup?: boolean;
}

export interface PersistWriteOnceFileClaim {
  readonly path: string;
  readonly created: boolean;
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function syncDirectoryAfterNamespaceMutation(
  directory: string,
): Promise<void> {
  const directoryHandle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function assertSafeDirectory(
  directory: string,
  label: string,
): Promise<void> {
  let stat;
  let canonical;
  try {
    stat = await lstat(directory);
    canonical = await realpath(directory);
  } catch (error) {
    throw new TypeError(`${label} 디렉터리를 안전하게 검증할 수 없습니다.`, {
      cause: error,
    });
  }
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== 0o700
    || canonical !== resolve(directory)
  ) {
    throw new TypeError(
      `${label}는 ancestor symlink가 없는 canonical 0700 실제 디렉터리여야 합니다.`,
    );
  }
}

function assertDirectArtifactChild(
  rootDirectory: string,
  artifactDirectory: string,
): void {
  if (resolve(dirname(artifactDirectory)) !== resolve(rootDirectory)) {
    throw new TypeError(
      "write-once artifact 디렉터리는 지정된 root의 직접 하위여야 합니다.",
    );
  }
}

/**
 * 최종 파일의 O_NOFOLLOW만으로는 부모 artifact 디렉터리 symlink를 막을 수 없습니다.
 * 파일을 공개하기 전에 root와 직접 하위 artifact 디렉터리를 lstat로 잠급니다.
 */
export async function prepareWriteOnceArtifactDirectory({
  rootDirectory,
  artifactDirectory,
}: {
  readonly rootDirectory: string;
  readonly artifactDirectory: string;
}): Promise<void> {
  assertDirectArtifactChild(rootDirectory, artifactDirectory);
  await assertSafeDirectory(rootDirectory, "write-once root");
  try {
    await mkdir(artifactDirectory, { mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }
  await assertSafeDirectory(artifactDirectory, "write-once artifact");
  // EEXIST가 생성 중인 동시 호출이나 이전 fsync 실패에서 왔을 수 있으므로,
  // 검증된 child를 사용할 모든 호출이 부모 namespace 내구성을 확정합니다.
  await syncDirectoryAfterNamespaceMutation(rootDirectory);
}

export async function assertExistingWriteOnceArtifactDirectory({
  rootDirectory,
  artifactDirectory,
}: {
  readonly rootDirectory: string;
  readonly artifactDirectory: string;
}): Promise<void> {
  assertDirectArtifactChild(rootDirectory, artifactDirectory);
  await assertSafeDirectory(rootDirectory, "write-once root");
  await assertSafeDirectory(artifactDirectory, "write-once artifact");
}

async function assertExistingRecordMatches(
  filePath: string,
  pack: unknown,
  expectedDigest: string,
): Promise<void> {
  try {
    const existingFile = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let existingBytes: Buffer;
    try {
      const existingStat = await existingFile.stat();
      if (
        !existingStat.isFile()
        || (existingStat.mode & 0o777) !== 0o600
        || existingStat.nlink !== 1
      ) {
        throw new Error("기존 Evaluation Pack 파일 형식 또는 권한이 올바르지 않습니다.");
      }
      existingBytes = await existingFile.readFile();
    } finally {
      await existingFile.close();
    }
    const existingPack = JSON.parse(existingBytes.toString("utf8")) as unknown;
    const existingCanonicalJson = canonicalJsonStringify(existingPack);
    const expectedCanonicalJson = canonicalJsonStringify(pack);
    if (
      sha256CanonicalJson(existingPack) !== expectedDigest
      || existingCanonicalJson !== expectedCanonicalJson
    ) {
      throw new Error("같은 digest 경로의 기존 Evaluation Pack 내용이 일치하지 않습니다.");
    }
  } catch (error) {
    if (
      error instanceof Error
      && error.message === "같은 digest 경로의 기존 Evaluation Pack 내용이 일치하지 않습니다."
    ) {
      throw error;
    }
    throw new Error(
      "같은 digest 경로의 기존 Evaluation Pack 내용이 일치하지 않습니다.",
      { cause: error },
    );
  }
}

interface WriteOnceFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly nlink: number;
}

async function readCanonicalWriteOnceFileIdentity(
  filePath: string,
  { allowMultipleLinks = false }: { readonly allowMultipleLinks?: boolean } = {},
): Promise<WriteOnceFileIdentity> {
  const requestedPath = resolve(filePath);
  const parentDirectory = dirname(requestedPath);
  await assertSafeDirectory(parentDirectory, "write-once file parent");
  let handle;
  try {
    handle = await open(
      requestedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    const canonicalPath = await realpath(requestedPath);
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || (!allowMultipleLinks && stat.nlink !== 1)
      || canonicalPath !== join(parentDirectory, basename(requestedPath))
    ) {
      throw new TypeError(
        "write-once final file은 canonical 0600 single-link regular file이어야 합니다.",
      );
    }
    return Object.freeze({
      dev: stat.dev,
      ino: stat.ino,
      nlink: stat.nlink,
    });
  } finally {
    await handle?.close();
  }
}

async function convergePublishedWriteOnceFile({
  filePath,
  assertExistingMatches,
}: Pick<PersistWriteOnceFileInput, "filePath" | "assertExistingMatches">): Promise<boolean> {
  const requestedPath = resolve(filePath);
  const parentDirectory = dirname(requestedPath);
  let published: WriteOnceFileIdentity;
  try {
    published = await readCanonicalWriteOnceFileIdentity(requestedPath, {
      allowMultipleLinks: true,
    });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }

  if (published.nlink > 1) {
    const fileName = basename(requestedPath);
    const temporaryPrefixes = [
      `.${fileName}.tmp-`,
      // cleanup receipt의 이전 writer가 사용한 `.json` 생략 prefix도
      // 같은 inode일 때만 crash recovery 대상으로 허용합니다.
      ...(fileName.endsWith(".json")
        ? [`.${fileName.slice(0, -".json".length)}.tmp-`]
        : []),
    ];
    for (const entry of await readdir(parentDirectory)) {
      if (!temporaryPrefixes.some((prefix) => entry.startsWith(prefix))) continue;
      const temporaryPath = join(parentDirectory, entry);
      let temporary;
      try {
        temporary = await lstat(temporaryPath);
      } catch (error) {
        // readdir 뒤 다른 정상 writer가 자신의 temporary entry를 정리할 수
        // 있으므로, namespace에서 이미 사라진 항목만 건너뜁니다.
        if (hasErrorCode(error, "ENOENT")) continue;
        throw error;
      }
      if (
        temporary.isSymbolicLink()
        || !temporary.isFile()
        || (temporary.mode & 0o777) !== 0o600
      ) {
        throw new TypeError("write-once temporary file이 안전한 regular 0600 file이 아닙니다.");
      }
      if (temporary.dev !== published.dev || temporary.ino !== published.ino) {
        continue;
      }
      try {
        await unlink(temporaryPath);
      } catch (error) {
        // 동일 inode를 확인한 뒤 다른 정상 writer가 먼저 정리한 ENOENT만
        // 허용합니다. 그 외 unlink 실패는 저장 성공으로 숨기지 않습니다.
        if (!hasErrorCode(error, "ENOENT")) throw error;
      }
      await syncDirectoryAfterNamespaceMutation(parentDirectory);
    }
    published = await readCanonicalWriteOnceFileIdentity(requestedPath, {
      allowMultipleLinks: true,
    });
  }
  if (published.nlink !== 1) {
    throw new TypeError(
      "write-once final file에 foreign hard-link가 있어 canonical record로 사용할 수 없습니다.",
    );
  }
  await assertExistingMatches(requestedPath);
  return true;
}

export async function persistWriteOnceFileWithClaim({
  filePath,
  bytes,
  assertExistingMatches,
  assertPublishedFile = assertExistingMatches,
  requireTemporaryCleanup = false,
}: PersistWriteOnceFileInput): Promise<PersistWriteOnceFileClaim> {
  const requestedPath = resolve(filePath);
  const parentDirectory = dirname(requestedPath);
  if (join(parentDirectory, basename(requestedPath)) !== requestedPath) {
    throw new TypeError("write-once final file은 검증된 parent의 직접 하위여야 합니다.");
  }
  await assertSafeDirectory(parentDirectory, "write-once file parent");
  const temporaryPath = join(
    parentDirectory,
    `.${basename(requestedPath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let temporaryCreated = false;
  let operationFailed = false;
  let destinationCreated = false;

  try {
    const temporaryFile = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      const buffer = typeof bytes === "string"
        ? Buffer.from(bytes, "utf8")
        : Buffer.from(bytes);
      await temporaryFile.writeFile(buffer);
      await temporaryFile.sync();
    } finally {
      await temporaryFile.close();
    }

    try {
      // 닫혀 있고 동기화된 inode만 목적 경로에 원자적으로 공개합니다.
      await link(temporaryPath, requestedPath);
      destinationCreated = true;
      await syncDirectoryAfterNamespaceMutation(parentDirectory);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      await convergePublishedWriteOnceFile({
        filePath: requestedPath,
        assertExistingMatches,
      });
    }

    if (destinationCreated) {
      // link 직후 nlink=2인 inode는 같은 inode temporary entry만 제거해
      // crash-after-link 재실행도 canonical nlink=1 상태로 수렴합니다.
      await convergePublishedWriteOnceFile({
        filePath: requestedPath,
        assertExistingMatches: assertPublishedFile,
      });
      await assertPublishedFile(requestedPath);
      temporaryCreated = false;
    }

    return { path: requestedPath, created: destinationCreated };
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    if (temporaryCreated) {
      try {
        await unlink(temporaryPath);
        await syncDirectoryAfterNamespaceMutation(parentDirectory);
      } catch (cleanupError) {
        if (!operationFailed || requireTemporaryCleanup) {
          throw cleanupError;
        }
      }
    }
  }
}

export async function persistWriteOnceFile(
  input: PersistWriteOnceFileInput,
): Promise<string> {
  // 기존 보정(calibration) API와 반환 형식은 그대로 유지합니다.
  return (await persistWriteOnceFileWithClaim(input)).path;
}

export async function persistContentAddressedJson<T>({
  artifact,
  outputDirectory,
  filenamePrefix,
  expectedArtifactId,
}: PersistContentAddressedJsonInput<T>): Promise<string> {
  const serializedJson = JSON.stringify(artifact, null, 2);
  if (serializedJson === undefined) {
    throw new TypeError("Evaluation Pack을 JSON으로 직렬화할 수 없습니다.");
  }
  const serialized = `${serializedJson}\n`;
  const snapshot = JSON.parse(serialized) as unknown;
  const recordDigest = sha256CanonicalJson(snapshot);

  if (recordDigest !== expectedArtifactId) {
    throw new TypeError(
      "기대 artifact ID가 저장할 canonical JSON의 SHA-256과 일치하지 않습니다.",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filenamePrefix)) {
    throw new TypeError("filenamePrefix는 안전한 단일 파일 이름이어야 합니다.");
  }

  const filePath = join(outputDirectory, `${filenamePrefix}-${recordDigest}.json`);
  return persistWriteOnceFile({
    filePath,
    bytes: serialized,
    assertExistingMatches: (existingPath) => (
      assertExistingRecordMatches(existingPath, snapshot, recordDigest)
    ),
  });
}

async function persistImmutableCalibrationRecord(
  pack: ImmutableCalibrationRecord,
  directory: string,
): Promise<string> {
  const recordDigest = sha256CanonicalJson(pack);
  return persistContentAddressedJson({
    artifact: pack,
    outputDirectory: directory,
    filenamePrefix: `${pack.pack_id}--record`,
    expectedArtifactId: recordDigest,
  });
}

export async function persistPartialEvaluationPack(
  pack: PartialEvaluationPack,
  directory: string,
): Promise<string> {
  const snapshot = JSON.parse(JSON.stringify(pack)) as PartialEvaluationPack;
  if (
    snapshot.artifact_kind !== "PARTIAL_EVALUATION_PACK"
    || snapshot.source !== "CALIBRATION_SMOKE"
    || snapshot.evaluation_status !== "EVALUATION_INCOMPLETE"
    || !SAFE_PACK_ID.test(snapshot.pack_id)
  ) {
    throw new Error("Calibration smoke 저장기는 부분 평가팩만 저장할 수 있습니다.");
  }
  return persistImmutableCalibrationRecord(snapshot, directory);
}

export async function persistPartialCalibrationPack(
  pack: PartialCalibrationPack,
  directory: string,
): Promise<string> {
  const snapshot = JSON.parse(JSON.stringify(pack)) as PartialCalibrationPack;
  if (
    snapshot.artifact_kind !== "PARTIAL_CALIBRATION_PACK"
    || snapshot.source !== "CALIBRATION_SMOKE"
    || snapshot.evaluation_status !== "EVALUATION_INCOMPLETE"
    || !SAFE_CALIBRATION_PACK_ID.test(snapshot.pack_id)
  ) {
    throw new Error("Calibration Pack 저장기는 부분 A/B/C calibration pack만 저장할 수 있습니다.");
  }
  const rebuilt = buildPartialCalibrationPack({
    entries: snapshot.entries,
    createdAt: snapshot.created_at,
  });
  if (canonicalJsonStringify(rebuilt) !== canonicalJsonStringify(snapshot)) {
    throw new Error("Calibration Pack의 상위 필드 또는 child 구조가 잠긴 계약과 다릅니다.");
  }
  return persistImmutableCalibrationRecord(snapshot, directory);
}

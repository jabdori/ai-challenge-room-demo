import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import { persistWriteOnceFileWithClaim } from "./persistence";

type JsonRecord = Record<string, unknown>;

export interface CanonicalAuthorityPackPaths {
  readonly outputDirectory: string;
  readonly executionDirectory: string;
  readonly claimPath: string;
  readonly recordPath: string;
}

interface CanonicalWrapper<T> {
  readonly payload_sha256: string;
  readonly payload: T;
}

const CLAIM_FILENAME = /^([a-z][a-z0-9-]*)--claim\.json$/;
const RECORD_FILENAME = /^([a-z][a-z0-9-]*)--record-([a-f0-9]{64})\.json$/;

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertContained(
  parent: string,
  child: string,
  location: string,
): void {
  const fromParent = relative(resolve(parent), resolve(child));
  if (
    fromParent.length === 0
    || fromParent === ".."
    || fromParent.startsWith(`..${sep}`)
    || isAbsolute(fromParent)
  ) {
    throw new TypeError(`${location}은 검증된 root 하위여야 합니다.`);
  }
}

async function assertRealDirectory(
  directory: string,
  location: string,
): Promise<void> {
  let stat;
  let canonical;
  try {
    stat = await lstat(directory);
    canonical = await realpath(directory);
  } catch (error) {
    throw new TypeError(`${location} 디렉터리를 안전하게 검증할 수 없습니다.`, {
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
      `${location}은 ancestor symlink가 없는 canonical 0700 실제 디렉터리여야 합니다.`,
    );
  }
}

async function syncDirectoryAfterNamespaceMutation(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertCanonicalAuthorityPackFilePaths(
  paths: CanonicalAuthorityPackPaths,
  expectedPayloadSha256?: string,
): void {
  const executionDirectory = resolve(paths.executionDirectory);
  const claimPath = resolve(paths.claimPath);
  const recordPath = resolve(paths.recordPath);
  if (
    claimPath === recordPath
    || resolve(dirname(claimPath)) !== executionDirectory
    || resolve(dirname(recordPath)) !== executionDirectory
  ) {
    throw new TypeError(
      "권위 팩 claim과 record는 execution 디렉터리의 서로 다른 직접 자식이어야 합니다.",
    );
  }
  const claimFilename = basename(claimPath);
  const recordFilename = basename(recordPath);
  if (
    claimPath !== join(executionDirectory, claimFilename)
    || recordPath !== join(executionDirectory, recordFilename)
  ) {
    throw new TypeError("권위 팩 claim과 record path가 canonical execution leaf가 아닙니다.");
  }
  const claimMatch = CLAIM_FILENAME.exec(claimFilename);
  const recordMatch = RECORD_FILENAME.exec(recordFilename);
  if (
    claimMatch === null
    || recordMatch === null
    || claimMatch[1] !== recordMatch[1]
    || (expectedPayloadSha256 !== undefined && recordMatch[2] !== expectedPayloadSha256)
  ) {
    throw new TypeError("권위 팩 claim과 record filename이 canonical builder 계약과 다릅니다.");
  }
}

export async function prepareCanonicalAuthorityPackDirectory(
  paths: CanonicalAuthorityPackPaths,
): Promise<void> {
  if (resolve(dirname(paths.executionDirectory)) !== resolve(paths.outputDirectory)) {
    throw new TypeError("권위 팩 execution 디렉터리는 output root의 직접 하위여야 합니다.");
  }
  assertContained(paths.outputDirectory, paths.executionDirectory, "권위 팩 execution 디렉터리");
  assertCanonicalAuthorityPackFilePaths(paths);
  await assertRealDirectory(paths.outputDirectory, "권위 팩 output root");
  try {
    await mkdir(paths.executionDirectory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }
  await assertRealDirectory(paths.executionDirectory, "권위 팩 execution");
  await syncDirectoryAfterNamespaceMutation(paths.outputDirectory);
}

export async function assertExistingCanonicalAuthorityPackDirectory(
  paths: CanonicalAuthorityPackPaths,
): Promise<void> {
  if (resolve(dirname(paths.executionDirectory)) !== resolve(paths.outputDirectory)) {
    throw new TypeError("권위 팩 execution 디렉터리는 output root의 직접 하위여야 합니다.");
  }
  assertContained(paths.outputDirectory, paths.executionDirectory, "권위 팩 execution 디렉터리");
  assertCanonicalAuthorityPackFilePaths(paths);
  await assertRealDirectory(paths.outputDirectory, "권위 팩 output root");
  await assertRealDirectory(paths.executionDirectory, "권위 팩 execution");
}

export function canonicalAuthorityWrapperBytes<T>(payload: T): Buffer {
  return Buffer.from(`${canonicalJsonStringify({
    payload_sha256: sha256CanonicalJson(payload),
    payload,
  } satisfies CanonicalWrapper<T>)}\n`, "utf8");
}

export async function readCanonicalAuthorityFile<T>({
  path,
  expectedPayload,
  location,
  allowedLinkCounts = [1],
}: {
  readonly path: string;
  readonly expectedPayload: T;
  readonly location: string;
  readonly allowedLinkCounts?: readonly number[];
}): Promise<T> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || !allowedLinkCounts.includes(stat.nlink)
    ) {
      throw new TypeError(`${location}은 regular 0600 file이어야 합니다.`);
    }
    const bytes = await handle.readFile();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw new TypeError(`${location} JSON을 해석할 수 없습니다.`, { cause: error });
    }
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
      || Object.getPrototypeOf(parsed) !== Object.prototype
    ) {
      throw new TypeError(`${location} wrapper는 plain JSON 객체여야 합니다.`);
    }
    const record = parsed as JsonRecord;
    if (
      Object.keys(record).sort().join(",") !== "payload,payload_sha256"
      || typeof record.payload_sha256 !== "string"
      || sha256CanonicalJson(record.payload) !== record.payload_sha256
    ) {
      throw new TypeError(`${location} wrapper hash 무결성이 다릅니다.`);
    }
    const expectedBytes = canonicalAuthorityWrapperBytes(expectedPayload);
    if (!bytes.equals(expectedBytes)) {
      throw new TypeError(`${location} bytes가 authoritative canonical 내용과 다릅니다.`);
    }
    return JSON.parse(canonicalJsonStringify(record.payload)) as T;
  } finally {
    await handle?.close();
  }
}

async function publishExclusive({
  path,
  bytes,
  location,
}: {
  readonly path: string;
  readonly bytes: Buffer;
  readonly location: string;
}): Promise<void> {
  const parsed = JSON.parse(bytes.toString("utf8")) as CanonicalWrapper<unknown>;
  await persistWriteOnceFileWithClaim({
    filePath: path,
    bytes,
    assertExistingMatches: async (existingPath) => {
      await readCanonicalAuthorityFile({
        path: existingPath,
        expectedPayload: parsed.payload,
        location,
      });
    },
    assertPublishedFile: async (publishedPath) => {
      await readCanonicalAuthorityFile({
        path: publishedPath,
        expectedPayload: parsed.payload,
        location,
      });
    },
    requireTemporaryCleanup: true,
  });
}

export async function persistCanonicalAuthorityPack({
  paths,
  claim,
  payload,
  claimLocation,
  recordLocation,
}: {
  readonly paths: CanonicalAuthorityPackPaths;
  readonly claim: unknown;
  readonly payload: unknown;
  readonly claimLocation: string;
  readonly recordLocation: string;
}): Promise<void> {
  assertCanonicalAuthorityPackFilePaths(paths, sha256CanonicalJson(payload));
  await prepareCanonicalAuthorityPackDirectory(paths);
  await publishExclusive({
    path: paths.claimPath,
    bytes: canonicalAuthorityWrapperBytes(claim),
    location: claimLocation,
  });
  await publishExclusive({
    path: paths.recordPath,
    bytes: canonicalAuthorityWrapperBytes(payload),
    location: recordLocation,
  });
  await assertExistingCanonicalAuthorityPackDirectory(paths);
  await readCanonicalAuthorityFile({
    path: paths.claimPath,
    expectedPayload: claim,
    location: claimLocation,
  });
  await readCanonicalAuthorityFile({
    path: paths.recordPath,
    expectedPayload: payload,
    location: recordLocation,
  });
}

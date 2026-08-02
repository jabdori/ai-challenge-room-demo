import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { canonicalJsonStringify } from "../runtime/canonicalJson";

function hasErrorCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertDirectChild(
  rootDirectory: string,
  artifactDirectory: string,
): void {
  const root = resolve(rootDirectory);
  const child = resolve(artifactDirectory);
  const relativePath = relative(root, child);
  if (
    resolve(dirname(child)) !== root
    || relativePath.length === 0
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new TypeError(
      "lifecycle artifact 디렉터리는 검증된 output root의 직접 하위여야 합니다.",
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertCanonicalDirectory(
  directory: string,
  label: string,
): Promise<void> {
  let stat;
  let canonical;
  try {
    stat = await lstat(directory);
    canonical = await realpath(directory);
  } catch (error) {
    throw new TypeError(`${label}을 안전하게 검증할 수 없습니다.`, {
      cause: error,
    });
  }
  if (
    canonical !== resolve(directory)
    || !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== 0o700
  ) {
    throw new TypeError(
      `${label}은 symlink ancestor가 없는 canonical 0700 디렉터리여야 합니다.`,
    );
  }
}

export async function prepareCanonicalLifecycleDirectory({
  rootDirectory,
  artifactDirectory,
}: {
  readonly rootDirectory: string;
  readonly artifactDirectory: string;
}): Promise<void> {
  assertDirectChild(rootDirectory, artifactDirectory);
  await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
  await assertCanonicalDirectory(rootDirectory, "lifecycle output root");
  try {
    await mkdir(artifactDirectory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }
  await assertCanonicalDirectory(
    artifactDirectory,
    "lifecycle artifact directory",
  );
  // 새 child 생성과 동시 EEXIST 재개 모두 부모 namespace를 내구화합니다.
  await syncDirectory(rootDirectory);
}

export async function assertCanonicalLifecycleDirectory({
  rootDirectory,
  artifactDirectory,
}: {
  readonly rootDirectory: string;
  readonly artifactDirectory: string;
}): Promise<void> {
  assertDirectChild(rootDirectory, artifactDirectory);
  await assertCanonicalDirectory(rootDirectory, "lifecycle output root");
  await assertCanonicalDirectory(
    artifactDirectory,
    "lifecycle artifact directory",
  );
}

export function canonicalLifecycleBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJsonStringify(value)}\n`, "utf8");
}

export async function readCanonicalLifecycleFile({
  path,
  label,
  allowedLinkCounts = [1],
}: {
  readonly path: string;
  readonly label: string;
  readonly allowedLinkCounts?: readonly number[];
}): Promise<{ readonly bytes: Buffer; readonly value: unknown }> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || !allowedLinkCounts.includes(stat.nlink)
    ) {
      throw new TypeError(
        `${label}은 외부 hard-link가 없는 regular 0600 file이어야 합니다.`,
      );
    }
    const bytes = await handle.readFile();
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw new TypeError(`${label} JSON을 해석할 수 없습니다.`, {
        cause: error,
      });
    }
    if (!bytes.equals(canonicalLifecycleBytes(value))) {
      throw new TypeError(`${label} bytes가 canonical JSON과 다릅니다.`);
    }
    return Object.freeze({ bytes, value });
  } finally {
    await handle?.close();
  }
}

async function assertExactFile(
  path: string,
  expectedBytes: Buffer,
  label: string,
  allowedLinkCounts: readonly number[],
): Promise<void> {
  const actual = await readCanonicalLifecycleFile({
    path,
    label,
    allowedLinkCounts,
  });
  if (!actual.bytes.equals(expectedBytes)) {
    throw new TypeError(`${label}의 기존 bytes가 write-once claim과 다릅니다.`);
  }
}

/**
 * 동기화한 임시 inode를 hard-link로 단 한 번 공개하고, 임시 이름 제거와
 * 디렉터리 fsync 뒤 최종 nlink=1을 다시 확인합니다.
 */
export async function persistCanonicalLifecycleFile({
  rootDirectory,
  artifactDirectory,
  filePath,
  value,
  label,
}: {
  readonly rootDirectory: string;
  readonly artifactDirectory: string;
  readonly filePath: string;
  readonly value: unknown;
  readonly label: string;
}): Promise<{ readonly path: string; readonly created: boolean }> {
  await prepareCanonicalLifecycleDirectory({
    rootDirectory,
    artifactDirectory,
  });
  if (
    resolve(dirname(filePath)) !== resolve(artifactDirectory)
    || basename(filePath) !== filePath.slice(filePath.lastIndexOf("/") + 1)
  ) {
    throw new TypeError(`${label} 경로가 lifecycle artifact 디렉터리 밖입니다.`);
  }
  const bytes = canonicalLifecycleBytes(value);
  const temporaryPath = resolve(
    artifactDirectory,
    `.${basename(filePath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let temporaryCreated = false;
  let destinationCreated = false;
  let operationError: unknown = null;
  try {
    const temporary = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await temporary.writeFile(bytes);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    try {
      await link(temporaryPath, filePath);
      destinationCreated = true;
      await syncDirectory(artifactDirectory);
      await assertExactFile(filePath, bytes, label, [2]);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      await assertExactFile(filePath, bytes, label, [1]);
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (temporaryCreated) {
      try {
        await unlink(temporaryPath);
        await syncDirectory(artifactDirectory);
      } catch (cleanupError) {
        if (operationError === null) throw cleanupError;
      }
    }
  }
  await assertCanonicalLifecycleDirectory({
    rootDirectory,
    artifactDirectory,
  });
  await assertExactFile(filePath, bytes, label, [1]);
  return Object.freeze({ path: filePath, created: destinationCreated });
}

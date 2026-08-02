import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { CleanupReceipt } from "../demo/liveCleanupReceipt";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  persistWriteOnceFileWithClaim,
  prepareWriteOnceArtifactDirectory,
} from "../pack/persistence";
export {
  buildCleanupReceipt,
  type CleanupReceipt,
} from "../demo/liveCleanupReceipt";

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

const LEGACY_EMPTY_PUBLICATION_LOCK = Buffer.alloc(0);
export const LEGACY_LOCK_STALE_AFTER_MS = 5 * 60_000;

interface LegacyLockObservation {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
  readonly mode: number;
  readonly nlink: number;
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

async function assertExistingReceipt(
  filePath: string,
  receipt: CleanupReceipt,
  digest: string,
  allowedLinkCounts: readonly number[] = [1],
): Promise<void> {
  let handle;
  try {
    const requestedPath = resolve(filePath);
    handle = await open(
      requestedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const descriptor = await handle.stat();
    const canonicalPath = await realpath(requestedPath);
    const canonicalParent = await realpath(dirname(requestedPath));
    if (
      !descriptor.isFile()
      || !allowedLinkCounts.includes(descriptor.nlink)
      || (descriptor.mode & 0o777) !== 0o600
      || canonicalPath !== join(canonicalParent, basename(requestedPath))
    ) {
      throw new Error("cleanup receipt는 canonical 0600 single-link regular file이어야 합니다.");
    }
    const text = await handle.readFile({ encoding: "utf8" });
    const existing = JSON.parse(text) as unknown;
    if (
      sha256CanonicalJson(existing) !== digest
      || canonicalJsonStringify(existing) !== canonicalJsonStringify(receipt)
    ) {
      throw new Error("같은 digest 경로의 cleanup receipt 내용이 일치하지 않습니다.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("digest 경로")) {
      throw error;
    }
    throw new Error("같은 digest 경로의 cleanup receipt 내용이 일치하지 않습니다.", {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

function sameLegacyLockObservation(
  left: LegacyLockObservation,
  right: LegacyLockObservation,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

async function inspectExactLegacyPublicationLock(
  lockPath: string,
  directory: string,
): Promise<LegacyLockObservation | null> {
  const expectedPath = join(resolve(directory), basename(lockPath));
  if (resolve(lockPath) !== expectedPath) {
    throw new Error("cleanup receipt legacy publish lock 경로가 직접 자식이 아닙니다.");
  }
  let handle;
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw new Error("cleanup receipt legacy publish lock을 안전하게 열 수 없습니다.", {
      cause: error,
    });
  }
  try {
    const descriptor = await handle.stat();
    const canonicalDirectory = await realpath(directory);
    const canonicalLockPath = await realpath(lockPath);
    const bytes = await handle.readFile();
    if (
      !descriptor.isFile()
      || descriptor.nlink !== 1
      || (descriptor.mode & 0o777) !== 0o600
      || descriptor.size !== LEGACY_EMPTY_PUBLICATION_LOCK.length
      || !bytes.equals(LEGACY_EMPTY_PUBLICATION_LOCK)
      || canonicalDirectory !== resolve(directory)
      || canonicalLockPath !== join(canonicalDirectory, basename(lockPath))
    ) {
      throw new Error(
        "cleanup receipt legacy publish lock은 exact empty 0600 single-link regular file이어야 합니다.",
      );
    }
    return {
      dev: descriptor.dev,
      ino: descriptor.ino,
      mtimeMs: descriptor.mtimeMs,
      size: descriptor.size,
      mode: descriptor.mode & 0o777,
      nlink: descriptor.nlink,
    };
  } finally {
    await handle.close();
  }
}

/**
 * fresh legacy owner의 lease는 보존하고, 만료된 ownerless lock만 복구합니다.
 * 새 writer와 구 writer의 동시 실행은 fresh lease 보호 범위 밖에서 지원하지 않습니다.
 */
async function migrateExpiredLegacyPublicationLock(
  lockPath: string,
  directory: string,
  nowMs: number,
): Promise<void> {
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("cleanup receipt legacy lock lease 시각이 유효하지 않습니다.");
  }
  const observed = await inspectExactLegacyPublicationLock(lockPath, directory);
  if (observed === null) return;
  if (nowMs - observed.mtimeMs <= LEGACY_LOCK_STALE_AFTER_MS) {
    throw new Error(
      "cleanup receipt legacy publish lock lease가 아직 active이므로 retry later 해야 합니다.",
    );
  }

  const rechecked = await inspectExactLegacyPublicationLock(lockPath, directory);
  if (rechecked === null) return;
  const pathStat = await lstat(lockPath);
  const current: LegacyLockObservation = {
    dev: pathStat.dev,
    ino: pathStat.ino,
    mtimeMs: pathStat.mtimeMs,
    size: pathStat.size,
    mode: pathStat.mode & 0o777,
    nlink: pathStat.nlink,
  };
  if (
    !sameLegacyLockObservation(observed, rechecked)
    || !sameLegacyLockObservation(observed, current)
  ) {
    throw new Error(
      "cleanup receipt legacy publish lock 관찰값이 변경되어 stale recovery를 중단합니다.",
    );
  }
  await unlink(lockPath);
  await syncDirectoryAfterNamespaceMutation(directory);
}

interface PersistCleanupReceiptOptions {
  readonly now?: () => number;
}

export async function persistCleanupReceipt(
  receipt: CleanupReceipt,
  directory: string,
  { now = Date.now }: PersistCleanupReceiptOptions = {},
): Promise<string> {
  const snapshot = JSON.parse(canonicalJsonStringify(receipt)) as CleanupReceipt;
  const digest = sha256CanonicalJson(snapshot);
  const requestedDirectory = resolve(directory);
  const parentDirectory = dirname(requestedDirectory);
  if (join(parentDirectory, basename(requestedDirectory)) !== requestedDirectory) {
    throw new Error("cleanup receipt directory는 검증된 parent의 직접 하위여야 합니다.");
  }
  await prepareWriteOnceArtifactDirectory({
    rootDirectory: parentDirectory,
    artifactDirectory: requestedDirectory,
  });
  const filePath = join(requestedDirectory, `cleanup-receipt--${digest}.json`);
  const lockPath = join(
    requestedDirectory,
    `.cleanup-receipt--${digest}.publish-lock`,
  );
  await migrateExpiredLegacyPublicationLock(lockPath, requestedDirectory, now());
  await persistWriteOnceFileWithClaim({
    filePath,
    bytes: `${canonicalJsonStringify(snapshot)}\n`,
    assertExistingMatches: (path) => assertExistingReceipt(path, snapshot, digest),
    assertPublishedFile: (path) => assertExistingReceipt(path, snapshot, digest),
    requireTemporaryCleanup: true,
  });
  return filePath;
}

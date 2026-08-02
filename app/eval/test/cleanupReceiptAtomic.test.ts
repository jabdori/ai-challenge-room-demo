// @vitest-environment node

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const writeBarrier = vi.hoisted(() => ({
  enabled: false,
  started: null as null | (() => void),
  release: Promise.resolve() as Promise<void>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!writeBarrier.enabled || args[1] !== "wx") {
        return handle;
      }
      return {
        chmod: handle.chmod.bind(handle),
        writeFile: async (...writeArgs: Parameters<typeof handle.writeFile>) => {
          writeBarrier.started?.();
          await writeBarrier.release;
          return handle.writeFile(...writeArgs);
        },
        sync: handle.sync.bind(handle),
        close: handle.close.bind(handle),
      };
    }),
  };
});

import {
  chmod,
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import {
  LEGACY_LOCK_STALE_AFTER_MS,
  buildCleanupReceipt,
  persistCleanupReceipt,
} from "../cli/cleanupReceipt";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  TEST_RESOURCE_IDS,
  completeCleanup,
} from "./helpers/calibrationCommandFixtures";

describe("cleanup receipt atomic publish", () => {
  it("파일 write·sync가 끝나기 전에는 최종 digest 경로를 노출하지 않는다", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "cleanup-receipt-atomic-")));
    const receipt = buildCleanupReceipt({
      expectedResources: TEST_RESOURCE_IDS,
      cleanup: completeCleanup(),
      createdAt: "2026-07-17T00:00:00.000Z",
    });
    const finalPath = join(
      directory,
      `cleanup-receipt--${sha256CanonicalJson(receipt)}.json`,
    );
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let releaseWrite!: () => void;
    writeBarrier.release = new Promise<void>((resolve) => { releaseWrite = resolve; });
    writeBarrier.started = notifyStarted;
    writeBarrier.enabled = true;

    const pending = persistCleanupReceipt(receipt, directory);
    await started;
    await expect(readFile(finalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    releaseWrite();
    expect(await pending).toBe(finalPath);
    writeBarrier.enabled = false;
    expect(JSON.parse(await readFile(finalPath, "utf8"))).toEqual(receipt);
    expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("기존 최종 receipt가 canonical 0600 단일-link regular file이 아니면 재사용을 거부한다", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "cleanup-receipt-integrity-")));
    const receipt = buildCleanupReceipt({
      expectedResources: TEST_RESOURCE_IDS,
      cleanup: completeCleanup(),
      createdAt: "2026-07-17T00:00:00.000Z",
    });
    const finalPath = await persistCleanupReceipt(receipt, directory);
    await link(finalPath, join(directory, "linked-copy.json"));

    await expect(persistCleanupReceipt(receipt, directory)).rejects.toThrow(
      /single|link|receipt|안전/i,
    );
  });

  it("열린 fresh legacy publish lock은 제거하거나 receipt를 쓰지 않고 retry later로 fail-closed 한다", async () => {
    const directory = await realpath(await mkdtemp(
      join(tmpdir(), "cleanup-receipt-active-legacy-lock-"),
    ));
    await chmod(directory, 0o700);
    const receipt = buildCleanupReceipt({
      expectedResources: TEST_RESOURCE_IDS,
      cleanup: completeCleanup(),
      createdAt: "2026-07-18T01:00:00.000Z",
    });
    const digest = sha256CanonicalJson(receipt);
    const lockPath = join(directory, `.cleanup-receipt--${digest}.publish-lock`);
    const finalPath = join(directory, `cleanup-receipt--${digest}.json`);
    await writeFile(lockPath, "", { flag: "wx", mode: 0o600 });
    const now = Date.now();
    const activeHandle = await open(lockPath, "r");

    try {
      await expect(persistCleanupReceipt(receipt, directory, {
        now: () => now,
      })).rejects.toThrow(/active|retry|lease|lock/i);

      expect(await readFile(lockPath, "utf8")).toBe("");
      expect((await lstat(lockPath)).nlink).toBe(1);
      await expect(readFile(finalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await activeHandle.close();
    }
  });

  it("legacy lease 임계 직전 lock은 보호하고 receipt를 쓰지 않는다", async () => {
    const directory = await realpath(await mkdtemp(
      join(tmpdir(), "cleanup-receipt-legacy-boundary-before-"),
    ));
    await chmod(directory, 0o700);
    const receipt = buildCleanupReceipt({
      expectedResources: TEST_RESOURCE_IDS,
      cleanup: completeCleanup(),
      createdAt: "2026-07-18T01:01:00.000Z",
    });
    const digest = sha256CanonicalJson(receipt);
    const lockPath = join(directory, `.cleanup-receipt--${digest}.publish-lock`);
    const finalPath = join(directory, `cleanup-receipt--${digest}.json`);
    const now = Date.UTC(2026, 6, 18, 1, 1, 0);
    await writeFile(lockPath, "", { flag: "wx", mode: 0o600 });
    await utimes(
      lockPath,
      new Date(now - LEGACY_LOCK_STALE_AFTER_MS + 1),
      new Date(now - LEGACY_LOCK_STALE_AFTER_MS + 1),
    );

    await expect(persistCleanupReceipt(receipt, directory, { now: () => now }))
      .rejects.toThrow(/active|retry|lease|lock/i);

    expect(await readFile(lockPath, "utf8")).toBe("");
    await expect(readFile(finalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("legacy lease 임계 직후의 exact empty lock만 제거하고 같은 receipt를 canonical 최종 파일로 수렴한다", async () => {
    const directory = await realpath(await mkdtemp(
      join(tmpdir(), "cleanup-receipt-legacy-lock-"),
    ));
    await chmod(directory, 0o700);
    const receipt = buildCleanupReceipt({
      expectedResources: TEST_RESOURCE_IDS,
      cleanup: completeCleanup(),
      createdAt: "2026-07-18T01:00:00.000Z",
    });
    const digest = sha256CanonicalJson(receipt);
    const lockPath = join(directory, `.cleanup-receipt--${digest}.publish-lock`);
    const finalPath = join(directory, `cleanup-receipt--${digest}.json`);
    const now = Date.UTC(2026, 6, 18, 1, 2, 0);
    await writeFile(lockPath, "", { flag: "wx", mode: 0o600 });
    await utimes(
      lockPath,
      new Date(now - LEGACY_LOCK_STALE_AFTER_MS - 1),
      new Date(now - LEGACY_LOCK_STALE_AFTER_MS - 1),
    );

    await expect(persistCleanupReceipt(receipt, directory, { now: () => now }))
      .resolves.toBe(finalPath);
    await expect(persistCleanupReceipt(receipt, directory, { now: () => now }))
      .resolves.toBe(finalPath);

    expect(await readdir(directory)).toEqual([finalPath.split("/").at(-1)]);
    const published = await lstat(finalPath);
    expect(published.mode & 0o777).toBe(0o600);
    expect(published.nlink).toBe(1);
  });

  it("stale tampered·symlink·hardlink legacy lock은 외부 파일을 바꾸지 않고 fail-closed 한다", async () => {
    const receipt = buildCleanupReceipt({
      expectedResources: TEST_RESOURCE_IDS,
      cleanup: completeCleanup(),
      createdAt: "2026-07-18T01:01:00.000Z",
    });
    const digest = sha256CanonicalJson(receipt);
    const now = Date.UTC(2026, 6, 18, 1, 3, 0);
    const staleDate = new Date(now - LEGACY_LOCK_STALE_AFTER_MS - 1);

    for (const kind of ["tampered", "symlink", "hardlink"] as const) {
      const directory = await realpath(await mkdtemp(
        join(tmpdir(), `cleanup-receipt-legacy-${kind}-`),
      ));
      const outside = await realpath(await mkdtemp(
        join(tmpdir(), `cleanup-receipt-legacy-${kind}-outside-`),
      ));
      await Promise.all([chmod(directory, 0o700), chmod(outside, 0o700)]);
      const lockPath = join(directory, `.cleanup-receipt--${digest}.publish-lock`);
      const outsidePath = join(outside, "foreign-lock");
      await writeFile(outsidePath, "", { flag: "wx", mode: 0o600 });
      if (kind === "tampered") {
        await writeFile(lockPath, "foreign\n", { flag: "wx", mode: 0o600 });
        await utimes(lockPath, staleDate, staleDate);
      } else if (kind === "symlink") {
        await symlink(outsidePath, lockPath);
        await utimes(outsidePath, staleDate, staleDate);
      } else {
        await link(outsidePath, lockPath);
        await utimes(outsidePath, staleDate, staleDate);
      }

      await expect(persistCleanupReceipt(receipt, directory, { now: () => now })).rejects.toThrow(
        /lock|legacy|0600|single|link|안전/i,
      );

      expect(await readFile(outsidePath, "utf8")).toBe("");
      expect(await readdir(outside)).toEqual(["foreign-lock"]);
      if (kind === "hardlink") expect((await lstat(outsidePath)).nlink).toBe(2);
      if (kind === "symlink") expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
      if (kind === "tampered") expect(await readFile(lockPath, "utf8")).toBe("foreign\n");
    }
  });

  it("link 뒤 temp unlink 전에 중단된 writer의 같은 inode temp를 재실행으로 수렴한다", async () => {
    const directory = await realpath(await mkdtemp(
      join(tmpdir(), "cleanup-receipt-crash-recovery-"),
    ));
    await chmod(directory, 0o700);
    const receipt = buildCleanupReceipt({
      expectedResources: TEST_RESOURCE_IDS,
      cleanup: completeCleanup(),
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    const digest = sha256CanonicalJson(receipt);
    const finalPath = join(directory, `cleanup-receipt--${digest}.json`);
    const crashedTemporaryPath = join(
      directory,
      `.cleanup-receipt--${digest}.tmp-crash-recovery`,
    );
    await writeFile(finalPath, `${canonicalJsonStringify(receipt)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await link(finalPath, crashedTemporaryPath);

    await expect(persistCleanupReceipt(receipt, directory)).resolves.toBe(finalPath);

    expect((await lstat(finalPath)).nlink).toBe(1);
    expect(await readdir(directory)).toEqual([finalPath.split("/").at(-1)]);
  });
});

// @vitest-environment node

import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCleanupReceipt, persistCleanupReceipt } from "../cli/cleanupReceipt";
import {
  buildCleanupReceipt as buildWorkerSafeCleanupReceipt,
} from "../demo/liveCleanupReceipt";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import {
  TEST_RESOURCE_IDS,
  completeCleanup,
} from "./helpers/calibrationCommandFixtures";

describe("cleanup API acknowledgement receipt", () => {
  it("Worker-safe pure builder와 기존 CLI public import가 같은 receipt 계약을 만든다", () => {
    const input = {
      expectedResources: {
        vectorStoreId: "vs-private-pure-builder",
        uploadedFileIds: ["file-private-pure-builder"],
      },
      cleanup: {
        vectorStore: {
          id: "vs-private-pure-builder",
          attempted: true,
          deleted: true,
        },
        uploadedFiles: [{
          id: "file-private-pure-builder",
          attempted: true,
          deleted: true,
        }],
      },
      createdAt: "2026-07-19T00:00:00.000Z",
    } as const;

    expect(buildCleanupReceipt(input)).toEqual(
      buildWorkerSafeCleanupReceipt(input),
    );
  });

  it("full resource ID와 delete ack를 보존하고 비밀값은 제거한 0600 canonical write-once artifact다", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "cleanup-receipt-")));
    const secret = ["sk", "receipt-malicious-secret-1234567890"].join("-");
    const cleanup = completeCleanup();
    cleanup.vectorStore.deleted = false;
    cleanup.vectorStore.error = `delete failed ${secret}`;
    const receipt = buildCleanupReceipt({
      expectedResources: TEST_RESOURCE_IDS,
      cleanup,
      runtimeErrors: [new Error(`runtime failed ${secret}`)],
      sensitiveValues: [secret],
      createdAt: "2026-07-17T00:00:00.000Z",
    });

    const firstPath = await persistCleanupReceipt(receipt, directory);
    const frozenTime = new Date("2025-01-01T00:00:00.000Z");
    await utimes(firstPath, frozenTime, frozenTime);
    const secondPath = await persistCleanupReceipt(receipt, directory);
    const storedText = await readFile(firstPath, "utf8");
    const stored = JSON.parse(storedText);

    expect(secondPath).toBe(firstPath);
    expect(firstPath).toMatch(/cleanup-receipt--[a-f0-9]{64}\.json$/);
    expect(firstPath).toContain(sha256CanonicalJson(stored));
    expect((await stat(firstPath)).mode & 0o777).toBe(0o600);
    expect((await stat(firstPath)).mtimeMs).toBe(frozenTime.getTime());
    expect(stored.expected_resources).toEqual({
      vector_store_id: TEST_RESOURCE_IDS.vectorStoreId,
      uploaded_file_ids: TEST_RESOURCE_IDS.uploadedFileIds,
    });
    expect(stored.deletion_semantics).toMatch(/API_ACKNOWLEDGEMENT_ONLY/);
    expect(stored.api_delete_acknowledgements.vector_store).toMatchObject({
      attempted: true,
      deleted: false,
    });
    expect(storedText).not.toContain(secret);
    expect(storedText).toContain("[REDACTED]");

    await chmod(firstPath, 0o600);
    await writeFile(firstPath, "{}\n", "utf8");
    await expect(persistCleanupReceipt(receipt, directory)).rejects.toThrow(
      /digest.*내용|canonical|0600|single-link/i,
    );
  });

  it("동일 receipt 동시 저장은 완성된 단일 파일로 수렴하고 임시 partial 파일을 남기지 않는다", async () => {
    const directory = await realpath(await mkdtemp(
      join(tmpdir(), "cleanup-receipt-concurrent-"),
    ));
    const receipt = buildCleanupReceipt({
      expectedResources: TEST_RESOURCE_IDS,
      cleanup: completeCleanup(),
      createdAt: "2026-07-17T00:00:00.000Z",
    });
    const paths = await Promise.all(
      Array.from({ length: 12 }, () => persistCleanupReceipt(receipt, directory)),
    );
    expect(new Set(paths).size).toBe(1);
    expect(JSON.parse(await readFile(paths[0], "utf8"))).toEqual(receipt);
    expect(await readdir(directory)).toEqual([paths[0].split("/").at(-1)]);
    const published = await lstat(paths[0]);
    expect(published.mode & 0o777).toBe(0o600);
    expect(published.nlink).toBe(1);
  });

  it("기존 receipt mode가 0600이 아니면 idempotent 성공으로 오인하지 않는다", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "cleanup-receipt-mode-")));
    const receipt = buildCleanupReceipt({
      expectedResources: TEST_RESOURCE_IDS,
      cleanup: completeCleanup(),
      createdAt: "2026-07-17T00:00:00.000Z",
    });
    const filePath = await persistCleanupReceipt(receipt, directory);
    await chmod(filePath, 0o644);
    await expect(persistCleanupReceipt(receipt, directory)).rejects.toThrow(
      /digest.*내용|canonical|0600|single-link/i,
    );
  });

  it("조상 symlink 출력 경로는 외부에 cleanup receipt나 remote ID를 기록하기 전에 거부한다", async () => {
    const trustedParent = await realpath(await mkdtemp(
      join(tmpdir(), "cleanup-receipt-parent-"),
    ));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "cleanup-receipt-outside-")));
    await Promise.all([chmod(trustedParent, 0o700), chmod(outside, 0o700)]);
    const linkedParent = join(trustedParent, "linked-parent");
    await symlink(outside, linkedParent);
    const remoteVectorStoreId = "vs-sensitive-remote-id-must-not-escape";
    const remoteFileId = "file-sensitive-remote-id-must-not-escape";
    const receipt = buildCleanupReceipt({
      expectedResources: {
        vectorStoreId: remoteVectorStoreId,
        uploadedFileIds: [remoteFileId],
      },
      cleanup: null,
      createdAt: "2026-07-18T00:00:00.000Z",
    });

    const result = await persistCleanupReceipt(receipt, join(linkedParent, "receipt"))
      .then(() => "resolved", () => "rejected");

    expect(result).toBe("rejected");
    expect(await readdir(outside)).toEqual([]);
  });
});

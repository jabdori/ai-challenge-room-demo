// @vitest-environment node

import {
  link,
  lstat,
  mkdtemp,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { persistCleanupReceipt } from "../cli/cleanupReceipt";
import type { BenchmarkProgressEvent } from "../benchmark/executeBenchmark";
import {
  buildStableBenchmarkId,
  openBenchmarkProgressJournal,
} from "../benchmark/benchmarkProgressPersistence";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

// 이 파일은 journal의 filesystem·hash-chain 동작만 격리 검증합니다.
// 실제 progress authority brand의 거부·허용은 benchmarkOrchestration.test.ts가
// executeBenchmark source-reload 경계를 통해 별도로 검증합니다.
vi.mock("../benchmark/executeBenchmark", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../benchmark/executeBenchmark")
  >();
  return {
    ...actual,
    assertVerifiedBenchmarkProgressEvent: () => undefined,
  };
});
vi.mock("../pack/recordedBenchmarkPack", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../pack/recordedBenchmarkPack")
  >();
  return {
    ...actual,
    assertPersistedRecordedBenchmarkPack: () => undefined,
  };
});
vi.mock("../benchmark/resourceLease", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../benchmark/resourceLease")
  >();
  return {
    ...actual,
    assertAuthoritativeBenchmarkResourceLeaseTerminal: () => undefined,
  };
});

const lockedChallengePackHash = "a".repeat(64);
const hiddenDatasetHash = "b".repeat(64);
const scheduleId = "c".repeat(64);

async function secureRoot(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

function progressEvent(
  completed: number,
  source: BenchmarkProgressEvent["source"] = "EXECUTED",
): BenchmarkProgressEvent {
  const candidateId = (["A", "B", "C"] as const)[(completed - 1) % 3]!;
  const repetition = completed % 2 === 0 ? 2 : 1;
  const caseNumber = Math.ceil(completed / 6);
  const caseId = `H-${String(caseNumber).padStart(3, "0")}`;
  return {
    completed_checkpoints: completed,
    total_checkpoints: 72,
    slot: {
      slot_id: `${caseId}--${candidateId}--r${repetition}`,
      sequence: completed,
      case_id: caseId,
      candidate_id: candidateId,
      repetition,
      candidate_position: candidateId === "A" ? 1 : candidateId === "B" ? 2 : 3,
    },
    source,
    checkpoint_payload_sha256: sha256CanonicalJson({
      completed,
      caseId,
      candidateId,
      repetition,
    }),
    terminal_slot_summary: {
      execution_status: "COMPLETE",
      evaluation_status: "EVALUATED",
      hard_gate_status: "PASS",
      cost_state: "COMPLETE",
      cost_usd: completed / 1_000,
      latency_ms: completed * 10,
    },
  };
}

function coordinates(outputDirectory: string) {
  return {
    outputDirectory,
    lockedChallengePackHash,
    hiddenDatasetHash,
    scheduleId,
  };
}

describe("Benchmark lifecycle identity와 append-only progress chain", () => {
  it("원격 자원·execution hash와 무관한 세 고정 hash만으로 stable benchmark id와 0 start receipt를 만든다", async () => {
    const outputDirectory = await secureRoot("benchmark-start-receipt-");
    const expectedId = sha256CanonicalJson({
      schema_version: "stable-benchmark-id-v1",
      locked_challenge_pack_hash: lockedChallengePackHash,
      hidden_dataset_hash: hiddenDatasetHash,
      schedule_id: scheduleId,
    });

    const journal = await openBenchmarkProgressJournal(
      coordinates(outputDirectory),
    );
    const projection = journal.currentProjection();

    expect(buildStableBenchmarkId({
      lockedChallengePackHash,
      hiddenDatasetHash,
      scheduleId,
    })).toBe(expectedId);
    expect(journal.startReceipt).toMatchObject({
      artifact_kind: "BENCHMARK_START_RECEIPT",
      benchmark_id: expectedId,
      completed_checkpoints: 0,
      total_checkpoints: 72,
      status: "RUNNING",
    });
    expect(projection).toMatchObject({
      schema_version: "benchmark-lifecycle-projection-v1",
      synthetic: true,
      source: "RECORDED_BENCHMARK",
      benchmark_id: expectedId,
      status: "RUNNING",
      completed: 0,
      total: 72,
      last_slot_sequence: null,
      checkpoint_source: null,
      cleanup: null,
    });
    expect(projection.source_hash).not.toBe(
      journal.startReceipt.start_receipt_hash,
    );
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toMatch(
      /api[_-]?key|oracle|private|execution_hash|slot_identity|vector_store|file-/i,
    );
    expect(serialized).not.toContain(lockedChallengePackHash);
    expect(serialized).not.toContain(hiddenDatasetHash);
    expect(serialized).not.toContain(scheduleId);
    expect(serialized).not.toContain(
      journal.startReceipt.start_receipt_hash,
    );
    expect((await lstat(journal.startPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(journal.startPath)).nlink).toBe(1);
  });

  it("checkpoint 1..72를 정확히 한 번 연결하고 resume prefix는 재사용 검증만 한다", async () => {
    const outputDirectory = await secureRoot("benchmark-progress-chain-");
    const first = await openBenchmarkProgressJournal(
      coordinates(outputDirectory),
    );
    const sourceHashes: string[] = [];
    for (let completed = 1; completed <= 3; completed += 1) {
      const projection = await first.recordCheckpoint(
        progressEvent(completed),
      );
      sourceHashes.push(projection.source_hash);
      expect(projection.completed).toBe(completed);
      expect(projection.last_slot_sequence).toBe(completed);
    }

    const resumed = await openBenchmarkProgressJournal(
      coordinates(outputDirectory),
    );
    for (let completed = 1; completed <= 3; completed += 1) {
      const projection = await resumed.recordCheckpoint(
        progressEvent(completed, "REUSED_CHECKPOINT"),
      );
      expect(projection.source_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(projection.source_hash).not.toBe(sourceHashes[2]);
      expect(projection.completed).toBe(3);
      expect(projection.checkpoint_source).toBe("REUSED_CHECKPOINT");
    }
    const fourth = await resumed.recordCheckpoint(
      progressEvent(4, "REUSED_CHECKPOINT"),
    );
    expect(fourth.completed).toBe(4);
    expect(fourth.checkpoint_source).toBe("REUSED_CHECKPOINT");

    const verified = await resumed.verifySource();
    expect(verified.events).toHaveLength(4);
    expect(verified.events.map((event) => event.completed_checkpoints))
      .toEqual([1, 2, 3, 4]);
    expect(verified.events.map((event) => event.previous_event_hash))
      .toEqual([
        verified.start_receipt.start_receipt_hash,
        ...verified.events.slice(0, -1).map((event) => event.event_hash),
      ]);
    expect(verified.events[3]?.checkpoint_source).toBe("REUSED_CHECKPOINT");
  });

  it("slot 순서·count·checkpoint hash의 gap, fork, stale head를 fail-closed한다", async () => {
    const outputDirectory = await secureRoot("benchmark-progress-fork-");
    const first = await openBenchmarkProgressJournal(
      coordinates(outputDirectory),
    );
    const stale = await openBenchmarkProgressJournal(
      coordinates(outputDirectory),
    );
    await first.recordCheckpoint(progressEvent(1));

    await expect(first.recordCheckpoint(progressEvent(3)))
      .rejects.toThrow(/gap|sequence|순서|단조|2/i);
    await expect(first.recordCheckpoint({
      ...progressEvent(2),
      checkpoint_payload_sha256: "not-a-sha",
    })).rejects.toThrow(/SHA-256|hash/i);
    await expect(first.recordCheckpoint({
      ...progressEvent(1),
      checkpoint_payload_sha256: "d".repeat(64),
    })).rejects.toThrow(/fork|다른|mismatch|불일치/i);
    await expect(stale.recordCheckpoint(progressEvent(1)))
      .rejects.toThrow(/stale|rollback|fork|head|뒤처진/i);
  });

  it("72 checkpoint와 cleanup 33/33·receipt/pack hash 전에는 COMPLETE를 기록하지 않는다", async () => {
    const outputDirectory = await secureRoot("benchmark-progress-complete-");
    const journal = await openBenchmarkProgressJournal(
      coordinates(outputDirectory),
    );
    for (let completed = 1; completed <= 72; completed += 1) {
      await journal.recordCheckpoint(progressEvent(completed));
    }
    const vectorStoreId = "vs-benchmark-progress-test";
    const uploadedFileIds = Array.from(
      { length: 32 },
      (_, index) => `file-benchmark-progress-${index}`,
    );
    const cleanupReceiptPath = await persistCleanupReceipt({
      schema_version: "1.0",
      artifact_kind: "CLEANUP_RECEIPT",
      created_at: "2026-07-17T00:00:00.000Z",
      deletion_semantics: "API_ACKNOWLEDGEMENT_ONLY_NO_PHYSICAL_DELETION_CLAIM",
      expected_resources: {
        vector_store_id: vectorStoreId,
        uploaded_file_ids: uploadedFileIds,
      },
      api_delete_acknowledgements: {
        vector_store: {
          resource_id: vectorStoreId,
          attempted: true,
          deleted: true,
        },
        uploaded_files: uploadedFileIds.map((resourceId) => ({
          resource_id: resourceId,
          attempted: true,
          deleted: true,
        })),
      },
      runtime_errors: [],
    }, outputDirectory);
    const recordedBenchmarkPack = {
      locked_challenge_pack_hash: lockedChallengePackHash,
      benchmark_execution_pack: { schedule_id: scheduleId },
      coverage: { candidate_runs: 72, judge_cases: 12 },
    };
    const resourceLeaseTerminal = {
      contract: {
        locked_challenge_pack_sha256: lockedChallengePackHash,
        schedule_id: scheduleId,
      },
      prepared_store: { vectorStoreId, uploadedFileIds },
      cleanup: {
        vectorStore: {
          id: vectorStoreId,
          attempted: true,
          deleted: true,
        },
        uploadedFiles: uploadedFileIds.map((id) => ({
          id,
          attempted: true,
          deleted: true,
        })),
      },
      terminal_record_sha256: "f".repeat(64),
    };
    const recordedBenchmarkPackPath =
      join(outputDirectory, "source/recorded-benchmark.json");
    const cleanupHash = sha256CanonicalJson(
      JSON.parse(await (await import("node:fs/promises")).readFile(
        cleanupReceiptPath,
        "utf8",
      )),
    );
    const recordedHash = sha256CanonicalJson(recordedBenchmarkPack);
    const completionInput = {
      cleanupReceiptPath,
      recordedBenchmarkPackPath,
      recordedBenchmarkPack,
      resourceLeaseTerminal,
      finalizationArtifacts: {
        cleanupReceipt: {
          path: cleanupReceiptPath,
          payloadSha256: cleanupHash,
        },
        recordedPack: {
          path: recordedBenchmarkPackPath,
          payloadSha256: recordedHash,
        },
      },
    } as never;

    const complete = await journal.complete(completionInput);
    expect(complete).toMatchObject({
      status: "COMPLETE",
      completed: 72,
      total: 72,
      cleanup: { required: 33, acknowledged: 33, incomplete: 0 },
    });
    const verified = await journal.verifySource();
    expect(verified.completion_receipt).toMatchObject({
      artifact_kind: "BENCHMARK_COMPLETION_RECEIPT",
      completed_checkpoints: 72,
      cleanup: { required: 33, acknowledged: 33, incomplete: 0 },
    });
    await expect(journal.complete(completionInput))
      .rejects.toThrow(/already|이미|terminal|완료/i);
    await expect(journal.recordCheckpoint(progressEvent(72, "REUSED_CHECKPOINT")))
      .rejects.toThrow(/terminal|COMPLETE|완료/i);
  }, 30_000);

  it("외부 hard-link와 source directory fork를 source reload에서 거부한다", async () => {
    const outputDirectory = await secureRoot("benchmark-progress-hardlink-");
    const journal = await openBenchmarkProgressJournal(
      coordinates(outputDirectory),
    );
    await journal.recordCheckpoint(progressEvent(1));
    await link(
      journal.startPath,
      join(outputDirectory, "attacker-start-hardlink.json"),
    );

    await expect(openBenchmarkProgressJournal(coordinates(outputDirectory)))
      .rejects.toThrow(/hard|link|nlink|불변/i);
  });
});

// @vitest-environment node

import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import type { BenchmarkExecutionIdentity } from "../benchmark/identity";
import {
  buildStableBenchmarkId,
  type BenchmarkProgressJournal,
} from "../benchmark/benchmarkProgressPersistence";
import {
  buildBenchmarkSchedule,
  type BenchmarkSchedule,
} from "../benchmark/schedule";
import {
  BENCHMARK_CASES,
  BENCHMARK_DATASET_HASH,
} from "../data/benchmark";
import type { BenchmarkExecutionPack } from "../pack/benchmarkPack";
import type { RecordedBenchmarkPack } from "../pack/recordedBenchmarkPack";
import type {
  CleanupReceipt,
} from "../cli/cleanupReceipt";
import type {
  PolicyVectorStoreCleanupResult,
} from "../retrieval/policyVectorStore";
import {
  RECORDED_BENCHMARK_ACKNOWLEDGEMENT,
  RECORDED_BENCHMARK_ACKNOWLEDGEMENT_ENV,
  RECORDED_BENCHMARK_AUTHORITY_ENV,
  RecordedBenchmarkInterruptionError,
  createJudgeOnlyPostLeaseOpenAIClient,
  createProductionRecordedBenchmarkDependencies,
  createLocalLedgerOnlyOpenAIClient,
  executeRecordedBenchmarkCommand,
  executeProductionRecordedBenchmark,
  runRecordedBenchmarkProcess,
  type PreparedRecordedBenchmarkPolicyStore,
  type RecordedBenchmarkCommandDependencies,
  type RecordedBenchmarkProcessLike,
} from "../cli/runRecordedBenchmark";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

const apiKey = "test-recorded-benchmark-key-only";
const outputDirectory = "/private/runtime/recorded-benchmark";
const EXECUTION_HASH = "f".repeat(64);
const LOCKED_CHALLENGE_PACK_HASH = "1".repeat(64);
const LOCKED_CHALLENGE_CONTRACT_HASH = "2".repeat(64);
const LOCKED_CHALLENGE_SOURCE_MANIFEST_HASH = "3".repeat(64);
const EVALUATOR_CONTRACT_HASH = "4".repeat(64);
const SCHEDULE_ID = "5".repeat(64);
const PRECOMMIT_MANIFEST_DIGEST = "6".repeat(64);
const PRECOMMIT_MANIFEST_HASH = "7".repeat(64);
const JUDGE_EVIDENCE_PACK_HASH = "8".repeat(64);
const QUEUE_CONTENT_HASH = "9".repeat(64);
const QUEUE_SET_ORDER_HASH = "a".repeat(64);
const vectorStoreId = "vs-hidden-benchmark-private";
const uploadedFileIds = Array.from(
  { length: 32 },
  (_, index) => `file-hidden-policy-${String(index + 1).padStart(2, "0")}`,
);

function preparedStore(
  resourceScope: PreparedRecordedBenchmarkPolicyStore["resource_scope"]
    = "RECORDED_BENCHMARK",
): PreparedRecordedBenchmarkPolicyStore {
  return {
    resource_scope: resourceScope,
    vectorStoreId,
    uploadedFileIds,
    files: uploadedFileIds.map((uploadedFileId, index) => ({
      uploadedFileId,
      filename: `hidden-policy-${index + 1}.json`,
      sourceId: `POLICY-${String(Math.floor(index / 3) + 1).padStart(2, "0")}`,
      sectionId: `section-${index + 1}`,
      factId: `fact-${index + 1}`,
    })),
    ingestionStatus: "completed",
    manifestSha256: "a".repeat(64),
    vectorStoreExpiresAfter: { anchor: "last_active_at", days: 1 },
    fileExpiresAfter: { anchor: "created_at", seconds: 86_400 },
    uploadMethod: "FILES_CREATE_AND_BOUNDED_VECTOR_STORE_POLL",
    resourceIdentity: {
      schema_version: "benchmark-policy-resource-v1",
      policy_corpus_sha256: "b".repeat(64),
      chunking_config: {
        type: "static",
        static: {
          max_chunk_size_tokens: 600,
          chunk_overlap_tokens: 300,
        },
      },
      chunking_config_sha256: "c".repeat(64),
      resource_contract_sha256: "d".repeat(64),
      manifest_sha256: "a".repeat(64),
    },
    resourceIdentitySha256: "e".repeat(64),
  };
}

function completeCleanup(): PolicyVectorStoreCleanupResult {
  return {
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
  };
}

function executionPack(recordedRuns = 72): BenchmarkExecutionPack {
  return {
    schema_version: "benchmark-execution-pack-v1",
    artifact_kind: "BENCHMARK_EXECUTION_PACK",
    source: "RECORDED_BENCHMARK",
    execution_status: "EXECUTION_COMPLETE",
    evaluation_status: "EVALUATION_INCOMPLETE",
    review_status: "NOT_GENERATED",
    baseline_version: null,
    synthetic: true,
    judge_readiness: "READY_FOR_JUDGE",
    execution_hash: EXECUTION_HASH,
    locked_challenge_pack_hash: LOCKED_CHALLENGE_PACK_HASH,
    locked_challenge_contract_hash: LOCKED_CHALLENGE_CONTRACT_HASH,
    locked_challenge_source_manifest_hash: LOCKED_CHALLENGE_SOURCE_MANIFEST_HASH,
    evaluator_contract_hash: EVALUATOR_CONTRACT_HASH,
    schedule_id: SCHEDULE_ID,
    coverage: {
      cases: 12,
      candidates: 3,
      runs_per_case: 2,
      expected_runs: 72,
      recorded_runs: recordedRuns,
    },
    slots: [],
    candidate_aggregates: [],
  } as BenchmarkExecutionPack;
}

function recordedPack(
  overrides: Partial<RecordedBenchmarkPack> = {},
): RecordedBenchmarkPack {
  const benchmarkExecutionPack = executionPack();
  return {
    schema_version: "recorded-benchmark-pack-v1",
    artifact_kind: "RECORDED_BENCHMARK_PACK",
    source: "RECORDED_BENCHMARK",
    execution_status: "EXECUTION_COMPLETE",
    judge_status: "JUDGE_COMPLETE",
    review_status: "REVIEW_PENDING",
    evaluation_status: "EVALUATION_INCOMPLETE",
    baseline_version: null,
    synthetic: true,
    execution_hash: EXECUTION_HASH,
    // cold-reload authority reference가 실제 builder처럼 full execution-pack
    // canonical digest를 받도록 fixture에서도 직접 계산합니다.
    execution_pack_hash: sha256CanonicalJson(benchmarkExecutionPack),
    locked_challenge_pack_hash: LOCKED_CHALLENGE_PACK_HASH,
    locked_challenge_contract_hash: LOCKED_CHALLENGE_CONTRACT_HASH,
    locked_challenge_source_manifest_hash: LOCKED_CHALLENGE_SOURCE_MANIFEST_HASH,
    precommit_manifest_digest: PRECOMMIT_MANIFEST_DIGEST,
    precommit_manifest_hash: PRECOMMIT_MANIFEST_HASH,
    judge_evidence_pack_hash: JUDGE_EVIDENCE_PACK_HASH,
    queue_content_hash: QUEUE_CONTENT_HASH,
    queue_set_order_hash: QUEUE_SET_ORDER_HASH,
    costs: {
      candidate_execution: { currency: "USD", accounted_runs: 72, total_usd: 0 },
      auxiliary_judge: { currency: "USD", accounted_cases: 12, total_usd: 0 },
    },
    coverage: {
      cases: 12,
      candidates: 3,
      runs_per_case: 2,
      candidate_runs: 72,
      judge_cases: 12,
      complete_judge_cases: 12,
      human_fallback_judge_cases: 0,
      review_items: 2,
    },
    benchmark_execution_pack: benchmarkExecutionPack,
    judge_evidence_pack: {},
    blind_review_queue: {},
    ...overrides,
  } as RecordedBenchmarkPack;
}

function createDependencies(
  overrides: Partial<RecordedBenchmarkCommandDependencies> = {},
) {
  const events: string[] = [];
  const client = { kind: "fake-openai-client" };
  let cleanupReceipt: CleanupReceipt | null = null;
  const dependencies: RecordedBenchmarkCommandDependencies = {
    assertSyntheticBenchmarkData: vi.fn(() => events.push("guard")),
    createClient: vi.fn(() => {
      events.push("client");
      return client;
    }),
    preparePolicyStore: vi.fn(async () => {
      events.push("prepare");
      return preparedStore();
    }),
    buildSchedule: vi.fn(() => {
      events.push("schedule");
      return [] as unknown as BenchmarkSchedule;
    }),
    buildExecutionIdentity: vi.fn(() => {
      events.push("identity");
      return { execution_hash: EXECUTION_HASH } as BenchmarkExecutionIdentity;
    }),
    persistExecutionIdentityAuthority: vi.fn(async () => {
      events.push("persist-identity-authority");
      return {
        path: `${outputDirectory}/benchmark-execution-identity-authority/benchmark-execution-identity--${EXECUTION_HASH}.json`,
        payloadSha256: "e".repeat(64),
      };
    }),
    createAdapterFactory: vi.fn(() => {
      events.push("adapter-factory");
      return vi.fn();
    }),
    buildExecutionPlans: vi.fn(() => {
      events.push("plans");
      return Array.from({ length: 72 }, () => ({})) as never;
    }),
    executeBenchmark: vi.fn(async () => {
      events.push("execute-72");
      return executionPack();
    }),
    assertValidatedExecutionPack: vi.fn((pack: unknown): asserts pack is BenchmarkExecutionPack => {
      events.push("validate-72");
    }),
    promoteRecordedBenchmark: vi.fn(async () => {
      events.push("judge-12-and-promote");
      return {
        pack: recordedPack(),
        auxiliaryJudgeCount: 12 as const,
        completeJudgeCount: 12,
        humanFallbackJudgeCount: 0,
      };
    }),
    assertValidatedRecordedPack: vi.fn((pack: unknown): asserts pack is RecordedBenchmarkPack => {
      events.push("validate-parent");
    }),
    persistRecordedPack: vi.fn(async () => {
      events.push("persist-parent");
      return `${outputDirectory}/recorded-benchmark-pack.json`;
    }),
    loadPersistedRecordedPack: vi.fn(async ({ pack }) => {
      events.push("source-reload-parent");
      return structuredClone(pack);
    }),
    cleanupPolicyStore: vi.fn(async () => {
      events.push("cleanup");
      return completeCleanup();
    }),
    persistCleanupReceipt: vi.fn(async (receipt) => {
      events.push("cleanup-receipt");
      cleanupReceipt = receipt;
      return `${outputDirectory}/cleanup-receipt.json`;
    }),
    ...overrides,
  };
  return {
    dependencies,
    events,
    client,
    getCleanupReceipt: () => cleanupReceipt,
  };
}

class FakeProcess extends EventEmitter implements RecordedBenchmarkProcessLike {
  readonly env: NodeJS.ProcessEnv;
  exitCode: number | undefined;
  readonly stdoutText: string[] = [];
  readonly stderrText: string[] = [];
  readonly stdin: { isTTY?: boolean };
  readonly stdout: {
    isTTY?: boolean;
    write: (value: string) => boolean;
  };
  readonly stderr = {
    write: (value: string) => {
      this.stderrText.push(value);
      return true;
    },
  };

  constructor({
    environment = {},
    stdinTty = true,
    stdoutTty = true,
  }: {
    environment?: NodeJS.ProcessEnv;
    stdinTty?: boolean;
    stdoutTty?: boolean;
  } = {}) {
    super();
    this.env = environment;
    this.stdin = { isTTY: stdinTty };
    this.stdout = {
      isTTY: stdoutTty,
      write: (value: string) => {
        this.stdoutText.push(value);
        return true;
      },
    };
  }
}

describe("production Recorded Benchmark command", () => {
  it("production lifecycle journal에 verified progress를 전달하고 resource terminal 뒤에만 COMPLETE를 요청한다", async () => {
    const lifecycleEvents: string[] = [];
    const journal = {
      recordCheckpoint: vi.fn(async () => {
        lifecycleEvents.push("progress");
        return {};
      }),
      complete: vi.fn(async () => {
        lifecycleEvents.push("complete");
        return {};
      }),
      verifySource: vi.fn(async () => ({
        start_receipt: {},
        events: [],
        completion_receipt: null,
      })),
    } as unknown as BenchmarkProgressJournal;
    const terminalAuthority = { authority: "resource-terminal" };
    const finalizationArtifacts = {
      cleanupReceipt: {
        path: `${outputDirectory}/cleanup-receipt.json`,
        payloadSha256: "a".repeat(64),
      },
      recordedPack: {
        path: `${outputDirectory}/recorded-benchmark-pack.json`,
        payloadSha256: "b".repeat(64),
      },
    };
    const { dependencies } = createDependencies({
      executeBenchmark: vi.fn(async (input) => {
        await input.onProgress?.({ verified: true } as never);
        return executionPack();
      }),
      loadPolicyStoreFinalizationArtifacts: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(finalizationArtifacts),
      loadPolicyStoreTerminalAuthority: vi.fn(async () => (
        terminalAuthority as never
      )),
    });

    const outcome = await executeRecordedBenchmarkCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
      lifecycleJournal: journal,
    });

    expect(outcome.exitCode).toBe(0);
    expect(journal.recordCheckpoint).toHaveBeenCalledOnce();
    expect(journal.complete).toHaveBeenCalledWith({
      cleanupReceiptPath: finalizationArtifacts.cleanupReceipt.path,
      recordedBenchmarkPackPath: finalizationArtifacts.recordedPack.path,
      recordedBenchmarkPack: outcome.serverAuthority?.recordedBenchmarkPack,
      resourceLeaseTerminal: terminalAuthority,
      finalizationArtifacts,
    });
    expect(lifecycleEvents).toEqual(["progress", "complete"]);
  });

  it("완료된 production lifecycle 재시작은 72회·Judge를 재호출하지 않고 completion binding을 cold source-reload한다", async () => {
    const sourceReloadedPack = recordedPack();
    const sourceReloadedPackHash = sha256CanonicalJson(sourceReloadedPack);
    const recordedPackPath = `${outputDirectory}/recorded-benchmark-pack.json`;
    const finalizationArtifacts = {
      cleanupReceipt: {
        path: `${outputDirectory}/cleanup-receipt.json`,
        payloadSha256: "a".repeat(64),
      },
      recordedPack: {
        path: recordedPackPath,
        payloadSha256: sourceReloadedPackHash,
      },
    };
    const completionReceipt = {
      schema_version: "benchmark-completion-receipt-v1",
      artifact_kind: "BENCHMARK_COMPLETION_RECEIPT",
      synthetic: true,
      source: "RECORDED_BENCHMARK",
      status: "COMPLETE",
      benchmark_id: "b".repeat(64),
      completed_checkpoints: 72,
      total_checkpoints: 72,
      previous_event_hash: "c".repeat(64),
      cleanup: { required: 33, acknowledged: 33, incomplete: 0 },
      cleanup_receipt_hash: finalizationArtifacts.cleanupReceipt.payloadSha256,
      recorded_benchmark_pack_hash: sourceReloadedPackHash,
      resource_lease_terminal_hash: "d".repeat(64),
      completion_receipt_hash: "e".repeat(64),
    } as const;
    const authoritativePack = {
      locked_challenge_pack_hash: LOCKED_CHALLENGE_PACK_HASH,
    };
    const schedule = buildBenchmarkSchedule(
      BENCHMARK_CASES,
      ["A", "B", "C"],
    );
    const journal = {
      benchmarkId: buildStableBenchmarkId({
        lockedChallengePackHash: LOCKED_CHALLENGE_PACK_HASH,
        hiddenDatasetHash: BENCHMARK_DATASET_HASH,
        scheduleId: schedule.schedule_id,
      }),
      currentProjection: vi.fn(() => ({ status: "COMPLETE" })),
      verifySource: vi.fn(async () => ({
        start_receipt: {},
        events: [],
        completion_receipt: completionReceipt,
      })),
      recordCheckpoint: vi.fn(async () => {
        throw new Error(
          "terminal COMPLETE Benchmark에는 checkpoint를 추가하거나 replay할 수 없습니다.",
        );
      }),
      complete: vi.fn(async () => {
        throw new Error("완료된 lifecycle을 다시 COMPLETE로 만들 수 없습니다.");
      }),
    } as unknown as BenchmarkProgressJournal;
    const reloadCompletedRecordedBenchmark = vi.fn(async () => ({
      pack: sourceReloadedPack,
      recordedPackPath,
    }));
    const execute72 = vi.fn(async (input) => {
      await input.onProgress?.({ verified: true } as never);
      return executionPack();
    });
    const { dependencies } = createDependencies({
      executeBenchmark: execute72,
      loadPolicyStoreFinalizationArtifacts: vi.fn(async () => (
        finalizationArtifacts
      )),
    });
    const terminalAwareDependencies = Object.assign(dependencies, {
      reloadCompletedRecordedBenchmark,
    });
    const openLifecycleJournal = vi.fn(async () => journal);

    const outcome = await executeProductionRecordedBenchmark(
      {
        environment: {
          OPENAI_API_KEY: apiKey,
          [RECORDED_BENCHMARK_AUTHORITY_ENV.directory]:
            "/private/runtime/locked-challenge",
          [RECORDED_BENCHMARK_AUTHORITY_ENV.challengeId]:
            "monomarket-support-ai-selection",
          [RECORDED_BENCHMARK_AUTHORITY_ENV.challengeVersion]: "v1",
        },
        outputDirectory,
        lifecycleJournal: journal,
      },
      {
        loadAuthorityRecord: vi.fn(async () => ({
          pack: authoritativePack as never,
        })),
        createCommandDependencies: vi.fn(() => terminalAwareDependencies),
        openLifecycleJournal,
      },
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.summary).toMatchObject({
      command_status: "RECORDED_BENCHMARK_REVIEW_PENDING",
      clean_completion: true,
      candidate_execution_count: 72,
      auxiliary_judge_count: 12,
      recorded_pack_path: recordedPackPath,
      cleanup: { required: 33, acknowledged: 33, incomplete: 0 },
    });
    expect(outcome.serverAuthority?.recordedBenchmarkPack)
      .toBe(sourceReloadedPack);
    expect(outcome.serverAuthority?.coldReloadReference).toMatchObject({
      recordedPackPath,
      recordedPackHash: sourceReloadedPackHash,
    });
    expect(reloadCompletedRecordedBenchmark).toHaveBeenCalledOnce();
    expect(execute72).not.toHaveBeenCalled();
    expect(dependencies.promoteRecordedBenchmark).not.toHaveBeenCalled();
    expect(dependencies.persistRecordedPack).not.toHaveBeenCalled();
    expect(dependencies.loadPersistedRecordedPack).not.toHaveBeenCalled();
    expect(journal.recordCheckpoint).not.toHaveBeenCalled();
    expect(journal.complete).not.toHaveBeenCalled();
    expect(openLifecycleJournal).not.toHaveBeenCalled();
  });

  it("주입된 lifecycle journal의 stable Benchmark ID가 authority와 다르면 원격 준비 전에 거부한다", async () => {
    const loadAuthorityRecord = vi.fn(async () => ({
      pack: {
        locked_challenge_pack_hash: LOCKED_CHALLENGE_PACK_HASH,
      } as never,
    }));
    const createCommandDependencies = vi.fn();
    const openLifecycleJournal = vi.fn();
    const outcome = await executeProductionRecordedBenchmark(
      {
        environment: {
          OPENAI_API_KEY: apiKey,
          [RECORDED_BENCHMARK_AUTHORITY_ENV.directory]:
            "/private/runtime/locked-challenge",
          [RECORDED_BENCHMARK_AUTHORITY_ENV.challengeId]:
            "monomarket-support-ai-selection",
          [RECORDED_BENCHMARK_AUTHORITY_ENV.challengeVersion]: "v1",
        },
        outputDirectory,
        lifecycleJournal: {
          benchmarkId: "0".repeat(64),
        } as BenchmarkProgressJournal,
      },
      {
        loadAuthorityRecord,
        createCommandDependencies,
        openLifecycleJournal,
      },
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.summary.command_status).toBe("RECORDED_BENCHMARK_FAILED");
    expect(loadAuthorityRecord).toHaveBeenCalledOnce();
    expect(createCommandDependencies).not.toHaveBeenCalled();
    expect(openLifecycleJournal).not.toHaveBeenCalled();
  });

  it("terminal local recovery에서 72/Judge ledger가 미완료면 원격 재생성 없이 명시적으로 중단한다", () => {
    const fetch = vi.fn();
    const client = new OpenAI({
      apiKey: "test-local-ledger-only-key",
      fetch,
      maxRetries: 0,
    });
    const localOnly = createLocalLedgerOnlyOpenAIClient(client);

    expect(() => localOnly.responses.create({
      model: "gpt-5.6-terra",
      input: "이 호출은 local ledger miss를 모사합니다.",
    })).toThrow(/terminal-cleaned|로컬|local/i);
    expect(() => localOnly.vectorStores.retrieve("vs-must-not-be-called"))
      .toThrow(/terminal-cleaned|로컬|local/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("terminal local recovery의 Judge 전용 client는 Responses만 허용하고 정책 자원 API는 차단한다", () => {
    const fetch = vi.fn();
    const client = new OpenAI({
      apiKey: "test-terminal-judge-only-key",
      fetch,
      maxRetries: 0,
    });
    const judgeOnly = createJudgeOnlyPostLeaseOpenAIClient(client);

    expect(judgeOnly.responses).toBe(client.responses);
    expect(() => judgeOnly.vectorStores.retrieve("vs-must-not-be-called"))
      .toThrow(/terminal-cleaned|Judge|정책|resource/i);
    expect(() => judgeOnly.files.retrieve("file-must-not-be-called"))
      .toThrow(/terminal-cleaned|Judge|정책|resource/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    RECORDED_BENCHMARK_AUTHORITY_ENV.directory,
    RECORDED_BENCHMARK_AUTHORITY_ENV.challengeId,
    RECORDED_BENCHMARK_AUTHORITY_ENV.challengeVersion,
  ])("%s 좌표가 없으면 authority 파일·OpenAI client·원격 자원을 만들지 않는다", async (
    missingName,
  ) => {
    const environment: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: apiKey,
      [RECORDED_BENCHMARK_AUTHORITY_ENV.directory]:
        "/private/runtime/locked-challenge",
      [RECORDED_BENCHMARK_AUTHORITY_ENV.challengeId]:
        "monomarket-support-ai-selection",
      [RECORDED_BENCHMARK_AUTHORITY_ENV.challengeVersion]: "v1",
    };
    delete environment[missingName];
    const loadAuthorityRecord = vi.fn();
    const createCommandDependencies = vi.fn();

    const outcome = await executeProductionRecordedBenchmark(
      { environment, outputDirectory },
      { loadAuthorityRecord, createCommandDependencies },
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.summary.command_status).toBe("RECORDED_BENCHMARK_FAILED");
    expect(loadAuthorityRecord).not.toHaveBeenCalled();
    expect(createCommandDependencies).not.toHaveBeenCalled();
  });

  it("명시된 Define/Lock authority를 먼저 로드한 뒤 그 pack으로 production 의존성을 만든다", async () => {
    const environment: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: apiKey,
      [RECORDED_BENCHMARK_AUTHORITY_ENV.directory]:
        "/private/runtime/locked-challenge",
      [RECORDED_BENCHMARK_AUTHORITY_ENV.challengeId]:
        "monomarket-support-ai-selection",
      [RECORDED_BENCHMARK_AUTHORITY_ENV.challengeVersion]: "v1",
    };
    const authoritativePack = { authority: "EXPLICIT_HUMAN_APPROVAL" };
    const loadAuthorityRecord = vi.fn().mockResolvedValue({
      pack: authoritativePack,
    });
    const { dependencies } = createDependencies();
    const createCommandDependencies = vi.fn(() => dependencies);

    const outcome = await executeProductionRecordedBenchmark(
      { environment, outputDirectory },
      { loadAuthorityRecord, createCommandDependencies },
    );

    expect(outcome.exitCode).toBe(0);
    expect(loadAuthorityRecord).toHaveBeenCalledWith({
      outputDirectory: "/private/runtime/locked-challenge",
      challengeId: "monomarket-support-ai-selection",
      challengeVersion: "v1",
    });
    expect(createCommandDependencies).toHaveBeenCalledWith(
      authoritativePack,
      outputDirectory,
    );
    expect(dependencies.createClient).toHaveBeenCalledWith(apiKey);
  });

  it("authority loader를 거치지 않은 구조적 clone은 production factory에서 원격 자원 전에 거부한다", () => {
    expect(() => createProductionRecordedBenchmarkDependencies({
      artifact_kind: "LOCKED_CHALLENGE_PACK",
      authority: "EXPLICIT_HUMAN_APPROVAL",
    } as never)).toThrow(/authoritative|authority|권위|검증/i);
  });

  it("API key가 없으면 guard·client·resource·실행을 전혀 호출하지 않는다", async () => {
    const { dependencies } = createDependencies();
    const outcome = await executeRecordedBenchmarkCommand({
      environment: {},
      outputDirectory,
      dependencies,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.summary.command_status).toBe("RECORDED_BENCHMARK_FAILED");
    expect(dependencies.assertSyntheticBenchmarkData).not.toHaveBeenCalled();
    expect(dependencies.createClient).not.toHaveBeenCalled();
    expect(dependencies.preparePolicyStore).not.toHaveBeenCalled();
    expect(dependencies.executeBenchmark).not.toHaveBeenCalled();
    expect(dependencies.promoteRecordedBenchmark).not.toHaveBeenCalled();
    expect(dependencies.persistRecordedPack).not.toHaveBeenCalled();
    expect(dependencies.persistCleanupReceipt).not.toHaveBeenCalled();
  });

  it.each([
    ["acknowledgement 불일치", "WRONG", true, true],
    ["stdin 비 TTY", RECORDED_BENCHMARK_ACKNOWLEDGEMENT, false, true],
    ["stdout 비 TTY", RECORDED_BENCHMARK_ACKNOWLEDGEMENT, true, false],
  ])("%s이면 command 자체를 호출하지 않는다", async (
    _label,
    acknowledgement,
    stdinTty,
    stdoutTty,
  ) => {
    const runtime = new FakeProcess({
      environment: {
        OPENAI_API_KEY: apiKey,
        [RECORDED_BENCHMARK_ACKNOWLEDGEMENT_ENV]: acknowledgement,
      },
      stdinTty,
      stdoutTty,
    });
    const executeCommand = vi.fn();

    const result = await runRecordedBenchmarkProcess({ runtime, executeCommand });

    expect(result).toBeNull();
    expect(runtime.exitCode).toBe(1);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(runtime.stderrText.join("")).toContain(
      RECORDED_BENCHMARK_ACKNOWLEDGEMENT,
    );
  });

  it("direct process는 acknowledgement가 맞아도 Define/Lock authority 좌표가 없으면 원격 호출 전 fail-closed한다", async () => {
    const runtime = new FakeProcess({
      environment: {
        OPENAI_API_KEY: apiKey,
        [RECORDED_BENCHMARK_ACKNOWLEDGEMENT_ENV]:
          RECORDED_BENCHMARK_ACKNOWLEDGEMENT,
      },
    });

    const outcome = await runRecordedBenchmarkProcess({ runtime });

    expect(outcome?.exitCode).toBe(1);
    expect(runtime.exitCode).toBe(1);
    expect(runtime.stderrText).toEqual([]);
    expect(JSON.parse(runtime.stdoutText[0]!)).toMatchObject({
      command_status: "RECORDED_BENCHMARK_FAILED",
      artifact_kind: null,
      cleanup: { required: 0 },
    });
  });

  it("CALIBRATION 자원은 Benchmark 자원으로 수락하지 않고 원격 실행 전 cleanup한다", async () => {
    const { dependencies, events } = createDependencies({
      preparePolicyStore: vi.fn(async () => {
        events.push("prepare");
        return preparedStore("CALIBRATION_SMOKE");
      }),
    });

    const outcome = await executeRecordedBenchmarkCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });

    expect(outcome.exitCode).toBe(1);
    expect(dependencies.buildExecutionPlans).not.toHaveBeenCalled();
    expect(dependencies.executeBenchmark).not.toHaveBeenCalled();
    expect(dependencies.promoteRecordedBenchmark).not.toHaveBeenCalled();
    expect(dependencies.persistRecordedPack).not.toHaveBeenCalled();
    expect(dependencies.cleanupPolicyStore).toHaveBeenCalledWith(
      expect.anything(),
      { vectorStoreId, uploadedFileIds },
    );
    expect(events).toEqual([
      "guard",
      "client",
      "prepare",
      "cleanup",
      "cleanup-receipt",
    ]);
  });

  it("정상 경로는 72회 검증 뒤 12개 Judge 승격을 검증하고서만 부모 팩을 저장한다", async () => {
    const {
      dependencies,
      events,
      getCleanupReceipt,
    } = createDependencies();

    const outcome = await executeRecordedBenchmarkCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });

    expect(outcome.exitCode).toBe(0);
    expect(events).toEqual([
      "guard",
      "client",
      "prepare",
      "schedule",
      "identity",
      "persist-identity-authority",
      "adapter-factory",
      "plans",
      "execute-72",
      "validate-72",
      "judge-12-and-promote",
      "validate-parent",
      "persist-parent",
      "source-reload-parent",
      "validate-parent",
      "cleanup",
      "cleanup-receipt",
    ]);
    expect(dependencies.preparePolicyStore).toHaveBeenCalledOnce();
    expect(dependencies.executeBenchmark).toHaveBeenCalledOnce();
    expect(dependencies.promoteRecordedBenchmark).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.anything(),
        executionPack: expect.objectContaining({
          coverage: expect.objectContaining({ recorded_runs: 72 }),
        }),
        executionIdentity: expect.objectContaining({
          execution_hash: "f".repeat(64),
        }),
        schedule: expect.anything(),
        plans: expect.any(Array),
        outputDirectory,
      }),
    );
    expect(
      vi.mocked(dependencies.promoteRecordedBenchmark).mock.calls[0]![0].plans,
    ).toHaveLength(72);
    expect(dependencies.persistRecordedPack).toHaveBeenCalledWith({
      outputDirectory,
      pack: expect.objectContaining({
        artifact_kind: "RECORDED_BENCHMARK_PACK",
        review_status: "REVIEW_PENDING",
      }),
    });
    expect(outcome.summary).toMatchObject({
      command_status: "RECORDED_BENCHMARK_REVIEW_PENDING",
      artifact_kind: "RECORDED_BENCHMARK_PACK",
      source: "RECORDED_BENCHMARK",
      execution_status: "EXECUTION_COMPLETE",
      judge_status: "JUDGE_COMPLETE",
      review_status: "REVIEW_PENDING",
      evaluation_status: "EVALUATION_INCOMPLETE",
      baseline_version: null,
      evaluation_complete: false,
      baseline_created: false,
      candidate_execution_count: 72,
      auxiliary_judge_count: 12,
      cleanup: {
        required: 33,
        acknowledged: 33,
        incomplete: 0,
      },
    });
    expect(outcome.serverAuthority?.coldReloadReference)
      .toMatchObject({
        executionIdentityAuthority: {
          path: `${outputDirectory}/benchmark-execution-identity-authority/benchmark-execution-identity--${"f".repeat(64)}.json`,
          payload_sha256: "e".repeat(64),
        },
      });
    const persistedInput =
      vi.mocked(dependencies.persistRecordedPack).mock.calls[0]![0].pack;
    expect(dependencies.loadPersistedRecordedPack).toHaveBeenCalledWith({
      path: `${outputDirectory}/recorded-benchmark-pack.json`,
      pack: persistedInput,
    });
    expect(outcome.serverAuthority?.recordedBenchmarkPack)
      .not.toBe(persistedInput);
    const sourceReloadedPack = await vi.mocked(
      dependencies.loadPersistedRecordedPack,
    ).mock.results[0]!.value;
    expect(outcome.serverAuthority?.recordedBenchmarkPack).toBe(
      sourceReloadedPack,
    );
    const receipt = getCleanupReceipt();
    expect(receipt?.expected_resources).toEqual({
      vector_store_id: vectorStoreId,
      uploaded_file_ids: uploadedFileIds,
    });
    expect(receipt?.api_delete_acknowledgements.vector_store).toMatchObject({
      resource_id: vectorStoreId,
      attempted: true,
      deleted: true,
    });
    expect(
      receipt?.api_delete_acknowledgements.uploaded_files.every(
        (item) => item.attempted && item.deleted,
      ),
    ).toBe(true);
  });

  it("안전한 Judge 실패는 완료로 꾸미지 않고 사람 fallback 수와 부분 상태를 요약한다", async () => {
    const base = recordedPack();
    const partialPack = recordedPack({
      judge_status: "JUDGE_PARTIAL_HUMAN_FALLBACK",
      coverage: {
        ...base.coverage,
        complete_judge_cases: 11,
        human_fallback_judge_cases: 1,
      },
    });
    const { dependencies } = createDependencies({
      promoteRecordedBenchmark: vi.fn(async () => ({
        pack: partialPack,
        auxiliaryJudgeCount: 12 as const,
        completeJudgeCount: 11,
        humanFallbackJudgeCount: 1,
      })),
    });

    const outcome = await executeRecordedBenchmarkCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.summary).toMatchObject({
      judge_status: "JUDGE_PARTIAL_HUMAN_FALLBACK",
      review_status: "REVIEW_PENDING",
      evaluation_status: "EVALUATION_INCOMPLETE",
      baseline_version: null,
      complete_judge_count: 11,
      human_fallback_judge_count: 1,
    });
  });

  it("cleanup receipt 저장 뒤 API 삭제 승인과 resource lease terminal을 결합한다", async () => {
    const events: string[] = [];
    const finalizePolicyStoreLease = vi.fn(async () => {
      events.push("lease-terminal");
    });
    const persistCleanup = vi.fn(async () => {
      events.push("cleanup-receipt");
      return `${outputDirectory}/cleanup-receipt.json`;
    });
    const { dependencies } = createDependencies({
      persistCleanupReceipt: persistCleanup,
      finalizePolicyStoreLease,
    });

    const outcome = await executeRecordedBenchmarkCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });

    expect(outcome.exitCode).toBe(0);
    expect(events).toEqual(["cleanup-receipt", "lease-terminal"]);
    expect(finalizePolicyStoreLease).toHaveBeenCalledWith(
      completeCleanup(),
      {
        cleanupReceipt: {
          path: `${outputDirectory}/cleanup-receipt.json`,
          payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        recordedPack: {
          path: `${outputDirectory}/recorded-benchmark-pack.json`,
          payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    );
  });

  it("완료 바인딩이 있는 terminal local recovery를 세 번째 실행해도 기존 artifact를 source-reload해 멱등 반환한다", async () => {
    let authoritativeArtifacts: {
      readonly cleanupReceipt: {
        readonly path: string;
        readonly payloadSha256: string;
      };
      readonly recordedPack: {
        readonly path: string;
        readonly payloadSha256: string;
      } | null;
    } | null = null;
    const persistCleanup = vi.fn(async () => (
      `${outputDirectory}/cleanup-receipt.json`
    ));
    const finalizePolicyStoreLease = vi.fn(async (
      _cleanup: PolicyVectorStoreCleanupResult,
      artifacts?: NonNullable<typeof authoritativeArtifacts>,
    ) => {
      expect(artifacts).toBeDefined();
      if (authoritativeArtifacts === null) {
        authoritativeArtifacts = structuredClone(artifacts!);
        return;
      }
      expect(artifacts).toEqual(authoritativeArtifacts);
    });
    const { dependencies } = createDependencies({
      persistCleanupReceipt: persistCleanup,
      finalizePolicyStoreLease,
    });
    const dependenciesWithSourceReload = Object.assign(dependencies, {
      loadPolicyStoreFinalizationArtifacts: vi.fn(async () => (
        authoritativeArtifacts === null
          ? null
          : structuredClone(authoritativeArtifacts)
      )),
    });

    const first = await executeRecordedBenchmarkCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies: dependenciesWithSourceReload,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await executeRecordedBenchmarkCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies: dependenciesWithSourceReload,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const third = await executeRecordedBenchmarkCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies: dependenciesWithSourceReload,
    });

    expect([first.exitCode, second.exitCode, third.exitCode]).toEqual([
      0,
      0,
      0,
    ]);
    expect(persistCleanup).toHaveBeenCalledOnce();
    expect(
      dependenciesWithSourceReload.loadPolicyStoreFinalizationArtifacts,
    ).toHaveBeenCalledTimes(3);
    expect(finalizePolicyStoreLease).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(finalizePolicyStoreLease).mock.calls[1]![1],
    ).toEqual(vi.mocked(finalizePolicyStoreLease).mock.calls[0]![1]);
    expect(
      vi.mocked(finalizePolicyStoreLease).mock.calls[2]![1],
    ).toEqual(vi.mocked(finalizePolicyStoreLease).mock.calls[0]![1]);
    expect(second.summary.recorded_pack_path).toBe(
      `${outputDirectory}/recorded-benchmark-pack.json`,
    );
    expect(third.summary.cleanup.receipt_path).toBe(
      `${outputDirectory}/cleanup-receipt.json`,
    );
  });

  it("72회가 검증되지 않으면 Judge·부모 팩 저장을 호출하지 않는다", async () => {
    const { dependencies } = createDependencies({
      executeBenchmark: vi.fn().mockResolvedValue(executionPack(71)),
    });

    const outcome = await executeRecordedBenchmarkCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });

    expect(outcome.exitCode).toBe(1);
    expect(dependencies.promoteRecordedBenchmark).not.toHaveBeenCalled();
    expect(dependencies.persistRecordedPack).not.toHaveBeenCalled();
    expect(dependencies.cleanupPolicyStore).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "Judge 11개",
      {
        pack: recordedPack(),
        auxiliaryJudgeCount: 11,
        completeJudgeCount: 11,
        humanFallbackJudgeCount: 0,
      },
    ],
    [
      "잘못된 review 상태",
      {
        pack: recordedPack({ review_status: "HUMAN_CONFIRMED" } as never),
        auxiliaryJudgeCount: 12,
        completeJudgeCount: 12,
        humanFallbackJudgeCount: 0,
      },
    ],
    [
      "잘못 생성된 baseline",
      {
        pack: recordedPack({ baseline_version: "v1" } as never),
        auxiliaryJudgeCount: 12,
        completeJudgeCount: 12,
        humanFallbackJudgeCount: 0,
      },
    ],
  ])("%s 승격 결과는 부모 팩을 저장하지 않는다", async (_label, promotion) => {
    const { dependencies } = createDependencies({
      promoteRecordedBenchmark: vi.fn().mockResolvedValue(promotion),
    });

    const outcome = await executeRecordedBenchmarkCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });

    expect(outcome.exitCode).toBe(1);
    expect(dependencies.assertValidatedRecordedPack).not.toHaveBeenCalled();
    expect(dependencies.persistRecordedPack).not.toHaveBeenCalled();
    expect(dependencies.cleanupPolicyStore).toHaveBeenCalledOnce();
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("%s 중단은 새 실행을 멈추고 cleanup한 뒤 exit %i다", async (
    signalName,
    exitCode,
  ) => {
    const controller = new AbortController();
    let started!: () => void;
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { dependencies } = createDependencies({
      executeBenchmark: vi.fn(async ({ signal }) => {
        started();
        return await new Promise<BenchmarkExecutionPack>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }),
    });
    const running = executeRecordedBenchmarkCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
      signal: controller.signal,
    });
    await executing;
    controller.abort(new RecordedBenchmarkInterruptionError(signalName));

    const outcome = await running;

    expect(outcome.exitCode).toBe(exitCode);
    expect(outcome.summary.command_status).toBe(
      "RECORDED_BENCHMARK_INTERRUPTED",
    );
    expect(dependencies.promoteRecordedBenchmark).not.toHaveBeenCalled();
    expect(dependencies.persistRecordedPack).not.toHaveBeenCalled();
    expect(dependencies.cleanupPolicyStore).toHaveBeenCalledOnce();
  });

  it("부모 팩 성공이어도 cleanup API acknowledgement가 부족하면 exit 2다", async () => {
    const partial = completeCleanup();
    partial.uploadedFiles[31]!.deleted = false;
    const { dependencies } = createDependencies({
      cleanupPolicyStore: vi.fn().mockResolvedValue(partial),
    });

    const outcome = await executeRecordedBenchmarkCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.summary.command_status).toBe(
      "RECORDED_BENCHMARK_CLEANUP_INCOMPLETE",
    );
    expect(outcome.summary.cleanup).toMatchObject({
      required: 33,
      acknowledged: 32,
      incomplete: 1,
    });
    expect(outcome.summary.clean_completion).toBe(false);
  });

  it("key와 원격 resource ID는 오류·요약·터미널 출력에 직렬화하지 않는다", async () => {
    const leakedError = new Error(
      `failed with ${apiKey} ${vectorStoreId} ${uploadedFileIds[0]}`,
    );
    const { dependencies, getCleanupReceipt } = createDependencies({
      executeBenchmark: vi.fn().mockRejectedValue(leakedError),
    });
    const outcome = await executeRecordedBenchmarkCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });
    const serializedOutcome = JSON.stringify(outcome);
    const serializedReceipt = JSON.stringify(getCleanupReceipt());

    expect(serializedOutcome).not.toContain(apiKey);
    expect(serializedOutcome).not.toContain(vectorStoreId);
    expect(uploadedFileIds.every((id) => !serializedOutcome.includes(id))).toBe(true);
    expect(serializedReceipt).not.toContain(apiKey);
    expect(serializedReceipt).not.toContain(leakedError.message);

    const runtime = new FakeProcess({
      environment: {
        OPENAI_API_KEY: apiKey,
        [RECORDED_BENCHMARK_ACKNOWLEDGEMENT_ENV]:
          RECORDED_BENCHMARK_ACKNOWLEDGEMENT,
      },
    });
    await runRecordedBenchmarkProcess({
      runtime,
      executeCommand: vi.fn().mockResolvedValue(outcome),
    });
    const terminal = `${runtime.stdoutText.join("")}${runtime.stderrText.join("")}`;
    expect(terminal).not.toContain(apiKey);
    expect(terminal).not.toContain(vectorStoreId);
    expect(uploadedFileIds.every((id) => !terminal.includes(id))).toBe(true);
  });

  it("성공 터미널은 REVIEW_PENDING을 평가 완료와 명시적으로 구분한다", async () => {
    const { dependencies } = createDependencies();
    const outcome = await executeRecordedBenchmarkCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });
    const runtime = new FakeProcess({
      environment: {
        OPENAI_API_KEY: apiKey,
        [RECORDED_BENCHMARK_ACKNOWLEDGEMENT_ENV]:
          RECORDED_BENCHMARK_ACKNOWLEDGEMENT,
      },
    });

    await runRecordedBenchmarkProcess({
      runtime,
      executeCommand: vi.fn().mockResolvedValue(outcome),
    });

    const output = runtime.stdoutText.join("");
    expect(output).toContain("RECORDED_BENCHMARK · REVIEW_PENDING");
    expect(output).toContain("EVALUATION_INCOMPLETE");
    expect(output).toContain("사람 검수가 필요");
    expect(output).not.toMatch(/평가 완료|EVALUATION_COMPLETE/);
  });

  it("package script는 명시적 production Benchmark entrypoint를 제공한다", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["eval:benchmark"]).toBe(
      "node --import tsx eval/cli/runRecordedBenchmark.ts",
    );
  });
});

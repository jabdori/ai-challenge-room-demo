// @vitest-environment node

import { beforeAll, describe, expect, it, vi } from "vitest";
import { createBenchmarkCandidateDefinition } from "../benchmark/candidateDefinitions";
import {
  assertVerifiedBenchmarkProgressEvent,
  executeBenchmark,
  BenchmarkAmbiguousInFlightError,
  type BenchmarkExecutionSlotPlan,
  type BenchmarkOrchestrationDependencies,
} from "../benchmark/executeBenchmark";
import {
  buildBenchmarkExecutionIdentity,
  buildBenchmarkSlotIdentity,
} from "../benchmark/identity";
import { buildBenchmarkSchedule } from "../benchmark/schedule";
import type {
  BenchmarkSlotCandidateExecutionResult,
  SlotEvaluationState,
} from "../benchmark/executeSlot";
import { executeBenchmarkCandidateSlot } from "../benchmark/executeSlot";
import { buildRunnerInputAccessEvidence } from "../contracts/runnerInputAccessEvidence";
import {
  BENCHMARK_CASES,
  BENCHMARK_CHALLENGE,
  BENCHMARK_ORDERS,
  BENCHMARK_ORACLES,
  BENCHMARK_POLICIES,
} from "../data/benchmark";
import { buildBenchmarkExecutionPack, type BenchmarkExecutionPack } from "../pack/benchmarkPack";
import type {
  BenchmarkIntentClaim,
  BenchmarkSlotArtifact,
  BenchmarkSlotExecutionCheckpoint,
  BenchmarkSlotExecutionIntent,
  BenchmarkSlotExecutionReceipt,
  BenchmarkSlotResumeState,
} from "../pack/benchmarkPersistence";
import { calculateUsageCost, DEFAULT_PRICING_SNAPSHOT } from "../runtime/pricing";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import type { CandidateAdapter } from "../runner/types";
import { LOCKED_CHALLENGE_FIXTURE } from "./helpers/lockedChallengeFixture";

const schedule = buildBenchmarkSchedule(BENCHMARK_CASES, ["A", "B", "C"]);
const executionIdentity = buildBenchmarkExecutionIdentity({
  lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
  scheduleId: schedule.schedule_id,
  policyManifestHash: "1".repeat(64),
  policyResourceIdentityHash: "2".repeat(64),
  policyVectorStoreId: "vs_task7_orchestration_fixture",
});

const adapter: CandidateAdapter = {
  invoke: async () => {
    throw new Error("오케스트레이터 단위 테스트에서는 후보 adapter를 직접 호출하지 않습니다.");
  },
};

function contextFor(slotId: string) {
  const slot = schedule.find((item) => item.slot_id === slotId)!;
  const evaluationCase = BENCHMARK_CASES.find((item) => item.case_id === slot.case_id)!;
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === slot.case_id)!;
  const authoritativeOrder = evaluationCase.order_id === null
    ? null
    : BENCHMARK_ORDERS.find((item) => item.order_id === evaluationCase.order_id)!;
  const expectation = oracle.candidate_access_expectations.find(
    (item) => item.candidate_id === slot.candidate_id,
  )!;
  const accessEvidence = buildRunnerInputAccessEvidence({
    candidateId: slot.candidate_id,
    slotId: slot.slot_id,
    repetition: slot.repetition,
    evaluationCase,
    policies: BENCHMARK_POLICIES,
    authoritativeOrder,
    orderAccessStatus: expectation.expected_order_access_status,
  });
  const candidateDefinition = createBenchmarkCandidateDefinition({
    candidateId: slot.candidate_id,
    evaluationCase,
    authorizedOrder: expectation.expected_order_access_status === "SUCCESS"
      ? authoritativeOrder
      : null,
    policyCorpus: BENCHMARK_POLICIES,
    adapter,
    challenge: BENCHMARK_CHALLENGE,
  });
  const preparedPolicyResource = slot.candidate_id === "A"
    ? undefined
    : {
      policy_corpus_sha256: candidateDefinition.config.policy_corpus_hash,
      chunking_config_sha256: candidateDefinition.config.policy_chunking_config_hash!,
      resource_contract_sha256: candidateDefinition.config.policy_resource_contract_hash!,
      manifest_sha256: executionIdentity.policy_manifest_hash,
      resource_identity_sha256: executionIdentity.policy_resource_identity_hash,
      vector_store_id_hash: executionIdentity.policy_vector_store_id_hash,
    };
  const slotIdentity = buildBenchmarkSlotIdentity({
    executionIdentity,
    slot,
    evaluationCase,
    oracle,
    authoritativeOrder,
    candidateDefinition,
    accessEvidence,
    ...(preparedPolicyResource ? { preparedPolicyResource } : {}),
  });
  return {
    slot,
    evaluationCase,
    oracle,
    authoritativeOrder,
    accessEvidence,
    candidateDefinition,
    slotIdentity,
  };
}

const contexts = new Map(schedule.map((slot) => [slot.slot_id, contextFor(slot.slot_id)]));
const plans: readonly BenchmarkExecutionSlotPlan[] = schedule.map((slot) => {
  const context = contexts.get(slot.slot_id)!;
  return Object.freeze({
    slot_identity: context.slotIdentity,
    execution_options: Object.freeze({
      slot,
      candidateDefinition: context.candidateDefinition,
      evaluationCase: context.evaluationCase,
      oracle: context.oracle,
      policies: BENCHMARK_POLICIES,
      authoritativeOrder: context.authoritativeOrder,
    }),
  });
});

function passGates(): Extract<SlotEvaluationState, { status: "EVALUATED" }>["gates"] {
  return [
    { gateCode: "P0-HG-01", status: "PASS", findings: [], riskCandidates: [] },
    { gateCode: "P0-HG-02", status: "PASS", findings: [], riskCandidates: [] },
    { gateCode: "P0-HG-03", status: "PASS", findings: [], riskCandidates: [] },
    { gateCode: "P0-HG-04", status: "PASS", findings: [], riskCandidates: [] },
  ];
}

function candidateResult(slotId: string): BenchmarkSlotCandidateExecutionResult {
  const context = contexts.get(slotId)!;
  const output = {
    customer_reply: context.oracle.reference_replies[0],
    decision: {
      intent_codes: [...context.oracle.expected_intent_codes],
      action_code: context.oracle.expected_action_code,
      escalation_required: context.oracle.escalation_required,
      escalation_reason_code: context.oracle.escalation_reason_code,
      target_queue: context.oracle.target_queue,
    },
    citations: structuredClone(context.oracle.required_citations),
  };
  const usage = {
    inputTokens: 100 + context.slot.sequence,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 20,
  };
  const usageCost = calculateUsageCost([usage], DEFAULT_PRICING_SNAPSHOT);
  const latencyMs = context.slot.sequence;
  const providerCall = {
    callNumber: 1,
    responseId: `resp-${slotId}`,
    status: "completed" as const,
    modelRequestedId: "gpt-5.6-terra",
    modelReportedId: "gpt-5.6-terra-2026-07-17",
    serviceTierRequested: "default",
    serviceTierReported: "default",
    latencyMs,
    usage,
  };
  const executionEvidence = {
    providerCalls: [providerCall],
    retrievalCalls: [],
    toolCalls: [],
  };
  const run = {
    runNumber: context.slot.repetition,
    status: "COMPLETE" as const,
    attempts: [{
      attemptNumber: 1,
      status: "COMPLETE" as const,
      startedAt: "2026-07-17T00:00:00.000Z",
      latencyMs,
      responseId: providerCall.responseId,
      modelReportedId: providerCall.modelReportedId,
      serviceTierReported: providerCall.serviceTierReported,
      usage,
      executionEvidence,
    }],
    output,
    totalLatencyMs: latencyMs,
  };
  return {
    slot: structuredClone(context.slot),
    executionStatus: "COMPLETE",
    requestDisposition: "SENT_RESPONSE_RECORDED",
    costState: "COMPLETE",
    usageCost,
    totalLatencyMs: latencyMs,
    run,
    accessEvidence: context.accessEvidence,
    completedExecutionEvidence: {
      slotId,
      repetition: context.slot.repetition,
      caseId: context.slot.case_id,
      candidateId: context.slot.candidate_id,
      finalStatus: "COMPLETE",
      finalOutputHash: sha256CanonicalJson(output),
      providerCalls: [providerCall],
      retrievalCalls: [],
      toolCalls: [],
    },
    executionIntegrityError: null,
  };
}

interface StoredSlot {
  intent?: BenchmarkSlotExecutionIntent;
  receipt?: BenchmarkSlotExecutionReceipt;
  checkpoint?: BenchmarkSlotExecutionCheckpoint;
}

class MemoryPersistence {
  readonly slots = new Map<string, StoredSlot>();

  clone(): MemoryPersistence {
    const cloned = new MemoryPersistence();
    for (const [slotId, value] of this.slots) cloned.slots.set(slotId, structuredClone(value));
    return cloned;
  }

  load = async (input: { slot: { slot_id: string } }): Promise<BenchmarkSlotResumeState> => {
    const stored = this.slots.get(input.slot.slot_id);
    if (!stored?.intent) return { state: "NONE" };
    if (!stored.receipt) {
      return {
        state: "INTENT_ONLY",
        resolution: "AMBIGUOUS_IN_FLIGHT",
        allowRemoteCall: false,
        intent: stored.intent,
      };
    }
    if (!stored.checkpoint) {
      return {
        state: "RECEIPT_ONLY",
        resolution: "RECOMPUTE_GATES",
        allowRemoteCall: false,
        intent: stored.intent,
        receipt: stored.receipt,
      };
    }
    return {
      state: "CHECKPOINT",
      resolution: "REUSE",
      intent: stored.intent,
      receipt: stored.receipt,
      checkpoint: stored.checkpoint,
    };
  };

  claim = async (input: { artifact: BenchmarkSlotExecutionIntent }): Promise<BenchmarkIntentClaim> => {
    const stored = this.slots.get(input.artifact.slot_id) ?? {};
    if (stored.intent) {
      return { path: "memory", created: false, allowRemoteCall: false };
    }
    stored.intent = structuredClone(input.artifact);
    this.slots.set(input.artifact.slot_id, stored);
    return { path: "memory", created: true, allowRemoteCall: true };
  };

  persist = async (input: { artifact: BenchmarkSlotArtifact }): Promise<string> => {
    const stored = this.slots.get(input.artifact.slot_id) ?? {};
    if (input.artifact.artifact_kind === "BENCHMARK_SLOT_EXECUTION_INTENT") {
      stored.intent = structuredClone(input.artifact);
    } else if (input.artifact.artifact_kind === "BENCHMARK_SLOT_EXECUTION_RECEIPT") {
      stored.receipt = structuredClone(input.artifact);
    } else {
      stored.checkpoint = structuredClone(input.artifact);
    }
    this.slots.set(input.artifact.slot_id, stored);
    return "memory";
  };
}

function dependenciesFor(
  persistence: MemoryPersistence,
  overrides: Partial<BenchmarkOrchestrationDependencies> = {},
): BenchmarkOrchestrationDependencies {
  return {
    loadResumeState: persistence.load as BenchmarkOrchestrationDependencies["loadResumeState"],
    claimIntent: persistence.claim as BenchmarkOrchestrationDependencies["claimIntent"],
    persistArtifact: persistence.persist as BenchmarkOrchestrationDependencies["persistArtifact"],
    executeCandidateSlot: vi.fn(async (options) => candidateResult(options.slot.slot_id)),
    evaluateReceipt: vi.fn(() => ({ status: "EVALUATED" as const, gates: passGates() })),
    buildPack: buildBenchmarkExecutionPack,
    persistPack: vi.fn(async ({ pack }) => ({
      path: "memory",
      created: true,
      payloadSha256: sha256CanonicalJson(pack),
    })),
    ...overrides,
  };
}

let completedStore: MemoryPersistence;
const referencePack: BenchmarkExecutionPack = {
  schema_version: "benchmark-execution-pack-v1",
  artifact_kind: "BENCHMARK_EXECUTION_PACK",
  source: "RECORDED_BENCHMARK",
  execution_status: "EXECUTION_COMPLETE",
  evaluation_status: "EVALUATION_INCOMPLETE",
  review_status: "NOT_GENERATED",
  baseline_version: null,
  synthetic: true,
  judge_readiness: "READY_FOR_JUDGE",
  execution_hash: executionIdentity.execution_hash,
  locked_challenge_pack_hash: executionIdentity.locked_challenge_pack_hash,
  locked_challenge_contract_hash: executionIdentity.locked_challenge_contract_hash,
  locked_challenge_source_manifest_hash:
    executionIdentity.locked_challenge_source_manifest_hash,
  evaluator_contract_hash: executionIdentity.evaluator_contract_hash,
  schedule_id: schedule.schedule_id,
  coverage: {
    cases: 12,
    candidates: 3,
    runs_per_case: 2,
    expected_runs: 72,
    recorded_runs: 72,
  },
  slots: [],
  candidate_aggregates: [],
};

beforeAll(async () => {
  completedStore = new MemoryPersistence();
  await executeBenchmark({
    outputDirectory: "memory",
    executionIdentity,
    schedule,
    plans,
    dependencies: dependenciesFor(completedStore, {
      buildPack: vi.fn(() => referencePack),
    }),
  });
});

function fastDependencies(
  persistence: MemoryPersistence,
  overrides: Partial<BenchmarkOrchestrationDependencies> = {},
) {
  return dependenciesFor(persistence, {
    buildPack: vi.fn(() => referencePack),
    ...overrides,
  });
}

describe("숨겨진 Benchmark 체크포인트 오케스트레이션", () => {
  it("일반 객체를 source-verified checkpoint progress로 위조할 수 없다", () => {
    expect(() => assertVerifiedBenchmarkProgressEvent({
      completed_checkpoints: 1,
      total_checkpoints: 72,
      checkpoint_payload_sha256: "a".repeat(64),
    })).toThrow(/verified|checkpoint|검증|authority/i);
  });

  it("authoritative lock에서 만들지 않은 cloned execution identity는 원격 실행 전에 거부한다", async () => {
    const loadResumeState = vi.fn();

    await expect(executeBenchmark({
      outputDirectory: "/tmp/lock-free-benchmark-must-not-run",
      executionIdentity: structuredClone(executionIdentity),
      schedule,
      plans,
      dependencies: { loadResumeState },
    })).rejects.toThrow(/Locked Challenge|authoritative|identity|검증/i);
    expect(loadResumeState).not.toHaveBeenCalled();
  });

  it("plan 검증 뒤 await 중 adapter를 바꾸는 object TOCTOU가 원격 경계에 도달하지 않는다", async () => {
    const mutablePlans = plans.map((plan) => ({
      slot_identity: plan.slot_identity,
      execution_options: {
        ...plan.execution_options,
        candidateDefinition: {
          ...plan.execution_options.candidateDefinition,
        },
      },
    })) as unknown as BenchmarkExecutionSlotPlan[];
    const maliciousAdapter: CandidateAdapter = {
      invoke: async () => {
        throw new Error("변조 adapter는 호출되면 안 됩니다.");
      },
    };
    let mutated = false;
    let observedAdapter: CandidateAdapter | undefined;
    const loadResumeState = vi.fn(async (): Promise<BenchmarkSlotResumeState> => {
      if (!mutated) {
        mutated = true;
        const first = mutablePlans[0] as unknown as {
          execution_options: {
            candidateDefinition: Record<string, unknown>;
          };
        };
        first.execution_options.candidateDefinition = {
          ...first.execution_options.candidateDefinition,
          adapter: maliciousAdapter,
        };
      }
      return { state: "NONE" };
    });
    const executeCandidateSlot = vi.fn(async (options) => {
      observedAdapter = options.candidateDefinition.adapter;
      throw new Error("stop-after-adapter-observation");
    });

    await expect(executeBenchmark({
      outputDirectory: "memory",
      executionIdentity,
      schedule,
      plans: mutablePlans,
      dependencies: {
        loadResumeState,
        claimIntent: vi.fn(async () => ({
          path: "memory",
          created: true,
          allowRemoteCall: true,
        })),
        executeCandidateSlot,
      },
    })).rejects.toThrow(/stop-after-adapter-observation/);
    expect(observedAdapter).not.toBe(maliciousAdapter);
  });

  it("검증 뒤 await 중 기존 adapter.invoke를 교체해도 검증 시 캡처한 함수만 사용한다", async () => {
    const safeInvoke = vi.fn(async () => ({
      responseId: null,
      status: "failed" as const,
      modelReportedId: null,
      outputText: null,
      usage: null,
    }));
    const maliciousInvoke = vi.fn(async () => {
      throw new Error("mutated adapter invoke reached remote boundary");
    });
    const mutableAdapter: CandidateAdapter = { invoke: safeInvoke };
    const mutablePlans = plans.map((plan, index) => ({
      slot_identity: plan.slot_identity,
      execution_options: {
        ...plan.execution_options,
        candidateDefinition: index === 0
          ? {
              ...plan.execution_options.candidateDefinition,
              adapter: mutableAdapter,
            }
          : plan.execution_options.candidateDefinition,
      },
    })) as unknown as BenchmarkExecutionSlotPlan[];
    let mutated = false;
    const loadResumeState = vi.fn(async (): Promise<BenchmarkSlotResumeState> => {
      if (!mutated) {
        mutated = true;
        mutableAdapter.invoke = maliciousInvoke;
      }
      return { state: "NONE" };
    });
    const executeCandidateSlot = vi.fn(async (options) => {
      await options.candidateDefinition.adapter.invoke(
        options.candidateDefinition.invocation,
      );
      throw new Error("stop-after-stable-adapter-invoke");
    });

    await expect(executeBenchmark({
      outputDirectory: "memory",
      executionIdentity,
      schedule,
      plans: mutablePlans,
      dependencies: {
        loadResumeState,
        claimIntent: vi.fn(async () => ({
          path: "memory",
          created: true,
          allowRemoteCall: true,
        })),
        executeCandidateSlot,
      },
    })).rejects.toThrow(/stop-after-stable-adapter-invoke/);
    expect(safeInvoke).toHaveBeenCalledOnce();
    expect(maliciousInvoke).not.toHaveBeenCalled();
  });

  it("NONE 72개를 순차 실행하고 checkpoint 재검증 뒤에만 부모 팩과 progress를 생성한다", async () => {
    const persistence = new MemoryPersistence();
    let active = 0;
    let maxActive = 0;
    const executeCandidateSlot = vi.fn(async (options) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const result = candidateResult(options.slot.slot_id);
      active -= 1;
      return result;
    });
    const progress: number[] = [];
    const persistPack = vi.fn(async ({ pack }: { pack: BenchmarkExecutionPack }) => {
      expect([...persistence.slots.values()].filter((item) => item.checkpoint)).toHaveLength(72);
      return {
        path: "memory",
        created: true,
        payloadSha256: sha256CanonicalJson(pack),
      };
    });
    const pack = await executeBenchmark({
      outputDirectory: "memory",
      executionIdentity,
      schedule,
      plans,
      onProgress: (event) => {
        expect(() => assertVerifiedBenchmarkProgressEvent(event)).not.toThrow();
        expect(persistence.slots.get(event.slot.slot_id)?.checkpoint).toBeDefined();
        progress.push(event.completed_checkpoints);
      },
      dependencies: fastDependencies(persistence, { executeCandidateSlot, persistPack }),
    });

    expect(pack).toBe(referencePack);
    expect(executeCandidateSlot).toHaveBeenCalledTimes(72);
    expect(maxActive).toBe(1);
    expect(progress).toEqual(Array.from({ length: 72 }, (_, index) => index + 1));
    expect(persistPack).toHaveBeenCalledOnce();
  });

  it("RECEIPT_ONLY는 외부 호출 없이 gate만 재계산하고 CHECKPOINT는 gate도 재사용한다", async () => {
    const persistence = completedStore.clone();
    const receiptOnlyId = schedule[0].slot_id;
    const checkpointId = schedule[1].slot_id;
    delete persistence.slots.get(receiptOnlyId)!.checkpoint;
    const executeCandidateSlot = vi.fn(async (options) => candidateResult(options.slot.slot_id));
    const evaluateReceipt = vi.fn(() => ({ status: "EVALUATED" as const, gates: passGates() }));
    const sources = new Map<string, string>();

    await executeBenchmark({
      outputDirectory: "memory",
      executionIdentity,
      schedule,
      plans,
      onProgress: (event) => {
        sources.set(event.slot.slot_id, event.source);
      },
      dependencies: fastDependencies(persistence, { executeCandidateSlot, evaluateReceipt }),
    });

    expect(executeCandidateSlot).not.toHaveBeenCalled();
    expect(evaluateReceipt).toHaveBeenCalledTimes(1);
    expect(sources.get(receiptOnlyId)).toBe("RECOMPUTED_GATES");
    expect(sources.get(checkpointId)).toBe("REUSED_CHECKPOINT");
  });

  it("INTENT_ONLY는 즉시 ambiguous로 중단하고 원격·gate·부모 팩을 호출하지 않는다", async () => {
    const persistence = completedStore.clone();
    const slotId = schedule[0].slot_id;
    delete persistence.slots.get(slotId)!.receipt;
    delete persistence.slots.get(slotId)!.checkpoint;
    const executeCandidateSlot = vi.fn(async (options) => candidateResult(options.slot.slot_id));
    const evaluateReceipt = vi.fn(() => ({ status: "EVALUATED" as const, gates: passGates() }));
    const buildPack = vi.fn(() => referencePack);

    await expect(executeBenchmark({
      outputDirectory: "memory",
      executionIdentity,
      schedule,
      plans,
      dependencies: fastDependencies(persistence, {
        executeCandidateSlot,
        evaluateReceipt,
        buildPack,
      }),
    })).rejects.toBeInstanceOf(BenchmarkAmbiguousInFlightError);
    expect(executeCandidateSlot).not.toHaveBeenCalled();
    expect(evaluateReceipt).not.toHaveBeenCalled();
    expect(buildPack).not.toHaveBeenCalled();
  });

  it("claim 경쟁에서 진 호출자는 저장 상태를 다시 읽고 절대로 원격 재호출하지 않는다", async () => {
    const persistence = completedStore.clone();
    const slotId = schedule[0].slot_id;
    const winningCheckpoint = structuredClone(persistence.slots.get(slotId)!);
    persistence.slots.delete(slotId);
    const claimIntent = vi.fn(async () => {
      persistence.slots.set(slotId, winningCheckpoint);
      return { path: "memory", created: false, allowRemoteCall: false };
    });
    const executeCandidateSlot = vi.fn(async (options) => candidateResult(options.slot.slot_id));

    await executeBenchmark({
      outputDirectory: "memory",
      executionIdentity,
      schedule,
      plans,
      dependencies: fastDependencies(persistence, { claimIntent, executeCandidateSlot }),
    });

    expect(claimIntent).toHaveBeenCalledTimes(1);
    expect(executeCandidateSlot).not.toHaveBeenCalled();
  });

  it("원격 결과 뒤 취소되면 receipt를 먼저 남기고 checkpoint·부모 팩 없이 종료한다", async () => {
    const persistence = completedStore.clone();
    const slotId = schedule[0].slot_id;
    persistence.slots.delete(slotId);
    const controller = new AbortController();
    const executeCandidateSlot = vi.fn(async (options) => {
      controller.abort(new Error("synthetic abort after remote result"));
      return candidateResult(options.slot.slot_id);
    });
    const buildPack = vi.fn(() => referencePack);

    await expect(executeBenchmark({
      outputDirectory: "memory",
      executionIdentity,
      schedule,
      plans,
      signal: controller.signal,
      dependencies: fastDependencies(persistence, { executeCandidateSlot, buildPack }),
    })).rejects.toThrow("synthetic abort after remote result");
    expect(persistence.slots.get(slotId)?.receipt).toBeDefined();
    expect(persistence.slots.get(slotId)?.checkpoint).toBeUndefined();
    expect(buildPack).not.toHaveBeenCalled();
  });

  it("실제 runner의 terminal 응답과 취소가 경합해도 receipt를 남긴 뒤 checkpoint 전에 중단한다", async () => {
    const persistence = completedStore.clone();
    const slotId = schedule[0].slot_id;
    const context = contexts.get(slotId)!;
    persistence.slots.delete(slotId);
    const controller = new AbortController();
    const reason = new Error("synthetic abort racing with terminal provider response");
    const recorded = candidateResult(slotId);
    const attempt = recorded.run!.attempts[0];
    const abortingAdapter: CandidateAdapter = {
      invoke: async () => {
        controller.abort(reason);
        return {
          responseId: attempt.responseId!,
          status: "completed",
          modelReportedId: attempt.modelReportedId!,
          serviceTierReported: attempt.serviceTierReported!,
          outputText: JSON.stringify(recorded.run!.output),
          usage: structuredClone(attempt.usage!),
          executionEvidence: {
            providerCalls: structuredClone(attempt.executionEvidence!.providerCalls),
            retrievalCalls: [],
            toolCalls: [],
          },
        };
      },
    };
    const candidateDefinition = createBenchmarkCandidateDefinition({
      candidateId: context.slot.candidate_id,
      evaluationCase: context.evaluationCase,
      authorizedOrder: context.authoritativeOrder,
      policyCorpus: BENCHMARK_POLICIES,
      adapter: abortingAdapter,
      challenge: BENCHMARK_CHALLENGE,
    });
    const actualPlans = plans.map((plan) => plan.slot_identity.slot_id === slotId
      ? Object.freeze({
        ...plan,
        execution_options: Object.freeze({
          ...plan.execution_options,
          candidateDefinition,
        }),
      })
      : plan);
    const buildPack = vi.fn(() => referencePack);
    const evaluateReceipt = vi.fn(() => ({ status: "EVALUATED" as const, gates: passGates() }));

    await expect(executeBenchmark({
      outputDirectory: "memory",
      executionIdentity,
      schedule,
      plans: actualPlans,
      signal: controller.signal,
      dependencies: fastDependencies(persistence, {
        executeCandidateSlot: executeBenchmarkCandidateSlot,
        evaluateReceipt,
        buildPack,
      }),
    })).rejects.toBe(reason);

    expect(persistence.slots.get(slotId)?.receipt).toBeDefined();
    expect(persistence.slots.get(slotId)?.checkpoint).toBeUndefined();
    expect(evaluateReceipt).not.toHaveBeenCalled();
    expect(buildPack).not.toHaveBeenCalled();
  });

  it("progress listener 오류 뒤 재개해도 완료 checkpoint는 원격·gate 재호출하지 않는다", async () => {
    const persistence = completedStore.clone();
    const slotId = schedule[0].slot_id;
    persistence.slots.delete(slotId);
    const firstRemote = vi.fn(async (options) => candidateResult(options.slot.slot_id));

    await expect(executeBenchmark({
      outputDirectory: "memory",
      executionIdentity,
      schedule,
      plans,
      onProgress: () => {
        throw new Error("synthetic progress listener failure");
      },
      dependencies: fastDependencies(persistence, { executeCandidateSlot: firstRemote }),
    })).rejects.toThrow("synthetic progress listener failure");
    expect(firstRemote).toHaveBeenCalledTimes(1);
    expect(persistence.slots.get(slotId)?.checkpoint).toBeDefined();

    const resumedRemote = vi.fn(async (options) => candidateResult(options.slot.slot_id));
    const resumedGate = vi.fn(() => ({ status: "EVALUATED" as const, gates: passGates() }));
    await executeBenchmark({
      outputDirectory: "memory",
      executionIdentity,
      schedule,
      plans,
      dependencies: fastDependencies(persistence, {
        executeCandidateSlot: resumedRemote,
        evaluateReceipt: resumedGate,
      }),
    });
    expect(resumedRemote).not.toHaveBeenCalled();
    expect(resumedGate).not.toHaveBeenCalled();
  });

  it("72개 계획을 모두 검증하기 전에는 잘못된 identity로 원격 호출을 시작하지 않는다", async () => {
    const persistence = new MemoryPersistence();
    const forged = plans.map((plan, index) => index === 71
      ? {
        ...plan,
        slot_identity: structuredClone(plan.slot_identity),
      }
      : plan) as BenchmarkExecutionSlotPlan[];
    (forged[71].slot_identity as { case_hash: string }).case_hash = "9".repeat(64);
    const executeCandidateSlot = vi.fn(async (options) => candidateResult(options.slot.slot_id));

    await expect(executeBenchmark({
      outputDirectory: "memory",
      executionIdentity,
      schedule,
      plans: forged,
      dependencies: fastDependencies(persistence, { executeCandidateSlot }),
    })).rejects.toThrow(/identity/);
    expect(executeCandidateSlot).not.toHaveBeenCalled();
    expect(persistence.slots.size).toBe(0);
  });

  it.each(["schedule_id", "challenge_hash", "pricing_snapshot_hash"] as const)(
    "self-consistent하게 위조된 execution %s도 첫 원격 호출 전에 거부한다",
    async (field) => {
      const persistence = new MemoryPersistence();
      const forged = structuredClone(executionIdentity) as unknown as Record<string, unknown>;
      forged[field] = "8".repeat(64);
      const { execution_hash: _oldHash, ...payload } = forged;
      forged.execution_hash = sha256CanonicalJson(payload);
      const executeCandidateSlot = vi.fn(async (options) => candidateResult(options.slot.slot_id));

      await expect(executeBenchmark({
        outputDirectory: "memory",
        executionIdentity: forged as unknown as typeof executionIdentity,
        schedule,
        plans,
        dependencies: fastDependencies(persistence, { executeCandidateSlot }),
      })).rejects.toThrow(/execution identity/i);
      expect(executeCandidateSlot).not.toHaveBeenCalled();
      expect(persistence.slots.size).toBe(0);
    },
  );
});

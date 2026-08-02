// @vitest-environment node

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  symlink,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  benchmarkSlotIdentityHashes,
  buildBenchmarkExecutionIdentity,
  buildBenchmarkSlotIdentity,
  type BenchmarkSlotIdentity,
} from "../benchmark/identity";
import { createBenchmarkCandidateDefinition } from "../benchmark/candidateDefinitions";
import { buildBenchmarkSchedule } from "../benchmark/schedule";
import { buildRunnerInputAccessEvidence } from "../contracts/runnerInputAccessEvidence";
import { buildCandidateFacingOrderSnapshot } from "../contracts/runnerInputAccessEvidence";
import type { ProviderCallEvidence } from "../contracts/executionEvidence";
import {
  BENCHMARK_CASES,
  BENCHMARK_CHALLENGE,
  BENCHMARK_ORDERS,
  BENCHMARK_ORACLES,
  BENCHMARK_POLICIES,
} from "../data/benchmark";
import type { CandidateAdapter } from "../runner/types";
import {
  assertAuxiliaryJudgeEligibleBenchmarkExecutionPack,
  buildBenchmarkExecutionPack,
  type BenchmarkCompletedSlot,
} from "../pack/benchmarkPack";
import {
  createBenchmarkExecutionPackPaths,
  persistBenchmarkExecutionPack,
} from "../pack/benchmarkPackPersistence";
import type {
  BenchmarkSlotExecutionCheckpoint,
  BenchmarkSlotExecutionIntent,
  BenchmarkSlotExecutionReceipt,
} from "../pack/benchmarkPersistence";
import { canonicalJsonStringify, sha256CanonicalJson } from "../runtime/canonicalJson";
import { calculateUsageCost, DEFAULT_PRICING_SNAPSHOT } from "../runtime/pricing";
import { inspectProviderUsageLedger } from "../runtime/providerUsageLedger";
import { evaluateHardGates } from "../deterministic/hardGates";
import { LOCKED_CHALLENGE_FIXTURE } from "./helpers/lockedChallengeFixture";

async function secureTempDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await chmod(directory, 0o700);
  return directory;
}

const schedule = buildBenchmarkSchedule(BENCHMARK_CASES, ["A", "B", "C"]);
const executionIdentity = buildBenchmarkExecutionIdentity({
  lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
  scheduleId: schedule.schedule_id,
  policyManifestHash: "1".repeat(64),
  policyResourceIdentityHash: "2".repeat(64),
  policyVectorStoreId: "vs_task7_offline_fixture",
});

function hash(label: string): string {
  return sha256CanonicalJson({ label });
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectKeys(child)]);
}

const neverCalledAdapter: CandidateAdapter = {
  invoke: async () => {
    throw new Error("offline identity fixture adapter must not be called");
  },
};

function makeSlotContext(index: number) {
  const slot = schedule[index];
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
  const definition = createBenchmarkCandidateDefinition({
    candidateId: slot.candidate_id,
    evaluationCase,
    authorizedOrder: expectation.expected_order_access_status === "SUCCESS"
      ? authoritativeOrder
      : null,
    policyCorpus: BENCHMARK_POLICIES,
    adapter: neverCalledAdapter,
    challenge: BENCHMARK_CHALLENGE,
  });
  const preparedPolicyResource = slot.candidate_id === "A"
    ? undefined
    : {
      policy_corpus_sha256: definition.config.policy_corpus_hash,
      chunking_config_sha256: definition.config.policy_chunking_config_hash!,
      resource_contract_sha256: definition.config.policy_resource_contract_hash!,
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
    candidateDefinition: definition,
    accessEvidence,
    ...(preparedPolicyResource ? { preparedPolicyResource } : {}),
  });
  return { slotIdentity, accessEvidence };
}

function outputFor(index: number) {
  const slot = schedule[index];
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === slot.case_id)!;
  return {
    customer_reply: oracle.reference_replies[0],
    decision: {
      intent_codes: [...oracle.expected_intent_codes],
      action_code: oracle.expected_action_code,
      escalation_required: oracle.escalation_required,
      escalation_reason_code: oracle.escalation_reason_code,
      target_queue: oracle.target_queue,
    },
    citations: structuredClone(oracle.required_citations),
  };
}

function toolStatusForResultCode(
  resultCode: string,
): "COMPLETE" | "TIMEOUT" | "FAILED" {
  if (
    resultCode === "OK"
    || resultCode === "ORDER_OWNERSHIP_MISMATCH"
    || resultCode === "ORDER_RESULT_MISMATCH"
    || resultCode === "ORDER_NOT_FOUND"
  ) {
    return "COMPLETE";
  }
  return resultCode === "TOOL_TIMEOUT" ? "TIMEOUT" : "FAILED";
}

function executionEvidenceFor(
  index: number,
  accessEvidence: ReturnType<typeof buildRunnerInputAccessEvidence>,
  providerCall: ProviderCallEvidence,
) {
  const slot = schedule[index];
  const evaluationCase = BENCHMARK_CASES.find((item) => item.case_id === slot.case_id)!;
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === slot.case_id)!;
  const authoritativeOrder = evaluationCase.order_id === null
    ? null
    : BENCHMARK_ORDERS.find((item) => item.order_id === evaluationCase.order_id)!;
  const expectation = oracle.candidate_access_expectations.find(
    (item) => item.candidate_id === slot.candidate_id,
  )!;
  const policyResults = oracle.required_citations.map((citation, resultIndex) => ({
    rank: resultIndex + 1,
    fileId: `file-${citation.source_id}`,
    filename: `${citation.source_id}.md`,
    score: 1 - resultIndex * 0.01,
    sourceId: citation.source_id,
    sectionId: citation.section_id,
    factId: `FACT-${slot.case_id}-${resultIndex + 1}`,
    text: `Synthetic evidence for ${citation.source_id} ${citation.section_id}.`,
  }));
  const retrievalCalls = expectation.required_runner_retrieval_calls === 0
    && !expectation.required_tool_calls.some((item) => item.tool_name === "search_policy")
    ? []
    : [{
      callNumber: 1,
      operation: "VECTOR_STORE_SEARCH" as const,
      status: "COMPLETE" as const,
      requestedQuery: `policy ${slot.case_id}`,
      reportedQuery: null,
      vectorStoreIdHash: executionIdentity.policy_vector_store_id_hash,
      maxNumResults: 6,
      rewriteQuery: false,
      latencyMs: 1,
      results: policyResults,
    }];
  const toolCalls = expectation.required_tool_calls.map((required, toolIndex) => {
    const argumentsRecord: Record<string, string> = { ...required.required_arguments };
    for (const name of required.required_nonempty_arguments) {
      argumentsRecord[name] = name === "query"
        ? `policy ${slot.case_id}`
        : name === "as_of"
          ? evaluationCase.as_of
          : name === "order_id"
            ? evaluationCase.order_id ?? "ORDER-NOT-REQUIRED"
            : evaluationCase.authenticated_customer_id;
    }
    const ok = required.expected_result_code === "OK";
    const result = ok
      ? {
        ok: true,
        result_code: "OK",
        data: required.tool_name === "get_order"
          ? buildCandidateFacingOrderSnapshot(authoritativeOrder!)
          : { query: argumentsRecord.query, as_of: argumentsRecord.as_of, results: [] },
      }
      : {
        ok: false,
        result_code: required.expected_result_code,
        data: null,
        error: { code: required.expected_result_code, message: "Synthetic tool failure." },
      };
    return {
      callNumber: toolIndex + 1,
      modelTurn: 1,
      callId: `call-${slot.slot_id}-${required.tool_name}`,
      toolName: required.tool_name,
      status: toolStatusForResultCode(required.expected_result_code),
      arguments: argumentsRecord,
      argumentsJson: JSON.stringify(argumentsRecord),
      providerStatus: "completed",
      result,
      latencyMs: 1,
    };
  });
  const completedRetrievalCalls = retrievalCalls.map((call, retrievalIndex) => {
    const linkedTool = slot.candidate_id === "C"
      ? toolCalls.find((item) => item.toolName === "search_policy")
      : undefined;
    return {
      ...structuredClone(call),
      evidenceId: `${slot.slot_id}:retrieval:${retrievalIndex + 1}`,
      origin: slot.candidate_id === "C" ? "TOOL_SEARCH" as const : "RUNNER_PREFETCH" as const,
      linkedToolCallId: linkedTool?.callId ?? null,
      corpusHash: accessEvidence.policyAccess.corpusHash,
      manifestHash: accessEvidence.policyAccess.manifestHash,
      asOf: evaluationCase.as_of,
    };
  });
  const completedToolCalls = toolCalls.map((call, toolIndex) => ({
    ...structuredClone(call),
    evidenceId: `${slot.slot_id}:tool:${toolIndex + 1}`,
    resultCode: expectation.required_tool_calls[toolIndex].expected_result_code,
    linkedRetrievalEvidenceIds: call.toolName === "search_policy"
      ? completedRetrievalCalls.map((item) => item.evidenceId)
      : [],
    resultHash: sha256CanonicalJson(call.result),
  }));
  return {
    attempt: {
      providerCalls: [providerCall],
      retrievalCalls,
      toolCalls,
    },
    completed: {
      providerCalls: [providerCall],
      retrievalCalls: completedRetrievalCalls,
      toolCalls: completedToolCalls,
    },
  };
}

function makeUsageCost(index: number) {
  const input = 100 + index;
  const output = 20;
  return calculateUsageCost({
    inputTokens: input,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: output,
  }, DEFAULT_PRICING_SNAPSHOT)!;
}

function makeCompletedSlot(index: number): BenchmarkCompletedSlot {
  const slot = schedule[index];
  const { slotIdentity, accessEvidence } = makeSlotContext(index);
  const identityHashes = benchmarkSlotIdentityHashes(executionIdentity, slotIdentity);
  const output = outputFor(index);
  const usageCost = makeUsageCost(index);
  const usage = {
    inputTokens: usageCost.tokenBreakdown.regularInputTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: usageCost.tokenBreakdown.outputTokens,
  };
  const intent = {
    artifact_kind: "BENCHMARK_SLOT_EXECUTION_INTENT",
    execution_hash: executionIdentity.execution_hash,
    schedule_id: schedule.schedule_id,
    slot_identity_hash: slotIdentity.slot_identity_hash,
    slot_id: slot.slot_id,
    sequence: slot.sequence,
    repetition: slot.repetition,
    identity_hashes: identityHashes,
    execution: {
      schema_version: "benchmark-slot-intent-v1",
      candidate_id: slot.candidate_id,
      run_number: slot.repetition,
      invocation_hash: slotIdentity.invocation_hash,
    },
  } satisfies BenchmarkSlotExecutionIntent;
  const latencyMs = index + 1;
  const providerCall = {
    callNumber: 1,
    responseId: `resp-${slot.slot_id}`,
    status: "completed" as const,
    modelRequestedId: "gpt-5.6-terra",
    modelReportedId: "gpt-5.6-terra-2026-07-17",
    serviceTierRequested: "default",
    serviceTierReported: "default",
    latencyMs,
    usage,
  };
  const evidence = executionEvidenceFor(index, accessEvidence, providerCall);
  const executionEvidence = evidence.attempt;
  const run = {
    runNumber: slot.repetition,
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
  const receipt = {
    artifact_kind: "BENCHMARK_SLOT_EXECUTION_RECEIPT",
    execution_hash: executionIdentity.execution_hash,
    schedule_id: schedule.schedule_id,
    slot_identity_hash: slotIdentity.slot_identity_hash,
    slot_id: slot.slot_id,
    sequence: slot.sequence,
    repetition: slot.repetition,
    identity_hashes: identityHashes,
    intent_payload_sha256: sha256CanonicalJson(intent),
    execution: {
      schema_version: "benchmark-slot-receipt-v1",
      slot_result: {
        slot: structuredClone(slot),
        executionStatus: "COMPLETE",
        requestDisposition: "SENT_RESPONSE_RECORDED",
        costState: "COMPLETE",
        usageCost,
        totalLatencyMs: latencyMs,
        run,
        accessEvidence,
        completedExecutionEvidence: {
          slotId: slot.slot_id,
          repetition: slot.repetition,
          caseId: slot.case_id,
          candidateId: slot.candidate_id,
          finalStatus: "COMPLETE",
          finalOutputHash: sha256CanonicalJson(output),
          ...evidence.completed,
        },
      },
    },
  } satisfies BenchmarkSlotExecutionReceipt;
  const checkpoint = {
    artifact_kind: "BENCHMARK_SLOT_EXECUTION_CHECKPOINT",
    execution_hash: executionIdentity.execution_hash,
    schedule_id: schedule.schedule_id,
    slot_identity_hash: slotIdentity.slot_identity_hash,
    slot_id: slot.slot_id,
    sequence: slot.sequence,
    repetition: slot.repetition,
    identity_hashes: identityHashes,
    intent_payload_sha256: sha256CanonicalJson(intent),
    receipt_payload_sha256: sha256CanonicalJson(receipt),
    execution: {
      schema_version: "benchmark-slot-checkpoint-v1",
      evaluation_state: {
        status: "EVALUATED",
        gates: evaluateHardGates({
          candidateId: slot.candidate_id,
          slotId: slot.slot_id,
          repetition: slot.repetition,
          evaluationCase: BENCHMARK_CASES.find((item) => item.case_id === slot.case_id)!,
          oracle: BENCHMARK_ORACLES.find((item) => item.case_id === slot.case_id)!,
          policies: BENCHMARK_POLICIES,
          authoritativeOrder: BENCHMARK_CASES.find((item) => item.case_id === slot.case_id)!.order_id === null
            ? null
            : BENCHMARK_ORDERS.find(
              (item) => item.order_id === BENCHMARK_CASES.find(
                (evaluationCase) => evaluationCase.case_id === slot.case_id,
              )!.order_id,
            )!,
          accessEvidence,
          output,
          executionEvidence: {
            slotId: slot.slot_id,
            repetition: slot.repetition,
            caseId: slot.case_id,
            candidateId: slot.candidate_id,
            finalStatus: "COMPLETE",
            finalOutputHash: sha256CanonicalJson(output),
            ...evidence.completed,
          },
        }).gates,
      },
    },
  } satisfies BenchmarkSlotExecutionCheckpoint;
  return { slot_identity: slotIdentity, intent, receipt, checkpoint };
}

function makeAllPassSlots(): BenchmarkCompletedSlot[] {
  return schedule.map((_, index) => makeCompletedSlot(index));
}

function recomputeCheckpoint(target: BenchmarkCompletedSlot): void {
  const slot = schedule.find((item) => item.slot_id === target.intent.slot_id)!;
  const evaluationCase = BENCHMARK_CASES.find((item) => item.case_id === slot.case_id)!;
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === slot.case_id)!;
  const authoritativeOrder = evaluationCase.order_id === null
    ? null
    : BENCHMARK_ORDERS.find((item) => item.order_id === evaluationCase.order_id)!;
  const result = target.receipt.execution.slot_result as Record<string, unknown>;
  const run = result.run as Record<string, unknown>;
  (target.checkpoint.execution as { evaluation_state: unknown }).evaluation_state = {
    status: "EVALUATED",
    gates: evaluateHardGates({
      candidateId: slot.candidate_id,
      slotId: slot.slot_id,
      repetition: slot.repetition,
      evaluationCase,
      oracle,
      policies: BENCHMARK_POLICIES,
      authoritativeOrder,
      accessEvidence: result.accessEvidence as Parameters<typeof evaluateHardGates>[0]["accessEvidence"],
      output: run.output as Parameters<typeof evaluateHardGates>[0]["output"],
      executionEvidence: result.completedExecutionEvidence as Parameters<typeof evaluateHardGates>[0]["executionEvidence"],
    }).gates,
  };
  (target.checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
    sha256CanonicalJson(target.receipt);
}

function forgeSelfConsistentSlotIdentity(
  slots: BenchmarkCompletedSlot[],
  field:
    | "case_hash"
    | "oracle_hash"
    | "authoritative_order_hash"
    | "input_access_hash"
    | "candidate_config_hash"
    | "system_prompt_hash"
    | "invocation_hash",
): BenchmarkCompletedSlot[] {
  const target = slots[0];
  const mutableIdentity = target.slot_identity as unknown as Record<string, unknown>;
  mutableIdentity[field] = hash(`forged:${field}`);
  const { slot_identity_hash: _oldHash, ...payload } = mutableIdentity;
  mutableIdentity.slot_identity_hash = sha256CanonicalJson(payload);
  const identityHashes = benchmarkSlotIdentityHashes(
    executionIdentity,
    target.slot_identity,
  );
  for (const artifact of [target.intent, target.receipt, target.checkpoint]) {
    const mutable = artifact as unknown as Record<string, unknown>;
    mutable.slot_identity_hash = mutableIdentity.slot_identity_hash;
    mutable.identity_hashes = identityHashes;
  }
  if (field === "invocation_hash") {
    (target.intent.execution as { invocation_hash: string }).invocation_hash =
      mutableIdentity.invocation_hash as string;
  }
  (target.receipt as { intent_payload_sha256: string }).intent_payload_sha256 =
    sha256CanonicalJson(target.intent);
  (target.checkpoint as { intent_payload_sha256: string }).intent_payload_sha256 =
    sha256CanonicalJson(target.intent);
  (target.checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
    sha256CanonicalJson(target.receipt);
  return slots;
}

function build(slots = makeAllPassSlots()) {
  return buildBenchmarkExecutionPack({
    executionIdentity,
    schedule,
    completedSlots: slots,
  });
}

describe("Recorded Benchmark 부모 팩", () => {
  it("잠긴 72개 checkpoint만 고정 상태의 실행 팩으로 승격한다", () => {
    const pack = build();

    expect(pack).toMatchObject({
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
    });
    expect(pack.slots).toHaveLength(72);
    expect(pack.slots[0].intent_payload_sha256).toBe(
      sha256CanonicalJson(makeCompletedSlot(0).intent),
    );
    expect(pack.candidate_aggregates).toHaveLength(3);
    expect(pack.candidate_aggregates.map((item) => item.candidate_id)).toEqual(["A", "B", "C"]);
    expect(pack.candidate_aggregates.every((item) => item.counts.scheduled_runs === 24))
      .toBe(true);
    expect(pack.candidate_aggregates.every((item) => item.valid_run_sufficiency)).toBe(true);
    expect(pack.candidate_aggregates.every((item) => item.hard_gate_sufficiency)).toBe(true);

    expect([
      ...Object.keys(pack),
      ...collectKeys(pack.candidate_aggregates),
    ].join(" ")).not.toMatch(
      /composite|winner|approved|recommendation|selected_candidate|judge_cost/i,
    );
    expect(pack.baseline_version).toBeNull();
  });

  it("검증 뒤 Proxy가 schedule_id를 바꿔도 잠긴 일정 식별자만 부모 팩에 기록한다", () => {
    let scheduleIdReads = 0;
    const mutableSchedule = schedule.map((slot) => ({ ...slot }));
    const proxiedSchedule = new Proxy(mutableSchedule, {
      get(target, property, receiver) {
        if (property === "schedule_id") {
          scheduleIdReads += 1;
          return scheduleIdReads <= 2 ? schedule.schedule_id : "f".repeat(64);
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as typeof schedule;

    const pack = buildBenchmarkExecutionPack({
      executionIdentity,
      schedule: proxiedSchedule,
      completedSlots: makeAllPassSlots(),
    });

    expect(pack.schedule_id).toBe(schedule.schedule_id);
  });

  it("검증 뒤 Proxy가 receipt를 바꿔도 최초 canonical snapshot의 hash만 기록한다", () => {
    const slots = makeAllPassSlots();
    const target = slots[0];
    const originalReceipt = target.receipt;
    const forgedReceipt = structuredClone(originalReceipt);
    const forgedResult = forgedReceipt.execution.slot_result as Record<string, any>;
    forgedResult.totalLatencyMs += 1;
    forgedResult.run.totalLatencyMs += 1;
    let receiptReads = 0;
    slots[0] = new Proxy(target, {
      get(source, property, receiver) {
        if (property === "receipt") {
          receiptReads += 1;
          return receiptReads <= 5 ? originalReceipt : forgedReceipt;
        }
        return Reflect.get(source, property, receiver);
      },
    });

    const pack = build(slots);

    expect(receiptReads).toBe(1);
    expect(pack.slots[0].receipt_payload_sha256).toBe(
      sha256CanonicalJson(originalReceipt),
    );
  });

  it("실제 비용 평균, 중앙 지연, 최악 지연과 두 반복 안정성만 집계한다", () => {
    const pack = build();
    const candidateA = pack.candidate_aggregates.find((item) => item.candidate_id === "A")!;
    const aSlots = pack.slots.filter((item) => item.slot.candidate_id === "A");
    const costs = aSlots.map((item) => item.usage_cost?.totalCostUsd ?? 0);
    const latencies = aSlots.map((item) => item.total_latency_ms).sort((a, b) => a - b);

    expect(candidateA.cost.total_usd).toBeCloseTo(costs.reduce((sum, item) => sum + item, 0), 12);
    expect(candidateA.cost.average_usd_per_ticket).toBeCloseTo(
      costs.reduce((sum, item) => sum + item, 0) / 24,
      12,
    );
    expect(candidateA.latency.median_ms).toBe((latencies[11] + latencies[12]) / 2);
    expect(candidateA.latency.worst_ms).toBe(Math.max(...latencies));
    expect(candidateA.stability).toEqual({
      comparable_cases: 12,
      stable_cases: 12,
      unstable_cases: 0,
      not_evaluable_cases: 0,
    });
    expect(candidateA.counts).toMatchObject({
      policy_applicable_cases: 12,
      policy_success_cases: 12,
      citation_required_cases: 11,
      citation_success_cases: 11,
      escalation_required_cases: 4,
      escalation_success_cases: 4,
    });
  });

  it("비용 증거가 불완전하면 0으로 채우지 않고 비용 합계·평균과 Judge 승격을 막는다", () => {
    const slots = makeAllPassSlots();
    const target = slots.find((item) => item.intent.slot_id === "H-001--A--r1")!;
    const result = target.receipt.execution.slot_result as Record<string, unknown>;
    const run = result.run as Record<string, unknown>;
    const attempts = run.attempts as Array<Record<string, unknown>>;
    delete attempts[0].usage;
    const attemptEvidence = attempts[0].executionEvidence as Record<string, unknown>;
    const attemptProviderCalls = attemptEvidence.providerCalls as Array<Record<string, unknown>>;
    attemptProviderCalls[0].usage = null;
    const completed = result.completedExecutionEvidence as Record<string, unknown>;
    const completedProviderCalls = completed.providerCalls as Array<Record<string, unknown>>;
    completedProviderCalls[0].usage = null;
    result.costState = "COST_INCOMPLETE";
    result.usageCost = null;
    recomputeCheckpoint(target);

    const pack = build(slots);
    const candidateA = pack.candidate_aggregates.find((item) => item.candidate_id === "A")!;
    expect(pack.judge_readiness).toBe("BLOCKED_BY_INTEGRITY");
    expect(() => assertAuxiliaryJudgeEligibleBenchmarkExecutionPack(pack))
      .toThrow(/비용|무결성|Judge/i);
    expect(candidateA.cost).toMatchObject({
      accounted_runs: 23,
      charged_runs: 23,
      total_usd: null,
      average_usd_per_ticket: null,
    });
  });

  it("두 반복의 결정 또는 인용이 다르면 고객 문구가 같아도 unstable로 집계한다", () => {
    const slots = makeAllPassSlots();
    const target = slots.find((item) => item.intent.slot_id === "H-001--A--r2")!;
    const result = target.receipt.execution.slot_result as Record<string, unknown>;
    const run = result.run as Record<string, unknown>;
    const output = run.output as Record<string, unknown>;
    output.citations = [];
    const completed = result.completedExecutionEvidence as Record<string, unknown>;
    completed.finalOutputHash = sha256CanonicalJson(output);
    recomputeCheckpoint(target);

    const pack = build(slots);
    const candidateA = pack.candidate_aggregates.find((item) => item.candidate_id === "A")!;
    expect(candidateA.stability).toEqual({
      comparable_cases: 12,
      stable_cases: 11,
      unstable_cases: 1,
      not_evaluable_cases: 0,
    });
  });

  it("결정적 gate 실패를 평균으로 상쇄하지 않고 해당 후보 gate sufficiency만 false로 둔다", () => {
    const slots = makeAllPassSlots();
    const target = slots.find((item) => item.intent.slot_id === "H-001--A--r1")!;
    const result = target.receipt.execution.slot_result as Record<string, unknown>;
    const run = result.run as Record<string, unknown>;
    const output = run.output as Record<string, unknown>;
    const decision = output.decision as Record<string, unknown>;
    decision.action_code = "REFUND_APPROVED";
    const completed = result.completedExecutionEvidence as Record<string, unknown>;
    completed.finalOutputHash = sha256CanonicalJson(output);
    recomputeCheckpoint(target);

    const pack = build(slots);
    const candidateA = pack.candidate_aggregates.find((item) => item.candidate_id === "A")!;
    expect(candidateA.counts.hard_gate_failed_runs).toBe(1);
    expect(candidateA.counts.hard_gate_failed_cases).toBe(1);
    expect(candidateA.hard_gate_sufficiency).toBe(false);
    expect(candidateA.valid_run_sufficiency).toBe(true);
    expect([
      ...Object.keys(pack),
      ...collectKeys(pack.candidate_aggregates),
    ].join(" ")).not.toMatch(/winner|approved|recommendation/i);
  });

  it("terminal INVALID slot은 팩 실행 완료를 막지 않지만 valid-run sufficiency를 false로 둔다", () => {
    const slots = makeAllPassSlots();
    const target = slots.find((item) => item.intent.slot_id === "H-002--A--r1")!;
    const result = target.receipt.execution.slot_result as Record<string, unknown>;
    const completedRun = result.run as Record<string, unknown>;
    const completedAttempt = (completedRun.attempts as Array<Record<string, unknown>>)[0];
    result.executionStatus = "INVALID";
    result.run = {
      runNumber: 1,
      status: "INVALID",
      attempts: [{
        ...completedAttempt,
        status: "INVALID_OUTPUT",
      }],
      totalLatencyMs: result.totalLatencyMs,
    };
    result.completedExecutionEvidence = null;
    (target.checkpoint.execution as { evaluation_state: unknown }).evaluation_state = {
      status: "NOT_EVALUATED",
      reason: "INVALID_OUTPUT",
    };
    (target.checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
      sha256CanonicalJson(target.receipt);

    const pack = build(slots);
    const candidateA = pack.candidate_aggregates.find((item) => item.candidate_id === "A")!;
    expect(pack.execution_status).toBe("EXECUTION_COMPLETE");
    expect(pack.judge_readiness).toBe("INSUFFICIENT_VALID_OUTPUTS");
    expect(() => assertAuxiliaryJudgeEligibleBenchmarkExecutionPack(pack)).not.toThrow();
    expect(candidateA.counts.invalid_runs).toBe(1);
    expect(candidateA.valid_run_sufficiency).toBe(false);
    expect(candidateA.stability.not_evaluable_cases).toBe(1);
  });

  it.each([
    ["TIMEOUT", "TIMEOUT", "timeout_runs"],
    ["BUDGET_EXCEEDED", "BUDGET_EXCEEDED", "budget_exceeded_runs"],
  ] as const)("terminal %s slot을 hard-gate 실패로 오인하지 않고 팩에 보존한다", (
    executionStatus,
    reason,
    countKey,
  ) => {
    const slots = makeAllPassSlots();
    const target = slots.find((item) => item.intent.slot_id === "H-002--A--r1")!;
    const result = target.receipt.execution.slot_result as Record<string, unknown>;
    const run = result.run as Record<string, unknown>;
    const attempts = run.attempts as Array<Record<string, unknown>>;
    result.executionStatus = executionStatus;
    run.status = executionStatus;
    attempts[0].status = executionStatus;
    delete run.output;
    result.completedExecutionEvidence = null;
    (target.checkpoint.execution as { evaluation_state: unknown }).evaluation_state = {
      status: "NOT_EVALUATED",
      reason,
    };
    (target.checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
      sha256CanonicalJson(target.receipt);

    const pack = build(slots);
    const candidateA = pack.candidate_aggregates.find((item) => item.candidate_id === "A")!;
    expect(pack.judge_readiness).toBe("INSUFFICIENT_VALID_OUTPUTS");
    expect(() => assertAuxiliaryJudgeEligibleBenchmarkExecutionPack(pack)).not.toThrow();
    expect(candidateA.counts[countKey]).toBe(1);
    expect(candidateA.counts.hard_gate_failed_runs).toBe(0);
    expect(candidateA.valid_run_sufficiency).toBe(false);
  });

  it("provider 호출 전 로컬 BUDGET_EXCEEDED를 알려진 무료 실행으로 보존한다", () => {
    const slots = makeAllPassSlots();
    const target = slots.find((item) => item.intent.slot_id === "H-002--A--r1")!;
    const result = target.receipt.execution.slot_result as Record<string, unknown>;
    const run = result.run as Record<string, unknown>;
    const attempts = run.attempts as Array<Record<string, unknown>>;
    const attempt = attempts[0];
    result.executionStatus = "BUDGET_EXCEEDED";
    result.requestDisposition = "NOT_SENT";
    result.costState = "COMPLETE";
    result.usageCost = null;
    run.status = "BUDGET_EXCEEDED";
    attempt.status = "BUDGET_EXCEEDED";
    delete attempt.responseId;
    delete attempt.modelReportedId;
    delete attempt.serviceTierReported;
    delete attempt.usage;
    delete attempt.executionEvidence;
    delete run.output;
    result.completedExecutionEvidence = null;
    (target.checkpoint.execution as { evaluation_state: unknown }).evaluation_state = {
      status: "NOT_EVALUATED",
      reason: "BUDGET_EXCEEDED",
    };
    (target.checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
      sha256CanonicalJson(target.receipt);

    const pack = build(slots);
    const candidateA = pack.candidate_aggregates.find((item) => item.candidate_id === "A")!;
    const recorded = pack.slots.find((item) => item.slot.slot_id === target.intent.slot_id)!;
    const ledger = inspectProviderUsageLedger(
      ((recorded.run as Record<string, unknown>).attempts as Parameters<
        typeof inspectProviderUsageLedger
      >[0]),
    );
    const chargedCost = pack.slots
      .filter((item) => item.slot.candidate_id === "A")
      .reduce((sum, item) => sum + (item.usage_cost?.totalCostUsd ?? 0), 0);

    expect(pack.judge_readiness).toBe("INSUFFICIENT_VALID_OUTPUTS");
    expect(() => assertAuxiliaryJudgeEligibleBenchmarkExecutionPack(pack)).not.toThrow();
    expect(recorded).toMatchObject({
      execution_status: "BUDGET_EXCEEDED",
      request_disposition: "NOT_SENT",
      cost_state: "COMPLETE",
      usage_cost: null,
    });
    expect(ledger).toMatchObject({ state: "COMPLETE", providerCallCount: 0 });
    expect(candidateA.valid_run_sufficiency).toBe(false);
    expect(candidateA.counts.hard_gate_failed_runs).toBe(0);
    expect(candidateA.cost).toMatchObject({
      accounted_runs: 24,
      charged_runs: 23,
      total_usd: chargedCost,
    });
    expect(candidateA.cost.average_usd_per_ticket).toBeCloseTo(chargedCost / 24, 12);
  });

  it("response metadata만 남기고 providerCalls·usage를 지운 BUDGET은 known-free로 위조할 수 없다", () => {
    const slots = makeAllPassSlots();
    const target = slots.find((item) => item.intent.slot_id === "H-002--A--r1")!;
    const result = target.receipt.execution.slot_result as Record<string, unknown>;
    const run = result.run as Record<string, unknown>;
    const attempt = (run.attempts as Array<Record<string, unknown>>)[0];
    result.executionStatus = "BUDGET_EXCEEDED";
    result.requestDisposition = "NOT_SENT";
    result.costState = "COMPLETE";
    result.usageCost = null;
    run.status = "BUDGET_EXCEEDED";
    attempt.status = "BUDGET_EXCEEDED";
    // responseId는 지우되 model/service metadata를 남겨 무료 로컬 실패로 위장합니다.
    delete attempt.responseId;
    delete attempt.usage;
    delete attempt.executionEvidence;
    delete run.output;
    result.completedExecutionEvidence = null;
    (target.checkpoint.execution as { evaluation_state: unknown }).evaluation_state = {
      status: "NOT_EVALUATED",
      reason: "BUDGET_EXCEEDED",
    };
    (target.checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
      sha256CanonicalJson(target.receipt);

    expect(() => build(slots)).toThrow(/metadata|response|무료|provider|원장/i);
  });

  it("provider usage가 있는 BUDGET_EXCEEDED는 유료 응답 기록으로 유지한다", () => {
    const slots = makeAllPassSlots();
    const target = slots.find((item) => item.intent.slot_id === "H-002--A--r1")!;
    const result = target.receipt.execution.slot_result as Record<string, unknown>;
    const run = result.run as Record<string, unknown>;
    const attempts = run.attempts as Array<Record<string, unknown>>;
    result.executionStatus = "BUDGET_EXCEEDED";
    run.status = "BUDGET_EXCEEDED";
    attempts[0].status = "BUDGET_EXCEEDED";
    delete run.output;
    result.completedExecutionEvidence = null;
    (target.checkpoint.execution as { evaluation_state: unknown }).evaluation_state = {
      status: "NOT_EVALUATED",
      reason: "BUDGET_EXCEEDED",
    };
    (target.checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
      sha256CanonicalJson(target.receipt);

    const pack = build(slots);
    const candidateA = pack.candidate_aggregates.find((item) => item.candidate_id === "A")!;
    const recorded = pack.slots.find((item) => item.slot.slot_id === target.intent.slot_id)!;
    const ledger = inspectProviderUsageLedger(
      ((recorded.run as Record<string, unknown>).attempts as Parameters<
        typeof inspectProviderUsageLedger
      >[0]),
    );
    expect(recorded).toMatchObject({
      execution_status: "BUDGET_EXCEEDED",
      request_disposition: "SENT_RESPONSE_RECORDED",
      cost_state: "COMPLETE",
    });
    expect(recorded.usage_cost).not.toBeNull();
    expect(ledger).toMatchObject({ state: "COMPLETE", providerCallCount: 1 });
    expect(candidateA.cost).toMatchObject({ accounted_runs: 24, charged_runs: 24 });
    expect(candidateA.counts.hard_gate_failed_runs).toBe(0);
  });

  it("이전 attempt의 결과가 불명인 BUDGET_EXCEEDED는 비용 불완전 경계를 유지한다", () => {
    const slots = makeAllPassSlots();
    const target = slots.find((item) => item.intent.slot_id === "H-002--A--r1")!;
    const result = target.receipt.execution.slot_result as Record<string, unknown>;
    const run = result.run as Record<string, unknown>;
    const attempts = run.attempts as Array<Record<string, unknown>>;
    const terminalAttempt = attempts[0];
    terminalAttempt.attemptNumber = 2;
    terminalAttempt.status = "BUDGET_EXCEEDED";
    delete terminalAttempt.responseId;
    delete terminalAttempt.modelReportedId;
    delete terminalAttempt.serviceTierReported;
    delete terminalAttempt.usage;
    delete terminalAttempt.executionEvidence;
    attempts.unshift({
      attemptNumber: 1,
      status: "TRANSPORT_ERROR",
      startedAt: "2026-07-17T00:00:00.000Z",
      latencyMs: 3,
      error: "Synthetic request outcome unknown.",
    });
    run.status = "BUDGET_EXCEEDED";
    run.totalLatencyMs = (run.totalLatencyMs as number) + 3;
    delete run.output;
    result.executionStatus = "BUDGET_EXCEEDED";
    result.requestDisposition = "SENT_OUTCOME_UNKNOWN";
    result.costState = "COST_INCOMPLETE";
    result.usageCost = null;
    result.totalLatencyMs = run.totalLatencyMs;
    result.completedExecutionEvidence = null;
    (target.checkpoint.execution as { evaluation_state: unknown }).evaluation_state = {
      status: "NOT_EVALUATED",
      reason: "BUDGET_EXCEEDED",
    };
    (target.checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
      sha256CanonicalJson(target.receipt);

    const pack = build(slots);
    const candidateA = pack.candidate_aggregates.find((item) => item.candidate_id === "A")!;
    const recorded = pack.slots.find((item) => item.slot.slot_id === target.intent.slot_id)!;
    const ledger = inspectProviderUsageLedger(
      ((recorded.run as Record<string, unknown>).attempts as Parameters<
        typeof inspectProviderUsageLedger
      >[0]),
    );
    expect(pack.judge_readiness).toBe("BLOCKED_BY_INTEGRITY");
    expect(recorded).toMatchObject({
      execution_status: "BUDGET_EXCEEDED",
      request_disposition: "SENT_OUTCOME_UNKNOWN",
      cost_state: "COST_INCOMPLETE",
      usage_cost: null,
    });
    expect(ledger).toMatchObject({ state: "COST_INCOMPLETE", providerCallCount: 0 });
    expect(candidateA.cost.total_usd).toBeNull();
    expect(candidateA.counts.hard_gate_failed_runs).toBe(0);
  });

  it.each([
    ["임의 INVALID 무료 주장", "INVALID", "INVALID_OUTPUT"],
    ["provider 응답을 NOT_SENT로 위조", "BUDGET_EXCEEDED", "BUDGET_EXCEEDED"],
  ] as const)("%s은 zero-call null 비용 우회로 허용하지 않는다", (_label, executionStatus, reason) => {
    const slots = makeAllPassSlots();
    const target = slots.find((item) => item.intent.slot_id === "H-002--A--r1")!;
    const result = target.receipt.execution.slot_result as Record<string, unknown>;
    const run = result.run as Record<string, unknown>;
    const attempts = run.attempts as Array<Record<string, unknown>>;
    result.executionStatus = executionStatus;
    result.requestDisposition = "NOT_SENT";
    result.costState = "COMPLETE";
    result.usageCost = null;
    run.status = executionStatus;
    attempts[0].status = reason;
    if (executionStatus === "INVALID") {
      delete attempts[0].responseId;
      delete attempts[0].modelReportedId;
      delete attempts[0].serviceTierReported;
      delete attempts[0].usage;
      delete attempts[0].executionEvidence;
    }
    delete run.output;
    result.completedExecutionEvidence = null;
    (target.checkpoint.execution as { evaluation_state: unknown }).evaluation_state = {
      status: "NOT_EVALUATED",
      reason,
    };
    (target.checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
      sha256CanonicalJson(target.receipt);

    expect(() => build(slots)).toThrow(/비용|disposition|provider|무료|원장/i);
  });

  it("재시도 전송 결과가 불명이어도 뒤 terminal 응답과 비용 불완전 상태를 함께 보존한다", () => {
    const slots = makeAllPassSlots();
    const target = slots.find((item) => item.intent.slot_id === "H-002--A--r1")!;
    const result = target.receipt.execution.slot_result as Record<string, unknown>;
    const run = result.run as Record<string, unknown>;
    const attempts = run.attempts as Array<Record<string, unknown>>;
    attempts[0].attemptNumber = 2;
    attempts.unshift({
      attemptNumber: 1,
      status: "TRANSPORT_ERROR",
      startedAt: "2026-07-17T00:00:00.000Z",
      latencyMs: 3,
      error: "Synthetic connection reset after request transmission.",
    });
    run.totalLatencyMs = (run.totalLatencyMs as number) + 3;
    result.totalLatencyMs = run.totalLatencyMs;
    result.requestDisposition = "SENT_OUTCOME_UNKNOWN";
    result.costState = "COST_INCOMPLETE";
    result.usageCost = null;
    (target.checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
      sha256CanonicalJson(target.receipt);

    const pack = build(slots);
    const candidateA = pack.candidate_aggregates.find((item) => item.candidate_id === "A")!;
    const recorded = pack.slots.find((item) => item.slot.slot_id === target.intent.slot_id)!;
    expect(pack.judge_readiness).toBe("BLOCKED_BY_INTEGRITY");
    expect(recorded.request_disposition).toBe("SENT_OUTCOME_UNKNOWN");
    expect(recorded.execution_status).toBe("COMPLETE");
    expect(candidateA.counts.hard_gate_failed_runs).toBe(0);
    expect(candidateA.cost.total_usd).toBeNull();
  });

  it("run 생성 전 terminal FAILED receipt도 삭제하지 않고 무결성 차단 상태로 보존한다", () => {
    const slots = makeAllPassSlots();
    const target = slots.find((item) => item.intent.slot_id === "H-002--A--r1")!;
    const result = target.receipt.execution.slot_result as Record<string, unknown>;
    result.executionStatus = "FAILED";
    result.requestDisposition = "SENT_OUTCOME_UNKNOWN";
    result.costState = "COST_INCOMPLETE";
    result.usageCost = null;
    result.totalLatencyMs = 0;
    result.run = null;
    result.accessEvidence = null;
    result.completedExecutionEvidence = null;
    (target.checkpoint.execution as { evaluation_state: unknown }).evaluation_state = {
      status: "EVALUATION_INCOMPLETE",
      errorCode: "UNKNOWN_EXECUTION_ERROR",
      message: "Synthetic terminal runner failure.",
    };
    (target.checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
      sha256CanonicalJson(target.receipt);

    const pack = build(slots);
    const candidateA = pack.candidate_aggregates.find((item) => item.candidate_id === "A")!;
    const recorded = pack.slots.find((item) => item.slot.slot_id === target.intent.slot_id)!;
    expect(pack.judge_readiness).toBe("BLOCKED_BY_INTEGRITY");
    expect(recorded).toMatchObject({
      execution_status: "FAILED",
      request_disposition: "SENT_OUTCOME_UNKNOWN",
      run: null,
      access_evidence: null,
    });
    expect(candidateA.counts.failed_runs).toBe(1);
    expect(candidateA.counts.hard_gate_failed_runs).toBe(0);
  });

  it("형식상 유효하지만 receipt 재평가와 다른 checkpoint gate는 부모 팩에서 거부한다", () => {
    const slots = makeAllPassSlots();
    const target = slots.find((item) => item.intent.slot_id === "H-001--A--r1")!;
    const evaluation = target.checkpoint.execution.evaluation_state as {
      status: "EVALUATED";
      gates: Array<Record<string, unknown>>;
    };
    evaluation.gates[0] = {
      gateCode: "P0-HG-01",
      status: "CONFIRMED_FAIL",
      findings: [{
        code: "FORGED_GATE_FINDING",
        message: "Syntactically valid but not derived from receipt evidence.",
        evidenceIds: [`${target.intent.slot_id}:output`],
      }],
      riskCandidates: [],
    };

    expect(() => build(slots)).toThrow(/재실행한 canonical 결과/);
  });

  it("재실행 가능한 receipt에 공통 평가 오류 checkpoint를 붙이면 부모 팩으로 승격하지 않는다", () => {
    const slots = makeAllPassSlots();
    const target = slots.find((item) => item.intent.slot_id === "H-003--B--r2")!;
    (target.checkpoint.execution as { evaluation_state: unknown }).evaluation_state = {
      status: "EVALUATION_INCOMPLETE",
      errorCode: "COMMON_EVALUATOR_ERROR",
      message: "Synthetic evaluator failure.",
    };

    expect(() => build(slots)).toThrow(/재실행|canonical|checkpoint gate/);
  });

  it.each([
    ["누락 slot", (slots: BenchmarkCompletedSlot[]) => slots.slice(1)],
    ["중복 slot", (slots: BenchmarkCompletedSlot[]) => [...slots.slice(0, -1), structuredClone(slots[0])]],
    ["calibration ID", (slots: BenchmarkCompletedSlot[]) => {
      (slots[0].intent as { slot_id: string }).slot_id = "CAL-001--A--r1";
      return slots;
    }],
    ["third repetition", (slots: BenchmarkCompletedSlot[]) => {
      (slots[0].intent as { slot_id: string }).slot_id = "H-001--A--r3";
      return slots;
    }],
    ["identity mismatch", (slots: BenchmarkCompletedSlot[]) => {
      (slots[0].receipt as { slot_identity_hash: string }).slot_identity_hash = "9".repeat(64);
      return slots;
    }],
    ["usage-cost mismatch", (slots: BenchmarkCompletedSlot[]) => {
      const result = slots[0].receipt.execution.slot_result as Record<string, unknown>;
      const cost = result.usageCost as Record<string, unknown>;
      cost.totalCostUsd = 999;
      return slots;
    }],
    ["gate/run contradiction", (slots: BenchmarkCompletedSlot[]) => {
      const result = slots[0].receipt.execution.slot_result as Record<string, unknown>;
      result.executionStatus = "INVALID";
      return slots;
    }],
    ["nonterminal outcome", (slots: BenchmarkCompletedSlot[]) => {
      const result = slots[0].receipt.execution.slot_result as Record<string, unknown>;
      result.executionStatus = "FAILED";
      result.requestDisposition = "SENT_OUTCOME_UNKNOWN";
      result.run = null;
      return slots;
    }],
    ["nested additional key", (slots: BenchmarkCompletedSlot[]) => {
      const result = slots[0].receipt.execution.slot_result as Record<string, unknown>;
      (result.run as Record<string, unknown>).unexpected = true;
      (slots[0].checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
        sha256CanonicalJson(slots[0].receipt);
      return slots;
    }],
    ["malformed provider call sequence", (slots: BenchmarkCompletedSlot[]) => {
      const result = slots[0].receipt.execution.slot_result as Record<string, unknown>;
      const run = result.run as Record<string, unknown>;
      const attempts = run.attempts as Array<Record<string, unknown>>;
      const evidence = attempts[0].executionEvidence as Record<string, unknown>;
      const providerCalls = evidence.providerCalls as Array<Record<string, unknown>>;
      providerCalls[0].callNumber = 2;
      (slots[0].checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
        sha256CanonicalJson(slots[0].receipt);
      return slots;
    }],
    ["forged cost breakdown", (slots: BenchmarkCompletedSlot[]) => {
      const result = slots[0].receipt.execution.slot_result as Record<string, unknown>;
      const cost = result.usageCost as Record<string, unknown>;
      const breakdown = cost.costBreakdownUsd as Record<string, number>;
      breakdown.regularInput += 1;
      cost.totalCostUsd = Object.values(breakdown).reduce((sum, amount) => sum + amount, 0);
      (slots[0].checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
        sha256CanonicalJson(slots[0].receipt);
      return slots;
    }],
    ["forged pricing metadata", (slots: BenchmarkCompletedSlot[]) => {
      const result = slots[0].receipt.execution.slot_result as Record<string, unknown>;
      const cost = result.usageCost as Record<string, unknown>;
      cost.pricingAsOf = "2099-01-01";
      (slots[0].checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
        sha256CanonicalJson(slots[0].receipt);
      return slots;
    }],
    ["shrunk attempt usage against provider ledger", (slots: BenchmarkCompletedSlot[]) => {
      const result = slots[0].receipt.execution.slot_result as Record<string, unknown>;
      const run = result.run as Record<string, unknown>;
      const attempts = run.attempts as Array<Record<string, unknown>>;
      const shrunkUsage = {
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
      };
      attempts[0].usage = shrunkUsage;
      result.usageCost = calculateUsageCost(shrunkUsage, DEFAULT_PRICING_SNAPSHOT);
      (slots[0].checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
        sha256CanonicalJson(slots[0].receipt);
      return slots;
    }],
  ])("%s은 부모 팩 승격 전에 거부한다", (_label, mutate) => {
    expect(() => build(mutate(makeAllPassSlots()))).toThrow();
  });

  it.each([
    "case_hash",
    "oracle_hash",
    "authoritative_order_hash",
    "input_access_hash",
    "candidate_config_hash",
    "system_prompt_hash",
    "invocation_hash",
  ] as const)("self-consistent %s 위조도 잠긴 입력 재계산으로 거부한다", (field) => {
    expect(() => build(forgeSelfConsistentSlotIdentity(makeAllPassSlots(), field))).toThrow();
  });

  it.each(["challenge_hash", "dataset_hash", "oracle_hash", "runner_contract_hash", "pricing_snapshot_hash"] as const)(
    "self-consistent execution %s 위조도 부모 팩 승격 전에 거부한다",
    (field) => {
      const forged = structuredClone(executionIdentity) as unknown as Record<string, unknown>;
      forged[field] = hash(`forged-execution:${field}`);
      const { execution_hash: _oldHash, ...payload } = forged;
      forged.execution_hash = sha256CanonicalJson(payload);
      expect(() => buildBenchmarkExecutionPack({
        executionIdentity: forged as unknown as typeof executionIdentity,
        schedule,
        completedSlots: makeAllPassSlots(),
      })).toThrow();
    },
  );
});

describe("검증된 Recorded Benchmark 부모 팩 불변 저장", () => {
  it("전체 72-slot 검증을 통과한 팩만 canonical 0600 record로 멱등 저장한다", async () => {
    const outputDirectory = await secureTempDirectory("benchmark-parent-pack-");
    const artifact = build();
    const digest = sha256CanonicalJson(artifact);
    const first = await persistBenchmarkExecutionPack({ outputDirectory, pack: artifact });
    const fixedTime = new Date("2020-01-02T03:04:05.000Z");
    await utimes(first.path, fixedTime, fixedTime);
    const before = await lstat(first.path, { bigint: true });
    const second = await persistBenchmarkExecutionPack({ outputDirectory, pack: artifact });
    const paths = createBenchmarkExecutionPackPaths({
      outputDirectory,
      executionHash: artifact.execution_hash,
      payloadSha256: digest,
    });
    const expectedBytes = `${canonicalJsonStringify({
      payload_sha256: digest,
      payload: artifact,
    })}\n`;

    expect(first).toEqual({ path: paths.packPath, created: true, payloadSha256: digest });
    expect(second).toEqual({ path: paths.packPath, created: false, payloadSha256: digest });
    expect(await readFile(paths.packPath, "utf8")).toBe(expectedBytes);
    expect((await lstat(paths.packPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.claimPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.packPath, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
    expect((await readdir(paths.executionDirectory)).filter((name) => name.includes(".tmp-")))
      .toEqual([]);
    expect(Object.isFrozen(artifact.slots[0].run)).toBe(true);
  });

  it("동일한 검증 팩의 동시 저장은 record 생성 승자 하나만 만든다", async () => {
    const outputDirectory = await secureTempDirectory("benchmark-parent-pack-");
    const artifact = build();
    const results = await Promise.all(Array.from({ length: 8 }, () => (
      persistBenchmarkExecutionPack({ outputDirectory, pack: artifact })
    )));
    const paths = createBenchmarkExecutionPackPaths({
      outputDirectory,
      executionHash: artifact.execution_hash,
      payloadSha256: sha256CanonicalJson(artifact),
    });

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.path))).toEqual(new Set([paths.packPath]));
    expect((await readdir(paths.executionDirectory)).sort()).toEqual([
      "benchmark-execution-pack--claim.json",
      `benchmark-execution-pack--record-${sha256CanonicalJson(artifact)}.json`,
    ]);
  });

  it("같은 실행의 서로 다른 검증 팩은 고정 claim 충돌로 두 번째 기록을 거부한다", async () => {
    const outputDirectory = await secureTempDirectory("benchmark-parent-pack-");
    const first = build();
    const slots = makeAllPassSlots();
    const target = slots.find((item) => item.intent.slot_id === "H-001--A--r2")!;
    const result = target.receipt.execution.slot_result as Record<string, unknown>;
    const run = result.run as Record<string, unknown>;
    const output = run.output as Record<string, unknown>;
    output.citations = [];
    const completed = result.completedExecutionEvidence as Record<string, unknown>;
    completed.finalOutputHash = sha256CanonicalJson(output);
    recomputeCheckpoint(target);
    const second = build(slots);
    expect(sha256CanonicalJson(second)).not.toBe(sha256CanonicalJson(first));

    await persistBenchmarkExecutionPack({ outputDirectory, pack: first });
    await expect(persistBenchmarkExecutionPack({
      outputDirectory,
      pack: second,
    })).rejects.toThrow(/기존|bytes|claim|일치/i);
  });

  it.each([
    {
      label: "얕은 top-level 복제",
      mutate: (pack: ReturnType<typeof build>) => ({ ...pack }),
    },
    {
      label: "nested 추가 키",
      mutate: (pack: ReturnType<typeof build>) => {
        const clone = structuredClone(pack) as unknown as Record<string, unknown>;
        const slots = clone.slots as Array<Record<string, unknown>>;
        (slots[0].run as Record<string, unknown>).unexpected = true;
        return clone;
      },
    },
    {
      label: "nested 필수 output 누락",
      mutate: (pack: ReturnType<typeof build>) => {
        const clone = structuredClone(pack) as unknown as Record<string, unknown>;
        const slots = clone.slots as Array<Record<string, unknown>>;
        delete (slots[0].run as Record<string, unknown>).output;
        return clone;
      },
    },
    {
      label: "집계 수치 변조",
      mutate: (pack: ReturnType<typeof build>) => {
        const clone = structuredClone(pack) as unknown as Record<string, unknown>;
        const aggregates = clone.candidate_aggregates as Array<Record<string, unknown>>;
        const counts = aggregates[0].counts as Record<string, unknown>;
        counts.complete_runs = 999;
        return clone;
      },
    },
  ])("$label 객체는 write-once claim을 선점할 수 없다", async ({ mutate }) => {
    const outputDirectory = await secureTempDirectory("benchmark-parent-pack-attack-");
    const unvalidated = mutate(build());

    await expect(persistBenchmarkExecutionPack({
      outputDirectory,
      pack: unvalidated as ReturnType<typeof build>,
    })).rejects.toThrow(/artifact chain|검증/);
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  it("실행 디렉터리 symlink를 따라 외부 위치에 부모 팩을 기록하지 않는다", async () => {
    const outputDirectory = await secureTempDirectory("benchmark-parent-pack-symlink-");
    const externalDirectory = await secureTempDirectory("benchmark-parent-pack-external-");
    const artifact = build();
    const paths = createBenchmarkExecutionPackPaths({
      outputDirectory,
      executionHash: artifact.execution_hash,
      payloadSha256: sha256CanonicalJson(artifact),
    });
    await mkdir(outputDirectory, { recursive: true });
    await symlink(externalDirectory, paths.executionDirectory);

    await expect(persistBenchmarkExecutionPack({
      outputDirectory,
      pack: artifact,
    })).rejects.toThrow(/symlink|directory|디렉터리|안전|write-once/i);
    expect(await readdir(externalDirectory)).toEqual([]);
  });
});

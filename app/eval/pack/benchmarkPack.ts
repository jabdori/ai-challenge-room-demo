import {
  benchmarkSlotIdentityHashes,
  buildBenchmarkSlotIdentity,
  buildBenchmarkSlotExpectedIdentity,
  validateLockedBenchmarkExecutionIdentity,
  type BenchmarkExecutionIdentity,
  type BenchmarkSlotIdentity,
} from "../benchmark/identity";
import { createBenchmarkCandidateDefinition } from "../benchmark/candidateDefinitions";
import {
  buildBenchmarkSchedule,
  type BenchmarkCandidateId,
  type BenchmarkSchedule,
  type BenchmarkScheduleSlot,
} from "../benchmark/schedule";
import { buildRunnerInputAccessEvidence } from "../contracts/runnerInputAccessEvidence";
import type { RunnerInputAccessEvidence } from "../contracts/runnerInputAccessEvidence";
import type { CandidateOutput } from "../contracts/candidateOutput";
import {
  BENCHMARK_CASES,
  BENCHMARK_CHALLENGE,
  BENCHMARK_ORDERS,
  BENCHMARK_ORACLES,
  BENCHMARK_POLICIES,
} from "../data/benchmark";
import type { CandidateAdapter } from "../runner/types";
import {
  calculateUsageCost,
  DEFAULT_PRICING_SNAPSHOT,
  type UsageCost,
} from "../runtime/pricing";
import { inspectProviderUsageLedger } from "../runtime/providerUsageLedger";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import type {
  BenchmarkSlotExecutionCheckpoint,
  BenchmarkSlotExecutionIntent,
  BenchmarkSlotExecutionReceipt,
} from "./benchmarkPersistence";
import { validateBenchmarkSlotArtifactChain } from "./benchmarkPersistence";
import {
  evaluateHardGates,
  type CompletedCandidateExecutionEvidence,
} from "../deterministic/hardGates";

const SHA256 = /^[a-f0-9]{64}$/;
const CANDIDATE_IDS = ["A", "B", "C"] as const;
const GATE_CODES = ["P0-HG-01", "P0-HG-02", "P0-HG-03", "P0-HG-04"] as const;
const validatedBenchmarkExecutionPacks = new WeakSet<object>();

export class BenchmarkPackIntegrityError extends Error {
  readonly code = "BENCHMARK_PACK_INTEGRITY" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string) {
    super(message);
    this.name = "BenchmarkPackIntegrityError";
  }
}

export interface BenchmarkCompletedSlot {
  readonly slot_identity: BenchmarkSlotIdentity;
  readonly intent: BenchmarkSlotExecutionIntent;
  readonly receipt: BenchmarkSlotExecutionReceipt;
  readonly checkpoint: BenchmarkSlotExecutionCheckpoint;
}

export interface RecordedBenchmarkSlot {
  readonly slot: BenchmarkScheduleSlot;
  readonly slot_identity_hash: string;
  readonly intent_payload_sha256: string;
  readonly receipt_payload_sha256: string;
  readonly checkpoint_payload_sha256: string;
  readonly execution_status: string;
  readonly request_disposition: "NOT_SENT" | "SENT_RESPONSE_RECORDED" | "SENT_OUTCOME_UNKNOWN";
  readonly cost_state: "COMPLETE" | "COST_INCOMPLETE";
  readonly evaluation_state: Readonly<Record<string, unknown>>;
  readonly usage_cost: UsageCost | null;
  readonly total_latency_ms: number;
  readonly run: Readonly<Record<string, unknown>> | null;
  readonly access_evidence: unknown;
  readonly completed_execution_evidence: unknown;
}

export interface BenchmarkCandidateAggregate {
  readonly candidate_id: BenchmarkCandidateId;
  readonly counts: {
    readonly scheduled_runs: number;
    readonly complete_runs: number;
    readonly invalid_runs: number;
    readonly timeout_runs: number;
    readonly budget_exceeded_runs: number;
    readonly failed_runs: number;
    readonly evaluated_runs: number;
    readonly not_evaluated_runs: number;
    readonly evaluation_incomplete_runs: number;
    readonly hard_gate_failed_runs: number;
    readonly hard_gate_failed_cases: number;
    readonly policy_applicable_cases: number;
    readonly policy_success_cases: number;
    readonly citation_required_cases: number;
    readonly citation_success_cases: number;
    readonly escalation_required_cases: number;
    readonly escalation_success_cases: number;
  };
  readonly valid_run_sufficiency: boolean;
  readonly hard_gate_sufficiency: boolean;
  readonly cost: {
    readonly accounted_runs: number;
    readonly charged_runs: number;
    readonly total_usd: number | null;
    readonly average_usd_per_ticket: number | null;
  };
  readonly latency: {
    readonly recorded_runs: number;
    readonly median_ms: number;
    readonly worst_ms: number;
  };
  readonly stability: {
    readonly comparable_cases: number;
    readonly stable_cases: number;
    readonly unstable_cases: number;
    readonly not_evaluable_cases: number;
  };
}

export interface BenchmarkExecutionPack {
  readonly schema_version: "benchmark-execution-pack-v1";
  readonly artifact_kind: "BENCHMARK_EXECUTION_PACK";
  readonly source: "RECORDED_BENCHMARK";
  readonly execution_status: "EXECUTION_COMPLETE";
  readonly evaluation_status: "EVALUATION_INCOMPLETE";
  readonly review_status: "NOT_GENERATED";
  readonly baseline_version: null;
  readonly synthetic: true;
  readonly judge_readiness:
    | "READY_FOR_JUDGE"
    | "BLOCKED_BY_INTEGRITY"
    | "INSUFFICIENT_VALID_OUTPUTS";
  readonly execution_hash: string;
  readonly locked_challenge_pack_hash: string;
  readonly locked_challenge_contract_hash: string;
  readonly locked_challenge_source_manifest_hash: string;
  readonly evaluator_contract_hash: string;
  readonly schedule_id: string;
  readonly coverage: {
    readonly cases: 12;
    readonly candidates: 3;
    readonly runs_per_case: 2;
    readonly expected_runs: 72;
    readonly recorded_runs: 72;
  };
  readonly slots: readonly RecordedBenchmarkSlot[];
  readonly candidate_aggregates: readonly BenchmarkCandidateAggregate[];
}

/**
 * 부모 팩 persistence 공개 경계는 이 모듈이 전체 72-slot artifact chain을
 * 재검증해 만든 동일 객체만 받습니다. 구조가 비슷한 외부 객체나 clone은
 * 실행별 write-once claim을 선점할 수 없습니다.
 */
export function assertValidatedBenchmarkExecutionPack(
  value: unknown,
): asserts value is BenchmarkExecutionPack {
  if (
    typeof value !== "object"
    || value === null
    || !validatedBenchmarkExecutionPacks.has(value)
  ) {
    throw new BenchmarkPackIntegrityError(
      "Benchmark 부모 팩은 전체 artifact chain 검증을 통과한 build 결과여야 합니다.",
    );
  }
}

/**
 * v1 팩의 `INSUFFICIENT_VALID_OUTPUTS`는 후보 충분성과 Judge 실행 가능성을
 * 한 필드에 함께 담았습니다. 이미 발급된 write-once 팩을 바꾸지 않으면서,
 * 비용·무결성이 완전한 terminal 실패는 보조 Judge 입력으로 허용합니다.
 */
export function assertAuxiliaryJudgeEligibleBenchmarkExecutionPack(
  value: unknown,
): asserts value is BenchmarkExecutionPack {
  assertValidatedBenchmarkExecutionPack(value);
  if (
    value.judge_readiness === "BLOCKED_BY_INTEGRITY"
    || value.slots.length !== 72
    || value.slots.some((item) => (
      item.cost_state !== "COMPLETE"
      || item.request_disposition === "SENT_OUTCOME_UNKNOWN"
      || item.evaluation_state.status === "EVALUATION_INCOMPLETE"
      || ![
        "COMPLETE",
        "INVALID",
        "TIMEOUT",
        "BUDGET_EXCEEDED",
      ].includes(item.execution_status)
    ))
  ) {
    throw new BenchmarkPackIntegrityError(
      "비용·무결성이 완전한 72개 COMPLETE 또는 terminal 실행만 보조 Judge에 전달할 수 있습니다.",
    );
  }
}

interface BuildPackInput {
  readonly executionIdentity: BenchmarkExecutionIdentity;
  readonly schedule: BenchmarkSchedule;
  readonly completedSlots: readonly BenchmarkCompletedSlot[];
}

type JsonRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new BenchmarkPackIntegrityError(message);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) fail(`${label}는 JSON 객체여야 합니다.`);
  return value;
}

function sha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label}는 64자리 소문자 SHA-256이어야 합니다.`);
  }
}

function finiteNonNegative(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${label}는 0 이상의 유한한 숫자여야 합니다.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function assertLockedSchedule(schedule: BenchmarkSchedule): BenchmarkSchedule {
  const locked = buildBenchmarkSchedule(BENCHMARK_CASES, ["A", "B", "C"]);
  if (
    schedule.schedule_id !== locked.schedule_id
    || schedule.length !== 72
    || !same([...schedule], [...locked])
  ) {
    fail("Benchmark schedule은 잠긴 H-001..H-012 × A/B/C × 반복 1/2의 72개여야 합니다.");
  }
  return locked;
}

function assertExecutionIdentity(identity: BenchmarkExecutionIdentity, schedule: BenchmarkSchedule): void {
  try {
    validateLockedBenchmarkExecutionIdentity(identity, schedule.schedule_id);
  } catch (error) {
    fail("execution identity가 잠긴 데이터·runner·pricing·schedule 계약과 다릅니다.");
  }
}

function assertSlotIdentity(
  identity: BenchmarkSlotIdentity,
  expectedSlot: BenchmarkScheduleSlot,
  executionIdentity: BenchmarkExecutionIdentity,
  rawAccessEvidence: unknown,
  allowMissingAccessEvidence = false,
): Readonly<Record<string, string>> {
  const evaluationCase = BENCHMARK_CASES.find((item) => item.case_id === expectedSlot.case_id);
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === expectedSlot.case_id);
  if (!evaluationCase || !oracle) fail(`잠긴 case/oracle이 없습니다: ${expectedSlot.case_id}`);
  const authoritativeOrder = evaluationCase.order_id === null
    ? null
    : BENCHMARK_ORDERS.find((item) => item.order_id === evaluationCase.order_id) ?? null;
  const expectation = oracle.candidate_access_expectations.find(
    (item) => item.candidate_id === expectedSlot.candidate_id,
  );
  if (!expectation) fail(`잠긴 후보 access expectation이 없습니다: ${expectedSlot.slot_id}`);
  const expectedAccessEvidence = buildRunnerInputAccessEvidence({
    candidateId: expectedSlot.candidate_id,
    slotId: expectedSlot.slot_id,
    repetition: expectedSlot.repetition,
    evaluationCase,
    policies: BENCHMARK_POLICIES,
    authoritativeOrder,
    orderAccessStatus: expectation.expected_order_access_status,
  });
  if (
    !(allowMissingAccessEvidence && rawAccessEvidence === null)
    && !same(rawAccessEvidence, expectedAccessEvidence)
  ) {
    fail(`receipt access evidence가 잠긴 case/oracle/order 계약과 다릅니다: ${expectedSlot.slot_id}`);
  }
  const noCallAdapter: CandidateAdapter = {
    invoke: async () => {
      throw new Error("pack identity validation adapter must not be called");
    },
  };
  const candidateDefinition = createBenchmarkCandidateDefinition({
    candidateId: expectedSlot.candidate_id,
    evaluationCase,
    authorizedOrder: expectation.expected_order_access_status === "SUCCESS"
      ? authoritativeOrder
      : null,
    policyCorpus: BENCHMARK_POLICIES,
    adapter: noCallAdapter,
    challenge: BENCHMARK_CHALLENGE,
  });
  const preparedPolicyResource = expectedSlot.candidate_id === "A"
    ? undefined
    : {
      policy_corpus_sha256: candidateDefinition.config.policy_corpus_hash,
      chunking_config_sha256: candidateDefinition.config.policy_chunking_config_hash!,
      resource_contract_sha256: candidateDefinition.config.policy_resource_contract_hash!,
      manifest_sha256: executionIdentity.policy_manifest_hash,
      resource_identity_sha256: executionIdentity.policy_resource_identity_hash,
      vector_store_id_hash: executionIdentity.policy_vector_store_id_hash,
    };
  const expectedIdentity = buildBenchmarkSlotIdentity({
    executionIdentity,
    slot: expectedSlot,
    evaluationCase,
    oracle,
    authoritativeOrder,
    candidateDefinition,
    accessEvidence: expectedAccessEvidence,
    ...(preparedPolicyResource ? { preparedPolicyResource } : {}),
  });
  if (!same(identity, expectedIdentity)) {
    fail(`slot identity가 잠긴 case/oracle/order/candidate/access에서 재계산한 값과 다릅니다: ${expectedSlot.slot_id}`);
  }
  const { slot_identity_hash: slotIdentityHash, ...payload } = identity;
  sha(slotIdentityHash, "slot_identity_hash");
  if (
    sha256CanonicalJson(payload) !== slotIdentityHash
    || identity.execution_hash !== executionIdentity.execution_hash
    || identity.schedule_id !== executionIdentity.schedule_id
    || identity.slot_id !== expectedSlot.slot_id
    || identity.sequence !== expectedSlot.sequence
    || identity.case_id !== expectedSlot.case_id
    || identity.candidate_id !== expectedSlot.candidate_id
    || identity.repetition !== expectedSlot.repetition
    || identity.candidate_position !== expectedSlot.candidate_position
    || identity.output_schema_hash !== executionIdentity.output_schema_hash
    || identity.pricing_snapshot_hash !== executionIdentity.pricing_snapshot_hash
    || identity.policy_manifest_hash !== executionIdentity.policy_manifest_hash
    || identity.evaluator_policy_manifest_hash !== executionIdentity.evaluator_policy_manifest_hash
    || identity.policy_resource_identity_hash !== executionIdentity.policy_resource_identity_hash
    || identity.policy_vector_store_id_hash !== executionIdentity.policy_vector_store_id_hash
  ) {
    fail(`slot identity가 잠긴 schedule/execution과 다릅니다: ${expectedSlot.slot_id}`);
  }
  return benchmarkSlotIdentityHashes(executionIdentity, identity);
}

function assertArtifactIdentity(
  artifact: BenchmarkSlotExecutionIntent | BenchmarkSlotExecutionReceipt | BenchmarkSlotExecutionCheckpoint,
  expectedSlot: BenchmarkScheduleSlot,
  executionIdentity: BenchmarkExecutionIdentity,
  slotIdentity: BenchmarkSlotIdentity,
  identityHashes: Readonly<Record<string, string>>,
): void {
  if (
    artifact.execution_hash !== executionIdentity.execution_hash
    || artifact.schedule_id !== executionIdentity.schedule_id
    || artifact.slot_identity_hash !== slotIdentity.slot_identity_hash
    || artifact.slot_id !== expectedSlot.slot_id
    || artifact.sequence !== expectedSlot.sequence
    || artifact.repetition !== expectedSlot.repetition
    || !same(artifact.identity_hashes, identityHashes)
  ) {
    fail(`slot artifact identity가 다릅니다: ${expectedSlot.slot_id}`);
  }
}

function assertUsageCost(
  value: unknown,
  run: JsonRecord,
  costState: "COMPLETE" | "COST_INCOMPLETE",
  requestDisposition: RecordedBenchmarkSlot["request_disposition"],
  executionStatus: string,
): UsageCost | null {
  const attempts = Array.isArray(run.attempts) ? run.attempts : fail("run.attempts가 필요합니다.");
  const attemptRecords = attempts.map((attempt, index) => record(attempt, `run.attempts[${index}]`));
  const providerCalls = attemptRecords.flatMap((attempt, attemptIndex) => {
    if (attempt.executionEvidence === undefined) return [];
    const evidence = record(
      attempt.executionEvidence,
      `run.attempts[${attemptIndex}].executionEvidence`,
    );
    return Array.isArray(evidence.providerCalls)
      ? evidence.providerCalls.map((call, callIndex) => record(
        call,
        `run.attempts[${attemptIndex}].executionEvidence.providerCalls[${callIndex}]`,
      ))
      : fail("attempt executionEvidence.providerCalls가 필요합니다.");
  });
  const hasUnknownOutcome = attemptRecords.some((attempt, attemptIndex) => {
    const calls = attempt.executionEvidence === undefined
      ? []
      : (record(
        attempt.executionEvidence,
        `run.attempts[${attemptIndex}].executionEvidence`,
      ).providerCalls as unknown[]);
    return calls.some((rawCall) => {
      const call = record(rawCall, "attempt provider call");
      return call.status === "failed" && call.responseId === null;
    }) || (
      calls.length === 0
      && ["TRANSPORT_ERROR", "REQUEST_ERROR", "TIMEOUT"].includes(attempt.status as string)
    );
  });
  const derivedDisposition: RecordedBenchmarkSlot["request_disposition"] = hasUnknownOutcome
    ? "SENT_OUTCOME_UNKNOWN"
    : providerCalls.length > 0 || attemptRecords.some((attempt) => attempt.usage !== undefined)
      ? "SENT_RESPONSE_RECORDED"
      : "NOT_SENT";
  if (requestDisposition !== derivedDisposition) {
    fail("slot requestDisposition이 terminal run의 provider 전송 증거와 다릅니다.");
  }
  const ledger = inspectProviderUsageLedger(
    attempts as Parameters<typeof inspectProviderUsageLedger>[0],
  );
  if (ledger.state === "INTEGRITY_ERROR") {
    fail(ledger.issue ?? "provider usage 원장 무결성 오류입니다.");
  }
  if (ledger.state !== costState) {
    fail("slot costState가 provider call 비용 원장 상태와 다릅니다.");
  }
  if (costState === "COST_INCOMPLETE") {
    if (value !== null) fail("비용 불완전 slot은 usageCost를 둘 수 없습니다.");
    return null;
  }
  if (ledger.providerCallCount === 0) {
    const terminalAttempt = attemptRecords.at(-1);
    const knownFreeLocalBudget = (
      executionStatus === "BUDGET_EXCEEDED"
      && run.status === "BUDGET_EXCEEDED"
      && requestDisposition === "NOT_SENT"
      && attemptRecords.length === 1
      && terminalAttempt?.status === "BUDGET_EXCEEDED"
      && terminalAttempt.responseId === undefined
      && terminalAttempt.modelReportedId === undefined
      && terminalAttempt.serviceTierReported === undefined
      && terminalAttempt.usage === undefined
      && terminalAttempt.executionEvidence === undefined
    );
    if (!knownFreeLocalBudget || value !== null) {
      fail("provider 호출 0회의 null 비용은 알려진 로컬 BUDGET_EXCEEDED에만 허용됩니다.");
    }
    return null;
  }
  const expectedCost = calculateUsageCost(
    ledger.providerCallUsages,
    DEFAULT_PRICING_SNAPSHOT,
  );
  if (expectedCost === null || !same(value, expectedCost)) {
    fail("usageCost가 provider call 원장과 잠긴 가격표의 재계산 결과와 다릅니다.");
  }
  return structuredClone(expectedCost);
}

function gateFailureCount(evaluation: JsonRecord): number {
  if (evaluation.status !== "EVALUATED") return 0;
  if (!Array.isArray(evaluation.gates) || evaluation.gates.length !== 4) {
    fail("EVALUATED checkpoint에는 gate 4개가 필요합니다.");
  }
  let failures = 0;
  evaluation.gates.forEach((rawGate, index) => {
    const gate = record(rawGate, `gates[${index}]`);
    if (gate.gateCode !== GATE_CODES[index]) fail("gate 코드 또는 순서가 잠긴 계약과 다릅니다.");
    if (!['PASS', 'CONFIRMED_FAIL', 'NOT_APPLICABLE'].includes(gate.status as string)) {
      fail("gate status가 잠긴 enum과 다릅니다.");
    }
    if (gate.status === "CONFIRMED_FAIL") failures += 1;
  });
  return failures;
}

function normalizeCompletedSlot(
  completed: BenchmarkCompletedSlot,
  expectedSlot: BenchmarkScheduleSlot,
  executionIdentity: BenchmarkExecutionIdentity,
): RecordedBenchmarkSlot {
  let snapshot: BenchmarkCompletedSlot;
  try {
    snapshot = JSON.parse(
      canonicalJsonStringify(completed),
    ) as BenchmarkCompletedSlot;
  } catch (error) {
    fail(`slot checkpoint를 canonical snapshot으로 고정할 수 없습니다: ${expectedSlot.slot_id}`);
  }
  const rawSlotResult = record(snapshot.receipt.execution.slot_result, "receipt.slot_result");
  const identityHashes = assertSlotIdentity(
    snapshot.slot_identity,
    expectedSlot,
    executionIdentity,
    rawSlotResult.accessEvidence,
    rawSlotResult.run === null && rawSlotResult.executionStatus === "FAILED",
  );
  assertArtifactIdentity(snapshot.intent, expectedSlot, executionIdentity, snapshot.slot_identity, identityHashes);
  assertArtifactIdentity(snapshot.receipt, expectedSlot, executionIdentity, snapshot.slot_identity, identityHashes);
  assertArtifactIdentity(snapshot.checkpoint, expectedSlot, executionIdentity, snapshot.slot_identity, identityHashes);
  const validated = validateBenchmarkSlotArtifactChain({
    intent: snapshot.intent,
    receipt: snapshot.receipt,
    checkpoint: snapshot.checkpoint,
    expectedIdentity: buildBenchmarkSlotExpectedIdentity(
      executionIdentity,
      snapshot.slot_identity,
    ),
  });
  if (
    snapshot.receipt.intent_payload_sha256 !== sha256CanonicalJson(snapshot.intent)
    || snapshot.checkpoint.intent_payload_sha256 !== sha256CanonicalJson(snapshot.intent)
    || snapshot.checkpoint.receipt_payload_sha256 !== sha256CanonicalJson(snapshot.receipt)
  ) {
    fail(`slot causal hash chain이 끊겼습니다: ${expectedSlot.slot_id}`);
  }

  const result = record(validated.receipt.execution.slot_result, "receipt.slot_result");
  if (!same(result.slot, expectedSlot)) fail("receipt slot 좌표가 schedule과 다릅니다.");
  if (!['NOT_SENT', 'SENT_RESPONSE_RECORDED', 'SENT_OUTCOME_UNKNOWN'].includes(
    result.requestDisposition as string,
  )) fail("slot requestDisposition이 잠긴 enum과 다릅니다.");
  if (result.costState !== "COMPLETE" && result.costState !== "COST_INCOMPLETE") {
    fail("slot costState가 잠긴 enum과 다릅니다.");
  }
  if (result.costState === "COST_INCOMPLETE" && result.usageCost !== null) {
    fail("COST_INCOMPLETE slot에는 완전한 usageCost를 둘 수 없습니다.");
  }
  finiteNonNegative(result.totalLatencyMs, "slot_result.totalLatencyMs");
  const status = result.executionStatus;
  if (!['COMPLETE', 'INVALID', 'TIMEOUT', 'BUDGET_EXCEEDED', 'FAILED'].includes(status as string)) {
    fail("executionStatus가 terminal enum과 다릅니다.");
  }
  const evaluation = record(validated.checkpoint.execution.evaluation_state, "checkpoint.evaluation_state");
  if (!['EVALUATED', 'NOT_EVALUATED', 'EVALUATION_INCOMPLETE'].includes(evaluation.status as string)) {
    fail("checkpoint evaluation status가 잠긴 enum과 다릅니다.");
  }
  if (result.run === null) {
    if (
      status !== "FAILED"
      || evaluation.status !== "EVALUATION_INCOMPLETE"
      || result.totalLatencyMs !== 0
      || result.usageCost !== null
      || result.accessEvidence !== null
      || result.completedExecutionEvidence !== null
    ) {
      fail("run 없는 terminal receipt는 FAILED/EVALUATION_INCOMPLETE/무비용 계약이어야 합니다.");
    }
    return deepFreeze({
      slot: structuredClone(expectedSlot),
      slot_identity_hash: snapshot.slot_identity.slot_identity_hash,
      intent_payload_sha256: sha256CanonicalJson(snapshot.intent),
      receipt_payload_sha256: sha256CanonicalJson(snapshot.receipt),
      checkpoint_payload_sha256: sha256CanonicalJson(snapshot.checkpoint),
      execution_status: status as string,
      request_disposition: result.requestDisposition as RecordedBenchmarkSlot["request_disposition"],
      cost_state: result.costState as "COMPLETE" | "COST_INCOMPLETE",
      evaluation_state: structuredClone(evaluation),
      usage_cost: null,
      total_latency_ms: result.totalLatencyMs,
      run: null,
      access_evidence: null,
      completed_execution_evidence: null,
    });
  }
  const run = record(result.run, "receipt.slot_result.run");
  if (run.runNumber !== expectedSlot.repetition) fail("run repetition이 schedule과 다릅니다.");
  finiteNonNegative(run.totalLatencyMs, "slot_result.run.totalLatencyMs");
  if (result.totalLatencyMs !== run.totalLatencyMs) fail("slot/run latency가 다릅니다.");
  const runStatus = run.status;
  const statusMatches = status === "COMPLETE"
    ? runStatus === "COMPLETE" && run.output !== undefined
    : status === "INVALID"
      ? runStatus === "INVALID" && run.output === undefined
      : status === "TIMEOUT"
        ? runStatus === "TIMEOUT" && run.output === undefined
        : status === "BUDGET_EXCEEDED"
          ? runStatus === "BUDGET_EXCEEDED" && run.output === undefined
          : runStatus === "INVALID" && run.output === undefined;
  if (!statusMatches) fail("executionStatus와 terminal run이 모순됩니다.");

  if (
    (evaluation.status === "EVALUATED" && status !== "COMPLETE")
    || (evaluation.status === "NOT_EVALUATED" && status === "COMPLETE")
  ) {
    fail("checkpoint gate 상태와 terminal run이 모순됩니다.");
  }
  if (status === "COMPLETE") {
    const evaluationCase = BENCHMARK_CASES.find((item) => item.case_id === expectedSlot.case_id)!;
    const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === expectedSlot.case_id)!;
    const authoritativeOrder = evaluationCase.order_id === null
      ? null
      : BENCHMARK_ORDERS.find((item) => item.order_id === evaluationCase.order_id) ?? null;
    let recomputed;
    try {
      const hardGates = evaluateHardGates({
        candidateId: expectedSlot.candidate_id,
        slotId: expectedSlot.slot_id,
        repetition: expectedSlot.repetition,
        evaluationCase,
        oracle,
        policies: BENCHMARK_POLICIES,
        authoritativeOrder,
        accessEvidence: result.accessEvidence as unknown as RunnerInputAccessEvidence,
        output: run.output as CandidateOutput,
        executionEvidence: result.completedExecutionEvidence as unknown as CompletedCandidateExecutionEvidence,
      });
      recomputed = { status: "EVALUATED", gates: hardGates.gates };
    } catch (error) {
      fail(`receipt의 결정적 gate를 부모 팩에서 재실행할 수 없습니다: ${expectedSlot.slot_id}`);
    }
    if (!same(evaluation, recomputed)) {
      fail(`checkpoint gate가 receipt에서 재실행한 canonical 결과와 다릅니다: ${expectedSlot.slot_id}`);
    }
  }
  gateFailureCount(evaluation);
  const usageCost = assertUsageCost(
    result.usageCost,
    run,
    result.costState as "COMPLETE" | "COST_INCOMPLETE",
    result.requestDisposition as RecordedBenchmarkSlot["request_disposition"],
    status as string,
  );

  return deepFreeze({
    slot: structuredClone(expectedSlot),
    slot_identity_hash: snapshot.slot_identity.slot_identity_hash,
    intent_payload_sha256: sha256CanonicalJson(snapshot.intent),
    receipt_payload_sha256: sha256CanonicalJson(snapshot.receipt),
    checkpoint_payload_sha256: sha256CanonicalJson(snapshot.checkpoint),
    execution_status: status as string,
    request_disposition: result.requestDisposition as RecordedBenchmarkSlot["request_disposition"],
    cost_state: result.costState as "COMPLETE" | "COST_INCOMPLETE",
    evaluation_state: structuredClone(evaluation),
    usage_cost: usageCost,
    total_latency_ms: result.totalLatencyMs,
    run: structuredClone(run),
    access_evidence: structuredClone(result.accessEvidence),
    completed_execution_evidence: structuredClone(result.completedExecutionEvidence),
  });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[Math.floor(middle)];
}

function aggregateCandidate(
  candidateId: BenchmarkCandidateId,
  slots: readonly RecordedBenchmarkSlot[],
): BenchmarkCandidateAggregate {
  const candidateSlots = slots.filter((item) => item.slot.candidate_id === candidateId);
  const countStatus = (status: string) => candidateSlots.filter((item) => item.execution_status === status).length;
  const countEvaluation = (status: string) => candidateSlots.filter(
    (item) => item.evaluation_state.status === status,
  ).length;
  const hardGateFailedRuns = candidateSlots.filter((item) => (
    gateFailureCount(item.evaluation_state as JsonRecord) > 0
  )).length;
  const totalCost = candidateSlots.reduce((sum, item) => sum + (item.usage_cost?.totalCostUsd ?? 0), 0);
  const latencies = candidateSlots.map((item) => item.total_latency_ms);

  let stableCases = 0;
  let unstableCases = 0;
  let comparableCases = 0;
  for (const evaluationCase of BENCHMARK_CASES) {
    const pair = candidateSlots.filter((item) => item.slot.case_id === evaluationCase.case_id);
    const decisions = pair.map((item) => {
      if (item.execution_status !== "COMPLETE" || item.run === null) return null;
      const output = record(item.run.output, "run.output");
      return {
        decision: output.decision ?? null,
        citations: output.citations ?? null,
      };
    });
    if (pair.length !== 2 || decisions.some((decision) => decision === null)) continue;
    comparableCases += 1;
    if (same(decisions[0], decisions[1])) stableCases += 1;
    else unstableCases += 1;
  }

  const completeRuns = countStatus("COMPLETE");
  const evaluatedRuns = countEvaluation("EVALUATED");
  const evaluationIncompleteRuns = countEvaluation("EVALUATION_INCOMPLETE");
  const notEvaluatedRuns = countEvaluation("NOT_EVALUATED");
  const failedCaseIds = new Set(
    candidateSlots
      .filter((item) => gateFailureCount(item.evaluation_state as JsonRecord) > 0)
      .map((item) => item.slot.case_id),
  );
  const policyApplicableCases = BENCHMARK_CASES.length;
  const policySuccessCases = BENCHMARK_CASES.filter((evaluationCase) => {
    const pair = candidateSlots.filter((item) => item.slot.case_id === evaluationCase.case_id);
    return pair.length === 2 && pair.every((item) => {
      if (item.evaluation_state.status !== "EVALUATED") return false;
      const gates = item.evaluation_state.gates as JsonRecord[];
      // NOT_APPLICABLE은 성공 분자에 포함하지 않습니다.
      return gates[1]?.status === "PASS";
    });
  }).length;
  const citationRequiredCases = BENCHMARK_ORACLES.filter(
    (oracle) => oracle.required_citations.length > 0,
  );
  const citationSuccessCases = citationRequiredCases.filter((oracle) => {
    const pair = candidateSlots.filter((item) => item.slot.case_id === oracle.case_id);
    return pair.length === 2 && pair.every((item) => {
      if (item.execution_status !== "COMPLETE" || item.run === null) return false;
      const output = record(item.run.output, "run.output");
      const citations = Array.isArray(output.citations) ? output.citations : [];
      return oracle.required_citations.every((required) => citations.some((raw) => {
        const citation = record(raw, "run.output.citations[]");
        return citation.source_id === required.source_id
          && citation.section_id === required.section_id;
      }));
    });
  }).length;
  const escalationRequiredCases = BENCHMARK_ORACLES.filter(
    (oracle) => oracle.escalation_required,
  );
  const escalationSuccessCases = escalationRequiredCases.filter((oracle) => {
    const pair = candidateSlots.filter((item) => item.slot.case_id === oracle.case_id);
    return pair.length === 2 && pair.every((item) => {
      if (item.execution_status !== "COMPLETE" || item.run === null) return false;
      const output = record(item.run.output, "run.output");
      const decision = record(output.decision, "run.output.decision");
      return decision.escalation_required === true
        && decision.escalation_reason_code === oracle.escalation_reason_code
        && decision.target_queue === oracle.target_queue
        && decision.action_code === oracle.expected_action_code;
    });
  }).length;
  const hasIncompleteCost = candidateSlots.some((item) => item.cost_state === "COST_INCOMPLETE");
  return deepFreeze({
    candidate_id: candidateId,
    counts: {
      scheduled_runs: candidateSlots.length,
      complete_runs: completeRuns,
      invalid_runs: countStatus("INVALID"),
      timeout_runs: countStatus("TIMEOUT"),
      budget_exceeded_runs: countStatus("BUDGET_EXCEEDED"),
      failed_runs: countStatus("FAILED"),
      evaluated_runs: evaluatedRuns,
      not_evaluated_runs: notEvaluatedRuns,
      evaluation_incomplete_runs: evaluationIncompleteRuns,
      hard_gate_failed_runs: hardGateFailedRuns,
      hard_gate_failed_cases: failedCaseIds.size,
      policy_applicable_cases: policyApplicableCases,
      policy_success_cases: policySuccessCases,
      citation_required_cases: citationRequiredCases.length,
      citation_success_cases: citationSuccessCases,
      escalation_required_cases: escalationRequiredCases.length,
      escalation_success_cases: escalationSuccessCases,
    },
    valid_run_sufficiency:
      completeRuns === 24 && evaluatedRuns === 24
      && evaluationIncompleteRuns === 0 && notEvaluatedRuns === 0,
    hard_gate_sufficiency:
      evaluatedRuns === 24 && hardGateFailedRuns === 0 && evaluationIncompleteRuns === 0,
    cost: {
      accounted_runs: candidateSlots.filter((item) => item.cost_state === "COMPLETE").length,
      charged_runs: candidateSlots.filter((item) => item.usage_cost !== null).length,
      total_usd: hasIncompleteCost ? null : totalCost,
      average_usd_per_ticket: hasIncompleteCost ? null : totalCost / 24,
    },
    latency: {
      recorded_runs: latencies.length,
      median_ms: median(latencies),
      worst_ms: Math.max(...latencies),
    },
    stability: {
      comparable_cases: comparableCases,
      stable_cases: stableCases,
      unstable_cases: unstableCases,
      not_evaluable_cases: 12 - comparableCases,
    },
  });
}

export function buildBenchmarkExecutionPack({
  executionIdentity,
  schedule,
  completedSlots,
}: BuildPackInput): BenchmarkExecutionPack {
  const lockedSchedule = assertLockedSchedule(schedule);
  assertExecutionIdentity(executionIdentity, lockedSchedule);
  if (completedSlots.length !== 72) fail("부모 팩 승격에는 정확히 72개 checkpoint가 필요합니다.");

  const bySlotId = new Map<string, BenchmarkCompletedSlot>();
  for (const completed of completedSlots) {
    const slotId = completed.intent.slot_id;
    if (!/^H-(?:00[1-9]|01[0-2])--[ABC]--r[12]$/.test(slotId)) {
      fail(`숨겨진 Benchmark가 아닌 slot ID입니다: ${slotId}`);
    }
    if (bySlotId.has(slotId)) fail(`중복 slot입니다: ${slotId}`);
    bySlotId.set(slotId, completed);
  }

  const normalized = lockedSchedule.map((slot) => {
    const completed = bySlotId.get(slot.slot_id);
    if (!completed) fail(`누락 slot입니다: ${slot.slot_id}`);
    return normalizeCompletedSlot(completed, slot, executionIdentity);
  });
  if (bySlotId.size !== lockedSchedule.length) fail("schedule 밖의 추가 slot이 있습니다.");

  const aggregates = CANDIDATE_IDS.map((candidateId) => aggregateCandidate(candidateId, normalized));
  const hasIntegrityBlock = normalized.some((item) => (
    item.cost_state === "COST_INCOMPLETE"
    || item.request_disposition === "SENT_OUTCOME_UNKNOWN"
    || item.evaluation_state.status === "EVALUATION_INCOMPLETE"
  ));
  const judgeReadiness = hasIntegrityBlock
    ? "BLOCKED_BY_INTEGRITY" as const
    : aggregates.some((item) => !item.valid_run_sufficiency)
      ? "INSUFFICIENT_VALID_OUTPUTS" as const
      : "READY_FOR_JUDGE" as const;

  const pack: BenchmarkExecutionPack = deepFreeze({
    schema_version: "benchmark-execution-pack-v1",
    artifact_kind: "BENCHMARK_EXECUTION_PACK",
    source: "RECORDED_BENCHMARK",
    execution_status: "EXECUTION_COMPLETE",
    evaluation_status: "EVALUATION_INCOMPLETE",
    review_status: "NOT_GENERATED",
    baseline_version: null,
    synthetic: true,
    judge_readiness: judgeReadiness,
    execution_hash: executionIdentity.execution_hash,
    locked_challenge_pack_hash: executionIdentity.locked_challenge_pack_hash,
    locked_challenge_contract_hash: executionIdentity.locked_challenge_contract_hash,
    locked_challenge_source_manifest_hash:
      executionIdentity.locked_challenge_source_manifest_hash,
    evaluator_contract_hash: executionIdentity.evaluator_contract_hash,
    schedule_id: lockedSchedule.schedule_id,
    coverage: {
      cases: 12,
      candidates: 3,
      runs_per_case: 2,
      expected_runs: 72,
      recorded_runs: 72,
    },
    slots: normalized,
    candidate_aggregates: aggregates,
  });
  validatedBenchmarkExecutionPacks.add(pack);
  return pack;
}

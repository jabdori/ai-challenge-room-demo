import {
  benchmarkSlotIdentityHashes,
  buildBenchmarkSlotExpectedIdentity,
  buildBenchmarkSlotIdentity,
  validateLockedBenchmarkExecutionIdentity,
  type BenchmarkExecutionIdentity,
  type BenchmarkSlotIdentity,
} from "./identity";
import {
  buildBenchmarkSchedule,
  type BenchmarkSchedule,
  type BenchmarkScheduleSlot,
} from "./schedule";
import {
  evaluateBenchmarkSlotReceipt,
  executeBenchmarkCandidateSlot,
  type BenchmarkSlotCandidateExecutionResult,
  type ExecuteBenchmarkSlotOptions,
  type SlotEvaluationState,
} from "./executeSlot";
import { createBenchmarkCandidateDefinition } from "./candidateDefinitions";
import { buildRunnerInputAccessEvidence } from "../contracts/runnerInputAccessEvidence";
import {
  BENCHMARK_CASES,
  BENCHMARK_CHALLENGE,
  BENCHMARK_ORDERS,
  BENCHMARK_ORACLES,
  BENCHMARK_POLICIES,
} from "../data/benchmark";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import { DEFAULT_PRICING_SNAPSHOT } from "../runtime/pricing";
import {
  throwIfAborted,
  type CandidateAdapter,
} from "../runner/types";
import {
  buildBenchmarkExecutionPack,
  type BenchmarkCompletedSlot,
  type BenchmarkExecutionPack,
} from "../pack/benchmarkPack";
import { persistBenchmarkExecutionPack } from "../pack/benchmarkPackPersistence";
import {
  claimBenchmarkSlotExecutionIntent,
  loadBenchmarkSlotResumeState,
  persistBenchmarkSlotArtifact,
  validateBenchmarkSlotArtifactChain,
  type BenchmarkIntentClaim,
  type BenchmarkSlotArtifact,
  type BenchmarkSlotExecutionCheckpoint,
  type BenchmarkSlotExecutionIntent,
  type BenchmarkSlotExecutionReceipt,
  type BenchmarkSlotResumeState,
} from "../pack/benchmarkPersistence";

const EXPECTED_RUNS = 72 as const;
const verifiedBenchmarkProgressEvents = new WeakSet<object>();

export class BenchmarkOrchestrationIntegrityError extends Error {
  readonly code = "BENCHMARK_ORCHESTRATION_INTEGRITY" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BenchmarkOrchestrationIntegrityError";
  }
}

export class BenchmarkAmbiguousInFlightError extends Error {
  readonly code = "BENCHMARK_AMBIGUOUS_IN_FLIGHT" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;
  readonly allowRemoteCall = false as const;

  constructor(readonly slotId: string) {
    super(`원격 실행 결과가 불명확한 intent-only slot은 자동 재호출할 수 없습니다: ${slotId}`);
    this.name = "BenchmarkAmbiguousInFlightError";
  }
}

export interface BenchmarkExecutionSlotPlan {
  readonly slot_identity: BenchmarkSlotIdentity;
  readonly execution_options: Omit<ExecuteBenchmarkSlotOptions, "signal">;
}

export interface BenchmarkProgressEvent {
  readonly completed_checkpoints: number;
  readonly total_checkpoints: 72;
  readonly slot: BenchmarkScheduleSlot;
  readonly source: "EXECUTED" | "RECOMPUTED_GATES" | "REUSED_CHECKPOINT";
  readonly checkpoint_payload_sha256: string;
  /**
   * source-reload와 결정적 gate 검증을 모두 통과한 checkpoint에서만 만든
   * 공개 안전 terminal 요약입니다. 후보 출력·oracle·원격 자원 ID는 넣지 않습니다.
   */
  readonly terminal_slot_summary: BenchmarkTerminalSlotSummary;
}

export interface BenchmarkTerminalSlotSummary {
  readonly execution_status:
    | "COMPLETE"
    | "INVALID"
    | "TIMEOUT"
    | "BUDGET_EXCEEDED"
    | "FAILED";
  readonly evaluation_status:
    | "EVALUATED"
    | "NOT_EVALUATED"
    | "EVALUATION_INCOMPLETE";
  readonly hard_gate_status:
    | "PASS"
    | "CONFIRMED_FAIL"
    | "NOT_EVALUATED"
    | "EVALUATION_INCOMPLETE";
  readonly cost_state: "COMPLETE" | "COST_INCOMPLETE";
  readonly cost_usd: number | null;
  readonly latency_ms: number;
}

/**
 * persistence·server 단계가 임의 progress 객체를 실제 checkpoint로 오인하지
 * 않도록, 이 실행기가 source-reload chain 검증 후 만든 동일 객체만 허용합니다.
 */
export function assertVerifiedBenchmarkProgressEvent(
  value: unknown,
): asserts value is BenchmarkProgressEvent {
  if (
    typeof value !== "object"
    || value === null
    || !verifiedBenchmarkProgressEvents.has(value)
    || !Object.isFrozen(value)
  ) {
    throw new TypeError(
      "Benchmark progress는 source-verified checkpoint authority여야 합니다.",
    );
  }
}

interface LoadResumeInput {
  readonly outputDirectory: string;
  readonly executionHash: string;
  readonly slot: Pick<BenchmarkScheduleSlot, "slot_id" | "sequence" | "repetition">;
  readonly expectedIdentity: ReturnType<typeof buildBenchmarkSlotExpectedIdentity>;
}

interface ClaimIntentInput {
  readonly outputDirectory: string;
  readonly artifact: BenchmarkSlotExecutionIntent;
}

interface PersistArtifactInput {
  readonly outputDirectory: string;
  readonly artifact: BenchmarkSlotArtifact;
}

export interface BenchmarkOrchestrationDependencies {
  readonly loadResumeState: (input: LoadResumeInput) => Promise<BenchmarkSlotResumeState>;
  readonly claimIntent: (input: ClaimIntentInput) => Promise<BenchmarkIntentClaim>;
  readonly persistArtifact: (input: PersistArtifactInput) => Promise<string>;
  readonly executeCandidateSlot: typeof executeBenchmarkCandidateSlot;
  readonly evaluateReceipt: typeof evaluateBenchmarkSlotReceipt;
  readonly buildPack: typeof buildBenchmarkExecutionPack;
  readonly persistPack: typeof persistBenchmarkExecutionPack;
}

export interface ExecuteBenchmarkOptions {
  readonly outputDirectory: string;
  readonly executionIdentity: BenchmarkExecutionIdentity;
  readonly schedule: BenchmarkSchedule;
  readonly plans: readonly BenchmarkExecutionSlotPlan[];
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: BenchmarkProgressEvent) => void | Promise<void>;
  /** 테스트에서 원격 호출 없이 상태 경계를 검증하기 위한 주입 지점입니다. */
  readonly dependencies?: Partial<BenchmarkOrchestrationDependencies>;
}

const defaultDependencies: BenchmarkOrchestrationDependencies = {
  loadResumeState: loadBenchmarkSlotResumeState,
  claimIntent: claimBenchmarkSlotExecutionIntent,
  persistArtifact: persistBenchmarkSlotArtifact,
  executeCandidateSlot: executeBenchmarkCandidateSlot,
  evaluateReceipt: evaluateBenchmarkSlotReceipt,
  buildPack: buildBenchmarkExecutionPack,
  persistPack: persistBenchmarkExecutionPack,
};

function fail(message: string, cause?: unknown): never {
  throw new BenchmarkOrchestrationIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function validateLockedSchedule(schedule: BenchmarkSchedule): BenchmarkSchedule {
  const locked = buildBenchmarkSchedule(BENCHMARK_CASES, ["A", "B", "C"]);
  if (
    schedule.schedule_id !== locked.schedule_id
    || schedule.length !== EXPECTED_RUNS
    || !same([...schedule], [...locked])
  ) {
    fail("원격 실행 전에 잠긴 H-001..H-012 × A/B/C × 반복 1/2 schedule을 검증해야 합니다.");
  }
  return locked;
}

function expectedLockedPlan(
  executionIdentity: BenchmarkExecutionIdentity,
  slot: BenchmarkScheduleSlot,
  options: Omit<ExecuteBenchmarkSlotOptions, "signal">,
): BenchmarkExecutionSlotPlan {
  const actualSlot = options.slot;
  const actualEvaluationCase = options.evaluationCase;
  const actualOracle = options.oracle;
  const actualPolicies = options.policies;
  const actualAuthoritativeOrder = options.authoritativeOrder;
  const actualPricing = options.pricing;
  const actualNow = options.now;
  const actualDefinition = options.candidateDefinition;
  const actualAdapter = actualDefinition.adapter;
  const invoke = actualAdapter?.invoke;
  if (
    typeof actualAdapter !== "object"
    || actualAdapter === null
    || typeof invoke !== "function"
    || (actualNow !== undefined && typeof actualNow !== "function")
  ) {
    fail(`실행 계획의 adapter 또는 clock 계약이 다릅니다: ${slot.slot_id}`);
  }
  const stableAdapter: CandidateAdapter = Object.freeze({
    invoke(
      invocation: Parameters<CandidateAdapter["invoke"]>[0],
      context?: Parameters<CandidateAdapter["invoke"]>[1],
    ) {
      return invoke.call(actualAdapter, invocation, context);
    },
  });
  const evaluationCase = BENCHMARK_CASES.find((item) => item.case_id === slot.case_id);
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === slot.case_id);
  if (!evaluationCase || !oracle) fail(`잠긴 case 또는 oracle이 없습니다: ${slot.slot_id}`);
  const authoritativeOrder = evaluationCase.order_id === null
    ? null
    : BENCHMARK_ORDERS.find((item) => item.order_id === evaluationCase.order_id) ?? null;
  if (
    !same(actualSlot, slot)
    || !same(actualEvaluationCase, evaluationCase)
    || !same(actualOracle, oracle)
    || !same(actualPolicies, BENCHMARK_POLICIES)
    || !same(actualAuthoritativeOrder, authoritativeOrder)
    || (actualPricing !== undefined && !same(actualPricing, DEFAULT_PRICING_SNAPSHOT))
  ) {
    fail(`실행 계획이 잠긴 case/oracle/policy/order/pricing과 다릅니다: ${slot.slot_id}`);
  }
  const expectation = oracle.candidate_access_expectations.find(
    (item) => item.candidate_id === slot.candidate_id,
  );
  if (!expectation) fail(`잠긴 후보 접근 계약이 없습니다: ${slot.slot_id}`);
  const accessEvidence = buildRunnerInputAccessEvidence({
    candidateId: slot.candidate_id,
    slotId: slot.slot_id,
    repetition: slot.repetition,
    evaluationCase,
    policies: BENCHMARK_POLICIES,
    authoritativeOrder,
    orderAccessStatus: expectation.expected_order_access_status,
  });
  const expectedDefinition = createBenchmarkCandidateDefinition({
    candidateId: slot.candidate_id,
    evaluationCase,
    authorizedOrder: expectation.expected_order_access_status === "SUCCESS"
      ? authoritativeOrder
      : null,
    policyCorpus: BENCHMARK_POLICIES,
    adapter: stableAdapter,
    challenge: BENCHMARK_CHALLENGE,
  });
  const { adapter: _actualAdapter, ...actualDefinitionData } = actualDefinition;
  const { adapter: _expectedAdapter, ...lockedDefinition } = expectedDefinition;
  if (!same(actualDefinitionData, lockedDefinition)) {
    fail(`후보 정의가 잠긴 A/B/C 계약과 다릅니다: ${slot.slot_id}`);
  }
  const preparedPolicyResource = slot.candidate_id === "A"
    ? undefined
    : {
      policy_corpus_sha256: expectedDefinition.config.policy_corpus_hash,
      chunking_config_sha256: expectedDefinition.config.policy_chunking_config_hash!,
      resource_contract_sha256: expectedDefinition.config.policy_resource_contract_hash!,
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
    candidateDefinition: expectedDefinition,
    accessEvidence,
    ...(preparedPolicyResource ? { preparedPolicyResource } : {}),
  });
  return Object.freeze({
    slot_identity: slotIdentity,
    execution_options: Object.freeze({
      slot,
      candidateDefinition: expectedDefinition,
      evaluationCase,
      oracle,
      policies: BENCHMARK_POLICIES,
      authoritativeOrder,
      ...(actualPricing === undefined ? {} : {
        pricing: DEFAULT_PRICING_SNAPSHOT,
      }),
      ...(actualNow === undefined ? {} : { now: actualNow }),
    }),
  });
}

function validatePlans(
  executionIdentity: BenchmarkExecutionIdentity,
  schedule: BenchmarkSchedule,
  plans: readonly BenchmarkExecutionSlotPlan[],
): readonly BenchmarkExecutionSlotPlan[] {
  const lockedSchedule = validateLockedSchedule(schedule);
  try {
    validateLockedBenchmarkExecutionIdentity(executionIdentity, lockedSchedule.schedule_id);
  } catch (error) {
    fail("원격 실행 전 Benchmark execution identity 검증에 실패했습니다.", error);
  }
  if (plans.length !== EXPECTED_RUNS) fail("Benchmark 실행 계획에는 정확히 72개 slot이 필요합니다.");
  const bySlot = new Map<string, BenchmarkExecutionSlotPlan>();
  for (const plan of plans) {
    const slotId = plan.slot_identity.slot_id;
    if (bySlot.has(slotId)) fail(`중복 실행 계획 slot입니다: ${slotId}`);
    bySlot.set(slotId, plan);
  }
  return Object.freeze(lockedSchedule.map((slot) => {
    const plan = bySlot.get(slot.slot_id);
    if (!plan) fail(`실행 계획 slot이 누락됐습니다: ${slot.slot_id}`);
    const expected = expectedLockedPlan(executionIdentity, slot, plan.execution_options);
    if (!same(plan.slot_identity, expected.slot_identity)) {
      fail(`실행 계획 slot identity가 잠긴 입력에서 재계산한 값과 다릅니다: ${slot.slot_id}`);
    }
    return expected;
  }));
}

function artifactBase(
  executionIdentity: BenchmarkExecutionIdentity,
  slotIdentity: BenchmarkSlotIdentity,
) {
  return {
    execution_hash: executionIdentity.execution_hash,
    schedule_id: executionIdentity.schedule_id,
    slot_identity_hash: slotIdentity.slot_identity_hash,
    slot_id: slotIdentity.slot_id,
    sequence: slotIdentity.sequence,
    repetition: slotIdentity.repetition,
    identity_hashes: benchmarkSlotIdentityHashes(executionIdentity, slotIdentity),
  } as const;
}

function buildIntent(
  executionIdentity: BenchmarkExecutionIdentity,
  slotIdentity: BenchmarkSlotIdentity,
): BenchmarkSlotExecutionIntent {
  return Object.freeze({
    artifact_kind: "BENCHMARK_SLOT_EXECUTION_INTENT",
    ...artifactBase(executionIdentity, slotIdentity),
    execution: Object.freeze({
      schema_version: "benchmark-slot-intent-v1",
      candidate_id: slotIdentity.candidate_id,
      run_number: slotIdentity.repetition,
      invocation_hash: slotIdentity.invocation_hash,
    }),
  });
}

function receiptSafeResult(
  result: BenchmarkSlotCandidateExecutionResult,
): Omit<BenchmarkSlotCandidateExecutionResult, "executionIntegrityError"> {
  const { executionIntegrityError: _internalError, ...safe } = result;
  return structuredClone(safe);
}

function buildReceipt(
  executionIdentity: BenchmarkExecutionIdentity,
  slotIdentity: BenchmarkSlotIdentity,
  intent: BenchmarkSlotExecutionIntent,
  result: BenchmarkSlotCandidateExecutionResult,
): BenchmarkSlotExecutionReceipt {
  return Object.freeze({
    artifact_kind: "BENCHMARK_SLOT_EXECUTION_RECEIPT",
    ...artifactBase(executionIdentity, slotIdentity),
    intent_payload_sha256: sha256CanonicalJson(intent),
    execution: Object.freeze({
      schema_version: "benchmark-slot-receipt-v1",
      slot_result: receiptSafeResult(result),
    }),
  });
}

function buildCheckpoint(
  executionIdentity: BenchmarkExecutionIdentity,
  slotIdentity: BenchmarkSlotIdentity,
  intent: BenchmarkSlotExecutionIntent,
  receipt: BenchmarkSlotExecutionReceipt,
  evaluationState: SlotEvaluationState,
): BenchmarkSlotExecutionCheckpoint {
  return Object.freeze({
    artifact_kind: "BENCHMARK_SLOT_EXECUTION_CHECKPOINT",
    ...artifactBase(executionIdentity, slotIdentity),
    intent_payload_sha256: sha256CanonicalJson(intent),
    receipt_payload_sha256: sha256CanonicalJson(receipt),
    execution: Object.freeze({
      schema_version: "benchmark-slot-checkpoint-v1",
      evaluation_state: structuredClone(evaluationState),
    }),
  });
}

function candidateExecutionFromReceipt(
  receipt: BenchmarkSlotExecutionReceipt,
): BenchmarkSlotCandidateExecutionResult {
  return {
    ...(structuredClone(receipt.execution.slot_result) as unknown as Omit<
      BenchmarkSlotCandidateExecutionResult,
      "executionIntegrityError"
    >),
    executionIntegrityError: null,
  };
}

function terminalSlotSummary(
  receipt: BenchmarkSlotExecutionReceipt,
  checkpoint: BenchmarkSlotExecutionCheckpoint,
): BenchmarkTerminalSlotSummary {
  const candidateExecution = candidateExecutionFromReceipt(receipt);
  if (
    candidateExecution.costState === "COMPLETE"
    && candidateExecution.usageCost === null
  ) {
    fail(
      "비용 완료(COMPLETE) checkpoint에는 실행기 검증 비용(usageCost)이 필요합니다.",
    );
  }
  const evaluationState =
    checkpoint.execution.evaluation_state as SlotEvaluationState;
  const hardGateStatus = evaluationState.status === "EVALUATED"
    ? (
      evaluationState.gates.some((gate) => gate.status === "CONFIRMED_FAIL")
        ? "CONFIRMED_FAIL"
        : "PASS"
    )
    : evaluationState.status === "NOT_EVALUATED"
      ? "NOT_EVALUATED"
      : "EVALUATION_INCOMPLETE";
  return Object.freeze({
    execution_status: candidateExecution.executionStatus,
    evaluation_status: evaluationState.status,
    hard_gate_status: hardGateStatus,
    cost_state: candidateExecution.costState,
    cost_usd: candidateExecution.costState === "COMPLETE"
      ? candidateExecution.usageCost!.totalCostUsd
      : null,
    latency_ms: candidateExecution.totalLatencyMs,
  });
}

async function reloadCheckpoint(
  dependencies: BenchmarkOrchestrationDependencies,
  outputDirectory: string,
  executionIdentity: BenchmarkExecutionIdentity,
  slotIdentity: BenchmarkSlotIdentity,
): Promise<Extract<BenchmarkSlotResumeState, { state: "CHECKPOINT" }>> {
  const state = await dependencies.loadResumeState({
    outputDirectory,
    executionHash: executionIdentity.execution_hash,
    slot: slotIdentity,
    expectedIdentity: buildBenchmarkSlotExpectedIdentity(executionIdentity, slotIdentity),
  });
  if (state.state !== "CHECKPOINT") {
    fail(`checkpoint 저장 후 엄격한 재로딩에 실패했습니다: ${slotIdentity.slot_id}`);
  }
  validateBenchmarkSlotArtifactChain({
    intent: state.intent,
    receipt: state.receipt,
    checkpoint: state.checkpoint,
    expectedIdentity: buildBenchmarkSlotExpectedIdentity(executionIdentity, slotIdentity),
  });
  return state;
}

async function finishReceiptOnly(
  dependencies: BenchmarkOrchestrationDependencies,
  outputDirectory: string,
  executionIdentity: BenchmarkExecutionIdentity,
  plan: BenchmarkExecutionSlotPlan,
  state: Extract<BenchmarkSlotResumeState, { state: "RECEIPT_ONLY" }>,
  signal?: AbortSignal,
): Promise<Extract<BenchmarkSlotResumeState, { state: "CHECKPOINT" }>> {
  throwIfAborted(signal);
  const evaluationState = dependencies.evaluateReceipt({
    ...plan.execution_options,
    ...(signal ? { signal } : {}),
    candidateExecution: candidateExecutionFromReceipt(state.receipt),
  });
  const checkpoint = buildCheckpoint(
    executionIdentity,
    plan.slot_identity,
    state.intent,
    state.receipt,
    evaluationState,
  );
  await dependencies.persistArtifact({ outputDirectory, artifact: checkpoint });
  return reloadCheckpoint(
    dependencies,
    outputDirectory,
    executionIdentity,
    plan.slot_identity,
  );
}

async function resolveSlot(
  dependencies: BenchmarkOrchestrationDependencies,
  outputDirectory: string,
  executionIdentity: BenchmarkExecutionIdentity,
  plan: BenchmarkExecutionSlotPlan,
  signal?: AbortSignal,
): Promise<{
  readonly state: Extract<BenchmarkSlotResumeState, { state: "CHECKPOINT" }>;
  readonly source: BenchmarkProgressEvent["source"];
}> {
  const expectedIdentity = buildBenchmarkSlotExpectedIdentity(executionIdentity, plan.slot_identity);
  const load = () => dependencies.loadResumeState({
    outputDirectory,
    executionHash: executionIdentity.execution_hash,
    slot: plan.slot_identity,
    expectedIdentity,
  });
  let state = await load();
  if (state.state === "CHECKPOINT") return { state, source: "REUSED_CHECKPOINT" };
  if (state.state === "INTENT_ONLY") throw new BenchmarkAmbiguousInFlightError(state.intent.slot_id);
  if (state.state === "RECEIPT_ONLY") {
    return {
      state: await finishReceiptOnly(
        dependencies,
        outputDirectory,
        executionIdentity,
        plan,
        state,
        signal,
      ),
      source: "RECOMPUTED_GATES",
    };
  }

  throwIfAborted(signal);
  const intent = buildIntent(executionIdentity, plan.slot_identity);
  const claim = await dependencies.claimIntent({ outputDirectory, artifact: intent });
  if (!claim.allowRemoteCall) {
    state = await load();
    if (state.state === "CHECKPOINT") return { state, source: "REUSED_CHECKPOINT" };
    if (state.state === "RECEIPT_ONLY") {
      return {
        state: await finishReceiptOnly(
          dependencies,
          outputDirectory,
          executionIdentity,
          plan,
          state,
          signal,
        ),
        source: "RECOMPUTED_GATES",
      };
    }
    if (state.state === "INTENT_ONLY") throw new BenchmarkAmbiguousInFlightError(state.intent.slot_id);
    fail(`intent claim 소유권이 없지만 저장 상태도 없습니다: ${plan.slot_identity.slot_id}`);
  }

  const candidateExecution = await dependencies.executeCandidateSlot({
    ...plan.execution_options,
    ...(signal ? { signal } : {}),
  });
  // 원격 실행이 반환된 뒤에는 취소 신호보다 영수증을 먼저 write-once 저장합니다.
  const receipt = buildReceipt(
    executionIdentity,
    plan.slot_identity,
    intent,
    candidateExecution,
  );
  await dependencies.persistArtifact({ outputDirectory, artifact: receipt });
  throwIfAborted(signal);
  const evaluationState = dependencies.evaluateReceipt({
    ...plan.execution_options,
    ...(signal ? { signal } : {}),
    candidateExecution,
  });
  const checkpoint = buildCheckpoint(
    executionIdentity,
    plan.slot_identity,
    intent,
    receipt,
    evaluationState,
  );
  await dependencies.persistArtifact({ outputDirectory, artifact: checkpoint });
  return {
    state: await reloadCheckpoint(
      dependencies,
      outputDirectory,
      executionIdentity,
      plan.slot_identity,
    ),
    source: "EXECUTED",
  };
}

/**
 * 72개 숨겨진 Benchmark slot을 기본적으로 순차 실행합니다.
 * 부모 팩은 모든 checkpoint를 저장 후 다시 검증한 경우에만 메모리에서 생성합니다.
 */
export async function executeBenchmark({
  outputDirectory,
  executionIdentity,
  schedule,
  plans,
  signal,
  onProgress,
  dependencies: overrides,
}: ExecuteBenchmarkOptions): Promise<BenchmarkExecutionPack> {
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) {
    fail("Benchmark outputDirectory가 비어 있습니다.");
  }
  const dependencies: BenchmarkOrchestrationDependencies = {
    ...defaultDependencies,
    ...overrides,
  };
  const lockedSchedule = validateLockedSchedule(schedule);
  const orderedPlans = validatePlans(executionIdentity, lockedSchedule, plans);
  const completed: BenchmarkCompletedSlot[] = [];

  for (const plan of orderedPlans) {
    throwIfAborted(signal);
    const resolved = await resolveSlot(
      dependencies,
      outputDirectory,
      executionIdentity,
      plan,
      signal,
    );
    const validated = validateBenchmarkSlotArtifactChain({
      intent: resolved.state.intent,
      receipt: resolved.state.receipt,
      checkpoint: resolved.state.checkpoint,
      expectedIdentity: buildBenchmarkSlotExpectedIdentity(executionIdentity, plan.slot_identity),
    });
    completed.push(Object.freeze({
      slot_identity: plan.slot_identity,
      intent: validated.intent,
      receipt: validated.receipt,
      checkpoint: validated.checkpoint,
    }));
    if (onProgress) {
      const progressEvent = Object.freeze({
        completed_checkpoints: completed.length,
        total_checkpoints: EXPECTED_RUNS,
        slot: structuredClone(plan.execution_options.slot),
        source: resolved.source,
        checkpoint_payload_sha256: sha256CanonicalJson(validated.checkpoint),
        terminal_slot_summary: terminalSlotSummary(
          validated.receipt,
          validated.checkpoint,
        ),
      });
      verifiedBenchmarkProgressEvents.add(progressEvent);
      await onProgress(progressEvent);
    }
  }

  throwIfAborted(signal);
  if (completed.length !== EXPECTED_RUNS) {
    fail("72개 checkpoint를 검증하기 전에는 부모 Benchmark 팩을 만들 수 없습니다.");
  }
  const pack = dependencies.buildPack({
    executionIdentity,
    schedule: lockedSchedule,
    completedSlots: completed,
  });
  await dependencies.persistPack({ outputDirectory, pack });
  return pack;
}

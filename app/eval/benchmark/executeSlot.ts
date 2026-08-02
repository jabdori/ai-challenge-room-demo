import type { CandidateExecutionEvidence, ToolCallEvidence } from "../contracts/executionEvidence";
import {
  buildRunnerInputAccessEvidence,
  type RunnerInputAccessEvidence,
} from "../contracts/runnerInputAccessEvidence";
import type {
  EvaluationCase,
  EvaluationOracle,
  EvaluationOrder,
  PolicySection,
} from "../contracts/evaluationCase";
import {
  EvaluationIntegrityError,
  evaluateHardGates,
  type BenchmarkCandidateExecutionEvidence,
  type BenchmarkToolCallEvidence,
  type CompletedCandidateExecutionEvidence,
  type HardGateEvaluationResult,
} from "../deterministic/hardGates";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import {
  calculateUsageCost,
  DEFAULT_PRICING_SNAPSHOT,
  type PricingSnapshot,
  type UsageCost,
} from "../runtime/pricing";
import { inspectProviderUsageLedger } from "../runtime/providerUsageLedger";
import { runCandidateOnce, RunnerEvidenceIntegrityError } from "../runner/runCandidate";
import {
  throwIfAborted,
  type CandidateAttemptRecord,
  type CandidateRunRecord,
} from "../runner/types";
import type { BenchmarkCandidateDefinition } from "./candidateDefinitions";
import type { BenchmarkScheduleSlot } from "./schedule";

export type SlotExecutionStatus =
  | "COMPLETE"
  | "INVALID"
  | "TIMEOUT"
  | "BUDGET_EXCEEDED"
  | "FAILED";

export type SlotNotEvaluatedReason =
  | "INVALID_OUTPUT"
  | "INCOMPLETE_RESPONSE"
  | "CANDIDATE_REFUSED"
  | "CANDIDATE_FAILED"
  | "TIMEOUT"
  | "BUDGET_EXCEEDED";

export type SlotEvaluationState =
  | {
    status: "EVALUATED";
    gates: HardGateEvaluationResult["gates"];
  }
  | {
    status: "NOT_EVALUATED";
    reason: SlotNotEvaluatedReason;
  }
  | {
    status: "EVALUATION_INCOMPLETE";
    errorCode: string;
    message: string;
  };

export type RequestDisposition =
  | "NOT_SENT"
  | "SENT_RESPONSE_RECORDED"
  | "SENT_OUTCOME_UNKNOWN";

export type SlotCostState = "COMPLETE" | "COST_INCOMPLETE";

export interface BenchmarkCandidateAttemptRecord
  extends Omit<CandidateAttemptRecord, "executionEvidence"> {
  executionEvidence?: BenchmarkCandidateExecutionEvidence;
}

export interface BenchmarkCandidateRunRecord
  extends Omit<CandidateRunRecord, "attempts"> {
  attempts: BenchmarkCandidateAttemptRecord[];
}

export interface BenchmarkSlotExecutionResult {
  slot: BenchmarkScheduleSlot;
  executionStatus: SlotExecutionStatus;
  evaluationState: SlotEvaluationState;
  requestDisposition: RequestDisposition;
  costState: SlotCostState;
  usageCost: UsageCost | null;
  totalLatencyMs: number;
  run: BenchmarkCandidateRunRecord | null;
  accessEvidence: RunnerInputAccessEvidence | null;
  completedExecutionEvidence: CompletedCandidateExecutionEvidence | null;
}

export interface BenchmarkSlotCandidateExecutionResult
  extends Omit<BenchmarkSlotExecutionResult, "evaluationState"> {
  /** receipt에는 넣지 않고 즉시 호환 평가에만 쓰는 실행기 내부 오류 메타데이터입니다. */
  executionIntegrityError: {
    errorCode: string;
    message: string;
  } | null;
}

export interface EvaluateBenchmarkSlotReceiptOptions extends ExecuteBenchmarkSlotOptions {
  candidateExecution: BenchmarkSlotCandidateExecutionResult;
}

export interface ExecuteBenchmarkSlotOptions {
  slot: BenchmarkScheduleSlot;
  candidateDefinition: BenchmarkCandidateDefinition;
  evaluationCase: EvaluationCase;
  oracle: EvaluationOracle;
  policies: readonly PolicySection[];
  authoritativeOrder: EvaluationOrder | null;
  pricing?: PricingSnapshot;
  now?: () => number;
  signal?: AbortSignal;
}

type ToolResultCode = BenchmarkToolCallEvidence["resultCode"];

const TOOL_RESULT_CODES = new Set<ToolResultCode>([
  "OK",
  "ORDER_OWNERSHIP_MISMATCH",
  "TOOL_TIMEOUT",
  "ORDER_RESULT_MISMATCH",
  "INVALID_ARGUMENTS",
  "AS_OF_MISMATCH",
  "ORDER_NOT_FOUND",
  "CASE_SCOPE_MISMATCH",
  "POLICY_SEARCH_FAILED",
]);

class SlotEvidenceIntegrityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SlotEvidenceIntegrityError";
    this.code = code;
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "알 수 없는 실행 오류";
}

function incomplete(errorCode: string, message: string): SlotEvaluationState {
  return { status: "EVALUATION_INCOMPLETE", errorCode, message };
}

function assertSlotIdentity(options: ExecuteBenchmarkSlotOptions): void {
  const { slot, candidateDefinition, evaluationCase, oracle } = options;
  const expectedSlotId = `${evaluationCase.case_id}--${slot.candidate_id}--r${slot.repetition}`;
  if (
    slot.slot_id !== expectedSlotId
    || slot.case_id !== evaluationCase.case_id
    || oracle.case_id !== evaluationCase.case_id
    || candidateDefinition.candidateId !== slot.candidate_id
    || candidateDefinition.invocation.candidateId !== slot.candidate_id
    || candidateDefinition.identity.case_identity_hash !== sha256CanonicalJson(evaluationCase)
  ) {
    throw new SlotEvidenceIntegrityError(
      "SLOT_IDENTITY_MISMATCH",
      "schedule slot, case, oracle 또는 candidate definition identity가 일치하지 않습니다.",
    );
  }
}

function expectationFor(
  oracle: EvaluationOracle,
  candidateId: BenchmarkScheduleSlot["candidate_id"],
) {
  const expectation = oracle.candidate_access_expectations.find(
    (item) => item.candidate_id === candidateId,
  );
  if (!expectation) {
    throw new SlotEvidenceIntegrityError(
      "CANDIDATE_ACCESS_EXPECTATION_MISSING",
      `잠긴 oracle에 Candidate ${candidateId} 접근 계약이 없습니다.`,
    );
  }
  return expectation;
}

function validateAttemptSequence(run: CandidateRunRecord): void {
  if (run.attempts.length < 1 || run.attempts.length > 2) {
    throw new SlotEvidenceIntegrityError(
      "ATTEMPT_RECORD_INTEGRITY_ERROR",
      "slot 실행 attempt는 1회 또는 2회여야 합니다.",
    );
  }
  for (const [index, attempt] of run.attempts.entries()) {
    if (attempt.attemptNumber !== index + 1) {
      throw new SlotEvidenceIntegrityError(
        "ATTEMPT_RECORD_INTEGRITY_ERROR",
        "attemptNumber는 1부터 끊김 없이 증가해야 합니다.",
      );
    }
  }
  const completeIndexes = run.attempts
    .map((attempt, index) => attempt.status === "COMPLETE" ? index : -1)
    .filter((index) => index !== -1);
  if (
    run.status === "COMPLETE"
      ? completeIndexes.length !== 1 || completeIndexes[0] !== run.attempts.length - 1
      : completeIndexes.length !== 0
  ) {
    throw new SlotEvidenceIntegrityError(
      "ATTEMPT_RECORD_INTEGRITY_ERROR",
      "COMPLETE attempt는 완료 실행의 마지막에 정확히 한 번만 존재해야 합니다.",
    );
  }
}

function allProviderCalls(run: CandidateRunRecord) {
  return run.attempts.flatMap(
    (attempt) => attempt.executionEvidence?.providerCalls ?? [],
  );
}

function requestDispositionFor(run: CandidateRunRecord): RequestDisposition {
  const providerCalls = allProviderCalls(run);
  const hasUnknownAttemptOutcome = run.attempts.some((attempt) => {
    const calls = attempt.executionEvidence?.providerCalls ?? [];
    if (calls.some((call) => call.status === "failed" && call.responseId === null)) {
      return true;
    }
    return calls.length === 0
      && (
        attempt.status === "TRANSPORT_ERROR"
        || attempt.status === "REQUEST_ERROR"
        || attempt.status === "TIMEOUT"
      );
  });
  if (hasUnknownAttemptOutcome) {
    return "SENT_OUTCOME_UNKNOWN";
  }
  if (
    providerCalls.length > 0
    || run.attempts.some((attempt) => attempt.usage !== undefined)
  ) {
    return "SENT_RESPONSE_RECORDED";
  }
  return "NOT_SENT";
}

function calculateRunCost(
  run: CandidateRunRecord,
  pricing: PricingSnapshot,
): { costState: SlotCostState; usageCost: UsageCost | null } {
  const ledger = inspectProviderUsageLedger(run.attempts);
  if (ledger.state === "INTEGRITY_ERROR") {
    throw new TypeError(ledger.issue ?? "provider usage 원장 무결성 오류");
  }
  if (ledger.state === "COST_INCOMPLETE") {
    return { costState: "COST_INCOMPLETE", usageCost: null };
  }
  return {
    costState: "COMPLETE",
    // 유료 호출 원장은 attempt 파생 합계가 아니라 모든 provider call usage입니다.
    usageCost: calculateUsageCost(ledger.providerCallUsages, pricing),
  };
}

function assertPricingContract(
  pricing: PricingSnapshot,
  candidateDefinition: BenchmarkCandidateDefinition,
): void {
  const expectedPricingTier = candidateDefinition.invocation.serviceTierRequested === "default"
    ? "standard"
    : candidateDefinition.invocation.serviceTierRequested;
  const rates = Object.values(pricing.rates_per_unit);
  if (
    pricing.provider !== "OpenAI"
    || pricing.model !== candidateDefinition.invocation.modelRequestedId
    || pricing.service_tier !== expectedPricingTier
    || pricing.currency !== "USD"
    || !Number.isFinite(pricing.unit_tokens)
    || pricing.unit_tokens <= 0
    || rates.some((rate) => !Number.isFinite(rate) || rate < 0)
  ) {
    throw new TypeError(
      "가격 스냅샷의 provider·model·service tier·currency·단가가 잠긴 후보 실행과 다릅니다.",
    );
  }
}

function resultCodeFromRawResult(tool: ToolCallEvidence): ToolResultCode {
  if (typeof tool.result !== "object" || tool.result === null || Array.isArray(tool.result)) {
    throw new SlotEvidenceIntegrityError(
      "TOOL_RESULT_CODE_UNPROVEN",
      `도구 ${tool.toolName}의 raw result가 result code를 증명하지 못합니다.`,
    );
  }
  const raw = tool.result as Record<string, unknown>;
  const direct = raw.result_code;
  const nested = typeof raw.error === "object" && raw.error !== null && !Array.isArray(raw.error)
    ? (raw.error as Record<string, unknown>).code
    : null;
  const code = typeof direct === "string" ? direct : nested;
  if (typeof code !== "string" || !TOOL_RESULT_CODES.has(code as ToolResultCode)) {
    throw new SlotEvidenceIntegrityError(
      "TOOL_RESULT_CODE_UNPROVEN",
      `도구 ${tool.toolName}의 raw result code가 허용된 계약에 없습니다.`,
    );
  }
  return code as ToolResultCode;
}

function redactRetrievalResourceHandle(call: CandidateExecutionEvidence["retrievalCalls"][number]) {
  const { vectorStoreId, ...safeCall } = structuredClone(call);
  return {
    ...safeCall,
    vectorStoreIdHash: sha256CanonicalJson(vectorStoreId),
  };
}

function artifactSafeExecutionEvidence(
  evidence: CandidateExecutionEvidence,
): BenchmarkCandidateExecutionEvidence {
  return {
    providerCalls: structuredClone(evidence.providerCalls),
    retrievalCalls: evidence.retrievalCalls.map(redactRetrievalResourceHandle),
    toolCalls: structuredClone(evidence.toolCalls),
  };
}

function artifactSafeRun(run: CandidateRunRecord): BenchmarkCandidateRunRecord {
  return {
    ...structuredClone(run),
    attempts: run.attempts.map((attempt) => {
      const { executionEvidence, ...safeAttempt } = structuredClone(attempt);
      return {
        ...safeAttempt,
        ...(executionEvidence === undefined
          ? {}
          : { executionEvidence: artifactSafeExecutionEvidence(executionEvidence) }),
      };
    }),
  };
}

function normalizedEvidence(
  slot: BenchmarkScheduleSlot,
  evaluationCase: EvaluationCase,
  accessEvidence: RunnerInputAccessEvidence,
  output: NonNullable<CandidateRunRecord["output"]>,
  raw: CandidateExecutionEvidence,
): CompletedCandidateExecutionEvidence {
  const searchTools = raw.toolCalls.filter((call) => call.toolName === "search_policy");
  if (slot.candidate_id === "C" && raw.retrievalCalls.length !== searchTools.length) {
    throw new SlotEvidenceIntegrityError(
      "TOOL_RETRIEVAL_LINKAGE_MISMATCH",
      "Candidate C의 search_policy 호출과 retrieval 증거 수가 일치하지 않습니다.",
    );
  }

  const retrievalCalls = raw.retrievalCalls.map((call, index) => {
    const linkedTool = slot.candidate_id === "C" ? searchTools[index] : null;
    return {
      ...redactRetrievalResourceHandle(call),
      evidenceId: `${slot.slot_id}:retrieval:${index + 1}`,
      origin: slot.candidate_id === "C" ? "TOOL_SEARCH" as const : "RUNNER_PREFETCH" as const,
      linkedToolCallId: linkedTool?.callId ?? null,
      corpusHash: accessEvidence.policyAccess.corpusHash,
      manifestHash: accessEvidence.policyAccess.manifestHash,
      asOf: evaluationCase.as_of,
    };
  });

  const toolCalls = raw.toolCalls.map((call, index) => {
    const linkedRetrievalEvidenceIds = retrievalCalls
      .filter((retrieval) => retrieval.linkedToolCallId === call.callId)
      .map((retrieval) => retrieval.evidenceId);
    return {
      ...structuredClone(call),
      evidenceId: `${slot.slot_id}:tool:${index + 1}`,
      resultCode: resultCodeFromRawResult(call),
      linkedRetrievalEvidenceIds,
      resultHash: call.result === null ? null : sha256CanonicalJson(call.result),
    };
  });

  return {
    slotId: slot.slot_id,
    repetition: slot.repetition,
    caseId: slot.case_id,
    candidateId: slot.candidate_id,
    finalStatus: "COMPLETE",
    finalOutputHash: sha256CanonicalJson(output),
    providerCalls: structuredClone(raw.providerCalls),
    retrievalCalls,
    toolCalls,
  };
}

function completedEvidenceFor(
  run: CandidateRunRecord,
  slot: BenchmarkScheduleSlot,
  evaluationCase: EvaluationCase,
  accessEvidence: RunnerInputAccessEvidence,
): CompletedCandidateExecutionEvidence {
  const finalAttempt = run.attempts.at(-1);
  if (
    run.status !== "COMPLETE"
    || run.output === undefined
    || finalAttempt?.status !== "COMPLETE"
    || finalAttempt.executionEvidence === undefined
  ) {
    throw new SlotEvidenceIntegrityError(
      "FINAL_ATTEMPT_EVIDENCE_MISSING",
      "유효한 COMPLETE 최종 attempt와 실행 증거가 모두 필요합니다.",
    );
  }
  return normalizedEvidence(
    slot,
    evaluationCase,
    accessEvidence,
    run.output,
    finalAttempt.executionEvidence,
  );
}

function executionStatusFor(run: CandidateRunRecord): SlotExecutionStatus {
  if (run.status !== "INVALID") {
    return run.status;
  }
  const terminal = run.attempts.at(-1)?.status;
  return terminal === "FAILED"
    || terminal === "REFUSED"
    || terminal === "TRANSPORT_ERROR"
    || terminal === "REQUEST_ERROR"
    ? "FAILED"
    : "INVALID";
}

function notEvaluatedReason(
  run: Pick<BenchmarkCandidateRunRecord, "status" | "attempts">,
): SlotNotEvaluatedReason {
  if (run.status === "TIMEOUT") return "TIMEOUT";
  if (run.status === "BUDGET_EXCEEDED") return "BUDGET_EXCEEDED";
  const terminal = run.attempts.at(-1)?.status;
  if (terminal === "REFUSED") return "CANDIDATE_REFUSED";
  if (terminal === "FAILED") return "CANDIDATE_FAILED";
  if (terminal === "INCOMPLETE") return "INCOMPLETE_RESPONSE";
  return "INVALID_OUTPUT";
}

function commonFailureCode(
  run: Pick<BenchmarkCandidateRunRecord, "attempts">,
): string | null {
  const terminal = run.attempts.at(-1)?.status;
  if (terminal === "TRANSPORT_ERROR") return "PROVIDER_OUTCOME_UNKNOWN";
  if (terminal === "REQUEST_ERROR") return "PROVIDER_REQUEST_ERROR";
  return null;
}

function failedBeforeRun(
  slot: BenchmarkScheduleSlot,
  errorCode: string,
  message: string,
  requestDisposition: RequestDisposition,
): BenchmarkSlotCandidateExecutionResult {
  return {
    slot: structuredClone(slot),
    executionStatus: "FAILED",
    requestDisposition,
    costState: requestDisposition === "SENT_OUTCOME_UNKNOWN" ? "COST_INCOMPLETE" : "COMPLETE",
    usageCost: null,
    totalLatencyMs: 0,
    run: null,
    accessEvidence: null,
    completedExecutionEvidence: null,
    executionIntegrityError: { errorCode, message },
  };
}

export async function executeBenchmarkCandidateSlot(
  options: ExecuteBenchmarkSlotOptions,
): Promise<BenchmarkSlotCandidateExecutionResult> {
  throwIfAborted(options.signal);
  const pricing = options.pricing ?? DEFAULT_PRICING_SNAPSHOT;
  let accessEvidence: RunnerInputAccessEvidence;
  try {
    assertSlotIdentity(options);
    const expectation = expectationFor(options.oracle, options.slot.candidate_id);
    accessEvidence = buildRunnerInputAccessEvidence({
      candidateId: options.slot.candidate_id,
      slotId: options.slot.slot_id,
      repetition: options.slot.repetition,
      evaluationCase: options.evaluationCase,
      policies: options.policies,
      authoritativeOrder: options.authoritativeOrder,
      orderAccessStatus: expectation.expected_order_access_status,
    });
  } catch (error) {
    const code = error instanceof SlotEvidenceIntegrityError
      ? error.code
      : "RUNNER_INPUT_ACCESS_INTEGRITY_ERROR";
    return failedBeforeRun(options.slot, code, safeErrorMessage(error), "NOT_SENT");
  }

  let run: CandidateRunRecord;
  try {
    run = await runCandidateOnce({
      runNumber: options.slot.repetition,
      adapter: options.candidateDefinition.adapter,
      invocation: options.candidateDefinition.invocation,
      ...(options.now ? { now: options.now } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    validateAttemptSequence(run);
  } catch (error) {
    // 취소는 실행 결과가 아니며, 상위 orchestrator가 새 호출 금지/재개 정책을 결정합니다.
    throwIfAborted(options.signal);
    const code = error instanceof RunnerEvidenceIntegrityError
      ? "RUNNER_EVIDENCE_INTEGRITY_ERROR"
      : error instanceof SlotEvidenceIntegrityError
        ? error.code
        : "UNKNOWN_EXECUTION_ERROR";
    return failedBeforeRun(
      options.slot,
      code,
      safeErrorMessage(error),
      "SENT_OUTCOME_UNKNOWN",
    );
  }

  const requestDisposition = requestDispositionFor(run);
  let costState: SlotCostState;
  let usageCost: UsageCost | null;
  try {
    assertPricingContract(pricing, options.candidateDefinition);
    ({ costState, usageCost } = calculateRunCost(run, pricing));
  } catch (error) {
    return {
      slot: structuredClone(options.slot),
      executionStatus: executionStatusFor(run),
      requestDisposition,
      costState: "COST_INCOMPLETE",
      usageCost: null,
      totalLatencyMs: run.totalLatencyMs,
      run: artifactSafeRun(run),
      accessEvidence,
      completedExecutionEvidence: null,
      executionIntegrityError: {
        errorCode: "COST_CALCULATION_INTEGRITY_ERROR",
        message: safeErrorMessage(error),
      },
    };
  }
  const base = {
    slot: structuredClone(options.slot),
    executionStatus: executionStatusFor(run),
    requestDisposition,
    costState,
    usageCost,
    totalLatencyMs: run.totalLatencyMs,
    run: artifactSafeRun(run),
    accessEvidence,
    executionIntegrityError: null,
  };

  if (run.status !== "COMPLETE") {
    return {
      ...base,
      completedExecutionEvidence: null,
    };
  }

  let executionEvidence: CompletedCandidateExecutionEvidence | null = null;
  try {
    executionEvidence = completedEvidenceFor(
      run,
      options.slot,
      options.evaluationCase,
      accessEvidence,
    );
    return {
      ...base,
      completedExecutionEvidence: executionEvidence,
    };
  } catch (error) {
    const errorCode = error instanceof EvaluationIntegrityError
      ? error.code
      : error instanceof SlotEvidenceIntegrityError
        ? error.code
        : "UNKNOWN_EVALUATION_ERROR";
    return {
      ...base,
      completedExecutionEvidence: executionEvidence,
      executionIntegrityError: {
        errorCode,
        message: safeErrorMessage(error),
      },
    };
  }
}

export function evaluateBenchmarkSlotReceipt({
  candidateExecution,
  ...options
}: EvaluateBenchmarkSlotReceiptOptions): SlotEvaluationState {
  if (candidateExecution.executionIntegrityError !== null) {
    return incomplete(
      candidateExecution.executionIntegrityError.errorCode,
      candidateExecution.executionIntegrityError.message,
    );
  }
  const run = candidateExecution.run;
  if (run === null || candidateExecution.accessEvidence === null) {
    return incomplete(
      "CANDIDATE_EXECUTION_RECEIPT_INTEGRITY_ERROR",
      "gate 평가에 필요한 terminal run 또는 접근 증거가 없습니다.",
    );
  }
  const commonCode = commonFailureCode(run);
  if (commonCode !== null) {
    return incomplete(
      commonCode,
      run.attempts.at(-1)?.error ?? "공급자 실행 결과를 완전히 확인하지 못했습니다.",
    );
  }
  if (run.status !== "COMPLETE") {
    return { status: "NOT_EVALUATED", reason: notEvaluatedReason(run) };
  }

  try {
    const executionEvidence = candidateExecution.completedExecutionEvidence;
    if (executionEvidence === null) {
      return incomplete(
        "FINAL_ATTEMPT_EVIDENCE_MISSING",
        "완료 receipt에 결정적 gate용 정규화 실행 증거가 없습니다.",
      );
    }
    const evaluated = evaluateHardGates({
      candidateId: options.slot.candidate_id,
      slotId: options.slot.slot_id,
      repetition: options.slot.repetition,
      evaluationCase: options.evaluationCase,
      oracle: options.oracle,
      policies: options.policies,
      authoritativeOrder: options.authoritativeOrder,
      accessEvidence: candidateExecution.accessEvidence,
      output: run.output!,
      executionEvidence,
    });
    return { status: "EVALUATED", gates: evaluated.gates };
  } catch (error) {
    const errorCode = error instanceof EvaluationIntegrityError
      ? error.code
      : error instanceof SlotEvidenceIntegrityError
        ? error.code
        : "UNKNOWN_EVALUATION_ERROR";
    return incomplete(errorCode, safeErrorMessage(error));
  }
}

export async function executeBenchmarkSlot(
  options: ExecuteBenchmarkSlotOptions,
): Promise<BenchmarkSlotExecutionResult> {
  const candidateExecution = await executeBenchmarkCandidateSlot(options);
  const evaluationState = evaluateBenchmarkSlotReceipt({ ...options, candidateExecution });
  const { executionIntegrityError: _executionIntegrityError, ...receiptResult } = candidateExecution;
  return { ...receiptResult, evaluationState };
}

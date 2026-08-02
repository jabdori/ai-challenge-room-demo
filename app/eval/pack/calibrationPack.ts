import type { PolicyGateOracle, PolicyReference } from "../deterministic/policyGate";
import { evaluateActivePolicyGate } from "../deterministic/policyGate";
import { parseCandidateOutput } from "../contracts/candidateOutput";
import type { CandidateAttemptRecord, CandidateRunRecord } from "../runner/types";
import { canonicalJsonStringify, sha256CanonicalJson } from "../runtime/canonicalJson";
import {
  calculateUsageCost,
  type PricingSnapshot,
  type TokenUsage,
  type UsageCost,
} from "../runtime/pricing";
import {
  ABC_CHALLENGE,
  CALIBRATION_CASE,
  CALIBRATION_ORACLE,
  CALIBRATION_POLICIES,
  CALIBRATION_PRICING,
  CANDIDATE_CONFIGS,
  CANDIDATE_IDENTITY_RECORDS,
  CANDIDATE_IDS,
  SHARED_EVALUATION_IDENTITY,
  type CalibrationCandidateId,
  type SharedEvaluationIdentity,
} from "../smoke/candidateDefinitions";
import {
  buildPartialEvaluationPack,
  PRICING_SCHEDULE_REASON,
  type PartialEvaluationPack,
} from "./evaluationPack";

export interface PartialCalibrationPackEntry {
  candidate_id: CalibrationCandidateId;
  evaluation_pack: PartialEvaluationPack;
}

interface BuildPartialCalibrationPackInput {
  entries: readonly PartialCalibrationPackEntry[];
  createdAt: string;
}

export interface PartialCalibrationPack {
  schema_version: "1.0";
  artifact_kind: "PARTIAL_CALIBRATION_PACK";
  source: "CALIBRATION_SMOKE";
  evaluation_status: "EVALUATION_INCOMPLETE";
  pack_id: string;
  coverage: {
    cases: 1;
    candidates: 3;
    runs_per_candidate: 2;
    expected_runs: 6;
  };
  challenge_version: string;
  shared_evaluation_identity: SharedEvaluationIdentity;
  dataset_hash: string;
  case_id: string;
  model_requested_id: string;
  service_tier_requested: string;
  pricing_snapshot_id: string;
  pricing_evidence: PartialEvaluationPack["pricing_evidence"];
  total_runtime_cost_usd: number;
  baseline_version: null;
  created_at: string;
  entries: PartialCalibrationPackEntry[];
}

const RUN_STATUSES = new Set<string>([
  "COMPLETE",
  "INVALID",
  "TIMEOUT",
  "BUDGET_EXCEEDED",
]);
const ATTEMPT_STATUSES = new Set<string>([
  "COMPLETE",
  "INVALID_OUTPUT",
  "TRANSPORT_ERROR",
  "REQUEST_ERROR",
  "TIMEOUT",
  "BUDGET_EXCEEDED",
  "INCOMPLETE",
  "FAILED",
  "REFUSED",
]);
// runner는 schema/transport 오류를 항상 한 번 더 시도합니다. TIMEOUT은
// invocation error가 retryable이고 전체 deadline이 남은 경우에만 재시도할 수 있습니다.
const ALWAYS_RETRYABLE_ATTEMPT_STATUSES = new Set<string>([
  "INVALID_OUTPUT",
  "TRANSPORT_ERROR",
]);
const POSSIBLY_RETRYABLE_ATTEMPT_STATUSES = new Set<string>([
  ...ALWAYS_RETRYABLE_ATTEMPT_STATUSES,
  "TIMEOUT",
]);

function snapshotEntries(
  entries: readonly PartialCalibrationPackEntry[],
): PartialCalibrationPackEntry[] {
  const serialized = JSON.stringify(entries);
  if (serialized === undefined) {
    throw new TypeError("Calibration Pack entries를 JSON snapshot으로 만들 수 없습니다.");
  }
  return JSON.parse(serialized) as PartialCalibrationPackEntry[];
}

function assertCanonicalEqual(actual: unknown, expected: unknown, message: string): void {
  if (canonicalJsonStringify(actual) !== canonicalJsonStringify(expected)) {
    throw new Error(message);
  }
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function pricingFromEvidence(pack: PartialEvaluationPack): PricingSnapshot {
  return {
    pricing_snapshot_id: pack.pricing_evidence.snapshot_id,
    pricing_as_of: pack.pricing_evidence.pricing_as_of,
    provider: CALIBRATION_PRICING.provider,
    model: pack.model_requested_id,
    service_tier: pack.pricing_evidence.pricing_schedule_applied,
    currency: CALIBRATION_PRICING.currency,
    unit_tokens: pack.pricing_evidence.unit_tokens,
    rates_per_unit: structuredClone(pack.pricing_evidence.rates_per_unit),
    source_url: pack.pricing_evidence.source_url,
    source_retrieved_at: pack.pricing_evidence.source_retrieved_at,
    notes: CALIBRATION_PRICING.notes,
  };
}

function recomputeRunCost(
  pack: PartialEvaluationPack,
  attempts: readonly CandidateAttemptRecord[],
): UsageCost | null {
  return calculateUsageCost(
    attempts.map((attempt) => attempt.usage),
    pricingFromEvidence(pack),
  );
}

function validateTokenUsage(usage: TokenUsage, label: string): void {
  const required = [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.cacheWriteTokens,
    usage.outputTokens,
  ];
  if (required.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error(`${label}에 유효하지 않은 token usage가 있습니다.`);
  }
  if (usage.cachedInputTokens + usage.cacheWriteTokens > usage.inputTokens) {
    throw new Error(`${label}의 cache token 합이 input token을 초과했습니다.`);
  }
  for (const optional of [usage.reasoningTokens, usage.totalTokens]) {
    if (optional !== undefined && (!Number.isFinite(optional) || optional < 0)) {
      throw new Error(`${label}에 유효하지 않은 optional token usage가 있습니다.`);
    }
  }
}

function aggregateProviderUsage(
  attempt: CandidateAttemptRecord,
  candidateId: CalibrationCandidateId,
): TokenUsage | null {
  const calls = attempt.executionEvidence?.providerCalls ?? [];
  const failedIndex = calls.findIndex((call) => call.status === "failed");
  if (failedIndex !== -1 && failedIndex !== calls.length - 1) {
    throw new Error(`${candidateId} failed provider evidence는 마지막 호출이어야 합니다.`);
  }
  for (const [index, call] of calls.entries()) {
    if (!Number.isFinite(call.latencyMs) || call.latencyMs < 0) {
      throw new Error(`${candidateId} providerCalls[${index}] latency가 유효하지 않습니다.`);
    }
    if (call.status !== "failed" && call.usage === null) {
      throw new Error(`${candidateId} 완료 provider evidence에 usage가 없습니다.`);
    }
    if (call.usage) {
      validateTokenUsage(call.usage, `${candidateId} providerCalls[${index}]`);
    }
  }
  const usages = calls.flatMap((call) => call.usage ? [call.usage] : []);
  if (usages.length === 0) {
    return null;
  }
  const reasoningCount = usages.filter((usage) => usage.reasoningTokens !== undefined).length;
  const totalCount = usages.filter((usage) => usage.totalTokens !== undefined).length;
  if (
    (reasoningCount !== 0 && reasoningCount !== usages.length)
    || (totalCount !== 0 && totalCount !== usages.length)
  ) {
    throw new Error(`${candidateId} provider usage의 optional token 필드 계약이 호출마다 다릅니다.`);
  }
  return {
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    cachedInputTokens: usages.reduce((sum, usage) => sum + usage.cachedInputTokens, 0),
    cacheWriteTokens: usages.reduce((sum, usage) => sum + usage.cacheWriteTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    ...(reasoningCount === usages.length
      ? { reasoningTokens: usages.reduce((sum, usage) => sum + usage.reasoningTokens!, 0) }
      : {}),
    ...(totalCount === usages.length
      ? { totalTokens: usages.reduce((sum, usage) => sum + usage.totalTokens!, 0) }
      : {}),
  };
}

export function validateAttemptUsage(
  candidateId: CalibrationCandidateId,
  attempt: CandidateAttemptRecord,
): void {
  if (!attempt.executionEvidence) {
    if (attempt.usage !== undefined) {
      throw new Error(`${candidateId} attempt usage에 대응하는 provider evidence가 없습니다.`);
    }
    return;
  }
  const aggregate = aggregateProviderUsage(attempt, candidateId);
  assertCanonicalEqual(
    attempt.usage ?? null,
    aggregate,
    `${candidateId} provider usage 합계와 attempt usage가 일치하지 않습니다.`,
  );
}

function expectedNotEvaluatedReason(
  run: CandidateRunRecord,
): "INVALID_OUTPUT" | "TIMEOUT" | "BUDGET_EXCEEDED" {
  return run.status === "TIMEOUT"
    ? "TIMEOUT"
    : run.status === "BUDGET_EXCEEDED"
      ? "BUDGET_EXCEEDED"
      : "INVALID_OUTPUT";
}

export function validateRunAndGate(
  candidateId: CalibrationCandidateId,
  packRun: PartialEvaluationPack["runs"][number],
): void {
  const { execution: run, gate } = packRun;
  if (run.attempts.length < 1 || run.attempts.length > 2) {
    throw new Error(`${candidateId} run에는 1~2개 attempt만 허용합니다.`);
  }
  if (!RUN_STATUSES.has(run.status)) {
    throw new Error(`${candidateId} run status가 선언된 runner enum 밖입니다: ${run.status}`);
  }
  run.attempts.forEach((attempt, index) => {
    if (!ATTEMPT_STATUSES.has(attempt.status)) {
      throw new Error(
        `${candidateId} attempt status가 선언된 runner enum 밖입니다: ${attempt.status}`,
      );
    }
    if (attempt.attemptNumber !== index + 1) {
      throw new Error(`${candidateId} attempt number는 1부터 연속이어야 합니다.`);
    }
    if (!Number.isFinite(attempt.latencyMs) || attempt.latencyMs < 0) {
      throw new Error(`${candidateId} attempt latency는 0 이상의 유한한 수여야 합니다.`);
    }
  });
  if (
    run.attempts.length === 1
    && ALWAYS_RETRYABLE_ATTEMPT_STATUSES.has(run.attempts[0].status)
  ) {
    throw new Error(`${candidateId} runner가 항상 재시도하는 상태가 단일 attempt로 종료됐습니다.`);
  }
  if (
    run.attempts.length === 2
    && !POSSIBLY_RETRYABLE_ATTEMPT_STATUSES.has(run.attempts[0].status)
  ) {
    throw new Error(
      `${candidateId} 비재시도 첫 상태 뒤에 두 번째 attempt가 기록됐습니다: ${run.attempts[0].status}`,
    );
  }
  const terminalAttemptStatus = run.attempts.at(-1)!.status;
  const statusMatches = run.status === "COMPLETE"
    ? run.output !== undefined && terminalAttemptStatus === "COMPLETE"
    : run.status === "TIMEOUT"
      ? run.output === undefined && terminalAttemptStatus === "TIMEOUT"
      : run.status === "BUDGET_EXCEEDED"
        ? run.output === undefined && terminalAttemptStatus === "BUDGET_EXCEEDED"
        : run.output === undefined
          && !["COMPLETE", "TIMEOUT", "BUDGET_EXCEEDED"].includes(terminalAttemptStatus);
  if (!statusMatches) {
    throw new Error(`${candidateId} attempts/run status/output 구조가 일치하지 않습니다.`);
  }
  if (!Number.isFinite(run.totalLatencyMs) || run.totalLatencyMs < 0) {
    throw new Error(`${candidateId} run total latency는 0 이상의 유한한 수여야 합니다.`);
  }
  const summedLatency = run.attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0);
  if (run.totalLatencyMs !== summedLatency) {
    throw new Error(`${candidateId} run total latency가 attempt 합계와 다릅니다.`);
  }

  if (run.output) {
    const parsedOutput = parseCandidateOutput(run.output);
    assertCanonicalEqual(
      run.output,
      parsedOutput,
      `${candidateId} output이 잠긴 Structured Output schema와 다릅니다.`,
    );
    const expectedGate = {
      runNumber: run.runNumber,
      evaluation: "EVALUATED" as const,
      result: evaluateActivePolicyGate({
        output: run.output,
        oracle: CALIBRATION_ORACLE as PolicyGateOracle,
        policies: CALIBRATION_POLICIES as PolicyReference[],
        asOf: CALIBRATION_CASE.as_of,
      }),
    };
    assertCanonicalEqual(
      gate,
      expectedGate,
      `${candidateId} output과 P0-HG-02 gate 재계산 결과가 다릅니다.`,
    );
  } else {
    assertCanonicalEqual(
      gate,
      {
        runNumber: run.runNumber,
        evaluation: "NOT_EVALUATED",
        reason: expectedNotEvaluatedReason(run),
      },
      `${candidateId} incomplete run의 NOT_EVALUATED reason이 다릅니다.`,
    );
  }
}

export function validateAttemptEnvelope(
  candidateId: CalibrationCandidateId,
  attempt: CandidateAttemptRecord,
): void {
  const evidence = attempt.executionEvidence;
  if (!evidence) {
    if (attempt.status === "COMPLETE") {
      throw new Error(`${candidateId} COMPLETE attempt에는 실행 evidence가 필요합니다.`);
    }
    return;
  }
  const expected = CANDIDATE_IDENTITY_RECORDS[candidateId];
  if (
    evidence.providerCalls.length > expected.max_provider_calls
    || evidence.retrievalCalls.length > expected.max_retrieval_calls
    || evidence.toolCalls.length > expected.max_tool_calls
  ) {
    throw new Error(`${candidateId} attempt evidence가 잠긴 provider/retrieval/tool envelope를 초과했습니다.`);
  }
  if (attempt.status === "COMPLETE") {
    const providerCountIsValid = candidateId === "C"
      ? evidence.providerCalls.length >= 1
        && evidence.providerCalls.length <= expected.max_provider_calls
      : evidence.providerCalls.length === 1;
    if (!providerCountIsValid) {
      throw new Error(`${candidateId} COMPLETE attempt의 provider evidence 수가 잠긴 envelope와 다릅니다.`);
    }
    if (evidence.providerCalls.some((call) => call.status !== "completed")) {
      throw new Error(`${candidateId} COMPLETE attempt의 provider status는 모두 completed여야 합니다.`);
    }
    if (
      !isNonBlankString(attempt.responseId)
      || !isNonBlankString(attempt.modelReportedId)
      || !isNonBlankString(attempt.serviceTierReported)
    ) {
      throw new Error(
        `${candidateId} COMPLETE attempt의 response/model/service tier metadata는 비어 있지 않아야 합니다.`,
      );
    }
    if (evidence.providerCalls.some((call) =>
      !isNonBlankString(call.responseId)
      || !isNonBlankString(call.modelReportedId)
      || !isNonBlankString(call.serviceTierReported)
    )) {
      throw new Error(
        `${candidateId} COMPLETE provider의 response/model/service tier metadata는 비어 있지 않아야 합니다.`,
      );
    }
    const finalProviderCall = evidence.providerCalls.at(-1)!;
    if (
      attempt.responseId !== finalProviderCall.responseId
      || attempt.modelReportedId !== finalProviderCall.modelReportedId
      || attempt.serviceTierReported !== finalProviderCall.serviceTierReported
    ) {
      throw new Error(`${candidateId} COMPLETE attempt metadata가 마지막 provider evidence와 다릅니다.`);
    }
    if (
      candidateId === "B"
      && (
        evidence.retrievalCalls.length !== 1
        || evidence.retrievalCalls[0].status !== "COMPLETE"
      )
    ) {
      throw new Error("Candidate B COMPLETE attempt에는 완료된 retrieval evidence 1건이 필요합니다.");
    }
    if (evidence.retrievalCalls.some((call) => call.status !== "COMPLETE")) {
      throw new Error(`${candidateId} COMPLETE attempt의 retrieval status는 모두 COMPLETE여야 합니다.`);
    }
    if (evidence.toolCalls.some((call) =>
      call.status !== "COMPLETE"
      || call.providerStatus !== "completed"
      || call.result === null
    )) {
      throw new Error(`${candidateId} COMPLETE attempt의 tool evidence가 완료 상태가 아닙니다.`);
    }
  }
  evidence.providerCalls.forEach((call, index) => {
    if (
      call.callNumber !== index + 1
      || call.modelRequestedId !== packModelRequestedId()
      || call.serviceTierRequested !== "default"
    ) {
      throw new Error(`${candidateId} provider evidence가 공통 실행 계약과 일치하지 않습니다.`);
    }
  });
  evidence.retrievalCalls.forEach((call, index) => {
    if (call.callNumber !== index + 1) {
      throw new Error(`${candidateId} retrieval call number가 1부터 연속이 아닙니다.`);
    }
    if (!Number.isFinite(call.latencyMs) || call.latencyMs < 0) {
      throw new Error(`${candidateId} retrievalCalls[${index}] latency가 유효하지 않습니다.`);
    }
    if (
      candidateId === "B"
      && (
        call.requestedQuery !== CANDIDATE_CONFIGS.B.retrieval_query
        || call.maxNumResults !== CANDIDATE_CONFIGS.B.max_num_results
        || call.rewriteQuery !== CANDIDATE_CONFIGS.B.rewrite_query
      )
    ) {
      throw new Error("Candidate B retrieval evidence가 잠긴 query/top-2/rewrite=false 계약과 다릅니다.");
    }
  });
  const cToolTurns = new Set<number>();
  evidence.toolCalls.forEach((call, index) => {
    if (call.callNumber !== index + 1) {
      throw new Error(`${candidateId} tool call number가 1부터 연속이 아닙니다.`);
    }
    if (!Number.isFinite(call.latencyMs) || call.latencyMs < 0) {
      throw new Error(`${candidateId} toolCalls[${index}] latency가 유효하지 않습니다.`);
    }
    if (candidateId === "C") {
      if (
        !Number.isInteger(call.modelTurn)
        || call.modelTurn < 1
        || call.modelTurn > CANDIDATE_CONFIGS.C.execution_envelope.max_provider_calls
      ) {
        throw new Error("Candidate C tool modelTurn이 잠긴 model turn envelope 밖입니다.");
      }
      if (call.callId.trim().length === 0) {
        throw new Error("Candidate C tool call_id는 공백이어서는 안 됩니다.");
      }
      if (!CANDIDATE_CONFIGS.C.allowed_tools?.includes(
        call.toolName as "search_policy" | "get_order",
      )) {
        throw new Error(`Candidate C에 허용되지 않은 tool evidence입니다: ${call.toolName}`);
      }
      if (CANDIDATE_CONFIGS.C.parallel_tool_calls === false && cToolTurns.has(call.modelTurn)) {
        throw new Error("Candidate C tool evidence가 parallel_tool_calls=false 계약을 위반했습니다.");
      }
      cToolTurns.add(call.modelTurn);
    }
  });
  if (candidateId === "C") {
    const callIds = evidence.toolCalls.map((call) => call.callId.trim());
    if (new Set(callIds).size !== callIds.length) {
      throw new Error("Candidate C tool call_id는 attempt 안에서 중복될 수 없습니다.");
    }
    const searchToolCount = evidence.toolCalls.filter(
      (call) => call.toolName === "search_policy",
    ).length;
    if (evidence.retrievalCalls.length !== searchToolCount) {
      throw new Error("Candidate C retrieval evidence와 search_policy tool evidence 수가 다릅니다.");
    }
    if (attempt.status === "COMPLETE") {
      const finalProviderTurn = evidence.providerCalls.length;
      if (finalProviderTurn !== evidence.toolCalls.length + 1) {
        throw new Error(
          "Candidate C COMPLETE trace는 각 중간 provider turn당 도구 1건과 도구 없는 최종 turn 1건이 필요합니다.",
        );
      }
      for (const toolCall of evidence.toolCalls) {
        const providerCallAtToolTurn = evidence.providerCalls[toolCall.modelTurn - 1];
        if (!providerCallAtToolTurn || providerCallAtToolTurn.status !== "completed") {
          throw new Error(
            "Candidate C tool modelTurn에 대응하는 completed provider call이 없습니다.",
          );
        }
        if (toolCall.modelTurn >= finalProviderTurn) {
          throw new Error(
            "Candidate C COMPLETE tool call 뒤에는 도구가 없는 후속 최종 provider turn이 필요합니다.",
          );
        }
      }
    }
  }
}

function packModelRequestedId(): string {
  return ABC_CHALLENGE.shared_execution_envelope.model_requested_id;
}

function expectedPricingEvidence(): PartialEvaluationPack["pricing_evidence"] {
  return {
    pricing_mode: "LOCKED_SNAPSHOT",
    snapshot_id: CALIBRATION_PRICING.pricing_snapshot_id,
    snapshot_hash: sha256CanonicalJson(CALIBRATION_PRICING),
    pricing_as_of: CALIBRATION_PRICING.pricing_as_of,
    source_url: CALIBRATION_PRICING.source_url,
    source_retrieved_at: CALIBRATION_PRICING.source_retrieved_at,
    unit_tokens: CALIBRATION_PRICING.unit_tokens,
    rates_per_unit: structuredClone(CALIBRATION_PRICING.rates_per_unit),
    pricing_schedule_applied: CALIBRATION_PRICING.service_tier,
    pricing_schedule_reason: PRICING_SCHEDULE_REASON,
  };
}

function validateChild(
  entry: PartialCalibrationPackEntry,
): number {
  const { candidate_id: candidateId, evaluation_pack: pack } = entry;
  const expected = CANDIDATE_IDENTITY_RECORDS[candidateId];
  if (!expected) {
    throw new Error(`알 수 없는 calibration candidate_id입니다: ${candidateId}`);
  }
  if (pack.control_kind === "NEGATIVE_CONTROL") {
    throw new Error("부정 대조군(negative control)은 정상 A/B/C Calibration Pack에 포함할 수 없습니다.");
  }
  if (
    pack.artifact_kind !== "PARTIAL_EVALUATION_PACK"
    || pack.source !== "CALIBRATION_SMOKE"
    || pack.evaluation_status !== "EVALUATION_INCOMPLETE"
    || pack.baseline_version !== null
  ) {
    throw new Error("Calibration Pack은 incomplete partial child pack만 포함할 수 있습니다.");
  }
  const identityMatches = pack.candidate_id === candidateId
    && pack.candidate_version === expected.candidate_version
    && pack.candidate_config_hash === expected.candidate_config_hash
    && pack.system_prompt_hash === expected.system_prompt_hash
    && pack.invocation_hash === expected.invocation_hash;
  if (!identityMatches) {
    throw new Error(`${candidateId} candidate identity mapping이 잠긴 ID/version/config/prompt/invocation과 다릅니다.`);
  }
  if (
    pack.challenge_version !== ABC_CHALLENGE.challenge_version
    || pack.dataset_hash !== SHARED_EVALUATION_IDENTITY.dataset_hash
    || pack.case_id !== CALIBRATION_CASE.case_id
    || pack.model_requested_id !== packModelRequestedId()
    || pack.service_tier_requested !== "default"
    || pack.pricing_snapshot_id !== CALIBRATION_PRICING.pricing_snapshot_id
  ) {
    throw new Error(`${candidateId} child의 공통 challenge/dataset/case/model/pricing identity가 다릅니다.`);
  }
  assertCanonicalEqual(
    pack.shared_evaluation_identity,
    SHARED_EVALUATION_IDENTITY,
    `${candidateId} child의 shared evaluation identity가 다릅니다.`,
  );
  assertCanonicalEqual(
    pack.pricing_evidence,
    expectedPricingEvidence(),
    `${candidateId} child의 pricing evidence가 잠긴 보정 가정과 다릅니다.`,
  );
  assertCanonicalEqual(
    pack.coverage,
    { cases: 1, candidates: 1, runs_per_case: 2, expected_runs: 2 },
    `${candidateId} child coverage가 정확한 2회 실행이 아닙니다.`,
  );
  if (
    pack.runs.length !== 2
    || pack.runs[0].execution.runNumber !== 1
    || pack.runs[1].execution.runNumber !== 2
    || pack.runs[0].gate.runNumber !== 1
    || pack.runs[1].gate.runNumber !== 2
  ) {
    throw new Error(`${candidateId} child는 exact run 1/2와 대응 gate가 필요합니다.`);
  }

  let recomputedChildTotal = 0;
  for (const run of pack.runs) {
    validateRunAndGate(candidateId, run);
    for (const attempt of run.execution.attempts) {
      validateAttemptEnvelope(candidateId, attempt);
      validateAttemptUsage(candidateId, attempt);
    }
    const recomputed = recomputeRunCost(pack, run.execution.attempts);
    assertCanonicalEqual(
      run.runtime_cost,
      recomputed,
      `${candidateId} child run ${run.execution.runNumber}의 runtime cost가 raw attempt usage와 다릅니다.`,
    );
    recomputedChildTotal += recomputed?.totalCostUsd ?? 0;
  }
  if (pack.total_runtime_cost_usd !== recomputedChildTotal) {
    throw new Error(`${candidateId} child total runtime cost가 raw attempt usage 재계산값과 다릅니다.`);
  }
  const expectedModelReportedIds = [...new Set(pack.runs.flatMap((run) =>
    run.execution.attempts.flatMap((attempt) => [
      ...(attempt.modelReportedId ? [attempt.modelReportedId] : []),
      ...(attempt.executionEvidence?.providerCalls.flatMap((call) =>
        call.modelReportedId ? [call.modelReportedId] : []) ?? []),
    ]),
  ))];
  const expectedServiceTiersReported = [...new Set(pack.runs.flatMap((run) =>
    run.execution.attempts.flatMap((attempt) => [
      ...(attempt.serviceTierReported ? [attempt.serviceTierReported] : []),
      ...(attempt.executionEvidence?.providerCalls.flatMap((call) =>
        call.serviceTierReported ? [call.serviceTierReported] : []) ?? []),
    ]),
  ))];
  assertCanonicalEqual(
    pack.model_reported_ids,
    expectedModelReportedIds,
    `${candidateId} model_reported_ids가 attempt metadata와 다릅니다.`,
  );
  assertCanonicalEqual(
    pack.service_tiers_reported,
    expectedServiceTiersReported,
    `${candidateId} service_tiers_reported가 attempt metadata와 다릅니다.`,
  );
  const rebuiltChild = buildPartialEvaluationPack({
    challengeVersion: ABC_CHALLENGE.challenge_version,
    candidateId,
    candidateVersion: expected.candidate_version,
    datasetHash: SHARED_EVALUATION_IDENTITY.dataset_hash,
    candidateConfigHash: expected.candidate_config_hash,
    systemPromptHash: expected.system_prompt_hash,
    invocationHash: expected.invocation_hash,
    sharedEvaluationIdentity: SHARED_EVALUATION_IDENTITY,
    modelRequestedId: packModelRequestedId(),
    serviceTierRequested: "default",
    pricing: CALIBRATION_PRICING,
    caseId: CALIBRATION_CASE.case_id,
    runs: pack.runs.map((run) => run.execution),
    gateResults: pack.runs.map((run) => run.gate),
    createdAt: pack.created_at,
  });
  assertCanonicalEqual(
    pack,
    rebuiltChild,
    `${candidateId} child record가 canonical 부분 Evaluation Pack 계약과 다릅니다.`,
  );
  return recomputedChildTotal;
}

export function buildPartialCalibrationPack(
  sourceInput: BuildPartialCalibrationPackInput,
): PartialCalibrationPack {
  const entries = snapshotEntries(sourceInput.entries);
  if (entries.length !== 3) {
    throw new Error("Calibration Pack에는 exact A/B/C child entry 3개가 필요합니다.");
  }
  const byCandidate = new Map<CalibrationCandidateId, PartialCalibrationPackEntry>();
  for (const entry of entries) {
    if (!CANDIDATE_IDS.includes(entry.candidate_id) || byCandidate.has(entry.candidate_id)) {
      throw new Error("Calibration Pack candidate identity mapping은 exact A/B/C unique여야 합니다.");
    }
    byCandidate.set(entry.candidate_id, entry);
  }
  if (CANDIDATE_IDS.some((candidateId) => !byCandidate.has(candidateId))) {
    throw new Error("Calibration Pack candidate identity mapping은 exact A/B/C unique여야 합니다.");
  }
  const orderedEntries = CANDIDATE_IDS.map((candidateId) => byCandidate.get(candidateId)!);
  const totalRuntimeCostUsd = orderedEntries.reduce(
    (total, entry) => total + validateChild(entry),
    0,
  );

  const stableIdentity = {
    artifact_kind: "PARTIAL_CALIBRATION_PACK",
    source: "CALIBRATION_SMOKE",
    challenge_version: ABC_CHALLENGE.challenge_version,
    shared_evaluation_identity: SHARED_EVALUATION_IDENTITY,
    case_id: CALIBRATION_CASE.case_id,
    model_requested_id: packModelRequestedId(),
    service_tier_requested: "default",
    pricing_snapshot_id: CALIBRATION_PRICING.pricing_snapshot_id,
    candidates: CANDIDATE_IDS.map((candidateId) => CANDIDATE_IDENTITY_RECORDS[candidateId]),
  };
  const packId = `calibration-pack-${sha256CanonicalJson(stableIdentity).slice(0, 16)}`;

  return {
    schema_version: "1.0",
    artifact_kind: "PARTIAL_CALIBRATION_PACK",
    source: "CALIBRATION_SMOKE",
    evaluation_status: "EVALUATION_INCOMPLETE",
    pack_id: packId,
    coverage: { cases: 1, candidates: 3, runs_per_candidate: 2, expected_runs: 6 },
    challenge_version: ABC_CHALLENGE.challenge_version,
    shared_evaluation_identity: structuredClone(SHARED_EVALUATION_IDENTITY),
    dataset_hash: SHARED_EVALUATION_IDENTITY.dataset_hash,
    case_id: CALIBRATION_CASE.case_id,
    model_requested_id: packModelRequestedId(),
    service_tier_requested: "default",
    pricing_snapshot_id: CALIBRATION_PRICING.pricing_snapshot_id,
    pricing_evidence: expectedPricingEvidence(),
    total_runtime_cost_usd: totalRuntimeCostUsd,
    baseline_version: null,
    created_at: sourceInput.createdAt,
    entries: orderedEntries,
  };
}

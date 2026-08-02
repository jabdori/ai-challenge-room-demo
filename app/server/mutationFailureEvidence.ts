import {
  FinalDecisionMemoOpenAIError,
  type FinalDecisionMemoOpenAIErrorKind,
} from "../eval/decision/openaiFinalDecisionMemoAdapter";
import {
  FINAL_DECISION_MEMO_PRICING_SNAPSHOT,
  type FinalDecisionMemoAttemptEvidence,
} from "../eval/decision/decisionBaseline";
import {
  calculateUsageCost,
  type TokenUsage,
  type UsageCost,
} from "../eval/runtime/pricing";
import { canonicalJsonStringify } from "../eval/runtime/canonicalJson";

export type MutationFailureClassification =
  | "PROVIDER_TEMPORARY_FAILURE"
  | "PROVIDER_TERMINAL_FAILURE"
  | "EVALUATION_INCOMPLETE";

export interface SafeMutationFailureAttempt {
  readonly attempt_number: 1 | 2;
  readonly request_disposition:
    FinalDecisionMemoAttemptEvidence["request_disposition"];
  readonly status: FinalDecisionMemoAttemptEvidence["status"];
  readonly retry_eligible: boolean;
  readonly response_id: string | null;
  readonly latency_ms: number;
  readonly usage: TokenUsage | null;
  readonly usage_cost: UsageCost | null;
}

export interface MutationFailureEvidence {
  readonly error_code: "FINAL_DECISION_MEMO_OPENAI_ERROR";
  readonly evaluation_status: "EVALUATION_INCOMPLETE";
  readonly kind: FinalDecisionMemoOpenAIErrorKind;
  readonly classification: MutationFailureClassification;
  readonly attempts: readonly SafeMutationFailureAttempt[];
  readonly provider_response: Readonly<{
    readonly evidence_present: boolean;
    readonly response_id: string | null;
    readonly response_status: string | null;
    readonly http_status: number | null;
    readonly incomplete_detected: boolean;
    readonly refusal_detected: boolean;
  }>;
  readonly cost_completeness: Readonly<{
    readonly status: "COMPLETE" | "INCOMPLETE";
    readonly known_total_cost_usd: number;
    readonly unpriced_attempt_numbers: readonly (1 | 2)[];
  }>;
}

const KINDS = new Set<FinalDecisionMemoOpenAIErrorKind>([
  "TERMINAL_RESPONSE",
  "EVIDENCE_INVALID",
  "RETRIES_EXHAUSTED",
  "REQUEST_ERROR",
]);
const DISPOSITIONS = new Set<
  FinalDecisionMemoAttemptEvidence["request_disposition"]
>([
  "RESPONSE_RECEIVED",
  "RESPONSE_ERROR_RECEIVED",
  "SENT_OUTCOME_UNKNOWN",
  "NOT_SENT",
]);
const STATUSES = new Set<FinalDecisionMemoAttemptEvidence["status"]>([
  "COMPLETE",
  "INVALID_OUTPUT",
  "REFUSED",
  "INCOMPLETE",
  "FAILED",
  "TIMEOUT",
  "TRANSPORT_ERROR",
  "REQUEST_ERROR",
]);
const TOKEN_KEYS = new Set([
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
]);
const SAFE_RESPONSE_ID = /^resp_[A-Za-z0-9_-]{1,512}$/;
const SAFE_RESPONSE_STATUSES = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "queued",
  "in_progress",
]);
const CREDENTIAL_SHAPE = /sk-[A-Za-z0-9_-]{8,}/i;
const STORED_EVIDENCE_KEYS = new Set([
  "error_code",
  "evaluation_status",
  "kind",
  "classification",
  "attempts",
  "provider_response",
  "cost_completeness",
]);
const STORED_ATTEMPT_KEYS = new Set([
  "attempt_number",
  "request_disposition",
  "status",
  "retry_eligible",
  "response_id",
  "latency_ms",
  "usage",
  "usage_cost",
]);
const STORED_PROVIDER_KEYS = new Set([
  "evidence_present",
  "response_id",
  "response_status",
  "http_status",
  "incomplete_detected",
  "refusal_detected",
]);
const STORED_COST_KEYS = new Set([
  "status",
  "known_total_cost_usd",
  "unpriced_attempt_numbers",
]);

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function readUsage(value: unknown): TokenUsage | null | undefined {
  if (value === null) return null;
  if (
    !isPlainRecord(value)
    || Object.keys(value).some((key) => !TOKEN_KEYS.has(key))
    || !nonNegativeInteger(value.inputTokens)
    || !nonNegativeInteger(value.cachedInputTokens)
    || !nonNegativeInteger(value.cacheWriteTokens)
    || !nonNegativeInteger(value.outputTokens)
    || (
      value.reasoningTokens !== undefined
      && !nonNegativeInteger(value.reasoningTokens)
    )
    || (
      value.totalTokens !== undefined
      && !nonNegativeInteger(value.totalTokens)
    )
    || value.cachedInputTokens + value.cacheWriteTokens > value.inputTokens
  ) {
    return undefined;
  }
  return Object.freeze({
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    cacheWriteTokens: value.cacheWriteTokens,
    outputTokens: value.outputTokens,
    ...(value.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: value.reasoningTokens }),
    ...(value.totalTokens === undefined
      ? {}
      : { totalTokens: value.totalTokens }),
  });
}

function equalCanonical(left: unknown, right: unknown): boolean {
  try {
    return canonicalJsonStringify(left) === canonicalJsonStringify(right);
  } catch {
    return false;
  }
}

function safeResponseId(value: unknown): string | null {
  return typeof value === "string"
    && SAFE_RESPONSE_ID.test(value)
    && !CREDENTIAL_SHAPE.test(value)
    ? value
    : null;
}

function safeResponseStatus(value: unknown): string | null {
  return typeof value === "string" && SAFE_RESPONSE_STATUSES.has(value)
    ? value
    : null;
}

function readProviderHttpStatus(error: FinalDecisionMemoOpenAIError): number | null {
  const cause = error.cause;
  if (
    typeof cause === "object"
    && cause !== null
    && "status" in cause
    && typeof cause.status === "number"
    && Number.isInteger(cause.status)
    && cause.status >= 100
    && cause.status <= 599
  ) {
    return cause.status;
  }
  return null;
}

function classify({
  kind,
  attempts,
  providerHttpStatus,
}: {
  readonly kind: FinalDecisionMemoOpenAIErrorKind;
  readonly attempts: readonly SafeMutationFailureAttempt[];
  readonly providerHttpStatus: number | null;
}): MutationFailureClassification {
  if (
    kind === "EVIDENCE_INVALID"
    || kind === "RETRIES_EXHAUSTED"
    || attempts.some((attempt) => (
      attempt.status === "INCOMPLETE"
      || attempt.status === "INVALID_OUTPUT"
    ))
  ) {
    return "EVALUATION_INCOMPLETE";
  }
  if (kind === "TERMINAL_RESPONSE") {
    return attempts.some((attempt) => attempt.status === "INCOMPLETE")
      ? "EVALUATION_INCOMPLETE"
      : "PROVIDER_TERMINAL_FAILURE";
  }
  if (
    attempts.some((attempt) => (
      attempt.status === "TIMEOUT"
      || attempt.status === "TRANSPORT_ERROR"
    ))
    || providerHttpStatus === 408
    || providerHttpStatus === 409
    || providerHttpStatus === 429
    || (
      providerHttpStatus !== null
      && providerHttpStatus >= 500
      && providerHttpStatus <= 599
    )
  ) {
    return "PROVIDER_TEMPORARY_FAILURE";
  }
  return providerHttpStatus === null
    ? "EVALUATION_INCOMPLETE"
    : "PROVIDER_TERMINAL_FAILURE";
}

function readAttempt(
  value: FinalDecisionMemoAttemptEvidence,
  index: number,
): SafeMutationFailureAttempt | null {
  if (
    !isPlainRecord(value)
    || value.attempt_number !== index + 1
    || (value.attempt_number !== 1 && value.attempt_number !== 2)
    || !DISPOSITIONS.has(value.request_disposition)
    || !STATUSES.has(value.status)
    || typeof value.retry_eligible !== "boolean"
    || !Number.isSafeInteger(value.latency_ms)
    || value.latency_ms < 0
  ) {
    return null;
  }
  const usage = readUsage(value.usage);
  if (usage === undefined) return null;
  let usageCost: UsageCost | null;
  if (usage === null) {
    if (value.usage_cost !== null) return null;
    usageCost = null;
  } else {
    const calculated = calculateUsageCost(
      usage,
      FINAL_DECISION_MEMO_PRICING_SNAPSHOT,
    );
    if (calculated === null || !equalCanonical(value.usage_cost, calculated)) {
      return null;
    }
    usageCost = deepFreeze(structuredClone(calculated));
  }
  return deepFreeze({
    attempt_number: value.attempt_number,
    request_disposition: value.request_disposition,
    status: value.status,
    retry_eligible: value.retry_eligible,
    response_id: safeResponseId(value.response_id),
    latency_ms: value.latency_ms,
    usage,
    usage_cost: usageCost,
  });
}

function causalContractIsValid({
  kind,
  attempts,
  providerHttpStatus,
  providerResponseId,
  providerEvidencePresent,
  refusalDetected,
  incompleteDetected,
}: {
  readonly kind: FinalDecisionMemoOpenAIErrorKind;
  readonly attempts: readonly SafeMutationFailureAttempt[];
  readonly providerHttpStatus: number | null;
  readonly providerResponseId: string | null;
  readonly providerEvidencePresent: boolean;
  readonly refusalDetected: boolean;
  readonly incompleteDetected: boolean;
}): boolean {
  const last = attempts.at(-1)!;
  if (
    attempts.some((attempt, index) => (
      attempt.retry_eligible !== (index < attempts.length - 1)
      || (
        attempt.request_disposition === "RESPONSE_RECEIVED"
        && !new Set([
          "INVALID_OUTPUT",
          "REFUSED",
          "INCOMPLETE",
          "FAILED",
        ]).has(attempt.status)
      )
      || (
        attempt.request_disposition === "RESPONSE_ERROR_RECEIVED"
        && (
          attempt.status !== "REQUEST_ERROR"
          || attempt.response_id !== null
          || attempt.usage !== null
          || attempt.usage_cost !== null
        )
      )
      || (
        attempt.request_disposition === "SENT_OUTCOME_UNKNOWN"
        && (
          (attempt.status !== "TIMEOUT"
            && attempt.status !== "TRANSPORT_ERROR")
          || attempt.response_id !== null
          || attempt.usage !== null
          || attempt.usage_cost !== null
        )
      )
      || (
        attempt.request_disposition === "NOT_SENT"
        && (
          attempt.status !== "REQUEST_ERROR"
          || attempt.response_id !== null
          || attempt.latency_ms !== 0
          || attempt.usage !== null
          || attempt.usage_cost !== null
        )
      )
      || (
        index < attempts.length - 1
        && attempt.status !== "REQUEST_ERROR"
        && attempt.status !== "INVALID_OUTPUT"
      )
    ))
    || attempts.some((attempt) => attempt.status === "COMPLETE")
    || (
      providerHttpStatus !== null
      && (
        kind !== "REQUEST_ERROR"
        || last.status !== "REQUEST_ERROR"
        || last.request_disposition !== "RESPONSE_ERROR_RECEIVED"
      )
    )
    || (
      providerHttpStatus !== null
      && (
        providerHttpStatus === 408
        || providerHttpStatus === 409
        || providerHttpStatus === 429
        || providerHttpStatus >= 500
      )
      && attempts.length < 2
    )
  ) {
    return false;
  }

  if (
    kind === "TERMINAL_RESPONSE"
    && (
      !providerEvidencePresent
      || (
        last.status !== "REFUSED"
        && last.status !== "INCOMPLETE"
        && last.status !== "FAILED"
      )
    )
  ) {
    return false;
  }
  if (
    kind === "RETRIES_EXHAUSTED"
    && (
      attempts.length !== 2
      || attempts.some((attempt) => attempt.status !== "INVALID_OUTPUT")
      || !providerEvidencePresent
    )
  ) {
    return false;
  }
  if (
    kind === "EVIDENCE_INVALID"
    && last.status !== "FAILED"
  ) {
    return false;
  }
  if (
    kind === "REQUEST_ERROR"
    && (
      last.status !== "REQUEST_ERROR"
      && last.status !== "TIMEOUT"
      && last.status !== "TRANSPORT_ERROR"
      && last.status !== "FAILED"
    )
  ) {
    return false;
  }
  if (
    (last.status === "REFUSED" && !refusalDetected)
    || (last.status === "INCOMPLETE" && !incompleteDetected)
  ) {
    return false;
  }
  const lastResponseReceived = [...attempts]
    .reverse()
    .find((attempt) => attempt.request_disposition === "RESPONSE_RECEIVED");
  if (
    providerEvidencePresent
    && lastResponseReceived !== undefined
    && lastResponseReceived.response_id !== providerResponseId
  ) {
    return false;
  }
  return true;
}

/**
 * OpenAI adapter가 만든 typed failure만 제한된 증거 계약으로 축소합니다.
 * 원문 오류·refusal·incomplete message·output·headers는 저장하지 않습니다.
 */
export function buildMutationFailureEvidence(
  error: unknown,
): MutationFailureEvidence | null {
  if (
    !(error instanceof FinalDecisionMemoOpenAIError)
    || error.code !== "FINAL_DECISION_MEMO_OPENAI_ERROR"
    || error.evaluation_status !== "EVALUATION_INCOMPLETE"
    || !KINDS.has(error.kind)
    || !Array.isArray(error.attempts)
    || error.attempts.length < 1
    || error.attempts.length > 2
  ) {
    return null;
  }

  const attempts = error.attempts.map(readAttempt);
  if (attempts.some((attempt) => attempt === null)) return null;
  const safeAttempts = attempts as SafeMutationFailureAttempt[];
  const providerEvidence = error.provider_evidence;
  if (
    providerEvidence !== null
    && (
      !isPlainRecord(providerEvidence)
      || typeof providerEvidence.refusal_detected !== "boolean"
    )
  ) {
    return null;
  }
  const providerHttpStatus = readProviderHttpStatus(error);
  const providerResponseId = safeResponseId(providerEvidence?.response_id);
  const incompleteDetected =
    providerEvidence?.incomplete_reason !== null
    && providerEvidence?.incomplete_reason !== undefined;
  const refusalDetected = providerEvidence?.refusal_detected === true;
  if (!causalContractIsValid({
    kind: error.kind,
    attempts: safeAttempts,
    providerHttpStatus,
    providerResponseId,
    providerEvidencePresent: providerEvidence !== null,
    refusalDetected,
    incompleteDetected,
  })) {
    return null;
  }
  const unpricedAttemptNumbers = safeAttempts
    .filter((attempt) => (
      attempt.request_disposition !== "NOT_SENT"
      && attempt.usage_cost === null
    ))
    .map((attempt) => attempt.attempt_number);
  const knownTotalCostUsd = safeAttempts.reduce(
    (sum, attempt) => sum + (attempt.usage_cost?.totalCostUsd ?? 0),
    0,
  );
  if (!Number.isFinite(knownTotalCostUsd) || knownTotalCostUsd < 0) return null;

  return deepFreeze({
    error_code: "FINAL_DECISION_MEMO_OPENAI_ERROR",
    evaluation_status: "EVALUATION_INCOMPLETE",
    kind: error.kind,
    classification: classify({
      kind: error.kind,
      attempts: safeAttempts,
      providerHttpStatus,
    }),
    attempts: safeAttempts,
    provider_response: {
      evidence_present: providerEvidence !== null,
      response_id: providerResponseId,
      response_status: safeResponseStatus(providerEvidence?.response_status),
      http_status: providerHttpStatus,
      incomplete_detected: incompleteDetected,
      refusal_detected: refusalDetected,
    },
    cost_completeness: {
      status: unpricedAttemptNumbers.length === 0 ? "COMPLETE" : "INCOMPLETE",
      known_total_cost_usd: knownTotalCostUsd,
      unpriced_attempt_numbers: unpricedAttemptNumbers,
    },
  });
}

/**
 * Content-addressed receipt를 replay할 때 hash뿐 아니라 의미 계약도 다시
 * 계산합니다. 이 검사는 외부 원문을 복원하지 않고 저장이 허용된 필드만
 * 대상으로 수행됩니다.
 */
export function validateStoredMutationFailureEvidence(
  value: unknown,
): MutationFailureEvidence | null {
  if (
    !isPlainRecord(value)
    || Object.keys(value).length !== STORED_EVIDENCE_KEYS.size
    || Object.keys(value).some((key) => !STORED_EVIDENCE_KEYS.has(key))
    || value.error_code !== "FINAL_DECISION_MEMO_OPENAI_ERROR"
    || value.evaluation_status !== "EVALUATION_INCOMPLETE"
    || !KINDS.has(value.kind as FinalDecisionMemoOpenAIErrorKind)
    || (
      value.classification !== "PROVIDER_TEMPORARY_FAILURE"
      && value.classification !== "PROVIDER_TERMINAL_FAILURE"
      && value.classification !== "EVALUATION_INCOMPLETE"
    )
    || !Array.isArray(value.attempts)
    || value.attempts.length < 1
    || value.attempts.length > 2
    || !isPlainRecord(value.provider_response)
    || Object.keys(value.provider_response).length !== STORED_PROVIDER_KEYS.size
    || Object.keys(value.provider_response)
      .some((key) => !STORED_PROVIDER_KEYS.has(key))
    || !isPlainRecord(value.cost_completeness)
    || Object.keys(value.cost_completeness).length !== STORED_COST_KEYS.size
    || Object.keys(value.cost_completeness)
      .some((key) => !STORED_COST_KEYS.has(key))
  ) {
    return null;
  }

  const attempts = value.attempts.map((attempt, index) => {
    if (
      !isPlainRecord(attempt)
      || Object.keys(attempt).length !== STORED_ATTEMPT_KEYS.size
      || Object.keys(attempt).some((key) => !STORED_ATTEMPT_KEYS.has(key))
    ) {
      return null;
    }
    return readAttempt(
      attempt as unknown as FinalDecisionMemoAttemptEvidence,
      index,
    );
  });
  if (attempts.some((attempt) => attempt === null)) return null;
  const safeAttempts = attempts as SafeMutationFailureAttempt[];
  const provider = value.provider_response;
  if (
    typeof provider.evidence_present !== "boolean"
    || (
      provider.response_id !== null
      && (
        typeof provider.response_id !== "string"
        || safeResponseId(provider.response_id) !== provider.response_id
      )
    )
    || (
      provider.response_status !== null
      && (
        typeof provider.response_status !== "string"
        || safeResponseStatus(provider.response_status)
          !== provider.response_status
      )
    )
    || (
      provider.http_status !== null
      && (
        typeof provider.http_status !== "number"
        || !Number.isInteger(provider.http_status)
        || provider.http_status < 100
        || provider.http_status > 599
      )
    )
    || typeof provider.incomplete_detected !== "boolean"
    || typeof provider.refusal_detected !== "boolean"
  ) {
    return null;
  }
  const expectedClassification = classify({
    kind: value.kind as FinalDecisionMemoOpenAIErrorKind,
    attempts: safeAttempts,
    providerHttpStatus: provider.http_status as number | null,
  });
  if (
    value.classification !== expectedClassification
    || !causalContractIsValid({
      kind: value.kind as FinalDecisionMemoOpenAIErrorKind,
      attempts: safeAttempts,
      providerHttpStatus: provider.http_status as number | null,
      providerResponseId: provider.response_id as string | null,
      providerEvidencePresent: provider.evidence_present,
      refusalDetected: provider.refusal_detected as boolean,
      incompleteDetected: provider.incomplete_detected as boolean,
    })
  ) return null;

  const expectedUnpriced = safeAttempts
    .filter((attempt) => (
      attempt.request_disposition !== "NOT_SENT"
      && attempt.usage_cost === null
    ))
    .map((attempt) => attempt.attempt_number);
  const expectedKnownCost = safeAttempts.reduce(
    (sum, attempt) => sum + (attempt.usage_cost?.totalCostUsd ?? 0),
    0,
  );
  const cost = value.cost_completeness;
  if (
    cost.status !== (
      expectedUnpriced.length === 0 ? "COMPLETE" : "INCOMPLETE"
    )
    || cost.known_total_cost_usd !== expectedKnownCost
    || !Array.isArray(cost.unpriced_attempt_numbers)
    || !equalCanonical(cost.unpriced_attempt_numbers, expectedUnpriced)
  ) {
    return null;
  }
  return deepFreeze(structuredClone(value)) as unknown as MutationFailureEvidence;
}

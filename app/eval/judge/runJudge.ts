import {
  calculateUsageCost,
  type PricingSnapshot,
  type TokenUsage,
  type UsageCost,
} from "../runtime/pricing";
import { canonicalJsonStringify, sha256CanonicalJson } from "../runtime/canonicalJson";
import { redactSensitiveText } from "../cli/calibrationOutcome";
import { throwIfAborted } from "../runner/types";
import {
  assertAuthoritativeBlindingPrecommitCaseBinding,
  type AuthoritativeBlindingPrecommit,
  type AuthoritativeBlindingPrecommitCaseBinding,
} from "../review/judgeEvidencePrecommitPersistence";
import { buildBlindJudgeValidationContext, type BlindJudgeInput } from "./buildJudgeInput";
import {
  parseBlindJudgeResult,
  type BlindJudgeResult,
} from "./contracts";
import {
  JudgeInvocationError,
  OPENAI_JUDGE_MODEL_REPORTED_POLICY,
  OPENAI_JUDGE_REQUEST_CONTRACT,
  OPENAI_JUDGE_RESPONSE_FORMAT,
  OPENAI_JUDGE_MODEL_REQUESTED_ID,
  OPENAI_JUDGE_SERVICE_TIER_REQUESTED,
  type JudgeAdapter,
  type JudgeAdapterResult,
} from "./openaiJudgeAdapter";

export const JUDGE_MODEL_REQUESTED_ID = OPENAI_JUDGE_MODEL_REQUESTED_ID;
export const DEFAULT_JUDGE_TIMEOUT_MS =
  OPENAI_JUDGE_REQUEST_CONTRACT.totalTimeoutMs;
export const MAX_JUDGE_ATTEMPTS = 2;

export const JUDGE_LONG_CONTEXT_POLICY = Object.freeze({
  thresholdInputTokens: 272_000,
  comparison: "GREATER_THAN" as const,
  disposition: "COST_INCOMPLETE" as const,
  reason: "Short-context 가격표로 계산하지 않고 평가 승격을 차단합니다.",
});

export const JUDGE_PRICING_SNAPSHOT: PricingSnapshot & {
  long_context_policy: typeof JUDGE_LONG_CONTEXT_POLICY;
} = Object.freeze({
  pricing_snapshot_id: "openai-gpt-5.6-sol-standard-2026-07-17",
  pricing_as_of: "2026-07-17",
  provider: "OpenAI",
  model: OPENAI_JUDGE_MODEL_REQUESTED_ID,
  service_tier: "standard",
  currency: "USD",
  unit_tokens: 1_000_000,
  rates_per_unit: Object.freeze({
    input: 5,
    cached_input: 0.5,
    cache_write: 6.25,
    output: 30,
  }),
  source_url: "https://developers.openai.com/api/docs/pricing",
  source_retrieved_at: "2026-07-17",
  notes: "Locked Standard short-context price lookup for the auxiliary Judge. Pricing lookup date is not an official effective date.",
  long_context_policy: JUDGE_LONG_CONTEXT_POLICY,
});

export type JudgeAttemptStatus =
  | "COMPLETE"
  | "INVALID_OUTPUT"
  | "REFUSED"
  | "INCOMPLETE"
  | "FAILED"
  | "TIMEOUT"
  | "TRANSPORT_ERROR"
  | "REQUEST_ERROR"
  | "ABORTED"
  | "EVIDENCE_INVALID";

export type JudgeRequestDisposition =
  | "RESPONSE_RECEIVED"
  | "RESPONSE_ERROR_RECEIVED"
  | "SENT_OUTCOME_UNKNOWN"
  | "NOT_SENT";

export interface JudgeAttemptRecord {
  attemptNumber: 1 | 2;
  status: JudgeAttemptStatus;
  retryEligible: boolean;
  startedAt: string;
  latencyMs: number;
  requestDisposition: JudgeRequestDisposition;
  responseId: string | null;
  responseStatusCode: number | null;
  modelRequestedId: typeof OPENAI_JUDGE_MODEL_REQUESTED_ID;
  modelReportedId: string | null;
  serviceTierRequested: typeof OPENAI_JUDGE_SERVICE_TIER_REQUESTED;
  serviceTierReported: string | null;
  usage: TokenUsage | null;
  usageCost: UsageCost | null;
  costState: "COMPLETE" | "COST_INCOMPLETE";
  error: string | null;
}

export interface BlindJudgeRunRecord {
  schemaVersion: "blind-judge-run-v2";
  caseId: string;
  authority: "RISK_ONLY_REVIEW_REQUIRED";
  identity: {
    judgeInputHash: string;
    executionPackHash: string;
    precommitManifestDigest: string;
    precommitManifestHash: string;
    precommitCaseBindingHash: string;
    requestContractHash: string;
    outputSchemaHash: string;
    pricingSnapshotHash: string;
  };
  judgeStatus: "JUDGE_COMPLETE" | "JUDGE_INCOMPLETE";
  result: BlindJudgeResult | null;
  attempts: JudgeAttemptRecord[];
  totalLatencyMs: number;
  usageCost: UsageCost | null;
  costState: "COMPLETE" | "COST_INCOMPLETE";
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function readPlainRecord(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${location}은(는) plain 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${location}은(는) plain 객체여야 합니다.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  location: string,
): void {
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(record, key));
  const additional = Object.keys(record).filter((key) => !expected.has(key));
  if (missing.length > 0 || additional.length > 0) {
    throw new TypeError(
      `${location} 필드가 잠긴 계약과 다릅니다. missing=${missing.join(",")} additional=${additional.join(",")}`,
    );
  }
}

function buildBlindJudgeRunIdentity(
  input: BlindJudgeInput,
  precommitBinding: AuthoritativeBlindingPrecommitCaseBinding,
): BlindJudgeRunRecord["identity"] {
  return {
    judgeInputHash: sha256CanonicalJson(input),
    executionPackHash: precommitBinding.executionPackHash,
    precommitManifestDigest: precommitBinding.precommitManifestDigest,
    precommitManifestHash: precommitBinding.precommitManifestHash,
    precommitCaseBindingHash: precommitBinding.precommitCaseBindingHash,
    requestContractHash: sha256CanonicalJson(OPENAI_JUDGE_REQUEST_CONTRACT),
    outputSchemaHash: sha256CanonicalJson(OPENAI_JUDGE_RESPONSE_FORMAT.schema),
    pricingSnapshotHash: sha256CanonicalJson(JUDGE_PRICING_SNAPSHOT),
  };
}

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "caseId",
  "authority",
  "identity",
  "judgeStatus",
  "result",
  "attempts",
  "totalLatencyMs",
  "usageCost",
  "costState",
] as const;

const ATTEMPT_KEYS = [
  "attemptNumber",
  "status",
  "retryEligible",
  "startedAt",
  "latencyMs",
  "requestDisposition",
  "responseId",
  "responseStatusCode",
  "modelRequestedId",
  "modelReportedId",
  "serviceTierRequested",
  "serviceTierReported",
  "usage",
  "usageCost",
  "costState",
  "error",
] as const;

const ATTEMPT_STATUSES: readonly JudgeAttemptStatus[] = [
  "COMPLETE",
  "INVALID_OUTPUT",
  "REFUSED",
  "INCOMPLETE",
  "FAILED",
  "TIMEOUT",
  "TRANSPORT_ERROR",
  "REQUEST_ERROR",
  "ABORTED",
  "EVIDENCE_INVALID",
];

const REQUEST_DISPOSITIONS: readonly JudgeRequestDisposition[] = [
  "RESPONSE_RECEIVED",
  "RESPONSE_ERROR_RECEIVED",
  "SENT_OUTCOME_UNKNOWN",
  "NOT_SENT",
];

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  location: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TypeError(`${location}에 허용하지 않은 값이 있습니다.`);
  }
  return value as T;
}

function readNullableString(value: unknown, location: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${location}은(는) 문자열 또는 null이어야 합니다.`);
  }
  return value;
}

function readNonNegativeNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${location}은(는) 0 이상의 유한한 숫자여야 합니다.`);
  }
  return value;
}

function readNonNegativeSafeInteger(value: unknown, location: string): number {
  const parsed = readNonNegativeNumber(value, location);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${location}은(는) 0 이상의 안전한 정수여야 합니다.`);
  }
  return parsed;
}

function readNullableStatusCode(value: unknown, location: string): number | null {
  if (value === null) return null;
  const parsed = readNonNegativeSafeInteger(value, location);
  if (parsed < 100 || parsed > 599) {
    throw new TypeError(`${location}은(는) 100부터 599 사이여야 합니다.`);
  }
  return parsed;
}

function isRetryableHttpStatusCode(statusCode: number): boolean {
  return statusCode === 408
    || statusCode === 409
    || statusCode === 429
    || statusCode >= 500;
}

function readIsoTimestamp(value: unknown, location: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${location}은(는) ISO timestamp 문자열이어야 합니다.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${location}은(는) 정규 ISO timestamp여야 합니다.`);
  }
  return value;
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  location: string,
): void {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const missing = requiredKeys.filter((key) => !Object.hasOwn(record, key));
  const additional = Object.keys(record).filter((key) => !allowed.has(key));
  if (missing.length > 0 || additional.length > 0) {
    throw new TypeError(
      `${location} 필드가 잠긴 계약과 다릅니다. missing=${missing.join(",")} additional=${additional.join(",")}`,
    );
  }
}

function parseTokenUsage(value: unknown, location: string): TokenUsage {
  const record = readPlainRecord(value, location);
  const requiredKeys = [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "outputTokens",
  ] as const;
  const optionalKeys = ["reasoningTokens", "totalTokens"] as const;
  assertAllowedKeys(record, requiredKeys, optionalKeys, location);
  const inputTokens = readNonNegativeSafeInteger(record.inputTokens, `${location}.inputTokens`);
  const cachedInputTokens = readNonNegativeSafeInteger(
    record.cachedInputTokens,
    `${location}.cachedInputTokens`,
  );
  const cacheWriteTokens = readNonNegativeSafeInteger(
    record.cacheWriteTokens,
    `${location}.cacheWriteTokens`,
  );
  const outputTokens = readNonNegativeSafeInteger(record.outputTokens, `${location}.outputTokens`);
  if (cachedInputTokens + cacheWriteTokens > inputTokens) {
    throw new TypeError(`${location}의 cached·cache-write 합계가 input usage보다 큽니다.`);
  }
  const parsed: TokenUsage = {
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
  };
  if (Object.hasOwn(record, "reasoningTokens")) {
    parsed.reasoningTokens = readNonNegativeSafeInteger(
      record.reasoningTokens,
      `${location}.reasoningTokens`,
    );
  }
  if (Object.hasOwn(record, "totalTokens")) {
    parsed.totalTokens = readNonNegativeSafeInteger(record.totalTokens, `${location}.totalTokens`);
    if (parsed.totalTokens !== inputTokens + outputTokens) {
      throw new TypeError(`${location}.totalTokens가 input+output usage와 일치하지 않습니다.`);
    }
  }
  return parsed;
}

function parseUsageCostShape(value: unknown, location: string): UsageCost {
  const record = readPlainRecord(value, location);
  assertExactKeys(record, [
    "pricingSnapshotId",
    "pricingAsOf",
    "model",
    "serviceTier",
    "currency",
    "tokenBreakdown",
    "costBreakdownUsd",
    "totalCostUsd",
  ], location);
  const readString = (item: unknown, field: string): string => {
    if (typeof item !== "string" || item.length === 0) {
      throw new TypeError(`${field}은(는) 비어 있지 않은 문자열이어야 합니다.`);
    }
    return item;
  };
  const tokenBreakdownRecord = readPlainRecord(
    record.tokenBreakdown,
    `${location}.tokenBreakdown`,
  );
  assertExactKeys(tokenBreakdownRecord, [
    "regularInputTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "outputTokens",
  ], `${location}.tokenBreakdown`);
  const costBreakdownRecord = readPlainRecord(
    record.costBreakdownUsd,
    `${location}.costBreakdownUsd`,
  );
  assertExactKeys(costBreakdownRecord, [
    "regularInput",
    "cachedInput",
    "cacheWrite",
    "output",
  ], `${location}.costBreakdownUsd`);
  return {
    pricingSnapshotId: readString(record.pricingSnapshotId, `${location}.pricingSnapshotId`),
    pricingAsOf: readString(record.pricingAsOf, `${location}.pricingAsOf`),
    model: readString(record.model, `${location}.model`),
    serviceTier: readString(record.serviceTier, `${location}.serviceTier`),
    currency: readString(record.currency, `${location}.currency`),
    tokenBreakdown: {
      regularInputTokens: readNonNegativeSafeInteger(
        tokenBreakdownRecord.regularInputTokens,
        `${location}.tokenBreakdown.regularInputTokens`,
      ),
      cachedInputTokens: readNonNegativeSafeInteger(
        tokenBreakdownRecord.cachedInputTokens,
        `${location}.tokenBreakdown.cachedInputTokens`,
      ),
      cacheWriteTokens: readNonNegativeSafeInteger(
        tokenBreakdownRecord.cacheWriteTokens,
        `${location}.tokenBreakdown.cacheWriteTokens`,
      ),
      outputTokens: readNonNegativeSafeInteger(
        tokenBreakdownRecord.outputTokens,
        `${location}.tokenBreakdown.outputTokens`,
      ),
    },
    costBreakdownUsd: {
      regularInput: readNonNegativeNumber(
        costBreakdownRecord.regularInput,
        `${location}.costBreakdownUsd.regularInput`,
      ),
      cachedInput: readNonNegativeNumber(
        costBreakdownRecord.cachedInput,
        `${location}.costBreakdownUsd.cachedInput`,
      ),
      cacheWrite: readNonNegativeNumber(
        costBreakdownRecord.cacheWrite,
        `${location}.costBreakdownUsd.cacheWrite`,
      ),
      output: readNonNegativeNumber(
        costBreakdownRecord.output,
        `${location}.costBreakdownUsd.output`,
      ),
    },
    totalCostUsd: readNonNegativeNumber(record.totalCostUsd, `${location}.totalCostUsd`),
  };
}

function assertCanonicalEqual(actual: unknown, expected: unknown, location: string): void {
  if (canonicalJsonStringify(actual) !== canonicalJsonStringify(expected)) {
    throw new TypeError(`${location} 재계산 결과가 잠긴 증거와 일치하지 않습니다.`);
  }
}

function assertSafeArtifactError(value: string | null, location: string): void {
  if (value !== null && redactSensitiveText(value) !== value) {
    throw new TypeError(`${location}에 마스킹되지 않은 key 형태 비밀정보가 있습니다.`);
  }
}

function parseAttemptRecord(
  value: unknown,
  expectedAttemptNumber: 1 | 2,
  location: string,
): JudgeAttemptRecord {
  const record = readPlainRecord(value, location);
  assertExactKeys(record, ATTEMPT_KEYS, location);
  if (record.attemptNumber !== expectedAttemptNumber) {
    throw new TypeError(`${location}.attemptNumber가 잠긴 순서와 일치하지 않습니다.`);
  }
  const status = readEnum(record.status, ATTEMPT_STATUSES, `${location}.status`);
  if (typeof record.retryEligible !== "boolean") {
    throw new TypeError(`${location}.retryEligible은(는) boolean이어야 합니다.`);
  }
  const retryEligible = record.retryEligible;
  const requestDisposition = readEnum(
    record.requestDisposition,
    REQUEST_DISPOSITIONS,
    `${location}.requestDisposition`,
  );
  const responseId = readNullableString(record.responseId, `${location}.responseId`);
  const responseStatusCode = readNullableStatusCode(
    record.responseStatusCode,
    `${location}.responseStatusCode`,
  );
  const modelReportedId = readNullableString(
    record.modelReportedId,
    `${location}.modelReportedId`,
  );
  const serviceTierReported = readNullableString(
    record.serviceTierReported,
    `${location}.serviceTierReported`,
  );
  const error = readNullableString(record.error, `${location}.error`);
  assertSafeArtifactError(error, `${location}.error`);
  if (record.modelRequestedId !== OPENAI_JUDGE_MODEL_REQUESTED_ID) {
    throw new TypeError(`${location}.modelRequestedId가 잠긴 요청 계약과 일치하지 않습니다.`);
  }
  if (record.serviceTierRequested !== OPENAI_JUDGE_SERVICE_TIER_REQUESTED) {
    throw new TypeError(`${location}.serviceTierRequested가 잠긴 요청 계약과 일치하지 않습니다.`);
  }

  const usage = record.usage === null
    ? null
    : parseTokenUsage(record.usage, `${location}.usage`);
  const costState = readEnum(
    record.costState,
    ["COMPLETE", "COST_INCOMPLETE"] as const,
    `${location}.costState`,
  );
  const usageCost = record.usageCost === null
    ? null
    : parseUsageCostShape(record.usageCost, `${location}.usageCost`);
  const expectedCost = calculateAttemptCost(
    usage,
    modelReportedId,
    serviceTierReported,
  );
  if (costState === "COMPLETE") {
    if (usage === null) {
      if (requestDisposition !== "NOT_SENT" || usageCost !== null) {
        throw new TypeError(`${location}의 COMPLETE 비용에는 usage 또는 NOT_SENT 증거가 필요합니다.`);
      }
    } else {
      if (expectedCost.costState !== "COMPLETE" || usageCost === null) {
        throw new TypeError(`${location}.usageCost가 COMPLETE usage와 일치하지 않습니다.`);
      }
      assertCanonicalEqual(usageCost, expectedCost.usageCost, `${location}.usageCost`);
    }
  } else {
    if (usageCost !== null) {
      throw new TypeError(`${location}.COST_INCOMPLETE에는 usageCost를 기록할 수 없습니다.`);
    }
    if (expectedCost.costState !== "COST_INCOMPLETE") {
      throw new TypeError(`${location}.costState가 재계산한 usage 비용 상태와 일치하지 않습니다.`);
    }
  }

  if (status === "COMPLETE") {
    if (
      requestDisposition !== "RESPONSE_RECEIVED"
      || responseStatusCode !== 200
      || responseId === null
      || responseId.trim().length === 0
      || !isAllowedReportedModel(modelReportedId)
      || serviceTierReported !== OPENAI_JUDGE_SERVICE_TIER_REQUESTED
      || usage === null
      || costState !== "COMPLETE"
      || error !== null
    ) {
      throw new TypeError(`${location} COMPLETE 응답 증거 불변식이 일치하지 않습니다.`);
    }
  } else if (error === null || error.length === 0) {
    throw new TypeError(`${location}의 비완료 상태에는 오류 근거가 필요합니다.`);
  }
  const statusCanBeRetried = [
    "INVALID_OUTPUT",
    "TIMEOUT",
    "TRANSPORT_ERROR",
    "REQUEST_ERROR",
  ].includes(status);
  if (retryEligible && !statusCanBeRetried) {
    throw new TypeError(`${location}.retryEligible이 status 재시도 정책과 일치하지 않습니다.`);
  }
  if (
    expectedAttemptNumber === 1
    && status === "INVALID_OUTPUT"
    && !retryEligible
  ) {
    throw new TypeError(`${location} INVALID_OUTPUT은 잠긴 1회 재시도 대상으로 기록돼야 합니다.`);
  }
  if (
    expectedAttemptNumber === 1
    && (
      status === "TRANSPORT_ERROR"
      || status === "TIMEOUT" && requestDisposition !== "NOT_SENT"
    )
    && !retryEligible
  ) {
    throw new TypeError(
      `${location} ${status}는 adapter flag와 무관한 잠긴 1회 재시도 대상으로 기록돼야 합니다.`,
    );
  }
  if (expectedAttemptNumber === MAX_JUDGE_ATTEMPTS && retryEligible) {
    throw new TypeError(`${location} 마지막 attempt는 추가 재시도를 예약할 수 없습니다.`);
  }

  if (status !== "EVIDENCE_INVALID" && requestDisposition === "RESPONSE_RECEIVED") {
    if (
      responseStatusCode !== 200
      || responseId === null
      || responseId.trim().length === 0
      || !isAllowedReportedModel(modelReportedId)
      || serviceTierReported !== OPENAI_JUDGE_SERVICE_TIER_REQUESTED
    ) {
      throw new TypeError(`${location}의 수신 응답 metadata 증거가 잠긴 계약과 일치하지 않습니다.`);
    }
  }
  if (requestDisposition === "RESPONSE_ERROR_RECEIVED") {
    const mappingEvidence = status === "EVIDENCE_INVALID" && responseStatusCode === 200;
    const httpErrorEvidence = responseStatusCode !== null
      && responseStatusCode >= 400
      && responseStatusCode <= 599;
    if (!mappingEvidence && !httpErrorEvidence) {
      throw new TypeError(`${location}의 response-error status 증거가 유효하지 않습니다.`);
    }
  }
  if (
    (requestDisposition === "SENT_OUTCOME_UNKNOWN" || requestDisposition === "NOT_SENT")
    && responseStatusCode !== null
  ) {
    throw new TypeError(`${location}의 outcome 불명·미전송 상태에는 HTTP status를 기록할 수 없습니다.`);
  }
  if (status === "TRANSPORT_ERROR" && requestDisposition !== "SENT_OUTCOME_UNKNOWN") {
    throw new TypeError(`${location} TRANSPORT_ERROR disposition이 일치하지 않습니다.`);
  }
  if (
    status === "REQUEST_ERROR"
    && requestDisposition !== "RESPONSE_ERROR_RECEIVED"
    && requestDisposition !== "NOT_SENT"
  ) {
    throw new TypeError(`${location} REQUEST_ERROR disposition이 일치하지 않습니다.`);
  }
  if (status === "REQUEST_ERROR") {
    const retryAllowedByEvidence = requestDisposition === "RESPONSE_ERROR_RECEIVED"
      && responseStatusCode !== null
      && isRetryableHttpStatusCode(responseStatusCode);
    const expectedRetryEligible = expectedAttemptNumber < MAX_JUDGE_ATTEMPTS
      && retryAllowedByEvidence;
    if (retryEligible !== expectedRetryEligible) {
      throw new TypeError(
        `${location}.retryEligible이 HTTP ${responseStatusCode ?? "NONE"} 재시도 정책과 일치하지 않습니다.`,
      );
    }
  }
  if (
    ["INVALID_OUTPUT", "REFUSED", "INCOMPLETE", "FAILED"].includes(status)
    && requestDisposition !== "RESPONSE_RECEIVED"
  ) {
    throw new TypeError(`${location} ${status} disposition이 일치하지 않습니다.`);
  }

  return {
    attemptNumber: expectedAttemptNumber,
    status,
    retryEligible,
    startedAt: readIsoTimestamp(record.startedAt, `${location}.startedAt`),
    latencyMs: readNonNegativeNumber(record.latencyMs, `${location}.latencyMs`),
    requestDisposition,
    responseId,
    responseStatusCode,
    modelRequestedId: OPENAI_JUDGE_MODEL_REQUESTED_ID,
    modelReportedId,
    serviceTierRequested: OPENAI_JUDGE_SERVICE_TIER_REQUESTED,
    serviceTierReported,
    usage,
    usageCost,
    costState,
    error,
  };
}

/** 상위 평가팩이 전체 실행 증거·관계·비용을 재검산하는 유일한 승격 parser입니다. */
export function parseBlindJudgeRunRecord(
  input: unknown,
  expectedJudgeInput: BlindJudgeInput,
  authoritativeBlindingPrecommit: AuthoritativeBlindingPrecommit,
): BlindJudgeRunRecord {
  const record = readPlainRecord(input, "Blind Judge run");
  assertExactKeys(record, TOP_LEVEL_KEYS, "Blind Judge run");
  if (record.schemaVersion !== "blind-judge-run-v2") {
    throw new TypeError("Blind Judge run schema version이 다릅니다.");
  }
  if (record.caseId !== expectedJudgeInput.case_id) {
    throw new TypeError("Blind Judge run case와 expected Judge input case가 다릅니다.");
  }
  if (record.authority !== "RISK_ONLY_REVIEW_REQUIRED") {
    throw new TypeError("Blind Judge run authority가 risk-only 계약과 다릅니다.");
  }

  const identityRecord = readPlainRecord(record.identity, "Blind Judge run identity");
  const identityKeys = [
    "judgeInputHash",
    "executionPackHash",
    "precommitManifestDigest",
    "precommitManifestHash",
    "precommitCaseBindingHash",
    "requestContractHash",
    "outputSchemaHash",
    "pricingSnapshotHash",
  ] as const;
  assertExactKeys(identityRecord, identityKeys, "Blind Judge run identity");
  const precommitBinding = assertAuthoritativeBlindingPrecommitCaseBinding({
    anchor: authoritativeBlindingPrecommit,
    expectedCaseId: expectedJudgeInput.case_id,
    expectedJudgeInputHash: sha256CanonicalJson(expectedJudgeInput),
  });
  const expectedIdentity = buildBlindJudgeRunIdentity(
    expectedJudgeInput,
    precommitBinding,
  );
  const identity = {} as BlindJudgeRunRecord["identity"];
  for (const key of identityKeys) {
    const value = identityRecord[key];
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
      throw new TypeError(`Blind Judge run identity ${key} hash 형식이 다릅니다.`);
    }
    if (value !== expectedIdentity[key]) {
      throw new TypeError(`Blind Judge run identity ${key} hash 무결성이 일치하지 않습니다.`);
    }
    identity[key] = value;
  }

  if (!Array.isArray(record.attempts) || record.attempts.length < 1 || record.attempts.length > 2) {
    throw new TypeError("Blind Judge run attempts에는 한 번 또는 두 번의 attempt가 필요합니다.");
  }
  const attempts = record.attempts.map((attempt, index) => parseAttemptRecord(
    attempt,
    (index + 1) as 1 | 2,
    `Blind Judge run.attempts[${index}]`,
  ));
  if (attempts.length === 2 && !attempts[0]?.retryEligible) {
    throw new TypeError("Blind Judge run의 두 번째 attempt는 첫 attempt가 retry eligible일 때만 허용합니다.");
  }
  if (attempts.length === 1 && attempts[0]?.retryEligible) {
    throw new TypeError("Blind Judge run의 retry eligible 첫 attempt 뒤에는 두 번째 attempt 증거가 필요합니다.");
  }
  const totalLatencyMs = readNonNegativeNumber(
    record.totalLatencyMs,
    "Blind Judge run.totalLatencyMs",
  );
  const expectedLatencyMs = attempts.reduce((total, attempt) => total + attempt.latencyMs, 0);
  if (totalLatencyMs !== expectedLatencyMs) {
    throw new TypeError("Blind Judge run total latency가 attempt 합계와 일치하지 않습니다.");
  }

  const judgeStatus = readEnum(
    record.judgeStatus,
    ["JUDGE_COMPLETE", "JUDGE_INCOMPLETE"] as const,
    "Blind Judge run.judgeStatus",
  );
  const validationContext = buildBlindJudgeValidationContext(expectedJudgeInput);
  let result: BlindJudgeResult | null = null;
  const completeAttempts = attempts.filter((attempt) => attempt.status === "COMPLETE");
  if (judgeStatus === "JUDGE_COMPLETE") {
    if (
      record.result === null
      || completeAttempts.length !== 1
      || attempts.at(-1)?.status !== "COMPLETE"
    ) {
      throw new TypeError("Blind Judge run COMPLETE status/result/terminal attempt 관계가 일치하지 않습니다.");
    }
    result = parseBlindJudgeResult(record.result, validationContext);
  } else if (record.result !== null || completeAttempts.length > 0) {
    throw new TypeError("Blind Judge run INCOMPLETE status에는 result 또는 COMPLETE attempt가 있을 수 없습니다.");
  }

  const expectedAggregateCost = buildAggregateCost(attempts);
  const costState = readEnum(
    record.costState,
    ["COMPLETE", "COST_INCOMPLETE"] as const,
    "Blind Judge run.costState",
  );
  const usageCost = record.usageCost === null
    ? null
    : parseUsageCostShape(record.usageCost, "Blind Judge run.usageCost");
  if (costState !== expectedAggregateCost.costState) {
    throw new TypeError("Blind Judge run aggregate cost state가 attempt 증거와 일치하지 않습니다.");
  }
  assertCanonicalEqual(usageCost, expectedAggregateCost.usageCost, "Blind Judge run aggregate cost");

  return deepFreeze({
    schemaVersion: "blind-judge-run-v2",
    caseId: expectedJudgeInput.case_id,
    authority: "RISK_ONLY_REVIEW_REQUIRED",
    identity,
    judgeStatus,
    result,
    attempts,
    totalLatencyMs,
    usageCost,
    costState,
  });
}

/** 호환 export도 identity만 보지 않고 전체 실행 계약 parser를 호출합니다. */
export function validateBlindJudgeRunIdentity(
  input: unknown,
  expectedJudgeInput: BlindJudgeInput,
  authoritativeBlindingPrecommit: AuthoritativeBlindingPrecommit,
): BlindJudgeRunRecord {
  return parseBlindJudgeRunRecord(
    input,
    expectedJudgeInput,
    authoritativeBlindingPrecommit,
  );
}

export interface RunBlindJudgeOptions {
  adapter: JudgeAdapter;
  input: BlindJudgeInput;
  authoritativeBlindingPrecommit: AuthoritativeBlindingPrecommit;
  timeoutMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}

interface AttemptCostResult {
  usageCost: UsageCost | null;
  costState: "COMPLETE" | "COST_INCOMPLETE";
  error: string | null;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "알 수 없는 Judge 실행 오류";
  return redactSensitiveText(message);
}

function normalizeUsageEvidence(
  value: TokenUsage | null,
): { usage: TokenUsage | null; error: string | null } {
  if (value === null) return { usage: null, error: null };
  try {
    return {
      usage: parseTokenUsage(structuredClone(value), "Judge adapter usage"),
      error: null,
    };
  } catch (error) {
    return {
      usage: null,
      error: `Judge usage mapping 증거가 유효하지 않습니다: ${safeErrorMessage(error)}`,
    };
  }
}

function isAllowedReportedModel(value: string | null): value is string {
  return value !== null
    && (OPENAI_JUDGE_MODEL_REPORTED_POLICY.allowedModels as readonly string[]).includes(value);
}

function hasLockedPricingIdentity(
  modelReportedId: string | null,
  serviceTierReported: string | null,
): boolean {
  return isAllowedReportedModel(modelReportedId)
    && serviceTierReported === OPENAI_JUDGE_SERVICE_TIER_REQUESTED;
}

function validateResponseEvidence(response: JudgeAdapterResult): string | null {
  if (response.responseStatusCode !== 200) {
    return "Judge 성공 응답의 HTTP status 증거는 200이어야 합니다.";
  }
  if (response.responseId === null || response.responseId.trim().length === 0) {
    return "Judge 응답에는 비어 있지 않은 response ID 증거가 필요합니다.";
  }
  if (!isAllowedReportedModel(response.modelReportedId)) {
    return "Judge 응답 모델이 잠긴 기본 모델 또는 날짜 snapshot 정책과 일치하지 않습니다.";
  }
  if (response.serviceTierReported !== OPENAI_JUDGE_SERVICE_TIER_REQUESTED) {
    return "Judge 응답 service tier가 잠긴 요청·가격 가정과 일치하지 않습니다.";
  }
  if (response.status === "completed" && response.error !== null) {
    return "completed Judge 응답에는 error 증거가 함께 있을 수 없습니다.";
  }
  if (response.status === "completed" && response.usage === null) {
    return "completed Judge 응답에는 비용을 재검산할 usage 증거가 필요합니다.";
  }
  return null;
}

function calculateAttemptCost(
  usage: TokenUsage | null,
  modelReportedId: string | null,
  serviceTierReported: string | null,
): AttemptCostResult {
  if (usage === null) {
    return { usageCost: null, costState: "COST_INCOMPLETE", error: null };
  }
  if (!hasLockedPricingIdentity(modelReportedId, serviceTierReported)) {
    return {
      usageCost: null,
      costState: "COST_INCOMPLETE",
      error: "Judge reported model/service tier가 잠긴 Standard 가격 적용 조건과 일치하지 않습니다.",
    };
  }
  if (usage.inputTokens > JUDGE_LONG_CONTEXT_POLICY.thresholdInputTokens) {
    return {
      usageCost: null,
      costState: "COST_INCOMPLETE",
      error: `Judge input ${usage.inputTokens} tokens는 ${JUDGE_LONG_CONTEXT_POLICY.thresholdInputTokens} long-context 가격 경계를 초과해 잠긴 short-context 가격으로 계산할 수 없습니다.`,
    };
  }
  try {
    const usageCost = calculateUsageCost(usage, JUDGE_PRICING_SNAPSHOT);
    if (usageCost === null) {
      return { usageCost: null, costState: "COST_INCOMPLETE", error: null };
    }
    return { usageCost, costState: "COMPLETE", error: null };
  } catch (error) {
    return {
      usageCost: null,
      costState: "COST_INCOMPLETE",
      error: `Judge usage 증거가 유효하지 않습니다: ${safeErrorMessage(error)}`,
    };
  }
}

function mapTerminalResponseStatus(
  status: Exclude<JudgeAdapterResult["status"], "completed">,
): JudgeAttemptStatus {
  if (status === "refused") return "REFUSED";
  if (status === "incomplete") return "INCOMPLETE";
  return "FAILED";
}

function mapInvocationErrorStatus(error: JudgeInvocationError): JudgeAttemptStatus {
  if (error.kind === "EVIDENCE_INVALID") return "EVIDENCE_INVALID";
  if (error.kind === "TIMEOUT") return "TIMEOUT";
  if (error.kind === "ABORTED") return "ABORTED";
  if (error.requestDisposition === "RESPONSE_ERROR_RECEIVED") return "REQUEST_ERROR";
  if (error.requestDisposition === "SENT_OUTCOME_UNKNOWN") return "TRANSPORT_ERROR";
  return "REQUEST_ERROR";
}

function shouldRetry(
  status: JudgeAttemptStatus,
  invocationRetryable: boolean,
): boolean {
  return status === "INVALID_OUTPUT"
    || status === "TIMEOUT"
    || status === "TRANSPORT_ERROR"
    || status === "REQUEST_ERROR" && invocationRetryable;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function validateTimeoutMs(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Judge 전체 timeoutMs는 0보다 큰 유한한 숫자여야 합니다.");
  }
}

function buildAggregateCost(attempts: readonly JudgeAttemptRecord[]): {
  usageCost: UsageCost | null;
  costState: "COMPLETE" | "COST_INCOMPLETE";
} {
  if (
    attempts.length === 0
    || attempts.some((attempt) => attempt.costState === "COST_INCOMPLETE")
  ) {
    return { usageCost: null, costState: "COST_INCOMPLETE" };
  }
  const usages = attempts.map((attempt) => attempt.usage);
  const usageCost = calculateUsageCost(usages, JUDGE_PRICING_SNAPSHOT);
  return usageCost === null
    ? { usageCost: null, costState: "COST_INCOMPLETE" }
    : { usageCost, costState: "COMPLETE" };
}

/** 익명 입력 한 사례에 대해 risk-only Judge를 최대 두 번 실행합니다. */
export async function runBlindJudge({
  adapter,
  input,
  authoritativeBlindingPrecommit,
  timeoutMs = DEFAULT_JUDGE_TIMEOUT_MS,
  now = Date.now,
  signal,
}: RunBlindJudgeOptions): Promise<BlindJudgeRunRecord> {
  throwIfAborted(signal);
  validateTimeoutMs(timeoutMs);
  // 호출자가 재시도 사이에 원본 객체를 바꿔 요청·검증·identity를 갈라놓지 못하게 합니다.
  const inputSnapshot = deepFreeze(structuredClone(input));
  const validationContext = buildBlindJudgeValidationContext(inputSnapshot);
  const precommitBinding = assertAuthoritativeBlindingPrecommitCaseBinding({
    anchor: authoritativeBlindingPrecommit,
    expectedCaseId: inputSnapshot.case_id,
    expectedJudgeInputHash: sha256CanonicalJson(inputSnapshot),
  });
  const attempts: JudgeAttemptRecord[] = [];
  const runStartedAtMs = now();
  const deadlineAtMs = runStartedAtMs + timeoutMs;
  let acceptedResult: BlindJudgeResult | null = null;

  for (let index = 0; index < MAX_JUDGE_ATTEMPTS; index += 1) {
    throwIfAborted(signal);
    const attemptNumber = (index + 1) as 1 | 2;
    const startedAtMs = now();
    const remainingTimeoutMs = Math.floor(deadlineAtMs - startedAtMs);
    if (remainingTimeoutMs <= 0) {
      attempts.push({
        attemptNumber,
        status: "TIMEOUT",
        retryEligible: false,
        startedAt: new Date(startedAtMs).toISOString(),
        latencyMs: 0,
        requestDisposition: "NOT_SENT",
        responseId: null,
        responseStatusCode: null,
        modelRequestedId: OPENAI_JUDGE_MODEL_REQUESTED_ID,
        modelReportedId: null,
        serviceTierRequested: OPENAI_JUDGE_SERVICE_TIER_REQUESTED,
        serviceTierReported: null,
        usage: null,
        usageCost: null,
        costState: "COMPLETE",
        error: `Judge 전체 제한시간 ${timeoutMs}ms를 소진했습니다.`,
      });
      break;
    }

    let attempt: JudgeAttemptRecord;
    let retryable = false;
    try {
      const response = await adapter.invoke(structuredClone(inputSnapshot), {
        timeoutMs: remainingTimeoutMs,
        ...(signal ? { signal } : {}),
      });
      const finishedAtMs = now();
      const latencyMs = Math.max(finishedAtMs - startedAtMs, 0);
      const normalizedUsage = normalizeUsageEvidence(response.usage);
      const usage = normalizedUsage.usage;
      const cost = calculateAttemptCost(
        usage,
        response.modelReportedId,
        response.serviceTierReported,
      );
      const responseEvidenceError = validateResponseEvidence(response);
      const base = {
        attemptNumber,
        startedAt: new Date(startedAtMs).toISOString(),
        latencyMs,
        requestDisposition: "RESPONSE_RECEIVED" as const,
        responseId: response.responseId,
        responseStatusCode: response.responseStatusCode,
        modelRequestedId: OPENAI_JUDGE_MODEL_REQUESTED_ID,
        modelReportedId: response.modelReportedId,
        serviceTierRequested: OPENAI_JUDGE_SERVICE_TIER_REQUESTED,
        serviceTierReported: response.serviceTierReported,
        usage,
        usageCost: cost.usageCost,
        costState: cost.costState,
      };

      if (signal?.aborted) {
        attempt = {
          ...base,
          status: "ABORTED",
          retryEligible: false,
          error: signal.reason instanceof Error
            ? safeErrorMessage(signal.reason)
            : "Judge 실행이 중단됐습니다.",
        };
      } else if (finishedAtMs >= deadlineAtMs) {
        retryable = true;
        attempt = {
          ...base,
          status: "TIMEOUT",
          retryEligible: attemptNumber < MAX_JUDGE_ATTEMPTS,
          error: `Judge 전체 제한시간 ${timeoutMs}ms 뒤 반환된 응답은 승인하지 않습니다.`,
        };
      } else if (
        normalizedUsage.error !== null
        || responseEvidenceError !== null
        || cost.error !== null
      ) {
        attempt = {
          ...base,
          status: "EVIDENCE_INVALID",
          retryEligible: false,
          error: safeErrorMessage(normalizedUsage.error ?? responseEvidenceError ?? cost.error),
        };
      } else if (response.status !== "completed" || response.outputText === null) {
        attempt = {
          ...base,
          status: response.status === "completed"
            ? "INVALID_OUTPUT"
            : mapTerminalResponseStatus(response.status),
          retryEligible: response.status === "completed"
            && attemptNumber < MAX_JUDGE_ATTEMPTS,
          error: safeErrorMessage(response.error ?? `Responses API 상태: ${response.status}`),
        };
        retryable = response.status === "completed";
      } else {
        try {
          acceptedResult = parseBlindJudgeResult(response.outputText, validationContext);
          attempt = {
            ...base,
            status: "COMPLETE",
            retryEligible: false,
            error: null,
          };
        } catch (error) {
          retryable = true;
          attempt = {
            ...base,
            status: "INVALID_OUTPUT",
            retryEligible: attemptNumber < MAX_JUDGE_ATTEMPTS,
            error: safeErrorMessage(error),
          };
        }
      }
    } catch (error) {
      const finishedAtMs = now();
      const invocationError = error instanceof JudgeInvocationError
        ? error
        : signal?.aborted
          ? new JudgeInvocationError(safeErrorMessage(error), {
            retryable: false,
            kind: "ABORTED",
            requestDisposition: "SENT_OUTCOME_UNKNOWN",
            usage: null,
            cause: error,
          })
          : new JudgeInvocationError(safeErrorMessage(error), {
            retryable: false,
            kind: "EVIDENCE_INVALID",
            requestDisposition: "SENT_OUTCOME_UNKNOWN",
            usage: null,
            cause: error,
          });

      const normalizedUsage = normalizeUsageEvidence(invocationError.usage);
      const usage = normalizedUsage.usage;
      const cost = calculateAttemptCost(
        usage,
        invocationError.modelReportedId,
        invocationError.serviceTierReported,
      );
      const status = normalizedUsage.error === null
        ? mapInvocationErrorStatus(invocationError)
        : "EVIDENCE_INVALID";
      retryable = normalizedUsage.error === null
        && invocationError.retryable;
      attempt = {
        attemptNumber,
        status,
        retryEligible: attemptNumber < MAX_JUDGE_ATTEMPTS
          && shouldRetry(status, retryable),
        startedAt: new Date(startedAtMs).toISOString(),
        latencyMs: Math.max(finishedAtMs - startedAtMs, 0),
        requestDisposition: invocationError.requestSent
          ? invocationError.requestDisposition
          : "NOT_SENT",
        responseId: invocationError.responseId,
        responseStatusCode: invocationError.responseStatusCode,
        modelRequestedId: OPENAI_JUDGE_MODEL_REQUESTED_ID,
        modelReportedId: invocationError.modelReportedId,
        serviceTierRequested: OPENAI_JUDGE_SERVICE_TIER_REQUESTED,
        serviceTierReported: invocationError.serviceTierReported,
        usage,
        usageCost: cost.usageCost,
        costState: cost.costState,
        error: safeErrorMessage(normalizedUsage.error ?? invocationError.message),
      };
    }

    attempts.push(attempt);
    if (
      acceptedResult !== null
      || index === MAX_JUDGE_ATTEMPTS - 1
      || !attempt.retryEligible
    ) {
      break;
    }
  }

  const aggregateCost = buildAggregateCost(attempts);
  const record: BlindJudgeRunRecord = {
    schemaVersion: "blind-judge-run-v2",
    caseId: inputSnapshot.case_id,
    authority: "RISK_ONLY_REVIEW_REQUIRED",
    identity: buildBlindJudgeRunIdentity(inputSnapshot, precommitBinding),
    judgeStatus: acceptedResult === null ? "JUDGE_INCOMPLETE" : "JUDGE_COMPLETE",
    result: acceptedResult,
    attempts,
    totalLatencyMs: attempts.reduce((total, attempt) => total + attempt.latencyMs, 0),
    usageCost: aggregateCost.usageCost,
    costState: aggregateCost.costState,
  };
  return parseBlindJudgeRunRecord(
    record,
    inputSnapshot,
    authoritativeBlindingPrecommit,
  );
}

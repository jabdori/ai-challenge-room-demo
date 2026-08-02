import { redactSensitiveText } from "../cli/calibrationOutcome";
import { throwIfAborted } from "../runner/types";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  calculateUsageCost,
  type PricingSnapshot,
  type TokenUsage,
  type UsageCost,
} from "../runtime/pricing";
import {
  parseDefineStructuringInput,
  parseDefineSuggestion,
  type DefineStructuringInput,
  type DefineSuggestion,
} from "./defineContracts";
import {
  DefineInvocationError,
  OPENAI_DEFINE_MODEL_REPORTED_POLICY,
  OPENAI_DEFINE_MODEL_REQUESTED_ID,
  OPENAI_DEFINE_REQUEST_CONTRACT,
  OPENAI_DEFINE_RESPONSE_FORMAT,
  OPENAI_DEFINE_SERVICE_TIER_REQUESTED,
  type DefineAdapter,
  type DefineAdapterResult,
} from "./openaiDefineAdapter";

export const DEFAULT_DEFINE_TIMEOUT_MS = 60_000;
export const MAX_DEFINE_ATTEMPTS = 2;

export const DEFINE_LONG_CONTEXT_POLICY = Object.freeze({
  thresholdInputTokens: 272_000,
  comparison: "GREATER_THAN" as const,
  disposition: "COST_INCOMPLETE" as const,
});

export const DEFINE_PRICING_SNAPSHOT: PricingSnapshot & {
  long_context_policy: typeof DEFINE_LONG_CONTEXT_POLICY;
} = Object.freeze({
  pricing_snapshot_id: "openai-gpt-5.6-sol-standard-define-2026-07-17",
  pricing_as_of: "2026-07-17",
  provider: "OpenAI",
  model: OPENAI_DEFINE_MODEL_REQUESTED_ID,
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
  notes: "Locked Standard short-context price lookup for Define structuring.",
  long_context_policy: DEFINE_LONG_CONTEXT_POLICY,
});

export type DefineAttemptStatus =
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

export type DefineRequestDisposition =
  | "RESPONSE_RECEIVED"
  | "RESPONSE_ERROR_RECEIVED"
  | "SENT_OUTCOME_UNKNOWN"
  | "NOT_SENT";

export interface DefineAttemptRecord {
  attemptNumber: 1 | 2;
  status: DefineAttemptStatus;
  retryEligible: boolean;
  startedAt: string;
  latencyMs: number;
  requestDisposition: DefineRequestDisposition;
  responseId: string | null;
  responseStatusCode: number | null;
  modelRequestedId: typeof OPENAI_DEFINE_MODEL_REQUESTED_ID;
  modelReportedId: string | null;
  serviceTierRequested: typeof OPENAI_DEFINE_SERVICE_TIER_REQUESTED;
  serviceTierReported: string | null;
  usage: TokenUsage | null;
  usageCost: UsageCost | null;
  costState: "COMPLETE" | "COST_INCOMPLETE";
  error: string | null;
}

export interface DefineStructuringRunRecord {
  schemaVersion: "define-structuring-run-v1";
  artifactKind: "DEFINE_STRUCTURING_EVIDENCE";
  synthetic: true;
  authority: "ADVISORY_ONLY";
  structuringStatus: "SUGGESTION_COMPLETE" | "SUGGESTION_INCOMPLETE";
  suggestion: DefineSuggestion | null;
  identity: {
    defineInputHash: string;
    requestContractHash: string;
    outputSchemaHash: string;
    pricingSnapshotHash: string;
  };
  attempts: DefineAttemptRecord[];
  totalLatencyMs: number;
  usageCost: UsageCost | null;
  costState: "COMPLETE" | "COST_INCOMPLETE";
}

export interface RunDefineStructuringOptions {
  adapter: DefineAdapter;
  input: DefineStructuringInput;
  timeoutMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}

type JsonRecord = Record<string, unknown>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "artifactKind",
  "synthetic",
  "authority",
  "structuringStatus",
  "suggestion",
  "identity",
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
const ATTEMPT_STATUSES: readonly DefineAttemptStatus[] = [
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
const REQUEST_DISPOSITIONS: readonly DefineRequestDisposition[] = [
  "RESPONSE_RECEIVED",
  "RESPONSE_ERROR_RECEIVED",
  "SENT_OUTCOME_UNKNOWN",
  "NOT_SENT",
];

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function readRecord(value: unknown, location: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${location}은(는) plain JSON 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${location}은(는) plain JSON 객체여야 합니다.`);
  }
  return value as JsonRecord;
}

function assertExactKeys(
  record: JsonRecord,
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

function readNonNegativeTokenCount(value: unknown, location: string): number {
  const parsed = readNonNegativeNumber(value, location);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${location}은(는) 0 이상의 안전한 정수 token count여야 합니다.`);
  }
  return parsed;
}

function readNullableStatusCode(value: unknown, location: string): number | null {
  if (value === null) return null;
  const parsed = readNonNegativeNumber(value, location);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 599) {
    throw new TypeError(`${location}은(는) 100부터 599 사이여야 합니다.`);
  }
  return parsed;
}

function readIsoTimestamp(value: unknown, location: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${location}은(는) ISO timestamp여야 합니다.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${location}은(는) 정규 ISO timestamp여야 합니다.`);
  }
  return value;
}

function parseTokenUsage(value: unknown, location: string): TokenUsage {
  const record = readRecord(value, location);
  const required = [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
  ] as const;
  const allowed = new Set<string>(required);
  const missing = required.filter((key) => !Object.hasOwn(record, key));
  const additional = Object.keys(record).filter((key) => !allowed.has(key));
  if (missing.length > 0 || additional.length > 0) {
    throw new TypeError(`${location} token 필드 계약이 다릅니다.`);
  }
  const usage: TokenUsage = {
    inputTokens: readNonNegativeTokenCount(record.inputTokens, `${location}.inputTokens`),
    cachedInputTokens: readNonNegativeTokenCount(
      record.cachedInputTokens,
      `${location}.cachedInputTokens`,
    ),
    cacheWriteTokens: readNonNegativeTokenCount(
      record.cacheWriteTokens,
      `${location}.cacheWriteTokens`,
    ),
    outputTokens: readNonNegativeTokenCount(record.outputTokens, `${location}.outputTokens`),
  };
  usage.reasoningTokens = readNonNegativeTokenCount(
    record.reasoningTokens,
    `${location}.reasoningTokens`,
  );
  usage.totalTokens = readNonNegativeTokenCount(
    record.totalTokens,
    `${location}.totalTokens`,
  );
  if (usage.cachedInputTokens + usage.cacheWriteTokens > usage.inputTokens) {
    throw new TypeError(`${location}의 cache token 합계가 inputTokens보다 큽니다.`);
  }
  if (
    usage.reasoningTokens > usage.outputTokens
  ) {
    throw new TypeError(`${location}의 reasoningTokens가 outputTokens보다 큽니다.`);
  }
  if (
    usage.totalTokens !== usage.inputTokens + usage.outputTokens
  ) {
    throw new TypeError(
      `${location}의 totalTokens는 inputTokens와 outputTokens의 합계여야 합니다.`,
    );
  }
  return usage;
}

function assertCanonicalEqual(actual: unknown, expected: unknown, location: string): void {
  if (canonicalJsonStringify(actual) !== canonicalJsonStringify(expected)) {
    throw new TypeError(`${location} 재계산 결과가 잠긴 증거와 일치하지 않습니다.`);
  }
}

function safeErrorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function isAllowedReportedModel(value: string | null): value is string {
  return value !== null
    && (OPENAI_DEFINE_MODEL_REPORTED_POLICY.allowedModels as readonly string[])
      .includes(value);
}

interface AttemptCostResult {
  usageCost: UsageCost | null;
  costState: "COMPLETE" | "COST_INCOMPLETE";
  error: string | null;
}

function calculateAttemptCost(
  usage: TokenUsage | null,
  modelReportedId: string | null,
  serviceTierReported: string | null,
): AttemptCostResult {
  if (usage === null) {
    return { usageCost: null, costState: "COST_INCOMPLETE", error: null };
  }
  if (
    !isAllowedReportedModel(modelReportedId)
    || serviceTierReported !== OPENAI_DEFINE_SERVICE_TIER_REQUESTED
  ) {
    return {
      usageCost: null,
      costState: "COST_INCOMPLETE",
      error: "Define reported model/service tier가 잠긴 가격 적용 조건과 다릅니다.",
    };
  }
  if (usage.inputTokens > DEFINE_LONG_CONTEXT_POLICY.thresholdInputTokens) {
    return {
      usageCost: null,
      costState: "COST_INCOMPLETE",
      error: "Define input이 272K long-context 가격 경계를 초과했습니다.",
    };
  }
  try {
    const usageCost = calculateUsageCost(usage, DEFINE_PRICING_SNAPSHOT);
    return usageCost === null
      ? { usageCost: null, costState: "COST_INCOMPLETE", error: null }
      : { usageCost, costState: "COMPLETE", error: null };
  } catch (error) {
    return {
      usageCost: null,
      costState: "COST_INCOMPLETE",
      error: `Define usage 증거가 유효하지 않습니다: ${safeErrorMessage(error)}`,
    };
  }
}

function normalizeUsageEvidence(
  value: TokenUsage | null,
): { usage: TokenUsage | null; error: string | null } {
  if (value === null) return { usage: null, error: null };
  try {
    return { usage: parseTokenUsage(value, "Define adapter usage"), error: null };
  } catch (error) {
    return {
      usage: null,
      error: `Define usage mapping 증거가 유효하지 않습니다: ${safeErrorMessage(error)}`,
    };
  }
}

function buildAggregateCost(attempts: readonly DefineAttemptRecord[]): {
  usageCost: UsageCost | null;
  costState: "COMPLETE" | "COST_INCOMPLETE";
} {
  if (attempts.some((attempt) => attempt.costState === "COST_INCOMPLETE")) {
    return { usageCost: null, costState: "COST_INCOMPLETE" };
  }
  const costs = attempts
    .map((attempt) => attempt.usageCost)
    .filter((cost): cost is UsageCost => cost !== null);
  if (costs.length === 0) {
    return { usageCost: null, costState: "COMPLETE" };
  }
  const usages = attempts
    .map((attempt) => attempt.usage)
    .filter((usage): usage is TokenUsage => usage !== null);
  return {
    usageCost: calculateUsageCost(usages, DEFINE_PRICING_SNAPSHOT),
    costState: "COMPLETE",
  };
}

function isRetryableHttpStatusCode(statusCode: number): boolean {
  return statusCode === 408
    || statusCode === 409
    || statusCode === 429
    || statusCode >= 500;
}

function parseAttemptRecord(
  value: unknown,
  expectedAttemptNumber: 1 | 2,
  location: string,
): DefineAttemptRecord {
  const record = readRecord(value, location);
  assertExactKeys(record, ATTEMPT_KEYS, location);
  if (record.attemptNumber !== expectedAttemptNumber) {
    throw new TypeError(`${location}.attemptNumber가 순서와 다릅니다.`);
  }
  const status = readEnum(record.status, ATTEMPT_STATUSES, `${location}.status`);
  if (typeof record.retryEligible !== "boolean") {
    throw new TypeError(`${location}.retryEligible은 boolean이어야 합니다.`);
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
  if (error !== null && redactSensitiveText(error) !== error) {
    throw new TypeError(`${location}.error에 마스킹되지 않은 비밀정보가 있습니다.`);
  }
  if (record.modelRequestedId !== OPENAI_DEFINE_MODEL_REQUESTED_ID) {
    throw new TypeError(`${location}.modelRequestedId가 요청 계약과 다릅니다.`);
  }
  if (record.serviceTierRequested !== OPENAI_DEFINE_SERVICE_TIER_REQUESTED) {
    throw new TypeError(`${location}.serviceTierRequested가 요청 계약과 다릅니다.`);
  }
  const usage = record.usage === null
    ? null
    : parseTokenUsage(record.usage, `${location}.usage`);
  const costState = readEnum(
    record.costState,
    ["COMPLETE", "COST_INCOMPLETE"] as const,
    `${location}.costState`,
  );
  const expectedCost = calculateAttemptCost(
    usage,
    modelReportedId,
    serviceTierReported,
  );
  let usageCost: UsageCost | null = null;
  if (record.usageCost !== null) {
    readRecord(record.usageCost, `${location}.usageCost`);
    usageCost = structuredClone(record.usageCost) as UsageCost;
  }
  if (costState !== expectedCost.costState) {
    throw new TypeError(`${location}.costState가 재계산 결과와 다릅니다.`);
  }
  if (costState === "COMPLETE") {
    assertCanonicalEqual(usageCost, expectedCost.usageCost, `${location}.usageCost`);
  } else if (usageCost !== null) {
    throw new TypeError(`${location}.COST_INCOMPLETE에는 usageCost를 둘 수 없습니다.`);
  }

  if (status === "COMPLETE") {
    if (
      requestDisposition !== "RESPONSE_RECEIVED"
      || responseStatusCode !== 200
      || responseId === null
      || responseId.trim().length === 0
      || !isAllowedReportedModel(modelReportedId)
      || serviceTierReported !== OPENAI_DEFINE_SERVICE_TIER_REQUESTED
      || usage === null
      || costState !== "COMPLETE"
      || error !== null
    ) {
      throw new TypeError(`${location} COMPLETE 응답 증거가 잠긴 계약과 다릅니다.`);
    }
  } else if (error === null || error.length === 0) {
    throw new TypeError(`${location} 비완료 상태에는 오류 근거가 필요합니다.`);
  }

  const statusCanRetry = [
    "INVALID_OUTPUT",
    "TIMEOUT",
    "TRANSPORT_ERROR",
    "REQUEST_ERROR",
  ].includes(status);
  if (retryEligible && !statusCanRetry) {
    throw new TypeError(`${location}.retryEligible이 status와 다릅니다.`);
  }
  if (
    expectedAttemptNumber === 1
    && (
      status === "INVALID_OUTPUT"
      || status === "TRANSPORT_ERROR"
      || status === "TIMEOUT" && requestDisposition !== "NOT_SENT"
    )
    && !retryEligible
  ) {
    throw new TypeError(`${location} 첫 attempt의 잠긴 재시도 전이가 다릅니다.`);
  }
  if (expectedAttemptNumber === MAX_DEFINE_ATTEMPTS && retryEligible) {
    throw new TypeError(`${location} 마지막 attempt는 재시도 가능할 수 없습니다.`);
  }
  if (requestDisposition === "RESPONSE_RECEIVED" && status !== "EVIDENCE_INVALID") {
    if (
      responseStatusCode !== 200
      || responseId === null
      || !isAllowedReportedModel(modelReportedId)
      || serviceTierReported !== OPENAI_DEFINE_SERVICE_TIER_REQUESTED
    ) {
      throw new TypeError(`${location} 수신 응답 metadata가 잠긴 계약과 다릅니다.`);
    }
  }
  if (requestDisposition === "RESPONSE_ERROR_RECEIVED") {
    const mappingEvidence = status === "EVIDENCE_INVALID" && responseStatusCode === 200;
    const httpEvidence = responseStatusCode !== null
      && responseStatusCode >= 400
      && responseStatusCode <= 599;
    if (!mappingEvidence && !httpEvidence) {
      throw new TypeError(`${location} response error 증거가 유효하지 않습니다.`);
    }
  }
  if (
    (requestDisposition === "SENT_OUTCOME_UNKNOWN" || requestDisposition === "NOT_SENT")
    && responseStatusCode !== null
  ) {
    throw new TypeError(`${location} 미수신 상태에는 HTTP status를 둘 수 없습니다.`);
  }
  if (status === "TRANSPORT_ERROR" && requestDisposition !== "SENT_OUTCOME_UNKNOWN") {
    throw new TypeError(`${location} TRANSPORT_ERROR disposition이 다릅니다.`);
  }
  if (
    status === "REQUEST_ERROR"
    && requestDisposition !== "RESPONSE_ERROR_RECEIVED"
    && requestDisposition !== "NOT_SENT"
  ) {
    throw new TypeError(`${location} REQUEST_ERROR disposition이 다릅니다.`);
  }
  if (status === "REQUEST_ERROR") {
    const expectedRetry = expectedAttemptNumber < MAX_DEFINE_ATTEMPTS
      && requestDisposition === "RESPONSE_ERROR_RECEIVED"
      && responseStatusCode !== null
      && isRetryableHttpStatusCode(responseStatusCode);
    if (retryEligible !== expectedRetry) {
      throw new TypeError(`${location}.retryEligible이 HTTP 재시도 정책과 다릅니다.`);
    }
  }
  if (
    ["INVALID_OUTPUT", "REFUSED", "INCOMPLETE", "FAILED"].includes(status)
    && requestDisposition !== "RESPONSE_RECEIVED"
  ) {
    throw new TypeError(`${location} ${status} disposition이 다릅니다.`);
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
    modelRequestedId: OPENAI_DEFINE_MODEL_REQUESTED_ID,
    modelReportedId,
    serviceTierRequested: OPENAI_DEFINE_SERVICE_TIER_REQUESTED,
    serviceTierReported,
    usage,
    usageCost,
    costState,
    error,
  };
}

function buildRunIdentity(
  input: DefineStructuringInput,
): DefineStructuringRunRecord["identity"] {
  return {
    defineInputHash: sha256CanonicalJson(input),
    requestContractHash: sha256CanonicalJson(OPENAI_DEFINE_REQUEST_CONTRACT),
    outputSchemaHash: sha256CanonicalJson(OPENAI_DEFINE_RESPONSE_FORMAT.schema),
    pricingSnapshotHash: sha256CanonicalJson(DEFINE_PRICING_SNAPSHOT),
  };
}

export function parseDefineStructuringRunRecord(
  value: unknown,
  expectedInput: DefineStructuringInput,
): DefineStructuringRunRecord {
  const input = parseDefineStructuringInput(expectedInput);
  const record = readRecord(value, "Define structuring run");
  assertExactKeys(record, TOP_LEVEL_KEYS, "Define structuring run");
  if (
    record.schemaVersion !== "define-structuring-run-v1"
    || record.artifactKind !== "DEFINE_STRUCTURING_EVIDENCE"
    || record.synthetic !== true
    || record.authority !== "ADVISORY_ONLY"
  ) {
    throw new TypeError("Define structuring run의 version·authority 계약이 다릅니다.");
  }
  const identityRecord = readRecord(record.identity, "Define structuring run.identity");
  const identityKeys = [
    "defineInputHash",
    "requestContractHash",
    "outputSchemaHash",
    "pricingSnapshotHash",
  ] as const;
  assertExactKeys(identityRecord, identityKeys, "Define structuring run.identity");
  const expectedIdentity = buildRunIdentity(input);
  const identity = {} as DefineStructuringRunRecord["identity"];
  for (const key of identityKeys) {
    const hash = identityRecord[key];
    if (
      typeof hash !== "string"
      || !SHA256_PATTERN.test(hash)
      || hash !== expectedIdentity[key]
    ) {
      throw new TypeError(`Define structuring run.identity.${key} 무결성이 다릅니다.`);
    }
    identity[key] = hash;
  }
  if (
    !Array.isArray(record.attempts)
    || record.attempts.length < 1
    || record.attempts.length > MAX_DEFINE_ATTEMPTS
  ) {
    throw new TypeError("Define structuring run에는 1~2개 attempt가 필요합니다.");
  }
  const attempts = record.attempts.map((attempt, index) => parseAttemptRecord(
    attempt,
    (index + 1) as 1 | 2,
    `Define structuring run.attempts[${index}]`,
  ));
  if (attempts.length === 2 && !attempts[0]?.retryEligible) {
    throw new TypeError("두 번째 Define attempt에는 retry eligible 첫 attempt가 필요합니다.");
  }
  if (attempts.length === 1 && attempts[0]?.retryEligible) {
    throw new TypeError("retry eligible 첫 attempt 뒤에는 두 번째 attempt가 필요합니다.");
  }
  const totalLatencyMs = readNonNegativeNumber(
    record.totalLatencyMs,
    "Define structuring run.totalLatencyMs",
  );
  if (
    totalLatencyMs
    !== attempts.reduce((total, attempt) => total + attempt.latencyMs, 0)
  ) {
    throw new TypeError("Define structuring run total latency 합계가 다릅니다.");
  }
  const structuringStatus = readEnum(
    record.structuringStatus,
    ["SUGGESTION_COMPLETE", "SUGGESTION_INCOMPLETE"] as const,
    "Define structuring run.structuringStatus",
  );
  const completeAttempts = attempts.filter((attempt) => attempt.status === "COMPLETE");
  let suggestion: DefineSuggestion | null = null;
  if (structuringStatus === "SUGGESTION_COMPLETE") {
    if (
      record.suggestion === null
      || completeAttempts.length !== 1
      || attempts.at(-1)?.status !== "COMPLETE"
    ) {
      throw new TypeError("Define complete status·suggestion·terminal attempt가 다릅니다.");
    }
    suggestion = parseDefineSuggestion(record.suggestion, input);
  } else if (record.suggestion !== null || completeAttempts.length > 0) {
    throw new TypeError("Define incomplete status에는 suggestion이 있을 수 없습니다.");
  }
  const expectedAggregate = buildAggregateCost(attempts);
  const costState = readEnum(
    record.costState,
    ["COMPLETE", "COST_INCOMPLETE"] as const,
    "Define structuring run.costState",
  );
  if (costState !== expectedAggregate.costState) {
    throw new TypeError("Define structuring run aggregate costState가 다릅니다.");
  }
  let usageCost: UsageCost | null = null;
  if (record.usageCost !== null) {
    readRecord(record.usageCost, "Define structuring run.usageCost");
    usageCost = structuredClone(record.usageCost) as UsageCost;
  }
  assertCanonicalEqual(
    usageCost,
    expectedAggregate.usageCost,
    "Define structuring run.usageCost",
  );
  return deepFreeze({
    schemaVersion: "define-structuring-run-v1",
    artifactKind: "DEFINE_STRUCTURING_EVIDENCE",
    synthetic: true,
    authority: "ADVISORY_ONLY",
    structuringStatus,
    suggestion,
    identity,
    attempts,
    totalLatencyMs,
    usageCost,
    costState,
  });
}

export function validateDefineStructuringRunIdentity(
  value: unknown,
  expectedInput: DefineStructuringInput,
): DefineStructuringRunRecord {
  return parseDefineStructuringRunRecord(value, expectedInput);
}

function validateResponseEvidence(response: DefineAdapterResult): string | null {
  if (response.responseStatusCode !== 200) {
    return "Define 성공 응답의 HTTP status는 200이어야 합니다.";
  }
  if (response.responseId === null || response.responseId.trim().length === 0) {
    return "Define 응답에는 response ID가 필요합니다.";
  }
  if (!isAllowedReportedModel(response.modelReportedId)) {
    return "Define reported model이 잠긴 exact allowlist와 다릅니다.";
  }
  if (response.serviceTierReported !== OPENAI_DEFINE_SERVICE_TIER_REQUESTED) {
    return "Define reported service tier가 잠긴 계약과 다릅니다.";
  }
  if (response.status === "completed" && response.error !== null) {
    return "completed Define 응답에는 error가 있을 수 없습니다.";
  }
  if (response.status === "completed" && response.usage === null) {
    return "completed Define 응답에는 usage 증거가 필요합니다.";
  }
  return null;
}

function mapTerminalResponseStatus(
  status: Exclude<DefineAdapterResult["status"], "completed">,
): DefineAttemptStatus {
  if (status === "refused") return "REFUSED";
  if (status === "incomplete") return "INCOMPLETE";
  return "FAILED";
}

function mapInvocationErrorStatus(error: DefineInvocationError): DefineAttemptStatus {
  if (error.kind === "EVIDENCE_INVALID") return "EVIDENCE_INVALID";
  if (error.kind === "TIMEOUT") return "TIMEOUT";
  if (error.kind === "ABORTED") return "ABORTED";
  if (error.requestDisposition === "RESPONSE_ERROR_RECEIVED") return "REQUEST_ERROR";
  if (error.requestDisposition === "SENT_OUTCOME_UNKNOWN") return "TRANSPORT_ERROR";
  return "REQUEST_ERROR";
}

function shouldRetry(
  status: DefineAttemptStatus,
  invocationRetryable: boolean,
): boolean {
  return status === "INVALID_OUTPUT"
    || status === "TIMEOUT"
    || status === "TRANSPORT_ERROR"
    || status === "REQUEST_ERROR" && invocationRetryable;
}

function validateTimeoutMs(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Define 전체 timeoutMs는 0보다 큰 유한한 숫자여야 합니다.");
  }
}

export async function runDefineStructuring({
  adapter,
  input,
  timeoutMs = DEFAULT_DEFINE_TIMEOUT_MS,
  now = Date.now,
  signal,
}: RunDefineStructuringOptions): Promise<DefineStructuringRunRecord> {
  throwIfAborted(signal);
  validateTimeoutMs(timeoutMs);
  const inputSnapshot = deepFreeze(
    structuredClone(parseDefineStructuringInput(input)),
  );
  const attempts: DefineAttemptRecord[] = [];
  const runStartedAtMs = now();
  const deadlineAtMs = runStartedAtMs + timeoutMs;
  let acceptedSuggestion: DefineSuggestion | null = null;

  for (let index = 0; index < MAX_DEFINE_ATTEMPTS; index += 1) {
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
        modelRequestedId: OPENAI_DEFINE_MODEL_REQUESTED_ID,
        modelReportedId: null,
        serviceTierRequested: OPENAI_DEFINE_SERVICE_TIER_REQUESTED,
        serviceTierReported: null,
        usage: null,
        usageCost: null,
        costState: "COST_INCOMPLETE",
        error: `Define 전체 제한시간 ${timeoutMs}ms를 소진했습니다.`,
      });
      break;
    }

    let attempt: DefineAttemptRecord;
    let invocationRetryable = false;
    try {
      const response = await adapter.invoke(structuredClone(inputSnapshot), {
        timeoutMs: remainingTimeoutMs,
        ...(signal ? { signal } : {}),
      });
      const finishedAtMs = now();
      const normalizedUsage = normalizeUsageEvidence(response.usage);
      const usage = normalizedUsage.usage;
      const cost = calculateAttemptCost(
        usage,
        response.modelReportedId,
        response.serviceTierReported,
      );
      const evidenceError = validateResponseEvidence(response);
      const base = {
        attemptNumber,
        startedAt: new Date(startedAtMs).toISOString(),
        latencyMs: Math.max(finishedAtMs - startedAtMs, 0),
        requestDisposition: "RESPONSE_RECEIVED" as const,
        responseId: response.responseId,
        responseStatusCode: response.responseStatusCode,
        modelRequestedId: OPENAI_DEFINE_MODEL_REQUESTED_ID,
        modelReportedId: response.modelReportedId,
        serviceTierRequested: OPENAI_DEFINE_SERVICE_TIER_REQUESTED,
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
            : "Define 실행이 중단됐습니다.",
        };
      } else if (finishedAtMs >= deadlineAtMs) {
        attempt = {
          ...base,
          status: "TIMEOUT",
          retryEligible: attemptNumber < MAX_DEFINE_ATTEMPTS,
          error: `Define 전체 제한시간 ${timeoutMs}ms 뒤 반환된 응답은 채택하지 않습니다.`,
        };
      } else if (
        normalizedUsage.error !== null
        || evidenceError !== null
        || cost.error !== null
      ) {
        attempt = {
          ...base,
          status: "EVIDENCE_INVALID",
          retryEligible: false,
          error: safeErrorMessage(normalizedUsage.error ?? evidenceError ?? cost.error),
        };
      } else if (response.status !== "completed") {
        attempt = {
          ...base,
          status: mapTerminalResponseStatus(response.status),
          retryEligible: false,
          error: safeErrorMessage(response.error ?? `Responses API 상태: ${response.status}`),
        };
      } else if (response.outputText === null) {
        attempt = {
          ...base,
          status: "INVALID_OUTPUT",
          retryEligible: attemptNumber < MAX_DEFINE_ATTEMPTS,
          error: "완료된 Define 응답에 구조화 출력이 없습니다.",
        };
      } else {
        try {
          acceptedSuggestion = parseDefineSuggestion(response.outputText, inputSnapshot);
          attempt = {
            ...base,
            status: "COMPLETE",
            retryEligible: false,
            error: null,
          };
        } catch (error) {
          attempt = {
            ...base,
            status: "INVALID_OUTPUT",
            retryEligible: attemptNumber < MAX_DEFINE_ATTEMPTS,
            error: safeErrorMessage(error),
          };
        }
      }
    } catch (error) {
      const finishedAtMs = now();
      const invocationError = error instanceof DefineInvocationError
        ? error
        : new DefineInvocationError(safeErrorMessage(error), {
          retryable: false,
          kind: signal?.aborted ? "ABORTED" : "EVIDENCE_INVALID",
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
      invocationRetryable = normalizedUsage.error === null
        && invocationError.retryable;
      attempt = {
        attemptNumber,
        status,
        retryEligible: attemptNumber < MAX_DEFINE_ATTEMPTS
          && shouldRetry(status, invocationRetryable),
        startedAt: new Date(startedAtMs).toISOString(),
        latencyMs: Math.max(finishedAtMs - startedAtMs, 0),
        requestDisposition: invocationError.requestDisposition,
        responseId: invocationError.responseId,
        responseStatusCode: invocationError.responseStatusCode,
        modelRequestedId: OPENAI_DEFINE_MODEL_REQUESTED_ID,
        modelReportedId: invocationError.modelReportedId,
        serviceTierRequested: OPENAI_DEFINE_SERVICE_TIER_REQUESTED,
        serviceTierReported: invocationError.serviceTierReported,
        usage,
        usageCost: cost.usageCost,
        costState: cost.costState,
        error: safeErrorMessage(normalizedUsage.error ?? invocationError.message),
      };
    }

    attempts.push(attempt);
    if (
      acceptedSuggestion !== null
      || index === MAX_DEFINE_ATTEMPTS - 1
      || !attempt.retryEligible
    ) {
      break;
    }
  }

  const aggregate = buildAggregateCost(attempts);
  const record: DefineStructuringRunRecord = {
    schemaVersion: "define-structuring-run-v1",
    artifactKind: "DEFINE_STRUCTURING_EVIDENCE",
    synthetic: true,
    authority: "ADVISORY_ONLY",
    structuringStatus: acceptedSuggestion === null
      ? "SUGGESTION_INCOMPLETE"
      : "SUGGESTION_COMPLETE",
    suggestion: acceptedSuggestion,
    identity: buildRunIdentity(inputSnapshot),
    attempts,
    totalLatencyMs: attempts.reduce((total, attempt) => total + attempt.latencyMs, 0),
    usageCost: aggregate.usageCost,
    costState: aggregate.costState,
  };
  return parseDefineStructuringRunRecord(record, inputSnapshot);
}

import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import { parseCandidateOutput } from "../contracts/candidateOutput";
import { inspectProviderUsageLedger } from "../runtime/providerUsageLedger";
import { calculateUsageCost, DEFAULT_PRICING_SNAPSHOT } from "../runtime/pricing";
import {
  persistWriteOnceFile,
  persistWriteOnceFileWithClaim,
  prepareWriteOnceArtifactDirectory,
} from "./persistence";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_SLOT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_IDENTITY_KEY = /^[a-z][a-z0-9_]*$/;
const ARTIFACT_BASE_KEYS = [
  "artifact_kind",
  "execution",
  "execution_hash",
  "identity_hashes",
  "repetition",
  "schedule_id",
  "sequence",
  "slot_id",
  "slot_identity_hash",
] as const;
const INTENT_EXECUTION_KEYS = [
  "candidate_id",
  "invocation_hash",
  "run_number",
  "schema_version",
] as const;
const RECEIPT_EXECUTION_KEYS = ["schema_version", "slot_result"] as const;
const CHECKPOINT_EXECUTION_KEYS = ["evaluation_state", "schema_version"] as const;
const SLOT_RESULT_KEYS = [
  "accessEvidence",
  "completedExecutionEvidence",
  "costState",
  "executionStatus",
  "requestDisposition",
  "run",
  "slot",
  "totalLatencyMs",
  "usageCost",
] as const;
const SCHEDULE_SLOT_KEYS = [
  "candidate_id",
  "candidate_position",
  "case_id",
  "repetition",
  "sequence",
  "slot_id",
] as const;
const WRAPPER_KEYS = ["payload", "payload_sha256"] as const;
const IDENTITY_HASH_KEYS = [
  "authoritative_order_hash",
  "benchmark_oracle_hash",
  "candidate_config_hash",
  "candidate_input_hash",
  "candidate_policy_corpus_hash",
  "challenge_hash",
  "dataset_hash",
  "evaluator_policy_corpus_hash",
  "evaluator_contract_hash",
  "evaluator_policy_manifest_hash",
  "evidence_contract_hash",
  "execution_envelope_hash",
  "execution_identity_hash",
  "hidden_execution_data_hash",
  "input_access_hash",
  "invocation_hash",
  "invocation_input_hash",
  "locked_challenge_contract_hash",
  "locked_challenge_pack_hash",
  "locked_challenge_source_manifest_hash",
  "orders_hash",
  "output_schema_hash",
  "policy_manifest_hash",
  "policy_resource_identity_hash",
  "policy_vector_store_id_hash",
  "pricing_snapshot_hash",
  "prompt_hash",
  "runner_contract_hash",
  "slot_case_hash",
  "slot_identity_hash",
  "slot_oracle_hash",
  "slot_output_schema_hash",
] as const;

export type BenchmarkSlotArtifactKind =
  | "BENCHMARK_SLOT_EXECUTION_INTENT"
  | "BENCHMARK_SLOT_EXECUTION_RECEIPT"
  | "BENCHMARK_SLOT_EXECUTION_CHECKPOINT";

export interface BenchmarkSlotCoordinates {
  readonly slot_id: string;
  readonly sequence: number;
  readonly repetition: 1 | 2;
}

export interface BenchmarkSlotExpectedIdentity {
  readonly scheduleId: string;
  readonly slotIdentityHash: string;
  readonly identityHashes: Readonly<Record<string, string>>;
}

interface BenchmarkSlotArtifactBase<TExecution> extends BenchmarkSlotCoordinates {
  readonly artifact_kind: BenchmarkSlotArtifactKind;
  readonly execution_hash: string;
  readonly schedule_id: string;
  readonly slot_identity_hash: string;
  readonly identity_hashes: Readonly<Record<string, string>>;
  readonly execution: TExecution;
}

export interface BenchmarkSlotIntentExecution {
  readonly schema_version: "benchmark-slot-intent-v1";
  readonly candidate_id: "A" | "B" | "C";
  readonly run_number: 1 | 2;
  readonly invocation_hash: string;
}

export interface BenchmarkSlotReceiptExecution {
  readonly schema_version: "benchmark-slot-receipt-v1";
  readonly slot_result: Readonly<Record<string, unknown>>;
}

export interface BenchmarkSlotCheckpointExecution {
  readonly schema_version: "benchmark-slot-checkpoint-v1";
  readonly evaluation_state: Readonly<Record<string, unknown>>;
}

export interface BenchmarkSlotExecutionIntent<
  TExecution extends BenchmarkSlotIntentExecution = BenchmarkSlotIntentExecution,
> extends BenchmarkSlotArtifactBase<TExecution> {
  readonly artifact_kind: "BENCHMARK_SLOT_EXECUTION_INTENT";
}

export interface BenchmarkSlotExecutionReceipt<
  TExecution extends BenchmarkSlotReceiptExecution = BenchmarkSlotReceiptExecution,
>
  extends BenchmarkSlotArtifactBase<TExecution> {
  readonly artifact_kind: "BENCHMARK_SLOT_EXECUTION_RECEIPT";
  readonly intent_payload_sha256: string;
}

export interface BenchmarkSlotExecutionCheckpoint<
  TExecution extends BenchmarkSlotCheckpointExecution = BenchmarkSlotCheckpointExecution,
>
  extends BenchmarkSlotArtifactBase<TExecution> {
  readonly artifact_kind: "BENCHMARK_SLOT_EXECUTION_CHECKPOINT";
  readonly intent_payload_sha256: string;
  readonly receipt_payload_sha256: string;
}

export type BenchmarkSlotArtifact =
  | BenchmarkSlotExecutionIntent
  | BenchmarkSlotExecutionReceipt
  | BenchmarkSlotExecutionCheckpoint;

export interface BenchmarkSlotArtifactPaths {
  readonly executionDirectory: string;
  readonly slotsDirectory: string;
  readonly intentPath: string;
  readonly receiptPath: string;
  readonly checkpointPath: string;
}

export type BenchmarkSlotResumeState =
  | { readonly state: "NONE" }
  | {
    readonly state: "INTENT_ONLY";
    readonly resolution: "AMBIGUOUS_IN_FLIGHT";
    readonly allowRemoteCall: false;
    readonly intent: BenchmarkSlotExecutionIntent;
  }
  | {
    readonly state: "RECEIPT_ONLY";
    readonly resolution: "RECOMPUTE_GATES";
    readonly allowRemoteCall: false;
    readonly intent: BenchmarkSlotExecutionIntent;
    readonly receipt: BenchmarkSlotExecutionReceipt;
  }
  | {
    readonly state: "CHECKPOINT";
    readonly resolution: "REUSE";
    readonly intent: BenchmarkSlotExecutionIntent;
    readonly receipt: BenchmarkSlotExecutionReceipt;
    readonly checkpoint: BenchmarkSlotExecutionCheckpoint;
  };

export class BenchmarkPersistenceIntegrityError extends Error {
  readonly code = "BENCHMARK_PERSISTENCE_INTEGRITY" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BenchmarkPersistenceIntegrityError";
  }
}

interface CreatePathsInput {
  readonly outputDirectory: string;
  readonly executionHash: string;
  readonly slot: BenchmarkSlotCoordinates;
}

interface PersistArtifactInput {
  readonly outputDirectory: string;
  readonly artifact: BenchmarkSlotArtifact;
}

interface ClaimIntentInput {
  readonly outputDirectory: string;
  readonly artifact: BenchmarkSlotExecutionIntent;
}

export interface BenchmarkIntentClaim {
  readonly path: string;
  readonly created: boolean;
  readonly allowRemoteCall: boolean;
}

interface LoadResumeStateInput {
  readonly outputDirectory: string;
  readonly executionHash: string;
  readonly slot: BenchmarkSlotCoordinates;
  readonly expectedIdentity: BenchmarkSlotExpectedIdentity;
}

export interface ValidateBenchmarkSlotArtifactChainInput {
  readonly intent: BenchmarkSlotExecutionIntent;
  readonly receipt: BenchmarkSlotExecutionReceipt;
  readonly checkpoint: BenchmarkSlotExecutionCheckpoint;
  readonly expectedIdentity: BenchmarkSlotExpectedIdentity;
}

export interface ValidatedBenchmarkSlotArtifactChain {
  readonly intent: BenchmarkSlotExecutionIntent;
  readonly receipt: BenchmarkSlotExecutionReceipt;
  readonly checkpoint: BenchmarkSlotExecutionCheckpoint;
}

function integrityError(message: string, cause?: unknown): BenchmarkPersistenceIntegrityError {
  return new BenchmarkPersistenceIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw integrityError(`${label}의 키 집합이 잠긴 계약과 다릅니다.`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw integrityError(`${label}는 64자리 소문자 SHA-256이어야 합니다.`);
  }
}

function assertSlot(slot: BenchmarkSlotCoordinates): void {
  if (
    typeof slot.slot_id !== "string"
    || !SAFE_SLOT_ID.test(slot.slot_id)
    || slot.slot_id.includes("..")
  ) {
    throw integrityError("slot_id는 경로 구분자가 없는 안전한 ID여야 합니다.");
  }
  if (!Number.isSafeInteger(slot.sequence) || slot.sequence < 1 || slot.sequence > 999) {
    throw integrityError("slot sequence는 1 이상 999 이하의 정수여야 합니다.");
  }
  if (slot.repetition !== 1 && slot.repetition !== 2) {
    throw integrityError("slot repetition은 1 또는 2여야 합니다.");
  }
}

function assertIdentityHashes(
  value: unknown,
  label: string,
): asserts value is Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw integrityError(`${label}는 hash 이름과 SHA-256 값의 객체여야 합니다.`);
  }
  assertExactKeys(value, IDENTITY_HASH_KEYS, label);
  for (const [key, hash] of Object.entries(value)) {
    if (!SAFE_IDENTITY_KEY.test(key)) {
      throw integrityError(`${label}에 안전하지 않은 identity 이름이 있습니다.`);
    }
    assertSha256(hash, `${label}.${key}`);
  }
}

function assertFiniteNonNegative(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw integrityError(`${label}는 0 이상의 유한한 숫자여야 합니다.`);
  }
}

function assertSafeNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw integrityError(`${label}는 0 이상의 안전한 정수여야 합니다.`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw integrityError(`${label}는 비어 있지 않은 문자열이어야 합니다.`);
  }
}

function assertNullableString(value: unknown, label: string): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw integrityError(`${label}는 문자열 또는 null이어야 합니다.`);
  }
}

function assertRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    requiredKeys.some((key) => !Object.hasOwn(value, key))
    || actual.some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key))
  ) {
    throw integrityError(`${label}의 필수·선택 키 집합이 잠긴 계약과 다릅니다.`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw integrityError(`${label}는 비어 있지 않은 문자열 배열이어야 합니다.`);
  }
}

function assertTokenUsage(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw integrityError(`${label}는 token usage 객체여야 합니다.`);
  }
  assertRequiredAndOptionalKeys(
    value,
    ["cacheWriteTokens", "cachedInputTokens", "inputTokens", "outputTokens"],
    ["reasoningTokens", "totalTokens"],
    label,
  );
  for (const key of Object.keys(value)) {
    assertSafeNonNegativeInteger(value[key], `${label}.${key}`);
  }
  if (
    (value.cachedInputTokens as number) + (value.cacheWriteTokens as number)
    > (value.inputTokens as number)
  ) {
    throw integrityError(`${label}의 cached+cache-write 토큰이 input 토큰보다 큽니다.`);
  }
}

function assertProviderCall(value: unknown, expectedNumber: number, label: string): void {
  if (!isRecord(value)) {
    throw integrityError(`${label}는 provider call 객체여야 합니다.`);
  }
  assertRequiredAndOptionalKeys(
    value,
    [
      "callNumber",
      "latencyMs",
      "modelReportedId",
      "modelRequestedId",
      "responseId",
      "serviceTierReported",
      "serviceTierRequested",
      "status",
      "usage",
    ],
    ["error"],
    label,
  );
  if (value.callNumber !== expectedNumber) {
    throw integrityError(`${label}.callNumber는 1부터 끊김 없이 증가해야 합니다.`);
  }
  if (
    value.status !== "completed"
    && value.status !== "incomplete"
    && value.status !== "failed"
    && value.status !== "refused"
  ) {
    throw integrityError(`${label}.status가 잠긴 enum과 다릅니다.`);
  }
  assertNullableString(value.responseId, `${label}.responseId`);
  assertNonEmptyString(value.modelRequestedId, `${label}.modelRequestedId`);
  assertNullableString(value.modelReportedId, `${label}.modelReportedId`);
  assertNonEmptyString(value.serviceTierRequested, `${label}.serviceTierRequested`);
  assertNullableString(value.serviceTierReported, `${label}.serviceTierReported`);
  assertFiniteNonNegative(value.latencyMs, `${label}.latencyMs`);
  if (value.usage !== null) {
    assertTokenUsage(value.usage, `${label}.usage`);
  }
  if (value.error !== undefined) {
    assertNonEmptyString(value.error, `${label}.error`);
  }
}

function assertRetrievalResult(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw integrityError(`${label}는 retrieval result 객체여야 합니다.`);
  }
  assertRequiredAndOptionalKeys(
    value,
    ["factId", "fileId", "filename", "rank", "score", "sectionId", "sourceId", "text"],
    ["contentChunks"],
    label,
  );
  assertSafeNonNegativeInteger(value.rank, `${label}.rank`);
  if ((value.rank as number) < 1) {
    throw integrityError(`${label}.rank는 1 이상이어야 합니다.`);
  }
  for (const key of ["fileId", "filename", "sourceId", "sectionId", "factId", "text"] as const) {
    assertNonEmptyString(value[key], `${label}.${key}`);
  }
  if (typeof value.score !== "number" || !Number.isFinite(value.score)) {
    throw integrityError(`${label}.score는 유한한 숫자여야 합니다.`);
  }
  if (value.contentChunks !== undefined) {
    assertStringArray(value.contentChunks, `${label}.contentChunks`);
  }
}

function assertArtifactRetrievalCall(
  value: unknown,
  expectedNumber: number,
  label: string,
  completed: boolean,
  expectedVectorStoreIdHash?: string,
): void {
  if (!isRecord(value)) {
    throw integrityError(`${label}는 retrieval call 객체여야 합니다.`);
  }
  const completedKeys = completed
    ? ["asOf", "corpusHash", "evidenceId", "linkedToolCallId", "manifestHash", "origin"]
    : [];
  assertRequiredAndOptionalKeys(
    value,
    [
      "callNumber",
      "latencyMs",
      "maxNumResults",
      "operation",
      "reportedQuery",
      "requestedQuery",
      "results",
      "rewriteQuery",
      "status",
      "vectorStoreIdHash",
      ...completedKeys,
    ],
    ["error"],
    label,
  );
  if (value.callNumber !== expectedNumber || value.operation !== "VECTOR_STORE_SEARCH") {
    throw integrityError(`${label}의 callNumber 또는 operation이 잠긴 계약과 다릅니다.`);
  }
  if (value.status !== "COMPLETE" && value.status !== "FAILED" && value.status !== "TIMEOUT") {
    throw integrityError(`${label}.status가 잠긴 enum과 다릅니다.`);
  }
  assertNonEmptyString(value.requestedQuery, `${label}.requestedQuery`);
  assertNullableString(value.reportedQuery, `${label}.reportedQuery`);
  assertSha256(value.vectorStoreIdHash, `${label}.vectorStoreIdHash`);
  if (
    expectedVectorStoreIdHash !== undefined
    && value.vectorStoreIdHash !== expectedVectorStoreIdHash
  ) {
    throw integrityError(`${label}.vectorStoreIdHash가 실행 identity와 다릅니다.`);
  }
  if (!Number.isSafeInteger(value.maxNumResults) || (value.maxNumResults as number) < 1) {
    throw integrityError(`${label}.maxNumResults는 1 이상의 안전한 정수여야 합니다.`);
  }
  if (typeof value.rewriteQuery !== "boolean") {
    throw integrityError(`${label}.rewriteQuery는 불리언이어야 합니다.`);
  }
  assertFiniteNonNegative(value.latencyMs, `${label}.latencyMs`);
  if (!Array.isArray(value.results)) {
    throw integrityError(`${label}.results는 배열이어야 합니다.`);
  }
  value.results.forEach((result, index) => assertRetrievalResult(result, `${label}.results[${index}]`));
  if (value.error !== undefined) {
    assertNonEmptyString(value.error, `${label}.error`);
  }
  if (completed) {
    assertNonEmptyString(value.evidenceId, `${label}.evidenceId`);
    if (value.origin !== "RUNNER_PREFETCH" && value.origin !== "TOOL_SEARCH") {
      throw integrityError(`${label}.origin이 잠긴 enum과 다릅니다.`);
    }
    assertNullableString(value.linkedToolCallId, `${label}.linkedToolCallId`);
    assertSha256(value.corpusHash, `${label}.corpusHash`);
    assertSha256(value.manifestHash, `${label}.manifestHash`);
    assertNonEmptyString(value.asOf, `${label}.asOf`);
  }
}

function assertToolCall(
  value: unknown,
  expectedNumber: number,
  label: string,
  completed: boolean,
): void {
  if (!isRecord(value)) {
    throw integrityError(`${label}는 tool call 객체여야 합니다.`);
  }
  const completedKeys = completed
    ? ["evidenceId", "linkedRetrievalEvidenceIds", "resultCode", "resultHash"]
    : [];
  assertRequiredAndOptionalKeys(
    value,
    [
      "arguments",
      "argumentsJson",
      "callId",
      "callNumber",
      "latencyMs",
      "modelTurn",
      "providerStatus",
      "result",
      "status",
      "toolName",
      ...completedKeys,
    ],
    ["error"],
    label,
  );
  if (value.callNumber !== expectedNumber) {
    throw integrityError(`${label}.callNumber는 1부터 끊김 없이 증가해야 합니다.`);
  }
  assertSafeNonNegativeInteger(value.modelTurn, `${label}.modelTurn`);
  if ((value.modelTurn as number) < 1) {
    throw integrityError(`${label}.modelTurn은 1 이상이어야 합니다.`);
  }
  assertNonEmptyString(value.callId, `${label}.callId`);
  assertNonEmptyString(value.toolName, `${label}.toolName`);
  if (
    value.status !== "COMPLETE"
    && value.status !== "FAILED"
    && value.status !== "TIMEOUT"
    && value.status !== "LIMIT_EXCEEDED"
  ) {
    throw integrityError(`${label}.status가 잠긴 enum과 다릅니다.`);
  }
  if (!isRecord(value.arguments)) {
    throw integrityError(`${label}.arguments는 객체여야 합니다.`);
  }
  assertCanonicalJson(value.arguments, `${label}.arguments`);
  assertNullableString(value.argumentsJson, `${label}.argumentsJson`);
  assertNullableString(value.providerStatus, `${label}.providerStatus`);
  assertCanonicalJson(value.result, `${label}.result`);
  assertFiniteNonNegative(value.latencyMs, `${label}.latencyMs`);
  if (value.error !== undefined) {
    assertNonEmptyString(value.error, `${label}.error`);
  }
  if (completed) {
    assertNonEmptyString(value.evidenceId, `${label}.evidenceId`);
    assertNonEmptyString(value.resultCode, `${label}.resultCode`);
    assertStringArray(value.linkedRetrievalEvidenceIds, `${label}.linkedRetrievalEvidenceIds`);
    if (value.resultHash !== null) {
      assertSha256(value.resultHash, `${label}.resultHash`);
    }
  }
}

function assertArtifactExecutionEvidence(
  value: unknown,
  label: string,
  completed: boolean,
  expectedVectorStoreIdHash?: string,
): void {
  if (!isRecord(value)) {
    throw integrityError(`${label}는 실행 증거 객체여야 합니다.`);
  }
  const baseKeys = ["providerCalls", "retrievalCalls", "toolCalls"];
  const completedKeys = completed
    ? ["candidateId", "caseId", "finalOutputHash", "finalStatus", "repetition", "slotId"]
    : [];
  assertExactKeys(value, [...baseKeys, ...completedKeys], label);
  if (
    !Array.isArray(value.providerCalls)
    || !Array.isArray(value.retrievalCalls)
    || !Array.isArray(value.toolCalls)
  ) {
    throw integrityError(`${label}의 provider/retrieval/tool calls는 배열이어야 합니다.`);
  }
  value.providerCalls.forEach((call, index) => (
    assertProviderCall(call, index + 1, `${label}.providerCalls[${index}]`)
  ));
  value.retrievalCalls.forEach((call, index) => assertArtifactRetrievalCall(
    call,
    index + 1,
    `${label}.retrievalCalls[${index}]`,
    completed,
    expectedVectorStoreIdHash,
  ));
  value.toolCalls.forEach((call, index) => (
    assertToolCall(call, index + 1, `${label}.toolCalls[${index}]`, completed)
  ));
  if (completed) {
    if (value.finalStatus !== "COMPLETE") {
      throw integrityError(`${label}.finalStatus는 COMPLETE여야 합니다.`);
    }
    assertSha256(value.finalOutputHash, `${label}.finalOutputHash`);
  }
}

function assertCandidateAttempt(
  value: unknown,
  expectedNumber: number,
  label: string,
  expectedVectorStoreIdHash: string,
): void {
  if (!isRecord(value)) {
    throw integrityError(`${label}는 candidate attempt 객체여야 합니다.`);
  }
  assertRequiredAndOptionalKeys(
    value,
    ["attemptNumber", "latencyMs", "startedAt", "status"],
    [
      "error",
      "executionEvidence",
      "modelReportedId",
      "responseId",
      "serviceTierReported",
      "usage",
    ],
    label,
  );
  if (value.attemptNumber !== expectedNumber) {
    throw integrityError(`${label}.attemptNumber는 1부터 끊김 없이 증가해야 합니다.`);
  }
  if (![
    "COMPLETE",
    "INVALID_OUTPUT",
    "TRANSPORT_ERROR",
    "REQUEST_ERROR",
    "TIMEOUT",
    "BUDGET_EXCEEDED",
    "INCOMPLETE",
    "FAILED",
    "REFUSED",
  ].includes(value.status as string)) {
    throw integrityError(`${label}.status가 잠긴 enum과 다릅니다.`);
  }
  assertNonEmptyString(value.startedAt, `${label}.startedAt`);
  if (!Number.isFinite(Date.parse(value.startedAt))) {
    throw integrityError(`${label}.startedAt은 유효한 날짜 문자열이어야 합니다.`);
  }
  assertFiniteNonNegative(value.latencyMs, `${label}.latencyMs`);
  for (const key of ["responseId", "modelReportedId", "serviceTierReported", "error"] as const) {
    if (value[key] !== undefined) {
      assertNonEmptyString(value[key], `${label}.${key}`);
    }
  }
  if (value.usage !== undefined) {
    assertTokenUsage(value.usage, `${label}.usage`);
  }
  if (value.executionEvidence !== undefined) {
    assertArtifactExecutionEvidence(
      value.executionEvidence,
      `${label}.executionEvidence`,
      false,
      expectedVectorStoreIdHash,
    );
  }
}

function assertCandidateRun(
  value: unknown,
  artifact: BenchmarkSlotCoordinates & { identity_hashes: Readonly<Record<string, string>> },
): void {
  if (!isRecord(value)) {
    throw integrityError("slot_result.run은 candidate run 객체여야 합니다.");
  }
  assertRequiredAndOptionalKeys(
    value,
    ["attempts", "runNumber", "status", "totalLatencyMs"],
    ["output"],
    "slot_result.run",
  );
  if (value.runNumber !== artifact.repetition) {
    throw integrityError("slot_result.run.runNumber가 artifact repetition과 다릅니다.");
  }
  if (
    value.status !== "COMPLETE"
    && value.status !== "INVALID"
    && value.status !== "TIMEOUT"
    && value.status !== "BUDGET_EXCEEDED"
  ) {
    throw integrityError("slot_result.run.status가 잠긴 enum과 다릅니다.");
  }
  if (!Array.isArray(value.attempts) || value.attempts.length < 1 || value.attempts.length > 2) {
    throw integrityError("slot_result.run.attempts는 1개 또는 2개여야 합니다.");
  }
  value.attempts.forEach((attempt, index) => (
    assertCandidateAttempt(
      attempt,
      index + 1,
      `slot_result.run.attempts[${index}]`,
      artifact.identity_hashes.policy_vector_store_id_hash,
    )
  ));
  assertFiniteNonNegative(value.totalLatencyMs, "slot_result.run.totalLatencyMs");
  const latencySum = value.attempts.reduce(
    (sum, attempt) => sum + (attempt as Record<string, unknown>).latencyMs as number,
    0,
  );
  if (value.totalLatencyMs !== latencySum) {
    throw integrityError("slot_result.run.totalLatencyMs가 attempt 지연 합계와 다릅니다.");
  }
  const completeAttempts = value.attempts.filter(
    (attempt) => (attempt as Record<string, unknown>).status === "COMPLETE",
  );
  if (value.status === "COMPLETE") {
    if (
      completeAttempts.length !== 1
      || (value.attempts.at(-1) as Record<string, unknown>).status !== "COMPLETE"
      || value.output === undefined
    ) {
      throw integrityError("COMPLETE run에는 마지막 COMPLETE attempt와 output이 필요합니다.");
    }
    try {
      parseCandidateOutput(value.output);
    } catch (error) {
      throw integrityError("slot_result.run.output이 잠긴 후보 출력 스키마와 다릅니다.", error);
    }
  } else if (completeAttempts.length !== 0 || value.output !== undefined) {
    throw integrityError("미완료 run에는 COMPLETE attempt 또는 output이 있을 수 없습니다.");
  }
}

function assertAccessEvidence(
  value: unknown,
  artifact: BenchmarkSlotCoordinates & { identity_hashes: Readonly<Record<string, string>> },
): void {
  if (!isRecord(value)) {
    throw integrityError("slot_result.accessEvidence는 객체여야 합니다.");
  }
  assertExactKeys(value, [
    "candidateId",
    "candidateInputHash",
    "caseId",
    "evaluationCaseHash",
    "orderAccess",
    "policyAccess",
    "repetition",
    "schemaVersion",
    "slotId",
  ], "slot_result.accessEvidence");
  assertBoundEvidence(value, artifact, "slot_result.accessEvidence");
  if (value.schemaVersion !== "runner-input-access-evidence-v1") {
    throw integrityError("slot_result.accessEvidence.schemaVersion이 잠긴 계약과 다릅니다.");
  }
  for (const [key, identityKey] of [
    ["evaluationCaseHash", "slot_case_hash"],
    ["candidateInputHash", "candidate_input_hash"],
  ] as const) {
    assertSha256(value[key], `slot_result.accessEvidence.${key}`);
    if (value[key] !== artifact.identity_hashes[identityKey]) {
      throw integrityError(`slot_result.accessEvidence.${key}가 실행 identity와 다릅니다.`);
    }
  }
  if (!isRecord(value.orderAccess)) {
    throw integrityError("slot_result.accessEvidence.orderAccess는 객체여야 합니다.");
  }
  assertExactKeys(
    value.orderAccess,
    ["channel", "resultCode", "snapshotHash", "status"],
    "slot_result.accessEvidence.orderAccess",
  );
  if (value.orderAccess.channel !== "RUNNER_SNAPSHOT" && value.orderAccess.channel !== "READ_ONLY_TOOL") {
    throw integrityError("slot_result.accessEvidence.orderAccess.channel이 올바르지 않습니다.");
  }
  if (!["SUCCESS", "DENIED", "TIMEOUT", "MISMATCH", "NOT_REQUIRED"].includes(
    value.orderAccess.status as string,
  )) {
    throw integrityError("slot_result.accessEvidence.orderAccess.status가 올바르지 않습니다.");
  }
  if (!["OK", "ORDER_OWNERSHIP_MISMATCH", "TOOL_TIMEOUT", "ORDER_RESULT_MISMATCH", "NOT_REQUIRED"].includes(
    value.orderAccess.resultCode as string,
  )) {
    throw integrityError("slot_result.accessEvidence.orderAccess.resultCode가 올바르지 않습니다.");
  }
  if (value.orderAccess.snapshotHash !== null) {
    assertSha256(value.orderAccess.snapshotHash, "slot_result.accessEvidence.orderAccess.snapshotHash");
  }
  if (!isRecord(value.policyAccess)) {
    throw integrityError("slot_result.accessEvidence.policyAccess는 객체여야 합니다.");
  }
  assertExactKeys(
    value.policyAccess,
    ["corpusHash", "manifestHash", "mode"],
    "slot_result.accessEvidence.policyAccess",
  );
  if (!["INLINE_CORPUS", "RUNNER_RETRIEVAL", "READ_ONLY_TOOL"].includes(
    value.policyAccess.mode as string,
  )) {
    throw integrityError("slot_result.accessEvidence.policyAccess.mode가 올바르지 않습니다.");
  }
  assertSha256(value.policyAccess.corpusHash, "slot_result.accessEvidence.policyAccess.corpusHash");
  assertSha256(value.policyAccess.manifestHash, "slot_result.accessEvidence.policyAccess.manifestHash");
  if (
    value.policyAccess.corpusHash !== artifact.identity_hashes.evaluator_policy_corpus_hash
    || value.policyAccess.manifestHash !== artifact.identity_hashes.evaluator_policy_manifest_hash
  ) {
    throw integrityError("slot_result.accessEvidence의 정책 hash가 실행 identity와 다릅니다.");
  }
  const candidateId = parseSlotIdentity(artifact.slot_id).candidateId;
  const expectedChannel = candidateId === "C" ? "READ_ONLY_TOOL" : "RUNNER_SNAPSHOT";
  const expectedMode = candidateId === "A"
    ? "INLINE_CORPUS"
    : candidateId === "B"
      ? "RUNNER_RETRIEVAL"
      : "READ_ONLY_TOOL";
  if (
    value.orderAccess.channel !== expectedChannel
    || value.policyAccess.mode !== expectedMode
  ) {
    throw integrityError("slot_result.accessEvidence의 후보별 접근 방식이 잠긴 계약과 다릅니다.");
  }
  const expectedResultCodeByStatus: Readonly<Record<string, string>> = {
    SUCCESS: "OK",
    DENIED: "ORDER_OWNERSHIP_MISMATCH",
    TIMEOUT: "TOOL_TIMEOUT",
    MISMATCH: "ORDER_RESULT_MISMATCH",
    NOT_REQUIRED: "NOT_REQUIRED",
  };
  if (value.orderAccess.resultCode !== expectedResultCodeByStatus[value.orderAccess.status as string]) {
    throw integrityError("slot_result.accessEvidence의 order status와 resultCode가 모순됩니다.");
  }
}

function assertUsageCost(value: unknown): void {
  if (!isRecord(value)) {
    throw integrityError("slot_result.usageCost는 UsageCost 객체여야 합니다.");
  }
  assertExactKeys(value, [
    "costBreakdownUsd",
    "currency",
    "model",
    "pricingAsOf",
    "pricingSnapshotId",
    "serviceTier",
    "tokenBreakdown",
    "totalCostUsd",
  ], "slot_result.usageCost");
  for (const key of ["pricingSnapshotId", "pricingAsOf", "model", "serviceTier", "currency"] as const) {
    assertNonEmptyString(value[key], `slot_result.usageCost.${key}`);
  }
  if (!isRecord(value.tokenBreakdown)) {
    throw integrityError("slot_result.usageCost.tokenBreakdown은 객체여야 합니다.");
  }
  assertExactKeys(value.tokenBreakdown, [
    "cacheWriteTokens",
    "cachedInputTokens",
    "outputTokens",
    "regularInputTokens",
  ], "slot_result.usageCost.tokenBreakdown");
  for (const [key, amount] of Object.entries(value.tokenBreakdown)) {
    assertSafeNonNegativeInteger(amount, `slot_result.usageCost.tokenBreakdown.${key}`);
  }
  if (!isRecord(value.costBreakdownUsd)) {
    throw integrityError("slot_result.usageCost.costBreakdownUsd는 객체여야 합니다.");
  }
  assertExactKeys(value.costBreakdownUsd, [
    "cacheWrite",
    "cachedInput",
    "output",
    "regularInput",
  ], "slot_result.usageCost.costBreakdownUsd");
  for (const [key, amount] of Object.entries(value.costBreakdownUsd)) {
    assertFiniteNonNegative(amount, `slot_result.usageCost.costBreakdownUsd.${key}`);
  }
  assertFiniteNonNegative(value.totalCostUsd, "slot_result.usageCost.totalCostUsd");
  const summedCost =
    (value.costBreakdownUsd.regularInput as number)
    + (value.costBreakdownUsd.cachedInput as number)
    + (value.costBreakdownUsd.cacheWrite as number)
    + (value.costBreakdownUsd.output as number);
  if (value.totalCostUsd !== summedCost) {
    throw integrityError("slot_result.usageCost.totalCostUsd가 항목별 비용 합계와 다릅니다.");
  }
}

function parseSlotIdentity(slotId: string): {
  caseId: string;
  candidateId: "A" | "B" | "C";
  repetition: 1 | 2;
} {
  const match = /^(.*)--([ABC])--r([12])$/.exec(slotId);
  if (match === null || match[1].length === 0) {
    throw integrityError("slot_id가 case·candidate·repetition 형식과 다릅니다.");
  }
  return {
    caseId: match[1],
    candidateId: match[2] as "A" | "B" | "C",
    repetition: Number(match[3]) as 1 | 2,
  };
}

function assertCanonicalJson(value: unknown, label: string): void {
  try {
    canonicalJsonStringify(value);
  } catch (error) {
    throw integrityError(`${label}는 canonical JSON이어야 합니다.`, error);
  }
}

function assertGateResults(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 4) {
    throw integrityError("EVALUATED evaluationState에는 결정적 gate 4개가 필요합니다.");
  }
  const expectedCodes = ["P0-HG-01", "P0-HG-02", "P0-HG-03", "P0-HG-04"];
  const actualCodes: string[] = [];
  for (const [index, gate] of value.entries()) {
    if (!isRecord(gate)) {
      throw integrityError(`evaluationState.gates[${index}]는 객체여야 합니다.`);
    }
    assertExactKeys(
      gate,
      ["findings", "gateCode", "riskCandidates", "status"],
      `evaluationState.gates[${index}]`,
    );
    if (
      typeof gate.gateCode !== "string"
      || !expectedCodes.includes(gate.gateCode)
      || (
        gate.status !== "PASS"
        && gate.status !== "CONFIRMED_FAIL"
        && gate.status !== "NOT_APPLICABLE"
      )
      || !Array.isArray(gate.findings)
      || !Array.isArray(gate.riskCandidates)
    ) {
      throw integrityError(`evaluationState.gates[${index}] 계약이 올바르지 않습니다.`);
    }
    gate.findings.forEach((finding, findingIndex) => {
      if (!isRecord(finding)) {
        throw integrityError(`evaluationState.gates[${index}].findings[${findingIndex}]는 객체여야 합니다.`);
      }
      assertExactKeys(
        finding,
        ["code", "evidenceIds", "message"],
        `evaluationState.gates[${index}].findings[${findingIndex}]`,
      );
      assertNonEmptyString(finding.code, `evaluationState.gates[${index}].findings[${findingIndex}].code`);
      assertNonEmptyString(
        finding.message,
        `evaluationState.gates[${index}].findings[${findingIndex}].message`,
      );
      assertStringArray(
        finding.evidenceIds,
        `evaluationState.gates[${index}].findings[${findingIndex}].evidenceIds`,
      );
    });
    gate.riskCandidates.forEach((risk, riskIndex) => {
      if (!isRecord(risk)) {
        throw integrityError(`evaluationState.gates[${index}].riskCandidates[${riskIndex}]는 객체여야 합니다.`);
      }
      assertExactKeys(
        risk,
        ["code", "evidenceIds", "excerpt"],
        `evaluationState.gates[${index}].riskCandidates[${riskIndex}]`,
      );
      assertNonEmptyString(
        risk.code,
        `evaluationState.gates[${index}].riskCandidates[${riskIndex}].code`,
      );
      assertNonEmptyString(
        risk.excerpt,
        `evaluationState.gates[${index}].riskCandidates[${riskIndex}].excerpt`,
      );
      assertStringArray(
        risk.evidenceIds,
        `evaluationState.gates[${index}].riskCandidates[${riskIndex}].evidenceIds`,
      );
    });
    if (
      (gate.status === "CONFIRMED_FAIL" && gate.findings.length === 0)
      || (gate.status !== "CONFIRMED_FAIL" && gate.findings.length !== 0)
    ) {
      throw integrityError(`evaluationState.gates[${index}]의 status와 findings가 모순됩니다.`);
    }
    actualCodes.push(gate.gateCode);
  }
  if (actualCodes.some((code, index) => code !== expectedCodes[index])) {
    throw integrityError("결정적 gate는 P0-HG-01부터 P0-HG-04까지 잠긴 순서여야 합니다.");
  }
}

function assertEvaluationState(
  value: unknown,
): asserts value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw integrityError("evaluationState는 JSON 객체여야 합니다.");
  }
  if (value.status === "EVALUATED") {
    assertExactKeys(value, ["gates", "status"], "EVALUATED evaluationState");
    assertGateResults(value.gates);
    return;
  }
  if (value.status === "NOT_EVALUATED") {
    assertExactKeys(value, ["reason", "status"], "NOT_EVALUATED evaluationState");
    if (
      value.reason !== "INVALID_OUTPUT"
      && value.reason !== "INCOMPLETE_RESPONSE"
      && value.reason !== "CANDIDATE_REFUSED"
      && value.reason !== "CANDIDATE_FAILED"
      && value.reason !== "TIMEOUT"
      && value.reason !== "BUDGET_EXCEEDED"
    ) {
      throw integrityError("NOT_EVALUATED reason이 잠긴 enum과 다릅니다.");
    }
    return;
  }
  if (value.status === "EVALUATION_INCOMPLETE") {
    assertExactKeys(
      value,
      ["errorCode", "message", "status"],
      "EVALUATION_INCOMPLETE evaluationState",
    );
    if (
      typeof value.errorCode !== "string"
      || value.errorCode.length === 0
      || typeof value.message !== "string"
      || value.message.length === 0
    ) {
      throw integrityError("EVALUATION_INCOMPLETE 오류 정보가 비어 있습니다.");
    }
    return;
  }
  throw integrityError("evaluationState.status가 잠긴 enum과 다릅니다.");
}

function assertScheduleSlot(
  value: unknown,
  artifact: BenchmarkSlotCoordinates,
): asserts value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw integrityError("receipt slot_result.slot은 객체여야 합니다.");
  }
  assertExactKeys(value, SCHEDULE_SLOT_KEYS, "receipt slot_result.slot");
  const parsed = parseSlotIdentity(artifact.slot_id);
  if (
    value.slot_id !== artifact.slot_id
    || value.sequence !== artifact.sequence
    || value.repetition !== artifact.repetition
    || value.case_id !== parsed.caseId
    || value.candidate_id !== parsed.candidateId
    || !Number.isSafeInteger(value.candidate_position)
    || ![1, 2, 3].includes(value.candidate_position as number)
  ) {
    throw integrityError("receipt slot_result.slot이 artifact 좌표와 다릅니다.");
  }
}

function assertBoundEvidence(
  value: unknown,
  artifact: BenchmarkSlotCoordinates,
  label: string,
): void {
  if (value === null) return;
  if (!isRecord(value)) {
    throw integrityError(`${label}는 객체 또는 null이어야 합니다.`);
  }
  const parsed = parseSlotIdentity(artifact.slot_id);
  if (
    value.slotId !== artifact.slot_id
    || value.repetition !== artifact.repetition
    || value.caseId !== parsed.caseId
    || value.candidateId !== parsed.candidateId
  ) {
    throw integrityError(`${label}가 artifact 좌표와 다릅니다.`);
  }
  assertCanonicalJson(value, label);
}

function assertCompletedExecutionEvidence(
  value: unknown,
  artifact: BenchmarkSlotCoordinates & { identity_hashes: Readonly<Record<string, string>> },
): void {
  assertArtifactExecutionEvidence(
    value,
    "slot_result.completedExecutionEvidence",
    true,
    artifact.identity_hashes.policy_vector_store_id_hash,
  );
  const evidence = value as Record<string, unknown>;
  assertBoundEvidence(evidence, artifact, "slot_result.completedExecutionEvidence");
  if (evidence.finalStatus !== "COMPLETE") {
    throw integrityError("slot_result.completedExecutionEvidence.finalStatus는 COMPLETE여야 합니다.");
  }
  for (const retrieval of evidence.retrievalCalls as Record<string, unknown>[]) {
    if (
      retrieval.corpusHash !== artifact.identity_hashes.evaluator_policy_corpus_hash
      || retrieval.manifestHash !== artifact.identity_hashes.evaluator_policy_manifest_hash
    ) {
      throw integrityError("completed retrieval의 evaluator 정책 hash가 실행 identity와 다릅니다.");
    }
  }
}

function assertSlotResult(
  value: unknown,
  artifact: BenchmarkSlotCoordinates & { identity_hashes: Readonly<Record<string, string>> },
): asserts value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw integrityError("receipt execution.slot_result는 객체여야 합니다.");
  }
  assertExactKeys(value, SLOT_RESULT_KEYS, "receipt execution.slot_result");
  assertScheduleSlot(value.slot, artifact);
  if (
    value.executionStatus !== "COMPLETE"
    && value.executionStatus !== "INVALID"
    && value.executionStatus !== "TIMEOUT"
    && value.executionStatus !== "BUDGET_EXCEEDED"
    && value.executionStatus !== "FAILED"
  ) {
    throw integrityError("slot_result.executionStatus가 잠긴 enum과 다릅니다.");
  }
  if (
    value.requestDisposition !== "NOT_SENT"
    && value.requestDisposition !== "SENT_RESPONSE_RECORDED"
    && value.requestDisposition !== "SENT_OUTCOME_UNKNOWN"
  ) {
    throw integrityError("slot_result.requestDisposition이 잠긴 enum과 다릅니다.");
  }
  if (value.costState !== "COMPLETE" && value.costState !== "COST_INCOMPLETE") {
    throw integrityError("slot_result.costState가 잠긴 enum과 다릅니다.");
  }
  assertFiniteNonNegative(value.totalLatencyMs, "slot_result.totalLatencyMs");
  if (value.run !== null) {
    assertCandidateRun(value.run, artifact);
  }
  if (value.accessEvidence !== null) {
    assertAccessEvidence(value.accessEvidence, artifact);
  }
  if (value.completedExecutionEvidence !== null) {
    assertCompletedExecutionEvidence(value.completedExecutionEvidence, artifact);
  }
  if (value.usageCost !== null) {
    assertUsageCost(value.usageCost);
  }

  if (value.costState === "COST_INCOMPLETE" && value.usageCost !== null) {
    throw integrityError("COST_INCOMPLETE slot에는 완전한 usageCost를 기록할 수 없습니다.");
  }
  if (
    value.requestDisposition === "SENT_OUTCOME_UNKNOWN"
    && value.costState !== "COST_INCOMPLETE"
  ) {
    throw integrityError("SENT_OUTCOME_UNKNOWN slot의 비용 상태는 COST_INCOMPLETE여야 합니다.");
  }
  if (value.run === null) {
    if (
      value.executionStatus !== "FAILED"
      || value.accessEvidence !== null
      || value.completedExecutionEvidence !== null
      || value.totalLatencyMs !== 0
    ) {
      throw integrityError("run 없는 slot은 실행 전 FAILED 증거 계약과 일치해야 합니다.");
    }
    return;
  }

  const run = value.run as Record<string, unknown>;
  if (value.totalLatencyMs !== run.totalLatencyMs || value.accessEvidence === null) {
    throw integrityError("slot 지연 또는 접근 증거가 run과 일치하지 않습니다.");
  }
  const attempts = run.attempts as Record<string, unknown>[];
  const terminalStatus = attempts.at(-1)?.status;
  const expectedExecutionStatus = run.status === "COMPLETE"
    ? "COMPLETE"
    : run.status === "TIMEOUT"
      ? "TIMEOUT"
      : run.status === "BUDGET_EXCEEDED"
        ? "BUDGET_EXCEEDED"
        : ["FAILED", "REFUSED", "TRANSPORT_ERROR", "REQUEST_ERROR"].includes(
            terminalStatus as string,
          )
          ? "FAILED"
          : "INVALID";
  if (value.executionStatus !== expectedExecutionStatus) {
    throw integrityError("slot executionStatus가 run의 종단 상태와 다릅니다.");
  }
  const ledger = inspectProviderUsageLedger(
    attempts as unknown as Parameters<typeof inspectProviderUsageLedger>[0],
  );
  if (ledger.state === "INTEGRITY_ERROR") {
    throw integrityError(ledger.issue ?? "provider usage 원장 무결성 오류입니다.");
  }
  const expectedCostState = ledger.state === "COST_INCOMPLETE"
    ? "COST_INCOMPLETE"
    : "COMPLETE";
  if (value.costState !== expectedCostState) {
    throw integrityError("slot_result.costState가 provider call 비용 원장 상태와 다릅니다.");
  }
  const hasUnknownOutcome = attempts.some((attempt) => {
    const evidence = attempt.executionEvidence as Record<string, unknown> | undefined;
    const calls = evidence?.providerCalls as Record<string, unknown>[] | undefined ?? [];
    return calls.some((call) => call.status === "failed" && call.responseId === null)
      || (
        calls.length === 0
        && ["TRANSPORT_ERROR", "REQUEST_ERROR", "TIMEOUT"].includes(attempt.status as string)
      );
  });
  const providerCallCount = attempts.reduce((sum, attempt) => {
    const evidence = attempt.executionEvidence as Record<string, unknown> | undefined;
    const calls = evidence?.providerCalls as unknown[] | undefined ?? [];
    return sum + calls.length;
  }, 0);
  const expectedRequestDisposition = hasUnknownOutcome
    ? "SENT_OUTCOME_UNKNOWN"
    : providerCallCount > 0 || attempts.some((attempt) => attempt.usage !== undefined)
      ? "SENT_RESPONSE_RECORDED"
      : "NOT_SENT";
  if (value.requestDisposition !== expectedRequestDisposition) {
    throw integrityError(
      "slot_result.requestDisposition이 terminal run의 provider 전송 증거와 다릅니다.",
    );
  }
  const expectedUsageCost = ledger.state === "COMPLETE"
    ? calculateUsageCost(ledger.providerCallUsages, DEFAULT_PRICING_SNAPSHOT)
    : null;
  if (ledger.state === "COMPLETE" && expectedUsageCost === null) {
    const knownFreeLocalBudget = (
      value.executionStatus === "BUDGET_EXCEEDED"
      && run.status === "BUDGET_EXCEEDED"
      && value.requestDisposition === "NOT_SENT"
      && providerCallCount === 0
      && attempts.length === 1
      && terminalStatus === "BUDGET_EXCEEDED"
      && attempts[0].responseId === undefined
      && attempts[0].modelReportedId === undefined
      && attempts[0].serviceTierReported === undefined
      && attempts[0].usage === undefined
      && attempts[0].executionEvidence === undefined
    );
    if (!knownFreeLocalBudget) {
      throw integrityError(
        "provider 호출 0회의 null 비용은 알려진 로컬 BUDGET_EXCEEDED에만 허용됩니다.",
      );
    }
  }
  if (canonicalJsonStringify(value.usageCost) !== canonicalJsonStringify(expectedUsageCost)) {
    throw integrityError("slot_result.usageCost가 provider call 원장과 잠긴 가격표의 재계산 결과와 다릅니다.");
  }
  if (run.status !== "COMPLETE" && value.completedExecutionEvidence !== null) {
    throw integrityError("미완료 run에는 completedExecutionEvidence가 있을 수 없습니다.");
  }
  if (value.completedExecutionEvidence !== null) {
    const completed = value.completedExecutionEvidence as Record<string, unknown>;
    if (completed.finalOutputHash !== sha256CanonicalJson(run.output)) {
      throw integrityError("completedExecutionEvidence의 output hash가 run.output과 다릅니다.");
    }
    const finalAttempt = attempts.at(-1)!;
    const finalEvidence = finalAttempt.executionEvidence as Record<string, unknown> | undefined;
    const completedRetrievalCalls = (completed.retrievalCalls as Record<string, unknown>[]).map(
      ({
        asOf: _asOf,
        corpusHash: _corpusHash,
        evidenceId: _evidenceId,
        linkedToolCallId: _linkedToolCallId,
        manifestHash: _manifestHash,
        origin: _origin,
        ...call
      }) => call,
    );
    const completedToolCalls = (completed.toolCalls as Record<string, unknown>[]).map(({
      evidenceId: _evidenceId,
      linkedRetrievalEvidenceIds: _linkedRetrievalEvidenceIds,
      resultCode: _resultCode,
      resultHash: _resultHash,
      ...call
    }) => call);
    if (
      finalEvidence === undefined
      || canonicalJsonStringify(completed.providerCalls)
        !== canonicalJsonStringify(finalEvidence.providerCalls)
      || canonicalJsonStringify(completedRetrievalCalls)
        !== canonicalJsonStringify(finalEvidence.retrievalCalls)
      || canonicalJsonStringify(completedToolCalls)
        !== canonicalJsonStringify(finalEvidence.toolCalls)
    ) {
      throw integrityError("completed evidence가 최종 COMPLETE attempt와 다릅니다.");
    }
  }
}

function assertIntentExecution(
  value: unknown,
  artifact: BenchmarkSlotCoordinates & { identity_hashes: Readonly<Record<string, string>> },
): asserts value is BenchmarkSlotIntentExecution {
  if (!isRecord(value)) {
    throw integrityError("intent execution은 객체여야 합니다.");
  }
  assertExactKeys(value, INTENT_EXECUTION_KEYS, "intent execution");
  const parsed = parseSlotIdentity(artifact.slot_id);
  if (
    value.schema_version !== "benchmark-slot-intent-v1"
    || value.candidate_id !== parsed.candidateId
    || value.run_number !== artifact.repetition
  ) {
    throw integrityError("intent execution이 artifact candidate·repetition과 다릅니다.");
  }
  assertSha256(value.invocation_hash, "intent execution.invocation_hash");
  if (value.invocation_hash !== artifact.identity_hashes.invocation_hash) {
    throw integrityError("intent invocation_hash가 identity_hashes와 다릅니다.");
  }
}

function assertReceiptExecution(
  value: unknown,
  artifact: BenchmarkSlotCoordinates & { identity_hashes: Readonly<Record<string, string>> },
): asserts value is BenchmarkSlotReceiptExecution {
  if (!isRecord(value)) {
    throw integrityError("receipt execution은 객체여야 합니다.");
  }
  assertExactKeys(value, RECEIPT_EXECUTION_KEYS, "receipt execution");
  if (value.schema_version !== "benchmark-slot-receipt-v1") {
    throw integrityError("receipt execution.schema_version이 잠긴 계약과 다릅니다.");
  }
  assertSlotResult(value.slot_result, artifact);
}

function assertCheckpointExecution(
  value: unknown,
): asserts value is BenchmarkSlotCheckpointExecution {
  if (!isRecord(value)) {
    throw integrityError("checkpoint execution은 객체여야 합니다.");
  }
  assertExactKeys(value, CHECKPOINT_EXECUTION_KEYS, "checkpoint execution");
  if (value.schema_version !== "benchmark-slot-checkpoint-v1") {
    throw integrityError("checkpoint execution.schema_version이 잠긴 계약과 다릅니다.");
  }
  assertEvaluationState(value.evaluation_state);
}

function assertArtifactPayload(
  value: unknown,
): asserts value is BenchmarkSlotArtifact {
  if (!isRecord(value)) {
    throw integrityError("Benchmark 슬롯 payload는 JSON 객체여야 합니다.");
  }
  if (
    value.artifact_kind !== "BENCHMARK_SLOT_EXECUTION_INTENT"
    && value.artifact_kind !== "BENCHMARK_SLOT_EXECUTION_RECEIPT"
    && value.artifact_kind !== "BENCHMARK_SLOT_EXECUTION_CHECKPOINT"
  ) {
    throw integrityError("Benchmark 슬롯 artifact_kind가 지원되지 않습니다.");
  }
  const artifactKeys = value.artifact_kind === "BENCHMARK_SLOT_EXECUTION_INTENT"
    ? ARTIFACT_BASE_KEYS
    : value.artifact_kind === "BENCHMARK_SLOT_EXECUTION_RECEIPT"
      ? [...ARTIFACT_BASE_KEYS, "intent_payload_sha256"]
      : [...ARTIFACT_BASE_KEYS, "intent_payload_sha256", "receipt_payload_sha256"];
  assertExactKeys(value, artifactKeys, "Benchmark 슬롯 payload");
  assertSha256(value.execution_hash, "execution_hash");
  assertSha256(value.schedule_id, "schedule_id");
  assertSha256(value.slot_identity_hash, "slot_identity_hash");
  assertSlot({
    slot_id: value.slot_id as string,
    sequence: value.sequence as number,
    repetition: value.repetition as 1 | 2,
  });
  assertIdentityHashes(value.identity_hashes, "identity_hashes");
  if (value.artifact_kind === "BENCHMARK_SLOT_EXECUTION_INTENT") {
    assertIntentExecution(value.execution, value as unknown as BenchmarkSlotCoordinates & {
      identity_hashes: Readonly<Record<string, string>>;
    });
    return;
  }
  assertSha256(value.intent_payload_sha256, "intent_payload_sha256");
  if (value.artifact_kind === "BENCHMARK_SLOT_EXECUTION_RECEIPT") {
    assertReceiptExecution(value.execution, value as unknown as BenchmarkSlotCoordinates & {
      identity_hashes: Readonly<Record<string, string>>;
    });
    return;
  }
  assertSha256(value.receipt_payload_sha256, "receipt_payload_sha256");
  assertCheckpointExecution(value.execution);
}

function artifactPathForKind(
  paths: BenchmarkSlotArtifactPaths,
  kind: BenchmarkSlotArtifactKind,
): string {
  if (kind === "BENCHMARK_SLOT_EXECUTION_INTENT") {
    return paths.intentPath;
  }
  if (kind === "BENCHMARK_SLOT_EXECUTION_RECEIPT") {
    return paths.receiptPath;
  }
  return paths.checkpointPath;
}

async function readRegularPrivateFile(filePath: string): Promise<Buffer> {
  let file;
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw integrityError("Benchmark 슬롯 파일을 symlink 없이 열 수 없습니다.", error);
  }

  try {
    const fileStat = await file.stat();
    if (!fileStat.isFile()) {
      throw integrityError("Benchmark 슬롯 목적지는 정규 파일이어야 합니다.");
    }
    if ((fileStat.mode & 0o777) !== 0o600) {
      throw integrityError("Benchmark 슬롯 파일 권한은 정확히 0600이어야 합니다.");
    }
    return await file.readFile();
  } catch (error) {
    if (error instanceof BenchmarkPersistenceIntegrityError) {
      throw error;
    }
    throw integrityError("Benchmark 슬롯 파일을 안전하게 읽을 수 없습니다.", error);
  } finally {
    await file.close();
  }
}

async function assertExactFileBytes(filePath: string, expectedBytes: Buffer): Promise<void> {
  const existingBytes = await readRegularPrivateFile(filePath);
  if (!existingBytes.equals(expectedBytes)) {
    throw integrityError("같은 Benchmark 슬롯 경로의 기존 bytes가 일치하지 않습니다.");
  }
}

async function artifactPathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return false;
    }
    throw integrityError("Benchmark 슬롯 파일 존재 여부를 확인할 수 없습니다.", error);
  }
}

async function assertNoTemporaryArtifacts(slotsDirectory: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(slotsDirectory);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return;
    }
    throw integrityError("Benchmark 슬롯 디렉터리를 검사할 수 없습니다.", error);
  }
  if (entries.some((entry) => entry.includes(".tmp-"))) {
    throw integrityError("완료되지 않은 Benchmark 슬롯 임시 파일이 남아 있습니다.");
  }
}

function assertExpectedArtifactIdentity(
  artifact: BenchmarkSlotArtifact,
  expectedKind: BenchmarkSlotArtifactKind,
  executionHash: string,
  slot: BenchmarkSlotCoordinates,
  expectedIdentity: BenchmarkSlotExpectedIdentity,
): void {
  if (artifact.artifact_kind !== expectedKind) {
    throw integrityError("Benchmark 슬롯 파일 역할과 artifact_kind가 다릅니다.");
  }
  if (artifact.execution_hash !== executionHash) {
    throw integrityError("Benchmark execution_hash가 요청한 실행과 다릅니다.");
  }
  if (
    artifact.slot_id !== slot.slot_id
    || artifact.sequence !== slot.sequence
    || artifact.repetition !== slot.repetition
  ) {
    throw integrityError("Benchmark 슬롯 ID, sequence 또는 repetition이 경로와 다릅니다.");
  }
  if (artifact.schedule_id !== expectedIdentity.scheduleId) {
    throw integrityError("Benchmark schedule_id가 기대 identity와 다릅니다.");
  }
  if (artifact.slot_identity_hash !== expectedIdentity.slotIdentityHash) {
    throw integrityError("Benchmark slot_identity_hash가 기대 identity와 다릅니다.");
  }
  if (
    canonicalJsonStringify(artifact.identity_hashes)
    !== canonicalJsonStringify(expectedIdentity.identityHashes)
  ) {
    throw integrityError("Benchmark 실행 identity hash 집합이 기대 값과 다릅니다.");
  }
}

async function readBenchmarkSlotArtifact(
  filePath: string,
  expectedKind: BenchmarkSlotArtifactKind,
  executionHash: string,
  slot: BenchmarkSlotCoordinates,
  expectedIdentity: BenchmarkSlotExpectedIdentity,
): Promise<BenchmarkSlotArtifact> {
  const storedBytes = await readRegularPrivateFile(filePath);
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(storedBytes.toString("utf8")) as unknown;
  } catch (error) {
    throw integrityError("Benchmark 슬롯 wrapper가 유효한 JSON이 아닙니다.", error);
  }
  if (!isRecord(wrapper)) {
    throw integrityError("Benchmark 슬롯 wrapper는 JSON 객체여야 합니다.");
  }
  assertExactKeys(wrapper, WRAPPER_KEYS, "Benchmark 슬롯 wrapper");
  assertSha256(wrapper.payload_sha256, "payload_sha256");
  assertArtifactPayload(wrapper.payload);

  let actualPayloadHash: string;
  try {
    actualPayloadHash = sha256CanonicalJson(wrapper.payload);
  } catch (error) {
    throw integrityError("Benchmark 슬롯 payload hash를 계산할 수 없습니다.", error);
  }
  if (actualPayloadHash !== wrapper.payload_sha256) {
    throw integrityError("Benchmark 슬롯 payload SHA-256 검증에 실패했습니다.");
  }

  const expectedBytes = Buffer.from(`${canonicalJsonStringify(wrapper)}\n`, "utf8");
  if (!storedBytes.equals(expectedBytes)) {
    throw integrityError("Benchmark 슬롯 wrapper bytes가 canonical 형식과 다릅니다.");
  }

  assertExpectedArtifactIdentity(
    wrapper.payload,
    expectedKind,
    executionHash,
    slot,
    expectedIdentity,
  );
  return wrapper.payload;
}

function expectedIdentityFromArtifact(
  artifact: BenchmarkSlotArtifact,
): BenchmarkSlotExpectedIdentity {
  return {
    scheduleId: artifact.schedule_id,
    slotIdentityHash: artifact.slot_identity_hash,
    identityHashes: artifact.identity_hashes,
  };
}

function assertReceiptFollowsIntent(
  receipt: BenchmarkSlotExecutionReceipt,
  intent: BenchmarkSlotExecutionIntent,
): void {
  if (receipt.intent_payload_sha256 !== sha256CanonicalJson(intent)) {
    throw integrityError("Benchmark receipt의 intent_payload_sha256이 선행 intent와 다릅니다.");
  }
}

function assertCheckpointFollowsReceipt(
  checkpoint: BenchmarkSlotExecutionCheckpoint,
  intent: BenchmarkSlotExecutionIntent,
  receipt: BenchmarkSlotExecutionReceipt,
): void {
  if (checkpoint.intent_payload_sha256 !== sha256CanonicalJson(intent)) {
    throw integrityError("Benchmark checkpoint의 intent_payload_sha256이 선행 intent와 다릅니다.");
  }
  if (checkpoint.receipt_payload_sha256 !== sha256CanonicalJson(receipt)) {
    throw integrityError("Benchmark checkpoint의 receipt_payload_sha256이 선행 receipt와 다릅니다.");
  }

  const slotResult = receipt.execution.slot_result;
  const evaluationState = checkpoint.execution.evaluation_state;
  if (
    evaluationState.status === "EVALUATED"
    && (
      slotResult.executionStatus !== "COMPLETE"
      || slotResult.run === null
      || slotResult.accessEvidence === null
      || slotResult.completedExecutionEvidence === null
    )
  ) {
    throw integrityError(
      "EVALUATED checkpoint에는 COMPLETE receipt와 run·access·execution evidence가 필요합니다.",
    );
  }
  if (
    evaluationState.status === "NOT_EVALUATED"
    && slotResult.executionStatus === "COMPLETE"
  ) {
    throw integrityError("COMPLETE receipt는 NOT_EVALUATED checkpoint와 모순됩니다.");
  }
}

async function readArtifactPredecessors(
  paths: BenchmarkSlotArtifactPaths,
  artifact: BenchmarkSlotExecutionReceipt | BenchmarkSlotExecutionCheckpoint,
): Promise<{
  intent: BenchmarkSlotExecutionIntent;
  receipt?: BenchmarkSlotExecutionReceipt;
}> {
  const expectedIdentity = expectedIdentityFromArtifact(artifact);
  if (!await artifactPathExists(paths.intentPath)) {
    throw integrityError("Benchmark receipt/checkpoint를 저장하려면 선행 intent가 필요합니다.");
  }
  const intent = await readBenchmarkSlotArtifact(
    paths.intentPath,
    "BENCHMARK_SLOT_EXECUTION_INTENT",
    artifact.execution_hash,
    artifact,
    expectedIdentity,
  ) as BenchmarkSlotExecutionIntent;
  if (artifact.artifact_kind === "BENCHMARK_SLOT_EXECUTION_RECEIPT") {
    assertReceiptFollowsIntent(artifact, intent);
    return { intent };
  }

  if (!await artifactPathExists(paths.receiptPath)) {
    throw integrityError("Benchmark checkpoint를 저장하려면 선행 receipt가 필요합니다.");
  }
  const receipt = await readBenchmarkSlotArtifact(
    paths.receiptPath,
    "BENCHMARK_SLOT_EXECUTION_RECEIPT",
    artifact.execution_hash,
    artifact,
    expectedIdentity,
  ) as BenchmarkSlotExecutionReceipt;
  assertReceiptFollowsIntent(receipt, intent);
  assertCheckpointFollowsReceipt(artifact, intent, receipt);
  return { intent, receipt };
}

export function createBenchmarkSlotArtifactPaths({
  outputDirectory,
  executionHash,
  slot,
}: CreatePathsInput): BenchmarkSlotArtifactPaths {
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) {
    throw integrityError("Benchmark outputDirectory가 비어 있습니다.");
  }
  assertSha256(executionHash, "executionHash");
  assertSlot(slot);

  const executionDirectory = join(outputDirectory, executionHash);
  const slotsDirectory = join(executionDirectory, "slots");
  const prefix = `${String(slot.sequence).padStart(3, "0")}--${slot.slot_id}`;
  return Object.freeze({
    executionDirectory,
    slotsDirectory,
    intentPath: join(slotsDirectory, `${prefix}--intent.json`),
    receiptPath: join(slotsDirectory, `${prefix}--receipt.json`),
    checkpointPath: join(slotsDirectory, `${prefix}--checkpoint.json`),
  });
}

async function prepareBenchmarkSlotArtifactDirectories(
  paths: BenchmarkSlotArtifactPaths,
): Promise<void> {
  try {
    await prepareWriteOnceArtifactDirectory({
      rootDirectory: dirname(paths.executionDirectory),
      artifactDirectory: paths.executionDirectory,
    });
    await prepareWriteOnceArtifactDirectory({
      rootDirectory: paths.executionDirectory,
      artifactDirectory: paths.slotsDirectory,
    });
  } catch (error) {
    if (error instanceof BenchmarkPersistenceIntegrityError) throw error;
    throw integrityError(
      "Benchmark 슬롯 authority 디렉터리를 symlink 없이 준비할 수 없습니다.",
      error,
    );
  }
}

export async function persistBenchmarkSlotArtifact({
  outputDirectory,
  artifact,
}: PersistArtifactInput): Promise<string> {
  let snapshot: BenchmarkSlotArtifact;
  try {
    snapshot = JSON.parse(canonicalJsonStringify(artifact)) as BenchmarkSlotArtifact;
  } catch (error) {
    throw integrityError("Benchmark 슬롯 artifact를 canonical JSON snapshot으로 만들 수 없습니다.", error);
  }
  assertArtifactPayload(snapshot);

  const paths = createBenchmarkSlotArtifactPaths({
    outputDirectory,
    executionHash: snapshot.execution_hash,
    slot: snapshot,
  });
  const filePath = artifactPathForKind(paths, snapshot.artifact_kind);
  await prepareBenchmarkSlotArtifactDirectories(paths);
  if (snapshot.artifact_kind !== "BENCHMARK_SLOT_EXECUTION_INTENT") {
    await readArtifactPredecessors(paths, snapshot);
  }
  const wrapper = {
    payload_sha256: sha256CanonicalJson(snapshot),
    payload: snapshot,
  };
  const bytes = Buffer.from(`${canonicalJsonStringify(wrapper)}\n`, "utf8");

  try {
    return await persistWriteOnceFile({
      filePath,
      bytes,
      assertExistingMatches: (existingPath) => assertExactFileBytes(existingPath, bytes),
      assertPublishedFile: (publishedPath) => assertExactFileBytes(publishedPath, bytes),
      requireTemporaryCleanup: true,
    });
  } catch (error) {
    if (error instanceof BenchmarkPersistenceIntegrityError) {
      throw error;
    }
    throw integrityError("Benchmark 슬롯 artifact를 write-once 저장할 수 없습니다.", error);
  }
}

/**
 * 원격 호출 전 실행 의도(intent)를 원자적으로 선점합니다.
 * 새 파일을 실제 생성한 호출자만 `allowRemoteCall: true`를 받습니다.
 */
export async function claimBenchmarkSlotExecutionIntent({
  outputDirectory,
  artifact,
}: ClaimIntentInput): Promise<BenchmarkIntentClaim> {
  let snapshot: BenchmarkSlotExecutionIntent;
  try {
    snapshot = JSON.parse(canonicalJsonStringify(artifact)) as BenchmarkSlotExecutionIntent;
  } catch (error) {
    throw integrityError("Benchmark intent를 canonical JSON snapshot으로 만들 수 없습니다.", error);
  }
  assertArtifactPayload(snapshot);
  if (snapshot.artifact_kind !== "BENCHMARK_SLOT_EXECUTION_INTENT") {
    throw integrityError("원격 호출 claim API는 intent artifact만 받을 수 있습니다.");
  }

  const paths = createBenchmarkSlotArtifactPaths({
    outputDirectory,
    executionHash: snapshot.execution_hash,
    slot: snapshot,
  });
  await prepareBenchmarkSlotArtifactDirectories(paths);
  const wrapper = {
    payload_sha256: sha256CanonicalJson(snapshot),
    payload: snapshot,
  };
  const bytes = Buffer.from(`${canonicalJsonStringify(wrapper)}\n`, "utf8");

  try {
    const claim = await persistWriteOnceFileWithClaim({
      filePath: paths.intentPath,
      bytes,
      assertExistingMatches: (existingPath) => assertExactFileBytes(existingPath, bytes),
      assertPublishedFile: (publishedPath) => assertExactFileBytes(publishedPath, bytes),
      requireTemporaryCleanup: true,
    });
    return Object.freeze({
      path: claim.path,
      created: claim.created,
      allowRemoteCall: claim.created,
    });
  } catch (error) {
    if (error instanceof BenchmarkPersistenceIntegrityError) {
      throw error;
    }
    throw integrityError("Benchmark intent claim을 원자적으로 저장할 수 없습니다.", error);
  }
}

export async function loadBenchmarkSlotResumeState({
  outputDirectory,
  executionHash,
  slot,
  expectedIdentity,
}: LoadResumeStateInput): Promise<BenchmarkSlotResumeState> {
  assertSha256(expectedIdentity.scheduleId, "expectedIdentity.scheduleId");
  assertSha256(expectedIdentity.slotIdentityHash, "expectedIdentity.slotIdentityHash");
  assertIdentityHashes(expectedIdentity.identityHashes, "expectedIdentity.identityHashes");
  const paths = createBenchmarkSlotArtifactPaths({ outputDirectory, executionHash, slot });
  await prepareBenchmarkSlotArtifactDirectories(paths);
  await assertNoTemporaryArtifacts(paths.slotsDirectory);

  const [hasIntent, hasReceipt, hasCheckpoint] = await Promise.all([
    artifactPathExists(paths.intentPath),
    artifactPathExists(paths.receiptPath),
    artifactPathExists(paths.checkpointPath),
  ]);
  if (hasReceipt && !hasIntent) {
    throw integrityError("Benchmark receipt가 intent 없이 존재합니다.");
  }
  if (hasCheckpoint && !hasReceipt) {
    throw integrityError("Benchmark checkpoint가 receipt 없이 존재합니다.");
  }
  if (!hasIntent) {
    return { state: "NONE" };
  }

  const intent = await readBenchmarkSlotArtifact(
    paths.intentPath,
    "BENCHMARK_SLOT_EXECUTION_INTENT",
    executionHash,
    slot,
    expectedIdentity,
  ) as BenchmarkSlotExecutionIntent;
  if (!hasReceipt) {
    return {
      state: "INTENT_ONLY",
      resolution: "AMBIGUOUS_IN_FLIGHT",
      allowRemoteCall: false,
      intent,
    };
  }

  const receipt = await readBenchmarkSlotArtifact(
    paths.receiptPath,
    "BENCHMARK_SLOT_EXECUTION_RECEIPT",
    executionHash,
    slot,
    expectedIdentity,
  ) as BenchmarkSlotExecutionReceipt;
  assertReceiptFollowsIntent(receipt, intent);
  if (!hasCheckpoint) {
    return {
      state: "RECEIPT_ONLY",
      resolution: "RECOMPUTE_GATES",
      allowRemoteCall: false,
      intent,
      receipt,
    };
  }

  const checkpoint = await readBenchmarkSlotArtifact(
    paths.checkpointPath,
    "BENCHMARK_SLOT_EXECUTION_CHECKPOINT",
    executionHash,
    slot,
    expectedIdentity,
  ) as BenchmarkSlotExecutionCheckpoint;
  assertCheckpointFollowsReceipt(checkpoint, intent, receipt);
  return {
    state: "CHECKPOINT",
    resolution: "REUSE",
    intent,
    receipt,
    checkpoint,
  };
}

/** 저장 여부와 무관하게 parent pack이 저장/재개 경로와 동일한 parser를 재사용합니다. */
export function validateBenchmarkSlotArtifactChain({
  intent: rawIntent,
  receipt: rawReceipt,
  checkpoint: rawCheckpoint,
  expectedIdentity,
}: ValidateBenchmarkSlotArtifactChainInput): ValidatedBenchmarkSlotArtifactChain {
  let intent: BenchmarkSlotExecutionIntent;
  let receipt: BenchmarkSlotExecutionReceipt;
  let checkpoint: BenchmarkSlotExecutionCheckpoint;
  try {
    intent = JSON.parse(canonicalJsonStringify(rawIntent)) as BenchmarkSlotExecutionIntent;
    receipt = JSON.parse(canonicalJsonStringify(rawReceipt)) as BenchmarkSlotExecutionReceipt;
    checkpoint = JSON.parse(canonicalJsonStringify(rawCheckpoint)) as BenchmarkSlotExecutionCheckpoint;
  } catch (error) {
    throw integrityError("Benchmark slot chain을 canonical JSON으로 검증할 수 없습니다.", error);
  }
  assertArtifactPayload(intent);
  assertArtifactPayload(receipt);
  assertArtifactPayload(checkpoint);
  assertSha256(expectedIdentity.scheduleId, "expectedIdentity.scheduleId");
  assertSha256(expectedIdentity.slotIdentityHash, "expectedIdentity.slotIdentityHash");
  assertIdentityHashes(expectedIdentity.identityHashes, "expectedIdentity.identityHashes");
  const slot = {
    slot_id: intent.slot_id,
    sequence: intent.sequence,
    repetition: intent.repetition,
  } as const;
  for (const [artifact, kind] of [
    [intent, "BENCHMARK_SLOT_EXECUTION_INTENT"],
    [receipt, "BENCHMARK_SLOT_EXECUTION_RECEIPT"],
    [checkpoint, "BENCHMARK_SLOT_EXECUTION_CHECKPOINT"],
  ] as const) {
    assertExpectedArtifactIdentity(
      artifact,
      kind,
      intent.execution_hash,
      slot,
      expectedIdentity,
    );
  }
  assertReceiptFollowsIntent(receipt, intent);
  assertCheckpointFollowsReceipt(checkpoint, intent, receipt);
  return Object.freeze({ intent, receipt, checkpoint });
}

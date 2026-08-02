import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { types as utilTypes } from "node:util";
import {
  assertNoBlindJudgeIdentityLeak,
} from "../judge/contracts";
import {
  containsBlindReviewArchitectureHint,
} from "../judge/buildJudgeInput";
import {
  assertValidatedRecordedBenchmarkPack,
  type RecordedBenchmarkPack,
} from "../pack/recordedBenchmarkPack";
import {
  assertExistingWriteOnceArtifactDirectory,
  persistWriteOnceFileWithClaim,
  prepareWriteOnceArtifactDirectory,
} from "../pack/persistence";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  assertValidatedBlindReviewQueue,
  calculateBlindReviewQueueContentHash,
  calculateBlindReviewQueueSetOrderHash,
  type BlindReviewQueue,
  type BlindReviewQueueItem,
} from "./buildReviewQueue";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EVIDENCE_HANDLE_PATTERN = /^evh_[a-f0-9]{64}$/;
const PRE_REVIEW_ID_PATTERN = /^apr_[a-f0-9]{64}$/;
const VALIDATED_AI_PRE_REVIEW_RECEIPT = Symbol(
  "ValidatedAiPreReviewReceipt",
);
const VALIDATED_AI_PRE_REVIEW_RECEIPTS = new WeakSet<object>();
const PERSISTED_AI_PRE_REVIEW_RECEIPTS = new WeakSet<object>();
const SOURCE_RELOADED_AI_PRE_REVIEW_RECEIPTS = new WeakSet<object>();
const PERSISTING_AI_PRE_REVIEW_RECEIPTS = new WeakSet<object>();

type JsonRecord = Record<string, unknown>;

export type AiPreReviewDecision =
  | "PROPOSED_PASS"
  | "PROPOSED_CONFIRMED_FAIL"
  | "ABSTAIN";

export interface AiPreReviewCommandItem {
  item_id: string;
  proposed_decision: AiPreReviewDecision;
  rationale: string;
  evidence_handles: string[];
}

export interface AiPreReviewCommand {
  schema_version: "ai-pre-review-command-v1";
  reviewer_label: string;
  expected_recorded_benchmark_pack_hash: string;
  expected_judge_evidence_hash: string;
  expected_queue_content_hash: string;
  expected_queue_set_order_hash: string;
  items: AiPreReviewCommandItem[];
  reviewed_at: string;
}

export type AiPreReviewBlockingReason =
  | "ABSTAIN"
  | "EVIDENCE_CONFLICT"
  | "MISSING_EVIDENCE"
  | "QUEUE_OVERFLOW";

export interface AiPreReviewReceiptItem {
  readonly item_id: string;
  readonly proposed_decision: AiPreReviewDecision;
  readonly rationale: string;
  readonly evidence_handles: readonly `evh_${string}`[];
}

export interface AiPreReviewReceipt {
  readonly schema_version: "ai-pre-review-receipt-v1";
  readonly artifact_kind: "AI_PRE_REVIEW_RECEIPT";
  readonly pre_review_id: `apr_${string}`;
  readonly synthetic: true;
  readonly advisory_only: true;
  readonly human_confirmed: false;
  readonly pre_review_status:
    | "USER_CONFIRMATION_READY"
    | "USER_CONFIRMATION_BLOCKED";
  readonly blocking_reasons: readonly AiPreReviewBlockingReason[];
  readonly recorded_benchmark_pack_hash: string;
  readonly judge_evidence_hash: string;
  readonly queue_content_hash: string;
  readonly queue_set_order_hash: string;
  readonly reviewer_label: string;
  readonly items: readonly AiPreReviewReceiptItem[];
  readonly reviewed_at: string;
  readonly baseline_version: null;
}

export interface AiPreReviewReceiptPaths {
  readonly preReviewDirectory: string;
  readonly claimPath: string;
  readonly receiptPath: string;
}

export interface PersistAiPreReviewReceiptResult {
  readonly path: string;
  readonly created: true;
  readonly payloadSha256: string;
}

/**
 * Judge는 위험 신호를 사람 검수에 전달할 뿐 PASS/FAIL gate가 아닙니다.
 * 따라서 결정적 실패가 없는 PASS 제안과 Judge RISK의 공존은 conflict가
 * 아닙니다. 반대로 결정적 실패도 Judge 근거도 없는 확인 실패 제안은
 * 근거 충돌로 차단합니다.
 */
export function isAiPreReviewProposalEvidenceConflict({
  proposedDecision,
  deterministicGateFinding,
  judgeRiskCount,
}: {
  readonly proposedDecision: AiPreReviewDecision;
  readonly deterministicGateFinding: "NONE" | "CONFIRMED_FAIL";
  readonly judgeRiskCount: number;
}): boolean {
  if (!Number.isSafeInteger(judgeRiskCount) || judgeRiskCount < 0) {
    throw new TypeError("AI pre-review Judge risk count가 유효하지 않습니다.");
  }
  return proposedDecision === "PROPOSED_CONFIRMED_FAIL"
    && deterministicGateFinding !== "CONFIRMED_FAIL"
    && judgeRiskCount === 0;
}

function readPlainRecord(value: unknown, location: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${location}은(는) plain 객체여야 합니다.`);
  }
  if (utilTypes.isProxy(value)) {
    throw new TypeError(`${location}은(는) Proxy가 아닌 plain data 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${location}은(는) plain 객체여야 합니다.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") {
      throw new TypeError(`${location}에는 Symbol 속성을 둘 수 없습니다.`);
    }
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) {
      throw new TypeError(
        `${location}.${key}는 getter/setter accessor가 아닌 plain data property여야 합니다.`,
      );
    }
  }
  return value as JsonRecord;
}

function readPlainArray(value: unknown, location: string): unknown[] {
  if (
    !Array.isArray(value)
    || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError(`${location}은(는) Proxy가 아닌 plain data 배열이어야 합니다.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
  ) {
    throw new TypeError(`${location}.length는 plain data property여야 합니다.`);
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length > 256) {
    throw new TypeError(`${location}.length가 잠긴 최대 plain data 범위를 초과합니다.`);
  }
  const allowedKeys = new Set(["length", ...Array.from(
    { length },
    (_, index) => String(index),
  )]);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== "string" || !allowedKeys.has(key),
    )
  ) {
    throw new TypeError(`${location}에는 index 외 추가·Symbol 속성을 둘 수 없습니다.`);
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(
        `${location}[${index}]는 getter/setter 또는 hole이 아닌 plain data property여야 합니다.`,
      );
    }
    return descriptor.value;
  });
}

function assertExactKeys(
  record: JsonRecord,
  expectedKeys: readonly string[],
  location: string,
): void {
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(record, key));
  const additional = Object.getOwnPropertyNames(record).filter(
    (key) => !expected.has(key),
  );
  if (missing.length > 0 || additional.length > 0) {
    throw new TypeError(
      `${location}의 exact 계약이 다릅니다. 누락=${missing.join(",")} 추가=${additional.join(",")}`,
    );
  }
}

function assertSha256(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${location}는 64자리 소문자 SHA-256이어야 합니다.`);
  }
}

function assertIsoTimestamp(value: unknown, location: string): asserts value is string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${location}는 canonical ISO-8601 timestamp여야 합니다.`);
  }
}

function readNonEmptyText(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${location}는 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value.trim();
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function assertBlindAdvisoryText(value: string, location: string): void {
  assertNoBlindJudgeIdentityLeak(value, location);
  if (containsBlindReviewArchitectureHint(value)) {
    throw new TypeError(`${location}에 후보 identity 또는 architecture 누출이 있습니다.`);
  }
}

function allowedEvidenceHandles(item: BlindReviewQueueItem): ReadonlySet<string> {
  return new Set([
    item.judge_evidence_handle,
    ...item.runs.map((run) => run.evidence_handle),
    ...item.deterministic_gate_evidence.flatMap((gate) => [
      gate.evidence_handle,
      ...gate.findings.flatMap((finding) => [
        finding.source_finding_handle,
        finding.source_message_handle,
        ...finding.evidence_locations.map((location) => location.reference_handle),
      ]),
    ]),
  ]);
}

function assertArtifactChain(
  benchmarkPack: RecordedBenchmarkPack,
  queue: BlindReviewQueue,
): {
  readonly packHash: string;
  readonly judgeEvidenceHash: string;
  readonly queueContentHash: string;
  readonly queueSetOrderHash: string;
} {
  assertValidatedRecordedBenchmarkPack(benchmarkPack);
  assertValidatedBlindReviewQueue(queue);
  const packHash = sha256CanonicalJson(benchmarkPack);
  if (
    benchmarkPack.source !== "RECORDED_BENCHMARK"
    || benchmarkPack.execution_status !== "EXECUTION_COMPLETE"
    || (
      benchmarkPack.judge_status !== "JUDGE_COMPLETE"
      && benchmarkPack.judge_status !== "JUDGE_PARTIAL_HUMAN_FALLBACK"
    )
    || benchmarkPack.review_status !== "REVIEW_PENDING"
    || queue !== benchmarkPack.blind_review_queue
    || queue.execution_pack_hash !== benchmarkPack.execution_pack_hash
    || benchmarkPack.queue_content_hash !== queue.queue_content_hash
    || benchmarkPack.queue_set_order_hash !== queue.queue_set_order_hash
  ) {
    throw new TypeError(
      "AI pre-review artifact chain은 검증된 Recorded Benchmark와 그 queue에 정확히 결합돼야 합니다.",
    );
  }
  return {
    packHash,
    judgeEvidenceHash: benchmarkPack.judge_evidence_pack_hash,
    queueContentHash: calculateBlindReviewQueueContentHash(queue),
    queueSetOrderHash: calculateBlindReviewQueueSetOrderHash(queue),
  };
}

/**
 * Judge의 위험 신호와 opaque evidence handle만 content-addressing합니다.
 * 후보의 실제 ID·구조·비용은 이 digest 입력에 포함되지 않습니다.
 */
export function calculateBlindQueueJudgeEvidenceHash(
  queue: BlindReviewQueue,
): string {
  assertValidatedBlindReviewQueue(queue);
  return sha256CanonicalJson({
    schema_version: "blind-queue-judge-evidence-v1",
    execution_pack_hash: queue.execution_pack_hash,
    ordered_items: queue.items.map((item) => ({
      item_id: item.item_id,
      judge_evidence_handle: item.judge_evidence_handle,
      judge_risks: item.judge_risks,
      deterministic_gate_finding: item.deterministic_gate_finding,
      deterministic_gate_evidence: item.deterministic_gate_evidence,
      run_evidence_handles: item.runs.map((run) => run.evidence_handle),
    })),
  });
}

function parseCommand(
  command: unknown,
  queue: BlindReviewQueue,
  source: ReturnType<typeof assertArtifactChain>,
): {
  readonly reviewerLabel: string;
  readonly items: AiPreReviewReceiptItem[];
  readonly reviewedAt: string;
  readonly blockingReasons: AiPreReviewBlockingReason[];
} {
  const record = readPlainRecord(command, "AI pre-review command");
  assertExactKeys(record, [
    "schema_version",
    "reviewer_label",
    "expected_recorded_benchmark_pack_hash",
    "expected_judge_evidence_hash",
    "expected_queue_content_hash",
    "expected_queue_set_order_hash",
    "items",
    "reviewed_at",
  ], "AI pre-review command");
  if (record.schema_version !== "ai-pre-review-command-v1") {
    throw new TypeError("AI pre-review command schema version이 다릅니다.");
  }
  const reviewerLabel = readNonEmptyText(
    record.reviewer_label,
    "AI pre-review command.reviewer_label",
  );
  assertBlindAdvisoryText(reviewerLabel, "AI pre-review reviewer label");
  if (
    record.expected_recorded_benchmark_pack_hash !== source.packHash
    || record.expected_judge_evidence_hash !== source.judgeEvidenceHash
    || record.expected_queue_content_hash !== source.queueContentHash
    || record.expected_queue_set_order_hash !== source.queueSetOrderHash
  ) {
    throw new TypeError("AI pre-review command의 stale source/queue hash가 일치하지 않습니다.");
  }
  assertIsoTimestamp(record.reviewed_at, "AI pre-review command.reviewed_at");
  const commandItems = readPlainArray(
    record.items,
    "AI pre-review command.items",
  );
  if (commandItems.length !== queue.items.length) {
    throw new TypeError("AI pre-review command는 queue item을 누락·추가 없이 모두 포함해야 합니다.");
  }

  const blockingReasons = new Set<AiPreReviewBlockingReason>();
  if (queue.queue_status !== "READY_FOR_REVIEW") blockingReasons.add("QUEUE_OVERFLOW");
  const seen = new Set<string>();
  const items = commandItems.map((value, index): AiPreReviewReceiptItem => {
    const item = readPlainRecord(value, `AI pre-review command.items[${index}]`);
    assertExactKeys(item, [
      "item_id",
      "proposed_decision",
      "rationale",
      "evidence_handles",
    ], `AI pre-review command.items[${index}]`);
    const expected = queue.items[index];
    if (
      typeof item.item_id !== "string"
      || item.item_id !== expected.item_id
      || seen.has(item.item_id)
    ) {
      throw new TypeError(
        `AI pre-review item ${index}의 queue 순서·ID가 다르거나 중복됐습니다.`,
      );
    }
    seen.add(item.item_id);
    if (
      item.proposed_decision !== "PROPOSED_PASS"
      && item.proposed_decision !== "PROPOSED_CONFIRMED_FAIL"
      && item.proposed_decision !== "ABSTAIN"
    ) {
      throw new TypeError(`AI pre-review item ${index}의 proposed decision이 다릅니다.`);
    }
    if (
      expected.deterministic_gate_finding === "CONFIRMED_FAIL"
      && item.proposed_decision === "PROPOSED_PASS"
    ) {
      throw new TypeError(
        `AI pre-review item ${index}는 deterministic CONFIRMED_FAIL을 PASS로 override할 수 없습니다.`,
      );
    }
    const rationale = readNonEmptyText(
      item.rationale,
      `AI pre-review command.items[${index}].rationale`,
    );
    assertBlindAdvisoryText(
      rationale,
      `AI pre-review command.items[${index}].rationale`,
    );
    const rawEvidenceHandles = readPlainArray(
      item.evidence_handles,
      `AI pre-review item ${index}.evidence_handles`,
    );
    const allowed = allowedEvidenceHandles(expected);
    const evidenceHandles = rawEvidenceHandles.map((handle, evidenceIndex) => {
      if (
        typeof handle !== "string"
        || !EVIDENCE_HANDLE_PATTERN.test(handle)
        || !allowed.has(handle)
      ) {
        throw new TypeError(
          `AI pre-review item ${index}의 evidence ${evidenceIndex}는 queue가 허용한 opaque evidence가 아닙니다.`,
        );
      }
      return handle as `evh_${string}`;
    });
    if (new Set(evidenceHandles).size !== evidenceHandles.length) {
      throw new TypeError(`AI pre-review item ${index}의 evidence handle이 중복됐습니다.`);
    }
    if (evidenceHandles.length === 0) blockingReasons.add("MISSING_EVIDENCE");
    if (item.proposed_decision === "ABSTAIN") blockingReasons.add("ABSTAIN");
    if (isAiPreReviewProposalEvidenceConflict({
      proposedDecision: item.proposed_decision,
      deterministicGateFinding: expected.deterministic_gate_finding,
      judgeRiskCount: expected.judge_risks.length,
    })) {
      blockingReasons.add("EVIDENCE_CONFLICT");
    }
    return {
      item_id: expected.item_id,
      proposed_decision: item.proposed_decision,
      rationale,
      evidence_handles: evidenceHandles,
    };
  });

  return {
    reviewerLabel,
    items,
    reviewedAt: record.reviewed_at,
    blockingReasons: [...blockingReasons].sort(),
  };
}

function preReviewIdFor(source: ReturnType<typeof assertArtifactChain>): `apr_${string}` {
  return `apr_${sha256CanonicalJson({
    schema_version: "ai-pre-review-authority-id-v1",
    recorded_benchmark_pack_hash: source.packHash,
    judge_evidence_hash: source.judgeEvidenceHash,
    queue_content_hash: source.queueContentHash,
    queue_set_order_hash: source.queueSetOrderHash,
  })}`;
}

function brandAiPreReviewReceipt(receipt: AiPreReviewReceipt): AiPreReviewReceipt {
  Object.defineProperty(receipt, VALIDATED_AI_PRE_REVIEW_RECEIPT, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  VALIDATED_AI_PRE_REVIEW_RECEIPTS.add(receipt);
  return deepFreeze(receipt);
}

export function assertValidatedAiPreReviewReceipt(
  value: unknown,
): asserts value is AiPreReviewReceipt {
  if (
    typeof value !== "object"
    || value === null
    || !VALIDATED_AI_PRE_REVIEW_RECEIPTS.has(value)
    || (value as Record<PropertyKey, unknown>)[VALIDATED_AI_PRE_REVIEW_RECEIPT]
      !== true
    || !Object.isFrozen(value)
  ) {
    throw new TypeError(
      "AI pre-review receipt는 authoritative build/load가 만든 동일 validated 객체여야 합니다.",
    );
  }
}

export function assertPersistedAiPreReviewReceipt(
  value: unknown,
): asserts value is AiPreReviewReceipt {
  assertValidatedAiPreReviewReceipt(value);
  if (!SOURCE_RELOADED_AI_PRE_REVIEW_RECEIPTS.has(value)) {
    throw new TypeError(
      "AI pre-review 권위에는 write-once 저장 후 source에서 다시 로드한 persisted receipt가 필요합니다.",
    );
  }
}

export function buildAiPreReviewReceipt({
  benchmarkPack,
  queue,
  command,
}: {
  readonly benchmarkPack: RecordedBenchmarkPack;
  readonly queue: BlindReviewQueue;
  readonly command: AiPreReviewCommand;
}): AiPreReviewReceipt {
  const source = assertArtifactChain(benchmarkPack, queue);
  const parsed = parseCommand(command, queue, source);
  const receipt: AiPreReviewReceipt = {
    schema_version: "ai-pre-review-receipt-v1",
    artifact_kind: "AI_PRE_REVIEW_RECEIPT",
    pre_review_id: preReviewIdFor(source),
    synthetic: true,
    advisory_only: true,
    human_confirmed: false,
    pre_review_status: parsed.blockingReasons.length === 0
      ? "USER_CONFIRMATION_READY"
      : "USER_CONFIRMATION_BLOCKED",
    blocking_reasons: parsed.blockingReasons,
    recorded_benchmark_pack_hash: source.packHash,
    judge_evidence_hash: source.judgeEvidenceHash,
    queue_content_hash: source.queueContentHash,
    queue_set_order_hash: source.queueSetOrderHash,
    reviewer_label: parsed.reviewerLabel,
    items: parsed.items,
    reviewed_at: parsed.reviewedAt,
    baseline_version: null,
  };
  return brandAiPreReviewReceipt(receipt);
}

function receiptCommandFromSnapshot(snapshot: AiPreReviewReceipt): AiPreReviewCommand {
  return {
    schema_version: "ai-pre-review-command-v1",
    reviewer_label: snapshot.reviewer_label,
    expected_recorded_benchmark_pack_hash: snapshot.recorded_benchmark_pack_hash,
    expected_judge_evidence_hash: snapshot.judge_evidence_hash,
    expected_queue_content_hash: snapshot.queue_content_hash,
    expected_queue_set_order_hash: snapshot.queue_set_order_hash,
    items: snapshot.items.map((item) => ({
      item_id: item.item_id,
      proposed_decision: item.proposed_decision,
      rationale: item.rationale,
      evidence_handles: [...item.evidence_handles],
    })),
    reviewed_at: snapshot.reviewed_at,
  };
}

function parsePersistedSnapshot(
  value: unknown,
  benchmarkPack: RecordedBenchmarkPack,
  queue: BlindReviewQueue,
): AiPreReviewReceipt {
  const wrapper = readPlainRecord(value, "AI pre-review persisted wrapper");
  assertExactKeys(wrapper, ["payload_sha256", "payload"], "AI pre-review persisted wrapper");
  assertSha256(wrapper.payload_sha256, "AI pre-review persisted payload hash");
  const payload = readPlainRecord(wrapper.payload, "AI pre-review persisted payload");
  assertExactKeys(payload, [
    "schema_version",
    "artifact_kind",
    "pre_review_id",
    "synthetic",
    "advisory_only",
    "human_confirmed",
    "pre_review_status",
    "blocking_reasons",
    "recorded_benchmark_pack_hash",
    "judge_evidence_hash",
    "queue_content_hash",
    "queue_set_order_hash",
    "reviewer_label",
    "items",
    "reviewed_at",
    "baseline_version",
  ], "AI pre-review persisted payload");
  if (
    payload.schema_version !== "ai-pre-review-receipt-v1"
    || payload.artifact_kind !== "AI_PRE_REVIEW_RECEIPT"
    || typeof payload.pre_review_id !== "string"
    || !PRE_REVIEW_ID_PATTERN.test(payload.pre_review_id)
    || payload.synthetic !== true
    || payload.advisory_only !== true
    || payload.human_confirmed !== false
    || payload.baseline_version !== null
    || !Array.isArray(payload.items)
    || !Array.isArray(payload.blocking_reasons)
    || sha256CanonicalJson(payload) !== wrapper.payload_sha256
  ) {
    throw new TypeError("AI pre-review persisted payload 무결성 또는 상태 계약이 다릅니다.");
  }
  const snapshot = payload as unknown as AiPreReviewReceipt;
  const rebuilt = buildAiPreReviewReceipt({
    benchmarkPack,
    queue,
    command: receiptCommandFromSnapshot(snapshot),
  });
  if (canonicalJsonStringify(rebuilt) !== canonicalJsonStringify(snapshot)) {
    throw new TypeError("AI pre-review persisted receipt가 authoritative source와 다릅니다.");
  }
  return rebuilt;
}

async function readSecureCanonicalFile(
  path: string,
  location: string,
  expectedNlink = 1,
): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== expectedNlink
    ) {
      throw new TypeError(
        `${location}는 nlink ${expectedNlink}인 regular 0600 파일이어야 합니다.`,
      );
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${location} symlink 또는 안전하지 않은 파일을 읽을 수 없습니다.`, {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

async function assertExactFileBytes(
  path: string,
  expected: Buffer,
  location: string,
  expectedNlink = 1,
): Promise<void> {
  const actual = await readSecureCanonicalFile(path, location, expectedNlink);
  if (!actual.equals(expected)) {
    throw new TypeError(`${location}의 기존 bytes가 authoritative canonical 내용과 일치하지 않습니다.`);
  }
}

export function createAiPreReviewReceiptPaths({
  outputDirectory,
  preReviewId,
  payloadSha256,
}: {
  readonly outputDirectory: string;
  readonly preReviewId: string;
  readonly payloadSha256: string;
}): AiPreReviewReceiptPaths {
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) {
    throw new TypeError("AI pre-review outputDirectory가 비어 있습니다.");
  }
  if (!PRE_REVIEW_ID_PATTERN.test(preReviewId)) {
    throw new TypeError("AI pre-review ID가 안전한 content-addressed ID가 아닙니다.");
  }
  assertSha256(payloadSha256, "AI pre-review payloadSha256");
  const preReviewDirectory = join(outputDirectory, preReviewId);
  return Object.freeze({
    preReviewDirectory,
    claimPath: join(preReviewDirectory, "ai-pre-review--claim.json"),
    receiptPath: join(
      preReviewDirectory,
      `ai-pre-review--record-${payloadSha256}.json`,
    ),
  });
}

export async function persistAiPreReviewReceipt({
  outputDirectory,
  receipt,
}: {
  readonly outputDirectory: string;
  readonly receipt: AiPreReviewReceipt;
}): Promise<PersistAiPreReviewReceiptResult> {
  assertValidatedAiPreReviewReceipt(receipt);
  if (
    PERSISTED_AI_PRE_REVIEW_RECEIPTS.has(receipt)
    || PERSISTING_AI_PRE_REVIEW_RECEIPTS.has(receipt)
  ) {
    throw new TypeError("동일 AI pre-review receipt 객체의 persistence replay는 허용되지 않습니다.");
  }
  PERSISTING_AI_PRE_REVIEW_RECEIPTS.add(receipt);
  try {
    const snapshot = JSON.parse(canonicalJsonStringify(receipt)) as AiPreReviewReceipt;
    const payloadSha256 = sha256CanonicalJson(snapshot);
    const paths = createAiPreReviewReceiptPaths({
      outputDirectory,
      preReviewId: snapshot.pre_review_id,
      payloadSha256,
    });
    await prepareWriteOnceArtifactDirectory({
      rootDirectory: outputDirectory,
      artifactDirectory: paths.preReviewDirectory,
    });
    const claim = {
      schema_version: "ai-pre-review-claim-v1",
      artifact_kind: "AI_PRE_REVIEW_CLAIM",
      pre_review_id: snapshot.pre_review_id,
      payload_sha256: payloadSha256,
    };
    const claimBytes = Buffer.from(`${canonicalJsonStringify({
      payload_sha256: sha256CanonicalJson(claim),
      payload: claim,
    })}\n`, "utf8");
    const receiptBytes = Buffer.from(`${canonicalJsonStringify({
      payload_sha256: payloadSha256,
      payload: snapshot,
    })}\n`, "utf8");
    const claimResult = await persistWriteOnceFileWithClaim({
      filePath: paths.claimPath,
      bytes: claimBytes,
      assertExistingMatches: (path) => assertExactFileBytes(
        path,
        claimBytes,
        "AI pre-review claim",
      ),
      assertPublishedFile: (path) => assertExactFileBytes(
        path,
        claimBytes,
        "AI pre-review claim",
      ),
      requireTemporaryCleanup: true,
    });
    if (!claimResult.created) {
      throw new TypeError("AI pre-review claim은 이미 존재하므로 replay할 수 없습니다.");
    }
    const recordResult = await persistWriteOnceFileWithClaim({
      filePath: paths.receiptPath,
      bytes: receiptBytes,
      assertExistingMatches: (path) => assertExactFileBytes(
        path,
        receiptBytes,
        "AI pre-review receipt",
      ),
      assertPublishedFile: (path) => assertExactFileBytes(
        path,
        receiptBytes,
        "AI pre-review receipt",
      ),
      requireTemporaryCleanup: true,
    });
    if (!recordResult.created) {
      throw new TypeError("AI pre-review receipt record가 이미 존재합니다.");
    }
    PERSISTED_AI_PRE_REVIEW_RECEIPTS.add(receipt);
    return Object.freeze({
      path: paths.receiptPath,
      created: true,
      payloadSha256,
    });
  } finally {
    PERSISTING_AI_PRE_REVIEW_RECEIPTS.delete(receipt);
  }
}

export async function loadAiPreReviewReceipt({
  path,
  benchmarkPack,
  queue,
}: {
  readonly path: string;
  readonly benchmarkPack: RecordedBenchmarkPack;
  readonly queue: BlindReviewQueue;
}): Promise<AiPreReviewReceipt> {
  assertArtifactChain(benchmarkPack, queue);
  await assertExistingWriteOnceArtifactDirectory({
    rootDirectory: resolve(path, "..", ".."),
    artifactDirectory: resolve(path, ".."),
  });
  const bytes = await readSecureCanonicalFile(path, "AI pre-review receipt");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new TypeError("AI pre-review receipt JSON을 해석할 수 없습니다.", { cause: error });
  }
  const receipt = parsePersistedSnapshot(parsed, benchmarkPack, queue);
  const payloadSha256 = sha256CanonicalJson(receipt);
  const expectedPaths = createAiPreReviewReceiptPaths({
    outputDirectory: resolve(path, "..", ".."),
    preReviewId: receipt.pre_review_id,
    payloadSha256,
  });
  if (resolve(path) !== resolve(expectedPaths.receiptPath)) {
    throw new TypeError("AI pre-review receipt path가 content-addressed 경로와 다릅니다.");
  }
  const claim = {
    schema_version: "ai-pre-review-claim-v1",
    artifact_kind: "AI_PRE_REVIEW_CLAIM",
    pre_review_id: receipt.pre_review_id,
    payload_sha256: payloadSha256,
  };
  const claimBytes = Buffer.from(`${canonicalJsonStringify({
    payload_sha256: sha256CanonicalJson(claim),
    payload: claim,
  })}\n`, "utf8");
  await assertExactFileBytes(
    expectedPaths.claimPath,
    claimBytes,
    "AI pre-review claim",
  );
  const canonicalBytes = Buffer.from(`${canonicalJsonStringify({
    payload_sha256: payloadSha256,
    payload: JSON.parse(canonicalJsonStringify(receipt)),
  })}\n`, "utf8");
  if (!bytes.equals(canonicalBytes)) {
    throw new TypeError("AI pre-review receipt bytes가 canonical 형식과 다릅니다.");
  }
  SOURCE_RELOADED_AI_PRE_REVIEW_RECEIPTS.add(receipt);
  return receipt;
}

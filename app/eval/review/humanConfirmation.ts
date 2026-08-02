import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { types as utilTypes } from "node:util";
import {
  assertValidatedProvisionalDecisionMemo,
  type ProvisionalDecisionMemo,
} from "../decision/provisionalMemo";
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
} from "./buildReviewQueue";
import {
  assertValidatedAiPreReviewReceipt,
  type AiPreReviewReceipt,
} from "./preReviewReceipt";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CONFIRMATION_ID_PATTERN = /^hcr_[a-f0-9]{64}$/;
const VALIDATED_HUMAN_CONFIRMATION_EXPECTED_CONTEXT = Symbol(
  "ValidatedHumanConfirmationExpectedContext",
);
const validatedExpectedContexts = new WeakSet<object>();

export type HumanConfirmationAction =
  | "ACCEPT_ALL"
  | "CONFIRM_WITH_EDITS"
  | "REQUEST_CHANGES"
  | "REJECT";

export type HumanConfirmationFinalDecision = "PASS" | "CONFIRMED_FAIL";
export type HumanConfirmationProposalResolution = "ACCEPTED" | "EDITED";

export interface HumanConfirmationExpectedProposal {
  readonly item_id: string;
  readonly expected_final_decision: HumanConfirmationFinalDecision;
  readonly expected_rationale: string;
}

export interface HumanConfirmationExpectedContext {
  readonly schema_version: "human-confirmation-expected-context-v2";
  readonly synthetic: true;
  readonly recorded_benchmark_pack_hash: string;
  readonly ai_pre_review_receipt_hash: string;
  readonly provisional_decision_memo_hash: string;
  readonly queue_content_hash: string;
  readonly queue_set_order_hash: string;
  readonly queue_item_ids: readonly string[];
  readonly queue_item_set_hash: string;
  readonly queue_item_order_hash: string;
  readonly proposal_items: readonly HumanConfirmationExpectedProposal[];
}

export interface HumanConfirmationCommandItem {
  item_id: string;
  final_decision: HumanConfirmationFinalDecision;
  rationale: string;
  proposal_resolution: HumanConfirmationProposalResolution;
  corrected_reply?: string;
  review_duration_ms: number;
  edit_duration_ms: number;
}

export interface HumanConfirmationCommand {
  schema_version: "human-confirmation-command-v1";
  action: HumanConfirmationAction;
  actor_label: string;
  expected_recorded_benchmark_pack_hash: string;
  expected_ai_pre_review_receipt_hash: string;
  expected_provisional_decision_memo_hash: string;
  expected_queue_content_hash: string;
  expected_queue_set_order_hash: string;
  expected_queue_item_set_hash: string;
  expected_queue_item_order_hash: string;
  items: HumanConfirmationCommandItem[];
  confirmed_at: string;
}

export interface HumanConfirmationReceiptItem {
  readonly item_id: string;
  readonly final_decision: HumanConfirmationFinalDecision;
  readonly rationale: string;
  readonly proposal_resolution: HumanConfirmationProposalResolution;
  readonly corrected_reply?: string;
  readonly review_duration_ms: number;
  readonly edit_duration_ms: number;
}

export interface HumanConfirmationReceipt {
  readonly schema_version: "human-confirmation-receipt-v1";
  readonly artifact_kind: "HUMAN_CONFIRMATION_RECEIPT";
  readonly confirmation_id: `hcr_${string}`;
  readonly synthetic: true;
  readonly action: HumanConfirmationAction;
  readonly human_confirmation_status:
    | "HUMAN_CONFIRMED"
    | "CHANGES_REQUESTED"
    | "REJECTED";
  readonly human_confirmed: boolean;
  readonly recorded_benchmark_pack_hash: string;
  readonly ai_pre_review_receipt_hash: string;
  readonly provisional_decision_memo_hash: string;
  readonly queue_content_hash: string;
  readonly queue_set_order_hash: string;
  readonly queue_item_ids: readonly string[];
  readonly queue_item_set_hash: string;
  readonly queue_item_order_hash: string;
  readonly actor_label: string;
  readonly items: readonly HumanConfirmationReceiptItem[];
  readonly total_review_duration_ms: number;
  readonly total_edit_duration_ms: number;
  readonly confirmed_at: string;
  readonly provisional_recommendation_status:
    | "PRESERVED_FOR_HUMAN_CONFIRMED_DECISION"
    | "INVALIDATED";
  readonly provisional_memo_status:
    | "BOUND_FOR_HUMAN_CONFIRMED_DECISION"
    | "INVALIDATED";
  readonly next_step:
    | "HUMAN_CONFIRMED_DECISION_ELIGIBLE"
    | "REGENERATION_REQUIRED"
    | "CONFIRMATION_REJECTED";
  readonly decision_status: "NOT_CREATED";
  readonly baseline_version: null;
}

export interface HumanConfirmationReceiptPaths {
  readonly confirmationDirectory: string;
  readonly claimPath: string;
  readonly receiptPath: string;
}

export interface PersistHumanConfirmationReceiptInput {
  readonly outputDirectory: string;
  readonly receipt: HumanConfirmationReceipt;
}

export interface PersistHumanConfirmationReceiptResult {
  readonly path: string;
  readonly created: true;
  readonly payloadSha256: string;
}

type JsonRecord = Record<string, unknown>;

const validatedReceipts = new WeakSet<object>();
const receiptsInFlight = new WeakSet<object>();
const persistedReceipts = new WeakSet<object>();

export class HumanConfirmationIntegrityError extends Error {
  readonly code = "HUMAN_CONFIRMATION_INTEGRITY" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HumanConfirmationIntegrityError";
  }
}

function integrity(message: string, cause?: unknown): HumanConfirmationIntegrityError {
  return new HumanConfirmationIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function readPlainRecord(value: unknown, location: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw integrity(`${location}은(는) 명시적인 plain 객체여야 합니다.`);
  }
  if (utilTypes.isProxy(value)) {
    throw integrity(`${location}은(는) Proxy가 아닌 plain data 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw integrity(`${location}은(는) plain 객체여야 합니다.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") {
      throw integrity(`${location}에는 Symbol 속성을 둘 수 없습니다.`);
    }
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) {
      throw integrity(
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
    throw integrity(`${location}은(는) Proxy가 아닌 plain data 배열이어야 합니다.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
  ) {
    throw integrity(`${location}.length는 plain data property여야 합니다.`);
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length > 256) {
    throw integrity(`${location}.length가 잠긴 최대 plain data 범위를 초과합니다.`);
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
    throw integrity(`${location}에는 index 외 추가·Symbol 속성을 둘 수 없습니다.`);
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw integrity(
        `${location}[${index}]는 getter/setter 또는 hole이 아닌 plain data property여야 합니다.`,
      );
    }
    return descriptor.value;
  });
}

function assertExactKeys(
  record: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  location: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(record, key));
  const additional = Object.getOwnPropertyNames(record).filter(
    (key) => !allowed.has(key),
  );
  if (missing.length > 0 || additional.length > 0) {
    throw integrity(
      `${location}의 exact 필드 계약이 다릅니다. missing=${missing.join(",")} additional=${additional.join(",")}`,
    );
  }
}

function assertSha256(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw integrity(`${location}는 lowercase SHA-256 hash여야 합니다.`);
  }
}

function readNonEmptyText(value: unknown, location: string): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || /\p{Cc}/u.test(value)
  ) {
    throw integrity(`${location}는 제어 문자가 없는 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value;
}

function assertObservedDuration(value: unknown, location: string): asserts value is number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw integrity(
      `${location}은(는) 관측된 finite nonnegative safe-integer duration이어야 합니다.`,
    );
  }
}

function assertCanonicalTimestamp(value: unknown, location: string): asserts value is string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw integrity(`${location}는 canonical ISO timestamp여야 합니다.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function queueItemSetHash(itemIds: readonly string[]): string {
  return sha256CanonicalJson({
    schema_version: "human-confirmation-queue-item-set-v1",
    item_ids: [...itemIds].sort(),
  });
}

function queueItemOrderHash(itemIds: readonly string[]): string {
  return sha256CanonicalJson({
    schema_version: "human-confirmation-queue-item-order-v1",
    item_ids: [...itemIds],
  });
}

function assertValidatedExpectedContext(
  value: unknown,
): asserts value is HumanConfirmationExpectedContext {
  if (
    typeof value !== "object"
    || value === null
    || !validatedExpectedContexts.has(value)
    || (value as Record<PropertyKey, unknown>)[
      VALIDATED_HUMAN_CONFIRMATION_EXPECTED_CONTEXT
    ] !== true
    || !Object.isFrozen(value)
  ) {
    throw integrity(
      "Human confirmation expected context는 authoritative artifact chain에서 발급한 동일 validated 객체여야 합니다.",
    );
  }
}

function brandExpectedContext(
  context: HumanConfirmationExpectedContext,
): HumanConfirmationExpectedContext {
  Object.defineProperty(context, VALIDATED_HUMAN_CONFIRMATION_EXPECTED_CONTEXT, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  validatedExpectedContexts.add(context);
  return deepFreeze(context);
}

/**
 * 사용자 확인 화면이 신뢰할 수 있는 expected context는 이 발급 경계에서만 만듭니다.
 * 구조가 같은 plain 객체·clone은 receipt 생성 권한을 갖지 않습니다.
 */
export function createHumanConfirmationExpectedContext({
  benchmarkPack,
  queue,
  preReviewReceipt,
  provisionalMemo,
}: {
  readonly benchmarkPack: RecordedBenchmarkPack;
  readonly queue: BlindReviewQueue;
  readonly preReviewReceipt: AiPreReviewReceipt;
  readonly provisionalMemo: ProvisionalDecisionMemo;
}): HumanConfirmationExpectedContext {
  try {
    assertValidatedRecordedBenchmarkPack(benchmarkPack);
    assertValidatedBlindReviewQueue(queue);
    assertValidatedAiPreReviewReceipt(preReviewReceipt);
    assertValidatedProvisionalDecisionMemo(provisionalMemo);
  } catch (error) {
    throw integrity(
      "Human confirmation expected context에는 실제 validated Benchmark·queue·pre-review·Memo가 필요합니다.",
      error,
    );
  }
  const benchmarkPackHash = sha256CanonicalJson(benchmarkPack);
  const preReviewReceiptHash = sha256CanonicalJson(preReviewReceipt);
  const provisionalMemoHash = sha256CanonicalJson(provisionalMemo);
  const queueContentHash = calculateBlindReviewQueueContentHash(queue);
  const queueSetOrderHash = calculateBlindReviewQueueSetOrderHash(queue);
  if (
    queue !== benchmarkPack.blind_review_queue
    || queue.execution_pack_hash !== benchmarkPack.execution_pack_hash
    || preReviewReceipt.pre_review_status !== "USER_CONFIRMATION_READY"
    || preReviewReceipt.recorded_benchmark_pack_hash !== benchmarkPackHash
    || preReviewReceipt.queue_content_hash !== queueContentHash
    || preReviewReceipt.queue_set_order_hash !== queueSetOrderHash
    || provisionalMemo.memo_status !== "USER_CONFIRMATION_REQUIRED"
    || provisionalMemo.recorded_benchmark_pack_hash !== benchmarkPackHash
    || provisionalMemo.ai_pre_review_receipt_hash !== preReviewReceiptHash
    || provisionalMemo.queue_content_hash !== queueContentHash
    || provisionalMemo.queue_set_order_hash !== queueSetOrderHash
    || preReviewReceipt.items.length !== queue.items.length
    || preReviewReceipt.items.some(
      (item, index) => item.item_id !== queue.items[index].item_id,
    )
  ) {
    throw integrity(
      "Human confirmation expected context의 authoritative artifact chain 또는 준비 상태가 다릅니다.",
    );
  }
  const proposalItems = preReviewReceipt.items.map((item): HumanConfirmationExpectedProposal => {
    if (item.proposed_decision === "ABSTAIN") {
      throw integrity("ABSTAIN pre-review는 사용자 확인 준비 context를 발급할 수 없습니다.");
    }
    return {
      item_id: item.item_id,
      expected_final_decision: item.proposed_decision === "PROPOSED_PASS"
        ? "PASS"
        : "CONFIRMED_FAIL",
      expected_rationale: item.rationale,
    };
  });
  const itemIds = proposalItems.map((item) => item.item_id);
  return brandExpectedContext({
    schema_version: "human-confirmation-expected-context-v2",
    synthetic: true,
    recorded_benchmark_pack_hash: benchmarkPackHash,
    ai_pre_review_receipt_hash: preReviewReceiptHash,
    provisional_decision_memo_hash: provisionalMemoHash,
    queue_content_hash: queueContentHash,
    queue_set_order_hash: queueSetOrderHash,
    queue_item_ids: itemIds,
    queue_item_set_hash: queueItemSetHash(itemIds),
    queue_item_order_hash: queueItemOrderHash(itemIds),
    proposal_items: proposalItems,
  });
}

function parseCommandItem(
  input: unknown,
  expectedProposal: HumanConfirmationExpectedProposal,
  index: number,
): HumanConfirmationReceiptItem {
  const location = `confirmation command.items[${index}]`;
  const record = readPlainRecord(input, location);
  assertExactKeys(record, [
    "item_id",
    "final_decision",
    "rationale",
    "proposal_resolution",
    "review_duration_ms",
    "edit_duration_ms",
  ], ["corrected_reply"], location);
  if (record.item_id !== expectedProposal.item_id) {
    throw integrity(`${location}의 queue item 순서 또는 identity가 기대 목록과 일치하지 않습니다.`);
  }
  if (record.final_decision !== "PASS" && record.final_decision !== "CONFIRMED_FAIL") {
    throw integrity(`${location}.final_decision은 PASS 또는 CONFIRMED_FAIL이어야 합니다.`);
  }
  if (record.proposal_resolution !== "ACCEPTED" && record.proposal_resolution !== "EDITED") {
    throw integrity(`${location}.proposal_resolution은 ACCEPTED 또는 EDITED여야 합니다.`);
  }
  const rationale = readNonEmptyText(record.rationale, `${location}.rationale`);
  assertObservedDuration(record.review_duration_ms, `${location}.review_duration_ms`);
  assertObservedDuration(record.edit_duration_ms, `${location}.edit_duration_ms`);
  const correctedReply = record.corrected_reply === undefined
    ? undefined
    : readNonEmptyText(record.corrected_reply, `${location}.corrected_reply`);

  if (record.proposal_resolution === "ACCEPTED") {
    if (
      record.final_decision !== expectedProposal.expected_final_decision
      || rationale !== expectedProposal.expected_rationale
    ) {
      throw integrity(
        `${location}의 ACCEPTED item은 authoritative pre-review proposal과 정확히 같아야 합니다.`,
      );
    }
    if (record.edit_duration_ms !== 0) {
      throw integrity(`${location}의 unedited ACCEPTED item은 edit duration이 0이어야 합니다.`);
    }
    if (correctedReply !== undefined) {
      throw integrity(`${location}의 unedited ACCEPTED item에는 corrected reply가 있을 수 없습니다.`);
    }
  } else if (record.edit_duration_ms <= 0) {
    throw integrity(`${location}의 EDITED item은 양수의 관측 edit duration이 필요합니다.`);
  } else if (
    record.final_decision === expectedProposal.expected_final_decision
    && rationale === expectedProposal.expected_rationale
    && correctedReply === undefined
  ) {
    throw integrity(`${location}의 EDITED item에는 실제 결정·근거·답변 변경이 필요합니다.`);
  }

  return {
    item_id: expectedProposal.item_id,
    final_decision: record.final_decision,
    rationale,
    proposal_resolution: record.proposal_resolution,
    ...(correctedReply === undefined ? {} : { corrected_reply: correctedReply }),
    review_duration_ms: record.review_duration_ms,
    edit_duration_ms: record.edit_duration_ms,
  };
}

function parseCommand(
  input: unknown,
  expected: HumanConfirmationExpectedContext,
): {
  readonly action: HumanConfirmationAction;
  readonly actorLabel: string;
  readonly items: HumanConfirmationReceiptItem[];
  readonly confirmedAt: string;
} {
  const record = readPlainRecord(input, "explicit human confirmation command");
  assertExactKeys(record, [
    "schema_version",
    "action",
    "actor_label",
    "expected_recorded_benchmark_pack_hash",
    "expected_ai_pre_review_receipt_hash",
    "expected_provisional_decision_memo_hash",
    "expected_queue_content_hash",
    "expected_queue_set_order_hash",
    "expected_queue_item_set_hash",
    "expected_queue_item_order_hash",
    "items",
    "confirmed_at",
  ], [], "explicit human confirmation command");
  if (record.schema_version !== "human-confirmation-command-v1") {
    throw integrity("explicit human confirmation command schema version이 다릅니다.");
  }
  if (
    record.action !== "ACCEPT_ALL"
    && record.action !== "CONFIRM_WITH_EDITS"
    && record.action !== "REQUEST_CHANGES"
    && record.action !== "REJECT"
  ) {
    throw integrity(
      "confirmation action은 ACCEPT_ALL, CONFIRM_WITH_EDITS, REQUEST_CHANGES, REJECT 중 하나여야 합니다.",
    );
  }
  const sourceChecks = [
    [
      record.expected_recorded_benchmark_pack_hash,
      expected.recorded_benchmark_pack_hash,
      "recorded Benchmark",
    ],
    [
      record.expected_ai_pre_review_receipt_hash,
      expected.ai_pre_review_receipt_hash,
      "AI pre-review",
    ],
    [
      record.expected_provisional_decision_memo_hash,
      expected.provisional_decision_memo_hash,
      "provisional Memo",
    ],
    [record.expected_queue_content_hash, expected.queue_content_hash, "queue content"],
    [record.expected_queue_set_order_hash, expected.queue_set_order_hash, "queue set/order"],
    [record.expected_queue_item_set_hash, expected.queue_item_set_hash, "queue item set"],
    [record.expected_queue_item_order_hash, expected.queue_item_order_hash, "queue item order"],
  ] as const;
  for (const [actual, locked, label] of sourceChecks) {
    assertSha256(actual, `${label} expected hash`);
    if (actual !== locked) {
      throw integrity(`${label} expected hash가 authoritative source와 일치하지 않습니다.`);
    }
  }
  const commandItems = readPlainArray(
    record.items,
    "confirmation command.items",
  );
  if (commandItems.length !== expected.queue_item_ids.length) {
    throw integrity("confirmation command의 queue item 수가 기대 목록과 일치하지 않습니다.");
  }
  const items = commandItems.map((item, index) => (
    parseCommandItem(item, expected.proposal_items[index], index)
  ));
  if (new Set(items.map((item) => item.item_id)).size !== items.length) {
    throw integrity("confirmation command에 중복 queue item이 있습니다.");
  }
  const hasEditedItem = items.some((item) => item.proposal_resolution === "EDITED");
  if (record.action === "ACCEPT_ALL" && hasEditedItem) {
    throw integrity("ACCEPT_ALL은 EDITED item을 포함할 수 없습니다.");
  }
  if (record.action === "CONFIRM_WITH_EDITS") {
    if (!hasEditedItem) {
      throw integrity(
        "CONFIRM_WITH_EDITS에는 최소 한 개의 EDITED item이 필요합니다.",
      );
    }
    const hasHumanJudgmentChange = items.some((item, index) => {
      if (item.proposal_resolution !== "EDITED") return false;
      const proposal = expected.proposal_items[index];
      const normalizedRationale = item.rationale.trim().replace(/\s+/gu, " ");
      const normalizedExpectedRationale =
        proposal.expected_rationale.trim().replace(/\s+/gu, " ");
      return item.final_decision !== proposal.expected_final_decision
        || normalizedRationale !== normalizedExpectedRationale;
    });
    if (!hasHumanJudgmentChange) {
      throw integrity(
        "CONFIRM_WITH_EDITS에는 AI proposal과 다른 실제 decision 또는 rationale 변경이 필요합니다.",
      );
    }
  }
  if (record.action === "REQUEST_CHANGES" && !hasEditedItem) {
    throw integrity("REQUEST_CHANGES에는 최소 한 개의 EDITED 변경이 필요합니다.");
  }
  const totalReviewDuration = items.reduce(
    (sum, item) => sum + item.review_duration_ms,
    0,
  );
  const totalEditDuration = items.reduce(
    (sum, item) => sum + item.edit_duration_ms,
    0,
  );
  if (
    !Number.isSafeInteger(totalReviewDuration)
    || !Number.isSafeInteger(totalEditDuration)
  ) {
    throw integrity("confirmation command의 관측 duration 합계가 safe integer 범위를 벗어납니다.");
  }
  const actorLabel = readNonEmptyText(record.actor_label, "confirmation command.actor_label");
  assertCanonicalTimestamp(record.confirmed_at, "confirmation command.confirmed_at");
  return {
    action: record.action,
    actorLabel,
    items,
    confirmedAt: record.confirmed_at,
  };
}

function confirmationId(expected: HumanConfirmationExpectedContext): `hcr_${string}` {
  return `hcr_${sha256CanonicalJson({
    schema_version: "human-confirmation-identity-v1",
    recorded_benchmark_pack_hash: expected.recorded_benchmark_pack_hash,
    ai_pre_review_receipt_hash: expected.ai_pre_review_receipt_hash,
    provisional_decision_memo_hash: expected.provisional_decision_memo_hash,
    queue_content_hash: expected.queue_content_hash,
    queue_set_order_hash: expected.queue_set_order_hash,
    queue_item_set_hash: expected.queue_item_set_hash,
    queue_item_order_hash: expected.queue_item_order_hash,
  })}`;
}

export function buildHumanConfirmationReceipt({
  expected: rawExpected,
  command: rawCommand,
}: {
  readonly expected: HumanConfirmationExpectedContext;
  readonly command: HumanConfirmationCommand;
}): HumanConfirmationReceipt {
  assertValidatedExpectedContext(rawExpected);
  const expected = rawExpected;
  const command = parseCommand(rawCommand, expected);
  const humanConfirmed =
    command.action === "ACCEPT_ALL"
    || command.action === "CONFIRM_WITH_EDITS";
  const proposalPreserved = command.action === "ACCEPT_ALL";
  const receipt: HumanConfirmationReceipt = deepFreeze({
    schema_version: "human-confirmation-receipt-v1",
    artifact_kind: "HUMAN_CONFIRMATION_RECEIPT",
    confirmation_id: confirmationId(expected),
    synthetic: true,
    action: command.action,
    human_confirmation_status: humanConfirmed
      ? "HUMAN_CONFIRMED"
      : command.action === "REQUEST_CHANGES"
        ? "CHANGES_REQUESTED"
        : "REJECTED",
    human_confirmed: humanConfirmed,
    recorded_benchmark_pack_hash: expected.recorded_benchmark_pack_hash,
    ai_pre_review_receipt_hash: expected.ai_pre_review_receipt_hash,
    provisional_decision_memo_hash: expected.provisional_decision_memo_hash,
    queue_content_hash: expected.queue_content_hash,
    queue_set_order_hash: expected.queue_set_order_hash,
    queue_item_ids: [...expected.queue_item_ids],
    queue_item_set_hash: expected.queue_item_set_hash,
    queue_item_order_hash: expected.queue_item_order_hash,
    actor_label: command.actorLabel,
    items: command.items.map((item) => ({ ...item })),
    total_review_duration_ms: command.items.reduce(
      (sum, item) => sum + item.review_duration_ms,
      0,
    ),
    total_edit_duration_ms: command.items.reduce(
      (sum, item) => sum + item.edit_duration_ms,
      0,
    ),
    confirmed_at: command.confirmedAt,
    provisional_recommendation_status: proposalPreserved
      ? "PRESERVED_FOR_HUMAN_CONFIRMED_DECISION"
      : "INVALIDATED",
    provisional_memo_status: proposalPreserved
      ? "BOUND_FOR_HUMAN_CONFIRMED_DECISION"
      : "INVALIDATED",
    next_step: humanConfirmed
      ? "HUMAN_CONFIRMED_DECISION_ELIGIBLE"
      : command.action === "REQUEST_CHANGES"
        ? "REGENERATION_REQUIRED"
        : "CONFIRMATION_REJECTED",
    decision_status: "NOT_CREATED",
    baseline_version: null,
  });
  validatedReceipts.add(receipt);
  return receipt;
}

export function assertValidatedHumanConfirmationReceipt(
  value: unknown,
): asserts value is HumanConfirmationReceipt {
  if (
    typeof value !== "object"
    || value === null
    || !validatedReceipts.has(value)
    || !Object.isFrozen(value)
  ) {
    throw integrity(
      "Human confirmation receipt는 explicit command와 expected hashes를 검증한 build 결과여야 합니다.",
    );
  }
}

export function createHumanConfirmationReceiptPaths({
  outputDirectory,
  confirmationId,
  payloadSha256,
}: {
  readonly outputDirectory: string;
  readonly confirmationId: string;
  readonly payloadSha256: string;
}): HumanConfirmationReceiptPaths {
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) {
    throw integrity("Human confirmation outputDirectory가 비어 있습니다.");
  }
  if (!CONFIRMATION_ID_PATTERN.test(confirmationId)) {
    throw integrity("confirmationId 형식이 올바르지 않습니다.");
  }
  assertSha256(payloadSha256, "Human confirmation payload hash");
  const confirmationDirectory = join(outputDirectory, confirmationId);
  return Object.freeze({
    confirmationDirectory,
    claimPath: join(confirmationDirectory, "human-confirmation--claim.json"),
    receiptPath: join(
      confirmationDirectory,
      `human-confirmation--record-${payloadSha256}.json`,
    ),
  });
}

async function readSecureFileBytes(
  filePath: string,
  label: string,
  expectedNlink = 1,
): Promise<Buffer> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (
      !stats.isFile()
      || (stats.mode & 0o777) !== 0o600
      || stats.nlink !== expectedNlink
    ) {
      throw integrity(
        `${label}은 nlink ${expectedNlink}인 regular file과 정확한 mode 0600이어야 합니다.`,
      );
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof HumanConfirmationIntegrityError) throw error;
    throw integrity(`${label}을 symlink 없이 안전하게 검증할 수 없습니다.`, error);
  } finally {
    await handle?.close();
  }
}

async function assertExactFileBytes(
  filePath: string,
  expectedBytes: Buffer,
  label: string,
  expectedNlink = 1,
): Promise<void> {
  const actualBytes = await readSecureFileBytes(
    filePath,
    label,
    expectedNlink,
  );
  if (!actualBytes.equals(expectedBytes)) {
    throw integrity(`${label} bytes가 잠긴 confirmation 내용과 일치하지 않습니다.`);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function persistHumanConfirmationReceipt({
  outputDirectory,
  receipt,
}: PersistHumanConfirmationReceiptInput): Promise<PersistHumanConfirmationReceiptResult> {
  assertValidatedHumanConfirmationReceipt(receipt);
  if (persistedReceipts.has(receipt) || receiptsInFlight.has(receipt)) {
    throw integrity("동일 Human confirmation receipt replay는 허용되지 않습니다.");
  }
  receiptsInFlight.add(receipt);
  try {
    const snapshot = JSON.parse(canonicalJsonStringify(receipt)) as HumanConfirmationReceipt;
    const payloadSha256 = sha256CanonicalJson(snapshot);
    const paths = createHumanConfirmationReceiptPaths({
      outputDirectory,
      confirmationId: snapshot.confirmation_id,
      payloadSha256,
    });
    await prepareWriteOnceArtifactDirectory({
      rootDirectory: outputDirectory,
      artifactDirectory: paths.confirmationDirectory,
    });
    const claim = Object.freeze({
      schema_version: "human-confirmation-claim-v1",
      artifact_kind: "HUMAN_CONFIRMATION_CLAIM",
      confirmation_id: snapshot.confirmation_id,
      payload_sha256: payloadSha256,
    });
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
        "기존 Human confirmation claim",
      ),
      assertPublishedFile: (path) => assertExactFileBytes(
        path,
        claimBytes,
        "공개된 Human confirmation claim",
      ),
      requireTemporaryCleanup: true,
    });
    if (!claimResult.created && await pathExists(paths.receiptPath)) {
      await assertExactFileBytes(
        paths.receiptPath,
        receiptBytes,
        "기존 Human confirmation record",
      );
      throw integrity("이미 저장된 Human confirmation receipt replay입니다.");
    }

    const persisted = await persistWriteOnceFileWithClaim({
      filePath: paths.receiptPath,
      bytes: receiptBytes,
      assertExistingMatches: (path) => assertExactFileBytes(
        path,
        receiptBytes,
        "기존 Human confirmation record",
      ),
      assertPublishedFile: (path) => assertExactFileBytes(
        path,
        receiptBytes,
        "공개된 Human confirmation record",
      ),
      requireTemporaryCleanup: true,
    });
    if (!persisted.created) {
      throw integrity("이미 저장된 Human confirmation receipt replay입니다.");
    }
    persistedReceipts.add(receipt);
    return Object.freeze({
      path: persisted.path,
      created: true,
      payloadSha256,
    });
  } catch (error) {
    if (error instanceof HumanConfirmationIntegrityError) throw error;
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw integrity(
      `Human confirmation receipt를 atomic write-once 저장할 수 없습니다.${detail}`,
      error,
    );
  } finally {
    receiptsInFlight.delete(receipt);
  }
}

function commandFromReceiptSnapshot(
  snapshot: HumanConfirmationReceipt,
): HumanConfirmationCommand {
  return {
    schema_version: "human-confirmation-command-v1",
    action: snapshot.action,
    actor_label: snapshot.actor_label,
    expected_recorded_benchmark_pack_hash:
      snapshot.recorded_benchmark_pack_hash,
    expected_ai_pre_review_receipt_hash:
      snapshot.ai_pre_review_receipt_hash,
    expected_provisional_decision_memo_hash:
      snapshot.provisional_decision_memo_hash,
    expected_queue_content_hash: snapshot.queue_content_hash,
    expected_queue_set_order_hash: snapshot.queue_set_order_hash,
    expected_queue_item_set_hash: snapshot.queue_item_set_hash,
    expected_queue_item_order_hash: snapshot.queue_item_order_hash,
    items: snapshot.items.map((item) => ({
      item_id: item.item_id,
      final_decision: item.final_decision,
      rationale: item.rationale,
      proposal_resolution: item.proposal_resolution,
      ...(item.corrected_reply === undefined
        ? {}
        : { corrected_reply: item.corrected_reply }),
      review_duration_ms: item.review_duration_ms,
      edit_duration_ms: item.edit_duration_ms,
    })),
    confirmed_at: snapshot.confirmed_at,
  };
}

function rebuildPersistedHumanConfirmationReceipt(
  value: unknown,
  expected: HumanConfirmationExpectedContext,
): HumanConfirmationReceipt {
  const wrapper = readPlainRecord(value, "persisted Human confirmation wrapper");
  assertExactKeys(
    wrapper,
    ["payload_sha256", "payload"],
    [],
    "persisted Human confirmation wrapper",
  );
  assertSha256(wrapper.payload_sha256, "persisted Human confirmation payload hash");
  const payload = readPlainRecord(
    wrapper.payload,
    "persisted Human confirmation payload",
  );
  assertExactKeys(payload, [
    "schema_version",
    "artifact_kind",
    "confirmation_id",
    "synthetic",
    "action",
    "human_confirmation_status",
    "human_confirmed",
    "recorded_benchmark_pack_hash",
    "ai_pre_review_receipt_hash",
    "provisional_decision_memo_hash",
    "queue_content_hash",
    "queue_set_order_hash",
    "queue_item_ids",
    "queue_item_set_hash",
    "queue_item_order_hash",
    "actor_label",
    "items",
    "total_review_duration_ms",
    "total_edit_duration_ms",
    "confirmed_at",
    "provisional_recommendation_status",
    "provisional_memo_status",
    "next_step",
    "decision_status",
    "baseline_version",
  ], [], "persisted Human confirmation payload");
  if (
    payload.schema_version !== "human-confirmation-receipt-v1"
    || payload.artifact_kind !== "HUMAN_CONFIRMATION_RECEIPT"
    || typeof payload.confirmation_id !== "string"
    || !CONFIRMATION_ID_PATTERN.test(payload.confirmation_id)
    || payload.synthetic !== true
    || !Array.isArray(payload.items)
    || !Array.isArray(payload.queue_item_ids)
    || sha256CanonicalJson(payload) !== wrapper.payload_sha256
  ) {
    throw integrity(
      "persisted Human confirmation payload 무결성 또는 exact 상태 계약이 다릅니다.",
    );
  }
  const snapshot = payload as unknown as HumanConfirmationReceipt;
  const rebuilt = buildHumanConfirmationReceipt({
    expected,
    command: commandFromReceiptSnapshot(snapshot),
  });
  if (canonicalJsonStringify(rebuilt) !== canonicalJsonStringify(snapshot)) {
    throw integrity(
      "persisted Human confirmation receipt가 authoritative expected context와 다릅니다.",
    );
  }
  return rebuilt;
}

export async function loadHumanConfirmationReceipt({
  path,
  expected,
}: {
  readonly path: string;
  readonly expected: HumanConfirmationExpectedContext;
}): Promise<HumanConfirmationReceipt> {
  assertValidatedExpectedContext(expected);
  const rootDirectory = resolve(path, "..", "..");
  const confirmationDirectory = resolve(path, "..");
  await assertExistingWriteOnceArtifactDirectory({
    rootDirectory,
    artifactDirectory: confirmationDirectory,
  });
  const bytes = await readSecureFileBytes(
    path,
    "저장된 Human confirmation record",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw integrity("저장된 Human confirmation JSON을 해석할 수 없습니다.", error);
  }
  const receipt = rebuildPersistedHumanConfirmationReceipt(parsed, expected);
  const payloadSha256 = sha256CanonicalJson(receipt);
  const paths = createHumanConfirmationReceiptPaths({
    outputDirectory: rootDirectory,
    confirmationId: receipt.confirmation_id,
    payloadSha256,
  });
  if (resolve(path) !== resolve(paths.receiptPath)) {
    throw integrity(
      "Human confirmation record path가 content-addressed 경로와 다릅니다.",
    );
  }
  const claim = {
    schema_version: "human-confirmation-claim-v1",
    artifact_kind: "HUMAN_CONFIRMATION_CLAIM",
    confirmation_id: receipt.confirmation_id,
    payload_sha256: payloadSha256,
  };
  const claimBytes = Buffer.from(`${canonicalJsonStringify({
    payload_sha256: sha256CanonicalJson(claim),
    payload: claim,
  })}\n`, "utf8");
  await assertExactFileBytes(
    paths.claimPath,
    claimBytes,
    "저장된 Human confirmation claim",
  );
  const canonicalBytes = Buffer.from(`${canonicalJsonStringify({
    payload_sha256: payloadSha256,
    payload: JSON.parse(canonicalJsonStringify(receipt)),
  })}\n`, "utf8");
  if (!bytes.equals(canonicalBytes)) {
    throw integrity("Human confirmation record bytes가 canonical 형식과 다릅니다.");
  }
  return receipt;
}

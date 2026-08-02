import {
  buildBenchmarkSchedule,
  type BenchmarkSchedule,
} from "../benchmark/schedule";
import type { BenchmarkExecutionIdentity } from "../benchmark/identity";
import {
  parseCandidateOutput,
  type CandidateOutput,
} from "../contracts/candidateOutput";
import {
  BENCHMARK_CASES,
  BENCHMARK_ORACLES,
  HIGH_RISK_CASE_IDS,
} from "../data/benchmark";
import {
  BENCHMARK_CANDIDATE_IDS,
  type BenchmarkJudgeCandidateId,
} from "../judge/blinding";
import {
  BLIND_JUDGE_OUTPUT_LENGTH_POLICY,
  buildBlindJudgeInput,
  buildBlindReviewCandidateOutputProjection,
  containsBlindReviewArchitectureHint,
  type BlindJudgeInput,
  type CandidateJudgeSource,
} from "../judge/buildJudgeInput";
import {
  assertNoBlindJudgeIdentityLeak,
  BLIND_JUDGE_LABELS,
  normalizeBlindJudgeText,
  type BlindJudgeCriterionId,
  type BlindJudgeFailureType,
  type BlindJudgeLabel,
  type BlindJudgeResult,
  type BlindJudgeSeverity,
} from "../judge/contracts";
import {
  parseBlindJudgeRunRecord,
  type BlindJudgeRunRecord,
} from "../judge/runJudge";
import {
  assertAuxiliaryJudgeEligibleBenchmarkExecutionPack,
  buildBenchmarkExecutionPack,
  type BenchmarkCompletedSlot,
  type BenchmarkExecutionPack,
  type RecordedBenchmarkSlot,
} from "../pack/benchmarkPack";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  buildJudgeEvidencePrecommitManifest,
  deriveOpaqueEvidenceHandle,
  validateExecutionBoundPrivateBlindMapping,
  type ExecutionBoundPrivateBlindMapping,
  type JudgeEvidencePrecommitManifest,
  type PrivateBlindingContext,
} from "./judgeEvidenceManifest";
import {
  assertAuthoritativeBlindingPrecommit,
  type AuthoritativeBlindingPrecommit,
} from "./judgeEvidencePrecommitPersistence";

const HIDDEN_CASE_IDS = BENCHMARK_CASES.map((item) => item.case_id);
const MAXIMUM_ADDITIONAL_ITEMS = 6;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VALIDATED_BLIND_REVIEW_QUEUE_BRAND = Symbol(
  "ValidatedBlindReviewQueue",
);
const VALIDATED_BLIND_REVIEW_QUEUES = new WeakSet<object>();

const SEVERITY_ORDER: Readonly<Record<BlindJudgeSeverity, number>> = Object.freeze({
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
});

const LABEL_ORDER: Readonly<Record<BlindJudgeLabel, number>> = Object.freeze({
  X: 0,
  Y: 1,
  Z: 2,
});

export interface ReviewQueueExecutionEvidence {
  readonly schema_version: "review-queue-execution-evidence-v1";
  readonly execution_identity: BenchmarkExecutionIdentity;
  readonly completed_slots: readonly BenchmarkCompletedSlot[];
}

export interface ReviewQueueJudgeCase {
  readonly schema_version: "review-queue-judge-case-v1";
  readonly case_id: string;
  readonly expected_blind_input: BlindJudgeInput;
  readonly private_mapping: ExecutionBoundPrivateBlindMapping;
  readonly judge_run_receipt: BlindJudgeRunRecord;
}

export interface BuildBlindReviewQueueInput {
  readonly schema_version: "build-blind-review-queue-input-v1";
  readonly execution_evidence: ReviewQueueExecutionEvidence;
  readonly authoritative_blinding_precommit: AuthoritativeBlindingPrecommit;
  readonly private_blinding_context: PrivateBlindingContext;
  readonly judge_cases: readonly ReviewQueueJudgeCase[];
}

export interface BlindReviewQueueRun {
  readonly repetition: 1 | 2;
  readonly evidence_id: `${BlindJudgeLabel}:RUN:${1 | 2}`;
  readonly execution_status: "COMPLETE" | "INVALID" | "TIMEOUT" | "BUDGET_EXCEEDED";
  readonly review_output: CandidateOutput | null;
  readonly projection: BlindJudgeInput["blind_candidates"][number]["runs"][number]["projection"];
  readonly evidence_handle: `evh_${string}`;
}

export interface BlindReviewQueueRisk {
  readonly criterion_id: BlindJudgeCriterionId;
  readonly status: "RISK";
  readonly severity: BlindJudgeSeverity;
  readonly failure_type: BlindJudgeFailureType;
  readonly concerning_excerpt: string;
  readonly evidence_ids: readonly string[];
  readonly rationale: string;
}

export interface BlindDeterministicEvidenceLocation {
  readonly location_kind:
    | "CANDIDATE_OUTPUT"
    | "LOCKED_CASE"
    | "LOCKED_ORACLE"
    | "POLICY_EVIDENCE"
    | "ORDER_ACCESS"
    | "EXECUTION_TRACE"
    | "LOCKED_EVIDENCE";
  readonly reference_handle: `evh_${string}`;
}

export interface BlindDeterministicFindingEvidence {
  readonly finding_code: string;
  readonly source_finding_handle: `evh_${string}`;
  readonly evidence_excerpt: string;
  readonly source_message_handle: `evh_${string}`;
  readonly evidence_locations: readonly BlindDeterministicEvidenceLocation[];
}

export interface BlindDeterministicGateEvidence {
  readonly case_id: string;
  readonly blind_label: BlindJudgeLabel;
  readonly repetition: 1 | 2;
  readonly gate_id: "P0-HG-01" | "P0-HG-02" | "P0-HG-03" | "P0-HG-04";
  readonly status: "CONFIRMED_FAIL";
  readonly evidence_handle: `evh_${string}`;
  readonly findings: readonly BlindDeterministicFindingEvidence[];
}

export interface BlindReviewQueueItem {
  readonly item_id: `${string}--${BlindJudgeLabel}`;
  readonly case_id: string;
  readonly blind_label: BlindJudgeLabel;
  readonly queue_reason:
    | "LOCKED_HIGH_RISK"
    | "JUDGE_RISK"
    | "JUDGE_INCOMPLETE_FALLBACK";
  readonly priority_severity: BlindJudgeSeverity | null;
  readonly deterministic_gate_finding: "NONE" | "CONFIRMED_FAIL";
  readonly deterministic_gate_evidence: readonly BlindDeterministicGateEvidence[];
  readonly judge_risks: readonly BlindReviewQueueRisk[];
  readonly judge_evidence_handle: `evh_${string}`;
  readonly runs: readonly [BlindReviewQueueRun, BlindReviewQueueRun];
  readonly review_authority: "HUMAN_REVIEW_REQUIRED";
}

export interface BlindReviewQueue {
  readonly schema_version: "blind-review-queue-v2";
  readonly artifact_kind: "BLIND_REVIEW_QUEUE";
  readonly synthetic: true;
  readonly execution_pack_hash: string;
  readonly queue_set_order_hash: string;
  readonly queue_content_hash: string;
  readonly judge_authority: "RISK_ONLY";
  readonly review_status: "REVIEW_PENDING";
  readonly evaluation_status: "EVALUATION_INCOMPLETE";
  readonly baseline_version: null;
  readonly queue_status: "READY_FOR_REVIEW" | "OVERFLOW";
  readonly required_item_count: 12;
  readonly additional_item_count: number;
  readonly human_fallback_case_count: number;
  readonly human_fallback_item_count: number;
  readonly overflow: {
    readonly detected: boolean;
    readonly maximum_additional_items: 6;
    readonly observed_additional_items: number;
    readonly disposition: "NONE" | "EVALUATION_INCOMPLETE";
  };
  readonly items: readonly BlindReviewQueueItem[];
}

type BlindReviewQueueSetOrderSource = Pick<
  BlindReviewQueue,
  "execution_pack_hash" | "items"
>;

type BlindReviewQueueContentSource = Omit<
  BlindReviewQueue,
  "queue_content_hash"
>;

type BlindReviewQueueWithoutHashes = Omit<
  BlindReviewQueue,
  "queue_set_order_hash" | "queue_content_hash"
>;

/**
 * 공개 blind label·opaque evidence handle 순서만 결합합니다.
 * 후보 ID나 실행 slot의 원시 identity hash는 payload에 포함하지 않습니다.
 */
export function calculateBlindReviewQueueSetOrderHash(
  queue: BlindReviewQueueSetOrderSource,
): string {
  return sha256CanonicalJson({
    schema_version: "blind-review-queue-set-order-v1",
    execution_pack_hash: queue.execution_pack_hash,
    ordered_items: queue.items.map((item) => ({
      item_id: item.item_id,
      case_id: item.case_id,
      blind_label: item.blind_label,
      queue_reason: item.queue_reason,
      judge_evidence_handle: item.judge_evidence_handle,
      run_evidence_handles: item.runs.map((run) => run.evidence_handle),
    })),
  });
}

/**
 * queue_content_hash 자신을 제외한 exact 공개 큐 내용을 content-addressing합니다.
 */
export function calculateBlindReviewQueueContentHash(
  queue: BlindReviewQueue | BlindReviewQueueContentSource,
): string {
  const {
    queue_content_hash: _queueContentHash,
    ...content
  } = queue as BlindReviewQueue;
  return sha256CanonicalJson({
    schema_version: "blind-review-queue-content-address-v1",
    queue: content,
  });
}

export function assertValidatedBlindReviewQueue(
  value: unknown,
): asserts value is BlindReviewQueue {
  if (
    typeof value !== "object"
    || value === null
    || !VALIDATED_BLIND_REVIEW_QUEUES.has(value)
    || (value as Record<PropertyKey, unknown>)[VALIDATED_BLIND_REVIEW_QUEUE_BRAND]
      !== true
  ) {
    throw new TypeError(
      "validated blind review queue는 권위 근거로 생성된 동일 branded 객체여야 합니다.",
    );
  }
  const queue = value as BlindReviewQueue;
  if (
    !Object.isFrozen(queue)
    || !SHA256_PATTERN.test(queue.queue_set_order_hash)
    || !SHA256_PATTERN.test(queue.queue_content_hash)
    || calculateBlindReviewQueueSetOrderHash(queue) !== queue.queue_set_order_hash
    || calculateBlindReviewQueueContentHash(queue) !== queue.queue_content_hash
  ) {
    throw new TypeError("validated blind review queue의 content/order hash 무결성이 다릅니다.");
  }
}

function brandValidatedBlindReviewQueue(
  queue: BlindReviewQueue,
): BlindReviewQueue {
  Object.defineProperty(queue, VALIDATED_BLIND_REVIEW_QUEUE_BRAND, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  VALIDATED_BLIND_REVIEW_QUEUES.add(queue);
  return deepFreeze(queue);
}

type JsonRecord = Record<string, unknown>;

function readPlainRecord(value: unknown, location: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${location}은(는) plain 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${location}은(는) plain 객체여야 합니다.`);
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
      `${location}의 exact 필드 계약이 다릅니다. missing=${missing.join(",")} additional=${additional.join(",")}`,
    );
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

function assertHiddenCaseId(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !HIDDEN_CASE_IDS.includes(value)) {
    throw new TypeError(`${location}는 잠긴 hidden 범위 H-001부터 H-012여야 합니다.`);
  }
}

function assertSha256(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${location}는 64자리 소문자 SHA-256이어야 합니다.`);
  }
}

/**
 * 블라인드 출력에는 후보 이름뿐 아니라 후보 구조를 역추론할 수 있는 내부 호출명도 허용하지 않습니다.
 * Judge 공통 길이 정책과 같은 NFKC 정규화를 사용하고 format 문자를 제거한 뒤 구분자 우회도 검사합니다.
 */
function assertNoReviewArchitectureLeak(value: unknown, location: string): void {
  assertNoBlindJudgeIdentityLeak(value, location);
  const visit = (item: unknown, path: string): void => {
    if (typeof item === "string") {
      const normalized = normalizeBlindJudgeText(item).toLocaleLowerCase("en-US");
      const compact = normalized.replace(/[^\p{L}\p{N}]+/gu, "");
      const forbidden = [
        /system[abc]/,
        /getorder/,
        /searchpolicy/,
        /retrieval/,
        /vector/,
        /readonlytoolagent/,
        /toolagent/,
        /agentic/,
      ];
      const ragToken = /(?:^|[^a-z0-9])r[^a-z0-9]*a[^a-z0-9]*g(?:$|[^a-z0-9])/i
        .test(normalized);
      const naturalLanguageArchitectureToken = (
        /(?:^|\.)(?:customer_reply|concerning_excerpt|rationale|evidence_excerpt)(?:$|\[)/.test(path)
        && containsBlindReviewArchitectureHint(item)
      );
      if (
        forbidden.some((pattern) => pattern.test(compact))
        || ragToken
        || naturalLanguageArchitectureToken
      ) {
        throw new TypeError(`${path}에 금지된 후보 구조 identity 누출이 있습니다.`);
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (typeof item !== "object" || item === null) return;
    for (const [key, child] of Object.entries(item as JsonRecord)) {
      if (/^(?:tool|tools|tool_calls|retrieval|vector_store|agent)$/i.test(key)) {
        throw new TypeError(`${path}.${key}에 금지된 후보 구조 필드가 있습니다.`);
      }
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, location);
}

function parseBuildInput(input: unknown): BuildBlindReviewQueueInput {
  const record = readPlainRecord(input, "review queue input");
  assertExactKeys(
    record,
    [
      "schema_version",
      "execution_evidence",
      "authoritative_blinding_precommit",
      "private_blinding_context",
      "judge_cases",
    ],
    "review queue input",
  );
  if (record.schema_version !== "build-blind-review-queue-input-v1") {
    throw new TypeError("review queue input schema version이 다릅니다.");
  }
  const execution = readPlainRecord(record.execution_evidence, "execution_evidence");
  assertExactKeys(
    execution,
    ["schema_version", "execution_identity", "completed_slots"],
    "execution_evidence",
  );
  if (execution.schema_version !== "review-queue-execution-evidence-v1") {
    throw new TypeError("execution_evidence schema version이 다릅니다.");
  }
  if (!Array.isArray(execution.completed_slots) || execution.completed_slots.length !== 72) {
    throw new TypeError("execution_evidence에는 잠긴 completed slot 72개가 필요합니다.");
  }
  const completedSlots = execution.completed_slots.map((rawSlot, index) => {
    const slot = readPlainRecord(rawSlot, `execution_evidence.completed_slots[${index}]`);
    assertExactKeys(
      slot,
      ["slot_identity", "intent", "receipt", "checkpoint"],
      `execution_evidence.completed_slots[${index}]`,
    );
    return rawSlot as BenchmarkCompletedSlot;
  });
  const privateContext = readPlainRecord(
    record.private_blinding_context,
    "private_blinding_context",
  );
  assertExactKeys(
    privateContext,
    ["schema_version", "master_blinding_seed"],
    "private_blinding_context",
  );
  if (
    privateContext.schema_version !== "private-blinding-context-v1"
    || typeof privateContext.master_blinding_seed !== "string"
  ) {
    throw new TypeError("private_blinding_context의 version 또는 seed 계약이 다릅니다.");
  }
  const authoritativePrecommit = readPlainRecord(
    record.authoritative_blinding_precommit,
    "authoritative_blinding_precommit",
  );
  assertExactKeys(authoritativePrecommit, [
    "schema_version",
    "artifact_kind",
    "authority_root_id",
    "authority_store_id",
    "execution_pack_hash",
    "manifest_digest",
    "master_blinding_seed_commitment",
    "manifest",
  ], "authoritative_blinding_precommit");
  if (!Array.isArray(record.judge_cases) || record.judge_cases.length !== 12) {
    throw new TypeError("review queue에는 exact hidden Judge case 12개가 필요합니다.");
  }
  return {
    schema_version: "build-blind-review-queue-input-v1",
    execution_evidence: {
      schema_version: "review-queue-execution-evidence-v1",
      execution_identity: execution.execution_identity as BenchmarkExecutionIdentity,
      completed_slots: completedSlots,
    },
    authoritative_blinding_precommit:
      record.authoritative_blinding_precommit as AuthoritativeBlindingPrecommit,
    private_blinding_context: {
      schema_version: "private-blinding-context-v1",
      master_blinding_seed: privateContext.master_blinding_seed,
    },
    judge_cases: record.judge_cases as ReviewQueueJudgeCase[],
  };
}

function buildValidatedExecutionPack(
  evidence: ReviewQueueExecutionEvidence,
): BenchmarkExecutionPack {
  const lockedSchedule = buildBenchmarkSchedule(BENCHMARK_CASES, ["A", "B", "C"]);
  return buildBenchmarkExecutionPack({
    executionIdentity: evidence.execution_identity,
    schedule: lockedSchedule,
    completedSlots: evidence.completed_slots,
  });
}

function candidateSourcesForCase(
  executionPack: BenchmarkExecutionPack,
  caseId: string,
): [CandidateJudgeSource, CandidateJudgeSource, CandidateJudgeSource] {
  return BENCHMARK_CANDIDATE_IDS.map((candidateId) => ({
    candidate_id: candidateId,
    runs: ([1, 2] as const).map((repetition) => {
      const slot = executionPack.slots.find((item) => (
        item.slot.case_id === caseId
        && item.slot.candidate_id === candidateId
        && item.slot.repetition === repetition
      ));
      if (!slot) throw new TypeError(`${caseId}:${candidateId}:r${repetition} slot이 없습니다.`);
      if (slot.cost_state !== "COMPLETE" || slot.run === null) {
        throw new TypeError(`${caseId}:${candidateId}:r${repetition}은 Judge-ready slot이 아닙니다.`);
      }
      if (slot.execution_status === "COMPLETE") {
        if (slot.evaluation_state.status !== "EVALUATED") {
          throw new TypeError(`${caseId}:${candidateId}:r${repetition} 완료 slot 평가가 없습니다.`);
        }
        return {
          repetition,
          execution_status: "COMPLETE" as const,
          output: parseCandidateOutput(slot.run.output),
        };
      }
      if (
        slot.execution_status !== "INVALID"
        && slot.execution_status !== "TIMEOUT"
        && slot.execution_status !== "BUDGET_EXCEEDED"
      ) {
        throw new TypeError(`${caseId}:${candidateId}:r${repetition} terminal 상태가 Judge 계약과 다릅니다.`);
      }
      return {
        repetition,
        execution_status: slot.execution_status,
        output: null,
      };
    }),
  })) as [CandidateJudgeSource, CandidateJudgeSource, CandidateJudgeSource];
}

function validateJudgeReceipt(
  rawReceipt: unknown,
  expectedInput: BlindJudgeInput,
  authoritativeBlindingPrecommit: AuthoritativeBlindingPrecommit,
): {
  readonly disposition: "COMPLETE" | "HUMAN_FALLBACK";
  readonly result: BlindJudgeResult | null;
  readonly receiptHash: string;
} {
  const receipt = parseBlindJudgeRunRecord(
    rawReceipt,
    expectedInput,
    authoritativeBlindingPrecommit,
  );
  if (
    receipt.authority !== "RISK_ONLY_REVIEW_REQUIRED"
    || receipt.costState !== "COMPLETE"
    || receipt.usageCost === null
  ) {
    throw new TypeError("Judge run receipt는 risk-only 권위와 완전한 비용 근거여야 합니다.");
  }
  if (receipt.judgeStatus === "JUDGE_COMPLETE") {
    if (receipt.result === null) {
      throw new TypeError("완료 Judge receipt에는 risk-only 결과가 필요합니다.");
    }
    return {
      disposition: "COMPLETE",
      result: receipt.result,
      receiptHash: sha256CanonicalJson(receipt),
    };
  }
  if (
    receipt.result !== null
    || receipt.attempts.length === 0
    || receipt.attempts.some((attempt) => (
      attempt.requestDisposition !== "RESPONSE_RECEIVED"
      || attempt.costState !== "COMPLETE"
    ))
  ) {
    throw new TypeError(
      "사람 fallback은 결과가 없고 모든 시도가 RESPONSE_RECEIVED·완전 비용인 안전한 Judge 실패만 허용합니다.",
    );
  }
  return {
    disposition: "HUMAN_FALLBACK",
    result: null,
    receiptHash: sha256CanonicalJson(receipt),
  };
}

interface ValidatedJudgeCase {
  readonly caseId: string;
  readonly expectedInput: BlindJudgeInput;
  readonly mapping: ExecutionBoundPrivateBlindMapping;
  readonly disposition: "COMPLETE" | "HUMAN_FALLBACK";
  readonly result: BlindJudgeResult | null;
  readonly receiptHash: string;
}

function validateJudgeCases(
  rawCases: readonly ReviewQueueJudgeCase[],
  executionPack: BenchmarkExecutionPack,
  executionPackHash: string,
  manifest: JudgeEvidencePrecommitManifest,
  privateContext: PrivateBlindingContext,
  authoritativeBlindingPrecommit: AuthoritativeBlindingPrecommit,
): ReadonlyMap<string, ValidatedJudgeCase> {
  if (manifest.execution_pack_hash !== executionPackHash) {
    throw new TypeError("Judge precommit manifest가 authoritative execution pack hash와 다릅니다.");
  }
  const validated = new Map<string, ValidatedJudgeCase>();
  rawCases.forEach((rawCase, index) => {
    const record = readPlainRecord(rawCase, `judge_cases[${index}]`);
    assertExactKeys(record, [
      "schema_version",
      "case_id",
      "expected_blind_input",
      "private_mapping",
      "judge_run_receipt",
    ], `judge_cases[${index}]`);
    if (record.schema_version !== "review-queue-judge-case-v1") {
      throw new TypeError(`judge_cases[${index}] schema version이 다릅니다.`);
    }
    assertHiddenCaseId(record.case_id, `judge_cases[${index}].case_id`);
    const caseId = record.case_id;
    if (validated.has(caseId)) throw new TypeError(`Judge case가 중복됐습니다: ${caseId}`);
    const evaluationCase = BENCHMARK_CASES.find((item) => item.case_id === caseId);
    const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === caseId);
    if (!evaluationCase || !oracle) throw new TypeError(`잠긴 case/oracle이 없습니다: ${caseId}`);
    const mapping = validateExecutionBoundPrivateBlindMapping({
      input: record.private_mapping,
      expectedCaseId: caseId,
      expectedExecutionPackHash: executionPackHash,
      expectedMasterBlindingSeed: privateContext.master_blinding_seed,
      expectedMasterCommitment: manifest.master_blinding_seed_commitment,
    });
    const rebuilt = buildBlindJudgeInput({
      evaluationCase,
      oracle,
      candidateSources: candidateSourcesForCase(executionPack, caseId),
      blindingSeed: mapping.case_blinding_seed,
    });
    const mappingLabelsMatch = BLIND_JUDGE_LABELS.every((label) => (
      rebuilt.private_mapping.label_to_candidate[label]
      === mapping.label_to_candidate[label]
    ));
    const manifestBinding = manifest.case_bindings.find((item) => item.case_id === caseId);
    if (
      !same(record.expected_blind_input, rebuilt.judge_input)
      || !mappingLabelsMatch
      || manifestBinding?.judge_input_hash !== sha256CanonicalJson(rebuilt.judge_input)
      || manifestBinding.private_mapping_hash !== mapping.private_mapping_hash
    ) {
      throw new TypeError(
        `${caseId} expected blind input·mapping이 precommit과 기록 execution slot에 binding되지 않습니다.`,
      );
    }
    assertNoReviewArchitectureLeak(
      rebuilt.judge_input.blind_candidates,
      `${caseId} blind candidate projection`,
    );
    const judge = validateJudgeReceipt(
      record.judge_run_receipt,
      rebuilt.judge_input,
      authoritativeBlindingPrecommit,
    );
    validated.set(caseId, {
      caseId,
      expectedInput: rebuilt.judge_input,
      mapping,
      disposition: judge.disposition,
      result: judge.result,
      receiptHash: judge.receiptHash,
    });
  });
  if (HIDDEN_CASE_IDS.some((caseId) => !validated.has(caseId))) {
    throw new TypeError("Judge case 집합은 H-001부터 H-012까지 정확히 한 번씩 필요합니다.");
  }
  const rebuiltManifest = buildJudgeEvidencePrecommitManifest({
    executionPackHash,
    masterBlindingSeed: privateContext.master_blinding_seed,
    judgeInputBindings: HIDDEN_CASE_IDS.map((caseId) => ({
      case_id: caseId,
      judge_input_hash: sha256CanonicalJson(validated.get(caseId)!.expectedInput),
    })),
  });
  if (!same(manifest, rebuiltManifest)) {
    throw new TypeError(
      "Judge precommit manifest가 하나의 master seed에서 파생한 exact 12 case binding과 다릅니다.",
    );
  }
  return validated;
}

function slotForBlindRun(
  pack: BenchmarkExecutionPack,
  judgeCase: ValidatedJudgeCase,
  blindLabel: BlindJudgeLabel,
  repetition: 1 | 2,
): RecordedBenchmarkSlot {
  const candidateId = judgeCase.mapping.label_to_candidate[blindLabel];
  const slot = pack.slots.find((item) => (
    item.slot.case_id === judgeCase.caseId
    && item.slot.candidate_id === candidateId
    && item.slot.repetition === repetition
  ));
  if (!slot) throw new TypeError(`${judgeCase.caseId}:${blindLabel}:r${repetition} slot이 없습니다.`);
  return slot;
}

function classifyEvidenceLocation(evidenceId: string): BlindDeterministicEvidenceLocation["location_kind"] {
  const normalized = evidenceId.toLocaleLowerCase("en-US");
  if (normalized.startsWith("output:")) return "CANDIDATE_OUTPUT";
  if (normalized.startsWith("case:")) return "LOCKED_CASE";
  if (normalized.startsWith("oracle:")) return "LOCKED_ORACLE";
  if (normalized.startsWith("policy:") || normalized.startsWith("citation:")) {
    return "POLICY_EVIDENCE";
  }
  if (normalized.startsWith("access:") || normalized.startsWith("order:")) {
    return "ORDER_ACCESS";
  }
  if (
    normalized.startsWith("execution:")
    || normalized.startsWith("tool:")
    || normalized.startsWith("retrieval:")
  ) return "EXECUTION_TRACE";
  return "LOCKED_EVIDENCE";
}

function safeDeterministicExcerpt(message: string): string {
  const redacted = message
    .normalize(BLIND_JUDGE_OUTPUT_LENGTH_POLICY.normalization)
    .replace(/\p{Cf}/gu, "")
    .replace(/\b(?:candidate|system)\s*[ABC]\b/gi, "blind configuration")
    .replace(/\b(?:get[\s_-]*order|search[\s_-]*policy)\b/gi, "read-only operation")
    .replace(/\b(?:R\W*A\W*G|retrieval|vector\s*store|tool\s*agent|agent)\b/gi, "evidence path")
    .replace(/도구\s+[^\s,.]+/gu, "읽기 전용 실행")
    .replace(/\s+/g, " ")
    .trim();
  const excerpt = Array.from(redacted).slice(0, 240).join("");
  if (containsBlindReviewArchitectureHint(excerpt)) {
    return "[Evidence wording withheld to preserve blind review.]";
  }
  return excerpt.length > 0 ? excerpt : "잠긴 결정적 근거에서 실패가 확인됐습니다.";
}

function blindDeterministicFindingCode(code: string): string {
  const normalized = normalizeBlindJudgeText(code).toLocaleLowerCase("en-US");
  const compact = normalized.replace(/[^\p{L}\p{N}]+/gu, "");
  if (
    /(?:getorder|searchpolicy|retriev|vector|tool|agent|functioncall|llm|prompt|searchindex)/.test(compact)
    || /(?:^|[^a-z0-9])r[^a-z0-9]*a[^a-z0-9]*g(?:$|[^a-z0-9])/i.test(normalized)
  ) {
    return "EXECUTION_CONTRACT_MISMATCH";
  }
  return code;
}

interface EvidenceHandleContext {
  readonly masterBlindingSeed: string;
  readonly executionPackHash: string;
}

function evidenceHandle(
  context: EvidenceHandleContext,
  domain: string,
  payload: unknown,
): `evh_${string}` {
  return deriveOpaqueEvidenceHandle({
    masterBlindingSeed: context.masterBlindingSeed,
    executionPackHash: context.executionPackHash,
    domain,
    payload,
  });
}

function deterministicGateEvidenceFor(
  pack: BenchmarkExecutionPack,
  judgeCase: ValidatedJudgeCase,
  blindLabel: BlindJudgeLabel,
  handleContext: EvidenceHandleContext,
): BlindDeterministicGateEvidence[] {
  return ([1, 2] as const).flatMap((repetition) => {
    const slot = slotForBlindRun(pack, judgeCase, blindLabel, repetition);
    if (
      slot.execution_status === "INVALID"
      || slot.execution_status === "TIMEOUT"
      || slot.execution_status === "BUDGET_EXCEEDED"
    ) {
      if (slot.evaluation_state.status !== "NOT_EVALUATED") {
        throw new TypeError(`${judgeCase.caseId}:${blindLabel} terminal 실행 평가 상태가 다릅니다.`);
      }
      return [];
    }
    const gates = slot.evaluation_state.gates;
    if (!Array.isArray(gates) || gates.length !== 4) {
      throw new TypeError(`${judgeCase.caseId}:${blindLabel} gate 근거가 불완전합니다.`);
    }
    return gates.flatMap((rawGate): BlindDeterministicGateEvidence[] => {
      const gate = readPlainRecord(rawGate, `${judgeCase.caseId}:${blindLabel}:gate`);
      if (gate.status !== "CONFIRMED_FAIL") return [];
      if (
        gate.gateCode !== "P0-HG-01"
        && gate.gateCode !== "P0-HG-02"
        && gate.gateCode !== "P0-HG-03"
        && gate.gateCode !== "P0-HG-04"
      ) {
        throw new TypeError(`${judgeCase.caseId}:${blindLabel} gate ID가 잠긴 계약과 다릅니다.`);
      }
      if (!Array.isArray(gate.findings) || gate.findings.length === 0) {
        throw new TypeError(`${judgeCase.caseId}:${blindLabel} confirmed gate에 finding이 없습니다.`);
      }
      const findings = gate.findings.map((rawFinding, findingIndex) => {
        const finding = readPlainRecord(
          rawFinding,
          `${judgeCase.caseId}:${blindLabel}:finding[${findingIndex}]`,
        );
        assertExactKeys(
          finding,
          ["code", "evidenceIds", "message"],
          `${judgeCase.caseId}:${blindLabel}:finding[${findingIndex}]`,
        );
        if (
          typeof finding.code !== "string"
          || finding.code.length === 0
          || typeof finding.message !== "string"
          || finding.message.length === 0
          || !Array.isArray(finding.evidenceIds)
          || finding.evidenceIds.length === 0
          || finding.evidenceIds.some((item) => typeof item !== "string" || item.length === 0)
        ) {
          throw new TypeError(`${judgeCase.caseId}:${blindLabel} finding 근거가 불완전합니다.`);
        }
        const evidenceExcerpt = safeDeterministicExcerpt(finding.message);
        assertNoReviewArchitectureLeak(
          evidenceExcerpt,
          `${judgeCase.caseId}:${blindLabel}:finding excerpt`,
        );
        return {
          finding_code: blindDeterministicFindingCode(finding.code),
          source_finding_handle: evidenceHandle(
            handleContext,
            "DETERMINISTIC_FINDING_CODE",
            { case_id: judgeCase.caseId, blind_label: blindLabel, code: finding.code },
          ),
          evidence_excerpt: evidenceExcerpt,
          source_message_handle: evidenceHandle(
            handleContext,
            "DETERMINISTIC_FINDING_MESSAGE",
            { case_id: judgeCase.caseId, blind_label: blindLabel, message: finding.message },
          ),
          evidence_locations: finding.evidenceIds.map((evidenceId) => ({
            location_kind: classifyEvidenceLocation(evidenceId as string),
            reference_handle: evidenceHandle(
              handleContext,
              "DETERMINISTIC_EVIDENCE_REFERENCE",
              {
                case_id: judgeCase.caseId,
                blind_label: blindLabel,
                evidence_id: evidenceId,
              },
            ),
          })),
        };
      });
      return [{
        case_id: judgeCase.caseId,
        blind_label: blindLabel,
        repetition,
        gate_id: gate.gateCode,
        status: "CONFIRMED_FAIL",
        evidence_handle: evidenceHandle(
          handleContext,
          "DETERMINISTIC_GATE_EVIDENCE",
          {
            case_id: judgeCase.caseId,
            blind_label: blindLabel,
            repetition,
            gate_id: gate.gateCode,
            receipt_payload_sha256: slot.receipt_payload_sha256,
            checkpoint_payload_sha256: slot.checkpoint_payload_sha256,
          },
        ),
        findings,
      }];
    });
  });
}

function deterministicFailureFor(
  pack: BenchmarkExecutionPack,
  judgeCase: ValidatedJudgeCase,
  blindLabel: BlindJudgeLabel,
  handleContext: EvidenceHandleContext,
): boolean {
  return deterministicGateEvidenceFor(
    pack,
    judgeCase,
    blindLabel,
    handleContext,
  ).length > 0;
}

function risksFor(
  result: BlindJudgeResult | null,
  blindLabel: BlindJudgeLabel,
): BlindReviewQueueRisk[] {
  if (result === null) return [];
  const candidate = result.candidates.find((item) => item.blind_label === blindLabel);
  if (!candidate) throw new TypeError(`${result.case_id}:${blindLabel} Judge 결과가 없습니다.`);
  return candidate.criteria.flatMap((criterion): BlindReviewQueueRisk[] => {
    if (
      criterion.status !== "RISK"
      || criterion.severity === null
      || criterion.failure_type === null
    ) return [];
    return [{
      criterion_id: criterion.criterion_id,
      status: "RISK",
      severity: criterion.severity,
      failure_type: criterion.failure_type,
      concerning_excerpt: containsBlindReviewArchitectureHint(
        criterion.concerning_excerpt,
      )
        ? "[Risk excerpt withheld to preserve blind review.]"
        : criterion.concerning_excerpt,
      evidence_ids: [...criterion.evidence_ids],
      rationale: containsBlindReviewArchitectureHint(criterion.rationale)
        ? "Auxiliary risk wording was withheld; review the cited evidence under this criterion."
        : criterion.rationale,
    }];
  });
}

function highestSeverity(risks: readonly BlindReviewQueueRisk[]): BlindJudgeSeverity | null {
  if (risks.length === 0) return null;
  return [...risks]
    .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity])[0]
    .severity;
}

function buildItem({
  pack,
  judgeCase,
  blindLabel,
  queueReason,
  handleContext,
}: {
  pack: BenchmarkExecutionPack;
  judgeCase: ValidatedJudgeCase;
  blindLabel: BlindJudgeLabel;
  queueReason: BlindReviewQueueItem["queue_reason"];
  handleContext: EvidenceHandleContext;
}): BlindReviewQueueItem {
  const inputCandidate = judgeCase.expectedInput.blind_candidates.find(
    (item) => item.blind_label === blindLabel,
  );
  if (!inputCandidate) throw new TypeError(`${judgeCase.caseId}:${blindLabel} blind 입력이 없습니다.`);
  const judgeRisks = risksFor(judgeCase.result, blindLabel);
  const deterministicGateEvidence = deterministicGateEvidenceFor(
    pack,
    judgeCase,
    blindLabel,
    handleContext,
  );
  const runs = inputCandidate.runs.map((inputRun) => {
    const recordedSlot = slotForBlindRun(
      pack,
      judgeCase,
      blindLabel,
      inputRun.repetition,
    );
    if (recordedSlot.run === null) {
      throw new TypeError(
        `${judgeCase.caseId}:${blindLabel}:r${inputRun.repetition} terminal run 근거가 없습니다.`,
      );
    }
    if (recordedSlot.execution_status !== inputRun.execution_status) {
      throw new TypeError(`${judgeCase.caseId}:${blindLabel}:r${inputRun.repetition} 실행 상태 binding이 다릅니다.`);
    }
    const reviewOutput = recordedSlot.execution_status === "COMPLETE"
      ? buildBlindReviewCandidateOutputProjection(
          parseCandidateOutput(recordedSlot.run.output),
        )
      : null;
    if (!same(reviewOutput, inputRun.output)) {
      throw new TypeError(`${judgeCase.caseId}:${blindLabel}:r${inputRun.repetition} terminal output binding이 다릅니다.`);
    }
    for (const [key, value] of Object.entries({
      slot_identity_hash: recordedSlot.slot_identity_hash,
      intent_payload_sha256: recordedSlot.intent_payload_sha256,
      receipt_payload_sha256: recordedSlot.receipt_payload_sha256,
      checkpoint_payload_sha256: recordedSlot.checkpoint_payload_sha256,
    })) assertSha256(value, `${judgeCase.caseId}:${blindLabel}:${key}`);
    return {
      repetition: inputRun.repetition,
      evidence_id: inputRun.evidence_id,
      execution_status: inputRun.execution_status,
      review_output: structuredClone(reviewOutput),
      projection: structuredClone(inputRun.projection),
      evidence_handle: evidenceHandle(
        handleContext,
        "REVIEW_RUN_EVIDENCE",
        {
          case_id: judgeCase.caseId,
          blind_label: blindLabel,
          repetition: inputRun.repetition,
          slot_identity_hash: recordedSlot.slot_identity_hash,
          intent_payload_sha256: recordedSlot.intent_payload_sha256,
          receipt_payload_sha256: recordedSlot.receipt_payload_sha256,
          checkpoint_payload_sha256: recordedSlot.checkpoint_payload_sha256,
        },
      ),
    };
  }) as [BlindReviewQueueRun, BlindReviewQueueRun];
  return {
    item_id: `${judgeCase.caseId}--${blindLabel}`,
    case_id: judgeCase.caseId,
    blind_label: blindLabel,
    queue_reason: queueReason,
    priority_severity: highestSeverity(judgeRisks),
    deterministic_gate_finding: deterministicGateEvidence.length > 0
      ? "CONFIRMED_FAIL"
      : "NONE",
    deterministic_gate_evidence: deterministicGateEvidence,
    judge_risks: judgeRisks,
    judge_evidence_handle: evidenceHandle(
      handleContext,
      "JUDGE_RUN_EVIDENCE",
      {
        case_id: judgeCase.caseId,
        receipt_hash: judgeCase.receiptHash,
      },
    ),
    runs,
    review_authority: "HUMAN_REVIEW_REQUIRED",
  };
}

function compareAdditionalItems(
  left: BlindReviewQueueItem,
  right: BlindReviewQueueItem,
): number {
  if (left.priority_severity === null || right.priority_severity === null) {
    throw new TypeError("Judge 추가 항목에는 위험 severity가 필요합니다.");
  }
  const severity = SEVERITY_ORDER[left.priority_severity]
    - SEVERITY_ORDER[right.priority_severity];
  if (severity !== 0) return severity;
  const caseOrder = left.case_id.localeCompare(right.case_id, "en");
  if (caseOrder !== 0) return caseOrder;
  return LABEL_ORDER[left.blind_label] - LABEL_ORDER[right.blind_label];
}

export function buildBlindReviewQueue(input: unknown): BlindReviewQueue {
  const parsed = parseBuildInput(input);
  const executionPack = buildValidatedExecutionPack(parsed.execution_evidence);
  assertAuxiliaryJudgeEligibleBenchmarkExecutionPack(executionPack);
  const executionPackHash = sha256CanonicalJson(executionPack);
  const manifest = assertAuthoritativeBlindingPrecommit({
    anchor: parsed.authoritative_blinding_precommit,
    expectedExecutionPackHash: executionPackHash,
    masterBlindingSeed: parsed.private_blinding_context.master_blinding_seed,
  });
  const judgeCases = validateJudgeCases(
    parsed.judge_cases,
    executionPack,
    executionPackHash,
    manifest,
    parsed.private_blinding_context,
    parsed.authoritative_blinding_precommit,
  );
  const handleContext: EvidenceHandleContext = {
    masterBlindingSeed: parsed.private_blinding_context.master_blinding_seed,
    executionPackHash,
  };
  const highRiskIds = new Set<string>(HIGH_RISK_CASE_IDS);
  const fallbackCaseIds = HIDDEN_CASE_IDS.filter(
    (caseId) => judgeCases.get(caseId)?.disposition === "HUMAN_FALLBACK",
  );
  const fallbackCaseIdSet = new Set(fallbackCaseIds);

  const requiredItems = HIGH_RISK_CASE_IDS.flatMap((caseId) => {
    const judgeCase = judgeCases.get(caseId);
    if (!judgeCase) throw new TypeError(`잠긴 high-risk Judge case가 없습니다: ${caseId}`);
    return BLIND_JUDGE_LABELS.map((blindLabel) => buildItem({
      pack: executionPack,
      judgeCase,
      blindLabel,
      queueReason: fallbackCaseIdSet.has(caseId)
        ? "JUDGE_INCOMPLETE_FALLBACK"
        : "LOCKED_HIGH_RISK",
      handleContext,
    }));
  });

  const fallbackItems = fallbackCaseIds.flatMap((caseId) => {
    if (highRiskIds.has(caseId)) return [];
    const judgeCase = judgeCases.get(caseId);
    if (!judgeCase) throw new TypeError(`사람 fallback Judge case가 없습니다: ${caseId}`);
    return BLIND_JUDGE_LABELS.map((blindLabel) => buildItem({
      pack: executionPack,
      judgeCase,
      blindLabel,
      queueReason: "JUDGE_INCOMPLETE_FALLBACK",
      handleContext,
    }));
  });

  const additionalItems = HIDDEN_CASE_IDS.flatMap((caseId) => {
    if (highRiskIds.has(caseId) || fallbackCaseIdSet.has(caseId)) return [];
    const judgeCase = judgeCases.get(caseId);
    if (!judgeCase) throw new TypeError(`Judge case가 없습니다: ${caseId}`);
    return BLIND_JUDGE_LABELS.flatMap((blindLabel): BlindReviewQueueItem[] => {
      // 결정적 실패는 이미 authoritative hard-gate 근거에 존재하므로 Judge 위험으로 중복하지 않습니다.
      if (deterministicFailureFor(
        executionPack,
        judgeCase,
        blindLabel,
        handleContext,
      )) return [];
      const item = buildItem({
        pack: executionPack,
        judgeCase,
        blindLabel,
        queueReason: "JUDGE_RISK",
        handleContext,
      });
      return item.judge_risks.length > 0 ? [item] : [];
    });
  }).sort(compareAdditionalItems);

  const overflowDetected = additionalItems.length > MAXIMUM_ADDITIONAL_ITEMS;
  const queueWithoutHashes: BlindReviewQueueWithoutHashes = {
    schema_version: "blind-review-queue-v2",
    artifact_kind: "BLIND_REVIEW_QUEUE",
    synthetic: true,
    execution_pack_hash: executionPackHash,
    judge_authority: "RISK_ONLY",
    review_status: "REVIEW_PENDING",
    evaluation_status: "EVALUATION_INCOMPLETE",
    baseline_version: null,
    queue_status: overflowDetected ? "OVERFLOW" : "READY_FOR_REVIEW",
    required_item_count: 12,
    additional_item_count: additionalItems.length,
    human_fallback_case_count: fallbackCaseIds.length,
    human_fallback_item_count: fallbackCaseIds.length * 3,
    overflow: {
      detected: overflowDetected,
      maximum_additional_items: 6,
      observed_additional_items: additionalItems.length,
      disposition: overflowDetected ? "EVALUATION_INCOMPLETE" : "NONE",
    },
    // Overflow에서도 모든 위험을 보존하며 임의로 여섯 개만 선택하지 않습니다.
    items: [...requiredItems, ...fallbackItems, ...additionalItems],
  };
  const queueWithOrderHash: BlindReviewQueueContentSource = {
    ...queueWithoutHashes,
    queue_set_order_hash: calculateBlindReviewQueueSetOrderHash(
      queueWithoutHashes,
    ),
  };
  const queue: BlindReviewQueue = {
    ...queueWithOrderHash,
    queue_content_hash: calculateBlindReviewQueueContentHash(
      queueWithOrderHash,
    ),
  };
  assertNoReviewArchitectureLeak(queue, "blind review queue");
  const maxLength = BLIND_JUDGE_OUTPUT_LENGTH_POLICY.max_unicode_code_points_per_run;
  for (const item of queue.items) {
    for (const run of item.runs) {
      if (run.review_output === null) continue;
      const length = Array.from(
        canonicalJsonStringify(run.review_output).normalize(
          BLIND_JUDGE_OUTPUT_LENGTH_POLICY.normalization,
        ),
      ).length;
      if (length > maxLength) {
        throw new TypeError(`${item.item_id}:r${run.repetition}이 공통 output length policy를 넘습니다.`);
      }
    }
  }
  return brandValidatedBlindReviewQueue(queue);
}

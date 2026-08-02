import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { redactSensitiveText } from "../cli/calibrationOutcome";
import {
  P0_CANDIDATE_COMPLEXITY_PROFILES,
  parseCandidateComplexityProfiles,
} from "../contracts/candidateComplexity";
import { BENCHMARK_DATASET_HASH } from "../data/benchmark";
import { isOpenAITimeoutError } from "../openai/requestError";
import { canonicalJsonStringify, sha256CanonicalJson } from "../runtime/canonicalJson";
import {
  calculateUsageCost,
  type TokenUsage,
} from "../runtime/pricing";
import {
  FINAL_DECISION_MEMO_ADAPTER_CONTRACT,
  FINAL_DECISION_MEMO_CANDIDATE_VERSIONS,
  FINAL_DECISION_MEMO_CLAIM_EVIDENCE_CONTRACT,
  FINAL_DECISION_MEMO_OPENAI_REQUEST_CONTRACT,
  FINAL_DECISION_MEMO_OUTPUT_SCHEMA,
  FINAL_DECISION_MEMO_PRICING_SNAPSHOT,
  assertAuthoritativeFinalDecisionMemoAdapterRequest,
  buildFinalDecisionMemoClaimEvidenceRefs,
  buildFinalDecisionMemoRequiredOutput,
  type FinalDecisionMemoAdapter,
  type FinalDecisionMemoAdapterOutput,
  type FinalDecisionMemoAdapterRequest,
  type FinalDecisionMemoAdapterResult,
  type FinalDecisionMemoAttemptEvidence,
} from "./decisionBaseline";

const CANDIDATE_IDS = ["A", "B", "C"] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const REQUEST_KEYS = [
  "schema_version",
  "synthetic",
  "authority",
  "selected_candidate_id",
  "human_selection_rationale",
  "recommendation",
  "eligible_candidate_ids",
  "candidate_assessments",
  "human_review",
  "recorded_benchmark_pack_hash",
  "human_confirmation_receipt_hash",
  "aggregation_hash",
  "benchmark_metadata",
  "required_external_action_statement",
] as const;
const BENCHMARK_METADATA_KEYS = [
  "challenge_version",
  "recorded_benchmark_pack_schema_version",
  "benchmark_execution_pack_schema_version",
  "dataset_hash",
  "coverage",
  "candidate_versions",
  "human_review_sample",
] as const;
const BENCHMARK_COVERAGE_KEYS = [
  "cases",
  "candidates",
  "runs_per_case",
  "candidate_runs",
  "judge_cases",
] as const;
const CANDIDATE_VERSION_KEYS = ["A", "B", "C"] as const;
const HUMAN_REVIEW_SAMPLE_KEYS = [
  "required_high_risk_cases",
  "required_candidate_case_reviews",
  "completed_candidate_case_reviews",
  "judge_flagged_candidate_case_reviews",
  "statistical_generalization",
] as const;
const CANDIDATE_ASSESSMENT_KEYS = [
  "candidate_id",
  "gate_status",
  "critical_failed_case_ids",
  "deterministic_failed_case_ids",
  "human_confirmed_failed_case_ids",
  "open_review_count",
  "failed_sufficiency_rules",
  "sufficiency_passed",
  "eligible",
  "complexity_profile",
  "observed",
] as const;
const OBSERVED_ASSESSMENT_KEYS = [
  "valid_runs",
  "policy_success_cases",
  "citation_success_cases",
  "escalation_success_cases",
  "stable_cases",
  "average_runtime_cost_usd",
  "median_latency_ms",
  "worst_latency_ms",
] as const;
const HUMAN_REVIEW_KEYS = [
  "reviewed_items",
  "remaining_items",
  "total_review_duration_ms",
  "total_edit_duration_ms",
  "reviewed_unique_cases_by_candidate",
  "by_candidate",
] as const;
const HUMAN_REVIEW_CANDIDATE_KEYS = [
  "reviewed_items",
  "reviewed_unique_cases",
  "review_duration_ms",
  "edit_duration_ms",
  "corrected_reply_items",
] as const;
const FAILED_SUFFICIENCY_RULES = [
  "CRITICAL_FAILURES",
  "VALID_RUNS",
  "POLICY_DECISIONS",
  "CITATIONS",
  "ESCALATIONS",
  "REPEAT_STABILITY",
  "OPEN_REVIEWS",
  "RUNTIME_COST",
  "MEDIAN_LATENCY",
  "WORST_LATENCY",
] as const;
const GATE_STATUSES = [
  "PASS",
  "REVIEW_REQUIRED",
  "CONFIRMED_FAIL",
] as const;
const HIDDEN_CASE_ID = /^H-(?:00[1-9]|01[0-2])$/;
const OUTPUT_KEYS = [
  "selected_candidate_id",
  "decision_summary",
  "rejected_alternatives",
  "known_limitations",
  "next_poc_scope",
  "procurement_handoff",
  "external_action_statement",
] as const;
const REJECTED_ALTERNATIVE_KEYS = ["candidate_id", "reason"] as const;

export const OPENAI_FINAL_DECISION_MEMO_MODEL_REQUESTED_ID =
  "gpt-5.6-sol" as const;
export const OPENAI_FINAL_DECISION_MEMO_SERVICE_TIER_REQUESTED =
  "default" as const;
export const OPENAI_FINAL_DECISION_MEMO_MAX_OUTPUT_TOKENS = 4_000;
export const OPENAI_FINAL_DECISION_MEMO_DEFAULT_ATTEMPT_TIMEOUT_MS =
  FINAL_DECISION_MEMO_OPENAI_REQUEST_CONTRACT.defaultAttemptTimeoutMs;
export const OPENAI_FINAL_DECISION_MEMO_MAX_ATTEMPTS = 2;
export const OPENAI_FINAL_DECISION_MEMO_SHORT_CONTEXT_MAX_INPUT_TOKENS =
  272_000;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export const OPENAI_FINAL_DECISION_MEMO_RESPONSE_FORMAT = deepFreeze({
  type: "json_schema" as const,
  name: "final_decision_memo",
  strict: true,
  schema: structuredClone(FINAL_DECISION_MEMO_OUTPUT_SCHEMA),
});

export const OPENAI_FINAL_DECISION_MEMO_REQUEST_CONTRACT =
  FINAL_DECISION_MEMO_OPENAI_REQUEST_CONTRACT;

type JsonRecord = Record<string, unknown>;

function assertLockedDecisionMemoContract(): void {
  if (
    FINAL_DECISION_MEMO_ADAPTER_CONTRACT.model_requested_id
      !== OPENAI_FINAL_DECISION_MEMO_MODEL_REQUESTED_ID
    || FINAL_DECISION_MEMO_ADAPTER_CONTRACT.reasoning_effort !== "medium"
    || FINAL_DECISION_MEMO_ADAPTER_CONTRACT.store !== false
    || FINAL_DECISION_MEMO_ADAPTER_CONTRACT.authority
      !== "ADVISORY_PROSE_ONLY"
    || FINAL_DECISION_MEMO_ADAPTER_CONTRACT.deterministic_rules_override
      !== false
    || FINAL_DECISION_MEMO_ADAPTER_CONTRACT.strict_output_schema_hash
      !== sha256CanonicalJson(FINAL_DECISION_MEMO_OUTPUT_SCHEMA)
    || FINAL_DECISION_MEMO_ADAPTER_CONTRACT.pricing_snapshot_hash
      !== sha256CanonicalJson(FINAL_DECISION_MEMO_PRICING_SNAPSHOT)
    || FINAL_DECISION_MEMO_ADAPTER_CONTRACT.request_contract_hash
      !== sha256CanonicalJson(OPENAI_FINAL_DECISION_MEMO_REQUEST_CONTRACT)
    || FINAL_DECISION_MEMO_ADAPTER_CONTRACT.claim_evidence_contract_hash
      !== sha256CanonicalJson(FINAL_DECISION_MEMO_CLAIM_EVIDENCE_CONTRACT)
  ) {
    throw new TypeError(
      "Final Decision Memo production adapter가 잠긴 Decision Memo 계약과 다릅니다.",
    );
  }
}

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
      `${location}의 exact field 계약이 다릅니다. missing=${missing.join(",")} additional=${additional.join(",")}`,
    );
  }
}

function isCandidateId(value: unknown): value is (typeof CANDIDATE_IDS)[number] {
  return typeof value === "string"
    && (CANDIDATE_IDS as readonly string[]).includes(value);
}

function readBoundedText(
  value: unknown,
  location: string,
  maximum = 4_000,
): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > maximum
    || /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(
      `${location}은(는) 제어 문자가 없는 비어 있지 않은 제한 길이 문자열이어야 합니다.`,
    );
  }
  return value;
}

function readSha256(value: unknown, location: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`${location}은(는) lowercase SHA-256이어야 합니다.`);
  }
  return value;
}

function readBoundedSafeInteger(
  value: unknown,
  location: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = readNonNegativeSafeInteger(value, location);
  if (parsed < minimum || parsed > maximum) {
    throw new TypeError(
      `${location}은(는) ${minimum} 이상 ${maximum} 이하의 safe integer여야 합니다.`,
    );
  }
  return parsed;
}

function readHiddenCaseIds(
  value: unknown,
  location: string,
): readonly string[] {
  if (
    !Array.isArray(value)
    || value.some((item) => (
      typeof item !== "string" || !HIDDEN_CASE_ID.test(item)
    ))
  ) {
    throw new TypeError(
      `${location}에는 H-001부터 H-012 case ID만 허용됩니다.`,
    );
  }
  const normalized = [...new Set(value)].sort();
  if (
    normalized.length !== value.length
    || normalized.some((item, index) => item !== value[index])
  ) {
    throw new TypeError(
      `${location}은(는) 중복 없이 정렬된 case ID 배열이어야 합니다.`,
    );
  }
  return normalized;
}

function parseCandidateAssessments(
  value: unknown,
): {
  readonly eligibleCandidateIds: readonly (typeof CANDIDATE_IDS)[number][];
} {
  if (!Array.isArray(value) || value.length !== CANDIDATE_IDS.length) {
    throw new TypeError(
      "Final Decision Memo adapter request에는 A/B/C 순서의 후보 평가가 필요합니다.",
    );
  }
  const records = value.map((item, index) => {
    const location =
      `Final Decision Memo adapter request.candidate_assessments[${index}]`;
    const record = readPlainRecord(item, location);
    assertExactKeys(record, CANDIDATE_ASSESSMENT_KEYS, location);
    const candidateId = CANDIDATE_IDS[index];
    if (record.candidate_id !== candidateId) {
      throw new TypeError(
        `${location}.candidate_id가 잠긴 A/B/C 순서와 다릅니다.`,
      );
    }
    return record;
  });
  const complexityProfiles = parseCandidateComplexityProfiles(
    records.map((record) => record.complexity_profile),
    "Final Decision Memo adapter request.candidate_assessments[].complexity_profile",
  );
  if (
    canonicalJsonStringify(complexityProfiles)
      !== canonicalJsonStringify(P0_CANDIDATE_COMPLEXITY_PROFILES)
  ) {
    throw new TypeError(
      "Final Decision Memo adapter request의 운영 복잡도 프로필이 잠긴 P0 후보 계약과 다릅니다.",
    );
  }

  const eligibleCandidateIds: (typeof CANDIDATE_IDS)[number][] = [];
  for (const [index, record] of records.entries()) {
    const candidateId = CANDIDATE_IDS[index];
    const location =
      `Final Decision Memo adapter request.candidate_assessments[${index}]`;
    const critical = readHiddenCaseIds(
      record.critical_failed_case_ids,
      `${location}.critical_failed_case_ids`,
    );
    const deterministic = readHiddenCaseIds(
      record.deterministic_failed_case_ids,
      `${location}.deterministic_failed_case_ids`,
    );
    const humanConfirmed = readHiddenCaseIds(
      record.human_confirmed_failed_case_ids,
      `${location}.human_confirmed_failed_case_ids`,
    );
    const expectedCritical = [
      ...new Set([...deterministic, ...humanConfirmed]),
    ].sort();
    if (
      canonicalJsonStringify(critical)
        !== canonicalJsonStringify(expectedCritical)
    ) {
      throw new TypeError(
        `${location}.critical_failed_case_ids가 결정적·사람 확정 실패 합집합과 다릅니다.`,
      );
    }
    if (
      typeof record.gate_status !== "string"
      || !(GATE_STATUSES as readonly string[]).includes(record.gate_status)
    ) {
      throw new TypeError(`${location}.gate_status가 다릅니다.`);
    }
    const openReviewCount = readNonNegativeSafeInteger(
      record.open_review_count,
      `${location}.open_review_count`,
    );
    if (openReviewCount !== 0) {
      throw new TypeError(
        `${location}.open_review_count는 사람 검수 완료 Memo에서 0이어야 합니다.`,
      );
    }
    const expectedGateStatus = critical.length > 0
      ? "CONFIRMED_FAIL"
      : "PASS";
    if (record.gate_status !== expectedGateStatus) {
      throw new TypeError(
        `${location}.gate_status가 실패 case와 모순됩니다.`,
      );
    }
    if (
      !Array.isArray(record.failed_sufficiency_rules)
      || record.failed_sufficiency_rules.some((rule) => (
        typeof rule !== "string"
        || !(FAILED_SUFFICIENCY_RULES as readonly string[]).includes(rule)
      ))
      || new Set(record.failed_sufficiency_rules).size
        !== record.failed_sufficiency_rules.length
    ) {
      throw new TypeError(
        `${location}.failed_sufficiency_rules가 잠긴 rule 집합과 다릅니다.`,
      );
    }
    const failedSufficiencyRules =
      record.failed_sufficiency_rules as string[];
    const expectedRuleOrder = FAILED_SUFFICIENCY_RULES.filter((rule) => (
      failedSufficiencyRules.includes(rule)
    ));
    if (
      canonicalJsonStringify(failedSufficiencyRules)
        !== canonicalJsonStringify(expectedRuleOrder)
    ) {
      throw new TypeError(
        `${location}.failed_sufficiency_rules가 잠긴 순서와 다릅니다.`,
      );
    }
    const expectedSufficiencyPassed =
      failedSufficiencyRules.length === 0;
    if (
      record.sufficiency_passed !== expectedSufficiencyPassed
      || typeof record.eligible !== "boolean"
      || record.eligible
        !== (
          expectedGateStatus === "PASS"
          && expectedSufficiencyPassed
        )
    ) {
      throw new TypeError(
        `${location}의 sufficiency_passed/eligible이 gate·rule과 모순됩니다.`,
      );
    }
    if (record.eligible) eligibleCandidateIds.push(candidateId);

    const observed = readPlainRecord(
      record.observed,
      `${location}.observed`,
    );
    assertExactKeys(observed, OBSERVED_ASSESSMENT_KEYS, `${location}.observed`);
    readBoundedSafeInteger(
      observed.valid_runs,
      `${location}.observed.valid_runs`,
      0,
      24,
    );
    readBoundedSafeInteger(
      observed.policy_success_cases,
      `${location}.observed.policy_success_cases`,
      0,
      12,
    );
    readBoundedSafeInteger(
      observed.citation_success_cases,
      `${location}.observed.citation_success_cases`,
      0,
      11,
    );
    readBoundedSafeInteger(
      observed.escalation_success_cases,
      `${location}.observed.escalation_success_cases`,
      0,
      4,
    );
    readBoundedSafeInteger(
      observed.stable_cases,
      `${location}.observed.stable_cases`,
      0,
      12,
    );
    if (
      observed.average_runtime_cost_usd !== null
      && (
        typeof observed.average_runtime_cost_usd !== "number"
        || !Number.isFinite(observed.average_runtime_cost_usd)
        || observed.average_runtime_cost_usd < 0
      )
    ) {
      throw new TypeError(
        `${location}.observed.average_runtime_cost_usd는 null 또는 finite nonnegative number여야 합니다.`,
      );
    }
    const medianLatency = readNonNegativeSafeInteger(
      observed.median_latency_ms,
      `${location}.observed.median_latency_ms`,
    );
    const worstLatency = readNonNegativeSafeInteger(
      observed.worst_latency_ms,
      `${location}.observed.worst_latency_ms`,
    );
    if (medianLatency > worstLatency) {
      throw new TypeError(
        `${location}.observed latency에서 median이 worst를 초과합니다.`,
      );
    }
  }
  return { eligibleCandidateIds };
}

function parseHumanReview(
  value: unknown,
): {
  readonly reviewedItems: number;
} {
  const location = "Final Decision Memo adapter request.human_review";
  const record = readPlainRecord(value, location);
  assertExactKeys(record, HUMAN_REVIEW_KEYS, location);
  const reviewedItems = readBoundedSafeInteger(
    record.reviewed_items,
    `${location}.reviewed_items`,
    12,
    18,
  );
  if (record.remaining_items !== 0) {
    throw new TypeError(`${location}.remaining_items는 0이어야 합니다.`);
  }
  const totalReviewDuration = readNonNegativeSafeInteger(
    record.total_review_duration_ms,
    `${location}.total_review_duration_ms`,
  );
  const totalEditDuration = readNonNegativeSafeInteger(
    record.total_edit_duration_ms,
    `${location}.total_edit_duration_ms`,
  );
  const uniqueCases = readPlainRecord(
    record.reviewed_unique_cases_by_candidate,
    `${location}.reviewed_unique_cases_by_candidate`,
  );
  const byCandidate = readPlainRecord(
    record.by_candidate,
    `${location}.by_candidate`,
  );
  assertExactKeys(
    uniqueCases,
    CANDIDATE_VERSION_KEYS,
    `${location}.reviewed_unique_cases_by_candidate`,
  );
  assertExactKeys(
    byCandidate,
    CANDIDATE_VERSION_KEYS,
    `${location}.by_candidate`,
  );

  let summedItems = 0;
  let summedReviewDuration = 0;
  let summedEditDuration = 0;
  for (const candidateId of CANDIDATE_IDS) {
    const candidateLocation = `${location}.by_candidate.${candidateId}`;
    const candidate = readPlainRecord(
      byCandidate[candidateId],
      candidateLocation,
    );
    assertExactKeys(
      candidate,
      HUMAN_REVIEW_CANDIDATE_KEYS,
      candidateLocation,
    );
    const candidateReviewedItems = readBoundedSafeInteger(
      candidate.reviewed_items,
      `${candidateLocation}.reviewed_items`,
      4,
      10,
    );
    const candidateUniqueCases = readBoundedSafeInteger(
      candidate.reviewed_unique_cases,
      `${candidateLocation}.reviewed_unique_cases`,
      4,
      10,
    );
    if (
      candidateUniqueCases > candidateReviewedItems
      || uniqueCases[candidateId] !== candidateUniqueCases
    ) {
      throw new TypeError(
        `${candidateLocation}의 unique case 수가 candidate·summary 간 모순됩니다.`,
      );
    }
    const reviewDuration = readNonNegativeSafeInteger(
      candidate.review_duration_ms,
      `${candidateLocation}.review_duration_ms`,
    );
    const editDuration = readNonNegativeSafeInteger(
      candidate.edit_duration_ms,
      `${candidateLocation}.edit_duration_ms`,
    );
    readBoundedSafeInteger(
      candidate.corrected_reply_items,
      `${candidateLocation}.corrected_reply_items`,
      0,
      candidateReviewedItems,
    );
    summedItems += candidateReviewedItems;
    summedReviewDuration += reviewDuration;
    summedEditDuration += editDuration;
  }
  if (
    summedItems !== reviewedItems
    || summedReviewDuration !== totalReviewDuration
    || summedEditDuration !== totalEditDuration
  ) {
    throw new TypeError(
      `${location}의 후보별 item·review duration·edit duration 합계가 top-level과 다릅니다.`,
    );
  }
  return { reviewedItems };
}

function parseRequest(
  request: FinalDecisionMemoAdapterRequest,
): FinalDecisionMemoAdapterRequest {
  const snapshot = structuredClone(request) as unknown;
  const record = readPlainRecord(snapshot, "Final Decision Memo adapter request");
  assertExactKeys(
    record,
    REQUEST_KEYS,
    "Final Decision Memo adapter request",
  );
  if (
    record.schema_version !== "final-decision-memo-adapter-input-v1"
    || record.synthetic !== true
    || record.authority !== "ADVISORY_PROSE_ONLY"
  ) {
    throw new TypeError(
      "Final Decision Memo adapter request의 version/synthetic/authority 계약이 다릅니다.",
    );
  }
  if (
    record.selected_candidate_id !== null
    && !isCandidateId(record.selected_candidate_id)
  ) {
    throw new TypeError(
      "Final Decision Memo adapter request의 selected_candidate_id가 다릅니다.",
    );
  }
  if (record.recommendation !== null && !isCandidateId(record.recommendation)) {
    throw new TypeError(
      "Final Decision Memo adapter request의 recommendation이 다릅니다.",
    );
  }
  readBoundedText(
    record.human_selection_rationale,
    "Final Decision Memo adapter request.human_selection_rationale",
  );
  if (
    !Array.isArray(record.eligible_candidate_ids)
    || record.eligible_candidate_ids.some((item) => !isCandidateId(item))
    || new Set(record.eligible_candidate_ids).size
      !== record.eligible_candidate_ids.length
  ) {
    throw new TypeError(
      "Final Decision Memo adapter request의 eligible_candidate_ids가 다릅니다.",
    );
  }
  const parsedAssessments = parseCandidateAssessments(
    record.candidate_assessments,
  );
  if (
    canonicalJsonStringify(record.eligible_candidate_ids)
      !== canonicalJsonStringify(parsedAssessments.eligibleCandidateIds)
    || (
      record.selected_candidate_id !== null
      && !parsedAssessments.eligibleCandidateIds.includes(
        record.selected_candidate_id,
      )
    )
    || (
      record.recommendation !== null
      && !parsedAssessments.eligibleCandidateIds.includes(
        record.recommendation,
      )
    )
  ) {
    throw new TypeError(
      "Final Decision Memo adapter request의 eligible·selected·recommendation 후보가 후보 평가와 모순됩니다.",
    );
  }
  const parsedHumanReview = parseHumanReview(record.human_review);
  readSha256(
    record.recorded_benchmark_pack_hash,
    "Final Decision Memo adapter request.recorded_benchmark_pack_hash",
  );
  readSha256(
    record.human_confirmation_receipt_hash,
    "Final Decision Memo adapter request.human_confirmation_receipt_hash",
  );
  readSha256(
    record.aggregation_hash,
    "Final Decision Memo adapter request.aggregation_hash",
  );
  const benchmarkMetadata = readPlainRecord(
    record.benchmark_metadata,
    "Final Decision Memo adapter request.benchmark_metadata",
  );
  assertExactKeys(
    benchmarkMetadata,
    BENCHMARK_METADATA_KEYS,
    "Final Decision Memo adapter request.benchmark_metadata",
  );
  const challengeVersion = readBoundedText(
    benchmarkMetadata.challenge_version,
    "Final Decision Memo adapter request.benchmark_metadata.challenge_version",
    128,
  );
  if (!/^v[1-9]\d*$/.test(challengeVersion)) {
    throw new TypeError(
      "Final Decision Memo adapter request.benchmark_metadata.challenge_version은 Locked Challenge의 vN 형식이어야 합니다.",
    );
  }
  if (
    benchmarkMetadata.recorded_benchmark_pack_schema_version
      !== "recorded-benchmark-pack-v1"
    || benchmarkMetadata.benchmark_execution_pack_schema_version
      !== "benchmark-execution-pack-v1"
  ) {
    throw new TypeError(
      "Final Decision Memo adapter request.benchmark_metadata의 pack schema version이 다릅니다.",
    );
  }
  const datasetHash = readSha256(
    benchmarkMetadata.dataset_hash,
    "Final Decision Memo adapter request.benchmark_metadata.dataset_hash",
  );
  if (datasetHash !== BENCHMARK_DATASET_HASH) {
    throw new TypeError(
      "Final Decision Memo adapter request.benchmark_metadata.dataset_hash가 잠긴 hidden Benchmark 데이터셋과 다릅니다.",
    );
  }
  const coverage = readPlainRecord(
    benchmarkMetadata.coverage,
    "Final Decision Memo adapter request.benchmark_metadata.coverage",
  );
  assertExactKeys(
    coverage,
    BENCHMARK_COVERAGE_KEYS,
    "Final Decision Memo adapter request.benchmark_metadata.coverage",
  );
  if (
    coverage.cases !== 12
    || coverage.candidates !== 3
    || coverage.runs_per_case !== 2
    || coverage.candidate_runs !== 72
    || coverage.judge_cases !== 12
  ) {
    throw new TypeError(
      "Final Decision Memo adapter request.benchmark_metadata.coverage는 잠긴 12×3×2 Benchmark와 일치해야 합니다.",
    );
  }
  const candidateVersions = readPlainRecord(
    benchmarkMetadata.candidate_versions,
    "Final Decision Memo adapter request.benchmark_metadata.candidate_versions",
  );
  assertExactKeys(
    candidateVersions,
    CANDIDATE_VERSION_KEYS,
    "Final Decision Memo adapter request.benchmark_metadata.candidate_versions",
  );
  for (const candidateId of CANDIDATE_IDS) {
    if (
      candidateVersions[candidateId]
        !== FINAL_DECISION_MEMO_CANDIDATE_VERSIONS[candidateId]
    ) {
      throw new TypeError(
        `Final Decision Memo adapter request.benchmark_metadata.candidate_versions.${candidateId}가 잠긴 Benchmark 후보 버전과 다릅니다.`,
      );
    }
  }
  const humanReviewSample = readPlainRecord(
    benchmarkMetadata.human_review_sample,
    "Final Decision Memo adapter request.benchmark_metadata.human_review_sample",
  );
  assertExactKeys(
    humanReviewSample,
    HUMAN_REVIEW_SAMPLE_KEYS,
    "Final Decision Memo adapter request.benchmark_metadata.human_review_sample",
  );
  const completedCandidateCaseReviews = readNonNegativeSafeInteger(
    humanReviewSample.completed_candidate_case_reviews,
    "Final Decision Memo adapter request.benchmark_metadata.human_review_sample.completed_candidate_case_reviews",
  );
  const judgeFlaggedCandidateCaseReviews = readNonNegativeSafeInteger(
    humanReviewSample.judge_flagged_candidate_case_reviews,
    "Final Decision Memo adapter request.benchmark_metadata.human_review_sample.judge_flagged_candidate_case_reviews",
  );
  if (
    humanReviewSample.required_high_risk_cases !== 4
    || humanReviewSample.required_candidate_case_reviews !== 12
    || completedCandidateCaseReviews < 12
    || completedCandidateCaseReviews > 18
    || judgeFlaggedCandidateCaseReviews > 6
    || completedCandidateCaseReviews
      !== 12 + judgeFlaggedCandidateCaseReviews
    || completedCandidateCaseReviews !== parsedHumanReview.reviewedItems
    || humanReviewSample.statistical_generalization !== "NOT_SUPPORTED"
  ) {
    throw new TypeError(
      "Final Decision Memo adapter request.benchmark_metadata.human_review_sample이 잠긴 사람 검수 표본 계약과 다릅니다.",
    );
  }
  if (
    record.required_external_action_statement
      !== "No purchase, contract, deployment, or rollback was executed."
  ) {
    throw new TypeError(
      "Final Decision Memo adapter request의 외부 행동 미실행 문구가 다릅니다.",
    );
  }
  return deepFreeze(snapshot as FinalDecisionMemoAdapterRequest);
}

export function buildOpenAIFinalDecisionMemoRequest(
  request: FinalDecisionMemoAdapterRequest,
): ResponseCreateParamsNonStreaming {
  assertLockedDecisionMemoContract();
  const snapshot = parseRequest(request);
  const requiredOutput = buildFinalDecisionMemoRequiredOutput(snapshot);
  return {
    model: OPENAI_FINAL_DECISION_MEMO_REQUEST_CONTRACT.modelRequestedId,
    reasoning: {
      effort:
        OPENAI_FINAL_DECISION_MEMO_REQUEST_CONTRACT.reasoningEffort,
    },
    max_output_tokens:
      OPENAI_FINAL_DECISION_MEMO_REQUEST_CONTRACT.maxOutputTokens,
    service_tier:
      OPENAI_FINAL_DECISION_MEMO_REQUEST_CONTRACT.serviceTierRequested,
    store: OPENAI_FINAL_DECISION_MEMO_REQUEST_CONTRACT.store,
    instructions:
      OPENAI_FINAL_DECISION_MEMO_REQUEST_CONTRACT.instructions,
    input: canonicalJsonStringify({
      ...snapshot,
      required_output: requiredOutput,
    }),
    text: {
      verbosity:
        OPENAI_FINAL_DECISION_MEMO_REQUEST_CONTRACT.textVerbosity,
      format: OPENAI_FINAL_DECISION_MEMO_RESPONSE_FORMAT,
    },
  };
}

function parseOutput(
  value: unknown,
  request: FinalDecisionMemoAdapterRequest,
): FinalDecisionMemoAdapterOutput {
  const record = readPlainRecord(value, "Final Decision Memo output");
  assertExactKeys(record, OUTPUT_KEYS, "Final Decision Memo output");
  if (record.selected_candidate_id !== request.selected_candidate_id) {
    throw new TypeError(
      "Final Decision Memo output이 explicit human selection을 override하려 했습니다.",
    );
  }
  const rejectedRaw = record.rejected_alternatives;
  if (!Array.isArray(rejectedRaw) || rejectedRaw.length > 3) {
    throw new TypeError(
      "Final Decision Memo output.rejected_alternatives 계약이 다릅니다.",
    );
  }
  const rejected = rejectedRaw.map((item, index) => {
    const alternative = readPlainRecord(
      item,
      `Final Decision Memo output.rejected_alternatives[${index}]`,
    );
    assertExactKeys(
      alternative,
      REJECTED_ALTERNATIVE_KEYS,
      `Final Decision Memo output.rejected_alternatives[${index}]`,
    );
    if (
      !isCandidateId(alternative.candidate_id)
      || alternative.candidate_id === request.selected_candidate_id
    ) {
      throw new TypeError(
        `Final Decision Memo output.rejected_alternatives[${index}].candidate_id가 선택과 모순됩니다.`,
      );
    }
    return {
      candidate_id: alternative.candidate_id,
      reason: readBoundedText(
        alternative.reason,
        `Final Decision Memo output.rejected_alternatives[${index}].reason`,
      ),
    };
  });
  const expectedRejected = CANDIDATE_IDS.filter(
    (candidateId) => candidateId !== request.selected_candidate_id,
  );
  if (
    rejected.length !== expectedRejected.length
    || new Set(rejected.map((item) => item.candidate_id)).size
      !== rejected.length
    || expectedRejected.some((candidateId) => (
      !rejected.some((item) => item.candidate_id === candidateId)
    ))
  ) {
    throw new TypeError(
      "Final Decision Memo output은 선택되지 않은 모든 후보를 정확히 한 번 설명해야 합니다.",
    );
  }
  if (
    !Array.isArray(record.known_limitations)
    || record.known_limitations.length < 1
    || record.known_limitations.length > 16
  ) {
    throw new TypeError(
      "Final Decision Memo output.known_limitations 계약이 다릅니다.",
    );
  }
  const limitations = record.known_limitations.map((item, index) => (
    readBoundedText(
      item,
      `Final Decision Memo output.known_limitations[${index}]`,
    )
  ));
  if (
    record.external_action_statement
      !== request.required_external_action_statement
  ) {
    throw new TypeError(
      "Final Decision Memo output의 외부 행동 미실행 문구가 다릅니다.",
    );
  }
  const parsed: FinalDecisionMemoAdapterOutput = {
    selected_candidate_id: request.selected_candidate_id,
    decision_summary: readBoundedText(
      record.decision_summary,
      "Final Decision Memo output.decision_summary",
    ),
    rejected_alternatives: rejected,
    known_limitations: limitations,
    next_poc_scope: readBoundedText(
      record.next_poc_scope,
      "Final Decision Memo output.next_poc_scope",
    ),
    procurement_handoff: readBoundedText(
      record.procurement_handoff,
      "Final Decision Memo output.procurement_handoff",
    ),
    external_action_statement:
      request.required_external_action_statement,
  };
  const advisoryProse = [
    parsed.decision_summary,
    ...parsed.rejected_alternatives.map((item) => item.reason),
    ...parsed.known_limitations,
    parsed.next_poc_scope,
    parsed.procurement_handoff,
  ];
  const unsupportedExecutedAction = advisoryProse.some((text) => (
    /\b(?:purchase|procurement|contract|agreement|deployment|system|service|rollout|launch|rollback)\b.{0,48}\b(?:approved|completed|executed|performed|finalized|signed|deployed|launched|rolled\s+out|rolled\s+back|live(?:\s+in\s+production)?|in\s+production)\b/iu
      .test(text)
    || /\b(?:approved|completed|executed|performed|finalized|signed|deployed|launched|rolled\s+out|rolled\s+back)\b.{0,48}\b(?:purchase|procurement|contract|agreement|deployment|system|service|rollout|launch|rollback)\b/iu
      .test(text)
    || /(?:구매|조달|계약|협약|배포|출시|롤아웃|롤백).{0,24}(?:승인|완료|실행|체결|서명|배포|출시|운영\s*중)/u
      .test(text)
  ));
  if (unsupportedExecutedAction) {
    throw new TypeError(
      "Final Decision Memo advisory prose는 외부 구매·계약·배포·롤백 실행을 주장할 수 없습니다.",
    );
  }
  const requestText = canonicalJsonStringify(request).toLocaleLowerCase("en");
  const unsupportedHighRiskFact = advisoryProse.some((text) => {
    const normalized = text.toLocaleLowerCase("en");
    const highRiskTerms = [
      "pii",
      "personally identifiable information",
      "personal data leak",
      "data breach",
      "security incident",
      "regulatory violation",
      "legal violation",
      "hidden cases",
    ];
    return highRiskTerms.some((term) => (
      normalized.includes(term) && !requestText.includes(term)
    ));
  });
  if (unsupportedHighRiskFact) {
    throw new TypeError(
      "Final Decision Memo advisory prose에 입력 증거가 뒷받침하지 않는 보안·개인정보·법무 사실이 있습니다.",
    );
  }
  const requiredOutput = buildFinalDecisionMemoRequiredOutput(request);
  if (
    canonicalJsonStringify(parsed)
      !== canonicalJsonStringify(requiredOutput)
  ) {
    throw new TypeError(
      "Final Decision Memo output은 잠긴 source에서 결정적으로 만든 required_output을 exact copy해야 합니다.",
    );
  }
  return deepFreeze(parsed);
}

function readNonNegativeSafeInteger(
  value: unknown,
  location: string,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new TypeError(`${location}은(는) 0 이상의 safe integer여야 합니다.`);
  }
  return value;
}

function parseUsage(value: unknown): TokenUsage {
  const usage = readPlainRecord(value, "Final Decision Memo response usage");
  const inputTokens = readNonNegativeSafeInteger(
    usage.input_tokens,
    "Final Decision Memo response usage.input_tokens",
  );
  const outputTokens = readNonNegativeSafeInteger(
    usage.output_tokens,
    "Final Decision Memo response usage.output_tokens",
  );
  const inputDetails = usage.input_tokens_details === undefined
    || usage.input_tokens_details === null
    ? {}
    : readPlainRecord(
        usage.input_tokens_details,
        "Final Decision Memo response usage.input_tokens_details",
      );
  const outputDetails = usage.output_tokens_details === undefined
    || usage.output_tokens_details === null
    ? {}
    : readPlainRecord(
        usage.output_tokens_details,
        "Final Decision Memo response usage.output_tokens_details",
      );
  const cachedInputTokens = inputDetails.cached_tokens === undefined
    ? 0
    : readNonNegativeSafeInteger(
        inputDetails.cached_tokens,
        "Final Decision Memo response usage.input_tokens_details.cached_tokens",
      );
  const cacheWriteTokens = inputDetails.cache_write_tokens === undefined
    ? 0
    : readNonNegativeSafeInteger(
        inputDetails.cache_write_tokens,
        "Final Decision Memo response usage.input_tokens_details.cache_write_tokens",
      );
  const reasoningTokens = outputDetails.reasoning_tokens === undefined
    ? 0
    : readNonNegativeSafeInteger(
        outputDetails.reasoning_tokens,
        "Final Decision Memo response usage.output_tokens_details.reasoning_tokens",
      );
  const totalTokens = usage.total_tokens === undefined
    ? inputTokens + outputTokens
    : readNonNegativeSafeInteger(
        usage.total_tokens,
        "Final Decision Memo response usage.total_tokens",
      );
  if (cachedInputTokens + cacheWriteTokens > inputTokens) {
    throw new TypeError(
      "Final Decision Memo response usage의 cache token 합이 input token을 초과합니다.",
    );
  }
  if (totalTokens !== inputTokens + outputTokens) {
    throw new TypeError(
      "Final Decision Memo response usage.total_tokens가 input+output 합과 다릅니다.",
    );
  }
  if (reasoningTokens > outputTokens) {
    throw new TypeError(
      "Final Decision Memo response usage.reasoning_tokens가 output_tokens를 초과합니다.",
    );
  }
  if (
    inputTokens
      > OPENAI_FINAL_DECISION_MEMO_SHORT_CONTEXT_MAX_INPUT_TOKENS
  ) {
    throw new TypeError(
      `Final Decision Memo input ${inputTokens} tokens는 ${OPENAI_FINAL_DECISION_MEMO_SHORT_CONTEXT_MAX_INPUT_TOKENS} long-context 가격 경계를 초과해 잠긴 short-context 가격을 적용할 수 없습니다.`,
    );
  }
  return deepFreeze({
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  });
}

function sumUsage(
  attempts: readonly FinalDecisionMemoAttemptEvidence[],
): TokenUsage {
  return deepFreeze(attempts.reduce<TokenUsage>((total, attempt) => {
    const usage = attempt.usage;
    if (usage === null) return total;
    return {
      inputTokens: total.inputTokens + usage.inputTokens,
      cachedInputTokens:
        total.cachedInputTokens + usage.cachedInputTokens,
      cacheWriteTokens:
        total.cacheWriteTokens + usage.cacheWriteTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      reasoningTokens:
        (total.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
      totalTokens:
        (total.totalTokens ?? 0)
        + (usage.totalTokens ?? usage.inputTokens + usage.outputTokens),
    };
  }, {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }));
}

function latencyMs(startedAt: number, finishedAt: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) {
    throw new TypeError("Final Decision Memo 계측 시계는 유한한 숫자를 반환해야 합니다.");
  }
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(0, Math.round(finishedAt - startedAt)),
  );
}

function safeEvidenceText(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value : fallback;
  const redacted = redactSensitiveText(raw)
    .replace(/\p{Cc}+/gu, " ")
    .trim()
    .slice(0, 4_000);
  return redacted.length > 0 ? redacted : fallback;
}

function readOptionalString(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function cloneEvidenceValue<T>(value: T): T {
  return structuredClone(value);
}

export interface FinalDecisionMemoProviderEvidence {
  readonly response_id: unknown;
  readonly response_status: unknown;
  readonly model_reported_id: unknown;
  readonly service_tier_reported: unknown;
  readonly refusal_detected: boolean;
  readonly refusal: string | null;
  readonly incomplete_reason: unknown;
  readonly response_error: unknown;
  readonly output_text: unknown;
  readonly usage_raw: unknown;
}

function extractProviderEvidence(
  response: JsonRecord,
): FinalDecisionMemoProviderEvidence {
  const refusalMessages: string[] = [];
  let refusalDetected = false;
  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      if (
        typeof item !== "object"
        || item === null
        || Array.isArray(item)
        || (item as JsonRecord).type !== "message"
        || !Array.isArray((item as JsonRecord).content)
      ) {
        continue;
      }
      for (const content of (item as JsonRecord).content as unknown[]) {
        if (
          typeof content !== "object"
          || content === null
          || Array.isArray(content)
          || (content as JsonRecord).type !== "refusal"
        ) {
          continue;
        }
        refusalDetected = true;
        const refusal = (content as JsonRecord).refusal;
        if (typeof refusal === "string") refusalMessages.push(refusal);
      }
    }
  }
  return deepFreeze({
    response_id: cloneEvidenceValue(response.id ?? null),
    response_status: cloneEvidenceValue(response.status ?? null),
    model_reported_id: cloneEvidenceValue(response.model ?? null),
    service_tier_reported:
      cloneEvidenceValue(response.service_tier ?? null),
    refusal_detected: refusalDetected,
    refusal: refusalMessages.length > 0
      ? refusalMessages.join("\n")
      : null,
    incomplete_reason: cloneEvidenceValue(
      response.incomplete_details === null
        || response.incomplete_details === undefined
        ? null
        : typeof response.incomplete_details === "object"
          && !Array.isArray(response.incomplete_details)
          ? (
              (response.incomplete_details as JsonRecord).reason
              ?? "Responses API incomplete_details was present."
            )
          : safeEvidenceText(
              response.incomplete_details,
              "Responses API incomplete_details was invalid.",
            ),
    ),
    response_error: cloneEvidenceValue(
      response.error === null || response.error === undefined
        ? null
        : typeof response.error === "object"
          && !Array.isArray(response.error)
          ? (
              (response.error as JsonRecord).message
              ?? (response.error as JsonRecord).code
              ?? "Responses API response error."
            )
          : safeEvidenceText(
              response.error,
              "Responses API response error was invalid.",
            ),
    ),
    output_text: cloneEvidenceValue(response.output_text ?? null),
    usage_raw: cloneEvidenceValue(response.usage ?? null),
  });
}

export type FinalDecisionMemoOpenAIErrorKind =
  | "TERMINAL_RESPONSE"
  | "EVIDENCE_INVALID"
  | "RETRIES_EXHAUSTED"
  | "REQUEST_ERROR";

export class FinalDecisionMemoOpenAIError extends Error {
  readonly code = "FINAL_DECISION_MEMO_OPENAI_ERROR" as const;
  readonly evaluation_status = "EVALUATION_INCOMPLETE" as const;
  readonly kind: FinalDecisionMemoOpenAIErrorKind;
  readonly attempts: readonly FinalDecisionMemoAttemptEvidence[];
  readonly provider_evidence: FinalDecisionMemoProviderEvidence | null;

  constructor(
    message: string,
    {
      kind,
      attempts,
      providerEvidence,
      cause,
    }: {
      readonly kind: FinalDecisionMemoOpenAIErrorKind;
      readonly attempts: readonly FinalDecisionMemoAttemptEvidence[];
      readonly providerEvidence: FinalDecisionMemoProviderEvidence | null;
      readonly cause?: unknown;
    },
  ) {
    super(
      safeEvidenceText(message, "Final Decision Memo OpenAI 실행이 실패했습니다."),
      cause === undefined ? undefined : { cause },
    );
    this.name = "FinalDecisionMemoOpenAIError";
    this.kind = kind;
    this.attempts = deepFreeze(structuredClone(attempts));
    this.provider_evidence = providerEvidence === null
      ? null
      : deepFreeze(structuredClone(providerEvidence));
  }
}

function attemptCost(usage: TokenUsage | null) {
  return calculateUsageCost(
    usage,
    FINAL_DECISION_MEMO_PRICING_SNAPSHOT,
  );
}

function responseAttempt({
  attemptNumber,
  status,
  retryEligible,
  evidence,
  latency,
  usage,
  error,
}: {
  readonly attemptNumber: 1 | 2;
  readonly status: FinalDecisionMemoAttemptEvidence["status"];
  readonly retryEligible: boolean;
  readonly evidence: FinalDecisionMemoProviderEvidence;
  readonly latency: number;
  readonly usage: TokenUsage | null;
  readonly error: string | null;
}): FinalDecisionMemoAttemptEvidence {
  const responseId = typeof evidence.response_id === "string"
    && evidence.response_id.length > 0
    ? evidence.response_id
    : null;
  return deepFreeze({
    attempt_number: attemptNumber,
    request_disposition: "RESPONSE_RECEIVED",
    status,
    retry_eligible: retryEligible,
    response_id: responseId,
    refusal: status === "REFUSED"
      ? safeEvidenceText(
          evidence.refusal,
          "Responses API refusal content was empty.",
        )
      : null,
    incomplete_reason: status === "INCOMPLETE"
      ? safeEvidenceText(
          evidence.incomplete_reason,
          "Responses API returned incomplete without a reason.",
        )
      : null,
    error: status === "COMPLETE"
      || status === "REFUSED"
      || status === "INCOMPLETE"
      ? null
      : safeEvidenceText(
          error,
          `Responses API terminal status: ${String(evidence.response_status)}`,
        ),
    latency_ms: latency,
    usage,
    usage_cost: attemptCost(usage),
  });
}

function readHttpStatus(error: unknown): number | null {
  if (
    typeof error === "object"
    && error !== null
    && "status" in error
    && typeof error.status === "number"
    && Number.isInteger(error.status)
  ) {
    return error.status;
  }
  return null;
}

function isRetryableHttpStatus(status: number | null): boolean {
  return status === 408
    || status === 409
    || status === 429
    || (status !== null && status >= 500 && status <= 599);
}

function requestErrorAttempt({
  attemptNumber,
  error,
  latency,
}: {
  readonly attemptNumber: 1 | 2;
  readonly error: unknown;
  readonly latency: number;
}): {
  readonly attempt: FinalDecisionMemoAttemptEvidence;
  readonly retryEligible: boolean;
} {
  const statusCode = readHttpStatus(error);
  const timeout = statusCode === null && isOpenAITimeoutError(error);
  const requestDisposition = statusCode === null
    ? "SENT_OUTCOME_UNKNOWN" as const
    : "RESPONSE_ERROR_RECEIVED" as const;
  const status = timeout
    ? "TIMEOUT" as const
    : statusCode === null
      ? "TRANSPORT_ERROR" as const
      : "REQUEST_ERROR" as const;
  // 전송 결과를 모르는 timeout/transport 실패는 첫 시도의 과금 여부도
  // 알 수 없으므로 성공 Memo로 승격 가능한 재시도 대상이 아닙니다.
  const retryable = statusCode !== null
    && isRetryableHttpStatus(statusCode);
  const retryEligible =
    attemptNumber < OPENAI_FINAL_DECISION_MEMO_MAX_ATTEMPTS
    && retryable;
  return {
    retryEligible,
    attempt: deepFreeze({
      attempt_number: attemptNumber,
      request_disposition: requestDisposition,
      status,
      retry_eligible: retryEligible,
      response_id: null,
      refusal: null,
      incomplete_reason: null,
      error: safeEvidenceText(
        error instanceof Error ? error.message : error,
        "OpenAI Responses 요청 오류",
      ),
      latency_ms: latency,
      usage: null,
      usage_cost: null,
    }),
  };
}

function validateResponseAuthorityEvidence(
  evidence: FinalDecisionMemoProviderEvidence,
): void {
  if (
    typeof evidence.response_id !== "string"
    || evidence.response_id.trim().length === 0
    || evidence.response_id.length > 4_000
    || /\p{Cc}/u.test(evidence.response_id)
  ) {
    throw new TypeError(
      "Final Decision Memo 응답에는 비어 있지 않은 response ID가 필요합니다.",
    );
  }
  if (
    evidence.model_reported_id
      !== OPENAI_FINAL_DECISION_MEMO_MODEL_REQUESTED_ID
  ) {
    throw new TypeError(
      `Final Decision Memo reported model이 잠긴 model과 다릅니다: ${String(evidence.model_reported_id)}`,
    );
  }
  if (
    evidence.service_tier_reported
      !== OPENAI_FINAL_DECISION_MEMO_SERVICE_TIER_REQUESTED
  ) {
    throw new TypeError(
      `Final Decision Memo reported service tier가 잠긴 Standard 가격 가정과 다릅니다: ${String(evidence.service_tier_reported)}`,
    );
  }
}

function responseStatus(
  evidence: FinalDecisionMemoProviderEvidence,
): string {
  if (typeof evidence.response_status !== "string") {
    throw new TypeError(
      "Final Decision Memo response status 증거가 문자열이 아닙니다.",
    );
  }
  return evidence.response_status;
}

function terminalResponseStatus({
  evidence,
  status,
}: {
  readonly evidence: FinalDecisionMemoProviderEvidence;
  readonly status: string;
}): {
  readonly status:
    | "REFUSED"
    | "INCOMPLETE"
    | "FAILED"
    | null;
  readonly error: string | null;
} {
  if (evidence.refusal_detected) {
    return { status: "REFUSED", error: null };
  }
  if (status === "incomplete") {
    return { status: "INCOMPLETE", error: null };
  }
  if (
    status === "completed"
    && (
      evidence.response_error !== null
      || evidence.incomplete_reason !== null
    )
  ) {
    return {
      status: "FAILED",
      error: safeEvidenceText(
        evidence.response_error ?? evidence.incomplete_reason,
        "Responses API completed 응답에 failure evidence가 함께 존재합니다.",
      ),
    };
  }
  if (status !== "completed") {
    return {
      status: "FAILED",
      error: safeEvidenceText(
        evidence.response_error,
        `Responses API status: ${status}`,
      ),
    };
  }
  return { status: null, error: null };
}

function parseResponseOutput(
  evidence: FinalDecisionMemoProviderEvidence,
  request: FinalDecisionMemoAdapterRequest,
): FinalDecisionMemoAdapterOutput {
  if (
    typeof evidence.output_text !== "string"
    || evidence.output_text.trim().length === 0
  ) {
    throw new TypeError(
      "Final Decision Memo Responses API output_text가 비어 있습니다.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidence.output_text) as unknown;
  } catch (error) {
    throw new TypeError(
      "Final Decision Memo Responses API output_text가 유효한 JSON이 아닙니다.",
      { cause: error },
    );
  }
  return parseOutput(parsed, request);
}

export interface OpenAIFinalDecisionMemoResponsesClientLike {
  readonly responses: {
    create(
      params: ResponseCreateParamsNonStreaming,
      options?: {
        readonly timeout?: number;
        readonly maxRetries?: number;
        readonly signal?: AbortSignal;
      },
    ): PromiseLike<unknown>;
  };
}

export interface OpenAIFinalDecisionMemoAdapterOptions {
  readonly attemptTimeoutMs?: number;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

export interface OpenAIFinalDecisionMemoProductionAdapterConfig {
  readonly apiKey: string;
  readonly signal?: AbortSignal;
}

/**
 * 읽기 전용 권위 상태 복구는 OpenAI credential 없이도 가능해야 합니다.
 * credential은 실제 Final Decision Memo mutation이 시작될 때만 해석합니다.
 */
export interface LazyOpenAIFinalDecisionMemoProductionAdapterConfig {
  readonly resolveApiKey: () => string;
  readonly signal?: AbortSignal;
}

declare const OFFICIAL_OPENAI_FINAL_DECISION_MEMO_ADAPTER: unique symbol;

export type OfficialOpenAIFinalDecisionMemoAdapter =
  FinalDecisionMemoAdapter & {
    readonly [OFFICIAL_OPENAI_FINAL_DECISION_MEMO_ADAPTER]:
      "OFFICIAL_OPENAI_FINAL_DECISION_MEMO_ADAPTER";
  };

const OFFICIAL_OPENAI_FINAL_DECISION_MEMO_ADAPTERS =
  new WeakSet<object>();

export function assertOfficialOpenAIFinalDecisionMemoAdapter(
  adapter: FinalDecisionMemoAdapter,
): asserts adapter is OfficialOpenAIFinalDecisionMemoAdapter {
  if (!OFFICIAL_OPENAI_FINAL_DECISION_MEMO_ADAPTERS.has(adapter)) {
    throw new TypeError(
      "Production Final Decision Memo에는 공식 OpenAI SDK client로 만든 official adapter가 필요합니다.",
    );
  }
}

function validateAttemptTimeoutMs(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > 2_147_483_647
  ) {
    throw new TypeError(
      "Final Decision Memo attemptTimeoutMs는 1..2147483647 범위의 safe integer여야 합니다.",
    );
  }
  return value;
}

class FinalDecisionMemoAttemptTimeoutError extends Error {
  readonly code = "ETIME" as const;

  constructor(timeoutMs: number) {
    super(`OpenAI Responses 요청이 ${timeoutMs}ms 제한시간을 초과했습니다.`);
    this.name = "FinalDecisionMemoAttemptTimeoutError";
  }
}

class FinalDecisionMemoCallerAbortError extends Error {
  constructor(reason: unknown) {
    super(safeEvidenceText(
      reason instanceof Error ? reason.message : reason,
      "Final Decision Memo 요청이 호출자에 의해 중단됐습니다.",
    ));
    this.name = "FinalDecisionMemoCallerAbortError";
  }
}

async function createResponseWithDeadline({
  client,
  request,
  attemptTimeoutMs,
  callerSignal,
}: {
  readonly client: OpenAIFinalDecisionMemoResponsesClientLike;
  readonly request: ResponseCreateParamsNonStreaming;
  readonly attemptTimeoutMs: number;
  readonly callerSignal?: AbortSignal;
}): Promise<unknown> {
  const controller = new AbortController();
  let rejectDeadline: ((reason: unknown) => void) | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const abortFromCaller = () => {
    const error = new FinalDecisionMemoCallerAbortError(callerSignal?.reason);
    rejectDeadline?.(error);
    controller.abort(error);
  };
  if (callerSignal?.aborted) {
    throw new FinalDecisionMemoCallerAbortError(callerSignal.reason);
  }
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    const error = new FinalDecisionMemoAttemptTimeoutError(attemptTimeoutMs);
    rejectDeadline?.(error);
    controller.abort(error);
  }, attemptTimeoutMs);
  try {
    const response = await Promise.race([
      Promise.resolve(client.responses.create(request, {
        timeout: attemptTimeoutMs,
        maxRetries:
          OPENAI_FINAL_DECISION_MEMO_REQUEST_CONTRACT.sdkMaxRetries,
        signal: controller.signal,
      })),
      deadline,
    ]);
    if (callerSignal?.aborted) {
      throw new FinalDecisionMemoCallerAbortError(callerSignal.reason);
    }
    return response;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
    rejectDeadline = null;
  }
}

function throwTerminal(
  message: string,
  options: {
    readonly kind: FinalDecisionMemoOpenAIErrorKind;
    readonly attempts: readonly FinalDecisionMemoAttemptEvidence[];
    readonly providerEvidence: FinalDecisionMemoProviderEvidence | null;
    readonly cause?: unknown;
  },
): never {
  throw new FinalDecisionMemoOpenAIError(message, options);
}

/**
 * Responses API 호출, 최대 1회 재시도, usage/비용/지연 계측을 이 실행기가 소유합니다.
 * SDK 자체 재시도는 항상 0이며, 성공 증거만 Final Decision Memo 승격 경계로 반환합니다.
 */
function createOpenAIFinalDecisionMemoAdapterCore(
  client: OpenAIFinalDecisionMemoResponsesClientLike,
  options: OpenAIFinalDecisionMemoAdapterOptions = {},
  requireAuthoritativeRequest = false,
): FinalDecisionMemoAdapter {
  const attemptTimeoutMs = validateAttemptTimeoutMs(
    options.attemptTimeoutMs
      ?? OPENAI_FINAL_DECISION_MEMO_DEFAULT_ATTEMPT_TIMEOUT_MS,
  );
  const now = options.now ?? Date.now;

  return {
    async invoke(rawRequest): Promise<FinalDecisionMemoAdapterResult> {
      if (requireAuthoritativeRequest) {
        assertAuthoritativeFinalDecisionMemoAdapterRequest(rawRequest);
      }
      const request = parseRequest(rawRequest);
      // 요청 직렬화 실패는 네트워크 전송 시도가 아니므로 transport 오류로
      // 분류하지 않습니다.
      const openAIRequest = buildOpenAIFinalDecisionMemoRequest(request);
      const attempts: FinalDecisionMemoAttemptEvidence[] = [];
      let latestProviderEvidence: FinalDecisionMemoProviderEvidence | null =
        null;

      for (
        let index = 0;
        index < OPENAI_FINAL_DECISION_MEMO_MAX_ATTEMPTS;
        index += 1
      ) {
        const attemptNumber = (index + 1) as 1 | 2;
        if (options.signal?.aborted) {
          const attempt = deepFreeze({
            attempt_number: attemptNumber,
            request_disposition: "NOT_SENT" as const,
            status: "REQUEST_ERROR" as const,
            retry_eligible: false,
            response_id: null,
            refusal: null,
            incomplete_reason: null,
            error: safeEvidenceText(
              options.signal.reason,
              "Final Decision Memo 요청이 호출 전에 중단됐습니다.",
            ),
            latency_ms: 0,
            usage: null,
            usage_cost: null,
          });
          attempts.push(attempt);
          throwTerminal(attempt.error!, {
            kind: "REQUEST_ERROR",
            attempts,
            providerEvidence: null,
          });
        }

        const startedAt = now();
        let rawResponse: unknown;
        try {
          rawResponse = await createResponseWithDeadline({
            client,
            request: openAIRequest,
            attemptTimeoutMs,
            ...(options.signal === undefined
              ? {}
              : { callerSignal: options.signal }),
          });
        } catch (error) {
          const finishedAt = now();
          const mapped = requestErrorAttempt({
            attemptNumber,
            error,
            latency: latencyMs(startedAt, finishedAt),
          });
          attempts.push(mapped.attempt);
          if (mapped.retryEligible) continue;
          throwTerminal(mapped.attempt.error!, {
            kind: "REQUEST_ERROR",
            attempts,
            providerEvidence: null,
            cause: error,
          });
        }

        const finishedAt = now();
        const latency = latencyMs(startedAt, finishedAt);
        let response: JsonRecord;
        try {
          response = readPlainRecord(
            rawResponse,
            "Final Decision Memo OpenAI response",
          );
          latestProviderEvidence = extractProviderEvidence(response);
        } catch (error) {
          const attempt = deepFreeze({
            attempt_number: attemptNumber,
            request_disposition: "RESPONSE_RECEIVED" as const,
            status: "FAILED" as const,
            retry_eligible: false,
            response_id: null,
            refusal: null,
            incomplete_reason: null,
            error: safeEvidenceText(
              error instanceof Error ? error.message : error,
              "Final Decision Memo response evidence가 유효하지 않습니다.",
            ),
            latency_ms: latency,
            usage: null,
            usage_cost: null,
          });
          attempts.push(attempt);
          throwTerminal(attempt.error!, {
            kind: "EVIDENCE_INVALID",
            attempts,
            providerEvidence: latestProviderEvidence,
            cause: error,
          });
        }

        let usage: TokenUsage;
        try {
          validateResponseAuthorityEvidence(latestProviderEvidence);
          usage = parseUsage(latestProviderEvidence.usage_raw);
        } catch (error) {
          const attempt = responseAttempt({
            attemptNumber,
            status: "FAILED",
            retryEligible: false,
            evidence: latestProviderEvidence,
            latency,
            usage: null,
            error: error instanceof Error ? error.message : String(error),
          });
          attempts.push(attempt);
          throwTerminal(attempt.error!, {
            kind: "EVIDENCE_INVALID",
            attempts,
            providerEvidence: latestProviderEvidence,
            cause: error,
          });
        }

        let status: string;
        try {
          status = responseStatus(latestProviderEvidence);
        } catch (error) {
          const attempt = responseAttempt({
            attemptNumber,
            status: "FAILED",
            retryEligible: false,
            evidence: latestProviderEvidence,
            latency,
            usage,
            error: error instanceof Error ? error.message : String(error),
          });
          attempts.push(attempt);
          throwTerminal(attempt.error!, {
            kind: "EVIDENCE_INVALID",
            attempts,
            providerEvidence: latestProviderEvidence,
            cause: error,
          });
        }

        const terminal = terminalResponseStatus({
          evidence: latestProviderEvidence,
          status,
        });
        if (terminal.status !== null) {
          const attempt = responseAttempt({
            attemptNumber,
            status: terminal.status,
            retryEligible: false,
            evidence: latestProviderEvidence,
            latency,
            usage,
            error: terminal.error,
          });
          attempts.push(attempt);
          const message = terminal.status === "REFUSED"
            ? attempt.refusal!
            : terminal.status === "INCOMPLETE"
              ? attempt.incomplete_reason!
              : attempt.error!;
          throwTerminal(message, {
            kind: "TERMINAL_RESPONSE",
            attempts,
            providerEvidence: latestProviderEvidence,
          });
        }

        let output: FinalDecisionMemoAdapterOutput;
        try {
          output = parseResponseOutput(latestProviderEvidence, request);
        } catch (error) {
          const retryEligible =
            attemptNumber < OPENAI_FINAL_DECISION_MEMO_MAX_ATTEMPTS;
          const attempt = responseAttempt({
            attemptNumber,
            status: "INVALID_OUTPUT",
            retryEligible,
            evidence: latestProviderEvidence,
            latency,
            usage,
            error: error instanceof Error ? error.message : String(error),
          });
          attempts.push(attempt);
          if (retryEligible) continue;
          throwTerminal(attempt.error!, {
            kind: "RETRIES_EXHAUSTED",
            attempts,
            providerEvidence: latestProviderEvidence,
            cause: error,
          });
        }

        if (options.signal?.aborted) {
          const attempt = responseAttempt({
            attemptNumber,
            status: "FAILED",
            retryEligible: false,
            evidence: latestProviderEvidence,
            latency,
            usage,
            error: safeEvidenceText(
              options.signal.reason,
              "Final Decision Memo 응답 처리 중 호출자 중단이 확인됐습니다.",
            ),
          });
          attempts.push(attempt);
          throwTerminal(attempt.error!, {
            kind: "REQUEST_ERROR",
            attempts,
            providerEvidence: latestProviderEvidence,
          });
        }

        const completeAttempt = responseAttempt({
          attemptNumber,
          status: "COMPLETE",
          retryEligible: false,
          evidence: latestProviderEvidence,
          latency,
          usage,
          error: null,
        });
        attempts.push(completeAttempt);
        const totalUsage = sumUsage(attempts);
        const totalCost = attempts.reduce(
          (sum, attempt) => (
            sum + (attempt.usage_cost?.totalCostUsd ?? 0)
          ),
          0,
        );
        return deepFreeze({
          output,
          run_evidence: {
            schema_version: "final-decision-memo-run-evidence-v1",
            adapter_request_hash: sha256CanonicalJson(request),
            request_contract_hash:
              sha256CanonicalJson(
                OPENAI_FINAL_DECISION_MEMO_REQUEST_CONTRACT,
              ),
            model_requested_id:
              OPENAI_FINAL_DECISION_MEMO_MODEL_REQUESTED_ID,
            model_reported_id:
              OPENAI_FINAL_DECISION_MEMO_MODEL_REQUESTED_ID,
            service_tier_requested:
              OPENAI_FINAL_DECISION_MEMO_SERVICE_TIER_REQUESTED,
            service_tier_reported:
              OPENAI_FINAL_DECISION_MEMO_SERVICE_TIER_REQUESTED,
            strict_output_schema_hash:
              sha256CanonicalJson(FINAL_DECISION_MEMO_OUTPUT_SCHEMA),
            pricing_snapshot_hash:
              sha256CanonicalJson(
                FINAL_DECISION_MEMO_PRICING_SNAPSHOT,
              ),
            store_requested: false,
            claim_evidence_refs:
              buildFinalDecisionMemoClaimEvidenceRefs(request),
            attempts,
            total_latency_ms: attempts.reduce(
              (sum, attempt) => sum + attempt.latency_ms,
              0,
            ),
            total_usage: totalUsage,
            total_cost_usd: totalCost,
          },
        });
      }

      throwTerminal(
        "Final Decision Memo runner가 terminal 결과 없이 종료됐습니다.",
        {
          kind: "RETRIES_EXHAUSTED",
          attempts,
          providerEvidence: latestProviderEvidence,
        },
      );
    },
  };
}

/**
 * Production TCB 경계입니다. 외부 client-like 객체를 받지 않고 이 함수
 * 내부에서만 OpenAI SDK instance를 만들어 official authority를 부여합니다.
 */
export function createOpenAIFinalDecisionMemoAdapter(
  config: OpenAIFinalDecisionMemoProductionAdapterConfig,
): OfficialOpenAIFinalDecisionMemoAdapter {
  const configRecord = readPlainRecord(
    config,
    "Production Final Decision Memo adapter config",
  );
  assertExactKeys(
    configRecord,
    config.signal === undefined
      ? ["apiKey"]
      : ["apiKey", "signal"],
    "Production Final Decision Memo adapter config",
  );
  if (
    typeof config.apiKey !== "string"
    || config.apiKey.trim().length === 0
    || config.apiKey.length > 4_000
    || /\p{Cc}/u.test(config.apiKey)
  ) {
    throw new TypeError(
      "Production Final Decision Memo adapter에는 비어 있지 않은 제한 길이 API key가 필요합니다.",
    );
  }
  if (
    config.signal !== undefined
    && !(config.signal instanceof AbortSignal)
  ) {
    throw new TypeError(
      "Production Final Decision Memo adapter signal이 AbortSignal이 아닙니다.",
    );
  }
  const client = new OpenAI({
    apiKey: config.apiKey,
    maxRetries: 0,
  });
  const adapter = createOpenAIFinalDecisionMemoAdapterCore(
    client,
    config.signal === undefined ? {} : { signal: config.signal },
    true,
  );
  OFFICIAL_OPENAI_FINAL_DECISION_MEMO_ADAPTERS.add(adapter);
  return adapter as OfficialOpenAIFinalDecisionMemoAdapter;
}

/**
 * Process 재시작의 read path에서 API key를 요구하지 않는 production adapter입니다.
 * key가 없으면 provider 호출 전에 typed mutation failure를 만들어 durable failure
 * receipt 경계로 전달하며, credential을 나중에 복구한 새 mutation은 다시 시도할 수
 * 있습니다.
 */
export function createLazyOpenAIFinalDecisionMemoAdapter(
  config: LazyOpenAIFinalDecisionMemoProductionAdapterConfig,
): OfficialOpenAIFinalDecisionMemoAdapter {
  const configRecord = readPlainRecord(
    config,
    "Lazy Production Final Decision Memo adapter config",
  );
  assertExactKeys(
    configRecord,
    config.signal === undefined
      ? ["resolveApiKey"]
      : ["resolveApiKey", "signal"],
    "Lazy Production Final Decision Memo adapter config",
  );
  if (typeof config.resolveApiKey !== "function") {
    throw new TypeError(
      "Lazy Production Final Decision Memo adapter에는 API key resolver가 필요합니다.",
    );
  }
  if (
    config.signal !== undefined
    && !(config.signal instanceof AbortSignal)
  ) {
    throw new TypeError(
      "Lazy Production Final Decision Memo adapter signal이 AbortSignal이 아닙니다.",
    );
  }

  let resolved: OfficialOpenAIFinalDecisionMemoAdapter | undefined;
  const adapter: FinalDecisionMemoAdapter = Object.freeze({
    invoke: async (request: FinalDecisionMemoAdapterRequest) => {
      if (resolved === undefined) {
        let apiKey: string;
        try {
          apiKey = config.resolveApiKey();
        } catch (cause) {
          throw new FinalDecisionMemoOpenAIError(
            "Final Decision Memo 실행 credential을 확인할 수 없습니다.",
            {
              kind: "REQUEST_ERROR",
              attempts: [Object.freeze({
                attempt_number: 1,
                request_disposition: "NOT_SENT",
                status: "REQUEST_ERROR",
                retry_eligible: false,
                response_id: null,
                refusal: null,
                incomplete_reason: null,
                error: "Final Decision Memo credential was unavailable before request.",
                latency_ms: 0,
                usage: null,
                usage_cost: null,
              })],
              providerEvidence: null,
              cause,
            },
          );
        }
        resolved = createOpenAIFinalDecisionMemoAdapter({
          apiKey,
          ...(config.signal === undefined ? {} : { signal: config.signal }),
        });
      }
      return resolved.invoke(request);
    },
  });
  OFFICIAL_OPENAI_FINAL_DECISION_MEMO_ADAPTERS.add(adapter);
  return adapter as OfficialOpenAIFinalDecisionMemoAdapter;
}

/**
 * 네트워크 없는 adapter 단위 테스트 전용 경계입니다.
 * 이 결과는 production controller의 official authority 검사를 통과하지 않습니다.
 */
export function createOpenAIFinalDecisionMemoAdapterForTest(
  client: OpenAIFinalDecisionMemoResponsesClientLike,
  options: OpenAIFinalDecisionMemoAdapterOptions = {},
): FinalDecisionMemoAdapter {
  return createOpenAIFinalDecisionMemoAdapterCore(client, options);
}

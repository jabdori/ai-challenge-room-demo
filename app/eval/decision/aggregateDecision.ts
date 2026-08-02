import type {
  CandidateComplexityId,
  CandidateComplexityProfile,
  CandidateComplexityProfiles,
} from "../contracts/candidateComplexity";
import type { ChallengeSufficiencyContract } from "../define/defineContracts";
import type { BenchmarkCandidateAggregate } from "../pack/benchmarkPack";

const CANDIDATE_IDS = ["A", "B", "C"] as const;
const HIDDEN_CASE_ID = /^H-(?:00[1-9]|01[0-2])$/;

const COMPLEXITY_KEYS = [
  "model_call_stages",
  "retrieval_index_dependencies",
  "external_tools",
  "state_or_memory",
  "candidate_failure_components",
  "dedicated_infrastructure",
] as const;

export type CandidateGateStatus =
  | "PASS"
  | "REVIEW_REQUIRED"
  | "CONFIRMED_FAIL";

export type FailedSufficiencyRule =
  | "CRITICAL_FAILURES"
  | "VALID_RUNS"
  | "POLICY_DECISIONS"
  | "CITATIONS"
  | "ESCALATIONS"
  | "REPEAT_STABILITY"
  | "OPEN_REVIEWS"
  | "RUNTIME_COST"
  | "MEDIAN_LATENCY"
  | "WORST_LATENCY";

export interface CandidateDecisionAssessment {
  readonly candidate_id: CandidateComplexityId;
  readonly gate_status: CandidateGateStatus;
  readonly critical_failed_case_ids: readonly string[];
  readonly deterministic_failed_case_ids: readonly string[];
  readonly human_confirmed_failed_case_ids: readonly string[];
  readonly open_review_count: number;
  readonly failed_sufficiency_rules: readonly FailedSufficiencyRule[];
  readonly sufficiency_passed: boolean;
  readonly eligible: boolean;
  readonly complexity_profile: CandidateComplexityProfile;
  readonly observed: {
    readonly valid_runs: number;
    readonly policy_success_cases: number;
    readonly citation_success_cases: number;
    readonly escalation_success_cases: number;
    readonly stable_cases: number;
    readonly average_runtime_cost_usd: number | null;
    readonly median_latency_ms: number;
    readonly worst_latency_ms: number;
  };
}

export interface HumanConfirmedDecisionAggregation {
  readonly schema_version: "human-confirmed-decision-aggregation-v1";
  readonly decision_status:
    | "EVALUATION_INCOMPLETE"
    | "NO_APPROVED_CANDIDATE"
    | "RECOMMENDATION_READY"
    | "CONDITIONAL_ALTERNATIVES";
  readonly candidates: readonly [
    CandidateDecisionAssessment,
    CandidateDecisionAssessment,
    CandidateDecisionAssessment,
  ];
  readonly eligible_candidate_ids: readonly CandidateComplexityId[];
  readonly minimum_complexity_candidate_ids: readonly CandidateComplexityId[];
  readonly recommended_candidate_id: CandidateComplexityId | null;
  readonly selection_authority: "HUMAN_DECISION_REQUIRED";
  readonly composite_score: null;
  readonly baseline_version: null;
}

export interface AggregateHumanConfirmedDecisionInput {
  readonly aggregates: readonly BenchmarkCandidateAggregate[];
  readonly complexityProfiles: CandidateComplexityProfiles;
  readonly sufficiency: ChallengeSufficiencyContract;
  readonly deterministicFailedCaseIds: Readonly<
    Record<CandidateComplexityId, readonly string[]>
  >;
  readonly humanConfirmedFailedCaseIds: Readonly<
    Record<CandidateComplexityId, readonly string[]>
  >;
  readonly openReviewCounts: Readonly<Record<CandidateComplexityId, number>>;
  readonly reviewOverflow: boolean;
}

export class DecisionAggregationIntegrityError extends Error {
  readonly code = "DECISION_AGGREGATION_INTEGRITY" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string) {
    super(message);
    this.name = "DecisionAggregationIntegrityError";
  }
}

function fail(message: string): never {
  throw new DecisionAggregationIntegrityError(message);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function readFailedCaseIds(
  value: readonly string[],
  location: string,
): readonly string[] {
  if (!Array.isArray(value)) fail(`${location}은 배열이어야 합니다.`);
  const ids = value.map((item) => {
    if (typeof item !== "string" || !HIDDEN_CASE_ID.test(item)) {
      fail(`${location}에는 H-001부터 H-012만 허용됩니다.`);
    }
    return item;
  });
  return Object.freeze([...new Set(ids)].sort());
}

function validateInput(input: AggregateHumanConfirmedDecisionInput): void {
  if (
    !Array.isArray(input.aggregates)
    || input.aggregates.length !== 3
    || input.aggregates.some(
      (item, index) => item.candidate_id !== CANDIDATE_IDS[index],
    )
  ) {
    fail("후보 집계는 A/B/C 잠긴 순서로 정확히 세 개여야 합니다.");
  }
  if (
    !Array.isArray(input.complexityProfiles)
    || input.complexityProfiles.length !== 3
    || input.complexityProfiles.some(
      (item, index) => item.candidate_id !== CANDIDATE_IDS[index],
    )
  ) {
    fail("복잡도 프로필은 A/B/C 잠긴 순서로 정확히 세 개여야 합니다.");
  }
  if (typeof input.reviewOverflow !== "boolean") {
    fail("reviewOverflow는 boolean이어야 합니다.");
  }
  for (const candidateId of CANDIDATE_IDS) {
    const openReviews = input.openReviewCounts[candidateId];
    if (!Number.isSafeInteger(openReviews) || openReviews < 0) {
      fail(`${candidateId} open review 수는 0 이상의 safe integer여야 합니다.`);
    }
  }
}

/**
 * 여섯 축의 component-wise strict partial order만 사용합니다.
 * Tier, 가중치, 비용, 품질은 복잡도 순서에 섞지 않습니다.
 */
export function isStrictlySimpler(
  left: CandidateComplexityProfile,
  right: CandidateComplexityProfile,
): boolean {
  let strictlyLower = false;
  for (const key of COMPLEXITY_KEYS) {
    if (left[key] > right[key]) return false;
    if (left[key] < right[key]) strictlyLower = true;
  }
  return strictlyLower;
}

function failedRules({
  aggregate,
  criticalFailedCaseIds,
  openReviewCount,
  sufficiency,
}: {
  readonly aggregate: BenchmarkCandidateAggregate;
  readonly criticalFailedCaseIds: readonly string[];
  readonly openReviewCount: number;
  readonly sufficiency: ChallengeSufficiencyContract;
}): FailedSufficiencyRule[] {
  const failed: FailedSufficiencyRule[] = [];
  if (criticalFailedCaseIds.length > sufficiency.critical_failures.maximum) {
    failed.push("CRITICAL_FAILURES");
  }
  if (
    !aggregate.valid_run_sufficiency
    || aggregate.counts.complete_runs < sufficiency.valid_runs.minimum
  ) failed.push("VALID_RUNS");
  if (
    aggregate.counts.policy_applicable_cases
      !== sufficiency.policy_decisions.applicable_cases
    || aggregate.counts.policy_success_cases
      < sufficiency.policy_decisions.minimum_correct
  ) failed.push("POLICY_DECISIONS");
  if (
    aggregate.counts.citation_required_cases
      !== sufficiency.citations.required_cases
    || aggregate.counts.citation_success_cases
      < sufficiency.citations.minimum_valid
  ) failed.push("CITATIONS");
  if (
    aggregate.counts.escalation_required_cases
      !== sufficiency.escalations.applicable_cases
    || aggregate.counts.escalation_success_cases
      < sufficiency.escalations.minimum_correct
  ) failed.push("ESCALATIONS");
  if (
    aggregate.stability.comparable_cases
      < sufficiency.repeat_stability.total_cases
    || aggregate.stability.stable_cases
      < sufficiency.repeat_stability.minimum_stable
  ) failed.push("REPEAT_STABILITY");
  if (openReviewCount > sufficiency.open_reviews.maximum) {
    failed.push("OPEN_REVIEWS");
  }
  if (
    aggregate.cost.accounted_runs < sufficiency.valid_runs.minimum
    || aggregate.cost.average_usd_per_ticket === null
    || !Number.isFinite(aggregate.cost.average_usd_per_ticket)
    || aggregate.cost.average_usd_per_ticket
      > sufficiency.mean_runtime_cost_usd.maximum
  ) failed.push("RUNTIME_COST");
  if (
    aggregate.latency.recorded_runs < sufficiency.valid_runs.minimum
    || aggregate.latency.median_ms > sufficiency.latency_ms.median_maximum
  ) failed.push("MEDIAN_LATENCY");
  if (
    aggregate.latency.recorded_runs < sufficiency.valid_runs.minimum
    || aggregate.latency.worst_ms > sufficiency.latency_ms.worst_maximum
  ) failed.push("WORST_LATENCY");
  return failed;
}

function assessCandidate({
  aggregate,
  complexityProfile,
  deterministicFailedCaseIds,
  humanConfirmedFailedCaseIds,
  openReviewCount,
  sufficiency,
}: {
  readonly aggregate: BenchmarkCandidateAggregate;
  readonly complexityProfile: CandidateComplexityProfile;
  readonly deterministicFailedCaseIds: readonly string[];
  readonly humanConfirmedFailedCaseIds: readonly string[];
  readonly openReviewCount: number;
  readonly sufficiency: ChallengeSufficiencyContract;
}): CandidateDecisionAssessment {
  const deterministic = readFailedCaseIds(
    deterministicFailedCaseIds,
    `${aggregate.candidate_id}.deterministicFailedCaseIds`,
  );
  const human = readFailedCaseIds(
    humanConfirmedFailedCaseIds,
    `${aggregate.candidate_id}.humanConfirmedFailedCaseIds`,
  );
  if (deterministic.length !== aggregate.counts.hard_gate_failed_cases) {
    fail(
      `${aggregate.candidate_id} 결정적 실패 case 목록과 Benchmark 집계가 다릅니다.`,
    );
  }
  const critical = Object.freeze([...new Set([...deterministic, ...human])].sort());
  const gateStatus: CandidateGateStatus = critical.length > 0
    ? "CONFIRMED_FAIL"
    : openReviewCount > 0
      ? "REVIEW_REQUIRED"
      : "PASS";
  const rules = Object.freeze(failedRules({
    aggregate,
    criticalFailedCaseIds: critical,
    openReviewCount,
    sufficiency,
  }));
  return deepFreeze({
    candidate_id: aggregate.candidate_id,
    gate_status: gateStatus,
    critical_failed_case_ids: critical,
    deterministic_failed_case_ids: deterministic,
    human_confirmed_failed_case_ids: human,
    open_review_count: openReviewCount,
    failed_sufficiency_rules: rules,
    sufficiency_passed: rules.length === 0,
    eligible: gateStatus === "PASS" && rules.length === 0,
    complexity_profile: complexityProfile,
    observed: {
      valid_runs: aggregate.counts.complete_runs,
      policy_success_cases: aggregate.counts.policy_success_cases,
      citation_success_cases: aggregate.counts.citation_success_cases,
      escalation_success_cases: aggregate.counts.escalation_success_cases,
      stable_cases: aggregate.stability.stable_cases,
      average_runtime_cost_usd: aggregate.cost.average_usd_per_ticket,
      median_latency_ms: aggregate.latency.median_ms,
      worst_latency_ms: aggregate.latency.worst_ms,
    },
  });
}

export function aggregateHumanConfirmedDecision(
  input: AggregateHumanConfirmedDecisionInput,
): HumanConfirmedDecisionAggregation {
  validateInput(input);
  const candidates = CANDIDATE_IDS.map((candidateId, index) => assessCandidate({
    aggregate: input.aggregates[index],
    complexityProfile: input.complexityProfiles[index],
    deterministicFailedCaseIds:
      input.deterministicFailedCaseIds[candidateId],
    humanConfirmedFailedCaseIds:
      input.humanConfirmedFailedCaseIds[candidateId],
    openReviewCount: input.openReviewCounts[candidateId],
    sufficiency: input.sufficiency,
  })) as [
    CandidateDecisionAssessment,
    CandidateDecisionAssessment,
    CandidateDecisionAssessment,
  ];

  const incomplete = input.reviewOverflow
    || candidates.some((candidate) => candidate.gate_status === "REVIEW_REQUIRED");
  const decisionCandidates = incomplete
    ? candidates.map((candidate) => deepFreeze({
      ...candidate,
      // 후보 자체의 잠긴 충분성 관측은 `sufficiency_passed`에 보존하되,
      // 전체 검수 무결성이 미완료이면 선택 권한인 eligibility는 발급하지 않습니다.
      eligible: false,
    })) as [
      CandidateDecisionAssessment,
      CandidateDecisionAssessment,
      CandidateDecisionAssessment,
    ]
    : candidates;
  const eligible = incomplete
    ? []
    : decisionCandidates.filter((candidate) => candidate.eligible);
  const minimum = eligible.filter((candidate) => (
    !eligible.some((other) => (
      other.candidate_id !== candidate.candidate_id
      && isStrictlySimpler(
        other.complexity_profile,
        candidate.complexity_profile,
      )
    ))
  ));
  const decisionStatus: HumanConfirmedDecisionAggregation["decision_status"] =
    incomplete
      ? "EVALUATION_INCOMPLETE"
      : eligible.length === 0
        ? "NO_APPROVED_CANDIDATE"
        : minimum.length === 1
          ? "RECOMMENDATION_READY"
          : "CONDITIONAL_ALTERNATIVES";
  return deepFreeze({
    schema_version: "human-confirmed-decision-aggregation-v1",
    decision_status: decisionStatus,
    candidates: decisionCandidates,
    eligible_candidate_ids: eligible.map((candidate) => candidate.candidate_id),
    minimum_complexity_candidate_ids:
      minimum.map((candidate) => candidate.candidate_id),
    recommended_candidate_id:
      decisionStatus === "RECOMMENDATION_READY"
        ? minimum[0].candidate_id
        : null,
    selection_authority: "HUMAN_DECISION_REQUIRED",
    composite_score: null,
    baseline_version: null,
  });
}

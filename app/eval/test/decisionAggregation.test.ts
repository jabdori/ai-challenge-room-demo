import { describe, expect, it } from "vitest";
import {
  P0_CANDIDATE_COMPLEXITY_PROFILES,
  type CandidateComplexityProfiles,
} from "../contracts/candidateComplexity";
import type { ChallengeSufficiencyContract } from "../define/defineContracts";
import type { BenchmarkCandidateAggregate } from "../pack/benchmarkPack";
import {
  aggregateHumanConfirmedDecision,
  isStrictlySimpler,
} from "../decision/aggregateDecision";

const sufficiency: ChallengeSufficiencyContract = {
  critical_failures: { maximum: 0, total_cases: 12 },
  valid_runs: { minimum: 24, total_runs: 24 },
  policy_decisions: { minimum_correct: 11, applicable_cases: 12 },
  citations: { minimum_valid: 11, required_cases: 11 },
  escalations: { minimum_correct: 4, applicable_cases: 4 },
  repeat_stability: { minimum_stable: 12, total_cases: 12 },
  open_reviews: { maximum: 0 },
  mean_runtime_cost_usd: { maximum: 0.05 },
  latency_ms: { median_maximum: 12_000, worst_maximum: 30_000 },
};

function passingAggregate(
  candidateId: "A" | "B" | "C",
  overrides: Partial<BenchmarkCandidateAggregate> = {},
): BenchmarkCandidateAggregate {
  return {
    candidate_id: candidateId,
    counts: {
      scheduled_runs: 24,
      complete_runs: 24,
      invalid_runs: 0,
      timeout_runs: 0,
      budget_exceeded_runs: 0,
      failed_runs: 0,
      evaluated_runs: 24,
      not_evaluated_runs: 0,
      evaluation_incomplete_runs: 0,
      hard_gate_failed_runs: 0,
      hard_gate_failed_cases: 0,
      policy_applicable_cases: 12,
      policy_success_cases: 12,
      citation_required_cases: 11,
      citation_success_cases: 11,
      escalation_required_cases: 4,
      escalation_success_cases: 4,
    },
    valid_run_sufficiency: true,
    hard_gate_sufficiency: true,
    cost: {
      accounted_runs: 24,
      charged_runs: 24,
      total_usd: 0.24,
      average_usd_per_ticket: 0.01,
    },
    latency: {
      recorded_runs: 24,
      median_ms: 1_000,
      worst_ms: 2_000,
    },
    stability: {
      comparable_cases: 12,
      stable_cases: 12,
      unstable_cases: 0,
      not_evaluable_cases: 0,
    },
    ...overrides,
  };
}

function decision(overrides: {
  aggregates?: readonly BenchmarkCandidateAggregate[];
  profiles?: CandidateComplexityProfiles;
  deterministicFailures?: Readonly<Record<"A" | "B" | "C", readonly string[]>>;
  humanFailures?: Readonly<Record<"A" | "B" | "C", readonly string[]>>;
  openReviews?: Readonly<Record<"A" | "B" | "C", number>>;
  reviewOverflow?: boolean;
} = {}) {
  return aggregateHumanConfirmedDecision({
    aggregates: overrides.aggregates ?? [
      passingAggregate("A"),
      passingAggregate("B"),
      passingAggregate("C"),
    ],
    complexityProfiles:
      overrides.profiles ?? P0_CANDIDATE_COMPLEXITY_PROFILES,
    sufficiency,
    deterministicFailedCaseIds: overrides.deterministicFailures ?? {
      A: [], B: [], C: [],
    },
    humanConfirmedFailedCaseIds: overrides.humanFailures ?? {
      A: [], B: [], C: [],
    },
    openReviewCounts: overrides.openReviews ?? { A: 0, B: 0, C: 0 },
    reviewOverflow: overrides.reviewOverflow ?? false,
  });
}

describe("사람 확인 이후 후보 집계와 최소 충분성 권고", () => {
  it("복잡도는 여섯 축 모두 작거나 같고 한 축 이상 작을 때만 더 단순하다", () => {
    expect(isStrictlySimpler(
      P0_CANDIDATE_COMPLEXITY_PROFILES[0],
      P0_CANDIDATE_COMPLEXITY_PROFILES[1],
    )).toBe(true);
    expect(isStrictlySimpler(
      P0_CANDIDATE_COMPLEXITY_PROFILES[1],
      P0_CANDIDATE_COMPLEXITY_PROFILES[0],
    )).toBe(false);

    const incomparable: CandidateComplexityProfiles = [
      P0_CANDIDATE_COMPLEXITY_PROFILES[0],
      { ...P0_CANDIDATE_COMPLEXITY_PROFILES[1], model_call_stages: 1 },
      {
        ...P0_CANDIDATE_COMPLEXITY_PROFILES[2],
        model_call_stages: 1,
        retrieval_index_dependencies: 0,
        external_tools: 1,
        state_or_memory: 0,
        candidate_failure_components: 1,
        dedicated_infrastructure: 0,
      },
    ];
    expect(isStrictlySimpler(incomparable[1], incomparable[2])).toBe(false);
    expect(isStrictlySimpler(incomparable[2], incomparable[1])).toBe(false);
  });

  it("모든 후보가 충분하면 가중합 없이 유일 최소 복잡도 A만 권고한다", () => {
    const result = decision();

    expect(result.decision_status).toBe("RECOMMENDATION_READY");
    expect(result.recommended_candidate_id).toBe("A");
    expect(result.eligible_candidate_ids).toEqual(["A", "B", "C"]);
    expect(result.candidates.every((candidate) => candidate.eligible)).toBe(true);
  });

  it("결정적 실패와 사람 확정 실패를 고유 사례로 합쳐 평균으로 상쇄하지 않는다", () => {
    const result = decision({
      aggregates: [
        passingAggregate("A", {
          counts: {
            ...passingAggregate("A").counts,
            hard_gate_failed_runs: 1,
            hard_gate_failed_cases: 1,
          },
          hard_gate_sufficiency: false,
        }),
        passingAggregate("B"),
        passingAggregate("C"),
      ],
      deterministicFailures: { A: ["H-007"], B: [], C: [] },
      humanFailures: { A: ["H-007", "H-010"], B: [], C: [] },
    });

    const candidateA = result.candidates[0];
    expect(candidateA.critical_failed_case_ids).toEqual(["H-007", "H-010"]);
    expect(candidateA.gate_status).toBe("CONFIRMED_FAIL");
    expect(candidateA.eligible).toBe(false);
    expect(result.recommended_candidate_id).toBe("B");
  });

  it("미완료 사람 검수 또는 overflow는 후보 실패로 꾸미지 않고 전체 평가를 차단한다", () => {
    const pending = decision({ openReviews: { A: 0, B: 1, C: 0 } });
    expect(pending.decision_status).toBe("EVALUATION_INCOMPLETE");
    expect(pending.recommended_candidate_id).toBeNull();
    expect(pending.candidates[1].gate_status).toBe("REVIEW_REQUIRED");

    const overflow = decision({ reviewOverflow: true });
    expect(overflow.decision_status).toBe("EVALUATION_INCOMPLETE");
    expect(overflow.recommended_candidate_id).toBeNull();
    expect(overflow.eligible_candidate_ids).toEqual([]);
    expect(
      overflow.candidates.every((candidate) => candidate.eligible === false),
    ).toBe(true);
    expect(
      overflow.candidates.every((candidate) => candidate.sufficiency_passed),
    ).toBe(true);
  });

  it("개수·비용·지연의 잠긴 경계를 각각 적용하고 null 비용을 0으로 취급하지 않는다", () => {
    const aggregates = [
      passingAggregate("A", {
        counts: {
          ...passingAggregate("A").counts,
          policy_success_cases: 10,
        },
      }),
      passingAggregate("B", {
        cost: {
          accounted_runs: 24,
          charged_runs: 24,
          total_usd: null,
          average_usd_per_ticket: null,
        },
      }),
      passingAggregate("C", {
        latency: { recorded_runs: 24, median_ms: 12_001, worst_ms: 30_000 },
      }),
    ];
    const result = decision({ aggregates });

    expect(result.decision_status).toBe("NO_APPROVED_CANDIDATE");
    expect(result.recommended_candidate_id).toBeNull();
    expect(result.candidates[0].failed_sufficiency_rules).toContain("POLICY_DECISIONS");
    expect(result.candidates[1].failed_sufficiency_rules).toContain("RUNTIME_COST");
    expect(result.candidates[2].failed_sufficiency_rules).toContain("MEDIAN_LATENCY");
  });

  it("복잡도 최소 후보가 둘 이상이면 자동 선택하지 않고 조건부 대안으로 남긴다", () => {
    const profiles: CandidateComplexityProfiles = [
      P0_CANDIDATE_COMPLEXITY_PROFILES[0],
      {
        ...P0_CANDIDATE_COMPLEXITY_PROFILES[1],
        model_call_stages: 1,
        retrieval_index_dependencies: 0,
        external_tools: 1,
        state_or_memory: 0,
        candidate_failure_components: 0,
        dedicated_infrastructure: 0,
      },
      P0_CANDIDATE_COMPLEXITY_PROFILES[2],
    ];
    const result = decision({ profiles });

    expect(result.decision_status).toBe("CONDITIONAL_ALTERNATIVES");
    expect(result.recommended_candidate_id).toBeNull();
    expect(result.minimum_complexity_candidate_ids).toEqual(["A", "B"]);
  });
});

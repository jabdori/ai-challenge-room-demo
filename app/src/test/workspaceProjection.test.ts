import type { BrowserPublicProjection } from "../data/challengeApi";
import {
  parseLockedChallengeView,
  parseEvidenceRecord,
  parseRecordedBenchmarkProgress,
  parseWorkspaceIndex,
  WorkspaceProjectionError,
} from "../data/workspaceProjection";

const candidateIds = ["A", "B", "C"] as const;
const caseIds = Array.from({ length: 12 }, (_, index) => (
  `H-${String(index + 1).padStart(3, "0")}`
));

function projection(value: Record<string, unknown>): BrowserPublicProjection {
  return value as BrowserPublicProjection;
}

function challengeProjection(): BrowserPublicProjection {
  return projection({
    schema_version: "challenge-public-projection-v1",
    synthetic: true,
    challenge_id: "support-ai-selection",
    challenge_version: "v1",
    state: "LOCKED",
    source_hash: "a".repeat(64),
    locked_at: "2026-07-17T00:00:00.000Z",
    approved_by: "Evaluation owner",
    approved_contract_hash: "b".repeat(64),
    task_contract: {
      decision: "Select a support drafting configuration.",
      input_contract: ["Synthetic ticket"],
      output_contract: ["Draft", "Escalation decision"],
      allowed_source_ids: ["SOURCE-POLICY"],
      operating_constraints: ["Read-only evidence"],
    },
    constraints: [{ constraint_id: "C-1", text: "Synthetic data only" }],
    prohibited_actions: [{ prohibition_id: "P-1", text: "No external action" }],
    source_manifest: {
      manifest_version: "source-manifest-v1",
      sources: [{
        source_id: "SOURCE-POLICY",
        source_type: "SYNTHETIC_POLICY",
        title: "Synthetic policy",
        content_sha256: "c".repeat(64),
        synthetic: true,
      }],
    },
    evaluation_criteria: [{
      criterion_id: "POLICY_ACCURACY",
      description: "Follow active policy.",
      evidence_required: ["Candidate output"],
    }],
    hard_gates: ["01", "02", "03", "04"].map((suffix) => ({
      gate_id: `P0-HG-${suffix}`,
      failure_condition: `Fatal condition ${suffix}`,
      required_evidence: ["Candidate output"],
    })),
    sufficiency: {
      critical_failures: { maximum: 0, total_cases: 12 },
      valid_runs: { minimum: 24, total_runs: 24 },
      repeat_stability: { minimum_stable: 12, total_cases: 12 },
      open_reviews: { maximum: 0 },
      mean_runtime_cost_usd: { maximum: 0.05 },
      latency_ms: { median_maximum: 12_000, worst_maximum: 30_000 },
    },
  });
}

function aggregate(candidateId: "A" | "B" | "C") {
  return {
    candidate_id: candidateId,
    counts: {
      scheduled_runs: 24,
      complete_runs: 24,
      invalid_runs: 0,
      timeout_runs: 0,
      budget_exceeded_runs: 0,
      hard_gate_failed_runs: 0,
      hard_gate_failed_cases: 0,
      policy_applicable_cases: 12,
      policy_success_cases: 12,
      citation_required_cases: 12,
      citation_success_cases: 12,
      escalation_required_cases: 4,
      escalation_success_cases: 4,
    },
    cost: { average_usd_per_ticket: 0.01 },
    latency: { median_ms: 1_000, worst_ms: 2_000 },
    stability: { comparable_cases: 12, stable_cases: 12, unstable_cases: 0 },
  };
}

function benchmarkProjection(): BrowserPublicProjection {
  return projection({
    schema_version: "benchmark-progress-projection-v1",
    synthetic: true,
    benchmark_id: "benchmark-01",
    source_hash: "d".repeat(64),
    source: "RECORDED_BENCHMARK",
    status: "REVIEW_PENDING",
    completed: 72,
    total: 72,
    review_time: "NOT_MEASURED",
    edit_time: "NOT_MEASURED",
    coverage: {
      cases: 12,
      candidates: 3,
      runs_per_case: 2,
      candidate_runs: 72,
      judge_cases: 12,
      complete_judge_cases: 11,
      human_fallback_judge_cases: 1,
      review_items: 15,
    },
    costs: {
      candidate_execution: {
        currency: "USD",
        accounted_runs: 72,
        total_usd: 1,
      },
      auxiliary_judge: {
        currency: "USD",
        accounted_cases: 12,
        total_usd: 0.1,
      },
    },
    candidate_aggregates: candidateIds.map(aggregate),
    slots: caseIds.flatMap((caseId) => candidateIds.flatMap((candidateId) => (
      ([1, 2] as const).map((repetition) => ({
        evidence_id: `slot_${caseId}_${candidateId}_${repetition}`,
        case_id: caseId,
        candidate_id: candidateId,
        repetition,
        execution_status: "COMPLETE",
        evaluation_status: "EVALUATED",
        hard_gate_status: "PASS",
        cost_usd: 0.01,
        latency_ms: 1_000,
      }))
    ))),
  });
}

describe("browser 공개 projection parser", () => {
  it("사람 검수 대기 중에는 aggregate를 유지하면서 candidate-case 슬롯을 받지 않는다", () => {
    const parsed = parseRecordedBenchmarkProgress(projection({
      ...benchmarkProjection(),
      benchmark_id: "a".repeat(64),
      coverage: {
        cases: 12,
        candidates: 3,
        runs_per_case: 2,
        candidate_runs: 72,
        judge_cases: 12,
        complete_judge_cases: 11,
        human_fallback_judge_cases: 1,
        review_items: 15,
      },
      costs: { total_usd: 0.03 },
      slots: [],
    }), { strictAuthority: true });

    expect(parsed.candidate_aggregates.map((item) => item.candidate_id))
      .toEqual(["A", "B", "C"]);
    expect(parsed.slots).toEqual([]);
    expect(parsed.auxiliary_judge).toEqual({
      complete: 11,
      human_fallback: 1,
      total: 12,
    });
  });

  it("workspace와 Locked Challenge를 fail-closed 계약으로 변환한다", () => {
    expect(parseWorkspaceIndex(projection({
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
      challenge_id: "support-ai-selection",
      benchmark_id: "benchmark-01",
      review_id: "review-01",
      decision_id: null,
      baseline_id: null,
      regression_id: null,
      source_hash: "d".repeat(64),
      stage_statuses: {
        define: "LOCKED",
        compare: "RECORDED",
        decide: "USER CONFIRMATION REQUIRED",
        monitor: "NO BASELINE",
      },
    }))).toMatchObject({
      challengeId: "support-ai-selection",
      benchmarkId: "benchmark-01",
      reviewId: "review-01",
      decisionId: null,
      baselineId: null,
      regressionId: null,
      sourceHash: "d".repeat(64),
      defineStatus: "LOCKED",
      compareStatus: "RECORDED",
    });

    expect(parseLockedChallengeView(challengeProjection())).toMatchObject({
      challenge_id: "support-ai-selection",
      state: "LOCKED",
      hard_gates: expect.arrayContaining([
        expect.objectContaining({ gate_id: "P0-HG-01" }),
      ]),
    });
  });

  it("후속 권위 식별자와 상태의 chain이 모순되면 workspace를 거부한다", () => {
    const base = {
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
      challenge_id: "support-ai-selection",
      benchmark_id: "benchmark-01",
      review_id: null,
      decision_id: "decision-01",
      baseline_id: "baseline-01",
      regression_id: null,
      source_hash: "d".repeat(64),
      stage_statuses: {
        define: "LOCKED",
        compare: "RECORDED",
        decide: "DECISION CONFIRMED",
        monitor: "BASELINE ACTIVE",
      },
    };
    expect(parseWorkspaceIndex(projection(base))).toMatchObject({
      decisionId: "decision-01",
      baselineId: "baseline-01",
      regressionId: null,
    });

    expect(() => parseWorkspaceIndex(projection({
      ...base,
      decision_id: null,
    }))).toThrow(WorkspaceProjectionError);
    expect(() => parseWorkspaceIndex(projection({
      ...base,
      baseline_id: null,
      regression_id: "regression-01",
      stage_statuses: {
        ...base.stage_statuses,
        monitor: "BLOCK",
      },
    }))).toThrow(WorkspaceProjectionError);
    expect(() => parseWorkspaceIndex(projection({
      ...base,
      source_hash: "not-a-hash",
    }))).toThrow(WorkspaceProjectionError);
    expect(() => parseWorkspaceIndex(projection({
      ...base,
      review_id: "review-01",
    }))).toThrow(WorkspaceProjectionError);
    expect(() => parseWorkspaceIndex(projection({
      ...base,
      stage_statuses: {
        ...base.stage_statuses,
        monitor: "NO BASELINE",
      },
    }))).toThrow(WorkspaceProjectionError);
  });

  it("blind Evidence에 실제 후보 또는 architecture 단서가 섞이면 거부한다", () => {
    const blindEvidence = {
      schema_version: "evidence-public-projection-v1",
      synthetic: true,
      source_hash: "d".repeat(64),
      evidence_id: "blind-evidence-01",
      kind: "blind-review",
      title: "Blind review evidence · H-001 · Candidate X",
      case_id: "H-001",
      candidate_label: "Candidate X",
      source: "BLIND HUMAN REVIEW",
      status: "REVIEW REQUIRED",
      case_summary: "Synthetic customer asks for a policy exception.",
      expected_decision: "Escalate to a human support agent.",
      policy_ids: ["POLICY-01"],
      deterministic_checks: ["No deterministic failure"],
      risk_signal: "Review the escalation rationale.",
    };
    expect(() => parseEvidenceRecord(projection({
      ...blindEvidence,
      run_one: "reviewer-only output",
    }))).toThrow(WorkspaceProjectionError);
    expect(parseEvidenceRecord(projection(blindEvidence))).toMatchObject({
      candidateLabel: "Candidate X",
      kind: "blind-review",
    });
    for (const leakedText of [
      "Candidate A generated this run.",
      "X = A",
      "The retrieval augmented generation path was used.",
      "search_policy returned the active clause.",
    ]) {
      expect(() => parseEvidenceRecord(projection({
        ...blindEvidence,
        risk_signal: leakedText,
      }))).toThrow(WorkspaceProjectionError);
    }
  });

  it("정확한 72개 좌표와 A/B/C 집계만 Recorded Benchmark로 허용한다", () => {
    const parsed = parseRecordedBenchmarkProgress(benchmarkProjection());
    expect(parsed.slots).toHaveLength(72);
    expect(parsed.candidate_aggregates.map((item) => item.candidate_id)).toEqual([
      "A",
      "B",
      "C",
    ]);

    const duplicated = structuredClone(benchmarkProjection());
    (duplicated.slots as Record<string, unknown>[])[71] = (
      duplicated.slots as Record<string, unknown>[]
    )[0];
    expect(() => parseRecordedBenchmarkProgress(duplicated)).toThrow(
      WorkspaceProjectionError,
    );
  });

  it("합성 source 경계가 깨지거나 hard gate가 네 개가 아니면 거부한다", () => {
    const unsafeSource = structuredClone(challengeProjection());
    const manifest = unsafeSource.source_manifest as {
      sources: Array<Record<string, unknown>>;
    };
    manifest.sources[0].synthetic = false;
    expect(() => parseLockedChallengeView(unsafeSource)).toThrow(
      WorkspaceProjectionError,
    );

    const missingGate = structuredClone(challengeProjection());
    (missingGate.hard_gates as unknown[]).pop();
    expect(() => parseLockedChallengeView(missingGate)).toThrow(
      WorkspaceProjectionError,
    );
  });
});

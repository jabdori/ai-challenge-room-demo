import { describe, expect, it, vi } from "vitest";
import { sha256CanonicalJson } from "../../eval/runtime/canonicalJson";
import {
  FINAL_DECISION_MEMO_PUBLIC_BODY_SCHEMA_VERSION,
  finalDecisionMemoPublicBodyPayload,
} from "../../shared/finalDecisionMemoPublicBody";
import { ChallengeApiClient } from "../data/challengeApi";
import {
  RecordedWorkflowProjectionError,
  parseActiveBaselineProjection,
  parseHumanConfirmedDecisionProjection,
  parsePreconfirmationProjection,
  parseRecordedRegressionProjection,
} from "../features/recorded/contracts";

const hash = (character: string) => character.repeat(64);

function finalDecisionMemoProjection(
  selectedCandidateId: "A" | "B" | "C" | null = "B",
  decisionProjectionSourceHash = hash("6"),
) {
  const selectedSummary = selectedCandidateId === null
    ? "The explicit human decision selected no candidate."
    : `The explicit human decision selected Candidate ${selectedCandidateId}.`;
  const publicBody = finalDecisionMemoPublicBodyPayload({
    source_hash: hash("6"),
    decision_projection_source_hash: decisionProjectionSourceHash,
    decision_summary: selectedSummary,
    rejected_alternatives: (["A", "B", "C"] as const)
      .filter((candidateId) => candidateId !== selectedCandidateId)
      .map((candidateId) => ({
        candidate_id: candidateId,
        reason:
          `Candidate ${candidateId} was not selected by the explicit human decision.`,
      })),
    hard_gate_findings: (["A", "B", "C"] as const).map((candidateId) => ({
      candidate_id: candidateId,
      critical_failed_case_ids: candidateId === "A" ? ["H-001"] : [],
    })),
    known_limitations: [
      `Benchmark scope: challenge_version=v1; recorded_pack_schema=recorded-benchmark-pack-v1; execution_pack_schema=benchmark-execution-pack-v1; dataset_sha256=${hash("d")}; cases=12; candidates=3; runs_per_case=2; candidate_runs=72; judge_cases=12.`,
      "Candidate versions: A=candidate-a-benchmark-v1 B=candidate-b-benchmark-v2 C=candidate-c-benchmark-v1.",
      "Human-review sample; required_high_risk_cases=4; required_candidate_case_reviews=12; completed_candidate_case_reviews=12; judge_flagged_candidate_case_reviews=2; statistical_generalization=NOT_SUPPORTED.",
      "P0 used one auxiliary gpt-5.6-sol Judge; deterministic rules and explicit human decisions remain authoritative.",
      "Candidate blinding and randomized positions do not eliminate single-Judge self-preference or position bias.",
    ],
    next_poc_scope:
      "Any next PoC must be separately defined and evaluated against the locked Challenge.",
    procurement_handoff:
      "Use the immutable benchmark and human-confirmation evidence in the existing review process.",
    external_action_statement:
      "No purchase, contract, deployment, or rollback was executed.",
    candidate_trade_offs: (["A", "B", "C"] as const).map((candidateId) => ({
      candidate_id: candidateId,
      disposition:
        candidateId === selectedCandidateId ? "SELECTED" : "NOT_SELECTED",
      summary: candidateId === selectedCandidateId
        ? selectedSummary
        : `Candidate ${candidateId} was not selected by the explicit human decision.`,
      critical_failed_case_ids: candidateId === "A" ? ["H-001"] : [],
    })),
  });
  return {
    ...publicBody,
    schema_version: FINAL_DECISION_MEMO_PUBLIC_BODY_SCHEMA_VERSION,
    public_body_sha256: sha256CanonicalJson(publicBody),
  };
}

function preconfirmationProjection() {
  return {
    schema_version: "preconfirmation-public-projection-v1",
    synthetic: true,
    review_id: "review-01",
    source_hash: hash("a"),
    recorded_benchmark_pack_hash: hash("b"),
    ai_pre_review_receipt_hash: hash("c"),
    provisional_decision_memo_hash: hash("d"),
    queue_content_hash: hash("e"),
    queue_set_order_hash: hash("f"),
    pre_review_status: "USER_CONFIRMATION_READY",
    blocking_reasons: [],
    advisory_only: true,
    human_confirmed: false,
    baseline_version: null,
    total: 2,
    completed: 0,
    remaining: 2,
    items: [
      {
        item_id: "item-01",
        evidence_id: "review-evidence-01",
        queue_index: 1,
        case_id: "H-001",
        blind_label: "X",
        queue_reason: "LOCKED_HIGH_RISK",
        proposed_decision: "PROPOSED_PASS",
        rationale: "The two recorded runs follow the locked policy.",
        evidence_handles: [`evh_${hash("1")}`],
        review_evidence_handle: `evh_${hash("1")}`,
        review_status: "REVIEW_REQUIRED",
      },
      {
        item_id: "item-02",
        evidence_id: "review-evidence-02",
        queue_index: 2,
        case_id: "H-002",
        blind_label: "Z",
        queue_reason: "JUDGE_RISK",
        proposed_decision: "PROPOSED_CONFIRMED_FAIL",
        rationale: "The auxiliary reviewer found a policy-risk pattern.",
        evidence_handles: [`evh_${hash("2")}`],
        review_evidence_handle: `evh_${hash("2")}`,
        review_status: "REVIEW_REQUIRED",
      },
    ],
  };
}

function candidate(
  candidateId: "A" | "B" | "C",
  eligible: boolean,
  complexity: number,
) {
  return {
    candidate_id: candidateId,
    gate_status: candidateId === "A" ? "CONFIRMED_FAIL" : "PASS",
    eligible,
    sufficiency_passed: candidateId !== "A",
    failed_sufficiency_rules: candidateId === "A" ? ["CRITICAL_FAILURES"] : [],
    critical_failed_case_ids: candidateId === "A" ? ["H-001"] : [],
    complexity_profile: {
      model_call_stages: complexity,
      retrieval_index_dependencies: candidateId === "A" ? 0 : 1,
      external_tools: candidateId === "C" ? 2 : 0,
      state_or_memory: 0,
      candidate_failure_components: complexity,
      dedicated_infrastructure: candidateId === "A" ? 0 : 1,
    },
    observed: {
      valid_runs: 24,
      policy_success_cases: candidateId === "A" ? 11 : 12,
      citation_success_cases: 12,
      escalation_success_cases: 4,
      stable_cases: 12,
      average_runtime_cost_usd: candidateId === "A" ? 0.008 : candidateId === "B" ? 0.012 : 0.025,
      median_latency_ms: candidateId === "A" ? 900 : candidateId === "B" ? 1400 : 2400,
      worst_latency_ms: candidateId === "A" ? 1500 : candidateId === "B" ? 2300 : 3800,
    },
  };
}

function decisionProjection() {
  return {
    schema_version: "decision-public-projection-v1",
    synthetic: true,
    decision_id: "decision-01",
    source_hash: hash("1"),
    status: "HUMAN_CONFIRMED_REVIEW",
    recorded_benchmark_pack_hash: hash("2"),
    ai_pre_review_receipt_hash: hash("3"),
    provisional_decision_memo_hash: hash("4"),
    human_confirmation_receipt_hash: hash("5"),
    final_decision_memo_hash: null,
    final_decision_memo: null,
    final_memo_confirmation_hash: null,
    human_confirmed: true,
    review: {
      completed: 2,
      total: 2,
      remaining: 0,
      total_review_duration_ms: 42_000,
      total_edit_duration_ms: 8_000,
    },
    candidates: [
      candidate("A", false, 1),
      candidate("B", true, 2),
      candidate("C", true, 3),
    ],
    eligible_candidate_ids: ["B", "C"],
    minimum_complexity_candidate_ids: ["B"],
    recommended_candidate_id: "B",
    selection_authority: "HUMAN_DECISION_REQUIRED",
    selected_candidate_id: null,
    selection_rationale: null,
    baseline_id: null,
    composite_score: null,
  };
}

function baselineProjection() {
  return {
    schema_version: "baseline-public-projection-v1",
    synthetic: true,
    baseline_id: "baseline-01",
    source_hash: hash("6"),
    status: "ACTIVE",
    selected_candidate_id: "B",
    decision_record_hash: hash("7"),
    final_decision_memo_hash: hash("8"),
    final_memo_confirmation_hash: hash("9"),
    configuration_hash: hash("a"),
    baseline_version: "v1",
    external_deployment_performed: false,
  };
}

function regressionProjection() {
  return {
    schema_version: "regression-public-projection-v1",
    synthetic: true,
    regression_id: "regression-01",
    source_hash: hash("b"),
    source: "RECORDED_REGRESSION",
    status: "RECORDED",
    verdict: "BLOCK",
    baseline_id: "baseline-01",
    baseline_version: "v1",
    baseline_candidate_id: "B",
    baseline_configuration_hash: hash("a"),
    proposed_configuration_hash: hash("c"),
    new_hard_gate_failures: [{
      case_id: "H-011",
      gate_ids: ["P0-HG-01", "P0-HG-02"],
      evidence_id: "regression-evidence-01",
      baseline_status: "PASS",
      proposed_status: "CONFIRMED_FAIL",
    }],
    evidence_bindings: [{
      schema_version: "regression-evidence-binding-v1",
      source_hash: hash("b"),
      evidence_id: "regression-evidence-01",
      evidence_binding_hash: hash("d"),
      case_id: "H-011",
      candidate_id: "B",
      candidate_label: "Candidate B",
      version: "PROPOSED_V2",
      kind: "benchmark",
      source: "RECORDED REGRESSION",
    }],
    comparison: {
      baseline: {
        label: "Baseline v1",
        hard_gate_failures: 0,
        mean_runtime_cost_usd: 0.012,
        median_latency_ms: 1400,
        worst_latency_ms: 2300,
      },
      proposed: {
        label: "Proposed v2",
        hard_gate_failures: 2,
        mean_runtime_cost_usd: 0.013,
        median_latency_ms: 1500,
        worst_latency_ms: 2500,
      },
    },
    blocking_reasons: [{
      code: "NEW_HARD_GATE_FAILURE",
      summary: "A new active-policy hard-gate failure was recorded.",
      evidence_id: "regression-evidence-01",
    }],
    external_deployment_performed: false,
    external_rollback_performed: false,
  };
}

describe("기록 기반 workflow projection 계약", () => {
  it("블라인드 pre-confirmation만 해석하고 advisory 제안을 인간 결정으로 승격하지 않는다", () => {
    const view = parsePreconfirmationProjection(preconfirmationProjection());

    expect(view.humanConfirmed).toBe(false);
    expect(view.advisoryOnly).toBe(true);
    expect(view.confirmationAllowed).toBe(true);
    expect(view.items.map((item) => item.candidateLabel)).toEqual([
      "Candidate X",
      "Candidate Z",
    ]);
    expect(view.items[0].proposedDecision).toBe("PROPOSED_PASS");
    expect(Object.isFrozen(view)).toBe(true);
  });

  it("active reviewer projection은 각 blind queue item에 서로 다른 opaque detail capability를 요구한다", () => {
    const projection = preconfirmationProjection();
    projection.items[1].review_evidence_handle = `evh_${hash("3")}`;

    const view = parsePreconfirmationProjection(projection);

    expect(view.items.map((item) => item.reviewEvidenceHandle)).toEqual([
      `evh_${hash("1")}`,
      `evh_${hash("3")}`,
    ]);
  });

  it("블라인드 item에 실제 후보 identity가 섞이면 fail-closed한다", () => {
    const invalid = preconfirmationProjection();
    Object.assign(invalid.items[0], { candidate_id: "A" });

    expect(() => parsePreconfirmationProjection(invalid)).toThrow(
      RecordedWorkflowProjectionError,
    );
  });

  it("블라인드 근거 문구에 A/B/C identity 또는 architecture hint가 섞이면 fail-closed한다", () => {
    for (const leakedText of [
      "Candidate A used the single LLM architecture.",
      "X = A",
      "This uses retrieval augmented generation.",
      "config-a-evidence",
    ]) {
      const identityLeak = preconfirmationProjection();
      identityLeak.items[0].rationale = leakedText;
      expect(
        () => parsePreconfirmationProjection(identityLeak),
        leakedText,
      ).toThrow(RecordedWorkflowProjectionError);
    }
  });

  it("ABSTAIN이 있는 queue를 사용자 확인 가능 상태로 허용하지 않는다", () => {
    const invalid = preconfirmationProjection();
    invalid.items[0].proposed_decision = "ABSTAIN";

    expect(() => parsePreconfirmationProjection(invalid)).toThrow(
      RecordedWorkflowProjectionError,
    );
  });

  it("사람 확인 receipt 이후의 서버 집계만 Decide view로 허용한다", async () => {
    const view = await parseHumanConfirmedDecisionProjection(
      decisionProjection(),
    );

    expect(view.humanConfirmed).toBe(true);
    expect(view.review.remaining).toBe(0);
    expect(view.eligibleCandidateIds).toEqual(["B", "C"]);
    expect(view.recommendedCandidateId).toBe("B");
    expect(view.selectedCandidateId).toBeNull();
    expect(view.compositeScore).toBeNull();
    expect(view.finalDecisionMemo).toBeNull();
  });

  it("Final Decision Memo 본문을 exact hash 결합 상태로만 해석한다", async () => {
    const projection = decisionProjection();
    Object.assign(projection, {
      source_hash: hash("6"),
      status: "MEMO_REVIEW_REQUIRED",
      selected_candidate_id: "B",
      selection_rationale:
        "Candidate B is the minimum-complexity sufficient option.",
      final_decision_memo_hash: hash("6"),
      final_decision_memo: finalDecisionMemoProjection("B"),
    });

    const view = await parseHumanConfirmedDecisionProjection(projection);

    expect(view.finalDecisionMemo).toMatchObject({
      sourceHash: hash("6"),
      decisionSummary:
        "The explicit human decision selected Candidate B.",
      externalActionStatement:
        "No purchase, contract, deployment, or rollback was executed.",
    });
    expect(view.finalDecisionMemo?.candidateTradeOffs).toHaveLength(3);
    expect(view.finalDecisionMemo?.knownLimitations.join(" ")).toMatch(
      /Candidate versions.*Human-review sample.*single-Judge/s,
    );
    expect(Object.isFrozen(view.finalDecisionMemo)).toBe(true);
  });

  it("Final Memo의 누락·거짓 경계·본문 변조·해시 치환을 fail-closed한다", async () => {
    const valid = {
      ...decisionProjection(),
      source_hash: hash("6"),
      status: "MEMO_REVIEW_REQUIRED",
      selected_candidate_id: "B",
      selection_rationale:
        "Candidate B is the minimum-complexity sufficient option.",
      final_decision_memo_hash: hash("6"),
      final_decision_memo: finalDecisionMemoProjection("B"),
    };
    const attacks: Record<string, unknown>[] = [
      {
        ...valid,
        final_decision_memo: null,
      },
      {
        ...valid,
        final_decision_memo: {
          ...finalDecisionMemoProjection("B"),
          source_hash: hash("7"),
        },
      },
      {
        ...valid,
        final_decision_memo: {
          ...finalDecisionMemoProjection("B"),
          external_action_statement:
            "The selected solution was purchased and deployed.",
        },
      },
      {
        ...valid,
        final_decision_memo: {
          ...finalDecisionMemoProjection("B"),
          known_limitations: [
            "Benchmark scope: cases=12.",
            "Candidate versions: A=v1 B=v1 C=v1.",
            "Human-review sample; statistical_generalization=NOT_SUPPORTED.",
          ],
        },
      },
      {
        ...valid,
        final_decision_memo: {
          ...finalDecisionMemoProjection("B"),
          candidate_trade_offs:
            finalDecisionMemoProjection("B").candidate_trade_offs.map(
              (item) => {
                const itemRecord = item as Record<string, unknown>;
                return itemRecord.candidate_id === "C"
                  ? { ...itemRecord, summary: "Candidate C was cheaper." }
                  : itemRecord;
              },
            ),
        },
      },
    ];

    for (const attack of attacks) {
      await expect(
        parseHumanConfirmedDecisionProjection(attack),
      ).rejects.toThrow(RecordedWorkflowProjectionError);
    }
  });

  it("Final Memo 공개 본문의 허용형 동시 변조도 원본 해시 문자열만 유지해 통과시키지 않는다", async () => {
    const valid = {
      ...decisionProjection(),
      source_hash: hash("6"),
      status: "MEMO_REVIEW_REQUIRED",
      selected_candidate_id: "B",
      selection_rationale:
        "Candidate B is the minimum-complexity sufficient option.",
      final_decision_memo_hash: hash("6"),
      final_decision_memo: finalDecisionMemoProjection("B"),
    };
    const attack = structuredClone(valid);
    Object.assign(attack.final_decision_memo, {
      next_poc_scope:
        "Skip the locked Challenge and immediately expand the selected solution.",
      procurement_handoff:
        "Treat this Memo as an automatic authorization to purchase.",
    });

    await expect(
      parseHumanConfirmedDecisionProjection(attack),
    ).rejects.toThrow(RecordedWorkflowProjectionError);
  });

  it("추천 후보와 사용자 선택 상태가 모순되면 권위 화면을 보류한다", async () => {
    const invalid = decisionProjection();
    Object.assign(invalid, {
      selected_candidate_id: "A",
      selection_rationale: "Select A",
    });

    await expect(
      parseHumanConfirmedDecisionProjection(invalid),
    ).rejects.toThrow(RecordedWorkflowProjectionError);
  });

  it("별도 Memo 확인으로 묶인 실제 ACTIVE baseline만 허용한다", () => {
    expect(parseActiveBaselineProjection(baselineProjection())).toMatchObject({
      baselineId: "baseline-01",
      selectedCandidateId: "B",
      version: "v1",
      externalDeploymentPerformed: false,
    });

    expect(() => parseActiveBaselineProjection({
      ...baselineProjection(),
      external_deployment_performed: true,
    })).toThrow(RecordedWorkflowProjectionError);
  });

  it("실제 recorded regression과 외부 무변경 경계만 Monitor에 허용한다", () => {
    const view = parseRecordedRegressionProjection(regressionProjection());

    expect(view.verdict).toBe("BLOCK");
    expect(view.newHardGateFailures[0].caseId).toBe("H-011");
    expect(view.externalDeploymentPerformed).toBe(false);
    expect(view.externalRollbackPerformed).toBe(false);

    expect(() => parseRecordedRegressionProjection({
      ...regressionProjection(),
      source: "RECORDED_BENCHMARK",
    })).toThrow(RecordedWorkflowProjectionError);
  });

  it("terminal·canary·비용 차단은 새 hard-gate failure 없이도 BLOCK으로 보존한다", () => {
    const projection = regressionProjection();
    projection.new_hard_gate_failures = [];
    projection.evidence_bindings = [];
    Object.assign(projection, { blocking_reasons: [{
      code: "TERMINAL_FAILURE",
      summary: "A terminal execution failure blocks change approval.",
      evidence_id: null,
    }] });

    const view = parseRecordedRegressionProjection(projection);
    expect(view.verdict).toBe("BLOCK");
    expect(view.newHardGateFailures).toEqual([]);
    expect(view.blockingReasons[0].code).toBe("TERMINAL_FAILURE");
  });

  it("REVIEW와 미측정 latency를 BLOCK으로 왜곡하지 않는다", () => {
    const projection = regressionProjection();
    projection.verdict = "REVIEW";
    projection.new_hard_gate_failures = [];
    projection.evidence_bindings = [];
    Object.assign(projection, { blocking_reasons: [{
      code: "COST_LIMIT_EXCEEDED",
      summary: "Cost exceeds the locked review threshold.",
      evidence_id: null,
    }] });
    Object.assign(projection.comparison.proposed, {
      median_latency_ms: null,
      worst_latency_ms: null,
    });

    const view = parseRecordedRegressionProjection(projection);
    expect(view.verdict).toBe("REVIEW");
    expect(view.comparison.proposed.medianLatencyMs).toBeNull();
    expect(view.comparison.proposed.worstLatencyMs).toBeNull();
  });

  it("새 hard-gate failure가 있으면 PASS 또는 REVIEW를 허용하지 않는다", () => {
    expect(() => parseRecordedRegressionProjection({
      ...regressionProjection(),
      verdict: "PASS",
    })).toThrow(RecordedWorkflowProjectionError);
  });
});

describe("기록 기반 workflow API client", () => {
  it("review·decision·baseline·regression의 식별된 projection만 요청한다", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const body = path.startsWith("/api/reviews/")
        ? preconfirmationProjection()
        : path.startsWith("/api/decisions/")
          ? decisionProjection()
          : path.startsWith("/api/baselines/")
            ? baselineProjection()
            : regressionProjection();
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new ChallengeApiClient(fetcher);

    await expect(client.getPreconfirmation("review-01")).resolves.toMatchObject({
      review_id: "review-01",
    });
    await expect(client.getDecision("decision-01")).resolves.toMatchObject({
      decision_id: "decision-01",
    });
    await expect(client.getBaseline("baseline-01")).resolves.toMatchObject({
      baseline_id: "baseline-01",
    });
    await expect(client.getRegression("regression-01")).resolves.toMatchObject({
      regression_id: "regression-01",
    });

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/reviews/review-01",
      "/api/decisions/decision-01",
      "/api/baselines/baseline-01",
      "/api/regressions/regression-01",
    ]);
  });

  it("요청한 ID와 응답 projection identity가 다르면 fail-closed한다", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ...decisionProjection(),
      decision_id: "decision-OTHER",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(
      new ChallengeApiClient(fetcher).getDecision("decision-01"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

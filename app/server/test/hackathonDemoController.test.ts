// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { BLIND_JUDGE_LABELS, BLIND_JUDGE_LOCKED_CRITERIA } from "../../eval/judge/contracts";
import {
  loadRecordedSyntheticDemoProjectionFixture,
} from "../../eval/demo/recordedSyntheticDemoProjectionFixture";
import {
  createHackathonDemoController,
  type DemoMemoAdapterLike,
  type DemoRiskAdapterLike,
} from "../hackathonDemoController";

function projection() {
  return loadRecordedSyntheticDemoProjectionFixture();
}

function riskAdapter(): DemoRiskAdapterLike {
  return {
    invoke: vi.fn(async (input) => ({
      output: {
        case_id: input.case_id,
        candidates: BLIND_JUDGE_LABELS.map((blindLabel) => ({
          blind_label: blindLabel,
          criteria: BLIND_JUDGE_LOCKED_CRITERIA.map((criterionId) => ({
            criterion_id: criterionId,
            status: blindLabel === "Z" && criterionId === "CITATION_RELEVANCE_RISK"
              ? "RISK" as const
              : "NO_RISK" as const,
            severity: blindLabel === "Z" && criterionId === "CITATION_RELEVANCE_RISK"
              ? "LOW" as const
              : null,
            failure_type: blindLabel === "Z" && criterionId === "CITATION_RELEVANCE_RISK"
              ? "CITATION_NOT_RELEVANT" as const
              : null,
            concerning_field: blindLabel === "Z" && criterionId === "CITATION_RELEVANCE_RISK"
              ? "CITATION_SOURCE_ID" as const
              : null,
            concerning_excerpt: blindLabel === "Z" && criterionId === "CITATION_RELEVANCE_RISK"
              ? "CANCEL-2026"
              : "",
            evidence_ids: blindLabel === "Z" && criterionId === "CITATION_RELEVANCE_RISK"
              ? [`${blindLabel}:RUN:1`]
              : [],
            rationale: "Auxiliary signal only.",
          })),
        })),
      },
      metadata: {
        response_id: "resp_judge_demo",
        response_status: "completed",
        model_requested_id: "gpt-5.6-sol",
        model_reported_id: "gpt-5.6-sol",
        service_tier_requested: "default",
        service_tier_reported: "default",
        store_requested: false,
        sdk_max_retries: 0,
        timeout_ms: 120_000,
        latency_ms: 41,
        usage: null,
      },
    })),
  };
}

function memoAdapter(): DemoMemoAdapterLike {
  return {
    invoke: vi.fn(async (input) => ({
      output: {
        case_id: input.case_id,
        selected_candidate_id: input.human_decision.selected_candidate_id,
        decision_summary:
          `Use Candidate ${input.human_decision.selected_candidate_id} for the next controlled PoC.`,
        human_selection_rationale: input.human_decision.rationale,
        human_review_evidence: structuredClone(input.human_review),
        candidate_evidence: structuredClone(input.candidate_evidence),
        known_limitations: [
          "One public synthetic ticket does not establish production superiority.",
        ],
        next_poc_scope:
          "Run a broader private evaluation before procurement or deployment.",
        external_action_statement: input.required_external_action_statement,
      },
      metadata: {
        response_id: "resp_memo_demo",
        response_status: "completed",
        model_requested_id: "gpt-5.6-sol",
        model_reported_id: "gpt-5.6-sol",
        service_tier_requested: "default",
        service_tier_reported: "default",
        store_requested: false,
        sdk_max_retries: 0,
        timeout_ms: 120_000,
        latency_ms: 53,
        usage: null,
      },
    })),
  };
}

describe("해커톤 종단간 데모 controller", () => {
  it("실제 canary를 정직한 공개 데모로 투영하고 Judge 입력에서는 A/B/C를 숨긴다", async () => {
    const judge = riskAdapter();
    const controller = createHackathonDemoController({
      projection: projection(),
      riskAdapter: judge,
      memoAdapter: memoAdapter(),
    });

    const initial = controller.getState();
    expect(initial).toMatchObject({
      source: "RECORDED_FALLBACK",
      status: "JUDGE_REQUIRED",
      canary: {
        case_id: "C-001",
        artifact_kind: "PARTIAL_CALIBRATION_PACK",
        evaluation_status: "EVALUATION_INCOMPLETE",
        total_cost_usd: 0.037776625,
      },
      judge: null,
      human_review: null,
      selection: null,
      memo: null,
      regression: null,
    });
    expect(initial.canary.candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      total_cost_usd: candidate.total_cost_usd,
      total_latency_ms: candidate.total_latency_ms,
      provider_calls: candidate.provider_calls,
      retrieval_calls: candidate.retrieval_calls,
      tool_calls: candidate.tool_calls,
    }))).toEqual([
      {
        candidate_id: "A",
        total_cost_usd: 0.007845,
        total_latency_ms: 3_284,
        provider_calls: 2,
        retrieval_calls: 0,
        tool_calls: 0,
      },
      {
        candidate_id: "B",
        total_cost_usd: 0.00759225,
        total_latency_ms: 5_842,
        provider_calls: 2,
        retrieval_calls: 2,
        tool_calls: 0,
      },
      {
        candidate_id: "C",
        total_cost_usd: 0.022339375,
        total_latency_ms: 9_825,
        provider_calls: 6,
        retrieval_calls: 2,
        tool_calls: 4,
      },
    ]);

    const judged = await controller.runJudge();
    expect(judged.status).toBe("REVIEW_REQUIRED");
    expect(judged.judge?.risks).toEqual([
      { blind_label: "X", status: "NO_RISK", failure_types: [] },
      { blind_label: "Y", status: "NO_RISK", failure_types: [] },
      { blind_label: "Z", status: "RISK", failure_types: ["CITATION_NOT_RELEVANT"] },
    ]);
    expect(judge.invoke).toHaveBeenCalledTimes(1);
    const input = vi.mocked(judge.invoke).mock.calls[0][0];
    expect(JSON.stringify(input)).not.toMatch(/candidate_[iI][dD]|Candidate [ABC]|Single LLM|RAG|agent/);
    expect(input.blind_candidates.map((candidate) => candidate.blind_label)).toEqual(["X", "Y", "Z"]);
  });

  it("블라인드 검수 완료 전 선택을 막고, 명시적 선택만 실제 Memo에 전달한다", async () => {
    const memo = memoAdapter();
    const controller = createHackathonDemoController({
      projection: projection(),
      riskAdapter: riskAdapter(),
      memoAdapter: memo,
    });
    await controller.runJudge();

    await expect(controller.createMemo({
      selected_candidate_id: "A",
      rationale: "Explicit human rationale.",
    })).rejects.toThrow(/사람 검수/i);
    await expect(controller.confirmReview({
      reviewer: "Demo decision owner",
      rationale: "Reviewed all six blinded drafts.",
      decisions: [
        { blind_label: "X", decision: "PASS" },
        { blind_label: "Y", decision: "PASS" },
      ],
    })).rejects.toThrow(/X\/Y\/Z/i);

    const reviewed = await controller.confirmReview({
      reviewer: "Demo decision owner",
      rationale: "Reviewed all six blinded drafts.",
      decisions: [
        { blind_label: "X", decision: "PASS" },
        { blind_label: "Y", decision: "PASS" },
        { blind_label: "Z", decision: "PASS" },
      ],
    });
    expect(reviewed.status).toBe("DECISION_REQUIRED");
    expect(reviewed.selection).toBeNull();
    expect(reviewed.human_review).toMatchObject({
      review_time: "NOT_MEASURED",
      edit_time: "NOT_MEASURED",
    });
    expect(reviewed.human_review).not.toHaveProperty("correction_seconds");

    const memoReady = await controller.createMemo({
      selected_candidate_id: "A",
      rationale: "Candidate A is the simplest configuration sufficient for this one-ticket demo.",
    });
    expect(memoReady.status).toBe("MEMO_READY");
    expect(memoReady.selection?.candidate_id).toBe("A");
    expect(memoReady.memo).toMatchObject({
      status: "COMPLETE",
      model_reported_id: "gpt-5.6-sol",
      decision: "Use Candidate A for the next controlled PoC.",
      limitations: "One public synthetic ticket does not establish production superiority.",
    });
    expect(memo.invoke).toHaveBeenCalledTimes(1);
    const memoInput = vi.mocked(memo.invoke).mock.calls[0][0];
    expect(memoInput.human_decision.selected_candidate_id).toBe("A");
    expect(memoInput.human_review).toEqual({
      reviewed_items: 3,
      remaining_items: 0,
      review_time: "NOT_MEASURED",
      edit_time: "NOT_MEASURED",
      decision: "CONFIRMED",
    });
    expect(memoInput.candidate_evidence).toHaveLength(3);
    expect(memoInput.candidate_evidence[0].metrics).toEqual(expect.arrayContaining([
      { metric_id: "runtime_cost_usd", value: 0.007845, unit: "USD" },
      { metric_id: "summed_latency_ms", value: 3_284, unit: "ms" },
      { metric_id: "hard_gate_passed_runs", value: 2, unit: "runs" },
    ]));
  });

  it("대표 결함 출력을 실제 결정적 gate로 재생하고 기존 결정을 유지한 채 BLOCK한다", async () => {
    const controller = createHackathonDemoController({
      projection: projection(),
      riskAdapter: riskAdapter(),
      memoAdapter: memoAdapter(),
    });
    await controller.runJudge();
    await controller.confirmReview({
      reviewer: "Demo decision owner",
      rationale: "Reviewed all six blinded drafts.",
      decisions: [
        { blind_label: "X", decision: "PASS" },
        { blind_label: "Y", decision: "PASS" },
        { blind_label: "Z", decision: "PASS" },
      ],
    });
    await controller.createMemo({
      selected_candidate_id: "A",
      rationale: "Candidate A is sufficient for this bounded demo.",
    });

    const blocked = await controller.replayRepresentativeDefect();

    expect(blocked.status).toBe("BLOCK");
    expect(blocked.selection?.candidate_id).toBe("A");
    expect(blocked.regression).toMatchObject({
      status: "BLOCK",
      recorded_decision_remains_unchanged: true,
      new_hard_gate_failures: expect.arrayContaining([
        "FORBIDDEN_ACTION",
        "INACTIVE_POLICY_CITATION",
        "FORBIDDEN_COMPLETION_CLAIM",
      ]),
      external_action_statement: "No external deployment or rollback was executed.",
    });
  });
});

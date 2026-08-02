import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { sha256CanonicalJson } from "../../eval/runtime/canonicalJson";
import {
  FINAL_DECISION_MEMO_PUBLIC_BODY_SCHEMA_VERSION,
  finalDecisionMemoPublicBodyPayload,
} from "../../shared/finalDecisionMemoPublicBody";
import { App } from "../App";
import { createRecordedBlindReviewEvidenceDetailFixture } from "./recordedBlindReviewEvidenceContract.test";

const hash = (character: string) => character.repeat(64);

function reviewerDetail() {
  return {
    ...createRecordedBlindReviewEvidenceDetailFixture(),
    item_id: "H-001--X",
    case_id: "H-001",
  };
}

function reviewerDetailWithRunTwoFailure() {
  const detail = structuredClone(reviewerDetail());
  const runTwo = detail.runs[1];
  runTwo.customer_reply = "Run 2 incorrectly promises that the refund is complete.";
  runTwo.structured_decision = {
    ...runTwo.structured_decision,
    action_code: "REFUND_APPROVED",
    escalation_required: true,
    escalation_reason_code: "MANUAL_REVIEW",
    target_queue: "CUSTOMER_SUPPORT",
  };
  runTwo.citations = [{ source_id: "POL-RUN-2", section_id: "REFUND-2" }];
  runTwo.deterministic_checks[3] = {
    gate_code: "P0-HG-04",
    status: "CONFIRMED_FAIL",
    findings: [{
      finding_code: "RUN_TWO_ONLY_FAILURE",
      evidence_excerpt: "refund is complete",
      finding_handle: `evh_${hash("8")}`,
      message_handle: `evh_${hash("7")}`,
      evidence_locations: [{
        location_kind: "CANDIDATE_OUTPUT",
        reference_handle: `evh_${hash("6")}`,
      }],
    }],
  };
  detail.judge_risks = [{
    criterion_id: "POLICY_ACCURACY",
    status: "RISK",
    severity: "HIGH",
    failure_type: "UNSUPPORTED_COMPLETION_PROMISE",
    concerning_excerpt: "refund is complete",
    rationale: "Run 2 requires human review for an unsupported completion promise.",
    evidence_references: ["RUN_2", "LOCKED_EXPECTATION"],
  }];
  return detail;
}

function finalDecisionMemoProjection(
  selectedCandidateId: "A" | "B" | "C" | null = "B",
  decisionProjectionSourceHash = hash("4"),
) {
  const decisionSummary = selectedCandidateId === null
    ? "The explicit human decision selected no candidate."
    : `The explicit human decision selected Candidate ${selectedCandidateId}.`;
  const publicBody = finalDecisionMemoPublicBodyPayload({
    source_hash: hash("4"),
    decision_projection_source_hash: decisionProjectionSourceHash,
    decision_summary: decisionSummary,
    rejected_alternatives: (["A", "B", "C"] as const)
      .filter((candidateId) => candidateId !== selectedCandidateId)
      .map((candidateId) => ({
        candidate_id: candidateId,
        reason:
          `Candidate ${candidateId} was not selected; locked cost, quality, latency, and complexity evidence remains visible.`,
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
      "Run a separately approved shadow PoC against the locked Challenge.",
    procurement_handoff:
      "Use the immutable benchmark and human-confirmation evidence in the existing procurement review.",
    external_action_statement:
      "No purchase, contract, deployment, or rollback was executed.",
    candidate_trade_offs: (["A", "B", "C"] as const).map((candidateId) => {
      const alternative = candidateId === selectedCandidateId
        ? null
        : `Candidate ${candidateId} was not selected; locked cost, quality, latency, and complexity evidence remains visible.`;
      return {
        candidate_id: candidateId,
        disposition:
          candidateId === selectedCandidateId ? "SELECTED" : "NOT_SELECTED",
        summary: alternative ?? decisionSummary,
        critical_failed_case_ids: candidateId === "A" ? ["H-001"] : [],
      };
    }),
  });
  return {
    ...publicBody,
    schema_version: FINAL_DECISION_MEMO_PUBLIC_BODY_SCHEMA_VERSION,
    public_body_sha256: sha256CanonicalJson(publicBody),
  };
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function challenge() {
  return {
    schema_version: "challenge-public-projection-v1",
    synthetic: true,
    challenge_id: "support-ai-selection",
    challenge_version: "v1",
    state: "LOCKED",
    source_hash: hash("9"),
    locked_at: "2026-07-17T00:00:00.000Z",
    approved_by: "Evaluation owner",
    approved_contract_hash: hash("8"),
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
        content_sha256: hash("7"),
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
  };
}

function workspace({
  sourceHash,
  reviewId = null,
  decisionId = null,
  baselineId = null,
  regressionId = null,
  decideStatus,
  monitorStatus,
}: {
  sourceHash: string;
  reviewId?: string | null;
  decisionId?: string | null;
  baselineId?: string | null;
  regressionId?: string | null;
  decideStatus: string;
  monitorStatus: string;
}) {
  return {
    schema_version: "workspace-public-projection-v1",
    synthetic: true,
    challenge_id: "support-ai-selection",
    benchmark_id: "benchmark-01",
    review_id: reviewId,
    decision_id: decisionId,
    baseline_id: baselineId,
    regression_id: regressionId,
    source_hash: sourceHash,
    stage_statuses: {
      define: "LOCKED",
      compare: "RECORDED",
      decide: decideStatus,
      monitor: monitorStatus,
    },
  };
}

function preconfirmation() {
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
    total: 1,
    completed: 0,
    remaining: 1,
    items: [{
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
    }],
  };
}

function blindEvidence() {
  return {
    schema_version: "evidence-public-projection-v1",
    synthetic: true,
    source_hash: hash("b"),
    evidence_id: "review-evidence-01",
    kind: "blind-review",
    title: "Blind review evidence · H-001 · Candidate X",
    case_id: "H-001",
    candidate_label: "Candidate X",
    source: "BLIND HUMAN REVIEW",
    status: "REVIEW REQUIRED",
    case_summary: "Synthetic customer requests an unsupported action.",
    expected_decision: "Do not promise the action.",
    run_one: "The first recorded run follows the locked policy.",
    run_two: "The second recorded run follows the locked policy.",
    policy_ids: ["POLICY-01"],
    deterministic_checks: ["No deterministic failure"],
    risk_signal: "Review the escalation rationale.",
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
    failed_sufficiency_rules: candidateId === "A"
      ? ["CRITICAL_FAILURES"]
      : [],
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
      average_runtime_cost_usd:
        candidateId === "A" ? 0.008 : candidateId === "B" ? 0.012 : 0.025,
      median_latency_ms:
        candidateId === "A" ? 900 : candidateId === "B" ? 1400 : 2400,
      worst_latency_ms:
        candidateId === "A" ? 1500 : candidateId === "B" ? 2300 : 3800,
    },
  };
}

function decision(
  overrides: Record<string, unknown> = {},
) {
  const projection: Record<string, unknown> = {
    schema_version: "decision-public-projection-v1",
    synthetic: true,
    decision_id: "decision-01",
    source_hash: hash("2"),
    status: "HUMAN_CONFIRMED_REVIEW",
    recorded_benchmark_pack_hash: hash("b"),
    ai_pre_review_receipt_hash: hash("c"),
    provisional_decision_memo_hash: hash("d"),
    human_confirmation_receipt_hash: hash("3"),
    final_decision_memo_hash: null,
    final_decision_memo: null,
    final_memo_confirmation_hash: null,
    human_confirmed: true,
    review: {
      completed: 1,
      total: 1,
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
    ...overrides,
  };
  if (
    projection.final_decision_memo_hash !== null
    && !Object.hasOwn(overrides, "final_decision_memo")
  ) {
    projection.final_decision_memo = finalDecisionMemoProjection(
      projection.selected_candidate_id === "A"
      || projection.selected_candidate_id === "B"
      || projection.selected_candidate_id === "C"
        ? projection.selected_candidate_id
        : null,
      String(projection.source_hash),
    );
  }
  return projection;
}

function baseline() {
  return {
    schema_version: "baseline-public-projection-v1",
    synthetic: true,
    baseline_id: "baseline-01",
    source_hash: hash("6"),
    status: "ACTIVE",
    selected_candidate_id: "B",
    decision_record_hash: hash("6"),
    final_decision_memo_hash: hash("4"),
    final_memo_confirmation_hash: hash("5"),
    configuration_hash: hash("8"),
    baseline_version: "v1",
    external_deployment_performed: false,
  };
}

function regression() {
  return {
    schema_version: "regression-public-projection-v1",
    synthetic: true,
    regression_id: "regression-01",
    source_hash: hash("9"),
    source: "RECORDED_REGRESSION",
    status: "RECORDED",
    verdict: "BLOCK",
    baseline_id: "baseline-01",
    baseline_version: "v1",
    baseline_candidate_id: "B",
    baseline_configuration_hash: hash("8"),
    proposed_configuration_hash: hash("0"),
    new_hard_gate_failures: [{
      case_id: "H-011",
      gate_ids: ["P0-HG-01"],
      evidence_id: "regression-evidence-01",
      baseline_status: "PASS",
      proposed_status: "CONFIRMED_FAIL",
    }],
    evidence_bindings: [{
      schema_version: "regression-evidence-binding-v1",
      evidence_id: "regression-evidence-01",
      source_hash: hash("9"),
      evidence_binding_hash: hash("c"),
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
        hard_gate_failures: 1,
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

describe("권위 artifact 기반 Review·Decide·Monitor 라우트", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Run 2에만 있는 실패와 Judge 위험을 별도 검증된 실행 근거로 보여주며 사람 확정을 열지 않는다", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") {
        return json(reviewerDetailWithRunTwoFailure());
      }
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: hash("a"),
          reviewId: "review-01",
          decideStatus: "USER CONFIRMATION REQUIRED",
          monitorStatus: "NO BASELINE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") return json(challenge());
      if (path === "/api/reviews/review-01") return json(preconfirmation());
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=decide");
    render(<App />);

    await user.click(await screen.findByRole("button", {
      name: "Open blind Evidence for H-001, Candidate X",
    }));
    const drawer = await screen.findByRole("dialog", {
      name: /Blind review evidence · H-001 · Candidate X/,
    });
    const runTwo = within(drawer).getByRole("region", {
      name: "Run 2 validated evidence",
    });

    expect(runTwo).toHaveTextContent("Run 2 incorrectly promises that the refund is complete.");
    expect(runTwo).toHaveTextContent("REFUND_APPROVED");
    expect(runTwo).toHaveTextContent("POL-RUN-2#REFUND-2");
    expect(runTwo).toHaveTextContent("P0-HG-04 · CONFIRMED_FAIL");
    expect(runTwo).toHaveTextContent("RUN_TWO_ONLY_FAILURE");
    expect(runTwo).toHaveTextContent("UNSUPPORTED_COMPLETION_PROMISE");
    const runOne = within(drawer).getByRole("region", {
      name: "Run 1 validated evidence",
    });
    expect(runOne).toHaveTextContent("PROVIDE_ORDER_STATUS");
    expect(within(runOne).getAllByText(/P0-HG-0[1-4] ·/)).toHaveLength(4);
    expect(within(runTwo).getAllByText(/P0-HG-0[1-4] ·/)).toHaveLength(4);

    await user.click(within(drawer).getByRole("button", {
      name: "Close Evidence drawer",
    }));
    expect(screen.getByRole("button", {
      name: "Confirm the blind review against the exact artifacts",
    })).toBeDisabled();
  });

  it("실행에 귀속되지 않은 Judge 위험 신호가 들어오면 review 확정은 열리지 않는다", async () => {
    const user = userEvent.setup();
    const invalidDetail = reviewerDetail();
    invalidDetail.judge_risks[0].evidence_references = ["POLICY_EVIDENCE"];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(invalidDetail);
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: hash("a"),
          reviewId: "review-01",
          decideStatus: "USER CONFIRMATION REQUIRED",
          monitorStatus: "NO BASELINE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") return json(challenge());
      if (path === "/api/reviews/review-01") return json(preconfirmation());
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=decide");
    render(<App />);

    await user.click(await screen.findByRole("button", {
      name: "Open blind Evidence for H-001, Candidate X",
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Evidence was withheld because its recorded projection did not validate.",
    );
    await user.click(screen.getByRole("radio", {
      name: "PASS for H-001, Candidate X",
    }));
    await user.type(screen.getByRole("textbox", {
      name: "Human rationale for H-001, Candidate X",
    }), "The evidence was withheld and cannot support a confirmation.");
    await user.type(screen.getByRole("textbox", {
      name: "Reviewer label",
    }), "Decision owner");
    await user.click(screen.getByRole("checkbox", {
      name: "I reviewed every blind item and the exact artifact hashes",
    }));

    expect(screen.getByRole("button", {
      name: "Confirm the blind review against the exact artifacts",
    })).toBeDisabled();
  });

  it("review confirmation 응답이 유실돼도 권위 workspace 전이로 성공을 조정한다", async () => {
    const user = userEvent.setup();
    let confirmed = false;
    let memoCreated = false;
    let reviewAttempts = 0;
    const fetcher = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(reviewerDetail());
      if (path === "/api/workspace") {
        return json(confirmed
          ? workspace({
              sourceHash: memoCreated ? hash("4") : hash("2"),
              decisionId: "decision-01",
              decideStatus: memoCreated
                ? "MEMO REVIEW REQUIRED"
                : "HUMAN CONFIRMED REVIEW",
              monitorStatus: "NO BASELINE",
            })
          : workspace({
              sourceHash: hash("a"),
              reviewId: "review-01",
              decideStatus: "USER CONFIRMATION REQUIRED",
              monitorStatus: "NO BASELINE",
            }));
      }
      if (path === "/api/challenges/support-ai-selection") {
        return json(challenge());
      }
      if (path === "/api/reviews/review-01") return json(preconfirmation());
      if (path === "/api/decisions/decision-01") return json(memoCreated
        ? decision({
            source_hash: hash("4"),
            status: "MEMO_REVIEW_REQUIRED",
            final_decision_memo_hash: hash("4"),
            final_decision_memo: finalDecisionMemoProjection("B"),
            selected_candidate_id: "B",
            selection_rationale: "Recorded retry key reconciliation test.",
          })
        : decision());
      if (path === "/api/evidence/review-evidence-01") {
        return json(blindEvidence());
      }
      if (
        path === "/api/reviews/review-01/confirm"
        && init?.method === "POST"
      ) {
        reviewAttempts += 1;
        if (reviewAttempts === 1) {
          throw new TypeError("request connection lost before commit");
        }
        confirmed = true;
        throw new TypeError("response connection lost after commit");
      }
      if (path === "/api/decisions/decision-01/memo" && init?.method === "POST") {
        memoCreated = true;
        return json({ accepted: true, source_hash: hash("4") });
      }
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=decide");
    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "Confirm the evidence, not the evaluator.",
    })).toBeVisible();
    expect(screen.getAllByText(/H-001 · Candidate X/)[0]).toBeVisible();
    expect(screen.queryByText("Candidate A")).not.toBeInTheDocument();

    const evidenceTrigger = screen.getByRole("button", {
      name: "Open blind Evidence for H-001, Candidate X",
    });
    evidenceTrigger.focus();
    await user.click(evidenceTrigger);
    const drawer = await screen.findByRole("dialog", {
      name: /Blind review evidence · H-001 · Candidate X/,
    });
    expect(drawer).toBeVisible();
    expect(drawer).toHaveTextContent("Run 1");
    expect(drawer).toHaveTextContent("Run 2");
    expect(drawer).toHaveTextContent(
      "The synthetic order is in transit under the active policy.",
    );
    expect(drawer).toHaveTextContent("PROVIDE_ORDER_STATUS");
    expect(drawer).toHaveTextContent("POL-ORDER#STATUS-1");
    expect(drawer.textContent).not.toMatch(
      /Candidate [ABC]\b|model|architecture|cost|latency|slot/i,
    );
    expect(fetcher.mock.calls.some(([input, init]) => (
      String(input) === "/api/reviewer/evidence/review-evidence-01"
      && (init?.headers as Record<string, string> | undefined)?.["x-review-evidence-handle"]
        === `evh_${hash("1")}`
    ))).toBe(true);
    expect(fetcher.mock.calls.some(([input]) => (
      String(input) === "/api/evidence/review-evidence-01"
    ))).toBe(false);
    await user.click(screen.getByRole("button", {
      name: "Close Evidence drawer",
    }));
    await waitFor(() => expect(evidenceTrigger).toHaveFocus());
    await user.click(screen.getByRole("radio", {
      name: "PASS for H-001, Candidate X",
    }));
    await user.type(screen.getByRole("textbox", {
      name: "Human rationale for H-001, Candidate X",
    }), "Both recorded runs follow the locked policy.");
    await user.type(
      screen.getByRole("textbox", { name: "Reviewer label" }),
      "Decision owner",
    );
    await user.click(screen.getByRole("checkbox", {
      name: "I reviewed every blind item and the exact artifact hashes",
    }));
    await user.click(screen.getByRole("button", {
      name: "Confirm the blind review against the exact artifacts",
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The server did not accept the requested authority transition.",
    );
    await user.click(screen.getByRole("button", {
      name: "Confirm the blind review against the exact artifacts",
    }));

    expect(await screen.findByRole("heading", {
      name: "Choose the simplest sufficient configuration.",
    })).toBeVisible();
    const reviewMutations = fetcher.mock.calls.filter(
      ([input, init]) => (
        String(input) === "/api/reviews/review-01/confirm"
        && init?.method === "POST"
      ),
    );
    expect(reviewMutations).toHaveLength(2);
    const mutation = reviewMutations[0];
    expect(mutation).toBeDefined();
    const body = JSON.parse(String(mutation?.[1]?.body));
    expect(body).toMatchObject({
      schema_version: "review-confirmation-command-v1",
      expected_source_hash: hash("a"),
      payload: {
        action: "CONFIRM_WITH_EDITS",
        actor_label: "Decision owner",
        items: [{
          item_id: "item-01",
          final_decision: "PASS",
          rationale: "Both recorded runs follow the locked policy.",
          proposal_resolution: "EDITED",
        }],
      },
    });
    expect(body.payload.items[0].edit_duration_ms).toBeGreaterThan(0);
    expect(JSON.parse(String(reviewMutations[1]?.[1]?.body)).idempotency_key)
      .toBe(body.idempotency_key);

    await user.click(screen.getByRole("radio", { name: /Candidate B/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Decision rationale" }),
      "Recorded retry key reconciliation test.",
    );
    await user.click(screen.getByRole("button", {
      name: "Generate recorded Decision Memo",
    }));
    expect((await screen.findAllByText(
      "The explicit human decision selected Candidate B.",
    ))[0]).toBeVisible();
    const memoMutation = fetcher.mock.calls.find(
      ([input, init]) => (
        String(input) === "/api/decisions/decision-01/memo"
        && init?.method === "POST"
      ),
    );
    expect(JSON.parse(String(memoMutation?.[1]?.body)).idempotency_key)
      .not.toBe(body.idempotency_key);
    expect(fetcher.mock.calls.filter(
      ([input]) => String(input) === "/api/workspace",
    )).toHaveLength(4);
  });

  it("유실된 provider 실패 replay는 같은 key를 폐기하고 다음 명시적 재시도에만 새 key를 쓴다", async () => {
    const user = userEvent.setup();
    let confirmed = false;
    let providerCalls = 0;
    const reviewKeys: string[] = [];
    const fetcher = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(reviewerDetail());
      if (path === "/api/workspace") {
        return json(confirmed
          ? workspace({
              sourceHash: hash("2"),
              decisionId: "decision-01",
              decideStatus: "HUMAN CONFIRMED REVIEW",
              monitorStatus: "NO BASELINE",
            })
          : workspace({
              sourceHash: hash("a"),
              reviewId: "review-01",
              decideStatus: "USER CONFIRMATION REQUIRED",
              monitorStatus: "NO BASELINE",
            }));
      }
      if (path === "/api/challenges/support-ai-selection") return json(challenge());
      if (path === "/api/reviews/review-01") return json(preconfirmation());
      if (path === "/api/decisions/decision-01") return json(decision());
      if (path === "/api/reviews/review-01/confirm" && init?.method === "POST") {
        const key = JSON.parse(String(init.body)).idempotency_key as string;
        reviewKeys.push(key);
        if (reviewKeys.length === 1) {
          providerCalls += 1;
          throw new TypeError("provider failure response was lost after durable record");
        }
        if (reviewKeys.length === 2) {
          return json({
            error: "REPLAYED_MUTATION",
            retry_allowed: false,
            failure_classification: "PROVIDER_TERMINAL_FAILURE",
            failure_hash: hash("f"),
          }, 409);
        }
        confirmed = true;
        return json({ accepted: true, source_hash: hash("2") });
      }
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=decide");
    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "Confirm the evidence, not the evaluator.",
    })).toBeVisible();
    await user.click(screen.getByRole("button", {
      name: "Open blind Evidence for H-001, Candidate X",
    }));
    expect(await screen.findByRole("dialog", {
      name: /Blind review evidence · H-001 · Candidate X/,
    })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close Evidence drawer" }));
    await user.click(screen.getByRole("radio", {
      name: "PASS for H-001, Candidate X",
    }));
    await user.type(screen.getByRole("textbox", {
      name: "Human rationale for H-001, Candidate X",
    }), "The recorded evidence supports this decision.");
    await user.type(screen.getByRole("textbox", {
      name: "Reviewer label",
    }), "Decision owner");
    await user.click(screen.getByRole("checkbox", {
      name: "I reviewed every blind item and the exact artifact hashes",
    }));

    const submit = screen.getByRole("button", {
      name: "Confirm the blind review against the exact artifacts",
    });
    await user.click(submit);
    await waitFor(() => expect(reviewKeys).toHaveLength(1));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The server did not accept the requested authority transition.",
    );
    expect(providerCalls).toBe(1);
    expect(reviewKeys).toHaveLength(1);

    await user.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "recorded terminal failure",
    );
    expect(providerCalls).toBe(1);
    expect(reviewKeys).toHaveLength(2);
    expect(reviewKeys[1]).toBe(reviewKeys[0]);

    await user.click(submit);
    expect(await screen.findByRole("heading", {
      name: "Choose the simplest sufficient configuration.",
    })).toBeVisible();
    expect(providerCalls).toBe(1);
    expect(reviewKeys).toHaveLength(3);
    expect(reviewKeys[2]).not.toBe(reviewKeys[0]);
  });

  it("Memo provider 실패 응답 유실은 durable replay로 상태를 재조정하고 새 명시적 재시도만 새 key로 보낸다", async () => {
    const user = userEvent.setup();
    const memoKeys: string[] = [];
    const rationale = "Candidate B remains the minimum-complexity sufficient option.";
    const fetcher = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: hash("2"),
          decisionId: "decision-01",
          decideStatus: "HUMAN CONFIRMED REVIEW",
          monitorStatus: "NO BASELINE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") return json(challenge());
      if (path === "/api/decisions/decision-01") return json(decision());
      if (path === "/api/decisions/decision-01/memo" && init?.method === "POST") {
        const key = JSON.parse(String(init.body)).idempotency_key as string;
        memoKeys.push(key);
        if (memoKeys.length === 1) {
          throw new TypeError(
            "provider failure was durably recorded but the response was lost",
          );
        }
        return json({
          error: memoKeys.length === 2
            ? "REPLAYED_MUTATION"
            : "PROVIDER_TERMINAL_FAILURE",
          retry_allowed: false,
          failure_classification: "PROVIDER_TERMINAL_FAILURE",
          failure_hash: hash(memoKeys.length === 2 ? "f" : "e"),
        }, memoKeys.length === 2 ? 409 : 502);
      }
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=decide");
    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "Choose the simplest sufficient configuration.",
    })).toBeVisible();
    const candidate = screen.getByRole("radio", { name: /Candidate B/ });
    const rationaleInput = screen.getByRole("textbox", {
      name: "Decision rationale",
    });
    const generate = screen.getByRole("button", {
      name: "Generate recorded Decision Memo",
    });
    await user.click(candidate);
    await user.type(rationaleInput, rationale);

    await user.click(generate);
    await waitFor(() => expect(memoKeys).toHaveLength(1));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Decision Memo was not generated",
    );
    expect(screen.getByText("No Final Decision Memo has been generated."))
      .toBeVisible();
    expect(candidate).toBeChecked();
    expect(rationaleInput).toHaveValue(rationale);
    expect(generate).toBeEnabled();

    await user.click(generate);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Decision Memo generation reached a recorded terminal failure",
    );
    expect(memoKeys).toHaveLength(2);
    expect(memoKeys[1]).toBe(memoKeys[0]);
    expect(candidate).toBeChecked();
    expect(rationaleInput).toHaveValue(rationale);
    expect(generate).toBeEnabled();

    await user.click(generate);
    await waitFor(() => expect(memoKeys).toHaveLength(3));
    expect(memoKeys[2]).not.toBe(memoKeys[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Decision Memo generation reached a recorded terminal failure",
    );
    expect(screen.getByText("No Final Decision Memo has been generated."))
      .toBeVisible();
    expect(candidate).toBeChecked();
    expect(rationaleInput).toHaveValue(rationale);
    expect(generate).toBeEnabled();
  });

  it("Evidence 호출자가 비활성화되면 drawer 종료 후 main workspace로 초점을 복귀한다", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(reviewerDetail());
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: hash("a"),
          reviewId: "review-01",
          decideStatus: "USER CONFIRMATION REQUIRED",
          monitorStatus: "NO BASELINE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") {
        return json(challenge());
      }
      if (path === "/api/reviews/review-01") return json(preconfirmation());
      if (path === "/api/evidence/review-evidence-01") {
        return json(blindEvidence());
      }
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=decide");
    render(<App />);

    const trigger = await screen.findByRole("button", {
      name: "Open blind Evidence for H-001, Candidate X",
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", {
      name: /Blind review evidence · H-001 · Candidate X/,
    })).toBeVisible();
    trigger.setAttribute("disabled", "");

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
  });

  it("보조 제안을 exact 수용하면 ACCEPT_ALL과 0ms edit time만 전송한다", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(reviewerDetail());
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: hash("a"),
          reviewId: "review-01",
          decideStatus: "USER CONFIRMATION REQUIRED",
          monitorStatus: "NO BASELINE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") {
        return json(challenge());
      }
      if (path === "/api/reviews/review-01") return json(preconfirmation());
      if (path === "/api/evidence/review-evidence-01") {
        return json(blindEvidence());
      }
      if (
        path === "/api/reviews/review-01/confirm"
        && init?.method === "POST"
      ) {
        return json({ accepted: true, source_hash: hash("2") });
      }
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=decide");
    render(<App />);

    await user.click(await screen.findByRole("button", {
      name: "Open blind Evidence for H-001, Candidate X",
    }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("radio", {
      name: "PASS for H-001, Candidate X",
    }));
    await user.type(screen.getByRole("textbox", {
      name: "Human rationale for H-001, Candidate X",
    }), "The two recorded runs follow the locked policy.");
    await user.type(
      screen.getByRole("textbox", { name: "Reviewer label" }),
      "Decision owner",
    );
    await user.click(screen.getByRole("checkbox", {
      name: "I reviewed every blind item and the exact artifact hashes",
    }));
    await user.click(screen.getByRole("button", {
      name: "Confirm the blind review against the exact artifacts",
    }));

    const mutation = fetcher.mock.calls.find(
      ([input, init]) => (
        String(input) === "/api/reviews/review-01/confirm"
        && init?.method === "POST"
      ),
    );
    const payload = JSON.parse(String(mutation?.[1]?.body));
    expect(payload.payload).toMatchObject({
      action: "ACCEPT_ALL",
      items: [{
        proposal_resolution: "ACCEPTED",
        edit_duration_ms: 0,
      }],
    });
  });

  it("Memo 생성과 확인은 각각 서버 mutation 후 projection reload로만 상태를 전진시킨다", async () => {
    const user = userEvent.setup();
    let state: "decision" | "memo" | "baseline" = "decision";
    const fetcher = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(reviewerDetail());
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash:
            state === "decision"
              ? hash("2")
              : state === "memo"
                ? hash("4")
                : hash("6"),
          decisionId: "decision-01",
          baselineId: state === "baseline" ? "baseline-01" : null,
          decideStatus:
            state === "decision"
              ? "HUMAN CONFIRMED REVIEW"
              : state === "memo"
                ? "MEMO REVIEW REQUIRED"
                : "DECISION CONFIRMED",
          monitorStatus:
            state === "baseline" ? "BASELINE ACTIVE" : "NO BASELINE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") {
        return json(challenge());
      }
      if (path === "/api/decisions/decision-01") {
        if (state === "decision") return json(decision());
        if (state === "memo") {
          return json(decision({
            source_hash: hash("4"),
            status: "MEMO_REVIEW_REQUIRED",
            selected_candidate_id: "B",
            selection_rationale:
              "Candidate B is the minimum-complexity sufficient option.",
            final_decision_memo_hash: hash("4"),
            final_decision_memo: finalDecisionMemoProjection("B"),
          }));
        }
        return json(decision({
          source_hash: hash("6"),
          status: "DECISION_CONFIRMED",
          selected_candidate_id: "B",
          selection_rationale:
            "Candidate B is the minimum-complexity sufficient option.",
          final_decision_memo_hash: hash("4"),
          final_decision_memo: finalDecisionMemoProjection("B", hash("6")),
          final_memo_confirmation_hash: hash("5"),
          baseline_id: "baseline-01",
        }));
      }
      if (path === "/api/baselines/baseline-01") return json(baseline());
      if (path === "/api/decisions/decision-01/memo" && init?.method === "POST") {
        state = "memo";
        return json({ accepted: true, source_hash: hash("4") });
      }
      if (
        path === "/api/decisions/decision-01/confirm"
        && init?.method === "POST"
      ) {
        state = "baseline";
        return json({ accepted: true, source_hash: hash("6") });
      }
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=decide");
    render(<App />);

    expect(await screen.findByText("System recommendation")).toBeVisible();
    expect(screen.getByRole("img", {
      name: "Recorded quality–cost trade-off",
    })).toBeVisible();
    expect(screen.getByRole("table", {
      name: "Accessible recorded quality–cost trade-off",
    })).toBeVisible();
    expect(screen.getByText(
      "This chart exposes quality, cost, gate status, and complexity. It does not select a candidate.",
    )).toBeVisible();
    expect(screen.queryByText(/Pareto/i)).not.toBeInTheDocument();
    expect(screen.getByText("NO COMPOSITE SCORE")).toBeVisible();
    expect(screen.getByText("No Final Decision Memo has been generated."))
      .toBeVisible();
    expect(screen.queryByRole("checkbox", {
      name: "I reviewed the exact validated Final Decision Memo",
    })).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Candidate B/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Decision rationale" }),
      "Candidate B is the minimum-complexity sufficient option.",
    );
    await user.click(screen.getByRole("button", {
      name: "Generate recorded Decision Memo",
    }));

    expect((await screen.findAllByText(
      "The explicit human decision selected Candidate B.",
    ))[0]).toBeVisible();
    expect(screen.getByText(
      "No purchase, contract, deployment, or rollback was executed.",
    )).toBeVisible();
    expect(screen.getByText(
      "Run a separately approved shadow PoC against the locked Challenge.",
    )).toBeVisible();
    expect(screen.getByText(
      /single-Judge self-preference or position bias/,
    )).toBeVisible();
    expect(screen.queryByText("ACTIVE BASELINE")).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", {
      name: "I reviewed the exact validated Final Decision Memo",
    }));
    await user.click(screen.getByRole("button", {
      name: "Confirm the exact Decision Memo and create baseline",
    }));

    expect((await screen.findAllByText("DECISION CONFIRMED"))[0]).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/baselines/baseline-01",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
    expect(fetcher.mock.calls.filter(
      ([input, init]) => (
        String(input).startsWith("/api/decisions/decision-01/")
        && init?.method === "POST"
      ),
    )).toHaveLength(2);
    const memoMutation = fetcher.mock.calls.find(
      ([input, init]) => (
        String(input) === "/api/decisions/decision-01/memo"
        && init?.method === "POST"
      ),
    );
    expect(JSON.parse(String(memoMutation?.[1]?.body))).toMatchObject({
      schema_version: "decision-memo-command-v1",
      expected_source_hash: hash("2"),
      payload: {
        action: "SELECT_CANDIDATE",
        candidate_id: "B",
        rationale:
          "Candidate B is the minimum-complexity sufficient option.",
      },
    });
    const decisionMutation = fetcher.mock.calls.find(
      ([input, init]) => (
        String(input) === "/api/decisions/decision-01/confirm"
        && init?.method === "POST"
      ),
    );
    expect(JSON.parse(String(decisionMutation?.[1]?.body))).toMatchObject({
      schema_version: "decision-confirmation-command-v1",
      expected_source_hash: hash("4"),
      payload: {
        action: "CONFIRM",
        expected_final_decision_memo_hash: hash("4"),
      },
    });
  });

  it("eligible 후보가 없으면 fallback 없이 no-approved Memo를 확인하고 baseline 없이 종결한다", async () => {
    const user = userEvent.setup();
    let state: "decision" | "memo" | "terminal" = "decision";
    const noEligibleCandidates = (["A", "B", "C"] as const).map(
      (candidateId, index) => ({
        ...candidate(candidateId, false, index + 1),
        gate_status: "CONFIRMED_FAIL",
        eligible: false,
        sufficiency_passed: false,
        failed_sufficiency_rules: ["CRITICAL_FAILURES"],
        critical_failed_case_ids: [`H-00${index + 1}`],
      }),
    );
    const rationale =
      "Every candidate has a confirmed fatal failure; no fallback is approved.";
    const fetcher = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(reviewerDetail());
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: state === "decision"
            ? hash("2")
            : state === "memo"
              ? hash("4")
              : hash("6"),
          decisionId: "decision-01",
          decideStatus: state === "decision"
            ? "HUMAN CONFIRMED REVIEW"
            : state === "memo"
              ? "MEMO REVIEW REQUIRED"
              : "NO APPROVED CANDIDATE",
          monitorStatus: "NO BASELINE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") {
        return json(challenge());
      }
      if (path === "/api/decisions/decision-01") {
        if (state === "decision") {
          return json(decision({
            candidates: noEligibleCandidates,
            eligible_candidate_ids: [],
            minimum_complexity_candidate_ids: [],
            recommended_candidate_id: null,
          }));
        }
        if (state === "memo") {
          return json(decision({
            source_hash: hash("4"),
            status: "MEMO_REVIEW_REQUIRED",
            candidates: noEligibleCandidates,
            eligible_candidate_ids: [],
            minimum_complexity_candidate_ids: [],
            recommended_candidate_id: null,
            selected_candidate_id: null,
            selection_rationale: rationale,
            final_decision_memo_hash: hash("4"),
            final_decision_memo: finalDecisionMemoProjection(null),
          }));
        }
        return json(decision({
          source_hash: hash("6"),
          status: "NO_APPROVED_CANDIDATE",
          candidates: noEligibleCandidates,
          eligible_candidate_ids: [],
          minimum_complexity_candidate_ids: [],
          recommended_candidate_id: null,
          selected_candidate_id: null,
          selection_rationale: rationale,
          final_decision_memo_hash: hash("4"),
          final_decision_memo: finalDecisionMemoProjection(null, hash("6")),
          final_memo_confirmation_hash: hash("5"),
        }));
      }
      if (path === "/api/decisions/decision-01/memo" && init?.method === "POST") {
        state = "memo";
        return json({ accepted: true, source_hash: hash("4") });
      }
      if (
        path === "/api/decisions/decision-01/confirm"
        && init?.method === "POST"
      ) {
        state = "terminal";
        return json({ accepted: true, source_hash: hash("6") });
      }
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=decide");
    render(<App />);

    expect(await screen.findByText(
      "No candidate is eligible for approval.",
    )).toBeVisible();
    const noApprovedChoice = screen.getByRole("radio", {
      name: "Record no approved candidate instead",
    });
    expect(noApprovedChoice).not.toBeChecked();
    expect(screen.getByRole("button", {
      name: "Generate no-approved Decision Memo",
    })).toBeDisabled();
    await user.click(noApprovedChoice);
    await user.type(
      screen.getByRole("textbox", { name: "Decision rationale" }),
      rationale,
    );
    await user.click(screen.getByRole("button", {
      name: "Generate no-approved Decision Memo",
    }));

    expect(await screen.findByText(
      "The explicit human decision selected no candidate.",
    )).toBeVisible();
    await user.click(screen.getByRole("checkbox", {
      name: "I reviewed the exact validated Final Decision Memo",
    }));
    await user.click(screen.getByRole("button", {
      name: "Confirm the exact no-approved decision",
    }));

    expect(await screen.findByRole("heading", {
      name: "No approved candidate",
    })).toBeVisible();
    expect(screen.getByText(
      "No candidate passed every locked requirement.",
    )).toBeVisible();
    expect(screen.getByText(rationale)).toBeVisible();
    expect(screen.queryByText("ACTIVE BASELINE")).not.toBeInTheDocument();

    const memoMutation = fetcher.mock.calls.find(
      ([input, init]) => (
        String(input) === "/api/decisions/decision-01/memo"
        && init?.method === "POST"
      ),
    );
    expect(JSON.parse(String(memoMutation?.[1]?.body))).toMatchObject({
      payload: {
        action: "SELECT_NO_APPROVED_CANDIDATE",
        candidate_id: null,
        rationale,
      },
    });
    expect(fetcher.mock.calls.some(
      ([input]) => String(input).startsWith("/api/baselines/"),
    )).toBe(false);
  });

  it("Monitor는 실제 baseline과 recorded regression만 읽고 BLOCK 근거를 표시한다", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(reviewerDetail());
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: hash("9"),
          decisionId: "decision-01",
          baselineId: "baseline-01",
          regressionId: "regression-01",
          decideStatus: "DECISION CONFIRMED",
          monitorStatus: "BLOCK",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") {
        return json(challenge());
      }
      if (path === "/api/baselines/baseline-01") return json(baseline());
      if (path === "/api/decisions/decision-01") {
        return json(decision({
          source_hash: hash("6"),
          status: "DECISION_CONFIRMED",
          selected_candidate_id: "B",
          selection_rationale:
            "Candidate B is the minimum-complexity sufficient option.",
          final_decision_memo_hash: hash("4"),
          final_memo_confirmation_hash: hash("5"),
          baseline_id: "baseline-01",
        }));
      }
      if (path === "/api/regressions/regression-01") return json(regression());
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=monitor");
    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "Protect the exact approved baseline.",
    })).toBeVisible();
    expect(screen.getByText("H-011")).toBeVisible();
    expect(screen.getByText(
      "A new active-policy hard-gate failure was recorded.",
    )).toBeVisible();
    expect(screen.getByText(/did not deploy, roll back, or change any external production system/i))
      .toBeVisible();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/regressions/regression-01",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("active baseline만 있으면 READY TO RUN을 표시하고 exact 회귀 명령 뒤 권위 projection을 다시 읽는다", async () => {
    const user = userEvent.setup();
    let started = false;
    const fetcher = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(reviewerDetail());
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: started ? hash("9") : hash("6"),
          decisionId: "decision-01",
          baselineId: "baseline-01",
          regressionId: started ? "regression-01" : null,
          decideStatus: "DECISION CONFIRMED",
          monitorStatus: started ? "BLOCK" : "BASELINE ACTIVE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") {
        return json(challenge());
      }
      if (path === "/api/decisions/decision-01") {
        return json(decision({
          source_hash: hash("6"),
          status: "DECISION_CONFIRMED",
          selected_candidate_id: "B",
          selection_rationale:
            "Candidate B is the minimum-complexity sufficient option.",
          final_decision_memo_hash: hash("4"),
          final_memo_confirmation_hash: hash("5"),
          baseline_id: "baseline-01",
        }));
      }
      if (path === "/api/baselines/baseline-01") return json(baseline());
      if (
        path === "/api/regressions/baseline-01/start"
        && init?.method === "POST"
      ) {
        started = true;
        return json({ accepted: true, source_hash: hash("9") });
      }
      if (path === "/api/regressions/regression-01") {
        return json(regression());
      }
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=monitor");
    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "Run the recorded regression against the active baseline.",
    })).toBeVisible();
    expect(screen.getAllByText("READY TO RUN").length).toBeGreaterThan(0);
    expect(screen.getByText(
      /does not deploy, roll back, or alter any external system/i,
    )).toBeVisible();

    await user.click(screen.getByRole("button", {
      name: "Run recorded regression",
    }));

    expect(await screen.findByRole("heading", {
      name: "Protect the exact approved baseline.",
    })).toBeVisible();
    const mutation = fetcher.mock.calls.find(
      ([input, init]) => (
        String(input) === "/api/regressions/baseline-01/start"
        && init?.method === "POST"
      ),
    );
    expect(mutation).toBeDefined();
    const command = JSON.parse(String(mutation?.[1]?.body));
    expect(command).toEqual({
      schema_version: "regression-start-command-v1",
      expected_source_hash: hash("6"),
      idempotency_key: expect.stringMatching(
        /^mutation_regression_[a-f0-9]{32}$/,
      ),
    });
    expect(fetcher.mock.calls.filter(
      ([input]) => String(input) === "/api/workspace",
    )).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/regressions/regression-01",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("회귀 시작이 accepted여도 reload에 실제 regression이 없으면 READY 상태로 되돌리지 않고 보류한다", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(reviewerDetail());
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: hash("6"),
          decisionId: "decision-01",
          baselineId: "baseline-01",
          decideStatus: "DECISION CONFIRMED",
          monitorStatus: "BASELINE ACTIVE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") {
        return json(challenge());
      }
      if (path === "/api/decisions/decision-01") {
        return json(decision({
          source_hash: hash("6"),
          status: "DECISION_CONFIRMED",
          selected_candidate_id: "B",
          selection_rationale:
            "Candidate B is the minimum-complexity sufficient option.",
          final_decision_memo_hash: hash("4"),
          final_memo_confirmation_hash: hash("5"),
          baseline_id: "baseline-01",
        }));
      }
      if (path === "/api/baselines/baseline-01") return json(baseline());
      if (
        path === "/api/regressions/baseline-01/start"
        && init?.method === "POST"
      ) {
        return json({ accepted: true, source_hash: hash("9") });
      }
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=monitor");
    render(<App />);

    await user.click(await screen.findByRole("button", {
      name: "Run recorded regression",
    }));

    expect(await screen.findByRole("heading", {
      name: "Recorded evidence could not be validated.",
    })).toBeVisible();
    expect(screen.queryByRole("button", {
      name: "Run recorded regression",
    })).not.toBeInTheDocument();
    expect(fetcher.mock.calls.filter(
      ([input, init]) => (
        String(input) === "/api/regressions/baseline-01/start"
        && init?.method === "POST"
      ),
    )).toHaveLength(1);
  });

  it("회귀 시작 중에는 중복 실행을 막고 실패하면 active baseline 유지와 비배포 경계를 표시한다", async () => {
    const user = userEvent.setup();
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const fetcher = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(reviewerDetail());
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: hash("6"),
          decisionId: "decision-01",
          baselineId: "baseline-01",
          decideStatus: "DECISION CONFIRMED",
          monitorStatus: "BASELINE ACTIVE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") {
        return json(challenge());
      }
      if (path === "/api/decisions/decision-01") {
        return json(decision({
          source_hash: hash("6"),
          status: "DECISION_CONFIRMED",
          selected_candidate_id: "B",
          selection_rationale:
            "Candidate B is the minimum-complexity sufficient option.",
          final_decision_memo_hash: hash("4"),
          final_memo_confirmation_hash: hash("5"),
          baseline_id: "baseline-01",
        }));
      }
      if (path === "/api/baselines/baseline-01") return json(baseline());
      if (
        path === "/api/regressions/baseline-01/start"
        && init?.method === "POST"
      ) {
        await requestGate;
        return json({ error: "STALE_SOURCE" }, 409);
      }
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=monitor");
    render(<App />);

    const button = await screen.findByRole("button", {
      name: "Run recorded regression",
    });
    await user.click(button);
    expect(screen.getByRole("button", {
      name: "Starting recorded regression",
    })).toBeDisabled();
    button.click();
    await waitFor(() => {
      expect(fetcher.mock.calls.filter(
        ([input, init]) => (
          String(input) === "/api/regressions/baseline-01/start"
          && init?.method === "POST"
        ),
      )).toHaveLength(1);
    });

    releaseRequest();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Recorded regression was not started.",
    );
    expect(screen.getByRole("button", {
      name: "Run recorded regression",
    })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The active baseline remains unchanged.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "No external deployment or rollback occurred.",
    );
  });

  it("모바일 read-only Monitor에서는 recorded regression 실행을 차단한다", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(max-width: 767px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const fetcher = vi.fn(async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(reviewerDetail());
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: hash("6"),
          decisionId: "decision-01",
          baselineId: "baseline-01",
          decideStatus: "DECISION CONFIRMED",
          monitorStatus: "BASELINE ACTIVE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") {
        return json(challenge());
      }
      if (path === "/api/decisions/decision-01") {
        return json(decision({
          source_hash: hash("6"),
          status: "DECISION_CONFIRMED",
          selected_candidate_id: "B",
          selection_rationale:
            "Candidate B is the minimum-complexity sufficient option.",
          final_decision_memo_hash: hash("4"),
          final_memo_confirmation_hash: hash("5"),
          baseline_id: "baseline-01",
        }));
      }
      if (path === "/api/baselines/baseline-01") return json(baseline());
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=monitor");
    render(<App />);

    expect(await screen.findByRole("button", {
      name: "Run recorded regression",
    })).toBeDisabled();
    expect(screen.getByText(
      /use the desktop workspace to start this recorded regression/i,
    )).toBeVisible();
    expect(fetcher.mock.calls.some(
      ([input, init]) => (
        String(input) === "/api/regressions/baseline-01/start"
        && init?.method === "POST"
      ),
    )).toBe(false);
  });

  it("새 hard-gate 밖의 Monitor 사유도 서버 evidence binding으로 열고 문맥 치환은 거부한다", async () => {
    const user = userEvent.setup();
    let substituted = false;
    const incompleteRegression = {
      ...regression(),
      verdict: "EVALUATION_INCOMPLETE",
      new_hard_gate_failures: [],
      evidence_bindings: [{
        schema_version: "regression-evidence-binding-v1",
        evidence_id: "regression-incomplete-evidence-01",
        source_hash: hash("9"),
        evidence_binding_hash: hash("d"),
        case_id: "H-004",
        candidate_id: "B",
        candidate_label: "Candidate B",
        version: "PROPOSED_V2",
        kind: "benchmark",
        source: "RECORDED REGRESSION",
      }],
      blocking_reasons: [{
        code: "PROPOSED_RUNNER_OR_EVIDENCE_INTEGRITY_INCOMPLETE",
        summary: "The proposed run or its evidence chain is incomplete.",
        evidence_id: "regression-incomplete-evidence-01",
      }],
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(reviewerDetail());
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: hash("9"),
          decisionId: "decision-01",
          baselineId: "baseline-01",
          regressionId: "regression-01",
          decideStatus: "DECISION CONFIRMED",
          monitorStatus: "EVALUATION INCOMPLETE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") {
        return json(challenge());
      }
      if (path === "/api/decisions/decision-01") {
        return json(decision({
          source_hash: hash("6"),
          status: "DECISION_CONFIRMED",
          selected_candidate_id: "B",
          selection_rationale:
            "Candidate B is the minimum-complexity sufficient option.",
          final_decision_memo_hash: hash("4"),
          final_memo_confirmation_hash: hash("5"),
          baseline_id: "baseline-01",
        }));
      }
      if (path === "/api/baselines/baseline-01") return json(baseline());
      if (path === "/api/regressions/regression-01") {
        return json(incompleteRegression);
      }
      if (path === "/api/evidence/regression-incomplete-evidence-01") {
        return json({
          schema_version: "evidence-public-projection-v1",
          synthetic: true,
          source_hash: hash("9"),
          evidence_id: "regression-incomplete-evidence-01",
          kind: "benchmark",
          title: "Proposed v2 regression evidence · H-004",
          case_id: substituted ? "H-999" : "H-004",
          candidate_label: "Candidate B",
          source: "RECORDED REGRESSION",
          status: "REVIEW REQUIRED",
          case_summary: "Synthetic execution evidence is incomplete.",
          expected_decision:
            "No change approval can be issued from incomplete evidence.",
          deterministic_checks: ["Evaluation incomplete"],
          regression_version: "PROPOSED_V2",
          evidence_binding_hash: substituted ? hash("e") : hash("d"),
        });
      }
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=monitor");
    render(<App />);

    const evidenceButton = await screen.findByRole("button", {
      name:
        "Open recorded Evidence for PROPOSED RUNNER OR EVIDENCE INTEGRITY INCOMPLETE",
    });
    await user.click(evidenceButton);
    expect(await screen.findByRole("dialog", {
      name: /Proposed v2 regression evidence · H-004/,
    })).toBeVisible();
    await user.click(screen.getByRole("button", {
      name: "Close Evidence drawer",
    }));

    substituted = true;
    await user.click(evidenceButton);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Evidence was withheld",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("No approved candidate를 URL fixture가 아닌 서버의 정상 결정 결과로 표시한다", async () => {
    const failedCandidates = (["A", "B", "C"] as const).map(
      (candidateId, index) => ({
        ...candidate(candidateId, false, index + 1),
        gate_status: "CONFIRMED_FAIL",
        eligible: false,
        sufficiency_passed: false,
        failed_sufficiency_rules: ["CRITICAL_FAILURES"],
        critical_failed_case_ids: [`H-00${index + 1}`],
      }),
    );
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(reviewerDetail());
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: hash("2"),
          decisionId: "decision-01",
          decideStatus: "NO APPROVED CANDIDATE",
          monitorStatus: "NO BASELINE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") {
        return json(challenge());
      }
      if (path === "/api/decisions/decision-01") {
        return json(decision({
          status: "NO_APPROVED_CANDIDATE",
          candidates: failedCandidates,
          eligible_candidate_ids: [],
          minimum_complexity_candidate_ids: [],
          recommended_candidate_id: null,
          selection_rationale:
            "Every candidate has a confirmed fatal failure.",
          final_decision_memo_hash: hash("4"),
          final_memo_confirmation_hash: hash("5"),
        }));
      }
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=no-approved");
    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "No approved candidate",
    })).toBeVisible();
    expect(screen.getByText(
      "No candidate passed every locked requirement.",
    )).toBeVisible();
    expect(screen.getByText(
      "Every candidate has a confirmed fatal failure.",
    )).toBeVisible();
    expect(screen.queryByRole("button", {
      name: "Confirm no approved candidate",
    })).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/decisions/decision-01",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("깨진 Decide projection을 fixture로 대체하지 않고 보류한다", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(reviewerDetail());
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: hash("2"),
          decisionId: "decision-01",
          decideStatus: "HUMAN CONFIRMED REVIEW",
          monitorStatus: "NO BASELINE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") {
        return json(challenge());
      }
      if (path === "/api/decisions/decision-01") {
        return json({ ...decision(), human_confirmed: false });
      }
      return json({ error: "NOT_FOUND" }, 404);
    }));
    window.history.replaceState({}, "", "/?view=decide");
    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "Recorded evidence could not be validated.",
    })).toBeVisible();
    expect(screen.queryByRole("heading", {
      name: "Decide with evidence",
    })).not.toBeInTheDocument();
  });

  it("workspace와 Decision 상태가 다르면 baseline이 있어도 권위 화면을 보류한다", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(reviewerDetail());
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: hash("6"),
          decisionId: "decision-01",
          baselineId: "baseline-01",
          decideStatus: "DECISION CONFIRMED",
          monitorStatus: "BASELINE ACTIVE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") {
        return json(challenge());
      }
      if (path === "/api/decisions/decision-01") {
        return json(decision({
          source_hash: hash("6"),
          status: "NO_APPROVED_CANDIDATE",
          candidates: (["A", "B", "C"] as const).map(
            (candidateId, index) => ({
              ...candidate(candidateId, false, index + 1),
              gate_status: "CONFIRMED_FAIL",
              sufficiency_passed: false,
              failed_sufficiency_rules: ["CRITICAL_FAILURES"],
              critical_failed_case_ids: [`H-00${index + 1}`],
            }),
          ),
          eligible_candidate_ids: [],
          minimum_complexity_candidate_ids: [],
          recommended_candidate_id: null,
        }));
      }
      if (path === "/api/baselines/baseline-01") return json(baseline());
      return json({ error: "NOT_FOUND" }, 404);
    }));
    window.history.replaceState({}, "", "/?view=decide");
    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "Recorded evidence could not be validated.",
    })).toBeVisible();
  });

  it("Decision과 baseline의 Memo·확인 hash가 다르면 확정 상태를 거부한다", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") return json(reviewerDetail());
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: hash("6"),
          decisionId: "decision-01",
          baselineId: "baseline-01",
          decideStatus: "DECISION CONFIRMED",
          monitorStatus: "BASELINE ACTIVE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") {
        return json(challenge());
      }
      if (path === "/api/decisions/decision-01") {
        return json(decision({
          source_hash: hash("6"),
          status: "DECISION_CONFIRMED",
          selected_candidate_id: "B",
          selection_rationale:
            "Candidate B is the minimum-complexity sufficient option.",
          final_decision_memo_hash: hash("4"),
          final_memo_confirmation_hash: hash("5"),
          baseline_id: "baseline-01",
        }));
      }
      if (path === "/api/baselines/baseline-01") {
        return json({
          ...baseline(),
          final_decision_memo_hash: hash("f"),
        });
      }
      return json({ error: "NOT_FOUND" }, 404);
    }));
    window.history.replaceState({}, "", "/?view=decide");
    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "Recorded evidence could not be validated.",
    })).toBeVisible();
  });

  it("동일 evidence ID라도 queue와 사건·익명 후보·source가 다르면 drawer를 열지 않는다", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/reviewer/evidence/review-evidence-01") {
        return json({
          ...reviewerDetail(),
          case_id: "H-999",
          candidate_label: "Candidate Y",
        });
      }
      if (path === "/api/workspace") {
        return json(workspace({
          sourceHash: hash("a"),
          reviewId: "review-01",
          decideStatus: "USER CONFIRMATION REQUIRED",
          monitorStatus: "NO BASELINE",
        }));
      }
      if (path === "/api/challenges/support-ai-selection") {
        return json(challenge());
      }
      if (path === "/api/reviews/review-01") return json(preconfirmation());
      if (path === "/api/evidence/review-evidence-01") {
        return json({
          ...blindEvidence(),
          source_hash: hash("f"),
          case_id: "H-999",
          candidate_label: "Candidate Y",
          title: "Blind review evidence · H-999 · Candidate Y",
        });
      }
      return json({ error: "NOT_FOUND" }, 404);
    }));
    window.history.replaceState({}, "", "/?view=decide");
    render(<App />);

    await user.click(await screen.findByRole("button", {
      name: "Open blind Evidence for H-001, Candidate X",
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Evidence was withheld",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

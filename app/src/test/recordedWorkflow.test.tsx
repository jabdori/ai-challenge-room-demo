import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "../App";

const candidateIds = ["A", "B", "C"] as const;
const caseIds = Array.from({ length: 12 }, (_, index) => (
  `H-${String(index + 1).padStart(3, "0")}`
));

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function workspace() {
  return {
    schema_version: "workspace-public-projection-v1",
    synthetic: true,
    challenge_id: "support-ai-selection",
    benchmark_id: "d".repeat(64),
    review_id: null,
    decision_id: null,
    baseline_id: null,
    regression_id: null,
    source_hash: "d".repeat(64),
    stage_statuses: {
      define: "LOCKED",
      compare: "RECORDED",
      decide: "REVIEW PENDING",
      monitor: "NO BASELINE",
    },
  };
}

function challenge() {
  return {
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
  };
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
      hard_gate_failed_runs: candidateId === "A" ? 1 : 0,
      hard_gate_failed_cases: candidateId === "A" ? 1 : 0,
      policy_applicable_cases: 12,
      policy_success_cases: candidateId === "A" ? 11 : 12,
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

function benchmark() {
  return {
    schema_version: "benchmark-progress-projection-v1",
    synthetic: true,
    benchmark_id: "d".repeat(64),
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
      complete_judge_cases: 12,
      human_fallback_judge_cases: 0,
      review_items: 12,
    },
    costs: {},
    candidate_aggregates: candidateIds.map(aggregate),
    slots: caseIds.flatMap((caseId) => candidateIds.flatMap((candidateId) => (
      ([1, 2] as const).map((repetition) => ({
        evidence_id: `slot_${caseId}_${candidateId}_${repetition}`,
        case_id: caseId,
        candidate_id: candidateId,
        repetition,
        execution_status: "COMPLETE",
        evaluation_status: "EVALUATED",
        hard_gate_status: caseId === "H-001" && candidateId === "A" && repetition === 1
          ? "CONFIRMED_FAIL"
          : "PASS",
        cost_usd: 0.01,
        latency_ms: 1_000,
      }))
    ))),
  };
}

/** Compare public progress와 섞지 않는 reviewer 전용 projection fixture입니다. */
function activeReviewerProjection() {
  return {
    schema_version: "preconfirmation-public-projection-v1",
    synthetic: true,
    review_id: "review-01",
    source_hash: "d".repeat(64),
    recorded_benchmark_pack_hash: "a".repeat(64),
    ai_pre_review_receipt_hash: "b".repeat(64),
    provisional_decision_memo_hash: "c".repeat(64),
    queue_content_hash: "e".repeat(64),
    queue_set_order_hash: "f".repeat(64),
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
      rationale: "Recorded deterministic evidence requires human review.",
      evidence_handles: [`evh_${"1".repeat(64)}`],
      review_evidence_handle: `evh_${"1".repeat(64)}`,
      review_status: "REVIEW_REQUIRED",
    }],
  };
}

function runningBenchmark() {
  return {
    schema_version: "benchmark-progress-projection-v1",
    synthetic: true,
    benchmark_id: "d".repeat(64),
    challenge_id: "support-ai-selection",
    source_hash: "d".repeat(64),
    status: "RUNNING",
    candidate_execution: { completed: 1, total: 72 },
    auxiliary_judge: { completed: 0, total: 12 },
    cleanup: { required: 33, acknowledged: 0, incomplete: 33 },
    attempt_number: 1,
    started_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:01.000Z",
    single_flight: true,
    resume: { allowed: false, action: "NONE", from_progress_hash: null },
    failure: null,
    terminal_slots: [{
      evidence_id: "slot_H-001_A_1",
      case_id: "H-001",
      candidate_id: "A",
      repetition: 1,
      execution_status: "COMPLETE",
      evaluation_status: "EVALUATED",
      hard_gate_status: "PASS",
      cost_usd: 0.01,
      latency_ms: 1_000,
    }],
  };
}

function evidence(id: string) {
  return {
    schema_version: "evidence-public-projection-v1",
    synthetic: true,
    source_hash: "d".repeat(64),
    evidence_id: id,
    kind: "benchmark",
    title: "Recorded run evidence · H-001 · Candidate A",
    case_id: "H-001",
    candidate_label: "Candidate A",
    source: "RECORDED BENCHMARK",
    status: "CONFIRMED FAIL",
    case_summary: "Synthetic customer asks for an action outside policy.",
    expected_decision: "Do not promise the action; escalate when required.",
    candidate_output: "The draft made an unsupported promise.",
    deterministic_checks: ["P0-HG-01 · CONFIRMED FAIL"],
    metadata: ["Immutable candidate execution"],
  };
}

function installApi() {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/workspace") return json(workspace());
    if (path === "/api/challenges/support-ai-selection") return json(challenge());
    if (path === `/api/benchmarks/${"d".repeat(64)}/progress`) return json(benchmark());
    if (path === "/api/reviews/review-01") return json(activeReviewerProjection());
    if (path.startsWith("/api/evidence/")) {
      return json(evidence(path.slice("/api/evidence/".length)));
    }
    return json({ error: "NOT_FOUND" }, 404);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("권위 artifact 기반 Define·Compare 라우트", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Define을 fixture fallback 없이 API의 Locked Challenge에서 렌더링한다", async () => {
    const fetcher = installApi();
    window.history.replaceState({}, "", "/?view=define");
    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "Turn a real business task into a private AI challenge.",
    })).toBeVisible();
    expect(screen.getByRole("heading", {
      name: "Select a support drafting configuration.",
    })).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/challenges/support-ai-selection",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
    expect(fetcher).not.toHaveBeenCalledWith(
      `/api/benchmarks/${"d".repeat(64)}/progress`,
      expect.anything(),
    );
    expect(screen.queryByRole("heading", { name: "Decide with evidence" })).not.toBeInTheDocument();
  });

  it("DRAFT lifecycle projection을 Define parser에 직접 통과시켜 렌더링한다", async () => {
    const lifecycleWorkspace = {
      ...workspace(),
      benchmark_id: null,
      source_hash: "e".repeat(64),
      stage_statuses: {
        define: "DRAFT",
        compare: "NOT READY",
        decide: "NOT READY",
        monitor: "NO BASELINE",
      },
    };
    const lifecycleChallenge = {
      schema_version: "challenge-public-projection-v1",
      synthetic: true,
      challenge_id: "support-ai-selection",
      challenge_version: "v1",
      source_hash: "e".repeat(64),
      state: "DRAFT",
      authority: "NONE",
      title: "Customer-support answer drafting and escalation",
      business_brief: {
        title: "Customer-support answer drafting and escalation",
        decision: "Select an AI configuration for customer-support agent assist.",
        workflow: "Draft a grounded answer and decide whether a support ticket needs escalation.",
        intended_users: ["Customer-support operations", "AI governance"],
        locale: "en-US",
      },
      constraints: [{
        constraint_id: "CONSTRAINT-POLICY-GROUNDING",
        text: "Use only approved synthetic policy and order sources.",
      }],
      prohibited_actions: [{
        prohibition_id: "PROHIBIT-UNSUPPORTED-PROMISE",
        text: "Do not promise actions that the evidence does not support.",
      }],
      source_manifest: {
        manifest_version: "define-source-manifest-v1",
        sources: [{
          source_id: "SOURCE-POLICY-CORPUS",
          source_type: "SYNTHETIC_POLICY_MANIFEST",
          title: "Synthetic support-policy manifest",
          content_sha256: "a".repeat(64),
          synthetic: true,
        }],
      },
      define_status: "NOT_STARTED",
      suggestion_summary: null,
      approved_contract_hash: null,
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/workspace") return json(lifecycleWorkspace);
      if (path === `/api/challenges/${lifecycleWorkspace.challenge_id}`) {
        return json(lifecycleChallenge);
      }
      return json({ error: "NOT_FOUND" }, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/?view=define");
    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "Structure the work before comparing AI systems.",
    })).toBeVisible();
    expect(screen.getAllByText("DRAFT").length).toBeGreaterThan(0);
    expect(screen.getByText(
      lifecycleChallenge.business_brief.title,
    )).toBeVisible();
    expect(screen.queryByRole("heading", {
      name: "Recorded evidence could not be validated.",
    })).not.toBeInTheDocument();
  });

  it("Compare의 실제 72-slot 셀에서 검증된 Evidence projection을 연다", async () => {
    const user = userEvent.setup();
    installApi();
    window.history.replaceState({}, "", "/?view=compare");
    render(<App />);

    const matrix = await screen.findByRole("table", {
      name: "12 hidden cases × 3 candidates × 2 fixed runs",
    });
    expect(within(matrix).getAllByRole("row")).toHaveLength(14);
    expect(screen.getByRole("region", { name: "Critical gate failures" })).toHaveTextContent(
      "Candidate A: 1 failed case",
    );

    await user.click(screen.getByRole("button", {
      name: "Open evidence for H-001, Candidate A, Run 1, GATE FAIL",
    }));
    expect(await screen.findByRole("dialog", {
      name: /Recorded run evidence · H-001 · Candidate A · Status CONFIRMED FAIL/,
    })).toBeVisible();
    expect(screen.getByText("The draft made an unsupported promise.")).toBeVisible();
  });

  it("RUNNING Compare는 source-confirmed progress만 750ms 고정 간격으로 재조회하고 unmount 뒤 중지한다", async () => {
    vi.useFakeTimers();
    try {
      const runningWorkspace = {
      ...workspace(),
      source_hash: "d".repeat(64),
      stage_statuses: {
        define: "LOCKED",
        compare: "RUNNING",
        decide: "NOT READY",
        monitor: "NO BASELINE",
      },
    };
      const fetcher = vi.fn(async (
        input: RequestInfo | URL,
        _init?: RequestInit,
      ) => {
      const path = String(input);
      if (path === "/api/workspace") return json(runningWorkspace);
      if (path === "/api/challenges/support-ai-selection") return json(challenge());
      if (path === `/api/benchmarks/${"d".repeat(64)}/progress`) {
        return json(runningBenchmark());
      }
      return json({ error: "NOT_FOUND" }, 404);
      });
      vi.stubGlobal("fetch", fetcher);
      window.history.replaceState({}, "", "/?view=compare");
      const rendered = render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByRole("heading", {
        name: "Follow persisted execution checkpoints.",
      })).toBeVisible();
      const progressPath = `/api/benchmarks/${"d".repeat(64)}/progress`;
      expect(fetcher.mock.calls.filter(([path]) => path === progressPath)).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(750);
      });
      expect(fetcher.mock.calls.filter(([path]) => path === progressPath)).toHaveLength(2);
      expect(fetcher.mock.calls.some(([, init]) => (
        (init as RequestInit | undefined)?.method === "POST"
      ))).toBe(false);

      rendered.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500);
      });
      expect(fetcher.mock.calls.filter(([path]) => path === progressPath)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("서버 projection이 깨지면 기존 recorded fixture를 대신 표시하지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/workspace") return json(workspace());
      return json({ ...challenge(), state: "DRAFT" });
    }));
    window.history.replaceState({}, "", "/?view=define");
    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "Recorded evidence could not be validated.",
    })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Decide with evidence" })).not.toBeInTheDocument();
    expect(screen.queryByText("Candidate B is the least complex sufficient configuration.")).not.toBeInTheDocument();
  });
});

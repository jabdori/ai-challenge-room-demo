import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type {
  DemoCandidateView,
  HackathonDemoState,
} from "../../shared/hackathonDemo";
import type {
  LiveDemoChallenge,
  LiveDemoExecution,
} from "../data/sitesDemoApi";

const api = vi.hoisted(() => ({
  getChallenge: vi.fn(),
  createLiveComparison: vi.fn(),
  runComparison: vi.fn(),
  getCurrentExecution: vi.fn(),
  getExecution: vi.fn(),
  getResults: vi.fn(),
  runJudge: vi.fn(),
  getEvidence: vi.fn(),
  confirmReviews: vi.fn(),
  selectCandidate: vi.fn(),
  createDecisionMemo: vi.fn(),
  replayRegression: vi.fn(),
  selectRecordedFallback: vi.fn(),
}));

const notifyAuthExpired = vi.hoisted(() => vi.fn());
const endSession = vi.hoisted(() => vi.fn());

vi.mock("../data/sitesDemoApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("../data/sitesDemoApi")>(),
  ...api,
}));

vi.mock("../features/access/JudgeAccessGate", async (importOriginal) => ({
  ...await importOriginal<typeof import("../features/access/JudgeAccessGate")>(),
  useJudgeSessionActions: () => ({
    ending: false,
    endSession,
    notifyAuthExpired,
  }),
}));

import { App } from "../App";
import { AuthExpiredError } from "../data/sitesDemoApi";

const CHALLENGE: LiveDemoChallenge = {
  schema_version: "live-demo-challenge-v1",
  synthetic: true,
  locked: true,
  case_id: "C-001",
  as_of: "2026-07-17T00:00:00Z",
  ticket: "Please cancel order ORD-1042 and refund me.",
  candidates: ["A", "B", "C"],
  runs_per_candidate: 1,
  external_action_statement:
    "No purchase, contract, deployment, or rollback was executed.",
};

function execution(
  overrides: Partial<LiveDemoExecution> = {},
): LiveDemoExecution {
  return {
    schema_version: "live-demo-execution-v1",
    execution_id: "cmp_live_demo_0001",
    source: "LIVE",
    status: "READY",
    progress_step: "READY",
    current_candidate: null,
    completed_candidate_count: 0,
    created_at_ms: 1_758_000_000_000,
    started_at_ms: null,
    heartbeat_at_ms: null,
    completed_at_ms: null,
    retry_count: 0,
    error_code: null,
    cleanup_status: "NOT_STARTED",
    actual_cost_micro_usd: 0,
    artifacts: {
      evaluation_pack_persisted: false,
      public_projection_persisted: false,
      cleanup_receipt_persisted: false,
    },
    ...overrides,
  };
}

function candidate(
  candidateId: "A" | "B" | "C",
  source: HackathonDemoState["source"],
  totalCostUsd: number,
  totalLatencyMs: number,
  hardGateStatus: "PASS" | "CONFIRMED_FAIL" = "PASS",
): DemoCandidateView {
  const repetitions = source === "LIVE_SYNTHETIC_DEMO"
    ? [1] as const
    : [1, 2] as const;
  const totalRuns = repetitions.length as 1 | 2;
  return {
    candidate_id: candidateId,
    architecture: candidateId === "A"
      ? "Single LLM"
      : candidateId === "B"
        ? "Retrieval RAG"
        : "Read-only tool agent",
    complexity_tier: candidateId === "A" ? "T1" : candidateId === "B" ? "T2" : "T3",
    hard_gate: {
      passed_runs: hardGateStatus === "PASS" ? totalRuns : 0,
      total_runs: totalRuns,
      status: hardGateStatus,
    },
    quality: {
      complete_outputs: totalRuns,
      active_policy_citations: totalRuns,
      stability: source === "LIVE_SYNTHETIC_DEMO"
        ? "SINGLE_RUN_NOT_MEASURED"
        : "STABLE",
      stable_decisions: source === "LIVE_SYNTHETIC_DEMO" ? null : true,
    },
    total_cost_usd: totalCostUsd,
    mean_cost_usd: totalCostUsd / totalRuns,
    total_latency_ms: totalLatencyMs,
    mean_latency_ms: totalLatencyMs / totalRuns,
    provider_calls: candidateId === "C" ? 3 * totalRuns : totalRuns,
    retrieval_calls: candidateId === "A" ? 0 : totalRuns,
    tool_calls: candidateId === "C" ? 2 * totalRuns : 0,
    runs: repetitions.map((repetition) => ({
      evidence_id: `demo-${candidateId.toLowerCase()}-${repetition}`,
      repetition,
      execution_status: "COMPLETE" as const,
      hard_gate_status: hardGateStatus,
      latency_ms: totalLatencyMs / totalRuns,
      cost_usd: totalCostUsd / totalRuns,
      customer_reply: `${source === "LIVE_SYNTHETIC_DEMO" ? "Live" : "Recorded"} reply ${candidateId}-${repetition}`,
      action_code: "DENY_CANCEL_AFTER_SHIPMENT",
      escalation_required: false,
      citations: ["CANCEL-2026 §2.2"],
    })) as unknown as DemoCandidateView["runs"],
  };
}

function state(
  source: HackathonDemoState["source"],
  overrides: Partial<HackathonDemoState> = {},
): HackathonDemoState {
  const candidates = [
    candidate("A", source, 0.0039, 1_642),
    candidate("B", source, 0.0054, 2_921),
    candidate("C", source, 0.0111, 4_913),
  ] as const;
  const repetitions = source === "LIVE_SYNTHETIC_DEMO"
    ? [1] as const
    : [1, 2] as const;
  return {
    schema_version: "hackathon-demo-state-v1",
    synthetic: true,
    source,
    status: "JUDGE_REQUIRED",
    canary: {
      pack_id: source === "LIVE_SYNTHETIC_DEMO"
        ? "live-pack-1d0d4af2c4428cb6"
        : "calibration-pack-1d0d4af2c4428cb6",
      pack_hash: "a".repeat(64),
      artifact_kind: source === "LIVE_SYNTHETIC_DEMO"
        ? "LIVE_DEMO_EVALUATION_PACK"
        : "PARTIAL_CALIBRATION_PACK",
      evaluation_status: "EVALUATION_INCOMPLETE",
      case_id: "C-001",
      ticket: CHALLENGE.ticket,
      as_of: CHALLENGE.as_of,
      total_cost_usd: candidates.reduce(
        (total, item) => total + item.total_cost_usd,
        0,
      ),
      candidates,
    },
    judge: null,
    blind_review: {
      case_id: "C-001",
      candidates: (["X", "Y", "Z"] as const).map((blindLabel) => ({
        blind_label: blindLabel,
        runs: repetitions.map((repetition) => ({
          repetition,
          customer_reply: `Blind ${blindLabel} reply ${repetition}`,
          citations: ["CANCEL-2026 §2.2"],
        })),
      })) as unknown as HackathonDemoState["blind_review"]["candidates"],
    },
    human_review: null,
    eligible_candidate_ids: [],
    selection: null,
    memo: null,
    regression: null,
    ...overrides,
  };
}

function judgeReady(
  source: HackathonDemoState["source"],
): HackathonDemoState {
  return state(source, {
    status: "REVIEW_REQUIRED",
    judge: {
      status: "COMPLETE",
      authority: "RISK_ONLY_REVIEW_REQUIRED",
      model_reported_id: "gpt-5.6-sol",
      latency_ms: 1_200,
      risks: [
        { blind_label: "X", status: "NO_RISK", failure_types: [] },
        { blind_label: "Y", status: "NO_RISK", failure_types: [] },
        { blind_label: "Z", status: "RISK", failure_types: ["CITATION_NOT_RELEVANT"] },
      ],
    },
  });
}

function reviewed(
  source: HackathonDemoState["source"],
): HackathonDemoState {
  const base = judgeReady(source);
  return state(source, {
    status: "DECISION_REQUIRED",
    judge: base.judge,
    human_review: {
      status: "COMPLETE",
      reviewer: "Demo decision owner",
      rationale: "All blinded drafts stay within the active-policy boundary.",
      review_time: "NOT_MEASURED",
      edit_time: "NOT_MEASURED",
      decisions: [
        { blind_label: "X", decision: "PASS" },
        { blind_label: "Y", decision: "PASS" },
        { blind_label: "Z", decision: "PASS" },
      ],
    },
    eligible_candidate_ids: ["A", "B", "C"],
  });
}

function selected(
  source: HackathonDemoState["source"],
): HackathonDemoState {
  const base = reviewed(source);
  return state(source, {
    status: "SELECTION_RECORDED",
    judge: base.judge,
    human_review: base.human_review,
    eligible_candidate_ids: base.eligible_candidate_ids,
    selection: {
      candidate_id: "A",
      rationale:
        "Candidate A is the simplest configuration sufficient for this bounded demo.",
    },
  });
}

function memoReady(
  source: HackathonDemoState["source"],
): HackathonDemoState {
  const base = selected(source);
  return state(source, {
    status: "MEMO_READY",
    judge: base.judge,
    human_review: base.human_review,
    eligible_candidate_ids: base.eligible_candidate_ids,
    selection: base.selection,
    memo: {
      status: "COMPLETE",
      model_reported_id: "gpt-5.6-sol",
      latency_ms: 1_420,
      decision: "Use Candidate A for the next controlled PoC.",
      evidence_basis: [
        "Candidate A passed the deterministic hard gate.",
        "Actual cost and latency remain visible.",
      ],
      trade_offs: "Candidate A is the least complex eligible option.",
      limitations: "One synthetic ticket does not establish production superiority.",
      next_step: "Run a broader private evaluation before procurement or deployment.",
      external_action_statement:
        "No purchase, contract, deployment, or rollback was executed.",
      error_code: null,
    },
  });
}

function memoFailed(
  source: HackathonDemoState["source"],
): HackathonDemoState {
  const base = selected(source);
  return state(source, {
    status: "MEMO_FAILED",
    judge: base.judge,
    human_review: base.human_review,
    eligible_candidate_ids: base.eligible_candidate_ids,
    selection: base.selection,
    memo: {
      status: "FAILED",
      model_reported_id: "gpt-5.6-sol",
      latency_ms: 1_420,
      decision: "",
      evidence_basis: [],
      trade_offs: "",
      limitations: "",
      next_step: "",
      external_action_statement:
        "No purchase, contract, deployment, or rollback was executed.",
      error_code: "BASELINE_NOT_CREATED",
    },
  });
}

function blocked(
  source: HackathonDemoState["source"],
): HackathonDemoState {
  const base = memoReady(source);
  return state(source, {
    status: "BLOCK",
    judge: base.judge,
    human_review: base.human_review,
    eligible_candidate_ids: base.eligible_candidate_ids,
    selection: base.selection,
    memo: base.memo,
    regression: {
      status: "BLOCK",
      recorded_decision_label: "Candidate A · synthetic demo decision",
      proposed_label: "Candidate A · representative defective change",
      new_hard_gate_failures: [
        "FORBIDDEN_ACTION",
        "INACTIVE_POLICY_CITATION",
      ],
      proposed_reply:
        "I used the retired policy and issued a refund for your shipped order.",
      recorded_decision_remains_unchanged: true,
      external_action_statement:
        "No external deployment or rollback was executed.",
    },
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  return {
    promise: new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    }),
    resolve,
    reject,
  };
}

describe("호스팅 해커톤 데모 작업공간(hosted hackathon demo workspace)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.history.replaceState({}, "", "/?view=demo&demoStage=define");
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    api.getChallenge.mockResolvedValue(CHALLENGE);
    api.getCurrentExecution.mockResolvedValue(null);
    api.getExecution.mockResolvedValue(execution({
      status: "RESULTS_READY",
      progress_step: "RESULTS_READY",
      completed_candidate_count: 3,
      cleanup_status: "ACKNOWLEDGED",
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("잠긴 Challenge를 복원하고 live 실행과 recorded fallback을 명시적으로 분리한다", async () => {
    render(<App />);

    expect(await screen.findByText(CHALLENGE.ticket)).toBeVisible();
    expect(screen.getByTestId("locked-challenge-details")).toHaveClass(
      "demo-challenge-details",
    );
    expect(screen.getByRole("button", { name: "Run live comparison" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Use recorded demo" })).toBeEnabled();
    const endSessionButton = screen.getByRole("button", {
      name: "End judge session",
    });
    expect(endSessionButton).toBeVisible();
    expect(endSessionButton).toHaveClass("button--compact");
    expect(api.createLiveComparison).not.toHaveBeenCalled();
    expect(api.selectRecordedFallback).not.toHaveBeenCalled();
  });

  it("라이브 A/B/C 장기 요청과 polling 동안 단계·후보·완료수·경과시간·재시도·정리를 표시하고 terminal 뒤에만 결과를 읽는다", async () => {
    const runningRequest = deferred<LiveDemoExecution>();
    const ready = execution();
    const retrieving = execution({
      status: "RUNNING",
      progress_step: "CANDIDATE_B_RETRIEVAL_STARTED",
      current_candidate: "B",
      completed_candidate_count: 1,
      started_at_ms: ready.created_at_ms,
      heartbeat_at_ms: ready.created_at_ms + 2_000,
      retry_count: 1,
      actual_cost_micro_usd: 3_900,
    });
    const complete = execution({
      status: "RESULTS_READY",
      progress_step: "RESULTS_READY",
      completed_candidate_count: 3,
      started_at_ms: ready.created_at_ms,
      heartbeat_at_ms: ready.created_at_ms + 8_000,
      completed_at_ms: ready.created_at_ms + 8_000,
      retry_count: 1,
      cleanup_status: "ACKNOWLEDGED",
      actual_cost_micro_usd: 20_400,
      artifacts: {
        evaluation_pack_persisted: true,
        public_projection_persisted: true,
        cleanup_receipt_persisted: true,
      },
    });
    api.createLiveComparison.mockResolvedValue(ready);
    api.runComparison.mockReturnValue(runningRequest.promise);
    api.getExecution
      .mockResolvedValueOnce(retrieving)
      .mockResolvedValueOnce(complete);
    api.getResults.mockResolvedValue(state("LIVE_SYNTHETIC_DEMO"));

    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(CHALLENGE.ticket);
    await user.click(screen.getByRole("button", { name: "Run live comparison" }));

    await waitFor(() => expect(screen.getByRole("status", {
      name: "Live comparison progress",
    })).toHaveTextContent("Candidate B policy retrieval"));
    expect(screen.getByRole("status", {
      name: "Live comparison progress",
    }).closest(".section-panel")).toHaveClass("define-work-input-panel");
    expect(screen.getByText("1 / 3 candidates complete")).toBeVisible();
    expect(screen.getByText("Retry 1")).toBeVisible();
    expect(screen.getByText(/Elapsed/)).toBeVisible();
    expect(screen.getByText("Cleanup not started")).toBeVisible();
    expect(api.getResults).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", {
      name: "Live comparison running…",
    })).not.toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Start new comparison",
    })).toBeDisabled();

    expect(await screen.findByRole("heading", {
      name: "Compare one real support task under the same boundary",
    }, { timeout: 3_000 })).toBeVisible();
    expect(screen.getAllByText("LIVE SYNTHETIC DEMO").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Single run · not measured")).toHaveLength(3);
    expect(screen.getAllByText("1 / 1 PASS")).toHaveLength(3);
    expect(api.getResults).toHaveBeenCalledTimes(1);
    expect(api.runComparison).toHaveBeenCalledTimes(1);
    runningRequest.resolve(complete);
  });

  it("비교 지표를 설명하고 보조 Judge를 통과 판정이 아닌 중립 신호로 표시한다", async () => {
    api.getCurrentExecution.mockResolvedValue(execution({
      status: "JUDGE_READY",
      progress_step: "JUDGE_READY",
      completed_candidate_count: 3,
      cleanup_status: "ACKNOWLEDGED",
    }));
    api.getResults.mockResolvedValue(judgeReady("LIVE_SYNTHETIC_DEMO"));
    window.history.replaceState({}, "", "/?view=demo&demoStage=compare");

    render(<App />);

    const comparison = await screen.findByRole("region", {
      name: "Candidate comparison measurements",
    });
    expect(within(comparison).getByText("What was measured")).toBeVisible();
    expect(screen.getByText(
      "Hard gates exclude fatal failures first. The remaining measures show trade-offs; they do not produce an automatic winner.",
    )).toBeVisible();
    expect(screen.getByText("How to read this comparison")).toBeVisible();
    expect(screen.getByText(/T1.*Single LLM/)).toBeInTheDocument();
    expect(within(comparison).getAllByText(
      "Complete answer 1/1 · Current-policy citation 1/1",
    )).toHaveLength(3);
    expect(within(comparison).getByText(
      "Model 3 · Policy search 1 · Tool 2",
    )).toBeVisible();

    expect(screen.getByText(
      "No additional signal is not a pass. Deterministic hard-gate findings above remain authoritative.",
    )).toBeVisible();
    expect(screen.getAllByText("NO ADDITIONAL SIGNAL")).toHaveLength(2);
    expect(screen.getByText("ADDITIONAL REVIEW SIGNAL")).toBeVisible();
    expect(screen.getByText("Citation may not be relevant")).toBeVisible();
    expect(screen.getByText("CITATION_NOT_RELEVANT")).toBeVisible();
    expect(
      screen.getByText("AUXILIARY REVIEW COMPLETE").closest(".status-badge"),
    ).toHaveClass("status-badge--neutral");
    expect(screen.getByText(
      "BOUNDED DEMO EVIDENCE · NOT A BENCHMARK",
    )).toBeVisible();
  });

  it("추가 Judge 신호가 없어도 결정적 hard-gate 실패를 그대로 유지한다", async () => {
    const base = judgeReady("LIVE_SYNTHETIC_DEMO");
    const mixed = state("LIVE_SYNTHETIC_DEMO", {
      status: "REVIEW_REQUIRED",
      canary: {
        ...base.canary,
        candidates: [
          candidate(
            "A",
            "LIVE_SYNTHETIC_DEMO",
            0.0039,
            1_642,
            "CONFIRMED_FAIL",
          ),
          candidate("B", "LIVE_SYNTHETIC_DEMO", 0.0054, 2_921),
          candidate("C", "LIVE_SYNTHETIC_DEMO", 0.0111, 4_913),
        ],
      },
      judge: {
        ...base.judge!,
        risks: [
          { blind_label: "X", status: "NO_RISK", failure_types: [] },
          { blind_label: "Y", status: "NO_RISK", failure_types: [] },
          { blind_label: "Z", status: "NO_RISK", failure_types: [] },
        ],
      },
    });
    api.getCurrentExecution.mockResolvedValue(execution({
      status: "JUDGE_READY",
      progress_step: "JUDGE_READY",
      completed_candidate_count: 3,
      cleanup_status: "ACKNOWLEDGED",
    }));
    api.getResults.mockResolvedValue(mixed);
    window.history.replaceState({}, "", "/?view=demo&demoStage=compare");

    render(<App />);

    expect(await screen.findByText("0 / 1 CONFIRMED_FAIL")).toBeVisible();
    expect(screen.getAllByText("NO ADDITIONAL SIGNAL")).toHaveLength(3);
    expect(screen.getByText(
      "No additional signal is not a pass. Deterministic hard-gate findings above remain authoritative.",
    )).toBeVisible();
  });

  it("사람 PASS 뒤에도 hard-gate 실패 후보를 선택지에서 제외한다", async () => {
    const base = reviewed("LIVE_SYNTHETIC_DEMO");
    const constrained = state("LIVE_SYNTHETIC_DEMO", {
      status: "DECISION_REQUIRED",
      canary: {
        ...base.canary,
        candidates: [
          candidate(
            "A",
            "LIVE_SYNTHETIC_DEMO",
            0.0039,
            1_642,
            "CONFIRMED_FAIL",
          ),
          candidate("B", "LIVE_SYNTHETIC_DEMO", 0.0054, 2_921),
          candidate("C", "LIVE_SYNTHETIC_DEMO", 0.0111, 4_913),
        ],
      },
      judge: base.judge,
      human_review: base.human_review,
      eligible_candidate_ids: ["B", "C"],
    });
    api.getCurrentExecution.mockResolvedValue(execution({
      status: "REVIEW_READY",
      progress_step: "REVIEW_READY",
      completed_candidate_count: 3,
      cleanup_status: "ACKNOWLEDGED",
    }));
    api.getResults.mockResolvedValue(constrained);
    window.history.replaceState({}, "", "/?view=demo&demoStage=decide");

    render(<App />);

    expect(await screen.findByRole("radio", { name: /Candidate B/ }))
      .toBeEnabled();
    expect(screen.getByRole("radio", { name: /Candidate C/ })).toBeEnabled();
    expect(screen.queryByRole("radio", { name: /Candidate A/ }))
      .not.toBeInTheDocument();
  });

  it("블라인드 검수에 잠긴 기준과 근거 작성 지침을 제공한다", async () => {
    api.getCurrentExecution.mockResolvedValue(execution({
      status: "JUDGE_READY",
      progress_step: "JUDGE_READY",
      completed_candidate_count: 3,
      cleanup_status: "ACKNOWLEDGED",
    }));
    api.getResults.mockResolvedValue(judgeReady("LIVE_SYNTHETIC_DEMO"));
    window.history.replaceState({}, "", "/?view=demo&demoStage=compare");

    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", {
      name: "Open blind human review",
    }));

    const review = screen.getByRole("region", {
      name: "Blind review · C-001",
    });
    const lockedBoundary = within(review).getByText(/already shipped/);
    expect(lockedBoundary).toBeVisible();
    expect(lockedBoundary).toHaveTextContent("CANCEL-2026 §2.2");
    expect(within(review).getAllByText(
      /A human PASS does not override a deterministic hard-gate failure/,
    ).length).toBeGreaterThan(0);
    expect(within(review).getByRole("radio", {
      name: "Candidate X PASS",
    })).toHaveAccessibleDescription(
      "No locked action, policy, citation, or promise failure was found in the reviewed response.",
    );
    expect(within(review).getByRole("radio", {
      name: "Candidate X CONFIRMED FAIL",
    })).toHaveAccessibleDescription(
      "One or more locked fatal failures are supported by the response or evidence.",
    );

    const rationale = within(review).getByLabelText(
      "Why did you mark X, Y, and Z this way?",
    );
    expect(rationale).toBeRequired();
    expect(rationale).toHaveAccessibleDescription(
      "Mention X, Y, and Z and cite the reply, active policy, citation, or unsupported promise that supports each decision. Do not infer the hidden architecture.",
    );
    expect(within(review).getByRole("button", {
      name: "Complete blind review",
    })).toBeDisabled();
  });

  it("Evidence dialog가 초점을 가두고 Escape 뒤 호출 버튼으로 복귀한다", async () => {
    api.getCurrentExecution.mockResolvedValue(execution({
      status: "RESULTS_READY",
      progress_step: "RESULTS_READY",
      completed_candidate_count: 3,
      cleanup_status: "ACKNOWLEDGED",
    }));
    api.getResults.mockResolvedValue(state("LIVE_SYNTHETIC_DEMO"));
    window.history.replaceState({}, "", "/?view=demo&demoStage=compare");

    const user = userEvent.setup();
    render(<App />);
    const opener = await screen.findByRole("button", {
      name: "Open Candidate A run 1 evidence",
    });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", {
      name: /Candidate A · Run 1/,
    });
    const close = within(dialog).getByRole("button", {
      name: "Close evidence",
    });
    await waitFor(() => expect(close).toHaveFocus());
    expect(document.getElementById("app-shell-root")).toHaveProperty(
      "inert",
      true,
    );

    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(document.getElementById("app-shell-root")).toHaveProperty(
      "inert",
      false,
    );
  });

  it("기록 데모는 사용자 선택으로만 열고 live 결과와 섞지 않는다", async () => {
    const recordedExecution = execution({
      execution_id: "cmp_recorded_demo_0001",
      source: "RECORDED_FALLBACK",
      status: "RESULTS_READY",
      progress_step: "RECORDED_FALLBACK_READY",
      completed_candidate_count: 3,
      completed_at_ms: 1_758_000_001_000,
    });
    api.selectRecordedFallback.mockResolvedValue({
      execution: recordedExecution,
      state: state("RECORDED_FALLBACK"),
    });

    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(CHALLENGE.ticket);
    await user.click(screen.getByRole("button", { name: "Use recorded demo" }));

    expect((await screen.findAllByText("RECORDED FALLBACK"))[0]).toBeVisible();
    expect(screen.getByText("C-001 · 1 synthetic ticket · 6 runs")).toBeVisible();
    expect(screen.queryByText("LIVE SYNTHETIC DEMO")).not.toBeInTheDocument();
    expect(api.createLiveComparison).not.toHaveBeenCalled();
    expect(api.runComparison).not.toHaveBeenCalled();

    const confirm = vi.spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const startNewComparison = screen.getByRole("button", {
      name: "Start new comparison",
    });
    await user.click(startNewComparison);
    expect(endSession).not.toHaveBeenCalled();
    await user.click(startNewComparison);
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(
      /current execution.*preserved.*access code/iu,
    ));
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  it("RUNNING 상태에 플랫폼 오류 증거가 있으면 실행 중으로 위장하지 않고 명시적 recorded fallback만 허용한다", async () => {
    api.getCurrentExecution.mockResolvedValue(execution({
      status: "RUNNING",
      progress_step: "FAILED_PLATFORM_UNRECONCILED",
      current_candidate: null,
      started_at_ms: 1_758_000_000_000,
      heartbeat_at_ms: 1_758_000_004_000,
      error_code: "FAILED_PLATFORM",
      cleanup_status: "FAILED",
      actual_cost_micro_usd: 3_900,
    }));

    render(<App />);

    const stopped = await screen.findByRole("alert", {
      name: "Live comparison progress",
    });
    expect(stopped).toHaveTextContent("LIVE COMPARISON STOPPED");
    expect(stopped).toHaveTextContent("FAILED_PLATFORM");
    expect(screen.getByRole("button", {
      name: "Run live comparison",
    })).toBeDisabled();
    expect(screen.getByRole("button", {
      name: "Use recorded demo",
    })).toBeEnabled();
    expect(api.getExecution).not.toHaveBeenCalled();
    expect(api.selectRecordedFallback).not.toHaveBeenCalled();
  });

  it("새로고침에서 JUDGE_RUNNING을 복원하고 완료 revision의 최신 snapshot을 다시 읽는다", async () => {
    const judgePoll = deferred<LiveDemoExecution>();
    api.getCurrentExecution.mockResolvedValue(execution({
      status: "RESULTS_READY",
      progress_step: "JUDGE_RUNNING",
      completed_candidate_count: 3,
      cleanup_status: "ACKNOWLEDGED",
    }));
    api.getExecution.mockReturnValue(judgePoll.promise);
    api.getResults
      .mockResolvedValueOnce(state("LIVE_SYNTHETIC_DEMO"))
      .mockResolvedValueOnce(judgeReady("LIVE_SYNTHETIC_DEMO"));
    window.history.replaceState({}, "", "/?view=demo&demoStage=compare");

    render(<App />);

    expect(await screen.findByRole("status", {
      name: "GPT-5.6 Judge progress",
    })).toHaveTextContent("Deterministic gates remain authoritative");
    const judgeProgress = screen.getByRole("status", {
      name: "GPT-5.6 Judge progress",
    });
    expect(judgeProgress).toHaveTextContent("may take some time");
    expect(judgeProgress).not.toHaveTextContent(/minute/i);
    expect(screen.queryByRole("button", {
      name: "Waiting for GPT-5.6 risk signals",
    })).not.toBeInTheDocument();

    judgePoll.resolve(execution({
      status: "JUDGE_READY",
      progress_step: "JUDGE_READY",
      completed_candidate_count: 3,
      cleanup_status: "ACKNOWLEDGED",
    }));

    expect(await screen.findByRole("button", {
      name: "Open blind human review",
    })).toBeEnabled();
    expect(api.getResults).toHaveBeenCalledTimes(2);
  });

  it("새로고침에서 MEMO_RUNNING을 복원하고 완료 revision의 실제 Memo snapshot을 다시 읽는다", async () => {
    const memoPoll = deferred<LiveDemoExecution>();
    api.getCurrentExecution.mockResolvedValue(execution({
      status: "MEMO_RUNNING",
      progress_step: "MEMO_RUNNING",
      completed_candidate_count: 3,
      cleanup_status: "ACKNOWLEDGED",
    }));
    api.getExecution.mockReturnValue(memoPoll.promise);
    api.getResults
      .mockResolvedValueOnce(selected("LIVE_SYNTHETIC_DEMO"))
      .mockResolvedValueOnce(memoReady("LIVE_SYNTHETIC_DEMO"));
    window.history.replaceState({}, "", "/?view=demo&demoStage=decide");

    render(<App />);

    expect(await screen.findByRole("status", {
      name: "GPT-5.6 Decision Memo progress",
    })).toHaveTextContent("recorded human selection remains unchanged");
    const memoProgress = screen.getByRole("status", {
      name: "GPT-5.6 Decision Memo progress",
    });
    expect(memoProgress).toHaveTextContent("may take some time");
    expect(screen.queryByRole("button", {
      name: "Waiting for GPT-5.6 Decision Memo",
    })).not.toBeInTheDocument();

    memoPoll.resolve(execution({
      status: "MEMO_READY",
      progress_step: "MEMO_READY",
      completed_candidate_count: 3,
      cleanup_status: "ACKNOWLEDGED",
    }));

    expect(await screen.findByText(
      "Use Candidate A for the next controlled PoC.",
    )).toBeVisible();
    expect(api.getResults).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["JUDGE_FAILED", "GPT-5.6 Judge did not complete", true],
    ["JUDGE_FAILED_FINAL", "GPT-5.6 Judge retry limit reached", false],
  ] as const)(
    "%s hydration은 결정적 gate를 유지한 persistent Judge 오류로 표시한다",
    async (progressStep, message, retryAvailable) => {
      api.getCurrentExecution.mockResolvedValue(execution({
        status: "RESULTS_READY",
        progress_step: progressStep,
        completed_candidate_count: 3,
        cleanup_status: "ACKNOWLEDGED",
      }));
      api.getResults.mockResolvedValue(state("LIVE_SYNTHETIC_DEMO"));
      window.history.replaceState({}, "", "/?view=demo&demoStage=compare");

      render(<App />);

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(screen.getAllByText("1 / 1 PASS")).toHaveLength(3);
      if (retryAvailable) {
        expect(screen.getByRole("button", {
          name: "Retry GPT-5.6 auxiliary risk check",
        })).toBeEnabled();
      } else {
        expect(screen.queryByRole("button", {
          name: /GPT-5.6 auxiliary risk check/,
        })).not.toBeInTheDocument();
      }
      expect(api.getExecution).not.toHaveBeenCalled();
    },
  );

  it("Judge transport failure 뒤 권위 execution을 재조정하고 server pending부터 terminal failure까지 추적한다", async () => {
    const judgePoll = deferred<LiveDemoExecution>();
    api.getCurrentExecution.mockResolvedValue(execution({
      status: "RESULTS_READY",
      progress_step: "RESULTS_READY",
      completed_candidate_count: 3,
      cleanup_status: "ACKNOWLEDGED",
    }));
    api.getResults.mockResolvedValue(state("LIVE_SYNTHETIC_DEMO"));
    api.runJudge.mockRejectedValue(new Error("transport ended"));
    api.getExecution
      .mockResolvedValueOnce(execution({
        status: "RESULTS_READY",
        progress_step: "JUDGE_RUNNING",
        completed_candidate_count: 3,
        cleanup_status: "ACKNOWLEDGED",
      }))
      .mockReturnValueOnce(judgePoll.promise);
    window.history.replaceState({}, "", "/?view=demo&demoStage=compare");

    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", {
      name: "Run GPT-5.6 auxiliary risk check",
    }));

    expect(await screen.findByRole("status", {
      name: "GPT-5.6 Judge progress",
    })).toBeVisible();
    expect(screen.queryByRole("button", {
      name: "Waiting for GPT-5.6 risk signals",
    })).not.toBeInTheDocument();

    judgePoll.resolve(execution({
      status: "RESULTS_READY",
      progress_step: "JUDGE_FAILED",
      completed_candidate_count: 3,
      cleanup_status: "ACKNOWLEDGED",
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "GPT-5.6 Judge did not complete",
    );
    expect(api.getExecution).toHaveBeenCalledTimes(2);
  });

  it("Memo transport failure 뒤 권위 MEMO_RUNNING을 복원하고 terminal failure snapshot을 투영한다", async () => {
    const memoPoll = deferred<LiveDemoExecution>();
    api.getCurrentExecution.mockResolvedValue(execution({
      status: "SELECTION_RECORDED",
      progress_step: "SELECTION_RECORDED",
      completed_candidate_count: 3,
      cleanup_status: "ACKNOWLEDGED",
    }));
    api.getResults
      .mockResolvedValueOnce(selected("LIVE_SYNTHETIC_DEMO"))
      .mockResolvedValueOnce(selected("LIVE_SYNTHETIC_DEMO"))
      .mockResolvedValueOnce(memoFailed("LIVE_SYNTHETIC_DEMO"));
    api.createDecisionMemo.mockRejectedValue(new Error("transport ended"));
    api.getExecution
      .mockResolvedValueOnce(execution({
        status: "MEMO_RUNNING",
        progress_step: "MEMO_RUNNING",
        completed_candidate_count: 3,
        cleanup_status: "ACKNOWLEDGED",
      }))
      .mockReturnValueOnce(memoPoll.promise);
    window.history.replaceState({}, "", "/?view=demo&demoStage=decide");

    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", {
      name: "Generate GPT-5.6 Decision Memo",
    }));

    expect(await screen.findByRole("status", {
      name: "GPT-5.6 Decision Memo progress",
    })).toBeVisible();
    expect(screen.queryByRole("button", {
      name: "Waiting for GPT-5.6 Decision Memo",
    })).not.toBeInTheDocument();

    memoPoll.resolve(execution({
      status: "MEMO_FAILED",
      progress_step:
        "MEMO_FAILED_RETRY_AVAILABLE_SELECTION_PRESERVED_NO_BASELINE_CREATED",
      completed_candidate_count: 3,
      cleanup_status: "ACKNOWLEDGED",
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Decision Memo could not be generated",
    );
    expect(screen.getByRole("button", {
      name: "Retry GPT-5.6 Decision Memo",
    })).toBeEnabled();
    expect(api.getExecution).toHaveBeenCalledTimes(2);
  });

  it("Judge 대기→블라인드 review→별도 사람 selection→Memo 실패 재시도→BLOCK을 실제 상태로 연결한다", async () => {
    const initial = state("LIVE_SYNTHETIC_DEMO");
    api.getCurrentExecution.mockResolvedValue(execution({
      status: "RESULTS_READY",
      progress_step: "RESULTS_READY",
      completed_candidate_count: 3,
      cleanup_status: "ACKNOWLEDGED",
    }));
    api.getResults.mockResolvedValue(initial);
    const judgeRequest = deferred<HackathonDemoState>();
    api.runJudge.mockReturnValue(judgeRequest.promise);
    api.confirmReviews.mockResolvedValue(reviewed("LIVE_SYNTHETIC_DEMO"));
    api.selectCandidate.mockResolvedValue(selected("LIVE_SYNTHETIC_DEMO"));
    api.createDecisionMemo
      .mockRejectedValueOnce(new Error("memo provider unavailable"))
      .mockResolvedValueOnce(memoReady("LIVE_SYNTHETIC_DEMO"));
    api.replayRegression.mockResolvedValue(blocked("LIVE_SYNTHETIC_DEMO"));

    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?view=demo&demoStage=compare");
    render(<App />);
    await screen.findByRole("button", {
      name: "Run GPT-5.6 auxiliary risk check",
    });
    await user.click(screen.getByRole("button", {
      name: "Run GPT-5.6 auxiliary risk check",
    }));

    expect(screen.getByRole("status", {
      name: "GPT-5.6 Judge progress",
    })).toHaveTextContent("Deterministic gates remain authoritative");
    judgeRequest.resolve(judgeReady("LIVE_SYNTHETIC_DEMO"));

    const riskGrid = await screen.findByTestId("demo-risk-grid");
    const riskCards = riskGrid.querySelectorAll(".demo-risk-card");
    expect(riskCards).toHaveLength(3);
    for (const card of riskCards) {
      expect(card.querySelector(".demo-risk-card__title")).not.toBeNull();
      expect(card.querySelector(".demo-risk-card__signal")).not.toBeNull();
      expect(card.querySelector(".demo-risk-card__findings")).not.toBeNull();
    }

    await user.click(await screen.findByRole("button", {
      name: "Open blind human review",
    }));
    const review = screen.getByRole("region", {
      name: "Blind review · C-001",
    });
    expect(within(review).getByText("Candidate X")).toBeVisible();
    const blindCards = review.querySelectorAll(".demo-blind-card");
    expect(blindCards).toHaveLength(3);
    for (const card of blindCards) {
      expect(card.querySelector(".demo-blind-card__runs")).not.toBeNull();
    }
    expect(within(review).queryByText(
      /Single LLM|Retrieval RAG|tool agent/,
    )).not.toBeInTheDocument();
    expect(within(review).queryByLabelText(
      "Human correction time in seconds",
    )).not.toBeInTheDocument();
    for (const label of ["X", "Y", "Z"] as const) {
      await user.click(within(review).getByRole("radio", {
        name: `Candidate ${label} PASS`,
      }));
    }
    await user.type(
      within(review).getByLabelText(
        "Why did you mark X, Y, and Z this way?",
      ),
      "All blinded drafts stay within the active-policy boundary.",
    );
    await user.click(within(review).getByRole("button", {
      name: "Complete blind review",
    }));
    expect(api.confirmReviews).toHaveBeenCalledWith(
      "cmp_live_demo_0001",
      {
        reviewer: "Demo decision owner",
        rationale: "All blinded drafts stay within the active-policy boundary.",
        decisions: [
          { blind_label: "X", decision: "PASS" },
          { blind_label: "Y", decision: "PASS" },
          { blind_label: "Z", decision: "PASS" },
        ],
      },
    );
    expect(await screen.findByText(/Human review time · NOT_MEASURED/))
      .toBeVisible();
    expect(screen.getByText(/Human edit time · NOT_MEASURED/)).toBeVisible();
    await user.click(await screen.findByRole("button", {
      name: "Continue to human decision",
    }));
    expect(window.scrollTo).toHaveBeenLastCalledWith({
      top: 0,
      behavior: "smooth",
    });

    await user.click(screen.getByRole("radio", { name: /Candidate A/ }));
    const decisionRationale = screen.getByLabelText(
      "Why are you selecting this eligible candidate?",
    );
    expect(decisionRationale).toHaveAttribute("rows", "3");
    expect(decisionRationale).toHaveAccessibleDescription(
      "Explain why this candidate is sufficient for the locked task and which cost, latency, or complexity trade-off you accept.",
    );
    expect(decisionRationale.closest("label")).toHaveClass(
      "decision-rationale-field",
    );
    await user.type(
      decisionRationale,
      "Candidate A is the simplest configuration sufficient for this bounded demo.",
    );
    await user.click(screen.getByRole("button", {
      name: "Record human candidate selection",
    }));
    expect(api.selectCandidate).toHaveBeenCalledTimes(1);
    expect(api.createDecisionMemo).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", {
      name: "Generate GPT-5.6 Decision Memo",
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Decision Memo could not be generated",
    );
    expect(screen.getByText("Human selection recorded · Candidate A")).toBeVisible();
    expect(screen.getByRole("button", {
      name: "Retry GPT-5.6 Decision Memo",
    })).toBeEnabled();

    await user.click(screen.getByRole("button", {
      name: "Retry GPT-5.6 Decision Memo",
    }));
    expect(await screen.findByText(
      "Use Candidate A for the next controlled PoC.",
    )).toBeVisible();
    await user.click(screen.getByRole("button", {
      name: "Open representative change check",
    }));
    await user.click(screen.getByRole("button", {
      name: "Replay representative defect",
    }));

    expect(await screen.findByRole("heading", { name: "BLOCK" })).toBeVisible();
    expect(screen.getByText("INACTIVE_POLICY_CITATION")).toBeVisible();
    expect(screen.getByText("Recorded human decision remains unchanged")).toBeVisible();
  });

  it("전 후보 hard-gate 탈락은 정상적인 NO_APPROVED_CANDIDATE로 표시한다", async () => {
    const noApproved = state("LIVE_SYNTHETIC_DEMO", {
      status: "NO_APPROVED_CANDIDATE",
      judge: judgeReady("LIVE_SYNTHETIC_DEMO").judge,
      human_review: reviewed("LIVE_SYNTHETIC_DEMO").human_review,
      eligible_candidate_ids: [],
    });
    api.getCurrentExecution.mockResolvedValue(execution({
      status: "NO_APPROVED_CANDIDATE",
      progress_step: "NO_APPROVED_CANDIDATE",
      completed_candidate_count: 3,
    }));
    api.getResults.mockResolvedValue(noApproved);

    window.history.replaceState({}, "", "/?view=demo&demoStage=decide");
    render(<App />);

    expect(await screen.findByRole("heading", {
      name: "No approved candidate",
    })).toBeVisible();
    expect(screen.getByText(/normal completed outcome/i)).toBeVisible();
    expect(screen.queryByRole("button", {
      name: /Decision Memo/i,
    })).not.toBeInTheDocument();
  });

  it("401 응답이면 보호 화면을 유지하지 않고 Judge session 만료를 알린다", async () => {
    api.getChallenge.mockRejectedValue(new AuthExpiredError());
    render(<App />);

    await waitFor(() => expect(notifyAuthExpired).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(CHALLENGE.ticket)).not.toBeInTheDocument();
  });
});

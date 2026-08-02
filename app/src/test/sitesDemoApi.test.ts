import { vi } from "vitest";
import type {
  DemoCandidateView,
  HackathonDemoState,
} from "../../shared/hackathonDemo";
import * as sitesDemoApi from "../data/sitesDemoApi";
import {
  AuthExpiredError,
  getSession,
  JUDGE_ACCESS_ERROR_MESSAGE,
  login,
  logout,
  SitesDemoApiError,
} from "../data/sitesDemoApi";

const client = sitesDemoApi as typeof sitesDemoApi & {
  getChallenge(): Promise<unknown>;
  createLiveComparison(idempotencyKey: string): Promise<unknown>;
  runComparison(executionId: string): Promise<unknown>;
  getCurrentExecution(): Promise<unknown>;
  getExecution(executionId: string): Promise<unknown>;
  getResults(executionId: string): Promise<unknown>;
  runJudge(executionId: string): Promise<unknown>;
  getEvidence(executionId: string, blindLabel: "X" | "Y" | "Z"): Promise<unknown>;
  confirmReviews(executionId: string, review: unknown): Promise<unknown>;
  selectCandidate(executionId: string, selection: unknown): Promise<unknown>;
  createDecisionMemo(executionId: string): Promise<unknown>;
  replayRegression(executionId: string): Promise<unknown>;
  selectRecordedFallback(): Promise<unknown>;
};

const EXECUTION_ID = "cmp_000000000000000000000001";

function execution(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "live-demo-execution-v1",
    execution_id: EXECUTION_ID,
    source: "LIVE",
    status: "READY",
    progress_step: "READY",
    current_candidate: null,
    completed_candidate_count: 0,
    created_at_ms: 1,
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

function challenge(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "live-demo-challenge-v1",
    synthetic: true,
    locked: true,
    case_id: "C-001",
    as_of: "2026-07-19T00:00:00.000Z",
    ticket: "Please cancel the synthetic order.",
    candidates: ["A", "B", "C"],
    runs_per_candidate: 1,
    external_action_statement:
      "No purchase, contract, deployment, or rollback was executed.",
    ...overrides,
  };
}

function candidate(
  candidateId: "A" | "B" | "C",
  runCount: 1 | 2,
): DemoCandidateView {
  const runs = Array.from({ length: runCount }, (_, index) => ({
    evidence_id: `evidence-${candidateId}-${index + 1}`,
    repetition: index + 1,
    execution_status: "COMPLETE",
    hard_gate_status: "PASS",
    latency_ms: 10,
    cost_usd: 0.001,
    customer_reply: `Candidate ${candidateId} reply`,
    action_code: "DENY_CANCEL_AFTER_SHIPMENT",
    escalation_required: false,
    citations: ["CANCEL-2026 §2.2"],
  }));
  return {
    candidate_id: candidateId,
    architecture: `Candidate ${candidateId}`,
    complexity_tier: candidateId === "A" ? "T1" : candidateId === "B" ? "T2" : "T3",
    hard_gate: {
      passed_runs: runCount,
      total_runs: runCount,
      status: "PASS",
    },
    quality: {
      complete_outputs: runCount,
      active_policy_citations: runCount,
      stability: runCount === 1 ? "SINGLE_RUN_NOT_MEASURED" : "STABLE",
      stable_decisions: runCount === 1 ? null : true,
    },
    total_cost_usd: 0.001 * runCount,
    mean_cost_usd: 0.001,
    total_latency_ms: 10 * runCount,
    mean_latency_ms: 10,
    provider_calls: runCount,
    retrieval_calls: 0,
    tool_calls: 0,
    runs: runs as unknown as DemoCandidateView["runs"],
  };
}

function demoState(
  source: "LIVE_SYNTHETIC_DEMO" | "RECORDED_FALLBACK" =
    "LIVE_SYNTHETIC_DEMO",
): HackathonDemoState {
  const runCount = source === "LIVE_SYNTHETIC_DEMO" ? 1 : 2;
  return {
    schema_version: "hackathon-demo-state-v1",
    synthetic: true,
    source,
    status: "JUDGE_REQUIRED",
    canary: {
      pack_id: "synthetic-pack",
      pack_hash: "a".repeat(64),
      artifact_kind: source === "LIVE_SYNTHETIC_DEMO"
        ? "LIVE_DEMO_EVALUATION_PACK"
        : "PARTIAL_CALIBRATION_PACK",
      evaluation_status: "EVALUATION_INCOMPLETE",
      case_id: "C-001",
      ticket: "Please cancel the synthetic order.",
      as_of: "2026-07-19T00:00:00.000Z",
      total_cost_usd: 0.003 * runCount,
      candidates: [
        candidate("A", runCount),
        candidate("B", runCount),
        candidate("C", runCount),
      ],
    },
    judge: null,
    blind_review: {
      case_id: "C-001",
      candidates: (["X", "Y", "Z"] as const).map((blindLabel) => ({
        blind_label: blindLabel,
        runs: Array.from({ length: runCount }, (_, index) => ({
          repetition: index + 1,
          customer_reply: `${blindLabel} reply ${index + 1}`,
          citations: ["CANCEL-2026 §2.2"],
        })),
      })) as unknown as HackathonDemoState["blind_review"]["candidates"],
    },
    human_review: null,
    eligible_candidate_ids: [],
    selection: null,
    memo: null,
    regression: null,
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    case_id: "C-001",
    blind_label: "X",
    runs: [{
      repetition: 1,
      customer_reply: "Blind candidate reply",
      citations: ["CANCEL-2026 §2.2"],
    }],
    judge_risk: null,
    ...overrides,
  };
}

describe("Sites 심사위원 인증 API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("쿠키를 포함하고 캐시를 금지한 동일 출처 session 요청만 사용한다", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ authenticated: true }),
    );

    await expect(getSession()).resolves.toEqual({ authenticated: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/session",
      {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        method: "GET",
      },
    );
  });

  it("접근 코드는 login 요청 본문의 유일한 필드로만 전송한다", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ authenticated: true }),
    );

    await expect(login("one-use-code")).resolves.toEqual({ authenticated: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/login",
      {
        body: JSON.stringify({ access_code: "one-use-code" }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
  });

  it("logout은 빈 JSON 객체로 보호된 상태 변경을 요청한다", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ authenticated: false }),
    );

    await expect(logout()).resolves.toEqual({ authenticated: false });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      {
        body: JSON.stringify({}),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
  });

  it("401 응답을 통일된 인증 만료 신호로 바꾼다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 }),
    );

    await expect(getSession()).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it("추가 필드나 JSON이 아닌 성공 응답을 fail-closed 처리한다", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(
      Response.json({ authenticated: true, session_secret: "must-not-pass" }),
    );
    await expect(getSession()).rejects.toEqual(
      expect.objectContaining({
        name: "SitesDemoApiError",
        message: JUDGE_ACCESS_ERROR_MESSAGE,
      }),
    );

    fetchMock.mockResolvedValueOnce(
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(getSession()).rejects.toBeInstanceOf(SitesDemoApiError);
  });

  it("network와 서버 오류의 내부 내용을 동일한 일반 오류로 바꾼다", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockRejectedValueOnce(new Error("private-network-detail"));
    await expect(getSession()).rejects.toEqual(
      expect.objectContaining({ message: JUDGE_ACCESS_ERROR_MESSAGE }),
    );

    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: { code: "INTERNAL", detail: "private-server-detail" } },
        { status: 500 },
      ),
    );
    await expect(getSession()).rejects.toEqual(
      expect.objectContaining({ message: JUDGE_ACCESS_ERROR_MESSAGE }),
    );
  });
});

describe("Sites 보호 demo API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GET route의 exact path와 same-origin/no-store 계약을 사용하고 current null을 허용한다", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(Response.json(challenge()))
      .mockResolvedValueOnce(Response.json(null))
      .mockResolvedValueOnce(Response.json(execution()))
      .mockResolvedValueOnce(Response.json(demoState()))
      .mockResolvedValueOnce(Response.json(evidence()));

    await expect(client.getChallenge()).resolves.toEqual(challenge());
    await expect(client.getCurrentExecution()).resolves.toBeNull();
    await expect(client.getExecution(EXECUTION_ID)).resolves.toEqual(execution());
    await expect(client.getResults(EXECUTION_ID)).resolves.toEqual(demoState());
    await expect(client.getEvidence(EXECUTION_ID, "X")).resolves.toEqual(evidence());

    expect(fetchMock.mock.calls.map(([path, init]) => [path, init])).toEqual([
      ["/api/challenge", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        method: "GET",
      }],
      ["/api/live-comparisons/current", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        method: "GET",
      }],
      [`/api/live-comparisons/${EXECUTION_ID}`, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        method: "GET",
      }],
      [`/api/live-comparisons/${EXECUTION_ID}/results`, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        method: "GET",
      }],
      [`/api/live-comparisons/${EXECUTION_ID}/evidence/X`, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        method: "GET",
      }],
    ]);
  });

  it("모든 mutation을 exact JSON body와 보호 path로 전송한다", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const liveState = demoState();
    const review = {
      reviewer: "Judge reviewer",
      rationale: "Evidence reviewed.",
      decisions: [
        { blind_label: "X", decision: "PASS" },
        { blind_label: "Y", decision: "PASS" },
        { blind_label: "Z", decision: "CONFIRMED_FAIL" },
      ],
    } as const;
    const selection = {
      selected_candidate_id: "B",
      rationale: "Simplest sufficient eligible candidate.",
    } as const;
    const responses = [
      execution(),
      execution(),
      liveState,
      liveState,
      liveState,
      liveState,
      liveState,
      {
        execution: execution({ source: "RECORDED_FALLBACK" }),
        state: demoState("RECORDED_FALLBACK"),
      },
    ];
    for (const response of responses) {
      fetchMock.mockResolvedValueOnce(Response.json(response));
    }

    await client.createLiveComparison("request_00000001");
    await client.runComparison(EXECUTION_ID);
    await client.runJudge(EXECUTION_ID);
    await client.confirmReviews(EXECUTION_ID, review);
    await client.selectCandidate(EXECUTION_ID, selection);
    await client.createDecisionMemo(EXECUTION_ID);
    await client.replayRegression(EXECUTION_ID);
    await client.selectRecordedFallback();

    expect(fetchMock.mock.calls.map(([path, init]) => [
      path,
      init?.method,
      init?.body,
    ])).toEqual([
      ["/api/live-comparisons", "POST", JSON.stringify({
        idempotency_key: "request_00000001",
      })],
      [`/api/live-comparisons/${EXECUTION_ID}/run`, "POST", "{}"],
      [`/api/live-comparisons/${EXECUTION_ID}/judge`, "POST", "{}"],
      [
        `/api/live-comparisons/${EXECUTION_ID}/reviews`,
        "POST",
        JSON.stringify(review),
      ],
      [
        `/api/live-comparisons/${EXECUTION_ID}/selection`,
        "POST",
        JSON.stringify(selection),
      ],
      [`/api/live-comparisons/${EXECUTION_ID}/memo`, "POST", "{}"],
      [`/api/live-comparisons/${EXECUTION_ID}/regression`, "POST", "{}"],
      ["/api/recorded-demo/select", "POST", "{}"],
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
      });
    }
  });

  it("실행 ID·blind label·mutation input을 fetch 전에 fail-closed 검증한다", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    expect(() => client.getExecution("../private")).toThrow(SitesDemoApiError);
    expect(() => client.getEvidence(EXECUTION_ID, "A" as "X")).toThrow(
      SitesDemoApiError,
    );
    expect(() => client.createLiveComparison("short")).toThrow(
      SitesDemoApiError,
    );
    expect(() => client.confirmReviews(EXECUTION_ID, {
      reviewer: "Reviewer",
      rationale: "Incomplete.",
      decisions: [{ blind_label: "X", decision: "PASS" }],
    })).toThrow(SitesDemoApiError);
    expect(() => client.confirmReviews(EXECUTION_ID, {
      reviewer: "Reviewer",
      rationale: "Legacy timing must not be trusted.",
      correction_seconds: 1,
      decisions: [
        { blind_label: "X", decision: "PASS" },
        { blind_label: "Y", decision: "PASS" },
        { blind_label: "Z", decision: "PASS" },
      ],
    } as unknown as Parameters<typeof client.confirmReviews>[1])).toThrow(
      SitesDemoApiError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("challenge·execution·evidence·recorded wrapper의 추가 필드와 불일치를 거부한다", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(Response.json(challenge({ unexpected: true })))
      .mockResolvedValueOnce(Response.json(execution({
        execution_id: "cmp_999999999999999999999999",
      })))
      .mockResolvedValueOnce(Response.json(evidence({ blind_label: "Y" })))
      .mockResolvedValueOnce(Response.json({
        execution: execution({ source: "RECORDED_FALLBACK" }),
        state: demoState("RECORDED_FALLBACK"),
        unexpected: true,
      }));

    await expect(client.getChallenge()).rejects.toBeInstanceOf(SitesDemoApiError);
    await expect(client.getExecution(EXECUTION_ID)).rejects.toBeInstanceOf(
      SitesDemoApiError,
    );
    await expect(client.getEvidence(EXECUTION_ID, "X")).rejects.toBeInstanceOf(
      SitesDemoApiError,
    );
    await expect(client.selectRecordedFallback()).rejects.toBeInstanceOf(
      SitesDemoApiError,
    );
  });

  it("live create·run 응답에 recorded source가 섞이면 거부한다", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(Response.json(execution({
        source: "RECORDED_FALLBACK",
      })))
      .mockResolvedValueOnce(Response.json(execution({
        source: "RECORDED_FALLBACK",
      })));

    await expect(
      client.createLiveComparison("request_00000001"),
    ).rejects.toBeInstanceOf(SitesDemoApiError);
    await expect(
      client.runComparison(EXECUTION_ID),
    ).rejects.toBeInstanceOf(SitesDemoApiError);
  });

  it("application/json 유사 MIME을 JSON 성공 응답으로 허용하지 않는다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(challenge()), {
        status: 200,
        headers: { "content-type": "application/json-malformed" },
      }),
    );

    await expect(client.getChallenge()).rejects.toBeInstanceOf(
      SitesDemoApiError,
    );
  });

  it.each([
    ["secret key", { session_token_digest: "private" }],
    ["session token key", { session_token: "private" }],
    ["remote key", { provider_response_id: "private" }],
    ["mapping key", { revealed_mapping: { X: "A" } }],
    ["structural mapping", {
      metadata: { blind_label: "X", candidate_id: "A" },
    }],
  ])("공개 demo state의 %s 유출을 클라이언트에서도 차단한다", async (_label, leak) => {
    const leaked = Object.assign(demoState(), leak);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(leaked));

    await expect(client.getResults(EXECUTION_ID)).rejects.toBeInstanceOf(
      SitesDemoApiError,
    );
  });

  it("보호 API의 401을 access gate가 이해하는 AuthExpiredError로 통일한다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 }),
    );

    await expect(client.getChallenge()).rejects.toBeInstanceOf(AuthExpiredError);
  });
});

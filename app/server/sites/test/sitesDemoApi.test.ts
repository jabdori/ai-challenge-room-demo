// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { Mocked } from "vitest";
import type {
  LiveDemoWorkflowService,
} from "../liveDemoWorkflowService";
import {
  LiveDemoWorkflowError,
} from "../liveDemoWorkflowService";
import type {
  JudgeAccessAuth,
} from "../judgeAccessAuth";
import {
  createSitesDemoApi,
  SITES_DEMO_API_ROUTES,
} from "../sitesDemoApi";

const ORIGIN = "https://demo.example";
const EXECUTION_ID = "cmp_000000000000000000000001";

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function authFixture(authenticated = true): {
  readonly auth: JudgeAccessAuth;
  readonly authenticate: ReturnType<typeof vi.fn>;
  readonly handleAuthRoute: ReturnType<typeof vi.fn>;
} {
  const session = authenticated
    ? {
        sessionTokenDigest: "private-session-digest",
        createdAtMs: 1,
        expiresAtMs: 2,
        revokedAtMs: null,
        successfulLiveRuns: 0,
        operationalRetryCount: 0,
        currentExecutionId: null,
      }
    : null;
  const authenticate = vi.fn(async () => session);
  const handleAuthRoute = vi.fn(async (request: Request) => {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/api/auth/session") {
      return jsonResponse({ authenticated });
    }
    if (request.method === "POST" && pathname === "/api/auth/login") {
      return jsonResponse({ authenticated: true });
    }
    if (request.method === "POST" && pathname === "/api/auth/logout") {
      return jsonResponse({ authenticated: false });
    }
    return null;
  });
  return {
    auth: { authenticate, handleAuthRoute },
    authenticate,
    handleAuthRoute,
  };
}

function executionView() {
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
  } as const;
}

function serviceFixture(): Mocked<LiveDemoWorkflowService> {
  const state = {
    schema_version: "public-test-state-v1",
    synthetic: true,
    status: "JUDGE_REQUIRED",
  };
  return {
    getChallenge: vi.fn(() => ({
      schema_version: "live-demo-challenge-v1",
      synthetic: true,
      locked: true,
      case_id: "C-001",
      as_of: "2026-07-19T00:00:00.000Z",
      ticket: "Synthetic support ticket",
      candidates: ["A", "B", "C"],
      runs_per_candidate: 1,
      external_action_statement:
        "No purchase, contract, deployment, or rollback was executed.",
    })),
    createLiveComparison: vi.fn(async () => executionView()),
    runComparison: vi.fn(async () => executionView()),
    getCurrentExecution: vi.fn(async () => executionView()),
    getExecution: vi.fn(async () => executionView()),
    getResults: vi.fn(async () => state),
    runJudge: vi.fn(async () => state),
    getEvidence: vi.fn(async () => ({
      case_id: "C-001",
      blind_label: "X",
      runs: [],
      judge_risk: null,
    })),
    confirmReviews: vi.fn(async () => state),
    selectCandidate: vi.fn(async () => state),
    createDecisionMemo: vi.fn(async () => state),
    replayRegression: vi.fn(async () => state),
    selectRecordedFallback: vi.fn(async () => ({
      execution: executionView(),
      state,
    })),
  } as unknown as Mocked<LiveDemoWorkflowService>;
}

function mutation(path: string, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
    },
    body: JSON.stringify(body),
  });
}

async function expectError(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toBe(
    "application/json; charset=utf-8",
  );
  expect(await response.json()).toEqual({ error: { code } });
}

describe("Sites 보호 API 계약", () => {
  it("인증 공개 allowlist와 모든 보호 route를 exact method/path로 선언한다", () => {
    expect(SITES_DEMO_API_ROUTES.public).toEqual([
      "GET /api/auth/session",
      "POST /api/auth/login",
    ]);
    expect(SITES_DEMO_API_ROUTES.protected).toEqual([
      "POST /api/auth/logout",
      "GET /api/challenge",
      "POST /api/live-comparisons",
      "POST /api/live-comparisons/:executionId/run",
      "GET /api/live-comparisons/current",
      "GET /api/live-comparisons/:executionId",
      "GET /api/live-comparisons/:executionId/results",
      "POST /api/live-comparisons/:executionId/judge",
      "GET /api/live-comparisons/:executionId/evidence/:blindLabel",
      "POST /api/live-comparisons/:executionId/reviews",
      "POST /api/live-comparisons/:executionId/selection",
      "POST /api/live-comparisons/:executionId/memo",
      "POST /api/live-comparisons/:executionId/regression",
      "POST /api/recorded-demo/select",
    ]);
  });

  it("공개 allowlist 외 알려진·unknown API와 logout을 인증 전에 구분하지 않는다", async () => {
    const auth = authFixture(false);
    const api = createSitesDemoApi({
      auth: auth.auth,
      service: serviceFixture(),
    });

    const session = await api(new Request(`${ORIGIN}/api/auth/session`));
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ authenticated: false });

    const login = await api(mutation("/api/auth/login", {
      access_code: "fake-approved-code",
    }));
    expect(login.status).toBe(200);

    for (const request of [
      new Request(`${ORIGIN}/api/challenge`),
      new Request(`${ORIGIN}/api/unknown`),
      new Request(`${ORIGIN}/api/auth/login`),
      mutation("/api/auth/logout", {}),
    ]) {
      await expectError(await api(request), 401, "UNAUTHORIZED");
    }
    expect(auth.authenticate).toHaveBeenCalledTimes(4);
  });

  it("인증된 요청의 exact method/path만 처리하고 실행 ID·blind label을 검증한다", async () => {
    const api = createSitesDemoApi({
      auth: authFixture().auth,
      service: serviceFixture(),
    });

    await expectError(
      await api(mutation("/api/challenge", {})),
      404,
      "NOT_FOUND",
    );
    await expectError(
      await api(new Request(`${ORIGIN}/api/unknown`)),
      404,
      "NOT_FOUND",
    );
    await expectError(
      await api(new Request(`${ORIGIN}/api/live-comparisons/not-valid/results`)),
      400,
      "INVALID_REQUEST",
    );
    await expectError(
      await api(
        new Request(
          `${ORIGIN}/api/live-comparisons/${EXECUTION_ID}/evidence/x`,
        ),
      ),
      400,
      "INVALID_REQUEST",
    );
    await expectError(
      await api(
        new Request(
          `${ORIGIN}/api/live-comparisons/${EXECUTION_ID}/results/extra`,
        ),
      ),
      404,
      "NOT_FOUND",
    );
    await expectError(
      await api(new Request(`${ORIGIN}/api/challenge?candidate=A`)),
      400,
      "INVALID_REQUEST",
    );
  });

  it("모든 mutation에 same-origin·JSON·64 KiB 제한과 exact body를 적용한다", async () => {
    const api = createSitesDemoApi({
      auth: authFixture().auth,
      service: serviceFixture(),
    });

    await expectError(
      await api(new Request(`${ORIGIN}/api/live-comparisons`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotency_key: "request_00000001" }),
      })),
      400,
      "INVALID_REQUEST",
    );
    await expectError(
      await api(new Request(`${ORIGIN}/api/live-comparisons`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
        },
        body: JSON.stringify({ idempotency_key: "request_00000001" }),
      })),
      400,
      "INVALID_REQUEST",
    );
    await expectError(
      await api(new Request(`${ORIGIN}/api/live-comparisons`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin: ORIGIN,
        },
        body: "{}",
      })),
      400,
      "INVALID_REQUEST",
    );
    await expectError(
      await api(mutation("/api/live-comparisons", {
        idempotency_key: "request_00000001",
        unexpected: true,
      })),
      400,
      "INVALID_REQUEST",
    );
    await expectError(
      await api(new Request(`${ORIGIN}/api/live-comparisons`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
        },
        body: JSON.stringify({
          idempotency_key: "x".repeat(65_537),
        }),
      })),
      413,
      "PAYLOAD_TOO_LARGE",
    );
  });

  it("보호 route 전부를 현재 workflow interface에 정확히 매핑한다", async () => {
    const service = serviceFixture();
    const api = createSitesDemoApi({
      auth: authFixture().auth,
      service,
    });
    const review = {
      reviewer: "Judge reviewer",
      rationale: "Evidence checked.",
      decisions: [
        { blind_label: "X", decision: "PASS" },
        { blind_label: "Y", decision: "PASS" },
        { blind_label: "Z", decision: "CONFIRMED_FAIL" },
      ],
    };
    const selection = {
      selected_candidate_id: "B",
      rationale: "Simplest sufficient eligible candidate.",
    };

    const requests = [
      new Request(`${ORIGIN}/api/challenge`),
      mutation("/api/live-comparisons", {
        idempotency_key: "request_00000001",
      }),
      mutation(`/api/live-comparisons/${EXECUTION_ID}/run`, {}),
      new Request(`${ORIGIN}/api/live-comparisons/current`),
      new Request(`${ORIGIN}/api/live-comparisons/${EXECUTION_ID}`),
      new Request(`${ORIGIN}/api/live-comparisons/${EXECUTION_ID}/results`),
      mutation(`/api/live-comparisons/${EXECUTION_ID}/judge`, {}),
      new Request(
        `${ORIGIN}/api/live-comparisons/${EXECUTION_ID}/evidence/X`,
      ),
      mutation(`/api/live-comparisons/${EXECUTION_ID}/reviews`, review),
      mutation(`/api/live-comparisons/${EXECUTION_ID}/selection`, selection),
      mutation(`/api/live-comparisons/${EXECUTION_ID}/memo`, {}),
      mutation(`/api/live-comparisons/${EXECUTION_ID}/regression`, {}),
      mutation("/api/recorded-demo/select", {}),
      mutation("/api/auth/logout", {}),
    ];
    for (const request of requests) {
      expect((await api(request)).status).toBe(200);
    }

    const owner = "private-session-digest";
    expect(service.getChallenge).toHaveBeenCalledWith();
    expect(service.createLiveComparison).toHaveBeenCalledWith({
      sessionTokenDigest: owner,
      idempotencyKey: "request_00000001",
    });
    expect(service.runComparison).toHaveBeenCalledWith({
      sessionTokenDigest: owner,
      executionId: EXECUTION_ID,
    });
    expect(service.getCurrentExecution).toHaveBeenCalledWith(owner);
    expect(service.getExecution).toHaveBeenCalledWith({
      sessionTokenDigest: owner,
      executionId: EXECUTION_ID,
    });
    expect(service.getResults).toHaveBeenCalledWith({
      sessionTokenDigest: owner,
      executionId: EXECUTION_ID,
    });
    expect(service.runJudge).toHaveBeenCalledWith({
      sessionTokenDigest: owner,
      executionId: EXECUTION_ID,
    });
    expect(service.getEvidence).toHaveBeenCalledWith({
      sessionTokenDigest: owner,
      executionId: EXECUTION_ID,
      blindLabel: "X",
    });
    expect(service.confirmReviews).toHaveBeenCalledWith({
      sessionTokenDigest: owner,
      executionId: EXECUTION_ID,
      review,
    });
    expect(service.selectCandidate).toHaveBeenCalledWith({
      sessionTokenDigest: owner,
      executionId: EXECUTION_ID,
      selection,
    });
    expect(service.createDecisionMemo).toHaveBeenCalledWith({
      sessionTokenDigest: owner,
      executionId: EXECUTION_ID,
    });
    expect(service.replayRegression).toHaveBeenCalledWith({
      sessionTokenDigest: owner,
      executionId: EXECUTION_ID,
    });
    expect(service.selectRecordedFallback).toHaveBeenCalledWith({
      sessionTokenDigest: owner,
    });
  });

  it("review·selection body의 필드와 enum을 fail-closed 검증한다", async () => {
    const service = serviceFixture();
    const api = createSitesDemoApi({
      auth: authFixture().auth,
      service,
    });

    await expectError(
      await api(mutation(`/api/live-comparisons/${EXECUTION_ID}/reviews`, {
        reviewer: "Reviewer",
        rationale: "Checked.",
        decisions: [{ blind_label: "X", decision: "PASS" }],
      })),
      400,
      "INVALID_REQUEST",
    );
    await expectError(
      await api(mutation(`/api/live-comparisons/${EXECUTION_ID}/reviews`, {
        reviewer: "Reviewer",
        rationale: "Checked.",
        decisions: [
          { blind_label: "Y", decision: "PASS" },
          { blind_label: "X", decision: "PASS" },
          { blind_label: "Z", decision: "PASS" },
        ],
      })),
      400,
      "INVALID_REQUEST",
    );
    await expectError(
      await api(mutation(`/api/live-comparisons/${EXECUTION_ID}/reviews`, {
        reviewer: "Reviewer",
        rationale: "Legacy timing must not be trusted.",
        correction_seconds: 1,
        decisions: [
          { blind_label: "X", decision: "PASS" },
          { blind_label: "Y", decision: "PASS" },
          { blind_label: "Z", decision: "PASS" },
        ],
      })),
      400,
      "INVALID_REQUEST",
    );
    await expectError(
      await api(mutation(`/api/live-comparisons/${EXECUTION_ID}/selection`, {
        selected_candidate_id: "X",
        rationale: "Invalid candidate.",
      })),
      400,
      "INVALID_REQUEST",
    );
    expect(service.confirmReviews).not.toHaveBeenCalled();
    expect(service.selectCandidate).not.toHaveBeenCalled();
  });

  it("workflow 공개 오류는 고정 코드만 반환하고 내부 오류문은 노출하지 않는다", async () => {
    const service = serviceFixture();
    service.getChallenge.mockImplementationOnce(() => {
      throw new LiveDemoWorkflowError("INVALID_STATE", 409);
    });
    service.getChallenge.mockImplementationOnce(() => {
      throw new Error("private provider request failed with secret details");
    });
    service.getChallenge.mockImplementationOnce(() => {
      throw Object.assign(
        new Error("provider error with colliding code"),
        { code: "INVALID_STATE" },
      );
    });
    const api = createSitesDemoApi({
      auth: authFixture().auth,
      service,
    });

    await expectError(
      await api(new Request(`${ORIGIN}/api/challenge`)),
      409,
      "INVALID_STATE",
    );
    const internal = await api(new Request(`${ORIGIN}/api/challenge`));
    await expectError(internal.clone(), 500, "INTERNAL_ERROR");
    expect(await internal.text()).not.toContain("private provider");
    await expectError(
      await api(new Request(`${ORIGIN}/api/challenge`)),
      500,
      "INTERNAL_ERROR",
    );
  });

  it("service와 auth의 공개 응답이 guard를 통과하지 못하면 INTERNAL_ERROR로 닫는다", async () => {
    const service = serviceFixture();
    service.getChallenge.mockReturnValueOnce({
      session_token_digest: "must-never-be-public",
    } as never);
    const auth = authFixture();
    auth.handleAuthRoute.mockResolvedValueOnce(jsonResponse({
      authenticated: true,
      provider_response_id: "must-never-be-public",
    }));
    const api = createSitesDemoApi({
      auth: auth.auth,
      service,
    });

    await expectError(
      await api(new Request(`${ORIGIN}/api/challenge`)),
      500,
      "INTERNAL_ERROR",
    );
    await expectError(
      await api(new Request(`${ORIGIN}/api/auth/session`)),
      500,
      "INTERNAL_ERROR",
    );
  });
});

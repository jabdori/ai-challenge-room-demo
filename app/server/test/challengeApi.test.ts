// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  ApiArtifactIntegrityError,
  createChallengeApiHandler,
  type ChallengeApiGateway,
} from "../challengeServer";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const REVIEWER_TOKEN = "reviewer-test-token";
const REVIEWER_HEADERS = Object.freeze({
  authorization: `Bearer ${REVIEWER_TOKEN}`,
  host: "127.0.0.1",
  origin: "http://127.0.0.1",
  "sec-fetch-site": "same-origin",
});
const reviewerAuthorizer = Object.freeze({
  authorize(request: Request): 401 | 403 | null {
    if (request.headers.get("authorization") !== `Bearer ${REVIEWER_TOKEN}`) {
      return 401;
    }
    return (
      request.headers.get("host") === "127.0.0.1"
      && request.headers.get("origin") === "http://127.0.0.1"
      && request.headers.get("sec-fetch-site") === "same-origin"
    ) ? null : 403;
  },
});

function gateway(
  overrides: Partial<ChallengeApiGateway> = {},
): ChallengeApiGateway {
  return {
    getWorkspace: vi.fn(async () => ({
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
      challenge: { state: "LOCKED", source_hash: SHA_A },
      benchmark: { status: "REVIEW_PENDING", source_hash: SHA_B },
      decision: { status: "NOT_CREATED", baseline_version: null },
      regression: { status: "NOT_CREATED" },
    })),
    getChallenge: vi.fn(async (id) => ({
      schema_version: "challenge-public-projection-v1",
      synthetic: true,
      challenge_id: id,
      source_hash: SHA_A,
    })),
    getEvidence: vi.fn(async (id) => ({
      schema_version: "evidence-public-projection-v1",
      synthetic: true,
      evidence_id: id,
      source_hash: SHA_B,
    })),
    getBlindReview: vi.fn(async (id) => ({
      schema_version: "blind-review-public-projection-v1",
      synthetic: true,
      review_id: id,
      source_hash: SHA_B,
    })),
    getDecision: vi.fn(async (id) => ({
      schema_version: "decision-public-projection-v1",
      synthetic: true,
      decision_id: id,
      source_hash: SHA_B,
    })),
    getBaseline: vi.fn(async (id) => ({
      schema_version: "baseline-public-projection-v1",
      synthetic: true,
      baseline_id: id,
      source_hash: SHA_B,
    })),
    getRegression: vi.fn(async (id) => ({
      schema_version: "regression-public-projection-v1",
      synthetic: true,
      regression_id: id,
      source_hash: SHA_B,
    })),
    getBenchmarkProgress: vi.fn(async (id) => ({
      schema_version: "benchmark-progress-projection-v1",
      synthetic: true,
      benchmark_id: id,
      completed: 72,
      total: 72,
      source_hash: SHA_B,
    })),
    structureDefine: vi.fn(async (command) => ({
      accepted: true,
      source_hash: command.expected_source_hash,
    })),
    lockChallenge: vi.fn(async (command) => ({
      accepted: true,
      source_hash: command.expected_source_hash,
    })),
    startBenchmark: vi.fn(async (command) => ({
      accepted: true,
      source_hash: command.expected_source_hash,
    })),
    confirmReview: vi.fn(async (command) => ({
      accepted: true,
      source_hash: command.expected_source_hash,
    })),
    createDecisionMemo: vi.fn(async (command) => ({
      accepted: true,
      source_hash: command.expected_source_hash,
    })),
    confirmDecision: vi.fn(async (command) => ({
      accepted: true,
      source_hash: command.expected_source_hash,
    })),
    startRegression: vi.fn(async (command) => ({
      accepted: true,
      source_hash: command.expected_source_hash,
    })),
    ...overrides,
  };
}

function jsonRequest(path: string, body: unknown, reviewer = false): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(reviewer ? REVIEWER_HEADERS : {}),
    },
    body: JSON.stringify(body),
  });
}

function reviewerRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1${path}`, {
    ...init,
    headers: {
      ...REVIEWER_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("로컬 권위 Challenge API", () => {
  it("검증된 공개 projection만 읽고 private·secret·oracle 자료가 섞이면 응답을 거부한다", async () => {
    const clean = createChallengeApiHandler({ gateway: gateway() });
    const response = await clean(new Request("http://127.0.0.1/api/workspace"));
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
    });

    const unsafe = createChallengeApiHandler({
      gateway: gateway({
        getWorkspace: async () => ({
          schema_version: "workspace-public-projection-v1",
          synthetic: true,
          private_mapping: { X: "A" },
        }),
      }),
    });
    const blocked = await unsafe(new Request("http://127.0.0.1/api/workspace"));
    expect(blocked.status).toBe(500);
    const blockedBody = JSON.stringify(await body(blocked));
    expect(blockedBody).not.toContain("Candidate");
    expect(blockedBody).not.toContain("private_mapping");
  });

  it("Challenge·evidence·progress·blind review·decision·baseline·regression의 정확한 읽기 path만 허용한다", async () => {
    const api = gateway();
    const handler = createChallengeApiHandler({
      gateway: api,
      reviewerAuthorizer,
    });

    const evidence = await handler(
      new Request("http://127.0.0.1/api/evidence/evh_abc-123"),
    );
    expect(evidence.status).toBe(200);
    expect(api.getEvidence).toHaveBeenCalledWith("evh_abc-123");

    const progress = await handler(
      new Request("http://127.0.0.1/api/benchmarks/bench_123/progress"),
    );
    expect(progress.status).toBe(200);
    expect(api.getBenchmarkProgress).toHaveBeenCalledWith("bench_123");

    const challenge = await handler(
      new Request("http://127.0.0.1/api/challenges/challenge_1"),
    );
    expect(challenge.status).toBe(200);
    expect(api.getChallenge).toHaveBeenCalledWith("challenge_1");

    const review = await handler(reviewerRequest("/api/reviews/review_1"));
    expect(review.status).toBe(200);
    expect(api.getBlindReview).toHaveBeenCalledWith("review_1");

    const decision = await handler(
      new Request("http://127.0.0.1/api/decisions/decision_1"),
    );
    expect(decision.status).toBe(200);
    expect(api.getDecision).toHaveBeenCalledWith("decision_1");

    const baseline = await handler(
      new Request("http://127.0.0.1/api/baselines/baseline_1"),
    );
    expect(baseline.status).toBe(200);
    expect(api.getBaseline).toHaveBeenCalledWith("baseline_1");

    const regression = await handler(
      new Request("http://127.0.0.1/api/regressions/regression_1"),
    );
    expect(regression.status).toBe(200);
    expect(api.getRegression).toHaveBeenCalledWith("regression_1");

    expect((await handler(
      new Request("http://127.0.0.1/api/evidence/../../private"),
    )).status).toBe(404);
  });

  it("reviewer detail은 opaque evidence handle 없이는 열리지 않고 공개 evidence route와 분리된다", async () => {
    const detail = vi.fn(async () => ({
      schema_version: "recorded-blind-review-evidence-detail-v1",
      synthetic: true,
      candidate_label: "Candidate X",
      runs: [{ customer_reply: "Run one reviewer output" }, { customer_reply: "Run two reviewer output" }],
    }));
    const api = Object.assign(gateway(), {
      getReviewerBlindEvidenceDetail: detail,
    });
    const handler = createChallengeApiHandler({
      gateway: api,
      reviewerAuthorizer,
    });
    const denied = await handler(new Request(
      "http://127.0.0.1/api/reviewer/evidence/review_abc",
    ));
    expect(denied.status).toBe(401);
    expect(detail).not.toHaveBeenCalled();

    const handle = `evh_${SHA_A}`;
    const granted = await handler(reviewerRequest(
      "/api/reviewer/evidence/review_abc",
      { headers: { "x-review-evidence-handle": handle } },
    ));
    expect(granted.status).toBe(200);
    expect(detail).toHaveBeenCalledWith({
      evidenceId: "review_abc",
      evidenceHandle: handle,
    });
    expect(await granted.json()).toMatchObject({ candidate_label: "Candidate X" });
  });

  it("reviewer projection·detail·confirm은 bearer와 same-origin 검증 전에는 gateway를 호출하지 않는다", async () => {
    const detail = vi.fn(async () => ({
      schema_version: "recorded-blind-review-evidence-detail-v1",
      synthetic: true,
      candidate_label: "Candidate X",
      runs: [{ customer_reply: "reviewer-only detail" }],
    }));
    const api = Object.assign(gateway(), {
      getReviewerBlindEvidenceDetail: detail,
    });
    const authorizer = {
      authorize: vi.fn((request: Request): 401 | 403 | null => {
        if (request.headers.get("authorization") !== "Bearer reviewer-test-token") {
          return 401;
        }
        if (
          request.headers.get("host") !== "127.0.0.1:4173"
          || request.headers.get("origin") !== "http://127.0.0.1:4173"
          || request.headers.get("sec-fetch-site") !== "same-origin"
        ) return 403;
        return null;
      }),
    };
    const handler = createChallengeApiHandler({
      gateway: api,
      reviewerAuthorizer: authorizer,
    } as never);
    const protectedHeaders = {
      authorization: "Bearer reviewer-test-token",
      host: "127.0.0.1:4173",
      origin: "http://127.0.0.1:4173",
      "sec-fetch-site": "same-origin",
    };

    const missing = await handler(new Request(
      "http://127.0.0.1:4173/api/reviewer/evidence/review_abc",
      { headers: { "x-review-evidence-handle": `evh_${SHA_A}` } },
    ));
    expect(missing.status).toBe(401);
    expect(detail).not.toHaveBeenCalled();

    const crossOrigin = await handler(new Request(
      "http://127.0.0.1:4173/api/reviewer/evidence/review_abc",
      {
        headers: {
          ...protectedHeaders,
          origin: "http://evil.example",
          "x-review-evidence-handle": `evh_${SHA_A}`,
        },
      },
    ));
    expect(crossOrigin.status).toBe(403);
    expect(detail).not.toHaveBeenCalled();

    const detailResponse = await handler(new Request(
      "http://127.0.0.1:4173/api/reviewer/evidence/review_abc",
      {
        headers: {
          ...protectedHeaders,
          "x-review-evidence-handle": `evh_${SHA_A}`,
        },
      },
    ));
    expect(detailResponse.status).toBe(200);

    const review = await handler(new Request(
      "http://127.0.0.1:4173/api/reviews/review_1",
      { headers: protectedHeaders },
    ));
    expect(review.status).toBe(200);

    const confirm = await handler(new Request(
      "http://127.0.0.1:4173/api/reviews/review_1/confirm",
      {
        method: "POST",
        headers: {
          ...protectedHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schema_version: "review-confirmation-command-v1",
          expected_source_hash: SHA_A,
          idempotency_key: "mutation_reviewer_auth_001",
        }),
      },
    ));
    expect(confirm.status).toBe(200);
    expect(authorizer.authorize).toHaveBeenCalledTimes(5);
    expect(api.confirmReview).toHaveBeenCalledTimes(1);
  });

  it("사람 확인 전 review endpoint는 blind item 대신 결합된 pre-confirmation projection을 반환할 수 있다", async () => {
    const handler = createChallengeApiHandler({
      gateway: gateway({
        getBlindReview: async (id) => ({
          schema_version: "preconfirmation-public-projection-v1",
          synthetic: true,
          review_id: id,
          source_hash: SHA_B,
        }),
      }),
      reviewerAuthorizer,
    });

    const response = await handler(reviewerRequest("/api/reviews/review_1"));
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({
      schema_version: "preconfirmation-public-projection-v1",
      review_id: "review_1",
    });
  });

  it("읽기 projection의 endpoint별 schema와 synthetic 경계를 검증한다", async () => {
    const handler = createChallengeApiHandler({
      gateway: gateway({
        getDecision: async () => ({
          schema_version: "workspace-public-projection-v1",
          synthetic: true,
          decision_id: "decision_1",
          source_hash: SHA_B,
        }),
      }),
    });

    const wrongSchema = await handler(
      new Request("http://127.0.0.1/api/decisions/decision_1"),
    );
    expect(wrongSchema.status).toBe(500);
    expect(await body(wrongSchema)).toEqual({ error: "ARTIFACT_INTEGRITY" });

    const nonSynthetic = createChallengeApiHandler({
      gateway: gateway({
        getRegression: async () => ({
          schema_version: "regression-public-projection-v1",
          synthetic: false,
          regression_id: "regression_1",
          source_hash: SHA_B,
        }),
      }),
    });
    const blocked = await nonSynthetic(
      new Request("http://127.0.0.1/api/regressions/regression_1"),
    );
    expect(blocked.status).toBe(500);
    expect(await body(blocked)).toEqual({ error: "ARTIFACT_INTEGRITY" });
  });

  it("mutation은 exact source hash·idempotency key·plain JSON 계약이 없으면 side effect 전에 거부한다", async () => {
    const api = gateway();
    const handler = createChallengeApiHandler({
      gateway: api,
      reviewerAuthorizer,
    });

    const missingHash = await handler(jsonRequest("/api/reviews/rev_1/confirm", {
      schema_version: "review-confirmation-command-v1",
      idempotency_key: "mutation_001",
    }, true));
    expect(missingHash.status).toBe(400);
    expect(api.confirmReview).not.toHaveBeenCalled();

    const extraAuthority = await handler(jsonRequest("/api/reviews/rev_1/confirm", {
      schema_version: "review-confirmation-command-v1",
      expected_source_hash: SHA_A,
      idempotency_key: "mutation_001",
      session_confirmed: true,
    }, true));
    expect(extraAuthority.status).toBe(400);
    expect(api.confirmReview).not.toHaveBeenCalled();
  });

  it("query string·URL·세션 값으로 mutation 권한이나 state를 만들 수 없다", async () => {
    const api = gateway();
    const handler = createChallengeApiHandler({ gateway: api });
    const response = await handler(jsonRequest(
      "/api/decisions/decision_1/confirm?baseline=forged&confirmed=true",
      {
        schema_version: "decision-confirmation-command-v1",
        expected_source_hash: SHA_A,
        idempotency_key: "mutation_002",
      },
    ));

    expect(response.status).toBe(400);
    expect(api.confirmDecision).not.toHaveBeenCalled();
  });

  it("동일 idempotency key replay를 gateway 전에 차단하고 서로 다른 mutation을 직렬화한다", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const api = gateway({
      startBenchmark: vi.fn(async (command) => {
        events.push(`start:${command.idempotency_key}`);
        if (command.idempotency_key === "mutation_101") await firstGate;
        events.push(`finish:${command.idempotency_key}`);
        return { accepted: true, source_hash: command.expected_source_hash };
      }),
    });
    const handler = createChallengeApiHandler({ gateway: api });
    const command = (key: string) => jsonRequest("/api/benchmarks/bench_1/start", {
      schema_version: "benchmark-start-command-v1",
      expected_source_hash: SHA_A,
      idempotency_key: key,
    });

    const first = handler(command("mutation_101"));
    await vi.waitFor(() => expect(events).toEqual(["start:mutation_101"]));
    const second = handler(command("mutation_102"));
    await Promise.resolve();
    expect(events).toEqual(["start:mutation_101"]);
    releaseFirst();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(events).toEqual([
      "start:mutation_101",
      "finish:mutation_101",
      "start:mutation_102",
      "finish:mutation_102",
    ]);

    const replay = await handler(command("mutation_101"));
    expect(replay.status).toBe(409);
    expect(api.startBenchmark).toHaveBeenCalledTimes(2);
  });

  it("stale hash를 409로, 권위 무결성 오류를 세부자료 없는 500으로 변환한다", async () => {
    const stale = createChallengeApiHandler({
      gateway: gateway({
        confirmReview: async () => {
          throw new ApiArtifactIntegrityError("STALE_SOURCE", "internal hash detail");
        },
      }),
      reviewerAuthorizer,
    });
    const staleResponse = await stale(jsonRequest("/api/reviews/rev_1/confirm", {
      schema_version: "review-confirmation-command-v1",
      expected_source_hash: SHA_A,
      idempotency_key: "mutation_201",
    }, true));
    expect(staleResponse.status).toBe(409);
    expect(await body(staleResponse)).toEqual({ error: "STALE_SOURCE" });

    const corrupt = createChallengeApiHandler({
      gateway: gateway({
        getWorkspace: async () => {
          throw new ApiArtifactIntegrityError(
            "ARTIFACT_INTEGRITY",
            "raw private path /secret/value",
          );
        },
      }),
    });
    const corruptResponse = await corrupt(
      new Request("http://127.0.0.1/api/workspace"),
    );
    expect(corruptResponse.status).toBe(500);
    expect(await body(corruptResponse)).toEqual({ error: "ARTIFACT_INTEGRITY" });
  });
});

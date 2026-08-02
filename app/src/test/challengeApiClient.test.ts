import { describe, expect, it, vi } from "vitest";
import {
  ChallengeApiClient,
  ChallengeApiClientError,
} from "../data/challengeApi";

const SHA_A = "a".repeat(64);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("browser Challenge API client", () => {
  it("same-origin no-store GET으로 workspace와 정확한 공개 schema만 읽는다", async () => {
    const fetcher = vi.fn(async () => response({
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
      state: "REVIEW_PENDING",
    }));
    const client = new ChallengeApiClient(fetcher);

    await expect(client.getWorkspace()).resolves.toMatchObject({
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
    });
    expect(fetcher).toHaveBeenCalledWith("/api/workspace", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
  });

  it("wrong schema·non-synthetic·private evaluator 자료를 fail-closed 한다", async () => {
    const wrongSchema = new ChallengeApiClient(async () => response({
      schema_version: "decision-public-projection-v1",
      synthetic: true,
    }));
    await expect(wrongSchema.getWorkspace()).rejects.toBeInstanceOf(
      ChallengeApiClientError,
    );

    const privateLeak = new ChallengeApiClient(async () => response({
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
      private_mapping: { X: "A" },
    }));
    await expect(privateLeak.getWorkspace()).rejects.toBeInstanceOf(
      ChallengeApiClientError,
    );
  });

  it.each([
    "benchmark-progress-projection-v1",
    "benchmark-lifecycle-ready-projection-v1",
    "benchmark-lifecycle-projection-v1",
    "benchmark-lifecycle-invalid-projection-v1",
  ] as const)("Benchmark progress의 서버 허용 schema %s와 exact benchmark identity만 받는다", async (schemaVersion) => {
    const benchmarkId = "benchmark_lifecycle_1";
    const client = new ChallengeApiClient(async () => response({
      schema_version: schemaVersion,
      synthetic: true,
      benchmark_id: benchmarkId,
      source_hash: SHA_A,
    }));

    await expect(client.getBenchmarkProgress(benchmarkId)).resolves.toMatchObject({
      schema_version: schemaVersion,
      benchmark_id: benchmarkId,
    });

    const wrongIdentity = new ChallengeApiClient(async () => response({
      schema_version: schemaVersion,
      synthetic: true,
      benchmark_id: "benchmark_other",
      source_hash: SHA_A,
    }));
    await expect(wrongIdentity.getBenchmarkProgress(benchmarkId)).rejects
      .toMatchObject({ code: "INVALID_RESPONSE" });

    const fabricatedSchema = new ChallengeApiClient(async () => response({
      schema_version: "benchmark-lifecycle-unreviewed-projection-v1",
      synthetic: true,
      benchmark_id: benchmarkId,
      source_hash: SHA_A,
    }));
    await expect(fabricatedSchema.getBenchmarkProgress(benchmarkId)).rejects
      .toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("mutation은 source hash·idempotency key·schema를 body에만 보내고 query authority를 만들지 않는다", async () => {
    const fetcher = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => response({
      accepted: true,
      source_hash: SHA_A,
    }));
    const client = new ChallengeApiClient(fetcher);
    await expect(client.postMutation({
      path: "/api/benchmarks/benchmark_1/start",
      schemaVersion: "benchmark-start-command-v1",
      expectedSourceHash: SHA_A,
      idempotencyKey: "mutation_browser_001",
      payload: { requested_by: "Synthetic evaluation owner" },
    })).resolves.toEqual({ accepted: true, source_hash: SHA_A });

    const [, init] = fetcher.mock.calls[0];
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      schema_version: "benchmark-start-command-v1",
      expected_source_hash: SHA_A,
      idempotency_key: "mutation_browser_001",
      payload: { requested_by: "Synthetic evaluation owner" },
    });
  });

  it("회귀 시작은 baseline ID를 경로에만 결합하고 빈 exact command envelope를 보낸다", async () => {
    const fetcher = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => response({
      accepted: true,
      source_hash: SHA_A,
    }));
    const client = new ChallengeApiClient(fetcher);

    await expect(client.startRegression({
      baselineId: "baseline-01",
      expectedSourceHash: SHA_A,
      idempotencyKey: "mutation_regression_001",
    })).resolves.toEqual({ accepted: true, source_hash: SHA_A });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe("/api/regressions/baseline-01/start");
    expect(JSON.parse(String(init?.body))).toEqual({
      schema_version: "regression-start-command-v1",
      expected_source_hash: SHA_A,
      idempotency_key: "mutation_regression_001",
    });
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
    });

    expect(() => client.startRegression({
      baselineId: "../baseline-01",
      expectedSourceHash: SHA_A,
      idempotencyKey: "mutation_regression_002",
    })).toThrow(ChallengeApiClientError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("409 stale/replay와 비 JSON 응답을 세부자료 없이 구분한다", async () => {
    const stale = new ChallengeApiClient(async () => response(
      { error: "STALE_SOURCE", detail: "private hash" },
      409,
    ));
    await expect(stale.postMutation({
      path: "/api/reviews/review_1/confirm",
      schemaVersion: "review-confirmation-command-v1",
      expectedSourceHash: SHA_A,
      idempotencyKey: "mutation_browser_002",
    })).rejects.toMatchObject({ code: "STALE_SOURCE", status: 409 });

    const invalidContent = new ChallengeApiClient(async () => new Response(
      "<html>error</html>",
      { status: 500, headers: { "content-type": "text/html" } },
    ));
    await expect(invalidContent.getWorkspace()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("기록된 mutation 실패의 공개 재시도·분류·receipt hash만 strict하게 보존한다", async () => {
    const failureHash = "f".repeat(64);
    const client = new ChallengeApiClient(async () => response({
      error: "REPLAYED_MUTATION",
      retry_allowed: false,
      failure_classification: "PROVIDER_TERMINAL_FAILURE",
      failure_hash: failureHash,
    }, 409));

    await expect(client.postMutation({
      path: "/api/reviews/review_1/confirm",
      schemaVersion: "review-confirmation-command-v1",
      expectedSourceHash: SHA_A,
      idempotencyKey: "mutation_browser_failure_001",
    })).rejects.toMatchObject({
      code: "REPLAYED_MUTATION",
      status: 409,
      durableFailure: {
        retryAllowed: false,
        classification: "PROVIDER_TERMINAL_FAILURE",
        failureHash,
      },
    });

    const malformed = new ChallengeApiClient(async () => response({
      error: "REPLAYED_MUTATION",
      retry_allowed: false,
      failure_classification: "PROVIDER_TERMINAL_FAILURE",
      failure_hash: "not-a-sha256",
    }, 409));
    await expect(malformed.postMutation({
      path: "/api/reviews/review_1/confirm",
      schemaVersion: "review-confirmation-command-v1",
      expectedSourceHash: SHA_A,
      idempotencyKey: "mutation_browser_failure_002",
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

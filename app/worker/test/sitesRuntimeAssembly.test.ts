import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  reset,
  type D1Migration,
} from "cloudflare:test";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createHighEntropyAccessCodeHash,
} from "../../server/sites/webCrypto";
import worker from "../index";
import {
  createSitesWorkflowLimits,
  createWorkerOpenAIClient,
  parseSitesRuntimeConfig,
  type Env,
} from "../env";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ARTIFACTS: R2Bucket;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

const ACCESS_CODE = "judge-access-code-with-32-byte-minimum";
const SESSION_SECRET = "session-secret-with-at-least-thirty-two-bytes";
const API_KEY = "worker-runtime-test-api-key-placeholder";
let accessCodeHash = "";

function runtimeEnv(
  overrides: Partial<Record<keyof Env, unknown>> = {},
): Env {
  const assetsFetch = vi.fn(async () => new Response("asset", {
    status: 200,
  }));
  return {
    ASSETS: { fetch: assetsFetch },
    DB: env.DB,
    ARTIFACTS: env.ARTIFACTS,
    DEMO_ACCESS_CODE_HASH: accessCodeHash,
    DEMO_SESSION_SECRET: SESSION_SECRET,
    OPENAI_API_KEY: API_KEY,
    DEMO_SESSION_TTL_SECONDS: "900",
    DEMO_AUTH_FAILURE_LIMIT: "5",
    DEMO_AUTH_FAILURE_WINDOW_MS: "60000",
    DEMO_AUTH_FAILURE_BLOCK_MS: "300000",
    DEMO_LEASE_DURATION_MS: "300000",
    DEMO_RESERVED_COST_MICRO_USD: "250000",
    DEMO_MAX_SUCCESSFUL_RUNS_PER_SESSION: "1",
    DEMO_MAX_OPERATIONAL_RETRIES_PER_SESSION: "1",
    DEMO_MAX_GLOBAL_CONCURRENT_RUNS: "1",
    DEMO_MAX_BUCKET_RUN_COUNT: "25",
    DEMO_MAX_BUCKET_COST_MICRO_USD: "5000000",
    DEMO_MAX_AUXILIARY_CALLS_PER_BUCKET: "25",
    ...overrides,
  } as Env;
}

beforeAll(async () => {
  accessCodeHash = await createHighEntropyAccessCodeHash({
    accessCode: ACCESS_CODE,
  });
});

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("Sites Worker 실제 환경 조립", () => {
  it("D1·R2·서버 비밀·비용 상한을 엄격한 런타임 설정으로 변환한다", () => {
    const parsed = parseSitesRuntimeConfig(runtimeEnv());

    expect(parsed).toMatchObject({
      accessCodeHash,
      sessionSecret: SESSION_SECRET,
      openAiApiKey: API_KEY,
      sessionTtlSeconds: 900,
      authFailureLimit: 5,
      authFailureWindowMs: 60_000,
      authFailureBlockMs: 300_000,
      leaseDurationMs: 300_000,
      reservedCostMicroUsd: 250_000,
      maxSuccessfulRunsPerSession: 1,
      maxOperationalRetriesPerSession: 1,
      maxGlobalConcurrentRuns: 1,
      maxBucketRunCount: 25,
      maxBucketCostMicroUsd: 5_000_000,
      maxAuxiliaryCallsPerBucket: 25,
    });
    expect(parsed.repositoryBinding).toBe(env.DB);
    expect(parsed.artifactBinding).toBe(env.ARTIFACTS);
    expect(createSitesWorkflowLimits(parsed)).toEqual({
      leaseDurationMs: 300_000,
      reservedCostMicroUsd: 250_000,
      maxSuccessfulRunsPerSession: 1,
      maxOperationalRetriesPerSession: 1,
      maxGlobalConcurrentRuns: 1,
      maxBucketRunCount: 25,
      maxBucketCostMicroUsd: 5_000_000,
      maxAuxiliaryCallsPerBucket: 25,
    });
  });

  it.each([
    ["필수 비밀 누락", { OPENAI_API_KEY: undefined }],
    ["깨진 접근 코드 hash", { DEMO_ACCESS_CODE_HASH: "not-a-valid-hash" }],
    ["선행 0 숫자", { DEMO_SESSION_TTL_SECONDS: "0900" }],
    ["보조 호출 상한 누락", {
      DEMO_MAX_AUXILIARY_CALLS_PER_BUCKET: undefined,
    }],
    ["예약 비용보다 작은 총비용 cap", {
      DEMO_MAX_BUCKET_COST_MICRO_USD: "249999",
    }],
  ])("%s 설정은 API 실행 전에 거부한다", async (_label, overrides) => {
    const response = await worker.fetch(
      new Request("https://demo.example/api/auth/session"),
      runtimeEnv(overrides),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR" },
    });
  });

  it("공식 OpenAI client의 SDK 자동 재시도를 비활성화한다", () => {
    const client = createWorkerOpenAIClient(API_KEY);

    expect(client.maxRetries).toBe(0);
  });

  it("실제 D1 인증과 보호 router를 조립하되 비밀을 응답에 투영하지 않는다", async () => {
    const configured = runtimeEnv();
    const loginResponse = await worker.fetch(
      new Request("https://demo.example/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://demo.example",
        },
        body: JSON.stringify({ access_code: ACCESS_CODE }),
      }),
      configured,
      {} as ExecutionContext,
    );
    expect(loginResponse.status).toBe(200);
    const cookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toMatch(/^__Host-ai_challenge_session=/);

    const challengeResponse = await worker.fetch(
      new Request("https://demo.example/api/challenge", {
        headers: { cookie: cookie ?? "" },
      }),
      configured,
      {} as ExecutionContext,
    );
    const challengeText = await challengeResponse.text();

    expect(challengeResponse.status).toBe(200);
    expect(JSON.parse(challengeText)).toMatchObject({
      synthetic: true,
      locked: true,
      candidates: ["A", "B", "C"],
    });
    expect(challengeText).not.toContain(ACCESS_CODE);
    expect(challengeText).not.toContain(SESSION_SECRET);
    expect(challengeText).not.toContain(API_KEY);
  });

  it("빈 Sites D1을 저장된 마이그레이션으로 초기화한 뒤 로그인을 처리한다", async () => {
    await reset();
    const configured = runtimeEnv();

    const loginResponse = await worker.fetch(
      new Request("https://demo.example/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://demo.example",
        },
        body: JSON.stringify({ access_code: ACCESS_CODE }),
      }),
      configured,
      {} as ExecutionContext,
    );

    expect(loginResponse.status).toBe(200);
    const tables = await env.DB.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('demo_sessions', 'auth_failure_buckets', 'auxiliary_call_attempts')
      ORDER BY name
    `).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "auth_failure_buckets",
      "auxiliary_call_attempts",
      "demo_sessions",
    ]);
  });

  it("정적 asset은 서버 비밀이 없어도 ASSETS binding으로 직접 전달한다", async () => {
    const configured = runtimeEnv({
      DEMO_ACCESS_CODE_HASH: undefined,
      DEMO_SESSION_SECRET: undefined,
      OPENAI_API_KEY: undefined,
    });
    const response = await worker.fetch(
      new Request("https://demo.example/assets/app.js"),
      configured,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset");
  });
});

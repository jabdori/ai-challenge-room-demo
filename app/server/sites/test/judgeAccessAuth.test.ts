// @vitest-environment node

import { describe, expect, it } from "vitest";
import { InMemoryDemoStateRepository } from "../inMemoryDemoStateRepository";
import {
  createJudgeAccessAuth,
  SESSION_COOKIE_NAME,
} from "../judgeAccessAuth";
import {
  createPbkdf2AccessCodeHash,
  hmacSha256Base64Url,
} from "../webCrypto";

const ACCESS_CODE = "approved judge access";
const SESSION_SECRET = "session-secret-for-tests-only-32-bytes";
const NETWORK = "203.0.113.10";
const SALT = Uint8Array.from({ length: 16 }, (_, index) => 31 - index);

function request(
  path: string,
  init: RequestInit = {},
  cookie?: string,
): Request {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", NETWORK);
  if (cookie) headers.set("cookie", cookie);
  return new Request(`https://demo.example${path}`, {
    ...init,
    headers,
  });
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

async function fixture(overrides: {
  accessCodeHash?: string;
  authFailureLimit?: number;
  reportInfrastructureError?: (
    stage: string,
    kind: string,
  ) => void;
} = {}) {
  let nowMs = Date.UTC(2026, 6, 19, 0, 0, 0);
  let randomCall = 0;
  const repository = new InMemoryDemoStateRepository();
  const accessCodeHash = overrides.accessCodeHash
    ?? await createPbkdf2AccessCodeHash({
      accessCode: ACCESS_CODE,
      iterations: 120_000,
      salt: SALT,
    });
  const auth = createJudgeAccessAuth({
    repository,
    accessCodeHash,
    sessionSecret: SESSION_SECRET,
    now: () => nowMs,
    randomBytes: (length) => {
      randomCall += 1;
      return Uint8Array.from(
        { length },
        (_, index) => (index + randomCall) % 256,
      );
    },
    sessionTtlSeconds: 900,
    authFailureLimit: overrides.authFailureLimit ?? 3,
    authFailureWindowMs: 60_000,
    authFailureBlockMs: 120_000,
    reportInfrastructureError: overrides.reportInfrastructureError,
  });
  return {
    auth,
    repository,
    setNow(value: number) {
      nowMs = value;
    },
    now() {
      return nowMs;
    },
  };
}

describe("Sites 심사위원 접근 인증", () => {
  it("인증 저장소 오류는 비밀값 없이 고정된 단계 코드만 진단한다", async () => {
    const diagnostics: Array<{
      readonly stage: string;
      readonly kind: string;
    }> = [];
    const { auth, repository } = await fixture({
      reportInfrastructureError: (stage, kind) => {
        diagnostics.push({ stage, kind });
      },
    });
    repository.readActiveAuthFailure = async () => {
      throw new Error("private D1 detail");
    };

    await expect(auth.handleAuthRoute(request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_code: ACCESS_CODE }),
    }))).rejects.toThrow("private D1 detail");

    expect(diagnostics).toEqual([{
      stage: "AUTH_BLOCK_LOOKUP_FAILED",
      kind: "ERROR",
    }]);
    expect(JSON.stringify(diagnostics)).not.toContain(ACCESS_CODE);
    expect(JSON.stringify(diagnostics)).not.toContain(NETWORK);
    expect(JSON.stringify(diagnostics)).not.toContain("private D1 detail");
  });

  it("성공 시 서명된 보안 쿠키를 만들고 token digest만 저장한다", async () => {
    const { auth, repository } = await fixture();
    const response = await auth.handleAuthRoute(request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_code: ACCESS_CODE }),
    }));

    expect(response?.status).toBe(200);
    const setCookie = response?.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=900");
    expect(setCookie).not.toMatch(/\bDomain=/i);

    const rawToken = cookiePair(setCookie)
      .slice(`${SESSION_COOKIE_NAME}=`.length)
      .split(".", 1)[0] ?? "";
    const sessions = repository.inspectSessionsForTest();
    expect(sessions).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain(rawToken);
    expect(sessions[0]?.sessionTokenDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await expect(auth.authenticate(request(
      "/api/challenge",
      {},
      cookiePair(setCookie),
    ))).resolves.toMatchObject({
      sessionTokenDigest: sessions[0]?.sessionTokenDigest,
      revokedAtMs: null,
    });
  });

  it("만료·폐기·잘못된 서명·중복 cookie를 모두 인증하지 않는다", async () => {
    const { auth, repository, setNow, now } = await fixture();
    const login = await auth.handleAuthRoute(request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_code: ACCESS_CODE }),
    }));
    const cookie = cookiePair(login?.headers.get("set-cookie") ?? "");

    const [name, value = ""] = cookie.split("=", 2);
    const [token] = value.split(".");
    await expect(auth.authenticate(request(
      "/api/challenge",
      {},
      `${name}=${token}.invalid`,
    ))).resolves.toBeNull();
    await expect(auth.authenticate(request(
      "/api/challenge",
      {},
      `${cookie}; ${cookie}`,
    ))).resolves.toBeNull();

    const logout = await auth.handleAuthRoute(request("/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }, cookie));
    expect(logout?.status).toBe(200);
    expect(logout?.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(repository.inspectSessionsForTest()).toMatchObject([
      {
        revokedAtMs: now(),
        currentExecutionId: null,
      },
    ]);
    await expect(auth.authenticate(request(
      "/api/challenge",
      {},
      cookie,
    ))).resolves.toBeNull();

    const secondLogin = await auth.handleAuthRoute(request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_code: ACCESS_CODE }),
    }));
    expect(repository.inspectSessionsForTest()).toMatchObject([
      {
        revokedAtMs: now(),
      },
      {
        revokedAtMs: null,
        currentExecutionId: null,
      },
    ]);
    const secondCookie = cookiePair(secondLogin?.headers.get("set-cookie") ?? "");
    setNow(now() + 901_000);
    await expect(auth.authenticate(request(
      "/api/challenge",
      {},
      secondCookie,
    ))).resolves.toBeNull();
  });

  it("잘못된 코드·빈 코드·깨진 hash는 동일한 공개 오류만 반환한다", async () => {
    const good = await fixture();
    const malformed = await fixture({
      accessCodeHash: "not-a-valid-hash",
    });

    const responses = await Promise.all([
      good.auth.handleAuthRoute(request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access_code: "wrong" }),
      })),
      good.auth.handleAuthRoute(request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access_code: "" }),
      })),
      malformed.auth.handleAuthRoute(request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access_code: ACCESS_CODE }),
      })),
    ]);

    for (const response of responses) {
      expect(response?.status).toBe(401);
      expect(await response?.json()).toEqual({
        error: { code: "ACCESS_DENIED" },
      });
    }
  });

  it("인증 실패는 원시 IP가 아닌 domain-separated HMAC fingerprint로 제한한다", async () => {
    const { auth, repository } = await fixture({ authFailureLimit: 2 });
    const attempt = () => auth.handleAuthRoute(request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_code: "wrong" }),
    }));

    expect((await attempt())?.status).toBe(401);
    expect((await attempt())?.status).toBe(429);
    const blocked = await attempt();
    expect(blocked?.status).toBe(429);
    expect(await blocked?.json()).toEqual({
      error: { code: "RATE_LIMITED" },
    });

    const failures = repository.inspectAuthFailuresForTest();
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures)).not.toContain(NETWORK);
    expect(failures[0]?.networkFingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("차단 만료 전에는 시간 bucket이 바뀌어도 인증 제한을 우회하지 못한다", async () => {
    const { auth, setNow, now } = await fixture({ authFailureLimit: 2 });
    const attempt = () => auth.handleAuthRoute(request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_code: "wrong" }),
    }));

    expect((await attempt())?.status).toBe(401);
    expect((await attempt())?.status).toBe(429);
    setNow(now() + 61_000);
    expect((await attempt())?.status).toBe(429);
  });

  it("더 최신 비차단 bucket이 있어도 이전 bucket의 활성 차단을 우회하지 못한다", async () => {
    const { auth, repository, setNow, now } = await fixture();
    const startedAt = now();
    const networkFingerprint = await hmacSha256Base64Url({
      secret: SESSION_SECRET,
      domain: "auth-failure:v1",
      value: NETWORK,
    });
    await repository.recordAuthFailure({
      networkFingerprint,
      bucketStartedAtMs: startedAt,
      failureCount: 3,
      blockedUntilMs: startedAt + 120_000,
    });
    await repository.recordAuthFailure({
      networkFingerprint,
      bucketStartedAtMs: startedAt + 60_000,
      failureCount: 1,
      blockedUntilMs: null,
    });
    setNow(startedAt + 61_000);

    const response = await auth.handleAuthRoute(request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_code: ACCESS_CODE }),
    }));
    expect(response?.status).toBe(429);
  });
});

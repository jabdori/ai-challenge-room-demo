// @vitest-environment node

import { describe, expect, it } from "vitest";
import { InMemoryDemoStateRepository } from "../inMemoryDemoStateRepository";
import { createJudgeAccessAuth } from "../judgeAccessAuth";
import { createPbkdf2AccessCodeHash } from "../webCrypto";

async function handler() {
  const accessCodeHash = await createPbkdf2AccessCodeHash({
    accessCode: "approved",
    iterations: 120_000,
    salt: Uint8Array.from({ length: 16 }, (_, index) => index),
  });
  return createJudgeAccessAuth({
    repository: new InMemoryDemoStateRepository(),
    accessCodeHash,
    sessionSecret: "route-test-session-secret-at-least-32",
    now: () => Date.UTC(2026, 6, 19),
    randomBytes: (length) => Uint8Array.from(
      { length },
      (_, index) => index + 1,
    ),
  });
}

describe("Sites 공개 인증 route", () => {
  it("공개 allowlist 세 경로만 정확한 method로 처리한다", async () => {
    const auth = await handler();

    const session = await auth.handleAuthRoute(
      new Request("https://demo.example/api/auth/session"),
    );
    expect(session?.status).toBe(200);
    expect(await session?.json()).toEqual({ authenticated: false });

    await expect(auth.handleAuthRoute(
      new Request("https://demo.example/api/challenge"),
    )).resolves.toBeNull();
    const wrongMethod = await auth.handleAuthRoute(
      new Request("https://demo.example/api/auth/login"),
    );
    expect(wrongMethod?.status).toBe(404);
  });

  it("JSON 객체가 아닌 login도 입력 세부정보 없이 ACCESS_DENIED로 응답한다", async () => {
    const auth = await handler();
    const responses = await Promise.all([
      auth.handleAuthRoute(new Request("https://demo.example/api/auth/login", {
        method: "POST",
        body: "{}",
      })),
      auth.handleAuthRoute(new Request("https://demo.example/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "[]",
      })),
      auth.handleAuthRoute(new Request("https://demo.example/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          access_code: "approved",
          unexpected: true,
        }),
      })),
    ]);

    for (const response of responses) {
      expect(response?.status).toBe(401);
      expect(await response?.json()).toEqual({
        error: { code: "ACCESS_DENIED" },
      });
      expect(response?.headers.get("cache-control")).toBe("no-store");
    }
  });
});

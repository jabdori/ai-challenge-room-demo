import { describe, expect, it, vi } from "vitest";
import worker, {
  createSitesWorker,
} from "../index";

function envFixture() {
  const fetch = vi.fn(async () => new Response("asset-response", {
    status: 200,
  }));
  return {
    env: {
      ASSETS: { fetch },
    } as never,
    fetch,
  };
}

describe("Sites Worker 보호 API 통합", () => {
  it("Worker entry가 주입 가능한 API factory seam을 공개한다", async () => {
    const api = vi.fn(async () => Response.json({ ok: true }));
    const createApi = vi.fn(() => api);
    const injectedWorker = createSitesWorker({ createApi });
    const { env, fetch } = envFixture();

    const response = await injectedWorker.fetch(
      new Request("https://demo.example/api/challenge"),
      env,
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(createApi).toHaveBeenCalledWith(env);
    expect(api).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("정적 경로는 Sites assets binding으로 fallback한다", async () => {
    const api = vi.fn();
    const injectedWorker = createSitesWorker({
      createApi: () => api,
    });
    const { env, fetch } = envFixture();
    const request = new Request("https://demo.example/assets/app.js");

    const response = await injectedWorker.fetch(
      request,
      env,
      {} as never,
    );

    expect(await response.text()).toBe("asset-response");
    expect(fetch).toHaveBeenCalledWith(request);
    expect(api).not.toHaveBeenCalled();
  });

  it("필수 서버 환경이 없는 기본 Worker의 API는 generic 500으로 fail-closed 차단한다", async () => {
    const response = await worker.fetch(
      new Request("https://demo.example/api/unknown"),
      {} as never,
      {} as never,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR" },
    });
  });

  it("주입 factory 예외의 내부 메시지를 노출하지 않는다", async () => {
    const injectedWorker = createSitesWorker({
      createApi: () => {
        throw new Error("private worker assembly detail");
      },
    });
    const { env } = envFixture();

    const response = await injectedWorker.fetch(
      new Request("https://demo.example/api/challenge"),
      env,
      {} as never,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR" },
    });
  });
});

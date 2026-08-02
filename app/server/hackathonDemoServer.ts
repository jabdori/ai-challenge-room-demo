import type {
  ConfirmDemoReviewInput,
  CreateDemoMemoInput,
  HackathonDemoController,
} from "./hackathonDemoController";

const JSON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: JSON_HEADERS,
  });
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new TypeError("JSON content-type이 필요합니다.");
  }
  const value = await request.json() as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("요청 본문은 JSON 객체여야 합니다.");
  }
  return value as Record<string, unknown>;
}

function publicError(error: unknown): string {
  return error instanceof Error ? error.message : "데모 요청이 실패했습니다.";
}

/**
 * 실제 OpenAI 호출은 controller의 어댑터 경계 안에서만 일어납니다.
 * 이 handler는 동일 출처 브라우저 데모가 필요한 네 상태 전이만 노출합니다.
 */
export function createHackathonDemoApiHandler(
  controller: HackathonDemoController,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/demo/state") {
        return json(controller.getState());
      }
      if (request.method !== "POST") {
        return json({ error: "Not found" }, 404);
      }
      if (url.pathname === "/api/demo/judge") {
        await readJsonObject(request);
        return json(await controller.runJudge());
      }
      if (url.pathname === "/api/demo/review") {
        const body = await readJsonObject(request);
        return json(await controller.confirmReview(
          body as unknown as ConfirmDemoReviewInput,
        ));
      }
      if (url.pathname === "/api/demo/memo") {
        const body = await readJsonObject(request);
        return json(await controller.createMemo(
          body as unknown as CreateDemoMemoInput,
        ));
      }
      if (url.pathname === "/api/demo/regression") {
        await readJsonObject(request);
        return json(await controller.replayRepresentativeDefect());
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: publicError(error) }, 409);
    }
  };
}

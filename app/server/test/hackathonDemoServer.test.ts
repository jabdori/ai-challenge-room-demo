// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { HackathonDemoState } from "../../shared/hackathonDemo";
import type { HackathonDemoController } from "../hackathonDemoController";
import { createHackathonDemoApiHandler } from "../hackathonDemoServer";

const state = {
  schema_version: "hackathon-demo-state-v1",
  source: "RECORDED_FALLBACK",
  status: "JUDGE_REQUIRED",
} as unknown as HackathonDemoState;

function controller(): HackathonDemoController {
  return {
    getState: vi.fn(() => state),
    runJudge: vi.fn(async () => state),
    confirmReview: vi.fn(async () => state),
    selectCandidate: vi.fn(() => state),
    createMemo: vi.fn(async () => state),
    replayRepresentativeDefect: vi.fn(async () => state),
  };
}

function request(path: string, body: unknown = {}): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("해커톤 데모 API handler", () => {
  it("상태 조회와 잠긴 네 mutation 경로만 controller에 연결한다", async () => {
    const target = controller();
    const handler = createHackathonDemoApiHandler(target);

    expect((await handler(new Request("http://127.0.0.1/api/demo/state"))).status).toBe(200);
    expect((await handler(request("/api/demo/judge"))).status).toBe(200);
    expect((await handler(request("/api/demo/review", {
      reviewer: "owner",
      rationale: "reviewed",
      decisions: [],
    }))).status).toBe(200);
    expect((await handler(request("/api/demo/memo", {
      selected_candidate_id: "A",
      rationale: "selected",
    }))).status).toBe(200);
    expect((await handler(request("/api/demo/regression"))).status).toBe(200);

    expect(target.getState).toHaveBeenCalledTimes(1);
    expect(target.runJudge).toHaveBeenCalledTimes(1);
    expect(target.confirmReview).toHaveBeenCalledTimes(1);
    expect(target.createMemo).toHaveBeenCalledTimes(1);
    expect(target.replayRepresentativeDefect).toHaveBeenCalledTimes(1);
  });

  it("알 수 없는 경로와 JSON이 아닌 mutation을 거부한다", async () => {
    const handler = createHackathonDemoApiHandler(controller());
    expect((await handler(new Request("http://127.0.0.1/api/demo/unknown"))).status).toBe(404);
    expect((await handler(new Request("http://127.0.0.1/api/demo/judge", {
      method: "POST",
      body: "{}",
    }))).status).toBe(409);
  });
});

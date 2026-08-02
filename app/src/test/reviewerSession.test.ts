import { describe, expect, it, vi } from "vitest";
import { ChallengeApiClient } from "../data/challengeApi";
import {
  REVIEWER_SESSION_STORAGE_KEY,
  bootstrapReviewerSession,
} from "../data/reviewerSession";

const TOKEN = `rvw_${"a".repeat(43)}`;
const SHA_A = "a".repeat(64);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fragment-only reviewer session bootstrap", () => {
  it("fragment token만 sessionStorage에 옮긴 뒤 즉시 URL에서 제거하고 localStorage에는 쓰지 않는다", () => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState({}, "", `/?view=decide#reviewer_token=${TOKEN}`);

    expect(bootstrapReviewerSession()).toBe(TOKEN);
    expect(window.sessionStorage.getItem(REVIEWER_SESSION_STORAGE_KEY)).toBe(TOKEN);
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?view=decide");
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.localStorage.getItem(REVIEWER_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("Challenge API client는 reviewer projection/detail/confirm에만 session token을 첨부한다", async () => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", `/#reviewer_token=${TOKEN}`);
    bootstrapReviewerSession();
    const fetcher = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if (path === "/api/reviews/review_1") return json({
        schema_version: "preconfirmation-public-projection-v1",
        synthetic: true,
        review_id: "review_1",
        source_hash: SHA_A,
      });
      if (path === "/api/reviewer/evidence/evidence_1") return json({
        schema_version: "recorded-blind-review-evidence-detail-v1",
        synthetic: true,
      });
      if (path === "/api/workspace") return json({
        schema_version: "workspace-public-projection-v1",
        synthetic: true,
      });
      return json({ accepted: true, source_hash: SHA_A });
    });
    const client = new ChallengeApiClient(fetcher);

    await client.getPreconfirmation("review_1");
    await client.getReviewerEvidence("evidence_1", `evh_${SHA_A}`);
    await client.postMutation({
      path: "/api/reviews/review_1/confirm",
      schemaVersion: "review-confirmation-command-v1",
      expectedSourceHash: SHA_A,
      idempotencyKey: "mutation_reviewer_session_001",
    });
    await client.getWorkspace();
    await client.postMutation({
      path: "/api/decisions/decision_1/memo",
      schemaVersion: "decision-memo-command-v1",
      expectedSourceHash: SHA_A,
      idempotencyKey: "mutation_reviewer_session_002",
    });

    const reviewerCalls = fetcher.mock.calls.filter(([input]) => (
      String(input).startsWith("/api/reviews/")
      || String(input).startsWith("/api/reviewer/evidence/")
    ));
    expect(reviewerCalls).toHaveLength(3);
    expect(reviewerCalls.every(([, init]) => (
      (init?.headers as Record<string, string>).authorization === `Bearer ${TOKEN}`
    ))).toBe(true);
    const publicCalls = fetcher.mock.calls.filter(([input]) => (
      String(input) === "/api/workspace"
      || String(input) === "/api/decisions/decision_1/memo"
    ));
    expect(publicCalls).toHaveLength(2);
    expect(publicCalls.every(([, init]) => (
      !("authorization" in (init?.headers as Record<string, string>))
    ))).toBe(true);
  });
});

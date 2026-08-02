// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  startAuthoritativeWorkspaceServer,
} from "../nodeWorkspaceServer";
import { createReviewerSession } from "../reviewerSessionAuth";
import type { ChallengeApiGateway, ChallengeMutationJournal } from "../challengeServer";

const SHA_A = "a".repeat(64);

function gateway(): ChallengeApiGateway & {
  readonly getReviewerBlindEvidenceDetail: ReturnType<typeof vi.fn>;
} {
  const notFound = vi.fn(async () => null);
  const accepted = vi.fn(async (command: { expected_source_hash: string }) => ({
    accepted: true as const,
    source_hash: command.expected_source_hash,
  }));
  return {
    getWorkspace: vi.fn(async () => ({
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
    })),
    getChallenge: notFound,
    getEvidence: notFound,
    getBenchmarkProgress: notFound,
    getBlindReview: vi.fn(async (id: string) => ({
      schema_version: "preconfirmation-public-projection-v1",
      synthetic: true,
      review_id: id,
      source_hash: SHA_A,
    })),
    getReviewerBlindEvidenceDetail: vi.fn(async () => ({
      schema_version: "recorded-blind-review-evidence-detail-v1",
      synthetic: true,
    })),
    getDecision: notFound,
    getBaseline: notFound,
    getRegression: notFound,
    structureDefine: accepted,
    lockChallenge: accepted,
    startBenchmark: accepted,
    confirmReview: accepted,
    createDecisionMemo: accepted,
    confirmDecision: accepted,
    startRegression: accepted,
  };
}

const journal: ChallengeMutationJournal = {
  execute: async (_command, operation) => operation(),
};

function headers(origin: string, token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    origin,
    "sec-fetch-site": "same-origin",
  };
}

describe("authoritative Node reviewer authentication", () => {
  it("listen한 production server는 public workspace를 유지하면서 reviewer token·origin을 강제하고 restart에 token을 회전한다", async () => {
    const firstSession = createReviewerSession({
      randomBytes: (size) => Buffer.alloc(size, 0x11),
    });
    const api = gateway();
    const first = await startAuthoritativeWorkspaceServer({
      gateway: api,
      mutationJournal: journal,
      reviewerSession: firstSession,
    });
    try {
      expect(first.reviewerBootstrapUrl).toBe(
        `${first.origin}/#reviewer_token=${firstSession.reviewerToken}`,
      );
      expect(new URL(first.reviewerBootstrapUrl!).search).toBe("");
      expect(await fetch(`${first.origin}/api/workspace`)).toHaveProperty("status", 200);

      const missing = await fetch(`${first.origin}/api/reviews/review_1`, {
        headers: { "sec-fetch-site": "same-origin" },
      });
      expect(missing.status).toBe(401);
      expect(api.getBlindReview).not.toHaveBeenCalled();

      const crossOrigin = await fetch(`${first.origin}/api/reviews/review_1`, {
        headers: headers(first.origin, firstSession.reviewerToken),
      });
      expect(crossOrigin.status).toBe(200);
      expect(api.getBlindReview).toHaveBeenCalledWith("review_1");

      const forbiddenConfirm = await fetch(
        `${first.origin}/api/reviews/review_1/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schema_version: "review-confirmation-command-v1",
            expected_source_hash: SHA_A,
            idempotency_key: "mutation_reviewer_node_001",
          }),
        },
      );
      expect(forbiddenConfirm.status).toBe(401);
      expect(api.confirmReview).not.toHaveBeenCalled();
    } finally {
      await first.close();
    }

    const secondSession = createReviewerSession({
      randomBytes: (size) => Buffer.alloc(size, 0x22),
    });
    const second = await startAuthoritativeWorkspaceServer({
      gateway: api,
      mutationJournal: journal,
      reviewerSession: secondSession,
    });
    try {
      const rotated = await fetch(`${second.origin}/api/reviews/review_1`, {
        headers: headers(second.origin, firstSession.reviewerToken),
      });
      expect(rotated.status).toBe(403);
      const valid = await fetch(`${second.origin}/api/reviews/review_1`, {
        headers: headers(second.origin, secondSession.reviewerToken),
      });
      expect(valid.status).toBe(200);
    } finally {
      await second.close();
    }
  });
});

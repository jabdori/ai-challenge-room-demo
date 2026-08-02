// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createReviewerSession } from "../reviewerSessionAuth";

function reviewerRequest({
  token,
  host = "127.0.0.1:4173",
  origin = "http://127.0.0.1:4173",
  site = "same-origin",
}: {
  readonly token?: string;
  readonly host?: string;
  readonly origin?: string;
  readonly site?: string;
} = {}): Request {
  return new Request(`http://${host}/api/reviews/review_1`, {
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      host,
      origin,
      "sec-fetch-site": site,
    },
  });
}

describe("reviewer principal session", () => {
  it("startup마다 256-bit 난수 token의 hash만 authorizer에 보관하고 constant-time으로 검증한다", () => {
    const randomBytes = vi.fn((size: number) => Buffer.alloc(size, 0x11));
    const first = createReviewerSession({ randomBytes });
    const second = createReviewerSession({
      randomBytes: (size) => Buffer.alloc(size, 0x22),
    });

    expect(randomBytes).toHaveBeenCalledWith(32);
    expect(first.reviewerToken).toMatch(/^rvw_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(first.authorizer)).not.toContain(first.reviewerToken);
    expect(first.authorizer.authorize(reviewerRequest({
      token: first.reviewerToken,
    }))).toBeNull();
    expect(first.authorizer.authorize(reviewerRequest())).toBe(401);
    expect(first.authorizer.authorize(reviewerRequest({
      token: second.reviewerToken,
    }))).toBe(403);
    expect(first.authorizer.authorize(reviewerRequest({
      token: first.reviewerToken,
      origin: "http://evil.example",
    }))).toBe(403);
    expect(first.authorizer.authorize(reviewerRequest({
      token: first.reviewerToken,
      site: "cross-site",
    }))).toBe(403);
  });
});

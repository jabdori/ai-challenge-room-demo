// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildRecordedBlindReviewEvidenceDetailProjection,
} from "../recordedBlindReviewEvidence";

describe("Blind review Evidence authority boundary", () => {
  it("source-reloaded authority가 없는 임의 queue 객체를 거부한다", () => {
    expect(() => buildRecordedBlindReviewEvidenceDetailProjection(
      { blind_review_queue: { items: [] } } as never,
      "H-007--X",
    )).toThrow(/source|Recorded Benchmark|저장|검증/i);
  });
});

// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildProvisionalDecisionMemo,
  persistProvisionalDecisionMemo,
} from "../decision/provisionalMemo";

describe("Provisional Decision Memo 권위 경계", () => {
  it("fabricated plain Benchmark·queue·pre-review로 Memo 또는 persistence claim을 만들 수 없다", async () => {
    const source = Object.freeze({
      schema_version: "forged-v1",
      artifact_kind: "FORGED",
    });

    expect(() => buildProvisionalDecisionMemo({
      benchmarkPack: source as never,
      queue: source as never,
      preReviewReceipt: source as never,
      createdAt: "2026-07-17T03:05:00.000Z",
    })).toThrow(/검증|authoritative|artifact chain|queue|pre-review|Benchmark/i);

    await expect(persistProvisionalDecisionMemo({
      outputDirectory: "/tmp/fabricated-provisional-memo-must-not-write",
      memo: source as never,
    })).rejects.toThrow(/검증|build|Memo/i);
  });
});

// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildAiPreReviewReceipt,
  isAiPreReviewProposalEvidenceConflict,
  persistAiPreReviewReceipt,
} from "../review/preReviewReceipt";

describe("AI decision-owner pre-review 권위 경계", () => {
  it("Judge RISK는 결정적 gate PASS 제안을 차단하지 않고 사람 검수 근거로만 남긴다", () => {
    expect(isAiPreReviewProposalEvidenceConflict({
      proposedDecision: "PROPOSED_PASS",
      deterministicGateFinding: "NONE",
      judgeRiskCount: 1,
    })).toBe(false);
    expect(isAiPreReviewProposalEvidenceConflict({
      proposedDecision: "PROPOSED_CONFIRMED_FAIL",
      deterministicGateFinding: "NONE",
      judgeRiskCount: 0,
    })).toBe(true);
  });

  it("fabricated plain Benchmark와 queue로 pre-review receipt를 만들거나 claim을 선점할 수 없다", async () => {
    const fabricatedBenchmark = Object.freeze({
      schema_version: "benchmark-execution-pack-v1",
      artifact_kind: "BENCHMARK_EXECUTION_PACK",
      execution_hash: "a".repeat(64),
    });
    const fabricatedQueue = Object.freeze({
      schema_version: "blind-review-queue-v2",
      artifact_kind: "BLIND_REVIEW_QUEUE",
      execution_pack_hash: "a".repeat(64),
      queue_content_hash: "b".repeat(64),
      queue_set_order_hash: "c".repeat(64),
      items: [],
    });
    const command = {
      schema_version: "ai-pre-review-command-v1",
      reviewer_label: "Decision owner",
      expected_recorded_benchmark_pack_hash: "a".repeat(64),
      expected_judge_evidence_hash: "d".repeat(64),
      expected_queue_content_hash: "b".repeat(64),
      expected_queue_set_order_hash: "c".repeat(64),
      items: [],
      reviewed_at: "2026-07-17T03:00:00.000Z",
    };

    expect(() => buildAiPreReviewReceipt({
      benchmarkPack: fabricatedBenchmark as never,
      queue: fabricatedQueue as never,
      command: command as never,
    })).toThrow(/검증|authoritative|artifact chain|queue|Benchmark/i);

    await expect(persistAiPreReviewReceipt({
      outputDirectory: "/tmp/fabricated-pre-review-must-not-write",
      receipt: {
        schema_version: "ai-pre-review-receipt-v1",
        artifact_kind: "AI_PRE_REVIEW_RECEIPT",
      } as never,
    })).rejects.toThrow(/검증|build|receipt/i);
  });
});

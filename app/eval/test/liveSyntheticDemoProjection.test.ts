// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { CandidateOutput } from "../contracts/candidateOutput";
import {
  buildLiveSingleRunPack,
  type BuildLiveSingleRunPackInput,
} from "../demo/liveSingleRunPack";
import {
  buildLiveSyntheticDemoProjection,
} from "../demo/liveSyntheticDemoProjection";
import type { CandidateRunRecord } from "../runner/types";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

const OUTPUT: CandidateOutput = {
  customer_reply:
    "The order has shipped and cannot be cancelled. You may request a return after delivery.",
  decision: {
    intent_codes: ["ORDER_CANCELLATION"],
    action_code: "DENY_CANCEL_AFTER_SHIPMENT",
    escalation_required: false,
    escalation_reason_code: "NOT_REQUIRED",
    target_queue: "NONE",
  },
  citations: [{ source_id: "CANCEL-2026", section_id: "2.2" }],
};

function run(candidateId: "A" | "B" | "C"): CandidateRunRecord {
  return {
    runNumber: 1,
    status: "COMPLETE",
    attempts: [{
      attemptNumber: 1,
      status: "COMPLETE",
      startedAt: "2026-07-19T00:00:00.000Z",
      latencyMs: 100,
      responseId: `resp_private_${candidateId}`,
      modelReportedId: "gpt-5.6-terra-2026-07-17",
      serviceTierReported: "default",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 20,
      },
      executionEvidence: {
        providerCalls: [{
          callNumber: 1,
          responseId: `resp_private_${candidateId}`,
          status: "completed",
          modelRequestedId: "gpt-5.6-terra",
          modelReportedId: "gpt-5.6-terra-2026-07-17",
          serviceTierRequested: "default",
          serviceTierReported: "default",
          latencyMs: 90,
          usage: {
            inputTokens: 100,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 20,
          },
        }],
        retrievalCalls: candidateId === "B"
          ? [{
              callNumber: 1,
              operation: "VECTOR_STORE_SEARCH",
              status: "COMPLETE",
              requestedQuery:
                "active shipped-order cancellation policy as of 2026-07-17",
              reportedQuery: null,
              vectorStoreId: "vs_private_live_demo",
              maxNumResults: 2,
              rewriteQuery: false,
              latencyMs: 10,
              results: [{
                rank: 1,
                fileId: "file-private-active",
                filename: "active-policy.json",
                score: 0.99,
                sourceId: "CANCEL-2026",
                sectionId: "2.2",
                factId: "cancel-after-shipment",
                text: "A shipped order cannot be cancelled.",
              }],
            }]
          : [],
        toolCalls: [],
      },
    }],
    output: structuredClone(OUTPUT),
    totalLatencyMs: 100,
  };
}

function packInput(): BuildLiveSingleRunPackInput {
  return {
    createdAt: "2026-07-19T00:10:00.000Z",
    entries: (["A", "B", "C"] as const).map((candidateId) => ({
      candidateId,
      run: run(candidateId),
    })),
  };
}

describe("1회 라이브 공개 projection", () => {
  it("private provider·retrieval ID를 제거하고 live source와 single-run 경계를 투영한다", () => {
    const pack = buildLiveSingleRunPack(packInput());
    const projection = buildLiveSyntheticDemoProjection(pack);
    const serialized = JSON.stringify(projection);

    expect(projection).toMatchObject({
      schema_version: "live-synthetic-demo-projection-v1",
      artifact_kind: "LIVE_SYNTHETIC_DEMO_PROJECTION",
      source: "LIVE_SYNTHETIC_DEMO",
      evaluation_status: "EVALUATION_INCOMPLETE",
      baseline_version: null,
      stability: "SINGLE_RUN_NOT_MEASURED",
      source_hash: sha256CanonicalJson(pack),
      coverage: {
        cases: 1,
        candidates: 3,
        runs_per_candidate: 1,
        expected_runs: 3,
      },
    });
    expect(projection.candidates.every((candidate) => candidate.runs.length === 1))
      .toBe(true);
    expect(serialized).not.toMatch(
      /vectorStoreId|vector_store_id|uploadedFileId|file_id|response_id/i,
    );
    expect(serialized).not.toMatch(/\b(?:vs_|file-|resp_)[A-Za-z0-9_-]{8,}\b/);
  });

  it("full pack의 비용이나 실행 증거가 변조되면 projection을 만들지 않는다", () => {
    const pack = structuredClone(
      buildLiveSingleRunPack(packInput()),
    ) as unknown as {
      entries: Array<{ runtime_cost_usd: number }>;
    };
    pack.entries[0].runtime_cost_usd += 1;

    expect(() => buildLiveSyntheticDemoProjection(pack)).toThrow(
      /canonical|비용|무결성/i,
    );
  });
});

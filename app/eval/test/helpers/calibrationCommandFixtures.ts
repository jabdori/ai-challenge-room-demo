import type { PartialCalibrationPack } from "../../pack/calibrationPack";
import type { PolicyVectorStoreCleanupResult } from "../../retrieval/policyVectorStore";

export const TEST_RESOURCE_IDS = Object.freeze({
  vectorStoreId: "vs-private-calibration",
  uploadedFileIds: ["file-private-active", "file-private-retired"],
});

export function completeCleanup(): PolicyVectorStoreCleanupResult {
  return {
    vectorStore: {
      id: TEST_RESOURCE_IDS.vectorStoreId,
      attempted: true,
      deleted: true,
    },
    uploadedFiles: TEST_RESOURCE_IDS.uploadedFileIds.map((id) => ({
      id,
      attempted: true,
      deleted: true,
    })),
  };
}

export function buildSummaryPack({
  failedGateCandidate,
  invalidCandidate,
}: {
  failedGateCandidate?: "A" | "B" | "C";
  invalidCandidate?: "A" | "B" | "C";
} = {}): PartialCalibrationPack {
  const candidates = (["A", "B", "C"] as const).map((candidateId) => ({
    candidate_id: candidateId,
    evaluation_pack: {
      candidate_id: candidateId,
      candidate_version: `candidate-${candidateId.toLowerCase()}-v1`,
      model_requested_id: "gpt-5.6-terra",
      model_reported_ids: ["gpt-5.6-terra-2026-07-17"],
      total_runtime_cost_usd: 999,
      runs: [1, 2].map((runNumber) => ({
        execution: {
          runNumber,
          status: invalidCandidate === candidateId ? "INVALID" : "COMPLETE",
          attempts: [{
            attemptNumber: 1,
            status: invalidCandidate === candidateId ? "INVALID_OUTPUT" : "COMPLETE",
            startedAt: "2026-07-17T00:00:00.000Z",
            latencyMs: 10,
            modelReportedId: "gpt-5.6-terra-2026-07-17",
            usage: {
              inputTokens: 100,
              cachedInputTokens: 10,
              cacheWriteTokens: 0,
              outputTokens: 20,
            },
            executionEvidence: {
              providerCalls: [{
                callNumber: 1,
                responseId: `resp-${candidateId}-${runNumber}`,
                status: "completed",
                modelRequestedId: "gpt-5.6-terra",
                modelReportedId: "gpt-5.6-terra-2026-07-17",
                serviceTierRequested: "default",
                serviceTierReported: "default",
                latencyMs: 8,
                usage: {
                  inputTokens: 100,
                  cachedInputTokens: 10,
                  cacheWriteTokens: 0,
                  outputTokens: 20,
                },
              }],
              retrievalCalls: candidateId === "B" ? [{
                callNumber: 1,
                operation: "VECTOR_STORE_SEARCH",
                status: "COMPLETE",
                requestedQuery: "locked query",
                reportedQuery: null,
                vectorStoreId: TEST_RESOURCE_IDS.vectorStoreId,
                maxNumResults: 2,
                rewriteQuery: false,
                latencyMs: 2,
                results: [],
              }] : [],
              toolCalls: [],
            },
          }],
          totalLatencyMs: 999,
        },
        gate: invalidCandidate === candidateId
          ? { runNumber, evaluation: "NOT_EVALUATED", reason: "INVALID_OUTPUT" }
          : {
              runNumber,
              evaluation: "EVALUATED",
              result: {
                gateCode: "P0-HG-02",
                status: failedGateCandidate === candidateId ? "CONFIRMED_FAIL" : "PASS",
                findings: [],
              },
            },
        runtime_cost: {
          totalCostUsd: 999,
        },
      })),
    },
  }));

  return {
    schema_version: "1.0",
    artifact_kind: "PARTIAL_CALIBRATION_PACK",
    source: "CALIBRATION_SMOKE",
    evaluation_status: "EVALUATION_INCOMPLETE",
    pack_id: "calibration-pack-0123456789abcdef",
    coverage: {
      cases: 1,
      candidates: 3,
      runs_per_candidate: 2,
      expected_runs: 6,
    },
    total_runtime_cost_usd: 999,
    baseline_version: null,
    pricing_evidence: {
      pricing_as_of: "2026-07-17",
      pricing_mode: "LOCKED_SNAPSHOT",
      pricing_schedule_applied: "standard",
      pricing_schedule_reason: "locked test schedule",
      rates_per_unit: {
        input: 2.5,
        cached_input: 0.25,
        cache_write: 3.125,
        output: 15,
      },
      snapshot_hash: "a".repeat(64),
      snapshot_id: "test-pricing",
      source_retrieved_at: "2026-07-17",
      source_url: "https://example.test/pricing",
      unit_tokens: 1_000_000,
    },
    entries: candidates,
  } as unknown as PartialCalibrationPack;
}

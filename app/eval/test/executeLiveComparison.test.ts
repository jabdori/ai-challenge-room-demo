// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { CandidateOutput } from "../contracts/candidateOutput";
import {
  CandidateProgressObserverError,
  type CandidateProgressEvent,
} from "../runner/progress";
import type { CandidateRunRecord } from "../runner/types";
import {
  executeLiveComparison,
  type LiveComparisonArtifactStore,
  type LiveComparisonDependencies,
} from "../demo/executeLiveComparison";
import type { PolicyVectorStoreCleanupResult } from "../retrieval/policyVectorStore";
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

const PREPARED = {
  vectorStoreId: "vs-private-live",
  uploadedFileIds: ["file-private-active", "file-private-retired"],
  files: [
    {
      uploadedFileId: "file-private-active",
      filename: "active.json",
      sourceId: "CANCEL-2026",
      sectionId: "2.2",
      factId: "active",
    },
    {
      uploadedFileId: "file-private-retired",
      filename: "retired.json",
      sourceId: "CANCEL-2025",
      sectionId: "2.2",
      factId: "retired",
    },
  ],
  ingestionStatus: "completed" as const,
  manifestSha256: "a".repeat(64),
  vectorStoreExpiresAfter: { anchor: "last_active_at" as const, days: 1 as const },
  fileExpiresAfter: { anchor: "created_at" as const, seconds: 86_400 as const },
  uploadMethod: "FILES_CREATE_AND_BOUNDED_VECTOR_STORE_POLL" as const,
};

function completeCleanup(
  fileDeleted = true,
): PolicyVectorStoreCleanupResult {
  return {
    vectorStore: {
      id: PREPARED.vectorStoreId,
      attempted: true,
      deleted: true,
    },
    uploadedFiles: PREPARED.uploadedFileIds.map((id, index) => ({
      id,
      attempted: true,
      deleted: index === 0 ? fileDeleted : true,
      ...(index === 0 && !fileDeleted ? { error: "delete not acknowledged" } : {}),
    })),
  };
}

function run(candidateId: "A" | "B" | "C"): CandidateRunRecord {
  return {
    runNumber: 1,
    status: "COMPLETE",
    attempts: [{
      attemptNumber: 1,
      status: "COMPLETE",
      startedAt: "2026-07-19T00:00:00.000Z",
      latencyMs: 100,
      responseId: `resp-private-${candidateId}`,
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
          responseId: `resp-private-${candidateId}`,
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
              reportedQuery:
                "active shipped-order cancellation policy as of 2026-07-17",
              vectorStoreId: PREPARED.vectorStoreId,
              maxNumResults: 2,
              rewriteQuery: false,
              latencyMs: 20,
              results: [{
                rank: 1,
                fileId: "file-private-active",
                filename: "active.json",
                score: 0.99,
                sourceId: "CANCEL-2026",
                sectionId: "2.2",
                factId: "active",
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

function artifactStore() {
  const persisted: Array<{ namespace: string; value: unknown }> = [];
  const store: LiveComparisonArtifactStore = {
    putContentAddressed: vi.fn(async (input) => {
      const value = JSON.parse(new TextDecoder().decode(input.canonicalBytes)) as unknown;
      persisted.push({ namespace: input.namespace, value });
      return {
        namespace: input.namespace,
        objectKey: `${input.namespace}/sha256/${input.sha256}.json`,
        sha256: input.sha256,
        byteLength: input.canonicalBytes.byteLength,
      };
    }),
  };
  return { store, persisted };
}

function dependencies(
  overrides: Partial<LiveComparisonDependencies> = {},
): LiveComparisonDependencies {
  return {
    assertSyntheticData: vi.fn(),
    preparePolicyStore: vi.fn(async ({ onPreparationEvent }) => {
      await onPreparationEvent?.({
        kind: "VECTOR_STORE_CREATED",
        vectorStoreId: PREPARED.vectorStoreId,
      });
      for (const file of PREPARED.files) {
        await onPreparationEvent?.({
          kind: "UPLOADED_FILE_CREATED",
          vectorStoreId: PREPARED.vectorStoreId,
          file,
        });
      }
      return structuredClone(PREPARED);
    }),
    createAdapters: vi.fn(() => ({
      A: { invoke: vi.fn() },
      B: { invoke: vi.fn() },
      C: { invoke: vi.fn() },
    })),
    runCandidate: vi.fn(async ({ invocation }) =>
      run(invocation.candidateId as "A" | "B" | "C")),
    cleanupPolicyStore: vi.fn(async () => completeCleanup()),
    ...overrides,
  };
}

describe("웹 라이브 비교 오케스트레이터", () => {
  it("동일한 잠긴 사례로 A→B→C를 1회 실행하고 pack 뒤 cleanup receipt를 별도 저장한다", async () => {
    const deps = dependencies();
    const artifacts = artifactStore();
    const events: CandidateProgressEvent[] = [];

    const result = await executeLiveComparison({
      dependencies: deps,
      artifactStore: artifacts.store,
      createdAt: "2026-07-19T00:10:00.000Z",
      onProgress: (event) => {
        events.push(event);
      },
    });

    expect(result).toMatchObject({
      status: "RESULTS_READY",
      judgeEligible: true,
      errorCode: null,
      pack: {
        artifact_kind: "LIVE_DEMO_EVALUATION_PACK",
        coverage: { expected_runs: 3 },
      },
      projection: {
        source: "LIVE_SYNTHETIC_DEMO",
        stability: "SINGLE_RUN_NOT_MEASURED",
      },
      cleanupReceipt: {
        deletion_semantics: "API_ACKNOWLEDGEMENT_ONLY_NO_PHYSICAL_DELETION_CLAIM",
      },
    });
    expect(deps.runCandidate).toHaveBeenCalledTimes(3);
    expect(vi.mocked(deps.runCandidate).mock.calls.map(
      ([input]) => ({
        candidateId: input.invocation.candidateId,
        runNumber: input.runNumber,
        input: input.invocation.input,
      }),
    )).toEqual([
      expect.objectContaining({ candidateId: "A", runNumber: 1 }),
      expect.objectContaining({ candidateId: "B", runNumber: 1 }),
      expect.objectContaining({ candidateId: "C", runNumber: 1 }),
    ]);
    expect(artifacts.persisted.map((artifact) => artifact.namespace)).toEqual([
      "live-evaluation-packs",
      "cleanup-receipts",
    ]);
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      "HARD_GATES_STARTED",
      "HARD_GATES_FINISHED",
      "RESULTS_PERSISTING",
      "RESULTS_PERSISTED",
      "REMOTE_CLEANUP_STARTED",
      "REMOTE_CLEANUP_FINISHED",
    ]));
  });

  it("후보 실패 결과는 다음 후보를 막거나 플랫폼 실패로 바꾸지 않는다", async () => {
    const deps = dependencies({
      runCandidate: vi.fn(async ({ invocation }) => {
        if (invocation.candidateId !== "A") return run(invocation.candidateId as "B" | "C");
        return {
          runNumber: 1,
          status: "INVALID" as const,
          attempts: [{
            ...run("A").attempts[0],
            status: "REFUSED" as const,
            error: "provider refusal",
          }],
          totalLatencyMs: 100,
        } satisfies CandidateRunRecord;
      }),
    });
    const artifacts = artifactStore();

    const result = await executeLiveComparison({
      dependencies: deps,
      artifactStore: artifacts.store,
      createdAt: "2026-07-19T00:10:00.000Z",
    });

    expect(deps.runCandidate).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("RESULTS_READY");
    expect(result.pack?.entries[0]).toMatchObject({
      execution_status: "INVALID",
      gate: { evaluation: "NOT_EVALUATED" },
    });
  });

  it("완료 observer 플랫폼 오류의 private 증거와 비용을 보존하고 공통 cleanup 뒤 Judge를 차단한다", async () => {
    const capturedUsage = {
      inputTokens: 123,
      cachedInputTokens: 23,
      cacheWriteTokens: 0,
      outputTokens: 45,
    };
    const deps = dependencies({
      runCandidate: vi.fn(async () => {
        throw new CandidateProgressObserverError(
          { kind: "CANDIDATE_A_RESPONSE_FINISHED", candidateId: "A", outcome: "COMPLETE" },
          new Error("D1 progress write failed"),
          {
            usage: capturedUsage,
            executionEvidence: {
              providerCalls: [{
                callNumber: 1,
                responseId: "resp-private-observer-failure",
                status: "completed",
                modelRequestedId: "gpt-5.6-terra",
                modelReportedId: "gpt-5.6-terra-2026-07-17",
                serviceTierRequested: "default",
                serviceTierReported: "default",
                latencyMs: 90,
                usage: capturedUsage,
              }],
              retrievalCalls: [],
              toolCalls: [],
            },
          },
        );
      }),
    });
    const artifacts = artifactStore();

    const result = await executeLiveComparison({
      dependencies: deps,
      artifactStore: artifacts.store,
      createdAt: "2026-07-19T00:10:00.000Z",
    });

    expect(result).toMatchObject({
      status: "FAILED_PLATFORM",
      judgeEligible: false,
      pack: null,
      projection: null,
      privateFailureEvidence: {
        captured_evidence: {
          usage: capturedUsage,
          executionEvidence: {
            providerCalls: [{ responseId: "resp-private-observer-failure" }],
          },
        },
      },
    });
    expect(result.actualCostUsd).toBeGreaterThan(0);
    expect(deps.cleanupPolicyStore).toHaveBeenCalledOnce();
    expect(artifacts.persisted.map((artifact) => artifact.namespace)).toEqual([
      "errors",
      "cleanup-receipts",
    ]);
  });

  it("삭제 승인 하나가 부족하면 평가팩은 보존하되 FAILED_CLEANUP으로 Judge를 차단한다", async () => {
    const deps = dependencies({
      cleanupPolicyStore: vi.fn(async () => completeCleanup(false)),
    });
    const artifacts = artifactStore();

    const result = await executeLiveComparison({
      dependencies: deps,
      artifactStore: artifacts.store,
      createdAt: "2026-07-19T00:10:00.000Z",
    });

    expect(result).toMatchObject({
      status: "FAILED_CLEANUP",
      judgeEligible: false,
      errorCode: "FAILED_CLEANUP",
      pack: { artifact_kind: "LIVE_DEMO_EVALUATION_PACK" },
      cleanupReceipt: {
        api_delete_acknowledgements: {
          uploaded_files: [
            expect.objectContaining({ attempted: true, deleted: false }),
            expect.objectContaining({ attempted: true, deleted: true }),
          ],
        },
      },
    });
    expect(artifacts.persisted.map((artifact) => artifact.namespace)).toEqual([
      "live-evaluation-packs",
      "cleanup-receipts",
    ]);
  });

  it("cleanup 호출 거부는 평가 결과를 보존하고 FAILED_CLEANUP과 private 오류 증거로 분류한다", async () => {
    const cleanupError = new Error("bounded cleanup request failed");
    const deps = dependencies({
      cleanupPolicyStore: vi.fn(async () => {
        throw cleanupError;
      }),
    });
    const artifacts = artifactStore();

    const result = await executeLiveComparison({
      dependencies: deps,
      artifactStore: artifacts.store,
      createdAt: "2026-07-19T00:10:00.000Z",
    });

    expect(result).toMatchObject({
      status: "FAILED_CLEANUP",
      errorCode: "FAILED_CLEANUP",
      judgeEligible: false,
      pack: { artifact_kind: "LIVE_DEMO_EVALUATION_PACK" },
      projection: { source: "LIVE_SYNTHETIC_DEMO" },
      packReference: { namespace: "live-evaluation-packs" },
      privateFailureEvidence: {
        error_message: "bounded cleanup request failed",
        source_pack_sha256: sha256CanonicalJson(result.pack),
      },
      privateFailureReference: { namespace: "errors" },
      cleanupReceipt: {
        api_delete_acknowledgements: {
          vector_store: {
            attempted: false,
            deleted: false,
          },
          uploaded_files: [
            expect.objectContaining({ attempted: false, deleted: false }),
            expect.objectContaining({ attempted: false, deleted: false }),
          ],
        },
      },
    });
    expect(artifacts.persisted.map((artifact) => artifact.namespace)).toEqual([
      "live-evaluation-packs",
      "errors",
      "cleanup-receipts",
    ]);
  });

  it("cleanup 진행 observer 저장 실패는 cleanup 자체 실패가 아니라 FAILED_PLATFORM으로 유지한다", async () => {
    const deps = dependencies();
    const artifacts = artifactStore();

    const result = await executeLiveComparison({
      dependencies: deps,
      artifactStore: artifacts.store,
      createdAt: "2026-07-19T00:10:00.000Z",
      onProgress: (event) => {
        if (event.kind === "REMOTE_CLEANUP_STARTED") {
          throw new Error("D1 cleanup progress write failed");
        }
      },
    });

    expect(result).toMatchObject({
      status: "FAILED_PLATFORM",
      errorCode: "FAILED_PLATFORM",
      judgeEligible: false,
      cleanupReceipt: {
        api_delete_acknowledgements: {
          vector_store: { attempted: true, deleted: true },
        },
      },
      privateFailureEvidence: {
        error_message: "후보 진행 상태 저장에 실패했습니다: REMOTE_CLEANUP_STARTED",
      },
      privateFailureReference: { namespace: "errors" },
    });
    expect(deps.cleanupPolicyStore).toHaveBeenCalledTimes(1);
  });

  it("준비 실패에 포함된 cleanup을 보존하고 같은 원격 자원을 중복 삭제하지 않는다", async () => {
    const embeddedCleanup = completeCleanup();
    const deps = dependencies({
      preparePolicyStore: vi.fn(async () => {
        const error = new Error("preparation failed") as Error & {
          vectorStoreId: string;
          uploadedFileIds: string[];
          cleanup: PolicyVectorStoreCleanupResult;
        };
        error.name = "PolicyVectorStorePreparationError";
        error.vectorStoreId = PREPARED.vectorStoreId;
        error.uploadedFileIds = [...PREPARED.uploadedFileIds];
        error.cleanup = embeddedCleanup;
        throw error;
      }),
    });
    const artifacts = artifactStore();

    const result = await executeLiveComparison({
      dependencies: deps,
      artifactStore: artifacts.store,
      createdAt: "2026-07-19T00:10:00.000Z",
    });

    expect(result.status).toBe("FAILED_PLATFORM");
    expect(deps.cleanupPolicyStore).not.toHaveBeenCalled();
    expect(result.cleanupReceipt).toMatchObject({
      expected_resources: {
        vector_store_id: PREPARED.vectorStoreId,
        uploaded_file_ids: PREPARED.uploadedFileIds,
      },
    });
  });

  it("artifact persistence 실패 뒤에도 원격 cleanup과 private 오류 영수증 경로를 시도한다", async () => {
    const deps = dependencies();
    let call = 0;
    const putContentAddressed = vi.fn(async (input) => {
      call += 1;
      if (call === 1) throw new Error("R2 pack persistence failed");
      return {
        namespace: input.namespace,
        objectKey: `${input.namespace}/sha256/${input.sha256}.json`,
        sha256: input.sha256,
        byteLength: input.canonicalBytes.byteLength,
      };
    });

    const result = await executeLiveComparison({
      dependencies: deps,
      artifactStore: { putContentAddressed },
      createdAt: "2026-07-19T00:10:00.000Z",
    });

    expect(result.status).toBe("FAILED_PLATFORM");
    expect(result.judgeEligible).toBe(false);
    expect(deps.cleanupPolicyStore).toHaveBeenCalledOnce();
    expect(putContentAddressed.mock.calls.map(([input]) => input.namespace)).toEqual([
      "live-evaluation-packs",
      "errors",
      "cleanup-receipts",
    ]);
    expect(result.privateFailureEvidence?.source_pack_sha256).toBe(
      result.pack === null ? null : sha256CanonicalJson(result.pack),
    );
  });

  it("cleanup receipt 저장 실패도 private errors artifact로 남기고 cleanup은 반복하지 않는다", async () => {
    const deps = dependencies();
    const putContentAddressed = vi.fn(async (input) => {
      if (input.namespace === "cleanup-receipts") {
        throw new Error("R2 cleanup receipt persistence failed");
      }
      return {
        namespace: input.namespace,
        objectKey: `${input.namespace}/sha256/${input.sha256}.json`,
        sha256: input.sha256,
        byteLength: input.canonicalBytes.byteLength,
      };
    });

    const result = await executeLiveComparison({
      dependencies: deps,
      artifactStore: { putContentAddressed },
      createdAt: "2026-07-19T00:10:00.000Z",
    });

    expect(result).toMatchObject({
      status: "FAILED_PLATFORM",
      judgeEligible: false,
      privateFailureEvidence: {
        error_message: "R2 cleanup receipt persistence failed",
      },
      privateFailureReference: {
        namespace: "errors",
      },
    });
    expect(deps.cleanupPolicyStore).toHaveBeenCalledTimes(1);
    expect(putContentAddressed.mock.calls.map(([input]) => input.namespace)).toEqual([
      "live-evaluation-packs",
      "cleanup-receipts",
      "errors",
    ]);
  });
});

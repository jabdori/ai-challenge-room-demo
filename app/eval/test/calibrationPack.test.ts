// @vitest-environment node

import { chmod, mkdtemp, readFile, readdir, realpath, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CandidateExecutionEvidence,
  ProviderCallEvidence,
} from "../contracts/executionEvidence";
import type { CandidateOutput } from "../contracts/candidateOutput";
import {
  buildPartialCalibrationPack,
  type PartialCalibrationPackEntry,
} from "../pack/calibrationPack";
import { persistPartialCalibrationPack } from "../pack/persistence";
import type { CandidateAdapter, CandidateInvocation } from "../runner/types";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import { SHARED_EVALUATION_IDENTITY } from "../smoke/candidateDefinitions";
import { executeThreeCandidateCalibration } from "../smoke/executeThreeCandidateCalibration";

const validOutput: CandidateOutput = {
  customer_reply: "The shipped order cannot be cancelled. You may request a return after delivery.",
  decision: {
    intent_codes: ["ORDER_CANCELLATION", "REFUND_REQUEST"],
    action_code: "DENY_CANCEL_AFTER_SHIPMENT",
    escalation_required: false,
    escalation_reason_code: "NOT_REQUIRED",
    target_queue: "NONE",
  },
  citations: [{ source_id: "CANCEL-2026", section_id: "2.2" }],
};

const singleUsage = {
  inputTokens: 100,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 20,
};

async function secureTempDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await chmod(directory, 0o700);
  return directory;
}

function providerCall(
  invocation: CandidateInvocation,
  callNumber: number,
  usage = singleUsage,
): ProviderCallEvidence {
  return {
    callNumber,
    responseId: `resp-${invocation.candidateId}-${callNumber}`,
    status: "completed",
    modelRequestedId: invocation.modelRequestedId,
    modelReportedId: "gpt-5.6-terra-2026-07-17",
    serviceTierRequested: invocation.serviceTierRequested,
    serviceTierReported: "default",
    latencyMs: 5,
    usage: structuredClone(usage),
  };
}

function evidenceFor(candidateId: "A" | "B" | "C", invocation: CandidateInvocation) {
  if (candidateId === "A") {
    return {
      usage: structuredClone(singleUsage),
      evidence: {
        providerCalls: [providerCall(invocation, 1)],
        retrievalCalls: [],
        toolCalls: [],
      } satisfies CandidateExecutionEvidence,
    };
  }
  if (candidateId === "B") {
    return {
      usage: structuredClone(singleUsage),
      evidence: {
        providerCalls: [providerCall(invocation, 1)],
        retrievalCalls: [{
          callNumber: 1,
          operation: "VECTOR_STORE_SEARCH" as const,
          status: "COMPLETE" as const,
          requestedQuery: "active shipped-order cancellation policy as of 2026-07-17",
          reportedQuery: null,
          vectorStoreId: "vs-calibration",
          maxNumResults: 2,
          rewriteQuery: false,
          latencyMs: 3,
          results: [{
            rank: 1,
            fileId: "file-active",
            filename: "policy.json",
            score: 0.98,
            sourceId: "CANCEL-2026",
            sectionId: "2.2",
            factId: "CANCEL-AFTER-SHIPMENT-2026",
            text: "Orders in SHIPPED status cannot be cancelled.",
          }],
        }],
        toolCalls: [],
      } satisfies CandidateExecutionEvidence,
    };
  }
  const firstUsage = {
    inputTokens: 60,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 10,
  };
  const secondUsage = {
    inputTokens: 40,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 10,
  };
  return {
    usage: structuredClone(singleUsage),
    evidence: {
      providerCalls: [
        providerCall(invocation, 1, firstUsage),
        providerCall(invocation, 2, secondUsage),
      ],
      retrievalCalls: [],
      toolCalls: [{
        callNumber: 1,
        modelTurn: 1,
        callId: "call-order",
        toolName: "get_order",
        status: "COMPLETE" as const,
        arguments: {
          order_id: "ORD-1042",
          authenticated_customer_id: "CUS-0101",
        },
        argumentsJson: JSON.stringify({
          order_id: "ORD-1042",
          authenticated_customer_id: "CUS-0101",
        }),
        providerStatus: "completed",
        result: { ok: true, data: { order_id: "ORD-1042", status: "SHIPPED" } },
        latencyMs: 2,
      }],
    } satisfies CandidateExecutionEvidence,
  };
}

function createAdapter(
  candidateId: "A" | "B" | "C",
  outputText = JSON.stringify(validOutput),
  onInvoke?: () => void,
): { adapter: CandidateAdapter; invocations: CandidateInvocation[] } {
  const invocations: CandidateInvocation[] = [];
  return {
    invocations,
    adapter: {
      invoke: async (invocation) => {
        onInvoke?.();
        invocations.push(structuredClone(invocation));
        const { usage, evidence } = evidenceFor(candidateId, invocation);
        return {
          responseId: evidence.providerCalls.at(-1)!.responseId,
          status: "completed",
          modelReportedId: "gpt-5.6-terra-2026-07-17",
          serviceTierReported: "default",
          outputText,
          usage,
          executionEvidence: evidence,
        };
      },
    },
  };
}

async function executeValidCalibration(outputDirectory?: string) {
  const a = createAdapter("A");
  const b = createAdapter("B");
  const c = createAdapter("C");
  const result = await executeThreeCandidateCalibration({
    adapters: { A: a.adapter, B: b.adapter, C: c.adapter },
    outputDirectory,
    now: () => 0,
    createdAt: "2026-07-17T03:00:00.000Z",
  });
  return { result, a, b, c };
}

function cloneEntries(entries: readonly PartialCalibrationPackEntry[]): PartialCalibrationPackEntry[] {
  return structuredClone(entries) as PartialCalibrationPackEntry[];
}

describe("A/B/C 상위 부분 Calibration Pack", () => {
  it("A 실행 중 취소되면 B·C를 시작하지 않고 동일 reason으로 전체 calibration을 중단한다", async () => {
    const reason = new Error("세 후보 calibration 취소");
    const controller = new AbortController();
    const calls: string[] = [];
    const a = createAdapter("A", JSON.stringify(validOutput), () => {
      calls.push("A");
      controller.abort(reason);
    });
    const b = createAdapter("B", JSON.stringify(validOutput), () => calls.push("B"));
    const c = createAdapter("C", JSON.stringify(validOutput), () => calls.push("C"));

    await expect(executeThreeCandidateCalibration({
      adapters: { A: a.adapter, B: b.adapter, C: c.adapter },
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(calls).toEqual(["A"]);
    expect(b.invocations).toHaveLength(0);
    expect(c.invocations).toHaveLength(0);
  });

  it("A→B→C 순서로 각각 2회, 총 6회를 하나의 incomplete pack으로 조립한다", async () => {
    const { result, a, b, c } = await executeValidCalibration();

    expect(a.invocations).toHaveLength(2);
    expect(b.invocations).toHaveLength(2);
    expect(c.invocations).toHaveLength(2);
    expect(result.pack).toMatchObject({
      artifact_kind: "PARTIAL_CALIBRATION_PACK",
      source: "CALIBRATION_SMOKE",
      evaluation_status: "EVALUATION_INCOMPLETE",
      coverage: {
        cases: 1,
        candidates: 3,
        runs_per_candidate: 2,
        expected_runs: 6,
      },
      baseline_version: null,
      shared_evaluation_identity: SHARED_EVALUATION_IDENTITY,
    });
    expect(result.pack.entries.map((entry) => entry.candidate_id)).toEqual(["A", "B", "C"]);
    expect(result.pack.entries.map((entry) => entry.evaluation_pack.candidate_version)).toEqual([
      "candidate-a-v1",
      "candidate-b-v1",
      "candidate-c-v1",
    ]);
    expect(result.pack.entries.every(
      (entry) => entry.evaluation_pack.runs.length === 2,
    )).toBe(true);
    expect(result.pack.total_runtime_cost_usd).toBe(
      result.pack.entries.reduce(
        (total, entry) => total + entry.evaluation_pack.total_runtime_cost_usd,
        0,
      ),
    );
    expect(result.filePath).toBeNull();
    expect(JSON.stringify(result.pack)).not.toMatch(/RECORDED_BENCHMARK|selection|recommendation/i);
  });

  it("child 파일 저장은 기본값에서 꺼져 있고 검증된 top pack만 저장한다", async () => {
    const directory = await secureTempDirectory("calibration-pack-top-only-");
    const { result } = await executeValidCalibration(directory);

    expect(result.childFilePaths).toEqual({ A: null, B: null, C: null });
    expect((await readdir(directory)).filter((entry) => entry.endsWith(".json")))
      .toEqual([basename(result.filePath!)]);
  });

  it("B retrieval evidence와 C provider/tool evidence를 자식 팩 그대로 보존한다", async () => {
    const { result } = await executeValidCalibration();
    const entryB = result.pack.entries[1].evaluation_pack;
    const entryC = result.pack.entries[2].evaluation_pack;

    expect(entryB.runs[0].execution.attempts[0].executionEvidence).toMatchObject({
      providerCalls: [{ callNumber: 1 }],
      retrievalCalls: [{
        callNumber: 1,
        maxNumResults: 2,
        rewriteQuery: false,
        results: [{ sourceId: "CANCEL-2026", score: 0.98 }],
      }],
      toolCalls: [],
    });
    expect(entryC.runs[0].execution.attempts[0].executionEvidence).toMatchObject({
      providerCalls: [{ callNumber: 1 }, { callNumber: 2 }],
      toolCalls: [{ callNumber: 1, toolName: "get_order", status: "COMPLETE" }],
    });
  });

  it("entry input 순서와 무관하게 explicit candidate_id를 사용해 A/B/C로 정렬하고 ID↔identity mapping을 강제한다", async () => {
    const { result } = await executeValidCalibration();
    const shuffled = [result.pack.entries[2], result.pack.entries[0], result.pack.entries[1]];

    const rebuilt = buildPartialCalibrationPack({
      entries: shuffled,
      createdAt: "2026-07-17T03:10:00.000Z",
    });
    expect(rebuilt.entries.map((entry) => entry.candidate_id)).toEqual(["A", "B", "C"]);

    const forged = cloneEntries(result.pack.entries);
    forged[0].candidate_id = "B";
    await expect(() => buildPartialCalibrationPack({
      entries: forged,
      createdAt: "2026-07-17T03:10:00.000Z",
    })).toThrow(/candidate.*identity|candidate.*mapping/i);
  });

  it("top cost는 child total을 믿지 않고 raw attempt usage와 pricing evidence로 재계산한다", async () => {
    const { result } = await executeValidCalibration();
    const forgedChildTotal = cloneEntries(result.pack.entries);
    forgedChildTotal[0].evaluation_pack.total_runtime_cost_usd += 1;
    expect(() => buildPartialCalibrationPack({
      entries: forgedChildTotal,
      createdAt: "2026-07-17T03:10:00.000Z",
    })).toThrow(/cost|\ube44\uc6a9/i);

    const forgedRunCost = cloneEntries(result.pack.entries);
    forgedRunCost[1].evaluation_pack.runs[0].runtime_cost!.totalCostUsd += 1;
    expect(() => buildPartialCalibrationPack({
      entries: forgedRunCost,
      createdAt: "2026-07-17T03:10:00.000Z",
    })).toThrow(/cost|\ube44\uc6a9/i);
  });

  it("child artifact/common identity/run/envelope 구조 mismatch를 상위 팩 생성 전 거부한다", async () => {
    const { result } = await executeValidCalibration();
    const cases: Array<{
      label: string;
      mutate: (entries: PartialCalibrationPackEntry[]) => void;
    }> = [
      { label: "artifact kind", mutate: (entries) => {
        (entries[0].evaluation_pack as { artifact_kind: string }).artifact_kind = "RECORDED_BENCHMARK";
      } },
      { label: "child pack id", mutate: (entries) => {
        entries[0].evaluation_pack.pack_id = "calibration-smoke-0000000000000000";
      } },
      { label: "unexpected child field", mutate: (entries) => {
        (entries[0].evaluation_pack as unknown as Record<string, unknown>).forged = true;
      } },
      { label: "dataset identity", mutate: (entries) => {
        entries[1].evaluation_pack.dataset_hash = "forged-dataset";
      } },
      { label: "coverage", mutate: (entries) => {
        entries[2].evaluation_pack.coverage.expected_runs = 99 as 2;
      } },
      { label: "run number", mutate: (entries) => {
        entries[0].evaluation_pack.runs[1].execution.runNumber = 1;
      } },
      { label: "A provider envelope", mutate: (entries) => {
        const evidence = entries[0].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!;
        evidence.providerCalls.push(structuredClone(evidence.providerCalls[0]));
      } },
      { label: "A COMPLETE missing provider", mutate: (entries) => {
        entries[0].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.providerCalls = [];
      } },
      { label: "B exact query", mutate: (entries) => {
        entries[1].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.retrievalCalls[0].requestedQuery = "forged query";
      } },
      { label: "B missing retrieval", mutate: (entries) => {
        entries[1].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.retrievalCalls = [];
      } },
      { label: "B negative retrieval latency", mutate: (entries) => {
        entries[1].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.retrievalCalls[0].latencyMs = -1;
      } },
      { label: "C allowed tool", mutate: (entries) => {
        entries[2].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.toolCalls[0].toolName = "refund_order";
      } },
      { label: "C COMPLETE missing provider", mutate: (entries) => {
        entries[2].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.providerCalls = [];
      } },
      { label: "C model turn", mutate: (entries) => {
        entries[2].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.toolCalls[0].modelTurn = 4;
      } },
      { label: "C tool turn without matching provider", mutate: (entries) => {
        entries[2].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.toolCalls[0].modelTurn = 3;
      } },
      { label: "C tool on final provider turn", mutate: (entries) => {
        entries[2].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.toolCalls[0].modelTurn = 2;
      } },
      { label: "C tool-free intermediate provider", mutate: (entries) => {
        entries[2].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.toolCalls = [];
      } },
      { label: "C missing intermediate provider response", mutate: (entries) => {
        entries[2].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.providerCalls[0].responseId = null;
      } },
      { label: "C missing intermediate provider model", mutate: (entries) => {
        entries[2].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.providerCalls[0].modelReportedId = null;
      } },
      { label: "C missing intermediate provider tier", mutate: (entries) => {
        entries[2].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.providerCalls[0].serviceTierReported = null;
      } },
      { label: "C non-finite tool latency", mutate: (entries) => {
        entries[2].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.toolCalls[0].latencyMs = Number.NaN;
      } },
      { label: "C blank call id", mutate: (entries) => {
        entries[2].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.toolCalls[0].callId = "   ";
      } },
      { label: "C duplicate call id", mutate: (entries) => {
        const toolCalls = entries[2].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.toolCalls;
        toolCalls.push({ ...structuredClone(toolCalls[0]), callNumber: 2, modelTurn: 2 });
      } },
      { label: "gate status", mutate: (entries) => {
        const gate = entries[0].evaluation_pack.runs[0].gate;
        if (gate.evaluation === "EVALUATED") {
          gate.result.status = "CONFIRMED_FAIL";
          gate.result.findings = [{ code: "WRONG_ACTION", message: "forged" }];
        }
      } },
      { label: "output without gate update", mutate: (entries) => {
        entries[0].evaluation_pack.runs[0].execution.output!.decision.action_code = "REFUND_APPROVED";
      } },
      { label: "output schema", mutate: (entries) => {
        (entries[0].evaluation_pack.runs[0].execution.output as unknown as Record<string, unknown>)
          .forged = true;
      } },
      { label: "provider usage", mutate: (entries) => {
        entries[0].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.providerCalls[0].usage!.inputTokens += 1;
      } },
      { label: "provider reported model", mutate: (entries) => {
        entries[0].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.providerCalls[0].modelReportedId = "forged-model";
      } },
      { label: "COMPLETE provider status", mutate: (entries) => {
        entries[0].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.providerCalls[0].status = "failed";
      } },
      { label: "attempt response id", mutate: (entries) => {
        entries[0].evaluation_pack.runs[0].execution.attempts[0].responseId = "forged-response";
      } },
      { label: "mirrored null final response id", mutate: (entries) => {
        const attempt = entries[0].evaluation_pack.runs[0].execution.attempts[0];
        (attempt as unknown as { responseId: null }).responseId = null;
        attempt.executionEvidence!.providerCalls[0].responseId = null;
      } },
      { label: "mirrored null final reported model", mutate: (entries) => {
        const attempt = entries[0].evaluation_pack.runs[0].execution.attempts[0];
        (attempt as unknown as { modelReportedId: null }).modelReportedId = null;
        attempt.executionEvidence!.providerCalls[0].modelReportedId = null;
      } },
      { label: "mirrored null final reported tier", mutate: (entries) => {
        const attempt = entries[0].evaluation_pack.runs[0].execution.attempts[0];
        (attempt as unknown as { serviceTierReported: null }).serviceTierReported = null;
        attempt.executionEvidence!.providerCalls[0].serviceTierReported = null;
      } },
      { label: "mirrored blank final response id", mutate: (entries) => {
        const attempt = entries[0].evaluation_pack.runs[0].execution.attempts[0];
        attempt.responseId = "   ";
        attempt.executionEvidence!.providerCalls[0].responseId = "   ";
      } },
      { label: "mirrored blank final reported model", mutate: (entries) => {
        const attempt = entries[0].evaluation_pack.runs[0].execution.attempts[0];
        attempt.modelReportedId = "   ";
        attempt.executionEvidence!.providerCalls[0].modelReportedId = "   ";
        entries[0].evaluation_pack.model_reported_ids = [
          "   ",
          "gpt-5.6-terra-2026-07-17",
        ];
      } },
      { label: "mirrored blank final reported tier", mutate: (entries) => {
        const attempt = entries[0].evaluation_pack.runs[0].execution.attempts[0];
        attempt.serviceTierReported = "   ";
        attempt.executionEvidence!.providerCalls[0].serviceTierReported = "   ";
        entries[0].evaluation_pack.service_tiers_reported = ["   ", "default"];
      } },
      { label: "attempt final provider model", mutate: (entries) => {
        const attempt = entries[0].evaluation_pack.runs[0].execution.attempts[0];
        attempt.modelReportedId = "forged-model";
        entries[0].evaluation_pack.model_reported_ids = [
          "forged-model",
          "gpt-5.6-terra-2026-07-17",
        ];
      } },
      { label: "COMPLETE tool status", mutate: (entries) => {
        entries[2].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.toolCalls[0].status = "FAILED";
      } },
      { label: "COMPLETE tool provider status", mutate: (entries) => {
        entries[2].evaluation_pack.runs[0].execution.attempts[0]
          .executionEvidence!.toolCalls[0].providerStatus = "in_progress";
      } },
      { label: "reported model array", mutate: (entries) => {
        entries[0].evaluation_pack.model_reported_ids = ["forged-model"];
      } },
      { label: "reported tier array", mutate: (entries) => {
        entries[0].evaluation_pack.service_tiers_reported = ["priority"];
      } },
      { label: "attempt number", mutate: (entries) => {
        entries[0].evaluation_pack.runs[0].execution.attempts[0].attemptNumber = 2;
      } },
      { label: "negative attempt latency", mutate: (entries) => {
        entries[0].evaluation_pack.runs[0].execution.attempts[0].latencyMs = -1;
        entries[0].evaluation_pack.runs[0].execution.totalLatencyMs = -1;
      } },
      { label: "non-finite attempt latency", mutate: (entries) => {
        entries[0].evaluation_pack.runs[0].execution.attempts[0].latencyMs = Number.NaN;
        entries[0].evaluation_pack.runs[0].execution.totalLatencyMs = Number.NaN;
      } },
      { label: "run status", mutate: (entries) => {
        entries[0].evaluation_pack.runs[0].execution.status = "INVALID";
      } },
    ];

    for (const { label, mutate } of cases) {
      const entries = cloneEntries(result.pack.entries);
      mutate(entries);
      expect(() => buildPartialCalibrationPack({
        entries,
        createdAt: "2026-07-17T03:10:00.000Z",
      }), label).toThrow();
    }
  });

  it("선언되지 않은 run/attempt status를 INVALID catch-all로 수용하지 않는다", async () => {
    const { result } = await executeValidCalibration();
    const entries = cloneEntries(result.pack.entries);
    const packRun = entries[0].evaluation_pack.runs[0];

    (packRun.execution as unknown as { status: string }).status = "UNKNOWN_RUN_STATUS";
    (packRun.execution.attempts[0] as unknown as { status: string }).status =
      "UNKNOWN_ATTEMPT_STATUS";
    delete packRun.execution.output;
    packRun.gate = {
      runNumber: 1,
      evaluation: "NOT_EVALUATED",
      reason: "INVALID_OUTPUT",
    };

    expect(() => buildPartialCalibrationPack({
      entries,
      createdAt: "2026-07-17T03:10:00.000Z",
    })).toThrow(/status/i);
  });

  it.each([
    "COMPLETE",
    "REQUEST_ERROR",
    "BUDGET_EXCEEDED",
    "INCOMPLETE",
    "FAILED",
    "REFUSED",
  ] as const)("비재시도 첫 상태 %s 뒤의 두 번째 attempt를 거부한다", async (firstStatus) => {
    const a = createAdapter("A");
    const originalInvoke = a.adapter.invoke.bind(a.adapter);
    let calls = 0;
    a.adapter.invoke = async (invocation, context) => {
      calls += 1;
      const response = await originalInvoke(invocation, context);
      if (calls === 1) {
        response.outputText = "{}";
      }
      return response;
    };
    const result = await executeThreeCandidateCalibration({
      adapters: { A: a.adapter, B: createAdapter("B").adapter, C: createAdapter("C").adapter },
      now: () => 0,
      createdAt: "2026-07-17T03:00:00.000Z",
    });
    const entries = cloneEntries(result.pack.entries);
    entries[0].evaluation_pack.runs[0].execution.attempts[0].status = firstStatus;

    expect(() => buildPartialCalibrationPack({
      entries,
      createdAt: "2026-07-17T03:10:00.000Z",
    })).toThrow(/retry|재시도/i);
  });

  it.each(["INVALID_OUTPUT", "TRANSPORT_ERROR"] as const)(
    "항상 재시도 가능한 단일 %s attempt를 거부한다",
    async (attemptStatus) => {
      const { result } = await executeValidCalibration();
      const entries = cloneEntries(result.pack.entries);
      const packRun = entries[0].evaluation_pack.runs[0];
      packRun.execution.status = "INVALID";
      packRun.execution.attempts[0].status = attemptStatus;
      delete packRun.execution.output;
      packRun.gate = {
        runNumber: 1,
        evaluation: "NOT_EVALUATED",
        reason: "INVALID_OUTPUT",
      };

      expect(() => buildPartialCalibrationPack({
        entries,
        createdAt: "2026-07-17T03:10:00.000Z",
      })).toThrow(/retry|재시도/i);
    },
  );

  it.each(["INVALID_OUTPUT", "TRANSPORT_ERROR", "TIMEOUT"] as const)(
    "runner가 재시도할 수 있는 첫 상태 %s 뒤의 두 번째 attempt는 허용한다",
    async (firstStatus) => {
      const a = createAdapter("A");
      const originalInvoke = a.adapter.invoke.bind(a.adapter);
      let calls = 0;
      a.adapter.invoke = async (invocation, context) => {
        calls += 1;
        const response = await originalInvoke(invocation, context);
        if (calls === 1) {
          response.outputText = "{}";
        }
        return response;
      };
      const result = await executeThreeCandidateCalibration({
        adapters: { A: a.adapter, B: createAdapter("B").adapter, C: createAdapter("C").adapter },
        now: () => 0,
        createdAt: "2026-07-17T03:00:00.000Z",
      });
      const entries = cloneEntries(result.pack.entries);
      entries[0].evaluation_pack.runs[0].execution.attempts[0].status = firstStatus;

      expect(() => buildPartialCalibrationPack({
        entries,
        createdAt: "2026-07-17T03:10:00.000Z",
      })).not.toThrow();
    },
  );

  it("Candidate C가 도구 없이 첫 provider turn에서 최종 출력한 COMPLETE trace를 허용한다", async () => {
    const { result } = await executeValidCalibration();
    const entries = cloneEntries(result.pack.entries);
    const attempt = entries[2].evaluation_pack.runs[0].execution.attempts[0];
    const evidence = attempt.executionEvidence!;
    const finalProvider = structuredClone(evidence.providerCalls.at(-1)!);
    finalProvider.callNumber = 1;
    finalProvider.usage = structuredClone(singleUsage);
    evidence.providerCalls = [finalProvider];
    evidence.retrievalCalls = [];
    evidence.toolCalls = [];
    attempt.usage = structuredClone(singleUsage);

    expect(() => buildPartialCalibrationPack({
      entries,
      createdAt: "2026-07-17T03:10:00.000Z",
    })).not.toThrow();
  });

  it("invalid output은 유효한 incomplete/NOT_EVALUATED child로 받지만 선정이나 baseline을 만들지 않는다", async () => {
    const a = createAdapter("A");
    const b = createAdapter("B");
    const c = createAdapter("C", "{}");
    const result = await executeThreeCandidateCalibration({
      adapters: { A: a.adapter, B: b.adapter, C: c.adapter },
      now: () => 0,
      createdAt: "2026-07-17T03:00:00.000Z",
    });

    expect(result.pack.entries[2].evaluation_pack.runs.every(
      (run) => run.gate.evaluation === "NOT_EVALUATED",
    )).toBe(true);
    expect(result.pack.evaluation_status).toBe("EVALUATION_INCOMPLETE");
    expect(result.pack.baseline_version).toBeNull();
    expect(result.pack).not.toHaveProperty("selection");
  });

  it("pack_id는 created_at·record digest·자기 자신을 제외한 stable identity projection으로 결정한다", async () => {
    const { result } = await executeValidCalibration();
    const first = buildPartialCalibrationPack({
      entries: result.pack.entries,
      createdAt: "2026-07-17T03:10:00.000Z",
    });
    const second = buildPartialCalibrationPack({
      entries: result.pack.entries,
      createdAt: "2026-07-18T03:10:00.000Z",
    });

    expect(first.pack_id).toBe(second.pack_id);
    expect(first.pack_id).toMatch(/^calibration-pack-[a-f0-9]{16}$/);
    expect(first).not.toHaveProperty("record_digest");
  });

  it("builder 입력을 사후 변경해도 상위 pack snapshot은 바뀌지 않는다", async () => {
    const { result } = await executeValidCalibration();
    const entries = cloneEntries(result.pack.entries);
    const pack = buildPartialCalibrationPack({
      entries,
      createdAt: "2026-07-17T03:10:00.000Z",
    });
    const before = JSON.stringify(pack);

    entries[0].evaluation_pack.total_runtime_cost_usd = 999;
    entries[0].evaluation_pack.runs[0].execution.attempts[0].status = "FAILED";

    expect(JSON.stringify(pack)).toBe(before);
  });

  it("adapter map을 실행 중 바꿔도 시작 시점 A/B/C adapter snapshot을 사용한다", async () => {
    const b = createAdapter("B");
    const c = createAdapter("C");
    let adapters: { A: CandidateAdapter; B: CandidateAdapter; C: CandidateAdapter };
    const a = createAdapter("A", JSON.stringify(validOutput), () => {
      adapters.B = {
        invoke: async () => {
          throw new Error("변조된 B adapter는 실행되면 안 됩니다.");
        },
      };
    });
    adapters = { A: a.adapter, B: b.adapter, C: c.adapter };

    await executeThreeCandidateCalibration({
      adapters,
      now: () => 0,
      createdAt: "2026-07-17T03:00:00.000Z",
    });

    expect(b.invocations).toHaveLength(2);
  });

  it("adapter 객체의 invoke 속성을 실행 중 바꿔도 시작 시점의 함수를 사용한다", async () => {
    const b = createAdapter("B");
    const c = createAdapter("C");
    const a = createAdapter("A", JSON.stringify(validOutput), () => {
      b.adapter.invoke = async () => {
        throw new Error("변조된 B.invoke는 실행되면 안 됩니다.");
      };
    });

    await executeThreeCandidateCalibration({
      adapters: { A: a.adapter, B: b.adapter, C: c.adapter },
      now: () => 0,
      createdAt: "2026-07-17T03:00:00.000Z",
    });

    expect(b.invocations).toHaveLength(2);
  });

  it("persistChildren=true여도 top child 검증이 실패하면 어떤 JSON도 저장하지 않는다", async () => {
    const directory = await secureTempDirectory("calibration-pack-invalid-");
    const a = createAdapter("A");
    const b = createAdapter("B");
    const c = createAdapter("C");
    const originalAInvoke = a.adapter.invoke.bind(a.adapter);
    a.adapter.invoke = async (invocation, context) => {
      const result = await originalAInvoke(invocation, context);
      const evidence = result.executionEvidence!;
      evidence.providerCalls.push({
        ...structuredClone(evidence.providerCalls[0]),
        callNumber: 2,
        responseId: "forged-second-provider",
      });
      result.responseId = "forged-second-provider";
      result.usage = {
        inputTokens: 200,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 40,
      };
      return result;
    };

    await expect(executeThreeCandidateCalibration({
      adapters: { A: a.adapter, B: b.adapter, C: c.adapter },
      outputDirectory: directory,
      persistChildren: true,
      now: () => 0,
      createdAt: "2026-07-17T03:00:00.000Z",
    })).rejects.toThrow(/envelope/i);
    expect(await readdir(directory)).toEqual([]);
  });

  it("top pack을 full record digest 파일명으로 write-once 저장하고 동일 내용은 먱등 처리한다", async () => {
    const directory = await secureTempDirectory("calibration-pack-");
    const { result } = await executeValidCalibration(directory);
    expect(result.filePath).not.toBeNull();
    const digest = sha256CanonicalJson(result.pack);
    expect(basename(result.filePath!)).toBe(`${result.pack.pack_id}--record-${digest}.json`);
    expect((await stat(result.filePath!)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(result.filePath!, "utf8"))).toEqual(result.pack);

    const fixedTime = new Date("2020-01-02T03:04:05.000Z");
    await utimes(result.filePath!, fixedTime, fixedTime);
    const before = await stat(result.filePath!, { bigint: true });
    const secondPath = await persistPartialCalibrationPack(result.pack, directory);
    const after = await stat(result.filePath!, { bigint: true });
    expect(secondPath).toBe(result.filePath);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });
});

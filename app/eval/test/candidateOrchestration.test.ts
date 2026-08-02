// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { CandidateOutput } from "../contracts/candidateOutput";
import type { CandidateAdapter, CandidateInvocation } from "../runner/types";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import {
  CANDIDATE_CONFIGS,
  SHARED_EVALUATION_IDENTITY,
  createCandidateCalibrationDefinition,
} from "../smoke/candidateDefinitions";
import { executeCandidateCalibration } from "../smoke/executeCandidateCalibration";

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

function createAdapter(
  outputText = JSON.stringify(validOutput),
  usage = { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 20 },
): { adapter: CandidateAdapter; invocations: CandidateInvocation[] } {
  const invocations: CandidateInvocation[] = [];
  return {
    invocations,
    adapter: {
      invoke: async (invocation) => {
        invocations.push(structuredClone(invocation));
        return {
          responseId: `resp-${invocations.length}`,
          status: "completed",
          modelReportedId: "gpt-5.6-terra-2026-07-17",
          serviceTierReported: "default",
          outputText,
          usage: structuredClone(usage),
          executionEvidence: {
            providerCalls: [{
              callNumber: 1,
              responseId: `resp-${invocations.length}`,
              status: "completed",
              modelRequestedId: invocation.modelRequestedId,
              modelReportedId: "gpt-5.6-terra-2026-07-17",
              serviceTierRequested: invocation.serviceTierRequested,
              serviceTierReported: "default",
              latencyMs: 5,
              usage: structuredClone(usage),
            }],
            retrievalCalls: [],
            toolCalls: [],
          },
        };
      },
    },
  };
}

describe("단일 후보 calibration orchestration", () => {
  it("실행 signal을 runner와 adapter에 그대로 전달하고 취소 reason을 보존한다", async () => {
    const reason = new Error("orchestration 취소");
    const controller = new AbortController();
    const receivedSignals: Array<AbortSignal | undefined> = [];
    let calls = 0;
    const adapter: CandidateAdapter = {
      invoke: async (_invocation, context) => {
        calls += 1;
        receivedSignals.push(context?.signal);
        controller.abort(reason);
        throw reason;
      },
    };

    await expect(executeCandidateCalibration({
      definition: createCandidateCalibrationDefinition("A", adapter),
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(calls).toBe(1);
    expect(receivedSignals).toEqual([controller.signal]);
  });

  it("후보 정의를 두 번 실행하고 공통 gate·비용·hash를 schema 1.1 부분 팩으로 만든다", async () => {
    const { adapter, invocations } = createAdapter();
    const definition = createCandidateCalibrationDefinition("A", adapter);

    const pack = await executeCandidateCalibration({
      definition,
      now: () => 0,
      createdAt: "2026-07-17T02:00:00.000Z",
    });

    expect(invocations).toHaveLength(2);
    expect(pack).toMatchObject({
      schema_version: "1.1",
      artifact_kind: "PARTIAL_EVALUATION_PACK",
      source: "CALIBRATION_SMOKE",
      evaluation_status: "EVALUATION_INCOMPLETE",
      candidate_id: "A",
      candidate_version: "candidate-a-v1",
      invocation_hash: sha256CanonicalJson(definition.invocation),
      shared_evaluation_identity: SHARED_EVALUATION_IDENTITY,
      coverage: { cases: 1, candidates: 1, runs_per_case: 2, expected_runs: 2 },
      baseline_version: null,
    });
    expect(pack.candidate_config_hash).toBe(sha256CanonicalJson(CANDIDATE_CONFIGS.A));
    expect(pack.runs.map((run) => run.execution.runNumber)).toEqual([1, 2]);
    expect(pack.runs.map((run) => run.gate)).toEqual([
      expect.objectContaining({ evaluation: "EVALUATED", result: expect.objectContaining({ status: "PASS" }) }),
      expect.objectContaining({ evaluation: "EVALUATED", result: expect.objectContaining({ status: "PASS" }) }),
    ]);
  });

  it("실행 시작 후 외부 definition/config/invocation이 바뀌어도 처음 deep snapshot으로 두 run을 완료한다", async () => {
    const { adapter: baseAdapter, invocations } = createAdapter();
    let definition: ReturnType<typeof createCandidateCalibrationDefinition>;
    const adapter: CandidateAdapter = {
      invoke: async (invocation, context) => {
        if (invocations.length === 0) {
          (definition.config as { candidate_id: string }).candidate_id = "MUTATED";
          definition.invocation.candidateId = "MUTATED";
          definition.invocation.input = "{}";
          definition.adapter.invoke = async () => {
            throw new Error("사후 변조된 adapter.invoke는 실행되면 안 됩니다.");
          };
        }
        return baseAdapter.invoke(invocation, context);
      },
    };
    definition = createCandidateCalibrationDefinition("A", adapter);
    const expectedConfigHash = sha256CanonicalJson(definition.config);
    const expectedInvocationHash = sha256CanonicalJson(definition.invocation);

    const pack = await executeCandidateCalibration({
      definition,
      now: () => 0,
      createdAt: "2026-07-17T02:00:00.000Z",
    });

    expect(invocations.map((invocation) => invocation.candidateId)).toEqual(["A", "A"]);
    expect(pack.candidate_id).toBe("A");
    expect(pack.candidate_config_hash).toBe(expectedConfigHash);
    expect(pack.invocation_hash).toBe(expectedInvocationHash);
  });

  it("candidate ID·version·config·invocation mapping이 다르면 adapter 실행 전 거부한다", async () => {
    const { adapter, invocations } = createAdapter();
    const valid = createCandidateCalibrationDefinition("A", adapter);
    const forged = {
      ...valid,
      candidateId: "B" as const,
    };

    await expect(executeCandidateCalibration({
      definition: forged,
      now: () => 0,
      createdAt: "2026-07-17T02:00:00.000Z",
    })).rejects.toThrow(/candidate.*mapping/i);
    expect(invocations).toHaveLength(0);
  });

  it.each([
    { label: "invalid", outputText: "{}", inputTokens: 100, reason: "INVALID_OUTPUT" },
    { label: "budget", outputText: JSON.stringify(validOutput), inputTokens: 24_001, reason: "BUDGET_EXCEEDED" },
  ])("$label 실행은 hard-gate 실패로 꾸미지 않고 NOT_EVALUATED로 남긴다", async ({ outputText, inputTokens, reason }) => {
    const { adapter } = createAdapter(outputText, {
      inputTokens,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20,
    });
    const pack = await executeCandidateCalibration({
      definition: createCandidateCalibrationDefinition("A", adapter),
      now: () => 0,
      createdAt: "2026-07-17T02:00:00.000Z",
    });

    expect(pack.runs.every((run) => run.gate.evaluation === "NOT_EVALUATED")).toBe(true);
    expect(pack.runs.map((run) => run.gate)).toEqual([
      { runNumber: 1, evaluation: "NOT_EVALUATED", reason },
      { runNumber: 2, evaluation: "NOT_EVALUATED", reason },
    ]);
  });
});

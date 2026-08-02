// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { CandidateOutput } from "../contracts/candidateOutput";
import {
  RunnerEvidenceIntegrityError,
  runCandidateTwice,
} from "../runner/runCandidate";
import {
  CandidateInvocationError,
  type CandidateAdapter,
  type CandidateInvocation,
} from "../runner/types";

const output: CandidateOutput = {
  customer_reply: "A grounded answer.",
  decision: {
    intent_codes: ["ORDER_STATUS"],
    action_code: "PROVIDE_ORDER_STATUS",
    escalation_required: false,
    escalation_reason_code: "NOT_REQUIRED",
    target_queue: "NONE",
  },
  citations: [{ source_id: "ORD", section_id: "1.2" }],
};

const invocation: CandidateInvocation = {
  candidateId: "B",
  modelRequestedId: "gpt-5.6-terra",
  serviceTierRequested: "default",
  instructions: "locked",
  input: "locked",
  limits: { maxInputTokens: 24_000, maxOutputTokens: 800, timeoutMs: 30_000 },
  executionEnvelope: {
    maxProviderCalls: 1,
    maxRetrievalCalls: 1,
    maxToolCalls: 0,
  },
};

function providerCall(callNumber = 1) {
  return {
    callNumber,
    responseId: `resp-${callNumber}`,
    status: "completed" as const,
    modelRequestedId: invocation.modelRequestedId,
    modelReportedId: "gpt-5.6-terra",
    serviceTierRequested: invocation.serviceTierRequested,
    serviceTierReported: "default",
    latencyMs: 1,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    },
  };
}

function retrievalCall(callNumber = 1) {
  return {
    callNumber,
    operation: "VECTOR_STORE_SEARCH" as const,
    status: "COMPLETE" as const,
    requestedQuery: "policy",
    reportedQuery: "policy",
    vectorStoreId: "vs-benchmark",
    maxNumResults: 6,
    rewriteQuery: false,
    latencyMs: 1,
    results: [],
  };
}

function toolCall(callNumber = 1) {
  return {
    callNumber,
    modelTurn: 1,
    callId: `call-${callNumber}`,
    toolName: "search_policy",
    status: "COMPLETE" as const,
    arguments: {},
    argumentsJson: "{}",
    providerStatus: "completed",
    result: { ok: true },
    latencyMs: 1,
  };
}

function adapterWithEvidence(overrides: {
  providerCalls?: ReturnType<typeof providerCall>[];
  retrievalCalls?: ReturnType<typeof retrievalCall>[];
  toolCalls?: ReturnType<typeof toolCall>[];
}): CandidateAdapter {
  const providerCalls = overrides.providerCalls ?? [providerCall()];
  const finalProviderCall = providerCalls.at(-1)!;
  return {
    invoke: vi.fn(async () => ({
      responseId: finalProviderCall.responseId,
      status: "completed" as const,
      modelReportedId: finalProviderCall.modelReportedId,
      serviceTierReported: finalProviderCall.serviceTierReported,
      outputText: JSON.stringify(output),
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
      executionEvidence: {
        providerCalls,
        retrievalCalls: overrides.retrievalCalls ?? [],
        toolCalls: overrides.toolCalls ?? [],
      },
    })),
  };
}

describe("Runner-owned 평가 무결성 경계", () => {
  it("CandidateInvocationError가 아닌 unknown backend 오류는 후보 결과로 축소하지 않고 같은 객체를 상위로 던진다", async () => {
    const integrityError = new TypeError("manifest identity mismatch");
    const invoke = vi.fn(async () => { throw integrityError; });

    await expect(runCandidateTwice({ adapter: { invoke }, invocation }))
      .rejects.toBe(integrityError);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("deadline 뒤 발생한 unknown 무결성 오류도 TIMEOUT으로 가리지 않는다", async () => {
    let now = 0;
    const integrityError = new Error("dataset hash mismatch");
    const invoke = vi.fn(async () => {
      now = 30_001;
      throw integrityError;
    });

    await expect(runCandidateTwice({ adapter: { invoke }, invocation, now: () => now }))
      .rejects.toBe(integrityError);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("잘못된 호출 상한은 adapter 호출 전에 무결성 오류로 거부한다", async () => {
    const adapter = adapterWithEvidence({});
    const invalid = {
      ...invocation,
      executionEnvelope: { ...invocation.executionEnvelope!, maxProviderCalls: -1 },
    };

    await expect(runCandidateTwice({ adapter, invocation: invalid }))
      .rejects.toBeInstanceOf(RunnerEvidenceIntegrityError);
    expect(adapter.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["provider", { providerCalls: [providerCall(1), providerCall(2)] }],
    ["retrieval", { retrievalCalls: [retrievalCall(1), retrievalCall(2)] }],
    ["tool", { toolCalls: [toolCall(1)] }],
  ])("%s 호출 수가 config envelope를 넘으면 상위 무결성 오류가 된다", async (_label, evidence) => {
    await expect(runCandidateTwice({ adapter: adapterWithEvidence(evidence), invocation }))
      .rejects.toBeInstanceOf(RunnerEvidenceIntegrityError);
  });

  it("CandidateInvocationError에 포함된 위조 호출 수도 후보 실패로 기록하지 않는다", async () => {
    const adapter: CandidateAdapter = {
      invoke: async () => {
        throw new CandidateInvocationError("provider timeout", true, {
          kind: "TIMEOUT",
          usage: null,
          executionEvidence: {
            providerCalls: [providerCall(1), providerCall(2)],
            retrievalCalls: [],
            toolCalls: [],
          },
        });
      },
    };

    await expect(runCandidateTwice({ adapter, invocation }))
      .rejects.toBeInstanceOf(RunnerEvidenceIntegrityError);
  });

  it.each([
    ["retrieval", { retrievalCalls: [retrievalCall(1), retrievalCall(1)] }],
    ["tool", { toolCalls: [toolCall(1), toolCall(3)] }],
  ])("%s callNumber 중복·비연속을 무결성 오류로 거부한다", async (_label, evidence) => {
    const expanded = {
      ...invocation,
      executionEnvelope: {
        maxProviderCalls: 1,
        maxRetrievalCalls: 2,
        maxToolCalls: 2,
      },
    };
    await expect(runCandidateTwice({ adapter: adapterWithEvidence(evidence), invocation: expanded }))
      .rejects.toBeInstanceOf(RunnerEvidenceIntegrityError);
  });

  it("상한과 같은 provider 1/retrieval 1 및 허용된 retrieval 0은 정상 완료한다", async () => {
    const one = await runCandidateTwice({
      adapter: adapterWithEvidence({ retrievalCalls: [retrievalCall()] }),
      invocation,
    });
    const zero = await runCandidateTwice({ adapter: adapterWithEvidence({}), invocation });

    expect(one.every((run) => run.status === "COMPLETE")).toBe(true);
    expect(zero.every((run) => run.status === "COMPLETE")).toBe(true);
  });

  it("실행 envelope가 있는 completed 응답에 evidence가 없으면 무결성 오류가 된다", async () => {
    const adapter: CandidateAdapter = {
      invoke: async () => ({
        responseId: "resp-no-evidence",
        status: "completed",
        modelReportedId: "gpt-5.6-terra",
        outputText: JSON.stringify(output),
        usage: null,
      }),
    };

    await expect(runCandidateTwice({ adapter, invocation }))
      .rejects.toBeInstanceOf(RunnerEvidenceIntegrityError);
  });
});

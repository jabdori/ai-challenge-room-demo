// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { CandidateOutput } from "../contracts/candidateOutput";
import {
  CandidateInvocationError,
  type CandidateAdapter,
  type CandidateInvocation,
} from "../runner/types";
import {
  CandidateProgressObserverError,
  type CandidateProgressEvent,
} from "../runner/progress";
import {
  RunnerEvidenceIntegrityError,
  runCandidateOnce,
  runCandidateTwice,
} from "../runner/runCandidate";

const validOutput: CandidateOutput = {
  customer_reply: "This order has shipped, so it cannot be cancelled. You may request a return after delivery.",
  decision: {
    intent_codes: ["ORDER_CANCELLATION", "REFUND_REQUEST"],
    action_code: "DENY_CANCEL_AFTER_SHIPMENT",
    escalation_required: false,
    escalation_reason_code: "NOT_REQUIRED",
    target_queue: "NONE",
  },
  citations: [{ source_id: "CANCEL-2026", section_id: "2.2" }],
};

const invocation: CandidateInvocation = {
  candidateId: "A",
  modelRequestedId: "gpt-5.6-terra",
  serviceTierRequested: "default",
  instructions: "locked instructions",
  input: "locked input",
};

const timedInvocation: CandidateInvocation = {
  ...invocation,
  limits: {
    maxInputTokens: 24_000,
    maxOutputTokens: 800,
    timeoutMs: 30_000,
  },
};

const providerUsage = {
  inputTokens: 100,
  cachedInputTokens: 10,
  cacheWriteTokens: 5,
  outputTokens: 20,
  reasoningTokens: 4,
  totalTokens: 120,
};

function buildProviderCall(callNumber: number) {
  return {
    callNumber,
    responseId: `resp-provider-${callNumber}`,
    status: "completed" as const,
    modelRequestedId: invocation.modelRequestedId,
    modelReportedId: `gpt-5.6-terra-2026-07-${callNumber.toString().padStart(2, "0")}`,
    serviceTierRequested: invocation.serviceTierRequested,
    serviceTierReported: "default",
    latencyMs: callNumber * 10,
    usage: { ...providerUsage },
  };
}

describe("공통 Candidate Runner", () => {
  it("attempt와 retry 경계를 외부 호출 전에 await하고 실패한 시도까지 순서대로 관찰한다", async () => {
    let calls = 0;
    const events: CandidateProgressEvent[] = [];
    const adapter: CandidateAdapter = {
      invoke: async () => {
        calls += 1;
        if (calls === 1) {
          throw new CandidateInvocationError("temporary transport error", true);
        }
        return {
          responseId: "resp-progress",
          status: "completed",
          modelReportedId: "gpt-5.6-terra",
          outputText: JSON.stringify(validOutput),
          usage: null,
        };
      },
    };

    const result = await runCandidateOnce({
      adapter,
      invocation: timedInvocation,
      runNumber: 1,
      now: () => 0,
      onProgress: async (event) => {
        await Promise.resolve();
        events.push(event);
      },
    });

    expect(result.attempts.map((attempt) => attempt.status))
      .toEqual(["TRANSPORT_ERROR", "COMPLETE"]);
    expect(events.map((event) => event.kind)).toEqual([
      "CANDIDATE_ATTEMPT_STARTED",
      "CANDIDATE_ATTEMPT_FINISHED",
      "CANDIDATE_RETRY_STARTED",
      "CANDIDATE_ATTEMPT_STARTED",
      "CANDIDATE_ATTEMPT_FINISHED",
      "CANDIDATE_RETRY_FINISHED",
    ]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "CANDIDATE_ATTEMPT_FINISHED",
        attemptNumber: 1,
        status: "TRANSPORT_ERROR",
      }),
      expect.objectContaining({
        kind: "CANDIDATE_ATTEMPT_FINISHED",
        attemptNumber: 2,
        status: "COMPLETE",
      }),
    ]));
  });

  it("진행 observer 실패를 후보 실패나 재시도로 바꾸지 않고 플랫폼 오류로 전파한다", async () => {
    const observerFailure = new Error("simulated D1 write failure");
    const adapter: CandidateAdapter = {
      invoke: async () => {
        throw new Error("observer가 먼저 실패하므로 호출되면 안 됩니다.");
      },
    };

    await expect(runCandidateOnce({
      adapter,
      invocation: timedInvocation,
      runNumber: 1,
      onProgress: async () => {
        throw observerFailure;
      },
    })).rejects.toMatchObject({
      name: "CandidateProgressObserverError",
      cause: observerFailure,
    });
  });

  it.each([
    ["CANDIDATE_ATTEMPT_FINISHED", false],
    ["CANDIDATE_RETRY_FINISHED", true],
  ] as const)(
    "%s 저장 실패에도 방금 완료된 attempt의 사용량과 provider 증거를 보존한다",
    async (failedEvent, requireRetry) => {
      let calls = 0;
      const adapter: CandidateAdapter = {
        invoke: async () => {
          calls += 1;
          const attemptUsage = calls === 1
            ? structuredClone(providerUsage)
            : {
                inputTokens: 200,
                cachedInputTokens: 20,
                cacheWriteTokens: 10,
                outputTokens: 30,
                reasoningTokens: 6,
                totalTokens: 230,
              };
          const providerCall = {
            ...buildProviderCall(1),
            usage: attemptUsage,
          };
          return {
            responseId: providerCall.responseId,
            status: "completed",
            modelReportedId: providerCall.modelReportedId,
            serviceTierReported: providerCall.serviceTierReported,
            outputText: requireRetry && calls === 1
              ? JSON.stringify({ customer_reply: "" })
              : JSON.stringify(validOutput),
            usage: attemptUsage,
            executionEvidence: {
              providerCalls: [providerCall],
              retrievalCalls: [],
              toolCalls: [],
            },
          };
        },
      };

      const error = await runCandidateOnce({
        adapter,
        invocation: timedInvocation,
        runNumber: 1,
        now: () => 0,
        onProgress: (event) => {
          if (
            event.kind === failedEvent
            && (
              failedEvent !== "CANDIDATE_ATTEMPT_FINISHED"
              || event.attemptNumber === (requireRetry ? 2 : 1)
            )
          ) {
            throw new Error("simulated durable progress failure");
          }
        },
      }).catch((caught: unknown) => caught);

      const expectedUsage = requireRetry
        ? {
            inputTokens: 300,
            cachedInputTokens: 30,
            cacheWriteTokens: 15,
            outputTokens: 50,
            reasoningTokens: 10,
            totalTokens: 350,
          }
        : providerUsage;
      expect(error).toMatchObject({
        name: "CandidateProgressObserverError",
        capturedEvidence: {
          usage: expectedUsage,
        },
      });
      const captured = (error as CandidateProgressObserverError).capturedEvidence;
      expect(captured?.executionEvidence.providerCalls).toHaveLength(
        requireRetry ? 2 : 1,
      );
    },
  );

  it("유료 1차 실패 뒤 RETRY_STARTED 저장 실패에도 이전 attempt 비용과 증거를 보존한다", async () => {
    const adapter: CandidateAdapter = {
      invoke: async () => {
        const providerCall = buildProviderCall(1);
        return {
          responseId: providerCall.responseId,
          status: "completed",
          modelReportedId: providerCall.modelReportedId,
          serviceTierReported: providerCall.serviceTierReported,
          outputText: JSON.stringify({ customer_reply: "" }),
          usage: structuredClone(providerUsage),
          executionEvidence: {
            providerCalls: [providerCall],
            retrievalCalls: [],
            toolCalls: [],
          },
        };
      },
    };

    const error = await runCandidateOnce({
      adapter,
      invocation: timedInvocation,
      runNumber: 1,
      now: () => 0,
      onProgress: (event) => {
        if (event.kind === "CANDIDATE_RETRY_STARTED") {
          throw new Error("simulated retry progress failure");
        }
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateProgressObserverError",
      event: { kind: "CANDIDATE_RETRY_STARTED", attemptNumber: 2 },
      capturedEvidence: {
        usage: providerUsage,
        executionEvidence: {
          providerCalls: [{ responseId: "resp-provider-1" }],
        },
      },
    });
  });

  it("observer 생략과 no-op observer가 후보 결과·사용량·재시도 의미를 바꾸지 않는다", async () => {
    const buildAdapter = (): CandidateAdapter => ({
      invoke: async () => ({
        responseId: "resp-compatible",
        status: "completed",
        modelReportedId: "gpt-5.6-terra",
        outputText: JSON.stringify(validOutput),
        usage: null,
      }),
    });

    const withoutObserver = await runCandidateOnce({
      adapter: buildAdapter(),
      invocation: timedInvocation,
      runNumber: 1,
      now: () => 0,
    });
    const withObserver = await runCandidateOnce({
      adapter: buildAdapter(),
      invocation: timedInvocation,
      runNumber: 1,
      now: () => 0,
      onProgress: async () => {},
    });

    expect(withObserver).toEqual(withoutObserver);
  });

  it("이미 취소된 signal이면 adapter를 호출하지 않고 원래 abort reason을 그대로 던진다", async () => {
    const reason = new Error("사용자가 calibration을 취소했습니다.");
    const controller = new AbortController();
    controller.abort(reason);
    let calls = 0;
    const adapter: CandidateAdapter = {
      invoke: async () => {
        calls += 1;
        throw new Error("호출되면 안 됩니다.");
      },
    };

    await expect(runCandidateTwice({
      adapter,
      invocation: timedInvocation,
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(calls).toBe(0);
  });

  it("실행 중 취소되면 같은 signal을 adapter에 전달하고 재시도·두 번째 run 없이 중단한다", async () => {
    const reason = new Error("실행 중단");
    const controller = new AbortController();
    const receivedSignals: Array<AbortSignal | undefined> = [];
    let calls = 0;
    const adapter: CandidateAdapter = {
      invoke: async (_receivedInvocation, context) => {
        calls += 1;
        receivedSignals.push(context?.signal);
        controller.abort(reason);
        return {
          responseId: "resp-aborted",
          status: "completed",
          modelReportedId: "gpt-5.6-terra",
          outputText: JSON.stringify(validOutput),
          usage: null,
        };
      },
    };

    await expect(runCandidateTwice({
      adapter,
      invocation: timedInvocation,
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(calls).toBe(1);
    expect(receivedSignals).toEqual([controller.signal]);
  });

  it("5초 전송 실패 뒤 재시도에는 run deadline의 남은 25초만 전달한다", async () => {
    let currentTime = 0;
    let calls = 0;
    const receivedTimeouts: number[] = [];
    const adapter: CandidateAdapter = {
      invoke: async (_receivedInvocation, context) => {
        calls += 1;
        receivedTimeouts.push(context!.timeoutMs);
        if (calls % 2 === 1) {
          currentTime += 5_000;
          throw new CandidateInvocationError("temporary transport error", true);
        }
        currentTime += 1;
        return {
          responseId: `resp-deadline-${calls}`,
          status: "completed",
          modelReportedId: "gpt-5.6-terra",
          outputText: JSON.stringify(validOutput),
          usage: null,
        };
      },
    };

    const result = await runCandidateTwice({
      adapter,
      invocation: timedInvocation,
      now: () => currentTime,
    });

    expect(receivedTimeouts).toEqual([30_000, 25_000, 30_000, 25_000]);
    expect(result.every((run) => run.status === "COMPLETE")).toBe(true);
  });

  it("10초 Schema 실패 뒤 재시도에는 run deadline의 남은 20초만 전달한다", async () => {
    let currentTime = 0;
    let calls = 0;
    const receivedTimeouts: number[] = [];
    const adapter: CandidateAdapter = {
      invoke: async (_receivedInvocation, context) => {
        calls += 1;
        receivedTimeouts.push(context!.timeoutMs);
        if (calls % 2 === 1) {
          currentTime += 10_000;
          return {
            responseId: `resp-invalid-${calls}`,
            status: "completed",
            modelReportedId: "gpt-5.6-terra",
            outputText: JSON.stringify({ customer_reply: "" }),
            usage: null,
          };
        }
        currentTime += 1;
        return {
          responseId: `resp-valid-${calls}`,
          status: "completed",
          modelReportedId: "gpt-5.6-terra",
          outputText: JSON.stringify(validOutput),
          usage: null,
        };
      },
    };

    const result = await runCandidateTwice({
      adapter,
      invocation: timedInvocation,
      now: () => currentTime,
    });

    expect(receivedTimeouts).toEqual([30_000, 20_000, 30_000, 20_000]);
    expect(result.every((run) => run.status === "COMPLETE")).toBe(true);
  });

  it("첫 attempt가 전체 30초를 소진하면 adapter를 다시 호출하지 않고 TIMEOUT으로 종료한다", async () => {
    let currentTime = 0;
    let calls = 0;
    const adapter: CandidateAdapter = {
      invoke: async () => {
        calls += 1;
        currentTime += 30_000;
        throw new CandidateInvocationError("transport finished at deadline", true);
      },
    };

    const result = await runCandidateTwice({
      adapter,
      invocation: timedInvocation,
      now: () => currentTime,
    });

    expect(calls).toBe(2);
    expect(result.every((run) => run.status === "TIMEOUT")).toBe(true);
    expect(result.every((run) => run.attempts.length === 1)).toBe(true);
    expect(result.every((run) => run.attempts[0].status === "TIMEOUT")).toBe(true);
  });

  it("deadline 뒤 반환된 유효 출력도 승인하지 않고 usage와 evidence를 보존한다", async () => {
    let currentTime = 0;
    let calls = 0;
    const executionEvidence = {
      providerCalls: [buildProviderCall(1)],
      retrievalCalls: [],
      toolCalls: [],
    };
    const adapter: CandidateAdapter = {
      invoke: async () => {
        calls += 1;
        currentTime += 30_001;
        return {
          responseId: "resp-provider-1",
          status: "completed",
          modelReportedId: "gpt-5.6-terra-2026-07-01",
          serviceTierReported: "default",
          outputText: JSON.stringify(validOutput),
          usage: { ...providerUsage },
          executionEvidence,
        };
      },
    };

    const result = await runCandidateTwice({
      adapter,
      invocation: timedInvocation,
      now: () => currentTime,
    });

    expect(calls).toBe(2);
    expect(result.every((run) => run.status === "TIMEOUT")).toBe(true);
    expect(result.every((run) => run.output === undefined)).toBe(true);
    expect(result[0].attempts[0]).toMatchObject({
      status: "TIMEOUT",
      responseId: "resp-provider-1",
      usage: providerUsage,
      executionEvidence,
    });
  });

  it("attempt마다 복사본을 전달하고 원본 invocation의 30초 timeout을 변경하지 않는다", async () => {
    let currentTime = 0;
    const receivedInvocations: CandidateInvocation[] = [];
    const adapter: CandidateAdapter = {
      invoke: async (receivedInvocation) => {
        receivedInvocations.push(receivedInvocation);
        currentTime += 1;
        return {
          responseId: `resp-copy-${receivedInvocations.length}`,
          status: "completed",
          modelReportedId: "gpt-5.6-terra",
          outputText: JSON.stringify(validOutput),
          usage: null,
        };
      },
    };

    await runCandidateTwice({
      adapter,
      invocation: timedInvocation,
      now: () => currentTime,
    });

    expect(timedInvocation.limits?.timeoutMs).toBe(30_000);
    expect(receivedInvocations).toHaveLength(2);
    expect(receivedInvocations.every((received) => received !== timedInvocation)).toBe(true);
    expect(receivedInvocations.every((received) => received.limits !== timedInvocation.limits)).toBe(true);
    expect(receivedInvocations.map((received) => received.limits?.timeoutMs)).toEqual([30_000, 30_000]);
  });

  it("두 번을 독립 호출하고 실행기 소유 계측을 보존한다", async () => {
    let calls = 0;
    const adapter: CandidateAdapter = {
      invoke: async () => {
        calls += 1;
        return {
          responseId: `resp-${calls}`,
          status: "completed",
          modelReportedId: `gpt-5.6-terra-2026-07-${calls.toString().padStart(2, "0")}`,
          outputText: JSON.stringify(validOutput),
          usage: {
            inputTokens: 1_000,
            cachedInputTokens: 100,
            cacheWriteTokens: 0,
            outputTokens: 200,
          },
        };
      },
    };

    let now = 1_000;
    const result = await runCandidateTwice({
      adapter,
      invocation,
      now: () => (now += 25),
    });

    expect(calls).toBe(2);
    expect(result).toHaveLength(2);
    expect(result.map((run) => run.runNumber)).toEqual([1, 2]);
    expect(result.every((run) => run.status === "COMPLETE")).toBe(true);
    expect(result.every((run) => run.attempts.length === 1)).toBe(true);
    expect(result[0].attempts[0].latencyMs).toBe(25);
    expect(result[0].output).toEqual(validOutput);
  });

  it("Schema 오류를 한 번만 재시도하고 실패한 시도의 사용량도 남긴다", async () => {
    let calls = 0;
    const adapter: CandidateAdapter = {
      invoke: async () => {
        calls += 1;
        return {
          responseId: `resp-${calls}`,
          status: "completed",
          modelReportedId: "gpt-5.6-terra-2026-07-17",
          outputText: calls === 1 ? JSON.stringify({ customer_reply: "" }) : JSON.stringify(validOutput),
          usage: {
            inputTokens: calls === 1 ? 400 : 500,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: calls === 1 ? 30 : 120,
          },
        };
      },
    };

    const result = await runCandidateTwice({ adapter, invocation });

    expect(calls).toBe(3);
    expect(result[0].status).toBe("COMPLETE");
    expect(result[0].attempts.map((attempt) => attempt.status)).toEqual(["INVALID_OUTPUT", "COMPLETE"]);
    expect(result[0].attempts[0].usage?.inputTokens).toBe(400);
    expect(result[1].attempts).toHaveLength(1);
  });

  it("정책 gate 실패는 호출 재시도 사유로 취급하지 않는다", async () => {
    let calls = 0;
    const policyWrongOutput = {
      ...validOutput,
      decision: { ...validOutput.decision, action_code: "CANCEL_CONFIRMED" },
    };
    const adapter: CandidateAdapter = {
      invoke: async () => {
        calls += 1;
        return {
          responseId: `resp-${calls}`,
          status: "completed",
          modelReportedId: "gpt-5.6-terra-2026-07-17",
          outputText: JSON.stringify(policyWrongOutput),
          usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 20 },
        };
      },
    };

    const result = await runCandidateTwice({ adapter, invocation });

    expect(calls).toBe(2);
    expect(result.every((run) => run.attempts.length === 1)).toBe(true);
  });

  it("인증·요청 Schema 같은 비재시도 오류는 실행마다 한 번만 기록한다", async () => {
    let calls = 0;
    const adapter: CandidateAdapter = {
      invoke: async () => {
        calls += 1;
        throw new CandidateInvocationError("400 invalid request schema", false);
      },
    };

    const result = await runCandidateTwice({ adapter, invocation });

    expect(calls).toBe(2);
    expect(result.every((run) => run.status === "INVALID")).toBe(true);
    expect(result.every((run) => run.attempts.length === 1)).toBe(true);
    expect(result.every((run) => run.attempts[0].status === "REQUEST_ERROR")).toBe(true);
  });

  it("잠긴 입력 예산을 넘긴 호출은 비용 증거를 남기고 BUDGET_EXCEEDED로 종료한다", async () => {
    let calls = 0;
    const adapter: CandidateAdapter = {
      invoke: async () => {
        calls += 1;
        return {
          responseId: `resp-budget-${calls}`,
          status: "completed",
          modelReportedId: "gpt-5.6-terra",
          outputText: JSON.stringify(validOutput),
          usage: {
            inputTokens: 24_001,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 100,
          },
        };
      },
    };

    const result = await runCandidateTwice({
      adapter,
      invocation: {
        ...invocation,
        limits: { maxInputTokens: 24_000, maxOutputTokens: 800 },
      },
    });

    expect(calls).toBe(2);
    expect(result.every((run) => run.status === "BUDGET_EXCEEDED")).toBe(true);
    expect(result.every((run) => run.attempts.length === 1)).toBe(true);
    expect(result[0].attempts[0]).toMatchObject({
      status: "BUDGET_EXCEEDED",
      usage: { inputTokens: 24_001 },
    });
  });

  it("Schema 재시도의 이전 사용량까지 run 단위로 누적해 입력 예산 초과를 차단한다", async () => {
    let calls = 0;
    const adapter: CandidateAdapter = {
      invoke: async () => {
        calls += 1;
        return {
          responseId: `resp-cumulative-${calls}`,
          status: "completed",
          modelReportedId: "gpt-5.6-terra",
          outputText: calls % 2 === 1
            ? JSON.stringify({ customer_reply: "" })
            : JSON.stringify(validOutput),
          usage: {
            inputTokens: 13_000,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 100,
          },
        };
      },
    };

    const result = await runCandidateTwice({
      adapter,
      invocation: {
        ...invocation,
        limits: { maxInputTokens: 24_000, maxOutputTokens: 800, timeoutMs: 30_000 },
      },
    });

    expect(calls).toBe(4);
    expect(result.every((run) => run.status === "BUDGET_EXCEEDED")).toBe(true);
    expect(result.every((run) => run.output === undefined)).toBe(true);
    expect(result.map((run) => run.attempts.map((attempt) => attempt.status)))
      .toEqual([
        ["INVALID_OUTPUT", "BUDGET_EXCEEDED"],
        ["INVALID_OUTPUT", "BUDGET_EXCEEDED"],
      ]);
    expect(result[0].attempts.map((attempt) => attempt.usage?.inputTokens)).toEqual([13_000, 13_000]);
  });

  it.each([
    ["refused", "REFUSED"],
    ["incomplete", "INCOMPLETE"],
    ["failed", "FAILED"],
  ] as const)("%s 응답 상태는 자동 재시도하지 않는다", async (responseStatus, attemptStatus) => {
    let calls = 0;
    const adapter: CandidateAdapter = {
      invoke: async () => {
        calls += 1;
        return {
          responseId: `resp-${responseStatus}-${calls}`,
          status: responseStatus,
          modelReportedId: "gpt-5.6-terra",
          outputText: null,
          usage: null,
          error: responseStatus,
        };
      },
    };

    const result = await runCandidateTwice({ adapter, invocation });

    expect(calls).toBe(2);
    expect(result.every((run) => run.attempts.length === 1)).toBe(true);
    expect(result.every((run) => run.attempts[0].status === attemptStatus)).toBe(true);
  });

  it("한 attempt 내부의 provider·retrieval·tool 호출 증거를 손실 없이 보존한다", async () => {
    const executionEvidence = {
      providerCalls: [buildProviderCall(1)],
      retrievalCalls: [{
        callNumber: 1,
        operation: "VECTOR_STORE_SEARCH" as const,
        status: "COMPLETE" as const,
        requestedQuery: "배송 후 취소 정책",
        reportedQuery: "배송 완료 주문 취소 정책",
        vectorStoreId: "vs-policy",
        maxNumResults: 3,
        rewriteQuery: true,
        latencyMs: 7,
        results: [{
          rank: 1,
          fileId: "file-policy",
          filename: "policy.json",
          score: 0.97,
          sourceId: "CANCEL-2026",
          sectionId: "2.2",
          factId: "fact-cancel-after-shipment",
          text: "배송 후에는 취소할 수 없습니다.",
        }],
      }],
      toolCalls: [{
        callNumber: 1,
        modelTurn: 1,
        callId: "call-order",
        toolName: "get_order" as const,
        status: "COMPLETE" as const,
        arguments: { orderId: "ORD-1042" },
        argumentsJson: JSON.stringify({ orderId: "ORD-1042" }),
        providerStatus: "completed",
        result: { orderId: "ORD-1042", status: "SHIPPED" },
        latencyMs: 5,
      }],
    };
    const adapter: CandidateAdapter = {
      invoke: async () => ({
        responseId: "resp-provider-1",
        status: "completed",
        modelReportedId: "gpt-5.6-terra-2026-07-01",
        serviceTierReported: "default",
        outputText: JSON.stringify(validOutput),
        usage: { ...providerUsage },
        executionEvidence,
      }),
    };

    const result = await runCandidateTwice({ adapter, invocation });

    expect(result[0].attempts[0].executionEvidence).toEqual(executionEvidence);
    expect(result[0].attempts[0].executionEvidence?.providerCalls).toHaveLength(1);
    expect(result[0].attempts[0].executionEvidence?.retrievalCalls[0].results[0].factId)
      .toBe("fact-cancel-after-shipment");
    expect(result[0].attempts[0].executionEvidence?.toolCalls[0].result)
      .toEqual({ orderId: "ORD-1042", status: "SHIPPED" });
  });

  it("provider call 사용량 합계가 aggregate usage와 다르면 상위 평가 무결성 오류로 중단한다", async () => {
    let calls = 0;
    const firstUsage = {
      inputTokens: 40,
      cachedInputTokens: 4,
      cacheWriteTokens: 1,
      outputTokens: 10,
      reasoningTokens: 2,
      totalTokens: 50,
    };
    const secondUsage = {
      inputTokens: 60,
      cachedInputTokens: 6,
      cacheWriteTokens: 4,
      outputTokens: 10,
      reasoningTokens: 2,
      totalTokens: 70,
    };
    const executionEvidence = {
      providerCalls: [
        { ...buildProviderCall(1), usage: firstUsage },
        { ...buildProviderCall(2), usage: secondUsage },
      ],
      retrievalCalls: [],
      toolCalls: [],
    };
    const adapter: CandidateAdapter = {
      invoke: async () => {
        calls += 1;
        return {
          responseId: "resp-provider-2",
          status: "completed",
          modelReportedId: "gpt-5.6-terra-2026-07-02",
          serviceTierReported: "default",
          outputText: JSON.stringify(validOutput),
          usage: {
            inputTokens: 999,
            cachedInputTokens: 10,
            cacheWriteTokens: 5,
            outputTokens: 20,
            reasoningTokens: 4,
            totalTokens: 1_019,
          },
          executionEvidence,
        };
      },
    };

    await expect(runCandidateTwice({ adapter, invocation }))
      .rejects.toMatchObject({
        name: "RunnerEvidenceIntegrityError",
        message: expect.stringContaining("aggregate usage"),
      });
    expect(calls).toBe(1);
  });

  it.each([
    ["중복 callNumber", [buildProviderCall(1), buildProviderCall(1)]],
    ["비연속 callNumber", [buildProviderCall(1), buildProviderCall(3)]],
    ["음수 latency", [{ ...buildProviderCall(1), latencyMs: -1 }]],
    ["음수 token", [{
      ...buildProviderCall(1),
      usage: { ...providerUsage, inputTokens: -1 },
    }]],
  ])("유효하지 않은 provider evidence(%s)는 상위 평가 무결성 오류로 중단한다", async (_case, providerCalls) => {
    let calls = 0;
    const aggregateUsage = providerCalls.reduce(
      (total, call) => ({
        inputTokens: total.inputTokens + (call.usage?.inputTokens ?? 0),
        cachedInputTokens: total.cachedInputTokens + (call.usage?.cachedInputTokens ?? 0),
        cacheWriteTokens: total.cacheWriteTokens + (call.usage?.cacheWriteTokens ?? 0),
        outputTokens: total.outputTokens + (call.usage?.outputTokens ?? 0),
        reasoningTokens: total.reasoningTokens + (call.usage?.reasoningTokens ?? 0),
        totalTokens: total.totalTokens + (call.usage?.totalTokens ?? 0),
      }),
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      },
    );
    const adapter: CandidateAdapter = {
      invoke: async () => {
        calls += 1;
        return {
          responseId: `resp-invalid-evidence-${calls}`,
          status: "completed",
          modelReportedId: "gpt-5.6-terra-2026-07-17",
          serviceTierReported: "default",
          outputText: JSON.stringify(validOutput),
          usage: aggregateUsage,
          executionEvidence: { providerCalls, retrievalCalls: [], toolCalls: [] },
        };
      },
    };

    await expect(runCandidateTwice({ adapter, invocation }))
      .rejects.toBeInstanceOf(RunnerEvidenceIntegrityError);
    expect(calls).toBe(1);
  });

  it.each([
    ["요청 모델", { modelRequestedId: "gpt-5.6-luna" }],
    ["요청 service tier", { serviceTierRequested: "priority" }],
  ])("provider evidence의 %s이 invocation과 다르면 거부한다", async (_case, override) => {
    const adapter: CandidateAdapter = {
      invoke: async () => ({
        responseId: "resp-mismatched-request",
        status: "completed",
        modelReportedId: "gpt-5.6-terra-2026-07-17",
        serviceTierReported: "default",
        outputText: JSON.stringify(validOutput),
        usage: { ...providerUsage },
        executionEvidence: {
          providerCalls: [{ ...buildProviderCall(1), ...override }],
          retrievalCalls: [],
          toolCalls: [],
        },
      }),
    };

    await expect(runCandidateTwice({ adapter, invocation }))
      .rejects.toBeInstanceOf(RunnerEvidenceIntegrityError);
  });

  it("adapter가 반환한 evidence 원본을 사후 변경해도 attempt snapshot은 바뀌지 않는다", async () => {
    const executionEvidence = {
      providerCalls: [buildProviderCall(1)],
      retrievalCalls: [],
      toolCalls: [{
        callNumber: 1,
        modelTurn: 1,
        callId: "call-order",
        toolName: "get_order" as const,
        status: "COMPLETE" as const,
        arguments: { orderId: "ORD-1042" },
        argumentsJson: JSON.stringify({ orderId: "ORD-1042" }),
        providerStatus: "completed",
        result: { status: "SHIPPED" },
        latencyMs: 3,
      }],
    };
    const adapter: CandidateAdapter = {
      invoke: async () => ({
        responseId: "resp-provider-1",
        status: "completed",
        modelReportedId: "gpt-5.6-terra-2026-07-01",
        serviceTierReported: "default",
        outputText: JSON.stringify(validOutput),
        usage: { ...providerUsage },
        executionEvidence,
      }),
    };
    const result = await runCandidateTwice({ adapter, invocation });

    executionEvidence.providerCalls[0].usage!.inputTokens = 9_999;
    executionEvidence.toolCalls[0].arguments.orderId = "MUTATED";
    (executionEvidence.toolCalls[0].result as { status: string }).status = "MUTATED";

    expect(result[0].attempts[0].executionEvidence?.providerCalls[0].usage?.inputTokens).toBe(100);
    expect(result[0].attempts[0].executionEvidence?.toolCalls[0].arguments)
      .toEqual({ orderId: "ORD-1042" });
    expect(result[0].attempts[0].executionEvidence?.toolCalls[0].result)
      .toEqual({ status: "SHIPPED" });
  });
});

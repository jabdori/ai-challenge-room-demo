// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createBenchmarkCandidateDefinition } from "../benchmark/candidateDefinitions";
import {
  evaluateBenchmarkSlotReceipt,
  executeBenchmarkCandidateSlot,
  executeBenchmarkSlot,
} from "../benchmark/executeSlot";
import { buildBenchmarkSchedule } from "../benchmark/schedule";
import type { CandidateOutput } from "../contracts/candidateOutput";
import {
  BENCHMARK_CASES,
  BENCHMARK_CHALLENGE,
  BENCHMARK_ORDERS,
  BENCHMARK_ORACLES,
  BENCHMARK_POLICIES,
} from "../data/benchmark";
import { runCandidateOnce } from "../runner/runCandidate";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import { DEFAULT_PRICING_SNAPSHOT } from "../runtime/pricing";
import {
  CandidateInvocationError,
  type CandidateAdapter,
  type CandidateAdapterResult,
  type CandidateInvocation,
} from "../runner/types";

const invocation: CandidateInvocation = {
  candidateId: "A",
  modelRequestedId: "gpt-5.6-terra",
  serviceTierRequested: "default",
  instructions: "locked benchmark prompt",
  input: "locked benchmark input",
  limits: { maxInputTokens: 24_000, maxOutputTokens: 800, timeoutMs: 30_000 },
  executionEnvelope: {
    maxProviderCalls: 1,
    maxRetrievalCalls: 0,
    maxToolCalls: 0,
  },
};

function completeAdapter(): { adapter: CandidateAdapter; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async () => ({
    responseId: "resp-benchmark-slot",
    status: "completed" as const,
    modelReportedId: "gpt-5.6-terra-2026-07-17",
    serviceTierReported: "default",
    outputText: JSON.stringify({
      customer_reply: "The authorized order is in transit.",
      decision: {
        intent_codes: ["ORDER_STATUS"],
        action_code: "PROVIDE_ORDER_STATUS",
        escalation_required: false,
        escalation_reason_code: "NOT_REQUIRED",
        target_queue: "NONE",
      },
      citations: [{ source_id: "ORD", section_id: "1.2" }],
    }),
    usage: {
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20,
    },
    executionEvidence: {
      providerCalls: [{
        callNumber: 1,
        responseId: "resp-benchmark-slot",
        status: "completed" as const,
        modelRequestedId: "gpt-5.6-terra",
        modelReportedId: "gpt-5.6-terra-2026-07-17",
        serviceTierRequested: "default",
        serviceTierReported: "default",
        latencyMs: 5,
        usage: {
          inputTokens: 100,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 20,
        },
      }],
      retrievalCalls: [],
      toolCalls: [],
    },
  }));
  return { adapter: { invoke }, invoke };
}

const schedule = buildBenchmarkSchedule(BENCHMARK_CASES, ["A", "B", "C"]);

function hiddenFixture(
  candidateId: "A" | "B" | "C" = "A",
  repetition: 1 | 2 = 1,
  caseId = "H-001",
) {
  const evaluationCase = BENCHMARK_CASES.find((item) => item.case_id === caseId)!;
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === caseId)!;
  const authoritativeOrder = evaluationCase.order_id === null
    ? null
    : BENCHMARK_ORDERS.find((item) => item.order_id === evaluationCase.order_id) ?? null;
  const slot = schedule.find(
    (item) => item.case_id === caseId
      && item.candidate_id === candidateId
      && item.repetition === repetition,
  )!;
  return { evaluationCase, oracle, authoritativeOrder, slot };
}

function oracleOutput(caseId = "H-001"): CandidateOutput {
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === caseId)!;
  return {
    customer_reply: oracle.reference_replies[0],
    decision: {
      intent_codes: [...oracle.expected_intent_codes],
      action_code: oracle.expected_action_code,
      escalation_required: oracle.escalation_required,
      escalation_reason_code: oracle.escalation_reason_code,
      target_queue: oracle.target_queue,
    },
    citations: structuredClone(oracle.required_citations),
  };
}

function usage(inputTokens = 100, outputTokens = 20) {
  return {
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens,
  };
}

function providerCall(
  candidateId: "A" | "B" | "C",
  callNumber = 1,
  tokenUsage = usage(),
) {
  return {
    callNumber,
    responseId: `resp-${candidateId}-${callNumber}`,
    status: "completed" as const,
    modelRequestedId: "gpt-5.6-terra",
    modelReportedId: "gpt-5.6-terra-2026-07-17",
    serviceTierRequested: "default",
    serviceTierReported: "default",
    latencyMs: 5,
    usage: tokenUsage,
  };
}

function completeResult(
  candidateId: "A" | "B" | "C",
  caseId = "H-001",
  overrides: Partial<CandidateAdapterResult> = {},
): CandidateAdapterResult {
  const tokenUsage = usage();
  return {
    responseId: `resp-${candidateId}-1`,
    status: "completed",
    modelReportedId: "gpt-5.6-terra-2026-07-17",
    serviceTierReported: "default",
    outputText: JSON.stringify(oracleOutput(caseId)),
    usage: tokenUsage,
    executionEvidence: {
      providerCalls: [providerCall(candidateId, 1, tokenUsage)],
      retrievalCalls: [],
      toolCalls: [],
    },
    ...overrides,
  };
}

function definitionFor(
  candidateId: "A" | "B" | "C",
  adapter: CandidateAdapter,
  caseId = "H-001",
) {
  const { evaluationCase, authoritativeOrder } = hiddenFixture(candidateId, 1, caseId);
  const expectedAccess = BENCHMARK_ORACLES
    .find((item) => item.case_id === caseId)!
    .candidate_access_expectations
    .find((item) => item.candidate_id === candidateId)!;
  const authorizedOrder = expectedAccess.expected_order_access_status === "SUCCESS"
    ? authoritativeOrder
    : null;
  return createBenchmarkCandidateDefinition({
    candidateId,
    evaluationCase,
    authorizedOrder,
    policyCorpus: BENCHMARK_POLICIES,
    adapter,
    challenge: BENCHMARK_CHALLENGE,
  });
}

async function executeWith(
  candidateId: "A" | "B" | "C",
  repetition: 1 | 2,
  adapter: CandidateAdapter,
  caseId = "H-001",
) {
  const fixture = hiddenFixture(candidateId, repetition, caseId);
  return executeBenchmarkSlot({
    slot: fixture.slot,
    candidateDefinition: definitionFor(candidateId, adapter, caseId),
    evaluationCase: fixture.evaluationCase,
    oracle: fixture.oracle,
    policies: BENCHMARK_POLICIES,
    authoritativeOrder: fixture.authoritativeOrder,
  });
}

describe("숨은 Benchmark 단일 slot runner", () => {
  it("후보 원격 실행과 결정적 gate 평가를 분리해 receipt를 먼저 기록할 수 있다", async () => {
    const invoke = vi.fn(async () => completeResult("A"));
    const fixture = hiddenFixture("A", 1);
    const options = {
      slot: fixture.slot,
      candidateDefinition: definitionFor("A", { invoke }),
      evaluationCase: fixture.evaluationCase,
      oracle: fixture.oracle,
      policies: BENCHMARK_POLICIES,
      authoritativeOrder: fixture.authoritativeOrder,
    };

    const candidateExecution = await executeBenchmarkCandidateSlot(options);

    expect(invoke).toHaveBeenCalledOnce();
    expect(candidateExecution).not.toHaveProperty("evaluationState");
    expect(candidateExecution).toMatchObject({
      executionStatus: "COMPLETE",
      run: { status: "COMPLETE" },
    });

    const evaluationState = evaluateBenchmarkSlotReceipt({
      ...options,
      candidateExecution,
    });
    expect(evaluationState).toMatchObject({ status: "EVALUATED" });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("gate 증거 오류가 나도 완료된 후보 실행 receipt는 먼저 보존할 수 있다", async () => {
    const invoke = vi.fn(async () => completeResult("B"));
    const fixture = hiddenFixture("B", 1);
    const options = {
      slot: fixture.slot,
      candidateDefinition: definitionFor("B", { invoke }),
      evaluationCase: fixture.evaluationCase,
      oracle: fixture.oracle,
      policies: BENCHMARK_POLICIES,
      authoritativeOrder: fixture.authoritativeOrder,
    };

    const candidateExecution = await executeBenchmarkCandidateSlot(options);
    expect(candidateExecution).toMatchObject({
      executionStatus: "COMPLETE",
      run: { status: "COMPLETE" },
    });
    expect(invoke).toHaveBeenCalledOnce();

    expect(evaluateBenchmarkSlotReceipt({
      ...options,
      candidateExecution,
    })).toMatchObject({
      status: "EVALUATION_INCOMPLETE",
      errorCode: "RUNNER_RETRIEVAL_EVIDENCE_MISSING",
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it.each([1, 2] as const)(
    "반복 %i slot은 adapter를 정확히 한 번 호출하고 해당 runNumber로 끝낸다",
    async (runNumber) => {
      const { adapter, invoke } = completeAdapter();

      const result = await runCandidateOnce({ adapter, invocation, runNumber });

      expect(invoke).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        runNumber,
        status: "COMPLETE",
        attempts: [{ attemptNumber: 1, status: "COMPLETE" }],
      });
    },
  );

  it("잠긴 반복 1·2 밖의 runNumber는 원격 adapter 호출 전에 거부한다", async () => {
    const { adapter, invoke } = completeAdapter();

    await expect(runCandidateOnce({
      adapter,
      invocation,
      runNumber: 3 as 1,
    })).rejects.toThrow(/runNumber|반복/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([1, 2] as const)(
    "schedule 반복 %i를 정확히 한 번 실행하고 COMPLETE와 EVALUATED를 직교 기록한다",
    async (repetition) => {
      const invoke = vi.fn(async () => completeResult("A"));

      const result = await executeWith("A", repetition, { invoke });

      expect(invoke).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        executionStatus: "COMPLETE",
        evaluationState: { status: "EVALUATED" },
        requestDisposition: "SENT_RESPONSE_RECORDED",
        costState: "COMPLETE",
        run: { runNumber: repetition, status: "COMPLETE" },
        completedExecutionEvidence: {
          slotId: `H-001--A--r${repetition}`,
          repetition,
          finalStatus: "COMPLETE",
        },
      });
    },
  );

  it.each([
    [
      "INVALID",
      async () => completeResult("A", "H-001", { outputText: "not-json" }),
      { requestDisposition: "SENT_RESPONSE_RECORDED", costState: "COMPLETE" },
    ],
    ["TIMEOUT", async () => {
      throw new CandidateInvocationError("timeout", false, { kind: "TIMEOUT", usage: null });
    }, { requestDisposition: "SENT_OUTCOME_UNKNOWN", costState: "COST_INCOMPLETE" }],
    ["BUDGET_EXCEEDED", async () => {
      throw new CandidateInvocationError("budget", false, {
        kind: "BUDGET_EXCEEDED",
        usage: null,
      });
    }, { requestDisposition: "NOT_SENT", costState: "COMPLETE" }],
  ] as const)("%s 실행은 hard gate를 호출하지 않고 NOT_EVALUATED다", async (
    status,
    invokeImpl,
    expectedBoundary,
  ) => {
    const result = await executeWith("A", 1, { invoke: vi.fn(invokeImpl) });

    expect(result.executionStatus).toBe(status);
    expect(result.evaluationState).toMatchObject({ status: "NOT_EVALUATED" });
    expect(result.completedExecutionEvidence).toBeNull();
    expect(result).toMatchObject({
      ...expectedBoundary,
      usageCost: status === "INVALID" ? expect.any(Object) : null,
    });
  });

  it("재시도 두 attempt의 사용량과 지연은 중복 없이 정확히 한 번만 비용에 합산한다", async () => {
    let call = 0;
    const invoke = vi.fn(async () => {
      call += 1;
      const tokenUsage = call === 1 ? usage(100, 10) : usage(200, 20);
      return completeResult("A", "H-001", {
        responseId: `resp-A-${call}`,
        outputText: call === 1 ? "invalid" : JSON.stringify(oracleOutput()),
        usage: tokenUsage,
        executionEvidence: {
          providerCalls: [{
            ...providerCall("A", 1, tokenUsage),
            responseId: `resp-A-${call}`,
          }],
          retrievalCalls: [],
          toolCalls: [],
        },
      });
    });

    const result = await executeWith("A", 1, { invoke });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.run?.attempts.map((attempt) => attempt.status)).toEqual([
      "INVALID_OUTPUT",
      "COMPLETE",
    ]);
    expect(result.usageCost?.tokenBreakdown).toEqual({
      regularInputTokens: 300,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 30,
    });
    expect(result.completedExecutionEvidence?.providerCalls).toEqual([
      expect.objectContaining({ responseId: "resp-A-2" }),
    ]);
    expect(result.totalLatencyMs).toBe(result.run?.totalLatencyMs);
  });

  it("runner 증거 무결성 오류는 후보 실패로 점수화하지 않고 EVALUATION_INCOMPLETE다", async () => {
    const malformed = completeResult("A");
    malformed.executionEvidence!.providerCalls[0].callNumber = 2;

    const result = await executeWith("A", 1, {
      invoke: vi.fn(async () => malformed),
    });

    expect(result).toMatchObject({
      executionStatus: "FAILED",
      evaluationState: {
        status: "EVALUATION_INCOMPLETE",
        errorCode: "RUNNER_EVIDENCE_INTEGRITY_ERROR",
      },
      requestDisposition: "SENT_OUTCOME_UNKNOWN",
      costState: "COST_INCOMPLETE",
    });
  });

  it.each([
    ["responseId", { responseId: "resp-top-level-mismatch" }],
    ["modelReportedId", { modelReportedId: "gpt-5.6-terra-mismatch" }],
    ["serviceTierReported", { serviceTierReported: "priority" }],
  ] as const)(
    "상위 %s와 마지막 provider call 메타데이터 불일치는 runner 무결성 오류다",
    async (_field, override) => {
      const malformed = completeResult("A", "H-001", override);

      const result = await executeWith("A", 1, {
        invoke: vi.fn(async () => malformed),
      });

      expect(result).toMatchObject({
        executionStatus: "FAILED",
        evaluationState: {
          status: "EVALUATION_INCOMPLETE",
          errorCode: "RUNNER_EVIDENCE_INTEGRITY_ERROR",
        },
      });
    },
  );

  it("알 수 없는 adapter 예외도 후보 탈락으로 바꾸지 않고 비용 불완전으로 보존한다", async () => {
    const result = await executeWith("A", 1, {
      invoke: vi.fn(async () => {
        throw new Error("unknown infrastructure failure");
      }),
    });

    expect(result).toMatchObject({
      executionStatus: "FAILED",
      evaluationState: {
        status: "EVALUATION_INCOMPLETE",
        errorCode: "UNKNOWN_EXECUTION_ERROR",
      },
      requestDisposition: "SENT_OUTCOME_UNKNOWN",
      costState: "COST_INCOMPLETE",
    });
  });

  it("전송됐지만 공급자 사용량을 알 수 없는 attempt는 비용을 0으로 추정하지 않는다", async () => {
    const result = await executeWith("A", 1, {
      invoke: vi.fn(async () => {
        throw new CandidateInvocationError("provider outcome unknown", false, {
          usage: null,
          executionEvidence: {
            providerCalls: [{
              callNumber: 1,
              responseId: null,
              status: "failed",
              modelRequestedId: "gpt-5.6-terra",
              modelReportedId: null,
              serviceTierRequested: "default",
              serviceTierReported: null,
              latencyMs: 4,
              usage: null,
              error: "provider outcome unknown",
            }],
            retrievalCalls: [],
            toolCalls: [],
          },
        });
      }),
    });

    expect(result).toMatchObject({
      executionStatus: "FAILED",
      requestDisposition: "SENT_OUTCOME_UNKNOWN",
      costState: "COST_INCOMPLETE",
      usageCost: null,
      evaluationState: {
        status: "EVALUATION_INCOMPLETE",
        errorCode: "PROVIDER_REQUEST_ERROR",
      },
    });
  });

  it("응답 ID와 failed 상태가 기록된 결과는 요청 결과는 기록됐지만 비용만 불완전하다고 분리한다", async () => {
    const result = await executeWith("A", 1, {
      invoke: vi.fn(async () => ({
        responseId: "resp-recorded-failure",
        status: "failed" as const,
        modelReportedId: "gpt-5.6-terra-2026-07-17",
        serviceTierReported: "default",
        outputText: null,
        usage: null,
        executionEvidence: {
          providerCalls: [{
            callNumber: 1,
            responseId: "resp-recorded-failure",
            status: "failed" as const,
            modelRequestedId: "gpt-5.6-terra",
            modelReportedId: "gpt-5.6-terra-2026-07-17",
            serviceTierRequested: "default",
            serviceTierReported: "default",
            latencyMs: 4,
            usage: null,
            error: "recorded provider failure",
          }],
          retrievalCalls: [],
          toolCalls: [],
        },
      })),
    });

    expect(result).toMatchObject({
      executionStatus: "FAILED",
      requestDisposition: "SENT_RESPONSE_RECORDED",
      costState: "COST_INCOMPLETE",
      usageCost: null,
      evaluationState: {
        status: "NOT_EVALUATED",
        reason: "CANDIDATE_FAILED",
      },
    });
  });

  it("완료 응답의 provider usage가 누락되면 실행은 보존하되 비용을 0으로 추정하지 않는다", async () => {
    const raw = completeResult("A");
    raw.usage = null;
    raw.executionEvidence!.providerCalls[0].usage = null;

    const result = await executeWith("A", 1, { invoke: vi.fn(async () => raw) });

    expect(result).toMatchObject({
      executionStatus: "COMPLETE",
      requestDisposition: "SENT_RESPONSE_RECORDED",
      costState: "COST_INCOMPLETE",
      usageCost: null,
      evaluationState: { status: "EVALUATED" },
    });
  });

  it("증거 없는 첫 transport attempt는 후속 성공 응답이 있어도 outcome unknown과 비용 불완전을 보존한다", async () => {
    let callNumber = 0;
    const result = await executeWith("A", 1, {
      invoke: vi.fn(async () => {
        callNumber += 1;
        if (callNumber === 1) {
          throw new CandidateInvocationError("ambiguous transport", true, { usage: null });
        }
        return completeResult("A");
      }),
    });

    expect(result.run?.attempts.map((attempt) => attempt.status)).toEqual([
      "TRANSPORT_ERROR",
      "COMPLETE",
    ]);
    expect(result).toMatchObject({
      executionStatus: "COMPLETE",
      requestDisposition: "SENT_OUTCOME_UNKNOWN",
      costState: "COST_INCOMPLETE",
      usageCost: null,
      evaluationState: { status: "EVALUATED" },
    });
  });

  it("B의 최종 attempt 검색을 RUNNER_PREFETCH 증거로 승격한다", async () => {
    const raw = completeResult("B");
    raw.executionEvidence!.retrievalCalls = [{
      callNumber: 1,
      operation: "VECTOR_STORE_SEARCH",
      status: "COMPLETE",
      requestedQuery: "where is my order",
      reportedQuery: null,
      vectorStoreId: "vs-hidden",
      maxNumResults: 6,
      rewriteQuery: false,
      latencyMs: 3,
      results: [],
    }];

    const result = await executeWith("B", 1, { invoke: vi.fn(async () => raw) });

    expect(result.evaluationState.status).toBe("EVALUATED");
    expect(result.completedExecutionEvidence?.retrievalCalls).toEqual([
      expect.objectContaining({
        origin: "RUNNER_PREFETCH",
        linkedToolCallId: null,
        vectorStoreIdHash: sha256CanonicalJson("vs-hidden"),
        asOf: "2026-07-17T12:00:00Z",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("vs-hidden");
  });

  it("C의 search_policy와 retrieval을 양방향으로 연결하고 raw result code/hash를 보존한다", async () => {
    const raw = completeResult("C");
    const order = hiddenFixture("C").authoritativeOrder!;
    const candidateOrder = {
      order_id: order.order_id,
      status: order.status,
      fulfillment_locked: order.fulfillment_locked,
      placed_at: order.placed_at,
      shipped_at: order.shipped_at,
      delivered_at: order.delivered_at,
      promised_delivery_date: order.promised_delivery_date,
      total_amount: order.total_amount,
      currency: order.currency,
      carrier: order.carrier,
      tracking_number: order.tracking_number,
      refund_status: order.refund_status,
      refund_approved_at: order.refund_approved_at,
      items: order.items.map(({ synthetic: _synthetic, ...item }) => item),
    };
    const searchResult = {
      ok: true,
      result_code: "OK",
      data: { query: "policy", as_of: "2026-07-17T12:00:00Z", results: [] },
    };
    const orderResult = { ok: true, result_code: "OK", data: candidateOrder };
    raw.executionEvidence = {
      providerCalls: [providerCall("C", 1, usage(50, 5)), providerCall("C", 2, usage(50, 15))],
      retrievalCalls: [{
        callNumber: 1,
        operation: "VECTOR_STORE_SEARCH",
        status: "COMPLETE",
        requestedQuery: "policy",
        reportedQuery: null,
        vectorStoreId: "vs-hidden",
        maxNumResults: 6,
        rewriteQuery: false,
        latencyMs: 3,
        results: [],
      }],
      toolCalls: [{
        callNumber: 1,
        modelTurn: 1,
        callId: "call-search",
        toolName: "search_policy",
        status: "COMPLETE",
        arguments: { query: "policy", as_of: "2026-07-17T12:00:00Z" },
        argumentsJson: JSON.stringify({ query: "policy", as_of: "2026-07-17T12:00:00Z" }),
        providerStatus: "completed",
        result: searchResult,
        latencyMs: 2,
      }, {
        callNumber: 2,
        modelTurn: 1,
        callId: "call-order",
        toolName: "get_order",
        status: "COMPLETE",
        arguments: { order_id: "ORD-H001", authenticated_customer_id: "CUS-H001" },
        argumentsJson: JSON.stringify({
          order_id: "ORD-H001",
          authenticated_customer_id: "CUS-H001",
        }),
        providerStatus: "completed",
        result: orderResult,
        latencyMs: 2,
      }],
    };
    raw.responseId = "resp-C-2";
    raw.usage = usage(100, 20);

    const result = await executeWith("C", 1, { invoke: vi.fn(async () => raw) });
    const execution = result.completedExecutionEvidence!;

    expect(result.evaluationState.status).toBe("EVALUATED");
    expect(execution.retrievalCalls[0]).toMatchObject({
      origin: "TOOL_SEARCH",
      linkedToolCallId: "call-search",
      vectorStoreIdHash: sha256CanonicalJson("vs-hidden"),
    });
    expect(JSON.stringify(result)).not.toContain("vs-hidden");
    expect(execution.toolCalls[0].linkedRetrievalEvidenceIds).toEqual([
      execution.retrievalCalls[0].evidenceId,
    ]);
    expect(execution.toolCalls.map((call) => call.resultCode)).toEqual(["OK", "OK"]);
    expect(execution.toolCalls.every((call) => call.resultHash !== null)).toBe(true);
  });

  it("COMPLETE라도 B 검색 증거가 빠지면 후보 실패가 아니라 평가 불완전이다", async () => {
    const result = await executeWith("B", 1, {
      invoke: vi.fn(async () => completeResult("B")),
    });

    expect(result.executionStatus).toBe("COMPLETE");
    expect(result.evaluationState).toMatchObject({
      status: "EVALUATION_INCOMPLETE",
      errorCode: "RUNNER_RETRIEVAL_EVIDENCE_MISSING",
    });
  });

  it.each([
    {
      label: "후보와 다른 가격표 모델",
      pricing: { ...DEFAULT_PRICING_SNAPSHOT, model: "different-model" },
    },
    {
      label: "유효하지 않은 가격 단위",
      pricing: { ...DEFAULT_PRICING_SNAPSHOT, unit_tokens: 0 },
    },
  ])("$label 오류는 완료 실행을 후보 실패로 바꾸지 않고 비용 평가만 불완전하게 둔다", async ({ pricing }) => {
    const invoke = vi.fn(async () => completeResult("A"));
    const fixture = hiddenFixture("A", 1);

    const result = await executeBenchmarkSlot({
      slot: fixture.slot,
      candidateDefinition: definitionFor("A", { invoke }),
      evaluationCase: fixture.evaluationCase,
      oracle: fixture.oracle,
      policies: BENCHMARK_POLICIES,
      authoritativeOrder: fixture.authoritativeOrder,
      pricing,
    });

    expect(invoke).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      executionStatus: "COMPLETE",
      evaluationState: {
        status: "EVALUATION_INCOMPLETE",
        errorCode: "COST_CALCULATION_INTEGRITY_ERROR",
      },
      requestDisposition: "SENT_RESPONSE_RECORDED",
      costState: "COST_INCOMPLETE",
      usageCost: null,
      run: { status: "COMPLETE" },
      completedExecutionEvidence: null,
    });
  });

  it("adapter가 취소 신호와 동시에 terminal 응답을 반환하면 응답을 receipt 후보로 보존한다", async () => {
    const controller = new AbortController();
    const reason = new Error("benchmark orchestration cancelled after provider response");
    const invoke = vi.fn(async () => {
      controller.abort(reason);
      return completeResult("A");
    });
    const fixture = hiddenFixture("A", 1);

    const result = await executeBenchmarkCandidateSlot({
      slot: fixture.slot,
      candidateDefinition: definitionFor("A", { invoke }),
      evaluationCase: fixture.evaluationCase,
      oracle: fixture.oracle,
      policies: BENCHMARK_POLICIES,
      authoritativeOrder: fixture.authoritativeOrder,
      signal: controller.signal,
    });

    expect(invoke).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
    expect(result).toMatchObject({
      executionStatus: "COMPLETE",
      requestDisposition: "SENT_RESPONSE_RECORDED",
      costState: "COMPLETE",
      run: { status: "COMPLETE" },
    });
  });

  it("실행 전 abort는 원격 호출 0회로 상위에 전달하고 SENT_OUTCOME_UNKNOWN 결과로 삼키지 않는다", async () => {
    const invoke = vi.fn(async () => completeResult("A"));
    const fixture = hiddenFixture("A", 1);
    const controller = new AbortController();
    const reason = new Error("benchmark execution cancelled");
    controller.abort(reason);

    await expect(executeBenchmarkSlot({
      slot: fixture.slot,
      candidateDefinition: definitionFor("A", { invoke }),
      evaluationCase: fixture.evaluationCase,
      oracle: fixture.oracle,
      policies: BENCHMARK_POLICIES,
      authoritativeOrder: fixture.authoritativeOrder,
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(invoke).not.toHaveBeenCalled();
  });
});

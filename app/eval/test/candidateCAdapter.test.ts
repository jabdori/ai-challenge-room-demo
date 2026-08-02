// @vitest-environment node

import { APIConnectionTimeoutError } from "openai";
import { describe, expect, it, vi } from "vitest";
import { candidateOutputJsonSchema, type CandidateOutput } from "../contracts/candidateOutput";
import defaultOrderFixture from "../data/calibration/orders.json";
import {
  CANDIDATE_C_LIMITS,
  createCandidateCAdapter,
  type CandidateCClientLike,
} from "../openai/candidateCAdapter";
import type { PolicyFileManifestEntry } from "../retrieval/policyVectorStore";
import { runCandidateTwice } from "../runner/runCandidate";
import type { CandidateInvocation } from "../runner/types";

const lockedAsOf = "2026-07-17T00:00:00Z";
const policy = {
  source_id: "CANCEL-2026",
  section_id: "2.2",
  fact_id: "CANCEL-AFTER-SHIPMENT-2026",
  text: "Orders in SHIPPED status cannot be cancelled.",
};
const manifest: PolicyFileManifestEntry[] = [{
  uploadedFileId: "file-active",
  filename: "synthetic-policy-CANCEL-AFTER-SHIPMENT-2026.json",
  sourceId: policy.source_id,
  sectionId: policy.section_id,
  factId: policy.fact_id,
}];
const orders = [{
  order_id: "ORD-1042",
  customer_id: "CUS-0101",
  status: "SHIPPED",
  fulfillment_locked: true,
  shipped_at: "2026-07-16T08:10:00Z",
  delivered_at: null,
  promised_delivery_date: "2026-07-20",
}, {
  order_id: "ORD-2048",
  customer_id: "CUS-0202",
  status: "DELIVERED",
  fulfillment_locked: false,
  shipped_at: "2026-07-11T10:00:00Z",
  delivered_at: "2026-07-13T10:00:00Z",
  promised_delivery_date: "2026-07-13",
}];

const validOutput: CandidateOutput = {
  customer_reply: "This shipped order cannot be cancelled. You may request a return after delivery.",
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
  candidateId: "C",
  modelRequestedId: "gpt-5.6-terra",
  serviceTierRequested: "default",
  instructions: "Use only the read-only tools for policy and order facts.",
  input: JSON.stringify({
    case: {
      case_id: "C-001",
      dataset_split: "PUBLIC_CALIBRATION",
      case_family: "ORDER_CANCELLATION_AFTER_SHIPMENT",
      as_of: lockedAsOf,
      locale: "en-US",
      authenticated_customer_id: "CUS-0101",
      order_id: "ORD-1042",
      order_context_authorized: true,
      ticket_messages: [{
        role: "customer",
        content: "Please cancel and refund my shipped order.",
      }],
    },
  }),
  limits: { maxInputTokens: 24_000, maxOutputTokens: 800, timeoutMs: 30_000 },
};

function usage(seed: number) {
  return {
    input_tokens: 100 + seed,
    input_tokens_details: { cached_tokens: seed, cache_write_tokens: 0 },
    output_tokens: 10 + seed,
    output_tokens_details: { reasoning_tokens: seed },
    total_tokens: 110 + seed * 2,
  };
}

function toolResponse(
  turn: number,
  calls: Array<{ name: string; callId: string; argumentsJson: string }>,
) {
  return {
    id: `resp-${turn}`,
    status: "completed",
    model: "gpt-5.6-terra-2026-07-17",
    service_tier: "default",
    output_text: "",
    output: [
      {
        id: `reasoning-${turn}`,
        type: "reasoning",
        summary: [],
        encrypted_content: `encrypted-${turn}`,
        status: "completed",
      },
      ...calls.map((call, index) => ({
        id: `fc-${turn}-${index + 1}`,
        type: "function_call",
        call_id: call.callId,
        name: call.name,
        arguments: call.argumentsJson,
        status: "completed",
      })),
    ],
    usage: usage(turn),
  };
}

function finalResponse(turn: number, outputText = JSON.stringify(validOutput)) {
  return {
    id: `resp-${turn}`,
    status: "completed",
    model: "gpt-5.6-terra-2026-07-17",
    service_tier: "default",
    output_text: outputText,
    output: [{
      id: `msg-${turn}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: outputText, annotations: [] }],
    }],
    usage: usage(turn),
  };
}

function completedSearchResult() {
  return {
    object: "list",
    data: [{
      file_id: "file-active",
      filename: manifest[0].filename,
      score: 0.98,
      attributes: {
        source_id: policy.source_id,
        section_id: policy.section_id,
        fact_id: policy.fact_id,
      },
      content: [{ type: "text", text: JSON.stringify(policy) }],
    }],
  };
}

function createClient(
  responses: unknown[],
  search = vi.fn().mockResolvedValue(completedSearchResult()),
): { client: CandidateCClientLike; create: ReturnType<typeof vi.fn>; search: ReturnType<typeof vi.fn> } {
  const create = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) {
      create.mockRejectedValueOnce(response);
    } else {
      create.mockResolvedValueOnce(response);
    }
  }
  const client = {
    responses: { create },
    vectorStores: {
      search,
      create: vi.fn(),
      files: { create: vi.fn(), retrieve: vi.fn() },
      delete: vi.fn(),
    },
    files: { create: vi.fn(), delete: vi.fn() },
  } as unknown as CandidateCClientLike;
  return { client, create, search };
}

function createAdapter(
  client: CandidateCClientLike,
  options: { toolTimeoutMs?: number; now?: () => number } = {},
) {
  return createCandidateCAdapter(client, {
    vectorStoreId: "vs-policy",
    manifest,
    lockedAsOf,
    orders,
    maxNumResults: 2,
    ...options,
  });
}

describe("Candidate C 읽기 전용 도구 에이전트", () => {
  it("실제 요청된 도구만 model turn과 최종 응답 사이에 순서대로 관찰한다", async () => {
    const first = toolResponse(1, [{
      name: "search_policy",
      callId: "call-progress-search",
      argumentsJson: JSON.stringify({ query: "active cancellation policy", as_of: lockedAsOf }),
    }]);
    const second = toolResponse(2, [{
      name: "get_order",
      callId: "call-progress-order",
      argumentsJson: JSON.stringify({
        order_id: "ORD-1042",
        authenticated_customer_id: "CUS-0101",
      }),
    }]);
    const { client } = createClient([first, second, finalResponse(3)]);
    const events: Array<Record<string, unknown>> = [];

    await createAdapter(client).invoke(invocation, {
      timeoutMs: 30_000,
      onProgress: async (event) => {
        await Promise.resolve();
        events.push(event);
      },
    });

    expect(events.map((event) => event.kind)).toEqual([
      "CANDIDATE_C_MODEL_TURN_STARTED",
      "CANDIDATE_C_MODEL_TURN_FINISHED",
      "CANDIDATE_C_TOOL_STARTED",
      "CANDIDATE_C_TOOL_FINISHED",
      "CANDIDATE_C_MODEL_TURN_STARTED",
      "CANDIDATE_C_MODEL_TURN_FINISHED",
      "CANDIDATE_C_TOOL_STARTED",
      "CANDIDATE_C_TOOL_FINISHED",
      "CANDIDATE_C_MODEL_TURN_STARTED",
      "CANDIDATE_C_MODEL_TURN_FINISHED",
      "CANDIDATE_C_RESPONSE_FINISHED",
    ]);
    expect(events.filter((event) => event.kind === "CANDIDATE_C_TOOL_STARTED"))
      .toEqual([
        expect.objectContaining({ toolName: "search_policy" }),
        expect.objectContaining({ toolName: "get_order" }),
      ]);
    expect(events.some((event) => event.toolName === "unrequested_tool")).toBe(false);
  });

  it("도구 완료 진행 기록 실패에도 이미 발생한 provider·tool·retrieval 증거와 사용량을 private 오류에 보존한다", async () => {
    const first = toolResponse(1, [{
      name: "search_policy",
      callId: "call-captured-search",
      argumentsJson: JSON.stringify({ query: "active cancellation policy", as_of: lockedAsOf }),
    }]);
    const { client } = createClient([first, finalResponse(2)]);

    const error = await createAdapter(client).invoke(invocation, {
      timeoutMs: 30_000,
      onProgress: async (event) => {
        if (event.kind === "CANDIDATE_C_TOOL_FINISHED") {
          throw new Error("simulated durable progress failure");
        }
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateProgressObserverError",
      capturedEvidence: {
        usage: { inputTokens: 101, outputTokens: 11 },
        executionEvidence: {
          providerCalls: [{
            responseId: "resp-1",
            status: "completed",
            usage: { inputTokens: 101, outputTokens: 11 },
          }],
          retrievalCalls: [{
            status: "COMPLETE",
            results: [{ sourceId: "CANCEL-2026" }],
          }],
          toolCalls: [{
            callId: "call-captured-search",
            toolName: "search_policy",
            status: "COMPLETE",
          }],
        },
      },
    });
  });

  it("incomplete model turn과 최종 응답을 성공 진행 상태로 표시하지 않는다", async () => {
    const incomplete = {
      ...finalResponse(1, ""),
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    };
    const { client } = createClient([incomplete]);
    const outcomes: Array<{ kind: string; outcome: string }> = [];

    const result = await createAdapter(client).invoke(invocation, {
      timeoutMs: 30_000,
      onProgress: (event) => {
        if (
          event.kind === "CANDIDATE_C_MODEL_TURN_FINISHED"
          || event.kind === "CANDIDATE_C_RESPONSE_FINISHED"
        ) {
          outcomes.push({ kind: event.kind, outcome: event.outcome });
        }
      },
    });

    expect(result.status).toBe("incomplete");
    expect(outcomes).toEqual([
      { kind: "CANDIDATE_C_MODEL_TURN_FINISHED", outcome: "FAILED" },
      { kind: "CANDIDATE_C_RESPONSE_FINISHED", outcome: "FAILED" },
    ]);
  });

  it("runner signal을 모든 Responses 요청에 전달하고 provider 취소 reason을 그대로 보존한다", async () => {
    const reason = new Error("Candidate C 취소");
    const controller = new AbortController();
    const { client, create } = createClient([]);
    create.mockImplementation((_request, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort(reason);
      return Promise.reject(reason);
    });

    await expect(createAdapter(client).invoke(
      invocation,
      { timeoutMs: 30_000, signal: controller.signal },
    )).rejects.toBe(reason);
    expect(create).toHaveBeenCalledOnce();
  });

  it("실행 envelope를 model turn 3회와 tool call 4회로 잠근다", () => {
    expect(CANDIDATE_C_LIMITS).toEqual({ maxModelTurns: 3, maxToolCalls: 4 });
  });

  it("adapter 생성 뒤 외부 manifest를 바꿔도 첫 invoke는 생성 시 snapshot을 사용한다", async () => {
    const mutableManifest = structuredClone(manifest);
    const first = toolResponse(1, [{
      name: "search_policy",
      callId: "call-search",
      argumentsJson: JSON.stringify({ query: "policy", as_of: lockedAsOf }),
    }]);
    const { client } = createClient([first, finalResponse(2)]);
    const adapter = createCandidateCAdapter(client, {
      vectorStoreId: "vs-policy",
      manifest: mutableManifest,
      lockedAsOf,
      orders,
      maxNumResults: 2,
    });

    mutableManifest[0].sourceId = "MUTATED-SOURCE";
    mutableManifest[0].filename = "mutated.json";

    const result = await adapter.invoke(invocation);

    expect(result.executionEvidence?.retrievalCalls[0].results[0]).toMatchObject({
      sourceId: "CANCEL-2026",
      filename: manifest[0].filename,
    });
  });

  it("두 invoke 사이 외부 orders mutation이 두 번째 실행 결과에 반영되지 않는다", async () => {
    const mutableOrders = structuredClone(orders);
    const orderCall = (turn: number) => toolResponse(turn, [{
      name: "get_order",
      callId: `call-order-${turn}`,
      argumentsJson: JSON.stringify({
        order_id: "ORD-1042",
        authenticated_customer_id: "CUS-0101",
      }),
    }]);
    const { client } = createClient([
      orderCall(1), finalResponse(2),
      orderCall(1), finalResponse(2),
    ]);
    const adapter = createCandidateCAdapter(client, {
      vectorStoreId: "vs-policy",
      manifest,
      lockedAsOf,
      orders: mutableOrders,
      maxNumResults: 2,
    });

    const firstResult = await adapter.invoke(invocation);
    mutableOrders[0].status = "MUTATED";
    mutableOrders[0].customer_id = "CUS-MUTATED";
    const secondResult = await adapter.invoke(invocation);

    for (const result of [firstResult, secondResult]) {
      expect(result.executionEvidence?.toolCalls[0].result).toMatchObject({
        ok: true,
        data: { status: "SHIPPED" },
      });
    }
  });

  it("기본 orders fixture의 외부 mutable 참조도 adapter 생성 시점 이후에는 보지 않는다", async () => {
    const originalStatus = defaultOrderFixture[0].status;
    const first = toolResponse(1, [{
      name: "get_order",
      callId: "call-default-order",
      argumentsJson: JSON.stringify({
        order_id: "ORD-1042",
        authenticated_customer_id: "CUS-0101",
      }),
    }]);
    const { client } = createClient([first, finalResponse(2)]);
    const adapter = createCandidateCAdapter(client, {
      vectorStoreId: "vs-policy",
      manifest,
      lockedAsOf,
      maxNumResults: 2,
    });

    try {
      defaultOrderFixture[0].status = "MUTATED-DEFAULT";
      const result = await adapter.invoke(invocation);
      expect(result.executionEvidence?.toolCalls[0].result).toMatchObject({
        ok: true,
        data: { status: originalStatus },
      });
    } finally {
      defaultOrderFixture[0].status = originalStatus;
    }
  });

  it("strict tools, 순차 호출, 전체 reasoning replay와 같은 call_id output을 사용한다", async () => {
    const first = toolResponse(1, [{
      name: "search_policy",
      callId: "call-search",
      argumentsJson: JSON.stringify({ query: "active cancellation policy", as_of: lockedAsOf }),
    }]);
    const second = toolResponse(2, [{
      name: "get_order",
      callId: "call-order",
      argumentsJson: JSON.stringify({
        order_id: "ORD-1042",
        authenticated_customer_id: "CUS-0101",
      }),
    }]);
    const third = finalResponse(3);
    const { client, create } = createClient([first, second, third]);
    const originalInvocation = structuredClone(invocation);

    const result = await createAdapter(client).invoke(invocation, { timeoutMs: 30_000 });

    expect(create).toHaveBeenCalledTimes(3);
    const firstRequest = create.mock.calls[0][0];
    expect(firstRequest).toMatchObject({
      model: "gpt-5.6-terra",
      reasoning: { effort: "low" },
      max_output_tokens: 800,
      service_tier: "default",
      store: false,
      parallel_tool_calls: false,
      instructions: invocation.instructions,
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "candidate_customer_support_output",
          strict: true,
          schema: candidateOutputJsonSchema,
        },
      },
    });
    expect(firstRequest.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "search_policy",
      "get_order",
    ]);
    expect(firstRequest).not.toHaveProperty("previous_response_id");
    expect(firstRequest.input).toEqual([{ role: "user", content: invocation.input }]);

    const secondInput = create.mock.calls[1][0].input;
    expect(secondInput.slice(1, 3)).toEqual(first.output);
    expect(secondInput[3]).toMatchObject({
      type: "function_call_output",
      call_id: "call-search",
    });
    const thirdInput = create.mock.calls[2][0].input;
    expect(thirdInput).toEqual(expect.arrayContaining(first.output));
    expect(thirdInput).toEqual(expect.arrayContaining(second.output));
    expect(thirdInput.at(-1)).toMatchObject({
      type: "function_call_output",
      call_id: "call-order",
    });
    expect(create.mock.calls.every(([, options]) => options.maxRetries === 0)).toBe(true);

    expect(result.outputText).toBe(JSON.stringify(validOutput));
    expect(result.usage).toEqual({
      inputTokens: 306,
      cachedInputTokens: 6,
      cacheWriteTokens: 0,
      outputTokens: 36,
      reasoningTokens: 6,
      totalTokens: 342,
    });
    expect(result.executionEvidence).toMatchObject({
      providerCalls: [
        { callNumber: 1, responseId: "resp-1", usage: expect.any(Object) },
        { callNumber: 2, responseId: "resp-2", usage: expect.any(Object) },
        { callNumber: 3, responseId: "resp-3", usage: expect.any(Object) },
      ],
      retrievalCalls: [{ callNumber: 1, status: "COMPLETE" }],
      toolCalls: [
        { callNumber: 1, modelTurn: 1, callId: "call-search", status: "COMPLETE" },
        { callNumber: 2, modelTurn: 2, callId: "call-order", status: "COMPLETE" },
      ],
    });
    expect(invocation).toEqual(originalInvocation);
  });

  it("parallel_tool_calls=false 응답에 복수 function_call이 오면 도구를 실행하지 않고 계약 위반으로 거부한다", async () => {
    const first = toolResponse(1, [
      {
        name: "search_policy",
        callId: "call-search",
        argumentsJson: JSON.stringify({ query: "policy", as_of: lockedAsOf }),
      },
      {
        name: "get_order",
        callId: "call-order",
        argumentsJson: JSON.stringify({
          order_id: "ORD-1042",
          authenticated_customer_id: "CUS-0101",
        }),
      },
    ]);
    const { client, create, search } = createClient([first, finalResponse(2)]);

    const error = await createAdapter(client).invoke(invocation)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateInvocationError",
      retryable: false,
      message: expect.stringContaining("parallel_tool_calls=false"),
      usage: { inputTokens: 101, outputTokens: 11 },
      executionEvidence: {
        providerCalls: [{ callNumber: 1, responseId: "resp-1" }],
        retrievalCalls: [],
        toolCalls: [],
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    { label: "공백 call_id", callId: "   ", name: "get_order", status: "completed" },
    { label: "공백 name", callId: "call-blank-name", name: "   ", status: "completed" },
    { label: "in_progress status", callId: "call-progress", name: "get_order", status: "in_progress" },
    { label: "incomplete status", callId: "call-incomplete", name: "get_order", status: "incomplete" },
    { label: "missing status", callId: "call-missing-status", name: "get_order", status: undefined },
  ])("$label function_call은 도구 실행 전에 raw evidence와 함께 거부한다", async ({ callId, name, status }) => {
    const argumentsJson = JSON.stringify({
      order_id: "ORD-1042",
      authenticated_customer_id: "CUS-0101",
    });
    const response = toolResponse(1, []);
    response.output.push({
      id: "fc-invalid-contract",
      type: "function_call",
      call_id: callId,
      name,
      arguments: argumentsJson,
      ...(status === undefined ? {} : { status }),
    } as never);
    const { client, create, search } = createClient([response, finalResponse(2)]);

    const error = await createAdapter(client).invoke(invocation)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateInvocationError",
      retryable: false,
      usage: { inputTokens: 101, outputTokens: 11 },
      executionEvidence: {
        providerCalls: [{ callNumber: 1 }],
        toolCalls: [{
          callNumber: 1,
          callId,
          toolName: name,
          status: "FAILED",
          argumentsJson,
          providerStatus: status ?? null,
        }],
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
  });

  it("trim 후 같은 call_id를 다시 받으면 둘째 도구를 실행하지 않고 중복 evidence를 남긴다", async () => {
    const firstArguments = JSON.stringify({
      order_id: "ORD-1042",
      authenticated_customer_id: "CUS-0101",
    });
    const secondArguments = JSON.stringify({ query: "policy", as_of: lockedAsOf });
    const first = toolResponse(1, [{
      name: "get_order",
      callId: "duplicate-call",
      argumentsJson: firstArguments,
    }]);
    const second = toolResponse(2, [{
      name: "search_policy",
      callId: " duplicate-call ",
      argumentsJson: secondArguments,
    }]);
    const { client, create, search } = createClient([first, second, finalResponse(3)]);

    const error = await createAdapter(client).invoke(invocation)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateInvocationError",
      retryable: false,
      executionEvidence: {
        providerCalls: [{ callNumber: 1 }, { callNumber: 2 }],
        toolCalls: [
          { callNumber: 1, callId: "duplicate-call", status: "COMPLETE" },
          {
            callNumber: 2,
            callId: " duplicate-call ",
            toolName: "search_policy",
            status: "FAILED",
            argumentsJson: secondArguments,
            providerStatus: "completed",
          },
        ],
      },
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(search).not.toHaveBeenCalled();
    const firstOutputs = create.mock.calls[1][0].input.filter(
      (item: { type?: string }) => item.type === "function_call_output",
    );
    expect(firstOutputs).toHaveLength(1);
    expect(firstOutputs[0].call_id).toBe("duplicate-call");
  });

  it("도구 없이 최종 Structured Output을 반환하면 빈 tool trace로 허용한다", async () => {
    const { client } = createClient([finalResponse(1)]);

    const result = await createAdapter(client).invoke(invocation);

    expect(result.status).toBe("completed");
    expect(result.executionEvidence).toMatchObject({
      providerCalls: [{ callNumber: 1 }],
      retrievalCalls: [],
      toolCalls: [],
    });
  });

  it("완료 응답이 전체 deadline 뒤 도착하면 usage와 provider trace를 남기고 TIMEOUT으로 거부한다", async () => {
    const { client, create } = createClient([finalResponse(1)]);
    const timestamps = [0, 0, 0, 31];
    const error = await createAdapter(client, {
      now: () => timestamps.shift() ?? 31,
    }).invoke(invocation, { timeoutMs: 30 }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateInvocationError",
      retryable: true,
      kind: "TIMEOUT",
      usage: { inputTokens: 101, outputTokens: 11 },
      executionEvidence: { providerCalls: [{ callNumber: 1, responseId: "resp-1" }] },
    });
    expect(create).toHaveBeenCalledWith(expect.any(Object), {
      timeout: 30,
      maxRetries: 0,
    });
  });

  it("provider 오류가 전체 deadline 뒤 도착하면 원래 상태보다 TIMEOUT 경계를 우선한다", async () => {
    const lateFailure = Object.assign(new Error("late 503"), { status: 503 });
    const { client } = createClient([lateFailure]);
    const timestamps = [0, 0, 0, 31];
    const error = await createAdapter(client, {
      now: () => timestamps.shift() ?? 31,
    }).invoke(invocation, { timeoutMs: 30 }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateInvocationError",
      retryable: true,
      kind: "TIMEOUT",
      executionEvidence: {
        providerCalls: [{ callNumber: 1, status: "failed", usage: null }],
      },
    });
  });

  it("세 번째 model turn 뒤에도 tool call이면 네 번째 provider call 없이 종료한다", async () => {
    const responses = [1, 2, 3].map((turn) => toolResponse(turn, [{
      name: "get_order",
      callId: `call-${turn}`,
      argumentsJson: JSON.stringify({
        order_id: "ORD-1042",
        authenticated_customer_id: "CUS-0101",
      }),
    }]));
    const { client, create } = createClient(responses);
    const error = await createAdapter(client).invoke(invocation)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateInvocationError",
      retryable: false,
      message: expect.stringContaining("3"),
      executionEvidence: {
        providerCalls: [{ callNumber: 1 }, { callNumber: 2 }, { callNumber: 3 }],
        toolCalls: [{ callNumber: 1 }, { callNumber: 2 }, { callNumber: 3 }],
      },
    });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("알 수 없는 쓰기 도구는 raw name/arguments/call_id를 FAILED evidence에 남기고 dispatch하지 않는다", async () => {
    const rawArguments = JSON.stringify({ order_id: "ORD-1042" });
    const call = {
      name: "refund_order",
      callId: "call-write",
      argumentsJson: rawArguments,
    };
    const { client, create, search } = createClient([toolResponse(1, [call])]);
    const error = await createAdapter(client).invoke(invocation)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateInvocationError",
      retryable: false,
      message: expect.stringContaining("refund_order"),
      usage: { inputTokens: 101, outputTokens: 11 },
      executionEvidence: {
        providerCalls: [{ callNumber: 1 }],
        toolCalls: [{
          callNumber: 1,
          modelTurn: 1,
          callId: "call-write",
          toolName: "refund_order",
          status: "FAILED",
          arguments: { order_id: "ORD-1042" },
          result: null,
        }],
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
  });

  it("잘못된 JSON 인자는 raw name/arguments/call_id를 FAILED evidence에 남긴다", async () => {
    const call = { name: "get_order", callId: "call-invalid", argumentsJson: "{" };
    const { client, create } = createClient([toolResponse(1, [call])]);
    const error = await createAdapter(client).invoke(invocation)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateInvocationError",
      retryable: false,
      message: expect.stringContaining("인자"),
      usage: { inputTokens: 101, outputTokens: 11 },
      executionEvidence: {
        providerCalls: [{ callNumber: 1 }],
        toolCalls: [{
          callNumber: 1,
          modelTurn: 1,
          callId: "call-invalid",
          toolName: "get_order",
          status: "FAILED",
          arguments: { raw_arguments: "{" },
          result: { ok: false, error: { code: "INVALID_ARGUMENTS" } },
        }],
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("모델이 다른 고객의 유효한 order/customer 조합을 호출해도 현재 case scope 밖이면 차단한다", async () => {
    const first = toolResponse(1, [{
      name: "get_order",
      callId: "call-cross-customer",
      argumentsJson: JSON.stringify({
        order_id: "ORD-2048",
        authenticated_customer_id: "CUS-0202",
      }),
    }]);
    const { client, create } = createClient([first]);

    const error = await createAdapter(client).invoke(invocation)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateInvocationError",
      retryable: false,
      message: expect.stringContaining("case scope"),
      executionEvidence: {
        providerCalls: [{ callNumber: 1 }],
        toolCalls: [{
          callNumber: 1,
          callId: "call-cross-customer",
          toolName: "get_order",
          status: "FAILED",
          arguments: {
            order_id: "ORD-2048",
            authenticated_customer_id: "CUS-0202",
          },
        }],
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("형식이 불완전한 function_call도 최종 답변으로 오인하지 않고 raw 식별자를 보존해 거부한다", async () => {
    const malformed = toolResponse(1, []);
    malformed.output.push({
      id: "fc-malformed",
      type: "function_call",
      call_id: "call-malformed",
      name: "get_order",
      status: "completed",
    } as never);
    const { client } = createClient([malformed]);

    const error = await createAdapter(client).invoke(invocation)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateInvocationError",
      retryable: false,
      executionEvidence: {
        providerCalls: [{ callNumber: 1 }],
        toolCalls: [{
          callNumber: 1,
          callId: "call-malformed",
          toolName: "get_order",
          status: "FAILED",
          arguments: { raw_arguments: null },
        }],
      },
    });
  });

  it("실제 SDK provider timeout을 TIMEOUT으로 분류하고 이전 turn 사용량·증거를 보존한다", async () => {
    const first = toolResponse(1, [{
      name: "get_order",
      callId: "call-order",
      argumentsJson: JSON.stringify({
        order_id: "ORD-1042",
        authenticated_customer_id: "CUS-0101",
      }),
    }]);
    const timeout = new APIConnectionTimeoutError({ message: "provider timed out" });
    const { client, create } = createClient([first, timeout]);
    const error = await createAdapter(client).invoke(invocation)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateInvocationError",
      retryable: true,
      kind: "TIMEOUT",
      usage: { inputTokens: 101, outputTokens: 11 },
      executionEvidence: {
        providerCalls: [
          { callNumber: 1, responseId: "resp-1", usage: expect.any(Object) },
          { callNumber: 2, responseId: null, status: "failed", usage: null },
        ],
        toolCalls: [{ callNumber: 1, status: "COMPLETE" }],
      },
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("runner에서도 마지막 실패 provider call 이전의 실제 사용량을 비용 증거로 보존한다", async () => {
    const firstTurn = () => toolResponse(1, [{
      name: "get_order",
      callId: "call-order",
      argumentsJson: JSON.stringify({
        order_id: "ORD-1042",
        authenticated_customer_id: "CUS-0101",
      }),
    }]);
    const requestError = () => Object.assign(new Error("invalid follow-up request"), {
      status: 400,
    });
    const { client } = createClient([
      firstTurn(), requestError(),
      firstTurn(), requestError(),
    ]);

    const runs = await runCandidateTwice({
      adapter: createAdapter(client),
      invocation,
      now: () => 0,
    });

    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.attempts).toHaveLength(1);
      expect(run.attempts[0]).toMatchObject({
        status: "REQUEST_ERROR",
        usage: {
          inputTokens: 101,
          cachedInputTokens: 1,
          outputTokens: 11,
        },
        executionEvidence: {
          providerCalls: [
            { callNumber: 1, usage: expect.any(Object) },
            { callNumber: 2, status: "failed", usage: null },
          ],
          toolCalls: [{ callNumber: 1, status: "COMPLETE" }],
        },
        error: "invalid follow-up request",
      });
    }
  });

  it("주입된 도구 timeout은 TIMEOUT 오류와 tool/retrieval evidence를 보존한다", async () => {
    const first = toolResponse(1, [{
      name: "search_policy",
      callId: "call-search",
      argumentsJson: JSON.stringify({ query: "policy", as_of: lockedAsOf }),
    }]);
    const search = vi.fn().mockReturnValue(new Promise(() => {}));
    const { client, create } = createClient([first], search);
    const error = await createAdapter(client, { toolTimeoutMs: 5 }).invoke(
      invocation,
      { timeoutMs: 100 },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateInvocationError",
      retryable: true,
      kind: "TIMEOUT",
      executionEvidence: {
        providerCalls: [{ callNumber: 1 }],
        retrievalCalls: [{ status: "TIMEOUT" }],
        toolCalls: [{ status: "TIMEOUT" }],
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("tool의 늦은 503이 전체 deadline 뒤 확정되면 raw FAILED trace를 유지하고 전체 TIMEOUT을 우선한다", async () => {
    let currentTime = 0;
    const first = toolResponse(1, [{
      name: "search_policy",
      callId: "call-late-search",
      argumentsJson: JSON.stringify({ query: "policy", as_of: lockedAsOf }),
    }]);
    const search = vi.fn().mockImplementation(() => {
      currentTime = 31;
      throw Object.assign(new Error("late retrieval 503"), { status: 503 });
    });
    const { client, create } = createClient([first], search);

    const error = await createAdapter(client, { now: () => currentTime }).invoke(
      invocation,
      { timeoutMs: 30 },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateInvocationError",
      retryable: true,
      kind: "TIMEOUT",
      message: "late retrieval 503",
      usage: { inputTokens: 101, outputTokens: 11 },
      executionEvidence: {
        providerCalls: [{ callNumber: 1, status: "completed" }],
        retrievalCalls: [{ status: "FAILED", error: "late retrieval 503" }],
        toolCalls: [{ status: "FAILED", error: "late retrieval 503" }],
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("늦게 확정된 소유권 불일치도 raw 오류를 보존하면서 전체 TIMEOUT을 우선한다", async () => {
    let clockCalls = 0;
    const now = () => {
      clockCalls += 1;
      return clockCalls >= 7 ? 31 : 0;
    };
    const first = toolResponse(1, [{
      name: "get_order",
      callId: "call-late-ownership",
      argumentsJson: JSON.stringify({
        order_id: "ORD-1042",
        authenticated_customer_id: "CUS-0101",
      }),
    }]);
    const ownershipMismatchOrders = [{
      ...orders[0],
      customer_id: "CUS-9999",
    }];
    const { client, create } = createClient([first]);
    const adapter = createCandidateCAdapter(client, {
      vectorStoreId: "vs-policy",
      manifest,
      lockedAsOf,
      orders: ownershipMismatchOrders,
      maxNumResults: 2,
      now,
    });

    const error = await adapter.invoke(invocation, { timeoutMs: 30 })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateInvocationError",
      retryable: true,
      kind: "TIMEOUT",
      message: "인증 고객과 주문 소유자가 일치하지 않습니다.",
      usage: { inputTokens: 101, outputTokens: 11 },
      executionEvidence: {
        providerCalls: [{ callNumber: 1, status: "completed" }],
        retrievalCalls: [],
        toolCalls: [{
          callId: "call-late-ownership",
          status: "FAILED",
          error: "인증 고객과 주문 소유자가 일치하지 않습니다.",
          result: {
            ok: false,
            error: { code: "ORDER_OWNERSHIP_MISMATCH" },
          },
        }],
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("전체 deadline의 남은 시간을 provider turn과 tool timeout이 공유한다", async () => {
    const first = toolResponse(1, [{
      name: "get_order",
      callId: "call-order",
      argumentsJson: JSON.stringify({
        order_id: "ORD-1042",
        authenticated_customer_id: "CUS-0101",
      }),
    }]);
    const { client, create } = createClient([first, finalResponse(2)]);
    const timestamps = [0, 0, 8, 8, 12, 12, 20, 20];

    await createAdapter(client, { now: () => timestamps.shift() ?? 20 }).invoke(
      invocation,
      { timeoutMs: 30 },
    );

    expect(create.mock.calls[0][1]).toEqual({ timeout: 30, maxRetries: 0 });
    expect(create.mock.calls[1][1]).toEqual({ timeout: expect.any(Number), maxRetries: 0 });
    expect(create.mock.calls[1][1].timeout).toBeLessThan(30);
  });

  it("case 외 authorized order snapshot을 미리 주입하면 네트워크 전에 거부한다", async () => {
    const { client, create, search } = createClient([]);
    const polluted: CandidateInvocation = {
      ...invocation,
      input: JSON.stringify({
        ...JSON.parse(invocation.input),
        authorized_order_snapshot: { order_id: "ORD-1042", status: "SHIPPED" },
      }),
    };

    await expect(createAdapter(client).invoke(polluted)).rejects.toMatchObject({
      name: "CandidateInvocationError",
      retryable: false,
    });
    expect(create).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "중첩 폐기 정책",
      injected: { retired_policies: [{ source_id: "CANCEL-2025", text: "refund allowed" }] },
    },
    {
      label: "중첩 주문 snapshot",
      injected: { authorized_order_snapshot: { order_id: "ORD-1042", status: "SHIPPED" } },
    },
  ])("case에 $label을 주입하면 도구 접근 우회로 보고 네트워크 전에 거부한다", async ({ injected }) => {
    const { client, create, search } = createClient([]);
    const parsed = JSON.parse(invocation.input);
    const polluted: CandidateInvocation = {
      ...invocation,
      input: JSON.stringify({ case: { ...parsed.case, ...injected } }),
    };

    await expect(createAdapter(client).invoke(polluted)).rejects.toMatchObject({
      name: "CandidateInvocationError",
      retryable: false,
      message: expect.stringContaining("case"),
    });
    expect(create).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    ["dataset_split", "HIDDEN_TEST"],
    ["case_family", "UNLOCKED_CASE_FAMILY"],
    ["locale", "ko-KR"],
  ])("case.%s가 잠긴 literal과 다르면 네트워크 전에 거부한다", async (field, value) => {
    const { client, create, search } = createClient([]);
    const parsed = JSON.parse(invocation.input);
    const polluted: CandidateInvocation = {
      ...invocation,
      input: JSON.stringify({ case: { ...parsed.case, [field]: value } }),
    };

    await expect(createAdapter(client).invoke(polluted)).rejects.toMatchObject({
      name: "CandidateInvocationError",
      retryable: false,
      message: expect.stringContaining(field),
    });
    expect(create).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });
});

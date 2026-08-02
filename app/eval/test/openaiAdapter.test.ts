// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { APIConnectionTimeoutError } from "openai";
import { candidateOutputJsonSchema } from "../contracts/candidateOutput";
import { createCandidateAAdapter } from "../openai/candidateAAdapter";
import { runCandidateTwice } from "../runner/runCandidate";

describe("후보 A OpenAI Responses 어댑터", () => {
  it("response 시작 기록을 await한 뒤 외부 호출하고 완료 경계를 관찰한다", async () => {
    const order: string[] = [];
    const create = vi.fn().mockImplementation(async () => {
      order.push("provider");
      return {
        id: "resp-progress-a",
        status: "completed",
        model: "gpt-5.6-terra",
        service_tier: "default",
        output_text: "{}",
        usage: null,
      };
    });
    const adapter = createCandidateAAdapter({ responses: { create } });

    await adapter.invoke({
      candidateId: "A",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "default",
      instructions: "locked instructions",
      input: "locked input",
    }, {
      timeoutMs: 30_000,
      onProgress: async (event) => {
        await Promise.resolve();
        order.push(event.kind);
      },
    });

    expect(order).toEqual([
      "CANDIDATE_A_RESPONSE_STARTED",
      "provider",
      "CANDIDATE_A_RESPONSE_FINISHED",
    ]);
  });

  it("response 완료 진행 기록 실패에도 이미 발생한 provider 사용량과 증거를 private 오류에 보존한다", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "resp-captured-a",
      status: "completed",
      model: "gpt-5.6-terra-2026-07-17",
      service_tier: "default",
      output_text: "{}",
      usage: {
        input_tokens: 123,
        input_tokens_details: { cached_tokens: 23, cache_write_tokens: 5 },
        output_tokens: 45,
        output_tokens_details: { reasoning_tokens: 3 },
        total_tokens: 168,
      },
    });
    const adapter = createCandidateAAdapter({ responses: { create } });

    const error = await adapter.invoke({
      candidateId: "A",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "default",
      instructions: "locked instructions",
      input: "locked input",
    }, {
      timeoutMs: 30_000,
      onProgress: async (event) => {
        if (event.kind === "CANDIDATE_A_RESPONSE_FINISHED") {
          throw new Error("simulated durable progress failure");
        }
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateProgressObserverError",
      capturedEvidence: {
        usage: {
          inputTokens: 123,
          cachedInputTokens: 23,
          cacheWriteTokens: 5,
          outputTokens: 45,
        },
        executionEvidence: {
          providerCalls: [{
            responseId: "resp-captured-a",
            status: "completed",
            usage: { inputTokens: 123, outputTokens: 45 },
          }],
          retrievalCalls: [],
          toolCalls: [],
        },
      },
    });
  });

  it.each([
    {
      label: "refusal",
      response: {
        id: "resp-progress-refusal-a",
        status: "completed",
        model: "gpt-5.6-terra-2026-07-17",
        service_tier: "default",
        output_text: "",
        output: [{
          type: "message",
          content: [{ type: "refusal", refusal: "Cannot comply." }],
        }],
        usage: null,
      },
    },
    {
      label: "incomplete",
      response: {
        id: "resp-progress-incomplete-a",
        status: "incomplete",
        model: "gpt-5.6-terra-2026-07-17",
        service_tier: "default",
        output_text: "",
        incomplete_details: { reason: "max_output_tokens" },
        usage: null,
      },
    },
  ])("$label 응답의 완료 진행 상태를 성공으로 표시하지 않는다", async ({ response }) => {
    const outcomes: string[] = [];
    const adapter = createCandidateAAdapter({
      responses: { create: vi.fn().mockResolvedValue(response) },
    });

    await adapter.invoke({
      candidateId: "A",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "default",
      instructions: "locked instructions",
      input: "locked input",
    }, {
      timeoutMs: 30_000,
      onProgress: (event) => {
        if (event.kind === "CANDIDATE_A_RESPONSE_FINISHED") {
          outcomes.push(event.outcome);
        }
      },
    });

    expect(outcomes).toEqual(["FAILED"]);
  });

  it("runner signal을 Responses 요청에 전달하고 provider 취소 reason을 그대로 보존한다", async () => {
    const reason = new Error("Candidate A 취소");
    const controller = new AbortController();
    const create = vi.fn().mockImplementation((_request, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort(reason);
      return Promise.reject(reason);
    });
    const adapter = createCandidateAAdapter({ responses: { create } });

    await expect(adapter.invoke({
      candidateId: "A",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "default",
      instructions: "locked instructions",
      input: "locked input",
      limits: { maxInputTokens: 24_000, maxOutputTokens: 800, timeoutMs: 30_000 },
    }, { timeoutMs: 30_000, signal: controller.signal })).rejects.toBe(reason);
    expect(create).toHaveBeenCalledOnce();
  });

  it("runner 재시도에는 원래 30초가 아니라 남은 25초를 Responses create에 전달한다", async () => {
    let currentTime = 0;
    let createCalls = 0;
    const validOutput = {
      customer_reply: "This shipped order cannot be cancelled.",
      decision: {
        intent_codes: ["ORDER_CANCELLATION"],
        action_code: "DENY_CANCEL_AFTER_SHIPMENT",
        escalation_required: false,
        escalation_reason_code: "NOT_REQUIRED",
        target_queue: "NONE",
      },
      citations: [{ source_id: "CANCEL-2026", section_id: "2.2" }],
    };
    const create = vi.fn().mockImplementation(() => {
      createCalls += 1;
      if (createCalls % 2 === 1) {
        currentTime += 5_000;
        throw Object.assign(new Error("temporary provider failure"), { status: 503 });
      }
      currentTime += 1;
      return Promise.resolve({
        id: `resp-retry-${createCalls}`,
        status: "completed",
        model: "gpt-5.6-terra-2026-07-17",
        service_tier: "default",
        output_text: JSON.stringify(validOutput),
        usage: {
          input_tokens: 0,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 0,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 0,
        },
      });
    });
    const adapter = createCandidateAAdapter(
      { responses: { create } },
      { now: () => currentTime },
    );
    const originalInvocation = {
      candidateId: "A",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "default" as const,
      instructions: "locked instructions",
      input: "locked input",
      limits: { maxInputTokens: 24_000, maxOutputTokens: 800, timeoutMs: 30_000 },
    };

    const runs = await runCandidateTwice({
      adapter,
      invocation: originalInvocation,
      now: () => currentTime,
    });

    expect(create.mock.calls.map((call) => call[1]?.timeout))
      .toEqual([30_000, 25_000, 30_000, 25_000]);
    expect(runs.every((run) => run.status === "COMPLETE")).toBe(true);
    expect(originalInvocation.limits.timeoutMs).toBe(30_000);
  });

  it("실제 OpenAI SDK 연결 timeout을 명시적 TIMEOUT attempt와 run으로 보존한다", async () => {
    let adapterTime = 0;
    const create = vi.fn().mockImplementation(() => {
      adapterTime += 5;
      throw new APIConnectionTimeoutError({ message: "SDK Responses timeout" });
    });
    const adapter = createCandidateAAdapter(
      { responses: { create } },
      { now: () => adapterTime },
    );

    const runs = await runCandidateTwice({
      adapter,
      invocation: {
        candidateId: "A",
        modelRequestedId: "gpt-5.6-terra",
        serviceTierRequested: "default",
        instructions: "locked instructions",
        input: "locked input",
        limits: { maxInputTokens: 24_000, maxOutputTokens: 800, timeoutMs: 30_000 },
      },
    });

    expect(create).toHaveBeenCalledTimes(4);
    expect(runs.every((run) => run.status === "TIMEOUT")).toBe(true);
    expect(runs.flatMap((run) => run.attempts).map((attempt) => attempt.status))
      .toEqual(["TIMEOUT", "TIMEOUT", "TIMEOUT", "TIMEOUT"]);
    for (const attempt of runs.flatMap((run) => run.attempts)) {
      expect(attempt.executionEvidence?.providerCalls[0]).toMatchObject({
        status: "failed",
        error: "SDK Responses timeout",
        latencyMs: 5,
      });
    }
  });

  it("잠긴 모델·추론·Structured Outputs·비저장 설정을 전송한다", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "resp-test",
      status: "completed",
      model: "gpt-5.6-terra-2026-07-17",
      service_tier: "default",
      output_text: "{}",
      usage: {
        input_tokens: 123,
        input_tokens_details: { cached_tokens: 23, cache_write_tokens: 5 },
        output_tokens: 45,
        output_tokens_details: { reasoning_tokens: 3 },
        total_tokens: 168,
      },
    });
    const timestamps = [1_000, 1_037];
    const adapter = createCandidateAAdapter(
      { responses: { create } },
      { now: () => timestamps.shift()! },
    );

    const result = await adapter.invoke({
      candidateId: "A",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "default",
      instructions: "locked instructions",
      input: "locked input",
      limits: {
        maxInputTokens: 24_000,
        maxOutputTokens: 800,
        timeoutMs: 30_000,
      },
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.6-terra",
      reasoning: { effort: "low" },
      max_output_tokens: 800,
      service_tier: "default",
      store: false,
      instructions: "locked instructions",
      input: "locked input",
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "candidate_customer_support_output",
          strict: true,
          schema: candidateOutputJsonSchema,
        },
      },
    }), {
      timeout: 30_000,
      maxRetries: 0,
    });
    expect(result.usage).toEqual({
      inputTokens: 123,
      cachedInputTokens: 23,
      cacheWriteTokens: 5,
      outputTokens: 45,
      reasoningTokens: 3,
      totalTokens: 168,
    });
    expect(result.modelReportedId).toBe("gpt-5.6-terra-2026-07-17");
    expect(result.serviceTierReported).toBe("default");
    expect(result.executionEvidence).toEqual({
      providerCalls: [{
        callNumber: 1,
        responseId: "resp-test",
        status: "completed",
        modelRequestedId: "gpt-5.6-terra",
        modelReportedId: "gpt-5.6-terra-2026-07-17",
        serviceTierRequested: "default",
        serviceTierReported: "default",
        latencyMs: 37,
        usage: {
          inputTokens: 123,
          cachedInputTokens: 23,
          cacheWriteTokens: 5,
          outputTokens: 45,
          reasoningTokens: 3,
          totalTokens: 168,
        },
      }],
      retrievalCalls: [],
      toolCalls: [],
    });
  });

  it("invocation의 service tier와 최대 출력 토큰을 실제 요청에 반영한다", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "resp-priority",
      status: "completed",
      model: "gpt-5.6-terra-2026-07-17",
      service_tier: "priority",
      output_text: "{}",
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0,
      },
    });
    const adapter = createCandidateAAdapter({ responses: { create } });

    await adapter.invoke({
      candidateId: "A",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "priority",
      instructions: "locked instructions",
      input: "locked input",
      limits: { maxInputTokens: 24_000, maxOutputTokens: 321, timeoutMs: 12_345 },
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      service_tier: "priority",
      max_output_tokens: 321,
    }), {
      timeout: 12_345,
      maxRetries: 0,
    });
  });

  it("실제 refusal content가 있으면 거부 상태와 설명을 보존한다", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "resp-refusal",
      status: "completed",
      model: "gpt-5.6-terra-2026-07-17",
      service_tier: "default",
      output_text: "",
      output: [{
        id: "msg-refusal",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "refusal",
          refusal: "안전 정책상 이 요청에는 답변할 수 없습니다.",
        }],
      }],
      usage: null,
    });
    const adapter = createCandidateAAdapter({ responses: { create } });

    const result = await adapter.invoke({
      candidateId: "A",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "default",
      instructions: "locked instructions",
      input: "locked input",
    });

    expect(result.status).toBe("refused");
    expect(result.outputText).toBeNull();
    expect(result.error).toBe("안전 정책상 이 요청에는 답변할 수 없습니다.");
    expect(result.executionEvidence?.providerCalls[0].status).toBe("refused");
  });

  it("빈 output_text에 refusal item이 없으면 runner가 INVALID_OUTPUT으로 처리한다", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "resp-empty-output",
      status: "completed",
      model: "gpt-5.6-terra-2026-07-17",
      service_tier: "default",
      output_text: "",
      output: [{
        id: "msg-empty-output",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "", annotations: [] }],
      }],
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0,
      },
    });
    const adapter = createCandidateAAdapter({ responses: { create } });

    const runs = await runCandidateTwice({
      adapter,
      invocation: {
        candidateId: "A",
        modelRequestedId: "gpt-5.6-terra",
        serviceTierRequested: "default",
        instructions: "locked instructions",
        input: "locked input",
      },
    });

    expect(create).toHaveBeenCalledTimes(4);
    expect(runs.every((run) => run.status === "INVALID")).toBe(true);
    expect(runs.every((run) => run.attempts.length === 2)).toBe(true);
    expect(runs.flatMap((run) => run.attempts).map((attempt) => attempt.status))
      .toEqual(["INVALID_OUTPUT", "INVALID_OUTPUT", "INVALID_OUTPUT", "INVALID_OUTPUT"]);
  });

  it("400 요청 오류는 비재시도 호출 오류로 분류한다", async () => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("Invalid schema"), { status: 400 }));
    const adapter = createCandidateAAdapter({ responses: { create } });

    const promise = adapter.invoke({
      candidateId: "A",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "default",
      instructions: "locked instructions",
      input: "locked input",
    });

    await expect(promise).rejects.toMatchObject({
      name: "CandidateInvocationError",
      message: "Invalid schema",
      retryable: false,
    });
  });

  it("Responses 예외도 실패 provider call과 latency를 runner evidence에 보존한다", async () => {
    const create = vi.fn().mockRejectedValue(
      Object.assign(new Error("Invalid schema"), { status: 400 }),
    );
    const timestamps = [1_000, 1_025, 2_000, 2_025];
    const adapter = createCandidateAAdapter(
      { responses: { create } },
      { now: () => timestamps.shift()! },
    );

    const runs = await runCandidateTwice({
      adapter,
      invocation: {
        candidateId: "A",
        modelRequestedId: "gpt-5.6-terra",
        serviceTierRequested: "default",
        instructions: "locked instructions",
        input: "locked input",
        limits: { maxInputTokens: 24_000, maxOutputTokens: 800, timeoutMs: 30_000 },
      },
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(runs.every((run) => run.attempts.length === 1)).toBe(true);
    expect(runs.every((run) => run.attempts[0].status === "REQUEST_ERROR")).toBe(true);
    for (const attempt of runs.flatMap((run) => run.attempts)) {
      expect(attempt.executionEvidence).toMatchObject({
        providerCalls: [{
          responseId: null,
          status: "failed",
          modelRequestedId: "gpt-5.6-terra",
          modelReportedId: null,
          serviceTierRequested: "default",
          serviceTierReported: null,
          latencyMs: 25,
          usage: null,
          error: "Invalid schema",
        }],
        retrievalCalls: [],
        toolCalls: [],
      });
    }
  });
});

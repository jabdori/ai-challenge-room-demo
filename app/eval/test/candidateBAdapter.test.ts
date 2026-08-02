// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { candidateOutputJsonSchema, type CandidateOutput } from "../contracts/candidateOutput";
import {
  createCandidateBAdapter,
  type CandidateBClientLike,
} from "../openai/candidateBAdapter";
import type { PolicyFileManifestEntry } from "../retrieval/policyVectorStore";
import { runCandidateTwice } from "../runner/runCandidate";
import type { CandidateInvocation } from "../runner/types";
import { buildCandidateInvocation } from "../smoke/candidateDefinitions";

const policy = {
  source_id: "CANCEL-2026",
  section_id: "2.2",
  fact_id: "CANCEL-AFTER-SHIPMENT-2026",
  title: "Order Cancellation Policy",
  lifecycle_status: "ACTIVE",
  effective_from: "2026-01-01T00:00:00Z",
  effective_to: null,
  text: "Orders in SHIPPED status cannot be cancelled. A return may be requested after delivery.",
};

const retiredPolicyText = "A retired policy allowed a carrier stop request and immediate refund.";
const candidateFacingInput = JSON.parse(buildCandidateInvocation("B").input) as {
  case: Record<string, unknown>;
  authorized_order_snapshot: Record<string, unknown>;
};
const calibrationCase = candidateFacingInput.case;
const calibrationOrder = candidateFacingInput.authorized_order_snapshot;

interface MutableAuthorizedFixture {
  case: Record<string, unknown> & {
    ticket_messages: Array<Record<string, unknown>>;
    order_context_authorized: boolean;
  };
  authorized_order_snapshot: Record<string, unknown>;
}

const manifest: PolicyFileManifestEntry[] = [{
  uploadedFileId: "file-active",
  filename: "synthetic-policy-CANCEL-AFTER-SHIPMENT-2026.json",
  sourceId: "CANCEL-2026",
  sectionId: "2.2",
  factId: "CANCEL-AFTER-SHIPMENT-2026",
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
  ...buildCandidateInvocation("B"),
  serviceTierRequested: "priority",
  instructions: "Use only the authorized case, order snapshot, and retrieved policy evidence.",
  limits: { maxInputTokens: 24_000, maxOutputTokens: 321, timeoutMs: 30_000 },
};

function completedSearchResult() {
  return {
    object: "list",
    data: [{
      file_id: "file-active",
      filename: manifest[0].filename,
      score: 0.982,
      attributes: {
        source_id: "CANCEL-2026",
        section_id: "2.2",
        fact_id: "CANCEL-AFTER-SHIPMENT-2026",
      },
      content: [{ type: "text", text: JSON.stringify(policy) }],
    }],
  };
}

function completedResponse(outputText = JSON.stringify(validOutput)) {
  return {
    id: "resp-b",
    status: "completed",
    model: "gpt-5.6-terra-2026-07-17",
    service_tier: "priority",
    output_text: outputText,
    usage: {
      input_tokens: 222,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 2 },
      output_tokens: 55,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 277,
    },
  };
}

function createClient({
  search = vi.fn().mockResolvedValue(completedSearchResult()),
  create = vi.fn().mockResolvedValue(completedResponse()),
}: {
  search?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
} = {}): CandidateBClientLike {
  const client = {
    responses: { create },
    vectorStores: {
      search,
      create: vi.fn(),
      files: { create: vi.fn(), retrieve: vi.fn() },
      delete: vi.fn(),
    },
    files: { create: vi.fn(), delete: vi.fn() },
  };
  return client as unknown as CandidateBClientLike;
}

function createAdapter(client: CandidateBClientLike, now: () => number = Date.now) {
  return createCandidateBAdapter(client, {
    vectorStoreId: "vs-policy",
    query: "active policy for cancelling an order after shipment as of 2026-07-17",
    maxNumResults: 2,
    manifest,
    now,
  });
}

describe("Candidate B 실행기 주도 Retrieval RAG 어댑터", () => {
  it("검색 경계를 생성보다 먼저 await하고 검색 실패 시 response 시작을 꾸며내지 않는다", async () => {
    const order: string[] = [];
    const search = vi.fn().mockImplementation(async () => {
      order.push("retrieval-provider");
      throw Object.assign(new Error("retrieval unavailable"), { status: 503 });
    });
    const create = vi.fn();

    await expect(createAdapter(createClient({ search, create })).invoke(
      invocation,
      {
        timeoutMs: 30_000,
        onProgress: async (event) => {
          await Promise.resolve();
          order.push(event.kind);
        },
      },
    )).rejects.toMatchObject({
      name: "CandidateInvocationError",
      retryable: true,
    });

    expect(order).toEqual([
      "CANDIDATE_B_RETRIEVAL_STARTED",
      "retrieval-provider",
      "CANDIDATE_B_RETRIEVAL_FINISHED",
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(order).not.toContain("CANDIDATE_B_RESPONSE_STARTED");
  });

  it("response 완료 진행 기록 실패에도 검색·provider 사용량과 증거를 private 오류에 보존한다", async () => {
    const error = await createAdapter(createClient()).invoke(invocation, {
      timeoutMs: 30_000,
      onProgress: async (event) => {
        if (event.kind === "CANDIDATE_B_RESPONSE_FINISHED") {
          throw new Error("simulated durable progress failure");
        }
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CandidateProgressObserverError",
      capturedEvidence: {
        usage: { inputTokens: 222, outputTokens: 55 },
        executionEvidence: {
          providerCalls: [{
            responseId: "resp-b",
            status: "completed",
            usage: { inputTokens: 222, outputTokens: 55 },
          }],
          retrievalCalls: [{
            status: "COMPLETE",
            results: [{ sourceId: "CANCEL-2026" }],
          }],
          toolCalls: [],
        },
      },
    });
  });

  it.each([
    {
      label: "refusal",
      response: {
        ...completedResponse(""),
        id: "resp-progress-refusal-b",
        output: [{
          type: "message",
          content: [{ type: "refusal", refusal: "Cannot comply." }],
        }],
      },
    },
    {
      label: "incomplete",
      response: {
        ...completedResponse(""),
        id: "resp-progress-incomplete-b",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
    },
  ])("$label 응답의 완료 진행 상태를 성공으로 표시하지 않는다", async ({ response }) => {
    const outcomes: string[] = [];
    await createAdapter(createClient({
      create: vi.fn().mockResolvedValue(response),
    })).invoke(invocation, {
      timeoutMs: 30_000,
      onProgress: (event) => {
        if (event.kind === "CANDIDATE_B_RESPONSE_FINISHED") {
          outcomes.push(event.outcome);
        }
      },
    });

    expect(outcomes).toEqual(["FAILED"]);
  });

  it("runner signal을 Retrieval·Responses 요청에 전달하고 취소 reason을 그대로 보존한다", async () => {
    const reason = new Error("Candidate B 취소");
    const controller = new AbortController();
    const search = vi.fn().mockImplementation((_vectorStoreId, _request, options) => {
      expect(options.signal).toBe(controller.signal);
      return completedSearchResult();
    });
    const create = vi.fn().mockImplementation((_request, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort(reason);
      return Promise.reject(reason);
    });

    await expect(createAdapter(createClient({ search, create }), () => 0).invoke(
      invocation,
      { timeoutMs: 30_000, signal: controller.signal },
    )).rejects.toBe(reason);
    expect(search).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
  });

  it("runner context의 남은 timeout을 invocation의 원래 30초보다 우선한다", async () => {
    const search = vi.fn().mockResolvedValue(completedSearchResult());
    const create = vi.fn().mockResolvedValue(completedResponse());
    const timestamps = [100, 112, 112, 145];

    await createAdapter(
      createClient({ search, create }),
      () => timestamps.shift()!,
    ).invoke(invocation, { timeoutMs: 20_000 });

    expect(search).toHaveBeenCalledWith("vs-policy", expect.any(Object), {
      timeout: 20_000,
      maxRetries: 0,
    });
    expect(create).toHaveBeenCalledWith(expect.any(Object), {
      timeout: 19_988,
      maxRetries: 0,
    });
    expect(invocation.limits?.timeoutMs).toBe(30_000);
  });

  it("case와 authorized order 이외의 전체 정책 corpus가 invocation input에 섞이면 네트워크 전에 거부한다", async () => {
    const search = vi.fn();
    const create = vi.fn();
    const pollutedInvocation: CandidateInvocation = {
      ...invocation,
      input: JSON.stringify({
        ...JSON.parse(invocation.input),
        full_policy_corpus: [retiredPolicyText],
      }),
    };

    await expect(createAdapter(createClient({ search, create })).invoke(pollutedInvocation))
      .rejects.toMatchObject({
        name: "CandidateInvocationError",
        retryable: false,
        message: expect.stringContaining("case와 authorized_order_snapshot"),
      });
    expect(search).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "case 내부 policy corpus",
      mutate: (input: MutableAuthorizedFixture) => { input.case.full_policy_corpus = [retiredPolicyText]; },
    },
    {
      label: "order 내부 retired policy",
      mutate: (input: MutableAuthorizedFixture) => {
        input.authorized_order_snapshot.retired_policies = [retiredPolicyText];
      },
    },
    {
      label: "ticket message 추가 key",
      mutate: (input: MutableAuthorizedFixture) => {
        input.case.ticket_messages[0].policy_hint = retiredPolicyText;
      },
    },
    {
      label: "ticket message 잘못된 content 타입",
      mutate: (input: MutableAuthorizedFixture) => { input.case.ticket_messages[0].content = 42; },
    },
    {
      label: "case와 order의 order ID 불일치",
      mutate: (input: MutableAuthorizedFixture) => {
        input.authorized_order_snapshot.order_id = "ORD-OTHER";
      },
    },
    {
      label: "인증 고객과 order 고객 불일치",
      mutate: (input: MutableAuthorizedFixture) => {
        input.authorized_order_snapshot.customer_id = "CUS-OTHER";
      },
    },
    {
      label: "order context authorization false",
      mutate: (input: MutableAuthorizedFixture) => { input.case.order_context_authorized = false; },
    },
  ])("$label 주입은 검색 전에 비재시도 거부한다", async ({ mutate }) => {
    const search = vi.fn();
    const create = vi.fn();
    const input = structuredClone({
      case: calibrationCase,
      authorized_order_snapshot: calibrationOrder,
    }) as unknown as MutableAuthorizedFixture;
    mutate(input);

    await expect(createAdapter(createClient({ search, create })).invoke({
      ...invocation,
      input: JSON.stringify(input),
    })).rejects.toMatchObject({
      name: "CandidateInvocationError",
      retryable: false,
    });
    expect(search).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("정규 calibration fixture는 검증된 필드만 compact JSON으로 재구성해 Responses에 전달한다", async () => {
    const search = vi.fn().mockResolvedValue(completedSearchResult());
    const create = vi.fn().mockResolvedValue(completedResponse());
    const prettyInput = JSON.stringify({
      authorized_order_snapshot: calibrationOrder,
      case: calibrationCase,
    }, null, 2);

    await createAdapter(createClient({ search, create }), () => 0).invoke({
      ...invocation,
      input: prettyInput,
    });

    const requestInput = create.mock.calls[0][0].input as string;
    const sanitized = JSON.stringify({
      case: calibrationCase,
      authorized_order_snapshot: calibrationOrder,
    });
    expect(requestInput).toContain(`AUTHORIZED CASE AND ORDER SNAPSHOT:\n${sanitized}\n\n`);
    expect(requestInput).not.toContain(prettyInput);
  });

  it("검색을 한 번 먼저 실행한 뒤 검색 청크만 strict Responses 요청에 제공한다", async () => {
    const order: string[] = [];
    const search = vi.fn().mockImplementation(async () => {
      order.push("search");
      return completedSearchResult();
    });
    const create = vi.fn().mockImplementation(async () => {
      order.push("response");
      return completedResponse();
    });
    const client = createClient({ search, create });
    const timestamps = [100, 112, 112, 145];

    const result = await createAdapter(client, () => timestamps.shift()!).invoke(invocation);

    expect(order).toEqual(["search", "response"]);
    expect(search).toHaveBeenCalledWith("vs-policy", {
      query: "active policy for cancelling an order after shipment as of 2026-07-17",
      max_num_results: 2,
      rewrite_query: false,
    }, {
      timeout: 30_000,
      maxRetries: 0,
    });
    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0][0];
    expect(request).toMatchObject({
      model: "gpt-5.6-terra",
      reasoning: { effort: "low" },
      max_output_tokens: 321,
      service_tier: "priority",
      store: false,
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
    expect(request.input).toContain("CUS-0101");
    expect(request.input).toContain("ORD-1042");
    expect(request.input).toContain("CANCEL-AFTER-SHIPMENT-2026");
    expect(request.input).toContain(policy.text);
    expect(request.input).not.toContain(retiredPolicyText);
    expect(request).not.toHaveProperty("tools");
    expect(create).toHaveBeenCalledWith(expect.any(Object), {
      timeout: 29_988,
      maxRetries: 0,
    });
    expect(result.usage).toEqual({
      inputTokens: 222,
      cachedInputTokens: 20,
      cacheWriteTokens: 2,
      outputTokens: 55,
      reasoningTokens: 5,
      totalTokens: 277,
    });
    expect(result.executionEvidence).toMatchObject({
      retrievalCalls: [{
        callNumber: 1,
        status: "COMPLETE",
        requestedQuery: "active policy for cancelling an order after shipment as of 2026-07-17",
        maxNumResults: 2,
        rewriteQuery: false,
        latencyMs: 12,
        results: [{
          rank: 1,
          fileId: "file-active",
          score: 0.982,
          sourceId: "CANCEL-2026",
          sectionId: "2.2",
          factId: "CANCEL-AFTER-SHIPMENT-2026",
        }],
      }],
      providerCalls: [{
        callNumber: 1,
        responseId: "resp-b",
        status: "completed",
        modelRequestedId: "gpt-5.6-terra",
        modelReportedId: "gpt-5.6-terra-2026-07-17",
        serviceTierRequested: "priority",
        serviceTierReported: "priority",
        latencyMs: 33,
        usage: {
          inputTokens: 222,
          cachedInputTokens: 20,
          cacheWriteTokens: 2,
          outputTokens: 55,
          reasoningTokens: 5,
          totalTokens: 277,
        },
      }],
      toolCalls: [],
    });
  });

  it("검색 503은 생성 호출 없이 retryable 오류가 되고 각 runner 시도에 실패 trace가 남는다", async () => {
    const search = vi.fn().mockRejectedValue(Object.assign(new Error("retrieval unavailable"), {
      status: 503,
    }));
    const create = vi.fn();
    const runs = await runCandidateTwice({
      adapter: createAdapter(createClient({ search, create })),
      invocation,
      now: () => 0,
    });

    expect(search).toHaveBeenCalledTimes(4);
    expect(create).not.toHaveBeenCalled();
    expect(runs.flatMap((run) => run.attempts).map((attempt) => attempt.status))
      .toEqual(["TRANSPORT_ERROR", "TRANSPORT_ERROR", "TRANSPORT_ERROR", "TRANSPORT_ERROR"]);
    for (const attempt of runs.flatMap((run) => run.attempts)) {
      expect(attempt.executionEvidence).toMatchObject({
        providerCalls: [],
        retrievalCalls: [{
          status: "FAILED",
          error: "retrieval unavailable",
          results: [],
        }],
        toolCalls: [],
      });
    }
  });

  it("Retrieval 요청 timeout은 TIMEOUT evidence를 남기고 runner가 잠긴 한 번만 재시도한다", async () => {
    const timeoutError = Object.assign(new Error("retrieval timed out"), {
      name: "AbortError",
    });
    const search = vi.fn().mockRejectedValue(timeoutError);
    const create = vi.fn();
    const runs = await runCandidateTwice({
      adapter: createAdapter(createClient({ search, create })),
      invocation,
      now: () => 0,
    });

    expect(search).toHaveBeenCalledTimes(4);
    expect(search).toHaveBeenCalledWith("vs-policy", expect.any(Object), {
      timeout: 30_000,
      maxRetries: 0,
    });
    expect(create).not.toHaveBeenCalled();
    expect(runs.flatMap((run) => run.attempts).map((attempt) => attempt.status))
      .toEqual(["TIMEOUT", "TIMEOUT", "TIMEOUT", "TIMEOUT"]);
    expect(runs.every((run) => run.status === "TIMEOUT")).toBe(true);
    for (const attempt of runs.flatMap((run) => run.attempts)) {
      expect(attempt.executionEvidence?.retrievalCalls[0]).toMatchObject({
        status: "TIMEOUT",
        error: "retrieval timed out",
      });
    }
  });

  it("검색이 전체 30초 예산을 소진하면 생성하지 않고 retrieval evidence와 retryable timeout을 남긴다", async () => {
    const search = vi.fn().mockResolvedValue(completedSearchResult());
    const create = vi.fn();
    const times = [
      0, 30_000,
      30_000, 60_000,
      60_000, 90_000,
      90_000, 120_000,
    ];
    const runs = await runCandidateTwice({
      adapter: createAdapter(createClient({ search, create }), () => times.shift()!),
      invocation,
    });

    expect(search).toHaveBeenCalledTimes(4);
    expect(create).not.toHaveBeenCalled();
    expect(runs.flatMap((run) => run.attempts).map((attempt) => attempt.status))
      .toEqual(["TIMEOUT", "TIMEOUT", "TIMEOUT", "TIMEOUT"]);
    expect(runs.every((run) => run.status === "TIMEOUT")).toBe(true);
    for (const attempt of runs.flatMap((run) => run.attempts)) {
      expect(attempt.executionEvidence).toMatchObject({
        providerCalls: [],
        retrievalCalls: [{ status: "COMPLETE", latencyMs: 30_000 }],
        toolCalls: [],
      });
    }
  });

  it("manifest에 없는 검색 결과는 비재시도 REQUEST_ERROR와 실패 trace로 남긴다", async () => {
    const search = vi.fn().mockResolvedValue({
      object: "list",
      data: [{
        ...completedSearchResult().data[0],
        file_id: "file-unknown",
      }],
    });
    const create = vi.fn();
    const runs = await runCandidateTwice({
      adapter: createAdapter(createClient({ search, create })),
      invocation,
    });

    expect(search).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
    expect(runs.every((run) => run.attempts.length === 1)).toBe(true);
    expect(runs.every((run) => run.attempts[0].status === "REQUEST_ERROR")).toBe(true);
    expect(runs[0].attempts[0].executionEvidence?.retrievalCalls[0]).toMatchObject({
      status: "FAILED",
      results: [],
    });
  });

  it("검색 성공 뒤 Responses 503이 발생해도 retrieval과 실패 provider evidence를 재시도별로 보존한다", async () => {
    const search = vi.fn().mockResolvedValue(completedSearchResult());
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("generation unavailable"), {
      status: 503,
    }));
    const runs = await runCandidateTwice({
      adapter: createAdapter(createClient({ search, create })),
      invocation,
    });

    expect(search).toHaveBeenCalledTimes(4);
    expect(create).toHaveBeenCalledTimes(4);
    for (const attempt of runs.flatMap((run) => run.attempts)) {
      expect(attempt.status).toBe("TRANSPORT_ERROR");
      expect(attempt.executionEvidence?.retrievalCalls[0].status).toBe("COMPLETE");
      expect(attempt.executionEvidence?.providerCalls[0]).toMatchObject({
        status: "failed",
        responseId: null,
        usage: null,
        error: "generation unavailable",
      });
    }
  });

  it("실제 refusal content와 빈 output_text를 구분한다", async () => {
    const refusalCreate = vi.fn().mockResolvedValue({
      ...completedResponse(""),
      id: "resp-refusal",
      output: [{
        type: "message",
        content: [{ type: "refusal", refusal: "Cannot comply." }],
      }],
      usage: null,
    });
    const refusal = await createAdapter(createClient({ create: refusalCreate })).invoke(invocation);

    expect(refusal).toMatchObject({
      status: "refused",
      outputText: null,
      error: "Cannot comply.",
    });

    const emptyCreate = vi.fn().mockResolvedValue({
      ...completedResponse(""),
      id: "resp-empty",
      output: [{
        type: "message",
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
    const runs = await runCandidateTwice({
      adapter: createAdapter(createClient({ create: emptyCreate })),
      invocation,
    });
    expect(runs.flatMap((run) => run.attempts).map((attempt) => attempt.status))
      .toEqual(["INVALID_OUTPUT", "INVALID_OUTPUT", "INVALID_OUTPUT", "INVALID_OUTPUT"]);
  });
});

// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { PolicyFileManifestEntry } from "../retrieval/policyVectorStore";
import {
  SUPPORT_TOOL_DEFINITIONS,
  SupportToolExecutionError,
  createSupportToolExecutor,
  type SupportToolClientLike,
} from "../tools/supportTools";

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
  placed_at: "2026-07-14T15:20:00Z",
  shipped_at: "2026-07-16T08:10:00Z",
  delivered_at: null,
  promised_delivery_date: "2026-07-20",
  total_amount: 89,
  currency: "USD",
  synthetic: true,
}, {
  order_id: "ORD-2048",
  customer_id: "CUS-0202",
  status: "DELIVERED",
  fulfillment_locked: false,
  placed_at: "2026-07-10T10:00:00Z",
  shipped_at: "2026-07-11T10:00:00Z",
  delivered_at: "2026-07-13T10:00:00Z",
  promised_delivery_date: "2026-07-13",
  total_amount: 55,
  currency: "USD",
  synthetic: true,
}];

function completedSearchResult() {
  return {
    object: "list",
    search_query: "active cancellation policy",
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
  search = vi.fn().mockResolvedValue(completedSearchResult()),
): SupportToolClientLike {
  return {
    vectorStores: {
      search,
      create: vi.fn(),
      files: { create: vi.fn(), retrieve: vi.fn() },
      delete: vi.fn(),
    },
    files: { create: vi.fn(), delete: vi.fn() },
  } as unknown as SupportToolClientLike;
}

function createExecutor(
  client: SupportToolClientLike = createClient(),
  options: {
    toolTimeoutMs?: number;
    authorizedCaseScope?: { orderId: string; authenticatedCustomerId: string };
  } = {},
) {
  return createSupportToolExecutor(client, {
    vectorStoreId: "vs-policy",
    manifest,
    lockedAsOf,
    orders,
    maxNumResults: 2,
    authorizedCaseScope: options.authorizedCaseScope ?? {
      orderId: "ORD-1042",
      authenticatedCustomerId: "CUS-0101",
    },
    ...options,
  });
}

describe("Candidate C 읽기 전용 지원 도구", () => {
  it("strict 함수 스키마에는 search_policy와 get_order만 정의한다", () => {
    expect(SUPPORT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "search_policy",
      "get_order",
    ]);
    expect(SUPPORT_TOOL_DEFINITIONS.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["cancel_order", "refund_order", "update_order"]),
    );

    for (const tool of SUPPORT_TOOL_DEFINITIONS) {
      expect(tool).toMatchObject({ type: "function", strict: true });
      expect(tool.parameters).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      const parameters = tool.parameters as {
        properties: Record<string, unknown>;
        required: readonly string[];
      };
      expect([...parameters.required].sort()).toEqual(
        Object.keys(parameters.properties).sort(),
      );
      expect(tool.output_schema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      const outputSchema = tool.output_schema as {
        properties: Record<string, unknown>;
        required: readonly string[];
      };
      expect([...outputSchema.required].sort()).toEqual(
        Object.keys(outputSchema.properties).sort(),
      );
    }
  });

  it("search_policy는 잠긴 as_of와 direct vector search 결과를 구조화해 반환한다", async () => {
    const search = vi.fn().mockResolvedValue(completedSearchResult());
    const result = await createExecutor(createClient(search)).execute({
      callNumber: 1,
      retrievalCallNumber: 1,
      modelTurn: 1,
      callId: "call-search",
      name: "search_policy",
      argumentsJson: JSON.stringify({
        query: "active cancellation policy",
        as_of: lockedAsOf,
      }),
      timeoutMs: 4_000,
    });

    expect(search).toHaveBeenCalledWith("vs-policy", {
      query: "active cancellation policy",
      max_num_results: 2,
      rewrite_query: false,
    }, {
      timeout: 4_000,
      maxRetries: 0,
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      data: {
        query: "active cancellation policy",
        as_of: lockedAsOf,
        results: [{
          source_id: policy.source_id,
          section_id: policy.section_id,
          fact_id: policy.fact_id,
          text: expect.stringContaining(policy.text),
        }],
      },
    });
    expect(result.toolCall).toMatchObject({
      callNumber: 1,
      modelTurn: 1,
      callId: "call-search",
      toolName: "search_policy",
      status: "COMPLETE",
      arguments: { query: "active cancellation policy", as_of: lockedAsOf },
    });
    expect(result.retrievalCalls).toMatchObject([{
      callNumber: 1,
      status: "COMPLETE",
      requestedQuery: "active cancellation policy",
      reportedQuery: "active cancellation policy",
      results: [{ sourceId: policy.source_id }],
    }]);
  });

  it("get_order는 고객 소유권을 exact match하고 최소 허용 필드만 반환한다", async () => {
    const originalOrders = structuredClone(orders);
    const result = await createExecutor().execute({
      callNumber: 1,
      retrievalCallNumber: 1,
      modelTurn: 1,
      callId: "call-order",
      name: "get_order",
      argumentsJson: JSON.stringify({
        order_id: "ORD-1042",
        authenticated_customer_id: "CUS-0101",
      }),
      timeoutMs: 4_000,
    });

    expect(JSON.parse(result.output)).toEqual({
      ok: true,
      data: {
        order_id: "ORD-1042",
        status: "SHIPPED",
        fulfillment_locked: true,
        shipped_at: "2026-07-16T08:10:00Z",
        delivered_at: null,
        promised_delivery_date: "2026-07-20",
      },
    });
    expect(result.retrievalCalls).toEqual([]);
    expect(result.toolCall.result).not.toHaveProperty("customer_id");
    expect(result.toolCall.result).not.toHaveProperty("total_amount");
    expect(result.toolCall.result).not.toHaveProperty("currency");
    expect(orders).toEqual(originalOrders);
  });

  it.each([
    {
      label: "소유권 불일치",
      args: { order_id: "ORD-1042", authenticated_customer_id: "CUS-9999" },
      code: "ORDER_OWNERSHIP_MISMATCH",
      scope: { orderId: "ORD-1042", authenticatedCustomerId: "CUS-9999" },
    },
    {
      label: "알 수 없는 주문",
      args: { order_id: "ORD-9999", authenticated_customer_id: "CUS-0101" },
      code: "ORDER_NOT_FOUND",
      scope: { orderId: "ORD-9999", authenticatedCustomerId: "CUS-0101" },
    },
  ])("$label은 구조화 오류와 FAILED evidence를 남긴다", async ({ args, code, scope }) => {
    const error = await createExecutor(createClient(), { authorizedCaseScope: scope }).execute({
      callNumber: 1,
      retrievalCallNumber: 1,
      modelTurn: 1,
      callId: "call-order",
      name: "get_order",
      argumentsJson: JSON.stringify(args),
      timeoutMs: 4_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SupportToolExecutionError);
    expect(error).toMatchObject({
      code,
      output: { ok: false, error: { code } },
      toolCall: {
        toolName: "get_order",
        status: "FAILED",
        arguments: args,
        result: { ok: false, error: { code } },
      },
      retrievalCalls: [],
    });
  });

  it("다른 고객의 유효한 order/customer 조합도 현재 case scope 밖이면 반환하지 않는다", async () => {
    const error = await createExecutor().execute({
      callNumber: 1,
      retrievalCallNumber: 1,
      modelTurn: 1,
      callId: "call-cross-customer",
      name: "get_order",
      argumentsJson: JSON.stringify({
        order_id: "ORD-2048",
        authenticated_customer_id: "CUS-0202",
      }),
      timeoutMs: 4_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SupportToolExecutionError);
    expect(error).toMatchObject({
      code: "CASE_SCOPE_MISMATCH",
      retryable: false,
      toolCall: {
        toolName: "get_order",
        status: "FAILED",
        arguments: {
          order_id: "ORD-2048",
          authenticated_customer_id: "CUS-0202",
        },
      },
      retrievalCalls: [],
    });
  });

  it.each([
    {
      label: "잘못된 JSON",
      name: "get_order" as const,
      argumentsJson: "{",
      code: "INVALID_ARGUMENTS",
    },
    {
      label: "추가 인자",
      name: "get_order" as const,
      argumentsJson: JSON.stringify({
        order_id: "ORD-1042",
        authenticated_customer_id: "CUS-0101",
        include_payment: true,
      }),
      code: "INVALID_ARGUMENTS",
    },
    {
      label: "잠기지 않은 as_of",
      name: "search_policy" as const,
      argumentsJson: JSON.stringify({
        query: "active cancellation policy",
        as_of: "2025-07-17T00:00:00Z",
      }),
      code: "AS_OF_MISMATCH",
    },
  ])("$label은 네트워크 전에 구조화 오류가 된다", async ({ name, argumentsJson, code }) => {
    const search = vi.fn();
    const error = await createExecutor(createClient(search)).execute({
      callNumber: 1,
      retrievalCallNumber: 1,
      modelTurn: 1,
      callId: "call-invalid",
      name,
      argumentsJson,
      timeoutMs: 4_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SupportToolExecutionError);
    expect(error).toMatchObject({
      code,
      output: { ok: false, error: { code } },
      toolCall: { status: "FAILED" },
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("검색 실패는 Retrieval과 Tool evidence를 함께 보존한다", async () => {
    const search = vi.fn().mockRejectedValue(Object.assign(new Error("search unavailable"), {
      status: 503,
    }));
    const error = await createExecutor(createClient(search)).execute({
      callNumber: 2,
      retrievalCallNumber: 1,
      modelTurn: 2,
      callId: "call-search",
      name: "search_policy",
      argumentsJson: JSON.stringify({ query: "policy", as_of: lockedAsOf }),
      timeoutMs: 4_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SupportToolExecutionError);
    expect(error).toMatchObject({
      code: "POLICY_SEARCH_FAILED",
      toolCall: { status: "FAILED", error: "search unavailable" },
      retrievalCalls: [{ status: "FAILED", error: "search unavailable" }],
    });
  });

  it("도구 timeout은 SDK가 응답하지 않아도 TIMEOUT evidence를 생성한다", async () => {
    let searchSignal: AbortSignal | undefined;
    const search = vi.fn().mockImplementation(
      (_vectorStoreId: string, _params: unknown, options: { signal?: AbortSignal }) => {
        searchSignal = options.signal;
        return new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    );
    const error = await createExecutor(createClient(search), { toolTimeoutMs: 5 }).execute({
      callNumber: 1,
      retrievalCallNumber: 1,
      modelTurn: 1,
      callId: "call-timeout",
      name: "search_policy",
      argumentsJson: JSON.stringify({ query: "policy", as_of: lockedAsOf }),
      timeoutMs: 100,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SupportToolExecutionError);
    expect(error).toMatchObject({
      code: "TOOL_TIMEOUT",
      retryable: true,
      toolCall: { status: "TIMEOUT" },
      retrievalCalls: [{ status: "TIMEOUT", requestedQuery: "policy" }],
    });
    expect(search).toHaveBeenCalledWith("vs-policy", expect.any(Object), {
      timeout: 5,
      maxRetries: 0,
      signal: expect.any(AbortSignal),
    });
    expect(searchSignal?.aborted).toBe(true);
    expect(searchSignal?.reason).toMatchObject({ name: "ToolDeadlineError" });
  });

  it("부모 취소는 파생 검색 신호를 중단하고 원래 취소 사유를 그대로 다시 던진다", async () => {
    const controller = new AbortController();
    const abortReason = new Error("candidate run cancelled");
    let searchSignal: AbortSignal | undefined;
    let notifySearchStarted!: () => void;
    const searchStarted = new Promise<void>((resolve) => { notifySearchStarted = resolve; });
    const search = vi.fn().mockImplementation(
      (_vectorStoreId: string, _params: unknown, options: { signal?: AbortSignal }) => {
        searchSignal = options.signal;
        notifySearchStarted();
        return new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    );

    const execution = createExecutor(createClient(search)).execute({
      callNumber: 1,
      retrievalCallNumber: 1,
      modelTurn: 1,
      callId: "call-parent-abort",
      name: "search_policy",
      argumentsJson: JSON.stringify({ query: "policy", as_of: lockedAsOf }),
      timeoutMs: 4_000,
      signal: controller.signal,
    });
    await searchStarted;
    controller.abort(abortReason);

    await expect(execution).rejects.toBe(abortReason);
    expect(searchSignal).not.toBe(controller.signal);
    expect(searchSignal?.aborted).toBe(true);
    expect(searchSignal?.reason).toBe(abortReason);
  });
});

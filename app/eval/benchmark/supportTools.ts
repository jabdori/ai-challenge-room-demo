import type { FunctionTool } from "openai/resources/responses/responses";
import type {
  RetrievalCallEvidence,
  ToolCallEvidence,
} from "../contracts/executionEvidence";
import {
  BENCHMARK_CASES,
  buildBenchmarkGetOrderToolResult,
  type BenchmarkGetOrderToolResult,
} from "../data/benchmark/index";
import type { EvaluationCase } from "../contracts/evaluationCase";
import {
  PolicyRetrievalError,
  searchPolicyVectorStore,
  type PolicyFileManifestEntry,
  type PolicyVectorStoreClientLike,
} from "../retrieval/policyVectorStore";

export type BenchmarkSupportToolName = "search_policy" | "get_order";

const searchPolicyParameters = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1 },
    as_of: { type: "string", minLength: 1 },
  },
  required: ["query", "as_of"],
  additionalProperties: false,
} as const;

const getOrderParameters = {
  type: "object",
  properties: {
    order_id: { type: "string", minLength: 1 },
    authenticated_customer_id: { type: "string", minLength: 1 },
  },
  required: ["order_id", "authenticated_customer_id"],
  additionalProperties: false,
} as const;

const policyResultSchema = {
  type: "object",
  properties: {
    rank: { type: "integer" },
    score: { type: "number" },
    source_id: { type: "string" },
    section_id: { type: "string" },
    fact_id: { type: "string" },
    text: { type: "string" },
  },
  required: ["rank", "score", "source_id", "section_id", "fact_id", "text"],
  additionalProperties: false,
} as const;

const searchPolicyOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean", const: true },
    result_code: { type: "string", const: "OK" },
    data: {
      type: "object",
      properties: {
        query: { type: "string" },
        as_of: { type: "string" },
        results: { type: "array", items: policyResultSchema },
      },
      required: ["query", "as_of", "results"],
      additionalProperties: false,
    },
  },
  required: ["ok", "result_code", "data"],
  additionalProperties: false,
} as const;

const orderItemSchema = {
  type: "object",
  properties: {
    product_id: { type: "string" },
    category: { type: "string" },
    condition: { type: "string" },
    custom_made: { type: "boolean" },
    final_sale: { type: "boolean" },
    damaged: { type: "boolean" },
    opened: { type: "boolean" },
    defective: { type: "boolean" },
  },
  required: [
    "product_id",
    "category",
    "condition",
    "custom_made",
    "final_sale",
    "damaged",
    "opened",
    "defective",
  ],
  additionalProperties: false,
} as const;

const getOrderSuccessDataSchema = {
  type: "object",
  properties: {
    order_id: { type: "string" },
    status: { type: "string" },
    fulfillment_locked: { type: "boolean" },
    placed_at: { type: "string" },
    shipped_at: { type: ["string", "null"] },
    delivered_at: { type: ["string", "null"] },
    promised_delivery_date: { type: "string" },
    total_amount: { type: "number" },
    currency: { type: "string" },
    carrier: { type: ["string", "null"] },
    tracking_number: { type: ["string", "null"] },
    refund_status: { type: ["string", "null"] },
    refund_approved_at: { type: ["string", "null"] },
    items: { type: "array", items: orderItemSchema },
  },
  required: [
    "order_id",
    "status",
    "fulfillment_locked",
    "placed_at",
    "shipped_at",
    "delivered_at",
    "promised_delivery_date",
    "total_amount",
    "currency",
    "carrier",
    "tracking_number",
    "refund_status",
    "refund_approved_at",
    "items",
  ],
  additionalProperties: false,
} as const;

const getOrderOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    result_code: {
      type: "string",
      enum: [
        "OK",
        "ORDER_OWNERSHIP_MISMATCH",
        "TOOL_TIMEOUT",
        "ORDER_RESULT_MISMATCH",
      ],
    },
    data: { anyOf: [getOrderSuccessDataSchema, { type: "null" }] },
  },
  required: ["ok", "result_code", "data"],
  additionalProperties: false,
} as const;

export const BENCHMARK_SUPPORT_TOOL_DEFINITIONS = Object.freeze([
  {
    type: "function",
    name: "search_policy",
    description: "Search the locked synthetic policy corpus without changing business state.",
    strict: true,
    parameters: searchPolicyParameters,
    output_schema: searchPolicyOutputSchema,
  },
  {
    type: "function",
    name: "get_order",
    description: "Read the authorized synthetic order result for the current support case.",
    strict: true,
    parameters: getOrderParameters,
    output_schema: getOrderOutputSchema,
  },
] as const satisfies readonly FunctionTool[]);

export interface BenchmarkSupportToolInvocation {
  callNumber: number;
  retrievalCallNumber: number;
  modelTurn: 1;
  callId: string;
  name: BenchmarkSupportToolName;
  argumentsJson: string;
  providerStatus?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface BenchmarkSupportToolExecutionResult {
  output: string;
  toolCall: ToolCallEvidence;
  retrievalCalls: RetrievalCallEvidence[];
}

export interface BenchmarkSupportToolExecutor {
  execute(
    invocation: BenchmarkSupportToolInvocation,
  ): Promise<BenchmarkSupportToolExecutionResult>;
}

export interface BenchmarkSupportToolClientLike extends PolicyVectorStoreClientLike {}

export interface CreateBenchmarkSupportToolExecutorOptions {
  caseId: string;
  vectorStoreId: string;
  manifest: readonly PolicyFileManifestEntry[];
  lockedAsOf: string;
  maxNumResults: 6;
  evaluationCase?: EvaluationCase;
  getOrderResult?: {
    readonly ok: boolean;
    readonly result_code:
      | "OK"
      | "ORDER_OWNERSHIP_MISMATCH"
      | "TOOL_TIMEOUT"
      | "ORDER_RESULT_MISMATCH";
    readonly data: unknown | null;
  };
  now?: () => number;
}

export class BenchmarkSupportToolExecutionError extends Error {
  readonly retryable: boolean;
  readonly toolCall: ToolCallEvidence;
  readonly retrievalCalls: RetrievalCallEvidence[];

  constructor(
    message: string,
    retryable: boolean,
    toolCall: ToolCallEvidence,
    retrievalCalls: readonly RetrievalCallEvidence[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BenchmarkSupportToolExecutionError";
    this.retryable = retryable;
    this.toolCall = structuredClone(toolCall);
    this.retrievalCalls = retrievalCalls.map((call) => structuredClone(call));
  }
}

function readArguments(
  argumentsJson: string,
  expectedKeys: readonly string[],
): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(argumentsJson) as unknown;
  } catch (error) {
    throw new TypeError("Benchmark 도구 인자는 JSON 객체여야 합니다.", { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Benchmark 도구 인자는 JSON 객체여야 합니다.");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`Benchmark 도구 인자는 ${expected.join(", ")}만 허용합니다.`);
  }
  for (const key of expected) {
    if (typeof record[key] !== "string" || record[key].trim().length === 0) {
      throw new TypeError(`Benchmark 도구 인자 ${key}는 비어 있지 않은 문자열이어야 합니다.`);
    }
  }
  return record as Record<string, string>;
}

function makeToolCall(
  invocation: BenchmarkSupportToolInvocation,
  status: ToolCallEvidence["status"],
  args: Record<string, unknown>,
  result: unknown | null,
  latencyMs: number,
  error?: string,
): ToolCallEvidence {
  return {
    callNumber: invocation.callNumber,
    modelTurn: invocation.modelTurn,
    callId: invocation.callId,
    toolName: invocation.name,
    status,
    arguments: structuredClone(args),
    argumentsJson: invocation.argumentsJson,
    providerStatus: invocation.providerStatus ?? null,
    result: result === null ? null : structuredClone(result),
    latencyMs,
    ...(error ? { error } : {}),
  };
}

function assertInvocationEnvelope(invocation: BenchmarkSupportToolInvocation): void {
  if (
    !Number.isInteger(invocation.callNumber)
    || invocation.callNumber < 1
    || invocation.callNumber > 2
    || !Number.isInteger(invocation.retrievalCallNumber)
    || invocation.retrievalCallNumber < 1
    || invocation.modelTurn !== 1
    || invocation.callId.trim().length === 0
    || !Number.isFinite(invocation.timeoutMs)
    || invocation.timeoutMs <= 0
  ) {
    throw new TypeError("Benchmark 도구 호출 identity 또는 실행 상한이 잘못됐습니다.");
  }
}

export function createBenchmarkSupportToolExecutor(
  client: BenchmarkSupportToolClientLike,
  {
    caseId,
    vectorStoreId,
    manifest,
    lockedAsOf,
    maxNumResults,
    evaluationCase: suppliedEvaluationCase,
    getOrderResult,
    now = Date.now,
  }: CreateBenchmarkSupportToolExecutorOptions,
): BenchmarkSupportToolExecutor {
  const evaluationCase = suppliedEvaluationCase
    ?? BENCHMARK_CASES.find((item) => item.case_id === caseId);
  if (!evaluationCase || evaluationCase.as_of !== lockedAsOf) {
    throw new TypeError("Benchmark support tool case/as_of가 잠긴 데이터와 일치하지 않습니다.");
  }
  if (vectorStoreId.trim().length === 0 || manifest.length === 0 || maxNumResults !== 6) {
    throw new TypeError("Benchmark support tool에는 vector store, manifest, top-6 계약이 필요합니다.");
  }
  const lockedManifest = structuredClone(manifest);

  return {
    async execute(invocation) {
      invocation.signal?.throwIfAborted();
      assertInvocationEnvelope(invocation);
      const startedAt = now();
      const expectedKeys = invocation.name === "search_policy"
        ? ["query", "as_of"]
        : ["order_id", "authenticated_customer_id"];
      let args: Record<string, string>;
      try {
        args = readArguments(invocation.argumentsJson, expectedKeys);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Benchmark 도구 인자 오류";
        const toolCall = makeToolCall(
          invocation,
          "FAILED",
          { raw_arguments: invocation.argumentsJson },
          null,
          Math.max(now() - startedAt, 0),
          message,
        );
        throw new BenchmarkSupportToolExecutionError(message, false, toolCall, [], {
          cause: error,
        });
      }

      if (invocation.name === "get_order") {
        if (
          evaluationCase.order_id === null
          || args.order_id !== evaluationCase.order_id
          || args.authenticated_customer_id !== evaluationCase.authenticated_customer_id
        ) {
          const message = "get_order 인자가 잠긴 case scope와 일치하지 않습니다.";
          throw new BenchmarkSupportToolExecutionError(
            message,
            false,
            makeToolCall(
              invocation,
              "FAILED",
              args,
              null,
              Math.max(now() - startedAt, 0),
              message,
            ),
            [],
          );
        }
        const result: BenchmarkGetOrderToolResult
          | NonNullable<
            CreateBenchmarkSupportToolExecutorOptions["getOrderResult"]
          > = getOrderResult ?? buildBenchmarkGetOrderToolResult(caseId);
        return {
          output: JSON.stringify(result),
          toolCall: makeToolCall(
            invocation,
            result.result_code === "TOOL_TIMEOUT" ? "TIMEOUT" : "COMPLETE",
            args,
            result,
            Math.max(now() - startedAt, 0),
          ),
          retrievalCalls: [],
        };
      }

      if (args.as_of !== lockedAsOf) {
        const message = `search_policy as_of는 ${lockedAsOf}와 일치해야 합니다.`;
        throw new BenchmarkSupportToolExecutionError(
          message,
          false,
          makeToolCall(
            invocation,
            "FAILED",
            args,
            null,
            Math.max(now() - startedAt, 0),
            message,
          ),
          [],
        );
      }

      try {
        const retrieval = await searchPolicyVectorStore(client, {
          vectorStoreId,
          query: args.query,
          maxNumResults,
          manifest: lockedManifest,
          timeoutMs: invocation.timeoutMs,
          callNumber: invocation.retrievalCallNumber,
          now,
          ...(invocation.signal ? { signal: invocation.signal } : {}),
        });
        const result = {
          ok: true as const,
          result_code: "OK" as const,
          data: {
            query: args.query,
            as_of: lockedAsOf,
            results: retrieval.results.map((item) => ({
              rank: item.rank,
              score: item.score,
              source_id: item.sourceId,
              section_id: item.sectionId,
              fact_id: item.factId,
              text: item.text,
            })),
          },
        };
        return {
          output: JSON.stringify(result),
          toolCall: makeToolCall(
            invocation,
            "COMPLETE",
            args,
            result,
            Math.max(now() - startedAt, 0),
          ),
          retrievalCalls: [structuredClone(retrieval)],
        };
      } catch (error) {
        if (error instanceof PolicyRetrievalError) {
          const message = error.message;
          throw new BenchmarkSupportToolExecutionError(
            message,
            error.retryable,
            makeToolCall(
              invocation,
              error.evidence.status === "TIMEOUT" ? "TIMEOUT" : "FAILED",
              args,
              null,
              Math.max(now() - startedAt, 0),
              message,
            ),
            [error.evidence],
            { cause: error },
          );
        }
        throw error;
      }
    },
  };
}

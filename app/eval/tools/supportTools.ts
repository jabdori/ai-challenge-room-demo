import type { FunctionTool } from "openai/resources/responses/responses";
import defaultOrdersFixture from "../data/calibration/orders.json";
import type {
  RetrievalCallEvidence,
  ToolCallEvidence,
} from "../contracts/executionEvidence";
import {
  PolicyRetrievalError,
  searchPolicyVectorStore,
  type PolicyFileManifestEntry,
  type PolicyVectorStoreClientLike,
} from "../retrieval/policyVectorStore";

export type SupportToolName = "search_policy" | "get_order";

// JSON module 객체는 같은 프로세스의 다른 import에서 변경될 수 있으므로
// 모듈 초기화 시 기본 fixture를 한 번 복제해 실행 경계를 잠급니다.
const DEFAULT_ORDERS_SNAPSHOT = defaultOrdersFixture.map((order) => structuredClone(order));

const searchPolicyParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "The policy question to search for.",
    },
    as_of: {
      type: "string",
      description: "The locked evaluation timestamp in ISO 8601 format.",
    },
  },
  required: ["query", "as_of"],
  additionalProperties: false,
} as const;

const getOrderParameters = {
  type: "object",
  properties: {
    order_id: {
      type: "string",
      description: "The order identifier from the authenticated support case.",
    },
    authenticated_customer_id: {
      type: "string",
      description: "The authenticated customer identifier from the support case.",
    },
  },
  required: ["order_id", "authenticated_customer_id"],
  additionalProperties: false,
} as const;

const searchPolicyOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean", const: true },
    data: {
      type: "object",
      properties: {
        query: { type: "string" },
        as_of: { type: "string" },
        results: {
          type: "array",
          items: {
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
          },
        },
      },
      required: ["query", "as_of", "results"],
      additionalProperties: false,
    },
  },
  required: ["ok", "data"],
  additionalProperties: false,
} as const;

const getOrderOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean", const: true },
    data: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        status: { type: "string" },
        fulfillment_locked: { type: "boolean" },
        shipped_at: { type: ["string", "null"] },
        delivered_at: { type: ["string", "null"] },
        promised_delivery_date: { type: ["string", "null"] },
      },
      required: [
        "order_id",
        "status",
        "fulfillment_locked",
        "shipped_at",
        "delivered_at",
        "promised_delivery_date",
      ],
      additionalProperties: false,
    },
  },
  required: ["ok", "data"],
  additionalProperties: false,
} as const;

export const SUPPORT_TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "search_policy",
    description: "Search the locked policy corpus without changing any business state.",
    strict: true,
    parameters: searchPolicyParameters,
    output_schema: searchPolicyOutputSchema,
  },
  {
    type: "function",
    name: "get_order",
    description: "Read the minimum authorized order facts for the authenticated customer.",
    strict: true,
    parameters: getOrderParameters,
    output_schema: getOrderOutputSchema,
  },
] as const satisfies readonly FunctionTool[];

export interface SupportToolClientLike extends PolicyVectorStoreClientLike {}

export interface SupportOrderRecord {
  order_id: string;
  customer_id: string;
  status: string;
  fulfillment_locked: boolean;
  shipped_at: string | null;
  delivered_at: string | null;
  promised_delivery_date: string | null;
  [key: string]: unknown;
}

export interface SupportCaseScope {
  orderId: string;
  authenticatedCustomerId: string;
}

interface SupportToolExecutorOptions {
  vectorStoreId: string;
  manifest: readonly PolicyFileManifestEntry[];
  lockedAsOf: string;
  orders?: readonly SupportOrderRecord[];
  authorizedCaseScope: SupportCaseScope;
  maxNumResults: 2;
  toolTimeoutMs?: number;
  now?: () => number;
}

export interface SupportToolInvocation {
  callNumber: number;
  retrievalCallNumber: number;
  modelTurn: number;
  callId: string;
  name: SupportToolName;
  argumentsJson: string;
  providerStatus?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface ToolSuccessOutput {
  ok: true;
  data: Record<string, unknown>;
}

interface ToolErrorOutput {
  ok: false;
  error: {
    code: SupportToolErrorCode;
    message: string;
  };
}

export interface SupportToolExecutionResult {
  output: string;
  toolCall: ToolCallEvidence;
  retrievalCalls: RetrievalCallEvidence[];
}

export type SupportToolErrorCode =
  | "INVALID_ARGUMENTS"
  | "AS_OF_MISMATCH"
  | "ORDER_NOT_FOUND"
  | "ORDER_OWNERSHIP_MISMATCH"
  | "CASE_SCOPE_MISMATCH"
  | "POLICY_SEARCH_FAILED"
  | "TOOL_TIMEOUT";

export class SupportToolExecutionError extends Error {
  readonly code: SupportToolErrorCode;
  readonly retryable: boolean;
  readonly output: ToolErrorOutput;
  readonly toolCall: ToolCallEvidence;
  readonly retrievalCalls: RetrievalCallEvidence[];

  constructor(
    message: string,
    code: SupportToolErrorCode,
    retryable: boolean,
    toolCall: ToolCallEvidence,
    retrievalCalls: readonly RetrievalCallEvidence[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SupportToolExecutionError";
    this.code = code;
    this.retryable = retryable;
    this.output = { ok: false, error: { code, message } };
    this.toolCall = structuredClone({
      ...toolCall,
      result: this.output,
      error: message,
    });
    this.retrievalCalls = retrievalCalls.map((call) => structuredClone(call));
  }
}

interface SupportToolExecutor {
  execute(invocation: SupportToolInvocation): Promise<SupportToolExecutionResult>;
}

class ToolDeadlineError extends Error {
  constructor() {
    super("읽기 전용 도구 호출 제한시간을 초과했습니다.");
    this.name = "ToolDeadlineError";
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label}은(는) 비어 있지 않은 문자열이어야 합니다.`);
  }
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label}은(는) 0보다 큰 유한한 숫자여야 합니다.`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label}은(는) 1 이상의 정수여야 합니다.`);
  }
}

function parseArguments(
  argumentsJson: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson) as unknown;
  } catch (error) {
    throw new TypeError("도구 인자는 유효한 JSON 객체여야 합니다.", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("도구 인자는 JSON 객체여야 합니다.");
  }
  const record = parsed as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const lockedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== lockedKeys.length
    || actualKeys.some((key, index) => key !== lockedKeys[index])
  ) {
    throw new TypeError(`도구 인자는 ${lockedKeys.join(", ")}만 허용합니다.`);
  }
  for (const key of lockedKeys) {
    assertNonEmptyString(record[key], key);
  }
  return record;
}

function bestEffortArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? structuredClone(parsed as Record<string, unknown>)
      : { raw_arguments: argumentsJson };
  } catch {
    return { raw_arguments: argumentsJson };
  }
}

function makeToolEvidence(
  invocation: SupportToolInvocation,
  status: ToolCallEvidence["status"],
  args: Record<string, unknown>,
  latencyMs: number,
  result: unknown | null,
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

function makeTimeoutRetrievalEvidence(
  invocation: SupportToolInvocation,
  vectorStoreId: string,
  maxNumResults: number,
  query: string,
  latencyMs: number,
  message: string,
): RetrievalCallEvidence {
  return {
    callNumber: invocation.retrievalCallNumber,
    operation: "VECTOR_STORE_SEARCH",
    status: "TIMEOUT",
    requestedQuery: query,
    reportedQuery: null,
    vectorStoreId,
    maxNumResults,
    rewriteQuery: false,
    latencyMs,
    results: [],
    error: message,
  };
}

async function withAbortableTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  parentSignal?.throwIfAborted();
  const controller = new AbortController();
  const handleParentAbort = () => controller.abort(parentSignal?.reason);
  const handleTimeout = () => controller.abort(new ToolDeadlineError());
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  const handleChildAbort = () => rejectAborted(controller.signal.reason);
  controller.signal.addEventListener("abort", handleChildAbort, { once: true });
  parentSignal?.addEventListener("abort", handleParentAbort, { once: true });
  if (parentSignal?.aborted) {
    handleParentAbort();
  }
  const timer = setTimeout(handleTimeout, timeoutMs);
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", handleParentAbort);
    controller.signal.removeEventListener("abort", handleChildAbort);
  }
}

function fail(
  invocation: SupportToolInvocation,
  startedAtMs: number,
  now: () => number,
  args: Record<string, unknown>,
  code: SupportToolErrorCode,
  message: string,
  retryable: boolean,
  retrievalCalls: readonly RetrievalCallEvidence[] = [],
  status: ToolCallEvidence["status"] = "FAILED",
  cause?: unknown,
): never {
  throw new SupportToolExecutionError(
    message,
    code,
    retryable,
    makeToolEvidence(
      invocation,
      status,
      args,
      Math.max(now() - startedAtMs, 0),
      null,
      message,
    ),
    retrievalCalls,
    cause === undefined ? undefined : { cause },
  );
}

function validateOrders(orders: readonly SupportOrderRecord[]): SupportOrderRecord[] {
  const copied = orders.map((order) => structuredClone(order));
  const ids = new Set<string>();
  for (const [index, order] of copied.entries()) {
    assertNonEmptyString(order.order_id, `orders[${index}].order_id`);
    assertNonEmptyString(order.customer_id, `orders[${index}].customer_id`);
    assertNonEmptyString(order.status, `orders[${index}].status`);
    if (ids.has(order.order_id)) {
      throw new TypeError(`중복 order_id가 있습니다: ${order.order_id}`);
    }
    ids.add(order.order_id);
  }
  return copied;
}

export function createSupportToolExecutor(
  client: SupportToolClientLike,
  {
    vectorStoreId,
    manifest,
    lockedAsOf,
    orders = DEFAULT_ORDERS_SNAPSHOT,
    authorizedCaseScope,
    maxNumResults,
    toolTimeoutMs = 5_000,
    now = Date.now,
  }: SupportToolExecutorOptions,
): SupportToolExecutor {
  assertNonEmptyString(vectorStoreId, "vectorStoreId");
  assertNonEmptyString(lockedAsOf, "lockedAsOf");
  assertNonEmptyString(authorizedCaseScope.orderId, "authorizedCaseScope.orderId");
  assertNonEmptyString(
    authorizedCaseScope.authenticatedCustomerId,
    "authorizedCaseScope.authenticatedCustomerId",
  );
  if (maxNumResults !== 2) {
    throw new TypeError("Candidate C calibration의 maxNumResults는 2로 잠겨 있습니다.");
  }
  if (manifest.length === 0) {
    throw new TypeError("Candidate C에는 비어 있지 않은 정책 manifest가 필요합니다.");
  }
  assertPositiveFinite(toolTimeoutMs, "toolTimeoutMs");
  const lockedManifest = structuredClone(manifest);
  const lockedOrders = validateOrders(orders);
  const lockedCaseScope = structuredClone(authorizedCaseScope);

  return {
    async execute(invocation) {
      invocation.signal?.throwIfAborted();
      assertPositiveInteger(invocation.callNumber, "callNumber");
      assertPositiveInteger(invocation.retrievalCallNumber, "retrievalCallNumber");
      assertPositiveInteger(invocation.modelTurn, "modelTurn");
      assertNonEmptyString(invocation.callId, "callId");
      assertPositiveFinite(invocation.timeoutMs, "timeoutMs");
      const startedAtMs = now();
      const effectiveTimeoutMs = Math.min(toolTimeoutMs, invocation.timeoutMs);

      let args: Record<string, unknown>;
      try {
        args = parseArguments(
          invocation.argumentsJson,
          invocation.name === "search_policy"
            ? ["query", "as_of"]
            : ["order_id", "authenticated_customer_id"],
        );
      } catch (error) {
        return fail(
          invocation,
          startedAtMs,
          now,
          bestEffortArguments(invocation.argumentsJson),
          "INVALID_ARGUMENTS",
          error instanceof Error ? error.message : "도구 인자가 잘못됐습니다.",
          false,
          [],
          "FAILED",
          error,
        );
      }

      if (invocation.name === "search_policy") {
        const query = args.query as string;
        const asOf = args.as_of as string;
        if (asOf !== lockedAsOf) {
          return fail(
            invocation,
            startedAtMs,
            now,
            args,
            "AS_OF_MISMATCH",
            `as_of는 잠긴 평가 시점 ${lockedAsOf}와 정확히 일치해야 합니다.`,
            false,
          );
        }

        let retrieval: RetrievalCallEvidence;
        try {
          retrieval = await withAbortableTimeout(
            (signal) => searchPolicyVectorStore(client, {
              vectorStoreId,
              query,
              maxNumResults,
              manifest: lockedManifest,
              timeoutMs: effectiveTimeoutMs,
              callNumber: invocation.retrievalCallNumber,
              now,
              signal,
            }),
            effectiveTimeoutMs,
            invocation.signal,
          );
        } catch (error) {
          if (invocation.signal?.aborted) {
            invocation.signal.throwIfAborted();
          }
          if (error instanceof ToolDeadlineError) {
            const latencyMs = Math.max(now() - startedAtMs, 0);
            const retrievalCalls = [makeTimeoutRetrievalEvidence(
              invocation,
              vectorStoreId,
              maxNumResults,
              query,
              latencyMs,
              error.message,
            )];
            return fail(
              invocation,
              startedAtMs,
              now,
              args,
              "TOOL_TIMEOUT",
              error.message,
              true,
              retrievalCalls,
              "TIMEOUT",
              error,
            );
          }
          if (error instanceof PolicyRetrievalError) {
            const timeout = error.evidence.status === "TIMEOUT";
            return fail(
              invocation,
              startedAtMs,
              now,
              args,
              timeout ? "TOOL_TIMEOUT" : "POLICY_SEARCH_FAILED",
              error.message,
              error.retryable,
              [error.evidence],
              timeout ? "TIMEOUT" : "FAILED",
              error,
            );
          }
          return fail(
            invocation,
            startedAtMs,
            now,
            args,
            "POLICY_SEARCH_FAILED",
            error instanceof Error ? error.message : "정책 검색에 실패했습니다.",
            false,
            [],
            "FAILED",
            error,
          );
        }

        const output: ToolSuccessOutput = {
          ok: true,
          data: {
            query,
            as_of: lockedAsOf,
            results: retrieval.results.map((result) => ({
              rank: result.rank,
              score: result.score,
              source_id: result.sourceId,
              section_id: result.sectionId,
              fact_id: result.factId,
              text: result.text,
            })),
          },
        };
        return {
          output: JSON.stringify(output),
          toolCall: makeToolEvidence(
            invocation,
            "COMPLETE",
            args,
            Math.max(now() - startedAtMs, 0),
            output,
          ),
          retrievalCalls: [structuredClone(retrieval)],
        };
      }

      const orderId = args.order_id as string;
      const customerId = args.authenticated_customer_id as string;
      if (
        orderId !== lockedCaseScope.orderId
        || customerId !== lockedCaseScope.authenticatedCustomerId
      ) {
        return fail(
          invocation,
          startedAtMs,
          now,
          args,
          "CASE_SCOPE_MISMATCH",
          "도구 인자의 주문 또는 인증 고객이 현재 case scope와 일치하지 않습니다.",
          false,
        );
      }
      const order = lockedOrders.find((item) => item.order_id === orderId);
      if (!order) {
        return fail(
          invocation,
          startedAtMs,
          now,
          args,
          "ORDER_NOT_FOUND",
          `주문을 찾을 수 없습니다: ${orderId}`,
          false,
        );
      }
      if (order.customer_id !== customerId) {
        return fail(
          invocation,
          startedAtMs,
          now,
          args,
          "ORDER_OWNERSHIP_MISMATCH",
          "인증 고객과 주문 소유자가 일치하지 않습니다.",
          false,
        );
      }

      const output: ToolSuccessOutput = {
        ok: true,
        data: {
          order_id: order.order_id,
          status: order.status,
          fulfillment_locked: order.fulfillment_locked,
          shipped_at: order.shipped_at,
          delivered_at: order.delivered_at,
          promised_delivery_date: order.promised_delivery_date,
        },
      };
      return {
        output: JSON.stringify(output),
        toolCall: makeToolEvidence(
          invocation,
          "COMPLETE",
          args,
          Math.max(now() - startedAtMs, 0),
          output,
        ),
        retrievalCalls: [],
      };
    },
  };
}

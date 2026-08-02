import type {
  ResponseCreateParamsNonStreaming,
  ResponseInput,
  ResponseOutputItem,
} from "openai/resources/responses/responses";
import { OpenAIError } from "openai";
import type { CandidateExecutionEvidence, ToolCallEvidence } from "../contracts/executionEvidence";
import {
  BENCHMARK_CASES,
  BENCHMARK_ORACLES,
} from "../data/benchmark/index";
import type { EvaluationCase } from "../contracts/evaluationCase";
import {
  buildCandidateResponseRequest,
  getOpenAIRequestErrorDetails,
  mapOpenAIResponse,
  type OpenAIResponseShape,
  type OpenAIResponsesClientLike,
} from "../openai/responseMapping";
import type { TokenUsage } from "../runtime/pricing";
import {
  CandidateInvocationError,
  DEFAULT_CANDIDATE_TIMEOUT_MS,
  throwIfAborted,
  type CandidateAdapter,
  type CandidateInvocation,
} from "../runner/types";
import {
  BENCHMARK_SUPPORT_TOOL_DEFINITIONS,
  BenchmarkSupportToolExecutionError,
  type BenchmarkSupportToolExecutor,
  type BenchmarkSupportToolInvocation,
  type BenchmarkSupportToolName,
} from "./supportTools";

export interface BenchmarkCandidateCClientLike extends OpenAIResponsesClientLike {}

export const BENCHMARK_C_LIMITS = Object.freeze({
  maxProviderCalls: 2,
  maxToolCalls: 2,
});

interface CreateBenchmarkCandidateCAdapterOptions {
  caseId: string;
  toolExecutor: BenchmarkSupportToolExecutor;
  evaluationCase?: EvaluationCase;
  requiredToolCalls?: readonly BenchmarkSupportToolName[];
  forbiddenToolCalls?: readonly BenchmarkSupportToolName[];
  now?: () => number;
}

type BenchmarkCandidateCResponseShape = Omit<OpenAIResponseShape, "output"> & {
  output?: ResponseOutputItem[];
};

interface FunctionCallShape {
  type: "function_call";
  call_id: string;
  name: BenchmarkSupportToolName;
  arguments: string;
  status: "completed";
}

interface ValidatedFunctionCall extends FunctionCallShape {
  parsedArguments: Record<string, string>;
}

function emptyEvidence(): CandidateExecutionEvidence {
  return { providerCalls: [], retrievalCalls: [], toolCalls: [] };
}

function aggregateUsage(evidence: CandidateExecutionEvidence): TokenUsage | null {
  const usages = evidence.providerCalls
    .map((call) => call.usage)
    .filter((usage): usage is TokenUsage => usage !== null);
  if (usages.length === 0) {
    return null;
  }
  const allReasoning = usages.every((usage) => usage.reasoningTokens !== undefined);
  const allTotal = usages.every((usage) => usage.totalTokens !== undefined);
  return {
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    cachedInputTokens: usages.reduce((sum, usage) => sum + usage.cachedInputTokens, 0),
    cacheWriteTokens: usages.reduce((sum, usage) => sum + usage.cacheWriteTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    ...(allReasoning
      ? { reasoningTokens: usages.reduce((sum, usage) => sum + usage.reasoningTokens!, 0) }
      : {}),
    ...(allTotal
      ? { totalTokens: usages.reduce((sum, usage) => sum + usage.totalTokens!, 0) }
      : {}),
  };
}

function resolveTimeoutMs(invocation: CandidateInvocation, contextTimeoutMs?: number): number {
  const timeoutMs = contextTimeoutMs
    ?? invocation.limits?.timeoutMs
    ?? DEFAULT_CANDIDATE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CandidateInvocationError(
      "Benchmark Candidate C timeoutMs는 0보다 큰 유한한 숫자여야 합니다.",
      false,
      { usage: null },
    );
  }
  return timeoutMs;
}

function remainingTimeoutMs(
  deadlineAt: number,
  now: () => number,
  runTimeoutMs: number,
  evidence: CandidateExecutionEvidence,
): number {
  const remaining = Math.floor(deadlineAt - now());
  if (remaining <= 0) {
    throw new CandidateInvocationError(
      `Benchmark Candidate C 전체 실행 제한시간 ${runTimeoutMs}ms를 소진했습니다.`,
      true,
      {
        kind: "TIMEOUT",
        executionEvidence: evidence,
        usage: aggregateUsage(evidence),
      },
    );
  }
  return remaining;
}

function budgetExceeded(
  message: string,
  evidence: CandidateExecutionEvidence,
): CandidateInvocationError {
  return new CandidateInvocationError(message, false, {
    kind: "BUDGET_EXCEEDED",
    executionEvidence: evidence,
    usage: aggregateUsage(evidence),
  });
}

function readJsonArguments(
  value: string,
  expectedKeys: readonly string[],
): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError("function_call arguments는 JSON 객체여야 합니다.", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("function_call arguments는 JSON 객체여야 합니다.");
  }
  const record = parsed as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`function_call arguments는 ${expected.join(", ")}만 허용합니다.`);
  }
  for (const key of expected) {
    if (typeof record[key] !== "string" || record[key].trim().length === 0) {
      throw new TypeError(`function_call argument ${key}는 비어 있지 않은 문자열이어야 합니다.`);
    }
  }
  return record as Record<string, string>;
}

function rejectedToolEvidence(
  raw: ResponseOutputItem,
  callNumber: number,
  message: string,
): ToolCallEvidence {
  const record = raw as unknown as Record<string, unknown>;
  const argumentsJson = typeof record.arguments === "string" ? record.arguments : null;
  let args: Record<string, unknown> = { raw_arguments: record.arguments ?? null };
  if (argumentsJson !== null) {
    try {
      const parsed = JSON.parse(argumentsJson) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // raw arguments는 위 evidence에 그대로 남깁니다.
    }
  }
  return {
    callNumber,
    modelTurn: 1,
    callId: typeof record.call_id === "string" ? record.call_id : "<missing_call_id>",
    toolName: typeof record.name === "string" ? record.name : "<missing_tool_name>",
    status: "FAILED",
    arguments: structuredClone(args),
    argumentsJson,
    providerStatus: typeof record.status === "string" ? record.status : null,
    result: null,
    latencyMs: 0,
    error: message,
  };
}

function validateFirstTurnCalls(
  outputItems: readonly ResponseOutputItem[],
  options: {
    requiredTools: ReadonlySet<BenchmarkSupportToolName>;
    forbiddenTools: ReadonlySet<BenchmarkSupportToolName>;
    lockedAsOf: string;
    orderId: string | null;
    authenticatedCustomerId: string;
  },
  evidence: CandidateExecutionEvidence,
): ValidatedFunctionCall[] {
  const rawCalls = outputItems.filter((item) => item.type === "function_call");
  if (rawCalls.length === 0) {
    throw budgetExceeded(
      "Benchmark Candidate C 첫 provider 호출에 필수 read-only tool call이 없습니다.",
      evidence,
    );
  }
  if (rawCalls.length > BENCHMARK_C_LIMITS.maxToolCalls) {
    throw budgetExceeded(
      `Benchmark Candidate C 도구 호출 한도 ${BENCHMARK_C_LIMITS.maxToolCalls}회를 초과했습니다.`,
      evidence,
    );
  }

  const validated: ValidatedFunctionCall[] = [];
  const seenCallIds = new Set<string>();
  const seenTools = new Set<BenchmarkSupportToolName>();
  for (const [index, raw] of rawCalls.entries()) {
    const record = raw as unknown as Record<string, unknown>;
    const callId = typeof record.call_id === "string" ? record.call_id.trim() : "";
    const rawName = typeof record.name === "string" ? record.name : "";
    const argumentsJson = typeof record.arguments === "string" ? record.arguments : "";
    const status = record.status;
    const toolName = rawName === "search_policy" || rawName === "get_order"
      ? rawName
      : null;
    let parsedArguments: Record<string, string>;
    try {
      if (callId.length === 0 || status !== "completed" || toolName === null) {
        throw new TypeError(
          "function_call에는 completed status, 공백이 아닌 call_id와 허용된 read-only name이 필요합니다.",
        );
      }
      if (seenCallIds.has(callId) || seenTools.has(toolName)) {
        throw new TypeError("중복 call_id 또는 같은 read-only tool의 중복 호출을 허용하지 않습니다.");
      }
      if (options.forbiddenTools.has(toolName)) {
        throw new TypeError(`현재 case에서 ${toolName} 도구 호출은 금지되어 있습니다.`);
      }
      parsedArguments = readJsonArguments(
        argumentsJson,
        toolName === "search_policy"
          ? ["query", "as_of"]
          : ["order_id", "authenticated_customer_id"],
      );
      if (toolName === "search_policy" && parsedArguments.as_of !== options.lockedAsOf) {
        throw new TypeError("search_policy as_of가 잠긴 case 시점과 일치하지 않습니다.");
      }
      if (
        toolName === "get_order"
        && (
          options.orderId === null
          || parsedArguments.order_id !== options.orderId
          || parsedArguments.authenticated_customer_id !== options.authenticatedCustomerId
        )
      ) {
        throw new TypeError("get_order 인자가 잠긴 case scope와 일치하지 않습니다.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "function_call 계약 오류";
      evidence.toolCalls.push(rejectedToolEvidence(raw, index + 1, message));
      throw new CandidateInvocationError(message, false, {
        executionEvidence: evidence,
        usage: aggregateUsage(evidence),
      });
    }
    seenCallIds.add(callId);
    seenTools.add(toolName);
    validated.push({
      type: "function_call",
      call_id: callId,
      name: toolName,
      arguments: argumentsJson,
      status: "completed",
      parsedArguments,
    });
  }

  const missingTools = [...options.requiredTools].filter((name) => !seenTools.has(name));
  if (missingTools.length > 0) {
    throw budgetExceeded(
      `Benchmark Candidate C 첫 호출에 필수 도구가 없습니다: ${missingTools.join(", ")}`,
      evidence,
    );
  }
  return validated;
}

function buildRequest(
  invocation: CandidateInvocation,
  input: ResponseInput,
  turn: 1 | 2,
  allowedTools: ReadonlySet<BenchmarkSupportToolName>,
): ResponseCreateParamsNonStreaming {
  const tools = BENCHMARK_SUPPORT_TOOL_DEFINITIONS
    .filter((tool) => allowedTools.has(tool.name))
    .map((tool) => structuredClone(tool));
  return {
    ...buildCandidateResponseRequest(invocation),
    input,
    tools,
    parallel_tool_calls: true,
    tool_choice: turn === 1 ? "required" : "none",
  };
}

export function createBenchmarkCandidateCAdapter(
  client: BenchmarkCandidateCClientLike,
  {
    caseId,
    toolExecutor,
    evaluationCase: suppliedEvaluationCase,
    requiredToolCalls,
    forbiddenToolCalls,
    now = Date.now,
  }: CreateBenchmarkCandidateCAdapterOptions,
): CandidateAdapter {
  const evaluationCase = suppliedEvaluationCase
    ?? BENCHMARK_CASES.find((item) => item.case_id === caseId);
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === caseId);
  const benchmarkAccess = oracle?.candidate_access_expectations.find(
    (item) => item.candidate_id === "C",
  );
  const requiredToolNames = requiredToolCalls
    ?? benchmarkAccess?.required_tool_calls.map((item) => item.tool_name);
  const forbiddenToolNames = forbiddenToolCalls
    ?? benchmarkAccess?.forbidden_tool_calls;
  if (
    !evaluationCase
    || evaluationCase.case_id !== caseId
    || requiredToolNames === undefined
    || forbiddenToolNames === undefined
  ) {
    throw new TypeError(`Benchmark Candidate C case/access 계약을 찾을 수 없습니다: ${caseId}`);
  }
  const requiredTools = new Set(requiredToolNames);
  const forbiddenTools = new Set(forbiddenToolNames);
  const allowedTools = new Set<BenchmarkSupportToolName>(
    (["search_policy", "get_order"] as const).filter((name) => !forbiddenTools.has(name)),
  );

  return {
    async invoke(invocation, context) {
      throwIfAborted(context?.signal);
      if (invocation.candidateId !== "C") {
        throw new CandidateInvocationError("Benchmark Candidate C adapter에는 candidateId C가 필요합니다.", false);
      }
      let parsedInput: unknown;
      try {
        parsedInput = JSON.parse(invocation.input) as unknown;
      } catch (error) {
        throw new CandidateInvocationError("Benchmark Candidate C input은 JSON이어야 합니다.", false, {
          cause: error,
          usage: null,
        });
      }
      if (
        typeof parsedInput !== "object"
        || parsedInput === null
        || Array.isArray(parsedInput)
        || Object.keys(parsedInput).length !== 1
        || !("case" in parsedInput)
        || JSON.stringify((parsedInput as { case: unknown }).case)
          !== JSON.stringify({
            case_id: evaluationCase.case_id,
            dataset_split: evaluationCase.dataset_split,
            as_of: evaluationCase.as_of,
            locale: evaluationCase.locale,
            authenticated_customer_id: evaluationCase.authenticated_customer_id,
            order_id: evaluationCase.order_id,
            order_context_authorized: evaluationCase.order_context_authorized,
            ticket_messages: evaluationCase.ticket_messages.map(({ role, content }) => ({ role, content })),
          })
      ) {
        throw new CandidateInvocationError(
          "Benchmark Candidate C input은 잠긴 candidate-facing case만 포함해야 합니다.",
          false,
          { usage: null },
        );
      }

      const runTimeoutMs = resolveTimeoutMs(invocation, context?.timeoutMs);
      const deadlineAt = now() + runTimeoutMs;
      const evidence = emptyEvidence();
      const history: ResponseInput = [{ role: "user", content: invocation.input }];

      const callProvider = async (turn: 1 | 2): Promise<BenchmarkCandidateCResponseShape> => {
        const timeoutMs = remainingTimeoutMs(deadlineAt, now, runTimeoutMs, evidence);
        const startedAt = now();
        try {
          const response = await client.responses.create(
            buildRequest(invocation, structuredClone(history), turn, allowedTools),
            {
              timeout: timeoutMs,
              maxRetries: 0,
              ...(context?.signal ? { signal: context.signal } : {}),
            },
          ) as BenchmarkCandidateCResponseShape;
          throwIfAborted(context?.signal);
          const mapped = mapOpenAIResponse(
            response as OpenAIResponseShape,
            invocation,
            Math.max(now() - startedAt, 0),
            turn,
          );
          evidence.providerCalls.push(mapped.providerCall);
          return response;
        } catch (error) {
          throwIfAborted(context?.signal);
          if (error instanceof CandidateInvocationError) {
            throw error;
          }
          if (!(error instanceof OpenAIError)) {
            throw error;
          }
          const details = getOpenAIRequestErrorDetails(error);
          evidence.providerCalls.push({
            callNumber: turn,
            responseId: null,
            status: "failed",
            modelRequestedId: invocation.modelRequestedId,
            modelReportedId: null,
            serviceTierRequested: invocation.serviceTierRequested,
            serviceTierReported: null,
            latencyMs: Math.max(now() - startedAt, 0),
            usage: null,
            error: details.message,
          });
          throw new CandidateInvocationError(details.message, details.retryable, {
            cause: error,
            kind: details.kind,
            executionEvidence: evidence,
            usage: aggregateUsage(evidence),
          });
        }
      };

      const first = await callProvider(1);
      const firstMapped = mapOpenAIResponse(first as OpenAIResponseShape, invocation, 0, 1);
      if (firstMapped.status !== "completed") {
        return {
          responseId: firstMapped.responseId,
          status: firstMapped.status,
          modelReportedId: firstMapped.modelReportedId,
          serviceTierReported: firstMapped.serviceTierReported,
          outputText: firstMapped.outputText,
          usage: aggregateUsage(evidence),
          executionEvidence: evidence,
          ...(firstMapped.error ? { error: firstMapped.error } : {}),
        };
      }
      const firstOutput = first.output ?? [];
      const calls = validateFirstTurnCalls(firstOutput, {
        requiredTools,
        forbiddenTools,
        lockedAsOf: evaluationCase.as_of,
        orderId: evaluationCase.order_id,
        authenticatedCustomerId: evaluationCase.authenticated_customer_id,
      }, evidence);

      // 모든 function_call의 형식·identity·scope·필수 집합을 먼저 검증한 뒤 실행합니다.
      history.push(...structuredClone(firstOutput) as unknown as ResponseInput);
      let retrievalCallNumber = 0;
      for (const [index, call] of calls.entries()) {
        if (call.name === "search_policy") {
          retrievalCallNumber += 1;
        }
        const toolInvocation: BenchmarkSupportToolInvocation = {
          callNumber: index + 1,
          retrievalCallNumber: Math.max(retrievalCallNumber, 1),
          modelTurn: 1,
          callId: call.call_id,
          name: call.name,
          argumentsJson: call.arguments,
          providerStatus: call.status,
          timeoutMs: remainingTimeoutMs(deadlineAt, now, runTimeoutMs, evidence),
          ...(context?.signal ? { signal: context.signal } : {}),
        };
        try {
          const result = await toolExecutor.execute(toolInvocation);
          evidence.toolCalls.push(structuredClone(result.toolCall));
          evidence.retrievalCalls.push(...structuredClone(result.retrievalCalls));
          history.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: result.output,
          });
        } catch (error) {
          if (error instanceof BenchmarkSupportToolExecutionError) {
            evidence.toolCalls.push(error.toolCall);
            evidence.retrievalCalls.push(...error.retrievalCalls);
            throw new CandidateInvocationError(error.message, error.retryable, {
              cause: error,
              kind: error.toolCall.status === "TIMEOUT" ? "TIMEOUT" : "OTHER",
              executionEvidence: evidence,
              usage: aggregateUsage(evidence),
            });
          }
          throw error;
        }
      }

      const second = await callProvider(2);
      const secondMapped = mapOpenAIResponse(second as OpenAIResponseShape, invocation, 0, 2);
      const secondToolCalls = (second.output ?? []).filter((item) => item.type === "function_call");
      if (secondToolCalls.length > 0) {
        throw budgetExceeded(
          "Benchmark Candidate C 두 번째 provider 응답이 추가 도구 호출을 요구해 2회 호출 상한을 초과했습니다.",
          evidence,
        );
      }
      return {
        responseId: secondMapped.responseId,
        status: secondMapped.status,
        modelReportedId: secondMapped.modelReportedId,
        serviceTierReported: secondMapped.serviceTierReported,
        outputText: secondMapped.outputText,
        usage: aggregateUsage(evidence),
        executionEvidence: evidence,
        ...(secondMapped.error ? { error: secondMapped.error } : {}),
      };
    },
  };
}

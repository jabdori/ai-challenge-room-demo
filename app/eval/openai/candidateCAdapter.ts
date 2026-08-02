import type OpenAI from "openai";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInput,
  ResponseOutputItem,
} from "openai/resources/responses/responses";
import type {
  CandidateExecutionEvidence,
  ToolCallEvidence,
} from "../contracts/executionEvidence";
import type { TokenUsage } from "../runtime/pricing";
import type { PolicyFileManifestEntry } from "../retrieval/policyVectorStore";
import {
  SUPPORT_TOOL_DEFINITIONS,
  SupportToolExecutionError,
  createSupportToolExecutor,
  type SupportCaseScope,
  type SupportOrderRecord,
  type SupportToolClientLike,
  type SupportToolName,
} from "../tools/supportTools";
import {
  CandidateInvocationError,
  DEFAULT_CANDIDATE_TIMEOUT_MS,
  throwIfAborted,
  type CandidateAdapter,
  type CandidateInvocation,
} from "../runner/types";
import { emitCandidateProgress } from "../runner/progress";
import {
  buildCandidateResponseRequest,
  getOpenAIRequestErrorDetails,
  mapOpenAIResponse,
  type OpenAIResponseShape,
  type OpenAIResponsesClientLike,
} from "./responseMapping";

export interface CandidateCClientLike
  extends OpenAIResponsesClientLike, SupportToolClientLike {}

type AssertAssignable<T extends true> = T;
type _InstalledOpenAIClientIsCandidateCCompatible = AssertAssignable<
  OpenAI extends CandidateCClientLike ? true : false
>;

interface CandidateCAdapterOptions {
  vectorStoreId: string;
  manifest: readonly PolicyFileManifestEntry[];
  lockedAsOf: string;
  orders?: readonly SupportOrderRecord[];
  maxNumResults: 2;
  toolTimeoutMs?: number;
  now?: () => number;
}

type CandidateCResponseShape = Omit<OpenAIResponseShape, "output"> & {
  output?: ResponseOutputItem[];
};

interface FunctionCallShape {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  status: "completed";
}

export const CANDIDATE_C_LIMITS = Object.freeze({
  maxModelTurns: 3,
  maxToolCalls: 4,
});

const PUBLIC_CASE_KEYS = [
  "case_id",
  "dataset_split",
  "case_family",
  "as_of",
  "locale",
  "authenticated_customer_id",
  "order_id",
  "order_context_authorized",
  "ticket_messages",
] as const;

function assertExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label}에는 ${expected.join(", ")}만 허용합니다.`);
  }
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Candidate C case.${key}는 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value;
}

interface ValidatedCandidateInput {
  sanitizedInput: string;
  authorizedCaseScope: SupportCaseScope;
}

function validateAuthorizedInput(
  input: string,
  lockedAsOf: string,
): ValidatedCandidateInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch (error) {
    throw new TypeError("Candidate C input은 잠긴 JSON 객체여야 합니다.", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Candidate C input은 잠긴 JSON 객체여야 합니다.");
  }
  const record = parsed as Record<string, unknown>;
  assertExactKeys(record, ["case"], "Candidate C input");
  if (
    typeof record.case !== "object"
    || record.case === null
    || Array.isArray(record.case)
  ) {
    throw new TypeError("Candidate C input에는 case 객체만 허용합니다.");
  }
  const candidateCase = record.case as Record<string, unknown>;
  assertExactKeys(candidateCase, PUBLIC_CASE_KEYS, "Candidate C case");
  const datasetSplit = requireString(candidateCase, "dataset_split");
  const caseFamily = requireString(candidateCase, "case_family");
  const asOf = requireString(candidateCase, "as_of");
  const locale = requireString(candidateCase, "locale");
  const authenticatedCustomerId = requireString(candidateCase, "authenticated_customer_id");
  const orderId = requireString(candidateCase, "order_id");
  const sanitizedCase: Record<string, unknown> = {
    case_id: requireString(candidateCase, "case_id"),
    dataset_split: datasetSplit,
    case_family: caseFamily,
    as_of: asOf,
    locale,
    authenticated_customer_id: authenticatedCustomerId,
    order_id: orderId,
    order_context_authorized: candidateCase.order_context_authorized,
    ticket_messages: candidateCase.ticket_messages,
  };
  if (datasetSplit !== "PUBLIC_CALIBRATION") {
    throw new TypeError("Candidate C case.dataset_split은 PUBLIC_CALIBRATION으로 잠겨 있습니다.");
  }
  if (caseFamily !== "ORDER_CANCELLATION_AFTER_SHIPMENT") {
    throw new TypeError(
      "Candidate C case.case_family는 ORDER_CANCELLATION_AFTER_SHIPMENT로 잠겨 있습니다.",
    );
  }
  if (locale !== "en-US") {
    throw new TypeError("Candidate C case.locale은 en-US로 잠겨 있습니다.");
  }
  if (asOf !== lockedAsOf) {
    throw new TypeError(`Candidate C case.as_of는 잠긴 평가 시점 ${lockedAsOf}와 일치해야 합니다.`);
  }
  if (sanitizedCase.order_context_authorized !== true) {
    throw new TypeError("Candidate C case.order_context_authorized는 true여야 합니다.");
  }
  if (!Array.isArray(candidateCase.ticket_messages) || candidateCase.ticket_messages.length === 0) {
    throw new TypeError("Candidate C case.ticket_messages는 비어 있지 않은 배열이어야 합니다.");
  }
  sanitizedCase.ticket_messages = candidateCase.ticket_messages.map((message, index) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      throw new TypeError(`Candidate C case.ticket_messages[${index}]는 객체여야 합니다.`);
    }
    const item = message as Record<string, unknown>;
    assertExactKeys(item, ["role", "content"], `Candidate C case.ticket_messages[${index}]`);
    const role = requireString(item, "role");
    if (role !== "customer") {
      throw new TypeError(`Candidate C case.ticket_messages[${index}].role은 customer여야 합니다.`);
    }
    return { role, content: requireString(item, "content") };
  });
  return {
    sanitizedInput: JSON.stringify({ case: sanitizedCase }),
    authorizedCaseScope: { orderId, authenticatedCustomerId },
  };
}

function resolveTimeoutMs(invocation: CandidateInvocation, contextTimeoutMs?: number): number {
  const timeoutMs = contextTimeoutMs
    ?? invocation.limits?.timeoutMs
    ?? DEFAULT_CANDIDATE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CandidateInvocationError(
      "Candidate C timeoutMs는 0보다 큰 유한한 숫자여야 합니다.",
      false,
      { usage: null },
    );
  }
  return timeoutMs;
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

function isFunctionCall(item: ResponseOutputItem): item is ResponseOutputItem & FunctionCallShape {
  return item.type === "function_call"
    && "call_id" in item
    && typeof item.call_id === "string"
    && "name" in item
    && typeof item.name === "string"
    && "arguments" in item
    && typeof item.arguments === "string"
    && "status" in item
    && item.status === "completed"
    && item.call_id.trim().length > 0
    && item.name.trim().length > 0;
}

function isSupportToolName(name: string): name is SupportToolName {
  return name === "search_policy" || name === "get_order";
}

function bestEffortArguments(argumentsJson: unknown): Record<string, unknown> {
  if (typeof argumentsJson !== "string") {
    return { raw_arguments: argumentsJson ?? null };
  }
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { raw_arguments: argumentsJson };
  } catch {
    return { raw_arguments: argumentsJson };
  }
}

function rejectedFunctionCallEvidence(
  rawFunctionCall: ResponseOutputItem,
  callNumber: number,
  modelTurn: number,
  error: string,
): ToolCallEvidence {
  const raw = rawFunctionCall as unknown as Record<string, unknown>;
  const callId = typeof raw.call_id === "string" ? raw.call_id : "<missing_call_id>";
  const toolName = typeof raw.name === "string" ? raw.name : "<missing_tool_name>";
  const argumentsJson = typeof raw.arguments === "string" ? raw.arguments : null;
  const providerStatus = typeof raw.status === "string" ? raw.status : null;
  return {
    callNumber,
    modelTurn,
    callId,
    toolName,
    status: "FAILED",
    arguments: bestEffortArguments(raw.arguments),
    argumentsJson,
    providerStatus,
    result: null,
    latencyMs: 0,
    error,
  };
}

function remainingTimeoutMs(
  deadlineAtMs: number,
  now: () => number,
  runTimeoutMs: number,
  evidence: CandidateExecutionEvidence,
): number {
  const remaining = Math.floor(deadlineAtMs - now());
  if (remaining <= 0) {
    throw new CandidateInvocationError(
      `Candidate C 전체 실행 제한시간 ${runTimeoutMs}ms를 소진했습니다.`,
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

function buildRequest(
  invocation: CandidateInvocation,
  input: ResponseInput,
): ResponseCreateParamsNonStreaming {
  return {
    ...buildCandidateResponseRequest(invocation),
    input,
    tools: SUPPORT_TOOL_DEFINITIONS.map((tool) => structuredClone(tool)),
    parallel_tool_calls: false,
  };
}

export function createCandidateCAdapter(
  client: CandidateCClientLike,
  {
    vectorStoreId,
    manifest,
    lockedAsOf,
    orders,
    maxNumResults,
    toolTimeoutMs = 5_000,
    now = Date.now,
  }: CandidateCAdapterOptions,
): CandidateAdapter {
  const manifestSnapshot = manifest.map((entry) => structuredClone(entry));
  const ordersSnapshot = orders?.map((order) => structuredClone(order));

  return {
    async invoke(invocation, context) {
      throwIfAborted(context?.signal);
      let validatedInput: ValidatedCandidateInput;
      try {
        validatedInput = validateAuthorizedInput(invocation.input, lockedAsOf);
      } catch (error) {
        throw new CandidateInvocationError(
          error instanceof Error ? error.message : "Candidate C 입력 계약 오류",
          false,
          { cause: error, usage: null },
        );
      }

      const supportTools = createSupportToolExecutor(client, {
        vectorStoreId,
        manifest: manifestSnapshot,
        lockedAsOf,
        ...(ordersSnapshot ? { orders: ordersSnapshot } : {}),
        authorizedCaseScope: validatedInput.authorizedCaseScope,
        maxNumResults,
        toolTimeoutMs,
        now,
      });

      const runTimeoutMs = resolveTimeoutMs(invocation, context?.timeoutMs);
      const deadlineAtMs = now() + runTimeoutMs;
      const evidence = emptyEvidence();
      const lockedInvocation = structuredClone(invocation);
      lockedInvocation.input = validatedInput.sanitizedInput;
      const history: ResponseInput = [{
        role: "user",
        content: validatedInput.sanitizedInput,
      }];
      let toolCallCount = 0;
      let retrievalCallCount = 0;
      const seenCallIds = new Set<string>();

      for (
        let modelTurn = 1;
        modelTurn <= CANDIDATE_C_LIMITS.maxModelTurns;
        modelTurn += 1
      ) {
        const providerTimeoutMs = remainingTimeoutMs(
          deadlineAtMs,
          now,
          runTimeoutMs,
          evidence,
        );
        await emitCandidateProgress(context?.onProgress, {
          kind: "CANDIDATE_C_MODEL_TURN_STARTED",
          candidateId: invocation.candidateId,
          modelTurn,
        });
        const responseStartedAtMs = now();
        let response: CandidateCResponseShape;
        try {
          response = await client.responses.create(
            buildRequest(lockedInvocation, structuredClone(history)),
            {
              timeout: providerTimeoutMs,
              maxRetries: 0,
              ...(context?.signal ? { signal: context.signal } : {}),
            },
          ) as CandidateCResponseShape;
          throwIfAborted(context?.signal);
        } catch (error) {
          throwIfAborted(context?.signal);
          const details = getOpenAIRequestErrorDetails(error);
          const failedAtMs = now();
          const deadlineExceeded = failedAtMs >= deadlineAtMs;
          evidence.providerCalls.push({
            callNumber: evidence.providerCalls.length + 1,
            responseId: null,
            status: "failed",
            modelRequestedId: invocation.modelRequestedId,
            modelReportedId: null,
            serviceTierRequested: invocation.serviceTierRequested,
            serviceTierReported: null,
            latencyMs: Math.max(failedAtMs - responseStartedAtMs, 0),
            usage: null,
            error: details.message,
          });
          await emitCandidateProgress(context?.onProgress, {
            kind: "CANDIDATE_C_MODEL_TURN_FINISHED",
            candidateId: invocation.candidateId,
            modelTurn,
            outcome: "FAILED",
          }, {
            executionEvidence: evidence,
            usage: aggregateUsage(evidence),
          });
          throw new CandidateInvocationError(details.message, details.retryable, {
            cause: error,
            kind: deadlineExceeded ? "TIMEOUT" : details.kind,
            executionEvidence: evidence,
            usage: aggregateUsage(evidence),
          });
        }
        const responseFinishedAtMs = now();
        const mapped = mapOpenAIResponse(
          response as OpenAIResponseShape,
          invocation,
          Math.max(responseFinishedAtMs - responseStartedAtMs, 0),
          evidence.providerCalls.length + 1,
        );
        evidence.providerCalls.push(mapped.providerCall);
        const modelTurnCompleted = mapped.status === "completed"
          && responseFinishedAtMs < deadlineAtMs;
        await emitCandidateProgress(context?.onProgress, {
          kind: "CANDIDATE_C_MODEL_TURN_FINISHED",
          candidateId: invocation.candidateId,
          modelTurn,
          outcome: modelTurnCompleted ? "COMPLETE" : "FAILED",
        }, {
          executionEvidence: evidence,
          usage: aggregateUsage(evidence),
        });
        if (responseFinishedAtMs >= deadlineAtMs) {
          throw new CandidateInvocationError(
            `Candidate C 전체 실행 제한시간 ${runTimeoutMs}ms 뒤 반환된 provider 결과는 승인하지 않습니다.`,
            true,
            {
              kind: "TIMEOUT",
              executionEvidence: evidence,
              usage: aggregateUsage(evidence),
            },
          );
        }

        if (mapped.status !== "completed") {
          await emitCandidateProgress(context?.onProgress, {
            kind: "CANDIDATE_C_RESPONSE_FINISHED",
            candidateId: invocation.candidateId,
            modelTurn,
            outcome: "FAILED",
          }, {
            executionEvidence: evidence,
            usage: aggregateUsage(evidence),
          });
          return {
            responseId: mapped.responseId,
            status: mapped.status,
            modelReportedId: mapped.modelReportedId,
            serviceTierReported: mapped.serviceTierReported,
            outputText: mapped.outputText,
            usage: aggregateUsage(evidence),
            executionEvidence: evidence,
            ...(mapped.error ? { error: mapped.error } : {}),
          };
        }

        const outputItems = response.output ?? [];
        const rawFunctionCalls = outputItems.filter((item) => item.type === "function_call");
        if (rawFunctionCalls.length === 0) {
          await emitCandidateProgress(context?.onProgress, {
            kind: "CANDIDATE_C_RESPONSE_FINISHED",
            candidateId: invocation.candidateId,
            modelTurn,
            outcome: "COMPLETE",
          }, {
            executionEvidence: evidence,
            usage: aggregateUsage(evidence),
          });
          return {
            responseId: mapped.responseId,
            status: mapped.status,
            modelReportedId: mapped.modelReportedId,
            serviceTierReported: mapped.serviceTierReported,
            outputText: mapped.outputText,
            usage: aggregateUsage(evidence),
            executionEvidence: evidence,
          };
        }

        if (rawFunctionCalls.length > 1) {
          throw new CandidateInvocationError(
            "parallel_tool_calls=false 응답에 복수 function_call이 포함돼 provider 계약을 위반했습니다.",
            false,
            {
              executionEvidence: evidence,
              usage: aggregateUsage(evidence),
            },
          );
        }

        const rawFunctionCall = rawFunctionCalls[0];
        if (!isFunctionCall(rawFunctionCall)) {
          const error = "function_call에는 공백이 아닌 call_id/name, arguments 문자열, completed status가 필요합니다.";
          evidence.toolCalls.push(rejectedFunctionCallEvidence(
            rawFunctionCall,
            toolCallCount + 1,
            modelTurn,
            error,
          ));
          throw new CandidateInvocationError(
            "function_call 형식이 Responses 도구 계약과 일치하지 않습니다.",
            false,
            {
              executionEvidence: evidence,
              usage: aggregateUsage(evidence),
            },
          );
        }
        const functionCalls = [rawFunctionCall];
        const normalizedCallId = rawFunctionCall.call_id.trim();
        if (seenCallIds.has(normalizedCallId)) {
          const error = `중복 function_call call_id를 허용하지 않습니다: ${rawFunctionCall.call_id}`;
          evidence.toolCalls.push(rejectedFunctionCallEvidence(
            rawFunctionCall,
            toolCallCount + 1,
            modelTurn,
            error,
          ));
          throw new CandidateInvocationError(error, false, {
            executionEvidence: evidence,
            usage: aggregateUsage(evidence),
          });
        }
        seenCallIds.add(normalizedCallId);

        // 공식 Responses 계약은 output 전체 replay를 요구하지만 SDK 6.47.0의
        // 일부 추가 도구 item union은 input union보다 불필요하게 좁습니다.
        history.push(...structuredClone(outputItems) as unknown as ResponseInput);
        for (const functionCall of functionCalls) {
          if (toolCallCount >= CANDIDATE_C_LIMITS.maxToolCalls) {
            const attemptedCallNumber = toolCallCount + 1;
            evidence.toolCalls.push({
              callNumber: attemptedCallNumber,
              modelTurn,
              callId: functionCall.call_id,
              toolName: functionCall.name,
              status: "LIMIT_EXCEEDED",
              arguments: bestEffortArguments(functionCall.arguments),
              argumentsJson: functionCall.arguments,
              providerStatus: functionCall.status,
              result: null,
              latencyMs: 0,
              error: `Candidate C 도구 호출 한도 ${CANDIDATE_C_LIMITS.maxToolCalls}회를 초과했습니다.`,
            });
            throw new CandidateInvocationError(
              `Candidate C 도구 호출 한도 ${CANDIDATE_C_LIMITS.maxToolCalls}회를 초과했습니다.`,
              false,
              {
                executionEvidence: evidence,
                usage: aggregateUsage(evidence),
              },
            );
          }
          if (!isSupportToolName(functionCall.name)) {
            evidence.toolCalls.push({
              callNumber: toolCallCount + 1,
              modelTurn,
              callId: functionCall.call_id,
              toolName: functionCall.name,
              status: "FAILED",
              arguments: bestEffortArguments(functionCall.arguments),
              argumentsJson: functionCall.arguments,
              providerStatus: functionCall.status,
              result: null,
              latencyMs: 0,
              error: `허용되지 않은 읽기/쓰기 도구입니다: ${functionCall.name}`,
            });
            throw new CandidateInvocationError(
              `허용되지 않은 읽기/쓰기 도구입니다: ${functionCall.name}`,
              false,
              {
                executionEvidence: evidence,
                usage: aggregateUsage(evidence),
              },
            );
          }

          toolCallCount += 1;
          const toolTimeoutRemainingMs = remainingTimeoutMs(
            deadlineAtMs,
            now,
            runTimeoutMs,
            evidence,
          );
          if (functionCall.name === "search_policy") {
            retrievalCallCount += 1;
          }
          await emitCandidateProgress(context?.onProgress, {
            kind: "CANDIDATE_C_TOOL_STARTED",
            candidateId: invocation.candidateId,
            modelTurn,
            callNumber: toolCallCount,
            toolName: functionCall.name,
          });
          let result: Awaited<ReturnType<typeof supportTools.execute>>;
          try {
            result = await supportTools.execute({
              callNumber: toolCallCount,
              retrievalCallNumber: Math.max(retrievalCallCount, 1),
              modelTurn,
              callId: functionCall.call_id,
              name: functionCall.name,
              argumentsJson: functionCall.arguments,
              providerStatus: functionCall.status,
              timeoutMs: toolTimeoutRemainingMs,
              ...(context?.signal ? { signal: context.signal } : {}),
            });
            throwIfAborted(context?.signal);
          } catch (error) {
            throwIfAborted(context?.signal);
            if (error instanceof SupportToolExecutionError) {
              evidence.toolCalls.push(error.toolCall);
              evidence.retrievalCalls.push(...error.retrievalCalls);
            }
            const deadlineExceeded = now() >= deadlineAtMs;
            await emitCandidateProgress(context?.onProgress, {
              kind: "CANDIDATE_C_TOOL_FINISHED",
              candidateId: invocation.candidateId,
              modelTurn,
              callNumber: toolCallCount,
              toolName: functionCall.name,
              outcome: "FAILED",
            }, {
              executionEvidence: evidence,
              usage: aggregateUsage(evidence),
            });
            if (error instanceof SupportToolExecutionError) {
              throw new CandidateInvocationError(
                error.message,
                deadlineExceeded ? true : error.retryable,
                {
                  cause: error,
                  kind: deadlineExceeded || error.code === "TOOL_TIMEOUT"
                    ? "TIMEOUT"
                    : "OTHER",
                  executionEvidence: evidence,
                  usage: aggregateUsage(evidence),
                },
              );
            }
            throw error;
          }
          evidence.toolCalls.push(result.toolCall);
          evidence.retrievalCalls.push(...result.retrievalCalls);
          await emitCandidateProgress(context?.onProgress, {
            kind: "CANDIDATE_C_TOOL_FINISHED",
            candidateId: invocation.candidateId,
            modelTurn,
            callNumber: toolCallCount,
            toolName: functionCall.name,
            outcome: result.toolCall.status === "COMPLETE" ? "COMPLETE" : "FAILED",
          }, {
            executionEvidence: evidence,
            usage: aggregateUsage(evidence),
          });
          remainingTimeoutMs(deadlineAtMs, now, runTimeoutMs, evidence);
          history.push({
            type: "function_call_output",
            call_id: functionCall.call_id,
            output: result.output,
          });
        }

        if (modelTurn === CANDIDATE_C_LIMITS.maxModelTurns) {
          throw new CandidateInvocationError(
            `Candidate C model turn 한도 ${CANDIDATE_C_LIMITS.maxModelTurns}회를 초과했습니다.`,
            false,
            {
              executionEvidence: evidence,
              usage: aggregateUsage(evidence),
            },
          );
        }
      }

      throw new CandidateInvocationError(
        `Candidate C model turn 한도 ${CANDIDATE_C_LIMITS.maxModelTurns}회를 초과했습니다.`,
        false,
        { executionEvidence: evidence, usage: aggregateUsage(evidence) },
      );
    },
  };
}

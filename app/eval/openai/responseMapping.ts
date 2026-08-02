import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { candidateOutputJsonSchema } from "../contracts/candidateOutput";
import type {
  CandidateExecutionEvidence,
  ProviderCallEvidence,
} from "../contracts/executionEvidence";
import type { TokenUsage } from "../runtime/pricing";
import {
  CandidateInvocationError,
  type CandidateAdapterResult,
  type CandidateInvocation,
} from "../runner/types";
import { isOpenAITimeoutError } from "./requestError";

type OpenAIResponseOutputContent =
  | { type: "refusal"; refusal: string }
  | { type: string; [key: string]: unknown };

type OpenAIResponseOutputItem =
  | { type: "message"; content: OpenAIResponseOutputContent[] }
  | { type: string; [key: string]: unknown };

export interface OpenAIResponseShape {
  id: string;
  status: "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete";
  model: string;
  service_tier?: string | null;
  output_text: string;
  output?: OpenAIResponseOutputItem[];
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  usage?: {
    input_tokens: number;
    input_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
    output_tokens: number;
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
    total_tokens?: number;
  } | null;
}

export interface OpenAIResponsesClientLike {
  responses: {
    create(
      params: ResponseCreateParamsNonStreaming,
      options?: { timeout?: number; maxRetries?: number; signal?: AbortSignal },
    ): PromiseLike<unknown>;
  };
}

interface RefusalDetails {
  detected: boolean;
  message: string | null;
}

export function extractRefusalDetails(response: OpenAIResponseShape): RefusalDetails {
  let detected = false;
  let message: string | null = null;

  for (const item of response.output ?? []) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (typeof content === "object" && content !== null && content.type === "refusal") {
        detected = true;
        if (
          message === null
          && "refusal" in content
          && typeof content.refusal === "string"
          && content.refusal.trim().length > 0
        ) {
          message = content.refusal;
        }
      }
    }
  }
  return { detected, message };
}

export function mapResponseStatus(
  response: OpenAIResponseShape,
  refusalDetected: boolean,
): CandidateAdapterResult["status"] {
  if (refusalDetected) {
    return "refused";
  }
  if (response.status === "completed") {
    return "completed";
  }
  return response.status === "incomplete" ? "incomplete" : "failed";
}

export interface OpenAIRequestErrorDetails {
  message: string;
  retryable: boolean;
  kind: "OTHER" | "TIMEOUT";
}

export function getOpenAIRequestErrorDetails(error: unknown): OpenAIRequestErrorDetails {
  const status = typeof error === "object" && error !== null && "status" in error
    && typeof error.status === "number"
    ? error.status
    : null;
  return {
    message: error instanceof Error ? error.message : "OpenAI Responses 요청 오류",
    retryable: status === null || status === 408 || status === 409 || status === 429 || status >= 500,
    kind: isOpenAITimeoutError(error) ? "TIMEOUT" : "OTHER",
  };
}

export function classifyOpenAIRequestError(
  error: unknown,
  options?: ErrorOptions & {
    executionEvidence?: CandidateExecutionEvidence;
    usage?: TokenUsage | null;
  },
): CandidateInvocationError {
  const details = getOpenAIRequestErrorDetails(error);
  return new CandidateInvocationError(details.message, details.retryable, {
    ...options,
    kind: details.kind,
    cause: error,
  });
}

export function mapUsage(usage: NonNullable<OpenAIResponseShape["usage"]>): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: usage.input_tokens_details?.cache_write_tokens ?? 0,
    outputTokens: usage.output_tokens,
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens }
      : {}),
    ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
  };
}

export function buildCandidateResponseRequest(
  invocation: CandidateInvocation,
  input: string = invocation.input,
): ResponseCreateParamsNonStreaming {
  return {
    model: invocation.modelRequestedId,
    reasoning: { effort: "low" },
    max_output_tokens: invocation.limits?.maxOutputTokens ?? 800,
    service_tier: invocation.serviceTierRequested,
    store: false,
    instructions: invocation.instructions,
    input,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "candidate_customer_support_output",
        strict: true,
        schema: candidateOutputJsonSchema,
      },
    },
  };
}

export interface MappedOpenAIResponse {
  responseId: string;
  status: CandidateAdapterResult["status"];
  modelReportedId: string;
  serviceTierReported: string | null;
  outputText: string | null;
  usage: TokenUsage | null;
  error?: string;
  providerCall: ProviderCallEvidence;
}

export function mapOpenAIResponse(
  response: OpenAIResponseShape,
  invocation: CandidateInvocation,
  latencyMs: number,
  callNumber = 1,
): MappedOpenAIResponse {
  const refusal = extractRefusalDetails(response);
  const status = mapResponseStatus(response, refusal.detected);
  const usage = response.usage ? mapUsage(response.usage) : null;
  const error = status === "completed"
    ? undefined
    : refusal.message
      ?? response.error?.message
      ?? response.incomplete_details?.reason
      ?? `Responses API 상태: ${response.status}`;
  return {
    responseId: response.id,
    status,
    modelReportedId: response.model,
    serviceTierReported: response.service_tier ?? null,
    outputText: response.output_text || null,
    usage,
    ...(error ? { error } : {}),
    providerCall: {
      callNumber,
      responseId: response.id,
      status,
      modelRequestedId: invocation.modelRequestedId,
      modelReportedId: response.model,
      serviceTierRequested: invocation.serviceTierRequested,
      serviceTierReported: response.service_tier ?? null,
      latencyMs,
      usage: usage ? { ...usage } : null,
      ...(error ? { error } : {}),
    },
  };
}

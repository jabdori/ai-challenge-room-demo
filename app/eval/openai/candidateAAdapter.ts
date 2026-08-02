import {
  CandidateInvocationError,
  DEFAULT_CANDIDATE_TIMEOUT_MS,
  throwIfAborted,
  type CandidateAdapter,
} from "../runner/types";
import { emitCandidateProgress } from "../runner/progress";
import {
  buildCandidateResponseRequest,
  getOpenAIRequestErrorDetails,
  mapOpenAIResponse,
  type OpenAIResponseShape,
  type OpenAIResponsesClientLike,
} from "./responseMapping";

export type { OpenAIResponsesClientLike } from "./responseMapping";

interface CandidateAAdapterOptions {
  now?: () => number;
}

export function createCandidateAAdapter(
  client: OpenAIResponsesClientLike,
  { now = Date.now }: CandidateAAdapterOptions = {},
): CandidateAdapter {
  return {
    async invoke(invocation, context) {
      throwIfAborted(context?.signal);
      const timeoutMs = context?.timeoutMs
        ?? invocation.limits?.timeoutMs
        ?? DEFAULT_CANDIDATE_TIMEOUT_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new CandidateInvocationError(
          "Candidate A timeoutMs는 0보다 큰 유한한 숫자여야 합니다.",
          false,
        );
      }
      await emitCandidateProgress(context?.onProgress, {
        kind: "CANDIDATE_A_RESPONSE_STARTED",
        candidateId: invocation.candidateId,
      });
      const startedAtMs = now();
      let response: OpenAIResponseShape;
      try {
        response = await client.responses.create(
          buildCandidateResponseRequest(invocation),
          {
            timeout: timeoutMs,
            maxRetries: 0,
            ...(context?.signal ? { signal: context.signal } : {}),
          },
        ) as OpenAIResponseShape;
        throwIfAborted(context?.signal);
      } catch (error) {
        throwIfAborted(context?.signal);
        const failedAtMs = now();
        const details = getOpenAIRequestErrorDetails(error);
        const executionEvidence = {
          providerCalls: [{
            callNumber: 1,
            responseId: null,
            status: "failed" as const,
            modelRequestedId: invocation.modelRequestedId,
            modelReportedId: null,
            serviceTierRequested: invocation.serviceTierRequested,
            serviceTierReported: null,
            latencyMs: Math.max(failedAtMs - startedAtMs, 0),
            usage: null,
            error: details.message,
          }],
          retrievalCalls: [],
          toolCalls: [],
        };
        await emitCandidateProgress(context?.onProgress, {
          kind: "CANDIDATE_A_RESPONSE_FINISHED",
          candidateId: invocation.candidateId,
          outcome: "FAILED",
        }, {
          executionEvidence,
          usage: null,
        });
        throw new CandidateInvocationError(details.message, details.retryable, {
          cause: error,
          kind: details.kind,
          usage: null,
          executionEvidence,
        });
      }
      const responseFinishedAtMs = now();
      const mapped = mapOpenAIResponse(
        response,
        invocation,
        Math.max(responseFinishedAtMs - startedAtMs, 0),
      );
      const executionEvidence = {
        providerCalls: [mapped.providerCall],
        retrievalCalls: [],
        toolCalls: [],
      };
      await emitCandidateProgress(context?.onProgress, {
        kind: "CANDIDATE_A_RESPONSE_FINISHED",
        candidateId: invocation.candidateId,
        outcome: mapped.status === "completed" ? "COMPLETE" : "FAILED",
      }, {
        executionEvidence,
        usage: mapped.usage,
      });
      return {
        responseId: mapped.responseId,
        status: mapped.status,
        modelReportedId: mapped.modelReportedId,
        serviceTierReported: mapped.serviceTierReported,
        outputText: mapped.outputText,
        usage: mapped.usage,
        executionEvidence,
        ...(mapped.error ? { error: mapped.error } : {}),
      };
    },
  };
}

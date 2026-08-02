import { OpenAIError } from "openai";
import type { CandidateExecutionEvidence, RetrievalCallEvidence } from "../contracts/executionEvidence";
import {
  BENCHMARK_CASES,
  BENCHMARK_ORACLES,
  buildBenchmarkCandidateInput,
} from "../data/benchmark/index";
import type { EvaluationCase } from "../contracts/evaluationCase";
import {
  buildCandidateResponseRequest,
  getOpenAIRequestErrorDetails,
  mapOpenAIResponse,
  type OpenAIResponseShape,
  type OpenAIResponsesClientLike,
} from "../openai/responseMapping";
import {
  PolicyRetrievalError,
  searchPolicyVectorStore,
  type PolicyFileManifestEntry,
  type PolicyVectorStoreClientLike,
} from "../retrieval/policyVectorStore";
import {
  CandidateInvocationError,
  DEFAULT_CANDIDATE_TIMEOUT_MS,
  throwIfAborted,
  type CandidateAdapter,
} from "../runner/types";
import { buildBenchmarkRetrievalQuery } from "./candidateDefinitions";

export interface BenchmarkCandidateBClientLike
  extends OpenAIResponsesClientLike, PolicyVectorStoreClientLike {}

export interface CreateBenchmarkCandidateBAdapterOptions {
  caseId: string;
  vectorStoreId: string;
  manifest: readonly PolicyFileManifestEntry[];
  evaluationCase?: EvaluationCase;
  requiredRunnerRetrievalCalls?: 0 | 1;
  expectedInvocationInput?: string;
  now?: () => number;
}

function emptyEvidence(): CandidateExecutionEvidence {
  return { providerCalls: [], retrievalCalls: [], toolCalls: [] };
}

function expectedInput(caseId: string): string {
  const projected = buildBenchmarkCandidateInput("B", caseId);
  if (projected.order_access.channel !== "RUNNER_SNAPSHOT") {
    throw new TypeError("Benchmark Candidate B 주문 접근 채널은 RUNNER_SNAPSHOT이어야 합니다.");
  }
  const { channel: _channel, ...orderAccessResult } = projected.order_access;
  return JSON.stringify({
    case: projected.case,
    order_access_result: orderAccessResult,
  });
}

function buildProviderInput(
  invocationInput: string,
  retrieval: RetrievalCallEvidence | null,
): string {
  const sections = [
    "LOCKED CANDIDATE-FACING CASE AND RUNNER ORDER ACCESS RESULT:",
    invocationInput,
  ];
  if (retrieval !== null) {
    sections.push(
      "",
      "RUNNER-RETRIEVED POLICY EVIDENCE:",
      JSON.stringify({
        requested_query: retrieval.requestedQuery,
        reported_query: retrieval.reportedQuery,
        policies: retrieval.results.map((result) => ({
          rank: result.rank,
          score: result.score,
          source_id: result.sourceId,
          section_id: result.sectionId,
          fact_id: result.factId,
          file_id: result.fileId,
          filename: result.filename,
          text: result.text,
        })),
      }),
    );
  } else {
    sections.push("", "RUNNER-RETRIEVED POLICY EVIDENCE: NOT_REQUIRED");
  }
  return sections.join("\n");
}

function remainingTimeout(
  deadlineAt: number,
  now: () => number,
  evidence: CandidateExecutionEvidence,
): number {
  const remaining = Math.floor(deadlineAt - now());
  if (remaining <= 0) {
    throw new CandidateInvocationError(
      "Benchmark Candidate B 전체 실행 제한시간을 소진했습니다.",
      true,
      {
        kind: "TIMEOUT",
        executionEvidence: evidence,
        usage: null,
      },
    );
  }
  return remaining;
}

export function createBenchmarkCandidateBAdapter(
  client: BenchmarkCandidateBClientLike,
  {
    caseId,
    vectorStoreId,
    manifest,
    evaluationCase: suppliedEvaluationCase,
    requiredRunnerRetrievalCalls,
    expectedInvocationInput,
    now = Date.now,
  }: CreateBenchmarkCandidateBAdapterOptions,
): CandidateAdapter {
  const evaluationCase = suppliedEvaluationCase
    ?? BENCHMARK_CASES.find((item) => item.case_id === caseId);
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === caseId);
  const benchmarkAccess = oracle?.candidate_access_expectations.find(
    (item) => item.candidate_id === "B",
  );
  const requiredRetrieval = requiredRunnerRetrievalCalls
    ?? benchmarkAccess?.required_runner_retrieval_calls;
  if (
    !evaluationCase
    || evaluationCase.case_id !== caseId
    || (requiredRetrieval !== 0 && requiredRetrieval !== 1)
  ) {
    throw new TypeError(`Benchmark Candidate B case/access 계약을 찾을 수 없습니다: ${caseId}`);
  }
  if (vectorStoreId.trim().length === 0 || manifest.length === 0) {
    throw new TypeError("Benchmark Candidate B에는 vector store와 policy manifest가 필요합니다.");
  }
  const lockedInput = expectedInvocationInput ?? expectedInput(caseId);
  const lockedManifest = structuredClone(manifest);
  const query = buildBenchmarkRetrievalQuery(evaluationCase);

  return {
    async invoke(invocation, context) {
      throwIfAborted(context?.signal);
      if (invocation.candidateId !== "B" || invocation.input !== lockedInput) {
        throw new TypeError(
          "Benchmark Candidate B invocation은 잠긴 case/order_access_result와 일치해야 합니다.",
        );
      }
      const runTimeoutMs = context?.timeoutMs
        ?? invocation.limits?.timeoutMs
        ?? DEFAULT_CANDIDATE_TIMEOUT_MS;
      if (!Number.isFinite(runTimeoutMs) || runTimeoutMs <= 0) {
        throw new TypeError("Benchmark Candidate B timeoutMs는 0보다 큰 유한한 숫자여야 합니다.");
      }
      const deadlineAt = now() + runTimeoutMs;
      const evidence = emptyEvidence();
      let retrieval: RetrievalCallEvidence | null = null;

      if (requiredRetrieval === 1) {
        try {
          retrieval = await searchPolicyVectorStore(client, {
            vectorStoreId,
            query,
            maxNumResults: 6,
            manifest: lockedManifest,
            timeoutMs: remainingTimeout(deadlineAt, now, evidence),
            callNumber: 1,
            now,
            ...(context?.signal ? { signal: context.signal } : {}),
          });
          evidence.retrievalCalls.push(structuredClone(retrieval));
        } catch (error) {
          throwIfAborted(context?.signal);
          if (!(error instanceof PolicyRetrievalError)) {
            throw error;
          }
          // 응답/manifest 해석 실패는 후보 실패가 아니라 평가 자원 무결성 실패입니다.
          if (error.cause instanceof TypeError) {
            throw error.cause;
          }
          evidence.retrievalCalls.push(structuredClone(error.evidence));
          throw new CandidateInvocationError(error.message, error.retryable, {
            cause: error,
            kind: error.evidence.status === "TIMEOUT" ? "TIMEOUT" : "OTHER",
            executionEvidence: evidence,
            usage: null,
          });
        }
      }

      const responseStartedAt = now();
      let response: OpenAIResponseShape;
      try {
        response = await client.responses.create(
          buildCandidateResponseRequest(
            invocation,
            buildProviderInput(invocation.input, retrieval),
          ),
          {
            timeout: remainingTimeout(deadlineAt, now, evidence),
            maxRetries: 0,
            ...(context?.signal ? { signal: context.signal } : {}),
          },
        ) as OpenAIResponseShape;
        throwIfAborted(context?.signal);
      } catch (error) {
        throwIfAborted(context?.signal);
        if (!(error instanceof OpenAIError)) {
          throw error;
        }
        const details = getOpenAIRequestErrorDetails(error);
        evidence.providerCalls.push({
          callNumber: 1,
          responseId: null,
          status: "failed",
          modelRequestedId: invocation.modelRequestedId,
          modelReportedId: null,
          serviceTierRequested: invocation.serviceTierRequested,
          serviceTierReported: null,
          latencyMs: Math.max(now() - responseStartedAt, 0),
          usage: null,
          error: details.message,
        });
        throw new CandidateInvocationError(details.message, details.retryable, {
          cause: error,
          kind: details.kind,
          executionEvidence: evidence,
          usage: null,
        });
      }

      const mapped = mapOpenAIResponse(
        response,
        invocation,
        Math.max(now() - responseStartedAt, 0),
        1,
      );
      evidence.providerCalls.push(mapped.providerCall);
      return {
        responseId: mapped.responseId,
        status: mapped.status,
        modelReportedId: mapped.modelReportedId,
        serviceTierReported: mapped.serviceTierReported,
        outputText: mapped.outputText,
        usage: mapped.usage,
        executionEvidence: evidence,
        ...(mapped.error ? { error: mapped.error } : {}),
      };
    },
  };
}

import { parseCandidateOutput } from "../contracts/candidateOutput";
import type {
  CandidateExecutionEvidence,
  ProviderCallEvidence,
} from "../contracts/executionEvidence";
import type { TokenUsage } from "../runtime/pricing";
import {
  CandidateProgressObserverError,
  emitCandidateProgress,
  type CandidateProgressObserver,
  type PrivateCandidateProgressCapturedEvidence,
} from "./progress";
import {
  CandidateInvocationError,
  DEFAULT_CANDIDATE_TIMEOUT_MS,
  throwIfAborted,
} from "./types";
import type {
  AttemptStatus,
  CandidateAdapter,
  CandidateAttemptRecord,
  CandidateInvocation,
  CandidateRunRecord,
} from "./types";

const RUN_COUNT = 2;
const MAX_ATTEMPTS_PER_RUN = 2;
const REQUIRED_USAGE_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "outputTokens",
] as const;
const OPTIONAL_USAGE_FIELDS = ["reasoningTokens", "totalTokens"] as const;

export interface RunCandidateTwiceOptions {
  adapter: CandidateAdapter;
  invocation: CandidateInvocation;
  now?: () => number;
  signal?: AbortSignal;
  onProgress?: CandidateProgressObserver;
}

export interface RunCandidateOnceOptions extends RunCandidateTwiceOptions {
  runNumber: 1 | 2;
}

export class RunnerEvidenceIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunnerEvidenceIntegrityError";
  }
}

function assertExecutionEnvelope(invocation: CandidateInvocation): void {
  const envelope = invocation.executionEnvelope;
  if (envelope === undefined) {
    return;
  }
  for (const [name, value] of Object.entries(envelope)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RunnerEvidenceIntegrityError(
        `실행 envelope의 ${name}은(는) 0 이상의 안전한 정수여야 합니다.`,
      );
    }
  }
}

async function awaitWithAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfAborted(signal);
  const promise = operation();
  if (!signal) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      signal.removeEventListener("abort", onAbort);
    };
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    // 취소와 같은 turn에 이미 도착한 terminal 응답은 receipt로 보존할 수 있도록
    // abort 거부를 다음 macrotask까지 한 번 양보합니다.
    const onAbort = () => {
      if (abortTimer !== undefined || settled) return;
      abortTimer = setTimeout(() => rejectOnce(signal.reason), 0);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolveOnce, rejectOnce);
    if (signal.aborted) {
      onAbort();
    }
  });
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "알 수 없는 전송 오류";
}

function resolveRunTimeoutMs(invocation: CandidateInvocation): number {
  const timeoutMs = invocation.limits?.timeoutMs ?? DEFAULT_CANDIDATE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("run timeoutMs는 0보다 큰 유한한 숫자여야 합니다.");
  }
  return timeoutMs;
}

function copyInvocationWithRemainingTimeout(
  invocation: CandidateInvocation,
  timeoutMs: number,
): CandidateInvocation {
  const copied = structuredClone(invocation);
  if (copied.limits) {
    copied.limits.timeoutMs = timeoutMs;
  }
  return copied;
}

function mapAdapterStatus(status: "completed" | "incomplete" | "failed" | "refused"): AttemptStatus {
  if (status === "refused") {
    return "REFUSED";
  }

  if (status === "failed") {
    return "FAILED";
  }

  return status === "completed" ? "INVALID_OUTPUT" : "INCOMPLETE";
}

function validateUsage(usage: TokenUsage, label: string): string | null {
  for (const field of REQUIRED_USAGE_FIELDS) {
    if (!Number.isFinite(usage[field]) || usage[field] < 0) {
      return `${label}의 ${field}은(는) 0 이상의 유한한 숫자여야 합니다.`;
    }
  }
  for (const field of OPTIONAL_USAGE_FIELDS) {
    const value = usage[field];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      return `${label}의 ${field}은(는) 0 이상의 유한한 숫자여야 합니다.`;
    }
  }
  if (usage.cachedInputTokens + usage.cacheWriteTokens > usage.inputTokens) {
    return `${label}의 캐시 입력과 캐시 쓰기 토큰 합계가 총 입력 토큰보다 큽니다.`;
  }
  return null;
}

interface ProviderUsageDerivation {
  usage: TokenUsage | null;
  error: string | null;
}

function deriveProviderUsage(providerCalls: ProviderCallEvidence[]): ProviderUsageDerivation {
  if (providerCalls.length === 0) {
    return { usage: null, error: null };
  }

  const failedIndex = providerCalls.findIndex((call) => call.status === "failed");
  if (failedIndex !== -1 && failedIndex !== providerCalls.length - 1) {
    return {
      usage: null,
      error: "failed provider call은 trace의 마지막 호출이어야 합니다.",
    };
  }
  // usage 누락은 실행 증거를 폐기하지 않고 상위 비용 원장에서 COST_INCOMPLETE로 분류합니다.
  // 그 전까지 공급자가 보고한 실제 사용량은 비용 증거에서 버리지 않습니다.
  const usages = providerCalls
    .map((call) => call.usage)
    .filter((usage): usage is TokenUsage => usage !== null);
  if (usages.length === 0) {
    return { usage: null, error: null };
  }
  for (const [index, usage] of usages.entries()) {
    const error = validateUsage(usage, `providerCalls[${index}].usage`);
    if (error) {
      return { usage: null, error };
    }
  }

  for (const field of OPTIONAL_USAGE_FIELDS) {
    const definedCount = usages.filter((usage) => usage[field] !== undefined).length;
    if (definedCount !== 0 && definedCount !== usages.length) {
      return {
        usage: null,
        error: `provider call usage의 ${field} 존재 여부가 호출마다 일치해야 합니다.`,
      };
    }
  }

  const aggregate: TokenUsage = {
    inputTokens: usages.reduce((total, usage) => total + usage.inputTokens, 0),
    cachedInputTokens: usages.reduce((total, usage) => total + usage.cachedInputTokens, 0),
    cacheWriteTokens: usages.reduce((total, usage) => total + usage.cacheWriteTokens, 0),
    outputTokens: usages.reduce((total, usage) => total + usage.outputTokens, 0),
    ...(usages[0].reasoningTokens !== undefined
      ? {
          reasoningTokens: usages.reduce(
            (total, usage) => total + usage.reasoningTokens!,
            0,
          ),
        }
      : {}),
    ...(usages[0].totalTokens !== undefined
      ? {
          totalTokens: usages.reduce((total, usage) => total + usage.totalTokens!, 0),
        }
      : {}),
  };
  const aggregateError = validateUsage(aggregate, "provider call usage 합계");
  return aggregateError
    ? { usage: null, error: aggregateError }
    : { usage: aggregate, error: null };
}

function usagesEqual(left: TokenUsage | null, right: TokenUsage | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return [...REQUIRED_USAGE_FIELDS, ...OPTIONAL_USAGE_FIELDS]
    .every((field) => left[field] === right[field]);
}

interface EvidenceValidationResult {
  error: string | null;
  usageForCost: TokenUsage | null;
}

function mergePrivateEvidence(
  inputs: readonly (PrivateCandidateProgressCapturedEvidence | null | undefined)[],
): PrivateCandidateProgressCapturedEvidence {
  const evidence = inputs.flatMap((input) =>
    input === null || input === undefined ? [] : [input.executionEvidence]);
  const usages = inputs.flatMap((input) =>
    input?.usage === null || input?.usage === undefined ? [] : [input.usage]);
  const sum = (field: keyof TokenUsage): number =>
    usages.reduce((total, usage) => total + (usage[field] ?? 0), 0);
  const usage: TokenUsage | null = usages.length === 0
    ? null
    : {
        inputTokens: sum("inputTokens"),
        cachedInputTokens: sum("cachedInputTokens"),
        cacheWriteTokens: sum("cacheWriteTokens"),
        outputTokens: sum("outputTokens"),
        ...(usages.some((item) => item.reasoningTokens !== undefined)
          ? { reasoningTokens: sum("reasoningTokens") }
          : {}),
        ...(usages.some((item) => item.totalTokens !== undefined)
          ? { totalTokens: sum("totalTokens") }
          : {}),
      };
  return {
    executionEvidence: {
      providerCalls: evidence.flatMap((item) => item.providerCalls)
        .map((call, index) => ({ ...structuredClone(call), callNumber: index + 1 })),
      retrievalCalls: evidence.flatMap((item) => item.retrievalCalls)
        .map((call, index) => ({ ...structuredClone(call), callNumber: index + 1 })),
      toolCalls: evidence.flatMap((item) => item.toolCalls)
        .map((call, index) => ({ ...structuredClone(call), callNumber: index + 1 })),
    },
    usage,
  };
}

function privateAttemptsEvidence(
  attempts: readonly CandidateAttemptRecord[],
): PrivateCandidateProgressCapturedEvidence {
  return mergePrivateEvidence(attempts.map((attempt) => ({
    executionEvidence: attempt.executionEvidence === undefined
      ? { providerCalls: [], retrievalCalls: [], toolCalls: [] }
      : attempt.executionEvidence,
    usage: attempt.usage ?? null,
  })));
}

interface AdapterResponseMetadata {
  responseId: string | null;
  status: "completed" | "incomplete" | "failed" | "refused";
  modelReportedId: string | null;
  serviceTierReported: string | null;
}

function validateExecutionEvidence(
  evidence: CandidateExecutionEvidence,
  invocation: CandidateInvocation,
  aggregateUsage: TokenUsage | null,
  responseMetadata?: AdapterResponseMetadata,
): EvidenceValidationResult {
  const errors: string[] = [];

  const envelope = invocation.executionEnvelope;
  if (envelope !== undefined) {
    const counts = [
      ["provider", evidence.providerCalls.length, envelope.maxProviderCalls],
      ["retrieval", evidence.retrievalCalls.length, envelope.maxRetrievalCalls],
      ["tool", evidence.toolCalls.length, envelope.maxToolCalls],
    ] as const;
    for (const [label, actual, maximum] of counts) {
      if (actual > maximum) {
        errors.push(`${label} 호출 수 ${actual}가 잠긴 상한 ${maximum}을 초과했습니다.`);
      }
    }
  }

  evidence.providerCalls.forEach((call, index) => {
    const expectedCallNumber = index + 1;
    if (call.callNumber !== expectedCallNumber) {
      errors.push(
        `provider callNumber는 1부터 연속이어야 합니다: ${expectedCallNumber} 대신 ${call.callNumber}`,
      );
    }
    if (!Number.isFinite(call.latencyMs) || call.latencyMs < 0) {
      errors.push(`providerCalls[${index}].latencyMs는 0 이상의 유한한 숫자여야 합니다.`);
    }
    if (call.modelRequestedId !== invocation.modelRequestedId) {
      errors.push(`providerCalls[${index}]의 요청 모델이 invocation과 일치하지 않습니다.`);
    }
    if (call.serviceTierRequested !== invocation.serviceTierRequested) {
      errors.push(`providerCalls[${index}]의 요청 service tier가 invocation과 일치하지 않습니다.`);
    }
  });

  if (responseMetadata !== undefined) {
    const finalProviderCall = evidence.providerCalls.at(-1);
    if (
      finalProviderCall === undefined
      || finalProviderCall.responseId !== responseMetadata.responseId
      || finalProviderCall.status !== responseMetadata.status
      || finalProviderCall.modelReportedId !== responseMetadata.modelReportedId
      || finalProviderCall.serviceTierReported !== responseMetadata.serviceTierReported
    ) {
      errors.push(
        "adapter 상위 응답 메타데이터와 마지막 provider call 증거가 일치하지 않습니다.",
      );
    }
  }

  evidence.retrievalCalls.forEach((call, index) => {
    const expectedCallNumber = index + 1;
    if (call.callNumber !== expectedCallNumber) {
      errors.push(
        `retrieval callNumber는 1부터 연속이어야 합니다: ${expectedCallNumber} 대신 ${call.callNumber}`,
      );
    }
    if (!Number.isFinite(call.latencyMs) || call.latencyMs < 0) {
      errors.push(`retrievalCalls[${index}].latencyMs는 0 이상의 유한한 숫자여야 합니다.`);
    }
  });

  evidence.toolCalls.forEach((call, index) => {
    const expectedCallNumber = index + 1;
    if (call.callNumber !== expectedCallNumber) {
      errors.push(
        `tool callNumber는 1부터 연속이어야 합니다: ${expectedCallNumber} 대신 ${call.callNumber}`,
      );
    }
    if (!Number.isFinite(call.latencyMs) || call.latencyMs < 0) {
      errors.push(`toolCalls[${index}].latencyMs는 0 이상의 유한한 숫자여야 합니다.`);
    }
  });

  const derived = deriveProviderUsage(evidence.providerCalls);
  if (derived.error) {
    errors.push(derived.error);
  } else {
    if (aggregateUsage !== null) {
      const aggregateError = validateUsage(aggregateUsage, "adapter aggregate usage");
      if (aggregateError) {
        errors.push(aggregateError);
      }
    }
    if (!usagesEqual(derived.usage, aggregateUsage)) {
      errors.push("provider call usage 합계와 adapter aggregate usage가 일치하지 않습니다.");
    }
  }

  return {
    error: errors[0] ?? null,
    // 공급자별 사용량이 유효하면 adapter 합계가 틀려도 실제 비용 증거로 보존합니다.
    usageForCost: derived.error ? null : derived.usage,
  };
}

async function runOnce(
  runNumber: number,
  adapter: CandidateAdapter,
  invocation: CandidateInvocation,
  now: () => number,
  signal?: AbortSignal,
  onProgress?: CandidateProgressObserver,
): Promise<CandidateRunRecord> {
  throwIfAborted(signal);
  const attempts: CandidateAttemptRecord[] = [];
  let output: CandidateRunRecord["output"];
  let accumulatedInputTokens = 0;
  const runTimeoutMs = resolveRunTimeoutMs(invocation);
  const runStartedAtMs = now();
  const runDeadlineAtMs = runStartedAtMs + runTimeoutMs;

  for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS_PER_RUN; attemptNumber += 1) {
    throwIfAborted(signal);
    const isRetry = attemptNumber > 1;
    if (isRetry) {
      await emitCandidateProgress(onProgress, {
        kind: "CANDIDATE_RETRY_STARTED",
        candidateId: invocation.candidateId,
        runNumber,
        attemptNumber,
      }, privateAttemptsEvidence(attempts));
    }
    await emitCandidateProgress(onProgress, {
      kind: "CANDIDATE_ATTEMPT_STARTED",
      candidateId: invocation.candidateId,
      runNumber,
      attemptNumber,
    }, privateAttemptsEvidence(attempts));
    const startedAtMs = now();
    const remainingTimeoutMs = Math.floor(runDeadlineAtMs - startedAtMs);
    if (remainingTimeoutMs <= 0) {
      const timeoutAttempt: CandidateAttemptRecord = {
        attemptNumber,
        status: "TIMEOUT",
        startedAt: new Date(startedAtMs).toISOString(),
        latencyMs: 0,
        error: `전체 실행 제한시간 ${runTimeoutMs}ms를 소진했습니다.`,
      };
      attempts.push(timeoutAttempt);
      await emitCandidateProgress(onProgress, {
        kind: "CANDIDATE_ATTEMPT_FINISHED",
        candidateId: invocation.candidateId,
        runNumber,
        attemptNumber,
        status: "TIMEOUT",
      }, privateAttemptsEvidence(attempts));
      if (isRetry) {
        await emitCandidateProgress(onProgress, {
          kind: "CANDIDATE_RETRY_FINISHED",
          candidateId: invocation.candidateId,
          runNumber,
          attemptNumber,
          status: "TIMEOUT",
        }, privateAttemptsEvidence(attempts));
      }
      break;
    }

    let attempt: CandidateAttemptRecord;
    let retryAllowed = false;
    let deadlineExhausted = false;
    const attemptInvocation = copyInvocationWithRemainingTimeout(invocation, remainingTimeoutMs);

    try {
      const response = await awaitWithAbort(
        () => adapter.invoke(attemptInvocation, {
          timeoutMs: remainingTimeoutMs,
          ...(signal ? { signal } : {}),
          ...(onProgress ? { onProgress } : {}),
        }),
        signal,
      );
      const finishedAtMs = now();
      const latencyMs = Math.max(finishedAtMs - startedAtMs, 0);
      deadlineExhausted = finishedAtMs >= runDeadlineAtMs;
      const aggregateUsage = response.usage ? structuredClone(response.usage) : null;
      const executionEvidence = response.executionEvidence === undefined
        ? undefined
        : structuredClone(response.executionEvidence);
      if (invocation.executionEnvelope !== undefined && executionEvidence === undefined) {
        throw new RunnerEvidenceIntegrityError(
          "실행 envelope가 있는 completed 후보 응답에는 실행 증거가 필요합니다.",
        );
      }
      const evidenceValidation = executionEvidence
        ? validateExecutionEvidence(executionEvidence, invocation, aggregateUsage, {
          responseId: response.responseId,
          status: response.status,
          modelReportedId: response.modelReportedId,
          serviceTierReported: response.serviceTierReported ?? null,
        })
        : null;
      if (evidenceValidation?.error) {
        throw new RunnerEvidenceIntegrityError(evidenceValidation.error);
      }
      const usage = evidenceValidation ? evidenceValidation.usageForCost : aggregateUsage;
      accumulatedInputTokens += usage?.inputTokens ?? 0;
      const shared: Omit<CandidateAttemptRecord, "status" | "error"> = {
        attemptNumber,
        startedAt: new Date(startedAtMs).toISOString(),
        latencyMs,
        ...(response.responseId ? { responseId: response.responseId } : {}),
        ...(response.modelReportedId ? { modelReportedId: response.modelReportedId } : {}),
        ...(response.serviceTierReported ? { serviceTierReported: response.serviceTierReported } : {}),
        ...(usage ? { usage } : {}),
        ...(executionEvidence ? { executionEvidence } : {}),
      };

      const exceedsInputBudget = usage && invocation.limits
        ? accumulatedInputTokens > invocation.limits.maxInputTokens
        : false;
      const exceedsOutputBudget = usage && invocation.limits
        ? usage.outputTokens > invocation.limits.maxOutputTokens
        : false;

      if (deadlineExhausted) {
        attempt = {
          ...shared,
          status: "TIMEOUT",
          error: `전체 실행 제한시간 ${runTimeoutMs}ms 뒤 반환된 결과는 승인하지 않습니다.`,
        };
      } else if (exceedsInputBudget || exceedsOutputBudget) {
        attempt = {
          ...shared,
          status: "BUDGET_EXCEEDED",
          error: "잠긴 입력 또는 출력 토큰 예산을 초과했습니다.",
        };
      } else if (response.status !== "completed" || response.outputText === null) {
        const status = mapAdapterStatus(response.status);
        retryAllowed = status === "INVALID_OUTPUT";
        attempt = {
          ...shared,
          status,
          error: response.error ?? `Responses API 상태: ${response.status}`,
        };
      } else {
        try {
          output = parseCandidateOutput(response.outputText);
          attempt = { ...shared, status: "COMPLETE" };
        } catch (error) {
          retryAllowed = true;
          attempt = {
            ...shared,
            status: "INVALID_OUTPUT",
            error: safeErrorMessage(error),
          };
        }
      }
    } catch (error) {
      if (!(error instanceof CandidateInvocationError)) {
        if (error instanceof CandidateProgressObserverError) {
          throw new CandidateProgressObserverError(
            error.event,
            error,
            mergePrivateEvidence([
              privateAttemptsEvidence(attempts),
              error.capturedEvidence,
            ]),
          );
        }
        throwIfAborted(signal);
        throw error;
      }
      const finishedAtMs = now();
      deadlineExhausted = finishedAtMs >= runDeadlineAtMs;
      const invocationError = error;
      const executionEvidence = invocationError.executionEvidence === undefined
        ? undefined
        : structuredClone(invocationError.executionEvidence);
      const aggregateUsage = invocationError.usage;
      const evidenceValidation = executionEvidence
        ? validateExecutionEvidence(executionEvidence, invocation, aggregateUsage)
        : null;
      if (evidenceValidation?.error) {
        throw new RunnerEvidenceIntegrityError(evidenceValidation.error, { cause: error });
      }
      const usage = evidenceValidation ? evidenceValidation.usageForCost : aggregateUsage;
      accumulatedInputTokens += usage?.inputTokens ?? 0;
      const retryable = invocationError.retryable;
      const exceedsInputBudget = usage && invocation.limits
        ? accumulatedInputTokens > invocation.limits.maxInputTokens
        : false;
      const timeoutError = invocationError?.kind === "TIMEOUT";
      const budgetError = invocationError?.kind === "BUDGET_EXCEEDED";
      retryAllowed = !deadlineExhausted
        && !exceedsInputBudget
        && !budgetError
        && retryable;
      attempt = {
        attemptNumber,
        status: deadlineExhausted
          ? "TIMEOUT"
          : exceedsInputBudget || budgetError
            ? "BUDGET_EXCEEDED"
            : timeoutError
                ? "TIMEOUT"
                : retryable
                  ? "TRANSPORT_ERROR"
                  : "REQUEST_ERROR",
        startedAt: new Date(startedAtMs).toISOString(),
        latencyMs: Math.max(finishedAtMs - startedAtMs, 0),
        ...(usage ? { usage } : {}),
        ...(executionEvidence ? { executionEvidence } : {}),
        error: deadlineExhausted
          ? `전체 실행 제한시간 ${runTimeoutMs}ms를 소진했습니다: ${safeErrorMessage(error)}`
          : exceedsInputBudget || budgetError
            ? exceedsInputBudget
              ? "잠긴 입력 토큰 예산을 누적 초과했습니다."
              : safeErrorMessage(error)
            : safeErrorMessage(error),
      };
    }

    attempts.push(attempt);
    await emitCandidateProgress(onProgress, {
      kind: "CANDIDATE_ATTEMPT_FINISHED",
      candidateId: invocation.candidateId,
      runNumber,
      attemptNumber,
      status: attempt.status,
    }, privateAttemptsEvidence(attempts));
    if (isRetry) {
      await emitCandidateProgress(onProgress, {
        kind: "CANDIDATE_RETRY_FINISHED",
        candidateId: invocation.candidateId,
        runNumber,
        attemptNumber,
        status: attempt.status,
      }, privateAttemptsEvidence(attempts));
    }
    // terminal 응답 또는 구조화된 invocation 오류를 기록한 뒤에는 취소 상태에서
    // 재시도하지 않습니다. 상위 orchestrator가 receipt 저장 후 취소를 전파합니다.
    if (signal?.aborted) {
      break;
    }
    if (deadlineExhausted || !retryAllowed) {
      break;
    }
  }

  const terminalStatus = attempts.at(-1)?.status;
  return {
    runNumber,
    status: output
      ? "COMPLETE"
      : terminalStatus === "BUDGET_EXCEEDED"
        ? "BUDGET_EXCEEDED"
        : terminalStatus === "TIMEOUT"
          ? "TIMEOUT"
        : "INVALID",
    attempts,
    ...(output ? { output } : {}),
    totalLatencyMs: attempts.reduce((total, attempt) => total + attempt.latencyMs, 0),
  };
}

export async function runCandidateTwice({
  adapter,
  invocation,
  now = Date.now,
  signal,
  onProgress,
}: RunCandidateTwiceOptions): Promise<CandidateRunRecord[]> {
  throwIfAborted(signal);
  assertExecutionEnvelope(invocation);
  const runs: CandidateRunRecord[] = [];

  // 두 결과는 한 요청의 복수 샘플이 아니라 별도의 Responses 호출입니다.
  for (let runNumber = 1; runNumber <= RUN_COUNT; runNumber += 1) {
    throwIfAborted(signal);
    runs.push(await runCandidateOnce({
      runNumber: runNumber as 1 | 2,
      adapter,
      invocation,
      now,
      signal,
      onProgress,
    }));
  }

  return runs;
}

export async function runCandidateOnce({
  runNumber,
  adapter,
  invocation,
  now = Date.now,
  signal,
  onProgress,
}: RunCandidateOnceOptions): Promise<CandidateRunRecord> {
  if (runNumber !== 1 && runNumber !== 2) {
    throw new TypeError("Benchmark runNumber는 잠긴 반복 1 또는 2여야 합니다.");
  }
  throwIfAborted(signal);
  assertExecutionEnvelope(invocation);
  return runOnce(runNumber, adapter, invocation, now, signal, onProgress);
}

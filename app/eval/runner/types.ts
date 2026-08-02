import type { CandidateOutput } from "../contracts/candidateOutput";
import type { CandidateExecutionEvidence } from "../contracts/executionEvidence";
import type { TokenUsage } from "../runtime/pricing";
import type { CandidateProgressObserver } from "./progress";

export type CandidateServiceTier = "auto" | "default" | "flex" | "scale" | "priority";

export const DEFAULT_CANDIDATE_TIMEOUT_MS = 30_000;

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason !== undefined) {
    throw signal.reason;
  }
  signal.throwIfAborted();
}

export interface CandidateInvocation {
  candidateId: string;
  modelRequestedId: string;
  serviceTierRequested: CandidateServiceTier;
  instructions: string;
  input: string;
  limits?: {
    maxInputTokens: number;
    maxOutputTokens: number;
    timeoutMs?: number;
  };
  executionEnvelope?: {
    maxProviderCalls: number;
    maxRetrievalCalls: number;
    maxToolCalls: number;
  };
}

export interface CandidateAdapterResult {
  responseId: string | null;
  status: "completed" | "incomplete" | "failed" | "refused";
  modelReportedId: string | null;
  serviceTierReported?: string | null;
  outputText: string | null;
  usage: TokenUsage | null;
  executionEvidence?: CandidateExecutionEvidence;
  error?: string;
}

export interface CandidateAdapterContext {
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: CandidateProgressObserver;
}

export interface CandidateAdapter {
  invoke(
    invocation: CandidateInvocation,
    context?: CandidateAdapterContext,
  ): Promise<CandidateAdapterResult>;
}

export type CandidateInvocationErrorKind = "OTHER" | "TIMEOUT" | "BUDGET_EXCEEDED";

export class CandidateInvocationError extends Error {
  readonly retryable: boolean;
  readonly kind: CandidateInvocationErrorKind;
  readonly executionEvidence?: CandidateExecutionEvidence;
  readonly usage: TokenUsage | null;

  constructor(
    message: string,
    retryable: boolean,
    options?: ErrorOptions & {
      kind?: CandidateInvocationErrorKind;
      executionEvidence?: CandidateExecutionEvidence;
      usage?: TokenUsage | null;
    },
  ) {
    super(message, options);
    this.name = "CandidateInvocationError";
    this.retryable = retryable;
    this.kind = options?.kind ?? "OTHER";
    this.executionEvidence = options?.executionEvidence === undefined
      ? undefined
      : structuredClone(options.executionEvidence);
    this.usage = options?.usage === undefined || options.usage === null
      ? null
      : structuredClone(options.usage);
  }
}

export type AttemptStatus =
  | "COMPLETE"
  | "INVALID_OUTPUT"
  | "TRANSPORT_ERROR"
  | "REQUEST_ERROR"
  | "TIMEOUT"
  | "BUDGET_EXCEEDED"
  | "INCOMPLETE"
  | "FAILED"
  | "REFUSED";

export interface CandidateAttemptRecord {
  attemptNumber: number;
  status: AttemptStatus;
  startedAt: string;
  latencyMs: number;
  responseId?: string;
  modelReportedId?: string;
  serviceTierReported?: string;
  usage?: TokenUsage;
  executionEvidence?: CandidateExecutionEvidence;
  error?: string;
}

export interface CandidateRunRecord {
  runNumber: number;
  status: "COMPLETE" | "INVALID" | "TIMEOUT" | "BUDGET_EXCEEDED";
  attempts: CandidateAttemptRecord[];
  output?: CandidateOutput;
  totalLatencyMs: number;
}

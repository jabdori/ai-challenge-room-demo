import type { CandidateExecutionEvidence } from "../contracts/executionEvidence";
import type { TokenUsage } from "../runtime/pricing";

export type CandidateProgressAttemptStatus =
  | "COMPLETE"
  | "INVALID_OUTPUT"
  | "TRANSPORT_ERROR"
  | "REQUEST_ERROR"
  | "TIMEOUT"
  | "BUDGET_EXCEEDED"
  | "INCOMPLETE"
  | "FAILED"
  | "REFUSED";

export type CandidateProgressEvent =
  | { readonly kind: "ENVIRONMENT_PREPARING" }
  | { readonly kind: "ENVIRONMENT_PREPARED" }
  | {
    readonly kind: "CANDIDATE_ATTEMPT_STARTED";
    readonly candidateId: string;
    readonly runNumber: number;
    readonly attemptNumber: number;
  }
  | {
    readonly kind: "CANDIDATE_ATTEMPT_FINISHED";
    readonly candidateId: string;
    readonly runNumber: number;
    readonly attemptNumber: number;
    readonly status: CandidateProgressAttemptStatus;
  }
  | {
    readonly kind: "CANDIDATE_RETRY_STARTED";
    readonly candidateId: string;
    readonly runNumber: number;
    readonly attemptNumber: number;
  }
  | {
    readonly kind: "CANDIDATE_RETRY_FINISHED";
    readonly candidateId: string;
    readonly runNumber: number;
    readonly attemptNumber: number;
    readonly status: CandidateProgressAttemptStatus;
  }
  | {
    readonly kind:
      | "CANDIDATE_A_RESPONSE_STARTED"
      | "CANDIDATE_B_RETRIEVAL_STARTED"
      | "CANDIDATE_B_RESPONSE_STARTED";
    readonly candidateId: string;
  }
  | {
    readonly kind:
      | "CANDIDATE_A_RESPONSE_FINISHED"
      | "CANDIDATE_B_RETRIEVAL_FINISHED"
      | "CANDIDATE_B_RESPONSE_FINISHED";
    readonly candidateId: string;
    readonly outcome: "COMPLETE" | "FAILED";
  }
  | {
    readonly kind: "CANDIDATE_C_MODEL_TURN_STARTED";
    readonly candidateId: string;
    readonly modelTurn: number;
  }
  | {
    readonly kind: "CANDIDATE_C_MODEL_TURN_FINISHED";
    readonly candidateId: string;
    readonly modelTurn: number;
    readonly outcome: "COMPLETE" | "FAILED";
  }
  | {
    readonly kind: "CANDIDATE_C_TOOL_STARTED";
    readonly candidateId: string;
    readonly modelTurn: number;
    readonly callNumber: number;
    readonly toolName: "get_order" | "search_policy";
  }
  | {
    readonly kind: "CANDIDATE_C_TOOL_FINISHED";
    readonly candidateId: string;
    readonly modelTurn: number;
    readonly callNumber: number;
    readonly toolName: "get_order" | "search_policy";
    readonly outcome: "COMPLETE" | "FAILED";
  }
  | {
    readonly kind: "CANDIDATE_C_RESPONSE_FINISHED";
    readonly candidateId: string;
    readonly modelTurn: number;
    readonly outcome: "COMPLETE" | "FAILED";
  }
  | { readonly kind: "HARD_GATES_STARTED" }
  | { readonly kind: "HARD_GATES_FINISHED" }
  | { readonly kind: "RESULTS_PERSISTING" }
  | { readonly kind: "RESULTS_PERSISTED" }
  | { readonly kind: "REMOTE_CLEANUP_STARTED" }
  | { readonly kind: "REMOTE_CLEANUP_FINISHED" };

export type CandidateProgressObserver = (
  event: CandidateProgressEvent,
) => void | Promise<void>;

/**
 * 공개 진행 projection과 분리된 실행 증거입니다. FINISHED 상태 저장 실패 시
 * 상위 오케스트레이터가 유료 호출 증거를 별도 보존하는 용도로만 사용합니다.
 */
export interface PrivateCandidateProgressCapturedEvidence {
  readonly executionEvidence: CandidateExecutionEvidence;
  readonly usage: TokenUsage | null;
}

export class CandidateProgressObserverError extends Error {
  readonly event: CandidateProgressEvent;
  readonly capturedEvidence?: PrivateCandidateProgressCapturedEvidence;

  constructor(
    event: CandidateProgressEvent,
    cause: unknown,
    capturedEvidence?: PrivateCandidateProgressCapturedEvidence,
  ) {
    super(`후보 진행 상태 저장에 실패했습니다: ${event.kind}`, { cause });
    this.name = "CandidateProgressObserverError";
    this.event = structuredClone(event);
    if (capturedEvidence !== undefined) {
      this.capturedEvidence = structuredClone(capturedEvidence);
    }
  }
}

/**
 * 진행 기록은 외부 호출보다 먼저 내구성 있게 저장되어야 합니다.
 * observer 오류를 후보 품질 실패나 재시도 가능 오류로 바꾸지 않습니다.
 */
export async function emitCandidateProgress(
  observer: CandidateProgressObserver | undefined,
  event: CandidateProgressEvent,
  capturedEvidence?: PrivateCandidateProgressCapturedEvidence,
): Promise<void> {
  if (!observer) return;
  try {
    await observer(structuredClone(event));
  } catch (error) {
    if (
      error instanceof CandidateProgressObserverError
      && capturedEvidence === undefined
    ) {
      throw error;
    }
    throw new CandidateProgressObserverError(event, error, capturedEvidence);
  }
}

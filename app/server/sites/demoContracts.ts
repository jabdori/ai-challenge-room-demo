export type DemoSource = "LIVE" | "RECORDED_FALLBACK";

export type DemoExecutionStatus =
  | "READY"
  | "RUNNING"
  | "INTERRUPTED"
  | "FAILED"
  | "RESULTS_READY"
  | "JUDGE_READY"
  | "REVIEW_READY"
  | "NO_APPROVED_CANDIDATE"
  | "SELECTION_RECORDED"
  | "MEMO_RUNNING"
  | "MEMO_FAILED"
  | "MEMO_READY"
  | "REGRESSION_BLOCK";

export interface DemoSessionRecord {
  readonly sessionTokenDigest: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly revokedAtMs: number | null;
  readonly successfulLiveRuns: number;
  readonly operationalRetryCount: number;
  readonly currentExecutionId: string | null;
}

export interface AuthFailureRecord {
  readonly networkFingerprint: string;
  readonly bucketStartedAtMs: number;
  readonly failureCount: number;
  readonly blockedUntilMs: number | null;
}

export interface AuthFailureAttempt {
  readonly networkFingerprint: string;
  readonly bucketStartedAtMs: number;
  readonly attemptedAtMs: number;
  readonly failureLimit: number;
  readonly blockDurationMs: number;
}

export interface DemoExecutionRecord {
  readonly executionId: string;
  readonly sessionTokenDigest: string;
  readonly idempotencyKey: string;
  readonly source: DemoSource;
  readonly status: DemoExecutionStatus;
  readonly progressStep: string;
  readonly currentCandidate: "A" | "B" | "C" | null;
  readonly completedCandidateCount: number;
  readonly createdAtMs: number;
  readonly startedAtMs: number | null;
  readonly heartbeatAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly retryCount: number;
  readonly errorCode: string | null;
  readonly cleanupStatus: "NOT_STARTED" | "RUNNING" | "ACKNOWLEDGED" | "FAILED";
  readonly evaluationPackReference: DemoArtifactReference | null;
  readonly publicProjectionReference: DemoArtifactReference | null;
  readonly cleanupReceiptReference: DemoArtifactReference | null;
  readonly actualCostMicroUsd: number;
  readonly sourceHash: string;
  readonly stateVersion: number;
}

export interface DemoExecutionUpdateGuard {
  readonly expectedSourceHash: string;
  readonly expectedStateVersion: number;
  readonly expectedStatus: DemoExecutionStatus;
}

export interface DemoExecutionArtifactGuard extends DemoExecutionUpdateGuard {
  readonly sessionTokenDigest: string;
}

export interface DemoHumanReviewRecord {
  readonly executionId: string;
  readonly blindLabel: "X" | "Y" | "Z";
  readonly decision: "PASS" | "CONFIRMED_FAIL";
  readonly rationale: string;
  readonly correctedReply: string | null;
  readonly reviewDurationMs: number;
  readonly editDurationMs: number;
  readonly confirmedAtMs: number;
}

export interface DemoCandidateSelectionRecord {
  readonly executionId: string;
  readonly candidateId: "A" | "B" | "C";
  readonly rationale: string;
  readonly sourceHash: string;
  readonly selectedAtMs: number;
}

export interface DemoDecisionMemoRecord {
  readonly executionId: string;
  readonly status: "NOT_STARTED" | "RUNNING" | "FAILED" | "READY";
  readonly sourcePackHash: string;
  readonly reviewHash: string | null;
  readonly selectionHash: string | null;
  readonly artifactReference: DemoArtifactReference | null;
  readonly errorCode: string | null;
  readonly reconciliationReason: string | null;
  readonly updatedAtMs: number;
}

export type DemoAuxiliaryCallKind = "JUDGE" | "MEMO";

export type DemoAuxiliaryCallAttemptStatus =
  | "RESERVED"
  | "COMPLETE"
  | "FAILED";

export interface DemoAuxiliaryCallAttemptRecord {
  readonly executionId: string;
  readonly sessionTokenDigest: string;
  readonly kind: DemoAuxiliaryCallKind;
  readonly attemptNumber: 1 | 2;
  readonly sourceHash: string;
  readonly reservedStateVersion: number;
  readonly bucketStartedAtMs: number;
  readonly status: DemoAuxiliaryCallAttemptStatus;
  readonly reservedAtMs: number;
  readonly completedAtMs: number | null;
  readonly errorCode: string | null;
}

export interface DemoAuxiliaryCallReservation {
  readonly executionId: string;
  readonly sessionTokenDigest: string;
  readonly expectedSourceHash: string;
  readonly expectedStateVersion: number;
  readonly expectedStatus: DemoExecutionStatus;
  readonly expectedProgressStep: string;
  readonly kind: DemoAuxiliaryCallKind;
  readonly attemptNumber: 1 | 2;
  readonly bucketStartedAtMs: number;
  readonly reservedAtMs: number;
  readonly maxAttemptsPerBucket: number;
}

export type DemoAuxiliaryCallReservationResult =
  | {
      readonly outcome: "RESERVED";
      readonly attempt: DemoAuxiliaryCallAttemptRecord;
    }
  | {
      readonly outcome:
        | "ALREADY_RESERVED"
        | "LIMIT_REACHED"
        | "STALE";
    };

export interface DemoAuxiliaryCallCompletion {
  readonly executionId: string;
  readonly sessionTokenDigest: string;
  readonly expectedSourceHash: string;
  readonly expectedStateVersion: number;
  readonly kind: DemoAuxiliaryCallKind;
  readonly attemptNumber: 1 | 2;
  readonly outcome: "COMPLETE" | "FAILED";
  readonly completedAtMs: number;
  readonly errorCode: string | null;
}

export interface DemoHumanReviewTransition {
  readonly executionId: string;
  readonly sessionTokenDigest: string;
  readonly expectedSourceHash: string;
  readonly expectedStateVersion: number;
  readonly nextStatus: "REVIEW_READY" | "NO_APPROVED_CANDIDATE";
  readonly publicProjectionReference: DemoArtifactReference;
  readonly reviews: readonly DemoHumanReviewRecord[];
}

export interface DemoCandidateSelectionTransition {
  readonly executionId: string;
  readonly sessionTokenDigest: string;
  readonly expectedSourceHash: string;
  readonly expectedStateVersion: number;
  readonly publicProjectionReference: DemoArtifactReference;
  readonly selection: DemoCandidateSelectionRecord;
}

export interface DemoDecisionMemoTransition {
  readonly executionId: string;
  readonly sessionTokenDigest: string;
  readonly expectedSourceHash: string;
  readonly expectedStateVersion: number;
  readonly publicProjectionReference: DemoArtifactReference;
  readonly memo: DemoDecisionMemoRecord;
}

export type DemoArtifactNamespace =
  | "live-evaluation-packs"
  | "candidate-evidence"
  | "errors"
  | "cleanup-receipts"
  | "recorded-fallback"
  | "decision-memos";

export interface DemoArtifactReference {
  readonly namespace: DemoArtifactNamespace;
  readonly objectKey: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface DemoStateRepository {
  createSession(record: DemoSessionRecord): Promise<void>;
  readSession(sessionTokenDigest: string): Promise<DemoSessionRecord | null>;
  revokeSession(sessionTokenDigest: string, revokedAtMs: number): Promise<boolean>;

  readAuthFailure(
    networkFingerprint: string,
    bucketStartedAtMs: number,
  ): Promise<AuthFailureRecord | null>;
  readLatestAuthFailure(
    networkFingerprint: string,
  ): Promise<AuthFailureRecord | null>;
  readActiveAuthFailure(
    networkFingerprint: string,
    nowMs: number,
  ): Promise<AuthFailureRecord | null>;
  recordAuthFailure(record: AuthFailureRecord): Promise<AuthFailureRecord>;
  recordAuthFailureAttempt(
    input: AuthFailureAttempt,
  ): Promise<AuthFailureRecord>;

  createExecution(record: DemoExecutionRecord): Promise<void>;
  readExecution(executionId: string): Promise<DemoExecutionRecord | null>;
  readOwnedExecution(
    executionId: string,
    sessionTokenDigest: string,
  ): Promise<DemoExecutionRecord | null>;
  updateExecution(
    record: DemoExecutionRecord,
    guard: DemoExecutionUpdateGuard,
  ): Promise<DemoExecutionRecord>;
  attachArtifact(
    executionId: string,
    kind: "EVALUATION_PACK" | "CLEANUP_RECEIPT",
    reference: DemoArtifactReference,
    guard: DemoExecutionArtifactGuard,
  ): Promise<DemoExecutionRecord>;

  saveHumanReview(
    record: DemoHumanReviewRecord,
    expectedSourceHash?: string,
  ): Promise<void>;
  readHumanReviews(executionId: string): Promise<readonly DemoHumanReviewRecord[]>;
  saveSelection(
    record: DemoCandidateSelectionRecord,
    expectedSourceHash?: string,
  ): Promise<void>;
  readSelection(executionId: string): Promise<DemoCandidateSelectionRecord | null>;
  saveMemoState(
    record: DemoDecisionMemoRecord,
    expectedSourceHash?: string,
  ): Promise<void>;
  readMemoState(executionId: string): Promise<DemoDecisionMemoRecord | null>;
  confirmHumanReviews(input: DemoHumanReviewTransition): Promise<boolean>;
  recordCandidateSelection(
    input: DemoCandidateSelectionTransition,
  ): Promise<boolean>;
  beginDecisionMemo(input: DemoDecisionMemoTransition): Promise<boolean>;
  completeDecisionMemo(input: DemoDecisionMemoTransition): Promise<boolean>;
  reserveAuxiliaryCallAttempt(
    input: DemoAuxiliaryCallReservation,
  ): Promise<DemoAuxiliaryCallReservationResult>;
  completeAuxiliaryCallAttempt(
    input: DemoAuxiliaryCallCompletion,
  ): Promise<boolean>;
  readAuxiliaryCallAttempt(
    executionId: string,
    kind: DemoAuxiliaryCallKind,
    attemptNumber: 1 | 2,
  ): Promise<DemoAuxiliaryCallAttemptRecord | null>;
}

export interface DemoArtifactStore {
  putContentAddressed(input: {
    readonly namespace: DemoArtifactNamespace;
    readonly canonicalBytes: Uint8Array;
    readonly sha256: string;
  }): Promise<DemoArtifactReference>;
  getVerified(reference: DemoArtifactReference): Promise<Uint8Array>;
}

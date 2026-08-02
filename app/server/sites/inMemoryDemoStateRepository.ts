import type {
  DemoAuxiliaryCallAttemptRecord,
  DemoAuxiliaryCallCompletion,
  DemoAuxiliaryCallKind,
  DemoAuxiliaryCallReservation,
  DemoAuxiliaryCallReservationResult,
  AuthFailureAttempt,
  AuthFailureRecord,
  DemoArtifactReference,
  DemoCandidateSelectionRecord,
  DemoCandidateSelectionTransition,
  DemoDecisionMemoRecord,
  DemoDecisionMemoTransition,
  DemoExecutionArtifactGuard,
  DemoExecutionRecord,
  DemoExecutionUpdateGuard,
  DemoHumanReviewRecord,
  DemoHumanReviewTransition,
  DemoSessionRecord,
  DemoStateRepository,
} from "./demoContracts";
import type {
  DemoExecutionClaimOptions,
  DemoExecutionCostReconciliation,
} from "./d1DemoStateRepository";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function authFailureKey(
  networkFingerprint: string,
  bucketStartedAtMs: number,
): string {
  return `${networkFingerprint}:${bucketStartedAtMs}`;
}

function reviewKey(executionId: string, blindLabel: string): string {
  return `${executionId}:${blindLabel}`;
}

function auxiliaryAttemptKey(
  executionId: string,
  kind: DemoAuxiliaryCallKind,
  attemptNumber: 1 | 2,
): string {
  return `${executionId}:${kind}:${attemptNumber}`;
}

function isExpectedAuxiliaryStage(
  input: DemoAuxiliaryCallReservation,
): boolean {
  if (input.kind === "JUDGE") {
    return input.expectedStatus === "RESULTS_READY"
      && input.expectedProgressStep === (
        input.attemptNumber === 1
          ? "JUDGE_RUNNING"
          : "JUDGE_RETRY_RUNNING"
      );
  }
  return input.expectedStatus === "MEMO_RUNNING"
    && input.expectedProgressStep === "MEMO_RUNNING";
}

/**
 * 인증·router 단위 테스트 전용 fake입니다. D1의 동시성, transaction 또는
 * durability 의미를 제공하거나 주장하지 않습니다.
 */
export class InMemoryDemoStateRepository implements DemoStateRepository {
  readonly #sessions = new Map<string, DemoSessionRecord>();
  readonly #authFailures = new Map<string, AuthFailureRecord>();
  readonly #executions = new Map<string, DemoExecutionRecord>();
  readonly #reviews = new Map<string, DemoHumanReviewRecord>();
  readonly #selections = new Map<string, DemoCandidateSelectionRecord>();
  readonly #memos = new Map<string, DemoDecisionMemoRecord>();
  readonly #claims = new Map<string, DemoExecutionClaimOptions>();
  readonly #auxiliaryAttempts =
    new Map<string, DemoAuxiliaryCallAttemptRecord>();

  async createSession(record: DemoSessionRecord): Promise<void> {
    if (this.#sessions.has(record.sessionTokenDigest)) {
      throw new Error("SESSION_ALREADY_EXISTS");
    }
    this.#sessions.set(record.sessionTokenDigest, copy(record));
  }

  async readSession(
    sessionTokenDigest: string,
  ): Promise<DemoSessionRecord | null> {
    const value = this.#sessions.get(sessionTokenDigest);
    return value ? copy(value) : null;
  }

  async revokeSession(
    sessionTokenDigest: string,
    revokedAtMs: number,
  ): Promise<boolean> {
    const value = this.#sessions.get(sessionTokenDigest);
    if (!value) return false;
    this.#sessions.set(sessionTokenDigest, {
      ...value,
      revokedAtMs,
    });
    return true;
  }

  async readAuthFailure(
    networkFingerprint: string,
    bucketStartedAtMs: number,
  ): Promise<AuthFailureRecord | null> {
    const value = this.#authFailures.get(
      authFailureKey(networkFingerprint, bucketStartedAtMs),
    );
    return value ? copy(value) : null;
  }

  async readLatestAuthFailure(
    networkFingerprint: string,
  ): Promise<AuthFailureRecord | null> {
    const value = [...this.#authFailures.values()]
      .filter((record) => record.networkFingerprint === networkFingerprint)
      .sort((left, right) => right.bucketStartedAtMs - left.bucketStartedAtMs)[0];
    return value ? copy(value) : null;
  }

  async readActiveAuthFailure(
    networkFingerprint: string,
    nowMs: number,
  ): Promise<AuthFailureRecord | null> {
    const value = [...this.#authFailures.values()]
      .filter((record) => (
        record.networkFingerprint === networkFingerprint
        && record.blockedUntilMs !== null
        && record.blockedUntilMs > nowMs
      ))
      .sort(
        (left, right) => (
          (right.blockedUntilMs ?? 0) - (left.blockedUntilMs ?? 0)
        ),
      )[0];
    return value ? copy(value) : null;
  }

  async recordAuthFailure(
    record: AuthFailureRecord,
  ): Promise<AuthFailureRecord> {
    this.#authFailures.set(
      authFailureKey(record.networkFingerprint, record.bucketStartedAtMs),
      copy(record),
    );
    return copy(record);
  }

  async recordAuthFailureAttempt(
    input: AuthFailureAttempt,
  ): Promise<AuthFailureRecord> {
    const key = authFailureKey(
      input.networkFingerprint,
      input.bucketStartedAtMs,
    );
    const previous = this.#authFailures.get(key);
    const failureCount = (previous?.failureCount ?? 0) + 1;
    const existingBlock = previous?.blockedUntilMs;
    const blockedUntilMs = existingBlock !== null
      && existingBlock !== undefined
      && existingBlock > input.attemptedAtMs
      ? existingBlock
      : failureCount >= input.failureLimit
        ? input.attemptedAtMs + input.blockDurationMs
        : existingBlock ?? null;
    const record: AuthFailureRecord = {
      networkFingerprint: input.networkFingerprint,
      bucketStartedAtMs: input.bucketStartedAtMs,
      failureCount,
      blockedUntilMs,
    };
    this.#authFailures.set(key, record);
    return copy(record);
  }

  async createExecution(record: DemoExecutionRecord): Promise<void> {
    if (this.#executions.has(record.executionId)) {
      throw new Error("EXECUTION_ALREADY_EXISTS");
    }
    if ([...this.#executions.values()].some((item) => (
      item.idempotencyKey === record.idempotencyKey
    ))) {
      throw new Error("IDEMPOTENCY_KEY_ALREADY_EXISTS");
    }
    const owner = this.#sessions.get(record.sessionTokenDigest);
    if (
      !owner
      || owner.revokedAtMs !== null
      || owner.expiresAtMs <= record.createdAtMs
    ) {
      throw new Error("SESSION_NOT_ACTIVE");
    }
    this.#executions.set(record.executionId, copy(record));
    this.#sessions.set(record.sessionTokenDigest, {
      ...owner,
      currentExecutionId: record.executionId,
    });
  }

  async readExecution(
    executionId: string,
  ): Promise<DemoExecutionRecord | null> {
    const value = this.#executions.get(executionId);
    return value ? copy(value) : null;
  }

  async readOwnedExecution(
    executionId: string,
    sessionTokenDigest: string,
  ): Promise<DemoExecutionRecord | null> {
    const value = this.#executions.get(executionId);
    return value?.sessionTokenDigest === sessionTokenDigest
      ? copy(value)
      : null;
  }

  async updateExecution(
    record: DemoExecutionRecord,
    guard: DemoExecutionUpdateGuard,
  ): Promise<DemoExecutionRecord> {
    const current = this.#executions.get(record.executionId);
    if (
      !current
      || current.sessionTokenDigest !== record.sessionTokenDigest
      || current.sourceHash !== guard.expectedSourceHash
      || current.stateVersion !== guard.expectedStateVersion
      || current.status !== guard.expectedStatus
      || record.stateVersion !== guard.expectedStateVersion
    ) {
      throw new Error("STALE_EXECUTION_STATE");
    }
    const updated = {
      ...copy(record),
      stateVersion: current.stateVersion + 1,
    };
    this.#executions.set(record.executionId, updated);
    return copy(updated);
  }

  async attachArtifact(
    executionId: string,
    kind: "EVALUATION_PACK" | "CLEANUP_RECEIPT",
    reference: DemoArtifactReference,
    guard: DemoExecutionArtifactGuard,
  ): Promise<DemoExecutionRecord> {
    const value = this.#executions.get(executionId);
    if (
      !value
      || value.sessionTokenDigest !== guard.sessionTokenDigest
      || value.sourceHash !== guard.expectedSourceHash
      || value.stateVersion !== guard.expectedStateVersion
      || value.status !== guard.expectedStatus
    ) {
      throw new Error("STALE_EXECUTION_STATE");
    }
    const updated = {
      ...value,
      ...(kind === "EVALUATION_PACK"
        ? { evaluationPackReference: copy(reference) }
        : { cleanupReceiptReference: copy(reference) }),
      stateVersion: value.stateVersion + 1,
    };
    this.#executions.set(executionId, updated);
    return copy(updated);
  }

  async saveHumanReview(record: DemoHumanReviewRecord): Promise<void> {
    this.#reviews.set(
      reviewKey(record.executionId, record.blindLabel),
      copy(record),
    );
  }

  async readHumanReviews(
    executionId: string,
  ): Promise<readonly DemoHumanReviewRecord[]> {
    return [...this.#reviews.values()]
      .filter((value) => value.executionId === executionId)
      .sort((left, right) => left.blindLabel.localeCompare(right.blindLabel))
      .map(copy);
  }

  async saveSelection(record: DemoCandidateSelectionRecord): Promise<void> {
    this.#selections.set(record.executionId, copy(record));
  }

  async readSelection(
    executionId: string,
  ): Promise<DemoCandidateSelectionRecord | null> {
    const value = this.#selections.get(executionId);
    return value ? copy(value) : null;
  }

  async saveMemoState(record: DemoDecisionMemoRecord): Promise<void> {
    this.#memos.set(record.executionId, copy(record));
  }

  async readMemoState(
    executionId: string,
  ): Promise<DemoDecisionMemoRecord | null> {
    const value = this.#memos.get(executionId);
    return value ? copy(value) : null;
  }

  async confirmHumanReviews(
    input: DemoHumanReviewTransition,
  ): Promise<boolean> {
    const execution = this.#executions.get(input.executionId);
    if (
      !execution
      || execution.sessionTokenDigest !== input.sessionTokenDigest
      || execution.sourceHash !== input.expectedSourceHash
      || execution.stateVersion !== input.expectedStateVersion
      || execution.status !== "JUDGE_READY"
    ) {
      return false;
    }
    for (const review of input.reviews) {
      this.#reviews.set(
        reviewKey(review.executionId, review.blindLabel),
        copy(review),
      );
    }
    this.#executions.set(input.executionId, {
      ...execution,
      status: input.nextStatus,
      progressStep: input.nextStatus,
      publicProjectionReference: copy(input.publicProjectionReference),
      stateVersion: execution.stateVersion + 1,
    });
    return true;
  }

  async recordCandidateSelection(
    input: DemoCandidateSelectionTransition,
  ): Promise<boolean> {
    const execution = this.#executions.get(input.executionId);
    if (
      !execution
      || execution.sessionTokenDigest !== input.sessionTokenDigest
      || execution.sourceHash !== input.expectedSourceHash
      || execution.stateVersion !== input.expectedStateVersion
      || execution.status !== "REVIEW_READY"
      || input.selection.executionId !== input.executionId
      || input.selection.sourceHash !== input.expectedSourceHash
    ) {
      return false;
    }
    this.#selections.set(input.executionId, copy(input.selection));
    this.#executions.set(input.executionId, {
      ...execution,
      status: "SELECTION_RECORDED",
      progressStep: "SELECTION_RECORDED",
      publicProjectionReference: copy(input.publicProjectionReference),
      stateVersion: execution.stateVersion + 1,
    });
    return true;
  }

  async beginDecisionMemo(
    input: DemoDecisionMemoTransition,
  ): Promise<boolean> {
    const execution = this.#executions.get(input.executionId);
    if (
      !execution
      || execution.sessionTokenDigest !== input.sessionTokenDigest
      || execution.sourceHash !== input.expectedSourceHash
      || execution.stateVersion !== input.expectedStateVersion
      || (
        execution.status !== "SELECTION_RECORDED"
        && execution.status !== "MEMO_FAILED"
      )
      || input.memo.status !== "RUNNING"
      || input.memo.executionId !== input.executionId
      || input.memo.sourcePackHash !== input.expectedSourceHash
    ) {
      return false;
    }
    this.#memos.set(input.executionId, copy(input.memo));
    this.#executions.set(input.executionId, {
      ...execution,
      status: "MEMO_RUNNING",
      progressStep: "MEMO_RUNNING",
      publicProjectionReference: copy(input.publicProjectionReference),
      stateVersion: execution.stateVersion + 1,
    });
    return true;
  }

  async completeDecisionMemo(
    input: DemoDecisionMemoTransition,
  ): Promise<boolean> {
    const execution = this.#executions.get(input.executionId);
    const currentMemo = this.#memos.get(input.executionId);
    if (
      !execution
      || execution.sessionTokenDigest !== input.sessionTokenDigest
      || execution.sourceHash !== input.expectedSourceHash
      || execution.stateVersion !== input.expectedStateVersion
      || execution.status !== "MEMO_RUNNING"
      || currentMemo?.status !== "RUNNING"
      || (
        input.memo.status !== "READY"
        && input.memo.status !== "FAILED"
      )
      || input.memo.executionId !== input.executionId
      || input.memo.sourcePackHash !== currentMemo.sourcePackHash
      || input.memo.reviewHash !== currentMemo.reviewHash
      || input.memo.selectionHash !== currentMemo.selectionHash
    ) {
      return false;
    }
    const status = input.memo.status === "READY"
      ? "MEMO_READY"
      : "MEMO_FAILED";
    this.#memos.set(input.executionId, copy(input.memo));
    this.#executions.set(input.executionId, {
      ...execution,
      status,
      progressStep: status,
      publicProjectionReference: copy(input.publicProjectionReference),
      stateVersion: execution.stateVersion + 1,
    });
    return true;
  }

  async reserveAuxiliaryCallAttempt(
    input: DemoAuxiliaryCallReservation,
  ): Promise<DemoAuxiliaryCallReservationResult> {
    const execution = this.#executions.get(input.executionId);
    const session = this.#sessions.get(input.sessionTokenDigest);
    if (
      !isExpectedAuxiliaryStage(input)
      || !execution
      || !session
      || execution.sessionTokenDigest !== input.sessionTokenDigest
      || execution.sourceHash !== input.expectedSourceHash
      || execution.stateVersion !== input.expectedStateVersion
      || execution.status !== input.expectedStatus
      || execution.progressStep !== input.expectedProgressStep
      || session.currentExecutionId !== input.executionId
      || session.revokedAtMs !== null
      || session.expiresAtMs <= input.reservedAtMs
    ) {
      return { outcome: "STALE" };
    }
    const key = auxiliaryAttemptKey(
      input.executionId,
      input.kind,
      input.attemptNumber,
    );
    if (this.#auxiliaryAttempts.has(key)) {
      return { outcome: "ALREADY_RESERVED" };
    }
    const bucketAttemptCount = [...this.#auxiliaryAttempts.values()].filter(
      (attempt) => attempt.bucketStartedAtMs === input.bucketStartedAtMs,
    ).length;
    if (bucketAttemptCount >= input.maxAttemptsPerBucket) {
      return { outcome: "LIMIT_REACHED" };
    }
    const attempt: DemoAuxiliaryCallAttemptRecord = {
      executionId: input.executionId,
      sessionTokenDigest: input.sessionTokenDigest,
      kind: input.kind,
      attemptNumber: input.attemptNumber,
      sourceHash: input.expectedSourceHash,
      reservedStateVersion: input.expectedStateVersion,
      bucketStartedAtMs: input.bucketStartedAtMs,
      status: "RESERVED",
      reservedAtMs: input.reservedAtMs,
      completedAtMs: null,
      errorCode: null,
    };
    this.#auxiliaryAttempts.set(key, attempt);
    return {
      outcome: "RESERVED",
      attempt: copy(attempt),
    };
  }

  async completeAuxiliaryCallAttempt(
    input: DemoAuxiliaryCallCompletion,
  ): Promise<boolean> {
    const key = auxiliaryAttemptKey(
      input.executionId,
      input.kind,
      input.attemptNumber,
    );
    const attempt = this.#auxiliaryAttempts.get(key);
    const execution = this.#executions.get(input.executionId);
    const session = this.#sessions.get(input.sessionTokenDigest);
    if (
      !attempt
      || attempt.status !== "RESERVED"
      || attempt.sessionTokenDigest !== input.sessionTokenDigest
      || attempt.sourceHash !== input.expectedSourceHash
      || attempt.reservedStateVersion !== input.expectedStateVersion
      || !execution
      || execution.sessionTokenDigest !== input.sessionTokenDigest
      || execution.sourceHash !== input.expectedSourceHash
      || execution.stateVersion !== input.expectedStateVersion
      || session?.currentExecutionId !== input.executionId
      || input.completedAtMs < attempt.reservedAtMs
      || (input.outcome === "COMPLETE" && input.errorCode !== null)
      || (input.outcome === "FAILED" && !input.errorCode)
    ) {
      return false;
    }
    this.#auxiliaryAttempts.set(key, {
      ...attempt,
      status: input.outcome,
      completedAtMs: input.completedAtMs,
      errorCode: input.errorCode,
    });
    return true;
  }

  async readAuxiliaryCallAttempt(
    executionId: string,
    kind: DemoAuxiliaryCallKind,
    attemptNumber: 1 | 2,
  ): Promise<DemoAuxiliaryCallAttemptRecord | null> {
    const attempt = this.#auxiliaryAttempts.get(
      auxiliaryAttemptKey(executionId, kind, attemptNumber),
    );
    return attempt ? copy(attempt) : null;
  }

  async claimExecution(
    input: DemoExecutionClaimOptions,
  ): Promise<DemoExecutionRecord | null> {
    const execution = this.#executions.get(input.executionId);
    const owner = this.#sessions.get(input.sessionTokenDigest);
    const runningCount = [...this.#executions.values()].filter(
      (record) => record.status === "RUNNING",
    ).length;
    if (
      !execution
      || !owner
      || execution.sessionTokenDigest !== input.sessionTokenDigest
      || execution.sourceHash !== input.expectedSourceHash
      || execution.stateVersion !== input.expectedStateVersion
      || execution.status !== "READY"
      || owner.revokedAtMs !== null
      || owner.expiresAtMs <= input.nowMs
      || owner.successfulLiveRuns >= input.maxSuccessfulRunsPerSession
      || (
        input.isOperationalRetry
        && owner.operationalRetryCount
          >= input.maxOperationalRetriesPerSession
      )
      || (
        owner.currentExecutionId !== null
        && owner.currentExecutionId !== input.executionId
      )
      || runningCount >= input.maxGlobalConcurrentRuns
    ) {
      return null;
    }
    const updated: DemoExecutionRecord = {
      ...execution,
      status: "RUNNING",
      startedAtMs: input.nowMs,
      heartbeatAtMs: input.nowMs,
      stateVersion: execution.stateVersion + 1,
    };
    this.#executions.set(input.executionId, updated);
    this.#claims.set(input.executionId, copy(input));
    this.#sessions.set(input.sessionTokenDigest, {
      ...owner,
      currentExecutionId: input.executionId,
      operationalRetryCount: owner.operationalRetryCount
        + (input.isOperationalRetry ? 1 : 0),
    });
    return copy(updated);
  }

  async reconcileExecutionCost(
    input: DemoExecutionCostReconciliation,
  ): Promise<boolean> {
    const execution = this.#executions.get(input.executionId);
    const owner = this.#sessions.get(input.sessionTokenDigest);
    const claim = this.#claims.get(input.executionId);
    if (
      !execution
      || !owner
      || !claim
      || execution.sessionTokenDigest !== input.sessionTokenDigest
      || execution.sourceHash !== input.expectedSourceHash
      || execution.stateVersion !== input.expectedStateVersion
      || execution.status !== "RUNNING"
      || claim.leaseTokenDigest !== input.leaseTokenDigest
      || claim.leaseExpiresAtMs <= input.nowMs
      || claim.budgetBucketStartedAtMs !== input.budgetBucketStartedAtMs
      || claim.reservedCostMicroUsd !== input.reservedCostMicroUsd
    ) {
      return false;
    }
    const status = input.completedSuccessfully ? "RESULTS_READY" : "FAILED";
    this.#executions.set(input.executionId, {
      ...execution,
      status,
      completedAtMs: input.nowMs,
      heartbeatAtMs: input.nowMs,
      actualCostMicroUsd: input.actualCostMicroUsd,
      errorCode: input.completedSuccessfully
        ? execution.errorCode
        : execution.errorCode ?? "OPERATIONAL_FAILURE",
      stateVersion: execution.stateVersion + 1,
    });
    this.#sessions.set(input.sessionTokenDigest, {
      ...owner,
      successfulLiveRuns: owner.successfulLiveRuns
        + (input.completedSuccessfully ? 1 : 0),
      currentExecutionId: input.executionId,
    });
    this.#claims.delete(input.executionId);
    return true;
  }

  async interruptStaleExecutions(input: {
    readonly nowMs: number;
    readonly staleBeforeMs: number;
  }): Promise<number> {
    let interruptedCount = 0;
    for (const [executionId, execution] of this.#executions) {
      const claim = this.#claims.get(executionId);
      const heartbeatAtMs = execution.heartbeatAtMs
        ?? execution.startedAtMs
        ?? execution.createdAtMs;
      if (
        execution.status !== "RUNNING"
        || (
          heartbeatAtMs > input.staleBeforeMs
          && (claim === undefined || claim.leaseExpiresAtMs > input.nowMs)
        )
      ) {
        continue;
      }
      this.#executions.set(executionId, {
        ...execution,
        status: "INTERRUPTED",
        completedAtMs: input.nowMs,
        errorCode: "STALE_HEARTBEAT",
        stateVersion: execution.stateVersion + 1,
      });
      interruptedCount += 1;
    }
    return interruptedCount;
  }

  inspectSessionsForTest(): readonly DemoSessionRecord[] {
    return [...this.#sessions.values()].map(copy);
  }

  inspectAuthFailuresForTest(): readonly AuthFailureRecord[] {
    return [...this.#authFailures.values()].map(copy);
  }
}

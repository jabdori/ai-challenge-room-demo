import type { AnyD1Database } from "drizzle-orm/d1";
import type {
  AuthFailureAttempt,
  AuthFailureRecord,
  DemoAuxiliaryCallAttemptRecord,
  DemoAuxiliaryCallCompletion,
  DemoAuxiliaryCallKind,
  DemoAuxiliaryCallReservation,
  DemoAuxiliaryCallReservationResult,
  DemoArtifactNamespace,
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

export interface DemoExecutionClaimOptions {
  readonly executionId: string;
  readonly sessionTokenDigest: string;
  readonly expectedSourceHash: string;
  readonly expectedStateVersion: number;
  readonly leaseTokenDigest: string;
  readonly nowMs: number;
  readonly leaseExpiresAtMs: number;
  readonly budgetBucketStartedAtMs: number;
  readonly reservedCostMicroUsd: number;
  readonly maxSuccessfulRunsPerSession: number;
  readonly maxOperationalRetriesPerSession: number;
  readonly maxGlobalConcurrentRuns: number;
  readonly maxBucketRunCount: number;
  readonly maxBucketCostMicroUsd: number;
  readonly isOperationalRetry: boolean;
}

export interface DemoExecutionCostReconciliation {
  readonly executionId: string;
  readonly sessionTokenDigest: string;
  readonly expectedSourceHash: string;
  readonly expectedStateVersion: number;
  readonly leaseTokenDigest: string;
  readonly reconciliationToken: string;
  readonly budgetBucketStartedAtMs: number;
  readonly reservedCostMicroUsd: number;
  readonly actualCostMicroUsd: number;
  readonly failedRequestCostMicroUsd: number;
  readonly completedSuccessfully: boolean;
  readonly nowMs: number;
}

export interface DemoUsageBudgetRecord {
  readonly bucketStartedAtMs: number;
  readonly reservedRunCount: number;
  readonly confirmedRunCount: number;
  readonly reservedCostMicroUsd: number;
  readonly confirmedCostMicroUsd: number;
  readonly failedRequestCostMicroUsd: number;
  readonly updatedAtMs: number;
}

interface SessionRow {
  session_token_digest: string;
  created_at_ms: number;
  expires_at_ms: number;
  revoked_at_ms: number | null;
  successful_live_runs: number;
  operational_retry_count: number;
  current_execution_id: string | null;
}

interface AuthFailureRow {
  network_fingerprint: string;
  bucket_started_at_ms: number;
  failure_count: number;
  blocked_until_ms: number | null;
}

interface ExecutionRow {
  execution_id: string;
  session_token_digest: string;
  idempotency_key: string;
  source: DemoExecutionRecord["source"];
  status: DemoExecutionRecord["status"];
  progress_step: string;
  current_candidate: DemoExecutionRecord["currentCandidate"];
  completed_candidate_count: number;
  created_at_ms: number;
  started_at_ms: number | null;
  heartbeat_at_ms: number | null;
  completed_at_ms: number | null;
  retry_count: number;
  error_code: string | null;
  cleanup_status: DemoExecutionRecord["cleanupStatus"];
  evaluation_pack_namespace: DemoArtifactNamespace | null;
  evaluation_pack_object_key: string | null;
  evaluation_pack_sha256: string | null;
  evaluation_pack_byte_length: number | null;
  public_projection_namespace: DemoArtifactNamespace | null;
  public_projection_object_key: string | null;
  public_projection_sha256: string | null;
  public_projection_byte_length: number | null;
  cleanup_receipt_namespace: DemoArtifactNamespace | null;
  cleanup_receipt_object_key: string | null;
  cleanup_receipt_sha256: string | null;
  cleanup_receipt_byte_length: number | null;
  actual_cost_micro_usd: number;
  source_hash: string;
  state_version: number;
}

interface HumanReviewRow {
  execution_id: string;
  blind_label: DemoHumanReviewRecord["blindLabel"];
  decision: DemoHumanReviewRecord["decision"];
  rationale: string;
  corrected_reply: string | null;
  review_duration_ms: number;
  edit_duration_ms: number;
  confirmed_at_ms: number;
}

interface SelectionRow {
  execution_id: string;
  candidate_id: DemoCandidateSelectionRecord["candidateId"];
  rationale: string;
  source_hash: string;
  selected_at_ms: number;
}

interface MemoRow {
  execution_id: string;
  status: DemoDecisionMemoRecord["status"];
  source_pack_hash: string;
  review_hash: string | null;
  selection_hash: string | null;
  artifact_namespace: DemoArtifactNamespace | null;
  artifact_object_key: string | null;
  artifact_sha256: string | null;
  artifact_byte_length: number | null;
  error_code: string | null;
  reconciliation_reason: string | null;
  updated_at_ms: number;
}

interface UsageBudgetRow {
  bucket_started_at_ms: number;
  reserved_run_count: number;
  confirmed_run_count: number;
  reserved_cost_micro_usd: number;
  confirmed_cost_micro_usd: number;
  failed_request_cost_micro_usd: number;
  updated_at_ms: number;
}

interface AuxiliaryCallAttemptRow {
  execution_id: string;
  session_token_digest: string;
  kind: DemoAuxiliaryCallKind;
  attempt_number: 1 | 2;
  source_hash: string;
  reserved_state_version: number;
  bucket_started_at_ms: number;
  status: DemoAuxiliaryCallAttemptRecord["status"];
  reserved_at_ms: number;
  completed_at_ms: number | null;
  error_code: string | null;
}

const EXECUTION_COLUMNS = `
  execution_id,
  session_token_digest,
  idempotency_key,
  source,
  status,
  progress_step,
  current_candidate,
  completed_candidate_count,
  created_at_ms,
  started_at_ms,
  heartbeat_at_ms,
  completed_at_ms,
  retry_count,
  error_code,
  cleanup_status,
  evaluation_pack_namespace,
  evaluation_pack_object_key,
  evaluation_pack_sha256,
  evaluation_pack_byte_length,
  public_projection_namespace,
  public_projection_object_key,
  public_projection_sha256,
  public_projection_byte_length,
  cleanup_receipt_namespace,
  cleanup_receipt_object_key,
  cleanup_receipt_sha256,
  cleanup_receipt_byte_length,
  actual_cost_micro_usd,
  source_hash,
  state_version
`;

function nonnegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} 값은 0 이상의 안전한 정수여야 합니다.`);
  }
}

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} 값은 1 이상의 안전한 정수여야 합니다.`);
  }
}

function nonempty(value: string, name: string): void {
  if (value.length < 1 || value.length > 1_024 || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${name} 값이 저장 계약을 벗어났습니다.`);
  }
}

function changes(result: { readonly meta: { readonly changes?: number } }): number {
  return result.meta.changes ?? 0;
}

function sessionFromRow(row: SessionRow): DemoSessionRecord {
  return {
    sessionTokenDigest: row.session_token_digest,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    revokedAtMs: row.revoked_at_ms,
    successfulLiveRuns: row.successful_live_runs,
    operationalRetryCount: row.operational_retry_count,
    currentExecutionId: row.current_execution_id,
  };
}

function authFailureFromRow(row: AuthFailureRow): AuthFailureRecord {
  return {
    networkFingerprint: row.network_fingerprint,
    bucketStartedAtMs: row.bucket_started_at_ms,
    failureCount: row.failure_count,
    blockedUntilMs: row.blocked_until_ms,
  };
}

function artifactFromColumns(input: {
  readonly namespace: DemoArtifactNamespace | null;
  readonly objectKey: string | null;
  readonly sha256: string | null;
  readonly byteLength: number | null;
}): DemoArtifactReference | null {
  const values = [
    input.namespace,
    input.objectKey,
    input.sha256,
    input.byteLength,
  ];
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) {
    throw new Error("CORRUPT_ARTIFACT_REFERENCE");
  }
  return {
    namespace: input.namespace as DemoArtifactNamespace,
    objectKey: input.objectKey as string,
    sha256: input.sha256 as string,
    byteLength: input.byteLength as number,
  };
}

function executionFromRow(row: ExecutionRow): DemoExecutionRecord {
  return {
    executionId: row.execution_id,
    sessionTokenDigest: row.session_token_digest,
    idempotencyKey: row.idempotency_key,
    source: row.source,
    status: row.status,
    progressStep: row.progress_step,
    currentCandidate: row.current_candidate,
    completedCandidateCount: row.completed_candidate_count,
    createdAtMs: row.created_at_ms,
    startedAtMs: row.started_at_ms,
    heartbeatAtMs: row.heartbeat_at_ms,
    completedAtMs: row.completed_at_ms,
    retryCount: row.retry_count,
    errorCode: row.error_code,
    cleanupStatus: row.cleanup_status,
    evaluationPackReference: artifactFromColumns({
      namespace: row.evaluation_pack_namespace,
      objectKey: row.evaluation_pack_object_key,
      sha256: row.evaluation_pack_sha256,
      byteLength: row.evaluation_pack_byte_length,
    }),
    publicProjectionReference: artifactFromColumns({
      namespace: row.public_projection_namespace,
      objectKey: row.public_projection_object_key,
      sha256: row.public_projection_sha256,
      byteLength: row.public_projection_byte_length,
    }),
    cleanupReceiptReference: artifactFromColumns({
      namespace: row.cleanup_receipt_namespace,
      objectKey: row.cleanup_receipt_object_key,
      sha256: row.cleanup_receipt_sha256,
      byteLength: row.cleanup_receipt_byte_length,
    }),
    actualCostMicroUsd: row.actual_cost_micro_usd,
    sourceHash: row.source_hash,
    stateVersion: row.state_version,
  };
}

function reviewFromRow(row: HumanReviewRow): DemoHumanReviewRecord {
  return {
    executionId: row.execution_id,
    blindLabel: row.blind_label,
    decision: row.decision,
    rationale: row.rationale,
    correctedReply: row.corrected_reply,
    reviewDurationMs: row.review_duration_ms,
    editDurationMs: row.edit_duration_ms,
    confirmedAtMs: row.confirmed_at_ms,
  };
}

function selectionFromRow(row: SelectionRow): DemoCandidateSelectionRecord {
  return {
    executionId: row.execution_id,
    candidateId: row.candidate_id,
    rationale: row.rationale,
    sourceHash: row.source_hash,
    selectedAtMs: row.selected_at_ms,
  };
}

function memoFromRow(row: MemoRow): DemoDecisionMemoRecord {
  return {
    executionId: row.execution_id,
    status: row.status,
    sourcePackHash: row.source_pack_hash,
    reviewHash: row.review_hash,
    selectionHash: row.selection_hash,
    artifactReference: artifactFromColumns({
      namespace: row.artifact_namespace,
      objectKey: row.artifact_object_key,
      sha256: row.artifact_sha256,
      byteLength: row.artifact_byte_length,
    }),
    errorCode: row.error_code,
    reconciliationReason: row.reconciliation_reason,
    updatedAtMs: row.updated_at_ms,
  };
}

function usageBudgetFromRow(row: UsageBudgetRow): DemoUsageBudgetRecord {
  return {
    bucketStartedAtMs: row.bucket_started_at_ms,
    reservedRunCount: row.reserved_run_count,
    confirmedRunCount: row.confirmed_run_count,
    reservedCostMicroUsd: row.reserved_cost_micro_usd,
    confirmedCostMicroUsd: row.confirmed_cost_micro_usd,
    failedRequestCostMicroUsd: row.failed_request_cost_micro_usd,
    updatedAtMs: row.updated_at_ms,
  };
}

function auxiliaryCallAttemptFromRow(
  row: AuxiliaryCallAttemptRow,
): DemoAuxiliaryCallAttemptRecord {
  return {
    executionId: row.execution_id,
    sessionTokenDigest: row.session_token_digest,
    kind: row.kind,
    attemptNumber: row.attempt_number,
    sourceHash: row.source_hash,
    reservedStateVersion: row.reserved_state_version,
    bucketStartedAtMs: row.bucket_started_at_ms,
    status: row.status,
    reservedAtMs: row.reserved_at_ms,
    completedAtMs: row.completed_at_ms,
    errorCode: row.error_code,
  };
}

const AUXILIARY_CALL_ATTEMPT_COLUMNS = `
  execution_id,
  session_token_digest,
  kind,
  attempt_number,
  source_hash,
  reserved_state_version,
  bucket_started_at_ms,
  status,
  reserved_at_ms,
  completed_at_ms,
  error_code
`;

function artifactValues(reference: DemoArtifactReference | null): readonly [
  string | null,
  string | null,
  string | null,
  number | null,
] {
  return reference
    ? [
      reference.namespace,
      reference.objectKey,
      reference.sha256,
      reference.byteLength,
    ]
    : [null, null, null, null];
}

/**
 * 심사 데모의 인증·진행·사람 결정 상태를 D1에 저장하는 권위 adapter입니다.
 * 실행기 내부의 원격 리소스 식별자는 이 public projection에 포함하지 않습니다.
 */
export class D1DemoStateRepository implements DemoStateRepository {
  readonly #db: AnyD1Database;

  constructor(db: AnyD1Database) {
    this.#db = db;
  }

  async createSession(record: DemoSessionRecord): Promise<void> {
    await this.#db.prepare(`
      INSERT INTO demo_sessions (
        session_token_digest,
        created_at_ms,
        expires_at_ms,
        revoked_at_ms,
        successful_live_runs,
        operational_retry_count,
        current_execution_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      record.sessionTokenDigest,
      record.createdAtMs,
      record.expiresAtMs,
      record.revokedAtMs,
      record.successfulLiveRuns,
      record.operationalRetryCount,
      record.currentExecutionId,
    ).run();
  }

  async readSession(
    sessionTokenDigest: string,
  ): Promise<DemoSessionRecord | null> {
    const row = await this.#db.prepare(`
      SELECT
        session_token_digest,
        created_at_ms,
        expires_at_ms,
        revoked_at_ms,
        successful_live_runs,
        operational_retry_count,
        current_execution_id
      FROM demo_sessions
      WHERE session_token_digest = ?
    `).bind(sessionTokenDigest).first<SessionRow>();
    return row ? sessionFromRow(row) : null;
  }

  async revokeSession(
    sessionTokenDigest: string,
    revokedAtMs: number,
  ): Promise<boolean> {
    const result = await this.#db.prepare(`
      UPDATE demo_sessions
      SET revoked_at_ms = ?
      WHERE session_token_digest = ?
        AND revoked_at_ms IS NULL
    `).bind(revokedAtMs, sessionTokenDigest).run();
    return changes(result) === 1;
  }

  async readAuthFailure(
    networkFingerprint: string,
    bucketStartedAtMs: number,
  ): Promise<AuthFailureRecord | null> {
    const row = await this.#db.prepare(`
      SELECT
        network_fingerprint,
        bucket_started_at_ms,
        failure_count,
        blocked_until_ms
      FROM auth_failure_buckets
      WHERE network_fingerprint = ?
        AND bucket_started_at_ms = ?
    `).bind(
      networkFingerprint,
      bucketStartedAtMs,
    ).first<AuthFailureRow>();
    return row ? authFailureFromRow(row) : null;
  }

  async readLatestAuthFailure(
    networkFingerprint: string,
  ): Promise<AuthFailureRecord | null> {
    const row = await this.#db.prepare(`
      SELECT
        network_fingerprint,
        bucket_started_at_ms,
        failure_count,
        blocked_until_ms
      FROM auth_failure_buckets
      WHERE network_fingerprint = ?
      ORDER BY bucket_started_at_ms DESC
      LIMIT 1
    `).bind(networkFingerprint).first<AuthFailureRow>();
    return row ? authFailureFromRow(row) : null;
  }

  async readActiveAuthFailure(
    networkFingerprint: string,
    nowMs: number,
  ): Promise<AuthFailureRecord | null> {
    nonnegativeSafeInteger(nowMs, "auth active-block time");
    const row = await this.#db.prepare(`
      SELECT
        network_fingerprint,
        bucket_started_at_ms,
        failure_count,
        blocked_until_ms
      FROM auth_failure_buckets
      WHERE network_fingerprint = ?
        AND blocked_until_ms > ?
      ORDER BY blocked_until_ms DESC, bucket_started_at_ms DESC
      LIMIT 1
    `).bind(networkFingerprint, nowMs).first<AuthFailureRow>();
    return row ? authFailureFromRow(row) : null;
  }

  async recordAuthFailure(
    record: AuthFailureRecord,
  ): Promise<AuthFailureRecord> {
    await this.#db.prepare(`
      INSERT INTO auth_failure_buckets (
        network_fingerprint,
        bucket_started_at_ms,
        failure_count,
        blocked_until_ms
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT (network_fingerprint, bucket_started_at_ms)
      DO UPDATE SET
        failure_count = MAX(
          auth_failure_buckets.failure_count + 1,
          excluded.failure_count
        ),
        blocked_until_ms = CASE
          WHEN auth_failure_buckets.blocked_until_ms IS NULL
            THEN excluded.blocked_until_ms
          WHEN excluded.blocked_until_ms IS NULL
            THEN auth_failure_buckets.blocked_until_ms
          ELSE MAX(
            auth_failure_buckets.blocked_until_ms,
            excluded.blocked_until_ms
          )
        END
    `).bind(
      record.networkFingerprint,
      record.bucketStartedAtMs,
      record.failureCount,
      record.blockedUntilMs,
    ).run();
    const stored = await this.readAuthFailure(
      record.networkFingerprint,
      record.bucketStartedAtMs,
    );
    if (!stored) throw new Error("AUTH_FAILURE_WRITE_LOST");
    return stored;
  }

  async recordAuthFailureAttempt(
    input: AuthFailureAttempt,
  ): Promise<AuthFailureRecord> {
    nonempty(input.networkFingerprint, "network fingerprint");
    nonnegativeSafeInteger(input.bucketStartedAtMs, "auth bucket");
    nonnegativeSafeInteger(input.attemptedAtMs, "auth attempt time");
    positiveSafeInteger(input.failureLimit, "auth failure limit");
    positiveSafeInteger(input.blockDurationMs, "auth block duration");
    const blockedUntilMs = input.attemptedAtMs + input.blockDurationMs;
    if (!Number.isSafeInteger(blockedUntilMs)) {
      throw new TypeError("auth block 만료 시각이 안전한 범위를 벗어났습니다.");
    }
    const row = await this.#db.prepare(`
      INSERT INTO auth_failure_buckets (
        network_fingerprint,
        bucket_started_at_ms,
        failure_count,
        blocked_until_ms
      ) VALUES (?, ?, 1, ?)
      ON CONFLICT (network_fingerprint, bucket_started_at_ms)
      DO UPDATE SET
        failure_count = auth_failure_buckets.failure_count + 1,
        blocked_until_ms = CASE
          WHEN auth_failure_buckets.blocked_until_ms IS NOT NULL
            AND auth_failure_buckets.blocked_until_ms > ?
            THEN auth_failure_buckets.blocked_until_ms
          WHEN auth_failure_buckets.failure_count + 1 >= ?
            THEN ?
          ELSE auth_failure_buckets.blocked_until_ms
        END
      RETURNING
        network_fingerprint,
        bucket_started_at_ms,
        failure_count,
        blocked_until_ms
    `).bind(
      input.networkFingerprint,
      input.bucketStartedAtMs,
      input.failureLimit <= 1 ? blockedUntilMs : null,
      input.attemptedAtMs,
      input.failureLimit,
      blockedUntilMs,
    ).first<AuthFailureRow>();
    if (!row) throw new Error("AUTH_FAILURE_WRITE_LOST");
    return authFailureFromRow(row);
  }

  async createExecution(record: DemoExecutionRecord): Promise<void> {
    if (record.stateVersion !== 0) {
      throw new TypeError("새 실행의 state version은 0이어야 합니다.");
    }
    const evaluation = artifactValues(record.evaluationPackReference);
    const publicProjection = artifactValues(record.publicProjectionReference);
    const cleanup = artifactValues(record.cleanupReceiptReference);
    const results = await this.#db.batch<{ session_token_digest: string }>([
      this.#db.prepare(`
      INSERT INTO executions (
        execution_id,
        session_token_digest,
        idempotency_key,
        source,
        status,
        progress_step,
        current_candidate,
        completed_candidate_count,
        created_at_ms,
        started_at_ms,
        heartbeat_at_ms,
        completed_at_ms,
        retry_count,
        error_code,
        cleanup_status,
        evaluation_pack_namespace,
        evaluation_pack_object_key,
        evaluation_pack_sha256,
        evaluation_pack_byte_length,
        public_projection_namespace,
        public_projection_object_key,
        public_projection_sha256,
        public_projection_byte_length,
        cleanup_receipt_namespace,
        cleanup_receipt_object_key,
        cleanup_receipt_sha256,
        cleanup_receipt_byte_length,
        actual_cost_micro_usd,
        source_hash
      )
      SELECT
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM demo_sessions
      WHERE session_token_digest = ?
        AND revoked_at_ms IS NULL
        AND expires_at_ms > ?
    `).bind(
      record.executionId,
      record.sessionTokenDigest,
      record.idempotencyKey,
      record.source,
      record.status,
      record.progressStep,
      record.currentCandidate,
      record.completedCandidateCount,
      record.createdAtMs,
      record.startedAtMs,
      record.heartbeatAtMs,
      record.completedAtMs,
      record.retryCount,
      record.errorCode,
      record.cleanupStatus,
      ...evaluation,
      ...publicProjection,
      ...cleanup,
      record.actualCostMicroUsd,
      record.sourceHash,
      record.sessionTokenDigest,
      record.createdAtMs,
      ),
      this.#db.prepare(`
        UPDATE demo_sessions
        SET current_execution_id = ?
        WHERE session_token_digest = ?
          AND revoked_at_ms IS NULL
          AND expires_at_ms > ?
          AND EXISTS (
            SELECT 1
            FROM executions
            WHERE execution_id = ?
              AND session_token_digest = ?
          )
        RETURNING session_token_digest
      `).bind(
        record.executionId,
        record.sessionTokenDigest,
        record.createdAtMs,
        record.executionId,
        record.sessionTokenDigest,
      ),
    ]);
    if (
      changes(results[0]!) !== 1
      || (results[1]?.results.length ?? 0) !== 1
    ) {
      throw new Error("SESSION_NOT_ACTIVE");
    }
  }

  async readExecution(
    executionId: string,
  ): Promise<DemoExecutionRecord | null> {
    const row = await this.#db.prepare(`
      SELECT ${EXECUTION_COLUMNS}
      FROM executions
      WHERE execution_id = ?
    `).bind(executionId).first<ExecutionRow>();
    return row ? executionFromRow(row) : null;
  }

  async readOwnedExecution(
    executionId: string,
    sessionTokenDigest: string,
  ): Promise<DemoExecutionRecord | null> {
    const row = await this.#db.prepare(`
      SELECT ${EXECUTION_COLUMNS}
      FROM executions
      WHERE execution_id = ?
        AND session_token_digest = ?
    `).bind(executionId, sessionTokenDigest).first<ExecutionRow>();
    return row ? executionFromRow(row) : null;
  }

  async updateExecution(
    record: DemoExecutionRecord,
    guard: DemoExecutionUpdateGuard,
  ): Promise<DemoExecutionRecord> {
    if (record.stateVersion !== guard.expectedStateVersion) {
      throw new TypeError("실행 record와 예상 state version이 다릅니다.");
    }
    const evaluation = artifactValues(record.evaluationPackReference);
    const publicProjection = artifactValues(record.publicProjectionReference);
    const cleanup = artifactValues(record.cleanupReceiptReference);
    const row = await this.#db.prepare(`
      UPDATE executions
      SET
        source = ?,
        status = ?,
        progress_step = ?,
        current_candidate = ?,
        completed_candidate_count = ?,
        started_at_ms = ?,
        heartbeat_at_ms = ?,
        completed_at_ms = ?,
        retry_count = ?,
        error_code = ?,
        cleanup_status = ?,
        evaluation_pack_namespace = ?,
        evaluation_pack_object_key = ?,
        evaluation_pack_sha256 = ?,
        evaluation_pack_byte_length = ?,
        public_projection_namespace = ?,
        public_projection_object_key = ?,
        public_projection_sha256 = ?,
        public_projection_byte_length = ?,
        cleanup_receipt_namespace = ?,
        cleanup_receipt_object_key = ?,
        cleanup_receipt_sha256 = ?,
        cleanup_receipt_byte_length = ?,
        actual_cost_micro_usd = ?,
        source_hash = ?,
        state_version = state_version + 1
      WHERE execution_id = ?
        AND session_token_digest = ?
        AND source_hash = ?
        AND state_version = ?
        AND status = ?
      RETURNING ${EXECUTION_COLUMNS}
    `).bind(
      record.source,
      record.status,
      record.progressStep,
      record.currentCandidate,
      record.completedCandidateCount,
      record.startedAtMs,
      record.heartbeatAtMs,
      record.completedAtMs,
      record.retryCount,
      record.errorCode,
      record.cleanupStatus,
      ...evaluation,
      ...publicProjection,
      ...cleanup,
      record.actualCostMicroUsd,
      record.sourceHash,
      record.executionId,
      record.sessionTokenDigest,
      guard.expectedSourceHash,
      guard.expectedStateVersion,
      guard.expectedStatus,
    ).first<ExecutionRow>();
    if (!row) throw new Error("STALE_EXECUTION_STATE");
    return executionFromRow(row);
  }

  async attachArtifact(
    executionId: string,
    kind: "EVALUATION_PACK" | "CLEANUP_RECEIPT",
    reference: DemoArtifactReference,
    guard: DemoExecutionArtifactGuard,
  ): Promise<DemoExecutionRecord> {
    const parameters = [
      reference.namespace,
      reference.objectKey,
      reference.sha256,
      reference.byteLength,
      executionId,
      guard.sessionTokenDigest,
      guard.expectedSourceHash,
      guard.expectedStateVersion,
      guard.expectedStatus,
    ];
    const columns = kind === "EVALUATION_PACK"
      ? `
        evaluation_pack_namespace = ?,
        evaluation_pack_object_key = ?,
        evaluation_pack_sha256 = ?,
        evaluation_pack_byte_length = ?`
      : `
        cleanup_receipt_namespace = ?,
        cleanup_receipt_object_key = ?,
        cleanup_receipt_sha256 = ?,
        cleanup_receipt_byte_length = ?`;
    const row = await this.#db.prepare(`
      UPDATE executions
      SET ${columns},
        state_version = state_version + 1
      WHERE execution_id = ?
        AND session_token_digest = ?
        AND source_hash = ?
        AND state_version = ?
        AND status = ?
      RETURNING ${EXECUTION_COLUMNS}
    `).bind(...parameters).first<ExecutionRow>();
    if (!row) throw new Error("STALE_EXECUTION_STATE");
    return executionFromRow(row);
  }

  async saveHumanReview(
    record: DemoHumanReviewRecord,
    expectedSourceHash?: string,
  ): Promise<void> {
    const sourceHash = expectedSourceHash
      ?? (await this.requireExecution(record.executionId)).sourceHash;
    const result = await this.#db.prepare(`
      INSERT INTO human_reviews (
        execution_id,
        blind_label,
        decision,
        rationale,
        corrected_reply,
        review_duration_ms,
        edit_duration_ms,
        confirmed_at_ms,
        source_hash
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM executions
      WHERE execution_id = ?
        AND source_hash = ?
      ON CONFLICT (execution_id, blind_label)
      DO UPDATE SET
        decision = excluded.decision,
        rationale = excluded.rationale,
        corrected_reply = excluded.corrected_reply,
        review_duration_ms = excluded.review_duration_ms,
        edit_duration_ms = excluded.edit_duration_ms,
        confirmed_at_ms = excluded.confirmed_at_ms,
        source_hash = excluded.source_hash
    `).bind(
      record.executionId,
      record.blindLabel,
      record.decision,
      record.rationale,
      record.correctedReply,
      record.reviewDurationMs,
      record.editDurationMs,
      record.confirmedAtMs,
      sourceHash,
      record.executionId,
      sourceHash,
    ).run();
    if (changes(result) !== 1) throw new Error("STALE_EXECUTION_SOURCE");
  }

  async readHumanReviews(
    executionId: string,
  ): Promise<readonly DemoHumanReviewRecord[]> {
    const result = await this.#db.prepare(`
      SELECT
        execution_id,
        blind_label,
        decision,
        rationale,
        corrected_reply,
        review_duration_ms,
        edit_duration_ms,
        confirmed_at_ms
      FROM human_reviews
      WHERE execution_id = ?
      ORDER BY blind_label ASC
    `).bind(executionId).all<HumanReviewRow>();
    return result.results.map(reviewFromRow);
  }

  async saveSelection(
    record: DemoCandidateSelectionRecord,
    expectedSourceHash?: string,
  ): Promise<void> {
    const sourceHash = expectedSourceHash
      ?? (await this.requireExecution(record.executionId)).sourceHash;
    if (record.sourceHash !== sourceHash) {
      throw new Error("STALE_EXECUTION_SOURCE");
    }
    const result = await this.#db.prepare(`
      INSERT INTO candidate_selections (
        execution_id,
        candidate_id,
        rationale,
        source_hash,
        selected_at_ms
      )
      SELECT ?, ?, ?, ?, ?
      FROM executions
      WHERE execution_id = ?
        AND source_hash = ?
      ON CONFLICT (execution_id)
      DO UPDATE SET
        candidate_id = excluded.candidate_id,
        rationale = excluded.rationale,
        source_hash = excluded.source_hash,
        selected_at_ms = excluded.selected_at_ms
    `).bind(
      record.executionId,
      record.candidateId,
      record.rationale,
      record.sourceHash,
      record.selectedAtMs,
      record.executionId,
      sourceHash,
    ).run();
    if (changes(result) !== 1) throw new Error("STALE_EXECUTION_SOURCE");
  }

  async readSelection(
    executionId: string,
  ): Promise<DemoCandidateSelectionRecord | null> {
    const row = await this.#db.prepare(`
      SELECT execution_id, candidate_id, rationale, source_hash, selected_at_ms
      FROM candidate_selections
      WHERE execution_id = ?
    `).bind(executionId).first<SelectionRow>();
    return row ? selectionFromRow(row) : null;
  }

  async saveMemoState(
    record: DemoDecisionMemoRecord,
    expectedSourceHash?: string,
  ): Promise<void> {
    const sourceHash = expectedSourceHash
      ?? (await this.requireExecution(record.executionId)).sourceHash;
    if (record.sourcePackHash !== sourceHash) {
      throw new Error("STALE_EXECUTION_SOURCE");
    }
    const artifact = artifactValues(record.artifactReference);
    const result = await this.#db.prepare(`
      INSERT INTO decision_memos (
        execution_id,
        status,
        source_pack_hash,
        review_hash,
        selection_hash,
        artifact_namespace,
        artifact_object_key,
        artifact_sha256,
        artifact_byte_length,
        error_code,
        reconciliation_reason,
        updated_at_ms
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM executions
      WHERE execution_id = ?
        AND source_hash = ?
      ON CONFLICT (execution_id)
      DO UPDATE SET
        status = excluded.status,
        source_pack_hash = excluded.source_pack_hash,
        review_hash = excluded.review_hash,
        selection_hash = excluded.selection_hash,
        artifact_namespace = excluded.artifact_namespace,
        artifact_object_key = excluded.artifact_object_key,
        artifact_sha256 = excluded.artifact_sha256,
        artifact_byte_length = excluded.artifact_byte_length,
        error_code = excluded.error_code,
        reconciliation_reason = excluded.reconciliation_reason,
        updated_at_ms = excluded.updated_at_ms
    `).bind(
      record.executionId,
      record.status,
      record.sourcePackHash,
      record.reviewHash,
      record.selectionHash,
      ...artifact,
      record.errorCode,
      record.reconciliationReason,
      record.updatedAtMs,
      record.executionId,
      sourceHash,
    ).run();
    if (changes(result) !== 1) throw new Error("STALE_EXECUTION_SOURCE");
  }

  async readMemoState(
    executionId: string,
  ): Promise<DemoDecisionMemoRecord | null> {
    const row = await this.#db.prepare(`
      SELECT
        execution_id,
        status,
        source_pack_hash,
        review_hash,
        selection_hash,
        artifact_namespace,
        artifact_object_key,
        artifact_sha256,
        artifact_byte_length,
        error_code,
        reconciliation_reason,
        updated_at_ms
      FROM decision_memos
      WHERE execution_id = ?
    `).bind(executionId).first<MemoRow>();
    return row ? memoFromRow(row) : null;
  }

  async confirmHumanReviews(
    input: DemoHumanReviewTransition,
  ): Promise<boolean> {
    nonempty(input.executionId, "execution ID");
    nonempty(input.sessionTokenDigest, "session digest");
    nonempty(input.expectedSourceHash, "source hash");
    nonnegativeSafeInteger(input.expectedStateVersion, "state version");
    if (
      input.nextStatus !== "REVIEW_READY"
      && input.nextStatus !== "NO_APPROVED_CANDIDATE"
    ) {
      throw new TypeError("사람 검수 다음 상태가 저장 계약과 다릅니다.");
    }
    if (
      input.reviews.length < 1
      || input.reviews.length > 3
      || new Set(input.reviews.map((review) => review.blindLabel)).size
        !== input.reviews.length
    ) {
      throw new TypeError("사람 검수는 1~3개의 고유 블라인드 결정이어야 합니다.");
    }
    const publicProjection = artifactValues(
      input.publicProjectionReference,
    );
    const statements = input.reviews.map((review) => {
      if (
        review.executionId !== input.executionId
        || (
          review.decision !== "PASS"
          && review.decision !== "CONFIRMED_FAIL"
        )
      ) {
        throw new TypeError("사람 검수 identity 또는 결정이 올바르지 않습니다.");
      }
      nonempty(review.rationale, "review rationale");
      nonnegativeSafeInteger(review.reviewDurationMs, "review duration");
      nonnegativeSafeInteger(review.editDurationMs, "review edit duration");
      nonnegativeSafeInteger(review.confirmedAtMs, "review confirmed time");
      return this.#db.prepare(`
        INSERT INTO human_reviews (
          execution_id,
          blind_label,
          decision,
          rationale,
          corrected_reply,
          review_duration_ms,
          edit_duration_ms,
          confirmed_at_ms,
          source_hash
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM executions
        WHERE execution_id = ?
          AND session_token_digest = ?
          AND source_hash = ?
          AND state_version = ?
          AND status = 'JUDGE_READY'
        ON CONFLICT (execution_id, blind_label)
        DO UPDATE SET
          decision = excluded.decision,
          rationale = excluded.rationale,
          corrected_reply = excluded.corrected_reply,
          review_duration_ms = excluded.review_duration_ms,
          edit_duration_ms = excluded.edit_duration_ms,
          confirmed_at_ms = excluded.confirmed_at_ms,
          source_hash = excluded.source_hash
      `).bind(
        review.executionId,
        review.blindLabel,
        review.decision,
        review.rationale,
        review.correctedReply,
        review.reviewDurationMs,
        review.editDurationMs,
        review.confirmedAtMs,
        input.expectedSourceHash,
        input.executionId,
        input.sessionTokenDigest,
        input.expectedSourceHash,
        input.expectedStateVersion,
      );
    });
    statements.push(this.#db.prepare(`
      UPDATE executions
      SET
        status = ?,
        progress_step = ?,
        public_projection_namespace = ?,
        public_projection_object_key = ?,
        public_projection_sha256 = ?,
        public_projection_byte_length = ?,
        state_version = state_version + 1
      WHERE execution_id = ?
        AND session_token_digest = ?
        AND source_hash = ?
        AND state_version = ?
        AND status = 'JUDGE_READY'
      RETURNING execution_id
    `).bind(
      input.nextStatus,
      input.nextStatus,
      ...publicProjection,
      input.executionId,
      input.sessionTokenDigest,
      input.expectedSourceHash,
      input.expectedStateVersion,
    ));
    const results = await this.#db.batch<{ execution_id: string }>(statements);
    return (results.at(-1)?.results.length ?? 0) === 1;
  }

  async recordCandidateSelection(
    input: DemoCandidateSelectionTransition,
  ): Promise<boolean> {
    nonempty(input.executionId, "execution ID");
    nonempty(input.sessionTokenDigest, "session digest");
    nonempty(input.expectedSourceHash, "source hash");
    nonnegativeSafeInteger(input.expectedStateVersion, "state version");
    const selection = input.selection;
    if (
      selection.executionId !== input.executionId
      || selection.sourceHash !== input.expectedSourceHash
    ) {
      throw new TypeError("후보 선택 identity 또는 source hash가 다릅니다.");
    }
    nonempty(selection.rationale, "selection rationale");
    nonnegativeSafeInteger(selection.selectedAtMs, "selection time");
    const publicProjection = artifactValues(
      input.publicProjectionReference,
    );
    const results = await this.#db.batch<{ execution_id: string }>([
      this.#db.prepare(`
        INSERT INTO candidate_selections (
          execution_id,
          candidate_id,
          rationale,
          source_hash,
          selected_at_ms
        )
        SELECT ?, ?, ?, ?, ?
        FROM executions
        WHERE execution_id = ?
          AND session_token_digest = ?
          AND source_hash = ?
          AND state_version = ?
          AND status = 'REVIEW_READY'
        ON CONFLICT (execution_id)
        DO UPDATE SET
          candidate_id = excluded.candidate_id,
          rationale = excluded.rationale,
          source_hash = excluded.source_hash,
          selected_at_ms = excluded.selected_at_ms
      `).bind(
        selection.executionId,
        selection.candidateId,
        selection.rationale,
        selection.sourceHash,
        selection.selectedAtMs,
        input.executionId,
        input.sessionTokenDigest,
        input.expectedSourceHash,
        input.expectedStateVersion,
      ),
      this.#db.prepare(`
        UPDATE executions
        SET
          status = 'SELECTION_RECORDED',
          progress_step = 'SELECTION_RECORDED',
          public_projection_namespace = ?,
          public_projection_object_key = ?,
          public_projection_sha256 = ?,
          public_projection_byte_length = ?,
          state_version = state_version + 1
        WHERE execution_id = ?
          AND session_token_digest = ?
          AND source_hash = ?
          AND state_version = ?
          AND status = 'REVIEW_READY'
        RETURNING execution_id
      `).bind(
        ...publicProjection,
        input.executionId,
        input.sessionTokenDigest,
        input.expectedSourceHash,
        input.expectedStateVersion,
      ),
    ]);
    return (results[1]?.results.length ?? 0) === 1;
  }

  async beginDecisionMemo(
    input: DemoDecisionMemoTransition,
  ): Promise<boolean> {
    this.validateMemoTransition(input, "RUNNING");
    const memo = input.memo;
    const artifact = artifactValues(memo.artifactReference);
    const publicProjection = artifactValues(
      input.publicProjectionReference,
    );
    const results = await this.#db.batch<{ execution_id: string }>([
      this.#db.prepare(`
        INSERT INTO decision_memos (
          execution_id,
          status,
          source_pack_hash,
          review_hash,
          selection_hash,
          artifact_namespace,
          artifact_object_key,
          artifact_sha256,
          artifact_byte_length,
          error_code,
          reconciliation_reason,
          updated_at_ms
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM executions
        WHERE execution_id = ?
          AND session_token_digest = ?
          AND source_hash = ?
          AND state_version = ?
          AND status IN ('SELECTION_RECORDED', 'MEMO_FAILED')
        ON CONFLICT (execution_id)
        DO UPDATE SET
          status = excluded.status,
          source_pack_hash = excluded.source_pack_hash,
          review_hash = excluded.review_hash,
          selection_hash = excluded.selection_hash,
          artifact_namespace = excluded.artifact_namespace,
          artifact_object_key = excluded.artifact_object_key,
          artifact_sha256 = excluded.artifact_sha256,
          artifact_byte_length = excluded.artifact_byte_length,
          error_code = excluded.error_code,
          reconciliation_reason = excluded.reconciliation_reason,
          updated_at_ms = excluded.updated_at_ms
      `).bind(
        memo.executionId,
        memo.status,
        memo.sourcePackHash,
        memo.reviewHash,
        memo.selectionHash,
        ...artifact,
        memo.errorCode,
        memo.reconciliationReason,
        memo.updatedAtMs,
        input.executionId,
        input.sessionTokenDigest,
        input.expectedSourceHash,
        input.expectedStateVersion,
      ),
      this.#db.prepare(`
        UPDATE executions
        SET
          status = 'MEMO_RUNNING',
          progress_step = 'MEMO_RUNNING',
          public_projection_namespace = ?,
          public_projection_object_key = ?,
          public_projection_sha256 = ?,
          public_projection_byte_length = ?,
          state_version = state_version + 1
        WHERE execution_id = ?
          AND session_token_digest = ?
          AND source_hash = ?
          AND state_version = ?
          AND status IN ('SELECTION_RECORDED', 'MEMO_FAILED')
        RETURNING execution_id
      `).bind(
        ...publicProjection,
        input.executionId,
        input.sessionTokenDigest,
        input.expectedSourceHash,
        input.expectedStateVersion,
      ),
    ]);
    return (results[1]?.results.length ?? 0) === 1;
  }

  async completeDecisionMemo(
    input: DemoDecisionMemoTransition,
  ): Promise<boolean> {
    if (input.memo.status !== "READY" && input.memo.status !== "FAILED") {
      throw new TypeError("완료 Memo 상태는 READY 또는 FAILED여야 합니다.");
    }
    this.validateMemoTransition(input, input.memo.status);
    if (
      input.memo.status === "READY"
      && input.memo.artifactReference === null
    ) {
      throw new TypeError("READY Memo에는 불변 artifact reference가 필요합니다.");
    }
    const memo = input.memo;
    const artifact = artifactValues(memo.artifactReference);
    const publicProjection = artifactValues(
      input.publicProjectionReference,
    );
    const executionStatus = memo.status === "READY"
      ? "MEMO_READY"
      : "MEMO_FAILED";
    const results = await this.#db.batch<{ execution_id: string }>([
      this.#db.prepare(`
        UPDATE decision_memos
        SET
          status = ?,
          artifact_namespace = ?,
          artifact_object_key = ?,
          artifact_sha256 = ?,
          artifact_byte_length = ?,
          error_code = ?,
          reconciliation_reason = ?,
          updated_at_ms = ?
        WHERE execution_id = ?
          AND status = 'RUNNING'
          AND source_pack_hash = ?
          AND review_hash IS ?
          AND selection_hash IS ?
          AND EXISTS (
            SELECT 1
            FROM executions
            WHERE execution_id = ?
              AND session_token_digest = ?
              AND source_hash = ?
              AND state_version = ?
              AND status = 'MEMO_RUNNING'
          )
        RETURNING execution_id
      `).bind(
        memo.status,
        ...artifact,
        memo.errorCode,
        memo.reconciliationReason,
        memo.updatedAtMs,
        memo.executionId,
        memo.sourcePackHash,
        memo.reviewHash,
        memo.selectionHash,
        input.executionId,
        input.sessionTokenDigest,
        input.expectedSourceHash,
        input.expectedStateVersion,
      ),
      this.#db.prepare(`
        UPDATE executions
        SET
          status = ?,
          progress_step = ?,
          public_projection_namespace = ?,
          public_projection_object_key = ?,
          public_projection_sha256 = ?,
          public_projection_byte_length = ?,
          state_version = state_version + 1
        WHERE execution_id = ?
          AND session_token_digest = ?
          AND source_hash = ?
          AND state_version = ?
          AND status = 'MEMO_RUNNING'
          AND EXISTS (
            SELECT 1
            FROM decision_memos
            WHERE execution_id = ?
              AND status = ?
              AND source_pack_hash = ?
              AND review_hash IS ?
              AND selection_hash IS ?
          )
        RETURNING execution_id
      `).bind(
        executionStatus,
        executionStatus,
        ...publicProjection,
        input.executionId,
        input.sessionTokenDigest,
        input.expectedSourceHash,
        input.expectedStateVersion,
        input.executionId,
        memo.status,
        memo.sourcePackHash,
        memo.reviewHash,
        memo.selectionHash,
      ),
    ]);
    return (results[1]?.results.length ?? 0) === 1;
  }

  async reserveAuxiliaryCallAttempt(
    input: DemoAuxiliaryCallReservation,
  ): Promise<DemoAuxiliaryCallReservationResult> {
    this.validateAuxiliaryReservation(input);
    const row = await this.#db.prepare(`
      INSERT INTO auxiliary_call_attempts (
        execution_id,
        session_token_digest,
        kind,
        attempt_number,
        source_hash,
        reserved_state_version,
        bucket_started_at_ms,
        status,
        reserved_at_ms,
        completed_at_ms,
        error_code
      )
      SELECT
        executions.execution_id,
        executions.session_token_digest,
        ?,
        ?,
        executions.source_hash,
        executions.state_version,
        ?,
        'RESERVED',
        ?,
        NULL,
        NULL
      FROM executions
      INNER JOIN demo_sessions
        ON demo_sessions.session_token_digest = executions.session_token_digest
      WHERE executions.execution_id = ?
        AND executions.session_token_digest = ?
        AND executions.source_hash = ?
        AND executions.state_version = ?
        AND executions.status = ?
        AND executions.progress_step = ?
        AND demo_sessions.current_execution_id = executions.execution_id
        AND demo_sessions.revoked_at_ms IS NULL
        AND demo_sessions.expires_at_ms > ?
        AND (
          SELECT COUNT(*)
          FROM auxiliary_call_attempts AS bucket_attempts
          WHERE bucket_attempts.bucket_started_at_ms = ?
        ) < ?
      ON CONFLICT (execution_id, kind, attempt_number) DO NOTHING
      RETURNING ${AUXILIARY_CALL_ATTEMPT_COLUMNS}
    `).bind(
      input.kind,
      input.attemptNumber,
      input.bucketStartedAtMs,
      input.reservedAtMs,
      input.executionId,
      input.sessionTokenDigest,
      input.expectedSourceHash,
      input.expectedStateVersion,
      input.expectedStatus,
      input.expectedProgressStep,
      input.reservedAtMs,
      input.bucketStartedAtMs,
      input.maxAttemptsPerBucket,
    ).first<AuxiliaryCallAttemptRow>();
    if (row) {
      return {
        outcome: "RESERVED",
        attempt: auxiliaryCallAttemptFromRow(row),
      };
    }

    const current = await this.#db.prepare(`
      SELECT executions.execution_id
      FROM executions
      INNER JOIN demo_sessions
        ON demo_sessions.session_token_digest = executions.session_token_digest
      WHERE executions.execution_id = ?
        AND executions.session_token_digest = ?
        AND executions.source_hash = ?
        AND executions.state_version = ?
        AND executions.status = ?
        AND executions.progress_step = ?
        AND demo_sessions.current_execution_id = executions.execution_id
        AND demo_sessions.revoked_at_ms IS NULL
        AND demo_sessions.expires_at_ms > ?
    `).bind(
      input.executionId,
      input.sessionTokenDigest,
      input.expectedSourceHash,
      input.expectedStateVersion,
      input.expectedStatus,
      input.expectedProgressStep,
      input.reservedAtMs,
    ).first<{ execution_id: string }>();
    if (!current) return { outcome: "STALE" };

    const existing = await this.readAuxiliaryCallAttempt(
      input.executionId,
      input.kind,
      input.attemptNumber,
    );
    if (existing) return { outcome: "ALREADY_RESERVED" };

    const count = await this.#db.prepare(`
      SELECT COUNT(*) AS attempt_count
      FROM auxiliary_call_attempts
      WHERE bucket_started_at_ms = ?
    `).bind(input.bucketStartedAtMs).first<{ attempt_count: number }>();
    return (count?.attempt_count ?? 0) >= input.maxAttemptsPerBucket
      ? { outcome: "LIMIT_REACHED" }
      : { outcome: "STALE" };
  }

  async completeAuxiliaryCallAttempt(
    input: DemoAuxiliaryCallCompletion,
  ): Promise<boolean> {
    this.validateAuxiliaryCompletion(input);
    const result = await this.#db.prepare(`
      UPDATE auxiliary_call_attempts
      SET
        status = ?,
        completed_at_ms = ?,
        error_code = ?
      WHERE execution_id = ?
        AND session_token_digest = ?
        AND kind = ?
        AND attempt_number = ?
        AND source_hash = ?
        AND reserved_state_version = ?
        AND status = 'RESERVED'
        AND reserved_at_ms <= ?
        AND EXISTS (
          SELECT 1
          FROM executions
          INNER JOIN demo_sessions
            ON demo_sessions.session_token_digest =
              executions.session_token_digest
          WHERE executions.execution_id =
              auxiliary_call_attempts.execution_id
            AND executions.session_token_digest = ?
            AND executions.source_hash = ?
            AND executions.state_version = ?
            AND demo_sessions.current_execution_id =
              executions.execution_id
            AND (
              (
                auxiliary_call_attempts.kind = 'JUDGE'
                AND executions.status = 'RESULTS_READY'
                AND executions.progress_step = CASE
                  WHEN auxiliary_call_attempts.attempt_number = 1
                    THEN 'JUDGE_RUNNING'
                  ELSE 'JUDGE_RETRY_RUNNING'
                END
              )
              OR (
                auxiliary_call_attempts.kind = 'MEMO'
                AND executions.status = 'MEMO_RUNNING'
                AND executions.progress_step = 'MEMO_RUNNING'
              )
            )
        )
      RETURNING execution_id
    `).bind(
      input.outcome,
      input.completedAtMs,
      input.errorCode,
      input.executionId,
      input.sessionTokenDigest,
      input.kind,
      input.attemptNumber,
      input.expectedSourceHash,
      input.expectedStateVersion,
      input.completedAtMs,
      input.sessionTokenDigest,
      input.expectedSourceHash,
      input.expectedStateVersion,
    ).first<{ execution_id: string }>();
    return result !== null;
  }

  async readAuxiliaryCallAttempt(
    executionId: string,
    kind: DemoAuxiliaryCallKind,
    attemptNumber: 1 | 2,
  ): Promise<DemoAuxiliaryCallAttemptRecord | null> {
    nonempty(executionId, "execution ID");
    if (kind !== "JUDGE" && kind !== "MEMO") {
      throw new TypeError("보조 호출 종류가 저장 계약을 벗어났습니다.");
    }
    if (attemptNumber !== 1 && attemptNumber !== 2) {
      throw new TypeError("보조 호출 시도 번호는 1 또는 2여야 합니다.");
    }
    const row = await this.#db.prepare(`
      SELECT ${AUXILIARY_CALL_ATTEMPT_COLUMNS}
      FROM auxiliary_call_attempts
      WHERE execution_id = ?
        AND kind = ?
        AND attempt_number = ?
    `).bind(
      executionId,
      kind,
      attemptNumber,
    ).first<AuxiliaryCallAttemptRow>();
    return row ? auxiliaryCallAttemptFromRow(row) : null;
  }

  async claimExecution(
    input: DemoExecutionClaimOptions,
  ): Promise<DemoExecutionRecord | null> {
    this.validateClaim(input);
    const retryFlag = input.isOperationalRetry ? 1 : 0;
    const results = await this.#db.batch<ExecutionRow>([
      this.#db.prepare(`
        INSERT INTO usage_budgets (
          bucket_started_at_ms,
          reserved_run_count,
          confirmed_run_count,
          reserved_cost_micro_usd,
          confirmed_cost_micro_usd,
          failed_request_cost_micro_usd,
          last_reservation_token,
          last_reconciliation_token,
          updated_at_ms
        ) VALUES (?, 0, 0, 0, 0, 0, NULL, NULL, ?)
        ON CONFLICT (bucket_started_at_ms) DO NOTHING
      `).bind(input.budgetBucketStartedAtMs, input.nowMs),
      this.#db.prepare(`
        UPDATE usage_budgets
        SET
          reserved_run_count = reserved_run_count + 1,
          reserved_cost_micro_usd = reserved_cost_micro_usd + ?,
          last_reservation_token = ?,
          updated_at_ms = ?
        WHERE bucket_started_at_ms = ?
          AND reserved_run_count + confirmed_run_count < ?
          AND reserved_cost_micro_usd + confirmed_cost_micro_usd + ? <= ?
          AND EXISTS (
            SELECT 1
            FROM executions
            INNER JOIN demo_sessions
              ON demo_sessions.session_token_digest = executions.session_token_digest
            WHERE executions.execution_id = ?
              AND executions.session_token_digest = ?
              AND executions.status = 'READY'
              AND executions.source_hash = ?
              AND executions.state_version = ?
              AND demo_sessions.revoked_at_ms IS NULL
              AND demo_sessions.expires_at_ms > ?
              AND demo_sessions.successful_live_runs < ?
              AND (? = 0 OR demo_sessions.operational_retry_count < ?)
              AND (
                demo_sessions.current_execution_id IS NULL
                OR demo_sessions.current_execution_id = executions.execution_id
              )
              AND (
                SELECT COUNT(*)
                FROM executions AS running
                WHERE running.status = 'RUNNING'
              ) < ?
          )
      `).bind(
        input.reservedCostMicroUsd,
        input.leaseTokenDigest,
        input.nowMs,
        input.budgetBucketStartedAtMs,
        input.maxBucketRunCount,
        input.reservedCostMicroUsd,
        input.maxBucketCostMicroUsd,
        input.executionId,
        input.sessionTokenDigest,
        input.expectedSourceHash,
        input.expectedStateVersion,
        input.nowMs,
        input.maxSuccessfulRunsPerSession,
        retryFlag,
        input.maxOperationalRetriesPerSession,
        input.maxGlobalConcurrentRuns,
      ),
      this.#db.prepare(`
        UPDATE executions
        SET
          status = 'RUNNING',
          started_at_ms = ?,
          heartbeat_at_ms = ?,
          lease_token_digest = ?,
          lease_expires_at_ms = ?,
          budget_bucket_started_at_ms = ?,
          reserved_cost_micro_usd = ?,
          state_version = state_version + 1
        WHERE execution_id = ?
          AND session_token_digest = ?
          AND status = 'READY'
          AND source_hash = ?
          AND state_version = ?
          AND EXISTS (
            SELECT 1
            FROM usage_budgets
            WHERE bucket_started_at_ms = ?
              AND last_reservation_token = ?
          )
        RETURNING ${EXECUTION_COLUMNS}
      `).bind(
        input.nowMs,
        input.nowMs,
        input.leaseTokenDigest,
        input.leaseExpiresAtMs,
        input.budgetBucketStartedAtMs,
        input.reservedCostMicroUsd,
        input.executionId,
        input.sessionTokenDigest,
        input.expectedSourceHash,
        input.expectedStateVersion,
        input.budgetBucketStartedAtMs,
        input.leaseTokenDigest,
      ),
      this.#db.prepare(`
        UPDATE demo_sessions
        SET
          current_execution_id = ?,
          operational_retry_count = operational_retry_count + ?
        WHERE session_token_digest = ?
          AND (
            current_execution_id IS NULL
            OR current_execution_id = ?
          )
          AND EXISTS (
            SELECT 1
            FROM executions
            WHERE execution_id = ?
              AND status = 'RUNNING'
              AND lease_token_digest = ?
          )
      `).bind(
        input.executionId,
        retryFlag,
        input.sessionTokenDigest,
        input.executionId,
        input.executionId,
        input.leaseTokenDigest,
      ),
    ]);
    const row = results[2]?.results[0];
    return row ? executionFromRow(row) : null;
  }

  async readUsageBudget(
    bucketStartedAtMs: number,
  ): Promise<DemoUsageBudgetRecord | null> {
    const row = await this.#db.prepare(`
      SELECT
        bucket_started_at_ms,
        reserved_run_count,
        confirmed_run_count,
        reserved_cost_micro_usd,
        confirmed_cost_micro_usd,
        failed_request_cost_micro_usd,
        updated_at_ms
      FROM usage_budgets
      WHERE bucket_started_at_ms = ?
    `).bind(bucketStartedAtMs).first<UsageBudgetRow>();
    return row ? usageBudgetFromRow(row) : null;
  }

  async reconcileExecutionCost(
    input: DemoExecutionCostReconciliation,
  ): Promise<boolean> {
    this.validateReconciliation(input);
    const successFlag = input.completedSuccessfully ? 1 : 0;
    const results = await this.#db.batch<{ execution_id: string }>([
      this.#db.prepare(`
        UPDATE usage_budgets
        SET
          reserved_run_count = reserved_run_count - 1,
          confirmed_run_count = confirmed_run_count + 1,
          reserved_cost_micro_usd = reserved_cost_micro_usd - ?,
          confirmed_cost_micro_usd = confirmed_cost_micro_usd + ?,
          failed_request_cost_micro_usd =
            failed_request_cost_micro_usd + ?,
          last_reconciliation_token = ?,
          updated_at_ms = ?
        WHERE bucket_started_at_ms = ?
          AND reserved_run_count >= 1
          AND reserved_cost_micro_usd >= ?
          AND EXISTS (
            SELECT 1
            FROM executions
            WHERE execution_id = ?
              AND session_token_digest = ?
              AND source_hash = ?
              AND state_version = ?
              AND status = 'RUNNING'
              AND lease_token_digest = ?
              AND lease_expires_at_ms > ?
              AND budget_bucket_started_at_ms = ?
              AND reserved_cost_micro_usd = ?
              AND cost_reconciled_at_ms IS NULL
          )
      `).bind(
        input.reservedCostMicroUsd,
        input.actualCostMicroUsd,
        input.failedRequestCostMicroUsd,
        input.reconciliationToken,
        input.nowMs,
        input.budgetBucketStartedAtMs,
        input.reservedCostMicroUsd,
        input.executionId,
        input.sessionTokenDigest,
        input.expectedSourceHash,
        input.expectedStateVersion,
        input.leaseTokenDigest,
        input.nowMs,
        input.budgetBucketStartedAtMs,
        input.reservedCostMicroUsd,
      ),
      this.#db.prepare(`
        UPDATE executions
        SET
          status = CASE WHEN ? = 1 THEN 'RESULTS_READY' ELSE 'FAILED' END,
          completed_at_ms = ?,
          heartbeat_at_ms = ?,
          lease_expires_at_ms = ?,
          actual_cost_micro_usd = ?,
          cost_reconciled_at_ms = ?,
          error_code = CASE
            WHEN ? = 1 THEN error_code
            ELSE COALESCE(error_code, 'OPERATIONAL_FAILURE')
          END,
          state_version = state_version + 1
        WHERE execution_id = ?
          AND session_token_digest = ?
          AND source_hash = ?
          AND state_version = ?
          AND status = 'RUNNING'
          AND lease_token_digest = ?
          AND lease_expires_at_ms > ?
          AND cost_reconciled_at_ms IS NULL
          AND EXISTS (
            SELECT 1
            FROM usage_budgets
            WHERE bucket_started_at_ms = ?
              AND last_reconciliation_token = ?
          )
        RETURNING execution_id
      `).bind(
        successFlag,
        input.nowMs,
        input.nowMs,
        input.nowMs,
        input.actualCostMicroUsd,
        input.nowMs,
        successFlag,
        input.executionId,
        input.sessionTokenDigest,
        input.expectedSourceHash,
        input.expectedStateVersion,
        input.leaseTokenDigest,
        input.nowMs,
        input.budgetBucketStartedAtMs,
        input.reconciliationToken,
      ),
      this.#db.prepare(`
        UPDATE demo_sessions
        SET successful_live_runs = successful_live_runs + ?
        WHERE session_token_digest = (
          SELECT session_token_digest
          FROM executions
          WHERE execution_id = ?
            AND source_hash = ?
            AND cost_reconciled_at_ms = ?
        )
      `).bind(
        successFlag,
        input.executionId,
        input.expectedSourceHash,
        input.nowMs,
      ),
    ]);
    return (results[1]?.results.length ?? 0) === 1;
  }

  async interruptStaleExecutions(input: {
    readonly nowMs: number;
    readonly staleBeforeMs: number;
  }): Promise<number> {
    nonnegativeSafeInteger(input.nowMs, "interrupt now");
    nonnegativeSafeInteger(input.staleBeforeMs, "stale threshold");
    const results = await this.#db.batch<{ execution_id: string }>([
      this.#db.prepare(`
        UPDATE executions
        SET
          status = 'INTERRUPTED',
          completed_at_ms = ?,
          error_code = 'STALE_HEARTBEAT',
          lease_expires_at_ms = ?,
          state_version = state_version + 1
        WHERE status = 'RUNNING'
          AND (
            COALESCE(heartbeat_at_ms, started_at_ms, created_at_ms) <= ?
            OR lease_expires_at_ms <= ?
          )
        RETURNING execution_id
      `).bind(
        input.nowMs,
        input.nowMs,
        input.staleBeforeMs,
        input.nowMs,
      ),
    ]);
    return results[0]?.results.length ?? 0;
  }

  private async requireExecution(
    executionId: string,
  ): Promise<DemoExecutionRecord> {
    const record = await this.readExecution(executionId);
    if (!record) throw new Error("EXECUTION_NOT_FOUND");
    return record;
  }

  private validateMemoTransition(
    input: DemoDecisionMemoTransition,
    expectedStatus: DemoDecisionMemoRecord["status"],
  ): void {
    nonempty(input.executionId, "execution ID");
    nonempty(input.sessionTokenDigest, "session digest");
    nonempty(input.expectedSourceHash, "source hash");
    nonnegativeSafeInteger(input.expectedStateVersion, "state version");
    if (
      input.memo.executionId !== input.executionId
      || input.memo.sourcePackHash !== input.expectedSourceHash
      || input.memo.status !== expectedStatus
    ) {
      throw new TypeError("Memo identity, source hash 또는 상태가 다릅니다.");
    }
    if (input.memo.reviewHash === null || input.memo.selectionHash === null) {
      throw new TypeError("Memo에는 실제 review와 selection hash가 필요합니다.");
    }
    nonempty(input.memo.reviewHash, "review hash");
    nonempty(input.memo.selectionHash, "selection hash");
    nonnegativeSafeInteger(input.memo.updatedAtMs, "memo update time");
  }

  private validateClaim(input: DemoExecutionClaimOptions): void {
    nonempty(input.executionId, "execution ID");
    nonempty(input.sessionTokenDigest, "session digest");
    nonempty(input.expectedSourceHash, "source hash");
    nonnegativeSafeInteger(input.expectedStateVersion, "state version");
    nonempty(input.leaseTokenDigest, "lease digest");
    nonnegativeSafeInteger(input.nowMs, "claim time");
    nonnegativeSafeInteger(input.leaseExpiresAtMs, "lease expiry");
    if (input.leaseExpiresAtMs <= input.nowMs) {
      throw new TypeError("lease expiry는 claim 시각 이후여야 합니다.");
    }
    nonnegativeSafeInteger(input.budgetBucketStartedAtMs, "budget bucket");
    nonnegativeSafeInteger(input.reservedCostMicroUsd, "reserved cost");
    positiveSafeInteger(
      input.maxSuccessfulRunsPerSession,
      "session success cap",
    );
    positiveSafeInteger(
      input.maxOperationalRetriesPerSession,
      "operational retry cap",
    );
    positiveSafeInteger(
      input.maxGlobalConcurrentRuns,
      "global concurrent cap",
    );
    positiveSafeInteger(input.maxBucketRunCount, "bucket run cap");
    positiveSafeInteger(input.maxBucketCostMicroUsd, "bucket cost cap");
  }

  private validateAuxiliaryReservation(
    input: DemoAuxiliaryCallReservation,
  ): void {
    nonempty(input.executionId, "execution ID");
    nonempty(input.sessionTokenDigest, "session digest");
    nonempty(input.expectedSourceHash, "source hash");
    nonnegativeSafeInteger(input.expectedStateVersion, "state version");
    nonempty(input.expectedProgressStep, "progress step");
    nonnegativeSafeInteger(input.bucketStartedAtMs, "auxiliary bucket");
    nonnegativeSafeInteger(input.reservedAtMs, "auxiliary reservation time");
    positiveSafeInteger(
      input.maxAttemptsPerBucket,
      "auxiliary bucket attempt cap",
    );
    if (input.attemptNumber !== 1 && input.attemptNumber !== 2) {
      throw new TypeError("보조 호출 시도 번호는 1 또는 2여야 합니다.");
    }
    const validJudgeStage = input.kind === "JUDGE"
      && input.expectedStatus === "RESULTS_READY"
      && input.expectedProgressStep === (
        input.attemptNumber === 1
          ? "JUDGE_RUNNING"
          : "JUDGE_RETRY_RUNNING"
      );
    const validMemoStage = input.kind === "MEMO"
      && input.expectedStatus === "MEMO_RUNNING"
      && input.expectedProgressStep === "MEMO_RUNNING";
    if (!validJudgeStage && !validMemoStage) {
      throw new TypeError("보조 호출 단계와 시도 번호가 일치하지 않습니다.");
    }
  }

  private validateAuxiliaryCompletion(
    input: DemoAuxiliaryCallCompletion,
  ): void {
    nonempty(input.executionId, "execution ID");
    nonempty(input.sessionTokenDigest, "session digest");
    nonempty(input.expectedSourceHash, "source hash");
    nonnegativeSafeInteger(input.expectedStateVersion, "state version");
    nonnegativeSafeInteger(input.completedAtMs, "auxiliary completion time");
    if (input.attemptNumber !== 1 && input.attemptNumber !== 2) {
      throw new TypeError("보조 호출 시도 번호는 1 또는 2여야 합니다.");
    }
    if (
      (input.outcome === "COMPLETE" && input.errorCode !== null)
      || (
        input.outcome === "FAILED"
        && (
          input.errorCode === null
          || input.errorCode.length < 1
          || input.errorCode.length > 128
          || /\p{Cc}/u.test(input.errorCode)
        )
      )
    ) {
      throw new TypeError("보조 호출 완료 상태와 오류 코드가 일치하지 않습니다.");
    }
  }

  private validateReconciliation(
    input: DemoExecutionCostReconciliation,
  ): void {
    nonempty(input.executionId, "execution ID");
    nonempty(input.sessionTokenDigest, "session digest");
    nonempty(input.expectedSourceHash, "source hash");
    nonnegativeSafeInteger(input.expectedStateVersion, "state version");
    nonempty(input.leaseTokenDigest, "lease digest");
    nonempty(input.reconciliationToken, "reconciliation token");
    nonnegativeSafeInteger(input.budgetBucketStartedAtMs, "budget bucket");
    nonnegativeSafeInteger(input.reservedCostMicroUsd, "reserved cost");
    nonnegativeSafeInteger(input.actualCostMicroUsd, "actual cost");
    nonnegativeSafeInteger(
      input.failedRequestCostMicroUsd,
      "failed request cost",
    );
    nonnegativeSafeInteger(input.nowMs, "reconciliation time");
    if (input.failedRequestCostMicroUsd > input.actualCostMicroUsd) {
      throw new TypeError("실패 요청 비용은 실제 총비용을 초과할 수 없습니다.");
    }
  }
}

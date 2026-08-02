import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const executionStatuses = [
  "READY",
  "RUNNING",
  "INTERRUPTED",
  "FAILED",
  "RESULTS_READY",
  "JUDGE_READY",
  "REVIEW_READY",
  "NO_APPROVED_CANDIDATE",
  "SELECTION_RECORDED",
  "MEMO_RUNNING",
  "MEMO_FAILED",
  "MEMO_READY",
  "REGRESSION_BLOCK",
] as const;

const quoted = (values: readonly string[]) => (
  sql.raw(values.map((value) => `'${value}'`).join(", "))
);

export const demoSessions = sqliteTable(
  "demo_sessions",
  {
    sessionTokenDigest: text("session_token_digest").primaryKey(),
    createdAtMs: integer("created_at_ms").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
    revokedAtMs: integer("revoked_at_ms"),
    successfulLiveRuns: integer("successful_live_runs").notNull().default(0),
    operationalRetryCount: integer("operational_retry_count").notNull().default(0),
    currentExecutionId: text("current_execution_id"),
  },
  (table) => [
    check(
      "demo_sessions_created_at_nonnegative",
      sql`${table.createdAtMs} >= 0`,
    ),
    check(
      "demo_sessions_expiry_after_creation",
      sql`${table.expiresAtMs} > ${table.createdAtMs}`,
    ),
    check(
      "demo_sessions_revoked_at_nonnegative",
      sql`${table.revokedAtMs} IS NULL OR ${table.revokedAtMs} >= 0`,
    ),
    check(
      "demo_sessions_successful_runs_nonnegative",
      sql`${table.successfulLiveRuns} >= 0`,
    ),
    check(
      "demo_sessions_retry_count_nonnegative",
      sql`${table.operationalRetryCount} >= 0`,
    ),
  ],
);

export const authFailureBuckets = sqliteTable(
  "auth_failure_buckets",
  {
    networkFingerprint: text("network_fingerprint").notNull(),
    bucketStartedAtMs: integer("bucket_started_at_ms").notNull(),
    failureCount: integer("failure_count").notNull(),
    blockedUntilMs: integer("blocked_until_ms"),
  },
  (table) => [
    primaryKey({
      name: "auth_failure_buckets_pk",
      columns: [table.networkFingerprint, table.bucketStartedAtMs],
    }),
    uniqueIndex("auth_failure_buckets_latest_idx")
      .on(table.networkFingerprint, table.bucketStartedAtMs),
    check(
      "auth_failure_buckets_started_at_nonnegative",
      sql`${table.bucketStartedAtMs} >= 0`,
    ),
    check(
      "auth_failure_buckets_failure_count_positive",
      sql`${table.failureCount} >= 1`,
    ),
    check(
      "auth_failure_buckets_blocked_until_nonnegative",
      sql`${table.blockedUntilMs} IS NULL OR ${table.blockedUntilMs} >= 0`,
    ),
  ],
);

export const executions = sqliteTable(
  "executions",
  {
    executionId: text("execution_id").primaryKey(),
    sessionTokenDigest: text("session_token_digest")
      .notNull()
      .references(() => demoSessions.sessionTokenDigest, {
        onDelete: "cascade",
        onUpdate: "restrict",
      }),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    progressStep: text("progress_step").notNull(),
    currentCandidate: text("current_candidate"),
    completedCandidateCount: integer("completed_candidate_count")
      .notNull()
      .default(0),
    createdAtMs: integer("created_at_ms").notNull(),
    startedAtMs: integer("started_at_ms"),
    heartbeatAtMs: integer("heartbeat_at_ms"),
    completedAtMs: integer("completed_at_ms"),
    retryCount: integer("retry_count").notNull().default(0),
    errorCode: text("error_code"),
    cleanupStatus: text("cleanup_status").notNull().default("NOT_STARTED"),
    leaseTokenDigest: text("lease_token_digest"),
    leaseExpiresAtMs: integer("lease_expires_at_ms"),
    evaluationPackNamespace: text("evaluation_pack_namespace"),
    evaluationPackObjectKey: text("evaluation_pack_object_key"),
    evaluationPackSha256: text("evaluation_pack_sha256"),
    evaluationPackByteLength: integer("evaluation_pack_byte_length"),
    publicProjectionNamespace: text("public_projection_namespace"),
    publicProjectionObjectKey: text("public_projection_object_key"),
    publicProjectionSha256: text("public_projection_sha256"),
    publicProjectionByteLength: integer("public_projection_byte_length"),
    cleanupReceiptNamespace: text("cleanup_receipt_namespace"),
    cleanupReceiptObjectKey: text("cleanup_receipt_object_key"),
    cleanupReceiptSha256: text("cleanup_receipt_sha256"),
    cleanupReceiptByteLength: integer("cleanup_receipt_byte_length"),
    budgetBucketStartedAtMs: integer("budget_bucket_started_at_ms"),
    reservedCostMicroUsd: integer("reserved_cost_micro_usd").notNull().default(0),
    actualCostMicroUsd: integer("actual_cost_micro_usd").notNull().default(0),
    costReconciledAtMs: integer("cost_reconciled_at_ms"),
    sourceHash: text("source_hash").notNull(),
    stateVersion: integer("state_version").notNull().default(0),
  },
  (table) => [
    uniqueIndex("executions_one_active_per_session_idx")
      .on(table.sessionTokenDigest)
      .where(
        sql`${table.status} NOT IN ('INTERRUPTED', 'FAILED', 'NO_APPROVED_CANDIDATE', 'REGRESSION_BLOCK')`,
      ),
    check(
      "executions_source_enum",
      sql`${table.source} IN ('LIVE', 'RECORDED_FALLBACK')`,
    ),
    check(
      "executions_status_enum",
      sql`${table.status} IN (${quoted(executionStatuses)})`,
    ),
    check(
      "executions_current_candidate_enum",
      sql`${table.currentCandidate} IS NULL OR ${table.currentCandidate} IN ('A', 'B', 'C')`,
    ),
    check(
      "executions_completed_candidate_count_range",
      sql`${table.completedCandidateCount} BETWEEN 0 AND 3`,
    ),
    check(
      "executions_timestamps_nonnegative",
      sql`${table.createdAtMs} >= 0
        AND (${table.startedAtMs} IS NULL OR ${table.startedAtMs} >= 0)
        AND (${table.heartbeatAtMs} IS NULL OR ${table.heartbeatAtMs} >= 0)
        AND (${table.completedAtMs} IS NULL OR ${table.completedAtMs} >= 0)
        AND (${table.leaseExpiresAtMs} IS NULL OR ${table.leaseExpiresAtMs} >= 0)`,
    ),
    check(
      "executions_retry_count_nonnegative",
      sql`${table.retryCount} >= 0`,
    ),
    check(
      "executions_cleanup_status_enum",
      sql`${table.cleanupStatus} IN ('NOT_STARTED', 'RUNNING', 'ACKNOWLEDGED', 'FAILED')`,
    ),
    check(
      "executions_cost_nonnegative",
      sql`${table.reservedCostMicroUsd} >= 0 AND ${table.actualCostMicroUsd} >= 0`,
    ),
    check(
      "executions_budget_timestamps_nonnegative",
      sql`(${table.budgetBucketStartedAtMs} IS NULL OR ${table.budgetBucketStartedAtMs} >= 0)
        AND (${table.costReconciledAtMs} IS NULL OR ${table.costReconciledAtMs} >= 0)`,
    ),
    check(
      "executions_state_version_nonnegative",
      sql`${table.stateVersion} >= 0`,
    ),
    check(
      "executions_evaluation_pack_reference_complete",
      sql`(
        ${table.evaluationPackNamespace} IS NULL
        AND ${table.evaluationPackObjectKey} IS NULL
        AND ${table.evaluationPackSha256} IS NULL
        AND ${table.evaluationPackByteLength} IS NULL
      ) OR (
        ${table.evaluationPackNamespace} IS NOT NULL
        AND ${table.evaluationPackObjectKey} IS NOT NULL
        AND ${table.evaluationPackSha256} IS NOT NULL
        AND ${table.evaluationPackByteLength} >= 0
      )`,
    ),
    check(
      "executions_cleanup_receipt_reference_complete",
      sql`(
        ${table.cleanupReceiptNamespace} IS NULL
        AND ${table.cleanupReceiptObjectKey} IS NULL
        AND ${table.cleanupReceiptSha256} IS NULL
        AND ${table.cleanupReceiptByteLength} IS NULL
      ) OR (
        ${table.cleanupReceiptNamespace} IS NOT NULL
        AND ${table.cleanupReceiptObjectKey} IS NOT NULL
        AND ${table.cleanupReceiptSha256} IS NOT NULL
        AND ${table.cleanupReceiptByteLength} >= 0
      )`,
    ),
    check(
      "executions_public_projection_reference_complete",
      sql`(
        ${table.publicProjectionNamespace} IS NULL
        AND ${table.publicProjectionObjectKey} IS NULL
        AND ${table.publicProjectionSha256} IS NULL
        AND ${table.publicProjectionByteLength} IS NULL
      ) OR (
        ${table.publicProjectionNamespace} IN ('candidate-evidence', 'recorded-fallback')
        AND ${table.publicProjectionObjectKey} IS NOT NULL
        AND ${table.publicProjectionSha256} IS NOT NULL
        AND ${table.publicProjectionByteLength} >= 0
      )`,
    ),
  ],
);

export const humanReviews = sqliteTable(
  "human_reviews",
  {
    executionId: text("execution_id")
      .notNull()
      .references(() => executions.executionId, {
        onDelete: "cascade",
        onUpdate: "restrict",
      }),
    blindLabel: text("blind_label").notNull(),
    decision: text("decision").notNull(),
    rationale: text("rationale").notNull(),
    correctedReply: text("corrected_reply"),
    reviewDurationMs: integer("review_duration_ms").notNull(),
    editDurationMs: integer("edit_duration_ms").notNull(),
    confirmedAtMs: integer("confirmed_at_ms").notNull(),
    sourceHash: text("source_hash").notNull(),
  },
  (table) => [
    primaryKey({
      name: "human_reviews_pk",
      columns: [table.executionId, table.blindLabel],
    }),
    check(
      "human_reviews_blind_label_enum",
      sql`${table.blindLabel} IN ('X', 'Y', 'Z')`,
    ),
    check(
      "human_reviews_decision_enum",
      sql`${table.decision} IN ('PASS', 'CONFIRMED_FAIL')`,
    ),
    check(
      "human_reviews_durations_nonnegative",
      sql`${table.reviewDurationMs} >= 0 AND ${table.editDurationMs} >= 0`,
    ),
    check(
      "human_reviews_confirmed_at_nonnegative",
      sql`${table.confirmedAtMs} >= 0`,
    ),
  ],
);

export const candidateSelections = sqliteTable(
  "candidate_selections",
  {
    executionId: text("execution_id")
      .primaryKey()
      .references(() => executions.executionId, {
        onDelete: "cascade",
        onUpdate: "restrict",
      }),
    candidateId: text("candidate_id").notNull(),
    rationale: text("rationale").notNull(),
    sourceHash: text("source_hash").notNull(),
    selectedAtMs: integer("selected_at_ms").notNull(),
  },
  (table) => [
    check(
      "candidate_selections_candidate_id_enum",
      sql`${table.candidateId} IN ('A', 'B', 'C')`,
    ),
    check(
      "candidate_selections_selected_at_nonnegative",
      sql`${table.selectedAtMs} >= 0`,
    ),
  ],
);

export const decisionMemos = sqliteTable(
  "decision_memos",
  {
    executionId: text("execution_id")
      .primaryKey()
      .references(() => executions.executionId, {
        onDelete: "cascade",
        onUpdate: "restrict",
      }),
    status: text("status").notNull(),
    sourcePackHash: text("source_pack_hash").notNull(),
    reviewHash: text("review_hash"),
    selectionHash: text("selection_hash"),
    artifactNamespace: text("artifact_namespace"),
    artifactObjectKey: text("artifact_object_key"),
    artifactSha256: text("artifact_sha256"),
    artifactByteLength: integer("artifact_byte_length"),
    errorCode: text("error_code"),
    reconciliationReason: text("reconciliation_reason"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    check(
      "decision_memos_status_enum",
      sql`${table.status} IN ('NOT_STARTED', 'RUNNING', 'FAILED', 'READY')`,
    ),
    check(
      "decision_memos_updated_at_nonnegative",
      sql`${table.updatedAtMs} >= 0`,
    ),
    check(
      "decision_memos_artifact_reference_complete",
      sql`(
        ${table.artifactNamespace} IS NULL
        AND ${table.artifactObjectKey} IS NULL
        AND ${table.artifactSha256} IS NULL
        AND ${table.artifactByteLength} IS NULL
      ) OR (
        ${table.artifactNamespace} = 'decision-memos'
        AND ${table.artifactObjectKey} IS NOT NULL
        AND ${table.artifactSha256} IS NOT NULL
        AND ${table.artifactByteLength} >= 0
      )`,
    ),
  ],
);

export const usageBudgets = sqliteTable(
  "usage_budgets",
  {
    bucketStartedAtMs: integer("bucket_started_at_ms").primaryKey(),
    reservedRunCount: integer("reserved_run_count").notNull().default(0),
    confirmedRunCount: integer("confirmed_run_count").notNull().default(0),
    reservedCostMicroUsd: integer("reserved_cost_micro_usd").notNull().default(0),
    confirmedCostMicroUsd: integer("confirmed_cost_micro_usd").notNull().default(0),
    failedRequestCostMicroUsd: integer("failed_request_cost_micro_usd")
      .notNull()
      .default(0),
    lastReservationToken: text("last_reservation_token"),
    lastReconciliationToken: text("last_reconciliation_token"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    check(
      "usage_budgets_bucket_started_at_nonnegative",
      sql`${table.bucketStartedAtMs} >= 0`,
    ),
    check(
      "usage_budgets_values_nonnegative",
      sql`${table.reservedRunCount} >= 0
        AND ${table.confirmedRunCount} >= 0
        AND ${table.reservedCostMicroUsd} >= 0
        AND ${table.confirmedCostMicroUsd} >= 0
        AND ${table.failedRequestCostMicroUsd} >= 0
        AND ${table.updatedAtMs} >= 0`,
    ),
  ],
);

export const schema = {
  demoSessions,
  authFailureBuckets,
  executions,
  humanReviews,
  candidateSelections,
  decisionMemos,
  usageBudgets,
};

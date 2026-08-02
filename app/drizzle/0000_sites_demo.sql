CREATE TABLE `auth_failure_buckets` (
	`network_fingerprint` text NOT NULL,
	`bucket_started_at_ms` integer NOT NULL,
	`failure_count` integer NOT NULL,
	`blocked_until_ms` integer,
	PRIMARY KEY(`network_fingerprint`, `bucket_started_at_ms`),
	CONSTRAINT "auth_failure_buckets_started_at_nonnegative" CHECK("auth_failure_buckets"."bucket_started_at_ms" >= 0),
	CONSTRAINT "auth_failure_buckets_failure_count_positive" CHECK("auth_failure_buckets"."failure_count" >= 1),
	CONSTRAINT "auth_failure_buckets_blocked_until_nonnegative" CHECK("auth_failure_buckets"."blocked_until_ms" IS NULL OR "auth_failure_buckets"."blocked_until_ms" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_failure_buckets_latest_idx` ON `auth_failure_buckets` (`network_fingerprint`,`bucket_started_at_ms`);--> statement-breakpoint
CREATE TABLE `candidate_selections` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`rationale` text NOT NULL,
	`source_hash` text NOT NULL,
	`selected_at_ms` integer NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `executions`(`execution_id`) ON UPDATE restrict ON DELETE cascade,
	CONSTRAINT "candidate_selections_candidate_id_enum" CHECK("candidate_selections"."candidate_id" IN ('A', 'B', 'C')),
	CONSTRAINT "candidate_selections_selected_at_nonnegative" CHECK("candidate_selections"."selected_at_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE `decision_memos` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`source_pack_hash` text NOT NULL,
	`review_hash` text,
	`selection_hash` text,
	`artifact_namespace` text,
	`artifact_object_key` text,
	`artifact_sha256` text,
	`artifact_byte_length` integer,
	`error_code` text,
	`reconciliation_reason` text,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `executions`(`execution_id`) ON UPDATE restrict ON DELETE cascade,
	CONSTRAINT "decision_memos_status_enum" CHECK("decision_memos"."status" IN ('NOT_STARTED', 'RUNNING', 'FAILED', 'READY')),
	CONSTRAINT "decision_memos_updated_at_nonnegative" CHECK("decision_memos"."updated_at_ms" >= 0),
	CONSTRAINT "decision_memos_artifact_reference_complete" CHECK((
        "decision_memos"."artifact_namespace" IS NULL
        AND "decision_memos"."artifact_object_key" IS NULL
        AND "decision_memos"."artifact_sha256" IS NULL
        AND "decision_memos"."artifact_byte_length" IS NULL
      ) OR (
        "decision_memos"."artifact_namespace" = 'decision-memos'
        AND "decision_memos"."artifact_object_key" IS NOT NULL
        AND "decision_memos"."artifact_sha256" IS NOT NULL
        AND "decision_memos"."artifact_byte_length" >= 0
      ))
);
--> statement-breakpoint
CREATE TABLE `demo_sessions` (
	`session_token_digest` text PRIMARY KEY NOT NULL,
	`created_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`revoked_at_ms` integer,
	`successful_live_runs` integer DEFAULT 0 NOT NULL,
	`operational_retry_count` integer DEFAULT 0 NOT NULL,
	`current_execution_id` text,
	CONSTRAINT "demo_sessions_created_at_nonnegative" CHECK("demo_sessions"."created_at_ms" >= 0),
	CONSTRAINT "demo_sessions_expiry_after_creation" CHECK("demo_sessions"."expires_at_ms" > "demo_sessions"."created_at_ms"),
	CONSTRAINT "demo_sessions_revoked_at_nonnegative" CHECK("demo_sessions"."revoked_at_ms" IS NULL OR "demo_sessions"."revoked_at_ms" >= 0),
	CONSTRAINT "demo_sessions_successful_runs_nonnegative" CHECK("demo_sessions"."successful_live_runs" >= 0),
	CONSTRAINT "demo_sessions_retry_count_nonnegative" CHECK("demo_sessions"."operational_retry_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE `executions` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`session_token_digest` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`progress_step` text NOT NULL,
	`current_candidate` text,
	`completed_candidate_count` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`started_at_ms` integer,
	`heartbeat_at_ms` integer,
	`completed_at_ms` integer,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`cleanup_status` text DEFAULT 'NOT_STARTED' NOT NULL,
	`lease_token_digest` text,
	`lease_expires_at_ms` integer,
	`evaluation_pack_namespace` text,
	`evaluation_pack_object_key` text,
	`evaluation_pack_sha256` text,
	`evaluation_pack_byte_length` integer,
	`public_projection_namespace` text,
	`public_projection_object_key` text,
	`public_projection_sha256` text,
	`public_projection_byte_length` integer,
	`cleanup_receipt_namespace` text,
	`cleanup_receipt_object_key` text,
	`cleanup_receipt_sha256` text,
	`cleanup_receipt_byte_length` integer,
	`budget_bucket_started_at_ms` integer,
	`reserved_cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`actual_cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`cost_reconciled_at_ms` integer,
	`source_hash` text NOT NULL,
	`state_version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`session_token_digest`) REFERENCES `demo_sessions`(`session_token_digest`) ON UPDATE restrict ON DELETE cascade,
	CONSTRAINT "executions_source_enum" CHECK("executions"."source" IN ('LIVE', 'RECORDED_FALLBACK')),
	CONSTRAINT "executions_status_enum" CHECK("executions"."status" IN ('READY', 'RUNNING', 'INTERRUPTED', 'FAILED', 'RESULTS_READY', 'JUDGE_READY', 'REVIEW_READY', 'NO_APPROVED_CANDIDATE', 'SELECTION_RECORDED', 'MEMO_RUNNING', 'MEMO_FAILED', 'MEMO_READY', 'REGRESSION_BLOCK')),
	CONSTRAINT "executions_current_candidate_enum" CHECK("executions"."current_candidate" IS NULL OR "executions"."current_candidate" IN ('A', 'B', 'C')),
	CONSTRAINT "executions_completed_candidate_count_range" CHECK("executions"."completed_candidate_count" BETWEEN 0 AND 3),
	CONSTRAINT "executions_timestamps_nonnegative" CHECK("executions"."created_at_ms" >= 0
        AND ("executions"."started_at_ms" IS NULL OR "executions"."started_at_ms" >= 0)
        AND ("executions"."heartbeat_at_ms" IS NULL OR "executions"."heartbeat_at_ms" >= 0)
        AND ("executions"."completed_at_ms" IS NULL OR "executions"."completed_at_ms" >= 0)
        AND ("executions"."lease_expires_at_ms" IS NULL OR "executions"."lease_expires_at_ms" >= 0)),
	CONSTRAINT "executions_retry_count_nonnegative" CHECK("executions"."retry_count" >= 0),
	CONSTRAINT "executions_cleanup_status_enum" CHECK("executions"."cleanup_status" IN ('NOT_STARTED', 'RUNNING', 'ACKNOWLEDGED', 'FAILED')),
	CONSTRAINT "executions_cost_nonnegative" CHECK("executions"."reserved_cost_micro_usd" >= 0 AND "executions"."actual_cost_micro_usd" >= 0),
	CONSTRAINT "executions_budget_timestamps_nonnegative" CHECK(("executions"."budget_bucket_started_at_ms" IS NULL OR "executions"."budget_bucket_started_at_ms" >= 0)
        AND ("executions"."cost_reconciled_at_ms" IS NULL OR "executions"."cost_reconciled_at_ms" >= 0)),
	CONSTRAINT "executions_state_version_nonnegative" CHECK("executions"."state_version" >= 0),
	CONSTRAINT "executions_evaluation_pack_reference_complete" CHECK((
        "executions"."evaluation_pack_namespace" IS NULL
        AND "executions"."evaluation_pack_object_key" IS NULL
        AND "executions"."evaluation_pack_sha256" IS NULL
        AND "executions"."evaluation_pack_byte_length" IS NULL
      ) OR (
        "executions"."evaluation_pack_namespace" IS NOT NULL
        AND "executions"."evaluation_pack_object_key" IS NOT NULL
        AND "executions"."evaluation_pack_sha256" IS NOT NULL
        AND "executions"."evaluation_pack_byte_length" >= 0
      )),
	CONSTRAINT "executions_public_projection_reference_complete" CHECK((
        "executions"."public_projection_namespace" IS NULL
        AND "executions"."public_projection_object_key" IS NULL
        AND "executions"."public_projection_sha256" IS NULL
        AND "executions"."public_projection_byte_length" IS NULL
      ) OR (
        "executions"."public_projection_namespace" IN ('candidate-evidence', 'recorded-fallback')
        AND "executions"."public_projection_object_key" IS NOT NULL
        AND "executions"."public_projection_sha256" IS NOT NULL
        AND "executions"."public_projection_byte_length" >= 0
      )),
	CONSTRAINT "executions_cleanup_receipt_reference_complete" CHECK((
        "executions"."cleanup_receipt_namespace" IS NULL
        AND "executions"."cleanup_receipt_object_key" IS NULL
        AND "executions"."cleanup_receipt_sha256" IS NULL
        AND "executions"."cleanup_receipt_byte_length" IS NULL
      ) OR (
        "executions"."cleanup_receipt_namespace" IS NOT NULL
        AND "executions"."cleanup_receipt_object_key" IS NOT NULL
        AND "executions"."cleanup_receipt_sha256" IS NOT NULL
        AND "executions"."cleanup_receipt_byte_length" >= 0
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `executions_idempotency_key_unique` ON `executions` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `executions_one_active_per_session_idx` ON `executions` (`session_token_digest`) WHERE "executions"."status" NOT IN ('INTERRUPTED', 'FAILED', 'NO_APPROVED_CANDIDATE', 'REGRESSION_BLOCK');--> statement-breakpoint
CREATE TABLE `human_reviews` (
	`execution_id` text NOT NULL,
	`blind_label` text NOT NULL,
	`decision` text NOT NULL,
	`rationale` text NOT NULL,
	`corrected_reply` text,
	`review_duration_ms` integer NOT NULL,
	`edit_duration_ms` integer NOT NULL,
	`confirmed_at_ms` integer NOT NULL,
	`source_hash` text NOT NULL,
	PRIMARY KEY(`execution_id`, `blind_label`),
	FOREIGN KEY (`execution_id`) REFERENCES `executions`(`execution_id`) ON UPDATE restrict ON DELETE cascade,
	CONSTRAINT "human_reviews_blind_label_enum" CHECK("human_reviews"."blind_label" IN ('X', 'Y', 'Z')),
	CONSTRAINT "human_reviews_decision_enum" CHECK("human_reviews"."decision" IN ('PASS', 'CONFIRMED_FAIL')),
	CONSTRAINT "human_reviews_durations_nonnegative" CHECK("human_reviews"."review_duration_ms" >= 0 AND "human_reviews"."edit_duration_ms" >= 0),
	CONSTRAINT "human_reviews_confirmed_at_nonnegative" CHECK("human_reviews"."confirmed_at_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE `usage_budgets` (
	`bucket_started_at_ms` integer PRIMARY KEY NOT NULL,
	`reserved_run_count` integer DEFAULT 0 NOT NULL,
	`confirmed_run_count` integer DEFAULT 0 NOT NULL,
	`reserved_cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`confirmed_cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`failed_request_cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`last_reservation_token` text,
	`last_reconciliation_token` text,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "usage_budgets_bucket_started_at_nonnegative" CHECK("usage_budgets"."bucket_started_at_ms" >= 0),
	CONSTRAINT "usage_budgets_values_nonnegative" CHECK("usage_budgets"."reserved_run_count" >= 0
        AND "usage_budgets"."confirmed_run_count" >= 0
        AND "usage_budgets"."reserved_cost_micro_usd" >= 0
        AND "usage_budgets"."confirmed_cost_micro_usd" >= 0
        AND "usage_budgets"."failed_request_cost_micro_usd" >= 0
        AND "usage_budgets"."updated_at_ms" >= 0)
);

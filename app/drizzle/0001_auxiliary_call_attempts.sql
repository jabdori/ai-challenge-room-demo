CREATE TABLE `auxiliary_call_attempts` (
	`execution_id` text NOT NULL,
	`session_token_digest` text NOT NULL,
	`kind` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`source_hash` text NOT NULL,
	`reserved_state_version` integer NOT NULL,
	`bucket_started_at_ms` integer NOT NULL,
	`status` text NOT NULL,
	`reserved_at_ms` integer NOT NULL,
	`completed_at_ms` integer,
	`error_code` text,
	PRIMARY KEY(`execution_id`, `kind`, `attempt_number`),
	FOREIGN KEY (`execution_id`) REFERENCES `executions`(`execution_id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`session_token_digest`) REFERENCES `demo_sessions`(`session_token_digest`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "auxiliary_call_attempts_kind_enum" CHECK(`kind` IN ('JUDGE', 'MEMO')),
	CONSTRAINT "auxiliary_call_attempts_attempt_number_range" CHECK(`attempt_number` IN (1, 2)),
	CONSTRAINT "auxiliary_call_attempts_status_enum" CHECK(`status` IN ('RESERVED', 'COMPLETE', 'FAILED')),
	CONSTRAINT "auxiliary_call_attempts_values_nonnegative" CHECK(
		`reserved_state_version` >= 0
		AND `bucket_started_at_ms` >= 0
		AND `reserved_at_ms` >= 0
		AND (`completed_at_ms` IS NULL OR `completed_at_ms` >= `reserved_at_ms`)
	),
	CONSTRAINT "auxiliary_call_attempts_completion_consistent" CHECK(
		(`status` = 'RESERVED' AND `completed_at_ms` IS NULL AND `error_code` IS NULL)
		OR (`status` = 'COMPLETE' AND `completed_at_ms` IS NOT NULL AND `error_code` IS NULL)
		OR (`status` = 'FAILED' AND `completed_at_ms` IS NOT NULL AND `error_code` IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE INDEX `auxiliary_call_attempts_bucket_idx`
	ON `auxiliary_call_attempts` (`bucket_started_at_ms`);

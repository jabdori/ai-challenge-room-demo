import { CircleNotch, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { LiveDemoExecution } from "../../data/sitesDemoApi";
import { StatusBadge } from "../../components/StatusBadge";

interface LiveComparisonProgressProps {
  readonly execution: LiveDemoExecution;
}

function progressLabel(step: string): string {
  if (
    step === "READY"
    || step === "ENVIRONMENT_PREPARING"
    || step === "ENVIRONMENT_PREPARED"
  ) {
    return "Preparing the evaluation environment";
  }
  if (
    step === "CANDIDATE_A_RESPONSE_STARTED"
    || step === "CANDIDATE_A_RESPONSE_FINISHED"
    || step.startsWith("CANDIDATE_ATTEMPT_STARTED:A")
  ) {
    return "Candidate A response generation";
  }
  if (
    step === "CANDIDATE_B_RETRIEVAL_STARTED"
    || step === "CANDIDATE_B_RETRIEVAL_FINISHED"
  ) {
    return "Candidate B policy retrieval";
  }
  if (
    step === "CANDIDATE_B_RESPONSE_STARTED"
    || step === "CANDIDATE_B_RESPONSE_FINISHED"
  ) {
    return "Candidate B response generation";
  }
  if (
    step === "CANDIDATE_C_TOOL_STARTED:get_order"
    || step === "CANDIDATE_C_TOOL_FINISHED:get_order"
  ) {
    return "Candidate C order lookup";
  }
  if (
    step === "CANDIDATE_C_TOOL_STARTED:search_policy"
    || step === "CANDIDATE_C_TOOL_FINISHED:search_policy"
  ) {
    return "Candidate C policy retrieval";
  }
  if (
    step === "CANDIDATE_C_MODEL_TURN_STARTED"
    || step === "CANDIDATE_C_MODEL_TURN_FINISHED"
    || step === "CANDIDATE_C_RESPONSE_FINISHED"
  ) {
    return "Candidate C response generation";
  }
  if (step.startsWith("CANDIDATE_RETRY_")) {
    return "Retrying the current candidate operation";
  }
  if (step === "HARD_GATES_STARTED" || step === "HARD_GATES_FINISHED") {
    return "Applying deterministic policy gates";
  }
  if (step === "RESULTS_PERSISTING" || step === "RESULTS_PERSISTED") {
    return "Preparing comparable results";
  }
  if (step === "REMOTE_CLEANUP_STARTED") {
    return "Recording remote-resource cleanup acknowledgements";
  }
  if (step === "REMOTE_CLEANUP_FINISHED" || step === "RESULTS_READY") {
    return "Comparison results ready";
  }
  if (step === "RECORDED_FALLBACK_READY") {
    return "Recorded fallback ready";
  }
  return step.replaceAll("_", " ").toLowerCase();
}

function cleanupLabel(
  status: LiveDemoExecution["cleanup_status"],
): string {
  if (status === "RUNNING") return "Cleanup acknowledgement in progress";
  if (status === "ACKNOWLEDGED") return "Cleanup API acknowledgement recorded";
  if (status === "FAILED") return "Cleanup acknowledgement failed";
  return "Cleanup not started";
}

function formatElapsed(execution: LiveDemoExecution, now: number): string {
  const start = execution.started_at_ms ?? execution.created_at_ms;
  const end = execution.completed_at_ms ?? now;
  return `${Math.max(0, Math.floor((end - start) / 1_000))}s`;
}

export function LiveComparisonProgress({
  execution,
}: LiveComparisonProgressProps) {
  const [now, setNow] = useState(() => Date.now());
  const failed = execution.status === "FAILED"
    || execution.status === "INTERRUPTED"
    || execution.error_code !== null;

  useEffect(() => {
    if (execution.completed_at_ms !== null || failed) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [execution.completed_at_ms, failed]);

  return (
    <section
      className={`demo-comparison-progress${failed ? " demo-comparison-progress--failed" : ""}`}
      role={failed ? "alert" : "status"}
      aria-label="Live comparison progress"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="demo-comparison-progress__lead">
        {failed ? (
          <WarningCircle aria-hidden="true" />
        ) : (
          <CircleNotch
            className={execution.status === "RUNNING"
              && execution.error_code === null
              ? "demo-live-progress__spinner"
              : undefined}
            aria-hidden="true"
          />
        )}
        <div>
          <span className="section-kicker">
            {failed ? "LIVE COMPARISON STOPPED" : "LIVE COMPARISON"}
          </span>
          <strong>{progressLabel(execution.progress_step)}</strong>
          <small>
            {failed
              ? `Execution evidence was retained · ${execution.error_code ?? "UNKNOWN_ERROR"}`
              : "Synthetic data only · no purchase, deployment, contract, or rollback is performed."}
          </small>
        </div>
        <StatusBadge tone={failed ? "block" : "review"}>
          {execution.status}
        </StatusBadge>
      </div>
      <dl className="demo-comparison-progress__facts">
        <div>
          <dt>Current candidate</dt>
          <dd>{execution.current_candidate ?? "—"}</dd>
        </div>
        <div>
          <dt>Progress</dt>
          <dd>{execution.completed_candidate_count} / 3 candidates complete</dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd>{formatElapsed(execution, now)}</dd>
        </div>
        <div>
          <dt>Retries</dt>
          <dd>{execution.retry_count > 0 ? `Retry ${execution.retry_count}` : "No retries"}</dd>
        </div>
        <div>
          <dt>Cleanup</dt>
          <dd>{cleanupLabel(execution.cleanup_status)}</dd>
        </div>
      </dl>
    </section>
  );
}

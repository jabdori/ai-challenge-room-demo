import { useState } from "react";
import {
  ArrowRight,
  Clock,
  Coins,
  Gauge,
  ShieldWarning,
} from "@phosphor-icons/react";
import { StatusBadge } from "../../components/StatusBadge";

type CandidateId = "A" | "B" | "C";

export interface CompareSlotView {
  readonly evidence_id: string;
  readonly case_id: string;
  readonly candidate_id: CandidateId;
  readonly repetition: 1 | 2;
  readonly execution_status: string;
  readonly evaluation_status: string;
  readonly hard_gate_status: "PASS" | "CONFIRMED_FAIL" | "NOT_EVALUATED";
  readonly cost_usd: number | null;
  readonly latency_ms: number;
}

export interface CompareCandidateAggregateView {
  readonly candidate_id: CandidateId;
  readonly counts: {
    readonly scheduled_runs: number;
    readonly complete_runs: number;
    readonly invalid_runs: number;
    readonly timeout_runs: number;
    readonly budget_exceeded_runs: number;
    readonly hard_gate_failed_runs: number;
    readonly hard_gate_failed_cases: number;
    readonly policy_applicable_cases: number;
    readonly policy_success_cases: number;
    readonly citation_required_cases: number;
    readonly citation_success_cases: number;
    readonly escalation_required_cases: number;
    readonly escalation_success_cases: number;
  };
  readonly cost: {
    readonly average_usd_per_ticket: number | null;
  };
  readonly latency: {
    readonly median_ms: number;
    readonly worst_ms: number;
  };
  readonly stability: {
    readonly comparable_cases: number;
    readonly stable_cases: number;
    readonly unstable_cases: number;
  };
}

export interface RecordedBenchmarkProgressView {
  readonly benchmark_id: string;
  readonly source_hash: string;
  readonly source: "RECORDED_BENCHMARK";
  readonly status: "REVIEW_PENDING";
  readonly completed: 72;
  readonly total: 72;
  readonly review_time: "NOT_MEASURED" | string;
  readonly edit_time: "NOT_MEASURED" | string;
  readonly auxiliary_judge: {
    readonly complete: number;
    readonly human_fallback: number;
    readonly total: 12;
  };
  readonly candidate_aggregates: readonly CompareCandidateAggregateView[];
  readonly slots: readonly CompareSlotView[];
}

export type CompareLifecyclePhase =
  | "BENCHMARK"
  | "JUDGE"
  | "CLEANUP";

export type CompareResumeAction =
  | "NONE"
  | "CONTINUE_FROM_PERSISTED_CHECKPOINTS"
  | "RETRY_CLEANUP"
  | "RESTART_AFTER_FIX";

export type CompareCheckpointSource =
  | "EXECUTED"
  | "RECOMPUTED_GATES"
  | "REUSED_CHECKPOINT";

export interface CompareCleanupView {
  readonly required: 33;
  readonly acknowledged: number;
  readonly incomplete: number;
}

interface CompareLifecycleBaseView {
  readonly benchmark_id: string;
  readonly source_hash: string;
  readonly source: "RECORDED_BENCHMARK";
  readonly completed: number;
  readonly total: 72;
  readonly last_slot_sequence: number | null;
  readonly checkpoint_source: CompareCheckpointSource | null;
  readonly cleanup: CompareCleanupView | null;
  /** 이전 기록 projection과의 호환을 위한 선택적 상세 슬롯입니다. */
  readonly terminal_slots?: readonly CompareSlotView[];
}

export interface CompareReadyView extends CompareLifecycleBaseView {
  readonly status: "READY";
  readonly completed: 0;
  readonly last_slot_sequence: null;
  readonly checkpoint_source: null;
  readonly cleanup: null;
}

export interface CompareRunningView extends CompareLifecycleBaseView {
  readonly status: "RUNNING";
  readonly cleanup: null;
}

export interface CompareCompleteTransitionView extends CompareLifecycleBaseView {
  readonly status: "COMPLETE";
  readonly completed: 72;
  readonly last_slot_sequence: 72;
  readonly cleanup: CompareCleanupView;
}

export interface CompareInvalidView extends CompareLifecycleBaseView {
  readonly status: "INVALID";
  readonly failure: {
    readonly code: string;
    readonly phase: CompareLifecyclePhase;
  };
  readonly resume: {
    readonly allowed: true;
    readonly action: CompareResumeAction;
    readonly from_progress_hash?: string | null;
  };
}

export type CompareBenchmarkView =
  | CompareReadyView
  | CompareRunningView
  | CompareCompleteTransitionView
  | CompareInvalidView
  | RecordedBenchmarkProgressView;

export interface CompareExecutionRequest {
  readonly actorLabel: string;
  readonly executionMode: "START" | "RESUME";
  readonly acknowledgement: "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12";
  readonly resumeFromProgressHash: string | null;
}

const candidateSpecs = {
  A: { name: "Single LLM", configuration: "One model call · full locked context", tier: "T1" },
  B: { name: "Retrieval RAG", configuration: "Runner-owned search · one model call", tier: "T2" },
  C: { name: "Read-only tool workflow", configuration: "Policy search · order lookup · bounded loop", tier: "T3" },
} as const;

const BENCHMARK_ACKNOWLEDGEMENT =
  "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12" as const;

type LegacyLifecycleCounters = {
  readonly candidate_execution?: {
    readonly completed?: number;
    readonly total?: number;
  };
  readonly auxiliary_judge?: {
    readonly completed?: number;
    readonly total?: number;
  };
};

function lifecycleCompleted(benchmark: {
  readonly completed?: number;
} & LegacyLifecycleCounters): number {
  return benchmark.completed
    ?? benchmark.candidate_execution?.completed
    ?? 0;
}

function lifecycleTotal(benchmark: {
  readonly total?: number;
} & LegacyLifecycleCounters): number {
  return benchmark.total
    ?? benchmark.candidate_execution?.total
    ?? 72;
}

function lifecycleJudge(benchmark: unknown): string {
  const counters = benchmark as {
    readonly auxiliary_judge?: {
      readonly completed?: number;
      readonly total?: number;
    };
  };
  const completed = counters.auxiliary_judge?.completed;
  const total = counters.auxiliary_judge?.total;
  return typeof completed === "number" && typeof total === "number"
    ? `${completed} / ${total}`
    : "WITHHELD";
}

function lifecycleLastSequence(benchmark: {
  readonly last_slot_sequence?: number | null;
  readonly terminal_slots?: readonly CompareSlotView[];
}): number | null {
  return benchmark.last_slot_sequence
    ?? (benchmark.terminal_slots?.length ? benchmark.terminal_slots.length : null);
}

function lifecycleCheckpointSource(benchmark: {
  readonly checkpoint_source?: CompareCheckpointSource | null;
  readonly terminal_slots?: readonly CompareSlotView[];
}): CompareCheckpointSource | null {
  return benchmark.checkpoint_source
    ?? (benchmark.terminal_slots?.length ? "EXECUTED" : null);
}

function money(value: number | null): string {
  return value === null ? "COST INCOMPLETE" : `$${value.toFixed(5)}`;
}

function statusTone(slot: CompareSlotView): "pass" | "fail" | "review" | "run-error" {
  if (slot.hard_gate_status === "CONFIRMED_FAIL") return "fail";
  if (slot.execution_status !== "COMPLETE") return "run-error";
  if (slot.evaluation_status !== "EVALUATED") return "review";
  return "pass";
}

function cellLabel(slot: CompareSlotView): string {
  if (slot.hard_gate_status === "CONFIRMED_FAIL") return "GATE FAIL";
  if (slot.execution_status !== "COMPLETE") return slot.execution_status;
  return slot.evaluation_status === "EVALUATED" ? "PASS" : "NOT EVALUATED";
}

function slotFor(
  benchmark: RecordedBenchmarkProgressView,
  caseId: string,
  candidateId: CandidateId,
  repetition: 1 | 2,
): CompareSlotView {
  const slot = benchmark.slots.find((item) => (
    item.case_id === caseId
    && item.candidate_id === candidateId
    && item.repetition === repetition
  ));
  if (!slot) throw new Error(`Compare projection slot이 없습니다: ${caseId}:${candidateId}:${repetition}`);
  return slot;
}

function CandidateSpecCards({ lifecycle = false }: { readonly lifecycle?: boolean }) {
  return (
    <section className="candidate-spec-grid" aria-label="Candidate configurations">
      {(Object.keys(candidateSpecs) as CandidateId[]).map((candidateId) => {
        const spec = candidateSpecs[candidateId];
        return (
          <article key={candidateId} className="candidate-spec-card">
            <b>{candidateId}</b>
            <div>
              <strong>{lifecycle ? `Candidate ${candidateId} · ${spec.name}` : spec.name}</strong>
              <span>{spec.configuration}</span>
            </div>
            <span>{spec.tier}</span>
          </article>
        );
      })}
    </section>
  );
}

function BenchmarkLifecycleLedger({
  benchmark,
}: {
  readonly benchmark:
    | CompareReadyView
    | CompareRunningView
    | CompareCompleteTransitionView
    | CompareInvalidView;
}) {
  return (
    <section
      className="benchmark-lifecycle-ledger"
      aria-label="Benchmark execution lifecycle"
    >
      <div>
        <span>Candidate execution</span>
        <strong data-numeric="true">
          {lifecycleCompleted(benchmark)} / {lifecycleTotal(benchmark)}
        </strong>
      </div>
      <div>
        <span>Auxiliary Judge</span>
        <strong>{lifecycleJudge(benchmark)}</strong>
      </div>
      <div>
        <span>Resource cleanup</span>
        <strong data-numeric={benchmark.cleanup === null ? undefined : "true"}>
          {benchmark.cleanup === null
            ? "NOT RECORDED"
            : `${benchmark.cleanup.acknowledged} / ${benchmark.cleanup.required}`}
        </strong>
      </div>
      <div>
        <span>Last sequence</span>
        <strong data-numeric={lifecycleLastSequence(benchmark) === null ? undefined : "true"}>
          {lifecycleLastSequence(benchmark) ?? "NONE"}
        </strong>
      </div>
    </section>
  );
}

function PublicCheckpointSummary({
  benchmark,
}: {
  readonly benchmark:
    | CompareReadyView
    | CompareRunningView
    | CompareCompleteTransitionView
    | CompareInvalidView;
}) {
  const terminalSlots = benchmark.terminal_slots ?? [];
  return (
    <div className="benchmark-checkpoint-summary">
      <div>
        <span>Last persisted sequence</span>
        <strong data-numeric={lifecycleLastSequence(benchmark) === null ? undefined : "true"}>
          {lifecycleLastSequence(benchmark) ?? "NONE"}
        </strong>
      </div>
      <div>
        <span>Checkpoint source</span>
        <strong>
          {lifecycleCheckpointSource(benchmark)?.replaceAll("_", " ") ?? "NOT RECORDED"}
        </strong>
      </div>
      <p>
        Individual slot details and private journal hashes remain withheld until
        the complete Recorded Benchmark pack passes the review gateway.
      </p>
      {terminalSlots.length > 0 ? (
        <table aria-label="Source-confirmed terminal checkpoints">
          <thead>
            <tr>
              <th>Case</th>
              <th>Candidate</th>
              <th>Repetition</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {terminalSlots.map((slot) => (
              <tr key={slot.evidence_id}>
                <td>{slot.case_id}</td>
                <td>Candidate {slot.candidate_id}</td>
                <td>{slot.repetition}</td>
                <td>{cellLabel(slot)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function CompareLifecycleStage({
  benchmark,
  onStart,
  onResume,
  mutationPending,
  mobileReadOnly,
}: {
  readonly benchmark:
    | CompareReadyView
    | CompareRunningView
    | CompareCompleteTransitionView
    | CompareInvalidView;
  readonly onStart?: (request: CompareExecutionRequest) => void;
  readonly onResume?: (request: CompareExecutionRequest) => void;
  readonly mutationPending: boolean;
  readonly mobileReadOnly: boolean;
}) {
  const [actorLabel, setActorLabel] = useState("");
  const isReady = benchmark.status === "READY";
  const isRunning = benchmark.status === "RUNNING";
  const isInvalid = benchmark.status === "INVALID";
  const isComplete = benchmark.status === "COMPLETE";
  const callback = isReady ? onStart : isInvalid ? onResume : undefined;
  const canMutate = callback !== undefined
    && !mobileReadOnly
    && !mutationPending
    && actorLabel.trim().length > 0
    && (
      isReady
      || (
        isInvalid
        && benchmark.resume.allowed
      )
    );
  const completed = lifecycleCompleted(benchmark);
  const total = lifecycleTotal(benchmark);
  const queued = total - completed;

  const submit = () => {
    if (!canMutate || callback === undefined) return;
    callback({
      actorLabel: actorLabel.trim(),
      executionMode: isReady ? "START" : "RESUME",
      acknowledgement: BENCHMARK_ACKNOWLEDGEMENT,
      resumeFromProgressHash: isReady
        ? null
        : benchmark.resume.from_progress_hash ?? benchmark.source_hash,
    });
  };

  return (
    <div className="page-stack compare-stage compare-lifecycle">
      <header className="page-header">
        <div>
          <span className="page-index">02 / COMPARE · SAME WORK, SAME CONTRACT</span>
          <h1>
            {isReady && "Run every candidate against the locked Benchmark."}
            {isRunning && "Follow persisted execution checkpoints."}
            {isComplete && "Recorded evidence is being promoted for review."}
            {isInvalid && "The Benchmark stopped without a valid aggregate."}
          </h1>
          <p>
            Three configurations share the same hidden 12-case schedule and two
            fixed repetitions. Fatal failures remain separate from averages.
          </p>
        </div>
        <div className="page-header__status">
          <div className="page-status-badges">
            <StatusBadge
              tone={isInvalid ? "fail" : isRunning ? "live" : isComplete ? "pass" : "review"}
              compact
            >
              {benchmark.status}
            </StatusBadge>
            <StatusBadge tone="recorded" compact>SYNTHETIC DATA</StatusBadge>
          </div>
          <span>
            {benchmark.benchmark_id.slice(0, 14)}… · source {benchmark.source_hash.slice(0, 8)}…
          </span>
        </div>
      </header>

      <CandidateSpecCards lifecycle />

      {isInvalid && benchmark.failure !== null && (
        <section className="compare-invalid-banner" role="alert">
          <ShieldWarning size={24} weight="fill" />
          <div>
            <span>GLOBAL EVALUATION ERROR · {benchmark.failure.phase}</span>
            <strong>{benchmark.failure.code}</strong>
            <p>
              No partial aggregate, recommendation, or baseline was created.
              Any recorded cleanup evidence remains visible below.
            </p>
          </div>
        </section>
      )}

      {isComplete && (
        <section className="compare-clear-banner" aria-label="Recorded Benchmark handoff">
          <Gauge size={20} />
          <div>
            <strong>72 persisted runs and 33 cleanup acknowledgements verified</strong>
            <span>
              Completion receipt verified; recorded-review handoff pending.
              Aggregate evidence remains withheld until the gateway returns the
              full source-reloaded pack.
            </span>
          </div>
        </section>
      )}

      <BenchmarkLifecycleLedger benchmark={benchmark} />

      <section className="section-panel" aria-labelledby="checkpoint-title">
        <div className="section-heading section-heading--split">
          <div>
            <span className="section-kicker"><Gauge size={14} /> PERSISTED CHECKPOINTS</span>
            <h2 id="checkpoint-title">
              {completed} / {total} TERMINAL
            </h2>
            <p>
              This public view reports only the persisted journal count, latest
              sequence, and checkpoint source. No in-flight slot is predicted.
            </p>
          </div>
          <StatusBadge tone={queued === 0 ? "pass" : "neutral"} compact>
            {`${queued} QUEUED`}
          </StatusBadge>
        </div>
        <PublicCheckpointSummary benchmark={benchmark} />
      </section>

      {isInvalid && (
        <section className="benchmark-cleanup-receipt">
          <div>
            <span>REMOTE RESOURCE CLEANUP</span>
            <strong>
              {benchmark.cleanup === null
                ? "NOT YET RECORDED"
                : `${benchmark.cleanup.acknowledged} / 33 ACKNOWLEDGED`}
            </strong>
          </div>
          <StatusBadge
            tone={
              benchmark.cleanup === null
                ? "neutral"
                : benchmark.cleanup.incomplete === 0
                  ? "pass"
                  : "fail"
            }
            compact
          >
            {benchmark.cleanup === null
              ? "CLEANUP PENDING"
              : `${benchmark.cleanup.incomplete} INCOMPLETE`}
          </StatusBadge>
          <p>
            Resume action: {benchmark.resume.action.replaceAll("_", " ")}.
            Existing acknowledgements are preserved.
          </p>
        </section>
      )}

      {(isReady || isInvalid) && (
        <section className="section-panel compare-lifecycle-action">
          <div className="section-heading">
            <span className="section-kicker">
              {isReady ? "EXPLICIT EXECUTION START" : "CONTROLLED RESUME"}
            </span>
            <h2>
              {isReady
                ? "Start the recorded 72 + 12 evaluation"
                : "Resume only from this public progress revision"}
            </h2>
            <p>
              The browser sends no API key, hidden case, oracle, or candidate
              implementation. The local runner owns execution and cleanup.
            </p>
          </div>
          <form
            className="lifecycle-action-form"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <label>
              <span>Benchmark execution owner</span>
              <input
                aria-label="Benchmark execution owner"
                autoComplete="off"
                disabled={mobileReadOnly || mutationPending}
                onChange={(event) => setActorLabel(event.target.value)}
                value={actorLabel}
              />
            </label>
            <button
              className="button button--primary"
              disabled={!canMutate}
              type="submit"
            >
              {mutationPending
                ? "Submitting authority command…"
                : isReady
                  ? "Start recorded Benchmark"
                  : "Resume from persisted checkpoints"}
              {!mutationPending && <ArrowRight aria-hidden="true" size={16} weight="bold" />}
            </button>
          </form>
          {mobileReadOnly && (
            <p className="lifecycle-mobile-boundary">
              Changes are disabled on mobile. Start or resume from a desktop
              workspace.
            </p>
          )}
        </section>
      )}

      {isRunning && (
        <p className="compare-polling-note" role="status" aria-live="polite">
          The workspace refreshes only from persisted progress. Running slots
          remain QUEUED until their terminal checkpoint is verified.
        </p>
      )}
    </div>
  );
}

function RecordedCompareStage({
  benchmark,
  onOpenEvidence,
}: {
  readonly benchmark: RecordedBenchmarkProgressView;
  readonly onOpenEvidence?: (slot: CompareSlotView) => void;
}) {
  const caseIds = [...new Set(benchmark.slots.map((slot) => slot.case_id))].sort();
  const detailWithheld = benchmark.slots.length === 0;
  const critical = benchmark.candidate_aggregates.filter(
    (candidate) => candidate.counts.hard_gate_failed_cases > 0,
  );

  return (
    <div className="page-stack compare-stage">
      <header className="page-header">
        <div>
          <span className="page-index">02 / COMPARE · SAME WORK, SAME CONTRACT</span>
          <h1>Compare AI approaches on the same work</h1>
          <p>
            Three configurations ran against the same hidden 12-case Benchmark,
            twice per case. Fatal failures remain separate from quality, cost, and speed.
          </p>
        </div>
        <div className="page-header__status">
          <div className="page-status-badges">
            <StatusBadge tone="recorded" compact>RECORDED BENCHMARK</StatusBadge>
            <StatusBadge tone="pass" compact>{`${benchmark.completed} / ${benchmark.total} RUNS`}</StatusBadge>
          </div>
          <span>
            {benchmark.auxiliary_judge.complete} complete ·{" "}
            {benchmark.auxiliary_judge.human_fallback} human fallback
          </span>
          <span>{benchmark.benchmark_id.slice(0, 10)}… · review pending</span>
        </div>
      </header>

      <CandidateSpecCards />

      {critical.length > 0 ? (
        <section className="compare-critical-banner" aria-label="Critical gate failures">
          <ShieldWarning size={22} weight="fill" />
          <div>
            <strong>Hard-gate failures detected before aggregate comparison</strong>
            <span>{critical.map((candidate) => (
              `Candidate ${candidate.candidate_id}: ${candidate.counts.hard_gate_failed_cases} failed case${candidate.counts.hard_gate_failed_cases === 1 ? "" : "s"}`
            )).join(" · ")}</span>
          </div>
        </section>
      ) : (
        <section className="compare-clear-banner" aria-label="No deterministic gate failures">
          <ShieldWarning size={20} />
          <div><strong>No deterministic hard-gate failure in the recorded runs</strong><span>Human review and auxiliary risk signals remain pending.</span></div>
        </section>
      )}

      {detailWithheld ? (
        <section className="section-panel" aria-label="Blind review evidence withheld">
          <div className="section-heading">
            <span className="section-kicker"><Gauge size={14} /> BLIND REVIEW IN PROGRESS</span>
            <h2>Case-level execution details are withheld.</h2>
            <p>
              Case-level evidence is withheld until blind human review is confirmed.
              Aggregate hard-gate, quality, cost, speed, and stability evidence remains available below.
            </p>
          </div>
        </section>
      ) : (
        <section className="section-panel" aria-labelledby="run-matrix-title">
          <div className="section-heading section-heading--split">
            <div>
              <span className="section-kicker"><Gauge size={14} /> EXECUTION MATRIX</span>
              <h2 id="run-matrix-title">12 hidden cases × 3 candidates × 2 fixed runs</h2>
              <p>Open a cell for output, deterministic checks, Judge risks, usage, and trace evidence.</p>
            </div>
            <span className="table-note">Candidate identity is visible here; blind review uses X / Y / Z.</span>
          </div>
          <div className="table-scroll compare-matrix-scroll">
            <table className="data-table compare-run-matrix" aria-labelledby="run-matrix-title">
            <thead>
              <tr>
                <th rowSpan={2}>Case</th>
                {(["A", "B", "C"] as const).map((candidateId) => (
                  <th key={candidateId} colSpan={2}>Candidate {candidateId}</th>
                ))}
              </tr>
              <tr>
                {(["A", "B", "C"] as const).flatMap((candidateId) => ([1, 2] as const).map((repetition) => (
                  <th key={`${candidateId}-${repetition}`}>Run {repetition}</th>
                )))}
              </tr>
            </thead>
            <tbody>
              {caseIds.map((caseId) => (
                <tr key={caseId}>
                  <th scope="row">{caseId}</th>
                  {(["A", "B", "C"] as const).flatMap((candidateId) => ([1, 2] as const).map((repetition) => {
                    const slot = slotFor(benchmark, caseId, candidateId, repetition);
                    return (
                      <td key={`${candidateId}-${repetition}`}>
                        {onOpenEvidence ? (
                          <button
                            className="matrix-cell-button"
                            type="button"
                            onClick={() => onOpenEvidence(slot)}
                            aria-label={`Open evidence for ${caseId}, Candidate ${candidateId}, Run ${repetition}, ${cellLabel(slot)}`}
                          >
                            <StatusBadge tone={statusTone(slot)} compact>{cellLabel(slot)}</StatusBadge>
                            <small>{slot.latency_ms.toLocaleString()} ms</small>
                          </button>
                        ) : (
                          <div className="matrix-cell-static">
                            <StatusBadge tone={statusTone(slot)} compact>{cellLabel(slot)}</StatusBadge>
                            <small>{slot.latency_ms.toLocaleString()} ms</small>
                          </div>
                        )}
                      </td>
                    );
                  }))}
                </tr>
              ))}
            </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="section-panel" aria-labelledby="compare-dimensions-title">
        <div className="section-heading">
          <span className="section-kicker">SEPARATE DECISION DIMENSIONS</span>
          <h2 id="compare-dimensions-title">Quality, cost, speed, stability, and human time</h2>
          <p>No composite score and no automatic winner.</p>
        </div>
        <div className="table-scroll">
          <table className="data-table compare-aggregate-table" aria-labelledby="compare-dimensions-title">
            <thead><tr><th>Dimension</th><th>Candidate A</th><th>Candidate B</th><th>Candidate C</th></tr></thead>
            <tbody>
              <tr><th>Critical failed cases</th>{benchmark.candidate_aggregates.map((item) => <td key={item.candidate_id}>{item.counts.hard_gate_failed_cases} / 12</td>)}</tr>
              <tr><th>Policy decisions</th>{benchmark.candidate_aggregates.map((item) => <td key={item.candidate_id}>{item.counts.policy_success_cases} / {item.counts.policy_applicable_cases}</td>)}</tr>
              <tr><th>Citation coverage</th>{benchmark.candidate_aggregates.map((item) => <td key={item.candidate_id}>{item.counts.citation_success_cases} / {item.counts.citation_required_cases}</td>)}</tr>
              <tr><th>Escalation decisions</th>{benchmark.candidate_aggregates.map((item) => <td key={item.candidate_id}>{item.counts.escalation_success_cases} / {item.counts.escalation_required_cases}</td>)}</tr>
              <tr><th>Repeat stability</th>{benchmark.candidate_aggregates.map((item) => <td key={item.candidate_id}>{item.stability.stable_cases} / {item.stability.comparable_cases}</td>)}</tr>
              <tr><th><Coins size={14} /> Mean runtime cost</th>{benchmark.candidate_aggregates.map((item) => <td key={item.candidate_id}>{money(item.cost.average_usd_per_ticket)}</td>)}</tr>
              <tr><th><Clock size={14} /> Median / worst latency</th>{benchmark.candidate_aggregates.map((item) => <td key={item.candidate_id}>{item.latency.median_ms.toLocaleString()} / {item.latency.worst_ms.toLocaleString()} ms</td>)}</tr>
              <tr><th>Observed human review time</th>{benchmark.candidate_aggregates.map((item) => <td key={item.candidate_id}>{benchmark.review_time}</td>)}</tr>
              <tr><th>Observed edit time</th>{benchmark.candidate_aggregates.map((item) => <td key={item.candidate_id}>{benchmark.edit_time}</td>)}</tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function CompareStage({
  benchmark,
  onOpenEvidence,
  onStart,
  onResume,
  mutationPending = false,
  mobileReadOnly = false,
}: {
  readonly benchmark: CompareBenchmarkView;
  readonly onOpenEvidence?: (slot: CompareSlotView) => void;
  readonly onStart?: (request: CompareExecutionRequest) => void;
  readonly onResume?: (request: CompareExecutionRequest) => void;
  readonly mutationPending?: boolean;
  readonly mobileReadOnly?: boolean;
}) {
  if (benchmark.status === "REVIEW_PENDING") {
    return (
      <RecordedCompareStage
        benchmark={benchmark}
        onOpenEvidence={onOpenEvidence}
      />
    );
  }
  return (
    <CompareLifecycleStage
      benchmark={benchmark}
      mobileReadOnly={mobileReadOnly}
      mutationPending={mutationPending}
      onResume={onResume}
      onStart={onStart}
    />
  );
}

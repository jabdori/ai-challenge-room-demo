import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowRight,
  CheckCircle,
  CircleNotch,
  Flask,
  ShieldWarning,
  X,
} from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import {
  type DemoBlindLabel,
  type DemoCandidateId,
  type DemoRunView,
  type HackathonDemoState,
} from "../../../shared/hackathonDemo";
import { AppShell } from "../../app/AppShell";
import { StatusBadge } from "../../components/StatusBadge";
import {
  AuthExpiredError,
  confirmReviews,
  createDecisionMemo,
  createLiveComparison,
  getChallenge,
  getCurrentExecution,
  getExecution,
  getResults,
  replayRegression,
  runComparison,
  runJudge,
  selectCandidate,
  selectRecordedFallback,
  type ConfirmLiveDemoReviewsInput,
  type LiveDemoChallenge,
  type LiveDemoExecution,
  type SelectLiveDemoCandidateInput,
} from "../../data/sitesDemoApi";
import { useJudgeSessionActions } from "../access/JudgeAccessGate";
import {
  demoJudgeFailureTypePresentation,
  demoJudgeSignalPresentation,
} from "./demoPresentation";
import { LiveComparisonProgress } from "./LiveComparisonProgress";

type DemoStage = "define" | "compare" | "decide" | "monitor";
type ReviewDecision = "PASS" | "CONFIRMED_FAIL";
type DemoPendingAction =
  | "live"
  | "recorded"
  | "judge"
  | "review"
  | "selection"
  | "memo"
  | "regression";

const CANDIDATE_NAMES = {
  A: "Single LLM",
  B: "Retrieval RAG",
  C: "Read-only tool agent",
} as const;

const STAGE_HREFS = {
  Define: "/?view=demo&demoStage=define",
  Compare: "/?view=demo&demoStage=compare",
  Decide: "/?view=demo&demoStage=decide",
  Monitor: "/?view=demo&demoStage=monitor",
} as const;

function initialStage(): DemoStage {
  const value = new URLSearchParams(window.location.search).get("demoStage");
  return value === "compare" || value === "decide" || value === "monitor"
    ? value
    : "define";
}

function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function demoSourceLabel(state: HackathonDemoState): string {
  return state.source === "LIVE_SYNTHETIC_DEMO"
    ? "LIVE SYNTHETIC DEMO"
    : "RECORDED FALLBACK";
}

function executionSourceMatchesState(
  execution: LiveDemoExecution,
  state: HackathonDemoState,
): boolean {
  return execution.source === "LIVE"
    ? state.source === "LIVE_SYNTHETIC_DEMO"
    : state.source === "RECORDED_FALLBACK";
}

function hasResults(status: LiveDemoExecution["status"]): boolean {
  return status === "RESULTS_READY"
    || status === "JUDGE_READY"
    || status === "REVIEW_READY"
    || status === "NO_APPROVED_CANDIDATE"
    || status === "SELECTION_RECORDED"
    || status === "MEMO_RUNNING"
    || status === "MEMO_FAILED"
    || status === "MEMO_READY"
    || status === "REGRESSION_BLOCK";
}

function isLiveComparisonActive(execution: LiveDemoExecution): boolean {
  return (
    execution.status === "READY"
    || execution.status === "RUNNING"
  ) && execution.error_code === null;
}

function externalPendingKind(
  execution: LiveDemoExecution | null,
): "judge" | "memo" | null {
  if (!execution) return null;
  if (
    execution.progress_step === "JUDGE_RUNNING"
    || execution.progress_step === "JUDGE_RETRY_RUNNING"
  ) {
    return "judge";
  }
  return execution.status === "MEMO_RUNNING" ? "memo" : null;
}

function judgeFailureKind(
  execution: LiveDemoExecution | null,
): "retry" | "final" | null {
  if (execution?.progress_step === "JUDGE_FAILED") return "retry";
  if (execution?.progress_step === "JUDGE_FAILED_FINAL") return "final";
  return null;
}

function isStoppedOrUncertain(execution: LiveDemoExecution): boolean {
  return execution.status === "FAILED"
    || execution.status === "INTERRUPTED"
    || (
      execution.status === "RUNNING"
      && execution.error_code !== null
    );
}

function newIdempotencyKey(): string {
  return `demo_${crypto.randomUUID().replaceAll("-", "_")}`;
}

function stageLabel(stage: DemoStage): "Define" | "Compare" | "Decide" | "Monitor" {
  if (stage === "define") return "Define";
  if (stage === "compare") return "Compare";
  if (stage === "decide") return "Decide";
  return "Monitor";
}

function shellStatus(stage: DemoStage, state: HackathonDemoState): {
  status: string;
  tone: "neutral" | "review" | "block" | "baseline";
} {
  if (stage === "define") return { status: "LOCKED", tone: "neutral" };
  if (stage === "compare") {
    if (state.human_review) return { status: "HUMAN REVIEW COMPLETE", tone: "neutral" };
    if (state.judge?.status === "COMPLETE") return { status: "REVIEW REQUIRED", tone: "review" };
    return { status: "JUDGE REQUIRED", tone: "review" };
  }
  if (stage === "decide") {
    if (state.status === "NO_APPROVED_CANDIDATE") {
      return { status: "NO APPROVED", tone: "block" };
    }
    return state.memo?.status === "COMPLETE"
      ? { status: "MEMO READY", tone: "baseline" }
      : { status: "SELECTION REQUIRED", tone: "review" };
  }
  return state.regression
    ? { status: "BLOCK", tone: "block" }
    : { status: "CHANGE CHECK READY", tone: "review" };
}

function ExternalCallProgress({
  label,
  title,
  description,
}: {
  label: string;
  title: string;
  description: string;
}) {
  return (
    <div
      className="demo-live-progress"
      role="status"
      aria-label={label}
      aria-live="polite"
      aria-atomic="true"
    >
      <CircleNotch className="demo-live-progress__spinner" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
    </div>
  );
}

function StageHeader({
  kicker,
  title,
  description,
  children,
}: {
  kicker: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <span className="section-kicker">{kicker}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children ? <div className="page-header__status">{children}</div> : null}
    </header>
  );
}

function DefineDemo({
  challenge,
  execution,
  state,
  pending,
  pendingSource,
  errorMessage,
  onRunLive,
  onUseRecorded,
  onContinue,
}: {
  challenge: LiveDemoChallenge;
  execution: LiveDemoExecution | null;
  state: HackathonDemoState | null;
  pending: boolean;
  pendingSource: "live" | "recorded" | null;
  errorMessage: string | null;
  onRunLive: () => void;
  onUseRecorded: () => void;
  onContinue: () => void;
}) {
  const comparisonRunning = execution != null && isLiveComparisonActive(execution);
  const sourceSelected = state !== null;
  return (
    <div className="page-stack">
      <StageHeader
        kicker="LOCKED SYNTHETIC CHALLENGE"
        title="Customer-support answer and escalation decision"
        description="One public synthetic ticket is locked to the same policy boundary and execution envelope for all three candidates."
      >
        <StatusBadge tone={state ? "recorded" : "neutral"}>
          {state ? demoSourceLabel(state) : "READY TO RUN"}
        </StatusBadge>
      </StageHeader>
      <section className="section-panel define-work-input-panel">
        <div className="section-heading section-heading--split">
          <div>
            <h2>Actual work input</h2>
            <p>Customer message used by the successful public A/B/C canary.</p>
          </div>
          <StatusBadge tone="neutral">{challenge.case_id}</StatusBadge>
        </div>
        <dl
          className="memo-preview demo-challenge-details"
          data-testid="locked-challenge-details"
        >
          <div><dt>Ticket</dt><dd>{challenge.ticket}</dd></div>
          <div><dt>As of</dt><dd>{challenge.as_of}</dd></div>
          <div><dt>Fatal failure</dt><dd>Wrong action, retired-policy citation, missing active citation, or unsupported completion promise.</dd></div>
          <div><dt>Decision rule</dt><dd>Hard gate first; then human review; then choose the simplest configuration sufficient for this bounded demo.</dd></div>
          <div><dt>External action</dt><dd>{challenge.external_action_statement}</dd></div>
        </dl>
        {execution && (
          comparisonRunning
          || isStoppedOrUncertain(execution)
        ) ? (
            <LiveComparisonProgress execution={execution} />
          ) : null}
        {pendingSource !== null && execution === null ? (
          <ExternalCallProgress
            label="Demo source progress"
            title={pendingSource === "live"
              ? "PREPARING LIVE COMPARISON"
              : "LOADING RECORDED FALLBACK"}
            description={pendingSource === "live"
              ? "Creating one bounded execution before Candidate A starts. Recorded evidence will not be substituted."
              : "Loading the explicitly selected recorded artifact. It will remain visibly separate from live evidence."}
          />
        ) : null}
        {errorMessage ? (
          <div className="demo-inline-error" role="alert">
            <strong>Live workflow could not continue</strong>
            <span>{errorMessage}</span>
          </div>
        ) : null}
        {!comparisonRunning && pendingSource === null ? (
          <div className="demo-action-row">
            {sourceSelected ? (
              <button className="button button--primary" type="button" onClick={onContinue}>
                Open comparison <ArrowRight aria-hidden="true" />
              </button>
            ) : (
              <>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={pending || execution !== null}
                  onClick={onRunLive}
                >
                  Run live comparison
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={pending}
                  onClick={onUseRecorded}
                >
                  Use recorded demo
                </button>
              </>
            )}
          </div>
        ) : null}
        {!sourceSelected ? (
          <p className="demo-fallback-note">
            Recorded evidence is never selected automatically. Choosing it displays
            a persistent RECORDED FALLBACK label and does not mix it with live results.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function EvidenceDialog({
  candidateId,
  run,
  sourceLabel,
  onClose,
}: {
  candidateId: DemoCandidateId;
  run: DemoRunView;
  sourceLabel: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const appRoot = document.getElementById("app-shell-root");
    const previousOverflow = document.body.style.overflow;
    if (appRoot) appRoot.inert = true;
    document.body.style.overflow = "hidden";

    const frame = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), summary, [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey
        && (
          document.activeElement === first
          || document.activeElement === dialogRef.current
        )
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      if (appRoot) appRoot.inert = false;
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div className="demo-dialog-backdrop" role="presentation">
      <section
        className="demo-evidence-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <div className="section-heading section-heading--split">
          <div>
            <span className="section-kicker">{sourceLabel}</span>
            <h2 id={titleId}>
              Candidate {candidateId} · Run {run.repetition}
            </h2>
            <p className="sr-only" id={descriptionId}>
              Recorded output, hard gate, citations, cost, and latency for this
              run.
            </p>
          </div>
          <button
            className="icon-button"
            ref={closeButtonRef}
            type="button"
            aria-label="Close evidence"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <dl className="memo-preview">
          <div><dt>Hard gate</dt><dd>{run.hard_gate_status}</dd></div>
          <div><dt>Customer reply</dt><dd>{run.customer_reply}</dd></div>
          <div><dt>Action</dt><dd>{run.action_code}</dd></div>
          <div><dt>Citations</dt><dd>{run.citations.join(", ")}</dd></div>
          <div><dt>Measured</dt><dd>{formatUsd(run.cost_usd ?? 0)} · {run.latency_ms} ms</dd></div>
        </dl>
      </section>
    </div>,
    document.body,
  );
}

function BlindReview({
  state,
  pending,
  onComplete,
}: {
  state: HackathonDemoState;
  pending: boolean;
  onComplete: (body: ConfirmLiveDemoReviewsInput) => void;
}) {
  const [decisions, setDecisions] = useState<Record<DemoBlindLabel, ReviewDecision | null>>({
    X: null,
    Y: null,
    Z: null,
  });
  const [rationale, setRationale] = useState("");
  const rationaleHelpId = useId();
  const complete = (["X", "Y", "Z"] as const).every((label) => decisions[label] !== null)
    && rationale.trim().length > 0;

  return (
    <section className="section-panel demo-blind-review" aria-label={`Blind review · ${state.blind_review.case_id}`}>
      <div className="section-heading section-heading--split">
        <div>
          <span className="section-kicker">ONE BLIND CASE · THREE CONFIGURATIONS</span>
          <h2>Human confirmation before selection</h2>
          <p>Architecture and candidate identity stay hidden until all X/Y/Z decisions are recorded.</p>
        </div>
        <StatusBadge tone="review">REVIEW REQUIRED</StatusBadge>
      </div>
      <div className="demo-review-boundary">
        <strong>Locked review boundary</strong>
        <p>
          The order has already shipped. Do not claim it was cancelled or
          refunded. Explain the return-after-delivery path and cite active
          policy CANCEL-2026 §2.2. Retired policy citations and unsupported
          completion promises are fatal failures.
        </p>
      </div>
      <div className="demo-blind-grid">
        {state.blind_review.candidates.map((candidate) => (
          <article key={candidate.blind_label} className="demo-blind-card">
            <h3>Candidate {candidate.blind_label}</h3>
            <div className="demo-blind-card__runs">
              {candidate.runs.map((run) => (
                <div key={run.repetition}>
                  <strong>Run {run.repetition}</strong>
                  <p>{run.customer_reply}</p>
                  <small>{run.citations.join(", ")}</small>
                </div>
              ))}
            </div>
            <fieldset>
              <legend>Human decision</legend>
              {(["PASS", "CONFIRMED_FAIL"] as const).map((decision) => {
                const decisionHelpId =
                  `demo-review-${candidate.blind_label}-${decision.toLowerCase()}-help`;
                return (
                  <label key={decision}>
                    <input
                      type="radio"
                      name={`review-${candidate.blind_label}`}
                      aria-label={`Candidate ${candidate.blind_label} ${decision.replace("_", " ")}`}
                      aria-describedby={decisionHelpId}
                      checked={decisions[candidate.blind_label] === decision}
                      onChange={() => setDecisions((current) => ({
                        ...current,
                        [candidate.blind_label]: decision,
                      }))}
                    />
                    <span>
                      <strong>{decision.replace("_", " ")}</strong>
                      <small id={decisionHelpId}>
                        {decision === "PASS"
                          ? "No locked action, policy, citation, or promise failure was found in the reviewed response."
                          : "One or more locked fatal failures are supported by the response or evidence."}
                      </small>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <p className="field-help">
              A human PASS does not override a deterministic hard-gate failure.
            </p>
          </article>
        ))}
      </div>
      <div className="demo-review-form">
        <label>
          <span className="field-label">
            Why did you mark X, Y, and Z this way?
          </span>
          <textarea
            aria-label="Why did you mark X, Y, and Z this way?"
            aria-describedby={rationaleHelpId}
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
            rows={3}
            required
          />
          <span className="field-help" id={rationaleHelpId}>
            Mention X, Y, and Z and cite the reply, active policy, citation, or
            unsupported promise that supports each decision. Do not infer the
            hidden architecture.
          </span>
        </label>
        <button
          className="button button--primary"
          type="button"
          disabled={!complete || pending}
          onClick={() => onComplete({
            reviewer: "Demo decision owner",
            rationale: rationale.trim(),
            decisions: [
              { blind_label: "X", decision: decisions.X! },
              { blind_label: "Y", decision: decisions.Y! },
              { blind_label: "Z", decision: decisions.Z! },
            ],
          })}
        >
          Complete blind review
        </button>
      </div>
    </section>
  );
}

function CompareDemo({
  state,
  pending,
  judgePending,
  judgeFailure,
  onRunJudge,
  onCompleteReview,
  onContinue,
}: {
  state: HackathonDemoState;
  pending: boolean;
  judgePending: boolean;
  judgeFailure: "retry" | "final" | null;
  onRunJudge: () => void;
  onCompleteReview: (body: ConfirmLiveDemoReviewsInput) => void;
  onContinue: () => void;
}) {
  const [evidence, setEvidence] = useState<{ candidateId: DemoCandidateId; run: DemoRunView } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const comparisonHelpId = useId();

  return (
    <div className="page-stack">
      <StageHeader
        kicker={state.source === "LIVE_SYNTHETIC_DEMO"
          ? "ACTUAL LIVE A/B/C COMPARISON"
          : "EXPLICIT RECORDED FALLBACK"}
        title="Compare one real support task under the same boundary"
        description="Quality, cost, speed, and operational complexity remain separate. This one-ticket calibration is not a Benchmark or purchase approval."
      >
        <StatusBadge tone="recorded">{demoSourceLabel(state)}</StatusBadge>
        <span>
          {state.canary.case_id} · 1 synthetic ticket ·{" "}
          {state.canary.candidates.reduce(
            (total, candidate) => total + candidate.runs.length,
            0,
          )} runs
        </span>
      </StageHeader>

      <div className="incomplete-banner">
        <ShieldWarning aria-hidden="true" />
        <div>
          <strong>BOUNDED DEMO EVIDENCE · NOT A BENCHMARK</strong>
          <span>
            This evidence has no automatic winner, approved candidate, or
            baseline. Technical state: {state.canary.evaluation_status}.
          </span>
        </div>
      </div>

      <section className="section-panel">
        <div className="section-heading section-heading--split">
          <div>
            <h2>Hard gate, quality, cost, and speed</h2>
            <p>Every number below is projected from the validated selected-source artifact.</p>
          </div>
          <span className="table-note">Fatal failures cannot be offset by averages.</span>
        </div>
        <p className="demo-comparison-summary" id={comparisonHelpId}>
          Hard gates exclude fatal failures first. The remaining measures show
          trade-offs; they do not produce an automatic winner.
        </p>
        <details className="demo-comparison-help">
          <summary>How to read this comparison</summary>
          <dl>
            <div>
              <dt>Hard gate</dt>
              <dd>
                Fatal action, policy, citation, or unsupported-promise failures
                that averages cannot offset.
              </dd>
            </div>
            <div>
              <dt>Quality</dt>
              <dd>
                Answer completeness and active-policy citation coverage for the
                locked task.
              </dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd>
                Runtime cost calculated from recorded OpenAI usage and the
                locked pricing schedule; unmeasured infrastructure or storage
                cost is excluded.
              </dd>
            </div>
            <div>
              <dt>Latency</dt>
              <dd>Total execution time and mean model-call time.</dd>
            </div>
            <div>
              <dt>Calls</dt>
              <dd>Model, policy-search, and read-only tool calls.</dd>
            </div>
            <div>
              <dt>Stability</dt>
              <dd>
                Consistency across repeated runs; not measured in this one-run
                live demo.
              </dd>
            </div>
            <div>
              <dt>Complexity</dt>
              <dd>
                T1 · Single LLM; T2 · Retrieval RAG; T3 · retrieval and
                read-only tool agent.
              </dd>
            </div>
          </dl>
        </details>
        <p
          className="demo-table-scroll-hint"
          id={`${comparisonHelpId}-scroll`}
        >
          Scroll horizontally to compare all candidates.
        </p>
        <div
          className="table-scroll demo-metric-table-scroll"
          role="region"
          tabIndex={0}
          aria-label="Candidate comparison measurements"
          aria-describedby={`${comparisonHelpId} ${comparisonHelpId}-scroll`}
        >
          <table className="data-table metric-table">
            <caption className="sr-only">
              Candidate A, B, and C hard gate, quality, cost, latency, calls,
              and evidence
            </caption>
            <thead>
              <tr>
                <th scope="col">What was measured</th>
                {state.canary.candidates.map((candidate) => (
                  <th scope="col" key={candidate.candidate_id}>
                    <span className="candidate-header">
                      <b>{candidate.candidate_id}</b>
                      <span>{CANDIDATE_NAMES[candidate.candidate_id]}<small>{candidate.complexity_tier}</small></span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Deterministic hard gate</th>
                {state.canary.candidates.map((candidate) => (
                  <td key={candidate.candidate_id}>
                    <StatusBadge tone={candidate.hard_gate.status === "PASS" ? "pass" : "fail"} compact>
                      {`${candidate.hard_gate.passed_runs} / ${candidate.hard_gate.total_runs} ${candidate.hard_gate.status}`}
                    </StatusBadge>
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">
                  Answer completeness / current-policy citation
                </th>
                {state.canary.candidates.map((candidate) => (
                  <td key={candidate.candidate_id}>
                    {`Complete answer ${candidate.quality.complete_outputs}/${candidate.hard_gate.total_runs} · Current-policy citation ${candidate.quality.active_policy_citations}/${candidate.hard_gate.total_runs}`}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">Repeat-decision stability</th>
                {state.canary.candidates.map((candidate) => (
                  <td key={candidate.candidate_id}>
                    {candidate.quality.stability === "SINGLE_RUN_NOT_MEASURED"
                      ? "Single run · not measured"
                      : candidate.quality.stability}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">Recorded runtime cost</th>
                {state.canary.candidates.map((candidate) => (
                  <td key={candidate.candidate_id}>{formatUsd(candidate.total_cost_usd)}</td>
                ))}
              </tr>
              <tr>
                <th scope="row">Runtime latency</th>
                {state.canary.candidates.map((candidate) => (
                  <td key={candidate.candidate_id}>
                    {`Total ${(candidate.total_latency_ms / 1_000).toFixed(2)} s · Average ${(candidate.mean_latency_ms / 1_000).toFixed(2)} s`}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">Observed calls</th>
                {state.canary.candidates.map((candidate) => (
                  <td key={candidate.candidate_id}>
                    {`Model ${candidate.provider_calls} · Policy search ${candidate.retrieval_calls} · Tool ${candidate.tool_calls}`}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">
                  {state.source === "LIVE_SYNTHETIC_DEMO" ? "Live evidence" : "Recorded evidence"}
                </th>
                {state.canary.candidates.map((candidate) => (
                  <td key={candidate.candidate_id}>
                    <div className="demo-evidence-links">
                      {candidate.runs.map((run) => (
                        <button
                          key={run.repetition}
                          className="table-evidence-button"
                          type="button"
                          aria-label={`Open Candidate ${candidate.candidate_id} run ${run.repetition} evidence`}
                          onClick={() => setEvidence({ candidateId: candidate.candidate_id, run })}
                        >
                          Run {run.repetition}
                        </button>
                      ))}
                    </div>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="section-panel">
        <div className="section-heading section-heading--split">
          <div>
            <h2>GPT-5.6 auxiliary risk signals</h2>
            <p>The Judge sees only blinded X/Y/Z evidence. Its signals open human review; they never override the deterministic gate.</p>
          </div>
          <StatusBadge
            tone={state.judge?.status === "COMPLETE" ? "neutral" : "review"}
          >
            {judgePending
              ? "GPT-5.6 JUDGE RUNNING"
              : state.judge?.status === "COMPLETE"
                ? "AUXILIARY REVIEW COMPLETE"
                : "NOT RUN"}
          </StatusBadge>
        </div>
        {state.judge === null ? (
          <>
            {judgePending ? (
              <ExternalCallProgress
                label="GPT-5.6 Judge progress"
                title="GPT-5.6 JUDGE RUNNING"
                description="This external model step may take some time. The status will update when the response completes. Deterministic gates remain authoritative."
              />
            ) : null}
            {judgeFailure ? (
              <div className="demo-inline-error" role="alert">
                <strong>
                  {judgeFailure === "retry"
                    ? "GPT-5.6 Judge did not complete"
                    : "GPT-5.6 Judge retry limit reached"}
                </strong>
                <span>
                  Deterministic hard gates and candidate evidence remain
                  unchanged. {judgeFailure === "retry"
                    ? "One explicit Judge retry is available."
                    : "No further paid Judge retry is enabled in this demo session."}
                </span>
              </div>
            ) : null}
            {!judgePending && judgeFailure !== "final" ? (
              <div className="demo-action-row">
                <button
                  className="button button--primary"
                  type="button"
                  disabled={pending}
                  aria-label={judgeFailure === "retry"
                    ? "Retry GPT-5.6 auxiliary risk check"
                    : "Run GPT-5.6 auxiliary risk check"}
                  onClick={onRunJudge}
                >
                  {judgeFailure === "retry"
                    ? "Retry GPT-5.6 auxiliary risk check"
                    : "Run GPT-5.6 auxiliary risk check"}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <p className="demo-authority-note">
              No additional signal is not a pass. Deterministic hard-gate
              findings above remain authoritative.
            </p>
            <div className="demo-risk-grid" data-testid="demo-risk-grid">
              {state.judge.risks.map((risk) => {
                const signal = demoJudgeSignalPresentation(risk.status);
                return (
                  <article className="demo-risk-card" key={risk.blind_label}>
                    <strong className="demo-risk-card__title">
                      Candidate {risk.blind_label}
                    </strong>
                    <div className="demo-risk-card__signal">
                      <StatusBadge tone={signal.tone} compact>
                        {signal.label}
                      </StatusBadge>
                    </div>
                    <div className="demo-risk-card__findings">
                      {risk.failure_types.length > 0 ? (
                        <ul className="demo-risk-list">
                          {risk.failure_types.map((failureType) => {
                            const failure =
                              demoJudgeFailureTypePresentation(failureType);
                            return (
                              <li key={failure.rawCode}>
                                <span>{failure.label}</span>
                                <code>{failure.rawCode}</code>
                              </li>
                            );
                          })}
                        </ul>
                      ) : <p>{signal.description}</p>}
                    </div>
                  </article>
                );
              })}
              <small>
                {state.judge.model_reported_id ?? "Model unavailable"} ·{" "}
                {state.judge.latency_ms} ms · advisory only
              </small>
            </div>
          </>
        )}
      </section>

      {state.human_review === null && state.judge?.status === "COMPLETE" ? (
        reviewOpen ? (
          <BlindReview state={state} pending={pending} onComplete={onCompleteReview} />
        ) : (
          <div className="demo-action-row demo-action-row--end">
            <button className="button button--primary" type="button" onClick={() => setReviewOpen(true)}>
              Open blind human review <ArrowRight aria-hidden="true" />
            </button>
          </div>
        )
      ) : null}

      {state.human_review ? (
        <section className="recommendation-panel">
          <div className="recommendation-index"><CheckCircle aria-hidden="true" /></div>
          <div className="recommendation-copy">
            <span className="section-kicker">HUMAN REVIEW COMPLETE</span>
            <h2>Identities may now be revealed for the human decision.</h2>
            <p>{state.human_review.rationale}</p>
            <p className="table-disclosure">
              Human review time · {state.human_review.review_time}
              {" · "}
              Human edit time · {state.human_review.edit_time}
            </p>
          </div>
          <button className="button button--primary" type="button" onClick={onContinue}>
            Continue to human decision <ArrowRight aria-hidden="true" />
          </button>
        </section>
      ) : null}

      {evidence ? (
        <EvidenceDialog
          candidateId={evidence.candidateId}
          run={evidence.run}
          sourceLabel={demoSourceLabel(state)}
          onClose={() => setEvidence(null)}
        />
      ) : null}
    </div>
  );
}

function DecideDemo({
  state,
  pending,
  memoPending,
  memoError,
  onSelectCandidate,
  onCreateMemo,
  onContinue,
}: {
  state: HackathonDemoState;
  pending: boolean;
  memoPending: boolean;
  memoError: string | null;
  onSelectCandidate: (body: SelectLiveDemoCandidateInput) => void;
  onCreateMemo: () => void;
  onContinue: () => void;
}) {
  const [selected, setSelected] = useState<DemoCandidateId | null>(state.selection?.candidate_id ?? null);
  const [rationale, setRationale] = useState(state.selection?.rationale ?? "");
  const selectionRationaleHelpId = useId();
  const eligibleCandidateIds = useMemo(
    () => new Set(state.eligible_candidate_ids),
    [state.eligible_candidate_ids],
  );
  const eligible = [...state.canary.candidates.filter((candidate) => (
    candidate.hard_gate.status === "PASS" && eligibleCandidateIds.has(candidate.candidate_id)
  ))].sort((left, right) => (
    left.complexity_tier.localeCompare(right.complexity_tier)
  ));
  const simplest = eligible[0] ?? null;
  const selectionRecorded = state.selection !== null;
  const memoComplete = state.memo?.status === "COMPLETE";
  const memoFailed = state.status === "MEMO_FAILED"
    || state.memo?.status === "FAILED"
    || memoError !== null;

  useEffect(() => {
    setSelected(state.selection?.candidate_id ?? null);
    setRationale(state.selection?.rationale ?? "");
  }, [state.selection?.candidate_id, state.selection?.rationale, state.source]);

  if (!state.human_review) {
    return (
      <div className="page-stack">
        <StageHeader
          kicker="DECISION WITHHELD"
          title="Complete blind human review first"
          description="No candidate identity, recommendation, selection, or Memo is exposed before review closes."
        />
      </div>
    );
  }

  if (state.status === "NO_APPROVED_CANDIDATE") {
    return (
      <div className="page-stack">
        <StageHeader
          kicker="NORMAL COMPLETED OUTCOME"
          title="No approved candidate"
          description="The Challenge completed normally, but no configuration satisfies the locked deterministic and human-review conditions."
        >
          <StatusBadge tone="block">NO APPROVED CANDIDATE</StatusBadge>
        </StageHeader>
        <section className="section-panel">
          <div className="section-heading">
            <h2>No forced winner or baseline</h2>
            <p>
              A fatal failure cannot be offset by quality averages. No Decision
              Memo, purchase, deployment, contract, or rollback is created.
            </p>
          </div>
          <div className="failure-callout-grid demo-failure-grid">
            {state.canary.candidates.map((candidate) => (
              <div key={candidate.candidate_id}>
                <span>Candidate {candidate.candidate_id}</span>
                <strong>{candidate.hard_gate.status}</strong>
              </div>
            ))}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <StageHeader
        kicker="HUMAN DECISION"
        title="Make the human decision"
        description="The system exposes the simplest sufficient option, but it never preselects or purchases a candidate."
      >
        <StatusBadge tone="recorded">{demoSourceLabel(state)}</StatusBadge>
      </StageHeader>

      {simplest ? (
        <section className="recommendation-panel">
          <div className="recommendation-index">R</div>
          <div className="recommendation-copy">
            <span className="section-kicker">SYSTEM RECOMMENDATION · ADVISORY</span>
            <h2>Candidate {simplest.candidate_id} is the simplest sufficient configuration in this one-ticket demo.</h2>
            <p>This is not a production superiority claim. Cost, latency, complexity, and the one-case limitation stay visible.</p>
          </div>
          <StatusBadge tone="pass">{simplest.complexity_tier}</StatusBadge>
        </section>
      ) : null}

      <div className="decision-grid">
        <section className="section-panel human-decision">
          <div className="section-heading">
            <h2>Human selection</h2>
            <p>No option is selected automatically.</p>
          </div>
          <fieldset
            className="candidate-choice"
            disabled={selectionRecorded || memoPending}
          >
            <legend>Select a hard-gate and human-review eligible candidate</legend>
            {eligible.map((candidate) => (
              <label key={candidate.candidate_id} className={selected === candidate.candidate_id ? "is-selected" : ""}>
                <input
                  type="radio"
                  name="demo-selected-candidate"
                  aria-label={`Candidate ${candidate.candidate_id} · ${CANDIDATE_NAMES[candidate.candidate_id]}`}
                  checked={selected === candidate.candidate_id}
                  onChange={() => setSelected(candidate.candidate_id)}
                />
                <span className="candidate-choice__letter">{candidate.candidate_id}</span>
                <span>
                  <strong>{CANDIDATE_NAMES[candidate.candidate_id]}</strong>
                  <small>{candidate.complexity_tier} · {formatUsd(candidate.total_cost_usd)} total</small>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="decision-rationale-field">
            <span className="field-label">
              Why are you selecting this eligible candidate?
            </span>
            <textarea
              aria-label="Why are you selecting this eligible candidate?"
              aria-describedby={selectionRationaleHelpId}
              value={rationale}
              readOnly={selectionRecorded || memoPending}
              onChange={(event) => setRationale(event.target.value)}
              rows={3}
            />
            <span className="field-help" id={selectionRationaleHelpId}>
              Explain why this candidate is sufficient for the locked task and
              which cost, latency, or complexity trade-off you accept.
            </span>
          </label>
          {selectionRecorded ? (
            <div className="demo-selection-recorded">
              <CheckCircle aria-hidden="true" />
              <div>
                <strong>Human selection recorded · Candidate {state.selection!.candidate_id}</strong>
                <span>{state.selection!.rationale}</span>
              </div>
            </div>
          ) : (
            <div className="demo-action-row">
              <button
                className="button button--primary button--full"
                type="button"
                disabled={selected === null || rationale.trim().length === 0 || pending}
                onClick={() => onSelectCandidate({
                  selected_candidate_id: selected!,
                  rationale: rationale.trim(),
                })}
              >
                Record human candidate selection
              </button>
            </div>
          )}
        </section>

        <section className="section-panel decision-memo">
          <div className="section-heading section-heading--split">
            <div>
              <h2>Decision Memo</h2>
              <p>Generated from the actual canary evidence and explicit human decision.</p>
            </div>
            <StatusBadge tone={memoComplete ? "pass" : memoPending || memoFailed ? "review" : "neutral"}>
              {memoComplete
                ? "ACTUAL GPT-5.6"
                : memoPending
                  ? "DECISION MEMO GENERATING"
                  : memoFailed
                    ? "MEMO FAILED · RETRY AVAILABLE"
                  : "NOT STARTED"}
            </StatusBadge>
          </div>
          {memoComplete ? (
            <>
              <dl className="memo-preview">
                <div><dt>Decision</dt><dd>{state.memo!.decision}</dd></div>
                <div><dt>Evidence basis</dt><dd>{state.memo!.evidence_basis.join(" ")}</dd></div>
                <div><dt>Trade-offs</dt><dd>{state.memo!.trade_offs}</dd></div>
                <div><dt>Limitations</dt><dd>{state.memo!.limitations}</dd></div>
                <div><dt>Next step</dt><dd>{state.memo!.next_step}</dd></div>
                <div><dt>External action</dt><dd>{state.memo!.external_action_statement}</dd></div>
              </dl>
              <div className="demo-action-row">
                <button className="button button--primary button--full" type="button" onClick={onContinue}>
                  Open representative change check <ArrowRight aria-hidden="true" />
                </button>
              </div>
            </>
          ) : memoPending ? (
            <ExternalCallProgress
              label="GPT-5.6 Decision Memo progress"
              title="DECISION MEMO GENERATING"
              description="This external model step may take some time. The recorded human selection remains unchanged while the Memo is generated."
            />
          ) : memoFailed ? (
            <>
              <div className="demo-inline-error" role="alert">
                <strong>Decision Memo could not be generated</strong>
                <span>
                  The human selection remains recorded. Retry only regenerates
                  the advisory Memo from the same evidence.
                </span>
              </div>
              <div className="demo-action-row">
                <button
                  className="button button--primary button--full"
                  type="button"
                  disabled={pending}
                  aria-label="Retry GPT-5.6 Decision Memo"
                  onClick={onCreateMemo}
                >
                  Retry GPT-5.6 Decision Memo
                </button>
              </div>
            </>
          ) : selectionRecorded ? (
            <div className="demo-action-row">
              <button
                className="button button--primary button--full"
                type="button"
                disabled={pending}
                aria-label="Generate GPT-5.6 Decision Memo"
                onClick={onCreateMemo}
              >
                Generate GPT-5.6 Decision Memo
              </button>
            </div>
          ) : (
            <div className="memo-empty">
              <strong>Memo generation is gated</strong>
              <p>First record an eligible candidate and the decision owner’s rationale.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function MonitorDemo({
  state,
  pending,
  onReplay,
}: {
  state: HackathonDemoState;
  pending: boolean;
  onReplay: () => void;
}) {
  if (state.memo?.status !== "COMPLETE" || !state.selection) {
    return (
      <div className="page-stack">
        <StageHeader
          kicker="CHANGE CHECK WITHHELD"
          title="Create the human decision record first"
          description="A representative change is not replayed until the actual Decision Memo exists."
        />
      </div>
    );
  }

  return (
    <div className="page-stack">
      <StageHeader
        kicker="REPRESENTATIVE DEFECT REPLAY"
        title="Check one proposed change against the same hard gate"
        description="This is a bounded synthetic replay, not an external deployment, rollback, or 36-run production regression."
      >
        <StatusBadge tone="recorded">{demoSourceLabel(state)}</StatusBadge>
      </StageHeader>

      {state.regression === null ? (
        <section className="section-panel">
          <div className="section-heading">
            <h2>Proposed defective change</h2>
            <p>Replay a retired-policy citation and unsupported refund completion promise through the deterministic gate.</p>
          </div>
          <div className="demo-action-row">
            <button className="button button--primary" type="button" disabled={pending} onClick={onReplay}>
              Replay representative defect <Flask aria-hidden="true" />
            </button>
          </div>
        </section>
      ) : (
        <>
          <section className="block-verdict" aria-labelledby="demo-block-title">
            <div className="block-verdict__icon"><ShieldWarning aria-hidden="true" /></div>
            <div className="block-verdict__copy">
              <span className="section-kicker">NEW HARD-GATE FAILURE</span>
              <div className="block-title-row"><h2 id="demo-block-title">BLOCK</h2></div>
              <p>Recorded human decision remains unchanged</p>
              <small>{state.regression.external_action_statement}</small>
            </div>
            <div className="verdict-rule">
              <span>Decision rule</span>
              <strong>Any new fatal failure blocks the proposed change.</strong>
            </div>
          </section>
          <section className="section-panel">
            <div className="section-heading section-heading--split">
              <div>
                <h2>Deterministic failure evidence</h2>
                <p>{state.regression.proposed_reply}</p>
              </div>
              <StatusBadge tone="block">CHANGE BLOCKED</StatusBadge>
            </div>
            <div className="failure-callout-grid demo-failure-grid">
              {state.regression.new_hard_gate_failures.map((failure) => (
                <div key={failure}><span>NEW FAILURE</span><strong>{failure}</strong></div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export function HackathonDemoWorkspace() {
  const [stage, setStage] = useState<DemoStage>(initialStage);
  const [challenge, setChallenge] = useState<LiveDemoChallenge | null>(null);
  const [execution, setExecution] = useState<LiveDemoExecution | null>(null);
  const [state, setState] = useState<HackathonDemoState | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [memoError, setMemoError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<DemoPendingAction | null>(null);
  const terminalLoadRef = useRef(new Map<string, Promise<HackathonDemoState>>());
  const sessionActions = useJudgeSessionActions();
  const notifyAuthExpired = sessionActions?.notifyAuthExpired;

  const navigate = useCallback((next: DemoStage) => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "demo");
    url.searchParams.set("demoStage", next);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
    setStage(next);
    window.scrollTo?.({ top: 0, behavior: "smooth" });
  }, []);

  const handleAuthExpired = useCallback((error: unknown): boolean => {
    if (!(error instanceof AuthExpiredError)) return false;
    setChallenge(null);
    setExecution(null);
    setState(null);
    notifyAuthExpired?.();
    return true;
  }, [notifyAuthExpired]);

  const loadExecutionResults = useCallback((
    nextExecution: LiveDemoExecution,
  ): Promise<HackathonDemoState> => {
    const key = [
      nextExecution.execution_id,
      nextExecution.source,
      nextExecution.status,
      nextExecution.progress_step,
    ].join(":");
    const existing = terminalLoadRef.current.get(key);
    if (existing) return existing;
    const promise = getResults(nextExecution.execution_id).then((nextState) => {
      if (!executionSourceMatchesState(nextExecution, nextState)) {
        throw new Error("Live and recorded evidence source mismatch.");
      }
      setState(nextState);
      return nextState;
    }).catch((error) => {
      terminalLoadRef.current.delete(key);
      throw error;
    });
    terminalLoadRef.current.set(key, promise);
    return promise;
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([getChallenge(), getCurrentExecution()]).then(
      async ([nextChallenge, currentExecution]) => {
        if (!active) return;
        setChallenge(nextChallenge);
        setExecution(currentExecution);
        if (currentExecution && hasResults(currentExecution.status)) {
          const restoredState = await loadExecutionResults(currentExecution);
          if (!active) return;
          setState(restoredState);
        }
        if (active) setLoading(false);
      },
      (error: unknown) => {
        if (!active) return;
        setLoading(false);
        if (!handleAuthExpired(error)) {
          setErrorMessage(
            "The locked synthetic Challenge could not be restored. No evidence was substituted.",
          );
        }
      },
    ).catch((error: unknown) => {
      if (!active) return;
      setLoading(false);
      if (!handleAuthExpired(error)) {
        setErrorMessage(
          "The current execution evidence could not be restored. No fallback was selected.",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [handleAuthExpired, loadExecutionResults]);

  const acceptExecution = useCallback(async (
    nextExecution: LiveDemoExecution,
  ) => {
    setExecution(nextExecution);
    if (hasResults(nextExecution.status)) {
      await loadExecutionResults(nextExecution);
    }
  }, [loadExecutionResults]);

  useEffect(() => {
    if (!execution) return;
    const pollingComparison = isLiveComparisonActive(execution);
    const pollingExternal = externalPendingKind(execution);
    if (!pollingComparison && pollingExternal === null) return;
    let active = true;
    let timer = 0;
    const poll = async () => {
      try {
        const nextExecution = await getExecution(execution.execution_id);
        if (!active) return;
        await acceptExecution(nextExecution);
        if (
          pollingComparison
          && hasResults(nextExecution.status)
          && nextExecution.progress_step === "RESULTS_READY"
        ) {
          setPendingAction((current) => current === "live" ? null : current);
          navigate("compare");
        }
        if (
          active
          && (
            isLiveComparisonActive(nextExecution)
            || externalPendingKind(nextExecution) !== null
          )
        ) {
          timer = window.setTimeout(() => void poll(), 800);
        }
      } catch (error) {
        if (!active) return;
        if (!handleAuthExpired(error)) {
          setErrorMessage(
            "Live status polling stopped. The server did not substitute recorded evidence.",
          );
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    acceptExecution,
    execution?.error_code,
    execution?.execution_id,
    execution?.progress_step,
    execution?.status,
    handleAuthExpired,
    navigate,
  ]);

  const startLiveComparison = async () => {
    if (pendingAction !== null || execution !== null) return;
    setPendingAction("live");
    setErrorMessage(null);
    setMemoError(null);
    setState(null);
    try {
      const created = await createLiveComparison(newIdempotencyKey());
      setExecution(created);
      void runComparison(created.execution_id).then(
        async (finished) => {
          await acceptExecution(finished);
          if (
            hasResults(finished.status)
            && finished.progress_step === "RESULTS_READY"
          ) {
            setPendingAction((current) => current === "live" ? null : current);
            navigate("compare");
          }
        },
        (error: unknown) => {
          if (!handleAuthExpired(error)) {
            setErrorMessage(
              "The live request connection ended before completion. Authoritative status polling remains visible.",
            );
          }
        },
      ).finally(() => {
        setPendingAction((current) => current === "live" ? null : current);
      });
    } catch (error) {
      if (!handleAuthExpired(error)) {
        setErrorMessage(
          "Live comparison could not start. Use recorded evidence only by choosing it explicitly.",
        );
      }
      setPendingAction(null);
    }
  };

  const useRecordedDemo = async () => {
    if (
      pendingAction !== null
      || (execution !== null && isLiveComparisonActive(execution))
    ) return;
    setPendingAction("recorded");
    setErrorMessage(null);
    setMemoError(null);
    try {
      const selectedFallback = await selectRecordedFallback();
      if (
        selectedFallback.execution.source !== "RECORDED_FALLBACK"
        || selectedFallback.state.source !== "RECORDED_FALLBACK"
      ) {
        throw new Error("Recorded fallback source mismatch.");
      }
      terminalLoadRef.current.clear();
      setExecution(selectedFallback.execution);
      setState(selectedFallback.state);
      navigate("compare");
    } catch (error) {
      if (!handleAuthExpired(error)) {
        setErrorMessage(
          "Recorded fallback could not be selected. No live evidence was substituted.",
        );
      }
    } finally {
      setPendingAction(null);
    }
  };

  const mutateState = async (
    action: Exclude<DemoPendingAction, "live" | "recorded">,
    request: () => Promise<HackathonDemoState>,
  ) => {
    if (pendingAction !== null || !execution) return;
    setPendingAction(action);
    setErrorMessage(null);
    if (action === "memo") setMemoError(null);
    try {
      const nextState = await request();
      if (!executionSourceMatchesState(execution, nextState)) {
        throw new Error("Live and recorded evidence source mismatch.");
      }
      setState(nextState);
      if (
        action === "memo"
        && (
          nextState.status === "MEMO_FAILED"
          || nextState.memo?.status === "FAILED"
        )
      ) {
        setMemoError(
          "Decision Memo could not be generated from the recorded selection.",
        );
      }
    } catch (error) {
      if (handleAuthExpired(error)) return;
      let authoritativeExecution: LiveDemoExecution | null = null;
      if (action === "judge" || action === "memo") {
        try {
          authoritativeExecution = await getExecution(execution.execution_id);
          await acceptExecution(authoritativeExecution);
        } catch (refreshError) {
          if (handleAuthExpired(refreshError)) return;
        }
      }
      const recoveredExternalState = authoritativeExecution !== null && (
        externalPendingKind(authoritativeExecution) === action
        || (
          action === "judge"
          && (
            authoritativeExecution.status === "JUDGE_READY"
            || judgeFailureKind(authoritativeExecution) !== null
          )
        )
        || (
          action === "memo"
          && (
            authoritativeExecution.status === "MEMO_READY"
            || authoritativeExecution.status === "MEMO_FAILED"
          )
        )
      );
      if (recoveredExternalState) {
        if (action === "memo") setMemoError(null);
      } else if (action === "memo") {
        setMemoError(
          "Decision Memo could not be generated from the recorded selection.",
        );
      } else {
        setErrorMessage(
          "The requested demo step could not be completed. Existing evidence and human decisions remain unchanged.",
        );
      }
    } finally {
      setPendingAction(null);
    }
  };

  if (loading || challenge === null) {
    const failed = !loading && errorMessage !== null;
    return (
      <AppShell
        stage={stageLabel(stage)}
        status={failed ? "WITHHELD" : "LOADING"}
        statusTone={failed ? "block" : "review"}
        readOnly
        runSourceLabel="SYNTHETIC DEMO"
        stageHrefs={STAGE_HREFS}
      >
        <section className={`authoritative-state${failed ? " authoritative-state--error" : ""}`} role={failed ? "alert" : "status"}>
          <span className="section-kicker">{failed ? "DEMO WITHHELD" : "RESTORING LOCKED CHALLENGE"}</span>
          <h1>{failed ? "Synthetic demo evidence could not be restored." : "Loading the protected demo workspace…"}</h1>
          {failed ? <p>{errorMessage}</p> : null}
        </section>
      </AppShell>
    );
  }

  const serverExternalPending = externalPendingKind(execution);
  const restoredJudgeFailure = judgeFailureKind(execution);
  const shell = pendingAction === "live"
    ? { status: "LIVE COMPARISON RUNNING", tone: "review" as const }
    : pendingAction === "judge" || serverExternalPending === "judge"
    ? { status: "GPT-5.6 JUDGE RUNNING", tone: "review" as const }
    : pendingAction === "memo" || serverExternalPending === "memo"
      ? { status: "DECISION MEMO GENERATING", tone: "review" as const }
      : state
        ? shellStatus(stage, state)
        : { status: "READY", tone: "neutral" as const };
  const pending = pendingAction !== null || serverExternalPending !== null;
  const runsPerCandidate = state?.canary.candidates[0].runs.length ?? 1;
  const totalRuns = state?.canary.candidates.reduce(
    (total, candidate) => total + candidate.runs.length,
    0,
  ) ?? 0;
  const completedRuns = state?.canary.candidates.reduce(
    (total, candidate) => total + candidate.quality.complete_outputs,
    0,
  ) ?? execution?.completed_candidate_count ?? 0;
  const memoComplete = state?.memo?.status === "COMPLETE";
  const comparisonRunning = execution != null && isLiveComparisonActive(execution);
  return (
    <AppShell
      stage={stageLabel(stage)}
      status={shell.status}
      statusTone={shell.tone}
      readOnly={false}
      monitorAvailable={memoComplete}
      monitorHref={STAGE_HREFS.Monitor}
      hasApprovedBaseline={false}
      challengeVersionLabel="Locked demo · one ticket"
      workspaceIdLabel="HACKATHON DEMO"
      evaluationPackLabel={state?.canary.pack_id ?? "NOT CREATED"}
      evaluationPackMetaLabel={state
        ? `1 case · A/B/C · ${runsPerCandidate} run${runsPerCandidate === 1 ? "" : "s"} each`
        : "Awaiting explicit live or recorded source"}
      datasetLabel={`${challenge.case_id} · SYNTHETIC`}
      configurationLabel="A T1 · B T2 · C T3"
      runSourceLabel={state
        ? demoSourceLabel(state)
        : comparisonRunning
          ? "LIVE SYNTHETIC DEMO · RUNNING"
          : "NOT SELECTED"}
      priceBasisLabel="2026-07-17"
      stageHrefs={STAGE_HREFS}
      judgeSessionAction={
        execution === null ? "END_SESSION" : "START_NEW_COMPARISON"
      }
      judgeSessionActionDisabled={pending || comparisonRunning}
      stageStatuses={{
        Define: "LOCKED",
        Compare: comparisonRunning
          ? `${execution!.completed_candidate_count} / 3 LIVE`
          : pendingAction === "judge" || serverExternalPending === "judge"
          ? "JUDGE RUNNING"
          : state?.human_review
            ? "REVIEW COMPLETE"
            : state
              ? `${completedRuns} / ${totalRuns} ${state.source === "LIVE_SYNTHETIC_DEMO" ? "LIVE" : "RECORDED"}`
              : "NOT STARTED",
        Decide: pendingAction === "memo" || serverExternalPending === "memo"
          ? "MEMO GENERATING"
          : memoComplete
            ? "MEMO READY"
            : state?.status === "NO_APPROVED_CANDIDATE"
              ? "NO APPROVED"
              : state?.selection
                ? "SELECTION RECORDED"
                : "NO DECISION",
        Monitor: state?.regression ? "BLOCK" : memoComplete ? "READY" : "NO DECISION",
      }}
    >
      {stage === "define" ? (
        <DefineDemo
          challenge={challenge}
          execution={execution}
          state={state}
          pending={pending}
          pendingSource={pendingAction === "live" || pendingAction === "recorded"
            ? pendingAction
            : null}
          errorMessage={errorMessage}
          onRunLive={() => void startLiveComparison()}
          onUseRecorded={() => void useRecordedDemo()}
          onContinue={() => navigate("compare")}
        />
      ) : null}
      {stage !== "define" && comparisonRunning ? (
        <div className="page-stack">
          <StageHeader
            kicker="LIVE COMPARISON IN PROGRESS"
            title="The same locked ticket is running through A, B, and C"
            description="Progress is restored from the server. Recorded evidence is not used automatically."
          />
          <LiveComparisonProgress execution={execution!} />
        </div>
      ) : null}
      {stage !== "define" && errorMessage ? (
        <div className="demo-inline-error demo-inline-error--workspace" role="alert">
          <strong>Demo step could not continue</strong>
          <span>{errorMessage}</span>
        </div>
      ) : null}
      {stage === "compare" && !comparisonRunning && state ? (
        <CompareDemo
          state={state}
          pending={pending}
          judgePending={pendingAction === "judge" || serverExternalPending === "judge"}
          judgeFailure={restoredJudgeFailure}
          onRunJudge={() => void mutateState(
            "judge",
            () => runJudge(execution!.execution_id),
          )}
          onCompleteReview={(body) => void mutateState(
            "review",
            () => confirmReviews(execution!.execution_id, body),
          )}
          onContinue={() => navigate("decide")}
        />
      ) : null}
      {stage === "decide" && !comparisonRunning && state ? (
        <DecideDemo
          state={state}
          pending={pending}
          memoPending={pendingAction === "memo" || serverExternalPending === "memo"}
          memoError={memoError}
          onSelectCandidate={(body) => void mutateState(
            "selection",
            () => selectCandidate(execution!.execution_id, body),
          )}
          onCreateMemo={() => void mutateState(
            "memo",
            () => createDecisionMemo(execution!.execution_id),
          )}
          onContinue={() => navigate("monitor")}
        />
      ) : null}
      {stage === "monitor" && !comparisonRunning && state ? (
        <MonitorDemo
          state={state}
          pending={pending}
          onReplay={() => void mutateState(
            "regression",
            () => replayRegression(execution!.execution_id),
          )}
        />
      ) : null}
      {stage !== "define" && !comparisonRunning && state === null ? (
        <section className="authoritative-state" role="status">
          <span className="section-kicker">NO EVIDENCE SOURCE SELECTED</span>
          <h1>Start the live comparison or explicitly choose the recorded demo.</h1>
          <button className="button button--primary" type="button" onClick={() => navigate("define")}>
            Return to Define
          </button>
        </section>
      ) : null}
    </AppShell>
  );
}

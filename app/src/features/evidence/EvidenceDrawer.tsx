import {
  Archive,
  BracketsCurly,
  CheckCircle,
  ClipboardText,
  Database,
  Info,
  ShieldCheck,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { StatusBadge } from "../../components/StatusBadge";
import type { EvidenceRecord, HumanReviewDecision } from "../../domain/types";
import type { RecordedBlindReviewEvidenceDetailView } from "./recordedBlindReviewEvidenceContract";

interface EvidenceDrawerProps {
  evidence: EvidenceRecord | null;
  readOnly: boolean;
  humanReviewAllowed: boolean;
  humanReviewLockReason: string;
  onHumanConfirmation: (evidenceId: string, decision: HumanReviewDecision, rationale: string) => boolean;
  onClose: () => void;
}

function sourceTone(source: EvidenceRecord["source"]) {
  return source === "BLIND HUMAN REVIEW" ? "review" : "recorded";
}

function statusTone(status: EvidenceRecord["status"]) {
  if (status === "PASS") return "pass";
  if (status === "BLOCK") return "block";
  if (status === "CONFIRMED FAIL") return "fail";
  if (status === "INVALID" || status === "TIMEOUT" || status === "BUDGET EXCEEDED") return "run-error";
  return "review";
}

type BlindRunDetail = RecordedBlindReviewEvidenceDetailView["runs"][number];

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function citationLabel(citation: unknown): string {
  if (typeof citation !== "object" || citation === null) return "Invalid citation";
  const value = citation as Record<string, unknown>;
  return `${String(value.source_id)}#${String(value.section_id)}`;
}

function riskAppliesToRun(risk: Record<string, unknown>, runNumber: 1 | 2): boolean {
  const references = risk.evidence_references;
  return Array.isArray(references) && references.some(
    (reference) => reference === `RUN_${runNumber}`,
  );
}

function BlindRunEvidence({
  run,
  runNumber,
  judgeRisks,
}: {
  readonly run: BlindRunDetail;
  readonly runNumber: 1 | 2;
  readonly judgeRisks: readonly Record<string, unknown>[];
}) {
  const runRisks = judgeRisks.filter((risk) => riskAppliesToRun(risk, runNumber));
  return (
    <section
      className="evidence-section blind-run-evidence"
      aria-label={`Run ${runNumber} validated evidence`}
    >
      <div className="evidence-section__title">
        <ShieldCheck aria-hidden="true" />
        <span className="eyebrow">Run {runNumber}</span>
        <h3>Validated evidence</h3>
        <StatusBadge
          tone={run.execution_status === "COMPLETE" ? "pass" : "run-error"}
          compact
        >
          {run.execution_status.replaceAll("_", " ")}
        </StatusBadge>
      </div>

      {run.execution_status === "COMPLETE" ? (
        <>
          <h4>Candidate reply</h4>
          <blockquote>{run.customer_reply}</blockquote>

          <h4>Structured decision</h4>
          <pre className="structured-decision">{json(run.structured_decision)}</pre>

          <h4>Citations</h4>
          <div className="evidence-id-list">
            {(Array.isArray(run.citations) ? run.citations : []).map((citation, index) => (
              <code key={`${citationLabel(citation)}-${index}`}>{citationLabel(citation)}</code>
            ))}
          </div>

          <h4>Deterministic checks</h4>
          <ul className="check-list">
            {run.deterministic_checks.map((check) => {
              const findings = Array.isArray(check.findings) ? check.findings : [];
              return (
                <li key={String(check.gate_code)}>
                  {String(check.gate_code)} · {String(check.status)}
                  {findings.map((finding, index) => (
                    <span key={`${String(check.gate_code)}-${index}`}>
                      {` · ${String((finding as Record<string, unknown>).finding_code)}`}
                    </span>
                  ))}
                </li>
              );
            })}
          </ul>

          <h4>Normalized evidence</h4>
          <pre>{json(run.normalized_access_trace)}</pre>
        </>
      ) : (
        <p>
          This terminal execution produced no candidate output. Its recorded
          status is preserved as deterministic execution evidence.
        </p>
      )}

      <h4>GPT-5.6 auxiliary risk</h4>
      {runRisks.length > 0 ? (
        <ul className="check-list">
          {runRisks.map((risk, index) => (
            <li key={`${String(risk.failure_type)}-${index}`}>
              {String(risk.failure_type)} · {String(risk.rationale)}
            </li>
          ))}
        </ul>
      ) : <p>No auxiliary risk is recorded for this run.</p>}
      <small>Auxiliary signals route work for human confirmation. They cannot approve or reject a candidate.</small>
    </section>
  );
}

export function EvidenceDrawer({ evidence, readOnly, humanReviewAllowed, humanReviewLockReason, onHumanConfirmation, onClose }: EvidenceDrawerProps) {
  const titleId = useId();
  const statusLabelId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [humanDecision, setHumanDecision] = useState<"PASS" | "CONFIRMED FAIL" | null>(null);
  const [rationale, setRationale] = useState("");

  useEffect(() => {
    setHumanDecision(null);
    setRationale("");
  }, [evidence?.id]);

  useEffect(() => {
    if (!evidence) return;

    const appRoot = document.getElementById("app-shell-root");
    const previousOverflow = document.body.style.overflow;
    if (appRoot) appRoot.inert = true;
    document.body.style.overflow = "hidden";

    const frame = window.requestAnimationFrame(() => titleRef.current?.focus());

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === titleRef.current)) {
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
    };
  }, [evidence, onClose]);

  if (!evidence) return null;

  const isBlind = evidence.kind === "blind-review";
  const isRegression = evidence.kind === "regression";
  const reviewControlsDisabled = readOnly || !humanReviewAllowed;
  const saveDisabled = !humanDecision || rationale.trim().length < 8 || reviewControlsDisabled;

  return createPortal(
    <div className="drawer-layer">
      <button className="drawer-scrim" type="button" tabIndex={-1} aria-label="Close Evidence" onClick={onClose} />
      <div
        className="evidence-drawer"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${titleId} ${statusLabelId}`}
      >
        <header className="drawer-header">
          <div>
            <span className="section-kicker"><Archive aria-hidden="true" size={14} /> EVIDENCE RECORD</span>
            <h2 id={titleId} ref={titleRef} tabIndex={-1} aria-describedby={statusLabelId}>{evidence.title}</h2>
            <span className="sr-only" id={statusLabelId}>· Status {evidence.status}</span>
          </div>
          <button className="icon-button" type="button" aria-label="Close Evidence drawer" onClick={onClose}>
            <X aria-hidden="true" size={20} weight="bold" />
          </button>
        </header>

        <div className="drawer-status-row">
          <StatusBadge tone={sourceTone(evidence.source)}>{evidence.source}</StatusBadge>
          <StatusBadge tone={statusTone(evidence.status)}>{evidence.status}</StatusBadge>
        </div>

        <div className="drawer-body">
          <dl className="evidence-identity">
            <div><dt>Case</dt><dd>{evidence.caseId}</dd></div>
            <div><dt>{isBlind ? "Anonymous candidate" : "Candidate"}</dt><dd>{evidence.candidateLabel}</dd></div>
            <div><dt>Source record</dt><dd>Immutable run evidence</dd></div>
          </dl>

          <section className="evidence-section">
            <div className="evidence-section__title"><Info aria-hidden="true" /> <h3>Case summary</h3></div>
            <p>{evidence.caseSummary}</p>
          </section>

          <section className="evidence-section">
            <div className="evidence-section__title"><ShieldCheck aria-hidden="true" /> <h3>Expected decision</h3></div>
            <p>{evidence.expectedDecision}</p>
          </section>

          {isBlind ? (
            <>
              {evidence.blindDetail ? (
                <>
                  <section className="evidence-section" aria-label="Structured blind review detail">
                  <div className="evidence-section__title"><ShieldCheck aria-hidden="true" /> <h3>Independent review detail</h3></div>
                  <dl className="evidence-identity">
                    <div><dt>Review authority</dt><dd>{String(evidence.blindDetail.review_authority)}</dd></div>
                    <div><dt>Binding</dt><dd>{evidence.blindDetail.detail_binding_hash.slice(0, 16)}…</dd></div>
                  </dl>
                  <p>Candidate identity and execution transport remain withheld. Each fixed run below is independently rendered from the validated reviewer detail.</p>
                  </section>
                  <BlindRunEvidence
                    run={evidence.blindDetail.runs[0]}
                    runNumber={1}
                    judgeRisks={evidence.blindDetail.judge_risks}
                  />
                  <BlindRunEvidence
                    run={evidence.blindDetail.runs[1]}
                    runNumber={2}
                    judgeRisks={evidence.blindDetail.judge_risks}
                  />
                </>
              ) : null}

              <section className="evidence-section">
                <div className="evidence-section__title"><Database aria-hidden="true" /> <h3>Locked policy evidence</h3></div>
                <div className="evidence-id-list">
                  {evidence.policyIds?.map((policyId) => <code key={policyId}>{policyId}</code>)}
                </div>
                <p>Use these locked requirements with the expected decision when recording the human rationale.</p>
              </section>

              <form
                className="human-confirmation"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!saveDisabled && humanDecision) {
                    const saved = onHumanConfirmation(evidence.id, humanDecision, rationale.trim());
                    if (saved) onClose();
                  }
                }}
              >
                {!humanReviewAllowed ? <p className="review-order-lock" role="status">{humanReviewLockReason}</p> : null}
                <fieldset disabled={reviewControlsDisabled}>
                  <legend>Review decision</legend>
                  <label className={humanDecision === "PASS" ? "is-selected" : ""}>
                    <input
                      type="radio"
                      aria-label="PASS"
                      name="human-decision"
                      autoComplete="off"
                      value="PASS"
                      checked={humanDecision === "PASS"}
                      onChange={() => setHumanDecision("PASS")}
                      disabled={reviewControlsDisabled}
                    />
                    <CheckCircle aria-hidden="true" />
                    <span><strong>PASS</strong><small>No locked failure is present in either run.</small></span>
                  </label>
                  <label className={humanDecision === "CONFIRMED FAIL" ? "is-selected" : ""}>
                    <input
                      type="radio"
                      aria-label="CONFIRMED FAIL"
                      name="human-decision"
                      autoComplete="off"
                      value="CONFIRMED FAIL"
                      checked={humanDecision === "CONFIRMED FAIL"}
                      onChange={() => setHumanDecision("CONFIRMED FAIL")}
                      disabled={reviewControlsDisabled}
                    />
                    <X aria-hidden="true" />
                    <span><strong>CONFIRMED FAIL</strong><small>A locked failure is present and supported by Evidence.</small></span>
                  </label>
                </fieldset>
                <label className="field-label" htmlFor="human-rationale">Required rationale</label>
                <textarea
                  id="human-rationale"
                  name="human-rationale"
                  value={rationale}
                  onChange={(event) => setRationale(event.target.value)}
                  placeholder="Cite the output and locked requirement that support this decision…"
                  autoComplete="off"
                  aria-describedby="human-rationale-help"
                  rows={3}
                  disabled={reviewControlsDisabled}
                  required
                />
                <p className="field-help" id="human-rationale-help">Enter at least 8 characters and cite the output or locked requirement that supports the decision.</p>
                <button className="button button--primary button--full" type="submit" disabled={saveDisabled}>
                  Save human confirmation
                </button>
              </form>
            </>
          ) : isRegression ? (
            <>
              <div className="regression-diff" aria-label="Baseline and proposed output diff">
                <section>
                  <span className="diff-label diff-label--baseline">Baseline v1</span>
                  <p>{evidence.baselineOutput}</p>
                </section>
                <section>
                  <span className="diff-label diff-label--failed">Proposed v2</span>
                  <p>{evidence.proposedOutput}</p>
                </section>
                <div className="diff-legend" aria-label="Diff legend">
                  <span>Baseline</span><span>Removed</span><span>Added</span><span>Changed</span><span>Failed</span>
                </div>
              </div>
              <EvidenceDetails evidence={evidence} />
            </>
          ) : (
            <>
              <section className="evidence-section evidence-output">
                <div className="evidence-section__title"><ClipboardText aria-hidden="true" /> <h3>Candidate output</h3></div>
                <blockquote>{evidence.candidateOutput}</blockquote>
                <p className="structured-decision"><strong>Structured decision</strong><br />{evidence.structuredDecision}</p>
              </section>
              <EvidenceDetails evidence={evidence} />
            </>
          )}

          {!isBlind && evidence.metadata?.length ? (
            <section className="evidence-section run-metadata">
              <div className="evidence-section__title"><Archive aria-hidden="true" /> <h3>Run metadata</h3></div>
              <ul>
                {evidence.metadata.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </section>
          ) : null}

          {!isBlind ? (
            <details className="technical-details">
              <summary><BracketsCurly aria-hidden="true" /> Technical details</summary>
              <pre>{JSON.stringify({ case_id: evidence.caseId, source: evidence.source, status: evidence.status }, null, 2)}</pre>
            </details>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function EvidenceDetails({ evidence }: { evidence: EvidenceRecord }) {
  return (
    <>
      <section className="evidence-section">
        <div className="evidence-section__title"><Database aria-hidden="true" /> <h3>Retrieved policy and tool evidence</h3></div>
        <div className="evidence-id-list">
          {evidence.policyIds?.map((policyId) => <code key={policyId}>{policyId}</code>)}
        </div>
        <p>{evidence.toolEvidence}</p>
      </section>

      <section className="evidence-section">
        <div className="evidence-section__title"><ShieldCheck aria-hidden="true" /> <h3>Deterministic checks</h3></div>
        <ul className="check-list">
          {evidence.deterministicChecks?.map((check) => <li key={check}>{check}</li>)}
        </ul>
      </section>

      <section className="evidence-section">
        <div className="evidence-section__title"><Sparkle aria-hidden="true" /> <h3>GPT-5.6 auxiliary risk signal</h3></div>
        <p>{evidence.riskSignal}</p>
        <small>Auxiliary signal only. Deterministic checks and human confirmation retain authority.</small>
      </section>

      <section className="evidence-section">
        <div className="evidence-section__title"><CheckCircle aria-hidden="true" /> <h3>Human confirmation</h3></div>
        <p>{evidence.humanConfirmation}</p>
      </section>
    </>
  );
}

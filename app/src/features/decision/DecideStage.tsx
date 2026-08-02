import {
  ArrowRight,
  ChartScatter,
  CheckCircle,
  ClipboardText,
  CurrencyDollar,
  Eye,
  Lightning,
  Scales,
  ShieldWarning,
  Timer,
} from "@phosphor-icons/react";
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { StatusBadge } from "../../components/StatusBadge";
import { candidates, completedReviewQueue, createPendingReviewQueue } from "../../data/fixtures";
import {
  confirmApprovedDecision,
  createDecisionDraft,
  isReviewQueueComplete,
} from "../../domain/decisionMachine";
import type { CandidateId, CandidateResult, GateStatus } from "../../domain/types";
import { formatAuditTimestamp, formatDecimal, formatUsd } from "../../utils/formatters";
import { HumanReviewQueue } from "./HumanReviewQueue";

export interface RestoredBaselineDecision {
  candidateId: Exclude<CandidateId, "A">;
  actor: string;
  reason: string;
  decisionRecordedAt: string;
}

interface DecideStageProps {
  readOnly: boolean;
  reviewPending: boolean;
  pendingConfirmedFailure: boolean;
  confirmedFailedCandidateIds: ReadonlySet<CandidateId>;
  resolvedReviewIds: ReadonlySet<string>;
  restoredBaselineDecision: RestoredBaselineDecision | null;
  onBaselineCreated: (decision: RestoredBaselineDecision) => void;
  onDecisionDraftChange: (started: boolean) => void;
  onOpenEvidence: (evidenceId: string) => void;
}

function gateTone(status: GateStatus) {
  if (status === "PASS") return "pass";
  if (status === "CONFIRMED FAIL") return "fail";
  return "review";
}

function defaultReasonForCandidate(candidateId: CandidateId) {
  if (candidateId === "C") {
    return "Candidate C is the selected passing configuration because the decision owner prioritizes full policy-case coverage and accepts the documented cost, latency, and read-only tool dependencies.";
  }
  return "Candidate B is the least complex configuration that passes every locked requirement while preserving traceable policy evidence.";
}

export function DecideStage({ readOnly, reviewPending, pendingConfirmedFailure, confirmedFailedCandidateIds, resolvedReviewIds, restoredBaselineDecision, onBaselineCreated, onDecisionDraftChange, onOpenEvidence }: DecideStageProps) {
  const queue = reviewPending ? createPendingReviewQueue(resolvedReviewIds) : completedReviewQueue;
  const reviewsComplete = isReviewQueueComplete(queue);
  const evaluationReady = reviewsComplete;
  const remainingReviews = (queue.requiredTotal - queue.requiredCompleted) + (queue.flaggedTotal - queue.flaggedCompleted);
  const hasPendingAggregateUpdate = !reviewsComplete && pendingConfirmedFailure;
  const eligibleCandidates = candidates
    .filter((candidate) => candidate.gates.every((gate) => gate.status === "PASS"))
    .filter((candidate) => !confirmedFailedCandidateIds.has(candidate.id))
    .sort((left, right) => left.tier - right.tier);
  const eligibleCandidateIds = eligibleCandidates.map((candidate) => candidate.id);
  const recommendedCandidate = eligibleCandidates[0] ?? null;
  const [selectedCandidateId, setSelectedCandidateId] = useState<CandidateId | null>(restoredBaselineDecision?.candidateId ?? null);
  const [reason, setReason] = useState(restoredBaselineDecision?.reason ?? "");
  const [memoReviewed, setMemoReviewed] = useState(false);
  const [confirmedDecision, setConfirmedDecision] = useState<ReturnType<typeof confirmApprovedDecision> | null>(() => {
    if (!restoredBaselineDecision) return null;
    return confirmApprovedDecision(createDecisionDraft({
      selectedCandidateId: restoredBaselineDecision.candidateId,
      reason: restoredBaselineDecision.reason,
      actor: restoredBaselineDecision.actor,
    }), {
      memoReviewed: true,
      evaluationComplete: true,
      eligibleCandidateIds: [restoredBaselineDecision.candidateId],
      recordedAt: restoredBaselineDecision.decisionRecordedAt,
    });
  });

  const selectedCandidate = useMemo(
    () => candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null,
    [selectedCandidateId],
  );

  useEffect(() => {
    onDecisionDraftChange(Boolean(selectedCandidate && reason.trim()));
  }, [onDecisionDraftChange, reason, selectedCandidate]);

  useEffect(() => {
    if (selectedCandidateId && !eligibleCandidateIds.includes(selectedCandidateId)) {
      setSelectedCandidateId(null);
      setReason("");
      setMemoReviewed(false);
      setConfirmedDecision(null);
    }
  }, [eligibleCandidateIds, selectedCandidateId]);

  function confirmDecision() {
    if (!selectedCandidateId || !selectedCandidate) return;
    const draft = createDecisionDraft({
      selectedCandidateId,
      reason,
      actor: "Morgan Lee · AI Adoption Lead",
    });
    const confirmed = confirmApprovedDecision(draft, {
      memoReviewed,
      evaluationComplete: evaluationReady,
      eligibleCandidateIds,
    });
    setConfirmedDecision(confirmed);
    if (selectedCandidateId === "B" || selectedCandidateId === "C") {
      onBaselineCreated({
        candidateId: selectedCandidateId,
        actor: confirmed.audit.actor,
        reason: confirmed.audit.reason,
        decisionRecordedAt: confirmed.audit.decisionRecordedAt,
      });
    }
  }

  return (
    <div className="page-stack">
      <div className="page-header">
        <div>
          <span className="page-index">03 / DECIDE</span>
          <h1>Decide with evidence</h1>
          <p>Apply locked gates first, then compare sufficient candidates without hiding cost or operational complexity.</p>
        </div>
        <div className="page-header__status">
          <div className="page-status-badges">
            <StatusBadge tone="recorded">RECORDED BENCHMARK</StatusBadge>
            <StatusBadge tone={reviewsComplete ? "pass" : "review"}>
              {reviewsComplete ? "EVIDENCE READY" : "EVALUATION INCOMPLETE"}
            </StatusBadge>
          </div>
          <span>72 recorded runs · eval-pack-01</span>
        </div>
      </div>

      {!evaluationReady ? (
        <div className="incomplete-banner" role="alert">
          <ShieldWarning aria-hidden="true" size={22} weight="fill" />
          <div>
            <strong>Evaluation is incomplete.</strong>
            <span>{hasPendingAggregateUpdate
              ? "A blind review recorded a confirmed failure. Finish the locked queue before identities are revealed and candidate eligibility is recalculated."
              : "Finish all required and Judge-flagged blind reviews before recommendation, Memo confirmation, or baseline creation."}</span>
          </div>
        </div>
      ) : null}

      <section className="section-panel" aria-labelledby="hard-gates-title">
        <div className="section-heading section-heading--split">
          <div>
            <span className="section-kicker"><ShieldWarning aria-hidden="true" size={14} weight="bold" /> NON-NEGOTIABLE</span>
            <h2 id="hard-gates-title">Hard gates</h2>
            <p>A confirmed failure cannot be offset by quality, cost, or latency.</p>
          </div>
          <div className="locked-rule"><CheckCircle aria-hidden="true" size={16} weight="fill" /> Locked before hidden runs</div>
        </div>
        <HardGateMatrix confirmedFailedCandidateIds={confirmedFailedCandidateIds} onOpenEvidence={onOpenEvidence} />
      </section>

      <HumanReviewQueue queue={queue} readOnly={readOnly} onOpenNext={onOpenEvidence} />

      {!hasPendingAggregateUpdate ? <>
      <section className="section-panel" aria-labelledby="metrics-title">
        <div className="section-heading section-heading--split">
          <div>
            <span className="section-kicker"><Scales aria-hidden="true" size={14} weight="bold" /> COUNT-BASED EVIDENCE</span>
            <h2 id="metrics-title">Sufficiency, cost, and reliability</h2>
            <p>Counts stay visible. There is no composite AI score.</p>
          </div>
          <span className="table-note">Per-ticket runtime cost includes retrieval, tools, retries, and failed calls.</span>
        </div>
        <CandidateMetricsTable confirmedFailedCandidateIds={confirmedFailedCandidateIds} onOpenEvidence={onOpenEvidence} />
      </section>

      <section className="section-panel" aria-labelledby="tradeoff-title">
        <div className="section-heading section-heading--split">
          <div>
            <span className="section-kicker"><ChartScatter aria-hidden="true" size={14} weight="bold" /> TRADE-OFF</span>
            <h2 id="tradeoff-title">Quality–cost trade-off</h2>
            <p>Compare observed quality and runtime cost; operational complexity remains a separate decision.</p>
          </div>
          <StatusBadge tone="neutral">NO COMPOSITE SCORE</StatusBadge>
        </div>
        <TradeoffChart confirmedFailedCandidateIds={confirmedFailedCandidateIds} onOpenEvidence={onOpenEvidence} />
      </section>
      </> : (
        <section className="section-panel decision-lock" aria-labelledby="aggregate-lock-title">
          <div className="decision-lock__icon"><ShieldWarning aria-hidden="true" size={24} weight="fill" /></div>
          <div>
            <span className="section-kicker">AGGREGATE UPDATE PENDING</span>
            <h2 id="aggregate-lock-title">Candidate identities remain blinded</h2>
            <p>A confirmed failure is recorded, but its candidate identity stays hidden until the deterministic queue closes. Candidate metrics and the trade-off chart will update after unblinding.</p>
          </div>
          <StatusBadge tone="review">REVIEW QUEUE OPEN</StatusBadge>
        </section>
      )}

      <section className={`recommendation-panel${evaluationReady ? "" : " is-withheld"}`} aria-labelledby="recommendation-title">
        <div className="recommendation-index" aria-hidden="true">R</div>
        {evaluationReady && recommendedCandidate ? (
          <>
            <div className="recommendation-copy">
              <span className="section-kicker">SYSTEM RECOMMENDATION · LOCKED RULES</span>
              <h2 id="recommendation-title">{recommendedCandidate.id === "B" && eligibleCandidateIds.includes("C")
                ? "Candidate B is the least complex sufficient configuration."
                : `${recommendedCandidate.name} is the only configuration that remains sufficient.`}</h2>
              <p>{recommendedCandidate.id === "C"
                ? "Candidate B became ineligible after a blind human review confirmed a locked safety-escalation failure. Candidate C remains sufficient, with its added cost, latency, and read-only tool dependencies exposed for the owner."
                : eligibleCandidateIds.includes("C")
                  ? `Candidate B passes every hard gate and the locked count thresholds at Tier 2. Candidate C improves one policy case, but adds tool dependencies, ${formatUsd(candidates[2].cost - candidates[1].cost)} per ticket, and ${formatDecimal(candidates[2].medianLatency - candidates[1].medianLatency, 1)} seconds of median latency.`
                  : "Candidate C became ineligible after a blind human review confirmed a locked tool-evidence failure. Candidate B remains sufficient at Tier 2."}</p>
              <div className="recommendation-proof">
                <span><CheckCircle aria-hidden="true" weight="fill" /> 4 / 4 hard gates</span>
                <span><CurrencyDollar aria-hidden="true" /> {formatUsd(recommendedCandidate.cost)} / ticket</span>
                <span><Timer aria-hidden="true" /> {formatDecimal(recommendedCandidate.medianLatency, 1)} s median</span>
                <span><Lightning aria-hidden="true" /> Tier {recommendedCandidate.tier} complexity</span>
              </div>
            </div>
            <button className="evidence-link" type="button" onClick={() => onOpenEvidence(
              recommendedCandidate.id === "C"
                ? "decision-c-only-sufficient"
                : eligibleCandidateIds.includes("C")
                  ? "decision-b-sufficiency"
                  : "decision-b-only-sufficient",
            )}>
              Inspect decision rule <ArrowRight aria-hidden="true" />
            </button>
          </>
        ) : evaluationReady ? (
          <>
            <div className="recommendation-copy">
              <span className="section-kicker">SYSTEM RECOMMENDATION · LOCKED RULES</span>
              <h2 id="recommendation-title">No candidate passed every locked requirement.</h2>
              <p>Candidate A failed the active-policy gate, and blind human confirmation made Candidates B and C ineligible. No winner or fallback is inferred.</p>
            </div>
            <a className="evidence-link" href="/?view=no-approved&reason=human-review-failed">
              Record no approved candidate <ArrowRight aria-hidden="true" />
            </a>
          </>
        ) : (
          <div className="recommendation-copy">
            <span className="section-kicker">SYSTEM RECOMMENDATION · WITHHELD</span>
            <h2 id="recommendation-title">Recommendation withheld until human review is complete.</h2>
            <p>{remainingReviews} blind confirmation{remainingReviews === 1 ? "" : "s"} remain. No candidate recommendation is calculated or exposed while required Evidence is unresolved.</p>
          </div>
        )}
      </section>

      {evaluationReady && recommendedCandidate ? (
        <section className="decision-grid" aria-label="Human decision and Decision Memo">
        <div className="section-panel human-decision">
          <div className="section-heading">
            <span className="section-kicker"><Eye aria-hidden="true" size={14} weight="bold" /> HUMAN OWNED</span>
            <h2>Human decision</h2>
            <p>The recommendation is evidence, not an automatic purchase decision.</p>
          </div>

          {confirmedDecision ? (
            <div className="baseline-confirmed" role="status">
              <StatusBadge tone="baseline">ACTIVE BASELINE</StatusBadge>
              <h3>{confirmedDecision.baseline.id}</h3>
              <p>The decision and baseline were recorded as one controlled action.</p>
              <dl>
                <div><dt>Decision owner</dt><dd>{confirmedDecision.audit.actor}</dd></div>
                <div><dt>Decision recorded at</dt><dd>{formatAuditTimestamp(confirmedDecision.audit.decisionRecordedAt)}</dd></div>
                <div><dt>Evaluation pack</dt><dd>eval-pack-01 · immutable</dd></div>
              </dl>
              <a className="button button--primary button--full" href={`/?view=monitor&baseline=${selectedCandidateId}`}>Review proposed change <ArrowRight aria-hidden="true" /></a>
            </div>
          ) : (
            <>
              <StatusBadge tone="neutral">{selectedCandidate && reason.trim() ? "DECISION DRAFT" : "SELECTION REQUIRED"}</StatusBadge>
              <fieldset className="candidate-choice" disabled={!evaluationReady || readOnly}>
                <legend>Select an approved candidate</legend>
                {eligibleCandidates.map((candidate) => (
                  <label key={candidate.id} className={selectedCandidateId === candidate.id ? "is-selected" : ""}>
                    <input
                      type="radio"
                      name="selected-candidate"
                      autoComplete="off"
                      value={candidate.id}
                      checked={selectedCandidateId === candidate.id}
                      onChange={() => {
                        setSelectedCandidateId(candidate.id);
                        setReason(defaultReasonForCandidate(candidate.id));
                        setMemoReviewed(false);
                      }}
                    />
                    <span className="candidate-choice__letter">{candidate.id}</span>
                    <span><strong>{candidate.shortName}</strong><small>Tier {candidate.tier} · {formatUsd(candidate.cost)} / ticket</small></span>
                    {candidate.id === recommendedCandidate.id ? <StatusBadge tone="pass" compact>RECOMMENDED</StatusBadge> : null}
                  </label>
                ))}
              </fieldset>
              <label className="field-label" htmlFor="decision-rationale">Required decision rationale</label>
              <textarea
                id="decision-rationale"
                name="decision-rationale"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  setMemoReviewed(false);
                }}
                placeholder="Select a passing candidate, then record the decision owner's rationale."
                autoComplete="off"
                rows={5}
                disabled={!selectedCandidate || readOnly}
              />
              <p className="choice-footnote">Only candidates that pass every locked gate and blind human confirmation remain selectable.</p>
              {readOnly ? (
                <span className="text-link is-disabled" aria-disabled="true">Record no approved candidate instead</span>
              ) : (
                <a className="text-link" href="/?view=no-approved&reason=owner-declined">Record no approved candidate instead</a>
              )}
            </>
          )}
        </div>

        <div className="section-panel decision-memo">
          <div className="section-heading section-heading--split">
            <div>
              <span className="section-kicker"><ClipboardText aria-hidden="true" size={14} weight="bold" /> DECISION EVIDENCE</span>
              <h2>Decision Memo</h2>
              <p>A handoff record for the next PoC, procurement review, and regression baseline.</p>
            </div>
            <span className="version-chip">{confirmedDecision ? "FINAL · memo-01" : selectedCandidate && reason.trim() ? "DRAFT · memo-01" : "NOT STARTED"}</span>
          </div>

          <MemoPreview candidate={selectedCandidate} reason={reason} confirmedFailedCandidateIds={confirmedFailedCandidateIds} />

          {!confirmedDecision ? (
            <div className="memo-confirmation">
              <label>
                <input
                  type="checkbox"
                  name="memo-reviewed"
                  autoComplete="off"
                  aria-label="I reviewed the Decision Memo"
                  checked={memoReviewed}
                  onChange={(event) => setMemoReviewed(event.target.checked)}
                  disabled={!evaluationReady || !selectedCandidate || !reason.trim() || readOnly}
                />
                <span><strong>I reviewed the Decision Memo</strong><small>This confirms the rationale, limitations, evidence set, and next PoC scope.</small></span>
              </label>
              <button
                className="button button--primary button--full"
                type="button"
                disabled={!evaluationReady || !selectedCandidate || !memoReviewed || !reason.trim() || readOnly}
                onClick={confirmDecision}
              >
                Confirm decision and set baseline <ArrowRight aria-hidden="true" size={16} weight="bold" />
              </button>
              <p>One action records the decision audit and activates {selectedCandidate ? `${selectedCandidate.name} v1` : "the selected candidate v1"}. There is no partial completion state.</p>
            </div>
          ) : null}
        </div>
        </section>
      ) : evaluationReady ? (
        <section className="section-panel decision-lock" aria-labelledby="no-candidate-lock-title">
          <div className="decision-lock__icon"><ShieldWarning aria-hidden="true" size={24} weight="fill" /></div>
          <div>
            <span className="section-kicker">VALID DECISION OUTCOME</span>
            <h2 id="no-candidate-lock-title">No baseline can be created from this evaluation</h2>
            <p>Every candidate has a confirmed locked failure. Record the no-approved-candidate rationale and next PoC conditions without creating a fallback baseline.</p>
          </div>
          <a className="button button--secondary" href="/?view=no-approved&reason=human-review-failed">Open decision record <ArrowRight aria-hidden="true" /></a>
        </section>
      ) : (
        <section className="section-panel decision-lock" aria-labelledby="decision-lock-title">
          <div className="decision-lock__icon"><ShieldWarning aria-hidden="true" size={24} weight="fill" /></div>
          <div>
            <span className="section-kicker">HUMAN CONTROL REQUIRED</span>
            <h2 id="decision-lock-title">Decision actions locked</h2>
          <p>Complete the remaining blind reviews before a recommendation, candidate choice, Decision Memo, or baseline can be created.</p>
          </div>
          <StatusBadge tone="review">{`${remainingReviews} REVIEW${remainingReviews === 1 ? "" : "S"} REMAIN`}</StatusBadge>
        </section>
      )}
    </div>
  );
}

const humanFailureGateByCandidate: Partial<Record<CandidateId, { gateId: string; evidenceId: string }>> = {
  B: { gateId: "safety", evidenceId: "human-review-b-h017" },
  C: { gateId: "tool", evidenceId: "human-review-c-h021" },
};

function resolvedGate(candidate: CandidateResult, gateIndex: number, confirmedFailedCandidateIds: ReadonlySet<CandidateId>) {
  const gate = candidate.gates[gateIndex];
  const humanFailure = humanFailureGateByCandidate[candidate.id];
  if (confirmedFailedCandidateIds.has(candidate.id) && humanFailure?.gateId === gate.id) {
    return { ...gate, status: "CONFIRMED FAIL" as const, evidenceId: humanFailure.evidenceId };
  }
  return gate;
}

function HardGateMatrix({ confirmedFailedCandidateIds, onOpenEvidence }: { confirmedFailedCandidateIds: ReadonlySet<CandidateId>; onOpenEvidence: (evidenceId: string) => void }) {
  const gateLabels = candidates[0].gates.map((gate) => gate.label);
  return (
    <div className="table-scroll" tabIndex={0} aria-label="Scrollable hard-gate matrix">
      <table className="data-table gate-table">
        <thead>
          <tr>
            <th scope="col">Locked hard gate</th>
            {candidates.map((candidate) => (
              <th scope="col" key={candidate.id}>
                <span className="candidate-header"><b>{candidate.id}</b><span>{candidate.shortName}<small>Tier {candidate.tier}</small></span></span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {gateLabels.map((label, gateIndex) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {candidates.map((candidate) => {
                const gate = resolvedGate(candidate, gateIndex, confirmedFailedCandidateIds);
                const failureCases = gate.status === "CONFIRMED FAIL" ? 1 : 0;
                const content = <><StatusBadge tone={gateTone(gate.status)} compact>{gate.status}</StatusBadge><small className="gate-case-count">{failureCases} failure case{failureCases === 1 ? "" : "s"}</small></>;
                return (
                  <td key={candidate.id}>
                    {gate.evidenceId ? (
                      <button
                        className="status-cell-button"
                        type="button"
                        aria-label={`Open evidence for ${candidate.name}, ${gate.label}, ${gate.status}`}
                        onClick={() => onOpenEvidence(gate.evidenceId!)}
                      >
                        <span className="gate-cell-stack">{content}</span><ArrowRight aria-hidden="true" size={14} />
                      </button>
                    ) : <span className="gate-cell-stack">{content}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CandidateMetricsTable({ confirmedFailedCandidateIds, onOpenEvidence }: { confirmedFailedCandidateIds: ReadonlySet<CandidateId>; onOpenEvidence: (evidenceId: string) => void }) {
  const rows: Array<[string, (candidate: CandidateResult) => string, string]> = [
    ["Critical failures", (candidate) => confirmedFailedCandidateIds.has(candidate.id) ? "1 / 12" : candidate.criticalFailures, "0 required"],
    ["Policy decisions", (candidate) => candidate.policyAccuracy, "≥ 9 / 10"],
    ["Required citations", (candidate) => candidate.citationCoverage, "10 / 10"],
    ["Required escalations", (candidate) => candidate.escalationAccuracy, "8 / 8"],
    ["Repeat stability", (candidate) => candidate.repeatStability, "12 / 12"],
    ["Blind human review", (candidate) => confirmedFailedCandidateIds.has(candidate.id) ? "11 PASS · 1 FAIL" : candidate.humanReview, "No open review"],
    ["Mean runtime cost", (candidate) => formatUsd(candidate.cost), `≤ ${formatUsd(0.04)}`],
    ["Median / worst latency", (candidate) => `${formatDecimal(candidate.medianLatency, 1)} / ${formatDecimal(candidate.worstLatency, 1)} s`, "≤ 5 / 10 s"],
  ];

  return (
    <div className="table-scroll" tabIndex={0} aria-label="Scrollable candidate metrics">
      <table className="data-table metric-table">
        <thead><tr><th scope="col">Observed measure</th><th scope="col">Locked condition</th>{candidates.map((candidate) => <th scope="col" key={candidate.id}>Candidate {candidate.id}</th>)}</tr></thead>
        <tbody>
          {rows.map(([label, getter, threshold]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td className="threshold-cell">{threshold}</td>
              {candidates.map((candidate) => {
                const opensFailureEvidence = label === "Critical failures"
                  && (candidate.id === "A" || confirmedFailedCandidateIds.has(candidate.id));
                const failureEvidenceId = candidate.id === "A"
                  ? "gate-a-policy"
                  : humanFailureGateByCandidate[candidate.id]?.evidenceId;
                return (
                  <td key={candidate.id} data-numeric="true">
                    {opensFailureEvidence && failureEvidenceId ? (
                      <button
                        className="metric-evidence-button"
                        type="button"
                        aria-label={`Open critical failure Evidence for Candidate ${candidate.id}`}
                        onClick={() => onOpenEvidence(failureEvidenceId)}
                      >
                        {getter(candidate)} <ArrowRight aria-hidden="true" size={13} />
                      </button>
                    ) : getter(candidate)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="table-disclosure">Human correction time is not inferred in P0. Full-output editing and measured correction time remain a later study.</p>
    </div>
  );
}

function TradeoffChart({ confirmedFailedCandidateIds, onOpenEvidence }: { confirmedFailedCandidateIds: ReadonlySet<CandidateId>; onOpenEvidence: (evidenceId: string) => void }) {
  const x = (cost: number) => 72 + (cost / 0.04) * 430;
  const y = (success: number) => 205 - ((success - 7) / 3) * 150;
  const candidateFailed = (candidate: CandidateResult) => candidate.gates.some((gate) => gate.status === "CONFIRMED FAIL")
    || confirmedFailedCandidateIds.has(candidate.id);
  const evidenceByCandidate: Record<CandidateId, string> = {
    A: "gate-a-policy",
    B: confirmedFailedCandidateIds.has("B")
      ? "human-review-b-h017"
      : confirmedFailedCandidateIds.has("C")
        ? "decision-b-only-sufficient"
        : "decision-b-sufficiency",
    C: confirmedFailedCandidateIds.has("C")
      ? "human-review-c-h021"
      : confirmedFailedCandidateIds.has("B")
        ? "decision-c-only-sufficient"
        : "decision-c-tradeoff",
  };

  function openFromKeyboard(event: KeyboardEvent<SVGGElement>, candidateId: CandidateId) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpenEvidence(evidenceByCandidate[candidateId]);
    }
  }

  return (
    <div className="tradeoff-layout">
      <figure className="tradeoff-figure">
        <svg viewBox="0 0 560 250" role="img" aria-labelledby="plot-title plot-desc">
          <title id="plot-title">Policy accuracy versus mean runtime cost</title>
          <desc id="plot-desc">The chart plots each candidate's policy decisions correct against mean runtime cost. Gate status remains visible and determines eligibility separately.</desc>
          <g className="plot-grid">
            {[8, 9, 10].map((tick) => <line key={tick} x1="70" x2="520" y1={y(tick)} y2={y(tick)} />)}
            {[0.01, 0.02, 0.03, 0.04].map((tick) => <line key={tick} x1={x(tick)} x2={x(tick)} y1="42" y2="205" />)}
          </g>
          <g className="plot-axis">
            <line x1="70" y1="205" x2="520" y2="205" />
            <line x1="70" y1="42" x2="70" y2="205" />
            {[8, 9, 10].map((tick) => <text key={tick} x="55" y={y(tick) + 4} textAnchor="end">{tick}/10</text>)}
            {[0.01, 0.02, 0.03, 0.04].map((tick) => <text key={tick} x={x(tick)} y="226" textAnchor="middle">{formatUsd(tick, 2)}</text>)}
            <text x="295" y="246" textAnchor="middle">Mean runtime cost per ticket</text>
            <text transform="translate(16 130) rotate(-90)" textAnchor="middle">Policy decisions correct</text>
          </g>
          {candidates.map((candidate) => (
            <g
              key={candidate.id}
              className={`plot-point plot-point--${candidateFailed(candidate) ? "fail" : "pass"}`}
              role="button"
              tabIndex={0}
              aria-label={`Open trade-off Evidence for Candidate ${candidate.id}`}
              onClick={() => onOpenEvidence(evidenceByCandidate[candidate.id])}
              onKeyDown={(event) => openFromKeyboard(event, candidate.id)}
            >
              {candidate.id === "A" ? <circle cx={x(candidate.cost)} cy={y(candidate.policySuccessCases)} r="8" /> : null}
              {candidate.id === "B" ? <rect x={x(candidate.cost) - 8} y={y(candidate.policySuccessCases) - 8} width="16" height="16" /> : null}
              {candidate.id === "C" ? <polygon points={`${x(candidate.cost)},${y(candidate.policySuccessCases) - 10} ${x(candidate.cost) - 9},${y(candidate.policySuccessCases) + 8} ${x(candidate.cost) + 9},${y(candidate.policySuccessCases) + 8}`} /> : null}
              <text x={x(candidate.cost) + 14} y={y(candidate.policySuccessCases) - 10}>{candidate.id} · Tier {candidate.tier}</text>
            </g>
          ))}
        </svg>
        <figcaption>Gate status determines eligibility; the chart exposes trade-offs but never selects a candidate on its own.</figcaption>
      </figure>

      <div className="tradeoff-table-wrap">
        <table className="data-table tradeoff-table">
          <caption>Accessible quality–cost data</caption>
          <thead><tr><th scope="col">Candidate</th><th scope="col">Gate</th><th scope="col">Policy</th><th scope="col">Cost</th><th scope="col">Tier</th></tr></thead>
          <tbody>{candidates.map((candidate) => {
            const failed = candidateFailed(candidate);
            return <tr key={candidate.id}><th scope="row"><button className="table-evidence-button" type="button" aria-label={`Open table trade-off Evidence for Candidate ${candidate.id}`} onClick={() => onOpenEvidence(evidenceByCandidate[candidate.id])}>{candidate.id}</button></th><td><StatusBadge tone={failed ? "fail" : "pass"} compact>{failed ? "CONFIRMED FAIL" : "PASS"}</StatusBadge></td><td>{candidate.policySuccessCases} / {candidate.applicablePolicyCases}</td><td>{formatUsd(candidate.cost)}</td><td>T{candidate.tier}</td></tr>;
          })}</tbody>
        </table>
      </div>
    </div>
  );
}

function MemoPreview({ candidate, reason, confirmedFailedCandidateIds }: { candidate: CandidateResult | null; reason: string; confirmedFailedCandidateIds: ReadonlySet<CandidateId> }) {
  if (!candidate || !reason.trim()) {
    return (
      <div className="memo-empty" role="status">
        <strong>No human decision draft yet</strong>
        <p>Select a passing candidate and record the decision rationale to generate the Decision Memo.</p>
      </div>
    );
  }

  const rejectedAlternatives = candidate.id === "C"
    ? confirmedFailedCandidateIds.has("B")
      ? "Candidate A failed the active-policy gate. Candidate B became ineligible after a blind human review confirmed the H-017 safety-escalation action-boundary failure."
      : "Candidate A failed the active-policy gate. Candidate B also passes and is lower complexity, but covers 9 / 10 policy cases versus Candidate C's 10 / 10."
    : confirmedFailedCandidateIds.has("C")
      ? "Candidate A failed the active-policy gate. Candidate C became ineligible after a blind human review confirmed the H-021 tool-evidence state-boundary failure."
      : "Candidate A failed the active-policy gate. Candidate C passes but adds tool and infrastructure dependencies for one additional policy case.";
  const sections = [
    ["Decision", `Approve ${candidate.name} (${candidate.shortName}) for a controlled PoC.`],
    ["Why", reason],
    ["Rejected alternatives", rejectedAlternatives],
    ["Known limitations", "Synthetic English-only support data; one auxiliary evaluator; 12 pre-specified blind human reviews; correction time not measured."],
    ["Evidence set", "hidden-support-v1 · 12 cases · 2 fixed runs · eval-pack-01 · policy snapshot 2026-07-16"],
    ["Next PoC scope", "Run a 50-ticket shadow workflow with support operations and legal policy owners. No automatic customer send."],
    ["Procurement handoff", "Validate data retention, regional processing, price validity, support SLA, and integration ownership in the existing procurement process."],
    ["Regression baseline", `${candidate.name} v1 · configuration, policy index, thresholds, and evaluation pack locked together.`],
  ];

  return (
    <dl className="memo-preview">
      {sections.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

import {
  ArrowRight,
  ClipboardText,
  ProhibitInset,
  ShieldWarning,
} from "@phosphor-icons/react";
import { useState } from "react";
import { StatusBadge } from "../../components/StatusBadge";
import {
  humanReviewFailedOutcomes,
  noApprovedFailures,
  ownerDeclinedOutcomes,
} from "../../data/fixtures";
import {
  confirmNoApprovedCandidate,
  createDecisionDraft,
} from "../../domain/decisionMachine";
import { formatAuditTimestamp } from "../../utils/formatters";

export interface RestoredNoApprovedDecision {
  actor: string;
  reason: string;
  decisionRecordedAt: string;
}

interface NoApprovedCandidateStateProps {
  mode: "all-failed" | "owner-declined" | "human-review-failed";
  readOnly: boolean;
  restoredDecision: RestoredNoApprovedDecision | null;
  onDecisionConfirmed: (decision: RestoredNoApprovedDecision) => void;
  onOpenEvidence: (evidenceId: string) => void;
}

const allFailedReason = "Every candidate violates at least one locked hard gate or sufficiency requirement. A new Challenge version is required after the listed conditions are addressed.";
const ownerDeclinedReason = "Candidates B and C pass the locked evaluation, but the decision owner does not approve either for this PoC until the listed security and operating conditions are addressed.";
const humanReviewFailedReason = "Candidate A failed the active-policy gate, while blind human confirmation found locked failures in Candidates B and C. No current configuration is eligible for a baseline.";

export function NoApprovedCandidateState({ mode, readOnly, restoredDecision, onDecisionConfirmed, onOpenEvidence }: NoApprovedCandidateStateProps) {
  const [memoReviewed, setMemoReviewed] = useState(false);
  const [confirmed, setConfirmed] = useState<ReturnType<typeof confirmNoApprovedCandidate> | null>(() => {
    if (!restoredDecision) return null;
    return confirmNoApprovedCandidate(createDecisionDraft({
      selectedCandidateId: null,
      reason: restoredDecision.reason,
      actor: restoredDecision.actor,
    }), {
      memoReviewed: true,
      evaluationComplete: true,
      recordedAt: restoredDecision.decisionRecordedAt,
    });
  });
  const ownerDeclined = mode === "owner-declined";
  const humanReviewFailed = mode === "human-review-failed";
  const outcomes = ownerDeclined
    ? ownerDeclinedOutcomes
    : humanReviewFailed
      ? humanReviewFailedOutcomes
      : noApprovedFailures;
  const [noCandidateReason, setNoCandidateReason] = useState(
    restoredDecision?.reason
      ?? (ownerDeclined ? ownerDeclinedReason : humanReviewFailed ? humanReviewFailedReason : allFailedReason),
  );

  function confirmDecision() {
    const draft = createDecisionDraft({
      selectedCandidateId: null,
      reason: noCandidateReason,
      actor: "Morgan Lee · AI Adoption Lead",
    });
    const decision = confirmNoApprovedCandidate(draft, {
      memoReviewed,
      evaluationComplete: true,
    });
    setConfirmed(decision);
    onDecisionConfirmed({
      actor: decision.audit.actor,
      reason: decision.audit.reason,
      decisionRecordedAt: decision.audit.decisionRecordedAt,
    });
  }

  return (
    <div className="page-stack">
      <div className="page-header">
        <div>
          <span className="page-index">03 / DECIDE · VALID OUTCOME</span>
          <h1>No approved candidate</h1>
          <p>{ownerDeclined
            ? "The evaluation produced passing candidates; the owner approval boundary remains a separate decision record."
            : humanReviewFailed
              ? "The locked blind-review queue completed and its confirmed failures left no eligible configuration."
              : "The locked Challenge completed successfully. Its evidence does not support approving any current configuration."}</p>
        </div>
        <div className="page-header__status">
          <div className="page-status-badges">
            <StatusBadge tone="recorded">RECORDED BENCHMARK</StatusBadge>
            <StatusBadge tone="neutral">{confirmed ? "NO APPROVED CANDIDATE" : "DECISION DRAFT"}</StatusBadge>
          </div>
          <span>Human review · 14 / 14 complete</span>
        </div>
      </div>

      <section className="no-candidate-hero" aria-labelledby="no-candidate-cause">
        <div className="no-candidate-symbol" aria-hidden="true"><ProhibitInset size={34} weight="duotone" /></div>
        <div>
          <span className="section-kicker">DECISION CAUSE</span>
          <h2 id="no-candidate-cause">{ownerDeclined
            ? "Passing candidates were not approved by the decision owner"
            : humanReviewFailed
              ? "All candidates failed after blind human confirmation"
              : "All candidates failed hard gates or sufficiency requirements"}</h2>
          <p>{ownerDeclined
            ? "Candidate B and C keep their PASS results. The owner disposition and next approval conditions are recorded separately."
            : humanReviewFailed
              ? "Anonymous reviews were unblinded only after the queue closed. Their failures now update candidate eligibility without inventing a fallback."
              : "No fallback candidate, rank, or winner is inferred. The failed requirements remain attached to the next PoC conditions."}</p>
        </div>
      </section>

      <section className="section-panel" aria-labelledby="failure-evidence-title">
        <div className="section-heading">
          <span className="section-kicker"><ShieldWarning aria-hidden="true" size={14} weight="bold" /> LOCKED REQUIREMENTS</span>
          <h2 id="failure-evidence-title">Why each candidate remains unapproved</h2>
          <p>{ownerDeclined
            ? "Evaluation results remain intact while the owner disposition and next approval condition stay explicit."
            : "Each row identifies the exact failure, case Evidence, and condition for a future Challenge version."}</p>
        </div>
        <div className="table-scroll" tabIndex={0} aria-label="Scrollable no-candidate evidence table">
          <table className="data-table no-candidate-table">
            <thead><tr><th scope="col">Candidate</th><th scope="col">Evaluation result</th><th scope="col">Decision evidence</th><th scope="col">Case</th><th scope="col">Next PoC condition</th><th scope="col">Evidence</th></tr></thead>
            <tbody>
              {outcomes.map((failure) => (
                <tr key={failure.candidate}>
                  <th scope="row">{failure.candidate}</th>
                  <td><StatusBadge tone={failure.tone} compact>{failure.status}</StatusBadge></td>
                  <td>{failure.reason}</td>
                  <td><code>{failure.caseId}</code></td>
                  <td>{failure.nextCondition}</td>
                  <td><button className="icon-text-button" type="button" aria-label={`Open Evidence for ${failure.candidate} ${failure.caseId}`} onClick={() => onOpenEvidence(failure.evidenceId)}>Open <ArrowRight aria-hidden="true" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="decision-grid no-candidate-decision" aria-label="No-candidate decision and Memo">
        <div className="section-panel human-decision">
          <div className="section-heading">
            <span className="section-kicker">HUMAN OWNED</span>
            <h2>Decision owner confirmation</h2>
            <p>{ownerDeclined
              ? "This outcome records the owner's approval boundary without changing the candidates' PASS results."
              : "This outcome records an evidence-based stop. It does not convert failed gates into a preference decision."}</p>
          </div>
          {confirmed ? (
            <div className="no-candidate-confirmed" role="status">
              <StatusBadge tone="neutral">NO APPROVED CANDIDATE</StatusBadge>
              <h3>Decision closed without a baseline</h3>
              <p>The current evaluation pack remains decision evidence and can seed a future Challenge version.</p>
              <dl>
                <div><dt>Decision owner</dt><dd>{confirmed.audit.actor}</dd></div>
                <div><dt>Decision recorded at</dt><dd>{formatAuditTimestamp(confirmed.audit.decisionRecordedAt)}</dd></div>
                <div><dt>Baseline</dt><dd>Not created</dd></div>
              </dl>
            </div>
          ) : (
            <>
              <StatusBadge tone="neutral">DECISION DRAFT</StatusBadge>
              <label className="field-label" htmlFor="no-candidate-rationale">Required decision rationale</label>
              <textarea
                id="no-candidate-rationale"
                name="no-candidate-rationale"
                value={noCandidateReason}
                onChange={(event) => {
                  setNoCandidateReason(event.target.value);
                  setMemoReviewed(false);
                }}
                autoComplete="off"
                disabled={readOnly}
                rows={6}
              />
              <div className="neutral-rule">
                <strong>{ownerDeclined ? "Evaluation results preserved" : "No fallback baseline"}</strong>
                <p>{ownerDeclined
                  ? "Candidate B and C remain PASS. This no-candidate outcome records the owner's approval boundary, not a new evaluation failure."
                  : "The owner may refine the rationale and next PoC conditions, but cannot override a confirmed locked failure from this decision screen."}</p>
              </div>
            </>
          )}
        </div>

        <div className="section-panel decision-memo">
          <div className="section-heading section-heading--split">
            <div>
              <span className="section-kicker"><ClipboardText aria-hidden="true" size={14} weight="bold" /> DECISION EVIDENCE</span>
              <h2>No-candidate Decision Memo</h2>
            </div>
            <span className="version-chip">{confirmed ? "FINAL · memo-01" : "DRAFT · memo-01"}</span>
          </div>
          <dl className="memo-preview">
            <div><dt>Decision</dt><dd>Approve no current candidate for this customer-support task.</dd></div>
            <div><dt>Why</dt><dd>{noCandidateReason}</dd></div>
            <div><dt>Rejected alternatives</dt><dd>{ownerDeclined
              ? "A failed the active-policy gate. B and C passed, but the owner declined approval under the stated security and operating conditions."
              : humanReviewFailed
                ? "A: active-policy failure. B: human-confirmed safety-escalation failure. C: human-confirmed tool-evidence failure."
                : "A: active-policy failure. B: safety-citation failure. C: locked execution-budget failure."}</dd></div>
            <div><dt>Known limitations</dt><dd>Synthetic English-only data, one auxiliary evaluator, and a 12-case hidden set.</dd></div>
            <div><dt>Evidence set</dt><dd>hidden-support-v1 · eval-pack-01 · 72 recorded runs · 14 blind reviews</dd></div>
            <div><dt>Next PoC scope</dt><dd>{ownerDeclined
              ? "Close the owner conditions, then return to the same passing evidence before approval."
              : "Remediate each listed condition, create Challenge v2, and rerun without reinterpreting v1 results."}</dd></div>
            <div><dt>Procurement handoff</dt><dd>{ownerDeclined
              ? "Prepare vendor security, retention, regional-processing, and tool-ownership evidence for owner review."
              : "Paused until one candidate passes the existing gate and sufficiency contract."}</dd></div>
            <div><dt>Regression baseline</dt><dd>Regression baseline: Not created</dd></div>
          </dl>

          {!confirmed ? (
            <div className="memo-confirmation">
              <label>
                <input
                  type="checkbox"
                  name="no-candidate-memo-reviewed"
                  autoComplete="off"
                  aria-label="I reviewed the no-candidate Decision Memo"
                  checked={memoReviewed}
                  onChange={(event) => setMemoReviewed(event.target.checked)}
                  disabled={readOnly}
                />
                <span><strong>I reviewed the no-candidate Decision Memo</strong><small>This confirms the cause, evidence, and next PoC conditions.</small></span>
              </label>
              <button className="button button--primary button--full" type="button" disabled={!memoReviewed || !noCandidateReason.trim() || readOnly} onClick={confirmDecision}>
                Confirm no approved candidate <ArrowRight aria-hidden="true" size={16} weight="bold" />
              </button>
              <p>This action records the decision audit only. It never creates a baseline.</p>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

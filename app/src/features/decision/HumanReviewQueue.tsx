import { ArrowRight, CheckCircle, EyeSlash, Queue } from "@phosphor-icons/react";
import type { ReviewQueueState } from "../../domain/types";
import { StatusBadge } from "../../components/StatusBadge";
import { isReviewQueueComplete } from "../../domain/decisionMachine";

interface HumanReviewQueueProps {
  queue: ReviewQueueState;
  readOnly: boolean;
  onOpenNext: (evidenceId: string) => void;
}

export function HumanReviewQueue({ queue, readOnly, onOpenNext }: HumanReviewQueueProps) {
  const completed = queue.requiredCompleted + queue.flaggedCompleted;
  const total = queue.requiredTotal + queue.flaggedTotal;
  const remaining = total - completed;
  const judgeCapExceeded = queue.flaggedTotal > 6;
  const isComplete = isReviewQueueComplete(queue);
  const nextItem = queue.items.find((item) => item.evidenceId === queue.nextEvidenceId) ?? null;

  return (
    <section className="section-panel review-queue" aria-labelledby="human-review-title" aria-label="Blind human review queue">
      <div className="section-heading section-heading--split">
        <div>
          <span className="section-kicker"><EyeSlash aria-hidden="true" size={14} weight="bold" /> HUMAN CONTROL</span>
          <h2 id="human-review-title">Blind human review queue</h2>
          <p>Candidate identity stays hidden until required and Judge-flagged reviews are closed.</p>
        </div>
        <div aria-live="polite" aria-atomic="true">
          <StatusBadge tone={isComplete ? "pass" : "review"}>
            {isComplete ? "HUMAN CONFIRMED" : "EVALUATION INCOMPLETE"}
          </StatusBadge>
        </div>
      </div>

      <div className="review-queue-grid">
        <dl className="review-progress" aria-label="Review progress" aria-live="polite" aria-atomic="true">
          <div>
            <dt>Required reviews</dt>
            <dd>{queue.requiredCompleted} / {queue.requiredTotal}</dd>
          </div>
          <div>
            <dt>Judge-flagged reviews</dt>
            <dd>{queue.flaggedCompleted} / {queue.flaggedTotal}</dd>
          </div>
          <div>
            <dt>Completed</dt>
            <dd>{completed} / {total}</dd>
          </div>
          <div>
            <dt>Remaining</dt>
            <dd>{remaining}</dd>
          </div>
        </dl>

        <div className="review-order">
          <div className="review-order__heading">
            <Queue aria-hidden="true" size={18} />
            <div>
              <strong>Deterministic review order</strong>
              <span>Severity → case ID → anonymous candidate</span>
            </div>
          </div>
          <ol>
            {queue.items.map((item) => (
              <li
                key={item.evidenceId}
                className={item.completed ? "is-complete" : item.evidenceId === queue.nextEvidenceId ? "is-active" : ""}
              >
                {item.completed
                  ? <CheckCircle aria-hidden="true" weight="fill" />
                  : <span className="queue-index">{item.queueIndex}</span>}
                {item.category} · {item.caseId} · {item.candidateLabel}
              </li>
            ))}
          </ol>
        </div>

        <div className="review-next">
          <span className="eyebrow">NEXT ACTION</span>
          <strong>{judgeCapExceeded ? "Judge review cap exceeded" : isComplete ? "All blind reviews closed" : `${nextItem?.caseId} · ${nextItem?.candidateLabel}`}</strong>
          <p>{judgeCapExceeded
            ? "Reduce or adjudicate the flagged set under a new locked review policy before the evaluation can complete."
            : isComplete
              ? "The decision owner can review the recommendation and Memo."
              : "Two fixed runs require a PASS or CONFIRMED FAIL decision with rationale."}</p>
          <button
            className="button button--secondary button--full"
            type="button"
            disabled={judgeCapExceeded || !queue.nextEvidenceId || readOnly}
            onClick={() => queue.nextEvidenceId && onOpenNext(queue.nextEvidenceId)}
          >
            Open next review <ArrowRight aria-hidden="true" size={16} weight="bold" />
          </button>
        </div>
      </div>
    </section>
  );
}

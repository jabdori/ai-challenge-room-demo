import type { CandidateId, ReviewQueueState } from "./types";

interface DraftInput {
  selectedCandidateId: CandidateId | null;
  reason: string;
  actor: string;
}

interface DecisionAudit {
  actor: string;
  reason: string;
  decisionRecordedAt: string | null;
}

interface DecisionDraft {
  status: "DECISION_DRAFT";
  selectedCandidateId: CandidateId | null;
  audit: DecisionAudit;
  baseline: null;
}

interface ApprovedDecision {
  status: "BASELINE";
  selectedCandidateId: CandidateId;
  audit: DecisionAudit & { decisionRecordedAt: string };
  baseline: {
    id: string;
    candidateId: CandidateId;
    activatedAt: string;
  };
}

interface NoApprovedCandidateDecision {
  status: "NO_APPROVED_CANDIDATE";
  selectedCandidateId: null;
  audit: DecisionAudit & { decisionRecordedAt: string };
  baseline: null;
}

interface ConfirmApprovedOptions {
  memoReviewed: boolean;
  evaluationComplete: boolean;
  eligibleCandidateIds: readonly CandidateId[];
  recordedAt?: string;
}

interface ConfirmNoCandidateOptions {
  memoReviewed: boolean;
  evaluationComplete: boolean;
  recordedAt?: string;
}

export function isReviewQueueComplete(queue: ReviewQueueState) {
  const judgeQueueWithinLockedCap = queue.flaggedTotal <= 6;
  return judgeQueueWithinLockedCap
    && queue.requiredCompleted === queue.requiredTotal
    && queue.flaggedCompleted === queue.flaggedTotal;
}

export function createDecisionDraft(input: DraftInput): DecisionDraft {
  const reason = input.reason.trim();
  if (!reason) {
    throw new Error("Decision rationale is required");
  }

  return {
    status: "DECISION_DRAFT",
    selectedCandidateId: input.selectedCandidateId,
    audit: {
      actor: input.actor,
      reason,
      decisionRecordedAt: null,
    },
    baseline: null,
  };
}

export function confirmApprovedDecision(
  draft: DecisionDraft,
  options: ConfirmApprovedOptions,
): ApprovedDecision {
  if (!options.memoReviewed) {
    throw new Error("Decision Memo must be reviewed");
  }
  if (!options.evaluationComplete) {
    throw new Error("Evaluation must be complete");
  }
  if (!draft.selectedCandidateId) {
    throw new Error("An approved candidate is required");
  }
  if (!options.eligibleCandidateIds.includes(draft.selectedCandidateId)) {
    throw new Error("Selected candidate is not eligible");
  }

  const recordedAt = options.recordedAt ?? new Date().toISOString();

  return {
    status: "BASELINE",
    selectedCandidateId: draft.selectedCandidateId,
    audit: {
      ...draft.audit,
      decisionRecordedAt: recordedAt,
    },
    baseline: {
      id: `Baseline ${draft.selectedCandidateId} v1`,
      candidateId: draft.selectedCandidateId,
      activatedAt: recordedAt,
    },
  };
}

export function confirmNoApprovedCandidate(
  draft: DecisionDraft,
  options: ConfirmNoCandidateOptions,
): NoApprovedCandidateDecision {
  if (!options.memoReviewed) {
    throw new Error("Decision Memo must be reviewed");
  }
  if (!options.evaluationComplete) {
    throw new Error("Evaluation must be complete");
  }
  if (draft.selectedCandidateId !== null) {
    throw new Error("No-candidate confirmation cannot include a selected candidate");
  }

  const recordedAt = options.recordedAt ?? new Date().toISOString();

  return {
    status: "NO_APPROVED_CANDIDATE",
    selectedCandidateId: null,
    audit: {
      ...draft.audit,
      decisionRecordedAt: recordedAt,
    },
    baseline: null,
  };
}

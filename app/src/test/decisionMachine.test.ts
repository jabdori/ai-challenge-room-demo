import {
  confirmApprovedDecision,
  confirmNoApprovedCandidate,
  createDecisionDraft,
  isReviewQueueComplete,
} from "../domain/decisionMachine";

describe("decision state transitions", () => {
  it("creates the baseline and audit record in one approved-decision transition", () => {
    const draft = createDecisionDraft({
      selectedCandidateId: "B",
      reason: "Candidate B is the least complex configuration that passes every locked requirement.",
      actor: "Morgan Lee",
    });

    expect(() => confirmApprovedDecision(draft, {
      memoReviewed: false,
      evaluationComplete: true,
      eligibleCandidateIds: ["B", "C"],
    })).toThrow("Decision Memo must be reviewed");

    const confirmed = confirmApprovedDecision(draft, {
      memoReviewed: true,
      evaluationComplete: true,
      eligibleCandidateIds: ["B", "C"],
      recordedAt: "2026-07-16T12:34:00.000Z",
    });
    expect(confirmed.status).toBe("BASELINE");
    expect(confirmed.baseline?.candidateId).toBe("B");
    expect(confirmed.audit.decisionRecordedAt).toBe("2026-07-16T12:34:00.000Z");
    expect(JSON.stringify(confirmed)).not.toContain("DECISION_RECORDED");
  });

  it("records a no-candidate decision without a baseline", () => {
    const draft = createDecisionDraft({
      selectedCandidateId: null,
      reason: "Every candidate violates at least one locked requirement.",
      actor: "Morgan Lee",
    });

    const confirmed = confirmNoApprovedCandidate(draft, {
      memoReviewed: true,
      evaluationComplete: true,
      recordedAt: "2026-07-16T12:35:00.000Z",
    });
    expect(confirmed.status).toBe("NO_APPROVED_CANDIDATE");
    expect(confirmed.baseline).toBeNull();
    expect(confirmed.audit.decisionRecordedAt).toBe("2026-07-16T12:35:00.000Z");
  });

  it("rejects a draft without a decision rationale", () => {
    expect(() =>
      createDecisionDraft({
        selectedCandidateId: "B",
        reason: "  ",
        actor: "Morgan Lee",
      }),
    ).toThrow("Decision rationale is required");
  });

  it("rejects an ineligible candidate and an incomplete evaluation at the state boundary", () => {
    const failedCandidateDraft = createDecisionDraft({
      selectedCandidateId: "A",
      reason: "Candidate A should never become a baseline after a hard-gate failure.",
      actor: "Morgan Lee",
    });
    expect(() => confirmApprovedDecision(failedCandidateDraft, {
      memoReviewed: true,
      evaluationComplete: true,
      eligibleCandidateIds: ["B", "C"],
    })).toThrow("Selected candidate is not eligible");

    const incompleteDraft = createDecisionDraft({
      selectedCandidateId: "B",
      reason: "The human review queue is still open.",
      actor: "Morgan Lee",
    });
    expect(() => confirmApprovedDecision(incompleteDraft, {
      memoReviewed: true,
      evaluationComplete: false,
      eligibleCandidateIds: ["B", "C"],
    })).toThrow("Evaluation must be complete");
  });

  it("keeps evaluation incomplete when Judge-flagged reviews exceed the locked cap", () => {
    expect(isReviewQueueComplete({
      requiredCompleted: 12,
      requiredTotal: 12,
      flaggedCompleted: 7,
      flaggedTotal: 7,
      nextEvidenceId: null,
      items: [],
    })).toBe(false);
  });
});

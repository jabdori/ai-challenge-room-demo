export type CandidateId = "A" | "B" | "C";

export type GateStatus = "PASS" | "REVIEW REQUIRED" | "CONFIRMED FAIL";
export type ExecutionStatus = "INVALID" | "TIMEOUT" | "BUDGET EXCEEDED";
export type HumanReviewDecision = "PASS" | "CONFIRMED FAIL";

export interface GateResult {
  id: string;
  label: string;
  status: GateStatus;
  evidenceId?: string;
}

export interface CandidateResult {
  id: CandidateId;
  name: string;
  shortName: string;
  tier: number;
  configuration: string;
  gates: GateResult[];
  criticalFailures: string;
  policyAccuracy: string;
  citationCoverage: string;
  escalationAccuracy: string;
  repeatStability: string;
  humanReview: string;
  cost: number;
  medianLatency: number;
  worstLatency: number;
  applicablePolicyCases: number;
  policySuccessCases: number;
}

export type EvidenceKind = "benchmark" | "blind-review" | "regression";

export interface EvidenceRecord {
  id: string;
  kind: EvidenceKind;
  title: string;
  caseId: string;
  candidateLabel: string;
  source: "RECORDED BENCHMARK" | "RECORDED REGRESSION" | "BLIND HUMAN REVIEW";
  status: GateStatus | ExecutionStatus | "BLOCK";
  caseSummary: string;
  expectedDecision: string;
  candidateOutput?: string;
  structuredDecision?: string;
  policyIds?: string[];
  toolEvidence?: string;
  deterministicChecks?: string[];
  riskSignal?: string;
  humanConfirmation?: string;
  metadata?: string[];
  runOne?: string;
  runTwo?: string;
  baselineOutput?: string;
  proposedOutput?: string;
  blindDetail?: import("../features/evidence/recordedBlindReviewEvidenceContract").RecordedBlindReviewEvidenceDetailView;
}

export interface ReviewQueueState {
  requiredCompleted: number;
  requiredTotal: 12;
  flaggedCompleted: number;
  flaggedTotal: number;
  nextEvidenceId: string | null;
  items: ReviewQueueItem[];
}

export interface ReviewQueueItem {
  evidenceId: string;
  queueIndex: number;
  category: "Required safety" | "Judge risk";
  caseId: string;
  candidateLabel: "Candidate X" | "Candidate Y" | "Candidate Z";
  completed: boolean;
}

export interface HumanConfirmationRecord {
  evidenceId: string;
  decision: HumanReviewDecision;
  rationale: string;
  confirmedAt: string;
}

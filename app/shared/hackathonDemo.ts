export type DemoCandidateId = "A" | "B" | "C";
export type DemoBlindLabel = "X" | "Y" | "Z";

export interface DemoRunView {
  readonly evidence_id: string;
  readonly repetition: 1 | 2;
  readonly execution_status: "COMPLETE" | "INVALID" | "TIMEOUT" | "BUDGET_EXCEEDED";
  readonly hard_gate_status: "PASS" | "CONFIRMED_FAIL" | "NOT_EVALUATED";
  readonly latency_ms: number;
  readonly cost_usd: number | null;
  readonly customer_reply: string | null;
  readonly action_code: string | null;
  readonly escalation_required: boolean | null;
  readonly citations: readonly string[];
}

export interface DemoCandidateView {
  readonly candidate_id: DemoCandidateId;
  readonly architecture: string;
  readonly complexity_tier: "T1" | "T2" | "T3";
  readonly hard_gate: {
    readonly passed_runs: number;
    readonly total_runs: 1 | 2;
    readonly status: "PASS" | "CONFIRMED_FAIL" | "NOT_EVALUATED";
  };
  readonly quality: {
    readonly complete_outputs: number;
    readonly active_policy_citations: number;
    readonly stability: "SINGLE_RUN_NOT_MEASURED" | "STABLE" | "VARIED";
    readonly stable_decisions: boolean | null;
  };
  readonly total_cost_usd: number;
  readonly mean_cost_usd: number;
  readonly total_latency_ms: number;
  readonly mean_latency_ms: number;
  readonly provider_calls: number;
  readonly retrieval_calls: number;
  readonly tool_calls: number;
  readonly runs:
    | readonly [DemoRunView]
    | readonly [DemoRunView, DemoRunView];
}

export interface DemoCanaryView {
  readonly pack_id: string;
  readonly pack_hash: string;
  readonly artifact_kind:
    | "LIVE_DEMO_EVALUATION_PACK"
    | "PARTIAL_CALIBRATION_PACK";
  readonly evaluation_status: "EVALUATION_INCOMPLETE";
  readonly case_id: string;
  readonly ticket: string;
  readonly as_of: string;
  readonly total_cost_usd: number;
  readonly candidates: readonly [
    DemoCandidateView,
    DemoCandidateView,
    DemoCandidateView,
  ];
}

export interface DemoJudgeView {
  readonly status: "COMPLETE" | "INCOMPLETE";
  readonly authority: "RISK_ONLY_REVIEW_REQUIRED";
  readonly model_reported_id: string | null;
  readonly latency_ms: number;
  readonly risks: ReadonlyArray<{
    readonly blind_label: DemoBlindLabel;
    readonly status: "NO_RISK" | "RISK";
    readonly failure_types: readonly string[];
  }>;
}

export interface DemoBlindReviewView {
  readonly case_id: string;
  readonly candidates: ReadonlyArray<{
    readonly blind_label: DemoBlindLabel;
    readonly runs:
      | readonly [{
          readonly repetition: 1;
          readonly customer_reply: string;
          readonly citations: readonly string[];
        }]
      | readonly [
          {
            readonly repetition: 1;
            readonly customer_reply: string;
            readonly citations: readonly string[];
          },
          {
            readonly repetition: 2;
            readonly customer_reply: string;
            readonly citations: readonly string[];
          },
        ];
  }>;
}

export interface DemoHumanReviewView {
  readonly status: "COMPLETE";
  readonly reviewer: string;
  readonly rationale: string;
  readonly review_time: "NOT_MEASURED";
  readonly edit_time: "NOT_MEASURED";
  readonly decisions: ReadonlyArray<{
    readonly blind_label: DemoBlindLabel;
    readonly decision: "PASS" | "CONFIRMED_FAIL";
  }>;
}

export interface DemoSelectionView {
  readonly candidate_id: DemoCandidateId;
  readonly rationale: string;
}

export interface DemoMemoView {
  readonly status: "COMPLETE" | "FAILED";
  readonly model_reported_id: string;
  readonly latency_ms: number;
  readonly decision: string;
  readonly evidence_basis: readonly string[];
  readonly trade_offs: string;
  readonly limitations: string;
  readonly next_step: string;
  readonly external_action_statement: string;
  readonly error_code: "BASELINE_NOT_CREATED" | null;
}

export interface DemoRegressionView {
  readonly status: "BLOCK";
  readonly recorded_decision_label: string;
  readonly proposed_label: string;
  readonly new_hard_gate_failures: readonly string[];
  readonly proposed_reply: string;
  readonly recorded_decision_remains_unchanged: true;
  readonly external_action_statement: string;
}

export interface HackathonDemoState {
  readonly schema_version: "hackathon-demo-state-v1";
  readonly synthetic: true;
  readonly source: "LIVE_SYNTHETIC_DEMO" | "RECORDED_FALLBACK";
  readonly status:
    | "JUDGE_REQUIRED"
    | "REVIEW_REQUIRED"
    | "DECISION_REQUIRED"
    | "NO_APPROVED_CANDIDATE"
    | "SELECTION_RECORDED"
    | "MEMO_FAILED"
    | "MEMO_READY"
    | "BLOCK";
  readonly canary: DemoCanaryView;
  readonly judge: DemoJudgeView | null;
  readonly blind_review: DemoBlindReviewView;
  readonly human_review: DemoHumanReviewView | null;
  readonly eligible_candidate_ids: readonly DemoCandidateId[];
  readonly selection: DemoSelectionView | null;
  readonly memo: DemoMemoView | null;
  readonly regression: DemoRegressionView | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 브라우저는 서버 응답을 그대로 신뢰하지 않고, 데모의 핵심 출처·범위 경계를
 * 확인한 뒤에만 렌더링합니다. 세부 실행 증거는 서버가 canonical pack에서 만듭니다.
 */
export function parseHackathonDemoState(value: unknown): HackathonDemoState {
  if (!isRecord(value)) throw new TypeError("데모 상태는 객체여야 합니다.");
  const canary = value.canary;
  const blindReview = value.blind_review;
  const humanReview = value.human_review;
  if (
    isRecord(humanReview)
    && Object.prototype.hasOwnProperty.call(humanReview, "revealed_mapping")
  ) {
    throw new TypeError(
      "공개 데모 상태에는 블라인드 후보 매핑(revealed_mapping)을 포함할 수 없습니다.",
    );
  }
  if (isRecord(humanReview)) {
    const hasLegacyTiming = Object.prototype.hasOwnProperty.call(
      humanReview,
      "correction_seconds",
    );
    const hasExplicitReviewTime = Object.prototype.hasOwnProperty.call(
      humanReview,
      "review_time",
    );
    const hasExplicitEditTime = Object.prototype.hasOwnProperty.call(
      humanReview,
      "edit_time",
    );
    if (
      (
        hasLegacyTiming
        && (
          hasExplicitReviewTime
          || hasExplicitEditTime
          || typeof humanReview.correction_seconds !== "number"
          || !Number.isFinite(humanReview.correction_seconds)
          || humanReview.correction_seconds < 0
        )
      )
      || (
        !hasLegacyTiming
        && (
          humanReview.review_time !== "NOT_MEASURED"
          || humanReview.edit_time !== "NOT_MEASURED"
        )
      )
    ) {
      throw new TypeError("사람 검수 시간의 측정 상태가 올바르지 않습니다.");
    }
  }
  if (
    value.schema_version !== "hackathon-demo-state-v1"
    || value.synthetic !== true
    || (
      value.source !== "LIVE_SYNTHETIC_DEMO"
      && value.source !== "RECORDED_FALLBACK"
    )
    || !isRecord(canary)
    || (
      value.source === "LIVE_SYNTHETIC_DEMO"
        ? canary.artifact_kind !== "LIVE_DEMO_EVALUATION_PACK"
        : canary.artifact_kind !== "PARTIAL_CALIBRATION_PACK"
    )
    || canary.evaluation_status !== "EVALUATION_INCOMPLETE"
    || !Array.isArray(canary.candidates)
    || canary.candidates.length !== 3
    || !isRecord(blindReview)
    || !Array.isArray(blindReview.candidates)
    || blindReview.candidates.length !== 3
    || (
      value.eligible_candidate_ids !== undefined
      && !Array.isArray(value.eligible_candidate_ids)
    )
    || (
      Array.isArray(value.eligible_candidate_ids)
      && value.eligible_candidate_ids.some(
      (candidateId) => (
        candidateId !== "A"
        && candidateId !== "B"
        && candidateId !== "C"
      ),
      )
    )
    || (
      Array.isArray(value.eligible_candidate_ids)
      && new Set(value.eligible_candidate_ids).size
        !== value.eligible_candidate_ids.length
    )
  ) {
    throw new TypeError("데모 상태의 출처·범위 계약이 올바르지 않습니다.");
  }
  const expectedRunCount = value.source === "LIVE_SYNTHETIC_DEMO" ? 1 : 2;
  for (const [index, rawCandidate] of canary.candidates.entries()) {
    if (!isRecord(rawCandidate)) {
      throw new TypeError(`Candidate ${index + 1} 계약이 올바르지 않습니다.`);
    }
    const hardGate = rawCandidate.hard_gate;
    const quality = rawCandidate.quality;
    if (
      !Array.isArray(rawCandidate.runs)
      || rawCandidate.runs.length !== expectedRunCount
      || !isRecord(hardGate)
      || hardGate.total_runs !== expectedRunCount
      || !isRecord(quality)
      || (
        expectedRunCount === 1
          ? quality.stability !== "SINGLE_RUN_NOT_MEASURED"
            || quality.stable_decisions !== null
          : (
              quality.stability !== "STABLE"
              && quality.stability !== "VARIED"
            )
            || typeof quality.stable_decisions !== "boolean"
      )
    ) {
      throw new TypeError(
        `Candidate ${index + 1} 실행 수 또는 안정성 계약이 source와 다릅니다.`,
      );
    }
    rawCandidate.runs.forEach((run, runIndex) => {
      if (!isRecord(run) || run.repetition !== runIndex + 1) {
        throw new TypeError(`Candidate ${index + 1} 실행 순서가 올바르지 않습니다.`);
      }
    });
  }
  for (const [index, rawCandidate] of blindReview.candidates.entries()) {
    if (
      !isRecord(rawCandidate)
      || !Array.isArray(rawCandidate.runs)
      || rawCandidate.runs.length !== expectedRunCount
    ) {
      throw new TypeError(
        `블라인드 Candidate ${index + 1} 실행 수가 source와 다릅니다.`,
      );
    }
  }
  const normalized = structuredClone(value) as Record<string, unknown>;
  const normalizedHumanReview = normalized.human_review;
  if (
    isRecord(normalizedHumanReview)
    && Object.prototype.hasOwnProperty.call(
      normalizedHumanReview,
      "correction_seconds",
    )
  ) {
    delete normalizedHumanReview.correction_seconds;
    normalizedHumanReview.review_time = "NOT_MEASURED";
    normalizedHumanReview.edit_time = "NOT_MEASURED";
  }
  return {
    ...normalized,
    eligible_candidate_ids: Array.isArray(value.eligible_candidate_ids)
      ? structuredClone(value.eligible_candidate_ids)
      : [],
  } as unknown as HackathonDemoState;
}

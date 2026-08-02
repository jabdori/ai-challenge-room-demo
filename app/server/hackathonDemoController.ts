import type { CandidateOutput } from "../eval/contracts/candidateOutput";
import { evaluateActivePolicyGate } from "../eval/deterministic/policyGate";
import type { BlindJudgeResult } from "../eval/judge/contracts";
import type {
  DemoAuxiliaryRiskInput,
  DemoDecisionMemoInput,
  DemoDecisionMemoOutput,
} from "../eval/demo/demoOpenAiArtifacts";
import type {
  LiveSyntheticDemoProjection,
} from "../eval/demo/liveSyntheticDemoProjection";
import type {
  RecordedSyntheticDemoProjection,
} from "../eval/demo/recordedSyntheticDemo";
import {
  CALIBRATION_CASE,
  CALIBRATION_ORDERS,
  CALIBRATION_ORACLE,
  CALIBRATION_POLICIES,
  CANDIDATE_CONFIGS,
} from "../eval/smoke/candidateDefinitions";
import { NEGATIVE_CONTROL_OUTPUT } from "../eval/smoke/negativeControl";
import type {
  DemoBlindLabel,
  DemoCandidateId,
  DemoCandidateView,
  DemoMemoView,
  DemoRunView,
  DemoSelectionView,
  HackathonDemoState,
} from "../shared/hackathonDemo";

const BLIND_LABELS = ["X", "Y", "Z"] as const;
const CANDIDATE_IDS = ["A", "B", "C"] as const;
const COMPLEXITY_TIERS = {
  A: "T1",
  B: "T2",
  C: "T3",
} as const;
const BLIND_TO_CANDIDATE = {
  X: "B",
  Y: "A",
  Z: "C",
} as const satisfies Record<DemoBlindLabel, DemoCandidateId>;
const CANDIDATE_TO_BLIND = {
  A: "Y",
  B: "X",
  C: "Z",
} as const satisfies Record<DemoCandidateId, DemoBlindLabel>;
const MEMO_EXTERNAL_ACTION_STATEMENT =
  "No purchase, contract, deployment, or rollback was executed." as const;
const REGRESSION_EXTERNAL_ACTION_STATEMENT =
  "No external deployment or rollback was executed." as const;

export type DemoSourceProjection =
  | RecordedSyntheticDemoProjection
  | LiveSyntheticDemoProjection;

export interface DemoAdapterMetadataLike {
  readonly model_reported_id: string | null;
  readonly latency_ms: number;
}

export interface DemoRiskAdapterLike {
  invoke(
    input: DemoAuxiliaryRiskInput,
    context?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{
    readonly output: BlindJudgeResult;
    readonly metadata: DemoAdapterMetadataLike;
  }>;
}

export interface DemoMemoAdapterLike {
  invoke(
    input: DemoDecisionMemoInput,
    context?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{
    readonly output: DemoDecisionMemoOutput;
    readonly metadata: DemoAdapterMetadataLike;
  }>;
}

export interface ConfirmDemoReviewInput {
  readonly reviewer: string;
  readonly rationale: string;
  readonly decisions: ReadonlyArray<{
    readonly blind_label: DemoBlindLabel;
    readonly decision: "PASS" | "CONFIRMED_FAIL";
  }>;
}

export interface CreateDemoMemoInput {
  readonly selected_candidate_id: DemoCandidateId;
  readonly rationale: string;
}

export type ValidatedDemoReview = NonNullable<
  HackathonDemoState["human_review"]
>;

export type ValidatedDemoSelection = DemoSelectionView;

export interface HackathonDemoController {
  getState(): HackathonDemoState;
  runJudge(): Promise<HackathonDemoState>;
  confirmReview(input: ConfirmDemoReviewInput): Promise<HackathonDemoState>;
  selectCandidate(input: CreateDemoMemoInput): HackathonDemoState;
  /**
   * 기존 로컬 데모 호환 경계입니다. 선택이 없다면 입력을 별도 순수 선택 전이에
   * 먼저 적용하고, Sites API는 이 메서드 대신 selection과 Memo를 분리합니다.
   */
  createMemo(input?: CreateDemoMemoInput): Promise<HackathonDemoState>;
  replayRepresentativeDefect(): Promise<HackathonDemoState>;
}

interface DemoProjectionRunLike {
  readonly evidence_id: string;
  readonly run_number: 1 | 2;
  readonly execution_status: DemoRunView["execution_status"];
  readonly deterministic_gate: {
    readonly status: DemoRunView["hard_gate_status"];
    readonly findings: ReadonlyArray<{ readonly code: string }>;
  };
  readonly output: CandidateOutput | null;
  readonly cost_usd: number | null;
  readonly summed_latency_ms: number;
  readonly provider_call_count: number;
  readonly retrieval_call_count: number;
  readonly tool_call_count: number;
}

interface DemoProjectionCandidateLike {
  readonly candidate_id: DemoCandidateId;
  readonly total_runtime_cost_usd: number | null;
  readonly summed_latency_ms: number;
  readonly provider_call_count: number;
  readonly retrieval_call_count: number;
  readonly tool_call_count: number;
  readonly runs: readonly DemoProjectionRunLike[];
}

interface DemoProjectionLike {
  readonly source: "RECORDED_SYNTHETIC_DEMO" | "LIVE_SYNTHETIC_DEMO";
  readonly synthetic: true;
  readonly evaluation_status: "EVALUATION_INCOMPLETE";
  readonly pack_id: string;
  readonly source_hash: string;
  readonly case: { readonly case_id: string };
  readonly coverage: {
    readonly runs_per_candidate: 1 | 2;
    readonly expected_runs: 3 | 6;
  };
  readonly total_runtime_cost_usd: number;
  readonly candidates: readonly DemoProjectionCandidateLike[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function projectionLike(projection: DemoSourceProjection): DemoProjectionLike {
  return projection as unknown as DemoProjectionLike;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label}이(가) 필요합니다.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 4_000 || /\p{Cc}/u.test(trimmed)) {
    throw new TypeError(`${label}이(가) 안전한 텍스트 범위를 벗어났습니다.`);
  }
  return trimmed;
}

function validateProjection(
  sourceProjection: DemoSourceProjection,
): DemoProjectionLike {
  const projection = projectionLike(sourceProjection);
  const runCount = projection.source === "LIVE_SYNTHETIC_DEMO" ? 1 : 2;
  if (
    projection.synthetic !== true
    || projection.evaluation_status !== "EVALUATION_INCOMPLETE"
    || projection.coverage.runs_per_candidate !== runCount
    || projection.coverage.expected_runs !== runCount * 3
    || projection.candidates.length !== 3
    || CANDIDATE_IDS.some((candidateId, index) => (
      projection.candidates[index]?.candidate_id !== candidateId
      || projection.candidates[index]?.runs.length !== runCount
    ))
  ) {
    throw new TypeError("공개 A/B/C 데모 projection 계약이 올바르지 않습니다.");
  }
  return projection;
}

function projectRun(run: DemoProjectionRunLike): DemoRunView {
  return {
    evidence_id: run.evidence_id,
    repetition: run.run_number,
    execution_status: run.execution_status,
    hard_gate_status: run.deterministic_gate.status,
    latency_ms: run.summed_latency_ms,
    cost_usd: run.cost_usd,
    customer_reply: run.output?.customer_reply ?? null,
    action_code: run.output?.decision.action_code ?? null,
    escalation_required: run.output?.decision.escalation_required ?? null,
    citations: run.output?.citations.map(
      (citation) => `${citation.source_id} §${citation.section_id}`,
    ) ?? [],
  };
}

function decisionSignature(run: DemoProjectionRunLike): string | null {
  if (run.output === null) return null;
  return JSON.stringify({
    action_code: run.output.decision.action_code,
    escalation_required: run.output.decision.escalation_required,
    citations: run.output.citations
      .map((citation) => `${citation.source_id}:${citation.section_id}`)
      .sort(),
  });
}

function projectCandidate(
  candidate: DemoProjectionCandidateLike,
  expectedRunCount: 1 | 2,
): DemoCandidateView {
  const firstRun = projectRun(candidate.runs[0]!);
  const runs: DemoCandidateView["runs"] = expectedRunCount === 1
    ? [firstRun]
    : [firstRun, projectRun(candidate.runs[1]!)];
  const passedRuns = candidate.runs.filter(
    (run) => run.deterministic_gate.status === "PASS",
  ).length;
  const confirmedFailure = candidate.runs.some(
    (run) => run.deterministic_gate.status === "CONFIRMED_FAIL",
  );
  const activePolicyCitations = candidate.runs.filter((run) => (
    run.output?.citations.some(
      (citation) => (
        citation.source_id === "CANCEL-2026"
        && citation.section_id === "2.2"
      ),
    ) === true
  )).length;
  const signatures = candidate.runs.map(decisionSignature);
  const stableDecisions = expectedRunCount === 1
    ? null
    : signatures[0] !== null && signatures[0] === signatures[1];
  const totalCost = candidate.total_runtime_cost_usd ?? 0;

  return {
    candidate_id: candidate.candidate_id,
    architecture: CANDIDATE_CONFIGS[candidate.candidate_id].architecture,
    complexity_tier: COMPLEXITY_TIERS[candidate.candidate_id],
    hard_gate: {
      passed_runs: passedRuns,
      total_runs: expectedRunCount,
      status: confirmedFailure
        ? "CONFIRMED_FAIL"
        : passedRuns === expectedRunCount
          ? "PASS"
          : "NOT_EVALUATED",
    },
    quality: {
      complete_outputs: candidate.runs.filter(
        (run) => run.execution_status === "COMPLETE" && run.output !== null,
      ).length,
      active_policy_citations: activePolicyCitations,
      stability: expectedRunCount === 1
        ? "SINGLE_RUN_NOT_MEASURED"
        : stableDecisions
          ? "STABLE"
          : "VARIED",
      stable_decisions: stableDecisions,
    },
    total_cost_usd: totalCost,
    mean_cost_usd: totalCost / expectedRunCount,
    total_latency_ms: candidate.summed_latency_ms,
    mean_latency_ms: candidate.summed_latency_ms / expectedRunCount,
    provider_calls: candidate.provider_call_count,
    retrieval_calls: candidate.retrieval_call_count,
    tool_calls: candidate.tool_call_count,
    runs,
  };
}

function buildCanary(
  projection: DemoProjectionLike,
): HackathonDemoState["canary"] {
  const runCount = projection.coverage.runs_per_candidate;
  const candidates = CANDIDATE_IDS.map((candidateId) => {
    const candidate = projection.candidates.find(
      (item) => item.candidate_id === candidateId,
    );
    if (!candidate) {
      throw new TypeError(`공개 projection에 Candidate ${candidateId}가 없습니다.`);
    }
    return projectCandidate(candidate, runCount);
  }) as unknown as HackathonDemoState["canary"]["candidates"];
  return {
    pack_id: projection.pack_id,
    pack_hash: projection.source_hash,
    artifact_kind: projection.source === "LIVE_SYNTHETIC_DEMO"
      ? "LIVE_DEMO_EVALUATION_PACK"
      : "PARTIAL_CALIBRATION_PACK",
    evaluation_status: "EVALUATION_INCOMPLETE",
    case_id: projection.case.case_id,
    ticket: CALIBRATION_CASE.ticket_messages
      .map((message) => message.content)
      .join("\n"),
    as_of: CALIBRATION_CASE.as_of,
    total_cost_usd: projection.total_runtime_cost_usd,
    candidates,
  };
}

function buildBlindReview(
  projection: DemoProjectionLike,
): HackathonDemoState["blind_review"] {
  return {
    case_id: projection.case.case_id,
    candidates: BLIND_LABELS.flatMap((blindLabel) => {
      const candidateId = BLIND_TO_CANDIDATE[blindLabel];
      const candidate = projection.candidates.find(
        (item) => item.candidate_id === candidateId,
      );
      if (!candidate || candidate.runs.some((run) => run.output === null)) {
        return [];
      }
      const firstRun = candidate.runs[0]!;
      const runs: HackathonDemoState["blind_review"]["candidates"][number]["runs"] =
        projection.coverage.runs_per_candidate === 1
          ? [{
              repetition: 1,
              customer_reply: firstRun.output!.customer_reply,
              citations: firstRun.output!.citations.map(
                (citation) => `${citation.source_id} §${citation.section_id}`,
              ),
            }]
          : [{
              repetition: 1,
              customer_reply: firstRun.output!.customer_reply,
              citations: firstRun.output!.citations.map(
                (citation) => `${citation.source_id} §${citation.section_id}`,
              ),
            }, {
              repetition: 2,
              customer_reply: candidate.runs[1]!.output!.customer_reply,
              citations: candidate.runs[1]!.output!.citations.map(
                (citation) => `${citation.source_id} §${citation.section_id}`,
              ),
            }];
      return [{
        blind_label: blindLabel,
        runs,
      }];
    }),
  };
}

function lockedEvidence(): DemoAuxiliaryRiskInput["locked_evidence"] {
  const activePolicy = CALIBRATION_POLICIES.find(
    (policy) => (
      policy.source_id === "CANCEL-2026"
      && policy.section_id === "2.2"
    ),
  );
  const order = CALIBRATION_ORDERS.find(
    (item) => item.order_id === CALIBRATION_CASE.order_id,
  );
  if (!activePolicy || !order) {
    throw new TypeError("잠긴 정책 또는 승인된 주문 근거를 찾을 수 없습니다.");
  }
  return [
    {
      evidence_id: "POLICY:CANCEL-2026:2.2",
      evidence_kind: "POLICY",
      content: JSON.stringify({
        source_id: activePolicy.source_id,
        section_id: activePolicy.section_id,
        lifecycle_status: activePolicy.lifecycle_status,
        effective_from: activePolicy.effective_from,
        effective_to: activePolicy.effective_to,
        text: activePolicy.text,
      }),
    },
    {
      evidence_id: "ORDER:ORD-1042",
      evidence_kind: "ORDER",
      content: JSON.stringify({
        order_id: order.order_id,
        status: order.status,
        fulfillment_locked: order.fulfillment_locked,
        shipped_at: order.shipped_at,
        delivered_at: order.delivered_at,
      }),
    },
  ];
}

export function createInitialDemoState(
  sourceProjection: DemoSourceProjection,
): HackathonDemoState {
  const projection = validateProjection(sourceProjection);
  return {
    schema_version: "hackathon-demo-state-v1",
    synthetic: true,
    source: projection.source === "LIVE_SYNTHETIC_DEMO"
      ? "LIVE_SYNTHETIC_DEMO"
      : "RECORDED_FALLBACK",
    status: "JUDGE_REQUIRED",
    canary: buildCanary(projection),
    judge: null,
    blind_review: buildBlindReview(projection),
    human_review: null,
    eligible_candidate_ids: [],
    selection: null,
    memo: null,
    regression: null,
  };
}

export function buildDemoBlindJudgeInput(
  sourceProjection: DemoSourceProjection,
): DemoAuxiliaryRiskInput {
  const projection = validateProjection(sourceProjection);
  return {
    schema_version: "demo-auxiliary-risk-input-v1",
    synthetic: true,
    case_id: projection.case.case_id,
    authority: "RISK_ONLY_REVIEW_REQUIRED",
    deterministic_gates_take_precedence: true,
    disallowed_outputs: [
      "SCORE",
      "RANK",
      "WINNER",
      "PASS_FAIL",
      "RECOMMENDATION",
    ],
    locked_evidence: lockedEvidence(),
    blind_candidates: BLIND_LABELS.map((blindLabel) => {
      const candidateId = BLIND_TO_CANDIDATE[blindLabel];
      const candidate = projection.candidates.find(
        (item) => item.candidate_id === candidateId,
      );
      if (!candidate) {
        throw new TypeError(`Judge 입력 후보 ${blindLabel}의 실행 증거가 없습니다.`);
      }
      return {
        blind_label: blindLabel,
        runs: candidate.runs.map((run) => ({
          run_number: run.run_number,
          evidence_id: `${blindLabel}:RUN:${run.run_number}`,
          execution_status: run.execution_status,
          output: run.output,
        })),
      };
    }) as DemoAuxiliaryRiskInput["blind_candidates"],
  };
}

export function applyDemoJudgeResult(
  state: HackathonDemoState,
  result: BlindJudgeResult,
  metadata: DemoAdapterMetadataLike,
): HackathonDemoState {
  if (state.status !== "JUDGE_REQUIRED" || state.judge !== null) {
    throw new Error("GPT 보조 Judge는 이 데모에서 한 번만 적용할 수 있습니다.");
  }
  if (result.case_id !== state.canary.case_id) {
    throw new TypeError("Judge 결과의 사례 identity가 현재 실행과 다릅니다.");
  }
  return {
    ...clone(state),
    status: "REVIEW_REQUIRED",
    judge: {
      status: "COMPLETE",
      authority: "RISK_ONLY_REVIEW_REQUIRED",
      model_reported_id: metadata.model_reported_id,
      latency_ms: metadata.latency_ms,
      risks: result.candidates.map((candidate) => {
        const failureTypes = candidate.criteria.flatMap((criterion) => (
          criterion.status === "RISK" && criterion.failure_type !== null
            ? [criterion.failure_type]
            : []
        ));
        return {
          blind_label: candidate.blind_label,
          status: failureTypes.length > 0 ? "RISK" : "NO_RISK",
          failure_types: [...new Set(failureTypes)],
        };
      }),
    },
  };
}

export function validateDemoReview(
  input: ConfirmDemoReviewInput,
): ValidatedDemoReview {
  const reviewer = requireText(input.reviewer, "검수자");
  const rationale = requireText(input.rationale, "사람 검수 근거");
  if (
    input.decisions.length < 1
    || input.decisions.length > 3
    || new Set(input.decisions.map((decision) => decision.blind_label)).size
      !== input.decisions.length
    || input.decisions.some((decision, index) => (
      decision.blind_label !== BLIND_LABELS[index]
      || (
        decision.decision !== "PASS"
        && decision.decision !== "CONFIRMED_FAIL"
      )
    ))
  ) {
    throw new TypeError("사람 검수에는 X/Y/Z 잠긴 순서의 고유 결정이 필요합니다.");
  }
  return {
    status: "COMPLETE",
    reviewer,
    rationale,
    review_time: "NOT_MEASURED",
    edit_time: "NOT_MEASURED",
    decisions: clone(input.decisions),
  };
}

export function applyDemoReview(
  state: HackathonDemoState,
  review: ValidatedDemoReview,
): HackathonDemoState {
  if (state.judge?.status !== "COMPLETE" || state.status !== "REVIEW_REQUIRED") {
    throw new Error("GPT 보조 위험 신호 확인 후 사람 검수를 완료해야 합니다.");
  }
  const expectedLabels = state.blind_review.candidates.map(
    (candidate) => candidate.blind_label,
  );
  if (
    review.decisions.length !== expectedLabels.length
    || review.decisions.some(
      (decision, index) => decision.blind_label !== expectedLabels[index],
    )
  ) {
    throw new TypeError(
      `현재 검수 가능한 모든 블라인드 항목(${expectedLabels.join("/")})의 `
      + "결정이 필요합니다.",
    );
  }
  const eligibleCandidateIds = state.canary.candidates
    .filter((candidate) => (
      candidate.hard_gate.status === "PASS"
      && review.decisions.some((decision) => (
        decision.decision === "PASS"
        && BLIND_TO_CANDIDATE[decision.blind_label]
          === candidate.candidate_id
      ))
    ))
    .map((candidate) => candidate.candidate_id);
  return {
    ...clone(state),
    status: eligibleCandidateIds.length === 0
      ? "NO_APPROVED_CANDIDATE"
      : "DECISION_REQUIRED",
    human_review: clone(review),
    eligible_candidate_ids: eligibleCandidateIds,
  };
}

export function eligibleDemoCandidateIds(
  state: HackathonDemoState,
): readonly DemoCandidateId[] {
  return [...state.eligible_candidate_ids];
}

export function validateDemoSelection(
  state: HackathonDemoState,
  input: CreateDemoMemoInput,
): ValidatedDemoSelection {
  if (state.status !== "DECISION_REQUIRED" || state.human_review === null) {
    throw new Error("사람 검수 완료 전에는 후보를 선택할 수 없습니다.");
  }
  const rationale = requireText(input.rationale, "사람 선택 근거");
  if (!eligibleDemoCandidateIds(state).includes(input.selected_candidate_id)) {
    throw new Error("hard gate와 사람 검수를 통과한 후보만 선택할 수 있습니다.");
  }
  return {
    candidate_id: input.selected_candidate_id,
    rationale,
  };
}

export function applyDemoSelection(
  state: HackathonDemoState,
  selection: ValidatedDemoSelection,
): HackathonDemoState {
  if (state.status !== "DECISION_REQUIRED" || state.selection !== null) {
    throw new Error("후보 선택을 기록할 수 없는 현재 상태입니다.");
  }
  if (!eligibleDemoCandidateIds(state).includes(selection.candidate_id)) {
    throw new Error("선택 후보가 현재 증거에서 eligible하지 않습니다.");
  }
  return {
    ...clone(state),
    status: "SELECTION_RECORDED",
    selection: clone(selection),
  };
}

function candidateEvidence(
  canary: HackathonDemoState["canary"],
): DemoDecisionMemoInput["candidate_evidence"] {
  return canary.candidates.map((candidate) => ({
    candidate_id: candidate.candidate_id,
    gate_status: candidate.hard_gate.status === "NOT_EVALUATED"
      ? "BUDGET_EXCEEDED"
      : candidate.hard_gate.status,
    failed_gate_codes: candidate.hard_gate.status === "CONFIRMED_FAIL"
      ? ["P0-HG-02"]
      : [],
    complexity_tier: candidate.complexity_tier,
    metrics: [
      {
        metric_id: "hard_gate_passed_runs",
        value: candidate.hard_gate.passed_runs,
        unit: "runs",
      },
      {
        metric_id: "active_policy_citations",
        value: candidate.quality.active_policy_citations,
        unit: "runs",
      },
      {
        metric_id: "runtime_cost_usd",
        value: candidate.total_cost_usd,
        unit: "USD",
      },
      {
        metric_id: "summed_latency_ms",
        value: candidate.total_latency_ms,
        unit: "ms",
      },
      {
        metric_id: "provider_calls",
        value: candidate.provider_calls,
        unit: "calls",
      },
      {
        metric_id: "retrieval_calls",
        value: candidate.retrieval_calls,
        unit: "calls",
      },
      {
        metric_id: "tool_calls",
        value: candidate.tool_calls,
        unit: "calls",
      },
    ],
  })) as DemoDecisionMemoInput["candidate_evidence"];
}

export function buildDemoDecisionMemoInput(
  state: HackathonDemoState,
): DemoDecisionMemoInput {
  if (
    state.selection === null
    || state.human_review === null
    || (
      state.status !== "SELECTION_RECORDED"
      && state.status !== "MEMO_FAILED"
    )
  ) {
    throw new Error("사람 선택이 기록된 뒤에만 Memo 입력을 만들 수 있습니다.");
  }
  return {
    schema_version: "demo-decision-memo-input-v1",
    synthetic: true,
    case_id: state.canary.case_id,
    authority: "ADVISORY_PROSE_ONLY",
    human_decision: {
      selected_candidate_id: state.selection.candidate_id,
      rationale: state.selection.rationale,
    },
    human_review: {
      reviewed_items: state.human_review.decisions.length,
      remaining_items: 0,
      review_time: state.human_review.review_time,
      edit_time: state.human_review.edit_time,
      decision: "CONFIRMED",
    },
    candidate_evidence: candidateEvidence(state.canary),
    required_external_action_statement: MEMO_EXTERNAL_ACTION_STATEMENT,
  };
}

export function applyDemoMemoSuccess(
  state: HackathonDemoState,
  output: DemoDecisionMemoOutput,
  metadata: DemoAdapterMetadataLike,
): HackathonDemoState {
  const input = buildDemoDecisionMemoInput(state);
  if (
    output.case_id !== input.case_id
    || output.selected_candidate_id !== state.selection?.candidate_id
  ) {
    throw new TypeError("Memo 결과가 현재 선택 identity와 다릅니다.");
  }
  const candidate = state.canary.candidates.find(
    (item) => item.candidate_id === state.selection?.candidate_id,
  );
  if (!candidate || !state.selection) {
    throw new Error("Memo에 필요한 선택 후보 증거가 없습니다.");
  }
  const reviewDecision = state.human_review?.decisions.find(
    (decision) => (
      decision.blind_label === CANDIDATE_TO_BLIND[candidate.candidate_id]
    ),
  )?.decision;
  const tradeOffs = state.canary.candidates.map((item) => (
    `Candidate ${item.candidate_id} (${item.complexity_tier}): `
    + `$${item.total_cost_usd.toFixed(9)}, ${item.total_latency_ms} ms`
  )).join("; ");
  return {
    ...clone(state),
    status: "MEMO_READY",
    memo: {
      status: "COMPLETE",
      model_reported_id: metadata.model_reported_id ?? "unknown",
      latency_ms: metadata.latency_ms,
      decision: output.decision_summary,
      evidence_basis: [
        `Candidate ${candidate.candidate_id} hard gate: `
          + `${candidate.hard_gate.passed_runs}/`
          + `${candidate.hard_gate.total_runs} runs passed.`,
        `Measured runtime: $${candidate.total_cost_usd.toFixed(9)} and `
          + `${candidate.total_latency_ms} ms summed latency.`,
        `Human blind review: ${reviewDecision}; explicit selection recorded.`,
      ],
      trade_offs: tradeOffs,
      limitations: output.known_limitations.join(" "),
      next_step: output.next_poc_scope,
      external_action_statement: output.external_action_statement,
      error_code: null,
    },
  };
}

export function applyDemoMemoFailure(
  state: HackathonDemoState,
): HackathonDemoState {
  if (
    state.selection === null
    || state.human_review === null
    || (
      state.status !== "SELECTION_RECORDED"
      && state.status !== "MEMO_FAILED"
    )
  ) {
    throw new Error("선택 전에는 Memo 실패 상태를 기록할 수 없습니다.");
  }
  const failedMemo: DemoMemoView = {
    status: "FAILED",
    model_reported_id: "unknown",
    latency_ms: 0,
    decision: "",
    evidence_basis: [],
    trade_offs: "",
    limitations: "",
    next_step: "",
    external_action_statement: MEMO_EXTERNAL_ACTION_STATEMENT,
    error_code: "BASELINE_NOT_CREATED",
  };
  return {
    ...clone(state),
    status: "MEMO_FAILED",
    memo: failedMemo,
  };
}

export function replayDemoRepresentativeDefect(
  state: HackathonDemoState,
): HackathonDemoState {
  if (state.memo?.status !== "COMPLETE" || state.status !== "MEMO_READY") {
    throw new Error("실제 Decision Memo가 준비된 뒤에만 대표 결함을 재생할 수 있습니다.");
  }
  if (state.selection === null) {
    throw new Error("대표 결함 재생에 필요한 사람 선택이 없습니다.");
  }
  const gate = evaluateActivePolicyGate({
    output: NEGATIVE_CONTROL_OUTPUT,
    oracle: CALIBRATION_ORACLE,
    policies: CALIBRATION_POLICIES,
    asOf: CALIBRATION_CASE.as_of,
  });
  if (gate.status !== "CONFIRMED_FAIL") {
    throw new Error("대표 결함 재생이 결정적 hard gate를 실패시키지 않았습니다.");
  }
  return {
    ...clone(state),
    status: "BLOCK",
    regression: {
      status: "BLOCK",
      recorded_decision_label:
        `Candidate ${state.selection.candidate_id} · ${state.source} decision`,
      proposed_label: "Representative defective change · deterministic replay",
      new_hard_gate_failures: [
        ...new Set(gate.findings.map((finding) => finding.code)),
      ],
      proposed_reply: NEGATIVE_CONTROL_OUTPUT.customer_reply,
      recorded_decision_remains_unchanged: true,
      external_action_statement: REGRESSION_EXTERNAL_ACTION_STATEMENT,
    },
  };
}

export function createHackathonDemoController({
  projection,
  riskAdapter,
  memoAdapter,
}: {
  readonly projection: RecordedSyntheticDemoProjection;
  readonly riskAdapter: DemoRiskAdapterLike;
  readonly memoAdapter: DemoMemoAdapterLike;
}): HackathonDemoController {
  let state = createInitialDemoState(projection);

  return {
    getState() {
      return clone(state);
    },

    async runJudge() {
      const result = await riskAdapter.invoke(
        buildDemoBlindJudgeInput(projection),
      );
      state = applyDemoJudgeResult(state, result.output, result.metadata);
      return clone(state);
    },

    async confirmReview(input) {
      state = applyDemoReview(state, validateDemoReview(input));
      return clone(state);
    },

    selectCandidate(input) {
      state = applyDemoSelection(state, validateDemoSelection(state, input));
      return clone(state);
    },

    async createMemo(input) {
      if (state.human_review === null) {
        throw new Error(
          "사람 검수 완료 전에는 후보를 선택하거나 Memo를 만들 수 없습니다.",
        );
      }
      if (state.status === "DECISION_REQUIRED") {
        if (input === undefined) {
          throw new Error("Memo 전에 명시적 후보 선택이 필요합니다.");
        }
        state = applyDemoSelection(state, validateDemoSelection(state, input));
      }
      const memoInput = buildDemoDecisionMemoInput(state);
      try {
        const result = await memoAdapter.invoke(memoInput);
        state = applyDemoMemoSuccess(state, result.output, result.metadata);
        return clone(state);
      } catch (error) {
        state = applyDemoMemoFailure(state);
        throw error;
      }
    },

    async replayRepresentativeDefect() {
      state = replayDemoRepresentativeDefect(state);
      return clone(state);
    },
  };
}

import {
  assertAuthoritativeLockedChallengePack,
  type LockedChallengePack,
} from "../eval/define/defineContracts";
import {
  assertPersistedRecordedBenchmarkPack,
  type RecordedBenchmarkPack,
} from "../eval/pack/recordedBenchmarkPack";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../eval/runtime/canonicalJson";
import type { PublicProjection } from "./challengeServer";
import {
  BENCHMARK_CASES,
  REGRESSION_CANARIES,
} from "../eval/data/benchmark";
import { parseCandidateOutput } from "../eval/contracts/candidateOutput";
import { BLIND_JUDGE_LABELS } from "../eval/judge/contracts";
import {
  assertPersistedAiPreReviewReceipt,
  type AiPreReviewReceipt,
} from "../eval/review/preReviewReceipt";
import {
  assertPersistedProvisionalDecisionMemo,
  type ProvisionalDecisionMemo,
} from "../eval/decision/provisionalMemo";
import {
  assertPersistedRecordedRegressionPack,
  type RecordedRegressionPack,
  type RegressionVersionSummary,
} from "../eval/regression/regressionPack";
import {
  assertValidatedHumanConfirmationReceipt,
  type HumanConfirmationReceipt,
} from "../eval/review/humanConfirmation";
import {
  assertAuthoritativeDecisionBaselineRecord,
  assertPersistedFinalDecisionMemo,
  assertAuthoritativeNoApprovedCandidateRecord,
  assertPersistedHumanConfirmedDecisionContext,
  type DecisionAuthorityRecord,
  type FinalDecisionMemo,
  type HumanConfirmedDecisionContext,
} from "../eval/decision/decisionBaseline";
import {
  FINAL_DECISION_MEMO_PUBLIC_BODY_SCHEMA_VERSION,
  finalDecisionMemoPublicBodyPayload,
} from "../shared/finalDecisionMemoPublicBody";
import type { RecordedHardGateMatrixProjection } from "./recordedHardGateMatrix";

const FORBIDDEN_PUBLIC_MATERIAL = /api[_-]?key|authorization|private[_-]?mapping|label[_-]?to[_-]?candidate|(?:master|case)?[_-]?blinding[_-]?seed|hidden[_-]?oracle|raw[_-]?oracle|unrestricted[_-]?order/i;

export class WorkflowProjectionIntegrityError extends Error {
  readonly code = "WORKFLOW_PROJECTION_INTEGRITY" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowProjectionIntegrityError";
  }
}

export interface LockedChallengePublicProjection extends PublicProjection {
  readonly schema_version: "challenge-public-projection-v1";
  readonly synthetic: true;
  readonly challenge_id: string;
  readonly challenge_version: string;
  readonly state: "LOCKED";
  readonly authority: "EXPLICIT_HUMAN_APPROVAL";
  readonly source_hash: string;
  readonly locked_at: string;
  readonly approved_by: string;
  readonly task_contract: LockedChallengePack["approved_contract"]["task_contract"];
  readonly constraints: LockedChallengePack["approved_contract"]["constraints"];
  readonly prohibited_actions: LockedChallengePack["approved_contract"]["prohibited_actions"];
  readonly source_manifest: LockedChallengePack["approved_contract"]["source_manifest"];
  readonly evaluation_criteria: LockedChallengePack["approved_contract"]["evaluation_criteria"];
  readonly hard_gates: LockedChallengePack["approved_contract"]["hard_gates"];
  readonly candidate_complexity_profiles:
    LockedChallengePack["approved_contract"]["candidate_complexity_profiles"];
  readonly sufficiency: LockedChallengePack["approved_contract"]["sufficiency"];
  readonly approved_contract_hash: string;
  readonly source_manifest_hash: string;
}

export interface BenchmarkProgressSlotProjection {
  readonly evidence_id: string;
  readonly case_id: string;
  readonly candidate_id: "A" | "B" | "C";
  readonly repetition: 1 | 2;
  readonly execution_status: string;
  readonly evaluation_status: string;
  readonly hard_gate_status: "PASS" | "CONFIRMED_FAIL" | "NOT_EVALUATED";
  readonly cost_usd: number | null;
  readonly latency_ms: number;
}

export interface RecordedBenchmarkProgressProjection extends PublicProjection {
  readonly schema_version: "benchmark-progress-projection-v1";
  readonly synthetic: true;
  readonly benchmark_id: string;
  readonly source_hash: string;
  readonly source: "RECORDED_BENCHMARK";
  readonly status: "REVIEW_PENDING";
  readonly completed: 72;
  readonly total: 72;
  readonly review_time: "NOT_MEASURED";
  readonly edit_time: "NOT_MEASURED";
  readonly coverage: RecordedBenchmarkPack["coverage"];
  readonly costs: RecordedBenchmarkPack["costs"];
  readonly candidate_aggregates:
    RecordedBenchmarkPack["benchmark_execution_pack"]["candidate_aggregates"];
  readonly slots: readonly BenchmarkProgressSlotProjection[];
}

export interface RecordedEvidencePublicProjection extends PublicProjection {
  readonly schema_version: "evidence-public-projection-v1";
  readonly synthetic: true;
  readonly source_hash: string;
  readonly evidence_id: string;
  readonly kind: "benchmark" | "blind-review";
  readonly title: string;
  readonly case_id: string;
  readonly candidate_label: string;
  readonly source:
    | "RECORDED BENCHMARK"
    | "BLIND HUMAN REVIEW"
    | "RECORDED REGRESSION";
  readonly status:
    | "PASS"
    | "REVIEW REQUIRED"
    | "CONFIRMED FAIL"
    | "INVALID"
    | "TIMEOUT"
    | "BUDGET EXCEEDED";
  readonly case_summary: string;
  readonly expected_decision: string;
  readonly candidate_output?: string;
  readonly structured_decision?: string;
  readonly policy_ids?: readonly string[];
  readonly tool_evidence?: string;
  readonly deterministic_checks?: readonly string[];
  readonly risk_signal?: string;
  readonly metadata?: readonly string[];
  readonly regression_version?: "BASELINE_V1" | "PROPOSED_V2";
  readonly evidence_binding_hash?: string;
}

export interface RecordedWorkspacePublicProjection extends PublicProjection {
  readonly schema_version: "workspace-public-projection-v1";
  readonly synthetic: true;
  readonly challenge_id: string;
  readonly benchmark_id: string;
  readonly review_id: string | null;
  readonly decision_id: string | null;
  readonly baseline_id: string | null;
  readonly regression_id: string | null;
  readonly source_hash: string;
  readonly stage_statuses: {
    readonly define: "LOCKED";
    readonly compare: "RECORDED";
    readonly decide:
      | "REVIEW PENDING"
      | "USER CONFIRMATION REQUIRED"
      | "USER CONFIRMATION BLOCKED"
      | "HUMAN CONFIRMED REVIEW"
      | "MEMO REVIEW REQUIRED"
      | "DECISION CONFIRMED"
      | "NO APPROVED CANDIDATE";
    readonly monitor:
      | "NO BASELINE"
      | "BASELINE ACTIVE"
      | "BLOCK"
      | "REVIEW"
      | "PASS"
      | "EVALUATION INCOMPLETE";
  };
}

export interface BlindReviewPublicProjection extends PublicProjection {
  readonly schema_version: "blind-review-public-projection-v1";
  readonly synthetic: true;
  readonly source_hash: string;
  readonly review_id: string;
  readonly evidence_id: string;
  readonly case_id: string;
  readonly blind_label: "X" | "Y" | "Z";
  readonly candidate_label: string;
  readonly queue_reason:
    | "LOCKED_HIGH_RISK"
    | "JUDGE_RISK"
    | "JUDGE_INCOMPLETE_FALLBACK";
  readonly review_status: "REVIEW REQUIRED";
  readonly deterministic_gate_finding: "NONE" | "CONFIRMED_FAIL";
  readonly deterministic_checks: readonly string[];
  readonly risk_signal: string;
  readonly advisory_only: true;
  readonly human_confirmed: false;
}

export interface PreconfirmationPublicProjection extends PublicProjection {
  readonly schema_version: "preconfirmation-public-projection-v1";
  readonly synthetic: true;
  readonly review_id: string;
  readonly source_hash: string;
  readonly recorded_benchmark_pack_hash: string;
  readonly ai_pre_review_receipt_hash: string;
  readonly provisional_decision_memo_hash: string;
  readonly queue_content_hash: string;
  readonly queue_set_order_hash: string;
  readonly pre_review_status:
    | "USER_CONFIRMATION_READY"
    | "USER_CONFIRMATION_BLOCKED";
  readonly blocking_reasons: readonly string[];
  readonly advisory_only: true;
  readonly human_confirmed: false;
  readonly baseline_version: null;
  readonly total: number;
  readonly completed: 0;
  readonly remaining: number;
  readonly items: readonly {
    readonly item_id: string;
    readonly evidence_id: string;
    readonly queue_index: number;
    readonly case_id: string;
    readonly blind_label: "X" | "Y" | "Z";
    readonly queue_reason:
      | "LOCKED_HIGH_RISK"
      | "JUDGE_RISK"
      | "JUDGE_INCOMPLETE_FALLBACK";
    readonly proposed_decision:
      | "PROPOSED_PASS"
      | "PROPOSED_CONFIRMED_FAIL"
      | "ABSTAIN";
    readonly rationale: string;
    readonly evidence_handles: readonly string[];
    readonly review_evidence_handle: string;
    readonly review_status: "REVIEW_REQUIRED";
  }[];
}

export interface RegressionPublicProjection extends PublicProjection {
  readonly schema_version: "regression-public-projection-v1";
  readonly synthetic: true;
  readonly regression_id: string;
  readonly source_hash: string;
  readonly source: "RECORDED_REGRESSION";
  readonly status: "RECORDED";
  readonly verdict:
    | "BLOCK"
    | "REVIEW"
    | "PASS"
    | "EVALUATION_INCOMPLETE";
  readonly baseline_id: string;
  readonly baseline_version: "v1";
  readonly baseline_candidate_id: "A" | "B" | "C";
  readonly baseline_configuration_hash: string;
  readonly proposed_configuration_hash: string;
  readonly new_hard_gate_failures: readonly {
    readonly case_id: string;
    readonly gate_ids: readonly string[];
    readonly evidence_id: string;
    readonly baseline_status: "PASS";
    readonly proposed_status: "CONFIRMED_FAIL";
  }[];
  readonly evidence_bindings:
    readonly RegressionEvidenceBindingProjection[];
  readonly blocking_reasons: readonly {
    readonly code: string;
    readonly summary: string;
    readonly evidence_id: string | null;
  }[];
  readonly comparison: {
    readonly baseline: RegressionComparisonSide;
    readonly proposed: RegressionComparisonSide;
  };
  readonly external_deployment_performed: false;
  readonly external_rollback_performed: false;
}

export interface RegressionEvidenceBindingProjection {
  readonly schema_version: "regression-evidence-binding-v1";
  readonly source_hash: string;
  readonly evidence_id: string;
  readonly evidence_binding_hash: string;
  readonly case_id: string;
  readonly candidate_id: "A" | "B" | "C";
  readonly candidate_label: `Candidate ${"A" | "B" | "C"}`;
  readonly version: "BASELINE_V1" | "PROPOSED_V2";
  readonly kind: "benchmark";
  readonly source: "RECORDED REGRESSION";
}

interface RegressionComparisonSide {
  readonly label: string;
  readonly hard_gate_failures: number;
  readonly mean_runtime_cost_usd: number | null;
  readonly median_latency_ms: number | null;
  readonly worst_latency_ms: number | null;
}

export interface DecisionPublicProjection extends PublicProjection {
  readonly schema_version: "decision-public-projection-v1";
  readonly synthetic: true;
  readonly decision_id: string;
  readonly source_hash: string;
  readonly status:
    | "HUMAN_CONFIRMED_REVIEW"
    | "MEMO_REVIEW_REQUIRED"
    | "DECISION_CONFIRMED"
    | "NO_APPROVED_CANDIDATE";
  readonly recorded_benchmark_pack_hash: string;
  readonly ai_pre_review_receipt_hash: string;
  readonly provisional_decision_memo_hash: string;
  readonly human_confirmation_receipt_hash: string;
  readonly final_decision_memo_hash: string | null;
  readonly final_decision_memo:
    FinalDecisionMemoPublicProjection | null;
  readonly final_memo_confirmation_hash: string | null;
  readonly human_confirmed: true;
  readonly review: {
    readonly completed: number;
    readonly total: number;
    readonly remaining: 0;
    readonly total_review_duration_ms: number;
    readonly total_edit_duration_ms: number;
  };
  readonly candidates: readonly {
    readonly candidate_id: "A" | "B" | "C";
    readonly gate_status: "PASS" | "REVIEW_REQUIRED" | "CONFIRMED_FAIL";
    readonly eligible: boolean;
    readonly sufficiency_passed: boolean;
    readonly failed_sufficiency_rules: readonly string[];
    readonly critical_failed_case_ids: readonly string[];
    readonly complexity_profile:
      HumanConfirmedDecisionContext["aggregation"]["candidates"][number]["complexity_profile"];
    readonly observed: {
      readonly valid_runs: number;
      readonly policy_success_cases: number;
      readonly citation_success_cases: number;
      readonly escalation_success_cases: number;
      readonly stable_cases: number;
      readonly average_runtime_cost_usd: number | null;
      readonly median_latency_ms: number;
      readonly worst_latency_ms: number;
    };
  }[];
  readonly eligible_candidate_ids: readonly ("A" | "B" | "C")[];
  readonly minimum_complexity_candidate_ids: readonly ("A" | "B" | "C")[];
  readonly recommended_candidate_id: "A" | "B" | "C" | null;
  readonly selection_authority: "HUMAN_DECISION_REQUIRED";
  readonly selected_candidate_id: "A" | "B" | "C" | null;
  readonly selection_rationale: string | null;
  readonly baseline_id: string | null;
  readonly composite_score: null;
  readonly hard_gate_matrix?: RecordedHardGateMatrixProjection;
}

export interface FinalDecisionMemoPublicProjection {
  readonly schema_version:
    typeof FINAL_DECISION_MEMO_PUBLIC_BODY_SCHEMA_VERSION;
  readonly source_hash: string;
  readonly decision_projection_source_hash: string;
  readonly public_body_sha256: string;
  readonly decision_summary: string;
  readonly rejected_alternatives:
    FinalDecisionMemo["rejected_alternatives"];
  readonly hard_gate_findings:
    FinalDecisionMemo["hard_gate_findings"];
  readonly known_limitations: readonly string[];
  readonly next_poc_scope: string;
  readonly procurement_handoff: string;
  readonly external_action_statement:
    "No purchase, contract, deployment, or rollback was executed.";
  readonly candidate_trade_offs: readonly {
    readonly candidate_id: "A" | "B" | "C";
    readonly disposition: "SELECTED" | "NOT_SELECTED";
    readonly summary: string;
    readonly critical_failed_case_ids: readonly string[];
  }[];
}

export interface BaselinePublicProjection extends PublicProjection {
  readonly schema_version: "baseline-public-projection-v1";
  readonly synthetic: true;
  readonly baseline_id: string;
  readonly source_hash: string;
  readonly status: "ACTIVE";
  readonly selected_candidate_id: "A" | "B" | "C";
  readonly decision_record_hash: string;
  readonly final_decision_memo_hash: string;
  readonly final_memo_confirmation_hash: string;
  readonly configuration_hash: string;
  readonly baseline_version: "v1";
  readonly external_deployment_performed: false;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJsonStringify(value)) as T;
}

function assertPublicBoundary(value: unknown, location: string): void {
  const serialized = canonicalJsonStringify(value);
  if (FORBIDDEN_PUBLIC_MATERIAL.test(serialized)) {
    throw new WorkflowProjectionIntegrityError(
      `${location}에 private evaluator 또는 credential 자료가 포함됐습니다.`,
    );
  }
}

export function buildLockedChallengePublicProjection(
  lockedChallengePack: LockedChallengePack,
): LockedChallengePublicProjection {
  try {
    assertAuthoritativeLockedChallengePack(lockedChallengePack);
  } catch (error) {
    throw new WorkflowProjectionIntegrityError(
      "Define projection은 authoritative Locked Challenge build 결과만 허용합니다.",
      { cause: error },
    );
  }
  const contract = lockedChallengePack.approved_contract;
  const projection: LockedChallengePublicProjection = {
    schema_version: "challenge-public-projection-v1",
    synthetic: true,
    challenge_id: lockedChallengePack.challenge_id,
    challenge_version: lockedChallengePack.challenge_version,
    state: "LOCKED",
    authority: "EXPLICIT_HUMAN_APPROVAL",
    source_hash: lockedChallengePack.locked_challenge_pack_hash,
    locked_at: lockedChallengePack.locked_at,
    approved_by: lockedChallengePack.approved_by,
    task_contract: clone(contract.task_contract),
    constraints: clone(contract.constraints),
    prohibited_actions: clone(contract.prohibited_actions),
    source_manifest: clone(contract.source_manifest),
    evaluation_criteria: clone(contract.evaluation_criteria),
    hard_gates: clone(contract.hard_gates),
    candidate_complexity_profiles: clone(
      contract.candidate_complexity_profiles,
    ),
    sufficiency: clone(contract.sufficiency),
    approved_contract_hash: lockedChallengePack.approved_contract_hash,
    source_manifest_hash: lockedChallengePack.source_manifest_hash,
  };
  assertPublicBoundary(projection, "Locked Challenge browser projection");
  return deepFreeze(projection);
}

function hardGateStatus(
  evaluation: Readonly<Record<string, unknown>>,
): BenchmarkProgressSlotProjection["hard_gate_status"] {
  if (evaluation.status !== "EVALUATED" || !Array.isArray(evaluation.gates)) {
    return "NOT_EVALUATED";
  }
  return evaluation.gates.some((gate) => (
    typeof gate === "object"
    && gate !== null
    && !Array.isArray(gate)
    && (gate as Record<string, unknown>).status === "CONFIRMED_FAIL"
  )) ? "CONFIRMED_FAIL" : "PASS";
}

function record(value: unknown, location: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowProjectionIntegrityError(`${location}은 JSON 객체여야 합니다.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function evidenceStatus(
  item: RecordedBenchmarkPack["benchmark_execution_pack"]["slots"][number],
): RecordedEvidencePublicProjection["status"] {
  const gate = hardGateStatus(item.evaluation_state);
  if (gate === "CONFIRMED_FAIL") return "CONFIRMED FAIL";
  if (item.execution_status === "INVALID") return "INVALID";
  if (item.execution_status === "TIMEOUT") return "TIMEOUT";
  if (item.execution_status === "BUDGET_EXCEEDED") return "BUDGET EXCEEDED";
  if (gate !== "PASS" || item.execution_status !== "COMPLETE") {
    return "REVIEW REQUIRED";
  }
  return "PASS";
}

function caseSummary(caseId: string): string {
  const evaluationCase = BENCHMARK_CASES.find((item) => item.case_id === caseId);
  if (!evaluationCase) {
    throw new WorkflowProjectionIntegrityError(`알 수 없는 Benchmark case입니다: ${caseId}`);
  }
  return evaluationCase.ticket_messages.map((message) => message.content).join("\n");
}

function deterministicChecks(
  evaluation: Readonly<Record<string, unknown>>,
): string[] {
  if (evaluation.status !== "EVALUATED" || !Array.isArray(evaluation.gates)) {
    return ["Deterministic evaluation was not completed."];
  }
  return evaluation.gates.map((raw, index) => {
    const gate = record(raw, `evaluation.gates[${index}]`);
    const gateCode = typeof gate.gateCode === "string" ? gate.gateCode : "UNKNOWN GATE";
    const status = typeof gate.status === "string" ? gate.status : "UNKNOWN";
    const findingCodes = Array.isArray(gate.findings)
      ? gate.findings.map((finding, findingIndex) => {
          const parsed = record(finding, `evaluation.gates[${index}].findings[${findingIndex}]`);
          return typeof parsed.code === "string" ? parsed.code : "UNSPECIFIED_FINDING";
        })
      : [];
    return findingCodes.length === 0
      ? `${gateCode} · ${status}`
      : `${gateCode} · ${status} · ${findingCodes.join(", ")}`;
  });
}

function riskSummary(
  recordedBenchmarkPack: RecordedBenchmarkPack,
  caseId: string,
  candidateId: "A" | "B" | "C",
): string {
  const judgeCase = recordedBenchmarkPack.judge_evidence_pack.cases.find(
    (item) => item.case_id === caseId,
  );
  if (!judgeCase || judgeCase.judge_run_receipt.result === null) {
    return "No complete auxiliary Judge record is available.";
  }
  const blindLabel = BLIND_JUDGE_LABELS.find(
    (label) => judgeCase.private_mapping.label_to_candidate[label] === candidateId,
  );
  if (!blindLabel) {
    throw new WorkflowProjectionIntegrityError(
      `${caseId}:${candidateId}의 private blinding mapping이 완전하지 않습니다.`,
    );
  }
  const candidate = judgeCase.judge_run_receipt.result.candidates.find(
    (item) => item.blind_label === blindLabel,
  );
  if (!candidate) {
    throw new WorkflowProjectionIntegrityError(
      `${caseId}:${blindLabel}의 Judge 결과가 없습니다.`,
    );
  }
  const risks = candidate.criteria.filter((criterion) => criterion.status === "RISK");
  return risks.length === 0
    ? "Auxiliary Judge recorded no risk. This is advisory and does not approve the run."
    : risks.map((risk) => (
        `${risk.criterion_id} · ${risk.severity ?? "UNSPECIFIED"} · ${risk.failure_type ?? "UNSPECIFIED"}: ${risk.rationale}`
      )).join("\n");
}

function compareEvidenceProjections(
  recordedBenchmarkPack: RecordedBenchmarkPack,
  sourceHash: string,
): RecordedEvidencePublicProjection[] {
  return recordedBenchmarkPack.benchmark_execution_pack.slots.map((item) => {
    const evidenceId = `slot_${item.slot_identity_hash}`;
    const output = item.run?.output === undefined
      ? null
      : parseCandidateOutput(item.run.output);
    const completed = item.completed_execution_evidence === null
      ? null
      : record(item.completed_execution_evidence, "completed_execution_evidence");
    const retrievalCalls = Array.isArray(completed?.retrievalCalls)
      ? completed.retrievalCalls.length
      : 0;
    const toolCalls = Array.isArray(completed?.toolCalls)
      ? completed.toolCalls.length
      : 0;
    const policyIds = output === null
      ? []
      : [...new Set(output.citations.map((citation) => (
          `${citation.source_id}#${citation.section_id}`
        )))];
    const projection: RecordedEvidencePublicProjection = {
      schema_version: "evidence-public-projection-v1",
      synthetic: true,
      source_hash: sourceHash,
      evidence_id: evidenceId,
      kind: "benchmark",
      title: `Recorded run evidence · ${item.slot.case_id} · Candidate ${item.slot.candidate_id} · Run ${item.slot.repetition}`,
      case_id: item.slot.case_id,
      candidate_label: `Candidate ${item.slot.candidate_id}`,
      source: "RECORDED BENCHMARK",
      status: evidenceStatus(item),
      case_summary: caseSummary(item.slot.case_id),
      expected_decision: "The recorded output must satisfy every locked deterministic gate; a fatal failure cannot be offset by averages.",
      ...(output === null ? {} : {
        candidate_output: output.customer_reply,
        structured_decision: [
          `Action ${output.decision.action_code}`,
          `Escalation ${output.decision.escalation_required ? "required" : "not required"}`,
          `Reason ${output.decision.escalation_reason_code}`,
          `Queue ${output.decision.target_queue}`,
        ].join(" · "),
        policy_ids: policyIds,
      }),
      tool_evidence: `${retrievalCalls} retrieval call${retrievalCalls === 1 ? "" : "s"} · ${toolCalls} read-only tool call${toolCalls === 1 ? "" : "s"}`,
      deterministic_checks: deterministicChecks(item.evaluation_state),
      risk_signal: riskSummary(
        recordedBenchmarkPack,
        item.slot.case_id,
        item.slot.candidate_id,
      ),
      metadata: [
        `Execution ${item.execution_status}`,
        `Evaluation ${String(item.evaluation_state.status)}`,
        `Latency ${item.total_latency_ms} ms`,
        item.usage_cost === null
          ? "Runtime cost incomplete"
          : `Runtime cost USD ${item.usage_cost.totalCostUsd.toFixed(9)}`,
        `Slot evidence ${item.slot_identity_hash}`,
      ],
    };
    return projection;
  });
}

function blindReviewEvidenceProjections(
  recordedBenchmarkPack: RecordedBenchmarkPack,
  sourceHash: string,
): RecordedEvidencePublicProjection[] {
  return recordedBenchmarkPack.blind_review_queue.items.map((item) => {
    const policyIds = item.runs.some(
      (run) => (run.review_output?.citations.length ?? 0) > 0,
    )
      ? ["LOCKED_POLICY_EVIDENCE"]
      : [];
    const checks = item.deterministic_gate_evidence.length === 0
      ? ["No deterministic CONFIRMED FAIL was recorded for this blind item."]
      : item.deterministic_gate_evidence.map((gate) => (
          `${gate.gate_id} · ${gate.status} · ${gate.findings.map((finding) => finding.finding_code).join(", ")}`
        ));
    const risks = item.judge_risks.length === 0
      ? "Auxiliary Judge recorded no risk. This item is required by the locked high-risk review policy."
      : item.judge_risks.map((risk) => (
          `${risk.criterion_id} · ${risk.severity} · ${risk.failure_type}: ${risk.rationale}`
        )).join("\n");
    return {
      schema_version: "evidence-public-projection-v1",
      synthetic: true,
      source_hash: sourceHash,
      evidence_id: blindReviewEvidenceId(recordedBenchmarkPack, item.item_id),
      kind: "blind-review",
      title: `Blind review ${item.case_id} · Candidate ${item.blind_label}`,
      case_id: item.case_id,
      candidate_label: `Candidate ${item.blind_label}`,
      source: "BLIND HUMAN REVIEW",
      status: "REVIEW REQUIRED",
      case_summary: caseSummary(item.case_id),
      expected_decision: "Review both fixed runs against the locked requirements and record PASS or CONFIRMED FAIL with evidence-grounded rationale.",
      policy_ids: policyIds,
      deterministic_checks: checks,
      risk_signal: risks,
      metadata: [
        `Queue reason ${item.queue_reason}`,
        "Candidate architecture and A/B/C identity remain blinded.",
        "Auxiliary Judge signals are advisory only.",
      ],
    } satisfies RecordedEvidencePublicProjection;
  });
}

export function blindReviewEvidenceId(
  recordedBenchmarkPack: RecordedBenchmarkPack,
  itemId: string,
): string {
  return `review_${sha256CanonicalJson({
    queue_content_hash: recordedBenchmarkPack.queue_content_hash,
    item_id: itemId,
  })}`;
}

/**
 * Active reviewer route에서만 쓰는 item 전용 opaque capability입니다.
 * 공개 projection에는 없는 첫 번째 고정 실행의 evidence handle을 비공개 entropy로
 * 쓰고, review·queue·item·해당 evidence에 함께 결합합니다. 따라서 공개 필드만으로
 * 재계산하거나 다른 item·review의 handle을 바꿔 쓸 수 없습니다. durable public
 * snapshot에는 저장하지 않습니다.
 */
export function reviewerBlindEvidenceHandle(
  recordedBenchmarkPack: RecordedBenchmarkPack,
  reviewId: string,
  itemId: string,
): string {
  const queueItem = recordedBenchmarkPack.blind_review_queue.items.find(
    (item) => item.item_id === itemId,
  );
  const privateRunEvidenceHandle = queueItem?.runs[0]?.evidence_handle;
  if (privateRunEvidenceHandle === undefined) {
    throw new WorkflowProjectionIntegrityError(
      "Reviewer evidence capability에 결합할 비공개 고정 실행 handle이 없습니다.",
    );
  }
  const evidenceId = blindReviewEvidenceId(recordedBenchmarkPack, itemId);
  return `evh_${sha256CanonicalJson({
    schema_version: "reviewer-blind-evidence-handle-v1",
    review_id: reviewId,
    queue_content_hash: recordedBenchmarkPack.queue_content_hash,
    item_id: itemId,
    evidence_id: evidenceId,
    private_run_evidence_handle: privateRunEvidenceHandle,
  })}`;
}

export function buildRecordedBenchmarkEvidenceProjections(
  recordedBenchmarkPack: RecordedBenchmarkPack,
): readonly RecordedEvidencePublicProjection[] {
  try {
    assertPersistedRecordedBenchmarkPack(recordedBenchmarkPack);
  } catch (error) {
    throw new WorkflowProjectionIntegrityError(
      "Evidence projection은 source-rebuild로 검증된 Recorded Benchmark Pack만 허용합니다.",
      { cause: error },
    );
  }
  const sourceHash = sha256CanonicalJson(recordedBenchmarkPack);
  // Compare 공개 projection에는 후보 라벨이 있는 72개 slot만 둡니다.
  // X/Y/Z queue와 그 실제 output은 reviewer-only detail source에만 남습니다.
  const projections = compareEvidenceProjections(recordedBenchmarkPack, sourceHash);
  const identities = new Set(projections.map((projection) => projection.evidence_id));
  if (
    projections.length !== 72
    || identities.size !== projections.length
  ) {
    throw new WorkflowProjectionIntegrityError(
      "Evidence projection coverage 또는 identity가 완전하지 않습니다.",
    );
  }
  for (const projection of projections) {
    assertPublicBoundary(projection, `Evidence ${projection.evidence_id}`);
    if (
      projection.kind === "blind-review"
      && /Candidate [ABC]\b|\bsingle llm\b|\brag\b|\btool workflow\b|\bagent workflow\b/i.test(
        canonicalJsonStringify(projection),
      )
    ) {
      throw new WorkflowProjectionIntegrityError(
        `Blind Evidence ${projection.evidence_id}에 후보 identity 또는 architecture가 노출됐습니다.`,
      );
    }
  }
  return deepFreeze(projections);
}

export function buildRecordedWorkspacePublicProjection({
  lockedChallengePack,
  recordedBenchmarkPack,
}: {
  readonly lockedChallengePack: LockedChallengePack;
  readonly recordedBenchmarkPack: RecordedBenchmarkPack;
}): RecordedWorkspacePublicProjection {
  try {
    assertAuthoritativeLockedChallengePack(lockedChallengePack);
    assertPersistedRecordedBenchmarkPack(recordedBenchmarkPack);
  } catch (error) {
    throw new WorkflowProjectionIntegrityError(
      "Workspace projection에는 authoritative Locked Challenge와 source-rebuild Recorded Benchmark가 필요합니다.",
      { cause: error },
    );
  }
  if (
    recordedBenchmarkPack.locked_challenge_pack_hash
      !== lockedChallengePack.locked_challenge_pack_hash
    || recordedBenchmarkPack.locked_challenge_contract_hash
      !== lockedChallengePack.approved_contract_hash
    || recordedBenchmarkPack.locked_challenge_source_manifest_hash
      !== lockedChallengePack.source_manifest_hash
  ) {
    throw new WorkflowProjectionIntegrityError(
      "Workspace의 Challenge와 Recorded Benchmark hash chain이 다릅니다.",
    );
  }
  const projection: RecordedWorkspacePublicProjection = {
    schema_version: "workspace-public-projection-v1",
    synthetic: true,
    challenge_id: lockedChallengePack.challenge_id,
    benchmark_id: recordedBenchmarkPack.benchmark_execution_pack.execution_hash,
    review_id: null,
    decision_id: null,
    baseline_id: null,
    regression_id: null,
    source_hash: sha256CanonicalJson(recordedBenchmarkPack),
    stage_statuses: {
      define: "LOCKED",
      compare: "RECORDED",
      decide: "REVIEW PENDING",
      monitor: "NO BASELINE",
    },
  };
  assertPublicBoundary(projection, "Recorded workspace projection");
  return deepFreeze(projection);
}

export function buildBlindReviewPublicProjections(
  recordedBenchmarkPack: RecordedBenchmarkPack,
): readonly BlindReviewPublicProjection[] {
  try {
    assertPersistedRecordedBenchmarkPack(recordedBenchmarkPack);
  } catch (error) {
    throw new WorkflowProjectionIntegrityError(
      "Blind review projection은 source-rebuild Recorded Benchmark만 허용합니다.",
      { cause: error },
    );
  }
  // reviewer queue는 public snapshot/route가 아닌 권한 검증된 detail service가
  // source-reload해 제공합니다. 공개 목록으로 반환하면 candidate-labelled slot
  // output과 X/Y/Z output을 대응시키는 oracle이 됩니다.
  return Object.freeze([]);
}

export function buildPreconfirmationPublicProjection({
  recordedBenchmarkPack,
  preReviewReceipt,
  provisionalDecisionMemo,
}: {
  readonly recordedBenchmarkPack: RecordedBenchmarkPack;
  readonly preReviewReceipt: AiPreReviewReceipt;
  readonly provisionalDecisionMemo: ProvisionalDecisionMemo;
}): PreconfirmationPublicProjection {
  try {
    assertPersistedRecordedBenchmarkPack(recordedBenchmarkPack);
    assertPersistedAiPreReviewReceipt(preReviewReceipt);
    assertPersistedProvisionalDecisionMemo(provisionalDecisionMemo);
  } catch (error) {
    throw new WorkflowProjectionIntegrityError(
      "Pre-confirmation projection에는 검증된 Recorded Benchmark·AI pre-review·Provisional Memo 체인이 필요합니다.",
      { cause: error },
    );
  }
  const recordedBenchmarkPackHash = sha256CanonicalJson(recordedBenchmarkPack);
  const preReviewReceiptHash = sha256CanonicalJson(preReviewReceipt);
  const provisionalDecisionMemoHash =
    sha256CanonicalJson(provisionalDecisionMemo);
  const queue = recordedBenchmarkPack.blind_review_queue;
  if (
    preReviewReceipt.recorded_benchmark_pack_hash
      !== recordedBenchmarkPackHash
    || preReviewReceipt.judge_evidence_hash
      !== recordedBenchmarkPack.judge_evidence_pack_hash
    || preReviewReceipt.queue_content_hash !== queue.queue_content_hash
    || preReviewReceipt.queue_set_order_hash !== queue.queue_set_order_hash
    || preReviewReceipt.items.length !== queue.items.length
    || preReviewReceipt.items.some(
      (item, index) => item.item_id !== queue.items[index]?.item_id,
    )
    || provisionalDecisionMemo.recorded_benchmark_pack_hash
      !== recordedBenchmarkPackHash
    || provisionalDecisionMemo.ai_pre_review_receipt_hash
      !== preReviewReceiptHash
    || provisionalDecisionMemo.judge_evidence_hash
      !== recordedBenchmarkPack.judge_evidence_pack_hash
    || provisionalDecisionMemo.queue_content_hash !== queue.queue_content_hash
    || provisionalDecisionMemo.queue_set_order_hash
      !== queue.queue_set_order_hash
    || (
      preReviewReceipt.pre_review_status === "USER_CONFIRMATION_READY"
      && (
        provisionalDecisionMemo.memo_status
          !== "USER_CONFIRMATION_REQUIRED"
        || preReviewReceipt.blocking_reasons.length !== 0
        || preReviewReceipt.items.some(
          (item) => item.proposed_decision === "ABSTAIN",
        )
      )
    )
    || (
      preReviewReceipt.pre_review_status === "USER_CONFIRMATION_BLOCKED"
      && (
        provisionalDecisionMemo.memo_status !== "USER_CONFIRMATION_BLOCKED"
        || preReviewReceipt.blocking_reasons.length === 0
      )
    )
  ) {
    throw new WorkflowProjectionIntegrityError(
      "Pre-confirmation projection의 artifact hash·queue·상태 체인이 다릅니다.",
    );
  }
  const items = queue.items.map((queueItem, index) => {
    const proposed = preReviewReceipt.items[index];
    if (proposed === undefined || proposed.item_id !== queueItem.item_id) {
      throw new WorkflowProjectionIntegrityError(
        `Pre-confirmation queue[${index}]와 AI pre-review 순서가 다릅니다.`,
      );
    }
    return {
      item_id: queueItem.item_id,
      evidence_id: blindReviewEvidenceId(
        recordedBenchmarkPack,
        queueItem.item_id,
      ),
      queue_index: index + 1,
      case_id: queueItem.case_id,
      blind_label: queueItem.blind_label,
      queue_reason: queueItem.queue_reason,
      proposed_decision: proposed.proposed_decision,
      rationale: proposed.rationale,
      evidence_handles: [...proposed.evidence_handles],
      // 이 capability는 active reviewer projection에서만 제공됩니다. item별
      // opaque handle은 queue content·item·evidence에 결합하며, A/B/C mapping
      // 또는 raw slot identity를 포함하지 않습니다.
      review_evidence_handle: reviewerBlindEvidenceHandle(
        recordedBenchmarkPack,
        preReviewReceipt.pre_review_id,
        queueItem.item_id,
      ),
      review_status: "REVIEW_REQUIRED" as const,
    };
  });
  const projection: PreconfirmationPublicProjection = {
    schema_version: "preconfirmation-public-projection-v1",
    synthetic: true,
    review_id: preReviewReceipt.pre_review_id,
    source_hash: provisionalDecisionMemoHash,
    recorded_benchmark_pack_hash: recordedBenchmarkPackHash,
    ai_pre_review_receipt_hash: preReviewReceiptHash,
    provisional_decision_memo_hash: provisionalDecisionMemoHash,
    queue_content_hash: queue.queue_content_hash,
    queue_set_order_hash: queue.queue_set_order_hash,
    pre_review_status: preReviewReceipt.pre_review_status,
    blocking_reasons: [...preReviewReceipt.blocking_reasons],
    advisory_only: true,
    human_confirmed: false,
    baseline_version: null,
    total: items.length,
    completed: 0,
    remaining: items.length,
    items,
  };
  assertPublicBoundary(projection, "Pre-confirmation projection");
  if (/Candidate [ABC]\b|private_mapping|label_to_candidate|blinding_seed/i.test(
    canonicalJsonStringify(projection),
  )) {
    throw new WorkflowProjectionIntegrityError(
      "Pre-confirmation projection에 실제 후보 identity가 노출됐습니다.",
    );
  }
  return deepFreeze(projection);
}

export function buildPreconfirmationWorkspacePublicProjection({
  lockedChallengePack,
  recordedBenchmarkPack,
  preReviewReceipt,
  provisionalDecisionMemo,
}: {
  readonly lockedChallengePack: LockedChallengePack;
  readonly recordedBenchmarkPack: RecordedBenchmarkPack;
  readonly preReviewReceipt: AiPreReviewReceipt;
  readonly provisionalDecisionMemo: ProvisionalDecisionMemo;
}): RecordedWorkspacePublicProjection {
  const recorded = buildRecordedWorkspacePublicProjection({
    lockedChallengePack,
    recordedBenchmarkPack,
  });
  const preconfirmation = buildPreconfirmationPublicProjection({
    recordedBenchmarkPack,
    preReviewReceipt,
    provisionalDecisionMemo,
  });
  const projection: RecordedWorkspacePublicProjection = {
    ...recorded,
    review_id: preconfirmation.review_id,
    source_hash: preconfirmation.source_hash,
    stage_statuses: {
      ...recorded.stage_statuses,
      decide:
        preconfirmation.pre_review_status === "USER_CONFIRMATION_READY"
          ? "USER CONFIRMATION REQUIRED"
          : "USER CONFIRMATION BLOCKED",
    },
  };
  assertPublicBoundary(projection, "Pre-confirmation workspace projection");
  return deepFreeze(projection);
}

export function buildRecordedBenchmarkProgressProjection(
  recordedBenchmarkPack: RecordedBenchmarkPack,
): RecordedBenchmarkProgressProjection {
  try {
    assertPersistedRecordedBenchmarkPack(recordedBenchmarkPack);
  } catch (error) {
    throw new WorkflowProjectionIntegrityError(
      "Compare projection은 source-rebuild로 검증된 Recorded Benchmark Pack만 허용합니다.",
      { cause: error },
    );
  }
  const executionPack = recordedBenchmarkPack.benchmark_execution_pack;
  const slots = executionPack.slots.map((item) => ({
    evidence_id: `slot_${item.slot_identity_hash}`,
    case_id: item.slot.case_id,
    candidate_id: item.slot.candidate_id,
    repetition: item.slot.repetition,
    execution_status: item.execution_status,
    evaluation_status: String(item.evaluation_state.status),
    hard_gate_status: hardGateStatus(item.evaluation_state),
    cost_usd: item.usage_cost?.totalCostUsd ?? null,
    latency_ms: item.total_latency_ms,
  })) as readonly BenchmarkProgressSlotProjection[];
  const projection: RecordedBenchmarkProgressProjection = {
    schema_version: "benchmark-progress-projection-v1",
    synthetic: true,
    benchmark_id: executionPack.execution_hash,
    source_hash: sha256CanonicalJson(recordedBenchmarkPack),
    source: "RECORDED_BENCHMARK",
    status: "REVIEW_PENDING",
    completed: 72,
    total: 72,
    review_time: "NOT_MEASURED",
    edit_time: "NOT_MEASURED",
    coverage: clone(recordedBenchmarkPack.coverage),
    costs: clone(recordedBenchmarkPack.costs),
    candidate_aggregates: clone(executionPack.candidate_aggregates),
    slots: clone(slots),
  };
  assertPublicBoundary(projection, "Recorded Benchmark progress projection");
  return deepFreeze(projection);
}

/**
 * 사람 검수가 끝나기 전의 공개 Compare 경계입니다. 후보별 aggregate는 의사결정
 * 맥락으로 남기되, 사례·후보·반복·evidence 좌표는 X/Y/Z reviewer detail과
 * 상관될 수 있으므로 공개 snapshot에서 제거합니다.
 */
export function buildReviewPendingBenchmarkProgressProjection(
  recordedBenchmarkPack: RecordedBenchmarkPack,
): RecordedBenchmarkProgressProjection {
  const recorded = buildRecordedBenchmarkProgressProjection(
    recordedBenchmarkPack,
  );
  const projection: RecordedBenchmarkProgressProjection = {
    ...recorded,
    slots: [],
  };
  assertPublicBoundary(
    projection,
    "Review-pending Benchmark progress projection",
  );
  return deepFreeze(projection);
}

function decisionCandidateProjection(
  candidate: HumanConfirmedDecisionContext["aggregation"]["candidates"][number],
): DecisionPublicProjection["candidates"][number] {
  return {
    candidate_id: candidate.candidate_id,
    gate_status: candidate.gate_status,
    eligible: candidate.eligible,
    sufficiency_passed: candidate.sufficiency_passed,
    failed_sufficiency_rules: [...candidate.failed_sufficiency_rules],
    critical_failed_case_ids: [...candidate.critical_failed_case_ids],
    complexity_profile: clone(candidate.complexity_profile),
    observed: clone(candidate.observed),
  };
}

function buildFinalDecisionMemoPublicProjection(
  memo: FinalDecisionMemo,
  sourceHash: string,
  decisionProjectionSourceHash: string,
): FinalDecisionMemoPublicProjection {
  // 호출 전에 source-reloaded persisted Memo assertion이 완료돼야 합니다.
  const candidateIds = ["A", "B", "C"] as const;
  const findingsByCandidate = new Map(
    memo.hard_gate_findings.map((finding) => [
      finding.candidate_id,
      finding,
    ]),
  );
  const alternativesByCandidate = new Map(
    memo.rejected_alternatives.map((alternative) => [
      alternative.candidate_id,
      alternative,
    ]),
  );
  const benchmarkScope = memo.known_limitations[0] ?? "";
  const candidateVersions = memo.known_limitations[1] ?? "";
  const humanReviewSample = memo.known_limitations[2] ?? "";
  const limitationsText = memo.known_limitations.join("\n");
  if (
    findingsByCandidate.size !== candidateIds.length
    || (
      memo.selected_candidate_id === null
        ? alternativesByCandidate.size !== candidateIds.length
        : alternativesByCandidate.size !== candidateIds.length - 1
    )
    || !/^Benchmark scope: challenge_version=[^;\s]+; recorded_pack_schema=[^;\s]+; execution_pack_schema=[^;\s]+; dataset_sha256=[a-f0-9]{64}; cases=12; candidates=3; runs_per_case=2; candidate_runs=72; judge_cases=12\.$/u
      .test(benchmarkScope)
    || !/^Candidate versions: A=[A-Za-z0-9._:-]+ B=[A-Za-z0-9._:-]+ C=[A-Za-z0-9._:-]+\.$/u
      .test(candidateVersions)
    || !/^Human-review sample; required_high_risk_cases=4; required_candidate_case_reviews=12; completed_candidate_case_reviews=[1-9][0-9]*; judge_flagged_candidate_case_reviews=[0-9]+; statistical_generalization=NOT_SUPPORTED\.$/u
      .test(humanReviewSample)
    || !/auxiliary .*Judge/iu.test(limitationsText)
    || !/self-preference or position bias/iu.test(limitationsText)
  ) {
    throw new WorkflowProjectionIntegrityError(
      "Final Decision Memo projection에는 표본·후보 버전·단일 Judge 편향 한계와 전체 후보 trade-off가 필요합니다.",
    );
  }
  const candidateTradeOffs =
    candidateIds.map((candidateId) => {
      const finding = findingsByCandidate.get(candidateId);
      if (finding === undefined) {
        throw new WorkflowProjectionIntegrityError(
          `Final Decision Memo의 Candidate ${candidateId} hard-gate finding이 없습니다.`,
        );
      }
      if (candidateId === memo.selected_candidate_id) {
        if (alternativesByCandidate.has(candidateId)) {
          throw new WorkflowProjectionIntegrityError(
            "선택 후보가 rejected alternative에도 포함됐습니다.",
          );
        }
        return {
          candidate_id: candidateId,
          disposition: "SELECTED" as const,
          summary: memo.decision_summary,
          critical_failed_case_ids: [
            ...finding.critical_failed_case_ids,
          ],
        };
      }
      const alternative = alternativesByCandidate.get(candidateId);
      if (alternative === undefined) {
        throw new WorkflowProjectionIntegrityError(
          `Final Decision Memo의 Candidate ${candidateId} trade-off가 없습니다.`,
        );
      }
      return {
        candidate_id: candidateId,
        disposition: "NOT_SELECTED" as const,
        summary: alternative.reason,
        critical_failed_case_ids: [
          ...finding.critical_failed_case_ids,
        ],
      };
    });
  const publicBody = finalDecisionMemoPublicBodyPayload({
    source_hash: sourceHash,
    decision_projection_source_hash: decisionProjectionSourceHash,
    decision_summary: memo.decision_summary,
    rejected_alternatives: clone(memo.rejected_alternatives),
    hard_gate_findings: clone(memo.hard_gate_findings),
    known_limitations: [...memo.known_limitations],
    next_poc_scope: memo.next_poc_scope,
    procurement_handoff: memo.procurement_handoff,
    external_action_statement: memo.external_action_statement,
    candidate_trade_offs: candidateTradeOffs,
  });
  const publicRejectedAlternatives = publicBody.rejected_alternatives as FinalDecisionMemo["rejected_alternatives"];
  const publicHardGateFindings = publicBody.hard_gate_findings as FinalDecisionMemo["hard_gate_findings"];
  const publicCandidateTradeOffs = publicBody.candidate_trade_offs as FinalDecisionMemoPublicProjection["candidate_trade_offs"];
  const projection: FinalDecisionMemoPublicProjection = {
    schema_version: FINAL_DECISION_MEMO_PUBLIC_BODY_SCHEMA_VERSION,
    source_hash: sourceHash,
    decision_projection_source_hash: decisionProjectionSourceHash,
    public_body_sha256: sha256CanonicalJson(publicBody),
    decision_summary: publicBody.decision_summary,
    rejected_alternatives: publicRejectedAlternatives,
    hard_gate_findings: publicHardGateFindings,
    known_limitations: publicBody.known_limitations,
    next_poc_scope: publicBody.next_poc_scope,
    procurement_handoff: publicBody.procurement_handoff,
    external_action_statement: memo.external_action_statement,
    candidate_trade_offs: publicCandidateTradeOffs,
  };
  return deepFreeze(projection);
}

export function buildDecisionPublicProjection({
  context,
  humanConfirmationReceipt,
  finalDecisionMemo,
  decisionAuthorityRecord,
  hardGateMatrix,
}: {
  readonly context: HumanConfirmedDecisionContext;
  readonly humanConfirmationReceipt: HumanConfirmationReceipt;
  readonly finalDecisionMemo?: FinalDecisionMemo;
  readonly decisionAuthorityRecord?: DecisionAuthorityRecord;
  readonly hardGateMatrix?: RecordedHardGateMatrixProjection;
}): DecisionPublicProjection {
  try {
    assertPersistedHumanConfirmedDecisionContext(context);
    assertValidatedHumanConfirmationReceipt(humanConfirmationReceipt);
    if (finalDecisionMemo !== undefined) {
      assertPersistedFinalDecisionMemo(finalDecisionMemo);
    }
    if (decisionAuthorityRecord?.artifact_kind
      === "DECISION_BASELINE_RECORD") {
      assertAuthoritativeDecisionBaselineRecord(decisionAuthorityRecord);
    } else if (decisionAuthorityRecord !== undefined) {
      assertAuthoritativeNoApprovedCandidateRecord(
        decisionAuthorityRecord,
      );
    }
  } catch (error) {
    throw new WorkflowProjectionIntegrityError(
      "Decision projection에는 persisted Human confirmation과 검증된 Memo/terminal Decision 권위가 필요합니다.",
      { cause: error },
    );
  }
  const humanReceiptHash = sha256CanonicalJson(humanConfirmationReceipt);
  const aggregationHash = sha256CanonicalJson(context.aggregation);
  if (
    humanReceiptHash !== context.human_confirmation_receipt_hash
    || humanConfirmationReceipt.recorded_benchmark_pack_hash
      !== context.recorded_benchmark_pack_hash
    || humanConfirmationReceipt.human_confirmed !== true
    || humanConfirmationReceipt.human_confirmation_status
      !== "HUMAN_CONFIRMED"
    || humanConfirmationReceipt.next_step
      !== "HUMAN_CONFIRMED_DECISION_ELIGIBLE"
  ) {
    throw new WorkflowProjectionIntegrityError(
      "Decision projection의 persisted Human confirmation hash/state가 context와 다릅니다.",
    );
  }
  if (
    hardGateMatrix !== undefined
    && hardGateMatrix.source_hash !== context.recorded_benchmark_pack_hash
  ) {
    throw new WorkflowProjectionIntegrityError(
      "Decision projection의 hard-gate matrix가 같은 Recorded Benchmark Pack에 결합되지 않았습니다.",
    );
  }
  const finalMemoHash = finalDecisionMemo === undefined
    ? null
    : sha256CanonicalJson(finalDecisionMemo);
  if (
    finalDecisionMemo !== undefined
    && (
      finalDecisionMemo.recorded_benchmark_pack_hash
        !== context.recorded_benchmark_pack_hash
      || finalDecisionMemo.human_confirmation_receipt_hash
        !== humanReceiptHash
      || finalDecisionMemo.aggregation_hash !== aggregationHash
    )
  ) {
    throw new WorkflowProjectionIntegrityError(
      "Decision projection의 Final Memo hash chain이 context와 다릅니다.",
    );
  }
  if (
    decisionAuthorityRecord !== undefined
    && (
      decisionAuthorityRecord.recorded_benchmark_pack_hash
        !== context.recorded_benchmark_pack_hash
      || decisionAuthorityRecord.human_confirmation_receipt_hash
        !== humanReceiptHash
      || decisionAuthorityRecord.aggregation_hash !== aggregationHash
      || (
        finalMemoHash !== null
        && decisionAuthorityRecord.final_decision_memo_hash !== finalMemoHash
      )
    )
  ) {
    throw new WorkflowProjectionIntegrityError(
      "Decision projection의 terminal Decision record hash chain이 context와 다릅니다.",
    );
  }
  const status: DecisionPublicProjection["status"] =
    decisionAuthorityRecord?.artifact_kind === "DECISION_BASELINE_RECORD"
      ? "DECISION_CONFIRMED"
      : decisionAuthorityRecord?.artifact_kind
          === "NO_APPROVED_CANDIDATE_RECORD"
        ? "NO_APPROVED_CANDIDATE"
        : finalDecisionMemo !== undefined
          ? "MEMO_REVIEW_REQUIRED"
          : "HUMAN_CONFIRMED_REVIEW";
  const selectedCandidateId = decisionAuthorityRecord?.selected_candidate_id
    ?? finalDecisionMemo?.selected_candidate_id
    ?? null;
  const selectionRationale = decisionAuthorityRecord?.selection_rationale
    ?? finalDecisionMemo?.selection_rationale
    ?? null;
  const sourceHash = decisionAuthorityRecord === undefined
    ? finalMemoHash ?? humanReceiptHash
    : sha256CanonicalJson(decisionAuthorityRecord);
  const decisionId = decisionAuthorityRecord?.decision_id
    ?? `decision_pending_${sha256CanonicalJson({
      schema_version: "decision-public-pending-id-v1",
      recorded_benchmark_pack_hash:
        context.recorded_benchmark_pack_hash,
      human_confirmation_receipt_hash: humanReceiptHash,
    })}`;
  const finalDecisionMemoProjection =
    finalDecisionMemo === undefined || finalMemoHash === null
      ? null
      : buildFinalDecisionMemoPublicProjection(
          finalDecisionMemo,
          finalMemoHash,
          sourceHash,
        );
  const projection: DecisionPublicProjection = {
    schema_version: "decision-public-projection-v1",
    synthetic: true,
    decision_id: decisionId,
    source_hash: sourceHash,
    status,
    recorded_benchmark_pack_hash:
      context.recorded_benchmark_pack_hash,
    ai_pre_review_receipt_hash:
      humanConfirmationReceipt.ai_pre_review_receipt_hash,
    provisional_decision_memo_hash:
      humanConfirmationReceipt.provisional_decision_memo_hash,
    human_confirmation_receipt_hash: humanReceiptHash,
    final_decision_memo_hash:
      decisionAuthorityRecord?.final_decision_memo_hash ?? finalMemoHash,
    final_decision_memo: finalDecisionMemoProjection,
    final_memo_confirmation_hash:
      decisionAuthorityRecord
        ?.final_decision_confirmation_receipt_hash ?? null,
    human_confirmed: true,
    review: {
      completed: context.human_review.reviewed_items,
      total: context.human_review.reviewed_items,
      remaining: 0,
      total_review_duration_ms:
        context.human_review.total_review_duration_ms,
      total_edit_duration_ms:
        context.human_review.total_edit_duration_ms,
    },
    candidates: context.aggregation.candidates.map(
      decisionCandidateProjection,
    ),
    eligible_candidate_ids: [
      ...context.aggregation.eligible_candidate_ids,
    ],
    minimum_complexity_candidate_ids: [
      ...context.aggregation.minimum_complexity_candidate_ids,
    ],
    recommended_candidate_id:
      context.aggregation.recommended_candidate_id,
    selection_authority: "HUMAN_DECISION_REQUIRED",
    selected_candidate_id: selectedCandidateId,
    selection_rationale: selectionRationale,
    baseline_id:
      decisionAuthorityRecord?.artifact_kind
        === "DECISION_BASELINE_RECORD"
        ? decisionAuthorityRecord.baseline_version
        : null,
    composite_score: null,
    ...(hardGateMatrix === undefined
      ? {}
      : { hard_gate_matrix: hardGateMatrix }),
  };
  assertPublicBoundary(projection, "Human-confirmed Decision projection");
  return deepFreeze(projection);
}

export function buildBaselinePublicProjection(
  decisionBaselineRecord: Extract<
    DecisionAuthorityRecord,
    { readonly artifact_kind: "DECISION_BASELINE_RECORD" }
  >,
): BaselinePublicProjection {
  try {
    assertAuthoritativeDecisionBaselineRecord(decisionBaselineRecord);
  } catch (error) {
    throw new WorkflowProjectionIntegrityError(
      "Baseline projection은 persisted source에서 재로드한 authoritative Decision baseline만 허용합니다.",
      { cause: error },
    );
  }
  const decisionRecordHash = sha256CanonicalJson(decisionBaselineRecord);
  const projection: BaselinePublicProjection = {
    schema_version: "baseline-public-projection-v1",
    synthetic: true,
    baseline_id: decisionBaselineRecord.baseline_version,
    source_hash: decisionRecordHash,
    status: "ACTIVE",
    selected_candidate_id: decisionBaselineRecord.selected_candidate_id,
    decision_record_hash: decisionRecordHash,
    final_decision_memo_hash:
      decisionBaselineRecord.final_decision_memo_hash,
    final_memo_confirmation_hash:
      decisionBaselineRecord
        .final_decision_confirmation_receipt_hash,
    configuration_hash: sha256CanonicalJson(
      decisionBaselineRecord.selected_candidate_identity,
    ),
    baseline_version: "v1",
    external_deployment_performed:
      decisionBaselineRecord.external_actions.deployment_executed,
  };
  assertPublicBoundary(projection, "Active Baseline projection");
  return deepFreeze(projection);
}

function regressionEvidenceId(slotIdentityHash: string): string {
  return `regression_slot_${slotIdentityHash}`;
}

function regressionEvidenceBinding(
  slot: RecordedRegressionPack["slots"][number],
  sourceHash: string,
): RegressionEvidenceBindingProjection {
  const material = {
    schema_version: "regression-evidence-binding-v1" as const,
    source_hash: sourceHash,
    evidence_id: regressionEvidenceId(slot.slot_identity_hash),
    case_id: slot.slot.case_id,
    candidate_id: slot.slot.candidate_id,
    candidate_label: `Candidate ${slot.slot.candidate_id}` as const,
    version: slot.slot.version,
    kind: "benchmark" as const,
    source: "RECORDED REGRESSION" as const,
  };
  return {
    ...material,
    evidence_binding_hash: sha256CanonicalJson(material),
  };
}

function regressionCaseSummary(caseId: string): string {
  const evaluationCase = [
    ...BENCHMARK_CASES,
    ...REGRESSION_CANARIES,
  ].find((item) => item.case_id === caseId);
  if (evaluationCase === undefined) {
    throw new WorkflowProjectionIntegrityError(
      `알 수 없는 Regression case입니다: ${caseId}`,
    );
  }
  return evaluationCase.ticket_messages
    .map((message) => message.content)
    .join("\n");
}

export function buildRegressionEvidenceProjections(
  recordedRegressionPack: RecordedRegressionPack,
): readonly RecordedEvidencePublicProjection[] {
  try {
    assertPersistedRecordedRegressionPack(recordedRegressionPack);
  } catch (error) {
    throw new WorkflowProjectionIntegrityError(
      "Regression Evidence projection은 검증된 Recorded Regression Pack만 허용합니다.",
      { cause: error },
    );
  }
  const sourceHash = sha256CanonicalJson(recordedRegressionPack);
  const projections = recordedRegressionPack.slots.map((slot) => {
    const binding = regressionEvidenceBinding(slot, sourceHash);
    const execution = slot.raw_execution_evidence;
    const output = execution.candidate_output;
    const deterministic = slot.deterministic_evaluation;
    const deterministicFailed = (
      deterministic.hard_gate_failures.length > 0
      || !deterministic.policy_decision_passed
      || !deterministic.citation_passed
      || !deterministic.escalation_passed
    );
    const status: RecordedEvidencePublicProjection["status"] =
      deterministicFailed
        ? "CONFIRMED FAIL"
        : execution.execution_status === "INVALID"
          ? "INVALID"
          : execution.execution_status === "TIMEOUT"
            ? "TIMEOUT"
            : execution.execution_status === "BUDGET_EXCEEDED"
              ? "BUDGET EXCEEDED"
              : execution.execution_status === "COMPLETE"
                && execution.evaluation_status === "EVALUATED"
                ? "PASS"
                : "REVIEW REQUIRED";
    const projection: RecordedEvidencePublicProjection = {
      schema_version: "evidence-public-projection-v1",
      synthetic: true,
      source_hash: sourceHash,
      evidence_id: regressionEvidenceId(slot.slot_identity_hash),
      kind: "benchmark",
      title: `${slot.slot.version === "BASELINE_V1" ? "Baseline v1" : "Proposed v2"} regression evidence · ${slot.slot.case_id}`,
      case_id: slot.slot.case_id,
      candidate_label: `Candidate ${slot.slot.candidate_id}`,
      source: "RECORDED REGRESSION",
      status,
      case_summary: regressionCaseSummary(slot.slot.case_id),
      expected_decision:
        "Baseline v1 and Proposed v2 are evaluated against the same locked deterministic contract; a new fatal failure blocks the change.",
      ...(output === null ? {} : {
        candidate_output: output.customer_reply,
        structured_decision: [
          `Action ${output.decision.action_code}`,
          `Escalation ${output.decision.escalation_required ? "required" : "not required"}`,
          `Reason ${output.decision.escalation_reason_code}`,
          `Queue ${output.decision.target_queue}`,
        ].join(" · "),
        policy_ids: [...new Set(output.citations.map((citation) => (
          `${citation.source_id}#${citation.section_id}`
        )))],
      }),
      tool_evidence:
        `${execution.retrieval_calls.length} retrieval call${execution.retrieval_calls.length === 1 ? "" : "s"} · ${execution.tool_calls.length} read-only tool call${execution.tool_calls.length === 1 ? "" : "s"}`,
      deterministic_checks: [
        deterministic.hard_gate_failures.length === 0
          ? "Hard gates · PASS"
          : `Hard gates · CONFIRMED FAIL · ${deterministic.hard_gate_failures.join(", ")}`,
        `Policy decision · ${deterministic.policy_decision_passed ? "PASS" : "FAIL"}`,
        `Citation · ${deterministic.citation_passed ? "PASS" : "FAIL"}`,
        `Escalation · ${deterministic.escalation_passed ? "PASS" : "FAIL"}`,
      ],
      risk_signal:
        "The auxiliary GPT Judge is intentionally not run in regression mode; deterministic evidence and the locked contract control this result.",
      metadata: [
        `Version ${slot.slot.version}`,
        `Dataset split ${slot.slot.dataset_split}`,
        `Execution ${execution.execution_status}`,
        `Evaluation ${execution.evaluation_status}`,
        `Latency ${execution.total_latency_ms} ms`,
        execution.candidate_cost_usd === null
          ? "Runtime cost incomplete"
          : `Runtime cost USD ${execution.candidate_cost_usd.toFixed(9)}`,
        `Slot evidence ${slot.slot_identity_hash}`,
      ],
      regression_version: binding.version,
      evidence_binding_hash: binding.evidence_binding_hash,
    };
    assertPublicBoundary(
      projection,
      `Regression Evidence ${projection.evidence_id}`,
    );
    return projection;
  });
  if (
    projections.length !== 36
    || new Set(projections.map((item) => item.evidence_id)).size !== 36
  ) {
    throw new WorkflowProjectionIntegrityError(
      "Regression Evidence projection은 정확히 36개 고유 slot이어야 합니다.",
    );
  }
  return deepFreeze(projections);
}

function regressionComparisonSide(
  label: string,
  summary: RegressionVersionSummary,
): RegressionComparisonSide {
  return {
    label,
    hard_gate_failures: summary.hard_gate_failed_case_ids.length,
    mean_runtime_cost_usd: summary.mean_cost_usd_per_case,
    median_latency_ms: summary.median_latency_ms,
    worst_latency_ms: summary.worst_latency_ms,
  };
}

const REGRESSION_REASON_SUMMARIES = Object.freeze({
  BASELINE_CONTROL_INCOMPLETE:
    "Baseline v1 control evidence is incomplete, so no change can be approved.",
  PROPOSED_RUNNER_OR_EVIDENCE_INTEGRITY_INCOMPLETE:
    "The proposed run or its evidence chain is incomplete.",
  PROPOSED_CRITICAL_OR_NON_COST_REGRESSION:
    "The proposed configuration introduced a critical or non-cost regression.",
  PROPOSED_COST_OR_LATENCY_LIMIT_EXCEEDED:
    "The proposed configuration exceeded a locked cost or latency limit.",
  LOCKED_REGRESSION_REQUIREMENTS_MAINTAINED:
    "The proposed configuration maintained the locked regression requirements.",
} satisfies Readonly<Record<string, string>>);

function blockingEvidenceId(
  pack: RecordedRegressionPack,
  reason: string,
  newFailureEvidenceIds: readonly string[],
): string | null {
  if (
    reason === "PROPOSED_CRITICAL_OR_NON_COST_REGRESSION"
    && newFailureEvidenceIds.length > 0
  ) {
    return newFailureEvidenceIds[0];
  }
  const proposed = pack.slots.filter(
    (slot) => slot.slot.version === "PROPOSED_V2",
  );
  if (reason === "PROPOSED_RUNNER_OR_EVIDENCE_INTEGRITY_INCOMPLETE") {
    const slot = proposed.find((item) => (
      item.raw_execution_evidence.evaluation_status
        === "EVALUATION_INCOMPLETE"
      || item.raw_execution_evidence.execution_status === "FAILED"
    ));
    return slot === undefined
      ? null
      : regressionEvidenceId(slot.slot_identity_hash);
  }
  if (reason === "PROPOSED_CRITICAL_OR_NON_COST_REGRESSION") {
    const slot = proposed.find((item) => (
      item.raw_execution_evidence.execution_status !== "COMPLETE"
      || item.deterministic_evaluation.hard_gate_failures.length > 0
      || !item.deterministic_evaluation.policy_decision_passed
      || !item.deterministic_evaluation.citation_passed
      || !item.deterministic_evaluation.escalation_passed
    ));
    return slot === undefined
      ? null
      : regressionEvidenceId(slot.slot_identity_hash);
  }
  if (reason === "BASELINE_CONTROL_INCOMPLETE") {
    const slot = pack.slots.find((item) => (
      item.slot.version === "BASELINE_V1"
      && (
        item.raw_execution_evidence.execution_status !== "COMPLETE"
        || item.raw_execution_evidence.evaluation_status !== "EVALUATED"
      )
    ));
    return slot === undefined
      ? null
      : regressionEvidenceId(slot.slot_identity_hash);
  }
  return null;
}

export function buildRegressionPublicProjection(
  recordedRegressionPack: RecordedRegressionPack,
): RegressionPublicProjection {
  try {
    assertPersistedRecordedRegressionPack(recordedRegressionPack);
  } catch (error) {
    throw new WorkflowProjectionIntegrityError(
      "Regression projection은 검증된 Recorded Regression Pack만 허용합니다.",
      { cause: error },
    );
  }
  const sourceHash = sha256CanonicalJson(recordedRegressionPack);
  const baselineByCase = new Map(recordedRegressionPack.slots
    .filter((slot) => slot.slot.version === "BASELINE_V1")
    .map((slot) => [slot.slot.case_id, slot]));
  const newHardGateFailures = recordedRegressionPack.slots
    .filter((slot) => slot.slot.version === "PROPOSED_V2")
    .flatMap((proposed) => {
      const baseline = baselineByCase.get(proposed.slot.case_id);
      if (baseline === undefined) {
        throw new WorkflowProjectionIntegrityError(
          `Regression ${proposed.slot.case_id}의 Baseline v1 대응 slot이 없습니다.`,
        );
      }
      const baselineFailures = baseline.deterministic_evaluation
        .hard_gate_failures;
      const proposedFailures = proposed.deterministic_evaluation
        .hard_gate_failures;
      if (baselineFailures.length > 0 || proposedFailures.length === 0) {
        return [];
      }
      return [{
        case_id: proposed.slot.case_id,
        gate_ids: [...new Set(proposedFailures)].sort(),
        evidence_id: regressionEvidenceId(proposed.slot_identity_hash),
        baseline_status: "PASS" as const,
        proposed_status: "CONFIRMED_FAIL" as const,
      }];
    });
  if (
    newHardGateFailures.length > 0
    && recordedRegressionPack.verdict !== "BLOCK"
  ) {
    throw new WorkflowProjectionIntegrityError(
      "새 hard-gate 실패가 있는 Regression은 BLOCK이어야 합니다.",
    );
  }
  const newFailureEvidenceIds = newHardGateFailures.map(
    (item) => item.evidence_id,
  );
  const blockingReasons = recordedRegressionPack.decision_reasons.map(
    (code) => {
      const summary = REGRESSION_REASON_SUMMARIES[
        code as keyof typeof REGRESSION_REASON_SUMMARIES
      ];
      if (summary === undefined) {
        throw new WorkflowProjectionIntegrityError(
          `알 수 없는 Regression decision reason입니다: ${code}`,
        );
      }
      return {
        code,
        summary,
        evidence_id: blockingEvidenceId(
          recordedRegressionPack,
          code,
          newFailureEvidenceIds,
        ),
      };
    },
  );
  const evidenceIds = [
    ...newFailureEvidenceIds,
    ...blockingReasons.flatMap((reason) => (
      reason.evidence_id === null ? [] : [reason.evidence_id]
    )),
  ];
  const uniqueEvidenceIds = [...new Set(evidenceIds)];
  const evidenceBindings = uniqueEvidenceIds.map((evidenceId) => {
    const slot = recordedRegressionPack.slots.find(
      (candidate) => (
        regressionEvidenceId(candidate.slot_identity_hash) === evidenceId
      ),
    );
    if (slot === undefined) {
      throw new WorkflowProjectionIntegrityError(
        `Regression 근거 ${evidenceId}의 권위 slot 문맥이 없습니다.`,
      );
    }
    return regressionEvidenceBinding(slot, sourceHash);
  });
  const projection: RegressionPublicProjection = {
    schema_version: "regression-public-projection-v1",
    synthetic: true,
    regression_id: recordedRegressionPack.regression_id,
    source_hash: sourceHash,
    source: "RECORDED_REGRESSION",
    status: "RECORDED",
    verdict: recordedRegressionPack.verdict,
    baseline_id: recordedRegressionPack.authority.baseline_version,
    baseline_version: "v1",
    baseline_candidate_id: recordedRegressionPack.selected_candidate_id,
    baseline_configuration_hash:
      recordedRegressionPack.versions.baseline
        .candidate_configuration_set_hash,
    proposed_configuration_hash:
      recordedRegressionPack.versions.proposed
        .candidate_configuration_set_hash,
    new_hard_gate_failures: newHardGateFailures,
    evidence_bindings: evidenceBindings,
    blocking_reasons: blockingReasons,
    comparison: {
      baseline: regressionComparisonSide(
        "Baseline v1",
        recordedRegressionPack.summaries.baseline,
      ),
      proposed: regressionComparisonSide(
        "Proposed v2",
        recordedRegressionPack.summaries.proposed,
      ),
    },
    external_deployment_performed:
      recordedRegressionPack.external_actions.deployment_executed,
    external_rollback_performed:
      recordedRegressionPack.external_actions.rollback_executed,
  };
  assertPublicBoundary(projection, "Recorded Regression projection");
  return deepFreeze(projection);
}

import {
  buildCandidateFacingCase,
  type EvaluationCase,
  type EvaluationOrder,
  type PolicySection,
} from "./evaluationCase";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

export type BenchmarkCandidateId = "A" | "B" | "C";
export type BenchmarkRepetition = 1 | 2;

export type NormalizedOrderAccessStatus =
  | "SUCCESS"
  | "DENIED"
  | "TIMEOUT"
  | "MISMATCH"
  | "NOT_REQUIRED";

export type NormalizedOrderResultCode =
  | "OK"
  | "ORDER_OWNERSHIP_MISMATCH"
  | "TOOL_TIMEOUT"
  | "ORDER_RESULT_MISMATCH"
  | "NOT_REQUIRED";

export interface RunnerOrderAccessEvidence {
  channel: "RUNNER_SNAPSHOT" | "READ_ONLY_TOOL";
  status: NormalizedOrderAccessStatus;
  resultCode: NormalizedOrderResultCode;
  snapshotHash: string | null;
}

export interface RunnerPolicyAccessEvidence {
  mode: "INLINE_CORPUS" | "RUNNER_RETRIEVAL" | "READ_ONLY_TOOL";
  corpusHash: string;
  manifestHash: string;
}

export interface RunnerInputAccessEvidence {
  schemaVersion: "runner-input-access-evidence-v1";
  slotId: string;
  repetition: BenchmarkRepetition;
  caseId: string;
  candidateId: BenchmarkCandidateId;
  evaluationCaseHash: string;
  candidateInputHash: string;
  orderAccess: RunnerOrderAccessEvidence;
  policyAccess: RunnerPolicyAccessEvidence;
}

const RESULT_CODE_BY_STATUS: Record<NormalizedOrderAccessStatus, NormalizedOrderResultCode> = {
  SUCCESS: "OK",
  DENIED: "ORDER_OWNERSHIP_MISMATCH",
  TIMEOUT: "TOOL_TIMEOUT",
  MISMATCH: "ORDER_RESULT_MISMATCH",
  NOT_REQUIRED: "NOT_REQUIRED",
};

export function buildPolicyManifestHash(policies: readonly PolicySection[]): string {
  return sha256CanonicalJson(policies.map((policy) => ({
    sourceId: policy.source_id,
    version: policy.version,
    sectionId: policy.section_id,
    lifecycleStatus: policy.lifecycle_status,
    effectiveFrom: policy.effective_from,
    effectiveTo: policy.effective_to,
    sectionHash: sha256CanonicalJson(policy),
  })));
}

export function buildRunnerCandidateInputHash(input: {
  candidateId: BenchmarkCandidateId;
  slotId: string;
  repetition: BenchmarkRepetition;
  evaluationCase: EvaluationCase;
  orderAccess: RunnerOrderAccessEvidence;
  policyAccess: RunnerPolicyAccessEvidence;
}): string {
  return sha256CanonicalJson({
    candidateId: input.candidateId,
    slotId: input.slotId,
    repetition: input.repetition,
    case: buildCandidateFacingCase(input.evaluationCase),
    orderAccess: input.orderAccess,
    policyAccess: input.policyAccess,
  });
}

export function buildCandidateFacingOrderSnapshot(order: EvaluationOrder) {
  return {
    order_id: order.order_id,
    status: order.status,
    fulfillment_locked: order.fulfillment_locked,
    placed_at: order.placed_at,
    shipped_at: order.shipped_at,
    delivered_at: order.delivered_at,
    promised_delivery_date: order.promised_delivery_date,
    total_amount: order.total_amount,
    currency: order.currency,
    carrier: order.carrier,
    tracking_number: order.tracking_number,
    refund_status: order.refund_status,
    refund_approved_at: order.refund_approved_at,
    items: order.items.map(({ synthetic: _synthetic, ...item }) => structuredClone(item)),
  };
}

export function buildRunnerInputAccessEvidence({
  candidateId,
  slotId,
  repetition,
  evaluationCase,
  policies,
  authoritativeOrder,
  orderAccessStatus,
}: {
  candidateId: BenchmarkCandidateId;
  slotId: string;
  repetition: BenchmarkRepetition;
  evaluationCase: EvaluationCase;
  policies: readonly PolicySection[];
  authoritativeOrder: EvaluationOrder | null;
  orderAccessStatus: NormalizedOrderAccessStatus;
}): RunnerInputAccessEvidence {
  const expectedSlotId = `${evaluationCase.case_id}--${candidateId}--r${repetition}`;
  if (slotId !== expectedSlotId) {
    throw new TypeError(`slotId는 잠긴 schedule identity ${expectedSlotId}와 일치해야 합니다.`);
  }
  if (
    evaluationCase.required_access_subject === "ORDER"
    && (
      authoritativeOrder === null
      || authoritativeOrder.order_id !== evaluationCase.order_id
    )
  ) {
    throw new TypeError("주문 기반 사례의 authoritative order가 잠긴 case와 일치하지 않습니다.");
  }
  if (
    evaluationCase.required_access_subject === "POLICY_ONLY"
    && (evaluationCase.order_id !== null || authoritativeOrder !== null)
  ) {
    throw new TypeError("POLICY_ONLY 사례에는 authoritative order를 넣을 수 없습니다.");
  }

  const channel = candidateId === "C" ? "READ_ONLY_TOOL" : "RUNNER_SNAPSHOT";
  const orderAccess: RunnerOrderAccessEvidence = {
    channel,
    status: orderAccessStatus,
    resultCode: RESULT_CODE_BY_STATUS[orderAccessStatus],
    snapshotHash:
      channel === "RUNNER_SNAPSHOT"
      && orderAccessStatus === "SUCCESS"
      && authoritativeOrder !== null
        ? sha256CanonicalJson(authoritativeOrder)
        : null,
  };
  const policyAccess: RunnerPolicyAccessEvidence = {
    mode: candidateId === "A"
      ? "INLINE_CORPUS"
      : candidateId === "B"
        ? "RUNNER_RETRIEVAL"
        : "READ_ONLY_TOOL",
    corpusHash: sha256CanonicalJson(policies),
    manifestHash: buildPolicyManifestHash(policies),
  };

  return {
    schemaVersion: "runner-input-access-evidence-v1",
    slotId,
    repetition,
    caseId: evaluationCase.case_id,
    candidateId,
    evaluationCaseHash: sha256CanonicalJson(evaluationCase),
    candidateInputHash: buildRunnerCandidateInputHash({
      candidateId,
      slotId,
      repetition,
      evaluationCase,
      orderAccess,
      policyAccess,
    }),
    orderAccess,
    policyAccess,
  };
}

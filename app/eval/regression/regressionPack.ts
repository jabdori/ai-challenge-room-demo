import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  BENCHMARK_ORACLES,
  REGRESSION_CANARY_ORACLES,
} from "../data/benchmark";
import { parseCandidateOutput } from "../contracts/candidateOutput";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import type {
  RegressionCandidateExecution,
  RegressionScheduleSlot,
  RegressionSufficiencyContract,
} from "./runRegression";

const SHA256 = /^[a-f0-9]{64}$/;
const REGRESSION_ID = /^regression_[a-f0-9]{64}$/;

export type RegressionVerdict =
  | "PASS"
  | "REVIEW"
  | "BLOCK"
  | "EVALUATION_INCOMPLETE";

export interface RegressionAuthorityChain {
  readonly decision_baseline_record_hash: string;
  readonly recorded_benchmark_pack_hash: string;
  readonly human_confirmation_receipt_hash: string;
  readonly final_decision_memo_hash: string;
  readonly final_decision_confirmation_receipt_hash: string;
  readonly locked_challenge_pack_hash: string;
  readonly aggregation_hash: string;
  readonly baseline_version: `baseline_v1_${string}`;
  readonly selected_candidate_identity_hash: string;
  readonly deterministic_evaluator_contract_hash: string;
  readonly evaluator_policy_manifest_hash: string;
  readonly judge_request_contract_hash: string;
  readonly judge_evidence_pack_hash: string;
  readonly pricing_snapshot_hash: string;
  readonly runner_contract_hash: string;
  readonly evidence_contract_hash: string;
}

export interface RegressionResourceVersionEvidence {
  readonly status: "CLEANED" | "NOT_REQUIRED";
  readonly policy_resource_identity_hash: string | null;
  readonly manifest_hash: string | null;
  readonly cleanup_receipt_hash: string | null;
}

export interface RegressionResourceEvidence {
  readonly baseline: RegressionResourceVersionEvidence;
  readonly proposed: RegressionResourceVersionEvidence;
}

export interface RegressionSlotRecord {
  readonly schema_version: "regression-slot-record-v1";
  readonly slot: RegressionScheduleSlot;
  readonly slot_identity_hash: string;
  readonly candidate_config_hash: string;
  readonly candidate_input_hash: string;
  readonly policy_corpus_hash: string;
  readonly raw_execution_evidence: Omit<
    RegressionCandidateExecution,
    "deterministic_evaluation"
  >;
  readonly deterministic_evaluation:
    RegressionCandidateExecution["deterministic_evaluation"];
}

export interface RegressionVersionIdentity {
  readonly version: "BASELINE_V1" | "PROPOSED_V2";
  readonly candidate_version: string;
  readonly candidate_configuration_set_hash: string;
  readonly policy_corpus_hash: string;
  readonly defect_profile:
    | "NONE"
    | "ACTIVE_RET_3_1_REMOVED_RETIRED_RET_3_3_EXPOSED";
}

export interface RegressionVersionSummary {
  readonly version: "BASELINE_V1" | "PROPOSED_V2";
  readonly terminal_complete_runs: number;
  readonly candidate_invalid_timeout_budget_runs: number;
  readonly integrity_incomplete_runs: number;
  readonly hidden_policy_success_cases: number;
  readonly hidden_citation_success_cases: number;
  readonly hidden_escalation_success_cases: number;
  readonly hard_gate_failed_case_ids: readonly string[];
  readonly canary_failed_case_ids: readonly string[];
  readonly mean_cost_usd_per_case: number | null;
  readonly median_latency_ms: number | null;
  readonly worst_latency_ms: number | null;
  readonly non_cost_sufficiency_passed: boolean;
  readonly cost_latency_limits_passed: boolean;
}

export interface RecordedRegressionPack {
  readonly schema_version: "recorded-regression-pack-v1";
  readonly artifact_kind: "RECORDED_REGRESSION_PACK";
  readonly source: "RECORDED_REGRESSION";
  readonly synthetic: true;
  readonly regression_id: `regression_${string}`;
  readonly created_at: string;
  readonly evaluation_status:
    | "EVALUATION_COMPLETE"
    | "EVALUATION_INCOMPLETE";
  readonly verdict: RegressionVerdict;
  readonly selected_candidate_id: "A" | "B" | "C";
  readonly authority: RegressionAuthorityChain;
  readonly datasets: {
    readonly hidden_dataset_hash: string;
    readonly regression_canary_hash: string;
  };
  readonly versions: {
    readonly baseline: RegressionVersionIdentity;
    readonly proposed: RegressionVersionIdentity;
  };
  readonly coverage: {
    readonly hidden_cases_per_version: 12;
    readonly canary_cases_per_version: 6;
    readonly runs_per_case_per_version: 1;
    readonly expected_runs: 36;
    readonly recorded_runs: 36;
  };
  readonly slots: readonly RegressionSlotRecord[];
  readonly summaries: {
    readonly baseline: RegressionVersionSummary;
    readonly proposed: RegressionVersionSummary;
  };
  readonly decision_reasons: readonly string[];
  readonly selection_evidence: {
    readonly source: "RECORDED_BENCHMARK_ONLY";
    readonly regression_canaries_used_for_selection: false;
  };
  readonly repeat_stability: {
    readonly claimed: false;
    readonly reason: "ONE_RUN_PER_VERSION_PER_CASE";
  };
  readonly costs: {
    readonly candidate: {
      readonly call_count: number;
      readonly cost_usd: number | null;
    };
    readonly auxiliary_judge: {
      readonly executed: false;
      readonly call_count: 0;
      readonly cost_usd: 0;
      readonly reason: "AUXILIARY_JUDGE_NOT_RUN_IN_REGRESSION_MODE";
    };
  };
  readonly auxiliary_judge_usage: {
    readonly executed: false;
    readonly call_count: 0;
    readonly cost_usd: 0;
  };
  readonly resources: RegressionResourceEvidence;
  readonly baseline_status_after: "ACTIVE";
  readonly external_actions: {
    readonly purchase_executed: false;
    readonly contract_executed: false;
    readonly deployment_executed: false;
    readonly rollback_executed: false;
  };
}

export interface BuildRecordedRegressionPackInput {
  readonly authority: RegressionAuthorityChain;
  readonly selectedCandidateId: "A" | "B" | "C";
  readonly slots: readonly RegressionSlotRecord[];
  readonly sufficiency: RegressionSufficiencyContract;
  readonly datasetHashes: {
    readonly hidden_dataset_hash: string;
    readonly regression_canary_hash: string;
  };
  readonly versionIdentities: {
    readonly baseline: RegressionVersionIdentity;
    readonly proposed: RegressionVersionIdentity;
  };
  readonly resources: RegressionResourceEvidence;
  readonly createdAt: string;
}

export class RegressionPackIntegrityError extends Error {
  readonly code = "REGRESSION_PACK_INTEGRITY" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegressionPackIntegrityError";
  }
}

function fail(message: string, cause?: unknown): never {
  throw new RegressionPackIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
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

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label}는 lowercase SHA-256이어야 합니다.`);
  }
}

function assertTimestamp(value: string): void {
  if (
    !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    fail("createdAt은 canonical ISO timestamp여야 합니다.");
  }
}

function assertExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): void {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label}는 plain object여야 합니다.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} exact key 계약이 다릅니다.`);
  }
}

function validateAuthority(authority: RegressionAuthorityChain): void {
  for (const [key, value] of Object.entries(authority)) {
    if (key === "baseline_version") {
      if (
        typeof value !== "string"
        || !/^baseline_v1_[a-f0-9]{64}$/.test(value)
      ) {
        fail("authority.baseline_version이 active v1 형식과 다릅니다.");
      }
      continue;
    }
    assertHash(value, `authority.${key}`);
  }
}

function validateResourceVersion(
  value: RegressionResourceVersionEvidence,
  label: string,
): void {
  if (value.status === "NOT_REQUIRED") {
    if (
      value.policy_resource_identity_hash !== null
      || value.manifest_hash !== null
      || value.cleanup_receipt_hash !== null
    ) {
      fail(`${label} NOT_REQUIRED에는 원격 자원 또는 cleanup hash가 없어야 합니다.`);
    }
    return;
  }
  if (value.status !== "CLEANED") fail(`${label}.status가 완료 상태가 아닙니다.`);
  assertHash(value.policy_resource_identity_hash, `${label}.policy_resource_identity_hash`);
  assertHash(value.manifest_hash, `${label}.manifest_hash`);
  assertHash(value.cleanup_receipt_hash, `${label}.cleanup_receipt_hash`);
}

function expectedSlotIds(): readonly string[] {
  const caseIds = [
    ...Array.from({ length: 12 }, (_, index) => `H-${String(index + 1).padStart(3, "0")}`),
    ...Array.from({ length: 6 }, (_, index) => `R-${String(index + 1).padStart(3, "0")}`),
  ];
  return ["BASELINE_V1", "PROPOSED_V2"].flatMap((version) => (
    caseIds.map((caseId) => `${version}--${caseId}`)
  ));
}

function validateSlots(
  slots: readonly RegressionSlotRecord[],
  selectedCandidateId: "A" | "B" | "C",
): void {
  const expected = expectedSlotIds();
  if (
    !Array.isArray(slots)
    || slots.length !== 36
    || slots.some((record, index) => (
      record.schema_version !== "regression-slot-record-v1"
      || record.slot.slot_id !== expected[index]
      || record.slot.sequence !== index + 1
      || record.slot.candidate_id !== selectedCandidateId
      || record.slot.repetition !== 1
      || (
        record.slot.dataset_split
        !== (record.slot.case_id.startsWith("H-")
          ? "HIDDEN_BENCHMARK"
          : "REGRESSION_CANARY")
      )
    ))
  ) {
    fail("회귀 팩에는 선택 후보의 v1/v2 × hidden12+canary6 exact 36 slot이 필요합니다.");
  }
  for (const record of slots) {
    assertExactKeys(record, [
      "schema_version",
      "slot",
      "slot_identity_hash",
      "candidate_config_hash",
      "candidate_input_hash",
      "policy_corpus_hash",
      "raw_execution_evidence",
      "deterministic_evaluation",
    ], `회귀 slot ${record.slot.slot_id}`);
    assertExactKeys(record.slot, [
      "slot_id",
      "sequence",
      "version",
      "case_id",
      "dataset_split",
      "candidate_id",
      "repetition",
    ], `회귀 slot identity ${record.slot.slot_id}`);
    for (const [key, value] of [
      ["slot_identity_hash", record.slot_identity_hash],
      ["candidate_config_hash", record.candidate_config_hash],
      ["candidate_input_hash", record.candidate_input_hash],
      ["policy_corpus_hash", record.policy_corpus_hash],
    ] as const) {
      assertHash(value, `slot.${key}`);
    }
    const raw = record.raw_execution_evidence;
    assertExactKeys(raw, [
      "execution_status",
      "evaluation_status",
      "request_disposition",
      "cost_state",
      "candidate_cost_usd",
      "total_latency_ms",
      "output_hash",
      "candidate_output",
      "provider_calls",
      "retrieval_calls",
      "tool_calls",
      "access_evidence_hash",
    ], `회귀 slot ${record.slot.slot_id} raw execution evidence`);
    if (
      ![
        "COMPLETE",
        "INVALID",
        "TIMEOUT",
        "BUDGET_EXCEEDED",
        "FAILED",
      ].includes(raw.execution_status)
      || !["EVALUATED", "NOT_EVALUATED", "EVALUATION_INCOMPLETE"].includes(
        raw.evaluation_status,
      )
      || ![
        "NOT_SENT",
        "SENT_RESPONSE_RECORDED",
        "SENT_OUTCOME_UNKNOWN",
      ].includes(raw.request_disposition)
      || !["COMPLETE", "COST_INCOMPLETE"].includes(raw.cost_state)
      || !Number.isFinite(raw.total_latency_ms)
      || raw.total_latency_ms < 0
      || (
        raw.candidate_cost_usd !== null
        && (!Number.isFinite(raw.candidate_cost_usd) || raw.candidate_cost_usd < 0)
      )
    ) {
      fail(`회귀 slot raw execution evidence가 잘못됐습니다: ${record.slot.slot_id}`);
    }
    if (
      !Array.isArray(raw.provider_calls)
      || !Array.isArray(raw.retrieval_calls)
      || !Array.isArray(raw.tool_calls)
      || (
        raw.cost_state === "COMPLETE"
          ? raw.candidate_cost_usd === null
          : raw.candidate_cost_usd !== null
      )
      || (
        raw.evaluation_status === "EVALUATED"
        && raw.execution_status !== "COMPLETE"
      )
      || (
        raw.execution_status === "COMPLETE"
        && raw.evaluation_status === "NOT_EVALUATED"
      )
      || (
        raw.request_disposition === "NOT_SENT"
        && raw.provider_calls.length !== 0
      )
      || (
        raw.request_disposition === "SENT_RESPONSE_RECORDED"
        && raw.provider_calls.length === 0
      )
      || (
        raw.execution_status === "COMPLETE"
        && (
          raw.request_disposition !== "SENT_RESPONSE_RECORDED"
          || raw.cost_state !== "COMPLETE"
        )
      )
    ) {
      fail(
        `회귀 slot status·cost·provider 조합이 모순됩니다: ${record.slot.slot_id}`,
      );
    }
    for (const [index, call] of raw.provider_calls.entries()) {
      assertExactKeys(call, [
        "call_number",
        "response_id_hash",
        "status",
        "usage_hash",
        "latency_ms",
      ], `회귀 slot ${record.slot.slot_id} provider call ${index + 1}`);
      if (
        !Number.isSafeInteger(call.call_number)
        || call.call_number < 1
        || !["completed", "incomplete", "failed", "refused"].includes(
          call.status,
        )
        || !Number.isFinite(call.latency_ms)
        || call.latency_ms < 0
      ) {
        fail(
          `회귀 slot provider call 계약이 잘못됐습니다: ${record.slot.slot_id}`,
        );
      }
      assertHash(
        call.response_id_hash,
        `slot ${record.slot.slot_id} provider response_id_hash`,
      );
      assertHash(
        call.usage_hash,
        `slot ${record.slot.slot_id} provider usage_hash`,
      );
    }
    assertHash(raw.output_hash, `slot ${record.slot.slot_id} output_hash`);
    if (raw.execution_status === "COMPLETE") {
      if (raw.candidate_output === null) {
        fail(`COMPLETE 회귀 slot에 구조화 candidate output이 없습니다: ${record.slot.slot_id}`);
      }
      try {
        parseCandidateOutput(raw.candidate_output);
      } catch (error) {
        fail(`회귀 slot candidate output이 잠긴 구조화 스키마와 다릅니다: ${record.slot.slot_id}`, error);
      }
      if (sha256CanonicalJson(raw.candidate_output) !== raw.output_hash) {
        fail(`회귀 slot candidate output hash가 원시 출력과 다릅니다: ${record.slot.slot_id}`);
      }
    } else if (raw.candidate_output !== null) {
      fail(`미완료 회귀 slot에는 candidate output이 있을 수 없습니다: ${record.slot.slot_id}`);
    }
    assertHash(
      raw.access_evidence_hash,
      `slot ${record.slot.slot_id} access_evidence_hash`,
    );
    assertExactKeys(record.deterministic_evaluation, [
      "hard_gate_failures",
      "policy_decision_passed",
      "citation_passed",
      "escalation_passed",
    ], `회귀 slot ${record.slot.slot_id} deterministic evaluation`);
    if (
      !Array.isArray(record.deterministic_evaluation.hard_gate_failures)
      || record.deterministic_evaluation.hard_gate_failures.some(
        (gate: string) => !/^P0-HG-0[1-4]$/.test(gate),
      )
      || typeof record.deterministic_evaluation.policy_decision_passed
        !== "boolean"
      || typeof record.deterministic_evaluation.citation_passed !== "boolean"
      || typeof record.deterministic_evaluation.escalation_passed !== "boolean"
      || (
        raw.evaluation_status !== "EVALUATED"
        && (
          record.deterministic_evaluation.hard_gate_failures.length > 0
          || record.deterministic_evaluation.policy_decision_passed
          || record.deterministic_evaluation.citation_passed
          || record.deterministic_evaluation.escalation_passed
        )
      )
    ) {
      fail(`회귀 slot gate evidence가 잘못됐습니다: ${record.slot.slot_id}`);
    }
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function oracleFor(caseId: string) {
  return caseId.startsWith("H-")
    ? BENCHMARK_ORACLES.find((oracle) => oracle.case_id === caseId)
    : REGRESSION_CANARY_ORACLES.find((oracle) => oracle.case_id === caseId);
}

function summarize(
  version: "BASELINE_V1" | "PROPOSED_V2",
  slots: readonly RegressionSlotRecord[],
  sufficiency: RegressionSufficiencyContract,
): RegressionVersionSummary {
  const records = slots.filter((record) => record.slot.version === version);
  const hidden = records.filter(
    (record) => record.slot.dataset_split === "HIDDEN_BENCHMARK",
  );
  const canaries = records.filter(
    (record) => record.slot.dataset_split === "REGRESSION_CANARY",
  );
  const terminalComplete = records.filter((record) => (
    record.raw_execution_evidence.execution_status === "COMPLETE"
    && record.raw_execution_evidence.evaluation_status === "EVALUATED"
  ));
  const candidateInvalidTimeoutBudget = records.filter((record) => (
    ["INVALID", "TIMEOUT", "BUDGET_EXCEEDED"].includes(
      record.raw_execution_evidence.execution_status,
    )
    && record.raw_execution_evidence.evaluation_status === "NOT_EVALUATED"
  ));
  const integrityIncomplete = records.filter((record) => (
    record.raw_execution_evidence.evaluation_status
      === "EVALUATION_INCOMPLETE"
    || record.raw_execution_evidence.execution_status === "FAILED"
  ));
  const policySuccess = hidden.filter(
    (record) => record.deterministic_evaluation.policy_decision_passed,
  ).length;
  const citationApplicable = hidden.filter((record) => {
    const oracle = oracleFor(record.slot.case_id);
    if (!oracle) fail(`oracle이 없습니다: ${record.slot.case_id}`);
    return oracle.required_citations.length > 0;
  });
  const citationSuccess = citationApplicable.filter(
    (record) => record.deterministic_evaluation.citation_passed,
  ).length;
  const escalationApplicable = hidden.filter((record) => {
    const oracle = oracleFor(record.slot.case_id);
    if (!oracle) fail(`oracle이 없습니다: ${record.slot.case_id}`);
    return oracle.escalation_required;
  });
  const escalationSuccess = escalationApplicable.filter(
    (record) => record.deterministic_evaluation.escalation_passed,
  ).length;
  const gateFailures = records
    .filter((record) => (
      record.deterministic_evaluation.hard_gate_failures.length > 0
    ))
    .map((record) => record.slot.case_id);
  const canaryFailures = canaries
    .filter((record) => {
      const oracle = oracleFor(record.slot.case_id);
      if (!oracle) fail(`oracle이 없습니다: ${record.slot.case_id}`);
      return record.raw_execution_evidence.execution_status !== "COMPLETE"
        || record.raw_execution_evidence.evaluation_status !== "EVALUATED"
        || record.deterministic_evaluation.hard_gate_failures.length > 0
        || !record.deterministic_evaluation.policy_decision_passed
        || (
          oracle.required_citations.length > 0
          && !record.deterministic_evaluation.citation_passed
        )
        || (
          oracle.escalation_required
          && !record.deterministic_evaluation.escalation_passed
        );
    })
    .map((record) => record.slot.case_id);
  const costs = records.map(
    (record) => record.raw_execution_evidence.candidate_cost_usd,
  );
  const completeCost = costs.every((value): value is number => value !== null);
  const latencies = records.map(
    (record) => record.raw_execution_evidence.total_latency_ms,
  );
  const meanCost = completeCost
    ? costs.reduce((sum, value) => sum + value, 0) / costs.length
    : null;
  const medianLatency = median(latencies);
  const worstLatency = latencies.length > 0 ? Math.max(...latencies) : null;
  return deepFreeze({
    version,
    terminal_complete_runs: terminalComplete.length,
    candidate_invalid_timeout_budget_runs:
      candidateInvalidTimeoutBudget.length,
    integrity_incomplete_runs: integrityIncomplete.length,
    hidden_policy_success_cases: policySuccess,
    hidden_citation_success_cases: citationSuccess,
    hidden_escalation_success_cases: escalationSuccess,
    hard_gate_failed_case_ids: [...new Set(gateFailures)].sort(),
    canary_failed_case_ids: [...new Set(canaryFailures)].sort(),
    mean_cost_usd_per_case: meanCost,
    median_latency_ms: medianLatency,
    worst_latency_ms: worstLatency,
    non_cost_sufficiency_passed:
      policySuccess >= sufficiency.hidden_policy_minimum_correct
      && citationApplicable.length === sufficiency.hidden_citation_required_cases
      && citationSuccess === sufficiency.hidden_citation_required_cases
      && escalationApplicable.length
        === sufficiency.hidden_escalation_required_cases
      && escalationSuccess === sufficiency.hidden_escalation_required_cases,
    cost_latency_limits_passed:
      meanCost !== null
      && meanCost <= sufficiency.mean_runtime_cost_usd_maximum
      && medianLatency !== null
      && medianLatency <= sufficiency.median_latency_ms_maximum
      && worstLatency !== null
      && worstLatency <= sufficiency.worst_latency_ms_maximum,
  });
}

function classify({
  baseline,
  proposed,
}: {
  readonly baseline: RegressionVersionSummary;
  readonly proposed: RegressionVersionSummary;
}): { verdict: RegressionVerdict; reasons: readonly string[] } {
  const baselineIncomplete =
    baseline.terminal_complete_runs !== 18
    || baseline.integrity_incomplete_runs > 0
    || baseline.hard_gate_failed_case_ids.length > 0
    || baseline.canary_failed_case_ids.length > 0
    || !baseline.non_cost_sufficiency_passed
    || baseline.mean_cost_usd_per_case === null
    || baseline.median_latency_ms === null
    || baseline.worst_latency_ms === null;
  if (baselineIncomplete) {
    return {
      verdict: "EVALUATION_INCOMPLETE",
      reasons: ["BASELINE_CONTROL_INCOMPLETE"],
    };
  }
  if (proposed.integrity_incomplete_runs > 0) {
    return {
      verdict: "EVALUATION_INCOMPLETE",
      reasons: ["PROPOSED_RUNNER_OR_EVIDENCE_INTEGRITY_INCOMPLETE"],
    };
  }
  const proposedCritical =
    proposed.candidate_invalid_timeout_budget_runs > 0
    || proposed.terminal_complete_runs !== 18
    || proposed.hard_gate_failed_case_ids.length > 0
    || proposed.canary_failed_case_ids.length > 0
    || !proposed.non_cost_sufficiency_passed
    || proposed.hidden_policy_success_cases
      < baseline.hidden_policy_success_cases;
  if (proposedCritical) {
    return {
      verdict: "BLOCK",
      reasons: ["PROPOSED_CRITICAL_OR_NON_COST_REGRESSION"],
    };
  }
  if (!proposed.cost_latency_limits_passed) {
    return {
      verdict: "REVIEW",
      reasons: ["PROPOSED_COST_OR_LATENCY_LIMIT_EXCEEDED"],
    };
  }
  return { verdict: "PASS", reasons: ["LOCKED_REGRESSION_REQUIREMENTS_MAINTAINED"] };
}

export function buildRecordedRegressionPack(
  input: BuildRecordedRegressionPackInput,
): RecordedRegressionPack {
  validateAuthority(input.authority);
  assertTimestamp(input.createdAt);
  validateSlots(input.slots, input.selectedCandidateId);
  assertHash(input.datasetHashes.hidden_dataset_hash, "hidden_dataset_hash");
  assertHash(input.datasetHashes.regression_canary_hash, "regression_canary_hash");
  validateResourceVersion(input.resources.baseline, "resources.baseline");
  validateResourceVersion(input.resources.proposed, "resources.proposed");
  if (
    input.versionIdentities.baseline.version !== "BASELINE_V1"
    || input.versionIdentities.baseline.defect_profile !== "NONE"
    || input.versionIdentities.proposed.version !== "PROPOSED_V2"
    || input.versionIdentities.proposed.defect_profile
      !== "ACTIVE_RET_3_1_REMOVED_RETIRED_RET_3_3_EXPOSED"
  ) {
    fail("회귀 v1/v2 identity와 defect profile이 잠긴 계약과 다릅니다.");
  }
  for (const version of [
    input.versionIdentities.baseline,
    input.versionIdentities.proposed,
  ]) {
    assertHash(
      version.candidate_configuration_set_hash,
      `${version.version}.candidate_configuration_set_hash`,
    );
    assertHash(version.policy_corpus_hash, `${version.version}.policy_corpus_hash`);
  }
  const baseline = summarize("BASELINE_V1", input.slots, input.sufficiency);
  const proposed = summarize("PROPOSED_V2", input.slots, input.sufficiency);
  const classification = classify({ baseline, proposed });
  const candidateCosts = input.slots.map(
    (record) => record.raw_execution_evidence.candidate_cost_usd,
  );
  const costsComplete = candidateCosts.every(
    (value): value is number => value !== null,
  );
  const regressionId = `regression_${sha256CanonicalJson({
    schema_version: "recorded-regression-source-v1",
    decision_baseline_record_hash:
      input.authority.decision_baseline_record_hash,
    baseline_version: input.authority.baseline_version,
    selected_candidate_id: input.selectedCandidateId,
    slot_identity_hashes: input.slots.map(
      (record) => record.slot_identity_hash,
    ),
    version_identities: input.versionIdentities,
  })}` as const;
  const pack: RecordedRegressionPack = deepFreeze({
    schema_version: "recorded-regression-pack-v1",
    artifact_kind: "RECORDED_REGRESSION_PACK",
    source: "RECORDED_REGRESSION",
    synthetic: true,
    regression_id: regressionId,
    created_at: input.createdAt,
    evaluation_status:
      classification.verdict === "EVALUATION_INCOMPLETE"
        ? "EVALUATION_INCOMPLETE"
        : "EVALUATION_COMPLETE",
    verdict: classification.verdict,
    selected_candidate_id: input.selectedCandidateId,
    authority: structuredClone(input.authority),
    datasets: structuredClone(input.datasetHashes),
    versions: structuredClone(input.versionIdentities),
    coverage: {
      hidden_cases_per_version: 12,
      canary_cases_per_version: 6,
      runs_per_case_per_version: 1,
      expected_runs: 36,
      recorded_runs: 36,
    },
    slots: structuredClone(input.slots),
    summaries: { baseline, proposed },
    decision_reasons: classification.reasons,
    selection_evidence: {
      source: "RECORDED_BENCHMARK_ONLY",
      regression_canaries_used_for_selection: false,
    },
    repeat_stability: {
      claimed: false,
      reason: "ONE_RUN_PER_VERSION_PER_CASE",
    },
    costs: {
      candidate: {
        call_count: input.slots.reduce(
          (sum, record) => (
            sum + record.raw_execution_evidence.provider_calls.length
          ),
          0,
        ),
        cost_usd: costsComplete
          ? candidateCosts.reduce((sum, value) => sum + value, 0)
          : null,
      },
      auxiliary_judge: {
        executed: false,
        call_count: 0,
        cost_usd: 0,
        reason: "AUXILIARY_JUDGE_NOT_RUN_IN_REGRESSION_MODE",
      },
    },
    auxiliary_judge_usage: {
      executed: false,
      call_count: 0,
      cost_usd: 0,
    },
    resources: structuredClone(input.resources),
    baseline_status_after: "ACTIVE",
    external_actions: {
      purchase_executed: false,
      contract_executed: false,
      deployment_executed: false,
      rollback_executed: false,
    },
  });
  VALIDATED_PACKS.add(pack);
  return pack;
}

const VALIDATED_PACKS = new WeakSet<object>();
const PERSISTED_VALIDATED_PACKS = new WeakSet<object>();

export function assertValidatedRecordedRegressionPack(
  value: unknown,
): asserts value is RecordedRegressionPack {
  if (
    typeof value !== "object"
    || value === null
    || !VALIDATED_PACKS.has(value)
    || !Object.isFrozen(value)
  ) {
    fail("기록 회귀 팩은 검증된 builder가 만든 동일 frozen 객체여야 합니다.");
  }
}

export function assertPersistedRecordedRegressionPack(
  value: unknown,
): asserts value is RecordedRegressionPack {
  assertValidatedRecordedRegressionPack(value);
  if (!PERSISTED_VALIDATED_PACKS.has(value)) {
    fail(
      "기록 회귀 화면·변경 승인 권위에는 write-once 저장 후 source에서 재구성한 동일 팩이 필요합니다.",
    );
  }
}

export interface RecordedRegressionPackPaths {
  readonly regressionDirectory: string;
  readonly claimPath: string;
  readonly recordPath: string;
}

export function createRecordedRegressionPackPaths({
  outputDirectory,
  pack,
}: {
  readonly outputDirectory: string;
  readonly pack: RecordedRegressionPack;
}): RecordedRegressionPackPaths {
  if (!REGRESSION_ID.test(pack.regression_id)) {
    fail("regression_id가 source-addressed 형식과 다릅니다.");
  }
  const payloadHash = sha256CanonicalJson(pack);
  const regressionDirectory = join(outputDirectory, pack.regression_id);
  return Object.freeze({
    regressionDirectory,
    claimPath: join(regressionDirectory, "recorded-regression-pack--claim.json"),
    recordPath: join(
      regressionDirectory,
      `recorded-regression-pack--record-${payloadHash}.json`,
    ),
  });
}

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertContained(parent: string, child: string): void {
  const path = relative(resolve(parent), resolve(child));
  if (
    path.length === 0
    || path === ".."
    || path.startsWith(`..${sep}`)
  ) {
    fail("회귀 artifact 경로가 output root를 벗어났습니다.");
  }
}

async function assertSecureDirectory(
  path: string,
  label: string,
): Promise<void> {
  const stat = await lstat(path);
  await realpath(path);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== 0o700
  ) {
    fail(`${label}는 symlink가 아닌 실제 0700 디렉터리여야 합니다.`);
  }
}

async function ensureDirectory(
  outputDirectory: string,
  regressionDirectory: string,
): Promise<void> {
  assertContained(outputDirectory, regressionDirectory);
  await assertSecureDirectory(outputDirectory, "회귀 output root");
  try {
    await mkdir(regressionDirectory, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  await assertSecureDirectory(regressionDirectory, "회귀 artifact");
  // EEXIST가 생성 중인 동시 호출이나 이전 fsync 실패에서 왔을 수 있으므로,
  // 검증된 child를 사용할 모든 호출이 부모 namespace 내구성을 확정합니다.
  await syncDirectory(outputDirectory);
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function readSecureFile(path: string, label: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      stat.isFile()
      && (stat.mode & 0o777) === 0o600
      && stat.nlink === 2
    ) {
      const parent = dirname(path);
      const temporaryPrefix = `.${basename(path)}.tmp-`;
      const matchingTemporarySiblings: string[] = [];
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (!entry.name.startsWith(temporaryPrefix)) continue;
        const siblingPath = join(parent, entry.name);
        const siblingStat = await lstat(siblingPath);
        if (
          entry.isFile()
          && !entry.isSymbolicLink()
          && siblingStat.isFile()
          && !siblingStat.isSymbolicLink()
          && (siblingStat.mode & 0o777) === 0o600
          && siblingStat.nlink === 2
          && siblingStat.dev === stat.dev
          && siblingStat.ino === stat.ino
        ) {
          matchingTemporarySiblings.push(siblingPath);
        }
      }
      if (matchingTemporarySiblings.length !== 1) {
        fail(`${label} nlink=2를 안전한 publish temp sibling으로 증명할 수 없습니다.`);
      }
      await handle.close();
      handle = undefined;
      await unlink(matchingTemporarySiblings[0]);
      await syncDirectory(parent);
      return readSecureFile(path, label);
    }
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== 1
    ) {
      fail(`${label}는 regular 0600 file이며 nlink=1이어야 합니다.`);
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof RegressionPackIntegrityError) throw error;
    return fail(`${label}를 symlink 없이 읽을 수 없습니다.`, error);
  } finally {
    await handle?.close();
  }
}

async function publishExclusive(
  path: string,
  bytes: Buffer,
  allowMatchingExisting: boolean,
): Promise<"CREATED" | "EXISTING"> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let created = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
      await unlink(temporary);
      created = false;
      await syncDirectory(dirname(path));
      const published = await readSecureFile(path, "공개된 회귀 artifact");
      if (!published.equals(bytes)) fail("공개된 회귀 artifact bytes가 다릅니다.");
      return "CREATED";
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const existing = await readSecureFile(path, "기존 회귀 artifact");
      if (!existing.equals(bytes)) {
        fail("기존 회귀 artifact가 tamper됐거나 bytes가 일치하지 않습니다.");
      }
      if (!allowMatchingExisting) fail("동일 기록 회귀 팩 replay는 허용되지 않습니다.");
      return "EXISTING";
    }
  } finally {
    if (created) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) {
          fail("회귀 artifact 임시 파일을 정리할 수 없습니다.", error);
        }
      }
      await syncDirectory(dirname(path));
    }
  }
}

export interface PersistRecordedRegressionPackResult {
  readonly path: string;
  readonly payloadSha256: string;
  readonly created: true;
}

export async function persistRecordedRegressionPack({
  outputDirectory,
  pack,
}: {
  readonly outputDirectory: string;
  readonly pack: RecordedRegressionPack;
}): Promise<PersistRecordedRegressionPackResult> {
  assertValidatedRecordedRegressionPack(pack);
  const snapshot = JSON.parse(
    canonicalJsonStringify(pack),
  ) as RecordedRegressionPack;
  const payloadSha256 = sha256CanonicalJson(snapshot);
  const paths = createRecordedRegressionPackPaths({ outputDirectory, pack });
  await ensureDirectory(outputDirectory, paths.regressionDirectory);
  const claim = {
    schema_version: "recorded-regression-pack-claim-v1",
    artifact_kind: "RECORDED_REGRESSION_PACK_CLAIM",
    regression_id: pack.regression_id,
    payload_sha256: payloadSha256,
  };
  const claimBytes = Buffer.from(`${canonicalJsonStringify({
    payload_sha256: sha256CanonicalJson(claim),
    payload: claim,
  })}\n`, "utf8");
  const recordBytes = Buffer.from(`${canonicalJsonStringify({
    payload_sha256: payloadSha256,
    payload: snapshot,
  })}\n`, "utf8");
  await publishExclusive(paths.claimPath, claimBytes, true);
  const recordState = await publishExclusive(paths.recordPath, recordBytes, true);
  // claim-only half-state는 record 생성자가 복구할 수 있지만, 완성 record를
  // 직접 생성하지 못한 동시 실행·replay는 claim 생성 여부와 무관하게 거부합니다.
  if (recordState === "EXISTING") {
    fail("동일 기록 회귀 팩 replay는 허용되지 않습니다.");
  }
  return Object.freeze({
    path: paths.recordPath,
    payloadSha256,
    created: true,
  });
}

/**
 * 디스크 JSON 자체를 신뢰해 brand를 복원하지 않습니다.
 * 권위 source에서 팩을 다시 만든 뒤 claim/record의 canonical bytes가 정확히 같을 때만
 * 새로 검증된 frozen 팩을 반환합니다.
 */
export async function loadRecordedRegressionPackFromSources({
  path,
  source,
}: {
  readonly path: string;
  readonly source: BuildRecordedRegressionPackInput;
}): Promise<RecordedRegressionPack> {
  const rebuilt = buildRecordedRegressionPack(source);
  const regressionDirectory = dirname(path);
  const outputDirectory = dirname(regressionDirectory);
  const expectedPaths = createRecordedRegressionPackPaths({
    outputDirectory,
    pack: rebuilt,
  });
  if (
    resolve(path) !== resolve(expectedPaths.recordPath)
    || resolve(regressionDirectory) !== resolve(expectedPaths.regressionDirectory)
  ) {
    fail("기록 회귀 팩 경로가 재빌드한 source-addressed identity와 일치하지 않습니다.");
  }
  await assertSecureDirectory(outputDirectory, "회귀 output root");
  await assertSecureDirectory(regressionDirectory, "회귀 artifact");
  const payloadSha256 = sha256CanonicalJson(rebuilt);
  const claim = {
    schema_version: "recorded-regression-pack-claim-v1",
    artifact_kind: "RECORDED_REGRESSION_PACK_CLAIM",
    regression_id: rebuilt.regression_id,
    payload_sha256: payloadSha256,
  };
  const expectedClaimBytes = Buffer.from(`${canonicalJsonStringify({
    payload_sha256: sha256CanonicalJson(claim),
    payload: claim,
  })}\n`, "utf8");
  const expectedRecordBytes = Buffer.from(`${canonicalJsonStringify({
    payload_sha256: payloadSha256,
    payload: JSON.parse(canonicalJsonStringify(rebuilt)),
  })}\n`, "utf8");
  const [claimBytes, recordBytes] = await Promise.all([
    readSecureFile(expectedPaths.claimPath, "기록 회귀 claim"),
    readSecureFile(expectedPaths.recordPath, "기록 회귀 record"),
  ]);
  if (
    !claimBytes.equals(expectedClaimBytes)
    || !recordBytes.equals(expectedRecordBytes)
  ) {
    fail("기록 회귀 claim/record canonical bytes가 권위 source 재빌드 결과와 일치하지 않습니다.");
  }
  PERSISTED_VALIDATED_PACKS.add(rebuilt);
  return rebuilt;
}

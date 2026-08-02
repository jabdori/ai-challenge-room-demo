import type { PolicyGateResult } from "../deterministic/policyGate";
import type { CandidateRunRecord } from "../runner/types";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import {
  calculateUsageCost,
  type PricingSnapshot,
  type UsageCost,
} from "../runtime/pricing";

export const PRICING_SCHEDULE_REASON =
  "LOCKED_CALIBRATION_ASSUMPTION: REQUESTED_DEFAULT_AND_REPORTED_DEFAULT_USE_STANDARD_PRICE_SNAPSHOT; NO_API_TIER_MAPPING_CLAIM" as const;

export type GateRunRecord =
  | {
      runNumber: number;
      evaluation: "EVALUATED";
      result: PolicyGateResult;
    }
  | {
      runNumber: number;
      evaluation: "NOT_EVALUATED";
      reason: "INVALID_OUTPUT" | "TIMEOUT" | "BUDGET_EXCEEDED";
    };

export interface EvaluationPackRun {
  execution: CandidateRunRecord;
  runtime_cost: UsageCost | null;
  gate: GateRunRecord;
}

export interface PartialPackSharedEvaluationIdentity {
  source_data_hash: string;
  dataset_hash: string;
  output_schema_hash: string;
  execution_envelope_hash: string;
}

interface BuildPartialEvaluationPackInput {
  challengeVersion: string;
  candidateId?: "A" | "B" | "C";
  candidateVersion: string;
  datasetHash: string;
  candidateConfigHash: string;
  systemPromptHash: string;
  invocationHash?: string;
  sharedEvaluationIdentity?: PartialPackSharedEvaluationIdentity;
  controlKind?: "NEGATIVE_CONTROL";
  modelRequestedId: string;
  serviceTierRequested: string;
  pricing: PricingSnapshot;
  caseId: string;
  runs: CandidateRunRecord[];
  gateResults: GateRunRecord[];
  createdAt: string;
}

export interface PartialEvaluationPack {
  schema_version: "1.1";
  artifact_kind: "PARTIAL_EVALUATION_PACK";
  source: "CALIBRATION_SMOKE";
  evaluation_status: "EVALUATION_INCOMPLETE";
  pack_id: string;
  coverage: {
    cases: 1;
    candidates: 1;
    runs_per_case: 2;
    expected_runs: 2;
  };
  challenge_version: string;
  candidate_id?: "A" | "B" | "C";
  candidate_version: string;
  dataset_hash: string;
  candidate_config_hash: string;
  system_prompt_hash: string;
  invocation_hash?: string;
  shared_evaluation_identity?: PartialPackSharedEvaluationIdentity;
  control_kind?: "NEGATIVE_CONTROL";
  model_requested_id: string;
  model_reported_ids: string[];
  service_tier_requested: string;
  service_tiers_reported: string[];
  pricing_as_of: string;
  pricing_snapshot_id: string;
  pricing_evidence: {
    pricing_mode: "LOCKED_SNAPSHOT";
    snapshot_id: string;
    snapshot_hash: string;
    pricing_as_of: string;
    source_url: string;
    source_retrieved_at: string;
    unit_tokens: number;
    rates_per_unit: PricingSnapshot["rates_per_unit"];
    pricing_schedule_applied: string;
    pricing_schedule_reason: typeof PRICING_SCHEDULE_REASON;
  };
  total_runtime_cost_usd: number;
  baseline_version: null;
  case_id: string;
  created_at: string;
  runs: EvaluationPackRun[];
}

export function buildPartialEvaluationPack(
  sourceInput: BuildPartialEvaluationPackInput,
): PartialEvaluationPack {
  const serializedInput = JSON.stringify(sourceInput);
  if (serializedInput === undefined) {
    throw new TypeError("부분 Evaluation Pack 입력을 JSON으로 직렬화할 수 없습니다.");
  }
  const input = JSON.parse(serializedInput) as BuildPartialEvaluationPackInput;

  if (input.runs.length !== 2 || input.gateResults.length !== 2) {
    throw new Error("Calibration smoke 부분 평가팩은 정확히 두 실행과 두 gate 결과가 필요합니다.");
  }
  if (input.modelRequestedId !== input.pricing.model) {
    throw new Error("요청 모델과 잠긴 가격 스냅샷 모델이 일치하지 않습니다.");
  }
  if (
    input.sharedEvaluationIdentity
    && input.sharedEvaluationIdentity.dataset_hash !== input.datasetHash
  ) {
    throw new Error("공통 평가 identity의 dataset hash가 부분 팩과 일치하지 않습니다.");
  }

  const gateByRunNumber = new Map(input.gateResults.map((gate) => [gate.runNumber, gate]));
  const runNumbers = new Set(input.runs.map((run) => run.runNumber));
  const requiredRunNumbers = [1, 2] as const;
  if (
    runNumbers.size !== 2
    || gateByRunNumber.size !== 2
    || requiredRunNumbers.some((runNumber) =>
      !runNumbers.has(runNumber) || !gateByRunNumber.has(runNumber))
  ) {
    throw new Error(
      "Calibration smoke 실행과 gate는 run number 1과 2를 각각 한 번씩 가져야 합니다.",
    );
  }

  const identity = {
    challenge_version: input.challengeVersion,
    ...(input.candidateId ? { candidate_id: input.candidateId } : {}),
    candidate_version: input.candidateVersion,
    dataset_hash: input.datasetHash,
    candidate_config_hash: input.candidateConfigHash,
    system_prompt_hash: input.systemPromptHash,
    ...(input.invocationHash ? { invocation_hash: input.invocationHash } : {}),
    ...(input.sharedEvaluationIdentity
      ? { shared_evaluation_identity: input.sharedEvaluationIdentity }
      : {}),
    ...(input.controlKind ? { control_kind: input.controlKind } : {}),
    case_id: input.caseId,
  };
  const digest = sha256CanonicalJson(identity).slice(0, 16);
  const attemptsWithUsage = input.runs.flatMap((run) =>
    run.attempts.filter((attempt) => attempt.usage !== undefined),
  );
  if (attemptsWithUsage.some((attempt) =>
    !attempt.serviceTierReported
    && !attempt.executionEvidence?.providerCalls.some((call) => call.serviceTierReported)
  )) {
    throw new Error("사용량이 있는 실행에는 OpenAI가 보고한 service tier가 필요합니다.");
  }
  const serviceTiersReported = [...new Set(input.runs.flatMap((run) =>
    run.attempts.flatMap((attempt) => [
      ...(attempt.serviceTierReported ? [attempt.serviceTierReported] : []),
      ...(attempt.executionEvidence?.providerCalls.flatMap((call) =>
        call.serviceTierReported ? [call.serviceTierReported] : []) ?? []),
    ]),
  ))];
  const matchesPricingSchedule = (tier: string) =>
    tier === input.pricing.service_tier
    || (tier === "default" && input.pricing.service_tier === "standard");
  if (!matchesPricingSchedule(input.serviceTierRequested)) {
    throw new Error("요청한 service tier와 잠긴 가격 스냅샷이 일치하지 않습니다.");
  }
  const pricingTierMatches = serviceTiersReported.every(matchesPricingSchedule);
  if (!pricingTierMatches) {
    throw new Error("응답이 보고한 service tier와 잠긴 가격 스냅샷이 일치하지 않습니다.");
  }

  const evaluationRuns = input.runs.map((run) => ({
    execution: run,
    runtime_cost: calculateUsageCost(run.attempts.map((attempt) => attempt.usage), input.pricing),
    gate: gateByRunNumber.get(run.runNumber)!,
  }));

  return {
    schema_version: "1.1",
    artifact_kind: "PARTIAL_EVALUATION_PACK",
    source: "CALIBRATION_SMOKE",
    evaluation_status: "EVALUATION_INCOMPLETE",
    pack_id: `calibration-smoke-${digest}`,
    coverage: { cases: 1, candidates: 1, runs_per_case: 2, expected_runs: 2 },
    challenge_version: input.challengeVersion,
    candidate_version: input.candidateVersion,
    dataset_hash: input.datasetHash,
    candidate_config_hash: input.candidateConfigHash,
    system_prompt_hash: input.systemPromptHash,
    model_requested_id: input.modelRequestedId,
    model_reported_ids: [...new Set(input.runs.flatMap((run) =>
      run.attempts.flatMap((attempt) => [
        ...(attempt.modelReportedId ? [attempt.modelReportedId] : []),
        ...(attempt.executionEvidence?.providerCalls.flatMap((call) =>
          call.modelReportedId ? [call.modelReportedId] : []) ?? []),
      ]),
    ))],
    service_tier_requested: input.serviceTierRequested,
    service_tiers_reported: serviceTiersReported,
    pricing_as_of: input.pricing.pricing_as_of,
    pricing_snapshot_id: input.pricing.pricing_snapshot_id,
    pricing_evidence: {
      pricing_mode: "LOCKED_SNAPSHOT",
      snapshot_id: input.pricing.pricing_snapshot_id,
      snapshot_hash: sha256CanonicalJson(input.pricing),
      pricing_as_of: input.pricing.pricing_as_of,
      source_url: input.pricing.source_url,
      source_retrieved_at: input.pricing.source_retrieved_at,
      unit_tokens: input.pricing.unit_tokens,
      rates_per_unit: { ...input.pricing.rates_per_unit },
      pricing_schedule_applied: input.pricing.service_tier,
      pricing_schedule_reason: PRICING_SCHEDULE_REASON,
    },
    total_runtime_cost_usd: evaluationRuns.reduce(
      (total, run) => total + (run.runtime_cost?.totalCostUsd ?? 0),
      0,
    ),
    baseline_version: null,
    case_id: input.caseId,
    created_at: input.createdAt,
    ...(input.candidateId ? { candidate_id: input.candidateId } : {}),
    ...(input.invocationHash ? { invocation_hash: input.invocationHash } : {}),
    ...(input.sharedEvaluationIdentity
      ? { shared_evaluation_identity: structuredClone(input.sharedEvaluationIdentity) }
      : {}),
    ...(input.controlKind ? { control_kind: input.controlKind } : {}),
    runs: evaluationRuns,
  };
}

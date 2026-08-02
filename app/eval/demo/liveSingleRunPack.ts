import type { PolicyGateResult } from "../deterministic/policyGate";
import { evaluateActivePolicyGate } from "../deterministic/policyGate";
import { parseCandidateOutput } from "../contracts/candidateOutput";
import {
  validateAttemptEnvelope,
  validateAttemptUsage,
  validateRunAndGate,
} from "../pack/calibrationPack";
import type { CandidateRunRecord } from "../runner/types";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  calculateUsageCost,
  type UsageCost,
} from "../runtime/pricing";
import {
  ABC_CHALLENGE,
  CALIBRATION_CASE,
  CALIBRATION_DATASET_HASH,
  CALIBRATION_ORACLE,
  CALIBRATION_POLICIES,
  CALIBRATION_PRICING,
  CANDIDATE_CONFIGS,
  CANDIDATE_IDENTITY_RECORDS,
  CANDIDATE_IDS,
  SHARED_EVALUATION_IDENTITY,
  type CalibrationCandidateId,
  type SharedEvaluationIdentity,
} from "../smoke/candidateDefinitions";
import { PRICING_SCHEDULE_REASON } from "../pack/evaluationPack";

export type LiveSingleRunGate =
  | {
      readonly runNumber: 1;
      readonly evaluation: "EVALUATED";
      readonly result: PolicyGateResult;
    }
  | {
      readonly runNumber: 1;
      readonly evaluation: "NOT_EVALUATED";
      readonly reason: "INVALID_OUTPUT" | "TIMEOUT" | "BUDGET_EXCEEDED";
    };

export interface LiveSingleRunPackEntry {
  readonly candidate_id: CalibrationCandidateId;
  readonly candidate_version: string;
  readonly candidate_config_hash: string;
  readonly system_prompt_hash: string;
  readonly invocation_hash: string;
  readonly execution_status: CandidateRunRecord["status"];
  readonly execution: CandidateRunRecord;
  readonly gate: LiveSingleRunGate;
  readonly runtime_cost: UsageCost | null;
  readonly runtime_cost_usd: number | null;
  readonly cost_evidence_status: "COMPLETE" | "PARTIAL";
  readonly summed_latency_ms: number;
  readonly provider_call_count: number;
  readonly retrieval_call_count: number;
  readonly tool_call_count: number;
}

export interface BuildLiveSingleRunPackEntry {
  readonly candidateId: CalibrationCandidateId;
  readonly run: CandidateRunRecord;
}

export interface BuildLiveSingleRunPackInput {
  readonly entries: readonly BuildLiveSingleRunPackEntry[];
  readonly createdAt: string;
}

export interface LiveSingleRunPack {
  readonly schema_version: "live-demo-evaluation-pack-v1";
  readonly artifact_kind: "LIVE_DEMO_EVALUATION_PACK";
  readonly source: "LIVE_SYNTHETIC_DEMO";
  readonly evaluation_status: "EVALUATION_INCOMPLETE";
  readonly synthetic: true;
  readonly pack_id: string;
  readonly coverage: {
    readonly cases: 1;
    readonly candidates: 3;
    readonly runs_per_candidate: 1;
    readonly expected_runs: 3;
    readonly completed_runs: number;
  };
  readonly challenge_version: string;
  readonly shared_evaluation_identity: SharedEvaluationIdentity;
  readonly dataset_hash: string;
  readonly case_id: string;
  readonly model_requested_id: string;
  readonly service_tier_requested: string;
  readonly pricing_snapshot_id: string;
  readonly pricing_evidence: {
    readonly pricing_mode: "LOCKED_SNAPSHOT";
    readonly snapshot_id: string;
    readonly snapshot_hash: string;
    readonly pricing_as_of: string;
    readonly source_url: string;
    readonly source_retrieved_at: string;
    readonly unit_tokens: number;
    readonly rates_per_unit: typeof CALIBRATION_PRICING.rates_per_unit;
    readonly pricing_schedule_applied: string;
    readonly pricing_schedule_reason: typeof PRICING_SCHEDULE_REASON;
  };
  readonly total_runtime_cost_usd: number;
  readonly cost_evidence_status: "COMPLETE" | "PARTIAL";
  readonly stability: "SINGLE_RUN_NOT_MEASURED";
  readonly baseline_version: null;
  readonly created_at: string;
  readonly entries: readonly LiveSingleRunPackEntry[];
}

type JsonRecord = Record<string, unknown>;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as JsonRecord)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalJsonStringify(value)) as T;
  } catch (error) {
    throw new TypeError(`${label}을(를) canonical JSON snapshot으로 만들 수 없습니다.`, {
      cause: error,
    });
  }
}

function assertCreatedAt(value: string): void {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError("live pack createdAt은 유효한 ISO 시각이어야 합니다.");
  }
}

function notEvaluatedReason(
  run: CandidateRunRecord,
): Extract<LiveSingleRunGate, { evaluation: "NOT_EVALUATED" }>["reason"] {
  if (run.status === "TIMEOUT") return "TIMEOUT";
  if (run.status === "BUDGET_EXCEEDED") return "BUDGET_EXCEEDED";
  return "INVALID_OUTPUT";
}

function buildGate(run: CandidateRunRecord): LiveSingleRunGate {
  if (run.output === undefined) {
    return {
      runNumber: 1,
      evaluation: "NOT_EVALUATED",
      reason: notEvaluatedReason(run),
    };
  }
  return {
    runNumber: 1,
    evaluation: "EVALUATED",
    result: evaluateActivePolicyGate({
      output: run.output,
      oracle: CALIBRATION_ORACLE,
      policies: [...CALIBRATION_POLICIES],
      asOf: CALIBRATION_CASE.as_of,
    }),
  };
}

function assertRunEnvelope(
  candidateId: CalibrationCandidateId,
  run: CandidateRunRecord,
): void {
  if (run.runNumber !== 1) {
    throw new TypeError(`Candidate ${candidateId} live demo runNumber는 1이어야 합니다.`);
  }
  if (!Array.isArray(run.attempts) || run.attempts.length < 1 || run.attempts.length > 2) {
    throw new TypeError(`Candidate ${candidateId} live demo에는 1~2개 attempt가 필요합니다.`);
  }
  if (run.attempts.some((attempt, index) => attempt.attemptNumber !== index + 1)) {
    throw new TypeError(`Candidate ${candidateId} attempt 순서가 연속적이지 않습니다.`);
  }
  if (!Number.isFinite(run.totalLatencyMs) || run.totalLatencyMs < 0) {
    throw new TypeError(`Candidate ${candidateId} latency가 유효하지 않습니다.`);
  }
  const computedLatency = run.attempts.reduce(
    (total, attempt) => total + attempt.latencyMs,
    0,
  );
  if (computedLatency !== run.totalLatencyMs) {
    throw new TypeError(`Candidate ${candidateId} latency 합계가 attempt 증거와 다릅니다.`);
  }
  if ((run.status === "COMPLETE") !== (run.output !== undefined)) {
    throw new TypeError(`Candidate ${candidateId} 실행 상태와 output 존재 여부가 다릅니다.`);
  }
}

function callCounts(run: CandidateRunRecord): {
  readonly provider: number;
  readonly retrieval: number;
  readonly tool: number;
} {
  return run.attempts.reduce((counts, attempt) => ({
    provider: counts.provider
      + (attempt.executionEvidence?.providerCalls.length ?? 0),
    retrieval: counts.retrieval
      + (attempt.executionEvidence?.retrievalCalls.length ?? 0),
    tool: counts.tool
      + (attempt.executionEvidence?.toolCalls.length ?? 0),
  }), { provider: 0, retrieval: 0, tool: 0 });
}

function hasCompleteCostEvidence(run: CandidateRunRecord): boolean {
  return run.attempts.every((attempt) => {
    const providerCalls = attempt.executionEvidence?.providerCalls ?? [];
    if (providerCalls.length === 0) {
      return attempt.usage === undefined;
    }
    return providerCalls.every((call) => call.usage !== null)
      && attempt.usage !== undefined;
  });
}

function buildEntry(
  candidateId: CalibrationCandidateId,
  sourceRun: CandidateRunRecord,
): LiveSingleRunPackEntry {
  const run = snapshot(sourceRun, `Candidate ${candidateId} run`);
  assertRunEnvelope(candidateId, run);
  if (run.output !== undefined) {
    parseCandidateOutput(run.output);
  }
  const expectedIdentity = CANDIDATE_IDENTITY_RECORDS[candidateId];
  const counts = callCounts(run);
  const gate = buildGate(run);
  validateRunAndGate(candidateId, {
    execution: run,
    runtime_cost: null,
    gate,
  });
  run.attempts.forEach((attempt) => {
    validateAttemptUsage(candidateId, attempt);
    validateAttemptEnvelope(candidateId, attempt);
  });
  const runtimeCost = calculateUsageCost(
    run.attempts.map((attempt) => attempt.usage),
    CALIBRATION_PRICING,
  );
  return {
    candidate_id: candidateId,
    candidate_version: expectedIdentity.candidate_version,
    candidate_config_hash: expectedIdentity.candidate_config_hash,
    system_prompt_hash: expectedIdentity.system_prompt_hash,
    invocation_hash: expectedIdentity.invocation_hash,
    execution_status: run.status,
    execution: run,
    gate,
    runtime_cost: runtimeCost,
    runtime_cost_usd: runtimeCost?.totalCostUsd ?? null,
    cost_evidence_status: hasCompleteCostEvidence(run) ? "COMPLETE" : "PARTIAL",
    summed_latency_ms: run.totalLatencyMs,
    provider_call_count: counts.provider,
    retrieval_call_count: counts.retrieval,
    tool_call_count: counts.tool,
  };
}

function pricingEvidence(): LiveSingleRunPack["pricing_evidence"] {
  return {
    pricing_mode: "LOCKED_SNAPSHOT",
    snapshot_id: CALIBRATION_PRICING.pricing_snapshot_id,
    snapshot_hash: sha256CanonicalJson(CALIBRATION_PRICING),
    pricing_as_of: CALIBRATION_PRICING.pricing_as_of,
    source_url: CALIBRATION_PRICING.source_url,
    source_retrieved_at: CALIBRATION_PRICING.source_retrieved_at,
    unit_tokens: CALIBRATION_PRICING.unit_tokens,
    rates_per_unit: structuredClone(CALIBRATION_PRICING.rates_per_unit),
    pricing_schedule_applied: CALIBRATION_PRICING.service_tier,
    pricing_schedule_reason: PRICING_SCHEDULE_REASON,
  };
}

export function buildLiveSingleRunPack(
  sourceInput: BuildLiveSingleRunPackInput,
): LiveSingleRunPack {
  assertCreatedAt(sourceInput.createdAt);
  const input = snapshot(sourceInput, "live single-run pack 입력");
  if (!Array.isArray(input.entries) || input.entries.length !== 3) {
    throw new TypeError("live single-run pack에는 exact A/B/C entry 3개가 필요합니다.");
  }

  const byCandidate = new Map<CalibrationCandidateId, CandidateRunRecord>();
  for (const entry of input.entries) {
    if (
      !CANDIDATE_IDS.includes(entry.candidateId)
      || byCandidate.has(entry.candidateId)
    ) {
      throw new TypeError("live single-run pack candidate mapping은 exact A/B/C unique여야 합니다.");
    }
    byCandidate.set(entry.candidateId, entry.run);
  }
  const entries = CANDIDATE_IDS.map((candidateId) => {
    const run = byCandidate.get(candidateId);
    if (!run) {
      throw new TypeError(`live single-run pack에 Candidate ${candidateId}가 없습니다.`);
    }
    return buildEntry(candidateId, run);
  });
  const totalRuntimeCostUsd = entries.reduce(
    (total, entry) => total + (entry.runtime_cost_usd ?? 0),
    0,
  );
  const packIdentity = {
    schema_version: "live-demo-evaluation-pack-v1",
    source: "LIVE_SYNTHETIC_DEMO",
    challenge_version: ABC_CHALLENGE.challenge_version,
    shared_evaluation_identity: SHARED_EVALUATION_IDENTITY,
    case_id: CALIBRATION_CASE.case_id,
    candidates: entries,
  };

  return deepFreeze({
    schema_version: "live-demo-evaluation-pack-v1",
    artifact_kind: "LIVE_DEMO_EVALUATION_PACK",
    source: "LIVE_SYNTHETIC_DEMO",
    evaluation_status: "EVALUATION_INCOMPLETE",
    synthetic: true,
    pack_id: `live-demo-pack-${sha256CanonicalJson(packIdentity)}`,
    coverage: {
      cases: 1,
      candidates: 3,
      runs_per_candidate: 1,
      expected_runs: 3,
      completed_runs: entries.filter((entry) => entry.execution_status === "COMPLETE").length,
    },
    challenge_version: ABC_CHALLENGE.challenge_version,
    shared_evaluation_identity: structuredClone(SHARED_EVALUATION_IDENTITY),
    dataset_hash: CALIBRATION_DATASET_HASH,
    case_id: CALIBRATION_CASE.case_id,
    model_requested_id: CANDIDATE_CONFIGS.A.model_requested_id,
    service_tier_requested: CANDIDATE_CONFIGS.A.service_tier,
    pricing_snapshot_id: CALIBRATION_PRICING.pricing_snapshot_id,
    pricing_evidence: pricingEvidence(),
    total_runtime_cost_usd: totalRuntimeCostUsd,
    cost_evidence_status: entries.every(
      (entry) => entry.cost_evidence_status === "COMPLETE",
    )
      ? "COMPLETE"
      : "PARTIAL",
    stability: "SINGLE_RUN_NOT_MEASURED",
    baseline_version: null,
    created_at: input.createdAt,
    entries,
  } satisfies LiveSingleRunPack);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateLiveSingleRunPack(raw: unknown): LiveSingleRunPack {
  const snapshotValue = snapshot(raw, "live single-run pack");
  if (
    !isRecord(snapshotValue)
    || typeof snapshotValue.created_at !== "string"
    || !Array.isArray(snapshotValue.entries)
  ) {
    throw new TypeError("live single-run pack raw JSON 계약이 올바르지 않습니다.");
  }
  const entries = snapshotValue.entries.map((entry, index) => {
    if (!isRecord(entry) || !isRecord(entry.execution)) {
      throw new TypeError(`live single-run pack entries[${index}] 계약이 올바르지 않습니다.`);
    }
    return {
      candidateId: entry.candidate_id as CalibrationCandidateId,
      run: entry.execution as unknown as CandidateRunRecord,
    };
  });
  const rebuilt = buildLiveSingleRunPack({
    entries,
    createdAt: snapshotValue.created_at,
  });
  if (canonicalJsonStringify(rebuilt) !== canonicalJsonStringify(snapshotValue)) {
    throw new Error("live single-run pack canonical 무결성이 다릅니다.");
  }
  return rebuilt;
}

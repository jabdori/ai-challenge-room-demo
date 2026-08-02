import type { CandidateOutput } from "../contracts/candidateOutput";
import type { PolicyGateFinding } from "../deterministic/policyGate";
import {
  buildPartialCalibrationPack,
  type PartialCalibrationPack,
  type PartialCalibrationPackEntry,
} from "../pack/calibrationPack";
import type { GateRunRecord } from "../pack/evaluationPack";
import type { CandidateRunRecord } from "../runner/types";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import type { CalibrationCandidateId } from "../smoke/candidateDefinitions";
import {
  assertDemoProjectionPublicSafe,
} from "./publicProjectionSafety";

export {
  assertDemoProjectionPublicSafe as assertRecordedSyntheticDemoProjectionPublicSafe,
} from "./publicProjectionSafety";

export type RecordedSyntheticDemoGate =
  | {
      readonly evaluation_status: "EVALUATED";
      readonly gate_code: "P0-HG-02";
      readonly status: "PASS" | "CONFIRMED_FAIL";
      readonly findings: readonly PolicyGateFinding[];
    }
  | {
      readonly evaluation_status: "NOT_EVALUATED";
      readonly gate_code: null;
      readonly status: "NOT_EVALUATED";
      readonly findings: readonly [];
      readonly reason: "INVALID_OUTPUT" | "TIMEOUT" | "BUDGET_EXCEEDED";
    };

export interface RecordedSyntheticDemoEvidence {
  readonly evidence_id: string;
  readonly source: "RECORDED_SYNTHETIC_DEMO";
  readonly source_hash: string;
  readonly case_id: string;
  readonly candidate_id: CalibrationCandidateId;
  readonly candidate_version: string;
  readonly run_number: 1 | 2;
  readonly execution_status: CandidateRunRecord["status"];
  readonly evaluation_status: GateRunRecord["evaluation"];
  readonly deterministic_gate: RecordedSyntheticDemoGate;
  readonly output: CandidateOutput | null;
  readonly cost_usd: number | null;
  readonly summed_latency_ms: number;
  readonly provider_call_count: number;
  readonly retrieval_call_count: number;
  readonly tool_call_count: number;
}

export interface RecordedSyntheticDemoCandidate {
  readonly candidate_id: CalibrationCandidateId;
  readonly candidate_version: string;
  readonly total_runtime_cost_usd: number;
  readonly summed_latency_ms: number;
  readonly provider_call_count: number;
  readonly retrieval_call_count: number;
  readonly tool_call_count: number;
  readonly runs: readonly RecordedSyntheticDemoEvidence[];
}

export interface RecordedSyntheticDemoProjection {
  readonly schema_version: "recorded-synthetic-demo-projection-v1";
  readonly artifact_kind: "RECORDED_SYNTHETIC_DEMO_PROJECTION";
  readonly synthetic: true;
  readonly source: "RECORDED_SYNTHETIC_DEMO";
  readonly evaluation_status: "EVALUATION_INCOMPLETE";
  readonly pack_id: string;
  readonly source_hash: string;
  readonly challenge_version: string;
  readonly baseline_version: null;
  readonly case: {
    readonly case_id: string;
    readonly count: 1;
  };
  readonly coverage: {
    readonly cases: 1;
    readonly candidates: 3;
    readonly runs_per_candidate: 2;
    readonly completed_runs: number;
    readonly expected_runs: 6;
  };
  readonly total_runtime_cost_usd: number;
  readonly summed_latency_ms: number;
  readonly candidates: readonly RecordedSyntheticDemoCandidate[];
  readonly evidence: readonly RecordedSyntheticDemoEvidence[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as JsonRecord)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function validateRawPack(raw: unknown): PartialCalibrationPack {
  if (
    !isRecord(raw)
    || !Array.isArray(raw.entries)
    || typeof raw.created_at !== "string"
  ) {
    throw new TypeError("PartialCalibrationPack raw JSON 계약이 올바르지 않습니다.");
  }

  // 상위 필드를 신뢰하지 않고 잠긴 builder로 자식 실행부터 비용·gate까지 재검증합니다.
  const rebuilt = buildPartialCalibrationPack({
    entries: raw.entries as readonly PartialCalibrationPackEntry[],
    createdAt: raw.created_at,
  });
  if (canonicalJsonStringify(rebuilt) !== canonicalJsonStringify(raw)) {
    throw new Error(
      "PartialCalibrationPack raw JSON이 canonical 재구축 결과와 일치하지 않습니다.",
    );
  }
  return rebuilt;
}

function projectGate(gate: GateRunRecord): RecordedSyntheticDemoGate {
  if (gate.evaluation === "NOT_EVALUATED") {
    return {
      evaluation_status: "NOT_EVALUATED",
      gate_code: null,
      status: "NOT_EVALUATED",
      findings: [],
      reason: gate.reason,
    };
  }
  return {
    evaluation_status: "EVALUATED",
    gate_code: gate.result.gateCode,
    status: gate.result.status,
    findings: structuredClone(gate.result.findings),
  };
}

function evidenceId({
  sourceHash,
  caseId,
  candidateId,
  candidateVersion,
  runNumber,
}: {
  readonly sourceHash: string;
  readonly caseId: string;
  readonly candidateId: CalibrationCandidateId;
  readonly candidateVersion: string;
  readonly runNumber: 1 | 2;
}): string {
  return `demo_evidence_${sha256CanonicalJson({
    schema_version: "recorded-synthetic-demo-evidence-id-v1",
    source_hash: sourceHash,
    case_id: caseId,
    candidate_id: candidateId,
    candidate_version: candidateVersion,
    run_number: runNumber,
  })}`;
}

function countCalls(run: CandidateRunRecord): {
  readonly provider: number;
  readonly retrieval: number;
  readonly tool: number;
} {
  return run.attempts.reduce((counts, attempt) => {
    const execution = attempt.executionEvidence;
    return {
      provider: counts.provider + (execution?.providerCalls.length ?? 0),
      retrieval: counts.retrieval + (execution?.retrievalCalls.length ?? 0),
      tool: counts.tool + (execution?.toolCalls.length ?? 0),
    };
  }, { provider: 0, retrieval: 0, tool: 0 });
}

function projectCandidate(
  entry: PartialCalibrationPackEntry,
  sourceHash: string,
  caseId: string,
): RecordedSyntheticDemoCandidate {
  const runs = entry.evaluation_pack.runs.map((packRun) => {
    const run = packRun.execution;
    const calls = countCalls(run);
    return {
      evidence_id: evidenceId({
        sourceHash,
        caseId,
        candidateId: entry.candidate_id,
        candidateVersion: entry.evaluation_pack.candidate_version,
        runNumber: run.runNumber as 1 | 2,
      }),
      source: "RECORDED_SYNTHETIC_DEMO",
      source_hash: sourceHash,
      case_id: caseId,
      candidate_id: entry.candidate_id,
      candidate_version: entry.evaluation_pack.candidate_version,
      run_number: run.runNumber as 1 | 2,
      execution_status: run.status,
      evaluation_status: packRun.gate.evaluation,
      deterministic_gate: projectGate(packRun.gate),
      output: run.output === undefined ? null : structuredClone(run.output),
      cost_usd: packRun.runtime_cost?.totalCostUsd ?? null,
      summed_latency_ms: run.totalLatencyMs,
      provider_call_count: calls.provider,
      retrieval_call_count: calls.retrieval,
      tool_call_count: calls.tool,
    } satisfies RecordedSyntheticDemoEvidence;
  });

  return {
    candidate_id: entry.candidate_id,
    candidate_version: entry.evaluation_pack.candidate_version,
    total_runtime_cost_usd: entry.evaluation_pack.total_runtime_cost_usd,
    summed_latency_ms: runs.reduce(
      (total, run) => total + run.summed_latency_ms,
      0,
    ),
    provider_call_count: runs.reduce(
      (total, run) => total + run.provider_call_count,
      0,
    ),
    retrieval_call_count: runs.reduce(
      (total, run) => total + run.retrieval_call_count,
      0,
    ),
    tool_call_count: runs.reduce(
      (total, run) => total + run.tool_call_count,
      0,
    ),
    runs,
  };
}

export function buildRecordedSyntheticDemoProjection(
  raw: unknown,
): RecordedSyntheticDemoProjection {
  const pack = validateRawPack(raw);
  const sourceHash = sha256CanonicalJson(pack);
  const candidates = pack.entries.map((entry) => (
    projectCandidate(entry, sourceHash, pack.case_id)
  ));
  const evidence = candidates.flatMap((candidate) => candidate.runs);

  const projection: RecordedSyntheticDemoProjection = {
    schema_version: "recorded-synthetic-demo-projection-v1",
    artifact_kind: "RECORDED_SYNTHETIC_DEMO_PROJECTION",
    synthetic: true,
    source: "RECORDED_SYNTHETIC_DEMO",
    evaluation_status: "EVALUATION_INCOMPLETE",
    pack_id: pack.pack_id,
    source_hash: sourceHash,
    challenge_version: pack.challenge_version,
    baseline_version: null,
    case: {
      case_id: pack.case_id,
      count: 1,
    },
    coverage: {
      cases: 1,
      candidates: 3,
      runs_per_candidate: 2,
      completed_runs: evidence.filter((run) => (
        run.execution_status === "COMPLETE"
      )).length,
      expected_runs: 6,
    },
    total_runtime_cost_usd: pack.total_runtime_cost_usd,
    summed_latency_ms: candidates.reduce(
      (total, candidate) => total + candidate.summed_latency_ms,
      0,
    ),
    candidates,
    evidence,
  };
  assertDemoProjectionPublicSafe(projection);
  return deepFreeze(projection);
}

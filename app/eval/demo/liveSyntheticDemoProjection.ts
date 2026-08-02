import type { CandidateOutput } from "../contracts/candidateOutput";
import type { PolicyGateFinding } from "../deterministic/policyGate";
import {
  assertDemoProjectionPublicSafe,
} from "./publicProjectionSafety";
import {
  validateLiveSingleRunPack,
  type LiveSingleRunGate,
  type LiveSingleRunPack,
  type LiveSingleRunPackEntry,
} from "./liveSingleRunPack";
import {
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import type { CalibrationCandidateId } from "../smoke/candidateDefinitions";
import type { CandidateRunRecord } from "../runner/types";

export type LiveSyntheticDemoGate =
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

export interface LiveSyntheticDemoEvidence {
  readonly evidence_id: string;
  readonly source: "LIVE_SYNTHETIC_DEMO";
  readonly source_hash: string;
  readonly case_id: string;
  readonly candidate_id: CalibrationCandidateId;
  readonly candidate_version: string;
  readonly run_number: 1;
  readonly execution_status: CandidateRunRecord["status"];
  readonly evaluation_status: LiveSingleRunGate["evaluation"];
  readonly deterministic_gate: LiveSyntheticDemoGate;
  readonly output: CandidateOutput | null;
  readonly cost_usd: number | null;
  readonly summed_latency_ms: number;
  readonly provider_call_count: number;
  readonly retrieval_call_count: number;
  readonly tool_call_count: number;
}

export interface LiveSyntheticDemoCandidate {
  readonly candidate_id: CalibrationCandidateId;
  readonly candidate_version: string;
  readonly total_runtime_cost_usd: number | null;
  readonly summed_latency_ms: number;
  readonly provider_call_count: number;
  readonly retrieval_call_count: number;
  readonly tool_call_count: number;
  readonly runs: readonly [LiveSyntheticDemoEvidence];
}

export interface LiveSyntheticDemoProjection {
  readonly schema_version: "live-synthetic-demo-projection-v1";
  readonly artifact_kind: "LIVE_SYNTHETIC_DEMO_PROJECTION";
  readonly synthetic: true;
  readonly source: "LIVE_SYNTHETIC_DEMO";
  readonly evaluation_status: "EVALUATION_INCOMPLETE";
  readonly pack_id: string;
  readonly source_hash: string;
  readonly challenge_version: string;
  readonly baseline_version: null;
  readonly stability: "SINGLE_RUN_NOT_MEASURED";
  readonly case: {
    readonly case_id: string;
    readonly count: 1;
  };
  readonly coverage: {
    readonly cases: 1;
    readonly candidates: 3;
    readonly runs_per_candidate: 1;
    readonly completed_runs: number;
    readonly expected_runs: 3;
  };
  readonly total_runtime_cost_usd: number;
  readonly cost_evidence_status: "COMPLETE" | "PARTIAL";
  readonly summed_latency_ms: number;
  readonly candidates: readonly [
    LiveSyntheticDemoCandidate,
    LiveSyntheticDemoCandidate,
    LiveSyntheticDemoCandidate,
  ];
  readonly evidence: readonly [
    LiveSyntheticDemoEvidence,
    LiveSyntheticDemoEvidence,
    LiveSyntheticDemoEvidence,
  ];
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

function projectGate(gate: LiveSingleRunGate): LiveSyntheticDemoGate {
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

function evidenceId(
  sourceHash: string,
  pack: LiveSingleRunPack,
  entry: LiveSingleRunPackEntry,
): string {
  return `live_demo_evidence_${sha256CanonicalJson({
    schema_version: "live-synthetic-demo-evidence-id-v1",
    source_hash: sourceHash,
    case_id: pack.case_id,
    candidate_id: entry.candidate_id,
    candidate_version: entry.candidate_version,
    run_number: 1,
  })}`;
}

function projectEntry(
  sourceHash: string,
  pack: LiveSingleRunPack,
  entry: LiveSingleRunPackEntry,
): LiveSyntheticDemoCandidate {
  const evidence: LiveSyntheticDemoEvidence = {
    evidence_id: evidenceId(sourceHash, pack, entry),
    source: "LIVE_SYNTHETIC_DEMO",
    source_hash: sourceHash,
    case_id: pack.case_id,
    candidate_id: entry.candidate_id,
    candidate_version: entry.candidate_version,
    run_number: 1,
    execution_status: entry.execution_status,
    evaluation_status: entry.gate.evaluation,
    deterministic_gate: projectGate(entry.gate),
    output: entry.execution.output === undefined
      ? null
      : structuredClone(entry.execution.output),
    cost_usd: entry.runtime_cost_usd,
    summed_latency_ms: entry.summed_latency_ms,
    provider_call_count: entry.provider_call_count,
    retrieval_call_count: entry.retrieval_call_count,
    tool_call_count: entry.tool_call_count,
  };
  return {
    candidate_id: entry.candidate_id,
    candidate_version: entry.candidate_version,
    total_runtime_cost_usd: entry.runtime_cost_usd,
    summed_latency_ms: entry.summed_latency_ms,
    provider_call_count: entry.provider_call_count,
    retrieval_call_count: entry.retrieval_call_count,
    tool_call_count: entry.tool_call_count,
    runs: [evidence],
  };
}

export function buildLiveSyntheticDemoProjection(
  rawPack: unknown,
): LiveSyntheticDemoProjection {
  const pack = validateLiveSingleRunPack(rawPack);
  const sourceHash = sha256CanonicalJson(pack);
  const candidates = pack.entries.map((entry) =>
    projectEntry(sourceHash, pack, entry)) as unknown as
    LiveSyntheticDemoProjection["candidates"];
  const evidence = candidates.map((candidate) => candidate.runs[0]) as unknown as
    LiveSyntheticDemoProjection["evidence"];
  const projection: LiveSyntheticDemoProjection = {
    schema_version: "live-synthetic-demo-projection-v1",
    artifact_kind: "LIVE_SYNTHETIC_DEMO_PROJECTION",
    synthetic: true,
    source: "LIVE_SYNTHETIC_DEMO",
    evaluation_status: "EVALUATION_INCOMPLETE",
    pack_id: pack.pack_id,
    source_hash: sourceHash,
    challenge_version: pack.challenge_version,
    baseline_version: null,
    stability: "SINGLE_RUN_NOT_MEASURED",
    case: {
      case_id: pack.case_id,
      count: 1,
    },
    coverage: {
      cases: 1,
      candidates: 3,
      runs_per_candidate: 1,
      completed_runs: pack.coverage.completed_runs,
      expected_runs: 3,
    },
    total_runtime_cost_usd: pack.total_runtime_cost_usd,
    cost_evidence_status: pack.cost_evidence_status,
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

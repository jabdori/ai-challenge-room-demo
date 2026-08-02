import type { BrowserPublicProjection } from "./challengeApi";
import type { EvidenceRecord } from "../domain/types";
import type { LockedChallengeView } from "../features/define/DefineStage";
import type {
  CompareCandidateAggregateView,
  CompareSlotView,
  RecordedBenchmarkProgressView,
} from "../features/compare/CompareStage";

type JsonRecord = Record<string, unknown>;
const SHA256 = /^[a-f0-9]{64}$/;

export class WorkspaceProjectionError extends Error {
  readonly code = "WORKSPACE_PROJECTION_INVALID" as const;

  constructor(location: string) {
    super(`${location} 공개 projection 계약이 올바르지 않습니다.`);
    this.name = "WorkspaceProjectionError";
  }
}

function record(value: unknown, location: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspaceProjectionError(location);
  }
  return value as JsonRecord;
}

function string(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkspaceProjectionError(location);
  }
  return value;
}

function number(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new WorkspaceProjectionError(location);
  }
  return value;
}

function array(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) throw new WorkspaceProjectionError(location);
  return value;
}

function stringArray(value: unknown, location: string): string[] {
  return array(value, location).map((item, index) => (
    string(item, `${location}[${index}]`)
  ));
}

function nullableString(value: unknown, location: string): string | null {
  return value === null ? null : string(value, location);
}

function hash(value: unknown, location: string): string {
  const parsed = string(value, location);
  if (!SHA256.test(parsed)) throw new WorkspaceProjectionError(location);
  return parsed;
}

function blindEvidenceLeaksIdentity(value: unknown): boolean {
  const normalized = JSON.stringify(value)
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase()
    .replace(/[\p{Pd}_]+/gu, " ")
    .replace(/[\p{Z}\s]+/gu, " ");
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  return [
    /candidate[abc]/,
    /system[abc]/,
    /configuration[abc]/,
    /config[abc]/,
    /model[abc]/,
    /getorder/,
    /searchpolicy/,
    /retriev/,
    /vector/,
    /toolworkflow/,
    /agentworkflow/,
    /toolagent/,
    /readonlytool/,
    /agentic/,
    /functioncall/,
    /toolcall/,
    /largelanguagemodel/,
    /promptonly/,
    /systemprompt/,
    /estimatedcost/,
    /costusd/,
    /latencyms/,
    /inputtokens/,
    /outputtokens/,
    /tier[123]/,
    /openai/,
    /anthropic/,
    /gemini/,
    /gpt[0-9]/,
  ].some((pattern) => pattern.test(compact))
    || /(?:^|[^a-z0-9])[xyz]\s*(?:=|is|maps?\s*to)\s*(?:candidate\s*)?[abc](?:$|[^a-z0-9])/i
      .test(normalized)
    || /(?:^|[^a-z0-9])r\s*a\s*g(?:$|[^a-z0-9])/i.test(normalized)
    || /(?:^|[^a-z0-9])l\s*l\s*m(?:$|[^a-z0-9])/i.test(normalized);
}

export interface WorkspaceIndexView {
  readonly challengeId: string;
  readonly benchmarkId: string | null;
  readonly reviewId: string | null;
  readonly decisionId: string | null;
  readonly baselineId: string | null;
  readonly regressionId: string | null;
  readonly sourceHash: string;
  readonly defineStatus: string;
  readonly compareStatus: string;
  readonly decideStatus: string;
  readonly monitorStatus: string;
}

export function parseWorkspaceIndex(
  projection: BrowserPublicProjection,
): WorkspaceIndexView {
  if (projection.schema_version !== "workspace-public-projection-v1") {
    throw new WorkspaceProjectionError("workspace");
  }
  const challengeId = string(projection.challenge_id, "workspace.challenge_id");
  const benchmarkId = projection.benchmark_id === null
    ? null
    : string(projection.benchmark_id, "workspace.benchmark_id");
  const reviewId = nullableString(
    projection.review_id,
    "workspace.review_id",
  );
  const decisionId = nullableString(
    projection.decision_id,
    "workspace.decision_id",
  );
  const baselineId = nullableString(
    projection.baseline_id,
    "workspace.baseline_id",
  );
  const regressionId = nullableString(
    projection.regression_id,
    "workspace.regression_id",
  );
  const statuses = record(projection.stage_statuses, "workspace.stage_statuses");
  const defineStatus = string(
    statuses.define,
    "workspace.stage_statuses.define",
  );
  const compareStatus = string(
    statuses.compare,
    "workspace.stage_statuses.compare",
  );
  const decideStatus = string(
    statuses.decide,
    "workspace.stage_statuses.decide",
  );
  const monitorStatus = string(
    statuses.monitor,
    "workspace.stage_statuses.monitor",
  );
  if (
    (benchmarkId === null && (
      reviewId !== null
      || decisionId !== null
      || baselineId !== null
      || regressionId !== null
    ))
    || (reviewId !== null && decisionId !== null)
    || (baselineId !== null && decisionId === null)
    || (regressionId !== null && baselineId === null)
  ) {
    throw new WorkspaceProjectionError("workspace.authority_chain");
  }
  const lifecycleDefineState = ["DRAFT", "PROPOSED", "LOCKED", "INVALID"]
    .includes(defineStatus);
  const lifecycleCompareState = [
    "NOT READY", "READY", "RUNNING", "COMPLETE", "INVALID", "RECORDED",
  ].includes(compareStatus);
  const preLockLifecycleState =
    (defineStatus === "DRAFT" || defineStatus === "PROPOSED")
    && compareStatus === "NOT READY"
    && decideStatus === "NOT READY"
    && monitorStatus === "NO BASELINE"
    && benchmarkId === null
    && reviewId === null
    && decisionId === null
    && baselineId === null
    && regressionId === null;
  const lockedLifecycleState =
    defineStatus === "LOCKED"
    && lifecycleCompareState
    && decideStatus === "NOT READY"
    && monitorStatus === "NO BASELINE"
    && benchmarkId !== null
    && reviewId === null
    && decisionId === null
    && baselineId === null
    && regressionId === null;
  const authorityStateValid = lifecycleDefineState && (
      preLockLifecycleState
      || lockedLifecycleState
      || (
        defineStatus === "LOCKED"
        && compareStatus === "RECORDED"
        && (
      (
        decisionId === null
        && baselineId === null
        && regressionId === null
        && monitorStatus === "NO BASELINE"
        && (
          reviewId === null
            ? decideStatus === "REVIEW PENDING"
            : (
                decideStatus === "USER CONFIRMATION REQUIRED"
                || decideStatus === "USER CONFIRMATION BLOCKED"
              )
        )
      )
      || (
        reviewId === null
        && decisionId !== null
        && baselineId === null
        && regressionId === null
        && monitorStatus === "NO BASELINE"
        && (
          decideStatus === "HUMAN CONFIRMED REVIEW"
          || decideStatus === "MEMO REVIEW REQUIRED"
          || decideStatus === "NO APPROVED CANDIDATE"
        )
      )
      || (
        reviewId === null
        && decisionId !== null
        && baselineId !== null
        && decideStatus === "DECISION CONFIRMED"
        && (
          regressionId === null
            ? monitorStatus === "BASELINE ACTIVE"
            : [
                "BLOCK",
                "REVIEW",
                "PASS",
                "EVALUATION INCOMPLETE",
              ].includes(monitorStatus)
        )
      )
    )
  ));
  if (!authorityStateValid) {
    throw new WorkspaceProjectionError("workspace.stage_authority");
  }
  return Object.freeze({
    challengeId,
    benchmarkId,
    reviewId,
    decisionId,
    baselineId,
    regressionId,
    sourceHash: hash(projection.source_hash, "workspace.source_hash"),
    defineStatus,
    compareStatus,
    decideStatus,
    monitorStatus,
  });
}

export function parseLockedChallengeView(
  projection: BrowserPublicProjection,
): LockedChallengeView {
  if (
    projection.schema_version !== "challenge-public-projection-v1"
    || projection.state !== "LOCKED"
  ) throw new WorkspaceProjectionError("challenge");
  const task = record(projection.task_contract, "challenge.task_contract");
  const sourceManifest = record(
    projection.source_manifest,
    "challenge.source_manifest",
  );
  const sufficiency = record(projection.sufficiency, "challenge.sufficiency");
  const critical = record(sufficiency.critical_failures, "sufficiency.critical_failures");
  const validRuns = record(sufficiency.valid_runs, "sufficiency.valid_runs");
  const stability = record(sufficiency.repeat_stability, "sufficiency.repeat_stability");
  const reviews = record(sufficiency.open_reviews, "sufficiency.open_reviews");
  const cost = record(sufficiency.mean_runtime_cost_usd, "sufficiency.mean_runtime_cost_usd");
  const latency = record(sufficiency.latency_ms, "sufficiency.latency_ms");
  const sources = array(sourceManifest.sources, "challenge.source_manifest.sources")
    .map((raw, index) => {
      const source = record(raw, `source[${index}]`);
      if (source.synthetic !== true) throw new WorkspaceProjectionError(`source[${index}].synthetic`);
      return {
        source_id: string(source.source_id, `source[${index}].source_id`),
        source_type: string(source.source_type, `source[${index}].source_type`),
        title: string(source.title, `source[${index}].title`),
        content_sha256: string(source.content_sha256, `source[${index}].content_sha256`),
        synthetic: true as const,
      };
    });
  const constraints = array(projection.constraints, "challenge.constraints").map((raw, index) => {
    const item = record(raw, `constraint[${index}]`);
    return {
      constraint_id: string(item.constraint_id, `constraint[${index}].constraint_id`),
      text: string(item.text, `constraint[${index}].text`),
    };
  });
  const prohibited = array(projection.prohibited_actions, "challenge.prohibited_actions")
    .map((raw, index) => {
      const item = record(raw, `prohibition[${index}]`);
      return {
        prohibition_id: string(item.prohibition_id, `prohibition[${index}].prohibition_id`),
        text: string(item.text, `prohibition[${index}].text`),
      };
    });
  const criteria = array(projection.evaluation_criteria, "challenge.evaluation_criteria")
    .map((raw, index) => {
      const item = record(raw, `criterion[${index}]`);
      return {
        criterion_id: string(item.criterion_id, `criterion[${index}].criterion_id`),
        description: string(item.description, `criterion[${index}].description`),
        evidence_required: stringArray(item.evidence_required, `criterion[${index}].evidence_required`),
      };
    });
  const hardGates = array(projection.hard_gates, "challenge.hard_gates")
    .map((raw, index) => {
      const item = record(raw, `hard_gate[${index}]`);
      return {
        gate_id: string(item.gate_id, `hard_gate[${index}].gate_id`),
        failure_condition: string(item.failure_condition, `hard_gate[${index}].failure_condition`),
        required_evidence: stringArray(item.required_evidence, `hard_gate[${index}].required_evidence`),
      };
    });
  if (hardGates.length !== 4) throw new WorkspaceProjectionError("challenge.hard_gates");
  return Object.freeze({
    challenge_id: string(projection.challenge_id, "challenge.challenge_id"),
    challenge_version: string(projection.challenge_version, "challenge.challenge_version"),
    state: "LOCKED",
    source_hash: string(projection.source_hash, "challenge.source_hash"),
    locked_at: string(projection.locked_at, "challenge.locked_at"),
    approved_by: string(projection.approved_by, "challenge.approved_by"),
    approved_contract_hash: string(
      projection.approved_contract_hash,
      "challenge.approved_contract_hash",
    ),
    task_contract: {
      decision: string(task.decision, "task.decision"),
      input_contract: stringArray(task.input_contract, "task.input_contract"),
      output_contract: stringArray(task.output_contract, "task.output_contract"),
      allowed_source_ids: stringArray(task.allowed_source_ids, "task.allowed_source_ids"),
      operating_constraints: stringArray(task.operating_constraints, "task.operating_constraints"),
    },
    constraints,
    prohibited_actions: prohibited,
    source_manifest: {
      manifest_version: string(sourceManifest.manifest_version, "source_manifest.manifest_version"),
      sources,
    },
    evaluation_criteria: criteria,
    hard_gates: hardGates,
    sufficiency: {
      critical_failures: {
        maximum: number(critical.maximum, "critical.maximum"),
        total_cases: number(critical.total_cases, "critical.total_cases"),
      },
      valid_runs: {
        minimum: number(validRuns.minimum, "valid_runs.minimum"),
        total_runs: number(validRuns.total_runs, "valid_runs.total_runs"),
      },
      repeat_stability: {
        minimum_stable: number(stability.minimum_stable, "stability.minimum_stable"),
        total_cases: number(stability.total_cases, "stability.total_cases"),
      },
      open_reviews: { maximum: number(reviews.maximum, "reviews.maximum") },
      mean_runtime_cost_usd: { maximum: number(cost.maximum, "cost.maximum") },
      latency_ms: {
        median_maximum: number(latency.median_maximum, "latency.median_maximum"),
        worst_maximum: number(latency.worst_maximum, "latency.worst_maximum"),
      },
    },
  });
}

function parseAggregate(value: unknown, index: number): CompareCandidateAggregateView {
  const item = record(value, `aggregate[${index}]`);
  const candidateId = item.candidate_id;
  if (candidateId !== "A" && candidateId !== "B" && candidateId !== "C") {
    throw new WorkspaceProjectionError(`aggregate[${index}].candidate_id`);
  }
  const counts = record(item.counts, `aggregate[${index}].counts`);
  const cost = record(item.cost, `aggregate[${index}].cost`);
  const latency = record(item.latency, `aggregate[${index}].latency`);
  const stability = record(item.stability, `aggregate[${index}].stability`);
  const count = (name: string) => number(counts[name], `aggregate[${index}].counts.${name}`);
  return {
    candidate_id: candidateId,
    counts: {
      scheduled_runs: count("scheduled_runs"),
      complete_runs: count("complete_runs"),
      invalid_runs: count("invalid_runs"),
      timeout_runs: count("timeout_runs"),
      budget_exceeded_runs: count("budget_exceeded_runs"),
      hard_gate_failed_runs: count("hard_gate_failed_runs"),
      hard_gate_failed_cases: count("hard_gate_failed_cases"),
      policy_applicable_cases: count("policy_applicable_cases"),
      policy_success_cases: count("policy_success_cases"),
      citation_required_cases: count("citation_required_cases"),
      citation_success_cases: count("citation_success_cases"),
      escalation_required_cases: count("escalation_required_cases"),
      escalation_success_cases: count("escalation_success_cases"),
    },
    cost: {
      average_usd_per_ticket: cost.average_usd_per_ticket === null
        ? null
        : number(cost.average_usd_per_ticket, `aggregate[${index}].cost.average`),
    },
    latency: {
      median_ms: number(latency.median_ms, `aggregate[${index}].latency.median`),
      worst_ms: number(latency.worst_ms, `aggregate[${index}].latency.worst`),
    },
    stability: {
      comparable_cases: number(stability.comparable_cases, `aggregate[${index}].stability.comparable`),
      stable_cases: number(stability.stable_cases, `aggregate[${index}].stability.stable`),
      unstable_cases: number(stability.unstable_cases, `aggregate[${index}].stability.unstable`),
    },
  };
}

export function parseRecordedBenchmarkProgress(
  projection: BrowserPublicProjection,
  options: { readonly strictAuthority?: boolean } = {},
): RecordedBenchmarkProgressView {
  if (
    projection.schema_version !== "benchmark-progress-projection-v1"
    || projection.source !== "RECORDED_BENCHMARK"
    || projection.status !== "REVIEW_PENDING"
    || projection.completed !== 72
    || projection.total !== 72
  ) throw new WorkspaceProjectionError("benchmark");
  if (options.strictAuthority === true) {
    const forbiddenAuthorityKey =
      /^(?:locked_challenge_pack_hash|hidden_dataset_hash|schedule_id|checkpoint_hash|progress_event_hash|start_receipt_hash|private_mapping|label_to_candidate|(?:master|case)_blinding_seed)$/i;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        if (forbiddenAuthorityKey.test(key)) {
          throw new WorkspaceProjectionError("benchmark.private_authority");
        }
        visit(child);
      }
    };
    visit(projection);
    const allowed = new Set([
      "schema_version",
      "synthetic",
      "benchmark_id",
      "source_hash",
      "source",
      "status",
      "completed",
      "total",
      "review_time",
      "edit_time",
      "coverage",
      "costs",
      "candidate_aggregates",
      "slots",
    ]);
    if (
      Object.keys(projection).some((key) => !allowed.has(key))
      || !SHA256.test(String(projection.benchmark_id))
      || !SHA256.test(String(projection.source_hash))
      || !Object.hasOwn(projection, "coverage")
      || !Object.hasOwn(projection, "costs")
      || Object.hasOwn(projection, "queue")
    ) {
      throw new WorkspaceProjectionError("benchmark.authority");
    }
  }
  const slots: CompareSlotView[] = array(projection.slots, "benchmark.slots")
    .map((raw, index) => {
      const item = record(raw, `slot[${index}]`);
      if (
        options.strictAuthority === true
        && (
          Object.keys(item).length !== 9
          || Object.keys(item).some((key) => !new Set([
            "evidence_id",
            "case_id",
            "candidate_id",
            "repetition",
            "execution_status",
            "evaluation_status",
            "hard_gate_status",
            "cost_usd",
            "latency_ms",
          ]).has(key))
        )
      ) {
        throw new WorkspaceProjectionError(`slot[${index}].authority`);
      }
      const candidateId = item.candidate_id;
      const repetition = item.repetition;
      const hardGateStatus = item.hard_gate_status;
      if (
        (candidateId !== "A" && candidateId !== "B" && candidateId !== "C")
        || (repetition !== 1 && repetition !== 2)
        || !["PASS", "CONFIRMED_FAIL", "NOT_EVALUATED"].includes(String(hardGateStatus))
      ) throw new WorkspaceProjectionError(`slot[${index}]`);
      return {
        evidence_id: string(item.evidence_id, `slot[${index}].evidence_id`),
        case_id: string(item.case_id, `slot[${index}].case_id`),
        candidate_id: candidateId,
        repetition,
        execution_status: string(item.execution_status, `slot[${index}].execution_status`),
        evaluation_status: string(item.evaluation_status, `slot[${index}].evaluation_status`),
        hard_gate_status: hardGateStatus as CompareSlotView["hard_gate_status"],
        cost_usd: item.cost_usd === null ? null : number(item.cost_usd, `slot[${index}].cost_usd`),
        latency_ms: number(item.latency_ms, `slot[${index}].latency_ms`),
      };
    });
  const coordinates = new Set(slots.map((slot) => (
    `${slot.case_id}:${slot.candidate_id}:${slot.repetition}`
  )));
  // REVIEW_PENDING의 권한 없는 Compare view는 aggregate만 제공할 수 있습니다.
  // 빈 slots는 누락이 아니라 active X/Y/Z 검수와 후보·사례 좌표를 상관하지
  // 못하게 하는 의도적 redaction입니다.
  if (
    !(
      slots.length === 0
      || (slots.length === 72 && coordinates.size === 72)
    )
  ) {
    throw new WorkspaceProjectionError("benchmark.slots coverage");
  }
  const aggregates = array(
    projection.candidate_aggregates,
    "benchmark.candidate_aggregates",
  ).map(parseAggregate);
  if (
    aggregates.length !== 3
    || aggregates.map((item) => item.candidate_id).join("") !== "ABC"
  ) throw new WorkspaceProjectionError("benchmark.candidate_aggregates coverage");
  const coverage = record(projection.coverage, "benchmark.coverage");
  const completeJudgeCases = number(
    coverage.complete_judge_cases,
    "benchmark.coverage.complete_judge_cases",
  );
  const humanFallbackJudgeCases = number(
    coverage.human_fallback_judge_cases,
    "benchmark.coverage.human_fallback_judge_cases",
  );
  if (
    !Number.isInteger(completeJudgeCases)
    || !Number.isInteger(humanFallbackJudgeCases)
    || completeJudgeCases + humanFallbackJudgeCases !== 12
  ) {
    throw new WorkspaceProjectionError("benchmark.coverage.judge_cases");
  }
  return Object.freeze({
    benchmark_id: string(projection.benchmark_id, "benchmark.benchmark_id"),
    source_hash: string(projection.source_hash, "benchmark.source_hash"),
    source: "RECORDED_BENCHMARK",
    status: "REVIEW_PENDING",
    completed: 72,
    total: 72,
    review_time: string(projection.review_time, "benchmark.review_time"),
    edit_time: string(projection.edit_time, "benchmark.edit_time"),
    auxiliary_judge: {
      complete: completeJudgeCases,
      human_fallback: humanFallbackJudgeCases,
      total: 12 as const,
    },
    candidate_aggregates: aggregates,
    slots,
  });
}

export interface ParsedEvidenceRecord extends EvidenceRecord {
  readonly sourceHash: string;
  readonly regressionVersion?: "BASELINE_V1" | "PROPOSED_V2";
  readonly evidenceBindingHash?: string;
}

export function parseEvidenceRecord(
  projection: BrowserPublicProjection,
): ParsedEvidenceRecord {
  const kind = projection.kind;
  const source = projection.source;
  const status = projection.status;
  if (
    projection.schema_version !== "evidence-public-projection-v1"
    || projection.synthetic !== true
    || !SHA256.test(String(projection.source_hash))
    || !["benchmark", "blind-review", "regression"].includes(String(kind))
    || !["RECORDED BENCHMARK", "RECORDED REGRESSION", "BLIND HUMAN REVIEW"].includes(String(source))
    || typeof status !== "string"
  ) throw new WorkspaceProjectionError("evidence");
  if (
    kind === "blind-review"
    && (
      source !== "BLIND HUMAN REVIEW"
      || status !== "REVIEW REQUIRED"
      || !/^Candidate [XYZ]$/.test(String(projection.candidate_label))
      || blindEvidenceLeaksIdentity(projection)
    )
  ) {
    throw new WorkspaceProjectionError("evidence.blinding");
  }
  if (
    kind === "blind-review"
    && (
      projection.run_one !== undefined
      || projection.run_two !== undefined
      || projection.blind_detail !== undefined
    )
  ) {
    throw new WorkspaceProjectionError("evidence.blind_reviewer_detail");
  }
  let regressionVersion: "BASELINE_V1" | "PROPOSED_V2" | undefined;
  let evidenceBindingHash: string | undefined;
  if (source === "RECORDED REGRESSION") {
    if (
      kind !== "benchmark"
      || (
        projection.regression_version !== "BASELINE_V1"
        && projection.regression_version !== "PROPOSED_V2"
      )
    ) {
      throw new WorkspaceProjectionError("evidence.regression_binding");
    }
    regressionVersion = projection.regression_version;
    evidenceBindingHash = hash(
      projection.evidence_binding_hash,
      "evidence.evidence_binding_hash",
    );
  } else if (
    projection.regression_version !== undefined
    || projection.evidence_binding_hash !== undefined
  ) {
    throw new WorkspaceProjectionError("evidence.regression_binding");
  }
  return Object.freeze({
    sourceHash: hash(projection.source_hash, "evidence.source_hash"),
    id: string(projection.evidence_id, "evidence.evidence_id"),
    kind: kind as EvidenceRecord["kind"],
    title: string(projection.title, "evidence.title"),
    caseId: string(projection.case_id, "evidence.case_id"),
    candidateLabel: string(projection.candidate_label, "evidence.candidate_label"),
    source: source as EvidenceRecord["source"],
    status: status as EvidenceRecord["status"],
    caseSummary: string(projection.case_summary, "evidence.case_summary"),
    expectedDecision: string(projection.expected_decision, "evidence.expected_decision"),
    ...(typeof projection.candidate_output === "string" ? { candidateOutput: projection.candidate_output } : {}),
    ...(typeof projection.structured_decision === "string" ? { structuredDecision: projection.structured_decision } : {}),
    ...(Array.isArray(projection.policy_ids) ? { policyIds: stringArray(projection.policy_ids, "evidence.policy_ids") } : {}),
    ...(typeof projection.tool_evidence === "string" ? { toolEvidence: projection.tool_evidence } : {}),
    ...(Array.isArray(projection.deterministic_checks) ? { deterministicChecks: stringArray(projection.deterministic_checks, "evidence.checks") } : {}),
    ...(typeof projection.risk_signal === "string" ? { riskSignal: projection.risk_signal } : {}),
    ...(typeof projection.human_confirmation === "string" ? { humanConfirmation: projection.human_confirmation } : {}),
    ...(Array.isArray(projection.metadata) ? { metadata: stringArray(projection.metadata, "evidence.metadata") } : {}),
    ...(typeof projection.baseline_output === "string" ? { baselineOutput: projection.baseline_output } : {}),
    ...(typeof projection.proposed_output === "string" ? { proposedOutput: projection.proposed_output } : {}),
    ...(regressionVersion === undefined ? {} : { regressionVersion }),
    ...(evidenceBindingHash === undefined ? {} : { evidenceBindingHash }),
  });
}

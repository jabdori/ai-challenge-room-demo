import type { BrowserPublicProjection } from "./challengeApi";
import {
  parseLockedChallengeView,
  parseRecordedBenchmarkProgress,
} from "./workspaceProjection";
import type {
  CompareBenchmarkView,
  CompareCompleteTransitionView,
  CompareInvalidView,
  CompareCheckpointSource,
  CompareCleanupView,
  CompareLifecyclePhase,
  CompareReadyView,
  CompareResumeAction,
  CompareRunningView,
  CompareSlotView,
} from "../features/compare/CompareStage";
import type {
  DefineChallengeView,
  DefineConstraintView,
  DefineCriterionSuggestionView,
  DefineDraftView,
  DefineHardGateSuggestionView,
  DefineProhibitedActionView,
  DefineProposedView,
  DefineSourceItem,
  DefineSuggestionSummaryView,
  DefineTaskContractSuggestionView,
} from "../features/define/DefineStage";

type JsonRecord = Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_TYPES = new Set([
  "SYNTHETIC_POLICY_MANIFEST",
  "SYNTHETIC_PUBLIC_EXAMPLES",
  "SYNTHETIC_ORDER_SCHEMA",
]);
const CRITERION_IDS = [
  "FACT_POLICY_ACCURACY",
  "CITATION_GROUNDING",
  "POLICY_COMPLIANCE",
  "ESCALATION_DECISION",
  "RESPONSE_QUALITY",
  "REPEAT_STABILITY",
] as const;
const HARD_GATE_IDS = [
  "P0-HG-01",
  "P0-HG-02",
  "P0-HG-03",
  "P0-HG-04",
] as const;
const RESUME_ACTIONS = new Set<CompareResumeAction>([
  "NONE",
  "CONTINUE_FROM_PERSISTED_CHECKPOINTS",
  "RETRY_CLEANUP",
  "RESTART_AFTER_FIX",
]);
const FAILURE_PHASES = new Set<CompareLifecyclePhase>([
  "BENCHMARK",
  "JUDGE",
  "CLEANUP",
]);
const CHECKPOINT_SOURCES = new Set<CompareCheckpointSource>([
  "EXECUTED",
  "RECOMPUTED_GATES",
  "REUSED_CHECKPOINT",
]);
const EXECUTION_STATUSES = new Set(["QUEUED", "COMPLETE", "INVALID", "TIMEOUT", "BUDGET_EXCEEDED"]);
const EVALUATION_STATUSES = new Set(["EVALUATED", "NOT_EVALUATED"]);
const GATE_STATUSES = new Set(["PASS", "CONFIRMED_FAIL", "NOT_EVALUATED"]);

export const BENCHMARK_PROGRESS_POLL_INTERVAL_MS = 750;

export class LifecycleProjectionError extends Error {
  readonly code = "LIFECYCLE_PROJECTION_INVALID" as const;

  constructor(location: string) {
    super(`${location} lifecycle 공개 projection 계약이 올바르지 않습니다.`);
    this.name = "LifecycleProjectionError";
  }
}

function record(value: unknown, location: string): JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new LifecycleProjectionError(location);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  location: string,
): void {
  const actual = Object.keys(value).sort();
  const locked = [...expected].sort();
  if (
    actual.length !== locked.length
    || actual.some((key, index) => key !== locked[index])
  ) {
    throw new LifecycleProjectionError(location);
  }
}

function text(value: unknown, location: string): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > 100_000
    || /\p{Cc}/u.test(value)
  ) {
    throw new LifecycleProjectionError(location);
  }
  return value;
}

function safeId(value: unknown, location: string): string {
  const parsed = text(value, location);
  if (!SAFE_ID.test(parsed)) throw new LifecycleProjectionError(location);
  return parsed;
}

function hash(value: unknown, location: string): string {
  const parsed = text(value, location);
  if (!SHA256.test(parsed)) throw new LifecycleProjectionError(location);
  return parsed;
}

function nonnegativeInteger(
  value: unknown,
  location: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || value > maximum
  ) {
    throw new LifecycleProjectionError(location);
  }
  return value;
}

function nonnegativeNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new LifecycleProjectionError(location);
  }
  return value;
}

function isoTimestamp(value: unknown, location: string): string {
  const parsed = text(value, location);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new LifecycleProjectionError(location);
  }
  return parsed;
}

function array(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new LifecycleProjectionError(location);
  }
  return value;
}

function stringArray(value: unknown, location: string): string[] {
  const parsed = array(value, location).map((item, index) => (
    text(item, `${location}[${index}]`)
  ));
  if (parsed.length === 0 || new Set(parsed).size !== parsed.length) {
    throw new LifecycleProjectionError(location);
  }
  return parsed;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function parseConstraint(
  value: unknown,
  index: number,
): DefineConstraintView {
  const location = `challenge.constraints[${index}]`;
  const item = record(value, location);
  exactKeys(item, ["constraint_id", "text"], location);
  return {
    constraint_id: safeId(item.constraint_id, `${location}.constraint_id`),
    text: text(item.text, `${location}.text`),
  };
}

function parseProhibitedAction(
  value: unknown,
  index: number,
): DefineProhibitedActionView {
  const location = `challenge.prohibited_actions[${index}]`;
  const item = record(value, location);
  exactKeys(item, ["prohibition_id", "text"], location);
  return {
    prohibition_id: safeId(
      item.prohibition_id,
      `${location}.prohibition_id`,
    ),
    text: text(item.text, `${location}.text`),
  };
}

function parseSource(
  value: unknown,
  index: number,
): DefineSourceItem {
  const location = `challenge.source_manifest.sources[${index}]`;
  const item = record(value, location);
  exactKeys(item, [
    "source_id",
    "source_type",
    "title",
    "content_sha256",
    "synthetic",
  ], location);
  if (
    item.synthetic !== true
    || !SOURCE_TYPES.has(String(item.source_type))
  ) {
    throw new LifecycleProjectionError(location);
  }
  return {
    source_id: safeId(item.source_id, `${location}.source_id`),
    source_type: String(item.source_type),
    title: text(item.title, `${location}.title`),
    content_sha256: hash(
      item.content_sha256,
      `${location}.content_sha256`,
    ),
    synthetic: true,
  };
}

function parseTaskContract(
  value: unknown,
  allowedSourceIds: ReadonlySet<string>,
): DefineTaskContractSuggestionView {
  const location = "challenge.suggestion_summary.task_contract";
  const task = record(value, location);
  exactKeys(task, [
    "decision",
    "input_contract",
    "output_contract",
    "allowed_source_ids",
    "operating_constraints",
  ], location);
  const sourceIds = stringArray(
    task.allowed_source_ids,
    `${location}.allowed_source_ids`,
  );
  if (sourceIds.some((sourceId) => !allowedSourceIds.has(sourceId))) {
    throw new LifecycleProjectionError(`${location}.allowed_source_ids`);
  }
  return {
    decision: text(task.decision, `${location}.decision`),
    input_contract: stringArray(
      task.input_contract,
      `${location}.input_contract`,
    ),
    output_contract: stringArray(
      task.output_contract,
      `${location}.output_contract`,
    ),
    allowed_source_ids: sourceIds,
    operating_constraints: stringArray(
      task.operating_constraints,
      `${location}.operating_constraints`,
    ),
  };
}

function parseCriterion(
  value: unknown,
  index: number,
): DefineCriterionSuggestionView {
  const location = `challenge.suggestion_summary.evaluation_criteria[${index}]`;
  const item = record(value, location);
  exactKeys(item, [
    "criterion_id",
    "description",
    "evidence_required",
  ], location);
  if (item.criterion_id !== CRITERION_IDS[index]) {
    throw new LifecycleProjectionError(`${location}.criterion_id`);
  }
  return {
    criterion_id: CRITERION_IDS[index],
    description: text(item.description, `${location}.description`),
    evidence_required: stringArray(
      item.evidence_required,
      `${location}.evidence_required`,
    ),
  };
}

function parseHardGate(
  value: unknown,
  index: number,
): DefineHardGateSuggestionView {
  const location = `challenge.suggestion_summary.hard_gates[${index}]`;
  const item = record(value, location);
  exactKeys(item, [
    "gate_id",
    "failure_condition",
    "required_evidence",
  ], location);
  if (item.gate_id !== HARD_GATE_IDS[index]) {
    throw new LifecycleProjectionError(`${location}.gate_id`);
  }
  return {
    gate_id: HARD_GATE_IDS[index],
    failure_condition: text(
      item.failure_condition,
      `${location}.failure_condition`,
    ),
    required_evidence: stringArray(
      item.required_evidence,
      `${location}.required_evidence`,
    ),
  };
}

function parseSuggestion(
  value: unknown,
  sourceIds: ReadonlySet<string>,
): DefineSuggestionSummaryView {
  const location = "challenge.suggestion_summary";
  const suggestion = record(value, location);
  exactKeys(suggestion, [
    "artifact_hash",
    "artifact_kind",
    "authority",
    "task_contract",
    "evaluation_criteria",
    "hard_gates",
    "limitations",
  ], location);
  if (
    suggestion.artifact_kind !== "DEFINE_SUGGESTION"
    || suggestion.authority !== "ADVISORY_ONLY"
  ) {
    throw new LifecycleProjectionError(location);
  }
  const criteria = array(
    suggestion.evaluation_criteria,
    `${location}.evaluation_criteria`,
  );
  const hardGates = array(
    suggestion.hard_gates,
    `${location}.hard_gates`,
  );
  if (
    criteria.length !== CRITERION_IDS.length
    || hardGates.length !== HARD_GATE_IDS.length
  ) {
    throw new LifecycleProjectionError(location);
  }
  return {
    artifact_hash: hash(
      suggestion.artifact_hash,
      `${location}.artifact_hash`,
    ),
    artifact_kind: "DEFINE_SUGGESTION",
    authority: "ADVISORY_ONLY",
    task_contract: parseTaskContract(suggestion.task_contract, sourceIds),
    evaluation_criteria: criteria.map(parseCriterion),
    hard_gates: hardGates.map(parseHardGate),
    limitations: stringArray(
      suggestion.limitations,
      `${location}.limitations`,
    ),
  };
}

function parseDefineLifecycleCommon(projection: JsonRecord) {
  const business = record(
    projection.business_brief,
    "challenge.business_brief",
  );
  exactKeys(business, [
    "title",
    "decision",
    "workflow",
    "intended_users",
    "locale",
  ], "challenge.business_brief");
  if (business.locale !== "en-US") {
    throw new LifecycleProjectionError("challenge.business_brief.locale");
  }
  const title = text(projection.title, "challenge.title");
  const businessTitle = text(
    business.title,
    "challenge.business_brief.title",
  );
  if (title !== businessTitle) {
    throw new LifecycleProjectionError("challenge.title");
  }
  const constraints = array(
    projection.constraints,
    "challenge.constraints",
  ).map(parseConstraint);
  const prohibited = array(
    projection.prohibited_actions,
    "challenge.prohibited_actions",
  ).map(parseProhibitedAction);
  if (
    constraints.length === 0
    || prohibited.length === 0
    || new Set(constraints.map((item) => item.constraint_id)).size
      !== constraints.length
    || new Set(prohibited.map((item) => item.prohibition_id)).size
      !== prohibited.length
  ) {
    throw new LifecycleProjectionError("challenge boundaries");
  }
  const manifest = record(
    projection.source_manifest,
    "challenge.source_manifest",
  );
  exactKeys(
    manifest,
    ["manifest_version", "sources"],
    "challenge.source_manifest",
  );
  if (manifest.manifest_version !== "define-source-manifest-v1") {
    throw new LifecycleProjectionError(
      "challenge.source_manifest.manifest_version",
    );
  }
  const sources = array(
    manifest.sources,
    "challenge.source_manifest.sources",
  ).map(parseSource);
  if (
    sources.length === 0
    || new Set(sources.map((item) => item.source_id)).size !== sources.length
  ) {
    throw new LifecycleProjectionError("challenge.source_manifest.sources");
  }
  return {
    challenge_id: safeId(
      projection.challenge_id,
      "challenge.challenge_id",
    ),
    challenge_version: safeId(
      projection.challenge_version,
      "challenge.challenge_version",
    ),
    source_hash: hash(projection.source_hash, "challenge.source_hash"),
    title,
    business_brief: {
      title: businessTitle,
      decision: text(
        business.decision,
        "challenge.business_brief.decision",
      ),
      workflow: text(
        business.workflow,
        "challenge.business_brief.workflow",
      ),
      intended_users: stringArray(
        business.intended_users,
        "challenge.business_brief.intended_users",
      ),
      locale: "en-US" as const,
    },
    constraints,
    prohibited_actions: prohibited,
    source_manifest: {
      manifest_version: "define-source-manifest-v1" as const,
      sources,
    },
  };
}

export function parseDefineLifecycleProjection(
  projection: BrowserPublicProjection,
): DefineChallengeView {
  if (projection.state === "LOCKED") {
    const raw = record(projection, "challenge.LOCKED");
    // 이미 배포된 recorded workflow의 LOCKED projection은 lifecycle 보강 필드가
    // 없지만 같은 공개 Challenge 계약입니다. Define lifecycle로 승격하기 전의
    // immutable projection은 기존 strict parser로 유지합니다.
    if (!Object.hasOwn(raw, "business_brief")) {
      return parseLockedChallengeView(projection);
    }
    const legacyKeys = [
      "schema_version",
      "synthetic",
      "challenge_id",
      "challenge_version",
      "state",
      "authority",
      "source_hash",
      "locked_at",
      "approved_by",
      "task_contract",
      "constraints",
      "prohibited_actions",
      "source_manifest",
      "evaluation_criteria",
      "hard_gates",
      "candidate_complexity_profiles",
      "sufficiency",
      "approved_contract_hash",
      "source_manifest_hash",
    ] as const;
    const lifecycleKeys = [
      ...legacyKeys,
      "title",
      "business_brief",
      "define_status",
      "suggestion_summary",
    ] as const;
    const lifecycleShape = true;
    exactKeys(
      raw,
      lifecycleShape ? lifecycleKeys : legacyKeys,
      "challenge.LOCKED",
    );
    if (
      raw.synthetic !== true
      || raw.authority !== "EXPLICIT_HUMAN_APPROVAL"
      || (lifecycleShape && raw.define_status !== "SUGGESTION_READY")
    ) {
      throw new LifecycleProjectionError("challenge.LOCKED.authority");
    }
    hash(raw.source_hash, "challenge.LOCKED.source_hash");
    hash(
      raw.approved_contract_hash,
      "challenge.LOCKED.approved_contract_hash",
    );
    hash(
      raw.source_manifest_hash,
      "challenge.LOCKED.source_manifest_hash",
    );
    if (lifecycleShape) {
      const common = parseDefineLifecycleCommon(raw);
      parseSuggestion(
        raw.suggestion_summary,
        new Set(
          common.source_manifest.sources.map((source) => source.source_id),
        ),
      );
    }
    return parseLockedChallengeView(projection);
  }
  const raw = record(projection, "challenge");
  exactKeys(raw, [
    "schema_version",
    "synthetic",
    "challenge_id",
    "challenge_version",
    "source_hash",
    "state",
    "authority",
    "title",
    "business_brief",
    "constraints",
    "prohibited_actions",
    "source_manifest",
    "define_status",
    "suggestion_summary",
    "approved_contract_hash",
  ], "challenge");
  if (
    raw.schema_version !== "challenge-public-projection-v1"
    || raw.synthetic !== true
  ) {
    throw new LifecycleProjectionError("challenge");
  }
  const common = parseDefineLifecycleCommon(raw);
  if (raw.state === "DRAFT") {
    if (
      raw.authority !== "NONE"
      || !["NOT_STARTED", "STRUCTURING", "INVALID"]
        .includes(String(raw.define_status))
      || raw.suggestion_summary !== null
      || raw.approved_contract_hash !== null
    ) {
      throw new LifecycleProjectionError("challenge.DRAFT");
    }
    return deepFreeze({
      ...common,
      state: "DRAFT",
      authority: "NONE",
      define_status: raw.define_status,
      suggestion_summary: null,
      approved_contract_hash: null,
    } as DefineDraftView);
  }
  if (
    raw.state !== "PROPOSED"
    || raw.authority !== "ADVISORY_ONLY"
    || raw.define_status !== "SUGGESTION_READY"
  ) {
    throw new LifecycleProjectionError("challenge.PROPOSED");
  }
  const sourceIds = new Set(
    common.source_manifest.sources.map((source) => source.source_id),
  );
  return deepFreeze({
    ...common,
    state: "PROPOSED",
    authority: "ADVISORY_ONLY",
    define_status: "SUGGESTION_READY",
    suggestion_summary: parseSuggestion(raw.suggestion_summary, sourceIds),
    approved_contract_hash: hash(
      raw.approved_contract_hash,
      "challenge.approved_contract_hash",
    ),
  } satisfies DefineProposedView);
}

function parseTerminalSlot(
  value: unknown,
  index: number,
): CompareSlotView {
  const location = `benchmark.terminal_slots[${index}]`;
  const slot = record(value, location);
  exactKeys(slot, [
    "evidence_id",
    "case_id",
    "candidate_id",
    "repetition",
    "execution_status",
    "evaluation_status",
    "hard_gate_status",
    "cost_usd",
    "latency_ms",
  ], location);
  if (
    !["A", "B", "C"].includes(String(slot.candidate_id))
    || (slot.repetition !== 1 && slot.repetition !== 2)
    || !EXECUTION_STATUSES.has(String(slot.execution_status))
    || !EVALUATION_STATUSES.has(String(slot.evaluation_status))
    || !GATE_STATUSES.has(String(slot.hard_gate_status))
  ) {
    throw new LifecycleProjectionError(location);
  }
  return {
    evidence_id: safeId(slot.evidence_id, `${location}.evidence_id`),
    case_id: safeId(slot.case_id, `${location}.case_id`),
    candidate_id: slot.candidate_id as "A" | "B" | "C",
    repetition: slot.repetition,
    execution_status: String(slot.execution_status),
    evaluation_status: String(slot.evaluation_status),
    hard_gate_status: slot.hard_gate_status as CompareSlotView["hard_gate_status"],
    cost_usd: slot.cost_usd === null
      ? null
      : nonnegativeNumber(slot.cost_usd, `${location}.cost_usd`),
    latency_ms: nonnegativeInteger(
      slot.latency_ms,
      `${location}.latency_ms`,
    ),
  };
}

function parseCanonicalLifecycleBenchmark(
  projection: JsonRecord,
): CompareReadyView | CompareRunningView | CompareCompleteTransitionView | CompareInvalidView {
  const status = projection.status;
  const schemaByStatus: Record<string, string> = {
    READY: "benchmark-lifecycle-ready-projection-v1",
    RUNNING: "benchmark-lifecycle-projection-v1",
    COMPLETE: "benchmark-lifecycle-projection-v1",
    INVALID: "benchmark-lifecycle-invalid-projection-v1",
  };
  if (typeof status !== "string" || schemaByStatus[status] !== projection.schema_version) {
    throw new LifecycleProjectionError("benchmark.schema_version");
  }
  const allowed = [
    "schema_version", "synthetic", "source", "benchmark_id", "status",
    "completed", "total", "last_slot_sequence", "checkpoint_source",
    "cleanup",
    ...(status === "INVALID" ? ["failure", "resume"] : []),
    "source_hash",
  ];
  exactKeys(projection, allowed, "benchmark");
  if (projection.synthetic !== true || projection.source !== "RECORDED_BENCHMARK") {
    throw new LifecycleProjectionError("benchmark.authority");
  }
  const benchmarkId = hash(projection.benchmark_id, "benchmark.benchmark_id");
  const sourceHash = hash(projection.source_hash, "benchmark.source_hash");
  const completed = nonnegativeInteger(projection.completed, "benchmark.completed", 72);
  if (projection.total !== 72) throw new LifecycleProjectionError("benchmark.total");
  const last = projection.last_slot_sequence;
  if (last !== null && (!Number.isSafeInteger(last) || last !== completed)) {
    throw new LifecycleProjectionError("benchmark.last_slot_sequence");
  }
  const checkpoint = projection.checkpoint_source;
  if (checkpoint !== null && !CHECKPOINT_SOURCES.has(checkpoint as CompareCheckpointSource)) {
    throw new LifecycleProjectionError("benchmark.checkpoint_source");
  }
  let cleanup: CompareCleanupView | null = null;
  if (projection.cleanup !== null) {
    const value = record(projection.cleanup, "benchmark.cleanup");
    exactKeys(value, ["required", "acknowledged", "incomplete"], "benchmark.cleanup");
    const acknowledged = nonnegativeInteger(value.acknowledged, "benchmark.cleanup.acknowledged", 33);
    const incomplete = nonnegativeInteger(value.incomplete, "benchmark.cleanup.incomplete", 33);
    if (value.required !== 33 || acknowledged + incomplete !== 33) {
      throw new LifecycleProjectionError("benchmark.cleanup");
    }
    cleanup = { required: 33, acknowledged, incomplete };
  }
  const base = {
    benchmark_id: benchmarkId,
    source_hash: sourceHash,
    source: "RECORDED_BENCHMARK" as const,
    completed,
    total: 72 as const,
    last_slot_sequence: last as number | null,
    checkpoint_source: checkpoint as CompareCheckpointSource | null,
    cleanup,
  };
  if (status === "READY") {
    if (completed !== 0 || last !== null || checkpoint !== null || cleanup !== null) {
      throw new LifecycleProjectionError("benchmark.READY");
    }
    return deepFreeze({ ...base, status: "READY", completed: 0 as const, last_slot_sequence: null, checkpoint_source: null, cleanup: null });
  }
  if (status === "RUNNING") {
    const beforeFirstCheckpoint = completed === 0
      && last === null
      && checkpoint === null;
    const afterCheckpoint = completed > 0
      && completed <= 72
      && last !== null
      && checkpoint !== null;
    if (cleanup !== null || (!beforeFirstCheckpoint && !afterCheckpoint)) {
      throw new LifecycleProjectionError("benchmark.RUNNING");
    }
    return deepFreeze({ ...base, status: "RUNNING", cleanup: null });
  }
  if (status === "COMPLETE") {
    if (completed !== 72 || last !== 72 || cleanup === null || cleanup.incomplete !== 0) {
      throw new LifecycleProjectionError("benchmark.COMPLETE");
    }
    return deepFreeze({ ...base, status: "COMPLETE", completed: 72 as const, last_slot_sequence: 72 as const, cleanup });
  }
  const failure = record(projection.failure, "benchmark.failure");
  exactKeys(failure, ["code", "phase"], "benchmark.failure");
  if (!FAILURE_PHASES.has(failure.phase as CompareLifecyclePhase)) throw new LifecycleProjectionError("benchmark.failure.phase");
  const resume = record(projection.resume, "benchmark.resume");
  exactKeys(resume, ["allowed", "action"], "benchmark.resume");
  if (resume.allowed !== true || !RESUME_ACTIONS.has(resume.action as CompareResumeAction)) throw new LifecycleProjectionError("benchmark.resume");
  return deepFreeze({
    ...base,
    status: "INVALID",
    failure: { code: safeId(failure.code, "benchmark.failure.code"), phase: failure.phase as CompareLifecyclePhase },
    resume: { allowed: true as const, action: resume.action as CompareResumeAction },
  });
}

function parseLifecycleBenchmark(
  projection: JsonRecord,
):
  | CompareReadyView
  | CompareRunningView
  | CompareCompleteTransitionView
  | CompareInvalidView {
  exactKeys(projection, [
    "schema_version",
    "synthetic",
    "benchmark_id",
    "challenge_id",
    "source_hash",
    "status",
    "candidate_execution",
    "auxiliary_judge",
    "cleanup",
    "attempt_number",
    "started_at",
    "updated_at",
    "single_flight",
    "resume",
    "failure",
    "terminal_slots",
  ], "benchmark");
  if (
    projection.schema_version !== "benchmark-progress-projection-v1"
    || projection.synthetic !== true
    || !["READY", "RUNNING", "COMPLETE", "INVALID"]
      .includes(String(projection.status))
  ) {
    throw new LifecycleProjectionError("benchmark");
  }
  const candidateExecution = record(
    projection.candidate_execution,
    "benchmark.candidate_execution",
  );
  exactKeys(
    candidateExecution,
    ["completed", "total"],
    "benchmark.candidate_execution",
  );
  const completed = nonnegativeInteger(
    candidateExecution.completed,
    "benchmark.candidate_execution.completed",
    72,
  );
  if (candidateExecution.total !== 72) {
    throw new LifecycleProjectionError("benchmark.candidate_execution.total");
  }
  const judge = record(
    projection.auxiliary_judge,
    "benchmark.auxiliary_judge",
  );
  exactKeys(judge, ["completed", "total"], "benchmark.auxiliary_judge");
  const judgeCompleted = nonnegativeInteger(
    judge.completed,
    "benchmark.auxiliary_judge.completed",
    12,
  );
  if (judge.total !== 12) {
    throw new LifecycleProjectionError("benchmark.auxiliary_judge.total");
  }
  const cleanup = record(projection.cleanup, "benchmark.cleanup");
  exactKeys(
    cleanup,
    ["required", "acknowledged", "incomplete"],
    "benchmark.cleanup",
  );
  if (cleanup.required !== 33) {
    throw new LifecycleProjectionError("benchmark.cleanup.required");
  }
  const acknowledged = nonnegativeInteger(
    cleanup.acknowledged,
    "benchmark.cleanup.acknowledged",
    33,
  );
  const incomplete = nonnegativeInteger(
    cleanup.incomplete,
    "benchmark.cleanup.incomplete",
    33,
  );
  if (acknowledged + incomplete !== 33) {
    throw new LifecycleProjectionError("benchmark.cleanup");
  }
  const terminalSlots = array(
    projection.terminal_slots,
    "benchmark.terminal_slots",
  ).map(parseTerminalSlot);
  const coordinates = terminalSlots.map((slot) => (
    `${slot.case_id}:${slot.candidate_id}:${slot.repetition}`
  ));
  if (
    terminalSlots.length !== completed
    || new Set(coordinates).size !== coordinates.length
    || new Set(terminalSlots.map((slot) => slot.evidence_id)).size
      !== terminalSlots.length
  ) {
    throw new LifecycleProjectionError("benchmark.terminal_slots");
  }
  const resume = record(projection.resume, "benchmark.resume");
  exactKeys(
    resume,
    ["allowed", "action", "from_progress_hash"],
    "benchmark.resume",
  );
  if (
    typeof resume.allowed !== "boolean"
    || !RESUME_ACTIONS.has(resume.action as CompareResumeAction)
  ) {
    throw new LifecycleProjectionError("benchmark.resume");
  }
  let resumeHash: string | null;
  if (resume.allowed) {
    if (resume.action === "NONE") {
      throw new LifecycleProjectionError("benchmark.resume.action");
    }
    resumeHash = hash(
      resume.from_progress_hash,
      "benchmark.resume.from_progress_hash",
    );
  } else {
    if (resume.action !== "NONE" || resume.from_progress_hash !== null) {
      throw new LifecycleProjectionError("benchmark.resume");
    }
    resumeHash = null;
  }
  let failure: {
    readonly code: string;
    readonly phase: CompareLifecyclePhase;
  } | null = null;
  if (projection.failure !== null) {
    const rawFailure = record(projection.failure, "benchmark.failure");
    exactKeys(rawFailure, ["code", "phase"], "benchmark.failure");
    if (!FAILURE_PHASES.has(rawFailure.phase as CompareLifecyclePhase)) {
      throw new LifecycleProjectionError("benchmark.failure.phase");
    }
    failure = {
      code: safeId(rawFailure.code, "benchmark.failure.code"),
      phase: rawFailure.phase as CompareLifecyclePhase,
    };
  }
  const status = projection.status as
    | "READY"
    | "RUNNING"
    | "COMPLETE"
    | "INVALID";
  const attemptNumber = nonnegativeInteger(
    projection.attempt_number,
    "benchmark.attempt_number",
  );
  const startedAt = projection.started_at === null
    ? null
    : isoTimestamp(projection.started_at, "benchmark.started_at");
  const updatedAt = isoTimestamp(
    projection.updated_at,
    "benchmark.updated_at",
  );
  if (typeof projection.single_flight !== "boolean") {
    throw new LifecycleProjectionError("benchmark.single_flight");
  }

  if (
    (status === "READY" && (
      completed !== 0
      || judgeCompleted !== 0
      || acknowledged !== 0
      || attemptNumber !== 0
      || startedAt !== null
      || projection.single_flight
      || failure !== null
      || resume.allowed
    ))
    || (status === "RUNNING" && (
      attemptNumber < 1
      || startedAt === null
      || projection.single_flight !== true
      || failure !== null
      || resume.allowed
    ))
    || (status === "COMPLETE" && (
      completed !== 72
      || judgeCompleted !== 12
      || acknowledged !== 33
      || incomplete !== 0
      || attemptNumber < 1
      || startedAt === null
      || projection.single_flight
      || failure !== null
      || resume.allowed
    ))
    || (status === "INVALID" && (
      projection.single_flight
      || failure === null
    ))
  ) {
    throw new LifecycleProjectionError(`benchmark.${status}`);
  }

  return deepFreeze({
    benchmark_id: hash(projection.benchmark_id, "benchmark.benchmark_id"),
    source: "RECORDED_BENCHMARK" as const,
    completed,
    total: 72 as const,
    last_slot_sequence: terminalSlots.length === 0 ? null : terminalSlots.length,
    checkpoint_source: terminalSlots.length === 0 ? null : "EXECUTED" as const,
    challenge_id: safeId(
      projection.challenge_id,
      "benchmark.challenge_id",
    ),
    source_hash: hash(projection.source_hash, "benchmark.source_hash"),
    status,
    candidate_execution: { completed, total: 72 },
    auxiliary_judge: { completed: judgeCompleted, total: 12 },
    cleanup: { required: 33, acknowledged, incomplete },
    attempt_number: attemptNumber,
    started_at: startedAt,
    updated_at: updatedAt,
    single_flight: projection.single_flight,
    resume: {
      allowed: resume.allowed,
      action: resume.action as CompareResumeAction,
      from_progress_hash: resumeHash,
    },
    failure,
    terminal_slots: terminalSlots,
  }) as unknown as
    | CompareReadyView
    | CompareRunningView
    | CompareCompleteTransitionView
    | CompareInvalidView;
}

export function parseCompareLifecycleProjection(
  projection: BrowserPublicProjection,
  options: { readonly strictAuthority?: boolean } = { strictAuthority: true },
): CompareBenchmarkView {
  if (projection.status === "REVIEW_PENDING") {
    return parseRecordedBenchmarkProgress(projection, {
      strictAuthority: options.strictAuthority !== false,
    });
  }
  if (
    projection.schema_version === "benchmark-lifecycle-ready-projection-v1"
    || projection.schema_version === "benchmark-lifecycle-projection-v1"
    || projection.schema_version === "benchmark-lifecycle-invalid-projection-v1"
  ) {
    return parseCanonicalLifecycleBenchmark(record(projection, "benchmark"));
  }
  return parseLifecycleBenchmark(record(projection, "benchmark"));
}

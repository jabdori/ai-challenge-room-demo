import {
  FINAL_DECISION_MEMO_PUBLIC_BODY_SCHEMA_VERSION,
  finalDecisionMemoPublicBodyPayload,
  sha256CanonicalPublicJson,
} from "../../../shared/finalDecisionMemoPublicBody";
import {
  parseRecordedHardGateMatrixProjection,
  type RecordedHardGateMatrixView,
} from "../decision/recordedHardGateMatrixContract";

type JsonRecord = Record<string, unknown>;
type CandidateId = "A" | "B" | "C";
type BlindLabel = "X" | "Y" | "Z";

const SHA256 = /^[a-f0-9]{64}$/;
const EVIDENCE_HANDLE = /^evh_[a-f0-9]{64}$/;

export class RecordedWorkflowProjectionError extends Error {
  readonly code = "RECORDED_WORKFLOW_PROJECTION_INVALID" as const;

  constructor(location: string) {
    super(`${location} 기록 projection 계약이 올바르지 않습니다.`);
    this.name = "RecordedWorkflowProjectionError";
  }
}

function fail(location: string): never {
  throw new RecordedWorkflowProjectionError(location);
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
  ) fail(location);
  return value as JsonRecord;
}

function exact(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  location: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) fail(location);
}

function text(value: unknown, location: string): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || /\p{Cc}/u.test(value)
  ) fail(location);
  return value;
}

function hash(value: unknown, location: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(location);
  return value;
}

function count(value: unknown, location: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(location);
  return value as number;
}

function nonnegativeNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(location);
  }
  return value;
}

function nullableNumber(value: unknown, location: string): number | null {
  return value === null ? null : nonnegativeNumber(value, location);
}

function array(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) fail(location);
  return value;
}

function stringArray(value: unknown, location: string): string[] {
  return array(value, location).map((item, index) => (
    text(item, `${location}[${index}]`)
  ));
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  location: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(location);
  return value as T;
}

function nullableHash(value: unknown, location: string): string | null {
  return value === null ? null : hash(value, location);
}

function nullableId(value: unknown, location: string): string | null {
  return value === null ? null : text(value, location);
}

function candidateId(value: unknown, location: string): CandidateId {
  return enumValue(value, ["A", "B", "C"], location);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function containsBlindIdentityOrArchitectureHint(value: unknown): boolean {
  const normalized = JSON.stringify(value)
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase();
  const tokenized = normalized
    .replace(/[\p{Pd}_]+/gu, " ")
    .replace(/[\p{Z}\s]+/gu, " ");
  const compact = tokenized.replace(/[^a-z0-9]/g, "");
  const compactPatterns = [
    /candidate[abc]/,
    /system[abc]/,
    /configuration[abc]/,
    /config[abc]/,
    /model[abc]/,
    /getorder/,
    /searchpolicy/,
    /retriev/,
    /vector/,
    /toolagent/,
    /readonlytool/,
    /agentic/,
    /functioncall/,
    /toolcall/,
    /largelanguagemodel/,
    /promptonly/,
    /promptbased/,
    /systemprompt/,
    /searchindex/,
    /semanticindex/,
    /embeddingindex/,
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
  ] as const;
  return compactPatterns.some((pattern) => pattern.test(compact))
    || /(?:^|[^a-z0-9])[xyz]\s*(?:=|is|maps?\s*to)\s*(?:candidate\s*)?[abc](?:$|[^a-z0-9])/i
      .test(tokenized)
    || /(?:^|[^a-z0-9])r\s*a\s*g(?:$|[^a-z0-9])/i.test(tokenized)
    || /(?:^|[^a-z0-9])l\s*l\s*m(?:$|[^a-z0-9])/i.test(tokenized)
    || /(?:^|[^a-z0-9])(?:tool|agent)(?:$|[^a-z0-9])/i.test(tokenized);
}

export interface RecordedPreconfirmationItemView {
  readonly itemId: string;
  readonly evidenceId: string;
  readonly queueIndex: number;
  readonly caseId: string;
  readonly blindLabel: BlindLabel;
  readonly candidateLabel: `Candidate ${BlindLabel}`;
  readonly queueReason:
    | "LOCKED_HIGH_RISK"
    | "JUDGE_RISK"
    | "JUDGE_INCOMPLETE_FALLBACK";
  readonly proposedDecision:
    | "PROPOSED_PASS"
    | "PROPOSED_CONFIRMED_FAIL"
    | "ABSTAIN";
  readonly rationale: string;
  readonly evidenceHandles: readonly string[];
  readonly reviewEvidenceHandle: string;
  readonly reviewStatus: "REVIEW_REQUIRED";
}

export interface RecordedPreconfirmationView {
  readonly reviewId: string;
  readonly sourceHash: string;
  readonly recordedBenchmarkPackHash: string;
  readonly aiPreReviewReceiptHash: string;
  readonly provisionalDecisionMemoHash: string;
  readonly queueContentHash: string;
  readonly queueSetOrderHash: string;
  readonly preReviewStatus:
    | "USER_CONFIRMATION_READY"
    | "USER_CONFIRMATION_BLOCKED";
  readonly blockingReasons: readonly string[];
  readonly advisoryOnly: true;
  readonly humanConfirmed: false;
  readonly baselineVersion: null;
  readonly total: number;
  readonly completed: 0;
  readonly remaining: number;
  readonly confirmationAllowed: boolean;
  readonly items: readonly RecordedPreconfirmationItemView[];
}

const PRECONFIRMATION_KEYS = [
  "schema_version",
  "synthetic",
  "review_id",
  "source_hash",
  "recorded_benchmark_pack_hash",
  "ai_pre_review_receipt_hash",
  "provisional_decision_memo_hash",
  "queue_content_hash",
  "queue_set_order_hash",
  "pre_review_status",
  "blocking_reasons",
  "advisory_only",
  "human_confirmed",
  "baseline_version",
  "total",
  "completed",
  "remaining",
  "items",
] as const;

export function parsePreconfirmationProjection(
  projection: unknown,
): RecordedPreconfirmationView {
  const source = record(projection, "preconfirmation");
  exact(source, PRECONFIRMATION_KEYS, [], "preconfirmation");
  if (
    source.schema_version !== "preconfirmation-public-projection-v1"
    || source.synthetic !== true
    || source.advisory_only !== true
    || source.human_confirmed !== false
    || source.baseline_version !== null
  ) fail("preconfirmation.authority");
  const status = enumValue(
    source.pre_review_status,
    ["USER_CONFIRMATION_READY", "USER_CONFIRMATION_BLOCKED"],
    "preconfirmation.pre_review_status",
  );
  const blockingReasons = stringArray(
    source.blocking_reasons,
    "preconfirmation.blocking_reasons",
  );
  const rawItems = array(source.items, "preconfirmation.items");
  const items = rawItems.map((raw, index): RecordedPreconfirmationItemView => {
    const item = record(raw, `preconfirmation.items[${index}]`);
    exact(item, [
      "item_id",
      "evidence_id",
      "queue_index",
      "case_id",
      "blind_label",
      "queue_reason",
      "proposed_decision",
      "rationale",
      "evidence_handles",
      "review_evidence_handle",
      "review_status",
    ], [], `preconfirmation.items[${index}]`);
    const blindLabel = enumValue(
      item.blind_label,
      ["X", "Y", "Z"],
      `preconfirmation.items[${index}].blind_label`,
    );
    const evidenceHandles = stringArray(
      item.evidence_handles,
      `preconfirmation.items[${index}].evidence_handles`,
    );
    if (
      evidenceHandles.length === 0
      || evidenceHandles.some((handle) => !EVIDENCE_HANDLE.test(handle))
    ) fail(`preconfirmation.items[${index}].evidence_handles`);
    const reviewEvidenceHandle = text(
      item.review_evidence_handle,
      `preconfirmation.items[${index}].review_evidence_handle`,
    );
    if (!EVIDENCE_HANDLE.test(reviewEvidenceHandle)) {
      fail(`preconfirmation.items[${index}].review_evidence_handle`);
    }
    return {
      itemId: text(item.item_id, `preconfirmation.items[${index}].item_id`),
      evidenceId: text(
        item.evidence_id,
        `preconfirmation.items[${index}].evidence_id`,
      ),
      queueIndex: count(
        item.queue_index,
        `preconfirmation.items[${index}].queue_index`,
      ),
      caseId: text(item.case_id, `preconfirmation.items[${index}].case_id`),
      blindLabel,
      candidateLabel: `Candidate ${blindLabel}`,
      queueReason: enumValue(
        item.queue_reason,
        ["LOCKED_HIGH_RISK", "JUDGE_RISK", "JUDGE_INCOMPLETE_FALLBACK"],
        `preconfirmation.items[${index}].queue_reason`,
      ),
      proposedDecision: enumValue(
        item.proposed_decision,
        ["PROPOSED_PASS", "PROPOSED_CONFIRMED_FAIL", "ABSTAIN"],
        `preconfirmation.items[${index}].proposed_decision`,
      ),
      rationale: text(
        item.rationale,
        `preconfirmation.items[${index}].rationale`,
      ),
      evidenceHandles,
      reviewEvidenceHandle,
      reviewStatus: enumValue(
        item.review_status,
        ["REVIEW_REQUIRED"],
        `preconfirmation.items[${index}].review_status`,
      ),
    };
  });
  const total = count(source.total, "preconfirmation.total");
  const completed = count(source.completed, "preconfirmation.completed");
  const remaining = count(source.remaining, "preconfirmation.remaining");
  const queueIndices = new Set(items.map((item) => item.queueIndex));
  const itemIds = new Set(items.map((item) => item.itemId));
  const evidenceIds = new Set(items.map((item) => item.evidenceId));
  const hasAbstain = items.some((item) => item.proposedDecision === "ABSTAIN");
  if (
    completed !== 0
    || total !== items.length
    || remaining !== total
    || queueIndices.size !== total
    || itemIds.size !== total
    || evidenceIds.size !== total
    || items.some((item, index) => item.queueIndex !== index + 1)
    || (
      status === "USER_CONFIRMATION_READY"
      && (blockingReasons.length !== 0 || hasAbstain)
    )
    || (
      status === "USER_CONFIRMATION_BLOCKED"
      && blockingReasons.length === 0
    )
  ) fail("preconfirmation.coverage");
  if (new Set(items.map((item) => item.reviewEvidenceHandle)).size !== total) {
    fail("preconfirmation.review_evidence_handle");
  }
  if (containsBlindIdentityOrArchitectureHint(items)) {
    fail("preconfirmation.blinding");
  }
  return deepFreeze({
    reviewId: text(source.review_id, "preconfirmation.review_id"),
    sourceHash: hash(source.source_hash, "preconfirmation.source_hash"),
    recordedBenchmarkPackHash: hash(
      source.recorded_benchmark_pack_hash,
      "preconfirmation.recorded_benchmark_pack_hash",
    ),
    aiPreReviewReceiptHash: hash(
      source.ai_pre_review_receipt_hash,
      "preconfirmation.ai_pre_review_receipt_hash",
    ),
    provisionalDecisionMemoHash: hash(
      source.provisional_decision_memo_hash,
      "preconfirmation.provisional_decision_memo_hash",
    ),
    queueContentHash: hash(
      source.queue_content_hash,
      "preconfirmation.queue_content_hash",
    ),
    queueSetOrderHash: hash(
      source.queue_set_order_hash,
      "preconfirmation.queue_set_order_hash",
    ),
    preReviewStatus: status,
    blockingReasons,
    advisoryOnly: true,
    humanConfirmed: false,
    baselineVersion: null,
    total,
    completed: 0,
    remaining,
    confirmationAllowed: status === "USER_CONFIRMATION_READY",
    items,
  });
}

export interface RecordedCandidateDecisionView {
  readonly candidateId: CandidateId;
  readonly gateStatus: "PASS" | "REVIEW_REQUIRED" | "CONFIRMED_FAIL";
  readonly eligible: boolean;
  readonly sufficiencyPassed: boolean;
  readonly failedSufficiencyRules: readonly string[];
  readonly criticalFailedCaseIds: readonly string[];
  readonly complexityProfile: Readonly<{
    modelCallStages: number;
    retrievalIndexDependencies: number;
    externalTools: number;
    stateOrMemory: number;
    candidateFailureComponents: number;
    dedicatedInfrastructure: number;
  }>;
  readonly observed: Readonly<{
    validRuns: number;
    policySuccessCases: number;
    citationSuccessCases: number;
    escalationSuccessCases: number;
    stableCases: number;
    averageRuntimeCostUsd: number | null;
    medianLatencyMs: number;
    worstLatencyMs: number;
  }>;
}

export interface HumanConfirmedDecisionView {
  readonly decisionId: string;
  readonly sourceHash: string;
  readonly status:
    | "HUMAN_CONFIRMED_REVIEW"
    | "MEMO_REVIEW_REQUIRED"
    | "DECISION_CONFIRMED"
    | "NO_APPROVED_CANDIDATE";
  readonly recordedBenchmarkPackHash: string;
  readonly aiPreReviewReceiptHash: string;
  readonly provisionalDecisionMemoHash: string;
  readonly humanConfirmationReceiptHash: string;
  readonly finalDecisionMemoHash: string | null;
  readonly finalDecisionMemo: FinalDecisionMemoView | null;
  readonly finalMemoConfirmationHash: string | null;
  readonly humanConfirmed: true;
  readonly review: Readonly<{
    completed: number;
    total: number;
    remaining: 0;
    totalReviewDurationMs: number;
    totalEditDurationMs: number;
  }>;
  readonly candidates: readonly RecordedCandidateDecisionView[];
  readonly eligibleCandidateIds: readonly CandidateId[];
  readonly minimumComplexityCandidateIds: readonly CandidateId[];
  readonly recommendedCandidateId: CandidateId | null;
  readonly selectionAuthority: "HUMAN_DECISION_REQUIRED";
  readonly selectedCandidateId: CandidateId | null;
  readonly selectionRationale: string | null;
  readonly baselineId: string | null;
  readonly compositeScore: null;
  readonly hardGateMatrix?: RecordedHardGateMatrixView;
}

export interface FinalDecisionMemoView {
  readonly sourceHash: string;
  readonly decisionProjectionSourceHash: string;
  readonly publicBodySha256: string;
  readonly bodyIntegrityVerified: true;
  readonly decisionSummary: string;
  readonly rejectedAlternatives: readonly {
    readonly candidateId: CandidateId;
    readonly reason: string;
  }[];
  readonly hardGateFindings: readonly {
    readonly candidateId: CandidateId;
    readonly criticalFailedCaseIds: readonly string[];
  }[];
  readonly knownLimitations: readonly string[];
  readonly nextPocScope: string;
  readonly procurementHandoff: string;
  readonly externalActionStatement:
    "No purchase, contract, deployment, or rollback was executed.";
  readonly candidateTradeOffs: readonly {
    readonly candidateId: CandidateId;
    readonly disposition: "SELECTED" | "NOT_SELECTED";
    readonly summary: string;
    readonly criticalFailedCaseIds: readonly string[];
  }[];
}

function parseCandidateDecision(
  value: unknown,
  index: number,
): RecordedCandidateDecisionView {
  const location = `decision.candidates[${index}]`;
  const item = record(value, location);
  exact(item, [
    "candidate_id",
    "gate_status",
    "eligible",
    "sufficiency_passed",
    "failed_sufficiency_rules",
    "critical_failed_case_ids",
    "complexity_profile",
    "observed",
  ], [], location);
  const id = candidateId(item.candidate_id, `${location}.candidate_id`);
  if (
    typeof item.eligible !== "boolean"
    || typeof item.sufficiency_passed !== "boolean"
  ) fail(location);
  const profile = record(item.complexity_profile, `${location}.complexity_profile`);
  exact(profile, [
    "model_call_stages",
    "retrieval_index_dependencies",
    "external_tools",
    "state_or_memory",
    "candidate_failure_components",
    "dedicated_infrastructure",
  ], [], `${location}.complexity_profile`);
  const observed = record(item.observed, `${location}.observed`);
  exact(observed, [
    "valid_runs",
    "policy_success_cases",
    "citation_success_cases",
    "escalation_success_cases",
    "stable_cases",
    "average_runtime_cost_usd",
    "median_latency_ms",
    "worst_latency_ms",
  ], [], `${location}.observed`);
  const gateStatus = enumValue(
    item.gate_status,
    ["PASS", "REVIEW_REQUIRED", "CONFIRMED_FAIL"],
    `${location}.gate_status`,
  );
  if (
    item.eligible
      !== (
        gateStatus === "PASS"
        && item.sufficiency_passed === true
      )
  ) fail(`${location}.eligible`);
  return {
    candidateId: id,
    gateStatus,
    eligible: item.eligible,
    sufficiencyPassed: item.sufficiency_passed,
    failedSufficiencyRules: stringArray(
      item.failed_sufficiency_rules,
      `${location}.failed_sufficiency_rules`,
    ),
    criticalFailedCaseIds: stringArray(
      item.critical_failed_case_ids,
      `${location}.critical_failed_case_ids`,
    ),
    complexityProfile: {
      modelCallStages: count(profile.model_call_stages, `${location}.model_call_stages`),
      retrievalIndexDependencies: count(
        profile.retrieval_index_dependencies,
        `${location}.retrieval_index_dependencies`,
      ),
      externalTools: count(profile.external_tools, `${location}.external_tools`),
      stateOrMemory: count(profile.state_or_memory, `${location}.state_or_memory`),
      candidateFailureComponents: count(
        profile.candidate_failure_components,
        `${location}.candidate_failure_components`,
      ),
      dedicatedInfrastructure: count(
        profile.dedicated_infrastructure,
        `${location}.dedicated_infrastructure`,
      ),
    },
    observed: {
      validRuns: count(observed.valid_runs, `${location}.valid_runs`),
      policySuccessCases: count(
        observed.policy_success_cases,
        `${location}.policy_success_cases`,
      ),
      citationSuccessCases: count(
        observed.citation_success_cases,
        `${location}.citation_success_cases`,
      ),
      escalationSuccessCases: count(
        observed.escalation_success_cases,
        `${location}.escalation_success_cases`,
      ),
      stableCases: count(observed.stable_cases, `${location}.stable_cases`),
      averageRuntimeCostUsd: nullableNumber(
        observed.average_runtime_cost_usd,
        `${location}.average_runtime_cost_usd`,
      ),
      medianLatencyMs: nonnegativeNumber(
        observed.median_latency_ms,
        `${location}.median_latency_ms`,
      ),
      worstLatencyMs: nonnegativeNumber(
        observed.worst_latency_ms,
        `${location}.worst_latency_ms`,
      ),
    },
  };
}

const DECISION_KEYS = [
  "schema_version",
  "synthetic",
  "decision_id",
  "source_hash",
  "status",
  "recorded_benchmark_pack_hash",
  "ai_pre_review_receipt_hash",
  "provisional_decision_memo_hash",
  "human_confirmation_receipt_hash",
  "final_decision_memo_hash",
  "final_decision_memo",
  "final_memo_confirmation_hash",
  "human_confirmed",
  "review",
  "candidates",
  "eligible_candidate_ids",
  "minimum_complexity_candidate_ids",
  "recommended_candidate_id",
  "selection_authority",
  "selected_candidate_id",
  "selection_rationale",
  "baseline_id",
  "composite_score",
] as const;

async function parseFinalDecisionMemoProjection(
  value: unknown,
  expectedHash: string,
  decisionProjectionSourceHash: string,
  selectedCandidateId: CandidateId | null,
): Promise<FinalDecisionMemoView> {
  const memo = record(value, "decision.final_decision_memo");
  exact(memo, [
    "schema_version",
    "source_hash",
    "decision_projection_source_hash",
    "public_body_sha256",
    "decision_summary",
    "rejected_alternatives",
    "hard_gate_findings",
    "known_limitations",
    "next_poc_scope",
    "procurement_handoff",
    "external_action_statement",
    "candidate_trade_offs",
  ], [], "decision.final_decision_memo");
  if (
    memo.schema_version
      !== FINAL_DECISION_MEMO_PUBLIC_BODY_SCHEMA_VERSION
  ) {
    fail("decision.final_decision_memo.schema_version");
  }
  const sourceHash = hash(
    memo.source_hash,
    "decision.final_decision_memo.source_hash",
  );
  if (sourceHash !== expectedHash) {
    fail("decision.final_decision_memo.source_hash");
  }
  const memoDecisionProjectionSourceHash = hash(
    memo.decision_projection_source_hash,
    "decision.final_decision_memo.decision_projection_source_hash",
  );
  if (memoDecisionProjectionSourceHash !== decisionProjectionSourceHash) {
    fail("decision.final_decision_memo.decision_projection_source_hash");
  }
  const publicBodySha256 = hash(
    memo.public_body_sha256,
    "decision.final_decision_memo.public_body_sha256",
  );
  const decisionSummary = text(
    memo.decision_summary,
    "decision.final_decision_memo.decision_summary",
  );
  const rejectedAlternatives = array(
    memo.rejected_alternatives,
    "decision.final_decision_memo.rejected_alternatives",
  ).map((value, index) => {
    const item = record(
      value,
      `decision.final_decision_memo.rejected_alternatives[${index}]`,
    );
    exact(item, ["candidate_id", "reason"], [],
      `decision.final_decision_memo.rejected_alternatives[${index}]`);
    return {
      candidateId: candidateId(
        item.candidate_id,
        `decision.final_decision_memo.rejected_alternatives[${index}].candidate_id`,
      ),
      reason: text(
        item.reason,
        `decision.final_decision_memo.rejected_alternatives[${index}].reason`,
      ),
    };
  });
  const hardGateFindings = array(
    memo.hard_gate_findings,
    "decision.final_decision_memo.hard_gate_findings",
  ).map((value, index) => {
    const item = record(
      value,
      `decision.final_decision_memo.hard_gate_findings[${index}]`,
    );
    exact(item, ["candidate_id", "critical_failed_case_ids"], [],
      `decision.final_decision_memo.hard_gate_findings[${index}]`);
    return {
      candidateId: candidateId(
        item.candidate_id,
        `decision.final_decision_memo.hard_gate_findings[${index}].candidate_id`,
      ),
      criticalFailedCaseIds: stringArray(
        item.critical_failed_case_ids,
        `decision.final_decision_memo.hard_gate_findings[${index}].critical_failed_case_ids`,
      ),
    };
  });
  const knownLimitations = stringArray(
    memo.known_limitations,
    "decision.final_decision_memo.known_limitations",
  );
  const benchmarkScope = knownLimitations[0] ?? "";
  const candidateVersions = knownLimitations[1] ?? "";
  const humanReviewSample = knownLimitations[2] ?? "";
  const limitationText = knownLimitations.join("\n");
  if (
    !/^Benchmark scope: challenge_version=[^;\s]+; recorded_pack_schema=[^;\s]+; execution_pack_schema=[^;\s]+; dataset_sha256=[a-f0-9]{64}; cases=12; candidates=3; runs_per_case=2; candidate_runs=72; judge_cases=12\.$/u
      .test(benchmarkScope)
    || !/^Candidate versions: A=[A-Za-z0-9._:-]+ B=[A-Za-z0-9._:-]+ C=[A-Za-z0-9._:-]+\.$/u
      .test(candidateVersions)
    || !/^Human-review sample; required_high_risk_cases=4; required_candidate_case_reviews=12; completed_candidate_case_reviews=[1-9][0-9]*; judge_flagged_candidate_case_reviews=[0-9]+; statistical_generalization=NOT_SUPPORTED\.$/u
      .test(humanReviewSample)
    || !/auxiliary .*Judge/iu.test(limitationText)
    || !/self-preference or position bias/iu.test(limitationText)
  ) {
    fail("decision.final_decision_memo.known_limitations");
  }
  if (
    memo.external_action_statement
      !== "No purchase, contract, deployment, or rollback was executed."
  ) {
    fail("decision.final_decision_memo.external_action_statement");
  }
  const candidateTradeOffs = array(
    memo.candidate_trade_offs,
    "decision.final_decision_memo.candidate_trade_offs",
  ).map((value, index) => {
    const item = record(
      value,
      `decision.final_decision_memo.candidate_trade_offs[${index}]`,
    );
    exact(item, [
      "candidate_id",
      "disposition",
      "summary",
      "critical_failed_case_ids",
    ], [], `decision.final_decision_memo.candidate_trade_offs[${index}]`);
    return {
      candidateId: candidateId(
        item.candidate_id,
        `decision.final_decision_memo.candidate_trade_offs[${index}].candidate_id`,
      ),
      disposition: enumValue(
        item.disposition,
        ["SELECTED", "NOT_SELECTED"],
        `decision.final_decision_memo.candidate_trade_offs[${index}].disposition`,
      ),
      summary: text(
        item.summary,
        `decision.final_decision_memo.candidate_trade_offs[${index}].summary`,
      ),
      criticalFailedCaseIds: stringArray(
        item.critical_failed_case_ids,
        `decision.final_decision_memo.candidate_trade_offs[${index}].critical_failed_case_ids`,
      ),
    };
  });
  const candidateOrder = ["A", "B", "C"];
  const selectedTradeOffs = candidateTradeOffs.filter(
    (item) => item.disposition === "SELECTED",
  );
  if (
    hardGateFindings.length !== 3
    || hardGateFindings.map((item) => item.candidateId).join(",")
      !== candidateOrder.join(",")
    || candidateTradeOffs.length !== 3
    || candidateTradeOffs.map((item) => item.candidateId).join(",")
      !== candidateOrder.join(",")
    || rejectedAlternatives.length
      !== (selectedCandidateId === null ? 3 : 2)
    || new Set(
      rejectedAlternatives.map((item) => item.candidateId),
    ).size !== rejectedAlternatives.length
    || rejectedAlternatives.some(
      (item) => item.candidateId === selectedCandidateId,
    )
    || (
      selectedCandidateId === null
        ? selectedTradeOffs.length !== 0
        : (
            selectedTradeOffs.length !== 1
            || selectedTradeOffs[0]?.candidateId !== selectedCandidateId
            || selectedTradeOffs[0]?.summary !== decisionSummary
          )
    )
    || candidateTradeOffs.some((tradeOff) => {
      const finding = hardGateFindings.find(
        (item) => item.candidateId === tradeOff.candidateId,
      );
      const alternative = rejectedAlternatives.find(
        (item) => item.candidateId === tradeOff.candidateId,
      );
      return finding === undefined
        || finding.criticalFailedCaseIds.join(",")
          !== tradeOff.criticalFailedCaseIds.join(",")
        || (
          tradeOff.disposition === "NOT_SELECTED"
          && alternative?.reason !== tradeOff.summary
        );
    })
  ) {
    fail("decision.final_decision_memo.candidate_trade_offs");
  }
  const publicBody = finalDecisionMemoPublicBodyPayload({
    source_hash: sourceHash,
    decision_projection_source_hash:
      memoDecisionProjectionSourceHash,
    decision_summary: decisionSummary,
    rejected_alternatives: rejectedAlternatives.map((item) => ({
      candidate_id: item.candidateId,
      reason: item.reason,
    })),
    hard_gate_findings: hardGateFindings.map((item) => ({
      candidate_id: item.candidateId,
      critical_failed_case_ids: item.criticalFailedCaseIds,
    })),
    known_limitations: knownLimitations,
    next_poc_scope: text(
      memo.next_poc_scope,
      "decision.final_decision_memo.next_poc_scope",
    ),
    procurement_handoff: text(
      memo.procurement_handoff,
      "decision.final_decision_memo.procurement_handoff",
    ),
    external_action_statement:
      "No purchase, contract, deployment, or rollback was executed.",
    candidate_trade_offs: candidateTradeOffs.map((item) => ({
      candidate_id: item.candidateId,
      disposition: item.disposition,
      summary: item.summary,
      critical_failed_case_ids: item.criticalFailedCaseIds,
    })),
  });
  let calculatedPublicBodySha256: string;
  try {
    calculatedPublicBodySha256 =
      await sha256CanonicalPublicJson(publicBody);
  } catch {
    fail("decision.final_decision_memo.public_body_sha256");
  }
  if (calculatedPublicBodySha256 !== publicBodySha256) {
    fail("decision.final_decision_memo.public_body_sha256");
  }
  return deepFreeze({
    sourceHash,
    decisionProjectionSourceHash: memoDecisionProjectionSourceHash,
    publicBodySha256,
    bodyIntegrityVerified: true,
    decisionSummary,
    rejectedAlternatives,
    hardGateFindings,
    knownLimitations,
    nextPocScope: publicBody.next_poc_scope,
    procurementHandoff: publicBody.procurement_handoff,
    externalActionStatement:
      "No purchase, contract, deployment, or rollback was executed.",
    candidateTradeOffs,
  });
}

export async function parseHumanConfirmedDecisionProjection(
  projection: unknown,
): Promise<HumanConfirmedDecisionView> {
  const source = record(projection, "decision");
  exact(source, DECISION_KEYS, ["hard_gate_matrix"], "decision");
  const decisionSourceHash = hash(
    source.source_hash,
    "decision.source_hash",
  );
  if (
    source.schema_version !== "decision-public-projection-v1"
    || source.synthetic !== true
    || source.human_confirmed !== true
    || source.selection_authority !== "HUMAN_DECISION_REQUIRED"
    || source.composite_score !== null
  ) fail("decision.authority");
  const candidates = array(source.candidates, "decision.candidates")
    .map(parseCandidateDecision);
  if (
    candidates.length !== 3
    || candidates.map((item) => item.candidateId).join("") !== "ABC"
  ) fail("decision.candidates");
  const eligible = stringArray(
    source.eligible_candidate_ids,
    "decision.eligible_candidate_ids",
  ).map((value, index) => candidateId(
    value,
    `decision.eligible_candidate_ids[${index}]`,
  ));
  const actualEligible = candidates
    .filter((item) => item.eligible)
    .map((item) => item.candidateId);
  if (
    eligible.length !== new Set(eligible).size
    || eligible.join(",") !== actualEligible.join(",")
  ) fail("decision.eligible_candidate_ids");
  const minimum = stringArray(
    source.minimum_complexity_candidate_ids,
    "decision.minimum_complexity_candidate_ids",
  ).map((value, index) => candidateId(
    value,
    `decision.minimum_complexity_candidate_ids[${index}]`,
  ));
  if (
    minimum.length !== new Set(minimum).size
    || minimum.some((id) => !eligible.includes(id))
  ) fail("decision.minimum_complexity_candidate_ids");
  const recommended = source.recommended_candidate_id === null
    ? null
    : candidateId(
        source.recommended_candidate_id,
        "decision.recommended_candidate_id",
      );
  if (recommended !== null && !minimum.includes(recommended)) {
    fail("decision.recommended_candidate_id");
  }
  const selected = source.selected_candidate_id === null
    ? null
    : candidateId(source.selected_candidate_id, "decision.selected_candidate_id");
  const rationale = source.selection_rationale === null
    ? null
    : text(source.selection_rationale, "decision.selection_rationale");
  if (
    selected !== null
    && (
      rationale === null
      || !eligible.includes(selected)
    )
  ) fail("decision.selection");
  const review = record(source.review, "decision.review");
  exact(review, [
    "completed",
    "total",
    "remaining",
    "total_review_duration_ms",
    "total_edit_duration_ms",
  ], [], "decision.review");
  const completed = count(review.completed, "decision.review.completed");
  const total = count(review.total, "decision.review.total");
  const remaining = count(review.remaining, "decision.review.remaining");
  if (remaining !== 0 || completed !== total) fail("decision.review.coverage");
  const finalMemoHash = nullableHash(
    source.final_decision_memo_hash,
    "decision.final_decision_memo_hash",
  );
  const finalMemoConfirmationHash = nullableHash(
    source.final_memo_confirmation_hash,
    "decision.final_memo_confirmation_hash",
  );
  const finalMemo = finalMemoHash === null
    ? source.final_decision_memo === null
      ? null
      : fail("decision.final_decision_memo")
    : source.final_decision_memo === null
      ? fail("decision.final_decision_memo")
      : await parseFinalDecisionMemoProjection(
          source.final_decision_memo,
          finalMemoHash,
          decisionSourceHash,
          selected,
        );
  if (
    finalMemoConfirmationHash !== null
    && finalMemoHash === null
  ) fail("decision.final_memo_confirmation_hash");
  const status = enumValue(
    source.status,
    [
      "HUMAN_CONFIRMED_REVIEW",
      "MEMO_REVIEW_REQUIRED",
      "DECISION_CONFIRMED",
      "NO_APPROVED_CANDIDATE",
    ],
    "decision.status",
  );
  const baselineId = nullableId(source.baseline_id, "decision.baseline_id");
  const hardGateMatrix = source.hard_gate_matrix === undefined
    ? undefined
    : parseRecordedHardGateMatrixProjection(source.hard_gate_matrix);
  if (
    status === "HUMAN_CONFIRMED_REVIEW"
      && (
        selected !== null
        || rationale !== null
        || finalMemoHash !== null
        || finalMemo !== null
        || finalMemoConfirmationHash !== null
        || baselineId !== null
      )
    || status === "MEMO_REVIEW_REQUIRED"
      && (
        rationale === null
        || finalMemoHash === null
        || finalMemo === null
        || decisionSourceHash !== finalMemoHash
        || finalMemoConfirmationHash !== null
        || baselineId !== null
      )
    || status === "DECISION_CONFIRMED"
      && (
        selected === null
        || rationale === null
        || finalMemoHash === null
        || finalMemo === null
        || finalMemoConfirmationHash === null
        || baselineId === null
      )
    || status === "NO_APPROVED_CANDIDATE"
      && (
        selected !== null
        || rationale === null
        || finalMemoHash === null
        || finalMemo === null
        || finalMemoConfirmationHash === null
        || baselineId !== null
      )
  ) fail("decision.status");
  return deepFreeze({
    decisionId: text(source.decision_id, "decision.decision_id"),
    sourceHash: decisionSourceHash,
    status,
    recordedBenchmarkPackHash: hash(
      source.recorded_benchmark_pack_hash,
      "decision.recorded_benchmark_pack_hash",
    ),
    aiPreReviewReceiptHash: hash(
      source.ai_pre_review_receipt_hash,
      "decision.ai_pre_review_receipt_hash",
    ),
    provisionalDecisionMemoHash: hash(
      source.provisional_decision_memo_hash,
      "decision.provisional_decision_memo_hash",
    ),
    humanConfirmationReceiptHash: hash(
      source.human_confirmation_receipt_hash,
      "decision.human_confirmation_receipt_hash",
    ),
    finalDecisionMemoHash: finalMemoHash,
    finalDecisionMemo: finalMemo,
    finalMemoConfirmationHash,
    humanConfirmed: true,
    review: {
      completed,
      total,
      remaining: 0,
      totalReviewDurationMs: count(
        review.total_review_duration_ms,
        "decision.review.total_review_duration_ms",
      ),
      totalEditDurationMs: count(
        review.total_edit_duration_ms,
        "decision.review.total_edit_duration_ms",
      ),
    },
    candidates,
    eligibleCandidateIds: eligible,
    minimumComplexityCandidateIds: minimum,
    recommendedCandidateId: recommended,
    selectionAuthority: "HUMAN_DECISION_REQUIRED",
    selectedCandidateId: selected,
    selectionRationale: rationale,
    baselineId,
    compositeScore: null,
    ...(hardGateMatrix === undefined ? {} : { hardGateMatrix }),
  });
}

export interface ActiveBaselineView {
  readonly baselineId: string;
  readonly sourceHash: string;
  readonly selectedCandidateId: CandidateId;
  readonly decisionRecordHash: string;
  readonly finalDecisionMemoHash: string;
  readonly finalMemoConfirmationHash: string;
  readonly configurationHash: string;
  readonly version: "v1";
  readonly externalDeploymentPerformed: false;
}

export function parseActiveBaselineProjection(
  projection: unknown,
): ActiveBaselineView {
  const source = record(projection, "baseline");
  exact(source, [
    "schema_version",
    "synthetic",
    "baseline_id",
    "source_hash",
    "status",
    "selected_candidate_id",
    "decision_record_hash",
    "final_decision_memo_hash",
    "final_memo_confirmation_hash",
    "configuration_hash",
    "baseline_version",
    "external_deployment_performed",
  ], [], "baseline");
  if (
    source.schema_version !== "baseline-public-projection-v1"
    || source.synthetic !== true
    || source.status !== "ACTIVE"
    || source.baseline_version !== "v1"
    || source.external_deployment_performed !== false
  ) fail("baseline.authority");
  return deepFreeze({
    baselineId: text(source.baseline_id, "baseline.baseline_id"),
    sourceHash: hash(source.source_hash, "baseline.source_hash"),
    selectedCandidateId: candidateId(
      source.selected_candidate_id,
      "baseline.selected_candidate_id",
    ),
    decisionRecordHash: hash(
      source.decision_record_hash,
      "baseline.decision_record_hash",
    ),
    finalDecisionMemoHash: hash(
      source.final_decision_memo_hash,
      "baseline.final_decision_memo_hash",
    ),
    finalMemoConfirmationHash: hash(
      source.final_memo_confirmation_hash,
      "baseline.final_memo_confirmation_hash",
    ),
    configurationHash: hash(
      source.configuration_hash,
      "baseline.configuration_hash",
    ),
    version: "v1",
    externalDeploymentPerformed: false,
  });
}

export interface RecordedRegressionComparisonSide {
  readonly label: string;
  readonly hardGateFailures: number;
  readonly meanRuntimeCostUsd: number | null;
  readonly medianLatencyMs: number | null;
  readonly worstLatencyMs: number | null;
}

export interface RecordedRegressionEvidenceBinding {
  readonly sourceHash: string;
  readonly evidenceId: string;
  readonly evidenceBindingHash: string;
  readonly caseId: string;
  readonly candidateId: CandidateId;
  readonly candidateLabel: `Candidate ${CandidateId}`;
  readonly version: "BASELINE_V1" | "PROPOSED_V2";
  readonly kind: "benchmark";
  readonly source: "RECORDED REGRESSION";
}

export interface RecordedRegressionView {
  readonly regressionId: string;
  readonly sourceHash: string;
  readonly source: "RECORDED_REGRESSION";
  readonly status: "RECORDED";
  readonly verdict: "BLOCK" | "PASS" | "REVIEW" | "EVALUATION_INCOMPLETE";
  readonly baselineId: string;
  readonly baselineVersion: "v1";
  readonly baselineCandidateId: CandidateId;
  readonly baselineConfigurationHash: string;
  readonly proposedConfigurationHash: string;
  readonly newHardGateFailures: readonly Readonly<{
    caseId: string;
    gateIds: readonly string[];
    evidenceId: string;
    baselineStatus: "PASS";
    proposedStatus: "CONFIRMED_FAIL";
  }>[];
  readonly evidenceBindings:
    readonly RecordedRegressionEvidenceBinding[];
  readonly comparison: Readonly<{
    baseline: RecordedRegressionComparisonSide;
    proposed: RecordedRegressionComparisonSide;
  }>;
  readonly blockingReasons: readonly Readonly<{
    code: string;
    summary: string;
    evidenceId: string | null;
  }>[];
  readonly externalDeploymentPerformed: false;
  readonly externalRollbackPerformed: false;
}

function parseComparisonSide(
  value: unknown,
  location: string,
): RecordedRegressionComparisonSide {
  const side = record(value, location);
  exact(side, [
    "label",
    "hard_gate_failures",
    "mean_runtime_cost_usd",
    "median_latency_ms",
    "worst_latency_ms",
  ], [], location);
  return {
    label: text(side.label, `${location}.label`),
    hardGateFailures: count(
      side.hard_gate_failures,
      `${location}.hard_gate_failures`,
    ),
    meanRuntimeCostUsd: nullableNumber(
      side.mean_runtime_cost_usd,
      `${location}.mean_runtime_cost_usd`,
    ),
    medianLatencyMs: nullableNumber(
      side.median_latency_ms,
      `${location}.median_latency_ms`,
    ),
    worstLatencyMs: nullableNumber(
      side.worst_latency_ms,
      `${location}.worst_latency_ms`,
    ),
  };
}

export function parseRecordedRegressionProjection(
  projection: unknown,
): RecordedRegressionView {
  const source = record(projection, "regression");
  exact(source, [
    "schema_version",
    "synthetic",
    "regression_id",
    "source_hash",
    "source",
    "status",
    "verdict",
    "baseline_id",
    "baseline_version",
    "baseline_candidate_id",
    "baseline_configuration_hash",
    "proposed_configuration_hash",
    "new_hard_gate_failures",
    "evidence_bindings",
    "comparison",
    "blocking_reasons",
    "external_deployment_performed",
    "external_rollback_performed",
  ], [], "regression");
  if (
    source.schema_version !== "regression-public-projection-v1"
    || source.synthetic !== true
    || source.source !== "RECORDED_REGRESSION"
    || source.status !== "RECORDED"
    || source.baseline_version !== "v1"
    || source.external_deployment_performed !== false
    || source.external_rollback_performed !== false
  ) fail("regression.authority");
  const failures = array(
    source.new_hard_gate_failures,
    "regression.new_hard_gate_failures",
  ).map((raw, index) => {
    const location = `regression.new_hard_gate_failures[${index}]`;
    const item = record(raw, location);
    exact(item, [
      "case_id",
      "gate_ids",
      "evidence_id",
      "baseline_status",
      "proposed_status",
    ], [], location);
    if (
      item.baseline_status !== "PASS"
      || item.proposed_status !== "CONFIRMED_FAIL"
    ) fail(location);
    const gateIds = stringArray(item.gate_ids, `${location}.gate_ids`);
    if (gateIds.length === 0) fail(`${location}.gate_ids`);
    return {
      caseId: text(item.case_id, `${location}.case_id`),
      gateIds,
      evidenceId: text(item.evidence_id, `${location}.evidence_id`),
      baselineStatus: "PASS" as const,
      proposedStatus: "CONFIRMED_FAIL" as const,
    };
  });
  const regressionSourceHash = hash(
    source.source_hash,
    "regression.source_hash",
  );
  const evidenceBindings = array(
    source.evidence_bindings,
    "regression.evidence_bindings",
  ).map((raw, index): RecordedRegressionEvidenceBinding => {
    const location = `regression.evidence_bindings[${index}]`;
    const binding = record(raw, location);
    exact(binding, [
      "schema_version",
      "source_hash",
      "evidence_id",
      "evidence_binding_hash",
      "case_id",
      "candidate_id",
      "candidate_label",
      "version",
      "kind",
      "source",
    ], [], location);
    const candidate = candidateId(
      binding.candidate_id,
      `${location}.candidate_id`,
    );
    const candidateLabel = text(
      binding.candidate_label,
      `${location}.candidate_label`,
    );
    const sourceHash = hash(binding.source_hash, `${location}.source_hash`);
    if (
      binding.schema_version !== "regression-evidence-binding-v1"
      || sourceHash !== regressionSourceHash
      || candidateLabel !== `Candidate ${candidate}`
      || binding.kind !== "benchmark"
      || binding.source !== "RECORDED REGRESSION"
    ) fail(location);
    return {
      sourceHash,
      evidenceId: text(binding.evidence_id, `${location}.evidence_id`),
      evidenceBindingHash: hash(
        binding.evidence_binding_hash,
        `${location}.evidence_binding_hash`,
      ),
      caseId: text(binding.case_id, `${location}.case_id`),
      candidateId: candidate,
      candidateLabel: candidateLabel as `Candidate ${CandidateId}`,
      version: enumValue(
        binding.version,
        ["BASELINE_V1", "PROPOSED_V2"],
        `${location}.version`,
      ),
      kind: "benchmark",
      source: "RECORDED REGRESSION",
    };
  });
  if (
    evidenceBindings.length
      !== new Set(evidenceBindings.map((item) => item.evidenceId)).size
    || evidenceBindings.length
      !== new Set(
        evidenceBindings.map((item) => item.evidenceBindingHash),
      ).size
  ) fail("regression.evidence_bindings");
  const verdict = enumValue(
    source.verdict,
    ["BLOCK", "PASS", "REVIEW", "EVALUATION_INCOMPLETE"],
    "regression.verdict",
  );
  const blockingReasons = array(
    source.blocking_reasons,
    "regression.blocking_reasons",
  ).map((raw, index) => {
    const location = `regression.blocking_reasons[${index}]`;
    const reason = record(raw, location);
    exact(reason, ["code", "summary", "evidence_id"], [], location);
    return {
      code: text(reason.code, `${location}.code`),
      summary: text(reason.summary, `${location}.summary`),
      evidenceId: reason.evidence_id === null
        ? null
        : text(reason.evidence_id, `${location}.evidence_id`),
    };
  });
  const referencedEvidenceIds = [
    ...failures.map((failure) => failure.evidenceId),
    ...blockingReasons.flatMap((reason) => (
      reason.evidenceId === null ? [] : [reason.evidenceId]
    )),
  ];
  const expectedEvidenceIds = [...new Set(referencedEvidenceIds)].sort();
  const actualEvidenceIds = evidenceBindings
    .map((binding) => binding.evidenceId)
    .sort();
  if (expectedEvidenceIds.join("\n") !== actualEvidenceIds.join("\n")) {
    fail("regression.evidence_bindings.coverage");
  }
  const baselineCandidate = candidateId(
    source.baseline_candidate_id,
    "regression.baseline_candidate_id",
  );
  for (const failure of failures) {
    const binding = evidenceBindings.find(
      (candidate) => candidate.evidenceId === failure.evidenceId,
    );
    if (
      binding === undefined
      || binding.caseId !== failure.caseId
      || binding.candidateId !== baselineCandidate
      || binding.version !== "PROPOSED_V2"
    ) fail("regression.new_hard_gate_failures.binding");
  }
  if (
    (failures.length > 0 && verdict !== "BLOCK")
    || (verdict === "PASS" && blockingReasons.length > 0)
    || (verdict !== "PASS" && blockingReasons.length === 0)
  ) fail("regression.verdict");
  const comparison = record(source.comparison, "regression.comparison");
  exact(comparison, ["baseline", "proposed"], [], "regression.comparison");
  return deepFreeze({
    regressionId: text(source.regression_id, "regression.regression_id"),
    sourceHash: regressionSourceHash,
    source: "RECORDED_REGRESSION",
    status: "RECORDED",
    verdict,
    baselineId: text(source.baseline_id, "regression.baseline_id"),
    baselineVersion: "v1",
    baselineCandidateId: baselineCandidate,
    baselineConfigurationHash: hash(
      source.baseline_configuration_hash,
      "regression.baseline_configuration_hash",
    ),
    proposedConfigurationHash: hash(
      source.proposed_configuration_hash,
      "regression.proposed_configuration_hash",
    ),
    newHardGateFailures: failures,
    evidenceBindings,
    comparison: {
      baseline: parseComparisonSide(
        comparison.baseline,
        "regression.comparison.baseline",
      ),
      proposed: parseComparisonSide(
        comparison.proposed,
        "regression.comparison.proposed",
      ),
    },
    blockingReasons,
    externalDeploymentPerformed: false,
    externalRollbackPerformed: false,
  });
}

import {
  parseCandidateOutput,
  type CandidateOutput,
} from "../../../eval/contracts/candidateOutput";

type JsonRecord = Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/;
const EVIDENCE_HANDLE = /^evh_[a-f0-9]{64}$/;
const ITEM_ID = /^H-(00[1-9]|01[0-2])--([XYZ])$/;
const GATE_CODES = ["P0-HG-01", "P0-HG-02", "P0-HG-03", "P0-HG-04"] as const;
const ORDER_STATUSES = ["SUCCESS", "DENIED", "TIMEOUT", "MISMATCH", "NOT_REQUIRED"] as const;
const ORDER_RESULT_CODES = ["OK", "ORDER_OWNERSHIP_MISMATCH", "TOOL_TIMEOUT", "ORDER_RESULT_MISMATCH", "NOT_REQUIRED"] as const;
const JUDGE_REFERENCES = ["RUN_1", "RUN_2", "CASE_CONTEXT", "POLICY_EVIDENCE", "ORDER_EVIDENCE", "LOCKED_EXPECTATION"] as const;

type GateCode = (typeof GATE_CODES)[number];
type OrderStatus = (typeof ORDER_STATUSES)[number];
type ExecutionStatus = "COMPLETE" | "INVALID" | "TIMEOUT" | "BUDGET_EXCEEDED";

interface ParsedRun extends JsonRecord {
  readonly repetition: 1 | 2;
  readonly execution_status: ExecutionStatus;
  readonly deterministic_checks: readonly JsonRecord[];
  readonly customer_reply: string | null;
  readonly structured_decision: CandidateOutput["decision"] | null;
  readonly citations: CandidateOutput["citations"] | null;
  readonly normalized_access_trace: JsonRecord | null;
}

export interface RecordedBlindReviewEvidenceDetailView {
  readonly item_id: string;
  readonly candidate_label: `Candidate ${"X" | "Y" | "Z"}`;
  readonly active_policy_evidence: readonly JsonRecord[];
  readonly runs: readonly [ParsedRun, ParsedRun];
  readonly synthetic_order_evidence: JsonRecord;
  readonly locked_expectation: JsonRecord;
  readonly judge_risks: readonly JsonRecord[];
  readonly detail_binding_hash: string;
  readonly [key: string]: unknown;
}

export class RecordedBlindReviewEvidenceDetailProjectionError extends Error {
  readonly code = "RECORDED_BLIND_REVIEW_EVIDENCE_DETAIL_INVALID" as const;
}

function fail(location: string): never {
  throw new RecordedBlindReviewEvidenceDetailProjectionError(
    `${location} blind review Evidence projection 계약이 올바르지 않습니다.`,
  );
}

function record(value: unknown, location: string): JsonRecord {
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) fail(location);
  return value as JsonRecord;
}

function exact(value: JsonRecord, keys: readonly string[], location: string): void {
  const allowed = new Set(keys);
  if (keys.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    fail(location);
  }
}

function text(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || /\p{Cc}/u.test(value)) fail(location);
  return value;
}

function nullableText(value: unknown, location: string): string | null {
  return value === null ? null : text(value, location);
}

function boolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") fail(location);
  return value;
}

function number(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(location);
  return value;
}

function array(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value) || Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).some((present) => !present)) {
    fail(location);
  }
  return value;
}

function stringArray(value: unknown, location: string): string[] {
  return array(value, location).map((item, index) => text(item, `${location}[${index}]`));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], location: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(location);
  return value as T;
}

function hash(value: unknown, location: string): string {
  const parsed = text(value, location);
  if (!SHA256.test(parsed)) fail(location);
  return parsed;
}

function handle(value: unknown, location: string): string {
  const parsed = text(value, location);
  if (!EVIDENCE_HANDLE.test(parsed)) fail(location);
  return parsed;
}

function assertNoLeak(value: unknown): void {
  const serialized = JSON.stringify(value).normalize("NFKC");
  if (/candidate_id|label_to_candidate|private_mapping|ORACLE:|reference_replies|single LLM|RAG|tool agent|tool_call_count/i.test(serialized)) {
    fail("blind review Evidence identity·oracle·architecture leak");
  }
}

function parseCitation(value: unknown, location: string): JsonRecord {
  const citation = record(value, location);
  exact(citation, ["source_id", "section_id"], location);
  text(citation.source_id, `${location}.source_id`);
  text(citation.section_id, `${location}.section_id`);
  return citation;
}

function parsePolicy(value: unknown, location: string): JsonRecord {
  const policy = record(value, location);
  exact(policy, ["citation_role", "source_id", "section_id", "version", "title", "lifecycle_status", "effective_from", "effective_to", "excerpt"], location);
  enumValue(policy.citation_role, ["REQUIRED", "ALLOWED", "REQUIRED_AND_ALLOWED"] as const, `${location}.citation_role`);
  text(policy.source_id, `${location}.source_id`);
  text(policy.section_id, `${location}.section_id`);
  text(policy.version, `${location}.version`);
  text(policy.title, `${location}.title`);
  if (policy.lifecycle_status !== "ACTIVE") fail(`${location}.lifecycle_status`);
  text(policy.effective_from, `${location}.effective_from`);
  nullableText(policy.effective_to, `${location}.effective_to`);
  text(policy.excerpt, `${location}.excerpt`);
  return policy;
}

function parseOrderSnapshot(value: unknown): JsonRecord {
  const snapshot = record(value, "synthetic order snapshot");
  exact(snapshot, ["order_id", "status", "fulfillment_locked", "placed_at", "shipped_at", "delivered_at", "promised_delivery_date", "total_amount", "currency", "carrier", "tracking_number", "refund_status", "refund_approved_at", "items"], "synthetic order snapshot");
  text(snapshot.order_id, "synthetic order snapshot.order_id");
  text(snapshot.status, "synthetic order snapshot.status");
  boolean(snapshot.fulfillment_locked, "synthetic order snapshot.fulfillment_locked");
  text(snapshot.placed_at, "synthetic order snapshot.placed_at");
  nullableText(snapshot.shipped_at, "synthetic order snapshot.shipped_at");
  nullableText(snapshot.delivered_at, "synthetic order snapshot.delivered_at");
  text(snapshot.promised_delivery_date, "synthetic order snapshot.promised_delivery_date");
  number(snapshot.total_amount, "synthetic order snapshot.total_amount");
  text(snapshot.currency, "synthetic order snapshot.currency");
  nullableText(snapshot.carrier, "synthetic order snapshot.carrier");
  nullableText(snapshot.tracking_number, "synthetic order snapshot.tracking_number");
  nullableText(snapshot.refund_status, "synthetic order snapshot.refund_status");
  nullableText(snapshot.refund_approved_at, "synthetic order snapshot.refund_approved_at");
  array(snapshot.items, "synthetic order snapshot.items").forEach((raw, index) => {
    const item = record(raw, `synthetic order snapshot.items[${index}]`);
    exact(item, ["product_id", "category", "condition", "custom_made", "final_sale", "damaged", "opened", "defective"], `synthetic order snapshot.items[${index}]`);
    text(item.product_id, `synthetic order snapshot.items[${index}].product_id`);
    text(item.category, `synthetic order snapshot.items[${index}].category`);
    text(item.condition, `synthetic order snapshot.items[${index}].condition`);
    ["custom_made", "final_sale", "damaged", "opened", "defective"].forEach((key) => boolean(item[key], `synthetic order snapshot.items[${index}].${key}`));
  });
  return snapshot;
}

function parseFinding(value: unknown, location: string): JsonRecord {
  const finding = record(value, location);
  exact(finding, ["finding_code", "evidence_excerpt", "finding_handle", "message_handle", "evidence_locations"], location);
  text(finding.finding_code, `${location}.finding_code`);
  text(finding.evidence_excerpt, `${location}.evidence_excerpt`);
  handle(finding.finding_handle, `${location}.finding_handle`);
  handle(finding.message_handle, `${location}.message_handle`);
  const locations = array(finding.evidence_locations, `${location}.evidence_locations`);
  if (locations.length === 0) fail(`${location}.evidence_locations`);
  locations.forEach((raw, index) => {
    const evidenceLocation = record(raw, `${location}.evidence_locations[${index}]`);
    exact(evidenceLocation, ["location_kind", "reference_handle"], `${location}.evidence_locations[${index}]`);
    text(evidenceLocation.location_kind, `${location}.evidence_locations[${index}].location_kind`);
    handle(evidenceLocation.reference_handle, `${location}.evidence_locations[${index}].reference_handle`);
  });
  return finding;
}

function parseChecks(value: unknown, location: string): readonly JsonRecord[] {
  const checks = array(value, location);
  if (checks.length !== GATE_CODES.length) fail(location);
  return checks.map((raw, index) => {
    const check = record(raw, `${location}[${index}]`);
    exact(check, ["gate_code", "status", "findings"], `${location}[${index}]`);
    if (check.gate_code !== GATE_CODES[index]) fail(`${location}[${index}].gate_code`);
    const status = enumValue(check.status, ["PASS", "CONFIRMED_FAIL", "NOT_APPLICABLE"] as const, `${location}[${index}].status`);
    const findings = array(check.findings, `${location}[${index}].findings`);
    if ((status === "CONFIRMED_FAIL") !== (findings.length > 0)) fail(`${location}[${index}].findings`);
    findings.forEach((finding, findingIndex) => parseFinding(finding, `${location}[${index}].findings[${findingIndex}]`));
    return check;
  });
}

function parseCandidateRunOutput(run: JsonRecord, location: string): CandidateOutput {
  array(run.citations, `${location}.citations`).forEach((citation, index) => parseCitation(citation, `${location}.citations[${index}]`));
  try {
    return parseCandidateOutput({
      customer_reply: run.customer_reply,
      decision: run.structured_decision,
      citations: run.citations,
    });
  } catch {
    fail(`${location}.candidate output`);
  }
}

function parseRun(value: unknown, index: 0 | 1, orderStatus: OrderStatus, seenHandles: Set<string>): ParsedRun {
  const location = `runs[${index}]`;
  const run = record(value, location);
  exact(run, ["repetition", "execution_status", "evidence_handle", "redaction_status", "source_output_commitment", "customer_reply", "structured_decision", "citations", "normalized_access_trace", "deterministic_checks"], location);
  if (run.repetition !== index + 1) fail(`${location}.repetition`);
  const executionStatus = enumValue(
    run.execution_status,
    ["COMPLETE", "INVALID", "TIMEOUT", "BUDGET_EXCEEDED"] as const,
    `${location}.execution_status`,
  );
  const evidenceHandle = handle(run.evidence_handle, `${location}.evidence_handle`);
  if (seenHandles.has(evidenceHandle)) fail(`${location}.evidence_handle reuse`);
  seenHandles.add(evidenceHandle);
  enumValue(run.redaction_status, ["REDACTED", "UNCHANGED"] as const, `${location}.redaction_status`);
  hash(run.source_output_commitment, `${location}.source_output_commitment`);
  if (executionStatus !== "COMPLETE") {
    if (
      run.customer_reply !== null
      || run.structured_decision !== null
      || run.citations !== null
      || run.normalized_access_trace !== null
      || array(run.deterministic_checks, `${location}.deterministic_checks`).length !== 0
    ) {
      fail(`${location}.terminal evidence`);
    }
    return {
      ...run,
      repetition: run.repetition as 1 | 2,
      execution_status: executionStatus,
      customer_reply: null,
      structured_decision: null,
      citations: null,
      normalized_access_trace: null,
      deterministic_checks: [],
    } as ParsedRun;
  }
  const candidateOutput = parseCandidateRunOutput(run, location);
  const trace = record(run.normalized_access_trace, `${location}.normalized_access_trace`);
  exact(trace, ["trace_kind", "policy_evidence", "order_evidence", "execution_transport_withheld", "binding_handle"], `${location}.normalized_access_trace`);
  if (trace.trace_kind !== "EVALUATOR_NORMALIZED_GROUNDING" || trace.execution_transport_withheld !== true) fail(`${location}.normalized_access_trace`);
  if (handle(trace.binding_handle, `${location}.normalized_access_trace.binding_handle`) !== evidenceHandle) fail(`${location}.normalized_access_trace.binding_handle`);
  const policy = record(trace.policy_evidence, `${location}.normalized_access_trace.policy_evidence`);
  exact(policy, ["status", "citation_ids"], `${location}.normalized_access_trace.policy_evidence`);
  const citationIds = stringArray(policy.citation_ids, `${location}.normalized_access_trace.policy_evidence.citation_ids`);
  const expectedPolicyStatus = candidateOutput.citations.length > 0 ? "RECORDED" : "NO_CITATION_RECORDED";
  if (policy.status !== expectedPolicyStatus || (expectedPolicyStatus === "RECORDED" && (citationIds.length !== 1 || citationIds[0] !== "LOCKED_POLICY_EVIDENCE")) || (expectedPolicyStatus === "NO_CITATION_RECORDED" && citationIds.length !== 0)) fail(`${location}.normalized_access_trace.policy_evidence`);
  const order = record(trace.order_evidence, `${location}.normalized_access_trace.order_evidence`);
  exact(order, ["status", "result_code"], `${location}.normalized_access_trace.order_evidence`);
  if (order.status !== orderStatus || !ORDER_STATUSES.includes(order.status as OrderStatus)) fail(`${location}.normalized_access_trace.order_evidence.status`);
  const expectedResult = { SUCCESS: "OK", DENIED: "ORDER_OWNERSHIP_MISMATCH", TIMEOUT: "TOOL_TIMEOUT", MISMATCH: "ORDER_RESULT_MISMATCH", NOT_REQUIRED: "NOT_REQUIRED" } as const;
  if (!ORDER_RESULT_CODES.includes(order.result_code as typeof ORDER_RESULT_CODES[number]) || order.result_code !== expectedResult[orderStatus]) fail(`${location}.normalized_access_trace.order_evidence.result_code`);
  const checks = parseChecks(run.deterministic_checks, `${location}.deterministic_checks`);
  return {
    ...run,
    repetition: run.repetition as 1 | 2,
    execution_status: executionStatus,
    customer_reply: candidateOutput.customer_reply,
    structured_decision: candidateOutput.decision,
    citations: candidateOutput.citations,
    deterministic_checks: checks,
  } as ParsedRun;
}

function parseJudgeRisk(value: unknown, index: number): JsonRecord {
  const location = `judge_risks[${index}]`;
  const risk = record(value, location);
  exact(risk, ["criterion_id", "status", "severity", "failure_type", "concerning_excerpt", "rationale", "evidence_references"], location);
  text(risk.criterion_id, `${location}.criterion_id`);
  if (risk.status !== "RISK") fail(`${location}.status`);
  enumValue(risk.severity, ["HIGH", "MEDIUM", "LOW"] as const, `${location}.severity`);
  text(risk.failure_type, `${location}.failure_type`);
  text(risk.concerning_excerpt, `${location}.concerning_excerpt`);
  text(risk.rationale, `${location}.rationale`);
  const references = stringArray(risk.evidence_references, `${location}.evidence_references`);
  if (references.length === 0 || references.some((reference) => !JUDGE_REFERENCES.includes(reference as typeof JUDGE_REFERENCES[number]))) fail(`${location}.evidence_references`);
  if (new Set(references).size !== references.length) fail(`${location}.evidence_references`);
  const citedRuns = references.filter((reference) => reference === "RUN_1" || reference === "RUN_2");
  if (citedRuns.length === 0) fail(`${location}.evidence_references`);
  if (
    risk.criterion_id === "RUN_TO_RUN_CONSISTENCY_RISK"
    && (citedRuns.length !== 2 || !citedRuns.includes("RUN_1") || !citedRuns.includes("RUN_2"))
  ) fail(`${location}.evidence_references`);
  return risk;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

export function parseRecordedBlindReviewEvidenceDetailProjection(value: unknown): RecordedBlindReviewEvidenceDetailView {
  const source = record(value, "blind review Evidence");
  exact(source, ["schema_version", "synthetic", "source", "source_hash", "evidence_id", "item_id", "case_id", "candidate_label", "queue_reason", "review_authority", "queue_content_hash", "queue_set_order_hash", "identity_boundary", "case_context", "locked_expectation", "active_policy_evidence", "synthetic_order_evidence", "runs", "judge_risks", "auxiliary_judge_authority", "detail_binding_hash"], "blind review Evidence");
  if (source.schema_version !== "recorded-blind-review-evidence-detail-v1" || source.synthetic !== true || source.source !== "BLIND_HUMAN_REVIEW" || source.review_authority !== "HUMAN_REVIEW_REQUIRED" || source.auxiliary_judge_authority !== "RISK_ONLY") fail("blind review Evidence authority");
  enumValue(
    source.queue_reason,
    ["LOCKED_HIGH_RISK", "JUDGE_RISK", "JUDGE_INCOMPLETE_FALLBACK"] as const,
    "queue_reason",
  );
  hash(source.source_hash, "source_hash");
  hash(source.queue_content_hash, "queue_content_hash");
  hash(source.queue_set_order_hash, "queue_set_order_hash");
  hash(source.detail_binding_hash, "detail_binding_hash");
  if (!/^review_[a-f0-9]{64}$/.test(text(source.evidence_id, "evidence_id"))) fail("evidence_id");
  const itemMatch = text(source.item_id, "item_id").match(ITEM_ID);
  if (!itemMatch) fail("item_id");
  const [caseId, blindLabel] = [itemMatch[1], itemMatch[2]];
  if (source.case_id !== `H-${caseId}` || source.candidate_label !== `Candidate ${blindLabel}`) fail("item identity");
  const identity = record(source.identity_boundary, "identity_boundary");
  exact(identity, ["blind_label", "actual_identity_withheld", "execution_transport_withheld"], "identity_boundary");
  if (identity.blind_label !== blindLabel || identity.actual_identity_withheld !== true || identity.execution_transport_withheld !== true) fail("identity_boundary");
  const context = record(source.case_context, "case_context");
  exact(context, ["as_of", "locale", "ticket_messages"], "case_context");
  if (context.locale !== "en-US") fail("case_context.locale");
  text(context.as_of, "case_context.as_of");
  const messages = array(context.ticket_messages, "case_context.ticket_messages");
  if (messages.length === 0) fail("case_context.ticket_messages");
  messages.forEach((raw, index) => {
    const message = record(raw, `case_context.ticket_messages[${index}]`);
    exact(message, ["role", "content"], `case_context.ticket_messages[${index}]`);
    if (message.role !== "customer") fail(`case_context.ticket_messages[${index}].role`);
    text(message.content, `case_context.ticket_messages[${index}].content`);
  });
  const expectation = record(source.locked_expectation, "locked_expectation");
  exact(expectation, ["expected_intent_codes", "expected_action_code", "escalation_required", "escalation_reason_code", "target_queue", "forbidden_action_codes", "required_citations", "allowed_citations", "required_reply_claims", "forbidden_reply_literals", "protected_order_fields"], "locked_expectation");
  stringArray(expectation.expected_intent_codes, "locked_expectation.expected_intent_codes");
  text(expectation.expected_action_code, "locked_expectation.expected_action_code");
  boolean(expectation.escalation_required, "locked_expectation.escalation_required");
  text(expectation.escalation_reason_code, "locked_expectation.escalation_reason_code");
  text(expectation.target_queue, "locked_expectation.target_queue");
  stringArray(expectation.forbidden_action_codes, "locked_expectation.forbidden_action_codes");
  const requiredCitations = array(expectation.required_citations, "locked_expectation.required_citations");
  const allowedCitations = array(expectation.allowed_citations, "locked_expectation.allowed_citations");
  if (requiredCitations.length === 0 || allowedCitations.length === 0) fail("locked_expectation citations");
  const parsedRequiredCitations = requiredCitations.map((citation, index) => parseCitation(citation, `locked_expectation.required_citations[${index}]`));
  allowedCitations.forEach((citation, index) => parseCitation(citation, `locked_expectation.allowed_citations[${index}]`));
  array(expectation.required_reply_claims, "locked_expectation.required_reply_claims").forEach((raw, index) => {
    const claim = record(raw, `locked_expectation.required_reply_claims[${index}]`);
    exact(claim, ["claim_id", "alternatives"], `locked_expectation.required_reply_claims[${index}]`);
    text(claim.claim_id, `locked_expectation.required_reply_claims[${index}].claim_id`);
    stringArray(claim.alternatives, `locked_expectation.required_reply_claims[${index}].alternatives`);
  });
  const forbiddenLiterals = array(expectation.forbidden_reply_literals, "locked_expectation.forbidden_reply_literals");
  forbiddenLiterals.forEach((raw, index) => {
    const literal = record(raw, `locked_expectation.forbidden_reply_literals[${index}]`);
    exact(literal, ["literal_id", "literal", "category"], `locked_expectation.forbidden_reply_literals[${index}]`);
    text(literal.literal_id, `locked_expectation.forbidden_reply_literals[${index}].literal_id`);
    text(literal.literal, `locked_expectation.forbidden_reply_literals[${index}].literal`);
    text(literal.category, `locked_expectation.forbidden_reply_literals[${index}].category`);
  });
  stringArray(expectation.protected_order_fields, "locked_expectation.protected_order_fields");
  const policies = array(source.active_policy_evidence, "active_policy_evidence").map((raw, index) => parsePolicy(raw, `active_policy_evidence[${index}]`));
  if (policies.length === 0) fail("active_policy_evidence");
  if (parsedRequiredCitations.some((required) => !policies.some((policy) => (
    policy.source_id === required.source_id && policy.section_id === required.section_id
  )))) fail("active_policy_evidence required citation");
  const orderEvidence = record(source.synthetic_order_evidence, "synthetic_order_evidence");
  exact(orderEvidence, ["status", "snapshot"], "synthetic_order_evidence");
  const orderStatus = enumValue(orderEvidence.status, ORDER_STATUSES, "synthetic_order_evidence.status");
  if ((orderStatus === "SUCCESS") !== (orderEvidence.snapshot !== null)) fail("synthetic_order_evidence snapshot");
  if (orderEvidence.snapshot !== null) parseOrderSnapshot(orderEvidence.snapshot);
  const rawRuns = array(source.runs, "runs");
  if (rawRuns.length !== 2) fail("runs");
  const seenHandles = new Set<string>();
  const parsedRuns = [parseRun(rawRuns[0], 0, orderStatus, seenHandles), parseRun(rawRuns[1], 1, orderStatus, seenHandles)] as const;
  const risks = array(source.judge_risks, "judge_risks").map(parseJudgeRisk);
  assertNoLeak(source);
  return deepFreeze({
    ...source,
    item_id: source.item_id as string,
    candidate_label: source.candidate_label as `Candidate ${"X" | "Y" | "Z"}`,
    active_policy_evidence: policies,
    runs: parsedRuns,
    synthetic_order_evidence: orderEvidence,
    locked_expectation: expectation,
    judge_risks: risks,
    detail_binding_hash: source.detail_binding_hash as string,
  });
}

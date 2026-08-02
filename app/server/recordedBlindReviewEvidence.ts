import {
  assertPersistedRecordedBenchmarkPack,
  type RecordedBenchmarkPack,
} from "../eval/pack/recordedBenchmarkPack";
import {
  buildBlindReviewCandidateOutputProjection,
} from "../eval/judge/buildJudgeInput";
import {
  assertNoBlindJudgeIdentityLeak,
  BLIND_JUDGE_COMMON_EVIDENCE_IDS,
  BLIND_JUDGE_LABELS,
} from "../eval/judge/contracts";
import {
  parseCandidateOutput,
  type CandidateOutput,
} from "../eval/contracts/candidateOutput";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../eval/runtime/canonicalJson";

const GATE_CODES = [
  "P0-HG-01",
  "P0-HG-02",
  "P0-HG-03",
  "P0-HG-04",
] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const EVIDENCE_HANDLE = /^evh_[a-f0-9]{64}$/;
const ITEM_ID = /^H-(?:00[1-9]|01[0-2])--[XYZ]$/;

type JsonRecord = Record<string, unknown>;
type BlindLabel = (typeof BLIND_JUDGE_LABELS)[number];
type GateCode = (typeof GATE_CODES)[number];

export interface RecordedBlindPolicyEvidence {
  readonly citation_role:
    | "REQUIRED"
    | "ALLOWED"
    | "REQUIRED_AND_ALLOWED";
  readonly source_id: string;
  readonly section_id: string;
  readonly version: string;
  readonly title: string;
  readonly lifecycle_status: "ACTIVE";
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly excerpt: string;
}

export interface RecordedBlindSyntheticOrderSnapshot {
  readonly order_id: string;
  readonly status: string;
  readonly fulfillment_locked: boolean;
  readonly placed_at: string;
  readonly shipped_at: string | null;
  readonly delivered_at: string | null;
  readonly promised_delivery_date: string;
  readonly total_amount: number;
  readonly currency: string;
  readonly carrier: string | null;
  readonly tracking_number: string | null;
  readonly refund_status: string | null;
  readonly refund_approved_at: string | null;
  readonly items: readonly {
    readonly product_id: string;
    readonly category: string;
    readonly condition: string;
    readonly custom_made: boolean;
    readonly final_sale: boolean;
    readonly damaged: boolean;
    readonly opened: boolean;
    readonly defective: boolean;
  }[];
}

export interface RecordedBlindDeterministicFinding {
  readonly finding_code: string;
  readonly evidence_excerpt: string;
  readonly finding_handle: string;
  readonly message_handle: string;
  readonly evidence_locations: readonly {
    readonly location_kind: string;
    readonly reference_handle: string;
  }[];
}

export interface RecordedBlindDeterministicCheck {
  readonly gate_code: GateCode;
  readonly status: "PASS" | "CONFIRMED_FAIL" | "NOT_APPLICABLE";
  readonly findings: readonly RecordedBlindDeterministicFinding[];
}

export interface RecordedBlindReviewRunDetail {
  readonly repetition: 1 | 2;
  readonly execution_status: "COMPLETE" | "INVALID" | "TIMEOUT" | "BUDGET_EXCEEDED";
  readonly evidence_handle: string;
  readonly redaction_status: "REDACTED" | "UNCHANGED";
  readonly source_output_commitment: string;
  readonly customer_reply: string | null;
  readonly structured_decision: CandidateOutput["decision"] | null;
  readonly citations: CandidateOutput["citations"] | null;
  readonly normalized_access_trace: {
    readonly trace_kind: "EVALUATOR_NORMALIZED_GROUNDING";
    readonly policy_evidence: {
      readonly status: "RECORDED" | "NO_CITATION_RECORDED";
      readonly citation_ids: readonly string[];
    };
    readonly order_evidence: {
      readonly status:
        | "SUCCESS"
        | "DENIED"
        | "TIMEOUT"
        | "MISMATCH"
        | "NOT_REQUIRED";
      readonly result_code:
        | "OK"
        | "ORDER_OWNERSHIP_MISMATCH"
        | "TOOL_TIMEOUT"
        | "ORDER_RESULT_MISMATCH"
        | "NOT_REQUIRED";
    };
    readonly execution_transport_withheld: true;
    readonly binding_handle: string;
  } | null;
  readonly deterministic_checks:
    | readonly []
    | readonly [
      RecordedBlindDeterministicCheck,
      RecordedBlindDeterministicCheck,
      RecordedBlindDeterministicCheck,
      RecordedBlindDeterministicCheck,
    ];
}

export interface RecordedBlindJudgeRisk {
  readonly criterion_id: string;
  readonly status: "RISK";
  readonly severity: "HIGH" | "MEDIUM" | "LOW";
  readonly failure_type: string;
  readonly concerning_excerpt: string;
  readonly rationale: string;
  readonly evidence_references: readonly string[];
}

export interface RecordedBlindReviewEvidenceDetailProjection {
  readonly schema_version: "recorded-blind-review-evidence-detail-v1";
  readonly synthetic: true;
  readonly source: "BLIND_HUMAN_REVIEW";
  readonly source_hash: string;
  readonly evidence_id: string;
  readonly item_id: string;
  readonly case_id: string;
  readonly candidate_label: `Candidate ${BlindLabel}`;
  readonly queue_reason:
    | "LOCKED_HIGH_RISK"
    | "JUDGE_RISK"
    | "JUDGE_INCOMPLETE_FALLBACK";
  readonly review_authority: "HUMAN_REVIEW_REQUIRED";
  readonly queue_content_hash: string;
  readonly queue_set_order_hash: string;
  readonly identity_boundary: {
    readonly blind_label: BlindLabel;
    readonly actual_identity_withheld: true;
    readonly execution_transport_withheld: true;
  };
  readonly case_context: {
    readonly as_of: string;
    readonly locale: "en-US";
    readonly ticket_messages: readonly {
      readonly role: "customer";
      readonly content: string;
    }[];
  };
  readonly locked_expectation: {
    readonly expected_intent_codes: readonly string[];
    readonly expected_action_code: string;
    readonly escalation_required: boolean;
    readonly escalation_reason_code: string;
    readonly target_queue: string;
    readonly forbidden_action_codes: readonly string[];
    readonly required_citations: readonly {
      readonly source_id: string;
      readonly section_id: string;
    }[];
    readonly allowed_citations: readonly {
      readonly source_id: string;
      readonly section_id: string;
    }[];
    readonly required_reply_claims: readonly {
      readonly claim_id: string;
      readonly alternatives: readonly string[];
    }[];
    readonly forbidden_reply_literals: readonly {
      readonly literal_id: string;
      readonly literal: string;
      readonly category: string;
    }[];
    readonly protected_order_fields: readonly string[];
  };
  readonly active_policy_evidence: readonly RecordedBlindPolicyEvidence[];
  readonly synthetic_order_evidence: {
    readonly status:
      | "SUCCESS"
      | "DENIED"
      | "TIMEOUT"
      | "MISMATCH"
      | "NOT_REQUIRED";
    readonly snapshot: RecordedBlindSyntheticOrderSnapshot | null;
  };
  readonly runs: readonly [
    RecordedBlindReviewRunDetail,
    RecordedBlindReviewRunDetail,
  ];
  readonly judge_risks: readonly RecordedBlindJudgeRisk[];
  readonly auxiliary_judge_authority: "RISK_ONLY";
  readonly detail_binding_hash: string;
}

export class RecordedBlindReviewEvidenceIntegrityError extends Error {
  readonly code = "RECORDED_BLIND_REVIEW_EVIDENCE_INTEGRITY" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecordedBlindReviewEvidenceIntegrityError";
  }
}

function fail(message: string, cause?: unknown): never {
  throw new RecordedBlindReviewEvidenceIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
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
    fail(`${location}은 plain JSON 객체여야 합니다.`);
  }
  return value as JsonRecord;
}

function exact(
  value: JsonRecord,
  keys: readonly string[],
  location: string,
): void {
  const expected = new Set(keys);
  if (
    keys.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !expected.has(key))
  ) {
    fail(`${location} exact-key 계약이 다릅니다.`);
  }
}

function text(value: unknown, location: string): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || /\p{Cc}/u.test(value)
  ) {
    fail(`${location}은 비어 있지 않은 안전한 문자열이어야 합니다.`);
  }
  return value;
}

function stringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) fail(`${location}은 배열이어야 합니다.`);
  return value.map((item, index) => text(item, `${location}[${index}]`));
}

function boolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") fail(`${location}은 boolean이어야 합니다.`);
  return value;
}

function finiteNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${location}은 유한한 숫자여야 합니다.`);
  }
  return value;
}

function nullableText(value: unknown, location: string): string | null {
  return value === null ? null : text(value, location);
}

function parseJsonContent(value: unknown, location: string): unknown {
  const source = text(value, location);
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    fail(`${location}이 JSON이 아닙니다.`, error);
  }
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function parseCitations(value: unknown, location: string) {
  if (!Array.isArray(value)) fail(`${location}은 배열이어야 합니다.`);
  return value.map((item, index) => {
    const citation = record(item, `${location}[${index}]`);
    exact(citation, ["source_id", "section_id"], `${location}[${index}]`);
    return {
      source_id: text(citation.source_id, `${location}[${index}].source_id`),
      section_id: text(citation.section_id, `${location}[${index}].section_id`),
    };
  });
}

function parseLockedEvidence(
  expectedBlindInput: JsonRecord,
): ReadonlyMap<string, unknown> {
  if (!Array.isArray(expectedBlindInput.locked_evidence)) {
    fail("expected_blind_input.locked_evidence가 배열이 아닙니다.");
  }
  const parsed = new Map<string, unknown>();
  expectedBlindInput.locked_evidence.forEach((raw, index) => {
    const item = record(raw, `locked_evidence[${index}]`);
    exact(item, ["evidence_id", "content"], `locked_evidence[${index}]`);
    const evidenceId = text(
      item.evidence_id,
      `locked_evidence[${index}].evidence_id`,
    );
    if (
      !BLIND_JUDGE_COMMON_EVIDENCE_IDS.includes(
        evidenceId as (typeof BLIND_JUDGE_COMMON_EVIDENCE_IDS)[number],
      )
      || parsed.has(evidenceId)
    ) {
      fail(`locked_evidence ID가 잠긴 공통 목록과 다릅니다: ${evidenceId}`);
    }
    parsed.set(
      evidenceId,
      parseJsonContent(item.content, `locked_evidence[${index}].content`),
    );
  });
  if (
    parsed.size !== BLIND_JUDGE_COMMON_EVIDENCE_IDS.length
    || BLIND_JUDGE_COMMON_EVIDENCE_IDS.some((id) => !parsed.has(id))
  ) {
    fail("locked_evidence 공통 근거 coverage가 완전하지 않습니다.");
  }
  return parsed;
}

function isActivePolicy(
  policy: JsonRecord,
  asOf: string,
): boolean {
  if (policy.lifecycle_status !== "ACTIVE") return false;
  const date = asOf.slice(0, 10);
  const from = text(policy.effective_from, "policy.effective_from");
  const to = policy.effective_to === null
    ? null
    : text(policy.effective_to, "policy.effective_to");
  return from <= date && (to === null || to >= date);
}

function parseActivePolicies(
  value: unknown,
  asOf: string,
  requiredCitations: readonly { source_id: string; section_id: string }[],
): RecordedBlindPolicyEvidence[] {
  const envelope = record(value, "locked policy evidence");
  exact(envelope, ["sections"], "locked policy evidence");
  if (!Array.isArray(envelope.sections)) {
    fail("locked policy evidence.sections가 배열이 아닙니다.");
  }
  const active = envelope.sections.flatMap((raw, index) => {
    const policy = record(raw, `locked policy evidence.sections[${index}]`);
    if (!isActivePolicy(policy, asOf)) return [];
    if (
      policy.citation_role !== "REQUIRED"
      && policy.citation_role !== "ALLOWED"
      && policy.citation_role !== "REQUIRED_AND_ALLOWED"
    ) {
      fail(`locked policy evidence.sections[${index}].citation_role이 다릅니다.`);
    }
    const citationRole =
      policy.citation_role as RecordedBlindPolicyEvidence["citation_role"];
    const excerpt = Array.from(
      text(policy.text, `locked policy evidence.sections[${index}].text`),
    ).slice(0, 600).join("");
    return [{
      citation_role: citationRole,
      source_id: text(
        policy.source_id,
        `locked policy evidence.sections[${index}].source_id`,
      ),
      section_id: text(
        policy.section_id,
        `locked policy evidence.sections[${index}].section_id`,
      ),
      version: text(
        policy.version,
        `locked policy evidence.sections[${index}].version`,
      ),
      title: text(
        policy.title,
        `locked policy evidence.sections[${index}].title`,
      ),
      lifecycle_status: "ACTIVE" as const,
      effective_from: text(
        policy.effective_from,
        `locked policy evidence.sections[${index}].effective_from`,
      ),
      effective_to: policy.effective_to === null
        ? null
        : text(
            policy.effective_to,
            `locked policy evidence.sections[${index}].effective_to`,
          ),
      excerpt,
    }];
  });
  if (
    requiredCitations.some((required) => !active.some((policy) => (
      policy.source_id === required.source_id
      && policy.section_id === required.section_id
    )))
  ) {
    fail("필수 citation에 대응하는 active policy excerpt가 없습니다.");
  }
  return active;
}

function parseOrderItem(value: unknown, location: string) {
  const item = record(value, location);
  exact(item, [
    "product_id",
    "category",
    "condition",
    "custom_made",
    "final_sale",
    "damaged",
    "opened",
    "defective",
  ], location);
  return {
    product_id: text(item.product_id, `${location}.product_id`),
    category: text(item.category, `${location}.category`),
    condition: text(item.condition, `${location}.condition`),
    custom_made: boolean(item.custom_made, `${location}.custom_made`),
    final_sale: boolean(item.final_sale, `${location}.final_sale`),
    damaged: boolean(item.damaged, `${location}.damaged`),
    opened: boolean(item.opened, `${location}.opened`),
    defective: boolean(item.defective, `${location}.defective`),
  };
}

function parseOrderSnapshot(
  value: unknown,
): RecordedBlindSyntheticOrderSnapshot {
  const snapshot = record(value, "synthetic order snapshot");
  exact(snapshot, [
    "order_id",
    "status",
    "fulfillment_locked",
    "placed_at",
    "shipped_at",
    "delivered_at",
    "promised_delivery_date",
    "total_amount",
    "currency",
    "carrier",
    "tracking_number",
    "refund_status",
    "refund_approved_at",
    "items",
  ], "synthetic order snapshot");
  if (!Array.isArray(snapshot.items)) {
    fail("synthetic order snapshot.items가 배열이 아닙니다.");
  }
  return {
    order_id: text(snapshot.order_id, "synthetic order snapshot.order_id"),
    status: text(snapshot.status, "synthetic order snapshot.status"),
    fulfillment_locked: boolean(
      snapshot.fulfillment_locked,
      "synthetic order snapshot.fulfillment_locked",
    ),
    placed_at: text(snapshot.placed_at, "synthetic order snapshot.placed_at"),
    shipped_at: nullableText(
      snapshot.shipped_at,
      "synthetic order snapshot.shipped_at",
    ),
    delivered_at: nullableText(
      snapshot.delivered_at,
      "synthetic order snapshot.delivered_at",
    ),
    promised_delivery_date: text(
      snapshot.promised_delivery_date,
      "synthetic order snapshot.promised_delivery_date",
    ),
    total_amount: finiteNumber(
      snapshot.total_amount,
      "synthetic order snapshot.total_amount",
    ),
    currency: text(snapshot.currency, "synthetic order snapshot.currency"),
    carrier: nullableText(snapshot.carrier, "synthetic order snapshot.carrier"),
    tracking_number: nullableText(
      snapshot.tracking_number,
      "synthetic order snapshot.tracking_number",
    ),
    refund_status: nullableText(
      snapshot.refund_status,
      "synthetic order snapshot.refund_status",
    ),
    refund_approved_at: nullableText(
      snapshot.refund_approved_at,
      "synthetic order snapshot.refund_approved_at",
    ),
    items: snapshot.items.map((item, index) => (
      parseOrderItem(item, `synthetic order snapshot.items[${index}]`)
    )),
  };
}

function parseOrderEvidence(
  value: unknown,
): RecordedBlindReviewEvidenceDetailProjection["synthetic_order_evidence"] {
  const evidence = record(value, "locked order evidence");
  exact(evidence, ["status", "snapshot"], "locked order evidence");
  if (
    evidence.status !== "SUCCESS"
    && evidence.status !== "DENIED"
    && evidence.status !== "TIMEOUT"
    && evidence.status !== "MISMATCH"
    && evidence.status !== "NOT_REQUIRED"
  ) {
    fail("locked order evidence.status가 다릅니다.");
  }
  const status = evidence.status as (
    RecordedBlindReviewEvidenceDetailProjection["synthetic_order_evidence"]["status"]
  );
  if (
    (status === "SUCCESS" && evidence.snapshot === null)
    || (status !== "SUCCESS" && evidence.snapshot !== null)
  ) {
    fail("locked order evidence status·snapshot이 모순됩니다.");
  }
  return {
    status,
    snapshot: evidence.snapshot === null
      ? null
      : parseOrderSnapshot(evidence.snapshot),
  };
}

function parseExpectedDecision(value: unknown) {
  const expected = record(value, "locked expected decision");
  exact(expected, [
    "expected_intent_codes",
    "expected_action_code",
    "escalation_required",
    "escalation_reason_code",
    "target_queue",
    "forbidden_action_codes",
  ], "locked expected decision");
  return {
    expected_intent_codes: stringArray(
      expected.expected_intent_codes,
      "locked expected decision.expected_intent_codes",
    ),
    expected_action_code: text(
      expected.expected_action_code,
      "locked expected decision.expected_action_code",
    ),
    escalation_required: boolean(
      expected.escalation_required,
      "locked expected decision.escalation_required",
    ),
    escalation_reason_code: text(
      expected.escalation_reason_code,
      "locked expected decision.escalation_reason_code",
    ),
    target_queue: text(
      expected.target_queue,
      "locked expected decision.target_queue",
    ),
    forbidden_action_codes: stringArray(
      expected.forbidden_action_codes,
      "locked expected decision.forbidden_action_codes",
    ),
  };
}

function parseReplyClaims(value: unknown) {
  if (!Array.isArray(value)) fail("required reply claims가 배열이 아닙니다.");
  return value.map((raw, index) => {
    const claim = record(raw, `required reply claims[${index}]`);
    exact(claim, ["claim_id", "alternatives"], `required reply claims[${index}]`);
    return {
      claim_id: text(claim.claim_id, `required reply claims[${index}].claim_id`),
      alternatives: stringArray(
        claim.alternatives,
        `required reply claims[${index}].alternatives`,
      ),
    };
  });
}

function parseForbiddenLiterals(value: unknown) {
  if (!Array.isArray(value)) fail("forbidden reply literals가 배열이 아닙니다.");
  return value.map((raw, index) => {
    const literal = record(raw, `forbidden reply literals[${index}]`);
    exact(
      literal,
      ["literal_id", "literal", "category"],
      `forbidden reply literals[${index}]`,
    );
    return {
      literal_id: text(
        literal.literal_id,
        `forbidden reply literals[${index}].literal_id`,
      ),
      literal: text(
        literal.literal,
        `forbidden reply literals[${index}].literal`,
      ),
      category: text(
        literal.category,
        `forbidden reply literals[${index}].category`,
      ),
    };
  });
}

function parseMapping(
  judgeCase: JsonRecord,
  blindLabel: BlindLabel,
): "A" | "B" | "C" {
  const mapping = record(judgeCase.private_mapping, "private mapping");
  const labelToCandidate = record(
    mapping.label_to_candidate,
    "private mapping.label_to_candidate",
  );
  exact(labelToCandidate, ["X", "Y", "Z"], "private mapping.label_to_candidate");
  const mapped = BLIND_JUDGE_LABELS.map((label) => labelToCandidate[label]);
  if (
    mapped.some((candidate) => (
      candidate !== "A" && candidate !== "B" && candidate !== "C"
    ))
    || new Set(mapped).size !== 3
  ) {
    fail("private mapping이 A/B/C permutation이 아닙니다.");
  }
  return labelToCandidate[blindLabel] as "A" | "B" | "C";
}

function parseSafeFinding(
  value: unknown,
  location: string,
): RecordedBlindDeterministicFinding {
  const finding = record(value, location);
  exact(finding, [
    "finding_code",
    "source_finding_handle",
    "evidence_excerpt",
    "source_message_handle",
    "evidence_locations",
  ], location);
  if (!Array.isArray(finding.evidence_locations)) {
    fail(`${location}.evidence_locations가 배열이 아닙니다.`);
  }
  const locations = finding.evidence_locations.map((raw, index) => {
    const evidenceLocation = record(
      raw,
      `${location}.evidence_locations[${index}]`,
    );
    exact(
      evidenceLocation,
      ["location_kind", "reference_handle"],
      `${location}.evidence_locations[${index}]`,
    );
    const referenceHandle = text(
      evidenceLocation.reference_handle,
      `${location}.evidence_locations[${index}].reference_handle`,
    );
    if (!EVIDENCE_HANDLE.test(referenceHandle)) {
      fail(`${location}.evidence_locations[${index}].reference_handle`);
    }
    return {
      location_kind: text(
        evidenceLocation.location_kind,
        `${location}.evidence_locations[${index}].location_kind`,
      ),
      reference_handle: referenceHandle,
    };
  });
  const findingHandle = text(
    finding.source_finding_handle,
    `${location}.source_finding_handle`,
  );
  const messageHandle = text(
    finding.source_message_handle,
    `${location}.source_message_handle`,
  );
  if (
    !EVIDENCE_HANDLE.test(findingHandle)
    || !EVIDENCE_HANDLE.test(messageHandle)
    || locations.length === 0
  ) {
    fail(`${location}의 opaque evidence handle이 불완전합니다.`);
  }
  return {
    finding_code: text(finding.finding_code, `${location}.finding_code`),
    evidence_excerpt: text(
      finding.evidence_excerpt,
      `${location}.evidence_excerpt`,
    ),
    finding_handle: findingHandle,
    message_handle: messageHandle,
    evidence_locations: locations,
  };
}

function parseDeterministicChecks({
  slot,
  queueItem,
  repetition,
}: {
  readonly slot: RecordedBenchmarkPack["benchmark_execution_pack"]["slots"][number];
  readonly queueItem: RecordedBenchmarkPack["blind_review_queue"]["items"][number];
  readonly repetition: 1 | 2;
}): RecordedBlindReviewRunDetail["deterministic_checks"] {
  const evaluation = record(slot.evaluation_state, `run ${repetition} evaluation`);
  const rawGates = evaluation.gates;
  if (evaluation.status !== "EVALUATED" || !Array.isArray(rawGates)) {
    fail(`run ${repetition}의 결정적 평가가 완료되지 않았습니다.`);
  }
  if (rawGates.length !== 4) {
    fail(`run ${repetition}의 결정적 gate 수가 4가 아닙니다.`);
  }
  const checks = GATE_CODES.map((gateCode, gateIndex) => {
    const gate = record(
      rawGates[gateIndex],
      `run ${repetition} gate ${gateCode}`,
    );
    if (
      gate.gateCode !== gateCode
      || (
        gate.status !== "PASS"
        && gate.status !== "CONFIRMED_FAIL"
        && gate.status !== "NOT_APPLICABLE"
      )
      || !Array.isArray(gate.findings)
    ) {
      fail(`run ${repetition} gate ${gateCode} 계약이 다릅니다.`);
    }
    const status = gate.status;
    const queueMatches = queueItem.deterministic_gate_evidence.filter(
      (item) => item.repetition === repetition && item.gate_id === gateCode,
    );
    if (
      (status === "CONFIRMED_FAIL" && queueMatches.length !== 1)
      || (status !== "CONFIRMED_FAIL" && queueMatches.length !== 0)
    ) {
      fail(`run ${repetition} gate ${gateCode}와 blind queue 근거가 모순됩니다.`);
    }
    if (
      (status === "CONFIRMED_FAIL" && gate.findings.length === 0)
      || (status !== "CONFIRMED_FAIL" && gate.findings.length > 0)
    ) {
      fail(`run ${repetition} gate ${gateCode} status·finding이 모순됩니다.`);
    }
    const findings = queueMatches.length === 0
      ? []
      : queueMatches[0].findings.map((finding, index) => (
          parseSafeFinding(
            finding,
            `run ${repetition} gate ${gateCode} findings[${index}]`,
          )
        ));
    if (
      status === "CONFIRMED_FAIL"
      && findings.length !== gate.findings.length
    ) {
      fail(`run ${repetition} gate ${gateCode} finding coverage가 다릅니다.`);
    }
    return {
      gate_code: gateCode,
      status,
      findings,
    };
  });
  return checks as unknown as [
    RecordedBlindDeterministicCheck,
    RecordedBlindDeterministicCheck,
    RecordedBlindDeterministicCheck,
    RecordedBlindDeterministicCheck,
  ];
}

function normalizeJudgeEvidenceReference(
  evidenceId: string,
  blindLabel: BlindLabel,
): string {
  if (evidenceId === `${blindLabel}:RUN:1`) return "RUN_1";
  if (evidenceId === `${blindLabel}:RUN:2`) return "RUN_2";
  if (evidenceId === "CASE:TICKET") return "CASE_CONTEXT";
  if (evidenceId === "EVALUATOR:POLICY_SECTIONS") return "POLICY_EVIDENCE";
  if (evidenceId === "EVALUATOR:ORDER_ACCESS") return "ORDER_EVIDENCE";
  if (evidenceId.startsWith("ORACLE:")) return "LOCKED_EXPECTATION";
  fail(`Judge RISK evidence ID가 blind item 범위를 벗어났습니다: ${evidenceId}`);
}

function parseJudgeRisks(
  queueItem: RecordedBenchmarkPack["blind_review_queue"]["items"][number],
): RecordedBlindJudgeRisk[] {
  return queueItem.judge_risks.map((risk, index) => {
    if (
      risk.status !== "RISK"
      || (
        risk.severity !== "HIGH"
        && risk.severity !== "MEDIUM"
        && risk.severity !== "LOW"
      )
    ) {
      fail(`judge_risks[${index}] 계약이 다릅니다.`);
    }
    return {
      criterion_id: text(risk.criterion_id, `judge_risks[${index}].criterion_id`),
      status: "RISK" as const,
      severity: risk.severity,
      failure_type: text(
        risk.failure_type,
        `judge_risks[${index}].failure_type`,
      ),
      concerning_excerpt: text(
        risk.concerning_excerpt,
        `judge_risks[${index}].concerning_excerpt`,
      ),
      rationale: text(risk.rationale, `judge_risks[${index}].rationale`),
      evidence_references: [...new Set(risk.evidence_ids.map((evidenceId) => (
        normalizeJudgeEvidenceReference(evidenceId, queueItem.blind_label)
      )))],
    };
  });
}

function parseAccessTrace(
  slot: RecordedBenchmarkPack["benchmark_execution_pack"]["slots"][number],
  output: CandidateOutput,
  queueRun: RecordedBenchmarkPack["blind_review_queue"]["items"][number]["runs"][number],
): RecordedBlindReviewRunDetail["normalized_access_trace"] {
  type NormalizedAccessTrace = NonNullable<
    RecordedBlindReviewRunDetail["normalized_access_trace"]
  >;
  const access = record(slot.access_evidence, "slot access evidence");
  const orderAccess = record(access.orderAccess, "slot access evidence.orderAccess");
  if (
    orderAccess.status !== "SUCCESS"
    && orderAccess.status !== "DENIED"
    && orderAccess.status !== "TIMEOUT"
    && orderAccess.status !== "MISMATCH"
    && orderAccess.status !== "NOT_REQUIRED"
  ) {
    fail("slot access evidence.orderAccess.status가 다릅니다.");
  }
  const orderStatus = orderAccess.status as (
    NormalizedAccessTrace["order_evidence"]["status"]
  );
  const expectedResultCode = {
    SUCCESS: "OK",
    DENIED: "ORDER_OWNERSHIP_MISMATCH",
    TIMEOUT: "TOOL_TIMEOUT",
    MISMATCH: "ORDER_RESULT_MISMATCH",
    NOT_REQUIRED: "NOT_REQUIRED",
  } as const;
  if (orderAccess.resultCode !== expectedResultCode[orderStatus]) {
    fail("slot access evidence order status와 result code가 모순됩니다.");
  }
  if (
    access.slotId !== slot.slot.slot_id
    || access.caseId !== slot.slot.case_id
    || access.candidateId !== slot.slot.candidate_id
    || access.repetition !== slot.slot.repetition
  ) {
    fail("slot access evidence identity가 mapped blind run과 다릅니다.");
  }
  if (!EVIDENCE_HANDLE.test(queueRun.evidence_handle)) {
    fail("blind run evidence handle이 올바르지 않습니다.");
  }
  return {
    trace_kind: "EVALUATOR_NORMALIZED_GROUNDING" as const,
    policy_evidence: {
      status: output.citations.length > 0
        ? "RECORDED" as const
        : "NO_CITATION_RECORDED" as const,
      citation_ids: output.citations.length > 0
        ? ["LOCKED_POLICY_EVIDENCE"]
        : [],
    },
    order_evidence: {
      status: orderStatus,
      result_code: orderAccess.resultCode as (
        NormalizedAccessTrace["order_evidence"]["result_code"]
      ),
    },
    execution_transport_withheld: true as const,
    binding_handle: queueRun.evidence_handle,
  };
}

function buildRunDetail({
  slot,
  queueItem,
  queueRun,
  expectedBlindRun,
}: {
  readonly slot: RecordedBenchmarkPack["benchmark_execution_pack"]["slots"][number];
  readonly queueItem: RecordedBenchmarkPack["blind_review_queue"]["items"][number];
  readonly queueRun: RecordedBenchmarkPack["blind_review_queue"]["items"][number]["runs"][number];
  readonly expectedBlindRun: JsonRecord;
}): RecordedBlindReviewRunDetail {
  if (
    slot.run === null
    || slot.slot.repetition !== queueRun.repetition
    || queueRun.repetition !== expectedBlindRun.repetition
  ) {
    fail("blind review run과 mapped terminal slot 좌표가 다릅니다.");
  }
  const executionStatus = slot.execution_status;
  if (
    executionStatus !== "COMPLETE"
    && executionStatus !== "INVALID"
    && executionStatus !== "TIMEOUT"
    && executionStatus !== "BUDGET_EXCEEDED"
  ) fail("blind review slot 실행 상태가 Judge terminal 계약과 다릅니다.");
  if (
    queueRun.execution_status !== executionStatus
    || expectedBlindRun.execution_status !== executionStatus
    || !same(queueRun.projection, expectedBlindRun.projection)
  ) fail("blind review 실행 상태·commitment가 raw slot과 Judge precommit 입력에 결합되지 않습니다.");
  const expectedProjection = record(
    expectedBlindRun.projection,
    "expected blind run projection",
  );
  if (
    (expectedProjection.redaction_status !== "REDACTED"
      && expectedProjection.redaction_status !== "UNCHANGED")
    || typeof expectedProjection.source_output_commitment !== "string"
    || !SHA256.test(expectedProjection.source_output_commitment)
  ) {
    fail("blind run redaction·source commitment가 다릅니다.");
  }
  if (executionStatus !== "COMPLETE") {
    if (
      slot.evaluation_state.status !== "NOT_EVALUATED"
      || queueRun.review_output !== null
      || expectedBlindRun.output !== null
    ) {
      fail("terminal blind review run에는 null output과 NOT_EVALUATED 근거가 필요합니다.");
    }
    return {
      repetition: queueRun.repetition,
      execution_status: executionStatus,
      evidence_handle: queueRun.evidence_handle,
      redaction_status: expectedProjection.redaction_status,
      source_output_commitment: expectedProjection.source_output_commitment,
      customer_reply: null,
      structured_decision: null,
      citations: null,
      normalized_access_trace: null,
      deterministic_checks: [],
    };
  }
  const rawOutput = parseCandidateOutput(slot.run.output);
  const blindedOutput = buildBlindReviewCandidateOutputProjection(rawOutput);
  const queueOutput = parseCandidateOutput(queueRun.review_output);
  const expectedOutput = parseCandidateOutput(expectedBlindRun.output);
  if (
    !same(blindedOutput, queueOutput)
    || !same(queueOutput, expectedOutput)
  ) {
    fail("blind review output·commitment가 raw slot과 Judge precommit 입력에 결합되지 않습니다.");
  }
  return {
    repetition: queueRun.repetition,
    execution_status: "COMPLETE",
    evidence_handle: queueRun.evidence_handle,
    redaction_status: expectedProjection.redaction_status,
    source_output_commitment: expectedProjection.source_output_commitment,
    // X/Y/Z queue output은 사람 검수에 필요한 실제 답변·결정·인용입니다.
    // raw slot identity와 A/B/C mapping은 이 projection에 포함하지 않습니다.
    customer_reply: queueOutput.customer_reply,
    structured_decision: structuredClone(queueOutput.decision),
    citations: structuredClone(queueOutput.citations),
    normalized_access_trace: parseAccessTrace(slot, queueOutput, queueRun),
    deterministic_checks: parseDeterministicChecks({
      slot,
      queueItem,
      repetition: queueRun.repetition,
    }),
  };
}

/**
 * private mapping은 서버 내부에서 raw slot을 X/Y/Z queue run에 결합하는 데만
 * 사용합니다. 반환 projection에는 실제 후보 ID, 실행 transport, 비용, 지연을
 * 포함하지 않습니다.
 */
export function buildRecordedBlindReviewEvidenceDetailProjection(
  recordedBenchmarkPack: RecordedBenchmarkPack,
  itemId: string,
): RecordedBlindReviewEvidenceDetailProjection {
  try {
    assertPersistedRecordedBenchmarkPack(recordedBenchmarkPack);
  } catch (error) {
    fail(
      "Blind Evidence에는 저장 후 source-reload 검증된 Recorded Benchmark Pack이 필요합니다.",
      error,
    );
  }
  if (!ITEM_ID.test(itemId)) fail("blind review item ID가 잠긴 형식이 아닙니다.");
  const queueItems = recordedBenchmarkPack.blind_review_queue.items.filter(
    (item) => item.item_id === itemId,
  );
  if (queueItems.length !== 1) {
    fail("blind review queue에서 item을 정확히 한 번 찾을 수 없습니다.");
  }
  const queueItem = queueItems[0];
  if (
    queueItem.item_id !== `${queueItem.case_id}--${queueItem.blind_label}`
    || !BLIND_JUDGE_LABELS.includes(queueItem.blind_label)
    || queueItem.review_authority !== "HUMAN_REVIEW_REQUIRED"
    || queueItem.runs.length !== 2
  ) {
    fail("blind review queue item identity·authority·run coverage가 다릅니다.");
  }
  const judgeCases = recordedBenchmarkPack.judge_evidence_pack.cases.filter(
    (item) => item.case_id === queueItem.case_id,
  );
  if (judgeCases.length !== 1) {
    fail("blind review case의 Judge evidence를 정확히 한 번 찾을 수 없습니다.");
  }
  const judgeCase = record(judgeCases[0], "judge evidence case");
  const expectedBlindInput = record(
    judgeCase.expected_blind_input,
    "expected blind input",
  );
  if (
    expectedBlindInput.schema_version !== "blind-judge-input-v1"
    || expectedBlindInput.case_id !== queueItem.case_id
    || expectedBlindInput.dataset_split !== "HIDDEN_BENCHMARK"
  ) {
    fail("expected blind input이 queue case와 다릅니다.");
  }
  const caseContext = record(expectedBlindInput.case, "expected blind input.case");
  if (
    caseContext.locale !== "en-US"
    || !Array.isArray(caseContext.ticket_messages)
  ) {
    fail("expected blind case context가 다릅니다.");
  }
  const ticketMessages = caseContext.ticket_messages.map((raw, index) => {
    const message = record(raw, `case.ticket_messages[${index}]`);
    exact(message, ["role", "content"], `case.ticket_messages[${index}]`);
    if (message.role !== "customer") {
      fail(`case.ticket_messages[${index}].role이 customer가 아닙니다.`);
    }
    return {
      role: "customer" as const,
      content: text(message.content, `case.ticket_messages[${index}].content`),
    };
  });
  const lockedEvidence = parseLockedEvidence(expectedBlindInput);
  if (!same(lockedEvidence.get("CASE:TICKET"), ticketMessages)) {
    fail("case context와 locked ticket evidence가 다릅니다.");
  }
  const expectedDecision = parseExpectedDecision(
    lockedEvidence.get("ORACLE:EXPECTED_DECISION"),
  );
  const requiredCitations = parseCitations(
    lockedEvidence.get("ORACLE:REQUIRED_CITATIONS"),
    "locked required citations",
  );
  const allowedCitations = parseCitations(
    lockedEvidence.get("ORACLE:ALLOWED_CITATIONS"),
    "locked allowed citations",
  );
  const requiredReplyClaims = parseReplyClaims(
    lockedEvidence.get("ORACLE:REQUIRED_REPLY_CLAIMS"),
  );
  const forbiddenReplyLiterals = parseForbiddenLiterals(
    lockedEvidence.get("ORACLE:FORBIDDEN_REPLY_LITERALS"),
  );
  const protectedOrderFields = stringArray(
    lockedEvidence.get("ORACLE:PROTECTED_ORDER_FIELDS"),
    "locked protected order fields",
  );
  const asOf = text(caseContext.as_of, "case.as_of");
  const activePolicyEvidence = parseActivePolicies(
    lockedEvidence.get("EVALUATOR:POLICY_SECTIONS"),
    asOf,
    requiredCitations,
  );
  const orderEvidence = parseOrderEvidence(
    lockedEvidence.get("EVALUATOR:ORDER_ACCESS"),
  );

  const mappedCandidateId = parseMapping(judgeCase, queueItem.blind_label);
  const rawSlots = recordedBenchmarkPack.benchmark_execution_pack.slots
    .filter((slot) => (
      slot.slot.case_id === queueItem.case_id
      && slot.slot.candidate_id === mappedCandidateId
    ))
    .sort((left, right) => left.slot.repetition - right.slot.repetition);
  if (
    rawSlots.length !== 2
    || rawSlots[0].slot.repetition !== 1
    || rawSlots[1].slot.repetition !== 2
  ) {
    fail("private mapping에 대응하는 두 fixed raw slot이 없습니다.");
  }
  if (!Array.isArray(expectedBlindInput.blind_candidates)) {
    fail("expected blind candidates가 배열이 아닙니다.");
  }
  const expectedCandidates = expectedBlindInput.blind_candidates.filter(
    (raw) => record(raw, "expected blind candidate").blind_label
      === queueItem.blind_label,
  );
  if (expectedCandidates.length !== 1) {
    fail("expected blind candidate를 정확히 한 번 찾을 수 없습니다.");
  }
  const expectedCandidate = record(
    expectedCandidates[0],
    "expected blind candidate",
  );
  const expectedRuns = expectedCandidate.runs;
  if (!Array.isArray(expectedRuns) || expectedRuns.length !== 2) {
    fail("expected blind candidate에는 두 fixed run이 필요합니다.");
  }
  const runs = ([0, 1] as const).map((index) => buildRunDetail({
    slot: rawSlots[index],
    queueItem,
    queueRun: queueItem.runs[index],
    expectedBlindRun: record(
      expectedRuns[index],
      `expected blind candidate.runs[${index}]`,
    ),
  })) as [
    RecordedBlindReviewRunDetail,
    RecordedBlindReviewRunDetail,
  ];
  const judgeRisks = parseJudgeRisks(queueItem);
  const sourceHash = sha256CanonicalJson(recordedBenchmarkPack);
  const evidenceId = `review_${sha256CanonicalJson({
    queue_content_hash: recordedBenchmarkPack.queue_content_hash,
    item_id: queueItem.item_id,
  })}`;
  const withoutBinding = {
    schema_version: "recorded-blind-review-evidence-detail-v1" as const,
    synthetic: true as const,
    source: "BLIND_HUMAN_REVIEW" as const,
    source_hash: sourceHash,
    evidence_id: evidenceId,
    item_id: queueItem.item_id,
    case_id: queueItem.case_id,
    candidate_label: `Candidate ${queueItem.blind_label}` as const,
    queue_reason: queueItem.queue_reason,
    review_authority: "HUMAN_REVIEW_REQUIRED" as const,
    queue_content_hash: recordedBenchmarkPack.queue_content_hash,
    queue_set_order_hash: recordedBenchmarkPack.queue_set_order_hash,
    identity_boundary: {
      blind_label: queueItem.blind_label,
      actual_identity_withheld: true as const,
      execution_transport_withheld: true as const,
    },
    case_context: {
      as_of: asOf,
      locale: "en-US" as const,
      ticket_messages: ticketMessages,
    },
    locked_expectation: {
      ...expectedDecision,
      required_citations: requiredCitations,
      allowed_citations: allowedCitations,
      required_reply_claims: requiredReplyClaims,
      forbidden_reply_literals: forbiddenReplyLiterals,
      protected_order_fields: protectedOrderFields,
    },
    active_policy_evidence: activePolicyEvidence,
    synthetic_order_evidence: orderEvidence,
    runs,
    judge_risks: judgeRisks,
    auxiliary_judge_authority: "RISK_ONLY" as const,
  };
  const projection: RecordedBlindReviewEvidenceDetailProjection = {
    ...withoutBinding,
    detail_binding_hash: sha256CanonicalJson({
      schema_version: "recorded-blind-review-evidence-detail-binding-v1",
      detail: withoutBinding,
    }),
  };
  try {
    assertNoBlindJudgeIdentityLeak(
      projection,
      "recorded blind review Evidence detail",
    );
  } catch (error) {
    fail("Blind Evidence detail에 후보 identity 또는 architecture 누출이 있습니다.", error);
  }
  const serialized = canonicalJsonStringify(projection);
  if (
    /label_to_candidate|private_mapping|candidate_id|ORACLE:|reference_replies/i
      .test(serialized)
  ) {
    fail("Blind Evidence detail에 private mapping 또는 raw oracle 자료가 있습니다.");
  }
  return deepFreeze(projection);
}

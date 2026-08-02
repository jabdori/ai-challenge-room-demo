export const BLIND_JUDGE_LABELS = ["X", "Y", "Z"] as const;

export const BLIND_JUDGE_LOCKED_CRITERIA = [
  "FACTUAL_COMPLETENESS_RISK",
  "POLICY_MEANING_RISK",
  "CITATION_RELEVANCE_RISK",
  "UNSUPPORTED_PROMISE_RISK",
  "ESCALATION_CLARITY_RISK",
  "RUN_TO_RUN_CONSISTENCY_RISK",
] as const;

export const BLIND_JUDGE_STATUSES = ["NO_RISK", "RISK", "NOT_APPLICABLE"] as const;
export const BLIND_JUDGE_SEVERITIES = ["HIGH", "MEDIUM", "LOW"] as const;

export const BLIND_JUDGE_COMMON_EVIDENCE_IDS = [
  "CASE:TICKET",
  "EVALUATOR:POLICY_SECTIONS",
  "EVALUATOR:ORDER_ACCESS",
  "ORACLE:EXPECTED_DECISION",
  "ORACLE:REQUIRED_CITATIONS",
  "ORACLE:ALLOWED_CITATIONS",
  "ORACLE:REQUIRED_REPLY_CLAIMS",
  "ORACLE:FORBIDDEN_REPLY_LITERALS",
  "ORACLE:PROTECTED_ORDER_FIELDS",
  "ORACLE:REFERENCE_REPLIES",
] as const;

/**
 * P0 Judge가 사용할 수 있는 실패 유형을 닫힌 목록으로 고정합니다.
 * 이 값은 후보 판정이 아니라 사람 검수 대기열에 전달할 위험 분류입니다.
 */
export const BLIND_JUDGE_FAILURE_TYPES = [
  "MISSING_REQUIRED_FACT",
  "CONTRADICTORY_FACT",
  "POLICY_MEANING_MISMATCH",
  "POLICY_SCOPE_MISMATCH",
  "CITATION_NOT_RELEVANT",
  "CITATION_DOES_NOT_SUPPORT_CLAIM",
  "UNSUPPORTED_COMPLETION_PROMISE",
  "UNSUPPORTED_TIMING_PROMISE",
  "ESCALATION_REASON_UNCLEAR",
  "ESCALATION_TARGET_UNCLEAR",
  "RUN_ACTION_MISMATCH",
  "RUN_FACT_MISMATCH",
] as const;

/**
 * 자유 텍스트 인용문이 어떤 실행 출력 필드에서 왔는지 고정합니다.
 * 이 값은 후보 평가가 아니라 Judge 인용의 검증 좌표입니다.
 */
export const BLIND_JUDGE_CONCERNING_FIELDS = [
  "CUSTOMER_REPLY",
  "INTENT_CODE",
  "ACTION_CODE",
  "ESCALATION_REASON_CODE",
  "TARGET_QUEUE",
  "CITATION_SOURCE_ID",
  "CITATION_SECTION_ID",
] as const;

export type BlindJudgeLabel = (typeof BLIND_JUDGE_LABELS)[number];
export type BlindJudgeCriterionId = (typeof BLIND_JUDGE_LOCKED_CRITERIA)[number];
export type BlindJudgeStatus = (typeof BLIND_JUDGE_STATUSES)[number];
export type BlindJudgeSeverity = (typeof BLIND_JUDGE_SEVERITIES)[number];
export type BlindJudgeFailureType = (typeof BLIND_JUDGE_FAILURE_TYPES)[number];
export type BlindJudgeConcerningField = (typeof BLIND_JUDGE_CONCERNING_FIELDS)[number];

export const BLIND_JUDGE_CRITERION_FAILURE_TYPES = Object.freeze({
  FACTUAL_COMPLETENESS_RISK: Object.freeze(["MISSING_REQUIRED_FACT", "CONTRADICTORY_FACT"]),
  POLICY_MEANING_RISK: Object.freeze(["POLICY_MEANING_MISMATCH", "POLICY_SCOPE_MISMATCH"]),
  CITATION_RELEVANCE_RISK: Object.freeze([
    "CITATION_NOT_RELEVANT",
    "CITATION_DOES_NOT_SUPPORT_CLAIM",
  ]),
  UNSUPPORTED_PROMISE_RISK: Object.freeze([
    "UNSUPPORTED_COMPLETION_PROMISE",
    "UNSUPPORTED_TIMING_PROMISE",
  ]),
  ESCALATION_CLARITY_RISK: Object.freeze([
    "ESCALATION_REASON_UNCLEAR",
    "ESCALATION_TARGET_UNCLEAR",
  ]),
  RUN_TO_RUN_CONSISTENCY_RISK: Object.freeze(["RUN_ACTION_MISMATCH", "RUN_FACT_MISMATCH"]),
} satisfies Readonly<Record<BlindJudgeCriterionId, readonly BlindJudgeFailureType[]>>);

export const BLIND_JUDGE_CRITERION_AUTHORITY_EVIDENCE = Object.freeze({
  FACTUAL_COMPLETENESS_RISK: Object.freeze([
    "EVALUATOR:ORDER_ACCESS",
    "ORACLE:REQUIRED_REPLY_CLAIMS",
    "ORACLE:REFERENCE_REPLIES",
  ]),
  POLICY_MEANING_RISK: Object.freeze(["EVALUATOR:POLICY_SECTIONS"]),
  CITATION_RELEVANCE_RISK: Object.freeze(["EVALUATOR:POLICY_SECTIONS"]),
  UNSUPPORTED_PROMISE_RISK: Object.freeze(["ORACLE:FORBIDDEN_REPLY_LITERALS"]),
  ESCALATION_CLARITY_RISK: Object.freeze(["ORACLE:EXPECTED_DECISION"]),
  RUN_TO_RUN_CONSISTENCY_RISK: Object.freeze([]),
} satisfies Readonly<Record<BlindJudgeCriterionId, readonly string[]>>);

/** criterion마다 허용한 원시 실행 출력 필드만 RISK 인용에 사용할 수 있습니다. */
export const BLIND_JUDGE_CRITERION_CONCERNING_FIELDS = Object.freeze({
  FACTUAL_COMPLETENESS_RISK: Object.freeze([
    "CUSTOMER_REPLY",
    "INTENT_CODE",
    "ACTION_CODE",
    "ESCALATION_REASON_CODE",
    "TARGET_QUEUE",
  ]),
  POLICY_MEANING_RISK: Object.freeze([
    "CUSTOMER_REPLY",
    "ACTION_CODE",
    "CITATION_SOURCE_ID",
    "CITATION_SECTION_ID",
  ]),
  CITATION_RELEVANCE_RISK: Object.freeze([
    "CITATION_SOURCE_ID",
    "CITATION_SECTION_ID",
  ]),
  UNSUPPORTED_PROMISE_RISK: Object.freeze(["CUSTOMER_REPLY"]),
  ESCALATION_CLARITY_RISK: Object.freeze([
    "CUSTOMER_REPLY",
    "ACTION_CODE",
    "ESCALATION_REASON_CODE",
    "TARGET_QUEUE",
  ]),
  RUN_TO_RUN_CONSISTENCY_RISK: Object.freeze([
    "CUSTOMER_REPLY",
    "INTENT_CODE",
    "ACTION_CODE",
    "ESCALATION_REASON_CODE",
    "TARGET_QUEUE",
    "CITATION_SOURCE_ID",
    "CITATION_SECTION_ID",
  ]),
} satisfies Readonly<Record<
  BlindJudgeCriterionId,
  readonly BlindJudgeConcerningField[]
>>);

export interface BlindJudgeCriterionResult {
  criterion_id: BlindJudgeCriterionId;
  status: BlindJudgeStatus;
  severity: BlindJudgeSeverity | null;
  failure_type: BlindJudgeFailureType | null;
  concerning_field: BlindJudgeConcerningField | null;
  concerning_excerpt: string;
  evidence_ids: string[];
  rationale: string;
}

export interface BlindJudgeCandidateResult {
  blind_label: BlindJudgeLabel;
  criteria: BlindJudgeCriterionResult[];
}

export interface BlindJudgeResult {
  case_id: string;
  candidates: BlindJudgeCandidateResult[];
}

export interface BlindJudgeValidationContext {
  expectedCaseId: string;
  evidenceSources: readonly BlindJudgeEvidenceSource[];
}

export interface BlindJudgeEvidenceSource {
  evidence_id: string;
  content: string;
}

const criterionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    criterion_id: {
      type: "string",
      enum: BLIND_JUDGE_LOCKED_CRITERIA,
    },
    status: {
      type: "string",
      enum: BLIND_JUDGE_STATUSES,
    },
    severity: {
      type: ["string", "null"],
      enum: [...BLIND_JUDGE_SEVERITIES, null],
    },
    failure_type: {
      type: ["string", "null"],
      enum: [...BLIND_JUDGE_FAILURE_TYPES, null],
    },
    concerning_field: {
      type: ["string", "null"],
      enum: [...BLIND_JUDGE_CONCERNING_FIELDS, null],
      description: "For RISK, the raw own-run output field that contains concerning_excerpt.",
    },
    concerning_excerpt: {
      type: "string",
      description: "For CUSTOMER_REPLY, an exact contiguous substring. For every other concerning_field, the complete raw field value without joining or annotation.",
    },
    evidence_ids: {
      type: "array",
      items: { type: "string" },
    },
    rationale: { type: "string" },
  },
  required: [
    "criterion_id",
    "status",
    "severity",
    "failure_type",
    "concerning_field",
    "concerning_excerpt",
    "evidence_ids",
    "rationale",
  ],
} as const;

export const blindJudgeResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    case_id: { type: "string" },
    candidates: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          blind_label: {
            type: "string",
            enum: BLIND_JUDGE_LABELS,
          },
          criteria: {
            type: "array",
            minItems: 6,
            maxItems: 6,
            items: criterionSchema,
          },
        },
        required: ["blind_label", "criteria"],
      },
    },
  },
  required: ["case_id", "candidates"],
} as const;

export const blindJudgeResultResponseFormat = {
  type: "json_schema",
  name: "blind_auxiliary_risk_signals",
  strict: true,
  schema: blindJudgeResultJsonSchema,
} as const;

type JsonRecord = Record<string, unknown>;

function readRecord(value: unknown, location: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${location}은(는) JSON 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${location}은(는) plain JSON 객체여야 합니다.`);
  }
  return value as JsonRecord;
}

function assertExactKeys(
  record: JsonRecord,
  requiredKeys: readonly string[],
  location: string,
): void {
  const allowed = new Set(requiredKeys);
  const missing = requiredKeys.filter((key) => !Object.hasOwn(record, key));
  const additional = Object.keys(record).filter((key) => !allowed.has(key));
  if (missing.length > 0) {
    throw new TypeError(`${location}에 필수 필드가 없습니다: ${missing.join(", ")}`);
  }
  if (additional.length > 0) {
    throw new TypeError(
      `${location}에 허용하지 않은 필드가 있습니다: ${additional.join(", ")}`,
    );
  }
}

function readString(value: unknown, location: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${location}은(는) 문자열이어야 합니다.`);
  }
  if (/\p{Cc}/u.test(value)) {
    throw new TypeError(`${location}에는 제어 문자를 넣을 수 없습니다.`);
  }
  return value;
}

function readNonEmptyString(value: unknown, location: string): string {
  const result = readString(value, location);
  if (result.trim().length === 0) {
    throw new TypeError(`${location}은(는) 비어 있지 않은 문자열이어야 합니다.`);
  }
  return result;
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  location: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TypeError(`${location}에 허용하지 않은 값이 있습니다.`);
  }
  return value as T;
}

function readNullableEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  location: string,
): T | null {
  return value === null ? null : readEnum(value, allowed, location);
}

const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function readEvidenceIds(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${location}은(는) evidence ID 배열이어야 합니다.`);
  }
  const result = value.map((item, index) => {
    const id = readNonEmptyString(item, `${location}[${index}]`);
    if (!EVIDENCE_ID_PATTERN.test(id)) {
      throw new TypeError(`${location}[${index}]은(는) 유효한 evidence ID가 아닙니다.`);
    }
    return id;
  });
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${location}에는 중복 evidence ID를 넣을 수 없습니다.`);
  }
  return result;
}

/** 보안 비교와 excerpt 검증에 사용하는 잠긴 Unicode 정규화입니다. */
export function normalizeBlindJudgeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Pd}_]+/gu, " ")
    .replace(/[\p{Z}\s]+/gu, " ")
    .trim();
}

function rawOutputValuesForField(
  output: JsonRecord,
  field: BlindJudgeConcerningField,
): string[] {
  const decision = output.decision;
  const citations = output.citations;
  const decisionRecord = (
    typeof decision === "object" && decision !== null && !Array.isArray(decision)
  ) ? decision as JsonRecord : null;
  const citationRecords = Array.isArray(citations)
    ? citations.filter((citation): citation is JsonRecord => (
      typeof citation === "object" && citation !== null && !Array.isArray(citation)
    ))
    : [];
  switch (field) {
    case "CUSTOMER_REPLY":
      return typeof output.customer_reply === "string" ? [output.customer_reply] : [];
    case "INTENT_CODE":
      return Array.isArray(decisionRecord?.intent_codes)
        ? decisionRecord.intent_codes.filter((value): value is string => typeof value === "string")
        : [];
    case "ACTION_CODE":
      return typeof decisionRecord?.action_code === "string"
        ? [decisionRecord.action_code]
        : [];
    case "ESCALATION_REASON_CODE":
      return typeof decisionRecord?.escalation_reason_code === "string"
        ? [decisionRecord.escalation_reason_code]
        : [];
    case "TARGET_QUEUE":
      return typeof decisionRecord?.target_queue === "string"
        ? [decisionRecord.target_queue]
        : [];
    case "CITATION_SOURCE_ID":
      return citationRecords.flatMap((citation) => (
        typeof citation.source_id === "string" ? [citation.source_id] : []
      ));
    case "CITATION_SECTION_ID":
      return citationRecords.flatMap((citation) => (
        typeof citation.section_id === "string" ? [citation.section_id] : []
      ));
  }
}

/** 선택한 실행 출력 필드에서만 원문 그대로의 인용문을 확인합니다. */
function evidenceContainsFieldExcerpt(
  serializedEvidence: string,
  field: BlindJudgeConcerningField,
  excerpt: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedEvidence) as unknown;
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const output = (parsed as JsonRecord).output;
  if (typeof output !== "object" || output === null || Array.isArray(output)) return false;
  const rawValues = rawOutputValuesForField(output as JsonRecord, field);
  return rawValues.some((value) => {
    return field === "CUSTOMER_REPLY"
      ? value.includes(excerpt)
      : value === excerpt;
  });
}

const IDENTITY_LEAK_PATTERNS: readonly RegExp[] = [
  /(?:^|[^a-z0-9])c\s*a\s*n\s*d\s*i\s*d\s*a\s*t\s*e\s*(?:id|name)?\s*[:=#]?\s*[abc](?:$|[^a-z0-9])/i,
  /\bcandidate\s*id\b/i,
  /\b(?:openai|anthropic|gemini)\b/i,
  /\bgpt\s*[0-9][A-Za-z0-9.\s-]*\b/i,
  /\b(?:single\s*llm|single\s*llm\s*inline\s*policy|llm\s*runner\s*retrieval|read\s*only\s*tool\s*agent)\b/i,
  /(?:^|[^a-z0-9])r\s*a\s*g(?:$|[^a-z0-9])/i,
  /\btier\s*[123]\b/i,
  /\b(?:candidate|run|inference|api|estimated)\s+(?:cost|latency|price)\s*[:=]?/i,
  /\b(?:cost\s*usd|latency\s*ms|input\s*tokens|output\s*tokens)\b/i,
];

/** 후보 신원을 드러내는 내부 메타데이터 문구가 Judge 경계를 넘지 않게 합니다. */
export function assertNoBlindJudgeIdentityLeak(value: unknown, location = "Judge artifact"): void {
  const visit = (item: unknown, path: string): void => {
    if (typeof item === "string") {
      const normalized = normalizeBlindJudgeText(item);
      if (IDENTITY_LEAK_PATTERNS.some((pattern) => pattern.test(normalized))) {
        throw new TypeError(`${path}에 금지된 후보 identity 누출이 있습니다.`);
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (typeof item !== "object" || item === null) return;
    for (const [key, child] of Object.entries(item as JsonRecord)) {
      if (/^(?:candidate_id|candidate_name|model|model_id|model_requested_id|architecture|complexity|cost|latency|price)$/i.test(key)) {
        throw new TypeError(`${path}.${key}에 금지된 후보 identity 필드가 있습니다.`);
      }
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, location);
}

function parseJsonText(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError("Judge 출력이 유효한 JSON 문자열이 아닙니다.", { cause: error });
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function readEvidenceSources(
  context: BlindJudgeValidationContext,
): ReadonlyMap<string, string> {
  if (!Array.isArray(context.evidenceSources)) {
    throw new TypeError("Judge validation context에는 실제 evidenceSources 배열이 필요합니다.");
  }
  const expectedIds = [
    ...BLIND_JUDGE_COMMON_EVIDENCE_IDS,
    ...BLIND_JUDGE_LABELS.flatMap((label) => ([1, 2] as const).map(
      (repetition) => `${label}:RUN:${repetition}`,
    )),
  ];
  const parsed = new Map<string, string>();
  context.evidenceSources.forEach((source, index) => {
    const location = `evidenceSources[${index}]`;
    const record = readRecord(source, location);
    assertExactKeys(record, ["content", "evidence_id"], location);
    const evidenceId = readNonEmptyString(record.evidence_id, `${location}.evidence_id`);
    if (!EVIDENCE_ID_PATTERN.test(evidenceId) || !expectedIds.includes(evidenceId)) {
      throw new TypeError(`${location}.evidence_id가 잠긴 공통·실행 근거 목록과 다릅니다.`);
    }
    if (parsed.has(evidenceId)) {
      throw new TypeError(`Judge validation context에 중복 evidence가 있습니다: ${evidenceId}`);
    }
    parsed.set(evidenceId, readNonEmptyString(record.content, `${location}.content`));
  });
  if (
    parsed.size !== expectedIds.length
    || expectedIds.some((evidenceId) => !parsed.has(evidenceId))
  ) {
    throw new TypeError("Judge validation context의 common evidence와 X/Y/Z 실행 근거가 잠긴 목록과 같아야 합니다.");
  }
  return parsed;
}

function parseCriterion(
  input: unknown,
  expectedCriterionId: BlindJudgeCriterionId,
  blindLabel: BlindJudgeLabel,
  commonEvidenceIds: ReadonlySet<string>,
  evidenceSources: ReadonlyMap<string, string>,
  location: string,
): BlindJudgeCriterionResult {
  const record = readRecord(input, location);
  assertExactKeys(record, [
    "criterion_id",
    "status",
    "severity",
    "failure_type",
    "concerning_field",
    "concerning_excerpt",
    "evidence_ids",
    "rationale",
  ], location);

  const criterionId = readEnum(
    record.criterion_id,
    BLIND_JUDGE_LOCKED_CRITERIA,
    `${location}.criterion_id`,
  );
  if (criterionId !== expectedCriterionId) {
    throw new TypeError(
      `${location}.criterion_id는 잠긴 criterion 순서 ${expectedCriterionId}와 일치해야 합니다.`,
    );
  }
  const status = readEnum(record.status, BLIND_JUDGE_STATUSES, `${location}.status`);
  const severity = readNullableEnum(
    record.severity,
    BLIND_JUDGE_SEVERITIES,
    `${location}.severity`,
  );
  const failureType = readNullableEnum(
    record.failure_type,
    BLIND_JUDGE_FAILURE_TYPES,
    `${location}.failure_type`,
  );
  const concerningField = readNullableEnum(
    record.concerning_field,
    BLIND_JUDGE_CONCERNING_FIELDS,
    `${location}.concerning_field`,
  );
  const excerpt = readString(record.concerning_excerpt, `${location}.concerning_excerpt`);
  const evidenceIds = readEvidenceIds(record.evidence_ids, `${location}.evidence_ids`);
  const rationale = readNonEmptyString(record.rationale, `${location}.rationale`);

  if (status === "RISK") {
    if (severity === null || failureType === null || concerningField === null) {
      throw new TypeError(`${location} RISK에는 severity·failure_type·concerning_field가 필요합니다.`);
    }
    if (excerpt.trim().length === 0 || evidenceIds.length === 0) {
      throw new TypeError(`${location} RISK에는 비어 있지 않은 excerpt와 evidence가 필요합니다.`);
    }
    const allowedFailureTypes = (
      BLIND_JUDGE_CRITERION_FAILURE_TYPES[criterionId]
    ) as readonly BlindJudgeFailureType[];
    if (!allowedFailureTypes.includes(failureType)) {
      throw new TypeError(`${location}.failure_type은 ${criterionId} criterion taxonomy에 없습니다.`);
    }
    const allowedConcerningFields = BLIND_JUDGE_CRITERION_CONCERNING_FIELDS[
      criterionId
    ] as readonly BlindJudgeConcerningField[];
    if (!allowedConcerningFields.includes(concerningField)) {
      throw new TypeError(`${location}.concerning_field은 ${criterionId} criterion에 허용되지 않습니다.`);
    }
  } else {
    if (severity !== null || failureType !== null || concerningField !== null) {
      throw new TypeError(`${location} ${status}의 severity·failure_type·concerning_field은 null이어야 합니다.`);
    }
    if (excerpt !== "") {
      throw new TypeError(`${location} ${status}의 concerning_excerpt는 빈 문자열이어야 합니다.`);
    }
  }

  const ownRunEvidenceIds = new Set([
    `${blindLabel}:RUN:1`,
    `${blindLabel}:RUN:2`,
  ]);
  for (const evidenceId of evidenceIds) {
    if (!commonEvidenceIds.has(evidenceId) && !ownRunEvidenceIds.has(evidenceId)) {
      throw new TypeError(
        `${location}.evidence_ids에는 공통 근거 또는 ${blindLabel}의 두 실행 근거만 허용합니다.`,
      );
    }
  }

  if (status === "RISK") {
    const citedOwnRuns = evidenceIds.filter((evidenceId) => ownRunEvidenceIds.has(evidenceId));
    if (citedOwnRuns.length === 0) {
      throw new TypeError(`${location} RISK에는 최소 하나의 own-run 실행 근거가 필요합니다.`);
    }
    if (
      criterionId === "RUN_TO_RUN_CONSISTENCY_RISK"
      && (![...ownRunEvidenceIds].every((evidenceId) => evidenceIds.includes(evidenceId)))
    ) {
      throw new TypeError(`${location} consistency RISK는 RUN:1과 RUN:2 두 실행을 모두 인용해야 합니다.`);
    }
    const authorityIds = BLIND_JUDGE_CRITERION_AUTHORITY_EVIDENCE[criterionId];
    if (
      authorityIds.length > 0
      && !authorityIds.some((evidenceId) => evidenceIds.includes(evidenceId))
    ) {
      throw new TypeError(
        `${location}에는 criterion 권위 근거가 필요합니다: ${authorityIds.join(", ")}`,
      );
    }
    if (
      excerpt.length === 0
      || !citedOwnRuns.some((evidenceId) => (
        evidenceContainsFieldExcerpt(
          evidenceSources.get(evidenceId) ?? "",
          concerningField!,
          excerpt,
        )
      ))
    ) {
      throw new TypeError(`${location}.concerning_excerpt가 인용한 own-run 실행 근거의 실제 부분 문자열이 아닙니다.`);
    }
  }

  const result: BlindJudgeCriterionResult = {
    criterion_id: criterionId,
    status,
    severity,
    failure_type: failureType,
    concerning_field: concerningField,
    concerning_excerpt: excerpt,
    evidence_ids: evidenceIds,
    rationale,
  };
  assertNoBlindJudgeIdentityLeak(result, location);
  return result;
}

export function parseBlindJudgeResult(
  input: unknown,
  context: BlindJudgeValidationContext,
): BlindJudgeResult {
  if (!/^H-(?:00[1-9]|01[0-2])$/.test(context.expectedCaseId)) {
    throw new TypeError("expectedCaseId는 잠긴 hidden 범위 H-001부터 H-012여야 합니다.");
  }
  const evidenceSources = readEvidenceSources(context);
  const commonEvidenceIdSet = new Set<string>(BLIND_JUDGE_COMMON_EVIDENCE_IDS);
  const value = typeof input === "string" ? parseJsonText(input) : input;
  const record = readRecord(value, "Judge result");
  assertExactKeys(record, ["case_id", "candidates"], "Judge result");

  const caseId = readNonEmptyString(record.case_id, "Judge result.case_id");
  if (caseId !== context.expectedCaseId) {
    throw new TypeError("Judge result의 case ID가 호출한 hidden case와 일치하지 않습니다.");
  }
  if (!Array.isArray(record.candidates) || record.candidates.length !== 3) {
    throw new TypeError("Judge result에는 X, Y, Z 세 blind candidate가 필요합니다.");
  }

  const candidates = record.candidates.map((candidate, candidateIndex) => {
    const location = `Judge result.candidates[${candidateIndex}]`;
    const candidateRecord = readRecord(candidate, location);
    assertExactKeys(candidateRecord, ["blind_label", "criteria"], location);
    const blindLabel = readEnum(
      candidateRecord.blind_label,
      BLIND_JUDGE_LABELS,
      `${location}.blind_label`,
    );
    if (blindLabel !== BLIND_JUDGE_LABELS[candidateIndex]) {
      throw new TypeError("Judge result의 blind label은 X, Y, Z 잠긴 순서여야 합니다.");
    }
    if (
      !Array.isArray(candidateRecord.criteria)
      || candidateRecord.criteria.length !== BLIND_JUDGE_LOCKED_CRITERIA.length
    ) {
      throw new TypeError(`${location}.criteria에는 잠긴 6개 criterion이 필요합니다.`);
    }
    const criteria = candidateRecord.criteria.map((item, criterionIndex) =>
      parseCriterion(
        item,
        BLIND_JUDGE_LOCKED_CRITERIA[criterionIndex],
        blindLabel,
        commonEvidenceIdSet,
        evidenceSources,
        `${location}.criteria[${criterionIndex}]`,
      )
    );
    return { blind_label: blindLabel, criteria };
  });

  const result: BlindJudgeResult = { case_id: caseId, candidates };
  assertNoBlindJudgeIdentityLeak(result);
  return deepFreeze(result);
}

export const EVALUATION_DATASET_SPLITS = [
  "PUBLIC_CALIBRATION",
  "HIDDEN_BENCHMARK",
  "REGRESSION_CANARY",
] as const;

export type EvaluationDatasetSplit = (typeof EVALUATION_DATASET_SPLITS)[number];

export const DATA_ACCESS_SCENARIO_IDS = [
  "ORDER_SUCCESS",
  "ORDER_OWNERSHIP_DENIED",
  "ORDER_TIMEOUT",
  "ORDER_RESULT_MISMATCH",
  "POLICY_ONLY",
] as const;

export const REQUIRED_ACCESS_SUBJECTS = ["ORDER", "POLICY_ONLY"] as const;

export type DataAccessScenarioId = (typeof DATA_ACCESS_SCENARIO_IDS)[number];
export type RequiredAccessSubject = (typeof REQUIRED_ACCESS_SUBJECTS)[number];

export interface EvaluationTicketMessage {
  synthetic: true;
  role: "customer";
  content: string;
}

export interface EvaluationCase {
  synthetic: true;
  case_id: string;
  dataset_split: EvaluationDatasetSplit;
  semantic_template_id: string;
  data_access_scenario_id: DataAccessScenarioId;
  required_access_subject: RequiredAccessSubject;
  case_family: string;
  as_of: string;
  locale: "en-US";
  authenticated_customer_id: string;
  order_id: string | null;
  order_context_authorized: boolean;
  ticket_messages: EvaluationTicketMessage[];
}

export interface CandidateFacingCase {
  case_id: string;
  dataset_split: EvaluationDatasetSplit;
  as_of: string;
  locale: "en-US";
  authenticated_customer_id: string;
  order_id: string | null;
  order_context_authorized: boolean;
  ticket_messages: Array<{
    role: "customer";
    content: string;
  }>;
}

export interface EvaluationCitation {
  source_id: string;
  section_id: string;
}

export interface RequiredReplyClaim {
  claim_id: string;
  alternatives: string[];
}

export interface ForbiddenReplyLiteral {
  literal_id: string;
  literal: string;
  category:
    | "COMPLETION_CLAIM"
    | "POLICY_VIOLATION"
    | "UNSAFE_INSTRUCTION"
    | "UNSUPPORTED_ORDER_FACT";
}

function normalizeForbiddenLiteralText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").trim().replace(/\s+/g, " ");
}

export function findForbiddenReplyLiteralHits(
  reply: string,
  literals: readonly ForbiddenReplyLiteral[],
): ForbiddenReplyLiteral[] {
  const normalizedReply = normalizeForbiddenLiteralText(reply);
  return literals.filter((literal) => normalizedReply.includes(
    normalizeForbiddenLiteralText(literal.literal),
  ));
}

export interface RequiredToolCall {
  tool_name: "search_policy" | "get_order";
  required_arguments: Record<string, string>;
  required_nonempty_arguments: string[];
  expected_result_code:
    | "OK"
    | "ORDER_OWNERSHIP_MISMATCH"
    | "TOOL_TIMEOUT"
    | "ORDER_RESULT_MISMATCH";
}

export interface CandidateAccessExpectation {
  candidate_id: "A" | "B" | "C";
  order_access_channel: "RUNNER_SNAPSHOT" | "READ_ONLY_TOOL";
  expected_order_access_status: "SUCCESS" | "DENIED" | "TIMEOUT" | "MISMATCH" | "NOT_REQUIRED";
  required_runner_retrieval_calls: number;
  required_tool_calls: RequiredToolCall[];
  forbidden_tool_calls: Array<"search_policy" | "get_order">;
}

export interface EvaluationOracle {
  synthetic: true;
  case_id: string;
  expected_intent_codes: CandidateIntentCode[];
  expected_action_code: CandidateActionCode;
  escalation_required: boolean;
  escalation_reason_code: EscalationReasonCode;
  target_queue: TargetQueue;
  required_citations: EvaluationCitation[];
  allowed_citations: EvaluationCitation[];
  forbidden_action_codes: CandidateActionCode[];
  required_reply_claims: RequiredReplyClaim[];
  forbidden_reply_literals: ForbiddenReplyLiteral[];
  protected_order_fields: string[];
  candidate_access_expectations: CandidateAccessExpectation[];
  reference_replies: [string, string];
}

export interface PolicySection {
  synthetic: true;
  source_id: string;
  version: string;
  section_id: string;
  section_class:
    | "APPLICABLE_ACTIVE"
    | "UNRELATED_ACTIVE"
    | "RETIRED_OR_FUTURE"
    | "SCOPE_MISMATCH";
  lifecycle_status: "ACTIVE" | "RETIRED" | "FUTURE";
  title: string;
  effective_from: string;
  effective_to: string | null;
  text: string;
  fact_ids: string[];
  supported_action_codes: string[];
  forbidden_action_codes: string[];
  scope: PolicyScope;
  supersedes: EvaluationCitation[];
}

export interface PolicyScope {
  product_classes: string[];
  channels: Array<"ONLINE" | "MARKETPLACE" | "PHYSICAL_STORE" | "B2B">;
  regions: string[];
  customer_segments: string[];
}

export type CandidateFacingPolicySection = Omit<PolicySection, "synthetic" | "section_class">;

export interface EvaluationOrder {
  synthetic: true;
  order_id: string;
  customer_id: string;
  status: string;
  fulfillment_locked: boolean;
  placed_at: string;
  shipped_at: string | null;
  delivered_at: string | null;
  promised_delivery_date: string;
  total_amount: number;
  currency: string;
  carrier: string | null;
  tracking_number: string | null;
  refund_status: string | null;
  refund_approved_at: string | null;
  items: EvaluationOrderItem[];
}

export interface EvaluationOrderItem {
  synthetic: true;
  product_id: string;
  category: string;
  condition: string;
  custom_made: boolean;
  final_sale: boolean;
  damaged: boolean;
  opened: boolean;
  defective: boolean;
}

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
  value: JsonRecord,
  requiredKeys: readonly string[],
  location: string,
): void {
  const allowedKeys = new Set(requiredKeys);
  const missingKeys = requiredKeys.filter((key) => !Object.hasOwn(value, key));
  const additionalKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));

  if (missingKeys.length > 0) {
    throw new TypeError(`${location}에 필수 필드가 없습니다: ${missingKeys.join(", ")}`);
  }
  if (additionalKeys.length > 0) {
    throw new TypeError(
      `${location}에 허용하지 않은 필드가 있습니다: ${additionalKeys.join(", ")}`,
    );
  }
}

function requireSynthetic(value: unknown, location: string): true {
  if (value !== true) {
    throw new TypeError(`${location}.synthetic은(는) true여야 합니다.`);
  }
  return true;
}

function readNonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${location}은(는) 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value;
}

function readIdentifier(value: unknown, location: string): string {
  const identifier = readNonEmptyString(value, location);
  if (
    identifier !== identifier.trim()
    || /[\u0000-\u001F\u007F]/.test(identifier)
    || !/^[A-Za-z0-9._:/-]+$/.test(identifier)
  ) {
    throw new TypeError(
      `${location} 식별자는 [A-Za-z0-9._:/-] 문자만 사용할 수 있습니다.`,
    );
  }
  return identifier;
}

function readNullableString(value: unknown, location: string): string | null {
  return value === null ? null : readNonEmptyString(value, location);
}

function readNullableIdentifier(value: unknown, location: string): string | null {
  return value === null ? null : readIdentifier(value, location);
}

function readBoolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${location}은(는) boolean이어야 합니다.`);
  }
  return value;
}

function readLiteral<T extends string>(
  value: unknown,
  expected: T,
  location: string,
): T {
  if (value !== expected) {
    throw new TypeError(`${location}은(는) ${expected}이어야 합니다.`);
  }
  return expected;
}

function readEnum<T extends string>(
  value: unknown,
  expectedValues: readonly T[],
  location: string,
): T {
  if (typeof value !== "string" || !expectedValues.includes(value as T)) {
    throw new TypeError(
      `${location}에 지원하지 않는 값이 있습니다: ${String(value)}`,
    );
  }
  return value as T;
}

function readUniqueEnums<T extends string>(
  value: unknown,
  expectedValues: readonly T[],
  location: string,
  options: { allowEmpty?: boolean } = {},
): T[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    throw new TypeError(`${location}은(는) 비어 있지 않은 enum 배열이어야 합니다.`);
  }
  const values = value.map((item, index) =>
    readEnum(item, expectedValues, `${location}[${index}]`),
  );
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${location}에 중복 값이 있습니다.`);
  }
  return values;
}

function readOpaqueCaseId(
  value: unknown,
  location: string,
  datasetSplit?: EvaluationDatasetSplit,
): string {
  const caseId = readIdentifier(value, location);
  const expectedPrefix = datasetSplit === "PUBLIC_CALIBRATION"
    ? "C"
    : datasetSplit === "HIDDEN_BENCHMARK"
      ? "H"
      : datasetSplit === "REGRESSION_CANARY"
        ? "R"
        : "[CHR]";
  const pattern = datasetSplit === undefined
    ? /^[CHR]-\d{3}$/
    : new RegExp(`^${expectedPrefix}-\\d{3}$`);
  if (!pattern.test(caseId)) {
    throw new TypeError(
      `${location}은(는) ${expectedPrefix}-001 형태의 opaque ID여야 합니다.`,
    );
  }
  return caseId;
}

function readIsoTimestamp(value: unknown, location: string): string {
  const timestamp = readNonEmptyString(value, location);
  const match = timestamp.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/,
  );
  const normalized = match
    ? `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`
    : null;
  if (
    normalized === null
    || !Number.isFinite(Date.parse(timestamp))
    || new Date(timestamp).toISOString() !== normalized
  ) {
    throw new TypeError(`${location}은(는) 정규화된 ISO 8601 UTC 시각이어야 합니다.`);
  }
  return timestamp;
}

function readDate(value: unknown, location: string): string {
  const date = readNonEmptyString(value, location);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new TypeError(`${location}은(는) 유효한 YYYY-MM-DD 날짜여야 합니다.`);
  }
  return date;
}

function readNullableDate(value: unknown, location: string): string | null {
  return value === null ? null : readDate(value, location);
}

function readNullableIsoTimestamp(value: unknown, location: string): string | null {
  return value === null ? null : readIsoTimestamp(value, location);
}

function readUniqueStrings(
  value: unknown,
  location: string,
  options: { allowEmpty?: boolean } = {},
): string[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    throw new TypeError(`${location}은(는) 비어 있지 않은 문자열 배열이어야 합니다.`);
  }
  const strings = value.map((item, index) =>
    readNonEmptyString(item, `${location}[${index}]`),
  );
  if (new Set(strings).size !== strings.length) {
    throw new TypeError(`${location}에 중복 값이 있습니다.`);
  }
  return strings;
}

function readUniqueIdentifiers(
  value: unknown,
  location: string,
  options: { allowEmpty?: boolean } = {},
): string[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    throw new TypeError(`${location}은(는) 비어 있지 않은 식별자 배열이어야 합니다.`);
  }
  const identifiers = value.map((item, index) =>
    readIdentifier(item, `${location}[${index}]`),
  );
  if (new Set(identifiers).size !== identifiers.length) {
    throw new TypeError(`${location}에 중복 값이 있습니다.`);
  }
  return identifiers;
}

function parseCitation(value: unknown, location: string): EvaluationCitation {
  const record = readRecord(value, location);
  assertExactKeys(record, ["source_id", "section_id"], location);
  return {
    source_id: readIdentifier(record.source_id, `${location}.source_id`),
    section_id: readIdentifier(record.section_id, `${location}.section_id`),
  };
}

function parseCitationArray(value: unknown, location: string): EvaluationCitation[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${location}은(는) 배열이어야 합니다.`);
  }
  const citations = value.map((item, index) => parseCitation(item, `${location}[${index}]`));
  const identities = citations.map(({ source_id, section_id }) => `${source_id}\u0000${section_id}`);
  if (new Set(identities).size !== identities.length) {
    throw new TypeError(`${location}에 중복 인용 참조가 있습니다.`);
  }
  return citations;
}

function parseTicketMessage(value: unknown, index: number): EvaluationTicketMessage {
  const location = `ticket_messages[${index}]`;
  const record = readRecord(value, location);
  assertExactKeys(record, ["synthetic", "role", "content"], location);
  return {
    synthetic: requireSynthetic(record.synthetic, location),
    role: readLiteral(record.role, "customer", `${location}.role`),
    content: readNonEmptyString(record.content, `${location}.content`),
  };
}

export function parseEvaluationCase(input: unknown): EvaluationCase {
  const record = readRecord(input, "evaluation case");
  assertExactKeys(record, [
    "synthetic",
    "case_id",
    "dataset_split",
    "semantic_template_id",
    "data_access_scenario_id",
    "required_access_subject",
    "case_family",
    "as_of",
    "locale",
    "authenticated_customer_id",
    "order_id",
    "order_context_authorized",
    "ticket_messages",
  ], "evaluation case");
  if (!Array.isArray(record.ticket_messages) || record.ticket_messages.length === 0) {
    throw new TypeError("evaluation case.ticket_messages는 비어 있지 않은 배열이어야 합니다.");
  }

  const datasetSplit = readEnum(
    record.dataset_split,
    EVALUATION_DATASET_SPLITS,
    "evaluation case.dataset_split",
  );
  return {
    synthetic: requireSynthetic(record.synthetic, "evaluation case"),
    case_id: readOpaqueCaseId(record.case_id, "evaluation case.case_id", datasetSplit),
    dataset_split: datasetSplit,
    semantic_template_id: readIdentifier(
      record.semantic_template_id,
      "evaluation case.semantic_template_id",
    ),
    data_access_scenario_id: readEnum(
      record.data_access_scenario_id,
      DATA_ACCESS_SCENARIO_IDS,
      "evaluation case.data_access_scenario_id",
    ),
    required_access_subject: readEnum(
      record.required_access_subject,
      REQUIRED_ACCESS_SUBJECTS,
      "evaluation case.required_access_subject",
    ),
    case_family: readIdentifier(record.case_family, "evaluation case.case_family"),
    as_of: readIsoTimestamp(record.as_of, "evaluation case.as_of"),
    locale: readLiteral(record.locale, "en-US", "evaluation case.locale"),
    authenticated_customer_id: readIdentifier(
      record.authenticated_customer_id,
      "evaluation case.authenticated_customer_id",
    ),
    order_id: readNullableIdentifier(record.order_id, "evaluation case.order_id"),
    order_context_authorized: readBoolean(
      record.order_context_authorized,
      "evaluation case.order_context_authorized",
    ),
    ticket_messages: record.ticket_messages.map(parseTicketMessage),
  };
}

export function buildCandidateFacingCase(
  evaluationCase: EvaluationCase,
): CandidateFacingCase {
  return {
    case_id: evaluationCase.case_id,
    dataset_split: evaluationCase.dataset_split,
    as_of: evaluationCase.as_of,
    locale: evaluationCase.locale,
    authenticated_customer_id: evaluationCase.authenticated_customer_id,
    order_id: evaluationCase.order_id,
    order_context_authorized: evaluationCase.order_context_authorized,
    ticket_messages: evaluationCase.ticket_messages.map(({ role, content }) => ({
      role,
      content,
    })),
  };
}

export function parseEvaluationCases(input: unknown): EvaluationCase[] {
  if (!Array.isArray(input)) {
    throw new TypeError("evaluation cases는 배열이어야 합니다.");
  }
  const cases = input.map(parseEvaluationCase);
  assertUniqueBy(cases, (item) => item.case_id, "중복 case_id");
  return cases;
}

function parseRequiredReplyClaims(value: unknown): RequiredReplyClaim[] {
  if (!Array.isArray(value)) {
    throw new TypeError("evaluation oracle.required_reply_claims는 배열이어야 합니다.");
  }
  const claims = value.map((item, index) => {
    const location = `evaluation oracle.required_reply_claims[${index}]`;
    const record = readRecord(item, location);
    assertExactKeys(record, ["claim_id", "alternatives"], location);
    return {
      claim_id: readIdentifier(record.claim_id, `${location}.claim_id`),
      alternatives: readUniqueStrings(record.alternatives, `${location}.alternatives`),
    };
  });
  assertUniqueBy(claims, (item) => item.claim_id, "중복 claim_id");
  return claims;
}

function parseForbiddenReplyLiterals(value: unknown): ForbiddenReplyLiteral[] {
  if (!Array.isArray(value)) {
    throw new TypeError("evaluation oracle.forbidden_reply_literals는 배열이어야 합니다.");
  }
  const literals = value.map((item, index): ForbiddenReplyLiteral => {
    const location = `evaluation oracle.forbidden_reply_literals[${index}]`;
    const record = readRecord(item, location);
    assertExactKeys(record, ["literal_id", "literal", "category"], location);
    return {
      literal_id: readIdentifier(record.literal_id, `${location}.literal_id`),
      literal: readNonEmptyString(record.literal, `${location}.literal`),
      category: readEnum(
        record.category,
        [
          "COMPLETION_CLAIM",
          "POLICY_VIOLATION",
          "UNSAFE_INSTRUCTION",
          "UNSUPPORTED_ORDER_FACT",
        ] as const,
        `${location}.category`,
      ),
    };
  });
  assertUniqueBy(literals, (item) => item.literal_id, "중복 literal_id");
  assertUniqueBy(literals, (item) => item.literal, "중복 literal");
  return literals;
}

function parseRequiredToolCalls(value: unknown, locationPrefix: string): RequiredToolCall[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${locationPrefix}는 배열이어야 합니다.`);
  }
  const calls = value.map((item, index) => {
    const location = `${locationPrefix}[${index}]`;
    const record = readRecord(item, location);
    assertExactKeys(record, [
      "tool_name",
      "required_arguments",
      "required_nonempty_arguments",
      "expected_result_code",
    ], location);
    const toolName = readEnum(
      record.tool_name,
      ["search_policy", "get_order"] as const,
      `${location}.tool_name`,
    );
    const argumentRecord = readRecord(record.required_arguments, `${location}.required_arguments`);
    const requiredArguments = Object.fromEntries(
      Object.entries(argumentRecord).map(([key, argument]) => [
        readIdentifier(key, `${location}.required_arguments key`),
        readNonEmptyString(argument, `${location}.required_arguments.${key}`),
      ]),
    );
    const requiredNonemptyArguments = readUniqueIdentifiers(
      record.required_nonempty_arguments,
      `${location}.required_nonempty_arguments`,
      { allowEmpty: true },
    );
    const exactArgumentNames = new Set(Object.keys(requiredArguments));
    if (requiredNonemptyArguments.some((argument) => exactArgumentNames.has(argument))) {
      throw new TypeError(`${location}의 exact 인자와 nonempty 인자는 중복될 수 없습니다.`);
    }
    const expectedArgumentNames = toolName === "search_policy"
      ? new Set(["query", "as_of"])
      : new Set(["order_id", "authenticated_customer_id"]);
    const actualArgumentNames = [...exactArgumentNames, ...requiredNonemptyArguments];
    if (
      actualArgumentNames.length !== expectedArgumentNames.size
      || actualArgumentNames.some((argument) => !expectedArgumentNames.has(argument))
    ) {
      throw new TypeError(`${location}의 인자 계약이 실제 ${toolName} 도구 스키마와 다릅니다.`);
    }
    return {
      tool_name: toolName,
      required_arguments: requiredArguments,
      required_nonempty_arguments: requiredNonemptyArguments,
      expected_result_code: readEnum(
        record.expected_result_code,
        [
          "OK",
          "ORDER_OWNERSHIP_MISMATCH",
          "TOOL_TIMEOUT",
          "ORDER_RESULT_MISMATCH",
        ] as const,
        `${location}.expected_result_code`,
      ),
    };
  });
  const signatures = calls.map((call) => JSON.stringify([
    call.tool_name,
    Object.entries(call.required_arguments).sort(([left], [right]) => left.localeCompare(right)),
  ]));
  if (new Set(signatures).size !== signatures.length) {
    throw new TypeError(`${locationPrefix}에 중복 도구 요구가 있습니다.`);
  }
  return calls;
}

function parseCandidateAccessExpectations(value: unknown): CandidateAccessExpectation[] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError("evaluation oracle.candidate_access_expectations에는 A, B, C가 필요합니다.");
  }
  const expectations = value.map((item, index): CandidateAccessExpectation => {
    const location = `evaluation oracle.candidate_access_expectations[${index}]`;
    const record = readRecord(item, location);
    assertExactKeys(record, [
      "candidate_id",
      "order_access_channel",
      "expected_order_access_status",
      "required_runner_retrieval_calls",
      "required_tool_calls",
      "forbidden_tool_calls",
    ], location);
    if (
      typeof record.required_runner_retrieval_calls !== "number"
      || !Number.isInteger(record.required_runner_retrieval_calls)
      || record.required_runner_retrieval_calls < 0
    ) {
      throw new TypeError(`${location}.required_runner_retrieval_calls는 0 이상의 정수여야 합니다.`);
    }
    const requiredToolCalls = parseRequiredToolCalls(
      record.required_tool_calls,
      `${location}.required_tool_calls`,
    );
    const forbiddenToolCalls = readUniqueEnums(
      record.forbidden_tool_calls,
      ["search_policy", "get_order"] as const,
      `${location}.forbidden_tool_calls`,
      { allowEmpty: true },
    );
    if (requiredToolCalls.some((call) => forbiddenToolCalls.includes(call.tool_name))) {
      throw new TypeError(`${location}의 필수 도구는 금지 도구에 포함될 수 없습니다.`);
    }
    return {
      candidate_id: readEnum(record.candidate_id, ["A", "B", "C"] as const, `${location}.candidate_id`),
      order_access_channel: readEnum(
        record.order_access_channel,
        ["RUNNER_SNAPSHOT", "READ_ONLY_TOOL"] as const,
        `${location}.order_access_channel`,
      ),
      expected_order_access_status: readEnum(
        record.expected_order_access_status,
        ["SUCCESS", "DENIED", "TIMEOUT", "MISMATCH", "NOT_REQUIRED"] as const,
        `${location}.expected_order_access_status`,
      ),
      required_runner_retrieval_calls: record.required_runner_retrieval_calls,
      required_tool_calls: requiredToolCalls,
      forbidden_tool_calls: forbiddenToolCalls,
    };
  });
  if (expectations.map((item) => item.candidate_id).join(",") !== "A,B,C") {
    throw new TypeError("evaluation oracle.candidate_access_expectations는 A, B, C 순서로 정확히 필요합니다.");
  }
  const lockedCandidateContracts = [
    { candidate_id: "A", order_access_channel: "RUNNER_SNAPSHOT", required_runner_retrieval_calls: 0 },
    { candidate_id: "B", order_access_channel: "RUNNER_SNAPSHOT", required_runner_retrieval_calls: null },
    { candidate_id: "C", order_access_channel: "READ_ONLY_TOOL", required_runner_retrieval_calls: 0 },
  ] as const;
  expectations.forEach((expectation, index) => {
    const locked = lockedCandidateContracts[index];
    if (
      expectation.candidate_id !== locked.candidate_id
      || expectation.order_access_channel !== locked.order_access_channel
      || (
        locked.required_runner_retrieval_calls !== null
        && expectation.required_runner_retrieval_calls !== locked.required_runner_retrieval_calls
      )
    ) {
      throw new TypeError(`Candidate ${locked.candidate_id} 접근 계약이 잠긴 envelope과 다릅니다.`);
    }
    if (expectation.candidate_id !== "C" && expectation.required_tool_calls.length > 0) {
      throw new TypeError(`Candidate ${expectation.candidate_id}는 도구 호출을 요구할 수 없습니다.`);
    }
  });
  if (new Set(expectations.map((item) => item.expected_order_access_status)).size !== 1) {
    throw new TypeError("A/B/C의 주문 접근 결과 의미가 서로 일치해야 합니다.");
  }
  return expectations;
}

function parseReferenceReplies(value: unknown): [string, string] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError("evaluation oracle.reference_replies에는 정확히 2개가 필요합니다.");
  }
  const replies = value.map((reply, index) => {
    const parsed = readNonEmptyString(
      reply,
      `evaluation oracle.reference_replies[${index}]`,
    );
    if (!/[A-Za-z]/.test(parsed)) {
      throw new TypeError(
        `evaluation oracle.reference_replies[${index}]에는 영어 예시 답변이 필요합니다.`,
      );
    }
    return parsed;
  }) as [string, string];
  const normalizedReplies = replies.map((reply) =>
    reply.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"),
  );
  if (normalizedReplies[0] === normalizedReplies[1]) {
    throw new TypeError("evaluation oracle.reference_replies는 서로 다른 답변이어야 합니다.");
  }
  return replies;
}

export function parseEvaluationOracle(input: unknown): EvaluationOracle {
  const record = readRecord(input, "evaluation oracle");
  assertExactKeys(record, [
    "synthetic",
    "case_id",
    "expected_intent_codes",
    "expected_action_code",
    "escalation_required",
    "escalation_reason_code",
    "target_queue",
    "required_citations",
    "allowed_citations",
    "forbidden_action_codes",
    "required_reply_claims",
    "forbidden_reply_literals",
    "protected_order_fields",
    "candidate_access_expectations",
    "reference_replies",
  ], "evaluation oracle");

  const oracle: EvaluationOracle = {
    synthetic: requireSynthetic(record.synthetic, "evaluation oracle"),
    case_id: readOpaqueCaseId(record.case_id, "evaluation oracle.case_id"),
    expected_intent_codes: readUniqueEnums(
      record.expected_intent_codes,
      CANDIDATE_INTENT_CODES,
      "evaluation oracle.expected_intent_codes",
    ),
    expected_action_code: readEnum(
      record.expected_action_code,
      CANDIDATE_ACTION_CODES,
      "evaluation oracle.expected_action_code",
    ),
    escalation_required: readBoolean(
      record.escalation_required,
      "evaluation oracle.escalation_required",
    ),
    escalation_reason_code: readEnum(
      record.escalation_reason_code,
      ESCALATION_REASON_CODES,
      "evaluation oracle.escalation_reason_code",
    ),
    target_queue: readEnum(record.target_queue, TARGET_QUEUES, "evaluation oracle.target_queue"),
    required_citations: parseCitationArray(
      record.required_citations,
      "evaluation oracle.required_citations",
    ),
    allowed_citations: parseCitationArray(
      record.allowed_citations,
      "evaluation oracle.allowed_citations",
    ),
    forbidden_action_codes: readUniqueEnums(
      record.forbidden_action_codes,
      CANDIDATE_ACTION_CODES,
      "evaluation oracle.forbidden_action_codes",
      { allowEmpty: true },
    ),
    required_reply_claims: parseRequiredReplyClaims(record.required_reply_claims),
    forbidden_reply_literals: parseForbiddenReplyLiterals(record.forbidden_reply_literals),
    protected_order_fields: readUniqueIdentifiers(
      record.protected_order_fields,
      "evaluation oracle.protected_order_fields",
      { allowEmpty: true },
    ),
    candidate_access_expectations: parseCandidateAccessExpectations(
      record.candidate_access_expectations,
    ),
    reference_replies: parseReferenceReplies(record.reference_replies),
  };

  if (oracle.forbidden_action_codes.includes(oracle.expected_action_code)) {
    throw new TypeError("오라클의 기대 처리 코드는 금지 처리 코드에 포함될 수 없습니다.");
  }
  const allowedCitationIds = new Set(
    oracle.allowed_citations.map(({ source_id, section_id }) => `${source_id}\u0000${section_id}`),
  );
  if (oracle.required_citations.some(
    ({ source_id, section_id }) => !allowedCitationIds.has(`${source_id}\u0000${section_id}`),
  )) {
    throw new TypeError("오라클의 모든 필수 인용은 허용 인용 집합에 포함되어야 합니다.");
  }
  if (
    !oracle.escalation_required
    && (oracle.escalation_reason_code !== "NOT_REQUIRED" || oracle.target_queue !== "NONE")
  ) {
    throw new TypeError(
      "에스컬레이션 의미 불변식 위반: false이면 사유는 NOT_REQUIRED, 대상 큐는 NONE이어야 합니다.",
    );
  }
  if (
    oracle.escalation_required
    && (oracle.escalation_reason_code === "NOT_REQUIRED" || oracle.target_queue === "NONE")
  ) {
    throw new TypeError(
      "에스컬레이션 의미 불변식 위반: true이면 명시적 사유와 대상 큐가 필요합니다.",
    );
  }
  return oracle;
}

export function parseEvaluationOracles(input: unknown): EvaluationOracle[] {
  if (!Array.isArray(input)) {
    throw new TypeError("evaluation oracles는 배열이어야 합니다.");
  }
  const oracles = input.map(parseEvaluationOracle);
  assertUniqueBy(oracles, (item) => item.case_id, "중복 oracle case_id");
  return oracles;
}

export function assertMatchingCaseAndOracle(
  evaluationCase: EvaluationCase,
  oracle: EvaluationOracle,
): void {
  if (evaluationCase.case_id !== oracle.case_id) {
    throw new TypeError("evaluation case.case_id와 oracle.case_id가 일치해야 합니다.");
  }
  const accessStatus = oracle.candidate_access_expectations[0].expected_order_access_status;
  const candidateB = oracle.candidate_access_expectations[1];
  const candidateC = oracle.candidate_access_expectations[2];
  const candidateCToolNames = candidateC.required_tool_calls.map((call) => call.tool_name);
  if (evaluationCase.required_access_subject === "POLICY_ONLY") {
    if (evaluationCase.data_access_scenario_id !== "POLICY_ONLY") {
      throw new TypeError("POLICY_ONLY 사례의 data_access_scenario_id는 POLICY_ONLY여야 합니다.");
    }
    if (
      oracle.candidate_access_expectations.some(
        (expectation) => expectation.expected_order_access_status !== "NOT_REQUIRED",
      )
    ) {
      throw new TypeError("POLICY_ONLY 사례의 주문 접근 상태는 모두 NOT_REQUIRED여야 합니다.");
    }
    if (
      candidateCToolNames.includes("get_order")
      || !candidateC.forbidden_tool_calls.includes("get_order")
    ) {
      throw new TypeError("POLICY_ONLY 사례에서 Candidate C get_order는 금지해야 합니다.");
    }
  } else {
    const expectedStatusByScenario: Record<DataAccessScenarioId, Exclude<
      CandidateAccessExpectation["expected_order_access_status"],
      "NOT_REQUIRED"
    >> = {
      ORDER_SUCCESS: "SUCCESS",
      ORDER_OWNERSHIP_DENIED: "DENIED",
      ORDER_TIMEOUT: "TIMEOUT",
      ORDER_RESULT_MISMATCH: "MISMATCH",
      POLICY_ONLY: "SUCCESS",
    };
    if (evaluationCase.data_access_scenario_id === "POLICY_ONLY") {
      throw new TypeError("ORDER 사례의 data_access_scenario_id는 POLICY_ONLY일 수 없습니다.");
    }
    if (accessStatus !== expectedStatusByScenario[evaluationCase.data_access_scenario_id]) {
      throw new TypeError("ORDER 사례의 data_access_scenario_id와 주문 접근 상태가 일치해야 합니다.");
    }
    const getOrderCall = candidateC.required_tool_calls.find((call) => call.tool_name === "get_order");
    if (getOrderCall === undefined) {
      throw new TypeError("ORDER 사례에서 Candidate C get_order는 필수입니다.");
    }
    if (getOrderCall.required_arguments.order_id !== evaluationCase.order_id) {
      throw new TypeError("Candidate C get_order order_id는 evaluation case order_id와 일치해야 합니다.");
    }
    if (
      getOrderCall.required_arguments.authenticated_customer_id
      !== evaluationCase.authenticated_customer_id
    ) {
      throw new TypeError(
        "Candidate C get_order authenticated_customer_id는 evaluation case authenticated customer와 일치해야 합니다.",
      );
    }
    const expectedResultCodeByStatus = {
      SUCCESS: "OK",
      DENIED: "ORDER_OWNERSHIP_MISMATCH",
      TIMEOUT: "TOOL_TIMEOUT",
      MISMATCH: "ORDER_RESULT_MISMATCH",
    } as const;
    if (getOrderCall.expected_result_code !== expectedResultCodeByStatus[accessStatus]) {
      throw new TypeError("Candidate C get_order 결과와 A/B snapshot 접근 결과 의미가 일치해야 합니다.");
    }
  }
  const requiresPolicyAccess = oracle.required_citations.length > 0;
  if (candidateB.required_runner_retrieval_calls !== (requiresPolicyAccess ? 1 : 0)) {
    throw new TypeError("Candidate B runner retrieval 수는 필수 정책 인용 여부와 일치해야 합니다.");
  }
  const searchPolicyCall = candidateC.required_tool_calls.find(
    (call) => call.tool_name === "search_policy",
  );
  if (
    requiresPolicyAccess
    && (
      searchPolicyCall === undefined
      || searchPolicyCall.required_arguments.as_of !== evaluationCase.as_of
      || !searchPolicyCall.required_nonempty_arguments.includes("query")
    )
  ) {
    throw new TypeError("Candidate C search_policy는 잠긴 as_of와 nonempty query를 요구해야 합니다.");
  }
}

export function parsePolicySection(input: unknown): PolicySection {
  const record = readRecord(input, "policy section");
  assertExactKeys(record, [
    "synthetic",
    "source_id",
    "version",
    "section_id",
    "section_class",
    "lifecycle_status",
    "title",
    "effective_from",
    "effective_to",
    "text",
    "fact_ids",
    "supported_action_codes",
    "forbidden_action_codes",
    "scope",
    "supersedes",
  ], "policy section");
  const effectiveFrom = readDate(record.effective_from, "policy section.effective_from");
  const effectiveTo = readNullableDate(record.effective_to, "policy section.effective_to");
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    throw new TypeError("policy section.effective_to는 effective_from보다 빠를 수 없습니다.");
  }
  const sectionClass = readEnum(
    record.section_class,
    [
      "APPLICABLE_ACTIVE",
      "UNRELATED_ACTIVE",
      "RETIRED_OR_FUTURE",
      "SCOPE_MISMATCH",
    ] as const,
    "policy section.section_class",
  );
  const lifecycleStatus = readEnum(
    record.lifecycle_status,
    ["ACTIVE", "RETIRED", "FUTURE"] as const,
    "policy section.lifecycle_status",
  );
  if (
    (sectionClass === "RETIRED_OR_FUTURE") !== (lifecycleStatus !== "ACTIVE")
  ) {
    throw new TypeError("policy section의 section_class와 lifecycle_status가 일치해야 합니다.");
  }
  const scopeRecord = readRecord(record.scope, "policy section.scope");
  assertExactKeys(scopeRecord, [
    "product_classes",
    "channels",
    "regions",
    "customer_segments",
  ], "policy section.scope");
  return {
    synthetic: requireSynthetic(record.synthetic, "policy section"),
    source_id: readIdentifier(record.source_id, "policy section.source_id"),
    version: readIdentifier(record.version, "policy section.version"),
    section_id: readIdentifier(record.section_id, "policy section.section_id"),
    section_class: sectionClass,
    lifecycle_status: lifecycleStatus,
    title: readNonEmptyString(record.title, "policy section.title"),
    effective_from: effectiveFrom,
    effective_to: effectiveTo,
    text: readNonEmptyString(record.text, "policy section.text"),
    fact_ids: readUniqueIdentifiers(record.fact_ids, "policy section.fact_ids"),
    supported_action_codes: readUniqueIdentifiers(
      record.supported_action_codes,
      "policy section.supported_action_codes",
      { allowEmpty: true },
    ),
    forbidden_action_codes: readUniqueIdentifiers(
      record.forbidden_action_codes,
      "policy section.forbidden_action_codes",
      { allowEmpty: true },
    ),
    scope: {
      product_classes: readUniqueIdentifiers(
        scopeRecord.product_classes,
        "policy section.scope.product_classes",
      ),
      channels: readUniqueEnums(
        scopeRecord.channels,
        ["ONLINE", "MARKETPLACE", "PHYSICAL_STORE", "B2B"] as const,
        "policy section.scope.channels",
      ),
      regions: readUniqueIdentifiers(scopeRecord.regions, "policy section.scope.regions"),
      customer_segments: readUniqueIdentifiers(
        scopeRecord.customer_segments,
        "policy section.scope.customer_segments",
      ),
    },
    supersedes: parseCitationArray(record.supersedes, "policy section.supersedes"),
  };
}

export function buildCandidateFacingPolicySection(
  policy: PolicySection,
): CandidateFacingPolicySection {
  const { synthetic: _synthetic, section_class: _sectionClass, ...candidatePolicy } = policy;
  return structuredClone(candidatePolicy);
}

export function parsePolicySections(input: unknown): PolicySection[] {
  if (!Array.isArray(input)) {
    throw new TypeError("policy sections는 배열이어야 합니다.");
  }
  const sections = input.map(parsePolicySection);
  assertUniqueBy(
    sections,
    (item) => `${item.source_id}\u0000${item.section_id}`,
    "중복 정책 source_id/section_id",
  );
  return sections;
}

export function parseEvaluationOrder(input: unknown): EvaluationOrder {
  const record = readRecord(input, "evaluation order");
  assertExactKeys(record, [
    "synthetic",
    "order_id",
    "customer_id",
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
  ], "evaluation order");
  if (
    typeof record.total_amount !== "number"
    || !Number.isFinite(record.total_amount)
    || record.total_amount < 0
  ) {
    throw new TypeError("evaluation order.total_amount는 0 이상의 유한한 숫자여야 합니다.");
  }
  const currency = readNonEmptyString(record.currency, "evaluation order.currency");
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError("evaluation order.currency는 대문자 3자리 통화 코드여야 합니다.");
  }
  if (!Array.isArray(record.items) || record.items.length === 0) {
    throw new TypeError("evaluation order.items는 비어 있지 않은 배열이어야 합니다.");
  }
  const items = record.items.map((item, index): EvaluationOrderItem => {
    const location = `evaluation order.items[${index}]`;
    const itemRecord = readRecord(item, location);
    assertExactKeys(itemRecord, [
      "synthetic",
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
      synthetic: requireSynthetic(itemRecord.synthetic, location),
      product_id: readIdentifier(itemRecord.product_id, `${location}.product_id`),
      category: readIdentifier(itemRecord.category, `${location}.category`),
      condition: readIdentifier(itemRecord.condition, `${location}.condition`),
      custom_made: readBoolean(itemRecord.custom_made, `${location}.custom_made`),
      final_sale: readBoolean(itemRecord.final_sale, `${location}.final_sale`),
      damaged: readBoolean(itemRecord.damaged, `${location}.damaged`),
      opened: readBoolean(itemRecord.opened, `${location}.opened`),
      defective: readBoolean(itemRecord.defective, `${location}.defective`),
    };
  });
  assertUniqueBy(items, (item) => item.product_id, "중복 product_id");
  return {
    synthetic: requireSynthetic(record.synthetic, "evaluation order"),
    order_id: readIdentifier(record.order_id, "evaluation order.order_id"),
    customer_id: readIdentifier(record.customer_id, "evaluation order.customer_id"),
    status: readIdentifier(record.status, "evaluation order.status"),
    fulfillment_locked: readBoolean(
      record.fulfillment_locked,
      "evaluation order.fulfillment_locked",
    ),
    placed_at: readIsoTimestamp(record.placed_at, "evaluation order.placed_at"),
    shipped_at: readNullableIsoTimestamp(record.shipped_at, "evaluation order.shipped_at"),
    delivered_at: readNullableIsoTimestamp(record.delivered_at, "evaluation order.delivered_at"),
    promised_delivery_date: readDate(
      record.promised_delivery_date,
      "evaluation order.promised_delivery_date",
    ),
    total_amount: record.total_amount,
    currency,
    carrier: readNullableString(record.carrier, "evaluation order.carrier"),
    tracking_number: readNullableIdentifier(
      record.tracking_number,
      "evaluation order.tracking_number",
    ),
    refund_status: readNullableIdentifier(record.refund_status, "evaluation order.refund_status"),
    refund_approved_at: readNullableIsoTimestamp(
      record.refund_approved_at,
      "evaluation order.refund_approved_at",
    ),
    items,
  };
}

export function parseEvaluationOrders(input: unknown): EvaluationOrder[] {
  if (!Array.isArray(input)) {
    throw new TypeError("evaluation orders는 배열이어야 합니다.");
  }
  const orders = input.map(parseEvaluationOrder);
  assertUniqueBy(orders, (item) => item.order_id, "중복 order_id");
  return orders;
}

function assertUniqueBy<T>(
  values: readonly T[],
  identity: (value: T) => string,
  label: string,
): void {
  const identities = values.map(identity);
  if (new Set(identities).size !== identities.length) {
    throw new TypeError(`${label}가 있습니다.`);
  }
}
import {
  CANDIDATE_ACTION_CODES,
  CANDIDATE_INTENT_CODES,
  ESCALATION_REASON_CODES,
  TARGET_QUEUES,
  type CandidateActionCode,
  type CandidateIntentCode,
  type EscalationReasonCode,
  type TargetQueue,
} from "./candidateOutput";

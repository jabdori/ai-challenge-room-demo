import { BENCHMARK_CHALLENGE } from "../data/benchmark/index";
import {
  parseCandidateComplexityProfiles,
  type CandidateComplexityProfiles,
} from "../contracts/candidateComplexity";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import {
  assertNoPotentialSecret,
  normalizeSecurityText,
} from "../runtime/secretSafety";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Z0-9][A-Z0-9._:-]*$/;
const PLAIN_JSON_MAX_ARRAY_LENGTH = 256;
const PLAIN_JSON_MAX_OBJECT_KEYS = 256;
const PLAIN_JSON_MAX_NODES = 4_096;
const PLAIN_JSON_MAX_DEPTH = 64;
const PLAIN_JSON_MAX_STRING_LENGTH = 100_000;

export const DEFINE_SOURCE_TYPES = [
  "SYNTHETIC_POLICY_MANIFEST",
  "SYNTHETIC_PUBLIC_EXAMPLES",
  "SYNTHETIC_ORDER_SCHEMA",
] as const;

export type DefineSourceType = (typeof DEFINE_SOURCE_TYPES)[number];

export const DEFINE_CRITERION_IDS = [
  "FACT_POLICY_ACCURACY",
  "CITATION_GROUNDING",
  "POLICY_COMPLIANCE",
  "ESCALATION_DECISION",
  "RESPONSE_QUALITY",
  "REPEAT_STABILITY",
] as const;

export const DEFINE_HARD_GATE_IDS = [
  "P0-HG-01",
  "P0-HG-02",
  "P0-HG-03",
  "P0-HG-04",
] as const;

export type DefineCriterionId = (typeof DEFINE_CRITERION_IDS)[number];
export type DefineHardGateId = (typeof DEFINE_HARD_GATE_IDS)[number];

export interface DefineBusinessBrief {
  title: string;
  decision: string;
  workflow: string;
  intended_users: string[];
  locale: "en-US";
}

export interface DefineConstraint {
  constraint_id: string;
  text: string;
}

export interface DefineProhibitedAction {
  prohibition_id: string;
  text: string;
}

export interface DefineSourceManifestItem {
  source_id: string;
  source_type: DefineSourceType;
  title: string;
  content_sha256: string;
  synthetic: true;
}

export interface DefineSourceManifest {
  manifest_version: "define-source-manifest-v1";
  sources: DefineSourceManifestItem[];
}

export interface DefineStructuringInput {
  schema_version: "define-structuring-input-v1";
  synthetic: true;
  business_brief: DefineBusinessBrief;
  constraints: DefineConstraint[];
  prohibited_actions: DefineProhibitedAction[];
  source_manifest: DefineSourceManifest;
}

export interface DefineTaskContractSuggestion {
  decision: string;
  input_contract: string[];
  output_contract: string[];
  allowed_source_ids: string[];
  operating_constraints: string[];
}

export interface DefineCriterionSuggestion {
  criterion_id: DefineCriterionId;
  description: string;
  evidence_required: string[];
}

export interface DefineHardGateSuggestion {
  gate_id: DefineHardGateId;
  failure_condition: string;
  required_evidence: string[];
}

export interface DefineSuggestion {
  artifact_kind: "DEFINE_SUGGESTION";
  authority: "ADVISORY_ONLY";
  task_contract: DefineTaskContractSuggestion;
  evaluation_criteria: [
    DefineCriterionSuggestion,
    DefineCriterionSuggestion,
    DefineCriterionSuggestion,
    DefineCriterionSuggestion,
    DefineCriterionSuggestion,
    DefineCriterionSuggestion,
  ];
  hard_gates: [
    DefineHardGateSuggestion,
    DefineHardGateSuggestion,
    DefineHardGateSuggestion,
    DefineHardGateSuggestion,
  ];
  limitations: string[];
}

export interface ChallengeSufficiencyContract {
  critical_failures: {
    maximum: 0;
    total_cases: 12;
  };
  valid_runs: {
    minimum: 24;
    total_runs: 24;
  };
  policy_decisions: {
    minimum_correct: 11;
    applicable_cases: 12;
  };
  citations: {
    minimum_valid: 11;
    required_cases: 11;
  };
  escalations: {
    minimum_correct: 4;
    applicable_cases: 4;
  };
  repeat_stability: {
    minimum_stable: 12;
    total_cases: 12;
  };
  open_reviews: {
    maximum: 0;
  };
  mean_runtime_cost_usd: {
    maximum: number;
  };
  latency_ms: {
    median_maximum: number;
    worst_maximum: number;
  };
}

export interface HumanApprovedChallengeContract {
  schema_version: "human-approved-challenge-contract-v1";
  synthetic: true;
  challenge_id: string;
  challenge_version: string;
  task_contract: DefineTaskContractSuggestion;
  constraints: DefineConstraint[];
  prohibited_actions: DefineProhibitedAction[];
  source_manifest: DefineSourceManifest;
  evaluation_criteria: DefineSuggestion["evaluation_criteria"];
  hard_gates: DefineSuggestion["hard_gates"];
  candidate_complexity_profiles: CandidateComplexityProfiles;
  sufficiency: ChallengeSufficiencyContract;
}

export interface HumanChallengeApproval {
  schema_version: "human-challenge-approval-v1";
  synthetic: true;
  actor_type: "HUMAN";
  actor_label: string;
  decision: "APPROVE_EXACT_CONTRACT";
  approved_at: string;
  define_input_hash: string;
  define_suggestion_hash: string;
  approved_contract: HumanApprovedChallengeContract;
}

export interface LockedChallengePack {
  schema_version: "locked-challenge-pack-v1";
  artifact_kind: "LOCKED_CHALLENGE_PACK";
  synthetic: true;
  state: "LOCKED";
  authority: "EXPLICIT_HUMAN_APPROVAL";
  challenge_id: string;
  challenge_version: string;
  locked_at: string;
  approved_by: string;
  source_define_input_hash: string;
  source_define_suggestion_hash: string;
  approved_contract: HumanApprovedChallengeContract;
  approved_contract_hash: string;
  source_manifest_hash: string;
  runtime_challenge_metadata_hash: string;
  locked_challenge_pack_hash: string;
}

export interface LockedChallengeBenchmarkBinding {
  locked_challenge_pack_hash: string;
  runtime_challenge_metadata_hash: string;
  approved_contract_hash: string;
  source_manifest_hash: string;
}

export interface CreateLockedChallengePackInput {
  readonly approval: HumanChallengeApproval;
  readonly defineInput: DefineStructuringInput;
  readonly defineSuggestion: DefineSuggestion;
}

const authoritativeLockedChallengePacks = new WeakSet<object>();

const defineCriterionSuggestionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    criterion_id: {
      type: "string",
      enum: DEFINE_CRITERION_IDS,
    },
    description: { type: "string" },
    evidence_required: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
    },
  },
  required: ["criterion_id", "description", "evidence_required"],
} as const;

const defineHardGateSuggestionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    gate_id: {
      type: "string",
      enum: DEFINE_HARD_GATE_IDS,
    },
    failure_condition: { type: "string" },
    required_evidence: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
    },
  },
  required: ["gate_id", "failure_condition", "required_evidence"],
} as const;

export const defineSuggestionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    artifact_kind: {
      type: "string",
      enum: ["DEFINE_SUGGESTION"],
    },
    authority: {
      type: "string",
      enum: ["ADVISORY_ONLY"],
    },
    task_contract: {
      type: "object",
      additionalProperties: false,
      properties: {
        decision: { type: "string" },
        input_contract: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
        output_contract: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
        allowed_source_ids: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
        operating_constraints: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
      },
      required: [
        "decision",
        "input_contract",
        "output_contract",
        "allowed_source_ids",
        "operating_constraints",
      ],
    },
    evaluation_criteria: {
      type: "array",
      minItems: DEFINE_CRITERION_IDS.length,
      maxItems: DEFINE_CRITERION_IDS.length,
      items: defineCriterionSuggestionJsonSchema,
    },
    hard_gates: {
      type: "array",
      minItems: DEFINE_HARD_GATE_IDS.length,
      maxItems: DEFINE_HARD_GATE_IDS.length,
      items: defineHardGateSuggestionJsonSchema,
    },
    limitations: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
    },
  },
  required: [
    "artifact_kind",
    "authority",
    "task_contract",
    "evaluation_criteria",
    "hard_gates",
    "limitations",
  ],
} as const;

export const defineSuggestionResponseFormat = {
  type: "json_schema",
  name: "define_advisory_challenge_suggestion",
  strict: true,
  schema: defineSuggestionJsonSchema,
} as const;

type JsonRecord = Record<string, unknown>;

/**
 * 외부 입력을 한 번의 descriptor snapshot으로 plain JSON data에 고정합니다.
 * 이후 보안 검사와 계약 파싱이 같은 값만 보게 하여 getter/Proxy 재읽기
 * TOCTOU가 검사 뒤 값을 바꾸지 못하게 합니다.
 */
function snapshotPlainJsonData(
  value: unknown,
  location: string,
  state: {
    readonly seen: WeakSet<object>;
    nodes: number;
  } = {
    seen: new WeakSet<object>(),
    nodes: 0,
  },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (state.nodes > PLAIN_JSON_MAX_NODES) {
    throw new TypeError(
      `${location}의 plain JSON 전체 node 수가 ${PLAIN_JSON_MAX_NODES} 상한을 초과했습니다.`,
    );
  }
  if (depth > PLAIN_JSON_MAX_DEPTH) {
    throw new TypeError(
      `${location}의 plain JSON 깊이가 ${PLAIN_JSON_MAX_DEPTH} 상한을 초과했습니다.`,
    );
  }
  if (
    value === null
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "string") {
    if (value.length > PLAIN_JSON_MAX_STRING_LENGTH) {
      throw new TypeError(
        `${location}의 문자열 길이가 ${PLAIN_JSON_MAX_STRING_LENGTH} 상한을 초과했습니다.`,
      );
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${location}의 숫자는 유한해야 합니다.`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${location}은(는) plain JSON data여야 합니다.`);
  }
  if (state.seen.has(value)) {
    throw new TypeError(`${location}에는 순환 참조가 있을 수 없습니다.`);
  }
  state.seen.add(value);

  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (
    (isArray && prototype !== Array.prototype)
    || (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    throw new TypeError(`${location}은(는) plain JSON 객체 또는 배열이어야 합니다.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    throw new TypeError(`${location}에는 symbol 속성이 있을 수 없습니다.`);
  }
  if (!isArray && ownKeys.length > PLAIN_JSON_MAX_OBJECT_KEYS) {
    throw new TypeError(
      `${location} 객체의 key 수가 ${PLAIN_JSON_MAX_OBJECT_KEYS} 상한을 초과했습니다.`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);

  if (isArray) {
    const lengthDescriptor = descriptors.length;
    if (
      !lengthDescriptor
      || !("value" in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      throw new TypeError(`${location}.length는 plain data property여야 합니다.`);
    }
    const length = lengthDescriptor.value as number;
    if (length > PLAIN_JSON_MAX_ARRAY_LENGTH) {
      throw new TypeError(
        `${location} 배열 길이가 ${PLAIN_JSON_MAX_ARRAY_LENGTH} 상한을 초과했습니다.`,
      );
    }
    const allowed = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
    const additional = Object.keys(descriptors).filter((key) => !allowed.has(key));
    if (additional.length > 0) {
      throw new TypeError(`${location} 배열에는 추가 속성이 있을 수 없습니다.`);
    }
    return Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || !("value" in descriptor)
        || !descriptor.enumerable
      ) {
        throw new TypeError(
          `${location}[${index}]는 getter/setter 또는 hole이 아닌 plain data property여야 합니다.`,
        );
      }
      return snapshotPlainJsonData(
        descriptor.value,
        `${location}[${index}]`,
        state,
        depth + 1,
      );
    });
  }

  // `__proto__`도 일반 own key로 보존해 exact-shape 검사에서 사라지지 않게 합니다.
  const snapshot = Object.create(null) as JsonRecord;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(
        `${location}의 property는 getter/setter accessor가 아닌 plain data property여야 합니다.`,
      );
    }
    snapshot[key] = snapshotPlainJsonData(
      descriptor.value,
      `${location}.[property]`,
      state,
      depth + 1,
    );
  }
  return snapshot;
}

function readRecord(value: unknown, location: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${location}은(는) plain JSON 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${location}은(는) plain JSON 객체여야 합니다.`);
  }
  return value as JsonRecord;
}

function assertExactKeys(
  record: JsonRecord,
  expectedKeys: readonly string[],
  location: string,
): void {
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(record, key));
  const additional = Object.keys(record).filter((key) => !expected.has(key));
  if (missing.length > 0 || additional.length > 0) {
    throw new TypeError(
      `${location}의 exact 필드 계약이 다릅니다. missing=${missing.join(",")} additional=${additional.join(",")}`,
    );
  }
}

function readString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${location}은(는) 비어 있지 않은 문자열이어야 합니다.`);
  }
  if (/\p{Cc}/u.test(value)) {
    throw new TypeError(`${location}에는 제어 문자를 넣을 수 없습니다.`);
  }
  return value;
}

function readIdentifier(value: unknown, location: string): string {
  const result = readString(value, location);
  if (!IDENTIFIER_PATTERN.test(result)) {
    throw new TypeError(`${location}은(는) 잠긴 대문자 식별자 형식이어야 합니다.`);
  }
  return result;
}

function readUniqueStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${location}은(는) 비어 있지 않은 문자열 배열이어야 합니다.`);
  }
  const result = value.map((item, index) => readString(item, `${location}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${location}에는 중복 값을 넣을 수 없습니다.`);
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

function readSha256(value: unknown, location: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${location}은(는) 64자리 소문자 SHA-256이어야 합니다.`);
  }
  return value;
}

function readIsoTimestamp(value: unknown, location: string): string {
  const timestamp = readString(value, location);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new TypeError(`${location}은(는) 정규 ISO timestamp여야 합니다.`);
  }
  return timestamp;
}

function readPositiveFiniteNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${location}은(는) 0보다 큰 유한한 숫자여야 합니다.`);
  }
  return value;
}

const HIDDEN_BENCHMARK_STRING_PATTERNS = [
  /\bH-\d{3}\b/i,
  /\bhidden[\s_-]*benchmark\b/i,
  /\boracles?\b/i,
  /\bdataset[\s_-]*(?:id|split)\b/i,
  /\bchallenge[\s_-]*benchmark[\s_-]*v\d+\b/i,
] as const;

const HIDDEN_BENCHMARK_KEY_PATTERN =
  /(?:^|_)(?:case_ids?|hidden_cases?|oracles?|dataset_id|dataset_split|high_risk_case_ids|expected_execution_count)(?:$|_)/i;

/**
 * Define 모델 경계에는 숨은 사례·정답·dataset 식별자가 들어갈 수 없습니다.
 * 이 검사는 키와 실제 문자열 값을 모두 순회합니다.
 */
export function assertNoHiddenBenchmarkLeak(
  value: unknown,
  location = "Define artifact",
): void {
  const visit = (item: unknown, path: string): void => {
    if (typeof item === "string") {
      const normalized = normalizeSecurityText(item);
      if (HIDDEN_BENCHMARK_STRING_PATTERNS.some((pattern) => pattern.test(normalized))) {
        throw new TypeError(`${path}에 숨은 Benchmark·oracle·dataset 식별자 누출이 있습니다.`);
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (typeof item !== "object" || item === null) return;
    for (const [key, child] of Object.entries(item as JsonRecord)) {
      const normalizedKey = normalizeSecurityText(key);
      if (HIDDEN_BENCHMARK_KEY_PATTERN.test(normalizedKey)) {
        throw new TypeError(`${path}의 property에 숨은 Benchmark 필드 누출이 있습니다.`);
      }
      visit(child, `${path}.[property]`);
    }
  };
  visit(value, location);
}

/** 합성 전용 Define 경계가 credential 형태 값을 외부 요청·증거에 보존하지 않게 합니다. */
function assertNoSensitiveCredentialLeak(
  value: unknown,
  location: string,
): void {
  assertNoPotentialSecret(value, location);
}

function parseConstraint(value: unknown, index: number): DefineConstraint {
  const location = `Define input.constraints[${index}]`;
  const record = readRecord(value, location);
  assertExactKeys(record, ["constraint_id", "text"], location);
  return {
    constraint_id: readIdentifier(record.constraint_id, `${location}.constraint_id`),
    text: readString(record.text, `${location}.text`),
  };
}

function parseProhibitedAction(value: unknown, index: number): DefineProhibitedAction {
  const location = `Define input.prohibited_actions[${index}]`;
  const record = readRecord(value, location);
  assertExactKeys(record, ["prohibition_id", "text"], location);
  return {
    prohibition_id: readIdentifier(record.prohibition_id, `${location}.prohibition_id`),
    text: readString(record.text, `${location}.text`),
  };
}

function assertUniqueIds(
  values: readonly string[],
  location: string,
): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${location}에는 중복 ID를 넣을 수 없습니다.`);
  }
}

function parseSourceManifest(value: unknown): DefineSourceManifest {
  const location = "Define input.source_manifest";
  const record = readRecord(value, location);
  assertExactKeys(record, ["manifest_version", "sources"], location);
  if (record.manifest_version !== "define-source-manifest-v1") {
    throw new TypeError(`${location}.manifest_version이 잠긴 계약과 다릅니다.`);
  }
  if (!Array.isArray(record.sources) || record.sources.length === 0) {
    throw new TypeError(`${location}.sources는 비어 있지 않은 배열이어야 합니다.`);
  }
  const sources = record.sources.map((item, index): DefineSourceManifestItem => {
    const itemLocation = `${location}.sources[${index}]`;
    const source = readRecord(item, itemLocation);
    assertExactKeys(
      source,
      ["source_id", "source_type", "title", "content_sha256", "synthetic"],
      itemLocation,
    );
    if (source.synthetic !== true) {
      throw new TypeError(`${itemLocation}.synthetic은 true여야 합니다.`);
    }
    if (typeof source.content_sha256 !== "string" || !SHA256_PATTERN.test(source.content_sha256)) {
      throw new TypeError(`${itemLocation}.content_sha256은 SHA-256이어야 합니다.`);
    }
    return {
      source_id: readIdentifier(source.source_id, `${itemLocation}.source_id`),
      source_type: readEnum(
        source.source_type,
        DEFINE_SOURCE_TYPES,
        `${itemLocation}.source_type`,
      ),
      title: readString(source.title, `${itemLocation}.title`),
      content_sha256: source.content_sha256,
      synthetic: true,
    };
  });
  assertUniqueIds(sources.map((item) => item.source_id), `${location}.sources`);
  return {
    manifest_version: "define-source-manifest-v1",
    sources,
  };
}

function parseTaskContract(
  value: unknown,
  sourceManifest: DefineSourceManifest,
  location: string,
): DefineTaskContractSuggestion {
  const task = readRecord(value, location);
  assertExactKeys(
    task,
    [
      "decision",
      "input_contract",
      "output_contract",
      "allowed_source_ids",
      "operating_constraints",
    ],
    location,
  );
  const allowedSourceIds = readUniqueStringArray(
    task.allowed_source_ids,
    `${location}.allowed_source_ids`,
  ).map((sourceId, index) => readIdentifier(
    sourceId,
    `${location}.allowed_source_ids[${index}]`,
  ));
  const sourceManifestIds = new Set(sourceManifest.sources.map((source) => source.source_id));
  if (allowedSourceIds.some((sourceId) => !sourceManifestIds.has(sourceId))) {
    throw new TypeError(`${location}의 allowed source가 잠긴 source manifest에 없습니다.`);
  }
  return {
    decision: readString(task.decision, `${location}.decision`),
    input_contract: readUniqueStringArray(
      task.input_contract,
      `${location}.input_contract`,
    ),
    output_contract: readUniqueStringArray(
      task.output_contract,
      `${location}.output_contract`,
    ),
    allowed_source_ids: allowedSourceIds,
    operating_constraints: readUniqueStringArray(
      task.operating_constraints,
      `${location}.operating_constraints`,
    ),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

export function parseDefineStructuringInput(value: unknown): DefineStructuringInput {
  const snapshot = snapshotPlainJsonData(value, "Define input");
  assertNoHiddenBenchmarkLeak(snapshot, "Define input");
  assertNoSensitiveCredentialLeak(snapshot, "Define input");
  const record = readRecord(snapshot, "Define input");
  assertExactKeys(
    record,
    [
      "schema_version",
      "synthetic",
      "business_brief",
      "constraints",
      "prohibited_actions",
      "source_manifest",
    ],
    "Define input",
  );
  if (record.schema_version !== "define-structuring-input-v1") {
    throw new TypeError("Define input.schema_version이 잠긴 계약과 다릅니다.");
  }
  if (record.synthetic !== true) {
    throw new TypeError("Define input.synthetic은 true여야 합니다.");
  }

  const business = readRecord(record.business_brief, "Define input.business_brief");
  assertExactKeys(
    business,
    ["title", "decision", "workflow", "intended_users", "locale"],
    "Define input.business_brief",
  );
  if (business.locale !== "en-US") {
    throw new TypeError("Define input.business_brief.locale은 en-US여야 합니다.");
  }
  if (!Array.isArray(record.constraints) || record.constraints.length === 0) {
    throw new TypeError("Define input.constraints는 비어 있지 않은 배열이어야 합니다.");
  }
  if (!Array.isArray(record.prohibited_actions) || record.prohibited_actions.length === 0) {
    throw new TypeError("Define input.prohibited_actions는 비어 있지 않은 배열이어야 합니다.");
  }

  const constraints = record.constraints.map(parseConstraint);
  const prohibitedActions = record.prohibited_actions.map(parseProhibitedAction);
  assertUniqueIds(
    constraints.map((item) => item.constraint_id),
    "Define input.constraints",
  );
  assertUniqueIds(
    prohibitedActions.map((item) => item.prohibition_id),
    "Define input.prohibited_actions",
  );

  return deepFreeze({
    schema_version: "define-structuring-input-v1",
    synthetic: true,
    business_brief: {
      title: readString(business.title, "Define input.business_brief.title"),
      decision: readString(business.decision, "Define input.business_brief.decision"),
      workflow: readString(business.workflow, "Define input.business_brief.workflow"),
      intended_users: readUniqueStringArray(
        business.intended_users,
        "Define input.business_brief.intended_users",
      ),
      locale: "en-US",
    },
    constraints,
    prohibited_actions: prohibitedActions,
    source_manifest: parseSourceManifest(record.source_manifest),
  });
}

function parseJsonText(value: string, location: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError(`${location}이 유효한 JSON 문자열이 아닙니다.`, { cause: error });
  }
}

function parseCriterionSuggestion(
  value: unknown,
  index: number,
): DefineCriterionSuggestion {
  const location = `Define suggestion.evaluation_criteria[${index}]`;
  const record = readRecord(value, location);
  assertExactKeys(record, ["criterion_id", "description", "evidence_required"], location);
  const expectedId = DEFINE_CRITERION_IDS[index];
  if (record.criterion_id !== expectedId) {
    throw new TypeError(`${location}.criterion_id의 잠긴 순서·coverage가 다릅니다.`);
  }
  return {
    criterion_id: expectedId,
    description: readString(record.description, `${location}.description`),
    evidence_required: readUniqueStringArray(
      record.evidence_required,
      `${location}.evidence_required`,
    ),
  };
}

function parseHardGateSuggestion(
  value: unknown,
  index: number,
): DefineHardGateSuggestion {
  const location = `Define suggestion.hard_gates[${index}]`;
  const record = readRecord(value, location);
  assertExactKeys(record, ["gate_id", "failure_condition", "required_evidence"], location);
  const expectedId = DEFINE_HARD_GATE_IDS[index];
  if (record.gate_id !== expectedId) {
    throw new TypeError(`${location}.gate_id의 잠긴 순서·coverage가 다릅니다.`);
  }
  return {
    gate_id: expectedId,
    failure_condition: readString(
      record.failure_condition,
      `${location}.failure_condition`,
    ),
    required_evidence: readUniqueStringArray(
      record.required_evidence,
      `${location}.required_evidence`,
    ),
  };
}

export function parseDefineSuggestion(
  value: unknown,
  expectedInput: DefineStructuringInput,
): DefineSuggestion {
  const input = parseDefineStructuringInput(expectedInput);
  const decoded = typeof value === "string"
    ? parseJsonText(value, "Define suggestion")
    : value;
  const raw = snapshotPlainJsonData(decoded, "Define suggestion");
  assertNoHiddenBenchmarkLeak(raw, "Define suggestion");
  assertNoSensitiveCredentialLeak(raw, "Define suggestion");
  const record = readRecord(raw, "Define suggestion");
  assertExactKeys(
    record,
    [
      "artifact_kind",
      "authority",
      "task_contract",
      "evaluation_criteria",
      "hard_gates",
      "limitations",
    ],
    "Define suggestion",
  );
  if (record.artifact_kind !== "DEFINE_SUGGESTION") {
    throw new TypeError("Define suggestion.artifact_kind가 DEFINE_SUGGESTION이 아닙니다.");
  }
  if (record.authority !== "ADVISORY_ONLY") {
    throw new TypeError("Define suggestion.authority는 ADVISORY_ONLY여야 합니다.");
  }

  const task = parseTaskContract(
    record.task_contract,
    input.source_manifest,
    "Define suggestion.task_contract",
  );

  if (
    !Array.isArray(record.evaluation_criteria)
    || record.evaluation_criteria.length !== DEFINE_CRITERION_IDS.length
  ) {
    throw new TypeError("Define suggestion.evaluation_criteria coverage가 다릅니다.");
  }
  if (
    !Array.isArray(record.hard_gates)
    || record.hard_gates.length !== DEFINE_HARD_GATE_IDS.length
  ) {
    throw new TypeError("Define suggestion.hard_gates에는 잠긴 4개 gate가 필요합니다.");
  }

  const suggestion: DefineSuggestion = {
    artifact_kind: "DEFINE_SUGGESTION",
    authority: "ADVISORY_ONLY",
    task_contract: task,
    evaluation_criteria: record.evaluation_criteria.map(
      parseCriterionSuggestion,
    ) as DefineSuggestion["evaluation_criteria"],
    hard_gates: record.hard_gates.map(
      parseHardGateSuggestion,
    ) as DefineSuggestion["hard_gates"],
    limitations: readUniqueStringArray(
      record.limitations,
      "Define suggestion.limitations",
    ),
  };
  return deepFreeze(suggestion);
}

function readFixedNumber(
  value: unknown,
  expected: number,
  location: string,
): number {
  if (value !== expected) {
    throw new TypeError(`${location}은(는) 잠긴 ${expected} 값이어야 합니다.`);
  }
  return expected;
}

function parseSufficiencyContract(value: unknown): ChallengeSufficiencyContract {
  const location = "Human approved contract.sufficiency";
  const record = readRecord(value, location);
  assertExactKeys(
    record,
    [
      "critical_failures",
      "valid_runs",
      "policy_decisions",
      "citations",
      "escalations",
      "repeat_stability",
      "open_reviews",
      "mean_runtime_cost_usd",
      "latency_ms",
    ],
    location,
  );

  const critical = readRecord(record.critical_failures, `${location}.critical_failures`);
  assertExactKeys(critical, ["maximum", "total_cases"], `${location}.critical_failures`);
  const validRuns = readRecord(record.valid_runs, `${location}.valid_runs`);
  assertExactKeys(validRuns, ["minimum", "total_runs"], `${location}.valid_runs`);
  const policy = readRecord(record.policy_decisions, `${location}.policy_decisions`);
  assertExactKeys(
    policy,
    ["minimum_correct", "applicable_cases"],
    `${location}.policy_decisions`,
  );
  const citations = readRecord(record.citations, `${location}.citations`);
  assertExactKeys(citations, ["minimum_valid", "required_cases"], `${location}.citations`);
  const escalations = readRecord(record.escalations, `${location}.escalations`);
  assertExactKeys(
    escalations,
    ["minimum_correct", "applicable_cases"],
    `${location}.escalations`,
  );
  const stability = readRecord(record.repeat_stability, `${location}.repeat_stability`);
  assertExactKeys(
    stability,
    ["minimum_stable", "total_cases"],
    `${location}.repeat_stability`,
  );
  const openReviews = readRecord(record.open_reviews, `${location}.open_reviews`);
  assertExactKeys(openReviews, ["maximum"], `${location}.open_reviews`);
  const meanCost = readRecord(
    record.mean_runtime_cost_usd,
    `${location}.mean_runtime_cost_usd`,
  );
  assertExactKeys(meanCost, ["maximum"], `${location}.mean_runtime_cost_usd`);
  const latency = readRecord(record.latency_ms, `${location}.latency_ms`);
  assertExactKeys(
    latency,
    ["median_maximum", "worst_maximum"],
    `${location}.latency_ms`,
  );
  const medianMaximum = readPositiveFiniteNumber(
    latency.median_maximum,
    `${location}.latency_ms.median_maximum`,
  );
  const worstMaximum = readPositiveFiniteNumber(
    latency.worst_maximum,
    `${location}.latency_ms.worst_maximum`,
  );
  if (worstMaximum < medianMaximum) {
    throw new TypeError(`${location}.latency_ms worst 한도는 median 한도 이상이어야 합니다.`);
  }

  return {
    critical_failures: {
      maximum: readFixedNumber(
        critical.maximum,
        0,
        `${location}.critical_failures.maximum`,
      ) as 0,
      total_cases: readFixedNumber(
        critical.total_cases,
        12,
        `${location}.critical_failures.total_cases`,
      ) as 12,
    },
    valid_runs: {
      minimum: readFixedNumber(
        validRuns.minimum,
        24,
        `${location}.valid_runs.minimum`,
      ) as 24,
      total_runs: readFixedNumber(
        validRuns.total_runs,
        24,
        `${location}.valid_runs.total_runs`,
      ) as 24,
    },
    policy_decisions: {
      minimum_correct: readFixedNumber(
        policy.minimum_correct,
        11,
        `${location}.policy_decisions.minimum_correct`,
      ) as 11,
      applicable_cases: readFixedNumber(
        policy.applicable_cases,
        12,
        `${location}.policy_decisions.applicable_cases`,
      ) as 12,
    },
    citations: {
      minimum_valid: readFixedNumber(
        citations.minimum_valid,
        11,
        `${location}.citations.minimum_valid`,
      ) as 11,
      required_cases: readFixedNumber(
        citations.required_cases,
        11,
        `${location}.citations.required_cases`,
      ) as 11,
    },
    escalations: {
      minimum_correct: readFixedNumber(
        escalations.minimum_correct,
        4,
        `${location}.escalations.minimum_correct`,
      ) as 4,
      applicable_cases: readFixedNumber(
        escalations.applicable_cases,
        4,
        `${location}.escalations.applicable_cases`,
      ) as 4,
    },
    repeat_stability: {
      minimum_stable: readFixedNumber(
        stability.minimum_stable,
        12,
        `${location}.repeat_stability.minimum_stable`,
      ) as 12,
      total_cases: readFixedNumber(
        stability.total_cases,
        12,
        `${location}.repeat_stability.total_cases`,
      ) as 12,
    },
    open_reviews: {
      maximum: readFixedNumber(
        openReviews.maximum,
        0,
        `${location}.open_reviews.maximum`,
      ) as 0,
    },
    mean_runtime_cost_usd: {
      maximum: readPositiveFiniteNumber(
        meanCost.maximum,
        `${location}.mean_runtime_cost_usd.maximum`,
      ),
    },
    latency_ms: {
      median_maximum: medianMaximum,
      worst_maximum: worstMaximum,
    },
  };
}

function parseApprovedChallengeContract(value: unknown): HumanApprovedChallengeContract {
  assertNoHiddenBenchmarkLeak(value, "Human approved contract");
  assertNoSensitiveCredentialLeak(value, "Human approved contract");
  const location = "Human approved contract";
  const record = readRecord(value, location);
  assertExactKeys(
    record,
    [
      "schema_version",
      "synthetic",
      "challenge_id",
      "challenge_version",
      "task_contract",
      "constraints",
      "prohibited_actions",
      "source_manifest",
      "evaluation_criteria",
      "hard_gates",
      "candidate_complexity_profiles",
      "sufficiency",
    ],
    location,
  );
  if (record.schema_version !== "human-approved-challenge-contract-v1") {
    throw new TypeError(`${location}.schema_version이 잠긴 계약과 다릅니다.`);
  }
  if (record.synthetic !== true) {
    throw new TypeError(`${location}.synthetic은 true여야 합니다.`);
  }
  const challengeId = readString(record.challenge_id, `${location}.challenge_id`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(challengeId)) {
    throw new TypeError(`${location}.challenge_id 형식이 다릅니다.`);
  }
  const challengeVersion = readString(
    record.challenge_version,
    `${location}.challenge_version`,
  );
  if (!/^v[1-9]\d*$/.test(challengeVersion)) {
    throw new TypeError(`${location}.challenge_version은 v1 형태여야 합니다.`);
  }
  const sourceManifest = parseSourceManifest(record.source_manifest);
  if (!Array.isArray(record.constraints) || record.constraints.length === 0) {
    throw new TypeError(`${location}.constraints는 비어 있지 않은 배열이어야 합니다.`);
  }
  if (!Array.isArray(record.prohibited_actions) || record.prohibited_actions.length === 0) {
    throw new TypeError(`${location}.prohibited_actions는 비어 있지 않은 배열이어야 합니다.`);
  }
  if (
    !Array.isArray(record.evaluation_criteria)
    || record.evaluation_criteria.length !== DEFINE_CRITERION_IDS.length
  ) {
    throw new TypeError(`${location}.evaluation_criteria coverage가 다릅니다.`);
  }
  if (
    !Array.isArray(record.hard_gates)
    || record.hard_gates.length !== DEFINE_HARD_GATE_IDS.length
  ) {
    throw new TypeError(`${location}.hard_gates coverage가 다릅니다.`);
  }
  const constraints = record.constraints.map(parseConstraint);
  const prohibitedActions = record.prohibited_actions.map(parseProhibitedAction);
  assertUniqueIds(
    constraints.map((item) => item.constraint_id),
    `${location}.constraints`,
  );
  assertUniqueIds(
    prohibitedActions.map((item) => item.prohibition_id),
    `${location}.prohibited_actions`,
  );
  return deepFreeze({
    schema_version: "human-approved-challenge-contract-v1",
    synthetic: true,
    challenge_id: challengeId,
    challenge_version: challengeVersion,
    task_contract: parseTaskContract(
      record.task_contract,
      sourceManifest,
      `${location}.task_contract`,
    ),
    constraints,
    prohibited_actions: prohibitedActions,
    source_manifest: sourceManifest,
    evaluation_criteria: record.evaluation_criteria.map(
      parseCriterionSuggestion,
    ) as DefineSuggestion["evaluation_criteria"],
    hard_gates: record.hard_gates.map(
      parseHardGateSuggestion,
    ) as DefineSuggestion["hard_gates"],
    candidate_complexity_profiles: parseCandidateComplexityProfiles(
      record.candidate_complexity_profiles,
      `${location}.candidate_complexity_profiles`,
    ),
    sufficiency: parseSufficiencyContract(record.sufficiency),
  });
}

function parseHumanChallengeApproval(value: unknown): HumanChallengeApproval {
  assertNoHiddenBenchmarkLeak(value, "Human challenge approval");
  assertNoSensitiveCredentialLeak(value, "Human challenge approval");
  const location = "Human challenge approval";
  const record = readRecord(value, location);
  assertExactKeys(
    record,
    [
      "schema_version",
      "synthetic",
      "actor_type",
      "actor_label",
      "decision",
      "approved_at",
      "define_input_hash",
      "define_suggestion_hash",
      "approved_contract",
    ],
    location,
  );
  if (record.schema_version !== "human-challenge-approval-v1") {
    throw new TypeError(`${location}.schema_version이 잠긴 계약과 다릅니다.`);
  }
  if (record.synthetic !== true) {
    throw new TypeError(`${location}.synthetic은 true여야 합니다.`);
  }
  if (record.actor_type !== "HUMAN") {
    throw new TypeError(`${location}.actor_type은 HUMAN이어야 합니다.`);
  }
  if (record.decision !== "APPROVE_EXACT_CONTRACT") {
    throw new TypeError(`${location}.decision은 명시적 exact approval이어야 합니다.`);
  }
  return deepFreeze({
    schema_version: "human-challenge-approval-v1",
    synthetic: true,
    actor_type: "HUMAN",
    actor_label: readString(record.actor_label, `${location}.actor_label`),
    decision: "APPROVE_EXACT_CONTRACT",
    approved_at: readIsoTimestamp(record.approved_at, `${location}.approved_at`),
    define_input_hash: readSha256(
      record.define_input_hash,
      `${location}.define_input_hash`,
    ),
    define_suggestion_hash: readSha256(
      record.define_suggestion_hash,
      `${location}.define_suggestion_hash`,
    ),
    approved_contract: parseApprovedChallengeContract(record.approved_contract),
  });
}

const LOCKED_CHALLENGE_PACK_KEYS = [
  "schema_version",
  "artifact_kind",
  "synthetic",
  "state",
  "authority",
  "challenge_id",
  "challenge_version",
  "locked_at",
  "approved_by",
  "source_define_input_hash",
  "source_define_suggestion_hash",
  "approved_contract",
  "approved_contract_hash",
  "source_manifest_hash",
  "runtime_challenge_metadata_hash",
  "locked_challenge_pack_hash",
] as const;

function buildLockedChallengePayload(approval: HumanChallengeApproval) {
  const approvedContractHash = sha256CanonicalJson(approval.approved_contract);
  const sourceManifestHash = sha256CanonicalJson(
    approval.approved_contract.source_manifest,
  );
  return {
    schema_version: "locked-challenge-pack-v1" as const,
    artifact_kind: "LOCKED_CHALLENGE_PACK" as const,
    synthetic: true as const,
    state: "LOCKED" as const,
    authority: "EXPLICIT_HUMAN_APPROVAL" as const,
    challenge_id: approval.approved_contract.challenge_id,
    challenge_version: approval.approved_contract.challenge_version,
    locked_at: approval.approved_at,
    approved_by: approval.actor_label,
    source_define_input_hash: approval.define_input_hash,
    source_define_suggestion_hash: approval.define_suggestion_hash,
    approved_contract: approval.approved_contract,
    approved_contract_hash: approvedContractHash,
    source_manifest_hash: sourceManifestHash,
    runtime_challenge_metadata_hash: sha256CanonicalJson(BENCHMARK_CHALLENGE),
  };
}

export function createLockedChallengePack(
  input: CreateLockedChallengePackInput,
): LockedChallengePack {
  const location = "Locked Challenge creation input";
  const snapshot = snapshotPlainJsonData(input, location);
  const record = readRecord(snapshot, location);
  assertExactKeys(
    record,
    ["approval", "defineInput", "defineSuggestion"],
    location,
  );
  const defineInput = parseDefineStructuringInput(record.defineInput);
  const defineSuggestion = parseDefineSuggestion(
    record.defineSuggestion,
    defineInput,
  );
  const approval = parseHumanChallengeApproval(record.approval);
  if (
    approval.define_input_hash !== sha256CanonicalJson(defineInput)
    || approval.define_suggestion_hash !== sha256CanonicalJson(defineSuggestion)
  ) {
    throw new TypeError(
      `${location}의 인간 승인 source hash가 실제 Define input·suggestion과 일치하지 않습니다.`,
    );
  }
  const payload = buildLockedChallengePayload(approval);
  const pack = deepFreeze({
    ...payload,
    locked_challenge_pack_hash: sha256CanonicalJson(payload),
  });
  authoritativeLockedChallengePacks.add(pack);
  return pack;
}

export function parseLockedChallengePack(value: unknown): LockedChallengePack {
  const location = "Locked Challenge pack";
  const snapshot = snapshotPlainJsonData(value, location);
  assertNoHiddenBenchmarkLeak(snapshot, location);
  assertNoSensitiveCredentialLeak(snapshot, location);
  const record = readRecord(snapshot, location);
  assertExactKeys(record, LOCKED_CHALLENGE_PACK_KEYS, location);
  if (
    record.schema_version !== "locked-challenge-pack-v1"
    || record.artifact_kind !== "LOCKED_CHALLENGE_PACK"
    || record.synthetic !== true
    || record.state !== "LOCKED"
    || record.authority !== "EXPLICIT_HUMAN_APPROVAL"
  ) {
    throw new TypeError(`${location}의 version·state·authority 계약이 다릅니다.`);
  }
  const approvedContract = parseApprovedChallengeContract(record.approved_contract);
  const parsed: LockedChallengePack = {
    schema_version: "locked-challenge-pack-v1",
    artifact_kind: "LOCKED_CHALLENGE_PACK",
    synthetic: true,
    state: "LOCKED",
    authority: "EXPLICIT_HUMAN_APPROVAL",
    challenge_id: readString(record.challenge_id, `${location}.challenge_id`),
    challenge_version: readString(
      record.challenge_version,
      `${location}.challenge_version`,
    ),
    locked_at: readIsoTimestamp(record.locked_at, `${location}.locked_at`),
    approved_by: readString(record.approved_by, `${location}.approved_by`),
    source_define_input_hash: readSha256(
      record.source_define_input_hash,
      `${location}.source_define_input_hash`,
    ),
    source_define_suggestion_hash: readSha256(
      record.source_define_suggestion_hash,
      `${location}.source_define_suggestion_hash`,
    ),
    approved_contract: approvedContract,
    approved_contract_hash: readSha256(
      record.approved_contract_hash,
      `${location}.approved_contract_hash`,
    ),
    source_manifest_hash: readSha256(
      record.source_manifest_hash,
      `${location}.source_manifest_hash`,
    ),
    runtime_challenge_metadata_hash: readSha256(
      record.runtime_challenge_metadata_hash,
      `${location}.runtime_challenge_metadata_hash`,
    ),
    locked_challenge_pack_hash: readSha256(
      record.locked_challenge_pack_hash,
      `${location}.locked_challenge_pack_hash`,
    ),
  };
  if (
    parsed.challenge_id !== approvedContract.challenge_id
    || parsed.challenge_version !== approvedContract.challenge_version
    || parsed.approved_contract_hash !== sha256CanonicalJson(approvedContract)
    || parsed.source_manifest_hash !== sha256CanonicalJson(approvedContract.source_manifest)
    || parsed.runtime_challenge_metadata_hash !== sha256CanonicalJson(BENCHMARK_CHALLENGE)
  ) {
    throw new TypeError(`${location}의 approved contract·source·runtime hash 무결성이 다릅니다.`);
  }
  const { locked_challenge_pack_hash: _hash, ...payload } = parsed;
  if (sha256CanonicalJson(payload) !== parsed.locked_challenge_pack_hash) {
    throw new TypeError(`${location}.locked_challenge_pack_hash 무결성이 일치하지 않습니다.`);
  }
  return deepFreeze(parsed);
}

export function assertLockedChallengePack(
  value: unknown,
): asserts value is LockedChallengePack {
  parseLockedChallengePack(value);
}

/** 실제 Define source와 explicit human approval을 함께 검증해 생성한 동일 객체만 권위 pack입니다. */
export function assertAuthoritativeLockedChallengePack(
  value: unknown,
): asserts value is LockedChallengePack {
  if (
    typeof value !== "object"
    || value === null
    || !authoritativeLockedChallengePacks.has(value)
  ) {
    throw new TypeError(
      "Locked Challenge pack은 실제 Define source와 인간 승인을 검증한 authoritative build 결과여야 합니다.",
    );
  }
  parseLockedChallengePack(value);
}

/** 후속 Benchmark identity가 Task 12A 승인 뒤 필수 입력으로 받을 공개 binding입니다. */
export function buildLockedChallengeBenchmarkBinding(
  value: unknown,
): LockedChallengeBenchmarkBinding {
  assertAuthoritativeLockedChallengePack(value);
  const pack = parseLockedChallengePack(value);
  return deepFreeze({
    locked_challenge_pack_hash: pack.locked_challenge_pack_hash,
    runtime_challenge_metadata_hash: pack.runtime_challenge_metadata_hash,
    approved_contract_hash: pack.approved_contract_hash,
    source_manifest_hash: pack.source_manifest_hash,
  });
}

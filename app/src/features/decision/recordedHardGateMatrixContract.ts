type JsonRecord = Record<string, unknown>;

const GATE_CODES = [
  "P0-HG-01",
  "P0-HG-02",
  "P0-HG-03",
  "P0-HG-04",
] as const;
const CANDIDATE_IDS = ["A", "B", "C"] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const SLOT_EVIDENCE_ID = /^slot_[a-f0-9]{64}$/;

export type RecordedHardGateCode = (typeof GATE_CODES)[number];
export type RecordedHardGateCandidateId = (typeof CANDIDATE_IDS)[number];
export type RecordedHardGateCellStatus =
  | "PASS"
  | "CONFIRMED_FAIL"
  | "REVIEW";

export interface RecordedHardGateEvidenceActionView {
  readonly actionKind:
    | "OPEN_FAILURE_EVIDENCE"
    | "OPEN_REVIEW_EVIDENCE";
  readonly primaryEvidenceId: string;
  readonly evidenceIds: readonly string[];
}

export interface RecordedHardGateCellView {
  readonly candidateId: RecordedHardGateCandidateId;
  readonly status: RecordedHardGateCellStatus;
  readonly applicability:
    | "APPLICABLE"
    | "PARTIALLY_APPLICABLE"
    | "NOT_APPLICABLE";
  readonly counts: {
    readonly totalRuns: 24;
    readonly passRuns: number;
    readonly confirmedFailRuns: number;
    readonly reviewRuns: number;
    readonly notApplicableRuns: number;
    readonly affectedCases: number;
  };
  readonly evidenceBindingHash: string;
  readonly evidenceAction: RecordedHardGateEvidenceActionView | null;
}

export interface RecordedHardGateRowView {
  readonly gateCode: RecordedHardGateCode;
  readonly label: string;
  readonly decisionRule: string;
  readonly notApplicableMeaning: string;
  readonly candidates: readonly [
    RecordedHardGateCellView,
    RecordedHardGateCellView,
    RecordedHardGateCellView,
  ];
}

export interface RecordedHardGateMatrixView {
  readonly sourceHash: string;
  readonly authority:
    "SOURCE_RELOADED_DETERMINISTIC_SLOT_EVIDENCE";
  readonly aggregationOrder:
    "CONFIRMED_FAIL_THEN_REVIEW_THEN_PASS";
  readonly fatalFailuresAreNotAveraged: true;
  readonly rows: readonly [
    RecordedHardGateRowView,
    RecordedHardGateRowView,
    RecordedHardGateRowView,
    RecordedHardGateRowView,
  ];
}

export class RecordedHardGateMatrixProjectionError extends Error {
  readonly code = "RECORDED_HARD_GATE_MATRIX_PROJECTION_INVALID" as const;

  constructor(location: string) {
    super(`${location} hard-gate matrix projection 계약이 올바르지 않습니다.`);
    this.name = "RecordedHardGateMatrixProjectionError";
  }
}

function fail(location: string): never {
  throw new RecordedHardGateMatrixProjectionError(location);
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
    fail(location);
  }
  return value as JsonRecord;
}

function exact(
  value: JsonRecord,
  keys: readonly string[],
  location: string,
): void {
  const allowed = new Set(keys);
  if (
    keys.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) {
    fail(location);
  }
}

function text(value: unknown, location: string): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value !== value.trim()
    || /\p{Cc}/u.test(value)
  ) {
    fail(location);
  }
  return value;
}

function integer(value: unknown, maximum: number, location: string): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < 0
    || (value as number) > maximum
  ) {
    fail(location);
  }
  return value as number;
}

function hash(value: unknown, location: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(location);
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  location: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(location);
  return value as T;
}

function array(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) fail(location);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function parseAction(
  value: unknown,
  status: RecordedHardGateCellStatus,
  location: string,
): RecordedHardGateEvidenceActionView | null {
  if (value !== null) fail(`${location}.raw_slot_identity_withheld`);
  return null;
}

function parseCell(
  value: unknown,
  expectedCandidateId: RecordedHardGateCandidateId,
  location: string,
): RecordedHardGateCellView {
  const cell = record(value, location);
  exact(cell, [
    "candidate_id",
    "status",
    "applicability",
    "counts",
    "evidence_binding_hash",
    "evidence_action",
  ], location);
  if (cell.candidate_id !== expectedCandidateId) fail(`${location}.candidate_id`);
  const status = enumValue(
    cell.status,
    ["PASS", "CONFIRMED_FAIL", "REVIEW"] as const,
    `${location}.status`,
  );
  const applicability = enumValue(
    cell.applicability,
    ["APPLICABLE", "PARTIALLY_APPLICABLE", "NOT_APPLICABLE"] as const,
    `${location}.applicability`,
  );
  const counts = record(cell.counts, `${location}.counts`);
  exact(counts, [
    "total_runs",
    "pass_runs",
    "confirmed_fail_runs",
    "review_runs",
    "not_applicable_runs",
    "affected_cases",
  ], `${location}.counts`);
  if (counts.total_runs !== 24) fail(`${location}.counts.total_runs`);
  const passRuns = integer(counts.pass_runs, 24, `${location}.counts.pass_runs`);
  const confirmedFailRuns = integer(
    counts.confirmed_fail_runs,
    24,
    `${location}.counts.confirmed_fail_runs`,
  );
  const reviewRuns = integer(
    counts.review_runs,
    24,
    `${location}.counts.review_runs`,
  );
  const notApplicableRuns = integer(
    counts.not_applicable_runs,
    24,
    `${location}.counts.not_applicable_runs`,
  );
  const affectedCases = integer(
    counts.affected_cases,
    12,
    `${location}.counts.affected_cases`,
  );
  if (
    passRuns + confirmedFailRuns + reviewRuns + notApplicableRuns !== 24
  ) {
    fail(`${location}.counts`);
  }
  const applicableRuns = passRuns + confirmedFailRuns + reviewRuns;
  const expectedApplicability = applicableRuns === 24
    ? "APPLICABLE"
    : applicableRuns === 0
      ? "NOT_APPLICABLE"
      : "PARTIALLY_APPLICABLE";
  if (applicability !== expectedApplicability) fail(`${location}.applicability`);
  const expectedStatus = confirmedFailRuns > 0
    ? "CONFIRMED_FAIL"
    : reviewRuns > 0 || applicableRuns === 0
      ? "REVIEW"
      : "PASS";
  if (status !== expectedStatus) fail(`${location}.status`);
  if (
    (status === "PASS" && affectedCases !== 0)
    || (status !== "PASS" && affectedCases === 0)
  ) {
    fail(`${location}.counts.affected_cases`);
  }
  const evidenceAction = parseAction(
    cell.evidence_action,
    status,
    `${location}.evidence_action`,
  );
  return {
    candidateId: expectedCandidateId,
    status,
    applicability,
    counts: {
      totalRuns: 24,
      passRuns,
      confirmedFailRuns,
      reviewRuns,
      notApplicableRuns,
      affectedCases,
    },
    evidenceBindingHash: hash(
      cell.evidence_binding_hash,
      `${location}.evidence_binding_hash`,
    ),
    evidenceAction,
  };
}

function parseRow(
  value: unknown,
  expectedGateCode: RecordedHardGateCode,
  location: string,
): RecordedHardGateRowView {
  const row = record(value, location);
  exact(row, [
    "gate_code",
    "label",
    "decision_rule",
    "not_applicable_meaning",
    "candidates",
  ], location);
  if (row.gate_code !== expectedGateCode) fail(`${location}.gate_code`);
  const rawCandidates = array(row.candidates, `${location}.candidates`);
  if (rawCandidates.length !== 3) fail(`${location}.candidates`);
  return {
    gateCode: expectedGateCode,
    label: text(row.label, `${location}.label`),
    decisionRule: text(row.decision_rule, `${location}.decision_rule`),
    notApplicableMeaning: text(
      row.not_applicable_meaning,
      `${location}.not_applicable_meaning`,
    ),
    candidates: CANDIDATE_IDS.map((candidateId, index) => (
      parseCell(
        rawCandidates[index],
        candidateId,
        `${location}.candidates[${index}]`,
      )
    )) as [
      RecordedHardGateCellView,
      RecordedHardGateCellView,
      RecordedHardGateCellView,
    ],
  };
}

export function parseRecordedHardGateMatrixProjection(
  value: unknown,
): RecordedHardGateMatrixView {
  const projection = record(value, "recorded hard-gate matrix");
  exact(projection, [
    "schema_version",
    "synthetic",
    "source",
    "source_hash",
    "authority",
    "aggregation_order",
    "fatal_failures_are_not_averaged",
    "rows",
  ], "recorded hard-gate matrix");
  if (
    projection.schema_version !== "recorded-hard-gate-matrix-v1"
    || projection.synthetic !== true
    || projection.source !== "RECORDED_BENCHMARK"
    || projection.authority
      !== "SOURCE_RELOADED_DETERMINISTIC_SLOT_EVIDENCE"
    || projection.aggregation_order
      !== "CONFIRMED_FAIL_THEN_REVIEW_THEN_PASS"
    || projection.fatal_failures_are_not_averaged !== true
  ) {
    fail("recorded hard-gate matrix.authority");
  }
  const rawRows = array(projection.rows, "recorded hard-gate matrix.rows");
  if (rawRows.length !== 4) fail("recorded hard-gate matrix.rows");
  const rows = GATE_CODES.map((gateCode, index) => (
    parseRow(
      rawRows[index],
      gateCode,
      `recorded hard-gate matrix.rows[${index}]`,
    )
  )) as [
    RecordedHardGateRowView,
    RecordedHardGateRowView,
    RecordedHardGateRowView,
    RecordedHardGateRowView,
  ];
  return deepFreeze({
    sourceHash: hash(
      projection.source_hash,
      "recorded hard-gate matrix.source_hash",
    ),
    authority: "SOURCE_RELOADED_DETERMINISTIC_SLOT_EVIDENCE",
    aggregationOrder: "CONFIRMED_FAIL_THEN_REVIEW_THEN_PASS",
    fatalFailuresAreNotAveraged: true,
    rows,
  });
}

import {
  assertMatchingCaseAndOracle,
  parseEvaluationCase,
  parseEvaluationCases,
  parseEvaluationOrder,
  parseEvaluationOracle,
  type EvaluationCase,
  type EvaluationOracle,
  type EvaluationOrder,
} from "../../contracts/evaluationCase";

export type HiddenBenchmarkCase = EvaluationCase & {
  dataset_split: "HIDDEN_BENCHMARK";
};

export type RegressionCanaryCase = EvaluationCase & {
  dataset_split: "REGRESSION_CANARY";
};

export interface HiddenBenchmarkData {
  cases: HiddenBenchmarkCase[];
  oracles: EvaluationOracle[];
}

export interface RegressionCanaryData {
  cases: RegressionCanaryCase[];
  oracles: EvaluationOracle[];
}

export interface RegressionAccessCandidateResult {
  candidate_id: "A" | "B" | "C";
  order_access_channel: "RUNNER_SNAPSHOT" | "READ_ONLY_TOOL";
  status: "SUCCESS" | "MISMATCH" | "NOT_REQUIRED";
  result_code: "OK" | "ORDER_RESULT_MISMATCH" | "NOT_REQUIRED";
  candidate_payload_order_id: string | null;
}

export interface RegressionAccessInjector {
  synthetic: true;
  case_id: string;
  injector_mode: "PASS_THROUGH" | "NOT_REQUIRED" | "RETURN_DIFFERENT_ORDER";
  requested_order_id: string | null;
  returned_order: EvaluationOrder | null;
  candidate_results: [
    RegressionAccessCandidateResult,
    RegressionAccessCandidateResult,
    RegressionAccessCandidateResult,
  ];
}

function readJsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label}은(는) JSON 객체여야 합니다.`);
  }
  return value as Record<string, unknown>;
}

function assertExactJsonKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label}의 exact key 계약이 일치하지 않습니다.`);
  }
}

function readEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TypeError(`${label}에 허용하지 않은 값이 있습니다.`);
  }
  return value as T;
}

function readNullableIdentifierValue(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9._:/-]+$/.test(value)) {
    throw new TypeError(`${label}은(는) 식별자 또는 null이어야 합니다.`);
  }
  return value;
}

export function parseRegressionAccessInjectors(input: unknown): RegressionAccessInjector[] {
  if (!Array.isArray(input)) {
    throw new TypeError("regression access injectors는 배열이어야 합니다.");
  }
  const injectors = input.map((item, index): RegressionAccessInjector => {
    const label = `regression access injectors[${index}]`;
    const record = readJsonRecord(item, label);
    assertExactJsonKeys(record, [
      "synthetic",
      "case_id",
      "injector_mode",
      "requested_order_id",
      "returned_order",
      "candidate_results",
    ], label);
    if (record.synthetic !== true) {
      throw new TypeError(`${label}.synthetic은 true여야 합니다.`);
    }
    const caseId = readNullableIdentifierValue(record.case_id, `${label}.case_id`);
    if (caseId === null || !/^R-\d{3}$/.test(caseId)) {
      throw new TypeError(`${label}.case_id는 R-001 형태여야 합니다.`);
    }
    const injectorMode = readEnumValue(
      record.injector_mode,
      ["PASS_THROUGH", "NOT_REQUIRED", "RETURN_DIFFERENT_ORDER"] as const,
      `${label}.injector_mode`,
    );
    const requestedOrderId = readNullableIdentifierValue(
      record.requested_order_id,
      `${label}.requested_order_id`,
    );
    const returnedOrder = record.returned_order === null
      ? null
      : parseEvaluationOrder(record.returned_order);
    if (!Array.isArray(record.candidate_results) || record.candidate_results.length !== 3) {
      throw new TypeError(`${label}.candidate_results에는 A, B, C가 필요합니다.`);
    }
    const candidateResults = record.candidate_results.map((result, resultIndex) => {
      const resultLabel = `${label}.candidate_results[${resultIndex}]`;
      const resultRecord = readJsonRecord(result, resultLabel);
      assertExactJsonKeys(resultRecord, [
        "candidate_id",
        "order_access_channel",
        "status",
        "result_code",
        "candidate_payload_order_id",
      ], resultLabel);
      return {
        candidate_id: readEnumValue(
          resultRecord.candidate_id,
          ["A", "B", "C"] as const,
          `${resultLabel}.candidate_id`,
        ),
        order_access_channel: readEnumValue(
          resultRecord.order_access_channel,
          ["RUNNER_SNAPSHOT", "READ_ONLY_TOOL"] as const,
          `${resultLabel}.order_access_channel`,
        ),
        status: readEnumValue(
          resultRecord.status,
          ["SUCCESS", "MISMATCH", "NOT_REQUIRED"] as const,
          `${resultLabel}.status`,
        ),
        result_code: readEnumValue(
          resultRecord.result_code,
          ["OK", "ORDER_RESULT_MISMATCH", "NOT_REQUIRED"] as const,
          `${resultLabel}.result_code`,
        ),
        candidate_payload_order_id: readNullableIdentifierValue(
          resultRecord.candidate_payload_order_id,
          `${resultLabel}.candidate_payload_order_id`,
        ),
      };
    }) as RegressionAccessInjector["candidate_results"];
    if (candidateResults.map((result) => result.candidate_id).join(",") !== "A,B,C") {
      throw new TypeError(`${label}.candidate_results는 A, B, C 순서여야 합니다.`);
    }
    if (
      candidateResults[0].order_access_channel !== "RUNNER_SNAPSHOT"
      || candidateResults[1].order_access_channel !== "RUNNER_SNAPSHOT"
      || candidateResults[2].order_access_channel !== "READ_ONLY_TOOL"
    ) {
      throw new TypeError(`${label}.candidate_results 접근 채널이 후보 계약과 다릅니다.`);
    }
    const expectedByMode = {
      PASS_THROUGH: { status: "SUCCESS", resultCode: "OK" },
      NOT_REQUIRED: { status: "NOT_REQUIRED", resultCode: "NOT_REQUIRED" },
      RETURN_DIFFERENT_ORDER: { status: "MISMATCH", resultCode: "ORDER_RESULT_MISMATCH" },
    } as const;
    const expected = expectedByMode[injectorMode];
    if (candidateResults.some(
      (result) => result.status !== expected.status || result.result_code !== expected.resultCode,
    )) {
      throw new TypeError(`${label}.candidate_results가 injector_mode와 일치하지 않습니다.`);
    }
    if (injectorMode === "PASS_THROUGH") {
      if (
        requestedOrderId === null
        || returnedOrder !== null
        || candidateResults.some((result) => result.candidate_payload_order_id !== requestedOrderId)
      ) {
        throw new TypeError(`${label} PASS_THROUGH 불변식이 일치하지 않습니다.`);
      }
    } else if (injectorMode === "NOT_REQUIRED") {
      if (
        requestedOrderId !== null
        || returnedOrder !== null
        || candidateResults.some((result) => result.candidate_payload_order_id !== null)
      ) {
        throw new TypeError(`${label} NOT_REQUIRED 불변식이 일치하지 않습니다.`);
      }
    } else if (
      requestedOrderId === null
      || returnedOrder === null
      || returnedOrder.order_id === requestedOrderId
      || candidateResults.some((result) => result.candidate_payload_order_id !== null)
    ) {
      throw new TypeError(`${label} RETURN_DIFFERENT_ORDER 불변식이 일치하지 않습니다.`);
    }
    return {
      synthetic: true,
      case_id: caseId,
      injector_mode: injectorMode,
      requested_order_id: requestedOrderId,
      returned_order: returnedOrder,
      candidate_results: candidateResults,
    };
  });
  if (new Set(injectors.map((injector) => injector.case_id)).size !== injectors.length) {
    throw new TypeError("regression access injectors에 중복 case_id가 있습니다.");
  }
  return injectors;
}

function assertDatasetSplit<T extends EvaluationCase["dataset_split"]>(
  evaluationCase: EvaluationCase,
  expectedSplit: T,
  label: string,
): asserts evaluationCase is EvaluationCase & { dataset_split: T } {
  if (evaluationCase.dataset_split !== expectedSplit) {
    throw new TypeError(`${label}의 dataset_split은 ${expectedSplit}여야 합니다.`);
  }
}

export function parseHiddenBenchmarkCase(input: unknown): HiddenBenchmarkCase {
  const evaluationCase = parseEvaluationCase(input);
  assertDatasetSplit(evaluationCase, "HIDDEN_BENCHMARK", "숨겨진 Benchmark 사례");
  return evaluationCase;
}

export function parseHiddenBenchmarkCases(input: unknown): HiddenBenchmarkCase[] {
  const cases = parseEvaluationCases(input);
  return cases.map((evaluationCase) => {
    assertDatasetSplit(evaluationCase, "HIDDEN_BENCHMARK", "숨겨진 Benchmark 사례");
    return evaluationCase;
  });
}

export function parseRegressionCanaryCase(input: unknown): RegressionCanaryCase {
  const evaluationCase = parseEvaluationCase(input);
  assertDatasetSplit(evaluationCase, "REGRESSION_CANARY", "회귀 canary 사례");
  return evaluationCase;
}

export function parseRegressionCanaryCases(input: unknown): RegressionCanaryCase[] {
  const cases = parseEvaluationCases(input);
  return cases.map((evaluationCase) => {
    assertDatasetSplit(evaluationCase, "REGRESSION_CANARY", "회귀 canary 사례");
    return evaluationCase;
  });
}

export function validateHiddenBenchmarkOracleCoverage(
  cases: readonly HiddenBenchmarkCase[],
  oracleInputs: readonly unknown[],
): HiddenBenchmarkData {
  const oracles = oracleInputs.map(parseEvaluationOracle);
  const caseIds = new Set(cases.map((item) => item.case_id));
  const oracleIds = oracles.map((item) => item.case_id);
  if (new Set(oracleIds).size !== oracleIds.length) {
    throw new TypeError("숨겨진 Benchmark oracle에 중복 case_id가 있습니다.");
  }

  const missingOracleIds = cases
    .map((item) => item.case_id)
    .filter((caseId) => !oracleIds.includes(caseId));
  if (missingOracleIds.length > 0) {
    throw new TypeError(`누락된 oracle이 있습니다: ${missingOracleIds.join(", ")}`);
  }

  const unknownOracleIds = oracleIds.filter((caseId) => !caseIds.has(caseId));
  if (unknownOracleIds.length > 0) {
    throw new TypeError(`사례에 대응하지 않는 oracle이 있습니다: ${unknownOracleIds.join(", ")}`);
  }

  for (const evaluationCase of cases) {
    const oracle = oracles.find((item) => item.case_id === evaluationCase.case_id);
    if (oracle === undefined) {
      throw new TypeError(`누락된 oracle이 있습니다: ${evaluationCase.case_id}`);
    }
    assertMatchingCaseAndOracle(evaluationCase, oracle);
  }

  return { cases: [...cases], oracles };
}

export function validateRegressionCanaryOracleCoverage(
  cases: readonly RegressionCanaryCase[],
  oracleInputs: readonly unknown[],
): RegressionCanaryData {
  const oracles = oracleInputs.map(parseEvaluationOracle);
  const caseIds = new Set(cases.map((item) => item.case_id));
  const oracleIds = oracles.map((item) => item.case_id);
  if (new Set(oracleIds).size !== oracleIds.length) {
    throw new TypeError("회귀 canary oracle에 중복 case_id가 있습니다.");
  }
  const missingOracleIds = cases
    .map((item) => item.case_id)
    .filter((caseId) => !oracleIds.includes(caseId));
  if (missingOracleIds.length > 0) {
    throw new TypeError(`누락된 canary oracle이 있습니다: ${missingOracleIds.join(", ")}`);
  }
  const unknownOracleIds = oracleIds.filter((caseId) => !caseIds.has(caseId));
  if (unknownOracleIds.length > 0) {
    throw new TypeError(`canary 사례에 대응하지 않는 oracle이 있습니다: ${unknownOracleIds.join(", ")}`);
  }
  for (const evaluationCase of cases) {
    const oracle = oracles.find((item) => item.case_id === evaluationCase.case_id);
    if (oracle === undefined) {
      throw new TypeError(`누락된 canary oracle이 있습니다: ${evaluationCase.case_id}`);
    }
    assertMatchingCaseAndOracle(evaluationCase, oracle);
  }
  return { cases: [...cases], oracles };
}

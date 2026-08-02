import benchmarkCasesFixture from "./cases.json";
import benchmarkChallengeFixture from "./challenge-benchmark-v1.json";
import benchmarkOraclesFixture from "./oracles.json";
import benchmarkOrdersFixture from "./orders.json";
import benchmarkPoliciesFixture from "./policies.json";
import publicCalibrationCaseFixture from "../calibration/case-c001.json";
import regressionAccessInjectorsFixture from "./regression-access-injectors.json";
import regressionCanariesFixture from "./regression-canaries.json";
import regressionOrdersFixture from "./regression-orders.json";
import {
  P0_CANDIDATE_COMPLEXITY_PROFILES,
  parseCandidateComplexityProfiles,
  type CandidateComplexityProfiles,
} from "../../contracts/candidateComplexity";
import {
  buildCandidateFacingCase,
  buildCandidateFacingPolicySection,
  parseEvaluationOrders,
  parseEvaluationOracles,
  parsePolicySections,
  type CandidateFacingCase,
  type CandidateFacingPolicySection,
  type EvaluationOracle,
  type EvaluationOrder,
} from "../../contracts/evaluationCase";
import { sha256CanonicalJson } from "../../runtime/canonicalJson";
import {
  parseHiddenBenchmarkCases,
  parseRegressionCanaryCases,
  parseRegressionAccessInjectors,
  validateHiddenBenchmarkOracleCoverage,
  validateRegressionCanaryOracleCoverage,
  type HiddenBenchmarkCase,
  type RegressionCanaryCase,
  type RegressionAccessInjector,
} from "./types";

export type BenchmarkCandidateId = "A" | "B" | "C";

interface CandidateEnvelope {
  candidate_id: BenchmarkCandidateId;
  architecture:
    | "SINGLE_LLM_INLINE_POLICY"
    | "LLM_RUNNER_RETRIEVAL"
    | "READ_ONLY_TOOL_AGENT";
  provider_call_limit: number;
  runner_retrieval_limit: number;
  read_only_tool_call_limit: number;
  policy_search_top_k: 6 | null;
  policy_access_mode: "INLINE_CORPUS" | "RETRIEVAL" | "READ_ONLY_TOOL";
  order_access_channel: "RUNNER_SNAPSHOT" | "READ_ONLY_TOOL";
}

export interface BenchmarkChallenge {
  synthetic: true;
  challenge_id: string;
  challenge_version: string;
  dataset_split: "HIDDEN_BENCHMARK";
  as_of: string;
  locale: "en-US";
  case_count: 12;
  case_ids: string[];
  policy_document_count: 12;
  policy_section_count: 32;
  candidate_ids: ["A", "B", "C"];
  repetitions_per_case: 2;
  expected_execution_count: 72;
  high_risk_case_ids: ["H-007", "H-010", "H-011", "H-012"];
  candidate_envelopes: [CandidateEnvelope, CandidateEnvelope, CandidateEnvelope];
  candidate_complexity_profiles: CandidateComplexityProfiles;
}

type JsonRecord = Record<string, unknown>;

function readRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  return value as JsonRecord;
}

function assertExactKeys(
  record: JsonRecord,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} has an invalid exact-key contract.`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
}

function parseCandidateEnvelope(value: unknown, index: number): CandidateEnvelope {
  const label = `candidate_envelopes[${index}]`;
  const record = readRecord(value, label);
  assertExactKeys(record, [
    "candidate_id",
    "architecture",
    "provider_call_limit",
    "runner_retrieval_limit",
    "read_only_tool_call_limit",
    "policy_search_top_k",
    "policy_access_mode",
    "order_access_channel",
  ], label);
  assertPositiveInteger(record.provider_call_limit, `${label}.provider_call_limit`);
  if (
    typeof record.runner_retrieval_limit !== "number"
    || !Number.isInteger(record.runner_retrieval_limit)
    || record.runner_retrieval_limit < 0
  ) {
    throw new TypeError(`${label}.runner_retrieval_limit must be a nonnegative integer.`);
  }
  if (
    typeof record.read_only_tool_call_limit !== "number"
    || !Number.isInteger(record.read_only_tool_call_limit)
    || record.read_only_tool_call_limit < 0
  ) {
    throw new TypeError(`${label}.read_only_tool_call_limit must be a nonnegative integer.`);
  }
  const candidateId = record.candidate_id;
  if (candidateId !== "A" && candidateId !== "B" && candidateId !== "C") {
    throw new TypeError(`${label}.candidate_id is invalid.`);
  }
  const expected = {
    A: {
      architecture: "SINGLE_LLM_INLINE_POLICY",
      runner_retrieval_limit: 0,
      read_only_tool_call_limit: 0,
      provider_call_limit: 1,
      policy_search_top_k: null,
      policy_access_mode: "INLINE_CORPUS",
      order_access_channel: "RUNNER_SNAPSHOT",
    },
    B: {
      architecture: "LLM_RUNNER_RETRIEVAL",
      runner_retrieval_limit: 1,
      read_only_tool_call_limit: 0,
      provider_call_limit: 1,
      policy_search_top_k: 6,
      policy_access_mode: "RETRIEVAL",
      order_access_channel: "RUNNER_SNAPSHOT",
    },
    C: {
      architecture: "READ_ONLY_TOOL_AGENT",
      runner_retrieval_limit: 0,
      read_only_tool_call_limit: 2,
      provider_call_limit: 2,
      policy_search_top_k: 6,
      policy_access_mode: "READ_ONLY_TOOL",
      order_access_channel: "READ_ONLY_TOOL",
    },
  } as const;
  const locked = expected[candidateId];
  for (const [key, lockedValue] of Object.entries(locked)) {
    if (record[key] !== lockedValue) {
      throw new TypeError(`${label}.${key} does not match the locked candidate envelope.`);
    }
  }
  return {
    candidate_id: candidateId,
    architecture: record.architecture as CandidateEnvelope["architecture"],
    provider_call_limit: record.provider_call_limit,
    runner_retrieval_limit: record.runner_retrieval_limit,
    read_only_tool_call_limit: record.read_only_tool_call_limit,
    policy_search_top_k: record.policy_search_top_k as 6 | null,
    policy_access_mode: record.policy_access_mode as CandidateEnvelope["policy_access_mode"],
    order_access_channel: record.order_access_channel as CandidateEnvelope["order_access_channel"],
  };
}

export function parseBenchmarkChallenge(value: unknown): BenchmarkChallenge {
  const record = readRecord(value, "benchmark challenge");
  assertExactKeys(record, [
    "synthetic",
    "challenge_id",
    "challenge_version",
    "dataset_split",
    "as_of",
    "locale",
    "case_count",
    "case_ids",
    "policy_document_count",
    "policy_section_count",
    "candidate_ids",
    "repetitions_per_case",
    "expected_execution_count",
    "high_risk_case_ids",
    "candidate_envelopes",
    "candidate_complexity_profiles",
  ], "benchmark challenge");
  if (
    record.synthetic !== true
    || record.challenge_id !== "monomarket-support-benchmark"
    || record.challenge_version !== "benchmark-v1"
    || record.dataset_split !== "HIDDEN_BENCHMARK"
    || record.as_of !== "2026-07-17T12:00:00Z"
    || record.locale !== "en-US"
    || record.case_count !== 12
    || record.policy_document_count !== 12
    || record.policy_section_count !== 32
    || record.repetitions_per_case !== 2
    || record.expected_execution_count !== 72
  ) {
    throw new TypeError("benchmark challenge does not match the locked P0 contract.");
  }
  if (!Array.isArray(record.case_ids) || !Array.isArray(record.candidate_ids)) {
    throw new TypeError("benchmark challenge case_ids and candidate_ids must be arrays.");
  }
  if (!Array.isArray(record.high_risk_case_ids) || !Array.isArray(record.candidate_envelopes)) {
    throw new TypeError("benchmark challenge high-risk IDs and envelopes must be arrays.");
  }
  const expectedCaseIds = Array.from(
    { length: 12 },
    (_, index) => `H-${String(index + 1).padStart(3, "0")}`,
  );
  if (JSON.stringify(record.case_ids) !== JSON.stringify(expectedCaseIds)) {
    throw new TypeError("benchmark challenge case IDs are not H-001 through H-012.");
  }
  if (JSON.stringify(record.candidate_ids) !== JSON.stringify(["A", "B", "C"])) {
    throw new TypeError("benchmark challenge candidate IDs must be A, B, C.");
  }
  const expectedHighRiskIds = ["H-007", "H-010", "H-011", "H-012"];
  if (JSON.stringify(record.high_risk_case_ids) !== JSON.stringify(expectedHighRiskIds)) {
    throw new TypeError("benchmark challenge high-risk IDs do not match the locked set.");
  }
  const envelopes = record.candidate_envelopes.map(parseCandidateEnvelope);
  if (envelopes.map((item) => item.candidate_id).join(",") !== "A,B,C") {
    throw new TypeError("candidate envelopes must be ordered A, B, C.");
  }
  const complexityProfiles = parseCandidateComplexityProfiles(
    record.candidate_complexity_profiles,
    "benchmark challenge.candidate_complexity_profiles",
  );
  if (
    sha256CanonicalJson(complexityProfiles)
    !== sha256CanonicalJson(P0_CANDIDATE_COMPLEXITY_PROFILES)
  ) {
    throw new TypeError(
      "benchmark challenge complexity profiles do not match the locked P0 values.",
    );
  }
  return {
    synthetic: true,
    challenge_id: record.challenge_id,
    challenge_version: record.challenge_version,
    dataset_split: "HIDDEN_BENCHMARK",
    as_of: record.as_of,
    locale: "en-US",
    case_count: 12,
    case_ids: [...record.case_ids] as string[],
    policy_document_count: 12,
    policy_section_count: 32,
    candidate_ids: ["A", "B", "C"],
    repetitions_per_case: 2,
    expected_execution_count: 72,
    high_risk_case_ids: ["H-007", "H-010", "H-011", "H-012"],
    candidate_envelopes: envelopes as BenchmarkChallenge["candidate_envelopes"],
    candidate_complexity_profiles: complexityProfiles,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function lockedSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

const parsedChallenge = parseBenchmarkChallenge(benchmarkChallengeFixture);
const parsedCases = parseHiddenBenchmarkCases(benchmarkCasesFixture);
const parsedOracles = parseEvaluationOracles(benchmarkOraclesFixture);
const parsedPolicies = parsePolicySections(benchmarkPoliciesFixture);
const parsedOrders = parseEvaluationOrders(benchmarkOrdersFixture);
const parsedRegressionOrders = parseEvaluationOrders(regressionOrdersFixture);
const parsedRegressionAccessInjectors = parseRegressionAccessInjectors(
  regressionAccessInjectorsFixture,
);
const canaryRecord = readRecord(regressionCanariesFixture, "regression canary bundle");
assertExactKeys(
  canaryRecord,
  ["synthetic", "dataset_split", "selection_use", "cases", "oracles"],
  "regression canary bundle",
);
if (
  canaryRecord.synthetic !== true
  || canaryRecord.dataset_split !== "REGRESSION_CANARY"
  || canaryRecord.selection_use !== "EXCLUDED_FROM_SELECTION"
) {
  throw new TypeError("regression canary bundle metadata is invalid.");
}
const parsedCanaryCases = parseRegressionCanaryCases(canaryRecord.cases);
if (!Array.isArray(canaryRecord.oracles)) {
  throw new TypeError("regression canary oracles must be an array.");
}
const parsedCanaryOracles = parseEvaluationOracles(canaryRecord.oracles);

export interface PublicCalibrationSemanticDescriptor {
  case_id: "C-001";
  semantic_template_id: "TPL-ORDER-CANCELLATION-AFTER-SHIPMENT";
  case_family: "ORDER_CANCELLATION_AFTER_SHIPMENT";
}

if (
  publicCalibrationCaseFixture.case_id !== "C-001"
  || publicCalibrationCaseFixture.dataset_split !== "PUBLIC_CALIBRATION"
  || publicCalibrationCaseFixture.case_family !== "ORDER_CANCELLATION_AFTER_SHIPMENT"
) {
  throw new TypeError("public C-001 semantic descriptor does not match the locked calibration case.");
}

export const PUBLIC_CALIBRATION_SEMANTIC_DESCRIPTORS = lockedSnapshot([
  {
    case_id: "C-001",
    semantic_template_id: "TPL-ORDER-CANCELLATION-AFTER-SHIPMENT",
    case_family: publicCalibrationCaseFixture.case_family,
  },
] satisfies PublicCalibrationSemanticDescriptor[]);

interface SemanticCaseDescriptor {
  case_id: string;
  semantic_template_id: string;
  case_family: string;
}

function normalizeSemanticDescriptor(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").trim();
}

export function assertCrossSplitSemanticTemplateIsolation(
  options: {
    publicDescriptors?: readonly SemanticCaseDescriptor[];
    hiddenCases?: readonly SemanticCaseDescriptor[];
    canaryCases?: readonly SemanticCaseDescriptor[];
  } = {},
): void {
  const splits = [
    {
      name: "PUBLIC_CALIBRATION",
      cases: options.publicDescriptors ?? PUBLIC_CALIBRATION_SEMANTIC_DESCRIPTORS,
    },
    { name: "HIDDEN_BENCHMARK", cases: options.hiddenCases ?? parsedCases },
    { name: "REGRESSION_CANARY", cases: options.canaryCases ?? parsedCanaryCases },
  ] as const;
  for (let leftIndex = 0; leftIndex < splits.length; leftIndex += 1) {
    const left = splits[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < splits.length; rightIndex += 1) {
      const right = splits[rightIndex];
      const rightTemplates = new Set(right.cases.map(
        (item) => normalizeSemanticDescriptor(item.semantic_template_id),
      ));
      const rightFamilies = new Set(right.cases.map(
        (item) => normalizeSemanticDescriptor(item.case_family),
      ));
      const duplicateTemplate = left.cases.find(
        (item) => rightTemplates.has(normalizeSemanticDescriptor(item.semantic_template_id)),
      );
      if (duplicateTemplate !== undefined) {
        throw new TypeError(
          `cross-split semantic_template_id overlap: ${left.name}/${right.name}/${duplicateTemplate.semantic_template_id}`,
        );
      }
      const duplicateFamily = left.cases.find(
        (item) => rightFamilies.has(normalizeSemanticDescriptor(item.case_family)),
      );
      if (duplicateFamily !== undefined) {
        throw new TypeError(
          `cross-split case_family overlap: ${left.name}/${right.name}/${duplicateFamily.case_family}`,
        );
      }
    }
  }
}

validateHiddenBenchmarkOracleCoverage(parsedCases, parsedOracles);
validateRegressionCanaryOracleCoverage(parsedCanaryCases, parsedCanaryOracles);
assertCrossSplitSemanticTemplateIsolation();

const expectedHiddenIds = parsedChallenge.case_ids;
if (parsedCases.map((item) => item.case_id).join(",") !== expectedHiddenIds.join(",")) {
  throw new TypeError("hidden case order does not match the challenge manifest.");
}
const expectedCanaryIds = Array.from(
  { length: 6 },
  (_, index) => `R-${String(index + 1).padStart(3, "0")}`,
);
if (parsedCanaryCases.map((item) => item.case_id).join(",") !== expectedCanaryIds.join(",")) {
  throw new TypeError("regression canary IDs are not R-001 through R-006.");
}
if (
  parsedRegressionAccessInjectors.map((item) => item.case_id).join(",")
  !== expectedCanaryIds.join(",")
) {
  throw new TypeError("regression access injector IDs do not match R-001 through R-006.");
}

const policyDocumentIds = [...new Set(parsedPolicies.map((policy) => policy.source_id))];
if (policyDocumentIds.length !== 12 || parsedPolicies.length !== 32) {
  throw new TypeError("policy corpus must contain exactly 12 documents and 32 sections.");
}
const expectedSectionClassCounts = {
  APPLICABLE_ACTIVE: 10,
  UNRELATED_ACTIVE: 10,
  RETIRED_OR_FUTURE: 6,
  SCOPE_MISMATCH: 6,
};
for (const [sectionClass, expectedCount] of Object.entries(expectedSectionClassCounts)) {
  const actualCount = parsedPolicies.filter(
    (policy) => policy.section_class === sectionClass,
  ).length;
  if (actualCount !== expectedCount) {
    throw new TypeError(`${sectionClass} must contain exactly ${expectedCount} sections.`);
  }
}
const policyByCitation = new Map(parsedPolicies.map((policy) => [
  `${policy.source_id}\u0000${policy.section_id}`,
  policy,
]));
for (const oracle of [...parsedOracles, ...parsedCanaryOracles]) {
  for (const citation of oracle.required_citations) {
    const policy = policyByCitation.get(`${citation.source_id}\u0000${citation.section_id}`);
    if (
      policy === undefined
      || policy.section_class !== "APPLICABLE_ACTIVE"
      || policy.lifecycle_status !== "ACTIVE"
    ) {
      throw new TypeError(`${oracle.case_id} has a required citation outside active applicable policy.`);
    }
  }
}

const orderById = new Map(parsedOrders.map((order) => [order.order_id, order]));
if (parsedOrders.length !== 11) {
  throw new TypeError("hidden benchmark must contain exactly 11 authoritative order records.");
}

export function validateHiddenBenchmarkAccessInvariants(
  cases: readonly HiddenBenchmarkCase[],
  orders: readonly EvaluationOrder[],
): void {
  const authoritativeOrderById = new Map(orders.map((order) => [order.order_id, order]));
  for (const evaluationCase of cases) {
    if (evaluationCase.required_access_subject === "POLICY_ONLY") {
      if (
        evaluationCase.data_access_scenario_id !== "POLICY_ONLY"
        || evaluationCase.order_id !== null
        || evaluationCase.order_context_authorized !== false
      ) {
        throw new TypeError(
          `${evaluationCase.case_id} POLICY_ONLY case requires null order and authorized=false.`,
        );
      }
      continue;
    }
    if (evaluationCase.data_access_scenario_id === "POLICY_ONLY") {
      throw new TypeError(
        `${evaluationCase.case_id} POLICY_ONLY scenario requires POLICY_ONLY access subject.`,
      );
    }
    const order = evaluationCase.order_id === null
      ? undefined
      : authoritativeOrderById.get(evaluationCase.order_id);
    if (order === undefined) {
      throw new TypeError(`${evaluationCase.case_id} is missing its authoritative order record.`);
    }
    if (evaluationCase.data_access_scenario_id === "ORDER_SUCCESS") {
      if (evaluationCase.order_context_authorized !== true) {
        throw new TypeError(`${evaluationCase.case_id} success case requires authorized=true.`);
      }
      if (order.customer_id !== evaluationCase.authenticated_customer_id) {
        throw new TypeError(`${evaluationCase.case_id} success case has an ownership mismatch.`);
      }
    }
    if (evaluationCase.data_access_scenario_id === "ORDER_OWNERSHIP_DENIED") {
      if (evaluationCase.order_context_authorized !== false) {
        throw new TypeError(`${evaluationCase.case_id} ownership denial requires authorized=false.`);
      }
      if (order.customer_id === evaluationCase.authenticated_customer_id) {
        throw new TypeError(`${evaluationCase.case_id} denial case must use a foreign-owned order.`);
      }
    }
    if (
      evaluationCase.data_access_scenario_id === "ORDER_TIMEOUT"
      && evaluationCase.order_context_authorized !== true
    ) {
      throw new TypeError(`${evaluationCase.case_id} timeout case requires authorized=true.`);
    }
  }
}

validateHiddenBenchmarkAccessInvariants(parsedCases, parsedOrders);

const expectedRegressionOrderIds = ["ORD-R001", "ORD-R002", "ORD-R004", "ORD-R005", "ORD-R006"];
if (parsedRegressionOrders.map((order) => order.order_id).join(",") !== expectedRegressionOrderIds.join(",")) {
  throw new TypeError("regression authoritative orders do not match the locked R-case set.");
}
const regressionOrderById = new Map(parsedRegressionOrders.map(
  (order) => [order.order_id, order],
));

export function validateRegressionCanaryAccessInvariants(
  cases: readonly RegressionCanaryCase[],
  oracles: readonly EvaluationOracle[],
  orders: readonly EvaluationOrder[],
  injectors: readonly RegressionAccessInjector[],
): void {
  const regressionOrderById = new Map(orders.map((order) => [order.order_id, order]));
  for (const evaluationCase of cases) {
    const oracle = oracles.find((item) => item.case_id === evaluationCase.case_id);
    const injector = injectors.find((item) => item.case_id === evaluationCase.case_id);
    if (oracle === undefined || injector === undefined) {
      throw new TypeError(`${evaluationCase.case_id} is missing regression oracle or access injector.`);
    }
    const expectedStatuses = oracle.candidate_access_expectations.map(
      (expectation) => expectation.expected_order_access_status,
    );
    if (injector.candidate_results.some(
      (result, index) => result.status !== expectedStatuses[index],
    )) {
      throw new TypeError(`${evaluationCase.case_id} injector status does not match its oracle.`);
    }
    if (evaluationCase.required_access_subject === "POLICY_ONLY") {
      if (
        evaluationCase.data_access_scenario_id !== "POLICY_ONLY"
        || evaluationCase.order_id !== null
        || evaluationCase.order_context_authorized !== false
        || injector.injector_mode !== "NOT_REQUIRED"
        || injector.requested_order_id !== null
      ) {
        throw new TypeError(
          `${evaluationCase.case_id} POLICY_ONLY regression access requires null order and authorized=false.`,
        );
      }
      continue;
    }
    const order = evaluationCase.order_id === null
      ? undefined
      : regressionOrderById.get(evaluationCase.order_id);
    if (
      order === undefined
      || injector.requested_order_id !== evaluationCase.order_id
    ) {
      throw new TypeError(`${evaluationCase.case_id} regression authoritative order is missing.`);
    }
    if (
      evaluationCase.data_access_scenario_id === "ORDER_SUCCESS"
      || evaluationCase.data_access_scenario_id === "ORDER_RESULT_MISMATCH"
    ) {
      if (evaluationCase.order_context_authorized !== true) {
        throw new TypeError(
          `${evaluationCase.case_id} authorized order context must be true for the requested order.`,
        );
      }
      if (order.customer_id !== evaluationCase.authenticated_customer_id) {
        throw new TypeError(
          `${evaluationCase.case_id} authoritative order ownership does not match the authenticated customer.`,
        );
      }
    }
    if (
      evaluationCase.data_access_scenario_id === "ORDER_RESULT_MISMATCH"
      && (
        injector.injector_mode !== "RETURN_DIFFERENT_ORDER"
        || injector.returned_order === null
        || injector.returned_order.order_id === evaluationCase.order_id
      )
    ) {
      throw new TypeError(`${evaluationCase.case_id} mismatch injector is invalid.`);
    }
    if (
      evaluationCase.data_access_scenario_id === "ORDER_SUCCESS"
      && injector.injector_mode !== "PASS_THROUGH"
    ) {
      throw new TypeError(`${evaluationCase.case_id} success injector must pass through.`);
    }
  }
}

validateRegressionCanaryAccessInvariants(
  parsedCanaryCases,
  parsedCanaryOracles,
  parsedRegressionOrders,
  parsedRegressionAccessInjectors,
);

export const BENCHMARK_CHALLENGE = lockedSnapshot(parsedChallenge);
export const BENCHMARK_CASES = lockedSnapshot(parsedCases);
export const BENCHMARK_ORACLES = lockedSnapshot(parsedOracles);
export const BENCHMARK_POLICIES = lockedSnapshot(parsedPolicies);
export const BENCHMARK_ORDERS = lockedSnapshot(parsedOrders);
export const REGRESSION_CANARIES = lockedSnapshot(parsedCanaryCases);
export const REGRESSION_CANARY_ORACLES = lockedSnapshot(parsedCanaryOracles);
export const REGRESSION_ORDERS = lockedSnapshot(parsedRegressionOrders);
export const REGRESSION_ACCESS_INJECTORS = lockedSnapshot(parsedRegressionAccessInjectors);
export const BENCHMARK_POLICY_DOCUMENT_IDS = lockedSnapshot(policyDocumentIds);
export const HIGH_RISK_CASE_IDS = lockedSnapshot(parsedChallenge.high_risk_case_ids);

export const BENCHMARK_SOURCE_DATA_HASH = sha256CanonicalJson({
  challenge: BENCHMARK_CHALLENGE,
  cases: BENCHMARK_CASES,
  oracles: BENCHMARK_ORACLES,
  policies: BENCHMARK_POLICIES,
  orders: BENCHMARK_ORDERS,
  regression_canaries: {
    cases: REGRESSION_CANARIES,
    oracles: REGRESSION_CANARY_ORACLES,
    orders: REGRESSION_ORDERS,
    access_injectors: REGRESSION_ACCESS_INJECTORS,
  },
});
export const BENCHMARK_DATASET_HASH = sha256CanonicalJson({
  cases: BENCHMARK_CASES,
  oracles: BENCHMARK_ORACLES,
});
export const BENCHMARK_ORACLE_HASH = sha256CanonicalJson(BENCHMARK_ORACLES);
export const BENCHMARK_POLICY_CORPUS_HASH = sha256CanonicalJson(BENCHMARK_POLICIES);
export const REGRESSION_CANARY_HASH = sha256CanonicalJson({
  cases: REGRESSION_CANARIES,
  oracles: REGRESSION_CANARY_ORACLES,
  orders: REGRESSION_ORDERS,
  access_injectors: REGRESSION_ACCESS_INJECTORS,
});

export interface CandidateFacingOrder {
  order_id: string;
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
  items: Array<Omit<EvaluationOrder["items"][number], "synthetic">>;
}

function buildCandidateFacingOrder(order: EvaluationOrder): CandidateFacingOrder {
  return {
    order_id: order.order_id,
    status: order.status,
    fulfillment_locked: order.fulfillment_locked,
    placed_at: order.placed_at,
    shipped_at: order.shipped_at,
    delivered_at: order.delivered_at,
    promised_delivery_date: order.promised_delivery_date,
    total_amount: order.total_amount,
    currency: order.currency,
    carrier: order.carrier,
    tracking_number: order.tracking_number,
    refund_status: order.refund_status,
    refund_approved_at: order.refund_approved_at,
    items: order.items.map(({ synthetic: _synthetic, ...item }) => structuredClone(item)),
  };
}

type CandidatePolicyAccess =
  | {
    mode: "INLINE_CORPUS";
    corpus_hash: string;
    sections: CandidateFacingPolicySection[];
  }
  | {
    mode: "RETRIEVAL";
    corpus_hash: string;
    locked_as_of: string;
    top_k: 6;
  }
  | {
    mode: "READ_ONLY_TOOL";
    corpus_hash: string;
    locked_as_of: string;
    tool_name: "search_policy";
    top_k: 6;
  };

type CandidateOrderAccess =
  | {
    channel: "RUNNER_SNAPSHOT";
    status: "SUCCESS" | "DENIED" | "TIMEOUT" | "MISMATCH" | "NOT_REQUIRED";
    result_code:
      | "OK"
      | "ORDER_OWNERSHIP_MISMATCH"
      | "TOOL_TIMEOUT"
      | "ORDER_RESULT_MISMATCH"
      | "NOT_REQUIRED";
    data: CandidateFacingOrder | null;
  }
  | {
    channel: "READ_ONLY_TOOL";
    allowed_tools: Array<"search_policy" | "get_order">;
  };

export interface BenchmarkCandidateInput {
  candidate_id: BenchmarkCandidateId;
  case: CandidateFacingCase;
  order_access: CandidateOrderAccess;
  policy_access: CandidatePolicyAccess;
}

function buildSnapshotOrderAccess(
  evaluationCase: (typeof BENCHMARK_CASES)[number],
  status: "SUCCESS" | "DENIED" | "TIMEOUT" | "MISMATCH" | "NOT_REQUIRED",
): Extract<CandidateOrderAccess, { channel: "RUNNER_SNAPSHOT" }> {
  const resultCode = {
    SUCCESS: "OK",
    DENIED: "ORDER_OWNERSHIP_MISMATCH",
    TIMEOUT: "TOOL_TIMEOUT",
    MISMATCH: "ORDER_RESULT_MISMATCH",
    NOT_REQUIRED: "NOT_REQUIRED",
  } as const;
  const order = evaluationCase.order_id === null ? undefined : orderById.get(evaluationCase.order_id);
  return {
    channel: "RUNNER_SNAPSHOT",
    status,
    result_code: resultCode[status],
    data: status === "SUCCESS" && order !== undefined ? buildCandidateFacingOrder(order) : null,
  };
}

export function buildBenchmarkCandidateInput(
  candidateId: BenchmarkCandidateId,
  caseId: string,
): BenchmarkCandidateInput {
  const evaluationCase = BENCHMARK_CASES.find((item) => item.case_id === caseId);
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === caseId);
  if (evaluationCase === undefined || oracle === undefined) {
    throw new TypeError(`Unknown hidden benchmark case: ${caseId}`);
  }
  const expectation = oracle.candidate_access_expectations.find(
    (item) => item.candidate_id === candidateId,
  );
  if (expectation === undefined) {
    throw new TypeError(`Missing Candidate ${candidateId} access expectation for ${caseId}.`);
  }
  const candidatePolicies = (): CandidateFacingPolicySection[] => BENCHMARK_POLICIES.map(
    buildCandidateFacingPolicySection,
  );
  const policyAccess: CandidatePolicyAccess = candidateId === "A"
    ? {
      mode: "INLINE_CORPUS",
      corpus_hash: BENCHMARK_POLICY_CORPUS_HASH,
      sections: candidatePolicies(),
    }
    : candidateId === "B"
      ? {
        mode: "RETRIEVAL",
        corpus_hash: BENCHMARK_POLICY_CORPUS_HASH,
        locked_as_of: evaluationCase.as_of,
        top_k: 6,
      }
      : {
        mode: "READ_ONLY_TOOL",
        corpus_hash: BENCHMARK_POLICY_CORPUS_HASH,
        locked_as_of: evaluationCase.as_of,
        tool_name: "search_policy",
        top_k: 6,
      };
  const orderAccess: CandidateOrderAccess = candidateId === "C"
    ? {
      channel: "READ_ONLY_TOOL",
      allowed_tools: evaluationCase.required_access_subject === "POLICY_ONLY"
        ? ["search_policy"]
        : ["search_policy", "get_order"],
    }
    : buildSnapshotOrderAccess(evaluationCase, expectation.expected_order_access_status);
  return lockedSnapshot({
    candidate_id: candidateId,
    case: buildCandidateFacingCase(evaluationCase),
    order_access: orderAccess,
    policy_access: policyAccess,
  });
}

export function assertCandidateProjectionDoesNotLeakEvaluatorMetadata(): void {
  const forbiddenKeys = [
    "semantic_template_id",
    "data_access_scenario_id",
    "required_access_subject",
    "case_family",
    "section_class",
    "candidate_access_expectations",
    "expected_action_code",
    "required_reply_claims",
    "forbidden_reply_literals",
  ];
  for (const evaluationCase of [...BENCHMARK_CASES, ...REGRESSION_CANARIES]) {
    const serializedCase = JSON.stringify(buildCandidateFacingCase(evaluationCase));
    if (forbiddenKeys.some((key) => serializedCase.includes(key))) {
      throw new Error(`${evaluationCase.case_id} candidate-facing case leaks evaluator-only data.`);
    }
  }
  for (const candidateId of ["A", "B", "C"] as const) {
    for (const evaluationCase of BENCHMARK_CASES) {
      const serializedInput = JSON.stringify(
        buildBenchmarkCandidateInput(candidateId, evaluationCase.case_id),
      );
      if (forbiddenKeys.some((key) => serializedInput.includes(key))) {
        throw new Error(`${candidateId}/${evaluationCase.case_id} input leaks evaluator-only data.`);
      }
      if (serializedInput.includes(BENCHMARK_ORACLE_HASH)) {
        throw new Error(`${candidateId}/${evaluationCase.case_id} input leaks the oracle hash.`);
      }
    }
  }
}

export function assertNoSemanticTemplateLeak(): void {
  assertCandidateProjectionDoesNotLeakEvaluatorMetadata();
}

export type BenchmarkGetOrderToolResult =
  | { ok: true; result_code: "OK"; data: CandidateFacingOrder }
  | {
    ok: false;
    result_code: "ORDER_OWNERSHIP_MISMATCH" | "TOOL_TIMEOUT";
    data: null;
  };

export function buildBenchmarkGetOrderToolResult(caseId: string): BenchmarkGetOrderToolResult {
  const evaluationCase = BENCHMARK_CASES.find((item) => item.case_id === caseId);
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === caseId);
  if (evaluationCase === undefined || oracle === undefined) {
    throw new TypeError(`Unknown hidden benchmark case: ${caseId}`);
  }
  if (evaluationCase.required_access_subject !== "ORDER" || evaluationCase.order_id === null) {
    throw new TypeError(`${caseId} does not allow get_order.`);
  }
  const cExpectation = oracle.candidate_access_expectations[2];
  if (cExpectation.expected_order_access_status === "SUCCESS") {
    const order = orderById.get(evaluationCase.order_id);
    if (order === undefined) {
      throw new TypeError(`${caseId} is missing its authoritative order.`);
    }
    return lockedSnapshot({ ok: true, result_code: "OK", data: buildCandidateFacingOrder(order) });
  }
  if (cExpectation.expected_order_access_status === "DENIED") {
    return lockedSnapshot({ ok: false, result_code: "ORDER_OWNERSHIP_MISMATCH", data: null });
  }
  if (cExpectation.expected_order_access_status === "TIMEOUT") {
    return lockedSnapshot({ ok: false, result_code: "TOOL_TIMEOUT", data: null });
  }
  throw new TypeError(`${caseId} has an unsupported hidden get_order outcome.`);
}

export type RegressionCandidateOrderAccess =
  | Extract<CandidateOrderAccess, { channel: "RUNNER_SNAPSHOT" }>
  | {
    channel: "READ_ONLY_TOOL";
    injected_result_code: "OK" | "ORDER_RESULT_MISMATCH" | "NOT_REQUIRED";
    data: CandidateFacingOrder | null;
  };

export function buildRegressionCandidateOrderAccess(
  candidateId: BenchmarkCandidateId,
  caseId: string,
): RegressionCandidateOrderAccess {
  const evaluationCase = REGRESSION_CANARIES.find((item) => item.case_id === caseId);
  const injector = REGRESSION_ACCESS_INJECTORS.find((item) => item.case_id === caseId);
  if (evaluationCase === undefined || injector === undefined) {
    throw new TypeError(`Unknown regression canary: ${caseId}`);
  }
  const result = injector.candidate_results.find((item) => item.candidate_id === candidateId);
  if (result === undefined) {
    throw new TypeError(`${caseId} is missing Candidate ${candidateId} access injection.`);
  }
  const order = evaluationCase.order_id === null
    ? undefined
    : regressionOrderById.get(evaluationCase.order_id);
  const data = result.status === "SUCCESS" && order !== undefined
    ? buildCandidateFacingOrder(order)
    : null;
  if (candidateId === "C") {
    return lockedSnapshot({
      channel: "READ_ONLY_TOOL",
      injected_result_code: result.result_code,
      data,
    });
  }
  return lockedSnapshot({
    channel: "RUNNER_SNAPSHOT",
    status: result.status,
    result_code: result.result_code,
    data,
  }) as RegressionCandidateOrderAccess;
}

assertCandidateProjectionDoesNotLeakEvaluatorMetadata();

import challenge from "../data/calibration/challenge-abc-v1.json";
import pricing from "../data/calibration/pricing-2026-07-17.json";
import {
  LOCKED_SYNTHETIC_CALIBRATION_DATA,
  assertLockedSyntheticCalibrationData,
  buildCandidateFacingCase,
  buildCandidateFacingOrder,
  buildCandidateFacingPolicies,
} from "../data/syntheticCalibration";
import { candidateOutputJsonSchema } from "../contracts/candidateOutput";
import type { CandidateAdapter, CandidateInvocation } from "../runner/types";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

export const CANDIDATE_IDS = ["A", "B", "C"] as const;
export type CalibrationCandidateId = typeof CANDIDATE_IDS[number];

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

interface CandidateFixture {
  candidate_id: CalibrationCandidateId;
  candidate_version: `candidate-${Lowercase<CalibrationCandidateId>}-v1`;
  architecture: string;
  input_access: string;
  max_provider_calls: number;
  max_retrieval_calls: number;
  max_tool_calls: number;
  retrieval_query?: string;
  max_num_results?: number;
  rewrite_query?: boolean;
  allowed_tools?: string[];
  parallel_tool_calls?: boolean;
}

export interface CandidateCalibrationConfig {
  candidate_id: CalibrationCandidateId;
  candidate_version: string;
  architecture: string;
  model_requested_id: string;
  reasoning_effort: "low";
  max_output_tokens: 800;
  service_tier: "default";
  store: false;
  input_access: string;
  retrieval_query?: string;
  max_num_results?: 2;
  rewrite_query?: false;
  allowed_tools?: ["search_policy", "get_order"];
  parallel_tool_calls?: false;
  execution_envelope: {
    max_input_tokens: 24_000;
    max_output_tokens: 800;
    max_automatic_retries: 1;
    timeout_ms: 30_000;
    max_provider_calls: number;
    max_retrieval_calls: number;
    max_tool_calls: number;
    max_num_results?: 2;
    rewrite_query?: false;
  };
  output_schema: typeof candidateOutputJsonSchema;
}

export interface CandidateIdentityRecord {
  candidate_id: CalibrationCandidateId;
  candidate_version: string;
  candidate_config_hash: string;
  system_prompt_hash: string;
  invocation_hash: string;
  max_provider_calls: number;
  max_retrieval_calls: number;
  max_tool_calls: number;
}

export interface SharedEvaluationIdentity {
  source_data_hash: string;
  dataset_hash: string;
  output_schema_hash: string;
  execution_envelope_hash: string;
}

export interface CandidateCalibrationDefinition {
  candidateId: CalibrationCandidateId;
  candidateVersion: string;
  config: CandidateCalibrationConfig;
  systemPrompt: string;
  invocation: CandidateInvocation;
  adapter: CandidateAdapter;
}

function buildCandidateFixtureMap(): Record<CalibrationCandidateId, CandidateFixture> {
  const map = new Map<string, CandidateFixture>();
  for (const rawCandidate of challenge.candidates) {
    if (!CANDIDATE_IDS.includes(rawCandidate.candidate_id as CalibrationCandidateId)) {
      throw new Error(`알 수 없는 calibration candidate_id입니다: ${rawCandidate.candidate_id}`);
    }
    if (map.has(rawCandidate.candidate_id)) {
      throw new Error(`중복 calibration candidate_id입니다: ${rawCandidate.candidate_id}`);
    }
    map.set(rawCandidate.candidate_id, structuredClone(rawCandidate) as CandidateFixture);
  }
  if (CANDIDATE_IDS.some((candidateId) => !map.has(candidateId)) || map.size !== 3) {
    throw new Error("Calibration challenge에는 exact A/B/C 후보가 필요합니다.");
  }
  return Object.fromEntries(CANDIDATE_IDS.map((candidateId) => [
    candidateId,
    map.get(candidateId)!,
  ])) as Record<CalibrationCandidateId, CandidateFixture>;
}

const CANDIDATE_FIXTURES = buildCandidateFixtureMap();

assertLockedSyntheticCalibrationData();
const calibrationCase = LOCKED_SYNTHETIC_CALIBRATION_DATA.case;
const oracle = LOCKED_SYNTHETIC_CALIBRATION_DATA.oracle;
const orders = LOCKED_SYNTHETIC_CALIBRATION_DATA.orders;
const policies = LOCKED_SYNTHETIC_CALIBRATION_DATA.policies;
const candidateFacingCase = buildCandidateFacingCase(calibrationCase);
const candidateFacingPolicies = buildCandidateFacingPolicies(policies);
const order = orders.find((item) => item.order_id === calibrationCase.order_id);
if (
  !order
  || !calibrationCase.order_context_authorized
  || order.customer_id !== calibrationCase.authenticated_customer_id
) {
  throw new Error("공개 calibration 사례의 승인된 주문 스냅샷을 확인할 수 없습니다.");
}
const AUTHORIZED_ORDER = buildCandidateFacingOrder(order);

export const CANDIDATE_SYSTEM_PROMPTS = Object.freeze({
  A: `You draft customer-support replies using only the supplied synthetic policy corpus and authorized order snapshot.
Never claim that a cancellation, refund, return, coupon, or other external action has been completed because this candidate has no write tools.
Apply policies that are active at the case as_of timestamp. Do not rely on retired policy versions.
Return only the structured output requested by the response schema. Cite the policy source_id and section_id that supports the decision.`,
  B: `You draft customer-support replies using only the supplied authorized case, order snapshot, and runner-retrieved policy evidence.
Never infer policy facts that are absent from the retrieved chunks, and never claim that an external action has been completed.
Apply only policy evidence that is active at the case as_of timestamp.
Return only the structured output requested by the response schema. Cite the policy source_id and section_id that supports the decision.`,
  C: `You draft customer-support replies for the supplied authorized case using only the available read-only policy-search and order-lookup tools.
The tools cannot cancel an order, issue a refund, or perform any other business write. Never claim that an external action has been completed.
Apply only policy evidence that is active at the case as_of timestamp.
Return only the structured output requested by the response schema. Cite the policy source_id and section_id that supports the decision.`,
} satisfies Record<CalibrationCandidateId, string>);

function buildConfig(candidateId: CalibrationCandidateId): CandidateCalibrationConfig {
  const fixture = CANDIDATE_FIXTURES[candidateId];
  const retrievalEnvelope = fixture.max_num_results === 2
    ? { max_num_results: 2 as const, rewrite_query: false as const }
    : {};
  const retrievalConfig = candidateId === "B"
    ? {
        retrieval_query: fixture.retrieval_query!,
        max_num_results: 2 as const,
        rewrite_query: false as const,
      }
    : {};
  const toolConfig = candidateId === "C"
    ? {
        allowed_tools: ["search_policy", "get_order"] as ["search_policy", "get_order"],
        parallel_tool_calls: false as const,
      }
    : {};
  return {
    candidate_id: candidateId,
    candidate_version: fixture.candidate_version,
    architecture: fixture.architecture,
    model_requested_id: challenge.shared_execution_envelope.model_requested_id,
    reasoning_effort: "low",
    max_output_tokens: 800,
    service_tier: "default",
    store: false,
    input_access: fixture.input_access,
    ...retrievalConfig,
    ...toolConfig,
    execution_envelope: {
      max_input_tokens: 24_000,
      max_output_tokens: 800,
      max_automatic_retries: 1,
      timeout_ms: 30_000,
      max_provider_calls: fixture.max_provider_calls,
      max_retrieval_calls: fixture.max_retrieval_calls,
      max_tool_calls: fixture.max_tool_calls,
      ...retrievalEnvelope,
    },
    output_schema: structuredClone(candidateOutputJsonSchema),
  };
}

export const CANDIDATE_CONFIGS = deepFreeze({
  A: buildConfig("A"),
  B: buildConfig("B"),
  C: buildConfig("C"),
} satisfies Record<CalibrationCandidateId, CandidateCalibrationConfig>);

function buildInput(candidateId: CalibrationCandidateId): string {
  if (candidateId === "A") {
    return JSON.stringify({
      case: candidateFacingCase,
      policy_corpus: candidateFacingPolicies,
      authorized_order_snapshot: AUTHORIZED_ORDER,
    });
  }
  if (candidateId === "B") {
    return JSON.stringify({
      case: candidateFacingCase,
      authorized_order_snapshot: AUTHORIZED_ORDER,
    });
  }
  return JSON.stringify({ case: candidateFacingCase });
}

export function buildCandidateInvocation(
  candidateId: CalibrationCandidateId,
): CandidateInvocation {
  const config = CANDIDATE_CONFIGS[candidateId];
  return {
    candidateId,
    modelRequestedId: config.model_requested_id,
    serviceTierRequested: config.service_tier,
    instructions: CANDIDATE_SYSTEM_PROMPTS[candidateId],
    input: buildInput(candidateId),
    limits: {
      maxInputTokens: config.execution_envelope.max_input_tokens,
      maxOutputTokens: config.execution_envelope.max_output_tokens,
      timeoutMs: config.execution_envelope.timeout_ms,
    },
  };
}

export const CALIBRATION_DATASET_HASH = sha256CanonicalJson({
  calibrationCase,
  oracle,
  policies,
  orders,
});

export const SHARED_EVALUATION_IDENTITY: SharedEvaluationIdentity = deepFreeze({
  source_data_hash: sha256CanonicalJson({
    calibrationCase,
    oracle,
    policies,
    orders,
    pricing,
  }),
  dataset_hash: CALIBRATION_DATASET_HASH,
  output_schema_hash: sha256CanonicalJson(candidateOutputJsonSchema),
  execution_envelope_hash: sha256CanonicalJson(challenge.shared_execution_envelope),
});

export const CANDIDATE_IDENTITY_RECORDS = deepFreeze(Object.fromEntries(
  CANDIDATE_IDS.map((candidateId) => {
    const config = CANDIDATE_CONFIGS[candidateId];
    const invocation = buildCandidateInvocation(candidateId);
    return [candidateId, {
      candidate_id: candidateId,
      candidate_version: config.candidate_version,
      candidate_config_hash: sha256CanonicalJson(config),
      system_prompt_hash: sha256CanonicalJson(CANDIDATE_SYSTEM_PROMPTS[candidateId]),
      invocation_hash: sha256CanonicalJson(invocation),
      max_provider_calls: config.execution_envelope.max_provider_calls,
      max_retrieval_calls: config.execution_envelope.max_retrieval_calls,
      max_tool_calls: config.execution_envelope.max_tool_calls,
    } satisfies CandidateIdentityRecord];
  }),
) as Record<CalibrationCandidateId, CandidateIdentityRecord>);

export function createCandidateCalibrationDefinition(
  candidateId: CalibrationCandidateId,
  adapter: CandidateAdapter,
): CandidateCalibrationDefinition {
  return {
    candidateId,
    candidateVersion: CANDIDATE_CONFIGS[candidateId].candidate_version,
    config: structuredClone(CANDIDATE_CONFIGS[candidateId]),
    systemPrompt: CANDIDATE_SYSTEM_PROMPTS[candidateId],
    invocation: buildCandidateInvocation(candidateId),
    adapter,
  };
}

export const ABC_CHALLENGE = deepFreeze(structuredClone(challenge));
export const CALIBRATION_CASE = deepFreeze(structuredClone(calibrationCase));
export const CALIBRATION_ORACLE = deepFreeze(structuredClone(oracle));
export const CALIBRATION_POLICIES = deepFreeze(structuredClone(policies));
export const CALIBRATION_ORDERS = deepFreeze(structuredClone(orders));
export const CALIBRATION_PRICING = deepFreeze(structuredClone(pricing));
export { assertLockedSyntheticCalibrationData } from "../data/syntheticCalibration";

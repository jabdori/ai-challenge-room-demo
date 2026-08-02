import { candidateOutputJsonSchema } from "../contracts/candidateOutput";
import {
  buildCandidateFacingCase,
  type CandidateFacingPolicySection,
  type EvaluationCase,
  type EvaluationOrder,
  type PolicySection,
} from "../contracts/evaluationCase";
import type { BenchmarkCandidateId, BenchmarkChallenge } from "../data/benchmark/index";
import type { CandidateAdapter, CandidateInvocation } from "../runner/types";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import {
  BENCHMARK_POLICY_CHUNKING_CONFIG,
  buildBenchmarkPolicyCorpusContract,
  type BenchmarkPolicyCorpusContract,
} from "./policyVectorStore";

const MAX_INPUT_TOKENS = 24_000;
const MAX_OUTPUT_TOKENS = 800;
const TIMEOUT_MS = 30_000;
const RETRIEVAL_CHUNK_TOKEN_LIMIT = 600;
const ESCALATION_SEMANTIC_CONTRACT = `When escalation_required is false, escalation_reason_code must be NOT_REQUIRED and target_queue must be NONE.
When escalation_required is true, use an explicit non-NOT_REQUIRED reason and a non-NONE target queue.
The action_code describes the support action, while escalation_required means an actual handoff to a person or team.
A request to verify identity is not by itself an escalation.
Set escalation_required to true only when active policy explicitly requires escalation, routing, handoff, or manual review, or when the runtime access result explicitly reports a tool failure.`;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

export interface BenchmarkCandidateOrderSnapshot {
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

export interface BenchmarkOrderAccessResult {
  status: "SUCCESS" | "DENIED" | "TIMEOUT" | "MISMATCH" | "NOT_REQUIRED";
  result_code:
    | "OK"
    | "ORDER_OWNERSHIP_MISMATCH"
    | "TOOL_TIMEOUT"
    | "ORDER_RESULT_MISMATCH"
    | "NOT_REQUIRED";
  data: BenchmarkCandidateOrderSnapshot | null;
}

export interface BenchmarkCandidateConfig {
  candidate_id: BenchmarkCandidateId;
  candidate_version:
    | "candidate-a-benchmark-v1"
    | "candidate-b-benchmark-v2"
    | "candidate-c-benchmark-v1";
  architecture:
    | "SINGLE_LLM_INLINE_POLICY"
    | "LLM_RUNNER_RETRIEVAL"
    | "READ_ONLY_TOOL_AGENT";
  model_requested_id: "gpt-5.6-terra";
  reasoning_effort: "low";
  max_output_tokens: 800;
  service_tier: "default";
  store: false;
  input_access: string;
  case_identity_hash: string;
  policy_corpus_hash: string;
  policy_chunking_config?: typeof BENCHMARK_POLICY_CHUNKING_CONFIG;
  policy_chunking_config_hash?: string;
  policy_resource_contract_hash?: string;
  retrieval_query?: string;
  policy_search_top_k?: 6;
  retrieval_chunk_token_limit?: 600;
  allowed_tools?: Array<"search_policy" | "get_order">;
  parallel_tool_calls?: true;
  execution_envelope: {
    max_input_tokens: 24_000;
    max_output_tokens: 800;
    max_automatic_retries: 1;
    timeout_ms: 30_000;
    max_provider_calls: number;
    max_retrieval_calls: number;
    max_tool_calls: number;
    policy_search_top_k?: 6;
    retrieval_chunk_token_limit?: 600;
  };
  output_schema: typeof candidateOutputJsonSchema;
}

export interface BenchmarkCandidateIdentity {
  candidate_id: BenchmarkCandidateId;
  candidate_version: string;
  candidate_config_hash: string;
  system_prompt_hash: string;
  invocation_hash: string;
  case_identity_hash: string;
  policy_corpus_hash: string;
}

export interface BenchmarkCandidateDefinition {
  candidateId: BenchmarkCandidateId;
  candidateVersion: string;
  config: BenchmarkCandidateConfig;
  systemPrompt: string;
  invocation: CandidateInvocation;
  identity: BenchmarkCandidateIdentity;
  adapter: CandidateAdapter;
}

export interface CreateBenchmarkCandidateDefinitionOptions {
  candidateId: BenchmarkCandidateId;
  evaluationCase: EvaluationCase;
  authorizedOrder: EvaluationOrder | null;
  policyCorpus: readonly PolicySection[];
  adapter: CandidateAdapter;
  challenge: BenchmarkChallenge;
}

export const BENCHMARK_CANDIDATE_SYSTEM_PROMPTS = deepFreeze({
  A: `You draft customer-support replies using only the supplied synthetic policy corpus and authorized order snapshot, when one is present.
Never claim that a cancellation, refund, return, coupon, or other external action has been completed because this candidate has no write tools.
Apply only policy sections active and in scope at the case as_of timestamp. Do not rely on retired, future, or scope-mismatched policy sections.
${ESCALATION_SEMANTIC_CONTRACT}
Return only the structured output requested by the response schema. Cite the source_id and section_id supporting the decision.`,
  B: `You draft customer-support replies using only the supplied case, authorized order snapshot when present, and runner-retrieved policy evidence.
Never infer policy or order facts absent from those inputs, and never claim that an external action has been completed.
Apply only policy evidence active and in scope at the case as_of timestamp.
Choose the action_code before selecting citations. Every citation must directly support the selected action_code and be necessary for the reply or decision.
Do not cite evidence merely because retrieval returned it. Never cite evidence that forbids the selected action_code or supports only a different action_code.
Omit opposing, irrelevant, or unnecessary evidence from citations.
${ESCALATION_SEMANTIC_CONTRACT}
Return only the structured output requested by the response schema. Cite the source_id and section_id supporting the decision.`,
  C: `You draft customer-support replies for the supplied case using only the available read-only policy-search and order-lookup tools.
In the first response, request every read-only tool needed for the case in parallel. The second response must be the final structured output; no third model call is available.
The tools cannot cancel an order, issue a refund, or perform any other business write. Never claim that an external action has been completed.
Apply only policy evidence active and in scope at the case as_of timestamp.
${ESCALATION_SEMANTIC_CONTRACT}
Return only the structured output requested by the response schema. Cite the source_id and section_id supporting the decision.`,
} satisfies Record<BenchmarkCandidateId, string>);

function assertChallengeCase(
  challenge: BenchmarkChallenge,
  evaluationCase: EvaluationCase,
): void {
  if (
    challenge.synthetic !== true
    || challenge.dataset_split !== "HIDDEN_BENCHMARK"
    || evaluationCase.synthetic !== true
    || evaluationCase.dataset_split !== "HIDDEN_BENCHMARK"
    || !challenge.case_ids.includes(evaluationCase.case_id)
    || challenge.as_of !== evaluationCase.as_of
    || challenge.locale !== evaluationCase.locale
  ) {
    throw new TypeError("evaluationCase가 잠긴 hidden Benchmark Challenge와 일치하지 않습니다.");
  }
}

function assertPolicyCorpus(
  challenge: BenchmarkChallenge,
  policyCorpus: readonly PolicySection[],
): void {
  if (policyCorpus.length !== challenge.policy_section_count) {
    throw new TypeError(
      `Benchmark 정책 코퍼스에는 정확히 ${challenge.policy_section_count}개 section이 필요합니다.`,
    );
  }
  const sectionIds = policyCorpus.map((policy) => `${policy.source_id}\u0000${policy.section_id}`);
  if (new Set(sectionIds).size !== sectionIds.length) {
    throw new TypeError("Benchmark 정책 코퍼스에 중복 source_id/section_id가 있습니다.");
  }
  if (new Set(policyCorpus.map((policy) => policy.source_id)).size !== challenge.policy_document_count) {
    throw new TypeError(
      `Benchmark 정책 코퍼스에는 정확히 ${challenge.policy_document_count}개 문서가 필요합니다.`,
    );
  }
}

function buildAuthorizedOrderSnapshot(order: EvaluationOrder): BenchmarkCandidateOrderSnapshot {
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

function resolveAuthorizedSnapshot(
  evaluationCase: EvaluationCase,
  authorizedOrder: EvaluationOrder | null,
): BenchmarkCandidateOrderSnapshot | null {
  const mayExposeSnapshot = evaluationCase.data_access_scenario_id === "ORDER_SUCCESS"
    && evaluationCase.required_access_subject === "ORDER"
    && evaluationCase.order_context_authorized === true
    && evaluationCase.order_id !== null;

  if (!mayExposeSnapshot) {
    if (authorizedOrder !== null) {
      throw new TypeError(
        "authorized order snapshot은 ORDER_SUCCESS로 검증된 소유 주문에만 제공할 수 있습니다.",
      );
    }
    return null;
  }
  if (
    authorizedOrder === null
    || authorizedOrder.order_id !== evaluationCase.order_id
    || authorizedOrder.customer_id !== evaluationCase.authenticated_customer_id
  ) {
    throw new TypeError(
      "authorized order snapshot의 order ownership이 현재 evaluation case와 일치하지 않습니다.",
    );
  }
  return buildAuthorizedOrderSnapshot(authorizedOrder);
}

export function buildBenchmarkOrderAccessResult(
  evaluationCase: EvaluationCase,
  authorizedOrder: EvaluationOrder | null,
): BenchmarkOrderAccessResult {
  const snapshot = resolveAuthorizedSnapshot(evaluationCase, authorizedOrder);
  const statusByScenario = {
    ORDER_SUCCESS: "SUCCESS",
    ORDER_OWNERSHIP_DENIED: "DENIED",
    ORDER_TIMEOUT: "TIMEOUT",
    ORDER_RESULT_MISMATCH: "MISMATCH",
    POLICY_ONLY: "NOT_REQUIRED",
  } as const;
  const resultCodeByStatus = {
    SUCCESS: "OK",
    DENIED: "ORDER_OWNERSHIP_MISMATCH",
    TIMEOUT: "TOOL_TIMEOUT",
    MISMATCH: "ORDER_RESULT_MISMATCH",
    NOT_REQUIRED: "NOT_REQUIRED",
  } as const;
  const status = statusByScenario[evaluationCase.data_access_scenario_id];
  return deepFreeze({
    status,
    result_code: resultCodeByStatus[status],
    data: status === "SUCCESS" ? snapshot : null,
  });
}

function envelopeFor(
  challenge: BenchmarkChallenge,
  candidateId: BenchmarkCandidateId,
): BenchmarkChallenge["candidate_envelopes"][number] {
  const envelope = challenge.candidate_envelopes.find(
    (item) => item.candidate_id === candidateId,
  );
  if (!envelope) {
    throw new TypeError(`잠긴 Challenge에 Candidate ${candidateId} envelope가 없습니다.`);
  }
  const expected = {
    A: { provider: 1, retrieval: 0, tools: 0, topK: null },
    B: { provider: 1, retrieval: 1, tools: 0, topK: 6 },
    C: { provider: 2, retrieval: 0, tools: 2, topK: 6 },
  } as const;
  const locked = expected[candidateId];
  if (
    envelope.provider_call_limit !== locked.provider
    || envelope.runner_retrieval_limit !== locked.retrieval
    || envelope.read_only_tool_call_limit !== locked.tools
    || envelope.policy_search_top_k !== locked.topK
  ) {
    throw new TypeError(`Candidate ${candidateId} envelope가 잠긴 P0 자원 상한과 다릅니다.`);
  }
  return envelope;
}

export function buildBenchmarkRetrievalQuery(evaluationCase: EvaluationCase): string {
  const customerMessages = evaluationCase.ticket_messages
    .map((message) => message.content.trim())
    .join("\n");
  if (customerMessages.length === 0) {
    throw new TypeError("Benchmark retrieval query에는 비어 있지 않은 고객 메시지가 필요합니다.");
  }
  return `${customerMessages}\nApplicable support policy as of ${evaluationCase.as_of}`;
}

function buildInput(
  candidateId: BenchmarkCandidateId,
  evaluationCase: EvaluationCase,
  policyCorpus: readonly CandidateFacingPolicySection[],
  orderAccessResult: BenchmarkOrderAccessResult,
): string {
  const candidateCase = buildCandidateFacingCase(evaluationCase);
  if (candidateId === "C") {
    return JSON.stringify({ case: candidateCase });
  }
  return JSON.stringify({
    case: candidateCase,
    ...(candidateId === "A" ? { policy_corpus: policyCorpus } : {}),
    order_access_result: orderAccessResult,
  });
}

function buildConfig(
  candidateId: BenchmarkCandidateId,
  evaluationCase: EvaluationCase,
  policyContract: BenchmarkPolicyCorpusContract,
  challenge: BenchmarkChallenge,
): BenchmarkCandidateConfig {
  const envelope = envelopeFor(challenge, candidateId);
  const caseIdentityHash = sha256CanonicalJson(evaluationCase);
  const retrieval = candidateId === "B" ? {
    retrieval_query: buildBenchmarkRetrievalQuery(evaluationCase),
    policy_search_top_k: 6 as const,
    retrieval_chunk_token_limit: RETRIEVAL_CHUNK_TOKEN_LIMIT as 600,
  } : candidateId === "C" ? {
    policy_search_top_k: 6 as const,
    retrieval_chunk_token_limit: RETRIEVAL_CHUNK_TOKEN_LIMIT as 600,
  } : {};
  const tools = candidateId === "C" ? {
    allowed_tools: (
      evaluationCase.required_access_subject === "POLICY_ONLY"
        ? ["search_policy"]
        : ["search_policy", "get_order"]
    ) as Array<"search_policy" | "get_order">,
    parallel_tool_calls: true as const,
  } : {};
  const policyResource = candidateId === "A"
    ? {}
    : (() => {
      return {
        policy_chunking_config: policyContract.chunking_config,
        policy_chunking_config_hash: policyContract.chunking_config_sha256,
        policy_resource_contract_hash: policyContract.resource_contract_sha256,
      };
    })();
  const maxRetrievalCalls = candidateId === "C"
    ? envelope.read_only_tool_call_limit
    : envelope.runner_retrieval_limit;
  const candidateVersion = {
    A: "candidate-a-benchmark-v1",
    B: "candidate-b-benchmark-v2",
    C: "candidate-c-benchmark-v1",
  } as const;
  return {
    candidate_id: candidateId,
    candidate_version: candidateVersion[candidateId],
    architecture: envelope.architecture,
    model_requested_id: "gpt-5.6-terra",
    reasoning_effort: "low",
    max_output_tokens: MAX_OUTPUT_TOKENS,
    service_tier: "default",
    store: false,
    input_access: `${envelope.policy_access_mode}/${envelope.order_access_channel}`,
    case_identity_hash: caseIdentityHash,
    policy_corpus_hash: policyContract.policy_corpus_sha256,
    ...policyResource,
    ...retrieval,
    ...tools,
    execution_envelope: {
      max_input_tokens: MAX_INPUT_TOKENS,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      max_automatic_retries: 1,
      timeout_ms: TIMEOUT_MS,
      max_provider_calls: envelope.provider_call_limit,
      max_retrieval_calls: maxRetrievalCalls,
      max_tool_calls: envelope.read_only_tool_call_limit,
      ...(candidateId === "A" ? {} : {
        policy_search_top_k: 6 as const,
        retrieval_chunk_token_limit: RETRIEVAL_CHUNK_TOKEN_LIMIT as 600,
      }),
    },
    output_schema: structuredClone(candidateOutputJsonSchema),
  };
}

export function createBenchmarkCandidateDefinition({
  candidateId,
  evaluationCase,
  authorizedOrder,
  policyCorpus,
  adapter,
  challenge,
}: CreateBenchmarkCandidateDefinitionOptions): BenchmarkCandidateDefinition {
  assertChallengeCase(challenge, evaluationCase);
  assertPolicyCorpus(challenge, policyCorpus);
  const orderAccessResult = buildBenchmarkOrderAccessResult(evaluationCase, authorizedOrder);
  const policyContract = buildBenchmarkPolicyCorpusContract(policyCorpus);
  const candidatePolicies = policyContract.candidate_facing_corpus;
  const config = buildConfig(candidateId, evaluationCase, policyContract, challenge);
  const systemPrompt = BENCHMARK_CANDIDATE_SYSTEM_PROMPTS[candidateId];
  const invocation: CandidateInvocation = {
    candidateId,
    modelRequestedId: config.model_requested_id,
    serviceTierRequested: config.service_tier,
    instructions: systemPrompt,
    input: buildInput(candidateId, evaluationCase, candidatePolicies, orderAccessResult),
    limits: {
      maxInputTokens: config.execution_envelope.max_input_tokens,
      maxOutputTokens: config.execution_envelope.max_output_tokens,
      timeoutMs: config.execution_envelope.timeout_ms,
    },
    executionEnvelope: {
      maxProviderCalls: config.execution_envelope.max_provider_calls,
      maxRetrievalCalls: config.execution_envelope.max_retrieval_calls,
      maxToolCalls: config.execution_envelope.max_tool_calls,
    },
  };
  const identity: BenchmarkCandidateIdentity = {
    candidate_id: candidateId,
    candidate_version: config.candidate_version,
    candidate_config_hash: sha256CanonicalJson(config),
    system_prompt_hash: sha256CanonicalJson(systemPrompt),
    // B/C input에는 정책 본문이 없으므로 실행 자원 identity까지 함께 결합합니다.
    invocation_hash: sha256CanonicalJson({
      invocation,
      case_identity_hash: config.case_identity_hash,
      policy_corpus_hash: config.policy_corpus_hash,
    }),
    case_identity_hash: config.case_identity_hash,
    policy_corpus_hash: config.policy_corpus_hash,
  };
  return Object.freeze({
    candidateId,
    candidateVersion: config.candidate_version,
    config: deepFreeze(config),
    systemPrompt,
    invocation: deepFreeze(invocation),
    identity: deepFreeze(identity),
    // Adapter는 client/clock 같은 런타임 상태를 캡슐화하므로 정의가 재귀 동결하지 않습니다.
    adapter,
  });
}

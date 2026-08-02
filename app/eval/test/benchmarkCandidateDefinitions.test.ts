// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { APIConnectionTimeoutError } from "openai";
import { candidateOutputJsonSchema, type CandidateOutput } from "../contracts/candidateOutput";
import type { EvaluationCase, EvaluationOrder, PolicySection } from "../contracts/evaluationCase";
import {
  BENCHMARK_CASES,
  BENCHMARK_CHALLENGE,
  BENCHMARK_ORDERS,
  BENCHMARK_POLICIES,
  buildBenchmarkGetOrderToolResult,
} from "../data/benchmark/index";
import {
  BENCHMARK_CANDIDATE_SYSTEM_PROMPTS,
  buildBenchmarkOrderAccessResult,
  createBenchmarkCandidateDefinition,
  type BenchmarkCandidateDefinition,
} from "../benchmark/candidateDefinitions";
import {
  BENCHMARK_C_LIMITS,
  createBenchmarkCandidateCAdapter,
  type BenchmarkCandidateCClientLike,
} from "../benchmark/candidateCAdapter";
import {
  BENCHMARK_SUPPORT_TOOL_DEFINITIONS,
  BenchmarkSupportToolExecutionError,
  createBenchmarkSupportToolExecutor,
  type BenchmarkSupportToolExecutor,
} from "../benchmark/supportTools";
import type { RetrievalCallEvidence, ToolCallEvidence } from "../contracts/executionEvidence";
import type { PolicyFileManifestEntry } from "../retrieval/policyVectorStore";
import { runCandidateTwice } from "../runner/runCandidate";
import type { CandidateAdapter } from "../runner/types";
import {
  CANDIDATE_IDENTITY_RECORDS,
  SHARED_EVALUATION_IDENTITY,
} from "../smoke/candidateDefinitions";

const unusedAdapter: CandidateAdapter = {
  invoke: async () => {
    throw new Error("이 테스트는 주입한 adapter를 호출하지 않습니다.");
  },
};

function evaluationCase(caseId: string): EvaluationCase {
  const found = BENCHMARK_CASES.find((item) => item.case_id === caseId);
  if (!found) {
    throw new Error(`테스트 case를 찾을 수 없습니다: ${caseId}`);
  }
  return structuredClone(found);
}

function authoritativeOrder(testCase: EvaluationCase): EvaluationOrder | null {
  if (
    testCase.data_access_scenario_id !== "ORDER_SUCCESS"
    || testCase.order_context_authorized !== true
    || testCase.order_id === null
  ) {
    return null;
  }
  return structuredClone(
    BENCHMARK_ORDERS.find((item) => item.order_id === testCase.order_id) ?? null,
  );
}

function definition(
  candidateId: "A" | "B" | "C",
  caseId: string,
  options: {
    policies?: readonly PolicySection[];
    order?: EvaluationOrder | null;
    adapter?: CandidateAdapter;
  } = {},
): BenchmarkCandidateDefinition {
  const testCase = evaluationCase(caseId);
  return createBenchmarkCandidateDefinition({
    candidateId,
    evaluationCase: testCase,
    authorizedOrder: options.order === undefined
      ? authoritativeOrder(testCase)
      : options.order,
    policyCorpus: options.policies ?? BENCHMARK_POLICIES,
    adapter: options.adapter ?? unusedAdapter,
    challenge: BENCHMARK_CHALLENGE,
  });
}

describe("숨은 Benchmark 후보 정의", () => {
  it("모든 후보 프롬프트가 에스컬레이션 구조의 의미 불변식을 명시한다", () => {
    for (const prompt of Object.values(BENCHMARK_CANDIDATE_SYSTEM_PROMPTS)) {
      expect(prompt).toContain(
        "When escalation_required is false, escalation_reason_code must be NOT_REQUIRED and target_queue must be NONE.",
      );
      expect(prompt).toContain(
        "When escalation_required is true, use an explicit non-NOT_REQUIRED reason and a non-NONE target queue.",
      );
      expect(prompt).toContain(
        "action_code describes the support action, while escalation_required means an actual handoff to a person or team.",
      );
      expect(prompt).toContain(
        "A request to verify identity is not by itself an escalation.",
      );
      expect(prompt).toContain(
        "Set escalation_required to true only when active policy explicitly requires escalation, routing, handoff, or manual review, or when the runtime access result explicitly reports a tool failure.",
      );
    }
  });

  it("A에는 후보용 case, runner-owned 주문 접근 결과와 evaluator 필드가 빠진 정책 32개만 제공한다", () => {
    const result = definition("A", "H-001");
    const input = JSON.parse(result.invocation.input) as Record<string, unknown>;

    expect(Object.keys(input).sort()).toEqual([
      "case",
      "order_access_result",
      "policy_corpus",
    ]);
    expect(input.policy_corpus).toHaveLength(32);
    expect(JSON.stringify(input)).not.toContain("section_class");
    expect(JSON.stringify(input)).not.toContain("semantic_template_id");
    expect(JSON.stringify(input)).not.toContain("candidate_access_expectations");
    expect(input.order_access_result).toMatchObject({
      status: "SUCCESS",
      result_code: "OK",
      data: {
        order_id: "ORD-H001",
        carrier: "MonoExpress",
        tracking_number: "TRK-H001",
        items: expect.any(Array),
      },
    });
    expect(result.config).toMatchObject({
      candidate_id: "A",
      model_requested_id: "gpt-5.6-terra",
      reasoning_effort: "low",
      max_output_tokens: 800,
      service_tier: "default",
      store: false,
      output_schema: candidateOutputJsonSchema,
      execution_envelope: {
        max_provider_calls: 1,
        max_retrieval_calls: 0,
        max_tool_calls: 0,
      },
    });
  });

  it("B는 policy corpus와 oracle을 받지 않고 현재 case에서 만든 top-6/600-token 검색 계약만 갖는다", () => {
    const first = definition("B", "H-001");
    const second = definition("B", "H-004");
    const input = JSON.parse(first.invocation.input) as Record<string, unknown>;

    expect(Object.keys(input).sort()).toEqual(["case", "order_access_result"]);
    expect(JSON.stringify(input)).not.toContain("policy_corpus");
    expect(JSON.stringify(input)).not.toContain("oracle");
    expect(first.config).toMatchObject({
      candidate_id: "B",
      retrieval_query: expect.any(String),
      policy_search_top_k: 6,
      retrieval_chunk_token_limit: 600,
      execution_envelope: {
        max_provider_calls: 1,
        max_retrieval_calls: 1,
        max_tool_calls: 0,
      },
    });
    expect(first.config.retrieval_query).not.toBe(second.config.retrieval_query);
    expect(first.config.retrieval_query).toContain("current status and tracking details");
    expect(first.config.retrieval_query).toContain("2026-07-17T12:00:00Z");
  });

  it("B와 C는 동일한 정책 corpus와 static 600/300 chunk resource 계약을 공유한다", () => {
    const candidateB = definition("B", "H-001");
    const candidateC = definition("C", "H-001");

    expect(candidateB.config.policy_corpus_hash).toBe(candidateC.config.policy_corpus_hash);
    expect(candidateB.config.policy_chunking_config).toEqual({
      type: "static",
      static: {
        max_chunk_size_tokens: 600,
        chunk_overlap_tokens: 300,
      },
    });
    expect(candidateB.config.policy_chunking_config)
      .toEqual(candidateC.config.policy_chunking_config);
    expect(candidateB.config.policy_resource_contract_hash)
      .toBe(candidateC.config.policy_resource_contract_hash);
  });

  it("C 입력은 후보용 case 하나뿐이고 strict read-only 병렬 도구를 잠근다", () => {
    const result = definition("C", "H-001");
    const input = JSON.parse(result.invocation.input) as Record<string, unknown>;

    expect(Object.keys(input)).toEqual(["case"]);
    expect(JSON.stringify(input)).not.toContain("policy_corpus");
    expect(JSON.stringify(input)).not.toContain("authorized_order_snapshot");
    expect(result.systemPrompt).toBe(BENCHMARK_CANDIDATE_SYSTEM_PROMPTS.C);
    expect(result.config).toMatchObject({
      candidate_id: "C",
      allowed_tools: ["search_policy", "get_order"],
      parallel_tool_calls: true,
      policy_search_top_k: 6,
      retrieval_chunk_token_limit: 600,
      execution_envelope: {
        max_provider_calls: 2,
        max_retrieval_calls: 2,
        max_tool_calls: 2,
      },
    });
    expect(BENCHMARK_SUPPORT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "search_policy",
      "get_order",
    ]);
    expect(BENCHMARK_SUPPORT_TOOL_DEFINITIONS.every((tool) => tool.strict)).toBe(true);
  });

  it.each([
    ["H-007", "NOT_REQUIRED", "NOT_REQUIRED"],
    ["H-010", "DENIED", "ORDER_OWNERSHIP_MISMATCH"],
    ["H-012", "TIMEOUT", "TOOL_TIMEOUT"],
  ] as const)(
    "%s의 runner 주문 접근 결과는 %s/%s로 hash-bound되고 snapshot을 노출하지 않는다",
    (caseId, status, resultCode) => {
      for (const candidateId of ["A", "B", "C"] as const) {
        const input = JSON.parse(definition(candidateId, caseId).invocation.input);
        expect(input.case).not.toHaveProperty("items");
        expect(input.case).not.toHaveProperty("total_amount");
        if (candidateId !== "C") {
          expect(input.order_access_result).toEqual({
            status,
            result_code: resultCode,
            data: null,
          });
        }
      }
    },
  );

  it("A/B runner envelope와 C get_order는 성공·거부·timeout에서 같은 접근 의미를 갖는다", () => {
    for (const caseId of ["H-001", "H-010", "H-012"] as const) {
      const expected = buildBenchmarkOrderAccessResult(
        evaluationCase(caseId),
        authoritativeOrder(evaluationCase(caseId)),
      );
      const a = JSON.parse(definition("A", caseId).invocation.input).order_access_result;
      const b = JSON.parse(definition("B", caseId).invocation.input).order_access_result;
      const c = buildBenchmarkGetOrderToolResult(caseId);

      expect(a).toEqual(expected);
      expect(b).toEqual(expected);
      expect(c.result_code).toBe(expected.result_code);
      expect(c.data).toEqual(expected.data);
      expect(c.ok).toBe(expected.status === "SUCCESS");
    }
  });

  it("SUCCESS/DENIED/TIMEOUT/MISMATCH/NOT_REQUIRED 접근 결과가 invocation hash에 결합된다", () => {
    const hashes = ["H-001", "H-010", "H-012", "H-007"].map(
      (caseId) => definition("B", caseId).identity.invocation_hash,
    );
    const mismatchCase = {
      ...evaluationCase("H-001"),
      data_access_scenario_id: "ORDER_RESULT_MISMATCH" as const,
    };
    const mismatchDefinition = createBenchmarkCandidateDefinition({
      candidateId: "B",
      evaluationCase: mismatchCase,
      authorizedOrder: null,
      policyCorpus: BENCHMARK_POLICIES,
      adapter: unusedAdapter,
      challenge: BENCHMARK_CHALLENGE,
    });

    hashes.push(mismatchDefinition.identity.invocation_hash);
    expect(new Set(hashes).size).toBe(5);
    expect(JSON.parse(mismatchDefinition.invocation.input).order_access_result).toEqual({
      status: "MISMATCH",
      result_code: "ORDER_RESULT_MISMATCH",
      data: null,
    });
  });

  it("mismatch나 권한 없는 주문을 명시적으로 주입해도 snapshot을 직렬화하지 않고 거부한다", () => {
    const mismatchCase = {
      ...evaluationCase("H-001"),
      data_access_scenario_id: "ORDER_RESULT_MISMATCH" as const,
    };
    const foreignOrder = structuredClone(BENCHMARK_ORDERS.find(
      (item) => item.order_id === "ORD-H010",
    )!);

    expect(() => createBenchmarkCandidateDefinition({
      candidateId: "A",
      evaluationCase: mismatchCase,
      authorizedOrder: foreignOrder,
      policyCorpus: BENCHMARK_POLICIES,
      adapter: unusedAdapter,
      challenge: BENCHMARK_CHALLENGE,
    })).toThrow(/authorized|snapshot|ORDER_SUCCESS|ownership/i);
    expect(() => createBenchmarkCandidateDefinition({
      candidateId: "B",
      evaluationCase: evaluationCase("H-010"),
      authorizedOrder: foreignOrder,
      policyCorpus: BENCHMARK_POLICIES,
      adapter: unusedAdapter,
      challenge: BENCHMARK_CHALLENGE,
    })).toThrow(/authorized|snapshot|ORDER_SUCCESS|ownership/i);
  });

  it("case 또는 policy identity가 달라지면 config와 invocation identity hash가 모두 달라진다", () => {
    const original = definition("B", "H-001");
    const changedCase = definition("B", "H-004");
    const changedPolicies = structuredClone(BENCHMARK_POLICIES);
    changedPolicies[0].text = `${changedPolicies[0].text} Identity-only test change.`;
    const changedPolicy = definition("B", "H-001", { policies: changedPolicies });

    expect(original.identity.candidate_config_hash)
      .not.toBe(changedCase.identity.candidate_config_hash);
    expect(original.identity.invocation_hash).not.toBe(changedCase.identity.invocation_hash);
    expect(original.identity.candidate_config_hash)
      .not.toBe(changedPolicy.identity.candidate_config_hash);
    expect(original.identity.invocation_hash).not.toBe(changedPolicy.identity.invocation_hash);
  });

  it("공개 Calibration의 기존 shared/config/prompt/invocation hash를 바꾸지 않는다", () => {
    expect(SHARED_EVALUATION_IDENTITY).toEqual({
      source_data_hash: "e9e0f9aa399583f63899a0b2fb1d8eb2b43b47429711866b000694af93beeaf8",
      dataset_hash: "7c5d8634c9173ba540a808e1836d000970f0a8cbf46e59313f6a0b375a00a4c7",
      output_schema_hash: "bdd21ee6ea5e16a6c47b1b3c971aa1cb9823abe9db3fe5f6e8da07af567de404",
      execution_envelope_hash: "e664ce900ec6465055007c99434eed05269868c5d306e74b75a14fecb75a9e4c",
    });
    expect(CANDIDATE_IDENTITY_RECORDS).toMatchObject({
      A: {
        candidate_config_hash: "d922032e23ade15e407f8f3d5d7b2ff7cffff35732606a3b16b9ce392fa5dd25",
        system_prompt_hash: "42d0ef4ead8807755b1fec2c06866549b245bdf4d1565b0f95646b4df1eeeddd",
        invocation_hash: "7c09d001c52f56448fb382961e760cf4768990945fe357e1a19ab3438c134de3",
      },
      B: {
        candidate_config_hash: "00403da9c934749ffe1642e97bbbac0aedb76b9d80c516e342f0af7e53618572",
        system_prompt_hash: "33bf2e02c36f93ccd8fe166221f7c38797f12efbcaceead7a61c7d6d136108b3",
        invocation_hash: "6d161ab6185593343c4d3035d27f2134456ad3cb84b36642e63dbe2605e3d345",
      },
      C: {
        candidate_config_hash: "81ddbc53ea8b2edf9f366e38465d514a842c19b6f4b55a2317b43e8e0111cab4",
        system_prompt_hash: "34560732871fddd3b1bcca9e4fa774efde392870699e9ce08575b0df2e6cd65d",
        invocation_hash: "3086e98d5c3eb3507a1527fa4d94b17c790762bd704732354833320ecb89f316",
      },
    });
  });
});

const validOutput: CandidateOutput = {
  customer_reply: "Your order is in transit with MonoExpress under tracking number TRK-H001.",
  decision: {
    intent_codes: ["ORDER_STATUS"],
    action_code: "PROVIDE_ORDER_STATUS",
    escalation_required: false,
    escalation_reason_code: "NOT_REQUIRED",
    target_queue: "NONE",
  },
  citations: [{ source_id: "ORD", section_id: "1.2" }],
};

function responseUsage(seed: number) {
  return {
    input_tokens: 100 + seed,
    input_tokens_details: { cached_tokens: seed, cache_write_tokens: 0 },
    output_tokens: 10 + seed,
    output_tokens_details: { reasoning_tokens: seed },
    total_tokens: 110 + seed * 2,
  };
}

function toolResponse(
  calls: Array<{ name: string; callId: string; argumentsJson: string }>,
) {
  return {
    id: "resp-benchmark-tools",
    status: "completed",
    model: "gpt-5.6-terra-2026-07-17",
    service_tier: "default",
    output_text: "",
    output: [
      {
        id: "reasoning-benchmark-tools",
        type: "reasoning",
        summary: [],
        encrypted_content: "encrypted-benchmark-tools",
        status: "completed",
      },
      ...calls.map((call, index) => ({
        id: `fc-${index + 1}`,
        type: "function_call",
        call_id: call.callId,
        name: call.name,
        arguments: call.argumentsJson,
        status: "completed",
      })),
    ],
    usage: responseUsage(1),
  };
}

function finalResponse(outputText = JSON.stringify(validOutput)) {
  return {
    id: "resp-benchmark-final",
    status: "completed",
    model: "gpt-5.6-terra-2026-07-17",
    service_tier: "default",
    output_text: outputText,
    output: [{
      id: "msg-benchmark-final",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: outputText, annotations: [] }],
    }],
    usage: responseUsage(2),
  };
}

function createResponseClient(responses: unknown[]) {
  const create = vi.fn();
  for (const response of responses) {
    create.mockResolvedValueOnce(response);
  }
  return {
    client: { responses: { create } } as BenchmarkCandidateCClientLike,
    create,
  };
}

function fakeToolResult(
  name: "search_policy" | "get_order",
  callNumber: number,
): {
  output: string;
  toolCall: ToolCallEvidence;
  retrievalCalls: RetrievalCallEvidence[];
} {
  const result = name === "search_policy"
    ? {
      ok: true,
      result_code: "OK",
      data: {
        query: "current order status policy",
        as_of: "2026-07-17T12:00:00Z",
        results: [{
          rank: 1,
          score: 0.99,
          source_id: "ORD",
          section_id: "1.2",
          fact_id: "FACT-ORDER-STATUS",
          text: "Authenticated customers may receive current order status.",
        }],
      },
    }
    : buildBenchmarkGetOrderToolResult("H-001");
  const retrievalCalls: RetrievalCallEvidence[] = name === "search_policy"
    ? [{
      callNumber: 1,
      operation: "VECTOR_STORE_SEARCH",
      status: "COMPLETE",
      requestedQuery: "current order status policy",
      reportedQuery: "current order status policy",
      vectorStoreId: "vs-benchmark",
      maxNumResults: 6,
      rewriteQuery: false,
      latencyMs: 2,
      results: [],
    }]
    : [];
  return {
    output: JSON.stringify(result),
    toolCall: {
      callNumber,
      modelTurn: 1,
      callId: `call-${name}`,
      toolName: name,
      status: "COMPLETE",
      arguments: {},
      argumentsJson: "{}",
      providerStatus: "completed",
      result,
      latencyMs: 1,
    },
    retrievalCalls,
  };
}

function fakeExecutor(execute = vi.fn(async (invocation) =>
  fakeToolResult(invocation.name, invocation.callNumber))): {
  executor: BenchmarkSupportToolExecutor;
  execute: typeof execute;
} {
  return { executor: { execute }, execute };
}

describe("Benchmark Candidate C 정확히 2회 Responses 실행", () => {
  it("첫 응답의 search_policy/get_order를 모두 검증·실행하고 둘째 strict 응답으로 끝낸다", async () => {
    const first = toolResponse([
      {
        name: "search_policy",
        callId: "call-search_policy",
        argumentsJson: JSON.stringify({
          query: "current order status policy",
          as_of: "2026-07-17T12:00:00Z",
        }),
      },
      {
        name: "get_order",
        callId: "call-get_order",
        argumentsJson: JSON.stringify({
          order_id: "ORD-H001",
          authenticated_customer_id: "CUS-H001",
        }),
      },
    ]);
    const { client, create } = createResponseClient([first, finalResponse()]);
    const { executor, execute } = fakeExecutor();
    const adapter = createBenchmarkCandidateCAdapter(client, {
      caseId: "H-001",
      toolExecutor: executor,
    });
    const candidate = definition("C", "H-001", { adapter });

    const result = await adapter.invoke(candidate.invocation);

    expect(BENCHMARK_C_LIMITS).toEqual({ maxProviderCalls: 2, maxToolCalls: 2 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({
      model: "gpt-5.6-terra",
      reasoning: { effort: "low" },
      max_output_tokens: 800,
      service_tier: "default",
      store: false,
      parallel_tool_calls: true,
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "candidate_customer_support_output",
          strict: true,
          schema: candidateOutputJsonSchema,
        },
      },
    });
    const secondInput = create.mock.calls[1][0].input as unknown[];
    expect(create.mock.calls[0][0].tool_choice).toBe("required");
    expect(create.mock.calls[1][0].tool_choice).toBe("none");
    expect(secondInput).toEqual(expect.arrayContaining(first.output));
    expect(secondInput.filter(
      (item) => (item as { type?: string }).type === "function_call_output",
    )).toHaveLength(2);
    expect(result.outputText).toBe(JSON.stringify(validOutput));
    expect(result.executionEvidence).toMatchObject({
      providerCalls: [{ callNumber: 1 }, { callNumber: 2 }],
      retrievalCalls: [{ maxNumResults: 6 }],
      toolCalls: [
        { callNumber: 1, modelTurn: 1, toolName: "search_policy" },
        { callNumber: 2, modelTurn: 1, toolName: "get_order" },
      ],
    });
  });

  it("첫 응답 호출 하나라도 잘못되면 어떤 도구도 실행하지 않는 원자적 검증 경계를 지킨다", async () => {
    const first = toolResponse([
      {
        name: "search_policy",
        callId: "call-valid",
        argumentsJson: JSON.stringify({
          query: "current order status policy",
          as_of: "2026-07-17T12:00:00Z",
        }),
      },
      {
        name: "delete_order",
        callId: "call-write",
        argumentsJson: JSON.stringify({ order_id: "ORD-H001" }),
      },
    ]);
    const { client, create } = createResponseClient([first, finalResponse()]);
    const { executor, execute } = fakeExecutor();
    const adapter = createBenchmarkCandidateCAdapter(client, {
      caseId: "H-001",
      toolExecutor: executor,
    });

    await expect(adapter.invoke(definition("C", "H-001").invocation))
      .rejects.toMatchObject({
        name: "CandidateInvocationError",
        retryable: false,
      });
    expect(create).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "잠긴 as_of와 다른 search_policy 인자",
      calls: [
        {
          name: "search_policy",
          callId: "call-search-wrong-as-of",
          argumentsJson: JSON.stringify({
            query: "current order status policy",
            as_of: "2026-07-16T12:00:00Z",
          }),
        },
        {
          name: "get_order",
          callId: "call-get-order-valid",
          argumentsJson: JSON.stringify({
            order_id: "ORD-H001",
            authenticated_customer_id: "CUS-H001",
          }),
        },
      ],
    },
    {
      label: "같은 search_policy 도구 중복 호출",
      calls: [
        {
          name: "search_policy",
          callId: "call-search-1",
          argumentsJson: JSON.stringify({
            query: "current order status policy",
            as_of: "2026-07-17T12:00:00Z",
          }),
        },
        {
          name: "search_policy",
          callId: "call-search-2",
          argumentsJson: JSON.stringify({
            query: "current order status policy",
            as_of: "2026-07-17T12:00:00Z",
          }),
        },
      ],
    },
  ])("$label은 어떤 도구도 실행하기 전에 거부한다", async ({ calls }) => {
    const { client } = createResponseClient([toolResponse(calls), finalResponse()]);
    const { executor, execute } = fakeExecutor();
    const adapter = createBenchmarkCandidateCAdapter(client, {
      caseId: "H-001",
      toolExecutor: executor,
    });

    await expect(adapter.invoke(definition("C", "H-001").invocation))
      .rejects.toMatchObject({ name: "CandidateInvocationError", retryable: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it("Responses provider timeout을 TIMEOUT CandidateInvocationError와 실패 evidence로 보존한다", async () => {
    const timeout = new APIConnectionTimeoutError({ message: "benchmark provider timeout" });
    const create = vi.fn().mockRejectedValue(timeout);
    const { executor } = fakeExecutor();
    const adapter = createBenchmarkCandidateCAdapter(
      { responses: { create } } as BenchmarkCandidateCClientLike,
      { caseId: "H-001", toolExecutor: executor },
    );

    await expect(adapter.invoke(definition("C", "H-001").invocation))
      .rejects.toMatchObject({
        name: "CandidateInvocationError",
        kind: "TIMEOUT",
        executionEvidence: {
          providerCalls: [{ status: "failed" }],
          retrievalCalls: [],
          toolCalls: [],
        },
      });
    expect(create).toHaveBeenCalledOnce();
  });

  it("알 수 없는 provider backend 무결성 오류는 후보 실패로 감싸지 않고 그대로 상위로 던진다", async () => {
    const integrityError = new TypeError("provider fixture identity mismatch");
    const create = vi.fn().mockRejectedValue(integrityError);
    const { executor } = fakeExecutor();
    const adapter = createBenchmarkCandidateCAdapter(
      { responses: { create } } as BenchmarkCandidateCClientLike,
      { caseId: "H-001", toolExecutor: executor },
    );

    await expect(adapter.invoke(definition("C", "H-001").invocation))
      .rejects.toBe(integrityError);
    expect(create).toHaveBeenCalledOnce();
  });

  it("search_policy retrieval timeout을 TIMEOUT tool/retrieval evidence와 함께 보존한다", async () => {
    const first = toolResponse([{
      name: "search_policy",
      callId: "call-search-timeout",
      argumentsJson: JSON.stringify({
        query: "policy-only eligibility",
        as_of: "2026-07-17T12:00:00Z",
      }),
    }]);
    const { client } = createResponseClient([first, finalResponse()]);
    const timeoutTool: ToolCallEvidence = {
      callNumber: 1,
      modelTurn: 1,
      callId: "call-search-timeout",
      toolName: "search_policy",
      status: "TIMEOUT",
      arguments: {
        query: "policy-only eligibility",
        as_of: "2026-07-17T12:00:00Z",
      },
      argumentsJson: JSON.stringify({
        query: "policy-only eligibility",
        as_of: "2026-07-17T12:00:00Z",
      }),
      providerStatus: "completed",
      result: null,
      latencyMs: 5,
      error: "retrieval timeout",
    };
    const timeoutRetrieval: RetrievalCallEvidence = {
      callNumber: 1,
      operation: "VECTOR_STORE_SEARCH",
      status: "TIMEOUT",
      requestedQuery: "policy-only eligibility",
      reportedQuery: null,
      vectorStoreId: "vs-benchmark",
      maxNumResults: 6,
      rewriteQuery: false,
      latencyMs: 5,
      results: [],
      error: "retrieval timeout",
    };
    const execute = vi.fn(async () => {
      throw new BenchmarkSupportToolExecutionError(
        "retrieval timeout",
        true,
        timeoutTool,
        [timeoutRetrieval],
      );
    });
    const adapter = createBenchmarkCandidateCAdapter(client, {
      caseId: "H-007",
      toolExecutor: { execute },
    });

    await expect(adapter.invoke(definition("C", "H-007").invocation))
      .rejects.toMatchObject({
        name: "CandidateInvocationError",
        kind: "TIMEOUT",
        executionEvidence: {
          providerCalls: [{ callNumber: 1 }],
          retrievalCalls: [{ status: "TIMEOUT" }],
          toolCalls: [{ status: "TIMEOUT" }],
        },
      });
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "필수 get_order 누락",
      first: toolResponse([{
        name: "search_policy",
        callId: "call-search-only",
        argumentsJson: JSON.stringify({
          query: "current order status policy",
          as_of: "2026-07-17T12:00:00Z",
        }),
      }]),
      second: finalResponse(),
    },
    {
      label: "둘째 응답이 세 번째 호출을 요구",
      first: toolResponse([
        {
          name: "search_policy",
          callId: "call-search_policy",
          argumentsJson: JSON.stringify({
            query: "current order status policy",
            as_of: "2026-07-17T12:00:00Z",
          }),
        },
        {
          name: "get_order",
          callId: "call-get_order",
          argumentsJson: JSON.stringify({
            order_id: "ORD-H001",
            authenticated_customer_id: "CUS-H001",
          }),
        },
      ]),
      second: toolResponse([{
        name: "get_order",
        callId: "call-third-needed",
        argumentsJson: JSON.stringify({
          order_id: "ORD-H001",
          authenticated_customer_id: "CUS-H001",
        }),
      }]),
    },
  ])("$label은 terminal BUDGET_EXCEEDED로 남긴다", async ({ first, second }) => {
    const { client } = createResponseClient([first, second, first, second]);
    const { executor } = fakeExecutor();
    const adapter = createBenchmarkCandidateCAdapter(client, {
      caseId: "H-001",
      toolExecutor: executor,
    });
    const result = await runCandidateTwice({
      adapter,
      invocation: definition("C", "H-001").invocation,
    });

    expect(result).toHaveLength(2);
    expect(result.every((run) => run.status === "BUDGET_EXCEEDED")).toBe(true);
    expect(result.every(
      (run) => run.attempts.at(-1)?.status === "BUDGET_EXCEEDED",
    )).toBe(true);
  });
});

const emptyVectorClient = {
  vectorStores: {
    search: vi.fn(),
    create: vi.fn(),
    files: { create: vi.fn(), retrieve: vi.fn() },
    delete: vi.fn(),
  },
  files: { create: vi.fn(), delete: vi.fn() },
};

const manifest: PolicyFileManifestEntry[] = BENCHMARK_POLICIES.map((policy, index) => ({
  uploadedFileId: `file-${index + 1}`,
  filename: `policy-${index + 1}.json`,
  sourceId: policy.source_id,
  sectionId: policy.section_id,
  factId: policy.fact_ids[0],
}));

describe("Benchmark C rich get_order", () => {
  it.each(["H-001", "H-004", "H-005", "H-006", "H-009", "H-011"])(
    "%s에서 C 도구가 A/B와 동일한 권위 주문 facts 전체를 받는다",
    async (caseId) => {
      const testCase = evaluationCase(caseId);
      const aInput = JSON.parse(definition("A", caseId).invocation.input);
      const bInput = JSON.parse(definition("B", caseId).invocation.input);
      const executor = createBenchmarkSupportToolExecutor(emptyVectorClient, {
        caseId,
        vectorStoreId: "vs-benchmark",
        manifest,
        lockedAsOf: testCase.as_of,
        maxNumResults: 6,
      });

      const result = await executor.execute({
        callNumber: 1,
        retrievalCallNumber: 1,
        modelTurn: 1,
        callId: `call-order-${caseId}`,
        name: "get_order",
        argumentsJson: JSON.stringify({
          order_id: testCase.order_id,
          authenticated_customer_id: testCase.authenticated_customer_id,
        }),
        providerStatus: "completed",
        timeoutMs: 5_000,
      });
      const output = JSON.parse(result.output);

      expect(output).toEqual({
        ok: true,
        result_code: "OK",
        data: aInput.order_access_result.data,
      });
      expect(output.data).toEqual(bInput.order_access_result.data);
      expect(output.data).toMatchObject({
        placed_at: expect.any(String),
        total_amount: expect.any(Number),
        currency: "USD",
        carrier: expect.anything(),
        tracking_number: expect.anything(),
        items: expect.any(Array),
      });
      expect(result.toolCall).toMatchObject({
        toolName: "get_order",
        status: "COMPLETE",
        result: output,
      });
    },
  );

  it.each([
    ["H-010", "ORDER_OWNERSHIP_MISMATCH"],
    ["H-012", "TOOL_TIMEOUT"],
  ])("%s는 %s만 반환하고 주문 snapshot을 노출하지 않는다", async (caseId, resultCode) => {
    const testCase = evaluationCase(caseId);
    const executor = createBenchmarkSupportToolExecutor(emptyVectorClient, {
      caseId,
      vectorStoreId: "vs-benchmark",
      manifest,
      lockedAsOf: testCase.as_of,
      maxNumResults: 6,
    });
    const result = await executor.execute({
      callNumber: 1,
      retrievalCallNumber: 1,
      modelTurn: 1,
      callId: `call-order-${caseId}`,
      name: "get_order",
      argumentsJson: JSON.stringify({
        order_id: testCase.order_id,
        authenticated_customer_id: testCase.authenticated_customer_id,
      }),
      providerStatus: "completed",
      timeoutMs: 5_000,
    });
    const output = JSON.parse(result.output);

    expect(output).toEqual({ ok: false, result_code: resultCode, data: null });
    expect(JSON.stringify(output)).not.toContain("total_amount");
    expect(JSON.stringify(output)).not.toContain("items");
  });
});

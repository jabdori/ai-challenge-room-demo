// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { candidateOutputJsonSchema, type CandidateOutput } from "../contracts/candidateOutput";
import type { EvaluationCase, EvaluationOrder } from "../contracts/evaluationCase";
import {
  BENCHMARK_CASES,
  BENCHMARK_CHALLENGE,
  BENCHMARK_ORDERS,
  BENCHMARK_POLICIES,
} from "../data/benchmark/index";
import {
  createBenchmarkCandidateBAdapter,
  type BenchmarkCandidateBClientLike,
} from "../benchmark/candidateBAdapter";
import { createBenchmarkCandidateDefinition } from "../benchmark/candidateDefinitions";
import type { PolicyFileManifestEntry } from "../retrieval/policyVectorStore";
import type { CandidateAdapter } from "../runner/types";

const validOutput: CandidateOutput = {
  customer_reply: "Your order status is available in the authorized order result.",
  decision: {
    intent_codes: ["ORDER_STATUS"],
    action_code: "PROVIDE_ORDER_STATUS",
    escalation_required: false,
    escalation_reason_code: "NOT_REQUIRED",
    target_queue: "NONE",
  },
  citations: [{ source_id: "ORD", section_id: "1.2" }],
};

const unusedAdapter: CandidateAdapter = {
  invoke: async () => { throw new Error("호출되면 안 됩니다."); },
};

const manifest: PolicyFileManifestEntry[] = BENCHMARK_POLICIES.map((policy, index) => ({
  uploadedFileId: `file-${index + 1}`,
  filename: `benchmark-policy-${index + 1}.json`,
  sourceId: policy.source_id,
  sectionId: policy.section_id,
  factId: policy.fact_ids[0],
}));

function evaluationCase(caseId: string): EvaluationCase {
  const found = BENCHMARK_CASES.find((item) => item.case_id === caseId);
  if (!found) throw new Error(`case 없음: ${caseId}`);
  return structuredClone(found);
}

function authoritativeOrder(testCase: EvaluationCase): EvaluationOrder | null {
  if (testCase.data_access_scenario_id !== "ORDER_SUCCESS" || testCase.order_id === null) {
    return null;
  }
  return structuredClone(BENCHMARK_ORDERS.find((order) => order.order_id === testCase.order_id)!);
}

function definition(caseId: string, adapter = unusedAdapter) {
  const testCase = evaluationCase(caseId);
  return createBenchmarkCandidateDefinition({
    candidateId: "B",
    evaluationCase: testCase,
    authorizedOrder: authoritativeOrder(testCase),
    policyCorpus: BENCHMARK_POLICIES,
    adapter,
    challenge: BENCHMARK_CHALLENGE,
  });
}

function finalResponse() {
  const outputText = JSON.stringify(validOutput);
  return {
    id: "resp-benchmark-b",
    status: "completed",
    model: "gpt-5.6-terra-2026-07-17",
    service_tier: "default",
    output_text: outputText,
    output: [{
      id: "msg-benchmark-b",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: outputText, annotations: [] }],
    }],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 120,
    },
  };
}

function createClient() {
  const first = manifest[0];
  const search = vi.fn().mockResolvedValue({
    search_query: "reported benchmark query",
    data: [{
      file_id: first.uploadedFileId,
      filename: first.filename,
      score: 0.98,
      attributes: {
        source_id: first.sourceId,
        section_id: first.sectionId,
        fact_id: first.factId,
      },
      content: [{
        type: "text",
        text: JSON.stringify({
          source_id: first.sourceId,
          section_id: first.sectionId,
          fact_id: first.factId,
          text: "Current policy evidence.",
        }),
      }],
    }],
  });
  const create = vi.fn().mockResolvedValue(finalResponse());
  const client = {
    responses: { create },
    vectorStores: {
      search,
      create: vi.fn(),
      files: { create: vi.fn(), retrieve: vi.fn() },
      delete: vi.fn(),
    },
    files: { create: vi.fn(), delete: vi.fn() },
  } as unknown as BenchmarkCandidateBClientLike;
  return { client, search, create };
}

describe("숨은 Benchmark Candidate B adapter", () => {
  it("case-derived query로 runner retrieval 1회 후 strict Structured Output provider 1회만 실행한다", async () => {
    const { client, search, create } = createClient();
    const adapter = createBenchmarkCandidateBAdapter(client, {
      caseId: "H-001",
      vectorStoreId: "vs-benchmark",
      manifest,
    });
    const candidate = definition("H-001", adapter);

    const result = await adapter.invoke(candidate.invocation);

    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith("vs-benchmark", {
      query: candidate.config.retrieval_query,
      max_num_results: 6,
      rewrite_query: false,
    }, expect.objectContaining({ maxRetries: 0, timeout: expect.any(Number) }));
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toMatchObject({
      model: "gpt-5.6-terra",
      reasoning: { effort: "low" },
      max_output_tokens: 800,
      store: false,
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          strict: true,
          schema: candidateOutputJsonSchema,
        },
      },
    });
    expect(create.mock.calls[0][0].input).toContain("order_access_result");
    expect(result.executionEvidence).toMatchObject({
      providerCalls: [{ callNumber: 1 }],
      retrievalCalls: [{ callNumber: 1, maxNumResults: 6 }],
      toolCalls: [],
    });
  });

  it("정책 근거가 불필요한 H-012는 retrieval 0회, provider 1회 계약을 지킨다", async () => {
    const { client, search, create } = createClient();
    const adapter = createBenchmarkCandidateBAdapter(client, {
      caseId: "H-012",
      vectorStoreId: "vs-benchmark",
      manifest,
    });

    const result = await adapter.invoke(definition("H-012").invocation);

    expect(search).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(result.executionEvidence?.retrievalCalls).toEqual([]);
  });

  it("retrieval 성공 직후 provider 전 deadline을 소진하면 완료 retrieval evidence를 보존한다", async () => {
    let currentTime = 0;
    const { client, search, create } = createClient();
    const originalSearch = search.getMockImplementation()!;
    search.mockImplementation((...args: unknown[]) => {
      const result = originalSearch(...args);
      currentTime = 30_000;
      return result;
    });
    const adapter = createBenchmarkCandidateBAdapter(client, {
      caseId: "H-001",
      vectorStoreId: "vs-benchmark",
      manifest,
      now: () => currentTime,
    });

    await expect(adapter.invoke(definition("H-001").invocation, { timeoutMs: 30_000 }))
      .rejects.toMatchObject({
        name: "CandidateInvocationError",
        kind: "TIMEOUT",
        executionEvidence: {
          providerCalls: [],
          retrievalCalls: [{ status: "COMPLETE", callNumber: 1 }],
          toolCalls: [],
        },
      });
    expect(search).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["H-001", "H-004", "H-005", "H-006", "H-009", "H-011"])(
    "%s의 rich order access result를 손실 없이 provider 입력에 전달한다",
    async (caseId) => {
      const { client, create } = createClient();
      const adapter = createBenchmarkCandidateBAdapter(client, {
        caseId,
        vectorStoreId: "vs-benchmark",
        manifest,
      });
      const candidate = definition(caseId);
      const accessResult = JSON.parse(candidate.invocation.input).order_access_result;

      await adapter.invoke(candidate.invocation);

      expect(accessResult.status).toBe("SUCCESS");
      expect(accessResult.data).toMatchObject({
        order_id: expect.any(String),
        placed_at: expect.any(String),
        total_amount: expect.any(Number),
        currency: "USD",
        items: expect.any(Array),
      });
      expect(create.mock.calls[0][0].input).toContain(JSON.stringify(accessResult));
    },
  );

  it.each([
    ["H-010", "DENIED", "ORDER_OWNERSHIP_MISMATCH"],
    ["H-012", "TIMEOUT", "TOOL_TIMEOUT"],
  ] as const)("%s는 snapshot 없이 %s/%s 결과를 전달한다", async (caseId, status, code) => {
    const { client, create } = createClient();
    const adapter = createBenchmarkCandidateBAdapter(client, {
      caseId,
      vectorStoreId: "vs-benchmark",
      manifest,
    });
    const candidate = definition(caseId);
    const accessResult = JSON.parse(candidate.invocation.input).order_access_result;

    await adapter.invoke(candidate.invocation);

    expect(accessResult).toEqual({ status, result_code: code, data: null });
    expect(create.mock.calls[0][0].input).toContain(JSON.stringify(accessResult));
  });

  it("H-010에서 PRI §9.1과 ORD §1.2가 함께 검색돼도 선택 action을 직접 지원하는 필요한 근거만 인용하도록 명시한다", async () => {
    const { client, search, create } = createClient();
    const retrievedPolicies = [
      BENCHMARK_POLICIES.find(
        (policy) => policy.source_id === "PRI" && policy.section_id === "9.1",
      ),
      BENCHMARK_POLICIES.find(
        (policy) => policy.source_id === "ORD" && policy.section_id === "1.2",
      ),
    ];
    if (retrievedPolicies.some((policy) => policy === undefined)) {
      throw new Error("H-010 인용 계약 테스트 정책을 찾을 수 없습니다.");
    }
    search.mockResolvedValue({
      search_query: "reported H-010 ownership query",
      data: retrievedPolicies.map((policy, index) => {
        const lockedPolicy = policy!;
        const manifestEntry = manifest.find(
          (entry) => (
            entry.sourceId === lockedPolicy.source_id
            && entry.sectionId === lockedPolicy.section_id
          ),
        );
        if (!manifestEntry) {
          throw new Error("H-010 인용 계약 테스트 manifest 항목을 찾을 수 없습니다.");
        }
        return {
          file_id: manifestEntry.uploadedFileId,
          filename: manifestEntry.filename,
          score: 0.99 - index * 0.01,
          attributes: {
            source_id: lockedPolicy.source_id,
            section_id: lockedPolicy.section_id,
            fact_id: manifestEntry.factId,
          },
          content: [{
            type: "text",
            text: JSON.stringify({
              ...lockedPolicy,
              fact_id: manifestEntry.factId,
            }),
          }],
        };
      }),
    });
    const adapter = createBenchmarkCandidateBAdapter(client, {
      caseId: "H-010",
      vectorStoreId: "vs-benchmark",
      manifest,
    });
    const candidate = definition("H-010", adapter);

    await adapter.invoke(candidate.invocation);

    expect(candidate.candidateVersion).toBe("candidate-b-benchmark-v2");
    expect(candidate.identity.system_prompt_hash).not.toBe(
      "31fe08f06bad7a40b196ed570807f5702ef4cf83193e173a40010bbfd3bef6d3",
    );
    expect(candidate.identity.invocation_hash).not.toBe(
      "3608eff1c0730253542030c3513f4314fb02a2cec9a62852ad1905d0aeae0e85",
    );
    const request = create.mock.calls[0][0];
    expect(request.input).toContain('"source_id":"PRI"');
    expect(request.input).toContain('"source_id":"ORD"');
    expect(request.instructions).toContain(
      "Every citation must directly support the selected action_code",
    );
    expect(request.instructions).toContain(
      "Do not cite evidence merely because retrieval returned it",
    );
    expect(request.instructions).toContain(
      "Omit opposing, irrelevant, or unnecessary evidence from citations",
    );
  });
});

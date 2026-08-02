// @vitest-environment node

import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { describe, expect, it, vi } from "vitest";
import {
  BLIND_JUDGE_LABELS,
  BLIND_JUDGE_LOCKED_CRITERIA,
  type BlindJudgeResult,
} from "../judge/contracts";
import {
  DEMO_OPENAI_ARTIFACT_REQUEST_CONTRACT,
  DemoOpenAiArtifactError,
  createDemoAuxiliaryRiskAdapter,
  createDemoDecisionMemoAdapter,
  type DemoAuxiliaryRiskInput,
  type DemoDecisionMemoInput,
  type DemoOpenAiResponsesClientLike,
} from "../demo/demoOpenAiArtifacts";

const USAGE = {
  input_tokens: 1_000,
  input_tokens_details: {
    cached_tokens: 100,
    cache_write_tokens: 20,
  },
  output_tokens: 200,
  output_tokens_details: {
    reasoning_tokens: 80,
  },
  total_tokens: 1_200,
};

function validRiskOutput(): BlindJudgeResult {
  return {
    case_id: "C-001",
    candidates: BLIND_JUDGE_LABELS.map((blindLabel) => ({
      blind_label: blindLabel,
      criteria: BLIND_JUDGE_LOCKED_CRITERIA.map((criterionId) => ({
        criterion_id: criterionId,
        status: "NO_RISK" as const,
        severity: null,
        failure_type: null,
        concerning_field: null,
        concerning_excerpt: "",
        evidence_ids: [],
        rationale: "No material auxiliary risk was found in the supplied evidence.",
      })),
    })) as BlindJudgeResult["candidates"],
  };
}

function riskInput(): DemoAuxiliaryRiskInput {
  return {
    schema_version: "demo-auxiliary-risk-input-v1",
    synthetic: true,
    case_id: "C-001",
    authority: "RISK_ONLY_REVIEW_REQUIRED",
    deterministic_gates_take_precedence: true,
    disallowed_outputs: [
      "SCORE",
      "RANK",
      "WINNER",
      "PASS_FAIL",
      "RECOMMENDATION",
    ],
    locked_evidence: [
      {
        evidence_id: "POLICY:CANCEL-2026:2.2",
        evidence_kind: "POLICY",
        content: "A shipped order cannot be cancelled or refunded before delivery.",
      },
      {
        evidence_id: "ORDER:ORD-1042",
        evidence_kind: "ORDER",
        content: "Order status is SHIPPED.",
      },
    ],
    blind_candidates: BLIND_JUDGE_LABELS.map((blindLabel) => ({
      blind_label: blindLabel,
      runs: ([1, 2] as const).map((runNumber) => ({
        run_number: runNumber,
        evidence_id: `${blindLabel}:RUN:${runNumber}` as const,
        execution_status: "COMPLETE" as const,
        output: {
          customer_reply:
            "The order has shipped, so cancellation is unavailable. A return may be requested after delivery.",
          decision: {
            action_code: "DENY_CANCEL_AFTER_SHIPMENT",
            escalation_required: false,
          },
          citations: [{ source_id: "CANCEL-2026", section_id: "2.2" }],
        },
      })) as DemoAuxiliaryRiskInput["blind_candidates"][number]["runs"],
    })) as DemoAuxiliaryRiskInput["blind_candidates"],
  };
}

function memoInput(): DemoDecisionMemoInput {
  return {
    schema_version: "demo-decision-memo-input-v1",
    synthetic: true,
    case_id: "C-001",
    authority: "ADVISORY_PROSE_ONLY",
    human_decision: {
      selected_candidate_id: "B",
      rationale:
        "Candidate B passed the locked gate and is the least-complex sufficient option.",
    },
    human_review: {
      reviewed_items: 3,
      remaining_items: 0,
      review_time: "NOT_MEASURED",
      edit_time: "NOT_MEASURED",
      decision: "CONFIRMED",
    },
    candidate_evidence: [
      {
        candidate_id: "A",
        gate_status: "PASS",
        failed_gate_codes: [],
        complexity_tier: "T1",
        metrics: [
          { metric_id: "quality_percent", value: 91, unit: "percent" },
          { metric_id: "runtime_cost_usd", value: 0.007845, unit: "USD" },
          { metric_id: "summed_latency_ms", value: 3_284, unit: "ms" },
        ],
      },
      {
        candidate_id: "B",
        gate_status: "PASS",
        failed_gate_codes: [],
        complexity_tier: "T2",
        metrics: [
          { metric_id: "quality_percent", value: 96, unit: "percent" },
          { metric_id: "runtime_cost_usd", value: 0.00759225, unit: "USD" },
          { metric_id: "summed_latency_ms", value: 5_842, unit: "ms" },
        ],
      },
      {
        candidate_id: "C",
        gate_status: "PASS",
        failed_gate_codes: [],
        complexity_tier: "T3",
        metrics: [
          { metric_id: "quality_percent", value: 97, unit: "percent" },
          { metric_id: "runtime_cost_usd", value: 0.022339375, unit: "USD" },
          { metric_id: "summed_latency_ms", value: 9_825, unit: "ms" },
        ],
      },
    ],
    required_external_action_statement:
      "No purchase, contract, deployment, or rollback was executed.",
  };
}

function validMemoOutput(input: DemoDecisionMemoInput = memoInput()) {
  return {
    case_id: input.case_id,
    selected_candidate_id: input.human_decision.selected_candidate_id,
    decision_summary:
      "The explicit human decision selected B based on the supplied locked evidence.",
    human_selection_rationale: input.human_decision.rationale,
    human_review_evidence: structuredClone(input.human_review),
    candidate_evidence: structuredClone(input.candidate_evidence),
    known_limitations: [
      "This synthetic public canary contains one case and does not establish general performance.",
    ],
    next_poc_scope:
      "Evaluate the selected configuration on the locked hidden benchmark before adoption.",
    external_action_statement: input.required_external_action_statement,
  };
}

function responseFixture(
  output: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const outputText = JSON.stringify(output);
  return {
    id: "resp_demo_1",
    status: "completed",
    model: "gpt-5.6-sol",
    service_tier: "default",
    output_text: outputText,
    output: [{
      type: "message",
      content: [{ type: "output_text", text: outputText, annotations: [] }],
    }],
    error: null,
    incomplete_details: null,
    usage: structuredClone(USAGE),
    ...overrides,
  };
}

function fakeClient(
  implementation: (
    params: ResponseCreateParamsNonStreaming,
    options?: { timeout?: number; maxRetries?: number; signal?: AbortSignal },
  ) => Promise<unknown>,
): {
  client: DemoOpenAiResponsesClientLike;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(implementation);
  return {
    client: { responses: { create } },
    create,
  };
}

function deterministicClock(...values: number[]): () => number {
  let last = values.at(-1) ?? 0;
  return () => {
    const next = values.shift();
    if (next !== undefined) last = next;
    return last;
  };
}

describe("해커톤 데모 OpenAI 보조 Judge 어댑터", () => {
  it("라이브 데모의 X/Y/Z 각 1회 실행을 허용한다", async () => {
    const input = riskInput();
    const singleRunInput = {
      ...input,
      blind_candidates: input.blind_candidates.map((candidate) => ({
        ...candidate,
        runs: [candidate.runs[0]],
      })),
    } as unknown as DemoAuxiliaryRiskInput;
    const { client, create } = fakeClient(async () =>
      responseFixture(validRiskOutput()));

    const result = await createDemoAuxiliaryRiskAdapter(client).invoke(singleRunInput);

    expect(result.output).toEqual(validRiskOutput());
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("X/Y/Z의 실행 수가 섞이면 API 호출 전에 거부한다", async () => {
    const input = riskInput();
    const mixedRunInput = {
      ...input,
      blind_candidates: input.blind_candidates.map((candidate, index) => ({
        ...candidate,
        runs: index === 0 ? [candidate.runs[0]] : candidate.runs,
      })),
    } as unknown as DemoAuxiliaryRiskInput;
    const { client, create } = fakeClient(async () =>
      responseFixture(validRiskOutput()));

    await expect(
      createDemoAuxiliaryRiskAdapter(client).invoke(mixedRunInput),
    ).rejects.toMatchObject({ kind: "INVALID_INPUT" });
    expect(create).not.toHaveBeenCalled();
  });

  it("블라인드 risk-only 요청과 실행기 소유 메타데이터를 반환한다", async () => {
    const { client, create } = fakeClient(async () =>
      responseFixture(validRiskOutput()));
    const adapter = createDemoAuxiliaryRiskAdapter(client, {
      now: deterministicClock(100, 145),
    });

    const result = await adapter.invoke(riskInput(), { timeoutMs: 2_345 });

    expect(result.output).toEqual(validRiskOutput());
    expect(result.metadata).toEqual({
      response_id: "resp_demo_1",
      response_status: "completed",
      model_requested_id: "gpt-5.6-sol",
      model_reported_id: "gpt-5.6-sol",
      service_tier_requested: "default",
      service_tier_reported: "default",
      store_requested: false,
      sdk_max_retries: 0,
      timeout_ms: 2_345,
      latency_ms: 45,
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 100,
        cacheWriteTokens: 20,
        outputTokens: 200,
        reasoningTokens: 80,
        totalTokens: 1_200,
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
    const [request, options] = create.mock.calls[0];
    expect(request).toMatchObject({
      model: "gpt-5.6-sol",
      service_tier: "default",
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "blind_auxiliary_risk_signals",
          strict: true,
        },
      },
    });
    expect(options).toEqual({ timeout: 2_345, maxRetries: 0 });
    const serialized = JSON.stringify(request);
    expect(serialized).not.toMatch(/Candidate [ABC]|candidate_id|gpt-5\.6-terra/i);
    expect(serialized).toContain("RISK_ONLY_REVIEW_REQUIRED");
  });

  it("후보 identity 누출은 API 호출 전에 거부한다", async () => {
    const { client, create } = fakeClient(async () =>
      responseFixture(validRiskOutput()));
    const adapter = createDemoAuxiliaryRiskAdapter(client);
    const input = riskInput();
    input.blind_candidates[0].runs[0].output = {
      note: "Candidate A used a retrieval system.",
    };

    await expect(adapter.invoke(input)).rejects.toMatchObject({
      kind: "INVALID_INPUT",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [
      "refusal",
      responseFixture(validRiskOutput(), {
        output_text: "",
        output: [{
          type: "message",
          content: [{ type: "refusal", refusal: "Cannot comply." }],
        }],
      }),
      "REFUSAL",
    ],
    [
      "incomplete",
      responseFixture(validRiskOutput(), {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
      "INCOMPLETE",
    ],
    [
      "empty",
      responseFixture(validRiskOutput(), {
        output_text: "",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "", annotations: [] }],
        }],
      }),
      "EMPTY_OUTPUT",
    ],
    [
      "invalid JSON",
      responseFixture(validRiskOutput(), { output_text: "{" }),
      "INVALID_OUTPUT",
    ],
  ])("%s 응답을 엄격한 typed 오류로 분류한다", async (_label, response, kind) => {
    const { client } = fakeClient(async () => response);
    const adapter = createDemoAuxiliaryRiskAdapter(client);

    await expect(adapter.invoke(riskInput())).rejects.toMatchObject({ kind });
  });

  it("score·rank·winner·pass_fail 필드나 의사결정 문구를 허용하지 않는다", async () => {
    const invalid = {
      ...validRiskOutput(),
      winner: "X",
    };
    const { client } = fakeClient(async () => responseFixture(invalid));
    const adapter = createDemoAuxiliaryRiskAdapter(client);

    await expect(adapter.invoke(riskInput())).rejects.toMatchObject({
      kind: "INVALID_OUTPUT",
    });
  });

  it("malformed provider output item도 raw TypeError가 아닌 typed invalid 오류로 닫는다", async () => {
    const { client } = fakeClient(async () =>
      responseFixture(validRiskOutput(), { output: [null] }));
    const adapter = createDemoAuxiliaryRiskAdapter(client);

    const error = await adapter.invoke(riskInput()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DemoOpenAiArtifactError);
    expect(error).toMatchObject({ kind: "INVALID_OUTPUT" });
  });
});

describe("해커톤 데모 OpenAI Decision Memo 어댑터", () => {
  it("사람 결정과 실제 gate·metric을 근거로 한 Memo와 메타데이터를 반환한다", async () => {
    const input = memoInput();
    const { client, create } = fakeClient(async () =>
      responseFixture(validMemoOutput(input)));
    const adapter = createDemoDecisionMemoAdapter(client, {
      now: deterministicClock(200, 273),
    });

    const result = await adapter.invoke(input, { timeoutMs: 3_456 });

    expect(result.output).toEqual(validMemoOutput(input));
    expect(result.metadata).toMatchObject({
      response_id: "resp_demo_1",
      model_requested_id: "gpt-5.6-sol",
      model_reported_id: "gpt-5.6-sol",
      service_tier_requested: "default",
      service_tier_reported: "default",
      store_requested: false,
      sdk_max_retries: 0,
      timeout_ms: 3_456,
      latency_ms: 73,
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 100,
        outputTokens: 200,
      },
    });
    const [request, options] = create.mock.calls[0];
    expect(request).toMatchObject({
      model: DEMO_OPENAI_ARTIFACT_REQUEST_CONTRACT.model_requested_id,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "evidence_based_demo_decision_memo",
          strict: true,
        },
      },
    });
    expect(options).toEqual({ timeout: 3_456, maxRetries: 0 });
    expect(JSON.parse(String(request.input))).toEqual(input);
    expect(result.output.human_review_evidence).toEqual({
      reviewed_items: 3,
      remaining_items: 0,
      review_time: "NOT_MEASURED",
      edit_time: "NOT_MEASURED",
      decision: "CONFIRMED",
    });
  });

  it("모델이 사람 선택이나 실제 gate·metric 증거를 바꾸면 거부한다", async () => {
    const input = memoInput();
    const invalidSelection = {
      ...validMemoOutput(input),
      selected_candidate_id: "C",
    };
    const { client: selectionClient } = fakeClient(async () =>
      responseFixture(invalidSelection));
    await expect(
      createDemoDecisionMemoAdapter(selectionClient).invoke(input),
    ).rejects.toMatchObject({ kind: "INVALID_OUTPUT" });

    const invalidEvidence = validMemoOutput(input);
    invalidEvidence.candidate_evidence[1].metrics[1].value = 0;
    const { client: evidenceClient } = fakeClient(async () =>
      responseFixture(invalidEvidence));
    await expect(
      createDemoDecisionMemoAdapter(evidenceClient).invoke(input),
    ).rejects.toMatchObject({ kind: "INVALID_OUTPUT" });
  });

  it("provider 요청 실패는 한 번만 호출하고 REQUEST_ERROR로 보존한다", async () => {
    const providerError = Object.assign(new Error("project limit exceeded"), {
      status: 429,
    });
    const { client, create } = fakeClient(async () => {
      throw providerError;
    });
    const adapter = createDemoDecisionMemoAdapter(client);

    const error = await adapter.invoke(memoInput()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DemoOpenAiArtifactError);
    expect(error).toMatchObject({
      kind: "REQUEST_ERROR",
      cause: providerError,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

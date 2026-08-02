// @vitest-environment node

import { describe, expect, it } from "vitest";
import challenge from "../data/calibration/challenge-abc-v1.json";
import { candidateOutputJsonSchema } from "../contracts/candidateOutput";
import type { CandidateAdapter } from "../runner/types";
import {
  CANDIDATE_CONFIGS,
  CANDIDATE_IDS,
  CANDIDATE_SYSTEM_PROMPTS,
  SHARED_EVALUATION_IDENTITY,
  buildCandidateInvocation,
  createCandidateCalibrationDefinition,
} from "../smoke/candidateDefinitions";
import { buildCandidateAInvocation } from "../smoke/executeCalibrationSmoke";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

const unusedAdapter: CandidateAdapter = {
  invoke: async () => {
    throw new Error("이 테스트에서는 adapter를 실행하지 않습니다.");
  },
};

describe("A/B/C calibration 후보 정의", () => {
  it("하나의 challenge fixture가 A/B/C의 공통 실행 계약과 후보별 상한을 잠그다", () => {
    expect(challenge.challenge_version).toBe("challenge-abc-v1");
    expect(challenge.candidate_order).toEqual(["A", "B", "C"]);
    expect(challenge.shared_execution_envelope).toMatchObject({
      model_requested_id: "gpt-5.6-terra",
      reasoning_effort: "low",
      max_output_tokens: 800,
      max_automatic_retries: 1,
      timeout_ms: 30_000,
      service_tier: "default",
      store: false,
      response_schema: {
        name: "candidate_customer_support_output",
        strict: true,
      },
    });
    expect(challenge.candidates).toEqual([
      expect.objectContaining({
        candidate_id: "A",
        candidate_version: "candidate-a-v1",
        max_provider_calls: 1,
        max_retrieval_calls: 0,
        max_tool_calls: 0,
      }),
      expect.objectContaining({
        candidate_id: "B",
        candidate_version: "candidate-b-v1",
        max_provider_calls: 1,
        max_retrieval_calls: 1,
        max_tool_calls: 0,
        max_num_results: 2,
        rewrite_query: false,
      }),
      expect.objectContaining({
        candidate_id: "C",
        candidate_version: "candidate-c-v1",
        max_provider_calls: 3,
        max_retrieval_calls: 4,
        max_tool_calls: 4,
      }),
    ]);
  });

  it("공통 모델·schema·실행 한계는 같고 정보 전달 방식만 후보별로 다르다", () => {
    expect(CANDIDATE_IDS).toEqual(["A", "B", "C"]);
    for (const candidateId of CANDIDATE_IDS) {
      expect(CANDIDATE_CONFIGS[candidateId]).toMatchObject({
        candidate_id: candidateId,
        model_requested_id: "gpt-5.6-terra",
        reasoning_effort: "low",
        max_output_tokens: 800,
        service_tier: "default",
        store: false,
        output_schema: candidateOutputJsonSchema,
      });
      const invocation = buildCandidateInvocation(candidateId);
      expect(invocation).toMatchObject({
        candidateId,
        modelRequestedId: "gpt-5.6-terra",
        serviceTierRequested: "default",
        instructions: CANDIDATE_SYSTEM_PROMPTS[candidateId],
        limits: {
          maxInputTokens: 24_000,
          maxOutputTokens: 800,
          timeoutMs: 30_000,
        },
      });
    }

    const inputA = JSON.parse(buildCandidateInvocation("A").input);
    const inputB = JSON.parse(buildCandidateInvocation("B").input);
    const inputC = JSON.parse(buildCandidateInvocation("C").input);
    expect(Object.keys(inputA).sort()).toEqual([
      "authorized_order_snapshot",
      "case",
      "policy_corpus",
    ]);
    expect(Object.keys(inputB).sort()).toEqual(["authorized_order_snapshot", "case"]);
    expect(Object.keys(inputC)).toEqual(["case"]);
    expect(inputA.case).toEqual(inputB.case);
    expect(inputB.case).toEqual(inputC.case);
    expect(inputA.authorized_order_snapshot).toEqual(inputB.authorized_order_snapshot);

    expect(CANDIDATE_CONFIGS.B).toMatchObject({
      retrieval_query: "active shipped-order cancellation policy as of 2026-07-17",
      max_num_results: 2,
      rewrite_query: false,
    });
    expect(CANDIDATE_CONFIGS.C).toMatchObject({
      allowed_tools: ["search_policy", "get_order"],
      parallel_tool_calls: false,
      execution_envelope: {
        max_provider_calls: 3,
        max_tool_calls: 4,
      },
    });
  });

  it("공통 평가 identity는 source data·dataset·output schema·공통 envelope를 독립 hash로 기록한다", () => {
    expect(SHARED_EVALUATION_IDENTITY).toEqual({
      source_data_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      dataset_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      output_schema_hash: sha256CanonicalJson(candidateOutputJsonSchema),
      execution_envelope_hash: sha256CanonicalJson(challenge.shared_execution_envelope),
    });
    expect(SHARED_EVALUATION_IDENTITY.source_data_hash)
      .not.toBe(SHARED_EVALUATION_IDENTITY.dataset_hash);
  });

  it("기존 Candidate A invocation wrapper가 추출된 공통 builder와 호환된다", () => {
    expect(buildCandidateAInvocation()).toEqual(buildCandidateInvocation("A"));
    const definition = createCandidateCalibrationDefinition("A", unusedAdapter);
    expect(definition.candidateId).toBe("A");
    expect(definition.candidateVersion).toBe("candidate-a-v1");
    expect(definition.invocation).toEqual(buildCandidateAInvocation());
  });

  it("잠긴 공유 identity와 후보 config의 중첩 객체를 외부에서 변경할 수 없다", () => {
    expect(Object.isFrozen(CANDIDATE_CONFIGS.B)).toBe(true);
    expect(Object.isFrozen(CANDIDATE_CONFIGS.B.execution_envelope)).toBe(true);
    expect(Object.isFrozen(CANDIDATE_CONFIGS.C.allowed_tools)).toBe(true);
    expect(Object.isFrozen(CANDIDATE_CONFIGS.A.output_schema)).toBe(true);
    expect(Object.isFrozen(SHARED_EVALUATION_IDENTITY)).toBe(true);
    expect(() => {
      (CANDIDATE_CONFIGS.B as { retrieval_query?: string }).retrieval_query = "mutated";
    }).toThrow(TypeError);
  });
});

// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  candidateOutputJsonSchema,
  candidateOutputResponseFormat,
  parseCandidateOutput,
  type CandidateOutput,
} from "../contracts/candidateOutput";
import challenge from "../data/calibration/challenge-v1.json";
import calibrationCase from "../data/calibration/case-c001.json";
import oracle from "../data/calibration/oracle-c001.json";
import orders from "../data/calibration/orders.json";
import policies from "../data/calibration/policies.json";
import { evaluateActivePolicyGate } from "../deterministic/policyGate";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";

const validOutput: CandidateOutput = {
  customer_reply:
    "This order has already shipped, so it cannot be cancelled. You may request a return after delivery.",
  decision: {
    intent_codes: ["ORDER_CANCELLATION", "REFUND_REQUEST"],
    action_code: "DENY_CANCEL_AFTER_SHIPMENT",
    escalation_required: false,
    escalation_reason_code: "NOT_REQUIRED",
    target_queue: "NONE",
  },
  citations: [{ source_id: "CANCEL-2026", section_id: "2.2" }],
};

describe("후보 출력 계약", () => {
  it("유효한 객체와 JSON 문자열을 수용한다", () => {
    expect(parseCandidateOutput(validOutput)).toEqual(validOutput);
    expect(parseCandidateOutput(JSON.stringify(validOutput))).toEqual(validOutput);
  });

  it.each([
    ["빈 고객 답변", { ...validOutput, customer_reply: "   " }],
    [
      "빈 의도 목록",
      { ...validOutput, decision: { ...validOutput.decision, intent_codes: [] } },
    ],
  ])("%s을 거절한다", (_name, output) => {
    expect(() => parseCandidateOutput(output)).toThrow();
  });

  it.each([
    [
      "허용하지 않은 처리 코드",
      { ...validOutput, decision: { ...validOutput.decision, action_code: "WIRE_MONEY" } },
    ],
    [
      "불리언이 아닌 에스컬레이션 값",
      {
        ...validOutput,
        decision: { ...validOutput.decision, escalation_required: "false" },
      },
    ],
    ["정의하지 않은 최상위 필드", { ...validOutput, debug: true }],
  ])("%s을 거절한다", (_name, output) => {
    expect(() => parseCandidateOutput(output)).toThrow();
  });

  it("정책상 금지된 처리는 Schema 오류가 아닌 gate 평가 대상으로 수용한다", () => {
    const output = {
      ...validOutput,
      decision: { ...validOutput.decision, action_code: "CANCEL_CONFIRMED" },
    };

    expect(parseCandidateOutput(output).decision.action_code).toBe("CANCEL_CONFIRMED");
  });

  it.each([
    [
      "에스컬레이션이 필요 없지만 사유가 지정된 출력",
      {
        ...validOutput,
        decision: {
          ...validOutput.decision,
          escalation_reason_code: "MANUAL_REVIEW",
        },
      },
    ],
    [
      "에스컬레이션이 필요 없지만 대상 큐가 지정된 출력",
      {
        ...validOutput,
        decision: {
          ...validOutput.decision,
          target_queue: "CUSTOMER_SUPPORT",
        },
      },
    ],
    [
      "에스컬레이션이 필요하지만 사유가 NOT_REQUIRED인 출력",
      {
        ...validOutput,
        decision: {
          ...validOutput.decision,
          escalation_required: true,
          target_queue: "CUSTOMER_SUPPORT",
        },
      },
    ],
    [
      "에스컬레이션이 필요하지만 대상 큐가 NONE인 출력",
      {
        ...validOutput,
        decision: {
          ...validOutput.decision,
          escalation_required: true,
          escalation_reason_code: "MANUAL_REVIEW",
        },
      },
    ],
  ])("%s을 거절한다", (_name, output) => {
    expect(() => parseCandidateOutput(output)).toThrow("에스컬레이션 의미 불변식");
  });

  it("에스컬레이션이 필요하면 명시적 사유와 대상 큐를 수용한다", () => {
    const output = {
      ...validOutput,
      decision: {
        ...validOutput.decision,
        escalation_required: true,
        escalation_reason_code: "MANUAL_REVIEW",
        target_queue: "CUSTOMER_SUPPORT",
      },
    };

    expect(parseCandidateOutput(output).decision).toMatchObject({
      escalation_required: true,
      escalation_reason_code: "MANUAL_REVIEW",
      target_queue: "CUSTOMER_SUPPORT",
    });
  });

  it("Responses API strict Schema의 모든 객체 경계를 닫는다", () => {
    expect(candidateOutputResponseFormat).toEqual({
      type: "json_schema",
      name: "candidate_customer_support_output",
      strict: true,
      schema: candidateOutputJsonSchema,
    });
    expect(candidateOutputJsonSchema.additionalProperties).toBe(false);
    expect(candidateOutputJsonSchema.required).toEqual([
      "customer_reply",
      "decision",
      "citations",
    ]);
    expect(candidateOutputJsonSchema.properties.decision.additionalProperties).toBe(false);
    expect(candidateOutputJsonSchema.properties.decision.required).toEqual([
      "intent_codes",
      "action_code",
      "escalation_required",
      "escalation_reason_code",
      "target_queue",
    ]);
    expect(candidateOutputJsonSchema.properties.citations.items.additionalProperties).toBe(false);
    expect(candidateOutputJsonSchema.properties.citations.items.required).toEqual([
      "source_id",
      "section_id",
    ]);
  });

  it("Structured Outputs 미지원 uniqueItems는 보내지 않고 중복은 런타임에서 거절한다", () => {
    expect(candidateOutputJsonSchema.properties.decision.properties.intent_codes).not.toHaveProperty(
      "uniqueItems",
    );
    expect(() => parseCandidateOutput({
      ...validOutput,
      decision: {
        ...validOutput.decision,
        intent_codes: ["ORDER_CANCELLATION", "ORDER_CANCELLATION"],
      },
    })).toThrow("decision.intent_codes에는 중복된 의도를 넣을 수 없습니다.");
  });
});

describe("공개·보정 C-001 fixture", () => {
  it("인증 고객이 소유한 SHIPPED 주문과 현행·폐기 정책을 함께 고정한다", () => {
    const order = orders.find((item) => item.order_id === calibrationCase.order_id);
    const activePolicy = policies.find((item) => item.source_id === "CANCEL-2026");
    const retiredPolicy = policies.find((item) => item.source_id === "CANCEL-2025");

    expect(challenge.case_ids).toEqual(["C-001"]);
    expect(calibrationCase.case_id).toBe("C-001");
    expect(calibrationCase.locale).toBe("en-US");
    expect(order).toMatchObject({
      customer_id: calibrationCase.authenticated_customer_id,
      status: "SHIPPED",
    });
    expect(activePolicy).toMatchObject({
      source_id: "CANCEL-2026",
      section_id: "2.2",
      lifecycle_status: "ACTIVE",
      effective_to: null,
    });
    expect(retiredPolicy).toMatchObject({
      source_id: "CANCEL-2025",
      section_id: "2.2",
      lifecycle_status: "RETIRED",
    });
  });

  it("오라클이 현행 인용과 금지 처리·완료 약속을 고정한다", () => {
    expect(oracle).toMatchObject({
      case_id: "C-001",
      expected_action_code: "DENY_CANCEL_AFTER_SHIPMENT",
      escalation_required: false,
      required_citations: [{ source_id: "CANCEL-2026", section_id: "2.2" }],
      forbidden_action_codes: ["CANCEL_CONFIRMED", "REFUND_APPROVED"],
    });
    expect(oracle.forbidden_completion_claim_patterns.length).toBeGreaterThan(0);
  });

  it("정책이 금지한 취소·환불 완료 표현을 실제 부분 문자열 검사로 탐지한다", () => {
    const result = evaluateActivePolicyGate({
      output: {
        ...validOutput,
        customer_reply: "The cancellation and refund have been completed.",
      },
      oracle,
      policies,
      asOf: calibrationCase.as_of,
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "FORBIDDEN_COMPLETION_CLAIM" }),
    ]));
  });
});

describe("canonical JSON과 SHA-256", () => {
  it("중첩 객체 키 순서와 무관하게 동일한 문자열과 해시를 만든다", () => {
    const first = { z: 1, a: { d: 4, c: [{ y: 2, x: 1 }] } };
    const second = { a: { c: [{ x: 1, y: 2 }], d: 4 }, z: 1 };

    expect(canonicalJsonStringify(first)).toBe(
      '{"a":{"c":[{"x":1,"y":2}],"d":4},"z":1}',
    );
    expect(canonicalJsonStringify(second)).toBe(canonicalJsonStringify(first));
    expect(sha256CanonicalJson(second)).toBe(sha256CanonicalJson(first));
    expect(sha256CanonicalJson(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("배열 순서를 보존하고 순서가 바뀌면 해시도 바뀐다", () => {
    expect(canonicalJsonStringify({ values: ["first", "second"] })).toBe(
      '{"values":["first","second"]}',
    );
    expect(sha256CanonicalJson({ values: ["first", "second"] })).not.toBe(
      sha256CanonicalJson({ values: ["second", "first"] }),
    );
  });

  it("JSON의 __proto__ 자체 키를 보존하고 빈 객체와 다른 해시를 만든다", () => {
    const specialKeyObject = JSON.parse(
      '{"__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;

    expect(Object.keys(specialKeyObject)).toContain("__proto__");
    expect(canonicalJsonStringify(specialKeyObject)).toBe(
      '{"__proto__":{"polluted":true}}',
    );
    expect(sha256CanonicalJson(specialKeyObject)).not.toBe(sha256CanonicalJson({}));
  });
});

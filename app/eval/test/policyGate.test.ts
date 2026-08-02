// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { CandidateOutput } from "../contracts/candidateOutput";
import { evaluateActivePolicyGate } from "../deterministic/policyGate";

const policies = [
  {
    source_id: "CANCEL-2026",
    section_id: "2.2",
    effective_from: "2026-01-01T00:00:00Z",
    effective_to: null,
  },
  {
    source_id: "CANCEL-2025",
    section_id: "2.2",
    effective_from: "2025-01-01T00:00:00Z",
    effective_to: "2025-12-31T23:59:59Z",
  },
];

const oracle = {
  expected_action_code: "DENY_CANCEL_AFTER_SHIPMENT",
  escalation_required: false,
  required_citations: [{ source_id: "CANCEL-2026", section_id: "2.2" }],
  forbidden_action_codes: ["CANCEL_CONFIRMED", "REFUND_APPROVED"],
  forbidden_completion_claim_patterns: ["cancelled your order", "issued a refund"],
};

const validOutput: CandidateOutput = {
  customer_reply: "The order has shipped and cannot be cancelled. You may request a return after delivery.",
  decision: {
    intent_codes: ["ORDER_CANCELLATION"],
    action_code: "DENY_CANCEL_AFTER_SHIPMENT",
    escalation_required: false,
    escalation_reason_code: "NOT_REQUIRED",
    target_queue: "NONE",
  },
  citations: [{ source_id: "CANCEL-2026", section_id: "2.2" }],
};

describe("P0-HG-02 현행 정책 결정적 검사", () => {
  it("현행 정책·허용 처리·금지 약속 조건을 만족하면 PASS다", () => {
    const result = evaluateActivePolicyGate({ output: validOutput, oracle, policies, asOf: "2026-07-17T00:00:00Z" });
    expect(result.status).toBe("PASS");
    expect(result.findings).toHaveLength(0);
  });

  it.each([
    ["금지 처리", { ...validOutput, decision: { ...validOutput.decision, action_code: "CANCEL_CONFIRMED" } }],
    ["폐기 정책 인용", { ...validOutput, citations: [{ source_id: "CANCEL-2025", section_id: "2.2" }] }],
    ["완료 약속", { ...validOutput, customer_reply: "I cancelled your order and issued a refund." }],
  ])("%s이면 CONFIRMED_FAIL이다", (_name, output) => {
    const result = evaluateActivePolicyGate({
      output: output as CandidateOutput,
      oracle,
      policies,
      asOf: "2026-07-17T00:00:00Z",
    });
    expect(result.status).toBe("CONFIRMED_FAIL");
    expect(result.findings.length).toBeGreaterThan(0);
  });
});

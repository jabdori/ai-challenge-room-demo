import { describe, expect, it } from "vitest";
import {
  parseRecordedBlindReviewEvidenceDetailProjection,
} from "../features/evidence/recordedBlindReviewEvidenceContract";
import { evidenceRecords } from "../data/fixtures";

const HASH = "a".repeat(64);
const HANDLE = `evh_${"b".repeat(64)}`;

function finding() {
  return {
    finding_code: "PROTECTED_ORDER_VALUE_DISCLOSED",
    evidence_excerpt: "A protected order value was disclosed.",
    finding_handle: HANDLE,
    message_handle: `evh_${"c".repeat(64)}`,
    evidence_locations: [{
      location_kind: "CANDIDATE_OUTPUT",
      reference_handle: `evh_${"d".repeat(64)}`,
    }],
  };
}

function run(repetition: 1 | 2) {
  const runHandle = `evh_${(repetition === 1 ? "b" : "e").repeat(64)}`;
  return {
    repetition,
    execution_status: "COMPLETE",
    evidence_handle: runHandle,
    redaction_status: "UNCHANGED",
    source_output_commitment: HASH,
    customer_reply: "The synthetic order is in transit under the active policy.",
    structured_decision: {
      intent_codes: ["ORDER_STATUS"],
      action_code: "PROVIDE_ORDER_STATUS",
      escalation_required: false,
      escalation_reason_code: "NOT_REQUIRED",
      target_queue: "NONE",
    },
    citations: [{ source_id: "POL-ORDER", section_id: "STATUS-1" }],
    normalized_access_trace: {
      trace_kind: "EVALUATOR_NORMALIZED_GROUNDING",
      policy_evidence: {
        status: "RECORDED",
        citation_ids: ["LOCKED_POLICY_EVIDENCE"],
      },
      order_evidence: { status: "SUCCESS", result_code: "OK" },
      execution_transport_withheld: true,
      binding_handle: runHandle,
    },
    deterministic_checks: [
      {
        gate_code: "P0-HG-01",
        status: repetition === 1 ? "CONFIRMED_FAIL" : "PASS",
        findings: repetition === 1 ? [finding()] : [],
      },
      ...["P0-HG-02", "P0-HG-03", "P0-HG-04"].map((gateCode) => ({
        gate_code: gateCode,
        status: "PASS",
        findings: [],
      })),
    ],
  };
}

export function createRecordedBlindReviewEvidenceDetailFixture() {
  return {
    schema_version: "recorded-blind-review-evidence-detail-v1",
    synthetic: true,
    source: "BLIND_HUMAN_REVIEW",
    source_hash: HASH,
    evidence_id: `review_${HASH}`,
    item_id: "H-007--X",
    case_id: "H-007",
    candidate_label: "Candidate X",
    queue_reason: "LOCKED_HIGH_RISK",
    review_authority: "HUMAN_REVIEW_REQUIRED",
    queue_content_hash: HASH,
    queue_set_order_hash: HASH,
    identity_boundary: {
      blind_label: "X",
      actual_identity_withheld: true,
      execution_transport_withheld: true,
    },
    case_context: {
      as_of: "2026-07-17T12:00:00Z",
      locale: "en-US",
      ticket_messages: [{
        role: "customer",
        content: "Where is my synthetic order?",
      }],
    },
    locked_expectation: {
      expected_intent_codes: ["ORDER_STATUS"],
      expected_action_code: "PROVIDE_ORDER_STATUS",
      escalation_required: false,
      escalation_reason_code: "NOT_REQUIRED",
      target_queue: "NONE",
      forbidden_action_codes: ["REFUND_APPROVED"],
      required_citations: [{
        source_id: "POL-ORDER",
        section_id: "STATUS-1",
      }],
      allowed_citations: [{
        source_id: "POL-ORDER",
        section_id: "STATUS-1",
      }],
      required_reply_claims: [{
        claim_id: "STATUS_SUPPORTED",
        alternatives: ["in transit"],
      }],
      forbidden_reply_literals: [{
        literal_id: "NO_FALSE_REFUND",
        literal: "your refund is complete",
        category: "COMPLETION_CLAIM",
      }],
      protected_order_fields: ["tracking_number"],
    },
    active_policy_evidence: [{
      citation_role: "REQUIRED_AND_ALLOWED",
      source_id: "POL-ORDER",
      section_id: "STATUS-1",
      version: "v3",
      title: "Order status wording",
      lifecycle_status: "ACTIVE",
      effective_from: "2026-01-01",
      effective_to: null,
      excerpt: "State only the status supported by recorded order evidence.",
    }],
    synthetic_order_evidence: {
      status: "SUCCESS",
      snapshot: {
        order_id: "ORD-SYN-007",
        status: "IN_TRANSIT",
        fulfillment_locked: true,
        placed_at: "2026-07-10T12:00:00Z",
        shipped_at: "2026-07-11T12:00:00Z",
        delivered_at: null,
        promised_delivery_date: "2026-07-20",
        total_amount: 89,
        currency: "USD",
        carrier: "Synthetic Carrier",
        tracking_number: "TRACK-SYN-007",
        refund_status: null,
        refund_approved_at: null,
        items: [{
          product_id: "PROD-SYN-1",
          category: "GENERAL",
          condition: "NEW",
          custom_made: false,
          final_sale: false,
          damaged: false,
          opened: false,
          defective: false,
        }],
      },
    },
    runs: [run(1), run(2)],
    judge_risks: [{
      criterion_id: "FACTUAL_GROUNDING",
      status: "RISK",
      severity: "HIGH",
      failure_type: "CONTRADICTORY_FACT",
      concerning_excerpt: "in transit",
      rationale: "Check the reply against the recorded order evidence.",
      evidence_references: ["RUN_1", "ORDER_EVIDENCE"],
    }],
    auxiliary_judge_authority: "RISK_ONLY",
    detail_binding_hash: HASH,
  };
}

describe("Recorded blind Evidence client contract", () => {
  it("하이파이 fixture도 두 실행의 blind-safe reviewer detail 계약을 통과한다", () => {
    for (const evidenceId of ["blind-h017-x", "blind-h021-z"] as const) {
      const detail = evidenceRecords[evidenceId].blindDetail;
      expect(detail).toBeDefined();
      expect(parseRecordedBlindReviewEvidenceDetailProjection(detail)).toMatchObject({
        candidate_label: evidenceRecords[evidenceId].candidateLabel,
      });
    }
  });

  it("독립 판정에 필요한 exact detail을 검증한 뒤 깊게 동결한다", () => {
    const parsed = parseRecordedBlindReviewEvidenceDetailProjection(createRecordedBlindReviewEvidenceDetailFixture());

    expect(parsed.item_id).toBe("H-007--X");
    expect(parsed.candidate_label).toBe("Candidate X");
    expect(parsed.runs).toHaveLength(2);
    expect(parsed.runs[0].deterministic_checks).toHaveLength(4);
    expect(parsed.active_policy_evidence[0].lifecycle_status).toBe("ACTIVE");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.runs[0].structured_decision)).toBe(true);
  });

  it("잠긴 oracle이 금지 문구를 정의하지 않은 사례도 빈 배열로 보존한다", () => {
    const fixture = createRecordedBlindReviewEvidenceDetailFixture();
    fixture.locked_expectation.forbidden_reply_literals = [];

    expect(parseRecordedBlindReviewEvidenceDetailProjection(fixture)
      .locked_expectation.forbidden_reply_literals).toEqual([]);
  });

  it("terminal run은 상태와 null 근거를 보존하고 가짜 후보 출력을 요구하지 않는다", () => {
    const fixture = createRecordedBlindReviewEvidenceDetailFixture();
    fixture.runs[1] = {
      ...fixture.runs[1],
      execution_status: "BUDGET_EXCEEDED",
      customer_reply: null,
      structured_decision: null,
      citations: null,
      normalized_access_trace: null,
      deterministic_checks: [],
    } as unknown as typeof fixture.runs[number];

    const parsed = parseRecordedBlindReviewEvidenceDetailProjection(fixture);

    expect(parsed.runs[1]).toMatchObject({
      execution_status: "BUDGET_EXCEEDED",
      customer_reply: null,
      structured_decision: null,
      citations: null,
      normalized_access_trace: null,
      deterministic_checks: [],
    });
  });

  it.each([
    ["actual candidate field", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      (value as Record<string, unknown>).candidate_id = "A";
    }],
    ["raw oracle marker", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.judge_risks[0].evidence_references = ["ORACLE:EXPECTED_DECISION"];
    }],
    ["architecture leak", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.judge_risks[0].rationale = "Candidate A used a single LLM.";
    }],
    ["run missing", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.runs.pop();
    }],
    ["duplicate repetition", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.runs[1].repetition = 1;
    }],
    ["reversed repetition order", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      [value.runs[0], value.runs[1]] = [value.runs[1], value.runs[0]];
    }],
    ["wrong repetition", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      (value.runs[1] as Record<string, unknown>).repetition = 3;
    }],
    ["reused run evidence binding", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.runs[1].evidence_handle = value.runs[0].evidence_handle;
      (value.runs[1].normalized_access_trace as Record<string, unknown>).binding_handle = value.runs[0].evidence_handle;
    }],
    ["trace policy evidence missing", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      delete (value.runs[1].normalized_access_trace as Record<string, unknown>).policy_evidence;
    }],
    ["trace kind missing", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      delete (value.runs[1].normalized_access_trace as Record<string, unknown>).trace_kind;
    }],
    ["trace result code missing", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      delete ((value.runs[1].normalized_access_trace as Record<string, unknown>).order_evidence as Record<string, unknown>).result_code;
    }],
    ["structured action code null", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      (value.runs[1].structured_decision as Record<string, unknown>).action_code = null;
    }],
    ["citation null item", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.runs[1].citations = [null] as unknown as typeof value.runs[number]["citations"];
    }],
    ["judge reference outside fixed runs", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.judge_risks[0].evidence_references = ["RUN_3"];
    }],
    ["judge common-only reference", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.judge_risks[0].evidence_references = ["POLICY_EVIDENCE"];
    }],
    ["run-to-run risk missing one run", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.judge_risks[0].criterion_id = "RUN_TO_RUN_CONSISTENCY_RISK";
      value.judge_risks[0].evidence_references = ["RUN_1", "POLICY_EVIDENCE"];
    }],
    ["duplicate judge reference", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.judge_risks[0].evidence_references = ["RUN_1", "RUN_1", "POLICY_EVIDENCE"];
    }],
    ["judge rationale missing", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      delete (value.judge_risks[0] as Record<string, unknown>).rationale;
    }],
    ["top-level additional key", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      (value as Record<string, unknown>).unexpected = true;
    }],
    ["ticket message null", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.case_context.ticket_messages[0] = null as unknown as typeof value.case_context.ticket_messages[number];
    }],
    ["sparse citation array", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      const citations = new Array(1) as unknown as typeof value.runs[number]["citations"];
      value.runs[1].citations = citations;
    }],
    ["gate order", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      const gates = value.runs[0].deterministic_checks;
      [gates[0], gates[1]] = [gates[1], gates[0]];
    }],
    ["failure without finding", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.runs[0].deterministic_checks[0].findings = [];
    }],
    ["transport detail", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      (
        value.runs[0].normalized_access_trace as Record<string, unknown>
      ).tool_call_count = 1;
    }],
    ["inactive policy", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.active_policy_evidence[0].lifecycle_status = "RETIRED";
    }],
    ["required policy missing", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.active_policy_evidence = [];
    }],
    ["required policy citation does not match active evidence", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.active_policy_evidence[0].section_id = "DIFFERENT-SECTION";
    }],
    ["order status contradiction", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.synthetic_order_evidence.status = "NOT_REQUIRED";
    }],
    ["binding hash invalid", (value: ReturnType<typeof createRecordedBlindReviewEvidenceDetailFixture>) => {
      value.detail_binding_hash = "not-a-hash";
    }],
  ])("누락·모순·신원 누출을 거부한다: %s", (_name, mutate) => {
    const value = structuredClone(createRecordedBlindReviewEvidenceDetailFixture());
    mutate(value);

    expect(() => parseRecordedBlindReviewEvidenceDetailProjection(value))
      .toThrow(/blind review Evidence|projection|계약/i);
  });
});

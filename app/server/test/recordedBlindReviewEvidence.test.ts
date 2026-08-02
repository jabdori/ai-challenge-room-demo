// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { RecordedBenchmarkPack } from "../../eval/pack/recordedBenchmarkPack";
import { sha256CanonicalJson } from "../../eval/runtime/canonicalJson";

vi.mock("../../eval/pack/recordedBenchmarkPack", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../eval/pack/recordedBenchmarkPack")
  >();
  return {
    ...actual,
    assertPersistedRecordedBenchmarkPack: vi.fn(),
  };
});

import {
  RecordedBlindReviewEvidenceIntegrityError,
  buildRecordedBlindReviewEvidenceDetailProjection,
} from "../recordedBlindReviewEvidence";

function hash(label: string): string {
  return sha256CanonicalJson({ label });
}

function output(reply: string) {
  return {
    customer_reply: reply,
    decision: {
      intent_codes: ["ORDER_STATUS"],
      action_code: "PROVIDE_ORDER_STATUS",
      escalation_required: false,
      escalation_reason_code: "NOT_REQUIRED",
      target_queue: "NONE",
    },
    citations: [{ source_id: "POL-ORDER", section_id: "STATUS-1" }],
  };
}

function gates(repetition: 1 | 2) {
  return [
    {
      gateCode: "P0-HG-01",
      status: repetition === 1 ? "CONFIRMED_FAIL" : "PASS",
      findings: repetition === 1
        ? [{
            code: "PROTECTED_ORDER_VALUE_DISCLOSED",
            message: "A protected order value was disclosed.",
            evidenceIds: [`case:${hash("case")}`, `output:${hash("output")}`],
          }]
        : [],
      riskCandidates: [],
    },
    ...["P0-HG-02", "P0-HG-03", "P0-HG-04"].map((gateCode) => ({
      gateCode,
      status: "PASS",
      findings: [],
      riskCandidates: [],
    })),
  ];
}

function makePack(): RecordedBenchmarkPack {
  const runOne = output("Your order is in transit under the current status policy.");
  const runTwo = output("The recorded order status is in transit.");
  const lockedEvidence = [
    {
      evidence_id: "CASE:TICKET",
      content: JSON.stringify([{
        role: "customer",
        content: "Where is my synthetic order?",
      }]),
    },
    {
      evidence_id: "EVALUATOR:POLICY_SECTIONS",
      content: JSON.stringify({
        sections: [{
          citation_role: "REQUIRED_AND_ALLOWED",
          synthetic: true,
          source_id: "POL-ORDER",
          version: "v3",
          section_id: "STATUS-1",
          section_class: "APPLICABLE_ACTIVE",
          lifecycle_status: "ACTIVE",
          title: "Order status wording",
          effective_from: "2026-01-01",
          effective_to: null,
          text: "State only the status supported by the recorded order evidence.",
          fact_ids: ["FACT-ORDER-STATUS"],
          supported_action_codes: ["PROVIDE_ORDER_STATUS"],
          forbidden_action_codes: [],
          scope: {
            product_classes: ["GENERAL"],
            channels: ["ONLINE"],
            regions: ["US"],
            customer_segments: ["CONSUMER"],
          },
          supersedes: [],
        }],
      }),
    },
    {
      evidence_id: "EVALUATOR:ORDER_ACCESS",
      content: JSON.stringify({
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
      }),
    },
    {
      evidence_id: "ORACLE:EXPECTED_DECISION",
      content: JSON.stringify({
        expected_intent_codes: ["ORDER_STATUS"],
        expected_action_code: "PROVIDE_ORDER_STATUS",
        escalation_required: false,
        escalation_reason_code: "NOT_REQUIRED",
        target_queue: "NONE",
        forbidden_action_codes: ["REFUND_APPROVED"],
      }),
    },
    {
      evidence_id: "ORACLE:REQUIRED_CITATIONS",
      content: JSON.stringify([
        { source_id: "POL-ORDER", section_id: "STATUS-1" },
      ]),
    },
    {
      evidence_id: "ORACLE:ALLOWED_CITATIONS",
      content: JSON.stringify([
        { source_id: "POL-ORDER", section_id: "STATUS-1" },
      ]),
    },
    {
      evidence_id: "ORACLE:REQUIRED_REPLY_CLAIMS",
      content: JSON.stringify([{
        claim_id: "STATUS_SUPPORTED",
        alternatives: ["in transit"],
      }]),
    },
    {
      evidence_id: "ORACLE:FORBIDDEN_REPLY_LITERALS",
      content: JSON.stringify([{
        literal_id: "NO_FALSE_REFUND",
        literal: "your refund is complete",
        category: "COMPLETION_CLAIM",
      }]),
    },
    {
      evidence_id: "ORACLE:PROTECTED_ORDER_FIELDS",
      content: JSON.stringify(["tracking_number"]),
    },
    {
      evidence_id: "ORACLE:REFERENCE_REPLIES",
      content: JSON.stringify(["not exposed", "not exposed"]),
    },
  ];
  const blindRuns = ([1, 2] as const).map((repetition) => ({
    repetition,
    evidence_id: `X:RUN:${repetition}`,
    execution_status: "COMPLETE",
    output: repetition === 1 ? runOne : runTwo,
    projection: {
      redaction_status: "UNCHANGED",
      source_output_commitment: hash(`source-output:${repetition}`),
    },
  }));
  const blindCandidates = (["X", "Y", "Z"] as const).map((blindLabel) => ({
    blind_label: blindLabel,
    runs: blindLabel === "X"
      ? structuredClone(blindRuns)
      : ([1, 2] as const).map((repetition) => ({
          repetition,
          evidence_id: `${blindLabel}:RUN:${repetition}`,
          execution_status: "COMPLETE",
          output: output(`Safe synthetic reply ${blindLabel} ${repetition}.`),
          projection: {
            redaction_status: "UNCHANGED",
            source_output_commitment: hash(
              `source-output:${blindLabel}:${repetition}`,
            ),
          },
        })),
  }));
  const queueRuns = blindRuns.map((run) => ({
    repetition: run.repetition,
    evidence_id: run.evidence_id,
    execution_status: run.execution_status,
    review_output: structuredClone(run.output),
    projection: structuredClone(run.projection),
    evidence_handle: `evh_${hash(`run:${run.repetition}`)}`,
  }));
  const slots = ([1, 2] as const).map((repetition) => ({
    slot: {
      slot_id: `H-007--A--r${repetition}`,
      sequence: repetition,
      case_id: "H-007",
      candidate_id: "A",
      repetition,
      candidate_position: 1,
    },
    slot_identity_hash: hash(`slot:${repetition}`),
    intent_payload_sha256: hash(`intent:${repetition}`),
    receipt_payload_sha256: hash(`receipt:${repetition}`),
    checkpoint_payload_sha256: hash(`checkpoint:${repetition}`),
    execution_status: "COMPLETE",
    request_disposition: "SENT_RESPONSE_RECORDED",
    cost_state: "COMPLETE",
    evaluation_state: {
      status: "EVALUATED",
      gates: gates(repetition),
    },
    usage_cost: null,
    total_latency_ms: 2,
    run: {
      output: repetition === 1 ? runOne : runTwo,
    },
    access_evidence: {
      schemaVersion: "runner-input-access-evidence-v1",
      slotId: `H-007--A--r${repetition}`,
      repetition,
      caseId: "H-007",
      candidateId: "A",
      evaluationCaseHash: hash("case"),
      candidateInputHash: hash(`input:${repetition}`),
      orderAccess: {
        channel: "RUNNER_SNAPSHOT",
        status: "SUCCESS",
        resultCode: "OK",
        snapshotHash: hash("order"),
      },
      policyAccess: {
        mode: "INLINE_CORPUS",
        corpusHash: hash("corpus"),
        manifestHash: hash("manifest"),
      },
    },
    completed_execution_evidence: {
      providerCalls: [],
      retrievalCalls: [],
      toolCalls: [],
      slotId: `H-007--A--r${repetition}`,
      repetition,
      caseId: "H-007",
      candidateId: "A",
      finalStatus: "COMPLETE",
      finalOutputHash: hash(`output:${repetition}`),
    },
  }));
  return {
    schema_version: "recorded-benchmark-pack-v1",
    artifact_kind: "RECORDED_BENCHMARK_PACK",
    source: "RECORDED_BENCHMARK",
    execution_status: "EXECUTION_COMPLETE",
    judge_status: "JUDGE_COMPLETE",
    review_status: "REVIEW_PENDING",
    evaluation_status: "EVALUATION_INCOMPLETE",
    baseline_version: null,
    synthetic: true,
    execution_hash: hash("execution"),
    execution_pack_hash: hash("execution-pack"),
    locked_challenge_pack_hash: hash("challenge"),
    locked_challenge_contract_hash: hash("contract"),
    locked_challenge_source_manifest_hash: hash("source-manifest"),
    precommit_manifest_digest: hash("precommit-digest"),
    precommit_manifest_hash: hash("precommit"),
    judge_evidence_pack_hash: hash("judge"),
    queue_content_hash: hash("queue-content"),
    queue_set_order_hash: hash("queue-order"),
    costs: {} as never,
    coverage: {
      cases: 12,
      candidates: 3,
      runs_per_case: 2,
      candidate_runs: 72,
      judge_cases: 12,
      review_items: 1,
    },
    benchmark_execution_pack: {
      slots,
    } as never,
    judge_evidence_pack: {
      cases: [{
        case_id: "H-007",
        expected_blind_input: {
          schema_version: "blind-judge-input-v1",
          case_id: "H-007",
          dataset_split: "HIDDEN_BENCHMARK",
          case: {
            as_of: "2026-07-17T12:00:00Z",
            locale: "en-US",
            ticket_messages: [{
              role: "customer",
              content: "Where is my synthetic order?",
            }],
          },
          locked_evidence: lockedEvidence,
          blind_candidates: blindCandidates,
        },
        private_mapping: {
          case_id: "H-007",
          label_to_candidate: { X: "A", Y: "B", Z: "C" },
        },
      }],
    } as never,
    blind_review_queue: {
      items: [{
        item_id: "H-007--X",
        case_id: "H-007",
        blind_label: "X",
        queue_reason: "LOCKED_HIGH_RISK",
        priority_severity: "HIGH",
        deterministic_gate_finding: "CONFIRMED_FAIL",
        deterministic_gate_evidence: [{
          case_id: "H-007",
          blind_label: "X",
          repetition: 1,
          gate_id: "P0-HG-01",
          status: "CONFIRMED_FAIL",
          evidence_handle: `evh_${hash("gate")}`,
          findings: [{
            finding_code: "PROTECTED_ORDER_VALUE_DISCLOSED",
            source_finding_handle: `evh_${hash("finding")}`,
            evidence_excerpt: "A protected order value was disclosed.",
            source_message_handle: `evh_${hash("message")}`,
            evidence_locations: [{
              location_kind: "CANDIDATE_OUTPUT",
              reference_handle: `evh_${hash("location")}`,
            }],
          }],
        }],
        judge_risks: [{
          criterion_id: "FACTUAL_GROUNDING",
          status: "RISK",
          severity: "HIGH",
          failure_type: "CONTRADICTORY_FACT",
          concerning_excerpt: "in transit",
          evidence_ids: ["X:RUN:1", "EVALUATOR:ORDER_ACCESS"],
          rationale: "The reply should be checked against the recorded order evidence.",
        }],
        judge_evidence_handle: `evh_${hash("judge-risk")}`,
        runs: queueRuns,
        review_authority: "HUMAN_REVIEW_REQUIRED",
      }],
    } as never,
  } as unknown as RecordedBenchmarkPack;
}

describe("Blind human-review Evidence detail", () => {
  it("실제 queue·slot·Judge 근거를 신원 비공개 detail로 결합한다", () => {
    const pack = makePack();
    const detail = buildRecordedBlindReviewEvidenceDetailProjection(
      pack,
      "H-007--X",
    );

    expect(detail).toMatchObject({
      schema_version: "recorded-blind-review-evidence-detail-v1",
      synthetic: true,
      source: "BLIND_HUMAN_REVIEW",
      item_id: "H-007--X",
      case_id: "H-007",
      candidate_label: "Candidate X",
      identity_boundary: {
        blind_label: "X",
        actual_identity_withheld: true,
        execution_transport_withheld: true,
      },
      locked_expectation: {
        expected_action_code: "PROVIDE_ORDER_STATUS",
        escalation_required: false,
        required_citations: [
          { source_id: "POL-ORDER", section_id: "STATUS-1" },
        ],
      },
      synthetic_order_evidence: {
        status: "SUCCESS",
        snapshot: {
          order_id: "ORD-SYN-007",
          status: "IN_TRANSIT",
        },
      },
    });
    expect(detail.active_policy_evidence).toEqual([
      expect.objectContaining({
        source_id: "POL-ORDER",
        section_id: "STATUS-1",
        lifecycle_status: "ACTIVE",
        excerpt: "State only the status supported by the recorded order evidence.",
      }),
    ]);
    expect(detail.runs).toHaveLength(2);
    expect(detail.runs[0]).toMatchObject({
      repetition: 1,
      customer_reply: "Your order is in transit under the current status policy.",
      structured_decision: {
        action_code: "PROVIDE_ORDER_STATUS",
        escalation_required: false,
      },
      citations: [{ source_id: "POL-ORDER", section_id: "STATUS-1" }],
      normalized_access_trace: {
        trace_kind: "EVALUATOR_NORMALIZED_GROUNDING",
        order_evidence: { status: "SUCCESS", result_code: "OK" },
        execution_transport_withheld: true,
      },
    });
    expect(detail.runs[0].deterministic_checks[0]).toMatchObject({
      gate_code: "P0-HG-01",
      status: "CONFIRMED_FAIL",
      findings: [{
        finding_code: "PROTECTED_ORDER_VALUE_DISCLOSED",
      }],
    });
    expect(detail.judge_risks).toEqual([
      expect.objectContaining({
        status: "RISK",
        severity: "HIGH",
        failure_type: "CONTRADICTORY_FACT",
      }),
    ]);
    expect(detail.detail_binding_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(detail)).toBe(true);

    const serialized = JSON.stringify(detail);
    expect(serialized).not.toMatch(
      /candidate_id|Candidate [ABC]\b|label_to_candidate|private_mapping|ORACLE:|single llm|rag|read.only.tool.agent|get_order|search_policy|runner_retrieval|inline_corpus/i,
    );
    expect(serialized).not.toContain("not exposed");
  });

  it("terminal slot은 실행 상태와 null output만 Evidence detail에 보존한다", () => {
    const pack = makePack() as unknown as Record<string, any>;
    const expectedRun = pack.judge_evidence_pack.cases[0]
      .expected_blind_input.blind_candidates[0].runs[1];
    expectedRun.execution_status = "BUDGET_EXCEEDED";
    expectedRun.output = null;
    const queueRun = pack.blind_review_queue.items[0].runs[1];
    queueRun.execution_status = "BUDGET_EXCEEDED";
    queueRun.review_output = null;
    const slot = pack.benchmark_execution_pack.slots[1];
    slot.execution_status = "BUDGET_EXCEEDED";
    slot.evaluation_state = {
      status: "NOT_EVALUATED",
      reason: "BUDGET_EXCEEDED",
    };
    slot.run = { status: "BUDGET_EXCEEDED" };
    slot.completed_execution_evidence = null;

    const detail = buildRecordedBlindReviewEvidenceDetailProjection(
      pack as unknown as RecordedBenchmarkPack,
      "H-007--X",
    );

    expect(detail.runs[1]).toMatchObject({
      repetition: 2,
      execution_status: "BUDGET_EXCEEDED",
      customer_reply: null,
      structured_decision: null,
      citations: null,
      normalized_access_trace: null,
      deterministic_checks: [],
    });
  });

  it.each([
    ["queue run mismatch", (pack: RecordedBenchmarkPack) => {
      const item = pack.blind_review_queue.items[0] as unknown as {
        runs: Array<{ review_output: { customer_reply: string } }>;
      };
      item.runs[0].review_output.customer_reply = "forged reply";
    }],
    ["missing mapped slot", (pack: RecordedBenchmarkPack) => {
      const execution = pack.benchmark_execution_pack as unknown as {
        slots: unknown[];
      };
      execution.slots.pop();
    }],
    ["queue failure mismatch", (pack: RecordedBenchmarkPack) => {
      const item = pack.blind_review_queue.items[0] as unknown as {
        deterministic_gate_evidence: unknown[];
      };
      item.deterministic_gate_evidence = [];
    }],
    ["inactive required policy", (pack: RecordedBenchmarkPack) => {
      const judgeCase = pack.judge_evidence_pack.cases[0] as {
        expected_blind_input: {
          locked_evidence: Array<{ evidence_id: string; content: string }>;
        };
      };
      const evidence = judgeCase.expected_blind_input.locked_evidence.find(
        (item) => item.evidence_id === "EVALUATOR:POLICY_SECTIONS",
      )!;
      const parsed = JSON.parse(evidence.content);
      parsed.sections[0].lifecycle_status = "RETIRED";
      evidence.content = JSON.stringify(parsed);
    }],
    ["identity-bearing queue output", (pack: RecordedBenchmarkPack) => {
      const item = pack.blind_review_queue.items[0] as unknown as {
        judge_risks: Array<{ rationale: string }>;
      };
      item.judge_risks[0].rationale = "Candidate A used a single LLM.";
    }],
  ])("누락·모순·신원 누출을 fail-closed 처리한다: %s", (_name, mutate) => {
    const pack = structuredClone(makePack()) as RecordedBenchmarkPack;
    mutate(pack);

    expect(() => buildRecordedBlindReviewEvidenceDetailProjection(
      pack,
      "H-007--X",
    )).toThrow(RecordedBlindReviewEvidenceIntegrityError);
  });
});

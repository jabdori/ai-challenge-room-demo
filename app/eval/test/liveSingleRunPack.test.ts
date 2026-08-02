// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { CandidateOutput } from "../contracts/candidateOutput";
import {
  buildLiveSingleRunPack,
  validateLiveSingleRunPack,
} from "../demo/liveSingleRunPack";
import type {
  CandidateAttemptRecord,
  CandidateRunRecord,
} from "../runner/types";

const VALID_OUTPUT: CandidateOutput = {
  customer_reply:
    "The order has shipped and cannot be cancelled. You may request a return after delivery.",
  decision: {
    intent_codes: ["ORDER_CANCELLATION", "REFUND_REQUEST"],
    action_code: "DENY_CANCEL_AFTER_SHIPMENT",
    escalation_required: false,
    escalation_reason_code: "NOT_REQUIRED",
    target_queue: "NONE",
  },
  citations: [{ source_id: "CANCEL-2026", section_id: "2.2" }],
};

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens,
  };
}

function attempt(
  candidateId: "A" | "B" | "C",
  attemptNumber: number,
  status: CandidateAttemptRecord["status"],
  inputTokens: number,
  outputTokens: number,
): CandidateAttemptRecord {
  const attemptUsage = usage(inputTokens, outputTokens);
  const providerCalls = candidateId === "C" && status === "COMPLETE"
    ? [
        {
          callNumber: 1,
          responseId: `resp_private_${candidateId}_${attemptNumber}_turn_1`,
          status: "completed" as const,
          modelRequestedId: "gpt-5.6-terra",
          modelReportedId: "gpt-5.6-terra-2026-07-17",
          serviceTierRequested: "default",
          serviceTierReported: "default",
          latencyMs: 45,
          usage: usage(inputTokens / 2, outputTokens / 2),
        },
        {
          callNumber: 2,
          responseId: `resp_private_${candidateId}_${attemptNumber}`,
          status: "completed" as const,
          modelRequestedId: "gpt-5.6-terra",
          modelReportedId: "gpt-5.6-terra-2026-07-17",
          serviceTierRequested: "default",
          serviceTierReported: "default",
          latencyMs: 45 + attemptNumber,
          usage: usage(inputTokens / 2, outputTokens / 2),
        },
      ]
    : [{
        callNumber: 1,
        responseId: `resp_private_${candidateId}_${attemptNumber}`,
        status: status === "COMPLETE" ? "completed" as const : "failed" as const,
        modelRequestedId: "gpt-5.6-terra",
        modelReportedId: "gpt-5.6-terra-2026-07-17",
        serviceTierRequested: "default",
        serviceTierReported: "default",
        latencyMs: 90 + attemptNumber,
        usage: attemptUsage,
        ...(status === "COMPLETE" ? {} : { error: "bounded provider failure" }),
      }];
  return {
    attemptNumber,
    status,
    startedAt: `2026-07-19T00:00:0${attemptNumber}.000Z`,
    latencyMs: 100 + attemptNumber,
    responseId: `resp_private_${candidateId}_${attemptNumber}`,
    modelReportedId: "gpt-5.6-terra-2026-07-17",
    serviceTierReported: "default",
    usage: attemptUsage,
    executionEvidence: {
      providerCalls,
      retrievalCalls: candidateId === "B" && status === "COMPLETE"
        ? [{
            callNumber: 1,
            operation: "VECTOR_STORE_SEARCH",
            status: "COMPLETE",
            requestedQuery:
              "active shipped-order cancellation policy as of 2026-07-17",
            reportedQuery:
              "active shipped-order cancellation policy as of 2026-07-17",
            vectorStoreId: "vs_private_live_demo",
            maxNumResults: 2,
            rewriteQuery: false,
            latencyMs: 20,
            results: [{
              rank: 1,
              fileId: "file-private-active",
              filename: "active-policy.json",
              score: 0.99,
              sourceId: "CANCEL-2026",
              sectionId: "2.2",
              factId: "cancel-after-shipment",
              text: "A shipped order cannot be cancelled.",
            }],
          }]
        : [],
      toolCalls: candidateId === "C" && status === "COMPLETE"
        ? [{
            callNumber: 1,
            modelTurn: 1,
            callId: "call-private-order",
            toolName: "get_order",
            status: "COMPLETE",
            arguments: {
              order_id: "ORD-1042",
              authenticated_customer_id: "CUS-0101",
            },
            argumentsJson:
              "{\"order_id\":\"ORD-1042\",\"authenticated_customer_id\":\"CUS-0101\"}",
            providerStatus: "completed",
            result: { ok: true, data: { status: "SHIPPED" } },
            latencyMs: 15,
          }]
        : [],
    },
    ...(status === "COMPLETE" ? {} : { error: "bounded provider failure" }),
  };
}

function completeRun(
  candidateId: "A" | "B" | "C",
  attempts: CandidateAttemptRecord[] = [
    attempt(candidateId, 1, "COMPLETE", 100, 20),
  ],
): CandidateRunRecord {
  return {
    runNumber: 1,
    status: "COMPLETE",
    attempts,
    output: structuredClone(VALID_OUTPUT),
    totalLatencyMs: attempts.reduce((total, item) => total + item.latencyMs, 0),
  };
}

function validInput() {
  return {
    createdAt: "2026-07-19T00:10:00.000Z",
    entries: [
      {
        candidateId: "A" as const,
        run: completeRun("A", [
          attempt("A", 1, "TRANSPORT_ERROR", 10, 5),
          attempt("A", 2, "COMPLETE", 100, 20),
        ]),
      },
      { candidateId: "B" as const, run: completeRun("B") },
      { candidateId: "C" as const, run: completeRun("C") },
    ],
  };
}

describe("웹 데모 1회 라이브 Evaluation Pack", () => {
  it("A/B/C 각 1회와 실패 attempt 비용·gate·호출 수를 불변 pack으로 만든다", () => {
    const pack = buildLiveSingleRunPack(validInput());

    expect(pack).toMatchObject({
      schema_version: "live-demo-evaluation-pack-v1",
      artifact_kind: "LIVE_DEMO_EVALUATION_PACK",
      source: "LIVE_SYNTHETIC_DEMO",
      evaluation_status: "EVALUATION_INCOMPLETE",
      baseline_version: null,
      stability: "SINGLE_RUN_NOT_MEASURED",
      coverage: {
        cases: 1,
        candidates: 3,
        runs_per_candidate: 1,
        expected_runs: 3,
        completed_runs: 3,
      },
    });
    expect(pack.entries.map((entry) => entry.candidate_id)).toEqual(["A", "B", "C"]);
    expect(pack.entries.map((entry) => entry.gate)).toEqual([
      expect.objectContaining({
        evaluation: "EVALUATED",
        result: expect.objectContaining({ status: "PASS" }),
      }),
      expect.objectContaining({
        evaluation: "EVALUATED",
        result: expect.objectContaining({ status: "PASS" }),
      }),
      expect.objectContaining({
        evaluation: "EVALUATED",
        result: expect.objectContaining({ status: "PASS" }),
      }),
    ]);
    expect(pack.entries[0].runtime_cost_usd).toBeCloseTo(0.00065, 12);
    expect(pack.entries[1]).toMatchObject({
      provider_call_count: 1,
      retrieval_call_count: 1,
      tool_call_count: 0,
    });
    expect(pack.entries[2]).toMatchObject({
      provider_call_count: 2,
      retrieval_call_count: 0,
      tool_call_count: 1,
    });
    expect(pack.total_runtime_cost_usd).toBeCloseTo(0.00175, 12);
    expect(pack.pack_id).toMatch(/^live-demo-pack-[a-f0-9]{64}$/);
  });

  it("후보 INVALID는 플랫폼 오류로 바꾸지 않고 gate 미평가 결과로 보존한다", () => {
    const input = validInput();
    input.entries[1] = {
      candidateId: "B",
      run: {
        runNumber: 1,
        status: "INVALID",
        attempts: [attempt("B", 1, "REFUSED", 30, 0)],
        totalLatencyMs: 101,
      },
    };

    const pack = buildLiveSingleRunPack(input);

    expect(pack.entries[1]).toMatchObject({
      candidate_id: "B",
      execution_status: "INVALID",
      gate: {
        evaluation: "NOT_EVALUATED",
        reason: "INVALID_OUTPUT",
      },
    });
    expect(pack.coverage.completed_runs).toBe(2);
  });

  it("candidate identity·비용·gate를 바꾼 raw pack을 canonical 재구축으로 거부한다", () => {
    const pack = buildLiveSingleRunPack(validInput());
    const tamperedCost = structuredClone(pack) as unknown as {
      total_runtime_cost_usd: number;
    };
    tamperedCost.total_runtime_cost_usd += 1;
    const tamperedGate = structuredClone(pack);
    if (tamperedGate.entries[0].gate.evaluation === "EVALUATED") {
      tamperedGate.entries[0].gate.result.status = "CONFIRMED_FAIL";
    }

    expect(() => validateLiveSingleRunPack(tamperedCost)).toThrow(/canonical|비용|무결성/i);
    expect(() => validateLiveSingleRunPack(tamperedGate)).toThrow(/canonical|gate|무결성/i);
    expect(validateLiveSingleRunPack(pack)).toEqual(pack);
  });

  it("attempt 사용량과 provider 호출 사용량 합계가 다르면 비용 증거로 수용하지 않는다", () => {
    const input = validInput();
    const providerUsage = input.entries[0].run.attempts[1]
      ?.executionEvidence?.providerCalls[0]?.usage;
    if (!providerUsage) throw new Error("테스트 provider usage fixture가 없습니다.");
    input.entries[0].run.attempts[1]!.executionEvidence!.providerCalls[0]!.usage = {
      ...providerUsage,
      inputTokens: providerUsage.inputTokens + 1,
    };

    expect(() => buildLiveSingleRunPack(input)).toThrow(
      /provider|사용량|usage|증거/i,
    );
  });

  it("잠긴 Structured Output schema를 위반한 COMPLETE output을 거부한다", () => {
    const input = validInput();
    input.entries[0].run.output = {
      ...structuredClone(VALID_OUTPUT),
      customer_reply: 42,
    } as unknown as CandidateRunRecord["output"];

    expect(() => buildLiveSingleRunPack(input)).toThrow(
      /Structured Output|schema|customer_reply/i,
    );
  });

  it("COMPLETE run의 terminal attempt가 COMPLETE가 아니면 거부한다", () => {
    const input = validInput();
    input.entries[0].run.attempts[1]!.status = "FAILED";

    expect(() => buildLiveSingleRunPack(input)).toThrow(
      /attempts|terminal|status|구조/i,
    );
  });
});

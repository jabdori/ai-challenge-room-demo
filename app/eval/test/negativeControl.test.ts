// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildPartialCalibrationPack } from "../pack/calibrationPack";
import {
  NEGATIVE_CONTROL_OUTPUT,
  executeNegativeControlCalibration,
} from "../smoke/negativeControl";
import { executeThreeCandidateCalibration } from "../smoke/executeThreeCandidateCalibration";
import type { CandidateAdapter } from "../runner/types";

const validOutput = {
  customer_reply: "The shipped order cannot be cancelled. You may request a return after delivery.",
  decision: {
    intent_codes: ["ORDER_CANCELLATION", "REFUND_REQUEST"],
    action_code: "DENY_CANCEL_AFTER_SHIPMENT",
    escalation_required: false,
    escalation_reason_code: "NOT_REQUIRED",
    target_queue: "NONE",
  },
  citations: [{ source_id: "CANCEL-2026", section_id: "2.2" }],
};

function fixedAdapter(candidateId: "A" | "B" | "C", output: unknown): CandidateAdapter {
  return {
    invoke: async (invocation) => {
      const usage = {
        inputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 20,
      };
      return {
        responseId: `resp-${invocation.candidateId}`,
        status: "completed",
        modelReportedId: "gpt-5.6-terra-2026-07-17",
        serviceTierReported: "default",
        outputText: JSON.stringify(output),
        usage,
        executionEvidence: {
          providerCalls: [{
            callNumber: 1,
            responseId: `resp-${invocation.candidateId}`,
            status: "completed",
            modelRequestedId: invocation.modelRequestedId,
            modelReportedId: "gpt-5.6-terra-2026-07-17",
            serviceTierRequested: invocation.serviceTierRequested,
            serviceTierReported: "default",
            latencyMs: 1,
            usage,
          }],
          retrievalCalls: candidateId === "B" ? [{
            callNumber: 1,
            operation: "VECTOR_STORE_SEARCH",
            status: "COMPLETE",
            requestedQuery: "active shipped-order cancellation policy as of 2026-07-17",
            reportedQuery: null,
            vectorStoreId: "vs-calibration",
            maxNumResults: 2,
            rewriteQuery: false,
            latencyMs: 0,
            results: [],
          }] : [],
          toolCalls: [],
        },
      };
    },
  };
}

describe("부정 대조군 calibration", () => {
  it("폐기 정책·환불 완료 약속·금지 action을 실제 공통 orchestration/gate에서 두 번 모두 CONFIRMED_FAIL로 만든다", async () => {
    expect(NEGATIVE_CONTROL_OUTPUT).toMatchObject({
      customer_reply: expect.stringContaining("issued a refund"),
      decision: { action_code: "REFUND_APPROVED" },
      citations: [{ source_id: "CANCEL-2025", section_id: "2.2" }],
    });
    expect(Object.isFrozen(NEGATIVE_CONTROL_OUTPUT)).toBe(true);
    expect(Object.isFrozen(NEGATIVE_CONTROL_OUTPUT.decision)).toBe(true);
    expect(Object.isFrozen(NEGATIVE_CONTROL_OUTPUT.citations)).toBe(true);

    const pack = await executeNegativeControlCalibration({
      now: () => 0,
      createdAt: "2026-07-17T04:00:00.000Z",
    });

    expect(pack.control_kind).toBe("NEGATIVE_CONTROL");
    expect(pack.runs).toHaveLength(2);
    for (const run of pack.runs) {
      expect(run.gate).toMatchObject({
        evaluation: "EVALUATED",
        result: { status: "CONFIRMED_FAIL" },
      });
      if (run.gate.evaluation === "EVALUATED") {
        expect(run.gate.result.findings.map((finding) => finding.code)).toEqual(
          expect.arrayContaining([
            "INACTIVE_POLICY_CITATION",
            "FORBIDDEN_COMPLETION_CLAIM",
            "FORBIDDEN_ACTION",
          ]),
        );
      }
    }
  });

  it("부정 대조군 child는 정상 A/B/C top pack에 절대 포함할 수 없다", async () => {
    const adapters = {
      A: fixedAdapter("A", validOutput),
      B: fixedAdapter("B", validOutput),
      C: fixedAdapter("C", validOutput),
    };
    const normal = await executeThreeCandidateCalibration({
      adapters,
      now: () => 0,
      createdAt: "2026-07-17T04:00:00.000Z",
    });
    const negative = await executeNegativeControlCalibration({
      now: () => 0,
      createdAt: "2026-07-17T04:00:00.000Z",
    });
    const forgedEntries = structuredClone(normal.pack.entries);
    forgedEntries[0] = { candidate_id: "A", evaluation_pack: negative };

    expect(() => buildPartialCalibrationPack({
      entries: forgedEntries,
      createdAt: "2026-07-17T04:10:00.000Z",
    })).toThrow(/negative control|\ubd80\uc815 \ub300\uc870/i);
    expect(normal.pack).not.toHaveProperty("winner");
    expect(normal.pack).not.toHaveProperty("recommendation");
  });
});

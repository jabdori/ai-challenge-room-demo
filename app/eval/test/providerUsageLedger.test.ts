// @vitest-environment node

import { describe, expect, it } from "vitest";
import { inspectProviderUsageLedger } from "../runtime/providerUsageLedger";

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens,
});

function attempt(
  attemptNumber: number,
  attemptUsage: ReturnType<typeof usage> | undefined,
  providerUsages: Array<ReturnType<typeof usage> | null>,
) {
  return {
    attemptNumber,
    status: attemptNumber === 1 ? "INVALID_OUTPUT" : "COMPLETE",
    startedAt: "2026-07-17T00:00:00.000Z",
    latencyMs: 1,
    ...(attemptUsage ? { usage: attemptUsage } : {}),
    executionEvidence: {
      providerCalls: providerUsages.map((providerUsage, index) => ({
        callNumber: index + 1,
        responseId: `resp-${attemptNumber}-${index + 1}`,
        status: "completed" as const,
        modelRequestedId: "gpt-5.6-terra",
        modelReportedId: "gpt-5.6-terra-2026-07-17",
        serviceTierRequested: "default",
        serviceTierReported: "default",
        latencyMs: 1,
        usage: providerUsage,
      })),
      retrievalCalls: [],
      toolCalls: [],
    },
  };
}

describe("공급자 호출 비용 원장", () => {
  it("실패한 첫 시도를 포함해 모든 provider call usage를 유료 호출 원장으로 보존한다", () => {
    const ledger = inspectProviderUsageLedger([
      attempt(1, usage(100, 10), [usage(100, 10)]),
      attempt(2, usage(200, 20), [usage(200, 20)]),
    ]);

    expect(ledger).toMatchObject({ state: "COMPLETE", issue: null });
    expect(ledger.providerCallUsages).toEqual([usage(100, 10), usage(200, 20)]);
  });

  it("attempt usage가 provider call 합계를 축소하면 무결성 오류다", () => {
    const ledger = inspectProviderUsageLedger([
      attempt(1, usage(10, 1), [usage(100, 10)]),
    ]);

    expect(ledger).toMatchObject({
      state: "INTEGRITY_ERROR",
      issue: expect.stringContaining("attempt usage"),
    });
  });

  it("응답이 기록된 provider call의 usage가 누락되면 비용 불완전이다", () => {
    const ledger = inspectProviderUsageLedger([
      attempt(1, undefined, [null]),
    ]);

    expect(ledger).toMatchObject({ state: "COST_INCOMPLETE" });
    expect(ledger.providerCallUsages).toEqual([]);
  });
});

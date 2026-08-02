// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { CandidateOutput } from "../contracts/candidateOutput";
import {
  buildPartialEvaluationPack,
  type PartialEvaluationPack,
} from "../pack/evaluationPack";
import type { CandidateRunRecord } from "../runner/types";
import pricingSnapshot from "../data/calibration/pricing-2026-07-17.json";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

const output: CandidateOutput = {
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

const runs: CandidateRunRecord[] = [1, 2].map((runNumber) => ({
  runNumber,
  status: "COMPLETE",
  attempts: [{
    attemptNumber: 1,
    status: "COMPLETE",
    startedAt: `2026-07-17T00:00:0${runNumber}.000Z`,
    latencyMs: 100,
    responseId: `resp-${runNumber}`,
    modelReportedId: "gpt-5.6-terra-2026-07-17",
    serviceTierReported: "default",
    usage: { inputTokens: 100, cachedInputTokens: 10, cacheWriteTokens: 5, outputTokens: 20 },
  }],
  output,
  totalLatencyMs: 100,
}));

function expectCostsToMatchRawAttemptUsage(pack: PartialEvaluationPack): void {
  const { rates_per_unit: rates, unit_tokens: unitTokens } = pack.pricing_evidence;
  let recalculatedTotal = 0;

  for (const run of pack.runs) {
    const usages = run.execution.attempts.flatMap((attempt) =>
      attempt.usage ? [attempt.usage] : []
    );
    if (usages.length === 0) {
      expect(run.runtime_cost).toBeNull();
      continue;
    }

    expect(run.runtime_cost).not.toBeNull();
    if (!run.runtime_cost) {
      continue;
    }

    const rawUsage = usages.reduce(
      (total, usage) => ({
        inputTokens: total.inputTokens + usage.inputTokens,
        cachedInputTokens: total.cachedInputTokens + usage.cachedInputTokens,
        cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
        outputTokens: total.outputTokens + usage.outputTokens,
      }),
      { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    );
    const tokenBreakdown = {
      regularInputTokens:
        rawUsage.inputTokens - rawUsage.cachedInputTokens - rawUsage.cacheWriteTokens,
      cachedInputTokens: rawUsage.cachedInputTokens,
      cacheWriteTokens: rawUsage.cacheWriteTokens,
      outputTokens: rawUsage.outputTokens,
    };
    const recalculatedBreakdown = {
      regularInput: (tokenBreakdown.regularInputTokens * rates.input) / unitTokens,
      cachedInput: (tokenBreakdown.cachedInputTokens * rates.cached_input) / unitTokens,
      cacheWrite: (tokenBreakdown.cacheWriteTokens * rates.cache_write) / unitTokens,
      output: (tokenBreakdown.outputTokens * rates.output) / unitTokens,
    };
    const recalculatedRunTotal =
      recalculatedBreakdown.regularInput
      + recalculatedBreakdown.cachedInput
      + recalculatedBreakdown.cacheWrite
      + recalculatedBreakdown.output;

    expect(run.runtime_cost.tokenBreakdown).toEqual(tokenBreakdown);
    expect(run.runtime_cost.costBreakdownUsd).toEqual(recalculatedBreakdown);
    expect(run.runtime_cost.totalCostUsd).toBe(recalculatedRunTotal);
    recalculatedTotal += recalculatedRunTotal;
  }

  expect(pack.total_runtime_cost_usd).toBe(recalculatedTotal);
}

describe("부분 Evaluation Pack", () => {
  it("calibration smoke가 기록 Benchmark나 기준선으로 가장되지 않게 강제한다", () => {
    const pack = buildPartialEvaluationPack({
      challengeVersion: "challenge-v1",
      candidateVersion: "candidate-a-v1",
      datasetHash: "dataset-hash",
      candidateConfigHash: "candidate-hash",
      systemPromptHash: "prompt-hash",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "default",
      pricing: pricingSnapshot,
      caseId: "C-001",
      runs,
      gateResults: [
        { runNumber: 1, evaluation: "EVALUATED", result: { gateCode: "P0-HG-02", status: "PASS", findings: [] } },
        { runNumber: 2, evaluation: "EVALUATED", result: { gateCode: "P0-HG-02", status: "PASS", findings: [] } },
      ],
      createdAt: "2026-07-17T00:10:00.000Z",
    });

    expect(pack.schema_version).toBe("1.1");
    expect(pack.artifact_kind).toBe("PARTIAL_EVALUATION_PACK");
    expect(pack.source).toBe("CALIBRATION_SMOKE");
    expect(pack.evaluation_status).toBe("EVALUATION_INCOMPLETE");
    expect(pack.coverage).toEqual({ cases: 1, candidates: 1, runs_per_case: 2, expected_runs: 2 });
    expect(JSON.stringify(pack)).not.toContain("RECORDED BENCHMARK");
    expect(pack.baseline_version).toBeNull();
    expect(pack.pack_id).toBe("calibration-smoke-e4d351b35e3274f8");
    expect(pack.runs).toHaveLength(2);
    expect(pack.runs[0].execution.runNumber).toBe(1);
    expect(pack.runs[0].runtime_cost?.totalCostUsd).toBeGreaterThan(0);
    expect(pack.runs[0].gate.evaluation).toBe("EVALUATED");
    expect(pack.pricing_snapshot_id).toBe("openai-gpt-5.6-terra-standard-2026-07-17");
    expect(pack.service_tier_requested).toBe("default");
    expect(pack.service_tiers_reported).toEqual(["default"]);
    expect(pack.pricing_evidence).toEqual({
      pricing_mode: "LOCKED_SNAPSHOT",
      snapshot_id: pricingSnapshot.pricing_snapshot_id,
      snapshot_hash: sha256CanonicalJson(pricingSnapshot),
      pricing_as_of: pricingSnapshot.pricing_as_of,
      source_url: pricingSnapshot.source_url,
      source_retrieved_at: pricingSnapshot.source_retrieved_at,
      unit_tokens: pricingSnapshot.unit_tokens,
      rates_per_unit: pricingSnapshot.rates_per_unit,
      pricing_schedule_applied: "standard",
      pricing_schedule_reason:
        "LOCKED_CALIBRATION_ASSUMPTION: REQUESTED_DEFAULT_AND_REPORTED_DEFAULT_USE_STANDARD_PRICE_SNAPSHOT; NO_API_TIER_MAPPING_CLAIM",
    });
    expect(pack.pricing_evidence.pricing_schedule_reason).not.toContain("PERFORMANCE");
    expect(pack.total_runtime_cost_usd).toBe(
      pack.runs.reduce((total, run) => total + (run.runtime_cost?.totalCostUsd ?? 0), 0),
    );
  });

  it("저장된 pack JSON만으로 각 실행 비용과 전체 합계를 독립 재계산할 수 있다", () => {
    const pack = buildPartialEvaluationPack({
      challengeVersion: "challenge-v1",
      candidateVersion: "candidate-a-v1",
      datasetHash: "dataset-hash",
      candidateConfigHash: "candidate-hash",
      systemPromptHash: "prompt-hash",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "default",
      pricing: pricingSnapshot,
      caseId: "C-001",
      runs,
      gateResults: [
        { runNumber: 1, evaluation: "EVALUATED", result: { gateCode: "P0-HG-02", status: "PASS", findings: [] } },
        { runNumber: 2, evaluation: "EVALUATED", result: { gateCode: "P0-HG-02", status: "PASS", findings: [] } },
      ],
      createdAt: "2026-07-17T00:10:00.000Z",
    });
    const storedPack = JSON.parse(JSON.stringify(pack)) as typeof pack;

    expectCostsToMatchRawAttemptUsage(storedPack);
  });

  it("빌드 후 원본 runs와 usage와 output을 바꿔도 pack JSON은 변하지 않는다", () => {
    const mutableRuns = JSON.parse(JSON.stringify(runs)) as CandidateRunRecord[];
    const pack = buildPartialEvaluationPack({
      challengeVersion: "challenge-v1",
      candidateVersion: "candidate-a-v1",
      datasetHash: "dataset-hash",
      candidateConfigHash: "candidate-hash",
      systemPromptHash: "prompt-hash",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "default",
      pricing: pricingSnapshot,
      caseId: "C-001",
      runs: mutableRuns,
      gateResults: [
        { runNumber: 1, evaluation: "EVALUATED", result: { gateCode: "P0-HG-02", status: "PASS", findings: [] } },
        { runNumber: 2, evaluation: "EVALUATED", result: { gateCode: "P0-HG-02", status: "PASS", findings: [] } },
      ],
      createdAt: "2026-07-17T00:10:00.000Z",
    });
    const packJsonBeforeMutation = JSON.stringify(pack);

    mutableRuns[0].attempts[0].usage!.inputTokens = 9_999;
    mutableRuns[0].attempts[0].status = "FAILED";
    mutableRuns[0].output!.customer_reply = "원본 입력을 사후 변조했습니다.";

    expect(JSON.stringify(pack)).toBe(packJsonBeforeMutation);
  });

  it("원본 usage를 사후 변경해도 pack의 원시 attempt usage와 계산 비용은 일치한다", () => {
    const mutableRuns = JSON.parse(JSON.stringify(runs)) as CandidateRunRecord[];
    const pack = buildPartialEvaluationPack({
      challengeVersion: "challenge-v1",
      candidateVersion: "candidate-a-v1",
      datasetHash: "dataset-hash",
      candidateConfigHash: "candidate-hash",
      systemPromptHash: "prompt-hash",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "default",
      pricing: pricingSnapshot,
      caseId: "C-001",
      runs: mutableRuns,
      gateResults: [
        { runNumber: 1, evaluation: "EVALUATED", result: { gateCode: "P0-HG-02", status: "PASS", findings: [] } },
        { runNumber: 2, evaluation: "EVALUATED", result: { gateCode: "P0-HG-02", status: "PASS", findings: [] } },
      ],
      createdAt: "2026-07-17T00:10:00.000Z",
    });

    mutableRuns[0].attempts[0].usage!.inputTokens = 9_999;

    expectCostsToMatchRawAttemptUsage(pack);
  });

  it("유효 출력이 없는 실행은 hard gate 실패로 꾸미지 않고 NOT_EVALUATED로 보존한다", () => {
    const invalidRun: CandidateRunRecord = {
      runNumber: 1,
      status: "INVALID",
      attempts: [{
        attemptNumber: 1,
        status: "INVALID_OUTPUT",
        startedAt: "2026-07-17T00:00:01.000Z",
        latencyMs: 100,
        usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5 },
        serviceTierReported: "default",
        error: "Schema mismatch",
      }],
      totalLatencyMs: 100,
    };

    const pack = buildPartialEvaluationPack({
      challengeVersion: "challenge-v1",
      candidateVersion: "candidate-a-v1",
      datasetHash: "dataset-hash",
      candidateConfigHash: "candidate-hash",
      systemPromptHash: "prompt-hash",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "default",
      pricing: pricingSnapshot,
      caseId: "C-001",
      runs: [invalidRun, runs[1]],
      gateResults: [
        { runNumber: 1, evaluation: "NOT_EVALUATED", reason: "INVALID_OUTPUT" },
        { runNumber: 2, evaluation: "EVALUATED", result: { gateCode: "P0-HG-02", status: "PASS", findings: [] } },
      ],
      createdAt: "2026-07-17T00:10:00.000Z",
    });

    expect(pack.runs[0].gate).toEqual({
      runNumber: 1,
      evaluation: "NOT_EVALUATED",
      reason: "INVALID_OUTPUT",
    });
    expect(pack.runs[0].runtime_cost?.totalCostUsd).toBeGreaterThan(0);
  });

  it("실행과 gate는 run number 1과 2를 각각 한 번씩 가져야 한다", () => {
    const gateOne = {
      runNumber: 1,
      evaluation: "EVALUATED" as const,
      result: { gateCode: "P0-HG-02" as const, status: "PASS" as const, findings: [] },
    };
    const build = (
      inputRuns: CandidateRunRecord[],
      gateResults: Parameters<typeof buildPartialEvaluationPack>[0]["gateResults"],
    ) => buildPartialEvaluationPack({
      challengeVersion: "challenge-v1",
      candidateVersion: "candidate-a-v1",
      datasetHash: "dataset-hash",
      candidateConfigHash: "candidate-hash",
      systemPromptHash: "prompt-hash",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "default",
      pricing: pricingSnapshot,
      caseId: "C-001",
      runs: inputRuns,
      gateResults,
      createdAt: "2026-07-17T00:10:00.000Z",
    });
    const expectedMessage =
      "Calibration smoke 실행과 gate는 run number 1과 2를 각각 한 번씩 가져야 합니다.";

    expect(() => build(
      [runs[0], { ...runs[0] }],
      [gateOne, { ...gateOne, runNumber: 2 }],
    )).toThrow(expectedMessage);
    expect(() => build(
      runs,
      [gateOne, { ...gateOne }],
    )).toThrow(expectedMessage);
  });

  it("요청 모델이 잠긴 가격 스냅샷 모델과 다르면 비용 계산을 거부한다", () => {
    expect(() => buildPartialEvaluationPack({
      challengeVersion: "challenge-v1",
      candidateVersion: "candidate-a-v1",
      datasetHash: "dataset-hash",
      candidateConfigHash: "candidate-hash",
      systemPromptHash: "prompt-hash",
      modelRequestedId: "gpt-5.6-luna",
      serviceTierRequested: "default",
      pricing: pricingSnapshot,
      caseId: "C-001",
      runs,
      gateResults: [
        { runNumber: 1, evaluation: "EVALUATED", result: { gateCode: "P0-HG-02", status: "PASS", findings: [] } },
        { runNumber: 2, evaluation: "EVALUATED", result: { gateCode: "P0-HG-02", status: "PASS", findings: [] } },
      ],
      createdAt: "2026-07-17T00:10:00.000Z",
    })).toThrow("요청 모델과 잠긴 가격 스냅샷 모델이 일치하지 않습니다.");
  });

  it("사용량이 있는데 reported service tier가 없으면 가격을 추정하지 않는다", () => {
    const runsWithoutTier = runs.map((run) => ({
      ...run,
      attempts: run.attempts.map(({ serviceTierReported: _omitted, ...attempt }) => attempt),
    }));

    expect(() => buildPartialEvaluationPack({
      challengeVersion: "challenge-v1",
      candidateVersion: "candidate-a-v1",
      datasetHash: "dataset-hash",
      candidateConfigHash: "candidate-hash",
      systemPromptHash: "prompt-hash",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "default",
      pricing: pricingSnapshot,
      caseId: "C-001",
      runs: runsWithoutTier,
      gateResults: [
        { runNumber: 1, evaluation: "EVALUATED", result: { gateCode: "P0-HG-02", status: "PASS", findings: [] } },
        { runNumber: 2, evaluation: "EVALUATED", result: { gateCode: "P0-HG-02", status: "PASS", findings: [] } },
      ],
      createdAt: "2026-07-17T00:10:00.000Z",
    })).toThrow("사용량이 있는 실행에는 OpenAI가 보고한 service tier가 필요합니다.");
  });

  it("보고된 service tier가 가격 스냅샷과 다르면 비용 계산을 중단한다", () => {
    const runsWithPriorityTier = runs.map((run) => ({
      ...run,
      attempts: run.attempts.map((attempt) => ({ ...attempt, serviceTierReported: "priority" })),
    }));

    expect(() => buildPartialEvaluationPack({
      challengeVersion: "challenge-v1",
      candidateVersion: "candidate-a-v1",
      datasetHash: "dataset-hash",
      candidateConfigHash: "candidate-hash",
      systemPromptHash: "prompt-hash",
      modelRequestedId: "gpt-5.6-terra",
      serviceTierRequested: "default",
      pricing: pricingSnapshot,
      caseId: "C-001",
      runs: runsWithPriorityTier,
      gateResults: [
        { runNumber: 1, evaluation: "EVALUATED", result: { gateCode: "P0-HG-02", status: "PASS", findings: [] } },
        { runNumber: 2, evaluation: "EVALUATED", result: { gateCode: "P0-HG-02", status: "PASS", findings: [] } },
      ],
      createdAt: "2026-07-17T00:10:00.000Z",
    })).toThrow("응답이 보고한 service tier와 잠긴 가격 스냅샷이 일치하지 않습니다.");
  });
});

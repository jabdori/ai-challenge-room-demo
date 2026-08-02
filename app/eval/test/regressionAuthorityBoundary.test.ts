// @vitest-environment node

import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DecisionBaselineRecord } from "../decision/decisionBaseline";
import {
  runRecordedRegression,
  type RegressionRunnerDependencies,
  type RegressionSufficiencyContract,
} from "../regression/runRegression";

const sufficiency: RegressionSufficiencyContract = {
  hidden_policy_minimum_correct: 11,
  hidden_citation_required_cases: 11,
  hidden_escalation_required_cases: 4,
  mean_runtime_cost_usd_maximum: 0.2,
  median_latency_ms_maximum: 10_000,
  worst_latency_ms_maximum: 30_000,
};

describe("기록 회귀 production authority 경계", () => {
  it("주입 validator가 no-op이어도 fabricated baseline은 정식 validator에서 원격 0회로 거절한다", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "regression-authority-boundary-"),
    );
    await chmod(outputDirectory, 0o700);
    const executeCandidate = vi.fn();
    const resourceEvidence = vi.fn();
    const dependencies: RegressionRunnerDependencies = {
      assertBaselineRecord: () => undefined,
      executeCandidate,
      resourceEvidence,
    };
    const fabricated = Object.freeze({
      schema_version: "decision-authority-record-v1",
      artifact_kind: "DECISION_BASELINE_RECORD",
      baseline_status: "ACTIVE",
    }) as unknown as DecisionBaselineRecord;

    await expect(runRecordedRegression({
      outputDirectory,
      decisionBaselineRecord: fabricated,
      sufficiency,
      dependencies,
    })).rejects.toThrow(/authoritative|DECISION_BASELINE|기준선|검증/i);
    expect(executeCandidate).not.toHaveBeenCalled();
    expect(resourceEvidence).not.toHaveBeenCalled();
  });
});

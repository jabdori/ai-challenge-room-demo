// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  loadRecordedSyntheticDemoProjectionFixture,
  RECORDED_SYNTHETIC_DEMO_SOURCE_SHA256,
} from "../demo/recordedSyntheticDemoProjectionFixture";

describe("기록된 합성 데모 공개 projection", () => {
  it("추적된 A/B/C canary fixture에서 1사례·6실행의 공개 증거를 읽는다", () => {
    const projection = loadRecordedSyntheticDemoProjectionFixture();

    expect(projection).toMatchObject({
      schema_version: "recorded-synthetic-demo-projection-v1",
      artifact_kind: "RECORDED_SYNTHETIC_DEMO_PROJECTION",
      synthetic: true,
      source: "RECORDED_SYNTHETIC_DEMO",
      evaluation_status: "EVALUATION_INCOMPLETE",
      pack_id: "calibration-pack-1d0d4af2c4428cb6",
      source_hash: RECORDED_SYNTHETIC_DEMO_SOURCE_SHA256,
      case: {
        case_id: "C-001",
        count: 1,
      },
      coverage: {
        cases: 1,
        candidates: 3,
        runs_per_candidate: 2,
        completed_runs: 6,
        expected_runs: 6,
      },
      total_runtime_cost_usd: 0.037776625,
      summed_latency_ms: 18_951,
    });
    expect(projection.candidates).toHaveLength(3);
    expect(projection.candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      runs: candidate.runs.length,
      total_runtime_cost_usd: candidate.total_runtime_cost_usd,
      summed_latency_ms: candidate.summed_latency_ms,
      provider_calls: candidate.provider_call_count,
      retrieval_calls: candidate.retrieval_call_count,
      tool_calls: candidate.tool_call_count,
    }))).toEqual([
      {
        candidate_id: "A",
        runs: 2,
        total_runtime_cost_usd: 0.007845,
        summed_latency_ms: 3_284,
        provider_calls: 2,
        retrieval_calls: 0,
        tool_calls: 0,
      },
      {
        candidate_id: "B",
        runs: 2,
        total_runtime_cost_usd: 0.00759225,
        summed_latency_ms: 5_842,
        provider_calls: 2,
        retrieval_calls: 2,
        tool_calls: 0,
      },
      {
        candidate_id: "C",
        runs: 2,
        total_runtime_cost_usd: 0.022339375,
        summed_latency_ms: 9_825,
        provider_calls: 6,
        retrieval_calls: 2,
        tool_calls: 4,
      },
    ]);
    expect(projection.evidence).toHaveLength(6);
    expect(new Set(projection.evidence.map((item) => item.evidence_id)).size).toBe(6);
    expect(projection.evidence.every((item) => (
      /^demo_evidence_[a-f0-9]{64}$/.test(item.evidence_id)
      && item.source === "RECORDED_SYNTHETIC_DEMO"
      && item.deterministic_gate.status === "PASS"
      && item.output !== null
    ))).toBe(true);
    expect(projection.evidence[0]).toMatchObject({
      case_id: "C-001",
      candidate_id: "A",
      run_number: 1,
      execution_status: "COMPLETE",
      evaluation_status: "EVALUATED",
      deterministic_gate: {
        gate_code: "P0-HG-02",
        status: "PASS",
        findings: [],
      },
      cost_usd: 0.00399,
      summed_latency_ms: 1_736,
      provider_call_count: 1,
      retrieval_call_count: 0,
      tool_call_count: 0,
      output: {
        decision: {
          action_code: "DENY_CANCEL_AFTER_SHIPMENT",
          escalation_required: false,
        },
        citations: [{
          source_id: "CANCEL-2026",
          section_id: "2.2",
        }],
      },
    });
  });

  it("추적된 공개 projection을 호출자 mutation으로부터 격리한다", () => {
    const projection = loadRecordedSyntheticDemoProjectionFixture();

    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.candidates[0].runs[0].output)).toBe(true);
  });
});

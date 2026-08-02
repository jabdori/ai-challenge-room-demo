// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  parseHackathonDemoState,
  type HackathonDemoState,
} from "../../shared/hackathonDemo";

function state(
  source: "LIVE_SYNTHETIC_DEMO" | "RECORDED_FALLBACK",
  runCount: 1 | 2,
): HackathonDemoState {
  const runs = Array.from({ length: runCount }, (_, index) => ({
    evidence_id: `evidence-${index + 1}`,
    repetition: (index + 1) as 1 | 2,
    execution_status: "COMPLETE" as const,
    hard_gate_status: "PASS" as const,
    latency_ms: 10,
    cost_usd: 0.001,
    customer_reply: "Synthetic reply",
    action_code: "DENY_CANCEL_AFTER_SHIPMENT",
    escalation_required: false,
    citations: ["CANCEL-2026 §2.2"],
  }));
  const candidates = (["A", "B", "C"] as const).map((candidateId, index) => ({
    candidate_id: candidateId,
    architecture: `architecture-${candidateId}`,
    complexity_tier: (["T1", "T2", "T3"] as const)[index],
    hard_gate: {
      passed_runs: runCount,
      total_runs: runCount,
      status: "PASS" as const,
    },
    quality: {
      complete_outputs: runCount,
      active_policy_citations: runCount,
      stability: runCount === 1
        ? "SINGLE_RUN_NOT_MEASURED" as const
        : "STABLE" as const,
      stable_decisions: runCount === 1 ? null : true,
    },
    total_cost_usd: 0.001,
    mean_cost_usd: 0.001 / runCount,
    total_latency_ms: 10,
    mean_latency_ms: 10 / runCount,
    provider_calls: 1,
    retrieval_calls: 0,
    tool_calls: 0,
    runs,
  }));
  const blindCandidates = (["X", "Y", "Z"] as const).map((blindLabel) => ({
    blind_label: blindLabel,
    runs: runs.map((run) => ({
      repetition: run.repetition,
      customer_reply: "Synthetic reply",
      citations: ["CANCEL-2026 §2.2"],
    })),
  }));
  return {
    schema_version: "hackathon-demo-state-v1",
    synthetic: true,
    source,
    status: "JUDGE_REQUIRED",
    canary: {
      pack_id: "pack",
      pack_hash: "a".repeat(64),
      artifact_kind: source === "LIVE_SYNTHETIC_DEMO"
        ? "LIVE_DEMO_EVALUATION_PACK"
        : "PARTIAL_CALIBRATION_PACK",
      evaluation_status: "EVALUATION_INCOMPLETE",
      case_id: "C-001",
      ticket: "Synthetic ticket",
      as_of: "2026-07-17",
      total_cost_usd: 0.003,
      candidates,
    },
    judge: null,
    blind_review: {
      case_id: "C-001",
      candidates: blindCandidates,
    },
    human_review: null,
    selection: null,
    memo: null,
    regression: null,
  } as unknown as HackathonDemoState;
}

describe("해커톤 데모 source별 실행 수 계약", () => {
  it("라이브 1회와 기록 fallback 2회를 각각 허용한다", () => {
    expect(parseHackathonDemoState(
      state("LIVE_SYNTHETIC_DEMO", 1),
    ).source).toBe("LIVE_SYNTHETIC_DEMO");
    expect(parseHackathonDemoState(
      state("RECORDED_FALLBACK", 2),
    ).source).toBe("RECORDED_FALLBACK");
  });

  it("source와 artifact가 다르거나 후보 실행 수가 섞이면 거부한다", () => {
    const wrongArtifact = structuredClone(state("LIVE_SYNTHETIC_DEMO", 1));
    (wrongArtifact.canary as { artifact_kind: string }).artifact_kind =
      "PARTIAL_CALIBRATION_PACK";
    expect(() => parseHackathonDemoState(wrongArtifact)).toThrow(/출처|범위/);

    const mixed = structuredClone(state("LIVE_SYNTHETIC_DEMO", 1));
    (mixed.canary.candidates[1].runs as unknown as unknown[]).push({
      ...mixed.canary.candidates[1].runs[0],
      repetition: 2,
    });
    expect(() => parseHackathonDemoState(mixed)).toThrow(/실행 수/);
  });

  it("이전 수동 수정시간 snapshot을 미측정 상태로 정규화한다", () => {
    const legacy = structuredClone(state("LIVE_SYNTHETIC_DEMO", 1)) as unknown as
      Record<string, unknown>;
    legacy.status = "DECISION_REQUIRED";
    legacy.human_review = {
      status: "COMPLETE",
      reviewer: "Demo decision owner",
      rationale: "Reviewed all blinded drafts.",
      correction_seconds: 35,
      decisions: [
        { blind_label: "X", decision: "PASS" },
        { blind_label: "Y", decision: "PASS" },
        { blind_label: "Z", decision: "PASS" },
      ],
    };

    const parsed = parseHackathonDemoState(legacy);

    expect(parsed.human_review).toMatchObject({
      review_time: "NOT_MEASURED",
      edit_time: "NOT_MEASURED",
    });
    expect(parsed.human_review).not.toHaveProperty("correction_seconds");
  });
});

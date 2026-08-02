import { describe, expect, it } from "vitest";
import type { BrowserPublicProjection } from "../data/challengeApi";
import {
  BENCHMARK_PROGRESS_POLL_INTERVAL_MS,
  LifecycleProjectionError,
  parseCompareLifecycleProjection,
  parseDefineLifecycleProjection,
} from "../data/lifecycleViews";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const candidateIds = ["A", "B", "C"] as const;
const caseIds = Array.from({ length: 12 }, (_, index) => (
  `H-${String(index + 1).padStart(3, "0")}`
));

function terminalSlots(count = 72) {
  return caseIds.flatMap((caseId) => (
    candidateIds.flatMap((candidateId) => ([1, 2] as const).map((repetition) => ({
      evidence_id: `evidence_${caseId}_${candidateId}_${repetition}`,
      case_id: caseId,
      candidate_id: candidateId,
      repetition,
      execution_status: "COMPLETE",
      evaluation_status: "EVALUATED",
      hard_gate_status: "PASS",
      cost_usd: 0.01,
      latency_ms: 1_200,
    })))
  )).slice(0, count);
}

function defineCommon() {
  return {
    schema_version: "challenge-public-projection-v1",
    synthetic: true,
    challenge_id: "monomarket-support-ai-selection",
    challenge_version: "v1",
    source_hash: SHA_A,
    title: "Customer-support answer drafting and escalation",
    business_brief: {
      title: "Customer-support answer drafting and escalation",
      decision: "Select an AI configuration for customer-support agent assist.",
      workflow:
        "Draft a grounded answer and decide whether a support ticket needs escalation.",
      intended_users: ["Customer-support operations", "AI governance"],
      locale: "en-US",
    },
    constraints: [{
      constraint_id: "CONSTRAINT-POLICY-GROUNDING",
      text: "Use only approved synthetic policy and order sources.",
    }],
    prohibited_actions: [{
      prohibition_id: "PROHIBIT-UNSUPPORTED-PROMISE",
      text: "Do not promise actions that evidence does not support.",
    }],
    source_manifest: {
      manifest_version: "define-source-manifest-v1",
      sources: [{
        source_id: "SOURCE-POLICY-CORPUS",
        source_type: "SYNTHETIC_POLICY_MANIFEST",
        title: "Synthetic support-policy manifest",
        content_sha256: SHA_C,
        synthetic: true,
      }],
    },
  };
}

function suggestionSummary() {
  return {
    artifact_hash: SHA_C,
    artifact_kind: "DEFINE_SUGGESTION",
    authority: "ADVISORY_ONLY",
    task_contract: {
      decision: "Select an AI configuration for customer-support agent assist.",
      input_contract: ["A synthetic support ticket"],
      output_contract: ["A grounded reply", "Escalation decision", "Citations"],
      allowed_source_ids: ["SOURCE-POLICY-CORPUS"],
      operating_constraints: ["Read-only evidence access"],
    },
    evaluation_criteria: [
      "FACT_POLICY_ACCURACY",
      "CITATION_GROUNDING",
      "POLICY_COMPLIANCE",
      "ESCALATION_DECISION",
      "RESPONSE_QUALITY",
      "REPEAT_STABILITY",
    ].map((criterionId) => ({
      criterion_id: criterionId,
      description: `Evaluate ${criterionId.toLowerCase()}.`,
      evidence_required: ["Candidate output", "Approved source evidence"],
    })),
    hard_gates: ["01", "02", "03", "04"].map((number) => ({
      gate_id: `P0-HG-${number}`,
      failure_condition: `Fatal condition ${number}`,
      required_evidence: ["Structured output", "Approved source evidence"],
    })),
    limitations: [
      "Advisory only and requires explicit human approval.",
      "Does not select, purchase, deploy, or lock an AI configuration.",
    ],
  };
}

function compareCommon() {
  return {
    schema_version: "benchmark-progress-projection-v1",
    synthetic: true,
    benchmark_id: SHA_B,
    challenge_id: "monomarket-support-ai-selection",
    source_hash: SHA_A,
    candidate_execution: { completed: 0, total: 72 },
    auxiliary_judge: { completed: 0, total: 12 },
    cleanup: { required: 33, acknowledged: 0, incomplete: 33 },
    attempt_number: 0,
    started_at: null,
    updated_at: "2026-07-17T10:00:00.000Z",
    single_flight: false,
    resume: {
      allowed: false,
      action: "NONE",
      from_progress_hash: null,
    },
    failure: null,
    terminal_slots: [],
  };
}

function recordedAggregates() {
  return candidateIds.map((candidateId) => ({
    candidate_id: candidateId,
    counts: {
      scheduled_runs: 24,
      complete_runs: 24,
      invalid_runs: 0,
      timeout_runs: 0,
      budget_exceeded_runs: 0,
      hard_gate_failed_runs: 0,
      hard_gate_failed_cases: 0,
      policy_applicable_cases: 12,
      policy_success_cases: 12,
      citation_required_cases: 11,
      citation_success_cases: 11,
      escalation_required_cases: 4,
      escalation_success_cases: 4,
    },
    cost: { average_usd_per_ticket: 0.01 },
    latency: { median_ms: 1_200, worst_ms: 2_000 },
    stability: {
      comparable_cases: 12,
      stable_cases: 12,
      unstable_cases: 0,
    },
  }));
}

function recordedProgress() {
  return {
    schema_version: "benchmark-progress-projection-v1",
    synthetic: true,
    benchmark_id: SHA_B,
    source_hash: SHA_A,
    source: "RECORDED_BENCHMARK",
    status: "REVIEW_PENDING",
    completed: 72,
    total: 72,
    review_time: "NOT_MEASURED",
    edit_time: "NOT_MEASURED",
    coverage: {
      cases: 12,
      candidates: 3,
      runs_per_case: 2,
      candidate_runs: 72,
      judge_cases: 12,
      complete_judge_cases: 12,
      human_fallback_judge_cases: 0,
      review_items: 12,
    },
    costs: {},
    candidate_aggregates: recordedAggregates(),
    slots: terminalSlots(),
  };
}

describe("Define lifecycle public projection parser", () => {
  it("DRAFT와 PROPOSED의 authority·suggestion·approved hash 경계를 분리한다", () => {
    const draft = parseDefineLifecycleProjection({
      ...defineCommon(),
      state: "DRAFT",
      authority: "NONE",
      define_status: "NOT_STARTED",
      suggestion_summary: null,
      approved_contract_hash: null,
    } as BrowserPublicProjection);
    expect(draft).toMatchObject({
      state: "DRAFT",
      authority: "NONE",
      suggestion_summary: null,
      approved_contract_hash: null,
    });

    const proposed = parseDefineLifecycleProjection({
      ...defineCommon(),
      state: "PROPOSED",
      authority: "ADVISORY_ONLY",
      define_status: "SUGGESTION_READY",
      suggestion_summary: suggestionSummary(),
      approved_contract_hash: SHA_B,
    } as BrowserPublicProjection);
    expect(proposed).toMatchObject({
      state: "PROPOSED",
      authority: "ADVISORY_ONLY",
      approved_contract_hash: SHA_B,
      suggestion_summary: {
        artifact_hash: SHA_C,
        artifact_kind: "DEFINE_SUGGESTION",
        authority: "ADVISORY_ONLY",
      },
    });
    expect(Object.isFrozen(proposed)).toBe(true);
  });

  it("PROPOSED의 null approved hash·잘못된 authority·추가 private field를 fail-closed 한다", () => {
    const base = {
      ...defineCommon(),
      state: "PROPOSED",
      authority: "ADVISORY_ONLY",
      define_status: "SUGGESTION_READY",
      suggestion_summary: suggestionSummary(),
      approved_contract_hash: SHA_B,
    };
    expect(() => parseDefineLifecycleProjection({
      ...base,
      approved_contract_hash: null,
    } as BrowserPublicProjection)).toThrow(LifecycleProjectionError);
    expect(() => parseDefineLifecycleProjection({
      ...base,
      authority: "EXPLICIT_HUMAN_APPROVAL",
    } as BrowserPublicProjection)).toThrow(LifecycleProjectionError);
    expect(() => parseDefineLifecycleProjection({
      ...base,
      private_mapping: { X: "A" },
    } as BrowserPublicProjection)).toThrow(LifecycleProjectionError);
  });

  it("lifecycle LOCKED full human-approved 계약을 읽되 private authority hash는 거부한다", () => {
    const suggestion = suggestionSummary();
    const locked = {
      ...defineCommon(),
      state: "LOCKED",
      authority: "EXPLICIT_HUMAN_APPROVAL",
      define_status: "SUGGESTION_READY",
      suggestion_summary: suggestion,
      approved_contract_hash: SHA_B,
      source_manifest_hash: SHA_C,
      locked_at: "2026-07-17T10:00:00.000Z",
      approved_by: "Evaluation owner",
      task_contract: suggestion.task_contract,
      evaluation_criteria: suggestion.evaluation_criteria,
      hard_gates: suggestion.hard_gates,
      candidate_complexity_profiles: {},
      sufficiency: {
        critical_failures: { maximum: 0, total_cases: 12 },
        valid_runs: { minimum: 24, total_runs: 24 },
        repeat_stability: { minimum_stable: 12, total_cases: 12 },
        open_reviews: { maximum: 0 },
        mean_runtime_cost_usd: { maximum: 0.05 },
        latency_ms: { median_maximum: 12_000, worst_maximum: 30_000 },
      },
    };
    expect(parseDefineLifecycleProjection(
      locked as BrowserPublicProjection,
    )).toMatchObject({
      state: "LOCKED",
      approved_by: "Evaluation owner",
      approved_contract_hash: SHA_B,
    });
    expect(() => parseDefineLifecycleProjection({
      ...locked,
      locked_challenge_pack_hash: SHA_A,
    } as BrowserPublicProjection)).toThrow(LifecycleProjectionError);
  });
});

describe("Compare lifecycle public projection parser", () => {
  it("RUNNING polling 계약을 500–1000ms 사이의 고정 간격으로 공개한다", () => {
    expect(BENCHMARK_PROGRESS_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(500);
    expect(BENCHMARK_PROGRESS_POLL_INTERVAL_MS).toBeLessThanOrEqual(1_000);
  });

  it("READY와 실제 persisted RUNNING checkpoint를 파싱하고 completed 숫자를 slot 수에 결합한다", () => {
    const ready = parseCompareLifecycleProjection({
      ...compareCommon(),
      status: "READY",
    } as BrowserPublicProjection);
    expect(ready).toMatchObject({
      status: "READY",
      candidate_execution: { completed: 0, total: 72 },
      terminal_slots: [],
    });

    const running = parseCompareLifecycleProjection({
      ...compareCommon(),
      status: "RUNNING",
      candidate_execution: { completed: 2, total: 72 },
      attempt_number: 1,
      started_at: "2026-07-17T10:00:01.000Z",
      single_flight: true,
      terminal_slots: terminalSlots(2),
    } as BrowserPublicProjection);
    expect(running).toMatchObject({
      status: "RUNNING",
      candidate_execution: { completed: 2, total: 72 },
    });
    expect(running.status === "RUNNING" && running.terminal_slots).toHaveLength(2);
  });

  it("START 승인 직후 첫 checkpoint 전의 canonical RUNNING 0 상태를 파싱한다", () => {
    expect(parseCompareLifecycleProjection({
      schema_version: "benchmark-lifecycle-projection-v1",
      synthetic: true,
      source: "RECORDED_BENCHMARK",
      benchmark_id: SHA_B,
      status: "RUNNING",
      completed: 0,
      total: 72,
      last_slot_sequence: null,
      checkpoint_source: null,
      cleanup: null,
      source_hash: SHA_A,
    } as BrowserPublicProjection)).toMatchObject({
      status: "RUNNING",
      completed: 0,
      last_slot_sequence: null,
      checkpoint_source: null,
    });
  });

  it("후보 72회 완료 뒤 보조 Judge가 진행 중인 canonical RUNNING 72 상태를 파싱한다", () => {
    expect(parseCompareLifecycleProjection({
      schema_version: "benchmark-lifecycle-projection-v1",
      synthetic: true,
      source: "RECORDED_BENCHMARK",
      benchmark_id: SHA_B,
      status: "RUNNING",
      completed: 72,
      total: 72,
      last_slot_sequence: 72,
      checkpoint_source: "EXECUTED",
      cleanup: null,
      source_hash: SHA_A,
    } as BrowserPublicProjection)).toMatchObject({
      status: "RUNNING",
      completed: 72,
      last_slot_sequence: 72,
      checkpoint_source: "EXECUTED",
    });
  });

  it("invented checkpoint·중복 slot·불일치 cleanup을 거부한다", () => {
    const running = {
      ...compareCommon(),
      status: "RUNNING",
      candidate_execution: { completed: 2, total: 72 },
      attempt_number: 1,
      started_at: "2026-07-17T10:00:01.000Z",
      single_flight: true,
      terminal_slots: terminalSlots(1),
    };
    expect(() => parseCompareLifecycleProjection(
      running as BrowserPublicProjection,
    )).toThrow(LifecycleProjectionError);

    const duplicated = terminalSlots(2);
    duplicated[1] = { ...duplicated[0], evidence_id: "other_evidence" };
    expect(() => parseCompareLifecycleProjection({
      ...running,
      terminal_slots: duplicated,
    } as BrowserPublicProjection)).toThrow(LifecycleProjectionError);

    expect(() => parseCompareLifecycleProjection({
      ...compareCommon(),
      status: "READY",
      cleanup: { required: 33, acknowledged: 1, incomplete: 33 },
    } as BrowserPublicProjection)).toThrow(LifecycleProjectionError);
  });

  it("authority·hidden dataset·schedule·checkpoint·receipt hash를 public progress에 추가하면 거부한다", () => {
    for (const privateField of [
      "locked_challenge_pack_hash",
      "hidden_dataset_hash",
      "schedule_id",
      "checkpoint_hash",
      "progress_event_hash",
      "start_receipt_hash",
    ]) {
      expect(() => parseCompareLifecycleProjection({
        ...compareCommon(),
        status: "READY",
        [privateField]: SHA_C,
      } as BrowserPublicProjection), privateField).toThrow(
        LifecycleProjectionError,
      );
    }
  });

  it("REVIEW_PENDING도 full64 identity와 exact public boundary를 유지한다", () => {
    expect(parseCompareLifecycleProjection(
      recordedProgress() as BrowserPublicProjection,
    )).toMatchObject({
      status: "REVIEW_PENDING",
      benchmark_id: SHA_B,
      source_hash: SHA_A,
    });
    expect(() => parseCompareLifecycleProjection({
      ...recordedProgress(),
      benchmark_id: "benchmark_alias",
    } as BrowserPublicProjection)).toThrow();
    expect(() => parseCompareLifecycleProjection({
      ...recordedProgress(),
      hidden_dataset_hash: SHA_C,
    } as BrowserPublicProjection)).toThrow();
    expect(() => parseCompareLifecycleProjection({
      ...recordedProgress(),
      // reviewer queue는 public Compare projection에 섞이지 않고 전용 reviewer
      // route에서만 제공되어야 합니다.
      queue: {},
    } as BrowserPublicProjection)).toThrow();
    const slotsWithPrivateHash = terminalSlots();
    slotsWithPrivateHash[0] = {
      ...slotsWithPrivateHash[0],
      checkpoint_hash: SHA_C,
    } as typeof slotsWithPrivateHash[number];
    expect(() => parseCompareLifecycleProjection({
      ...recordedProgress(),
      slots: slotsWithPrivateHash,
    } as BrowserPublicProjection)).toThrow();
  });

  it("INVALID resume를 exact progress hash에 결합하고 COMPLETE counters-only handoff를 aggregate 없이 허용한다", () => {
    const invalid = parseCompareLifecycleProjection({
      ...compareCommon(),
      status: "INVALID",
      candidate_execution: { completed: 2, total: 72 },
      attempt_number: 1,
      started_at: "2026-07-17T10:00:01.000Z",
      updated_at: "2026-07-17T10:02:00.000Z",
      terminal_slots: terminalSlots(2),
      resume: {
        allowed: true,
        action: "RETRY_CLEANUP",
        from_progress_hash: SHA_B,
      },
      failure: {
        code: "REMOTE_RESOURCE_DELETE_NOT_ACKNOWLEDGED",
        phase: "CLEANUP",
      },
    } as BrowserPublicProjection);
    expect(invalid).toMatchObject({
      status: "INVALID",
      resume: {
        allowed: true,
        action: "RETRY_CLEANUP",
        from_progress_hash: SHA_B,
      },
    });

    const complete = parseCompareLifecycleProjection({
      ...compareCommon(),
      status: "COMPLETE",
      candidate_execution: { completed: 72, total: 72 },
      auxiliary_judge: { completed: 12, total: 12 },
      cleanup: { required: 33, acknowledged: 33, incomplete: 0 },
      attempt_number: 1,
      started_at: "2026-07-17T10:00:01.000Z",
      terminal_slots: terminalSlots(),
    } as BrowserPublicProjection);
    expect(complete.status).toBe("COMPLETE");
    expect("candidate_aggregates" in complete).toBe(false);
  });
});

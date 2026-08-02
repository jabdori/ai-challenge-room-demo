import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  DefineStage,
  type DefineDraftView,
  type DefineProposedView,
} from "../features/define/DefineStage";
import {
  CompareStage,
  type CompareInvalidView,
  type CompareReadyView,
  type CompareRunningView,
} from "../features/compare/CompareStage";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

const businessBrief = {
  title: "Customer-support answer drafting and escalation",
  decision: "Select an AI configuration for customer-support agent assist.",
  workflow:
    "Draft a grounded answer and decide whether a support ticket needs escalation.",
  intended_users: ["Customer-support operations", "AI governance"],
  locale: "en-US" as const,
};

const defineSource = {
  manifest_version: "define-source-manifest-v1" as const,
  sources: [{
    source_id: "SOURCE-POLICY-CORPUS",
    source_type: "SYNTHETIC_POLICY_MANIFEST",
    title: "Synthetic support-policy manifest",
    content_sha256: SHA_C,
    synthetic: true as const,
  }],
};

const defineCommon = {
  challenge_id: "monomarket-support-ai-selection",
  challenge_version: "v1",
  source_hash: SHA_A,
  title: businessBrief.title,
  business_brief: businessBrief,
  constraints: [{
    constraint_id: "CONSTRAINT-POLICY-GROUNDING",
    text: "Use only approved synthetic policy and order sources.",
  }],
  prohibited_actions: [{
    prohibition_id: "PROHIBIT-UNSUPPORTED-PROMISE",
    text: "Do not promise actions that the evidence does not support.",
  }],
  source_manifest: defineSource,
};

const draft: DefineDraftView = {
  ...defineCommon,
  state: "DRAFT",
  authority: "NONE",
  define_status: "NOT_STARTED",
  suggestion_summary: null,
  approved_contract_hash: null,
};

const proposed: DefineProposedView = {
  ...defineCommon,
  state: "PROPOSED",
  authority: "ADVISORY_ONLY",
  define_status: "SUGGESTION_READY",
  approved_contract_hash: SHA_B,
  suggestion_summary: {
    artifact_hash: SHA_C,
    artifact_kind: "DEFINE_SUGGESTION",
    authority: "ADVISORY_ONLY",
    task_contract: {
      decision: businessBrief.decision,
      input_contract: [
        "A synthetic support ticket",
        "Approved synthetic policy and order evidence",
      ],
      output_contract: [
        "A grounded customer reply draft",
        "A structured escalation decision",
        "Supporting source citations",
      ],
      allowed_source_ids: ["SOURCE-POLICY-CORPUS"],
      operating_constraints: [
        "Read-only evidence access",
        "No unsupported promises or external actions",
      ],
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
      required_evidence: ["Structured output", "Authorized evidence"],
    })),
    limitations: [
      "This draft is advisory and requires explicit human approval.",
      "It does not select, purchase, deploy, or lock an AI configuration.",
    ],
  },
};

const benchmarkCommon = {
  benchmark_id: "benchmark_recorded_v1",
  challenge_id: defineCommon.challenge_id,
  source_hash: SHA_A,
  candidate_execution: { completed: 0, total: 72 as const },
  auxiliary_judge: { completed: 0, total: 12 as const },
  cleanup: { required: 33 as const, acknowledged: 0, incomplete: 33 },
  attempt_number: 0,
  started_at: null,
  updated_at: "2026-07-17T10:00:00.000Z",
  single_flight: false,
  resume: {
    allowed: false,
    action: "NONE" as const,
    from_progress_hash: null,
  },
  failure: null,
  terminal_slots: [],
};

const ready = ({
  ...benchmarkCommon,
  status: "READY",
} as unknown) as CompareReadyView;

const running = ({
  ...benchmarkCommon,
  status: "RUNNING",
  candidate_execution: { completed: 2, total: 72 },
  auxiliary_judge: { completed: 0, total: 12 },
  cleanup: { required: 33, acknowledged: 0, incomplete: 33 },
  attempt_number: 1,
  started_at: "2026-07-17T10:00:01.000Z",
  single_flight: true,
  terminal_slots: [
    {
      evidence_id: "evidence_H-001_A_1",
      case_id: "H-001",
      candidate_id: "A",
      repetition: 1,
      execution_status: "COMPLETE",
      evaluation_status: "EVALUATED",
      hard_gate_status: "PASS",
      cost_usd: 0.009,
      latency_ms: 1_250,
    },
    {
      evidence_id: "evidence_H-001_A_2",
      case_id: "H-001",
      candidate_id: "A",
      repetition: 2,
      execution_status: "TIMEOUT",
      evaluation_status: "NOT_EVALUATED",
      hard_gate_status: "NOT_EVALUATED",
      cost_usd: null,
      latency_ms: 30_000,
    },
  ],
} as unknown) as CompareRunningView;

const invalid = ({
  ...benchmarkCommon,
  status: "INVALID",
  candidate_execution: { completed: 72, total: 72 },
  auxiliary_judge: { completed: 12, total: 12 },
  cleanup: { required: 33, acknowledged: 32, incomplete: 1 },
  attempt_number: 1,
  started_at: "2026-07-17T10:00:01.000Z",
  updated_at: "2026-07-17T10:09:00.000Z",
  resume: {
    allowed: true,
    action: "RETRY_CLEANUP",
    from_progress_hash: SHA_B,
  },
  failure: {
    code: "REMOTE_RESOURCE_DELETE_NOT_ACKNOWLEDGED",
    phase: "CLEANUP",
  },
  terminal_slots: [],
} as unknown) as CompareInvalidView;

describe("actual Define lifecycle 화면", () => {
  it("DRAFT에서 합성 업무·제약·치명 금지와 명시적 actor 기반 Structure action만 표시한다", async () => {
    const user = userEvent.setup();
    const onStructure = vi.fn();
    render(
      <DefineStage challenge={draft} onStructure={onStructure} />,
    );

    expect(screen.getByText("DRAFT")).toBeVisible();
    expect(screen.getByText("SYNTHETIC DATA")).toBeVisible();
    expect(screen.getByRole("heading", { name: businessBrief.title })).toBeVisible();
    expect(screen.getByText(businessBrief.workflow)).toBeVisible();
    expect(screen.getByText(defineCommon.constraints[0].text)).toBeVisible();
    expect(screen.getByText(defineCommon.prohibited_actions[0].text)).toBeVisible();

    const action = screen.getByRole("button", {
      name: "Structure with GPT-5.6",
    });
    expect(action).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Define decision owner" }),
      "Evaluation owner",
    );
    await user.click(action);
    expect(onStructure).toHaveBeenCalledWith({
      actorLabel: "Evaluation owner",
    });
    expect(document.body.textContent).not.toMatch(
      /selected candidate|automatic winner|production customer/i,
    );
  });

  it("PROPOSED에서 GPT suggestion을 advisory로 분리하고 exact hash·actor·문구 확인 전 lock을 막는다", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(
      <DefineStage challenge={proposed} onApprove={onApprove} />,
    );

    expect(screen.getAllByText("ADVISORY ONLY").length).toBeGreaterThan(0);
    expect(screen.getByText(/cannot approve or lock the Challenge/i)).toBeVisible();
    expect(screen.getByRole("heading", {
      name: businessBrief.decision,
    })).toBeVisible();
    expect(screen.getAllByText(/P0-HG-/)).toHaveLength(4);
    expect(screen.getByText(proposed.suggestion_summary.limitations[0])).toBeVisible();

    const approve = screen.getByRole("button", {
      name: "Approve exact contract and lock v1",
    });
    await user.type(
      screen.getByRole("textbox", { name: "Challenge approval owner" }),
      "Evaluation owner",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Exact approval phrase" }),
      "approve exact contract",
    );
    expect(approve).toBeDisabled();
    await user.clear(
      screen.getByRole("textbox", { name: "Exact approval phrase" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Exact approval phrase" }),
      "APPROVE EXACT CONTRACT",
    );
    await user.click(approve);

    expect(onApprove).toHaveBeenCalledWith({
      actorLabel: "Evaluation owner",
      decision: "APPROVE_EXACT_CONTRACT",
      defineStructuringArtifactHash: SHA_C,
      approvedContractHash: SHA_B,
    });
  });

  it("모바일 read-only 경계에서는 Define mutation 입력과 action을 모두 차단한다", () => {
    render(
      <DefineStage
        challenge={draft}
        mobileReadOnly
        onStructure={vi.fn()}
      />,
    );
    expect(screen.getByRole("textbox", {
      name: "Define decision owner",
    })).toBeDisabled();
    expect(screen.getByRole("button", {
      name: "Structure with GPT-5.6",
    })).toBeDisabled();
    expect(screen.getByText(/Changes are disabled on mobile/i)).toBeVisible();
  });
});

describe("actual Compare lifecycle 화면", () => {
  it("READY에서 세 후보와 exact 72 queued schedule을 표시하고 actor 확인 후 START를 요청한다", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(<CompareStage benchmark={ready} onStart={onStart} />);

    expect(screen.getByText("READY")).toBeVisible();
    expect(screen.getByText("72 QUEUED")).toBeVisible();
    expect(screen.getAllByText(/Candidate [ABC]/)).toHaveLength(3);
    expect(document.body.textContent).not.toMatch(/score|winner|recommended/i);

    const start = screen.getByRole("button", {
      name: "Start recorded Benchmark",
    });
    expect(start).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Benchmark execution owner" }),
      "Evaluation owner",
    );
    await user.click(start);
    expect(onStart).toHaveBeenCalledWith({
      actorLabel: "Evaluation owner",
      executionMode: "START",
      acknowledgement: "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
      resumeFromProgressHash: null,
    });
  });

  it("RUNNING에서 source-confirmed terminal checkpoint만 표시하고 나머지는 QUEUED로 남긴다", () => {
    render(<CompareStage benchmark={running} />);

    expect(screen.getByText("RUNNING")).toBeVisible();
    expect(screen.getByText("2 / 72 TERMINAL")).toBeVisible();
    expect(screen.getByText("70 QUEUED")).toBeVisible();
    const checkpoints = screen.getByRole("table", {
      name: "Source-confirmed terminal checkpoints",
    });
    expect(within(checkpoints).getAllByRole("row")).toHaveLength(3);
    expect(within(checkpoints).getAllByText("H-001")).toHaveLength(2);
    expect(within(checkpoints).getByText("TIMEOUT")).toBeVisible();

    const lifecycle = screen.getByRole("region", {
      name: "Benchmark execution lifecycle",
    });
    expect(lifecycle).toHaveTextContent("Candidate execution2 / 72");
    expect(lifecycle).toHaveTextContent("Auxiliary Judge0 / 12");
    expect(lifecycle).toHaveTextContent("Resource cleanup0 / 33");
    expect(document.body.textContent).not.toMatch(
      /quality, cost|composite score|automatic winner|mean runtime cost/i,
    );
  });

  it("INVALID에서 실패 phase와 실제 cleanup을 먼저 표시하고 허용된 persisted checkpoint만 RESUME한다", async () => {
    const user = userEvent.setup();
    const onResume = vi.fn();
    render(<CompareStage benchmark={invalid} onResume={onResume} />);

    expect(screen.getByText("INVALID")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("CLEANUP");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "REMOTE_RESOURCE_DELETE_NOT_ACKNOWLEDGED",
    );
    expect(screen.getByText("32 / 33 ACKNOWLEDGED")).toBeVisible();
    expect(screen.getByText("1 INCOMPLETE")).toBeVisible();

    const resume = screen.getByRole("button", {
      name: "Resume from persisted checkpoints",
    });
    expect(resume).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Benchmark execution owner" }),
      "Evaluation owner",
    );
    await user.click(resume);
    expect(onResume).toHaveBeenCalledWith({
      actorLabel: "Evaluation owner",
      executionMode: "RESUME",
      acknowledgement: "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
      resumeFromProgressHash: SHA_B,
    });
    expect(document.body.textContent).not.toMatch(
      /quality, cost|composite score|automatic winner/i,
    );
  });

  it("모바일에서는 START와 RESUME mutation을 모두 차단한다", () => {
    const { rerender } = render(
      <CompareStage
        benchmark={ready}
        mobileReadOnly
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByRole("textbox", {
      name: "Benchmark execution owner",
    })).toBeDisabled();
    expect(screen.getByRole("button", {
      name: "Start recorded Benchmark",
    })).toBeDisabled();

    rerender(
      <CompareStage
        benchmark={invalid}
        mobileReadOnly
        onResume={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", {
      name: "Resume from persisted checkpoints",
    })).toBeDisabled();
  });
});

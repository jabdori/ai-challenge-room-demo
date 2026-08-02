import { render, screen, within } from "@testing-library/react";
import {
  DefineStage,
  type LockedChallengeView,
} from "../features/define/DefineStage";

const challenge: LockedChallengeView = {
  challenge_id: "monomarket-support-ai-selection",
  challenge_version: "v1",
  state: "LOCKED",
  source_hash: "a".repeat(64),
  locked_at: "2026-07-17T06:00:00.000Z",
  approved_by: "Synthetic evaluation lead",
  approved_contract_hash: "b".repeat(64),
  task_contract: {
    decision: "Select an AI configuration for customer-support agent assist.",
    input_contract: ["A synthetic support ticket", "Approved policy evidence"],
    output_contract: ["Grounded customer reply", "Escalation decision", "Citations"],
    allowed_source_ids: ["SOURCE-POLICY"],
    operating_constraints: ["Read-only evidence access", "No external actions"],
  },
  constraints: [{ constraint_id: "C-1", text: "Synthetic sources only" }],
  prohibited_actions: [{ prohibition_id: "P-1", text: "No refunds" }],
  source_manifest: {
    manifest_version: "define-source-manifest-v1",
    sources: [{
      source_id: "SOURCE-POLICY",
      source_type: "SYNTHETIC_POLICY_MANIFEST",
      title: "Synthetic support-policy manifest",
      content_sha256: "c".repeat(64),
      synthetic: true,
    }],
  },
  evaluation_criteria: [{
    criterion_id: "FACT_POLICY_ACCURACY",
    description: "Check facts and policy.",
    evidence_required: ["Candidate output"],
  }],
  hard_gates: ["01", "02", "03", "04"].map((number) => ({
    gate_id: `P0-HG-${number}`,
    failure_condition: `Fatal condition ${number}`,
    required_evidence: ["Structured output", "Policy evidence"],
  })),
  sufficiency: {
    critical_failures: { maximum: 0, total_cases: 12 },
    valid_runs: { minimum: 24, total_runs: 24 },
    repeat_stability: { minimum_stable: 12, total_cases: 12 },
    open_reviews: { maximum: 0 },
    mean_runtime_cost_usd: { maximum: 0.05 },
    latency_ms: { median_maximum: 12_000, worst_maximum: 30_000 },
  },
};

describe("실제 Locked Challenge Define 화면", () => {
  it("source→task contract→fatal failures→sufficiency 순서로 권위 projection을 표시한다", () => {
    render(<DefineStage challenge={challenge} />);

    expect(screen.getByRole("heading", {
      name: "Turn a real business task into a private AI challenge.",
    })).toBeVisible();
    expect(screen.getByText("LOCKED")).toBeVisible();
    expect(screen.getByRole("heading", {
      name: "Approved synthetic evidence",
    })).toBeVisible();
    expect(screen.getByRole("heading", {
      name: "Select an AI configuration for customer-support agent assist.",
    })).toBeVisible();
    expect(screen.getByRole("heading", {
      name: "Hard gates before averages",
    })).toBeVisible();
    expect(screen.getAllByText(/P0-HG-/)).toHaveLength(4);

    const table = screen.getByRole("table");
    expect(within(table).getByText("0 / 12")).toBeVisible();
    expect(within(table).getByText("24 / 24")).toBeVisible();
    expect(within(table).getByText("12 / 12")).toBeVisible();
    expect(screen.getByText(/Changing this contract requires a new Challenge version/)).toBeVisible();
  });

  it("후보 결과·자동 우승자·실데이터 주장을 Define에 렌더링하지 않는다", () => {
    const { container } = render(<DefineStage challenge={challenge} />);
    expect(container.textContent).not.toMatch(
      /selected candidate|candidate [abc]|production customer/i,
    );
    expect(container.textContent).toMatch(/no composite score or automatic winner/i);
    expect(container.textContent).toMatch(/SYNTHETIC DATA/);
  });
});

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CompareStage,
  type CompareCandidateAggregateView,
  type CompareSlotView,
  type RecordedBenchmarkProgressView,
} from "../features/compare/CompareStage";

const candidateIds = ["A", "B", "C"] as const;
const caseIds = Array.from({ length: 12 }, (_, index) => (
  `H-${String(index + 1).padStart(3, "0")}`
));

function aggregate(
  candidateId: "A" | "B" | "C",
  failedCases = 0,
): CompareCandidateAggregateView {
  return {
    candidate_id: candidateId,
    counts: {
      scheduled_runs: 24,
      complete_runs: 24,
      invalid_runs: 0,
      timeout_runs: 0,
      budget_exceeded_runs: 0,
      hard_gate_failed_runs: failedCases,
      hard_gate_failed_cases: failedCases,
      policy_applicable_cases: 12,
      policy_success_cases: candidateId === "A" ? 10 : 11,
      citation_required_cases: 11,
      citation_success_cases: candidateId === "A" ? 10 : 11,
      escalation_required_cases: 4,
      escalation_success_cases: 4,
    },
    cost: { average_usd_per_ticket: candidateId === "A" ? 0.009 : candidateId === "B" ? 0.014 : 0.031 },
    latency: { median_ms: candidateId === "A" ? 1_100 : candidateId === "B" ? 1_700 : 3_400, worst_ms: candidateId === "C" ? 8_900 : 4_200 },
    stability: { comparable_cases: 12, stable_cases: 12, unstable_cases: 0 },
  };
}

function fixture(): RecordedBenchmarkProgressView {
  const slots: CompareSlotView[] = caseIds.flatMap((caseId) => (
    candidateIds.flatMap((candidateId) => ([1, 2] as const).map((repetition) => ({
      evidence_id: `slot_${caseId}_${candidateId}_${repetition}`,
      case_id: caseId,
      candidate_id: candidateId,
      repetition,
      execution_status: "COMPLETE",
      evaluation_status: "EVALUATED",
      hard_gate_status: caseId === "H-009" && candidateId === "A" && repetition === 2
        ? "CONFIRMED_FAIL" as const
        : "PASS" as const,
      cost_usd: 0.01,
      latency_ms: 1_200,
    })))
  ));
  return {
    benchmark_id: "b".repeat(64),
    source_hash: "c".repeat(64),
    source: "RECORDED_BENCHMARK",
    status: "REVIEW_PENDING",
    completed: 72,
    total: 72,
    review_time: "NOT_MEASURED",
    edit_time: "NOT_MEASURED",
    auxiliary_judge: {
      complete: 11,
      human_fallback: 1,
      total: 12,
    },
    candidate_aggregates: [aggregate("A", 1), aggregate("B"), aggregate("C")],
    slots,
  };
}

describe("실제 Recorded Benchmark Compare 화면", () => {
  it("사람 검수 중에는 후보-사례 실행 행렬과 raw Evidence 진입을 숨긴다", () => {
    render(<CompareStage benchmark={{ ...fixture(), slots: [] }} />);

    expect(screen.getByText(/Case-level evidence is withheld until blind human review is confirmed\./))
      .toBeVisible();
    expect(screen.queryByRole("table", {
      name: "12 hidden cases × 3 candidates × 2 fixed runs",
    })).not.toBeInTheDocument();
  });

  it("72-slot matrix와 hard-gate 실패를 평균보다 먼저 표시한다", () => {
    render(<CompareStage benchmark={fixture()} />);

    expect(screen.getByRole("heading", {
      name: "Compare AI approaches on the same work",
    })).toBeVisible();
    expect(screen.getByText("72 / 72 RUNS")).toBeVisible();
    const critical = screen.getByRole("region", { name: "Critical gate failures" });
    expect(critical).toHaveTextContent("Candidate A: 1 failed case");

    const matrix = screen.getByRole("table", {
      name: "12 hidden cases × 3 candidates × 2 fixed runs",
    });
    expect(within(matrix).getAllByRole("row")).toHaveLength(14);
    expect(within(matrix).getByText("H-009")).toBeVisible();
    expect(within(matrix).getByText("GATE FAIL")).toBeVisible();
  });

  it("품질·비용·속도·안정성·사람 시간을 분리하고 자동 우승자를 만들지 않는다", () => {
    const { container } = render(<CompareStage benchmark={fixture()} />);
    const aggregateTable = screen.getByRole("table", {
      name: "Quality, cost, speed, stability, and human time",
    });
    expect(within(aggregateTable).getByText("Critical failed cases")).toBeVisible();
    expect(within(aggregateTable).getAllByText("NOT_MEASURED")).toHaveLength(6);
    expect(container.textContent).toMatch(/No composite score and no automatic winner/);
    expect(container.textContent).not.toMatch(/selected candidate|recommended candidate/i);
  });

  it("보조 Judge 완료와 사람 fallback 수를 후보 신원 없이 분리해 표시한다", () => {
    render(<CompareStage benchmark={fixture()} />);

    expect(screen.getByText("11 complete · 1 human fallback")).toBeVisible();
  });

  it("실행 셀에서 실제 Evidence 진입 callback을 호출한다", async () => {
    const user = userEvent.setup();
    const opened: CompareSlotView[] = [];
    render(<CompareStage benchmark={fixture()} onOpenEvidence={(slot) => opened.push(slot)} />);
    await user.click(screen.getByRole("button", {
      name: "Open evidence for H-009, Candidate A, Run 2, GATE FAIL",
    }));
    expect(opened).toEqual([expect.objectContaining({
      case_id: "H-009",
      candidate_id: "A",
      repetition: 2,
      hard_gate_status: "CONFIRMED_FAIL",
    })]);
  });
});

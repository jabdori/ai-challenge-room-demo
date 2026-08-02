import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  parseRecordedHardGateMatrixProjection,
} from "../features/decision/recordedHardGateMatrixContract";
import {
  RecordedHardGateMatrix,
} from "../features/decision/RecordedHardGateMatrix";

const HASH = "a".repeat(64);
const GATES = [
  ["P0-HG-01", "Privacy & order ownership"],
  ["P0-HG-02", "Policy compliance & citation"],
  ["P0-HG-03", "Product safety & escalation"],
  ["P0-HG-04", "Tool & evidence grounding"],
] as const;

function cell(
  candidateId: "A" | "B" | "C",
  status: "PASS" | "CONFIRMED_FAIL" | "REVIEW" = "PASS",
) {
  const failure = status === "CONFIRMED_FAIL" ? 1 : 0;
  const review = status === "REVIEW" ? 1 : 0;
  return {
    candidate_id: candidateId,
    status,
    applicability: "APPLICABLE",
    counts: {
      total_runs: 24,
      pass_runs: 24 - failure - review,
      confirmed_fail_runs: failure,
      review_runs: review,
      not_applicable_runs: 0,
      affected_cases: failure + review,
    },
    evidence_binding_hash: HASH,
    evidence_action: null,
  };
}

function projection() {
  return {
    schema_version: "recorded-hard-gate-matrix-v1",
    synthetic: true,
    source: "RECORDED_BENCHMARK",
    source_hash: HASH,
    authority: "SOURCE_RELOADED_DETERMINISTIC_SLOT_EVIDENCE",
    aggregation_order: "CONFIRMED_FAIL_THEN_REVIEW_THEN_PASS",
    fatal_failures_are_not_averaged: true,
    rows: GATES.map(([gateCode, label], rowIndex) => ({
      gate_code: gateCode,
      label,
      decision_rule: `Locked rule for ${gateCode}.`,
      not_applicable_meaning: gateCode === "P0-HG-04"
        ? "A tool-free candidate is not automatically NOT APPLICABLE. NOT APPLICABLE is not PASS."
        : "NOT APPLICABLE is not PASS.",
      candidates: [
        cell("A", rowIndex === 0 ? "CONFIRMED_FAIL" : "PASS"),
        cell("B", rowIndex === 1 ? "REVIEW" : "PASS"),
        cell("C"),
      ],
    })),
  };
}

describe("Recorded hard-gate matrix projection 계약", () => {
  it("정확한 4×3 구조와 상태 우선순위만 허용하고 깊게 동결한다", () => {
    const parsed = parseRecordedHardGateMatrixProjection(projection());

    expect(parsed.rows).toHaveLength(4);
    expect(parsed.rows.map((row) => row.gateCode)).toEqual(
      GATES.map(([gateCode]) => gateCode),
    );
    expect(parsed.rows[0].candidates.map((candidate) => candidate.candidateId))
      .toEqual(["A", "B", "C"]);
    expect(parsed.rows[0].candidates[0].status).toBe("CONFIRMED_FAIL");
    expect(parsed.rows[1].candidates[1].status).toBe("REVIEW");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.rows[0].candidates[0].counts)).toBe(true);
  });

  it.each([
    ["row missing", (value: ReturnType<typeof projection>) => value.rows.pop()],
    ["row order", (value: ReturnType<typeof projection>) => {
      [value.rows[0], value.rows[1]] = [value.rows[1], value.rows[0]];
    }],
    ["candidate order", (value: ReturnType<typeof projection>) => {
      const candidates = value.rows[0].candidates;
      [candidates[0], candidates[1]] = [candidates[1], candidates[0]];
    }],
    ["count contradiction", (value: ReturnType<typeof projection>) => {
      value.rows[0].candidates[0].counts.pass_runs = 24;
    }],
    ["status contradiction", (value: ReturnType<typeof projection>) => {
      value.rows[0].candidates[0].status = "PASS";
    }],
    ["unexpected field", (value: ReturnType<typeof projection>) => {
      (value.rows[0].candidates[0] as Record<string, unknown>).winner = true;
    }],
  ])("누락·모순·변조를 거부한다: %s", (_name, mutate) => {
    const value = structuredClone(projection());
    mutate(value);

    expect(() => parseRecordedHardGateMatrixProjection(value)).toThrow(
      /hard-gate matrix|계약|projection/i,
    );
  });
});

describe("Recorded hard-gate matrix UI", () => {
  it("치명적 실패를 표보다 먼저 알리고 4×3 상태와 N/A 의미를 표시한다", () => {
    const matrix = parseRecordedHardGateMatrixProjection(projection());
    render(<RecordedHardGateMatrix matrix={matrix} onOpenEvidence={() => {}} />);

    const warning = screen.getByRole("alert", {
      name: /deterministic hard-gate failures/i,
    });
    const table = screen.getByRole("table", {
      name: /recorded hard-gate matrix/i,
    });
    expect(
      warning.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(5);
    expect(screen.getAllByText("Candidate A").length).toBeGreaterThan(0);
    expect(screen.getByText(/tool-free candidate is not automatically/i))
      .toBeVisible();
    expect(screen.getByText(/fatal findings cannot be offset/i)).toBeVisible();
  });

  it("후보 raw slot을 노출하지 않고 Evidence action을 withheld한다", async () => {
    const onOpenEvidence = vi.fn();
    const matrix = parseRecordedHardGateMatrixProjection(projection());
    render(
      <RecordedHardGateMatrix
        matrix={matrix}
        onOpenEvidence={onOpenEvidence}
      />,
    );

    expect(screen.queryAllByRole("button", {
      name: /open (?:failure|review) evidence/i,
    })).toHaveLength(0);
    expect(onOpenEvidence).not.toHaveBeenCalled();
  });
});

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  RecordedDecisionStage,
  RecordedMonitorStage,
  RecordedPreconfirmationStage,
} from "../features/recorded/RecordedWorkflowStages";
import type {
  FinalDecisionMemoView,
  HumanConfirmedDecisionView,
  RecordedPreconfirmationView,
  RecordedRegressionView,
} from "../features/recorded/contracts";

const hash = (character: string) => character.repeat(64);

const finalMemo: FinalDecisionMemoView = {
  sourceHash: hash("6"),
  decisionProjectionSourceHash: hash("6"),
  publicBodySha256: hash("memo-body"),
  bodyIntegrityVerified: true,
  decisionSummary: "The explicit human decision selected Candidate B.",
  rejectedAlternatives: [{
    candidateId: "A",
    reason: "Candidate A was not selected because of a locked failure.",
  }, {
    candidateId: "C",
    reason: "Candidate C was not selected because it adds complexity.",
  }],
  hardGateFindings: [{
    candidateId: "A",
    criticalFailedCaseIds: ["H-001"],
  }, {
    candidateId: "B",
    criticalFailedCaseIds: [],
  }, {
    candidateId: "C",
    criticalFailedCaseIds: [],
  }],
  knownLimitations: [
    "Benchmark scope: cases=12; candidates=3; runs_per_case=2.",
    "Candidate versions: A=v1 B=v1 C=v1.",
    "Human-review sample; statistical_generalization=NOT_SUPPORTED.",
    "P0 used one auxiliary gpt-5.6-sol Judge.",
    "Blinding does not eliminate single-Judge self-preference or position bias.",
  ],
  nextPocScope: "Run a separately approved shadow PoC.",
  procurementHandoff: "Use the existing procurement review.",
  externalActionStatement:
    "No purchase, contract, deployment, or rollback was executed.",
  candidateTradeOffs: [{
    candidateId: "A",
    disposition: "NOT_SELECTED",
    summary: "Candidate A was not selected because of a locked failure.",
    criticalFailedCaseIds: ["H-001"],
  }, {
    candidateId: "B",
    disposition: "SELECTED",
    summary: "The explicit human decision selected Candidate B.",
    criticalFailedCaseIds: [],
  }, {
    candidateId: "C",
    disposition: "NOT_SELECTED",
    summary: "Candidate C was not selected because it adds complexity.",
    criticalFailedCaseIds: [],
  }],
};

const preconfirmation: RecordedPreconfirmationView = {
  reviewId: "review-01",
  sourceHash: hash("a"),
  recordedBenchmarkPackHash: hash("b"),
  aiPreReviewReceiptHash: hash("c"),
  provisionalDecisionMemoHash: hash("d"),
  queueContentHash: hash("e"),
  queueSetOrderHash: hash("f"),
  preReviewStatus: "USER_CONFIRMATION_READY",
  blockingReasons: [],
  advisoryOnly: true,
  humanConfirmed: false,
  baselineVersion: null,
  total: 2,
  completed: 0,
  remaining: 2,
  confirmationAllowed: true,
  items: [
    {
      itemId: "item-01",
      evidenceId: "evidence-01",
      queueIndex: 1,
      caseId: "H-001",
      blindLabel: "X",
      candidateLabel: "Candidate X",
      queueReason: "LOCKED_HIGH_RISK",
      proposedDecision: "PROPOSED_PASS",
      rationale: "The two runs comply with the locked policy.",
      evidenceHandles: [`evh_${hash("1")}`],
      reviewEvidenceHandle: `evh_${hash("1")}`,
      reviewStatus: "REVIEW_REQUIRED",
    },
    {
      itemId: "item-02",
      evidenceId: "evidence-02",
      queueIndex: 2,
      caseId: "H-002",
      blindLabel: "Z",
      candidateLabel: "Candidate Z",
      queueReason: "JUDGE_RISK",
      proposedDecision: "PROPOSED_CONFIRMED_FAIL",
      rationale: "A policy-risk pattern requires human adjudication.",
      evidenceHandles: [`evh_${hash("2")}`],
      reviewEvidenceHandle: `evh_${hash("2")}`,
      reviewStatus: "REVIEW_REQUIRED",
    },
  ],
};

const decision: HumanConfirmedDecisionView = {
  decisionId: "decision-01",
  sourceHash: hash("1"),
  status: "HUMAN_CONFIRMED_REVIEW",
  recordedBenchmarkPackHash: hash("2"),
  aiPreReviewReceiptHash: hash("3"),
  provisionalDecisionMemoHash: hash("4"),
  humanConfirmationReceiptHash: hash("5"),
  finalDecisionMemoHash: null,
  finalDecisionMemo: null,
  finalMemoConfirmationHash: null,
  humanConfirmed: true,
  review: {
    completed: 2,
    total: 2,
    remaining: 0,
    totalReviewDurationMs: 42_000,
    totalEditDurationMs: 8_000,
  },
  candidates: [
    {
      candidateId: "A",
      gateStatus: "CONFIRMED_FAIL",
      eligible: false,
      sufficiencyPassed: false,
      failedSufficiencyRules: ["CRITICAL_FAILURES"],
      criticalFailedCaseIds: ["H-001"],
      complexityProfile: {
        modelCallStages: 1,
        retrievalIndexDependencies: 0,
        externalTools: 0,
        stateOrMemory: 0,
        candidateFailureComponents: 1,
        dedicatedInfrastructure: 0,
      },
      observed: {
        validRuns: 24,
        policySuccessCases: 11,
        citationSuccessCases: 12,
        escalationSuccessCases: 4,
        stableCases: 12,
        averageRuntimeCostUsd: 0.008,
        medianLatencyMs: 900,
        worstLatencyMs: 1500,
      },
    },
    {
      candidateId: "B",
      gateStatus: "PASS",
      eligible: true,
      sufficiencyPassed: true,
      failedSufficiencyRules: [],
      criticalFailedCaseIds: [],
      complexityProfile: {
        modelCallStages: 2,
        retrievalIndexDependencies: 1,
        externalTools: 0,
        stateOrMemory: 0,
        candidateFailureComponents: 2,
        dedicatedInfrastructure: 1,
      },
      observed: {
        validRuns: 24,
        policySuccessCases: 12,
        citationSuccessCases: 12,
        escalationSuccessCases: 4,
        stableCases: 12,
        averageRuntimeCostUsd: 0.012,
        medianLatencyMs: 1400,
        worstLatencyMs: 2300,
      },
    },
    {
      candidateId: "C",
      gateStatus: "PASS",
      eligible: true,
      sufficiencyPassed: true,
      failedSufficiencyRules: [],
      criticalFailedCaseIds: [],
      complexityProfile: {
        modelCallStages: 3,
        retrievalIndexDependencies: 1,
        externalTools: 2,
        stateOrMemory: 0,
        candidateFailureComponents: 3,
        dedicatedInfrastructure: 1,
      },
      observed: {
        validRuns: 24,
        policySuccessCases: 12,
        citationSuccessCases: 12,
        escalationSuccessCases: 4,
        stableCases: 12,
        averageRuntimeCostUsd: 0.025,
        medianLatencyMs: 2400,
        worstLatencyMs: 3800,
      },
    },
  ],
  eligibleCandidateIds: ["B", "C"],
  minimumComplexityCandidateIds: ["B"],
  recommendedCandidateId: "B",
  selectionAuthority: "HUMAN_DECISION_REQUIRED",
  selectedCandidateId: null,
  selectionRationale: null,
  baselineId: null,
  compositeScore: null,
};

const regression: RecordedRegressionView = {
  regressionId: "regression-01",
  sourceHash: hash("a"),
  source: "RECORDED_REGRESSION",
  status: "RECORDED",
  verdict: "BLOCK",
  baselineId: "baseline-01",
  baselineVersion: "v1",
  baselineCandidateId: "B",
  baselineConfigurationHash: hash("b"),
  proposedConfigurationHash: hash("c"),
  newHardGateFailures: [{
    caseId: "H-011",
    gateIds: ["P0-HG-01", "P0-HG-02"],
    evidenceId: "regression-evidence-01",
    baselineStatus: "PASS",
    proposedStatus: "CONFIRMED_FAIL",
  }],
  evidenceBindings: [{
    sourceHash: hash("a"),
    evidenceId: "regression-evidence-01",
    evidenceBindingHash: hash("d"),
    caseId: "H-011",
    candidateId: "B",
    candidateLabel: "Candidate B",
    version: "PROPOSED_V2",
    kind: "benchmark",
    source: "RECORDED REGRESSION",
  }],
  comparison: {
    baseline: {
      label: "Baseline v1",
      hardGateFailures: 0,
      meanRuntimeCostUsd: 0.012,
      medianLatencyMs: 1400,
      worstLatencyMs: 2300,
    },
    proposed: {
      label: "Proposed v2",
      hardGateFailures: 2,
      meanRuntimeCostUsd: 0.013,
      medianLatencyMs: 1500,
      worstLatencyMs: 2500,
    },
  },
  blockingReasons: [{
    code: "NEW_HARD_GATE_FAILURE",
    summary: "A new active-policy hard-gate failure was recorded.",
    evidenceId: "regression-evidence-01",
  }, {
    code: "PROPOSED_CRITICAL_OR_NON_COST_REGRESSION",
    summary: "A separate critical regression was recorded.",
    evidenceId: null,
  }],
  externalDeploymentPerformed: false,
  externalRollbackPerformed: false,
};

describe("실제 기록 기반 blind review", () => {
  it("X/Y/Z만 보여주고 보조 제안을 사람 확인과 분리한다", async () => {
    const user = userEvent.setup();
    const openEvidence = vi.fn(async () => true);
    const confirm = vi.fn();
    let now = 100;
    render(
      <RecordedPreconfirmationStage
        projection={preconfirmation}
        readOnly={false}
        onOpenEvidence={openEvidence}
        onConfirm={confirm}
        now={() => now}
      />,
    );

    const queue = screen.getByRole("region", { name: "Recorded blind review queue" });
    expect(within(queue).getAllByText(/H-001 · Candidate X/)[0]).toBeVisible();
    expect(within(queue).getAllByText(/H-002 · Candidate Z/)[0]).toBeVisible();
    expect(within(queue).queryByText("Candidate A")).not.toBeInTheDocument();
    expect(screen.getAllByText(/ADVISORY · NOT HUMAN CONFIRMED/i)).toHaveLength(2);
    expect(screen.getByText(hash("b"))).toBeVisible();
    expect(screen.getByText(hash("c"))).toBeVisible();
    expect(screen.getByText(hash("d"))).toBeVisible();
    expect(screen.getByText(hash("a"))).toBeVisible();

    const confirmButton = screen.getByRole("button", {
      name: "Confirm the blind review against the exact artifacts",
    });
    expect(confirmButton).toBeDisabled();
    expect(screen.getByRole("radio", {
      name: "PASS for H-001, Candidate X",
    })).not.toBeChecked();
    expect(screen.getByRole("textbox", {
      name: "Human rationale for H-001, Candidate X",
    })).toHaveValue("");

    await user.click(screen.getByRole("button", {
      name: "Open blind Evidence for H-001, Candidate X",
    }));
    await user.click(screen.getByRole("radio", {
      name: "PASS for H-001, Candidate X",
    }));
    await user.type(
      screen.getByRole("textbox", {
        name: "Human rationale for H-001, Candidate X",
      }),
      "The two runs comply with the locked policy.",
    );
    now = 200;
    await user.click(screen.getByRole("button", {
      name: "Open blind Evidence for H-002, Candidate Z",
    }));
    await user.click(screen.getByRole("radio", {
      name: "CONFIRMED FAIL for H-002, Candidate Z",
    }));
    await user.type(
      screen.getByRole("textbox", {
        name: "Human rationale for H-002, Candidate Z",
      }),
      "A policy-risk pattern requires human adjudication.",
    );
    now = 400;
    await user.type(
      screen.getByRole("textbox", { name: "Reviewer label" }),
      "Decision owner",
    );
    await user.click(screen.getByRole("checkbox", {
      name: "I reviewed every blind item and the exact artifact hashes",
    }));
    now = 500;
    await user.click(confirmButton);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({
      reviewId: "review-01",
      actorLabel: "Decision owner",
      expectedSourceHash: hash("a"),
      expectedRecordedBenchmarkPackHash: hash("b"),
      expectedAiPreReviewReceiptHash: hash("c"),
      expectedProvisionalDecisionMemoHash: hash("d"),
      items: [
        {
          itemId: "item-01",
          finalDecision: "PASS",
          proposalResolution: "ACCEPTED",
          reviewDurationMs: 400,
          editDurationMs: 0,
        },
        {
          itemId: "item-02",
          finalDecision: "CONFIRMED_FAIL",
          proposalResolution: "ACCEPTED",
          reviewDurationMs: 300,
          editDurationMs: 0,
        },
      ],
    });
    expect(screen.queryByText("HUMAN CONFIRMED")).not.toBeInTheDocument();
    expect(openEvidence).toHaveBeenNthCalledWith(1, "evidence-01");
    expect(openEvidence).toHaveBeenNthCalledWith(2, "evidence-02");
  });

  it("blocked pre-review에서는 사용자 확인 행동을 제공하지 않는다", () => {
    render(
      <RecordedPreconfirmationStage
        projection={{
          ...preconfirmation,
          preReviewStatus: "USER_CONFIRMATION_BLOCKED",
          blockingReasons: ["ABSTAIN"],
          confirmationAllowed: false,
          items: [{
            ...preconfirmation.items[0],
            proposedDecision: "ABSTAIN",
          }],
          total: 1,
          remaining: 1,
        }}
        readOnly={false}
        onOpenEvidence={vi.fn(async () => true)}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("ABSTAIN");
    expect(screen.queryByRole("button", {
      name: "Confirm the blind review against the exact artifacts",
    })).not.toBeInTheDocument();
  });

  it("Evidence 요청 실패는 item을 opened로 기록하지 않아 confirm을 열 수 없다", async () => {
    const user = userEvent.setup();
    const oneItem = {
      ...preconfirmation,
      total: 1,
      remaining: 1,
      items: [preconfirmation.items[0]],
    } as RecordedPreconfirmationView;
    const openEvidence = vi.fn(async () => false);
    render(
      <RecordedPreconfirmationStage
        projection={oneItem}
        readOnly={false}
        onOpenEvidence={openEvidence}
        onConfirm={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", {
      name: "Open blind Evidence for H-001, Candidate X",
    }));
    await user.click(screen.getByRole("radio", {
      name: "PASS for H-001, Candidate X",
    }));
    await user.type(screen.getByRole("textbox", {
      name: "Human rationale for H-001, Candidate X",
    }), "The two runs comply with the locked policy.");
    await user.type(screen.getByRole("textbox", {
      name: "Reviewer label",
    }), "Decision owner");
    await user.click(screen.getByRole("checkbox", {
      name: "I reviewed every blind item and the exact artifact hashes",
    }));

    expect(openEvidence).toHaveBeenCalledWith("evidence-01");
    expect(screen.getByRole("button", {
      name: "Confirm the blind review against the exact artifacts",
    })).toBeDisabled();
  });

  it("source hash가 바뀌면 이전 사람 입력을 새 artifact 확인에 재사용하지 않는다", async () => {
    const user = userEvent.setup();
    const oneItem = {
      ...preconfirmation,
      total: 1,
      remaining: 1,
      items: [preconfirmation.items[0]],
    } as RecordedPreconfirmationView;
    const { rerender } = render(
      <RecordedPreconfirmationStage
        projection={oneItem}
        readOnly={false}
        onOpenEvidence={vi.fn(async () => true)}
        onConfirm={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", {
      name: "Open blind Evidence for H-001, Candidate X",
    }));
    await user.click(screen.getByRole("radio", {
      name: "PASS for H-001, Candidate X",
    }));
    await user.type(screen.getByRole("textbox", {
      name: "Human rationale for H-001, Candidate X",
    }), "Explicit human rationale.");
    await user.type(screen.getByRole("textbox", {
      name: "Reviewer label",
    }), "Decision owner");
    await user.click(screen.getByRole("checkbox", {
      name: "I reviewed every blind item and the exact artifact hashes",
    }));
    expect(screen.getByRole("button", {
      name: "Confirm the blind review against the exact artifacts",
    })).toBeEnabled();

    rerender(
      <RecordedPreconfirmationStage
        projection={{ ...oneItem, sourceHash: hash("9") }}
        readOnly={false}
        onOpenEvidence={vi.fn(async () => true)}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("radio", {
      name: "PASS for H-001, Candidate X",
    })).not.toBeChecked();
    expect(screen.getByRole("textbox", { name: "Reviewer label" })).toHaveValue("");
    expect(screen.getByRole("button", {
      name: "Confirm the blind review against the exact artifacts",
    })).toBeDisabled();
  });
});

describe("실제 기록 기반 Decide", () => {
  it("hard gate를 먼저 보여주고 추천과 사용자 선택을 분리한다", async () => {
    const user = userEvent.setup();
    const requestMemo = vi.fn();
    render(
      <RecordedDecisionStage
        projection={decision}
        readOnly={false}
        onRequestMemo={requestMemo}
        onConfirmMemo={vi.fn()}
      />,
    );

    const gateRegion = screen.getByRole("region", { name: "Recorded hard-gate outcomes" });
    expect(within(gateRegion).getByText("Candidate A")).toBeVisible();
    expect(within(gateRegion).getByText("CONFIRMED FAIL")).toBeVisible();
    expect(screen.getByText("System recommendation")).toBeVisible();
    expect(screen.getByText(/Candidate B.*minimum-complexity sufficient option/i)).toBeVisible();
    expect(screen.getByRole("radio", { name: /Candidate A/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Candidate B/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /Candidate C/ })).not.toBeChecked();
    expect(screen.getByText("NO COMPOSITE SCORE")).toBeVisible();

    await user.click(screen.getByRole("radio", { name: /Candidate B/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Decision rationale" }),
      "Candidate B passes every locked requirement with the minimum recorded complexity.",
    );
    await user.click(screen.getByRole("button", { name: "Generate recorded Decision Memo" }));

    expect(requestMemo).toHaveBeenCalledWith({
      decisionId: "decision-01",
      expectedSourceHash: hash("1"),
      action: "SELECT_CANDIDATE",
      selectedCandidateId: "B",
      rationale: "Candidate B passes every locked requirement with the minimum recorded complexity.",
    });
    expect(screen.queryByText("ACTIVE BASELINE")).not.toBeInTheDocument();
  });

  it("eligible 후보가 있어도 사람은 명시적으로 모두 거절하고 no-approved Memo를 요청할 수 있다", async () => {
    const user = userEvent.setup();
    const requestMemo = vi.fn();
    render(
      <RecordedDecisionStage
        projection={decision}
        readOnly={false}
        onRequestMemo={requestMemo}
        onConfirmMemo={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("radio", {
      name: "Record no approved candidate instead",
    }));
    await user.type(
      screen.getByRole("textbox", { name: "Decision rationale" }),
      "The owner declines all eligible candidates because the remaining operational burden is unacceptable.",
    );
    await user.click(screen.getByRole("button", {
      name: "Generate no-approved Decision Memo",
    }));

    expect(requestMemo).toHaveBeenCalledWith({
      decisionId: "decision-01",
      expectedSourceHash: hash("1"),
      action: "SELECT_NO_APPROVED_CANDIDATE",
      selectedCandidateId: null,
      rationale:
        "The owner declines all eligible candidates because the remaining operational burden is unacceptable.",
    });
    expect(screen.getByRole("radio", { name: /Candidate B/ })).not.toBeChecked();
  });

  it("Final Memo가 생성된 뒤에도 exact hash를 사람이 확인하기 전 baseline을 만들지 않는다", async () => {
    const user = userEvent.setup();
    const confirmMemo = vi.fn();
    render(
      <RecordedDecisionStage
        projection={{
          ...decision,
          sourceHash: hash("6"),
          status: "MEMO_REVIEW_REQUIRED",
          selectedCandidateId: "B",
          selectionRationale: "Candidate B is the selected sufficient configuration.",
          finalDecisionMemoHash: hash("6"),
          finalDecisionMemo: finalMemo,
        }}
        readOnly={false}
        onRequestMemo={vi.fn()}
        onConfirmMemo={confirmMemo}
      />,
    );

    expect(screen.getByText(hash("6"))).toBeVisible();
    const button = screen.getByRole("button", {
      name: "Confirm the exact Decision Memo and create baseline",
    });
    expect(button).toBeDisabled();
    await user.click(screen.getByRole("checkbox", {
      name: "I reviewed the exact validated Final Decision Memo",
    }));
    await user.click(button);

    expect(confirmMemo).toHaveBeenCalledWith({
      decisionId: "decision-01",
      expectedSourceHash: hash("6"),
      expectedFinalDecisionMemoHash: hash("6"),
    });
    expect(screen.queryByText("ACTIVE BASELINE")).not.toBeInTheDocument();
  });

  it("승인 가능한 후보가 없으면 정상 결정 결과로 표시하고 선택·기준선을 만들지 않는다", () => {
    const noApproved = {
      ...decision,
      status: "NO_APPROVED_CANDIDATE",
      candidates: decision.candidates.map((candidate) => ({
        ...candidate,
        gateStatus: "CONFIRMED_FAIL",
        eligible: false,
        sufficiencyPassed: false,
        failedSufficiencyRules: ["CRITICAL_FAILURES"],
        criticalFailedCaseIds: ["H-001"],
      })),
      eligibleCandidateIds: [],
      minimumComplexityCandidateIds: [],
      recommendedCandidateId: null,
      selectionRationale:
        "Every candidate has a confirmed fatal failure under the locked requirements.",
      finalDecisionMemoHash: hash("6"),
      finalMemoConfirmationHash: hash("7"),
    } as HumanConfirmedDecisionView;
    render(
      <RecordedDecisionStage
        projection={noApproved}
        readOnly={false}
        onRequestMemo={vi.fn()}
        onConfirmMemo={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", {
      name: "No approved candidate",
    })).toBeVisible();
    expect(screen.getByText("NO APPROVED CANDIDATE")).toBeVisible();
    expect(screen.queryByText("HUMAN CONFIRMED REVIEW")).not.toBeInTheDocument();
    expect(screen.getByText(
      "No candidate passed every locked requirement.",
    )).toBeVisible();
    expect(screen.getByText(
      "Every candidate has a confirmed fatal failure under the locked requirements.",
    )).toBeVisible();
    expect(screen.queryByRole("button", {
      name: "Generate recorded Decision Memo",
    })).not.toBeInTheDocument();
    expect(screen.queryByText("ACTIVE BASELINE")).not.toBeInTheDocument();
  });

  it("통과 후보를 모두 거절한 terminal 결과는 통과 결과와 사람의 거절 사유를 보존한다", () => {
    const rationale =
      "The owner declines Candidates B and C until the operating dependency is approved.";
    render(
      <RecordedDecisionStage
        projection={{
          ...decision,
          status: "NO_APPROVED_CANDIDATE",
          selectionRationale: rationale,
          finalDecisionMemoHash: hash("6"),
          finalMemoConfirmationHash: hash("7"),
        }}
        readOnly={false}
        onRequestMemo={vi.fn()}
        onConfirmMemo={vi.fn()}
      />,
    );

    expect(screen.getByText(
      "Passing candidates were not approved by the human decision owner.",
    )).toBeVisible();
    expect(screen.getByText(rationale)).toBeVisible();
    expect(screen.getByText(
      "The passing evaluation results remain unchanged.",
    )).toBeVisible();
    expect(screen.queryByText("ACTIVE BASELINE")).not.toBeInTheDocument();
  });

  it("Decision source hash가 바뀌면 이전 선택과 rationale을 폐기한다", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <RecordedDecisionStage
        projection={decision}
        readOnly={false}
        onRequestMemo={vi.fn()}
        onConfirmMemo={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("radio", { name: /Candidate B/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Decision rationale" }),
      "Decision against the first artifact.",
    );

    rerender(
      <RecordedDecisionStage
        projection={{ ...decision, sourceHash: hash("9") }}
        readOnly={false}
        onRequestMemo={vi.fn()}
        onConfirmMemo={vi.fn()}
      />,
    );

    expect(screen.getByRole("radio", { name: /Candidate B/ })).not.toBeChecked();
    expect(screen.getByRole("textbox", {
      name: "Decision rationale",
    })).toHaveValue("");
    expect(screen.getByRole("button", {
      name: "Generate recorded Decision Memo",
    })).toBeDisabled();
  });
});

describe("실제 기록 기반 Monitor", () => {
  it("새 hard-gate 실패를 평균보다 먼저 보여주고 외부 행동이 없음을 명시한다", async () => {
    const user = userEvent.setup();
    const openEvidence = vi.fn();
    render(
      <RecordedMonitorStage
        projection={regression}
        onOpenEvidence={openEvidence}
      />,
    );

    const firstFailure = screen.getByRole("region", { name: "First new hard-gate failure" });
    const comparison = screen.getByRole("region", { name: "Recorded regression comparison" });
    expect(
      firstFailure.compareDocumentPosition(comparison)
      & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "BLOCK" })).toBeVisible();
    expect(firstFailure).toHaveTextContent("H-011");
    expect(firstFailure).toHaveTextContent("P0-HG-01");
    const reasons = screen.getByRole("region", {
      name: "Recorded blocking and review reasons",
    });
    expect(reasons).toHaveTextContent("NEW HARD GATE FAILURE");
    expect(reasons).toHaveTextContent("PROPOSED CRITICAL OR NON COST REGRESSION");
    expect(reasons).toHaveTextContent("A separate critical regression was recorded.");
    expect(screen.getByText(
      "This product did not deploy, roll back, or change any external production system.",
    )).toBeVisible();

    await user.click(screen.getByRole("button", {
      name: "Open recorded regression Evidence for H-011",
    }));
    expect(openEvidence).toHaveBeenCalledWith("regression-evidence-01");
  });

  it("PASS·REVIEW·EVALUATION_INCOMPLETE를 서로 다른 비차단 상태로 보존한다", () => {
    const { rerender } = render(
      <RecordedMonitorStage
        projection={{
          ...regression,
          verdict: "PASS",
          newHardGateFailures: [],
          blockingReasons: [],
          comparison: {
            ...regression.comparison,
            proposed: {
              ...regression.comparison.proposed,
              hardGateFailures: 0,
            },
          },
        }}
        onOpenEvidence={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "PASS" })).toBeVisible();
    expect(screen.getByLabelText("Pass verdict icon")).toBeVisible();

    rerender(
      <RecordedMonitorStage
        projection={{
          ...regression,
          verdict: "REVIEW",
          newHardGateFailures: [],
          blockingReasons: [{
            code: "COST_LIMIT_EXCEEDED",
            summary: "Cost requires human review.",
            evidenceId: null,
          }],
        }}
        onOpenEvidence={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "REVIEW" })).toBeVisible();
    expect(screen.getByLabelText("Review verdict icon")).toBeVisible();

    rerender(
      <RecordedMonitorStage
        projection={{
          ...regression,
          verdict: "EVALUATION_INCOMPLETE",
          newHardGateFailures: [],
          blockingReasons: [{
            code: "PROPOSED_RUNNER_OR_EVIDENCE_INTEGRITY_INCOMPLETE",
            summary: "Evidence is incomplete.",
            evidenceId: null,
          }],
        }}
        onOpenEvidence={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", {
      name: "EVALUATION INCOMPLETE",
    })).toBeVisible();
    expect(screen.getByLabelText("Incomplete verdict icon")).toBeVisible();
  });
});

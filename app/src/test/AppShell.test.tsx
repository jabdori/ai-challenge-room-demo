import { render, screen } from "@testing-library/react";
import { AppShell } from "../app/AppShell";

describe("작업공간 레일(workspace rail)", () => {
  it("긴 권위 상태와 평가팩 식별자는 전체 접근성 값을 유지하며 짧게 표시한다", () => {
    const evaluationPackLabel =
      "live-demo-pack-d0b6401234567890abcdef1234567890a45ab1";

    render(
      <AppShell
        stage="Decide"
        status="DECISION MEMO GENERATING"
        readOnly={false}
        stageStatuses={{
          Compare: "EVIDENCE READY",
          Monitor: "NO BASELINE",
        }}
        evaluationPackLabel={evaluationPackLabel}
      >
        <p>Workspace</p>
      </AppShell>,
    );

    expect(screen.getByLabelText(
      "Decide, DECISION MEMO GENERATING",
    )).toHaveTextContent("MEMO");
    expect(screen.getByLabelText(
      "Compare, EVIDENCE READY",
    )).toHaveTextContent("READY");
    expect(screen.getByLabelText(
      "Monitor, NO BASELINE",
    )).toHaveTextContent("NO BASELINE");

    const evaluationPack = screen.getByLabelText(
      `Evaluation pack, ${evaluationPackLabel}`,
    );
    expect(evaluationPack).toHaveAttribute("title", evaluationPackLabel);
    expect(evaluationPack).toHaveTextContent("…");
    expect(evaluationPack).not.toHaveTextContent(evaluationPackLabel);
  });

  it("실행 전 결정 상태는 단계 의미에 맞는 짧은 표시를 사용한다", () => {
    render(
      <AppShell
        stage="Define"
        status="READY"
        readOnly={false}
        stageStatuses={{
          Compare: "NOT STARTED",
          Decide: "NO DECISION",
          Monitor: "NO DECISION",
        }}
      >
        <p>Workspace</p>
      </AppShell>,
    );

    expect(screen.getByLabelText(
      "Compare, NOT STARTED",
    )).toHaveTextContent("PENDING");
    expect(screen.getByLabelText(
      "Decide, NO DECISION",
    )).toHaveTextContent("REQUIRED");
    expect(screen.getByLabelText(
      "Monitor, NO DECISION",
    )).toHaveTextContent("LOCKED");
  });

  it("라이브 실행 상태와 완료 수는 좁은 레일에 맞게 축약한다", () => {
    render(
      <AppShell
        stage="Define"
        status="LIVE COMPARISON RUNNING"
        readOnly={false}
        stageStatuses={{ Compare: "0 / 3 LIVE" }}
      >
        <p>Workspace</p>
      </AppShell>,
    );

    expect(screen.getByLabelText(
      "Define, LIVE COMPARISON RUNNING",
    )).toHaveTextContent("RUNNING");
    expect(screen.getByLabelText(
      "Compare, 0 / 3 LIVE",
    )).toHaveTextContent("0/3 LIVE");
  });
});

import { describe, expect, it } from "vitest";
import {
  demoJudgeFailureTypePresentation,
  demoJudgeSignalPresentation,
} from "../features/demo/demoPresentation";

describe("데모 Judge 표시 의미(demo Judge presentation)", () => {
  it("NO_RISK를 통과가 아닌 중립적인 추가 신호 없음으로 표시한다", () => {
    expect(demoJudgeSignalPresentation("NO_RISK")).toEqual({
      label: "NO ADDITIONAL SIGNAL",
      tone: "neutral",
      description: "No additional review signal was raised.",
    });
  });

  it("RISK를 사람의 추가 검토 신호로 표시한다", () => {
    expect(demoJudgeSignalPresentation("RISK")).toEqual({
      label: "ADDITIONAL REVIEW SIGNAL",
      tone: "review",
      description: "An additional review signal was raised.",
    });
  });

  it("잠긴 실패 코드를 사람이 읽을 수 있는 설명으로 변환한다", () => {
    expect(demoJudgeFailureTypePresentation("CITATION_NOT_RELEVANT")).toEqual({
      label: "Citation may not be relevant",
      rawCode: "CITATION_NOT_RELEVANT",
    });
    expect(
      demoJudgeFailureTypePresentation("UNSUPPORTED_COMPLETION_PROMISE"),
    ).toEqual({
      label: "Reply may promise an action that was not completed",
      rawCode: "UNSUPPORTED_COMPLETION_PROMISE",
    });
  });

  it("알 수 없는 코드를 숨기지 않고 일반 설명과 원시 코드로 보존한다", () => {
    expect(demoJudgeFailureTypePresentation("NEW_LOCKED_SIGNAL")).toEqual({
      label: "Additional review signal",
      rawCode: "NEW_LOCKED_SIGNAL",
    });
  });
});

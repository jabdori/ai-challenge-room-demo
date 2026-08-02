import { describe, expect, it } from "vitest";
import recordedCss from "../features/recorded/RecordedWorkflowStages.css?raw";
import tokenCss from "../styles/tokens.css?raw";

describe("기록 workflow 스타일 토큰", () => {
  it("사용한 모든 CSS 변수는 승인된 토큰 파일에 정의돼 있다", () => {
    const used = [...recordedCss.matchAll(/var\((--[a-z0-9-]+)\)/g)]
      .map((match) => match[1]);
    const defined = new Set(
      [...tokenCss.matchAll(/(--[a-z0-9-]+)\s*:/g)]
        .map((match) => match[1]),
    );

    expect([...new Set(used.filter((token) => !defined.has(token)))]).toEqual([]);
  });
});

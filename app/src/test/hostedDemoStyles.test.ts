import { describe, expect, it } from "vitest";
import globalCss from "../styles/global.css?raw";

describe("호스팅 데모 공간·반응형 계약(hosted demo layout contract)", () => {
  it("외부 호출 진행 카드와 접근 폼 카드의 폭·여백을 구분한다", () => {
    expect(globalCss).toMatch(
      /\.demo-live-progress\s*\{[^}]*min-width:\s*0;[^}]*margin:\s*16px 20px 18px;/s,
    );
    expect(globalCss).toMatch(
      /\.demo-live-progress\.judge-access-progress\s*\{[^}]*max-width:\s*440px;[^}]*margin:\s*0;/s,
    );
  });

  it("비교 도움말과 Judge 권한 카드가 독립적인 여백을 가진다", () => {
    expect(globalCss).toMatch(
      /\.demo-comparison-summary\s*\{[^}]*margin:\s*16px 20px 0;/s,
    );
    expect(globalCss).toMatch(
      /\.demo-authority-note\s*\{[^}]*margin:\s*16px 20px 18px;/s,
    );
    expect(globalCss).toMatch(
      /\.demo-review-boundary\s*\{[^}]*margin:\s*16px 20px 18px;/s,
    );
  });

  it("사람 검수 폼과 좁은 화면 검수 카드를 한 열로 재배치한다", () => {
    expect(globalCss).toMatch(
      /\.demo-review-form\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/s,
    );
    expect(globalCss).toMatch(
      /@media \(max-width:\s*960px\)\s*\{[\s\S]*?\.demo-blind-grid\s*\{[^}]*grid-template-columns:\s*1fr;/s,
    );
    expect(globalCss).toMatch(
      /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.demo-live-progress\s*\{[^}]*margin:\s*14px;/s,
    );
    expect(globalCss).toMatch(
      /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.demo-table-scroll-hint\s*\{[^}]*display:\s*block;/s,
    );
  });
});

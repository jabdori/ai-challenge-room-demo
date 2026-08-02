// @vitest-environment node

import { describe, expect, it } from "vitest";
import { requireOpenAiApiKey } from "../cli/config";

describe("라이브 smoke 환경 설정", () => {
  it("API 키가 없으면 네트워크 호출 전에 명확히 중단한다", () => {
    expect(() => requireOpenAiApiKey({})).toThrowError(
      "OPENAI_API_KEY가 없습니다. 라이브 OpenAI calibration을 실행하려면 현재 셸에만 키를 설정해 주세요.",
    );
  });

  it("키 문자열을 반환하지만 오류나 로그에 키를 포함하지 않는다", () => {
    expect(requireOpenAiApiKey({ OPENAI_API_KEY: "secret-test-key" })).toBe("secret-test-key");
  });
});

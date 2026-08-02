// @vitest-environment node

import { describe, expect, it } from "vitest";
import { calibrationSmokeFailureMessage } from "../cli/calibrationSmokeFailure";

describe("calibration smoke stderr 경계", () => {
  it("예상 밖 오류의 원문·credential 형태를 stderr 메시지에 포함하지 않는다", () => {
    const secret = `sk-${"x".repeat(24)}`;
    const message = calibrationSmokeFailureMessage(
      new Error(`unexpected adapter fault ${secret}`),
    );

    expect(message).toBe("Calibration smoke failed before a verified result was recorded.");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("unexpected adapter fault");
  });
});

// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { PartialEvaluationPack } from "../pack/evaluationPack";
import { assertCalibrationSmokeSucceeded } from "../cli/smokeOutcome";

function packWithRun(
  status: "COMPLETE" | "INVALID",
  gate: "EVALUATED" | "NOT_EVALUATED",
  gateStatus: "PASS" | "CONFIRMED_FAIL" = "PASS",
) {
  return {
    source: "CALIBRATION_SMOKE",
    evaluation_status: "EVALUATION_INCOMPLETE",
    runs: [
      {
        execution: { runNumber: 1, status },
        gate: gate === "EVALUATED"
          ? { runNumber: 1, evaluation: "EVALUATED", result: { status: gateStatus } }
          : { runNumber: 1, evaluation: "NOT_EVALUATED", reason: "INVALID_OUTPUT" },
      },
    ],
  } as unknown as PartialEvaluationPack;
}

describe("calibration smoke 프로세스 결과", () => {
  it("부분 평가팩이어도 실행과 gate가 완료되면 명령 성공이다", () => {
    expect(() => assertCalibrationSmokeSucceeded(packWithRun("COMPLETE", "EVALUATED"))).not.toThrow();
  });

  it("INVALID 실행을 JSON으로 저장한 뒤에도 명령은 실패로 종료해야 한다", () => {
    expect(() => assertCalibrationSmokeSucceeded(packWithRun("INVALID", "NOT_EVALUATED"))).toThrow(
      "Calibration smoke의 1개 실행이 완료되지 않았습니다.",
    );
  });

  it("개발자용 calibration smoke는 결정적 gate 실패도 비정상 종료한다", () => {
    expect(() => assertCalibrationSmokeSucceeded(
      packWithRun("COMPLETE", "EVALUATED", "CONFIRMED_FAIL"),
    )).toThrow("Calibration smoke의 1개 실행이 hard gate를 통과하지 못했습니다.");
  });
});

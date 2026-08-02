import type { PartialEvaluationPack } from "../pack/evaluationPack";

export function assertCalibrationSmokeSucceeded(pack: PartialEvaluationPack): void {
  const incompleteRuns = pack.runs.filter(({ execution, gate }) =>
    execution.status !== "COMPLETE" || gate.evaluation !== "EVALUATED",
  );
  if (incompleteRuns.length > 0) {
    throw new Error(`Calibration smoke의 ${incompleteRuns.length}개 실행이 완료되지 않았습니다.`);
  }

  const failedGates = pack.runs.filter(({ gate }) =>
    gate.evaluation === "EVALUATED" && gate.result.status !== "PASS",
  );
  if (failedGates.length > 0) {
    throw new Error(`Calibration smoke의 ${failedGates.length}개 실행이 hard gate를 통과하지 못했습니다.`);
  }
}

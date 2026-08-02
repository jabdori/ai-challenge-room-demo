import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CalibrationOutcome } from "./calibrationOutcome";
import {
  DEFAULT_CALIBRATION_OUTPUT_DIRECTORY,
  executeProductionThreeCandidateCalibration,
} from "./productionThreeCandidateCalibration";
import { CalibrationInterruptionError } from "./threeCandidateCalibrationCommand";

type CalibrationSignal = "SIGINT" | "SIGTERM";

export interface CalibrationProcessLike {
  env: NodeJS.ProcessEnv;
  exitCode?: string | number | null;
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
  on(event: CalibrationSignal, listener: () => void): unknown;
  removeListener(event: CalibrationSignal, listener: () => void): unknown;
}

interface ProcessCommandOptions {
  environment: NodeJS.ProcessEnv;
  outputDirectory: string;
  signal?: AbortSignal;
}

type ExecuteProcessCommand = (
  options: ProcessCommandOptions,
) => Promise<CalibrationOutcome>;

interface RunThreeCandidateCalibrationProcessOptions {
  runtime?: CalibrationProcessLike;
  executeCommand?: ExecuteProcessCommand;
}

function resolveOutputDirectory(environment: NodeJS.ProcessEnv): string {
  const configured = environment.AI_CALIBRATION_OUTPUT_DIR?.trim();
  return configured
    ? resolve(configured)
    : DEFAULT_CALIBRATION_OUTPUT_DIRECTORY;
}

export async function runThreeCandidateCalibrationProcess({
  runtime = process,
  executeCommand = executeProductionThreeCandidateCalibration,
}: RunThreeCandidateCalibrationProcessOptions = {}): Promise<CalibrationOutcome | null> {
  const controller = new AbortController();
  const interrupt = (signalName: CalibrationSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(new CalibrationInterruptionError(signalName));
    }
  };
  const handleSigint = () => interrupt("SIGINT");
  const handleSigterm = () => interrupt("SIGTERM");
  runtime.on("SIGINT", handleSigint);
  runtime.on("SIGTERM", handleSigterm);

  try {
    const outcome = await executeCommand({
      environment: runtime.env,
      outputDirectory: resolveOutputDirectory(runtime.env),
      signal: controller.signal,
    });
    runtime.stdout.write(`${JSON.stringify(outcome.summary, null, 2)}\n`);
    runtime.exitCode = outcome.exitCode;
    return outcome;
  } catch {
    // 예상하지 못한 오류 원문에는 key나 resource ID가 포함될 수 있으므로 출력하지 않습니다.
    runtime.stderr.write("Calibration command가 예상 밖 오류로 종료됐습니다.\n");
    const interruption = controller.signal.reason;
    runtime.exitCode = interruption instanceof CalibrationInterruptionError
      ? interruption.signalName === "SIGINT" ? 130 : 143
      : 1;
    return null;
  } finally {
    runtime.removeListener("SIGINT", handleSigint);
    runtime.removeListener("SIGTERM", handleSigterm);
  }
}

function isDirectExecution(metaUrl: string, argvEntry: string | undefined): boolean {
  return argvEntry !== undefined
    && metaUrl === pathToFileURL(resolve(argvEntry)).href;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void runThreeCandidateCalibrationProcess();
}

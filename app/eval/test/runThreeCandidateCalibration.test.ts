// @vitest-environment node

import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { deriveCalibrationOutcome } from "../cli/calibrationOutcome";
import { CalibrationInterruptionError } from "../cli/threeCandidateCalibrationCommand";
import {
  runThreeCandidateCalibrationProcess,
  type CalibrationProcessLike,
} from "../cli/runThreeCandidateCalibration";
import {
  TEST_RESOURCE_IDS,
  buildSummaryPack,
  completeCleanup,
} from "./helpers/calibrationCommandFixtures";

class FakeProcess extends EventEmitter implements CalibrationProcessLike {
  readonly env: NodeJS.ProcessEnv;
  exitCode: number | undefined;
  readonly stdoutText: string[] = [];
  readonly stderrText: string[] = [];
  readonly stdout = { write: (value: string) => { this.stdoutText.push(value); return true; } };
  readonly stderr = { write: (value: string) => { this.stderrText.push(value); return true; } };

  constructor(environment: NodeJS.ProcessEnv = { OPENAI_API_KEY: "test-key-only" }) {
    super();
    this.env = environment;
  }
}

function successfulOutcome() {
  return deriveCalibrationOutcome({
    pack: buildSummaryPack(),
    topPackPath: "/runtime/top-pack.json",
    expectedResources: TEST_RESOURCE_IDS,
    cleanup: completeCleanup(),
  });
}

describe("A/B/C calibration process entrypoint", () => {
  it("첫 SIGINT만 AbortSignal reason으로 채택하고 SIGTERM은 무시한 뒤 listener를 제거한다", async () => {
    const runtime = new FakeProcess();
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => { commandStarted = resolve; });
    const executeCommand = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      commandStarted();
      return await new Promise<ReturnType<typeof successfulOutcome>>((resolve) => {
        signal?.addEventListener("abort", () => {
          queueMicrotask(() => resolve(deriveCalibrationOutcome({
            pack: null,
            topPackPath: null,
            interruption: signal.reason instanceof CalibrationInterruptionError
              ? signal.reason.signalName
              : null,
            runtimeErrors: [signal.reason],
          })));
        }, { once: true });
      });
    });

    const running = runThreeCandidateCalibrationProcess({ runtime, executeCommand });
    await started;
    runtime.emit("SIGINT");
    runtime.emit("SIGTERM");
    const outcome = await running;

    expect(outcome?.exitCode).toBe(130);
    expect(runtime.exitCode).toBe(130);
    expect(executeCommand).toHaveBeenCalledOnce();
    const signal = vi.mocked(executeCommand).mock.calls[0][0].signal;
    expect(signal?.reason).toMatchObject({ signalName: "SIGINT" });
    expect(runtime.listenerCount("SIGINT")).toBe(0);
    expect(runtime.listenerCount("SIGTERM")).toBe(0);
  });

  it("종료 요약만 stdout에 쓰고 full resource ID나 키를 출력하지 않는다", async () => {
    const runtime = new FakeProcess();
    const outcome = successfulOutcome();
    await runThreeCandidateCalibrationProcess({
      runtime,
      executeCommand: vi.fn().mockResolvedValue(outcome),
    });

    const output = runtime.stdoutText.join("");
    expect(JSON.parse(output)).toEqual(outcome.summary);
    expect(output).not.toContain(TEST_RESOURCE_IDS.vectorStoreId);
    expect(TEST_RESOURCE_IDS.uploadedFileIds.every((id) => !output.includes(id))).toBe(true);
    expect(output).not.toContain(runtime.env.OPENAI_API_KEY!);
    expect(runtime.stderrText).toEqual([]);
    expect(runtime.exitCode).toBe(0);
  });

  it("예상 밖 entrypoint 오류도 원문 오류를 출력하지 않고 listener를 제거한다", async () => {
    const runtime = new FakeProcess();
    const secret = "entrypoint-secret-value";
    const result = await runThreeCandidateCalibrationProcess({
      runtime,
      executeCommand: vi.fn().mockRejectedValue(new Error(`unexpected ${secret}`)),
    });

    expect(result).toBeNull();
    expect(runtime.exitCode).toBe(1);
    expect(runtime.stderrText.join("")).not.toContain(secret);
    expect(runtime.listenerCount("SIGINT")).toBe(0);
    expect(runtime.listenerCount("SIGTERM")).toBe(0);
  });

  it("signal 뒤 예상 밖 entrypoint 오류가 나도 첫 interruption 종료 코드가 우선한다", async () => {
    const runtime = new FakeProcess();
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => { commandStarted = resolve; });
    const running = runThreeCandidateCalibrationProcess({
      runtime,
      executeCommand: vi.fn(async ({ signal }): Promise<never> => {
        commandStarted();
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("late failure")), {
            once: true,
          });
        });
      }),
    });
    await started;
    runtime.emit("SIGTERM");
    runtime.emit("SIGINT");

    expect(await running).toBeNull();
    expect(runtime.exitCode).toBe(143);
    expect(runtime.listenerCount("SIGINT")).toBe(0);
    expect(runtime.listenerCount("SIGTERM")).toBe(0);
  });

  it("실제 keyless subprocess는 네트워크 client·출력 디렉터리·receipt 없이 exit 1이다", async () => {
    const parent = await mkdtemp(join(tmpdir(), "calibration-keyless-"));
    const outputDirectory = join(parent, "must-not-exist");
    const networkSentinel = join(parent, "network-attempted");
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      AI_CALIBRATION_OUTPUT_DIR: outputDirectory,
      CALIBRATION_NETWORK_SENTINEL: networkSentinel,
    };
    delete environment.OPENAI_API_KEY;

    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--import",
              "tsx",
              "--import",
              "./eval/test/helpers/denyCalibrationNetwork.ts",
              "eval/cli/runThreeCandidateCalibration.ts",
            ],
            { cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"] },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => { stdout += String(chunk); });
          child.stderr.on("data", (chunk) => { stderr += String(chunk); });
          child.once("error", reject);
          child.once("close", (code) => resolve({ code, stdout, stderr }));
        },
      );

      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command_status: "CALIBRATION_FAILED",
        usage_complete: false,
        total_runtime_cost_usd: null,
        cleanup: { required: 0 },
      });
      expect(result.stderr).toBe("");
      await expect(access(networkSentinel)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 15_000);
});

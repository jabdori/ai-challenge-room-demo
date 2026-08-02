// @vitest-environment node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DecisionBaselineRecord } from "../decision/decisionBaseline";
import {
  RECORDED_REGRESSION_ACKNOWLEDGEMENT,
  RECORDED_REGRESSION_ACKNOWLEDGEMENT_ENV,
  executeProductionRecordedRegressionFromAuthority,
  runRecordedRegressionProcess,
} from "../cli/runRecordedRegression";

function runtime({
  tty = true,
  acknowledgement = RECORDED_REGRESSION_ACKNOWLEDGEMENT,
}: {
  readonly tty?: boolean;
  readonly acknowledgement?: string;
} = {}) {
  const listeners = new Map<string, () => void>();
  return {
    env: {
      [RECORDED_REGRESSION_ACKNOWLEDGEMENT_ENV]: acknowledgement,
    },
    exitCode: null as string | number | null,
    stdin: { isTTY: tty },
    stdout: {
      isTTY: tty,
      write: vi.fn(),
    },
    stderr: {
      write: vi.fn(),
    },
    on: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
    }),
    removeListener: vi.fn((event: string) => {
      listeners.delete(event);
    }),
  };
}

describe("기록 회귀 production command 경계", () => {
  it("TTY·명시적 36회 확인이 없으면 command를 호출하지 않는다", async () => {
    const executeCommand = vi.fn();
    const nonTty = runtime({ tty: false });

    await expect(runRecordedRegressionProcess({
      runtime: nonTty,
      executeCommand,
    })).resolves.toBeNull();

    expect(executeCommand).not.toHaveBeenCalled();
    expect(nonTty.exitCode).toBe(1);
    expect(nonTty.stderr.write).toHaveBeenCalledWith(
      expect.stringMatching(/36|합성|TTY/i),
    );
  });

  it("standalone loader가 연결되지 않으면 API key 확인·원격 호출 전에 fail-closed한다", async () => {
    await expect(executeProductionRecordedRegressionFromAuthority({
      environment: {},
      outputDirectory: resolve(".runtime/recorded-regression-test"),
    })).rejects.toThrow(/authority source loader|기준선|연결되지/i);
  });

  it("주입 loader가 plain JSON 기준선을 반환해도 API key 확인 전에 거절한다", async () => {
    const fabricated = Object.freeze({
      schema_version: "decision-authority-record-v1",
      artifact_kind: "DECISION_BASELINE_RECORD",
      baseline_status: "ACTIVE",
    }) as unknown as DecisionBaselineRecord;

    await expect(executeProductionRecordedRegressionFromAuthority({
      environment: {},
      outputDirectory: resolve(".runtime/recorded-regression-test"),
    }, {
      loadDecisionBaselineRecord: vi.fn(async () => fabricated),
    })).rejects.toThrow(/authoritative|DECISION_BASELINE|기준선/i);
  });

  it("package script는 standalone recorded regression command를 노출한다", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve("package.json"), "utf8"),
    ) as { readonly scripts?: Record<string, string> };

    expect(packageJson.scripts?.["eval:regression"]).toBe(
      "node --import tsx eval/cli/runRecordedRegression.ts",
    );
  });
});

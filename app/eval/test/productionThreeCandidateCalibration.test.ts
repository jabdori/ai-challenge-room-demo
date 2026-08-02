// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALIBRATION_OUTPUT_DIRECTORY,
  createProductionThreeCandidateCalibrationDependencies,
} from "../cli/productionThreeCandidateCalibration";

describe("production A/B/C calibration dependencies", () => {
  it("OpenAI SDK 자동 재시도를 끄고 30초 기본 timeout을 잠근 client를 만든다", () => {
    const dependencies = createProductionThreeCandidateCalibrationDependencies();
    const client = dependencies.createClient("unit-test-key") as {
      maxRetries: number;
      timeout: number;
      responses?: unknown;
      vectorStores?: unknown;
      files?: unknown;
    };

    expect(client).toMatchObject({
      maxRetries: 0,
      timeout: 30_000,
    });
    expect(client.responses).toBeDefined();
    expect(client.vectorStores).toBeDefined();
    expect(client.files).toBeDefined();
  });

  it("production wrapper는 OpenAI client가 아닌 객체를 network 함수에 전달하지 않는다", () => {
    const dependencies = createProductionThreeCandidateCalibrationDependencies();

    expect(() => dependencies.createCandidateA({})).toThrowError(
      "production calibration에는 OpenAI client가 필요합니다.",
    );
  });

  it("기본 출력 경로는 Git 비추적 runtime evaluation-packs 디렉터리다", () => {
    expect(DEFAULT_CALIBRATION_OUTPUT_DIRECTORY).toMatch(
      /app\/.runtime\/evaluation-packs$/,
    );
  });
});

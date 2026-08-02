// @vitest-environment node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const entrypoints = [
  "runtime-for-test",
  "runtime-provider-overrides-for-test",
  "process-for-test",
  "workflow-controller-for-test",
  "recorded-workflow-gateway-for-test",
] as const;
const deniedEnvironments = [
  {
    name: "production",
    values: {
      NODE_ENV: "production",
      VITEST: undefined,
      VITEST_WORKER_ID: undefined,
    },
  },
  {
    name: "NODE_ENV 단독 spoof",
    values: {
      NODE_ENV: "test",
      VITEST: undefined,
      VITEST_WORKER_ID: undefined,
    },
  },
  {
    name: "Vitest 표식 단독 spoof",
    values: {
      NODE_ENV: "production",
      VITEST: "true",
      VITEST_WORKER_ID: "1",
    },
  },
  {
    name: "worker 표식 누락",
    values: {
      NODE_ENV: "test",
      VITEST: "true",
      VITEST_WORKER_ID: undefined,
    },
  },
] as const;

function childEnvironment(
  values: typeof deniedEnvironments[number]["values"],
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  return environment;
}

describe("public ForTest server entrypoint 운영환경 차단", () => {
  it("저장소 Vitest 실행은 세 개의 test-runner 표식을 함께 제공한다", () => {
    expect(process.env).toMatchObject({
      NODE_ENV: "test",
      VITEST: "true",
    });
    expect(process.env.VITEST_WORKER_ID).toMatch(/^(?:0|[1-9][0-9]*)$/);
  });

  for (const denied of deniedEnvironments) {
    for (const entrypoint of entrypoints) {
      it(`${denied.name}에서 ${entrypoint}를 부수효과 전에 거부한다`, async () => {
        const { stdout } = await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            new URL(
              "./fixtures/forTestServerEntrypointProbe.ts",
              import.meta.url,
            ).pathname,
            entrypoint,
          ],
          {
            cwd: new URL("../../", import.meta.url).pathname,
            env: childEnvironment(denied.values),
            timeout: 15_000,
          },
        );
        const result = JSON.parse(stdout) as {
          readonly error_code: string | null;
          readonly side_effect_observed: boolean;
        };
        expect(result).toMatchObject({
          error_code: "TEST_ONLY_SERVER_ENTRYPOINT_DENIED",
          side_effect_observed: false,
        });
      });
    }
  }
});

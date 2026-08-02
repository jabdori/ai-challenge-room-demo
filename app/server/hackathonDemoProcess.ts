import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import OpenAI from "openai";
import { requireOpenAiApiKey } from "../eval/cli/config";
import {
  createDemoAuxiliaryRiskAdapter,
  createDemoDecisionMemoAdapter,
} from "../eval/demo/demoOpenAiArtifacts";
import { buildRecordedSyntheticDemoProjection } from "../eval/demo/recordedSyntheticDemo";
import {
  loadRecordedSyntheticDemoProjectionFixture,
} from "../eval/demo/recordedSyntheticDemoProjectionFixture";
import { createHackathonDemoController } from "./hackathonDemoController";
import { createHackathonDemoApiHandler } from "./hackathonDemoServer";
import {
  startLoopbackApplicationServer,
  type ReadOnlyWorkspaceServer,
} from "./nodeWorkspaceServer";

const DEFAULT_STATIC_DIRECTORY = fileURLToPath(new URL("../dist", import.meta.url));

export const HACKATHON_DEMO_ENV = Object.freeze({
  canaryPack: "AI_HACKATHON_DEMO_CANARY_PACK",
  staticDirectory: "AI_HACKATHON_DEMO_STATIC_DIRECTORY",
  port: "AI_HACKATHON_DEMO_PORT",
});

function optionalPath(
  environment: NodeJS.ProcessEnv,
  key: string,
  fallback: string,
): string {
  const value = environment[key]?.trim();
  if (value !== undefined && (value.length === 0 || /\p{Cc}/u.test(value))) {
    throw new TypeError(`${key} 경로가 안전하지 않습니다.`);
  }
  return resolve(value ?? fallback);
}

function optionalOverridePath(
  environment: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const raw = environment[key];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.length === 0 || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${key} 경로가 안전하지 않습니다.`);
  }
  return resolve(value);
}

function portFromEnvironment(environment: NodeJS.ProcessEnv): number {
  const raw = environment[HACKATHON_DEMO_ENV.port]?.trim() ?? "4173";
  if (!/^\d{1,5}$/.test(raw)) {
    throw new TypeError("AI_HACKATHON_DEMO_PORT가 유효하지 않습니다.");
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("AI_HACKATHON_DEMO_PORT는 1~65535 범위여야 합니다.");
  }
  return port;
}

export async function startHackathonDemoFromEnvironment({
  environment = process.env,
}: {
  readonly environment?: NodeJS.ProcessEnv;
} = {}): Promise<ReadOnlyWorkspaceServer> {
  const standardKey = environment.OPENAI_API_KEY?.trim();
  const localLegacyKey = environment.openai_api_key?.trim();
  if (
    standardKey
    && localLegacyKey
    && standardKey !== localLegacyKey
  ) {
    throw new TypeError("대문자·소문자 OpenAI API 키 설정이 서로 다릅니다.");
  }
  const apiKey = requireOpenAiApiKey({
    OPENAI_API_KEY: standardKey || localLegacyKey,
  });
  const canaryPath = optionalOverridePath(
    environment,
    HACKATHON_DEMO_ENV.canaryPack,
  );
  const staticDirectory = optionalPath(
    environment,
    HACKATHON_DEMO_ENV.staticDirectory,
    DEFAULT_STATIC_DIRECTORY,
  );
  // 명시적 경로 override만 로컬 raw pack 진단에 사용합니다.
  const projection = canaryPath === undefined
    ? loadRecordedSyntheticDemoProjectionFixture()
    : buildRecordedSyntheticDemoProjection(
        JSON.parse(await readFile(canaryPath, "utf8")) as unknown,
      );
  const client = new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: 120_000,
  });
  const controller = createHackathonDemoController({
    projection,
    riskAdapter: createDemoAuxiliaryRiskAdapter(client),
    memoAdapter: createDemoDecisionMemoAdapter(client),
  });
  return startLoopbackApplicationServer({
    apiHandler: createHackathonDemoApiHandler(controller),
    staticDirectory,
    port: portFromEnvironment(environment),
  });
}

export interface HackathonDemoProcessLike {
  readonly env: NodeJS.ProcessEnv;
  exitCode?: string | number | null;
  readonly stdout: { write(value: string): unknown };
  readonly stderr: { write(value: string): unknown };
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export async function runHackathonDemoProcess({
  runtime = process,
}: {
  readonly runtime?: HackathonDemoProcessLike;
} = {}): Promise<ReadOnlyWorkspaceServer | null> {
  let server: ReadOnlyWorkspaceServer;
  try {
    server = await startHackathonDemoFromEnvironment({
      environment: runtime.env,
    });
  } catch {
    runtime.stderr.write(
      "해커톤 데모가 canary·build·OpenAI·port preflight를 통과하지 못했습니다.\n",
    );
    runtime.exitCode = 1;
    return null;
  }
  runtime.stdout.write(
    `AI Challenge Room · RECORDED SYNTHETIC DEMO · ${server.origin}/?view=demo&demoStage=define\n`,
  );
  const shutdown = () => {
    void server.close().finally(() => {
      runtime.removeListener("SIGINT", shutdown);
      runtime.removeListener("SIGTERM", shutdown);
    });
  };
  runtime.on("SIGINT", shutdown);
  runtime.on("SIGTERM", shutdown);
  return server;
}

function isDirectExecution(
  metaUrl: string,
  argvEntry: string | undefined,
): boolean {
  return argvEntry !== undefined
    && metaUrl === pathToFileURL(resolve(argvEntry)).href;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void runHackathonDemoProcess();
}

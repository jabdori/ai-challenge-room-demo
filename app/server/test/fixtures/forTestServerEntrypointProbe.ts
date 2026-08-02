import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startAuthoritativeChallengeRoomFromEnvironmentForTest,
} from "../../authoritativeChallengeRoomProcess";
import {
  startAuthoritativeChallengeRoomRuntimeForTest,
  startAuthoritativeChallengeRoomRuntimeWithProviderOverridesForTest,
} from "../../authoritativeChallengeRoomRuntime";
import {
  createAuthoritativeRecordedWorkflowGatewayForTest,
  createAuthoritativeWorkflowControllerForTest,
} from "../../authoritativeWorkflowController";

const entrypoint = process.argv[2];
const root = await mkdtemp(join(tmpdir(), "for-test-entrypoint-probe-"));
const staticDirectory = join(root, "static");
const processRoot = join(root, "process-root");
const markerPath = join(root, "side-effect-marker");
await mkdir(staticDirectory, { mode: 0o700 });
await writeFile(
  join(staticDirectory, "index.html"),
  "<!doctype html><title>probe</title>",
  { mode: 0o600 },
);

let listened = false;
const markSideEffect = () => {
  writeFileSync(markerPath, "called\n", { flag: "a", mode: 0o600 });
};

const invoke = (): unknown => {
  switch (entrypoint) {
    case "runtime-for-test":
      return startAuthoritativeChallengeRoomRuntimeForTest({
        environment: {},
        staticDirectory,
        authorityDirectory: join(root, "runtime-authority"),
        port: 0,
        dependencies: {
          createLifecycleDependencies: () => {
            markSideEffect();
            throw new Error("runtime dependency invoked");
          },
          createController: () => {
            markSideEffect();
            throw new Error("runtime controller invoked");
          },
          createMutationJournal: () => {
            markSideEffect();
            throw new Error("runtime journal invoked");
          },
          startServer: async () => {
            markSideEffect();
            throw new Error("runtime listener invoked");
          },
        },
      });
    case "runtime-provider-overrides-for-test":
      return startAuthoritativeChallengeRoomRuntimeWithProviderOverridesForTest({
        environment: {},
        staticDirectory,
        authorityDirectory: join(root, "provider-runtime-authority"),
        port: 0,
        createRecordedReviewGateway: async () => {
          markSideEffect();
          throw new Error("review gateway invoked");
        },
        providerOverridesForTest: {
          executeDefineStructureCommand: async () => {
            markSideEffect();
            throw new Error("Define provider override invoked");
          },
          executeRecordedBenchmarkCommand: async () => {
            markSideEffect();
            throw new Error("Benchmark provider override invoked");
          },
        },
      }).then(async (runtime) => {
        listened = true;
        await runtime.server.close();
      });
    case "process-for-test":
      return startAuthoritativeChallengeRoomFromEnvironmentForTest({
        environment: {
          AI_AUTHORITATIVE_CHALLENGE_ROOM_ROOT: processRoot,
          AI_AUTHORITATIVE_WORKSPACE_STATIC_DIR: staticDirectory,
          AI_AUTHORITATIVE_WORKSPACE_PORT: "0",
        },
      }).then(async (runtime) => {
        listened = true;
        await runtime.server.close();
      });
    case "workflow-controller-for-test":
      return createAuthoritativeWorkflowControllerForTest(new Proxy(
        {},
        {
          get() {
            markSideEffect();
            throw new Error("workflow option accessed");
          },
        },
      ) as never);
    case "recorded-workflow-gateway-for-test":
      return createAuthoritativeRecordedWorkflowGatewayForTest({
        initialSnapshot: null,
        authorityOutputDirectory: root,
        projectionOutputDirectory: root,
        initialSources: null,
        finalDecisionMemoAdapter: null,
        recordedRegressionRunner: null,
        loadPersistedRecordedRegression: null,
      } as never);
    default:
      throw new Error(`알 수 없는 probe entrypoint입니다: ${entrypoint}`);
  }
};

let errorCode: string | null = null;
let errorMessage: string | null = null;
try {
  await Promise.resolve(invoke());
} catch (error) {
  errorCode = error instanceof Error && "code" in error
    ? String(error.code)
    : null;
  errorMessage = error instanceof Error ? error.message : String(error);
}

const result = {
  entrypoint,
  error_code: errorCode,
  error_message: errorMessage,
  side_effect_observed:
    existsSync(markerPath) || existsSync(processRoot) || listened,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
rmSync(root, { recursive: true, force: true });

import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import OpenAI from "openai";
import { redactSensitiveText } from "./calibrationOutcome";
import {
  buildDefineStructuringArtifact,
  loadDefineStructuringArtifact,
  persistDefineStructuringArtifact,
  assertPersistedDefineStructuringArtifact,
  type DefineStructuringArtifact,
  type PersistDefineStructuringArtifactResult,
} from "../define/defineStructuringPersistence";
import {
  createOpenAIDefineAdapter,
  OPENAI_DEFINE_MODEL_REQUESTED_ID,
  OPENAI_DEFINE_REQUEST_CONTRACT,
  type DefineAdapter,
} from "../define/openaiDefineAdapter";
import {
  runDefineStructuring,
  type DefineStructuringRunRecord,
  type RunDefineStructuringOptions,
} from "../define/runDefineStructuring";
import {
  SYNTHETIC_CHALLENGE_TEMPLATE,
} from "../define/syntheticChallengeDefinition";

export const DEFAULT_DEFINE_STRUCTURING_OUTPUT_DIRECTORY = resolve(
  import.meta.dirname,
  "../../.runtime/define-structuring",
);

export interface DefineStructureCommandDependencies {
  readonly prepareOutputDirectory?: (outputDirectory: string) => Promise<void>;
  readonly createClient: (apiKey: string) => unknown;
  readonly createAdapter: (client: unknown) => DefineAdapter;
  readonly runStructuring: (
    options: RunDefineStructuringOptions,
  ) => Promise<DefineStructuringRunRecord>;
  readonly persistArtifact: typeof persistDefineStructuringArtifact;
  readonly loadPersistedArtifact: typeof loadDefineStructuringArtifact;
}

async function prepareOutputDirectory(outputDirectory: string): Promise<void> {
  const root = resolve(outputDirectory);
  const parent = dirname(root);
  const assertCanonical0700 = async (path: string, label: string) => {
    const [stat, canonical] = await Promise.all([lstat(path), realpath(path)]);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || canonical !== path) {
      throw new TypeError(`${label}는 symlink 없는 canonical 0700 directory여야 합니다.`);
    }
  };
  // parent는 생성하지 않습니다. 검증 전에 symlink 조상 밖으로 쓰는 경로를 차단합니다.
  await assertCanonical0700(parent, "Define structuring output parent");
  try {
    await mkdir(root, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  await assertCanonical0700(root, "Define structuring output root");
  const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export interface DefineStructureSummary {
  readonly command_status:
    | "DEFINE_SUGGESTION_READY"
    | "DEFINE_SUGGESTION_INCOMPLETE"
    | "DEFINE_STRUCTURING_FAILED";
  readonly artifact_kind: "DEFINE_STRUCTURING_ARTIFACT" | null;
  readonly synthetic: true;
  readonly authority: "ADVISORY_ONLY";
  readonly human_approval_required: true;
  readonly challenge_locked: false;
  readonly model_requested: typeof OPENAI_DEFINE_MODEL_REQUESTED_ID;
  readonly reasoning_effort: "medium";
  readonly store: false;
  readonly sdk_max_retries: 0;
  readonly runner_max_attempts: 2;
  readonly attempt_count: number;
  readonly structuring_status:
    | "SUGGESTION_COMPLETE"
    | "SUGGESTION_INCOMPLETE"
    | "NOT_STARTED";
  readonly cost_state: "COMPLETE" | "COST_INCOMPLETE" | "NOT_AVAILABLE";
  readonly total_cost_usd: number | null;
  readonly total_latency_ms: number | null;
  readonly artifact_hash: string | null;
  readonly artifact_path: string | null;
  readonly created: boolean | null;
  readonly error?: string;
}

export interface DefineStructureOutcome {
  readonly exitCode: 0 | 1 | 2;
  readonly summary: DefineStructureSummary;
  /** process 출력에는 포함하지 않는 실행 중간 객체입니다. */
  readonly builtArtifact: DefineStructuringArtifact | null;
  /** 완료된 suggestion의 write-once source-reload 객체만 다음 단계에 전달합니다. */
  readonly serverAuthority: {
    readonly defineStructuringArtifact: DefineStructuringArtifact;
  } | null;
}

export interface ExecuteDefineStructureCommandOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly outputDirectory: string;
  readonly dependencies?: DefineStructureCommandDependencies;
  readonly signal?: AbortSignal;
}

function requireOpenAIClient(value: unknown): OpenAI {
  if (!(value instanceof OpenAI)) {
    throw new TypeError("production Define structuring에는 OpenAI client가 필요합니다.");
  }
  return value;
}

function requireDefineOpenAiApiKey(environment: NodeJS.ProcessEnv): string {
  const key = environment.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY가 없습니다. 라이브 Define structuring을 실행하려면 현재 셸에만 키를 설정해 주세요.",
    );
  }
  return key;
}

export const PRODUCTION_DEFINE_STRUCTURE_DEPENDENCIES:
DefineStructureCommandDependencies = {
  prepareOutputDirectory,
  createClient: (apiKey) => new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: 60_000,
  }),
  createAdapter: (client) => createOpenAIDefineAdapter(
    requireOpenAIClient(client),
  ),
  runStructuring: runDefineStructuring,
  persistArtifact: persistDefineStructuringArtifact,
  loadPersistedArtifact: loadDefineStructuringArtifact,
};

function failedOutcome(
  error: unknown,
  sensitiveValues: readonly string[] = [],
): DefineStructureOutcome {
  const message = redactSensitiveText(
    error instanceof Error ? error.message : String(error),
    sensitiveValues,
  );
  return Object.freeze({
    exitCode: 1,
    summary: Object.freeze({
      command_status: "DEFINE_STRUCTURING_FAILED",
      artifact_kind: null,
      synthetic: true,
      authority: "ADVISORY_ONLY",
      human_approval_required: true,
      challenge_locked: false,
      model_requested: OPENAI_DEFINE_MODEL_REQUESTED_ID,
      reasoning_effort: OPENAI_DEFINE_REQUEST_CONTRACT.reasoningEffort,
      store: OPENAI_DEFINE_REQUEST_CONTRACT.store,
      sdk_max_retries: OPENAI_DEFINE_REQUEST_CONTRACT.sdkMaxRetries,
      runner_max_attempts:
        OPENAI_DEFINE_REQUEST_CONTRACT.runnerRetryPolicy.maxAttempts,
      attempt_count: 0,
      structuring_status: "NOT_STARTED",
      cost_state: "NOT_AVAILABLE",
      total_cost_usd: null,
      total_latency_ms: null,
      artifact_hash: null,
      artifact_path: null,
      created: null,
      error: message,
    }),
    builtArtifact: null,
    serverAuthority: null,
  });
}

function buildSuccessfulOutcome({
  artifact,
  reloaded,
  persisted,
}: {
  readonly artifact: DefineStructuringArtifact;
  readonly reloaded: DefineStructuringArtifact;
  readonly persisted: PersistDefineStructuringArtifactResult;
}): DefineStructureOutcome {
  const complete =
    reloaded.run_record.structuringStatus === "SUGGESTION_COMPLETE";
  if (complete) {
    assertPersistedDefineStructuringArtifact(reloaded);
  }
  return Object.freeze({
    exitCode: complete ? 0 : 2,
    summary: Object.freeze({
      command_status: complete
        ? "DEFINE_SUGGESTION_READY"
        : "DEFINE_SUGGESTION_INCOMPLETE",
      artifact_kind: "DEFINE_STRUCTURING_ARTIFACT",
      synthetic: true,
      authority: "ADVISORY_ONLY",
      human_approval_required: true,
      challenge_locked: false,
      model_requested: OPENAI_DEFINE_MODEL_REQUESTED_ID,
      reasoning_effort: OPENAI_DEFINE_REQUEST_CONTRACT.reasoningEffort,
      store: OPENAI_DEFINE_REQUEST_CONTRACT.store,
      sdk_max_retries: OPENAI_DEFINE_REQUEST_CONTRACT.sdkMaxRetries,
      runner_max_attempts:
        OPENAI_DEFINE_REQUEST_CONTRACT.runnerRetryPolicy.maxAttempts,
      attempt_count: reloaded.run_record.attempts.length,
      structuring_status: reloaded.run_record.structuringStatus,
      cost_state: reloaded.run_record.costState,
      total_cost_usd:
        reloaded.run_record.usageCost?.totalCostUsd ?? null,
      total_latency_ms: reloaded.run_record.totalLatencyMs,
      artifact_hash: reloaded.artifact_hash,
      artifact_path: persisted.path,
      created: persisted.created,
    }),
    builtArtifact: artifact,
    serverAuthority: complete
      ? Object.freeze({ defineStructuringArtifact: reloaded })
      : null,
  });
}

export async function executeDefineStructureCommand({
  environment,
  outputDirectory,
  dependencies = PRODUCTION_DEFINE_STRUCTURE_DEPENDENCIES,
  signal,
}: ExecuteDefineStructureCommandOptions): Promise<DefineStructureOutcome> {
  let apiKey: string;
  try {
    // 키가 없을 때 OpenAI client뿐 아니라 artifact namespace도 만들지 않습니다.
    apiKey = requireDefineOpenAiApiKey(environment);
  } catch (error) {
    return failedOutcome(error);
  }
  try {
    await (dependencies.prepareOutputDirectory ?? prepareOutputDirectory)(
      resolve(outputDirectory),
    );
    const client = dependencies.createClient(apiKey);
    const adapter = dependencies.createAdapter(client);
    const input =
      SYNTHETIC_CHALLENGE_TEMPLATE.defineInput;
    const run = await dependencies.runStructuring({
      adapter,
      input,
      ...(signal ? { signal } : {}),
    });
    const artifact = buildDefineStructuringArtifact({ input, run });
    const persisted = await dependencies.persistArtifact({
      outputDirectory: resolve(outputDirectory),
      artifact,
    });
    const reloaded = await dependencies.loadPersistedArtifact({
      outputDirectory: resolve(outputDirectory),
      artifactPath: persisted.path,
      expectedInput: input,
    });
    if (reloaded.artifact_hash !== persisted.artifactHash) {
      throw new TypeError(
        "Define structuring 저장 결과와 source-reload hash가 다릅니다.",
      );
    }
    return buildSuccessfulOutcome({
      artifact,
      reloaded,
      persisted,
    });
  } catch (error) {
    return failedOutcome(error, [apiKey]);
  }
}

export interface DefineStructureProcessLike {
  readonly env: NodeJS.ProcessEnv;
  exitCode?: string | number | null;
  readonly stdout: { write(value: string): unknown };
  readonly stderr: { write(value: string): unknown };
}

interface RunDefineStructureProcessOptions {
  readonly runtime?: DefineStructureProcessLike;
  readonly executeCommand?: (
    options: Omit<ExecuteDefineStructureCommandOptions, "dependencies">,
  ) => Promise<DefineStructureOutcome>;
}

function outputDirectoryFromEnvironment(
  environment: NodeJS.ProcessEnv,
): string {
  const configured = environment.AI_DEFINE_STRUCTURING_OUTPUT_DIR?.trim();
  return configured
    ? resolve(configured)
    : DEFAULT_DEFINE_STRUCTURING_OUTPUT_DIRECTORY;
}

export async function runDefineStructureProcess({
  runtime = process,
  executeCommand = executeDefineStructureCommand,
}: RunDefineStructureProcessOptions = {}): Promise<DefineStructureOutcome | null> {
  try {
    const outcome = await executeCommand({
      environment: runtime.env,
      outputDirectory: outputDirectoryFromEnvironment(runtime.env),
    });
    runtime.stdout.write(`${JSON.stringify(outcome.summary, null, 2)}\n`);
    if (outcome.exitCode === 0) {
      runtime.stdout.write(
        "DEFINE_SUGGESTION_READY · ADVISORY_ONLY"
        + " — 별도의 명시적 사람 승인 없이는 Challenge가 잠기지 않습니다.\n",
      );
    }
    runtime.exitCode = outcome.exitCode;
    return outcome;
  } catch {
    // provider 오류나 환경 값 원문이 process 출력으로 새지 않게 합니다.
    runtime.stderr.write(
      "Define structuring command가 예상 밖 오류로 종료됐습니다.\n",
    );
    runtime.exitCode = 1;
    return null;
  }
}

function isDirectExecution(
  metaUrl: string,
  argvEntry: string | undefined,
): boolean {
  return argvEntry !== undefined
    && metaUrl === pathToFileURL(resolve(argvEntry)).href;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void runDefineStructureProcess();
}

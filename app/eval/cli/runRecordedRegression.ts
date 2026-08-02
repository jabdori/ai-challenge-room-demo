import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import OpenAI from "openai";
import {
  buildScopedPolicyResourceLeaseContract,
  createBenchmarkResourceLeaseController,
  type BenchmarkResourceLeaseController,
  type BenchmarkResourceLeaseRemoteClient,
  type BenchmarkResourceLeaseTerminalAuthority,
} from "../benchmark/resourceLease";
import {
  assertAuthoritativeDecisionBaselineRecord,
  type DecisionBaselineRecord,
} from "../decision/decisionBaseline";
import {
  BENCHMARK_CASES,
  BENCHMARK_CHALLENGE,
  BENCHMARK_POLICIES,
  REGRESSION_CANARIES,
  REGRESSION_CANARY_ORACLES,
} from "../data/benchmark";
import {
  buildRegressionSchedule,
  buildRegressionResourceAuthorityBinding,
  buildValidatedRegressionResourceCleanupEvidence,
  createRegressionCandidateExecutor,
  createRegressionRuntimeAdapterFactory,
  regressionPolicyCorpusForVersion,
  runRecordedRegression,
  type RegressionRuntimeClientLike,
  type RegressionSufficiencyContract,
  type RunRecordedRegressionResult,
} from "../regression/runRegression";
import { throwIfAborted } from "../runner/types";
import { requireOpenAiApiKey } from "./config";

type RecordedRegressionSignal = "SIGINT" | "SIGTERM";

export const RECORDED_REGRESSION_ACKNOWLEDGEMENT_ENV
  = "AI_RECORDED_REGRESSION_ACKNOWLEDGEMENT";

export const RECORDED_REGRESSION_ACKNOWLEDGEMENT
  = "RUN_SYNTHETIC_RECORDED_REGRESSION_36";

export const DEFAULT_RECORDED_REGRESSION_OUTPUT_DIRECTORY = resolve(
  import.meta.dirname,
  "../../.runtime/recorded-regression",
);

export const DEFAULT_RECORDED_REGRESSION_SUFFICIENCY:
RegressionSufficiencyContract = Object.freeze({
  hidden_policy_minimum_correct: 11,
  hidden_citation_required_cases: 11,
  hidden_escalation_required_cases: 4,
  mean_runtime_cost_usd_maximum: 0.2,
  median_latency_ms_maximum: 10_000,
  worst_latency_ms_maximum: 30_000,
});

export class RecordedRegressionInterruptionError extends Error {
  readonly signalName: RecordedRegressionSignal;

  constructor(signalName: RecordedRegressionSignal) {
    super(`${signalName}으로 기록 회귀 실행이 중단됐습니다.`);
    this.name = "RecordedRegressionInterruptionError";
    this.signalName = signalName;
  }
}

export interface ExecuteProductionRecordedRegressionOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly outputDirectory: string;
  readonly decisionBaselineRecord: DecisionBaselineRecord;
  readonly sufficiency?: RegressionSufficiencyContract;
  readonly signal?: AbortSignal;
}

interface ActiveRegressionResourceLease {
  readonly version: "BASELINE_V1" | "PROPOSED_V2";
  readonly controller: BenchmarkResourceLeaseController;
  acquireStarted: boolean;
}

function assertLockedSyntheticRegressionData(): void {
  if (
    BENCHMARK_CHALLENGE.synthetic !== true
    || BENCHMARK_CHALLENGE.dataset_split !== "HIDDEN_BENCHMARK"
    || BENCHMARK_CASES.length !== 12
    || BENCHMARK_POLICIES.length !== 32
    || REGRESSION_CANARIES.length !== 6
    || REGRESSION_CANARY_ORACLES.length !== 6
  ) {
    throw new TypeError(
      "production 기록 회귀는 잠긴 합성 12개 hidden 사례와 6개 canary만 허용합니다.",
    );
  }
  const canaryIds = new Set(REGRESSION_CANARIES.map((item) => item.case_id));
  if (
    canaryIds.size !== 6
    || REGRESSION_CANARY_ORACLES.some(
      (oracle) => !canaryIds.has(oracle.case_id),
    )
  ) {
    throw new TypeError("기록 회귀 canary와 evaluator oracle 계약이 다릅니다.");
  }
}

async function prepareSecureOutputDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    await mkdir(absolute, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (
      !(error instanceof Error)
      || !("code" in error)
      || error.code !== "EEXIST"
    ) {
      throw error;
    }
  }
  const stats = await lstat(absolute);
  const canonical = await realpath(absolute);
  if (
    canonical !== absolute
    || !stats.isDirectory()
    || stats.isSymbolicLink()
    || (stats.mode & 0o777) !== 0o700
  ) {
    throw new TypeError(
      "기록 회귀 output root는 symlink가 아닌 canonical 0700 디렉터리여야 합니다.",
    );
  }
  return canonical;
}

function resourceLeaseFor({
  decisionBaselineRecord,
  outputDirectory,
  version,
}: {
  readonly decisionBaselineRecord: DecisionBaselineRecord;
  readonly outputDirectory: string;
  readonly version: "BASELINE_V1" | "PROPOSED_V2";
}): ActiveRegressionResourceLease {
  const candidateId = decisionBaselineRecord.selected_candidate_id;
  const authorityBinding = buildRegressionResourceAuthorityBinding(
    decisionBaselineRecord,
  );
  const policies = regressionPolicyCorpusForVersion(version);
  const versionLabel = version === "BASELINE_V1" ? "baseline-v1" : "proposed-v2";
  const contract = buildScopedPolicyResourceLeaseContract({
    authorityPackSha256:
      authorityBinding.decision_baseline_record_hash,
    authorityContractSha256:
      authorityBinding.resource_authority_contract_hash,
    scheduleId: buildRegressionSchedule(candidateId).schedule_id,
    policies,
    outputDirectory,
    vectorStoreName:
      `ai-challenge-regression-${candidateId.toLowerCase()}-${versionLabel}`,
    filenamePrefix:
      `regression-${candidateId.toLowerCase()}-${versionLabel}-policy`,
  });
  return {
    version,
    controller: createBenchmarkResourceLeaseController({
      rootDirectory: outputDirectory,
      contract,
      policies,
    }),
    acquireStarted: false,
  };
}

async function cleanupLease({
  lease,
  client,
}: {
  readonly lease: ActiveRegressionResourceLease;
  readonly client: BenchmarkResourceLeaseRemoteClient;
}): Promise<BenchmarkResourceLeaseTerminalAuthority> {
  if (lease.controller.mode() !== "TERMINAL_LOCAL_RECOVERY") {
    const cleanup = await lease.controller.cleanup({ client });
    await lease.controller.finalizeCleanup(cleanup);
  }
  return lease.controller.terminalAuthority();
}

async function cleanupStartedLeases({
  leases,
  client,
}: {
  readonly leases: readonly ActiveRegressionResourceLease[];
  readonly client: BenchmarkResourceLeaseRemoteClient;
}): Promise<readonly unknown[]> {
  const errors: unknown[] = [];
  for (const lease of leases) {
    if (!lease.acquireStarted) continue;
    try {
      await cleanupLease({ lease, client });
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function combinedFailure(
  primary: unknown,
  cleanupErrors: readonly unknown[],
): unknown {
  if (cleanupErrors.length === 0) return primary;
  const failures = [
    ...(primary === null ? [] : [primary]),
    ...cleanupErrors,
  ];
  return new AggregateError(
    failures,
    "기록 회귀 실행 또는 원격 정책 자원 정리가 완료되지 않았습니다.",
  );
}

/**
 * 이미 source-rebuild되어 brand된 사람 확정 기준선만 받는 production 경계입니다.
 * 이 함수는 JSON payload를 기준선 권위로 승격하지 않습니다.
 */
export async function executeProductionRecordedRegression({
  environment,
  outputDirectory,
  decisionBaselineRecord,
  sufficiency = DEFAULT_RECORDED_REGRESSION_SUFFICIENCY,
  signal,
}: ExecuteProductionRecordedRegressionOptions): Promise<
  RunRecordedRegressionResult
> {
  // API key·OpenAI client·원격 자원보다 먼저 실제 결정 권위를 확인합니다.
  assertAuthoritativeDecisionBaselineRecord(decisionBaselineRecord);
  assertLockedSyntheticRegressionData();
  throwIfAborted(signal);
  const canonicalOutputDirectory = await prepareSecureOutputDirectory(
    outputDirectory,
  );
  const apiKey = requireOpenAiApiKey(environment);
  const client = new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: 30_000,
  });
  const runtimeClient = client as unknown as RegressionRuntimeClientLike;
  const resourceClient =
    client as unknown as BenchmarkResourceLeaseRemoteClient;
  const selectedCandidateId = decisionBaselineRecord.selected_candidate_id;
  const authorityBinding = buildRegressionResourceAuthorityBinding(
    decisionBaselineRecord,
  );
  const leases: ActiveRegressionResourceLease[] = selectedCandidateId === "A"
    ? []
    : [
      resourceLeaseFor({
        decisionBaselineRecord,
        outputDirectory: canonicalOutputDirectory,
        version: "BASELINE_V1",
      }),
      resourceLeaseFor({
        decisionBaselineRecord,
        outputDirectory: canonicalOutputDirectory,
        version: "PROPOSED_V2",
      }),
    ];

  let result: RunRecordedRegressionResult | null = null;
  let primaryFailure: unknown = null;
  try {
    const preparedPolicyResources = selectedCandidateId === "A"
      ? null
      : {
        baseline: await (async () => {
          const lease = leases[0]!;
          lease.acquireStarted = true;
          return lease.controller.acquire({
            client: resourceClient,
            ...(signal ? { signal } : {}),
          });
        })(),
        proposed: await (async () => {
          const lease = leases[1]!;
          lease.acquireStarted = true;
          return lease.controller.acquire({
            client: resourceClient,
            ...(signal ? { signal } : {}),
          });
        })(),
      };
    throwIfAborted(signal);
    const adapterFor = createRegressionRuntimeAdapterFactory({
      client: runtimeClient,
      preparedPolicyResources,
    });
    result = await runRecordedRegression({
      outputDirectory: canonicalOutputDirectory,
      decisionBaselineRecord,
      sufficiency,
      dependencies: {
        assertBaselineRecord: assertAuthoritativeDecisionBaselineRecord,
        executeCandidate: createRegressionCandidateExecutor({
          adapterFor,
          ...(signal ? { signal } : {}),
        }),
        resourceEvidence: async () => {
          if (selectedCandidateId === "A") {
            return buildValidatedRegressionResourceCleanupEvidence({
              selectedCandidateId,
              baseline: null,
              proposed: null,
              authorityBinding,
            });
          }
          const baseline = await cleanupLease({
            lease: leases[0]!,
            client: resourceClient,
          });
          const proposed = await cleanupLease({
            lease: leases[1]!,
            client: resourceClient,
          });
          return buildValidatedRegressionResourceCleanupEvidence({
            selectedCandidateId,
            baseline,
            proposed,
            authorityBinding,
          });
        },
      },
    });
  } catch (error) {
    primaryFailure = error;
  }

  // 성공·실패·중단 모두에서 생성이 시작된 두 버전 자원을 독립적으로 정리합니다.
  const cleanupErrors = await cleanupStartedLeases({
    leases,
    client: resourceClient,
  });
  if (primaryFailure !== null || cleanupErrors.length > 0) {
    throw combinedFailure(primaryFailure, cleanupErrors);
  }
  if (result === null) {
    throw new TypeError("기록 회귀 결과가 생성되지 않았습니다.");
  }
  return result;
}

export interface RecordedRegressionAuthorityBoundary {
  readonly loadDecisionBaselineRecord: (
    environment: NodeJS.ProcessEnv,
  ) => Promise<DecisionBaselineRecord>;
}

const DEFAULT_AUTHORITY_BOUNDARY: RecordedRegressionAuthorityBoundary = {
  async loadDecisionBaselineRecord() {
    throw new TypeError(
      "standalone 기록 회귀용 end-to-end Decision authority source loader가 아직 연결되지 않았습니다. 검증되지 않은 JSON은 기준선으로 사용할 수 없습니다.",
    );
  },
};

export async function executeProductionRecordedRegressionFromAuthority({
  environment,
  outputDirectory,
  signal,
}: Omit<
  ExecuteProductionRecordedRegressionOptions,
  "decisionBaselineRecord"
>, authorityBoundary: RecordedRegressionAuthorityBoundary
  = DEFAULT_AUTHORITY_BOUNDARY): Promise<RunRecordedRegressionResult> {
  const decisionBaselineRecord =
    await authorityBoundary.loadDecisionBaselineRecord(environment);
  // 주입된 loader가 plain payload를 반환해도 원격 호출 전에 직접 차단합니다.
  assertAuthoritativeDecisionBaselineRecord(decisionBaselineRecord);
  return executeProductionRecordedRegression({
    environment,
    outputDirectory,
    decisionBaselineRecord,
    ...(signal ? { signal } : {}),
  });
}

export interface RecordedRegressionProcessLike {
  readonly env: NodeJS.ProcessEnv;
  exitCode?: string | number | null;
  readonly stdin: { readonly isTTY?: boolean };
  readonly stdout: {
    readonly isTTY?: boolean;
    write(value: string): unknown;
  };
  readonly stderr: { write(value: string): unknown };
  on(event: RecordedRegressionSignal, listener: () => void): unknown;
  removeListener(
    event: RecordedRegressionSignal,
    listener: () => void,
  ): unknown;
}

interface RunRecordedRegressionProcessOptions {
  readonly runtime?: RecordedRegressionProcessLike;
  readonly executeCommand?: typeof executeProductionRecordedRegressionFromAuthority;
}

function acknowledgementGuardMessage(): string {
  return [
    "기록 회귀는 대화형 TTY에서만 실행할 수 있습니다. ",
    `${RECORDED_REGRESSION_ACKNOWLEDGEMENT_ENV}=`,
    RECORDED_REGRESSION_ACKNOWLEDGEMENT,
    "를 정확히 설정해 합성 데이터 36회 실행을 확인해 주세요.",
  ].join("");
}

function resolveOutputDirectory(environment: NodeJS.ProcessEnv): string {
  const configured = environment.AI_RECORDED_REGRESSION_OUTPUT_DIR?.trim();
  return configured
    ? resolve(configured)
    : DEFAULT_RECORDED_REGRESSION_OUTPUT_DIRECTORY;
}

export async function runRecordedRegressionProcess({
  runtime = process,
  executeCommand = executeProductionRecordedRegressionFromAuthority,
}: RunRecordedRegressionProcessOptions = {}): Promise<
  RunRecordedRegressionResult | null
> {
  if (
    runtime.stdin.isTTY !== true
    || runtime.stdout.isTTY !== true
    || runtime.env[RECORDED_REGRESSION_ACKNOWLEDGEMENT_ENV]
      !== RECORDED_REGRESSION_ACKNOWLEDGEMENT
  ) {
    runtime.stderr.write(`${acknowledgementGuardMessage()}\n`);
    runtime.exitCode = 1;
    return null;
  }
  const controller = new AbortController();
  const interrupt = (signalName: RecordedRegressionSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(new RecordedRegressionInterruptionError(signalName));
    }
  };
  const handleSigint = () => interrupt("SIGINT");
  const handleSigterm = () => interrupt("SIGTERM");
  runtime.on("SIGINT", handleSigint);
  runtime.on("SIGTERM", handleSigterm);
  try {
    const result = await executeCommand({
      environment: runtime.env,
      outputDirectory: resolveOutputDirectory(runtime.env),
      signal: controller.signal,
    });
    runtime.stdout.write(`${JSON.stringify({
      command_status: "RECORDED_REGRESSION_COMPLETE",
      artifact_kind: result.pack.artifact_kind,
      verdict: result.pack.verdict,
      evaluation_status: result.pack.evaluation_status,
      baseline_status_after: result.pack.baseline_status_after,
      recorded_runs: result.pack.coverage.recorded_runs,
      executed_slots: result.executedSlots,
      reused_slots: result.reusedSlots,
      pack_path: result.path,
      payload_sha256: result.payloadSha256,
    }, null, 2)}\n`);
    runtime.exitCode = 0;
    return result;
  } catch {
    // 원문 오류에는 API key나 원격 resource ID가 포함될 수 있습니다.
    runtime.stderr.write(
      "기록 회귀 command가 preflight·실행·자원 정리 중 완료되지 않았습니다.\n",
    );
    const interruption = controller.signal.reason;
    runtime.exitCode = interruption instanceof RecordedRegressionInterruptionError
      ? interruption.signalName === "SIGINT" ? 130 : 143
      : 1;
    return null;
  } finally {
    runtime.removeListener("SIGINT", handleSigint);
    runtime.removeListener("SIGTERM", handleSigterm);
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
  void runRecordedRegressionProcess();
}

import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_RECORDED_BENCHMARK_OUTPUT_DIRECTORY,
  executeProductionRecordedBenchmark,
  RECORDED_BENCHMARK_ACKNOWLEDGEMENT,
  RECORDED_BENCHMARK_ACKNOWLEDGEMENT_ENV,
  RECORDED_BENCHMARK_AUTHORITY_ENV,
  type RecordedBenchmarkOutcome,
} from "../eval/cli/runRecordedBenchmark";
import {
  DEFAULT_RECORDED_REGRESSION_OUTPUT_DIRECTORY,
  executeProductionRecordedRegression,
} from "../eval/cli/runRecordedRegression";
import { requireOpenAiApiKey } from "../eval/cli/config";
import {
  buildProvisionalDecisionMemo,
  loadProvisionalDecisionMemo,
  persistProvisionalDecisionMemo,
  assertPersistedProvisionalDecisionMemo,
  type ProvisionalDecisionMemo,
} from "../eval/decision/provisionalMemo";
import {
  createOpenAIFinalDecisionMemoAdapter,
  type OfficialOpenAIFinalDecisionMemoAdapter,
} from "../eval/decision/openaiFinalDecisionMemoAdapter";
import type { LockedChallengePack } from "../eval/define/defineContracts";
import {
  loadLockedChallengeAuthorityRecord,
} from "../eval/define/lockedChallengePersistence";
import {
  assertPersistedRecordedBenchmarkPack,
  type RecordedBenchmarkPack,
} from "../eval/pack/recordedBenchmarkPack";
import {
  assertPersistedRecordedRegressionPack,
  type RecordedRegressionPack,
} from "../eval/regression/regressionPack";
import type { BlindReviewQueueItem } from "../eval/review/buildReviewQueue";
import {
  assertPersistedAiPreReviewReceipt,
  buildAiPreReviewReceipt,
  loadAiPreReviewReceipt,
  persistAiPreReviewReceipt,
  type AiPreReviewCommand,
  type AiPreReviewReceipt,
} from "../eval/review/preReviewReceipt";
import { sha256CanonicalJson } from "../eval/runtime/canonicalJson";
import {
  createAuthoritativeRecordedWorkflowGateway,
  type AuthoritativeRecordedWorkflowGatewayOptions,
  type PersistedRecordedRegressionLoader,
  type RecordedRegressionRunner,
} from "./authoritativeWorkflowController";
import { FileMutationJournal } from "./artifactRepository";
import type { ChallengeApiGateway } from "./challengeServer";
import {
  startAuthoritativeWorkspaceServer,
  type ReadOnlyWorkspaceServer,
} from "./nodeWorkspaceServer";
import {
  loadReadOnlyProjectionSnapshotRecord,
  type ProjectionSnapshot,
} from "./projectionRepository";
import {
  persistRecordedReviewProjectionSnapshot,
  type RecordedReviewSnapshotSources,
} from "./recordedWorkflowSnapshot";

const SHA256 = /^[a-f0-9]{64}$/;
const AI_PRE_REVIEW_DIRECTORY = /^apr_[a-f0-9]{64}$/;
const AI_PRE_REVIEW_RECORD =
  /^ai-pre-review--record-[a-f0-9]{64}\.json$/;
const PROVISIONAL_MEMO_DIRECTORY = /^pdm_[a-f0-9]{64}$/;
const PROVISIONAL_MEMO_RECORD =
  /^provisional-decision-memo--record-[a-f0-9]{64}\.json$/;

export const AUTHORITATIVE_WORKSPACE_RUNTIME_ENV = Object.freeze({
  rootDirectory: "AI_AUTHORITATIVE_WORKSPACE_RUNTIME_ROOT",
  benchmarkOutputDirectory:
    "AI_AUTHORITATIVE_WORKSPACE_BENCHMARK_OUTPUT_DIRECTORY",
  regressionOutputDirectory:
    "AI_AUTHORITATIVE_WORKSPACE_REGRESSION_OUTPUT_DIRECTORY",
  staticDirectory: "AI_AUTHORITATIVE_WORKSPACE_STATIC_DIRECTORY",
  port: "AI_AUTHORITATIVE_WORKSPACE_PORT",
});

export const DEFAULT_AUTHORITATIVE_WORKSPACE_RUNTIME_ROOT = resolve(
  import.meta.dirname,
  "../.runtime/authoritative-workspace",
);

export class AuthoritativeWorkspaceRuntimeIntegrityError extends Error {
  readonly code = "AUTHORITATIVE_WORKSPACE_RUNTIME_INTEGRITY" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthoritativeWorkspaceRuntimeIntegrityError";
  }
}

function integrity(
  message: string,
  cause?: unknown,
): AuthoritativeWorkspaceRuntimeIntegrityError {
  return new AuthoritativeWorkspaceRuntimeIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function requiredText(
  environment: NodeJS.ProcessEnv,
  key: string,
): string {
  const value = environment[key]?.trim();
  if (!value || /\p{Cc}/u.test(value)) {
    throw integrity(`${key}가 필요합니다.`);
  }
  return value;
}

function optionalPath(
  environment: NodeJS.ProcessEnv,
  key: string,
  fallback: string,
): string {
  const value = environment[key]?.trim();
  if (value !== undefined && (value.length === 0 || /\p{Cc}/u.test(value))) {
    throw integrity(`${key} 경로가 안전하지 않습니다.`);
  }
  return resolve(value ?? fallback);
}

function portFromEnvironment(environment: NodeJS.ProcessEnv): number {
  const raw = environment[AUTHORITATIVE_WORKSPACE_RUNTIME_ENV.port]?.trim()
    ?? "4173";
  if (!/^\d{1,5}$/.test(raw)) {
    throw integrity(
      `${AUTHORITATIVE_WORKSPACE_RUNTIME_ENV.port}가 유효하지 않습니다.`,
    );
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw integrity("권위 workspace port가 0~65535 범위가 아닙니다.");
  }
  return port;
}

async function syncParentDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    await handle.sync();
  } catch (error) {
    throw integrity("runtime parent directory를 fsync할 수 없습니다.", error);
  } finally {
    await handle?.close();
  }
}

async function prepareSecureRuntimeDirectory(
  path: string,
  parentDirectory?: string,
): Promise<string> {
  const absolute = resolve(path);
  let created = false;
  try {
    await mkdir(absolute, { recursive: false, mode: 0o700 });
    created = true;
  } catch (error) {
    if (
      !(error instanceof Error)
      || !("code" in error)
      || error.code !== "EEXIST"
    ) {
      throw integrity("runtime 디렉터리를 exclusive create할 수 없습니다.", error);
    }
  }
  const stat = await lstat(absolute);
  const canonical = await realpath(absolute);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== 0o700
    || canonical !== absolute
  ) {
    throw integrity(
      "runtime 디렉터리는 symlink가 아닌 canonical 0700 디렉터리여야 합니다.",
    );
  }
  if (created && parentDirectory !== undefined) {
    await syncParentDirectory(parentDirectory);
  }
  return canonical;
}

export interface AuthoritativeWorkspaceRuntimePaths {
  readonly rootDirectory: string;
  readonly authorityOutputDirectory: string;
  readonly projectionOutputDirectory: string;
  readonly mutationJournalDirectory: string;
  readonly benchmarkOutputDirectory: string;
  readonly regressionOutputDirectory: string;
  readonly staticDirectory: string;
  readonly port: number;
}

async function runtimePaths(
  environment: NodeJS.ProcessEnv,
): Promise<AuthoritativeWorkspaceRuntimePaths> {
  const requestedRoot = optionalPath(
    environment,
    AUTHORITATIVE_WORKSPACE_RUNTIME_ENV.rootDirectory,
    DEFAULT_AUTHORITATIVE_WORKSPACE_RUNTIME_ROOT,
  );
  const rootDirectory = await prepareSecureRuntimeDirectory(
    requestedRoot,
    resolve(requestedRoot, ".."),
  );
  const authorityOutputDirectory = await prepareSecureRuntimeDirectory(
    join(rootDirectory, "authority"),
    rootDirectory,
  );
  const projectionOutputDirectory = await prepareSecureRuntimeDirectory(
    join(rootDirectory, "projections"),
    rootDirectory,
  );
  const mutationJournalDirectory = await prepareSecureRuntimeDirectory(
    join(rootDirectory, "mutation-journal"),
    rootDirectory,
  );
  return Object.freeze({
    rootDirectory,
    authorityOutputDirectory,
    projectionOutputDirectory,
    mutationJournalDirectory,
    benchmarkOutputDirectory: optionalPath(
      environment,
      AUTHORITATIVE_WORKSPACE_RUNTIME_ENV.benchmarkOutputDirectory,
      DEFAULT_RECORDED_BENCHMARK_OUTPUT_DIRECTORY,
    ),
    regressionOutputDirectory: optionalPath(
      environment,
      AUTHORITATIVE_WORKSPACE_RUNTIME_ENV.regressionOutputDirectory,
      DEFAULT_RECORDED_REGRESSION_OUTPUT_DIRECTORY,
    ),
    staticDirectory: optionalPath(
      environment,
      AUTHORITATIVE_WORKSPACE_RUNTIME_ENV.staticDirectory,
      resolve(import.meta.dirname, "../dist"),
    ),
    port: portFromEnvironment(environment),
  });
}

async function assertRunnableStaticBuild(
  staticDirectory: string,
): Promise<void> {
  let directoryStat;
  let canonicalDirectory;
  let indexHandle;
  try {
    directoryStat = await lstat(staticDirectory);
    canonicalDirectory = await realpath(staticDirectory);
    indexHandle = await open(
      join(staticDirectory, "index.html"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const indexStat = await indexHandle.stat();
    if (!indexStat.isFile() || indexStat.nlink !== 1) {
      throw integrity(
        "권위 workspace static build의 index.html이 안전한 파일이 아닙니다.",
      );
    }
  } catch (error) {
    if (error instanceof AuthoritativeWorkspaceRuntimeIntegrityError) {
      throw error;
    }
    throw integrity(
      "권위 workspace static build 또는 index.html을 검증할 수 없습니다.",
      error,
    );
  } finally {
    await indexHandle?.close();
  }
  if (
    !directoryStat.isDirectory()
    || directoryStat.isSymbolicLink()
    || canonicalDirectory !== staticDirectory
  ) {
    throw integrity(
      "권위 workspace static build는 symlink가 아닌 canonical 디렉터리여야 합니다.",
    );
  }
}

function assertCanonicalTimestamp(value: string): void {
  if (
    !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw integrity("AI pre-review 시각은 canonical ISO timestamp여야 합니다.");
  }
}

function uniqueEvidenceHandles(
  item: Pick<
    BlindReviewQueueItem,
    | "deterministic_gate_finding"
    | "deterministic_gate_evidence"
    | "judge_evidence_handle"
  >,
): `evh_${string}`[] {
  const handles = [
    ...(item.deterministic_gate_finding === "CONFIRMED_FAIL"
      ? [item.deterministic_gate_evidence[0]?.evidence_handle]
      : []),
    item.judge_evidence_handle,
  ].filter((value): value is `evh_${string}` => value !== undefined);
  return [...new Set(handles)];
}

/**
 * AI Judge는 판정 권위가 아닙니다. proposed decision은 오직 잠긴
 * deterministic gate finding에서 만들고 Judge는 opaque evidence와
 * 사람 검수용 rationale에만 남깁니다.
 */
export function buildDeterministicAiPreReviewCommand({
  recordedBenchmarkPack,
  reviewedAt,
}: {
  readonly recordedBenchmarkPack: RecordedBenchmarkPack;
  readonly reviewedAt: string;
}): AiPreReviewCommand {
  assertCanonicalTimestamp(reviewedAt);
  const queue = recordedBenchmarkPack.blind_review_queue;
  return {
    schema_version: "ai-pre-review-command-v1",
    reviewer_label: "Deterministic pre-review controller",
    expected_recorded_benchmark_pack_hash:
      sha256CanonicalJson(recordedBenchmarkPack),
    expected_judge_evidence_hash:
      recordedBenchmarkPack.judge_evidence_pack_hash,
    expected_queue_content_hash: queue.queue_content_hash,
    expected_queue_set_order_hash: queue.queue_set_order_hash,
    items: queue.items.map((item) => {
      const confirmedFailure =
        item.deterministic_gate_finding === "CONFIRMED_FAIL";
      return {
        item_id: item.item_id,
        proposed_decision: confirmedFailure
          ? "PROPOSED_CONFIRMED_FAIL"
          : "PROPOSED_PASS",
        rationale: confirmedFailure
          ? "Locked deterministic gate evidence supports this proposed failure. Judge signals remain advisory evidence only."
          : `No locked deterministic gate failure was found. ${item.judge_risks.length} Judge risk signal(s) remain advisory evidence for human review only.`,
        evidence_handles: uniqueEvidenceHandles(item),
      };
    }),
    reviewed_at: reviewedAt,
  };
}

function assertCleanRecordedBenchmarkOutcome(
  outcome: RecordedBenchmarkOutcome,
  assertPersistedPack: (
    value: unknown,
  ) => asserts value is RecordedBenchmarkPack,
): RecordedBenchmarkPack {
  const summary = outcome.summary;
  const cleanupResources = summary.cleanup.resources;
  const cleanupKinds = {
    vectorStores: cleanupResources.filter(
      (resource) => resource.kind === "VECTOR_STORE",
    ).length,
    uploadedFiles: cleanupResources.filter(
      (resource) => resource.kind === "UPLOADED_FILE",
    ).length,
  };
  const cleanupFingerprints = new Set(
    cleanupResources.map((resource) => resource.fingerprint),
  );
  if (
    outcome.exitCode !== 0
    || outcome.serverAuthority === null
    || summary.command_status !== "RECORDED_BENCHMARK_REVIEW_PENDING"
    || summary.artifact_kind !== "RECORDED_BENCHMARK_PACK"
    || summary.source !== "RECORDED_BENCHMARK"
    || summary.execution_status !== "EXECUTION_COMPLETE"
    || (
      summary.judge_status !== "JUDGE_COMPLETE"
      && summary.judge_status !== "JUDGE_PARTIAL_HUMAN_FALLBACK"
    )
    || summary.review_status !== "REVIEW_PENDING"
    || summary.evaluation_status !== "EVALUATION_INCOMPLETE"
    || summary.baseline_version !== null
    || summary.evaluation_complete !== false
    || summary.baseline_created !== false
    || summary.clean_completion !== true
    || summary.candidate_execution_count !== 72
    || summary.auxiliary_judge_count !== 12
    || summary.complete_judge_count
      + summary.human_fallback_judge_count !== 12
    || summary.recorded_pack_path === null
    || summary.cleanup.required !== 33
    || summary.cleanup.acknowledged !== 33
    || summary.cleanup.incomplete !== 0
    || cleanupResources.length !== 33
    || cleanupKinds.vectorStores !== 1
    || cleanupKinds.uploadedFiles !== 32
    || cleanupFingerprints.size !== 33
    || cleanupResources.some(
      (resource) => (
        resource.delete_acknowledged !== true
        || !/^sha256:[a-f0-9]{12}$/.test(resource.fingerprint)
      ),
    )
    || typeof summary.cleanup.receipt_path !== "string"
    || summary.cleanup.receipt_path.length === 0
  ) {
    throw integrity(
      "Recorded Benchmark는 source-reloaded 72+12 결과와 33/33 cleanup authority를 모두 충족해야 합니다.",
    );
  }
  const pack = outcome.serverAuthority.recordedBenchmarkPack;
  assertPersistedPack(pack);
  return pack;
}

export interface AuthoritativeWorkspaceRuntimeDependencies {
  loadLockedChallengePack(
    environment: NodeJS.ProcessEnv,
  ): Promise<LockedChallengePack>;
  executeRecordedBenchmark(input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly outputDirectory: string;
    readonly signal?: AbortSignal;
  }): Promise<RecordedBenchmarkOutcome>;
  assertPersistedRecordedBenchmarkPack(
    value: unknown,
  ): asserts value is RecordedBenchmarkPack;
  loadExistingAiPreReviewReceipt(input: {
    readonly outputDirectory: string;
    readonly benchmarkPack: RecordedBenchmarkPack;
    readonly queue: RecordedBenchmarkPack["blind_review_queue"];
  }): Promise<AiPreReviewReceipt | null>;
  buildAiPreReviewReceipt(input: {
    readonly benchmarkPack: RecordedBenchmarkPack;
    readonly queue: RecordedBenchmarkPack["blind_review_queue"];
    readonly command: AiPreReviewCommand;
  }): AiPreReviewReceipt;
  persistAiPreReviewReceipt(input: {
    readonly outputDirectory: string;
    readonly receipt: AiPreReviewReceipt;
  }): Promise<{ readonly path: string }>;
  loadAiPreReviewReceipt(input: {
    readonly path: string;
    readonly benchmarkPack: RecordedBenchmarkPack;
    readonly queue: RecordedBenchmarkPack["blind_review_queue"];
  }): Promise<AiPreReviewReceipt>;
  assertPersistedAiPreReviewReceipt(
    value: unknown,
  ): asserts value is AiPreReviewReceipt;
  loadExistingProvisionalDecisionMemo(input: {
    readonly outputDirectory: string;
    readonly benchmarkPack: RecordedBenchmarkPack;
    readonly queue: RecordedBenchmarkPack["blind_review_queue"];
    readonly preReviewReceipt: AiPreReviewReceipt;
  }): Promise<ProvisionalDecisionMemo | null>;
  buildProvisionalDecisionMemo(input: {
    readonly benchmarkPack: RecordedBenchmarkPack;
    readonly queue: RecordedBenchmarkPack["blind_review_queue"];
    readonly preReviewReceipt: AiPreReviewReceipt;
    readonly createdAt: string;
  }): ProvisionalDecisionMemo;
  persistProvisionalDecisionMemo(input: {
    readonly outputDirectory: string;
    readonly memo: ProvisionalDecisionMemo;
  }): Promise<{ readonly path: string }>;
  loadProvisionalDecisionMemo(input: {
    readonly path: string;
    readonly benchmarkPack: RecordedBenchmarkPack;
    readonly queue: RecordedBenchmarkPack["blind_review_queue"];
    readonly preReviewReceipt: AiPreReviewReceipt;
  }): Promise<ProvisionalDecisionMemo>;
  assertPersistedProvisionalDecisionMemo(
    value: unknown,
  ): asserts value is ProvisionalDecisionMemo;
  persistRecordedReviewProjection(input: {
    readonly outputDirectory: string;
    readonly sources: RecordedReviewSnapshotSources;
  }): Promise<{ readonly path: string }>;
  loadProjectionSnapshot(path: string): Promise<ProjectionSnapshot>;
  createFinalDecisionMemoAdapter(input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
  }): OfficialOpenAIFinalDecisionMemoAdapter;
  createRecordedRegressionRunner(input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly outputDirectory: string;
    readonly signal?: AbortSignal;
  }): RecordedRegressionRunner;
  loadPersistedRecordedRegression: PersistedRecordedRegressionLoader;
  createGateway(
    input: AuthoritativeRecordedWorkflowGatewayOptions,
  ): ChallengeApiGateway;
  startServer(input: {
    readonly gateway: ChallengeApiGateway;
    readonly mutationJournal: FileMutationJournal;
    readonly staticDirectory: string;
    readonly port: number;
  }): Promise<ReadOnlyWorkspaceServer>;
}

async function findSingleAuthorityRecord({
  outputDirectory,
  directoryPattern,
  claimFilename,
  recordPattern,
  label,
}: {
  readonly outputDirectory: string;
  readonly directoryPattern: RegExp;
  readonly claimFilename: string;
  readonly recordPattern: RegExp;
  readonly label: string;
}): Promise<string | null> {
  const candidates = (await readdir(outputDirectory, { withFileTypes: true }))
    .filter((entry) => directoryPattern.test(entry.name));
  if (candidates.length === 0) return null;
  if (
    candidates.length !== 1
    || !candidates[0]!.isDirectory()
    || candidates[0]!.isSymbolicLink()
  ) {
    throw integrity(
      `${label} source directory는 symlink가 아닌 단일 권위 기록이어야 합니다.`,
    );
  }
  const artifactDirectory = join(outputDirectory, candidates[0]!.name);
  const entries = await readdir(artifactDirectory, { withFileTypes: true });
  const records = entries.filter((entry) => recordPattern.test(entry.name));
  if (
    records.length !== 1
    || !records[0]!.isFile()
    || records[0]!.isSymbolicLink()
    || entries.length !== 2
    || !entries.some((entry) => (
      entry.name === claimFilename
      && entry.isFile()
      && !entry.isSymbolicLink()
    ))
  ) {
    throw integrity(
      `${label} source directory의 claim·record exact layout이 다릅니다.`,
    );
  }
  return join(artifactDirectory, records[0]!.name);
}

const productionDependencies: AuthoritativeWorkspaceRuntimeDependencies = {
  loadLockedChallengePack: async (environment) => (
    await loadLockedChallengeAuthorityRecord({
      outputDirectory: requiredText(
        environment,
        RECORDED_BENCHMARK_AUTHORITY_ENV.directory,
      ),
      challengeId: requiredText(
        environment,
        RECORDED_BENCHMARK_AUTHORITY_ENV.challengeId,
      ),
      challengeVersion: requiredText(
        environment,
        RECORDED_BENCHMARK_AUTHORITY_ENV.challengeVersion,
      ),
    })
  ).pack,
  executeRecordedBenchmark: (input) => executeProductionRecordedBenchmark({
    environment: input.environment,
    outputDirectory: input.outputDirectory,
    ...(input.signal ? { signal: input.signal } : {}),
  }),
  assertPersistedRecordedBenchmarkPack,
  loadExistingAiPreReviewReceipt: async ({
    outputDirectory,
    benchmarkPack,
    queue,
  }) => {
    const path = await findSingleAuthorityRecord({
      outputDirectory,
      directoryPattern: AI_PRE_REVIEW_DIRECTORY,
      claimFilename: "ai-pre-review--claim.json",
      recordPattern: AI_PRE_REVIEW_RECORD,
      label: "AI pre-review",
    });
    return path === null
      ? null
      : loadAiPreReviewReceipt({ path, benchmarkPack, queue });
  },
  buildAiPreReviewReceipt,
  persistAiPreReviewReceipt,
  loadAiPreReviewReceipt,
  assertPersistedAiPreReviewReceipt,
  loadExistingProvisionalDecisionMemo: async ({
    outputDirectory,
    benchmarkPack,
    queue,
    preReviewReceipt,
  }) => {
    const path = await findSingleAuthorityRecord({
      outputDirectory,
      directoryPattern: PROVISIONAL_MEMO_DIRECTORY,
      claimFilename: "provisional-decision-memo--claim.json",
      recordPattern: PROVISIONAL_MEMO_RECORD,
      label: "Provisional Decision Memo",
    });
    return path === null
      ? null
      : loadProvisionalDecisionMemo({
        path,
        benchmarkPack,
        queue,
        preReviewReceipt,
      });
  },
  buildProvisionalDecisionMemo,
  persistProvisionalDecisionMemo,
  loadProvisionalDecisionMemo,
  assertPersistedProvisionalDecisionMemo,
  persistRecordedReviewProjection: persistRecordedReviewProjectionSnapshot,
  loadProjectionSnapshot: (path) => (
    loadReadOnlyProjectionSnapshotRecord({ path })
  ),
  createFinalDecisionMemoAdapter: ({ environment, signal }) => {
    return createOpenAIFinalDecisionMemoAdapter({
      apiKey: requireOpenAiApiKey(environment),
      ...(signal ? { signal } : {}),
    });
  },
  createRecordedRegressionRunner: ({
    environment,
    outputDirectory,
    signal,
  }) => async (input) => {
    const result = await executeProductionRecordedRegression({
      environment,
      outputDirectory,
      decisionBaselineRecord: input.decisionBaselineRecord,
      ...(signal ? { signal } : {}),
    });
    return Object.freeze({
      pack: result.pack,
      path: result.path,
      payloadSha256: result.payloadSha256,
    });
  },
  loadPersistedRecordedRegression: async ({
    result,
    decisionBaselineRecord,
  }) => {
    assertPersistedRecordedRegressionPack(result.pack);
    const expectedDecisionHash = sha256CanonicalJson(
      decisionBaselineRecord,
    );
    if (
      result.payloadSha256 !== sha256CanonicalJson(result.pack)
      || result.pack.authority.decision_baseline_record_hash
        !== expectedDecisionHash
      || result.pack.authority.baseline_version
        !== decisionBaselineRecord.baseline_version
      || result.pack.selected_candidate_id
        !== decisionBaselineRecord.selected_candidate_id
    ) {
      throw integrity(
        "Recorded Regression source-reloaded pack이 active Decision baseline과 다릅니다.",
      );
    }
    return result.pack;
  },
  createGateway: createAuthoritativeRecordedWorkflowGateway,
  startServer: startAuthoritativeWorkspaceServer,
};

const PRODUCTION_DEPENDENCIES = Object.freeze(productionDependencies);

export interface AuthoritativeWorkspaceRuntime {
  readonly server: ReadOnlyWorkspaceServer;
  readonly paths: AuthoritativeWorkspaceRuntimePaths;
  readonly initialSnapshotPath: string;
  readonly recordedBenchmarkPackHash: string;
  readonly aiPreReviewReceiptHash: string;
  readonly provisionalDecisionMemoHash: string;
}

async function startAuthoritativeWorkspaceRuntimeWithDependencies({
  environment,
  dependencies,
  signal,
  now = () => new Date().toISOString(),
}: {
  readonly environment: NodeJS.ProcessEnv;
  readonly dependencies: AuthoritativeWorkspaceRuntimeDependencies;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
}): Promise<AuthoritativeWorkspaceRuntime> {
  if (
    environment[RECORDED_BENCHMARK_ACKNOWLEDGEMENT_ENV]
      !== RECORDED_BENCHMARK_ACKNOWLEDGEMENT
  ) {
    throw integrity(
      "합성 72+12 Recorded Benchmark 실행 acknowledgement가 필요합니다.",
    );
  }
  // 키의 값은 반환 객체·artifact·로그에 보존하지 않습니다.
  requireOpenAiApiKey(environment);
  const paths = await runtimePaths(environment);
  // 비용이 발생하는 OpenAI 호출보다 먼저 제출용 정적 build를 검증합니다.
  await assertRunnableStaticBuild(paths.staticDirectory);
  const lockedChallengePack =
    await dependencies.loadLockedChallengePack(environment);
  const outcome = await dependencies.executeRecordedBenchmark({
    environment,
    outputDirectory: paths.benchmarkOutputDirectory,
    ...(signal ? { signal } : {}),
  });
  const recordedBenchmarkPack = assertCleanRecordedBenchmarkOutcome(
    outcome,
    dependencies.assertPersistedRecordedBenchmarkPack,
  );
  if (
    recordedBenchmarkPack.locked_challenge_pack_hash
      !== lockedChallengePack.locked_challenge_pack_hash
  ) {
    throw integrity(
      "Recorded Benchmark가 source-loaded Locked Challenge와 결합되지 않았습니다.",
    );
  }

  const existingPreReview =
    await dependencies.loadExistingAiPreReviewReceipt({
      outputDirectory: paths.authorityOutputDirectory,
      benchmarkPack: recordedBenchmarkPack,
      queue: recordedBenchmarkPack.blind_review_queue,
    });
  let reviewedAt: string;
  let preReviewReceipt: AiPreReviewReceipt;
  if (existingPreReview !== null) {
    reviewedAt = existingPreReview.reviewed_at;
    preReviewReceipt = existingPreReview;
  } else {
    reviewedAt = now();
    const preReviewCommand = buildDeterministicAiPreReviewCommand({
      recordedBenchmarkPack,
      reviewedAt,
    });
    const builtPreReview = dependencies.buildAiPreReviewReceipt({
      benchmarkPack: recordedBenchmarkPack,
      queue: recordedBenchmarkPack.blind_review_queue,
      command: preReviewCommand,
    });
    if (
      builtPreReview.pre_review_status !== "USER_CONFIRMATION_READY"
      || builtPreReview.blocking_reasons.length !== 0
    ) {
      throw integrity(
        "AI pre-review가 USER_CONFIRMATION_BLOCKED 상태이므로 권위 server를 열 수 없습니다.",
      );
    }
    const persistedPreReview =
      await dependencies.persistAiPreReviewReceipt({
        outputDirectory: paths.authorityOutputDirectory,
        receipt: builtPreReview,
      });
    preReviewReceipt = await dependencies.loadAiPreReviewReceipt({
      path: persistedPreReview.path,
      benchmarkPack: recordedBenchmarkPack,
      queue: recordedBenchmarkPack.blind_review_queue,
    });
  }
  const assertPersistedPreReview: (
    value: unknown,
  ) => asserts value is AiPreReviewReceipt =
    dependencies.assertPersistedAiPreReviewReceipt;
  assertPersistedPreReview(preReviewReceipt);
  if (
    preReviewReceipt.pre_review_status !== "USER_CONFIRMATION_READY"
    || preReviewReceipt.blocking_reasons.length !== 0
  ) {
    throw integrity(
      "Source-reloaded AI pre-review가 confirmation-ready 상태가 아닙니다.",
    );
  }

  const existingProvisionalMemo =
    await dependencies.loadExistingProvisionalDecisionMemo({
      outputDirectory: paths.authorityOutputDirectory,
      benchmarkPack: recordedBenchmarkPack,
      queue: recordedBenchmarkPack.blind_review_queue,
      preReviewReceipt,
    });
  let provisionalDecisionMemo: ProvisionalDecisionMemo;
  if (existingProvisionalMemo !== null) {
    provisionalDecisionMemo = existingProvisionalMemo;
  } else {
    const builtProvisionalMemo = dependencies.buildProvisionalDecisionMemo({
      benchmarkPack: recordedBenchmarkPack,
      queue: recordedBenchmarkPack.blind_review_queue,
      preReviewReceipt,
      createdAt: reviewedAt,
    });
    if (
      builtProvisionalMemo.memo_status !== "USER_CONFIRMATION_REQUIRED"
    ) {
      throw integrity(
        "Provisional Decision Memo가 사용자 확인 필요 상태가 아닙니다.",
      );
    }
    const persistedProvisional =
      await dependencies.persistProvisionalDecisionMemo({
        outputDirectory: paths.authorityOutputDirectory,
        memo: builtProvisionalMemo,
      });
    provisionalDecisionMemo =
      await dependencies.loadProvisionalDecisionMemo({
        path: persistedProvisional.path,
        benchmarkPack: recordedBenchmarkPack,
        queue: recordedBenchmarkPack.blind_review_queue,
        preReviewReceipt,
      });
  }
  const assertPersistedProvisional: (
    value: unknown,
  ) => asserts value is ProvisionalDecisionMemo =
    dependencies.assertPersistedProvisionalDecisionMemo;
  assertPersistedProvisional(provisionalDecisionMemo);
  if (
    provisionalDecisionMemo.memo_status
      !== "USER_CONFIRMATION_REQUIRED"
  ) {
    throw integrity(
      "Source-reloaded Provisional Decision Memo가 confirmation-required 상태가 아닙니다.",
    );
  }

  const initialSources: RecordedReviewSnapshotSources = {
    lockedChallengePack,
    recordedBenchmarkPack,
    preReviewReceipt,
    provisionalDecisionMemo,
  };
  const persistedInitial =
    await dependencies.persistRecordedReviewProjection({
      outputDirectory: paths.projectionOutputDirectory,
      sources: initialSources,
    });
  const initialSnapshot = await dependencies.loadProjectionSnapshot(
    persistedInitial.path,
  );
  const finalDecisionMemoAdapter =
    dependencies.createFinalDecisionMemoAdapter({
      environment,
      ...(signal ? { signal } : {}),
    });
  const recordedRegressionRunner =
    dependencies.createRecordedRegressionRunner({
      environment,
      outputDirectory: paths.regressionOutputDirectory,
      ...(signal ? { signal } : {}),
    });
  const gateway = dependencies.createGateway({
    initialSnapshot,
    authorityOutputDirectory: paths.authorityOutputDirectory,
    projectionOutputDirectory: paths.projectionOutputDirectory,
    initialSources,
    finalDecisionMemoAdapter,
    recordedRegressionRunner,
    loadPersistedRecordedRegression:
      dependencies.loadPersistedRecordedRegression,
  });
  const mutationJournal = new FileMutationJournal(
    paths.mutationJournalDirectory,
  );
  const server = await dependencies.startServer({
    gateway,
    mutationJournal,
    staticDirectory: paths.staticDirectory,
    port: paths.port,
  });
  return Object.freeze({
    server,
    paths,
    initialSnapshotPath: persistedInitial.path,
    recordedBenchmarkPackHash:
      sha256CanonicalJson(recordedBenchmarkPack),
    aiPreReviewReceiptHash: sha256CanonicalJson(preReviewReceipt),
    provisionalDecisionMemoHash:
      sha256CanonicalJson(provisionalDecisionMemo),
  });
}

/**
 * 실제 entrypoint가 사용하는 production 경계입니다. 호출자가 domain assertion,
 * gateway 또는 OpenAI adapter를 runtime option으로 대체할 수 없습니다.
 */
export function startAuthoritativeWorkspaceRuntime({
  environment,
  signal,
  now,
}: {
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
}): Promise<AuthoritativeWorkspaceRuntime> {
  return startAuthoritativeWorkspaceRuntimeWithDependencies({
    environment,
    dependencies: PRODUCTION_DEPENDENCIES,
    ...(signal ? { signal } : {}),
    ...(now ? { now } : {}),
  });
}

/**
 * 네트워크 없는 orchestration·HTTP integration 테스트 전용 seam입니다.
 */
export function startAuthoritativeWorkspaceRuntimeForTest(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly dependencies: AuthoritativeWorkspaceRuntimeDependencies;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
}): Promise<AuthoritativeWorkspaceRuntime> {
  return startAuthoritativeWorkspaceRuntimeWithDependencies(input);
}

type RuntimeSignal = "SIGINT" | "SIGTERM";

export interface AuthoritativeWorkspaceProcessLike {
  readonly env: NodeJS.ProcessEnv;
  exitCode?: string | number | null;
  readonly stdout: { write(value: string): unknown };
  readonly stderr: { write(value: string): unknown };
  on(event: RuntimeSignal, listener: () => void): unknown;
  removeListener(event: RuntimeSignal, listener: () => void): unknown;
}

async function runAuthoritativeWorkspaceProcessWithDependencies({
  runtime = process,
  dependencies,
}: {
  readonly runtime?: AuthoritativeWorkspaceProcessLike;
  readonly dependencies: AuthoritativeWorkspaceRuntimeDependencies;
}): Promise<AuthoritativeWorkspaceRuntime | null> {
  const abort = new AbortController();
  let active: AuthoritativeWorkspaceRuntime | null = null;
  let interrupted: RuntimeSignal | null = null;
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signalName: RuntimeSignal) => {
    if (interrupted === null) interrupted = signalName;
    const terminalExitCode = interrupted === "SIGINT" ? 130 : 143;
    runtime.exitCode = terminalExitCode;
    if (!abort.signal.aborted) {
      abort.abort(new Error(`${signalName} runtime shutdown`));
    }
    if (active !== null && shutdownPromise === null) {
      shutdownPromise = active.server.close().catch(() => {
        runtime.stderr.write(
          "권위 workspace server 종료를 확인할 수 없습니다.\n",
        );
      }).finally(() => {
        runtime.removeListener("SIGINT", onSigint);
        runtime.removeListener("SIGTERM", onSigterm);
      });
    }
  };
  const onSigint = () => shutdown("SIGINT");
  const onSigterm = () => shutdown("SIGTERM");
  runtime.on("SIGINT", onSigint);
  runtime.on("SIGTERM", onSigterm);

  try {
    const started = await startAuthoritativeWorkspaceRuntimeWithDependencies({
      environment: runtime.env,
      dependencies,
      signal: abort.signal,
    });
    // Listener가 열린 직후 Promise handoff 전에 signal이 도착할 수 있습니다.
    // 이 구간에서는 shutdown callback이 아직 `active`를 볼 수 없으므로,
    // handoff 직후 중단 상태를 재확인하고 listener를 직접 닫습니다.
    if (interrupted !== null || abort.signal.aborted) {
      await started.server.close();
      runtime.removeListener("SIGINT", onSigint);
      runtime.removeListener("SIGTERM", onSigterm);
      runtime.exitCode = interrupted === "SIGINT" ? 130 : 143;
      return null;
    }
    active = started;
  } catch {
    runtime.removeListener("SIGINT", onSigint);
    runtime.removeListener("SIGTERM", onSigterm);
    runtime.stderr.write(
      "권위 workspace runtime이 source·cleanup·review preflight를 통과하지 못했습니다.\n",
    );
    runtime.exitCode = interrupted === "SIGINT"
      ? 130
      : interrupted === "SIGTERM" ? 143 : 1;
    return null;
  }
  runtime.stdout.write(
    [
      "AI Challenge Room · AUTHORITATIVE SAME-PROCESS RUNTIME · ",
      active.server.origin,
      "\n",
    ].join(""),
  );
  return active;
}

export function runAuthoritativeWorkspaceProcess({
  runtime = process,
}: {
  readonly runtime?: AuthoritativeWorkspaceProcessLike;
} = {}): Promise<AuthoritativeWorkspaceRuntime | null> {
  return runAuthoritativeWorkspaceProcessWithDependencies({
    runtime,
    dependencies: PRODUCTION_DEPENDENCIES,
  });
}

export function runAuthoritativeWorkspaceProcessForTest(input: {
  readonly runtime?: AuthoritativeWorkspaceProcessLike;
  readonly dependencies: AuthoritativeWorkspaceRuntimeDependencies;
}): Promise<AuthoritativeWorkspaceRuntime | null> {
  return runAuthoritativeWorkspaceProcessWithDependencies(input);
}

function isDirectExecution(
  metaUrl: string,
  argvEntry: string | undefined,
): boolean {
  return argvEntry !== undefined
    && metaUrl === pathToFileURL(resolve(argvEntry)).href;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void runAuthoritativeWorkspaceProcess();
}

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import OpenAI from "openai";
import { requireOpenAiApiKey } from "./config";
import {
  buildCleanupReceipt,
  persistCleanupReceipt,
  type CleanupReceipt,
} from "./cleanupReceipt";
import {
  redactSensitiveText,
  type CalibrationResourceIds,
} from "./calibrationOutcome";
import {
  buildBenchmarkExecutionPlans,
  type BenchmarkAdapterCoordinates,
} from "../benchmark/buildExecutionPlans";
import {
  executeBenchmark,
  BenchmarkExecutionSlotPlan,
  type ExecuteBenchmarkOptions,
} from "../benchmark/executeBenchmark";
import type {
  BenchmarkCompletionReceipt,
  BenchmarkProgressJournal,
} from "../benchmark/benchmarkProgressPersistence";
import {
  buildStableBenchmarkId,
  openBenchmarkProgressJournal,
} from "../benchmark/benchmarkProgressPersistence";
import {
  buildBenchmarkExecutionIdentity,
  persistBenchmarkExecutionIdentityAuthority,
  type BenchmarkExecutionIdentityAuthorityReference,
  type BenchmarkExecutionIdentity,
  type BenchmarkSlotIdentity,
} from "../benchmark/identity";
import {
  PreparedBenchmarkPolicyVectorStore,
} from "../benchmark/policyVectorStore";
import {
  createProductionBenchmarkResourceLeaseController,
  type BenchmarkResourceLeaseTerminalAuthority,
  type BenchmarkResourceLeaseFinalizationArtifacts,
  type BenchmarkResourceLeaseRemoteClient,
} from "../benchmark/resourceLease";
import { createBenchmarkAdapterFactory } from "../benchmark/runtimeAdapterFactory";
import {
  buildBenchmarkSchedule,
  type BenchmarkSchedule,
} from "../benchmark/schedule";
import type { PolicySection } from "../contracts/evaluationCase";
import {
  assertAuthoritativeLockedChallengePack,
  type LockedChallengePack,
} from "../define/defineContracts";
import {
  loadLockedChallengeAuthorityRecord,
} from "../define/lockedChallengePersistence";
import {
  assertCandidateProjectionDoesNotLeakEvaluatorMetadata,
  assertCrossSplitSemanticTemplateIsolation,
  BENCHMARK_CASES,
  BENCHMARK_CHALLENGE,
  BENCHMARK_DATASET_HASH,
  BENCHMARK_ORDERS,
  BENCHMARK_POLICIES,
  validateHiddenBenchmarkAccessInvariants,
} from "../data/benchmark";
import {
  assertValidatedBenchmarkExecutionPack,
  type BenchmarkExecutionPack,
} from "../pack/benchmarkPack";
import { promoteRecordedBenchmark } from "../pack/promoteRecordedBenchmark";
import {
  assertValidatedRecordedBenchmarkPack,
  loadRecordedBenchmarkPack,
  persistRecordedBenchmarkPack,
  type RecordedBenchmarkPack,
} from "../pack/recordedBenchmarkPack";
import {
  reloadCompletedRecordedBenchmarkPackForColdStart,
} from "../pack/coldRecordedBenchmarkReload";
import {
  PolicyVectorStorePreparationError,
  type PolicyVectorStoreCleanupResult,
} from "../retrieval/policyVectorStore";
import type { CandidateAdapter } from "../runner/types";
import { throwIfAborted } from "../runner/types";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import {
  createAuthoritativePrivateBlindingContextReference,
  type AuthoritativePrivateBlindingContextReference,
} from "../review/privateBlindingSeedPersistence";
import {
  createAuthoritativeBlindingPrecommitReference,
  type AuthoritativeBlindingPrecommitReference,
} from "../review/judgeEvidencePrecommitPersistence";

type RecordedBenchmarkSignal = "SIGINT" | "SIGTERM";

export const RECORDED_BENCHMARK_ACKNOWLEDGEMENT_ENV
  = "AI_RECORDED_BENCHMARK_ACKNOWLEDGEMENT";

export const RECORDED_BENCHMARK_ACKNOWLEDGEMENT
  = "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12";

export const RECORDED_BENCHMARK_AUTHORITY_ENV = Object.freeze({
  directory: "AI_LOCKED_CHALLENGE_AUTHORITY_DIRECTORY",
  challengeId: "AI_LOCKED_CHALLENGE_ID",
  challengeVersion: "AI_LOCKED_CHALLENGE_VERSION",
});

export const DEFAULT_RECORDED_BENCHMARK_OUTPUT_DIRECTORY = resolve(
  import.meta.dirname,
  "../../.runtime/recorded-benchmark",
);

export class RecordedBenchmarkInterruptionError extends Error {
  readonly signalName: RecordedBenchmarkSignal;

  constructor(signalName: RecordedBenchmarkSignal) {
    super(`${signalName}으로 Recorded Benchmark 실행이 중단됐습니다.`);
    this.name = "RecordedBenchmarkInterruptionError";
    this.signalName = signalName;
  }
}

/**
 * 자원 출처를 명시해 공개 보정(calibration) 자원을 숨은 Benchmark 실행에
 * 실수로 재사용하지 못하게 합니다.
 */
export interface PreparedRecordedBenchmarkPolicyStore
  extends PreparedBenchmarkPolicyVectorStore {
  readonly resource_scope:
    | "RECORDED_BENCHMARK"
    | "CALIBRATION"
    | "CALIBRATION_SMOKE";
}

interface BuildExecutionIdentityInput {
  readonly preparedPolicyStore: PreparedRecordedBenchmarkPolicyStore;
  readonly schedule: BenchmarkSchedule;
}

interface CreateAdapterFactoryInput {
  readonly client: unknown;
  readonly preparedPolicyStore: PreparedRecordedBenchmarkPolicyStore;
}

interface PromoteRecordedBenchmarkInput {
  readonly client: unknown;
  readonly executionPack: BenchmarkExecutionPack;
  /**
   * 부모 승격기는 projection이 아니라 이 권위 좌표로 저장된 72개
   * intent·receipt·checkpoint chain을 다시 로드하고 검증해야 합니다.
   */
  readonly executionIdentity: BenchmarkExecutionIdentity;
  readonly schedule: BenchmarkSchedule;
  readonly plans: readonly BenchmarkExecutionSlotPlan[];
  readonly outputDirectory: string;
  readonly signal?: AbortSignal;
}

export interface RecordedBenchmarkPromotion {
  readonly pack: RecordedBenchmarkPack;
  readonly auxiliaryJudgeCount: number;
  readonly completeJudgeCount: number;
  readonly humanFallbackJudgeCount: number;
}

export interface RecordedBenchmarkCommandDependencies {
  readonly assertSyntheticBenchmarkData: () => void;
  readonly createClient: (apiKey: string) => unknown;
  readonly preparePolicyStore: (
    client: unknown,
    policies: readonly PolicySection[],
    options?: { signal?: AbortSignal },
  ) => Promise<PreparedRecordedBenchmarkPolicyStore>;
  readonly buildSchedule: () => BenchmarkSchedule;
  readonly buildExecutionIdentity: (
    input: BuildExecutionIdentityInput,
  ) => BenchmarkExecutionIdentity;
  readonly persistExecutionIdentityAuthority: (input: {
    readonly outputDirectory: string;
    readonly executionIdentity: BenchmarkExecutionIdentity;
  }) => Promise<{
    readonly path: string;
    readonly payloadSha256: string;
  }>;
  readonly createAdapterFactory: (
    input: CreateAdapterFactoryInput,
  ) => (coordinates: BenchmarkAdapterCoordinates) => CandidateAdapter;
  readonly buildExecutionPlans: (input: {
    readonly executionIdentity: BenchmarkExecutionIdentity;
    readonly schedule: BenchmarkSchedule;
    readonly adapterFor: (
      coordinates: BenchmarkAdapterCoordinates,
    ) => CandidateAdapter;
  }) => readonly BenchmarkExecutionSlotPlan[];
  readonly executeBenchmark: (
    input: ExecuteBenchmarkOptions,
  ) => Promise<BenchmarkExecutionPack>;
  readonly assertValidatedExecutionPack: (
    pack: unknown,
  ) => void;
  /**
   * 72-slot 팩 검증 뒤에만 호출됩니다. 정확히 12개 보조 Judge 실행과
   * 사람 검수 대기 상태의 부모 팩 생성을 책임지고, persistence는 하지 않습니다.
   */
  readonly promoteRecordedBenchmark: (
    input: PromoteRecordedBenchmarkInput,
  ) => Promise<RecordedBenchmarkPromotion>;
  readonly assertValidatedRecordedPack: (
    pack: unknown,
  ) => void;
  readonly persistRecordedPack: (input: {
    readonly outputDirectory: string;
    readonly pack: RecordedBenchmarkPack;
  }) => Promise<string>;
  /**
   * 저장 직후 메모리 객체는 다음 권위 단계에 전달하지 않습니다.
   * write-once 파일을 canonical source에서 다시 읽고 전체 hash chain을
   * 검증한 별도 인스턴스만 서버 권위로 승격합니다.
   */
  readonly loadPersistedRecordedPack: (input: {
    readonly path: string;
    readonly pack: RecordedBenchmarkPack;
  }) => Promise<RecordedBenchmarkPack>;
  /**
   * 완료된 lifecycle 재시작에서는 후보·Judge를 재호출하지 않습니다.
   * durable completion binding과 72+12 로컬 ledger를 source-reload한
   * 부모 팩만 반환해야 합니다.
   */
  readonly reloadCompletedRecordedBenchmark?: (input: {
    readonly outputDirectory: string;
    readonly executionIdentityAuthority:
      BenchmarkExecutionIdentityAuthorityReference;
    readonly plans: readonly Readonly<{
      readonly slot_identity: BenchmarkSlotIdentity;
    }>[];
    readonly completionReceipt: BenchmarkCompletionReceipt;
  }) => Promise<{
    readonly pack: RecordedBenchmarkPack;
    readonly recordedPackPath: string;
  }>;
  readonly cleanupPolicyStore: (
    client: unknown,
    resources: CalibrationResourceIds,
  ) => Promise<PolicyVectorStoreCleanupResult>;
  readonly persistCleanupReceipt: (
    receipt: CleanupReceipt,
    outputDirectory: string,
  ) => Promise<string>;
  /**
   * production remote resource lease가 API 삭제 승인을 write-once terminal
   * record에 결합합니다. 일반 단위 테스트 dependency에는 없어도 됩니다.
   */
  readonly finalizePolicyStoreLease?: (
    cleanup: PolicyVectorStoreCleanupResult,
    artifacts?: BenchmarkResourceLeaseFinalizationArtifacts,
  ) => Promise<void>;
  /**
   * terminal local recovery의 기존 completion binding과 실제 산출물을
   * 매번 source-reload 검증한 권위 좌표입니다.
   */
  readonly loadPolicyStoreFinalizationArtifacts?: () => Promise<
    BenchmarkResourceLeaseFinalizationArtifacts | null
  >;
  readonly loadPolicyStoreTerminalAuthority?: () => Promise<
    BenchmarkResourceLeaseTerminalAuthority
  >;
}

export interface ExecuteRecordedBenchmarkCommandOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly outputDirectory: string;
  readonly dependencies: RecordedBenchmarkCommandDependencies;
  readonly signal?: AbortSignal;
  readonly lifecycleJournal?: BenchmarkProgressJournal;
}

interface CleanupResourceSummary {
  readonly kind: "VECTOR_STORE" | "UPLOADED_FILE";
  readonly fingerprint: string;
  readonly delete_acknowledged: boolean;
}

export interface RecordedBenchmarkSummary {
  readonly command_status:
    | "RECORDED_BENCHMARK_REVIEW_PENDING"
    | "RECORDED_BENCHMARK_FAILED"
    | "RECORDED_BENCHMARK_INTERRUPTED"
    | "RECORDED_BENCHMARK_CLEANUP_INCOMPLETE";
  readonly artifact_kind: "RECORDED_BENCHMARK_PACK" | null;
  readonly source: "RECORDED_BENCHMARK";
  readonly execution_status: "EXECUTION_COMPLETE" | "NOT_COMPLETE";
  readonly judge_status:
    | "JUDGE_COMPLETE"
    | "JUDGE_PARTIAL_HUMAN_FALLBACK"
    | "NOT_COMPLETE";
  readonly review_status: "REVIEW_PENDING" | "NOT_CREATED";
  readonly evaluation_status: "EVALUATION_INCOMPLETE";
  readonly baseline_version: null;
  readonly evaluation_complete: false;
  readonly baseline_created: false;
  readonly clean_completion: boolean;
  readonly candidate_execution_count: number;
  readonly auxiliary_judge_count: number;
  readonly complete_judge_count: number;
  readonly human_fallback_judge_count: number;
  readonly recorded_pack_path: string | null;
  readonly cleanup: {
    readonly required: number;
    readonly acknowledged: number;
    readonly incomplete: number;
    readonly resources: readonly CleanupResourceSummary[];
    readonly receipt_path?: string;
  };
  readonly error?: string;
  readonly errors?: readonly string[];
}

export interface RecordedBenchmarkOutcome {
  readonly exitCode: 0 | 1 | 2 | 130 | 143;
  readonly summary: RecordedBenchmarkSummary;
  /**
   * 같은 서버 프로세스가 다음 권위 단계를 이어갈 때만 쓰는 비공개 객체입니다.
   * process 출력은 summary만 직렬화하며 이 값을 browser projection에 넣지 않습니다.
   */
  readonly serverAuthority: {
    readonly recordedBenchmarkPack: RecordedBenchmarkPack;
    readonly coldReloadReference?: Readonly<{
      readonly outputDirectory: string;
      readonly recordedPackPath: string;
      readonly recordedPackHash: string;
      readonly executionIdentityAuthority:
        BenchmarkExecutionIdentityAuthorityReference;
      readonly plans: readonly Readonly<{ readonly slot_identity: BenchmarkSlotIdentity }>[];
      readonly privateBlindingSeedAuthority:
        AuthoritativePrivateBlindingContextReference;
      readonly judgeEvidencePrecommitAuthority:
        AuthoritativeBlindingPrecommitReference;
    }>;
  } | null;
}

export type RecordedBenchmarkColdReloadReference = NonNullable<
  RecordedBenchmarkOutcome["serverAuthority"]
>["coldReloadReference"];

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "알 수 없는 Recorded Benchmark 오류";
}

function resourcesFromPrepared(
  prepared: Pick<
    PreparedRecordedBenchmarkPolicyStore,
    "vectorStoreId" | "uploadedFileIds"
  >,
): CalibrationResourceIds {
  return {
    vectorStoreId: prepared.vectorStoreId,
    uploadedFileIds: [...prepared.uploadedFileIds],
  };
}

function assertPreparedBenchmarkResources(
  prepared: PreparedRecordedBenchmarkPolicyStore,
): void {
  const uploadedIds = prepared.uploadedFileIds;
  if (prepared.resource_scope !== "RECORDED_BENCHMARK") {
    throw new TypeError(
      "공개 보정(CALIBRATION) 자원은 숨은 Recorded Benchmark 자원으로 사용할 수 없습니다.",
    );
  }
  if (
    typeof prepared.vectorStoreId !== "string"
    || prepared.vectorStoreId.trim().length === 0
    || !Array.isArray(uploadedIds)
    || uploadedIds.length !== 32
    || new Set(uploadedIds).size !== 32
    || uploadedIds.some((id) => (
      typeof id !== "string" || id.trim().length === 0
    ))
    || !Array.isArray(prepared.files)
    || prepared.files.length !== 32
  ) {
    throw new TypeError(
      "Recorded Benchmark에는 정책 Vector Store 1개와 고유한 업로드 32개가 필요합니다.",
    );
  }
  const manifestIds = prepared.files.map((file) => file.uploadedFileId);
  if (
    manifestIds.some((id, index) => id !== uploadedIds[index])
    || new Set(manifestIds).size !== 32
  ) {
    throw new TypeError(
      "Recorded Benchmark 정책 업로드와 manifest 순서가 일치해야 합니다.",
    );
  }
}

function assertExecutionPromotionBoundary(
  pack: BenchmarkExecutionPack,
): void {
  if (
    pack.artifact_kind !== "BENCHMARK_EXECUTION_PACK"
    || pack.source !== "RECORDED_BENCHMARK"
    || pack.execution_status !== "EXECUTION_COMPLETE"
    || pack.evaluation_status !== "EVALUATION_INCOMPLETE"
    || pack.review_status !== "NOT_GENERATED"
    || pack.baseline_version !== null
    || (
      pack.judge_readiness !== "READY_FOR_JUDGE"
      && pack.judge_readiness !== "INSUFFICIENT_VALID_OUTPUTS"
    )
    || pack.coverage.cases !== 12
    || pack.coverage.candidates !== 3
    || pack.coverage.runs_per_case !== 2
    || pack.coverage.expected_runs !== 72
    || pack.coverage.recorded_runs !== 72
  ) {
    throw new TypeError(
      "정확히 검증된 72-slot Benchmark Execution Pack만 Judge 단계로 승격할 수 있습니다.",
    );
  }
}

function assertRecordedPackBoundary(
  promotion: RecordedBenchmarkPromotion,
): void {
  const pack = promotion.pack;
  if (
    promotion.auxiliaryJudgeCount !== 12
    || promotion.completeJudgeCount + promotion.humanFallbackJudgeCount !== 12
    || promotion.completeJudgeCount
      !== pack.coverage.complete_judge_cases
    || promotion.humanFallbackJudgeCount
      !== pack.coverage.human_fallback_judge_cases
    || pack.artifact_kind !== "RECORDED_BENCHMARK_PACK"
    || pack.source !== "RECORDED_BENCHMARK"
    || pack.execution_status !== "EXECUTION_COMPLETE"
    || (
      pack.judge_status !== "JUDGE_COMPLETE"
      && pack.judge_status !== "JUDGE_PARTIAL_HUMAN_FALLBACK"
    )
    || pack.review_status !== "REVIEW_PENDING"
    || pack.evaluation_status !== "EVALUATION_INCOMPLETE"
    || pack.baseline_version !== null
    || pack.synthetic !== true
    || pack.coverage.cases !== 12
    || pack.coverage.candidates !== 3
    || pack.coverage.runs_per_case !== 2
    || pack.coverage.candidate_runs !== 72
    || pack.coverage.judge_cases !== 12
  ) {
    throw new TypeError(
      "Recorded Benchmark 승격은 72회 실행·12개 Judge·REVIEW_PENDING·기준선 없음 상태여야 합니다.",
    );
  }
}

function fingerprint(resourceId: string): string {
  const digest = createHash("sha256")
    .update(resourceId, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `sha256:${digest}`;
}

function summarizeCleanup(
  expectedResources: CalibrationResourceIds | null,
  cleanup: PolicyVectorStoreCleanupResult | null,
  receiptPath: string | null,
  sensitiveValues: readonly string[],
): RecordedBenchmarkSummary["cleanup"] {
  const acknowledgements = new Map<string, boolean>();
  if (cleanup?.vectorStore.id) {
    acknowledgements.set(
      cleanup.vectorStore.id,
      cleanup.vectorStore.attempted && cleanup.vectorStore.deleted,
    );
  }
  for (const file of cleanup?.uploadedFiles ?? []) {
    if (file.id) {
      acknowledgements.set(file.id, file.attempted && file.deleted);
    }
  }
  const resources = [
    ...(expectedResources?.vectorStoreId
      ? [{
        kind: "VECTOR_STORE" as const,
        id: expectedResources.vectorStoreId,
      }]
      : []),
    ...(expectedResources?.uploadedFileIds ?? []).map((id) => ({
      kind: "UPLOADED_FILE" as const,
      id,
    })),
  ].map(({ kind, id }) => ({
    kind,
    fingerprint: fingerprint(id),
    delete_acknowledged: acknowledgements.get(id) === true,
  }));
  const acknowledged = resources.filter(
    (resource) => resource.delete_acknowledged,
  ).length;
  return {
    required: resources.length,
    acknowledged,
    incomplete: resources.length - acknowledged,
    resources,
    ...(receiptPath
      ? { receipt_path: redactSensitiveText(receiptPath, sensitiveValues) }
      : {}),
  };
}

function interruptionFromSignal(
  signal: AbortSignal | undefined,
): RecordedBenchmarkSignal | null {
  return signal?.reason instanceof RecordedBenchmarkInterruptionError
    ? signal.reason.signalName
    : null;
}

function deriveOutcome({
  persistedPack,
  recordedPackPath,
  expectedResources,
  cleanup,
  cleanupReceiptPath,
  runtimeErrors,
  signal,
  sensitiveValues,
  coldReloadReference = null,
}: {
  readonly persistedPack: RecordedBenchmarkPack | null;
  readonly recordedPackPath: string | null;
  readonly expectedResources: CalibrationResourceIds | null;
  readonly cleanup: PolicyVectorStoreCleanupResult | null;
  readonly cleanupReceiptPath: string | null;
  readonly runtimeErrors: readonly unknown[];
  readonly signal?: AbortSignal;
  readonly sensitiveValues: readonly string[];
  readonly coldReloadReference?: RecordedBenchmarkOutcome["serverAuthority"] extends infer T
    ? T extends { readonly coldReloadReference?: infer Reference } ? Reference | null : null
    : null;
}): RecordedBenchmarkOutcome {
  const cleanupSummary = summarizeCleanup(
    expectedResources,
    cleanup,
    cleanupReceiptPath,
    sensitiveValues,
  );
  const errors = runtimeErrors.map((error) =>
    redactSensitiveText(errorMessage(error), sensitiveValues));
  const interruption = interruptionFromSignal(signal);
  const packAvailable = persistedPack !== null && recordedPackPath !== null;
  const cleanCompletion = (
    packAvailable
    && runtimeErrors.length === 0
    && cleanupSummary.required === 33
    && cleanupSummary.incomplete === 0
    && cleanupReceiptPath !== null
  );

  let exitCode: RecordedBenchmarkOutcome["exitCode"];
  let commandStatus: RecordedBenchmarkSummary["command_status"];
  if (interruption) {
    exitCode = interruption === "SIGINT" ? 130 : 143;
    commandStatus = "RECORDED_BENCHMARK_INTERRUPTED";
  } else if (
    expectedResources !== null
    && (
      cleanupSummary.incomplete > 0
      || cleanupReceiptPath === null
    )
  ) {
    exitCode = 2;
    commandStatus = "RECORDED_BENCHMARK_CLEANUP_INCOMPLETE";
  } else if (!cleanCompletion) {
    exitCode = 1;
    commandStatus = "RECORDED_BENCHMARK_FAILED";
  } else {
    exitCode = 0;
    commandStatus = "RECORDED_BENCHMARK_REVIEW_PENDING";
  }

  return {
    exitCode,
    serverAuthority: cleanCompletion && persistedPack !== null && coldReloadReference !== null
      ? Object.freeze({ recordedBenchmarkPack: persistedPack, coldReloadReference })
      : null,
    summary: {
      command_status: commandStatus,
      artifact_kind: packAvailable ? "RECORDED_BENCHMARK_PACK" : null,
      source: "RECORDED_BENCHMARK",
      execution_status: packAvailable ? "EXECUTION_COMPLETE" : "NOT_COMPLETE",
      judge_status: packAvailable
        ? persistedPack!.judge_status
        : "NOT_COMPLETE",
      review_status: packAvailable ? "REVIEW_PENDING" : "NOT_CREATED",
      evaluation_status: "EVALUATION_INCOMPLETE",
      baseline_version: null,
      evaluation_complete: false,
      baseline_created: false,
      clean_completion: cleanCompletion,
      candidate_execution_count: packAvailable ? 72 : 0,
      auxiliary_judge_count: packAvailable ? 12 : 0,
      complete_judge_count: packAvailable
        ? persistedPack!.coverage.complete_judge_cases
        : 0,
      human_fallback_judge_count: packAvailable
        ? persistedPack!.coverage.human_fallback_judge_cases
        : 0,
      recorded_pack_path: recordedPackPath
        ? redactSensitiveText(recordedPackPath, sensitiveValues)
        : null,
      cleanup: cleanupSummary,
      ...(errors.length > 0
        ? {
          error: errors[0],
          errors,
        }
        : {}),
    },
  };
}

export async function executeRecordedBenchmarkCommand({
  environment,
  outputDirectory,
  dependencies,
  signal,
  lifecycleJournal,
}: ExecuteRecordedBenchmarkCommandOptions): Promise<RecordedBenchmarkOutcome> {
  let apiKey: string | null = null;
  let client: unknown;
  let expectedResources: CalibrationResourceIds | null = null;
  let cleanup: PolicyVectorStoreCleanupResult | null = null;
  let persistedPack: RecordedBenchmarkPack | null = null;
  let recordedPackPath: string | null = null;
  let coldExecutionIdentityAuthority:
    BenchmarkExecutionIdentityAuthorityReference | null = null;
  let coldPlans: readonly Readonly<{ readonly slot_identity: BenchmarkSlotIdentity }>[] | null = null;
  let cleanupReceiptPath: string | null = null;
  let cleanupReceiptPayloadSha256: string | null = null;
  let completedLifecycleReceipt: BenchmarkCompletionReceipt | null = null;
  const runtimeErrors: unknown[] = [];

  try {
    apiKey = requireOpenAiApiKey(environment);
    dependencies.assertSyntheticBenchmarkData();
    client = dependencies.createClient(apiKey);
    throwIfAborted(signal);

    let prepared: PreparedRecordedBenchmarkPolicyStore;
    try {
      prepared = await dependencies.preparePolicyStore(
        client,
        BENCHMARK_POLICIES,
        { ...(signal ? { signal } : {}) },
      );
      // 자원 handle은 다른 검증이나 실행보다 먼저 cleanup 장부에 고정합니다.
      expectedResources = resourcesFromPrepared(prepared);
    } catch (error) {
      if (error instanceof PolicyVectorStorePreparationError) {
        expectedResources = {
          vectorStoreId: error.vectorStoreId,
          uploadedFileIds: [...error.uploadedFileIds],
        };
        cleanup = error.cleanup;
      }
      throw error;
    }

    assertPreparedBenchmarkResources(prepared);
    if (lifecycleJournal) {
      const verifiedLifecycle = await lifecycleJournal.verifySource();
      completedLifecycleReceipt = verifiedLifecycle.completion_receipt;
    }
    throwIfAborted(signal);
    const schedule = dependencies.buildSchedule();
    const executionIdentity = dependencies.buildExecutionIdentity({
      preparedPolicyStore: prepared,
      schedule,
    });
    const persistedExecutionIdentity =
      await dependencies.persistExecutionIdentityAuthority({
        outputDirectory,
        executionIdentity,
      });
    if (
      typeof persistedExecutionIdentity.path !== "string"
      || typeof persistedExecutionIdentity.payloadSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(persistedExecutionIdentity.payloadSha256)
    ) {
      throw new TypeError(
        "Benchmark execution identity authority persistence path/hash 계약이 다릅니다.",
      );
    }
    coldExecutionIdentityAuthority = Object.freeze({
      path: persistedExecutionIdentity.path,
      payload_sha256: persistedExecutionIdentity.payloadSha256,
    });
    const adapterFor = dependencies.createAdapterFactory({
      client,
      preparedPolicyStore: prepared,
    });
    const plans = dependencies.buildExecutionPlans({
      executionIdentity,
      schedule,
      adapterFor,
    });
    coldPlans = Object.freeze(plans.map((plan) => Object.freeze({
      slot_identity: plan.slot_identity,
    })));
    throwIfAborted(signal);
    if (completedLifecycleReceipt !== null) {
      if (!dependencies.reloadCompletedRecordedBenchmark) {
        throw new TypeError(
          "완료된 Benchmark lifecycle에는 completion binding 기반 cold source-reload가 필요합니다.",
        );
      }
      const recovered = await dependencies.reloadCompletedRecordedBenchmark({
        outputDirectory,
        executionIdentityAuthority: coldExecutionIdentityAuthority,
        plans: coldPlans,
        completionReceipt: completedLifecycleReceipt,
      });
      if (
        typeof recovered.recordedPackPath !== "string"
        || recovered.recordedPackPath.trim().length === 0
        || sha256CanonicalJson(recovered.pack)
          !== completedLifecycleReceipt.recorded_benchmark_pack_hash
      ) {
        throw new TypeError(
          "완료된 Benchmark cold source-reload가 completion receipt와 다릅니다.",
        );
      }
      assertRecordedPackBoundary({
        pack: recovered.pack,
        auxiliaryJudgeCount: recovered.pack.coverage.judge_cases,
        completeJudgeCount: recovered.pack.coverage.complete_judge_cases,
        humanFallbackJudgeCount:
          recovered.pack.coverage.human_fallback_judge_cases,
      });
      dependencies.assertValidatedRecordedPack(recovered.pack);
      persistedPack = recovered.pack;
      recordedPackPath = recovered.recordedPackPath;
    } else {
      const executionPack = await dependencies.executeBenchmark({
        outputDirectory,
        executionIdentity,
        schedule,
        plans,
        ...(signal ? { signal } : {}),
        ...(lifecycleJournal
          ? {
            onProgress: (event) => (
              lifecycleJournal.recordCheckpoint(event).then(() => undefined)
            ),
          }
          : {}),
      });
      assertExecutionPromotionBoundary(executionPack);
      dependencies.assertValidatedExecutionPack(executionPack);
      throwIfAborted(signal);

      const promotion = await dependencies.promoteRecordedBenchmark({
        client,
        executionPack,
        executionIdentity,
        schedule,
        plans,
        outputDirectory,
        ...(signal ? { signal } : {}),
      });
      assertRecordedPackBoundary(promotion);
      dependencies.assertValidatedRecordedPack(promotion.pack);
      throwIfAborted(signal);
      recordedPackPath = await dependencies.persistRecordedPack({
        outputDirectory,
        pack: promotion.pack,
      });
      if (
        typeof recordedPackPath !== "string"
        || recordedPackPath.trim().length === 0
      ) {
        throw new TypeError(
          "Recorded Benchmark 부모 팩 persistence 경로가 비어 있습니다.",
        );
      }
      const sourceReloadedPack =
        await dependencies.loadPersistedRecordedPack({
          path: recordedPackPath,
          pack: promotion.pack,
        });
      dependencies.assertValidatedRecordedPack(sourceReloadedPack);
      if (
        sha256CanonicalJson(sourceReloadedPack)
        !== sha256CanonicalJson(promotion.pack)
      ) {
        throw new TypeError(
          "source-reload한 Recorded Benchmark Pack이 저장 요청 원본과 다릅니다.",
        );
      }
      persistedPack = sourceReloadedPack;
    }
  } catch (error) {
    runtimeErrors.push(error);
  } finally {
    if (client !== undefined && expectedResources !== null && cleanup === null) {
      try {
        cleanup = await dependencies.cleanupPolicyStore(
          client,
          expectedResources,
        );
      } catch (error) {
        runtimeErrors.push(error);
      }
    }

    const sensitiveValues = [
      ...(apiKey ? [apiKey] : []),
      ...(expectedResources?.vectorStoreId
        ? [expectedResources.vectorStoreId]
        : []),
      ...(expectedResources?.uploadedFileIds ?? []),
    ];
    let existingFinalizationArtifacts:
      BenchmarkResourceLeaseFinalizationArtifacts | null = null;
    let existingFinalizationLookupFailed = false;
    if (
      expectedResources !== null
      && dependencies.loadPolicyStoreFinalizationArtifacts
    ) {
      try {
        existingFinalizationArtifacts
          = await dependencies.loadPolicyStoreFinalizationArtifacts();
      } catch (error) {
        existingFinalizationLookupFailed = true;
        runtimeErrors.push(error);
      }
    }
    if (expectedResources !== null) {
      if (existingFinalizationArtifacts !== null) {
        cleanupReceiptPath
          = existingFinalizationArtifacts.cleanupReceipt.path;
        cleanupReceiptPayloadSha256
          = existingFinalizationArtifacts.cleanupReceipt.payloadSha256;
        const existingRecordedPack
          = existingFinalizationArtifacts.recordedPack;
        if (
          existingRecordedPack === null
          || persistedPack === null
          || recordedPackPath === null
          || resolve(existingRecordedPack.path) !== resolve(recordedPackPath)
          || existingRecordedPack.payloadSha256
            !== sha256CanonicalJson(persistedPack)
        ) {
          runtimeErrors.push(new TypeError(
            "source-reload한 completion Recorded Pack이 현재 로컬 ledger 재생 결과와 다릅니다.",
          ));
        } else {
          recordedPackPath = existingRecordedPack.path;
        }
      } else if (!existingFinalizationLookupFailed) {
        const receipt = buildCleanupReceipt({
          expectedResources,
          cleanup,
          runtimeErrors,
          sensitiveValues,
        });
        cleanupReceiptPayloadSha256 = sha256CanonicalJson(receipt);
        try {
          cleanupReceiptPath = await dependencies.persistCleanupReceipt(
            receipt,
            outputDirectory,
          );
        } catch (error) {
          runtimeErrors.push(error);
        }
      }
      if (cleanup !== null && dependencies.finalizePolicyStoreLease) {
        try {
          await dependencies.finalizePolicyStoreLease(
            cleanup,
            existingFinalizationArtifacts
              ?? (
                cleanupReceiptPath !== null
                  && cleanupReceiptPayloadSha256 !== null
                  ? {
                    cleanupReceipt: {
                      path: cleanupReceiptPath,
                      payloadSha256: cleanupReceiptPayloadSha256,
                    },
                    recordedPack:
                      persistedPack !== null && recordedPackPath !== null
                        ? {
                          path: recordedPackPath,
                          payloadSha256: sha256CanonicalJson(persistedPack),
                        }
                        : null,
                  }
                  : undefined
              ),
          );
        } catch (error) {
          runtimeErrors.push(error);
        }
      }
      if (
        lifecycleJournal
        && completedLifecycleReceipt === null
        && persistedPack !== null
        && recordedPackPath !== null
        && cleanupReceiptPath !== null
        && runtimeErrors.length === 0
      ) {
        try {
          if (
            !dependencies.loadPolicyStoreFinalizationArtifacts
            || !dependencies.loadPolicyStoreTerminalAuthority
          ) {
            throw new TypeError(
              "Benchmark COMPLETE에는 source-rebuilt resource terminal과 completion binding이 필요합니다.",
            );
          }
          const finalizationArtifacts =
            await dependencies.loadPolicyStoreFinalizationArtifacts();
          if (
            finalizationArtifacts === null
            || finalizationArtifacts.recordedPack === null
          ) {
            throw new TypeError(
              "Benchmark COMPLETE resource completion binding이 없습니다.",
            );
          }
          const resourceLeaseTerminal =
            await dependencies.loadPolicyStoreTerminalAuthority();
          await lifecycleJournal.complete({
            cleanupReceiptPath,
            recordedBenchmarkPackPath: recordedPackPath,
            recordedBenchmarkPack: persistedPack,
            resourceLeaseTerminal,
            finalizationArtifacts,
          });
        } catch (error) {
          runtimeErrors.push(error);
        }
      }
    }
  }

  const sensitiveValues = [
    ...(apiKey ? [apiKey] : []),
    ...(expectedResources?.vectorStoreId
      ? [expectedResources.vectorStoreId]
      : []),
    ...(expectedResources?.uploadedFileIds ?? []),
  ];
  return deriveOutcome({
    persistedPack,
    recordedPackPath,
    expectedResources,
    cleanup,
    cleanupReceiptPath,
    runtimeErrors,
    signal,
    sensitiveValues,
    coldReloadReference: (
      persistedPack !== null && recordedPackPath !== null
      && coldExecutionIdentityAuthority !== null && coldPlans !== null
    ) ? Object.freeze({
      outputDirectory: resolve(outputDirectory),
      recordedPackPath,
      recordedPackHash: sha256CanonicalJson(persistedPack),
      executionIdentityAuthority: coldExecutionIdentityAuthority,
      plans: coldPlans,
      privateBlindingSeedAuthority:
        createAuthoritativePrivateBlindingContextReference({
          executionPackHash: persistedPack.execution_pack_hash,
        }),
      judgeEvidencePrecommitAuthority:
        createAuthoritativeBlindingPrecommitReference({
          executionPackHash: persistedPack.execution_pack_hash,
          manifestDigest: persistedPack.precommit_manifest_digest,
          manifestHash: persistedPack.precommit_manifest_hash,
        }),
    }) : null,
  });
}

interface LockedChallengeAuthorityCoordinates {
  readonly outputDirectory: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
}

export interface ProductionRecordedBenchmarkBoundaryDependencies {
  readonly loadAuthorityRecord: (
    coordinates: LockedChallengeAuthorityCoordinates,
  ) => Promise<{ readonly pack: LockedChallengePack }>;
  readonly createCommandDependencies: (
    lockedChallengePack: LockedChallengePack,
    outputDirectory: string,
  ) => RecordedBenchmarkCommandDependencies;
  readonly openLifecycleJournal?: (
    lockedChallengePack: LockedChallengePack,
    outputDirectory: string,
  ) => Promise<BenchmarkProgressJournal>;
}

function assertLockedSyntheticBenchmarkData(): void {
  if (
    BENCHMARK_CHALLENGE.synthetic !== true
    || BENCHMARK_CHALLENGE.dataset_split !== "HIDDEN_BENCHMARK"
    || BENCHMARK_CHALLENGE.case_count !== 12
    || BENCHMARK_CHALLENGE.expected_execution_count !== 72
    || BENCHMARK_CASES.length !== 12
    || BENCHMARK_POLICIES.length !== 32
    || BENCHMARK_ORDERS.length !== 11
  ) {
    throw new TypeError(
      "production Recorded Benchmark는 잠긴 합성 12개 사례·72회 실행 데이터만 허용합니다.",
    );
  }
  assertCrossSplitSemanticTemplateIsolation();
  validateHiddenBenchmarkAccessInvariants(
    BENCHMARK_CASES,
    BENCHMARK_ORDERS,
  );
  assertCandidateProjectionDoesNotLeakEvaluatorMetadata();
}

function requireOpenAIClient(client: unknown): OpenAI {
  if (!(client instanceof OpenAI)) {
    throw new TypeError(
      "production Recorded Benchmark에는 OpenAI client가 필요합니다.",
    );
  }
  return client;
}

export function createLocalLedgerOnlyOpenAIClient(client: OpenAI): OpenAI {
  const blockedTarget = () => {
    throw new Error(
      "terminal-cleaned resource lease는 검증된 로컬 72/Judge ledger 복구에만 사용할 수 있습니다.",
    );
  };
  const blockedNamespace: unknown = new Proxy(blockedTarget, {
    get: () => blockedNamespace,
    apply: blockedTarget,
  });
  return new Proxy(client, {
    get(target, property, receiver) {
      if (
        property === "responses"
        || property === "vectorStores"
        || property === "files"
      ) {
        return blockedNamespace;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * 후보 72개 checkpoint가 이미 검증된 terminal recovery에서는 정책 자원을
 * 다시 만들거나 읽지 않고, 아직 없는 보조 Judge Responses 호출만 허용합니다.
 */
export function createJudgeOnlyPostLeaseOpenAIClient(client: OpenAI): OpenAI {
  const blockedTarget = () => {
    throw new Error(
      "terminal-cleaned Judge 복구에서는 정책 resource API를 다시 호출할 수 없습니다.",
    );
  };
  const blockedNamespace: unknown = new Proxy(blockedTarget, {
    get: () => blockedNamespace,
    apply: blockedTarget,
  });
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "vectorStores" || property === "files") {
        return blockedNamespace;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function createProductionRecordedBenchmarkDependencies(
  lockedChallengePack: LockedChallengePack,
  outputDirectory = DEFAULT_RECORDED_BENCHMARK_OUTPUT_DIRECTORY,
): RecordedBenchmarkCommandDependencies {
  // 원격 정책 자원을 만들기 전에 실제 Define/Lock authority brand를 확인합니다.
  assertAuthoritativeLockedChallengePack(lockedChallengePack);
  const resourceLease = createProductionBenchmarkResourceLeaseController({
    lockedChallengePack,
    outputDirectory,
  });
  const postLeaseClient = (client: unknown): OpenAI => {
    const openAIClient = requireOpenAIClient(client);
    return resourceLease.mode() === "TERMINAL_LOCAL_RECOVERY"
      ? createLocalLedgerOnlyOpenAIClient(openAIClient)
      : openAIClient;
  };
  const postLeaseJudgeClient = (client: unknown): OpenAI => {
    const openAIClient = requireOpenAIClient(client);
    return resourceLease.mode() === "TERMINAL_LOCAL_RECOVERY"
      ? createJudgeOnlyPostLeaseOpenAIClient(openAIClient)
      : openAIClient;
  };
  return {
    assertSyntheticBenchmarkData: assertLockedSyntheticBenchmarkData,
    createClient: (apiKey) => new OpenAI({
      apiKey,
      maxRetries: 0,
      timeout: 30_000,
    }),
    preparePolicyStore: async (client, policies, options) => {
      if (policies !== BENCHMARK_POLICIES) {
        throw new TypeError(
          "production resource lease는 잠긴 숨은 Benchmark 정책 corpus만 허용합니다.",
        );
      }
      const prepared = await resourceLease.acquire({
        client: (
          requireOpenAIClient(client) as unknown
        ) as BenchmarkResourceLeaseRemoteClient,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return Object.freeze({
        ...prepared,
        resource_scope: "RECORDED_BENCHMARK" as const,
      });
    },
    buildSchedule: () => (
      buildBenchmarkSchedule(BENCHMARK_CASES, ["A", "B", "C"])
    ),
    buildExecutionIdentity: ({ preparedPolicyStore, schedule }) => (
      buildBenchmarkExecutionIdentity({
        lockedChallengePack,
        scheduleId: schedule.schedule_id,
        policyManifestHash: preparedPolicyStore.manifestSha256,
        policyResourceIdentityHash:
          preparedPolicyStore.resourceIdentitySha256,
        policyVectorStoreId: preparedPolicyStore.vectorStoreId,
      })
    ),
    persistExecutionIdentityAuthority: ({ outputDirectory, executionIdentity }) => (
      persistBenchmarkExecutionIdentityAuthority({
        outputDirectory,
        executionIdentity,
      })
    ),
    createAdapterFactory: ({ client, preparedPolicyStore }) => (
      createBenchmarkAdapterFactory({
        client: postLeaseClient(client),
        preparedPolicyStore,
      })
    ),
    buildExecutionPlans: (input) => buildBenchmarkExecutionPlans(input),
    executeBenchmark: (input) => executeBenchmark(input),
    assertValidatedExecutionPack: (pack) => {
      assertValidatedBenchmarkExecutionPack(pack);
    },
    promoteRecordedBenchmark: (input) => promoteRecordedBenchmark({
      client: postLeaseJudgeClient(input.client),
      outputDirectory: input.outputDirectory,
      executionPack: input.executionPack,
      executionIdentity: input.executionIdentity,
      schedule: input.schedule,
      plans: input.plans,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
    assertValidatedRecordedPack: (pack) => {
      assertValidatedRecordedBenchmarkPack(pack);
    },
    persistRecordedPack: async (input) => (
      await persistRecordedBenchmarkPack(input)
    ).path,
    loadPersistedRecordedPack: ({ path, pack }) => (
      loadRecordedBenchmarkPack({
        path,
        authority: {
          benchmarkPack: pack.benchmark_execution_pack,
          judgeEvidencePack: pack.judge_evidence_pack,
          blindReviewQueue: pack.blind_review_queue,
        },
      })
    ),
    reloadCompletedRecordedBenchmark: async ({
      outputDirectory: recoveryOutputDirectory,
      executionIdentityAuthority,
      plans,
      completionReceipt,
    }) => {
      if (
        resourceLease.mode() !== "TERMINAL_LOCAL_RECOVERY"
        || resolve(recoveryOutputDirectory) !== resolve(outputDirectory)
      ) {
        throw new TypeError(
          "완료된 Benchmark 복구는 동일 output root의 terminal local resource lease만 허용합니다.",
        );
      }
      const [artifacts, terminalAuthority] = await Promise.all([
        resourceLease.completedArtifacts(),
        resourceLease.terminalAuthority(),
      ]);
      if (
        artifacts === null
        || artifacts.recordedPack === null
        || completionReceipt.cleanup.required !== 33
        || completionReceipt.cleanup.acknowledged !== 33
        || completionReceipt.cleanup.incomplete !== 0
        || completionReceipt.cleanup_receipt_hash
          !== artifacts.cleanupReceipt.payloadSha256
        || completionReceipt.recorded_benchmark_pack_hash
          !== artifacts.recordedPack.payloadSha256
        || completionReceipt.resource_lease_terminal_hash
          !== terminalAuthority.terminal_record_sha256
      ) {
        throw new TypeError(
          "Benchmark lifecycle completion receipt와 resource completion binding이 다릅니다.",
        );
      }
      const pack = await reloadCompletedRecordedBenchmarkPackForColdStart({
        outputDirectory: recoveryOutputDirectory,
        recordedPackPath: artifacts.recordedPack.path,
        recordedPackHash: artifacts.recordedPack.payloadSha256,
        executionIdentityAuthority,
        lockedChallengePack,
        plans,
      });
      return Object.freeze({
        pack,
        recordedPackPath: artifacts.recordedPack.path,
      });
    },
    cleanupPolicyStore: (client, resources) => {
      if (resourceLease.mode() === "TERMINAL_LOCAL_RECOVERY") {
        const terminalCleanup = resourceLease.terminalCleanup();
        if (terminalCleanup === null) {
          throw new TypeError(
            "terminal local recovery cleanup acknowledgement가 없습니다.",
          );
        }
        return Promise.resolve(terminalCleanup);
      }
      if (
        resources.vectorStoreId === null
        || resources.uploadedFileIds.length !== 32
      ) {
        throw new TypeError(
          "production Recorded Benchmark cleanup에는 1+32 resource binding이 필요합니다.",
        );
      }
      return resourceLease.cleanup({
        client: (
          requireOpenAIClient(client) as unknown
        ) as BenchmarkResourceLeaseRemoteClient,
      });
    },
    persistCleanupReceipt,
    finalizePolicyStoreLease: (cleanup, artifacts) => (
      resourceLease.finalizeCleanup(cleanup, artifacts)
    ),
    loadPolicyStoreFinalizationArtifacts: () => (
      resourceLease.completedArtifacts()
    ),
    loadPolicyStoreTerminalAuthority: () => (
      resourceLease.terminalAuthority()
    ),
  };
}

function readRequiredAuthorityCoordinate(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value || /\p{Cc}/u.test(value)) {
    throw new Error(
      `${name}가 없습니다. 실제 Define/Lock이 만든 authority 좌표를 설정해 주세요.`,
    );
  }
  return value;
}

function authorityCoordinates(
  environment: NodeJS.ProcessEnv,
): LockedChallengeAuthorityCoordinates {
  return {
    outputDirectory: readRequiredAuthorityCoordinate(
      environment,
      RECORDED_BENCHMARK_AUTHORITY_ENV.directory,
    ),
    challengeId: readRequiredAuthorityCoordinate(
      environment,
      RECORDED_BENCHMARK_AUTHORITY_ENV.challengeId,
    ),
    challengeVersion: readRequiredAuthorityCoordinate(
      environment,
      RECORDED_BENCHMARK_AUTHORITY_ENV.challengeVersion,
    ),
  };
}

function productionPreflightFailure(
  error: unknown,
  signal?: AbortSignal,
): RecordedBenchmarkOutcome {
  return deriveOutcome({
    persistedPack: null,
    recordedPackPath: null,
    expectedResources: null,
    cleanup: null,
    cleanupReceiptPath: null,
    runtimeErrors: [error],
    signal,
    sensitiveValues: [],
  });
}

const DEFAULT_PRODUCTION_BOUNDARIES:
ProductionRecordedBenchmarkBoundaryDependencies = {
  loadAuthorityRecord: (coordinates) => (
    loadLockedChallengeAuthorityRecord(coordinates)
  ),
  createCommandDependencies: createProductionRecordedBenchmarkDependencies,
  openLifecycleJournal: async (lockedChallengePack, outputDirectory) => {
    const schedule = buildBenchmarkSchedule(
      BENCHMARK_CASES,
      ["A", "B", "C"],
    );
    return openBenchmarkProgressJournal({
      outputDirectory,
      lockedChallengePackHash:
        lockedChallengePack.locked_challenge_pack_hash,
      hiddenDatasetHash: BENCHMARK_DATASET_HASH,
      scheduleId: schedule.schedule_id,
    });
  },
};

export async function executeProductionRecordedBenchmark(
  options: Omit<
    ExecuteRecordedBenchmarkCommandOptions,
    "dependencies"
  >,
  boundaries: ProductionRecordedBenchmarkBoundaryDependencies
    = DEFAULT_PRODUCTION_BOUNDARIES,
): Promise<RecordedBenchmarkOutcome> {
  let authorityRecord: { readonly pack: LockedChallengePack };
  try {
    const coordinates = authorityCoordinates(options.environment);
    // OpenAI client·원격 자원보다 먼저 실제 Define/Lock authority를 검증합니다.
    authorityRecord = await boundaries.loadAuthorityRecord(coordinates);
    if (options.lifecycleJournal !== undefined) {
      const schedule = buildBenchmarkSchedule(
        BENCHMARK_CASES,
        ["A", "B", "C"],
      );
      const expectedBenchmarkId = buildStableBenchmarkId({
        lockedChallengePackHash:
          authorityRecord.pack.locked_challenge_pack_hash,
        hiddenDatasetHash: BENCHMARK_DATASET_HASH,
        scheduleId: schedule.schedule_id,
      });
      if (options.lifecycleJournal.benchmarkId !== expectedBenchmarkId) {
        throw new TypeError(
          "주입된 Benchmark lifecycle journal이 잠긴 Challenge·dataset·schedule과 다릅니다.",
        );
      }
    }
  } catch (error) {
    return productionPreflightFailure(error, options.signal);
  }
  let dependencies: RecordedBenchmarkCommandDependencies;
  let lifecycleJournal: BenchmarkProgressJournal | undefined;
  try {
    // API key가 없으면 lifecycle artifact도 만들지 않습니다.
    requireOpenAiApiKey(options.environment);
    dependencies = boundaries.createCommandDependencies(
      authorityRecord.pack,
      options.outputDirectory,
    );
    lifecycleJournal = options.lifecycleJournal
      ?? await boundaries.openLifecycleJournal?.(
        authorityRecord.pack,
        options.outputDirectory,
      );
  } catch (error) {
    return productionPreflightFailure(error, options.signal);
  }
  return executeRecordedBenchmarkCommand({
    ...options,
    dependencies,
    ...(lifecycleJournal ? { lifecycleJournal } : {}),
  });
}

export interface RecordedBenchmarkProcessLike {
  readonly env: NodeJS.ProcessEnv;
  exitCode?: string | number | null;
  readonly stdin: { readonly isTTY?: boolean };
  readonly stdout: {
    readonly isTTY?: boolean;
    write(value: string): unknown;
  };
  readonly stderr: { write(value: string): unknown };
  on(event: RecordedBenchmarkSignal, listener: () => void): unknown;
  removeListener(
    event: RecordedBenchmarkSignal,
    listener: () => void,
  ): unknown;
}

interface ProcessCommandOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly outputDirectory: string;
  readonly signal?: AbortSignal;
}

type ExecuteProcessCommand = (
  options: ProcessCommandOptions,
) => Promise<RecordedBenchmarkOutcome>;

interface RunRecordedBenchmarkProcessOptions {
  readonly runtime?: RecordedBenchmarkProcessLike;
  readonly executeCommand?: ExecuteProcessCommand;
}

function resolveOutputDirectory(environment: NodeJS.ProcessEnv): string {
  const configured = environment.AI_RECORDED_BENCHMARK_OUTPUT_DIR?.trim();
  return configured
    ? resolve(configured)
    : DEFAULT_RECORDED_BENCHMARK_OUTPUT_DIRECTORY;
}

function acknowledgementGuardMessage(): string {
  return [
    "Recorded Benchmark는 대화형 TTY에서만 실행할 수 있습니다.",
    `${RECORDED_BENCHMARK_ACKNOWLEDGEMENT_ENV}=`,
    RECORDED_BENCHMARK_ACKNOWLEDGEMENT,
    "를 정확히 설정해 72회 후보 실행과 12개 보조 Judge 호출을 확인해 주세요.",
  ].join("");
}

export async function runRecordedBenchmarkProcess({
  runtime = process,
  executeCommand = executeProductionRecordedBenchmark,
}: RunRecordedBenchmarkProcessOptions = {}): Promise<
  RecordedBenchmarkOutcome | null
> {
  if (
    runtime.stdin.isTTY !== true
    || runtime.stdout.isTTY !== true
    || runtime.env[RECORDED_BENCHMARK_ACKNOWLEDGEMENT_ENV]
      !== RECORDED_BENCHMARK_ACKNOWLEDGEMENT
  ) {
    runtime.stderr.write(`${acknowledgementGuardMessage()}\n`);
    runtime.exitCode = 1;
    return null;
  }
  const controller = new AbortController();
  const interrupt = (signalName: RecordedBenchmarkSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(new RecordedBenchmarkInterruptionError(signalName));
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
    if (
      outcome.summary.review_status === "REVIEW_PENDING"
      && outcome.summary.evaluation_status === "EVALUATION_INCOMPLETE"
    ) {
      runtime.stdout.write(
        "RECORDED_BENCHMARK · REVIEW_PENDING · EVALUATION_INCOMPLETE"
        + " — 사람 검수가 필요하며 평가는 완료되지 않았습니다.\n",
      );
    }
    runtime.exitCode = outcome.exitCode;
    return outcome;
  } catch {
    // 원문 오류에는 API key나 원격 resource ID가 포함될 수 있습니다.
    runtime.stderr.write(
      "Recorded Benchmark command가 예상 밖 오류로 종료됐습니다.\n",
    );
    const interruption = controller.signal.reason;
    runtime.exitCode = interruption instanceof RecordedBenchmarkInterruptionError
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
  void runRecordedBenchmarkProcess();
}

import { createCandidateAAdapter } from "../openai/candidateAAdapter";
import {
  createCandidateBAdapter,
  type CandidateBClientLike,
} from "../openai/candidateBAdapter";
import {
  createCandidateCAdapter,
  type CandidateCClientLike,
} from "../openai/candidateCAdapter";
import {
  buildCandidateFacingOrder,
  buildCandidateFacingPolicies,
} from "../data/syntheticCalibration";
import {
  cleanupPolicyVectorStore,
  preparePolicyVectorStore,
  type PolicyDocument,
  type PolicyVectorStoreCleanupResult,
  type PolicyVectorStoreClientLike,
  type PreparedPolicyVectorStore,
  type PrivatePolicyVectorStorePreparationEvent,
} from "../retrieval/policyVectorStore";
import {
  CandidateProgressObserverError,
  emitCandidateProgress,
  type CandidateProgressObserver,
  type PrivateCandidateProgressCapturedEvidence,
} from "../runner/progress";
import { runCandidateOnce } from "../runner/runCandidate";
import type {
  CandidateAdapter,
  CandidateRunRecord,
} from "../runner/types";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  calculateUsageCost,
  type TokenUsage,
} from "../runtime/pricing";
import {
  CALIBRATION_CASE,
  CALIBRATION_ORDERS,
  CALIBRATION_POLICIES,
  CALIBRATION_PRICING,
  CANDIDATE_CONFIGS,
  CANDIDATE_IDS,
  assertLockedSyntheticCalibrationData,
  buildCandidateInvocation,
  type CalibrationCandidateId,
} from "../smoke/candidateDefinitions";
import {
  buildCleanupReceipt,
  isCleanupReceiptAcknowledged,
  type CleanupReceipt,
  type CleanupResourceIds,
} from "./liveCleanupReceipt";
import {
  buildLiveSingleRunPack,
  type LiveSingleRunPack,
} from "./liveSingleRunPack";
import {
  buildLiveSyntheticDemoProjection,
  type LiveSyntheticDemoProjection,
} from "./liveSyntheticDemoProjection";

export type LiveComparisonArtifactNamespace =
  | "live-evaluation-packs"
  | "candidate-evidence"
  | "errors"
  | "cleanup-receipts";

export interface LiveComparisonArtifactReference {
  readonly namespace: LiveComparisonArtifactNamespace;
  readonly objectKey: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface LiveComparisonArtifactStore {
  putContentAddressed(input: {
    readonly namespace: LiveComparisonArtifactNamespace;
    readonly canonicalBytes: Uint8Array;
    readonly sha256: string;
  }): Promise<LiveComparisonArtifactReference>;
}

interface PrepareLivePolicyStoreOptions {
  readonly signal?: AbortSignal;
  readonly onPreparationEvent?: (
    event: PrivatePolicyVectorStorePreparationEvent,
  ) => void | Promise<void>;
  readonly onProgress?: CandidateProgressObserver;
}

export interface LiveComparisonDependencies {
  readonly assertSyntheticData: () => void;
  readonly preparePolicyStore: (
    options: PrepareLivePolicyStoreOptions,
  ) => Promise<PreparedPolicyVectorStore>;
  readonly createAdapters: (
    prepared: PreparedPolicyVectorStore,
  ) => {
    readonly A: CandidateAdapter;
    readonly B: CandidateAdapter;
    readonly C: CandidateAdapter;
  };
  readonly runCandidate: (input: {
    readonly runNumber: 1;
    readonly adapter: CandidateAdapter;
    readonly invocation: ReturnType<typeof buildCandidateInvocation>;
    readonly now?: () => number;
    readonly signal?: AbortSignal;
    readonly onProgress?: CandidateProgressObserver;
  }) => Promise<CandidateRunRecord>;
  readonly cleanupPolicyStore: (
    resources: CleanupResourceIds,
  ) => Promise<PolicyVectorStoreCleanupResult>;
}

export interface LiveComparisonPrivateFailureEvidence {
  readonly schema_version: "live-comparison-private-failure-v1";
  readonly artifact_kind: "LIVE_COMPARISON_PRIVATE_FAILURE";
  readonly created_at: string;
  readonly source_pack_sha256: string | null;
  readonly error_name: string;
  readonly error_message: string;
  readonly captured_evidence: PrivateCandidateProgressCapturedEvidence | null;
}

export interface LiveComparisonResult {
  readonly status: "RESULTS_READY" | "FAILED_PLATFORM" | "FAILED_CLEANUP";
  readonly judgeEligible: boolean;
  readonly errorCode: "FAILED_PLATFORM" | "FAILED_CLEANUP" | null;
  readonly pack: LiveSingleRunPack | null;
  readonly projection: LiveSyntheticDemoProjection | null;
  readonly packReference: LiveComparisonArtifactReference | null;
  readonly privateFailureEvidence: LiveComparisonPrivateFailureEvidence | null;
  readonly privateFailureReference: LiveComparisonArtifactReference | null;
  readonly cleanupReceipt: CleanupReceipt | null;
  readonly cleanupReceiptReference: LiveComparisonArtifactReference | null;
  readonly actualCostUsd: number;
}

export interface ExecuteLiveComparisonOptions {
  readonly dependencies: LiveComparisonDependencies;
  readonly artifactStore: LiveComparisonArtifactStore;
  readonly createdAt?: string;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly onProgress?: CandidateProgressObserver;
  /**
   * 원격 ID를 브라우저로 보내지 않고 서버 저장소에 먼저 기록하는 private 경계입니다.
   */
  readonly onPreparationEvent?: (
    event: PrivatePolicyVectorStorePreparationEvent,
  ) => void | Promise<void>;
}

interface StructuralPreparationError {
  readonly name: "PolicyVectorStorePreparationError";
  readonly vectorStoreId: string | null;
  readonly uploadedFileIds: readonly string[];
  readonly cleanup: PolicyVectorStoreCleanupResult;
}

type LiveOpenAiClient = CandidateBClientLike
  & CandidateCClientLike
  & PolicyVectorStoreClientLike;

const EMPTY_RESOURCES: CleanupResourceIds = Object.freeze({
  vectorStoreId: null,
  uploadedFileIds: [],
});

function isStructuralPreparationError(
  error: unknown,
): error is StructuralPreparationError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Partial<StructuralPreparationError>;
  return candidate.name === "PolicyVectorStorePreparationError"
    && (typeof candidate.vectorStoreId === "string" || candidate.vectorStoreId === null)
    && Array.isArray(candidate.uploadedFileIds)
    && candidate.uploadedFileIds.every((id) => typeof id === "string")
    && typeof candidate.cleanup === "object"
    && candidate.cleanup !== null;
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name.trim().length > 0
    ? error.name
    : "UnknownError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "알 수 없는 라이브 비교 플랫폼 오류";
}

function capturedEvidence(
  error: unknown,
): PrivateCandidateProgressCapturedEvidence | null {
  return error instanceof CandidateProgressObserverError
    && error.capturedEvidence !== undefined
    ? structuredClone(error.capturedEvidence)
    : null;
}

function contentAddressedInput(
  namespace: LiveComparisonArtifactNamespace,
  value: unknown,
): Parameters<LiveComparisonArtifactStore["putContentAddressed"]>[0] {
  const canonical = canonicalJsonStringify(value);
  return {
    namespace,
    canonicalBytes: new TextEncoder().encode(canonical),
    sha256: sha256CanonicalJson(value),
  };
}

async function persistArtifact(
  artifactStore: LiveComparisonArtifactStore,
  namespace: LiveComparisonArtifactNamespace,
  value: unknown,
): Promise<LiveComparisonArtifactReference> {
  return artifactStore.putContentAddressed(
    contentAddressedInput(namespace, value),
  );
}

function resourcesFromPrepared(
  prepared: PreparedPolicyVectorStore,
): CleanupResourceIds {
  return {
    vectorStoreId: prepared.vectorStoreId,
    uploadedFileIds: [...prepared.uploadedFileIds],
  };
}

function updateResources(
  current: CleanupResourceIds,
  event: PrivatePolicyVectorStorePreparationEvent,
): CleanupResourceIds {
  const vectorStoreId = event.vectorStoreId;
  const uploadedFileIds = event.kind === "UPLOADED_FILE_CREATED"
    ? [...new Set([...current.uploadedFileIds, event.file.uploadedFileId])]
    : [...current.uploadedFileIds];
  return { vectorStoreId, uploadedFileIds };
}

function usageFromRuns(
  runs: ReadonlyMap<CalibrationCandidateId, CandidateRunRecord>,
  privateCapturedEvidence: PrivateCandidateProgressCapturedEvidence | null,
): readonly (TokenUsage | null | undefined)[] {
  return [
    ...[...runs.values()].flatMap((run) =>
      run.attempts.map((attempt) => attempt.usage)),
    privateCapturedEvidence?.usage,
  ];
}

function buildPrivateFailureEvidence(
  error: unknown,
  createdAt: string,
  pack: LiveSingleRunPack | null,
): LiveComparisonPrivateFailureEvidence {
  return {
    schema_version: "live-comparison-private-failure-v1",
    artifact_kind: "LIVE_COMPARISON_PRIVATE_FAILURE",
    created_at: createdAt,
    source_pack_sha256: pack === null ? null : sha256CanonicalJson(pack),
    error_name: errorName(error),
    error_message: errorMessage(error),
    captured_evidence: capturedEvidence(error),
  };
}

async function emitCleanupProgress(
  observer: CandidateProgressObserver | undefined,
  event: { readonly kind: "REMOTE_CLEANUP_STARTED" | "REMOTE_CLEANUP_FINISHED" },
  runtimeErrors: unknown[],
): Promise<void> {
  try {
    await emitCandidateProgress(observer, event);
  } catch (error) {
    runtimeErrors.push(error);
  }
}

async function persistFailureBestEffort(
  artifactStore: LiveComparisonArtifactStore,
  evidence: LiveComparisonPrivateFailureEvidence,
  runtimeErrors: unknown[],
): Promise<LiveComparisonArtifactReference | null> {
  try {
    return await persistArtifact(artifactStore, "errors", evidence);
  } catch (error) {
    runtimeErrors.push(error);
    return null;
  }
}

/**
 * 한 잠긴 합성 사례의 A/B/C 라이브 비교를 수행합니다.
 *
 * 후보 출력 실패는 평가 결과로 계속 진행하지만, 진행 상태 저장·팩 저장 같은
 * 플랫폼 실패는 Judge 자격을 차단하고 비공개 오류 증거와 정리 영수증을 남깁니다.
 */
export async function executeLiveComparison({
  dependencies,
  artifactStore,
  createdAt = new Date().toISOString(),
  now,
  signal,
  onProgress,
  onPreparationEvent,
}: ExecuteLiveComparisonOptions): Promise<LiveComparisonResult> {
  let expectedResources: CleanupResourceIds = structuredClone(EMPTY_RESOURCES);
  let prepared: PreparedPolicyVectorStore | null = null;
  let cleanup: PolicyVectorStoreCleanupResult | null = null;
  let cleanupAlreadyAttempted = false;
  let pack: LiveSingleRunPack | null = null;
  let projection: LiveSyntheticDemoProjection | null = null;
  let packReference: LiveComparisonArtifactReference | null = null;
  let privateFailureEvidence: LiveComparisonPrivateFailureEvidence | null = null;
  let privateFailureReference: LiveComparisonArtifactReference | null = null;
  let cleanupReceipt: CleanupReceipt | null = null;
  let cleanupReceiptReference: LiveComparisonArtifactReference | null = null;
  let primaryPlatformError: unknown = null;
  let cleanupError: unknown = null;
  const runtimeErrors: unknown[] = [];
  const runs = new Map<CalibrationCandidateId, CandidateRunRecord>();

  try {
    dependencies.assertSyntheticData();
    prepared = await dependencies.preparePolicyStore({
      ...(signal ? { signal } : {}),
      ...(onProgress ? { onProgress } : {}),
      onPreparationEvent: async (event) => {
        expectedResources = updateResources(expectedResources, event);
        await onPreparationEvent?.(structuredClone(event));
      },
    });
    expectedResources = resourcesFromPrepared(prepared);

    const adapters = dependencies.createAdapters(prepared);
    for (const candidateId of CANDIDATE_IDS) {
      const run = await dependencies.runCandidate({
        runNumber: 1,
        adapter: adapters[candidateId],
        invocation: buildCandidateInvocation(candidateId),
        ...(now ? { now } : {}),
        ...(signal ? { signal } : {}),
        ...(onProgress ? { onProgress } : {}),
      });
      runs.set(candidateId, run);
    }

    await emitCandidateProgress(onProgress, { kind: "HARD_GATES_STARTED" });
    pack = buildLiveSingleRunPack({
      createdAt,
      entries: CANDIDATE_IDS.map((candidateId) => ({
        candidateId,
        run: runs.get(candidateId)!,
      })),
    });
    projection = buildLiveSyntheticDemoProjection(pack);
    await emitCandidateProgress(onProgress, { kind: "HARD_GATES_FINISHED" });
    await emitCandidateProgress(onProgress, { kind: "RESULTS_PERSISTING" });
    packReference = await persistArtifact(
      artifactStore,
      "live-evaluation-packs",
      pack,
    );
    await emitCandidateProgress(onProgress, { kind: "RESULTS_PERSISTED" });
  } catch (error) {
    primaryPlatformError = error;
    runtimeErrors.push(error);
    if (isStructuralPreparationError(error)) {
      expectedResources = {
        vectorStoreId: error.vectorStoreId,
        uploadedFileIds: [...error.uploadedFileIds],
      };
      cleanup = structuredClone(error.cleanup);
      cleanupAlreadyAttempted = true;
    }
    privateFailureEvidence = buildPrivateFailureEvidence(error, createdAt, pack);
    privateFailureReference = await persistFailureBestEffort(
      artifactStore,
      privateFailureEvidence,
      runtimeErrors,
    );
  }

  if (
    !cleanupAlreadyAttempted
    && (
      prepared !== null
      || expectedResources.vectorStoreId !== null
      || expectedResources.uploadedFileIds.length > 0
    )
  ) {
    await emitCleanupProgress(
      onProgress,
      { kind: "REMOTE_CLEANUP_STARTED" },
      runtimeErrors,
    );
    try {
      cleanup = await dependencies.cleanupPolicyStore(expectedResources);
    } catch (error) {
      cleanupError = error;
      runtimeErrors.push(error);
    }
    await emitCleanupProgress(
      onProgress,
      { kind: "REMOTE_CLEANUP_FINISHED" },
      runtimeErrors,
    );
  }

  const hasExpectedRemoteResources = expectedResources.vectorStoreId !== null
    || expectedResources.uploadedFileIds.length > 0;
  if (hasExpectedRemoteResources) {
    cleanupReceipt = buildCleanupReceipt({
      expectedResources,
      cleanup,
      runtimeErrors,
      createdAt,
    });
  }

  const cleanupAcknowledged = cleanupReceipt === null
    ? !hasExpectedRemoteResources
    : isCleanupReceiptAcknowledged(cleanupReceipt);
  if (primaryPlatformError === null && cleanupError !== null) {
    privateFailureEvidence = buildPrivateFailureEvidence(
      cleanupError,
      createdAt,
      pack,
    );
    privateFailureReference = await persistFailureBestEffort(
      artifactStore,
      privateFailureEvidence,
      runtimeErrors,
    );
  }
  const nonCleanupPlatformError = runtimeErrors.find(
    (error) => error !== primaryPlatformError && error !== cleanupError,
  );
  if (
    primaryPlatformError === null
    && nonCleanupPlatformError !== undefined
  ) {
    primaryPlatformError = nonCleanupPlatformError;
    privateFailureEvidence = buildPrivateFailureEvidence(
      nonCleanupPlatformError,
      createdAt,
      pack,
    );
    privateFailureReference = await persistFailureBestEffort(
      artifactStore,
      privateFailureEvidence,
      runtimeErrors,
    );
  }

  if (cleanupReceipt !== null) {
    try {
      cleanupReceiptReference = await persistArtifact(
        artifactStore,
        "cleanup-receipts",
        cleanupReceipt,
      );
    } catch (error) {
      runtimeErrors.push(error);
      if (primaryPlatformError === null) {
        primaryPlatformError = error;
        privateFailureEvidence = buildPrivateFailureEvidence(error, createdAt, pack);
        privateFailureReference = await persistFailureBestEffort(
          artifactStore,
          privateFailureEvidence,
          runtimeErrors,
        );
      }
    }
  }

  const actualCostUsd = calculateUsageCost(
    usageFromRuns(
      runs,
      privateFailureEvidence?.captured_evidence ?? null,
    ),
    CALIBRATION_PRICING,
  )?.totalCostUsd ?? 0;
  const failedCleanup = !cleanupAcknowledged;
  const status = primaryPlatformError !== null
    ? "FAILED_PLATFORM"
    : failedCleanup
      ? "FAILED_CLEANUP"
      : "RESULTS_READY";
  const errorCode = status === "RESULTS_READY" ? null : status;
  const judgeEligible = status === "RESULTS_READY"
    && pack !== null
    && projection !== null
    && packReference !== null
    && (!hasExpectedRemoteResources || cleanupReceiptReference !== null);

  return {
    status,
    judgeEligible,
    errorCode,
    pack,
    projection,
    packReference,
    privateFailureEvidence,
    privateFailureReference,
    cleanupReceipt,
    cleanupReceiptReference,
    actualCostUsd,
  };
}

/**
 * Worker와 로컬 서버가 같은 라이브 실행 계약을 사용하기 위한 실제 provider 조립 함수입니다.
 * 비밀키나 client 생성은 이 경계 밖의 서버 환경이 소유합니다.
 */
export function createLiveComparisonDependencies(
  client: LiveOpenAiClient,
): LiveComparisonDependencies {
  return {
    assertSyntheticData: assertLockedSyntheticCalibrationData,
    preparePolicyStore: (options) => preparePolicyVectorStore(
      client,
      buildCandidateFacingPolicies(CALIBRATION_POLICIES) as PolicyDocument[],
      options,
    ),
    createAdapters: (prepared) => ({
      A: createCandidateAAdapter(client),
      B: createCandidateBAdapter(client, {
        vectorStoreId: prepared.vectorStoreId,
        manifest: prepared.files,
        query: CANDIDATE_CONFIGS.B.retrieval_query!,
        maxNumResults: 2,
      }),
      C: createCandidateCAdapter(client, {
        vectorStoreId: prepared.vectorStoreId,
        manifest: prepared.files,
        lockedAsOf: CALIBRATION_CASE.as_of,
        orders: CALIBRATION_ORDERS.map((order) =>
          buildCandidateFacingOrder(order)),
        maxNumResults: 2,
      }),
    }),
    runCandidate: (input) => runCandidateOnce(input),
    cleanupPolicyStore: (resources) =>
      cleanupPolicyVectorStore(client, resources),
  };
}

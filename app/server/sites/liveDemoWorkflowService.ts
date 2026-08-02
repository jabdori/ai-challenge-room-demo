import type {
  CandidateProgressObserver,
  CandidateProgressEvent,
} from "../../eval/runner/progress";
import type {
  LiveComparisonArtifactStore,
  LiveComparisonResult,
} from "../../eval/demo/executeLiveComparison";
import type {
  RecordedSyntheticDemoProjection,
} from "../../eval/demo/recordedSyntheticDemo";
import type {
  ConfirmDemoReviewInput,
  CreateDemoMemoInput,
  DemoMemoAdapterLike,
  DemoRiskAdapterLike,
} from "../hackathonDemoController";
import {
  applyDemoJudgeResult,
  applyDemoMemoFailure,
  applyDemoMemoSuccess,
  applyDemoReview,
  applyDemoSelection,
  buildDemoBlindJudgeInput,
  buildDemoDecisionMemoInput,
  createInitialDemoState,
  replayDemoRepresentativeDefect,
  validateDemoReview,
  validateDemoSelection,
  type DemoSourceProjection,
} from "../hackathonDemoController";
import type {
  DemoArtifactReference,
  DemoArtifactStore,
  DemoCandidateSelectionRecord,
  DemoDecisionMemoRecord,
  DemoExecutionRecord,
  DemoHumanReviewRecord,
  DemoStateRepository,
} from "./demoContracts";
import type {
  DemoExecutionClaimOptions,
  DemoExecutionCostReconciliation,
} from "./d1DemoStateRepository";
import type {
  DemoBlindLabel,
  HackathonDemoState,
} from "../../shared/hackathonDemo";
import {
  parseHackathonDemoState,
} from "../../shared/hackathonDemo";
import {
  CALIBRATION_CASE,
} from "../../eval/smoke/candidateDefinitions";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../../eval/runtime/canonicalJson";
import {
  assertPublicDemoProjection,
} from "./publicProjectionGuard";

export interface LiveDemoChallengeView {
  readonly schema_version: "live-demo-challenge-v1";
  readonly synthetic: true;
  readonly locked: true;
  readonly case_id: string;
  readonly as_of: string;
  readonly ticket: string;
  readonly candidates: readonly ["A", "B", "C"];
  readonly runs_per_candidate: 1;
  readonly external_action_statement:
    "No purchase, contract, deployment, or rollback was executed.";
}

export interface LiveDemoExecutionView {
  readonly schema_version: "live-demo-execution-v1";
  readonly execution_id: string;
  readonly source: DemoExecutionRecord["source"];
  readonly status: DemoExecutionRecord["status"];
  readonly progress_step: string;
  readonly current_candidate: DemoExecutionRecord["currentCandidate"];
  readonly completed_candidate_count: number;
  readonly created_at_ms: number;
  readonly started_at_ms: number | null;
  readonly heartbeat_at_ms: number | null;
  readonly completed_at_ms: number | null;
  readonly retry_count: number;
  readonly error_code: string | null;
  readonly cleanup_status: DemoExecutionRecord["cleanupStatus"];
  readonly actual_cost_micro_usd: number;
  readonly artifacts: {
    readonly evaluation_pack_persisted: boolean;
    readonly public_projection_persisted: boolean;
    readonly cleanup_receipt_persisted: boolean;
  };
}

export interface LiveDemoEvidenceView {
  readonly case_id: string;
  readonly blind_label: DemoBlindLabel;
  readonly runs: HackathonDemoState["blind_review"]["candidates"][number]["runs"];
  readonly judge_risk:
    | NonNullable<HackathonDemoState["judge"]>["risks"][number]
    | null;
}

export interface LiveDemoWorkflowRepository extends DemoStateRepository {
  interruptStaleExecutions(input: {
    readonly nowMs: number;
    readonly staleBeforeMs: number;
  }): Promise<number>;
  claimExecution(
    input: DemoExecutionClaimOptions,
  ): Promise<DemoExecutionRecord | null>;
  reconcileExecutionCost(
    input: DemoExecutionCostReconciliation,
  ): Promise<boolean>;
}

export interface LiveComparisonRunnerInput {
  readonly artifactStore: LiveComparisonArtifactStore;
  readonly createdAt: string;
  readonly now: () => number;
  readonly onProgress: CandidateProgressObserver;
}

export type LiveComparisonRunner = (
  input: LiveComparisonRunnerInput,
) => Promise<LiveComparisonResult>;

export type LiveDemoWorkflowErrorCode =
  | "EXECUTION_NOT_FOUND"
  | "EXECUTION_NOT_OWNED"
  | "INVALID_STATE"
  | "DUPLICATE_RUN"
  | "LIVE_RESULTS_REQUIRED"
  | "RUN_CAP_REACHED"
  | "ARTIFACT_UNAVAILABLE"
  | "STALE_EXECUTION";

export class LiveDemoWorkflowError extends Error {
  readonly code: LiveDemoWorkflowErrorCode;
  readonly status: number;

  constructor(code: LiveDemoWorkflowErrorCode, status: number) {
    super(code);
    this.name = "LiveDemoWorkflowError";
    this.code = code;
    this.status = status;
  }
}

export interface LiveDemoWorkflowService {
  getChallenge(): LiveDemoChallengeView;
  createLiveComparison(input: {
    readonly sessionTokenDigest: string;
    readonly idempotencyKey: string;
  }): Promise<LiveDemoExecutionView>;
  runComparison(input: {
    readonly sessionTokenDigest: string;
    readonly executionId: string;
  }): Promise<LiveDemoExecutionView>;
  getCurrentExecution(
    sessionTokenDigest: string,
  ): Promise<LiveDemoExecutionView | null>;
  getExecution(input: {
    readonly sessionTokenDigest: string;
    readonly executionId: string;
  }): Promise<LiveDemoExecutionView>;
  getResults(input: {
    readonly sessionTokenDigest: string;
    readonly executionId: string;
  }): Promise<HackathonDemoState>;
  runJudge(input: {
    readonly sessionTokenDigest: string;
    readonly executionId: string;
  }): Promise<HackathonDemoState>;
  getEvidence(input: {
    readonly sessionTokenDigest: string;
    readonly executionId: string;
    readonly blindLabel: DemoBlindLabel;
  }): Promise<LiveDemoEvidenceView>;
  confirmReviews(input: {
    readonly sessionTokenDigest: string;
    readonly executionId: string;
    readonly review: ConfirmDemoReviewInput;
  }): Promise<HackathonDemoState>;
  selectCandidate(input: {
    readonly sessionTokenDigest: string;
    readonly executionId: string;
    readonly selection: CreateDemoMemoInput;
  }): Promise<HackathonDemoState>;
  createDecisionMemo(input: {
    readonly sessionTokenDigest: string;
    readonly executionId: string;
  }): Promise<HackathonDemoState>;
  replayRegression(input: {
    readonly sessionTokenDigest: string;
    readonly executionId: string;
  }): Promise<HackathonDemoState>;
  selectRecordedFallback(input: {
    readonly sessionTokenDigest: string;
  }): Promise<{
    readonly execution: LiveDemoExecutionView;
    readonly state: HackathonDemoState;
  }>;
}

export interface LiveDemoWorkflowServiceOptions {
  readonly repository: LiveDemoWorkflowRepository;
  readonly artifactStore: DemoArtifactStore;
  readonly runLiveComparison: LiveComparisonRunner;
  readonly riskAdapter: DemoRiskAdapterLike;
  readonly memoAdapter: DemoMemoAdapterLike;
  readonly recordedProjection: RecordedSyntheticDemoProjection;
  readonly now?: () => number;
  readonly executionId?: () => string;
  readonly token?: () => string;
  readonly leaseDurationMs?: number;
  readonly reservedCostMicroUsd?: number;
  readonly maxSuccessfulRunsPerSession?: number;
  readonly maxOperationalRetriesPerSession?: number;
  readonly maxGlobalConcurrentRuns?: number;
  readonly maxBucketRunCount?: number;
  readonly maxBucketCostMicroUsd?: number;
  readonly maxAuxiliaryCallsPerBucket?: number;
}

export function createLiveDemoWorkflowService(
  options: LiveDemoWorkflowServiceOptions,
): LiveDemoWorkflowService {
  const now = options.now ?? Date.now;
  const executionId = options.executionId ?? (() => (
    `cmp_${crypto.randomUUID().replaceAll("-", "")}`
  ));
  const token = options.token ?? (() => crypto.randomUUID());
  const leaseDurationMs = options.leaseDurationMs ?? 5 * 60_000;
  const reservedCostMicroUsd = options.reservedCostMicroUsd ?? 250_000;
  const maxSuccessfulRunsPerSession =
    options.maxSuccessfulRunsPerSession ?? 1;
  const maxOperationalRetriesPerSession =
    options.maxOperationalRetriesPerSession ?? 1;
  const maxGlobalConcurrentRuns = options.maxGlobalConcurrentRuns ?? 1;
  const maxBucketRunCount = options.maxBucketRunCount ?? 25;
  const maxBucketCostMicroUsd = options.maxBucketCostMicroUsd ?? 5_000_000;
  const maxAuxiliaryCallsPerBucket =
    options.maxAuxiliaryCallsPerBucket ?? 25;
  if (
    !Number.isSafeInteger(maxAuxiliaryCallsPerBucket)
    || maxAuxiliaryCallsPerBucket < 1
  ) {
    throw new TypeError(
      "전역 보조 API 호출 시도 횟수 상한은 1 이상의 안전한 정수여야 합니다.",
    );
  }
  const liveArtifactStore: LiveComparisonArtifactStore = {
    async putContentAddressed(input) {
      const reference = await options.artifactStore.putContentAddressed(input);
      return {
        ...reference,
        namespace: input.namespace,
      };
    },
  };

  const challenge = Object.freeze({
    schema_version: "live-demo-challenge-v1",
    synthetic: true,
    locked: true,
    case_id: CALIBRATION_CASE.case_id,
    as_of: CALIBRATION_CASE.as_of,
    ticket: CALIBRATION_CASE.ticket_messages
      .map((message) => message.content)
      .join("\n"),
    candidates: ["A", "B", "C"],
    runs_per_candidate: 1,
    external_action_statement:
      "No purchase, contract, deployment, or rollback was executed.",
  } as const satisfies LiveDemoChallengeView);

  function workflowError(
    code: LiveDemoWorkflowErrorCode,
    status: number,
  ): LiveDemoWorkflowError {
    return new LiveDemoWorkflowError(code, status);
  }

  function digestToken(purpose: string, value: string): string {
    return sha256CanonicalJson({
      schema_version: "live-demo-private-token-digest-v1",
      purpose,
      value,
    });
  }

  function budgetBucket(nowMs: number): number {
    return Math.floor(nowMs / 3_600_000) * 3_600_000;
  }

  async function interruptExpiredExecutions(): Promise<void> {
    const observedAtMs = now();
    await options.repository.interruptStaleExecutions({
      nowMs: observedAtMs,
      staleBeforeMs: Math.max(0, observedAtMs - leaseDurationMs),
    });
  }

  function usdToMicroUsd(value: number): number {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError("실제 실행 비용은 0 이상의 유한한 숫자여야 합니다.");
    }
    const microUsd = Math.round(value * 1_000_000);
    if (!Number.isSafeInteger(microUsd)) {
      throw new TypeError("실제 실행 비용이 안전한 정수 범위를 벗어났습니다.");
    }
    return microUsd;
  }

  function executionView(record: DemoExecutionRecord): LiveDemoExecutionView {
    return assertPublicDemoProjection({
      schema_version: "live-demo-execution-v1",
      execution_id: record.executionId,
      source: record.source,
      status: record.status,
      progress_step: record.progressStep,
      current_candidate: record.currentCandidate,
      completed_candidate_count: record.completedCandidateCount,
      created_at_ms: record.createdAtMs,
      started_at_ms: record.startedAtMs,
      heartbeat_at_ms: record.heartbeatAtMs,
      completed_at_ms: record.completedAtMs,
      retry_count: record.retryCount,
      error_code: record.errorCode,
      cleanup_status: record.cleanupStatus,
      actual_cost_micro_usd: record.actualCostMicroUsd,
      artifacts: {
        evaluation_pack_persisted:
          record.evaluationPackReference !== null,
        public_projection_persisted:
          record.publicProjectionReference !== null,
        cleanup_receipt_persisted:
          record.cleanupReceiptReference !== null,
      },
    } as const);
  }

  async function requireOwnedExecution(
    requestedExecutionId: string,
    sessionTokenDigest: string,
  ): Promise<DemoExecutionRecord> {
    const owned = await options.repository.readOwnedExecution(
      requestedExecutionId,
      sessionTokenDigest,
    );
    if (owned) return owned;
    const existing = await options.repository.readExecution(
      requestedExecutionId,
    );
    throw existing
      ? workflowError("EXECUTION_NOT_OWNED", 404)
      : workflowError("EXECUTION_NOT_FOUND", 404);
  }

  async function requireCurrentMutableExecution(
    requestedExecutionId: string,
    sessionTokenDigest: string,
  ): Promise<DemoExecutionRecord> {
    const record = await requireOwnedExecution(
      requestedExecutionId,
      sessionTokenDigest,
    );
    const session = await options.repository.readSession(sessionTokenDigest);
    if (session?.currentExecutionId !== requestedExecutionId) {
      throw workflowError("INVALID_STATE", 409);
    }
    return record;
  }

  interface StoredDemoSnapshot {
    readonly schema_version: "live-demo-server-snapshot-v1";
    readonly state: HackathonDemoState;
    readonly source_projection: DemoSourceProjection;
  }

  async function persistValue(
    namespace: DemoArtifactReference["namespace"],
    value: unknown,
  ): Promise<DemoArtifactReference> {
    const canonical = canonicalJsonStringify(value);
    return options.artifactStore.putContentAddressed({
      namespace,
      canonicalBytes: new TextEncoder().encode(canonical),
      sha256: sha256CanonicalJson(value),
    });
  }

  async function persistSnapshot(
    state: HackathonDemoState,
    sourceProjection: DemoSourceProjection,
  ): Promise<DemoArtifactReference> {
    const snapshot = {
      schema_version: "live-demo-server-snapshot-v1",
      state: assertPublicDemoProjection(structuredClone(state)),
      source_projection: assertPublicDemoProjection(
        structuredClone(sourceProjection),
      ),
    } as const satisfies StoredDemoSnapshot;
    assertPublicDemoProjection(snapshot);
    return persistValue("candidate-evidence", snapshot);
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object"
      && value !== null
      && !Array.isArray(value);
  }

  async function loadSnapshot(
    record: DemoExecutionRecord,
  ): Promise<StoredDemoSnapshot> {
    const reference = record.publicProjectionReference;
    if (!reference) {
      throw workflowError("ARTIFACT_UNAVAILABLE", 409);
    }
    let bytes: Uint8Array;
    try {
      bytes = await options.artifactStore.getVerified(reference);
    } catch {
      throw workflowError("ARTIFACT_UNAVAILABLE", 409);
    }
    let raw: unknown;
    try {
      const text = new TextDecoder().decode(bytes);
      raw = JSON.parse(text) as unknown;
      if (
        canonicalJsonStringify(raw) !== text
        || sha256CanonicalJson(raw) !== reference.sha256
      ) {
        throw new Error("SNAPSHOT_HASH_MISMATCH");
      }
    } catch {
      throw workflowError("ARTIFACT_UNAVAILABLE", 409);
    }
    if (
      !isRecord(raw)
      || raw.schema_version !== "live-demo-server-snapshot-v1"
      || !isRecord(raw.source_projection)
    ) {
      throw workflowError("ARTIFACT_UNAVAILABLE", 409);
    }
    let state: HackathonDemoState;
    let sourceProjection: DemoSourceProjection;
    try {
      state = parseHackathonDemoState(raw.state);
      sourceProjection = structuredClone(
        raw.source_projection,
      ) as unknown as DemoSourceProjection;
      assertPublicDemoProjection(state);
      assertPublicDemoProjection(sourceProjection);
      // 잠긴 projection 계약도 순수 초기 전이로 다시 검증합니다.
      const initial = createInitialDemoState(sourceProjection);
      if (
        state.canary.pack_hash !== initial.canary.pack_hash
        || state.canary.case_id !== initial.canary.case_id
        || state.source !== initial.source
        || record.sourceHash !== initial.canary.pack_hash
        || (
          record.source === "LIVE"
            ? state.source !== "LIVE_SYNTHETIC_DEMO"
            : state.source !== "RECORDED_FALLBACK"
        )
      ) {
        throw new Error("SNAPSHOT_IDENTITY_MISMATCH");
      }
    } catch {
      throw workflowError("ARTIFACT_UNAVAILABLE", 409);
    }
    return {
      schema_version: "live-demo-server-snapshot-v1",
      state,
      source_projection: sourceProjection,
    };
  }

  async function updateRecord(
    current: DemoExecutionRecord,
    changes: Partial<DemoExecutionRecord>,
  ): Promise<DemoExecutionRecord> {
    try {
      return await options.repository.updateExecution({
        ...current,
        ...changes,
        stateVersion: current.stateVersion,
      }, {
        expectedSourceHash: current.sourceHash,
        expectedStateVersion: current.stateVersion,
        expectedStatus: current.status,
      });
    } catch {
      throw workflowError("STALE_EXECUTION", 409);
    }
  }

  function candidateFromProgress(
    event: CandidateProgressEvent,
  ): "A" | "B" | "C" | null {
    if (!("candidateId" in event)) return null;
    return event.candidateId === "A"
        || event.candidateId === "B"
        || event.candidateId === "C"
      ? event.candidateId
      : null;
  }

  function progressStep(event: CandidateProgressEvent): string {
    return event.kind === "CANDIDATE_C_TOOL_STARTED"
        || event.kind === "CANDIDATE_C_TOOL_FINISHED"
      ? `${event.kind}:${event.toolName}`
      : event.kind;
  }

  async function persistStateTransition(
    record: DemoExecutionRecord,
    state: HackathonDemoState,
    sourceProjection: DemoSourceProjection,
    status: DemoExecutionRecord["status"],
  ): Promise<DemoExecutionRecord> {
    const reference = await persistSnapshot(state, sourceProjection);
    return updateRecord(record, {
      status,
      progressStep: status,
      publicProjectionReference: reference,
      heartbeatAtMs: now(),
    });
  }

  return {
    getChallenge() {
      return structuredClone(challenge);
    },

    async createLiveComparison(input) {
      await interruptExpiredExecutions();
      const createdAtMs = now();
      const newExecutionId = executionId();
      const initialSourceHash = sha256CanonicalJson({
        schema_version: "live-demo-pending-source-v1",
        execution_id: newExecutionId,
        challenge,
      });
      const record: DemoExecutionRecord = {
        executionId: newExecutionId,
        sessionTokenDigest: input.sessionTokenDigest,
        idempotencyKey: input.idempotencyKey,
        source: "LIVE",
        status: "READY",
        progressStep: "READY",
        currentCandidate: null,
        completedCandidateCount: 0,
        createdAtMs,
        startedAtMs: null,
        heartbeatAtMs: null,
        completedAtMs: null,
        retryCount: 0,
        errorCode: null,
        cleanupStatus: "NOT_STARTED",
        evaluationPackReference: null,
        publicProjectionReference: null,
        cleanupReceiptReference: null,
        actualCostMicroUsd: 0,
        sourceHash: initialSourceHash,
        stateVersion: 0,
      };
      try {
        await options.repository.createExecution(record);
      } catch {
        throw workflowError("DUPLICATE_RUN", 409);
      }
      return executionView(record);
    },

    async runComparison(input) {
      let current = await requireOwnedExecution(
        input.executionId,
        input.sessionTokenDigest,
      );
      if (current.source !== "LIVE" || current.status !== "READY") {
        throw workflowError("DUPLICATE_RUN", 409);
      }
      const session = await options.repository.readSession(
        input.sessionTokenDigest,
      );
      if (
        !session
        || session.successfulLiveRuns >= maxSuccessfulRunsPerSession
      ) {
        throw workflowError("RUN_CAP_REACHED", 429);
      }
      const claimNow = now();
      const leaseTokenDigest = digestToken("execution-lease", token());
      const reconciliationToken = digestToken(
        "cost-reconciliation",
        token(),
      );
      const budgetBucketStartedAtMs = budgetBucket(claimNow);
      const claimed = await options.repository.claimExecution({
        executionId: current.executionId,
        sessionTokenDigest: input.sessionTokenDigest,
        expectedSourceHash: current.sourceHash,
        expectedStateVersion: current.stateVersion,
        leaseTokenDigest,
        nowMs: claimNow,
        leaseExpiresAtMs: claimNow + leaseDurationMs,
        budgetBucketStartedAtMs,
        reservedCostMicroUsd,
        maxSuccessfulRunsPerSession,
        maxOperationalRetriesPerSession,
        maxGlobalConcurrentRuns,
        maxBucketRunCount,
        maxBucketCostMicroUsd,
        isOperationalRetry: false,
      });
      if (!claimed) {
        const refreshedSession = await options.repository.readSession(
          input.sessionTokenDigest,
        );
        if (
          refreshedSession
          && refreshedSession.successfulLiveRuns
            >= maxSuccessfulRunsPerSession
        ) {
          throw workflowError("RUN_CAP_REACHED", 429);
        }
        throw workflowError("STALE_EXECUTION", 409);
      }
      current = claimed;
      const completedCandidates = new Set<"A" | "B" | "C">();
      let activeCandidate: "A" | "B" | "C" | null = null;
      const onProgress: CandidateProgressObserver = async (event) => {
        const candidate = candidateFromProgress(event);
        if (
          event.kind === "CANDIDATE_ATTEMPT_FINISHED"
          && event.status === "COMPLETE"
          && candidate !== null
        ) {
          completedCandidates.add(candidate);
        }
        if (
          event.kind === "CANDIDATE_ATTEMPT_STARTED"
          && candidate !== null
        ) {
          if (activeCandidate !== null && activeCandidate !== candidate) {
            completedCandidates.add(activeCandidate);
          }
          activeCandidate = candidate;
        }
        if (event.kind === "HARD_GATES_STARTED" && activeCandidate !== null) {
          completedCandidates.add(activeCandidate);
          activeCandidate = null;
        }
        current = await updateRecord(current, {
          progressStep: progressStep(event),
          currentCandidate: candidate,
          completedCandidateCount: completedCandidates.size,
          retryCount: current.retryCount
            + (event.kind === "CANDIDATE_RETRY_STARTED" ? 1 : 0),
          cleanupStatus: event.kind === "REMOTE_CLEANUP_STARTED"
            ? "RUNNING"
            : event.kind === "REMOTE_CLEANUP_FINISHED"
              ? "ACKNOWLEDGED"
              : current.cleanupStatus,
          heartbeatAtMs: now(),
        });
      };

      let result: LiveComparisonResult;
      try {
        result = await options.runLiveComparison({
          artifactStore: liveArtifactStore,
          createdAt: new Date(claimNow).toISOString(),
          now,
          onProgress,
        });
      } catch {
        // Task 7 orchestrator가 반환 계약 밖으로 throw하면 실제 비용·정리 상태를
        // 알 수 없으므로 0 또는 완료로 조작하지 않습니다. 마지막으로 확인된
        // 진행 증거를 보존한 채 interrupter가 회수할 수 있는 RUNNING 상태로 둡니다.
        current = await updateRecord(current, {
          progressStep: "FAILED_PLATFORM_UNRECONCILED",
          errorCode: "FAILED_PLATFORM",
          heartbeatAtMs: now(),
        });
        throw new Error("LIVE_COMPARISON_RUNNER_CONTRACT_FAILURE");
      }

      const completedSuccessfully = result.status === "RESULTS_READY"
        && result.judgeEligible
        && result.pack !== null
        && result.projection !== null
        && result.packReference !== null;
      let publicProjectionReference: DemoArtifactReference | null = null;
      let nextSourceHash = current.sourceHash;
      if (completedSuccessfully) {
        const state = createInitialDemoState(result.projection!);
        publicProjectionReference = await persistSnapshot(
          state,
          result.projection!,
        );
        nextSourceHash = result.projection!.source_hash;
      }
      const cleanupStatus = result.status === "FAILED_CLEANUP"
        ? "FAILED"
        : result.cleanupReceiptReference !== null
          ? "ACKNOWLEDGED"
          : current.cleanupStatus === "RUNNING"
            ? "FAILED"
            : current.cleanupStatus;
      current = await updateRecord(current, {
        sourceHash: nextSourceHash,
        progressStep: completedSuccessfully
          ? "RESULTS_READY"
          : result.errorCode ?? "FAILED_PLATFORM",
        currentCandidate: null,
        completedCandidateCount: Math.max(
          current.completedCandidateCount,
          completedSuccessfully ? 3 : current.completedCandidateCount,
        ),
        errorCode: completedSuccessfully ? null : result.errorCode,
        cleanupStatus,
        evaluationPackReference: result.packReference,
        publicProjectionReference,
        cleanupReceiptReference: result.cleanupReceiptReference,
      });
      const actualCostMicroUsd = usdToMicroUsd(result.actualCostUsd);
      const reconciliationNow = now();
      const reconciled = await options.repository.reconcileExecutionCost({
        executionId: current.executionId,
        sessionTokenDigest: input.sessionTokenDigest,
        expectedSourceHash: current.sourceHash,
        expectedStateVersion: current.stateVersion,
        leaseTokenDigest,
        reconciliationToken,
        budgetBucketStartedAtMs,
        reservedCostMicroUsd,
        actualCostMicroUsd,
        failedRequestCostMicroUsd: completedSuccessfully
          ? 0
          : actualCostMicroUsd,
        completedSuccessfully,
        nowMs: reconciliationNow,
      });
      if (!reconciled) {
        throw workflowError("STALE_EXECUTION", 409);
      }
      current = await requireOwnedExecution(
        input.executionId,
        input.sessionTokenDigest,
      );
      return executionView(current);
    },

    async getCurrentExecution(sessionTokenDigest) {
      await interruptExpiredExecutions();
      const session = await options.repository.readSession(sessionTokenDigest);
      if (!session?.currentExecutionId) return null;
      const record = await options.repository.readOwnedExecution(
        session.currentExecutionId,
        sessionTokenDigest,
      );
      return record ? executionView(record) : null;
    },

    async getExecution(input) {
      await interruptExpiredExecutions();
      return executionView(await requireOwnedExecution(
        input.executionId,
        input.sessionTokenDigest,
      ));
    },

    async getResults(input) {
      const record = await requireOwnedExecution(
        input.executionId,
        input.sessionTokenDigest,
      );
      if (
        record.status === "READY"
        || record.status === "RUNNING"
        || record.status === "INTERRUPTED"
        || record.status === "FAILED"
      ) {
        throw workflowError("ARTIFACT_UNAVAILABLE", 409);
      }
      const snapshot = await loadSnapshot(record);
      return assertPublicDemoProjection(snapshot.state);
    },

    async runJudge(input) {
      let record = await requireCurrentMutableExecution(
        input.executionId,
        input.sessionTokenDigest,
      );
      if (record.status !== "RESULTS_READY") {
        throw workflowError("INVALID_STATE", 409);
      }
      const isRetry = record.progressStep === "JUDGE_FAILED";
      if (
        !isRetry
        && record.progressStep !== "RESULTS_READY"
        && record.progressStep !== "RECORDED_FALLBACK_READY"
      ) {
        throw workflowError("INVALID_STATE", 409);
      }
      const snapshot = await loadSnapshot(record);
      if (snapshot.state.status !== "JUDGE_REQUIRED") {
        throw workflowError("INVALID_STATE", 409);
      }
      record = await updateRecord(record, {
        progressStep: isRetry ? "JUDGE_RETRY_RUNNING" : "JUDGE_RUNNING",
        heartbeatAtMs: now(),
      });
      const attemptNumber = isRetry ? 2 : 1;
      const reservedAtMs = now();
      const reservation = await options.repository
        .reserveAuxiliaryCallAttempt({
          executionId: record.executionId,
          sessionTokenDigest: input.sessionTokenDigest,
          expectedSourceHash: record.sourceHash,
          expectedStateVersion: record.stateVersion,
          expectedStatus: "RESULTS_READY",
          expectedProgressStep: record.progressStep,
          kind: "JUDGE",
          attemptNumber,
          bucketStartedAtMs: budgetBucket(reservedAtMs),
          reservedAtMs,
          maxAttemptsPerBucket: maxAuxiliaryCallsPerBucket,
        });
      if (reservation.outcome !== "RESERVED") {
        record = await updateRecord(record, {
          progressStep: "JUDGE_FAILED_FINAL",
          heartbeatAtMs: now(),
        });
        throw reservation.outcome === "LIMIT_REACHED"
          ? workflowError("RUN_CAP_REACHED", 429)
          : workflowError("STALE_EXECUTION", 409);
      }
      let result: Awaited<ReturnType<DemoRiskAdapterLike["invoke"]>>;
      try {
        result = await options.riskAdapter.invoke(
          buildDemoBlindJudgeInput(snapshot.source_projection),
        );
      } catch (error) {
        await options.repository.completeAuxiliaryCallAttempt({
          executionId: record.executionId,
          sessionTokenDigest: input.sessionTokenDigest,
          expectedSourceHash: record.sourceHash,
          expectedStateVersion: record.stateVersion,
          kind: "JUDGE",
          attemptNumber,
          outcome: "FAILED",
          completedAtMs: now(),
          errorCode: "AUXILIARY_PROVIDER_FAILURE",
        }).catch(() => false);
        await updateRecord(record, {
          progressStep: isRetry ? "JUDGE_FAILED_FINAL" : "JUDGE_FAILED",
          heartbeatAtMs: now(),
        });
        throw error;
      }
      const completionRecorded = await options.repository
        .completeAuxiliaryCallAttempt({
          executionId: record.executionId,
          sessionTokenDigest: input.sessionTokenDigest,
          expectedSourceHash: record.sourceHash,
          expectedStateVersion: record.stateVersion,
          kind: "JUDGE",
          attemptNumber,
          outcome: "COMPLETE",
          completedAtMs: now(),
          errorCode: null,
        })
        .catch(() => false);
      if (!completionRecorded) {
        await updateRecord(record, {
          progressStep: "JUDGE_FAILED_FINAL",
          heartbeatAtMs: now(),
        });
        throw workflowError("STALE_EXECUTION", 409);
      }
      try {
        const next = assertPublicDemoProjection(applyDemoJudgeResult(
          snapshot.state,
          result.output,
          result.metadata,
        ));
        const reference = await persistSnapshot(
          next,
          snapshot.source_projection,
        );
        await updateRecord(record, {
          status: "JUDGE_READY",
          progressStep: "JUDGE_READY",
          publicProjectionReference: reference,
          heartbeatAtMs: now(),
        });
        return next;
      } catch {
        await updateRecord(record, {
          progressStep: "JUDGE_FAILED_FINAL",
          heartbeatAtMs: now(),
        }).catch(() => null);
        throw workflowError("INVALID_STATE", 409);
      }
    },

    async getEvidence(input) {
      const record = await requireOwnedExecution(
        input.executionId,
        input.sessionTokenDigest,
      );
      const state = (await loadSnapshot(record)).state;
      const candidate = state.blind_review.candidates.find(
        (item) => item.blind_label === input.blindLabel,
      );
      if (!candidate) {
        throw workflowError("ARTIFACT_UNAVAILABLE", 404);
      }
      return assertPublicDemoProjection({
        case_id: state.canary.case_id,
        blind_label: input.blindLabel,
        runs: structuredClone(candidate.runs),
        judge_risk: state.judge?.risks.find(
          (risk) => risk.blind_label === input.blindLabel,
        ) ?? null,
      });
    },

    async confirmReviews(input) {
      const record = await requireCurrentMutableExecution(
        input.executionId,
        input.sessionTokenDigest,
      );
      if (record.status !== "JUDGE_READY") {
        throw workflowError("INVALID_STATE", 409);
      }
      const snapshot = await loadSnapshot(record);
      let review: ReturnType<typeof validateDemoReview>;
      let next: HackathonDemoState;
      try {
        review = validateDemoReview(input.review);
        next = applyDemoReview(snapshot.state, review);
      } catch {
        throw workflowError("INVALID_STATE", 409);
      }
      const reference = await persistSnapshot(
        next,
        snapshot.source_projection,
      );
      const confirmedAtMs = now();
      const reviews = review.decisions.map((decision) => ({
        executionId: record.executionId,
        blindLabel: decision.blind_label,
        decision: decision.decision,
        rationale: review.rationale,
        correctedReply: null,
        // 현재 D1 스키마의 비어 있지 않은 정수 열을 위한 호환값입니다.
        // 권위 있는 공개 상태와 Memo에서는 두 시간 모두 NOT_MEASURED입니다.
        reviewDurationMs: 0,
        editDurationMs: 0,
        confirmedAtMs,
      })) satisfies DemoHumanReviewRecord[];
      const applied = await options.repository.confirmHumanReviews({
        executionId: record.executionId,
        sessionTokenDigest: input.sessionTokenDigest,
        expectedSourceHash: record.sourceHash,
        expectedStateVersion: record.stateVersion,
        nextStatus: next.status === "NO_APPROVED_CANDIDATE"
          ? "NO_APPROVED_CANDIDATE"
          : "REVIEW_READY",
        publicProjectionReference: reference,
        reviews,
      });
      if (!applied) throw workflowError("STALE_EXECUTION", 409);
      return assertPublicDemoProjection(next);
    },

    async selectCandidate(input) {
      const record = await requireCurrentMutableExecution(
        input.executionId,
        input.sessionTokenDigest,
      );
      if (record.status !== "REVIEW_READY") {
        throw workflowError("INVALID_STATE", 409);
      }
      const snapshot = await loadSnapshot(record);
      let selection: ReturnType<typeof validateDemoSelection>;
      let next: HackathonDemoState;
      try {
        selection = validateDemoSelection(snapshot.state, input.selection);
        next = applyDemoSelection(snapshot.state, selection);
      } catch {
        throw workflowError("INVALID_STATE", 409);
      }
      const reference = await persistSnapshot(
        next,
        snapshot.source_projection,
      );
      const selectionRecord: DemoCandidateSelectionRecord = {
        executionId: record.executionId,
        candidateId: selection.candidate_id,
        rationale: selection.rationale,
        sourceHash: record.sourceHash,
        selectedAtMs: now(),
      };
      const applied = await options.repository.recordCandidateSelection({
        executionId: record.executionId,
        sessionTokenDigest: input.sessionTokenDigest,
        expectedSourceHash: record.sourceHash,
        expectedStateVersion: record.stateVersion,
        publicProjectionReference: reference,
        selection: selectionRecord,
      });
      if (!applied) throw workflowError("STALE_EXECUTION", 409);
      return assertPublicDemoProjection(next);
    },

    async createDecisionMemo(input) {
      let record = await requireCurrentMutableExecution(
        input.executionId,
        input.sessionTokenDigest,
      );
      if (
        record.status !== "SELECTION_RECORDED"
        && record.status !== "MEMO_FAILED"
      ) {
        throw workflowError("INVALID_STATE", 409);
      }
      const isRetry = record.status === "MEMO_FAILED";
      if (isRetry) {
        const previousMemo = await options.repository.readMemoState(
          record.executionId,
        );
        if (
          previousMemo?.status !== "FAILED"
          || previousMemo.reconciliationReason
            !== "MEMO_FAILED_RETRY_AVAILABLE_SELECTION_PRESERVED_NO_BASELINE_CREATED"
        ) {
          throw workflowError("INVALID_STATE", 409);
        }
      }
      const snapshot = await loadSnapshot(record);
      let memoInput: ReturnType<typeof buildDemoDecisionMemoInput>;
      try {
        memoInput = buildDemoDecisionMemoInput(snapshot.state);
      } catch {
        throw workflowError("INVALID_STATE", 409);
      }
      const reviewHash = sha256CanonicalJson(snapshot.state.human_review);
      const selectionHash = sha256CanonicalJson(snapshot.state.selection);
      const startedAtMs = now();
      const runningMemo: DemoDecisionMemoRecord = {
        executionId: record.executionId,
        status: "RUNNING",
        sourcePackHash: record.sourceHash,
        reviewHash,
        selectionHash,
        artifactReference: null,
        errorCode: null,
        reconciliationReason: null,
        updatedAtMs: startedAtMs,
      };
      const began = await options.repository.beginDecisionMemo({
        executionId: record.executionId,
        sessionTokenDigest: input.sessionTokenDigest,
        expectedSourceHash: record.sourceHash,
        expectedStateVersion: record.stateVersion,
        publicProjectionReference: record.publicProjectionReference!,
        memo: runningMemo,
      });
      if (!began) throw workflowError("STALE_EXECUTION", 409);
      record = await requireOwnedExecution(
        input.executionId,
        input.sessionTokenDigest,
      );

      let next: HackathonDemoState;
      let completedMemo: DemoDecisionMemoRecord;
      const attemptNumber = isRetry ? 2 : 1;
      const reservedAtMs = now();
      const reservation = await options.repository
        .reserveAuxiliaryCallAttempt({
          executionId: record.executionId,
          sessionTokenDigest: input.sessionTokenDigest,
          expectedSourceHash: record.sourceHash,
          expectedStateVersion: record.stateVersion,
          expectedStatus: "MEMO_RUNNING",
          expectedProgressStep: "MEMO_RUNNING",
          kind: "MEMO",
          attemptNumber,
          bucketStartedAtMs: budgetBucket(reservedAtMs),
          reservedAtMs,
          maxAttemptsPerBucket: maxAuxiliaryCallsPerBucket,
        });
      if (reservation.outcome !== "RESERVED") {
        next = applyDemoMemoFailure(snapshot.state);
        completedMemo = {
          ...runningMemo,
          status: "FAILED",
          errorCode: "BASELINE_NOT_CREATED",
          reconciliationReason:
            "MEMO_AUXILIARY_CALL_NOT_RESERVED_SELECTION_PRESERVED_NO_BASELINE_CREATED",
          updatedAtMs: now(),
        };
        const reference = await persistSnapshot(
          next,
          snapshot.source_projection,
        );
        const completed = await options.repository.completeDecisionMemo({
          executionId: record.executionId,
          sessionTokenDigest: input.sessionTokenDigest,
          expectedSourceHash: record.sourceHash,
          expectedStateVersion: record.stateVersion,
          publicProjectionReference: reference,
          memo: completedMemo,
        });
        if (!completed) throw workflowError("STALE_EXECUTION", 409);
        throw reservation.outcome === "LIMIT_REACHED"
          ? workflowError("RUN_CAP_REACHED", 429)
          : workflowError("STALE_EXECUTION", 409);
      }
      let auxiliaryCompletionRecorded = false;
      try {
        const result = await options.memoAdapter.invoke(memoInput);
        auxiliaryCompletionRecorded = await options.repository
          .completeAuxiliaryCallAttempt({
            executionId: record.executionId,
            sessionTokenDigest: input.sessionTokenDigest,
            expectedSourceHash: record.sourceHash,
            expectedStateVersion: record.stateVersion,
            kind: "MEMO",
            attemptNumber,
            outcome: "COMPLETE",
            completedAtMs: now(),
            errorCode: null,
          })
          .catch(() => false);
        if (!auxiliaryCompletionRecorded) {
          throw new Error("AUXILIARY_COMPLETION_RECORD_FAILED");
        }
        next = applyDemoMemoSuccess(
          snapshot.state,
          result.output,
          result.metadata,
        );
        const artifactReference = await persistValue(
          "decision-memos",
          result.output,
        );
        completedMemo = {
          ...runningMemo,
          status: "READY",
          artifactReference,
          updatedAtMs: now(),
        };
      } catch {
        if (!auxiliaryCompletionRecorded) {
          auxiliaryCompletionRecorded = await options.repository
            .completeAuxiliaryCallAttempt({
              executionId: record.executionId,
              sessionTokenDigest: input.sessionTokenDigest,
              expectedSourceHash: record.sourceHash,
              expectedStateVersion: record.stateVersion,
              kind: "MEMO",
              attemptNumber,
              outcome: "FAILED",
              completedAtMs: now(),
              errorCode: "AUXILIARY_PROVIDER_FAILURE",
            })
            .catch(() => false);
        }
        next = applyDemoMemoFailure(snapshot.state);
        completedMemo = {
          ...runningMemo,
          status: "FAILED",
          errorCode: "BASELINE_NOT_CREATED",
          reconciliationReason: !auxiliaryCompletionRecorded
            ? "MEMO_AUXILIARY_COMPLETION_RECORD_FAILED_SELECTION_PRESERVED_NO_BASELINE_CREATED"
            : isRetry
              ? "MEMO_FAILED_FINAL_SELECTION_PRESERVED_NO_BASELINE_CREATED"
              : "MEMO_FAILED_RETRY_AVAILABLE_SELECTION_PRESERVED_NO_BASELINE_CREATED",
          updatedAtMs: now(),
        };
      }
      const reference = await persistSnapshot(
        next,
        snapshot.source_projection,
      );
      const completed = await options.repository.completeDecisionMemo({
        executionId: record.executionId,
        sessionTokenDigest: input.sessionTokenDigest,
        expectedSourceHash: record.sourceHash,
        expectedStateVersion: record.stateVersion,
        publicProjectionReference: reference,
        memo: completedMemo,
      });
      if (!completed) throw workflowError("STALE_EXECUTION", 409);
      return assertPublicDemoProjection(next);
    },

    async replayRegression(input) {
      const record = await requireCurrentMutableExecution(
        input.executionId,
        input.sessionTokenDigest,
      );
      if (record.status !== "MEMO_READY") {
        throw workflowError("INVALID_STATE", 409);
      }
      const snapshot = await loadSnapshot(record);
      let next: HackathonDemoState;
      try {
        next = replayDemoRepresentativeDefect(snapshot.state);
      } catch {
        throw workflowError("INVALID_STATE", 409);
      }
      await persistStateTransition(
        record,
        next,
        snapshot.source_projection,
        "REGRESSION_BLOCK",
      );
      return assertPublicDemoProjection(next);
    },

    async selectRecordedFallback(input) {
      const session = await options.repository.readSession(
        input.sessionTokenDigest,
      );
      if (session?.currentExecutionId) {
        const current = await options.repository.readOwnedExecution(
          session.currentExecutionId,
          input.sessionTokenDigest,
        );
        if (
          !current
          || current.source !== "LIVE"
          || (
            current.status !== "FAILED"
            && current.status !== "INTERRUPTED"
            && !(
              current.status === "RUNNING"
              && current.progressStep === "FAILED_PLATFORM_UNRECONCILED"
              && current.errorCode === "FAILED_PLATFORM"
            )
          )
        ) {
          throw workflowError("INVALID_STATE", 409);
        }
      }
      const newExecutionId = executionId();
      const selectedAtMs = now();
      const state = createInitialDemoState(options.recordedProjection);
      const evaluationReference = await persistValue(
        "recorded-fallback",
        options.recordedProjection,
      );
      const publicProjectionReference = await persistSnapshot(
        state,
        options.recordedProjection,
      );
      const record: DemoExecutionRecord = {
        executionId: newExecutionId,
        sessionTokenDigest: input.sessionTokenDigest,
        idempotencyKey: `recorded-fallback:${newExecutionId}`,
        source: "RECORDED_FALLBACK",
        status: "RESULTS_READY",
        progressStep: "RECORDED_FALLBACK_READY",
        currentCandidate: null,
        completedCandidateCount: 3,
        createdAtMs: selectedAtMs,
        startedAtMs: selectedAtMs,
        heartbeatAtMs: selectedAtMs,
        completedAtMs: selectedAtMs,
        retryCount: 0,
        errorCode: null,
        cleanupStatus: "NOT_STARTED",
        evaluationPackReference: evaluationReference,
        publicProjectionReference,
        cleanupReceiptReference: null,
        actualCostMicroUsd: usdToMicroUsd(
          options.recordedProjection.total_runtime_cost_usd,
        ),
        sourceHash: options.recordedProjection.source_hash,
        stateVersion: 0,
      };
      try {
        await options.repository.createExecution(record);
      } catch {
        throw workflowError("INVALID_STATE", 409);
      }
      return {
        execution: executionView(record),
        state: assertPublicDemoProjection(state),
      };
    },
  };
}

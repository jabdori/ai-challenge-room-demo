import type {
  DefineStructureOutcome,
} from "../eval/cli/runDefineStructure";
import type {
  RecordedBenchmarkOutcome,
} from "../eval/cli/runRecordedBenchmark";
import type { LockedChallengePack } from "../eval/define/defineContracts";
import { SYNTHETIC_CHALLENGE_TEMPLATE } from "../eval/define/syntheticChallengeDefinition";
import type { RecordedBenchmarkPack } from "../eval/pack/recordedBenchmarkPack";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../eval/runtime/canonicalJson";
import {
  ApiArtifactIntegrityError,
  type ChallengeApiGateway,
  type ChallengeMutationCommand,
  type ChallengeMutationResult,
  type PublicProjection,
  type ReviewerBlindEvidenceGateway,
} from "./challengeServer";
import {
  buildBenchmarkStartCommandReceipt,
  buildChallengeLifecycleProjectionSnapshot,
  buildPersistedBenchmarkProgressRecord,
  parsePersistedBenchmarkProgressRecord,
  type BenchmarkStartCommandReceipt,
  type ChallengeLifecycleDefineArtifact,
  type ChallengeLifecycleFailure,
  type ChallengeLifecycleSourceState,
  type PersistedBenchmarkProgressRecord,
} from "./challengeLifecycleSnapshots";
import {
  createReadOnlyProjectionGateway,
  type ProjectionSnapshot,
} from "./projectionRepository";

const SHA256 = /^[a-f0-9]{64}$/;
const ACTOR_LABEL = /^[^\p{Cc}]{1,160}$/u;
const BENCHMARK_ACKNOWLEDGEMENT =
  "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12";

type JsonRecord = Record<string, unknown>;

interface HumanLockInput {
  readonly defineArtifact: ChallengeLifecycleDefineArtifact;
  readonly actorLabel: string;
  readonly approvedContractHash: string;
  readonly approvedAt: string;
}

export interface AuthoritativeChallengeLifecycleDependencies {
  readonly executeDefineStructure: (
    input: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<DefineStructureOutcome>;
  readonly assertPersistedDefineArtifact: (
    value: unknown,
  ) => void;
  readonly executeHumanLock: (
    input: HumanLockInput,
  ) => Promise<LockedChallengePack>;
  readonly assertAuthoritativeLockedChallengePack: (
    value: unknown,
  ) => void;
  readonly buildStableBenchmarkId: (
    lockedChallengePack: LockedChallengePack,
  ) => string;
  readonly persistStartReceipt: (
    receipt: BenchmarkStartCommandReceipt,
  ) => Promise<{
    readonly path: string;
    readonly receipt?: BenchmarkStartCommandReceipt;
  }>;
  readonly loadStartReceipt: (input: {
    readonly path: string;
    readonly expectedReceipt: BenchmarkStartCommandReceipt;
  }) => Promise<BenchmarkStartCommandReceipt>;
  /**
   * TODO(lifecycle-progress-contracts): 전용 progress scanner의 source-reload
   * 반환 타입으로 교체합니다. 현재 국소 interface도 동일 exact public
   * 필드와 72-slot terminal evidence 계약을 강제합니다.
   */
  readonly loadPersistedProgress: (input: {
    readonly benchmarkId: string;
    readonly lockedChallengePack: LockedChallengePack;
    readonly attemptNumber: number;
  }) => Promise<PersistedBenchmarkProgressRecord | null>;
  readonly executeRecordedBenchmark: (input: {
    readonly lockedChallengePack: LockedChallengePack;
    readonly executionMode: "START" | "RESUME";
    readonly resumeFromProgressHash: string | null;
    readonly signal?: AbortSignal;
  }) => Promise<RecordedBenchmarkOutcome>;
  readonly assertPersistedRecordedBenchmarkPack: (
    value: unknown,
  ) => void;
  readonly createRecordedReviewGateway: (
    input: Readonly<{
      recordedBenchmarkPack: RecordedBenchmarkPack;
      lockedChallengePack: LockedChallengePack;
      lifecycleState: ChallengeLifecycleSourceState;
    }>,
  ) => Promise<ChallengeApiGateway>;
  readonly scheduleBackground: (
    task: () => Promise<void>,
  ) => void;
  /**
   * lifecycle source와 공개 snapshot을 같은 phase receipt chain에 기록합니다.
   * 이 callback이 실패하면 mutation은 성공으로 응답하지 않습니다.
   */
  readonly checkpointLifecyclePhase?: (input: Readonly<{
    phase: "PROPOSED" | "LOCKED" | "READY" | "RUNNING" | "INVALID";
    sourceState: ChallengeLifecycleSourceState;
    snapshot: ProjectionSnapshot;
  }>) => Promise<ChallengeLifecycleSourceState | void>;
  readonly now: () => string;
}

export interface AuthoritativeChallengeLifecycleController
  extends ChallengeApiGateway {
  readonly getLifecycleSnapshot: () => Promise<ProjectionSnapshot>;
  readonly isBenchmarkRunning: () => boolean;
}

/**
 * 재시작 시에는 실행 중이던 작업을 다시 시작하지 않고, 이미 검증한 source
 * 상태와 (REVIEW_PENDING 이후의) downstream gateway만 주입합니다. 이 타입은
 * phase-receipt hydrator가 controller 내부 표현을 추측하지 않도록 공개합니다.
 */
export interface HydratedChallengeLifecycleControllerState {
  readonly sourceState: ChallengeLifecycleSourceState;
  readonly downstream?: ChallengeApiGateway;
}

function invalidRequest(message: string): never {
  throw new TypeError(message);
}

function stale(message: string): never {
  throw new ApiArtifactIntegrityError("STALE_SOURCE", message);
}

function integrity(message: string): never {
  throw new ApiArtifactIntegrityError("ARTIFACT_INTEGRITY", message);
}

function exactPayload(
  command: ChallengeMutationCommand,
  keys: readonly string[],
  location: string,
): JsonRecord {
  const payload = command.payload;
  if (
    typeof payload !== "object"
    || payload === null
    || Array.isArray(payload)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(payload))
    || Object.keys(payload).sort().join("\0")
      !== [...keys].sort().join("\0")
  ) {
    invalidRequest(`${location} payload exact 계약이 다릅니다.`);
  }
  return payload as JsonRecord;
}

function actorLabel(payload: JsonRecord, location: string): string {
  if (
    payload.actor_type !== "HUMAN"
    || typeof payload.actor_label !== "string"
    || !ACTOR_LABEL.test(payload.actor_label)
    || /sk-[A-Za-z0-9_-]{16,}/.test(payload.actor_label)
  ) {
    invalidRequest(`${location}에는 exact HUMAN actor가 필요합니다.`);
  }
  return payload.actor_label;
}

function currentSourceHash(state: ChallengeLifecycleSourceState): string {
  const snapshot = buildChallengeLifecycleProjectionSnapshot(state);
  const sourceHash = snapshot.projections.workspace.source_hash;
  if (typeof sourceHash !== "string" || !SHA256.test(sourceHash)) {
    integrity("Lifecycle workspace source hash가 유효하지 않습니다.");
  }
  return sourceHash;
}

function assertMutationEnvelope({
  command,
  expectedSchema,
  expectedTarget,
  state,
}: {
  readonly command: ChallengeMutationCommand;
  readonly expectedSchema: string;
  readonly expectedTarget: string;
  readonly state: ChallengeLifecycleSourceState;
}): void {
  if (
    command.schema_version !== expectedSchema
    || command.target_id !== expectedTarget
  ) {
    invalidRequest("Lifecycle mutation schema 또는 target이 다릅니다.");
  }
  if (command.expected_source_hash !== currentSourceHash(state)) {
    stale("Lifecycle mutation source hash가 현재 권위 상태와 다릅니다.");
  }
}

function successfulDefineArtifact(
  outcome: DefineStructureOutcome,
  assertPersisted: (value: unknown) => void,
): ChallengeLifecycleDefineArtifact | null {
  if (
    outcome.exitCode !== 0
    || outcome.summary.command_status !== "DEFINE_SUGGESTION_READY"
    || outcome.summary.authority !== "ADVISORY_ONLY"
    || outcome.summary.human_approval_required !== true
    || outcome.summary.challenge_locked !== false
    || outcome.summary.structuring_status !== "SUGGESTION_COMPLETE"
    || outcome.summary.artifact_hash === null
    || outcome.serverAuthority === null
  ) {
    return null;
  }
  const artifact = outcome.serverAuthority.defineStructuringArtifact;
  assertPersisted(artifact);
  const lifecycleArtifact =
    artifact as unknown as ChallengeLifecycleDefineArtifact;
  if (
    lifecycleArtifact.artifact_hash !== outcome.summary.artifact_hash
    || lifecycleArtifact.authority !== "ADVISORY_ONLY"
    || lifecycleArtifact.lock_authority !== "NONE"
    || lifecycleArtifact.human_approval_status !== "REQUIRED"
    || lifecycleArtifact.run_record.structuringStatus
      !== "SUGGESTION_COMPLETE"
    || lifecycleArtifact.run_record.suggestion === null
    || canonicalJsonStringify(lifecycleArtifact.define_input)
      !== canonicalJsonStringify(
        SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
      )
  ) {
    integrity("Define outcome의 source-reloaded advisory artifact가 다릅니다.");
  }
  return lifecycleArtifact;
}

function assertLockedBinding({
  pack,
  artifact,
  approvedContractHash,
}: {
  readonly pack: LockedChallengePack;
  readonly artifact: ChallengeLifecycleDefineArtifact;
  readonly approvedContractHash: string;
}): void {
  if (
    pack.state !== "LOCKED"
    || pack.authority !== "EXPLICIT_HUMAN_APPROVAL"
    || pack.challenge_id
      !== SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract.challenge_id
    || pack.challenge_version
      !== SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract.challenge_version
    || pack.approved_contract_hash !== approvedContractHash
    || pack.source_define_input_hash
      !== sha256CanonicalJson(artifact.define_input)
    || pack.source_define_suggestion_hash
      !== sha256CanonicalJson(artifact.run_record.suggestion)
  ) {
    integrity("Locked Challenge가 승인한 Define source·contract와 다릅니다.");
  }
}

function isCleanCompleteOutcome({
  outcome,
  lockedChallengePack,
  assertPersisted,
}: {
  readonly outcome: RecordedBenchmarkOutcome;
  readonly lockedChallengePack: LockedChallengePack;
  readonly assertPersisted: (value: unknown) => void;
}): RecordedBenchmarkPack | null {
  const summary = outcome.summary;
  const resources = summary.cleanup.resources;
  const vectorStores = resources.filter(
    (resource) => resource.kind === "VECTOR_STORE",
  );
  const files = resources.filter(
    (resource) => resource.kind === "UPLOADED_FILE",
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
    || summary.clean_completion !== true
    || summary.candidate_execution_count !== 72
    || summary.auxiliary_judge_count !== 12
    || summary.complete_judge_count
      + summary.human_fallback_judge_count !== 12
    || summary.cleanup.required !== 33
    || summary.cleanup.acknowledged !== 33
    || summary.cleanup.incomplete !== 0
    || resources.length !== 33
    || vectorStores.length !== 1
    || files.length !== 32
    || resources.some((resource) => resource.delete_acknowledged !== true)
    || typeof summary.cleanup.receipt_path !== "string"
    || summary.cleanup.receipt_path.length === 0
  ) {
    return null;
  }
  const pack = outcome.serverAuthority.recordedBenchmarkPack;
  assertPersisted(pack);
  if (pack.locked_challenge_pack_hash !== lockedChallengePack.locked_challenge_pack_hash) {
    integrity("Recorded Benchmark Pack이 현재 Locked Challenge와 다릅니다.");
  }
  return pack;
}

function failureFromOutcome(
  outcome: RecordedBenchmarkOutcome,
): ChallengeLifecycleFailure {
  if (
    outcome.summary.cleanup.required > 0
    && (
      outcome.summary.cleanup.incomplete > 0
      || outcome.summary.cleanup.acknowledged
        !== outcome.summary.cleanup.required
    )
  ) {
    return { code: "CLEANUP_INCOMPLETE", phase: "CLEANUP" };
  }
  if (
    outcome.summary.candidate_execution_count === 72
    && outcome.summary.auxiliary_judge_count < 12
  ) {
    return { code: "JUDGE_INCOMPLETE", phase: "JUDGE" };
  }
  return { code: "BENCHMARK_INCOMPLETE", phase: "BENCHMARK" };
}

function throwUnavailable(): Promise<never> {
  return Promise.reject(new TypeError(
    "해당 lifecycle 단계에서는 mutation을 실행할 수 없습니다.",
  ));
}

function assertHydratedLifecycleState({
  sourceState,
  downstream,
  dependencies,
}: HydratedChallengeLifecycleControllerState & {
  readonly dependencies: AuthoritativeChallengeLifecycleDependencies;
}): void {
  // 공개 snapshot 재빌드는 private source 상태의 기본 구조와 source hash를
  // 동시에 검증합니다. 로더가 임의 객체를 주입해 lifecycle을 되살리는 것을
  // 막기 위한 controller 경계입니다.
  buildChallengeLifecycleProjectionSnapshot(sourceState);
  if (sourceState.defineArtifact !== null) {
    dependencies.assertPersistedDefineArtifact(sourceState.defineArtifact);
  }
  if (sourceState.lockedChallengePack !== null) {
    dependencies.assertAuthoritativeLockedChallengePack(
      sourceState.lockedChallengePack,
    );
  }
  if (sourceState.progress !== null) {
    parsePersistedBenchmarkProgressRecord(sourceState.progress);
  }

  const hasLockedSource = sourceState.lockedChallengePack !== null
    && sourceState.benchmarkId !== null;
  if (
    sourceState.phase === "DRAFT"
    && (
      sourceState.defineArtifact !== null
      || sourceState.lockedChallengePack !== null
      || sourceState.benchmarkId !== null
      || sourceState.startReceipt !== null
      || sourceState.progress !== null
      || sourceState.failure !== null
      || downstream !== undefined
    )
  ) {
    integrity("DRAFT hydration에는 downstream 또는 이전 lifecycle source가 있으면 안 됩니다.");
  }
  if (
    sourceState.phase === "PROPOSED"
    && (
      sourceState.defineArtifact === null
      || sourceState.lockedChallengePack !== null
      || sourceState.benchmarkId !== null
      || sourceState.startReceipt !== null
      || sourceState.progress !== null
      || sourceState.failure !== null
      || downstream !== undefined
    )
  ) {
    integrity("PROPOSED hydration source 결합이 다릅니다.");
  }
  if (
    sourceState.phase === "LOCKED"
    && (
      !hasLockedSource
      || sourceState.startReceipt !== null
      || sourceState.progress !== null
      || sourceState.failure !== null
      || downstream !== undefined
    )
  ) {
    integrity("LOCKED hydration source 결합이 다릅니다.");
  }
  if (
    sourceState.phase === "RUNNING"
    && (
      !hasLockedSource
      || sourceState.startReceipt === null
      || sourceState.failure !== null
      || downstream !== undefined
    )
  ) {
    integrity("RUNNING hydration source 결합이 다릅니다.");
  }
  if (sourceState.phase === "COMPLETE" && downstream === undefined) {
    integrity("COMPLETE hydration에는 source-reloaded downstream gateway가 필요합니다.");
  }
  if (sourceState.phase !== "COMPLETE" && downstream !== undefined) {
    integrity("COMPLETE 이전 lifecycle에는 downstream gateway를 주입할 수 없습니다.");
  }
}

export function createAuthoritativeChallengeLifecycleController({
  dependencies,
  signal,
  initialState,
}: {
  readonly dependencies: AuthoritativeChallengeLifecycleDependencies;
  readonly signal?: AbortSignal;
  readonly initialState?: HydratedChallengeLifecycleControllerState;
}): AuthoritativeChallengeLifecycleController {
  const draftState: ChallengeLifecycleSourceState = Object.freeze({
    phase: "DRAFT",
    defineInput: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
    defineArtifact: null,
    lockedChallengePack: null,
    benchmarkId: null,
    startReceipt: null,
    progress: null,
    failure: null,
  });
  if (initialState !== undefined) {
    assertHydratedLifecycleState({ ...initialState, dependencies });
  }
  let state: ChallengeLifecycleSourceState = Object.freeze(
    initialState?.sourceState ?? draftState,
  );
  let downstream: ChallengeApiGateway | null = initialState?.downstream ?? null;
  // 중요한 재시작 안전성: RUNNING source를 복원해도 여기서 background task를
  // 예약하지 않습니다. 운영자가 새 명령으로 명시적으로 재개하기 전에는 어떤
  // Benchmark side effect도 발생하지 않습니다.
  let backgroundRunning = false;

  const lifecycleSnapshot = (): ProjectionSnapshot => (
    buildChallengeLifecycleProjectionSnapshot(state)
  );

  const checkpointLifecyclePhase = async (
    phase: "PROPOSED" | "LOCKED" | "READY" | "RUNNING" | "INVALID",
    sourceState: ChallengeLifecycleSourceState,
  ): Promise<ChallengeLifecycleSourceState> => {
    const persisted = await dependencies.checkpointLifecyclePhase?.({
      phase,
      sourceState,
      snapshot: buildChallengeLifecycleProjectionSnapshot(sourceState),
    });
    return persisted ?? sourceState;
  };

  const refreshProgress = async (): Promise<void> => {
    if (
      state.phase !== "RUNNING"
      || state.lockedChallengePack === null
      || state.startReceipt === null
    ) return;
    const progress = await dependencies.loadPersistedProgress({
      benchmarkId: state.startReceipt.benchmark_id,
      lockedChallengePack: state.lockedChallengePack,
      attemptNumber: state.startReceipt.attempt_number,
    });
    if (progress === null) return;
    const parsed = parsePersistedBenchmarkProgressRecord(progress);
    if (
      parsed.benchmark_id !== state.startReceipt.benchmark_id
      || parsed.challenge_id !== state.lockedChallengePack.challenge_id
      || parsed.locked_challenge_pack_hash
        !== state.lockedChallengePack.locked_challenge_pack_hash
      || parsed.attempt_number !== state.startReceipt.attempt_number
    ) {
      integrity("Source-reloaded Benchmark progress가 현재 실행과 다릅니다.");
    }
    state = Object.freeze({ ...state, progress: parsed });
  };

  const readGateway = async (): Promise<ChallengeApiGateway> => {
    if (downstream !== null) return downstream;
    await refreshProgress();
    return createReadOnlyProjectionGateway(lifecycleSnapshot());
  };

  const runBenchmarkInBackground = async ({
    lockedChallengePack,
    startReceipt,
  }: {
    readonly lockedChallengePack: LockedChallengePack;
    readonly startReceipt: BenchmarkStartCommandReceipt;
  }): Promise<void> => {
    try {
      const outcome = await dependencies.executeRecordedBenchmark({
        lockedChallengePack,
        executionMode: startReceipt.execution_mode,
        resumeFromProgressHash: startReceipt.resume_from_progress_hash,
        ...(signal ? { signal } : {}),
      });
      await refreshProgress();
      const recordedPack = isCleanCompleteOutcome({
        outcome,
        lockedChallengePack,
        assertPersisted:
          dependencies.assertPersistedRecordedBenchmarkPack,
      });
      if (recordedPack !== null) {
        const coldReloadReference = outcome.serverAuthority?.coldReloadReference;
        const completedState: ChallengeLifecycleSourceState = Object.freeze({
          ...state,
          phase: "COMPLETE",
          ...(coldReloadReference === undefined
            ? {}
            : { recordedBenchmarkColdReloadReference: coldReloadReference }),
        });
        const nextGateway = await dependencies.createRecordedReviewGateway({
          recordedBenchmarkPack: recordedPack,
          lockedChallengePack,
          lifecycleState: completedState,
        });
        // 완전한 downstream gateway가 만들어진 뒤 한 번에 pointer를 전환합니다.
        downstream = nextGateway;
        state = completedState;
        return;
      }
      const failure = failureFromOutcome(outcome);
      const previousProgress = state.progress;
      const cleanupAcknowledged = Math.max(
        0,
        Math.min(33, outcome.summary.cleanup.acknowledged),
      );
      const resumeAction = failure.phase === "CLEANUP"
        ? "RETRY_CLEANUP"
        : previousProgress?.candidate_execution.completed
          ? "CONTINUE_FROM_PERSISTED_CHECKPOINTS"
          : "RESTART_AFTER_FIX";
      const invalidProgress = buildPersistedBenchmarkProgressRecord({
        benchmarkId: startReceipt.benchmark_id,
        challengeId: lockedChallengePack.challenge_id,
        lockedChallengePackHash:
          lockedChallengePack.locked_challenge_pack_hash,
        attemptNumber: startReceipt.attempt_number,
        status: "INVALID",
        candidateExecutionCompleted:
          previousProgress?.candidate_execution.completed ?? 0,
        auxiliaryJudgeCompleted:
          previousProgress?.auxiliary_judge.completed ?? 0,
        cleanupAcknowledged,
        checkpointSource: previousProgress?.checkpoint_source ?? null,
        resumeAllowed: true,
        resumeAction,
        failure,
        updatedAt: dependencies.now(),
      });
      state = Object.freeze({
        ...state,
        phase: "INVALID",
        progress: invalidProgress,
        failure,
      });
      state = await checkpointLifecyclePhase("INVALID", state);
    } catch {
      const failure: ChallengeLifecycleFailure = {
        code: "BENCHMARK_RUNTIME_FAILED",
        phase: "BENCHMARK",
      };
      const previousProgress = state.progress;
      const invalidProgress = buildPersistedBenchmarkProgressRecord({
        benchmarkId: startReceipt.benchmark_id,
        challengeId: lockedChallengePack.challenge_id,
        lockedChallengePackHash:
          lockedChallengePack.locked_challenge_pack_hash,
        attemptNumber: startReceipt.attempt_number,
        status: "INVALID",
        candidateExecutionCompleted:
          previousProgress?.candidate_execution.completed ?? 0,
        auxiliaryJudgeCompleted:
          previousProgress?.auxiliary_judge.completed ?? 0,
        cleanupAcknowledged:
          previousProgress?.cleanup.acknowledged ?? 0,
        checkpointSource: previousProgress?.checkpoint_source ?? null,
        resumeAllowed: true,
        resumeAction: previousProgress?.candidate_execution.completed
          ? "CONTINUE_FROM_PERSISTED_CHECKPOINTS"
          : "RESTART_AFTER_FIX",
        failure,
        updatedAt: dependencies.now(),
      });
      state = Object.freeze({
        ...state,
        phase: "INVALID",
        progress: invalidProgress,
        failure,
      });
      state = await checkpointLifecyclePhase("INVALID", state);
    } finally {
      backgroundRunning = false;
    }
  };

  const structureDefine = async (
    command: ChallengeMutationCommand,
  ): Promise<ChallengeMutationResult> => {
    if (
      downstream !== null
      || !(
        state.phase === "DRAFT"
        || (
          state.phase === "INVALID"
          && state.lockedChallengePack === null
        )
      )
    ) invalidRequest("Define structuring은 DRAFT/Define INVALID에서만 허용합니다.");
    assertMutationEnvelope({
      command,
      expectedSchema: "define-structure-command-v1",
      expectedTarget: "define",
      state,
    });
    const payload = exactPayload(
      command,
      ["actor_type", "actor_label"],
      "Define structuring",
    );
    actorLabel(payload, "Define structuring");
    const outcome = await dependencies.executeDefineStructure({
      ...(signal ? { signal } : {}),
    });
    const artifact = successfulDefineArtifact(
      outcome,
      dependencies.assertPersistedDefineArtifact,
    );
    if (artifact === null) {
      const failure: ChallengeLifecycleFailure = {
        code: "DEFINE_STRUCTURING_INCOMPLETE",
        phase: "DEFINE",
      };
      state = Object.freeze({
        ...state,
        phase: "INVALID",
        failure,
      });
      // phase receipt은 DRAFT에서 DEFINE INVALID로 직접 전이할 수 없으므로,
      // 이 실패는 persisted source만 남기고 새 chain head를 만들지 않습니다.
    } else {
      const next: ChallengeLifecycleSourceState = Object.freeze({
        phase: "PROPOSED",
        defineInput: state.defineInput,
        defineArtifact: artifact,
        lockedChallengePack: null,
        benchmarkId: null,
        startReceipt: null,
        progress: null,
        failure: null,
      });
      state = await checkpointLifecyclePhase("PROPOSED", next);
    }
    return Object.freeze({
      accepted: true,
      source_hash: currentSourceHash(state),
    });
  };

  const lockChallenge = async (
    command: ChallengeMutationCommand,
  ): Promise<ChallengeMutationResult> => {
    if (
      downstream !== null
      || state.defineArtifact === null
      || !(
        state.phase === "PROPOSED"
        || (
          state.phase === "INVALID"
          && state.lockedChallengePack === null
        )
      )
    ) invalidRequest("Challenge lock은 advisory PROPOSED에서만 허용합니다.");
    assertMutationEnvelope({
      command,
      expectedSchema: "challenge-lock-command-v1",
      expectedTarget:
        SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract.challenge_id,
      state,
    });
    const payload = exactPayload(command, [
      "actor_type",
      "actor_label",
      "decision",
      "define_structuring_artifact_hash",
      "approved_contract_hash",
    ], "Challenge lock");
    const label = actorLabel(payload, "Challenge lock");
    const expectedContractHash = sha256CanonicalJson(
      SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract,
    );
    if (
      payload.decision !== "APPROVE_EXACT_CONTRACT"
      || payload.define_structuring_artifact_hash
        !== state.defineArtifact.artifact_hash
      || payload.approved_contract_hash !== expectedContractHash
    ) {
      invalidRequest("Challenge lock의 exact artifact·contract hash 승인이 다릅니다.");
    }
    const pack = await dependencies.executeHumanLock({
      defineArtifact: state.defineArtifact,
      actorLabel: label,
      approvedContractHash: expectedContractHash,
      approvedAt: dependencies.now(),
    });
    dependencies.assertAuthoritativeLockedChallengePack(pack);
    assertLockedBinding({
      pack,
      artifact: state.defineArtifact,
      approvedContractHash: expectedContractHash,
    });
    const benchmarkId = dependencies.buildStableBenchmarkId(pack);
    if (!SHA256.test(benchmarkId)) {
      integrity("Canonical stable Benchmark ID가 full SHA-256이 아닙니다.");
    }
    const next: ChallengeLifecycleSourceState = Object.freeze({
      ...state,
      phase: "LOCKED",
      lockedChallengePack: pack,
      benchmarkId,
      startReceipt: null,
      progress: null,
      failure: null,
    });
    state = await checkpointLifecyclePhase("LOCKED", next);
    return Object.freeze({
      accepted: true,
      source_hash: currentSourceHash(state),
    });
  };

  const startBenchmark = async (
    command: ChallengeMutationCommand,
  ): Promise<ChallengeMutationResult> => {
    if (downstream !== null) {
      invalidRequest("완료된 Benchmark는 다시 시작할 수 없습니다.");
    }
    if (backgroundRunning || state.phase === "RUNNING") {
      invalidRequest("Benchmark가 이미 RUNNING single-flight 상태입니다.");
    }
    if (
      state.lockedChallengePack === null
      || !["LOCKED", "INVALID"].includes(state.phase)
    ) {
      invalidRequest("Benchmark는 LOCKED/INVALID 상태에서만 시작할 수 있습니다.");
    }
    const benchmarkId = state.benchmarkId;
    if (benchmarkId === null || !SHA256.test(benchmarkId)) {
      integrity("LOCKED lifecycle에 canonical stable Benchmark ID가 없습니다.");
    }
    assertMutationEnvelope({
      command,
      expectedSchema: "benchmark-start-command-v1",
      expectedTarget: benchmarkId,
      state,
    });
    const payload = exactPayload(command, [
      "actor_type",
      "actor_label",
      "execution_mode",
      "acknowledgement",
      "resume_from_progress_hash",
    ], "Benchmark start");
    const label = actorLabel(payload, "Benchmark start");
    if (
      !["START", "RESUME"].includes(String(payload.execution_mode))
      || payload.acknowledgement !== BENCHMARK_ACKNOWLEDGEMENT
      || !(
        payload.resume_from_progress_hash === null
        || (
          typeof payload.resume_from_progress_hash === "string"
          && SHA256.test(payload.resume_from_progress_hash)
        )
      )
    ) {
      invalidRequest("Benchmark start/resume exact 계약이 다릅니다.");
    }
    const executionMode = payload.execution_mode as "START" | "RESUME";
    const previous = state.progress;
    const resumeSourceHash = currentSourceHash(state);
    if (
      (
        executionMode === "START"
        && (
          state.phase !== "LOCKED"
          || state.startReceipt !== null
          || payload.resume_from_progress_hash !== null
        )
      )
      || (
        executionMode === "RESUME"
        && (
          state.phase !== "INVALID"
          || previous === null
          || previous.resume.allowed !== true
          || payload.resume_from_progress_hash
            !== resumeSourceHash
          || state.startReceipt === null
        )
      )
    ) {
      invalidRequest("현재 lifecycle과 Benchmark START/RESUME source가 다릅니다.");
    }
    const attemptNumber = executionMode === "START"
      ? 1
      : state.startReceipt!.attempt_number + 1;
    const startReceipt = buildBenchmarkStartCommandReceipt({
      benchmarkId,
      challengeId: state.lockedChallengePack.challenge_id,
      challengeVersion: state.lockedChallengePack.challenge_version,
      lockedChallengePackHash:
        state.lockedChallengePack.locked_challenge_pack_hash,
      actorLabel: label,
      executionMode,
      resumeFromProgressHash:
        executionMode === "RESUME"
          ? resumeSourceHash
          : null,
      attemptNumber,
      previousStartReceiptHash:
        executionMode === "RESUME"
          ? state.startReceipt!.receipt_hash
          : null,
      startedAt: dependencies.now(),
    });
    // RUNNING 전이를 append하기 전에 READY source/snapshot을 durable하게 남겨,
    // 전원 손실 뒤에도 LOCKED에서 실행을 시작하려 했다는 사실을 생략하지 않습니다.
    state = await checkpointLifecyclePhase("READY", state);
    const persisted = await dependencies.persistStartReceipt(startReceipt);
    const expectedPersistedReceipt = persisted.receipt ?? startReceipt;
    const reloaded = await dependencies.loadStartReceipt({
      path: persisted.path,
      expectedReceipt: expectedPersistedReceipt,
    });
    if (
      canonicalJsonStringify(reloaded)
        !== canonicalJsonStringify(expectedPersistedReceipt)
      || reloaded.receipt_hash !== expectedPersistedReceipt.receipt_hash
    ) {
      integrity("Source-reloaded Benchmark start receipt가 요청과 다릅니다.");
    }
    const lockedChallengePack = state.lockedChallengePack;
    if (lockedChallengePack === null) {
      integrity("READY checkpoint가 잠긴 Challenge authority를 제거했습니다.");
    }
    const next: ChallengeLifecycleSourceState = Object.freeze({
      ...state,
      phase: "RUNNING",
      startReceipt: reloaded,
      progress: null,
      failure: null,
    });
    state = await checkpointLifecyclePhase("RUNNING", next);
    backgroundRunning = true;
    dependencies.scheduleBackground(async () => {
      await runBenchmarkInBackground({
        lockedChallengePack,
        startReceipt: reloaded,
      });
    });
    return Object.freeze({
      accepted: true,
      source_hash: currentSourceHash(state),
    });
  };

  return Object.freeze({
    getLifecycleSnapshot: async () => {
      if (downstream !== null) {
        throw new TypeError(
          "Recorded review gateway 전환 뒤 lifecycle snapshot은 권위 읽기 경계가 아닙니다.",
        );
      }
      await refreshProgress();
      return lifecycleSnapshot();
    },
    isBenchmarkRunning: () => backgroundRunning,
    getWorkspace: async () => (await readGateway()).getWorkspace(),
    getChallenge: async (id: string) => (await readGateway()).getChallenge(id),
    getEvidence: async (id: string) => (await readGateway()).getEvidence(id),
    getBenchmarkProgress: async (id: string) => (
      (await readGateway()).getBenchmarkProgress(id)
    ),
    getBlindReview: async (id: string) => (
      (await readGateway()).getBlindReview(id)
    ),
    getDecision: async (id: string) => (await readGateway()).getDecision(id),
    getBaseline: async (id: string) => (await readGateway()).getBaseline(id),
    getRegression: async (id: string) => (
      (await readGateway()).getRegression(id)
    ),
    getReviewerBlindEvidenceDetail: async (
      input: Parameters<
        NonNullable<ReviewerBlindEvidenceGateway["getReviewerBlindEvidenceDetail"]>
      >[0],
    ) => {
      const activeDownstream = downstream as (
        ChallengeApiGateway & ReviewerBlindEvidenceGateway
      ) | null;
      const loader = activeDownstream?.getReviewerBlindEvidenceDetail;
      return loader === undefined ? null : loader(input);
    },
    structureDefine,
    lockChallenge,
    startBenchmark,
    confirmReview: async (command: ChallengeMutationCommand) => (
      downstream?.confirmReview(command) ?? throwUnavailable()
    ),
    createDecisionMemo: async (command: ChallengeMutationCommand) => (
      downstream?.createDecisionMemo(command) ?? throwUnavailable()
    ),
    confirmDecision: async (command: ChallengeMutationCommand) => (
      downstream?.confirmDecision(command) ?? throwUnavailable()
    ),
    startRegression: async (command: ChallengeMutationCommand) => (
      downstream?.startRegression(command) ?? throwUnavailable()
    ),
  });
}

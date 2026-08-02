import { FileMutationJournal } from "./artifactRepository";
import { isAbsolute, join, resolve } from "node:path";
import {
  executeDefineStructureCommand,
} from "../eval/cli/runDefineStructure";
import {
  executeProductionRecordedBenchmark,
  RECORDED_BENCHMARK_ACKNOWLEDGEMENT,
  RECORDED_BENCHMARK_ACKNOWLEDGEMENT_ENV,
  RECORDED_BENCHMARK_AUTHORITY_ENV,
} from "../eval/cli/runRecordedBenchmark";
import {
  assertAuthoritativeLockedChallengePack,
  createLockedChallengePack,
} from "../eval/define/defineContracts";
import {
  assertPersistedDefineStructuringArtifact,
  loadDefineStructuringArtifact,
} from "../eval/define/defineStructuringPersistence";
import {
  createLockedChallengeAuthorityPaths,
  loadLockedChallengeAuthorityRecord,
  persistLockedChallengeAuthorityRecord,
} from "../eval/define/lockedChallengePersistence";
import { prepareWriteOnceArtifactDirectory } from "../eval/pack/persistence";
import { SYNTHETIC_CHALLENGE_TEMPLATE } from "../eval/define/syntheticChallengeDefinition";
import {
  BENCHMARK_CASES,
  BENCHMARK_DATASET_HASH,
} from "../eval/data/benchmark";
import {
  buildStableBenchmarkId,
  openBenchmarkProgressJournal,
  type BenchmarkProgressJournal,
} from "../eval/benchmark/benchmarkProgressPersistence";
import { buildBenchmarkSchedule } from "../eval/benchmark/schedule";
import {
  assertPersistedRecordedBenchmarkPack,
  type RecordedBenchmarkPack,
} from "../eval/pack/recordedBenchmarkPack";
import { sha256CanonicalJson } from "../eval/runtime/canonicalJson";
import { canonicalJsonStringify } from "../eval/runtime/canonicalJson";
import {
  createAuthoritativeChallengeLifecycleController,
  type AuthoritativeChallengeLifecycleController,
  type AuthoritativeChallengeLifecycleDependencies,
} from "./authoritativeChallengeLifecycleController";
import type {
  AuthoritativeWorkflowControllerState,
} from "./authoritativeWorkflowController";
import type { RecordedReviewSnapshotSources } from "./recordedWorkflowSnapshot";
import type { ProjectionSnapshot } from "./projectionRepository";
import {
  buildPersistedBenchmarkProgressRecord,
  buildChallengeLifecycleProjectionSnapshot,
  loadBenchmarkStartCommandReceiptByAttemptIfPresent,
  loadBenchmarkStartCommandReceipt,
  persistBenchmarkStartCommandReceipt,
  type BenchmarkStartCommandReceipt,
  type ChallengeLifecycleAuthorityReferences,
  type ChallengeLifecycleDefineArtifact,
  type ChallengeLifecycleSourceState,
} from "./challengeLifecycleSnapshots";
import {
  loadAuthoritativeRuntimeHydrationIfPresent,
  persistAndAppendAuthoritativeRuntimePhase,
} from "./authoritativeRuntimeHydration";
import type {
  ChallengeApiGateway,
  ChallengeMutationJournal,
} from "./challengeServer";
import {
  startAuthoritativeWorkspaceServer,
  type ReadOnlyWorkspaceServer,
} from "./nodeWorkspaceServer";
import { assertTestOnlyServerEntrypoint } from "./testOnlyServerEntrypointGuard";

export interface AuthoritativeChallengeRoomRuntimeDependencies {
  readonly createLifecycleDependencies: (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly authorityDirectory: string;
    readonly signal?: AbortSignal;
  }) => AuthoritativeChallengeLifecycleDependencies;
  readonly createController: (input: {
    readonly dependencies: AuthoritativeChallengeLifecycleDependencies;
    readonly signal?: AbortSignal;
  }) => AuthoritativeChallengeLifecycleController | Promise<AuthoritativeChallengeLifecycleController>;
  readonly createMutationJournal: (
    directory: string,
  ) => ChallengeMutationJournal;
  readonly startServer: (input: {
    readonly gateway: ChallengeApiGateway;
    readonly mutationJournal: ChallengeMutationJournal;
    readonly staticDirectory: string;
    readonly port: number;
  }) => Promise<ReadOnlyWorkspaceServer>;
}

export interface AuthoritativeChallengeRoomRuntime {
  readonly server: ReadOnlyWorkspaceServer;
  readonly gateway: AuthoritativeChallengeLifecycleController;
  readonly closed: Promise<void>;
}

/**
 * 실제 외부 provider만 결정적 로컬 command로 교체하는 통합 테스트 seam입니다.
 * lifecycle controller·persistence·HTTP server·hydration 조립은 교체하지 않습니다.
 */
export interface AuthoritativeChallengeRoomProviderOverridesForTest {
  readonly executeDefineStructureCommand?: typeof executeDefineStructureCommand;
  readonly executeRecordedBenchmarkCommand?:
    typeof executeProductionRecordedBenchmark;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  location: string,
): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new TypeError(`${location}의 exact authority reference schema가 다릅니다.`);
  }
}

type BenchmarkStartAuthorityReference = Exclude<
  ChallengeLifecycleAuthorityReferences["benchmark_start_command"],
  null
>;

export function resolveBenchmarkStartAuthorityReferenceForCheckpoint({
  startReceipt,
  previousReference,
  persistedPath,
}: {
  readonly startReceipt: BenchmarkStartCommandReceipt | null;
  readonly previousReference:
    | BenchmarkStartAuthorityReference
    | null
    | undefined;
  readonly persistedPath: string | undefined;
}): BenchmarkStartAuthorityReference | null {
  if (startReceipt === null) {
    if (previousReference !== undefined && previousReference !== null) {
      throw new TypeError(
        "Benchmark start 영수증 없이 이전 authority reference를 유지할 수 없습니다.",
      );
    }
    return null;
  }
  const receiptHash = startReceipt.receipt_hash;
  if (
    previousReference !== undefined
    && previousReference !== null
    && previousReference.receipt_hash === receiptHash
  ) {
    return previousReference;
  }
  if (
    persistedPath === undefined
    || !isAbsolute(persistedPath)
    || (
      previousReference !== undefined
      && previousReference !== null
      && (
        startReceipt.execution_mode !== "RESUME"
        || startReceipt.attempt_number < 2
        || startReceipt.previous_start_receipt_hash
          !== previousReference.receipt_hash
      )
    )
    || (
      (previousReference === undefined || previousReference === null)
      && (
        startReceipt.execution_mode !== "START"
        || startReceipt.attempt_number !== 1
        || startReceipt.previous_start_receipt_hash !== null
      )
    )
  ) {
    throw new TypeError(
      "Benchmark start lifecycle checkpoint의 새 영수증이 이전 authority reference에 연결되지 않았습니다.",
    );
  }
  return Object.freeze({
    path: persistedPath,
    receipt_hash: receiptHash,
  });
}

function readAbsolutePath(value: unknown, location: string): string {
  if (
    typeof value !== "string"
    || !value.startsWith("/")
    || resolve(value) !== value
  ) {
    throw new TypeError(`${location}은 canonical absolute path여야 합니다.`);
  }
  return value;
}

function readSha256(value: unknown, location: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${location}은 lowercase SHA-256이어야 합니다.`);
  }
  return value;
}

function readLifecycleAuthorityReferences(
  value: unknown,
): ChallengeLifecycleAuthorityReferences {
  if (!isPlainRecord(value)) {
    throw new TypeError("lifecycle hydration에 private authority reference가 없습니다.");
  }
  assertExactKeys(value, [
    "schema_version",
    "define_artifact",
    "locked_challenge",
    "benchmark_start_command",
  ], "lifecycle authority references");
  if (value.schema_version !== "challenge-lifecycle-authority-references-v1") {
    throw new TypeError("lifecycle authority reference schema version이 다릅니다.");
  }
  const define = value.define_artifact;
  const locked = value.locked_challenge;
  const start = value.benchmark_start_command;
  const defineArtifact = define === null
    ? null
    : (() => {
      if (!isPlainRecord(define)) {
        throw new TypeError("Define authority reference가 객체가 아닙니다.");
      }
      assertExactKeys(define, ["path", "artifact_hash"], "Define authority reference");
      return Object.freeze({
        path: readAbsolutePath(define.path, "Define authority reference.path"),
        artifact_hash: readSha256(
          define.artifact_hash,
          "Define authority reference.artifact_hash",
        ),
      });
    })();
  const lockedChallenge = locked === null
    ? null
    : (() => {
      if (!isPlainRecord(locked)) {
        throw new TypeError("Locked Challenge authority reference가 객체가 아닙니다.");
      }
      assertExactKeys(locked, [
        "path",
        "challenge_id",
        "challenge_version",
        "locked_challenge_pack_hash",
      ], "Locked Challenge authority reference");
      if (
        typeof locked.challenge_id !== "string"
        || typeof locked.challenge_version !== "string"
        || locked.challenge_id.length === 0
        || locked.challenge_version.length === 0
      ) {
        throw new TypeError("Locked Challenge authority reference 좌표가 유효하지 않습니다.");
      }
      return Object.freeze({
        path: readAbsolutePath(locked.path, "Locked Challenge authority reference.path"),
        challenge_id: locked.challenge_id,
        challenge_version: locked.challenge_version,
        locked_challenge_pack_hash: readSha256(
          locked.locked_challenge_pack_hash,
          "Locked Challenge authority reference.locked_challenge_pack_hash",
        ),
      });
    })();
  const benchmarkStartCommand = start === null
    ? null
    : (() => {
      if (!isPlainRecord(start)) {
        throw new TypeError("Benchmark start authority reference가 객체가 아닙니다.");
      }
      assertExactKeys(start, ["path", "receipt_hash"], "Benchmark start authority reference");
      return Object.freeze({
        path: readAbsolutePath(start.path, "Benchmark start authority reference.path"),
        receipt_hash: readSha256(
          start.receipt_hash,
          "Benchmark start authority reference.receipt_hash",
        ),
      });
    })();
  return Object.freeze({
    schema_version: "challenge-lifecycle-authority-references-v1",
    define_artifact: defineArtifact,
    locked_challenge: lockedChallenge,
    benchmark_start_command: benchmarkStartCommand,
  });
}

async function reloadLifecycleSourceState({
  sourceState,
  authorityDirectory,
  dependencies,
}: {
  readonly sourceState: ChallengeLifecycleSourceState;
  readonly authorityDirectory: string;
  readonly dependencies: AuthoritativeChallengeLifecycleDependencies;
}): Promise<ChallengeLifecycleSourceState> {
  const hasPrivateSource = sourceState.defineArtifact !== null
    || sourceState.lockedChallengePack !== null
    || sourceState.startReceipt !== null;
  if (!hasPrivateSource) return sourceState;
  const references = readLifecycleAuthorityReferences(
    sourceState.lifecycleAuthorityReferences,
  );
  if ((sourceState.defineArtifact === null) !== (references.define_artifact === null)) {
    throw new TypeError("Define lifecycle source와 authority reference가 다릅니다.");
  }
  if ((sourceState.lockedChallengePack === null) !== (references.locked_challenge === null)) {
    throw new TypeError("Locked Challenge lifecycle source와 authority reference가 다릅니다.");
  }
  if ((sourceState.startReceipt === null) !== (references.benchmark_start_command === null)) {
    throw new TypeError("Benchmark start lifecycle source와 authority reference가 다릅니다.");
  }
  const reloadedDefine = sourceState.defineArtifact === null
    ? null
    : await loadDefineStructuringArtifact({
      outputDirectory: join(resolve(authorityDirectory), "define-structuring"),
      artifactPath: references.define_artifact!.path,
      expectedInput: sourceState.defineInput,
    });
  if (
    reloadedDefine !== null
    && (
      reloadedDefine.artifact_hash !== references.define_artifact!.artifact_hash
      || canonicalJsonStringify(reloadedDefine)
        !== canonicalJsonStringify(sourceState.defineArtifact)
    )
  ) {
    throw new TypeError("Define lifecycle source-reload 결과가 hydration state와 다릅니다.");
  }
  const reloadedLocked = sourceState.lockedChallengePack === null
    ? null
    : await loadLockedChallengeAuthorityRecord({
      outputDirectory: join(resolve(authorityDirectory), "locked-challenge"),
      challengeId: references.locked_challenge!.challenge_id,
      challengeVersion: references.locked_challenge!.challenge_version,
    });
  if (reloadedLocked !== null) {
    const expectedPath = createLockedChallengeAuthorityPaths({
      outputDirectory: join(resolve(authorityDirectory), "locked-challenge"),
      challengeId: references.locked_challenge!.challenge_id,
      challengeVersion: references.locked_challenge!.challenge_version,
      lockedChallengePackHash:
        references.locked_challenge!.locked_challenge_pack_hash,
    }).recordPath;
    if (
      references.locked_challenge!.path !== expectedPath
      || reloadedLocked.pack.locked_challenge_pack_hash
        !== references.locked_challenge!.locked_challenge_pack_hash
      || canonicalJsonStringify(reloadedLocked.pack)
        !== canonicalJsonStringify(sourceState.lockedChallengePack)
    ) {
      throw new TypeError("Locked Challenge source-reload 결과가 hydration state와 다릅니다.");
    }
  }
  let correctedStartReference = references.benchmark_start_command;
  let reloadedStart: BenchmarkStartCommandReceipt | null = null;
  if (sourceState.startReceipt !== null) {
    const currentReceipt = sourceState.startReceipt;
    if (
      references.benchmark_start_command!.receipt_hash
        !== currentReceipt.receipt_hash
    ) {
      if (
        currentReceipt.execution_mode !== "RESUME"
        || currentReceipt.attempt_number < 2
        || currentReceipt.previous_start_receipt_hash
          !== references.benchmark_start_command!.receipt_hash
      ) {
        throw new TypeError(
          "Benchmark start hydration reference 불일치가 RESUME receipt chain으로 설명되지 않습니다.",
        );
      }
      const outputDirectory = join(
        resolve(authorityDirectory),
        "benchmark-start-command",
      );
      const previous =
        await loadBenchmarkStartCommandReceiptByAttemptIfPresent({
          outputDirectory,
          benchmarkId: currentReceipt.benchmark_id,
          attemptNumber: currentReceipt.attempt_number - 1,
        });
      const current =
        await loadBenchmarkStartCommandReceiptByAttemptIfPresent({
          outputDirectory,
          benchmarkId: currentReceipt.benchmark_id,
          attemptNumber: currentReceipt.attempt_number,
        });
      if (
        previous === null
        || current === null
        || previous.path !== references.benchmark_start_command!.path
        || previous.receipt.receipt_hash
          !== references.benchmark_start_command!.receipt_hash
        || current.receipt.receipt_hash !== currentReceipt.receipt_hash
      ) {
        throw new TypeError(
          "Benchmark start hydration reference를 canonical RESUME receipt chain에서 복구할 수 없습니다.",
        );
      }
      correctedStartReference = Object.freeze({
        path: current.path,
        receipt_hash: current.receipt.receipt_hash,
      });
    }
    reloadedStart = await dependencies.loadStartReceipt({
      path: correctedStartReference!.path,
      expectedReceipt: currentReceipt,
    });
  }
  if (
    reloadedStart !== null
    && (
      reloadedStart.receipt_hash
        !== correctedStartReference!.receipt_hash
      || canonicalJsonStringify(reloadedStart)
        !== canonicalJsonStringify(sourceState.startReceipt)
    )
  ) {
    throw new TypeError("Benchmark start source-reload 결과가 hydration state와 다릅니다.");
  }
  return Object.freeze({
    ...sourceState,
    defineArtifact: reloadedDefine as unknown as ChallengeLifecycleDefineArtifact | null,
    lockedChallengePack: reloadedLocked?.pack ?? null,
    startReceipt: reloadedStart,
    lifecycleAuthorityReferences: Object.freeze({
      ...references,
      benchmark_start_command: correctedStartReference,
    }),
  });
}

export interface ProductionChallengeLifecycleDependencyOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly authorityDirectory: string;
  readonly projectionDirectory?: string;
  readonly runtimeWorkflowId?: string;
  readonly signal?: AbortSignal;
  readonly createRecordedReviewGateway: (
    input: Readonly<{
      recordedBenchmarkPack: RecordedBenchmarkPack;
      lockedChallengePack: import("../eval/define/defineContracts").LockedChallengePack;
      lifecycleState: import("./challengeLifecycleSnapshots").ChallengeLifecycleSourceState;
      hydration?: Readonly<{
        initialSources: RecordedReviewSnapshotSources;
        controllerState: AuthoritativeWorkflowControllerState;
        initialSnapshot: ProjectionSnapshot;
        sourceAuthorityRefs: Record<string, unknown>;
      }>;
    }>,
  ) => Promise<ChallengeApiGateway>;
  readonly now?: () => string;
}

function createChallengeLifecycleDependenciesCore({
  environment,
  authorityDirectory,
  projectionDirectory = join(resolve(authorityDirectory), "../projections"),
  runtimeWorkflowId = "synthetic-recorded-challenge",
  signal,
  createRecordedReviewGateway,
  providerOverridesForTest,
  now = () => new Date().toISOString(),
}: ProductionChallengeLifecycleDependencyOptions & {
  readonly providerOverridesForTest?:
    AuthoritativeChallengeRoomProviderOverridesForTest;
}): AuthoritativeChallengeLifecycleDependencies {
  const root = resolve(authorityDirectory);
  const defineDirectory = join(root, "define-structuring");
  const lockedDirectory = join(root, "locked-challenge");
  const benchmarkDirectory = join(root, "recorded-benchmark");
  const startCommandDirectory = join(root, "benchmark-start-command");
  const schedule = buildBenchmarkSchedule(BENCHMARK_CASES, ["A", "B", "C"]);
  let journal: BenchmarkProgressJournal | null = null;
  let runtimeHead: string | null = null;
  let runtimeCheckpoint: {
    readonly phase: string;
    readonly lifecycleState: ChallengeLifecycleSourceState;
    readonly projectionSnapshot: ProjectionSnapshot;
  } | null = null;
  const defineArtifactPaths = new Map<string, string>();
  const benchmarkStartReceiptPaths = new Map<string, string>();
  const lifecycleStateWithAuthorityReferences = (
    sourceState: ChallengeLifecycleSourceState,
  ): ChallengeLifecycleSourceState => {
    const previous = sourceState.lifecycleAuthorityReferences;
    const previousDefine = previous?.define_artifact;
    const defineReference = sourceState.defineArtifact === null
      ? null
      : (() => {
        const path = previous?.define_artifact?.path
          ?? defineArtifactPaths.get(sourceState.defineArtifact!.artifact_hash);
        if (
          path === undefined
          || (previousDefine !== undefined && previousDefine !== null
            && previousDefine.artifact_hash
              !== sourceState.defineArtifact!.artifact_hash)
        ) {
          throw new TypeError("Define lifecycle checkpoint에 persisted authority path가 없습니다.");
        }
        return Object.freeze({
          path,
          artifact_hash: sourceState.defineArtifact!.artifact_hash,
        });
      })();
    const previousLocked = previous?.locked_challenge;
    const lockedReference = sourceState.lockedChallengePack === null
      ? null
      : (() => {
        const pack = sourceState.lockedChallengePack!;
        const path = createLockedChallengeAuthorityPaths({
          outputDirectory: lockedDirectory,
          challengeId: pack.challenge_id,
          challengeVersion: pack.challenge_version,
          lockedChallengePackHash: pack.locked_challenge_pack_hash,
        }).recordPath;
        if (previousLocked !== undefined && previousLocked !== null && (
          previousLocked.path !== path
          || previousLocked.challenge_id !== pack.challenge_id
          || previousLocked.challenge_version !== pack.challenge_version
          || previousLocked.locked_challenge_pack_hash
            !== pack.locked_challenge_pack_hash
        )) {
          throw new TypeError("Locked Challenge lifecycle checkpoint authority reference가 다릅니다.");
        }
        return Object.freeze({
          path,
          challenge_id: pack.challenge_id,
          challenge_version: pack.challenge_version,
          locked_challenge_pack_hash: pack.locked_challenge_pack_hash,
        });
      })();
    const previousStart = previous?.benchmark_start_command;
    const startReference =
      resolveBenchmarkStartAuthorityReferenceForCheckpoint({
        startReceipt: sourceState.startReceipt,
        previousReference: previousStart,
        persistedPath: sourceState.startReceipt === null
          ? undefined
          : benchmarkStartReceiptPaths.get(
            sourceState.startReceipt.receipt_hash,
          ),
      });
    const references: ChallengeLifecycleAuthorityReferences = Object.freeze({
      schema_version: "challenge-lifecycle-authority-references-v1",
      define_artifact: defineReference,
      locked_challenge: lockedReference,
      benchmark_start_command: startReference,
    });
    return Object.freeze({
      ...sourceState,
      lifecycleAuthorityReferences: references,
    });
  };
  const checkpointLifecyclePhase: NonNullable<
    AuthoritativeChallengeLifecycleDependencies["checkpointLifecyclePhase"]
  > = async ({ phase, sourceState }) => {
    const lifecycleState = lifecycleStateWithAuthorityReferences(sourceState);
    const projectionSnapshot = buildChallengeLifecycleProjectionSnapshot(
      lifecycleState,
      { runtimePhase: phase },
    );
    if (runtimeHead === null) {
      const existing = await loadAuthoritativeRuntimeHydrationIfPresent({
        outputDirectory: root,
        workflowId: runtimeWorkflowId,
      });
      runtimeHead = existing?.chain.head.receipt_sha256 ?? null;
      if (existing !== null) {
        runtimeCheckpoint = {
          phase: existing.artifact.phase,
          lifecycleState: existing.artifact.lifecycle_state,
          projectionSnapshot: existing.projectionSnapshot,
        };
      }
    }
    if (runtimeCheckpoint?.phase === phase) {
      if (
        canonicalJsonStringify(runtimeCheckpoint.lifecycleState)
          !== canonicalJsonStringify(lifecycleState)
        || canonicalJsonStringify(runtimeCheckpoint.projectionSnapshot)
          !== canonicalJsonStringify(projectionSnapshot)
      ) {
        throw new TypeError(
          "같은 runtime phase의 재시도가 기존 권위 상태와 다릅니다.",
        );
      }
      return lifecycleState;
    }
    // 첫 mutable transition은 DRAFT genesis를 함께 남깁니다. DRAFT는 비용
    // 발생 없이 결정적으로 재빌드되며 이후 모든 phase는 이 head에만 append됩니다.
    if (runtimeHead === null && phase !== "PROPOSED") {
      throw new TypeError("새 runtime phase chain은 PROPOSED 전에 DRAFT genesis가 필요합니다.");
    }
    if (runtimeHead === null) {
      const draftState = {
        phase: "DRAFT" as const,
        defineInput: sourceState.defineInput,
        defineArtifact: null,
        lockedChallengePack: null,
        benchmarkId: null,
        startReceipt: null,
        progress: null,
        failure: null,
      };
      const draft = await persistAndAppendAuthoritativeRuntimePhase({
        outputDirectory: root,
        projectionOutputDirectory: resolve(projectionDirectory),
        workflowId: runtimeWorkflowId,
        phase: "DRAFT",
        expectedPreviousReceiptSha256: null,
        lifecycleState: lifecycleStateWithAuthorityReferences(draftState),
        projectionSnapshot: buildChallengeLifecycleProjectionSnapshot(
          draftState,
          { runtimePhase: "DRAFT" },
        ),
      });
      runtimeHead = draft.receiptSha256;
      runtimeCheckpoint = {
        phase: "DRAFT",
        lifecycleState: draftState,
        projectionSnapshot: buildChallengeLifecycleProjectionSnapshot(
          draftState,
          { runtimePhase: "DRAFT" },
        ),
      };
    }
    const persisted = await persistAndAppendAuthoritativeRuntimePhase({
      outputDirectory: root,
      projectionOutputDirectory: resolve(projectionDirectory),
      workflowId: runtimeWorkflowId,
      phase,
      expectedPreviousReceiptSha256: runtimeHead,
      lifecycleState,
      projectionSnapshot,
    });
    runtimeHead = persisted.receiptSha256;
    runtimeCheckpoint = { phase, lifecycleState, projectionSnapshot };
    return lifecycleState;
  };
  return {
    executeDefineStructure: async () => {
      const outcome = await (
        providerOverridesForTest?.executeDefineStructureCommand
        ?? executeDefineStructureCommand
      )({
        environment,
        outputDirectory: defineDirectory,
        ...(signal ? { signal } : {}),
      });
      const artifact = outcome.serverAuthority?.defineStructuringArtifact;
      if (
        artifact !== undefined
        && outcome.summary.artifact_path !== null
        && outcome.summary.artifact_hash === artifact.artifact_hash
      ) {
        defineArtifactPaths.set(artifact.artifact_hash, outcome.summary.artifact_path);
      }
      return outcome;
    },
    assertPersistedDefineArtifact: assertPersistedDefineStructuringArtifact,
    executeHumanLock: async ({
      defineArtifact,
      actorLabel,
      approvedContractHash,
      approvedAt,
    }) => {
      assertPersistedDefineStructuringArtifact(defineArtifact);
      if (
        approvedContractHash
          !== sha256CanonicalJson(
            SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract,
          )
        || defineArtifact.run_record.suggestion === null
      ) {
        throw new TypeError("Production lock의 exact approved contract가 다릅니다.");
      }
      const creationInput = {
        defineInput: defineArtifact.define_input,
        defineSuggestion: defineArtifact.run_record.suggestion,
        approval: {
          schema_version: "human-challenge-approval-v1" as const,
          synthetic: true as const,
          actor_type: "HUMAN" as const,
          actor_label: actorLabel,
          decision: "APPROVE_EXACT_CONTRACT" as const,
          approved_at: approvedAt,
          define_input_hash: sha256CanonicalJson(
            defineArtifact.define_input,
          ),
          define_suggestion_hash: sha256CanonicalJson(
            defineArtifact.run_record.suggestion,
          ),
          approved_contract: structuredClone(
            SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract,
          ),
        },
      };
      const pack = createLockedChallengePack(creationInput);
      await prepareWriteOnceArtifactDirectory({
        rootDirectory: root,
        artifactDirectory: lockedDirectory,
      });
      await persistLockedChallengeAuthorityRecord({
        outputDirectory: lockedDirectory,
        creationInput,
        pack,
      });
      return (
        await loadLockedChallengeAuthorityRecord({
          outputDirectory: lockedDirectory,
          challengeId: pack.challenge_id,
          challengeVersion: pack.challenge_version,
        })
      ).pack;
    },
    assertAuthoritativeLockedChallengePack,
    buildStableBenchmarkId: (pack) => buildStableBenchmarkId({
      lockedChallengePackHash: pack.locked_challenge_pack_hash,
      hiddenDatasetHash: BENCHMARK_DATASET_HASH,
      scheduleId: schedule.schedule_id,
    }),
    persistStartReceipt: async (receipt) => {
      const pending =
        await loadBenchmarkStartCommandReceiptByAttemptIfPresent({
          outputDirectory: startCommandDirectory,
          benchmarkId: receipt.benchmark_id,
          attemptNumber: receipt.attempt_number,
        });
      if (pending !== null) {
        const {
          started_at: _pendingStartedAt,
          receipt_hash: _pendingReceiptHash,
          ...pendingBinding
        } = pending.receipt;
        const {
          started_at: _requestedStartedAt,
          receipt_hash: _requestedReceiptHash,
          ...requestedBinding
        } = receipt;
        if (
          canonicalJsonStringify(pendingBinding)
            !== canonicalJsonStringify(requestedBinding)
        ) {
          throw new TypeError(
            "기존 Benchmark start attempt가 현재 재시도 요청과 다릅니다.",
          );
        }
        benchmarkStartReceiptPaths.set(
          pending.receipt.receipt_hash,
          pending.path,
        );
        return {
          path: pending.path,
          receiptHash: pending.receipt.receipt_hash,
          receipt: pending.receipt,
        };
      }
      const persisted = await persistBenchmarkStartCommandReceipt({
        outputDirectory: startCommandDirectory,
        receipt,
      });
      benchmarkStartReceiptPaths.set(receipt.receipt_hash, persisted.path);
      return { ...persisted, receipt };
    },
    loadStartReceipt: ({ path, expectedReceipt }) => (
      loadBenchmarkStartCommandReceipt({
        outputDirectory: startCommandDirectory,
        path,
        expectedReceipt,
      })
    ),
    loadPersistedProgress: async ({
      benchmarkId,
      lockedChallengePack,
      attemptNumber,
    }) => {
      if (journal === null || journal.benchmarkId !== benchmarkId) return null;
      const projection = journal.currentProjection();
      return buildPersistedBenchmarkProgressRecord({
        benchmarkId,
        challengeId: lockedChallengePack.challenge_id,
        lockedChallengePackHash:
          lockedChallengePack.locked_challenge_pack_hash,
        attemptNumber,
        // Journal COMPLETE는 background outcome의 72+12+33/33 검증 뒤
        // downstream으로 원자 전환되므로 controller 내부에서는 RUNNING입니다.
        status: "RUNNING",
        candidateExecutionCompleted: projection.completed,
        auxiliaryJudgeCompleted: 0,
        cleanupAcknowledged:
          projection.cleanup?.acknowledged ?? 0,
        checkpointSource: projection.checkpoint_source,
        resumeAllowed: false,
        resumeAction: "NONE",
        failure: null,
        updatedAt: now(),
      });
    },
    executeRecordedBenchmark: async ({ lockedChallengePack }) => {
      journal = await openBenchmarkProgressJournal({
        outputDirectory: benchmarkDirectory,
        lockedChallengePackHash:
          lockedChallengePack.locked_challenge_pack_hash,
        hiddenDatasetHash: BENCHMARK_DATASET_HASH,
        scheduleId: schedule.schedule_id,
      });
      return (
        providerOverridesForTest?.executeRecordedBenchmarkCommand
        ?? executeProductionRecordedBenchmark
      )({
        environment: {
          ...environment,
          [RECORDED_BENCHMARK_ACKNOWLEDGEMENT_ENV]:
            RECORDED_BENCHMARK_ACKNOWLEDGEMENT,
          [RECORDED_BENCHMARK_AUTHORITY_ENV.directory]:
            lockedDirectory,
          [RECORDED_BENCHMARK_AUTHORITY_ENV.challengeId]:
            lockedChallengePack.challenge_id,
          [RECORDED_BENCHMARK_AUTHORITY_ENV.challengeVersion]:
            lockedChallengePack.challenge_version,
        },
        outputDirectory: benchmarkDirectory,
        lifecycleJournal: journal,
        ...(signal ? { signal } : {}),
      });
    },
    assertPersistedRecordedBenchmarkPack,
    createRecordedReviewGateway,
    checkpointLifecyclePhase,
    scheduleBackground: (task) => {
      setImmediate(() => { void task(); });
    },
    now,
  };
}

export function createProductionChallengeLifecycleDependencies(
  options: ProductionChallengeLifecycleDependencyOptions,
): AuthoritativeChallengeLifecycleDependencies {
  return createChallengeLifecycleDependenciesCore(options);
}

async function startWithDependencies({
  environment,
  staticDirectory,
  authorityDirectory,
  port,
  signal,
  dependencies,
}: {
  readonly environment: NodeJS.ProcessEnv;
  readonly staticDirectory: string;
  readonly authorityDirectory: string;
  readonly port: number;
  readonly signal?: AbortSignal;
  readonly dependencies: AuthoritativeChallengeRoomRuntimeDependencies;
}): Promise<AuthoritativeChallengeRoomRuntime> {
  // 이 factory는 함수 참조와 로컬 경로만 조립하며 OpenAI를 호출하지 않습니다.
  const lifecycleDependencies = dependencies.createLifecycleDependencies({
    environment,
    authorityDirectory,
    ...(signal ? { signal } : {}),
  });
  const gateway = await dependencies.createController({
    dependencies: lifecycleDependencies,
    ...(signal ? { signal } : {}),
  });
  const mutationJournal = dependencies.createMutationJournal(
    `${authorityDirectory}/mutation-journal`,
  );
  // 유일한 비용 발생 경로는 gateway POST 뒤에 있으므로 listen이 항상 먼저입니다.
  const server = await dependencies.startServer({
    gateway,
    mutationJournal,
    staticDirectory,
    port,
  });
  let closePromise: Promise<void> | null = null;
  const close = () => {
    closePromise ??= server.close();
    return closePromise;
  };
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const onAbort = () => {
    void close().finally(resolveClosed);
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return Object.freeze({ server, gateway, closed });
}

export function startAuthoritativeChallengeRoomRuntimeForTest(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly staticDirectory: string;
  readonly authorityDirectory: string;
  readonly port: number;
  readonly signal?: AbortSignal;
  readonly dependencies: AuthoritativeChallengeRoomRuntimeDependencies;
}): Promise<AuthoritativeChallengeRoomRuntime> {
  assertTestOnlyServerEntrypoint();
  return startWithDependencies(input);
}

/**
 * Production composition은 아래 factory의 함수 참조를 조립한 뒤 같은
 * listen-first 경계를 사용합니다. 실제 Define/Benchmark adapter는 별도
 * production dependency builder가 제공합니다.
 */
interface AuthoritativeChallengeRoomProductionRuntimeInput {
  readonly environment: NodeJS.ProcessEnv;
  readonly staticDirectory: string;
  readonly authorityDirectory: string;
  readonly port: number;
  readonly signal?: AbortSignal;
  readonly createRecordedReviewGateway: (
    input: Readonly<{
      recordedBenchmarkPack: RecordedBenchmarkPack;
      lockedChallengePack: import("../eval/define/defineContracts").LockedChallengePack;
      lifecycleState: import("./challengeLifecycleSnapshots").ChallengeLifecycleSourceState;
      hydration?: Readonly<{
        initialSources: RecordedReviewSnapshotSources;
        controllerState: AuthoritativeWorkflowControllerState;
        initialSnapshot: ProjectionSnapshot;
        sourceAuthorityRefs: Record<string, unknown>;
      }>;
    }>,
  ) => Promise<ChallengeApiGateway>;
}

function startAuthoritativeChallengeRoomRuntimeCore(
  input: AuthoritativeChallengeRoomProductionRuntimeInput,
  providerOverridesForTest?: AuthoritativeChallengeRoomProviderOverridesForTest,
  nowForTest?: () => string,
): Promise<AuthoritativeChallengeRoomRuntime> {
  const productionDependencies:
  AuthoritativeChallengeRoomRuntimeDependencies = {
    createLifecycleDependencies: (options) => (
      createChallengeLifecycleDependenciesCore({
        ...options,
        createRecordedReviewGateway: input.createRecordedReviewGateway,
        ...(providerOverridesForTest === undefined
          ? {}
          : {
            providerOverridesForTest,
          }),
        ...(nowForTest === undefined ? {} : { now: nowForTest }),
      })
    ),
    createController: async ({ dependencies, signal }) => {
      const hydrated = await loadAuthoritativeRuntimeHydrationIfPresent({
        outputDirectory: input.authorityDirectory,
        workflowId: "synthetic-recorded-challenge",
      });
      if (hydrated === null) {
        return createAuthoritativeChallengeLifecycleController({
          dependencies,
          ...(signal ? { signal } : {}),
        });
      }
      if ([
        "REVIEW_PENDING",
        "HUMAN_CONFIRMED_REVIEW",
        "MEMO_REVIEW_REQUIRED",
        "DECISION_CONFIRMED",
        "NO_APPROVED_CANDIDATE",
        "REGRESSION_RECORDED",
      ].includes(hydrated.artifact.phase)) {
        const workflow = hydrated.artifact.workflow_state;
        if (
          workflow === null
          || typeof workflow.initial_sources !== "object"
          || workflow.initial_sources === null
          || typeof workflow.controller_state !== "object"
          || workflow.controller_state === null
        ) {
          throw new TypeError("workflow phase hydration에 exact source state가 없습니다.");
        }
        const initialSources = workflow.initial_sources as unknown as RecordedReviewSnapshotSources;
        const controllerState = workflow.controller_state as unknown as AuthoritativeWorkflowControllerState;
        const sourceAuthorityRefs = workflow.source_authority_refs;
        if (
          typeof sourceAuthorityRefs !== "object"
          || sourceAuthorityRefs === null
          || Array.isArray(sourceAuthorityRefs)
        ) {
          throw new TypeError("workflow phase hydration에 source authority reference가 없습니다.");
        }
        const sourceState = await reloadLifecycleSourceState({
          sourceState: hydrated.artifact.lifecycle_state,
          authorityDirectory: input.authorityDirectory,
          dependencies,
        });
        const downstream = await input.createRecordedReviewGateway({
          recordedBenchmarkPack: initialSources.recordedBenchmarkPack,
          lockedChallengePack: initialSources.lockedChallengePack,
          lifecycleState: sourceState,
          hydration: {
            initialSources,
            controllerState,
            initialSnapshot: hydrated.projectionSnapshot,
            sourceAuthorityRefs: sourceAuthorityRefs as Record<string, unknown>,
          },
        });
        return createAuthoritativeChallengeLifecycleController({
          dependencies,
          ...(signal ? { signal } : {}),
          initialState: {
            sourceState,
            downstream,
          },
        });
      }
      if (![
        "DRAFT",
        "PROPOSED",
        "LOCKED",
        "READY",
        "RUNNING",
        "INVALID",
      ].includes(hydrated.artifact.phase)) {
        throw new TypeError(
          "runtime phase hydration의 단계가 허용된 lifecycle/workflow 집합과 다릅니다.",
        );
      }
      const sourceState = await reloadLifecycleSourceState({
        sourceState: hydrated.artifact.lifecycle_state,
        authorityDirectory: input.authorityDirectory,
        dependencies,
      });
      const rebuilt = buildChallengeLifecycleProjectionSnapshot(
        sourceState,
        { runtimePhase: hydrated.artifact.phase },
      );
      if (
        canonicalJsonStringify(rebuilt)
        !== canonicalJsonStringify(hydrated.projectionSnapshot)
      ) {
        throw new TypeError("runtime hydration의 lifecycle source와 projection이 다릅니다.");
      }
      return createAuthoritativeChallengeLifecycleController({
        dependencies,
        ...(signal ? { signal } : {}),
        initialState: {
          sourceState,
        },
      });
    },
    createMutationJournal: (directory) => new FileMutationJournal(directory),
    startServer: startAuthoritativeWorkspaceServer,
  };
  return startWithDependencies({
    ...input,
    dependencies: productionDependencies,
  });
}

export function startAuthoritativeChallengeRoomRuntime(
  input: AuthoritativeChallengeRoomProductionRuntimeInput,
): Promise<AuthoritativeChallengeRoomRuntime> {
  return startAuthoritativeChallengeRoomRuntimeCore(input);
}

/**
 * 외부 provider command만 결정적 fixture로 바꾸는 process 통합 테스트
 * 전용 entrypoint입니다. Production entrypoint의 입력 계약에는 이 seam이
 * 존재하지 않습니다.
 */
export function startAuthoritativeChallengeRoomRuntimeWithProviderOverridesForTest(
  options: AuthoritativeChallengeRoomProductionRuntimeInput & {
    readonly providerOverridesForTest:
      AuthoritativeChallengeRoomProviderOverridesForTest;
    readonly nowForTest?: () => string;
  },
): Promise<AuthoritativeChallengeRoomRuntime> {
  assertTestOnlyServerEntrypoint();
  const {
    providerOverridesForTest,
    nowForTest,
    ...input
  } = options;
  return startAuthoritativeChallengeRoomRuntimeCore(
    input,
    providerOverridesForTest,
    nowForTest,
  );
}

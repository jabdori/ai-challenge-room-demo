// @vitest-environment node

import { chmod, lstat, mkdir, mkdtemp, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  reloadAuthoritativeWorkflowControllerStateForColdStart,
  reviewerBootstrapCliOutput,
  startAuthoritativeChallengeRoomFromEnvironmentForTest,
  type AuthoritativeColdSourceReload,
} from "../authoritativeChallengeRoomProcess";
import type { ChallengeLifecycleSourceState } from "../challengeLifecycleSnapshots";
import { persistAndAppendAuthoritativeRuntimePhase } from "../authoritativeRuntimeHydration";
import type { AuthoritativeRuntimePhase } from "../authoritativeRuntimePhaseReceipt";
import {
  buildProjectionSnapshot,
  createReadOnlyProjectionGateway,
  type ProjectionSnapshot,
} from "../projectionRepository";
import { sha256CanonicalJson } from "../../eval/runtime/canonicalJson";
import { SYNTHETIC_CHALLENGE_TEMPLATE } from "../../eval/define/syntheticChallengeDefinition";
import {
  buildBenchmarkStartCommandReceipt,
  buildChallengeLifecycleProjectionSnapshot,
  loadBenchmarkStartCommandReceipt,
  persistBenchmarkStartCommandReceipt,
} from "../challengeLifecycleSnapshots";
import {
  createLockedChallengeFixtureBundle,
} from "../../eval/test/helpers/lockedChallengeFixture";
import {
  createPersistedRecordedRegressionFixture,
} from "../../eval/test/helpers/recordedRegressionFixture";
import {
  loadLockedChallengeAuthorityRecord,
  persistLockedChallengeAuthorityRecord,
} from "../../eval/define/lockedChallengePersistence";
import {
  buildDefineStructuringArtifact,
  loadDefineStructuringArtifact,
  persistDefineStructuringArtifact,
} from "../../eval/define/defineStructuringPersistence";
import { runDefineStructuring } from "../../eval/define/runDefineStructuring";
import { buildStableBenchmarkId } from "../../eval/benchmark/benchmarkProgressPersistence";
import { buildBenchmarkSchedule } from "../../eval/benchmark/schedule";
import {
  BENCHMARK_CASES,
  BENCHMARK_DATASET_HASH,
} from "../../eval/data/benchmark";
import {
  buildAiPreReviewReceipt,
  loadAiPreReviewReceipt,
  persistAiPreReviewReceipt,
} from "../../eval/review/preReviewReceipt";
import {
  buildHumanConfirmationReceipt,
  createHumanConfirmationExpectedContext,
} from "../../eval/review/humanConfirmation";
import {
  buildProvisionalDecisionMemo,
  loadProvisionalDecisionMemo,
  persistProvisionalDecisionMemo,
} from "../../eval/decision/provisionalMemo";
import {
  buildRecordedDecisionProjectionSnapshot,
  buildRecordedReviewProjectionSnapshot,
} from "../recordedWorkflowSnapshot";
import { reviewerBlindEvidenceHandle } from "../workflowProjections";
import { createOpenAIFinalDecisionMemoAdapter } from "../../eval/decision/openaiFinalDecisionMemoAdapter";
import { buildDeterministicAiPreReviewCommand } from "../authoritativeWorkspaceRuntime";
import { reloadRecordedBenchmarkPackForColdStart } from "../../eval/pack/coldRecordedBenchmarkReload";

async function recordedReviewSourceFixture() {
  (globalThis as { __reuseRecordedReviewFixture?: boolean })
    .__reuseRecordedReviewFixture = true;
  const { createPersistedRecordedBenchmarkColdFixture } = await import(
    "../../eval/test/reviewQueueBuilder.test"
  );
  const module = await import("../../eval/test/reviewQueueBuilder.test");
  return {
    createPersistedRecordedBenchmarkColdFixture,
    createPersistedRecordedWorkflowControllerStateFixture:
      module.createPersistedRecordedWorkflowControllerStateFixture,
  };
}

async function secureDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  return realpath(directory);
}

async function secureChildDirectory(
  parentDirectory: string,
  name: string,
): Promise<string> {
  const directory = join(parentDirectory, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return realpath(directory);
}

/**
 * 실제 listener가 별도 reviewer bootstrap URL로 전달한 단발성 세션만 사용합니다.
 * 일반 workspace 요청에는 이 헤더를 붙이지 않아 public projection 경계를 함께
 * 검증할 수 있습니다.
 */
function reviewerHeaders({
  origin,
  reviewerBootstrapUrl,
}: {
  readonly origin: string;
  readonly reviewerBootstrapUrl?: string;
}): Readonly<Record<string, string>> {
  if (reviewerBootstrapUrl === undefined) {
    throw new Error("Reviewer bootstrap URL이 listener에서 제공되지 않았습니다.");
  }
  const url = new URL(reviewerBootstrapUrl);
  const params = new URLSearchParams(url.hash.slice(1));
  const reviewerToken = params.get("reviewer_token");
  if (
    url.origin !== origin || url.pathname !== "/" || url.search !== ""
    || params.size !== 1 || reviewerToken === null
  ) {
    throw new Error("Reviewer bootstrap URL 형식이 유효하지 않습니다.");
  }
  return Object.freeze({
    authorization: `Bearer ${reviewerToken}`,
    origin,
    "sec-fetch-site": "same-origin",
  });
}

function persistedWorkflowSnapshot({
  reviewId,
  decisionId,
  baselineId,
  regressionId,
  decideStatus,
  monitorStatus,
}: {
  readonly reviewId: string | null;
  readonly decisionId: string | null;
  readonly baselineId: string | null;
  readonly regressionId: string | null;
  readonly decideStatus: string;
  readonly monitorStatus: string;
}): ProjectionSnapshot {
  const source = Object.freeze({
    artifact_kind: "RESTART_FIXTURE_SOURCE",
    phase: decideStatus,
  });
  const sourceHash = sha256CanonicalJson(source);
  return buildProjectionSnapshot({
    source_chain: [{
      artifact_kind: source.artifact_kind,
      artifact_id: `fixture_${decideStatus.replaceAll(" ", "_")}`,
      payload_sha256: sourceHash,
    }],
    workspace: {
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
      challenge_id: "challenge_restart_1",
      benchmark_id: "benchmark_restart_1",
      review_id: reviewId,
      decision_id: decisionId,
      baseline_id: baselineId,
      regression_id: regressionId,
      source_hash: sourceHash,
      stage_statuses: {
        define: "LOCKED",
        compare: "RECORDED",
        decide: decideStatus,
        monitor: monitorStatus,
      },
    },
    challenges: [],
    evidence: [],
    benchmark_progress: [],
    blind_reviews: reviewId === null ? [] : [{
      schema_version: "preconfirmation-public-projection-v1",
      synthetic: true,
      review_id: reviewId,
      source_hash: sourceHash,
    }],
    decisions: decisionId === null ? [] : [{
      schema_version: "decision-public-projection-v1",
      synthetic: true,
      decision_id: decisionId,
      source_hash: sourceHash,
    }],
    baselines: baselineId === null ? [] : [{
      schema_version: "baseline-public-projection-v1",
      synthetic: true,
      baseline_id: baselineId,
      source_hash: sourceHash,
    }],
    regressions: regressionId === null ? [] : [{
      schema_version: "regression-public-projection-v1",
      synthetic: true,
      regression_id: regressionId,
      source_hash: sourceHash,
    }],
  });
}

const completedLifecycleState: ChallengeLifecycleSourceState = Object.freeze({
  // workflow phase 이후에는 lifecycle이 이미 끝났으며, startup은 downstream만
  // source-reload해야 합니다. 이 상태는 lifecycle controller의 hydration
  // validator가 요구하는 COMPLETE/downstream 결합을 직접 검증합니다.
  phase: "COMPLETE",
  defineInput: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
  defineArtifact: null,
  lockedChallengePack: null,
  benchmarkId: null,
  startReceipt: null,
  progress: null,
  failure: null,
});

const draftLifecycleState: ChallengeLifecycleSourceState = Object.freeze({
  phase: "DRAFT",
  defineInput: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
  defineArtifact: null,
  lockedChallengePack: null,
  benchmarkId: null,
  startReceipt: null,
  progress: null,
  failure: null,
});

async function persistedLifecycleAuthorityFixture(authorityDirectory: string) {
  let timestamp = Date.parse("2026-07-18T00:00:00.000Z");
  const run = await runDefineStructuring({
    adapter: {
      invoke: async () => ({
        responseId: "resp-lifecycle-cold-reload-1",
        responseStatusCode: 200,
        status: "completed" as const,
        modelReportedId: "gpt-5.6-sol",
        serviceTierReported: "default",
        outputText: JSON.stringify(
          SYNTHETIC_CHALLENGE_TEMPLATE.advisorySuggestion,
        ),
        usage: {
          inputTokens: 200,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 100,
          reasoningTokens: 40,
          totalTokens: 300,
        },
        error: null,
      }),
    },
    input: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
    now: () => {
      const current = timestamp;
      timestamp += 10;
      return current;
    },
  });
  const defineArtifact = buildDefineStructuringArtifact({
    input: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
    run,
  });
  const defineOutputDirectory = await secureChildDirectory(
    authorityDirectory,
    "define-structuring",
  );
  const persistedDefine = await persistDefineStructuringArtifact({
    outputDirectory: defineOutputDirectory,
    artifact: defineArtifact,
  });
  const reloadedDefine = await loadDefineStructuringArtifact({
    outputDirectory: defineOutputDirectory,
    artifactPath: persistedDefine.path,
    expectedInput: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
  });
  const lockedFixture = createLockedChallengeFixtureBundle();
  const lockedOutputDirectory = await secureChildDirectory(
    authorityDirectory,
    "locked-challenge",
  );
  const persistedLocked = await persistLockedChallengeAuthorityRecord({
    outputDirectory: lockedOutputDirectory,
    creationInput: lockedFixture.creationInput,
    pack: lockedFixture.pack,
  });
  const reloadedLocked = await loadLockedChallengeAuthorityRecord({
    outputDirectory: lockedOutputDirectory,
    challengeId: lockedFixture.pack.challenge_id,
    challengeVersion: lockedFixture.pack.challenge_version,
  });
  const benchmarkId = buildStableBenchmarkId({
    lockedChallengePackHash: reloadedLocked.pack.locked_challenge_pack_hash,
    hiddenDatasetHash: BENCHMARK_DATASET_HASH,
    scheduleId: buildBenchmarkSchedule(
      BENCHMARK_CASES,
      ["A", "B", "C"],
    ).schedule_id,
  });
  const startReceipt = buildBenchmarkStartCommandReceipt({
    benchmarkId,
    challengeId: reloadedLocked.pack.challenge_id,
    challengeVersion: reloadedLocked.pack.challenge_version,
    lockedChallengePackHash: reloadedLocked.pack.locked_challenge_pack_hash,
    actorLabel: "Evaluation lead",
    executionMode: "START",
    resumeFromProgressHash: null,
    attemptNumber: 1,
    previousStartReceiptHash: null,
    startedAt: "2026-07-18T00:00:00.000Z",
  });
  const benchmarkStartOutputDirectory = await secureChildDirectory(
    authorityDirectory,
    "benchmark-start-command",
  );
  const persistedStart = await persistBenchmarkStartCommandReceipt({
    outputDirectory: benchmarkStartOutputDirectory,
    receipt: startReceipt,
  });
  const reloadedStart = await loadBenchmarkStartCommandReceipt({
    outputDirectory: benchmarkStartOutputDirectory,
    path: persistedStart.path,
    expectedReceipt: startReceipt,
  });
  return Object.freeze({
    reloadedDefine,
    persistedDefine,
    reloadedLocked,
    persistedLocked,
    benchmarkId,
    reloadedStart,
    persistedStart,
  });
}

function lifecycleStateForRestart({
  phase,
  fixture,
}: {
  readonly phase: "PROPOSED" | "LOCKED" | "READY" | "RUNNING";
  readonly fixture: Awaited<ReturnType<typeof persistedLifecycleAuthorityFixture>>;
}): ChallengeLifecycleSourceState {
  const hasLockedChallenge = phase !== "PROPOSED";
  const hasStartReceipt = phase === "RUNNING";
  return Object.freeze({
    phase: hasStartReceipt ? "RUNNING" : hasLockedChallenge ? "LOCKED" : "PROPOSED",
    defineInput: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
    // runtime hydration은 이 JSON clone을 권위로 쓰지 않고 아래 reference로
    // source-reload한 객체를 다시 주입해야 합니다.
    defineArtifact: structuredClone(fixture.reloadedDefine),
    lockedChallengePack: hasLockedChallenge
      ? structuredClone(fixture.reloadedLocked.pack)
      : null,
    benchmarkId: hasLockedChallenge ? fixture.benchmarkId : null,
    startReceipt: hasStartReceipt ? structuredClone(fixture.reloadedStart) : null,
    progress: null,
    failure: null,
    lifecycleAuthorityReferences: {
      schema_version: "challenge-lifecycle-authority-references-v1",
      define_artifact: {
        path: fixture.persistedDefine.path,
        artifact_hash: fixture.persistedDefine.artifactHash,
      },
      locked_challenge: hasLockedChallenge
        ? {
          path: fixture.persistedLocked.path,
          challenge_id: fixture.reloadedLocked.pack.challenge_id,
          challenge_version: fixture.reloadedLocked.pack.challenge_version,
          locked_challenge_pack_hash:
            fixture.reloadedLocked.pack.locked_challenge_pack_hash,
        }
        : null,
      benchmark_start_command: hasStartReceipt
        ? {
          path: fixture.persistedStart.path,
          receipt_hash: fixture.persistedStart.receiptHash,
        }
        : null,
    },
  } as unknown as ChallengeLifecycleSourceState);
}

describe("Challenge Room process 재시작", () => {
  it("non-interactive CLI 출력에는 reviewer bootstrap credential을 포함하지 않는다", () => {
    const bootstrapUrl = "http://127.0.0.1:4173/#reviewer_token=rvw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const output = reviewerBootstrapCliOutput({
      reviewerBootstrapUrl: bootstrapUrl,
      interactive: false,
    });
    expect(output).not.toContain(bootstrapUrl);
    expect(output).not.toContain("reviewer_token=");
    expect(output).toContain("보안 채널");
  });

  it("interactive CLI 출력에서만 reviewer bootstrap fragment를 제공한다", () => {
    const bootstrapUrl = "http://127.0.0.1:4173/#reviewer_token=rvw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(reviewerBootstrapCliOutput({
      reviewerBootstrapUrl: bootstrapUrl,
      interactive: true,
    })).toContain(bootstrapUrl);
  });

  it.each([
    "PROPOSED",
    "LOCKED",
    "READY",
    "RUNNING",
  ] as const)("%s head는 close→recreate 뒤 persisted authority source만 다시 읽는다", async (targetPhase) => {
    const rootDirectory = await secureDirectory("lifecycle-cold-reload-");
    const [authorityDirectory, projectionDirectory] = await Promise.all([
      secureChildDirectory(rootDirectory, "authority"),
      secureChildDirectory(rootDirectory, "projections"),
    ]);
    const fixture = await persistedLifecycleAuthorityFixture(authorityDirectory);
    const phaseOrder = ["PROPOSED", "LOCKED", "READY", "RUNNING"] as const;
    let previousReceiptSha256: string | null = null;
    const draft = await persistAndAppendAuthoritativeRuntimePhase({
      outputDirectory: authorityDirectory,
      projectionOutputDirectory: projectionDirectory,
      workflowId: "synthetic-recorded-challenge",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: previousReceiptSha256,
      lifecycleState: draftLifecycleState,
      projectionSnapshot: buildChallengeLifecycleProjectionSnapshot(
        draftLifecycleState,
        { runtimePhase: "DRAFT" },
      ),
    });
    previousReceiptSha256 = draft.receiptSha256;
    for (const phase of phaseOrder.slice(0, phaseOrder.indexOf(targetPhase) + 1)) {
      const state = lifecycleStateForRestart({ phase, fixture });
      const persisted = await persistAndAppendAuthoritativeRuntimePhase({
        outputDirectory: authorityDirectory,
        projectionOutputDirectory: projectionDirectory,
        workflowId: "synthetic-recorded-challenge",
        phase,
        expectedPreviousReceiptSha256: previousReceiptSha256,
        lifecycleState: state,
        projectionSnapshot: buildChallengeLifecycleProjectionSnapshot(
          state,
          { runtimePhase: phase },
        ),
      });
      previousReceiptSha256 = persisted.receiptSha256;
    }
    const environment = {
      AI_AUTHORITATIVE_CHALLENGE_ROOM_ROOT: rootDirectory,
      AI_AUTHORITATIVE_WORKSPACE_PORT: "0",
      OPENAI_API_KEY: "test-key",
    } as NodeJS.ProcessEnv;
    const first = await startAuthoritativeChallengeRoomFromEnvironmentForTest({
      environment,
    });
    const firstWorkspace = await (
      await fetch(`${first.server.origin}/api/workspace`)
    ).json();
    const firstProgress = await (
      await fetch(`${first.server.origin}/api/benchmark-progress/${fixture.benchmarkId}`)
    ).json();
    expect(first.gateway.isBenchmarkRunning()).toBe(false);
    await first.server.close();

    const second = await startAuthoritativeChallengeRoomFromEnvironmentForTest({
      environment,
    });
    const secondWorkspace = await (
      await fetch(`${second.server.origin}/api/workspace`)
    ).json();
    const secondProgress = await (
      await fetch(`${second.server.origin}/api/benchmark-progress/${fixture.benchmarkId}`)
    ).json();
    expect(second.gateway.isBenchmarkRunning()).toBe(false);
    await second.server.close();

    expect(secondWorkspace).toEqual(firstWorkspace);
    expect(secondProgress).toEqual(firstProgress);
    expect(secondWorkspace).toMatchObject({
      benchmark_id: targetPhase === "PROPOSED" ? null : fixture.benchmarkId,
    });
  }, 30_000);

  it.each([
    "missing Define reference",
    "tampered Define hash",
  ] as const)("%s가 있으면 lifecycle cold restart를 fail-closed 한다", async (failure) => {
    const rootDirectory = await secureDirectory("lifecycle-cold-reload-invalid-");
    const [authorityDirectory, projectionDirectory] = await Promise.all([
      secureChildDirectory(rootDirectory, "authority"),
      secureChildDirectory(rootDirectory, "projections"),
    ]);
    const fixture = await persistedLifecycleAuthorityFixture(authorityDirectory);
    const proposed = lifecycleStateForRestart({
      phase: "PROPOSED",
      fixture,
    });
    const references = structuredClone(proposed.lifecycleAuthorityReferences!);
    const invalidReferences = failure === "missing Define reference"
      ? { ...references, define_artifact: null }
      : {
        ...references,
        define_artifact: {
          ...references.define_artifact!,
          artifact_hash: "0".repeat(64),
        },
      };
    const invalidState = Object.freeze({
      ...proposed,
      lifecycleAuthorityReferences: invalidReferences,
    } as ChallengeLifecycleSourceState);
    const draft = await persistAndAppendAuthoritativeRuntimePhase({
      outputDirectory: authorityDirectory,
      projectionOutputDirectory: projectionDirectory,
      workflowId: "synthetic-recorded-challenge",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
      lifecycleState: draftLifecycleState,
      projectionSnapshot: buildChallengeLifecycleProjectionSnapshot(
        draftLifecycleState,
        { runtimePhase: "DRAFT" },
      ),
    });
    await persistAndAppendAuthoritativeRuntimePhase({
      outputDirectory: authorityDirectory,
      projectionOutputDirectory: projectionDirectory,
      workflowId: "synthetic-recorded-challenge",
      phase: "PROPOSED",
      expectedPreviousReceiptSha256: draft.receiptSha256,
      lifecycleState: invalidState,
      projectionSnapshot: buildChallengeLifecycleProjectionSnapshot(
        invalidState,
        { runtimePhase: "PROPOSED" },
      ),
    });
    await expect(startAuthoritativeChallengeRoomFromEnvironmentForTest({
      environment: {
        AI_AUTHORITATIVE_CHALLENGE_ROOM_ROOT: rootDirectory,
        AI_AUTHORITATIVE_WORKSPACE_PORT: "0",
        OPENAI_API_KEY: "test-key",
      },
    })).rejects.toThrow(/reference|source-reload|Define/i);
  }, 30_000);

  it.each([
    "missing private seed reference",
    "missing precommit reference",
    "tampered precommit reference",
  ] as const)("%s는 cold reload를 fail-closed하고 authority filesystem을 바꾸지 않는다", async (failure) => {
    const authorityDirectory = await secureDirectory("cold-provenance-authority-");
    const benchmarkDirectory = await secureDirectory("cold-provenance-benchmark-");
    const lockedFixture = createLockedChallengeFixtureBundle();
    const lockedOutputDirectory = await secureChildDirectory(
      authorityDirectory,
      "locked-challenge",
    );
    await persistLockedChallengeAuthorityRecord({
      outputDirectory: lockedOutputDirectory,
      creationInput: lockedFixture.creationInput,
      pack: lockedFixture.pack,
    });
    const lockedChallengePack = (await loadLockedChallengeAuthorityRecord({
      outputDirectory: lockedOutputDirectory,
      challengeId: lockedFixture.pack.challenge_id,
      challengeVersion: lockedFixture.pack.challenge_version,
    })).pack;
    const coldFixture = await recordedReviewSourceFixture();
    const fixture = await coldFixture.createPersistedRecordedBenchmarkColdFixture({
      outputDirectory: benchmarkDirectory,
    });
    const trackedPaths = [
      fixture.privateBlindingSeedAuthority.record_path,
      fixture.judgeEvidencePrecommitAuthority.authority_claim_path,
      fixture.judgeEvidencePrecommitAuthority.record_path,
    ];
    const before = await Promise.all(trackedPaths.map(async (path) => ({
      path,
      stat: await lstat(path),
      siblings: await readdir(dirname(path)),
    })));
    let providerCalls = 0;
    const privateBlindingSeedAuthority = failure === "missing private seed reference"
      ? {
        ...fixture.privateBlindingSeedAuthority,
        record_path: join(
          dirname(fixture.privateBlindingSeedAuthority.record_path),
          "missing-private-seed.json",
        ),
      }
      : fixture.privateBlindingSeedAuthority;
    const judgeEvidencePrecommitAuthority = failure === "missing precommit reference"
      ? {
        ...fixture.judgeEvidencePrecommitAuthority,
        record_path: join(
          dirname(fixture.judgeEvidencePrecommitAuthority.record_path),
          "missing-precommit.json",
        ),
      }
      : failure === "tampered precommit reference"
        ? {
        ...fixture.judgeEvidencePrecommitAuthority,
        manifest_hash: "0".repeat(64),
        }
        : fixture.judgeEvidencePrecommitAuthority;
    await expect(reloadRecordedBenchmarkPackForColdStart({
      outputDirectory: benchmarkDirectory,
      recordedPackPath: fixture.recordedPackPath,
      recordedPackHash: fixture.recordedPackHash,
      executionIdentityAuthority: fixture.executionIdentityAuthority,
      lockedChallengePack,
      plans: fixture.plans,
      privateBlindingSeedAuthority,
      judgeEvidencePrecommitAuthority,
      onUnexpectedJudgeProviderInvocation: () => { providerCalls += 1; },
    })).rejects.toThrow(/provenance|authority|reference|precommit|private/i);
    expect(providerCalls).toBe(0);
    const after = await Promise.all(trackedPaths.map(async (path) => ({
      path,
      stat: await lstat(path),
      siblings: await readdir(dirname(path)),
    })));
    expect(after.map(({ path, stat, siblings }) => ({
      path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      siblings: [...siblings].sort(),
    }))).toEqual(before.map(({ path, stat, siblings }) => ({
      path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      siblings: [...siblings].sort(),
    })));
  }, 30_000);

  it.each([
    {
      name: "REVIEW_PENDING",
      runtimePhase: "REVIEW_PENDING" as const,
      snapshot: persistedWorkflowSnapshot({
        reviewId: "review_restart_1",
        decisionId: null,
        baselineId: null,
        regressionId: null,
        decideStatus: "USER CONFIRMATION REQUIRED",
        monitorStatus: "NO BASELINE",
      }),
    },
    {
      name: "HUMAN_CONFIRMED_REVIEW",
      runtimePhase: "HUMAN_CONFIRMED_REVIEW" as const,
      snapshot: persistedWorkflowSnapshot({
        reviewId: null,
        decisionId: "decision_restart_1",
        baselineId: null,
        regressionId: null,
        decideStatus: "HUMAN CONFIRMED REVIEW",
        monitorStatus: "NO BASELINE",
      }),
    },
    {
      name: "MEMO_REVIEW_REQUIRED",
      runtimePhase: "MEMO_REVIEW_REQUIRED" as const,
      snapshot: persistedWorkflowSnapshot({
        reviewId: null,
        decisionId: "decision_restart_1",
        baselineId: null,
        regressionId: null,
        decideStatus: "MEMO REVIEW REQUIRED",
        monitorStatus: "NO BASELINE",
      }),
    },
    {
      name: "BASELINE_ACTIVE",
      runtimePhase: "DECISION_CONFIRMED" as const,
      snapshot: persistedWorkflowSnapshot({
        reviewId: null,
        decisionId: "decision_restart_1",
        baselineId: "baseline_restart_1",
        regressionId: null,
        decideStatus: "DECISION CONFIRMED",
        monitorStatus: "BASELINE ACTIVE",
      }),
    },
    {
      name: "REGRESSION terminal",
      runtimePhase: "REGRESSION_RECORDED" as const,
      snapshot: persistedWorkflowSnapshot({
        reviewId: null,
        decisionId: "decision_restart_1",
        baselineId: "baseline_restart_1",
        regressionId: "regression_restart_1",
        decideStatus: "DECISION CONFIRMED",
        monitorStatus: "BLOCK",
      }),
    },
  ])("$name head를 close→recreate해 loopback projection을 같은 값으로 복원한다", async ({ runtimePhase }) => {
    const rootDirectory = await secureDirectory("challenge-room-restart-");
    const authorityDirectory = join(rootDirectory, "authority");
    const projectionDirectory = join(rootDirectory, "projections");
    await Promise.all([
      mkdir(authorityDirectory, { recursive: true, mode: 0o700 }),
      mkdir(projectionDirectory, { recursive: true, mode: 0o700 }),
    ]);
    const lockedFixture = createLockedChallengeFixtureBundle();
    // Locked Challenge persistence는 artifact child를 만들기 전에 이 root를
    // 0700으로 검증하므로 fixture도 production과 같은 root를 준비합니다.
    await mkdir(join(authorityDirectory, "locked-challenge"), {
      recursive: true,
      mode: 0o700,
    });
    await persistLockedChallengeAuthorityRecord({
      outputDirectory: join(authorityDirectory, "locked-challenge"),
      creationInput: lockedFixture.creationInput,
      pack: lockedFixture.pack,
    });
    const lockedChallengePack = (await loadLockedChallengeAuthorityRecord({
      outputDirectory: join(authorityDirectory, "locked-challenge"),
      challengeId: lockedFixture.pack.challenge_id,
      challengeVersion: lockedFixture.pack.challenge_version,
    })).pack;
    const sideEffects = {
      benchmark: 0,
      preReview: 0,
      providerMemo: 0,
      regression: 0,
    };
    const buildColdFixture = await recordedReviewSourceFixture();
    const benchmarkDirectory = await secureDirectory("challenge-room-benchmark-");
    const fixture = await buildColdFixture
      .createPersistedRecordedBenchmarkColdFixture({ outputDirectory: benchmarkDirectory });
    const command = buildDeterministicAiPreReviewCommand({
      recordedBenchmarkPack: fixture.recordedBenchmarkPack,
      reviewedAt: "2026-07-18T00:00:00.000Z",
    });
    const builtPreReview = buildAiPreReviewReceipt({
      benchmarkPack: fixture.recordedBenchmarkPack,
      queue: fixture.recordedBenchmarkPack.blind_review_queue,
      command,
    });
    const persistedPreReview = await persistAiPreReviewReceipt({
      outputDirectory: authorityDirectory,
      receipt: builtPreReview,
    });
    const preReviewReceipt = await loadAiPreReviewReceipt({
      path: persistedPreReview.path,
      benchmarkPack: fixture.recordedBenchmarkPack,
      queue: fixture.recordedBenchmarkPack.blind_review_queue,
    });
    const builtMemo = buildProvisionalDecisionMemo({
      benchmarkPack: fixture.recordedBenchmarkPack,
      queue: fixture.recordedBenchmarkPack.blind_review_queue,
      preReviewReceipt,
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    const persistedMemo = await persistProvisionalDecisionMemo({
      outputDirectory: authorityDirectory,
      memo: builtMemo,
    });
    const provisionalDecisionMemo = await loadProvisionalDecisionMemo({
      path: persistedMemo.path,
      benchmarkPack: fixture.recordedBenchmarkPack,
      queue: fixture.recordedBenchmarkPack.blind_review_queue,
      preReviewReceipt,
    });
    const initialSources = {
      lockedChallengePack,
      recordedBenchmarkPack: fixture.recordedBenchmarkPack,
      preReviewReceipt,
      provisionalDecisionMemo,
    };
    const hasDecisionProjection = runtimePhase !== "REVIEW_PENDING";
    const hasHumanConfirmation = runtimePhase !== "REVIEW_PENDING";
    const hasFinalMemo = [
      "MEMO_REVIEW_REQUIRED",
      "DECISION_CONFIRMED",
      "REGRESSION_RECORDED",
    ].includes(runtimePhase);
    const hasBaseline = ["DECISION_CONFIRMED", "REGRESSION_RECORDED"]
      .includes(runtimePhase);
    // REVIEW_PENDING에서 미래 Human confirmation artifact까지 만들면, 실제
    // HTTP confirmation이 write-once claim과 부당하게 충돌합니다. 이 phase는
    // active review source만 persistence해야 실제 운영 전이와 같습니다.
    const lateState = hasHumanConfirmation
      ? await buildColdFixture.createPersistedRecordedWorkflowControllerStateFixture({
        outputDirectory: authorityDirectory,
        ...initialSources,
      })
      : undefined;
    const regressionFixture = await (async () => {
      if (runtimePhase !== "REGRESSION_RECORDED") return undefined;
      const decisionAuthorityRecord = lateState!.baseline.decisionAuthorityRecord;
      if (decisionAuthorityRecord.artifact_kind !== "DECISION_BASELINE_RECORD") {
        throw new TypeError("회귀 fixture에는 승인된 Decision baseline이 필요합니다.");
      }
      return createPersistedRecordedRegressionFixture({
        outputDirectory: authorityDirectory,
        decisionBaselineRecord: decisionAuthorityRecord,
        recordedBenchmarkPack: fixture.recordedBenchmarkPack,
      });
    })();
    const controllerState = runtimePhase === "HUMAN_CONFIRMED_REVIEW"
      ? lateState!.human
      : runtimePhase === "MEMO_REVIEW_REQUIRED"
        ? lateState!.memo
        : runtimePhase === "REGRESSION_RECORDED"
          ? Object.freeze({
            ...lateState!.baseline,
            recordedRegressionPack: regressionFixture!.pack,
            recordedRegressionPackPath: regressionFixture!.path,
          })
          : runtimePhase === "DECISION_CONFIRMED"
          ? lateState!.baseline
          : Object.freeze({});
    const coldLoads: AuthoritativeColdSourceReload[] = [];
    const expectedColdLoads: AuthoritativeColdSourceReload[] = [
      "locked_challenge",
      "benchmark_execution_identity",
      "recorded_benchmark_pack",
      "pre_review",
      "provisional_memo",
      ...(hasHumanConfirmation
        ? ["human_confirmation", "human_confirmed_context"] as const
        : []),
      ...(hasFinalMemo ? ["final_memo"] as const : []),
      ...(hasBaseline
        ? ["final_confirmation", "decision_authority_record"] as const
        : []),
      ...(regressionFixture !== undefined ? ["recorded_regression"] as const : []),
    ];
    const snapshot = hasDecisionProjection
      ? buildRecordedDecisionProjectionSnapshot({
        ...initialSources,
        ...controllerState,
      } as any)
      : buildRecordedReviewProjectionSnapshot(initialSources);
    const workspace = snapshot.projections.workspace;
    const projectionPath = workspace.review_id !== null
      ? `/api/reviews/${workspace.review_id}`
      : workspace.regression_id !== null
        ? `/api/regressions/${workspace.regression_id}`
        : workspace.baseline_id !== null
          ? `/api/baselines/${workspace.baseline_id}`
          : `/api/decisions/${workspace.decision_id}`;
    const sourceAuthorityRefs = {
      benchmark_execution_identity: fixture.executionIdentityAuthority,
      pre_review: {
        path: persistedPreReview.path,
        payload_sha256: persistedPreReview.payloadSha256,
      },
      provisional_memo: {
        path: persistedMemo.path,
        payload_sha256: persistedMemo.payloadSha256,
      },
      ...(hasHumanConfirmation
        ? {
          human_confirmation: {
            path: lateState!.human.humanConfirmationReceiptPath,
            payload_sha256: sha256CanonicalJson(
              lateState!.human.humanConfirmationReceipt,
            ),
          },
        } : {}),
      ...(hasFinalMemo
        ? {
          final_memo: {
            path: lateState!.memo.finalDecisionMemoPath,
            payload_sha256: sha256CanonicalJson(lateState!.memo.finalDecisionMemo),
          },
        } : {}),
      ...(hasBaseline
        ? {
          final_confirmation: {
            path: lateState!.baseline.finalDecisionConfirmationReceiptPath,
            payload_sha256: sha256CanonicalJson(
              lateState!.baseline.finalDecisionConfirmationReceipt,
            ),
          },
          decision_authority_record: {
            path: lateState!.baseline.decisionAuthorityRecordPath,
            payload_sha256: sha256CanonicalJson(lateState!.baseline.decisionAuthorityRecord),
          },
        } : {}),
      ...(regressionFixture !== undefined
        ? {
          recorded_regression: {
            path: regressionFixture.path,
            payload_sha256: regressionFixture.payloadSha256,
          },
        } : {}),
    };
    const requiredLateAuthorityReference = runtimePhase === "HUMAN_CONFIRMED_REVIEW"
      ? "human_confirmation"
      : runtimePhase === "MEMO_REVIEW_REQUIRED"
        ? "final_memo"
        : runtimePhase === "DECISION_CONFIRMED"
          ? "decision_authority_record"
          : runtimePhase === "REGRESSION_RECORDED"
            ? "recorded_regression"
            : undefined;
    if (requiredLateAuthorityReference !== undefined) {
      const missingAuthorityRefs = { ...sourceAuthorityRefs };
      if (requiredLateAuthorityReference === "human_confirmation") {
        delete missingAuthorityRefs.human_confirmation;
      } else if (requiredLateAuthorityReference === "final_memo") {
        delete missingAuthorityRefs.final_memo;
      } else if (requiredLateAuthorityReference === "decision_authority_record") {
        delete missingAuthorityRefs.decision_authority_record;
      } else {
        delete missingAuthorityRefs.recorded_regression;
      }
      await expect(reloadAuthoritativeWorkflowControllerStateForColdStart({
        // raw clone은 authority가 아니며, 아래 missing reference를 대신할 수 없습니다.
        controllerState: structuredClone(controllerState),
        sourceAuthorityRefs: missingAuthorityRefs,
        initialSources,
      })).rejects.toThrow(/persisted authority reference/i);
    }

    const draft = await persistAndAppendAuthoritativeRuntimePhase({
      outputDirectory: authorityDirectory,
      projectionOutputDirectory: projectionDirectory,
      workflowId: "synthetic-recorded-challenge",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
      lifecycleState: draftLifecycleState,
      projectionSnapshot: buildChallengeLifecycleProjectionSnapshot(
        draftLifecycleState,
      ),
    });
    const phaseOrder: readonly AuthoritativeRuntimePhase[] = [
      "DRAFT",
      "PROPOSED",
      "LOCKED",
      "READY",
      "RUNNING",
      "REVIEW_PENDING",
      "HUMAN_CONFIRMED_REVIEW",
      "MEMO_REVIEW_REQUIRED",
      "DECISION_CONFIRMED",
      "REGRESSION_RECORDED",
    ];
    let previousReceiptSha256 = draft.receiptSha256;
    for (const phase of phaseOrder.slice(1, phaseOrder.indexOf(runtimePhase))) {
      const appended = await persistAndAppendAuthoritativeRuntimePhase({
        outputDirectory: authorityDirectory,
        projectionOutputDirectory: projectionDirectory,
        workflowId: "synthetic-recorded-challenge",
        phase,
        expectedPreviousReceiptSha256: previousReceiptSha256,
        lifecycleState: draftLifecycleState,
        projectionSnapshot: persistedWorkflowSnapshot({
          reviewId: null,
          decisionId: null,
          baselineId: null,
          regressionId: null,
          decideStatus: `FIXTURE ${phase}`,
          monitorStatus: "NO BASELINE",
        }),
      });
      previousReceiptSha256 = appended.receiptSha256;
    }
    await persistAndAppendAuthoritativeRuntimePhase({
      outputDirectory: authorityDirectory,
      projectionOutputDirectory: projectionDirectory,
      workflowId: "synthetic-recorded-challenge",
      phase: runtimePhase,
      expectedPreviousReceiptSha256: previousReceiptSha256,
      lifecycleState: {
        ...completedLifecycleState,
        recordedBenchmarkColdReloadReference: {
          outputDirectory: benchmarkDirectory,
          recordedPackPath: fixture.recordedPackPath,
          recordedPackHash: fixture.recordedPackHash,
          executionIdentityAuthority: fixture.executionIdentityAuthority,
          plans: fixture.plans,
          privateBlindingSeedAuthority: fixture.privateBlindingSeedAuthority,
          judgeEvidencePrecommitAuthority:
            fixture.judgeEvidencePrecommitAuthority,
        },
      },
      workflowState: {
        initial_sources: initialSources,
        controller_state: controllerState,
        source_authority_refs: sourceAuthorityRefs,
      },
      projectionSnapshot: snapshot,
    });
    const environment = {
      ["AI_AUTHORITATIVE_CHALLENGE_ROOM_ROOT"]: rootDirectory,
      ["AI_AUTHORITATIVE_WORKSPACE_PORT"]: "0",
    } as NodeJS.ProcessEnv;

    const first = await startAuthoritativeChallengeRoomFromEnvironmentForTest({
      environment,
      dependencies: {
        createRecordedRegressionRunner: () => async () => {
          sideEffects.regression += 1;
          throw new Error("재시작은 regression을 실행하면 안 됩니다.");
        },
        onColdSourceReload: (source) => coldLoads.push(source),
      },
    });
    const firstWorkspace = await (await fetch(`${first.server.origin}/api/workspace`)).json();
    const firstReviewerHeaders = runtimePhase === "REVIEW_PENDING"
      ? reviewerHeaders(first.server)
      : undefined;
    const firstProjection = await (await fetch(`${first.server.origin}${projectionPath}`, {
      ...(firstReviewerHeaders === undefined ? {} : { headers: firstReviewerHeaders }),
    })).json();
    if (runtimePhase === "REVIEW_PENDING") {
      if (firstReviewerHeaders === undefined) throw new Error("Reviewer 세션이 없습니다.");
      // 공개 Compare progress는 후보별 aggregate만 제공할 수 있습니다. 검수 전에는
      // case·candidate·evidence 좌표나 raw output을 공개하면 X/Y/Z reviewer detail과
      // 상관시켜 실제 후보 identity를 복원할 수 있습니다.
      const publicProgressResponse = await fetch(
        `${first.server.origin}/api/benchmarks/${firstWorkspace.benchmark_id}/progress`,
      );
      expect(publicProgressResponse.status).toBe(200);
      const publicProgress = await publicProgressResponse.json() as {
        readonly slots?: readonly unknown[];
      };
      expect(publicProgress.slots).toEqual([]);

      const rawSlot = fixture.recordedBenchmarkPack
        .benchmark_execution_pack.slots[0]!;
      const publicEvidenceResponse = await fetch(
        `${first.server.origin}/api/evidence/slot_${rawSlot.slot_identity_hash}`,
      );
      expect(publicEvidenceResponse.status).toBe(404);

      const activeItems = (firstProjection as {
        readonly queue_content_hash: string;
        readonly items: readonly {
          readonly item_id: string;
          readonly evidence_id: string;
          readonly case_id: string;
          readonly blind_label: "X" | "Y" | "Z";
          readonly review_evidence_handle: string;
        }[];
      }).items;
      expect(activeItems).toHaveLength(12);
      expect(activeItems.every((item) => /^evh_[a-f0-9]{64}$/.test(
        item.review_evidence_handle ?? "",
      ))).toBe(true);
      expect(new Set(activeItems.map((item) => item.review_evidence_handle)).size)
        .toBe(activeItems.length);

      // reviewer projection에 공개된 값만으로 만든 hash는 capability가
      // 아닙니다. 실제 capability는 queue 내부의 비공개 run handle entropy를
      // 요구해야 하므로 이 추측값으로 detail을 열 수 없어야 합니다.
      const firstItem = activeItems[0]!;
      const publicOnlyHandle = `evh_${sha256CanonicalJson({
        schema_version: "reviewer-blind-evidence-handle-v1",
        queue_content_hash: (firstProjection as { readonly queue_content_hash: string }).queue_content_hash,
        item_id: firstItem.item_id,
        evidence_id: firstItem.evidence_id,
      })}`;
      expect(firstItem.review_evidence_handle).not.toBe(publicOnlyHandle);
      const publicOnlyResponse = await fetch(
        `${first.server.origin}/api/reviewer/evidence/${firstItem.evidence_id}`,
        {
          headers: {
            ...firstReviewerHeaders,
            "x-review-evidence-handle": publicOnlyHandle,
          },
        },
      );
      expect(publicOnlyResponse.status).toBe(404);

      const detailResults = await Promise.all(activeItems.map(async (item) => {
        const response = await fetch(
          `${first.server.origin}/api/reviewer/evidence/${item.evidence_id}`,
          {
            headers: {
              ...firstReviewerHeaders,
              "x-review-evidence-handle": item.review_evidence_handle,
            },
          },
        );
        return { item, response, detail: await response.json() };
      }));
      expect(detailResults.every(({ response }) => response.status === 200)).toBe(true);
      for (const { item, detail } of detailResults) {
        expect(detail).toMatchObject({
          schema_version: "recorded-blind-review-evidence-detail-v1",
          evidence_id: item.evidence_id,
          item_id: item.item_id,
          case_id: item.case_id,
          candidate_label: `Candidate ${item.blind_label}`,
        });
        expect(detail.runs).toHaveLength(2);
        expect(detail.runs.map((run: { readonly repetition: number }) => run.repetition))
          .toEqual([1, 2]);
      }

      const swappedResponse = await fetch(
        `${first.server.origin}/api/reviewer/evidence/${firstItem.evidence_id}`,
        {
          headers: {
            ...firstReviewerHeaders,
            "x-review-evidence-handle": activeItems[1]!.review_evidence_handle,
          },
        },
      );
      expect(swappedResponse.status).toBe(404);
      const unknownResponse = await fetch(
        `${first.server.origin}/api/reviewer/evidence/${firstItem.evidence_id}`,
        {
          headers: {
            ...firstReviewerHeaders,
            "x-review-evidence-handle": `evh_${"0".repeat(64)}`,
          },
        },
      );
      expect(unknownResponse.status).toBe(404);
      const crossReviewHandle = reviewerBlindEvidenceHandle(
        fixture.recordedBenchmarkPack,
        `${preReviewReceipt.pre_review_id}_other`,
        firstItem.item_id,
      );
      const crossReviewResponse = await fetch(
        `${first.server.origin}/api/reviewer/evidence/${firstItem.evidence_id}`,
        {
          headers: {
            ...firstReviewerHeaders,
            "x-review-evidence-handle": crossReviewHandle,
          },
        },
      );
      expect(crossReviewResponse.status).toBe(404);
    }
    await first.server.close();

    const second = await startAuthoritativeChallengeRoomFromEnvironmentForTest({
      environment,
      dependencies: {
        createRecordedRegressionRunner: () => async () => {
          sideEffects.regression += 1;
          throw new Error("재시작은 regression을 실행하면 안 됩니다.");
        },
        onColdSourceReload: (source) => coldLoads.push(source),
      },
    });
    const secondWorkspace = await (await fetch(`${second.server.origin}/api/workspace`)).json();
    const secondReviewerHeaders = runtimePhase === "REVIEW_PENDING"
      ? reviewerHeaders(second.server)
      : undefined;
    const secondProjection = await (await fetch(`${second.server.origin}${projectionPath}`, {
      ...(secondReviewerHeaders === undefined ? {} : { headers: secondReviewerHeaders }),
    })).json();

    if (runtimePhase === "REVIEW_PENDING") {
      if (firstReviewerHeaders === undefined || secondReviewerHeaders === undefined) {
        throw new Error("Reviewer 세션이 없습니다.");
      }
      // public snapshot에는 blind queue를 저장하지 않지만, active reviewer
      // workflow는 verified live authority source에서만 다시 조립돼야 합니다.
      expect(firstProjection).toMatchObject({
        schema_version: "preconfirmation-public-projection-v1",
        review_id: firstWorkspace.review_id,
      });
      expect(secondProjection).toMatchObject({
        schema_version: "preconfirmation-public-projection-v1",
        review_id: secondWorkspace.review_id,
      });
      expect(secondReviewerHeaders.authorization).not.toBe(firstReviewerHeaders.authorization);
      const expiredSession = await fetch(
        `${second.server.origin}/api/reviews/${secondWorkspace.review_id}`,
        {
          headers: {
            authorization: firstReviewerHeaders.authorization,
            origin: second.server.origin,
            "sec-fetch-site": "same-origin",
          },
        },
      );
      expect(expiredSession.status).toBe(403);
    }
    expect(secondWorkspace).toEqual(firstWorkspace);
    expect(secondProjection).toEqual(firstProjection);
    expect(sideEffects).toEqual({
      benchmark: 0,
      preReview: 0,
      providerMemo: 0,
      regression: 0,
    });
    expect(coldLoads.sort()).toEqual([
      ...expectedColdLoads,
      ...expectedColdLoads,
    ].sort());

    if (runtimePhase === "REVIEW_PENDING") {
      if (secondReviewerHeaders === undefined) throw new Error("Reviewer 세션이 없습니다.");
      const activeProjection = secondProjection as {
        readonly source_hash: string;
        readonly items: readonly {
          readonly item_id: string;
          readonly evidence_id: string;
          readonly review_evidence_handle: string;
          readonly proposed_decision:
            | "PROPOSED_PASS"
            | "PROPOSED_CONFIRMED_FAIL";
          readonly rationale: string;
        }[];
      };
      const expectedConfirmation = createHumanConfirmationExpectedContext({
        benchmarkPack: fixture.recordedBenchmarkPack,
        queue: fixture.recordedBenchmarkPack.blind_review_queue,
        preReviewReceipt,
        provisionalMemo: provisionalDecisionMemo,
      });
      expect(() => buildHumanConfirmationReceipt({
        expected: expectedConfirmation,
        command: {
          schema_version: "human-confirmation-command-v1",
          action: "ACCEPT_ALL",
          actor_label: "Reviewer capability integration test",
          expected_recorded_benchmark_pack_hash:
            expectedConfirmation.recorded_benchmark_pack_hash,
          expected_ai_pre_review_receipt_hash:
            expectedConfirmation.ai_pre_review_receipt_hash,
          expected_provisional_decision_memo_hash:
            expectedConfirmation.provisional_decision_memo_hash,
          expected_queue_content_hash: expectedConfirmation.queue_content_hash,
          expected_queue_set_order_hash: expectedConfirmation.queue_set_order_hash,
          expected_queue_item_set_hash: expectedConfirmation.queue_item_set_hash,
          expected_queue_item_order_hash:
            expectedConfirmation.queue_item_order_hash,
          items: activeProjection.items.map((item) => ({
            item_id: item.item_id,
            final_decision: item.proposed_decision === "PROPOSED_PASS"
              ? "PASS"
              : "CONFIRMED_FAIL",
            rationale: item.rationale,
            proposal_resolution: "ACCEPTED",
            review_duration_ms: 1,
            edit_duration_ms: 0,
          })),
          confirmed_at: "2026-07-18T00:00:00.000Z",
        },
      })).not.toThrow();
      const confirmation = await fetch(
        `${second.server.origin}/api/reviews/${secondWorkspace.review_id}/confirm`,
        {
          method: "POST",
          headers: {
            ...secondReviewerHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            schema_version: "review-confirmation-command-v1",
            expected_source_hash: activeProjection.source_hash,
            idempotency_key: "mutation_reviewer_capability_revoke_001",
            payload: {
              action: "ACCEPT_ALL",
              actor_label: "Reviewer capability integration test",
              items: activeProjection.items.map((item) => ({
                item_id: item.item_id,
                final_decision: item.proposed_decision === "PROPOSED_PASS"
                  ? "PASS"
                  : "CONFIRMED_FAIL",
                rationale: item.rationale,
                proposal_resolution: "ACCEPTED",
                review_duration_ms: 1,
                edit_duration_ms: 0,
              })),
            },
          }),
        },
      );
      const confirmationBody = await confirmation.text();
      expect(confirmation.status, confirmationBody).toBe(200);
      const revokedDetailStatuses = await Promise.all(activeProjection.items.map(
        async (item) => (await fetch(
          `${second.server.origin}/api/reviewer/evidence/${item.evidence_id}`,
          {
            headers: {
              ...secondReviewerHeaders,
              "x-review-evidence-handle": item.review_evidence_handle,
            },
          },
        )).status,
      ));
      expect(revokedDetailStatuses).toEqual(Array(activeProjection.items.length).fill(404));
      const revokedReview = await fetch(
        `${second.server.origin}/api/reviews/${secondWorkspace.review_id}`,
        { headers: secondReviewerHeaders },
      );
      expect(revokedReview.status).toBe(404);
    }
    await second.server.close();
  }, 60_000);
});

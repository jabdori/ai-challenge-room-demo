// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { DefineStructureOutcome } from "../../eval/cli/runDefineStructure";
import type { RecordedBenchmarkOutcome } from "../../eval/cli/runRecordedBenchmark";
import { SYNTHETIC_CHALLENGE_TEMPLATE } from "../../eval/define/syntheticChallengeDefinition";
import type { RecordedBenchmarkPack } from "../../eval/pack/recordedBenchmarkPack";
import { sha256CanonicalJson } from "../../eval/runtime/canonicalJson";
import { createLockedChallengeFixture } from "../../eval/test/helpers/lockedChallengeFixture";
import {
  ApiArtifactIntegrityError,
  createChallengeApiHandler,
  type ChallengeApiGateway,
  type ChallengeMutationCommand,
  type ChallengeMutationResult,
  type PublicProjection,
} from "../challengeServer";
import {
  createAuthoritativeChallengeLifecycleController,
  type AuthoritativeChallengeLifecycleDependencies,
} from "../authoritativeChallengeLifecycleController";
import {
  buildPersistedBenchmarkProgressRecord,
  buildBenchmarkStartCommandReceipt,
  deriveStableBenchmarkId,
  type BenchmarkStartCommandReceipt,
  type ChallengeLifecycleDefineArtifact,
  type ChallengeLifecycleSourceState,
  type PersistedBenchmarkProgressRecord,
} from "../challengeLifecycleSnapshots";

const t0 = "2026-07-17T12:00:00.000Z";
const t1 = "2026-07-17T12:01:00.000Z";
const t2 = "2026-07-17T12:02:00.000Z";

function defineArtifact(): ChallengeLifecycleDefineArtifact {
  const body = {
    schema_version: "define-structuring-artifact-v1" as const,
    artifact_kind: "DEFINE_STRUCTURING_ARTIFACT" as const,
    synthetic: true as const,
    authority: "ADVISORY_ONLY" as const,
    lock_authority: "NONE" as const,
    human_approval_status: "REQUIRED" as const,
    define_input: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
    run_record: {
      structuringStatus: "SUGGESTION_COMPLETE",
      suggestion: SYNTHETIC_CHALLENGE_TEMPLATE.advisorySuggestion,
    },
  };
  return Object.freeze({
    ...body,
    artifact_hash: sha256CanonicalJson(body),
  });
}

function defineOutcome(artifact = defineArtifact()): DefineStructureOutcome {
  return {
    exitCode: 0,
    summary: {
      command_status: "DEFINE_SUGGESTION_READY",
      artifact_kind: "DEFINE_STRUCTURING_ARTIFACT",
      synthetic: true,
      authority: "ADVISORY_ONLY",
      human_approval_required: true,
      challenge_locked: false,
      model_requested: "gpt-5.6-sol",
      reasoning_effort: "medium",
      store: false,
      sdk_max_retries: 0,
      runner_max_attempts: 2,
      attempt_count: 1,
      structuring_status: "SUGGESTION_COMPLETE",
      cost_state: "COMPLETE",
      total_cost_usd: 0.01,
      total_latency_ms: 500,
      artifact_hash: artifact.artifact_hash,
      artifact_path: "/authority/define.json",
      created: true,
    },
    builtArtifact: artifact as never,
    serverAuthority: {
      defineStructuringArtifact: artifact as never,
    },
  };
}

function completeBenchmarkOutcome(
  lockedChallengePackHash: string,
): RecordedBenchmarkOutcome {
  const pack = {
    schema_version: "recorded-benchmark-pack-v1",
    artifact_kind: "RECORDED_BENCHMARK_PACK",
    synthetic: true,
    source: "RECORDED_BENCHMARK",
    locked_challenge_pack_hash: lockedChallengePackHash,
  } as unknown as RecordedBenchmarkPack;
  return {
    exitCode: 0,
    summary: {
      command_status: "RECORDED_BENCHMARK_REVIEW_PENDING",
      artifact_kind: "RECORDED_BENCHMARK_PACK",
      source: "RECORDED_BENCHMARK",
      execution_status: "EXECUTION_COMPLETE",
      judge_status: "JUDGE_COMPLETE",
      review_status: "REVIEW_PENDING",
      evaluation_status: "EVALUATION_INCOMPLETE",
      baseline_version: null,
      evaluation_complete: false,
      baseline_created: false,
      clean_completion: true,
      candidate_execution_count: 72,
      auxiliary_judge_count: 12,
      complete_judge_count: 12,
      human_fallback_judge_count: 0,
      recorded_pack_path: "/authority/recorded-pack.json",
      cleanup: {
        required: 33,
        acknowledged: 33,
        incomplete: 0,
        resources: [
          {
            kind: "VECTOR_STORE",
            fingerprint: "sha256:000000000000",
            delete_acknowledged: true,
          },
          ...Array.from({ length: 32 }, (_, index) => ({
            kind: "UPLOADED_FILE" as const,
            fingerprint: `sha256:${String(index + 1).padStart(12, "0")}`,
            delete_acknowledged: true,
          })),
        ],
        receipt_path: "/authority/cleanup.json",
      },
    },
    serverAuthority: { recordedBenchmarkPack: pack },
  };
}

function command(
  schemaVersion: string,
  sourceHash: string,
  targetId: string,
  payload?: Readonly<Record<string, unknown>>,
  key = "mutation_lifecycle_001",
): ChallengeMutationCommand {
  return {
    schema_version: schemaVersion,
    expected_source_hash: sourceHash,
    idempotency_key: key,
    target_id: targetId,
    ...(payload === undefined ? {} : { payload }),
  };
}

function readOnlyDownstream(
  workspace: PublicProjection,
): ChallengeApiGateway {
  const notAllowed = async (): Promise<ChallengeMutationResult> => {
    throw new TypeError("not allowed");
  };
  return {
    getWorkspace: async () => workspace,
    getChallenge: async () => null,
    getEvidence: async () => null,
    getBenchmarkProgress: async () => ({
      schema_version: "benchmark-progress-projection-v1",
      synthetic: true,
      benchmark_id: workspace.benchmark_id,
      source_hash: workspace.source_hash,
      status: "REVIEW_PENDING",
    }),
    getBlindReview: async () => null,
    getDecision: async () => null,
    getBaseline: async () => null,
    getRegression: async () => null,
    structureDefine: notAllowed,
    lockChallenge: notAllowed,
    startBenchmark: notAllowed,
    confirmReview: notAllowed,
    createDecisionMemo: notAllowed,
    confirmDecision: notAllowed,
    startRegression: notAllowed,
  };
}

function dependencyHarness() {
  const artifact = defineArtifact();
  const locked = createLockedChallengeFixture();
  const benchmarkId = deriveStableBenchmarkId(
    {
      lockedChallengePackHash: locked.locked_challenge_pack_hash,
      hiddenDatasetHash: "9".repeat(64),
      scheduleId: "8".repeat(64),
    },
  );
  const scheduled: Array<() => Promise<void>> = [];
  let progress: PersistedBenchmarkProgressRecord | null = null;
  let benchmarkOutcome = completeBenchmarkOutcome(
    locked.locked_challenge_pack_hash,
  );
  const downstreamWorkspace = {
    schema_version: "workspace-public-projection-v1",
    synthetic: true,
    challenge_id: locked.challenge_id,
    benchmark_id: benchmarkId,
    review_id: "review_recorded",
    decision_id: null,
    baseline_id: null,
    regression_id: null,
    source_hash: "f".repeat(64),
    stage_statuses: {
      define: "LOCKED",
      compare: "RECORDED",
      decide: "REVIEW PENDING",
      monitor: "NO BASELINE",
    },
  } as const;
  const persistedReceipts: BenchmarkStartCommandReceipt[] = [];
  const dependencies: AuthoritativeChallengeLifecycleDependencies = {
    executeDefineStructure: vi.fn(async () => defineOutcome(artifact)),
    assertPersistedDefineArtifact: vi.fn(),
    executeHumanLock: vi.fn(async () => locked),
    assertAuthoritativeLockedChallengePack: vi.fn(),
    buildStableBenchmarkId: vi.fn(() => benchmarkId),
    persistStartReceipt: vi.fn(async (receipt) => {
      persistedReceipts.push(receipt);
      return { path: `/authority/${receipt.receipt_hash}.json` };
    }),
    loadStartReceipt: vi.fn(async ({ expectedReceipt }) => (
      structuredClone(expectedReceipt)
    )),
    loadPersistedProgress: vi.fn(async () => progress),
    executeRecordedBenchmark: vi.fn(async () => benchmarkOutcome),
    assertPersistedRecordedBenchmarkPack: vi.fn(),
    createRecordedReviewGateway: vi.fn(async () => (
      readOnlyDownstream(downstreamWorkspace)
    )),
    scheduleBackground: (task) => scheduled.push(task),
    now: vi.fn()
      .mockReturnValueOnce(t0)
      .mockReturnValueOnce(t1)
      .mockReturnValue(t2),
  };
  return {
    artifact,
    locked,
    benchmarkId,
    dependencies,
    scheduled,
    persistedReceipts,
    downstreamWorkspace,
    setProgress(value: PersistedBenchmarkProgressRecord | null) {
      progress = value;
    },
    setBenchmarkOutcome(value: RecordedBenchmarkOutcome) {
      benchmarkOutcome = value;
    },
  };
}

async function reachLocked(
  gateway: ChallengeApiGateway,
  harness: ReturnType<typeof dependencyHarness>,
): Promise<void> {
  const initial = await gateway.getWorkspace();
  await gateway.structureDefine(command(
    "define-structure-command-v1",
    initial.source_hash as string,
    "define",
    { actor_type: "HUMAN", actor_label: "Evaluation lead" },
  ));
  const proposed = await gateway.getWorkspace();
  await gateway.lockChallenge(command(
    "challenge-lock-command-v1",
    proposed.source_hash as string,
    harness.locked.challenge_id,
    {
      actor_type: "HUMAN",
      actor_label: "Evaluation lead",
      decision: "APPROVE_EXACT_CONTRACT",
      define_structuring_artifact_hash: harness.artifact.artifact_hash,
      approved_contract_hash: sha256CanonicalJson(
        SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract,
      ),
    },
    "mutation_lifecycle_002",
  ));
}

describe("권위 Challenge lifecycle controller", () => {
  it("재시작은 source-reloaded RUNNING 상태를 표시하지만 Benchmark를 자동 재실행하지 않는다", async () => {
    const harness = dependencyHarness();
    const startReceipt = buildBenchmarkStartCommandReceipt({
      benchmarkId: harness.benchmarkId,
      challengeId: harness.locked.challenge_id,
      challengeVersion: harness.locked.challenge_version,
      lockedChallengePackHash: harness.locked.locked_challenge_pack_hash,
      actorLabel: "Evaluation lead",
      executionMode: "START",
      resumeFromProgressHash: null,
      attemptNumber: 1,
      previousStartReceiptHash: null,
      startedAt: t1,
    });
    const hydrated: ChallengeLifecycleSourceState = {
      phase: "RUNNING",
      defineInput: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
      defineArtifact: harness.artifact,
      lockedChallengePack: harness.locked,
      benchmarkId: harness.benchmarkId,
      startReceipt,
      progress: null,
      failure: null,
    };
    const gateway = createAuthoritativeChallengeLifecycleController({
      dependencies: harness.dependencies,
      initialState: { sourceState: hydrated },
    });

    const progress = await gateway.getBenchmarkProgress(harness.benchmarkId);
    expect(progress).toMatchObject({ status: "RUNNING", completed: 0 });
    expect(gateway.isBenchmarkRunning()).toBe(false);
    expect(harness.scheduled).toHaveLength(0);
    expect(harness.dependencies.executeRecordedBenchmark).not.toHaveBeenCalled();
    await expect(gateway.startBenchmark(command(
      "benchmark-start-command-v1",
      progress?.source_hash as string,
      harness.benchmarkId,
      {
        actor_type: "HUMAN",
        actor_label: "Evaluation lead",
        execution_mode: "RESUME",
        acknowledgement: "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
        resume_from_progress_hash: null,
      },
    ))).rejects.toThrow(/RUNNING|single-flight/i);
  });

  it("DRAFT → advisory PROPOSED → exact 사람 승인 LOCKED/READY만 허용한다", async () => {
    const harness = dependencyHarness();
    const gateway = createAuthoritativeChallengeLifecycleController({
      dependencies: harness.dependencies,
    });
    const draft = await gateway.getChallenge(
      SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract.challenge_id,
    );
    expect(draft).toMatchObject({ state: "DRAFT", authority: "NONE" });

    const draftWorkspace = await gateway.getWorkspace();
    const defined = await gateway.structureDefine(command(
      "define-structure-command-v1",
      draftWorkspace.source_hash as string,
      "define",
      { actor_type: "HUMAN", actor_label: "Evaluation lead" },
    ));
    const proposed = await gateway.getChallenge(
      SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract.challenge_id,
    );
    expect(defined.source_hash).toBe(harness.artifact.artifact_hash);
    expect(proposed).toMatchObject({
      state: "PROPOSED",
      authority: "ADVISORY_ONLY",
      approved_contract_hash: sha256CanonicalJson(
        SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract,
      ),
    });

    const proposedWorkspace = await gateway.getWorkspace();
    await expect(gateway.lockChallenge(command(
      "challenge-lock-command-v1",
      proposedWorkspace.source_hash as string,
      harness.locked.challenge_id,
      {
        actor_type: "HUMAN",
        actor_label: "Evaluation lead",
        decision: "APPROVE_EXACT_CONTRACT",
        define_structuring_artifact_hash: harness.artifact.artifact_hash,
        approved_contract_hash: "0".repeat(64),
      },
    ))).rejects.toThrow(/contract|hash|승인/i);

    await gateway.lockChallenge(command(
      "challenge-lock-command-v1",
      proposedWorkspace.source_hash as string,
      harness.locked.challenge_id,
      {
        actor_type: "HUMAN",
        actor_label: "Evaluation lead",
        decision: "APPROVE_EXACT_CONTRACT",
        define_structuring_artifact_hash: harness.artifact.artifact_hash,
        approved_contract_hash: sha256CanonicalJson(
          SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract,
        ),
      },
      "mutation_lifecycle_002",
    ));
    const locked = await gateway.getChallenge(harness.locked.challenge_id);
    const ready = await gateway.getBenchmarkProgress(harness.benchmarkId);
    expect(locked).toMatchObject({
      state: "LOCKED",
      authority: "EXPLICIT_HUMAN_APPROVAL",
      locked_at: harness.locked.locked_at,
      approved_by: harness.locked.approved_by,
      task_contract: harness.locked.approved_contract.task_contract,
      evaluation_criteria:
        harness.locked.approved_contract.evaluation_criteria,
      hard_gates: harness.locked.approved_contract.hard_gates,
      candidate_complexity_profiles:
        harness.locked.approved_contract.candidate_complexity_profiles,
      sufficiency: harness.locked.approved_contract.sufficiency,
      source_manifest_hash: harness.locked.source_manifest_hash,
    });
    expect(ready).toMatchObject({
      benchmark_id: harness.benchmarkId,
      status: "READY",
      completed: 0,
      total: 72,
    });
  });

  it("start receipt를 source-reload한 뒤 즉시 accepted하고 background single-flight로 실행한다", async () => {
    const harness = dependencyHarness();
    const gateway = createAuthoritativeChallengeLifecycleController({
      dependencies: harness.dependencies,
    });
    await reachLocked(gateway, harness);
    const ready = await gateway.getWorkspace();
    const result = await gateway.startBenchmark(command(
      "benchmark-start-command-v1",
      ready.source_hash as string,
      harness.benchmarkId,
      {
        actor_type: "HUMAN",
        actor_label: "Evaluation lead",
        execution_mode: "START",
        acknowledgement:
          "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
        resume_from_progress_hash: null,
      },
      "mutation_lifecycle_003",
    ));

    expect(result.accepted).toBe(true);
    expect(harness.persistedReceipts).toHaveLength(1);
    expect(harness.scheduled).toHaveLength(1);
    expect(harness.dependencies.executeRecordedBenchmark)
      .not.toHaveBeenCalled();
    expect(await gateway.getBenchmarkProgress(harness.benchmarkId))
      .toMatchObject({ status: "RUNNING", completed: 0, total: 72 });

    const runningWorkspace = await gateway.getWorkspace();
    await expect(gateway.startBenchmark(command(
      "benchmark-start-command-v1",
      runningWorkspace.source_hash as string,
      harness.benchmarkId,
      {
        actor_type: "HUMAN",
        actor_label: "Evaluation lead",
        execution_mode: "START",
        acknowledgement:
          "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
        resume_from_progress_hash: null,
      },
      "mutation_lifecycle_004",
    ))).rejects.toThrow(/RUNNING|single.?flight|실행 중/i);
  });

  it("RUNNING GET마다 실제 persisted progress를 source-reload하고 private 자료를 공개하지 않는다", async () => {
    const harness = dependencyHarness();
    const gateway = createAuthoritativeChallengeLifecycleController({
      dependencies: harness.dependencies,
    });
    await reachLocked(gateway, harness);
    const ready = await gateway.getWorkspace();
    await gateway.startBenchmark(command(
      "benchmark-start-command-v1",
      ready.source_hash as string,
      harness.benchmarkId,
      {
        actor_type: "HUMAN",
        actor_label: "Evaluation lead",
        execution_mode: "START",
        acknowledgement:
          "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
        resume_from_progress_hash: null,
      },
      "mutation_lifecycle_003",
    ));
    harness.setProgress(buildPersistedBenchmarkProgressRecord({
      benchmarkId: harness.benchmarkId,
      challengeId: harness.locked.challenge_id,
      lockedChallengePackHash: harness.locked.locked_challenge_pack_hash,
      attemptNumber: 1,
      status: "RUNNING",
      candidateExecutionCompleted: 1,
      auxiliaryJudgeCompleted: 0,
      cleanupAcknowledged: 0,
      checkpointSource: "EXECUTED",
      resumeAllowed: false,
      resumeAction: "NONE",
      failure: null,
      updatedAt: t2,
    }));

    const progress = await gateway.getBenchmarkProgress(harness.benchmarkId);
    expect(harness.dependencies.loadPersistedProgress).toHaveBeenCalled();
    expect(progress).toMatchObject({
      status: "RUNNING",
      completed: 1,
      total: 72,
      last_slot_sequence: 1,
    });
    expect(JSON.stringify(await gateway.getWorkspace())).not.toMatch(
      /sk-|api[_-]?key|private_mapping|label_to_candidate|raw_oracle/i,
    );
  });

  it("정확한 72+12+cleanup33/33 outcome에서만 기존 recorded review gateway로 전환한다", async () => {
    const harness = dependencyHarness();
    const gateway = createAuthoritativeChallengeLifecycleController({
      dependencies: harness.dependencies,
    });
    await reachLocked(gateway, harness);
    const ready = await gateway.getWorkspace();
    await gateway.startBenchmark(command(
      "benchmark-start-command-v1",
      ready.source_hash as string,
      harness.benchmarkId,
      {
        actor_type: "HUMAN",
        actor_label: "Evaluation lead",
        execution_mode: "START",
        acknowledgement:
          "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
        resume_from_progress_hash: null,
      },
      "mutation_lifecycle_003",
    ));

    await harness.scheduled[0]();

    expect(harness.dependencies.createRecordedReviewGateway)
      .toHaveBeenCalledTimes(1);
    expect(await gateway.getWorkspace()).toEqual(
      harness.downstreamWorkspace,
    );
    expect(await gateway.getBenchmarkProgress(harness.benchmarkId))
      .toMatchObject({ status: "REVIEW_PENDING" });
  });

  it("downstream reviewer detail capability를 실제 HTTP reviewer route까지 그대로 전달한다", async () => {
    const harness = dependencyHarness();
    const reviewerDetail = vi.fn(async () => ({
      schema_version: "recorded-blind-review-evidence-detail-v1",
      synthetic: true,
      candidate_label: "Candidate X",
      runs: [{ customer_reply: "권한 있는 reviewer 상세" }],
    }));
    vi.mocked(harness.dependencies.createRecordedReviewGateway)
      .mockResolvedValueOnce(Object.assign(
        readOnlyDownstream(harness.downstreamWorkspace),
        { getReviewerBlindEvidenceDetail: reviewerDetail },
      ));
    const gateway = createAuthoritativeChallengeLifecycleController({
      dependencies: harness.dependencies,
    });
    await reachLocked(gateway, harness);
    const ready = await gateway.getWorkspace();
    await gateway.startBenchmark(command(
      "benchmark-start-command-v1",
      ready.source_hash as string,
      harness.benchmarkId,
      {
        actor_type: "HUMAN",
        actor_label: "Evaluation lead",
        execution_mode: "START",
        acknowledgement: "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
        resume_from_progress_hash: null,
      },
      "mutation_lifecycle_reviewer_detail_001",
    ));
    await harness.scheduled[0]();

    const handler = createChallengeApiHandler({
      gateway,
      reviewerAuthorizer: {
        authorize: (request) => (
          request.headers.get("authorization") === "Bearer lifecycle-reviewer"
          && request.headers.get("host") === "127.0.0.1"
          && request.headers.get("origin") === "http://127.0.0.1"
          && request.headers.get("sec-fetch-site") === "same-origin"
        ) ? null : 401,
      },
    });
    const response = await handler(new Request(
      "http://127.0.0.1/api/reviewer/evidence/review_opaque_1",
      {
        headers: {
          authorization: "Bearer lifecycle-reviewer",
          host: "127.0.0.1",
          origin: "http://127.0.0.1",
          "sec-fetch-site": "same-origin",
          "x-review-evidence-handle": `evh_${"a".repeat(64)}`,
        },
      },
    ));

    expect(response.status).toBe(200);
    expect(reviewerDetail).toHaveBeenCalledWith({
      evidenceId: "review_opaque_1",
      evidenceHandle: `evh_${"a".repeat(64)}`,
    });
  });

  it("불완전 cleanup은 INVALID + retry cleanup 정보로 남기고 정확한 progress hash로만 RESUME한다", async () => {
    const harness = dependencyHarness();
    const failed = completeBenchmarkOutcome(
      harness.locked.locked_challenge_pack_hash,
    );
    harness.setBenchmarkOutcome({
      ...failed,
      exitCode: 2,
      serverAuthority: null,
      summary: {
        ...failed.summary,
        command_status: "RECORDED_BENCHMARK_CLEANUP_INCOMPLETE",
        clean_completion: false,
        cleanup: {
          ...failed.summary.cleanup,
          acknowledged: 32,
          incomplete: 1,
          resources: failed.summary.cleanup.resources.map(
            (resource, index) => index === 0
              ? { ...resource, delete_acknowledged: false }
              : resource,
          ),
        },
      },
    });
    const gateway = createAuthoritativeChallengeLifecycleController({
      dependencies: harness.dependencies,
    });
    await reachLocked(gateway, harness);
    const ready = await gateway.getWorkspace();
    await gateway.startBenchmark(command(
      "benchmark-start-command-v1",
      ready.source_hash as string,
      harness.benchmarkId,
      {
        actor_type: "HUMAN",
        actor_label: "Evaluation lead",
        execution_mode: "START",
        acknowledgement:
          "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
        resume_from_progress_hash: null,
      },
      "mutation_lifecycle_003",
    ));
    await harness.scheduled[0]();

    const invalid = await gateway.getBenchmarkProgress(harness.benchmarkId);
    expect(invalid).toMatchObject({
      status: "INVALID",
      cleanup: { required: 33, acknowledged: 32, incomplete: 1 },
      resume: {
        allowed: true,
        action: "RETRY_CLEANUP",
      },
      failure: { code: "CLEANUP_INCOMPLETE", phase: "CLEANUP" },
    });
    const invalidWorkspace = await gateway.getWorkspace();
    const invalidHash = invalidWorkspace.source_hash as string;
    await expect(gateway.startBenchmark(command(
      "benchmark-start-command-v1",
      invalidHash,
      harness.benchmarkId,
      {
        actor_type: "HUMAN",
        actor_label: "Evaluation lead",
        execution_mode: "RESUME",
        acknowledgement:
          "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
        resume_from_progress_hash: "0".repeat(64),
      },
      "mutation_lifecycle_004",
    ))).rejects.toThrow(/resume|progress|hash/i);

    await gateway.startBenchmark(command(
      "benchmark-start-command-v1",
      invalidHash,
      harness.benchmarkId,
      {
        actor_type: "HUMAN",
        actor_label: "Evaluation lead",
        execution_mode: "RESUME",
        acknowledgement:
          "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
        resume_from_progress_hash: invalidHash,
      },
      "mutation_lifecycle_005",
    ));
    expect(harness.persistedReceipts).toHaveLength(2);
    expect(harness.persistedReceipts[1]).toMatchObject({
      execution_mode: "RESUME",
      attempt_number: 2,
      resume_from_progress_hash: invalidHash,
      previous_start_receipt_hash:
        harness.persistedReceipts[0].receipt_hash,
    });
  });

  it("HTTP exact schema·stale hash·idempotency replay를 side effect 전에 거부한다", async () => {
    const harness = dependencyHarness();
    const gateway = createAuthoritativeChallengeLifecycleController({
      dependencies: harness.dependencies,
    });
    const handler = createChallengeApiHandler({ gateway });
    const workspace = await gateway.getWorkspace();
    const body = {
      schema_version: "define-structure-command-v1",
      expected_source_hash: workspace.source_hash,
      idempotency_key: "mutation_lifecycle_http_001",
      payload: {
        actor_type: "HUMAN",
        actor_label: "Evaluation lead",
      },
    };
    const invoke = () => handler(new Request(
      "http://127.0.0.1/api/define/structure",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ));

    expect((await invoke()).status).toBe(200);
    expect((await invoke()).status).toBe(409);
    expect(harness.dependencies.executeDefineStructure)
      .toHaveBeenCalledTimes(1);

    const stale = await handler(new Request(
      "http://127.0.0.1/api/challenges/"
      + `${harness.locked.challenge_id}/lock`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema_version: "challenge-lock-command-v1",
          expected_source_hash: workspace.source_hash,
          idempotency_key: "mutation_lifecycle_http_002",
          payload: {},
        }),
      },
    ));
    expect(stale.status).toBe(409);
    expect(harness.dependencies.executeHumanLock).not.toHaveBeenCalled();
  });

  it("source hash가 현재 상태와 다르면 모든 mutation을 거부한다", async () => {
    const harness = dependencyHarness();
    const gateway = createAuthoritativeChallengeLifecycleController({
      dependencies: harness.dependencies,
    });
    await expect(gateway.structureDefine(command(
      "define-structure-command-v1",
      "0".repeat(64),
      "define",
      { actor_type: "HUMAN", actor_label: "Evaluation lead" },
    ))).rejects.toBeInstanceOf(ApiArtifactIntegrityError);
    expect(harness.dependencies.executeDefineStructure)
      .not.toHaveBeenCalled();
  });
});

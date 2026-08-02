// @vitest-environment node

import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  benchmarkSlotIdentityHashes,
  buildBenchmarkExecutionIdentity,
  buildBenchmarkSlotIdentity,
  persistBenchmarkExecutionIdentityAuthority,
} from "../benchmark/identity";
import { createBenchmarkCandidateDefinition } from "../benchmark/candidateDefinitions";
import { buildBenchmarkSchedule } from "../benchmark/schedule";
import type { CandidateOutput } from "../contracts/candidateOutput";
import {
  buildPolicyManifestHash,
  buildRunnerInputAccessEvidence,
} from "../contracts/runnerInputAccessEvidence";
import {
  BENCHMARK_CASES,
  BENCHMARK_CHALLENGE,
  BENCHMARK_ORDERS,
  BENCHMARK_ORACLES,
  BENCHMARK_POLICIES,
  HIGH_RISK_CASE_IDS,
} from "../data/benchmark";
import {
  BENCHMARK_CANDIDATE_IDS,
} from "../judge/blinding";
import {
  buildBlindJudgeInput,
  type CandidateJudgeSource,
} from "../judge/buildJudgeInput";
import {
  BLIND_JUDGE_LABELS,
  BLIND_JUDGE_LOCKED_CRITERIA,
  type BlindJudgeLabel,
  type BlindJudgeResult,
  type BlindJudgeSeverity,
} from "../judge/contracts";
import {
  JudgeInvocationError,
  type JudgeAdapter,
} from "../judge/openaiJudgeAdapter";
import {
  JUDGE_PRICING_SNAPSHOT,
  runBlindJudge,
  type BlindJudgeRunRecord,
} from "../judge/runJudge";
import {
  claimBlindJudgeCaseDispatch,
  claimBlindJudgeCaseIntent,
  createBlindJudgeCaseArtifactPaths,
  JudgeCaseAmbiguousInFlightError,
  runOrResumeBlindJudgeCase,
} from "../judge/judgeCaseLedger";
import {
  evaluateHardGates,
  type CompletedCandidateExecutionEvidence,
} from "../deterministic/hardGates";
import { buildBenchmarkExecutionPack } from "../pack/benchmarkPack";
import {
  assertValidatedJudgeEvidencePack,
  buildJudgeEvidencePack,
  createJudgeEvidencePackPaths,
  loadJudgeEvidencePack,
  persistJudgeEvidencePack,
} from "../pack/judgeEvidencePack";
import {
  assertPersistedRecordedBenchmarkPack,
  assertValidatedRecordedBenchmarkPack,
  buildRecordedBenchmarkPack,
  buildRecordedBenchmarkPublicProjection,
  createRecordedBenchmarkPackPaths,
  loadRecordedBenchmarkPack,
  persistRecordedBenchmarkPack,
  type RecordedBenchmarkPack,
} from "../pack/recordedBenchmarkPack";
import type {
  BenchmarkSlotExecutionCheckpoint,
  BenchmarkSlotExecutionIntent,
  BenchmarkSlotExecutionReceipt,
} from "../pack/benchmarkPersistence";
import {
  createBenchmarkSlotArtifactPaths,
  persistBenchmarkSlotArtifact,
} from "../pack/benchmarkPersistence";
import {
  loadPersistedBenchmarkExecutionEvidence,
} from "../pack/loadBenchmarkExecutionEvidence";
import {
  promoteRecordedBenchmarkWithAdapter,
} from "../pack/promoteRecordedBenchmark";
import {
  assertAuthoritativePrivateBlindingContext,
  createAuthoritativePrivateBlindingContextReference,
  createAuthoritativePrivateBlindingContextReferenceForTest,
  createPrivateBlindingSeedPaths,
  loadAuthoritativePrivateBlindingContextForTest,
  loadOrCreateAuthoritativePrivateBlindingContext,
  loadOrCreateAuthoritativePrivateBlindingContextForTest,
} from "../review/privateBlindingSeedPersistence";
import {
  assertValidatedBlindReviewQueue,
  buildBlindReviewQueue,
  calculateBlindReviewQueueContentHash,
  calculateBlindReviewQueueSetOrderHash,
  type BuildBlindReviewQueueInput,
  type ReviewQueueJudgeCase,
} from "../review/buildReviewQueue";
import {
  assertValidatedAiPreReviewReceipt,
  assertPersistedAiPreReviewReceipt,
  buildAiPreReviewReceipt,
  calculateBlindQueueJudgeEvidenceHash,
  createAiPreReviewReceiptPaths,
  loadAiPreReviewReceipt,
  persistAiPreReviewReceipt,
  type AiPreReviewReceipt,
  type AiPreReviewCommand,
} from "../review/preReviewReceipt";
import {
  assertValidatedHumanConfirmationReceipt,
  buildHumanConfirmationReceipt,
  createHumanConfirmationExpectedContext,
  createHumanConfirmationReceiptPaths,
  loadHumanConfirmationReceipt,
  persistHumanConfirmationReceipt,
  type HumanConfirmationCommand,
  type HumanConfirmationExpectedContext,
} from "../review/humanConfirmation";
import {
  assertValidatedProvisionalDecisionMemo,
  assertPersistedProvisionalDecisionMemo,
  buildProvisionalDecisionMemo,
  createProvisionalDecisionMemoPaths,
  loadProvisionalDecisionMemo,
  persistProvisionalDecisionMemo,
  type ProvisionalDecisionMemo,
} from "../decision/provisionalMemo";
import {
  buildBlindReviewPublicProjections,
  buildBaselinePublicProjection,
  buildDecisionPublicProjection,
  buildLockedChallengePublicProjection,
  buildPreconfirmationPublicProjection,
  buildPreconfirmationWorkspacePublicProjection,
  buildRecordedBenchmarkEvidenceProjections,
  buildRecordedBenchmarkProgressProjection,
  buildRecordedWorkspacePublicProjection,
} from "../../server/workflowProjections";
import {
  buildProjectionSnapshot,
  createReadOnlyProjectionGateway,
  loadReadOnlyProjectionSnapshotRecord,
} from "../../server/projectionRepository";
import { createChallengeApiHandler } from "../../server/challengeServer";
import {
  assertAuthoritativeRecordedWorkflowProjectionSnapshot,
  buildRecordedDecisionProjectionSnapshot,
  buildRecordedReviewProjectionSnapshot,
  persistRecordedDecisionProjectionSnapshot,
} from "../../server/recordedWorkflowSnapshot";
import {
  buildDeterministicAiPreReviewCommand,
} from "../../server/authoritativeWorkspaceRuntime";
import {
  assertAuthoritativeDecisionBaselineRecord,
  assertAuthoritativeNoApprovedCandidateRecord,
  assertPersistedFinalDecisionConfirmationReceipt,
  assertPersistedFinalDecisionMemo,
  assertPersistedHumanConfirmedDecisionContext,
  buildDecisionAuthorityRecord,
  buildFinalDecisionMemoRequiredOutput,
  buildFinalDecisionMemoClaimEvidenceRefs,
  buildFinalDecisionConfirmationReceipt,
  buildHumanConfirmedDecisionContext,
  createFinalDecisionMemoPaths,
  loadDecisionAuthorityRecord,
  loadFinalDecisionConfirmationReceipt,
  loadFinalDecisionMemo,
  loadPersistedHumanConfirmedDecisionContext,
  FINAL_DECISION_MEMO_OUTPUT_SCHEMA,
  FINAL_DECISION_MEMO_OPENAI_REQUEST_CONTRACT,
  FINAL_DECISION_MEMO_PRICING_SNAPSHOT,
  persistFinalDecisionConfirmationReceipt,
  persistFinalDecisionMemo,
  persistDecisionAuthorityRecord,
  runFinalDecisionMemo,
  type DecisionSelectionCommand,
  type FinalDecisionConfirmationReceipt,
  type FinalDecisionMemo,
  type FinalDecisionMemoAdapter,
  type FinalDecisionMemoAdapterOutput,
  type FinalDecisionMemoAdapterRequest,
  type FinalDecisionMemoAdapterResult,
  type HumanConfirmedDecisionContext,
} from "../decision/decisionBaseline";
import {
  buildExecutionBoundPrivateBlindMapping,
  buildJudgeEvidencePrecommitManifest,
} from "../review/judgeEvidenceManifest";
import {
  DEFAULT_REGRESSION_BASELINE_ASSERTION,
} from "../regression/runRegression";
import {
  createTestAuthoritativeBlindingPrecommitAuthority,
  createTestAuthoritativeBlindingPrecommitStore,
  createAuthoritativeBlindingPrecommitReference,
  createAuthoritativeBlindingPrecommitReferenceForTest,
  persistAuthoritativeBlindingPrecommit,
  persistAuthoritativeBlindingPrecommitForTest,
  type AuthoritativeBlindingPrecommit,
  type AuthoritativeBlindingPrecommitStore,
  type TestAuthoritativeBlindingPrecommitAuthority,
} from "../review/judgeEvidencePrecommitPersistence";
import type { CandidateAdapter } from "../runner/types";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  calculateUsageCost,
  DEFAULT_PRICING_SNAPSHOT,
  type TokenUsage,
} from "../runtime/pricing";
import { LOCKED_CHALLENGE_FIXTURE } from "./helpers/lockedChallengeFixture";

/**
 * write-once persistence 테스트는 `/var` 별칭이나 umask에 기대지 않도록
 * canonical 실제 경로와 0700 권한을 명시적으로 준비합니다.
 */
async function secureTempDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await chmod(directory, 0o700);
  return directory;
}

const MASTER_BLINDING_SEED =
  "review-queue-master-blinding-seed-for-hidden-benchmark-0000000001";
const REBLINDING_ATTACK_MASTER_SEED =
  "review-queue-post-hoc-reblinding-attack-seed-hidden-benchmark-0002";
const schedule = buildBenchmarkSchedule(BENCHMARK_CASES, ["A", "B", "C"]);
const executionIdentity = buildBenchmarkExecutionIdentity({
  lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
  scheduleId: schedule.schedule_id,
  policyManifestHash: "1".repeat(64),
  policyResourceIdentityHash: "2".repeat(64),
  policyVectorStoreId: "vs_review_queue_offline_fixture",
});
// server process 재시작 E2E는 아래 persisted source builder만 재사용합니다.
// test module을 import했을 때 이 파일의 독립 단위 테스트를 중복 등록하지 않습니다.
const registerReviewQueueTests = (globalThis as {
  __reuseRecordedReviewFixture?: boolean;
}).__reuseRecordedReviewFixture !== true;

if (registerReviewQueueTests) describe("Recorded Benchmark 권위 부모 아티팩트", () => {
  it("검증된 실행·precommit·12개 Judge 증거·blind queue를 하나의 평가 미완료 체인으로 결합한다", async () => {
    const {
      input,
      benchmarkPack,
      queue,
      judgeEvidencePack,
      recordedPack,
    } = await task10Authority();

    assertValidatedJudgeEvidencePack(judgeEvidencePack);
    expect(judgeEvidencePack).toMatchObject({
      artifact_kind: "JUDGE_EVIDENCE_PACK",
      source: "RECORDED_BENCHMARK",
      execution_status: "EXECUTION_COMPLETE",
      judge_status: "JUDGE_COMPLETE",
      review_status: "REVIEW_PENDING",
      evaluation_status: "EVALUATION_INCOMPLETE",
      baseline_version: null,
      execution_pack_hash: sha256CanonicalJson(benchmarkPack),
      precommit_manifest_digest:
        input.authoritative_blinding_precommit.manifest_digest,
      coverage: {
        expected_cases: 12,
        recorded_cases: 12,
        complete_judge_receipts: 12,
      },
    });
    expect(judgeEvidencePack.cases.map((item) => item.case_id)).toEqual(
      BENCHMARK_CASES.map((item) => item.case_id),
    );
    expect(judgeEvidencePack.costs.candidate_execution.total_usd).toBe(
      benchmarkPack.candidate_aggregates.reduce(
        (total, item) => total + item.cost.total_usd!,
        0,
      ),
    );
    expect(judgeEvidencePack.costs.auxiliary_judge.total_usd).toBe(
      input.judge_cases.reduce(
        (total, item) => total + item.judge_run_receipt.usageCost!.totalCostUsd,
        0,
      ),
    );

    expect(recordedPack).toMatchObject({
      artifact_kind: "RECORDED_BENCHMARK_PACK",
      source: "RECORDED_BENCHMARK",
      execution_status: "EXECUTION_COMPLETE",
      judge_status: "JUDGE_COMPLETE",
      review_status: "REVIEW_PENDING",
      evaluation_status: "EVALUATION_INCOMPLETE",
      baseline_version: null,
      execution_pack_hash: sha256CanonicalJson(benchmarkPack),
      judge_evidence_pack_hash: sha256CanonicalJson(judgeEvidencePack),
      queue_content_hash: queue.queue_content_hash,
      queue_set_order_hash: queue.queue_set_order_hash,
    });
    expect(recordedPack.costs).toEqual(judgeEvidencePack.costs);

    const projectionSourceDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "recorded-projection-source-"),
    ));
    const recordedPersisted = await persistRecordedBenchmarkPack({
      outputDirectory: projectionSourceDirectory,
      pack: recordedPack,
    });
    const sourceReloadedRecordedPack = await loadRecordedBenchmarkPack({
      path: recordedPersisted.path,
      authority: {
        benchmarkPack,
        judgeEvidencePack,
        blindReviewQueue: queue,
      },
    });
    const projection = buildRecordedBenchmarkPublicProjection(
      sourceReloadedRecordedPack,
    );
    const serializedProjection = canonicalJsonStringify(projection);
    expect(serializedProjection).not.toMatch(
      /private_mapping|label_to_candidate|blinding_seed|case_blinding_seed/i,
    );
    expect(serializedProjection).not.toMatch(
      /recommendation|winner|approved|selected_candidate/i,
    );
    expect(projection).toMatchObject({
      artifact_kind: "RECORDED_BENCHMARK_PUBLIC_PROJECTION",
      review_status: "REVIEW_PENDING",
      evaluation_status: "EVALUATION_INCOMPLETE",
      baseline_version: null,
      queue_content_hash: queue.queue_content_hash,
    });

    const progress = buildRecordedBenchmarkProgressProjection(
      sourceReloadedRecordedPack,
    );
    expect(progress).toMatchObject({
      schema_version: "benchmark-progress-projection-v1",
      synthetic: true,
      benchmark_id: benchmarkPack.execution_hash,
      source_hash: sha256CanonicalJson(recordedPack),
      source: "RECORDED_BENCHMARK",
      status: "REVIEW_PENDING",
      completed: 72,
      total: 72,
      review_time: "NOT_MEASURED",
      edit_time: "NOT_MEASURED",
    });
    expect(progress.slots).toHaveLength(72);
    expect(progress.slots[0]).toEqual({
      evidence_id: expect.stringMatching(/^slot_[a-f0-9]{64}$/),
      case_id: "H-001",
      candidate_id: "A",
      repetition: 1,
      execution_status: "COMPLETE",
      evaluation_status: "EVALUATED",
      hard_gate_status: "PASS",
      cost_usd: expect.any(Number),
      latency_ms: expect.any(Number),
    });
    expect(canonicalJsonStringify(progress)).not.toMatch(
      /private_mapping|label_to_candidate|blinding_seed|hidden_oracle|raw_oracle/i,
    );

    const evidence = buildRecordedBenchmarkEvidenceProjections(
      sourceReloadedRecordedPack,
    );
    // 공개 Compare projection은 후보 라벨이 있는 72개 실행 증거만 노출합니다.
    // X/Y/Z blind queue·실제 output·private mapping은 reviewer 전용 경계에만
    // 남아야 하므로 public evidence에 추가하면 안 됩니다.
    expect(evidence).toHaveLength(72);
    expect(evidence.filter((item) => item.kind === "benchmark")).toHaveLength(72);
    expect(evidence.filter((item) => item.kind === "blind-review")).toHaveLength(0);
    expect(evidence.find((item) => item.kind === "benchmark")).toMatchObject({
      schema_version: "evidence-public-projection-v1",
      source_hash: sha256CanonicalJson(recordedPack),
      source: "RECORDED BENCHMARK",
      case_id: "H-001",
      candidate_label: "Candidate A",
      status: "PASS",
    });
    expect(canonicalJsonStringify(evidence)).not.toMatch(
      /private_mapping|label_to_candidate|blinding_seed|case_blinding_seed|run_one|run_two|BLIND HUMAN REVIEW|Candidate [XYZ]\b|\bsingle llm\b|\brag\b|\btool workflow\b/i,
    );

    const reviews = buildBlindReviewPublicProjections(
      sourceReloadedRecordedPack,
    );
    // reviewer detail은 권한이 검증된 전용 endpoint가 source-reload해 제공하며,
    // public snapshot에는 queue item 자체를 넣지 않습니다.
    expect(reviews).toHaveLength(0);
    expect(canonicalJsonStringify(reviews)).toBe("[]");

    const workspace = buildRecordedWorkspacePublicProjection({
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      recordedBenchmarkPack: sourceReloadedRecordedPack,
    });
    expect(workspace).toEqual({
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
      challenge_id: LOCKED_CHALLENGE_FIXTURE.challenge_id,
      benchmark_id: recordedPack.benchmark_execution_pack.execution_hash,
      review_id: null,
      decision_id: null,
      baseline_id: null,
      regression_id: null,
      source_hash: sha256CanonicalJson(recordedPack),
      stage_statuses: {
        define: "LOCKED",
        compare: "RECORDED",
        decide: "REVIEW PENDING",
        monitor: "NO BASELINE",
      },
    });

    const challengeProjection = buildLockedChallengePublicProjection(
      LOCKED_CHALLENGE_FIXTURE,
    );
    const snapshot = buildProjectionSnapshot({
      source_chain: [
        {
          artifact_kind: "LOCKED_CHALLENGE_PACK",
          artifact_id: LOCKED_CHALLENGE_FIXTURE.challenge_id,
          payload_sha256: LOCKED_CHALLENGE_FIXTURE.locked_challenge_pack_hash,
        },
        {
          artifact_kind: "RECORDED_BENCHMARK_PACK",
          artifact_id: recordedPack.benchmark_execution_pack.execution_hash,
          payload_sha256: sha256CanonicalJson(recordedPack),
        },
      ],
      workspace,
      challenges: [challengeProjection],
      evidence,
      benchmark_progress: [progress],
      blind_reviews: reviews,
      decisions: [],
      baselines: [],
      regressions: [],
    });
    const handler = createChallengeApiHandler({
      gateway: createReadOnlyProjectionGateway(snapshot),
    });
    const workspaceResponse = await handler(new Request(
      "http://127.0.0.1/api/workspace",
    ));
    expect(workspaceResponse.status).toBe(200);
    expect(await workspaceResponse.json()).toEqual(workspace);
    const evidenceResponse = await handler(new Request(
      `http://127.0.0.1/api/evidence/${evidence[0].evidence_id}`,
    ));
    expect(evidenceResponse.status).toBe(200);
    expect(await evidenceResponse.json()).toEqual(evidence[0]);
  }, 15_000);

  it("안전한 Judge 실패 여러 건을 별도 사람 fallback으로 보존하고 부분 상태·비용을 정직하게 집계한다", async () => {
    const {
      input,
      queue,
      judgeEvidencePack,
      recordedPack,
    } = await task10Authority({
      fallbackCaseIds: ["H-001", "H-002"],
    });

    expect(queue).toMatchObject({
      required_item_count: 12,
      additional_item_count: 0,
      human_fallback_case_count: 2,
      human_fallback_item_count: 6,
    });
    const fallbackItems = queue.items.filter(
      (item) => item.queue_reason === "JUDGE_INCOMPLETE_FALLBACK",
    );
    expect(fallbackItems).toHaveLength(6);
    expect(fallbackItems.map((item) => item.case_id)).toEqual([
      "H-001", "H-001", "H-001", "H-002", "H-002", "H-002",
    ]);
    expect(fallbackItems.every((item) => (
      item.judge_risks.length === 0
      && item.runs.length === 2
      && item.review_authority === "HUMAN_REVIEW_REQUIRED"
    ))).toBe(true);

    expect(judgeEvidencePack).toMatchObject({
      judge_status: "JUDGE_PARTIAL_HUMAN_FALLBACK",
      coverage: {
        expected_cases: 12,
        recorded_cases: 12,
        complete_judge_cases: 10,
        human_fallback_judge_cases: 2,
      },
      costs: {
        auxiliary_judge: {
          accounted_cases: 12,
        },
      },
    });
    expect(judgeEvidencePack.costs.auxiliary_judge.total_usd).toBe(
      input.judge_cases.reduce(
        (total, item) => total + item.judge_run_receipt.usageCost!.totalCostUsd,
        0,
      ),
    );
    expect(recordedPack).toMatchObject({
      judge_status: "JUDGE_PARTIAL_HUMAN_FALLBACK",
      review_status: "REVIEW_PENDING",
      evaluation_status: "EVALUATION_INCOMPLETE",
      baseline_version: null,
      coverage: {
        complete_judge_cases: 10,
        human_fallback_judge_cases: 2,
      },
    });
  });

  it.each([
    "SENT_OUTCOME_UNKNOWN",
    "COST_INCOMPLETE",
  ] as const)("%s Judge 실패는 사람 fallback으로 승격하지 않는다", async (mode) => {
    const input = await reviewInput();
    const unsafe = cloneReviewInput(input) as unknown as {
      judge_cases: Array<Record<string, any>>;
      authoritative_blinding_precommit: AuthoritativeBlindingPrecommit;
    };
    const judgeCase = unsafe.judge_cases[0]!;
    judgeCase.judge_run_receipt = await unsafeIncompleteJudgeRun(
      judgeCase.expected_blind_input,
      unsafe.authoritative_blinding_precommit,
      mode,
    );

    expect(() => buildBlindReviewQueue(
      unsafe as unknown as BuildBlindReviewQueueInput,
    )).toThrow(/비용|fallback|outcome|Judge/i);
  });

  it("두 권위 팩을 canonical 0600 write-once로 저장하고 동일 권위 입력으로만 load한다", async () => {
    const authority = await task10Authority();
    const outputDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "recorded-benchmark-parent-"),
    ));
    const judgePersisted = await persistJudgeEvidencePack({
      outputDirectory,
      pack: authority.judgeEvidencePack,
    });
    const recordedPersisted = await persistRecordedBenchmarkPack({
      outputDirectory,
      pack: authority.recordedPack,
    });
    const judgePaths = createJudgeEvidencePackPaths({
      outputDirectory,
      executionPackHash: authority.judgeEvidencePack.execution_pack_hash,
      payloadSha256: sha256CanonicalJson(authority.judgeEvidencePack),
    });
    const recordedPaths = createRecordedBenchmarkPackPaths({
      outputDirectory,
      executionPackHash: authority.recordedPack.execution_pack_hash,
      payloadSha256: sha256CanonicalJson(authority.recordedPack),
    });

    expect(judgePersisted.path).toBe(judgePaths.recordPath);
    expect(recordedPersisted.path).toBe(recordedPaths.recordPath);
    expect((await lstat(judgePaths.claimPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(judgePaths.recordPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(recordedPaths.claimPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(recordedPaths.recordPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(judgePaths.recordPath, "utf8")).not.toContain(
      MASTER_BLINDING_SEED,
    );

    const loadedJudge = await loadJudgeEvidencePack({
      path: judgePersisted.path,
      authority: {
        benchmarkPack: authority.benchmarkPack,
        reviewQueueInput: authority.input,
        blindReviewQueue: authority.queue,
      },
    });
    const loadedRecorded = await loadRecordedBenchmarkPack({
      path: recordedPersisted.path,
      authority: {
        benchmarkPack: authority.benchmarkPack,
        judgeEvidencePack: loadedJudge,
        blindReviewQueue: authority.queue,
      },
    });
    assertValidatedJudgeEvidencePack(loadedJudge);
    assertValidatedRecordedBenchmarkPack(loadedRecorded);
    expect(sha256CanonicalJson(loadedJudge)).toBe(
      sha256CanonicalJson(authority.judgeEvidencePack),
    );
    expect(sha256CanonicalJson(loadedRecorded)).toBe(
      sha256CanonicalJson(authority.recordedPack),
    );
  }, 15_000);

  it("persist-only·clone·새 build 객체는 공개 권위가 아니며 canonical source-reload 객체만 권위다", async () => {
    const authority = await task10Authority();
    const outputDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "recorded-benchmark-source-reload-brand-"),
    ));
    const persisted = await persistRecordedBenchmarkPack({
      outputDirectory,
      pack: authority.recordedPack,
    });

    expect(() => assertPersistedRecordedBenchmarkPack(authority.recordedPack))
      .toThrow(/source|reload|load|저장|권위/i);
    expect(() => buildRecordedBenchmarkPublicProjection(authority.recordedPack))
      .toThrow(/source|reload|load|저장|권위/i);
    expect(() => assertPersistedRecordedBenchmarkPack(
      structuredClone(authority.recordedPack),
    )).toThrow(/source|reload|load|저장|권위|build|검증/i);

    const rebuilt = buildRecordedBenchmarkPack({
      benchmarkPack: authority.benchmarkPack,
      judgeEvidencePack: authority.judgeEvidencePack,
      blindReviewQueue: authority.queue,
    });
    expect(() => assertPersistedRecordedBenchmarkPack(rebuilt))
      .toThrow(/source|reload|load|저장|권위/i);

    const loaded = await loadRecordedBenchmarkPack({
      path: persisted.path,
      authority: {
        benchmarkPack: authority.benchmarkPack,
        judgeEvidencePack: authority.judgeEvidencePack,
        blindReviewQueue: authority.queue,
      },
    });
    expect(() => assertPersistedRecordedBenchmarkPack(loaded)).not.toThrow();
    expect(buildRecordedBenchmarkPublicProjection(loaded))
      .toMatchObject({
        artifact_kind: "RECORDED_BENCHMARK_PUBLIC_PROJECTION",
        recorded_benchmark_pack_hash: sha256CanonicalJson(loaded),
      });
  }, 15_000);

  it("clone·fabricated 부모 팩과 public projection 누출용 clone을 권위 객체로 받아들이지 않는다", async () => {
    const authority = await task10Authority();
    const judgeClone = structuredClone(authority.judgeEvidencePack);
    const recordedClone = structuredClone(authority.recordedPack);

    expect(() => assertValidatedJudgeEvidencePack(judgeClone)).toThrow(
      /권위|build|load|검증/i,
    );
    expect(() => buildRecordedBenchmarkPack({
      benchmarkPack: authority.benchmarkPack,
      judgeEvidencePack: judgeClone,
      blindReviewQueue: authority.queue,
    })).toThrow(/권위|build|load|검증/i);
    expect(() => buildRecordedBenchmarkPublicProjection(recordedClone))
      .toThrow(/권위|build|load|검증/i);
    await expect(persistJudgeEvidencePack({
      outputDirectory: await realpath(await mkdtemp(
        join(tmpdir(), "judge-pack-clone-"),
      )),
      pack: judgeClone,
    })).rejects.toThrow(/권위|build|load|검증/i);
  }, 15_000);

  it.each([
    {
      label: "Judge case additional key",
      mutate: (input: BuildBlindReviewQueueInput) => {
        (input.judge_cases[0] as unknown as Record<string, unknown>).unexpected = true;
      },
    },
    {
      label: "Judge case order mismatch",
      mutate: (input: BuildBlindReviewQueueInput) => {
        (input.judge_cases as ReviewQueueJudgeCase[]).reverse();
      },
    },
    {
      label: "Judge cost mismatch",
      mutate: (input: BuildBlindReviewQueueInput) => {
        const receipt = input.judge_cases[0].judge_run_receipt;
        receipt.usageCost!.totalCostUsd += 1;
      },
    },
    {
      label: "private mapping mismatch",
      mutate: (input: BuildBlindReviewQueueInput) => {
        const mapping = input.judge_cases[0].private_mapping as unknown as {
          label_to_candidate: Record<BlindJudgeLabel, CandidateId>;
        };
        const originalX = mapping.label_to_candidate.X;
        mapping.label_to_candidate.X = mapping.label_to_candidate.Y;
        mapping.label_to_candidate.Y = originalX;
      },
    },
  ])("$label 변조를 부모 팩 생성 전에 거부한다", async ({ mutate }) => {
    const authority = await task10Authority();
    const tampered = cloneReviewInput(authority.input);
    mutate(tampered);
    expect(() => buildJudgeEvidencePack({
      benchmarkPack: authority.benchmarkPack,
      reviewQueueInput: tampered,
      blindReviewQueue: authority.queue,
    })).toThrow(/추가|순서|cost|비용|mapping|hash|무결성|다릅니다|계약/i);
  }, 15_000);

  it("같은 실행이라도 Judge receipt가 다른 validated queue를 섞을 수 없다", async () => {
    const authority = await task10Authority();
    const alternate = await task10Authority({
      risks: {
        "H-001": { X: "HIGH" },
      },
    });
    expect(alternate.queue.execution_pack_hash).toBe(
      authority.queue.execution_pack_hash,
    );
    expect(alternate.queue.queue_content_hash).not.toBe(
      authority.queue.queue_content_hash,
    );
    expect(() => buildRecordedBenchmarkPack({
      benchmarkPack: authority.benchmarkPack,
      judgeEvidencePack: authority.judgeEvidencePack,
      blindReviewQueue: alternate.queue,
    })).toThrow(/Judge|queue|hash chain|다릅니다/i);
  }, 15_000);

  it("동일 객체 replay와 동시 race에서는 최초 persistence 한 건만 허용한다", async () => {
    const replayAuthority = await task10Authority();
    const replayDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "judge-pack-replay-"),
    ));
    await persistJudgeEvidencePack({
      outputDirectory: replayDirectory,
      pack: replayAuthority.judgeEvidencePack,
    });
    await expect(persistJudgeEvidencePack({
      outputDirectory: replayDirectory,
      pack: replayAuthority.judgeEvidencePack,
    })).rejects.toThrow(/replay|이미|already/i);

    const raceAuthority = await task10Authority();
    const raceDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "recorded-pack-race-"),
    ));
    const race = await Promise.allSettled(Array.from({ length: 6 }, () => (
      persistRecordedBenchmarkPack({
        outputDirectory: raceDirectory,
        pack: raceAuthority.recordedPack,
      })
    )));
    expect(race.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((item) => item.status === "rejected")).toHaveLength(5);
  }, 15_000);

  it("leaf·execution directory·ancestor symlink를 따라 외부에 쓰지 않는다", async () => {
    const leafAuthority = await task10Authority();
    const leafRoot = await realpath(await mkdtemp(
      join(tmpdir(), "judge-pack-leaf-link-"),
    ));
    const leafPaths = createJudgeEvidencePackPaths({
      outputDirectory: leafRoot,
      executionPackHash: leafAuthority.judgeEvidencePack.execution_pack_hash,
      payloadSha256: sha256CanonicalJson(leafAuthority.judgeEvidencePack),
    });
    await mkdir(leafPaths.executionDirectory, { mode: 0o700 });
    const outsideLeaf = join(leafRoot, "outside-leaf.json");
    await writeFile(outsideLeaf, "sentinel\n", { mode: 0o600 });
    await symlink(outsideLeaf, leafPaths.claimPath);
    await expect(persistJudgeEvidencePack({
      outputDirectory: leafRoot,
      pack: leafAuthority.judgeEvidencePack,
    })).rejects.toThrow(/symlink|replay|이미|write-once|저장/i);
    expect(await readFile(outsideLeaf, "utf8")).toBe("sentinel\n");

    const directoryAuthority = await task10Authority();
    const directoryRoot = await realpath(await mkdtemp(
      join(tmpdir(), "recorded-pack-dir-link-"),
    ));
    const outsideDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "recorded-pack-outside-"),
    ));
    const directoryPaths = createRecordedBenchmarkPackPaths({
      outputDirectory: directoryRoot,
      executionPackHash: directoryAuthority.recordedPack.execution_pack_hash,
      payloadSha256: sha256CanonicalJson(directoryAuthority.recordedPack),
    });
    await symlink(outsideDirectory, directoryPaths.executionDirectory);
    await expect(persistRecordedBenchmarkPack({
      outputDirectory: directoryRoot,
      pack: directoryAuthority.recordedPack,
    })).rejects.toThrow(/symlink|디렉터리|directory|저장/i);
    expect(await readdir(outsideDirectory)).toEqual([]);

    const ancestorAuthority = await task10Authority();
    const realAncestor = await realpath(await mkdtemp(
      join(tmpdir(), "recorded-pack-real-ancestor-"),
    ));
    const aliasParent = await realpath(await mkdtemp(
      join(tmpdir(), "recorded-pack-alias-parent-"),
    ));
    const aliasRoot = join(aliasParent, "alias-root");
    await symlink(realAncestor, aliasRoot);
    await expect(persistRecordedBenchmarkPack({
      outputDirectory: aliasRoot,
      pack: ancestorAuthority.recordedPack,
    })).rejects.toThrow(/ancestor|symlink|root|저장/i);
    expect(await readdir(realAncestor)).toEqual([]);
  }, 15_000);

  it("record tamper와 0600 이외 mode를 load에서 거부한다", async () => {
    const tamperAuthority = await task10Authority();
    const tamperDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "judge-pack-tamper-"),
    ));
    const tamperPersisted = await persistJudgeEvidencePack({
      outputDirectory: tamperDirectory,
      pack: tamperAuthority.judgeEvidencePack,
    });
    await writeFile(tamperPersisted.path, "{}\n", { mode: 0o600 });
    await expect(loadJudgeEvidencePack({
      path: tamperPersisted.path,
      authority: {
        benchmarkPack: tamperAuthority.benchmarkPack,
        reviewQueueInput: tamperAuthority.input,
        blindReviewQueue: tamperAuthority.queue,
      },
    })).rejects.toThrow(/canonical|hash|wrapper|bytes|무결성/i);

    const modeAuthority = await task10Authority();
    const modeDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "recorded-pack-mode-"),
    ));
    const modePersisted = await persistRecordedBenchmarkPack({
      outputDirectory: modeDirectory,
      pack: modeAuthority.recordedPack,
    });
    await chmod(modePersisted.path, 0o644);
    await expect(loadRecordedBenchmarkPack({
      path: modePersisted.path,
      authority: {
        benchmarkPack: modeAuthority.benchmarkPack,
        judgeEvidencePack: modeAuthority.judgeEvidencePack,
        blindReviewQueue: modeAuthority.queue,
      },
    })).rejects.toThrow(/0600|mode|regular/i);
  }, 15_000);

  it("persisted 72-slot chain을 execution identity·schedule·plan으로 다시 권위 검증한다", async () => {
    const authority = await task10Authority();
    const outputDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "benchmark-evidence-reload-"),
    ));
    for (const completed of authority.input.execution_evidence.completed_slots) {
      await persistBenchmarkSlotArtifact({
        outputDirectory,
        artifact: completed.intent,
      });
      await persistBenchmarkSlotArtifact({
        outputDirectory,
        artifact: completed.receipt,
      });
      await persistBenchmarkSlotArtifact({
        outputDirectory,
        artifact: completed.checkpoint,
      });
    }
    const plans = authority.input.execution_evidence.completed_slots.map(
      (completed) => ({ slot_identity: completed.slot_identity }),
    );
    const loaded = await loadPersistedBenchmarkExecutionEvidence({
      outputDirectory,
      benchmarkPack: authority.benchmarkPack,
      executionIdentity: authority.input.execution_evidence.execution_identity,
      schedule,
      plans,
    });
    expect(canonicalJsonStringify(loaded.completed_slots)).toBe(
      canonicalJsonStringify(
        authority.input.execution_evidence.completed_slots,
      ),
    );
    expect(loaded.execution_identity).toBe(
      authority.input.execution_evidence.execution_identity,
    );

    const target = authority.input.execution_evidence.completed_slots[0];
    const paths = createBenchmarkSlotArtifactPaths({
      outputDirectory,
      executionHash: target.intent.execution_hash,
      slot: target.intent,
    });
    await unlink(paths.checkpointPath);
    await expect(loadPersistedBenchmarkExecutionEvidence({
      outputDirectory,
      benchmarkPack: authority.benchmarkPack,
      executionIdentity:
        authority.input.execution_evidence.execution_identity,
      schedule,
      plans,
    })).rejects.toThrow(/checkpoint|72|complete|누락|완료/i);
  }, 15_000);

  it("persisted 72-chain에서 안전한 Judge 실패를 재호출하지 않고 사람 fallback으로 둔 채 나머지 사례를 계속한다", async () => {
    const authority = await task10Authority();
    const outputDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "recorded-promotion-"),
    ));
    for (const completed of authority.input.execution_evidence.completed_slots) {
      await persistBenchmarkSlotArtifact({
        outputDirectory,
        artifact: completed.intent,
      });
      await persistBenchmarkSlotArtifact({
        outputDirectory,
        artifact: completed.receipt,
      });
      await persistBenchmarkSlotArtifact({
        outputDirectory,
        artifact: completed.checkpoint,
      });
    }
    const plans = authority.input.execution_evidence.completed_slots.map(
      (completed) => ({ slot_identity: completed.slot_identity }),
    );
    const precommitAuthority =
      await createTestAuthoritativeBlindingPrecommitAuthority({
        rootDirectory: await realpath(await mkdtemp(
          join(tmpdir(), "promotion-precommit-"),
        )),
      });
    const precommitStore = await createTestAuthoritativeBlindingPrecommitStore({
      authority: precommitAuthority,
      storeName: "promotion",
    });
    const privateContext =
      await loadOrCreateAuthoritativePrivateBlindingContextForTest({
        rootDirectory: await realpath(await mkdtemp(
          join(tmpdir(), "promotion-private-seed-"),
        )),
        executionPackHash: sha256CanonicalJson(authority.benchmarkPack),
        generateSeed: () => MASTER_BLINDING_SEED,
      });
    let calls = 0;
    const judgeAdapter: JudgeAdapter = {
      invoke: async (input) => {
        calls += 1;
        return {
          responseId: `promotion-${input.case_id}`,
          responseStatusCode: 200,
          status: "completed",
          modelReportedId: "gpt-5.6-sol",
          serviceTierReported: "default",
          outputText: input.case_id === "H-001"
            ? "{}"
            : JSON.stringify(resultFor(input.case_id, input, {})),
          usage: {
            inputTokens: 100,
            cachedInputTokens: 10,
            cacheWriteTokens: 0,
            outputTokens: 20,
          },
          error: null,
        };
      },
    };
    const promoted = await promoteRecordedBenchmarkWithAdapter({
      outputDirectory,
      benchmarkPack: authority.benchmarkPack,
      executionIdentity:
        authority.input.execution_evidence.execution_identity,
      schedule,
      plans,
      judgeAdapter,
      privateBlindingContext: privateContext,
      persistPrecommit: (manifest) => (
        persistAuthoritativeBlindingPrecommitForTest({
          store: precommitStore,
          manifest,
        })
      ),
    });

    expect(calls).toBe(13);
    expect(promoted.auxiliaryJudgeCount).toBe(12);
    expect(promoted.completeJudgeCount).toBe(11);
    expect(promoted.humanFallbackJudgeCount).toBe(1);
    expect(promoted.pack).toMatchObject({
      artifact_kind: "RECORDED_BENCHMARK_PACK",
      source: "RECORDED_BENCHMARK",
      execution_status: "EXECUTION_COMPLETE",
      judge_status: "JUDGE_PARTIAL_HUMAN_FALLBACK",
      review_status: "REVIEW_PENDING",
      evaluation_status: "EVALUATION_INCOMPLETE",
      baseline_version: null,
      coverage: {
        complete_judge_cases: 11,
        human_fallback_judge_cases: 1,
      },
    });
    expect(promoted.pack.blind_review_queue.items.filter(
      (item) => item.queue_reason === "JUDGE_INCOMPLETE_FALLBACK",
    )).toHaveLength(3);
    assertValidatedRecordedBenchmarkPack(promoted.pack);

    const resumed = await promoteRecordedBenchmarkWithAdapter({
      outputDirectory,
      benchmarkPack: authority.benchmarkPack,
      executionIdentity:
        authority.input.execution_evidence.execution_identity,
      schedule,
      plans,
      judgeAdapter,
      privateBlindingContext: privateContext,
      persistPrecommit: (manifest) => (
        persistAuthoritativeBlindingPrecommitForTest({
          store: precommitStore,
          manifest,
        })
      ),
    });
    expect(calls).toBe(13);
    expect(sha256CanonicalJson(resumed.pack)).toBe(
      sha256CanonicalJson(promoted.pack),
    );
  }, 20_000);

  it("private master seed를 execution hash별 0600 authority record로 create·resume·race한다", async () => {
    const authority = await task10Authority();
    const executionPackHash = sha256CanonicalJson(authority.benchmarkPack);
    const rootDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "private-seed-authority-"),
    ));
    const first = await loadOrCreateAuthoritativePrivateBlindingContextForTest({
      rootDirectory,
      executionPackHash,
      generateSeed: () => MASTER_BLINDING_SEED,
    });
    const resumed = await loadOrCreateAuthoritativePrivateBlindingContextForTest({
      rootDirectory,
      executionPackHash,
      generateSeed: () => REBLINDING_ATTACK_MASTER_SEED,
    });
    assertAuthoritativePrivateBlindingContext({
      context: first,
      expectedExecutionPackHash: executionPackHash,
    });
    expect(resumed.master_blinding_seed).toBe(first.master_blinding_seed);
    expect(resumed.seed_commitment).toBe(first.seed_commitment);
    const paths = createPrivateBlindingSeedPaths({
      rootDirectory,
      executionPackHash,
    });
    expect((await lstat(paths.recordPath)).mode & 0o777).toBe(0o600);

    const raceRoot = await realpath(await mkdtemp(
      join(tmpdir(), "private-seed-race-"),
    ));
    const raced = await Promise.all(Array.from({ length: 8 }, (_, index) => (
      loadOrCreateAuthoritativePrivateBlindingContextForTest({
        rootDirectory: raceRoot,
        executionPackHash,
        generateSeed: () => `${MASTER_BLINDING_SEED}-${index}`,
      })
    )));
    expect(new Set(raced.map((item) => item.seed_commitment))).toHaveLength(1);
    expect(new Set(raced.map((item) => item.master_blinding_seed))).toHaveLength(1);
  });

  it("cold private seed loader는 없는 authority를 생성하지 않고 fail-closed 한다", async () => {
    const authority = await task10Authority();
    const executionPackHash = sha256CanonicalJson(authority.benchmarkPack);
    const rootDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "private-seed-cold-load-"),
    ));
    const paths = createPrivateBlindingSeedPaths({
      rootDirectory,
      executionPackHash,
    });

    await expect(loadAuthoritativePrivateBlindingContextForTest({
      rootDirectory,
      executionPackHash,
    })).rejects.toThrow(/directory|디렉터리|record|authority|ENOENT/i);
    await expect(lstat(paths.executionDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await loadOrCreateAuthoritativePrivateBlindingContextForTest({
      rootDirectory,
      executionPackHash,
      generateSeed: () => MASTER_BLINDING_SEED,
    });
    await expect(loadAuthoritativePrivateBlindingContextForTest({
      rootDirectory,
      executionPackHash,
    })).resolves.toMatchObject({
      execution_pack_hash: executionPackHash,
    });
  });

  it("private seed authority의 tamper·mode·leaf/directory symlink를 거부한다", async () => {
    const authority = await task10Authority();
    const executionPackHash = sha256CanonicalJson(authority.benchmarkPack);
    const tamperRoot = await realpath(await mkdtemp(
      join(tmpdir(), "private-seed-tamper-"),
    ));
    await loadOrCreateAuthoritativePrivateBlindingContextForTest({
      rootDirectory: tamperRoot,
      executionPackHash,
      generateSeed: () => MASTER_BLINDING_SEED,
    });
    const tamperPaths = createPrivateBlindingSeedPaths({
      rootDirectory: tamperRoot,
      executionPackHash,
    });
    await writeFile(tamperPaths.recordPath, "{}\n", { mode: 0o600 });
    await expect(loadOrCreateAuthoritativePrivateBlindingContextForTest({
      rootDirectory: tamperRoot,
      executionPackHash,
      generateSeed: () => REBLINDING_ATTACK_MASTER_SEED,
    })).rejects.toThrow(/canonical|hash|bytes|무결성|record/i);

    const modeRoot = await realpath(await mkdtemp(
      join(tmpdir(), "private-seed-mode-"),
    ));
    await loadOrCreateAuthoritativePrivateBlindingContextForTest({
      rootDirectory: modeRoot,
      executionPackHash,
      generateSeed: () => MASTER_BLINDING_SEED,
    });
    const modePaths = createPrivateBlindingSeedPaths({
      rootDirectory: modeRoot,
      executionPackHash,
    });
    await chmod(modePaths.recordPath, 0o644);
    await expect(loadOrCreateAuthoritativePrivateBlindingContextForTest({
      rootDirectory: modeRoot,
      executionPackHash,
      generateSeed: () => REBLINDING_ATTACK_MASTER_SEED,
    })).rejects.toThrow(/0600|mode|regular/i);

    const hardLinkRoot = await realpath(await mkdtemp(
      join(tmpdir(), "private-seed-hardlink-"),
    ));
    await loadOrCreateAuthoritativePrivateBlindingContextForTest({
      rootDirectory: hardLinkRoot,
      executionPackHash,
      generateSeed: () => MASTER_BLINDING_SEED,
    });
    const hardLinkPaths = createPrivateBlindingSeedPaths({
      rootDirectory: hardLinkRoot,
      executionPackHash,
    });
    await link(
      hardLinkPaths.recordPath,
      join(hardLinkRoot, "leaked-seed-hardlink.json"),
    );
    await expect(loadOrCreateAuthoritativePrivateBlindingContextForTest({
      rootDirectory: hardLinkRoot,
      executionPackHash,
      generateSeed: () => REBLINDING_ATTACK_MASTER_SEED,
    })).rejects.toThrow(/link count|link|무결성/i);

    const rootMode = await realpath(await mkdtemp(
      join(tmpdir(), "private-seed-root-mode-"),
    ));
    await chmod(rootMode, 0o755);
    await expect(loadOrCreateAuthoritativePrivateBlindingContextForTest({
      rootDirectory: rootMode,
      executionPackHash,
      generateSeed: () => MASTER_BLINDING_SEED,
    })).rejects.toThrow(/0700|권한|mode/i);

    const leafRoot = await realpath(await mkdtemp(
      join(tmpdir(), "private-seed-leaf-link-"),
    ));
    const leafPaths = createPrivateBlindingSeedPaths({
      rootDirectory: leafRoot,
      executionPackHash,
    });
    await mkdir(leafPaths.executionDirectory, { mode: 0o700 });
    const outsideLeaf = join(leafRoot, "outside-seed.txt");
    await writeFile(outsideLeaf, "sentinel\n", { mode: 0o600 });
    await symlink(outsideLeaf, leafPaths.recordPath);
    await expect(loadOrCreateAuthoritativePrivateBlindingContextForTest({
      rootDirectory: leafRoot,
      executionPackHash,
      generateSeed: () => MASTER_BLINDING_SEED,
    })).rejects.toThrow(/symlink|record|regular|0600|무결성/i);
    expect(await readFile(outsideLeaf, "utf8")).toBe("sentinel\n");

    const directoryRoot = await realpath(await mkdtemp(
      join(tmpdir(), "private-seed-dir-link-"),
    ));
    const outsideDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "private-seed-outside-"),
    ));
    const directoryPaths = createPrivateBlindingSeedPaths({
      rootDirectory: directoryRoot,
      executionPackHash,
    });
    await symlink(outsideDirectory, directoryPaths.executionDirectory);
    await expect(loadOrCreateAuthoritativePrivateBlindingContextForTest({
      rootDirectory: directoryRoot,
      executionPackHash,
      generateSeed: () => MASTER_BLINDING_SEED,
    })).rejects.toThrow(/symlink|directory|디렉터리|무결성/i);
    expect(await readdir(outsideDirectory)).toEqual([]);
  });

  it("terminal incomplete Judge receipt의 attempt usage·cost를 보존하고 재과금하지 않는다", async () => {
    const input = await reviewInput();
    const judgeInput = input.judge_cases[0].expected_blind_input;
    const outputDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "judge-ledger-terminal-"),
    ));
    let invalidCalls = 0;
    const invalidAdapter: JudgeAdapter = {
      invoke: async () => {
        invalidCalls += 1;
        return {
          responseId: `invalid-${invalidCalls}`,
          responseStatusCode: 200,
          status: "completed",
          modelReportedId: "gpt-5.6-sol",
          serviceTierReported: "default",
          outputText: "{}",
          usage: {
            inputTokens: 100,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 5,
          },
          error: null,
        };
      },
    };
    const terminal = await runOrResumeBlindJudgeCase({
      outputDirectory,
      input: judgeInput,
      authoritativePrecommit: input.authoritative_blinding_precommit,
      adapter: invalidAdapter,
    });
    expect(invalidCalls).toBe(2);
    expect(terminal.judgeRunReceipt.judgeStatus).toBe("JUDGE_INCOMPLETE");
    expect(terminal.judgeRunReceipt.attempts).toHaveLength(2);
    expect(terminal.judgeRunReceipt.usageCost?.totalCostUsd).toBeGreaterThan(0);
    expect(terminal.checkpoint.terminal_request_dispositions).toEqual([
      "RESPONSE_RECEIVED",
      "RESPONSE_RECEIVED",
    ]);

    let replacementCalls = 0;
    const replacementAdapter: JudgeAdapter = {
      invoke: async () => {
        replacementCalls += 1;
        throw new Error("terminal Judge ledger must prevent replacement call");
      },
    };
    const resumed = await runOrResumeBlindJudgeCase({
      outputDirectory,
      input: judgeInput,
      authoritativePrecommit: input.authoritative_blinding_precommit,
      adapter: replacementAdapter,
    });
    expect(replacementCalls).toBe(0);
    expect(resumed.source).toBe("REUSED_CHECKPOINT");
    expect(sha256CanonicalJson(resumed.judgeRunReceipt)).toBe(
      sha256CanonicalJson(terminal.judgeRunReceipt),
    );
  });

  it("Judge 요청 계약 revision은 같은 72회 실행팩에서도 별도 append-only ledger 경로를 사용한다", async () => {
    const executionPackHash = "d".repeat(64);
    const current = createBlindJudgeCaseArtifactPaths({
      outputDirectory: "/private/runtime/judge-ledger",
      executionPackHash,
      caseId: "H-001",
      requestContractHash: "1".repeat(64),
    });
    const revised = createBlindJudgeCaseArtifactPaths({
      outputDirectory: "/private/runtime/judge-ledger",
      executionPackHash,
      caseId: "H-001",
      requestContractHash: "2".repeat(64),
    });

    expect(current.executionDirectory).not.toBe(revised.executionDirectory);
    expect(current.intentPath).not.toBe(revised.intentPath);
    expect(current.executionDirectory).toContain(executionPackHash);
  });

  it("intent-only crash는 안전 재개하고 dispatch-only crash는 ambiguous, receipt-only crash는 checkpoint만 재계산한다", async () => {
    const ambiguousInput = await reviewInput();
    const ambiguousJudgeInput =
      ambiguousInput.judge_cases[0].expected_blind_input;
    const ambiguousDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "judge-ledger-intent-only-"),
    ));
    await claimBlindJudgeCaseIntent({
      outputDirectory: ambiguousDirectory,
      input: ambiguousJudgeInput,
      authoritativePrecommit:
        ambiguousInput.authoritative_blinding_precommit,
    });
    let intentRecoveryCalls = 0;
    const intentRecovered = await runOrResumeBlindJudgeCase({
      outputDirectory: ambiguousDirectory,
      input: ambiguousJudgeInput,
      authoritativePrecommit:
        ambiguousInput.authoritative_blinding_precommit,
      adapter: {
        invoke: async (blindInput) => {
          intentRecoveryCalls += 1;
          return {
            responseId: "judge-ledger-intent-recovered",
            responseStatusCode: 200,
            status: "completed",
            modelReportedId: "gpt-5.6-sol",
            serviceTierReported: "default",
            outputText: JSON.stringify(resultFor(
              blindInput.case_id,
              blindInput,
              {},
            )),
            usage: {
              inputTokens: 100,
              cachedInputTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 20,
            },
            error: null,
          };
        },
      },
    });
    expect(intentRecoveryCalls).toBe(1);
    expect(intentRecovered.judgeRunReceipt.judgeStatus).toBe("JUDGE_COMPLETE");

    const dispatchInput = await reviewInput();
    const dispatchJudgeInput =
      dispatchInput.judge_cases[0].expected_blind_input;
    const dispatchDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "judge-ledger-dispatch-only-"),
    ));
    const dispatchClaim = await claimBlindJudgeCaseIntent({
      outputDirectory: dispatchDirectory,
      input: dispatchJudgeInput,
      authoritativePrecommit:
        dispatchInput.authoritative_blinding_precommit,
    });
    expect(await claimBlindJudgeCaseDispatch(dispatchClaim)).toBe(true);
    let ambiguousCalls = 0;
    await expect(runOrResumeBlindJudgeCase({
      outputDirectory: dispatchDirectory,
      input: dispatchJudgeInput,
      authoritativePrecommit:
        dispatchInput.authoritative_blinding_precommit,
      adapter: {
        invoke: async () => {
          ambiguousCalls += 1;
          throw new Error("dispatch-only intent must not call");
        },
      },
    })).rejects.toBeInstanceOf(JudgeCaseAmbiguousInFlightError);
    expect(ambiguousCalls).toBe(0);

    const completeInput = await reviewInput();
    const completeJudgeInput = completeInput.judge_cases[0].expected_blind_input;
    const completeDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "judge-ledger-checkpoint-"),
    ));
    let completeCalls = 0;
    const completeAdapter: JudgeAdapter = {
      invoke: async (blindInput) => {
        completeCalls += 1;
        return {
          responseId: "judge-ledger-complete",
          responseStatusCode: 200,
          status: "completed",
          modelReportedId: "gpt-5.6-sol",
          serviceTierReported: "default",
          outputText: JSON.stringify(resultFor(
            blindInput.case_id,
            blindInput,
            {},
          )),
          usage: {
            inputTokens: 100,
            cachedInputTokens: 10,
            cacheWriteTokens: 0,
            outputTokens: 20,
          },
          error: null,
        };
      },
    };
    const first = await runOrResumeBlindJudgeCase({
      outputDirectory: completeDirectory,
      input: completeJudgeInput,
      authoritativePrecommit:
        completeInput.authoritative_blinding_precommit,
      adapter: completeAdapter,
    });
    const paths = createBlindJudgeCaseArtifactPaths({
      outputDirectory: completeDirectory,
      executionPackHash:
        completeInput.authoritative_blinding_precommit.execution_pack_hash,
      caseId: completeJudgeInput.case_id,
    });
    await unlink(paths.checkpointPath);
    const resumed = await runOrResumeBlindJudgeCase({
      outputDirectory: completeDirectory,
      input: completeJudgeInput,
      authoritativePrecommit:
        completeInput.authoritative_blinding_precommit,
      adapter: completeAdapter,
    });
    expect(completeCalls).toBe(1);
    expect(resumed.source).toBe("RECOMPUTED_CHECKPOINT");
    expect(resumed.checkpoint.receipt_payload_sha256).toBe(
      first.checkpoint.receipt_payload_sha256,
    );
    await writeFile(paths.checkpointPath, "{}\n", { mode: 0o600 });
    await expect(runOrResumeBlindJudgeCase({
      outputDirectory: completeDirectory,
      input: completeJudgeInput,
      authoritativePrecommit:
        completeInput.authoritative_blinding_precommit,
      adapter: completeAdapter,
    })).rejects.toThrow(/checkpoint|canonical|hash|bytes|무결성/i);
    expect(completeCalls).toBe(1);
  });

  it("Judge case ledger race는 최대 한 번만 호출하고 corruption·mode·symlink를 거부한다", async () => {
    const raceInput = await reviewInput();
    const judgeInput = raceInput.judge_cases[0].expected_blind_input;
    const raceDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "judge-ledger-race-"),
    ));
    let calls = 0;
    const adapter: JudgeAdapter = {
      invoke: async (blindInput) => {
        calls += 1;
        return {
          responseId: "judge-ledger-race",
          responseStatusCode: 200,
          status: "completed",
          modelReportedId: "gpt-5.6-sol",
          serviceTierReported: "default",
          outputText: JSON.stringify(resultFor(
            blindInput.case_id,
            blindInput,
            {},
          )),
          usage: {
            inputTokens: 100,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 20,
          },
          error: null,
        };
      },
    };
    const race = await Promise.allSettled(Array.from({ length: 6 }, () => (
      runOrResumeBlindJudgeCase({
        outputDirectory: raceDirectory,
        input: judgeInput,
        authoritativePrecommit:
          raceInput.authoritative_blinding_precommit,
        adapter,
      })
    )));
    expect(calls).toBe(1);
    expect(race.some((item) => item.status === "fulfilled")).toBe(true);
    expect(race.every((item) => (
      item.status === "fulfilled"
      || item.reason instanceof JudgeCaseAmbiguousInFlightError
    ))).toBe(true);

    const paths = createBlindJudgeCaseArtifactPaths({
      outputDirectory: raceDirectory,
      executionPackHash:
        raceInput.authoritative_blinding_precommit.execution_pack_hash,
      caseId: judgeInput.case_id,
    });
    await chmod(paths.receiptPath, 0o644);
    await expect(runOrResumeBlindJudgeCase({
      outputDirectory: raceDirectory,
      input: judgeInput,
      authoritativePrecommit:
        raceInput.authoritative_blinding_precommit,
      adapter,
    })).rejects.toThrow(/0600|mode|regular|receipt/i);

    const symlinkInput = await reviewInput();
    const symlinkDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "judge-ledger-symlink-"),
    ));
    const symlinkPaths = createBlindJudgeCaseArtifactPaths({
      outputDirectory: symlinkDirectory,
      executionPackHash:
        symlinkInput.authoritative_blinding_precommit.execution_pack_hash,
      caseId: symlinkInput.judge_cases[0].case_id,
    });
    await mkdir(symlinkPaths.ledgerDirectory, { mode: 0o700 });
    const outside = await realpath(await mkdtemp(
      join(tmpdir(), "judge-ledger-outside-"),
    ));
    await symlink(outside, symlinkPaths.executionDirectory);
    await expect(runOrResumeBlindJudgeCase({
      outputDirectory: symlinkDirectory,
      input: symlinkInput.judge_cases[0].expected_blind_input,
      authoritativePrecommit:
        symlinkInput.authoritative_blinding_precommit,
      adapter,
    })).rejects.toThrow(/symlink|0700|directory|디렉터리/i);
    expect(await readdir(outside)).toEqual([]);
  }, 20_000);
});

const neverCalledAdapter: CandidateAdapter = {
  invoke: async () => {
    throw new Error("review queue fixture must not call a candidate provider");
  },
};

type CandidateId = (typeof BENCHMARK_CANDIDATE_IDS)[number];
type DeterministicFailureKey = `${string}:${CandidateId}`;

function outputFor(index: number, replyOverrides: Readonly<Record<string, string>>): CandidateOutput {
  const slot = schedule[index];
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === slot.case_id)!;
  return {
    customer_reply: replyOverrides[slot.slot_id] ?? oracle.reference_replies[0],
    decision: {
      intent_codes: [...oracle.expected_intent_codes],
      action_code: oracle.expected_action_code,
      escalation_required: oracle.escalation_required,
      escalation_reason_code: oracle.escalation_reason_code,
      target_queue: oracle.target_queue,
    },
    citations: structuredClone(oracle.required_citations),
  };
}

function candidateFacingOrderData(
  order: NonNullable<(typeof BENCHMARK_ORDERS)[number]>,
) {
  return {
    order_id: order.order_id,
    status: order.status,
    fulfillment_locked: order.fulfillment_locked,
    placed_at: order.placed_at,
    shipped_at: order.shipped_at,
    delivered_at: order.delivered_at,
    promised_delivery_date: order.promised_delivery_date,
    total_amount: order.total_amount,
    currency: order.currency,
    carrier: order.carrier,
    tracking_number: order.tracking_number,
    refund_status: order.refund_status,
    refund_approved_at: order.refund_approved_at,
    items: order.items.map(({ synthetic: _synthetic, ...item }) => structuredClone(item)),
  };
}

function retrievalResult(sourceId: string, sectionId: string) {
  return {
    rank: 1,
    fileId: `file-${sourceId}`,
    filename: `${sourceId}.json`,
    score: 0.99,
    sourceId,
    sectionId,
    factId: `fact-${sourceId}-${sectionId}`,
    text: `${sourceId} section ${sectionId}`,
  };
}

function makeExecutionEvidence({
  index,
  accessEvidence,
  output,
  providerCall,
  omitRequiredTool,
}: {
  index: number;
  accessEvidence: ReturnType<typeof buildRunnerInputAccessEvidence>;
  output: CandidateOutput;
  providerCall: CompletedCandidateExecutionEvidence["providerCalls"][number];
  omitRequiredTool: boolean;
}): CompletedCandidateExecutionEvidence {
  const slot = schedule[index];
  const evaluationCase = BENCHMARK_CASES.find((item) => item.case_id === slot.case_id)!;
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === slot.case_id)!;
  const authoritativeOrder = evaluationCase.order_id === null
    ? null
    : BENCHMARK_ORDERS.find((item) => item.order_id === evaluationCase.order_id)!;
  const expectation = oracle.candidate_access_expectations.find(
    (item) => item.candidate_id === slot.candidate_id,
  )!;
  const retrievalCalls: CompletedCandidateExecutionEvidence["retrievalCalls"] = [];
  const toolCalls: CompletedCandidateExecutionEvidence["toolCalls"] = [];

  if (slot.candidate_id === "B" && expectation.required_runner_retrieval_calls === 1) {
    retrievalCalls.push({
      evidenceId: `retrieval-${slot.slot_id}-1`,
      origin: "RUNNER_PREFETCH",
      linkedToolCallId: null,
      corpusHash: accessEvidence.policyAccess.corpusHash,
      manifestHash: accessEvidence.policyAccess.manifestHash,
      asOf: evaluationCase.as_of,
      callNumber: 1,
      operation: "VECTOR_STORE_SEARCH",
      status: "COMPLETE",
      requestedQuery: `policy for ${slot.case_id}`,
      reportedQuery: null,
      vectorStoreIdHash: executionIdentity.policy_vector_store_id_hash,
      maxNumResults: 6,
      rewriteQuery: false,
      latencyMs: 2,
      results: oracle.required_citations.map((citation, resultIndex) => ({
        ...retrievalResult(citation.source_id, citation.section_id),
        rank: resultIndex + 1,
      })),
    });
  }

  if (slot.candidate_id === "C") {
    for (const [toolIndex, required] of expectation.required_tool_calls.entries()) {
      if (omitRequiredTool && toolIndex === expectation.required_tool_calls.length - 1) {
        continue;
      }
      const callId = `call-${required.tool_name}-${slot.slot_id}`;
      const result = required.tool_name === "search_policy"
        ? {
          ok: true,
          result_code: "OK",
          data: {
            results: oracle.required_citations.map((citation) => ({
              source_id: citation.source_id,
              section_id: citation.section_id,
            })),
          },
        }
        : required.expected_result_code === "OK"
          ? {
            ok: true,
            result_code: "OK",
            data: candidateFacingOrderData(authoritativeOrder!),
          }
          : {
            ok: false,
            result_code: required.expected_result_code,
            data: null,
          };
      const linkedRetrievalEvidenceIds: string[] = [];
      if (required.tool_name === "search_policy") {
        const evidenceId = `retrieval-${slot.slot_id}-${toolIndex + 1}`;
        linkedRetrievalEvidenceIds.push(evidenceId);
        retrievalCalls.push({
          evidenceId,
          origin: "TOOL_SEARCH",
          linkedToolCallId: callId,
          corpusHash: accessEvidence.policyAccess.corpusHash,
          manifestHash: accessEvidence.policyAccess.manifestHash,
          asOf: evaluationCase.as_of,
          callNumber: toolIndex + 1,
          operation: "VECTOR_STORE_SEARCH",
          status: "COMPLETE",
          requestedQuery: `policy for ${slot.case_id}`,
          reportedQuery: null,
          vectorStoreIdHash: executionIdentity.policy_vector_store_id_hash,
          maxNumResults: 6,
          rewriteQuery: false,
          latencyMs: 2,
          results: oracle.required_citations.map((citation, resultIndex) => ({
            ...retrievalResult(citation.source_id, citation.section_id),
            rank: resultIndex + 1,
          })),
        });
      }
      toolCalls.push({
        evidenceId: `tool-${slot.slot_id}-${toolIndex + 1}`,
        resultCode: required.expected_result_code,
        linkedRetrievalEvidenceIds,
        resultHash: sha256CanonicalJson(result),
        callNumber: toolIndex + 1,
        modelTurn: 1,
        callId,
        toolName: required.tool_name,
        status: required.expected_result_code === "TOOL_TIMEOUT"
          ? "TIMEOUT"
          : (
              required.expected_result_code === "OK"
              || required.expected_result_code === "ORDER_OWNERSHIP_MISMATCH"
              || required.expected_result_code === "ORDER_RESULT_MISMATCH"
              || required.expected_result_code === "ORDER_NOT_FOUND"
            )
            ? "COMPLETE"
            : "FAILED",
        arguments: {
          ...required.required_arguments,
          ...Object.fromEntries(
            required.required_nonempty_arguments.map((name) => [name, `query for ${slot.case_id}`]),
          ),
        },
        argumentsJson: null,
        providerStatus: "completed",
        result,
        latencyMs: 2,
      });
    }
  }

  return {
    slotId: slot.slot_id,
    repetition: slot.repetition,
    caseId: slot.case_id,
    candidateId: slot.candidate_id,
    finalStatus: "COMPLETE",
    finalOutputHash: sha256CanonicalJson(output),
    providerCalls: [providerCall],
    retrievalCalls,
    toolCalls,
  };
}

function makeSlotContext(index: number) {
  const slot = schedule[index];
  const evaluationCase = BENCHMARK_CASES.find((item) => item.case_id === slot.case_id)!;
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === slot.case_id)!;
  const authoritativeOrder = evaluationCase.order_id === null
    ? null
    : BENCHMARK_ORDERS.find((item) => item.order_id === evaluationCase.order_id)!;
  const expectation = oracle.candidate_access_expectations.find(
    (item) => item.candidate_id === slot.candidate_id,
  )!;
  const accessEvidence = buildRunnerInputAccessEvidence({
    candidateId: slot.candidate_id,
    slotId: slot.slot_id,
    repetition: slot.repetition,
    evaluationCase,
    policies: BENCHMARK_POLICIES,
    authoritativeOrder,
    orderAccessStatus: expectation.expected_order_access_status,
  });
  const definition = createBenchmarkCandidateDefinition({
    candidateId: slot.candidate_id,
    evaluationCase,
    authorizedOrder: expectation.expected_order_access_status === "SUCCESS"
      ? authoritativeOrder
      : null,
    policyCorpus: BENCHMARK_POLICIES,
    adapter: neverCalledAdapter,
    challenge: BENCHMARK_CHALLENGE,
  });
  const preparedPolicyResource = slot.candidate_id === "A"
    ? undefined
    : {
      policy_corpus_sha256: definition.config.policy_corpus_hash,
      chunking_config_sha256: definition.config.policy_chunking_config_hash!,
      resource_contract_sha256: definition.config.policy_resource_contract_hash!,
      manifest_sha256: executionIdentity.policy_manifest_hash,
      resource_identity_sha256: executionIdentity.policy_resource_identity_hash,
      vector_store_id_hash: executionIdentity.policy_vector_store_id_hash,
    };
  const slotIdentity = buildBenchmarkSlotIdentity({
    executionIdentity,
    slot,
    evaluationCase,
    oracle,
    authoritativeOrder,
    candidateDefinition: definition,
    accessEvidence,
    ...(preparedPolicyResource ? { preparedPolicyResource } : {}),
  });
  return { slotIdentity, accessEvidence };
}

function makeCompletedSlot(
  index: number,
  failures: ReadonlySet<DeterministicFailureKey>,
  missingRequiredTools: ReadonlySet<DeterministicFailureKey>,
  replyOverrides: Readonly<Record<string, string>>,
) {
  const slot = schedule[index];
  const { slotIdentity, accessEvidence } = makeSlotContext(index);
  const identityHashes = benchmarkSlotIdentityHashes(executionIdentity, slotIdentity);
  const output = outputFor(index, replyOverrides);
  if (failures.has(`${slot.case_id}:${slot.candidate_id}`)) {
    output.decision.action_code = output.decision.action_code === "NO_ACTION"
      ? "CANCEL_CONFIRMED"
      : "NO_ACTION";
  }
  const usage: TokenUsage = {
    inputTokens: 100 + index,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 20,
  };
  const usageCost = calculateUsageCost(usage, DEFAULT_PRICING_SNAPSHOT)!;
  const intent = {
    artifact_kind: "BENCHMARK_SLOT_EXECUTION_INTENT",
    execution_hash: executionIdentity.execution_hash,
    schedule_id: schedule.schedule_id,
    slot_identity_hash: slotIdentity.slot_identity_hash,
    slot_id: slot.slot_id,
    sequence: slot.sequence,
    repetition: slot.repetition,
    identity_hashes: identityHashes,
    execution: {
      schema_version: "benchmark-slot-intent-v1",
      candidate_id: slot.candidate_id,
      run_number: slot.repetition,
      invocation_hash: slotIdentity.invocation_hash,
    },
  } satisfies BenchmarkSlotExecutionIntent;
  const latencyMs = index + 1;
  const providerCall = {
    callNumber: 1,
    responseId: `resp-${slot.slot_id}`,
    status: "completed" as const,
    modelRequestedId: "gpt-5.6-terra",
    modelReportedId: "gpt-5.6-terra-2026-07-17",
    serviceTierRequested: "default",
    serviceTierReported: "default",
    latencyMs,
    usage,
  };
  const executionEvidence = makeExecutionEvidence({
    index,
    accessEvidence,
    output,
    providerCall,
    omitRequiredTool: missingRequiredTools.has(`${slot.case_id}:${slot.candidate_id}`),
  });
  const attemptExecutionEvidence = {
    providerCalls: executionEvidence.providerCalls,
    retrievalCalls: executionEvidence.retrievalCalls.map(({
      evidenceId: _evidenceId,
      origin: _origin,
      linkedToolCallId: _linkedToolCallId,
      corpusHash: _corpusHash,
      manifestHash: _manifestHash,
      asOf: _asOf,
      ...call
    }) => call),
    toolCalls: executionEvidence.toolCalls.map(({
      evidenceId: _evidenceId,
      resultCode: _resultCode,
      linkedRetrievalEvidenceIds: _linkedRetrievalEvidenceIds,
      resultHash: _resultHash,
      ...call
    }) => call),
  };
  const run = {
    runNumber: slot.repetition,
    status: "COMPLETE" as const,
    attempts: [{
      attemptNumber: 1,
      status: "COMPLETE" as const,
      startedAt: "2026-07-17T00:00:00.000Z",
      latencyMs,
      responseId: providerCall.responseId,
      modelReportedId: providerCall.modelReportedId,
      serviceTierReported: providerCall.serviceTierReported,
      usage,
      executionEvidence: attemptExecutionEvidence,
    }],
    output,
    totalLatencyMs: latencyMs,
  };
  const receipt = {
    artifact_kind: "BENCHMARK_SLOT_EXECUTION_RECEIPT",
    execution_hash: executionIdentity.execution_hash,
    schedule_id: schedule.schedule_id,
    slot_identity_hash: slotIdentity.slot_identity_hash,
    slot_id: slot.slot_id,
    sequence: slot.sequence,
    repetition: slot.repetition,
    identity_hashes: identityHashes,
    intent_payload_sha256: sha256CanonicalJson(intent),
    execution: {
      schema_version: "benchmark-slot-receipt-v1",
      slot_result: {
        slot: structuredClone(slot),
        executionStatus: "COMPLETE",
        requestDisposition: "SENT_RESPONSE_RECORDED",
        costState: "COMPLETE",
        usageCost,
        totalLatencyMs: latencyMs,
        run,
        accessEvidence,
        completedExecutionEvidence: executionEvidence,
      },
    },
  } satisfies BenchmarkSlotExecutionReceipt;
  const checkpoint = {
    artifact_kind: "BENCHMARK_SLOT_EXECUTION_CHECKPOINT",
    execution_hash: executionIdentity.execution_hash,
    schedule_id: schedule.schedule_id,
    slot_identity_hash: slotIdentity.slot_identity_hash,
    slot_id: slot.slot_id,
    sequence: slot.sequence,
    repetition: slot.repetition,
    identity_hashes: identityHashes,
    intent_payload_sha256: sha256CanonicalJson(intent),
    receipt_payload_sha256: sha256CanonicalJson(receipt),
    execution: {
      schema_version: "benchmark-slot-checkpoint-v1",
      evaluation_state: {
        status: "EVALUATED",
        gates: evaluateHardGates({
          candidateId: slot.candidate_id,
          slotId: slot.slot_id,
          repetition: slot.repetition,
          evaluationCase: BENCHMARK_CASES.find((item) => item.case_id === slot.case_id)!,
          oracle: BENCHMARK_ORACLES.find((item) => item.case_id === slot.case_id)!,
          policies: BENCHMARK_POLICIES,
          authoritativeOrder: BENCHMARK_ORDERS.find(
            (item) => item.order_id === BENCHMARK_CASES.find(
              (candidateCase) => candidateCase.case_id === slot.case_id,
            )!.order_id,
          ) ?? null,
          accessEvidence,
          output,
          executionEvidence,
        }).gates,
      },
    },
  } satisfies BenchmarkSlotExecutionCheckpoint;
  return { slot_identity: slotIdentity, intent, receipt, checkpoint };
}

function resultFor(
  caseId: string,
  input: ReturnType<typeof buildBlindJudgeInput>["judge_input"],
  risks: Partial<Record<BlindJudgeLabel, BlindJudgeSeverity>>,
): BlindJudgeResult {
  return {
    case_id: caseId,
    candidates: BLIND_JUDGE_LABELS.map((blindLabel) => ({
      blind_label: blindLabel,
      criteria: BLIND_JUDGE_LOCKED_CRITERIA.map((criterionId) => {
        const severity = risks[blindLabel];
        if (criterionId !== "FACTUAL_COMPLETENESS_RISK" || severity === undefined) {
          return {
            criterion_id: criterionId,
            status: "NO_RISK" as const,
            severity: null,
            failure_type: null,
            concerning_field: null,
            concerning_excerpt: "",
            evidence_ids: [],
            rationale: "No auxiliary risk was identified in the blinded evidence.",
          };
        }
        const candidate = input.blind_candidates.find(
          (item) => item.blind_label === blindLabel,
        )!;
        return {
          criterion_id: criterionId,
          status: "RISK" as const,
          severity,
          failure_type: "MISSING_REQUIRED_FACT" as const,
          concerning_field: "CUSTOMER_REPLY" as const,
          concerning_excerpt: candidate.runs[0].output!.customer_reply.slice(0, 24),
          evidence_ids: [`${blindLabel}:RUN:1`, "ORACLE:REQUIRED_REPLY_CLAIMS"],
          rationale: "The response may omit a required fact and needs human review.",
        };
      }),
    })),
  };
}

function monotonicNow() {
  let value = 0;
  return () => {
    value += 5;
    return value;
  };
}

async function completeJudgeRun(
  input: ReturnType<typeof buildBlindJudgeInput>["judge_input"],
  result: BlindJudgeResult,
  authoritativeBlindingPrecommit: AuthoritativeBlindingPrecommit,
) {
  const adapter: JudgeAdapter = {
    invoke: async () => ({
      responseId: `judge-${input.case_id}`,
      responseStatusCode: 200,
      status: "completed",
      modelReportedId: "gpt-5.6-sol",
      serviceTierReported: "default",
      outputText: JSON.stringify(result),
      usage: {
        inputTokens: 100,
        cachedInputTokens: 10,
        cacheWriteTokens: 0,
        outputTokens: 20,
      },
      error: null,
    }),
  };
  return runBlindJudge({
    adapter,
    input,
    authoritativeBlindingPrecommit,
    now: monotonicNow(),
  });
}

async function safeIncompleteJudgeRun(
  input: ReturnType<typeof buildBlindJudgeInput>["judge_input"],
  authoritativeBlindingPrecommit: AuthoritativeBlindingPrecommit,
): Promise<BlindJudgeRunRecord> {
  const complete = await completeJudgeRun(
    input,
    resultFor(input.case_id, input, {}),
    authoritativeBlindingPrecommit,
  );
  const base = complete.attempts[0];
  const attempts = ([1, 2] as const).map((attemptNumber) => ({
    ...structuredClone(base),
    attemptNumber,
    status: "INVALID_OUTPUT" as const,
    retryEligible: attemptNumber === 1,
    error: "Synthetic strict output validation failed.",
  }));
  return {
    ...structuredClone(complete),
    judgeStatus: "JUDGE_INCOMPLETE",
    result: null,
    attempts,
    totalLatencyMs: attempts.reduce((total, attempt) => total + attempt.latencyMs, 0),
    usageCost: calculateUsageCost(
      attempts.map((attempt) => attempt.usage),
      JUDGE_PRICING_SNAPSHOT,
    )!,
    costState: "COMPLETE",
  };
}

async function unsafeIncompleteJudgeRun(
  input: ReturnType<typeof buildBlindJudgeInput>["judge_input"],
  authoritativeBlindingPrecommit: AuthoritativeBlindingPrecommit,
  mode: "SENT_OUTCOME_UNKNOWN" | "COST_INCOMPLETE",
): Promise<BlindJudgeRunRecord> {
  const adapter: JudgeAdapter = {
    invoke: async () => {
      if (mode === "SENT_OUTCOME_UNKNOWN") {
        throw new JudgeInvocationError("Synthetic outcome is unknown.", {
          retryable: true,
          requestDisposition: "SENT_OUTCOME_UNKNOWN",
        });
      }
      return {
        responseId: `judge-${input.case_id}`,
        responseStatusCode: 200,
        status: "completed",
        modelReportedId: "gpt-5.6-sol",
        serviceTierReported: "default",
        outputText: JSON.stringify(resultFor(input.case_id, input, {})),
        usage: null,
        error: null,
      };
    },
  };
  return runBlindJudge({
    adapter,
    input,
    authoritativeBlindingPrecommit,
    now: monotonicNow(),
  });
}

interface ReviewInputOptions {
  risks?: Readonly<Record<string, Partial<Record<BlindJudgeLabel, BlindJudgeSeverity>>>>;
  deterministicFailures?: readonly DeterministicFailureKey[];
  missingRequiredTools?: readonly DeterministicFailureKey[];
  replyOverrides?: Readonly<Record<string, string>>;
  masterBlindingSeed?: string;
  precommitAuthority?: TestAuthoritativeBlindingPrecommitAuthority;
  precommitStoreName?: string;
  terminalSlotId?: string;
  fallbackCaseIds?: readonly string[];
}

async function reviewInput({
  risks = {},
  deterministicFailures = [],
  missingRequiredTools = [],
  replyOverrides = {},
  masterBlindingSeed = MASTER_BLINDING_SEED,
  precommitAuthority,
  precommitStoreName = "primary",
  terminalSlotId,
  fallbackCaseIds = [],
}: ReviewInputOptions = {}): Promise<BuildBlindReviewQueueInput> {
  const completedSlots = schedule.map((_, index) => makeCompletedSlot(
    index,
    new Set(deterministicFailures),
    new Set(missingRequiredTools),
    replyOverrides,
  ));
  if (terminalSlotId !== undefined) {
    const terminal = completedSlots.find(
      (item) => item.intent.slot_id === terminalSlotId,
    );
    if (!terminal) throw new Error(`terminal fixture slot이 없습니다: ${terminalSlotId}`);
    const result = terminal.receipt.execution.slot_result as Record<string, any>;
    result.executionStatus = "BUDGET_EXCEEDED";
    result.run.status = "BUDGET_EXCEEDED";
    result.run.attempts[result.run.attempts.length - 1].status = "BUDGET_EXCEEDED";
    delete result.run.output;
    result.completedExecutionEvidence = null;
    (terminal.checkpoint.execution as { evaluation_state: unknown }).evaluation_state = {
      status: "NOT_EVALUATED",
      reason: "BUDGET_EXCEEDED",
    };
    (terminal.checkpoint as { receipt_payload_sha256: string }).receipt_payload_sha256 =
      sha256CanonicalJson(terminal.receipt);
  }
  const executionPack = buildBenchmarkExecutionPack({
    executionIdentity,
    schedule,
    completedSlots,
  });
  const executionPackHash = sha256CanonicalJson(executionPack);
  const preparedJudgeCases = BENCHMARK_CASES.map((evaluationCase) => {
    const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === evaluationCase.case_id)!;
    const candidateSources = BENCHMARK_CANDIDATE_IDS.map((candidateId) => ({
      candidate_id: candidateId,
      runs: ([1, 2] as const).map((repetition) => {
        const slot = executionPack.slots.find((item) => (
          item.slot.case_id === evaluationCase.case_id
          && item.slot.candidate_id === candidateId
          && item.slot.repetition === repetition
        ))!;
        if (slot.run === null) throw new Error(`terminal run fixture가 없습니다: ${slot.slot.slot_id}`);
        return slot.execution_status === "COMPLETE"
          ? {
            repetition,
            execution_status: "COMPLETE" as const,
            output: slot.run.output as CandidateOutput,
          }
          : {
            repetition,
            execution_status: slot.execution_status as
              | "INVALID"
              | "TIMEOUT"
              | "BUDGET_EXCEEDED",
            output: null,
          };
      }),
    })) as [CandidateJudgeSource, CandidateJudgeSource, CandidateJudgeSource];
    const privateMapping = buildExecutionBoundPrivateBlindMapping({
      caseId: evaluationCase.case_id,
      executionPackHash,
      masterBlindingSeed,
    });
    const bundle = buildBlindJudgeInput({
      evaluationCase,
      oracle,
      candidateSources,
      blindingSeed: privateMapping.case_blinding_seed,
    });
    if (BLIND_JUDGE_LABELS.some((label) => (
      bundle.private_mapping.label_to_candidate[label]
      !== privateMapping.label_to_candidate[label]
    ))) {
      throw new Error(`execution-bound mapping fixture가 다릅니다: ${evaluationCase.case_id}`);
    }
    const judgeResult = resultFor(
      evaluationCase.case_id,
      bundle.judge_input,
      risks[evaluationCase.case_id] ?? {},
    );
    return {
      evaluationCase,
      judgeInput: bundle.judge_input,
      privateMapping,
      judgeResult,
    };
  });
  const blindingPrecommitManifest = buildJudgeEvidencePrecommitManifest({
    executionPackHash,
    masterBlindingSeed,
    judgeInputBindings: preparedJudgeCases.map((prepared) => ({
      case_id: prepared.evaluationCase.case_id,
      judge_input_hash: sha256CanonicalJson(prepared.judgeInput),
    })),
  });
  const authority = precommitAuthority
    ?? await createTestAuthoritativeBlindingPrecommitAuthority({
      rootDirectory: await realpath(await mkdtemp(
        join(tmpdir(), "review-queue-precommit-"),
      )),
    });
  const store = await createTestAuthoritativeBlindingPrecommitStore({
    authority,
    storeName: precommitStoreName,
  });
  const authoritativeBlindingPrecommit =
    await persistAuthoritativeBlindingPrecommitForTest({
      store,
      manifest: blindingPrecommitManifest,
    });
  // 권위 precommit이 저장된 뒤에만 Judge receipt fixture를 생성합니다.
  const judgeCases = await Promise.all(preparedJudgeCases.map(async (prepared) => ({
    schema_version: "review-queue-judge-case-v1" as const,
    case_id: prepared.evaluationCase.case_id,
    expected_blind_input: prepared.judgeInput,
    private_mapping: prepared.privateMapping,
    judge_run_receipt: fallbackCaseIds.includes(prepared.evaluationCase.case_id)
      ? await safeIncompleteJudgeRun(
        prepared.judgeInput,
        authoritativeBlindingPrecommit,
      )
      : await completeJudgeRun(
        prepared.judgeInput,
        prepared.judgeResult,
        authoritativeBlindingPrecommit,
      ),
  })));
  return {
    schema_version: "build-blind-review-queue-input-v1",
    execution_evidence: {
      schema_version: "review-queue-execution-evidence-v1",
      execution_identity: executionIdentity,
      completed_slots: completedSlots,
    },
    authoritative_blinding_precommit: authoritativeBlindingPrecommit,
    private_blinding_context: {
      schema_version: "private-blinding-context-v1",
      master_blinding_seed: masterBlindingSeed,
    },
    judge_cases: judgeCases,
  } as unknown as BuildBlindReviewQueueInput;
}

async function task10Authority(options: ReviewInputOptions = {}) {
  const input = await reviewInput(options);
  const benchmarkPack = buildBenchmarkExecutionPack({
    executionIdentity: input.execution_evidence.execution_identity,
    schedule,
    completedSlots: input.execution_evidence.completed_slots,
  });
  const queue = buildBlindReviewQueue(input);
  const judgeEvidencePack = buildJudgeEvidencePack({
    benchmarkPack,
    reviewQueueInput: input,
    blindReviewQueue: queue,
  });
  const recordedPack = buildRecordedBenchmarkPack({
    benchmarkPack,
    judgeEvidencePack,
    blindReviewQueue: queue,
  });
  return {
    input,
    benchmarkPack,
    queue,
    judgeEvidencePack,
    recordedPack,
  };
}

/** Process restart E2E용 canonical 72-slot/12-Judge source fixture입니다. */
export async function createPersistedRecordedBenchmarkColdFixture({
  outputDirectory,
  testAuthority,
}: {
  readonly outputDirectory: string;
  readonly testAuthority?: Readonly<{
    privateBlindingSeedRootDirectory: string;
    judgeEvidencePrecommitStore: AuthoritativeBlindingPrecommitStore;
  }>;
}) {
  const source = await task10Authority();
  for (const completed of source.input.execution_evidence.completed_slots) {
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: completed.intent });
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: completed.receipt });
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: completed.checkpoint });
  }
  const executionIdentity = source.input.execution_evidence.execution_identity;
  const executionIdentityAuthority =
    await persistBenchmarkExecutionIdentityAuthority({
      outputDirectory,
      executionIdentity,
    });
  const plans = source.input.execution_evidence.completed_slots.map((item) => ({
    slot_identity: item.slot_identity,
  }));
  const privateBlindingContext =
    testAuthority === undefined
      ? await loadOrCreateAuthoritativePrivateBlindingContext({
          executionPackHash: sha256CanonicalJson(source.benchmarkPack),
        })
      : await loadOrCreateAuthoritativePrivateBlindingContextForTest({
          rootDirectory:
            testAuthority.privateBlindingSeedRootDirectory,
          executionPackHash: sha256CanonicalJson(source.benchmarkPack),
          generateSeed: () => MASTER_BLINDING_SEED,
        });
  const judgeAdapter: JudgeAdapter = {
    invoke: async (input) => ({
      responseId: `restart-fixture-${input.case_id}`,
      responseStatusCode: 200,
      status: "completed",
      modelReportedId: "gpt-5.6-sol",
      serviceTierReported: "default",
      outputText: JSON.stringify(resultFor(input.case_id, input, {})),
      usage: { inputTokens: 100, cachedInputTokens: 10, cacheWriteTokens: 0, outputTokens: 20 },
      error: null,
    }),
  };
  const promoted = await promoteRecordedBenchmarkWithAdapter({
    outputDirectory,
    benchmarkPack: source.benchmarkPack,
    executionIdentity,
    schedule,
    plans,
    judgeAdapter,
    privateBlindingContext,
    persistPrecommit: (manifest) => (
      testAuthority === undefined
        ? persistAuthoritativeBlindingPrecommit({ manifest })
        : persistAuthoritativeBlindingPrecommitForTest({
            store: testAuthority.judgeEvidencePrecommitStore,
            manifest,
          })
    ),
  });
  const persisted = await persistRecordedBenchmarkPack({
    outputDirectory,
    pack: promoted.pack,
  });
  const recordedBenchmarkPack = await loadRecordedBenchmarkPack({
    path: persisted.path,
    authority: {
      benchmarkPack: source.benchmarkPack,
      judgeEvidencePack: promoted.pack.judge_evidence_pack,
      blindReviewQueue: promoted.pack.blind_review_queue,
    },
  });
  return {
    recordedBenchmarkPack,
    executionIdentityAuthority: {
      path: executionIdentityAuthority.path,
      payload_sha256: executionIdentityAuthority.payloadSha256,
    },
    plans,
    recordedPackPath: persisted.path,
    recordedPackHash: persisted.payloadSha256,
    privateBlindingSeedAuthority:
      testAuthority === undefined
        ? createAuthoritativePrivateBlindingContextReference({
            executionPackHash:
              recordedBenchmarkPack.execution_pack_hash,
          })
        : createAuthoritativePrivateBlindingContextReferenceForTest({
            rootDirectory:
              testAuthority.privateBlindingSeedRootDirectory,
            executionPackHash:
              recordedBenchmarkPack.execution_pack_hash,
          }),
    judgeEvidencePrecommitAuthority:
      testAuthority === undefined
        ? createAuthoritativeBlindingPrecommitReference({
            executionPackHash:
              recordedBenchmarkPack.execution_pack_hash,
            manifestDigest:
              recordedBenchmarkPack.precommit_manifest_digest,
            manifestHash:
              recordedBenchmarkPack.precommit_manifest_hash,
          })
        : createAuthoritativeBlindingPrecommitReferenceForTest({
            store: testAuthority.judgeEvidencePrecommitStore,
            executionPackHash:
              recordedBenchmarkPack.execution_pack_hash,
            manifestDigest:
              recordedBenchmarkPack.precommit_manifest_digest,
            manifestHash:
              recordedBenchmarkPack.precommit_manifest_hash,
          }),
  };
}

function cloneReviewInput(input: BuildBlindReviewQueueInput): BuildBlindReviewQueueInput {
  const cloned = structuredClone(input) as BuildBlindReviewQueueInput;
  return {
    ...cloned,
    execution_evidence: {
      ...cloned.execution_evidence,
      // 일반 변조 테스트는 authoritative Locked Challenge에서 만든 동일 identity를 유지합니다.
      execution_identity: input.execution_evidence.execution_identity,
    },
    // 일반 변조 테스트는 저장 모듈이 발급한 동일 branded anchor를 유지합니다.
    authoritative_blinding_precommit: input.authoritative_blinding_precommit,
  };
}

function labelForCandidate(
  input: BuildBlindReviewQueueInput,
  caseId: string,
  candidateId: CandidateId,
): BlindJudgeLabel {
  const mapping = input.judge_cases.find((item) => item.case_id === caseId)!.private_mapping;
  return BLIND_JUDGE_LABELS.find(
    (label) => mapping.label_to_candidate[label] === candidateId,
  )!;
}

if (registerReviewQueueTests) describe("권위 근거에 결합된 blind human review queue", () => {
  it("잠긴 72-slot pack을 재검증하고 high-risk 4×X/Y/Z에 opaque run 근거를 붙인다", async () => {
    const input = await reviewInput();
    const queue = buildBlindReviewQueue(input);

    expect(queue.execution_pack_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(queue.required_item_count).toBe(12);
    expect(queue.additional_item_count).toBe(0);
    expect(queue.items.map((item) => `${item.case_id}:${item.blind_label}`)).toEqual(
      HIGH_RISK_CASE_IDS.flatMap((caseId) =>
        BLIND_JUDGE_LABELS.map((label) => `${caseId}:${label}`)
      ),
    );
    expect(queue.items.every((item) => item.runs.length === 2)).toBe(true);
    expect(queue.items.every((item) => item.runs.every((run) => (
      /^evh_[a-f0-9]{64}$/.test(run.evidence_handle)
      && typeof run.review_output?.customer_reply === "string"
    )))).toBe(true);
    expect(queue.items.every((item) => /^evh_[a-f0-9]{64}$/.test(item.judge_evidence_handle)))
      .toBe(true);
    const rawHashes = input.execution_evidence.completed_slots.flatMap((slot) => [
      slot.slot_identity.slot_identity_hash,
      sha256CanonicalJson(slot.intent),
      sha256CanonicalJson(slot.receipt),
      sha256CanonicalJson(slot.checkpoint),
    ]);
    const serialized = JSON.stringify(queue);
    expect(serialized).not.toMatch(
      /slot_identity_hash|intent_payload_sha256|receipt_payload_sha256|checkpoint_payload_sha256/i,
    );
    expect(rawHashes.every((hash) => !serialized.includes(hash))).toBe(true);
  });

  it("고위험 terminal run을 상태와 null output으로 보존해 사람 검수에서 위조 답변을 만들지 않는다", async () => {
    const input = await reviewInput({ terminalSlotId: "H-007--C--r2" });
    const blindLabel = labelForCandidate(input, "H-007", "C");
    const queue = buildBlindReviewQueue(input);
    const item = queue.items.find((candidate) => (
      candidate.case_id === "H-007" && candidate.blind_label === blindLabel
    ));

    expect(item).toBeDefined();
    expect(item!.runs).toMatchObject([
      { repetition: 1, execution_status: "COMPLETE" },
      {
        repetition: 2,
        execution_status: "BUDGET_EXCEEDED",
        review_output: null,
      },
    ]);
    expect(item!.deterministic_gate_finding).toBe("NONE");
  });

  it("고위험 실제 gate 실패를 blind run별 체크포인트 근거로 투영하고 구조 단서를 제거한다", async () => {
    const input = await reviewInput({ missingRequiredTools: ["H-007:C"] });
    const blindLabel = labelForCandidate(input, "H-007", "C");
    const queue = buildBlindReviewQueue(input);
    const item = queue.items.find((candidate) => (
      candidate.case_id === "H-007" && candidate.blind_label === blindLabel
    ));

    expect(item).toBeDefined();
    expect(item!.deterministic_gate_finding).toBe("CONFIRMED_FAIL");
    expect(item!.deterministic_gate_evidence.map((evidence) => evidence.repetition)).toEqual([1, 2]);
    const unsaltedFindingCodeHashes = new Set([
      sha256CanonicalJson({ finding_code: "REQUIRED_TOOL_MISSING" }),
      sha256CanonicalJson({ finding_code: "CITATION_NOT_IN_RETRIEVED_EVIDENCE" }),
    ]);
    for (const evidence of item!.deterministic_gate_evidence) {
      const completed = input.execution_evidence.completed_slots.find((slot) => (
        slot.slot_identity.case_id === "H-007"
        && slot.slot_identity.candidate_id === "C"
        && slot.slot_identity.repetition === evidence.repetition
      ));
      expect(completed).toBeDefined();
      expect(evidence).toMatchObject({
        case_id: "H-007",
        blind_label: blindLabel,
        gate_id: "P0-HG-04",
        status: "CONFIRMED_FAIL",
      });
      expect(evidence.evidence_handle).toMatch(/^evh_[a-f0-9]{64}$/);
      expect(evidence.evidence_handle).not.toBe(sha256CanonicalJson(completed!.receipt));
      expect(evidence.evidence_handle).not.toBe(sha256CanonicalJson(completed!.checkpoint));
      expect(evidence.findings.length).toBeGreaterThan(0);
      for (const finding of evidence.findings) {
        expect(finding).toMatchObject({
          finding_code: "EXECUTION_CONTRACT_MISMATCH",
        });
        expect(finding.source_finding_handle).toMatch(/^evh_[a-f0-9]{64}$/);
        expect(unsaltedFindingCodeHashes.has(finding.source_finding_handle)).toBe(false);
        expect(finding.source_message_handle).toMatch(/^evh_[a-f0-9]{64}$/);
        expect(finding.evidence_excerpt.length).toBeGreaterThan(0);
        expect(finding.evidence_locations.length).toBeGreaterThanOrEqual(2);
        expect(finding.evidence_locations.every((location) => (
          /^evh_[a-f0-9]{64}$/.test(location.reference_handle)
        ))).toBe(true);
      }
    }
    expect(JSON.stringify(item!.deterministic_gate_evidence)).not.toMatch(
      /candidate[_ -]?[abc]|system[_ -]?[abc]|get[_ -]?order|search[_ -]?policy|retriev|vector|\br\W*a\W*g\b|tool|agent/i,
    );
  });

  it("실제 gate 실패를 pack과 private mapping에서 재도출하고 Judge 중복 추가를 막는다", async () => {
    const input = await reviewInput({
      deterministicFailures: ["H-002:A"],
    });
    const blindLabel = labelForCandidate(input, "H-002", "A");
    const riskInput = await reviewInput({
      deterministicFailures: ["H-002:A"],
      risks: { "H-002": { [blindLabel]: "HIGH", Z: "MEDIUM" } },
    });
    const queue = buildBlindReviewQueue(riskInput);

    expect(queue.items.some((item) => (
      item.case_id === "H-002" && item.blind_label === blindLabel
    ))).toBe(false);
    expect(queue.items.filter((item) => item.case_id === "H-002")).toHaveLength(
      blindLabel === "Z" ? 0 : 1,
    );
  });

  it.each([
    [0, {}, "READY_FOR_REVIEW"],
    [2, { "H-001": { X: "HIGH", Y: "LOW" } }, "READY_FOR_REVIEW"],
    [6, {
      "H-001": { X: "HIGH", Y: "HIGH", Z: "HIGH" },
      "H-002": { X: "MEDIUM", Y: "LOW", Z: "LOW" },
    }, "READY_FOR_REVIEW"],
    [7, {
      "H-001": { X: "HIGH", Y: "HIGH", Z: "HIGH" },
      "H-002": { X: "MEDIUM", Y: "MEDIUM", Z: "LOW" },
      "H-003": { X: "LOW" },
    }, "OVERFLOW"],
  ] as const)("Judge 추가 %i개를 누락 없이 처리한다", async (count, risks, status) => {
    const queue = buildBlindReviewQueue(await reviewInput({ risks }));

    expect(queue.additional_item_count).toBe(count);
    expect(queue.items).toHaveLength(12 + count);
    expect(queue.queue_status).toBe(status);
    expect(queue.overflow.detected).toBe(count > 6);
    expect(queue.evaluation_status).toBe("EVALUATION_INCOMPLETE");
  });

  it("추가 위험을 HIGH→MEDIUM→LOW, case ID, X/Y/Z 순으로 정렬한다", async () => {
    const queue = buildBlindReviewQueue(await reviewInput({
      risks: {
        "H-001": { Z: "LOW", Y: "HIGH" },
        "H-002": { Z: "HIGH", X: "HIGH" },
        "H-003": { Y: "MEDIUM", X: "MEDIUM" },
      },
    }));

    expect(queue.items.slice(12).map((item) =>
      `${item.priority_severity}:${item.case_id}:${item.blind_label}`
    )).toEqual([
      "HIGH:H-001:Y",
      "HIGH:H-002:X",
      "HIGH:H-002:Z",
      "MEDIUM:H-003:X",
      "MEDIUM:H-003:Y",
      "LOW:H-001:Z",
    ]);
  });

  it("top-level과 judge case의 추가 필드 및 이전 임의 failure ref API를 거부한다", async () => {
    const input = await reviewInput();
    const topExtra = { ...input, deterministicConfirmedFailures: [] };
    expect(() => buildBlindReviewQueue(topExtra)).toThrow(/exact|필드|additional|허용/i);

    const caseExtra = cloneReviewInput(input) as unknown as Record<string, any>;
    caseExtra.judge_cases[0].candidate_id = "A";
    expect(() => buildBlindReviewQueue(caseExtra)).toThrow(/exact|필드|additional|허용/i);

    const outputExtra = cloneReviewInput(input) as any;
    const completed = outputExtra.execution_evidence.completed_slots[0];
    completed.receipt.execution.slot_result.run.output.unexpected_field = "forged";
    completed.receipt.execution.slot_result.completedExecutionEvidence.finalOutputHash =
      sha256CanonicalJson(completed.receipt.execution.slot_result.run.output);
    completed.checkpoint.receipt_payload_sha256 = sha256CanonicalJson(completed.receipt);
    expect(() => buildBlindReviewQueue(outputExtra)).toThrow(/output|필드|키|계약|exact/i);

    const slotWrapperExtra = cloneReviewInput(input) as any;
    slotWrapperExtra.execution_evidence.completed_slots[0].candidate_id = "A";
    expect(() => buildBlindReviewQueue(slotWrapperExtra)).toThrow(
      /completed_slots|wrapper|plain|exact|필드|additional|계약/i,
    );

    const slotWrapperPrototype = cloneReviewInput(input) as any;
    slotWrapperPrototype.execution_evidence.completed_slots[0] = Object.assign(
      Object.create({ candidate_id: "A" }),
      slotWrapperPrototype.execution_evidence.completed_slots[0],
    );
    expect(() => buildBlindReviewQueue(slotWrapperPrototype)).toThrow(
      /completed_slots|wrapper|plain|prototype|객체/i,
    );
  });

  it("하나의 execution-bound master commitment만 허용하고 사후 case reblinding을 거부한다", async () => {
    const input = await reviewInput();
    const queue = buildBlindReviewQueue(input);
    const commitment =
      input.authoritative_blinding_precommit.master_blinding_seed_commitment;

    expect(new Set(input.judge_cases.map(
      (item) => item.private_mapping.master_blinding_seed_commitment,
    ))).toEqual(new Set([commitment]));
    expect(input.judge_cases.every((item) => (
      item.private_mapping.execution_pack_hash
      === input.authoritative_blinding_precommit.execution_pack_hash
    ))).toBe(true);
    expect(JSON.stringify(queue)).not.toMatch(
      /master_blinding_seed|case_blinding_seed|private_mapping|label_to_candidate/i,
    );
    const serialized = JSON.stringify(queue);
    expect(serialized).not.toContain(MASTER_BLINDING_SEED);
    expect(input.judge_cases.every((item) => (
      !serialized.includes(item.private_mapping.case_blinding_seed)
      && !serialized.includes(item.private_mapping.private_mapping_hash)
    ))).toBe(true);

    const postHoc = cloneReviewInput(input) as any;
    postHoc.judge_cases[0].private_mapping = buildExecutionBoundPrivateBlindMapping({
      caseId: "H-001",
      executionPackHash: input.authoritative_blinding_precommit.execution_pack_hash,
      masterBlindingSeed: "post-hoc-case-reblinding-secret-for-hidden-benchmark-00001",
    });
    expect(() => buildBlindReviewQueue(postHoc)).toThrow(
      /precommit|commitment|seed|reblind|mapping|무결성/i,
    );
  });

  it("persist/load가 발급하지 않은 clone·fabricated precommit anchor를 거부한다", async () => {
    const input = await reviewInput();
    const cloned = structuredClone(input) as any;
    cloned.execution_evidence.execution_identity =
      input.execution_evidence.execution_identity;
    expect(() => buildBlindReviewQueue(cloned)).toThrow(
      /authoritative|brand|persist|load|권위/i,
    );

    const fabricated = {
      ...input,
      authoritative_blinding_precommit: {
        ...input.authoritative_blinding_precommit,
      },
    };
    expect(() => buildBlindReviewQueue(fabricated)).toThrow(
      /authoritative|brand|persist|load|권위/i,
    );
  });

  it("권위 근거로 생성된 동일 queue 객체만 validated brand를 유지하고 공개 hash로 내용·순서를 결합한다", async () => {
    const queue = buildBlindReviewQueue(await reviewInput({
      risks: { "H-001": { X: "HIGH" } },
    }));

    expect(() => assertValidatedBlindReviewQueue(queue)).not.toThrow();
    expect(queue.queue_set_order_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(queue.queue_content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(calculateBlindReviewQueueSetOrderHash(queue)).toBe(
      queue.queue_set_order_hash,
    );
    expect(calculateBlindReviewQueueContentHash(queue)).toBe(
      queue.queue_content_hash,
    );

    const cloned = structuredClone(queue);
    expect(() => assertValidatedBlindReviewQueue(cloned)).toThrow(
      /validated|brand|권위|생성된 동일 객체/i,
    );
    expect(() => assertValidatedBlindReviewQueue({ ...queue })).toThrow(
      /validated|brand|권위|생성된 동일 객체/i,
    );
    expect(() => assertValidatedBlindReviewQueue({
      ...structuredClone(queue),
      queue_content_hash: calculateBlindReviewQueueContentHash(queue),
      queue_set_order_hash: calculateBlindReviewQueueSetOrderHash(queue),
    })).toThrow(/validated|brand|권위|생성된 동일 객체/i);

    expect(JSON.stringify(queue)).not.toMatch(
      /slot_identity_hash|intent_payload_sha256|receipt_payload_sha256|checkpoint_payload_sha256/i,
    );
  });

  it("12개 Judge 입력·mapping·receipt를 새 seed로 전부 재생성해도 최초 write-once precommit을 바꾸지 못한다", async () => {
    const authorityRoot = await realpath(await mkdtemp(
      join(tmpdir(), "review-queue-full-reblind-authority-"),
    ));
    const authority = await createTestAuthoritativeBlindingPrecommitAuthority({
      rootDirectory: authorityRoot,
    });
    const first = await reviewInput({
      precommitAuthority: authority,
      precommitStoreName: "authority-store",
      masterBlindingSeed: MASTER_BLINDING_SEED,
    });

    expect(first.judge_cases).toHaveLength(12);
    expect(() => buildBlindReviewQueue(first)).not.toThrow();
    await expect(reviewInput({
      precommitAuthority: authority,
      precommitStoreName: "attacker-store",
      masterBlindingSeed: REBLINDING_ATTACK_MASTER_SEED,
    })).rejects.toThrow(
      /authority|store|claim|precommit|write-once|commitment|다릅니다/i,
    );
  });

  it("Judge receipt replay, expected input 위조, attempt 변조를 모두 거부한다", async () => {
    const input = await reviewInput();

    const replay = cloneReviewInput(input) as any;
    replay.judge_cases[1].judge_run_receipt = replay.judge_cases[0].judge_run_receipt;
    expect(() => buildBlindReviewQueue(replay)).toThrow(/case|identity|hash|receipt/i);

    const forgedInput = cloneReviewInput(input) as any;
    forgedInput.judge_cases[0].expected_blind_input.blind_candidates[0].runs[0].output.customer_reply =
      "Self-consistent forged reply that is not in the recorded execution slot.";
    await expect(completeJudgeRun(
      forgedInput.judge_cases[0].expected_blind_input,
      resultFor("H-001", forgedInput.judge_cases[0].expected_blind_input, {}),
      input.authoritative_blinding_precommit,
    )).rejects.toThrow(/precommit|확약|binding|input/i);
    expect(() => buildBlindReviewQueue(forgedInput)).toThrow(/execution|slot|blind input|binding|일치/i);

    const attemptTamper = cloneReviewInput(input) as any;
    attemptTamper.judge_cases[0].judge_run_receipt.attempts[0].latencyMs += 1;
    expect(() => buildBlindReviewQueue(attemptTamper)).toThrow(/latency|receipt|attempt|합계|무결성/i);

    const httpTamper = cloneReviewInput(input) as any;
    httpTamper.judge_cases[0].judge_run_receipt.attempts[0].responseStatusCode = 201;
    expect(() => buildBlindReviewQueue(httpTamper)).toThrow(/HTTP|status|응답|증거|불변식/i);

    const resultExtra = cloneReviewInput(input) as any;
    resultExtra.judge_cases[0].judge_run_receipt.result.candidates[0].unexpected_field = "forged";
    expect(() => buildBlindReviewQueue(resultExtra)).toThrow(/result|candidate|필드|키|계약|exact/i);
  });

  it("72-slot causal hash가 바뀌거나 slot replay가 발생하면 pack 재검증에서 차단한다", async () => {
    const input = await reviewInput();
    const hashTamper = cloneReviewInput(input) as any;
    hashTamper.execution_evidence.completed_slots[0].checkpoint.receipt_payload_sha256 =
      "0".repeat(64);
    expect(() => buildBlindReviewQueue(hashTamper)).toThrow(/checkpoint|receipt|hash|인과|무결성/i);

    const slotReplay = cloneReviewInput(input) as any;
    slotReplay.execution_evidence.completed_slots[1] =
      structuredClone(slotReplay.execution_evidence.completed_slots[0]);
    expect(() => buildBlindReviewQueue(slotReplay)).toThrow(/중복|누락|slot|schedule/i);
  });

  it("큐에 노출되지 않는 NO_RISK 구조 문구는 immutable Judge COMPLETE 승격을 막지 않는다", async () => {
    const input = cloneReviewInput(await reviewInput()) as any;
    const judgeCase = input.judge_cases.find(
      (item: ReviewQueueJudgeCase) => item.case_id === "H-012",
    )!;
    const result = structuredClone(
      judgeCase.judge_run_receipt.result,
    ) as BlindJudgeResult;
    result.candidates[0]!.criteria[0]!.rationale =
      "Both runs specify tool failure and escalation clearly.";
    judgeCase.judge_run_receipt = await completeJudgeRun(
      judgeCase.expected_blind_input,
      result,
      input.authoritative_blinding_precommit,
    );
    const immutableReceiptHash = sha256CanonicalJson(
      judgeCase.judge_run_receipt,
    );

    const queue = buildBlindReviewQueue(input);

    expect(sha256CanonicalJson(judgeCase.judge_run_receipt)).toBe(
      immutableReceiptHash,
    );
    expect(
      judgeCase.judge_run_receipt.result.candidates[0].criteria[0].rationale,
    ).toBe("Both runs specify tool failure and escalation clearly.");
    expect(queue.items.filter((item) => item.case_id === "H-012")).toHaveLength(3);
    expect(JSON.stringify(queue)).not.toContain(
      "Both runs specify tool failure and escalation clearly.",
    );
  });

  it("노출 RISK 구조 문구만 중립화하고 분류·근거·결정적 gate 우선권은 보존한다", async () => {
    const input = cloneReviewInput(await reviewInput({
      deterministicFailures: ["H-012:A"],
    })) as any;
    const blindLabel = labelForCandidate(input, "H-012", "A");
    const judgeCase = input.judge_cases.find(
      (item: ReviewQueueJudgeCase) => item.case_id === "H-012",
    )!;
    const result = structuredClone(
      judgeCase.judge_run_receipt.result,
    ) as BlindJudgeResult;
    const candidate = result.candidates.find(
      (item) => item.blind_label === blindLabel,
    )!;
    candidate.criteria[0] = {
      criterion_id: "FACTUAL_COMPLETENESS_RISK",
      status: "RISK",
      severity: "HIGH",
      failure_type: "MISSING_REQUIRED_FACT",
      concerning_field: "INTENT_CODE",
      concerning_excerpt: "TOOL_FAILURE",
      evidence_ids: [
        `${blindLabel}:RUN:1`,
        "ORACLE:REQUIRED_REPLY_CLAIMS",
      ],
      rationale:
        "The tool failure signal requires human review of the cited evidence.",
    };
    judgeCase.judge_run_receipt = await completeJudgeRun(
      judgeCase.expected_blind_input,
      result,
      input.authoritative_blinding_precommit,
    );
    const immutableReceiptHash = sha256CanonicalJson(
      judgeCase.judge_run_receipt,
    );

    const queue = buildBlindReviewQueue(input);
    const item = queue.items.find((queueItem) => (
      queueItem.case_id === "H-012"
      && queueItem.blind_label === blindLabel
    ))!;
    const risk = item.judge_risks[0]!;

    expect(sha256CanonicalJson(judgeCase.judge_run_receipt)).toBe(
      immutableReceiptHash,
    );
    expect(item.deterministic_gate_finding).toBe("CONFIRMED_FAIL");
    expect(risk).toMatchObject({
      criterion_id: "FACTUAL_COMPLETENESS_RISK",
      status: "RISK",
      severity: "HIGH",
      failure_type: "MISSING_REQUIRED_FACT",
      evidence_ids: [
        `${blindLabel}:RUN:1`,
        "ORACLE:REQUIRED_REPLY_CLAIMS",
      ],
    });
    expect(risk.concerning_excerpt).not.toContain("TOOL_FAILURE");
    expect(risk.rationale).not.toMatch(/\btool\b/i);
    expect(JSON.stringify(item.judge_risks)).not.toMatch(/tool[ _-]*failure/i);
  });

  it.each([
    "Ｓｙｓｔｅｍ\u200b A generated this answer.",
    "The get-order and search_policy path was used.",
    "A R.A.G. retrieval used a vector store.",
    "A read-only tool agent generated this answer.",
    "Vector search grounded this reply.",
    "An agentic workflow generated this reply.",
    "Ｆｕｎｃｔｉｏｎ\u200b-\u200bcalling generated this reply.",
    "An L\u200bL\u200bM generated this reply.",
    "Prompt_only mode generated this reply.",
    "Search·index grounding generated this reply.",
    "Functіon calling generated this reply.",
    "Ρrompt only generated this reply.",
    "Configuration A generated this reply.",
    "Config-B generated this reply.",
    "Model C generated this reply.",
    "Ｃｏｎｆｉｇｕｒａｔｉｏｎ\u200b Α generated this reply.",
    "Confіguration·Β generated this reply.",
    "Μodel／С generated this reply.",
  ])("구조 동의어·homoglyph·분리자 공격을 중립 review projection으로 바꾼다: %s", async (leak) => {
    const input = await reviewInput({ replyOverrides: { "H-007--A--r1": leak } });
    const blindLabel = labelForCandidate(input, "H-007", "A");
    const queue = buildBlindReviewQueue(input);
    const item = queue.items.find((candidate) => (
      candidate.case_id === "H-007" && candidate.blind_label === blindLabel
    ));
    const judgeCase = input.judge_cases.find((candidate) => candidate.case_id === "H-007")!;
    const judgeCandidate = judgeCase.expected_blind_input.blind_candidates.find(
      (candidate) => candidate.blind_label === blindLabel,
    )!;

    expect(item!.runs[0].review_output!.customer_reply).toBe(
      "[Wording withheld to preserve blind review.]",
    );
    expect(item!.runs[0].projection).toMatchObject({
      redaction_status: "REDACTED",
      source_output_commitment: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(judgeCandidate.runs[0].output!.customer_reply).toBe(
      "[Wording withheld to preserve blind review.]",
    );
    expect(judgeCandidate.runs[0].projection).toEqual(item!.runs[0].projection);
    expect(JSON.stringify(queue)).not.toContain(leak);
  });

  it("중립화는 원시 hard-gate 실패와 Judge RISK를 숨기거나 통과 판정으로 바꾸지 않는다", async () => {
    const replyOverrides = {
      "H-007--A--r1": "Function-calling generated this unsafe answer.",
    };
    const base = await reviewInput({
      deterministicFailures: ["H-007:A"],
      replyOverrides,
    });
    const blindLabel = labelForCandidate(base, "H-007", "A");
    const input = await reviewInput({
      deterministicFailures: ["H-007:A"],
      replyOverrides,
      risks: { "H-007": { [blindLabel]: "HIGH" } },
    });
    const queue = buildBlindReviewQueue(input);
    const item = queue.items.find((candidate) => (
      candidate.case_id === "H-007" && candidate.blind_label === blindLabel
    ))!;

    expect(item.runs[0].projection.redaction_status).toBe("REDACTED");
    expect(item.deterministic_gate_finding).toBe("CONFIRMED_FAIL");
    expect(item.deterministic_gate_evidence.length).toBeGreaterThan(0);
    expect(item.judge_risks.some((risk) => risk.status === "RISK")).toBe(true);
    expect(JSON.stringify(item)).not.toMatch(/PASS|approved|winner|recommendation/i);
  });

  it("큐는 deep-freeze되고 입력 사후 변경과 분리되며 신원·비용·구조를 노출하지 않는다", async () => {
    const input = cloneReviewInput(await reviewInput({ risks: { "H-001": { X: "HIGH" } } }));
    const queue = buildBlindReviewQueue(input);
    const originalReply = queue.items[0].runs[0].review_output!.customer_reply;

    input.judge_cases[6].expected_blind_input.blind_candidates[0].runs[0].output!.customer_reply =
      "Mutated after queue creation.";
    expect(queue.items[0].runs[0].review_output!.customer_reply).toBe(originalReply);
    expect(Object.isFrozen(queue)).toBe(true);
    expect(Object.isFrozen(queue.items[0].runs[0].review_output)).toBe(true);
    expect(Object.isFrozen(queue.items[0].deterministic_gate_evidence)).toBe(true);
    expect(() => {
      (queue.items[0].runs[0].review_output as { customer_reply: string }).customer_reply = "forged";
    }).toThrow();

    const serialized = JSON.stringify(queue);
    expect(serialized).not.toMatch(
      /candidate_id|label_to_candidate|private_mapping|blinding_seed|model|config(?:uration)?|architecture|complexity|cost|latency|system[ _-]*[abc]|get_order|search_policy|retrieval|vector|rag|tool[ _-]*agent|read[ _-]*only[ _-]*tool/i,
    );
    expect(serialized).not.toMatch(/human_confirmed|approved_candidate|winner|recommendation/i);
    expect(queue.items.every((item) => item.judge_risks.every((risk) => risk.status === "RISK")))
      .toBe(true);
  });
});

function benchmarkPackForReviewInput(input: BuildBlindReviewQueueInput) {
  return buildBenchmarkExecutionPack({
    executionIdentity: input.execution_evidence.execution_identity,
    schedule,
    completedSlots: input.execution_evidence.completed_slots,
  });
}

function preReviewCommandFor(
  benchmarkPack: ReturnType<typeof buildRecordedBenchmarkPack>,
  queue: ReturnType<typeof buildBlindReviewQueue>,
  overrides: Partial<AiPreReviewCommand> = {},
): AiPreReviewCommand {
  return {
    schema_version: "ai-pre-review-command-v1",
    reviewer_label: "Independent decision owner",
    expected_recorded_benchmark_pack_hash: sha256CanonicalJson(benchmarkPack),
    expected_judge_evidence_hash: benchmarkPack.judge_evidence_pack_hash,
    expected_queue_content_hash: calculateBlindReviewQueueContentHash(queue),
    expected_queue_set_order_hash: calculateBlindReviewQueueSetOrderHash(queue),
    items: queue.items.map((item) => ({
      item_id: item.item_id,
      proposed_decision: item.deterministic_gate_finding === "CONFIRMED_FAIL"
        ? "PROPOSED_CONFIRMED_FAIL"
        : "PROPOSED_PASS",
      rationale: item.deterministic_gate_finding === "CONFIRMED_FAIL"
        ? "The locked deterministic evidence confirms this proposed failure."
        : "The blinded queue evidence supports this advisory proposal.",
      evidence_handles: [
        item.deterministic_gate_evidence[0]?.evidence_handle
        ?? item.judge_evidence_handle,
      ],
    })),
    reviewed_at: "2026-07-17T03:00:00.000Z",
    ...overrides,
  };
}

/** 다른 server 재시작 통합 테스트도 같은 persisted source fixture를 재사용한다. */
export async function task13Authority(options: ReviewInputOptions = {}) {
  const task10 = await task10Authority(options);
  const input = task10.input;
  const queue = task10.queue;
  const sourceDirectory = await realpath(await mkdtemp(
    join(tmpdir(), "task13-recorded-benchmark-source-"),
  ));
  const persisted = await persistRecordedBenchmarkPack({
    outputDirectory: sourceDirectory,
    pack: task10.recordedPack,
  });
  const benchmarkPack = await loadRecordedBenchmarkPack({
    path: persisted.path,
    authority: {
      benchmarkPack: task10.benchmarkPack,
      judgeEvidencePack: task10.judgeEvidencePack,
      blindReviewQueue: queue,
    },
  });
  const command = preReviewCommandFor(benchmarkPack, queue);
  return { input, benchmarkPack, queue, command };
}

if (registerReviewQueueTests) describe("권위 queue에 결합된 AI pre-review와 provisional Memo", () => {
  it("exact queue 순서·opaque evidence·source hash를 가진 advisory receipt만 사용자 확인 준비 상태가 된다", async () => {
    const { benchmarkPack, queue, command } = await task13Authority();
    const receipt = buildAiPreReviewReceipt({ benchmarkPack, queue, command });

    expect(receipt).toMatchObject({
      schema_version: "ai-pre-review-receipt-v1",
      artifact_kind: "AI_PRE_REVIEW_RECEIPT",
      synthetic: true,
      advisory_only: true,
      human_confirmed: false,
      pre_review_status: "USER_CONFIRMATION_READY",
      recorded_benchmark_pack_hash: sha256CanonicalJson(benchmarkPack),
      judge_evidence_hash: benchmarkPack.judge_evidence_pack_hash,
      queue_content_hash: calculateBlindReviewQueueContentHash(queue),
      queue_set_order_hash: calculateBlindReviewQueueSetOrderHash(queue),
      baseline_version: null,
    });
    expect(receipt.items.map((item) => item.item_id)).toEqual(
      queue.items.map((item) => item.item_id),
    );
    expect(receipt.items.every((item) => (
      item.evidence_handles.length > 0
      && item.evidence_handles.every((handle) => /^evh_[a-f0-9]{64}$/.test(handle))
    ))).toBe(true);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(() => assertValidatedAiPreReviewReceipt(receipt)).not.toThrow();
    expect(() => assertValidatedAiPreReviewReceipt(structuredClone(receipt))).toThrow(
      /검증|build|authoritative/i,
    );
    expect(() => buildAiPreReviewReceipt({
      benchmarkPack,
      queue: structuredClone(queue),
      command,
    })).toThrow(/검증|authoritative|queue/i);
  });

  it("ABSTAIN은 receipt에 보존되지만 USER_CONFIRMATION_BLOCKED를 강제한다", async () => {
    const { benchmarkPack, queue, command } = await task13Authority();
    command.items[0] = {
      ...command.items[0],
      proposed_decision: "ABSTAIN",
      rationale: "The available blinded evidence is insufficient for an advisory proposal.",
    };
    const receipt = buildAiPreReviewReceipt({ benchmarkPack, queue, command });

    expect(receipt.pre_review_status).toBe("USER_CONFIRMATION_BLOCKED");
    expect(receipt.blocking_reasons).toContain("ABSTAIN");
    expect(receipt.human_confirmed).toBe(false);
    expect(receipt.baseline_version).toBeNull();
  });

  it("Judge 위험은 PROPOSED_PASS를 차단하지 않고 사람 검수 근거로 남긴다", async () => {
    const { benchmarkPack, queue } = await task13Authority({
      risks: { "H-001": { X: "HIGH" } },
    });
    const command = buildDeterministicAiPreReviewCommand({
      recordedBenchmarkPack: benchmarkPack,
      reviewedAt: "2026-07-17T03:00:00.000Z",
    });
    const receipt = buildAiPreReviewReceipt({ benchmarkPack, queue, command });

    expect(receipt.pre_review_status).toBe("USER_CONFIRMATION_READY");
    expect(receipt.blocking_reasons).not.toContain("EVIDENCE_CONFLICT");
    expect(queue.items.some((item) => item.judge_risks.length > 0)).toBe(true);
    expect(receipt.human_confirmed).toBe(false);
    expect(receipt.baseline_version).toBeNull();
  }, 15_000);

  it("accessor가 검증 뒤 queue item 배열을 바꾸는 pre-review TOCTOU를 거부한다", async () => {
    const { benchmarkPack, queue, command } = await task13Authority();
    const originalItems = command.items;
    let reads = 0;
    Object.defineProperty(command, "items", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return reads <= 2 ? originalItems : [];
      },
    });

    expect(() => buildAiPreReviewReceipt({ benchmarkPack, queue, command }))
      .toThrow(/accessor|getter|data property|plain data|TOCTOU|속성/i);
  });

  it("거대한 sparse pre-review item/evidence 배열을 할당 전에 거부한다", async () => {
    const { benchmarkPack, queue, command } = await task13Authority();
    const hugeItems: AiPreReviewCommand["items"] = [];
    hugeItems.length = 1_000_000;
    command.items = hugeItems;
    expect(() => buildAiPreReviewReceipt({ benchmarkPack, queue, command }))
      .toThrow(/length|최대|범위|plain data/i);

    const evidenceCommand = preReviewCommandFor(benchmarkPack, queue);
    const hugeEvidence: string[] = [];
    hugeEvidence.length = 1_000_000;
    evidenceCommand.items[0].evidence_handles = hugeEvidence;
    expect(() => buildAiPreReviewReceipt({
      benchmarkPack,
      queue,
      command: evidenceCommand,
    })).toThrow(/length|최대|범위|plain data/i);
  });

  it("deterministic CONFIRMED_FAIL을 PROPOSED_PASS로 override할 수 없다", async () => {
    const { input, benchmarkPack, queue, command } = await task13Authority({
      deterministicFailures: ["H-007:A"],
    });
    const blindLabel = labelForCandidate(input, "H-007", "A");
    const itemId = `H-007--${blindLabel}`;
    const index = command.items.findIndex((item) => item.item_id === itemId);
    expect(index).toBeGreaterThanOrEqual(0);
    command.items[index] = {
      ...command.items[index],
      proposed_decision: "PROPOSED_PASS",
      rationale: "Attempted deterministic gate override.",
    };

    expect(() => buildAiPreReviewReceipt({ benchmarkPack, queue, command }))
      .toThrow(/deterministic|CONFIRMED_FAIL|override|gate/i);
  });

  it.each([
    {
      label: "reordered",
      mutate: (command: AiPreReviewCommand) => {
        [command.items[0], command.items[1]] = [command.items[1], command.items[0]];
      },
    },
    {
      label: "duplicate",
      mutate: (command: AiPreReviewCommand) => {
        command.items[1] = { ...command.items[0] };
      },
    },
    {
      label: "missing",
      mutate: (command: AiPreReviewCommand) => {
        command.items.pop();
      },
    },
    {
      label: "extra",
      mutate: (command: AiPreReviewCommand) => {
        command.items.push({ ...command.items[0], item_id: "H-001--X" });
      },
    },
    {
      label: "unsupported evidence",
      mutate: (command: AiPreReviewCommand) => {
        command.items[0].evidence_handles = [`evh_${"f".repeat(64)}`];
      },
    },
    {
      label: "identity leak",
      mutate: (command: AiPreReviewCommand) => {
        command.items[0].rationale = "Configuration A should pass because it used Model C.";
      },
    },
    {
      label: "stale queue hash",
      mutate: (command: AiPreReviewCommand) => {
        command.expected_queue_content_hash = "f".repeat(64);
      },
    },
  ])("$label pre-review command를 거부한다", async ({ mutate }) => {
    const { benchmarkPack, queue, command } = await task13Authority();
    mutate(command);
    expect(() => buildAiPreReviewReceipt({ benchmarkPack, queue, command }))
      .toThrow(/queue|item|evidence|identity|architecture|hash|순서|일치|누락|추가/i);
  });

  it("validated counts와 opaque evidence만으로 비권위 provisional Memo를 만든다", async () => {
    const { benchmarkPack, queue, command } = await task13Authority();
    const builtPreReviewReceipt = buildAiPreReviewReceipt({
      benchmarkPack,
      queue,
      command,
    });
    const sourceDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "preconfirmation-projection-source-"),
    ));
    const preReviewPersisted = await persistAiPreReviewReceipt({
      outputDirectory: sourceDirectory,
      receipt: builtPreReviewReceipt,
    });
    const preReviewReceipt = await loadAiPreReviewReceipt({
      path: preReviewPersisted.path,
      benchmarkPack,
      queue,
    });
    const builtMemo = buildProvisionalDecisionMemo({
      benchmarkPack,
      queue,
      preReviewReceipt,
      createdAt: "2026-07-17T03:05:00.000Z",
    });
    const memoPersisted = await persistProvisionalDecisionMemo({
      outputDirectory: sourceDirectory,
      memo: builtMemo,
    });
    const memo = await loadProvisionalDecisionMemo({
      path: memoPersisted.path,
      benchmarkPack,
      queue,
      preReviewReceipt,
    });

    expect(memo).toMatchObject({
      schema_version: "provisional-decision-memo-v1",
      artifact_kind: "PROVISIONAL_DECISION_MEMO",
      synthetic: true,
      advisory_only: true,
      human_confirmed: false,
      memo_status: "USER_CONFIRMATION_REQUIRED",
      recorded_benchmark_pack_hash: sha256CanonicalJson(benchmarkPack),
      ai_pre_review_receipt_hash: sha256CanonicalJson(preReviewReceipt),
      queue_content_hash: calculateBlindReviewQueueContentHash(queue),
    });
    expect(memo.counts.total_items).toBe(queue.items.length);
    expect(memo.evidence_handles.length).toBeGreaterThan(0);
    expect(Object.isFrozen(memo)).toBe(true);
    expect(() => assertValidatedProvisionalDecisionMemo(memo)).not.toThrow();
    expect(() => assertValidatedProvisionalDecisionMemo(structuredClone(memo)))
      .toThrow(/검증|build|authoritative/i);
    expect(JSON.stringify(memo)).not.toMatch(
      /composite[_ -]?score|winner|approved[_ -]?candidate|baseline[_ -]?id|purchase|deploy|contract/i,
    );

    const projection = buildPreconfirmationPublicProjection({
      recordedBenchmarkPack: benchmarkPack,
      preReviewReceipt,
      provisionalDecisionMemo: memo,
    });
    expect(projection).toMatchObject({
      schema_version: "preconfirmation-public-projection-v1",
      synthetic: true,
      review_id: preReviewReceipt.pre_review_id,
      source_hash: sha256CanonicalJson(memo),
      recorded_benchmark_pack_hash: sha256CanonicalJson(benchmarkPack),
      ai_pre_review_receipt_hash: sha256CanonicalJson(preReviewReceipt),
      provisional_decision_memo_hash: sha256CanonicalJson(memo),
      pre_review_status: "USER_CONFIRMATION_READY",
      advisory_only: true,
      human_confirmed: false,
      baseline_version: null,
      total: queue.items.length,
      completed: 0,
      remaining: queue.items.length,
    });
    expect(projection.items.map((item) => item.queue_index)).toEqual(
      queue.items.map((_, index) => index + 1),
    );
    expect(projection.items.map((item) => item.blind_label)).toEqual(
      queue.items.map((item) => item.blind_label),
    );
    expect(canonicalJsonStringify(projection)).not.toMatch(
      /Candidate [ABC]\b|private_mapping|label_to_candidate|blinding_seed|\bsingle llm\b|\brag\b|\btool workflow\b/i,
    );
    expect(buildPreconfirmationWorkspacePublicProjection({
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      recordedBenchmarkPack: benchmarkPack,
      preReviewReceipt,
      provisionalDecisionMemo: memo,
    })).toMatchObject({
      review_id: preReviewReceipt.pre_review_id,
      decision_id: null,
      baseline_id: null,
      regression_id: null,
      source_hash: sha256CanonicalJson(memo),
      stage_statuses: {
        define: "LOCKED",
        compare: "RECORDED",
        decide: "USER CONFIRMATION REQUIRED",
        monitor: "NO BASELINE",
      },
    });
    const snapshot = buildRecordedReviewProjectionSnapshot({
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      recordedBenchmarkPack: benchmarkPack,
      preReviewReceipt,
      provisionalDecisionMemo: memo,
    });
    // 대기열·AI 제안·opaque evidence handle은 persisted public snapshot에
    // 직렬화하면 안 됩니다. reviewer 전용 live route만 source에서 다시 조립합니다.
    expect(snapshot.projections.blind_reviews).toEqual([]);
    expect(canonicalJsonStringify(snapshot)).not.toMatch(
      /queue_content_hash|queue_set_order_hash|proposed_decision|review_evidence_handle|evh_[a-f0-9]{64}/i,
    );
    expect(snapshot.projections.workspace).toMatchObject({
      review_id: preReviewReceipt.pre_review_id,
      source_hash: sha256CanonicalJson(memo),
    });
    // REVIEW_PENDING 공개 snapshot은 후보별 aggregate만 유지합니다. case·candidate·run
    // 좌표와 raw evidence를 남기면 reviewer X/Y/Z detail과 상관시켜 후보 identity를
    // 복원할 수 있으므로, review confirmation 전에는 모두 fail-closed로 제거합니다.
    expect(snapshot.projections.evidence).toEqual([]);
    const publicProgress = snapshot.projections.benchmark_progress[0]!;
    expect(publicProgress).toMatchObject({
      completed: 72,
      total: 72,
      candidate_aggregates: expect.arrayContaining([
        expect.objectContaining({ candidate_id: "A" }),
        expect.objectContaining({ candidate_id: "B" }),
        expect.objectContaining({ candidate_id: "C" }),
      ]),
    });
    expect(publicProgress.slots).toEqual([]);
    expect(canonicalJsonStringify(publicProgress)).not.toMatch(
      /evidence_id|case_id|repetition|customer_reply|structured_decision|slot_/i,
    );
    expect(() => assertAuthoritativeRecordedWorkflowProjectionSnapshot(
      snapshot,
    )).not.toThrow();
    expect(() => assertAuthoritativeRecordedWorkflowProjectionSnapshot(
      structuredClone(snapshot),
    )).toThrow(/authoritative|권위|snapshot/i);
    await expect(
      createReadOnlyProjectionGateway(snapshot).getBlindReview(
        preReviewReceipt.pre_review_id,
      ),
    ).resolves.toBeNull();
  });

  it("blocked pre-review의 Memo도 USER_CONFIRMATION_BLOCKED이며 승인·baseline을 만들지 않는다", async () => {
    const { benchmarkPack, queue, command } = await task13Authority();
    command.items[0] = {
      ...command.items[0],
      proposed_decision: "ABSTAIN",
      rationale: "The evidence is insufficient.",
    };
    const preReviewReceipt = buildAiPreReviewReceipt({ benchmarkPack, queue, command });
    const memo = buildProvisionalDecisionMemo({
      benchmarkPack,
      queue,
      preReviewReceipt,
      createdAt: "2026-07-17T03:05:00.000Z",
    });

    expect(memo.memo_status).toBe("USER_CONFIRMATION_BLOCKED");
    expect(memo.human_confirmed).toBe(false);
    expect(JSON.stringify(memo)).not.toMatch(
      /"human_confirmed":true|approved|baseline_id/i,
    );
  });

  it("AI pre-review receipt를 canonical 0600 write-once 저장·로드하고 replay·clone·동시 선점을 막는다", async () => {
    const { benchmarkPack, queue, command } = await task13Authority();
    const receipt = buildAiPreReviewReceipt({ benchmarkPack, queue, command });
    const outputDirectory = await secureTempDirectory("ai-pre-review-");
    const stored = await persistAiPreReviewReceipt({ outputDirectory, receipt });
    const paths = createAiPreReviewReceiptPaths({
      outputDirectory,
      preReviewId: receipt.pre_review_id,
      payloadSha256: sha256CanonicalJson(receipt),
    });
    const loaded = await loadAiPreReviewReceipt({
      path: stored.path,
      benchmarkPack,
      queue,
    });

    expect(stored.path).toBe(paths.receiptPath);
    expect((await lstat(paths.receiptPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.claimPath)).mode & 0o777).toBe(0o600);
    expect(loaded).toEqual(receipt);
    expect(() => assertValidatedAiPreReviewReceipt(loaded)).not.toThrow();
    expect(() => assertPersistedAiPreReviewReceipt(receipt)).toThrow(
      /persisted|write-once|저장|source/i,
    );
    expect(() => assertPersistedAiPreReviewReceipt(loaded)).not.toThrow();
    const receiptHardLink = join(outputDirectory, "ai-pre-review-hard-link");
    await link(paths.receiptPath, receiptHardLink);
    await expect(loadAiPreReviewReceipt({
      path: stored.path,
      benchmarkPack,
      queue,
    })).rejects.toThrow(/nlink|hard.?link|regular|0600/i);
    await unlink(receiptHardLink);
    const movedPreReviewDirectory = `${paths.preReviewDirectory}-real`;
    await rename(paths.preReviewDirectory, movedPreReviewDirectory);
    await symlink(movedPreReviewDirectory, paths.preReviewDirectory);
    await expect(loadAiPreReviewReceipt({
      path: stored.path,
      benchmarkPack,
      queue,
    })).rejects.toThrow(/symlink|directory|디렉터리|safe|검증/i);
    await unlink(paths.preReviewDirectory);
    await rename(movedPreReviewDirectory, paths.preReviewDirectory);
    await unlink(paths.claimPath);
    await expect(loadAiPreReviewReceipt({
      path: stored.path,
      benchmarkPack,
      queue,
    })).rejects.toThrow(/claim|누락|safe|검증/i);
    await expect(persistAiPreReviewReceipt({ outputDirectory, receipt }))
      .rejects.toThrow(/replay|이미|already/i);

    const cloneDirectory = await secureTempDirectory("ai-pre-review-clone-");
    await expect(persistAiPreReviewReceipt({
      outputDirectory: cloneDirectory,
      receipt: structuredClone(receipt),
    })).rejects.toThrow(/검증|build|receipt/i);
    expect(await readdir(cloneDirectory)).toEqual([]);

    const raceDirectory = await secureTempDirectory("ai-pre-review-race-");
    const raceReceipt = buildAiPreReviewReceipt({ benchmarkPack, queue, command });
    const settled = await Promise.allSettled(Array.from({ length: 6 }, () => (
      persistAiPreReviewReceipt({ outputDirectory: raceDirectory, receipt: raceReceipt })
    )));
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(5);
  });

  it("pre-review symlink claim과 mode 변조 record를 authoritative load/replay로 신뢰하지 않는다", async () => {
    const { benchmarkPack, queue, command } = await task13Authority();
    const receipt = buildAiPreReviewReceipt({ benchmarkPack, queue, command });
    const directorySymlinkRoot = await secureTempDirectory(
      "ai-pre-review-directory-symlink-",
    );
    const directorySymlinkTarget = await secureTempDirectory(
      "ai-pre-review-outside-",
    );
    const directorySymlinkPaths = createAiPreReviewReceiptPaths({
      outputDirectory: directorySymlinkRoot,
      preReviewId: receipt.pre_review_id,
      payloadSha256: sha256CanonicalJson(receipt),
    });
    await symlink(
      directorySymlinkTarget,
      directorySymlinkPaths.preReviewDirectory,
    );
    await expect(persistAiPreReviewReceipt({
      outputDirectory: directorySymlinkRoot,
      receipt,
    })).rejects.toThrow(/symlink|directory|디렉터리|safe|검증/i);
    expect(await readdir(directorySymlinkTarget)).toEqual([]);

    const claimReceipt = buildAiPreReviewReceipt({ benchmarkPack, queue, command });
    const directory = await secureTempDirectory("ai-pre-review-symlink-");
    const paths = createAiPreReviewReceiptPaths({
      outputDirectory: directory,
      preReviewId: claimReceipt.pre_review_id,
      payloadSha256: sha256CanonicalJson(claimReceipt),
    });
    await mkdir(paths.preReviewDirectory, { recursive: true });
    const target = join(directory, "attacker.json");
    await writeFile(target, "{}\n", "utf8");
    await symlink(target, paths.claimPath);
    await expect(persistAiPreReviewReceipt({
      outputDirectory: directory,
      receipt: claimReceipt,
    }))
      .rejects.toThrow(/symlink|claim|검증|일치|safe/i);

    const modeDirectory = await secureTempDirectory("ai-pre-review-mode-");
    const modeReceipt = buildAiPreReviewReceipt({ benchmarkPack, queue, command });
    const persisted = await persistAiPreReviewReceipt({
      outputDirectory: modeDirectory,
      receipt: modeReceipt,
    });
    await chmod(persisted.path, 0o644);
    await expect(loadAiPreReviewReceipt({
      path: persisted.path,
      benchmarkPack,
      queue,
    })).rejects.toThrow(/0600|mode|regular|검증/i);
  });

  it("provisional Memo를 canonical 0600 write-once 저장·로드하고 replay·clone·symlink를 차단한다", async () => {
    const { benchmarkPack, queue, command } = await task13Authority();
    const preReviewReceipt = buildAiPreReviewReceipt({ benchmarkPack, queue, command });
    const memo = buildProvisionalDecisionMemo({
      benchmarkPack,
      queue,
      preReviewReceipt,
      createdAt: "2026-07-17T03:05:00.000Z",
    });
    const directory = await secureTempDirectory("provisional-memo-");
    const persisted = await persistProvisionalDecisionMemo({ outputDirectory: directory, memo });
    const paths = createProvisionalDecisionMemoPaths({
      outputDirectory: directory,
      memoId: memo.memo_id,
      payloadSha256: sha256CanonicalJson(memo),
    });
    const loaded = await loadProvisionalDecisionMemo({
      path: persisted.path,
      benchmarkPack,
      queue,
      preReviewReceipt,
    });
    expect(() => assertPersistedProvisionalDecisionMemo(memo)).toThrow(
      /persisted|write-once|저장|source/i,
    );
    expect(() => assertPersistedProvisionalDecisionMemo(loaded)).not.toThrow();
    expect((await lstat(paths.memoPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.claimPath)).mode & 0o777).toBe(0o600);
    expect(loaded).toEqual(memo);
    const memoHardLink = join(directory, "provisional-memo-hard-link");
    await link(paths.memoPath, memoHardLink);
    await expect(loadProvisionalDecisionMemo({
      path: persisted.path,
      benchmarkPack,
      queue,
      preReviewReceipt,
    })).rejects.toThrow(/nlink|hard.?link|regular|0600/i);
    await unlink(memoHardLink);
    const movedMemoDirectory = `${paths.memoDirectory}-real`;
    await rename(paths.memoDirectory, movedMemoDirectory);
    await symlink(movedMemoDirectory, paths.memoDirectory);
    await expect(loadProvisionalDecisionMemo({
      path: persisted.path,
      benchmarkPack,
      queue,
      preReviewReceipt,
    })).rejects.toThrow(/symlink|directory|디렉터리|safe|검증/i);
    await unlink(paths.memoDirectory);
    await rename(movedMemoDirectory, paths.memoDirectory);
    await unlink(paths.claimPath);
    await expect(loadProvisionalDecisionMemo({
      path: persisted.path,
      benchmarkPack,
      queue,
      preReviewReceipt,
    })).rejects.toThrow(/claim|누락|safe|검증/i);
    await expect(persistProvisionalDecisionMemo({ outputDirectory: directory, memo }))
      .rejects.toThrow(/replay|이미|already/i);

    const cloneDirectory = await secureTempDirectory("provisional-memo-clone-");
    await expect(persistProvisionalDecisionMemo({
      outputDirectory: cloneDirectory,
      memo: structuredClone(memo),
    })).rejects.toThrow(/검증|build|Memo/i);
    expect(await readdir(cloneDirectory)).toEqual([]);

    const directorySymlinkRoot = await secureTempDirectory(
      "provisional-memo-directory-symlink-",
    );
    const directorySymlinkTarget = await secureTempDirectory(
      "provisional-memo-outside-",
    );
    const directorySymlinkMemo = buildProvisionalDecisionMemo({
      benchmarkPack,
      queue,
      preReviewReceipt,
      createdAt: "2026-07-17T03:06:00.000Z",
    });
    const directorySymlinkPaths = createProvisionalDecisionMemoPaths({
      outputDirectory: directorySymlinkRoot,
      memoId: directorySymlinkMemo.memo_id,
      payloadSha256: sha256CanonicalJson(directorySymlinkMemo),
    });
    await symlink(
      directorySymlinkTarget,
      directorySymlinkPaths.memoDirectory,
    );
    await expect(persistProvisionalDecisionMemo({
      outputDirectory: directorySymlinkRoot,
      memo: directorySymlinkMemo,
    })).rejects.toThrow(/symlink|directory|디렉터리|safe|검증/i);
    expect(await readdir(directorySymlinkTarget)).toEqual([]);

    const symlinkDirectory = await secureTempDirectory("provisional-memo-symlink-");
    const symlinkMemo = buildProvisionalDecisionMemo({
      benchmarkPack,
      queue,
      preReviewReceipt,
      createdAt: "2026-07-17T03:07:00.000Z",
    });
    const symlinkPaths = createProvisionalDecisionMemoPaths({
      outputDirectory: symlinkDirectory,
      memoId: symlinkMemo.memo_id,
      payloadSha256: sha256CanonicalJson(symlinkMemo),
    });
    await mkdir(symlinkPaths.memoDirectory, { recursive: true });
    const target = join(symlinkDirectory, "attacker.json");
    await writeFile(target, "{}\n", "utf8");
    await symlink(target, symlinkPaths.claimPath);
    await expect(persistProvisionalDecisionMemo({
      outputDirectory: symlinkDirectory,
      memo: symlinkMemo,
    })).rejects.toThrow(/symlink|claim|검증|일치|safe/i);
  });
});

async function task14Authority(options: ReviewInputOptions = {}) {
  const authority = await task13Authority(options);
  const builtPreReviewReceipt = buildAiPreReviewReceipt({
    benchmarkPack: authority.benchmarkPack,
    queue: authority.queue,
    command: authority.command,
  });
  const sourceDirectory = await realpath(await mkdtemp(
    join(tmpdir(), "task14-preconfirmation-source-"),
  ));
  const preReviewPersisted = await persistAiPreReviewReceipt({
    outputDirectory: sourceDirectory,
    receipt: builtPreReviewReceipt,
  });
  const preReviewReceipt = await loadAiPreReviewReceipt({
    path: preReviewPersisted.path,
    benchmarkPack: authority.benchmarkPack,
    queue: authority.queue,
  });
  const builtProvisionalMemo = buildProvisionalDecisionMemo({
    benchmarkPack: authority.benchmarkPack,
    queue: authority.queue,
    preReviewReceipt,
    createdAt: "2026-07-17T03:05:00.000Z",
  });
  const provisionalMemoPersisted = await persistProvisionalDecisionMemo({
    outputDirectory: sourceDirectory,
    memo: builtProvisionalMemo,
  });
  const provisionalMemo = await loadProvisionalDecisionMemo({
    path: provisionalMemoPersisted.path,
    benchmarkPack: authority.benchmarkPack,
    queue: authority.queue,
    preReviewReceipt,
  });
  const expected = createHumanConfirmationExpectedContext({
    benchmarkPack: authority.benchmarkPack,
    queue: authority.queue,
    preReviewReceipt,
    provisionalMemo,
  });
  return {
    ...authority,
    preReviewReceipt,
    provisionalMemo,
    expected,
  };
}

function humanConfirmationCommandFor(
  expected: HumanConfirmationExpectedContext,
  overrides: Partial<HumanConfirmationCommand> = {},
): HumanConfirmationCommand {
  return {
    schema_version: "human-confirmation-command-v1",
    action: "ACCEPT_ALL",
    actor_label: "Challenge owner",
    expected_recorded_benchmark_pack_hash: expected.recorded_benchmark_pack_hash,
    expected_ai_pre_review_receipt_hash: expected.ai_pre_review_receipt_hash,
    expected_provisional_decision_memo_hash: expected.provisional_decision_memo_hash,
    expected_queue_content_hash: expected.queue_content_hash,
    expected_queue_set_order_hash: expected.queue_set_order_hash,
    expected_queue_item_set_hash: expected.queue_item_set_hash,
    expected_queue_item_order_hash: expected.queue_item_order_hash,
    items: expected.proposal_items.map((item, index) => ({
      item_id: item.item_id,
      final_decision: item.expected_final_decision,
      rationale: item.expected_rationale,
      proposal_resolution: "ACCEPTED",
      review_duration_ms: 1_000 + index,
      edit_duration_ms: 0,
    })),
    confirmed_at: "2026-07-17T03:10:00.000Z",
    ...overrides,
  };
}

if (registerReviewQueueTests) describe("권위 artifact chain에 결합된 최종 사용자 확인", () => {
  it("실제 branded source만 expected context를 발급하며 clone·fabrication을 거부한다", async () => {
    const {
      benchmarkPack,
      queue,
      preReviewReceipt,
      provisionalMemo,
      expected,
    } = await task14Authority();

    expect(expected).toMatchObject({
      schema_version: "human-confirmation-expected-context-v2",
      synthetic: true,
      recorded_benchmark_pack_hash: sha256CanonicalJson(benchmarkPack),
      ai_pre_review_receipt_hash: sha256CanonicalJson(preReviewReceipt),
      provisional_decision_memo_hash: sha256CanonicalJson(provisionalMemo),
      queue_content_hash: calculateBlindReviewQueueContentHash(queue),
      queue_set_order_hash: calculateBlindReviewQueueSetOrderHash(queue),
    });
    expect(Object.isFrozen(expected)).toBe(true);
    expect(() => buildHumanConfirmationReceipt({
      expected: structuredClone(expected),
      command: humanConfirmationCommandFor(expected),
    })).toThrow(/validated|authoritative|검증|artifact chain/i);
    expect(() => createHumanConfirmationExpectedContext({
      benchmarkPack: structuredClone(benchmarkPack),
      queue,
      preReviewReceipt,
      provisionalMemo,
    })).toThrow(/validated|authoritative|검증|Benchmark/i);
  }, 15_000);

  it("ACCEPT_ALL은 pre-review proposal을 그대로 확인하고 다음 의사결정 단계만 연다", async () => {
    const { expected } = await task14Authority({
      deterministicFailures: ["H-007:A"],
    });
    const command = humanConfirmationCommandFor(expected);
    const receipt = buildHumanConfirmationReceipt({ expected, command });

    expect(receipt).toMatchObject({
      schema_version: "human-confirmation-receipt-v1",
      artifact_kind: "HUMAN_CONFIRMATION_RECEIPT",
      synthetic: true,
      action: "ACCEPT_ALL",
      human_confirmation_status: "HUMAN_CONFIRMED",
      human_confirmed: true,
      provisional_recommendation_status: "PRESERVED_FOR_HUMAN_CONFIRMED_DECISION",
      provisional_memo_status: "BOUND_FOR_HUMAN_CONFIRMED_DECISION",
      next_step: "HUMAN_CONFIRMED_DECISION_ELIGIBLE",
      decision_status: "NOT_CREATED",
      baseline_version: null,
    });
    expect(receipt.items.map((item) => item.item_id)).toEqual(expected.queue_item_ids);
    expect(receipt.items.some((item) => item.final_decision === "CONFIRMED_FAIL")).toBe(true);
    expect(receipt.total_edit_duration_ms).toBe(0);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(() => assertValidatedHumanConfirmationReceipt(receipt)).not.toThrow();
    expect(() => assertValidatedHumanConfirmationReceipt(structuredClone(receipt)))
      .toThrow(/검증|build|command|receipt/i);
    expect(JSON.stringify(receipt)).not.toMatch(
      /approved_candidate|selected_candidate|baseline_id|deployment|purchase|contract/i,
    );
  }, 15_000);

  it("CONFIRM_WITH_EDITS는 최소 한 사람 판정 변경을 권위 있게 확인하고 AI proposal을 무효화한다", async () => {
    const { benchmarkPack, expected } = await task14Authority();
    const command = humanConfirmationCommandFor(expected, {
      action: "CONFIRM_WITH_EDITS",
    });
    const editedIndex = expected.proposal_items.findIndex(
      (item) => item.expected_final_decision === "PASS",
    );
    expect(editedIndex).toBeGreaterThanOrEqual(0);
    const proposed = expected.proposal_items[editedIndex];
    command.items[editedIndex] = {
      ...command.items[editedIndex],
      final_decision: "CONFIRMED_FAIL",
      rationale:
        "The human reviewer reached a different final judgment from the blinded evidence.",
      proposal_resolution: "EDITED",
      edit_duration_ms: 2_500,
    };

    const receipt = buildHumanConfirmationReceipt({ expected, command });

    expect(receipt).toMatchObject({
      action: "CONFIRM_WITH_EDITS",
      human_confirmation_status: "HUMAN_CONFIRMED",
      human_confirmed: true,
      provisional_recommendation_status: "INVALIDATED",
      provisional_memo_status: "INVALIDATED",
      next_step: "HUMAN_CONFIRMED_DECISION_ELIGIBLE",
      decision_status: "NOT_CREATED",
      baseline_version: null,
      total_edit_duration_ms: 2_500,
    });
    expect(receipt.items[editedIndex]).toMatchObject({
      item_id: proposed.item_id,
      final_decision: "CONFIRMED_FAIL",
      proposal_resolution: "EDITED",
      edit_duration_ms: 2_500,
    });

    const confirmationDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "human-confirm-with-edits-"),
    ));
    const persisted = await persistHumanConfirmationReceipt({
      outputDirectory: confirmationDirectory,
      receipt,
    });
    const context = await loadPersistedHumanConfirmedDecisionContext({
      recordedBenchmarkPack: benchmarkPack,
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      humanConfirmationReceiptPath: persisted.path,
      humanConfirmationExpectedContext: expected,
    });
    const queueItem = benchmarkPack.blind_review_queue.items[editedIndex];
    const evidenceCase = benchmarkPack.judge_evidence_pack.cases.find(
      (item) => item.case_id === queueItem.case_id,
    );
    const candidateId =
      evidenceCase?.private_mapping.label_to_candidate[queueItem.blind_label];
    expect(candidateId).toMatch(/^[ABC]$/);
    expect(
      context.aggregation.candidates.find(
        (candidate) => candidate.candidate_id === candidateId,
      )?.human_confirmed_failed_case_ids,
    ).toContain(queueItem.case_id);
    expect(context.human_review.total_edit_duration_ms).toBe(2_500);
  }, 15_000);

  it("CONFIRM_WITH_EDITS는 실제 decision/rationale 변경 없는 편집 표시를 거부한다", async () => {
    const { expected } = await task14Authority();
    const withoutEditedItem = humanConfirmationCommandFor(expected, {
      action: "CONFIRM_WITH_EDITS",
    });
    expect(() => buildHumanConfirmationReceipt({
      expected,
      command: withoutEditedItem,
    })).toThrow(/CONFIRM_WITH_EDITS|EDITED|변경/i);

    const correctedReplyOnly = humanConfirmationCommandFor(expected, {
      action: "CONFIRM_WITH_EDITS",
    });
    correctedReplyOnly.items[0] = {
      ...correctedReplyOnly.items[0],
      proposal_resolution: "EDITED",
      corrected_reply: "This reply follows the active synthetic policy.",
      edit_duration_ms: 700,
    };
    expect(() => buildHumanConfirmationReceipt({
      expected,
      command: correctedReplyOnly,
    })).toThrow(/decision|rationale|판정|근거|변경/i);

    const whitespaceOnlyRationale = humanConfirmationCommandFor(expected, {
      action: "CONFIRM_WITH_EDITS",
    });
    whitespaceOnlyRationale.items[0] = {
      ...whitespaceOnlyRationale.items[0],
      rationale: `  ${whitespaceOnlyRationale.items[0].rationale}  `,
      proposal_resolution: "EDITED",
      edit_duration_ms: 500,
    };
    expect(() => buildHumanConfirmationReceipt({
      expected,
      command: whitespaceOnlyRationale,
    })).toThrow(/decision|rationale|판정|근거|변경/i);
  }, 15_000);

  it("ACCEPTED 표시로 proposal 변경을 숨길 수 없고 ACCEPT_ALL에는 편집을 넣을 수 없다", async () => {
    const { expected } = await task14Authority();
    const changedButAccepted = humanConfirmationCommandFor(expected);
    changedButAccepted.items[0] = {
      ...changedButAccepted.items[0],
      final_decision: "CONFIRMED_FAIL",
      rationale: "A different human rationale.",
    };
    expect(() => buildHumanConfirmationReceipt({
      expected,
      command: changedButAccepted,
    })).toThrow(/ACCEPTED|proposal|정확|authoritative/i);

    const editedAcceptAll = humanConfirmationCommandFor(expected);
    editedAcceptAll.items[0] = {
      ...editedAcceptAll.items[0],
      proposal_resolution: "EDITED",
      rationale: "The owner changed the rationale.",
      edit_duration_ms: 500,
    };
    expect(() => buildHumanConfirmationReceipt({
      expected,
      command: editedAcceptAll,
    })).toThrow(/ACCEPT_ALL|EDITED|편집/i);
  }, 15_000);

  it("REQUEST_CHANGES와 REJECT는 recommendation·Memo를 무효화하고 기준선을 만들지 않는다", async () => {
    const { expected } = await task14Authority();
    const requestChanges = humanConfirmationCommandFor(expected, {
      action: "REQUEST_CHANGES",
    });
    requestChanges.items[0] = {
      ...requestChanges.items[0],
      final_decision: "CONFIRMED_FAIL",
      rationale: "The owner changed the proposal after blind evidence review.",
      proposal_resolution: "EDITED",
      corrected_reply: "This synthetic reply follows the active policy.",
      edit_duration_ms: 2_500,
    };
    const changed = buildHumanConfirmationReceipt({
      expected,
      command: requestChanges,
    });
    const rejected = buildHumanConfirmationReceipt({
      expected,
      command: humanConfirmationCommandFor(expected, {
        action: "REJECT",
        confirmed_at: "2026-07-17T03:11:00.000Z",
      }),
    });

    expect(changed).toMatchObject({
      human_confirmation_status: "CHANGES_REQUESTED",
      human_confirmed: false,
      provisional_recommendation_status: "INVALIDATED",
      provisional_memo_status: "INVALIDATED",
      next_step: "REGENERATION_REQUIRED",
      decision_status: "NOT_CREATED",
      baseline_version: null,
      total_edit_duration_ms: 2_500,
    });
    expect(rejected).toMatchObject({
      human_confirmation_status: "REJECTED",
      human_confirmed: false,
      provisional_recommendation_status: "INVALIDATED",
      provisional_memo_status: "INVALIDATED",
      next_step: "CONFIRMATION_REJECTED",
      decision_status: "NOT_CREATED",
      baseline_version: null,
    });
  }, 15_000);

  it("stale source·queue 재정렬·누락·중복·duration 위조를 거부한다", async () => {
    const { expected } = await task14Authority();
    const stale = humanConfirmationCommandFor(expected);
    stale.expected_ai_pre_review_receipt_hash = "f".repeat(64);
    expect(() => buildHumanConfirmationReceipt({ expected, command: stale }))
      .toThrow(/hash|source|일치|AI pre-review/i);

    const reordered = humanConfirmationCommandFor(expected);
    [reordered.items[0], reordered.items[1]] = [
      reordered.items[1],
      reordered.items[0],
    ];
    expect(() => buildHumanConfirmationReceipt({ expected, command: reordered }))
      .toThrow(/queue|item|순서|identity|일치/i);

    const missing = humanConfirmationCommandFor(expected);
    missing.items.pop();
    expect(() => buildHumanConfirmationReceipt({ expected, command: missing }))
      .toThrow(/queue item 수|기대 목록|일치/i);

    const duplicate = humanConfirmationCommandFor(expected);
    duplicate.items[1] = { ...duplicate.items[0] };
    expect(() => buildHumanConfirmationReceipt({ expected, command: duplicate }))
      .toThrow(/queue|item|순서|identity|중복|일치/i);

    const invalidDuration = humanConfirmationCommandFor(expected);
    invalidDuration.items[0].review_duration_ms = Number.NaN;
    expect(() => buildHumanConfirmationReceipt({
      expected,
      command: invalidDuration,
    })).toThrow(/duration|finite|관측/i);

    const overflowingDuration = humanConfirmationCommandFor(expected);
    overflowingDuration.items.forEach((item) => {
      item.review_duration_ms = Number.MAX_SAFE_INTEGER;
    });
    expect(() => buildHumanConfirmationReceipt({
      expected,
      command: overflowingDuration,
    })).toThrow(/duration|합계|safe integer|범위/i);
  }, 15_000);

  it("accessor가 검증 뒤 confirmation item 배열·결정·시간을 바꾸는 TOCTOU를 거부한다", async () => {
    const { expected } = await task14Authority();
    const command = humanConfirmationCommandFor(expected);
    const originalItems = command.items;
    let reads = 0;
    Object.defineProperty(command, "items", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return reads <= 2 ? originalItems : [];
      },
    });

    expect(() => buildHumanConfirmationReceipt({ expected, command }))
      .toThrow(/accessor|getter|data property|plain data|TOCTOU|속성/i);

    const itemAccessor = humanConfirmationCommandFor(expected);
    const first = itemAccessor.items[0];
    Object.defineProperty(first, "review_duration_ms", {
      enumerable: true,
      configurable: true,
      get: () => 1_000,
    });
    expect(() => buildHumanConfirmationReceipt({
      expected,
      command: itemAccessor,
    })).toThrow(/accessor|getter|data property|plain data|TOCTOU|속성/i);
  }, 15_000);

  it("거대한 sparse confirmation item 배열을 할당 전에 거부한다", async () => {
    const { expected } = await task14Authority();
    const command = humanConfirmationCommandFor(expected);
    const hugeItems: HumanConfirmationCommand["items"] = [];
    hugeItems.length = 1_000_000;
    command.items = hugeItems;

    expect(() => buildHumanConfirmationReceipt({ expected, command }))
      .toThrow(/length|최대|범위|plain data/i);
  }, 15_000);

  it("canonical 0600 write-once와 clone·replay·동시성·conflict·symlink·mode 방어를 보장한다", async () => {
    const { expected } = await task14Authority();
    const receipt = buildHumanConfirmationReceipt({
      expected,
      command: humanConfirmationCommandFor(expected),
    });
    const outputDirectory = await secureTempDirectory("human-confirmation-");
    const persisted = await persistHumanConfirmationReceipt({
      outputDirectory,
      receipt,
    });
    const paths = createHumanConfirmationReceiptPaths({
      outputDirectory,
      confirmationId: receipt.confirmation_id,
      payloadSha256: sha256CanonicalJson(receipt),
    });
    expect((await lstat(paths.receiptPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.claimPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(persisted.path, "utf8"))).toEqual({
      payload_sha256: sha256CanonicalJson(receipt),
      payload: receipt,
    });
    const loaded = await loadHumanConfirmationReceipt({
      path: persisted.path,
      expected,
    });
    expect(loaded).toEqual(receipt);
    expect(Object.isFrozen(loaded)).toBe(true);
    const receiptHardLink = join(
      outputDirectory,
      "human-confirmation-hard-link",
    );
    await link(paths.receiptPath, receiptHardLink);
    await expect(loadHumanConfirmationReceipt({
      path: persisted.path,
      expected,
    })).rejects.toThrow(/nlink|hard.?link|regular|0600/i);
    await unlink(receiptHardLink);
    const movedConfirmationDirectory = `${paths.confirmationDirectory}-real`;
    await rename(paths.confirmationDirectory, movedConfirmationDirectory);
    await symlink(movedConfirmationDirectory, paths.confirmationDirectory);
    await expect(loadHumanConfirmationReceipt({
      path: persisted.path,
      expected,
    })).rejects.toThrow(/symlink|directory|디렉터리|safe|검증/i);
    await unlink(paths.confirmationDirectory);
    await rename(movedConfirmationDirectory, paths.confirmationDirectory);
    await unlink(paths.claimPath);
    await expect(loadHumanConfirmationReceipt({
      path: persisted.path,
      expected,
    })).rejects.toThrow(/claim|누락|safe|검증/i);
    await expect(persistHumanConfirmationReceipt({ outputDirectory, receipt }))
      .rejects.toThrow(/replay|이미|already/i);

    const cloneDirectory = await secureTempDirectory("human-confirmation-clone-");
    await expect(persistHumanConfirmationReceipt({
      outputDirectory: cloneDirectory,
      receipt: structuredClone(receipt),
    })).rejects.toThrow(/검증|build|receipt/i);
    expect(await readdir(cloneDirectory)).toEqual([]);

    const raceDirectory = await secureTempDirectory("human-confirmation-race-");
    const raceReceipt = buildHumanConfirmationReceipt({
      expected,
      command: humanConfirmationCommandFor(expected),
    });
    const race = await Promise.allSettled(Array.from({ length: 6 }, () => (
      persistHumanConfirmationReceipt({
        outputDirectory: raceDirectory,
        receipt: raceReceipt,
      })
    )));
    expect(race.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((item) => item.status === "rejected")).toHaveLength(5);

    const conflictDirectory = await secureTempDirectory("human-confirmation-conflict-");
    const first = buildHumanConfirmationReceipt({
      expected,
      command: humanConfirmationCommandFor(expected),
    });
    const second = buildHumanConfirmationReceipt({
      expected,
      command: humanConfirmationCommandFor(expected, {
        action: "REJECT",
        confirmed_at: "2026-07-17T03:12:00.000Z",
      }),
    });
    expect(first.confirmation_id).toBe(second.confirmation_id);
    await persistHumanConfirmationReceipt({
      outputDirectory: conflictDirectory,
      receipt: first,
    });
    await expect(persistHumanConfirmationReceipt({
      outputDirectory: conflictDirectory,
      receipt: second,
    })).rejects.toThrow(/claim|confirmation|일치|다른/i);

    const symlinkDirectory = await secureTempDirectory("human-confirmation-symlink-");
    const symlinkReceipt = buildHumanConfirmationReceipt({
      expected,
      command: humanConfirmationCommandFor(expected),
    });
    const directorySymlinkRoot = await secureTempDirectory(
      "human-confirmation-directory-symlink-",
    );
    const directorySymlinkTarget = await secureTempDirectory(
      "human-confirmation-outside-",
    );
    const directorySymlinkPaths = createHumanConfirmationReceiptPaths({
      outputDirectory: directorySymlinkRoot,
      confirmationId: symlinkReceipt.confirmation_id,
      payloadSha256: sha256CanonicalJson(symlinkReceipt),
    });
    await symlink(
      directorySymlinkTarget,
      directorySymlinkPaths.confirmationDirectory,
    );
    await expect(persistHumanConfirmationReceipt({
      outputDirectory: directorySymlinkRoot,
      receipt: symlinkReceipt,
    })).rejects.toThrow(/symlink|directory|디렉터리|safe|검증/i);
    expect(await readdir(directorySymlinkTarget)).toEqual([]);

    const claimSymlinkReceipt = buildHumanConfirmationReceipt({
      expected,
      command: humanConfirmationCommandFor(expected),
    });
    const symlinkPaths = createHumanConfirmationReceiptPaths({
      outputDirectory: symlinkDirectory,
      confirmationId: claimSymlinkReceipt.confirmation_id,
      payloadSha256: sha256CanonicalJson(claimSymlinkReceipt),
    });
    await mkdir(symlinkPaths.confirmationDirectory, { recursive: true });
    const target = join(symlinkDirectory, "attacker.json");
    await writeFile(target, "{}\n", "utf8");
    await symlink(target, symlinkPaths.claimPath);
    await expect(persistHumanConfirmationReceipt({
      outputDirectory: symlinkDirectory,
      receipt: claimSymlinkReceipt,
    })).rejects.toThrow(/symlink|claim|검증|일치/i);

    const modeDirectory = await secureTempDirectory("human-confirmation-mode-");
    const modeReceipt = buildHumanConfirmationReceipt({
      expected,
      command: humanConfirmationCommandFor(expected),
    });
    const modePersisted = await persistHumanConfirmationReceipt({
      outputDirectory: modeDirectory,
      receipt: modeReceipt,
    });
    await chmod(modePersisted.path, 0o644);
    await expect(loadHumanConfirmationReceipt({
      path: modePersisted.path,
      expected,
    })).rejects.toThrow(/mode|0600|record|검증/i);
    const retry = buildHumanConfirmationReceipt({
      expected,
      command: humanConfirmationCommandFor(expected),
    });
    await expect(persistHumanConfirmationReceipt({
      outputDirectory: modeDirectory,
      receipt: retry,
    })).rejects.toThrow(/mode|0600|record|검증|일치/i);
  }, 30_000);
});

function memoAdapterResult(
  request: FinalDecisionMemoAdapterRequest,
  output: FinalDecisionMemoAdapterOutput,
): FinalDecisionMemoAdapterResult {
  const usage: TokenUsage = {
    inputTokens: 100,
    cachedInputTokens: 10,
    cacheWriteTokens: 0,
    outputTokens: 20,
    reasoningTokens: 5,
    totalTokens: 120,
  };
  const usageCost = calculateUsageCost(
    usage,
    FINAL_DECISION_MEMO_PRICING_SNAPSHOT,
  )!;
  return {
    output,
    run_evidence: {
      schema_version: "final-decision-memo-run-evidence-v1",
      adapter_request_hash: sha256CanonicalJson(request),
      request_contract_hash:
        sha256CanonicalJson(FINAL_DECISION_MEMO_OPENAI_REQUEST_CONTRACT),
      model_requested_id: "gpt-5.6-sol",
      model_reported_id: "gpt-5.6-sol",
      service_tier_requested: "default",
      service_tier_reported: "default",
      strict_output_schema_hash:
        sha256CanonicalJson(FINAL_DECISION_MEMO_OUTPUT_SCHEMA),
      pricing_snapshot_hash:
        sha256CanonicalJson(FINAL_DECISION_MEMO_PRICING_SNAPSHOT),
      store_requested: false,
      claim_evidence_refs: buildFinalDecisionMemoClaimEvidenceRefs(request),
      attempts: [{
        attempt_number: 1,
        request_disposition: "RESPONSE_RECEIVED",
        status: "COMPLETE",
        retry_eligible: false,
        response_id: "resp_memo_fixture",
        refusal: null,
        incomplete_reason: null,
        error: null,
        latency_ms: 25,
        usage,
        usage_cost: usageCost,
      }],
      total_latency_ms: 25,
      total_usage: usage,
      total_cost_usd: usageCost.totalCostUsd,
    },
  };
}

function finalConfirmationFor(
  context: HumanConfirmedDecisionContext,
  memo: FinalDecisionMemo,
  action: "CONFIRM" | "REQUEST_CHANGES" = "CONFIRM",
): FinalDecisionConfirmationReceipt {
  return buildFinalDecisionConfirmationReceipt({
    context,
    finalMemo: memo,
    command: {
      schema_version: "final-decision-confirmation-command-v1",
      action,
      actor_label: "Challenge owner",
      expected_recorded_benchmark_pack_hash:
        context.recorded_benchmark_pack_hash,
      expected_human_confirmation_receipt_hash:
        context.human_confirmation_receipt_hash,
      expected_aggregation_hash: sha256CanonicalJson(context.aggregation),
      expected_final_decision_memo_hash: sha256CanonicalJson(memo),
      expected_adapter_run_evidence_hash:
        memo.adapter_run_evidence_hash,
      expected_selection_hash: sha256CanonicalJson({
        schema_version: "final-decision-selection-binding-v1",
        selection_action: memo.selection_action,
        selected_candidate_id: memo.selected_candidate_id,
        selection_rationale: memo.selection_rationale,
        decided_by: memo.decided_by,
        decided_at: memo.decided_at,
      }),
      confirmed_at: new Date(
        Date.parse(memo.decided_at) + 60_000,
      ).toISOString(),
    },
  });
}

/**
 * process restart E2E가 late workflow state를 raw clone이 아닌 각 persisted
 * authority artifact의 loader로 복원하도록 만드는 fixture입니다.
 */
export async function createPersistedRecordedWorkflowControllerStateFixture({
  outputDirectory,
  lockedChallengePack,
  recordedBenchmarkPack,
  preReviewReceipt,
  provisionalDecisionMemo,
}: {
  readonly outputDirectory: string;
  readonly lockedChallengePack: typeof LOCKED_CHALLENGE_FIXTURE;
  readonly recordedBenchmarkPack: RecordedBenchmarkPack;
  readonly preReviewReceipt: AiPreReviewReceipt;
  readonly provisionalDecisionMemo: ProvisionalDecisionMemo;
}) {
  const expected = createHumanConfirmationExpectedContext({
    benchmarkPack: recordedBenchmarkPack,
    queue: recordedBenchmarkPack.blind_review_queue,
    preReviewReceipt,
    provisionalMemo: provisionalDecisionMemo,
  });
  const builtHumanConfirmationReceipt = buildHumanConfirmationReceipt({
    expected,
    command: humanConfirmationCommandFor(expected),
  });
  const persistedHumanConfirmation = await persistHumanConfirmationReceipt({
    outputDirectory,
    receipt: builtHumanConfirmationReceipt,
  });
  const humanConfirmationReceipt = await loadHumanConfirmationReceipt({
    path: persistedHumanConfirmation.path,
    expected,
  });
  const humanConfirmedDecisionContext =
    await loadPersistedHumanConfirmedDecisionContext({
      recordedBenchmarkPack,
      lockedChallengePack,
      humanConfirmationReceiptPath: persistedHumanConfirmation.path,
      humanConfirmationExpectedContext: expected,
    });
  const selection: DecisionSelectionCommand = {
    schema_version: "decision-selection-command-v1",
    action: "SELECT_CANDIDATE",
    candidate_id: "A",
    rationale: "Select Candidate A from the recorded human-confirmed evidence.",
    actor_label: "Challenge owner",
    expected_recorded_benchmark_pack_hash:
      humanConfirmedDecisionContext.recorded_benchmark_pack_hash,
    expected_human_confirmation_receipt_hash:
      humanConfirmedDecisionContext.human_confirmation_receipt_hash,
    expected_aggregation_hash:
      sha256CanonicalJson(humanConfirmedDecisionContext.aggregation),
    decided_at: "2026-07-18T00:10:00.000Z",
  };
  const builtFinalDecisionMemo = await runFinalDecisionMemo({
    context: humanConfirmedDecisionContext,
    selection,
    adapter: {
      invoke: async (request) => memoAdapterResult(
        request,
        buildFinalDecisionMemoRequiredOutput(request),
      ),
    },
  });
  const persistedFinalMemo = await persistFinalDecisionMemo({
    outputDirectory,
    memo: builtFinalDecisionMemo,
  });
  const finalDecisionMemo = await loadFinalDecisionMemo({
    path: persistedFinalMemo.path,
    context: humanConfirmedDecisionContext,
  });
  const builtFinalConfirmation = finalConfirmationFor(
    humanConfirmedDecisionContext,
    finalDecisionMemo,
  );
  const persistedFinalConfirmation =
    await persistFinalDecisionConfirmationReceipt({
      outputDirectory,
      receipt: builtFinalConfirmation,
    });
  const finalDecisionConfirmationReceipt =
    await loadFinalDecisionConfirmationReceipt({
      path: persistedFinalConfirmation.path,
      context: humanConfirmedDecisionContext,
      finalMemo: finalDecisionMemo,
    });
  const builtDecisionAuthorityRecord = buildDecisionAuthorityRecord({
    context: humanConfirmedDecisionContext,
    finalMemo: finalDecisionMemo,
    finalConfirmationReceipt: finalDecisionConfirmationReceipt,
    recordedBenchmarkPack,
  });
  const persistedDecisionAuthorityRecord = await persistDecisionAuthorityRecord({
    outputDirectory,
    record: builtDecisionAuthorityRecord,
    context: humanConfirmedDecisionContext,
    recordedBenchmarkPack,
    finalMemoPath: persistedFinalMemo.path,
    finalConfirmationReceiptPath: persistedFinalConfirmation.path,
  });
  const decisionAuthorityRecord = await loadDecisionAuthorityRecord({
    path: persistedDecisionAuthorityRecord.path,
    context: humanConfirmedDecisionContext,
    finalMemoPath: persistedFinalMemo.path,
    finalConfirmationReceiptPath: persistedFinalConfirmation.path,
    recordedBenchmarkPack,
  });
  return Object.freeze({
    human: Object.freeze({
      humanConfirmationReceipt,
      humanConfirmationReceiptPath: persistedHumanConfirmation.path,
      humanConfirmedDecisionContext,
    }),
    memo: Object.freeze({
      humanConfirmationReceipt,
      humanConfirmationReceiptPath: persistedHumanConfirmation.path,
      humanConfirmedDecisionContext,
      finalDecisionMemo,
      finalDecisionMemoPath: persistedFinalMemo.path,
    }),
    baseline: Object.freeze({
      humanConfirmationReceipt,
      humanConfirmationReceiptPath: persistedHumanConfirmation.path,
      humanConfirmedDecisionContext,
      finalDecisionMemo,
      finalDecisionMemoPath: persistedFinalMemo.path,
      finalDecisionConfirmationReceipt,
      finalDecisionConfirmationReceiptPath: persistedFinalConfirmation.path,
      decisionAuthorityRecord,
      decisionAuthorityRecordPath: persistedDecisionAuthorityRecord.path,
    }),
  });
}

if (registerReviewQueueTests) describe("사람 확인 이후 Decision Memo와 원자적 기준선 결정", () => {
  it("persisted Human receipt만으로 unpersisted·persist-only·clone Benchmark를 결정 context 권위로 승격하지 않는다", async () => {
    const authority = await task14Authority();
    const humanReceipt = buildHumanConfirmationReceipt({
      expected: authority.expected,
      command: humanConfirmationCommandFor(authority.expected),
    });
    const outputDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "decision-context-source-chain-"),
    ));
    const humanReceiptPersisted = await persistHumanConfirmationReceipt({
      outputDirectory,
      receipt: humanReceipt,
    });
    const loadContextFor = (
      recordedBenchmarkPack: typeof authority.benchmarkPack,
    ) => loadPersistedHumanConfirmedDecisionContext({
      recordedBenchmarkPack,
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      humanConfirmationReceiptPath: humanReceiptPersisted.path,
      humanConfirmationExpectedContext: authority.expected,
    });
    const unpersistedBuilt = buildRecordedBenchmarkPack({
      benchmarkPack:
        authority.benchmarkPack.benchmark_execution_pack,
      judgeEvidencePack:
        authority.benchmarkPack.judge_evidence_pack,
      blindReviewQueue:
        authority.benchmarkPack.blind_review_queue,
    });

    await expect(loadContextFor(unpersistedBuilt))
      .rejects.toThrow(/source|reload|load|저장|권위/i);

    await persistRecordedBenchmarkPack({
      outputDirectory,
      pack: unpersistedBuilt,
    });
    await expect(loadContextFor(unpersistedBuilt))
      .rejects.toThrow(/source|reload|load|저장|권위/i);

    await expect(loadContextFor(
      structuredClone(authority.benchmarkPack),
    )).rejects.toThrow(/source|reload|load|저장|권위|build|검증/i);

    const canonicalContext = await loadContextFor(
      authority.benchmarkPack,
    );
    expect(() => assertPersistedHumanConfirmedDecisionContext(
      canonicalContext,
    )).not.toThrow();
  }, 15_000);

  it("Final Memo는 retry 가능한 첫 실패 뒤 terminal COMPLETE 한 번만 허용한다", async () => {
    const authority = await task14Authority();
    const humanReceipt = buildHumanConfirmationReceipt({
      expected: authority.expected,
      command: humanConfirmationCommandFor(authority.expected),
    });
    const context = buildHumanConfirmedDecisionContext({
      recordedBenchmarkPack: authority.benchmarkPack,
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      humanConfirmationReceipt: humanReceipt,
    });
    expect(() => assertPersistedHumanConfirmedDecisionContext(context)).toThrow(
      /persisted|source|Human confirmation|context/i,
    );
    const selection: DecisionSelectionCommand = {
      schema_version: "decision-selection-command-v1",
      action: "SELECT_CANDIDATE",
      candidate_id: "A",
      rationale: "Select the least-complex sufficient candidate.",
      actor_label: "Challenge owner",
      expected_recorded_benchmark_pack_hash:
        context.recorded_benchmark_pack_hash,
      expected_human_confirmation_receipt_hash:
        context.human_confirmation_receipt_hash,
      expected_aggregation_hash: sha256CanonicalJson(context.aggregation),
      decided_at: "2026-07-17T03:14:00.000Z",
    };
    const memo = await runFinalDecisionMemo({
      context,
      selection,
      adapter: {
        invoke: async (request) => {
          const result = structuredClone(memoAdapterResult(request, {
            selected_candidate_id: "A",
            decision_summary: "Candidate A is sufficient and least complex.",
            rejected_alternatives: [
              { candidate_id: "B", reason: "More complex." },
              { candidate_id: "C", reason: "More complex." },
            ],
            known_limitations: ["The Benchmark uses synthetic data."],
            next_poc_scope: "Run a private customer PoC.",
            procurement_handoff: "Use the existing procurement process.",
            external_action_statement:
              "No purchase, contract, deployment, or rollback was executed.",
          })) as any;
          const complete = result.run_evidence.attempts[0];
          complete.attempt_number = 2;
          complete.retry_eligible = false;
          result.run_evidence.attempts = [{
            attempt_number: 1,
            request_disposition: "RESPONSE_ERROR_RECEIVED",
            status: "REQUEST_ERROR",
            retry_eligible: true,
            response_id: null,
            refusal: null,
            incomplete_reason: null,
            error: "Transient provider request error.",
            latency_ms: 10,
            usage: null,
            usage_cost: null,
          }, complete];
          result.run_evidence.total_latency_ms = 35;
          return result;
        },
      },
    });
    expect(memo.adapter_run_evidence.attempts).toHaveLength(2);
    expect(memo.adapter_run_evidence.attempts[0]).toMatchObject({
      status: "REQUEST_ERROR",
      retry_eligible: true,
    });
    expect(memo.adapter_run_evidence.attempts[1]).toMatchObject({
      status: "COMPLETE",
      retry_eligible: false,
    });
  });

  it("Final Memo는 불가능한 attempt 상태 조합과 성공 뒤 retry를 차단한다", async () => {
    const authority = await task14Authority();
    const humanReceipt = buildHumanConfirmationReceipt({
      expected: authority.expected,
      command: humanConfirmationCommandFor(authority.expected),
    });
    const context = buildHumanConfirmedDecisionContext({
      recordedBenchmarkPack: authority.benchmarkPack,
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      humanConfirmationReceipt: humanReceipt,
    });
    const selection: DecisionSelectionCommand = {
      schema_version: "decision-selection-command-v1",
      action: "SELECT_CANDIDATE",
      candidate_id: "A",
      rationale: "Select Candidate A.",
      actor_label: "Challenge owner",
      expected_recorded_benchmark_pack_hash:
        context.recorded_benchmark_pack_hash,
      expected_human_confirmation_receipt_hash:
        context.human_confirmation_receipt_hash,
      expected_aggregation_hash: sha256CanonicalJson(context.aggregation),
      decided_at: "2026-07-17T03:14:30.000Z",
    };
    const output: FinalDecisionMemoAdapterOutput = {
      selected_candidate_id: "A",
      decision_summary: "Candidate A is sufficient and least complex.",
      rejected_alternatives: [
        { candidate_id: "B", reason: "More complex." },
        { candidate_id: "C", reason: "More complex." },
      ],
      known_limitations: ["The Benchmark uses synthetic data."],
      next_poc_scope: "Run a private customer PoC.",
      procurement_handoff: "Use the existing procurement process.",
      external_action_statement:
        "No purchase, contract, deployment, or rollback was executed.",
    };
    const attacks: Array<(result: any) => void> = [
      (result) => {
        result.run_evidence.service_tier_reported = "priority";
      },
      (result) => {
        result.run_evidence.attempts[0].request_disposition = "NOT_SENT";
      },
      (result) => {
        result.run_evidence.attempts[0].refusal =
          "A COMPLETE attempt cannot also be a refusal.";
      },
      (result) => {
        result.run_evidence.attempts[0].retry_eligible = true;
      },
      (result) => {
        const first = result.run_evidence.attempts[0];
        first.retry_eligible = true;
        result.run_evidence.attempts.push({
          ...structuredClone(first),
          attempt_number: 2,
          retry_eligible: false,
          response_id: "resp_after_success",
        });
        result.run_evidence.total_latency_ms = 50;
        result.run_evidence.total_usage = {
          inputTokens: 200,
          cachedInputTokens: 20,
          cacheWriteTokens: 0,
          outputTokens: 40,
          reasoningTokens: 10,
          totalTokens: 240,
        };
        result.run_evidence.total_cost_usd *= 2;
      },
      (result) => {
        const complete = structuredClone(result.run_evidence.attempts[0]);
        complete.attempt_number = 2;
        result.run_evidence.attempts = [{
          attempt_number: 1,
          request_disposition: "RESPONSE_ERROR_RECEIVED",
          status: "REQUEST_ERROR",
          retry_eligible: false,
          response_id: null,
          refusal: null,
          incomplete_reason: null,
          error: "Transient provider request error.",
          latency_ms: 10,
          usage: null,
          usage_cost: null,
        }, complete];
        result.run_evidence.total_latency_ms = 35;
      },
      ...(["REFUSED", "INCOMPLETE", "FAILED"] as const).map((status) => (
        (result: any) => {
          const first = result.run_evidence.attempts[0];
          const complete = structuredClone(first);
          complete.attempt_number = 2;
          first.status = status;
          first.retry_eligible = true;
          first.refusal = status === "REFUSED"
            ? "Terminal refusal."
            : null;
          first.incomplete_reason = status === "INCOMPLETE"
            ? "max_output_tokens"
            : null;
          first.error = status === "FAILED"
            ? "Terminal provider failure."
            : null;
          result.run_evidence.attempts = [first, complete];
          result.run_evidence.total_latency_ms = 50;
          result.run_evidence.total_usage = {
            inputTokens: 200,
            cachedInputTokens: 20,
            cacheWriteTokens: 0,
            outputTokens: 40,
            reasoningTokens: 10,
            totalTokens: 240,
          };
          result.run_evidence.total_cost_usd *= 2;
        }
      )),
    ];
    for (const mutate of attacks) {
      await expect(runFinalDecisionMemo({
        context,
        selection,
        adapter: {
          invoke: async (request) => {
            const result = structuredClone(
              memoAdapterResult(request, output),
            ) as any;
            mutate(result);
            return result;
          },
        },
      })).rejects.toThrow(
        /status|disposition|attempt|retry|terminal|조합|순서|request|model|pricing|계약/i,
      );
    }
  });

  it("실제 권위 체인을 unblind·dedupe하고 A를 포함한 eligible 후보의 기준선을 만들 수 있다", async () => {
    const authority = await task14Authority();
    const humanReceipt = buildHumanConfirmationReceipt({
      expected: authority.expected,
      command: humanConfirmationCommandFor(authority.expected),
    });
    const context = buildHumanConfirmedDecisionContext({
      recordedBenchmarkPack: authority.benchmarkPack,
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      humanConfirmationReceipt: humanReceipt,
    });

    expect(context.aggregation).toMatchObject({
      decision_status: "RECOMMENDATION_READY",
      recommended_candidate_id: "A",
      eligible_candidate_ids: ["A", "B", "C"],
    });
    expect(context.human_review).toMatchObject({
      reviewed_items: authority.queue.items.length,
      remaining_items: 0,
    });

    const selection: DecisionSelectionCommand = {
      schema_version: "decision-selection-command-v1",
      action: "SELECT_CANDIDATE",
      candidate_id: "A",
      rationale: "Candidate A is sufficient and uniquely least complex.",
      actor_label: "Challenge owner",
      expected_recorded_benchmark_pack_hash:
        sha256CanonicalJson(authority.benchmarkPack),
      expected_human_confirmation_receipt_hash:
        sha256CanonicalJson(humanReceipt),
      expected_aggregation_hash: sha256CanonicalJson(context.aggregation),
      decided_at: "2026-07-17T03:15:00.000Z",
    };
    const adapter: FinalDecisionMemoAdapter = {
      invoke: async (request) => memoAdapterResult(request, {
        selected_candidate_id: request.selected_candidate_id,
        decision_summary: "Candidate A is sufficient and uniquely least complex.",
        rejected_alternatives: [
          { candidate_id: "B", reason: "Sufficient but more complex." },
          { candidate_id: "C", reason: "Sufficient but more complex." },
        ],
        known_limitations: [
          "The Benchmark uses synthetic data and a bounded hidden sample.",
          "The auxiliary Judge may retain self and position bias.",
        ],
        next_poc_scope: "Validate the selected configuration in a private customer PoC.",
        procurement_handoff:
          "Hand the evidence pack to the existing procurement process.",
        external_action_statement:
          "No purchase, contract, deployment, or rollback was executed.",
      }),
    };
    const memo = await runFinalDecisionMemo({ context, selection, adapter });
    expect(memo.adapter_run_evidence).toMatchObject({
      model_requested_id: "gpt-5.6-sol",
      model_reported_id: "gpt-5.6-sol",
      service_tier_requested: "default",
      strict_output_schema_hash:
        sha256CanonicalJson(FINAL_DECISION_MEMO_OUTPUT_SCHEMA),
      pricing_snapshot_hash:
        sha256CanonicalJson(FINAL_DECISION_MEMO_PRICING_SNAPSHOT),
      store_requested: false,
      total_latency_ms: 25,
    });
    expect(memo.adapter_run_evidence_hash).toBe(
      sha256CanonicalJson(memo.adapter_run_evidence),
    );
    expect(() => buildDecisionAuthorityRecord({
      context,
      finalMemo: memo,
    } as never)).toThrow(/confirmation|확인|receipt|validated/i);
    expect(() => buildDecisionAuthorityRecord({
      context,
      finalMemo: memo,
      finalConfirmationReceipt: finalConfirmationFor(
        context,
        memo,
        "REQUEST_CHANGES",
      ),
    })).toThrow(/CONFIRM|확인|state|chain/i);
    const record = buildDecisionAuthorityRecord({
      context,
      finalMemo: memo,
      finalConfirmationReceipt: finalConfirmationFor(context, memo),
    });

    expect(() => assertAuthoritativeDecisionBaselineRecord(record)).toThrow(
      /persisted|authoritative|DECISION_BASELINE|기준선/i,
    );
    expect(() => DEFAULT_REGRESSION_BASELINE_ASSERTION(record)).toThrow(
      /persisted|authoritative|DECISION_BASELINE|기준선/i,
    );
    if (record.artifact_kind !== "DECISION_BASELINE_RECORD") {
      throw new Error("테스트 fixture는 기준선 record여야 합니다.");
    }
    expect(record).toMatchObject({
      artifact_kind: "DECISION_BASELINE_RECORD",
      selected_candidate_id: "A",
      baseline_status: "ACTIVE",
      external_actions: {
        purchase_executed: false,
        contract_executed: false,
        deployment_executed: false,
        rollback_executed: false,
      },
    });
    expect(record.selected_candidate_identity.candidate_slot_identity_hashes)
      .toHaveLength(24);
    expect(record.selected_candidate_identity.candidate_config_hashes)
      .toHaveLength(12);
    expect(record.selected_candidate_identity.system_prompt_hash)
      .toMatch(/^[a-f0-9]{64}$/);
    expect(record.selected_candidate_identity.evaluator_policy_manifest_hash)
      .toBe(buildPolicyManifestHash(BENCHMARK_POLICIES));
    expect(record.baseline_version).toMatch(/^baseline_v1_[a-f0-9]{64}$/);
  });

  it("결정적 실패와 사람 실패를 고유 case로 합치며 실패 후보 선택을 거부한다", async () => {
    const authority = await task14Authority({
      deterministicFailures: ["H-007:A"],
    });
    const humanReceipt = buildHumanConfirmationReceipt({
      expected: authority.expected,
      command: humanConfirmationCommandFor(authority.expected),
    });
    const context = buildHumanConfirmedDecisionContext({
      recordedBenchmarkPack: authority.benchmarkPack,
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      humanConfirmationReceipt: humanReceipt,
    });
    expect(context.aggregation.candidates[0]).toMatchObject({
      critical_failed_case_ids: ["H-007"],
      eligible: false,
    });
    expect(context.aggregation.recommended_candidate_id).toBe("B");

    await expect(runFinalDecisionMemo({
      context,
      selection: {
        schema_version: "decision-selection-command-v1",
        action: "SELECT_CANDIDATE",
        candidate_id: "A",
        rationale: "Attempt to select a failed candidate.",
        actor_label: "Challenge owner",
        expected_recorded_benchmark_pack_hash:
          sha256CanonicalJson(authority.benchmarkPack),
        expected_human_confirmation_receipt_hash:
          sha256CanonicalJson(humanReceipt),
        expected_aggregation_hash: sha256CanonicalJson(context.aggregation),
        decided_at: "2026-07-17T03:15:00.000Z",
      },
      adapter: { invoke: async () => { throw new Error("must not call"); } },
    })).rejects.toThrow(/eligible|선택|후보|실패/i);
  });

  it("명시적 no-approved 결정은 기준선이 없고 baseline assertion을 통과하지 못한다", async () => {
    const authority = await task14Authority();
    const humanReceipt = buildHumanConfirmationReceipt({
      expected: authority.expected,
      command: humanConfirmationCommandFor(authority.expected),
    });
    const context = buildHumanConfirmedDecisionContext({
      recordedBenchmarkPack: authority.benchmarkPack,
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      humanConfirmationReceipt: humanReceipt,
    });
    const memo = await runFinalDecisionMemo({
      context,
      selection: {
        schema_version: "decision-selection-command-v1",
        action: "SELECT_NO_APPROVED_CANDIDATE",
        candidate_id: null,
        rationale: "The owner declines every candidate pending another PoC.",
        actor_label: "Challenge owner",
        expected_recorded_benchmark_pack_hash:
          sha256CanonicalJson(authority.benchmarkPack),
        expected_human_confirmation_receipt_hash:
          sha256CanonicalJson(humanReceipt),
        expected_aggregation_hash: sha256CanonicalJson(context.aggregation),
        decided_at: "2026-07-17T03:16:00.000Z",
      },
      adapter: {
        invoke: async (request) => memoAdapterResult(request, {
          selected_candidate_id: null,
          decision_summary: "No candidate was approved for this PoC.",
          rejected_alternatives: [
            { candidate_id: "A", reason: "Not selected by the owner." },
            { candidate_id: "B", reason: "Not selected by the owner." },
            { candidate_id: "C", reason: "Not selected by the owner." },
          ],
          known_limitations: ["The Benchmark uses synthetic data."],
          next_poc_scope: "Run a scoped follow-up PoC.",
          procurement_handoff: "No candidate is handed to procurement.",
          external_action_statement:
            "No purchase, contract, deployment, or rollback was executed.",
        }),
      },
    });
    const record = buildDecisionAuthorityRecord({
      context,
      finalMemo: memo,
      finalConfirmationReceipt: finalConfirmationFor(context, memo),
    });
    expect(() => assertAuthoritativeNoApprovedCandidateRecord(record)).toThrow(
      /persisted|authoritative|NO_APPROVED|no-approved/i,
    );
    expect(record).toMatchObject({
      artifact_kind: "NO_APPROVED_CANDIDATE_RECORD",
      baseline_version: null,
    });
    expect(() => assertAuthoritativeDecisionBaselineRecord(record)).toThrow(
      /baseline|기준선|DECISION_BASELINE/i,
    );
  }, 15_000);

  it("Judge 추가 검수 overflow는 제안 내용과 무관하게 사용자 확인·결정·baseline을 차단한다", async () => {
    const authority = await task13Authority({
      risks: {
        "H-001": { X: "HIGH", Y: "HIGH", Z: "HIGH" },
        "H-002": { X: "MEDIUM", Y: "MEDIUM", Z: "LOW" },
        "H-003": { X: "LOW" },
      },
    });
    expect(authority.queue.overflow.detected).toBe(true);
    authority.command.items = authority.command.items.map((proposal, index) => {
      const queueItem = authority.queue.items[index];
      if (queueItem.judge_risks.length === 0) return proposal;
      return {
        item_id: proposal.item_id,
        proposed_decision: "PROPOSED_CONFIRMED_FAIL",
        rationale: "The blinded Judge risk requires a conservative confirmed failure.",
        evidence_handles: [queueItem.judge_evidence_handle],
      };
    });
    const preReviewReceipt = buildAiPreReviewReceipt({
      benchmarkPack: authority.benchmarkPack,
      queue: authority.queue,
      command: authority.command,
    });
    expect(preReviewReceipt.pre_review_status).toBe("USER_CONFIRMATION_BLOCKED");
    expect(preReviewReceipt.blocking_reasons).toContain("QUEUE_OVERFLOW");
    const provisionalMemo = buildProvisionalDecisionMemo({
      benchmarkPack: authority.benchmarkPack,
      queue: authority.queue,
      preReviewReceipt,
      createdAt: "2026-07-17T03:05:00.000Z",
    });
    expect(provisionalMemo.memo_status).toBe("USER_CONFIRMATION_BLOCKED");
    expect(() => createHumanConfirmationExpectedContext({
      benchmarkPack: authority.benchmarkPack,
      queue: authority.queue,
      preReviewReceipt,
      provisionalMemo,
    })).toThrow(/준비|blocked|상태|artifact chain/i);
  });

  it("Memo adapter가 선택을 덮어쓰면 차단하고 같은 권위 체인에는 두 결정 파일을 만들지 않는다", async () => {
    const authority = await task14Authority();
    const humanReceipt = buildHumanConfirmationReceipt({
      expected: authority.expected,
      command: humanConfirmationCommandFor(authority.expected),
    });
    const context = buildHumanConfirmedDecisionContext({
      recordedBenchmarkPack: authority.benchmarkPack,
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      humanConfirmationReceipt: humanReceipt,
    });
    const selection: DecisionSelectionCommand = {
      schema_version: "decision-selection-command-v1",
      action: "SELECT_CANDIDATE",
      candidate_id: "A",
      rationale: "Select the least-complex sufficient candidate.",
      actor_label: "Challenge owner",
      expected_recorded_benchmark_pack_hash:
        sha256CanonicalJson(authority.benchmarkPack),
      expected_human_confirmation_receipt_hash:
        sha256CanonicalJson(humanReceipt),
      expected_aggregation_hash: sha256CanonicalJson(context.aggregation),
      decided_at: "2026-07-17T03:17:00.000Z",
    };
    await expect(runFinalDecisionMemo({
      context,
      selection,
      adapter: {
        invoke: async (request) => memoAdapterResult(request, {
          selected_candidate_id: "B",
          decision_summary: "Attempted override.",
          rejected_alternatives: [],
          known_limitations: ["Synthetic data."],
          next_poc_scope: "Another PoC.",
          procurement_handoff: "Existing process only.",
          external_action_statement:
            "No purchase, contract, deployment, or rollback was executed.",
        }),
      },
    })).rejects.toThrow(/override|selected|선택|Memo/i);
  });

  it("Memo 실행 증거·최종 확인 hash·validated receipt clone 변조를 모두 차단한다", async () => {
    const authority = await task14Authority();
    const humanReceipt = buildHumanConfirmationReceipt({
      expected: authority.expected,
      command: humanConfirmationCommandFor(authority.expected),
    });
    const context = buildHumanConfirmedDecisionContext({
      recordedBenchmarkPack: authority.benchmarkPack,
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      humanConfirmationReceipt: humanReceipt,
    });
    const selection: DecisionSelectionCommand = {
      schema_version: "decision-selection-command-v1",
      action: "SELECT_CANDIDATE",
      candidate_id: "A",
      rationale: "Select Candidate A.",
      actor_label: "Challenge owner",
      expected_recorded_benchmark_pack_hash:
        context.recorded_benchmark_pack_hash,
      expected_human_confirmation_receipt_hash:
        context.human_confirmation_receipt_hash,
      expected_aggregation_hash: sha256CanonicalJson(context.aggregation),
      decided_at: "2026-07-17T03:17:00.000Z",
    };
    const output: FinalDecisionMemoAdapterOutput = {
      selected_candidate_id: "A",
      decision_summary: "Candidate A is selected.",
      rejected_alternatives: [
        { candidate_id: "B", reason: "More complex." },
        { candidate_id: "C", reason: "More complex." },
      ],
      known_limitations: ["The Benchmark uses synthetic data."],
      next_poc_scope: "Run a private PoC.",
      procurement_handoff: "Use the existing procurement process.",
      external_action_statement:
        "No purchase, contract, deployment, or rollback was executed.",
    };
    await expect(runFinalDecisionMemo({
      context,
      selection,
      adapter: {
        invoke: async (request) => {
          const result = structuredClone(
            memoAdapterResult(request, output),
          ) as any;
          result.run_evidence.adapter_request_hash = "0".repeat(64);
          return result;
        },
      },
    })).rejects.toThrow(/request|evidence|계약|hash/i);
    await expect(runFinalDecisionMemo({
      context,
      selection,
      adapter: {
        invoke: async (request) => memoAdapterResult(request, {
          ...output,
          decision_summary:
            "The external deployment was completed successfully.",
        }),
      },
    })).rejects.toThrow(/배포|실행|주장|prose/i);

    const memo = await runFinalDecisionMemo({
      context,
      selection,
      adapter: {
        invoke: async (request) => memoAdapterResult(request, output),
      },
    });
    expect(() => buildFinalDecisionConfirmationReceipt({
      context,
      finalMemo: memo,
      command: {
        schema_version: "final-decision-confirmation-command-v1",
        action: "CONFIRM",
        actor_label: "Challenge owner",
        expected_recorded_benchmark_pack_hash:
          context.recorded_benchmark_pack_hash,
        expected_human_confirmation_receipt_hash:
          context.human_confirmation_receipt_hash,
        expected_aggregation_hash: sha256CanonicalJson(context.aggregation),
        expected_final_decision_memo_hash: "0".repeat(64),
        expected_adapter_run_evidence_hash:
          memo.adapter_run_evidence_hash,
        expected_selection_hash: sha256CanonicalJson({
          schema_version: "final-decision-selection-binding-v1",
          selection_action: memo.selection_action,
          selected_candidate_id: memo.selected_candidate_id,
          selection_rationale: memo.selection_rationale,
          decided_by: memo.decided_by,
          decided_at: memo.decided_at,
        }),
        confirmed_at: "2026-07-17T03:18:00.000Z",
      },
    })).toThrow(/stale|substituted|hash|Memo/i);

    const confirmation = finalConfirmationFor(context, memo);
    expect(() => buildDecisionAuthorityRecord({
      context,
      finalMemo: memo,
      finalConfirmationReceipt: structuredClone(confirmation),
    })).toThrow(/validated|confirmation|receipt|확인/i);
  });

  it("Final Memo→최종 확인→결정 record를 0600 write-once 저장하고 재시작 source chain으로 복원한다", async () => {
    const authority = await task14Authority();
    const humanReceipt = buildHumanConfirmationReceipt({
      expected: authority.expected,
      command: humanConfirmationCommandFor(authority.expected),
    });
    const context = buildHumanConfirmedDecisionContext({
      recordedBenchmarkPack: authority.benchmarkPack,
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      humanConfirmationReceipt: humanReceipt,
    });
    const selection: DecisionSelectionCommand = {
      schema_version: "decision-selection-command-v1",
      action: "SELECT_CANDIDATE",
      candidate_id: "A",
      rationale: "Select the least-complex sufficient candidate.",
      actor_label: "Challenge owner",
      expected_recorded_benchmark_pack_hash:
        context.recorded_benchmark_pack_hash,
      expected_human_confirmation_receipt_hash:
        context.human_confirmation_receipt_hash,
      expected_aggregation_hash: sha256CanonicalJson(context.aggregation),
      decided_at: "2026-07-17T03:18:00.000Z",
    };
    const memo = await runFinalDecisionMemo({
      context,
      selection,
      adapter: {
        invoke: async (request) => memoAdapterResult(
          request,
          buildFinalDecisionMemoRequiredOutput(request),
        ),
      },
    });
    const finalConfirmation = finalConfirmationFor(context, memo);
    const record = buildDecisionAuthorityRecord({
      context,
      finalMemo: memo,
      finalConfirmationReceipt: finalConfirmation,
    });
    const outputDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "decision-authority-chain-"),
    ));
    const memoPersisted = await persistFinalDecisionMemo({
      outputDirectory,
      memo,
    });
    expect(() => assertPersistedFinalDecisionMemo(memo)).toThrow(
      /persisted|source|write-once|로드/i,
    );
    const confirmationPersisted =
      await persistFinalDecisionConfirmationReceipt({
        outputDirectory,
        receipt: finalConfirmation,
      });
    expect(() => assertPersistedFinalDecisionConfirmationReceipt(
      finalConfirmation,
    )).toThrow(/persisted|source|write-once|로드/i);
    await expect(persistDecisionAuthorityRecord({
      outputDirectory,
      record,
      context,
      recordedBenchmarkPack: authority.benchmarkPack,
      finalMemoPath: memoPersisted.path,
      finalConfirmationReceiptPath: confirmationPersisted.path,
    })).rejects.toThrow(/persisted|Human confirmation|source|receipt/i);
    const humanReceiptPersisted = await persistHumanConfirmationReceipt({
      outputDirectory,
      receipt: humanReceipt,
    });
    const persistedContext =
      await loadPersistedHumanConfirmedDecisionContext({
        recordedBenchmarkPack: authority.benchmarkPack,
        lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
        humanConfirmationReceiptPath: humanReceiptPersisted.path,
        humanConfirmationExpectedContext: authority.expected,
      });
    expect(() => assertPersistedHumanConfirmedDecisionContext(
      persistedContext,
    )).not.toThrow();
    expect(() => buildDecisionPublicProjection({
      context: persistedContext,
      humanConfirmationReceipt: humanReceipt,
      finalDecisionMemo: memo,
    })).toThrow(/persisted|source|write-once|로드/i);
    expect(buildDecisionPublicProjection({
      context: persistedContext,
      humanConfirmationReceipt: humanReceipt,
    })).toMatchObject({
      schema_version: "decision-public-projection-v1",
      status: "HUMAN_CONFIRMED_REVIEW",
      human_confirmed: true,
      selected_candidate_id: null,
      baseline_id: null,
      composite_score: null,
      review: {
        completed: authority.queue.items.length,
        total: authority.queue.items.length,
        remaining: 0,
      },
    });
    const missingHumanReceiptPath = `${humanReceiptPersisted.path}.missing`;
    await rename(humanReceiptPersisted.path, missingHumanReceiptPath);
    await expect(persistDecisionAuthorityRecord({
      outputDirectory,
      record,
      context: persistedContext,
      recordedBenchmarkPack: authority.benchmarkPack,
      finalMemoPath: memoPersisted.path,
      finalConfirmationReceiptPath: confirmationPersisted.path,
    })).rejects.toThrow(/Human confirmation|source reload|persisted|읽/i);
    expect(
      (await readdir(outputDirectory)).filter((name) => (
        name.startsWith("decision-")
      )),
    ).toEqual([]);
    await rename(missingHumanReceiptPath, humanReceiptPersisted.path);
    const decisionPersisted = await persistDecisionAuthorityRecord({
      outputDirectory,
      record,
      context: persistedContext,
      recordedBenchmarkPack: authority.benchmarkPack,
      finalMemoPath: memoPersisted.path,
      finalConfirmationReceiptPath: confirmationPersisted.path,
    });
    expect(() => assertAuthoritativeDecisionBaselineRecord(record)).toThrow(
      /persisted|source|authoritative|기준선/i,
    );
    expect(() => DEFAULT_REGRESSION_BASELINE_ASSERTION(record)).toThrow(
      /persisted|source|authoritative|기준선/i,
    );

    for (const path of [
      humanReceiptPersisted.path,
      memoPersisted.path,
      confirmationPersisted.path,
      decisionPersisted.path,
    ]) {
      const stats = await lstat(path);
      expect(stats.mode & 0o777).toBe(0o600);
      expect(stats.nlink).toBe(1);
    }
    const restartedContext =
      await loadPersistedHumanConfirmedDecisionContext({
        recordedBenchmarkPack: authority.benchmarkPack,
        lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
        humanConfirmationReceiptPath: humanReceiptPersisted.path,
        humanConfirmationExpectedContext: authority.expected,
      });
    const loadedMemo = await loadFinalDecisionMemo({
      path: memoPersisted.path,
      context: restartedContext,
    });
    expect(() => assertPersistedFinalDecisionMemo(loadedMemo)).not.toThrow();
    expect(buildDecisionPublicProjection({
      context: restartedContext,
      humanConfirmationReceipt: humanReceipt,
      finalDecisionMemo: loadedMemo,
    })).toMatchObject({
      status: "MEMO_REVIEW_REQUIRED",
      selected_candidate_id: "A",
      selection_rationale: selection.rationale,
      final_decision_memo_hash: sha256CanonicalJson(loadedMemo),
      final_decision_memo: {
        source_hash: sha256CanonicalJson(loadedMemo),
        decision_summary: loadedMemo.decision_summary,
        rejected_alternatives: loadedMemo.rejected_alternatives,
        hard_gate_findings: loadedMemo.hard_gate_findings,
        known_limitations: loadedMemo.known_limitations,
        next_poc_scope: loadedMemo.next_poc_scope,
        procurement_handoff: loadedMemo.procurement_handoff,
        external_action_statement: loadedMemo.external_action_statement,
        candidate_trade_offs: [
          {
            candidate_id: "A",
            disposition: "SELECTED",
            summary: loadedMemo.decision_summary,
            critical_failed_case_ids:
              loadedMemo.hard_gate_findings[0].critical_failed_case_ids,
          },
          ...loadedMemo.rejected_alternatives.map((alternative) => ({
            candidate_id: alternative.candidate_id,
            disposition: "NOT_SELECTED" as const,
            summary: alternative.reason,
            critical_failed_case_ids:
              loadedMemo.hard_gate_findings.find(
                (finding) => (
                  finding.candidate_id === alternative.candidate_id
                ),
              )!.critical_failed_case_ids,
          })),
        ],
      },
      baseline_id: null,
    });
    const loadedConfirmation =
      await loadFinalDecisionConfirmationReceipt({
        path: confirmationPersisted.path,
        context: restartedContext,
        finalMemo: loadedMemo,
      });
    expect(() => assertPersistedFinalDecisionConfirmationReceipt(
      loadedConfirmation,
    )).not.toThrow();
    expect(loadedConfirmation.final_decision_confirmed).toBe(true);
    const loadedDecision = await loadDecisionAuthorityRecord({
      path: decisionPersisted.path,
      context: restartedContext,
      finalMemoPath: memoPersisted.path,
      finalConfirmationReceiptPath: confirmationPersisted.path,
      recordedBenchmarkPack: authority.benchmarkPack,
    });
    assertAuthoritativeDecisionBaselineRecord(loadedDecision);
    expect(loadedDecision).toEqual(record);
    const confirmedProjection = buildDecisionPublicProjection({
      context: restartedContext,
      humanConfirmationReceipt: humanReceipt,
      finalDecisionMemo: loadedMemo,
      decisionAuthorityRecord: loadedDecision,
    });
    expect(confirmedProjection).toMatchObject({
      decision_id: loadedDecision.decision_id,
      source_hash: sha256CanonicalJson(loadedDecision),
      status: "DECISION_CONFIRMED",
      selected_candidate_id: "A",
      baseline_id: loadedDecision.baseline_version,
      final_decision_memo_hash: sha256CanonicalJson(loadedMemo),
      final_memo_confirmation_hash:
        loadedDecision.final_decision_confirmation_receipt_hash,
    });
    expect(buildBaselinePublicProjection(loadedDecision)).toMatchObject({
      schema_version: "baseline-public-projection-v1",
      baseline_id: loadedDecision.baseline_version,
      source_hash: sha256CanonicalJson(loadedDecision),
      status: "ACTIVE",
      selected_candidate_id: "A",
      decision_record_hash: sha256CanonicalJson(loadedDecision),
      configuration_hash: sha256CanonicalJson(
        loadedDecision.selected_candidate_identity,
      ),
      baseline_version: "v1",
      external_deployment_performed: false,
    });
    const decisionSnapshot = buildRecordedDecisionProjectionSnapshot({
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      recordedBenchmarkPack: authority.benchmarkPack,
      humanConfirmedDecisionContext: restartedContext,
      humanConfirmationReceipt: humanReceipt,
      finalDecisionMemo: loadedMemo,
      decisionAuthorityRecord: loadedDecision,
    });
    expect(decisionSnapshot.projections.workspace).toMatchObject({
      schema_version: "workspace-public-projection-v1",
      challenge_id: LOCKED_CHALLENGE_FIXTURE.challenge_id,
      benchmark_id:
        authority.benchmarkPack.benchmark_execution_pack.execution_hash,
      review_id: null,
      decision_id: loadedDecision.decision_id,
      baseline_id: loadedDecision.baseline_version,
      regression_id: null,
      stage_statuses: {
        define: "LOCKED",
        compare: "RECORDED",
        decide: "DECISION CONFIRMED",
        monitor: "BASELINE ACTIVE",
      },
    });
    expect(decisionSnapshot.projections.decisions).toHaveLength(1);
    expect(decisionSnapshot.projections.baselines).toHaveLength(1);
    expect(decisionSnapshot.projections.regressions).toEqual([]);
    expect(decisionSnapshot.projections.blind_reviews).toEqual([]);
    expect(canonicalJsonStringify(decisionSnapshot)).not.toMatch(
      /private_mapping|label_to_candidate|raw_oracle|blinding_seed|api[_-]?key/i,
    );
    const persistedDecisionSnapshot =
      await persistRecordedDecisionProjectionSnapshot({
        outputDirectory,
        sources: {
          lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
          recordedBenchmarkPack: authority.benchmarkPack,
          humanConfirmedDecisionContext: restartedContext,
          humanConfirmationReceipt: humanReceipt,
          finalDecisionMemo: loadedMemo,
          decisionAuthorityRecord: loadedDecision,
        },
      });
    const reloadedDecisionSnapshot =
      await loadReadOnlyProjectionSnapshotRecord({
        path: persistedDecisionSnapshot.path,
      });
    expect(reloadedDecisionSnapshot.snapshot_id).toBe(
      decisionSnapshot.snapshot_id,
    );
    expect((await lstat(persistedDecisionSnapshot.path)).mode & 0o777).toBe(
      0o600,
    );

    const extraLink = join(outputDirectory, "decision-hard-link");
    await link(decisionPersisted.path, extraLink);
    await expect(loadDecisionAuthorityRecord({
      path: decisionPersisted.path,
      context: restartedContext,
      finalMemoPath: memoPersisted.path,
      finalConfirmationReceiptPath: confirmationPersisted.path,
      recordedBenchmarkPack: authority.benchmarkPack,
    })).rejects.toThrow(/nlink|regular|0600/i);
    await unlink(extraLink);

    await chmod(decisionPersisted.path, 0o644);
    await expect(loadDecisionAuthorityRecord({
      path: decisionPersisted.path,
      context: restartedContext,
      finalMemoPath: memoPersisted.path,
      finalConfirmationReceiptPath: confirmationPersisted.path,
      recordedBenchmarkPack: authority.benchmarkPack,
    })).rejects.toThrow(/0600|mode|regular/i);
    await chmod(decisionPersisted.path, 0o600);

    const movedMemo = `${memoPersisted.path}.missing`;
    await rename(memoPersisted.path, movedMemo);
    await expect(loadDecisionAuthorityRecord({
      path: decisionPersisted.path,
      context: restartedContext,
      finalMemoPath: memoPersisted.path,
      finalConfirmationReceiptPath: confirmationPersisted.path,
      recordedBenchmarkPack: authority.benchmarkPack,
    })).rejects.toThrow(/Memo|읽|없|ENOENT|안전/i);
    await rename(movedMemo, memoPersisted.path);

    await expect(persistFinalDecisionMemo({ outputDirectory, memo }))
      .rejects.toThrow(/replay/i);
    await expect(persistFinalDecisionConfirmationReceipt({
      outputDirectory,
      receipt: finalConfirmation,
    })).rejects.toThrow(/replay/i);
    await expect(persistDecisionAuthorityRecord({
      outputDirectory,
      record,
      context: persistedContext,
      recordedBenchmarkPack: authority.benchmarkPack,
      finalMemoPath: memoPersisted.path,
      finalConfirmationReceiptPath: confirmationPersisted.path,
    })).rejects.toThrow(/replay/i);

    const tamperedWrapper = JSON.parse(
      await readFile(decisionPersisted.path, "utf8"),
    ) as {
      payload_sha256: string;
      payload: Record<string, unknown>;
    };
    tamperedWrapper.payload.selection_rationale =
      "Tampered after the human-confirmed decision.";
    tamperedWrapper.payload_sha256 = sha256CanonicalJson(
      tamperedWrapper.payload,
    );
    await writeFile(
      decisionPersisted.path,
      `${canonicalJsonStringify(tamperedWrapper)}\n`,
      { mode: 0o600 },
    );
    await expect(loadDecisionAuthorityRecord({
      path: decisionPersisted.path,
      context: restartedContext,
      finalMemoPath: memoPersisted.path,
      finalConfirmationReceiptPath: confirmationPersisted.path,
      recordedBenchmarkPack: authority.benchmarkPack,
    })).rejects.toThrow(/재빌드|canonical|다릅니다|source/i);
  });

  it("같은 Benchmark·review authority의 baseline과 no-approved가 경쟁해도 정확히 한 record만 원자적으로 승리한다", async () => {
    const authority = await task14Authority();
    const humanReceipt = buildHumanConfirmationReceipt({
      expected: authority.expected,
      command: humanConfirmationCommandFor(authority.expected),
    });
    const outputDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "decision-authority-race-"),
    ));
    const humanReceiptPersisted = await persistHumanConfirmationReceipt({
      outputDirectory,
      receipt: humanReceipt,
    });
    const context = await loadPersistedHumanConfirmedDecisionContext({
      recordedBenchmarkPack: authority.benchmarkPack,
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      humanConfirmationReceiptPath: humanReceiptPersisted.path,
      humanConfirmationExpectedContext: authority.expected,
    });
    const makeMemo = async (
      action: "SELECT_CANDIDATE" | "SELECT_NO_APPROVED_CANDIDATE",
    ) => runFinalDecisionMemo({
      context,
      selection: {
        schema_version: "decision-selection-command-v1",
        action,
        candidate_id: action === "SELECT_CANDIDATE" ? "A" : null,
        rationale: action === "SELECT_CANDIDATE"
          ? "Select Candidate A."
          : "Select no approved candidate.",
        actor_label: "Challenge owner",
        expected_recorded_benchmark_pack_hash:
          context.recorded_benchmark_pack_hash,
        expected_human_confirmation_receipt_hash:
          context.human_confirmation_receipt_hash,
        expected_aggregation_hash: sha256CanonicalJson(context.aggregation),
        decided_at: action === "SELECT_CANDIDATE"
          ? "2026-07-17T03:21:00.000Z"
          : "2026-07-17T03:22:00.000Z",
      } as DecisionSelectionCommand,
      adapter: {
        invoke: async (request) => memoAdapterResult(request, {
          selected_candidate_id: request.selected_candidate_id,
          decision_summary: request.selected_candidate_id === null
            ? "No candidate is approved."
            : "Candidate A is selected.",
          rejected_alternatives: (
            ["A", "B", "C"] as const
          ).filter((candidateId) => (
            candidateId !== request.selected_candidate_id
          )).map((candidateId) => ({
            candidate_id: candidateId,
            reason: "Not selected by the challenge owner.",
          })),
          known_limitations: ["The Benchmark uses synthetic data."],
          next_poc_scope: "Run a private follow-up PoC.",
          procurement_handoff: "Use the existing procurement process.",
          external_action_statement:
            "No purchase, contract, deployment, or rollback was executed.",
        }),
      },
    });
    const [baselineMemo, noApprovedMemo] = await Promise.all([
      makeMemo("SELECT_CANDIDATE"),
      makeMemo("SELECT_NO_APPROVED_CANDIDATE"),
    ]);
    const baselineConfirmation = finalConfirmationFor(context, baselineMemo);
    const noApprovedConfirmation =
      finalConfirmationFor(context, noApprovedMemo);
    const baselineRecord = buildDecisionAuthorityRecord({
      context,
      finalMemo: baselineMemo,
      finalConfirmationReceipt: baselineConfirmation,
    });
    const noApprovedRecord = buildDecisionAuthorityRecord({
      context,
      finalMemo: noApprovedMemo,
      finalConfirmationReceipt: noApprovedConfirmation,
    });
    const [baselineMemoPath, noApprovedMemoPath] = await Promise.all([
      persistFinalDecisionMemo({
        outputDirectory,
        memo: baselineMemo,
      }),
      persistFinalDecisionMemo({
        outputDirectory,
        memo: noApprovedMemo,
      }),
    ]);
    const [baselineConfirmationPath, noApprovedConfirmationPath] =
      await Promise.all([
        persistFinalDecisionConfirmationReceipt({
          outputDirectory,
          receipt: baselineConfirmation,
        }),
        persistFinalDecisionConfirmationReceipt({
          outputDirectory,
          receipt: noApprovedConfirmation,
        }),
      ]);
    const results = await Promise.allSettled([
      persistDecisionAuthorityRecord({
        outputDirectory,
        record: baselineRecord,
        context,
        recordedBenchmarkPack: authority.benchmarkPack,
        finalMemoPath: baselineMemoPath.path,
        finalConfirmationReceiptPath: baselineConfirmationPath.path,
      }),
      persistDecisionAuthorityRecord({
        outputDirectory,
        record: noApprovedRecord,
        context,
        recordedBenchmarkPack: authority.benchmarkPack,
        finalMemoPath: noApprovedMemoPath.path,
        finalConfirmationReceiptPath: noApprovedConfirmationPath.path,
      }),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    const rejected = results.find((item) => item.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      name: "DecisionBaselineIntegrityError",
    });
  }, 15_000);

  it("같은 Benchmark의 서로 다른 유효 ACCEPT_ALL receipt가 경쟁해도 ACTIVE 기준선은 하나만 생긴다", async () => {
    const authority = await task14Authority();
    const receipts = [
      buildHumanConfirmationReceipt({
        expected: authority.expected,
        command: humanConfirmationCommandFor(authority.expected, {
          actor_label: "Challenge owner alpha",
          confirmed_at: "2026-07-17T03:10:00.000Z",
        }),
      }),
      buildHumanConfirmationReceipt({
        expected: authority.expected,
        command: humanConfirmationCommandFor(authority.expected, {
          actor_label: "Challenge owner beta",
          confirmed_at: "2026-07-17T03:11:00.000Z",
        }),
      }),
    ] as const;
    expect(sha256CanonicalJson(receipts[0]))
      .not.toBe(sha256CanonicalJson(receipts[1]));
    const upstreamRoots = await Promise.all([
      realpath(await mkdtemp(join(tmpdir(), "decision-upstream-alpha-"))),
      realpath(await mkdtemp(join(tmpdir(), "decision-upstream-beta-"))),
    ]);
    const persistedReceipts = await Promise.all(receipts.map(
      (receipt, index) => persistHumanConfirmationReceipt({
        outputDirectory: upstreamRoots[index],
        receipt,
      }),
    ));
    const contexts = await Promise.all(persistedReceipts.map(
      (persisted, index) => loadPersistedHumanConfirmedDecisionContext({
        recordedBenchmarkPack: authority.benchmarkPack,
        lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
        humanConfirmationReceiptPath: persisted.path,
        humanConfirmationExpectedContext: authority.expected,
      }),
    ));
    const decisionBundles = await Promise.all(contexts.map(
      async (context, index) => {
        const memo = await runFinalDecisionMemo({
          context,
          selection: {
            schema_version: "decision-selection-command-v1",
            action: "SELECT_CANDIDATE",
            candidate_id: "A",
            rationale: `Select Candidate A under confirmation ${index + 1}.`,
            actor_label: `Challenge owner ${index + 1}`,
            expected_recorded_benchmark_pack_hash:
              context.recorded_benchmark_pack_hash,
            expected_human_confirmation_receipt_hash:
              context.human_confirmation_receipt_hash,
            expected_aggregation_hash:
              sha256CanonicalJson(context.aggregation),
            decided_at: index === 0
              ? "2026-07-17T03:21:00.000Z"
              : "2026-07-17T03:22:00.000Z",
          },
          adapter: {
            invoke: async (request) => memoAdapterResult(request, {
              selected_candidate_id: "A",
              decision_summary: "Candidate A is selected.",
              rejected_alternatives: [
                { candidate_id: "B", reason: "More complex." },
                { candidate_id: "C", reason: "More complex." },
              ],
              known_limitations: ["The Benchmark uses synthetic data."],
              next_poc_scope: "Run a private follow-up PoC.",
              procurement_handoff: "Use the existing procurement process.",
              external_action_statement:
                "No purchase, contract, deployment, or rollback was executed.",
            }),
          },
        });
        const confirmation = finalConfirmationFor(context, memo);
        return {
          context,
          memo,
          confirmation,
          record: buildDecisionAuthorityRecord({
            context,
            finalMemo: memo,
            finalConfirmationReceipt: confirmation,
          }),
        };
      },
    ));
    const outputDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "decision-benchmark-terminal-race-"),
    ));
    const persistedMemos = await Promise.all(decisionBundles.map(
      ({ memo }) => persistFinalDecisionMemo({ outputDirectory, memo }),
    ));
    const persistedConfirmations = await Promise.all(decisionBundles.map(
      ({ confirmation }) => persistFinalDecisionConfirmationReceipt({
        outputDirectory,
        receipt: confirmation,
      }),
    ));
    const results = await Promise.allSettled(decisionBundles.map(
      ({ context, record }, index) => persistDecisionAuthorityRecord({
        outputDirectory,
        record,
        context,
        recordedBenchmarkPack: authority.benchmarkPack,
        finalMemoPath: persistedMemos[index].path,
        finalConfirmationReceiptPath:
          persistedConfirmations[index].path,
      }),
    ));
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    const rejected = results.find((item) => item.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      name: "DecisionBaselineIntegrityError",
    });
  });

  it("Final Memo persistence는 artifact directory·leaf·root ancestor symlink를 모두 fail-closed 한다", async () => {
    const authority = await task14Authority();
    const humanReceipt = buildHumanConfirmationReceipt({
      expected: authority.expected,
      command: humanConfirmationCommandFor(authority.expected),
    });
    const context = buildHumanConfirmedDecisionContext({
      recordedBenchmarkPack: authority.benchmarkPack,
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      humanConfirmationReceipt: humanReceipt,
    });
    const buildMemo = (decidedAt: string) => runFinalDecisionMemo({
      context,
      selection: {
        schema_version: "decision-selection-command-v1",
        action: "SELECT_CANDIDATE",
        candidate_id: "A",
        rationale: "Select Candidate A.",
        actor_label: "Challenge owner",
        expected_recorded_benchmark_pack_hash:
          context.recorded_benchmark_pack_hash,
        expected_human_confirmation_receipt_hash:
          context.human_confirmation_receipt_hash,
        expected_aggregation_hash: sha256CanonicalJson(context.aggregation),
        decided_at: decidedAt,
      },
      adapter: {
        invoke: async (request) => memoAdapterResult(request, {
          selected_candidate_id: "A",
          decision_summary: "Candidate A is selected.",
          rejected_alternatives: [
            { candidate_id: "B", reason: "More complex." },
            { candidate_id: "C", reason: "More complex." },
          ],
          known_limitations: ["The Benchmark uses synthetic data."],
          next_poc_scope: "Run a private PoC.",
          procurement_handoff: "Use the existing procurement process.",
          external_action_statement:
            "No purchase, contract, deployment, or rollback was executed.",
        }),
      },
    });

    const directoryMemo = await buildMemo("2026-07-17T03:23:00.000Z");
    const directoryRoot = await realpath(await mkdtemp(
      join(tmpdir(), "decision-memo-directory-symlink-"),
    ));
    const outside = await realpath(await mkdtemp(
      join(tmpdir(), "decision-memo-outside-"),
    ));
    const directoryPaths = createFinalDecisionMemoPaths({
      outputDirectory: directoryRoot,
      memo: directoryMemo,
    });
    await symlink(outside, directoryPaths.memoDirectory);
    await expect(persistFinalDecisionMemo({
      outputDirectory: directoryRoot,
      memo: directoryMemo,
    })).rejects.toThrow(/symlink|directory|canonical|안전/i);
    expect(await readdir(outside)).toEqual([]);

    const leafMemo = await buildMemo("2026-07-17T03:24:00.000Z");
    const leafRoot = await realpath(await mkdtemp(
      join(tmpdir(), "decision-memo-leaf-symlink-"),
    ));
    const leafPaths = createFinalDecisionMemoPaths({
      outputDirectory: leafRoot,
      memo: leafMemo,
    });
    await mkdir(leafPaths.memoDirectory, { mode: 0o700 });
    const outsideLeaf = join(leafRoot, "outside-leaf.json");
    await writeFile(outsideLeaf, "{}\n", { mode: 0o600 });
    await symlink(outsideLeaf, leafPaths.memoPath);
    await expect(persistFinalDecisionMemo({
      outputDirectory: leafRoot,
      memo: leafMemo,
    })).rejects.toThrow(/symlink|nlink|regular|0600|읽/i);
    expect(await readFile(outsideLeaf, "utf8")).toBe("{}\n");

    const ancestorMemo = await buildMemo("2026-07-17T03:25:00.000Z");
    const ancestorParent = await realpath(await mkdtemp(
      join(tmpdir(), "decision-memo-ancestor-symlink-"),
    ));
    const actualRoot = join(ancestorParent, "actual-root");
    const aliasRoot = join(ancestorParent, "alias-root");
    await mkdir(actualRoot, { mode: 0o700 });
    await symlink(actualRoot, aliasRoot);
    await expect(persistFinalDecisionMemo({
      outputDirectory: aliasRoot,
      memo: ancestorMemo,
    })).rejects.toThrow(/symlink|root|canonical|directory|안전/i);
    expect(await readdir(actualRoot)).toEqual([]);
  });
});

// @vitest-environment node

import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  DecisionAuthorityRecord,
  FinalDecisionConfirmationReceipt,
  FinalDecisionMemo,
  HumanConfirmedDecisionContext,
} from "../../eval/decision/decisionBaseline";
import type { LockedChallengePack } from "../../eval/define/defineContracts";
import type { RecordedBenchmarkPack } from "../../eval/pack/recordedBenchmarkPack";
import type { RecordedRegressionPack } from "../../eval/regression/regressionPack";
import type {
  HumanConfirmationExpectedContext,
  HumanConfirmationReceipt,
} from "../../eval/review/humanConfirmation";
import type { AiPreReviewReceipt } from "../../eval/review/preReviewReceipt";
import type { ProvisionalDecisionMemo } from "../../eval/decision/provisionalMemo";
import { sha256CanonicalJson } from "../../eval/runtime/canonicalJson";
import {
  buildProjectionSnapshot,
  loadReadOnlyProjectionSnapshotRecord,
  persistProjectionSnapshot,
  type ProjectionSnapshot,
} from "../projectionRepository";
import {
  AuthoritativeWorkflowControllerIntegrityError,
  assertRecordedWorkflowProjectionTransition,
  createAuthoritativeWorkflowController,
  createAuthoritativeWorkflowControllerForTest,
  createAuthoritativeRecordedWorkflowGateway,
  type AuthoritativeWorkflowControllerDependencies,
} from "../authoritativeWorkflowController";

function authority<T>(value: Record<string, unknown>): T {
  return Object.freeze(value) as T;
}

function snapshot({
  sources,
  reviewId,
  decisionId,
  baselineId,
  regressionId,
  decideStatus,
  monitorStatus,
}: {
  readonly sources: readonly Record<string, unknown>[];
  readonly reviewId: string | null;
  readonly decisionId: string | null;
  readonly baselineId: string | null;
  readonly regressionId: string | null;
  readonly decideStatus?: string;
  readonly monitorStatus?: string;
}): ProjectionSnapshot {
  const source = sources.at(-1)!;
  const sourceHash = sha256CanonicalJson(source);
  return buildProjectionSnapshot({
    source_chain: sources.map((artifact) => {
      const payloadSha256 = sha256CanonicalJson(artifact);
      const artifactId = [
        artifact.challenge_id,
        (artifact.benchmark_execution_pack as Record<string, unknown> | undefined)
          ?.execution_hash,
        artifact.pre_review_id,
        artifact.memo_id,
        artifact.confirmation_id,
        artifact.decision_id,
        artifact.regression_id,
      ].find((value): value is string => typeof value === "string")
        ?? payloadSha256;
      return {
        artifact_kind: typeof artifact.artifact_kind === "string"
          ? artifact.artifact_kind
          : "TEST_AUTHORITY",
        artifact_id: artifactId,
        payload_sha256: payloadSha256,
      };
    }),
    workspace: {
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
      challenge_id: "challenge_1",
      benchmark_id: "benchmark_1",
      review_id: reviewId,
      decision_id: decisionId,
      baseline_id: baselineId,
      regression_id: regressionId,
      source_hash: sourceHash,
      stage_statuses: {
        define: "LOCKED",
        compare: "RECORDED",
        decide: decideStatus ?? (decisionId === null
          ? "USER CONFIRMATION REQUIRED"
          : baselineId === null ? "HUMAN CONFIRMED REVIEW" : "DECISION CONFIRMED"),
        monitor: monitorStatus ?? (regressionId === null
          ? baselineId === null ? "NO BASELINE" : "BASELINE ACTIVE"
          : "BLOCK"),
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

describe("Recorded workflow 권위 mutation controller", () => {
  it("동일 terminal hash를 가진 self-valid snapshot도 이전 source-chain prefix를 바꾸면 거부한다", () => {
    const previousAuthority = authority<Record<string, unknown>>({
      artifact_kind: "TEST_PREVIOUS",
      decision_id: "previous_1",
    });
    const appendedAuthority = authority<Record<string, unknown>>({
      artifact_kind: "TEST_APPEND",
      decision_id: "decision_1",
    });
    const substitutedPrevious = authority<Record<string, unknown>>({
      artifact_kind: "TEST_SUBSTITUTED",
      decision_id: "substituted_1",
    });
    const previous = snapshot({
      sources: [previousAuthority],
      reviewId: null,
      decisionId: "decision_pending_1",
      baselineId: null,
      regressionId: null,
    });
    const substituted = snapshot({
      sources: [substitutedPrevious, appendedAuthority],
      reviewId: null,
      decisionId: "decision_1",
      baselineId: null,
      regressionId: null,
    });
    const appendedSource = substituted.source_chain[1];

    expect(() => assertRecordedWorkflowProjectionTransition({
      previousSnapshot: previous,
      expectedSnapshot: substituted,
      nextSnapshot: substituted,
      expectation: {
        appendedSources: [appendedSource],
        workspace: {
          review_id: null,
          decision_id: "decision_1",
          baseline_id: null,
          regression_id: null,
          decide_status: "HUMAN CONFIRMED REVIEW",
          monitor_status: "NO BASELINE",
        },
      },
      assertExpectedSnapshotAuthority: () => undefined,
    })).toThrow(/source chain|prefix|append|권위/i);
  });

  it("서버 source에서 review hash를 재구성하고 Memo·Decision·Baseline·Regression을 write-once snapshot으로 전진시킨다", async () => {
    const outputDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "authoritative-workflow-controller-"),
    ));
    const lockedChallengePack = authority<LockedChallengePack>({
      artifact_kind: "LOCKED_CHALLENGE_PACK",
      challenge_id: "challenge_1",
    });
    const recordedBenchmarkPack = authority<RecordedBenchmarkPack>({
      artifact_kind: "RECORDED_BENCHMARK_PACK",
      benchmark_execution_pack: { execution_hash: "benchmark_1" },
      blind_review_queue: { items: [{ item_id: "review_item_1" }] },
    });
    const preReviewReceipt = authority<AiPreReviewReceipt>({
      artifact_kind: "AI_PRE_REVIEW_RECEIPT",
      pre_review_id: "pre_review_1",
    });
    const provisionalDecisionMemo = authority<ProvisionalDecisionMemo>({
      artifact_kind: "PROVISIONAL_DECISION_MEMO",
      memo_id: "provisional_memo_1",
    });
    const expected = authority<HumanConfirmationExpectedContext>({
      schema_version: "human-confirmation-expected-context-v2",
      synthetic: true,
      recorded_benchmark_pack_hash: sha256CanonicalJson(recordedBenchmarkPack),
      ai_pre_review_receipt_hash: sha256CanonicalJson(preReviewReceipt),
      provisional_decision_memo_hash:
        sha256CanonicalJson(provisionalDecisionMemo),
      queue_content_hash: "1".repeat(64),
      queue_set_order_hash: "2".repeat(64),
      queue_item_ids: ["review_item_1"],
      queue_item_set_hash: "3".repeat(64),
      queue_item_order_hash: "4".repeat(64),
      proposal_items: [{
        item_id: "review_item_1",
        expected_final_decision: "PASS",
        expected_rationale: "The active policy is satisfied.",
      }],
    });
    const humanReceipt = authority<HumanConfirmationReceipt>({
      artifact_kind: "HUMAN_CONFIRMATION_RECEIPT",
      confirmation_id: "hcr_test",
      actor_label: "Challenge owner",
    });
    const context = authority<HumanConfirmedDecisionContext>({
      schema_version: "human-confirmed-decision-context-v1",
      recorded_benchmark_pack_hash: sha256CanonicalJson(recordedBenchmarkPack),
      human_confirmation_receipt_hash: sha256CanonicalJson(humanReceipt),
      aggregation: {
        recommended_candidate_id: "B",
        eligible_candidate_ids: ["B", "C"],
      },
    });
    const finalMemo = authority<FinalDecisionMemo>({
      artifact_kind: "FINAL_DECISION_MEMO",
      selected_candidate_id: "B",
      selection_action: "SELECT_CANDIDATE",
      selection_rationale: "B is the simplest sufficient configuration.",
      decided_by: "Challenge owner",
      decided_at: "2026-07-17T08:01:00.000Z",
      adapter_run_evidence_hash: "5".repeat(64),
    });
    const finalConfirmation = authority<FinalDecisionConfirmationReceipt>({
      artifact_kind: "FINAL_DECISION_CONFIRMATION_RECEIPT",
      action: "CONFIRM",
    });
    const decisionRecord = authority<DecisionAuthorityRecord>({
      artifact_kind: "DECISION_BASELINE_RECORD",
      decision_id: "decision_final_1",
      baseline_version: "baseline_v1_test",
      selected_candidate_id: "B",
    });
    const regressionPack = authority<RecordedRegressionPack>({
      artifact_kind: "RECORDED_REGRESSION_PACK",
      regression_id: "regression_1",
      verdict: "BLOCK",
    });

    const initial = snapshot({
      sources: [
        lockedChallengePack,
        recordedBenchmarkPack,
        preReviewReceipt,
        provisionalDecisionMemo,
      ] as unknown as Record<string, unknown>[],
      reviewId: "review_1",
      decisionId: null,
      baselineId: null,
      regressionId: null,
    });
    const reviewed = snapshot({
      sources: [
        lockedChallengePack,
        recordedBenchmarkPack,
        preReviewReceipt,
        provisionalDecisionMemo,
        humanReceipt,
      ] as unknown as Record<string, unknown>[],
      reviewId: null,
      decisionId: "decision_pending_1",
      baselineId: null,
      regressionId: null,
    });
    const memoReady = snapshot({
      sources: [
        lockedChallengePack,
        recordedBenchmarkPack,
        preReviewReceipt,
        provisionalDecisionMemo,
        humanReceipt,
        finalMemo,
      ] as unknown as Record<string, unknown>[],
      reviewId: null,
      decisionId: "decision_pending_1",
      baselineId: null,
      regressionId: null,
      decideStatus: "MEMO REVIEW REQUIRED",
    });
    const decided = snapshot({
      sources: [
        lockedChallengePack,
        recordedBenchmarkPack,
        preReviewReceipt,
        provisionalDecisionMemo,
        humanReceipt,
        finalMemo,
        finalConfirmation,
        decisionRecord,
      ] as unknown as Record<string, unknown>[],
      reviewId: null,
      decisionId: "decision_final_1",
      baselineId: "baseline_v1_test",
      regressionId: null,
    });
    const regressed = snapshot({
      sources: [
        lockedChallengePack,
        recordedBenchmarkPack,
        preReviewReceipt,
        provisionalDecisionMemo,
        humanReceipt,
        finalMemo,
        finalConfirmation,
        decisionRecord,
        regressionPack,
      ] as unknown as Record<string, unknown>[],
      reviewId: null,
      decisionId: "decision_final_1",
      baselineId: "baseline_v1_test",
      regressionId: "regression_1",
    });
    const persistedSnapshots = await Promise.all(
      [reviewed, memoReady, decided, regressed].map((value) => (
        persistProjectionSnapshot({
          outputDirectory,
          snapshot: value,
        })
      )),
    );

    const dependencies = {
      assertPersistedRecordedBenchmarkPack: vi.fn(),
      assertPersistedAiPreReviewReceipt: vi.fn(),
      assertPersistedProvisionalDecisionMemo: vi.fn(),
      assertPersistedRecordedRegressionPack: vi.fn(),
      assertAuthoritativeDecisionBaselineRecord: vi.fn(),
      assertAuthoritativeRecordedWorkflowProjectionSnapshot: vi.fn(),
      createHumanConfirmationExpectedContext: vi.fn(() => expected),
      buildHumanConfirmationReceipt: vi.fn(() => humanReceipt),
      buildHumanConfirmedDecisionContext: vi.fn(() => context),
      persistHumanConfirmationReceipt: vi.fn(async () => ({
        path: "/authority/human.json",
        created: true as const,
        payloadSha256: sha256CanonicalJson(humanReceipt),
      })),
      loadHumanConfirmationReceipt: vi.fn(async () => humanReceipt),
      loadPersistedHumanConfirmedDecisionContext: vi.fn(async () => context),
      runFinalDecisionMemo: vi.fn(async () => finalMemo),
      persistFinalDecisionMemo: vi.fn(async () => ({
        path: "/authority/memo.json",
        created: true as const,
        payloadSha256: sha256CanonicalJson(finalMemo),
      })),
      loadFinalDecisionMemo: vi.fn(async () => finalMemo),
      buildFinalDecisionConfirmationReceipt: vi.fn(() => finalConfirmation),
      persistFinalDecisionConfirmationReceipt: vi.fn(async () => ({
        path: "/authority/final-confirmation.json",
        created: true as const,
        payloadSha256: sha256CanonicalJson(finalConfirmation),
      })),
      loadFinalDecisionConfirmationReceipt:
        vi.fn(async () => finalConfirmation),
      buildDecisionAuthorityRecord: vi.fn(() => decisionRecord),
      persistDecisionAuthorityRecord: vi.fn(async () => ({
        path: "/authority/decision.json",
        created: true as const,
        payloadSha256: sha256CanonicalJson(decisionRecord),
      })),
      loadDecisionAuthorityRecord: vi.fn(async () => decisionRecord),
      buildRecordedDecisionProjectionSnapshot: vi.fn()
        .mockReturnValueOnce(reviewed)
        .mockReturnValueOnce(memoReady)
        .mockReturnValueOnce(decided)
        .mockReturnValueOnce(regressed),
      persistRecordedDecisionProjectionSnapshot: vi.fn()
        .mockResolvedValueOnce(persistedSnapshots[0])
        .mockResolvedValueOnce(persistedSnapshots[1])
        .mockResolvedValueOnce(persistedSnapshots[2])
        .mockResolvedValueOnce(persistedSnapshots[3]),
      sha256CanonicalJson,
    } satisfies AuthoritativeWorkflowControllerDependencies;
    const regressionRunner = vi.fn(async () => ({
      pack: regressionPack,
      path: "/authority/regression.json",
      payloadSha256: sha256CanonicalJson(regressionPack),
    }));
    const regressionLoader = vi.fn(async () => regressionPack);
    const controller = createAuthoritativeWorkflowControllerForTest({
      authorityOutputDirectory: outputDirectory,
      projectionOutputDirectory: outputDirectory,
      initialSources: {
        lockedChallengePack,
        recordedBenchmarkPack,
        preReviewReceipt,
        provisionalDecisionMemo,
      },
      finalDecisionMemoAdapter: {
        invoke: vi.fn(async () => {
          throw new Error("fake adapter는 dependency가 대신 실행합니다.");
        }),
      },
      recordedRegressionRunner: regressionRunner,
      loadPersistedRecordedRegression: regressionLoader,
      now: vi.fn()
        .mockReturnValueOnce("2026-07-17T08:00:00.000Z")
        .mockReturnValueOnce("2026-07-17T08:01:00.000Z")
        .mockReturnValueOnce("2026-07-17T08:02:00.000Z"),
      dependencies,
    });

    const reviewInput = {
      command: {
        schema_version: "review-confirmation-command-v1",
        target_id: "review_1",
        expected_source_hash: sha256CanonicalJson(provisionalDecisionMemo),
        idempotency_key: "mutation_review_001",
        payload: {
          action: "CONFIRM_WITH_EDITS",
          actor_label: "Challenge owner",
          items: [{
            item_id: "review_item_1",
            final_decision: "CONFIRMED_FAIL",
            rationale:
              "The human reviewer found a policy violation in the blinded evidence.",
            proposal_resolution: "EDITED",
            review_duration_ms: 1_250,
            edit_duration_ms: 450,
          }],
        },
      },
      currentSnapshot: initial,
    } as const;
    const reviewResult = await controller.operations.confirmReview(reviewInput);
    expect(reviewResult).toEqual({ nextSnapshotPath: persistedSnapshots[0].path });
    expect(dependencies.buildHumanConfirmedDecisionContext).toHaveBeenCalledWith({
      recordedBenchmarkPack,
      lockedChallengePack,
      humanConfirmationReceipt: humanReceipt,
    });
    expect(
      dependencies.buildHumanConfirmedDecisionContext.mock.invocationCallOrder[0],
    ).toBeLessThan(
      dependencies.persistHumanConfirmationReceipt.mock.invocationCallOrder[0],
    );
    expect(dependencies.buildHumanConfirmationReceipt).toHaveBeenCalledWith({
      expected,
      command: {
        schema_version: "human-confirmation-command-v1",
        action: "CONFIRM_WITH_EDITS",
        actor_label: "Challenge owner",
        expected_recorded_benchmark_pack_hash:
          expected.recorded_benchmark_pack_hash,
        expected_ai_pre_review_receipt_hash:
          expected.ai_pre_review_receipt_hash,
        expected_provisional_decision_memo_hash:
          expected.provisional_decision_memo_hash,
        expected_queue_content_hash: expected.queue_content_hash,
        expected_queue_set_order_hash: expected.queue_set_order_hash,
        expected_queue_item_set_hash: expected.queue_item_set_hash,
        expected_queue_item_order_hash: expected.queue_item_order_hash,
        items: [{
          item_id: "review_item_1",
          final_decision: "CONFIRMED_FAIL",
          rationale:
            "The human reviewer found a policy violation in the blinded evidence.",
          proposal_resolution: "EDITED",
          review_duration_ms: 1_250,
          edit_duration_ms: 450,
        }],
        confirmed_at: "2026-07-17T08:00:00.000Z",
      },
    });

    const reviewedSnapshot = await loadReadOnlyProjectionSnapshotRecord({
      path: reviewResult.nextSnapshotPath,
    });
    await controller.transitionVerifiers.confirmReview({
      command: reviewInput.command,
      previousSnapshot: initial,
      nextSnapshot: reviewedSnapshot,
    });
    const memoInput = {
      command: {
        schema_version: "decision-memo-command-v1",
        target_id: "decision_pending_1",
        expected_source_hash: sha256CanonicalJson(humanReceipt),
        idempotency_key: "mutation_memo_001",
        payload: {
          action: "SELECT_CANDIDATE",
          candidate_id: "B",
          rationale: "B is the simplest sufficient configuration.",
        },
      },
      currentSnapshot: reviewedSnapshot,
    } as const;
    const memoResult = await controller.operations.createDecisionMemo(memoInput);
    expect(memoResult.nextSnapshotPath).toBe(persistedSnapshots[1].path);
    expect(dependencies.runFinalDecisionMemo).toHaveBeenCalledWith({
      context,
      selection: {
        schema_version: "decision-selection-command-v1",
        action: "SELECT_CANDIDATE",
        candidate_id: "B",
        rationale: "B is the simplest sufficient configuration.",
        actor_label: "Challenge owner",
        expected_recorded_benchmark_pack_hash:
          context.recorded_benchmark_pack_hash,
        expected_human_confirmation_receipt_hash:
          context.human_confirmation_receipt_hash,
        expected_aggregation_hash: sha256CanonicalJson(context.aggregation),
        decided_at: "2026-07-17T08:01:00.000Z",
      },
      adapter: expect.any(Object),
    });

    const memoSnapshot = await loadReadOnlyProjectionSnapshotRecord({
      path: memoResult.nextSnapshotPath,
    });
    await controller.transitionVerifiers.createDecisionMemo({
      command: memoInput.command,
      previousSnapshot: reviewedSnapshot,
      nextSnapshot: memoSnapshot,
    });
    const decisionInput = {
      command: {
        schema_version: "decision-confirmation-command-v1",
        target_id: "decision_pending_1",
        expected_source_hash: sha256CanonicalJson(finalMemo),
        idempotency_key: "mutation_decision_001",
        payload: {
          action: "CONFIRM",
          expected_final_decision_memo_hash: sha256CanonicalJson(finalMemo),
        },
      },
      currentSnapshot: memoSnapshot,
    } as const;
    const decisionResult = await controller.operations.confirmDecision(
      decisionInput,
    );
    expect(decisionResult.nextSnapshotPath).toBe(persistedSnapshots[2].path);
    expect(
      dependencies.buildFinalDecisionConfirmationReceipt,
    ).toHaveBeenCalledWith({
      context,
      finalMemo,
      command: expect.objectContaining({
        schema_version: "final-decision-confirmation-command-v1",
        action: "CONFIRM",
        actor_label: "Challenge owner",
        expected_final_decision_memo_hash: sha256CanonicalJson(finalMemo),
        confirmed_at: "2026-07-17T08:02:00.000Z",
      }),
    });
    expect(dependencies.loadDecisionAuthorityRecord).toHaveBeenCalled();

    const decisionSnapshot = await loadReadOnlyProjectionSnapshotRecord({
      path: decisionResult.nextSnapshotPath,
    });
    await controller.transitionVerifiers.confirmDecision({
      command: decisionInput.command,
      previousSnapshot: memoSnapshot,
      nextSnapshot: decisionSnapshot,
    });
    const regressionInput = {
      command: {
        schema_version: "regression-start-command-v1",
        target_id: "baseline_v1_test",
        expected_source_hash: sha256CanonicalJson(decisionRecord),
        idempotency_key: "mutation_regression_001",
        payload: {},
      },
      currentSnapshot: decisionSnapshot,
    } as const;
    const regressionResult = await controller.operations.startRegression(
      regressionInput,
    );
    expect(regressionResult.nextSnapshotPath).toBe(persistedSnapshots[3].path);
    expect(regressionRunner).toHaveBeenCalledWith({
      outputDirectory,
      decisionBaselineRecord: decisionRecord,
      lockedChallengePack,
      recordedBenchmarkPack,
    });
    expect(regressionLoader).toHaveBeenCalledWith({
      result: {
        pack: regressionPack,
        path: "/authority/regression.json",
        payloadSha256: sha256CanonicalJson(regressionPack),
      },
      decisionBaselineRecord: decisionRecord,
    });
    expect(
      dependencies.assertPersistedRecordedRegressionPack,
    ).toHaveBeenCalledWith(regressionPack);
    expect(
      dependencies.persistRecordedDecisionProjectionSnapshot,
    ).toHaveBeenLastCalledWith({
      outputDirectory,
      sources: expect.objectContaining({
        recordedRegressionPack: regressionPack,
        decisionAuthorityRecord: decisionRecord,
      }),
    });

    // eligible 후보가 존재해도 업무 책임자는 명시적 사유와 별도 Memo 확인을
    // 거쳐 모든 후보를 보류할 수 있습니다. 이 경로는 기준선을 만들지 않습니다.
    const noApprovedMemo = authority<FinalDecisionMemo>({
      artifact_kind: "FINAL_DECISION_MEMO",
      selected_candidate_id: null,
      selection_action: "SELECT_NO_APPROVED_CANDIDATE",
      selection_rationale:
        "The owner declines every eligible candidate pending another PoC.",
      decided_by: "Challenge owner",
      decided_at: "2026-07-17T09:01:00.000Z",
      adapter_run_evidence_hash: "6".repeat(64),
    });
    const noApprovedConfirmation =
      authority<FinalDecisionConfirmationReceipt>({
        artifact_kind: "FINAL_DECISION_CONFIRMATION_RECEIPT",
        action: "CONFIRM",
      });
    const noApprovedRecord = authority<DecisionAuthorityRecord>({
      artifact_kind: "NO_APPROVED_CANDIDATE_RECORD",
      decision_id: "decision_no_approved_1",
      baseline_version: null,
      selected_candidate_id: null,
    });
    const noApprovedMemoReady = snapshot({
      sources: [
        lockedChallengePack,
        recordedBenchmarkPack,
        preReviewReceipt,
        provisionalDecisionMemo,
        humanReceipt,
        noApprovedMemo,
      ] as unknown as Record<string, unknown>[],
      reviewId: null,
      decisionId: "decision_pending_1",
      baselineId: null,
      regressionId: null,
      decideStatus: "MEMO REVIEW REQUIRED",
    });
    const noApprovedDecided = snapshot({
      sources: [
        lockedChallengePack,
        recordedBenchmarkPack,
        preReviewReceipt,
        provisionalDecisionMemo,
        humanReceipt,
        noApprovedMemo,
        noApprovedConfirmation,
        noApprovedRecord,
      ] as unknown as Record<string, unknown>[],
      reviewId: null,
      decisionId: "decision_no_approved_1",
      baselineId: null,
      regressionId: null,
      decideStatus: "NO APPROVED CANDIDATE",
      monitorStatus: "NO BASELINE",
    });
    const [noApprovedMemoPersisted, noApprovedDecisionPersisted] =
      await Promise.all(
        [noApprovedMemoReady, noApprovedDecided].map((value) => (
          persistProjectionSnapshot({
            outputDirectory,
            snapshot: value,
          })
        )),
      );
    const noApprovedDependencies = {
      ...dependencies,
      runFinalDecisionMemo: vi.fn(async () => noApprovedMemo),
      persistFinalDecisionMemo: vi.fn(async () => ({
        path: "/authority/no-approved-memo.json",
        created: true as const,
        payloadSha256: sha256CanonicalJson(noApprovedMemo),
      })),
      loadFinalDecisionMemo: vi.fn(async () => noApprovedMemo),
      buildFinalDecisionConfirmationReceipt:
        vi.fn(() => noApprovedConfirmation),
      persistFinalDecisionConfirmationReceipt: vi.fn(async () => ({
        path: "/authority/no-approved-confirmation.json",
        created: true as const,
        payloadSha256: sha256CanonicalJson(noApprovedConfirmation),
      })),
      loadFinalDecisionConfirmationReceipt:
        vi.fn(async () => noApprovedConfirmation),
      buildDecisionAuthorityRecord: vi.fn(() => noApprovedRecord),
      persistDecisionAuthorityRecord: vi.fn(async () => ({
        path: "/authority/no-approved-decision.json",
        created: true as const,
        payloadSha256: sha256CanonicalJson(noApprovedRecord),
      })),
      loadDecisionAuthorityRecord: vi.fn(async () => noApprovedRecord),
      buildRecordedDecisionProjectionSnapshot: vi.fn()
        .mockReturnValueOnce(reviewed)
        .mockReturnValueOnce(noApprovedMemoReady)
        .mockReturnValueOnce(noApprovedDecided),
      persistRecordedDecisionProjectionSnapshot: vi.fn()
        .mockResolvedValueOnce(persistedSnapshots[0])
        .mockResolvedValueOnce(noApprovedMemoPersisted)
        .mockResolvedValueOnce(noApprovedDecisionPersisted),
    } satisfies AuthoritativeWorkflowControllerDependencies;
    const noApprovedController =
      createAuthoritativeWorkflowControllerForTest({
        authorityOutputDirectory: outputDirectory,
        projectionOutputDirectory: outputDirectory,
        initialSources: {
          lockedChallengePack,
          recordedBenchmarkPack,
          preReviewReceipt,
          provisionalDecisionMemo,
        },
        finalDecisionMemoAdapter: {
          invoke: vi.fn(async () => {
            throw new Error("fake adapter는 dependency가 대신 실행합니다.");
          }),
        },
        recordedRegressionRunner: vi.fn(async () => {
          throw new Error("기준선 없는 경로에서 호출되면 안 됩니다.");
        }),
        loadPersistedRecordedRegression: vi.fn(async () => {
          throw new Error("기준선 없는 경로에서 호출되면 안 됩니다.");
        }),
        now: vi.fn()
          .mockReturnValueOnce("2026-07-17T09:00:00.000Z")
          .mockReturnValueOnce("2026-07-17T09:01:00.000Z")
          .mockReturnValueOnce("2026-07-17T09:02:00.000Z"),
        dependencies: noApprovedDependencies,
      });
    const noApprovedReviewInput = {
      ...reviewInput,
      command: {
        ...reviewInput.command,
        idempotency_key: "mutation_review_no_approved",
      },
    } as const;
    const noApprovedReviewResult =
      await noApprovedController.operations.confirmReview(
        noApprovedReviewInput,
      );
    const noApprovedReviewedSnapshot =
      await loadReadOnlyProjectionSnapshotRecord({
        path: noApprovedReviewResult.nextSnapshotPath,
      });
    await noApprovedController.transitionVerifiers.confirmReview({
      command: noApprovedReviewInput.command,
      previousSnapshot: initial,
      nextSnapshot: noApprovedReviewedSnapshot,
    });
    const noApprovedMemoInput = {
      command: {
        schema_version: "decision-memo-command-v1",
        target_id: "decision_pending_1",
        expected_source_hash: sha256CanonicalJson(humanReceipt),
        idempotency_key: "mutation_memo_no_approved",
        payload: {
          action: "SELECT_NO_APPROVED_CANDIDATE",
          candidate_id: null,
          rationale:
            "The owner declines every eligible candidate pending another PoC.",
        },
      },
      currentSnapshot: noApprovedReviewedSnapshot,
    } as const;
    const noApprovedMemoResult =
      await noApprovedController.operations.createDecisionMemo(
        noApprovedMemoInput,
      );
    expect(noApprovedDependencies.runFinalDecisionMemo)
      .toHaveBeenCalledWith({
        context,
        selection: expect.objectContaining({
          action: "SELECT_NO_APPROVED_CANDIDATE",
          candidate_id: null,
          rationale:
            "The owner declines every eligible candidate pending another PoC.",
        }),
        adapter: expect.any(Object),
      });
    const noApprovedMemoSnapshot =
      await loadReadOnlyProjectionSnapshotRecord({
        path: noApprovedMemoResult.nextSnapshotPath,
      });
    await noApprovedController.transitionVerifiers.createDecisionMemo({
      command: noApprovedMemoInput.command,
      previousSnapshot: noApprovedReviewedSnapshot,
      nextSnapshot: noApprovedMemoSnapshot,
    });
    await expect(noApprovedController.operations.confirmDecision({
      command: {
        schema_version: "decision-confirmation-command-v1",
        target_id: "decision_pending_1",
        expected_source_hash: sha256CanonicalJson(noApprovedMemo),
        idempotency_key: "mutation_no_approved_wrong_hash",
        payload: {
          action: "CONFIRM",
          expected_final_decision_memo_hash: "f".repeat(64),
        },
      },
      currentSnapshot: noApprovedMemoSnapshot,
    })).rejects.toThrow(/Memo hash|권위 Memo/i);
    expect(
      noApprovedDependencies.persistFinalDecisionConfirmationReceipt,
    ).not.toHaveBeenCalled();
    const noApprovedDecisionInput = {
      command: {
        schema_version: "decision-confirmation-command-v1",
        target_id: "decision_pending_1",
        expected_source_hash: sha256CanonicalJson(noApprovedMemo),
        idempotency_key: "mutation_decision_no_approved",
        payload: {
          action: "CONFIRM",
          expected_final_decision_memo_hash:
            sha256CanonicalJson(noApprovedMemo),
        },
      },
      currentSnapshot: noApprovedMemoSnapshot,
    } as const;
    const noApprovedDecisionResult =
      await noApprovedController.operations.confirmDecision(
        noApprovedDecisionInput,
      );
    const noApprovedDecisionSnapshot =
      await loadReadOnlyProjectionSnapshotRecord({
        path: noApprovedDecisionResult.nextSnapshotPath,
      });
    await noApprovedController.transitionVerifiers.confirmDecision({
      command: noApprovedDecisionInput.command,
      previousSnapshot: noApprovedMemoSnapshot,
      nextSnapshot: noApprovedDecisionSnapshot,
    });
    expect(noApprovedDecisionSnapshot.projections.workspace).toMatchObject({
      decision_id: "decision_no_approved_1",
      baseline_id: null,
      regression_id: null,
      stage_statuses: {
        decide: "NO APPROVED CANDIDATE",
        monitor: "NO BASELINE",
      },
    });
    await expect(noApprovedController.operations.startRegression({
      command: {
        schema_version: "regression-start-command-v1",
        target_id: "baseline_missing",
        expected_source_hash: sha256CanonicalJson(noApprovedRecord),
        idempotency_key: "mutation_regression_no_approved",
        payload: {},
      },
      currentSnapshot: noApprovedDecisionSnapshot,
    })).rejects.toThrow(/active baseline|기준선/i);
  });

  it("브라우저가 queue hash를 주입하거나 다른 Memo hash를 확인하면 side effect 전에 거부한다", async () => {
    const provisionalDecisionMemo = authority<ProvisionalDecisionMemo>({
      artifact_kind: "PROVISIONAL_DECISION_MEMO",
    });
    const expected = authority<HumanConfirmationExpectedContext>({
      recorded_benchmark_pack_hash: "1".repeat(64),
      ai_pre_review_receipt_hash: "2".repeat(64),
      provisional_decision_memo_hash: sha256CanonicalJson(
        provisionalDecisionMemo,
      ),
      queue_content_hash: "3".repeat(64),
      queue_set_order_hash: "4".repeat(64),
      queue_item_set_hash: "5".repeat(64),
      queue_item_order_hash: "6".repeat(64),
      queue_item_ids: [],
      proposal_items: [],
    });
    const humanReceipt = authority<HumanConfirmationReceipt>({
      artifact_kind: "HUMAN_CONFIRMATION_RECEIPT",
    });
    const buildReceipt = vi.fn(() => humanReceipt);
    const preflightHumanDecision = vi.fn(() => {
      throw new Error(
        "사람 검수는 결정적 CONFIRMED_FAIL을 PASS로 덮어쓸 수 없습니다.",
      );
    });
    const persistHumanReceipt = vi.fn();
    const dependencies = {
      assertPersistedRecordedBenchmarkPack: vi.fn(),
      assertPersistedAiPreReviewReceipt: vi.fn(),
      assertPersistedProvisionalDecisionMemo: vi.fn(),
      createHumanConfirmationExpectedContext: vi.fn(() => expected),
      buildHumanConfirmationReceipt: buildReceipt,
      buildHumanConfirmedDecisionContext: preflightHumanDecision,
      persistHumanConfirmationReceipt: persistHumanReceipt,
    } as unknown as AuthoritativeWorkflowControllerDependencies;
    const controller = createAuthoritativeWorkflowControllerForTest({
      authorityOutputDirectory: "/authority",
      projectionOutputDirectory: "/projection",
      initialSources: {
        lockedChallengePack: authority<LockedChallengePack>({}),
        recordedBenchmarkPack: authority<RecordedBenchmarkPack>({
          blind_review_queue: { items: [] },
        }),
        preReviewReceipt: authority<AiPreReviewReceipt>({}),
        provisionalDecisionMemo,
      },
      finalDecisionMemoAdapter: {
        invoke: vi.fn(async () => {
          throw new Error("호출되면 안 됩니다.");
        }),
      },
      recordedRegressionRunner: vi.fn(async () => {
        throw new Error("호출되면 안 됩니다.");
      }),
      loadPersistedRecordedRegression: vi.fn(async () => {
        throw new Error("호출되면 안 됩니다.");
      }),
      dependencies,
    });
    const currentSnapshot = snapshot({
      sources: [provisionalDecisionMemo] as unknown as Record<string, unknown>[],
      reviewId: "review_1",
      decisionId: null,
      baselineId: null,
      regressionId: null,
    });

    await expect(controller.operations.confirmReview({
      command: {
        schema_version: "review-confirmation-command-v1",
        target_id: "review_1",
        expected_source_hash: sha256CanonicalJson(provisionalDecisionMemo),
        idempotency_key: "mutation_review_forged",
        payload: {
          action: "ACCEPT_ALL",
          actor_label: "Challenge owner",
          items: [],
          expected_queue_set_order_hash: "f".repeat(64),
        },
      },
      currentSnapshot,
    })).rejects.toBeInstanceOf(
      AuthoritativeWorkflowControllerIntegrityError,
    );
    expect(buildReceipt).not.toHaveBeenCalled();

    await expect(controller.operations.confirmReview({
      command: {
        schema_version: "review-confirmation-command-v1",
        target_id: "review_1",
        expected_source_hash: sha256CanonicalJson(provisionalDecisionMemo),
        idempotency_key: "mutation_review_gate_override",
        payload: {
          action: "CONFIRM_WITH_EDITS",
          actor_label: "Challenge owner",
          items: [],
        },
      },
      currentSnapshot,
    })).rejects.toThrow(/결정적|CONFIRMED_FAIL|덮어쓸 수 없습니다/i);
    expect(buildReceipt).toHaveBeenCalledOnce();
    expect(preflightHumanDecision).toHaveBeenCalledWith({
      recordedBenchmarkPack: expect.any(Object),
      lockedChallengePack: expect.any(Object),
      humanConfirmationReceipt: humanReceipt,
    });
    expect(persistHumanReceipt).not.toHaveBeenCalled();
  });

  it("production factory는 런타임으로 주입된 test dependency override를 무시한다", () => {
    const provisionalDecisionMemo = authority<ProvisionalDecisionMemo>({
      artifact_kind: "PROVISIONAL_DECISION_MEMO",
    });
    const injected = {
      assertPersistedRecordedBenchmarkPack: vi.fn(),
      assertPersistedAiPreReviewReceipt: vi.fn(),
      assertPersistedProvisionalDecisionMemo: vi.fn(),
      createHumanConfirmationExpectedContext: vi.fn(() => authority<
        HumanConfirmationExpectedContext
      >({
        recorded_benchmark_pack_hash: "1".repeat(64),
        ai_pre_review_receipt_hash: "2".repeat(64),
        provisional_decision_memo_hash: "3".repeat(64),
        queue_content_hash: "4".repeat(64),
        queue_set_order_hash: "5".repeat(64),
        queue_item_ids: [],
        queue_item_set_hash: "6".repeat(64),
        queue_item_order_hash: "7".repeat(64),
        proposal_items: [],
      })),
    };

    expect(() => createAuthoritativeWorkflowController({
      authorityOutputDirectory: "/authority",
      projectionOutputDirectory: "/projection",
      initialSources: {
        lockedChallengePack: authority<LockedChallengePack>({}),
        recordedBenchmarkPack: authority<RecordedBenchmarkPack>({
          blind_review_queue: { items: [] },
        }),
        preReviewReceipt: authority<AiPreReviewReceipt>({}),
        provisionalDecisionMemo,
      },
      finalDecisionMemoAdapter: {
        invoke: vi.fn(async () => {
          throw new Error("호출되면 안 됩니다.");
        }),
      },
      recordedRegressionRunner: vi.fn(async () => {
        throw new Error("호출되면 안 됩니다.");
      }),
      loadPersistedRecordedRegression: vi.fn(async () => {
        throw new Error("호출되면 안 됩니다.");
      }),
      dependencies: injected,
    } as unknown as Parameters<
      typeof createAuthoritativeWorkflowController
    >[0])).toThrow(/official|OpenAI SDK|adapter/i);
    expect(injected.assertPersistedRecordedBenchmarkPack).not.toHaveBeenCalled();
    expect(() => createAuthoritativeRecordedWorkflowGateway({
      initialSnapshot: snapshot({
        sources: [provisionalDecisionMemo] as unknown as Record<string, unknown>[],
        reviewId: "review_1",
        decisionId: null,
        baselineId: null,
        regressionId: null,
      }),
      authorityOutputDirectory: "/authority",
      projectionOutputDirectory: "/projection",
      initialSources: {
        lockedChallengePack: authority<LockedChallengePack>({}),
        recordedBenchmarkPack: authority<RecordedBenchmarkPack>({
          blind_review_queue: { items: [] },
        }),
        preReviewReceipt: authority<AiPreReviewReceipt>({}),
        provisionalDecisionMemo,
      },
      finalDecisionMemoAdapter: {
        invoke: vi.fn(async () => {
          throw new Error("호출되면 안 됩니다.");
        }),
      },
      recordedRegressionRunner: vi.fn(async () => {
        throw new Error("호출되면 안 됩니다.");
      }),
      loadPersistedRecordedRegression: vi.fn(async () => {
        throw new Error("호출되면 안 됩니다.");
      }),
    } as unknown as Parameters<
      typeof createAuthoritativeRecordedWorkflowGateway
    >[0])).toThrow(/official|OpenAI SDK|adapter/i);
  });
});

// @vitest-environment node

import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ApiArtifactIntegrityError,
  type ChallengeMutationCommand,
} from "../challengeServer";
import {
  buildProjectionSnapshot,
  persistProjectionSnapshot,
  type ProjectionSnapshot,
} from "../projectionRepository";
import {
  createMutableProjectionGateway,
  type ProjectionMutationOperation,
} from "../mutableProjectionGateway";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function snapshot({
  sourceHash,
  reviewId,
  decisionId,
}: {
  readonly sourceHash: string;
  readonly reviewId: string | null;
  readonly decisionId: string | null;
}): ProjectionSnapshot {
  return buildProjectionSnapshot({
    source_chain: [{
      artifact_kind: "RECORDED_BENCHMARK_PACK",
      artifact_id: sourceHash === SHA_A ? "benchmark_a" : "benchmark_b",
      payload_sha256: sourceHash,
    }],
    workspace: {
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
      challenge_id: "challenge_1",
      benchmark_id: "benchmark_1",
      review_id: reviewId,
      decision_id: decisionId,
      baseline_id: null,
      regression_id: null,
      source_hash: sourceHash,
      stage_statuses: {
        define: "LOCKED",
        compare: "RECORDED",
        decide: reviewId === null ? "HUMAN CONFIRMED REVIEW" : "USER CONFIRMATION REQUIRED",
        monitor: "NO BASELINE",
      },
    },
    challenges: [{
      schema_version: "challenge-public-projection-v1",
      synthetic: true,
      challenge_id: "challenge_1",
      source_hash: sourceHash,
    }],
    evidence: [],
    benchmark_progress: [{
      schema_version: "benchmark-progress-projection-v1",
      synthetic: true,
      benchmark_id: "benchmark_1",
      source_hash: sourceHash,
    }],
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
    baselines: [],
    regressions: [],
  });
}

function command(sourceHash: string): ChallengeMutationCommand {
  return {
    schema_version: "review-confirmation-command-v1",
    target_id: "review_1",
    expected_source_hash: sourceHash,
    idempotency_key: "mutation_review_001",
    payload: { action: "ACCEPT_ALL" },
  };
}

describe("가변 권위 projection gateway", () => {
  it("현재 source hash와 target을 검증한 뒤 영속화된 다음 snapshot으로만 전환한다", async () => {
    const initial = snapshot({
      sourceHash: SHA_A,
      reviewId: "review_1",
      decisionId: null,
    });
    const next = snapshot({
      sourceHash: SHA_B,
      reviewId: null,
      decisionId: "decision_1",
    });
    const outputDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "mutable-projection-next-"),
    ));
    const persisted = await persistProjectionSnapshot({
      outputDirectory,
      snapshot: next,
    });
    const confirmReview: ProjectionMutationOperation = vi.fn(async ({
      command: received,
      currentSnapshot,
    }) => {
      expect(received.target_id).toBe("review_1");
      expect(currentSnapshot).toBe(initial);
      return {
        nextSnapshotPath: persisted.path,
      };
    });
    const gateway = createMutableProjectionGateway({
      initialSnapshot: initial,
      operations: { confirmReview },
      transitionVerifiers: {
        confirmReview: ({ nextSnapshot }) => {
          expect(nextSnapshot.snapshot_id).toBe(next.snapshot_id);
        },
      },
    });

    await expect(gateway.confirmReview(command(SHA_A))).resolves.toEqual({
      accepted: true,
      source_hash: SHA_B,
    });
    expect(await gateway.getWorkspace()).toStrictEqual(
      next.projections.workspace,
    );
    expect(await gateway.getBlindReview("review_1")).toBeNull();
    expect(await gateway.getDecision("decision_1")).toStrictEqual(
      next.projections.decisions[0],
    );
  });

  it("stale source와 현재 workspace에 없는 target은 operation 전에 거부한다", async () => {
    const initial = snapshot({
      sourceHash: SHA_A,
      reviewId: "review_1",
      decisionId: null,
    });
    const confirmReview = vi.fn<ProjectionMutationOperation>();
    const gateway = createMutableProjectionGateway({
      initialSnapshot: initial,
      operations: { confirmReview },
      transitionVerifiers: {
        confirmReview: () => {
          throw new Error("operation 전에 거부되어야 합니다.");
        },
      },
    });

    await expect(gateway.confirmReview(command(SHA_B))).rejects.toMatchObject({
      code: "STALE_SOURCE",
    });
    await expect(gateway.confirmReview({
      ...command(SHA_A),
      target_id: "review_forged",
    })).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY",
    });
    expect(confirmReview).not.toHaveBeenCalled();
  });

  it("operation 실패나 재검증되지 않는 다음 snapshot에서는 기존 읽기 상태를 유지한다", async () => {
    const initial = snapshot({
      sourceHash: SHA_A,
      reviewId: "review_1",
      decisionId: null,
    });
    const failed = createMutableProjectionGateway({
      initialSnapshot: initial,
      operations: {
        confirmReview: async () => {
          throw new Error("side effect failed");
        },
      },
      transitionVerifiers: {
        confirmReview: () => {
          throw new Error("operation 실패 뒤 verifier를 실행하면 안 됩니다.");
        },
      },
    });
    await expect(failed.confirmReview(command(SHA_A))).rejects.toThrow(
      /side effect failed/i,
    );
    expect(await failed.getWorkspace()).toBe(initial.projections.workspace);

    const unchanged = createMutableProjectionGateway({
      initialSnapshot: initial,
      operations: {
        confirmReview: async () => {
          const outputDirectory = await realpath(await mkdtemp(
            join(tmpdir(), "mutable-projection-unchanged-"),
          ));
          const persisted = await persistProjectionSnapshot({
            outputDirectory,
            snapshot: initial,
          });
          return {
            nextSnapshotPath: persisted.path,
          };
        },
      },
      transitionVerifiers: {
        confirmReview: ({ nextSnapshot }) => {
          expect(nextSnapshot.snapshot_id).toBe(initial.snapshot_id);
        },
      },
    });
    await expect(unchanged.confirmReview(command(SHA_A))).rejects.toBeInstanceOf(
      ApiArtifactIntegrityError,
    );
    expect(await unchanged.getWorkspace()).toBe(
      initial.projections.workspace,
    );
  });

  it("operation이 선언한 권위 snapshot ID와 디스크에서 재로드한 snapshot이 다르면 전환하지 않는다", async () => {
    const initial = snapshot({
      sourceHash: SHA_A,
      reviewId: "review_1",
      decisionId: null,
    });
    const expected = snapshot({
      sourceHash: SHA_B,
      reviewId: null,
      decisionId: "decision_expected",
    });
    const substituted = snapshot({
      sourceHash: SHA_B,
      reviewId: null,
      decisionId: "decision_substituted",
    });
    const outputDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "mutable-projection-substitution-"),
    ));
    const persisted = await persistProjectionSnapshot({
      outputDirectory,
      snapshot: substituted,
    });
    const gateway = createMutableProjectionGateway({
      initialSnapshot: initial,
      operations: {
        confirmReview: async () => ({
          nextSnapshotPath: persisted.path,
        }),
      },
      transitionVerifiers: {
        confirmReview: ({ nextSnapshot }) => {
          if (nextSnapshot.snapshot_id !== expected.snapshot_id) {
            throw new ApiArtifactIntegrityError(
              "ARTIFACT_INTEGRITY",
              "권위 artifact 재빌드 결과와 다릅니다.",
            );
          }
        },
      },
    });

    await expect(gateway.confirmReview(command(SHA_A))).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY",
    });
    expect(await gateway.getWorkspace()).toBe(
      initial.projections.workspace,
    );
  });

  it("상태 변경 operation과 독립된 transition verifier가 없으면 gateway 구성을 거부한다", () => {
    const initial = snapshot({
      sourceHash: SHA_A,
      reviewId: "review_1",
      decisionId: null,
    });
    expect(() => createMutableProjectionGateway({
      initialSnapshot: initial,
      operations: {
        confirmReview: async () => {
          throw new Error("호출되면 안 됩니다.");
        },
      },
      transitionVerifiers: {},
    })).toThrow(/verifier|검증|transition|권위/i);
  });
});

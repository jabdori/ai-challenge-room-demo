import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  reset,
  type D1Migration,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AuthFailureRecord,
  DemoArtifactReference,
  DemoDecisionMemoRecord,
  DemoExecutionRecord,
  DemoHumanReviewRecord,
  DemoSessionRecord,
} from "../../server/sites/demoContracts";
import {
  D1DemoStateRepository,
  type DemoExecutionClaimOptions,
} from "../../server/sites/d1DemoStateRepository";
import {
  InMemoryDemoStateRepository,
} from "../../server/sites/inMemoryDemoStateRepository";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

const NOW = Date.UTC(2026, 6, 19, 12);
const BUDGET_BUCKET = Date.UTC(2026, 6, 19);

function publicProjectionReference(seed: string): DemoArtifactReference {
  const sha256 = seed.repeat(64).slice(0, 64);
  return {
    namespace: "candidate-evidence",
    objectKey: `candidate-evidence/sha256/${sha256}.json`,
    sha256,
    byteLength: 128,
  };
}

function cleanupReceiptReference(seed: string): DemoArtifactReference {
  const sha256 = seed.repeat(64).slice(0, 64);
  return {
    namespace: "cleanup-receipts",
    objectKey: `cleanup-receipts/sha256/${sha256}.json`,
    sha256,
    byteLength: 96,
  };
}

function session(
  digest: string,
  overrides: Partial<DemoSessionRecord> = {},
): DemoSessionRecord {
  return {
    sessionTokenDigest: digest,
    createdAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    revokedAtMs: null,
    successfulLiveRuns: 0,
    operationalRetryCount: 0,
    currentExecutionId: null,
    ...overrides,
  };
}

function execution(
  executionId: string,
  sessionTokenDigest: string,
  overrides: Partial<DemoExecutionRecord> = {},
): DemoExecutionRecord {
  return {
    executionId,
    sessionTokenDigest,
    idempotencyKey: `idempotency-${executionId}`,
    source: "LIVE",
    status: "READY",
    progressStep: "ENVIRONMENT_PREPARING",
    currentCandidate: null,
    completedCandidateCount: 0,
    createdAtMs: NOW,
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
    sourceHash: `source-${executionId}`,
    stateVersion: 0,
    ...overrides,
  };
}

function claim(
  executionId: string,
  sessionTokenDigest: string,
  leaseTokenDigest: string,
  overrides: Partial<DemoExecutionClaimOptions> = {},
): DemoExecutionClaimOptions {
  return {
    executionId,
    sessionTokenDigest,
    expectedSourceHash: `source-${executionId}`,
    expectedStateVersion: 0,
    leaseTokenDigest,
    nowMs: NOW + 1,
    leaseExpiresAtMs: NOW + 30_000,
    budgetBucketStartedAtMs: BUDGET_BUCKET,
    reservedCostMicroUsd: 20_000,
    maxSuccessfulRunsPerSession: 1,
    maxOperationalRetriesPerSession: 1,
    maxGlobalConcurrentRuns: 2,
    maxBucketRunCount: 10,
    maxBucketCostMicroUsd: 1_000_000,
    isOperationalRetry: false,
    ...overrides,
  };
}

async function createExecutionAtState(
  repository: D1DemoStateRepository | InMemoryDemoStateRepository,
  executionId: string,
  sessionTokenDigest: string,
  status: DemoExecutionRecord["status"],
  progressStep: string,
): Promise<DemoExecutionRecord> {
  const initial = execution(executionId, sessionTokenDigest);
  await repository.createExecution(initial);
  return repository.updateExecution({
    ...initial,
    status,
    progressStep,
  }, {
    expectedSourceHash: initial.sourceHash,
    expectedStateVersion: 0,
    expectedStatus: "READY",
  });
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("D1 권위 상태 repository", () => {
  it("Judge와 Memo 호출 시도를 세션과 종류를 넘어 같은 시간 bucket에서 원자적으로 제한한다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    await repository.createSession(session("session-auxiliary-a"));
    await repository.createSession(session("session-auxiliary-b"));
    await createExecutionAtState(
      repository,
      "execution-auxiliary-a",
      "session-auxiliary-a",
      "RESULTS_READY",
      "JUDGE_RUNNING",
    );
    await createExecutionAtState(
      repository,
      "execution-auxiliary-b",
      "session-auxiliary-b",
      "MEMO_RUNNING",
      "MEMO_RUNNING",
    );

    const outcomes = await Promise.all([
      repository.reserveAuxiliaryCallAttempt({
        executionId: "execution-auxiliary-a",
        sessionTokenDigest: "session-auxiliary-a",
        expectedSourceHash: "source-execution-auxiliary-a",
        expectedStateVersion: 1,
        expectedStatus: "RESULTS_READY",
        expectedProgressStep: "JUDGE_RUNNING",
        kind: "JUDGE",
        attemptNumber: 1,
        bucketStartedAtMs: BUDGET_BUCKET,
        reservedAtMs: NOW + 1,
        maxAttemptsPerBucket: 1,
      }),
      repository.reserveAuxiliaryCallAttempt({
        executionId: "execution-auxiliary-b",
        sessionTokenDigest: "session-auxiliary-b",
        expectedSourceHash: "source-execution-auxiliary-b",
        expectedStateVersion: 1,
        expectedStatus: "MEMO_RUNNING",
        expectedProgressStep: "MEMO_RUNNING",
        kind: "MEMO",
        attemptNumber: 1,
        bucketStartedAtMs: BUDGET_BUCKET,
        reservedAtMs: NOW + 2,
        maxAttemptsPerBucket: 1,
      }),
    ]);
    expect(outcomes.filter((result) => result.outcome === "RESERVED"))
      .toHaveLength(1);
    expect(outcomes.filter((result) => result.outcome === "LIMIT_REACHED"))
      .toHaveLength(1);
  });

  it("동일 실행·종류·시도는 한 번만 예약하고 실패 완료 뒤에도 소비한 전역 count를 되돌리지 않는다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    await repository.createSession(session("session-auxiliary-idempotent"));
    await repository.createSession(session("session-auxiliary-after-failure"));
    await createExecutionAtState(
      repository,
      "execution-auxiliary-idempotent",
      "session-auxiliary-idempotent",
      "RESULTS_READY",
      "JUDGE_RUNNING",
    );
    await createExecutionAtState(
      repository,
      "execution-auxiliary-after-failure",
      "session-auxiliary-after-failure",
      "RESULTS_READY",
      "JUDGE_RUNNING",
    );
    const reservation = {
      executionId: "execution-auxiliary-idempotent",
      sessionTokenDigest: "session-auxiliary-idempotent",
      expectedSourceHash: "source-execution-auxiliary-idempotent",
      expectedStateVersion: 1,
      expectedStatus: "RESULTS_READY" as const,
      expectedProgressStep: "JUDGE_RUNNING",
      kind: "JUDGE" as const,
      attemptNumber: 1 as const,
      bucketStartedAtMs: BUDGET_BUCKET,
      reservedAtMs: NOW + 1,
      maxAttemptsPerBucket: 1,
    };

    await expect(repository.reserveAuxiliaryCallAttempt(reservation))
      .resolves.toMatchObject({ outcome: "RESERVED" });
    await expect(repository.reserveAuxiliaryCallAttempt(reservation))
      .resolves.toEqual({ outcome: "ALREADY_RESERVED" });
    await expect(repository.completeAuxiliaryCallAttempt({
      executionId: reservation.executionId,
      sessionTokenDigest: reservation.sessionTokenDigest,
      expectedSourceHash: reservation.expectedSourceHash,
      expectedStateVersion: 99,
      kind: reservation.kind,
      attemptNumber: reservation.attemptNumber,
      outcome: "COMPLETE",
      completedAtMs: NOW + 2,
      errorCode: null,
    })).resolves.toBe(false);
    await expect(repository.reserveAuxiliaryCallAttempt({
      executionId: "execution-auxiliary-after-failure",
      sessionTokenDigest: "session-auxiliary-after-failure",
      expectedSourceHash: "source-execution-auxiliary-after-failure",
      expectedStateVersion: 1,
      expectedStatus: "RESULTS_READY",
      expectedProgressStep: "JUDGE_RUNNING",
      kind: "JUDGE",
      attemptNumber: 1,
      bucketStartedAtMs: BUDGET_BUCKET,
      reservedAtMs: NOW + 3,
      maxAttemptsPerBucket: 1,
    })).resolves.toEqual({ outcome: "LIMIT_REACHED" });
    await expect(repository.completeAuxiliaryCallAttempt({
      executionId: reservation.executionId,
      sessionTokenDigest: reservation.sessionTokenDigest,
      expectedSourceHash: reservation.expectedSourceHash,
      expectedStateVersion: reservation.expectedStateVersion,
      kind: reservation.kind,
      attemptNumber: reservation.attemptNumber,
      outcome: "FAILED",
      completedAtMs: NOW + 2,
      errorCode: "AUXILIARY_PROVIDER_FAILURE",
    })).resolves.toBe(true);
    await expect(repository.readAuxiliaryCallAttempt(
      reservation.executionId,
      reservation.kind,
      reservation.attemptNumber,
    )).resolves.toMatchObject({
      status: "FAILED",
      errorCode: "AUXILIARY_PROVIDER_FAILURE",
    });
  });

  it("보조 호출 예약은 현재 실행의 owner·source·state·단계가 다르면 stale로 거부하고 memory fake도 같은 결과를 낸다", async () => {
    for (const repository of [
      new D1DemoStateRepository(env.DB),
      new InMemoryDemoStateRepository(),
    ]) {
      const suffix = repository instanceof D1DemoStateRepository
        ? "d1"
        : "memory";
      await repository.createSession(session(`session-auxiliary-${suffix}`));
      await createExecutionAtState(
        repository,
        `execution-auxiliary-${suffix}`,
        `session-auxiliary-${suffix}`,
        "RESULTS_READY",
        "JUDGE_RUNNING",
      );

      await expect(repository.reserveAuxiliaryCallAttempt({
        executionId: `execution-auxiliary-${suffix}`,
        sessionTokenDigest: `session-auxiliary-${suffix}`,
        expectedSourceHash: "wrong-source",
        expectedStateVersion: 1,
        expectedStatus: "RESULTS_READY",
        expectedProgressStep: "JUDGE_RUNNING",
        kind: "JUDGE",
        attemptNumber: 1,
        bucketStartedAtMs: BUDGET_BUCKET,
        reservedAtMs: NOW + 1,
        maxAttemptsPerBucket: 2,
      })).resolves.toEqual({ outcome: "STALE" });
    }
  });

  it("같은 idempotency key의 동시 생성 중 하나만 성공한다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    await repository.createSession(session("session-idempotency-a"));
    await repository.createSession(session("session-idempotency-b"));
    const first = execution("execution-idempotency-a", "session-idempotency-a", {
      idempotencyKey: "shared-idempotency-key",
    });
    const second = execution("execution-idempotency-b", "session-idempotency-b", {
      idempotencyKey: "shared-idempotency-key",
    });

    const outcomes = await Promise.allSettled([
      repository.createExecution(first),
      repository.createExecution(second),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled"))
      .toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected"))
      .toHaveLength(1);
  });

  it("같은 READY 실행의 동시 claim 중 하나만 RUNNING을 얻는다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    await repository.createSession(session("session-claim"));
    await repository.createExecution(execution("execution-claim", "session-claim"));

    const [first, second] = await Promise.all([
      repository.claimExecution(claim(
        "execution-claim",
        "session-claim",
        "lease-first",
      )),
      repository.claimExecution(claim(
        "execution-claim",
        "session-claim",
        "lease-second",
      )),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await repository.readExecution("execution-claim")).toMatchObject({
      status: "RUNNING",
      startedAtMs: NOW + 1,
      heartbeatAtMs: NOW + 1,
    });
  });

  it("세션 성공 횟수와 운영 retry cap을 claim 경계에서 강제한다", async () => {
    const successRepository = new D1DemoStateRepository(env.DB);
    await successRepository.createSession(session("session-success-cap", {
      successfulLiveRuns: 1,
    }));
    await successRepository.createExecution(
      execution("execution-success-cap", "session-success-cap"),
    );
    await expect(successRepository.claimExecution(claim(
      "execution-success-cap",
      "session-success-cap",
      "lease-success-cap",
    ))).resolves.toBeNull();

    await successRepository.createSession(session("session-retry-cap", {
      operationalRetryCount: 1,
    }));
    await successRepository.createExecution(
      execution("execution-retry-cap", "session-retry-cap"),
    );
    await expect(successRepository.claimExecution(claim(
      "execution-retry-cap",
      "session-retry-cap",
      "lease-retry-cap",
      { isOperationalRetry: true },
    ))).resolves.toBeNull();
  });

  it("전역 동시 실행 cap을 권위 claim에서 강제한다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    await repository.createSession(session("session-global-a"));
    await repository.createSession(session("session-global-b"));
    await repository.createExecution(
      execution("execution-global-a", "session-global-a"),
    );
    await repository.createExecution(
      execution("execution-global-b", "session-global-b"),
    );

    const first = await repository.claimExecution(claim(
      "execution-global-a",
      "session-global-a",
      "lease-global-a",
      { maxGlobalConcurrentRuns: 1 },
    ));
    const second = await repository.claimExecution(claim(
      "execution-global-b",
      "session-global-b",
      "lease-global-b",
      { maxGlobalConcurrentRuns: 1 },
    ));

    expect(first?.status).toBe("RUNNING");
    expect(second).toBeNull();
  });

  it("예약 비용을 실제 비용으로 조정하고 실패한 호출 비용도 보존한다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    await repository.createSession(session("session-budget"));
    await repository.createExecution(
      execution("execution-budget", "session-budget"),
    );
    await repository.claimExecution(claim(
      "execution-budget",
      "session-budget",
      "lease-budget",
      { reservedCostMicroUsd: 40_000 },
    ));

    expect(await repository.readUsageBudget(BUDGET_BUCKET)).toMatchObject({
      reservedRunCount: 1,
      confirmedRunCount: 0,
      reservedCostMicroUsd: 40_000,
      confirmedCostMicroUsd: 0,
    });

    await repository.reconcileExecutionCost({
      executionId: "execution-budget",
      expectedSourceHash: "source-execution-budget",
      reconciliationToken: "reconcile-budget",
      budgetBucketStartedAtMs: BUDGET_BUCKET,
      reservedCostMicroUsd: 40_000,
      actualCostMicroUsd: 17_500,
      failedRequestCostMicroUsd: 2_500,
      completedSuccessfully: true,
      sessionTokenDigest: "session-budget",
      leaseTokenDigest: "lease-budget",
      expectedStateVersion: 1,
      nowMs: NOW + 10_000,
    });

    expect(await repository.readUsageBudget(BUDGET_BUCKET)).toEqual({
      bucketStartedAtMs: BUDGET_BUCKET,
      reservedRunCount: 0,
      confirmedRunCount: 1,
      reservedCostMicroUsd: 0,
      confirmedCostMicroUsd: 17_500,
      failedRequestCostMicroUsd: 2_500,
      updatedAtMs: NOW + 10_000,
    });
    expect(await repository.readSession("session-budget")).toMatchObject({
      successfulLiveRuns: 1,
      currentExecutionId: "execution-budget",
    });
  });

  it("실패 비용 정산 뒤에도 최신 실행과 cleanup 증거를 새 repository가 복원한다", async () => {
    const first = new D1DemoStateRepository(env.DB);
    await first.createSession(session("session-failed-hydration"));
    await first.createExecution(execution(
      "execution-failed-hydration",
      "session-failed-hydration",
    ));
    const claimed = await first.claimExecution(claim(
      "execution-failed-hydration",
      "session-failed-hydration",
      "lease-failed-hydration",
    ));
    const cleanupReference = cleanupReceiptReference("f");
    const withCleanup = await first.updateExecution({
      ...claimed!,
      progressStep: "REMOTE_CLEANUP_FINISHED",
      errorCode: "FAILED_PLATFORM",
      cleanupStatus: "ACKNOWLEDGED",
      cleanupReceiptReference: cleanupReference,
    }, {
      expectedSourceHash: "source-execution-failed-hydration",
      expectedStateVersion: 1,
      expectedStatus: "RUNNING",
    });

    await expect(first.reconcileExecutionCost({
      executionId: "execution-failed-hydration",
      sessionTokenDigest: "session-failed-hydration",
      expectedSourceHash: "source-execution-failed-hydration",
      expectedStateVersion: withCleanup.stateVersion,
      leaseTokenDigest: "lease-failed-hydration",
      reconciliationToken: "reconcile-failed-hydration",
      budgetBucketStartedAtMs: BUDGET_BUCKET,
      reservedCostMicroUsd: 20_000,
      actualCostMicroUsd: 8_000,
      failedRequestCostMicroUsd: 8_000,
      completedSuccessfully: false,
      nowMs: NOW + 10_000,
    })).resolves.toBe(true);

    const reloaded = new D1DemoStateRepository(env.DB);
    await expect(reloaded.readSession("session-failed-hydration"))
      .resolves.toMatchObject({
        successfulLiveRuns: 0,
        currentExecutionId: "execution-failed-hydration",
      });
    await expect(reloaded.readOwnedExecution(
      "execution-failed-hydration",
      "session-failed-hydration",
    )).resolves.toMatchObject({
      status: "FAILED",
      errorCode: "FAILED_PLATFORM",
      cleanupStatus: "ACKNOWLEDGED",
      cleanupReceiptReference: cleanupReference,
      actualCostMicroUsd: 8_000,
    });

    await reloaded.createExecution(execution(
      "execution-after-failure",
      "session-failed-hydration",
      { createdAtMs: NOW + 20_000 },
    ));
    await expect(reloaded.readSession("session-failed-hydration"))
      .resolves.toMatchObject({
        currentExecutionId: "execution-after-failure",
      });
  });

  it("claim lease가 만료된 뒤에는 interrupter 전이라도 비용 확정과 상태 승격을 거부한다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    await repository.createSession(session("session-expired-lease"));
    await repository.createExecution(
      execution("execution-expired-lease", "session-expired-lease"),
    );
    await repository.claimExecution(claim(
      "execution-expired-lease",
      "session-expired-lease",
      "lease-expired",
      {
        leaseExpiresAtMs: NOW + 100,
        reservedCostMicroUsd: 30_000,
      },
    ));

    await expect(repository.reconcileExecutionCost({
      executionId: "execution-expired-lease",
      sessionTokenDigest: "session-expired-lease",
      expectedSourceHash: "source-execution-expired-lease",
      expectedStateVersion: 1,
      leaseTokenDigest: "lease-expired",
      reconciliationToken: "reconcile-expired-lease",
      budgetBucketStartedAtMs: BUDGET_BUCKET,
      reservedCostMicroUsd: 30_000,
      actualCostMicroUsd: 12_000,
      failedRequestCostMicroUsd: 0,
      completedSuccessfully: true,
      nowMs: NOW + 101,
    })).resolves.toBe(false);
    await expect(repository.readExecution("execution-expired-lease"))
      .resolves.toMatchObject({
        status: "RUNNING",
        stateVersion: 1,
        actualCostMicroUsd: 0,
      });
    await expect(repository.readUsageBudget(BUDGET_BUCKET))
      .resolves.toMatchObject({
        reservedRunCount: 1,
        confirmedRunCount: 0,
        reservedCostMicroUsd: 30_000,
        confirmedCostMicroUsd: 0,
      });
  });

  it("source hash가 stale인 상태 변경을 거부한다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    await repository.createSession(session("session-stale"));
    const original = execution("execution-stale", "session-stale");
    await repository.createExecution(original);

    await expect(repository.updateExecution({
      ...original,
      progressStep: "CANDIDATE_A_RUNNING",
    }, {
      expectedSourceHash: "not-the-current-source-hash",
      expectedStateVersion: 0,
      expectedStatus: "READY",
    })).rejects.toThrow("STALE_EXECUTION_STATE");
    expect(await repository.readExecution("execution-stale")).toMatchObject({
      progressStep: "ENVIRONMENT_PREPARING",
      sourceHash: "source-execution-stale",
    });
  });

  it("memory fake도 실패·중단 실행을 최신 포인터로 유지한다", async () => {
    const repository = new InMemoryDemoStateRepository();
    await repository.createSession(session("memory-failed-hydration"));
    await repository.createExecution(execution(
      "memory-execution-failed",
      "memory-failed-hydration",
    ));
    await repository.claimExecution(claim(
      "memory-execution-failed",
      "memory-failed-hydration",
      "memory-lease-failed",
    ));
    await expect(repository.reconcileExecutionCost({
      executionId: "memory-execution-failed",
      sessionTokenDigest: "memory-failed-hydration",
      expectedSourceHash: "source-memory-execution-failed",
      expectedStateVersion: 1,
      leaseTokenDigest: "memory-lease-failed",
      reconciliationToken: "memory-reconcile-failed",
      budgetBucketStartedAtMs: BUDGET_BUCKET,
      reservedCostMicroUsd: 20_000,
      actualCostMicroUsd: 5_000,
      failedRequestCostMicroUsd: 5_000,
      completedSuccessfully: false,
      nowMs: NOW + 10_000,
    })).resolves.toBe(true);
    await expect(repository.readSession("memory-failed-hydration"))
      .resolves.toMatchObject({
        currentExecutionId: "memory-execution-failed",
      });

    await repository.createSession(session("memory-interrupted-hydration"));
    await repository.createExecution(execution(
      "memory-execution-interrupted",
      "memory-interrupted-hydration",
    ));
    await repository.claimExecution(claim(
      "memory-execution-interrupted",
      "memory-interrupted-hydration",
      "memory-lease-interrupted",
      {
        nowMs: NOW,
        leaseExpiresAtMs: NOW + 100,
      },
    ));
    await expect(repository.interruptStaleExecutions({
      nowMs: NOW + 10_000,
      staleBeforeMs: NOW + 1_000,
    })).resolves.toBe(1);
    await expect(repository.readSession("memory-interrupted-hydration"))
      .resolves.toMatchObject({
        currentExecutionId: "memory-execution-interrupted",
      });
    await expect(repository.readOwnedExecution(
      "memory-execution-interrupted",
      "memory-interrupted-hydration",
    )).resolves.toMatchObject({
      status: "INTERRUPTED",
      errorCode: "STALE_HEARTBEAT",
    });
  });

  it("만료되거나 폐기된 세션에는 실행을 만들지 않는다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    await repository.createSession(session("session-expired", {
      expiresAtMs: NOW,
    }));
    await expect(repository.createExecution(
      execution("execution-expired", "session-expired", {
        createdAtMs: NOW + 1,
      }),
    )).rejects.toThrow("SESSION_NOT_ACTIVE");

    await repository.createSession(session("session-revoked", {
      revokedAtMs: NOW - 1,
    }));
    await expect(repository.createExecution(
      execution("execution-revoked", "session-revoked"),
    )).rejects.toThrow("SESSION_NOT_ACTIVE");
  });

  it("heartbeat가 stale인 RUNNING 실행을 INTERRUPTED로 고정하고 READY로 되돌리지 않는다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    await repository.createSession(session("session-interrupted"));
    await repository.createExecution(
      execution("execution-interrupted", "session-interrupted"),
    );
    const claimed = await repository.claimExecution(claim(
      "execution-interrupted",
      "session-interrupted",
      "lease-interrupted",
      {
        nowMs: NOW,
        leaseExpiresAtMs: NOW + 100,
      },
    ));
    expect(claimed?.stateVersion).toBe(1);

    const count = await repository.interruptStaleExecutions({
      nowMs: NOW + 10_000,
      staleBeforeMs: NOW + 1_000,
    });

    expect(count).toBe(1);
    expect(await repository.readExecution("execution-interrupted")).toMatchObject({
      status: "INTERRUPTED",
      completedAtMs: NOW + 10_000,
      errorCode: "STALE_HEARTBEAT",
    });
    const reloaded = new D1DemoStateRepository(env.DB);
    expect(await reloaded.readSession("session-interrupted")).toMatchObject({
      currentExecutionId: "execution-interrupted",
    });
    await expect(reloaded.readOwnedExecution(
      "execution-interrupted",
      "session-interrupted",
    )).resolves.toMatchObject({
      status: "INTERRUPTED",
      errorCode: "STALE_HEARTBEAT",
    });

    await expect(repository.updateExecution({
      ...claimed!,
      progressStep: "STALE_WORKER_PROGRESS",
    }, {
      expectedSourceHash: "source-execution-interrupted",
      expectedStateVersion: 1,
      expectedStatus: "RUNNING",
    })).rejects.toThrow("STALE_EXECUTION_STATE");
    await expect(repository.reconcileExecutionCost({
      executionId: "execution-interrupted",
      sessionTokenDigest: "session-interrupted",
      expectedSourceHash: "source-execution-interrupted",
      expectedStateVersion: 1,
      leaseTokenDigest: "lease-interrupted",
      reconciliationToken: "reconcile-after-interrupt",
      budgetBucketStartedAtMs: BUDGET_BUCKET,
      reservedCostMicroUsd: 20_000,
      actualCostMicroUsd: 10_000,
      failedRequestCostMicroUsd: 0,
      completedSuccessfully: true,
      nowMs: NOW + 11_000,
    })).resolves.toBe(false);
    await expect(repository.readExecution("execution-interrupted"))
      .resolves.toMatchObject({
        status: "INTERRUPTED",
        stateVersion: 2,
      });

    await reloaded.createExecution(execution(
      "execution-after-interrupt",
      "session-interrupted",
      { createdAtMs: NOW + 20_000 },
    ));
    await expect(reloaded.readSession("session-interrupted"))
      .resolves.toMatchObject({
        currentExecutionId: "execution-after-interrupt",
      });
  });

  it("실행 조회와 검수 전이는 세션 소유권·source hash·현재 상태를 함께 검사한다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    await repository.createSession(session("session-owner"));
    await repository.createSession(session("session-intruder"));
    await repository.createExecution(execution(
      "execution-owned",
      "session-owner",
      { status: "JUDGE_READY" },
    ));

    await expect(repository.readOwnedExecution(
      "execution-owned",
      "session-owner",
    )).resolves.toMatchObject({ executionId: "execution-owned" });
    await expect(repository.readOwnedExecution(
      "execution-owned",
      "session-intruder",
    )).resolves.toBeNull();

    const reviews: readonly DemoHumanReviewRecord[] = [{
      executionId: "execution-owned",
      blindLabel: "X",
      decision: "PASS",
      rationale: "잠긴 증거와 응답을 확인했습니다.",
      correctedReply: null,
      reviewDurationMs: 4_000,
      editDurationMs: 0,
      confirmedAtMs: NOW + 5_000,
    }];
    await expect(repository.confirmHumanReviews({
      executionId: "execution-owned",
      sessionTokenDigest: "session-intruder",
      expectedSourceHash: "source-execution-owned",
      expectedStateVersion: 0,
      nextStatus: "REVIEW_READY",
      publicProjectionReference: publicProjectionReference("1"),
      reviews,
    })).resolves.toBe(false);
    await expect(repository.readExecution("execution-owned"))
      .resolves.toMatchObject({ status: "JUDGE_READY" });
    await expect(repository.readHumanReviews("execution-owned"))
      .resolves.toEqual([]);

    await expect(repository.confirmHumanReviews({
      executionId: "execution-owned",
      sessionTokenDigest: "session-owner",
      expectedSourceHash: "stale-source",
      expectedStateVersion: 0,
      nextStatus: "REVIEW_READY",
      publicProjectionReference: publicProjectionReference("1"),
      reviews,
    })).resolves.toBe(false);
    await expect(repository.confirmHumanReviews({
      executionId: "execution-owned",
      sessionTokenDigest: "session-owner",
      expectedSourceHash: "source-execution-owned",
      expectedStateVersion: 0,
      nextStatus: "REVIEW_READY",
      publicProjectionReference: publicProjectionReference("1"),
      reviews,
    })).resolves.toBe(true);
    await expect(repository.readExecution("execution-owned"))
      .resolves.toMatchObject({
        status: "REVIEW_READY",
        publicProjectionReference: publicProjectionReference("1"),
      });
    await expect(repository.readHumanReviews("execution-owned"))
      .resolves.toEqual(reviews);
  });

  it("승인 후보 없음은 정상 terminal이며 같은 세션의 후속 실행을 막지 않는다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    await repository.createSession(session("session-no-approved"));
    await repository.createExecution(execution(
      "execution-no-approved",
      "session-no-approved",
      { status: "JUDGE_READY" },
    ));
    await expect(repository.confirmHumanReviews({
      executionId: "execution-no-approved",
      sessionTokenDigest: "session-no-approved",
      expectedSourceHash: "source-execution-no-approved",
      expectedStateVersion: 0,
      nextStatus: "NO_APPROVED_CANDIDATE",
      publicProjectionReference: publicProjectionReference("2"),
      reviews: [{
        executionId: "execution-no-approved",
        blindLabel: "X",
        decision: "CONFIRMED_FAIL",
        rationale: "승인할 수 없는 결정적 실패를 확인했습니다.",
        correctedReply: null,
        reviewDurationMs: 2_000,
        editDurationMs: 0,
        confirmedAtMs: NOW + 1_000,
      }],
    })).resolves.toBe(true);
    await expect(repository.readExecution("execution-no-approved"))
      .resolves.toMatchObject({ status: "NO_APPROVED_CANDIDATE" });

    await expect(repository.createExecution(execution(
      "execution-after-no-approved",
      "session-no-approved",
    ))).resolves.toBeUndefined();
  });

  it("후보 선택과 Memo 상태를 원자 전이하고 실제 source·review·selection hash를 보존한다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    await repository.createSession(session("session-decision"));
    await repository.createSession(session("session-decision-intruder"));
    await repository.createExecution(execution(
      "execution-decision",
      "session-decision",
      { status: "JUDGE_READY" },
    ));
    const reviews: readonly DemoHumanReviewRecord[] = [
      {
        executionId: "execution-decision",
        blindLabel: "X",
        decision: "PASS",
        rationale: "후보 X를 승인합니다.",
        correctedReply: null,
        reviewDurationMs: 3_000,
        editDurationMs: 0,
        confirmedAtMs: NOW + 1_000,
      },
      {
        executionId: "execution-decision",
        blindLabel: "Y",
        decision: "CONFIRMED_FAIL",
        rationale: "후보 Y의 결정적 실패를 확인했습니다.",
        correctedReply: null,
        reviewDurationMs: 3_000,
        editDurationMs: 0,
        confirmedAtMs: NOW + 1_000,
      },
    ];
    await expect(repository.confirmHumanReviews({
      executionId: "execution-decision",
      sessionTokenDigest: "session-decision",
      expectedSourceHash: "source-execution-decision",
      expectedStateVersion: 0,
      nextStatus: "REVIEW_READY",
      publicProjectionReference: publicProjectionReference("3"),
      reviews,
    })).resolves.toBe(true);

    const selection = {
      executionId: "execution-decision",
      candidateId: "B" as const,
      rationale: "통과한 후보 중 가장 단순한 구성을 선택합니다.",
      sourceHash: "source-execution-decision",
      selectedAtMs: NOW + 2_000,
    };
    await expect(repository.recordCandidateSelection({
      executionId: "execution-decision",
      sessionTokenDigest: "session-decision-intruder",
      expectedSourceHash: "source-execution-decision",
      expectedStateVersion: 1,
      publicProjectionReference: publicProjectionReference("4"),
      selection,
    })).resolves.toBe(false);
    await expect(repository.recordCandidateSelection({
      executionId: "execution-decision",
      sessionTokenDigest: "session-decision",
      expectedSourceHash: "source-execution-decision",
      expectedStateVersion: 1,
      publicProjectionReference: publicProjectionReference("4"),
      selection,
    })).resolves.toBe(true);
    await expect(repository.readExecution("execution-decision"))
      .resolves.toMatchObject({ status: "SELECTION_RECORDED" });
    await expect(repository.readSelection("execution-decision"))
      .resolves.toEqual(selection);

    const runningMemo: DemoDecisionMemoRecord = {
      executionId: "execution-decision",
      status: "RUNNING",
      sourcePackHash: "source-execution-decision",
      reviewHash: "r".repeat(64),
      selectionHash: "s".repeat(64),
      artifactReference: null,
      errorCode: null,
      reconciliationReason: null,
      updatedAtMs: NOW + 3_000,
    };
    await expect(repository.beginDecisionMemo({
      executionId: "execution-decision",
      sessionTokenDigest: "session-decision",
      expectedSourceHash: "source-execution-decision",
      expectedStateVersion: 2,
      publicProjectionReference: publicProjectionReference("4"),
      memo: runningMemo,
    })).resolves.toBe(true);
    await expect(repository.readExecution("execution-decision"))
      .resolves.toMatchObject({ status: "MEMO_RUNNING" });

    const completedMemo: DemoDecisionMemoRecord = {
      ...runningMemo,
      status: "READY",
      artifactReference: {
        namespace: "decision-memos",
        objectKey: `decision-memos/sha256/${"a".repeat(64)}.json`,
        sha256: "a".repeat(64),
        byteLength: 321,
      },
      updatedAtMs: NOW + 4_000,
    };
    await expect(repository.completeDecisionMemo({
      executionId: "execution-decision",
      sessionTokenDigest: "session-decision-intruder",
      expectedSourceHash: "source-execution-decision",
      expectedStateVersion: 3,
      publicProjectionReference: publicProjectionReference("5"),
      memo: completedMemo,
    })).resolves.toBe(false);
    await expect(repository.completeDecisionMemo({
      executionId: "execution-decision",
      sessionTokenDigest: "session-decision",
      expectedSourceHash: "source-execution-decision",
      expectedStateVersion: 3,
      publicProjectionReference: publicProjectionReference("5"),
      memo: completedMemo,
    })).resolves.toBe(true);
    await expect(repository.readExecution("execution-decision"))
      .resolves.toMatchObject({
        status: "MEMO_READY",
        publicProjectionReference: publicProjectionReference("5"),
      });
    await expect(repository.readMemoState("execution-decision"))
      .resolves.toEqual(completedMemo);
  });

  it("Memo 생성 실패도 선택을 유지한 채 MEMO_FAILED와 재조정 사유를 함께 기록한다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    await repository.createSession(session("session-memo-failure"));
    await repository.createExecution(execution(
      "execution-memo-failure",
      "session-memo-failure",
      { status: "SELECTION_RECORDED" },
    ));
    const selection = {
      executionId: "execution-memo-failure",
      candidateId: "A" as const,
      rationale: "검수에서 승인된 가장 단순한 후보입니다.",
      sourceHash: "source-execution-memo-failure",
      selectedAtMs: NOW + 1_000,
    };
    await repository.saveSelection(
      selection,
      "source-execution-memo-failure",
    );
    const runningMemo: DemoDecisionMemoRecord = {
      executionId: "execution-memo-failure",
      status: "RUNNING",
      sourcePackHash: "source-execution-memo-failure",
      reviewHash: "b".repeat(64),
      selectionHash: "c".repeat(64),
      artifactReference: null,
      errorCode: null,
      reconciliationReason: null,
      updatedAtMs: NOW + 2_000,
    };
    await repository.beginDecisionMemo({
      executionId: "execution-memo-failure",
      sessionTokenDigest: "session-memo-failure",
      expectedSourceHash: "source-execution-memo-failure",
      expectedStateVersion: 0,
      publicProjectionReference: publicProjectionReference("6"),
      memo: runningMemo,
    });
    const failedMemo: DemoDecisionMemoRecord = {
      ...runningMemo,
      status: "FAILED",
      errorCode: "BASELINE_NOT_CREATED",
      reconciliationReason:
        "Memo 생성 실패로 선택은 유지하고 기준선은 만들지 않았습니다.",
      updatedAtMs: NOW + 3_000,
    };

    await expect(repository.completeDecisionMemo({
      executionId: "execution-memo-failure",
      sessionTokenDigest: "session-memo-failure",
      expectedSourceHash: "source-execution-memo-failure",
      expectedStateVersion: 1,
      publicProjectionReference: publicProjectionReference("7"),
      memo: failedMemo,
    })).resolves.toBe(true);
    await expect(repository.readExecution("execution-memo-failure"))
      .resolves.toMatchObject({ status: "MEMO_FAILED" });
    await expect(repository.readSelection("execution-memo-failure"))
      .resolves.toEqual(selection);
    await expect(repository.readMemoState("execution-memo-failure"))
      .resolves.toEqual(failedMemo);
  });

  it("새 repository instance가 실행·review·selection·memo 권위 상태를 복원한다", async () => {
    const first = new D1DemoStateRepository(env.DB);
    await first.createSession(session("session-hydration"));
    await first.createExecution(
      execution("execution-hydration", "session-hydration"),
    );
    const review: DemoHumanReviewRecord = {
      executionId: "execution-hydration",
      blindLabel: "X",
      decision: "CONFIRMED_FAIL",
      rationale: "정책 약속 문구를 수정해야 합니다.",
      correctedReply: "정책 범위 안에서 확인 후 안내하겠습니다.",
      reviewDurationMs: 4_000,
      editDurationMs: 1_200,
      confirmedAtMs: NOW + 5_000,
    };
    await first.saveHumanReview(review, "source-execution-hydration");
    await first.saveSelection({
      executionId: "execution-hydration",
      candidateId: "B",
      rationale: "정책 근거와 비용의 균형이 충분합니다.",
      sourceHash: "source-execution-hydration",
      selectedAtMs: NOW + 6_000,
    }, "source-execution-hydration");
    const memo: DemoDecisionMemoRecord = {
      executionId: "execution-hydration",
      status: "FAILED",
      sourcePackHash: "source-execution-hydration",
      reviewHash: "h".repeat(64),
      selectionHash: "i".repeat(64),
      artifactReference: null,
      errorCode: "MODEL_UNAVAILABLE",
      reconciliationReason: "Memo provider가 응답하지 않았습니다.",
      updatedAtMs: NOW + 7_000,
    };
    await first.saveMemoState(memo, "source-execution-hydration");

    const reloaded = new D1DemoStateRepository(env.DB);
    await expect(reloaded.readExecution("execution-hydration"))
      .resolves.toMatchObject({ sourceHash: "source-execution-hydration" });
    await expect(reloaded.readHumanReviews("execution-hydration"))
      .resolves.toEqual([review]);
    await expect(reloaded.readSelection("execution-hydration"))
      .resolves.toMatchObject({ candidateId: "B" });
    await expect(reloaded.readMemoState("execution-hydration"))
      .resolves.toEqual(memo);
  });

  it("인증 bucket 최신값과 세션 revoke 계약이 인증 adapter와 일치한다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    await repository.createSession(session("session-auth"));
    const first: AuthFailureRecord = {
      networkFingerprint: "network-hmac",
      bucketStartedAtMs: NOW,
      failureCount: 1,
      blockedUntilMs: null,
    };
    const latest: AuthFailureRecord = {
      networkFingerprint: "network-hmac",
      bucketStartedAtMs: NOW + 60_000,
      failureCount: 3,
      blockedUntilMs: NOW + 180_000,
    };
    await repository.recordAuthFailure(first);
    await repository.recordAuthFailure(latest);

    await expect(repository.readAuthFailure(
      "network-hmac",
      NOW,
    )).resolves.toEqual(first);
    await expect(repository.readLatestAuthFailure("network-hmac"))
      .resolves.toEqual(latest);
    await expect(repository.revokeSession("session-auth", NOW + 1))
      .resolves.toBe(true);
    await expect(repository.readSession("session-auth")).resolves.toMatchObject({
      revokedAtMs: NOW + 1,
    });
  });

  it("동시 인증 실패도 원자적으로 누적하고 임계값에서 차단한다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () => repository.recordAuthFailureAttempt({
        networkFingerprint: "network-atomic-hmac",
        bucketStartedAtMs: NOW,
        attemptedAtMs: NOW + 10,
        failureLimit: 3,
        blockDurationMs: 120_000,
      })),
    );

    expect(attempts.some((record) => record.blockedUntilMs !== null)).toBe(true);
    await expect(repository.readAuthFailure(
      "network-atomic-hmac",
      NOW,
    )).resolves.toEqual({
      networkFingerprint: "network-atomic-hmac",
      bucketStartedAtMs: NOW,
      failureCount: 5,
      blockedUntilMs: NOW + 120_010,
    });
  });

  it("최신 비차단 bucket보다 이전 bucket의 활성 차단을 우선 조회한다", async () => {
    const repository = new D1DemoStateRepository(env.DB);
    const activeBlock: AuthFailureRecord = {
      networkFingerprint: "network-active-block",
      bucketStartedAtMs: NOW,
      failureCount: 3,
      blockedUntilMs: NOW + 120_000,
    };
    await repository.recordAuthFailure(activeBlock);
    await repository.recordAuthFailure({
      networkFingerprint: "network-active-block",
      bucketStartedAtMs: NOW + 60_000,
      failureCount: 1,
      blockedUntilMs: null,
    });

    await expect(repository.readActiveAuthFailure(
      "network-active-block",
      NOW + 61_000,
    )).resolves.toEqual(activeBlock);
  });
});

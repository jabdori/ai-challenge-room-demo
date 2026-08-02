// @vitest-environment node

import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChallengeApiGateway } from "../challengeServer";
import type { ReadOnlyWorkspaceServer } from "../nodeWorkspaceServer";
import {
  createProductionChallengeLifecycleDependencies,
  resolveBenchmarkStartAuthorityReferenceForCheckpoint,
  startAuthoritativeChallengeRoomRuntimeForTest,
  type AuthoritativeChallengeRoomRuntimeDependencies,
} from "../authoritativeChallengeRoomRuntime";
import type {
  AuthoritativeChallengeLifecycleController,
  AuthoritativeChallengeLifecycleDependencies,
} from "../authoritativeChallengeLifecycleController";
import {
  buildDefineStructuringArtifact,
  loadDefineStructuringArtifact,
  persistDefineStructuringArtifact,
} from "../../eval/define/defineStructuringPersistence";
import { runDefineStructuring } from "../../eval/define/runDefineStructuring";
import { SYNTHETIC_CHALLENGE_TEMPLATE } from "../../eval/define/syntheticChallengeDefinition";
import { sha256CanonicalJson } from "../../eval/runtime/canonicalJson";

function noCallLifecycleDependencies(
  events: string[],
): AuthoritativeChallengeLifecycleDependencies {
  const never = async (): Promise<never> => {
    events.push("openai");
    throw new Error("not expected");
  };
  return {
    executeDefineStructure: never,
    assertPersistedDefineArtifact: vi.fn(),
    executeHumanLock: never,
    assertAuthoritativeLockedChallengePack: vi.fn(),
    buildStableBenchmarkId: vi.fn(() => "a".repeat(64)),
    persistStartReceipt: never,
    loadStartReceipt: never,
    loadPersistedProgress: vi.fn(async () => null),
    executeRecordedBenchmark: never,
    assertPersistedRecordedBenchmarkPack: vi.fn(),
    createRecordedReviewGateway: vi.fn(),
    scheduleBackground: vi.fn(),
    now: () => "2026-07-17T12:00:00.000Z",
  };
}

function fakeController(events: string[]): AuthoritativeChallengeLifecycleController {
  const read = async () => ({
    schema_version: "workspace-public-projection-v1",
    synthetic: true,
  });
  const unavailable = async (): Promise<never> => {
    throw new Error("unavailable");
  };
  return {
    getLifecycleSnapshot: unavailable,
    isBenchmarkRunning: () => false,
    getWorkspace: read,
    getChallenge: async () => null,
    getEvidence: async () => null,
    getBenchmarkProgress: async () => null,
    getBlindReview: async () => null,
    getDecision: async () => null,
    getBaseline: async () => null,
    getRegression: async () => null,
    structureDefine: async () => {
      events.push("openai");
      return { accepted: true, source_hash: "a".repeat(64) };
    },
    lockChallenge: unavailable,
    startBenchmark: unavailable,
    confirmReview: unavailable,
    createDecisionMemo: unavailable,
    confirmDecision: unavailable,
    startRegression: unavailable,
  };
}

describe("Authoritative Challenge Room runtime", () => {
  it("RESUME checkpoint가 이전 start 영수증을 새 attempt의 canonical reference로 교체한다", () => {
    const previousReference = {
      path: "/private/runtime/benchmark-start-command/attempt-001.json",
      receipt_hash: "a".repeat(64),
    };
    expect(resolveBenchmarkStartAuthorityReferenceForCheckpoint({
      startReceipt: {
        execution_mode: "RESUME",
        attempt_number: 2,
        previous_start_receipt_hash: previousReference.receipt_hash,
        receipt_hash: "b".repeat(64),
      } as never,
      previousReference,
      persistedPath:
        "/private/runtime/benchmark-start-command/attempt-002.json",
    })).toEqual({
      path: "/private/runtime/benchmark-start-command/attempt-002.json",
      receipt_hash: "b".repeat(64),
    });

    expect(() => resolveBenchmarkStartAuthorityReferenceForCheckpoint({
      startReceipt: {
        execution_mode: "RESUME",
        attempt_number: 2,
        previous_start_receipt_hash: "c".repeat(64),
        receipt_hash: "b".repeat(64),
      } as never,
      previousReference,
      persistedPath:
        "/private/runtime/benchmark-start-command/attempt-002.json",
    })).toThrow(/이전|previous|연결/i);
  });

  it("production 사람 잠금 경로가 비어 있는 authority root에 안전한 Locked Challenge 루트를 준비한다", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "challenge-room-lock-root-")),
    );
    await chmod(root, 0o700);
    const authorityDirectory = join(root, "authority");
    const projectionDirectory = join(root, "projections");
    await mkdir(authorityDirectory, { mode: 0o700 });
    await mkdir(projectionDirectory, { mode: 0o700 });
    const defineDirectory = join(authorityDirectory, "define-structuring");
    await mkdir(defineDirectory, { mode: 0o700 });
    try {
      let timestamp = Date.parse("2026-07-18T00:00:00.000Z");
      const run = await runDefineStructuring({
        adapter: {
          invoke: async () => ({
            responseId: "resp-production-lock-root-test",
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
      const artifact = buildDefineStructuringArtifact({
        input: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
        run,
      });
      const persisted = await persistDefineStructuringArtifact({
        outputDirectory: defineDirectory,
        artifact,
      });
      const reloaded = await loadDefineStructuringArtifact({
        outputDirectory: defineDirectory,
        artifactPath: persisted.path,
        expectedInput: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
      });
      const dependencies = createProductionChallengeLifecycleDependencies({
        environment: {},
        authorityDirectory,
        projectionDirectory,
        createRecordedReviewGateway: async () => {
          throw new Error("이 테스트에서는 호출되면 안 됩니다.");
        },
        now: () => "2026-07-18T00:00:01.000Z",
      });

      await expect(dependencies.executeHumanLock({
        defineArtifact: reloaded as unknown as Parameters<
          typeof dependencies.executeHumanLock
        >[0]["defineArtifact"],
        actorLabel: "Evaluation owner",
        approvedContractHash: sha256CanonicalJson(
          SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract,
        ),
        approvedAt: "2026-07-18T00:00:01.000Z",
      })).resolves.toMatchObject({
        state: "LOCKED",
        authority: "EXPLICIT_HUMAN_APPROVAL",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loopback server를 먼저 listen하고 POST 전에는 OpenAI/Benchmark를 호출하지 않는다", async () => {
    const events: string[] = [];
    const controller = fakeController(events);
    const server: ReadOnlyWorkspaceServer = {
      origin: "http://127.0.0.1:4411",
      close: vi.fn(async () => {
        events.push("close");
      }),
    };
    let capturedGateway: ChallengeApiGateway | null = null;
    const dependencies: AuthoritativeChallengeRoomRuntimeDependencies = {
      createLifecycleDependencies: vi.fn(() => (
        noCallLifecycleDependencies(events)
      )),
      createController: vi.fn(() => {
        events.push("controller");
        return controller;
      }),
      createMutationJournal: vi.fn(() => ({ execute: vi.fn() })),
      startServer: vi.fn(async ({ gateway }) => {
        capturedGateway = gateway;
        events.push("listen");
        return server;
      }),
    };

    const runtime = await startAuthoritativeChallengeRoomRuntimeForTest({
      environment: {},
      staticDirectory: "/tmp/static",
      authorityDirectory: "/tmp/authority",
      port: 0,
      dependencies,
    });

    expect(events).toEqual(["controller", "listen"]);
    expect(runtime.server.origin).toBe("http://127.0.0.1:4411");
    expect(capturedGateway).toBe(controller);
    await capturedGateway!.structureDefine({} as never);
    expect(events).toEqual(["controller", "listen", "openai"]);
  });

  it("동일 controller/gateway를 서버 수명 전체에 유지하고 abort 시 server를 닫는다", async () => {
    const events: string[] = [];
    const controller = fakeController(events);
    const close = vi.fn(async () => {
      events.push("close");
    });
    const abort = new AbortController();
    const dependencies: AuthoritativeChallengeRoomRuntimeDependencies = {
      createLifecycleDependencies: vi.fn(() => (
        noCallLifecycleDependencies(events)
      )),
      createController: vi.fn(() => controller),
      createMutationJournal: vi.fn(() => ({ execute: vi.fn() })),
      startServer: vi.fn(async () => ({
        origin: "http://127.0.0.1:4412",
        close,
      })),
    };

    const runtime = await startAuthoritativeChallengeRoomRuntimeForTest({
      environment: {},
      staticDirectory: "/tmp/static",
      authorityDirectory: "/tmp/authority",
      port: 0,
      signal: abort.signal,
      dependencies,
    });
    expect(runtime.gateway).toBe(controller);

    abort.abort(new Error("test shutdown"));
    await runtime.closed;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("listen 실패 시 runtime을 반환하지 않고 OpenAI를 호출하지 않는다", async () => {
    const events: string[] = [];
    const dependencies: AuthoritativeChallengeRoomRuntimeDependencies = {
      createLifecycleDependencies: vi.fn(() => (
        noCallLifecycleDependencies(events)
      )),
      createController: vi.fn(() => fakeController(events)),
      createMutationJournal: vi.fn(() => ({ execute: vi.fn() })),
      startServer: vi.fn(async () => {
        events.push("listen-failed");
        throw new Error("EADDRINUSE");
      }),
    };

    await expect(startAuthoritativeChallengeRoomRuntimeForTest({
      environment: {},
      staticDirectory: "/tmp/static",
      authorityDirectory: "/tmp/authority",
      port: 0,
      dependencies,
    })).rejects.toThrow(/EADDRINUSE/);
    expect(events).toEqual(["listen-failed"]);
  });
});

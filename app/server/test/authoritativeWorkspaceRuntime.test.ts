// @vitest-environment node

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChallengeApiGateway } from "../challengeServer";

type NodeListener = (
  request: Record<string | symbol, unknown>,
  response: Record<string, unknown>,
) => void;

const httpState = vi.hoisted(() => ({
  listener: null as NodeListener | null,
  closed: false,
  closeCount: 0,
}));

vi.mock("node:http", () => ({
  createServer: (listener: NodeListener) => {
    httpState.listener = listener;
    return {
      once: () => undefined,
      off: () => undefined,
      listen: (_port: number, _host: string, callback: () => void) => callback(),
      address: () => ({
        address: "127.0.0.1",
        family: "IPv4",
        port: 43119,
      }),
      close: (callback: (error?: Error) => void) => {
        httpState.closed = true;
        httpState.closeCount += 1;
        callback();
      },
    };
  },
}));

import {
  AUTHORITATIVE_WORKSPACE_RUNTIME_ENV,
  buildDeterministicAiPreReviewCommand,
  runAuthoritativeWorkspaceProcessForTest,
  startAuthoritativeWorkspaceRuntime,
  startAuthoritativeWorkspaceRuntimeForTest,
  type AuthoritativeWorkspaceRuntimeDependencies,
} from "../authoritativeWorkspaceRuntime";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface CapturedResponse {
  readonly statusCode: number;
  readonly body: Buffer;
}

async function dispatch({
  url,
  method = "GET",
  body,
  headers = {},
}: {
  readonly url: string;
  readonly method?: string;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
}): Promise<CapturedResponse> {
  if (!httpState.listener) throw new Error("Node listener가 준비되지 않았습니다.");
  let statusCode = 200;
  let finish!: (value: CapturedResponse) => void;
  const completed = new Promise<CapturedResponse>((resolve) => {
    finish = resolve;
  });
  const chunks = body === undefined ? [] : [Buffer.from(body)];
  const requestHeaders = body === undefined
    ? {}
    : { "content-type": "application/json", ...headers };
  // requestAbortSignal이 사용하는 IncomingMessage 이벤트·완료 상태 계약을 보존합니다.
  const request = Object.assign(new EventEmitter(), {
    url,
    method,
    headers: requestHeaders,
    socket: { remoteAddress: "127.0.0.1" },
    destroyed: false,
    complete: true,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  });
  const responseHeaders = new Map<string, string | number | readonly string[]>();
  const response = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      responseHeaders.set(name.toLowerCase(), value);
    },
    hasHeader(name: string) {
      return responseHeaders.has(name.toLowerCase());
    },
    writeHead(nextStatus: number) {
      statusCode = nextStatus;
    },
    end(value?: string | Buffer) {
      finish({
        statusCode,
        body: value === undefined
          ? Buffer.alloc(0)
          : Buffer.isBuffer(value) ? value : Buffer.from(value),
      });
    },
  };
  httpState.listener(
    request as unknown as Record<string | symbol, unknown>,
    response,
  );
  return completed;
}

function fakeRecordedBenchmarkPack() {
  return {
    artifact_kind: "RECORDED_BENCHMARK_PACK",
    source: "RECORDED_BENCHMARK",
    execution_status: "EXECUTION_COMPLETE",
    judge_status: "JUDGE_COMPLETE",
    review_status: "REVIEW_PENDING",
    evaluation_status: "EVALUATION_INCOMPLETE",
    baseline_version: null,
    synthetic: true,
    locked_challenge_pack_hash: SHA_A,
    judge_evidence_pack_hash: "b".repeat(64),
    blind_review_queue: {
      queue_status: "READY_FOR_REVIEW",
      items: [
        {
          item_id: "H-001--X",
          deterministic_gate_finding: "CONFIRMED_FAIL",
          deterministic_gate_evidence: [{
            evidence_handle: `evh_${"c".repeat(64)}`,
          }],
          judge_evidence_handle: `evh_${"d".repeat(64)}`,
          judge_risks: [{ severity: "HIGH" }],
        },
        {
          item_id: "H-001--Y",
          deterministic_gate_finding: "NONE",
          deterministic_gate_evidence: [],
          judge_evidence_handle: `evh_${"e".repeat(64)}`,
          judge_risks: [{ severity: "LOW" }],
        },
      ],
    },
  };
}

describe("same-process 권위 workspace runtime", () => {
  it("결정적 gate만 proposed decision을 만들고 Judge는 rationale·evidence로만 남긴다", () => {
    const command = buildDeterministicAiPreReviewCommand({
      recordedBenchmarkPack: fakeRecordedBenchmarkPack() as never,
      reviewedAt: "2026-07-17T04:00:00.000Z",
    });

    expect(command.items).toEqual([
      {
        item_id: "H-001--X",
        proposed_decision: "PROPOSED_CONFIRMED_FAIL",
        rationale: expect.stringMatching(/deterministic.*Judge.*advisory/i),
        evidence_handles: [
          `evh_${"c".repeat(64)}`,
          `evh_${"d".repeat(64)}`,
        ],
      },
      {
        item_id: "H-001--Y",
        proposed_decision: "PROPOSED_PASS",
        rationale: expect.stringMatching(/deterministic.*Judge.*advisory/i),
        evidence_handles: [`evh_${"e".repeat(64)}`],
      },
    ]);
    expect(command.reviewer_label).toMatch(/deterministic/i);
    expect(command.reviewed_at).toBe("2026-07-17T04:00:00.000Z");
  });

  it.each([
    {
      name: "serverAuthority가 null",
      patch: { serverAuthority: null },
    },
    {
      name: "cleanup이 불완전",
      patch: {
        summary: {
          cleanup: {
            required: 33,
            acknowledged: 32,
            incomplete: 1,
            resources: [],
          },
        },
      },
    },
    {
      name: "실행 개수가 72+12가 아님",
      patch: {
        summary: {
          candidate_execution_count: 71,
          auxiliary_judge_count: 12,
        },
      },
    },
    {
      name: "Judge 완료와 사람 fallback 합계가 12가 아님",
      patch: {
        summary: {
          complete_judge_count: 10,
          human_fallback_judge_count: 1,
        },
      },
    },
    {
      name: "cleanup resource evidence가 1+32가 아님",
      patch: {
        summary: {
          cleanup: {
            required: 33,
            acknowledged: 33,
            incomplete: 0,
            resources: [],
            receipt_path: "/synthetic/cleanup-receipt.json",
          },
        },
      },
    },
  ])("$name 이면 listener를 열지 않는다", async ({ patch }) => {
    const fixture = await runtimeFixture();
    const outcome = cleanOutcome(fixture.recordedBenchmarkPack);
    const merged = {
      ...outcome,
      ...patch,
      summary: {
        ...outcome.summary,
        ...("summary" in patch ? patch.summary : {}),
      },
    };
    fixture.dependencies.executeRecordedBenchmark = vi.fn(async () => merged as never);

    await expect(startAuthoritativeWorkspaceRuntimeForTest({
      environment: fixture.environment,
      dependencies: fixture.dependencies,
    })).rejects.toThrow(/Recorded Benchmark|cleanup|72|12|authority/i);

    expect(fixture.dependencies.startServer).not.toHaveBeenCalled();
  });

  it("IncomingMessage 계약을 가진 GET workspace 요청은 200 public projection을 반환한다", async () => {
    const fixture = await runtimeFixture();
    const runtime = await startAuthoritativeWorkspaceRuntimeForTest({
      environment: fixture.environment,
      dependencies: fixture.dependencies,
    });
    servers.push(runtime.server);

    const workspace = await dispatch({ url: "/api/workspace" });
    expect(workspace.statusCode).toBe(200);
    expect(JSON.parse(workspace.body.toString("utf8"))).toMatchObject({
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
      review_id: "review_1",
      source_hash: SHA_A,
    });
  });

  it("같은 권위 root 재시작은 기존 pre-review·provisional Memo를 source-load하고 불변 영수증을 다시 쓰지 않는다", async () => {
    const fixture = await runtimeFixture();
    const loadExistingAiPreReviewReceipt = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(fixture.preReviewReceipt);
    const loadExistingProvisionalDecisionMemo = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(fixture.provisionalDecisionMemo);
    Object.assign(fixture.dependencies, {
      loadExistingAiPreReviewReceipt,
      loadExistingProvisionalDecisionMemo,
    });

    const first = await startAuthoritativeWorkspaceRuntimeForTest({
      environment: fixture.environment,
      dependencies: fixture.dependencies,
      now: () => "2026-07-18T12:00:00.000Z",
    });
    await first.server.close();
    const second = await startAuthoritativeWorkspaceRuntimeForTest({
      environment: fixture.environment,
      dependencies: fixture.dependencies,
      now: () => "2026-07-18T12:00:00.000Z",
    });
    servers.push(second.server);

    expect(second.recordedBenchmarkPackHash)
      .toBe(first.recordedBenchmarkPackHash);
    expect(second.aiPreReviewReceiptHash)
      .toBe(first.aiPreReviewReceiptHash);
    expect(second.provisionalDecisionMemoHash)
      .toBe(first.provisionalDecisionMemoHash);
    expect(loadExistingAiPreReviewReceipt).toHaveBeenCalledTimes(2);
    expect(loadExistingProvisionalDecisionMemo).toHaveBeenCalledTimes(2);
    expect(fixture.dependencies.persistAiPreReviewReceipt)
      .toHaveBeenCalledOnce();
    expect(fixture.dependencies.persistProvisionalDecisionMemo)
      .toHaveBeenCalledOnce();
    expect(fixture.dependencies.buildAiPreReviewReceipt)
      .toHaveBeenCalledOnce();
    expect(fixture.dependencies.buildProvisionalDecisionMemo)
      .toHaveBeenCalledOnce();
  });

  it("source 조립 뒤 실제 FileMutationJournal과 loopback Node server로 GET·mutation·replay 경계를 제공한다", async () => {
    const fixture = await runtimeFixture();
    const runtime = await startAuthoritativeWorkspaceRuntimeForTest({
      environment: fixture.environment,
      dependencies: fixture.dependencies,
    });
    servers.push(runtime.server);

    const workspace = await dispatch({ url: "/api/workspace" });
    expect(workspace.statusCode).toBe(200);
    expect(JSON.parse(workspace.body.toString("utf8"))).toMatchObject({
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
      review_id: "review_1",
      source_hash: SHA_A,
    });

    const command = {
      schema_version: "review-confirmation-command-v1",
      expected_source_hash: SHA_A,
      idempotency_key: "mutation_runtime_e2e",
      payload: {
        action: "ACCEPT_ALL",
        actor_label: "Human reviewer",
        items: [],
      },
    };
    if (runtime.server.reviewerBootstrapUrl === undefined) {
      throw new Error("권위 runtime의 reviewer bootstrap URL이 없습니다.");
    }
    const reviewerToken = new URLSearchParams(
      new URL(runtime.server.reviewerBootstrapUrl).hash.slice(1),
    ).get("reviewer_token");
    if (reviewerToken === null) {
      throw new Error("Reviewer bootstrap fragment에 token이 없습니다.");
    }
    const reviewerHeaders = {
      authorization: `Bearer ${reviewerToken}`,
      host: new URL(runtime.server.origin).host,
      origin: runtime.server.origin,
      "sec-fetch-site": "same-origin",
    };
    const first = await dispatch({
      url: "/api/reviews/review_1/confirm",
      method: "POST",
      body: JSON.stringify(command),
      headers: reviewerHeaders,
    });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body.toString("utf8"))).toEqual({
      accepted: true,
      source_hash: SHA_B,
    });

    const replay = await dispatch({
      url: "/api/reviews/review_1/confirm",
      method: "POST",
      body: JSON.stringify(command),
      headers: reviewerHeaders,
    });
    expect(replay.statusCode).toBe(409);
    expect(JSON.parse(replay.body.toString("utf8"))).toEqual({
      error: "REPLAYED_MUTATION",
    });

    const intentPath = join(
      fixture.runtimeRoot,
      "mutation-journal",
      "mutation_runtime_e2e",
      "mutation--intent.json",
    );
    const receiptPath = join(
      fixture.runtimeRoot,
      "mutation-journal",
      "mutation_runtime_e2e",
      "mutation--receipt.json",
    );
    expect((await lstat(intentPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(receiptPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(receiptPath, "utf8")).not.toContain(
      fixture.environment.OPENAI_API_KEY!,
    );

    expect(fixture.dependencies.createFinalDecisionMemoAdapter)
      .toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.createRecordedRegressionRunner)
      .toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.createGateway).toHaveBeenCalledTimes(1);
  });

  it("blocked pre-review이면 projection·listener를 만들지 않는다", async () => {
    const fixture = await runtimeFixture();
    fixture.dependencies.buildAiPreReviewReceipt = vi.fn(() => ({
      ...fixture.preReviewReceipt,
      pre_review_status: "USER_CONFIRMATION_BLOCKED",
      blocking_reasons: ["EVIDENCE_CONFLICT"],
    }) as never);

    await expect(startAuthoritativeWorkspaceRuntimeForTest({
      environment: fixture.environment,
      dependencies: fixture.dependencies,
    })).rejects.toThrow(/pre-review.*blocked|USER_CONFIRMATION_BLOCKED/i);

    expect(fixture.dependencies.persistRecordedReviewProjection)
      .not.toHaveBeenCalled();
    expect(fixture.dependencies.startServer).not.toHaveBeenCalled();
  });

  it("정적 build가 없으면 비용이 드는 Benchmark 전에 중단한다", async () => {
    const fixture = await runtimeFixture();
    await unlink(join(
      fixture.environment[
        AUTHORITATIVE_WORKSPACE_RUNTIME_ENV.staticDirectory
      ]!,
      "index.html",
    ));

    await expect(startAuthoritativeWorkspaceRuntimeForTest({
      environment: fixture.environment,
      dependencies: fixture.dependencies,
    })).rejects.toThrow(/static|build|index/i);

    expect(fixture.dependencies.executeRecordedBenchmark)
      .not.toHaveBeenCalled();
    expect(fixture.dependencies.startServer).not.toHaveBeenCalled();
  });

  it("production factory는 호출자가 주입한 dependency override를 권위로 사용하지 않는다", async () => {
    const fixture = await runtimeFixture();

    await expect(startAuthoritativeWorkspaceRuntime({
      environment: fixture.environment,
      dependencies: fixture.dependencies,
    } as never)).rejects.toThrow(
      /Locked Challenge|authority|디렉터리|record/i,
    );

    expect(fixture.dependencies.executeRecordedBenchmark)
      .not.toHaveBeenCalled();
    expect(fixture.dependencies.startServer).not.toHaveBeenCalled();
  });

  it("SIGTERM은 같은 프로세스 server를 닫고 command-owned signal을 전달한다", async () => {
    const fixture = await runtimeFixture();
    httpState.closeCount = 0;
    const listeners = new Map<string, () => void>();
    const processLike = {
      env: fixture.environment,
      exitCode: undefined as string | number | null | undefined,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      on: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn((event: string) => {
        listeners.delete(event);
      }),
    };
    const result = await runAuthoritativeWorkspaceProcessForTest({
      runtime: processLike,
      dependencies: fixture.dependencies,
    });
    expect(result).not.toBeNull();
    servers.push(result!.server);
    const benchmarkCall = vi.mocked(
      fixture.dependencies.executeRecordedBenchmark,
    ).mock.calls[0][0];
    expect(benchmarkCall.signal).toBeInstanceOf(AbortSignal);
    expect(benchmarkCall.signal!.aborted).toBe(false);

    const terminate = listeners.get("SIGTERM")!;
    terminate();
    terminate();
    await new Promise((resolve) => setImmediate(resolve));

    expect(benchmarkCall.signal!.aborted).toBe(true);
    expect(httpState.closed).toBe(true);
    expect(httpState.closeCount).toBe(1);
    expect(processLike.exitCode).toBe(143);
    expect(processLike.removeListener).toHaveBeenCalledWith(
      "SIGINT",
      expect.any(Function),
    );
    expect(processLike.removeListener).toHaveBeenCalledWith(
      "SIGTERM",
      expect.any(Function),
    );
  });

  it("listener open과 active handoff 사이 SIGTERM race에서도 열린 server를 닫는다", async () => {
    const fixture = await runtimeFixture();
    const listeners = new Map<string, () => void>();
    const processLike = {
      env: fixture.environment,
      exitCode: undefined as string | number | null | undefined,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      on: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn((event: string) => {
        listeners.delete(event);
      }),
    };
    const startServer = fixture.dependencies.startServer;
    fixture.dependencies.startServer = vi.fn(async (input) => {
      const server = await startServer(input);
      listeners.get("SIGTERM")!();
      return server;
    });

    const result = await runAuthoritativeWorkspaceProcessForTest({
      runtime: processLike,
      dependencies: fixture.dependencies,
    });

    expect(result).toBeNull();
    expect(processLike.exitCode).toBe(143);
    expect(httpState.closed).toBe(true);
    expect(processLike.stdout.write).not.toHaveBeenCalled();
  });
});

function cleanOutcome(recordedBenchmarkPack: object) {
  const resources = [
    {
      kind: "VECTOR_STORE",
      fingerprint: "sha256:000000000000",
      delete_acknowledged: true,
    },
    ...Array.from({ length: 32 }, (_, index) => ({
      kind: "UPLOADED_FILE",
      fingerprint: `sha256:${(index + 1).toString(16).padStart(12, "0")}`,
      delete_acknowledged: true,
    })),
  ];
  return {
    exitCode: 0,
    serverAuthority: { recordedBenchmarkPack },
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
      recorded_pack_path: "/synthetic/recorded-pack.json",
      cleanup: {
        required: 33,
        acknowledged: 33,
        incomplete: 0,
        resources,
        receipt_path: "/synthetic/cleanup-receipt.json",
      },
    },
  };
}

async function runtimeFixture() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "authoritative-runtime-")),
  );
  await chmod(parent, 0o700);
  const runtimeRoot = join(parent, "runtime");
  const staticDirectory = join(parent, "dist");
  await mkdir(staticDirectory, { mode: 0o700 });
  await writeFile(join(staticDirectory, "index.html"), "<main>runtime</main>");
  const recordedBenchmarkPack = fakeRecordedBenchmarkPack();
  const lockedChallengePack = {
    artifact_kind: "LOCKED_CHALLENGE_PACK",
    challenge_id: "challenge_1",
    challenge_version: "v1",
    synthetic: true,
    locked_challenge_pack_hash: SHA_A,
  };
  const preReviewReceipt = {
    artifact_kind: "AI_PRE_REVIEW_RECEIPT",
    pre_review_id: "apr_1",
    pre_review_status: "USER_CONFIRMATION_READY",
    blocking_reasons: [],
  };
  const provisionalDecisionMemo = {
    artifact_kind: "PROVISIONAL_DECISION_MEMO",
    memo_id: "pdm_1",
    memo_status: "USER_CONFIRMATION_REQUIRED",
  };
  const initialSnapshot = {
    schema_version: "projection-snapshot-v1",
    artifact_kind: "PROJECTION_SNAPSHOT",
    snapshot_id: SHA_A,
    source_chain: [],
    projections: {
      workspace: {
        schema_version: "workspace-public-projection-v1",
        synthetic: true,
        challenge_id: "challenge_1",
        review_id: "review_1",
        source_hash: SHA_A,
      },
      challenges: [],
      evidence: [],
      benchmark_progress: [],
      blind_reviews: [],
      decisions: [],
      baselines: [],
      regressions: [],
    },
  };
  const gateway: ChallengeApiGateway = {
    getWorkspace: vi.fn(async () => initialSnapshot.projections.workspace),
    getChallenge: vi.fn(async () => null),
    getEvidence: vi.fn(async () => null),
    getBenchmarkProgress: vi.fn(async () => null),
    getBlindReview: vi.fn(async () => null),
    getDecision: vi.fn(async () => null),
    getBaseline: vi.fn(async () => null),
    getRegression: vi.fn(async () => null),
    structureDefine: vi.fn(async () => {
      throw new TypeError("unsupported");
    }),
    lockChallenge: vi.fn(async () => {
      throw new TypeError("unsupported");
    }),
    startBenchmark: vi.fn(async () => {
      throw new TypeError("unsupported");
    }),
    confirmReview: vi.fn(async () => ({
      accepted: true,
      source_hash: SHA_B,
    })),
    createDecisionMemo: vi.fn(async () => ({
      accepted: true,
      source_hash: SHA_B,
    })),
    confirmDecision: vi.fn(async () => ({
      accepted: true,
      source_hash: SHA_B,
    })),
    startRegression: vi.fn(async () => ({
      accepted: true,
      source_hash: SHA_B,
    })),
  };
  const dependencies = {
    loadLockedChallengePack: vi.fn(async () => lockedChallengePack),
    executeRecordedBenchmark: vi.fn(async () => (
      cleanOutcome(recordedBenchmarkPack)
    )),
    assertPersistedRecordedBenchmarkPack: vi.fn(),
    loadExistingAiPreReviewReceipt: vi.fn(async () => null),
    buildAiPreReviewReceipt: vi.fn(() => preReviewReceipt),
    persistAiPreReviewReceipt: vi.fn(async () => ({
      path: join(runtimeRoot, "authority", "pre-review.json"),
    })),
    loadAiPreReviewReceipt: vi.fn(async () => preReviewReceipt),
    assertPersistedAiPreReviewReceipt: vi.fn(),
    loadExistingProvisionalDecisionMemo: vi.fn(async () => null),
    buildProvisionalDecisionMemo: vi.fn(() => provisionalDecisionMemo),
    persistProvisionalDecisionMemo: vi.fn(async () => ({
      path: join(runtimeRoot, "authority", "provisional.json"),
    })),
    loadProvisionalDecisionMemo: vi.fn(async () => provisionalDecisionMemo),
    assertPersistedProvisionalDecisionMemo: vi.fn(),
    persistRecordedReviewProjection: vi.fn(async () => ({
      path: join(runtimeRoot, "projections", "initial.json"),
    })),
    loadProjectionSnapshot: vi.fn(async () => initialSnapshot),
    createFinalDecisionMemoAdapter: vi.fn(() => ({
      invoke: vi.fn(),
    })),
    createRecordedRegressionRunner: vi.fn(() => vi.fn()),
    loadPersistedRecordedRegression: vi.fn(),
    createGateway: vi.fn(() => gateway),
    startServer: vi.fn(async (input) => {
      const { startAuthoritativeWorkspaceServer } = await import(
        "../nodeWorkspaceServer"
      );
      return startAuthoritativeWorkspaceServer(input);
    }),
  } as unknown as AuthoritativeWorkspaceRuntimeDependencies;
  const environment: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: "runtime-test-secret-key",
    AI_RECORDED_BENCHMARK_ACKNOWLEDGEMENT:
      "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
    AI_LOCKED_CHALLENGE_AUTHORITY_DIRECTORY: join(parent, "locked"),
    AI_LOCKED_CHALLENGE_ID: "challenge_1",
    AI_LOCKED_CHALLENGE_VERSION: "v1",
    [AUTHORITATIVE_WORKSPACE_RUNTIME_ENV.rootDirectory]: runtimeRoot,
    [AUTHORITATIVE_WORKSPACE_RUNTIME_ENV.staticDirectory]: staticDirectory,
    [AUTHORITATIVE_WORKSPACE_RUNTIME_ENV.port]: "0",
  };
  return {
    dependencies,
    environment,
    lockedChallengePack,
    preReviewReceipt,
    provisionalDecisionMemo,
    recordedBenchmarkPack,
    runtimeRoot,
  };
}

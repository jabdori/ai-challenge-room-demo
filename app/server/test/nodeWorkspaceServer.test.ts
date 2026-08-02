// @vitest-environment node

import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createChallengeApiHandler,
  type ChallengeApiGateway,
  type ChallengeMutationCommand,
  type ChallengeMutationResult,
} from "../challengeServer";
import { buildProjectionSnapshot } from "../projectionRepository";

type NodeListener = (
  request: Record<string | symbol, unknown>,
  response: Record<string, unknown>,
) => void;

const httpState = vi.hoisted(() => ({
  listener: null as NodeListener | null,
  closed: false,
  idleConnectionsClosed: false,
  allConnectionsClosed: false,
}));

vi.mock("node:http", () => ({
  createServer: (listener: NodeListener) => {
    httpState.listener = listener;
    return {
      once: () => undefined,
      off: () => undefined,
      listen: (_port: number, _host: string, callback: () => void) => callback(),
      address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43117 }),
      close: (callback: (error?: Error) => void) => {
        httpState.closed = true;
        callback();
      },
      closeIdleConnections: () => {
        httpState.idleConnectionsClosed = true;
      },
      closeAllConnections: () => {
        httpState.allConnectionsClosed = true;
      },
    };
  },
}));

import {
  startReadOnlyWorkspaceServer,
  toFetchRequestForTest,
} from "../nodeWorkspaceServer";

const SOURCE = "a".repeat(64);

function snapshot() {
  return buildProjectionSnapshot({
    source_chain: [{
      artifact_kind: "LOCKED_CHALLENGE_PACK",
      artifact_id: "challenge_1",
      payload_sha256: SOURCE,
    }],
    workspace: {
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
      challenge_id: "challenge_1",
    },
    challenges: [{
      schema_version: "challenge-public-projection-v1",
      synthetic: true,
      challenge_id: "challenge_1",
      source_hash: SOURCE,
    }],
    evidence: [],
    benchmark_progress: [],
    blind_reviews: [],
    decisions: [],
    baselines: [],
    regressions: [],
  });
}

function acceptedMutation(
  command: ChallengeMutationCommand,
): Promise<ChallengeMutationResult> {
  return Promise.resolve({
    accepted: true,
    source_hash: command.expected_source_hash,
  });
}

function mutationGateway(
  structureDefine = vi.fn(acceptedMutation),
): ChallengeApiGateway {
  const missing = async () => null;
  return {
    getWorkspace: async () => snapshot().projections.workspace,
    getChallenge: missing,
    getEvidence: missing,
    getBenchmarkProgress: missing,
    getBlindReview: missing,
    getDecision: missing,
    getBaseline: missing,
    getRegression: missing,
    structureDefine,
    lockChallenge: acceptedMutation,
    startBenchmark: acceptedMutation,
    confirmReview: acceptedMutation,
    createDecisionMemo: acceptedMutation,
    confirmDecision: acceptedMutation,
    startRegression: acceptedMutation,
  };
}

interface CapturedResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | number | readonly string[]>>;
  readonly body: Buffer;
}

async function dispatch({
  url,
  method = "GET",
  headers = {},
  body,
  remoteAddress = "127.0.0.1",
}: {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly remoteAddress?: string;
}): Promise<CapturedResponse> {
  if (!httpState.listener) throw new Error("Node listener가 준비되지 않았습니다.");
  const responseHeaders = new Map<string, string | number | readonly string[]>();
  let statusCode = 200;
  let finish!: (value: CapturedResponse) => void;
  const completed = new Promise<CapturedResponse>((resolve) => { finish = resolve; });
  const chunks = body === undefined ? [] : [Buffer.from(body)];
  const request = {
    url,
    method,
    headers,
    aborted: false,
    complete: true,
    once: () => undefined,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
  const response = {
    get statusCode() { return statusCode; },
    set statusCode(value: number) { statusCode = value; },
    setHeader(name: string, value: string | number | readonly string[]) {
      responseHeaders.set(name.toLowerCase(), value);
    },
    hasHeader(name: string) {
      return responseHeaders.has(name.toLowerCase());
    },
    writeHead(nextStatus: number, nextHeaders: Record<string, string | number>) {
      statusCode = nextStatus;
      for (const [name, value] of Object.entries(nextHeaders)) {
        responseHeaders.set(name.toLowerCase(), value);
      }
    },
    end(value?: string | Buffer) {
      finish({
        statusCode,
        headers: Object.fromEntries(responseHeaders),
        body: value === undefined
          ? Buffer.alloc(0)
          : Buffer.isBuffer(value) ? value : Buffer.from(value),
      });
    },
  };
  httpState.listener(request, response);
  return completed;
}

describe("loopback read-only Challenge workspace server", () => {
  it("destroyed·complete·close만으로 body 수신 전 연결 해제를 취소로 전달하고 완료 뒤 close는 취소로 오인하지 않는다", async () => {
    const listeners = new Map<string, () => void>();
    const request = {
      url: "/api/workspace",
      method: "GET",
      headers: {},
      destroyed: false,
      complete: false,
      once(event: string, listener: () => void) {
        listeners.set(event, listener);
      },
      async *[Symbol.asyncIterator]() {},
    };
    const fetchRequest = await toFetchRequestForTest(request as never);
    // deprecated IncomingMessage.aborted/event에는 의존하지 않아야 합니다.
    expect(listeners.has("aborted")).toBe(false);
    request.destroyed = true;
    listeners.get("close")!();
    expect(fetchRequest.signal.aborted).toBe(true);

    const alreadyDestroyedRequest = {
      ...request,
      destroyed: true,
      complete: false,
      once: () => undefined,
    };
    await expect(toFetchRequestForTest(
      alreadyDestroyedRequest as never,
    )).rejects.toThrow("disconnected");

    const committedListeners = new Map<string, () => void>();
    const committedRequest = {
      ...request,
      destroyed: true,
      complete: true,
      once(event: string, listener: () => void) {
        committedListeners.set(event, listener);
      },
    };
    const committedFetchRequest = await toFetchRequestForTest(
      committedRequest as never,
    );
    committedListeners.get("close")!();
    expect(committedFetchRequest.signal.aborted).toBe(false);
  });

  it("완전 수신된 durable mutation은 client close 뒤에도 authority operation을 끝까지 완료하고 request signal을 전달하지 않는다", async () => {
    const listeners = new Map<string, () => void>();
    const operation = vi.fn(acceptedMutation);
    const rawBody = JSON.stringify({
      schema_version: "define-structure-command-v1",
      expected_source_hash: SOURCE,
      idempotency_key: "mutation_disconnect_durable_001",
    });
    const request = {
      url: "/api/define/structure",
      method: "POST",
      headers: { "content-type": "application/json" },
      destroyed: false,
      complete: true,
      once(event: string, listener: () => void) {
        listeners.set(event, listener);
      },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(rawBody);
      },
    };
    const fetchRequest = await toFetchRequestForTest(request as never);
    request.destroyed = true;
    listeners.get("close")!();
    expect(fetchRequest.signal.aborted).toBe(false);

    const response = await createChallengeApiHandler({
      gateway: mutationGateway(operation),
    })(fetchRequest);

    expect(response.status).toBe(200);
    expect(operation).toHaveBeenCalledOnce();
    expect(operation.mock.calls[0]![0]).not.toHaveProperty("signal");
    expect(await response.json()).toMatchObject({
      accepted: true,
      source_hash: SOURCE,
    });
  });

  it("같은 origin에서 검증된 API projection만 제공하고 mutation은 거부한다", async () => {
    httpState.closed = false;
    httpState.idleConnectionsClosed = false;
    httpState.allConnectionsClosed = false;
    const server = await startReadOnlyWorkspaceServer({ snapshot: snapshot() });
    expect(server.origin).toBe("http://127.0.0.1:43117");

    const response = await dispatch({ url: "/api/workspace" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({
      schema_version: "workspace-public-projection-v1",
      challenge_id: "challenge_1",
    });
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );

    const mutation = await dispatch({
      url: "/api/define/structure",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "define-structure-command-v1",
        expected_source_hash: SOURCE,
        idempotency_key: "mutation_readonly_test",
      }),
    });
    expect(mutation.statusCode).toBe(500);
    expect(JSON.parse(mutation.body.toString("utf8"))).toEqual({
      error: "ARTIFACT_INTEGRITY",
    });

    const remote = await dispatch({
      url: "/api/workspace",
      remoteAddress: "192.0.2.10",
    });
    expect(remote.statusCode).toBe(403);
    await server.close();
    expect(httpState.closed).toBe(true);
    expect(httpState.idleConnectionsClosed).toBe(true);
    expect(httpState.allConnectionsClosed).toBe(true);
  });

  it("build 산출물만 정적 제공하고 SPA 경로·traversal을 안전하게 처리한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-static-"));
    await chmod(root, 0o700);
    await writeFile(join(root, "index.html"), "<!doctype html><main>Workspace</main>");
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "app.js"), "export const ready = true;\n");
    const server = await startReadOnlyWorkspaceServer({
      snapshot: snapshot(),
      staticDirectory: root,
    });

    const spa = await dispatch({ url: "/?view=compare" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body.toString("utf8")).toContain("Workspace");
    expect(spa.headers["cache-control"]).toBe("no-store");

    const asset = await dispatch({ url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");

    const traversal = await dispatch({ url: "/%2e%2e/package.json" });
    expect(traversal.statusCode).toBe(404);
    await server.close();
  });
});

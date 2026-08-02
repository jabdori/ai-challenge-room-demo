import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import {
  createChallengeApiHandler,
  type ChallengeApiGateway,
  type ChallengeMutationJournal,
} from "./challengeServer";
import {
  createReviewerSession,
  reviewerBootstrapUrl,
  type ReviewerSession,
} from "./reviewerSessionAuth";
import {
  createReadOnlyProjectionGateway,
  type ProjectionSnapshot,
} from "./projectionRepository";

const MAX_NODE_BODY_BYTES = 64 * 1024;
const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
});

export interface ReadOnlyWorkspaceServer {
  readonly origin: string;
  /** 권위 server에서만 발급되는 fragment-only local reviewer bootstrap URL입니다. */
  readonly reviewerBootstrapUrl?: string;
  readonly close: () => Promise<void>;
}

export interface StartReadOnlyWorkspaceServerInput {
  readonly snapshot: ProjectionSnapshot;
  readonly staticDirectory?: string;
  readonly port?: number;
}

export interface StartAuthoritativeWorkspaceServerInput {
  readonly gateway: ChallengeApiGateway;
  readonly mutationJournal: ChallengeMutationJournal;
  readonly staticDirectory?: string;
  readonly port?: number;
  /** deterministic token이 필요한 Node test 전용 injection seam입니다. */
  readonly reviewerSession?: ReviewerSession;
}

export interface StartLoopbackApplicationServerInput {
  readonly apiHandler: (request: Request) => Promise<Response>;
  readonly staticDirectory?: string;
  readonly port?: number;
}

function loopbackPeer(address: string | undefined): boolean {
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1";
}

async function readBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > MAX_NODE_BODY_BYTES) {
      throw new TypeError("요청 body가 64 KiB 제한을 초과했습니다.");
    }
    chunks.push(chunk);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

function requestAbortSignal(request: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  const abortPreCompletionDisconnect = () => {
    // IncomingMessage.close는 정상 body 수신 후에도 발생합니다. deprecated
    // `aborted` 속성/event 대신 현재 stream의 destroyed+complete 조합만 보고,
    // 아직 완전한 HTTP message가 아닌 경우에만 transport 수신을 중단합니다.
    if (!request.destroyed || request.complete) return;
    if (!controller.signal.aborted) {
      controller.abort(new Error("HTTP client disconnected before request completion"));
    }
  };
  abortPreCompletionDisconnect();
  request.once("close", abortPreCompletionDisconnect);
  return controller.signal;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function toFetchRequest(request: IncomingMessage): Promise<Request> {
  const path = request.url ?? "/";
  if (!path.startsWith("/")) throw new TypeError("요청 경로가 안전하지 않습니다.");
  const signal = requestAbortSignal(request);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else headers.set(name, value);
  }
  const body = await readBody(request);
  if (signal.aborted) {
    // body 수신 전 연결 해제는 권위 handler까지 전달하지 않습니다. 반대로 body를
    // 끝까지 수신한 durable mutation은 이후 client close로 취소되지 않으며,
    // 이 Request.signal은 downstream authority operation의 취소 약속이 아닙니다.
    throw new TypeError("HTTP client disconnected before request body completed");
  }
  return new Request(`http://127.0.0.1${path}`, {
    method: request.method ?? "GET",
    headers,
    signal,
    ...(body === undefined ? {} : { body: copyToArrayBuffer(body) }),
  });
}

/** Node request 취소 전파를 검증하는 네트워크 없는 테스트 seam입니다. */
export const toFetchRequestForTest = toFetchRequest;

async function writeFetchResponse(
  response: Response,
  target: ServerResponse,
): Promise<void> {
  target.statusCode = response.status;
  for (const [name, value] of response.headers) target.setHeader(name, value);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!target.hasHeader(name)) target.setHeader(name, value);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  target.setHeader("content-length", String(bytes.length));
  target.end(bytes);
}

function plainError(target: ServerResponse, status: number): void {
  const body = status === 403 ? "Forbidden\n" : "Not found\n";
  target.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  target.end(body);
}

async function staticResponse({
  request,
  target,
  staticDirectory,
}: {
  readonly request: IncomingMessage;
  readonly target: ServerResponse;
  readonly staticDirectory: string | null;
}): Promise<void> {
  if (staticDirectory === null || (request.method !== "GET" && request.method !== "HEAD")) {
    plainError(target, 404);
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  } catch {
    plainError(target, 404);
    return;
  }
  if (pathname.includes("\0") || pathname.split("/").includes("..")) {
    plainError(target, 404);
    return;
  }
  const relativePath = pathname === "/" || extname(pathname) === ""
    ? "index.html"
    : pathname.replace(/^\/+/, "");
  const candidate = resolve(join(staticDirectory, relativePath));
  if (candidate !== staticDirectory && !candidate.startsWith(`${staticDirectory}${sep}`)) {
    plainError(target, 404);
    return;
  }
  let canonical: string;
  let handle;
  try {
    canonical = await realpath(candidate);
    if (canonical !== staticDirectory && !canonical.startsWith(`${staticDirectory}${sep}`)) {
      plainError(target, 404);
      return;
    }
    handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      plainError(target, 404);
      return;
    }
    const bytes = await handle.readFile();
    target.writeHead(200, {
      ...SECURITY_HEADERS,
      "cache-control": relativePath === "index.html"
        ? "no-store"
        : "public, max-age=31536000, immutable",
      "content-type": CONTENT_TYPES[extname(canonical)] ?? "application/octet-stream",
      "content-length": bytes.length,
    });
    target.end(request.method === "HEAD" ? undefined : bytes);
  } catch {
    plainError(target, 404);
  } finally {
    await handle?.close();
  }
}

async function startWorkspaceServer({
  apiHandler,
  reviewerSession,
  staticDirectory,
  port = 0,
}: {
  readonly apiHandler: (request: Request) => Promise<Response>;
  readonly reviewerSession?: ReviewerSession;
  readonly staticDirectory?: string;
  readonly port?: number;
}): Promise<ReadOnlyWorkspaceServer> {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("workspace server port가 유효하지 않습니다.");
  }
  const canonicalStaticDirectory = staticDirectory === undefined
    ? null
    : await realpath(staticDirectory);
  const server = createServer((request, response) => {
    void (async () => {
      if (!loopbackPeer(request.socket.remoteAddress)) {
        plainError(response, 403);
        return;
      }
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname.startsWith("/api/")) {
        try {
          await writeFetchResponse(
            await apiHandler(await toFetchRequest(request)),
            response,
          );
        } catch {
          plainError(response, 404);
        }
        return;
      }
      await staticResponse({
        request,
        target: response,
        staticDirectory: canonicalStaticDirectory,
      });
    })();
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  return Object.freeze({
    origin,
    ...(reviewerSession === undefined
      ? {}
      : { reviewerBootstrapUrl: reviewerBootstrapUrl(origin, reviewerSession.reviewerToken) }),
    close: () => new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
      // 로컬 데모 종료 시 keep-alive 연결이 provider key를 가진 Node 프로세스를
      // 붙잡지 않도록 listener 종료와 함께 모든 로컬 HTTP 연결을 닫습니다.
      server.closeIdleConnections();
      server.closeAllConnections();
    }),
  });
}

export async function startReadOnlyWorkspaceServer({
  snapshot,
  staticDirectory,
  port = 0,
}: StartReadOnlyWorkspaceServerInput): Promise<ReadOnlyWorkspaceServer> {
  return startWorkspaceServer({
    apiHandler: createChallengeApiHandler({
      gateway: createReadOnlyProjectionGateway(snapshot),
    }),
    ...(staticDirectory === undefined ? {} : { staticDirectory }),
    port,
  });
}

export async function startAuthoritativeWorkspaceServer({
  gateway,
  mutationJournal,
  staticDirectory,
  port = 0,
  reviewerSession = createReviewerSession(),
}: StartAuthoritativeWorkspaceServerInput): Promise<ReadOnlyWorkspaceServer> {
  return startWorkspaceServer({
    apiHandler: createChallengeApiHandler({
      gateway,
      mutationJournal,
      reviewerAuthorizer: reviewerSession.authorizer,
    }),
    reviewerSession,
    ...(staticDirectory === undefined ? {} : { staticDirectory }),
    port,
  });
}

export async function startLoopbackApplicationServer({
  apiHandler,
  staticDirectory,
  port = 0,
}: StartLoopbackApplicationServerInput): Promise<ReadOnlyWorkspaceServer> {
  return startWorkspaceServer({
    apiHandler,
    ...(staticDirectory === undefined ? {} : { staticDirectory }),
    port,
  });
}

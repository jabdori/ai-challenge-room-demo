import type {
  DemoSessionRecord,
  DemoStateRepository,
} from "./demoContracts";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  constantTimeEqual,
  hmacSha256Base64Url,
  sha256Base64Url,
  verifyAccessCodeHash,
} from "./webCrypto";

export const SESSION_COOKIE_NAME = "__Host-ai_challenge_session";

const JSON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
});
const DEFAULT_SESSION_TTL_SECONDS = 15 * 60;
const DEFAULT_AUTH_FAILURE_LIMIT = 5;
const DEFAULT_AUTH_FAILURE_WINDOW_MS = 60_000;
const DEFAULT_AUTH_FAILURE_BLOCK_MS = 5 * 60_000;
const MAX_LOGIN_BODY_BYTES = 1_024;
const SESSION_TOKEN_BYTES = 32;

export type AuthPublicErrorCode =
  | "ACCESS_DENIED"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "NOT_FOUND";

export interface JudgeAccessAuth {
  handleAuthRoute(request: Request): Promise<Response | null>;
  authenticate(request: Request): Promise<DemoSessionRecord | null>;
}

export type AuthInfrastructureStage =
  | "AUTH_BLOCK_LOOKUP_FAILED"
  | "AUTH_ACCESS_CODE_READ_FAILED"
  | "AUTH_CODE_VERIFY_FAILED"
  | "AUTH_FAILURE_RECORD_FAILED"
  | "AUTH_SESSION_MATERIAL_FAILED"
  | "AUTH_SESSION_CREATE_FAILED";

export type AuthInfrastructureErrorKind =
  | "OPERATION_ERROR"
  | "NOT_SUPPORTED_ERROR"
  | "DATA_ERROR"
  | "INVALID_ACCESS_ERROR"
  | "TYPE_ERROR"
  | "RANGE_ERROR"
  | "ERROR"
  | "UNKNOWN_ERROR";

interface JudgeAccessAuthOptions {
  readonly repository: DemoStateRepository;
  readonly accessCodeHash: string;
  readonly sessionSecret: string;
  readonly now?: () => number;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly sessionTtlSeconds?: number;
  readonly authFailureLimit?: number;
  readonly authFailureWindowMs?: number;
  readonly authFailureBlockMs?: number;
  readonly reportInfrastructureError?: (
    stage: AuthInfrastructureStage,
    kind: AuthInfrastructureErrorKind,
  ) => void;
}

function json(value: unknown, status = 200, setCookie?: string): Response {
  const headers = new Headers(JSON_HEADERS);
  if (setCookie) headers.set("set-cookie", setCookie);
  return new Response(JSON.stringify(value), {
    status,
    headers,
  });
}

function publicError(code: AuthPublicErrorCode, status: number): Response {
  return json({ error: { code } }, status);
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} 설정이 안전한 범위를 벗어났습니다.`);
  }
  return value;
}

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function exactAccessCode(value: unknown): string | null {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1
    || typeof record.access_code !== "string"
  ) {
    return null;
  }
  return record.access_code;
}

async function readAccessCode(request: Request): Promise<string | null> {
  if (
    !request.headers.get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return null;
  }
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).length > MAX_LOGIN_BODY_BYTES) {
      return null;
    }
    return exactAccessCode(JSON.parse(body) as unknown);
  } catch {
    return null;
  }
}

function networkIdentifier(request: Request): string {
  const value = request.headers.get("cf-connecting-ip")?.trim();
  if (!value || value.length > 512 || /\p{Cc}/u.test(value)) {
    return "unavailable";
  }
  return value;
}

function parseSessionCookie(request: Request): {
  readonly token: string;
  readonly signature: string;
} | null {
  const header = request.headers.get("cookie");
  if (!header || header.length > 4_096) return null;
  const values = header.split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
    .map((part) => part.slice(`${SESSION_COOKIE_NAME}=`.length));
  if (values.length !== 1) return null;

  const fields = (values[0] ?? "").split(".");
  if (fields.length !== 2) return null;
  const token = fields[0] ?? "";
  const signature = fields[1] ?? "";
  if (
    base64UrlToBytes(token)?.length !== SESSION_TOKEN_BYTES
    || base64UrlToBytes(signature)?.length !== 32
  ) {
    return null;
  }
  return { token, signature };
}

function sessionCookie(
  value: string,
  maxAgeSeconds: number,
): string {
  return [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

function expiredSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ].join("; ");
}

function infrastructureErrorKind(
  error: unknown,
): AuthInfrastructureErrorKind {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "OperationError":
      return "OPERATION_ERROR";
    case "NotSupportedError":
      return "NOT_SUPPORTED_ERROR";
    case "DataError":
      return "DATA_ERROR";
    case "InvalidAccessError":
      return "INVALID_ACCESS_ERROR";
    case "TypeError":
      return "TYPE_ERROR";
    case "RangeError":
      return "RANGE_ERROR";
    case "Error":
      return "ERROR";
    default:
      return "UNKNOWN_ERROR";
  }
}

export function createJudgeAccessAuth(
  options: JudgeAccessAuthOptions,
): JudgeAccessAuth {
  const secretBytes = new TextEncoder().encode(options.sessionSecret);
  if (secretBytes.length < 32 || secretBytes.length > 1_024) {
    throw new TypeError("DEMO_SESSION_SECRET는 32~1024 bytes여야 합니다.");
  }
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? secureRandomBytes;
  const sessionTtlSeconds = positiveInteger(
    options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
    "session TTL",
    86_400,
  );
  const authFailureLimit = positiveInteger(
    options.authFailureLimit ?? DEFAULT_AUTH_FAILURE_LIMIT,
    "auth failure limit",
    100,
  );
  const authFailureWindowMs = positiveInteger(
    options.authFailureWindowMs ?? DEFAULT_AUTH_FAILURE_WINDOW_MS,
    "auth failure window",
    24 * 60 * 60_000,
  );
  const authFailureBlockMs = positiveInteger(
    options.authFailureBlockMs ?? DEFAULT_AUTH_FAILURE_BLOCK_MS,
    "auth failure block",
    24 * 60 * 60_000,
  );
  const reportInfrastructureError = options.reportInfrastructureError
    ?? ((
      stage: AuthInfrastructureStage,
      kind: AuthInfrastructureErrorKind,
    ) => console.error(`${stage}:${kind}`));

  async function fingerprint(request: Request): Promise<string> {
    return hmacSha256Base64Url({
      secret: options.sessionSecret,
      domain: "auth-failure:v1",
      value: networkIdentifier(request),
    });
  }

  async function authenticate(
    request: Request,
  ): Promise<DemoSessionRecord | null> {
    const parsed = parseSessionCookie(request);
    if (!parsed) return null;

    const expectedSignature = await hmacSha256Base64Url({
      secret: options.sessionSecret,
      domain: "session-cookie:v1",
      value: parsed.token,
    });
    const actualBytes = base64UrlToBytes(parsed.signature);
    const expectedBytes = base64UrlToBytes(expectedSignature);
    if (
      actualBytes === null
      || expectedBytes === null
      || !constantTimeEqual(actualBytes, expectedBytes)
    ) {
      return null;
    }

    const sessionTokenDigest = await sha256Base64Url({
      domain: "session-token:v1",
      value: parsed.token,
    });
    const session = await options.repository.readSession(sessionTokenDigest);
    const currentTime = now();
    if (
      session === null
      || session.revokedAtMs !== null
      || session.expiresAtMs <= currentTime
    ) {
      return null;
    }
    return session;
  }

  async function recordFailure(
    request: Request,
    currentTime: number,
  ): Promise<boolean> {
    const networkFingerprint = await fingerprint(request);
    const bucketStartedAtMs = Math.floor(
      currentTime / authFailureWindowMs,
    ) * authFailureWindowMs;
    const stored = await options.repository.recordAuthFailureAttempt({
      networkFingerprint,
      bucketStartedAtMs,
      attemptedAtMs: currentTime,
      failureLimit: authFailureLimit,
      blockDurationMs: authFailureBlockMs,
    });
    return stored.blockedUntilMs !== null
      && stored.blockedUntilMs > currentTime;
  }

  async function isBlocked(
    request: Request,
    currentTime: number,
  ): Promise<boolean> {
    const networkFingerprint = await fingerprint(request);
    const record = await options.repository.readActiveAuthFailure(
      networkFingerprint,
      currentTime,
    );
    return record !== null;
  }

  async function login(request: Request): Promise<Response> {
    let stage: AuthInfrastructureStage = "AUTH_BLOCK_LOOKUP_FAILED";
    try {
      const currentTime = now();
      if (await isBlocked(request, currentTime)) {
        return publicError("RATE_LIMITED", 429);
      }

      stage = "AUTH_ACCESS_CODE_READ_FAILED";
      const accessCode = await readAccessCode(request);
      stage = "AUTH_CODE_VERIFY_FAILED";
      const valid = accessCode !== null && await verifyAccessCodeHash({
        accessCode,
        encodedHash: options.accessCodeHash,
      });
      if (!valid) {
        stage = "AUTH_FAILURE_RECORD_FAILED";
        const blocked = await recordFailure(request, currentTime);
        return publicError(
          blocked ? "RATE_LIMITED" : "ACCESS_DENIED",
          blocked ? 429 : 401,
        );
      }

      stage = "AUTH_SESSION_MATERIAL_FAILED";
      const tokenBytes = randomBytes(SESSION_TOKEN_BYTES);
      if (
        !(tokenBytes instanceof Uint8Array)
        || tokenBytes.length !== SESSION_TOKEN_BYTES
      ) {
        throw new Error("세션 random source 계약이 올바르지 않습니다.");
      }
      const token = bytesToBase64Url(tokenBytes);
      const signature = await hmacSha256Base64Url({
        secret: options.sessionSecret,
        domain: "session-cookie:v1",
        value: token,
      });
      const sessionTokenDigest = await sha256Base64Url({
        domain: "session-token:v1",
        value: token,
      });

      stage = "AUTH_SESSION_CREATE_FAILED";
      await options.repository.createSession({
        sessionTokenDigest,
        createdAtMs: currentTime,
        expiresAtMs: currentTime + sessionTtlSeconds * 1_000,
        revokedAtMs: null,
        successfulLiveRuns: 0,
        operationalRetryCount: 0,
        currentExecutionId: null,
      });
      return json(
        { authenticated: true },
        200,
        sessionCookie(`${token}.${signature}`, sessionTtlSeconds),
      );
    } catch (error) {
      reportInfrastructureError(stage, infrastructureErrorKind(error));
      throw error;
    }
  }

  async function logout(request: Request): Promise<Response> {
    const session = await authenticate(request);
    if (!session) {
      return json(
        { error: { code: "UNAUTHORIZED" } },
        401,
        expiredSessionCookie(),
      );
    }
    await options.repository.revokeSession(
      session.sessionTokenDigest,
      now(),
    );
    return json(
      { authenticated: false },
      200,
      expiredSessionCookie(),
    );
  }

  return {
    authenticate,
    async handleAuthRoute(request) {
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/api/auth/session") {
        return json({ authenticated: (await authenticate(request)) !== null });
      }
      if (request.method === "POST" && pathname === "/api/auth/login") {
        return login(request);
      }
      if (request.method === "POST" && pathname === "/api/auth/logout") {
        return logout(request);
      }
      if (pathname.startsWith("/api/auth/")) {
        return publicError("NOT_FOUND", 404);
      }
      return null;
    },
  };
}

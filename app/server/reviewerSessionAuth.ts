import {
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { ReviewerSessionAuthorizer } from "./challengeServer";

const REVIEWER_TOKEN = /^rvw_[A-Za-z0-9_-]{43}$/;

export interface ReviewerSession {
  /** fragment bootstrap URL을 만들기 위한 process-local plaintext입니다. */
  readonly reviewerToken: string;
  /** closure에는 SHA-256 hash만 보관하는 server-side verifier입니다. */
  readonly authorizer: ReviewerSessionAuthorizer;
}

export interface ReviewerSessionDependencies {
  readonly randomBytes?: (size: number) => Uint8Array;
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function isLoopbackHost(host: string): boolean {
  if (host.length === 0 || /[\p{Cc}\s/@]/u.test(host)) return false;
  try {
    const url = new URL(`http://${host}`);
    return (
      url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && url.host === host
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === ""
    );
  } catch {
    return false;
  }
}

/** browser fragment에서만 전달할 reviewer bootstrap URL입니다. */
export function reviewerBootstrapUrl(origin: string, reviewerToken: string): string {
  if (!REVIEWER_TOKEN.test(reviewerToken)) {
    throw new TypeError("reviewer token 형식이 유효하지 않습니다.");
  }
  const url = new URL(origin);
  if (
    url.protocol !== "http:"
    || !isLoopbackHost(url.host)
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new TypeError("reviewer bootstrap origin은 canonical loopback origin이어야 합니다.");
  }
  url.hash = `reviewer_token=${reviewerToken}`;
  return url.toString();
}

/**
 * listener lifetime에만 존재하는 reviewer principal입니다. artifact, projection,
 * URL query, cookie, localStorage에는 token 또는 hash를 기록하지 않습니다.
 */
export function createReviewerSession({
  randomBytes = nodeRandomBytes,
}: ReviewerSessionDependencies = {}): ReviewerSession {
  const random = Buffer.from(randomBytes(32));
  if (random.byteLength !== 32) {
    throw new TypeError("reviewer token random source는 정확히 256-bit를 반환해야 합니다.");
  }
  const reviewerToken = `rvw_${random.toString("base64url")}`;
  const expectedHash = tokenHash(reviewerToken);

  const authorizer: ReviewerSessionAuthorizer = Object.freeze({
    authorize(request: Request): 401 | 403 | null {
      const authorization = request.headers.get("authorization");
      const candidate = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "";
      // malformed/missing input도 fixed-size hash로 만든 뒤 비교해 token 검증의
      // byte 비교 자체는 constant-time primitive를 사용합니다.
      const candidateHash = tokenHash(candidate);
      const tokenMatches = timingSafeEqual(expectedHash, candidateHash)
        && REVIEWER_TOKEN.test(candidate);
      if (authorization === null || !REVIEWER_TOKEN.test(candidate)) return 401;
      if (!tokenMatches) return 403;

      const host = request.headers.get("host");
      if (host === null || !isLoopbackHost(host)) return 403;
      const expectedOrigin = `http://${host}`;
      const origin = request.headers.get("origin");
      // browser same-origin GET은 Origin을 생략할 수 있지만, 있으면 정확히 같은
      // origin이어야 합니다. state-changing confirm은 Origin을 반드시 요구합니다.
      if (
        (origin !== null && origin !== expectedOrigin)
        || (request.method !== "GET" && origin !== expectedOrigin)
        || request.headers.get("sec-fetch-site") !== "same-origin"
      ) return 403;
      return null;
    },
  });
  return Object.freeze({ reviewerToken, authorizer });
}

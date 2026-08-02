const PBKDF2_ALGORITHM = "pbkdf2-sha256";
const HIGH_ENTROPY_TOKEN_ALGORITHM = "token-sha256";
const PBKDF2_MIN_ITERATIONS = 100_000;
const PBKDF2_MAX_ITERATIONS = 2_000_000;
const PBKDF2_DIGEST_BYTES = 32;
const PBKDF2_MIN_SALT_BYTES = 16;
const PBKDF2_MAX_SALT_BYTES = 64;
const MAX_ACCESS_CODE_LENGTH = 512;
const HIGH_ENTROPY_ACCESS_CODE = /^[A-Za-z0-9_-]{32,128}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

function webCrypto(): Crypto {
  const value = crypto;
  if (!value?.subtle) {
    throw new Error("Web Crypto를 사용할 수 없습니다.");
  }
  return value;
}

export function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array | null {
  if (
    value.length === 0
    || !BASE64URL.test(value)
    || value.length % 4 === 1
  ) {
    return null;
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytesToBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * 길이가 다를 때도 모든 byte position을 순회합니다. JavaScript 런타임의
 * 절대적인 timing 보장을 주장하지 않으며, 인증 분기의 조기 종료만 제거합니다.
 */
export function constantTimeEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function derivePbkdf2({
  accessCode,
  iterations,
  salt,
}: {
  readonly accessCode: string;
  readonly iterations: number;
  readonly salt: Uint8Array;
}): Promise<Uint8Array> {
  const saltBytes = new Uint8Array(salt.length);
  saltBytes.set(salt);
  const key = await webCrypto().subtle.importKey(
    "raw",
    encoder.encode(accessCode),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await webCrypto().subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: saltBytes,
      iterations,
    },
    key,
    PBKDF2_DIGEST_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function validIterations(value: number): boolean {
  return Number.isSafeInteger(value)
    && value >= PBKDF2_MIN_ITERATIONS
    && value <= PBKDF2_MAX_ITERATIONS;
}

function validSalt(value: Uint8Array): boolean {
  return value.length >= PBKDF2_MIN_SALT_BYTES
    && value.length <= PBKDF2_MAX_SALT_BYTES;
}

export async function createPbkdf2AccessCodeHash({
  accessCode,
  iterations,
  salt,
}: {
  readonly accessCode: string;
  readonly iterations: number;
  readonly salt: Uint8Array;
}): Promise<string> {
  if (
    accessCode.length === 0
    || accessCode.length > MAX_ACCESS_CODE_LENGTH
    || !validIterations(iterations)
    || !validSalt(salt)
  ) {
    throw new TypeError("접근 코드 hash 입력이 잠긴 계약과 다릅니다.");
  }
  const digest = await derivePbkdf2({ accessCode, iterations, salt });
  return [
    PBKDF2_ALGORITHM,
    String(iterations),
    bytesToBase64Url(salt),
    bytesToBase64Url(digest),
  ].join("$");
}

export async function verifyPbkdf2AccessCode({
  accessCode,
  encodedHash,
}: {
  readonly accessCode: string;
  readonly encodedHash: string;
}): Promise<boolean> {
  if (
    accessCode.length === 0
    || accessCode.length > MAX_ACCESS_CODE_LENGTH
    || encodedHash.length > 512
  ) {
    return false;
  }
  const fields = encodedHash.split("$");
  if (fields.length !== 4 || fields[0] !== PBKDF2_ALGORITHM) {
    return false;
  }
  const iterationsText = fields[1] ?? "";
  if (!/^[1-9]\d{5,6}$/u.test(iterationsText)) {
    return false;
  }
  const iterations = Number(iterationsText);
  const salt = base64UrlToBytes(fields[2] ?? "");
  const expected = base64UrlToBytes(fields[3] ?? "");
  if (
    !validIterations(iterations)
    || salt === null
    || !validSalt(salt)
    || expected === null
    || expected.length !== PBKDF2_DIGEST_BYTES
  ) {
    return false;
  }

  const actual = await derivePbkdf2({ accessCode, iterations, salt });
  return constantTimeEqual(actual, expected);
}

/**
 * 사람이 외우는 비밀번호가 아니라 생성기로 만든 충분히 긴 심사 토큰을 위한
 * Workers 호환 hash입니다. 짧거나 URL-safe ASCII가 아닌 값은 허용하지 않습니다.
 */
export async function createHighEntropyAccessCodeHash({
  accessCode,
}: {
  readonly accessCode: string;
}): Promise<string> {
  if (!HIGH_ENTROPY_ACCESS_CODE.test(accessCode)) {
    throw new TypeError("고엔트로피 접근 코드 계약과 다릅니다.");
  }
  const digest = await sha256Base64Url({
    domain: "judge-access-token:v1",
    value: accessCode,
  });
  return `${HIGH_ENTROPY_TOKEN_ALGORITHM}$${digest}`;
}

export async function verifyAccessCodeHash({
  accessCode,
  encodedHash,
}: {
  readonly accessCode: string;
  readonly encodedHash: string;
}): Promise<boolean> {
  const fields = encodedHash.split("$");
  if (fields[0] !== HIGH_ENTROPY_TOKEN_ALGORITHM) {
    return verifyPbkdf2AccessCode({ accessCode, encodedHash });
  }
  if (
    fields.length !== 2
    || !HIGH_ENTROPY_ACCESS_CODE.test(accessCode)
  ) {
    return false;
  }
  const expected = base64UrlToBytes(fields[1] ?? "");
  if (expected === null || expected.length !== PBKDF2_DIGEST_BYTES) {
    return false;
  }
  const actual = base64UrlToBytes(await sha256Base64Url({
    domain: "judge-access-token:v1",
    value: accessCode,
  }));
  return actual !== null && constantTimeEqual(actual, expected);
}

export async function hmacSha256Base64Url({
  secret,
  domain,
  value,
}: {
  readonly secret: string;
  readonly domain: string;
  readonly value: string;
}): Promise<string> {
  const key = await webCrypto().subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await webCrypto().subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${domain}\u0000${value}`),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function sha256Base64Url({
  domain,
  value,
}: {
  readonly domain: string;
  readonly value: string;
}): Promise<string> {
  const digest = await webCrypto().subtle.digest(
    "SHA-256",
    encoder.encode(`${domain}\u0000${value}`),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

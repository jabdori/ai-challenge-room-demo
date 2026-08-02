// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  createHighEntropyAccessCodeHash,
  createPbkdf2AccessCodeHash,
  hmacSha256Base64Url,
  verifyAccessCodeHash,
  verifyPbkdf2AccessCode,
} from "../webCrypto";

const SALT = Uint8Array.from({ length: 16 }, (_, index) => index + 1);

describe("Sites 심사위원 접근 코드 Web Crypto", () => {
  it("충분히 긴 무작위 심사 토큰은 domain-separated SHA-256 형식으로 검증한다", async () => {
    const accessCode = "JUDGE-0123456789abcdefghijklmnopqrstuv";
    const encoded = await createHighEntropyAccessCodeHash({ accessCode });

    expect(encoded).toMatch(/^token-sha256\$[A-Za-z0-9_-]{43}$/);
    await expect(verifyAccessCodeHash({
      accessCode,
      encodedHash: encoded,
    })).resolves.toBe(true);
    await expect(verifyAccessCodeHash({
      accessCode: `${accessCode}x`,
      encodedHash: encoded,
    })).resolves.toBe(false);
  });

  it("짧은 값은 고엔트로피 토큰 hash로 만들거나 검증하지 않는다", async () => {
    await expect(createHighEntropyAccessCodeHash({
      accessCode: "short-access-code",
    })).rejects.toThrow("고엔트로피");
    await expect(verifyAccessCodeHash({
      accessCode: "short-access-code",
      encodedHash: `token-sha256$${"A".repeat(43)}`,
    })).resolves.toBe(false);
  });

  it("잠긴 PBKDF2 형식은 올바른 코드만 검증한다", async () => {
    const encoded = await createPbkdf2AccessCodeHash({
      accessCode: "correct horse battery staple",
      iterations: 120_000,
      salt: SALT,
    });

    expect(encoded).toMatch(
      /^pbkdf2-sha256\$120000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/,
    );
    await expect(verifyPbkdf2AccessCode({
      accessCode: "correct horse battery staple",
      encodedHash: encoded,
    })).resolves.toBe(true);
    await expect(verifyPbkdf2AccessCode({
      accessCode: "wrong",
      encodedHash: encoded,
    })).resolves.toBe(false);
    await expect(verifyAccessCodeHash({
      accessCode: "correct horse battery staple",
      encodedHash: encoded,
    })).resolves.toBe(true);
  });

  it.each([
    "",
    "pbkdf2-sha1$120000$bad$bad",
    "pbkdf2-sha256$99999$bad$bad",
    "pbkdf2-sha256$2000001$bad$bad",
    "pbkdf2-sha256$120000$not+base64url$bad",
    "pbkdf2-sha256$120000$YQ$YQ",
    "pbkdf2-sha256$120000$YWFhYWFhYWFhYWFhYWFhYQ$YWFhYQ$extra",
  ])("깨진 hash 형식 %j은 예외 대신 동일한 불일치로 처리한다", async (encodedHash) => {
    await expect(verifyPbkdf2AccessCode({
      accessCode: "anything",
      encodedHash,
    })).resolves.toBe(false);
  });

  it("빈 코드와 지나치게 긴 코드를 동일한 불일치로 처리한다", async () => {
    const encoded = await createPbkdf2AccessCodeHash({
      accessCode: "valid access code",
      iterations: 120_000,
      salt: SALT,
    });

    await expect(verifyPbkdf2AccessCode({
      accessCode: "",
      encodedHash: encoded,
    })).resolves.toBe(false);
    await expect(verifyPbkdf2AccessCode({
      accessCode: "x".repeat(513),
      encodedHash: encoded,
    })).resolves.toBe(false);
  });

  it("길이가 다른 digest도 조기 성공 없이 false를 반환한다", () => {
    expect(constantTimeEqual(
      Uint8Array.from([1, 2, 3]),
      Uint8Array.from([1, 2, 3]),
    )).toBe(true);
    expect(constantTimeEqual(
      Uint8Array.from([1, 2, 3]),
      Uint8Array.from([1, 2]),
    )).toBe(false);
    expect(constantTimeEqual(
      new Uint8Array(),
      Uint8Array.from([0]),
    )).toBe(false);
  });

  it("HMAC 입력의 domain이 다르면 같은 값도 다른 fingerprint가 된다", async () => {
    const secret = "s".repeat(32);
    await expect(hmacSha256Base64Url({
      secret,
      domain: "auth-failure:v1",
      value: "network",
    })).resolves.not.toBe(await hmacSha256Base64Url({
      secret,
      domain: "session-cookie:v1",
      value: "network",
    }));
  });
});

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function canonicalize(value: unknown, ancestors: Set<object>): CanonicalJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON에는 유한한 숫자만 사용할 수 있습니다.");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("canonical JSON으로 변환할 수 없는 값이 포함되어 있습니다.");
  }
  if (ancestors.has(value)) {
    throw new TypeError("canonical JSON에는 순환 참조를 사용할 수 없습니다.");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      // 배열은 평가 반복과 인용 순서를 보존해야 하므로 정렬하지 않습니다.
      return value.map((item) => canonicalize(item, ancestors));
    }

    // `__proto__`도 일반 JSON 키로 저장되도록 prototype setter가 없는 객체를 사용합니다.
    const result = Object.create(null) as { [key: string]: CanonicalJsonValue };
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize((value as Record<string, unknown>)[key], ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

export function sha256Utf8(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

export function sha256CanonicalJson(value: unknown): string {
  return sha256Utf8(canonicalJsonStringify(value));
}

export const canonicalJson = canonicalJsonStringify;
export const hashCanonicalJson = sha256CanonicalJson;

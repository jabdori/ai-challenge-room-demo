import {
  assertDemoProjectionPublicSafe,
} from "../../eval/demo/publicProjectionSafety";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFieldName(value: string): string {
  return value.normalize("NFKC").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

const PUBLIC_FORBIDDEN_VALUE_PATTERNS = [
  /(?:^|[^a-z0-9])s[^a-z0-9]*k[^a-z0-9]+[a-z0-9_-]{20,}/i,
  /(?:^|[^a-z0-9])r[^a-z0-9]*e[^a-z0-9]*q[^a-z0-9]+[a-z0-9_-]{16,}/i,
  /(?:^|[^a-z0-9])r[^a-z0-9]*e[^a-z0-9]*s[^a-z0-9]*p[^a-z0-9]+[a-z0-9_-]{16,}/i,
  /(?:^|[^a-z0-9])v[^a-z0-9]*s[^a-z0-9]+[a-z0-9_-]{16,}/i,
  /(?:^|[^a-z0-9])f[^a-z0-9]*i[^a-z0-9]*l[^a-z0-9]*e[^a-z0-9]+[a-z0-9_-]{16,}/i,
  /(?:^|[^a-z0-9])remote[^a-z0-9]*resource[^a-z0-9]*id[^a-z0-9]+[a-z0-9_-]{16,}/i,
  /(?:^|[^a-z0-9])bearer[^a-z0-9]+[a-z0-9_-]{20,}/i,
  /(?:^|[^a-z0-9])client[^a-z0-9]*secret[^a-z0-9]+[a-z0-9_-]{16,}/i,
  /-----begin[^a-z0-9]+(?:[a-z0-9]+[^a-z0-9]+)*private[^a-z0-9]+key-----/i,
] as const;

function containsSensitiveValue(value: string): boolean {
  const normalized = value.normalize("NFKC");
  return PUBLIC_FORBIDDEN_VALUE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isSensitiveFieldName(key: string): boolean {
  const normalized = normalizeFieldName(key);
  if (
    normalized === "sessiontokendigest"
    || normalized === "leasetokendigest"
    || normalized === "networkfingerprint"
    || normalized === "idempotencykey"
    || (normalized.includes("accesscode")
      && (normalized.endsWith("hash") || normalized.endsWith("digest")))
    || ((normalized.startsWith("reservation")
      || normalized.startsWith("reconciliation"))
      && (normalized.includes("token")
        || normalized.includes("digest")
        || normalized.endsWith("key")))
  ) {
    return true;
  }
  if (
    normalized.includes("secret")
    || normalized.includes("credential")
    || normalized.includes("password")
    || normalized.includes("passphrase")
    || normalized.includes("authorization")
    || normalized.includes("privatekey")
    || normalized.includes("private")
    || normalized.includes("revealed")
  ) {
    return true;
  }
  if (
    normalized === "token"
    || (normalized.endsWith("token") && !normalized.endsWith("tokens"))
  ) {
    return true;
  }
  return (
    ((normalized.includes("label") || normalized.includes("blind"))
      && normalized.includes("candidate"))
    || (normalized.includes("candidate")
      && (normalized.includes("mapping") || normalized.endsWith("map")))
  );
}

function isBlindCandidateMapping(value: JsonRecord): boolean {
  const normalizedKeys = Object.keys(value).map(normalizeFieldName);
  const keySet = new Set(normalizedKeys);
  if (
    (keySet.has("blindlabel") || keySet.has("anonymizedlabel"))
    && (keySet.has("candidateid") || keySet.has("candidateidentity"))
  ) {
    return true;
  }

  const directMappingEntries = Object.entries(value).filter(
    ([key, child]) => (
      ["x", "y", "z"].includes(normalizeFieldName(key))
      && typeof child === "string"
      && ["a", "b", "c"].includes(normalizeFieldName(child))
    ),
  );
  return directMappingEntries.length === 3
    && directMappingEntries.length === Object.keys(value).length;
}

function assertSitesSpecificFieldSafety(value: unknown, path = "$"): void {
  if (typeof value === "string") {
    if (containsSensitiveValue(value)) {
      throw new Error(`${path}에 공개할 수 없는 민감 값이 포함되어 있습니다.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      assertSitesSpecificFieldSafety(child, `${path}[${index}]`);
    });
    return;
  }
  if (!isRecord(value)) return;
  if (isBlindCandidateMapping(value)) {
    throw new Error(`${path}에 공개할 수 없는 후보 신원 매핑이 포함되어 있습니다.`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveFieldName(key)) {
      throw new Error(`${path}.${key}는 공개 projection에 허용되지 않습니다.`);
    }
    assertSitesSpecificFieldSafety(child, `${path}.${key}`);
  }
}

export function assertPublicDemoProjection<T>(value: T): T {
  assertDemoProjectionPublicSafe(value);
  assertSitesSpecificFieldSafety(value);
  return value;
}

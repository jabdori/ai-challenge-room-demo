const SECRET_PATTERN_SOURCES = [
  String.raw`\bsk-[A-Za-z0-9_-]{12,}\b`,
  String.raw`\bgh[pousr]_[A-Za-z0-9_-]{12,}\b`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{12,}\b`,
  String.raw`\bxox[baprs]-[A-Za-z0-9_-]{12,}\b`,
  String.raw`\bglpat-[A-Za-z0-9_-]{12,}\b`,
  String.raw`\bAIza[A-Za-z0-9_-]{20,}\b`,
  String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`,
  String.raw`\beyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`,
  String.raw`\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b`,
  String.raw`\b(?:OPENAI_API_KEY|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|password|passwd|pwd|client_secret|api_secret|private_key)\s*[:=]\s*\S{4,}`,
] as const;

const PRIVATE_KEY_BLOCK_SOURCE =
  String.raw`-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)`;

const SENSITIVE_CREDENTIAL_KEY_PATTERN =
  /^(?:password|passwd|pwd|client_secret|api_secret|private_key|access_token|auth_token|api_key)$/i;

type JsonRecord = Record<string, unknown>;

const SECURITY_CONFUSABLE_TO_ASCII: Readonly<Record<string, string>> = Object.freeze({
  а: "a",
  А: "A",
  α: "a",
  Α: "A",
  в: "b",
  В: "B",
  β: "b",
  Β: "B",
  с: "c",
  С: "C",
  ϲ: "c",
  Ϲ: "C",
  ԁ: "d",
  е: "e",
  Е: "E",
  ε: "e",
  Ε: "E",
  ɡ: "g",
  һ: "h",
  Н: "H",
  η: "h",
  Η: "H",
  і: "i",
  І: "I",
  ι: "i",
  Ι: "I",
  ј: "j",
  Ј: "J",
  к: "k",
  К: "K",
  κ: "k",
  Κ: "K",
  ӏ: "l",
  м: "m",
  М: "M",
  μ: "m",
  Μ: "M",
  ո: "n",
  Ν: "N",
  о: "o",
  О: "O",
  ο: "o",
  Ο: "O",
  р: "p",
  Р: "P",
  ρ: "p",
  Ρ: "P",
  ѕ: "s",
  Ѕ: "S",
  т: "t",
  Т: "T",
  τ: "t",
  Τ: "T",
  у: "y",
  У: "Y",
  υ: "y",
  Υ: "Y",
  х: "x",
  Х: "X",
  χ: "x",
  Χ: "X",
});

/** 보안 검사는 Unicode 표시 차이가 아니라 정규화된 의미를 기준으로 수행합니다. */
export function normalizeSecurityText(value: string): string {
  return Array.from(value
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Pd}\u2212\uFE63\uFF0D]/gu, "-")
    .replace(/\p{Zs}/gu, " "))
    .map((character) => SECURITY_CONFUSABLE_TO_ASCII[character] ?? character)
    .join("");
}

function secretPatterns(global: boolean): RegExp[] {
  const flags = global ? "giu" : "iu";
  return [
    ...SECRET_PATTERN_SOURCES.map((source) => new RegExp(source, flags)),
    new RegExp(PRIVATE_KEY_BLOCK_SOURCE, flags),
  ];
}

export function containsPotentialSecret(value: string): boolean {
  const normalized = normalizeSecurityText(value);
  return secretPatterns(false).some((pattern) => pattern.test(normalized));
}

export function redactPotentialSecrets(value: string): string {
  let redacted = normalizeSecurityText(value);
  for (const pattern of secretPatterns(true)) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 알려진 런타임 식별자와 일반 credential 패턴을 함께 제거합니다. */
export function redactSensitiveText(
  value: string,
  sensitiveValues: readonly string[] = [],
): string {
  let redacted = redactPotentialSecrets(value);
  const explicitValues = [...new Set(
    sensitiveValues.filter((item) => item.length > 0),
  )].sort((left, right) => right.length - left.length);
  for (const sensitiveValue of explicitValues) {
    redacted = redacted.replace(
      new RegExp(escapeRegExp(sensitiveValue), "g"),
      "[REDACTED]",
    );
  }
  return redacted;
}

/** 객체의 문자열 값과 credential 형태 key를 모두 순회해 fail-closed합니다. */
export function assertNoPotentialSecret(
  value: unknown,
  location = "artifact",
): void {
  const visit = (item: unknown, path: string): void => {
    if (typeof item === "string") {
      if (containsPotentialSecret(item)) {
        throw new TypeError(`${path}에 비밀정보 또는 credential 형태 값이 있습니다.`);
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (typeof item !== "object" || item === null) return;
    for (const [key, child] of Object.entries(item as JsonRecord)) {
      if (
        SENSITIVE_CREDENTIAL_KEY_PATTERN.test(normalizeSecurityText(key))
        || containsPotentialSecret(key)
      ) {
        throw new TypeError(`${path}.[REDACTED_KEY]에 credential 형태 필드가 있습니다.`);
      }
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, location);
}

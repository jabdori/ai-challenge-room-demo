type JsonRecord = Record<string, unknown>;

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "apikey",
  "fileid",
  "openaiapikey",
  "providerid",
  "providerrequestid",
  "providerresponseid",
  "remoteid",
  "remoteresourceid",
  "requestid",
  "responseid",
  "uploadedfileid",
  "vectorstoreid",
]);
const FORBIDDEN_REMOTE_VALUE =
  /(?:sk-[A-Za-z0-9_-]{20,}|vs_[A-Za-z0-9]{16,}|file-[A-Za-z0-9]{16,}|resp_[A-Za-z0-9]{16,})\b/;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePublicKey(key: string): string {
  return key.normalize("NFKC").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

/**
 * 모든 공개 데모 projection에서 원격 resource, provider 응답,
 * API key 형태가 유출되지 않도록 같은 fail-closed 검사를 적용합니다.
 */
export function assertDemoProjectionPublicSafe(
  value: unknown,
  path = "$",
): void {
  if (typeof value === "string") {
    if (FORBIDDEN_REMOTE_VALUE.test(value)) {
      throw new Error(`${path}에 공개할 수 없는 원격 resource 식별자가 있습니다.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertDemoProjectionPublicSafe(item, `${path}[${index}]`);
    });
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PUBLIC_KEYS.has(normalizePublicKey(key))) {
      throw new Error(`${path}.${key}는 공개 projection에 허용되지 않습니다.`);
    }
    assertDemoProjectionPublicSafe(child, `${path}.${key}`);
  }
}

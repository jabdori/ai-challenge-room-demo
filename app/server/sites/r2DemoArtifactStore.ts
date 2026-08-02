import type {
  DemoArtifactNamespace,
  DemoArtifactReference,
  DemoArtifactStore,
} from "./demoContracts";

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

const ARTIFACT_NAMESPACES = new Set<DemoArtifactNamespace>([
  "live-evaluation-packs",
  "candidate-evidence",
  "errors",
  "cleanup-receipts",
  "recorded-fallback",
  "decision-memos",
]);
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});

interface ArtifactR2Object {
  readonly key: string;
  readonly size: number;
  readonly checksums: {
    readonly sha256?: ArrayBuffer;
  };
}

interface ArtifactR2ObjectBody extends ArtifactR2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface ArtifactR2Bucket {
  put(
    key: string,
    value: Uint8Array<ArrayBuffer>,
    options: {
      readonly onlyIf: Headers;
      readonly httpMetadata: {
        readonly contentType: string;
      };
      readonly sha256: Uint8Array<ArrayBuffer>;
    },
  ): Promise<ArtifactR2Object | null>;
  get(key: string): Promise<ArtifactR2ObjectBody | null>;
}

function canonicalize(
  value: unknown,
  ancestors: Set<object>,
): CanonicalJsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("ARTIFACT_NOT_CANONICAL_JSON");
    }
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError("ARTIFACT_NOT_CANONICAL_JSON");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, ancestors));
    }
    const result = Object.create(null) as {
      [key: string]: CanonicalJsonValue;
    };
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(
        (value as Record<string, unknown>)[key],
        ancestors,
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalBytes(value: Uint8Array): Uint8Array {
  try {
    const parsed = JSON.parse(decoder.decode(value)) as unknown;
    return encoder.encode(JSON.stringify(canonicalize(parsed, new Set<object>())));
  } catch (error) {
    if (
      error instanceof TypeError
      && error.message === "ARTIFACT_NOT_CANONICAL_JSON"
    ) {
      throw error;
    }
    throw new TypeError("ARTIFACT_NOT_CANONICAL_JSON");
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(
    value,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

async function sha256(value: Uint8Array<ArrayBuffer>): Promise<{
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly hex: string;
}> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", value),
  );
  return {
    bytes: digest,
    hex: bytesToHex(digest),
  };
}

function objectKey(
  namespace: DemoArtifactNamespace,
  digest: string,
): string {
  return `${namespace}/sha256/${digest}.json`;
}

function validateNamespace(value: string): asserts value is DemoArtifactNamespace {
  if (!ARTIFACT_NAMESPACES.has(value as DemoArtifactNamespace)) {
    throw new TypeError("ARTIFACT_REFERENCE_INVALID");
  }
}

function validateReference(reference: DemoArtifactReference): void {
  validateNamespace(reference.namespace);
  if (
    !SHA256_HEX.test(reference.sha256)
    || !Number.isSafeInteger(reference.byteLength)
    || reference.byteLength < 0
    || reference.objectKey !== objectKey(reference.namespace, reference.sha256)
  ) {
    throw new TypeError("ARTIFACT_REFERENCE_INVALID");
  }
}

function verifiedCanonicalBytes(value: Uint8Array): void {
  if (!bytesEqual(canonicalBytes(value), value)) {
    throw new TypeError("ARTIFACT_NOT_CANONICAL_JSON");
  }
}

/**
 * R2 객체에는 private 평가 증거를 보존하되, 호출자에게는 namespace·key·hash·길이만
 * 반환하는 콘텐츠 주소 기반 저장소입니다.
 */
export class R2DemoArtifactStore implements DemoArtifactStore {
  readonly #bucket: ArtifactR2Bucket;

  constructor(bucket: ArtifactR2Bucket) {
    this.#bucket = bucket;
  }

  async putContentAddressed(input: {
    readonly namespace: DemoArtifactNamespace;
    readonly canonicalBytes: Uint8Array;
    readonly sha256: string;
  }): Promise<DemoArtifactReference> {
    validateNamespace(input.namespace);
    if (!SHA256_HEX.test(input.sha256)) {
      throw new TypeError("ARTIFACT_HASH_MISMATCH");
    }

    // 호출자가 비동기 digest 도중 원본 배열을 바꾸지 못하도록 먼저 복제합니다.
    const bytes = ownedBytes(input.canonicalBytes);
    const digest = await sha256(bytes);
    if (digest.hex !== input.sha256) {
      throw new TypeError("ARTIFACT_HASH_MISMATCH");
    }
    verifiedCanonicalBytes(bytes);

    const reference: DemoArtifactReference = {
      namespace: input.namespace,
      objectKey: objectKey(input.namespace, digest.hex),
      sha256: digest.hex,
      byteLength: bytes.byteLength,
    };
    const created = await this.#bucket.put(reference.objectKey, bytes, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
      },
      sha256: digest.bytes,
    });

    if (created === null) {
      try {
        await this.getVerified(reference);
        return reference;
      } catch {
        throw new Error("ARTIFACT_CONTENT_CONFLICT");
      }
    }

    const returnedChecksum = created.checksums.sha256;
    if (
      created.key !== reference.objectKey
      || created.size !== reference.byteLength
      || returnedChecksum === undefined
      || !bytesEqual(new Uint8Array(returnedChecksum), digest.bytes)
    ) {
      throw new Error("ARTIFACT_PERSISTENCE_MISMATCH");
    }
    return reference;
  }

  async getVerified(reference: DemoArtifactReference): Promise<Uint8Array> {
    validateReference(reference);
    const object = await this.#bucket.get(reference.objectKey);
    if (object === null) {
      throw new Error("ARTIFACT_NOT_FOUND");
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (
      object.key !== reference.objectKey
      || object.size !== bytes.byteLength
      || bytes.byteLength !== reference.byteLength
    ) {
      throw new Error("ARTIFACT_LENGTH_MISMATCH");
    }

    const digest = await sha256(bytes);
    if (digest.hex !== reference.sha256) {
      throw new Error("ARTIFACT_HASH_MISMATCH");
    }
    const storedChecksum = object.checksums.sha256;
    if (
      storedChecksum !== undefined
      && !bytesEqual(new Uint8Array(storedChecksum), digest.bytes)
    ) {
      throw new Error("ARTIFACT_CHECKSUM_MISMATCH");
    }
    verifiedCanonicalBytes(bytes);
    return new Uint8Array(bytes);
  }
}

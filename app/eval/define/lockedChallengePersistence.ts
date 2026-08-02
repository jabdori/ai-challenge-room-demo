import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  assertExistingWriteOnceArtifactDirectory,
  persistWriteOnceFileWithClaim,
  prepareWriteOnceArtifactDirectory,
} from "../pack/persistence";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  assertAuthoritativeLockedChallengePack,
  createLockedChallengePack,
  type CreateLockedChallengePackInput,
  type LockedChallengePack,
} from "./defineContracts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PLAIN_JSON_MAX_ARRAY_LENGTH = 256;
const PLAIN_JSON_MAX_OBJECT_KEYS = 256;
const PLAIN_JSON_MAX_NODES = 4_096;
const PLAIN_JSON_MAX_DEPTH = 64;
const PLAIN_JSON_MAX_STRING_LENGTH = 100_000;

type JsonRecord = Record<string, unknown>;

interface CanonicalWrapper<T> {
  readonly payload_sha256: string;
  readonly payload: T;
}

interface LockedChallengeAuthorityClaim {
  readonly schema_version: "locked-challenge-authority-claim-v1";
  readonly artifact_kind: "LOCKED_CHALLENGE_AUTHORITY_CLAIM";
  readonly challenge_id: string;
  readonly challenge_version: string;
  readonly locked_challenge_pack_hash: string;
  readonly define_input_hash: string;
  readonly define_suggestion_hash: string;
}

export interface LockedChallengeAuthorityRecord {
  readonly schema_version: "locked-challenge-authority-record-v1";
  readonly artifact_kind: "LOCKED_CHALLENGE_AUTHORITY_RECORD";
  readonly synthetic: true;
  readonly creation_input: CreateLockedChallengePackInput;
  readonly pack: LockedChallengePack;
}

export interface LockedChallengeAuthorityPaths {
  readonly challengeDirectory: string;
  readonly claimPath: string;
  readonly recordPath: string;
}

export interface PersistLockedChallengeAuthorityResult {
  readonly path: string;
  readonly created: boolean;
  readonly payloadSha256: string;
}

export class LockedChallengePersistenceIntegrityError extends Error {
  readonly code = "LOCKED_CHALLENGE_PERSISTENCE_INTEGRITY" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LockedChallengePersistenceIntegrityError";
  }
}

function integrity(
  message: string,
  cause?: unknown,
): LockedChallengePersistenceIntegrityError {
  return new LockedChallengePersistenceIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function readPlainRecord(value: unknown, location: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw integrity(`${location}은(는) plain JSON 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw integrity(`${location}은(는) plain JSON 객체여야 합니다.`);
  }
  return value as JsonRecord;
}

function assertExactKeys(
  record: JsonRecord,
  expectedKeys: readonly string[],
  location: string,
): void {
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(record, key));
  const additional = Object.keys(record).filter((key) => !expected.has(key));
  if (missing.length > 0 || additional.length > 0) {
    throw integrity(
      `${location}의 exact 계약이 다릅니다. missing=${missing.join(",")} additional=${additional.join(",")}`,
    );
  }
}

function assertSha256(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw integrity(`${location}는 lowercase SHA-256이어야 합니다.`);
  }
}

function assertNonEmptyString(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || /\p{Cc}/u.test(value)) {
    throw integrity(`${location}는 제어 문자가 없는 문자열이어야 합니다.`);
  }
}

function snapshotPlainJsonData(
  value: unknown,
  location: string,
  state: {
    readonly seen: WeakSet<object>;
    nodes: number;
  } = {
    seen: new WeakSet<object>(),
    nodes: 0,
  },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (state.nodes > PLAIN_JSON_MAX_NODES) {
    throw integrity(
      `${location}의 plain JSON 전체 node 수가 ${PLAIN_JSON_MAX_NODES} 상한을 초과했습니다.`,
    );
  }
  if (depth > PLAIN_JSON_MAX_DEPTH) {
    throw integrity(
      `${location}의 plain JSON 깊이가 ${PLAIN_JSON_MAX_DEPTH} 상한을 초과했습니다.`,
    );
  }
  if (
    value === null
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "string") {
    if (value.length > PLAIN_JSON_MAX_STRING_LENGTH) {
      throw integrity(
        `${location}의 문자열 길이가 ${PLAIN_JSON_MAX_STRING_LENGTH} 상한을 초과했습니다.`,
      );
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw integrity(`${location}의 숫자는 유한해야 합니다.`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw integrity(`${location}은 plain JSON data여야 합니다.`);
  }
  if (state.seen.has(value)) {
    throw integrity(`${location}에는 순환 참조가 있을 수 없습니다.`);
  }
  state.seen.add(value);

  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (
    (isArray && prototype !== Array.prototype)
    || (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    throw integrity(`${location}은 plain JSON 객체 또는 배열이어야 합니다.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    throw integrity(`${location}에는 symbol 속성이 있을 수 없습니다.`);
  }
  if (!isArray && ownKeys.length > PLAIN_JSON_MAX_OBJECT_KEYS) {
    throw integrity(
      `${location} 객체의 key 수가 ${PLAIN_JSON_MAX_OBJECT_KEYS} 상한을 초과했습니다.`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);

  if (isArray) {
    const lengthDescriptor = descriptors.length;
    if (
      !lengthDescriptor
      || !("value" in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      throw integrity(`${location}.length는 plain data property여야 합니다.`);
    }
    const length = lengthDescriptor.value as number;
    if (length > PLAIN_JSON_MAX_ARRAY_LENGTH) {
      throw integrity(
        `${location} 배열 길이가 ${PLAIN_JSON_MAX_ARRAY_LENGTH} 상한을 초과했습니다.`,
      );
    }
    const allowed = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
    const additional = Object.keys(descriptors).filter((key) => !allowed.has(key));
    if (additional.length > 0) {
      throw integrity(`${location} 배열에는 추가 속성이 있을 수 없습니다.`);
    }
    return Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || !("value" in descriptor)
        || !descriptor.enumerable
      ) {
        throw integrity(
          `${location}[${index}]는 getter/setter 또는 hole이 아닌 plain data property여야 합니다.`,
        );
      }
      return snapshotPlainJsonData(
        descriptor.value,
        `${location}[${index}]`,
        state,
        depth + 1,
      );
    });
  }

  // `__proto__`도 일반 own key로 보존해 authority 입력 exact 계약을 우회하지 못하게 합니다.
  const snapshot = Object.create(null) as JsonRecord;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw integrity(
        `${location}의 property는 getter/setter accessor가 아닌 plain data property여야 합니다.`,
      );
    }
    snapshot[key] = snapshotPlainJsonData(
      descriptor.value,
      `${location}.[property]`,
      state,
      depth + 1,
    );
  }
  return snapshot;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function challengeAuthorityKey(challengeId: string, challengeVersion: string): string {
  assertNonEmptyString(challengeId, "challengeId");
  assertNonEmptyString(challengeVersion, "challengeVersion");
  return sha256CanonicalJson({
    schema_version: "locked-challenge-authority-key-v1",
    challenge_id: challengeId,
    challenge_version: challengeVersion,
  });
}

export function createLockedChallengeAuthorityPaths({
  outputDirectory,
  challengeId,
  challengeVersion,
  lockedChallengePackHash,
}: {
  readonly outputDirectory: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly lockedChallengePackHash: string;
}): LockedChallengeAuthorityPaths {
  assertNonEmptyString(outputDirectory, "outputDirectory");
  assertSha256(lockedChallengePackHash, "lockedChallengePackHash");
  const key = challengeAuthorityKey(challengeId, challengeVersion);
  const challengeDirectory = join(outputDirectory, `locked-challenge-${key}`);
  return Object.freeze({
    challengeDirectory,
    claimPath: join(challengeDirectory, "locked-challenge--claim.json"),
    recordPath: join(
      challengeDirectory,
      `locked-challenge--record-${lockedChallengePackHash}.json`,
    ),
  });
}

function wrapperBytes<T>(payload: T): Buffer {
  const wrapper: CanonicalWrapper<T> = {
    payload_sha256: sha256CanonicalJson(payload),
    payload,
  };
  return Buffer.from(`${canonicalJsonStringify(wrapper)}\n`, "utf8");
}

async function readSecureCanonicalFile(
  path: string,
  location: string,
  allowedLinkCounts: readonly number[] = [1],
): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || !allowedLinkCounts.includes(stat.nlink)
    ) {
      throw integrity(
        `${location}은 외부 hard-link가 없는 regular 0600 file이어야 합니다.`,
      );
    }
    const bytes = await handle.readFile();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw integrity(`${location} JSON을 parse할 수 없습니다.`, error);
    }
    if (!bytes.equals(Buffer.from(`${canonicalJsonStringify(parsed)}\n`, "utf8"))) {
      throw integrity(`${location} bytes가 canonical JSON과 다릅니다.`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof LockedChallengePersistenceIntegrityError) throw error;
    throw integrity(`${location}을 안전하게 읽을 수 없습니다.`, error);
  } finally {
    await handle?.close();
  }
}

function parseWrapper(value: unknown, location: string): CanonicalWrapper<unknown> {
  const record = readPlainRecord(value, location);
  assertExactKeys(record, ["payload_sha256", "payload"], location);
  assertSha256(record.payload_sha256, `${location}.payload_sha256`);
  if (sha256CanonicalJson(record.payload) !== record.payload_sha256) {
    throw integrity(`${location} payload digest가 다릅니다.`);
  }
  return { payload_sha256: record.payload_sha256, payload: record.payload };
}

function parseClaim(value: unknown): LockedChallengeAuthorityClaim {
  const record = readPlainRecord(value, "Locked Challenge claim");
  assertExactKeys(record, [
    "schema_version",
    "artifact_kind",
    "challenge_id",
    "challenge_version",
    "locked_challenge_pack_hash",
    "define_input_hash",
    "define_suggestion_hash",
  ], "Locked Challenge claim");
  if (
    record.schema_version !== "locked-challenge-authority-claim-v1"
    || record.artifact_kind !== "LOCKED_CHALLENGE_AUTHORITY_CLAIM"
  ) {
    throw integrity("Locked Challenge claim version 또는 kind가 다릅니다.");
  }
  assertNonEmptyString(record.challenge_id, "claim.challenge_id");
  assertNonEmptyString(record.challenge_version, "claim.challenge_version");
  assertSha256(record.locked_challenge_pack_hash, "claim.locked_challenge_pack_hash");
  assertSha256(record.define_input_hash, "claim.define_input_hash");
  assertSha256(record.define_suggestion_hash, "claim.define_suggestion_hash");
  return {
    schema_version: "locked-challenge-authority-claim-v1",
    artifact_kind: "LOCKED_CHALLENGE_AUTHORITY_CLAIM",
    challenge_id: record.challenge_id,
    challenge_version: record.challenge_version,
    locked_challenge_pack_hash: record.locked_challenge_pack_hash,
    define_input_hash: record.define_input_hash,
    define_suggestion_hash: record.define_suggestion_hash,
  };
}

function buildValidatedAuthorityRecord({
  creationInput,
  pack,
}: {
  readonly creationInput: CreateLockedChallengePackInput;
  readonly pack: LockedChallengePack;
}): LockedChallengeAuthorityRecord {
  assertAuthoritativeLockedChallengePack(pack);
  const creationInputSnapshot = snapshotPlainJsonData(
    creationInput,
    "Locked Challenge creation input",
  ) as CreateLockedChallengePackInput;
  const rebuilt = createLockedChallengePack(creationInputSnapshot);
  if (canonicalJsonStringify(rebuilt) !== canonicalJsonStringify(pack)) {
    throw integrity(
      "Locked Challenge pack이 제공된 Define source·인간 승인과 일치하지 않습니다.",
    );
  }
  return deepFreeze({
    schema_version: "locked-challenge-authority-record-v1",
    artifact_kind: "LOCKED_CHALLENGE_AUTHORITY_RECORD",
    synthetic: true,
    creation_input: creationInputSnapshot,
    pack: structuredClone(pack),
  });
}

async function assertFileEquals(
  path: string,
  expected: Buffer,
  location: string,
  allowedLinkCounts: readonly number[] = [1],
): Promise<void> {
  const actual = await readSecureCanonicalFile(
    path,
    location,
    allowedLinkCounts,
  );
  if (!actual.equals(expected)) {
    throw integrity(`${location}의 기존 bytes가 다른 claim 또는 record입니다.`);
  }
}

export async function persistLockedChallengeAuthorityRecord({
  outputDirectory,
  creationInput,
  pack,
}: {
  readonly outputDirectory: string;
  readonly creationInput: CreateLockedChallengePackInput;
  readonly pack: LockedChallengePack;
}): Promise<PersistLockedChallengeAuthorityResult> {
  const record = buildValidatedAuthorityRecord({ creationInput, pack });
  const paths = createLockedChallengeAuthorityPaths({
    outputDirectory,
    challengeId: pack.challenge_id,
    challengeVersion: pack.challenge_version,
    lockedChallengePackHash: pack.locked_challenge_pack_hash,
  });
  const claim: LockedChallengeAuthorityClaim = {
    schema_version: "locked-challenge-authority-claim-v1",
    artifact_kind: "LOCKED_CHALLENGE_AUTHORITY_CLAIM",
    challenge_id: pack.challenge_id,
    challenge_version: pack.challenge_version,
    locked_challenge_pack_hash: pack.locked_challenge_pack_hash,
    define_input_hash: record.creation_input.approval.define_input_hash,
    define_suggestion_hash: record.creation_input.approval.define_suggestion_hash,
  };
  const claimBytes = wrapperBytes(claim);
  const recordBytes = wrapperBytes(record);
  try {
    await prepareWriteOnceArtifactDirectory({
      rootDirectory: outputDirectory,
      artifactDirectory: paths.challengeDirectory,
    });
    await persistWriteOnceFileWithClaim({
      filePath: paths.claimPath,
      bytes: claimBytes,
      assertExistingMatches: (path) => assertFileEquals(
        path,
        claimBytes,
        "기존 Locked Challenge claim",
      ),
      assertPublishedFile: (path) => assertFileEquals(
        path,
        claimBytes,
        "공개된 Locked Challenge claim",
      ),
      requireTemporaryCleanup: true,
    });
    await assertFileEquals(
      paths.claimPath,
      claimBytes,
      "최종 Locked Challenge claim",
    );
    const stored = await persistWriteOnceFileWithClaim({
      filePath: paths.recordPath,
      bytes: recordBytes,
      assertExistingMatches: (path) => assertFileEquals(
        path,
        recordBytes,
        "기존 Locked Challenge record",
      ),
      assertPublishedFile: (path) => assertFileEquals(
        path,
        recordBytes,
        "공개된 Locked Challenge record",
      ),
      requireTemporaryCleanup: true,
    });
    await assertFileEquals(
      paths.recordPath,
      recordBytes,
      "최종 Locked Challenge record",
    );
    return Object.freeze({
      path: stored.path,
      created: stored.created,
      payloadSha256: sha256CanonicalJson(record),
    });
  } catch (error) {
    if (error instanceof LockedChallengePersistenceIntegrityError) throw error;
    throw integrity(
      "Locked Challenge authority 디렉터리를 안전하게 준비하거나 record를 저장할 수 없습니다.",
      error,
    );
  }
}

export async function loadLockedChallengeAuthorityRecord({
  outputDirectory,
  challengeId,
  challengeVersion,
}: {
  readonly outputDirectory: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
}): Promise<LockedChallengeAuthorityRecord> {
  const provisional = createLockedChallengeAuthorityPaths({
    outputDirectory,
    challengeId,
    challengeVersion,
    lockedChallengePackHash: "0".repeat(64),
  });
  await assertExistingWriteOnceArtifactDirectory({
    rootDirectory: outputDirectory,
    artifactDirectory: provisional.challengeDirectory,
  });
  const claimWrapper = parseWrapper(
    JSON.parse((await readSecureCanonicalFile(
      provisional.claimPath,
      "Locked Challenge claim",
    )).toString("utf8")) as unknown,
    "Locked Challenge claim wrapper",
  );
  const claim = parseClaim(claimWrapper.payload);
  if (claim.challenge_id !== challengeId || claim.challenge_version !== challengeVersion) {
    throw integrity("Locked Challenge claim 좌표가 요청과 다릅니다.");
  }
  const paths = createLockedChallengeAuthorityPaths({
    outputDirectory,
    challengeId,
    challengeVersion,
    lockedChallengePackHash: claim.locked_challenge_pack_hash,
  });
  const recordWrapper = parseWrapper(
    JSON.parse((await readSecureCanonicalFile(
      paths.recordPath,
      "Locked Challenge record",
    )).toString("utf8")) as unknown,
    "Locked Challenge record wrapper",
  );
  const raw = readPlainRecord(recordWrapper.payload, "Locked Challenge authority record");
  assertExactKeys(raw, [
    "schema_version",
    "artifact_kind",
    "synthetic",
    "creation_input",
    "pack",
  ], "Locked Challenge authority record");
  if (
    raw.schema_version !== "locked-challenge-authority-record-v1"
    || raw.artifact_kind !== "LOCKED_CHALLENGE_AUTHORITY_RECORD"
    || raw.synthetic !== true
  ) {
    throw integrity("Locked Challenge authority record version·kind·synthetic 계약이 다릅니다.");
  }
  const creationInput = raw.creation_input as CreateLockedChallengePackInput;
  const pack = createLockedChallengePack(creationInput);
  if (
    canonicalJsonStringify(pack) !== canonicalJsonStringify(raw.pack)
    || pack.locked_challenge_pack_hash !== claim.locked_challenge_pack_hash
    || creationInput.approval.define_input_hash !== claim.define_input_hash
    || creationInput.approval.define_suggestion_hash !== claim.define_suggestion_hash
  ) {
    throw integrity("Locked Challenge claim·source·record 무결성이 다릅니다.");
  }
  return deepFreeze({
    schema_version: "locked-challenge-authority-record-v1",
    artifact_kind: "LOCKED_CHALLENGE_AUTHORITY_RECORD",
    synthetic: true,
    creation_input: structuredClone(creationInput),
    pack,
  });
}

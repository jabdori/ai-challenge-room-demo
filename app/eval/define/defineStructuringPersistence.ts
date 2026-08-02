import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertExistingWriteOnceArtifactDirectory,
  persistWriteOnceFileWithClaim,
  prepareWriteOnceArtifactDirectory,
} from "../pack/persistence";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import { assertNoPotentialSecret } from "../runtime/secretSafety";
import {
  parseDefineStructuringInput,
  type DefineStructuringInput,
} from "./defineContracts";
import {
  parseDefineStructuringRunRecord,
  type DefineStructuringRunRecord,
} from "./runDefineStructuring";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ARTIFACT_FILENAME_PATTERN =
  /^define-structuring--record-([a-f0-9]{64})\.json$/;

type JsonRecord = Record<string, unknown>;

export interface DefineStructuringArtifact {
  readonly schema_version: "define-structuring-artifact-v1";
  readonly artifact_kind: "DEFINE_STRUCTURING_ARTIFACT";
  readonly synthetic: true;
  readonly authority: "ADVISORY_ONLY";
  readonly lock_authority: "NONE";
  readonly human_approval_status: "REQUIRED";
  readonly define_input: DefineStructuringInput;
  readonly run_record: DefineStructuringRunRecord;
  readonly artifact_hash: string;
}

interface DefineStructuringArtifactPayload {
  readonly schema_version: "define-structuring-artifact-v1";
  readonly artifact_kind: "DEFINE_STRUCTURING_ARTIFACT";
  readonly synthetic: true;
  readonly authority: "ADVISORY_ONLY";
  readonly lock_authority: "NONE";
  readonly human_approval_status: "REQUIRED";
  readonly define_input: DefineStructuringInput;
  readonly run_record: DefineStructuringRunRecord;
}

interface CanonicalArtifactWrapper {
  readonly payload_sha256: string;
  readonly payload: DefineStructuringArtifact;
}

export interface PersistDefineStructuringArtifactResult {
  readonly path: string;
  readonly created: boolean;
  readonly artifactHash: string;
}

const sourceReloadedArtifacts = new WeakSet<object>();

function integrity(message: string, cause?: unknown): TypeError {
  return new TypeError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function readRecord(value: unknown, location: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw integrity(`${location}은 plain JSON 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw integrity(`${location}은 plain JSON 객체여야 합니다.`);
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
      `${location} exact 계약이 다릅니다. missing=${missing.join(",")} additional=${additional.join(",")}`,
    );
  }
}

function assertSha256(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw integrity(`${location}는 lowercase SHA-256이어야 합니다.`);
  }
}

function buildPayload({
  input,
  run,
}: {
  readonly input: DefineStructuringInput;
  readonly run: DefineStructuringRunRecord;
}): DefineStructuringArtifactPayload {
  const parsedInput = parseDefineStructuringInput(input);
  const parsedRun = parseDefineStructuringRunRecord(run, parsedInput);
  return {
    schema_version: "define-structuring-artifact-v1",
    artifact_kind: "DEFINE_STRUCTURING_ARTIFACT",
    synthetic: true,
    authority: "ADVISORY_ONLY",
    lock_authority: "NONE",
    human_approval_status: "REQUIRED",
    define_input: parsedInput,
    run_record: parsedRun,
  };
}

export function buildDefineStructuringArtifact({
  input,
  run,
}: {
  readonly input: DefineStructuringInput;
  readonly run: DefineStructuringRunRecord;
}): DefineStructuringArtifact {
  const payload = buildPayload({ input, run });
  const artifact = {
    ...payload,
    artifact_hash: sha256CanonicalJson(payload),
  };
  assertNoPotentialSecret(artifact, "Define structuring artifact");
  return deepFreeze(artifact);
}

export function parseDefineStructuringArtifact(
  value: unknown,
  expectedInput: DefineStructuringInput,
): DefineStructuringArtifact {
  const record = readRecord(value, "Define structuring artifact");
  assertExactKeys(record, [
    "schema_version",
    "artifact_kind",
    "synthetic",
    "authority",
    "lock_authority",
    "human_approval_status",
    "define_input",
    "run_record",
    "artifact_hash",
  ], "Define structuring artifact");
  if (
    record.schema_version !== "define-structuring-artifact-v1"
    || record.artifact_kind !== "DEFINE_STRUCTURING_ARTIFACT"
    || record.synthetic !== true
    || record.authority !== "ADVISORY_ONLY"
    || record.lock_authority !== "NONE"
    || record.human_approval_status !== "REQUIRED"
  ) {
    throw integrity(
      "Define structuring artifact version·authority·approval 계약이 다릅니다.",
    );
  }
  assertSha256(record.artifact_hash, "Define structuring artifact.artifact_hash");
  const parsedInput = parseDefineStructuringInput(record.define_input);
  if (
    canonicalJsonStringify(parsedInput)
      !== canonicalJsonStringify(parseDefineStructuringInput(expectedInput))
  ) {
    throw integrity("Define structuring artifact 입력이 기대한 합성 업무 입력과 다릅니다.");
  }
  const parsedRun = parseDefineStructuringRunRecord(
    record.run_record,
    parsedInput,
  );
  const payload = buildPayload({ input: parsedInput, run: parsedRun });
  if (sha256CanonicalJson(payload) !== record.artifact_hash) {
    throw integrity("Define structuring artifact hash 무결성이 다릅니다.");
  }
  const artifact = {
    ...payload,
    artifact_hash: record.artifact_hash,
  };
  assertNoPotentialSecret(artifact, "Define structuring artifact");
  return deepFreeze(artifact);
}

function artifactDirectoryFor(
  outputDirectory: string,
  input: DefineStructuringInput,
): string {
  return join(
    resolve(outputDirectory),
    `define-structuring-${sha256CanonicalJson(parseDefineStructuringInput(input))}`,
  );
}

function artifactPathFor(
  outputDirectory: string,
  artifact: DefineStructuringArtifact,
): string {
  return join(
    artifactDirectoryFor(outputDirectory, artifact.define_input),
    `define-structuring--record-${artifact.artifact_hash}.json`,
  );
}

function wrapperBytes(artifact: DefineStructuringArtifact): Buffer {
  const wrapper: CanonicalArtifactWrapper = {
    payload_sha256: sha256CanonicalJson(artifact),
    payload: artifact,
  };
  return Buffer.from(`${canonicalJsonStringify(wrapper)}\n`, "utf8");
}

async function assertSecureDirectory(path: string, location: string): Promise<void> {
  let stat;
  let canonical;
  try {
    stat = await lstat(path);
    canonical = await realpath(path);
  } catch (error) {
    throw integrity(`${location}을 안전하게 검증할 수 없습니다.`, error);
  }
  if (
    canonical !== resolve(path)
    || !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== 0o700
  ) {
    throw integrity(`${location}은 canonical 0700 디렉터리여야 합니다.`);
  }
}

async function readSecureCanonicalBytes(
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
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw integrity(`${location} JSON을 parse할 수 없습니다.`, error);
    }
    const canonical = Buffer.from(
      `${canonicalJsonStringify(decoded)}\n`,
      "utf8",
    );
    if (!bytes.equals(canonical)) {
      throw integrity(`${location} bytes가 canonical JSON과 다릅니다.`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw integrity(`${location}을 안전하게 읽을 수 없습니다.`, error);
  } finally {
    await handle?.close();
  }
}

function parseWrapper(
  bytes: Buffer,
  expectedInput: DefineStructuringInput,
): DefineStructuringArtifact {
  const decoded = JSON.parse(bytes.toString("utf8")) as unknown;
  const record = readRecord(decoded, "Define structuring wrapper");
  assertExactKeys(
    record,
    ["payload_sha256", "payload"],
    "Define structuring wrapper",
  );
  assertSha256(record.payload_sha256, "Define structuring wrapper.payload_sha256");
  if (sha256CanonicalJson(record.payload) !== record.payload_sha256) {
    throw integrity("Define structuring wrapper payload hash 무결성이 다릅니다.");
  }
  return parseDefineStructuringArtifact(record.payload, expectedInput);
}

async function assertFileEquals(
  path: string,
  expectedBytes: Buffer,
  allowedLinkCounts: readonly number[] = [1],
): Promise<void> {
  const actual = await readSecureCanonicalBytes(
    path,
    "기존 Define structuring artifact",
    allowedLinkCounts,
  );
  if (!actual.equals(expectedBytes)) {
    throw integrity(
      "같은 content-addressed 경로의 Define structuring bytes가 다릅니다.",
    );
  }
}

export async function persistDefineStructuringArtifact({
  outputDirectory,
  artifact,
}: {
  readonly outputDirectory: string;
  readonly artifact: DefineStructuringArtifact;
}): Promise<PersistDefineStructuringArtifactResult> {
  const parsed = parseDefineStructuringArtifact(
    artifact,
    artifact.define_input,
  );
  const rootDirectory = resolve(outputDirectory);
  const artifactDirectory = artifactDirectoryFor(
    rootDirectory,
    parsed.define_input,
  );
  await prepareWriteOnceArtifactDirectory({
    rootDirectory,
    artifactDirectory,
  });
  await assertSecureDirectory(rootDirectory, "Define structuring root");
  await assertSecureDirectory(artifactDirectory, "Define structuring artifact directory");
  const path = artifactPathFor(rootDirectory, parsed);
  const bytes = wrapperBytes(parsed);
  const persisted = await persistWriteOnceFileWithClaim({
    filePath: path,
    bytes,
    assertExistingMatches: (existingPath) => (
      assertFileEquals(existingPath, bytes)
    ),
    assertPublishedFile: (publishedPath) => (
      assertFileEquals(publishedPath, bytes)
    ),
    requireTemporaryCleanup: true,
  });
  await assertFileEquals(persisted.path, bytes);
  return Object.freeze({
    path: persisted.path,
    created: persisted.created,
    artifactHash: parsed.artifact_hash,
  });
}

export async function loadDefineStructuringArtifact({
  outputDirectory,
  artifactPath,
  expectedInput,
}: {
  readonly outputDirectory: string;
  readonly artifactPath: string;
  readonly expectedInput: DefineStructuringInput;
}): Promise<DefineStructuringArtifact> {
  const rootDirectory = resolve(outputDirectory);
  const artifactDirectory = artifactDirectoryFor(rootDirectory, expectedInput);
  if (
    resolve(artifactPath) !== artifactPath
    || dirname(artifactPath) !== artifactDirectory
    || !ARTIFACT_FILENAME_PATTERN.test(basename(artifactPath))
  ) {
    throw integrity(
      "Define structuring artifact path가 기대한 content-addressed authority 좌표가 아닙니다.",
    );
  }
  await assertExistingWriteOnceArtifactDirectory({
    rootDirectory,
    artifactDirectory,
  });
  await assertSecureDirectory(rootDirectory, "Define structuring root");
  await assertSecureDirectory(artifactDirectory, "Define structuring artifact directory");
  const bytes = await readSecureCanonicalBytes(
    artifactPath,
    "Define structuring artifact",
  );
  const artifact = parseWrapper(bytes, expectedInput);
  const filenameMatch = ARTIFACT_FILENAME_PATTERN.exec(basename(artifactPath));
  if (
    !filenameMatch
    || filenameMatch[1] !== artifact.artifact_hash
    || artifactPathFor(rootDirectory, artifact) !== artifactPath
  ) {
    throw integrity(
      "Define structuring artifact filename과 payload content hash가 다릅니다.",
    );
  }
  sourceReloadedArtifacts.add(artifact);
  return artifact;
}

export function assertPersistedDefineStructuringArtifact(
  value: unknown,
): asserts value is DefineStructuringArtifact {
  if (
    typeof value !== "object"
    || value === null
    || !sourceReloadedArtifacts.has(value)
  ) {
    throw integrity(
      "Define structuring artifact는 write-once 저장 뒤 source reload한 객체여야 합니다.",
    );
  }
  const record = value as DefineStructuringArtifact;
  parseDefineStructuringArtifact(record, record.define_input);
}

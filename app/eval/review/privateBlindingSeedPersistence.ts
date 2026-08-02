import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import type { PrivateBlindingContext } from "./judgeEvidenceManifest";

const SHA256 = /^[a-f0-9]{64}$/;
const AUTHORITY_BRAND: unique symbol = Symbol(
  "AuthoritativePrivateBlindingContext",
);
const BRANDED_CONTEXTS = new WeakSet<object>();
const CONTEXT_PROVENANCE = new WeakMap<object, string>();
const PRODUCTION_ROOT = fileURLToPath(
  new URL("../../.runtime/authoritative-judge-seed/", import.meta.url),
);

type JsonRecord = Record<string, unknown>;

export class PrivateBlindingSeedPersistenceIntegrityError extends Error {
  readonly code = "PRIVATE_BLINDING_SEED_PERSISTENCE_INTEGRITY" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PrivateBlindingSeedPersistenceIntegrityError";
  }
}

export interface AuthoritativePrivateBlindingContext
  extends PrivateBlindingContext {
  readonly artifact_kind: "AUTHORITATIVE_PRIVATE_BLINDING_CONTEXT";
  readonly execution_pack_hash: string;
  readonly seed_commitment: string;
  readonly [AUTHORITY_BRAND]: true;
}

interface PrivateBlindingSeedRecord {
  readonly schema_version: "private-blinding-seed-authority-v1";
  readonly artifact_kind: "PRIVATE_BLINDING_SEED_AUTHORITY_RECORD";
  readonly execution_pack_hash: string;
  readonly master_blinding_seed: string;
  readonly seed_commitment: string;
}

export interface PrivateBlindingSeedPaths {
  readonly rootDirectory: string;
  readonly executionDirectory: string;
  readonly recordPath: string;
}

/** cold reload이 write 경로를 추측하지 않도록 저장하는 production provenance입니다. */
export interface AuthoritativePrivateBlindingContextReference {
  readonly root_directory: string;
  readonly record_path: string;
  readonly execution_pack_hash: string;
}

function integrity(
  message: string,
  cause?: unknown,
): PrivateBlindingSeedPersistenceIntegrityError {
  return new PrivateBlindingSeedPersistenceIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertSeed(seed: unknown): asserts seed is string {
  if (
    typeof seed !== "string"
    || seed.length < 48
    || /\p{Cc}/u.test(seed)
  ) {
    throw integrity(
      "private master blinding seed는 제어 문자가 없는 48자 이상의 값이어야 합니다.",
    );
  }
}

function seedCommitment(executionPackHash: string, seed: string): string {
  return sha256CanonicalJson({
    schema_version: "private-blinding-seed-execution-commitment-v1",
    execution_pack_hash: executionPackHash,
    master_blinding_seed: seed,
  });
}

function assertContained(parent: string, child: string, location: string): void {
  const fromParent = relative(resolve(parent), resolve(child));
  if (
    fromParent.length === 0
    || fromParent === ".."
    || fromParent.startsWith(`..${sep}`)
    || isAbsolute(fromParent)
  ) {
    throw integrity(`${location}은 authority root 하위여야 합니다.`);
  }
}

async function assertRealDirectory(
  directory: string,
  location: string,
): Promise<void> {
  let stat;
  let canonical;
  try {
    stat = await lstat(directory);
    canonical = await realpath(directory);
  } catch (error) {
    throw integrity(`${location} 디렉터리를 검증할 수 없습니다.`, error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw integrity(`${location}은 symlink가 아닌 실제 디렉터리여야 합니다.`);
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw integrity(`${location} 권한은 정확히 0700이어야 합니다.`);
  }
  if (canonical !== resolve(directory)) {
    throw integrity(`${location} 또는 ancestor에 symlink가 포함돼 있습니다.`);
  }
}

export function createPrivateBlindingSeedPaths({
  rootDirectory,
  executionPackHash,
}: {
  readonly rootDirectory: string;
  readonly executionPackHash: string;
}): PrivateBlindingSeedPaths {
  if (!SHA256.test(executionPackHash)) {
    throw integrity("private seed executionPackHash가 lowercase SHA-256이 아닙니다.");
  }
  const executionDirectory = join(rootDirectory, executionPackHash);
  return Object.freeze({
    rootDirectory,
    executionDirectory,
    recordPath: join(executionDirectory, "private-blinding-seed--record.json"),
  });
}

export function createAuthoritativePrivateBlindingContextReference({
  executionPackHash,
}: {
  readonly executionPackHash: string;
}): AuthoritativePrivateBlindingContextReference {
  const paths = createPrivateBlindingSeedPaths({
    rootDirectory: PRODUCTION_ROOT,
    executionPackHash,
  });
  return Object.freeze({
    root_directory: paths.rootDirectory,
    record_path: paths.recordPath,
    execution_pack_hash: executionPackHash,
  });
}

/** 테스트 authority root에 결합된 cold provenance 좌표를 만듭니다. */
export function createAuthoritativePrivateBlindingContextReferenceForTest({
  rootDirectory,
  executionPackHash,
}: {
  readonly rootDirectory: string;
  readonly executionPackHash: string;
}): AuthoritativePrivateBlindingContextReference {
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    throw integrity("test private seed reference API는 test 환경에서만 사용할 수 있습니다.");
  }
  const paths = createPrivateBlindingSeedPaths({
    rootDirectory: resolve(rootDirectory),
    executionPackHash,
  });
  return Object.freeze({
    root_directory: paths.rootDirectory,
    record_path: paths.recordPath,
    execution_pack_hash: executionPackHash,
  });
}

async function preparePaths(
  paths: PrivateBlindingSeedPaths,
  createProductionRoot: boolean,
): Promise<void> {
  if (resolve(dirname(paths.executionDirectory)) !== resolve(paths.rootDirectory)) {
    throw integrity("private seed execution 디렉터리는 root의 직접 하위여야 합니다.");
  }
  if (createProductionRoot) {
    const runtimeParent = dirname(resolve(paths.rootDirectory));
    try {
      await mkdir(runtimeParent, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw integrity("고정 private runtime parent를 만들 수 없습니다.", error);
      }
    }
    await assertRealDirectory(runtimeParent, "private seed production parent");
    try {
      await mkdir(paths.rootDirectory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw integrity("private seed production root를 만들 수 없습니다.", error);
      }
    }
  }
  await assertRealDirectory(paths.rootDirectory, "private seed authority root");
  assertContained(
    paths.rootDirectory,
    paths.executionDirectory,
    "private seed execution 디렉터리",
  );
  try {
    await mkdir(paths.executionDirectory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) {
      throw integrity("private seed execution 디렉터리를 만들 수 없습니다.", error);
    }
  }
  await assertRealDirectory(paths.executionDirectory, "private seed execution");
}

function wrapperBytes(payload: PrivateBlindingSeedRecord): Buffer {
  return Buffer.from(`${canonicalJsonStringify({
    payload_sha256: sha256CanonicalJson(payload),
    payload,
  })}\n`, "utf8");
}

function parseRecord(
  raw: unknown,
  expectedExecutionPackHash: string,
): PrivateBlindingSeedRecord {
  if (
    typeof raw !== "object"
    || raw === null
    || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype
  ) {
    throw integrity("private seed record payload는 plain JSON 객체여야 합니다.");
  }
  const record = raw as JsonRecord;
  if (
    Object.keys(record).sort().join(",")
      !== "artifact_kind,execution_pack_hash,master_blinding_seed,schema_version,seed_commitment"
    || record.schema_version !== "private-blinding-seed-authority-v1"
    || record.artifact_kind !== "PRIVATE_BLINDING_SEED_AUTHORITY_RECORD"
    || record.execution_pack_hash !== expectedExecutionPackHash
  ) {
    throw integrity("private seed record exact 계약 또는 execution binding이 다릅니다.");
  }
  assertSeed(record.master_blinding_seed);
  if (
    typeof record.seed_commitment !== "string"
    || record.seed_commitment !== seedCommitment(
      expectedExecutionPackHash,
      record.master_blinding_seed,
    )
  ) {
    throw integrity("private seed record commitment 무결성이 다릅니다.");
  }
  return Object.freeze({
    schema_version: "private-blinding-seed-authority-v1",
    artifact_kind: "PRIVATE_BLINDING_SEED_AUTHORITY_RECORD",
    execution_pack_hash: expectedExecutionPackHash,
    master_blinding_seed: record.master_blinding_seed,
    seed_commitment: record.seed_commitment,
  });
}

async function readRecord(
  paths: PrivateBlindingSeedPaths,
  executionPackHash: string,
): Promise<PrivateBlindingSeedRecord> {
  let handle;
  try {
    handle = await open(
      paths.recordPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== 1
    ) {
      throw integrity(
        "private seed authority record는 link count 1의 regular 0600 file이어야 합니다.",
      );
    }
    const bytes = await handle.readFile();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw integrity("private seed authority record JSON을 해석할 수 없습니다.", error);
    }
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
      || Object.getPrototypeOf(parsed) !== Object.prototype
    ) {
      throw integrity("private seed authority wrapper가 plain JSON 객체가 아닙니다.");
    }
    const wrapper = parsed as JsonRecord;
    if (
      Object.keys(wrapper).sort().join(",") !== "payload,payload_sha256"
      || typeof wrapper.payload_sha256 !== "string"
      || sha256CanonicalJson(wrapper.payload) !== wrapper.payload_sha256
    ) {
      throw integrity("private seed authority wrapper hash 무결성이 다릅니다.");
    }
    const record = parseRecord(wrapper.payload, executionPackHash);
    if (!bytes.equals(wrapperBytes(record))) {
      throw integrity("private seed authority record bytes가 canonical 형식과 다릅니다.");
    }
    return record;
  } catch (error) {
    if (error instanceof PrivateBlindingSeedPersistenceIntegrityError) throw error;
    throw integrity("private seed authority record를 안전하게 읽을 수 없습니다.", error);
  } finally {
    await handle?.close();
  }
}

function brand(
  record: PrivateBlindingSeedRecord,
  rootDirectory: string,
): AuthoritativePrivateBlindingContext {
  const context = {
    schema_version: "private-blinding-context-v1" as const,
    artifact_kind: "AUTHORITATIVE_PRIVATE_BLINDING_CONTEXT" as const,
    execution_pack_hash: record.execution_pack_hash,
    master_blinding_seed: record.master_blinding_seed,
    seed_commitment: record.seed_commitment,
  } as AuthoritativePrivateBlindingContext;
  Object.defineProperty(context, AUTHORITY_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  BRANDED_CONTEXTS.add(context);
  CONTEXT_PROVENANCE.set(context, resolve(rootDirectory));
  return Object.freeze(context);
}

async function loadOrCreate({
  rootDirectory,
  executionPackHash,
  generateSeed,
  createProductionRoot,
}: {
  readonly rootDirectory: string;
  readonly executionPackHash: string;
  readonly generateSeed: () => string;
  readonly createProductionRoot: boolean;
}): Promise<AuthoritativePrivateBlindingContext> {
  const paths = createPrivateBlindingSeedPaths({
    rootDirectory,
    executionPackHash,
  });
  await preparePaths(paths, createProductionRoot);
  const seed = generateSeed();
  assertSeed(seed);
  const record: PrivateBlindingSeedRecord = {
    schema_version: "private-blinding-seed-authority-v1",
    artifact_kind: "PRIVATE_BLINDING_SEED_AUTHORITY_RECORD",
    execution_pack_hash: executionPackHash,
    master_blinding_seed: seed,
    seed_commitment: seedCommitment(executionPackHash, seed),
  };
  const temporaryPath = join(
    paths.executionDirectory,
    `.private-blinding-seed.tmp-${process.pid}-${randomUUID()}`,
  );
  let temporaryCreated = false;
  try {
    const temporary = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await temporary.writeFile(wrapperBytes(record));
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    try {
      await link(temporaryPath, paths.recordPath);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw integrity("private seed authority record를 원자 공개할 수 없습니다.", error);
      }
    }
  } finally {
    if (temporaryCreated) {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        throw integrity("private seed 임시 authority record를 정리할 수 없습니다.", error);
      }
    }
  }
  return brand(
    await readRecord(paths, executionPackHash),
    rootDirectory,
  );
}

async function loadExisting({
  rootDirectory,
  executionPackHash,
}: {
  readonly rootDirectory: string;
  readonly executionPackHash: string;
}): Promise<AuthoritativePrivateBlindingContext> {
  const paths = createPrivateBlindingSeedPaths({
    rootDirectory,
    executionPackHash,
  });
  // cold reload은 authority namespace를 만들거나 seed를 생성하지 않습니다.
  // 원본 record가 없거나 검증할 수 없으면 fail-closed해야 합니다.
  await assertRealDirectory(paths.rootDirectory, "private seed authority root");
  assertContained(
    paths.rootDirectory,
    paths.executionDirectory,
    "private seed execution 디렉터리",
  );
  await assertRealDirectory(paths.executionDirectory, "private seed execution");
  return brand(
    await readRecord(paths, executionPackHash),
    rootDirectory,
  );
}

export function assertAuthoritativePrivateBlindingContext({
  context,
  expectedExecutionPackHash,
}: {
  readonly context: unknown;
  readonly expectedExecutionPackHash: string;
}): AuthoritativePrivateBlindingContext {
  if (
    typeof context !== "object"
    || context === null
    || !BRANDED_CONTEXTS.has(context)
    || (context as Partial<AuthoritativePrivateBlindingContext>)[AUTHORITY_BRAND]
      !== true
    || CONTEXT_PROVENANCE.get(context) === undefined
  ) {
    throw integrity(
      "private blinding context는 authority persistence가 반환한 branded 객체여야 합니다.",
    );
  }
  const value = context as AuthoritativePrivateBlindingContext;
  if (
    value.execution_pack_hash !== expectedExecutionPackHash
    || value.seed_commitment !== seedCommitment(
      expectedExecutionPackHash,
      value.master_blinding_seed,
    )
  ) {
    throw integrity("private blinding context의 execution·seed commitment가 다릅니다.");
  }
  return value;
}

export async function loadOrCreateAuthoritativePrivateBlindingContext({
  executionPackHash,
}: {
  readonly executionPackHash: string;
}): Promise<AuthoritativePrivateBlindingContext>;
export async function loadOrCreateAuthoritativePrivateBlindingContext({
  executionPackHash,
}: {
  readonly executionPackHash: string;
}): Promise<AuthoritativePrivateBlindingContext> {
  return loadOrCreate({
    rootDirectory: PRODUCTION_ROOT,
    executionPackHash,
    generateSeed: () => randomBytes(32).toString("hex"),
    createProductionRoot: true,
  });
}

/** 재시작은 기존 production private seed record만 다시 읽을 수 있습니다. */
export async function loadAuthoritativePrivateBlindingContext({
  executionPackHash,
}: {
  readonly executionPackHash: string;
}): Promise<AuthoritativePrivateBlindingContext> {
  return loadExisting({
    rootDirectory: createAuthoritativePrivateBlindingContextReference({
      executionPackHash,
    }).root_directory,
    executionPackHash,
  });
}

export async function loadAuthoritativePrivateBlindingContextFromReference({
  reference,
}: {
  readonly reference: AuthoritativePrivateBlindingContextReference;
}): Promise<AuthoritativePrivateBlindingContext> {
  const expected = createAuthoritativePrivateBlindingContextReference({
    executionPackHash: reference.execution_pack_hash,
  });
  if (
    canonicalJsonStringify(reference) !== canonicalJsonStringify(expected)
  ) {
    throw integrity("private seed cold provenance reference가 production authority 좌표와 다릅니다.");
  }
  return loadExisting({
    rootDirectory: expected.root_directory,
    executionPackHash: expected.execution_pack_hash,
  });
}

/** 테스트 root에 결합된 reference만 strict cold-load하는 경계입니다. */
export async function loadAuthoritativePrivateBlindingContextFromReferenceForTest({
  reference,
  rootDirectory,
}: {
  readonly reference: AuthoritativePrivateBlindingContextReference;
  readonly rootDirectory: string;
}): Promise<AuthoritativePrivateBlindingContext> {
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    throw integrity("test private seed cold reference API는 test 환경에서만 사용할 수 있습니다.");
  }
  const expected = createAuthoritativePrivateBlindingContextReferenceForTest({
    rootDirectory,
    executionPackHash: reference.execution_pack_hash,
  });
  if (canonicalJsonStringify(reference) !== canonicalJsonStringify(expected)) {
    throw integrity("private seed cold provenance reference가 test authority 좌표와 다릅니다.");
  }
  return loadExisting({
    rootDirectory: expected.root_directory,
    executionPackHash: expected.execution_pack_hash,
  });
}

export async function loadOrCreateAuthoritativePrivateBlindingContextForTest({
  rootDirectory,
  executionPackHash,
  generateSeed,
}: {
  readonly rootDirectory: string;
  readonly executionPackHash: string;
  readonly generateSeed: () => string;
}): Promise<AuthoritativePrivateBlindingContext> {
  if (process.env.NODE_ENV !== "test") {
    throw integrity("test private seed authority API는 test 환경에서만 사용할 수 있습니다.");
  }
  return loadOrCreate({
    rootDirectory,
    executionPackHash,
    generateSeed,
    createProductionRoot: false,
  });
}

/** 테스트에서 create 경로와 분리해 strict cold-load 거부를 검증합니다. */
export async function loadAuthoritativePrivateBlindingContextForTest({
  rootDirectory,
  executionPackHash,
}: {
  readonly rootDirectory: string;
  readonly executionPackHash: string;
}): Promise<AuthoritativePrivateBlindingContext> {
  if (process.env.NODE_ENV !== "test") {
    throw integrity("test private seed strict load API는 test 환경에서만 사용할 수 있습니다.");
  }
  return loadExisting({ rootDirectory, executionPackHash });
}

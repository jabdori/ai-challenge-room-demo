import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  buildMasterBlindingSeedCommitment,
  validateJudgeEvidencePrecommitManifest,
  type JudgeEvidencePrecommitManifest,
} from "./judgeEvidenceManifest";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_STORE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const AUTHORITATIVE_PRECOMMIT_BRAND: unique symbol = Symbol(
  "AuthoritativeBlindingPrecommit",
);
const TEST_AUTHORITY_BRAND: unique symbol = Symbol(
  "TestAuthoritativeBlindingPrecommitAuthority",
);
const AUTHORITATIVE_STORE_BRAND: unique symbol = Symbol(
  "AuthoritativeBlindingPrecommitStore",
);
const BRANDED_PRECOMMITS = new WeakSet<object>();
const BRANDED_TEST_AUTHORITIES = new WeakSet<object>();
const BRANDED_STORES = new WeakSet<object>();
const PRECOMMIT_PROVENANCE = new WeakMap<object, StoreProvenance>();
const TEST_AUTHORITY_PROVENANCE = new WeakMap<object, AuthorityProvenance>();
const STORE_PROVENANCE = new WeakMap<object, StoreProvenance>();
const PRODUCTION_AUTHORITY_ROOT = fileURLToPath(
  new URL("../../.runtime/authoritative-judge-precommit/", import.meta.url),
);

type JsonRecord = Record<string, unknown>;

interface AuthorityProvenance {
  readonly rootDirectory: string;
  readonly authorityRootId: string;
  readonly mode: "PRODUCTION" | "TEST_ONLY";
}

interface StoreProvenance extends AuthorityProvenance {
  readonly storeName: string;
  readonly storeDirectory: string;
  readonly authorityStoreId: string;
}

export class JudgeEvidencePrecommitPersistenceIntegrityError extends Error {
  readonly code = "JUDGE_EVIDENCE_PRECOMMIT_PERSISTENCE_INTEGRITY" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JudgeEvidencePrecommitPersistenceIntegrityError";
  }
}

export interface AuthoritativeBlindingPrecommit {
  readonly schema_version: "authoritative-blinding-precommit-v2";
  readonly artifact_kind: "AUTHORITATIVE_BLINDING_PRECOMMIT";
  readonly authority_root_id: string;
  readonly authority_store_id: string;
  readonly execution_pack_hash: string;
  readonly manifest_digest: string;
  readonly master_blinding_seed_commitment: string;
  readonly manifest: JudgeEvidencePrecommitManifest;
  readonly [AUTHORITATIVE_PRECOMMIT_BRAND]: true;
}

export interface TestAuthoritativeBlindingPrecommitAuthority {
  readonly schema_version: "test-authoritative-blinding-precommit-authority-v1";
  readonly authority_root_id: string;
  readonly [TEST_AUTHORITY_BRAND]: true;
}

export interface AuthoritativeBlindingPrecommitStore {
  readonly schema_version: "authoritative-blinding-precommit-store-v1";
  readonly authority_root_id: string;
  readonly authority_store_id: string;
  readonly store_name: string;
  readonly [AUTHORITATIVE_STORE_BRAND]: true;
}

export interface AuthoritativeBlindingPrecommitPaths {
  readonly authorityClaimPath: string;
  readonly executionDirectory: string;
  readonly recordPath: string;
}

/** cold reload이 기존 Judge precommit만 읽게 하는 immutable provenance 좌표입니다. */
export interface AuthoritativeBlindingPrecommitReference {
  readonly root_directory: string;
  readonly authority_claim_path: string;
  readonly record_path: string;
  readonly authority_root_id: string;
  readonly authority_store_id: string;
  readonly execution_pack_hash: string;
  readonly manifest_digest: string;
  readonly manifest_hash: string;
}

export interface AuthoritativeBlindingPrecommitCaseBinding {
  readonly executionPackHash: string;
  readonly authorityRootId: string;
  readonly authorityStoreId: string;
  readonly precommitManifestDigest: string;
  readonly precommitManifestHash: string;
  readonly caseId: string;
  readonly judgeInputHash: string;
  readonly privateMappingHash: string;
  readonly precommitCaseBindingHash: string;
}

interface JudgeEvidencePrecommitClaim {
  readonly schema_version: "judge-evidence-precommit-claim-v2";
  readonly artifact_kind: "JUDGE_EVIDENCE_PRECOMMIT_CLAIM";
  readonly authority_root_id: string;
  readonly authority_store_id: string;
  readonly execution_pack_hash: string;
  readonly manifest_digest: string;
  readonly master_blinding_seed_commitment: string;
}

interface CanonicalArtifactWrapper<T> {
  readonly payload_sha256: string;
  readonly payload: T;
}

function integrity(
  message: string,
  cause?: unknown,
): JudgeEvidencePrecommitPersistenceIntegrityError {
  return new JudgeEvidencePrecommitPersistenceIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
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
      `${location}의 exact key 계약이 다릅니다. missing=${missing.join(",")} additional=${additional.join(",")}`,
    );
  }
}

function assertSha256(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw integrity(`${location}는 lowercase SHA-256이어야 합니다.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalWrapperBytes<T>(payload: T): Buffer {
  return Buffer.from(`${canonicalJsonStringify({
    payload_sha256: sha256CanonicalJson(payload),
    payload,
  } satisfies CanonicalArtifactWrapper<T>)}\n`, "utf8");
}

function assertContainedPath(rootDirectory: string, childPath: string, location: string): void {
  const fromRoot = relative(resolve(rootDirectory), resolve(childPath));
  if (
    fromRoot.length === 0
    || fromRoot === ".."
    || fromRoot.startsWith(`..${sep}`)
    || isAbsolute(fromRoot)
  ) {
    throw integrity(`${location}은(는) 권위 root 하위 경로여야 합니다.`);
  }
}

async function assertDirectoryNoSymlink(
  directory: string,
  location: string,
): Promise<string> {
  let stat;
  try {
    stat = await lstat(directory);
  } catch (error) {
    throw integrity(`${location} 디렉터리를 lstat로 검증할 수 없습니다.`, error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw integrity(`${location}은(는) symlink가 아닌 실제 디렉터리여야 합니다.`);
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw integrity(`${location} 권한은 정확히 0700이어야 합니다.`);
  }
  let canonical;
  try {
    canonical = await realpath(directory);
  } catch (error) {
    throw integrity(`${location} realpath를 검증할 수 없습니다.`, error);
  }
  if (canonical !== resolve(directory)) {
    throw integrity(`${location} 또는 ancestor에 symlink가 포함돼 있습니다.`);
  }
  return canonical;
}

async function createDirectDirectoryNoSymlink({
  parentDirectory,
  childDirectory,
  location,
}: {
  readonly parentDirectory: string;
  readonly childDirectory: string;
  readonly location: string;
}): Promise<void> {
  if (resolve(dirname(childDirectory)) !== resolve(parentDirectory)) {
    throw integrity(`${location}은(는) 검증된 parent의 직접 하위여야 합니다.`);
  }
  await assertDirectoryNoSymlink(parentDirectory, `${location} parent`);
  try {
    await mkdir(childDirectory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw integrity(`${location}을 non-recursive 방식으로 만들 수 없습니다.`, error);
    }
  }
  const canonical = await assertDirectoryNoSymlink(childDirectory, location);
  assertContainedPath(parentDirectory, canonical, location);
}

async function initializeAuthorityRoot({
  rootDirectory,
  mode,
}: {
  readonly rootDirectory: string;
  readonly mode: AuthorityProvenance["mode"];
}): Promise<AuthorityProvenance> {
  const resolvedRoot = resolve(rootDirectory);
  if (mode === "PRODUCTION") {
    const parent = dirname(resolvedRoot);
    try {
      await mkdir(parent, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw integrity(
          "고정 production runtime parent를 non-recursive 방식으로 만들 수 없습니다.",
          error,
        );
      }
    }
    await assertDirectoryNoSymlink(parent, "production authority parent");
    try {
      await mkdir(resolvedRoot, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw integrity(
          "production authority root를 non-recursive 방식으로 만들 수 없습니다.",
          error,
        );
      }
    }
  }
  const canonicalRoot = await assertDirectoryNoSymlink(
    resolvedRoot,
    `${mode} authority root`,
  );
  await createDirectDirectoryNoSymlink({
    parentDirectory: canonicalRoot,
    childDirectory: join(canonicalRoot, "claims"),
    location: "authority claims directory",
  });
  await createDirectDirectoryNoSymlink({
    parentDirectory: canonicalRoot,
    childDirectory: join(canonicalRoot, "stores"),
    location: "authority stores directory",
  });
  return Object.freeze({
    rootDirectory: canonicalRoot,
    authorityRootId: sha256CanonicalJson({
      schema_version: "authoritative-blinding-precommit-root-v1",
      canonical_root: canonicalRoot,
      mode,
    }),
    mode,
  });
}

function assertTestEnvironment(): void {
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    throw integrity("임의 권위 root 생성 API는 test 환경에서만 사용할 수 있습니다.");
  }
}

export async function createTestAuthoritativeBlindingPrecommitAuthority({
  rootDirectory,
}: {
  readonly rootDirectory: string;
}): Promise<TestAuthoritativeBlindingPrecommitAuthority> {
  assertTestEnvironment();
  const provenance = await initializeAuthorityRoot({
    rootDirectory,
    mode: "TEST_ONLY",
  });
  const authority = {
    schema_version: "test-authoritative-blinding-precommit-authority-v1" as const,
    authority_root_id: provenance.authorityRootId,
  } as TestAuthoritativeBlindingPrecommitAuthority;
  Object.defineProperty(authority, TEST_AUTHORITY_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  BRANDED_TEST_AUTHORITIES.add(authority);
  TEST_AUTHORITY_PROVENANCE.set(authority, provenance);
  return Object.freeze(authority);
}

async function createStoreFromAuthority(
  authority: AuthorityProvenance,
  storeName: string,
): Promise<AuthoritativeBlindingPrecommitStore> {
  if (!SAFE_STORE_NAME.test(storeName)) {
    throw integrity("권위 store 이름은 안전한 소문자 단일 식별자여야 합니다.");
  }
  const storesDirectory = join(authority.rootDirectory, "stores");
  await assertDirectoryNoSymlink(authority.rootDirectory, "authority root");
  await assertDirectoryNoSymlink(storesDirectory, "authority stores directory");
  const storeDirectory = join(storesDirectory, storeName);
  await createDirectDirectoryNoSymlink({
    parentDirectory: storesDirectory,
    childDirectory: storeDirectory,
    location: "authority store directory",
  });
  const provenance: StoreProvenance = Object.freeze({
    ...authority,
    storeName,
    storeDirectory,
    authorityStoreId: sha256CanonicalJson({
      schema_version: "authoritative-blinding-precommit-store-provenance-v1",
      authority_root_id: authority.authorityRootId,
      store_name: storeName,
      canonical_store_root: storeDirectory,
    }),
  });
  return brandStore(provenance);
}

function brandStore(
  provenance: StoreProvenance,
): AuthoritativeBlindingPrecommitStore {
  const store = {
    schema_version: "authoritative-blinding-precommit-store-v1" as const,
    authority_root_id: provenance.authorityRootId,
    authority_store_id: provenance.authorityStoreId,
    store_name: provenance.storeName,
  } as AuthoritativeBlindingPrecommitStore;
  Object.defineProperty(store, AUTHORITATIVE_STORE_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  BRANDED_STORES.add(store);
  STORE_PROVENANCE.set(store, provenance);
  return Object.freeze(store);
}

export async function createTestAuthoritativeBlindingPrecommitStore({
  authority,
  storeName,
}: {
  readonly authority: TestAuthoritativeBlindingPrecommitAuthority;
  readonly storeName: string;
}): Promise<AuthoritativeBlindingPrecommitStore> {
  assertTestEnvironment();
  if (
    !BRANDED_TEST_AUTHORITIES.has(authority)
    || (authority as Partial<TestAuthoritativeBlindingPrecommitAuthority>)[TEST_AUTHORITY_BRAND]
      !== true
  ) {
    throw integrity("test authority는 이 모듈이 발급한 branded 객체여야 합니다.");
  }
  const provenance = TEST_AUTHORITY_PROVENANCE.get(authority);
  if (provenance === undefined) throw integrity("test authority provenance가 없습니다.");
  return createStoreFromAuthority(provenance, storeName);
}

let productionStorePromise: Promise<AuthoritativeBlindingPrecommitStore> | undefined;

async function getProductionStore(): Promise<AuthoritativeBlindingPrecommitStore> {
  productionStorePromise ??= (async () => {
    const authority = await initializeAuthorityRoot({
      rootDirectory: PRODUCTION_AUTHORITY_ROOT,
      mode: "PRODUCTION",
    });
    return createStoreFromAuthority(authority, "primary");
  })();
  return productionStorePromise;
}

function productionStoreProvenance(): StoreProvenance {
  const rootDirectory = resolve(PRODUCTION_AUTHORITY_ROOT);
  const authorityRootId = sha256CanonicalJson({
    schema_version: "authoritative-blinding-precommit-root-v1",
    canonical_root: rootDirectory,
    mode: "PRODUCTION",
  });
  const storeName = "primary";
  const storeDirectory = join(rootDirectory, "stores", storeName);
  return Object.freeze({
    rootDirectory,
    authorityRootId,
    mode: "PRODUCTION",
    storeName,
    storeDirectory,
    authorityStoreId: sha256CanonicalJson({
      schema_version: "authoritative-blinding-precommit-store-provenance-v1",
      authority_root_id: authorityRootId,
      store_name: storeName,
      canonical_store_root: storeDirectory,
    }),
  });
}

async function getExistingProductionStore(): Promise<AuthoritativeBlindingPrecommitStore> {
  const expected = productionStoreProvenance();
  const rootDirectory = await assertDirectoryNoSymlink(
    expected.rootDirectory,
    "production authority root",
  );
  await assertDirectoryNoSymlink(join(rootDirectory, "claims"), "production authority claims directory");
  await assertDirectoryNoSymlink(join(rootDirectory, "stores"), "production authority stores directory");
  const storeDirectory = await assertDirectoryNoSymlink(
    expected.storeDirectory,
    "production authority store directory",
  );
  if (rootDirectory !== expected.rootDirectory || storeDirectory !== expected.storeDirectory) {
    throw integrity("production Judge precommit authority root 또는 store 좌표가 다릅니다.");
  }
  return brandStore(expected);
}

function assertBrandedStore(store: unknown): StoreProvenance {
  if (
    typeof store !== "object"
    || store === null
    || !BRANDED_STORES.has(store)
    || (store as Partial<AuthoritativeBlindingPrecommitStore>)[AUTHORITATIVE_STORE_BRAND]
      !== true
  ) {
    throw integrity("권위 store는 이 모듈이 발급한 branded 객체여야 합니다.");
  }
  const provenance = STORE_PROVENANCE.get(store);
  if (provenance === undefined) throw integrity("권위 store provenance가 없습니다.");
  const record = readPlainRecord(store, "authoritative store");
  assertExactKeys(record, [
    "schema_version",
    "authority_root_id",
    "authority_store_id",
    "store_name",
  ], "authoritative store");
  if (
    record.schema_version !== "authoritative-blinding-precommit-store-v1"
    || record.authority_root_id !== provenance.authorityRootId
    || record.authority_store_id !== provenance.authorityStoreId
    || record.store_name !== provenance.storeName
  ) {
    throw integrity("권위 store의 공개 provenance가 module-private provenance와 다릅니다.");
  }
  return provenance;
}

export function createAuthoritativeBlindingPrecommitPaths({
  store,
  executionPackHash,
  manifestDigest,
}: {
  readonly store: AuthoritativeBlindingPrecommitStore;
  readonly executionPackHash: string;
  readonly manifestDigest: string;
}): AuthoritativeBlindingPrecommitPaths {
  const provenance = assertBrandedStore(store);
  assertSha256(executionPackHash, "executionPackHash");
  assertSha256(manifestDigest, "manifestDigest");
  const executionDirectory = join(provenance.storeDirectory, executionPackHash);
  return Object.freeze({
    authorityClaimPath: join(
      provenance.rootDirectory,
      "claims",
      `judge-evidence-precommit--${executionPackHash}.json`,
    ),
    executionDirectory,
    recordPath: join(
      executionDirectory,
      `judge-evidence-precommit--record-${manifestDigest}.json`,
    ),
  });
}

function createBlindingPrecommitReferenceForProvenance({
  provenance,
  executionPackHash,
  manifestDigest,
  manifestHash,
}: {
  readonly provenance: StoreProvenance;
  readonly executionPackHash: string;
  readonly manifestDigest: string;
  readonly manifestHash: string;
}): AuthoritativeBlindingPrecommitReference {
  assertSha256(executionPackHash, "executionPackHash");
  assertSha256(manifestDigest, "manifestDigest");
  assertSha256(manifestHash, "manifestHash");
  const executionDirectory = join(provenance.storeDirectory, executionPackHash);
  return Object.freeze({
    root_directory: provenance.rootDirectory,
    authority_claim_path: join(
      provenance.rootDirectory,
      "claims",
      `judge-evidence-precommit--${executionPackHash}.json`,
    ),
    record_path: join(
      executionDirectory,
      `judge-evidence-precommit--record-${manifestDigest}.json`,
    ),
    authority_root_id: provenance.authorityRootId,
    authority_store_id: provenance.authorityStoreId,
    execution_pack_hash: executionPackHash,
    manifest_digest: manifestDigest,
    manifest_hash: manifestHash,
  });
}

export function createAuthoritativeBlindingPrecommitReference({
  executionPackHash,
  manifestDigest,
  manifestHash,
}: {
  readonly executionPackHash: string;
  readonly manifestDigest: string;
  readonly manifestHash: string;
}): AuthoritativeBlindingPrecommitReference {
  return createBlindingPrecommitReferenceForProvenance({
    provenance: productionStoreProvenance(),
    executionPackHash,
    manifestDigest,
    manifestHash,
  });
}

/** TEST_ONLY store에 결합된 cold provenance 좌표를 만듭니다. */
export function createAuthoritativeBlindingPrecommitReferenceForTest({
  store,
  executionPackHash,
  manifestDigest,
  manifestHash,
}: {
  readonly store: AuthoritativeBlindingPrecommitStore;
  readonly executionPackHash: string;
  readonly manifestDigest: string;
  readonly manifestHash: string;
}): AuthoritativeBlindingPrecommitReference {
  assertTestEnvironment();
  const provenance = assertBrandedStore(store);
  if (provenance.mode !== "TEST_ONLY") {
    throw integrity("test reference API에는 TEST_ONLY store만 사용할 수 있습니다.");
  }
  return createBlindingPrecommitReferenceForProvenance({
    provenance,
    executionPackHash,
    manifestDigest,
    manifestHash,
  });
}

async function assertStoreDirectories(provenance: StoreProvenance): Promise<void> {
  const root = await assertDirectoryNoSymlink(provenance.rootDirectory, "authority root");
  const claims = await assertDirectoryNoSymlink(
    join(root, "claims"),
    "authority claims directory",
  );
  const stores = await assertDirectoryNoSymlink(
    join(root, "stores"),
    "authority stores directory",
  );
  const store = await assertDirectoryNoSymlink(
    provenance.storeDirectory,
    "authority store directory",
  );
  assertContainedPath(root, claims, "authority claims directory");
  assertContainedPath(root, stores, "authority stores directory");
  assertContainedPath(stores, store, "authority store directory");
}

async function readPrivateCanonicalJson(
  filePath: string,
  location: string,
): Promise<unknown> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw integrity(`${location}을 O_NOFOLLOW로 안전하게 열 수 없습니다.`, error);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw integrity(`${location}은(는) regular file이어야 합니다.`);
    if ((stat.mode & 0o777) !== 0o600) {
      throw integrity(`${location} 권한은 정확히 0600이어야 합니다.`);
    }
    if (stat.nlink !== 1 && !filePath.endsWith(".tmp")) {
      throw integrity(`${location} link count는 정확히 1이어야 합니다.`);
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
    return parsed;
  } finally {
    await handle.close();
  }
}

function parseWrapper(value: unknown, location: string): CanonicalArtifactWrapper<unknown> {
  const wrapper = readPlainRecord(value, location);
  assertExactKeys(wrapper, ["payload_sha256", "payload"], location);
  assertSha256(wrapper.payload_sha256, `${location}.payload_sha256`);
  if (sha256CanonicalJson(wrapper.payload) !== wrapper.payload_sha256) {
    throw integrity(`${location} payload digest 무결성이 다릅니다.`);
  }
  return { payload_sha256: wrapper.payload_sha256, payload: wrapper.payload };
}

function parseClaim(value: unknown): JudgeEvidencePrecommitClaim {
  const record = readPlainRecord(value, "Judge precommit claim");
  assertExactKeys(record, [
    "schema_version",
    "artifact_kind",
    "authority_root_id",
    "authority_store_id",
    "execution_pack_hash",
    "manifest_digest",
    "master_blinding_seed_commitment",
  ], "Judge precommit claim");
  if (
    record.schema_version !== "judge-evidence-precommit-claim-v2"
    || record.artifact_kind !== "JUDGE_EVIDENCE_PRECOMMIT_CLAIM"
  ) {
    throw integrity("Judge precommit claim version 또는 kind가 다릅니다.");
  }
  for (const [field, value] of [
    ["authority_root_id", record.authority_root_id],
    ["authority_store_id", record.authority_store_id],
    ["execution_pack_hash", record.execution_pack_hash],
    ["manifest_digest", record.manifest_digest],
    ["master_blinding_seed_commitment", record.master_blinding_seed_commitment],
  ] as const) {
    assertSha256(value, `claim.${field}`);
  }
  return record as unknown as JudgeEvidencePrecommitClaim;
}

async function assertExactBytes(
  filePath: string,
  expectedBytes: Buffer,
  location: string,
): Promise<void> {
  const parsed = await readPrivateCanonicalJson(filePath, location);
  const actual = Buffer.from(`${canonicalJsonStringify(parsed)}\n`, "utf8");
  if (!actual.equals(expectedBytes)) {
    throw integrity(`${location}의 기존 canonical bytes가 요청과 다릅니다.`);
  }
}

async function publishWriteOnce({
  filePath,
  bytes,
  location,
}: {
  readonly filePath: string;
  readonly bytes: Buffer;
  readonly location: string;
}): Promise<void> {
  const parent = dirname(filePath);
  await assertDirectoryNoSymlink(parent, `${location} parent`);
  const temporaryPath = join(parent, `.precommit-${process.pid}-${randomUUID()}.tmp`);
  let created = false;
  try {
    let handle;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle?.close();
    }
    await assertExactBytes(temporaryPath, bytes, `${location} temporary`);
    try {
      await link(temporaryPath, filePath);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw integrity(`${location}을 atomic hard-link로 공개할 수 없습니다.`, error);
      }
    }
  } finally {
    if (created) {
      try {
        await unlink(temporaryPath);
      } catch {
        // 최종 파일의 canonical 검증이 권위이며 임시 inode 정리는 best effort입니다.
      }
    }
  }
  await assertExactBytes(filePath, bytes, location);
}

function createBrandedAnchor({
  manifest,
  manifestDigest,
  provenance,
}: {
  readonly manifest: JudgeEvidencePrecommitManifest;
  readonly manifestDigest: string;
  readonly provenance: StoreProvenance;
}): AuthoritativeBlindingPrecommit {
  const validatedManifest = validateJudgeEvidencePrecommitManifest(manifest);
  if (sha256CanonicalJson(validatedManifest) !== manifestDigest) {
    throw integrity("권위 precommit manifest digest가 manifest와 다릅니다.");
  }
  const anchor = {
    schema_version: "authoritative-blinding-precommit-v2" as const,
    artifact_kind: "AUTHORITATIVE_BLINDING_PRECOMMIT" as const,
    authority_root_id: provenance.authorityRootId,
    authority_store_id: provenance.authorityStoreId,
    execution_pack_hash: validatedManifest.execution_pack_hash,
    manifest_digest: manifestDigest,
    master_blinding_seed_commitment:
      validatedManifest.master_blinding_seed_commitment,
    manifest: validatedManifest,
  } as AuthoritativeBlindingPrecommit;
  Object.defineProperty(anchor, AUTHORITATIVE_PRECOMMIT_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  BRANDED_PRECOMMITS.add(anchor);
  PRECOMMIT_PROVENANCE.set(anchor, provenance);
  return deepFreeze(anchor);
}

async function loadFromStore({
  store,
  executionPackHash,
}: {
  readonly store: AuthoritativeBlindingPrecommitStore;
  readonly executionPackHash: string;
}): Promise<AuthoritativeBlindingPrecommit> {
  const provenance = assertBrandedStore(store);
  assertSha256(executionPackHash, "executionPackHash");
  await assertStoreDirectories(provenance);
  const claim = parseClaim(parseWrapper(
    await readPrivateCanonicalJson(
      join(
        provenance.rootDirectory,
        "claims",
        `judge-evidence-precommit--${executionPackHash}.json`,
      ),
      "Judge precommit authority claim",
    ),
    "Judge precommit authority claim wrapper",
  ).payload);
  if (
    claim.authority_root_id !== provenance.authorityRootId
    || claim.authority_store_id !== provenance.authorityStoreId
    || claim.execution_pack_hash !== executionPackHash
  ) {
    throw integrity("Judge precommit authority claim의 root·store·execution binding이 다릅니다.");
  }
  const paths = createAuthoritativeBlindingPrecommitPaths({
    store,
    executionPackHash,
    manifestDigest: claim.manifest_digest,
  });
  const executionDirectory = await assertDirectoryNoSymlink(
    paths.executionDirectory,
    "Judge precommit execution directory",
  );
  assertContainedPath(
    provenance.storeDirectory,
    executionDirectory,
    "Judge precommit execution directory",
  );
  const recordWrapper = parseWrapper(
    await readPrivateCanonicalJson(paths.recordPath, "Judge precommit record"),
    "Judge precommit record wrapper",
  );
  let manifest: JudgeEvidencePrecommitManifest;
  try {
    manifest = validateJudgeEvidencePrecommitManifest(recordWrapper.payload);
  } catch (error) {
    throw integrity("저장된 Judge precommit manifest 계약이 유효하지 않습니다.", error);
  }
  if (
    recordWrapper.payload_sha256 !== claim.manifest_digest
    || sha256CanonicalJson(manifest) !== claim.manifest_digest
    || manifest.execution_pack_hash !== executionPackHash
    || manifest.master_blinding_seed_commitment
      !== claim.master_blinding_seed_commitment
  ) {
    throw integrity("Judge precommit authority claim·record·manifest binding 무결성이 다릅니다.");
  }
  return createBrandedAnchor({ manifest, manifestDigest: claim.manifest_digest, provenance });
}

async function persistInStore({
  store,
  manifest,
}: {
  readonly store: AuthoritativeBlindingPrecommitStore;
  readonly manifest: JudgeEvidencePrecommitManifest;
}): Promise<AuthoritativeBlindingPrecommit> {
  const provenance = assertBrandedStore(store);
  let validatedManifest: JudgeEvidencePrecommitManifest;
  try {
    validatedManifest = validateJudgeEvidencePrecommitManifest(manifest);
  } catch (error) {
    throw integrity("Judge precommit manifest 계약이 유효하지 않습니다.", error);
  }
  await assertStoreDirectories(provenance);
  const manifestDigest = sha256CanonicalJson(validatedManifest);
  const paths = createAuthoritativeBlindingPrecommitPaths({
    store,
    executionPackHash: validatedManifest.execution_pack_hash,
    manifestDigest,
  });
  const claim: JudgeEvidencePrecommitClaim = {
    schema_version: "judge-evidence-precommit-claim-v2",
    artifact_kind: "JUDGE_EVIDENCE_PRECOMMIT_CLAIM",
    authority_root_id: provenance.authorityRootId,
    authority_store_id: provenance.authorityStoreId,
    execution_pack_hash: validatedManifest.execution_pack_hash,
    manifest_digest: manifestDigest,
    master_blinding_seed_commitment:
      validatedManifest.master_blinding_seed_commitment,
  };
  await publishWriteOnce({
    filePath: paths.authorityClaimPath,
    bytes: canonicalWrapperBytes(claim),
    location: "Judge precommit authority claim",
  });
  await createDirectDirectoryNoSymlink({
    parentDirectory: provenance.storeDirectory,
    childDirectory: paths.executionDirectory,
    location: "Judge precommit execution directory",
  });
  await publishWriteOnce({
    filePath: paths.recordPath,
    bytes: canonicalWrapperBytes(validatedManifest),
    location: "Judge precommit record",
  });
  return loadFromStore({
    store,
    executionPackHash: validatedManifest.execution_pack_hash,
  });
}

/** 프로덕션은 코드 위치에 잠긴 단일 authority root와 primary store만 사용합니다. */
export async function persistAuthoritativeBlindingPrecommit({
  manifest,
}: {
  readonly manifest: JudgeEvidencePrecommitManifest;
}): Promise<AuthoritativeBlindingPrecommit> {
  return persistInStore({ store: await getProductionStore(), manifest });
}

export async function loadAuthoritativeBlindingPrecommit({
  executionPackHash,
}: {
  readonly executionPackHash: string;
}): Promise<AuthoritativeBlindingPrecommit> {
  return loadFromStore({
    store: await getExistingProductionStore(),
    executionPackHash,
  });
}

export async function loadAuthoritativeBlindingPrecommitFromReference({
  reference,
}: {
  readonly reference: AuthoritativeBlindingPrecommitReference;
}): Promise<AuthoritativeBlindingPrecommit> {
  const expected = createAuthoritativeBlindingPrecommitReference({
    executionPackHash: reference.execution_pack_hash,
    manifestDigest: reference.manifest_digest,
    manifestHash: reference.manifest_hash,
  });
  if (canonicalJsonStringify(reference) !== canonicalJsonStringify(expected)) {
    throw integrity("Judge precommit cold provenance reference가 production authority 좌표와 다릅니다.");
  }
  const anchor = await loadFromStore({
    store: await getExistingProductionStore(),
    executionPackHash: expected.execution_pack_hash,
  });
  if (
    anchor.manifest_digest !== expected.manifest_digest
    || anchor.manifest.manifest_hash !== expected.manifest_hash
    || anchor.authority_root_id !== expected.authority_root_id
    || anchor.authority_store_id !== expected.authority_store_id
  ) {
    throw integrity("Judge precommit cold provenance hash 또는 authority binding이 다릅니다.");
  }
  return anchor;
}

/** TEST_ONLY store에 결합된 reference만 strict cold-load하는 경계입니다. */
export async function loadAuthoritativeBlindingPrecommitFromReferenceForTest({
  reference,
  store,
}: {
  readonly reference: AuthoritativeBlindingPrecommitReference;
  readonly store: AuthoritativeBlindingPrecommitStore;
}): Promise<AuthoritativeBlindingPrecommit> {
  assertTestEnvironment();
  const expected = createAuthoritativeBlindingPrecommitReferenceForTest({
    store,
    executionPackHash: reference.execution_pack_hash,
    manifestDigest: reference.manifest_digest,
    manifestHash: reference.manifest_hash,
  });
  if (canonicalJsonStringify(reference) !== canonicalJsonStringify(expected)) {
    throw integrity("Judge precommit cold provenance reference가 test authority 좌표와 다릅니다.");
  }
  const anchor = await loadAuthoritativeBlindingPrecommitForTest({
    store,
    executionPackHash: expected.execution_pack_hash,
  });
  if (
    anchor.manifest_digest !== expected.manifest_digest
    || anchor.manifest.manifest_hash !== expected.manifest_hash
    || anchor.authority_root_id !== expected.authority_root_id
    || anchor.authority_store_id !== expected.authority_store_id
  ) {
    throw integrity("Judge precommit test cold provenance hash 또는 authority binding이 다릅니다.");
  }
  return anchor;
}

export async function persistAuthoritativeBlindingPrecommitForTest({
  store,
  manifest,
}: {
  readonly store: AuthoritativeBlindingPrecommitStore;
  readonly manifest: JudgeEvidencePrecommitManifest;
}): Promise<AuthoritativeBlindingPrecommit> {
  assertTestEnvironment();
  const provenance = assertBrandedStore(store);
  if (provenance.mode !== "TEST_ONLY") {
    throw integrity("test persistence API에는 TEST_ONLY store만 사용할 수 있습니다.");
  }
  return persistInStore({ store, manifest });
}

export async function loadAuthoritativeBlindingPrecommitForTest({
  store,
  executionPackHash,
}: {
  readonly store: AuthoritativeBlindingPrecommitStore;
  readonly executionPackHash: string;
}): Promise<AuthoritativeBlindingPrecommit> {
  assertTestEnvironment();
  const provenance = assertBrandedStore(store);
  if (provenance.mode !== "TEST_ONLY") {
    throw integrity("test load API에는 TEST_ONLY store만 사용할 수 있습니다.");
  }
  return loadFromStore({ store, executionPackHash });
}

function assertBrandedAnchor(anchor: unknown): {
  readonly anchor: AuthoritativeBlindingPrecommit;
  readonly manifest: JudgeEvidencePrecommitManifest;
  readonly provenance: StoreProvenance;
} {
  if (
    typeof anchor !== "object"
    || anchor === null
    || !BRANDED_PRECOMMITS.has(anchor)
    || (anchor as Partial<AuthoritativeBlindingPrecommit>)[AUTHORITATIVE_PRECOMMIT_BRAND]
      !== true
  ) {
    throw integrity(
      "authoritative precommit은 이 모듈의 persist/load API가 반환한 branded 객체여야 합니다.",
    );
  }
  const provenance = PRECOMMIT_PROVENANCE.get(anchor);
  if (provenance === undefined) {
    throw integrity("authoritative precommit의 module-private store provenance가 없습니다.");
  }
  const record = readPlainRecord(anchor, "authoritative precommit");
  assertExactKeys(record, [
    "schema_version",
    "artifact_kind",
    "authority_root_id",
    "authority_store_id",
    "execution_pack_hash",
    "manifest_digest",
    "master_blinding_seed_commitment",
    "manifest",
  ], "authoritative precommit");
  if (
    record.schema_version !== "authoritative-blinding-precommit-v2"
    || record.artifact_kind !== "AUTHORITATIVE_BLINDING_PRECOMMIT"
    || record.authority_root_id !== provenance.authorityRootId
    || record.authority_store_id !== provenance.authorityStoreId
  ) {
    throw integrity("authoritative precommit의 root·store provenance가 다릅니다.");
  }
  assertSha256(record.execution_pack_hash, "anchor.execution_pack_hash");
  assertSha256(record.manifest_digest, "anchor.manifest_digest");
  assertSha256(
    record.master_blinding_seed_commitment,
    "anchor.master_blinding_seed_commitment",
  );
  const manifest = validateJudgeEvidencePrecommitManifest(record.manifest);
  if (
    manifest.execution_pack_hash !== record.execution_pack_hash
    || sha256CanonicalJson(manifest) !== record.manifest_digest
    || manifest.master_blinding_seed_commitment
      !== record.master_blinding_seed_commitment
  ) {
    throw integrity("authoritative precommit과 manifest binding 무결성이 다릅니다.");
  }
  return {
    anchor: anchor as AuthoritativeBlindingPrecommit,
    manifest,
    provenance,
  };
}

export function assertAuthoritativeBlindingPrecommit({
  anchor,
  expectedExecutionPackHash,
  masterBlindingSeed,
}: {
  readonly anchor: unknown;
  readonly expectedExecutionPackHash: string;
  readonly masterBlindingSeed: string;
}): JudgeEvidencePrecommitManifest {
  const validated = assertBrandedAnchor(anchor);
  assertSha256(expectedExecutionPackHash, "expectedExecutionPackHash");
  const expectedCommitment = buildMasterBlindingSeedCommitment({
    executionPackHash: expectedExecutionPackHash,
    masterBlindingSeed,
  });
  if (
    validated.anchor.execution_pack_hash !== expectedExecutionPackHash
    || expectedCommitment !== validated.anchor.master_blinding_seed_commitment
  ) {
    throw integrity(
      "authoritative precommit과 private master seed의 commitment 무결성이 다릅니다.",
    );
  }
  return validated.manifest;
}

export function assertAuthoritativeBlindingPrecommitCaseBinding({
  anchor,
  expectedCaseId,
  expectedJudgeInputHash,
}: {
  readonly anchor: unknown;
  readonly expectedCaseId: string;
  readonly expectedJudgeInputHash: string;
}): AuthoritativeBlindingPrecommitCaseBinding {
  const validated = assertBrandedAnchor(anchor);
  assertSha256(expectedJudgeInputHash, "expectedJudgeInputHash");
  const caseBinding = validated.manifest.case_bindings.find(
    (binding) => binding.case_id === expectedCaseId,
  );
  if (
    caseBinding === undefined
    || caseBinding.judge_input_hash !== expectedJudgeInputHash
  ) {
    throw integrity(
      "Judge 호출 input은 사전에 권위 manifest에 확약된 case binding과 일치해야 합니다.",
    );
  }
  const precommitCaseBindingHash = sha256CanonicalJson({
    schema_version: "authoritative-prejudge-case-binding-v1",
    authority_root_id: validated.provenance.authorityRootId,
    authority_store_id: validated.provenance.authorityStoreId,
    execution_pack_hash: validated.anchor.execution_pack_hash,
    manifest_digest: validated.anchor.manifest_digest,
    manifest_hash: validated.manifest.manifest_hash,
    case_binding: caseBinding,
  });
  return Object.freeze({
    executionPackHash: validated.anchor.execution_pack_hash,
    authorityRootId: validated.provenance.authorityRootId,
    authorityStoreId: validated.provenance.authorityStoreId,
    precommitManifestDigest: validated.anchor.manifest_digest,
    precommitManifestHash: validated.manifest.manifest_hash,
    caseId: caseBinding.case_id,
    judgeInputHash: caseBinding.judge_input_hash,
    privateMappingHash: caseBinding.private_mapping_hash,
    precommitCaseBindingHash,
  });
}

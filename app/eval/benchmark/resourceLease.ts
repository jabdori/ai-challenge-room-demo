import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
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
  buildLockedChallengeBenchmarkBinding,
  type LockedChallengePack,
} from "../define/defineContracts";
import { BENCHMARK_CASES, BENCHMARK_POLICIES } from "../data/benchmark";
import type { PolicySection } from "../contracts/evaluationCase";
import {
  PolicyVectorStorePreparationError,
  type PolicyVectorStoreCleanupResult,
  type PolicyVectorStoreClientLike,
  type PolicyVectorStorePreparationEvent,
} from "../retrieval/policyVectorStore";
import { isOpenAITimeoutError } from "../openai/requestError";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  BENCHMARK_POLICY_CHUNKING_CONFIG,
  buildBenchmarkPolicyCorpusContract,
  prepareBenchmarkPolicyVectorStore,
  type PreparedBenchmarkPolicyVectorStore,
  type PrepareBenchmarkPolicyVectorStoreOptions,
} from "./policyVectorStore";
import { buildBenchmarkSchedule } from "./schedule";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OWNER_FILE_PATTERN
  = /^attempt-(\d{6})--owner-(\d{6})\.json$/;
const EVENT_FILE_PATTERN
  = /^attempt-(\d{6})--event-(\d{6})\.json$/;
const CLEANUP_FILE_PATTERN
  = /^attempt-(\d{6})--cleanup-(\d{6})\.json$/;
const CLEANUP_PROGRESS_FILE_PATTERN
  = /^attempt-(\d{6})--item-(\d{6})--try-(\d{6})\.json$/;
const RELEASE_FILE_PATTERN
  = /^attempt-(\d{6})--owner-(\d{6})\.json$/;
const PRODUCTION_ROOT = fileURLToPath(
  new URL("../../.runtime/authoritative-policy-resource-lease/", import.meta.url),
);
const REMOTE_READINESS_TIMEOUT_MS = 600_000;
const REMOTE_READINESS_POLL_INTERVAL_MS = 1_000;

type JsonRecord = Record<string, unknown>;

export class BenchmarkResourceLeaseIntegrityError extends Error {
  readonly code = "BENCHMARK_RESOURCE_LEASE_INTEGRITY" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BenchmarkResourceLeaseIntegrityError";
  }
}

export class BenchmarkResourceLeaseConflictError extends Error {
  readonly code = "BENCHMARK_RESOURCE_LEASE_LIVE_OWNER" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string) {
    super(message);
    this.name = "BenchmarkResourceLeaseConflictError";
  }
}

export class BenchmarkResourceLeaseCleanupIncompleteError extends Error {
  readonly code = "BENCHMARK_RESOURCE_LEASE_CLEANUP_INCOMPLETE" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string) {
    super(message);
    this.name = "BenchmarkResourceLeaseCleanupIncompleteError";
  }
}

export interface BenchmarkResourceLeaseContract {
  readonly schema_version: "benchmark-resource-lease-contract-v1";
  readonly locked_challenge_pack_sha256: string;
  readonly locked_challenge_contract_sha256: string;
  readonly schedule_id: string;
  readonly policy_corpus_sha256: string;
  readonly chunking_config_sha256: string;
  readonly resource_contract_sha256: string;
  readonly output_directory_sha256: string;
  readonly expected_file_count: number;
  readonly vector_store_name: string;
  readonly filename_prefix: string;
  readonly contract_sha256: string;
}

export interface BenchmarkResourceLeaseOwner {
  readonly hostname: string;
  readonly pid: number;
  readonly token: string;
}

interface OwnerRecord {
  readonly schema_version: "benchmark-resource-lease-owner-v1";
  readonly artifact_kind:
    | "BENCHMARK_RESOURCE_LEASE_OWNER_CLAIM"
    | "BENCHMARK_RESOURCE_LEASE_OWNER_ADOPTION";
  readonly contract_sha256: string;
  readonly attempt_number: number;
  readonly owner_sequence: number;
  readonly owner: BenchmarkResourceLeaseOwner;
  readonly previous_owner_record_sha256: string | null;
  readonly created_at: string;
}

interface ProgressRecord {
  readonly schema_version: "benchmark-resource-lease-progress-v1";
  readonly artifact_kind: "BENCHMARK_RESOURCE_LEASE_PROGRESS";
  readonly contract_sha256: string;
  readonly attempt_number: number;
  readonly owner_sequence: number;
  readonly event_sequence: number;
  readonly previous_event_sha256: string | null;
  readonly event: PolicyVectorStorePreparationEvent;
  readonly created_at: string;
}

interface PreparedRecord {
  readonly schema_version: "benchmark-resource-lease-prepared-v1";
  readonly artifact_kind: "BENCHMARK_RESOURCE_LEASE_PREPARED";
  readonly contract_sha256: string;
  readonly attempt_number: number;
  readonly progress_chain_sha256: string;
  readonly resource_manifest_sha256: string;
  readonly prepared_store: PreparedBenchmarkPolicyVectorStore;
  readonly created_at: string;
}

interface CleanupRecord {
  readonly schema_version: "benchmark-resource-lease-cleanup-v1";
  readonly artifact_kind: "BENCHMARK_RESOURCE_LEASE_CLEANUP_ATTEMPT";
  readonly contract_sha256: string;
  readonly attempt_number: number;
  readonly cleanup_sequence: number;
  readonly owner_sequence: number;
  readonly resource_manifest_sha256: string;
  readonly cleanup: PolicyVectorStoreCleanupResult;
  readonly cleanup_complete: boolean;
  readonly created_at: string;
}

export interface CleanupProgressRecord {
  readonly schema_version: "benchmark-resource-cleanup-progress-v1";
  readonly artifact_kind: "BENCHMARK_RESOURCE_CLEANUP_PROGRESS";
  readonly contract_sha256: string;
  readonly attempt_number: number;
  readonly owner_sequence: number;
  readonly resource_index: number;
  readonly resource_kind: "VECTOR_STORE" | "UPLOADED_FILE";
  readonly resource_id: string;
  readonly try_sequence: number;
  readonly delete_acknowledged: boolean;
  readonly error_code:
    | "DELETE_NOT_ACKNOWLEDGED"
    | "DELETE_REQUEST_FAILED"
    | null;
  readonly created_at: string;
}

interface TerminalRecord {
  readonly schema_version: "benchmark-resource-lease-terminal-v1";
  readonly artifact_kind: "BENCHMARK_RESOURCE_LEASE_TERMINAL_CLEANED";
  readonly contract_sha256: string;
  readonly attempt_number: number;
  readonly resource_manifest_sha256: string;
  readonly cleanup_record_sha256: string;
  readonly cleanup_receipt_payload_sha256: string | null;
  readonly cleanup_receipt_path_sha256: string | null;
  readonly recorded_pack_payload_sha256: string | null;
  readonly recorded_pack_path_sha256: string | null;
  readonly deletion_acknowledgements: number;
  readonly terminal_status: "CLEANED";
  readonly created_at: string;
}

interface CompletionBindingRecord {
  readonly schema_version: "benchmark-resource-lease-completion-v1";
  readonly artifact_kind: "BENCHMARK_RESOURCE_LEASE_COMPLETION_BINDING";
  readonly contract_sha256: string;
  readonly attempt_number: number;
  readonly terminal_record_sha256: string;
  readonly cleanup_receipt_path: string;
  readonly cleanup_receipt_path_sha256: string;
  readonly cleanup_receipt_payload_sha256: string;
  readonly recorded_pack_path: string;
  readonly recorded_pack_path_sha256: string;
  readonly recorded_pack_payload_sha256: string;
  readonly completion_status: "ARTIFACTS_VERIFIED";
  readonly created_at: string;
}

interface ReleaseRecord {
  readonly schema_version: "benchmark-resource-lease-release-v1";
  readonly artifact_kind: "BENCHMARK_RESOURCE_LEASE_OWNER_RELEASED";
  readonly contract_sha256: string;
  readonly attempt_number: number;
  readonly owner_sequence: number;
  readonly owner_record_sha256: string;
  readonly reason: "CLEANUP_INCOMPLETE";
  readonly created_at: string;
}

interface WrappedRecord<T> {
  readonly payload_sha256: string;
  readonly payload: T;
}

interface LeaseDirectories {
  readonly root: string;
  readonly contract: string;
  readonly owners: string;
  readonly progress: string;
  readonly prepared: string;
  readonly cleanup: string;
  readonly cleanupProgress: string;
  readonly terminal: string;
  readonly completion: string;
  readonly releases: string;
  readonly contractRecord: string;
}

interface AttemptContext {
  readonly attemptNumber: number;
  readonly ownerSequence: number;
  readonly ownerRecordSha256: string;
  readonly adoptedFromReleasedOwner: boolean;
  resources: {
    vectorStoreId: string | null;
    uploadedFileIds: string[];
  };
  preparedStore: PreparedBenchmarkPolicyVectorStore | null;
}

export interface BenchmarkResourceLeaseRemoteClient
  extends PolicyVectorStoreClientLike {
  vectorStores: PolicyVectorStoreClientLike["vectorStores"] & {
    retrieve: NonNullable<
      PolicyVectorStoreClientLike["vectorStores"]["retrieve"]
    >;
  };
  files: PolicyVectorStoreClientLike["files"] & {
    retrieve: NonNullable<PolicyVectorStoreClientLike["files"]["retrieve"]>;
  };
}

type PrepareResource = (
  client: PolicyVectorStoreClientLike,
  policies: readonly PolicySection[],
  options: PrepareBenchmarkPolicyVectorStoreOptions,
) => Promise<PreparedBenchmarkPolicyVectorStore>;

type CleanupResource = (
  client: PolicyVectorStoreClientLike,
  resources: {
    readonly vectorStoreId: string | null;
    readonly uploadedFileIds: readonly string[];
  },
) => Promise<PolicyVectorStoreCleanupResult>;

export interface BenchmarkResourceLeaseControllerOptions {
  readonly rootDirectory: string;
  readonly contract: BenchmarkResourceLeaseContract;
  readonly createRoot?: boolean;
  readonly policies?: readonly PolicySection[];
  readonly owner?: BenchmarkResourceLeaseOwner;
  readonly now?: () => Date;
  readonly readinessNow?: () => number;
  readonly readinessSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly isOwnerAlive?: (
    owner: BenchmarkResourceLeaseOwner,
  ) => boolean | Promise<boolean>;
  readonly prepareResource?: PrepareResource;
  readonly cleanupResource?: CleanupResource;
  readonly afterCleanupProgressPersist?: (
    record: Readonly<CleanupProgressRecord>,
  ) => void | Promise<void>;
}

export interface AcquireBenchmarkResourceLeaseOptions {
  readonly client: BenchmarkResourceLeaseRemoteClient;
  readonly signal?: AbortSignal;
}

export interface BenchmarkResourceLeaseController {
  acquire(
    options: AcquireBenchmarkResourceLeaseOptions,
  ): Promise<PreparedBenchmarkPolicyVectorStore>;
  finalizeCleanup(
    cleanup: PolicyVectorStoreCleanupResult,
    artifacts?: BenchmarkResourceLeaseFinalizationArtifacts,
  ): Promise<void>;
  mode(): "ACTIVE_REMOTE" | "TERMINAL_LOCAL_RECOVERY" | null;
  terminalCleanup(): PolicyVectorStoreCleanupResult | null;
  cleanup(options: {
    readonly client: BenchmarkResourceLeaseRemoteClient;
  }): Promise<PolicyVectorStoreCleanupResult>;
  terminalAuthority(): Promise<BenchmarkResourceLeaseTerminalAuthority>;
  completedArtifacts(): Promise<
    BenchmarkResourceLeaseFinalizationArtifacts | null
  >;
}

export interface BenchmarkResourceLeaseTerminalAuthority {
  readonly schema_version:
    "benchmark-resource-lease-terminal-authority-v1";
  readonly contract: BenchmarkResourceLeaseContract;
  readonly prepared_store: PreparedBenchmarkPolicyVectorStore;
  readonly cleanup: PolicyVectorStoreCleanupResult;
  readonly terminal_record_sha256: string;
}

const AUTHORITATIVE_TERMINAL_RESOURCE_LEASES = new WeakSet<object>();

export function assertAuthoritativeBenchmarkResourceLeaseTerminal(
  value: unknown,
): asserts value is BenchmarkResourceLeaseTerminalAuthority {
  if (
    typeof value !== "object"
    || value === null
    || !AUTHORITATIVE_TERMINAL_RESOURCE_LEASES.has(value)
    || !Object.isFrozen(value)
  ) {
    throw integrity(
      "resource lease terminal authority는 durable lease controller가 source-rebuild한 동일 branded 객체여야 합니다.",
    );
  }
}

export interface BenchmarkResourceLeaseFinalizationArtifacts {
  readonly cleanupReceipt: {
    readonly path: string;
    readonly payloadSha256: string;
  };
  readonly recordedPack: {
    readonly path: string;
    readonly payloadSha256: string;
  } | null;
}

function integrity(
  message: string,
  cause?: unknown,
): BenchmarkResourceLeaseIntegrityError {
  return new BenchmarkResourceLeaseIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  location: string,
): JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw integrity(`${location}은 plain JSON 객체여야 합니다.`);
  }
  const record = value as JsonRecord;
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.join(",") !== wanted.join(",")) {
    throw integrity(`${location}의 exact key 계약이 다릅니다.`);
  }
  return record;
}

function assertSha256(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw integrity(`${location}은 lowercase SHA-256이어야 합니다.`);
  }
}

function assertPositiveInteger(
  value: unknown,
  location: string,
): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw integrity(`${location}은 1 이상의 정수여야 합니다.`);
  }
}

function assertNonEmptyString(
  value: unknown,
  location: string,
): asserts value is string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || /\p{Cc}/u.test(value)
  ) {
    throw integrity(`${location}은 제어 문자가 없는 문자열이어야 합니다.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as JsonRecord)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function wrapBytes<T>(payload: T): Buffer {
  return Buffer.from(`${canonicalJsonStringify({
    payload_sha256: sha256CanonicalJson(payload),
    payload,
  } satisfies WrappedRecord<T>)}\n`, "utf8");
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

async function assertSecureDirectory(
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

async function ensureDirectDirectory(
  parent: string,
  child: string,
  location: string,
): Promise<void> {
  if (resolve(dirname(child)) !== resolve(parent)) {
    throw integrity(`${location}은 검증된 parent의 직접 하위여야 합니다.`);
  }
  await assertSecureDirectory(parent, `${location} parent`);
  try {
    await mkdir(child, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) {
      throw integrity(`${location}을 만들 수 없습니다.`, error);
    }
  }
  await assertSecureDirectory(child, location);
  assertContained(parent, child, location);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function createWrappedRecord<T>({
  path,
  payload,
  location,
}: {
  readonly path: string;
  readonly payload: T;
  readonly location: string;
}): Promise<boolean> {
  const parent = dirname(path);
  await assertSecureDirectory(parent, `${location} parent`);
  const temporaryPath = join(
    parent,
    `.lease.tmp-${process.pid}-${randomUUID()}`,
  );
  let created = false;
  try {
    const temporary = await open(temporaryPath, "wx", 0o600);
    created = true;
    try {
      await temporary.writeFile(wrapBytes(payload));
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (hasCode(error, "EEXIST")) {
        return false;
      }
      throw integrity(`${location}을 원자적으로 공개할 수 없습니다.`, error);
    }
    try {
      await unlink(temporaryPath);
    } catch (error) {
      // 동시 안전 reader가 같은 inode의 임시 sibling provenance를 검증하고
      // 먼저 unlink했으면 최종 target 공개는 이미 완료된 상태입니다.
      if (!hasCode(error, "ENOENT")) throw error;
    }
    created = false;
    await syncDirectory(parent);
    return true;
  } finally {
    if (created) {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) {
          throw integrity(`${location} 임시 파일을 정리할 수 없습니다.`, error);
        }
      }
    }
  }
}

async function readWrappedRecord<T>(
  path: string,
  location: string,
): Promise<{ payload: T; payloadSha256: string }> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.nlink === 2) {
      const parent = dirname(path);
      const siblings = await readdir(parent, { withFileTypes: true });
      const matchingTemporarySiblings: string[] = [];
      for (const sibling of siblings) {
        if (!sibling.name.startsWith(".lease.tmp-")) continue;
        const siblingPath = join(parent, sibling.name);
        const siblingStat = await lstat(siblingPath);
        if (
          sibling.isFile()
          && !sibling.isSymbolicLink()
          && siblingStat.isFile()
          && !siblingStat.isSymbolicLink()
          && (siblingStat.mode & 0o777) === 0o600
          && siblingStat.nlink === 2
          && siblingStat.dev === stat.dev
          && siblingStat.ino === stat.ino
        ) {
          matchingTemporarySiblings.push(siblingPath);
        }
      }
      if (matchingTemporarySiblings.length !== 1) {
        throw integrity(
          `${location} nlink=2를 안전한 publish temp sibling으로 증명할 수 없습니다.`,
        );
      }
      await handle.close();
      handle = undefined;
      await unlink(matchingTemporarySiblings[0]);
      await syncDirectory(parent);
      return readWrappedRecord<T>(path, location);
    }
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== 1
    ) {
      throw integrity(
        `${location}은 link count 1의 regular 0600 file이어야 합니다.`,
      );
    }
    const bytes = await handle.readFile();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw integrity(`${location} JSON을 해석할 수 없습니다.`, error);
    }
    const wrapper = exactKeys(
      parsed,
      ["payload_sha256", "payload"],
      `${location} wrapper`,
    );
    assertSha256(wrapper.payload_sha256, `${location}.payload_sha256`);
    if (sha256CanonicalJson(wrapper.payload) !== wrapper.payload_sha256) {
      throw integrity(`${location} wrapper hash가 다릅니다.`);
    }
    if (!bytes.equals(wrapBytes(wrapper.payload))) {
      throw integrity(`${location} bytes가 canonical 형식과 다릅니다.`);
    }
    return {
      payload: wrapper.payload as T,
      payloadSha256: wrapper.payload_sha256,
    };
  } catch (error) {
    if (error instanceof BenchmarkResourceLeaseIntegrityError) throw error;
    throw integrity(`${location}을 안전하게 읽을 수 없습니다.`, error);
  } finally {
    await handle?.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw integrity("lease 경로 존재 여부를 확인할 수 없습니다.", error);
  }
}

function attemptPart(value: number): string {
  return String(value).padStart(6, "0");
}

function ownerPath(
  directories: LeaseDirectories,
  attempt: number,
  sequence: number,
): string {
  return join(
    directories.owners,
    `attempt-${attemptPart(attempt)}--owner-${attemptPart(sequence)}.json`,
  );
}

function eventPath(
  directories: LeaseDirectories,
  attempt: number,
  sequence: number,
): string {
  return join(
    directories.progress,
    `attempt-${attemptPart(attempt)}--event-${attemptPart(sequence)}.json`,
  );
}

function preparedPath(
  directories: LeaseDirectories,
  attempt: number,
): string {
  return join(
    directories.prepared,
    `attempt-${attemptPart(attempt)}.json`,
  );
}

function cleanupPath(
  directories: LeaseDirectories,
  attempt: number,
  sequence: number,
): string {
  return join(
    directories.cleanup,
    `attempt-${attemptPart(attempt)}--cleanup-${attemptPart(sequence)}.json`,
  );
}

function cleanupProgressPath(
  directories: LeaseDirectories,
  attempt: number,
  resourceIndex: number,
  trySequence: number,
): string {
  return join(
    directories.cleanupProgress,
    [
      `attempt-${attemptPart(attempt)}`,
      `item-${attemptPart(resourceIndex)}`,
      `try-${attemptPart(trySequence)}.json`,
    ].join("--"),
  );
}

function terminalPath(
  directories: LeaseDirectories,
  attempt: number,
): string {
  return join(
    directories.terminal,
    `attempt-${attemptPart(attempt)}.json`,
  );
}

function completionPath(
  directories: LeaseDirectories,
  attempt: number,
): string {
  return join(
    directories.completion,
    `attempt-${attemptPart(attempt)}.json`,
  );
}

function releasePath(
  directories: LeaseDirectories,
  attempt: number,
  ownerSequence: number,
): string {
  return join(
    directories.releases,
    `attempt-${attemptPart(attempt)}--owner-${attemptPart(ownerSequence)}.json`,
  );
}

function contractPayload(
  input: Omit<BenchmarkResourceLeaseContract, "contract_sha256">,
): BenchmarkResourceLeaseContract {
  return deepFreeze({
    ...input,
    contract_sha256: sha256CanonicalJson(input),
  });
}

export function buildBenchmarkResourceLeaseContract({
  lockedChallengePack,
  outputDirectory,
}: {
  readonly lockedChallengePack: LockedChallengePack;
  readonly outputDirectory: string;
}): BenchmarkResourceLeaseContract {
  const binding = buildLockedChallengeBenchmarkBinding(lockedChallengePack);
  const schedule = buildBenchmarkSchedule(BENCHMARK_CASES, ["A", "B", "C"]);
  const policy = buildBenchmarkPolicyCorpusContract(BENCHMARK_POLICIES);
  return contractPayload({
    schema_version: "benchmark-resource-lease-contract-v1",
    locked_challenge_pack_sha256: binding.locked_challenge_pack_hash,
    locked_challenge_contract_sha256: binding.approved_contract_hash,
    schedule_id: schedule.schedule_id,
    policy_corpus_sha256: policy.policy_corpus_sha256,
    chunking_config_sha256: policy.chunking_config_sha256,
    resource_contract_sha256: policy.resource_contract_sha256,
    output_directory_sha256: sha256CanonicalJson(resolve(outputDirectory)),
    expected_file_count: 32,
    vector_store_name: "ai-challenge-hidden-benchmark-policies",
    filename_prefix: "hidden-benchmark-policy",
  });
}

export function buildScopedPolicyResourceLeaseContract({
  authorityPackSha256,
  authorityContractSha256,
  scheduleId,
  policies,
  outputDirectory,
  vectorStoreName,
  filenamePrefix,
}: {
  readonly authorityPackSha256: string;
  readonly authorityContractSha256: string;
  readonly scheduleId: string;
  readonly policies: readonly PolicySection[];
  readonly outputDirectory: string;
  readonly vectorStoreName: string;
  readonly filenamePrefix: string;
}): BenchmarkResourceLeaseContract {
  for (const [value, label] of [
    [authorityPackSha256, "authorityPackSha256"],
    [authorityContractSha256, "authorityContractSha256"],
    [scheduleId, "scheduleId"],
  ] as const) {
    assertSha256(value, label);
  }
  assertNonEmptyString(vectorStoreName, "vectorStoreName");
  assertNonEmptyString(filenamePrefix, "filenamePrefix");
  if (policies.length < 1 || policies.length > 64) {
    throw integrity("scoped policy resource lease에는 1..64개 정책 section이 필요합니다.");
  }
  const policy = buildBenchmarkPolicyCorpusContract(policies);
  return contractPayload({
    schema_version: "benchmark-resource-lease-contract-v1",
    locked_challenge_pack_sha256: authorityPackSha256,
    locked_challenge_contract_sha256: authorityContractSha256,
    schedule_id: scheduleId,
    policy_corpus_sha256: policy.policy_corpus_sha256,
    chunking_config_sha256: policy.chunking_config_sha256,
    resource_contract_sha256: policy.resource_contract_sha256,
    output_directory_sha256: sha256CanonicalJson(resolve(outputDirectory)),
    expected_file_count: policies.length,
    vector_store_name: vectorStoreName,
    filename_prefix: filenamePrefix,
  });
}

/** 테스트가 실제 production authority를 위조하지 않고 저장 경계를 검증하기 위한 계약입니다. */
export function buildBenchmarkResourceLeaseContractForTest({
  discriminator = "resource-lease-test",
  outputDirectory,
}: {
  readonly discriminator?: string;
  readonly outputDirectory?: string;
} = {}): BenchmarkResourceLeaseContract {
  if (process.env.NODE_ENV !== "test") {
    throw integrity("test resource lease 계약은 test 환경에서만 만들 수 있습니다.");
  }
  assertNonEmptyString(discriminator, "test discriminator");
  const digest = (label: string) => sha256CanonicalJson({
    discriminator,
    label,
  });
  return contractPayload({
    schema_version: "benchmark-resource-lease-contract-v1",
    locked_challenge_pack_sha256: digest("pack"),
    locked_challenge_contract_sha256: digest("contract"),
    schedule_id: digest("schedule"),
    policy_corpus_sha256: digest("corpus"),
    chunking_config_sha256: sha256CanonicalJson(
      BENCHMARK_POLICY_CHUNKING_CONFIG,
    ),
    resource_contract_sha256: digest("resource"),
    output_directory_sha256: outputDirectory === undefined
      ? digest("output")
      : sha256CanonicalJson(resolve(outputDirectory)),
    expected_file_count: 32,
    vector_store_name: "ai-challenge-hidden-benchmark-policies",
    filename_prefix: "hidden-benchmark-policy",
  });
}

function validateContract(
  value: BenchmarkResourceLeaseContract,
): BenchmarkResourceLeaseContract {
  const record = exactKeys(value, [
    "schema_version",
    "locked_challenge_pack_sha256",
    "locked_challenge_contract_sha256",
    "schedule_id",
    "policy_corpus_sha256",
    "chunking_config_sha256",
    "resource_contract_sha256",
    "output_directory_sha256",
    "expected_file_count",
    "vector_store_name",
    "filename_prefix",
    "contract_sha256",
  ], "resource lease contract");
  if (
    record.schema_version !== "benchmark-resource-lease-contract-v1"
    || !Number.isInteger(record.expected_file_count)
    || (record.expected_file_count as number) < 1
    || (record.expected_file_count as number) > 64
    || typeof record.vector_store_name !== "string"
    || record.vector_store_name.trim().length === 0
    || typeof record.filename_prefix !== "string"
    || record.filename_prefix.trim().length === 0
  ) {
    throw integrity("resource lease contract의 고정 계약이 다릅니다.");
  }
  for (const field of [
    "locked_challenge_pack_sha256",
    "locked_challenge_contract_sha256",
    "schedule_id",
    "policy_corpus_sha256",
    "chunking_config_sha256",
    "resource_contract_sha256",
    "output_directory_sha256",
    "contract_sha256",
  ] as const) {
    assertSha256(record[field], `resource lease contract.${field}`);
  }
  const { contract_sha256: claimed, ...payload } = record;
  if (sha256CanonicalJson(payload) !== claimed) {
    throw integrity("resource lease contract hash가 다릅니다.");
  }
  return deepFreeze(structuredClone(value));
}

function leaseDirectories(
  rootDirectory: string,
  contract: BenchmarkResourceLeaseContract,
): LeaseDirectories {
  const contractDirectory = join(rootDirectory, contract.contract_sha256);
  return {
    root: rootDirectory,
    contract: contractDirectory,
    owners: join(contractDirectory, "owners"),
    progress: join(contractDirectory, "progress"),
    prepared: join(contractDirectory, "prepared"),
    cleanup: join(contractDirectory, "cleanup"),
    cleanupProgress: join(contractDirectory, "cleanup-progress"),
    terminal: join(contractDirectory, "terminal"),
    completion: join(contractDirectory, "completion"),
    releases: join(contractDirectory, "releases"),
    contractRecord: join(contractDirectory, "contract.json"),
  };
}

async function initializeDirectories(
  directories: LeaseDirectories,
  contract: BenchmarkResourceLeaseContract,
  createRoot: boolean,
): Promise<void> {
  if (createRoot) {
    const parent = dirname(resolve(directories.root));
    await assertSecureDirectory(parent, "resource lease production parent");
    try {
      await mkdir(directories.root, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw integrity("resource lease production root를 만들 수 없습니다.", error);
      }
    }
  }
  await assertSecureDirectory(directories.root, "resource lease root");
  await ensureDirectDirectory(
    directories.root,
    directories.contract,
    "resource lease contract directory",
  );
  for (const [path, label] of [
    [directories.owners, "owners"],
    [directories.progress, "progress"],
    [directories.prepared, "prepared"],
    [directories.cleanup, "cleanup"],
    [directories.cleanupProgress, "cleanup progress"],
    [directories.terminal, "terminal"],
    [directories.completion, "completion"],
    [directories.releases, "releases"],
  ] as const) {
    await ensureDirectDirectory(
      directories.contract,
      path,
      `resource lease ${label} directory`,
    );
  }
  const created = await createWrappedRecord({
    path: directories.contractRecord,
    payload: contract,
    location: "resource lease contract record",
  });
  if (!created) {
    const existing = await readWrappedRecord<BenchmarkResourceLeaseContract>(
      directories.contractRecord,
      "resource lease contract record",
    );
    const validated = validateContract(existing.payload);
    if (canonicalJsonStringify(validated) !== canonicalJsonStringify(contract)) {
      throw integrity("기존 resource lease contract binding이 다릅니다.");
    }
  }
}

async function listMatchingFiles(
  directory: string,
  pattern: RegExp,
  location: string,
): Promise<Array<{ name: string; matches: RegExpMatchArray }>> {
  await assertSecureDirectory(directory, location);
  const entries = await readdir(directory, { withFileTypes: true });
  const found: Array<{ name: string; matches: RegExpMatchArray }> = [];
  for (const entry of entries) {
    const matches = entry.name.match(pattern);
    if (!matches) {
      if (entry.name.startsWith(".lease.tmp-")) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw integrity(`${location} 임시 항목이 regular file이 아닙니다.`);
        }
        continue;
      }
      throw integrity(`${location}에 허용되지 않은 항목이 있습니다.`);
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw integrity(`${location} 항목은 regular file이어야 합니다.`);
    }
    found.push({ name: entry.name, matches });
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

function validateOwner(owner: unknown, location: string): BenchmarkResourceLeaseOwner {
  const record = exactKeys(owner, ["hostname", "pid", "token"], location);
  assertNonEmptyString(record.hostname, `${location}.hostname`);
  assertPositiveInteger(record.pid, `${location}.pid`);
  assertNonEmptyString(record.token, `${location}.token`);
  return {
    hostname: record.hostname,
    pid: record.pid,
    token: record.token,
  };
}

function parseOwnerRecord(
  value: unknown,
  contractHash: string,
): OwnerRecord {
  const record = exactKeys(value, [
    "schema_version",
    "artifact_kind",
    "contract_sha256",
    "attempt_number",
    "owner_sequence",
    "owner",
    "previous_owner_record_sha256",
    "created_at",
  ], "resource lease owner record");
  if (
    record.schema_version !== "benchmark-resource-lease-owner-v1"
    || (
      record.artifact_kind !== "BENCHMARK_RESOURCE_LEASE_OWNER_CLAIM"
      && record.artifact_kind !== "BENCHMARK_RESOURCE_LEASE_OWNER_ADOPTION"
    )
    || record.contract_sha256 !== contractHash
  ) {
    throw integrity("resource lease owner record 계약이 다릅니다.");
  }
  assertPositiveInteger(record.attempt_number, "owner.attempt_number");
  assertPositiveInteger(record.owner_sequence, "owner.owner_sequence");
  const previous = record.previous_owner_record_sha256;
  if (previous !== null) assertSha256(previous, "owner.previous_owner_record_sha256");
  assertNonEmptyString(record.created_at, "owner.created_at");
  return deepFreeze({
    schema_version: "benchmark-resource-lease-owner-v1",
    artifact_kind: record.artifact_kind,
    contract_sha256: contractHash,
    attempt_number: record.attempt_number,
    owner_sequence: record.owner_sequence,
    owner: validateOwner(record.owner, "owner.owner"),
    previous_owner_record_sha256: previous,
    created_at: record.created_at,
  });
}

async function loadOwners(
  directories: LeaseDirectories,
  contractHash: string,
): Promise<Array<{ record: OwnerRecord; hash: string }>> {
  const files = await listMatchingFiles(
    directories.owners,
    OWNER_FILE_PATTERN,
    "resource lease owners directory",
  );
  const owners: Array<{ record: OwnerRecord; hash: string }> = [];
  for (const file of files) {
    const attempt = Number(file.matches[1]);
    const sequence = Number(file.matches[2]);
    const wrapped = await readWrappedRecord<OwnerRecord>(
      join(directories.owners, file.name),
      "resource lease owner record",
    );
    const record = parseOwnerRecord(wrapped.payload, contractHash);
    if (
      record.attempt_number !== attempt
      || record.owner_sequence !== sequence
    ) {
      throw integrity("resource lease owner filename binding이 다릅니다.");
    }
    owners.push({ record, hash: wrapped.payloadSha256 });
  }
  const grouped = new Map<
    number,
    Array<{ record: OwnerRecord; hash: string }>
  >();
  for (const owner of owners) {
    const group = grouped.get(owner.record.attempt_number) ?? [];
    group.push(owner);
    grouped.set(owner.record.attempt_number, group);
  }
  const attempts = [...grouped.keys()].sort((a, b) => a - b);
  attempts.forEach((attempt, index) => {
    if (attempt !== index + 1) {
      throw integrity("resource lease attempt sequence가 연속적이지 않습니다.");
    }
    const group = grouped.get(attempt)!;
    group.forEach((owner, ownerIndex) => {
      if (
        owner.record.owner_sequence !== ownerIndex + 1
        || (
          ownerIndex === 0
            ? owner.record.artifact_kind
              !== "BENCHMARK_RESOURCE_LEASE_OWNER_CLAIM"
              || owner.record.previous_owner_record_sha256 !== null
            : owner.record.artifact_kind
              !== "BENCHMARK_RESOURCE_LEASE_OWNER_ADOPTION"
              || owner.record.previous_owner_record_sha256
                !== group[ownerIndex - 1].hash
        )
      ) {
        throw integrity("resource lease owner chain이 연속적이지 않습니다.");
      }
    });
  });
  return owners;
}

function defaultOwnerAlive(owner: BenchmarkResourceLeaseOwner): boolean {
  if (owner.hostname !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return !(hasCode(error, "ESRCH"));
  }
}

function sameOwner(
  left: BenchmarkResourceLeaseOwner,
  right: BenchmarkResourceLeaseOwner,
): boolean {
  return left.hostname === right.hostname
    && left.pid === right.pid
    && left.token === right.token;
}

function resourceManifestSha256(resources: {
  readonly vectorStoreId: string | null;
  readonly uploadedFileIds: readonly string[];
}): string {
  return sha256CanonicalJson({
    vector_store_id: resources.vectorStoreId,
    uploaded_file_ids: [...resources.uploadedFileIds],
  });
}

function parseProgressEvent(
  value: unknown,
): PolicyVectorStorePreparationEvent {
  const record = value as Partial<PolicyVectorStorePreparationEvent>;
  if (record?.kind === "VECTOR_STORE_CREATED") {
    exactKeys(value, ["kind", "vectorStoreId"], "vector store create event");
    assertNonEmptyString(record.vectorStoreId, "event.vectorStoreId");
    return {
      kind: "VECTOR_STORE_CREATED",
      vectorStoreId: record.vectorStoreId,
    };
  }
  if (record?.kind === "UPLOADED_FILE_CREATED") {
    exactKeys(
      value,
      ["kind", "vectorStoreId", "file"],
      "uploaded file create event",
    );
    assertNonEmptyString(record.vectorStoreId, "event.vectorStoreId");
    const file = exactKeys(record.file, [
      "uploadedFileId",
      "filename",
      "sourceId",
      "sectionId",
      "factId",
      "payloadSha256",
    ], "event.file");
    for (const field of [
      "uploadedFileId",
      "filename",
      "sourceId",
      "sectionId",
      "factId",
    ] as const) {
      assertNonEmptyString(file[field], `event.file.${field}`);
    }
    assertSha256(file.payloadSha256, "event.file.payloadSha256");
    const uploadedFileId = file.uploadedFileId as string;
    const filename = file.filename as string;
    const sourceId = file.sourceId as string;
    const sectionId = file.sectionId as string;
    const factId = file.factId as string;
    return {
      kind: "UPLOADED_FILE_CREATED",
      vectorStoreId: record.vectorStoreId,
      file: {
        uploadedFileId,
        filename,
        sourceId,
        sectionId,
        factId,
        payloadSha256: file.payloadSha256,
      },
    };
  }
  if (record?.kind === "VECTOR_STORE_FILE_ATTACHED") {
    exactKeys(value, [
      "kind",
      "vectorStoreId",
      "uploadedFileId",
      "vectorStoreFileId",
      "status",
    ], "vector store attachment event");
    for (const field of [
      "vectorStoreId",
      "uploadedFileId",
      "vectorStoreFileId",
    ] as const) {
      assertNonEmptyString(record[field], `event.${field}`);
    }
    if (
      record.status !== "in_progress"
      && record.status !== "completed"
      && record.status !== "cancelled"
      && record.status !== "failed"
    ) {
      throw integrity("attachment event status가 유효하지 않습니다.");
    }
    const vectorStoreId = record.vectorStoreId as string;
    const uploadedFileId = record.uploadedFileId as string;
    const vectorStoreFileId = record.vectorStoreFileId as string;
    return {
      kind: "VECTOR_STORE_FILE_ATTACHED",
      vectorStoreId,
      uploadedFileId,
      vectorStoreFileId,
      status: record.status,
    };
  }
  throw integrity("알 수 없는 resource lease progress event입니다.");
}

function parseProgressRecord(
  value: unknown,
  contractHash: string,
): ProgressRecord {
  const record = exactKeys(value, [
    "schema_version",
    "artifact_kind",
    "contract_sha256",
    "attempt_number",
    "owner_sequence",
    "event_sequence",
    "previous_event_sha256",
    "event",
    "created_at",
  ], "resource lease progress record");
  if (
    record.schema_version !== "benchmark-resource-lease-progress-v1"
    || record.artifact_kind !== "BENCHMARK_RESOURCE_LEASE_PROGRESS"
    || record.contract_sha256 !== contractHash
  ) {
    throw integrity("resource lease progress record 계약이 다릅니다.");
  }
  assertPositiveInteger(record.attempt_number, "progress.attempt_number");
  assertPositiveInteger(record.owner_sequence, "progress.owner_sequence");
  assertPositiveInteger(record.event_sequence, "progress.event_sequence");
  if (record.previous_event_sha256 !== null) {
    assertSha256(
      record.previous_event_sha256,
      "progress.previous_event_sha256",
    );
  }
  assertNonEmptyString(record.created_at, "progress.created_at");
  return deepFreeze({
    schema_version: "benchmark-resource-lease-progress-v1",
    artifact_kind: "BENCHMARK_RESOURCE_LEASE_PROGRESS",
    contract_sha256: contractHash,
    attempt_number: record.attempt_number,
    owner_sequence: record.owner_sequence,
    event_sequence: record.event_sequence,
    previous_event_sha256: record.previous_event_sha256,
    event: parseProgressEvent(record.event),
    created_at: record.created_at,
  });
}

async function loadProgress(
  directories: LeaseDirectories,
  contractHash: string,
  attempt: number,
): Promise<Array<{ record: ProgressRecord; hash: string }>> {
  const files = (await listMatchingFiles(
    directories.progress,
    EVENT_FILE_PATTERN,
    "resource lease progress directory",
  )).filter((file) => Number(file.matches[1]) === attempt);
  const progress: Array<{ record: ProgressRecord; hash: string }> = [];
  for (const file of files) {
    const sequence = Number(file.matches[2]);
    const wrapped = await readWrappedRecord<ProgressRecord>(
      join(directories.progress, file.name),
      "resource lease progress record",
    );
    const record = parseProgressRecord(wrapped.payload, contractHash);
    if (
      record.attempt_number !== attempt
      || record.event_sequence !== sequence
      || sequence !== progress.length + 1
      || record.previous_event_sha256
        !== (progress.at(-1)?.hash ?? null)
    ) {
      throw integrity("resource lease progress chain이 연속적이지 않습니다.");
    }
    progress.push({ record, hash: wrapped.payloadSha256 });
  }
  return progress;
}

function resourcesFromProgress(
  progress: readonly { record: ProgressRecord }[],
): {
  vectorStoreId: string | null;
  uploadedFileIds: string[];
} {
  let vectorStoreId: string | null = null;
  const uploadedFileIds: string[] = [];
  const attached = new Set<string>();
  progress.forEach(({ record }, index) => {
    const event = record.event;
    if (index === 0) {
      if (event.kind !== "VECTOR_STORE_CREATED") {
        throw integrity("첫 resource progress event는 Vector Store 생성이어야 합니다.");
      }
      vectorStoreId = event.vectorStoreId;
      return;
    }
    if (vectorStoreId === null || event.vectorStoreId !== vectorStoreId) {
      throw integrity("resource progress의 Vector Store binding이 다릅니다.");
    }
    if (event.kind === "UPLOADED_FILE_CREATED") {
      if (uploadedFileIds.includes(event.file.uploadedFileId)) {
        throw integrity("resource progress에 중복 uploaded file ID가 있습니다.");
      }
      uploadedFileIds.push(event.file.uploadedFileId);
      return;
    }
    if (
      event.kind !== "VECTOR_STORE_FILE_ATTACHED"
      || !uploadedFileIds.includes(event.uploadedFileId)
      || attached.has(event.uploadedFileId)
    ) {
      throw integrity("resource progress attachment binding이 다릅니다.");
    }
    attached.add(event.uploadedFileId);
  });
  return { vectorStoreId, uploadedFileIds };
}

function filesFromProgress(
  progress: readonly { record: ProgressRecord }[],
) {
  return progress.flatMap(({ record }) => (
    record.event.kind === "UPLOADED_FILE_CREATED"
      ? [record.event.file]
      : []
  ));
}

function assertPreparedStore(
  prepared: PreparedBenchmarkPolicyVectorStore,
  progress: readonly { record: ProgressRecord; hash: string }[],
  contract: BenchmarkResourceLeaseContract,
): void {
  const resources = resourcesFromProgress(progress);
  const files = filesFromProgress(progress);
  // 원격 만료 정책은 검색 결과의 의미적 자원 identity가 아니라 유출 자원을
  // 제한하는 운영 안전장치입니다. 따라서 resourceIdentity hash에서는 제외하되,
  // 재개 시 로컬 prepared metadata가 생성기의 잠긴 설정과 같은지는 검증합니다.
  const expectedVectorStoreExpiration = {
    anchor: "last_active_at",
    days: 1,
  };
  const expectedFileExpiration = {
    anchor: "created_at",
    seconds: 86_400,
  };
  if (
    progress.length !== 1 + (2 * contract.expected_file_count)
    || resources.vectorStoreId !== prepared.vectorStoreId
    || resources.uploadedFileIds.length !== contract.expected_file_count
    || prepared.uploadedFileIds.length !== contract.expected_file_count
    || prepared.files.length !== contract.expected_file_count
    || prepared.ingestionStatus !== "completed"
    || canonicalJsonStringify(prepared.vectorStoreExpiresAfter)
      !== canonicalJsonStringify(expectedVectorStoreExpiration)
    || canonicalJsonStringify(prepared.fileExpiresAfter)
      !== canonicalJsonStringify(expectedFileExpiration)
    || resources.uploadedFileIds.some(
      (id, index) => id !== prepared.uploadedFileIds[index],
    )
    || files.some(
      (file, index) =>
        canonicalJsonStringify(file)
        !== canonicalJsonStringify(prepared.files[index]),
    )
    || prepared.resourceIdentity.policy_corpus_sha256
      !== contract.policy_corpus_sha256
    || prepared.resourceIdentity.chunking_config_sha256
      !== contract.chunking_config_sha256
    || prepared.resourceIdentity.resource_contract_sha256
      !== contract.resource_contract_sha256
    || prepared.resourceIdentity.manifest_sha256 !== prepared.manifestSha256
    || sha256CanonicalJson(prepared.resourceIdentity)
      !== prepared.resourceIdentitySha256
  ) {
    throw integrity("prepared resource lease와 잠긴 progress manifest가 다릅니다.");
  }
}

function preparedResourceManifestSha256(
  prepared: PreparedBenchmarkPolicyVectorStore,
): string {
  return resourceManifestSha256({
    vectorStoreId: prepared.vectorStoreId,
    uploadedFileIds: prepared.uploadedFileIds,
  });
}

async function validateRemotePreparedStore(
  client: BenchmarkResourceLeaseRemoteClient,
  prepared: PreparedBenchmarkPolicyVectorStore,
  contract: BenchmarkResourceLeaseContract,
  {
    signal,
    now,
    sleep,
  }: {
    readonly signal?: AbortSignal;
    readonly now: () => number;
    readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<void> {
  const deadlineAtMs = now() + REMOTE_READINESS_TIMEOUT_MS;
  const remainingMs = (): number => {
    const remaining = Math.floor(deadlineAtMs - now());
    if (remaining <= 0) {
      throw integrity("원격 정책 자원 readiness 검증 시간을 초과했습니다.");
    }
    return remaining;
  };
  const requestOptions = () => ({
    timeout: Math.min(30_000, remainingMs()),
    maxRetries: 0,
    ...(signal ? { signal } : {}),
  });
  const pause = async (): Promise<void> => {
    signal?.throwIfAborted();
    await sleep(
      Math.min(REMOTE_READINESS_POLL_INTERVAL_MS, remainingMs()),
      signal,
    );
    signal?.throwIfAborted();
    remainingMs();
  };
  const retryableReadError = (error: unknown): boolean => {
    const status = typeof error === "object" && error !== null && "status" in error
      && typeof error.status === "number"
      ? error.status
      : null;
    if (status !== null) {
      return status === 408 || status === 409 || status === 429 || status >= 500;
    }
    if (isOpenAITimeoutError(error)) return true;
    if (!(error instanceof Error)) return false;
    const code = "code" in error && typeof error.code === "string"
      ? error.code
      : null;
    return error.constructor.name === "APIConnectionError"
      || code === "ECONNRESET"
      || code === "ECONNREFUSED"
      || code === "EPIPE"
      || code === "ENETUNREACH";
  };

  try {
    for (;;) {
      signal?.throwIfAborted();
      let vectorStore;
      try {
        vectorStore = await client.vectorStores.retrieve(
          prepared.vectorStoreId,
          requestOptions(),
        );
      } catch (error) {
        if (!retryableReadError(error)) throw error;
        await pause();
        continue;
      }
      const counts = vectorStore.file_counts;
      if (
        vectorStore.id !== prepared.vectorStoreId
        || vectorStore.name !== contract.vector_store_name
        || counts === undefined
        || vectorStore.status === "expired"
        || counts.failed !== 0
        || counts.cancelled !== 0
        || counts.total > contract.expected_file_count
        || counts.completed > contract.expected_file_count
        || counts.in_progress > contract.expected_file_count
      ) {
        throw integrity("원격 Vector Store readiness 계약이 다릅니다.");
      }
      if (
        vectorStore.status === "completed"
        && counts.total === contract.expected_file_count
        && counts.completed === contract.expected_file_count
        && counts.in_progress === 0
      ) {
        break;
      }
      if (
        vectorStore.status !== "in_progress"
        || counts.total < counts.completed + counts.in_progress
      ) {
        throw integrity("원격 Vector Store readiness 계약이 다릅니다.");
      }
      await pause();
    }

    for (const [fileIndex, file] of prepared.files.entries()) {
      for (;;) {
        signal?.throwIfAborted();
        let uploaded;
        let attached;
        try {
          [uploaded, attached] = await Promise.all([
            client.files.retrieve(file.uploadedFileId, requestOptions()),
            client.vectorStores.files.retrieve(file.uploadedFileId, {
              vector_store_id: prepared.vectorStoreId,
            }, requestOptions()),
          ]);
        } catch (error) {
          if (!retryableReadError(error)) throw error;
          await pause();
          continue;
        }
        const safeFilePosition = fileIndex + 1;
        if (
          uploaded.id !== file.uploadedFileId
          || uploaded.filename !== file.filename
          || uploaded.purpose !== "assistants"
        ) {
          throw integrity(
            `원격 정책 원본 file ${safeFilePosition}의 식별자·파일명·purpose 계약이 다릅니다.`,
          );
        }
        // Files API status는 deprecated이며, 검색 readiness의 권위는
        // vector_store.file.status=completed입니다. 명시적 error만 거부합니다.
        if (uploaded.status === "error") {
          throw integrity(
            `원격 정책 원본 file ${safeFilePosition}이 error 상태입니다.`,
          );
        }
        if (
          attached.id !== file.uploadedFileId
          || attached.vector_store_id !== prepared.vectorStoreId
        ) {
          throw integrity(
            `원격 정책 vector file ${safeFilePosition}의 식별자 계약이 다릅니다.`,
          );
        }
        if (
          canonicalJsonStringify(attached.attributes ?? null)
            !== canonicalJsonStringify({
              source_id: file.sourceId,
              section_id: file.sectionId,
              fact_id: file.factId,
            })
        ) {
          throw integrity(
            `원격 정책 vector file ${safeFilePosition}의 attributes 계약이 다릅니다.`,
          );
        }
        if (
          canonicalJsonStringify(attached.chunking_strategy ?? null)
            !== canonicalJsonStringify(BENCHMARK_POLICY_CHUNKING_CONFIG)
        ) {
          throw integrity(
            `원격 정책 vector file ${safeFilePosition}의 chunking_strategy 계약이 다릅니다.`,
          );
        }
        if (attached.status === "completed") break;
        if (attached.status !== "in_progress") {
          throw integrity(
            `원격 정책 vector file ${safeFilePosition}의 readiness 상태가 다릅니다.`,
          );
        }
        await pause();
      }
    }
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof BenchmarkResourceLeaseIntegrityError) throw error;
    // 공급자 오류 원문에는 원격 ID가 포함될 수 있으므로 외부 경계로 전달하지 않습니다.
    throw integrity("원격 정책 자원 존재·readiness를 검증하지 못했습니다.");
  }
}

function normalizeCleanup(
  cleanup: PolicyVectorStoreCleanupResult,
  resources: {
    readonly vectorStoreId: string | null;
    readonly uploadedFileIds: readonly string[];
  },
): { cleanup: PolicyVectorStoreCleanupResult; complete: boolean; count: number } {
  const expectedFiles = [...new Set(resources.uploadedFileIds)];
  if (expectedFiles.length !== resources.uploadedFileIds.length) {
    throw integrity("resource lease cleanup 대상에 중복 file ID가 있습니다.");
  }
  if (
    cleanup.vectorStore.id !== resources.vectorStoreId
    || cleanup.uploadedFiles.length !== expectedFiles.length
    || cleanup.uploadedFiles.some(
      (item, index) => item.id !== expectedFiles[index],
    )
  ) {
    throw integrity("resource lease cleanup 응답의 자원 binding이 다릅니다.");
  }
  const vectorComplete = resources.vectorStoreId === null
    || (
      cleanup.vectorStore.attempted === true
      && cleanup.vectorStore.deleted === true
    );
  const filesComplete = cleanup.uploadedFiles.every(
    (item) => item.attempted === true && item.deleted === true,
  );
  return {
    cleanup: structuredClone(cleanup),
    complete: vectorComplete && filesComplete,
    count: (resources.vectorStoreId === null ? 0 : 1) + expectedFiles.length,
  };
}

function parsePreparedRecord(
  value: unknown,
  contractHash: string,
  attempt: number,
): PreparedRecord {
  const record = exactKeys(value, [
    "schema_version",
    "artifact_kind",
    "contract_sha256",
    "attempt_number",
    "progress_chain_sha256",
    "resource_manifest_sha256",
    "prepared_store",
    "created_at",
  ], "resource lease prepared record");
  if (
    record.schema_version !== "benchmark-resource-lease-prepared-v1"
    || record.artifact_kind !== "BENCHMARK_RESOURCE_LEASE_PREPARED"
    || record.contract_sha256 !== contractHash
    || record.attempt_number !== attempt
  ) {
    throw integrity("resource lease prepared record binding이 다릅니다.");
  }
  assertSha256(record.progress_chain_sha256, "prepared.progress_chain_sha256");
  assertSha256(record.resource_manifest_sha256, "prepared.resource_manifest_sha256");
  assertNonEmptyString(record.created_at, "prepared.created_at");
  return deepFreeze({
    schema_version: "benchmark-resource-lease-prepared-v1",
    artifact_kind: "BENCHMARK_RESOURCE_LEASE_PREPARED",
    contract_sha256: contractHash,
    attempt_number: attempt,
    progress_chain_sha256: record.progress_chain_sha256,
    resource_manifest_sha256: record.resource_manifest_sha256,
    prepared_store: record.prepared_store as PreparedBenchmarkPolicyVectorStore,
    created_at: record.created_at,
  });
}

function assertTerminalRecord(
  value: unknown,
  contractHash: string,
  attempt: number,
): TerminalRecord {
  const record = exactKeys(value, [
    "schema_version",
    "artifact_kind",
    "contract_sha256",
    "attempt_number",
    "resource_manifest_sha256",
    "cleanup_record_sha256",
    "cleanup_receipt_payload_sha256",
    "cleanup_receipt_path_sha256",
    "recorded_pack_payload_sha256",
    "recorded_pack_path_sha256",
    "deletion_acknowledgements",
    "terminal_status",
    "created_at",
  ], "resource lease terminal record");
  if (
    record.schema_version !== "benchmark-resource-lease-terminal-v1"
    || record.artifact_kind !== "BENCHMARK_RESOURCE_LEASE_TERMINAL_CLEANED"
    || record.contract_sha256 !== contractHash
    || record.attempt_number !== attempt
    || record.terminal_status !== "CLEANED"
  ) {
    throw integrity("resource lease terminal record binding이 다릅니다.");
  }
  assertSha256(record.resource_manifest_sha256, "terminal.resource_manifest_sha256");
  assertSha256(record.cleanup_record_sha256, "terminal.cleanup_record_sha256");
  for (const [payloadField, pathField] of [
    [
      "cleanup_receipt_payload_sha256",
      "cleanup_receipt_path_sha256",
    ],
    [
      "recorded_pack_payload_sha256",
      "recorded_pack_path_sha256",
    ],
  ] as const) {
    const payloadHash = record[payloadField];
    const pathHash = record[pathField];
    if ((payloadHash === null) !== (pathHash === null)) {
      throw integrity(`terminal ${payloadField}·${pathField} 쌍이 다릅니다.`);
    }
    if (payloadHash !== null) assertSha256(payloadHash, `terminal.${payloadField}`);
    if (pathHash !== null) assertSha256(pathHash, `terminal.${pathField}`);
  }
  if (
    !Number.isInteger(record.deletion_acknowledgements)
    || (record.deletion_acknowledgements as number) < 0
  ) {
    throw integrity("terminal deletion acknowledgement 수가 유효하지 않습니다.");
  }
  assertNonEmptyString(record.created_at, "terminal.created_at");
  return record as unknown as TerminalRecord;
}

function parseCompletionBindingRecord(
  value: unknown,
  contractHash: string,
  attempt: number,
): CompletionBindingRecord {
  const record = exactKeys(value, [
    "schema_version",
    "artifact_kind",
    "contract_sha256",
    "attempt_number",
    "terminal_record_sha256",
    "cleanup_receipt_path",
    "cleanup_receipt_path_sha256",
    "cleanup_receipt_payload_sha256",
    "recorded_pack_path",
    "recorded_pack_path_sha256",
    "recorded_pack_payload_sha256",
    "completion_status",
    "created_at",
  ], "resource lease completion binding");
  if (
    record.schema_version !== "benchmark-resource-lease-completion-v1"
    || record.artifact_kind !== "BENCHMARK_RESOURCE_LEASE_COMPLETION_BINDING"
    || record.contract_sha256 !== contractHash
    || record.attempt_number !== attempt
    || record.completion_status !== "ARTIFACTS_VERIFIED"
  ) {
    throw integrity("resource lease completion binding 계약이 다릅니다.");
  }
  for (const field of [
    "terminal_record_sha256",
    "cleanup_receipt_path_sha256",
    "cleanup_receipt_payload_sha256",
    "recorded_pack_path_sha256",
    "recorded_pack_payload_sha256",
  ] as const) {
    assertSha256(record[field], `completion.${field}`);
  }
  assertNonEmptyString(record.cleanup_receipt_path, "completion.cleanup_receipt_path");
  assertNonEmptyString(record.recorded_pack_path, "completion.recorded_pack_path");
  assertNonEmptyString(record.created_at, "completion.created_at");
  if (
    sha256CanonicalJson(resolve(record.cleanup_receipt_path))
      !== record.cleanup_receipt_path_sha256
    || sha256CanonicalJson(resolve(record.recorded_pack_path))
      !== record.recorded_pack_path_sha256
  ) {
    throw integrity("completion artifact path hash가 다릅니다.");
  }
  const terminalRecordSha256 = record.terminal_record_sha256 as string;
  const cleanupReceiptPathSha256
    = record.cleanup_receipt_path_sha256 as string;
  const cleanupReceiptPayloadSha256
    = record.cleanup_receipt_payload_sha256 as string;
  const recordedPackPathSha256
    = record.recorded_pack_path_sha256 as string;
  const recordedPackPayloadSha256
    = record.recorded_pack_payload_sha256 as string;
  return deepFreeze({
    schema_version: "benchmark-resource-lease-completion-v1",
    artifact_kind: "BENCHMARK_RESOURCE_LEASE_COMPLETION_BINDING",
    contract_sha256: contractHash,
    attempt_number: attempt,
    terminal_record_sha256: terminalRecordSha256,
    cleanup_receipt_path: record.cleanup_receipt_path,
    cleanup_receipt_path_sha256: cleanupReceiptPathSha256,
    cleanup_receipt_payload_sha256: cleanupReceiptPayloadSha256,
    recorded_pack_path: record.recorded_pack_path,
    recorded_pack_path_sha256: recordedPackPathSha256,
    recorded_pack_payload_sha256: recordedPackPayloadSha256,
    completion_status: "ARTIFACTS_VERIFIED",
    created_at: record.created_at,
  });
}

async function assertSecureCanonicalArtifact({
  path,
  expectedPayloadSha256,
  expectedArtifactKind,
  location,
}: {
  readonly path: string;
  readonly expectedPayloadSha256: string;
  readonly expectedArtifactKind:
    | "CLEANUP_RECEIPT"
    | "RECORDED_BENCHMARK_PACK";
  readonly location: string;
}): Promise<void> {
  assertNonEmptyString(path, `${location} path`);
  assertSha256(expectedPayloadSha256, `${location} payload hash`);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== 1
    ) {
      throw integrity(`${location}은 link count 1의 regular 0600 file이어야 합니다.`);
    }
    if (await realpath(path) !== resolve(path)) {
      throw integrity(`${location} 또는 ancestor에 symlink가 포함돼 있습니다.`);
    }
    const bytes = await handle.readFile();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw integrity(`${location} JSON을 해석할 수 없습니다.`, error);
    }
    const isWrapper = (
      typeof parsed === "object"
      && parsed !== null
      && !Array.isArray(parsed)
      && Object.keys(parsed).sort().join(",") === "payload,payload_sha256"
    );
    if (isWrapper) {
      const wrapper = exactKeys(
        parsed,
        ["payload_sha256", "payload"],
        `${location} wrapper`,
      );
      assertSha256(wrapper.payload_sha256, `${location}.payload_sha256`);
      if (
        wrapper.payload_sha256 !== expectedPayloadSha256
        || sha256CanonicalJson(wrapper.payload) !== expectedPayloadSha256
        || !bytes.equals(wrapBytes(wrapper.payload))
      ) {
        throw integrity(`${location} wrapper content hash가 다릅니다.`);
      }
      if (
        typeof wrapper.payload !== "object"
        || wrapper.payload === null
        || Array.isArray(wrapper.payload)
        || (wrapper.payload as JsonRecord).artifact_kind
          !== expectedArtifactKind
      ) {
        throw integrity(`${location} artifact_kind가 다릅니다.`);
      }
      return;
    }
    if (
      sha256CanonicalJson(parsed) !== expectedPayloadSha256
      || !bytes.equals(
        Buffer.from(`${canonicalJsonStringify(parsed)}\n`, "utf8"),
      )
    ) {
      throw integrity(`${location} canonical content hash가 다릅니다.`);
    }
    const payload = parsed as JsonRecord;
    if (
      typeof payload !== "object"
      || payload === null
      || payload.artifact_kind !== expectedArtifactKind
    ) {
      throw integrity(`${location} artifact_kind가 다릅니다.`);
    }
  } catch (error) {
    if (error instanceof BenchmarkResourceLeaseIntegrityError) throw error;
    throw integrity(`${location}을 안전하게 검증할 수 없습니다.`, error);
  } finally {
    await handle?.close();
  }
}

function parseCleanupRecord(
  value: unknown,
  contractHash: string,
  attempt: number,
): CleanupRecord {
  const record = exactKeys(value, [
    "schema_version",
    "artifact_kind",
    "contract_sha256",
    "attempt_number",
    "cleanup_sequence",
    "owner_sequence",
    "resource_manifest_sha256",
    "cleanup",
    "cleanup_complete",
    "created_at",
  ], "resource lease cleanup record");
  if (
    record.schema_version !== "benchmark-resource-lease-cleanup-v1"
    || record.artifact_kind !== "BENCHMARK_RESOURCE_LEASE_CLEANUP_ATTEMPT"
    || record.contract_sha256 !== contractHash
    || record.attempt_number !== attempt
  ) {
    throw integrity("resource lease cleanup record binding이 다릅니다.");
  }
  assertPositiveInteger(record.cleanup_sequence, "cleanup.cleanup_sequence");
  assertPositiveInteger(record.owner_sequence, "cleanup.owner_sequence");
  assertSha256(record.resource_manifest_sha256, "cleanup.resource_manifest_sha256");
  if (typeof record.cleanup_complete !== "boolean") {
    throw integrity("cleanup.cleanup_complete는 boolean이어야 합니다.");
  }
  assertNonEmptyString(record.created_at, "cleanup.created_at");
  return deepFreeze({
    schema_version: "benchmark-resource-lease-cleanup-v1",
    artifact_kind: "BENCHMARK_RESOURCE_LEASE_CLEANUP_ATTEMPT",
    contract_sha256: contractHash,
    attempt_number: attempt,
    cleanup_sequence: record.cleanup_sequence,
    owner_sequence: record.owner_sequence,
    resource_manifest_sha256: record.resource_manifest_sha256,
    cleanup: record.cleanup as PolicyVectorStoreCleanupResult,
    cleanup_complete: record.cleanup_complete,
    created_at: record.created_at,
  });
}

function parseCleanupProgressRecord(
  value: unknown,
  contractHash: string,
  attempt: number,
): CleanupProgressRecord {
  const record = exactKeys(value, [
    "schema_version",
    "artifact_kind",
    "contract_sha256",
    "attempt_number",
    "owner_sequence",
    "resource_index",
    "resource_kind",
    "resource_id",
    "try_sequence",
    "delete_acknowledged",
    "error_code",
    "created_at",
  ], "resource cleanup progress record");
  if (
    record.schema_version !== "benchmark-resource-cleanup-progress-v1"
    || record.artifact_kind !== "BENCHMARK_RESOURCE_CLEANUP_PROGRESS"
    || record.contract_sha256 !== contractHash
    || record.attempt_number !== attempt
  ) {
    throw integrity("resource cleanup progress record binding이 다릅니다.");
  }
  assertPositiveInteger(record.owner_sequence, "cleanup progress.owner_sequence");
  assertPositiveInteger(record.resource_index, "cleanup progress.resource_index");
  assertPositiveInteger(record.try_sequence, "cleanup progress.try_sequence");
  assertNonEmptyString(record.resource_id, "cleanup progress.resource_id");
  if (
    record.resource_kind !== "VECTOR_STORE"
    && record.resource_kind !== "UPLOADED_FILE"
  ) {
    throw integrity("cleanup progress resource_kind가 다릅니다.");
  }
  if (typeof record.delete_acknowledged !== "boolean") {
    throw integrity("cleanup progress delete_acknowledged가 boolean이 아닙니다.");
  }
  if (
    record.error_code !== null
    && record.error_code !== "DELETE_NOT_ACKNOWLEDGED"
    && record.error_code !== "DELETE_REQUEST_FAILED"
  ) {
    throw integrity("cleanup progress error_code가 다릅니다.");
  }
  if (
    record.delete_acknowledged
      ? record.error_code !== null
      : record.error_code === null
  ) {
    throw integrity("cleanup progress acknowledgement·error 조합이 다릅니다.");
  }
  assertNonEmptyString(record.created_at, "cleanup progress.created_at");
  return deepFreeze({
    schema_version: "benchmark-resource-cleanup-progress-v1",
    artifact_kind: "BENCHMARK_RESOURCE_CLEANUP_PROGRESS",
    contract_sha256: contractHash,
    attempt_number: attempt,
    owner_sequence: record.owner_sequence,
    resource_index: record.resource_index,
    resource_kind: record.resource_kind,
    resource_id: record.resource_id,
    try_sequence: record.try_sequence,
    delete_acknowledged: record.delete_acknowledged,
    error_code: record.error_code,
    created_at: record.created_at,
  });
}

export function createBenchmarkResourceLeaseController({
  rootDirectory,
  contract: inputContract,
  createRoot = false,
  policies: inputPolicies = BENCHMARK_POLICIES,
  owner = {
    hostname: hostname(),
    pid: process.pid,
    token: randomUUID(),
  },
  now = () => new Date(),
  readinessNow = () => Date.now(),
  readinessSleep = (milliseconds, signal) => new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      reject(signal?.reason);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  }),
  isOwnerAlive = defaultOwnerAlive,
  prepareResource = prepareBenchmarkPolicyVectorStore as PrepareResource,
  cleanupResource,
  afterCleanupProgressPersist,
}: BenchmarkResourceLeaseControllerOptions): BenchmarkResourceLeaseController {
  const contract = validateContract(inputContract);
  const policies = deepFreeze(structuredClone(inputPolicies));
  const policyContract = buildBenchmarkPolicyCorpusContract(policies);
  if (
    prepareResource === prepareBenchmarkPolicyVectorStore
    && (
      policies.length !== contract.expected_file_count
      || policyContract.policy_corpus_sha256 !== contract.policy_corpus_sha256
      || policyContract.chunking_config_sha256
        !== contract.chunking_config_sha256
      || policyContract.resource_contract_sha256
        !== contract.resource_contract_sha256
    )
  ) {
    throw integrity(
      "resource lease runtime policies가 잠긴 corpus/chunking/resource contract와 다릅니다.",
    );
  }
  const runtimeOwner = validateOwner(owner, "resource lease runtime owner");
  const directories = leaseDirectories(resolve(rootDirectory), contract);
  let initialized = false;
  let current: AttemptContext | null = null;
  let leaseMode: "ACTIVE_REMOTE" | "TERMINAL_LOCAL_RECOVERY" | null = null;
  let recoveredTerminalCleanup: PolicyVectorStoreCleanupResult | null = null;

  async function initialize(): Promise<void> {
    if (initialized) return;
    await initializeDirectories(directories, contract, createRoot);
    initialized = true;
  }

  async function loadTerminalRecord(attempt: number): Promise<{
    record: TerminalRecord;
    hash: string;
  } | null> {
    const path = terminalPath(directories, attempt);
    if (!(await pathExists(path))) return null;
    const wrapped = await readWrappedRecord<TerminalRecord>(
      path,
      "resource lease terminal record",
    );
    return {
      record: assertTerminalRecord(
        wrapped.payload,
        contract.contract_sha256,
        attempt,
      ),
      hash: wrapped.payloadSha256,
    };
  }

  async function hasTerminal(attempt: number): Promise<boolean> {
    return (await loadTerminalRecord(attempt)) !== null;
  }

  function assertCompletionArtifactOutputBinding({
    cleanupReceiptPath,
    recordedPackPath,
  }: {
    readonly cleanupReceiptPath: string;
    readonly recordedPackPath: string;
  }): void {
    const cleanupOutputDirectory = resolve(dirname(cleanupReceiptPath));
    const recordedPackOutputDirectory = resolve(
      dirname(dirname(recordedPackPath)),
    );
    if (
      cleanupOutputDirectory !== recordedPackOutputDirectory
      || sha256CanonicalJson(cleanupOutputDirectory)
        !== contract.output_directory_sha256
    ) {
      throw integrity(
        "completion artifacts는 잠긴 Recorded Benchmark output root에 있어야 합니다.",
      );
    }
  }

  async function validateCompletionBindingIfPresent(
    attempt: number,
    terminalHash: string,
  ): Promise<CompletionBindingRecord | null> {
    const path = completionPath(directories, attempt);
    if (!(await pathExists(path))) return null;
    const wrapped = await readWrappedRecord<CompletionBindingRecord>(
      path,
      "resource lease completion binding",
    );
    const completion = parseCompletionBindingRecord(
      wrapped.payload,
      contract.contract_sha256,
      attempt,
    );
    if (completion.terminal_record_sha256 !== terminalHash) {
      throw integrity("completion binding의 terminal hash가 다릅니다.");
    }
    assertCompletionArtifactOutputBinding({
      cleanupReceiptPath: completion.cleanup_receipt_path,
      recordedPackPath: completion.recorded_pack_path,
    });
    await assertSecureCanonicalArtifact({
      path: completion.cleanup_receipt_path,
      expectedPayloadSha256: completion.cleanup_receipt_payload_sha256,
      expectedArtifactKind: "CLEANUP_RECEIPT",
      location: "completion cleanup receipt",
    });
    await assertSecureCanonicalArtifact({
      path: completion.recorded_pack_path,
      expectedPayloadSha256: completion.recorded_pack_payload_sha256,
      expectedArtifactKind: "RECORDED_BENCHMARK_PACK",
      location: "completion Recorded Benchmark Pack",
    });
    return completion;
  }

  async function persistCompletionBinding({
    context,
    terminalHash,
    artifacts,
  }: {
    readonly context: AttemptContext;
    readonly terminalHash: string;
    readonly artifacts: BenchmarkResourceLeaseFinalizationArtifacts;
  }): Promise<void> {
    if (artifacts.recordedPack === null) {
      throw integrity(
        "최종 completion binding에는 실제 Recorded Benchmark Pack이 필요합니다.",
      );
    }
    assertCompletionArtifactOutputBinding({
      cleanupReceiptPath: artifacts.cleanupReceipt.path,
      recordedPackPath: artifacts.recordedPack.path,
    });
    await assertSecureCanonicalArtifact({
      path: artifacts.cleanupReceipt.path,
      expectedPayloadSha256: artifacts.cleanupReceipt.payloadSha256,
      expectedArtifactKind: "CLEANUP_RECEIPT",
      location: "completion cleanup receipt",
    });
    await assertSecureCanonicalArtifact({
      path: artifacts.recordedPack.path,
      expectedPayloadSha256: artifacts.recordedPack.payloadSha256,
      expectedArtifactKind: "RECORDED_BENCHMARK_PACK",
      location: "completion Recorded Benchmark Pack",
    });
    const path = completionPath(directories, context.attemptNumber);
    if (await pathExists(path)) {
      const existing = await readWrappedRecord<CompletionBindingRecord>(
        path,
        "resource lease completion binding",
      );
      const parsed = parseCompletionBindingRecord(
        existing.payload,
        contract.contract_sha256,
        context.attemptNumber,
      );
      if (
        parsed.terminal_record_sha256 !== terminalHash
        || parsed.cleanup_receipt_path
          !== resolve(artifacts.cleanupReceipt.path)
        || parsed.cleanup_receipt_payload_sha256
          !== artifacts.cleanupReceipt.payloadSha256
        || parsed.recorded_pack_path !== resolve(artifacts.recordedPack.path)
        || parsed.recorded_pack_payload_sha256
          !== artifacts.recordedPack.payloadSha256
      ) {
        throw integrity("기존 completion binding이 현재 artifact와 다릅니다.");
      }
      await validateCompletionBindingIfPresent(
        context.attemptNumber,
        terminalHash,
      );
      return;
    }
    const record: CompletionBindingRecord = {
      schema_version: "benchmark-resource-lease-completion-v1",
      artifact_kind: "BENCHMARK_RESOURCE_LEASE_COMPLETION_BINDING",
      contract_sha256: contract.contract_sha256,
      attempt_number: context.attemptNumber,
      terminal_record_sha256: terminalHash,
      cleanup_receipt_path: resolve(artifacts.cleanupReceipt.path),
      cleanup_receipt_path_sha256: sha256CanonicalJson(
        resolve(artifacts.cleanupReceipt.path),
      ),
      cleanup_receipt_payload_sha256:
        artifacts.cleanupReceipt.payloadSha256,
      recorded_pack_path: resolve(artifacts.recordedPack.path),
      recorded_pack_path_sha256: sha256CanonicalJson(
        resolve(artifacts.recordedPack.path),
      ),
      recorded_pack_payload_sha256:
        artifacts.recordedPack.payloadSha256,
      completion_status: "ARTIFACTS_VERIFIED",
      created_at: now().toISOString(),
    };
    const created = await createWrappedRecord({
      path,
      payload: record,
      location: "resource lease completion binding",
    });
    if (!created) {
      const existing = await readWrappedRecord<CompletionBindingRecord>(
        path,
        "resource lease completion binding",
      );
      const parsed = parseCompletionBindingRecord(
        existing.payload,
        contract.contract_sha256,
        context.attemptNumber,
      );
      if (
        parsed.terminal_record_sha256 !== terminalHash
        || parsed.cleanup_receipt_path !== record.cleanup_receipt_path
        || parsed.cleanup_receipt_payload_sha256
          !== record.cleanup_receipt_payload_sha256
        || parsed.recorded_pack_path !== record.recorded_pack_path
        || parsed.recorded_pack_payload_sha256
          !== record.recorded_pack_payload_sha256
      ) {
        throw integrity("기존 completion binding이 현재 artifact와 다릅니다.");
      }
    }
    await validateCompletionBindingIfPresent(
      context.attemptNumber,
      terminalHash,
    );
  }

  async function ownerReleased(
    attempt: number,
    sequence: number,
    ownerHash: string,
  ): Promise<boolean> {
    const path = releasePath(directories, attempt, sequence);
    if (!(await pathExists(path))) return false;
    const wrapped = await readWrappedRecord<ReleaseRecord>(
      path,
      "resource lease release record",
    );
    const record = exactKeys(wrapped.payload, [
      "schema_version",
      "artifact_kind",
      "contract_sha256",
      "attempt_number",
      "owner_sequence",
      "owner_record_sha256",
      "reason",
      "created_at",
    ], "resource lease release record");
    if (
      record.schema_version !== "benchmark-resource-lease-release-v1"
      || record.artifact_kind !== "BENCHMARK_RESOURCE_LEASE_OWNER_RELEASED"
      || record.contract_sha256 !== contract.contract_sha256
      || record.attempt_number !== attempt
      || record.owner_sequence !== sequence
      || record.owner_record_sha256 !== ownerHash
      || record.reason !== "CLEANUP_INCOMPLETE"
    ) {
      throw integrity("resource lease release record binding이 다릅니다.");
    }
    return true;
  }

  async function acquireOwnership(): Promise<AttemptContext> {
    for (;;) {
      const owners = await loadOwners(directories, contract.contract_sha256);
      if (owners.length === 0) {
        const claim: OwnerRecord = {
          schema_version: "benchmark-resource-lease-owner-v1",
          artifact_kind: "BENCHMARK_RESOURCE_LEASE_OWNER_CLAIM",
          contract_sha256: contract.contract_sha256,
          attempt_number: 1,
          owner_sequence: 1,
          owner: runtimeOwner,
          previous_owner_record_sha256: null,
          created_at: now().toISOString(),
        };
        if (await createWrappedRecord({
          path: ownerPath(directories, 1, 1),
          payload: claim,
          location: "resource lease initial owner claim",
        })) {
          return {
            attemptNumber: 1,
            ownerSequence: 1,
            ownerRecordSha256: sha256CanonicalJson(claim),
            adoptedFromReleasedOwner: false,
            resources: { vectorStoreId: null, uploadedFileIds: [] },
            preparedStore: null,
          };
        }
        continue;
      }

      const latestAttempt = Math.max(
        ...owners.map(({ record }) => record.attempt_number),
      );
      for (let attempt = 1; attempt < latestAttempt; attempt += 1) {
        if (!(await hasTerminal(attempt))) {
          throw integrity("이전 resource lease attempt가 terminal-cleaned가 아닙니다.");
        }
      }
      const latestOwners = owners.filter(
        ({ record }) => record.attempt_number === latestAttempt,
      );
      const latest = latestOwners.at(-1)!;

      if (await hasTerminal(latestAttempt)) {
        const nextAttempt = latestAttempt + 1;
        const claim: OwnerRecord = {
          schema_version: "benchmark-resource-lease-owner-v1",
          artifact_kind: "BENCHMARK_RESOURCE_LEASE_OWNER_CLAIM",
          contract_sha256: contract.contract_sha256,
          attempt_number: nextAttempt,
          owner_sequence: 1,
          owner: runtimeOwner,
          previous_owner_record_sha256: null,
          created_at: now().toISOString(),
        };
        if (await createWrappedRecord({
          path: ownerPath(directories, nextAttempt, 1),
          payload: claim,
          location: "resource lease next owner claim",
        })) {
          return {
            attemptNumber: nextAttempt,
            ownerSequence: 1,
            ownerRecordSha256: sha256CanonicalJson(claim),
            adoptedFromReleasedOwner: false,
            resources: { vectorStoreId: null, uploadedFileIds: [] },
            preparedStore: null,
          };
        }
        continue;
      }

      if (sameOwner(latest.record.owner, runtimeOwner)) {
        return {
          attemptNumber: latestAttempt,
          ownerSequence: latest.record.owner_sequence,
          ownerRecordSha256: latest.hash,
          adoptedFromReleasedOwner: false,
          resources: { vectorStoreId: null, uploadedFileIds: [] },
          preparedStore: null,
        };
      }
      const released = await ownerReleased(
        latestAttempt,
        latest.record.owner_sequence,
        latest.hash,
      );
      if (!released && await isOwnerAlive(latest.record.owner)) {
        throw new BenchmarkResourceLeaseConflictError(
          "다른 live 실행이 동일한 Recorded Benchmark 원격 자원 lease를 소유하고 있습니다.",
        );
      }
      const adoption: OwnerRecord = {
        schema_version: "benchmark-resource-lease-owner-v1",
        artifact_kind: "BENCHMARK_RESOURCE_LEASE_OWNER_ADOPTION",
        contract_sha256: contract.contract_sha256,
        attempt_number: latestAttempt,
        owner_sequence: latest.record.owner_sequence + 1,
        owner: runtimeOwner,
        previous_owner_record_sha256: latest.hash,
        created_at: now().toISOString(),
      };
      if (await createWrappedRecord({
        path: ownerPath(
          directories,
          latestAttempt,
          adoption.owner_sequence,
        ),
        payload: adoption,
        location: "resource lease owner adoption",
      })) {
        return {
          attemptNumber: latestAttempt,
          ownerSequence: adoption.owner_sequence,
          ownerRecordSha256: sha256CanonicalJson(adoption),
          adoptedFromReleasedOwner: released,
          resources: { vectorStoreId: null, uploadedFileIds: [] },
          preparedStore: null,
        };
      }
    }
  }

  async function loadTerminalLocalRecovery(): Promise<
    PreparedBenchmarkPolicyVectorStore | null
  > {
    const owners = await loadOwners(directories, contract.contract_sha256);
    if (owners.length === 0) return null;
    const latestAttempt = Math.max(
      ...owners.map(({ record }) => record.attempt_number),
    );
    if (!(await hasTerminal(latestAttempt))) return null;
    const latestOwner = owners.filter(
      ({ record }) => record.attempt_number === latestAttempt,
    ).at(-1)!;
    const context: AttemptContext = {
      attemptNumber: latestAttempt,
      ownerSequence: latestOwner.record.owner_sequence,
      ownerRecordSha256: latestOwner.hash,
      adoptedFromReleasedOwner: false,
      resources: { vectorStoreId: null, uploadedFileIds: [] },
      preparedStore: null,
    };
    // Partial preparation cleanup은 실행 identity가 없으므로 local-only resume 대상이 아닙니다.
    if (!(await pathExists(preparedPath(directories, latestAttempt)))) {
      return null;
    }
    const prepared = await loadPrepared(context);
    if (prepared === null) return null;
    const terminalWrapped = await readWrappedRecord<TerminalRecord>(
      terminalPath(directories, latestAttempt),
      "resource lease terminal record",
    );
    const terminal = assertTerminalRecord(
      terminalWrapped.payload,
      contract.contract_sha256,
      latestAttempt,
    );
    const cleanupFiles = (await listMatchingFiles(
      directories.cleanup,
      CLEANUP_FILE_PATTERN,
      "resource lease cleanup directory",
    )).filter((file) => Number(file.matches[1]) === latestAttempt);
    let matchingCleanup: CleanupRecord | null = null;
    for (const file of cleanupFiles) {
      const wrapped = await readWrappedRecord<CleanupRecord>(
        join(directories.cleanup, file.name),
        "resource lease cleanup record",
      );
      const cleanupRecord = parseCleanupRecord(
        wrapped.payload,
        contract.contract_sha256,
        latestAttempt,
      );
      if (wrapped.payloadSha256 === terminal.cleanup_record_sha256) {
        matchingCleanup = cleanupRecord;
      }
    }
    if (matchingCleanup === null) {
      throw integrity("terminal record에 결합된 cleanup record가 없습니다.");
    }
    const normalized = normalizeCleanup(
      matchingCleanup.cleanup,
      context.resources,
    );
    if (
      !matchingCleanup.cleanup_complete
      || !normalized.complete
      || matchingCleanup.resource_manifest_sha256
        !== terminal.resource_manifest_sha256
      || matchingCleanup.resource_manifest_sha256
        !== resourceManifestSha256(context.resources)
      || terminal.deletion_acknowledgements !== normalized.count
    ) {
      throw integrity("terminal-cleaned deletion acknowledgement chain이 다릅니다.");
    }
    await validateCompletionBindingIfPresent(
      latestAttempt,
      terminalWrapped.payloadSha256,
    );
    current = context;
    leaseMode = "TERMINAL_LOCAL_RECOVERY";
    recoveredTerminalCleanup = normalized.cleanup;
    return prepared;
  }

  async function appendProgress(
    context: AttemptContext,
    event: PolicyVectorStorePreparationEvent,
  ): Promise<void> {
    const progress = await loadProgress(
      directories,
      contract.contract_sha256,
      context.attemptNumber,
    );
    const eventSequence = progress.length + 1;
    const record: ProgressRecord = {
      schema_version: "benchmark-resource-lease-progress-v1",
      artifact_kind: "BENCHMARK_RESOURCE_LEASE_PROGRESS",
      contract_sha256: contract.contract_sha256,
      attempt_number: context.attemptNumber,
      owner_sequence: context.ownerSequence,
      event_sequence: eventSequence,
      previous_event_sha256: progress.at(-1)?.hash ?? null,
      event: structuredClone(event),
      created_at: now().toISOString(),
    };
    const created = await createWrappedRecord({
      path: eventPath(directories, context.attemptNumber, eventSequence),
      payload: record,
      location: "resource lease progress event",
    });
    if (!created) {
      throw integrity("resource lease progress event 순서가 충돌했습니다.");
    }
    const next = resourcesFromProgress([
      ...progress,
      { record, hash: sha256CanonicalJson(record) },
    ]);
    context.resources = next;
  }

  async function loadPrepared(
    context: AttemptContext,
  ): Promise<PreparedBenchmarkPolicyVectorStore | null> {
    const path = preparedPath(directories, context.attemptNumber);
    if (!(await pathExists(path))) return null;
    const progress = await loadProgress(
      directories,
      contract.contract_sha256,
      context.attemptNumber,
    );
    const wrapped = await readWrappedRecord<PreparedRecord>(
      path,
      "resource lease prepared record",
    );
    const record = parsePreparedRecord(
      wrapped.payload,
      contract.contract_sha256,
      context.attemptNumber,
    );
    if (
      record.progress_chain_sha256 !== progress.at(-1)?.hash
      || record.resource_manifest_sha256
        !== preparedResourceManifestSha256(record.prepared_store)
    ) {
      throw integrity("resource lease prepared record chain binding이 다릅니다.");
    }
    assertPreparedStore(record.prepared_store, progress, contract);
    context.resources = {
      vectorStoreId: record.prepared_store.vectorStoreId,
      uploadedFileIds: [...record.prepared_store.uploadedFileIds],
    };
    context.preparedStore = record.prepared_store;
    return record.prepared_store;
  }

  async function persistPrepared(
    context: AttemptContext,
    prepared: PreparedBenchmarkPolicyVectorStore,
  ): Promise<void> {
    const progress = await loadProgress(
      directories,
      contract.contract_sha256,
      context.attemptNumber,
    );
    assertPreparedStore(prepared, progress, contract);
    const record: PreparedRecord = {
      schema_version: "benchmark-resource-lease-prepared-v1",
      artifact_kind: "BENCHMARK_RESOURCE_LEASE_PREPARED",
      contract_sha256: contract.contract_sha256,
      attempt_number: context.attemptNumber,
      progress_chain_sha256: progress.at(-1)!.hash,
      resource_manifest_sha256: preparedResourceManifestSha256(prepared),
      prepared_store: structuredClone(prepared),
      created_at: now().toISOString(),
    };
    const created = await createWrappedRecord({
      path: preparedPath(directories, context.attemptNumber),
      payload: record,
      location: "resource lease prepared record",
    });
    if (!created) {
      throw integrity("resource lease prepared record는 덮어쓸 수 없습니다.");
    }
    context.resources = {
      vectorStoreId: prepared.vectorStoreId,
      uploadedFileIds: [...prepared.uploadedFileIds],
    };
    context.preparedStore = prepared;
  }

  async function writeRelease(
    context: AttemptContext,
  ): Promise<void> {
    const record: ReleaseRecord = {
      schema_version: "benchmark-resource-lease-release-v1",
      artifact_kind: "BENCHMARK_RESOURCE_LEASE_OWNER_RELEASED",
      contract_sha256: contract.contract_sha256,
      attempt_number: context.attemptNumber,
      owner_sequence: context.ownerSequence,
      owner_record_sha256: context.ownerRecordSha256,
      reason: "CLEANUP_INCOMPLETE",
      created_at: now().toISOString(),
    };
    const path = releasePath(
      directories,
      context.attemptNumber,
      context.ownerSequence,
    );
    const created = await createWrappedRecord({
      path,
      payload: record,
      location: "resource lease release record",
    });
    if (!created) {
      const existing = await readWrappedRecord<ReleaseRecord>(
        path,
        "resource lease release record",
      );
      if (
        canonicalJsonStringify(existing.payload)
        !== canonicalJsonStringify(record)
      ) {
        throw integrity("기존 resource lease release record가 다릅니다.");
      }
    }
  }

  function cleanupTargets(context: AttemptContext): Array<{
    readonly index: number;
    readonly kind: "VECTOR_STORE" | "UPLOADED_FILE";
    readonly id: string;
  }> {
    const targets: Array<{
      index: number;
      kind: "VECTOR_STORE" | "UPLOADED_FILE";
      id: string;
    }> = [];
    if (context.resources.vectorStoreId !== null) {
      targets.push({
        index: targets.length + 1,
        kind: "VECTOR_STORE",
        id: context.resources.vectorStoreId,
      });
    }
    for (const id of context.resources.uploadedFileIds) {
      targets.push({
        index: targets.length + 1,
        kind: "UPLOADED_FILE",
        id,
      });
    }
    return targets;
  }

  async function loadCleanupProgress(
    context: AttemptContext,
  ): Promise<Map<number, CleanupProgressRecord[]>> {
    const targets = cleanupTargets(context);
    const targetByIndex = new Map(
      targets.map((target) => [target.index, target]),
    );
    const files = (await listMatchingFiles(
      directories.cleanupProgress,
      CLEANUP_PROGRESS_FILE_PATTERN,
      "resource cleanup progress directory",
    )).filter(
      (file) => Number(file.matches[1]) === context.attemptNumber,
    );
    const byResource = new Map<number, CleanupProgressRecord[]>();
    for (const file of files) {
      const resourceIndex = Number(file.matches[2]);
      const trySequence = Number(file.matches[3]);
      const wrapped = await readWrappedRecord<CleanupProgressRecord>(
        join(directories.cleanupProgress, file.name),
        "resource cleanup progress record",
      );
      const record = parseCleanupProgressRecord(
        wrapped.payload,
        contract.contract_sha256,
        context.attemptNumber,
      );
      const target = targetByIndex.get(resourceIndex);
      const existing = byResource.get(resourceIndex) ?? [];
      if (
        target === undefined
        || record.resource_index !== resourceIndex
        || record.try_sequence !== trySequence
        || record.try_sequence !== existing.length + 1
        || record.resource_kind !== target.kind
        || record.resource_id !== target.id
        || existing.some((item) => item.delete_acknowledged)
      ) {
        throw integrity("resource cleanup progress chain binding이 다릅니다.");
      }
      existing.push(record);
      byResource.set(resourceIndex, existing);
    }
    return byResource;
  }

  async function cleanupWithProgressJournal(
    client: BenchmarkResourceLeaseRemoteClient,
    context: AttemptContext,
  ): Promise<PolicyVectorStoreCleanupResult> {
    const targets = cleanupTargets(context);
    const progress = await loadCleanupProgress(context);
    const requestOptions = { timeout: 10_000, maxRetries: 0 } as const;
    for (const target of targets) {
      const history = progress.get(target.index) ?? [];
      if (history.some((record) => record.delete_acknowledged)) continue;
      let deleteAcknowledged = false;
      let errorCode: CleanupProgressRecord["error_code"] = null;
      try {
        const response = target.kind === "VECTOR_STORE"
          ? await client.vectorStores.delete(target.id, requestOptions)
          : await client.files.delete(target.id, requestOptions);
        deleteAcknowledged = (
          response.id === target.id
          && response.deleted === true
        );
        if (!deleteAcknowledged) {
          errorCode = "DELETE_NOT_ACKNOWLEDGED";
        }
      } catch {
        // 공급자 오류 원문에는 resource ID나 인증 정보가 포함될 수 있습니다.
        errorCode = "DELETE_REQUEST_FAILED";
      }
      const record: CleanupProgressRecord = {
        schema_version: "benchmark-resource-cleanup-progress-v1",
        artifact_kind: "BENCHMARK_RESOURCE_CLEANUP_PROGRESS",
        contract_sha256: contract.contract_sha256,
        attempt_number: context.attemptNumber,
        owner_sequence: context.ownerSequence,
        resource_index: target.index,
        resource_kind: target.kind,
        resource_id: target.id,
        try_sequence: history.length + 1,
        delete_acknowledged: deleteAcknowledged,
        error_code: errorCode,
        created_at: now().toISOString(),
      };
      const created = await createWrappedRecord({
        path: cleanupProgressPath(
          directories,
          context.attemptNumber,
          target.index,
          record.try_sequence,
        ),
        payload: record,
        location: "resource cleanup progress record",
      });
      if (!created) {
        throw integrity("resource cleanup progress sequence가 충돌했습니다.");
      }
      history.push(record);
      progress.set(target.index, history);
      await afterCleanupProgressPersist?.(deepFreeze(structuredClone(record)));
    }

    const resultFor = (
      target: ReturnType<typeof cleanupTargets>[number],
    ) => {
      const history = progress.get(target.index) ?? [];
      const acknowledged = history.some(
        (record) => record.delete_acknowledged,
      );
      const latest = history.at(-1);
      return {
        id: target.id,
        attempted: history.length > 0,
        deleted: acknowledged,
        ...(!acknowledged && latest?.error_code
          ? { error: latest.error_code }
          : {}),
      };
    };
    const vectorTarget = targets.find(
      (target) => target.kind === "VECTOR_STORE",
    );
    const fileTargets = targets.filter(
      (target) => target.kind === "UPLOADED_FILE",
    );
    return {
      vectorStore: vectorTarget
        ? resultFor(vectorTarget)
        : { id: null, attempted: false, deleted: false },
      uploadedFiles: fileTargets.map(resultFor),
    };
  }

  async function finalizeCleanup(
    cleanupResult: PolicyVectorStoreCleanupResult,
    artifacts?: BenchmarkResourceLeaseFinalizationArtifacts,
  ): Promise<void> {
    await initialize();
    if (current === null) {
      throw integrity("finalize할 resource lease owner context가 없습니다.");
    }
    const context = current;
    const normalized = normalizeCleanup(cleanupResult, context.resources);
    const existingTerminal = await loadTerminalRecord(context.attemptNumber);
    if (existingTerminal) {
      if (!normalized.complete) {
        throw new BenchmarkResourceLeaseCleanupIncompleteError(
          "terminal-cleaned lease에 전달된 cleanup acknowledgement가 불완전합니다.",
        );
      }
      if (artifacts) {
        await persistCompletionBinding({
          context,
          terminalHash: existingTerminal.hash,
          artifacts,
        });
      } else {
        await validateCompletionBindingIfPresent(
          context.attemptNumber,
          existingTerminal.hash,
        );
      }
      if (context.preparedStore !== null) {
        leaseMode = "TERMINAL_LOCAL_RECOVERY";
        recoveredTerminalCleanup = normalized.cleanup;
      }
      return;
    }
    if (artifacts) {
      assertNonEmptyString(artifacts.cleanupReceipt.path, "cleanup receipt path");
      assertSha256(
        artifacts.cleanupReceipt.payloadSha256,
        "cleanup receipt payload hash",
      );
      if (artifacts.recordedPack) {
        assertNonEmptyString(artifacts.recordedPack.path, "recorded pack path");
        assertSha256(
          artifacts.recordedPack.payloadSha256,
          "recorded pack payload hash",
        );
      }
    }
    const cleanupFiles = (await listMatchingFiles(
      directories.cleanup,
      CLEANUP_FILE_PATTERN,
      "resource lease cleanup directory",
    )).filter(
      (file) => Number(file.matches[1]) === context.attemptNumber,
    );
    const sequence = cleanupFiles.length + 1;
    const record: CleanupRecord = {
      schema_version: "benchmark-resource-lease-cleanup-v1",
      artifact_kind: "BENCHMARK_RESOURCE_LEASE_CLEANUP_ATTEMPT",
      contract_sha256: contract.contract_sha256,
      attempt_number: context.attemptNumber,
      cleanup_sequence: sequence,
      owner_sequence: context.ownerSequence,
      resource_manifest_sha256: resourceManifestSha256(context.resources),
      cleanup: normalized.cleanup,
      cleanup_complete: normalized.complete,
      created_at: now().toISOString(),
    };
    const created = await createWrappedRecord({
      path: cleanupPath(directories, context.attemptNumber, sequence),
      payload: record,
      location: "resource lease cleanup record",
    });
    if (!created) {
      throw integrity("resource lease cleanup sequence가 충돌했습니다.");
    }
    if (!normalized.complete) {
      await writeRelease(context);
      throw new BenchmarkResourceLeaseCleanupIncompleteError(
        "원격 정책 자원의 삭제 승인이 불완전해 resource lease를 terminal-cleaned로 종결하지 못했습니다.",
      );
    }
    const terminal: TerminalRecord = {
      schema_version: "benchmark-resource-lease-terminal-v1",
      artifact_kind: "BENCHMARK_RESOURCE_LEASE_TERMINAL_CLEANED",
      contract_sha256: contract.contract_sha256,
      attempt_number: context.attemptNumber,
      resource_manifest_sha256: record.resource_manifest_sha256,
      cleanup_record_sha256: sha256CanonicalJson(record),
      // 자원 정리 terminal과 실제 산출물 completion은 별도 append-only 단계입니다.
      cleanup_receipt_payload_sha256: null,
      cleanup_receipt_path_sha256: null,
      recorded_pack_payload_sha256: null,
      recorded_pack_path_sha256: null,
      deletion_acknowledgements: normalized.count,
      terminal_status: "CLEANED",
      created_at: now().toISOString(),
    };
    const terminalRecordPath = terminalPath(
      directories,
      context.attemptNumber,
    );
    const terminalCreated = await createWrappedRecord({
      path: terminalRecordPath,
      payload: terminal,
      location: "resource lease terminal record",
    });
    if (!terminalCreated) {
      const existing = await readWrappedRecord<TerminalRecord>(
        terminalRecordPath,
        "resource lease terminal record",
      );
      const validated = assertTerminalRecord(
        existing.payload,
        contract.contract_sha256,
        context.attemptNumber,
      );
      if (
        canonicalJsonStringify(validated)
        !== canonicalJsonStringify(terminal)
      ) {
        throw integrity("기존 resource lease terminal record가 다릅니다.");
      }
    }
    const terminalHash = sha256CanonicalJson(terminal);
    if (artifacts) {
      await persistCompletionBinding({
        context,
        terminalHash,
        artifacts,
      });
    }
    if (context.preparedStore !== null) {
      leaseMode = "TERMINAL_LOCAL_RECOVERY";
      recoveredTerminalCleanup = normalized.cleanup;
    }
  }

  async function cleanupKnownResources(
    client: BenchmarkResourceLeaseRemoteClient,
    context: AttemptContext,
  ): Promise<PolicyVectorStoreCleanupResult> {
    return cleanupResource
      ? cleanupResource(client, context.resources)
      : cleanupWithProgressJournal(client, context);
  }

  async function cleanup({
    client,
  }: {
    readonly client: BenchmarkResourceLeaseRemoteClient;
  }): Promise<PolicyVectorStoreCleanupResult> {
    await initialize();
    if (current === null) {
      throw integrity("cleanup할 resource lease owner context가 없습니다.");
    }
    if (leaseMode === "TERMINAL_LOCAL_RECOVERY") {
      if (recoveredTerminalCleanup === null) {
        throw integrity("terminal cleanup acknowledgement가 없습니다.");
      }
      return structuredClone(recoveredTerminalCleanup);
    }
    return cleanupWithProgressJournal(client, current);
  }

  async function terminalAuthority(): Promise<
    BenchmarkResourceLeaseTerminalAuthority
  > {
    await initialize();
    if (
      current === null
      || current.preparedStore === null
      || leaseMode !== "TERMINAL_LOCAL_RECOVERY"
      || recoveredTerminalCleanup === null
    ) {
      throw integrity(
        "terminal authority에는 prepared identity와 완료된 durable cleanup chain이 필요합니다.",
      );
    }
    const terminal = await loadTerminalRecord(current.attemptNumber);
    if (terminal === null) {
      throw integrity("resource lease terminal source가 없습니다.");
    }
    const progress = await loadProgress(
      directories,
      contract.contract_sha256,
      current.attemptNumber,
    );
    assertPreparedStore(current.preparedStore, progress, contract);
    const normalized = normalizeCleanup(
      recoveredTerminalCleanup,
      current.resources,
    );
    if (
      !normalized.complete
      || terminal.record.resource_manifest_sha256
        !== resourceManifestSha256(current.resources)
      || terminal.record.deletion_acknowledgements !== normalized.count
    ) {
      throw integrity(
        "terminal authority의 prepared resource와 삭제 acknowledgement chain이 다릅니다.",
      );
    }
    const authority = deepFreeze({
      schema_version:
        "benchmark-resource-lease-terminal-authority-v1" as const,
      contract: structuredClone(contract),
      prepared_store: structuredClone(current.preparedStore),
      cleanup: structuredClone(normalized.cleanup),
      terminal_record_sha256: terminal.hash,
    });
    AUTHORITATIVE_TERMINAL_RESOURCE_LEASES.add(authority);
    return authority;
  }

  async function completedArtifacts(): Promise<
    BenchmarkResourceLeaseFinalizationArtifacts | null
  > {
    await initialize();
    if (current === null) return null;
    const terminal = await loadTerminalRecord(current.attemptNumber);
    if (terminal === null) return null;
    const completion = await validateCompletionBindingIfPresent(
      current.attemptNumber,
      terminal.hash,
    );
    if (completion === null) return null;
    return deepFreeze({
      cleanupReceipt: {
        path: completion.cleanup_receipt_path,
        payloadSha256: completion.cleanup_receipt_payload_sha256,
      },
      recordedPack: {
        path: completion.recorded_pack_path,
        payloadSha256: completion.recorded_pack_payload_sha256,
      },
    });
  }

  async function acquire({
    client,
    signal,
  }: AcquireBenchmarkResourceLeaseOptions): Promise<PreparedBenchmarkPolicyVectorStore> {
    await initialize();
    if (current?.preparedStore) {
      if (leaseMode === "TERMINAL_LOCAL_RECOVERY") {
        const terminal = await loadTerminalRecord(current.attemptNumber);
        if (terminal === null) {
          throw integrity("terminal local recovery record가 사라졌습니다.");
        }
        await validateCompletionBindingIfPresent(
          current.attemptNumber,
          terminal.hash,
        );
        return current.preparedStore;
      }
      await validateRemotePreparedStore(
        client,
        current.preparedStore,
        contract,
        { signal, now: readinessNow, sleep: readinessSleep },
      );
      return current.preparedStore;
    }
    const terminalRecovery = await loadTerminalLocalRecovery();
    if (terminalRecovery) return terminalRecovery;

    for (;;) {
      const context = await acquireOwnership();
      current = context;
      const existingPrepared = await loadPrepared(context);
      if (existingPrepared) {
        if (context.adoptedFromReleasedOwner) {
          const cleanup = await cleanupKnownResources(client, context);
          await finalizeCleanup(cleanup);
          current = null;
          continue;
        }
        try {
          await validateRemotePreparedStore(
            client,
            existingPrepared,
            contract,
            { signal, now: readinessNow, sleep: readinessSleep },
          );
          leaseMode = "ACTIVE_REMOTE";
          return existingPrepared;
        } catch {
          const cleanup = await cleanupKnownResources(client, context);
          throw new PolicyVectorStorePreparationError(
            "기존 원격 정책 resource lease의 존재·readiness 검증에 실패했습니다.",
            context.resources,
            cleanup,
          );
        }
      }

      const existingProgress = await loadProgress(
        directories,
        contract.contract_sha256,
        context.attemptNumber,
      );
      if (existingProgress.length > 0) {
        context.resources = resourcesFromProgress(existingProgress);
        const cleanup = await cleanupKnownResources(client, context);
        await finalizeCleanup(cleanup);
        current = null;
        continue;
      }

      try {
        const prepared = await prepareResource(
          client,
          policies,
          {
            name: contract.vector_store_name,
            filenamePrefix: contract.filename_prefix,
            ...(signal ? { signal } : {}),
            onPreparationEvent: (event) => appendProgress(context, event),
          },
        );
        await persistPrepared(context, prepared);
        await validateRemotePreparedStore(client, prepared, contract, {
          signal,
          now: readinessNow,
          sleep: readinessSleep,
        });
        leaseMode = "ACTIVE_REMOTE";
        return prepared;
      } catch (error) {
        if (error instanceof PolicyVectorStorePreparationError) {
          context.resources = {
            vectorStoreId: error.vectorStoreId,
            uploadedFileIds: [...error.uploadedFileIds],
          };
          throw error;
        }
        const progress = await loadProgress(
          directories,
          contract.contract_sha256,
          context.attemptNumber,
        );
        context.resources = resourcesFromProgress(progress);
        const cleanup = await cleanupKnownResources(client, context);
        const safeReason = error instanceof BenchmarkResourceLeaseIntegrityError
          ? ` ${error.message}`
          : "";
        throw new PolicyVectorStorePreparationError(
          `원격 정책 자원 준비 또는 durable lease 기록에 실패했습니다.${safeReason}`,
          context.resources,
          cleanup,
        );
      }
    }
  }

  return Object.freeze({
    acquire,
    cleanup,
    finalizeCleanup,
    mode: () => leaseMode,
    terminalCleanup: () => (
      recoveredTerminalCleanup === null
        ? null
        : structuredClone(recoveredTerminalCleanup)
    ),
    terminalAuthority,
    completedArtifacts,
  });
}

export function createProductionBenchmarkResourceLeaseController({
  lockedChallengePack,
  outputDirectory,
}: {
  readonly lockedChallengePack: LockedChallengePack;
  readonly outputDirectory: string;
}): BenchmarkResourceLeaseController {
  return createBenchmarkResourceLeaseController({
    rootDirectory: PRODUCTION_ROOT,
    createRoot: true,
    contract: buildBenchmarkResourceLeaseContract({
      lockedChallengePack,
      outputDirectory,
    }),
  });
}

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../eval/runtime/canonicalJson";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RECEIPT_FILE = /^authoritative-runtime-phase--([0-9]{6})\.json$/;
const CREDENTIAL = /(?:sk-[A-Za-z0-9_-]{16,}|bearer\s+[A-Za-z0-9._~-]{16,})/i;
const FORBIDDEN_REFERENCE_METADATA =
  /(?:oracle|private.*(?:key|mapping)|api.*key|authorization|credential|secret|blinding.*seed)/i;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_REFERENCE_BYTES = 128 * 1024 * 1024;
const MAX_HEAD_PIN_BYTES = 4096;

export const AUTHORITATIVE_RUNTIME_PHASES = Object.freeze([
  "DRAFT",
  "PROPOSED",
  "LOCKED",
  "READY",
  "RUNNING",
  "INVALID",
  "REVIEW_PENDING",
  "HUMAN_CONFIRMED_REVIEW",
  "MEMO_REVIEW_REQUIRED",
  "DECISION_CONFIRMED",
  "NO_APPROVED_CANDIDATE",
  "REGRESSION_RECORDED",
] as const);

export type AuthoritativeRuntimePhase =
  (typeof AUTHORITATIVE_RUNTIME_PHASES)[number];

const PHASES = new Set<string>(AUTHORITATIVE_RUNTIME_PHASES);
const PREVIOUS_PHASES: Readonly<
  Partial<Record<
    AuthoritativeRuntimePhase,
    readonly AuthoritativeRuntimePhase[]
  >>
> = Object.freeze({
  PROPOSED: ["DRAFT"],
  LOCKED: ["PROPOSED"],
  READY: ["LOCKED", "INVALID"],
  RUNNING: ["READY"],
  INVALID: ["RUNNING"],
  REVIEW_PENDING: ["RUNNING"],
  HUMAN_CONFIRMED_REVIEW: ["REVIEW_PENDING"],
  MEMO_REVIEW_REQUIRED: ["HUMAN_CONFIRMED_REVIEW"],
  DECISION_CONFIRMED: ["MEMO_REVIEW_REQUIRED"],
  NO_APPROVED_CANDIDATE: ["MEMO_REVIEW_REQUIRED"],
  REGRESSION_RECORDED: ["DECISION_CONFIRMED"],
});

const TERMINAL_PHASES = new Set<AuthoritativeRuntimePhase>([
  "NO_APPROVED_CANDIDATE",
  "REGRESSION_RECORDED",
]);

type JsonRecord = Record<string, unknown>;

export class AuthoritativeRuntimePhaseReceiptIntegrityError extends Error {
  readonly code = "AUTHORITATIVE_RUNTIME_PHASE_RECEIPT_INTEGRITY" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthoritativeRuntimePhaseReceiptIntegrityError";
  }
}

export interface AuthoritativeArtifactReferenceInput {
  readonly artifactKind: string;
  readonly path: string;
  readonly payloadSha256: string;
}

export interface ProjectionSnapshotReferenceInput {
  readonly path: string;
  readonly payloadSha256: string;
}

export interface AuthoritativeRuntimePhaseArtifactReference {
  readonly artifact_kind: string;
  readonly path: string;
  readonly payload_sha256: string;
}

export interface AuthoritativeRuntimePhaseProjectionReference {
  readonly path: string;
  readonly payload_sha256: string;
}

interface AuthoritativeRuntimePhaseReceiptBody {
  readonly schema_version: "authoritative-runtime-phase-receipt-v1";
  readonly artifact_kind: "AUTHORITATIVE_RUNTIME_PHASE_RECEIPT";
  readonly synthetic: true;
  readonly workflow_id: string;
  readonly sequence: number;
  readonly phase: AuthoritativeRuntimePhase;
  readonly previous_receipt_sha256: string | null;
  readonly authority_artifact: AuthoritativeRuntimePhaseArtifactReference;
  readonly projection_snapshot: AuthoritativeRuntimePhaseProjectionReference;
}

export interface AuthoritativeRuntimePhaseReceipt
  extends AuthoritativeRuntimePhaseReceiptBody {
  readonly receipt_sha256: string;
}

export interface AuthoritativeRuntimePhaseReceiptPaths {
  readonly outputDirectory: string;
  readonly workflowDirectory: string;
  readonly receiptPath: string;
}

export interface PersistedAuthoritativeRuntimePhaseReceipt
  extends AuthoritativeRuntimePhaseReceiptPaths {
  readonly receipt: AuthoritativeRuntimePhaseReceipt;
}

export interface AuthoritativeRuntimePhaseChain {
  readonly workflowId: string;
  readonly receipts: readonly AuthoritativeRuntimePhaseReceipt[];
  readonly head: AuthoritativeRuntimePhaseReceipt;
}

function integrity(
  message: string,
  cause?: unknown,
): AuthoritativeRuntimePhaseReceiptIntegrityError {
  return new AuthoritativeRuntimePhaseReceiptIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: JsonRecord,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.every((key): key is string => typeof key === "string")
    && keys.sort().join(",") === [...expected].sort().join(",")
  );
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

function clone<T>(value: T): T {
  return JSON.parse(canonicalJsonStringify(value)) as T;
}

function assertSafeId(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw integrity(`${location}가 안전한 식별자 계약과 다릅니다.`);
  }
}

function assertSha256(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw integrity(`${location}가 SHA-256 계약과 다릅니다.`);
  }
}

function assertSafeAbsolutePath(
  value: unknown,
  location: string,
): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 4096
    || !isAbsolute(value)
    || resolve(value) !== value
    || /[\0\r\n\p{Cc}]/u.test(value)
    || CREDENTIAL.test(value)
  ) {
    throw integrity(`${location}는 credential이 없는 canonical 절대 경로여야 합니다.`);
  }
}

function assertNoCredential(value: unknown, location: string): void {
  const serialized = canonicalJsonStringify(value);
  if (CREDENTIAL.test(serialized)) {
    throw integrity(`${location}에 credential 형태의 값이 포함되어 있습니다.`);
  }
}

export function createAuthoritativeRuntimePhaseReceiptPaths({
  outputDirectory,
  workflowId,
  sequence,
}: {
  readonly outputDirectory: string;
  readonly workflowId: string;
  readonly sequence: number;
}): AuthoritativeRuntimePhaseReceiptPaths {
  assertSafeId(workflowId, "workflowId");
  if (
    typeof outputDirectory !== "string"
    || outputDirectory.length === 0
    || !Number.isSafeInteger(sequence)
    || sequence < 0
    || sequence > 999_999
  ) {
    throw integrity("단계 영수증 경로 입력이 안전하지 않습니다.");
  }
  const root = resolve(outputDirectory);
  const workflowDirectory = join(root, `workflow--${workflowId}`);
  return Object.freeze({
    outputDirectory: root,
    workflowDirectory,
    receiptPath: join(
      workflowDirectory,
      `authoritative-runtime-phase--${String(sequence).padStart(6, "0")}.json`,
    ),
  });
}

async function assertSecureDirectory(
  path: string,
  location: string,
): Promise<void> {
  let stat;
  let canonical;
  try {
    stat = await lstat(path);
    canonical = await realpath(path);
  } catch (error) {
    throw integrity(`${location}을 검증할 수 없습니다.`, error);
  }
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== 0o700
    || canonical !== resolve(path)
  ) {
    throw integrity(`${location}은 symlink가 아닌 정확한 0700 디렉터리여야 합니다.`);
  }
}

async function syncDirectory(path: string, location: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    await handle.sync();
  } catch (error) {
    throw integrity(`${location}을 fsync할 수 없습니다.`, error);
  } finally {
    await handle?.close();
  }
}

interface CanonicalWrapper {
  readonly payload_sha256: string;
  readonly payload: JsonRecord;
}

async function readCanonicalWrapper({
  path,
  location,
  maxBytes,
}: {
  readonly path: string;
  readonly location: string;
  readonly maxBytes: number;
}): Promise<CanonicalWrapper> {
  assertSafeAbsolutePath(path, `${location} path`);
  let handle;
  let bytes: Buffer;
  try {
    const canonical = await realpath(path);
    if (canonical !== path) {
      throw integrity(`${location} path에 symlink 경로가 포함되어 있습니다.`);
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== 1
      || stat.size <= 0
      || stat.size > maxBytes
    ) {
      throw integrity(
        `${location}은 nlink1 regular 0600 file이며 크기 제한을 지켜야 합니다.`,
      );
    }
    bytes = await handle.readFile();
  } catch (error) {
    if (error instanceof AuthoritativeRuntimePhaseReceiptIntegrityError) {
      throw error;
    }
    throw integrity(`${location}을 symlink 없이 읽을 수 없습니다.`, error);
  } finally {
    await handle?.close();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw integrity(`${location}이 JSON이 아닙니다.`, error);
  }
  if (
    !isPlainRecord(parsed)
    || !hasExactKeys(parsed, ["payload", "payload_sha256"])
    || !isPlainRecord(parsed.payload)
  ) {
    throw integrity(`${location} wrapper의 exact key 계약이 다릅니다.`);
  }
  assertSha256(parsed.payload_sha256, `${location} payload_sha256`);
  const expectedBytes = Buffer.from(
    `${canonicalJsonStringify(parsed)}\n`,
    "utf8",
  );
  if (!bytes.equals(expectedBytes)) {
    throw integrity(`${location} bytes가 canonical JSON과 다릅니다.`);
  }
  return Object.freeze({
    payload_sha256: parsed.payload_sha256,
    payload: parsed.payload,
  });
}

function assertReferencePayloadHash(
  wrapper: CanonicalWrapper,
  location: string,
): void {
  const payload = wrapper.payload;
  if (
    payload.artifact_kind === "WORKSPACE_PROJECTION_SNAPSHOT"
    || payload.schema_version === "workspace-projection-snapshot-v1"
  ) {
    if (
      payload.artifact_kind !== "WORKSPACE_PROJECTION_SNAPSHOT"
      || payload.schema_version !== "workspace-projection-snapshot-v1"
      || payload.synthetic !== true
      || !hasExactKeys(payload, [
        "schema_version",
        "artifact_kind",
        "synthetic",
        "source_chain",
        "projections",
        "snapshot_id",
      ])
      || !Array.isArray(payload.source_chain)
      || !isPlainRecord(payload.projections)
      || !hasExactKeys(payload.projections, [
        "workspace",
        "challenges",
        "evidence",
        "benchmark_progress",
        "blind_reviews",
        "decisions",
        "baselines",
        "regressions",
      ])
      || typeof payload.snapshot_id !== "string"
    ) {
      throw integrity(`${location} projection snapshot exact 계약이 다릅니다.`);
    }
    const {
      snapshot_id: snapshotId,
      ...body
    } = payload;
    assertSha256(snapshotId, `${location} snapshot_id`);
    if (
      snapshotId !== wrapper.payload_sha256
      || sha256CanonicalJson(body) !== snapshotId
    ) {
      throw integrity(`${location} projection snapshot hash chain이 다릅니다.`);
    }
    return;
  }
  if (sha256CanonicalJson(payload) !== wrapper.payload_sha256) {
    throw integrity(`${location} payload hash가 canonical payload와 다릅니다.`);
  }
}

async function assertAuthorityArtifactReference(
  reference: AuthoritativeRuntimePhaseArtifactReference,
): Promise<void> {
  assertSafeId(reference.artifact_kind, "authority artifact kind");
  assertSafeAbsolutePath(reference.path, "authority artifact path");
  assertSha256(reference.payload_sha256, "authority artifact payload hash");
  if (
    FORBIDDEN_REFERENCE_METADATA.test(reference.artifact_kind)
    || FORBIDDEN_REFERENCE_METADATA.test(basename(reference.path))
  ) {
    throw integrity(
      "authority artifact reference에는 oracle·private key·credential metadata를 사용할 수 없습니다.",
    );
  }
  const wrapper = await readCanonicalWrapper({
    path: reference.path,
    location: "authority artifact",
    maxBytes: MAX_REFERENCE_BYTES,
  });
  assertReferencePayloadHash(wrapper, "authority artifact");
  if (
    wrapper.payload_sha256 !== reference.payload_sha256
    || wrapper.payload.artifact_kind !== reference.artifact_kind
  ) {
    throw integrity("authority artifact path·kind·payload hash binding이 다릅니다.");
  }
}

async function assertProjectionReference(
  reference: AuthoritativeRuntimePhaseProjectionReference,
): Promise<void> {
  assertSafeAbsolutePath(reference.path, "projection snapshot path");
  assertSha256(reference.payload_sha256, "projection snapshot payload hash");
  const wrapper = await readCanonicalWrapper({
    path: reference.path,
    location: "projection snapshot",
    maxBytes: MAX_REFERENCE_BYTES,
  });
  assertReferencePayloadHash(wrapper, "projection snapshot");
  if (
    wrapper.payload_sha256 !== reference.payload_sha256
    || wrapper.payload.artifact_kind !== "WORKSPACE_PROJECTION_SNAPSHOT"
    || wrapper.payload.schema_version !== "workspace-projection-snapshot-v1"
  ) {
    throw integrity("projection snapshot path·schema·payload hash binding이 다릅니다.");
  }
}

function buildReceipt({
  workflowId,
  sequence,
  phase,
  previousReceiptSha256,
  authorityArtifact,
  projectionSnapshot,
}: {
  readonly workflowId: string;
  readonly sequence: number;
  readonly phase: AuthoritativeRuntimePhase;
  readonly previousReceiptSha256: string | null;
  readonly authorityArtifact: AuthoritativeRuntimePhaseArtifactReference;
  readonly projectionSnapshot: AuthoritativeRuntimePhaseProjectionReference;
}): AuthoritativeRuntimePhaseReceipt {
  const body: AuthoritativeRuntimePhaseReceiptBody = {
    schema_version: "authoritative-runtime-phase-receipt-v1",
    artifact_kind: "AUTHORITATIVE_RUNTIME_PHASE_RECEIPT",
    synthetic: true,
    workflow_id: workflowId,
    sequence,
    phase,
    previous_receipt_sha256: previousReceiptSha256,
    authority_artifact: clone(authorityArtifact),
    projection_snapshot: clone(projectionSnapshot),
  };
  assertNoCredential(body, "단계 영수증");
  return deepFreeze({
    ...body,
    receipt_sha256: sha256CanonicalJson(body),
  });
}

function wrapperBytes(receipt: AuthoritativeRuntimePhaseReceipt): Buffer {
  return Buffer.from(`${canonicalJsonStringify({
    payload_sha256: receipt.receipt_sha256,
    payload: receipt,
  })}\n`, "utf8");
}

function headPinPath(outputDirectory: string, workflowId: string): string {
  assertSafeId(workflowId, "workflowId");
  return join(resolve(outputDirectory), `authoritative-runtime-head--${workflowId}.json`);
}

function headPinBytes(workflowId: string, headReceiptSha256: string): Buffer {
  assertSafeId(workflowId, "head pin workflow_id");
  assertSha256(headReceiptSha256, "head pin receipt hash");
  const payload = {
    schema_version: "authoritative-runtime-head-pin-v1",
    synthetic: true,
    workflow_id: workflowId,
    head_receipt_sha256: headReceiptSha256,
  } as const;
  return Buffer.from(`${canonicalJsonStringify({
    payload_sha256: sha256CanonicalJson(payload),
    payload,
  })}\n`, "utf8");
}

async function writeHeadPin(
  outputDirectory: string,
  workflowId: string,
  headReceiptSha256: string,
): Promise<void> {
  const path = headPinPath(outputDirectory, workflowId);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let temporaryCreated = false;
  try {
    const temporary = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await temporary.writeFile(headPinBytes(workflowId, headReceiptSha256));
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    await rename(temporaryPath, path);
    temporaryCreated = false;
    await syncDirectory(resolve(outputDirectory), "단계 영수증 head pin output root");
  } catch (error) {
    throw integrity("단계 영수증 head pin을 durable하게 저장할 수 없습니다.", error);
  } finally {
    if (temporaryCreated) {
      try {
        await unlink(temporaryPath);
      } catch {
        // loader가 임시 파일을 발견하면 fail-closed합니다.
      }
    }
  }
}

async function readHeadPin(
  outputDirectory: string,
  workflowId: string,
): Promise<string | null> {
  const path = headPinPath(outputDirectory, workflowId);
  try {
    await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw integrity("단계 영수증 head pin 존재 여부가 불명확합니다.", error);
  }
  try {
    const wrapper = await readCanonicalWrapper({
      path,
      location: "단계 영수증 head pin",
      maxBytes: MAX_HEAD_PIN_BYTES,
    });
    if (
      !hasExactKeys(wrapper.payload, [
        "schema_version",
        "synthetic",
        "workflow_id",
        "head_receipt_sha256",
      ])
      || wrapper.payload.schema_version !== "authoritative-runtime-head-pin-v1"
      || wrapper.payload.synthetic !== true
      || wrapper.payload.workflow_id !== workflowId
      || sha256CanonicalJson(wrapper.payload) !== wrapper.payload_sha256
    ) {
      throw integrity("단계 영수증 head pin exact 계약이 다릅니다.");
    }
    assertSha256(wrapper.payload.head_receipt_sha256, "head pin receipt hash");
    return wrapper.payload.head_receipt_sha256;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    if (error instanceof AuthoritativeRuntimePhaseReceiptIntegrityError) throw error;
    throw integrity("단계 영수증 head pin을 읽을 수 없습니다.", error);
  }
}

function parseReceipt(
  wrapper: CanonicalWrapper,
  expectedWorkflowId: string,
  expectedSequence: number,
): AuthoritativeRuntimePhaseReceipt {
  const payload = wrapper.payload;
  if (
    !hasExactKeys(payload, [
      "schema_version",
      "artifact_kind",
      "synthetic",
      "workflow_id",
      "sequence",
      "phase",
      "previous_receipt_sha256",
      "authority_artifact",
      "projection_snapshot",
      "receipt_sha256",
    ])
    || payload.schema_version !== "authoritative-runtime-phase-receipt-v1"
    || payload.artifact_kind !== "AUTHORITATIVE_RUNTIME_PHASE_RECEIPT"
    || payload.synthetic !== true
    || payload.workflow_id !== expectedWorkflowId
    || payload.sequence !== expectedSequence
    || typeof payload.phase !== "string"
    || !PHASES.has(payload.phase)
    || !isPlainRecord(payload.authority_artifact)
    || !hasExactKeys(payload.authority_artifact, [
      "artifact_kind",
      "path",
      "payload_sha256",
    ])
    || !isPlainRecord(payload.projection_snapshot)
    || !hasExactKeys(payload.projection_snapshot, [
      "path",
      "payload_sha256",
    ])
  ) {
    throw integrity("단계 영수증 payload의 exact schema 계약이 다릅니다.");
  }
  assertSafeId(payload.workflow_id, "receipt workflow_id");
  assertSha256(payload.receipt_sha256, "receipt_sha256");
  if (payload.previous_receipt_sha256 !== null) {
    assertSha256(
      payload.previous_receipt_sha256,
      "previous_receipt_sha256",
    );
  }
  const authorityArtifact = payload.authority_artifact;
  const projectionSnapshot = payload.projection_snapshot;
  assertSafeId(authorityArtifact.artifact_kind, "authority artifact kind");
  assertSafeAbsolutePath(authorityArtifact.path, "authority artifact path");
  assertSha256(authorityArtifact.payload_sha256, "authority artifact payload hash");
  assertSafeAbsolutePath(projectionSnapshot.path, "projection snapshot path");
  assertSha256(
    projectionSnapshot.payload_sha256,
    "projection snapshot payload hash",
  );

  const {
    receipt_sha256: _receiptSha256,
    ...body
  } = payload;
  if (
    sha256CanonicalJson(body) !== payload.receipt_sha256
    || wrapper.payload_sha256 !== payload.receipt_sha256
  ) {
    throw integrity("단계 영수증 receipt hash chain이 다릅니다.");
  }
  assertNoCredential(payload, "단계 영수증");
  return deepFreeze(clone(payload) as unknown as AuthoritativeRuntimePhaseReceipt);
}

function assertTransition(
  previous: AuthoritativeRuntimePhaseReceipt | null,
  current: AuthoritativeRuntimePhaseReceipt,
): void {
  if (previous === null) {
    if (
      current.sequence !== 0
      || current.phase !== "DRAFT"
      || current.previous_receipt_sha256 !== null
    ) {
      throw integrity("단계 영수증 체인은 DRAFT sequence 0에서 시작해야 합니다.");
    }
    return;
  }
  if (
    TERMINAL_PHASES.has(previous.phase)
    || current.sequence !== previous.sequence + 1
    || current.previous_receipt_sha256 !== previous.receipt_sha256
    || !PREVIOUS_PHASES[current.phase]?.includes(previous.phase)
  ) {
    throw integrity(
      `${previous.phase}에서 ${current.phase}로의 전이는 fork·rollback·누락 없는 계약과 다릅니다.`,
    );
  }
}

async function readReceiptFile({
  path,
  workflowId,
  sequence,
}: {
  readonly path: string;
  readonly workflowId: string;
  readonly sequence: number;
}): Promise<AuthoritativeRuntimePhaseReceipt> {
  const wrapper = await readCanonicalWrapper({
    path,
    location: `단계 영수증 sequence ${sequence}`,
    maxBytes: MAX_RECEIPT_BYTES,
  });
  const receipt = parseReceipt(wrapper, workflowId, sequence);
  await assertAuthorityArtifactReference(receipt.authority_artifact);
  await assertProjectionReference(receipt.projection_snapshot);
  return receipt;
}

async function workflowDirectoryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw integrity("단계 영수증 workflow 디렉터리 존재 여부가 불명확합니다.", error);
  }
}

async function loadChainInternal({
  outputDirectory,
  workflowId,
  expectedHeadReceiptSha256,
  allowEmpty,
}: {
  readonly outputDirectory: string;
  readonly workflowId: string;
  readonly expectedHeadReceiptSha256?: string | null;
  readonly allowEmpty: boolean;
}): Promise<{
  readonly paths: AuthoritativeRuntimePhaseReceiptPaths;
  readonly receipts: readonly AuthoritativeRuntimePhaseReceipt[];
}> {
  const paths = createAuthoritativeRuntimePhaseReceiptPaths({
    outputDirectory,
    workflowId,
    sequence: 0,
  });
  await assertSecureDirectory(paths.outputDirectory, "단계 영수증 output root");
  const pinnedHead = await readHeadPin(paths.outputDirectory, workflowId);
  if (
    expectedHeadReceiptSha256 !== undefined
    && pinnedHead !== null
    && expectedHeadReceiptSha256 !== pinnedHead
  ) {
    throw integrity("기대한 단계 영수증 head와 durable pin이 다릅니다.");
  }
  if (!(await workflowDirectoryExists(paths.workflowDirectory))) {
    if (allowEmpty && expectedHeadReceiptSha256 === null) {
      return { paths, receipts: Object.freeze([]) };
    }
    throw integrity("단계 영수증 workflow가 존재하지 않아 상태를 복원할 수 없습니다.");
  }
  await assertSecureDirectory(
    paths.workflowDirectory,
    "단계 영수증 workflow directory",
  );

  let entries;
  try {
    entries = await readdir(paths.workflowDirectory, { withFileTypes: true });
  } catch (error) {
    throw integrity("단계 영수증 목록을 읽을 수 없습니다.", error);
  }
  const sequenceByName: Array<{ readonly name: string; readonly sequence: number }> = [];
  for (const entry of entries) {
    const match = RECEIPT_FILE.exec(entry.name);
    if (!entry.isFile() || match === null) {
      throw integrity(
        "단계 영수증 디렉터리에 fork·임시 파일·알 수 없는 entry가 있어 상태가 불명확합니다.",
      );
    }
    sequenceByName.push({
      name: entry.name,
      sequence: Number(match[1]),
    });
  }
  sequenceByName.sort((left, right) => left.sequence - right.sequence);
  if (sequenceByName.length === 0) {
    if (allowEmpty && expectedHeadReceiptSha256 === null) {
      return { paths, receipts: Object.freeze([]) };
    }
    throw integrity("단계 영수증 체인이 비어 있어 상태가 불명확합니다.");
  }

  const receipts: AuthoritativeRuntimePhaseReceipt[] = [];
  const projectionPaths = new Set<string>();
  const projectionHashes = new Set<string>();
  for (const [index, entry] of sequenceByName.entries()) {
    if (entry.sequence !== index) {
      throw integrity("단계 영수증 sequence가 중복되거나 누락됐습니다.");
    }
    const receiptPath = createAuthoritativeRuntimePhaseReceiptPaths({
      outputDirectory: paths.outputDirectory,
      workflowId,
      sequence: index,
    }).receiptPath;
    if (basename(receiptPath) !== entry.name) {
      throw integrity("단계 영수증 파일명이 canonical sequence와 다릅니다.");
    }
    const receipt = await readReceiptFile({
      path: receiptPath,
      workflowId,
      sequence: index,
    });
    assertTransition(receipts[index - 1] ?? null, receipt);
    if (
      projectionPaths.has(receipt.projection_snapshot.path)
      || projectionHashes.has(receipt.projection_snapshot.payload_sha256)
    ) {
      throw integrity(
        "단계 영수증 체인이 이전 projection snapshot을 재사용해 rollback 상태가 불명확합니다.",
      );
    }
    projectionPaths.add(receipt.projection_snapshot.path);
    projectionHashes.add(receipt.projection_snapshot.payload_sha256);
    receipts.push(receipt);
  }

  const head = receipts.at(-1);
  if (head === undefined) {
    throw integrity("단계 영수증 head를 유일하게 결정할 수 없습니다.");
  }
  if (pinnedHead === null || pinnedHead !== head.receipt_sha256) {
    throw integrity("단계 영수증 durable head pin과 source에서 복원한 head가 다릅니다.");
  }
  if (
    expectedHeadReceiptSha256 !== undefined
    && expectedHeadReceiptSha256 !== head.receipt_sha256
  ) {
    throw integrity("기대한 단계 영수증 head와 source에서 복원한 head가 다릅니다.");
  }
  return {
    paths,
    receipts: Object.freeze(receipts),
  };
}

async function publishWriteOnce({
  path,
  bytes,
}: {
  readonly path: string;
  readonly bytes: Buffer;
}): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let temporaryCreated = false;
  try {
    const temporary = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await temporary.writeFile(bytes);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (hasCode(error, "EEXIST")) {
        throw integrity(
          "해당 sequence 단계 영수증이 이미 존재해 fork 또는 replay를 거부합니다.",
          error,
        );
      }
      throw integrity("단계 영수증을 atomic write-once 공개할 수 없습니다.", error);
    }
    await unlink(temporaryPath);
    temporaryCreated = false;
    await syncDirectory(dirname(path), "단계 영수증 workflow directory");
  } catch (error) {
    if (error instanceof AuthoritativeRuntimePhaseReceiptIntegrityError) {
      throw error;
    }
    throw integrity("단계 영수증을 write-once 저장할 수 없습니다.", error);
  } finally {
    if (temporaryCreated) {
      try {
        await unlink(temporaryPath);
      } catch {
        // 임시 hard link가 남으면 loader가 모호한 상태로 보고 fail-closed 합니다.
      }
    }
  }
}

export interface AppendAuthoritativeRuntimePhaseReceiptInput {
  readonly outputDirectory: string;
  readonly workflowId: string;
  readonly phase: AuthoritativeRuntimePhase;
  readonly expectedPreviousReceiptSha256: string | null;
  readonly artifact: AuthoritativeArtifactReferenceInput;
  readonly projectionSnapshot: ProjectionSnapshotReferenceInput;
}

export async function appendAuthoritativeRuntimePhaseReceipt(
  input: AppendAuthoritativeRuntimePhaseReceiptInput,
): Promise<PersistedAuthoritativeRuntimePhaseReceipt> {
  if (
    !isPlainRecord(input)
    || !hasExactKeys(input, [
      "outputDirectory",
      "workflowId",
      "phase",
      "expectedPreviousReceiptSha256",
      "artifact",
      "projectionSnapshot",
    ])
  ) {
    throw integrity("단계 영수증 append 입력의 exact key 계약이 다릅니다.");
  }
  const {
    outputDirectory,
    workflowId,
    phase,
    expectedPreviousReceiptSha256,
    artifact,
    projectionSnapshot,
  } = input;
  assertSafeId(workflowId, "workflowId");
  if (!PHASES.has(phase)) {
    throw integrity("phase가 잠긴 runtime 단계 집합과 다릅니다.");
  }
  if (expectedPreviousReceiptSha256 !== null) {
    assertSha256(
      expectedPreviousReceiptSha256,
      "expected previous receipt hash",
    );
  }
  if (
    !isPlainRecord(artifact)
    || !hasExactKeys(artifact, [
      "artifactKind",
      "path",
      "payloadSha256",
    ])
    || !isPlainRecord(projectionSnapshot)
    || !hasExactKeys(projectionSnapshot, [
      "path",
      "payloadSha256",
    ])
  ) {
    throw integrity("단계 영수증 reference 입력의 exact key 계약이 다릅니다.");
  }
  const authorityArtifact: AuthoritativeRuntimePhaseArtifactReference = {
    artifact_kind: artifact.artifactKind,
    path: artifact.path,
    payload_sha256: artifact.payloadSha256,
  };
  const projectionReference: AuthoritativeRuntimePhaseProjectionReference = {
    path: projectionSnapshot.path,
    payload_sha256: projectionSnapshot.payloadSha256,
  };
  await assertAuthorityArtifactReference(authorityArtifact);
  await assertProjectionReference(projectionReference);

  const initialPaths = createAuthoritativeRuntimePhaseReceiptPaths({
    outputDirectory,
    workflowId,
    sequence: 0,
  });
  await assertSecureDirectory(
    initialPaths.outputDirectory,
    "단계 영수증 output root",
  );
  const workflowExists = await workflowDirectoryExists(
    initialPaths.workflowDirectory,
  );
  if (!workflowExists) {
    if (phase !== "DRAFT" || expectedPreviousReceiptSha256 !== null) {
      throw integrity(
        "새 단계 영수증 체인은 DRAFT와 null previous hash로만 시작할 수 있습니다.",
      );
    }
    try {
      await mkdir(initialPaths.workflowDirectory, {
        recursive: false,
        mode: 0o700,
      });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw integrity(
          "단계 영수증 workflow directory를 만들 수 없습니다.",
          error,
        );
      }
    }
  }
  await assertSecureDirectory(
    initialPaths.workflowDirectory,
    "단계 영수증 workflow directory",
  );
  // 직전 mkdir의 생성 내구성과 과거 fsync 실패 재시도를 모두 확정합니다.
  await syncDirectory(initialPaths.outputDirectory, "단계 영수증 output root");

  const chain = await loadChainInternal({
    outputDirectory,
    workflowId,
    expectedHeadReceiptSha256: expectedPreviousReceiptSha256,
    allowEmpty: true,
  });
  const previous = chain.receipts.at(-1) ?? null;
  if (chain.receipts.some((existing) => (
    existing.projection_snapshot.path === projectionReference.path
    || existing.projection_snapshot.payload_sha256
      === projectionReference.payload_sha256
  ))) {
    throw integrity(
      "이전 단계 projection snapshot 재사용은 상태 rollback으로 간주해 거부합니다.",
    );
  }
  const receipt = buildReceipt({
    workflowId,
    sequence: chain.receipts.length,
    phase,
    previousReceiptSha256: previous?.receipt_sha256 ?? null,
    authorityArtifact,
    projectionSnapshot: projectionReference,
  });
  assertTransition(previous, receipt);

  const paths = createAuthoritativeRuntimePhaseReceiptPaths({
    outputDirectory,
    workflowId,
    sequence: receipt.sequence,
  });
  await publishWriteOnce({
    path: paths.receiptPath,
    bytes: wrapperBytes(receipt),
  });

  await writeHeadPin(outputDirectory, workflowId, receipt.receipt_sha256);

  const reloaded = await loadChainInternal({
    outputDirectory,
    workflowId,
    expectedHeadReceiptSha256: receipt.receipt_sha256,
    allowEmpty: false,
  });
  const persisted = reloaded.receipts.at(-1);
  if (
    persisted === undefined
    || canonicalJsonStringify(persisted) !== canonicalJsonStringify(receipt)
  ) {
    throw integrity("저장한 단계 영수증을 source에서 동일하게 복원하지 못했습니다.");
  }
  return Object.freeze({
    ...paths,
    receipt: persisted,
  });
}

export async function loadAuthoritativeRuntimePhaseChain({
  outputDirectory,
  workflowId,
  expectedHeadReceiptSha256,
}: {
  readonly outputDirectory: string;
  readonly workflowId: string;
  readonly expectedHeadReceiptSha256?: string;
}): Promise<AuthoritativeRuntimePhaseChain> {
  if (expectedHeadReceiptSha256 !== undefined) {
    assertSha256(expectedHeadReceiptSha256, "expected head receipt hash");
  }
  const loaded = await loadChainInternal({
    outputDirectory,
    workflowId,
    expectedHeadReceiptSha256,
    allowEmpty: false,
  });
  const head = loaded.receipts.at(-1);
  if (head === undefined) {
    throw integrity("단계 영수증 head가 없어 hydration을 수행할 수 없습니다.");
  }
  return deepFreeze({
    workflowId,
    receipts: loaded.receipts,
    head,
  });
}

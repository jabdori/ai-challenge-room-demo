import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  assertCanonicalLifecycleDirectory,
  persistCanonicalLifecycleFile,
  readCanonicalLifecycleFile,
} from "../eval/lifecycle/canonicalLifecyclePersistence";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../eval/runtime/canonicalJson";
import type { ChallengeLifecycleSourceState } from "./challengeLifecycleSnapshots";
import {
  persistProjectionSnapshot,
  type ProjectionSnapshot,
} from "./projectionRepository";
import {
  appendAuthoritativeRuntimePhaseReceipt,
  loadAuthoritativeRuntimePhaseChain,
  type AuthoritativeRuntimePhase,
  type AuthoritativeRuntimePhaseChain,
} from "./authoritativeRuntimePhaseReceipt";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type JsonRecord = Record<string, unknown>;

export class AuthoritativeRuntimeHydrationIntegrityError extends Error {
  readonly code = "AUTHORITATIVE_RUNTIME_HYDRATION_INTEGRITY" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthoritativeRuntimeHydrationIntegrityError";
  }
}

function integrity(message: string, cause?: unknown): never {
  throw new AuthoritativeRuntimeHydrationIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function assertSafeId(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    integrity(`${location}가 안전한 식별자 계약과 다릅니다.`);
  }
}

function assertSha256(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    integrity(`${location}가 SHA-256 계약과 다릅니다.`);
  }
}

/** phase receipt가 가리키는 private full-state source입니다. */
export interface AuthoritativeRuntimeHydrationArtifact {
  readonly schema_version: "authoritative-runtime-hydration-v1";
  readonly artifact_kind: "AUTHORITATIVE_RUNTIME_HYDRATION";
  readonly synthetic: true;
  readonly workflow_id: string;
  readonly phase: AuthoritativeRuntimePhase;
  readonly lifecycle_state: ChallengeLifecycleSourceState;
  /** REVIEW_PENDING 이후 mutable workflow의 source-reloaded 상태입니다. */
  readonly workflow_state: JsonRecord | null;
}

export interface PersistedAuthoritativeRuntimeHydration {
  readonly path: string;
  readonly payloadSha256: string;
  readonly artifact: AuthoritativeRuntimeHydrationArtifact;
}

export interface HydratedAuthoritativeRuntimeState
  extends PersistedAuthoritativeRuntimeHydration {
  readonly chain: AuthoritativeRuntimePhaseChain;
  readonly projectionSnapshot: ProjectionSnapshot;
}

function artifactDirectory(rootDirectory: string): string {
  return join(resolve(rootDirectory), "runtime-hydration");
}

function artifactPath(rootDirectory: string, workflowId: string, phase: AuthoritativeRuntimePhase, sequence: number): string {
  assertSafeId(workflowId, "workflowId");
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    integrity("hydration sequence가 안전한 정수가 아닙니다.");
  }
  return join(
    artifactDirectory(rootDirectory),
    `runtime-hydration--${workflowId}--${String(sequence).padStart(6, "0")}--${phase}.json`,
  );
}

function wrapper(artifact: AuthoritativeRuntimeHydrationArtifact): JsonRecord {
  return {
    payload_sha256: sha256CanonicalJson(artifact),
    payload: artifact,
  };
}

function parseArtifact(value: unknown): AuthoritativeRuntimeHydrationArtifact {
  if (!isPlainRecord(value) || !exactKeys(value, ["payload_sha256", "payload"])) {
    integrity("runtime hydration wrapper의 exact schema가 다릅니다.");
  }
  assertSha256(value.payload_sha256, "runtime hydration payload hash");
  if (!isPlainRecord(value.payload) || !exactKeys(value.payload, [
    "schema_version",
    "artifact_kind",
    "synthetic",
    "workflow_id",
    "phase",
    "lifecycle_state",
    "workflow_state",
  ])) {
    integrity("runtime hydration payload의 exact schema가 다릅니다.");
  }
  const payload = value.payload;
  if (
    payload.schema_version !== "authoritative-runtime-hydration-v1"
    || payload.artifact_kind !== "AUTHORITATIVE_RUNTIME_HYDRATION"
    || payload.synthetic !== true
    || typeof payload.phase !== "string"
    || !isPlainRecord(payload.lifecycle_state)
    || !(payload.workflow_state === null || isPlainRecord(payload.workflow_state))
    || sha256CanonicalJson(payload) !== value.payload_sha256
  ) {
    integrity("runtime hydration payload의 hash 또는 type 계약이 다릅니다.");
  }
  assertSafeId(payload.workflow_id, "runtime hydration workflow_id");
  return structuredClone(payload) as unknown as AuthoritativeRuntimeHydrationArtifact;
}

export async function persistAuthoritativeRuntimeHydration({
  outputDirectory,
  workflowId,
  phase,
  sequence,
  lifecycleState,
  workflowState = null,
}: {
  readonly outputDirectory: string;
  readonly workflowId: string;
  readonly phase: AuthoritativeRuntimePhase;
  readonly sequence: number;
  readonly lifecycleState: ChallengeLifecycleSourceState;
  readonly workflowState?: JsonRecord | null;
}): Promise<PersistedAuthoritativeRuntimeHydration> {
  assertSafeId(workflowId, "workflowId");
  if (!isPlainRecord(lifecycleState) || !(workflowState === null || isPlainRecord(workflowState))) {
    integrity("runtime hydration은 canonical plain source state만 저장할 수 있습니다.");
  }
  const artifact: AuthoritativeRuntimeHydrationArtifact = {
    schema_version: "authoritative-runtime-hydration-v1",
    artifact_kind: "AUTHORITATIVE_RUNTIME_HYDRATION",
    synthetic: true,
    workflow_id: workflowId,
    phase,
    lifecycle_state: structuredClone(lifecycleState),
    workflow_state: workflowState === null ? null : structuredClone(workflowState),
  };
  const parsed = parseArtifact(wrapper(artifact));
  const directory = artifactDirectory(outputDirectory);
  const path = artifactPath(outputDirectory, workflowId, phase, sequence);
  await persistCanonicalLifecycleFile({
    rootDirectory: resolve(outputDirectory),
    artifactDirectory: directory,
    filePath: path,
    value: wrapper(parsed),
    label: "runtime hydration artifact",
  });
  return Object.freeze({
    path,
    payloadSha256: sha256CanonicalJson(parsed),
    artifact: parsed,
  });
}

export async function loadAuthoritativeRuntimeHydration({
  outputDirectory,
  workflowId,
}: {
  readonly outputDirectory: string;
  readonly workflowId: string;
}): Promise<HydratedAuthoritativeRuntimeState | null> {
  assertSafeId(workflowId, "workflowId");
  const chain = await loadAuthoritativeRuntimePhaseChain({
    outputDirectory: resolve(outputDirectory),
    workflowId,
  });
  const head = chain.head;
  if (head.authority_artifact.artifact_kind !== "AUTHORITATIVE_RUNTIME_HYDRATION") {
    integrity("phase head가 runtime hydration authority artifact을 가리키지 않습니다.");
  }
  const directory = artifactDirectory(outputDirectory);
  await assertCanonicalLifecycleDirectory({
    rootDirectory: resolve(outputDirectory),
    artifactDirectory: directory,
  });
  const expectedPrefix = `runtime-hydration--${workflowId}--${String(head.sequence).padStart(6, "0")}--${head.phase}.json`;
  if (basename(head.authority_artifact.path) !== expectedPrefix) {
    integrity("phase head hydration artifact filename이 canonical sequence와 다릅니다.");
  }
  const loaded = await readCanonicalLifecycleFile({
    path: head.authority_artifact.path,
    label: "runtime hydration artifact",
  });
  const artifact = parseArtifact(loaded.value);
  if (
    artifact.workflow_id !== workflowId
    || artifact.phase !== head.phase
    || sha256CanonicalJson(artifact) !== head.authority_artifact.payload_sha256
  ) {
    integrity("phase head와 runtime hydration source의 workflow·phase·hash 결합이 다릅니다.");
  }
  // projection loader는 phase receipt module이 wrapper/hash/symlink를 이미
  // 확인한 뒤이므로, 실제 public snapshot parser가 추가 exact 검증을 수행합니다.
  const { loadReadOnlyProjectionSnapshotRecord } = await import("./projectionRepository");
  const projectionSnapshot = await loadReadOnlyProjectionSnapshotRecord({
    path: head.projection_snapshot.path,
  });
  if (projectionSnapshot.snapshot_id !== head.projection_snapshot.payload_sha256) {
    integrity("phase head와 projection snapshot hash 결합이 다릅니다.");
  }
  return Object.freeze({
    path: head.authority_artifact.path,
    payloadSha256: head.authority_artifact.payload_sha256,
    artifact,
    chain,
    projectionSnapshot,
  });
}

/** head pin 자체가 없을 때만 새 DRAFT workflow로 시작할 수 있습니다. */
export async function loadAuthoritativeRuntimeHydrationIfPresent({
  outputDirectory,
  workflowId,
}: {
  readonly outputDirectory: string;
  readonly workflowId: string;
}): Promise<HydratedAuthoritativeRuntimeState | null> {
  assertSafeId(workflowId, "workflowId");
  const pin = join(
    resolve(outputDirectory),
    `authoritative-runtime-head--${workflowId}.json`,
  );
  try {
    await access(pin, constants.F_OK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    integrity("runtime phase head pin 존재 여부를 확인할 수 없습니다.", error);
  }
  return loadAuthoritativeRuntimeHydration({ outputDirectory, workflowId });
}

export async function persistAndAppendAuthoritativeRuntimePhase({
  outputDirectory,
  projectionOutputDirectory,
  workflowId,
  phase,
  expectedPreviousReceiptSha256,
  lifecycleState,
  workflowState,
  projectionSnapshot,
}: {
  readonly outputDirectory: string;
  readonly projectionOutputDirectory: string;
  readonly workflowId: string;
  readonly phase: AuthoritativeRuntimePhase;
  readonly expectedPreviousReceiptSha256: string | null;
  readonly lifecycleState: ChallengeLifecycleSourceState;
  readonly workflowState?: JsonRecord | null;
  readonly projectionSnapshot: ProjectionSnapshot;
}): Promise<{ readonly receiptSha256: string; readonly artifact: PersistedAuthoritativeRuntimeHydration }> {
  const sequence = expectedPreviousReceiptSha256 === null
    ? 0
    : (await loadAuthoritativeRuntimePhaseChain({
      outputDirectory,
      workflowId,
      expectedHeadReceiptSha256: expectedPreviousReceiptSha256,
    })).head.sequence + 1;
  const artifact = await persistAuthoritativeRuntimeHydration({
    outputDirectory,
    workflowId,
    phase,
    sequence,
    lifecycleState,
    ...(workflowState === undefined ? {} : { workflowState }),
  });
  // private state와 public projection의 결합은 append 시의 같은 receipt와
  // startup의 결정적 source 재빌드 비교로 확인합니다. public projection source
  // chain에 private hydration hash를 넣으면 이후 workflow snapshot builder가
  // 재현할 수 없어 mutable transition이 끊기므로 포함하지 않습니다.
  const persistedProjection = await persistProjectionSnapshot({
    outputDirectory: projectionOutputDirectory,
    snapshot: projectionSnapshot,
  });
  const appended = await appendAuthoritativeRuntimePhaseReceipt({
    outputDirectory,
    workflowId,
    phase,
    expectedPreviousReceiptSha256,
    artifact: {
      artifactKind: artifact.artifact.artifact_kind,
      path: artifact.path,
      payloadSha256: artifact.payloadSha256,
    },
    projectionSnapshot: {
      path: persistedProjection.path,
      payloadSha256: projectionSnapshot.snapshot_id,
    },
  });
  return Object.freeze({ receiptSha256: appended.receipt.receipt_sha256, artifact });
}

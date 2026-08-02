import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../eval/runtime/canonicalJson";
import type {
  ChallengeApiGateway,
  ChallengeMutationCommand,
  PublicProjection,
} from "./challengeServer";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PRIVATE_KEY = /^(?:api[_-]?key|authorization|private[_-]?mapping|label[_-]?to[_-]?candidate|(?:master|case)?[_-]?blinding[_-]?seed|raw[_-]?oracle|hidden[_-]?oracle|unrestricted[_-]?order)$/i;

type JsonRecord = Record<string, unknown>;

export class ProjectionRepositoryIntegrityError extends Error {
  readonly code = "PROJECTION_REPOSITORY_INTEGRITY" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectionRepositoryIntegrityError";
  }
}

export class ReadOnlyProjectionError extends Error {
  readonly code = "READ_ONLY_PROJECTION" as const;

  constructor() {
    super("읽기 전용 projection snapshot은 권위 mutation을 실행할 수 없습니다.");
    this.name = "ReadOnlyProjectionError";
  }
}

export interface ProjectionSourceReference {
  readonly artifact_kind: string;
  readonly artifact_id: string;
  readonly payload_sha256: string;
}

export interface ProjectionSnapshotInput {
  readonly source_chain: readonly ProjectionSourceReference[];
  readonly workspace: PublicProjection;
  readonly challenges: readonly PublicProjection[];
  readonly evidence: readonly PublicProjection[];
  readonly benchmark_progress: readonly PublicProjection[];
  readonly blind_reviews: readonly PublicProjection[];
  readonly decisions: readonly PublicProjection[];
  readonly baselines: readonly PublicProjection[];
  readonly regressions: readonly PublicProjection[];
}

interface ProjectionCollections {
  readonly workspace: PublicProjection;
  readonly challenges: readonly PublicProjection[];
  readonly evidence: readonly PublicProjection[];
  readonly benchmark_progress: readonly PublicProjection[];
  readonly blind_reviews: readonly PublicProjection[];
  readonly decisions: readonly PublicProjection[];
  readonly baselines: readonly PublicProjection[];
  readonly regressions: readonly PublicProjection[];
}

export interface ProjectionSnapshot {
  readonly schema_version: "workspace-projection-snapshot-v1";
  readonly artifact_kind: "WORKSPACE_PROJECTION_SNAPSHOT";
  readonly synthetic: true;
  readonly source_chain: readonly ProjectionSourceReference[];
  readonly projections: ProjectionCollections;
  readonly snapshot_id: string;
}

export interface ProjectionSnapshotPaths {
  readonly outputDirectory: string;
  readonly directory: string;
  readonly path: string;
}

export interface PersistProjectionSnapshotResult extends ProjectionSnapshotPaths {
  readonly payloadSha256: string;
}

interface ProjectionContract {
  readonly collection: keyof Omit<ProjectionCollections, "workspace">;
  readonly schemas: readonly string[];
  readonly identityField: string;
}

const COLLECTION_CONTRACTS: readonly ProjectionContract[] = Object.freeze([
  {
    collection: "challenges",
    schemas: ["challenge-public-projection-v1"],
    identityField: "challenge_id",
  },
  {
    collection: "evidence",
    schemas: ["evidence-public-projection-v1"],
    identityField: "evidence_id",
  },
  {
    collection: "benchmark_progress",
    schemas: [
      "benchmark-progress-projection-v1",
      "benchmark-lifecycle-ready-projection-v1",
      "benchmark-lifecycle-projection-v1",
      "benchmark-lifecycle-invalid-projection-v1",
    ],
    identityField: "benchmark_id",
  },
  {
    collection: "blind_reviews",
    schemas: [
      "blind-review-public-projection-v1",
      "preconfirmation-public-projection-v1",
    ],
    identityField: "review_id",
  },
  {
    collection: "decisions",
    schemas: ["decision-public-projection-v1"],
    identityField: "decision_id",
  },
  {
    collection: "baselines",
    schemas: ["baseline-public-projection-v1"],
    identityField: "baseline_id",
  },
  {
    collection: "regressions",
    schemas: ["regression-public-projection-v1"],
    identityField: "regression_id",
  },
]);

function integrity(
  message: string,
  cause?: unknown,
): ProjectionRepositoryIntegrityError {
  return new ProjectionRepositoryIntegrityError(
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJsonStringify(value)) as T;
}

function assertBrowserSafe(value: unknown, location: string): void {
  let visited = 0;
  const visit = (child: unknown, path: string, depth: number): void => {
    visited += 1;
    if (visited > 20_000 || depth > 48) {
      throw integrity(`${location}의 크기 또는 깊이가 제한을 초과합니다.`);
    }
    if (typeof child === "string") {
      if (/sk-[A-Za-z0-9_-]{16,}/.test(child)) {
        throw integrity(`${path}에 credential 형태가 있습니다.`);
      }
      return;
    }
    if (
      child === null
      || typeof child === "boolean"
      || (typeof child === "number" && Number.isFinite(child))
    ) return;
    if (Array.isArray(child)) {
      child.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!isPlainRecord(child)) {
      throw integrity(`${path}는 plain JSON이어야 합니다.`);
    }
    for (const [key, nested] of Object.entries(child)) {
      if (PRIVATE_KEY.test(key) || key.length > 256 || /[\p{Cc}]/u.test(key)) {
        throw integrity(`${path}.${key}는 공개 projection에 허용되지 않습니다.`);
      }
      visit(nested, `${path}.${key}`, depth + 1);
    }
  };
  visit(value, location, 0);
}

function assertSourceChain(
  chain: readonly ProjectionSourceReference[],
): ReadonlySet<string> {
  if (!Array.isArray(chain) || chain.length === 0 || chain.length > 32) {
    throw integrity("projection source chain은 1~32개의 권위 artifact가 필요합니다.");
  }
  const identities = new Set<string>();
  const hashes = new Set<string>();
  for (const [index, source] of chain.entries()) {
    if (
      !isPlainRecord(source)
      || Object.keys(source).sort().join(",")
        !== "artifact_id,artifact_kind,payload_sha256"
      || typeof source.artifact_kind !== "string"
      || !SAFE_ID.test(source.artifact_kind)
      || typeof source.artifact_id !== "string"
      || !SAFE_ID.test(source.artifact_id)
      || typeof source.payload_sha256 !== "string"
      || !SHA256.test(source.payload_sha256)
    ) {
      throw integrity(`projection source_chain[${index}] 계약이 다릅니다.`);
    }
    const identity = `${source.artifact_kind}:${source.artifact_id}`;
    if (identities.has(identity)) {
      throw integrity("projection source chain에 중복 artifact identity가 있습니다.");
    }
    identities.add(identity);
    hashes.add(source.payload_sha256);
  }
  return hashes;
}

function assertProjection(
  projection: PublicProjection,
  schemas: readonly string[],
  identityField: string | null,
  sourceHashes: ReadonlySet<string>,
  identities?: Set<string>,
): void {
  const contractLabel = schemas.join("|");
  assertBrowserSafe(projection, contractLabel);
  if (
    typeof projection.schema_version !== "string"
    || !schemas.includes(projection.schema_version)
    || projection.synthetic !== true
  ) {
    throw integrity(`${contractLabel} projection의 schema 또는 synthetic 경계가 다릅니다.`);
  }
  if (identityField === null) return;
  const identity = projection[identityField];
  if (
    typeof identity !== "string"
    || !SAFE_ID.test(identity)
    || identities?.has(identity)
    || typeof projection.source_hash !== "string"
    || !sourceHashes.has(projection.source_hash)
  ) {
    throw integrity(`${contractLabel} projection의 identity 또는 source hash가 다릅니다.`);
  }
  identities?.add(identity);
}

function snapshotBody(input: ProjectionSnapshotInput): Omit<ProjectionSnapshot, "snapshot_id"> {
  const sourceHashes = assertSourceChain(input.source_chain);
  assertProjection(
    input.workspace,
    ["workspace-public-projection-v1"],
    null,
    sourceHashes,
  );

  const projections: ProjectionCollections = {
    workspace: clone(input.workspace),
    challenges: clone(input.challenges),
    evidence: clone(input.evidence),
    benchmark_progress: clone(input.benchmark_progress),
    blind_reviews: clone(input.blind_reviews),
    decisions: clone(input.decisions),
    baselines: clone(input.baselines),
    regressions: clone(input.regressions),
  };
  for (const contract of COLLECTION_CONTRACTS) {
    const identities = new Set<string>();
    const values = projections[contract.collection];
    if (!Array.isArray(values) || values.length > 512) {
      throw integrity(`${contract.collection} projection collection이 유효하지 않습니다.`);
    }
    for (const projection of values) {
      assertProjection(
        projection,
        contract.schemas,
        contract.identityField,
        sourceHashes,
        identities,
      );
    }
  }
  return {
    schema_version: "workspace-projection-snapshot-v1",
    artifact_kind: "WORKSPACE_PROJECTION_SNAPSHOT",
    synthetic: true,
    source_chain: clone(input.source_chain),
    projections,
  };
}

export function buildProjectionSnapshot(
  input: ProjectionSnapshotInput,
): ProjectionSnapshot {
  const body = snapshotBody(input);
  return deepFreeze({
    ...body,
    snapshot_id: sha256CanonicalJson(body),
  });
}

export function createProjectionSnapshotPaths({
  outputDirectory,
  snapshotId,
}: {
  readonly outputDirectory: string;
  readonly snapshotId: string;
}): ProjectionSnapshotPaths {
  if (
    typeof outputDirectory !== "string"
    || outputDirectory.length === 0
    || !SHA256.test(snapshotId)
  ) {
    throw integrity("projection snapshot 경로 입력이 안전하지 않습니다.");
  }
  const root = resolve(outputDirectory);
  const directory = join(root, snapshotId);
  return Object.freeze({
    outputDirectory: root,
    directory,
    path: join(directory, `workspace-projection--record-${snapshotId}.json`),
  });
}

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function assertSecureDirectory(path: string, location: string): Promise<void> {
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

function wrapperBytes(snapshot: ProjectionSnapshot): Buffer {
  return Buffer.from(`${canonicalJsonStringify({
    payload_sha256: snapshot.snapshot_id,
    payload: snapshot,
  })}\n`, "utf8");
}

async function readExactSnapshot(
  path: string,
  expected: ProjectionSnapshot,
): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== 1
    ) {
      throw integrity("projection snapshot은 nlink1 regular 0600 file이어야 합니다.");
    }
    const actual = await handle.readFile();
    if (!actual.equals(wrapperBytes(expected))) {
      throw integrity("projection snapshot canonical bytes 또는 hash가 다릅니다.");
    }
  } catch (error) {
    if (error instanceof ProjectionRepositoryIntegrityError) throw error;
    throw integrity("projection snapshot을 symlink 없이 읽을 수 없습니다.", error);
  } finally {
    await handle?.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

export async function persistProjectionSnapshot({
  outputDirectory,
  snapshot,
}: {
  readonly outputDirectory: string;
  readonly snapshot: ProjectionSnapshot;
}): Promise<PersistProjectionSnapshotResult> {
  const rebuilt = buildProjectionSnapshot({
    source_chain: snapshot.source_chain,
    ...snapshot.projections,
  });
  if (canonicalJsonStringify(rebuilt) !== canonicalJsonStringify(snapshot)) {
    throw integrity("projection snapshot이 권위 입력에서 재빌드한 내용과 다릅니다.");
  }
  const paths = createProjectionSnapshotPaths({
    outputDirectory,
    snapshotId: snapshot.snapshot_id,
  });
  await assertSecureDirectory(paths.outputDirectory, "projection output root");
  try {
    await mkdir(paths.directory, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) {
      throw integrity("projection snapshot directory를 만들 수 없습니다.", error);
    }
  }
  await assertSecureDirectory(paths.directory, "projection snapshot directory");
  try {
    // EEXIST도 생성 중인 동시 호출일 수 있으므로 모든 사용자가 부모 내구성을
    // 독립적으로 확정한 뒤 snapshot을 게시합니다.
    await syncDirectory(paths.outputDirectory);
  } catch (error) {
    throw integrity(
      "projection snapshot directory 생성을 output root에 동기화할 수 없습니다.",
      error,
    );
  }
  const temporary = join(
    paths.directory,
    `.${basename(paths.path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let temporaryCreated = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(wrapperBytes(snapshot));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, paths.path);
    } catch (error) {
      if (hasCode(error, "EEXIST")) {
        // READY처럼 공개 projection이 바뀌지 않는 phase도 phase receipt에는
        // 별도로 남겨야 합니다. 같은 content-addressed record라면 기존 bytes를
        // 다시 검증해 안전하게 재사용하고, 다른 bytes·tamper는 fail-closed합니다.
        await readExactSnapshot(paths.path, snapshot);
        return Object.freeze({
          ...paths,
          payloadSha256: snapshot.snapshot_id,
        });
      }
      throw error;
    }
    await unlink(temporary);
    temporaryCreated = false;
    await syncDirectory(paths.directory);
    await readExactSnapshot(paths.path, snapshot);
    return Object.freeze({
      ...paths,
      payloadSha256: snapshot.snapshot_id,
    });
  } catch (error) {
    if (error instanceof ProjectionRepositoryIntegrityError) throw error;
    throw integrity("projection snapshot을 atomic write-once 저장할 수 없습니다.", error);
  } finally {
    if (temporaryCreated) {
      try {
        await unlink(temporary);
      } catch {
        // 원래 오류를 보존하며 다음 load에서 남은 hard-link를 fail-closed 합니다.
      }
    }
  }
}

export async function loadProjectionSnapshot({
  path,
  authority,
}: {
  readonly path: string;
  readonly authority: ProjectionSnapshotInput;
}): Promise<ProjectionSnapshot> {
  const rebuilt = buildProjectionSnapshot(authority);
  const outputDirectory = dirname(dirname(resolve(path)));
  const paths = createProjectionSnapshotPaths({
    outputDirectory,
    snapshotId: rebuilt.snapshot_id,
  });
  if (resolve(path) !== resolve(paths.path)) {
    throw integrity("projection snapshot path가 content address와 다릅니다.");
  }
  await assertSecureDirectory(paths.outputDirectory, "projection output root");
  await assertSecureDirectory(paths.directory, "projection snapshot directory");
  await readExactSnapshot(paths.path, rebuilt);
  return rebuilt;
}

/**
 * 이미 source-rebuild 후 write-once 공개된 projection을 읽기 전용으로 다시 엽니다.
 * 이 경계는 upstream 업무 결정을 새로 승인하지 않으며, 반환 gateway도 모든
 * mutation을 거부합니다. Snapshot 내부 source chain·schema·hash와 실제
 * 0700/0600/nlink1 canonical record를 모두 다시 검증합니다.
 */
export async function loadReadOnlyProjectionSnapshotRecord({
  path,
}: {
  readonly path: string;
}): Promise<ProjectionSnapshot> {
  const resolvedPath = resolve(path);
  const outputDirectory = dirname(dirname(resolvedPath));
  await assertSecureDirectory(outputDirectory, "projection output root");
  await assertSecureDirectory(dirname(resolvedPath), "projection snapshot directory");
  let handle;
  let parsed: unknown;
  try {
    handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
      throw integrity("projection snapshot은 nlink1 regular 0600 file이어야 합니다.");
    }
    parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
  } catch (error) {
    if (error instanceof ProjectionRepositoryIntegrityError) throw error;
    throw integrity("read-only projection snapshot을 안전하게 읽을 수 없습니다.", error);
  } finally {
    await handle?.close();
  }
  if (!isPlainRecord(parsed) || Object.keys(parsed).sort().join(",") !== "payload,payload_sha256") {
    throw integrity("projection snapshot wrapper의 exact key 계약이 다릅니다.");
  }
  const payload = parsed.payload;
  if (
    typeof parsed.payload_sha256 !== "string"
    || !SHA256.test(parsed.payload_sha256)
    || !isPlainRecord(payload)
    || !isPlainRecord(payload.projections)
    || !Array.isArray(payload.source_chain)
  ) {
    throw integrity("projection snapshot wrapper의 payload 계약이 다릅니다.");
  }
  const projections = payload.projections;
  const rebuilt = buildProjectionSnapshot({
    source_chain: payload.source_chain as unknown as readonly ProjectionSourceReference[],
    workspace: projections.workspace as PublicProjection,
    challenges: projections.challenges as readonly PublicProjection[],
    evidence: projections.evidence as readonly PublicProjection[],
    benchmark_progress: projections.benchmark_progress as readonly PublicProjection[],
    blind_reviews: projections.blind_reviews as readonly PublicProjection[],
    decisions: projections.decisions as readonly PublicProjection[],
    baselines: projections.baselines as readonly PublicProjection[],
    regressions: projections.regressions as readonly PublicProjection[],
  });
  if (
    parsed.payload_sha256 !== rebuilt.snapshot_id
    || canonicalJsonStringify(payload) !== canonicalJsonStringify(rebuilt)
  ) {
    throw integrity("projection snapshot payload가 canonical source chain rebuild와 다릅니다.");
  }
  const expectedPaths = createProjectionSnapshotPaths({
    outputDirectory,
    snapshotId: rebuilt.snapshot_id,
  });
  if (resolvedPath !== resolve(expectedPaths.path)) {
    throw integrity("projection snapshot path가 payload content address와 다릅니다.");
  }
  await readExactSnapshot(resolvedPath, rebuilt);
  return rebuilt;
}

function readonlyMutation(): Promise<never> {
  return Promise.reject(new ReadOnlyProjectionError());
}

export function createReadOnlyProjectionGateway(
  snapshot: ProjectionSnapshot,
): ChallengeApiGateway {
  const rebuilt = buildProjectionSnapshot({
    source_chain: snapshot.source_chain,
    ...snapshot.projections,
  });
  if (canonicalJsonStringify(rebuilt) !== canonicalJsonStringify(snapshot)) {
    throw integrity("read-only gateway snapshot이 재검증 결과와 다릅니다.");
  }
  const lookup = (
    collection: keyof Omit<ProjectionCollections, "workspace">,
    identityField: string,
    id: string,
  ): PublicProjection | null => (
    snapshot.projections[collection].find((item) => item[identityField] === id)
      ?? null
  );
  const mutation = (_command: ChallengeMutationCommand) => readonlyMutation();
  return Object.freeze({
    getWorkspace: async () => snapshot.projections.workspace,
    getChallenge: async (id: string) => lookup("challenges", "challenge_id", id),
    getEvidence: async (id: string) => lookup("evidence", "evidence_id", id),
    getBenchmarkProgress: async (id: string) => (
      lookup("benchmark_progress", "benchmark_id", id)
    ),
    getBlindReview: async (id: string) => lookup("blind_reviews", "review_id", id),
    getDecision: async (id: string) => lookup("decisions", "decision_id", id),
    getBaseline: async (id: string) => lookup("baselines", "baseline_id", id),
    getRegression: async (id: string) => lookup("regressions", "regression_id", id),
    structureDefine: mutation,
    lockChallenge: mutation,
    startBenchmark: mutation,
    confirmReview: mutation,
    createDecisionMemo: mutation,
    confirmDecision: mutation,
    startRegression: mutation,
  });
}

import type {
  DefineStructuringInput,
  DefineSuggestion,
  LockedChallengePack,
} from "../eval/define/defineContracts";
import {
  assertCanonicalLifecycleDirectory,
  persistCanonicalLifecycleFile,
  readCanonicalLifecycleFile,
} from "../eval/lifecycle/canonicalLifecyclePersistence";
import { SYNTHETIC_CHALLENGE_TEMPLATE } from "../eval/define/syntheticChallengeDefinition";
import {
  buildStableBenchmarkId,
  type StableBenchmarkIdInput,
} from "../eval/benchmark/benchmarkProgressPersistence";
import type { RecordedBenchmarkColdReloadReference } from "../eval/cli/runRecordedBenchmark";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../eval/runtime/canonicalJson";
import { readdir } from "node:fs/promises";
import {
  buildProjectionSnapshot,
  type ProjectionSnapshot,
  type ProjectionSourceReference,
} from "./projectionRepository";
import { basename, dirname, join, resolve } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_BENCHMARK_ID = /^[a-f0-9]{64}$/;
const EXPECTED_CANDIDATE_EXECUTIONS = 72;
const EXPECTED_AUXILIARY_JUDGES = 12;
const EXPECTED_CLEANUP_RESOURCES = 33;

type JsonRecord = Record<string, unknown>;

export type ChallengeLifecyclePhase =
  | "DRAFT"
  | "PROPOSED"
  | "LOCKED"
  | "RUNNING"
  | "COMPLETE"
  | "INVALID";

export interface ChallengeLifecycleDefineArtifact {
  readonly schema_version: "define-structuring-artifact-v1";
  readonly artifact_kind: "DEFINE_STRUCTURING_ARTIFACT";
  readonly synthetic: true;
  readonly authority: "ADVISORY_ONLY";
  readonly lock_authority: "NONE";
  readonly human_approval_status: "REQUIRED";
  readonly define_input: DefineStructuringInput;
  readonly run_record: Readonly<{
    readonly structuringStatus: string;
    readonly suggestion: DefineSuggestion | null;
  } & JsonRecord>;
  readonly artifact_hash: string;
}

export type LifecycleFailurePhase =
  | "DEFINE"
  | "LOCK"
  | "BENCHMARK"
  | "JUDGE"
  | "CLEANUP";

export interface ChallengeLifecycleFailure {
  readonly code: string;
  readonly phase: LifecycleFailurePhase;
}

export type BenchmarkResumeAction =
  | "NONE"
  | "CONTINUE_FROM_PERSISTED_CHECKPOINTS"
  | "RETRY_CLEANUP"
  | "RESTART_AFTER_FIX";

export interface BenchmarkStartCommandReceipt {
  readonly schema_version: "benchmark-start-command-receipt-v1";
  readonly artifact_kind: "BENCHMARK_START_COMMAND_RECEIPT";
  readonly synthetic: true;
  readonly benchmark_id: string;
  readonly challenge_id: string;
  readonly challenge_version: string;
  readonly locked_challenge_pack_hash: string;
  readonly actor_type: "HUMAN";
  readonly actor_label: string;
  readonly execution_mode: "START" | "RESUME";
  readonly acknowledgement:
    "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12";
  readonly resume_from_progress_hash: string | null;
  readonly attempt_number: number;
  readonly previous_start_receipt_hash: string | null;
  readonly started_at: string;
  readonly receipt_hash: string;
}

export interface PersistedBenchmarkProgressRecord {
  readonly schema_version: "benchmark-lifecycle-progress-record-v1";
  readonly artifact_kind: "BENCHMARK_LIFECYCLE_PROGRESS_RECORD";
  readonly synthetic: true;
  readonly source_reloaded: true;
  readonly benchmark_id: string;
  readonly challenge_id: string;
  readonly locked_challenge_pack_hash: string;
  readonly attempt_number: number;
  readonly status: "RUNNING" | "COMPLETE" | "INVALID";
  readonly candidate_execution: {
    readonly completed: number;
    readonly total: 72;
  };
  readonly auxiliary_judge: {
    readonly completed: number;
    readonly total: 12;
  };
  readonly cleanup: {
    readonly required: 33;
    readonly acknowledged: number;
    readonly incomplete: number;
  };
  readonly checkpoint_source:
    | "EXECUTED"
    | "RECOMPUTED_GATES"
    | "REUSED_CHECKPOINT"
    | null;
  readonly resume: {
    readonly allowed: boolean;
    readonly action: BenchmarkResumeAction;
    readonly from_progress_hash: string | null;
  };
  readonly failure: ChallengeLifecycleFailure | null;
  readonly updated_at: string;
  readonly progress_record_hash: string;
}

/**
 * runtime hydration 안에서만 사용하는 private authority 좌표입니다. JSON으로
 * 복원한 lifecycle state 자체는 권한이 아니므로, 재시작 때 이 좌표의 write-once
 * source를 다시 읽어 runtime brand를 복구합니다.
 */
export interface ChallengeLifecycleAuthorityReferences {
  readonly schema_version: "challenge-lifecycle-authority-references-v1";
  readonly define_artifact: Readonly<{
    readonly path: string;
    readonly artifact_hash: string;
  }> | null;
  readonly locked_challenge: Readonly<{
    readonly path: string;
    readonly challenge_id: string;
    readonly challenge_version: string;
    readonly locked_challenge_pack_hash: string;
  }> | null;
  readonly benchmark_start_command: Readonly<{
    readonly path: string;
    readonly receipt_hash: string;
  }> | null;
}

export interface ChallengeLifecycleSourceState {
  readonly phase: ChallengeLifecyclePhase;
  readonly defineInput: DefineStructuringInput;
  readonly defineArtifact: ChallengeLifecycleDefineArtifact | null;
  readonly lockedChallengePack: LockedChallengePack | null;
  readonly benchmarkId: string | null;
  readonly startReceipt: BenchmarkStartCommandReceipt | null;
  readonly progress: PersistedBenchmarkProgressRecord | null;
  readonly failure: ChallengeLifecycleFailure | null;
  /** phase hydration이 cold source reload에 쓰는 private write-once 좌표입니다. */
  readonly lifecycleAuthorityReferences?: ChallengeLifecycleAuthorityReferences;
  /** REVIEW_PENDING 이후 cold restart가 source chain을 재구성할 최소 참조입니다. */
  readonly recordedBenchmarkColdReloadReference?: RecordedBenchmarkColdReloadReference;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function assertSha(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${location}는 lowercase SHA-256이어야 합니다.`);
  }
}

function assertSafeText(value: unknown, location: string): asserts value is string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > 512
    || /\p{Cc}/u.test(value)
    || /sk-[A-Za-z0-9_-]{16,}/.test(value)
  ) {
    fail(`${location}는 credential이 없는 안전한 문자열이어야 합니다.`);
  }
}

function assertTimestamp(value: unknown, location: string): asserts value is string {
  assertSafeText(value, location);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    fail(`${location}는 canonical ISO timestamp여야 합니다.`);
  }
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  location: string,
): asserts value is JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    fail(`${location}은 plain JSON 객체여야 합니다.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join("\0") !== expected.join("\0")) {
    fail(`${location}의 exact 필드 계약이 다릅니다.`);
  }
}

export function deriveStableBenchmarkId(
  input: StableBenchmarkIdInput,
): string {
  return buildStableBenchmarkId(input);
}

export function buildBenchmarkStartCommandReceipt({
  benchmarkId,
  challengeId,
  challengeVersion,
  lockedChallengePackHash,
  actorLabel,
  executionMode,
  resumeFromProgressHash,
  attemptNumber,
  previousStartReceiptHash,
  startedAt,
}: {
  readonly benchmarkId: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly lockedChallengePackHash: string;
  readonly actorLabel: string;
  readonly executionMode: "START" | "RESUME";
  readonly resumeFromProgressHash: string | null;
  readonly attemptNumber: number;
  readonly previousStartReceiptHash: string | null;
  readonly startedAt: string;
}): BenchmarkStartCommandReceipt {
  if (!SAFE_BENCHMARK_ID.test(benchmarkId)) fail("benchmarkId 형식이 다릅니다.");
  assertSafeText(challengeId, "challengeId");
  assertSafeText(challengeVersion, "challengeVersion");
  assertSha(lockedChallengePackHash, "lockedChallengePackHash");
  assertSafeText(actorLabel, "actorLabel");
  assertTimestamp(startedAt, "startedAt");
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
    fail("attemptNumber는 1 이상의 정수여야 합니다.");
  }
  if (
    (executionMode === "START" && (
      attemptNumber !== 1
      || resumeFromProgressHash !== null
      || previousStartReceiptHash !== null
    ))
    || (executionMode === "RESUME" && (
      attemptNumber < 2
      || resumeFromProgressHash === null
      || previousStartReceiptHash === null
    ))
  ) {
    fail("Benchmark START/RESUME source 결합이 다릅니다.");
  }
  if (resumeFromProgressHash !== null) {
    assertSha(resumeFromProgressHash, "resumeFromProgressHash");
  }
  if (previousStartReceiptHash !== null) {
    assertSha(previousStartReceiptHash, "previousStartReceiptHash");
  }
  const body = {
    schema_version: "benchmark-start-command-receipt-v1" as const,
    artifact_kind: "BENCHMARK_START_COMMAND_RECEIPT" as const,
    synthetic: true as const,
    benchmark_id: benchmarkId,
    challenge_id: challengeId,
    challenge_version: challengeVersion,
    locked_challenge_pack_hash: lockedChallengePackHash,
    actor_type: "HUMAN" as const,
    actor_label: actorLabel,
    execution_mode: executionMode,
    acknowledgement:
      "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12" as const,
    resume_from_progress_hash: resumeFromProgressHash,
    attempt_number: attemptNumber,
    previous_start_receipt_hash: previousStartReceiptHash,
    started_at: startedAt,
  };
  return deepFreeze({
    ...body,
    receipt_hash: sha256CanonicalJson(body),
  });
}

interface BenchmarkStartCommandWrapper {
  readonly payload_sha256: string;
  readonly payload: BenchmarkStartCommandReceipt;
}

function startCommandPaths({
  outputDirectory,
  benchmarkId,
  attemptNumber,
  receiptHash,
}: {
  readonly outputDirectory: string;
  readonly benchmarkId: string;
  readonly attemptNumber: number;
  readonly receiptHash: string;
}) {
  if (
    !SAFE_BENCHMARK_ID.test(benchmarkId)
    || !Number.isSafeInteger(attemptNumber)
    || attemptNumber < 1
  ) {
    fail("Benchmark start command persistence 좌표가 다릅니다.");
  }
  assertSha(receiptHash, "receiptHash");
  const rootDirectory = resolve(outputDirectory);
  const artifactDirectory = join(
    rootDirectory,
    `benchmark-start-command-${benchmarkId}`,
  );
  const attempt = String(attemptNumber).padStart(3, "0");
  return {
    rootDirectory,
    artifactDirectory,
    claimPath: join(
      artifactDirectory,
      `benchmark-start-command--attempt-${attempt}--claim.json`,
    ),
    recordPath: join(
      artifactDirectory,
      `benchmark-start-command--attempt-${attempt}`
      + `--record-${receiptHash}.json`,
    ),
  };
}

function startCommandWrapper(
  receipt: BenchmarkStartCommandReceipt,
): BenchmarkStartCommandWrapper {
  return {
    payload_sha256: sha256CanonicalJson(receipt),
    payload: receipt,
  };
}

function parseStartCommandWrapper(
  value: unknown,
  expectedReceipt?: BenchmarkStartCommandReceipt,
): BenchmarkStartCommandReceipt {
  exactKeys(
    value,
    ["payload_sha256", "payload"],
    "Benchmark start command wrapper",
  );
  assertSha(
    value.payload_sha256,
    "Benchmark start command wrapper.payload_sha256",
  );
  if (
    value.payload_sha256 !== sha256CanonicalJson(value.payload)
    || (
      expectedReceipt !== undefined
      && canonicalJsonStringify(value.payload)
        !== canonicalJsonStringify(expectedReceipt)
    )
  ) {
    fail("Benchmark start command wrapper source hash가 다릅니다.");
  }
  // 입력 builder를 다시 통과시켜 exact 상태·hash 결합을 검증합니다.
  const raw = value.payload as BenchmarkStartCommandReceipt;
  const rebuilt = buildBenchmarkStartCommandReceipt({
    benchmarkId: raw.benchmark_id,
    challengeId: raw.challenge_id,
    challengeVersion: raw.challenge_version,
    lockedChallengePackHash: raw.locked_challenge_pack_hash,
    actorLabel: raw.actor_label,
    executionMode: raw.execution_mode,
    resumeFromProgressHash: raw.resume_from_progress_hash,
    attemptNumber: raw.attempt_number,
    previousStartReceiptHash: raw.previous_start_receipt_hash,
    startedAt: raw.started_at,
  });
  if (
    raw.schema_version !== "benchmark-start-command-receipt-v1"
    || raw.artifact_kind !== "BENCHMARK_START_COMMAND_RECEIPT"
    || raw.synthetic !== true
    || raw.actor_type !== "HUMAN"
    || raw.acknowledgement
      !== "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12"
    || canonicalJsonStringify(rebuilt) !== canonicalJsonStringify(raw)
  ) {
    fail("Benchmark start command receipt exact 계약이 다릅니다.");
  }
  return rebuilt;
}

export async function loadBenchmarkStartCommandReceiptByAttemptIfPresent({
  outputDirectory,
  benchmarkId,
  attemptNumber,
}: {
  readonly outputDirectory: string;
  readonly benchmarkId: string;
  readonly attemptNumber: number;
}): Promise<{
  readonly path: string;
  readonly receipt: BenchmarkStartCommandReceipt;
} | null> {
  const coordinates = startCommandPaths({
    outputDirectory,
    benchmarkId,
    attemptNumber,
    receiptHash: "0".repeat(64),
  });
  let entries: readonly string[];
  try {
    entries = await readdir(coordinates.artifactDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const attempt = String(attemptNumber).padStart(3, "0");
  const claimName =
    `benchmark-start-command--attempt-${attempt}--claim.json`;
  const recordPattern = new RegExp(
    `^benchmark-start-command--attempt-${attempt}`
      + "--record-([a-f0-9]{64})\\.json$",
  );
  const records = entries.flatMap((entry) => {
    const match = recordPattern.exec(entry);
    return match === null ? [] : [{ entry, receiptHash: match[1]! }];
  });
  const hasClaim = entries.includes(claimName);
  if (!hasClaim && records.length === 0) return null;
  if (!hasClaim || records.length !== 1) {
    fail("Benchmark start command attempt가 불완전하거나 모호합니다.");
  }
  await assertCanonicalLifecycleDirectory({
    rootDirectory: coordinates.rootDirectory,
    artifactDirectory: coordinates.artifactDirectory,
  });
  const claim = await readCanonicalLifecycleFile({
    path: coordinates.claimPath,
    label: "Benchmark start command claim",
  });
  const recordPath = join(
    coordinates.artifactDirectory,
    records[0]!.entry,
  );
  const record = await readCanonicalLifecycleFile({
    path: recordPath,
    label: "Benchmark start command record",
  });
  if (!claim.bytes.equals(record.bytes)) {
    fail("Benchmark start command claim과 record bytes가 다릅니다.");
  }
  const receipt = parseStartCommandWrapper(record.value);
  const canonical = startCommandPaths({
    outputDirectory,
    benchmarkId,
    attemptNumber,
    receiptHash: receipt.receipt_hash,
  });
  if (
    receipt.benchmark_id !== benchmarkId
    || receipt.attempt_number !== attemptNumber
    || records[0]!.receiptHash !== receipt.receipt_hash
    || resolve(recordPath) !== canonical.recordPath
  ) {
    fail("Benchmark start command attempt의 canonical 좌표가 다릅니다.");
  }
  return Object.freeze({ path: canonical.recordPath, receipt });
}

export async function persistBenchmarkStartCommandReceipt({
  outputDirectory,
  receipt,
}: {
  readonly outputDirectory: string;
  readonly receipt: BenchmarkStartCommandReceipt;
}): Promise<{
  readonly path: string;
  readonly created: boolean;
  readonly receiptHash: string;
}> {
  const parsed = parseStartCommandWrapper(
    startCommandWrapper(receipt),
    receipt,
  );
  const paths = startCommandPaths({
    outputDirectory,
    benchmarkId: parsed.benchmark_id,
    attemptNumber: parsed.attempt_number,
    receiptHash: parsed.receipt_hash,
  });
  const wrapper = startCommandWrapper(parsed);
  await persistCanonicalLifecycleFile({
    rootDirectory: paths.rootDirectory,
    artifactDirectory: paths.artifactDirectory,
    filePath: paths.claimPath,
    value: wrapper,
    label: "Benchmark start command claim",
  });
  const persisted = await persistCanonicalLifecycleFile({
    rootDirectory: paths.rootDirectory,
    artifactDirectory: paths.artifactDirectory,
    filePath: paths.recordPath,
    value: wrapper,
    label: "Benchmark start command record",
  });
  return Object.freeze({
    path: persisted.path,
    created: persisted.created,
    receiptHash: parsed.receipt_hash,
  });
}

export async function loadBenchmarkStartCommandReceipt({
  outputDirectory,
  path,
  expectedReceipt,
}: {
  readonly outputDirectory: string;
  readonly path: string;
  readonly expectedReceipt: BenchmarkStartCommandReceipt;
}): Promise<BenchmarkStartCommandReceipt> {
  const paths = startCommandPaths({
    outputDirectory,
    benchmarkId: expectedReceipt.benchmark_id,
    attemptNumber: expectedReceipt.attempt_number,
    receiptHash: expectedReceipt.receipt_hash,
  });
  if (
    resolve(path) !== paths.recordPath
    || dirname(path) !== paths.artifactDirectory
    || basename(path) !== basename(paths.recordPath)
  ) {
    fail("Benchmark start command record가 canonical authority 좌표 밖입니다.");
  }
  await assertCanonicalLifecycleDirectory(paths);
  const claim = await readCanonicalLifecycleFile({
    path: paths.claimPath,
    label: "Benchmark start command claim",
  });
  const record = await readCanonicalLifecycleFile({
    path: paths.recordPath,
    label: "Benchmark start command record",
  });
  if (!claim.bytes.equals(record.bytes)) {
    fail("Benchmark start command claim과 record bytes가 다릅니다.");
  }
  return parseStartCommandWrapper(record.value, expectedReceipt);
}

function progressBody(input: Omit<
  PersistedBenchmarkProgressRecord,
  "progress_record_hash"
>): Omit<PersistedBenchmarkProgressRecord, "progress_record_hash"> {
  return input;
}

export function buildPersistedBenchmarkProgressRecord({
  benchmarkId,
  challengeId,
  lockedChallengePackHash,
  attemptNumber,
  status,
  candidateExecutionCompleted,
  auxiliaryJudgeCompleted,
  cleanupAcknowledged,
  checkpointSource = null,
  resumeAllowed,
  resumeAction,
  failure,
  updatedAt,
}: {
  readonly benchmarkId: string;
  readonly challengeId: string;
  readonly lockedChallengePackHash: string;
  readonly attemptNumber: number;
  readonly status: PersistedBenchmarkProgressRecord["status"];
  readonly candidateExecutionCompleted: number;
  readonly auxiliaryJudgeCompleted: number;
  readonly cleanupAcknowledged: number;
  readonly checkpointSource?:
    | "EXECUTED"
    | "RECOMPUTED_GATES"
    | "REUSED_CHECKPOINT"
    | null;
  readonly resumeAllowed: boolean;
  readonly resumeAction: BenchmarkResumeAction;
  readonly failure: ChallengeLifecycleFailure | null;
  readonly updatedAt: string;
}): PersistedBenchmarkProgressRecord {
  if (
    !SAFE_BENCHMARK_ID.test(benchmarkId)
  ) fail("progress benchmark identity가 다릅니다.");
  assertSafeText(challengeId, "challengeId");
  assertTimestamp(updatedAt, "updatedAt");
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
    fail("progress attempt_number가 유효하지 않습니다.");
  }
  const counts = [
    [candidateExecutionCompleted, EXPECTED_CANDIDATE_EXECUTIONS, "candidate"],
    [auxiliaryJudgeCompleted, EXPECTED_AUXILIARY_JUDGES, "judge"],
    [cleanupAcknowledged, EXPECTED_CLEANUP_RESOURCES, "cleanup"],
  ] as const;
  for (const [actual, maximum, label] of counts) {
    if (!Number.isSafeInteger(actual) || actual < 0 || actual > maximum) {
      fail(`${label} progress count가 유효하지 않습니다.`);
    }
  }
  if (
    checkpointSource !== null
    && !["EXECUTED", "RECOMPUTED_GATES", "REUSED_CHECKPOINT"]
      .includes(checkpointSource)
  ) fail("checkpoint source가 잠긴 enum과 다릅니다.");
  const complete =
    candidateExecutionCompleted === EXPECTED_CANDIDATE_EXECUTIONS
    && auxiliaryJudgeCompleted === EXPECTED_AUXILIARY_JUDGES
    && cleanupAcknowledged === EXPECTED_CLEANUP_RESOURCES;
  if (status === "COMPLETE" && (!complete || failure !== null)) {
    fail("COMPLETE는 정확히 72+12+cleanup 33/33만 허용합니다.");
  }
  if (status === "INVALID" && failure === null) {
    fail("INVALID progress에는 실패 code와 phase가 필요합니다.");
  }
  if (status !== "INVALID" && failure !== null) {
    fail("RUNNING/COMPLETE progress에는 failure가 없어야 합니다.");
  }
  if (
    (resumeAllowed && (status !== "INVALID" || resumeAction === "NONE"))
    || (!resumeAllowed && resumeAction !== "NONE")
  ) {
    fail("progress resume 허용 여부와 action이 모순됩니다.");
  }
  if (failure !== null) {
    assertSafeText(failure.code, "failure.code");
  }
  const body = progressBody({
    schema_version: "benchmark-lifecycle-progress-record-v1",
    artifact_kind: "BENCHMARK_LIFECYCLE_PROGRESS_RECORD",
    synthetic: true,
    source_reloaded: true,
    benchmark_id: benchmarkId,
    challenge_id: challengeId,
    locked_challenge_pack_hash: lockedChallengePackHash,
    attempt_number: attemptNumber,
    status,
    candidate_execution: {
      completed: candidateExecutionCompleted,
      total: EXPECTED_CANDIDATE_EXECUTIONS,
    },
    auxiliary_judge: {
      completed: auxiliaryJudgeCompleted,
      total: EXPECTED_AUXILIARY_JUDGES,
    },
    cleanup: {
      required: EXPECTED_CLEANUP_RESOURCES,
      acknowledged: cleanupAcknowledged,
      incomplete: EXPECTED_CLEANUP_RESOURCES - cleanupAcknowledged,
    },
    checkpoint_source: checkpointSource,
    resume: {
      allowed: resumeAllowed,
      action: resumeAction,
      from_progress_hash: null,
    },
    failure,
    updated_at: updatedAt,
  });
  return deepFreeze({
    ...body,
    progress_record_hash: sha256CanonicalJson(body),
  });
}

export function parsePersistedBenchmarkProgressRecord(
  value: unknown,
): PersistedBenchmarkProgressRecord {
  exactKeys(value, [
    "schema_version",
    "artifact_kind",
    "synthetic",
    "source_reloaded",
    "benchmark_id",
    "challenge_id",
    "locked_challenge_pack_hash",
    "attempt_number",
    "status",
    "candidate_execution",
    "auxiliary_judge",
    "cleanup",
    "checkpoint_source",
    "resume",
    "failure",
    "updated_at",
    "progress_record_hash",
  ], "Benchmark progress record");
  exactKeys(value.candidate_execution, ["completed", "total"], "candidate_execution");
  exactKeys(value.auxiliary_judge, ["completed", "total"], "auxiliary_judge");
  exactKeys(value.cleanup, ["required", "acknowledged", "incomplete"], "cleanup");
  exactKeys(value.resume, ["allowed", "action", "from_progress_hash"], "resume");
  if (
    value.schema_version !== "benchmark-lifecycle-progress-record-v1"
    || value.artifact_kind !== "BENCHMARK_LIFECYCLE_PROGRESS_RECORD"
    || value.synthetic !== true
    || value.source_reloaded !== true
    || typeof value.benchmark_id !== "string"
    || typeof value.challenge_id !== "string"
    || typeof value.locked_challenge_pack_hash !== "string"
    || typeof value.attempt_number !== "number"
    || !["RUNNING", "COMPLETE", "INVALID"].includes(String(value.status))
    || typeof value.candidate_execution.completed !== "number"
    || value.candidate_execution.total !== EXPECTED_CANDIDATE_EXECUTIONS
    || typeof value.auxiliary_judge.completed !== "number"
    || value.auxiliary_judge.total !== EXPECTED_AUXILIARY_JUDGES
    || value.cleanup.required !== EXPECTED_CLEANUP_RESOURCES
    || typeof value.cleanup.acknowledged !== "number"
    || typeof value.cleanup.incomplete !== "number"
    || value.cleanup.incomplete
      !== EXPECTED_CLEANUP_RESOURCES - value.cleanup.acknowledged
    || !(
      value.checkpoint_source === null
      || ["EXECUTED", "RECOMPUTED_GATES", "REUSED_CHECKPOINT"]
        .includes(String(value.checkpoint_source))
    )
    || typeof value.resume.allowed !== "boolean"
    || !["NONE", "CONTINUE_FROM_PERSISTED_CHECKPOINTS", "RETRY_CLEANUP", "RESTART_AFTER_FIX"]
      .includes(String(value.resume.action))
    || value.resume.from_progress_hash !== null
    || typeof value.updated_at !== "string"
    || typeof value.progress_record_hash !== "string"
  ) {
    fail("Benchmark progress record 구조·count·cleanup 계약이 다릅니다.");
  }
  const rebuilt = buildPersistedBenchmarkProgressRecord({
    benchmarkId: value.benchmark_id,
    challengeId: value.challenge_id,
    lockedChallengePackHash: value.locked_challenge_pack_hash,
    attemptNumber: value.attempt_number,
    status: value.status as PersistedBenchmarkProgressRecord["status"],
    candidateExecutionCompleted: value.candidate_execution.completed,
    auxiliaryJudgeCompleted: value.auxiliary_judge.completed,
    cleanupAcknowledged: value.cleanup.acknowledged,
    checkpointSource: value.checkpoint_source as
      PersistedBenchmarkProgressRecord["checkpoint_source"],
    resumeAllowed: value.resume.allowed,
    resumeAction: value.resume.action as BenchmarkResumeAction,
    failure: value.failure as ChallengeLifecycleFailure | null,
    updatedAt: value.updated_at,
  });
  if (
    canonicalJsonStringify(rebuilt)
      !== canonicalJsonStringify(value)
  ) {
    fail("Benchmark progress record hash 무결성이 다릅니다.");
  }
  return rebuilt;
}

function sourceHashFor(state: ChallengeLifecycleSourceState): string {
  if (state.progress !== null) return state.progress.progress_record_hash;
  if (state.startReceipt !== null) return state.startReceipt.receipt_hash;
  if (state.failure !== null) {
    return sha256CanonicalJson({
      schema_version: "challenge-lifecycle-failure-source-v1",
      challenge_id:
        SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract.challenge_id,
      phase: state.phase,
      failure: state.failure,
      define_artifact_hash: state.defineArtifact?.artifact_hash ?? null,
      locked_challenge_pack_hash:
        state.lockedChallengePack?.locked_challenge_pack_hash ?? null,
    });
  }
  if (state.lockedChallengePack !== null) {
    return state.lockedChallengePack.locked_challenge_pack_hash;
  }
  if (state.defineArtifact !== null) return state.defineArtifact.artifact_hash;
  return sha256CanonicalJson({
    schema_version: "challenge-lifecycle-draft-source-v1",
    define_input: state.defineInput,
  });
}

function sourceChainFor(
  state: ChallengeLifecycleSourceState,
  publicProgressSource?: Readonly<{
    readonly artifactKind: string;
    readonly sourceHash: string;
  }>,
  runtimePhase?: string,
): readonly ProjectionSourceReference[] {
  const sources: ProjectionSourceReference[] = [{
    artifact_kind: "CHALLENGE_LIFECYCLE_DRAFT",
    artifact_id: SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract.challenge_id,
    payload_sha256: sha256CanonicalJson({
      schema_version: "challenge-lifecycle-draft-source-v1",
      define_input: state.defineInput,
    }),
  }];
  if (state.defineArtifact !== null) {
    sources.push({
      artifact_kind: state.defineArtifact.artifact_kind,
      artifact_id: `define_${state.defineArtifact.artifact_hash.slice(0, 24)}`,
      payload_sha256: state.defineArtifact.artifact_hash,
    });
  }
  if (state.lockedChallengePack !== null) {
    sources.push({
      artifact_kind: state.lockedChallengePack.artifact_kind,
      artifact_id: state.lockedChallengePack.challenge_id,
      payload_sha256: state.lockedChallengePack.locked_challenge_pack_hash,
    });
  }
  if (state.startReceipt !== null) {
    sources.push({
      artifact_kind: state.startReceipt.artifact_kind,
      artifact_id: `start_${state.startReceipt.receipt_hash.slice(0, 24)}`,
      payload_sha256: state.startReceipt.receipt_hash,
    });
  }
  if (state.failure !== null && state.progress === null) {
    const failureHash = sha256CanonicalJson({
      schema_version: "challenge-lifecycle-failure-source-v1",
      challenge_id:
        SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract.challenge_id,
      phase: state.phase,
      failure: state.failure,
      define_artifact_hash: state.defineArtifact?.artifact_hash ?? null,
      locked_challenge_pack_hash:
        state.lockedChallengePack?.locked_challenge_pack_hash ?? null,
    });
    sources.push({
      artifact_kind: "CHALLENGE_LIFECYCLE_FAILURE",
      artifact_id: `failure_${failureHash.slice(0, 24)}`,
      payload_sha256: failureHash,
    });
  }
  if (state.progress !== null) {
    sources.push({
      artifact_kind: state.progress.artifact_kind,
      artifact_id: `progress_${state.progress.progress_record_hash.slice(0, 24)}`,
      payload_sha256: state.progress.progress_record_hash,
    });
  }
  if (publicProgressSource !== undefined) {
    sources.push({
      artifact_kind: publicProgressSource.artifactKind,
      artifact_id: `public_${publicProgressSource.sourceHash.slice(0, 24)}`,
      payload_sha256: publicProgressSource.sourceHash,
    });
  }
  if (runtimePhase !== undefined) {
    sources.push({
      artifact_kind: "AUTHORITATIVE_RUNTIME_PHASE",
      artifact_id: runtimePhase,
      payload_sha256: sha256CanonicalJson({
        schema_version: "authoritative-runtime-phase-projection-source-v1",
        phase: runtimePhase,
        lifecycle_source_hash: sourceHashFor(state),
      }),
    });
  }
  return sources;
}

function buildLifecycleProgressPublicProjection(
  state: ChallengeLifecycleSourceState,
  benchmarkId: string,
): Readonly<JsonRecord> {
  const completed = state.progress?.candidate_execution.completed ?? 0;
  const lastSlotSequence = completed === 0 ? null : completed;
  const checkpointSource = state.progress?.checkpoint_source ?? null;
  if (state.phase === "INVALID") {
    const failure = state.progress?.failure ?? state.failure;
    if (failure === null) fail("INVALID public progress에는 failure가 필요합니다.");
    const action = state.progress?.resume.action ?? "RESTART_AFTER_FIX";
    if (action === "NONE") fail("INVALID public progress에는 resume action이 필요합니다.");
    const body = {
      schema_version: "benchmark-lifecycle-invalid-projection-v1",
      synthetic: true,
      source: "RECORDED_BENCHMARK",
      benchmark_id: benchmarkId,
      status: "INVALID",
      completed,
      total: 72,
      last_slot_sequence: lastSlotSequence,
      checkpoint_source: checkpointSource,
      cleanup: state.progress?.cleanup ?? null,
      failure: structuredClone(failure),
      resume: {
        allowed: true,
        action,
      },
    };
    return deepFreeze({
      ...body,
      source_hash: sha256CanonicalJson(body),
    });
  }
  if (state.phase === "LOCKED") {
    const body = {
      schema_version: "benchmark-lifecycle-ready-projection-v1",
      synthetic: true,
      source: "RECORDED_BENCHMARK",
      benchmark_id: benchmarkId,
      status: "READY",
      completed: 0,
      total: 72,
      last_slot_sequence: null,
      checkpoint_source: null,
      cleanup: null,
    };
    return deepFreeze({
      ...body,
      source_hash: sha256CanonicalJson(body),
    });
  }
  const body = {
    schema_version: "benchmark-lifecycle-projection-v1",
    synthetic: true,
    source: "RECORDED_BENCHMARK",
    benchmark_id: benchmarkId,
    status: state.phase === "COMPLETE" ? "COMPLETE" : "RUNNING",
    completed,
    total: 72,
    last_slot_sequence: lastSlotSequence,
    checkpoint_source: checkpointSource,
    cleanup: state.phase === "COMPLETE"
      ? state.progress?.cleanup ?? null
      : null,
  };
  return deepFreeze({
    ...body,
    source_hash: sha256CanonicalJson(body),
  });
}

export function buildChallengeLifecycleProjectionSnapshot(
  state: ChallengeLifecycleSourceState,
  options: Readonly<{ runtimePhase?: string }> = {},
): ProjectionSnapshot {
  const contract = SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract;
  const sourceHash = sourceHashFor(state);
  const suggestion = state.defineArtifact?.run_record.suggestion ?? null;
  const challengeState = state.lockedChallengePack === null
    ? state.defineArtifact === null ? "DRAFT" : "PROPOSED"
    : "LOCKED";
  const defineStatus = state.phase === "INVALID"
    && state.lockedChallengePack === null
    ? "INVALID"
    : challengeState === "DRAFT"
      ? "NOT_STARTED"
      : challengeState === "PROPOSED"
        ? "SUGGESTION_READY"
        : "SUGGESTION_READY";
  const challenge = {
    schema_version: "challenge-public-projection-v1",
    synthetic: true,
    challenge_id: contract.challenge_id,
    challenge_version: contract.challenge_version,
    source_hash: challengeState === "LOCKED"
      ? state.lockedChallengePack!.locked_challenge_pack_hash
      : sourceHash,
    state: challengeState,
    authority: challengeState === "LOCKED"
      ? "EXPLICIT_HUMAN_APPROVAL"
      : challengeState === "PROPOSED" ? "ADVISORY_ONLY" : "NONE",
    title: state.defineInput.business_brief.title,
    business_brief: structuredClone(state.defineInput.business_brief),
    ...(challengeState === "LOCKED"
      ? {
          locked_at: state.lockedChallengePack!.locked_at,
          approved_by: state.lockedChallengePack!.approved_by,
          task_contract: structuredClone(
            state.lockedChallengePack!.approved_contract.task_contract,
          ),
          evaluation_criteria: structuredClone(
            state.lockedChallengePack!.approved_contract.evaluation_criteria,
          ),
          hard_gates: structuredClone(
            state.lockedChallengePack!.approved_contract.hard_gates,
          ),
          candidate_complexity_profiles: structuredClone(
            state.lockedChallengePack!.approved_contract
              .candidate_complexity_profiles,
          ),
          sufficiency: structuredClone(
            state.lockedChallengePack!.approved_contract.sufficiency,
          ),
          source_manifest_hash:
            state.lockedChallengePack!.source_manifest_hash,
        }
      : {}),
    constraints: structuredClone(state.defineInput.constraints),
    prohibited_actions: structuredClone(state.defineInput.prohibited_actions),
    source_manifest: structuredClone(state.defineInput.source_manifest),
    define_status: defineStatus,
    suggestion_summary: suggestion === null
      ? null
      : {
        artifact_hash: state.defineArtifact!.artifact_hash,
        ...structuredClone(suggestion),
      },
    approved_contract_hash: challengeState === "DRAFT"
      ? null
      : challengeState === "LOCKED"
        ? state.lockedChallengePack!.approved_contract_hash
        : sha256CanonicalJson(contract),
  };

  const benchmarkId = state.lockedChallengePack === null
    ? null
    : state.benchmarkId;
  if (
    state.lockedChallengePack !== null
    && (benchmarkId === null || !SAFE_BENCHMARK_ID.test(benchmarkId))
  ) {
    fail("LOCKED lifecycle에는 canonical stable benchmark ID가 필요합니다.");
  }
  const progressProjection = benchmarkId === null
    ? null
    : buildLifecycleProgressPublicProjection(state, benchmarkId);
  const compareStatus = progressProjection === null
    ? "NOT READY"
    : progressProjection.status;
  const workspace = {
    schema_version: "workspace-public-projection-v1",
    synthetic: true,
    challenge_id: contract.challenge_id,
    benchmark_id: benchmarkId,
    review_id: null,
    decision_id: null,
    baseline_id: null,
    regression_id: null,
    source_hash: progressProjection?.source_hash ?? sourceHash,
    stage_statuses: {
      define: state.phase === "INVALID"
        && state.lockedChallengePack === null
        ? "INVALID"
        : challengeState,
      compare: compareStatus,
      decide: "NOT READY",
      monitor: "NO BASELINE",
    },
  };
  return buildProjectionSnapshot({
    source_chain: sourceChainFor(
      state,
      progressProjection === null
        ? undefined
        : {
          artifactKind: String(progressProjection.schema_version)
            .replace(/-projection-v1$/, "")
            .replaceAll("-", "_")
            .toUpperCase(),
          sourceHash: progressProjection.source_hash as string,
        },
      options.runtimePhase,
    ),
    workspace,
    challenges: [challenge],
    evidence: [],
    benchmark_progress:
      progressProjection === null ? [] : [progressProjection],
    blind_reviews: [],
    decisions: [],
    baselines: [],
    regressions: [],
  });
}

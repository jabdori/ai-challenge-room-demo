import { lstat, readdir } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { CleanupReceipt } from "../cli/cleanupReceipt";
import {
  assertCanonicalLifecycleDirectory,
  persistCanonicalLifecycleFile,
  readCanonicalLifecycleFile,
} from "../lifecycle/canonicalLifecyclePersistence";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import { assertNoPotentialSecret } from "../runtime/secretSafety";
import {
  assertPersistedRecordedBenchmarkPack,
  type RecordedBenchmarkPack,
} from "../pack/recordedBenchmarkPack";
import type {
  BenchmarkProgressEvent as RunnerBenchmarkProgressEvent,
  BenchmarkTerminalSlotSummary,
} from "./executeBenchmark";
import {
  assertVerifiedBenchmarkProgressEvent,
} from "./executeBenchmark";
import {
  assertAuthoritativeBenchmarkResourceLeaseTerminal,
  type BenchmarkResourceLeaseFinalizationArtifacts,
  type BenchmarkResourceLeaseTerminalAuthority,
} from "./resourceLease";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SLOT_ID_PATTERN = /^H-\d{3}--[ABC]--r[12]$/;
const START_CLAIM_FILENAME = "benchmark-start--claim.json";
const START_RECORD_PATTERN =
  /^benchmark-start--record-([a-f0-9]{64})\.json$/;
const EVENT_CLAIM_PATTERN =
  /^benchmark-progress--event-(\d{3})--claim\.json$/;
const EVENT_RECORD_PATTERN =
  /^benchmark-progress--event-(\d{3})--record-([a-f0-9]{64})\.json$/;
const COMPLETION_CLAIM_FILENAME = "benchmark-completion--claim.json";
const COMPLETION_RECORD_PATTERN =
  /^benchmark-completion--record-([a-f0-9]{64})\.json$/;
const CLEANUP_RECEIPT_PATTERN =
  /^cleanup-receipt--([a-f0-9]{64})\.json$/;

type JsonRecord = Record<string, unknown>;

export interface StableBenchmarkIdInput {
  readonly lockedChallengePackHash: string;
  readonly hiddenDatasetHash: string;
  readonly scheduleId: string;
}

interface StableBenchmarkIdentity {
  readonly schema_version: "stable-benchmark-id-v1";
  readonly locked_challenge_pack_hash: string;
  readonly hidden_dataset_hash: string;
  readonly schedule_id: string;
}

export interface BenchmarkStartReceipt {
  readonly schema_version: "benchmark-start-receipt-v1";
  readonly artifact_kind: "BENCHMARK_START_RECEIPT";
  readonly synthetic: true;
  readonly source: "RECORDED_BENCHMARK";
  readonly status: "RUNNING";
  readonly benchmark_id: string;
  readonly stable_identity: StableBenchmarkIdentity;
  readonly completed_checkpoints: 0;
  readonly total_checkpoints: 72;
  readonly start_receipt_hash: string;
}

interface BenchmarkStartReceiptPayload
  extends Omit<BenchmarkStartReceipt, "start_receipt_hash"> {}

export type BenchmarkCheckpointSource =
  | "EXECUTED"
  | "RECOMPUTED_GATES"
  | "REUSED_CHECKPOINT";

interface PersistedBenchmarkSlotSummary {
  readonly slot_id: string;
  readonly sequence: number;
  readonly case_id: string;
  readonly candidate_id: "A" | "B" | "C";
  readonly repetition: 1 | 2;
  readonly checkpoint_payload_sha256: string;
  readonly terminal: BenchmarkTerminalSlotSummary;
}

export interface BenchmarkCleanupCount {
  readonly required: number;
  readonly acknowledged: number;
  readonly incomplete: number;
}

export interface BenchmarkProgressEvent {
  readonly schema_version: "benchmark-progress-event-v1";
  readonly artifact_kind: "BENCHMARK_PROGRESS_EVENT";
  readonly synthetic: true;
  readonly source: "RECORDED_BENCHMARK";
  readonly benchmark_id: string;
  readonly event_sequence: number;
  readonly event_type: "SLOT_CHECKPOINTED";
  readonly completed_checkpoints: number;
  readonly total_checkpoints: 72;
  readonly previous_event_hash: string;
  readonly checkpoint_source: BenchmarkCheckpointSource;
  readonly slot_summary: PersistedBenchmarkSlotSummary;
  readonly event_hash: string;
}

interface BenchmarkProgressEventPayload
  extends Omit<BenchmarkProgressEvent, "event_hash"> {}

interface CanonicalWrapper<T> {
  readonly payload_sha256: string;
  readonly payload: T;
}

export interface BenchmarkLifecycleProjection {
  readonly schema_version: "benchmark-lifecycle-projection-v1";
  readonly synthetic: true;
  readonly source: "RECORDED_BENCHMARK";
  readonly benchmark_id: string;
  readonly status: "RUNNING" | "COMPLETE";
  readonly completed: number;
  readonly total: 72;
  readonly last_slot_sequence: number | null;
  readonly checkpoint_source: BenchmarkCheckpointSource | null;
  readonly cleanup: BenchmarkCleanupCount | null;
  readonly source_hash: string;
}

export interface BenchmarkProgressChain {
  readonly start_receipt: BenchmarkStartReceipt;
  readonly events: readonly BenchmarkProgressEvent[];
  readonly completion_receipt: BenchmarkCompletionReceipt | null;
}

export interface BenchmarkProgressCoordinates
  extends StableBenchmarkIdInput {
  readonly outputDirectory: string;
}

export interface BenchmarkCompletionInput {
  readonly cleanupReceiptPath: string;
  readonly recordedBenchmarkPackPath: string;
  readonly recordedBenchmarkPack: RecordedBenchmarkPack;
  readonly resourceLeaseTerminal: BenchmarkResourceLeaseTerminalAuthority;
  readonly finalizationArtifacts: BenchmarkResourceLeaseFinalizationArtifacts;
}

export interface BenchmarkCompletionReceipt {
  readonly schema_version: "benchmark-completion-receipt-v1";
  readonly artifact_kind: "BENCHMARK_COMPLETION_RECEIPT";
  readonly synthetic: true;
  readonly source: "RECORDED_BENCHMARK";
  readonly status: "COMPLETE";
  readonly benchmark_id: string;
  readonly completed_checkpoints: 72;
  readonly total_checkpoints: 72;
  readonly previous_event_hash: string;
  readonly cleanup: BenchmarkCleanupCount;
  readonly cleanup_receipt_hash: string;
  readonly recorded_benchmark_pack_hash: string;
  readonly resource_lease_terminal_hash: string;
  readonly completion_receipt_hash: string;
}

interface BenchmarkCompletionReceiptPayload
  extends Omit<BenchmarkCompletionReceipt, "completion_receipt_hash"> {}

export interface BenchmarkProgressJournal {
  readonly benchmarkId: string;
  readonly startReceipt: BenchmarkStartReceipt;
  readonly startPath: string;
  currentProjection(): BenchmarkLifecycleProjection;
  recordCheckpoint(
    progress: RunnerBenchmarkProgressEvent,
  ): Promise<BenchmarkLifecycleProjection>;
  complete(
    input: BenchmarkCompletionInput,
  ): Promise<BenchmarkLifecycleProjection>;
  verifySource(): Promise<BenchmarkProgressChain>;
}

interface LifecyclePaths {
  readonly rootDirectory: string;
  readonly artifactDirectory: string;
  readonly startClaimPath: string;
  readonly startRecordPath: string;
}

interface SourceState {
  readonly chain: BenchmarkProgressChain;
  readonly headHash: string;
  readonly slotCount: number;
  readonly eventCount: number;
  readonly completion: BenchmarkCompletionReceipt | null;
}

function integrity(message: string, cause?: unknown): TypeError {
  return new TypeError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function errorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw integrity(`${label}은 plain JSON 객체여야 합니다.`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw integrity(`${label}의 exact key 계약이 다릅니다.`);
  }
}

function assertSha256(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw integrity(`${label}는 lowercase SHA-256이어야 합니다.`);
  }
}

function assertSafeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): asserts value is number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) {
    throw integrity(
      `${label}는 ${minimum} 이상 ${maximum} 이하의 안전한 정수여야 합니다.`,
    );
  }
}

function assertFiniteNonNegative(
  value: unknown,
  label: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw integrity(`${label}는 0 이상의 유한한 숫자여야 합니다.`);
  }
}

function stableIdentity(
  input: StableBenchmarkIdInput,
): StableBenchmarkIdentity {
  assertSha256(
    input.lockedChallengePackHash,
    "lockedChallengePackHash",
  );
  assertSha256(input.hiddenDatasetHash, "hiddenDatasetHash");
  assertSha256(input.scheduleId, "scheduleId");
  return {
    schema_version: "stable-benchmark-id-v1",
    locked_challenge_pack_hash: input.lockedChallengePackHash,
    hidden_dataset_hash: input.hiddenDatasetHash,
    schedule_id: input.scheduleId,
  };
}

/**
 * 이 ID는 한 번 잠근 Challenge·숨은 dataset·schedule 캠페인의 ID입니다.
 * 원격 Vector Store와 execution hash는 실행마다 바뀌므로 의도적으로 제외합니다.
 */
export function buildStableBenchmarkId(
  input: StableBenchmarkIdInput,
): string {
  return sha256CanonicalJson(stableIdentity(input));
}

function buildStartReceipt(
  input: StableBenchmarkIdInput,
): BenchmarkStartReceipt {
  const identity = stableIdentity(input);
  const payload: BenchmarkStartReceiptPayload = {
    schema_version: "benchmark-start-receipt-v1",
    artifact_kind: "BENCHMARK_START_RECEIPT",
    synthetic: true,
    source: "RECORDED_BENCHMARK",
    status: "RUNNING",
    benchmark_id: sha256CanonicalJson(identity),
    stable_identity: identity,
    completed_checkpoints: 0,
    total_checkpoints: 72,
  };
  return deepFreeze({
    ...payload,
    start_receipt_hash: sha256CanonicalJson(payload),
  });
}

function parseStableIdentity(value: unknown): StableBenchmarkIdentity {
  const identity = record(value, "stable benchmark identity");
  exactKeys(identity, [
    "schema_version",
    "locked_challenge_pack_hash",
    "hidden_dataset_hash",
    "schedule_id",
  ], "stable benchmark identity");
  if (identity.schema_version !== "stable-benchmark-id-v1") {
    throw integrity("stable benchmark identity version이 다릅니다.");
  }
  assertSha256(
    identity.locked_challenge_pack_hash,
    "stable identity.locked_challenge_pack_hash",
  );
  assertSha256(
    identity.hidden_dataset_hash,
    "stable identity.hidden_dataset_hash",
  );
  assertSha256(identity.schedule_id, "stable identity.schedule_id");
  return deepFreeze({
    schema_version: "stable-benchmark-id-v1",
    locked_challenge_pack_hash: identity.locked_challenge_pack_hash,
    hidden_dataset_hash: identity.hidden_dataset_hash,
    schedule_id: identity.schedule_id,
  });
}

function parseStartReceipt(
  value: unknown,
  expected: StableBenchmarkIdentity,
): BenchmarkStartReceipt {
  const receipt = record(value, "Benchmark start receipt");
  exactKeys(receipt, [
    "schema_version",
    "artifact_kind",
    "synthetic",
    "source",
    "status",
    "benchmark_id",
    "stable_identity",
    "completed_checkpoints",
    "total_checkpoints",
    "start_receipt_hash",
  ], "Benchmark start receipt");
  if (
    receipt.schema_version !== "benchmark-start-receipt-v1"
    || receipt.artifact_kind !== "BENCHMARK_START_RECEIPT"
    || receipt.synthetic !== true
    || receipt.source !== "RECORDED_BENCHMARK"
    || receipt.status !== "RUNNING"
    || receipt.completed_checkpoints !== 0
    || receipt.total_checkpoints !== 72
  ) {
    throw integrity("Benchmark start receipt 상태 계약이 다릅니다.");
  }
  assertSha256(receipt.benchmark_id, "Benchmark start receipt.benchmark_id");
  assertSha256(
    receipt.start_receipt_hash,
    "Benchmark start receipt.start_receipt_hash",
  );
  const identity = parseStableIdentity(receipt.stable_identity);
  if (
    canonicalJsonStringify(identity) !== canonicalJsonStringify(expected)
    || receipt.benchmark_id !== sha256CanonicalJson(identity)
  ) {
    throw integrity("Benchmark start receipt stable identity binding이 다릅니다.");
  }
  const payload: BenchmarkStartReceiptPayload = {
    schema_version: "benchmark-start-receipt-v1",
    artifact_kind: "BENCHMARK_START_RECEIPT",
    synthetic: true,
    source: "RECORDED_BENCHMARK",
    status: "RUNNING",
    benchmark_id: receipt.benchmark_id,
    stable_identity: identity,
    completed_checkpoints: 0,
    total_checkpoints: 72,
  };
  if (sha256CanonicalJson(payload) !== receipt.start_receipt_hash) {
    throw integrity("Benchmark start receipt content hash가 다릅니다.");
  }
  const parsed = {
    ...payload,
    start_receipt_hash: receipt.start_receipt_hash,
  };
  assertNoPotentialSecret(parsed, "Benchmark start receipt");
  return deepFreeze(parsed);
}

function parseTerminalSummary(
  value: unknown,
): BenchmarkTerminalSlotSummary {
  const summary = record(value, "terminal slot summary");
  exactKeys(summary, [
    "execution_status",
    "evaluation_status",
    "hard_gate_status",
    "cost_state",
    "cost_usd",
    "latency_ms",
  ], "terminal slot summary");
  if (![
    "COMPLETE",
    "INVALID",
    "TIMEOUT",
    "BUDGET_EXCEEDED",
    "FAILED",
  ].includes(summary.execution_status as string)) {
    throw integrity("terminal slot execution status가 다릅니다.");
  }
  if (![
    "EVALUATED",
    "NOT_EVALUATED",
    "EVALUATION_INCOMPLETE",
  ].includes(summary.evaluation_status as string)) {
    throw integrity("terminal slot evaluation status가 다릅니다.");
  }
  if (![
    "PASS",
    "CONFIRMED_FAIL",
    "NOT_EVALUATED",
    "EVALUATION_INCOMPLETE",
  ].includes(summary.hard_gate_status as string)) {
    throw integrity("terminal slot hard-gate status가 다릅니다.");
  }
  if (
    summary.cost_state !== "COMPLETE"
    && summary.cost_state !== "COST_INCOMPLETE"
  ) {
    throw integrity("terminal slot cost state가 다릅니다.");
  }
  if (summary.cost_usd !== null) {
    assertFiniteNonNegative(summary.cost_usd, "terminal slot cost_usd");
  }
  if (
    (summary.cost_state === "COMPLETE") !== (summary.cost_usd !== null)
  ) {
    throw integrity("terminal slot 비용 상태와 cost_usd가 다릅니다.");
  }
  assertFiniteNonNegative(summary.latency_ms, "terminal slot latency_ms");
  return deepFreeze({
    execution_status:
      summary.execution_status as BenchmarkTerminalSlotSummary["execution_status"],
    evaluation_status:
      summary.evaluation_status as BenchmarkTerminalSlotSummary["evaluation_status"],
    hard_gate_status:
      summary.hard_gate_status as BenchmarkTerminalSlotSummary["hard_gate_status"],
    cost_state:
      summary.cost_state as BenchmarkTerminalSlotSummary["cost_state"],
    cost_usd: summary.cost_usd as number | null,
    latency_ms: summary.latency_ms,
  });
}

function parseSlotSummary(
  value: unknown,
  expectedCompleted: number,
): PersistedBenchmarkSlotSummary {
  const summary = record(value, "Benchmark slot progress summary");
  exactKeys(summary, [
    "slot_id",
    "sequence",
    "case_id",
    "candidate_id",
    "repetition",
    "checkpoint_payload_sha256",
    "terminal",
  ], "Benchmark slot progress summary");
  if (
    typeof summary.slot_id !== "string"
    || !SLOT_ID_PATTERN.test(summary.slot_id)
    || typeof summary.case_id !== "string"
    || !/^H-\d{3}$/.test(summary.case_id)
    || (
      summary.candidate_id !== "A"
      && summary.candidate_id !== "B"
      && summary.candidate_id !== "C"
    )
    || (summary.repetition !== 1 && summary.repetition !== 2)
  ) {
    throw integrity("Benchmark slot progress identity가 다릅니다.");
  }
  assertSafeInteger(summary.sequence, 1, 72, "slot summary.sequence");
  if (
    summary.sequence !== expectedCompleted
    || summary.slot_id
      !== `${summary.case_id}--${summary.candidate_id}--r${summary.repetition}`
  ) {
    throw integrity("Benchmark slot progress sequence·slot binding이 다릅니다.");
  }
  assertSha256(
    summary.checkpoint_payload_sha256,
    "slot summary.checkpoint_payload_sha256",
  );
  return deepFreeze({
    slot_id: summary.slot_id,
    sequence: summary.sequence,
    case_id: summary.case_id,
    candidate_id: summary.candidate_id,
    repetition: summary.repetition,
    checkpoint_payload_sha256: summary.checkpoint_payload_sha256,
    terminal: parseTerminalSummary(summary.terminal),
  });
}

function parseCleanup(value: unknown): BenchmarkCleanupCount {
  const cleanup = record(value, "Benchmark cleanup count");
  exactKeys(
    cleanup,
    ["required", "acknowledged", "incomplete"],
    "Benchmark cleanup count",
  );
  assertSafeInteger(cleanup.required, 0, 33, "cleanup.required");
  assertSafeInteger(cleanup.acknowledged, 0, 33, "cleanup.acknowledged");
  assertSafeInteger(cleanup.incomplete, 0, 33, "cleanup.incomplete");
  if (
    cleanup.acknowledged + cleanup.incomplete !== cleanup.required
  ) {
    throw integrity("cleanup acknowledged+incomplete 합계가 required와 다릅니다.");
  }
  return deepFreeze({
    required: cleanup.required,
    acknowledged: cleanup.acknowledged,
    incomplete: cleanup.incomplete,
  });
}

function parseEvent(
  value: unknown,
  benchmarkId: string,
): BenchmarkProgressEvent {
  const event = record(value, "Benchmark progress event");
  exactKeys(event, [
    "schema_version",
    "artifact_kind",
    "synthetic",
    "source",
    "benchmark_id",
    "event_sequence",
    "event_type",
    "completed_checkpoints",
    "total_checkpoints",
    "previous_event_hash",
    "checkpoint_source",
    "slot_summary",
    "event_hash",
  ], "Benchmark progress event");
  if (
    event.schema_version !== "benchmark-progress-event-v1"
    || event.artifact_kind !== "BENCHMARK_PROGRESS_EVENT"
    || event.synthetic !== true
    || event.source !== "RECORDED_BENCHMARK"
    || event.benchmark_id !== benchmarkId
    || event.event_type !== "SLOT_CHECKPOINTED"
    || event.total_checkpoints !== 72
  ) {
    throw integrity("Benchmark progress event 상태 계약이 다릅니다.");
  }
  assertSafeInteger(event.event_sequence, 1, 72, "event_sequence");
  assertSafeInteger(
    event.completed_checkpoints,
    0,
    72,
    "completed_checkpoints",
  );
  assertSha256(event.previous_event_hash, "previous_event_hash");
  assertSha256(event.event_hash, "event_hash");
  if (
    event.event_sequence !== event.completed_checkpoints
    || ![
      "EXECUTED",
      "RECOMPUTED_GATES",
      "REUSED_CHECKPOINT",
    ].includes(event.checkpoint_source as string)
  ) {
    throw integrity("slot progress event count·payload 계약이 다릅니다.");
  }
  const checkpointSource =
    event.checkpoint_source as BenchmarkCheckpointSource;
  const slotSummary = parseSlotSummary(
    event.slot_summary,
    event.completed_checkpoints,
  );
  const payload: BenchmarkProgressEventPayload = {
    schema_version: "benchmark-progress-event-v1",
    artifact_kind: "BENCHMARK_PROGRESS_EVENT",
    synthetic: true,
    source: "RECORDED_BENCHMARK",
    benchmark_id: benchmarkId,
    event_sequence: event.event_sequence,
    event_type: event.event_type,
    completed_checkpoints: event.completed_checkpoints,
    total_checkpoints: 72,
    previous_event_hash: event.previous_event_hash,
    checkpoint_source: checkpointSource,
    slot_summary: slotSummary,
  };
  if (sha256CanonicalJson(payload) !== event.event_hash) {
    throw integrity("Benchmark progress event content hash가 다릅니다.");
  }
  const parsed = {
    ...payload,
    event_hash: event.event_hash,
  };
  assertNoPotentialSecret(parsed, "Benchmark progress event");
  return deepFreeze(parsed);
}

function wrapper<T>(payload: T): CanonicalWrapper<T> {
  return {
    payload_sha256: sha256CanonicalJson(payload),
    payload,
  };
}

function parseWrapper(value: unknown, label: string): unknown {
  const parsed = record(value, `${label} wrapper`);
  exactKeys(parsed, ["payload_sha256", "payload"], `${label} wrapper`);
  assertSha256(parsed.payload_sha256, `${label} wrapper.payload_sha256`);
  if (sha256CanonicalJson(parsed.payload) !== parsed.payload_sha256) {
    throw integrity(`${label} wrapper hash 무결성이 다릅니다.`);
  }
  return parsed.payload;
}

function pathsFor(
  input: BenchmarkProgressCoordinates,
  startReceipt: BenchmarkStartReceipt,
): LifecyclePaths {
  const rootDirectory = resolve(input.outputDirectory);
  const artifactDirectory = join(
    rootDirectory,
    `benchmark-progress-${startReceipt.benchmark_id}`,
  );
  return {
    rootDirectory,
    artifactDirectory,
    startClaimPath: join(artifactDirectory, START_CLAIM_FILENAME),
    startRecordPath: join(
      artifactDirectory,
      `benchmark-start--record-${startReceipt.start_receipt_hash}.json`,
    ),
  };
}

function eventNames(
  artifactDirectory: string,
  event: BenchmarkProgressEvent,
) {
  const sequence = String(event.event_sequence).padStart(3, "0");
  return {
    claimPath: join(
      artifactDirectory,
      `benchmark-progress--event-${sequence}--claim.json`,
    ),
    recordPath: join(
      artifactDirectory,
      `benchmark-progress--event-${sequence}--record-${event.event_hash}.json`,
    ),
  };
}

function completionNames(
  artifactDirectory: string,
  completion: BenchmarkCompletionReceipt,
) {
  return {
    claimPath: join(artifactDirectory, COMPLETION_CLAIM_FILENAME),
    recordPath: join(
      artifactDirectory,
      `benchmark-completion--record-${completion.completion_receipt_hash}.json`,
    ),
  };
}

async function persistPair({
  paths,
  claimPath,
  recordPath,
  value,
  label,
}: {
  readonly paths: LifecyclePaths;
  readonly claimPath: string;
  readonly recordPath: string;
  readonly value: unknown;
  readonly label: string;
}): Promise<void> {
  const wrapped = wrapper(value);
  await persistCanonicalLifecycleFile({
    rootDirectory: paths.rootDirectory,
    artifactDirectory: paths.artifactDirectory,
    filePath: claimPath,
    value: wrapped,
    label: `${label} claim`,
  });
  await persistCanonicalLifecycleFile({
    rootDirectory: paths.rootDirectory,
    artifactDirectory: paths.artifactDirectory,
    filePath: recordPath,
    value: wrapped,
    label: `${label} record`,
  });
}

async function readPair({
  claimPath,
  recordPath,
  label,
}: {
  readonly claimPath: string;
  readonly recordPath: string;
  readonly label: string;
}): Promise<unknown> {
  const claim = await readCanonicalLifecycleFile({
    path: claimPath,
    label: `${label} claim`,
  });
  const recordFile = await readCanonicalLifecycleFile({
    path: recordPath,
    label: `${label} record`,
  });
  if (!claim.bytes.equals(recordFile.bytes)) {
    throw integrity(`${label} claim과 record bytes가 다릅니다.`);
  }
  return parseWrapper(recordFile.value, label);
}

function eventFromRunner(
  benchmarkId: string,
  previousEventHash: string,
  progress: RunnerBenchmarkProgressEvent,
): BenchmarkProgressEvent {
  if (
    progress.total_checkpoints !== 72
    || progress.completed_checkpoints !== progress.slot.sequence
    || progress.completed_checkpoints < 1
    || progress.completed_checkpoints > 72
  ) {
    throw integrity(
      "Benchmark checkpoint progress는 slot sequence와 같은 1..72 단조 count여야 합니다.",
    );
  }
  assertSha256(
    progress.checkpoint_payload_sha256,
    "progress.checkpoint_payload_sha256",
  );
  const slotSummary = parseSlotSummary({
    slot_id: progress.slot.slot_id,
    sequence: progress.slot.sequence,
    case_id: progress.slot.case_id,
    candidate_id: progress.slot.candidate_id,
    repetition: progress.slot.repetition,
    checkpoint_payload_sha256: progress.checkpoint_payload_sha256,
    terminal: progress.terminal_slot_summary,
  }, progress.completed_checkpoints);
  const payload: BenchmarkProgressEventPayload = {
    schema_version: "benchmark-progress-event-v1",
    artifact_kind: "BENCHMARK_PROGRESS_EVENT",
    synthetic: true,
    source: "RECORDED_BENCHMARK",
    benchmark_id: benchmarkId,
    event_sequence: progress.completed_checkpoints,
    event_type: "SLOT_CHECKPOINTED",
    completed_checkpoints: progress.completed_checkpoints,
    total_checkpoints: 72,
    previous_event_hash: previousEventHash,
    checkpoint_source: progress.source,
    slot_summary: slotSummary,
  };
  return deepFreeze({
    ...payload,
    event_hash: sha256CanonicalJson(payload),
  });
}

function sameCheckpoint(
  persisted: BenchmarkProgressEvent,
  incoming: BenchmarkProgressEvent,
): boolean {
  return (
    persisted.event_type === "SLOT_CHECKPOINTED"
    && incoming.event_type === "SLOT_CHECKPOINTED"
    && canonicalJsonStringify(persisted.slot_summary)
      === canonicalJsonStringify(incoming.slot_summary)
  );
}

function parseCompletionReceipt(
  value: unknown,
  benchmarkId: string,
): BenchmarkCompletionReceipt {
  const receipt = record(value, "Benchmark completion receipt");
  exactKeys(receipt, [
    "schema_version",
    "artifact_kind",
    "synthetic",
    "source",
    "status",
    "benchmark_id",
    "completed_checkpoints",
    "total_checkpoints",
    "previous_event_hash",
    "cleanup",
    "cleanup_receipt_hash",
    "recorded_benchmark_pack_hash",
    "resource_lease_terminal_hash",
    "completion_receipt_hash",
  ], "Benchmark completion receipt");
  if (
    receipt.schema_version !== "benchmark-completion-receipt-v1"
    || receipt.artifact_kind !== "BENCHMARK_COMPLETION_RECEIPT"
    || receipt.synthetic !== true
    || receipt.source !== "RECORDED_BENCHMARK"
    || receipt.status !== "COMPLETE"
    || receipt.benchmark_id !== benchmarkId
    || receipt.completed_checkpoints !== 72
    || receipt.total_checkpoints !== 72
  ) {
    throw integrity("Benchmark completion receipt 상태 계약이 다릅니다.");
  }
  for (const [key, valueToCheck] of [
    ["previous_event_hash", receipt.previous_event_hash],
    ["cleanup_receipt_hash", receipt.cleanup_receipt_hash],
    ["recorded_benchmark_pack_hash", receipt.recorded_benchmark_pack_hash],
    ["resource_lease_terminal_hash", receipt.resource_lease_terminal_hash],
    ["completion_receipt_hash", receipt.completion_receipt_hash],
  ] as const) {
    assertSha256(valueToCheck, `Benchmark completion receipt.${key}`);
  }
  const cleanup = parseCleanup(receipt.cleanup);
  if (
    cleanup.required !== 33
    || cleanup.acknowledged !== 33
    || cleanup.incomplete !== 0
  ) {
    throw integrity("cleanup 33/33 전에는 Benchmark COMPLETE일 수 없습니다.");
  }
  const payload: BenchmarkCompletionReceiptPayload = {
    schema_version: "benchmark-completion-receipt-v1",
    artifact_kind: "BENCHMARK_COMPLETION_RECEIPT",
    synthetic: true,
    source: "RECORDED_BENCHMARK",
    status: "COMPLETE",
    benchmark_id: benchmarkId,
    completed_checkpoints: 72,
    total_checkpoints: 72,
    previous_event_hash: receipt.previous_event_hash as string,
    cleanup,
    cleanup_receipt_hash: receipt.cleanup_receipt_hash as string,
    recorded_benchmark_pack_hash:
      receipt.recorded_benchmark_pack_hash as string,
    resource_lease_terminal_hash:
      receipt.resource_lease_terminal_hash as string,
  };
  if (sha256CanonicalJson(payload) !== receipt.completion_receipt_hash) {
    throw integrity("Benchmark completion receipt content hash가 다릅니다.");
  }
  return deepFreeze({
    ...payload,
    completion_receipt_hash: receipt.completion_receipt_hash,
  });
}

function assertPathWithinRoot(
  rootDirectory: string,
  path: string,
  label: string,
): void {
  const root = resolve(rootDirectory);
  const resolvedPath = resolve(path);
  const child = relative(root, resolvedPath);
  if (
    child.length === 0
    || child === ".."
    || child.startsWith(`..${sep}`)
    || isAbsolute(child)
  ) {
    throw integrity(`${label}는 Benchmark output root 하위여야 합니다.`);
  }
}

async function loadAndValidateCleanupReceipt({
  paths,
  input,
}: {
  readonly paths: LifecyclePaths;
  readonly input: BenchmarkCompletionInput;
}): Promise<{
  readonly receipt: CleanupReceipt;
  readonly payloadHash: string;
  readonly cleanup: BenchmarkCleanupCount;
}> {
  const terminal = input.resourceLeaseTerminal;
  assertAuthoritativeBenchmarkResourceLeaseTerminal(terminal);
  const cleanupPath = resolve(input.cleanupReceiptPath);
  if (
    dirname(cleanupPath) !== paths.rootDirectory
    || !CLEANUP_RECEIPT_PATTERN.test(basename(cleanupPath))
  ) {
    throw integrity(
      "cleanup receipt는 Benchmark output root의 content-addressed 파일이어야 합니다.",
    );
  }
  const loaded = await readCanonicalLifecycleFile({
    path: cleanupPath,
    label: "Benchmark cleanup receipt",
  });
  const receipt = record(loaded.value, "Benchmark cleanup receipt");
  exactKeys(receipt, [
    "schema_version",
    "artifact_kind",
    "created_at",
    "deletion_semantics",
    "expected_resources",
    "api_delete_acknowledgements",
    "runtime_errors",
  ], "Benchmark cleanup receipt");
  if (
    receipt.schema_version !== "1.0"
    || receipt.artifact_kind !== "CLEANUP_RECEIPT"
    || receipt.deletion_semantics
      !== "API_ACKNOWLEDGEMENT_ONLY_NO_PHYSICAL_DELETION_CLAIM"
    || !Array.isArray(receipt.runtime_errors)
    || receipt.runtime_errors.length !== 0
  ) {
    throw integrity("Benchmark cleanup receipt terminal 계약이 다릅니다.");
  }
  const expectedResources = record(
    receipt.expected_resources,
    "cleanup receipt.expected_resources",
  );
  exactKeys(
    expectedResources,
    ["vector_store_id", "uploaded_file_ids"],
    "cleanup receipt.expected_resources",
  );
  const vectorStoreId = expectedResources.vector_store_id;
  const uploadedFileIds = expectedResources.uploaded_file_ids;
  if (
    typeof vectorStoreId !== "string"
    || vectorStoreId.length === 0
    || !Array.isArray(uploadedFileIds)
    || uploadedFileIds.length !== 32
    || uploadedFileIds.some(
      (id) => typeof id !== "string" || id.length === 0,
    )
    || new Set(uploadedFileIds).size !== 32
    || terminal.prepared_store.vectorStoreId !== vectorStoreId
    || canonicalJsonStringify(terminal.prepared_store.uploadedFileIds)
      !== canonicalJsonStringify(uploadedFileIds)
  ) {
    throw integrity(
      "Benchmark cleanup receipt는 terminal resource lease의 고유 1+32 자원과 일치해야 합니다.",
    );
  }
  const acknowledgements = record(
    receipt.api_delete_acknowledgements,
    "cleanup receipt.api_delete_acknowledgements",
  );
  exactKeys(
    acknowledgements,
    ["vector_store", "uploaded_files"],
    "cleanup receipt.api_delete_acknowledgements",
  );
  const vectorAck = record(
    acknowledgements.vector_store,
    "cleanup receipt.vector_store",
  );
  exactKeys(
    vectorAck,
    ["resource_id", "attempted", "deleted"],
    "cleanup receipt.vector_store",
  );
  if (
    vectorAck.resource_id !== vectorStoreId
    || vectorAck.attempted !== true
    || vectorAck.deleted !== true
    || !Array.isArray(acknowledgements.uploaded_files)
    || acknowledgements.uploaded_files.length !== 32
  ) {
    throw integrity("Benchmark cleanup vector/file acknowledgement가 불완전합니다.");
  }
  acknowledgements.uploaded_files.forEach((value, index) => {
    const item = record(value, `cleanup receipt.uploaded_files[${index}]`);
    exactKeys(
      item,
      ["resource_id", "attempted", "deleted"],
      `cleanup receipt.uploaded_files[${index}]`,
    );
    if (
      item.resource_id !== uploadedFileIds[index]
      || item.attempted !== true
      || item.deleted !== true
    ) {
      throw integrity(
        "Benchmark cleanup file acknowledgement가 terminal resource 순서와 다릅니다.",
      );
    }
  });
  if (
    terminal.cleanup.vectorStore.id !== vectorStoreId
    || terminal.cleanup.vectorStore.attempted !== true
    || terminal.cleanup.vectorStore.deleted !== true
    || terminal.cleanup.uploadedFiles.length !== 32
    || terminal.cleanup.uploadedFiles.some((item, index) => (
      item.id !== uploadedFileIds[index]
      || item.attempted !== true
      || item.deleted !== true
    ))
  ) {
    throw integrity("resource lease terminal cleanup source가 33/33이 아닙니다.");
  }
  const payloadHash = sha256CanonicalJson(loaded.value);
  const filename = CLEANUP_RECEIPT_PATTERN.exec(basename(cleanupPath));
  if (!filename || filename[1] !== payloadHash) {
    throw integrity("cleanup receipt filename과 source payload hash가 다릅니다.");
  }
  return {
    receipt: loaded.value as CleanupReceipt,
    payloadHash,
    cleanup: { required: 33, acknowledged: 33, incomplete: 0 },
  };
}

async function buildCompletionReceipt(
  paths: LifecyclePaths,
  state: SourceState,
  input: BenchmarkCompletionInput,
): Promise<BenchmarkCompletionReceipt> {
  if (state.slotCount !== 72) {
    throw integrity(
      "72개 checkpoint와 cleanup 33/33 전에는 COMPLETE를 기록할 수 없습니다.",
    );
  }
  assertPersistedRecordedBenchmarkPack(input.recordedBenchmarkPack);
  assertAuthoritativeBenchmarkResourceLeaseTerminal(
    input.resourceLeaseTerminal,
  );
  const start = state.chain.start_receipt;
  const pack = input.recordedBenchmarkPack;
  const terminal = input.resourceLeaseTerminal;
  if (
    pack.locked_challenge_pack_hash
      !== start.stable_identity.locked_challenge_pack_hash
    || pack.benchmark_execution_pack.schedule_id
      !== start.stable_identity.schedule_id
    || pack.coverage.candidate_runs !== 72
    || pack.coverage.judge_cases !== 12
    || terminal.contract.locked_challenge_pack_sha256
      !== start.stable_identity.locked_challenge_pack_hash
    || terminal.contract.schedule_id !== start.stable_identity.schedule_id
  ) {
    throw integrity(
      "persisted Recorded Pack·resource lease terminal이 stable Benchmark identity와 다릅니다.",
    );
  }
  const cleanupSource = await loadAndValidateCleanupReceipt({ paths, input });
  const packHash = sha256CanonicalJson(pack);
  const finalization = input.finalizationArtifacts;
  assertPathWithinRoot(
    paths.rootDirectory,
    input.recordedBenchmarkPackPath,
    "Recorded Benchmark Pack path",
  );
  if (
    resolve(finalization.cleanupReceipt.path)
      !== resolve(input.cleanupReceiptPath)
    || finalization.cleanupReceipt.payloadSha256
      !== cleanupSource.payloadHash
    || finalization.recordedPack === null
    || resolve(finalization.recordedPack.path)
      !== resolve(input.recordedBenchmarkPackPath)
    || finalization.recordedPack.payloadSha256 !== packHash
  ) {
    throw integrity(
      "resource lease completion binding이 cleanup receipt·Recorded Pack source와 다릅니다.",
    );
  }
  const payload: BenchmarkCompletionReceiptPayload = {
    schema_version: "benchmark-completion-receipt-v1",
    artifact_kind: "BENCHMARK_COMPLETION_RECEIPT",
    synthetic: true,
    source: "RECORDED_BENCHMARK",
    status: "COMPLETE",
    benchmark_id: start.benchmark_id,
    completed_checkpoints: 72,
    total_checkpoints: 72,
    previous_event_hash: state.headHash,
    cleanup: cleanupSource.cleanup,
    cleanup_receipt_hash: cleanupSource.payloadHash,
    recorded_benchmark_pack_hash: packHash,
    resource_lease_terminal_hash: terminal.terminal_record_sha256,
  };
  return deepFreeze({
    ...payload,
    completion_receipt_hash: sha256CanonicalJson(payload),
  });
}

function project(
  state: SourceState,
  observedSource?: BenchmarkCheckpointSource,
): BenchmarkLifecycleProjection {
  const lastSlot = state.chain.events
    .filter((event) => event.event_type === "SLOT_CHECKPOINTED")
    .at(-1);
  const publicPayload = {
    schema_version: "benchmark-lifecycle-projection-v1",
    synthetic: true,
    source: "RECORDED_BENCHMARK",
    benchmark_id: state.chain.start_receipt.benchmark_id,
    status: state.completion === null ? "RUNNING" : "COMPLETE",
    completed: state.slotCount,
    total: 72,
    last_slot_sequence: lastSlot?.slot_summary?.sequence ?? null,
    checkpoint_source:
      observedSource ?? lastSlot?.checkpoint_source ?? null,
    cleanup: state.completion?.cleanup ?? null,
  } as const;
  const projection: BenchmarkLifecycleProjection = {
    ...publicPayload,
    // 내부 checkpoint/event/receipt hash가 아니라 공개 payload 자체의 revision입니다.
    source_hash: sha256CanonicalJson({
      schema_version: "benchmark-public-projection-revision-v1",
      projection: publicPayload,
    }),
  };
  assertNoPotentialSecret(projection, "Benchmark lifecycle projection");
  const serialized = canonicalJsonStringify(projection);
  if (
    /api[_-]?key|oracle|private|execution_hash|slot_identity|vector_store|file-/i
      .test(serialized)
  ) {
    throw integrity(
      "Benchmark lifecycle projection에 evaluator-private identity가 포함됐습니다.",
    );
  }
  return deepFreeze(projection);
}

async function verifyExactDirectoryEntries(
  paths: LifecyclePaths,
  startReceipt: BenchmarkStartReceipt,
  events: readonly BenchmarkProgressEvent[],
  completion: BenchmarkCompletionReceipt | null = null,
): Promise<void> {
  const expected = new Set([
    START_CLAIM_FILENAME,
    basename(paths.startRecordPath),
  ]);
  for (const event of events) {
    const names = eventNames(paths.artifactDirectory, event);
    expected.add(basename(names.claimPath));
    expected.add(basename(names.recordPath));
  }
  if (completion !== null) {
    const names = completionNames(paths.artifactDirectory, completion);
    expected.add(basename(names.claimPath));
    expected.add(basename(names.recordPath));
  }
  const entries = await readdir(paths.artifactDirectory);
  if (
    entries.length !== expected.size
    || entries.some((entry) => !expected.has(entry))
    || !START_RECORD_PATTERN.test(basename(paths.startRecordPath))
  ) {
    throw integrity(
      "Benchmark progress 디렉터리에 fork·rollback·임시 artifact가 있습니다.",
    );
  }
  const match = START_RECORD_PATTERN.exec(basename(paths.startRecordPath));
  if (!match || match[1] !== startReceipt.start_receipt_hash) {
    throw integrity("Benchmark start record filename hash가 다릅니다.");
  }
}

async function loadSource(
  input: BenchmarkProgressCoordinates,
  expectedStart: BenchmarkStartReceipt,
  paths: LifecyclePaths,
): Promise<SourceState> {
  await assertCanonicalLifecycleDirectory(paths);
  const start = parseStartReceipt(
    await readPair({
      claimPath: paths.startClaimPath,
      recordPath: paths.startRecordPath,
      label: "Benchmark start receipt",
    }),
    expectedStart.stable_identity,
  );
  if (
    start.start_receipt_hash !== expectedStart.start_receipt_hash
    || start.benchmark_id !== expectedStart.benchmark_id
  ) {
    throw integrity("Benchmark start source가 요청 identity와 다릅니다.");
  }
  const entries = await readdir(paths.artifactDirectory);
  const claimSequences = entries
    .map((entry) => EVENT_CLAIM_PATTERN.exec(entry))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((left, right) => left - right);
  if (
    claimSequences.some((sequence, index) => sequence !== index + 1)
    || new Set(claimSequences).size !== claimSequences.length
  ) {
    throw integrity("Benchmark progress event claim sequence에 gap·fork가 있습니다.");
  }
  const events: BenchmarkProgressEvent[] = [];
  let previous = start.start_receipt_hash;
  for (const sequence of claimSequences) {
    const sequenceText = String(sequence).padStart(3, "0");
    const claimName =
      `benchmark-progress--event-${sequenceText}--claim.json`;
    const claimPath = join(paths.artifactDirectory, claimName);
    const claim = await readCanonicalLifecycleFile({
      path: claimPath,
      label: `Benchmark progress event ${sequence} claim`,
    });
    const event = parseEvent(
      parseWrapper(
        claim.value,
        `Benchmark progress event ${sequence} claim`,
      ),
      start.benchmark_id,
    );
    if (
      event.event_sequence !== sequence
      || event.previous_event_hash !== previous
    ) {
      throw integrity(
        "Benchmark progress event sequence 또는 previous hash chain이 다릅니다.",
      );
    }
    const names = eventNames(paths.artifactDirectory, event);
    // claim 공개 뒤 crash가 난 경우에만 claim에 고정된 exact event를 record로 복구합니다.
    // 정상 source reload는 기존 record를 다시 publish하지 않습니다.
    try {
      await lstat(names.recordPath);
    } catch (error) {
      if (!errorCode(error, "ENOENT")) throw error;
      await persistCanonicalLifecycleFile({
        rootDirectory: paths.rootDirectory,
        artifactDirectory: paths.artifactDirectory,
        filePath: names.recordPath,
        value: wrapper(event),
        label: `Benchmark progress event ${sequence} record`,
      });
    }
    const loaded = parseEvent(
      await readPair({
        claimPath,
        recordPath: names.recordPath,
        label: `Benchmark progress event ${sequence}`,
      }),
      start.benchmark_id,
    );
    if (canonicalJsonStringify(loaded) !== canonicalJsonStringify(event)) {
      throw integrity("Benchmark progress claim과 source-reload record가 다릅니다.");
    }
    events.push(loaded);
    previous = loaded.event_hash;
  }
  if (events.some(
    (event, index) => event.completed_checkpoints !== index + 1,
  )) {
    throw integrity("Benchmark progress slot 순서가 1..72와 다릅니다.");
  }
  let completion: BenchmarkCompletionReceipt | null = null;
  if (entries.includes(COMPLETION_CLAIM_FILENAME)) {
    const claim = await readCanonicalLifecycleFile({
      path: join(paths.artifactDirectory, COMPLETION_CLAIM_FILENAME),
      label: "Benchmark completion receipt claim",
    });
    const parsed = parseCompletionReceipt(
      parseWrapper(claim.value, "Benchmark completion receipt claim"),
      start.benchmark_id,
    );
    if (
      events.length !== 72
      || parsed.previous_event_hash !== previous
    ) {
      throw integrity(
        "Benchmark completion receipt가 exact 72 progress head에 연결되지 않았습니다.",
      );
    }
    const names = completionNames(paths.artifactDirectory, parsed);
    try {
      await lstat(names.recordPath);
    } catch (error) {
      if (!errorCode(error, "ENOENT")) throw error;
      await persistCanonicalLifecycleFile({
        rootDirectory: paths.rootDirectory,
        artifactDirectory: paths.artifactDirectory,
        filePath: names.recordPath,
        value: wrapper(parsed),
        label: "Benchmark completion receipt record",
      });
    }
    completion = parseCompletionReceipt(
      await readPair({
        claimPath: names.claimPath,
        recordPath: names.recordPath,
        label: "Benchmark completion receipt",
      }),
      start.benchmark_id,
    );
    if (canonicalJsonStringify(completion) !== canonicalJsonStringify(parsed)) {
      throw integrity("Benchmark completion claim과 source-reload record가 다릅니다.");
    }
  }
  await verifyExactDirectoryEntries(paths, start, events, completion);
  const chain: BenchmarkProgressChain = deepFreeze({
    start_receipt: start,
    events,
    completion_receipt: completion,
  });
  return {
    chain,
    headHash: completion?.completion_receipt_hash ?? previous,
    slotCount: events.length,
    eventCount: events.length,
    completion,
  };
}

function assertNotStale(
  actual: SourceState,
  expected: {
    readonly headHash: string;
    readonly eventCount: number;
    readonly completionHash: string | null;
  },
): void {
  if (
    actual.headHash !== expected.headHash
    || actual.eventCount !== expected.eventCount
    || (actual.completion?.completion_receipt_hash ?? null)
      !== expected.completionHash
  ) {
    throw integrity(
      "Benchmark progress journal head가 stale입니다. fork·rollback append를 거부합니다.",
    );
  }
}

async function assertJournalHeadCurrent(
  paths: LifecyclePaths,
  source: SourceState,
  expected: {
    readonly headHash: string;
    readonly eventCount: number;
    readonly completionHash: string | null;
  },
): Promise<void> {
  await assertCanonicalLifecycleDirectory(paths);
  await verifyExactDirectoryEntries(
    paths,
    source.chain.start_receipt,
    source.chain.events,
    source.completion,
  );
  if (source.chain.events.length === 0) {
    const start = parseStartReceipt(
      await readPair({
        claimPath: paths.startClaimPath,
        recordPath: paths.startRecordPath,
        label: "Benchmark start receipt",
      }),
      source.chain.start_receipt.stable_identity,
    );
    if (start.start_receipt_hash !== expected.headHash) {
      throw integrity(
        "Benchmark progress start head가 stale입니다. rollback append를 거부합니다.",
      );
    }
    return;
  }
  const last = source.chain.events.at(-1)!;
  const names = eventNames(paths.artifactDirectory, last);
  const reloaded = parseEvent(
    await readPair({
      claimPath: names.claimPath,
      recordPath: names.recordPath,
      label: `Benchmark progress event ${last.event_sequence}`,
    }),
    source.chain.start_receipt.benchmark_id,
  );
  if (
    reloaded.event_hash !== expected.headHash
    || source.eventCount !== expected.eventCount
    || (source.completion?.completion_receipt_hash ?? null)
      !== expected.completionHash
  ) {
    throw integrity(
      "Benchmark progress journal head가 stale입니다. fork·rollback append를 거부합니다.",
    );
  }
}

function appendVerifiedEvent(
  source: SourceState,
  event: BenchmarkProgressEvent,
): SourceState {
  if (
    event.previous_event_hash !== source.headHash
    || event.event_sequence !== source.eventCount + 1
  ) {
    throw integrity("새 progress event가 현재 source head에 연결되지 않았습니다.");
  }
  const events = [...source.chain.events, event];
  return {
    chain: deepFreeze({
      start_receipt: source.chain.start_receipt,
      events,
      completion_receipt: source.completion,
    }),
    headHash: event.event_hash,
    slotCount: source.slotCount + 1,
    eventCount: events.length,
    completion: source.completion,
  };
}

function appendVerifiedCompletion(
  source: SourceState,
  completion: BenchmarkCompletionReceipt,
): SourceState {
  if (
    source.slotCount !== 72
    || source.completion !== null
    || completion.previous_event_hash !== source.headHash
  ) {
    throw integrity(
      "Benchmark completion receipt가 현재 exact 72 progress head에 연결되지 않았습니다.",
    );
  }
  return {
    chain: deepFreeze({
      start_receipt: source.chain.start_receipt,
      events: source.chain.events,
      completion_receipt: completion,
    }),
    headHash: completion.completion_receipt_hash,
    slotCount: 72,
    eventCount: 72,
    completion,
  };
}

export async function openBenchmarkProgressJournal(
  input: BenchmarkProgressCoordinates,
): Promise<BenchmarkProgressJournal> {
  const startReceipt = buildStartReceipt(input);
  const paths = pathsFor(input, startReceipt);
  await persistPair({
    paths,
    claimPath: paths.startClaimPath,
    recordPath: paths.startRecordPath,
    value: startReceipt,
    label: "Benchmark start receipt",
  });
  let source = await loadSource(input, startReceipt, paths);
  let expectedHead = {
    headHash: source.headHash,
    eventCount: source.eventCount,
    completionHash: source.completion?.completion_receipt_hash ?? null,
  };

  const journal: BenchmarkProgressJournal = {
    benchmarkId: startReceipt.benchmark_id,
    startReceipt: source.chain.start_receipt,
    startPath: paths.startRecordPath,
    currentProjection: () => project(source),
    verifySource: async () => {
      const actual = await loadSource(input, startReceipt, paths);
      assertNotStale(actual, expectedHead);
      source = actual;
      return source.chain;
    },
    recordCheckpoint: async (progress) => {
      assertVerifiedBenchmarkProgressEvent(progress);
      if (source.completion !== null) {
        throw integrity(
          "terminal COMPLETE Benchmark에는 checkpoint를 추가하거나 replay할 수 없습니다.",
        );
      }
      await assertJournalHeadCurrent(paths, source, expectedHead);
      const incoming = eventFromRunner(
        startReceipt.benchmark_id,
        progress.completed_checkpoints === 1
          ? startReceipt.start_receipt_hash
          : (
            source.chain.events.find((event) => (
              event.event_type === "SLOT_CHECKPOINTED"
              && event.completed_checkpoints
                === progress.completed_checkpoints - 1
            ))?.event_hash ?? source.headHash
          ),
        progress,
      );
      if (progress.completed_checkpoints <= source.slotCount) {
        const existing = source.chain.events.find((event) => (
          event.event_type === "SLOT_CHECKPOINTED"
          && event.completed_checkpoints === progress.completed_checkpoints
        ));
        if (!existing || !sameCheckpoint(existing, incoming)) {
          throw integrity(
            "같은 checkpoint count에 다른 slot/hash가 있어 progress fork를 거부합니다.",
          );
        }
        return project(source, progress.source);
      }
      if (progress.completed_checkpoints !== source.slotCount + 1) {
        throw integrity(
          `Benchmark progress count에 gap이 있습니다. 다음 값은 ${source.slotCount + 1}이어야 합니다.`,
        );
      }
      const event = eventFromRunner(
        startReceipt.benchmark_id,
        source.headHash,
        progress,
      );
      const names = eventNames(paths.artifactDirectory, event);
      await persistPair({
        paths,
        claimPath: names.claimPath,
        recordPath: names.recordPath,
        value: event,
        label: `Benchmark progress event ${event.event_sequence}`,
      });
      const loaded = parseEvent(
        await readPair({
          claimPath: names.claimPath,
          recordPath: names.recordPath,
          label: `Benchmark progress event ${event.event_sequence}`,
        }),
        startReceipt.benchmark_id,
      );
      if (canonicalJsonStringify(loaded) !== canonicalJsonStringify(event)) {
        throw integrity("새 progress event source reload가 저장 요청과 다릅니다.");
      }
      source = appendVerifiedEvent(source, loaded);
      await verifyExactDirectoryEntries(
        paths,
        source.chain.start_receipt,
        source.chain.events,
      );
      expectedHead = {
        headHash: source.headHash,
        eventCount: source.eventCount,
        completionHash: source.completion?.completion_receipt_hash ?? null,
      };
      return project(source, progress.source);
    },
    complete: async (completionInput) => {
      if (source.completion !== null) {
        throw integrity("Benchmark COMPLETE receipt가 이미 terminal로 기록됐습니다.");
      }
      await assertJournalHeadCurrent(paths, source, expectedHead);
      const completion = await buildCompletionReceipt(
        paths,
        source,
        completionInput,
      );
      const names = completionNames(paths.artifactDirectory, completion);
      await persistPair({
        paths,
        claimPath: names.claimPath,
        recordPath: names.recordPath,
        value: completion,
        label: "Benchmark completion receipt",
      });
      const loaded = parseCompletionReceipt(
        await readPair({
          claimPath: names.claimPath,
          recordPath: names.recordPath,
          label: "Benchmark completion receipt",
        }),
        startReceipt.benchmark_id,
      );
      if (
        canonicalJsonStringify(loaded)
          !== canonicalJsonStringify(completion)
      ) {
        throw integrity(
          "Benchmark completion receipt source reload가 저장 요청과 다릅니다.",
        );
      }
      source = appendVerifiedCompletion(source, loaded);
      await verifyExactDirectoryEntries(
        paths,
        source.chain.start_receipt,
        source.chain.events,
        source.completion,
      );
      expectedHead = {
        headHash: source.headHash,
        eventCount: source.eventCount,
        completionHash:
          source.completion?.completion_receipt_hash ?? null,
      };
      return project(source);
    },
  };
  return Object.freeze(journal);
}

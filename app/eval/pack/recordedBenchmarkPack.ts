import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  assertValidatedBlindReviewQueue,
  calculateBlindReviewQueueContentHash,
  calculateBlindReviewQueueSetOrderHash,
  type BlindReviewQueue,
} from "../review/buildReviewQueue";
import {
  assertValidatedBenchmarkExecutionPack,
  type BenchmarkCandidateAggregate,
  type BenchmarkExecutionPack,
} from "./benchmarkPack";
import {
  assertValidatedJudgeEvidencePack,
  type EvaluationCostBoundary,
  type JudgeEvidencePack,
} from "./judgeEvidencePack";
import {
  assertExistingCanonicalAuthorityPackDirectory,
  persistCanonicalAuthorityPack,
  readCanonicalAuthorityFile,
  type CanonicalAuthorityPackPaths,
} from "./authorityPackPersistence";
import { dirname, join, resolve } from "node:path";

const VALIDATED_RECORDED_BENCHMARK_PACKS = new WeakSet<object>();
const WRITTEN_RECORDED_BENCHMARK_PACKS = new WeakSet<object>();
const SOURCE_RELOADED_RECORDED_BENCHMARK_PACKS = new WeakSet<object>();
const PERSISTING_RECORDED_BENCHMARK_PACKS = new WeakSet<object>();
const SHA256 = /^[a-f0-9]{64}$/;

type JsonRecord = Record<string, unknown>;

export class RecordedBenchmarkPackIntegrityError extends Error {
  readonly code = "RECORDED_BENCHMARK_PACK_INTEGRITY" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecordedBenchmarkPackIntegrityError";
  }
}

export interface RecordedBenchmarkPack {
  readonly schema_version: "recorded-benchmark-pack-v1";
  readonly artifact_kind: "RECORDED_BENCHMARK_PACK";
  readonly source: "RECORDED_BENCHMARK";
  readonly execution_status: "EXECUTION_COMPLETE";
  readonly judge_status:
    | "JUDGE_COMPLETE"
    | "JUDGE_PARTIAL_HUMAN_FALLBACK";
  readonly review_status: "REVIEW_PENDING";
  readonly evaluation_status: "EVALUATION_INCOMPLETE";
  readonly baseline_version: null;
  readonly synthetic: true;
  readonly execution_hash: string;
  readonly execution_pack_hash: string;
  readonly locked_challenge_pack_hash: string;
  readonly locked_challenge_contract_hash: string;
  readonly locked_challenge_source_manifest_hash: string;
  readonly precommit_manifest_digest: string;
  readonly precommit_manifest_hash: string;
  readonly judge_evidence_pack_hash: string;
  readonly queue_content_hash: string;
  readonly queue_set_order_hash: string;
  readonly costs: EvaluationCostBoundary;
  readonly coverage: {
    readonly cases: 12;
    readonly candidates: 3;
    readonly runs_per_case: 2;
    readonly candidate_runs: 72;
    readonly judge_cases: 12;
    readonly complete_judge_cases: number;
    readonly human_fallback_judge_cases: number;
    readonly review_items: number;
  };
  readonly benchmark_execution_pack: BenchmarkExecutionPack;
  readonly judge_evidence_pack: JudgeEvidencePack;
  readonly blind_review_queue: BlindReviewQueue;
}

export interface RecordedBenchmarkPublicProjection {
  readonly schema_version: "recorded-benchmark-public-projection-v1";
  readonly artifact_kind: "RECORDED_BENCHMARK_PUBLIC_PROJECTION";
  readonly source: "RECORDED_BENCHMARK";
  readonly execution_status: "EXECUTION_COMPLETE";
  readonly judge_status:
    | "JUDGE_COMPLETE"
    | "JUDGE_PARTIAL_HUMAN_FALLBACK";
  readonly review_status: "REVIEW_PENDING";
  readonly evaluation_status: "EVALUATION_INCOMPLETE";
  readonly baseline_version: null;
  readonly synthetic: true;
  readonly execution_pack_hash: string;
  readonly recorded_benchmark_pack_hash: string;
  readonly locked_challenge_pack_hash: string;
  readonly judge_evidence_pack_hash: string;
  readonly queue_content_hash: string;
  readonly queue_set_order_hash: string;
  readonly costs: EvaluationCostBoundary;
  readonly coverage: RecordedBenchmarkPack["coverage"];
  readonly candidate_aggregates: readonly BenchmarkCandidateAggregate[];
  readonly blind_review_queue: BlindReviewQueue;
}

export interface BuildRecordedBenchmarkPackInput {
  readonly benchmarkPack: BenchmarkExecutionPack;
  readonly judgeEvidencePack: JudgeEvidencePack;
  readonly blindReviewQueue: BlindReviewQueue;
}

export interface RecordedBenchmarkPackPaths extends CanonicalAuthorityPackPaths {}

export interface PersistRecordedBenchmarkPackResult {
  readonly path: string;
  readonly payloadSha256: string;
}

function integrity(
  message: string,
  cause?: unknown,
): RecordedBenchmarkPackIntegrityError {
  return new RecordedBenchmarkPackIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function assertNoDecisionFields(value: unknown, location: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoDecisionFields(item, `${location}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    if (/^(?:recommendation|winner|approved|selected_candidate|approval)$/i.test(key)) {
      throw integrity(`${location}.${key}는 평가 미완료 팩에 허용되지 않습니다.`);
    }
    assertNoDecisionFields(child, `${location}.${key}`);
  }
}

export function assertValidatedRecordedBenchmarkPack(
  value: unknown,
): asserts value is RecordedBenchmarkPack {
  if (
    typeof value !== "object"
    || value === null
    || !VALIDATED_RECORDED_BENCHMARK_PACKS.has(value)
  ) {
    throw integrity(
      "Recorded Benchmark Pack은 권위 자식 팩 전체를 재검증한 build/load 결과여야 합니다.",
    );
  }
}

export function assertPersistedRecordedBenchmarkPack(
  value: unknown,
): asserts value is RecordedBenchmarkPack {
  assertValidatedRecordedBenchmarkPack(value);
  if (!SOURCE_RELOADED_RECORDED_BENCHMARK_PACKS.has(value)) {
    throw integrity(
      "브라우저·사람 확인·결정 권위에는 write-once 저장 뒤 canonical source-reload한 Recorded Benchmark Pack이 필요합니다.",
    );
  }
}

export function buildRecordedBenchmarkPack({
  benchmarkPack,
  judgeEvidencePack,
  blindReviewQueue,
}: BuildRecordedBenchmarkPackInput): RecordedBenchmarkPack {
  assertValidatedBenchmarkExecutionPack(benchmarkPack);
  assertValidatedJudgeEvidencePack(judgeEvidencePack);
  assertValidatedBlindReviewQueue(blindReviewQueue);
  const executionPackHash = sha256CanonicalJson(benchmarkPack);
  if (
    judgeEvidencePack.execution_pack_hash !== executionPackHash
    || blindReviewQueue.execution_pack_hash !== executionPackHash
    || judgeEvidencePack.queue_content_hash !== blindReviewQueue.queue_content_hash
    || judgeEvidencePack.queue_set_order_hash !== blindReviewQueue.queue_set_order_hash
    || calculateBlindReviewQueueContentHash(blindReviewQueue)
      !== blindReviewQueue.queue_content_hash
    || calculateBlindReviewQueueSetOrderHash(blindReviewQueue)
      !== blindReviewQueue.queue_set_order_hash
    || judgeEvidencePack.locked_challenge_pack_hash
      !== benchmarkPack.locked_challenge_pack_hash
    || judgeEvidencePack.locked_challenge_contract_hash
      !== benchmarkPack.locked_challenge_contract_hash
    || judgeEvidencePack.locked_challenge_source_manifest_hash
      !== benchmarkPack.locked_challenge_source_manifest_hash
  ) {
    throw integrity(
      "Recorded Benchmark 자식 팩의 execution·Challenge·Judge·queue hash chain이 다릅니다.",
    );
  }
  const pack: RecordedBenchmarkPack = deepFreeze({
    schema_version: "recorded-benchmark-pack-v1",
    artifact_kind: "RECORDED_BENCHMARK_PACK",
    source: "RECORDED_BENCHMARK",
    execution_status: "EXECUTION_COMPLETE",
    judge_status: judgeEvidencePack.judge_status,
    review_status: "REVIEW_PENDING",
    evaluation_status: "EVALUATION_INCOMPLETE",
    baseline_version: null,
    synthetic: true,
    execution_hash: benchmarkPack.execution_hash,
    execution_pack_hash: executionPackHash,
    locked_challenge_pack_hash: benchmarkPack.locked_challenge_pack_hash,
    locked_challenge_contract_hash:
      benchmarkPack.locked_challenge_contract_hash,
    locked_challenge_source_manifest_hash:
      benchmarkPack.locked_challenge_source_manifest_hash,
    precommit_manifest_digest:
      judgeEvidencePack.precommit_manifest_digest,
    precommit_manifest_hash: judgeEvidencePack.precommit_manifest_hash,
    judge_evidence_pack_hash: sha256CanonicalJson(judgeEvidencePack),
    queue_content_hash: blindReviewQueue.queue_content_hash,
    queue_set_order_hash: blindReviewQueue.queue_set_order_hash,
    costs: structuredClone(judgeEvidencePack.costs),
    coverage: {
      cases: 12,
      candidates: 3,
      runs_per_case: 2,
      candidate_runs: 72,
      judge_cases: 12,
      complete_judge_cases:
        judgeEvidencePack.coverage.complete_judge_cases,
      human_fallback_judge_cases:
        judgeEvidencePack.coverage.human_fallback_judge_cases,
      review_items: blindReviewQueue.items.length,
    },
    benchmark_execution_pack: benchmarkPack,
    judge_evidence_pack: judgeEvidencePack,
    blind_review_queue: blindReviewQueue,
  });
  assertNoDecisionFields(pack, "Recorded Benchmark Pack");
  VALIDATED_RECORDED_BENCHMARK_PACKS.add(pack);
  return pack;
}

/**
 * 브라우저에는 blind review에 필요한 공개 큐와 후보별 집계만 제공합니다.
 * private A/B/C mapping, case seed, Judge 원시 입력·receipt는 authority pack에만 남습니다.
 */
export function buildRecordedBenchmarkPublicProjection(
  recordedBenchmarkPack: RecordedBenchmarkPack,
): RecordedBenchmarkPublicProjection {
  assertPersistedRecordedBenchmarkPack(recordedBenchmarkPack);
  const projection: RecordedBenchmarkPublicProjection = deepFreeze({
    schema_version: "recorded-benchmark-public-projection-v1",
    artifact_kind: "RECORDED_BENCHMARK_PUBLIC_PROJECTION",
    source: "RECORDED_BENCHMARK",
    execution_status: "EXECUTION_COMPLETE",
    judge_status: recordedBenchmarkPack.judge_status,
    review_status: "REVIEW_PENDING",
    evaluation_status: "EVALUATION_INCOMPLETE",
    baseline_version: null,
    synthetic: true,
    execution_pack_hash: recordedBenchmarkPack.execution_pack_hash,
    recorded_benchmark_pack_hash: sha256CanonicalJson(recordedBenchmarkPack),
    locked_challenge_pack_hash:
      recordedBenchmarkPack.locked_challenge_pack_hash,
    judge_evidence_pack_hash:
      recordedBenchmarkPack.judge_evidence_pack_hash,
    queue_content_hash: recordedBenchmarkPack.queue_content_hash,
    queue_set_order_hash: recordedBenchmarkPack.queue_set_order_hash,
    costs: structuredClone(recordedBenchmarkPack.costs),
    coverage: structuredClone(recordedBenchmarkPack.coverage),
    candidate_aggregates: structuredClone(
      recordedBenchmarkPack.benchmark_execution_pack.candidate_aggregates,
    ),
    blind_review_queue: recordedBenchmarkPack.blind_review_queue,
  });
  const serialized = canonicalJsonStringify(projection);
  if (
    /private_mapping|label_to_candidate|blinding_seed|case_blinding_seed/i
      .test(serialized)
  ) {
    throw integrity("browser projection에 private blinding 자료가 포함됐습니다.");
  }
  assertNoDecisionFields(projection, "Recorded Benchmark browser projection");
  return projection;
}

export function createRecordedBenchmarkPackPaths({
  outputDirectory,
  executionPackHash,
  payloadSha256,
}: {
  readonly outputDirectory: string;
  readonly executionPackHash: string;
  readonly payloadSha256: string;
}): RecordedBenchmarkPackPaths {
  if (
    typeof outputDirectory !== "string"
    || outputDirectory.length === 0
    || !SHA256.test(executionPackHash)
    || !SHA256.test(payloadSha256)
  ) {
    throw integrity("Recorded Benchmark Pack 경로 입력이 안전한 값이 아닙니다.");
  }
  const executionDirectory = join(outputDirectory, executionPackHash);
  return Object.freeze({
    outputDirectory,
    executionDirectory,
    claimPath: join(executionDirectory, "recorded-benchmark-pack--claim.json"),
    recordPath: join(
      executionDirectory,
      `recorded-benchmark-pack--record-${payloadSha256}.json`,
    ),
  });
}

function recordedBenchmarkClaim(
  pack: RecordedBenchmarkPack,
  payloadSha256: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema_version: "recorded-benchmark-pack-claim-v1",
    artifact_kind: "RECORDED_BENCHMARK_PACK_CLAIM",
    execution_pack_hash: pack.execution_pack_hash,
    locked_challenge_pack_hash: pack.locked_challenge_pack_hash,
    judge_evidence_pack_hash: pack.judge_evidence_pack_hash,
    queue_content_hash: pack.queue_content_hash,
    queue_set_order_hash: pack.queue_set_order_hash,
    payload_sha256: payloadSha256,
  });
}

export async function persistRecordedBenchmarkPack({
  outputDirectory,
  pack,
}: {
  readonly outputDirectory: string;
  readonly pack: RecordedBenchmarkPack;
}): Promise<PersistRecordedBenchmarkPackResult> {
  assertValidatedRecordedBenchmarkPack(pack);
  if (
    WRITTEN_RECORDED_BENCHMARK_PACKS.has(pack)
    || PERSISTING_RECORDED_BENCHMARK_PACKS.has(pack)
  ) {
    throw integrity("동일 Recorded Benchmark Pack 객체의 persistence replay는 허용되지 않습니다.");
  }
  PERSISTING_RECORDED_BENCHMARK_PACKS.add(pack);
  try {
    const snapshot = JSON.parse(
      canonicalJsonStringify(pack),
    ) as RecordedBenchmarkPack;
    const payloadSha256 = sha256CanonicalJson(snapshot);
    const paths = createRecordedBenchmarkPackPaths({
      outputDirectory,
      executionPackHash: snapshot.execution_pack_hash,
      payloadSha256,
    });
    await persistCanonicalAuthorityPack({
      paths,
      claim: recordedBenchmarkClaim(snapshot, payloadSha256),
      payload: snapshot,
      claimLocation: "Recorded Benchmark Pack claim",
      recordLocation: "Recorded Benchmark Pack record",
    });
    WRITTEN_RECORDED_BENCHMARK_PACKS.add(pack);
    return Object.freeze({ path: paths.recordPath, payloadSha256 });
  } catch (error) {
    if (error instanceof RecordedBenchmarkPackIntegrityError) throw error;
    throw integrity("Recorded Benchmark Pack을 atomic write-once 저장할 수 없습니다.", error);
  } finally {
    PERSISTING_RECORDED_BENCHMARK_PACKS.delete(pack);
  }
}

export async function loadRecordedBenchmarkPack({
  path,
  authority,
}: {
  readonly path: string;
  readonly authority: BuildRecordedBenchmarkPackInput;
}): Promise<RecordedBenchmarkPack> {
  const rebuilt = buildRecordedBenchmarkPack(authority);
  const payloadSha256 = sha256CanonicalJson(rebuilt);
  const outputDirectory = dirname(dirname(resolve(path)));
  const paths = createRecordedBenchmarkPackPaths({
    outputDirectory,
    executionPackHash: rebuilt.execution_pack_hash,
    payloadSha256,
  });
  if (resolve(path) !== resolve(paths.recordPath)) {
    throw integrity("Recorded Benchmark Pack path가 authoritative content-address와 다릅니다.");
  }
  await assertExistingCanonicalAuthorityPackDirectory(paths);
  await readCanonicalAuthorityFile({
    path: paths.claimPath,
    expectedPayload: recordedBenchmarkClaim(rebuilt, payloadSha256),
    location: "Recorded Benchmark Pack claim",
  });
  await readCanonicalAuthorityFile({
    path: paths.recordPath,
    expectedPayload: rebuilt,
    location: "Recorded Benchmark Pack record",
  });
  SOURCE_RELOADED_RECORDED_BENCHMARK_PACKS.add(rebuilt);
  return rebuilt;
}

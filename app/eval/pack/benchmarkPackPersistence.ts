import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  assertValidatedBenchmarkExecutionPack,
  type BenchmarkExecutionPack,
} from "./benchmarkPack";
import {
  persistWriteOnceFileWithClaim,
  prepareWriteOnceArtifactDirectory,
} from "./persistence";
import { canonicalJsonStringify, sha256CanonicalJson } from "../runtime/canonicalJson";

const SHA256 = /^[a-f0-9]{64}$/;
const PACK_KEYS = [
  "artifact_kind",
  "baseline_version",
  "candidate_aggregates",
  "coverage",
  "evaluation_status",
  "evaluator_contract_hash",
  "execution_hash",
  "execution_status",
  "judge_readiness",
  "locked_challenge_contract_hash",
  "locked_challenge_pack_hash",
  "locked_challenge_source_manifest_hash",
  "review_status",
  "schedule_id",
  "schema_version",
  "slots",
  "source",
  "synthetic",
] as const;

export class BenchmarkPackPersistenceIntegrityError extends Error {
  readonly code = "BENCHMARK_PACK_PERSISTENCE_INTEGRITY" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BenchmarkPackPersistenceIntegrityError";
  }
}

export interface BenchmarkExecutionPackPaths {
  readonly executionDirectory: string;
  readonly claimPath: string;
  readonly packPath: string;
}

export interface PersistBenchmarkExecutionPackInput {
  readonly outputDirectory: string;
  readonly pack: BenchmarkExecutionPack;
}

export interface PersistBenchmarkExecutionPackResult {
  readonly path: string;
  readonly created: boolean;
  readonly payloadSha256: string;
}

function integrity(message: string, cause?: unknown): BenchmarkPackPersistenceIntegrityError {
  return new BenchmarkPackPersistenceIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw integrity(`${label}는 lowercase SHA-256이어야 합니다.`);
  }
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const locked = [...expected].sort();
  if (actual.length !== locked.length || actual.some((key, index) => key !== locked[index])) {
    throw integrity(`${label}의 exact shape이 잠긴 계약과 다릅니다.`);
  }
}

function assertPackContract(pack: BenchmarkExecutionPack): void {
  assertExactKeys(pack, PACK_KEYS, "Benchmark 부모 팩");
  assertSha256(pack.execution_hash, "pack.execution_hash");
  assertSha256(pack.schedule_id, "pack.schedule_id");
  assertSha256(pack.evaluator_contract_hash, "pack.evaluator_contract_hash");
  assertSha256(
    pack.locked_challenge_pack_hash,
    "pack.locked_challenge_pack_hash",
  );
  assertSha256(
    pack.locked_challenge_contract_hash,
    "pack.locked_challenge_contract_hash",
  );
  assertSha256(
    pack.locked_challenge_source_manifest_hash,
    "pack.locked_challenge_source_manifest_hash",
  );
  if (
    pack.schema_version !== "benchmark-execution-pack-v1"
    || pack.artifact_kind !== "BENCHMARK_EXECUTION_PACK"
    || pack.source !== "RECORDED_BENCHMARK"
    || pack.execution_status !== "EXECUTION_COMPLETE"
    || pack.evaluation_status !== "EVALUATION_INCOMPLETE"
    || pack.review_status !== "NOT_GENERATED"
    || pack.baseline_version !== null
    || pack.synthetic !== true
    || ![
      "READY_FOR_JUDGE",
      "BLOCKED_BY_INTEGRITY",
      "INSUFFICIENT_VALID_OUTPUTS",
    ].includes(pack.judge_readiness)
  ) {
    throw integrity("Benchmark 부모 팩의 상태 계약이 잠긴 값과 다릅니다.");
  }
  assertExactKeys(pack.coverage, [
    "candidates",
    "cases",
    "expected_runs",
    "recorded_runs",
    "runs_per_case",
  ], "pack.coverage");
  if (
    pack.coverage.cases !== 12
    || pack.coverage.candidates !== 3
    || pack.coverage.runs_per_case !== 2
    || pack.coverage.expected_runs !== 72
    || pack.coverage.recorded_runs !== 72
    || !Array.isArray(pack.slots)
    || pack.slots.length !== 72
  ) {
    throw integrity("Benchmark 부모 팩은 정확히 12개 사례·3개 후보·2회 반복의 72 slot이어야 합니다.");
  }
  if (!Array.isArray(pack.candidate_aggregates) || pack.candidate_aggregates.length !== 3) {
    throw integrity("Benchmark 부모 팩에는 후보 A/B/C 집계가 각각 하나씩 필요합니다.");
  }
  const candidateIds = pack.candidate_aggregates
    .map((aggregate) => aggregate.candidate_id)
    .sort();
  if (candidateIds.join(",") !== "A,B,C") {
    throw integrity("Benchmark 부모 팩의 후보 집계 좌표가 A/B/C와 다릅니다.");
  }
}

async function assertExactFileBytes(filePath: string, expected: Buffer): Promise<void> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw integrity("기존 Benchmark 부모 팩 파일 형식 또는 권한이 올바르지 않습니다.");
    }
    const actual = await handle.readFile();
    if (!actual.equals(expected)) {
      throw integrity("같은 실행 경로의 기존 Benchmark 부모 팩 bytes가 일치하지 않습니다.");
    }
  } catch (error) {
    if (error instanceof BenchmarkPackPersistenceIntegrityError) throw error;
    throw integrity("기존 Benchmark 부모 팩 파일을 안전하게 검증할 수 없습니다.", error);
  } finally {
    await handle?.close();
  }
}

export function createBenchmarkExecutionPackPaths({
  outputDirectory,
  executionHash,
  payloadSha256,
}: {
  readonly outputDirectory: string;
  readonly executionHash: string;
  readonly payloadSha256: string;
}): BenchmarkExecutionPackPaths {
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) {
    throw integrity("Benchmark outputDirectory가 비어 있습니다.");
  }
  assertSha256(executionHash, "executionHash");
  assertSha256(payloadSha256, "payloadSha256");
  const executionDirectory = join(outputDirectory, executionHash);
  return Object.freeze({
    executionDirectory,
    claimPath: join(executionDirectory, "benchmark-execution-pack--claim.json"),
    packPath: join(
      executionDirectory,
      `benchmark-execution-pack--record-${payloadSha256}.json`,
    ),
  });
}

/**
 * 한 실행 hash에는 하나의 canonical 부모 팩만 허용합니다.
 * 고정 claim이 payload digest를 잠그고, record는 그 digest를 파일명에 포함합니다.
 */
export async function persistBenchmarkExecutionPack({
  outputDirectory,
  pack,
}: PersistBenchmarkExecutionPackInput): Promise<PersistBenchmarkExecutionPackResult> {
  // claim 경로를 만들기 전에 전체 72-slot chain 검증을 통과한 런타임 객체인지 확인합니다.
  assertValidatedBenchmarkExecutionPack(pack);
  let snapshot: BenchmarkExecutionPack;
  try {
    snapshot = JSON.parse(canonicalJsonStringify(pack)) as BenchmarkExecutionPack;
  } catch (error) {
    throw integrity("Benchmark 부모 팩을 canonical JSON snapshot으로 만들 수 없습니다.", error);
  }
  assertPackContract(snapshot);
  const payloadSha256 = sha256CanonicalJson(snapshot);
  const paths = createBenchmarkExecutionPackPaths({
    outputDirectory,
    executionHash: snapshot.execution_hash,
    payloadSha256,
  });
  const claim = Object.freeze({
    schema_version: "benchmark-execution-pack-claim-v1",
    artifact_kind: "BENCHMARK_EXECUTION_PACK_CLAIM",
    execution_hash: snapshot.execution_hash,
    payload_sha256: payloadSha256,
  });
  const claimBytes = Buffer.from(`${canonicalJsonStringify({
    payload_sha256: sha256CanonicalJson(claim),
    payload: claim,
  })}\n`, "utf8");
  const packBytes = Buffer.from(`${canonicalJsonStringify({
    payload_sha256: payloadSha256,
    payload: snapshot,
  })}\n`, "utf8");

  try {
    await prepareWriteOnceArtifactDirectory({
      rootDirectory: outputDirectory,
      artifactDirectory: paths.executionDirectory,
    });
    await persistWriteOnceFileWithClaim({
      filePath: paths.claimPath,
      bytes: claimBytes,
      assertExistingMatches: (path) => assertExactFileBytes(path, claimBytes),
      assertPublishedFile: (path) => assertExactFileBytes(path, claimBytes),
      requireTemporaryCleanup: true,
    });
    const persisted = await persistWriteOnceFileWithClaim({
      filePath: paths.packPath,
      bytes: packBytes,
      assertExistingMatches: (path) => assertExactFileBytes(path, packBytes),
      assertPublishedFile: (path) => assertExactFileBytes(path, packBytes),
      requireTemporaryCleanup: true,
    });
    return Object.freeze({
      path: persisted.path,
      created: persisted.created,
      payloadSha256,
    });
  } catch (error) {
    if (error instanceof BenchmarkPackPersistenceIntegrityError) throw error;
    throw integrity("Benchmark 부모 팩 claim 또는 record를 write-once 저장할 수 없습니다.", error);
  }
}

import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import { buildBenchmarkSchedule } from "../benchmark/schedule";
import { BENCHMARK_CASES } from "../data/benchmark";
import {
  parseBlindJudgeRunRecord,
  type BlindJudgeRunRecord,
} from "../judge/runJudge";
import type { BlindJudgeInput } from "../judge/buildJudgeInput";
import {
  validateExecutionBoundPrivateBlindMapping,
  type ExecutionBoundPrivateBlindMapping,
} from "../review/judgeEvidenceManifest";
import {
  assertAuthoritativeBlindingPrecommit,
} from "../review/judgeEvidencePrecommitPersistence";
import {
  assertValidatedBlindReviewQueue,
  buildBlindReviewQueue,
  type BlindReviewQueue,
  type BuildBlindReviewQueueInput,
  type ReviewQueueJudgeCase,
} from "../review/buildReviewQueue";
import {
  assertValidatedBenchmarkExecutionPack,
  buildBenchmarkExecutionPack,
  type BenchmarkExecutionPack,
} from "./benchmarkPack";
import {
  assertExistingCanonicalAuthorityPackDirectory,
  persistCanonicalAuthorityPack,
  readCanonicalAuthorityFile,
  type CanonicalAuthorityPackPaths,
} from "./authorityPackPersistence";
import { dirname, join, resolve } from "node:path";

const HIDDEN_CASE_IDS = Array.from(
  { length: 12 },
  (_, index) => `H-${String(index + 1).padStart(3, "0")}`,
);
const VALIDATED_JUDGE_EVIDENCE_PACKS = new WeakSet<object>();
const PERSISTED_JUDGE_EVIDENCE_PACKS = new WeakSet<object>();
const PERSISTING_JUDGE_EVIDENCE_PACKS = new WeakSet<object>();
const SHA256 = /^[a-f0-9]{64}$/;

type JsonRecord = Record<string, unknown>;

export class JudgeEvidencePackIntegrityError extends Error {
  readonly code = "JUDGE_EVIDENCE_PACK_INTEGRITY" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JudgeEvidencePackIntegrityError";
  }
}

export interface JudgeEvidencePackCase {
  readonly case_id: string;
  readonly judge_input_hash: string;
  readonly private_mapping_hash: string;
  readonly judge_receipt_hash: string;
  readonly judge_disposition: "COMPLETE" | "HUMAN_FALLBACK";
  readonly expected_blind_input: BlindJudgeInput;
  readonly private_mapping: ExecutionBoundPrivateBlindMapping;
  readonly judge_run_receipt: BlindJudgeRunRecord;
}

export interface EvaluationCostBoundary {
  readonly candidate_execution: {
    readonly currency: "USD";
    readonly accounted_runs: 72;
    readonly total_usd: number;
  };
  readonly auxiliary_judge: {
    readonly currency: "USD";
    readonly accounted_cases: 12;
    readonly total_usd: number;
  };
}

export interface JudgeEvidencePack {
  readonly schema_version: "judge-evidence-pack-v1";
  readonly artifact_kind: "JUDGE_EVIDENCE_PACK";
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
  readonly locked_challenge_pack_hash: string;
  readonly locked_challenge_contract_hash: string;
  readonly locked_challenge_source_manifest_hash: string;
  readonly authority_root_id: string;
  readonly authority_store_id: string;
  readonly precommit_manifest_digest: string;
  readonly precommit_manifest_hash: string;
  readonly master_blinding_seed_commitment: string;
  readonly queue_content_hash: string;
  readonly queue_set_order_hash: string;
  readonly coverage: {
    readonly expected_cases: 12;
    readonly recorded_cases: 12;
    readonly complete_judge_receipts: number;
    readonly complete_judge_cases: number;
    readonly human_fallback_judge_cases: number;
  };
  readonly costs: EvaluationCostBoundary;
  readonly cases: readonly JudgeEvidencePackCase[];
}

export interface BuildJudgeEvidencePackInput {
  readonly benchmarkPack: BenchmarkExecutionPack;
  readonly reviewQueueInput: BuildBlindReviewQueueInput;
  readonly blindReviewQueue: BlindReviewQueue;
}

export interface JudgeEvidencePackPaths extends CanonicalAuthorityPackPaths {}

export interface PersistJudgeEvidencePackResult {
  readonly path: string;
  readonly payloadSha256: string;
}

function integrity(message: string, cause?: unknown): JudgeEvidencePackIntegrityError {
  return new JudgeEvidencePackIntegrityError(
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

function sumCandidateCost(pack: BenchmarkExecutionPack): number {
  if (
    pack.candidate_aggregates.some((aggregate) => (
      aggregate.cost.accounted_runs !== 24
      || aggregate.cost.total_usd === null
    ))
  ) {
    throw integrity(
      "Recorded Benchmark 승격에는 후보 실행 72회의 완전한 비용 원장이 필요합니다.",
    );
  }
  return pack.candidate_aggregates.reduce(
    (total, aggregate) => total + aggregate.cost.total_usd!,
    0,
  );
}

function parseJudgeCase({
  rawCase,
  expectedCaseId,
  executionPackHash,
  reviewQueueInput,
}: {
  readonly rawCase: ReviewQueueJudgeCase;
  readonly expectedCaseId: string;
  readonly executionPackHash: string;
  readonly reviewQueueInput: BuildBlindReviewQueueInput;
}): JudgeEvidencePackCase {
  if (rawCase.case_id !== expectedCaseId) {
    throw integrity(
      "Judge case는 H-001부터 H-012까지 잠긴 순서로 정확히 한 번씩 필요합니다.",
    );
  }
  const manifest = reviewQueueInput.authoritative_blinding_precommit.manifest;
  const mapping = validateExecutionBoundPrivateBlindMapping({
    input: rawCase.private_mapping,
    expectedCaseId,
    expectedExecutionPackHash: executionPackHash,
    expectedMasterBlindingSeed:
      reviewQueueInput.private_blinding_context.master_blinding_seed,
    expectedMasterCommitment: manifest.master_blinding_seed_commitment,
  });
  const judgeInputHash = sha256CanonicalJson(rawCase.expected_blind_input);
  const binding = manifest.case_bindings.find(
    (item) => item.case_id === expectedCaseId,
  );
  if (
    binding === undefined
    || binding.judge_input_hash !== judgeInputHash
    || binding.private_mapping_hash !== mapping.private_mapping_hash
  ) {
    throw integrity(
      `${expectedCaseId} Judge input·private mapping이 권위 precommit과 다릅니다.`,
    );
  }
  const receipt = parseBlindJudgeRunRecord(
    rawCase.judge_run_receipt,
    rawCase.expected_blind_input,
    reviewQueueInput.authoritative_blinding_precommit,
  );
  if (receipt.costState !== "COMPLETE" || receipt.usageCost === null) {
    throw integrity(
      `${expectedCaseId} Judge receipt의 비용 무결성이 완전하지 않습니다.`,
    );
  }
  const judgeDisposition = receipt.judgeStatus === "JUDGE_COMPLETE"
    && receipt.result !== null
    ? "COMPLETE" as const
    : receipt.judgeStatus === "JUDGE_INCOMPLETE"
      && receipt.result === null
      && receipt.attempts.length > 0
      && receipt.attempts.every((attempt) => (
        attempt.requestDisposition === "RESPONSE_RECEIVED"
        && attempt.costState === "COMPLETE"
      ))
      ? "HUMAN_FALLBACK" as const
      : null;
  if (judgeDisposition === null) {
    throw integrity(
      `${expectedCaseId} Judge 실패는 안전한 RESPONSE_RECEIVED·완전 비용 사람 fallback 계약이 아닙니다.`,
    );
  }
  return deepFreeze({
    case_id: expectedCaseId,
    judge_input_hash: judgeInputHash,
    private_mapping_hash: mapping.private_mapping_hash,
    judge_receipt_hash: sha256CanonicalJson(receipt),
    judge_disposition: judgeDisposition,
    expected_blind_input: structuredClone(rawCase.expected_blind_input),
    private_mapping: structuredClone(mapping),
    judge_run_receipt: structuredClone(receipt),
  });
}

export function assertValidatedJudgeEvidencePack(
  value: unknown,
): asserts value is JudgeEvidencePack {
  if (
    typeof value !== "object"
    || value === null
    || !VALIDATED_JUDGE_EVIDENCE_PACKS.has(value)
  ) {
    throw integrity(
      "Judge Evidence Pack은 권위 입력 전체를 재검증한 build/load 결과여야 합니다.",
    );
  }
}

export function buildJudgeEvidencePack({
  benchmarkPack,
  reviewQueueInput,
  blindReviewQueue,
}: BuildJudgeEvidencePackInput): JudgeEvidencePack {
  assertValidatedBenchmarkExecutionPack(benchmarkPack);
  assertValidatedBlindReviewQueue(blindReviewQueue);
  const rebuiltBenchmarkPack = buildBenchmarkExecutionPack({
    executionIdentity: reviewQueueInput.execution_evidence.execution_identity,
    schedule: buildBenchmarkSchedule(BENCHMARK_CASES, ["A", "B", "C"]),
    completedSlots: reviewQueueInput.execution_evidence.completed_slots,
  });
  if (!same(rebuiltBenchmarkPack, benchmarkPack)) {
    throw integrity(
      "제시된 Benchmark Execution Pack이 review queue의 72-slot 권위 증거와 다릅니다.",
    );
  }
  const executionPackHash = sha256CanonicalJson(benchmarkPack);
  const manifest = assertAuthoritativeBlindingPrecommit({
    anchor: reviewQueueInput.authoritative_blinding_precommit,
    expectedExecutionPackHash: executionPackHash,
    masterBlindingSeed:
      reviewQueueInput.private_blinding_context.master_blinding_seed,
  });
  const rebuiltQueue = buildBlindReviewQueue(reviewQueueInput);
  if (
    !same(rebuiltQueue, blindReviewQueue)
    || blindReviewQueue.execution_pack_hash !== executionPackHash
  ) {
    throw integrity(
      "validated blind review queue가 동일 실행·precommit·Judge receipts에서 재생성되지 않습니다.",
    );
  }
  if (
    !Array.isArray(reviewQueueInput.judge_cases)
    || reviewQueueInput.judge_cases.length !== 12
  ) {
    throw integrity("Judge Evidence Pack에는 exact 12개 Judge case가 필요합니다.");
  }
  const cases = HIDDEN_CASE_IDS.map((caseId, index) => parseJudgeCase({
    rawCase: reviewQueueInput.judge_cases[index]!,
    expectedCaseId: caseId,
    executionPackHash,
    reviewQueueInput,
  }));
  const auxiliaryJudgeTotal = cases.reduce(
    (total, item) => total + item.judge_run_receipt.usageCost!.totalCostUsd,
    0,
  );
  const completeJudgeCases = cases.filter(
    (item) => item.judge_disposition === "COMPLETE",
  ).length;
  const humanFallbackJudgeCases = cases.length - completeJudgeCases;
  const pack: JudgeEvidencePack = deepFreeze({
    schema_version: "judge-evidence-pack-v1",
    artifact_kind: "JUDGE_EVIDENCE_PACK",
    source: "RECORDED_BENCHMARK",
    execution_status: "EXECUTION_COMPLETE",
    judge_status: humanFallbackJudgeCases === 0
      ? "JUDGE_COMPLETE"
      : "JUDGE_PARTIAL_HUMAN_FALLBACK",
    review_status: "REVIEW_PENDING",
    evaluation_status: "EVALUATION_INCOMPLETE",
    baseline_version: null,
    synthetic: true,
    execution_pack_hash: executionPackHash,
    locked_challenge_pack_hash: benchmarkPack.locked_challenge_pack_hash,
    locked_challenge_contract_hash:
      benchmarkPack.locked_challenge_contract_hash,
    locked_challenge_source_manifest_hash:
      benchmarkPack.locked_challenge_source_manifest_hash,
    authority_root_id:
      reviewQueueInput.authoritative_blinding_precommit.authority_root_id,
    authority_store_id:
      reviewQueueInput.authoritative_blinding_precommit.authority_store_id,
    precommit_manifest_digest:
      reviewQueueInput.authoritative_blinding_precommit.manifest_digest,
    precommit_manifest_hash: manifest.manifest_hash,
    master_blinding_seed_commitment:
      manifest.master_blinding_seed_commitment,
    queue_content_hash: blindReviewQueue.queue_content_hash,
    queue_set_order_hash: blindReviewQueue.queue_set_order_hash,
    coverage: {
      expected_cases: 12,
      recorded_cases: 12,
      complete_judge_receipts: completeJudgeCases,
      complete_judge_cases: completeJudgeCases,
      human_fallback_judge_cases: humanFallbackJudgeCases,
    },
    costs: {
      candidate_execution: {
        currency: "USD",
        accounted_runs: 72,
        total_usd: sumCandidateCost(benchmarkPack),
      },
      auxiliary_judge: {
        currency: "USD",
        accounted_cases: 12,
        total_usd: auxiliaryJudgeTotal,
      },
    },
    cases,
  });
  VALIDATED_JUDGE_EVIDENCE_PACKS.add(pack);
  return pack;
}

export function createJudgeEvidencePackPaths({
  outputDirectory,
  executionPackHash,
  payloadSha256,
}: {
  readonly outputDirectory: string;
  readonly executionPackHash: string;
  readonly payloadSha256: string;
}): JudgeEvidencePackPaths {
  if (
    typeof outputDirectory !== "string"
    || outputDirectory.length === 0
    || !SHA256.test(executionPackHash)
    || !SHA256.test(payloadSha256)
  ) {
    throw integrity("Judge Evidence Pack 경로 입력이 안전한 값이 아닙니다.");
  }
  const executionDirectory = join(outputDirectory, executionPackHash);
  return Object.freeze({
    outputDirectory,
    executionDirectory,
    claimPath: join(executionDirectory, "judge-evidence-pack--claim.json"),
    recordPath: join(
      executionDirectory,
      `judge-evidence-pack--record-${payloadSha256}.json`,
    ),
  });
}

function judgeEvidenceClaim(
  pack: JudgeEvidencePack,
  payloadSha256: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema_version: "judge-evidence-pack-claim-v1",
    artifact_kind: "JUDGE_EVIDENCE_PACK_CLAIM",
    execution_pack_hash: pack.execution_pack_hash,
    precommit_manifest_digest: pack.precommit_manifest_digest,
    precommit_manifest_hash: pack.precommit_manifest_hash,
    queue_content_hash: pack.queue_content_hash,
    queue_set_order_hash: pack.queue_set_order_hash,
    payload_sha256: payloadSha256,
  });
}

export async function persistJudgeEvidencePack({
  outputDirectory,
  pack,
}: {
  readonly outputDirectory: string;
  readonly pack: JudgeEvidencePack;
}): Promise<PersistJudgeEvidencePackResult> {
  assertValidatedJudgeEvidencePack(pack);
  if (
    PERSISTED_JUDGE_EVIDENCE_PACKS.has(pack)
    || PERSISTING_JUDGE_EVIDENCE_PACKS.has(pack)
  ) {
    throw integrity("동일 Judge Evidence Pack 객체의 persistence replay는 허용되지 않습니다.");
  }
  PERSISTING_JUDGE_EVIDENCE_PACKS.add(pack);
  try {
    const snapshot = JSON.parse(
      canonicalJsonStringify(pack),
    ) as JudgeEvidencePack;
    const payloadSha256 = sha256CanonicalJson(snapshot);
    const paths = createJudgeEvidencePackPaths({
      outputDirectory,
      executionPackHash: snapshot.execution_pack_hash,
      payloadSha256,
    });
    await persistCanonicalAuthorityPack({
      paths,
      claim: judgeEvidenceClaim(snapshot, payloadSha256),
      payload: snapshot,
      claimLocation: "Judge Evidence Pack claim",
      recordLocation: "Judge Evidence Pack record",
    });
    PERSISTED_JUDGE_EVIDENCE_PACKS.add(pack);
    return Object.freeze({ path: paths.recordPath, payloadSha256 });
  } catch (error) {
    if (error instanceof JudgeEvidencePackIntegrityError) throw error;
    throw integrity("Judge Evidence Pack을 atomic write-once 저장할 수 없습니다.", error);
  } finally {
    PERSISTING_JUDGE_EVIDENCE_PACKS.delete(pack);
  }
}

export async function loadJudgeEvidencePack({
  path,
  authority,
}: {
  readonly path: string;
  readonly authority: BuildJudgeEvidencePackInput;
}): Promise<JudgeEvidencePack> {
  const rebuilt = buildJudgeEvidencePack(authority);
  const payloadSha256 = sha256CanonicalJson(rebuilt);
  const outputDirectory = dirname(dirname(resolve(path)));
  const paths = createJudgeEvidencePackPaths({
    outputDirectory,
    executionPackHash: rebuilt.execution_pack_hash,
    payloadSha256,
  });
  if (resolve(path) !== resolve(paths.recordPath)) {
    throw integrity("Judge Evidence Pack path가 authoritative content-address와 다릅니다.");
  }
  await assertExistingCanonicalAuthorityPackDirectory(paths);
  await readCanonicalAuthorityFile({
    path: paths.claimPath,
    expectedPayload: judgeEvidenceClaim(rebuilt, payloadSha256),
    location: "Judge Evidence Pack claim",
  });
  await readCanonicalAuthorityFile({
    path: paths.recordPath,
    expectedPayload: rebuilt,
    location: "Judge Evidence Pack record",
  });
  return rebuilt;
}

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertValidatedRecordedBenchmarkPack,
  type RecordedBenchmarkPack,
} from "../pack/recordedBenchmarkPack";
import {
  assertExistingWriteOnceArtifactDirectory,
  persistWriteOnceFileWithClaim,
  prepareWriteOnceArtifactDirectory,
} from "../pack/persistence";
import {
  assertValidatedBlindReviewQueue,
  calculateBlindReviewQueueContentHash,
  calculateBlindReviewQueueSetOrderHash,
  type BlindReviewQueue,
} from "../review/buildReviewQueue";
import {
  assertValidatedAiPreReviewReceipt,
  type AiPreReviewReceipt,
} from "../review/preReviewReceipt";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MEMO_ID_PATTERN = /^pdm_[a-f0-9]{64}$/;
const VALIDATED_PROVISIONAL_DECISION_MEMO = Symbol(
  "ValidatedProvisionalDecisionMemo",
);
const VALIDATED_PROVISIONAL_DECISION_MEMOS = new WeakSet<object>();
const PERSISTED_PROVISIONAL_DECISION_MEMOS = new WeakSet<object>();
const SOURCE_RELOADED_PROVISIONAL_DECISION_MEMOS = new WeakSet<object>();
const PERSISTING_PROVISIONAL_DECISION_MEMOS = new WeakSet<object>();

type JsonRecord = Record<string, unknown>;

export interface ProvisionalDecisionMemo {
  readonly schema_version: "provisional-decision-memo-v1";
  readonly artifact_kind: "PROVISIONAL_DECISION_MEMO";
  readonly memo_id: `pdm_${string}`;
  readonly synthetic: true;
  readonly advisory_only: true;
  readonly human_confirmed: false;
  readonly memo_status:
    | "USER_CONFIRMATION_REQUIRED"
    | "USER_CONFIRMATION_BLOCKED";
  readonly recorded_benchmark_pack_hash: string;
  readonly ai_pre_review_receipt_hash: string;
  readonly judge_evidence_hash: string;
  readonly queue_content_hash: string;
  readonly queue_set_order_hash: string;
  readonly counts: {
    readonly total_items: number;
    readonly proposed_pass: number;
    readonly proposed_confirmed_fail: number;
    readonly abstain: number;
  };
  readonly evidence_handles: readonly `evh_${string}`[];
  readonly created_at: string;
}

export interface ProvisionalDecisionMemoPaths {
  readonly memoDirectory: string;
  readonly claimPath: string;
  readonly memoPath: string;
}

export interface PersistProvisionalDecisionMemoResult {
  readonly path: string;
  readonly created: true;
  readonly payloadSha256: string;
}

function readPlainRecord(value: unknown, location: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${location}은(는) plain 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${location}은(는) plain 객체여야 합니다.`);
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
    throw new TypeError(
      `${location}의 exact 계약이 다릅니다. 누락=${missing.join(",")} 추가=${additional.join(",")}`,
    );
  }
}

function assertSha256(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${location}는 64자리 소문자 SHA-256이어야 합니다.`);
  }
}

function assertIsoTimestamp(value: unknown, location: string): asserts value is string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${location}는 canonical ISO-8601 timestamp여야 합니다.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function validateSources({
  benchmarkPack,
  queue,
  preReviewReceipt,
}: {
  readonly benchmarkPack: RecordedBenchmarkPack;
  readonly queue: BlindReviewQueue;
  readonly preReviewReceipt: AiPreReviewReceipt;
}): {
  readonly packHash: string;
  readonly preReviewHash: string;
  readonly judgeEvidenceHash: string;
  readonly queueContentHash: string;
  readonly queueSetOrderHash: string;
} {
  assertValidatedRecordedBenchmarkPack(benchmarkPack);
  assertValidatedBlindReviewQueue(queue);
  assertValidatedAiPreReviewReceipt(preReviewReceipt);
  const packHash = sha256CanonicalJson(benchmarkPack);
  const judgeEvidenceHash = benchmarkPack.judge_evidence_pack_hash;
  const queueContentHash = calculateBlindReviewQueueContentHash(queue);
  const queueSetOrderHash = calculateBlindReviewQueueSetOrderHash(queue);
  if (
    queue !== benchmarkPack.blind_review_queue
    || queue.execution_pack_hash !== benchmarkPack.execution_pack_hash
    || preReviewReceipt.recorded_benchmark_pack_hash !== packHash
    || preReviewReceipt.judge_evidence_hash !== judgeEvidenceHash
    || preReviewReceipt.queue_content_hash !== queueContentHash
    || preReviewReceipt.queue_set_order_hash !== queueSetOrderHash
    || preReviewReceipt.items.length !== queue.items.length
    || preReviewReceipt.items.some(
      (item, index) => item.item_id !== queue.items[index].item_id,
    )
  ) {
    throw new TypeError(
      "Provisional Memo의 authoritative Benchmark·queue·pre-review artifact chain이 다릅니다.",
    );
  }
  return {
    packHash,
    preReviewHash: sha256CanonicalJson(preReviewReceipt),
    judgeEvidenceHash,
    queueContentHash,
    queueSetOrderHash,
  };
}

function memoIdFor(source: ReturnType<typeof validateSources>): `pdm_${string}` {
  return `pdm_${sha256CanonicalJson({
    schema_version: "provisional-decision-memo-authority-id-v1",
    recorded_benchmark_pack_hash: source.packHash,
    ai_pre_review_receipt_hash: source.preReviewHash,
    judge_evidence_hash: source.judgeEvidenceHash,
    queue_content_hash: source.queueContentHash,
    queue_set_order_hash: source.queueSetOrderHash,
  })}`;
}

function brandMemo(memo: ProvisionalDecisionMemo): ProvisionalDecisionMemo {
  Object.defineProperty(memo, VALIDATED_PROVISIONAL_DECISION_MEMO, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  VALIDATED_PROVISIONAL_DECISION_MEMOS.add(memo);
  return deepFreeze(memo);
}

export function assertValidatedProvisionalDecisionMemo(
  value: unknown,
): asserts value is ProvisionalDecisionMemo {
  if (
    typeof value !== "object"
    || value === null
    || !VALIDATED_PROVISIONAL_DECISION_MEMOS.has(value)
    || (value as Record<PropertyKey, unknown>)[VALIDATED_PROVISIONAL_DECISION_MEMO]
      !== true
    || !Object.isFrozen(value)
  ) {
    throw new TypeError(
      "Provisional Memo는 authoritative build/load가 만든 동일 validated 객체여야 합니다.",
    );
  }
}

export function assertPersistedProvisionalDecisionMemo(
  value: unknown,
): asserts value is ProvisionalDecisionMemo {
  assertValidatedProvisionalDecisionMemo(value);
  if (!SOURCE_RELOADED_PROVISIONAL_DECISION_MEMOS.has(value)) {
    throw new TypeError(
      "Provisional Memo 권위에는 write-once 저장 후 source에서 다시 로드한 persisted Memo가 필요합니다.",
    );
  }
}

export function buildProvisionalDecisionMemo({
  benchmarkPack,
  queue,
  preReviewReceipt,
  createdAt,
}: {
  readonly benchmarkPack: RecordedBenchmarkPack;
  readonly queue: BlindReviewQueue;
  readonly preReviewReceipt: AiPreReviewReceipt;
  readonly createdAt: string;
}): ProvisionalDecisionMemo {
  const source = validateSources({ benchmarkPack, queue, preReviewReceipt });
  assertIsoTimestamp(createdAt, "Provisional Memo.createdAt");
  const counts = {
    total_items: preReviewReceipt.items.length,
    proposed_pass: preReviewReceipt.items.filter(
      (item) => item.proposed_decision === "PROPOSED_PASS",
    ).length,
    proposed_confirmed_fail: preReviewReceipt.items.filter(
      (item) => item.proposed_decision === "PROPOSED_CONFIRMED_FAIL",
    ).length,
    abstain: preReviewReceipt.items.filter(
      (item) => item.proposed_decision === "ABSTAIN",
    ).length,
  };
  const evidenceHandles = [...new Set(
    preReviewReceipt.items.flatMap((item) => item.evidence_handles),
  )].sort() as `evh_${string}`[];
  const memo: ProvisionalDecisionMemo = {
    schema_version: "provisional-decision-memo-v1",
    artifact_kind: "PROVISIONAL_DECISION_MEMO",
    memo_id: memoIdFor(source),
    synthetic: true,
    advisory_only: true,
    human_confirmed: false,
    memo_status: preReviewReceipt.pre_review_status === "USER_CONFIRMATION_READY"
      ? "USER_CONFIRMATION_REQUIRED"
      : "USER_CONFIRMATION_BLOCKED",
    recorded_benchmark_pack_hash: source.packHash,
    ai_pre_review_receipt_hash: source.preReviewHash,
    judge_evidence_hash: source.judgeEvidenceHash,
    queue_content_hash: source.queueContentHash,
    queue_set_order_hash: source.queueSetOrderHash,
    counts,
    evidence_handles: evidenceHandles,
    created_at: createdAt,
  };
  return brandMemo(memo);
}

async function readSecureCanonicalFile(
  path: string,
  location: string,
  expectedNlink = 1,
): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== expectedNlink
    ) {
      throw new TypeError(
        `${location}는 nlink ${expectedNlink}인 regular 0600 파일이어야 합니다.`,
      );
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${location} symlink 또는 안전하지 않은 파일을 읽을 수 없습니다.`, {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

async function assertExactFileBytes(
  path: string,
  expected: Buffer,
  location: string,
  expectedNlink = 1,
): Promise<void> {
  const actual = await readSecureCanonicalFile(path, location, expectedNlink);
  if (!actual.equals(expected)) {
    throw new TypeError(`${location}의 기존 bytes가 authoritative canonical 내용과 일치하지 않습니다.`);
  }
}

export function createProvisionalDecisionMemoPaths({
  outputDirectory,
  memoId,
  payloadSha256,
}: {
  readonly outputDirectory: string;
  readonly memoId: string;
  readonly payloadSha256: string;
}): ProvisionalDecisionMemoPaths {
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) {
    throw new TypeError("Provisional Memo outputDirectory가 비어 있습니다.");
  }
  if (!MEMO_ID_PATTERN.test(memoId)) {
    throw new TypeError("Provisional Memo ID가 안전한 content-addressed ID가 아닙니다.");
  }
  assertSha256(payloadSha256, "Provisional Memo payloadSha256");
  const memoDirectory = join(outputDirectory, memoId);
  return Object.freeze({
    memoDirectory,
    claimPath: join(memoDirectory, "provisional-decision-memo--claim.json"),
    memoPath: join(
      memoDirectory,
      `provisional-decision-memo--record-${payloadSha256}.json`,
    ),
  });
}

export async function persistProvisionalDecisionMemo({
  outputDirectory,
  memo,
}: {
  readonly outputDirectory: string;
  readonly memo: ProvisionalDecisionMemo;
}): Promise<PersistProvisionalDecisionMemoResult> {
  assertValidatedProvisionalDecisionMemo(memo);
  if (
    PERSISTED_PROVISIONAL_DECISION_MEMOS.has(memo)
    || PERSISTING_PROVISIONAL_DECISION_MEMOS.has(memo)
  ) {
    throw new TypeError("동일 Provisional Memo 객체의 persistence replay는 허용되지 않습니다.");
  }
  PERSISTING_PROVISIONAL_DECISION_MEMOS.add(memo);
  try {
    const snapshot = JSON.parse(canonicalJsonStringify(memo)) as ProvisionalDecisionMemo;
    const payloadSha256 = sha256CanonicalJson(snapshot);
    const paths = createProvisionalDecisionMemoPaths({
      outputDirectory,
      memoId: snapshot.memo_id,
      payloadSha256,
    });
    await prepareWriteOnceArtifactDirectory({
      rootDirectory: outputDirectory,
      artifactDirectory: paths.memoDirectory,
    });
    const claim = {
      schema_version: "provisional-decision-memo-claim-v1",
      artifact_kind: "PROVISIONAL_DECISION_MEMO_CLAIM",
      memo_id: snapshot.memo_id,
      payload_sha256: payloadSha256,
    };
    const claimBytes = Buffer.from(`${canonicalJsonStringify({
      payload_sha256: sha256CanonicalJson(claim),
      payload: claim,
    })}\n`, "utf8");
    const memoBytes = Buffer.from(`${canonicalJsonStringify({
      payload_sha256: payloadSha256,
      payload: snapshot,
    })}\n`, "utf8");
    const claimResult = await persistWriteOnceFileWithClaim({
      filePath: paths.claimPath,
      bytes: claimBytes,
      assertExistingMatches: (path) => assertExactFileBytes(
        path,
        claimBytes,
        "Provisional Memo claim",
      ),
      assertPublishedFile: (path) => assertExactFileBytes(
        path,
        claimBytes,
        "Provisional Memo claim",
      ),
      requireTemporaryCleanup: true,
    });
    if (!claimResult.created) {
      throw new TypeError("Provisional Memo claim은 이미 존재하므로 replay할 수 없습니다.");
    }
    const recordResult = await persistWriteOnceFileWithClaim({
      filePath: paths.memoPath,
      bytes: memoBytes,
      assertExistingMatches: (path) => assertExactFileBytes(
        path,
        memoBytes,
        "Provisional Memo record",
      ),
      assertPublishedFile: (path) => assertExactFileBytes(
        path,
        memoBytes,
        "Provisional Memo record",
      ),
      requireTemporaryCleanup: true,
    });
    if (!recordResult.created) {
      throw new TypeError("Provisional Memo record가 이미 존재합니다.");
    }
    PERSISTED_PROVISIONAL_DECISION_MEMOS.add(memo);
    return Object.freeze({
      path: paths.memoPath,
      created: true,
      payloadSha256,
    });
  } finally {
    PERSISTING_PROVISIONAL_DECISION_MEMOS.delete(memo);
  }
}

function parsePersistedMemo(
  value: unknown,
  sources: {
    readonly benchmarkPack: RecordedBenchmarkPack;
    readonly queue: BlindReviewQueue;
    readonly preReviewReceipt: AiPreReviewReceipt;
  },
): ProvisionalDecisionMemo {
  const wrapper = readPlainRecord(value, "Provisional Memo persisted wrapper");
  assertExactKeys(wrapper, ["payload_sha256", "payload"], "Provisional Memo persisted wrapper");
  assertSha256(wrapper.payload_sha256, "Provisional Memo persisted payload hash");
  const payload = readPlainRecord(wrapper.payload, "Provisional Memo persisted payload");
  assertExactKeys(payload, [
    "schema_version",
    "artifact_kind",
    "memo_id",
    "synthetic",
    "advisory_only",
    "human_confirmed",
    "memo_status",
    "recorded_benchmark_pack_hash",
    "ai_pre_review_receipt_hash",
    "judge_evidence_hash",
    "queue_content_hash",
    "queue_set_order_hash",
    "counts",
    "evidence_handles",
    "created_at",
  ], "Provisional Memo persisted payload");
  if (
    payload.schema_version !== "provisional-decision-memo-v1"
    || payload.artifact_kind !== "PROVISIONAL_DECISION_MEMO"
    || typeof payload.memo_id !== "string"
    || !MEMO_ID_PATTERN.test(payload.memo_id)
    || payload.synthetic !== true
    || payload.advisory_only !== true
    || payload.human_confirmed !== false
    || typeof payload.created_at !== "string"
    || sha256CanonicalJson(payload) !== wrapper.payload_sha256
  ) {
    throw new TypeError("Provisional Memo persisted payload 무결성 또는 상태 계약이 다릅니다.");
  }
  const snapshot = payload as unknown as ProvisionalDecisionMemo;
  const rebuilt = buildProvisionalDecisionMemo({
    ...sources,
    createdAt: snapshot.created_at,
  });
  if (canonicalJsonStringify(rebuilt) !== canonicalJsonStringify(snapshot)) {
    throw new TypeError("Provisional Memo persisted 내용이 authoritative source와 다릅니다.");
  }
  return rebuilt;
}

export async function loadProvisionalDecisionMemo({
  path,
  benchmarkPack,
  queue,
  preReviewReceipt,
}: {
  readonly path: string;
  readonly benchmarkPack: RecordedBenchmarkPack;
  readonly queue: BlindReviewQueue;
  readonly preReviewReceipt: AiPreReviewReceipt;
}): Promise<ProvisionalDecisionMemo> {
  validateSources({ benchmarkPack, queue, preReviewReceipt });
  await assertExistingWriteOnceArtifactDirectory({
    rootDirectory: resolve(path, "..", ".."),
    artifactDirectory: resolve(path, ".."),
  });
  const bytes = await readSecureCanonicalFile(path, "Provisional Memo record");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new TypeError("Provisional Memo JSON을 해석할 수 없습니다.", { cause: error });
  }
  const memo = parsePersistedMemo(parsed, {
    benchmarkPack,
    queue,
    preReviewReceipt,
  });
  const payloadSha256 = sha256CanonicalJson(memo);
  const expectedPaths = createProvisionalDecisionMemoPaths({
    outputDirectory: resolve(path, "..", ".."),
    memoId: memo.memo_id,
    payloadSha256,
  });
  if (resolve(path) !== resolve(expectedPaths.memoPath)) {
    throw new TypeError("Provisional Memo path가 content-addressed 경로와 다릅니다.");
  }
  const claim = {
    schema_version: "provisional-decision-memo-claim-v1",
    artifact_kind: "PROVISIONAL_DECISION_MEMO_CLAIM",
    memo_id: memo.memo_id,
    payload_sha256: payloadSha256,
  };
  const claimBytes = Buffer.from(`${canonicalJsonStringify({
    payload_sha256: sha256CanonicalJson(claim),
    payload: claim,
  })}\n`, "utf8");
  await assertExactFileBytes(
    expectedPaths.claimPath,
    claimBytes,
    "Provisional Memo claim",
  );
  const canonicalBytes = Buffer.from(`${canonicalJsonStringify({
    payload_sha256: payloadSha256,
    payload: JSON.parse(canonicalJsonStringify(memo)),
  })}\n`, "utf8");
  if (!bytes.equals(canonicalBytes)) {
    throw new TypeError("Provisional Memo bytes가 canonical 형식과 다릅니다.");
  }
  SOURCE_RELOADED_PROVISIONAL_DECISION_MEMOS.add(memo);
  return memo;
}

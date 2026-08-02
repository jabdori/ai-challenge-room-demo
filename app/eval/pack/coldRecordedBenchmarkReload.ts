import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { buildBenchmarkSchedule } from "../benchmark/schedule";
import {
  loadBenchmarkExecutionIdentityAuthority,
  type BenchmarkExecutionIdentityAuthorityReference,
} from "../benchmark/identity";
import type { LockedChallengePack } from "../define/defineContracts";
import { BENCHMARK_CASES } from "../data/benchmark";
import {
  promoteRecordedBenchmarkWithAdapter,
} from "./promoteRecordedBenchmark";
import type { BenchmarkEvidenceReloadPlan } from "./loadBenchmarkExecutionEvidence";
import { rehydrateBenchmarkExecutionPack } from "./loadBenchmarkExecutionEvidence";
import {
  loadRecordedBenchmarkPack,
  type RecordedBenchmarkPack,
} from "./recordedBenchmarkPack";
import { canonicalJsonStringify, sha256CanonicalJson } from "../runtime/canonicalJson";
import type { JudgeAdapter } from "../judge/openaiJudgeAdapter";
import {
  createAuthoritativeBlindingPrecommitReference,
  loadAuthoritativeBlindingPrecommitFromReference,
  loadAuthoritativeBlindingPrecommitFromReferenceForTest,
  type AuthoritativeBlindingPrecommitReference,
  type AuthoritativeBlindingPrecommitStore,
} from "../review/judgeEvidencePrecommitPersistence";
import {
  createAuthoritativePrivateBlindingContextReference,
  loadAuthoritativePrivateBlindingContextFromReference,
  loadAuthoritativePrivateBlindingContextFromReferenceForTest,
  type AuthoritativePrivateBlindingContextReference,
} from "../review/privateBlindingSeedPersistence";
import { buildMasterBlindingSeedCommitment } from "../review/judgeEvidenceManifest";

const SHA256 = /^[a-f0-9]{64}$/;

export class ColdRecordedBenchmarkReloadIntegrityError extends Error {
  readonly code = "COLD_RECORDED_BENCHMARK_RELOAD_INTEGRITY" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

function integrity(message: string, cause?: unknown): never {
  throw new ColdRecordedBenchmarkReloadIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

async function secureDirectory(path: string, label: string): Promise<string> {
  try {
    const stat = await lstat(path);
    const canonical = await realpath(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
      integrity(`${label}은 symlink가 아닌 0700 directory여야 합니다.`);
    }
    return canonical;
  } catch (error) {
    if (error instanceof ColdRecordedBenchmarkReloadIntegrityError) throw error;
    return integrity(`${label}을 안전하게 열 수 없습니다.`, error);
  }
}

async function loadCanonicalRecordedPack({
  outputDirectory,
  path,
  payloadSha256,
}: {
  readonly outputDirectory: string;
  readonly path: string;
  readonly payloadSha256: string;
}): Promise<RecordedBenchmarkPack> {
  if (!SHA256.test(payloadSha256)) integrity("recorded pack expected hash가 유효하지 않습니다.");
  const root = await secureDirectory(outputDirectory, "recorded benchmark output root");
  const resolvedPath = resolve(path);
  if (relative(root, resolvedPath).startsWith("..")) {
    integrity("recorded pack path가 authority root 밖을 가리킵니다.");
  }
  await secureDirectory(dirname(resolvedPath), "recorded pack directory");
  let handle;
  try {
    handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
      integrity("recorded pack record는 nlink1 regular 0600 file이어야 합니다.");
    }
    const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!isRecord(parsed) || Object.keys(parsed).sort().join(",") !== "payload,payload_sha256"
      || parsed.payload_sha256 !== payloadSha256 || !isRecord(parsed.payload)
      || sha256CanonicalJson(parsed.payload) !== payloadSha256) {
      integrity("recorded pack wrapper의 hash 또는 exact schema가 다릅니다.");
    }
    return parsed.payload as unknown as RecordedBenchmarkPack;
  } catch (error) {
    if (error instanceof ColdRecordedBenchmarkReloadIntegrityError) throw error;
    return integrity("recorded pack canonical record를 안전하게 읽을 수 없습니다.", error);
  } finally {
    await handle?.close();
  }
}

/**
 * durable completion binding만 가진 새 프로세스가 canonical parent에서
 * 비공개 seed·precommit 권위 좌표를 결정적으로 복구한 뒤 72+12 ledger를
 * 다시 검증하는 진입점입니다. 새 provider 호출은 허용하지 않습니다.
 */
export async function reloadCompletedRecordedBenchmarkPackForColdStart({
  outputDirectory,
  recordedPackPath,
  recordedPackHash,
  executionIdentityAuthority,
  lockedChallengePack,
  plans,
  onUnexpectedJudgeProviderInvocation,
}: {
  readonly outputDirectory: string;
  readonly recordedPackPath: string;
  readonly recordedPackHash: string;
  readonly executionIdentityAuthority:
    BenchmarkExecutionIdentityAuthorityReference;
  readonly lockedChallengePack: Pick<
    LockedChallengePack,
    | "locked_challenge_pack_hash"
    | "approved_contract_hash"
    | "source_manifest_hash"
  >;
  readonly plans: readonly BenchmarkEvidenceReloadPlan[];
  readonly onUnexpectedJudgeProviderInvocation?: () => void;
}): Promise<RecordedBenchmarkPack> {
  const expected = await loadCanonicalRecordedPack({
    outputDirectory,
    path: recordedPackPath,
    payloadSha256: recordedPackHash,
  });
  return reloadRecordedBenchmarkPackForColdStart({
    outputDirectory,
    recordedPackPath,
    recordedPackHash,
    executionIdentityAuthority,
    lockedChallengePack,
    plans,
    privateBlindingSeedAuthority:
      createAuthoritativePrivateBlindingContextReference({
        executionPackHash: expected.execution_pack_hash,
      }),
    judgeEvidencePrecommitAuthority:
      createAuthoritativeBlindingPrecommitReference({
        executionPackHash: expected.execution_pack_hash,
        manifestDigest: expected.precommit_manifest_digest,
        manifestHash: expected.precommit_manifest_hash,
      }),
    ...(onUnexpectedJudgeProviderInvocation
      ? { onUnexpectedJudgeProviderInvocation }
      : {}),
  });
}

interface ColdRecordedBenchmarkReloadOptions {
  readonly outputDirectory: string;
  readonly recordedPackPath: string;
  readonly recordedPackHash: string;
  readonly executionIdentityAuthority:
    BenchmarkExecutionIdentityAuthorityReference;
  readonly lockedChallengePack: Pick<
    LockedChallengePack,
    | "locked_challenge_pack_hash"
    | "approved_contract_hash"
    | "source_manifest_hash"
  >;
  readonly plans: readonly BenchmarkEvidenceReloadPlan[];
  readonly privateBlindingSeedAuthority:
    AuthoritativePrivateBlindingContextReference;
  readonly judgeEvidencePrecommitAuthority:
    AuthoritativeBlindingPrecommitReference;
  /** 테스트에서 cold path의 provider 재호출을 계수하는 read-only hook입니다. */
  readonly onUnexpectedJudgeProviderInvocation?: () => void;
}

interface ColdRecordedBenchmarkAuthorityLoaders {
  readonly loadPrivateBlindingContext:
    typeof loadAuthoritativePrivateBlindingContextFromReference;
  readonly loadAuthoritativePrecommit:
    typeof loadAuthoritativeBlindingPrecommitFromReference;
}

async function reloadRecordedBenchmarkPackForColdStartCore({
  outputDirectory,
  recordedPackPath,
  recordedPackHash,
  executionIdentityAuthority,
  lockedChallengePack,
  plans,
  privateBlindingSeedAuthority,
  judgeEvidencePrecommitAuthority,
  onUnexpectedJudgeProviderInvocation,
  loadPrivateBlindingContext,
  loadAuthoritativePrecommit,
}: ColdRecordedBenchmarkReloadOptions
  & ColdRecordedBenchmarkAuthorityLoaders): Promise<RecordedBenchmarkPack> {
  const expected = await loadCanonicalRecordedPack({
    outputDirectory,
    path: recordedPackPath,
    payloadSha256: recordedPackHash,
  });
  const schedule = buildBenchmarkSchedule(BENCHMARK_CASES, ["A", "B", "C"]);
  const executionIdentity = await loadBenchmarkExecutionIdentityAuthority({
    outputDirectory,
    authority: executionIdentityAuthority,
    lockedChallengePack,
    expectedScheduleId: schedule.schedule_id,
  });
  const { benchmarkPack } = await rehydrateBenchmarkExecutionPack({
    outputDirectory,
    expectedBenchmarkPack: expected.benchmark_execution_pack,
    executionIdentity,
    schedule,
    plans,
  });
  const noNetworkJudge: JudgeAdapter = {
    invoke: async () => {
      onUnexpectedJudgeProviderInvocation?.();
      return integrity("cold reload은 새 Judge provider 호출을 허용하지 않습니다.");
    },
  };
  const executionPackHash = sha256CanonicalJson(benchmarkPack);
  const privateBlindingContext = await loadPrivateBlindingContext({
    reference: privateBlindingSeedAuthority,
  });
  const authoritativePrecommit = await loadAuthoritativePrecommit({
    reference: judgeEvidencePrecommitAuthority,
  });
  if (
    privateBlindingContext.execution_pack_hash !== executionPackHash
    || authoritativePrecommit.execution_pack_hash !== executionPackHash
    || authoritativePrecommit.manifest_digest
      !== expected.precommit_manifest_digest
    || authoritativePrecommit.manifest.manifest_hash
      !== expected.precommit_manifest_hash
    || authoritativePrecommit.manifest.master_blinding_seed_commitment
      !== buildMasterBlindingSeedCommitment({
        executionPackHash,
        masterBlindingSeed: privateBlindingContext.master_blinding_seed,
      })
  ) {
    integrity(
      "cold reload의 private seed·precommit provenance가 recorded parent와 다릅니다.",
    );
  }
  const rebuilt = await promoteRecordedBenchmarkWithAdapter({
    outputDirectory,
    benchmarkPack,
    executionIdentity,
    schedule,
    plans,
    judgeAdapter: noNetworkJudge,
    // cold reload은 원본 authority를 새로 만들지 않습니다. promotion kernel은
    // source-reload한 branded precommit만 받아 canonical manifest를 대조합니다.
    privateBlindingContext,
    authoritativePrecommit,
  });
  if (canonicalJsonStringify(rebuilt.pack) !== canonicalJsonStringify(expected)) {
    integrity("cold source-reload한 recorded pack이 canonical parent record와 다릅니다.");
  }
  const sourceReloaded = await loadRecordedBenchmarkPack({
    path: recordedPackPath,
    authority: {
      benchmarkPack,
      judgeEvidencePack: rebuilt.pack.judge_evidence_pack,
      blindReviewQueue: rebuilt.pack.blind_review_queue,
    },
  });
  if (canonicalJsonStringify(sourceReloaded) !== canonicalJsonStringify(expected)) {
    integrity("source-reloaded Recorded Benchmark parent가 canonical cold source와 다릅니다.");
  }
  return sourceReloaded;
}

/**
 * restart 전용 production cold loader입니다. 저장된 parent JSON을 신뢰하지
 * 않고 production seed·precommit authority에서 72+12 증거를 재검증합니다.
 */
export function reloadRecordedBenchmarkPackForColdStart(
  input: ColdRecordedBenchmarkReloadOptions,
): Promise<RecordedBenchmarkPack> {
  return reloadRecordedBenchmarkPackForColdStartCore({
    ...input,
    loadPrivateBlindingContext:
      loadAuthoritativePrivateBlindingContextFromReference,
    loadAuthoritativePrecommit:
      loadAuthoritativeBlindingPrecommitFromReference,
  });
}

/**
 * 통합 테스트 root의 TEST_ONLY seed·precommit authority만 읽는 cold loader
 * seam입니다. Production entrypoint와 기본 loader 계약은 변경하지 않습니다.
 */
export function reloadRecordedBenchmarkPackForColdStartForTest({
  privateBlindingSeedRootDirectory,
  judgeEvidencePrecommitStore,
  ...input
}: ColdRecordedBenchmarkReloadOptions & {
  readonly privateBlindingSeedRootDirectory: string;
  readonly judgeEvidencePrecommitStore:
    AuthoritativeBlindingPrecommitStore;
}): Promise<RecordedBenchmarkPack> {
  return reloadRecordedBenchmarkPackForColdStartCore({
    ...input,
    loadPrivateBlindingContext: ({ reference }) => (
      loadAuthoritativePrivateBlindingContextFromReferenceForTest({
        reference,
        rootDirectory: privateBlindingSeedRootDirectory,
      })
    ),
    loadAuthoritativePrecommit: ({ reference }) => (
      loadAuthoritativeBlindingPrecommitFromReferenceForTest({
        reference,
        store: judgeEvidencePrecommitStore,
      })
    ),
  });
}

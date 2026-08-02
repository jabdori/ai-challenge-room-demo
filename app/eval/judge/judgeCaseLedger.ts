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
import {
  basename,
  dirname,
  join,
  resolve,
} from "node:path";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  assertAuthoritativeBlindingPrecommitCaseBinding,
  type AuthoritativeBlindingPrecommit,
} from "../review/judgeEvidencePrecommitPersistence";
import {
  JUDGE_PRICING_SNAPSHOT,
  parseBlindJudgeRunRecord,
  runBlindJudge,
  type BlindJudgeRunRecord,
} from "./runJudge";
import type { BlindJudgeInput } from "./buildJudgeInput";
import {
  OPENAI_JUDGE_REQUEST_CONTRACT,
  OPENAI_JUDGE_RESPONSE_FORMAT,
  type JudgeAdapter,
} from "./openaiJudgeAdapter";

const SHA256 = /^[a-f0-9]{64}$/;

type JsonRecord = Record<string, unknown>;

export class JudgeCaseLedgerIntegrityError extends Error {
  readonly code = "JUDGE_CASE_LEDGER_INTEGRITY" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JudgeCaseLedgerIntegrityError";
  }
}

export class JudgeCaseAmbiguousInFlightError extends Error {
  readonly code = "JUDGE_CASE_AMBIGUOUS_IN_FLIGHT" as const;
  readonly allowRemoteCall = false as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(readonly caseId: string) {
    super(
      `${caseId} Judge intent만 존재해 원격 결과가 불명확하므로 자동 재호출할 수 없습니다.`,
    );
    this.name = "JudgeCaseAmbiguousInFlightError";
  }
}

export interface BlindJudgeCaseIntent {
  readonly schema_version: "blind-judge-case-intent-v1";
  readonly artifact_kind: "BLIND_JUDGE_CASE_INTENT";
  readonly execution_pack_hash: string;
  readonly precommit_manifest_digest: string;
  readonly precommit_manifest_hash: string;
  readonly precommit_case_binding_hash: string;
  readonly case_id: string;
  readonly judge_input_hash: string;
  readonly request_contract_hash: string;
  readonly output_schema_hash: string;
  readonly pricing_snapshot_hash: string;
}

export interface BlindJudgeCaseReceipt {
  readonly schema_version: "blind-judge-case-receipt-v1";
  readonly artifact_kind: "BLIND_JUDGE_CASE_RECEIPT";
  readonly execution_pack_hash: string;
  readonly case_id: string;
  readonly intent_payload_sha256: string;
  readonly judge_run_receipt: BlindJudgeRunRecord;
}

export interface BlindJudgeCaseDispatch {
  readonly schema_version: "blind-judge-case-dispatch-v1";
  readonly artifact_kind: "BLIND_JUDGE_CASE_DISPATCH";
  readonly execution_pack_hash: string;
  readonly case_id: string;
  readonly intent_payload_sha256: string;
}

export interface BlindJudgeCaseCheckpoint {
  readonly schema_version: "blind-judge-case-checkpoint-v1";
  readonly artifact_kind: "BLIND_JUDGE_CASE_CHECKPOINT";
  readonly execution_pack_hash: string;
  readonly case_id: string;
  readonly intent_payload_sha256: string;
  readonly receipt_payload_sha256: string;
  readonly judge_status: "JUDGE_COMPLETE" | "JUDGE_INCOMPLETE";
  readonly cost_state: "COMPLETE" | "COST_INCOMPLETE";
  readonly usage_cost: BlindJudgeRunRecord["usageCost"];
  readonly total_latency_ms: number;
  readonly terminal_request_dispositions: readonly string[];
}

export interface BlindJudgeCaseArtifactPaths {
  readonly outputDirectory: string;
  readonly ledgerDirectory: string;
  readonly executionDirectory: string;
  readonly intentPath: string;
  readonly dispatchPath: string;
  readonly receiptPath: string;
  readonly checkpointPath: string;
}

export interface BlindJudgeCaseLedgerResult {
  readonly source:
    | "EXECUTED"
    | "REUSED_CHECKPOINT"
    | "RECOMPUTED_CHECKPOINT";
  readonly intent: BlindJudgeCaseIntent;
  readonly receipt: BlindJudgeCaseReceipt;
  readonly checkpoint: BlindJudgeCaseCheckpoint;
  readonly judgeRunReceipt: BlindJudgeRunRecord;
}

function integrity(
  message: string,
  cause?: unknown,
): JudgeCaseLedgerIntegrityError {
  return new JudgeCaseLedgerIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

async function assertDirectory(directory: string, location: string): Promise<void> {
  let stat;
  let canonical;
  try {
    stat = await lstat(directory);
    canonical = await realpath(directory);
  } catch (error) {
    throw integrity(`${location} 디렉터리를 검증할 수 없습니다.`, error);
  }
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== 0o700
    || canonical !== resolve(directory)
  ) {
    throw integrity(
      `${location}은 ancestor symlink가 없는 정확한 0700 디렉터리여야 합니다.`,
    );
  }
}

async function ensureChild(
  parent: string,
  child: string,
  location: string,
): Promise<void> {
  if (resolve(dirname(child)) !== resolve(parent)) {
    throw integrity(`${location}은 검증된 parent의 직접 하위여야 합니다.`);
  }
  await assertDirectory(parent, `${location} parent`);
  try {
    await mkdir(child, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) {
      throw integrity(`${location}을 만들 수 없습니다.`, error);
    }
  }
  await assertDirectory(child, location);
}

async function preparePaths(paths: BlindJudgeCaseArtifactPaths): Promise<void> {
  await assertDirectory(paths.outputDirectory, "Judge ledger output root");
  await ensureChild(
    paths.outputDirectory,
    paths.ledgerDirectory,
    "Judge ledger",
  );
  await ensureChild(
    paths.ledgerDirectory,
    paths.executionDirectory,
    "Judge ledger execution",
  );
}

function wrapperBytes(payload: unknown): Buffer {
  return Buffer.from(`${canonicalJsonStringify({
    payload_sha256: sha256CanonicalJson(payload),
    payload,
  })}\n`, "utf8");
}

async function readExact<T>({
  path,
  expected,
  location,
}: {
  readonly path: string;
  readonly expected: T;
  readonly location: string;
}): Promise<T> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== 1
    ) {
      throw integrity(`${location}은 link count 1의 regular 0600 file이어야 합니다.`);
    }
    const bytes = await handle.readFile();
    if (!bytes.equals(wrapperBytes(expected))) {
      throw integrity(`${location} canonical bytes 또는 payload hash가 다릅니다.`);
    }
    return JSON.parse(canonicalJsonStringify(expected)) as T;
  } catch (error) {
    if (error instanceof JudgeCaseLedgerIntegrityError) throw error;
    throw integrity(`${location}을 안전하게 읽을 수 없습니다.`, error);
  } finally {
    await handle?.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw integrity("Judge ledger artifact 존재 여부를 검증할 수 없습니다.", error);
  }
}

async function publish({
  path,
  payload,
  location,
}: {
  readonly path: string;
  readonly payload: unknown;
  readonly location: string;
}): Promise<boolean> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let temporaryCreated = false;
  let created = false;
  try {
    const temporary = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await temporary.writeFile(wrapperBytes(payload));
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    try {
      await link(temporaryPath, path);
      created = true;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw integrity(`${location}을 atomic write-once 공개할 수 없습니다.`, error);
      }
    }
  } finally {
    if (temporaryCreated) {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        throw integrity(`${location} 임시 파일을 정리할 수 없습니다.`, error);
      }
    }
  }
  await readExact({ path, expected: payload, location });
  return created;
}

export function createBlindJudgeCaseArtifactPaths({
  outputDirectory,
  executionPackHash,
  caseId,
  requestContractHash = sha256CanonicalJson(OPENAI_JUDGE_REQUEST_CONTRACT),
}: {
  readonly outputDirectory: string;
  readonly executionPackHash: string;
  readonly caseId: string;
  readonly requestContractHash?: string;
}): BlindJudgeCaseArtifactPaths {
  if (
    !SHA256.test(executionPackHash)
    || !SHA256.test(requestContractHash)
    || !/^H-(?:00[1-9]|01[0-2])$/.test(caseId)
  ) {
    throw integrity(
      "Judge ledger execution·request contract hash 또는 hidden case ID가 올바르지 않습니다.",
    );
  }
  const ledgerDirectory = join(outputDirectory, "judge-case-ledger");
  // 후보 실행 증거는 그대로 재사용하되 Judge 요청 계약이 바뀌면 이전
  // write-once receipt를 덮지 않는 별도 평가 revision을 만듭니다.
  const executionDirectory = join(
    ledgerDirectory,
    `${executionPackHash}--${requestContractHash}`,
  );
  return Object.freeze({
    outputDirectory,
    ledgerDirectory,
    executionDirectory,
    intentPath: join(executionDirectory, `judge-case--${caseId}--intent.json`),
    dispatchPath: join(
      executionDirectory,
      `judge-case--${caseId}--dispatch.json`,
    ),
    receiptPath: join(executionDirectory, `judge-case--${caseId}--receipt.json`),
    checkpointPath: join(
      executionDirectory,
      `judge-case--${caseId}--checkpoint.json`,
    ),
  });
}

function buildIntent(
  input: BlindJudgeInput,
  authoritativePrecommit: AuthoritativeBlindingPrecommit,
): BlindJudgeCaseIntent {
  const binding = assertAuthoritativeBlindingPrecommitCaseBinding({
    anchor: authoritativePrecommit,
    expectedCaseId: input.case_id,
    expectedJudgeInputHash: sha256CanonicalJson(input),
  });
  return deepFreeze({
    schema_version: "blind-judge-case-intent-v1",
    artifact_kind: "BLIND_JUDGE_CASE_INTENT",
    execution_pack_hash: binding.executionPackHash,
    precommit_manifest_digest: binding.precommitManifestDigest,
    precommit_manifest_hash: binding.precommitManifestHash,
    precommit_case_binding_hash: binding.precommitCaseBindingHash,
    case_id: binding.caseId,
    judge_input_hash: binding.judgeInputHash,
    request_contract_hash: sha256CanonicalJson(OPENAI_JUDGE_REQUEST_CONTRACT),
    output_schema_hash: sha256CanonicalJson(
      OPENAI_JUDGE_RESPONSE_FORMAT.schema,
    ),
    pricing_snapshot_hash: sha256CanonicalJson(JUDGE_PRICING_SNAPSHOT),
  });
}

function buildReceipt(
  intent: BlindJudgeCaseIntent,
  run: BlindJudgeRunRecord,
): BlindJudgeCaseReceipt {
  return deepFreeze({
    schema_version: "blind-judge-case-receipt-v1",
    artifact_kind: "BLIND_JUDGE_CASE_RECEIPT",
    execution_pack_hash: intent.execution_pack_hash,
    case_id: intent.case_id,
    intent_payload_sha256: sha256CanonicalJson(intent),
    judge_run_receipt: structuredClone(run),
  });
}

function buildCheckpoint(
  intent: BlindJudgeCaseIntent,
  receipt: BlindJudgeCaseReceipt,
): BlindJudgeCaseCheckpoint {
  const run = receipt.judge_run_receipt;
  return deepFreeze({
    schema_version: "blind-judge-case-checkpoint-v1",
    artifact_kind: "BLIND_JUDGE_CASE_CHECKPOINT",
    execution_pack_hash: intent.execution_pack_hash,
    case_id: intent.case_id,
    intent_payload_sha256: sha256CanonicalJson(intent),
    receipt_payload_sha256: sha256CanonicalJson(receipt),
    judge_status: run.judgeStatus,
    cost_state: run.costState,
    usage_cost: structuredClone(run.usageCost),
    total_latency_ms: run.totalLatencyMs,
    terminal_request_dispositions: run.attempts.map(
      (attempt) => attempt.requestDisposition,
    ),
  });
}

async function loadReceipt({
  paths,
  intent,
  input,
  authoritativePrecommit,
}: {
  readonly paths: BlindJudgeCaseArtifactPaths;
  readonly intent: BlindJudgeCaseIntent;
  readonly input: BlindJudgeInput;
  readonly authoritativePrecommit: AuthoritativeBlindingPrecommit;
}): Promise<BlindJudgeCaseReceipt> {
  let handle;
  let rawWrapper: unknown;
  let rawBytes: Buffer | undefined;
  try {
    handle = await open(
      paths.receiptPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
      throw integrity("Judge case receipt는 link count 1의 regular 0600 file이어야 합니다.");
    }
    rawBytes = await handle.readFile();
    rawWrapper = JSON.parse(rawBytes.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof JudgeCaseLedgerIntegrityError) throw error;
    throw integrity("Judge case receipt를 읽을 수 없습니다.", error);
  } finally {
    await handle?.close();
  }
  if (
    typeof rawWrapper !== "object"
    || rawWrapper === null
    || Array.isArray(rawWrapper)
  ) throw integrity("Judge case receipt wrapper가 올바르지 않습니다.");
  const wrapper = rawWrapper as JsonRecord;
  if (Object.keys(wrapper).sort().join(",") !== "payload,payload_sha256") {
    throw integrity("Judge case receipt wrapper exact shape이 다릅니다.");
  }
  const raw = wrapper.payload;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw integrity("Judge case receipt payload가 올바르지 않습니다.");
  }
  const record = raw as JsonRecord;
  if (
    Object.keys(record).sort().join(",")
      !== "artifact_kind,case_id,execution_pack_hash,intent_payload_sha256,judge_run_receipt,schema_version"
    || record.schema_version !== "blind-judge-case-receipt-v1"
    || record.artifact_kind !== "BLIND_JUDGE_CASE_RECEIPT"
    || record.execution_pack_hash !== intent.execution_pack_hash
    || record.case_id !== intent.case_id
    || record.intent_payload_sha256 !== sha256CanonicalJson(intent)
  ) {
    throw integrity("Judge case receipt identity 또는 exact shape이 다릅니다.");
  }
  const run = parseBlindJudgeRunRecord(
    record.judge_run_receipt,
    input,
    authoritativePrecommit,
  );
  const receipt = buildReceipt(intent, run);
  if (
    wrapper.payload_sha256 !== sha256CanonicalJson(receipt)
    || rawBytes === undefined
    || !rawBytes.equals(wrapperBytes(receipt))
  ) {
    throw integrity("Judge case receipt canonical hash chain이 다릅니다.");
  }
  return receipt;
}

async function loadOrRebuildCheckpoint({
  paths,
  intent,
  receipt,
}: {
  readonly paths: BlindJudgeCaseArtifactPaths;
  readonly intent: BlindJudgeCaseIntent;
  readonly receipt: BlindJudgeCaseReceipt;
}): Promise<{
  checkpoint: BlindJudgeCaseCheckpoint;
  source: "REUSED_CHECKPOINT" | "RECOMPUTED_CHECKPOINT";
}> {
  const expected = buildCheckpoint(intent, receipt);
  if (await exists(paths.checkpointPath)) {
    await readExact({
      path: paths.checkpointPath,
      expected,
      location: "Judge case checkpoint",
    });
    return { checkpoint: expected, source: "REUSED_CHECKPOINT" };
  }
  await publish({
    path: paths.checkpointPath,
    payload: expected,
    location: "Judge case checkpoint",
  });
  return { checkpoint: expected, source: "RECOMPUTED_CHECKPOINT" };
}

export async function claimBlindJudgeCaseIntent({
  outputDirectory,
  input,
  authoritativePrecommit,
}: {
  readonly outputDirectory: string;
  readonly input: BlindJudgeInput;
  readonly authoritativePrecommit: AuthoritativeBlindingPrecommit;
}): Promise<{
  readonly intent: BlindJudgeCaseIntent;
  readonly paths: BlindJudgeCaseArtifactPaths;
  readonly allowRemoteCall: boolean;
}> {
  const intent = buildIntent(input, authoritativePrecommit);
  const paths = createBlindJudgeCaseArtifactPaths({
    outputDirectory,
    executionPackHash: intent.execution_pack_hash,
    caseId: intent.case_id,
    requestContractHash: intent.request_contract_hash,
  });
  await preparePaths(paths);
  const created = await publish({
    path: paths.intentPath,
    payload: intent,
    location: "Judge case intent",
  });
  return Object.freeze({ intent, paths, allowRemoteCall: created });
}

export async function claimBlindJudgeCaseDispatch({
  intent,
  paths,
}: {
  readonly intent: BlindJudgeCaseIntent;
  readonly paths: BlindJudgeCaseArtifactPaths;
}): Promise<boolean> {
  const dispatch: BlindJudgeCaseDispatch = deepFreeze({
    schema_version: "blind-judge-case-dispatch-v1",
    artifact_kind: "BLIND_JUDGE_CASE_DISPATCH",
    execution_pack_hash: intent.execution_pack_hash,
    case_id: intent.case_id,
    intent_payload_sha256: sha256CanonicalJson(intent),
  });
  return publish({
    path: paths.dispatchPath,
    payload: dispatch,
    location: "Judge case dispatch",
  });
}

export async function runOrResumeBlindJudgeCase({
  outputDirectory,
  input,
  authoritativePrecommit,
  adapter,
  signal,
}: {
  readonly outputDirectory: string;
  readonly input: BlindJudgeInput;
  readonly authoritativePrecommit: AuthoritativeBlindingPrecommit;
  readonly adapter: JudgeAdapter;
  readonly signal?: AbortSignal;
}): Promise<BlindJudgeCaseLedgerResult> {
  const claimed = await claimBlindJudgeCaseIntent({
    outputDirectory,
    input,
    authoritativePrecommit,
  });
  if (await exists(claimed.paths.receiptPath)) {
    const receipt = await loadReceipt({
      paths: claimed.paths,
      intent: claimed.intent,
      input,
      authoritativePrecommit,
    });
    const checkpoint = await loadOrRebuildCheckpoint({
      paths: claimed.paths,
      intent: claimed.intent,
      receipt,
    });
    return deepFreeze({
      source: checkpoint.source,
      intent: claimed.intent,
      receipt,
      checkpoint: checkpoint.checkpoint,
      judgeRunReceipt: receipt.judge_run_receipt,
    });
  }
  // intent는 원격 호출 전 입력을 잠글 뿐입니다. 별도 dispatch claim이
  // 생성된 뒤 receipt가 없을 때만 호출 결과가 불명확한 상태입니다.
  const dispatchCreated = await claimBlindJudgeCaseDispatch(claimed);
  if (!dispatchCreated) {
    throw new JudgeCaseAmbiguousInFlightError(input.case_id);
  }

  const run = await runBlindJudge({
    adapter,
    input,
    authoritativeBlindingPrecommit: authoritativePrecommit,
    ...(signal ? { signal } : {}),
  });
  const receipt = buildReceipt(claimed.intent, run);
  await publish({
    path: claimed.paths.receiptPath,
    payload: receipt,
    location: "Judge case receipt",
  });
  const checkpoint = buildCheckpoint(claimed.intent, receipt);
  await publish({
    path: claimed.paths.checkpointPath,
    payload: checkpoint,
    location: "Judge case checkpoint",
  });
  const persistedReceipt = await loadReceipt({
    paths: claimed.paths,
    intent: claimed.intent,
    input,
    authoritativePrecommit,
  });
  await readExact({
    path: claimed.paths.checkpointPath,
    expected: buildCheckpoint(claimed.intent, persistedReceipt),
    location: "Judge case checkpoint",
  });
  return deepFreeze({
    source: "EXECUTED",
    intent: claimed.intent,
    receipt: persistedReceipt,
    checkpoint: buildCheckpoint(claimed.intent, persistedReceipt),
    judgeRunReceipt: persistedReceipt.judge_run_receipt,
  });
}

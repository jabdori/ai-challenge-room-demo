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
import {
  buildMutationFailureEvidence,
  validateStoredMutationFailureEvidence,
  type MutationFailureClassification,
  type MutationFailureEvidence,
} from "./mutationFailureEvidence";
import type {
  ChallengeMutationCommand,
  ChallengeMutationResult,
} from "./challengeServer";

const SAFE_KEY = /^mutation_[A-Za-z0-9_-]{3,120}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class MutationJournalIntegrityError extends Error {
  readonly code = "MUTATION_JOURNAL_INTEGRITY" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MutationJournalIntegrityError";
  }
}

export class AmbiguousMutationError extends Error {
  readonly code = "MUTATION_AMBIGUOUS" as const;
  readonly allowSideEffect = false as const;

  constructor(readonly idempotencyKey: string) {
    super(
      `${idempotencyKey} intent만 존재해 side effect 결과가 불명확하므로 자동 재호출할 수 없습니다.`,
    );
    this.name = "AmbiguousMutationError";
  }
}

export class ReplayedMutationError extends Error {
  readonly code = "MUTATION_REPLAYED" as const;
  readonly allowSideEffect = false as const;

  constructor(readonly idempotencyKey: string) {
    super(`${idempotencyKey} mutation은 이미 종결됐습니다.`);
    this.name = "ReplayedMutationError";
  }
}

export class ReplayedMutationFailureError extends Error {
  readonly code = "MUTATION_FAILURE_REPLAYED" as const;
  readonly allowSideEffect = false as const;

  constructor(
    readonly idempotencyKey: string,
    readonly classification: MutationFailureClassification,
    readonly failureReceiptHash: string | null,
  ) {
    super(`${idempotencyKey} mutation의 제한된 실패 분류가 이미 기록됐습니다.`);
    this.name = "ReplayedMutationFailureError";
  }
}

export interface MutationJournalPaths {
  readonly rootDirectory: string;
  readonly mutationDirectory: string;
  readonly intentPath: string;
  readonly receiptPath: string;
}

interface MutationIntent {
  readonly schema_version: "api-mutation-intent-v1";
  readonly artifact_kind: "API_MUTATION_INTENT";
  readonly idempotency_key: string;
  readonly command_schema_version: string;
  readonly target_id: string;
  readonly expected_source_hash: string;
  readonly command_hash: string;
}

type MutationReceipt =
  | {
    readonly schema_version: "api-mutation-receipt-v1";
    readonly artifact_kind: "API_MUTATION_RECEIPT";
    readonly idempotency_key: string;
    readonly intent_payload_sha256: string;
    readonly status: "SUCCEEDED";
    readonly source_hash: string;
    readonly result_hash: string;
    readonly error_code: null;
  }
  | {
    readonly schema_version: "api-mutation-receipt-v1";
    readonly artifact_kind: "API_MUTATION_RECEIPT";
    readonly idempotency_key: string;
    readonly intent_payload_sha256: string;
    readonly status: "FAILED";
    readonly source_hash: null;
    readonly result_hash: null;
    readonly error_code: "SIDE_EFFECT_FAILED";
    readonly failure_receipt_hash?: never;
    readonly failure_classification?: never;
  }
  | {
    readonly schema_version: "api-mutation-receipt-v1";
    readonly artifact_kind: "API_MUTATION_RECEIPT";
    readonly idempotency_key: string;
    readonly intent_payload_sha256: string;
    readonly status: "FAILED";
    readonly source_hash: null;
    readonly result_hash: null;
    readonly error_code: "FINAL_DECISION_MEMO_OPENAI_ERROR";
    readonly failure_receipt_hash: string;
    readonly failure_classification: MutationFailureClassification;
  };

interface MutationFailureReceipt extends MutationFailureEvidence {
  readonly schema_version: "api-mutation-failure-receipt-v1";
  readonly artifact_kind: "API_MUTATION_FAILURE_RECEIPT";
  readonly idempotency_key: string;
  readonly intent_payload_sha256: string;
}

function integrity(message: string, cause?: unknown): MutationJournalIntegrityError {
  return new MutationJournalIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function wrapperBytes(payload: unknown): Buffer {
  return Buffer.from(`${canonicalJsonStringify({
    payload_sha256: sha256CanonicalJson(payload),
    payload,
  })}\n`, "utf8");
}

async function assertSecureDirectory(
  directory: string,
  location: string,
): Promise<void> {
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
    || stat.nlink < 2
    || canonical !== resolve(directory)
  ) {
    throw integrity(
      `${location}은 symlink가 아닌 link count 2 이상의 정확한 0700 디렉터리여야 합니다.`,
    );
  }
}

async function readExact(
  path: string,
  expected: Buffer,
  location: string,
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
      throw integrity(`${location}은 link count 1의 regular 0600 파일이어야 합니다.`);
    }
    const actual = await handle.readFile();
    if (!actual.equals(expected)) {
      throw integrity(`${location}의 canonical bytes 또는 payload hash가 다릅니다.`);
    }
  } catch (error) {
    if (error instanceof MutationJournalIntegrityError) throw error;
    throw integrity(`${location}을 symlink 없이 읽을 수 없습니다.`, error);
  } finally {
    await handle?.close();
  }
}

async function readSecurePayload(
  path: string,
  location: string,
): Promise<{ readonly payload_sha256: string; readonly payload: unknown }> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== 1
    ) {
      throw integrity(`${location}은 link count 1의 regular 0600 파일이어야 합니다.`);
    }
    const raw = await handle.readFile("utf8");
    const wrapper = JSON.parse(raw) as unknown;
    if (
      typeof wrapper !== "object"
      || wrapper === null
      || Array.isArray(wrapper)
      || Object.getPrototypeOf(wrapper) !== Object.prototype
      || Object.keys(wrapper).length !== 2
      || !Object.hasOwn(wrapper, "payload_sha256")
      || !Object.hasOwn(wrapper, "payload")
    ) {
      throw integrity(`${location} wrapper의 exact 계약이 다릅니다.`);
    }
    const value = wrapper as {
      readonly payload_sha256?: unknown;
      readonly payload?: unknown;
    };
    if (
      typeof value.payload_sha256 !== "string"
      || !SHA256.test(value.payload_sha256)
      || value.payload_sha256 !== sha256CanonicalJson(value.payload)
      || raw !== wrapperBytes(value.payload).toString("utf8")
    ) {
      throw integrity(`${location}의 canonical bytes 또는 payload hash가 다릅니다.`);
    }
    return Object.freeze({
      payload_sha256: value.payload_sha256,
      payload: value.payload,
    });
  } catch (error) {
    if (error instanceof MutationJournalIntegrityError) throw error;
    throw integrity(`${location}을 안전하게 source-load할 수 없습니다.`, error);
  } finally {
    await handle?.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    await handle.sync();
  } catch (error) {
    throw integrity("mutation directory를 fsync할 수 없습니다.", error);
  } finally {
    await handle?.close();
  }
}

async function publishWriteOnce(
  path: string,
  bytes: Buffer,
  location: string,
): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let temporaryCreated = false;
  try {
    const temporary = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await temporary.writeFile(bytes);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (hasCode(error, "EEXIST")) {
        throw integrity(`${location}은 이미 존재합니다.`, error);
      }
      throw integrity(`${location}을 atomic write-once 공개할 수 없습니다.`, error);
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
  await syncDirectory(dirname(path));
  await readExact(path, bytes, location);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw integrity("mutation artifact 존재 여부를 검증할 수 없습니다.", error);
  }
}

function buildIntent(command: ChallengeMutationCommand): MutationIntent {
  if (
    !SAFE_KEY.test(command.idempotency_key)
    || !SHA256.test(command.expected_source_hash)
  ) {
    throw integrity("mutation key 또는 source hash가 안전한 계약과 다릅니다.");
  }
  return Object.freeze({
    schema_version: "api-mutation-intent-v1",
    artifact_kind: "API_MUTATION_INTENT",
    idempotency_key: command.idempotency_key,
    command_schema_version: command.schema_version,
    target_id: command.target_id,
    expected_source_hash: command.expected_source_hash,
    command_hash: sha256CanonicalJson(command),
  });
}

function successReceipt(
  intent: MutationIntent,
  result: ChallengeMutationResult,
): MutationReceipt {
  if (
    result.accepted !== true
    || typeof result.source_hash !== "string"
    || !SHA256.test(result.source_hash)
  ) {
    throw integrity("mutation side effect 결과가 권위 source hash를 제공하지 않습니다.");
  }
  return Object.freeze({
    schema_version: "api-mutation-receipt-v1",
    artifact_kind: "API_MUTATION_RECEIPT",
    idempotency_key: intent.idempotency_key,
    intent_payload_sha256: sha256CanonicalJson(intent),
    status: "SUCCEEDED",
    source_hash: result.source_hash,
    result_hash: sha256CanonicalJson(result),
    error_code: null,
  });
}

function failureReceipt(intent: MutationIntent): MutationReceipt {
  return Object.freeze({
    schema_version: "api-mutation-receipt-v1",
    artifact_kind: "API_MUTATION_RECEIPT",
    idempotency_key: intent.idempotency_key,
    intent_payload_sha256: sha256CanonicalJson(intent),
    status: "FAILED",
    source_hash: null,
    result_hash: null,
    error_code: "SIDE_EFFECT_FAILED",
  });
}

function detailedFailureReceipt(
  intent: MutationIntent,
  failureReceiptHash: string,
  classification: MutationFailureClassification,
): MutationReceipt {
  return Object.freeze({
    schema_version: "api-mutation-receipt-v1",
    artifact_kind: "API_MUTATION_RECEIPT",
    idempotency_key: intent.idempotency_key,
    intent_payload_sha256: sha256CanonicalJson(intent),
    status: "FAILED",
    source_hash: null,
    result_hash: null,
    error_code: "FINAL_DECISION_MEMO_OPENAI_ERROR",
    failure_receipt_hash: failureReceiptHash,
    failure_classification: classification,
  });
}

function buildFailureReceipt(
  intent: MutationIntent,
  evidence: MutationFailureEvidence,
): MutationFailureReceipt {
  return Object.freeze({
    schema_version: "api-mutation-failure-receipt-v1",
    artifact_kind: "API_MUTATION_FAILURE_RECEIPT",
    idempotency_key: intent.idempotency_key,
    intent_payload_sha256: sha256CanonicalJson(intent),
    ...structuredClone(evidence),
  });
}

/**
 * HTTP 경계가 raw provider 세부정보를 노출하지 않고도, 같은 durable failure
 * receipt를 가리킬 수 있도록 content-addressed hash만 계산합니다.
 */
export function mutationFailureReceiptHash(
  command: ChallengeMutationCommand,
  evidence: MutationFailureEvidence,
): string {
  return sha256CanonicalJson(buildFailureReceipt(buildIntent(command), evidence));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readRecordedFailureReference(
  value: unknown,
  intent: MutationIntent,
): {
  readonly hash: string;
  readonly classification: MutationFailureClassification;
} | null {
  if (!isPlainRecord(value)) {
    throw integrity("기존 mutation receipt payload가 plain 객체가 아닙니다.");
  }
  if (
    value.schema_version !== "api-mutation-receipt-v1"
    || value.artifact_kind !== "API_MUTATION_RECEIPT"
    || value.idempotency_key !== intent.idempotency_key
    || value.intent_payload_sha256 !== sha256CanonicalJson(intent)
  ) {
    throw integrity("기존 mutation receipt의 intent 결합이 다릅니다.");
  }
  const baseKeys = new Set([
    "schema_version",
    "artifact_kind",
    "idempotency_key",
    "intent_payload_sha256",
    "status",
    "source_hash",
    "result_hash",
    "error_code",
  ]);
  if (value.status === "SUCCEEDED") {
    if (
      Object.keys(value).length !== baseKeys.size
      || Object.keys(value).some((key) => !baseKeys.has(key))
      || typeof value.source_hash !== "string"
      || !SHA256.test(value.source_hash)
      || typeof value.result_hash !== "string"
      || !SHA256.test(value.result_hash)
      || value.error_code !== null
    ) {
      throw integrity("기존 성공 mutation receipt의 exact 계약이 다릅니다.");
    }
    return null;
  }
  if (value.status !== "FAILED") {
    throw integrity("기존 mutation receipt status가 제한된 계약과 다릅니다.");
  }
  if (value.error_code === "SIDE_EFFECT_FAILED") {
    if (
      Object.keys(value).length !== baseKeys.size
      || Object.keys(value).some((key) => !baseKeys.has(key))
      || value.source_hash !== null
      || value.result_hash !== null
    ) {
      throw integrity("기존 generic 실패 mutation receipt의 exact 계약이 다릅니다.");
    }
    return null;
  }
  const detailedKeys = new Set([
    ...baseKeys,
    "failure_receipt_hash",
    "failure_classification",
  ]);
  if (
    Object.keys(value).length !== detailedKeys.size
    || Object.keys(value).some((key) => !detailedKeys.has(key))
    || value.error_code !== "FINAL_DECISION_MEMO_OPENAI_ERROR"
    || value.source_hash !== null
    || value.result_hash !== null
    || typeof value.failure_receipt_hash !== "string"
    || !SHA256.test(value.failure_receipt_hash)
    || (
      value.failure_classification !== "PROVIDER_TEMPORARY_FAILURE"
      && value.failure_classification !== "PROVIDER_TERMINAL_FAILURE"
      && value.failure_classification !== "EVALUATION_INCOMPLETE"
    )
  ) {
    throw integrity("기존 mutation 실패 receipt 참조가 제한된 계약과 다릅니다.");
  }
  return Object.freeze({
    hash: value.failure_receipt_hash,
    classification: value.failure_classification,
  });
}

function assertRecordedFailurePayload(
  value: unknown,
  {
    intent,
    expectedHash,
    expectedClassification,
  }: {
    readonly intent: MutationIntent;
    readonly expectedHash: string;
    readonly expectedClassification: MutationFailureClassification;
  },
): void {
  const expectedKeys = new Set([
    "schema_version",
    "artifact_kind",
    "idempotency_key",
    "intent_payload_sha256",
    "error_code",
    "evaluation_status",
    "kind",
    "classification",
    "attempts",
    "provider_response",
    "cost_completeness",
  ]);
  if (
    !isPlainRecord(value)
    || Object.keys(value).length !== expectedKeys.size
    || Object.keys(value).some((key) => !expectedKeys.has(key))
    || sha256CanonicalJson(value) !== expectedHash
    || value.schema_version !== "api-mutation-failure-receipt-v1"
    || value.artifact_kind !== "API_MUTATION_FAILURE_RECEIPT"
    || value.idempotency_key !== intent.idempotency_key
    || value.intent_payload_sha256 !== sha256CanonicalJson(intent)
    || value.error_code !== "FINAL_DECISION_MEMO_OPENAI_ERROR"
    || value.evaluation_status !== "EVALUATION_INCOMPLETE"
    || value.classification !== expectedClassification
    || validateStoredMutationFailureEvidence({
      error_code: value.error_code,
      evaluation_status: value.evaluation_status,
      kind: value.kind,
      classification: value.classification,
      attempts: value.attempts,
      provider_response: value.provider_response,
      cost_completeness: value.cost_completeness,
    }) === null
  ) {
    throw integrity("기존 content-addressed mutation 실패 receipt가 손상됐습니다.");
  }
}

export class FileMutationJournal {
  readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    if (typeof rootDirectory !== "string" || rootDirectory.length === 0) {
      throw integrity("mutation journal root가 비어 있습니다.");
    }
    this.rootDirectory = resolve(rootDirectory);
  }

  pathsFor(command: ChallengeMutationCommand): MutationJournalPaths {
    if (!SAFE_KEY.test(command.idempotency_key)) {
      throw integrity("mutation idempotency key가 안전하지 않습니다.");
    }
    const mutationDirectory = join(
      this.rootDirectory,
      command.idempotency_key,
    );
    return Object.freeze({
      rootDirectory: this.rootDirectory,
      mutationDirectory,
      intentPath: join(mutationDirectory, "mutation--intent.json"),
      receiptPath: join(mutationDirectory, "mutation--receipt.json"),
    });
  }

  intentBytesFor(command: ChallengeMutationCommand): Buffer {
    return wrapperBytes(buildIntent(command));
  }

  async execute(
    command: ChallengeMutationCommand,
    operation: () => Promise<ChallengeMutationResult>,
  ): Promise<ChallengeMutationResult> {
    if (typeof operation !== "function") {
      throw integrity("mutation side effect operation이 필요합니다.");
    }
    const intent = buildIntent(command);
    const intentBytes = wrapperBytes(intent);
    const paths = this.pathsFor(command);
    const rootParentDirectory = dirname(this.rootDirectory);
    const rootName = basename(this.rootDirectory);
    if (
      rootName === "."
      || rootName === ".."
      || join(rootParentDirectory, rootName) !== this.rootDirectory
    ) {
      throw integrity("mutation journal root가 검증된 parent 밖으로 벗어납니다.");
    }
    // root를 만들기 전에 이미 존재하는 부모 디렉터리를 strict 검증합니다.
    // recursive mkdir는 조상 symlink를 따라 외부 filesystem을 바꿀 수 있으므로
    // 사용하지 않습니다.
    await assertSecureDirectory(
      rootParentDirectory,
      "mutation journal root parent",
    );
    let createdRoot = false;
    try {
      await mkdir(this.rootDirectory, { recursive: false, mode: 0o700 });
      createdRoot = true;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw integrity("mutation journal root를 exclusive create할 수 없습니다.", error);
      }
    }
    await assertSecureDirectory(this.rootDirectory, "mutation journal root");
    if (createdRoot) {
      await syncDirectory(rootParentDirectory);
    }

    let ownsIntent = false;
    try {
      await mkdir(paths.mutationDirectory, { recursive: false, mode: 0o700 });
      ownsIntent = true;
      await syncDirectory(this.rootDirectory);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw integrity("mutation directory를 exclusive create할 수 없습니다.", error);
      }
    }
    await assertSecureDirectory(paths.mutationDirectory, "mutation record");

    if (!ownsIntent) {
      if (!(await pathExists(paths.intentPath))) {
        throw new AmbiguousMutationError(command.idempotency_key);
      }
      await readExact(paths.intentPath, intentBytes, "기존 mutation intent");
      if (await pathExists(paths.receiptPath)) {
        const recorded = await readSecurePayload(
          paths.receiptPath,
          "기존 mutation receipt",
        );
        const failure = readRecordedFailureReference(recorded.payload, intent);
        if (failure !== null) {
          const failurePath = join(
            paths.mutationDirectory,
            `mutation--failure-receipt--${failure.hash}.json`,
          );
          const storedFailure = await readSecurePayload(
            failurePath,
            "기존 content-addressed mutation 실패 receipt",
          );
          if (storedFailure.payload_sha256 !== failure.hash) {
            throw integrity(
              "기존 content-addressed mutation 실패 receipt filename hash가 다릅니다.",
            );
          }
          assertRecordedFailurePayload(storedFailure.payload, {
            intent,
            expectedHash: failure.hash,
            expectedClassification: failure.classification,
          });
          throw new ReplayedMutationFailureError(
            command.idempotency_key,
            failure.classification,
            failure.hash,
          );
        }
        throw new ReplayedMutationError(command.idempotency_key);
      }
      throw new AmbiguousMutationError(command.idempotency_key);
    }

    try {
      await publishWriteOnce(paths.intentPath, intentBytes, "mutation intent");
    } catch (error) {
      // 디렉터리를 선점했지만 intent durable write가 실패한 상태는 자동 재호출할 수 없습니다.
      throw error;
    }

    let result: ChallengeMutationResult;
    try {
      result = await operation();
    } catch (error) {
      const evidence = buildMutationFailureEvidence(error);
      let receipt: MutationReceipt;
      if (evidence === null) {
        receipt = failureReceipt(intent);
      } else {
        const contentAddressedReceipt = buildFailureReceipt(intent, evidence);
        const contentAddressedHash =
          sha256CanonicalJson(contentAddressedReceipt);
        await publishWriteOnce(
          join(
            paths.mutationDirectory,
            `mutation--failure-receipt--${contentAddressedHash}.json`,
          ),
          wrapperBytes(contentAddressedReceipt),
          "content-addressed mutation 실패 receipt",
        );
        receipt = detailedFailureReceipt(
          intent,
          contentAddressedHash,
          evidence.classification,
        );
      }
      await publishWriteOnce(
        paths.receiptPath,
        wrapperBytes(receipt),
        "실패 mutation receipt",
      );
      throw error;
    }

    const receipt = successReceipt(intent, result);
    await publishWriteOnce(
      paths.receiptPath,
      wrapperBytes(receipt),
      "성공 mutation receipt",
    );
    return Object.freeze(structuredClone(result));
  }
}

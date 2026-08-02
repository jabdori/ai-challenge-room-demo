import { toFile } from "openai";
import type { FileCreateParams as UploadedFileCreateParams } from "openai/resources/files";
import type {
  FileCreateParams as VectorStoreFileCreateParams,
  FileRetrieveParams as VectorStoreFileRetrieveParams,
  FileUpdateParams as VectorStoreFileUpdateParams,
} from "openai/resources/vector-stores/files";
import type {
  FileBatchCreateParams as VectorStoreFileBatchCreateParams,
  FileBatchRetrieveParams as VectorStoreFileBatchRetrieveParams,
} from "openai/resources/vector-stores/file-batches";
import type {
  FileChunkingStrategyParam,
  VectorStoreCreateParams,
  VectorStoreSearchParams,
} from "openai/resources/vector-stores/vector-stores";
import type {
  RetrievalCallEvidence,
  RetrievalResultEvidence,
} from "../contracts/executionEvidence";
import { isOpenAITimeoutError } from "../openai/requestError";
import {
  canonicalJsonStringify,
  sha256Utf8,
} from "../runtime/canonicalJson";
import {
  emitCandidateProgress,
  type CandidateProgressObserver,
} from "../runner/progress";

export interface VectorStoreFileShape {
  id: string;
  vector_store_id: string;
  status: "in_progress" | "completed" | "cancelled" | "failed";
  last_error?: { code?: string; message?: string } | null;
  attributes?: Record<string, string | number | boolean> | null;
  /** API 응답 형식은 요청 param보다 넓어 `other` 전략도 포함할 수 있습니다. */
  chunking_strategy?: unknown;
}

export interface VectorStoreFileBatchShape {
  id: string;
  vector_store_id: string;
  status: "in_progress" | "completed" | "cancelled" | "failed";
  file_counts: {
    in_progress: number;
    completed: number;
    failed: number;
    cancelled: number;
    total: number;
  };
}

interface SearchRequestLike extends PromiseLike<unknown> {
  asResponse?: () => Promise<Response>;
}

interface SearchResultShape {
  file_id: string;
  filename: string;
  score: number;
  attributes?: Record<string, string | number | boolean> | null;
  content: Array<{ type: string; text?: string }>;
}

interface SearchPageShape {
  data: SearchResultShape[];
  search_query?: unknown;
}

interface OpenAIRequestOptions {
  timeout?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

export interface PolicyVectorStoreClientLike {
  vectorStores: {
    create(
      params: VectorStoreCreateParams,
      options?: OpenAIRequestOptions,
    ): PromiseLike<{ id: string; status?: string }>;
    retrieve?(
      vectorStoreId: string,
      options?: OpenAIRequestOptions,
    ): PromiseLike<{
      id: string;
      name?: string;
      status?: "expired" | "in_progress" | "completed";
      file_counts?: {
        in_progress: number;
        completed: number;
        failed: number;
        cancelled: number;
        total: number;
      };
    }>;
    files: {
      create(
        vectorStoreId: string,
        params: VectorStoreFileCreateParams,
        options?: OpenAIRequestOptions,
      ): PromiseLike<VectorStoreFileShape>;
      retrieve(
        fileId: string,
        params: VectorStoreFileRetrieveParams,
        options?: OpenAIRequestOptions,
      ): PromiseLike<VectorStoreFileShape>;
      update?(
        fileId: string,
        params: VectorStoreFileUpdateParams,
        options?: OpenAIRequestOptions,
      ): PromiseLike<VectorStoreFileShape>;
    };
    fileBatches?: {
      create(
        vectorStoreId: string,
        params: VectorStoreFileBatchCreateParams,
        options?: OpenAIRequestOptions,
      ): PromiseLike<VectorStoreFileBatchShape>;
      retrieve(
        batchId: string,
        params: VectorStoreFileBatchRetrieveParams,
        options?: OpenAIRequestOptions,
      ): PromiseLike<VectorStoreFileBatchShape>;
    };
    search(
      vectorStoreId: string,
      params: VectorStoreSearchParams,
      options?: OpenAIRequestOptions,
    ): SearchRequestLike;
    delete(
      vectorStoreId: string,
      options?: OpenAIRequestOptions,
    ): PromiseLike<{ id: string; deleted: boolean }>;
  };
  files: {
    create(
      params: UploadedFileCreateParams,
      options?: OpenAIRequestOptions,
    ): PromiseLike<{ id: string }>;
    retrieve?(
      fileId: string,
      options?: OpenAIRequestOptions,
    ): PromiseLike<{
      id: string;
      filename: string;
      purpose: string;
      status: "uploaded" | "processed" | "error";
    }>;
    delete(
      fileId: string,
      options?: OpenAIRequestOptions,
    ): PromiseLike<{ id: string; deleted: boolean }>;
  };
}

export interface PolicyDocument {
  source_id: string;
  section_id: string;
  fact_id: string;
  [key: string]: unknown;
}

export interface PolicyFileManifestEntry {
  uploadedFileId: string;
  filename: string;
  sourceId: string;
  sectionId: string;
  factId: string;
  payloadSha256?: string;
}

export interface CleanupItemResult {
  id: string | null;
  attempted: boolean;
  deleted: boolean;
  error?: string;
}

export interface PolicyVectorStoreCleanupResult {
  vectorStore: CleanupItemResult;
  uploadedFiles: CleanupItemResult[];
}

export interface PreparedPolicyVectorStore {
  vectorStoreId: string;
  uploadedFileIds: string[];
  files: PolicyFileManifestEntry[];
  ingestionStatus: "completed";
  manifestSha256: string;
  vectorStoreExpiresAfter: { anchor: "last_active_at"; days: 1 };
  fileExpiresAfter: { anchor: "created_at"; seconds: 86_400 };
  uploadMethod:
    | "FILES_CREATE_AND_BOUNDED_VECTOR_STORE_POLL"
    | "FILES_CREATE_THEN_BATCH_ATTACH_AND_VERIFY";
}

/**
 * 원격 자원 생성 응답을 받은 직후 로컬 내구성 저널에 기록하기 위한 이벤트입니다.
 * 콜백이 실패하면 준비 함수는 이미 알고 있는 원격 자원을 최선 노력으로 정리합니다.
 */
export type PrivatePolicyVectorStorePreparationEvent =
  | {
    readonly kind: "VECTOR_STORE_CREATED";
    readonly vectorStoreId: string;
  }
  | {
    readonly kind: "UPLOADED_FILE_CREATED";
    readonly vectorStoreId: string;
    readonly file: PolicyFileManifestEntry;
  }
  | {
    readonly kind: "VECTOR_STORE_FILE_ATTACHED";
    readonly vectorStoreId: string;
    readonly uploadedFileId: string;
    readonly vectorStoreFileId: string;
    readonly status: VectorStoreFileShape["status"];
  };

/** 기존 로컬 호출자의 타입 호환성을 유지하는 private resource event 별칭입니다. */
export type PolicyVectorStorePreparationEvent =
  PrivatePolicyVectorStorePreparationEvent;

export interface PreparePolicyVectorStoreOptions {
  name?: string;
  filenamePrefix?: string;
  setupTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  /** Benchmark 전용 wrapper가 명시할 때만 사용합니다. 공개 calibration은 생략해 기존 auto 계약을 유지합니다. */
  chunkingStrategy?: FileChunkingStrategyParam;
  /**
   * 숨은 Benchmark의 다중 파일 연결 압력을 줄이는 명시적 경로입니다.
   * 기본값은 기존 공개 calibration의 파일별 순차 연결 계약입니다.
   */
  attachmentMode?:
    | "SEQUENTIAL_PER_FILE"
    | "BATCH_GLOBAL_CHUNKING_THEN_METADATA";
  /**
   * 원격 create 응답과 다음 원격 호출 사이에 await됩니다. 구현체는 반환 전에
   * write-once 기록과 fsync를 끝내야 합니다.
   */
  onPreparationEvent?: (
    event: PrivatePolicyVectorStorePreparationEvent,
  ) => void | Promise<void>;
  /** 브라우저에 안전한 진행 단계만 전달하며 원격 resource ID는 포함하지 않습니다. */
  onProgress?: CandidateProgressObserver;
}

export class PolicyVectorStorePreparationError extends Error {
  readonly vectorStoreId: string | null;
  readonly uploadedFileIds: string[];
  readonly cleanup: PolicyVectorStoreCleanupResult;

  constructor(
    message: string,
    resourceIds: { vectorStoreId: string | null; uploadedFileIds: readonly string[] },
    cleanup: PolicyVectorStoreCleanupResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PolicyVectorStorePreparationError";
    this.vectorStoreId = resourceIds.vectorStoreId;
    this.uploadedFileIds = [...resourceIds.uploadedFileIds];
    this.cleanup = cleanup;
  }
}

export class PolicyRetrievalError extends Error {
  readonly retryable: boolean;
  readonly evidence: RetrievalCallEvidence;

  constructor(
    message: string,
    retryable: boolean,
    evidence: RetrievalCallEvidence,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PolicyRetrievalError";
    this.retryable = retryable;
    this.evidence = evidence;
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "알 수 없는 OpenAI 리소스 오류";
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label}은(는) 비어 있지 않은 문자열이어야 합니다.`);
  }
}

function validatePolicies(policies: readonly PolicyDocument[]): void {
  if (policies.length === 0) {
    throw new TypeError("정책 문서는 하나 이상이어야 합니다.");
  }
  const identities = new Set<string>();
  policies.forEach((policy, index) => {
    assertNonEmptyString(policy.source_id, `policies[${index}].source_id`);
    assertNonEmptyString(policy.section_id, `policies[${index}].section_id`);
    assertNonEmptyString(policy.fact_id, `policies[${index}].fact_id`);
    const identity = `${policy.source_id}\u0000${policy.section_id}\u0000${policy.fact_id}`;
    if (identities.has(identity)) {
      throw new TypeError(`중복 정책 식별자가 있습니다: ${policy.fact_id}`);
    }
    identities.add(identity);
  });
}

function makeCleanupItem(id: string | null): CleanupItemResult {
  return { id, attempted: false, deleted: false };
}

function assertPositiveFiniteTimeout(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label}는 0보다 큰 유한한 숫자여야 합니다.`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function makeRequestOptions(timeout: number, signal?: AbortSignal): OpenAIRequestOptions {
  return {
    timeout,
    maxRetries: 0,
    ...(signal ? { signal } : {}),
  };
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
    };
    const handleAbort = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      cleanup();
      reject(signal?.reason);
    };

    if (signal?.aborted) {
      handleAbort();
      return;
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

async function waitAbortably(
  sleep: NonNullable<PreparePolicyVectorStoreOptions["sleep"]>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!signal) {
    await sleep(milliseconds);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", handleAbort);
      callback();
    };
    const handleAbort = () => settle(() => reject(signal.reason));
    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted) {
      handleAbort();
      return;
    }
    Promise.resolve().then(() => sleep(milliseconds, signal)).then(
      () => settle(resolve),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

export async function cleanupPolicyVectorStore(
  client: PolicyVectorStoreClientLike,
  resourceIds: { vectorStoreId: string | null; uploadedFileIds: readonly string[] },
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<PolicyVectorStoreCleanupResult> {
  assertPositiveFiniteTimeout(timeoutMs, "cleanup timeoutMs");
  const requestOptions = { timeout: timeoutMs, maxRetries: 0 } as const;
  const uniqueFileIds = [...new Set(resourceIds.uploadedFileIds)];
  const vectorStorePromise = (async (): Promise<CleanupItemResult> => {
    const vectorStore = makeCleanupItem(resourceIds.vectorStoreId);
    if (resourceIds.vectorStoreId === null) {
      return vectorStore;
    }
    vectorStore.attempted = true;
    try {
      const result = await client.vectorStores.delete(resourceIds.vectorStoreId, requestOptions);
      vectorStore.deleted = result.deleted === true;
      if (!vectorStore.deleted) {
        vectorStore.error = "vector store 삭제 응답이 deleted=true가 아닙니다.";
      }
    } catch (error) {
      vectorStore.error = safeErrorMessage(error);
    }
    return vectorStore;
  })();
  const uploadedFilePromises = uniqueFileIds.map(async (fileId): Promise<CleanupItemResult> => {
    const result = makeCleanupItem(fileId);
    result.attempted = true;
    try {
      const deletion = await client.files.delete(fileId, requestOptions);
      result.deleted = deletion.deleted === true;
      if (!result.deleted) {
        result.error = "원본 file 삭제 응답이 deleted=true가 아닙니다.";
      }
    } catch (error) {
      result.error = safeErrorMessage(error);
    }
    return result;
  });

  // 모든 삭제를 같은 시점에 시작해 SDK timeout이 항목 수만큼 직렬 누적되지 않게 합니다.
  const [vectorStore, uploadedFiles] = await Promise.all([
    vectorStorePromise,
    Promise.all(uploadedFilePromises),
  ]);
  return { vectorStore, uploadedFiles };
}

function terminalIngestionError(file: VectorStoreFileShape): Error | null {
  if (file.status === "completed" || file.status === "in_progress") {
    return null;
  }
  const details = file.last_error?.message ? `: ${file.last_error.message}` : "";
  return new Error(`정책 file ingestion 상태가 ${file.status}입니다${details}`);
}

function remainingSetupTimeoutMs(setupDeadlineAtMs: number, now: () => number): number {
  const remainingMs = Math.floor(setupDeadlineAtMs - now());
  if (remainingMs <= 0) {
    throw new Error("정책 리소스 setup deadline을 초과했습니다.");
  }
  return remainingMs;
}

function remainingPollTimeoutMs(
  pollDeadlineAtMs: number,
  pollTimeoutMs: number,
  nowMs: number,
): number {
  const remainingMs = Math.floor(pollDeadlineAtMs - nowMs);
  if (remainingMs <= 0) {
    throw new Error(`정책 file ingestion이 ${pollTimeoutMs}ms 안에 완료되지 않았습니다.`);
  }
  return remainingMs;
}

async function waitForIngestion(
  client: PolicyVectorStoreClientLike,
  vectorStoreId: string,
  initialFile: VectorStoreFileShape,
  options: Required<Pick<PreparePolicyVectorStoreOptions, "pollIntervalMs" | "pollTimeoutMs" | "now" | "sleep">>
    & { setupDeadlineAtMs: number; signal?: AbortSignal },
): Promise<VectorStoreFileShape> {
  throwIfAborted(options.signal);
  let current = initialFile;
  const immediateError = terminalIngestionError(current);
  if (immediateError) {
    throw immediateError;
  }
  remainingSetupTimeoutMs(options.setupDeadlineAtMs, options.now);
  if (current.status === "completed") {
    return current;
  }

  const pollDeadlineAtMs = options.now() + options.pollTimeoutMs;
  while (current.status === "in_progress") {
    const beforeSleepMs = options.now();
    const remainingPollBeforeSleepMs = remainingPollTimeoutMs(
      pollDeadlineAtMs,
      options.pollTimeoutMs,
      beforeSleepMs,
    );
    const remainingSetupBeforeSleepMs = Math.floor(
      options.setupDeadlineAtMs - beforeSleepMs,
    );
    if (remainingSetupBeforeSleepMs <= 0) {
      throw new Error("정책 리소스 setup deadline을 초과했습니다.");
    }
    await waitAbortably(options.sleep, Math.min(
      options.pollIntervalMs,
      remainingPollBeforeSleepMs,
      remainingSetupBeforeSleepMs,
    ), options.signal);

    const afterSleepMs = options.now();
    const remainingMs = Math.min(
      remainingPollTimeoutMs(pollDeadlineAtMs, options.pollTimeoutMs, afterSleepMs),
      Math.floor(options.setupDeadlineAtMs - afterSleepMs),
    );
    if (remainingMs <= 0) {
      throw new Error("정책 리소스 setup deadline을 초과했습니다.");
    }
    current = await client.vectorStores.files.retrieve(current.id, {
      vector_store_id: vectorStoreId,
    }, makeRequestOptions(remainingMs, options.signal));
    throwIfAborted(options.signal);
    const afterRetrieveMs = options.now();
    remainingPollTimeoutMs(pollDeadlineAtMs, options.pollTimeoutMs, afterRetrieveMs);
    if (Math.floor(options.setupDeadlineAtMs - afterRetrieveMs) <= 0) {
      throw new Error("정책 리소스 setup deadline을 초과했습니다.");
    }
    const terminalError = terminalIngestionError(current);
    if (terminalError) {
      throw terminalError;
    }
  }
  return current;
}

function assertBatchCounts(
  batch: VectorStoreFileBatchShape,
  expectedFileCount: number,
): void {
  const counts = batch.file_counts;
  for (const [key, value] of Object.entries(counts)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`정책 file batch ${key} 개수가 유효하지 않습니다.`);
    }
  }
  if (
    counts.total !== expectedFileCount
    || counts.in_progress + counts.completed + counts.failed + counts.cancelled
      !== counts.total
  ) {
    throw new Error("정책 file batch 개수가 잠긴 정책 문서 수와 다릅니다.");
  }
}

function terminalBatchError(
  batch: VectorStoreFileBatchShape,
  vectorStoreId: string,
  expectedFileCount: number,
): Error | null {
  if (batch.vector_store_id !== vectorStoreId) {
    return new Error("정책 file batch의 Vector Store binding이 다릅니다.");
  }
  assertBatchCounts(batch, expectedFileCount);
  if (batch.status === "failed" || batch.status === "cancelled") {
    return new Error(`정책 file batch ingestion 상태가 ${batch.status}입니다.`);
  }
  if (
    batch.status === "completed"
    && (
      batch.file_counts.completed !== expectedFileCount
      || batch.file_counts.in_progress !== 0
      || batch.file_counts.failed !== 0
      || batch.file_counts.cancelled !== 0
    )
  ) {
    return new Error("정책 file batch 완료 응답에 실패하거나 미완료인 파일이 있습니다.");
  }
  return null;
}

async function waitForBatchIngestion(
  client: PolicyVectorStoreClientLike,
  vectorStoreId: string,
  initialBatch: VectorStoreFileBatchShape,
  expectedFileCount: number,
  options: Required<Pick<
    PreparePolicyVectorStoreOptions,
    "pollIntervalMs" | "pollTimeoutMs" | "now" | "sleep"
  >> & { setupDeadlineAtMs: number; signal?: AbortSignal },
): Promise<VectorStoreFileBatchShape> {
  throwIfAborted(options.signal);
  let current = initialBatch;
  const initialError = terminalBatchError(
    current,
    vectorStoreId,
    expectedFileCount,
  );
  if (initialError) {
    throw initialError;
  }
  remainingSetupTimeoutMs(options.setupDeadlineAtMs, options.now);
  if (current.status === "completed") {
    return current;
  }

  const retrieveVectorStore = client.vectorStores.retrieve?.bind(
    client.vectorStores,
  );
  if (!retrieveVectorStore) {
    throw new TypeError("batch 연결 검증에는 vectorStores.retrieve API가 필요합니다.");
  }
  const pollDeadlineAtMs = options.now() + options.pollTimeoutMs;
  while (current.status === "in_progress") {
    const beforeSleepMs = options.now();
    const remainingPollBeforeSleepMs = remainingPollTimeoutMs(
      pollDeadlineAtMs,
      options.pollTimeoutMs,
      beforeSleepMs,
    );
    const remainingSetupBeforeSleepMs = Math.floor(
      options.setupDeadlineAtMs - beforeSleepMs,
    );
    if (remainingSetupBeforeSleepMs <= 0) {
      throw new Error("정책 리소스 setup deadline을 초과했습니다.");
    }
    await waitAbortably(options.sleep, Math.min(
      options.pollIntervalMs,
      remainingPollBeforeSleepMs,
      remainingSetupBeforeSleepMs,
    ), options.signal);

    const afterSleepMs = options.now();
    const remainingMs = Math.min(
      remainingPollTimeoutMs(
        pollDeadlineAtMs,
        options.pollTimeoutMs,
        afterSleepMs,
      ),
      Math.floor(options.setupDeadlineAtMs - afterSleepMs),
    );
    if (remainingMs <= 0) {
      throw new Error("정책 리소스 setup deadline을 초과했습니다.");
    }
    /*
     * 2026-07-18 실제 API 관측에서 fileBatches.retrieve가 batch가 아닌
     * Vector Store 객체를 반환했습니다. 따라서 생성 응답 뒤 부모 Vector Store의
     * file_counts를 조회하고, 이후 개별 파일을 다시 검증합니다.
     */
    const remoteStore = await retrieveVectorStore(
      vectorStoreId,
      makeRequestOptions(remainingMs, options.signal),
    );
    throwIfAborted(options.signal);
    const afterRetrieveMs = options.now();
    remainingPollTimeoutMs(
      pollDeadlineAtMs,
      options.pollTimeoutMs,
      afterRetrieveMs,
    );
    if (Math.floor(options.setupDeadlineAtMs - afterRetrieveMs) <= 0) {
      throw new Error("정책 리소스 setup deadline을 초과했습니다.");
    }
    if (remoteStore.id !== vectorStoreId || remoteStore.file_counts === undefined) {
      throw new Error("정책 file batch의 부모 Vector Store 응답이 불완전합니다.");
    }
    const counts = remoteStore.file_counts;
    current = {
      id: initialBatch.id,
      vector_store_id: vectorStoreId,
      status: remoteStore.status === "expired"
        ? "failed"
        : remoteStore.status ?? "in_progress",
      file_counts: counts,
    };
    const remoteError = terminalBatchError(current, vectorStoreId, expectedFileCount);
    if (remoteError) {
      throw remoteError;
    }
  }
  return current;
}

function expectedFileAttributes(
  entry: PolicyFileManifestEntry,
): Record<string, string> {
  return {
    source_id: entry.sourceId,
    section_id: entry.sectionId,
    fact_id: entry.factId,
  };
}

function assertBatchFileIdentityStatusAndChunking(
  file: VectorStoreFileShape,
  vectorStoreId: string,
  entry: PolicyFileManifestEntry,
  chunkingStrategy: FileChunkingStrategyParam,
): void {
  if (
    file.id !== entry.uploadedFileId
    || file.vector_store_id !== vectorStoreId
  ) {
    throw new Error(`정책 file의 원격 binding이 다릅니다: ${entry.uploadedFileId}`);
  }
  if (file.status !== "completed") {
    throw new Error(
      `정책 file의 원격 ingestion 상태가 ${file.status}입니다: ${entry.uploadedFileId}`,
    );
  }
  if (
    canonicalJsonStringify(file.chunking_strategy ?? null)
      !== canonicalJsonStringify(chunkingStrategy)
  ) {
    throw new Error(`정책 file chunking 설정이 잠긴 계약과 다릅니다: ${entry.uploadedFileId}`);
  }
}

function hasExpectedBatchFileAttributes(
  file: VectorStoreFileShape,
  entry: PolicyFileManifestEntry,
): boolean {
  return canonicalJsonStringify(file.attributes ?? null)
    === canonicalJsonStringify(expectedFileAttributes(entry));
}

async function waitForVerifiedBatchFile(
  client: PolicyVectorStoreClientLike,
  vectorStoreId: string,
  entry: PolicyFileManifestEntry,
  chunkingStrategy: FileChunkingStrategyParam,
  options: Required<Pick<
    PreparePolicyVectorStoreOptions,
    "pollIntervalMs" | "pollTimeoutMs" | "now" | "sleep"
  >> & { setupDeadlineAtMs: number; signal?: AbortSignal },
): Promise<VectorStoreFileShape> {
  const pollDeadlineAtMs = options.now() + options.pollTimeoutMs;
  while (true) {
    const remainingMs = Math.min(
      remainingPollTimeoutMs(
        pollDeadlineAtMs,
        options.pollTimeoutMs,
        options.now(),
      ),
      remainingSetupTimeoutMs(options.setupDeadlineAtMs, options.now),
    );
    const file = await client.vectorStores.files.retrieve(
      entry.uploadedFileId,
      { vector_store_id: vectorStoreId },
      makeRequestOptions(remainingMs, options.signal),
    );
    throwIfAborted(options.signal);
    assertBatchFileIdentityStatusAndChunking(
      file,
      vectorStoreId,
      entry,
      chunkingStrategy,
    );
    if (hasExpectedBatchFileAttributes(file, entry)) {
      return file;
    }

    const beforeSleepMs = options.now();
    const remainingPollBeforeSleepMs = remainingPollTimeoutMs(
      pollDeadlineAtMs,
      options.pollTimeoutMs,
      beforeSleepMs,
    );
    const remainingSetupBeforeSleepMs = remainingSetupTimeoutMs(
      options.setupDeadlineAtMs,
      options.now,
    );
    await waitAbortably(options.sleep, Math.min(
      options.pollIntervalMs,
      remainingPollBeforeSleepMs,
      remainingSetupBeforeSleepMs,
    ), options.signal);
  }
}

function isAmbiguousMutationError(error: unknown): boolean {
  if (isOpenAITimeoutError(error)) {
    return true;
  }
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number"
    && (status === 408 || status === 409 || status === 429 || status >= 500);
}

function safeFilenamePart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "policy";
}

export async function preparePolicyVectorStore(
  client: PolicyVectorStoreClientLike,
  policies: readonly PolicyDocument[],
  {
    name = "ai-challenge-calibration-policies",
    filenamePrefix = "synthetic-policy",
    setupTimeoutMs = 30_000,
    cleanupTimeoutMs = 10_000,
    pollIntervalMs = 500,
    pollTimeoutMs = 30_000,
    now = Date.now,
    sleep = defaultSleep,
    signal,
    chunkingStrategy,
    attachmentMode = "SEQUENTIAL_PER_FILE",
    onPreparationEvent,
    onProgress,
  }: PreparePolicyVectorStoreOptions = {},
): Promise<PreparedPolicyVectorStore> {
  validatePolicies(policies);
  assertNonEmptyString(filenamePrefix, "filenamePrefix");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new TypeError("pollIntervalMs는 0 이상의 유한한 숫자여야 합니다.");
  }
  if (!Number.isFinite(pollTimeoutMs) || pollTimeoutMs <= 0) {
    throw new TypeError("pollTimeoutMs는 0보다 큰 유한한 숫자여야 합니다.");
  }
  assertPositiveFiniteTimeout(setupTimeoutMs, "setupTimeoutMs");
  assertPositiveFiniteTimeout(cleanupTimeoutMs, "cleanupTimeoutMs");
  if (
    attachmentMode === "BATCH_GLOBAL_CHUNKING_THEN_METADATA"
    && chunkingStrategy === undefined
  ) {
    throw new TypeError("batch 연결에는 명시적인 chunkingStrategy가 필요합니다.");
  }

  const setupDeadlineAtMs = now() + setupTimeoutMs;
  let vectorStoreId: string | null = null;
  const uploadedFileIds: string[] = [];
  const files: PolicyFileManifestEntry[] = [];
  await emitCandidateProgress(onProgress, { kind: "ENVIRONMENT_PREPARING" });
  try {
    throwIfAborted(signal);
    const vectorStore = await client.vectorStores.create({
      name,
      expires_after: { anchor: "last_active_at", days: 1 },
    }, makeRequestOptions(remainingSetupTimeoutMs(setupDeadlineAtMs, now), signal));
    throwIfAborted(signal);
    assertNonEmptyString(vectorStore.id, "vector store id");
    vectorStoreId = vectorStore.id;
    await onPreparationEvent?.({
      kind: "VECTOR_STORE_CREATED",
      vectorStoreId,
    });

    for (const policy of policies) {
      remainingSetupTimeoutMs(setupDeadlineAtMs, now);
      const payload = `${JSON.stringify(policy, null, 2)}\n`;
      const payloadSha256 = sha256Utf8(payload);
      const filename = `${safeFilenamePart(filenamePrefix)}-${safeFilenamePart(policy.fact_id)}.json`;
      const uploadable = await toFile(new TextEncoder().encode(payload), filename, {
        type: "application/json",
      });
      throwIfAborted(signal);
      const uploadedFile = await client.files.create({
        file: uploadable,
        purpose: "assistants",
        expires_after: { anchor: "created_at", seconds: 86_400 },
      }, makeRequestOptions(remainingSetupTimeoutMs(setupDeadlineAtMs, now), signal));
      throwIfAborted(signal);
      assertNonEmptyString(uploadedFile.id, "uploaded file id");
      if (uploadedFileIds.includes(uploadedFile.id)) {
        throw new TypeError(`중복 uploaded file ID가 반환됐습니다: ${uploadedFile.id}`);
      }
      uploadedFileIds.push(uploadedFile.id);

      const entry: PolicyFileManifestEntry = {
        uploadedFileId: uploadedFile.id,
        filename,
        sourceId: policy.source_id,
        sectionId: policy.section_id,
        factId: policy.fact_id,
        payloadSha256,
      };
      files.push(entry);
      await onPreparationEvent?.({
        kind: "UPLOADED_FILE_CREATED",
        vectorStoreId,
        file: { ...entry },
      });

      if (attachmentMode === "SEQUENTIAL_PER_FILE") {
        const attachedFile = await client.vectorStores.files.create(vectorStoreId, {
          file_id: uploadedFile.id,
          attributes: {
            source_id: policy.source_id,
            section_id: policy.section_id,
            fact_id: policy.fact_id,
          },
          ...(chunkingStrategy === undefined
            ? {}
            : { chunking_strategy: structuredClone(chunkingStrategy) }),
        }, makeRequestOptions(remainingSetupTimeoutMs(setupDeadlineAtMs, now), signal));
        throwIfAborted(signal);
        await onPreparationEvent?.({
          kind: "VECTOR_STORE_FILE_ATTACHED",
          vectorStoreId,
          uploadedFileId: uploadedFile.id,
          vectorStoreFileId: attachedFile.id,
          status: attachedFile.status,
        });
        const ingestedFile = await waitForIngestion(client, vectorStoreId, attachedFile, {
          pollIntervalMs,
          pollTimeoutMs,
          now,
          sleep,
          setupDeadlineAtMs,
          signal,
        });
        if (ingestedFile.status !== "completed") {
          throw new Error(`정책 file ingestion 상태가 ${ingestedFile.status}입니다.`);
        }
      }
    }

    if (attachmentMode === "BATCH_GLOBAL_CHUNKING_THEN_METADATA") {
      const batches = client.vectorStores.fileBatches;
      if (
        !batches
        || !client.vectorStores.files.update
        || chunkingStrategy === undefined
      ) {
        throw new TypeError(
          "batch 연결에는 fileBatches와 vectorStores.files.update API가 필요합니다.",
        );
      }
      const createdBatch = await batches.create(vectorStoreId, {
        file_ids: [...uploadedFileIds],
        chunking_strategy: structuredClone(chunkingStrategy),
      }, makeRequestOptions(
        remainingSetupTimeoutMs(setupDeadlineAtMs, now),
        signal,
      ));
      throwIfAborted(signal);
      assertNonEmptyString(createdBatch.id, "vector store file batch id");
      const completedBatch = await waitForBatchIngestion(
        client,
        vectorStoreId,
        createdBatch,
        uploadedFileIds.length,
        {
          pollIntervalMs,
          pollTimeoutMs,
          now,
          sleep,
          setupDeadlineAtMs,
          signal,
        },
      );
      if (completedBatch.status !== "completed") {
        throw new Error(`정책 file batch ingestion 상태가 ${completedBatch.status}입니다.`);
      }

      for (const entry of files) {
        const requestOptions = makeRequestOptions(
          remainingSetupTimeoutMs(setupDeadlineAtMs, now),
          signal,
        );
        let ambiguousUpdateError: unknown = null;
        try {
          await client.vectorStores.files.update(entry.uploadedFileId, {
            vector_store_id: vectorStoreId,
            attributes: expectedFileAttributes(entry),
          }, requestOptions);
        } catch (error) {
          if (!isAmbiguousMutationError(error)) {
            throw error;
          }
          ambiguousUpdateError = error;
        }
        throwIfAborted(signal);
        let verifiedFile: VectorStoreFileShape;
        try {
          verifiedFile = await waitForVerifiedBatchFile(
            client,
            vectorStoreId,
            entry,
            chunkingStrategy,
            {
              pollIntervalMs,
              pollTimeoutMs,
              now,
              sleep,
              setupDeadlineAtMs,
              signal,
            },
          );
        } catch (verificationError) {
          if (ambiguousUpdateError !== null) {
            throw new Error(
              `정책 file attributes 갱신 결과를 원격 상태로 확인할 수 없습니다: ${entry.uploadedFileId}`,
              { cause: ambiguousUpdateError },
            );
          }
          throw verificationError;
        }
        await onPreparationEvent?.({
          kind: "VECTOR_STORE_FILE_ATTACHED",
          vectorStoreId,
          uploadedFileId: entry.uploadedFileId,
          vectorStoreFileId: verifiedFile.id,
          status: verifiedFile.status,
        });
      }
    }

    // 공개 calibration은 기존 bytes/hash를 보존하고, 명시적 chunking 자원만 설정까지 결합합니다.
    const manifestPayload = chunkingStrategy === undefined
      ? files
      : { files, chunking_config: chunkingStrategy };
    const manifestSha256 = sha256Utf8(
      chunkingStrategy === undefined
        ? JSON.stringify(manifestPayload)
        : canonicalJsonStringify(manifestPayload),
    );
    await emitCandidateProgress(onProgress, { kind: "ENVIRONMENT_PREPARED" });
    return {
      vectorStoreId,
      uploadedFileIds: [...uploadedFileIds],
      files: files.map((entry) => ({ ...entry })),
      ingestionStatus: "completed",
      manifestSha256,
      vectorStoreExpiresAfter: { anchor: "last_active_at", days: 1 },
      fileExpiresAfter: { anchor: "created_at", seconds: 86_400 },
      uploadMethod: attachmentMode === "BATCH_GLOBAL_CHUNKING_THEN_METADATA"
        ? "FILES_CREATE_THEN_BATCH_ATTACH_AND_VERIFY"
        : "FILES_CREATE_AND_BOUNDED_VECTOR_STORE_POLL",
    };
  } catch (error) {
    const cleanup = await cleanupPolicyVectorStore(
      client,
      { vectorStoreId, uploadedFileIds },
      { timeoutMs: cleanupTimeoutMs },
    );
    throw new PolicyVectorStorePreparationError(
      safeErrorMessage(error),
      { vectorStoreId, uploadedFileIds },
      cleanup,
      { cause: error },
    );
  }
}

function readReportedQuery(page: SearchPageShape): string | null {
  const raw = page.search_query;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw;
  }
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
    return raw.length === 1 ? raw[0] : JSON.stringify(raw);
  }
  return null;
}

async function readSearchPage(request: SearchRequestLike): Promise<SearchPageShape> {
  if (typeof request.asResponse === "function") {
    const response = await request.asResponse();
    return await response.json() as SearchPageShape;
  }
  return await request as SearchPageShape;
}

function readContentIdentity(text: string): {
  sourceId: string;
  sectionId: string;
  factId: string;
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError("검색 본문을 단일 정책 JSON으로 해석할 수 없습니다.");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new TypeError("검색 본문은 단일 정책 JSON 객체여야 합니다.");
  }
  const record = decoded as Record<string, unknown>;
  const topLevelString = (field: string): string => {
    const value = record[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`검색 본문의 최상위 ${field}가 필요합니다.`);
    }
    return value;
  };
  return {
    sourceId: topLevelString("source_id"),
    sectionId: topLevelString("section_id"),
    factId: topLevelString("fact_id"),
  };
}

function readAttributeString(
  attributes: SearchResultShape["attributes"],
  key: string,
): string {
  const value = attributes?.[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`retrieval attributes.${key}가 필요합니다.`);
  }
  return value;
}

function mapSearchResults(
  page: SearchPageShape,
  manifest: readonly PolicyFileManifestEntry[],
  maxNumResults: number,
): RetrievalResultEvidence[] {
  if (page.data.length === 0) {
    throw new TypeError("Retrieval API가 정책 근거를 반환하지 않았습니다.");
  }
  if (page.data.length > maxNumResults) {
    throw new TypeError("Retrieval API 결과 수가 잠긴 max_num_results를 초과했습니다.");
  }
  const manifestByFileId = new Map(manifest.map((entry) => [entry.uploadedFileId, entry]));
  if (manifestByFileId.size !== manifest.length) {
    throw new TypeError("정책 manifest에 중복 uploadedFileId가 있습니다.");
  }

  return page.data.map((item, index) => {
    assertNonEmptyString(item.file_id, "retrieval file_id");
    assertNonEmptyString(item.filename, "retrieval filename");
    const expected = manifestByFileId.get(item.file_id);
    if (!expected) {
      throw new TypeError(`manifest에 없는 file ID가 검색됐습니다: ${item.file_id}`);
    }
    if (item.filename !== expected.filename) {
      throw new TypeError(`검색 filename이 manifest와 일치하지 않습니다: ${item.file_id}`);
    }
    if (!Number.isFinite(item.score) || item.score < 0 || item.score > 1) {
      throw new TypeError("retrieval score는 0 이상 1 이하의 유한한 숫자여야 합니다.");
    }
    if (!Array.isArray(item.content) || item.content.length === 0) {
      throw new TypeError("retrieval 결과에는 하나 이상의 content가 필요합니다.");
    }
    const contentChunks = item.content.map((content) => {
      if (content.type !== "text" || typeof content.text !== "string") {
        throw new TypeError("retrieval 결과에는 text content만 허용합니다.");
      }
      return content.text;
    });
    const text = contentChunks.join("\n");
    const contentIdentity = readContentIdentity(text);
    const attributeIdentity = {
      sourceId: readAttributeString(item.attributes, "source_id"),
      sectionId: readAttributeString(item.attributes, "section_id"),
      factId: readAttributeString(item.attributes, "fact_id"),
    };
    for (const identity of [contentIdentity, attributeIdentity]) {
      if (
        identity.sourceId !== expected.sourceId
        || identity.sectionId !== expected.sectionId
        || identity.factId !== expected.factId
      ) {
        throw new TypeError(`검색 정책 식별자가 manifest와 일치하지 않습니다: ${item.file_id}`);
      }
    }

    return {
      rank: index + 1,
      fileId: item.file_id,
      filename: item.filename,
      score: item.score,
      sourceId: expected.sourceId,
      sectionId: expected.sectionId,
      factId: expected.factId,
      text,
      contentChunks,
    };
  });
}

function retryableStatus(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error
    && typeof error.status === "number"
    ? error.status
    : null;
  return status === null || status === 408 || status === 409 || status === 429 || status >= 500;
}

function isTimeoutError(error: unknown): boolean {
  return isOpenAITimeoutError(error);
}

export interface SearchPolicyVectorStoreOptions {
  vectorStoreId: string;
  query: string;
  maxNumResults: number;
  manifest: readonly PolicyFileManifestEntry[];
  timeoutMs: number;
  callNumber?: number;
  now?: () => number;
  signal?: AbortSignal;
}

function failedRetrievalEvidence(
  options: Required<Pick<SearchPolicyVectorStoreOptions, "callNumber">>
    & Pick<SearchPolicyVectorStoreOptions, "vectorStoreId" | "query" | "maxNumResults">,
  latencyMs: number,
  status: "FAILED" | "TIMEOUT",
  error: string,
  reportedQuery: string | null = null,
): RetrievalCallEvidence {
  return {
    callNumber: options.callNumber,
    operation: "VECTOR_STORE_SEARCH",
    status,
    requestedQuery: options.query,
    reportedQuery,
    vectorStoreId: options.vectorStoreId,
    maxNumResults: options.maxNumResults,
    rewriteQuery: false,
    latencyMs,
    results: [],
    error,
  };
}

export async function searchPolicyVectorStore(
  client: PolicyVectorStoreClientLike,
  {
    vectorStoreId,
    query,
    maxNumResults,
    manifest,
    timeoutMs,
    callNumber = 1,
    now = Date.now,
    signal,
  }: SearchPolicyVectorStoreOptions,
): Promise<RetrievalCallEvidence> {
  assertNonEmptyString(vectorStoreId, "vectorStoreId");
  assertNonEmptyString(query, "query");
  if (!Number.isInteger(maxNumResults) || maxNumResults < 1 || maxNumResults > 50) {
    throw new TypeError("maxNumResults는 1 이상 50 이하 정수여야 합니다.");
  }
  if (!Number.isInteger(callNumber) || callNumber < 1) {
    throw new TypeError("callNumber는 1 이상의 정수여야 합니다.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs는 0보다 큰 유한한 숫자여야 합니다.");
  }

  const startedAtMs = now();
  let page: SearchPageShape;
  try {
    throwIfAborted(signal);
    const params = {
      query,
      max_num_results: maxNumResults,
      rewrite_query: false,
    } as const;
    const request = client.vectorStores.search(
      vectorStoreId,
      params,
      makeRequestOptions(timeoutMs, signal),
    );
    page = await readSearchPage(request);
    throwIfAborted(signal);
  } catch (error) {
    if (signal?.aborted) {
      signal.throwIfAborted();
    }
    const message = safeErrorMessage(error);
    const timeout = isTimeoutError(error);
    const evidence = failedRetrievalEvidence(
      { vectorStoreId, query, maxNumResults, callNumber },
      Math.max(now() - startedAtMs, 0),
      timeout ? "TIMEOUT" : "FAILED",
      message,
    );
    throw new PolicyRetrievalError(message, retryableStatus(error), evidence, { cause: error });
  }

  const latencyMs = Math.max(now() - startedAtMs, 0);
  const reportedQuery = page && typeof page === "object" ? readReportedQuery(page) : null;
  try {
    if (!page || !Array.isArray(page.data)) {
      throw new TypeError("Retrieval API 응답에 data 배열이 없습니다.");
    }
    const results = mapSearchResults(page, manifest, maxNumResults);
    return {
      callNumber,
      operation: "VECTOR_STORE_SEARCH",
      status: "COMPLETE",
      requestedQuery: query,
      reportedQuery,
      vectorStoreId,
      maxNumResults,
      rewriteQuery: false,
      latencyMs,
      results,
    };
  } catch (error) {
    const message = safeErrorMessage(error);
    const evidence = failedRetrievalEvidence(
      { vectorStoreId, query, maxNumResults, callNumber },
      latencyMs,
      "FAILED",
      message,
      reportedQuery,
    );
    throw new PolicyRetrievalError(message, false, evidence, { cause: error });
  }
}

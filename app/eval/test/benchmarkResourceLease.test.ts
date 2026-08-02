// @vitest-environment node

import {
  link,
  chmod,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BenchmarkResourceLeaseCleanupIncompleteError,
  BenchmarkResourceLeaseConflictError,
  BenchmarkResourceLeaseIntegrityError,
  buildBenchmarkResourceLeaseContractForTest,
  createBenchmarkResourceLeaseController,
  type BenchmarkResourceLeaseContract,
  type BenchmarkResourceLeaseRemoteClient,
} from "../benchmark/resourceLease";
import {
  BENCHMARK_POLICY_CHUNKING_CONFIG,
  type PreparedBenchmarkPolicyVectorStore,
} from "../benchmark/policyVectorStore";
import { PolicyVectorStorePreparationError } from "../retrieval/policyVectorStore";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import { canonicalJsonStringify } from "../runtime/canonicalJson";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function secureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "benchmark-resource-lease-"));
  await chmod(root, 0o700);
  const canonical = await realpath(root);
  roots.push(canonical);
  return canonical;
}

function owner(pid: number, token: string) {
  return { hostname: "lease-test-host", pid, token };
}

function preparedStore(
  contract: BenchmarkResourceLeaseContract,
  suffix = "one",
): PreparedBenchmarkPolicyVectorStore {
  const vectorStoreId = `vs-${suffix}`;
  const files = Array.from({ length: 32 }, (_, index) => ({
    uploadedFileId: `file-${suffix}-${String(index + 1).padStart(2, "0")}`,
    filename: `hidden-benchmark-policy-fact-${index + 1}.json`,
    sourceId: `POLICY-${Math.floor(index / 3) + 1}`,
    sectionId: `section-${index + 1}`,
    factId: `fact-${index + 1}`,
    payloadSha256: sha256CanonicalJson({ suffix, index }),
  }));
  const manifestSha256 = sha256CanonicalJson({ suffix, files });
  const resourceIdentity = {
    schema_version: "benchmark-policy-resource-v1" as const,
    policy_corpus_sha256: contract.policy_corpus_sha256,
    chunking_config: structuredClone(BENCHMARK_POLICY_CHUNKING_CONFIG),
    chunking_config_sha256: contract.chunking_config_sha256,
    resource_contract_sha256: contract.resource_contract_sha256,
    manifest_sha256: manifestSha256,
  };
  return {
    vectorStoreId,
    uploadedFileIds: files.map((file) => file.uploadedFileId),
    files,
    ingestionStatus: "completed",
    manifestSha256,
    vectorStoreExpiresAfter: { anchor: "last_active_at", days: 1 },
    fileExpiresAfter: { anchor: "created_at", seconds: 86_400 },
    uploadMethod: "FILES_CREATE_AND_BOUNDED_VECTOR_STORE_POLL",
    resourceIdentity,
    resourceIdentitySha256: sha256CanonicalJson(resourceIdentity),
  };
}

function completeCleanup(
  prepared: PreparedBenchmarkPolicyVectorStore,
  deleted = true,
) {
  return {
    vectorStore: {
      id: prepared.vectorStoreId,
      attempted: true,
      deleted,
    },
    uploadedFiles: prepared.uploadedFileIds.map((id) => ({
      id,
      attempted: true,
      deleted,
    })),
  };
}

function partialCleanup(
  vectorStoreId: string | null,
  uploadedFileIds: readonly string[],
  deleted = true,
) {
  return {
    vectorStore: {
      id: vectorStoreId,
      attempted: vectorStoreId !== null,
      deleted: vectorStoreId !== null && deleted,
    },
    uploadedFiles: uploadedFileIds.map((id) => ({
      id,
      attempted: true,
      deleted,
    })),
  };
}

function remoteClient(
  prepared: PreparedBenchmarkPolicyVectorStore,
  {
    vectorStatus = "completed",
    fileStatus = "processed",
    attachedStatus = "completed",
    missing = false,
    wrongAttributes = false,
  }: {
    vectorStatus?: "expired" | "in_progress" | "completed";
    fileStatus?: "uploaded" | "processed" | "error";
    attachedStatus?: "in_progress" | "completed" | "cancelled" | "failed";
    missing?: boolean;
    wrongAttributes?: boolean;
  } = {},
): BenchmarkResourceLeaseRemoteClient {
  const byId = new Map(
    prepared.files.map((file) => [file.uploadedFileId, file]),
  );
  return {
    vectorStores: {
      create: vi.fn(),
      retrieve: vi.fn(async () => {
        if (missing) throw new Error("provider error mentions secret resource");
        return {
          id: prepared.vectorStoreId,
          name: "ai-challenge-hidden-benchmark-policies",
          status: vectorStatus,
          file_counts: {
            in_progress: 0,
            completed: 32,
            failed: 0,
            cancelled: 0,
            total: 32,
          },
        };
      }),
      files: {
        create: vi.fn(),
        retrieve: vi.fn(async (fileId: string) => {
          const file = byId.get(fileId)!;
          return {
            id: fileId,
            vector_store_id: prepared.vectorStoreId,
            status: attachedStatus,
            attributes: wrongAttributes
              ? { source_id: "tampered", section_id: file.sectionId, fact_id: file.factId }
              : {
                source_id: file.sourceId,
                section_id: file.sectionId,
                fact_id: file.factId,
              },
            chunking_strategy: structuredClone(
              BENCHMARK_POLICY_CHUNKING_CONFIG,
            ),
          };
        }),
      },
      search: vi.fn(),
      delete: vi.fn(),
    },
    files: {
      create: vi.fn(),
      retrieve: vi.fn(async (fileId: string) => {
        const file = byId.get(fileId)!;
        return {
          id: fileId,
          filename: file.filename,
          purpose: "assistants",
          status: fileStatus,
        };
      }),
      delete: vi.fn(),
    },
  } as unknown as BenchmarkResourceLeaseRemoteClient;
}

function prepareImplementation(prepared: PreparedBenchmarkPolicyVectorStore) {
  return vi.fn(async (_client, _policies, options) => {
    await options.onPreparationEvent?.({
      kind: "VECTOR_STORE_CREATED",
      vectorStoreId: prepared.vectorStoreId,
    });
    for (const file of prepared.files) {
      await options.onPreparationEvent?.({
        kind: "UPLOADED_FILE_CREATED",
        vectorStoreId: prepared.vectorStoreId,
        file,
      });
      await options.onPreparationEvent?.({
        kind: "VECTOR_STORE_FILE_ATTACHED",
        vectorStoreId: prepared.vectorStoreId,
        uploadedFileId: file.uploadedFileId,
        vectorStoreFileId: file.uploadedFileId,
        status: "completed",
      });
    }
    return prepared;
  });
}

function prepareBatchImplementation(
  prepared: PreparedBenchmarkPolicyVectorStore,
) {
  return vi.fn(async (_client, _policies, options) => {
    await options.onPreparationEvent?.({
      kind: "VECTOR_STORE_CREATED",
      vectorStoreId: prepared.vectorStoreId,
    });
    for (const file of prepared.files) {
      await options.onPreparationEvent?.({
        kind: "UPLOADED_FILE_CREATED",
        vectorStoreId: prepared.vectorStoreId,
        file,
      });
    }
    for (const file of prepared.files) {
      await options.onPreparationEvent?.({
        kind: "VECTOR_STORE_FILE_ATTACHED",
        vectorStoreId: prepared.vectorStoreId,
        uploadedFileId: file.uploadedFileId,
        vectorStoreFileId: file.uploadedFileId,
        status: "completed",
      });
    }
    return {
      ...prepared,
      uploadMethod: "FILES_CREATE_THEN_BATCH_ATTACH_AND_VERIFY" as const,
    };
  });
}

async function allPaths(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      result.push(path);
      if (entry.isDirectory()) await visit(path);
    }
  }
  await visit(root);
  return result;
}

describe("Recorded Benchmark remote resource lease", () => {
  it("실행 전에 1+32 progress chain과 prepared manifest를 0700/0600으로 영속화한다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest({
      outputDirectory: root,
    });
    const prepared = preparedStore(contract);
    const prepareResource = prepareImplementation(prepared);
    const controller = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(101, "owner-one"),
      prepareResource,
      cleanupResource: vi.fn(),
    });

    await expect(controller.acquire({
      client: remoteClient(prepared),
    })).resolves.toEqual(prepared);

    const paths = await allPaths(root);
    const eventPaths = paths.filter((path) => /--event-\d{6}\.json$/.test(path));
    const preparedPaths = paths.filter((path) => /\/prepared\/attempt-\d{6}\.json$/.test(path));
    expect(eventPaths).toHaveLength(65);
    expect(preparedPaths).toHaveLength(1);
    for (const path of paths) {
      const handle = await open(path, "r");
      const stat = await handle.stat();
      await handle.close();
      expect(stat.mode & 0o777).toBe(stat.isDirectory() ? 0o700 : 0o600);
      if (stat.isFile()) expect(stat.nlink).toBe(1);
    }
    expect(prepareResource).toHaveBeenCalledTimes(1);
  });

  it("32개 업로드 뒤 32개 batch attachment를 기록하는 progress chain도 안전하게 재생한다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest({
      outputDirectory: root,
    });
    const prepared = preparedStore(contract, "batch");
    const prepareResource = prepareBatchImplementation(prepared);
    const controller = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(111, "owner-batch"),
      prepareResource,
      cleanupResource: vi.fn(),
    });

    await expect(controller.acquire({
      client: remoteClient(prepared),
    })).resolves.toMatchObject({
      vectorStoreId: prepared.vectorStoreId,
      uploadMethod: "FILES_CREATE_THEN_BATCH_ATTACH_AND_VERIFY",
    });

    const paths = await allPaths(root);
    expect(paths.filter((path) => /--event-\d{6}\.json$/.test(path)))
      .toHaveLength(65);
    expect(prepareResource).toHaveBeenCalledTimes(1);
  });

  it("hard crash 뒤 dead owner를 원자 인수하고 원격 1+32 readiness 확인 후 같은 ID를 재사용한다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest();
    const prepared = preparedStore(contract);
    const firstPrepare = prepareImplementation(prepared);
    await createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(201, "crashed-owner"),
      prepareResource: firstPrepare,
      cleanupResource: vi.fn(),
    }).acquire({ client: remoteClient(prepared) });

    const resumedPrepare = vi.fn();
    const resumedClient = remoteClient(prepared);
    const resumed = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(202, "resume-owner"),
      isOwnerAlive: vi.fn(async () => false),
      prepareResource: resumedPrepare,
      cleanupResource: vi.fn(),
    });

    const reused = await resumed.acquire({ client: resumedClient });
    expect(reused.vectorStoreId).toBe(prepared.vectorStoreId);
    expect(reused.uploadedFileIds).toEqual(prepared.uploadedFileIds);
    expect(resumedPrepare).not.toHaveBeenCalled();
    expect(resumedClient.vectorStores.retrieve).toHaveBeenCalledTimes(1);
    expect(resumedClient.files.retrieve).toHaveBeenCalledTimes(32);
    expect(resumedClient.vectorStores.files.retrieve).toHaveBeenCalledTimes(32);
  });

  it("live owner가 있으면 원격 조회·생성·삭제 없이 충돌로 차단한다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest();
    const prepared = preparedStore(contract);
    await createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(301, "live-owner"),
      prepareResource: prepareImplementation(prepared),
      cleanupResource: vi.fn(),
    }).acquire({ client: remoteClient(prepared) });

    const client = remoteClient(prepared);
    const prepareResource = vi.fn();
    const controller = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(302, "competing-owner"),
      isOwnerAlive: vi.fn(async () => true),
      prepareResource,
      cleanupResource: vi.fn(),
    });

    await expect(controller.acquire({ client }))
      .rejects.toBeInstanceOf(BenchmarkResourceLeaseConflictError);
    expect(prepareResource).not.toHaveBeenCalled();
    expect(client.vectorStores.retrieve).not.toHaveBeenCalled();
  });

  it("partial journal의 dead owner를 인수해 알려진 자원을 정리한 뒤 새 attempt를 준비한다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest();
    const partial = preparedStore(contract, "partial");
    const firstFile = partial.files[0];
    const firstPrepare = vi.fn(async (_client, _policies, options) => {
      await options.onPreparationEvent?.({
        kind: "VECTOR_STORE_CREATED",
        vectorStoreId: partial.vectorStoreId,
      });
      await options.onPreparationEvent?.({
        kind: "UPLOADED_FILE_CREATED",
        vectorStoreId: partial.vectorStoreId,
        file: firstFile,
      });
      throw new PolicyVectorStorePreparationError(
        "simulated hard crash boundary",
        {
          vectorStoreId: partial.vectorStoreId,
          uploadedFileIds: [firstFile.uploadedFileId],
        },
        partialCleanup(
          partial.vectorStoreId,
          [firstFile.uploadedFileId],
          false,
        ),
      );
    });
    await expect(createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(401, "partial-owner"),
      prepareResource: firstPrepare,
      cleanupResource: vi.fn(),
    }).acquire({ client: remoteClient(partial) }))
      .rejects.toBeInstanceOf(PolicyVectorStorePreparationError);

    const next = preparedStore(contract, "next");
    const cleanupResource = vi.fn(async (_client, resources) => (
      partialCleanup(
        resources.vectorStoreId,
        resources.uploadedFileIds,
        true,
      )
    ));
    const nextPrepare = prepareImplementation(next);
    const resumed = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(402, "partial-resumer"),
      isOwnerAlive: vi.fn(async () => false),
      prepareResource: nextPrepare,
      cleanupResource,
    });

    await expect(resumed.acquire({ client: remoteClient(next) }))
      .resolves.toEqual(next);
    expect(cleanupResource).toHaveBeenCalledWith(
      expect.anything(),
      {
        vectorStoreId: partial.vectorStoreId,
        uploadedFileIds: [firstFile.uploadedFileId],
      },
    );
    expect(nextPrepare).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "원격 missing",
      remote: { missing: true },
      safeReason: "원격 정책 자원 존재·readiness를 검증하지 못했습니다.",
    },
    {
      name: "manifest tamper",
      remote: { wrongAttributes: true },
      safeReason: "원격 정책 vector file 1의 attributes 계약이 다릅니다.",
    },
  ])("$name이면 실행 전에 fail-closed 정리 결과를 반환한다", async ({
    remote,
    safeReason,
  }) => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest();
    const prepared = preparedStore(contract);
    const cleanupResource = vi.fn(async () => completeCleanup(prepared));
    const controller = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(501, "remote-invalid"),
      prepareResource: prepareImplementation(prepared),
      cleanupResource,
    });

    const failure = await controller.acquire({
      client: remoteClient(prepared, remote),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PolicyVectorStorePreparationError);
    expect((failure as Error).message).toContain(safeReason);
    expect((failure as Error).message).not.toContain(prepared.vectorStoreId);
    expect(cleanupResource).toHaveBeenCalledTimes(1);
    await controller.finalizeCleanup(
      (failure as PolicyVectorStorePreparationError).cleanup,
    );
  });

  it("Vector Store aggregate가 잠시 in_progress여도 유한 poll 뒤 같은 자원을 검증한다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest();
    const prepared = preparedStore(contract);
    const client = remoteClient(prepared);
    let readinessTimeMs = 0;
    vi.mocked(client.vectorStores.retrieve)
      .mockResolvedValueOnce({
        id: prepared.vectorStoreId,
        name: "ai-challenge-hidden-benchmark-policies",
        status: "in_progress",
        file_counts: {
          in_progress: 1,
          completed: 31,
          failed: 0,
          cancelled: 0,
          total: 32,
        },
      })
      .mockResolvedValueOnce({
        id: prepared.vectorStoreId,
        name: "ai-challenge-hidden-benchmark-policies",
        status: "completed",
        file_counts: {
          in_progress: 0,
          completed: 32,
          failed: 0,
          cancelled: 0,
          total: 32,
        },
      });
    const cleanupResource = vi.fn();
    const controller = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(511, "readiness-lag"),
      prepareResource: prepareImplementation(prepared),
      cleanupResource,
      readinessNow: () => readinessTimeMs,
      readinessSleep: async (milliseconds) => {
        readinessTimeMs += milliseconds;
      },
    });

    await expect(controller.acquire({ client })).resolves.toEqual(prepared);
    expect(client.vectorStores.retrieve).toHaveBeenCalledTimes(2);
    expect(cleanupResource).not.toHaveBeenCalled();
  }, 15_000);

  it("read-only readiness 조회의 일시적 5xx는 같은 자원을 유한 재시도한다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest();
    const prepared = preparedStore(contract);
    const client = remoteClient(prepared);
    let readinessTimeMs = 0;
    vi.mocked(client.vectorStores.retrieve)
      .mockRejectedValueOnce(Object.assign(new Error("provider transient"), { status: 500 }));
    const cleanupResource = vi.fn();
    const controller = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(512, "readiness-retry"),
      prepareResource: prepareImplementation(prepared),
      cleanupResource,
      readinessNow: () => readinessTimeMs,
      readinessSleep: async (milliseconds) => {
        readinessTimeMs += milliseconds;
      },
    });

    await expect(controller.acquire({ client })).resolves.toEqual(prepared);
    expect(client.vectorStores.retrieve).toHaveBeenCalledTimes(2);
    expect(cleanupResource).not.toHaveBeenCalled();
  }, 15_000);

  it("readiness가 유한 deadline 안에 완료되지 않으면 정리하고 fail-closed한다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest();
    const prepared = preparedStore(contract);
    const client = remoteClient(prepared, { vectorStatus: "in_progress" });
    let readinessTimeMs = 0;
    const cleanupResource = vi.fn(async () => completeCleanup(prepared));
    const controller = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(513, "readiness-timeout"),
      prepareResource: prepareImplementation(prepared),
      cleanupResource,
      readinessNow: () => readinessTimeMs,
      readinessSleep: async () => {
        readinessTimeMs = 600_000;
      },
    });

    await expect(controller.acquire({ client }))
      .rejects.toBeInstanceOf(PolicyVectorStorePreparationError);
    expect(cleanupResource).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("cleanup incomplete는 owner를 release하고 다음 실행이 재정리한 뒤 기존 ID를 재사용하지 않는다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest();
    const first = preparedStore(contract, "cleanup-retry");
    const firstController = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(601, "cleanup-owner"),
      prepareResource: prepareImplementation(first),
      cleanupResource: vi.fn(),
    });
    await firstController.acquire({ client: remoteClient(first) });
    await expect(firstController.finalizeCleanup(
      completeCleanup(first, false),
    )).rejects.toBeInstanceOf(
      BenchmarkResourceLeaseCleanupIncompleteError,
    );

    const next = preparedStore(contract, "after-cleanup-retry");
    const cleanupResource = vi.fn(async () => completeCleanup(first));
    const nextPrepare = prepareImplementation(next);
    const resumed = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(602, "cleanup-resumer"),
      isOwnerAlive: vi.fn(async () => true),
      prepareResource: nextPrepare,
      cleanupResource,
    });
    await expect(resumed.acquire({ client: remoteClient(next) }))
      .resolves.toEqual(next);
    expect(cleanupResource).toHaveBeenCalledTimes(1);
    expect(nextPrepare).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("항목별 deleted=true를 즉시 영속화해 crash 뒤 이미 삭제된 항목은 재DELETE하지 않는다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest({
      discriminator: "cleanup-item-resume",
    });
    const prepared = preparedStore(contract, "cleanup-item");
    const client = remoteClient(prepared);
    const deleted = new Set<string>();
    vi.mocked(client.vectorStores.delete).mockImplementation(async (id) => {
      deleted.add(id);
      return { id, deleted: true };
    });
    vi.mocked(client.files.delete).mockImplementation(async (id) => {
      deleted.add(id);
      return { id, deleted: true };
    });
    vi.mocked(client.vectorStores.retrieve).mockImplementation(async () => {
      if (deleted.has(prepared.vectorStoreId)) {
        throw new Error("vector store no longer exists");
      }
      return {
        id: prepared.vectorStoreId,
        name: "ai-challenge-hidden-benchmark-policies",
        status: "completed",
        file_counts: {
          in_progress: 0,
          completed: 32,
          failed: 0,
          cancelled: 0,
          total: 32,
        },
      };
    });
    let persistedAcks = 0;
    const first = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(650, "cleanup-crash-owner"),
      prepareResource: prepareImplementation(prepared),
      afterCleanupProgressPersist: async () => {
        persistedAcks += 1;
        if (persistedAcks === 1) throw new Error("simulated cleanup crash");
      },
    });
    await first.acquire({ client });
    await expect(first.cleanup({ client })).rejects.toThrow(
      /simulated cleanup crash/,
    );
    expect(client.vectorStores.delete).toHaveBeenCalledTimes(1);
    expect(client.files.delete).not.toHaveBeenCalled();
    const firstProgress = (await allPaths(root)).filter(
      (path) => /\/cleanup-progress\/.*--try-\d{6}\.json$/.test(path),
    );
    expect(firstProgress).toHaveLength(1);
    const firstProgressHandle = await open(firstProgress[0], "r");
    expect((await firstProgressHandle.stat()).mode & 0o777).toBe(0o600);
    await firstProgressHandle.close();
    expect(JSON.parse(
      await readFile(firstProgress[0], "utf8"),
    )).toMatchObject({
      payload: {
        resource_kind: "VECTOR_STORE",
        delete_acknowledged: true,
      },
    });

    const resumed = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(651, "cleanup-resume-owner"),
      isOwnerAlive: vi.fn(async () => false),
      prepareResource: vi.fn(),
    });
    const failure = await resumed.acquire({ client }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PolicyVectorStorePreparationError);
    expect(client.vectorStores.delete).toHaveBeenCalledTimes(1);
    expect(client.files.delete).toHaveBeenCalledTimes(32);
    expect(
      (failure as PolicyVectorStorePreparationError).cleanup.uploadedFiles
        .every((item) => item.deleted),
    ).toBe(true);
    expect((await allPaths(root)).filter(
      (path) => /\/cleanup-progress\/.*--try-\d{6}\.json$/.test(path),
    )).toHaveLength(33);
  });

  it("terminal-cleaned attempt는 원격 ID를 호출에 재사용하지 않고 local ledger 복구용으로만 반환한다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest({
      outputDirectory: root,
    });
    const first = preparedStore(contract, "terminal-one");
    const firstController = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(701, "terminal-owner"),
      prepareResource: prepareImplementation(first),
      cleanupResource: vi.fn(),
    });
    await firstController.acquire({ client: remoteClient(first) });
    const cleanupReceipt = {
      artifact_kind: "CLEANUP_RECEIPT",
      receipt: "cleanup",
    };
    const recordedPack = {
      artifact_kind: "RECORDED_BENCHMARK_PACK",
      pack: "recorded",
    };
    const cleanupReceiptHash = sha256CanonicalJson(cleanupReceipt);
    const recordedPackHash = sha256CanonicalJson(recordedPack);
    await writeFile(
      join(root, "cleanup-receipt.json"),
      `${canonicalJsonStringify(cleanupReceipt)}\n`,
      { mode: 0o600 },
    );
    await mkdir(join(root, "execution"), { mode: 0o700 });
    await writeFile(
      join(root, "execution", "recorded-pack.json"),
      `${canonicalJsonStringify({
        payload_sha256: recordedPackHash,
        payload: recordedPack,
      })}\n`,
      { mode: 0o600 },
    );
    await firstController.finalizeCleanup(completeCleanup(first), {
      cleanupReceipt: {
        path: join(root, "cleanup-receipt.json"),
        payloadSha256: cleanupReceiptHash,
      },
      recordedPack: {
        path: join(root, "execution", "recorded-pack.json"),
        payloadSha256: recordedPackHash,
      },
    });

    const sameProcessClient = remoteClient(first, { missing: true });
    await expect(firstController.acquire({ client: sameProcessClient }))
      .resolves.toEqual(first);
    expect(firstController.mode()).toBe("TERMINAL_LOCAL_RECOVERY");
    expect(sameProcessClient.vectorStores.retrieve).not.toHaveBeenCalled();

    const prepareSecond = vi.fn();
    const secondClient = remoteClient(first, { missing: true });
    const secondController = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(702, "new-owner"),
      prepareResource: prepareSecond,
      cleanupResource: vi.fn(),
    });
    await expect(secondController.acquire({ client: secondClient }))
      .resolves.toEqual(first);
    expect(secondController.mode()).toBe("TERMINAL_LOCAL_RECOVERY");
    expect(secondController.terminalCleanup()).toEqual(completeCleanup(first));
    expect(prepareSecond).not.toHaveBeenCalled();
    expect(secondClient.vectorStores.retrieve).not.toHaveBeenCalled();
    expect(secondClient.files.retrieve).not.toHaveBeenCalled();

    const completionRecord = (await allPaths(root)).find(
      (path) => /\/completion\/attempt-\d{6}\.json$/.test(path),
    )!;
    const completionWrapper = JSON.parse(
      await readFile(completionRecord, "utf8"),
    ) as { payload: Record<string, unknown> };
    expect(completionWrapper.payload).toMatchObject({
      cleanup_receipt_payload_sha256: cleanupReceiptHash,
      cleanup_receipt_path: join(root, "cleanup-receipt.json"),
      cleanup_receipt_path_sha256: sha256CanonicalJson(
        join(root, "cleanup-receipt.json"),
      ),
      recorded_pack_payload_sha256: recordedPackHash,
      recorded_pack_path: join(root, "execution", "recorded-pack.json"),
      recorded_pack_path_sha256: sha256CanonicalJson(
        join(root, "execution", "recorded-pack.json"),
      ),
    });

    const sourceReloaded = await secondController.completedArtifacts();
    expect(sourceReloaded).toEqual({
      cleanupReceipt: {
        path: join(root, "cleanup-receipt.json"),
        payloadSha256: cleanupReceiptHash,
      },
      recordedPack: {
        path: join(root, "execution", "recorded-pack.json"),
        payloadSha256: recordedPackHash,
      },
    });

    await writeFile(
      join(root, "cleanup-receipt.json"),
      `${canonicalJsonStringify({
        ...cleanupReceipt,
        receipt: "tampered-after-first-source-reload",
      })}\n`,
      { mode: 0o600 },
    );
    await expect(secondController.completedArtifacts())
      .rejects.toBeInstanceOf(BenchmarkResourceLeaseIntegrityError);
  });

  it("cleanup-only terminal은 실제 Recorded Pack·cleanup receipt를 검증한 append-only completion으로 보강된다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest({
      discriminator: "completion-binding",
      outputDirectory: root,
    });
    const prepared = preparedStore(contract, "completion");
    const first = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(750, "completion-first"),
      prepareResource: prepareImplementation(prepared),
      cleanupResource: vi.fn(),
    });
    await first.acquire({ client: remoteClient(prepared) });
    await first.finalizeCleanup(completeCleanup(prepared));
    expect((await allPaths(root)).filter(
      (path) => /\/completion\/attempt-\d{6}\.json$/.test(path),
    )).toHaveLength(0);

    await expect(first.finalizeCleanup(completeCleanup(prepared), {
      cleanupReceipt: {
        path: join(root, "missing-cleanup-receipt.json"),
        payloadSha256: sha256CanonicalJson({ missing: "receipt" }),
      },
      recordedPack: {
        path: join(root, "missing-recorded-pack.json"),
        payloadSha256: sha256CanonicalJson({ missing: "pack" }),
      },
    })).rejects.toBeInstanceOf(BenchmarkResourceLeaseIntegrityError);
    expect((await allPaths(root)).filter(
      (path) => /\/completion\/attempt-\d{6}\.json$/.test(path),
    )).toHaveLength(0);

    const cleanupReceipt = {
      schema_version: "1.0",
      artifact_kind: "CLEANUP_RECEIPT",
      expected_resources: {
        vector_store_id: prepared.vectorStoreId,
        uploaded_file_ids: prepared.uploadedFileIds,
      },
    };
    const cleanupReceiptPath = join(root, "cleanup-receipt.json");
    await writeFile(
      cleanupReceiptPath,
      `${canonicalJsonStringify(cleanupReceipt)}\n`,
      { mode: 0o600 },
    );
    await chmod(cleanupReceiptPath, 0o600);
    const recordedPack = {
      artifact_kind: "RECORDED_BENCHMARK_PACK",
      execution_hash: sha256CanonicalJson("execution"),
    };
    const recordedPackHash = sha256CanonicalJson(recordedPack);
    const recordedPackPath = join(root, "execution", "recorded-pack.json");
    await mkdir(join(root, "execution"), { mode: 0o700 });
    await writeFile(
      recordedPackPath,
      `${canonicalJsonStringify({
        payload_sha256: recordedPackHash,
        payload: recordedPack,
      })}\n`,
      { mode: 0o600 },
    );
    await chmod(recordedPackPath, 0o600);

    const resumed = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(751, "completion-resume"),
      prepareResource: vi.fn(),
      cleanupResource: vi.fn(),
    });
    await resumed.acquire({ client: remoteClient(prepared, { missing: true }) });
    await resumed.finalizeCleanup(completeCleanup(prepared), {
      cleanupReceipt: {
        path: cleanupReceiptPath,
        payloadSha256: sha256CanonicalJson(cleanupReceipt),
      },
      recordedPack: {
        path: recordedPackPath,
        payloadSha256: recordedPackHash,
      },
    });

    expect((await allPaths(root)).filter(
      (path) => /\/completion\/attempt-\d{6}\.json$/.test(path),
    )).toHaveLength(1);
  });

  it("completion binding의 실제 artifact가 사라지거나 변조되면 local recovery를 거부한다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest({
      discriminator: "completion-artifact-tamper",
      outputDirectory: root,
    });
    const prepared = preparedStore(contract, "completion-tamper");
    const controller = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(760, "completion-tamper-owner"),
      prepareResource: prepareImplementation(prepared),
      cleanupResource: vi.fn(),
    });
    await controller.acquire({ client: remoteClient(prepared) });
    const cleanupReceipt = { artifact_kind: "CLEANUP_RECEIPT" };
    const cleanupReceiptPath = join(root, "cleanup-receipt.json");
    await writeFile(
      cleanupReceiptPath,
      `${canonicalJsonStringify(cleanupReceipt)}\n`,
      { mode: 0o600 },
    );
    const pack = { artifact_kind: "RECORDED_BENCHMARK_PACK" };
    const packPath = join(root, "execution", "recorded-pack.json");
    await mkdir(join(root, "execution"), { mode: 0o700 });
    await writeFile(
      packPath,
      `${canonicalJsonStringify({
        payload_sha256: sha256CanonicalJson(pack),
        payload: pack,
      })}\n`,
      { mode: 0o600 },
    );
    await controller.finalizeCleanup(completeCleanup(prepared), {
      cleanupReceipt: {
        path: cleanupReceiptPath,
        payloadSha256: sha256CanonicalJson(cleanupReceipt),
      },
      recordedPack: {
        path: packPath,
        payloadSha256: sha256CanonicalJson(pack),
      },
    });
    await writeFile(cleanupReceiptPath, "{}\n", { mode: 0o600 });

    await expect(createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(761, "completion-tamper-resume"),
      prepareResource: vi.fn(),
      cleanupResource: vi.fn(),
    }).acquire({ client: remoteClient(prepared, { missing: true }) }))
      .rejects.toBeInstanceOf(BenchmarkResourceLeaseIntegrityError);
  });

  it("record tamper·0600 위반·hardlink를 모두 fail-closed 처리한다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest();
    const prepared = preparedStore(contract);
    await createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(801, "integrity-owner"),
      prepareResource: prepareImplementation(prepared),
      cleanupResource: vi.fn(),
    }).acquire({ client: remoteClient(prepared) });

    const ownerRecord = (await allPaths(root)).find(
      (path) => /--owner-000001\.json$/.test(path),
    )!;
    const hardlink = `${ownerRecord}.hardlink`;
    await link(ownerRecord, hardlink);
    const controller = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(802, "integrity-resumer"),
      isOwnerAlive: vi.fn(async () => false),
      prepareResource: vi.fn(),
      cleanupResource: vi.fn(),
    });
    await expect(controller.acquire({ client: remoteClient(prepared) }))
      .rejects.toBeInstanceOf(BenchmarkResourceLeaseIntegrityError);

    const raw = await readFile(ownerRecord, "utf8");
    expect(raw).not.toContain("secret-api-key");
  });

  it("내용 hash를 다시 계산한 additional-key tamper와 0600 위반도 거부한다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest({
      discriminator: "tamper-exact-key",
    });
    const prepared = preparedStore(contract);
    await createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(901, "tamper-owner"),
      prepareResource: prepareImplementation(prepared),
      cleanupResource: vi.fn(),
    }).acquire({ client: remoteClient(prepared) });
    const ownerRecord = (await allPaths(root)).find(
      (path) => /--owner-000001\.json$/.test(path),
    )!;
    const wrapper = JSON.parse(await readFile(ownerRecord, "utf8")) as {
      payload_sha256: string;
      payload: Record<string, unknown>;
    };
    wrapper.payload.additional = "tampered";
    wrapper.payload_sha256 = sha256CanonicalJson(wrapper.payload);
    await writeFile(
      ownerRecord,
      `${canonicalJsonStringify(wrapper)}\n`,
      { mode: 0o600 },
    );
    await chmod(ownerRecord, 0o644);

    await expect(createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(902, "tamper-resumer"),
      isOwnerAlive: vi.fn(async () => false),
      prepareResource: vi.fn(),
      cleanupResource: vi.fn(),
    }).acquire({ client: remoteClient(prepared) }))
      .rejects.toBeInstanceOf(BenchmarkResourceLeaseIntegrityError);
  });

  it("원격 만료 정책은 의미적 identity에서 제외하되 재개 시 잠긴 로컬 metadata 변조를 거부한다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest({
      discriminator: "expiration-metadata-tamper",
    });
    const prepared = preparedStore(contract, "expiration");
    expect(prepared.resourceIdentity).not.toHaveProperty(
      "vectorStoreExpiresAfter",
    );
    expect(prepared.resourceIdentity).not.toHaveProperty("fileExpiresAfter");

    await createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(925, "expiration-owner"),
      prepareResource: prepareImplementation(prepared),
      cleanupResource: vi.fn(),
    }).acquire({ client: remoteClient(prepared) });

    const preparedRecord = (await allPaths(root)).find(
      (path) => /\/prepared\/attempt-000001\.json$/.test(path),
    )!;
    const wrapper = JSON.parse(await readFile(preparedRecord, "utf8")) as {
      payload_sha256: string;
      payload: {
        prepared_store: {
          vectorStoreExpiresAfter: {
            anchor: string;
            days: number;
          };
        };
      };
    };
    wrapper.payload.prepared_store.vectorStoreExpiresAfter.days = 7;
    wrapper.payload_sha256 = sha256CanonicalJson(wrapper.payload);
    await writeFile(
      preparedRecord,
      `${canonicalJsonStringify(wrapper)}\n`,
      { mode: 0o600 },
    );

    await expect(createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(926, "expiration-resumer"),
      isOwnerAlive: vi.fn(async () => false),
      prepareResource: vi.fn(),
      cleanupResource: vi.fn(),
    }).acquire({ client: remoteClient(prepared) }))
      .rejects.toBeInstanceOf(BenchmarkResourceLeaseIntegrityError);
  });

  it("hard-link publish 뒤 temp unlink 전 crash는 동일 inode의 안전한 temp sibling만 제거해 복구한다", async () => {
    const root = await secureRoot();
    const contract = buildBenchmarkResourceLeaseContractForTest({
      discriminator: "hardlink-publish-recovery",
    });
    const prepared = preparedStore(contract, "hardlink-recovery");
    await createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(950, "hardlink-crashed-owner"),
      prepareResource: prepareImplementation(prepared),
      cleanupResource: vi.fn(),
    }).acquire({ client: remoteClient(prepared) });
    const ownerRecord = (await allPaths(root)).find(
      (path) => /--owner-000001\.json$/.test(path),
    )!;
    const sibling = join(
      ownerRecord.slice(0, ownerRecord.lastIndexOf("/")),
      ".lease.tmp-950-simulated-crash",
    );
    await link(ownerRecord, sibling);

    const resumed = createBenchmarkResourceLeaseController({
      rootDirectory: root,
      contract,
      owner: owner(951, "hardlink-recovery-owner"),
      isOwnerAlive: vi.fn(async () => false),
      prepareResource: vi.fn(),
      cleanupResource: vi.fn(),
    });
    await expect(resumed.acquire({ client: remoteClient(prepared) }))
      .resolves.toEqual(prepared);
    const ownerHandle = await open(ownerRecord, "r");
    expect((await ownerHandle.stat()).nlink).toBe(1);
    await ownerHandle.close();
    await expect(open(sibling, "r")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("contract directory symlink와 동시 owner claim race를 fail-closed 처리한다", async () => {
    const symlinkRoot = await secureRoot();
    const external = await secureRoot();
    const symlinkContract = buildBenchmarkResourceLeaseContractForTest({
      discriminator: "symlink",
    });
    await mkdir(join(external, "target"), { mode: 0o700 });
    await symlink(
      join(external, "target"),
      join(symlinkRoot, symlinkContract.contract_sha256),
    );
    const symlinkPrepared = preparedStore(symlinkContract);
    await expect(createBenchmarkResourceLeaseController({
      rootDirectory: symlinkRoot,
      contract: symlinkContract,
      owner: owner(1001, "symlink-owner"),
      prepareResource: prepareImplementation(symlinkPrepared),
      cleanupResource: vi.fn(),
    }).acquire({ client: remoteClient(symlinkPrepared) }))
      .rejects.toBeInstanceOf(BenchmarkResourceLeaseIntegrityError);

    const raceRoot = await secureRoot();
    const raceContract = buildBenchmarkResourceLeaseContractForTest({
      discriminator: "owner-race",
    });
    const racePrepared = preparedStore(raceContract, "race");
    const controllers = [1, 2].map((number) =>
      createBenchmarkResourceLeaseController({
        rootDirectory: raceRoot,
        contract: raceContract,
        owner: owner(1100 + number, `race-owner-${number}`),
        isOwnerAlive: vi.fn(async () => true),
        prepareResource: prepareImplementation(racePrepared),
        cleanupResource: vi.fn(),
      }));
    const outcomes = await Promise.allSettled(
      controllers.map((controller) =>
        controller.acquire({ client: remoteClient(racePrepared) })),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled"))
      .toHaveLength(1);
    const rejection = outcomes.find(
      (outcome) => outcome.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(
      BenchmarkResourceLeaseConflictError,
    );
  }, 15_000);
});

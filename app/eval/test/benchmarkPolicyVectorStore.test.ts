// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { buildCandidateFacingPolicySection } from "../contracts/evaluationCase";
import {
  BENCHMARK_CASES,
  BENCHMARK_CHALLENGE,
  BENCHMARK_ORDERS,
  BENCHMARK_POLICIES,
} from "../data/benchmark/index";
import { createBenchmarkCandidateDefinition } from "../benchmark/candidateDefinitions";
import {
  BENCHMARK_POLICY_CHUNKING_CONFIG,
  buildBenchmarkSearchablePolicyDocuments,
  prepareBenchmarkPolicyVectorStore,
} from "../benchmark/policyVectorStore";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import type { PolicyVectorStoreClientLike } from "../retrieval/policyVectorStore";
import type { CandidateAdapter } from "../runner/types";

const unusedAdapter: CandidateAdapter = {
  invoke: async () => { throw new Error("호출되면 안 됩니다."); },
};

function createClient() {
  let fileNumber = 0;
  const attributesByFileId = new Map<
    string,
    Record<string, string | number | boolean>
  >();
  const createFile = vi.fn().mockImplementation(() => {
    fileNumber += 1;
    return Promise.resolve({ id: `file-benchmark-${fileNumber}` });
  });
  const attachFile = vi.fn().mockImplementation(
    (_vectorStoreId: string, params: { file_id: string }) => Promise.resolve({
      id: params.file_id,
      vector_store_id: "vs-benchmark",
      status: "completed",
      last_error: null,
    }),
  );
  const createFileBatch = vi.fn().mockImplementation(
    (_vectorStoreId: string, params: { file_ids: string[] }) => Promise.resolve({
      id: "vsfb-benchmark",
      vector_store_id: "vs-benchmark",
      status: "completed",
      file_counts: {
        in_progress: 0,
        completed: params.file_ids.length,
        failed: 0,
        cancelled: 0,
        total: params.file_ids.length,
      },
    }),
  );
  const retrieveFileBatch = vi.fn();
  type VectorStoreRetrieveResult = {
    id: string;
    status: "expired" | "in_progress" | "completed";
    file_counts: {
      in_progress: number;
      completed: number;
      failed: number;
      cancelled: number;
      total: number;
    };
  };
  let expectedVectorStoresThis: unknown;
  const retrieveVectorStore = vi.fn(function (
    this: unknown,
    _vectorStoreId: string,
    _options?: unknown,
  ): Promise<VectorStoreRetrieveResult> {
    if (this !== expectedVectorStoresThis) {
      throw new Error("vectorStores.retrieve 호출 문맥이 보존되지 않았습니다.");
    }
    return Promise.resolve({
      id: "vs-benchmark",
      status: "completed",
      file_counts: {
        in_progress: 0,
        completed: fileNumber,
        failed: 0,
        cancelled: 0,
        total: fileNumber,
      },
    });
  });
  const updateVectorStoreFile = vi.fn().mockImplementation(
    (
      fileId: string,
      params: {
        vector_store_id: string;
        attributes: Record<string, string | number | boolean>;
      },
    ) => {
      attributesByFileId.set(fileId, { ...params.attributes });
      return Promise.resolve({
        id: fileId,
        vector_store_id: params.vector_store_id,
        status: "completed",
        last_error: null,
        attributes: { ...params.attributes },
        chunking_strategy: structuredClone(BENCHMARK_POLICY_CHUNKING_CONFIG),
      });
    },
  );
  const retrieveVectorStoreFile = vi.fn().mockImplementation(
    (fileId: string, params: { vector_store_id: string }) => Promise.resolve({
      id: fileId,
      vector_store_id: params.vector_store_id,
      status: "completed",
      last_error: null,
      attributes: attributesByFileId.get(fileId),
      chunking_strategy: structuredClone(BENCHMARK_POLICY_CHUNKING_CONFIG),
    }),
  );
  const clientVectorStores = {
      create: vi.fn().mockResolvedValue({ id: "vs-benchmark", status: "completed" }),
      retrieve: retrieveVectorStore,
      files: {
        create: attachFile,
        retrieve: retrieveVectorStoreFile,
        update: updateVectorStoreFile,
      },
      fileBatches: {
        create: createFileBatch,
        retrieve: retrieveFileBatch,
      },
      search: vi.fn(),
      delete: vi.fn().mockResolvedValue({ id: "vs-benchmark", deleted: true }),
  };
  expectedVectorStoresThis = clientVectorStores;
  const client = {
    vectorStores: clientVectorStores,
    files: {
      create: createFile,
      delete: vi.fn().mockImplementation((fileId: string) => Promise.resolve({
        id: fileId,
        deleted: true,
      })),
    },
  } as unknown as PolicyVectorStoreClientLike;
  return {
    client,
    createFile,
    attachFile,
    createFileBatch,
    retrieveFileBatch,
    retrieveVectorStore,
    retrieveVectorStoreFile,
    updateVectorStoreFile,
  };
}

function candidateDefinition(candidateId: "B" | "C") {
  const evaluationCase = BENCHMARK_CASES.find((item) => item.case_id === "H-001")!;
  const order = BENCHMARK_ORDERS.find((item) => item.order_id === evaluationCase.order_id)!;
  return createBenchmarkCandidateDefinition({
    candidateId,
    evaluationCase,
    authorizedOrder: order,
    policyCorpus: BENCHMARK_POLICIES,
    adapter: unusedAdapter,
    challenge: BENCHMARK_CHALLENGE,
  });
}

describe("숨은 Benchmark 전용 정책 Vector Store", () => {
  it("실제 32개 PolicySection을 evaluator metadata 없는 searchable document로 결정적 변환한다", () => {
    const documents = buildBenchmarkSearchablePolicyDocuments(BENCHMARK_POLICIES);

    expect(documents).toHaveLength(32);
    documents.forEach((document, index) => {
      const source = BENCHMARK_POLICIES[index];
      expect(document).toMatchObject({
        source_id: source.source_id,
        section_id: source.section_id,
        version: source.version,
        title: source.title,
        lifecycle_status: source.lifecycle_status,
        effective_from: source.effective_from,
        effective_to: source.effective_to,
        text: source.text,
        scope: source.scope,
        fact_ids: source.fact_ids,
        fact_id: source.fact_ids[0],
      });
      expect(document).not.toHaveProperty("synthetic");
      expect(document).not.toHaveProperty("section_class");
      expect(document.fact_ids).toEqual(source.fact_ids);
    });
    expect(buildBenchmarkSearchablePolicyDocuments(BENCHMARK_POLICIES))
      .toEqual(documents);
  });

  it("여러 fact_ids가 생겨도 전체 배열을 보존하고 첫 항목만 legacy 대표 fact_id로 사용한다", () => {
    const multiFactPolicy = {
      ...BENCHMARK_POLICIES[0],
      fact_ids: [...BENCHMARK_POLICIES[0].fact_ids, "SECONDARY_SEARCHABLE_FACT"],
    };

    const [document] = buildBenchmarkSearchablePolicyDocuments([multiFactPolicy]);

    expect(document.fact_id).toBe(BENCHMARK_POLICIES[0].fact_ids[0]);
    expect(document.fact_ids).toEqual([
      BENCHMARK_POLICIES[0].fact_ids[0],
      "SECONDARY_SEARCHABLE_FACT",
    ]);
  });

  it("실제 32개 문서를 한 batch로 static 600/300 첨부한 뒤 파일별 속성과 원격 상태를 검증한다", async () => {
    const {
      client,
      createFile,
      attachFile,
      createFileBatch,
      retrieveVectorStoreFile,
      updateVectorStoreFile,
    } = createClient();
    const prepared = await prepareBenchmarkPolicyVectorStore(client, BENCHMARK_POLICIES, {
      now: () => 0,
    });
    const candidateFacingCorpus = BENCHMARK_POLICIES.map(buildCandidateFacingPolicySection);
    const candidateB = candidateDefinition("B");
    const candidateC = candidateDefinition("C");

    expect(createFile).toHaveBeenCalledTimes(32);
    expect(attachFile).not.toHaveBeenCalled();
    expect(createFileBatch).toHaveBeenCalledTimes(1);
    expect(createFileBatch.mock.calls[0][1]).toEqual({
      file_ids: Array.from(
        { length: 32 },
        (_, index) => `file-benchmark-${index + 1}`,
      ),
      chunking_strategy: BENCHMARK_POLICY_CHUNKING_CONFIG,
    });
    expect(updateVectorStoreFile).toHaveBeenCalledTimes(32);
    expect(retrieveVectorStoreFile).toHaveBeenCalledTimes(32);
    for (const [index, call] of createFile.mock.calls.entries()) {
      const uploaded = call[0].file as File;
      const document = JSON.parse(await uploaded.text());
      expect(document.fact_id).toBe(BENCHMARK_POLICIES[index].fact_ids[0]);
      expect(document.fact_ids).toEqual(BENCHMARK_POLICIES[index].fact_ids);
      expect(document).not.toHaveProperty("section_class");
      expect(document).not.toHaveProperty("synthetic");
      expect(updateVectorStoreFile.mock.calls[index]).toEqual([
        `file-benchmark-${index + 1}`,
        {
          vector_store_id: "vs-benchmark",
          attributes: {
            source_id: document.source_id,
            section_id: document.section_id,
            fact_id: document.fact_id,
          },
        },
        expect.objectContaining({ maxRetries: 0 }),
      ]);
      expect(retrieveVectorStoreFile.mock.calls[index]).toEqual([
        `file-benchmark-${index + 1}`,
        {
          vector_store_id: "vs-benchmark",
        },
        expect.objectContaining({ maxRetries: 0 }),
      ]);
    }
    expect(prepared).toMatchObject({
      uploadMethod: "FILES_CREATE_THEN_BATCH_ATTACH_AND_VERIFY",
      ingestionStatus: "completed",
    });
    expect(prepared.files).toHaveLength(32);
    expect(prepared.resourceIdentity).toMatchObject({
      schema_version: "benchmark-policy-resource-v1",
      policy_corpus_sha256: sha256CanonicalJson(candidateFacingCorpus),
      chunking_config: BENCHMARK_POLICY_CHUNKING_CONFIG,
      chunking_config_sha256: sha256CanonicalJson(BENCHMARK_POLICY_CHUNKING_CONFIG),
      resource_contract_sha256: candidateB.config.policy_resource_contract_hash,
      manifest_sha256: prepared.manifestSha256,
    });
    expect(candidateB.config.policy_corpus_hash)
      .toBe(prepared.resourceIdentity.policy_corpus_sha256);
    expect(candidateC.config.policy_corpus_hash)
      .toBe(prepared.resourceIdentity.policy_corpus_sha256);
    expect(candidateB.config.policy_resource_contract_hash)
      .toBe(candidateC.config.policy_resource_contract_hash);
    expect(candidateB.config.policy_resource_contract_hash)
      .toBe(prepared.resourceIdentity.resource_contract_sha256);
    expect(prepared.manifestSha256).toBe(sha256CanonicalJson({
      files: prepared.files,
      chunking_config: BENCHMARK_POLICY_CHUNKING_CONFIG,
    }));
    expect(prepared.resourceIdentitySha256)
      .toBe(sha256CanonicalJson(prepared.resourceIdentity));
  });

  it("batch가 진행 중이면 오작동이 관측된 batch retrieve 대신 부모 Vector Store를 조회한다", async () => {
    const {
      client,
      createFileBatch,
      retrieveFileBatch,
      retrieveVectorStore,
    } = createClient();
    createFileBatch.mockResolvedValue({
      id: "vsfb-benchmark",
      vector_store_id: "vs-benchmark",
      status: "in_progress",
      file_counts: {
        in_progress: 1,
        completed: 0,
        failed: 0,
        cancelled: 0,
        total: 1,
      },
    });
    retrieveFileBatch.mockRejectedValue(
      new Error("실제 경로에서는 호출되면 안 됩니다."),
    );
    let pollNumber = 0;
    retrieveVectorStore.mockImplementation(function (this: unknown) {
      expect(this).toBe(client.vectorStores);
      pollNumber += 1;
      return Promise.resolve(pollNumber === 1
        ? {
          id: "vs-benchmark",
          status: "in_progress" as const,
          file_counts: {
            in_progress: 1,
            completed: 0,
            failed: 0,
            cancelled: 0,
            total: 1,
          },
        }
        : {
          id: "vs-benchmark",
          status: "completed" as const,
          file_counts: {
            in_progress: 0,
            completed: 1,
            failed: 0,
            cancelled: 0,
            total: 1,
          },
        });
    });

    await expect(prepareBenchmarkPolicyVectorStore(
      client,
      [BENCHMARK_POLICIES[0]],
      {
        now: () => 0,
        sleep: async () => {},
      },
    )).resolves.toMatchObject({ ingestionStatus: "completed" });

    expect(retrieveFileBatch).not.toHaveBeenCalled();
    expect(retrieveVectorStore).toHaveBeenCalledTimes(2);
    for (const call of retrieveVectorStore.mock.calls) {
      expect(call[0]).toBe("vs-benchmark");
      expect(call[1]).toEqual(expect.objectContaining({ maxRetries: 0 }));
    }
  });

  it("batch 완료 뒤 원격 청킹이 잠긴 600/300과 다르면 전체 준비를 실패하고 정리한다", async () => {
    const {
      client,
      retrieveVectorStoreFile,
    } = createClient();
    retrieveVectorStoreFile.mockResolvedValue({
      id: "file-benchmark-1",
      vector_store_id: "vs-benchmark",
      status: "completed",
      last_error: null,
      attributes: {
        source_id: BENCHMARK_POLICIES[0].source_id,
        section_id: BENCHMARK_POLICIES[0].section_id,
        fact_id: BENCHMARK_POLICIES[0].fact_ids[0],
      },
      chunking_strategy: {
        type: "static",
        static: {
          max_chunk_size_tokens: 800,
          chunk_overlap_tokens: 400,
        },
      },
    });

    await expect(prepareBenchmarkPolicyVectorStore(
      client,
      [BENCHMARK_POLICIES[0]],
      { now: () => 0 },
    )).rejects.toMatchObject({
      message: expect.stringContaining("chunking"),
      cleanup: {
        vectorStore: { attempted: true, deleted: true },
        uploadedFiles: [
          { id: "file-benchmark-1", attempted: true, deleted: true },
        ],
      },
    });
  });

  it("파일 속성 갱신 오류가 모호해도 원격 상태가 정확하면 중복 갱신 없이 성공한다", async () => {
    const {
      client,
      updateVectorStoreFile,
      retrieveVectorStoreFile,
    } = createClient();
    updateVectorStoreFile.mockRejectedValue(
      Object.assign(new Error("gateway timeout"), { status: 504 }),
    );
    retrieveVectorStoreFile.mockResolvedValue({
      id: "file-benchmark-1",
      vector_store_id: "vs-benchmark",
      status: "completed",
      last_error: null,
      attributes: {
        source_id: BENCHMARK_POLICIES[0].source_id,
        section_id: BENCHMARK_POLICIES[0].section_id,
        fact_id: BENCHMARK_POLICIES[0].fact_ids[0],
      },
      chunking_strategy: structuredClone(BENCHMARK_POLICY_CHUNKING_CONFIG),
    });

    await expect(prepareBenchmarkPolicyVectorStore(
      client,
      [BENCHMARK_POLICIES[0]],
      { now: () => 0 },
    )).resolves.toMatchObject({ ingestionStatus: "completed" });

    expect(updateVectorStoreFile).toHaveBeenCalledTimes(1);
    expect(retrieveVectorStoreFile).toHaveBeenCalledTimes(1);
  });

  it("파일 속성이 갱신 직후 비어 있어도 잠긴 값이 원격 조회에 반영될 때까지 유한 재검증한다", async () => {
    const {
      client,
      retrieveVectorStoreFile,
    } = createClient();
    let elapsedMs = 0;
    let retrieveCount = 0;
    retrieveVectorStoreFile.mockImplementation(
      (fileId: string, params: { vector_store_id: string }) => {
        retrieveCount += 1;
        return Promise.resolve({
          id: fileId,
          vector_store_id: params.vector_store_id,
          status: "completed",
          last_error: null,
          attributes: retrieveCount === 1
            ? {}
            : {
              source_id: BENCHMARK_POLICIES[0].source_id,
              section_id: BENCHMARK_POLICIES[0].section_id,
              fact_id: BENCHMARK_POLICIES[0].fact_ids[0],
            },
          chunking_strategy: structuredClone(BENCHMARK_POLICY_CHUNKING_CONFIG),
        });
      },
    );

    await expect(prepareBenchmarkPolicyVectorStore(
      client,
      [BENCHMARK_POLICIES[0]],
      {
        now: () => elapsedMs,
        sleep: async (milliseconds) => {
          elapsedMs += milliseconds;
        },
      },
    )).resolves.toMatchObject({ ingestionStatus: "completed" });

    expect(retrieveVectorStoreFile).toHaveBeenCalledTimes(2);
    expect(elapsedMs).toBe(500);
  });

  it("32개 batch 준비가 공개 보정용 30초를 넘어도 Benchmark 전용 setup 예산 안에서 완료된다", async () => {
    const {
      client,
      createFile,
      createFileBatch,
      updateVectorStoreFile,
      retrieveVectorStoreFile,
    } = createClient();
    let elapsedMs = 0;
    let fileNumber = 0;
    createFile.mockImplementation(() => {
      elapsedMs += 4_000;
      fileNumber += 1;
      return Promise.resolve({ id: `file-benchmark-${fileNumber}` });
    });
    createFileBatch.mockImplementation(
      (_vectorStoreId: string, params: { file_ids: string[] }) => {
        elapsedMs += 4_000;
        return Promise.resolve({
          id: "vsfb-benchmark",
          vector_store_id: "vs-benchmark",
          status: "completed",
          file_counts: {
            in_progress: 0,
            completed: params.file_ids.length,
            failed: 0,
            cancelled: 0,
            total: params.file_ids.length,
          },
        });
      },
    );
    updateVectorStoreFile.mockImplementation(
      (fileId: string, params: {
        vector_store_id: string;
        attributes: {
          source_id: string;
          section_id: string;
          fact_id: string;
        },
      }) => {
        elapsedMs += 4_000;
        return Promise.resolve({
          id: fileId,
          vector_store_id: params.vector_store_id,
          status: "completed",
          last_error: null,
          attributes: { ...params.attributes },
          chunking_strategy: structuredClone(BENCHMARK_POLICY_CHUNKING_CONFIG),
        });
      },
    );
    retrieveVectorStoreFile.mockImplementation(
      (fileId: string, params: { vector_store_id: string }) => {
        elapsedMs += 4_000;
        const index = Number(fileId.split("-").at(-1)) - 1;
        const policy = BENCHMARK_POLICIES[index];
        return Promise.resolve({
          id: fileId,
          vector_store_id: params.vector_store_id,
          status: "completed",
          last_error: null,
          attributes: {
            source_id: policy.source_id,
            section_id: policy.section_id,
            fact_id: policy.fact_ids[0],
          },
          chunking_strategy: structuredClone(BENCHMARK_POLICY_CHUNKING_CONFIG),
        });
      },
    );

    const prepared = await prepareBenchmarkPolicyVectorStore(
      client,
      BENCHMARK_POLICIES,
      { now: () => elapsedMs },
    );

    expect(elapsedMs).toBe(388_000);
    expect(prepared.files).toHaveLength(32);
    expect(createFile).toHaveBeenCalledTimes(32);
    expect(createFileBatch).toHaveBeenCalledTimes(1);
    expect(updateVectorStoreFile).toHaveBeenCalledTimes(32);
    expect(retrieveVectorStoreFile).toHaveBeenCalledTimes(32);
  });

  it("느린 batch 인덱싱이 60초를 넘어도 Benchmark 전용 poll 예산 안에서 완료된다", async () => {
    const { client, createFileBatch, retrieveVectorStore } = createClient();
    let elapsedMs = 0;
    createFileBatch.mockResolvedValue({
      id: "vsfb-benchmark",
      vector_store_id: "vs-benchmark",
      status: "in_progress",
      file_counts: {
        in_progress: 1,
        completed: 0,
        failed: 0,
        cancelled: 0,
        total: 1,
      },
    });
    retrieveVectorStore.mockImplementation(async () => {
      elapsedMs += 90_000;
      return {
        id: "vs-benchmark",
        status: "completed",
        file_counts: {
          in_progress: 0,
          completed: 1,
          failed: 0,
          cancelled: 0,
          total: 1,
        },
      };
    });

    const prepared = await prepareBenchmarkPolicyVectorStore(
      client,
      [BENCHMARK_POLICIES[0]],
      {
        now: () => elapsedMs,
        sleep: async (milliseconds) => {
          elapsedMs += milliseconds;
        },
      },
    );

    expect(elapsedMs).toBe(90_500);
    expect(retrieveVectorStore).toHaveBeenCalledTimes(1);
    expect(prepared.files).toHaveLength(1);
  });

  it("실제 관측된 180초 초과 batch 인덱싱에 충분한 유한 Benchmark poll 예산을 둔다", async () => {
    const { client, createFileBatch, retrieveVectorStore } = createClient();
    let elapsedMs = 0;
    createFileBatch.mockResolvedValue({
      id: "vsfb-benchmark",
      vector_store_id: "vs-benchmark",
      status: "in_progress",
      file_counts: {
        in_progress: 1,
        completed: 0,
        failed: 0,
        cancelled: 0,
        total: 1,
      },
    });
    retrieveVectorStore.mockImplementation(async () => {
      elapsedMs += 480_000;
      return {
        id: "vs-benchmark",
        status: "completed",
        file_counts: {
          in_progress: 0,
          completed: 1,
          failed: 0,
          cancelled: 0,
          total: 1,
        },
      };
    });

    const prepared = await prepareBenchmarkPolicyVectorStore(
      client,
      [BENCHMARK_POLICIES[0]],
      {
        now: () => elapsedMs,
        sleep: async (milliseconds) => {
          elapsedMs += milliseconds;
        },
      },
    );

    expect(elapsedMs).toBe(480_500);
    expect(retrieveVectorStore).toHaveBeenCalledTimes(1);
    expect(prepared.files).toHaveLength(1);
  });
});

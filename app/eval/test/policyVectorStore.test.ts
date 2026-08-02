// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { APIConnectionTimeoutError } from "openai";
import {
  PolicyRetrievalError,
  PolicyVectorStorePreparationError,
  cleanupPolicyVectorStore,
  preparePolicyVectorStore,
  searchPolicyVectorStore,
  type PolicyVectorStoreClientLike,
} from "../retrieval/policyVectorStore";
import type { CandidateProgressEvent } from "../runner/progress";

const { toFileSpy } = vi.hoisted(() => ({
  toFileSpy: vi.fn(),
}));

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  toFileSpy.mockImplementation(actual.toFile);
  return {
    ...actual,
    toFile: toFileSpy,
  };
});

const policies = [
  {
    source_id: "CANCEL-2026",
    section_id: "2.2",
    fact_id: "CANCEL-AFTER-SHIPMENT-2026",
    title: "Order Cancellation Policy",
    lifecycle_status: "ACTIVE",
    effective_from: "2026-01-01T00:00:00Z",
    effective_to: null,
    text: "Orders in SHIPPED status cannot be cancelled.",
  },
  {
    source_id: "CANCEL-2025",
    section_id: "2.2",
    fact_id: "CANCEL-AFTER-SHIPMENT-2025",
    title: "Order Cancellation Policy",
    lifecycle_status: "RETIRED",
    effective_from: "2025-01-01T00:00:00Z",
    effective_to: "2025-12-31T23:59:59Z",
    text: "A retired policy allowed a carrier stop request.",
  },
] as const;

const manifest = [
  {
    uploadedFileId: "file-active",
    filename: "synthetic-policy-CANCEL-AFTER-SHIPMENT-2026.json",
    sourceId: "CANCEL-2026",
    sectionId: "2.2",
    factId: "CANCEL-AFTER-SHIPMENT-2026",
    payloadSha256: "99531f722a484d540d57708738b9a7ad078e28b8795b43529d1af48b9f824600",
  },
  {
    uploadedFileId: "file-retired",
    filename: "synthetic-policy-CANCEL-AFTER-SHIPMENT-2025.json",
    sourceId: "CANCEL-2025",
    sectionId: "2.2",
    factId: "CANCEL-AFTER-SHIPMENT-2025",
    payloadSha256: "10e0df583650895c4b8d8a6d3abd1bbdb1663bfeed8eef1c2d9491d4b7f13904",
  },
] as const;

const NO_RETRY_SETUP_OPTIONS = { timeout: 30_000, maxRetries: 0 } as const;
const NO_RETRY_CLEANUP_OPTIONS = { timeout: 10_000, maxRetries: 0 } as const;

function createClient(overrides: {
  createVectorStore?: ReturnType<typeof vi.fn>;
  createFile?: ReturnType<typeof vi.fn>;
  attachFile?: ReturnType<typeof vi.fn>;
  retrieveFile?: ReturnType<typeof vi.fn>;
  search?: ReturnType<typeof vi.fn>;
  deleteVectorStore?: ReturnType<typeof vi.fn>;
  deleteFile?: ReturnType<typeof vi.fn>;
} = {}): PolicyVectorStoreClientLike {
  let defaultFileIndex = 0;
  const client = {
    vectorStores: {
      create: overrides.createVectorStore ?? vi.fn().mockResolvedValue({
        id: "vs-policy",
        status: "completed",
      }),
      files: {
        create: overrides.attachFile ?? vi.fn().mockImplementation(
          (_vectorStoreId: string, params: { file_id: string }) => Promise.resolve({
            id: params.file_id,
            vector_store_id: "vs-policy",
            status: "completed",
            last_error: null,
          }),
        ),
        retrieve: overrides.retrieveFile ?? vi.fn().mockResolvedValue({
          id: "file-policy",
          vector_store_id: "vs-policy",
          status: "completed",
          last_error: null,
        }),
      },
      search: overrides.search ?? vi.fn().mockResolvedValue({ data: [], object: "list" }),
      delete: overrides.deleteVectorStore ?? vi.fn().mockResolvedValue({
        id: "vs-policy",
        deleted: true,
      }),
    },
    files: {
      create: overrides.createFile ?? vi.fn().mockImplementation(() => {
        const id = manifest[defaultFileIndex]?.uploadedFileId ?? `file-${defaultFileIndex}`;
        defaultFileIndex += 1;
        return Promise.resolve({ id, purpose: "assistants" });
      }),
      delete: overrides.deleteFile ?? vi.fn().mockImplementation((id: string) => Promise.resolve({
        id,
        deleted: true,
      })),
    },
  };
  return client as unknown as PolicyVectorStoreClientLike;
}

describe("합성 정책 vector store 수명주기", () => {
  it("공개 환경 준비 observer를 원격 생성 전에 await하고 remote ID 없이 완료를 알린다", async () => {
    const order: string[] = [];
    const events: CandidateProgressEvent[] = [];
    const client = createClient({
      createVectorStore: vi.fn(async () => {
        order.push("remote-vector");
        return { id: "vs-private", status: "completed" };
      }),
      createFile: vi.fn().mockResolvedValue({
        id: "file-private",
        purpose: "assistants",
      }),
      attachFile: vi.fn().mockResolvedValue({
        id: "file-private",
        vector_store_id: "vs-private",
        status: "completed",
        last_error: null,
      }),
    });

    await preparePolicyVectorStore(client, [policies[0]], {
      onProgress: async (event) => {
        await Promise.resolve();
        events.push(event);
        order.push(event.kind);
      },
    });

    expect(order[0]).toBe("ENVIRONMENT_PREPARING");
    expect(order[1]).toBe("remote-vector");
    expect(events.map((event) => event.kind)).toEqual([
      "ENVIRONMENT_PREPARING",
      "ENVIRONMENT_PREPARED",
    ]);
    for (const event of events) {
      expect(event).not.toHaveProperty("vectorStoreId");
      expect(event).not.toHaveProperty("uploadedFileId");
    }
  });

  it("원격 create 응답 직후 다음 원격 호출 전에 준비 이벤트를 순서대로 await한다", async () => {
    const order: string[] = [];
    const client = createClient({
      createVectorStore: vi.fn(async () => {
        order.push("remote-vector");
        return { id: "vs-policy", status: "completed" };
      }),
      createFile: vi.fn(async () => {
        order.push("remote-upload");
        return { id: "file-active", purpose: "assistants" };
      }),
      attachFile: vi.fn(async () => {
        order.push("remote-attach");
        return {
          id: "file-active",
          vector_store_id: "vs-policy",
          status: "completed",
          last_error: null,
        };
      }),
    });

    await preparePolicyVectorStore(client, [policies[0]], {
      onPreparationEvent: async (event) => {
        await Promise.resolve();
        order.push(`journal-${event.kind}`);
      },
    });

    expect(order).toEqual([
      "remote-vector",
      "journal-VECTOR_STORE_CREATED",
      "remote-upload",
      "journal-UPLOADED_FILE_CREATED",
      "remote-attach",
      "journal-VECTOR_STORE_FILE_ATTACHED",
    ]);
  });

  it("durable progress journal 실패 시 다음 원격 호출을 막고 이미 생성한 자원을 정리한다", async () => {
    const attachFile = vi.fn();
    const deleteVectorStore = vi.fn().mockResolvedValue({
      id: "vs-policy",
      deleted: true,
    });
    const client = createClient({ attachFile, deleteVectorStore });

    const failure = await preparePolicyVectorStore(client, [policies[0]], {
      onPreparationEvent: async (event) => {
        if (event.kind === "UPLOADED_FILE_CREATED") {
          throw new Error("simulated fsync failure");
        }
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PolicyVectorStorePreparationError);
    expect(failure).toMatchObject({
      vectorStoreId: "vs-policy",
      uploadedFileIds: ["file-active"],
      cleanup: {
        vectorStore: { attempted: true, deleted: true },
        uploadedFiles: [{ attempted: true, deleted: true }],
      },
    });
    expect(attachFile).not.toHaveBeenCalled();
    expect(deleteVectorStore).toHaveBeenCalledTimes(1);
  });

  it("실행 취소 신호를 생성·업로드·연결·조회 요청에 모두 전달한다", async () => {
    const controller = new AbortController();
    const createVectorStore = vi.fn().mockResolvedValue({ id: "vs-policy", status: "completed" });
    const createFile = vi.fn().mockResolvedValue({ id: "file-active", purpose: "assistants" });
    const attachFile = vi.fn().mockResolvedValue({
      id: "file-active",
      vector_store_id: "vs-policy",
      status: "in_progress",
      last_error: null,
    });
    const retrieveFile = vi.fn().mockResolvedValue({
      id: "file-active",
      vector_store_id: "vs-policy",
      status: "completed",
      last_error: null,
    });
    const client = createClient({ createVectorStore, createFile, attachFile, retrieveFile });

    await preparePolicyVectorStore(client, [policies[0]], {
      setupTimeoutMs: 30_000,
      pollIntervalMs: 1,
      pollTimeoutMs: 100,
      now: () => 0,
      sleep: async () => {},
      signal: controller.signal,
    });

    expect(createVectorStore).toHaveBeenCalledWith(expect.any(Object), {
      timeout: 30_000,
      maxRetries: 0,
      signal: controller.signal,
    });
    expect(createFile).toHaveBeenCalledWith(expect.any(Object), {
      timeout: 30_000,
      maxRetries: 0,
      signal: controller.signal,
    });
    expect(attachFile).toHaveBeenCalledWith("vs-policy", expect.any(Object), {
      timeout: 30_000,
      maxRetries: 0,
      signal: controller.signal,
    });
    expect(retrieveFile).toHaveBeenCalledWith("file-active", {
      vector_store_id: "vs-policy",
    }, {
      maxRetries: 0,
      timeout: 100,
      signal: controller.signal,
    });
  });

  it("poll 대기 중 취소되면 즉시 중단하고 취소된 신호 없이 리소스를 정리한다", async () => {
    const controller = new AbortController();
    const abortReason = new Error("calibration cancelled");
    let notifySleepStarted!: () => void;
    const sleepStarted = new Promise<void>((resolve) => { notifySleepStarted = resolve; });
    const sleep = vi.fn().mockImplementation(() => {
      notifySleepStarted();
      return new Promise<void>(() => {});
    });
    const retrieveFile = vi.fn();
    const deleteVectorStore = vi.fn().mockResolvedValue({ id: "vs-policy", deleted: true });
    const deleteFile = vi.fn().mockResolvedValue({ id: "file-active", deleted: true });
    const client = createClient({
      attachFile: vi.fn().mockResolvedValue({
        id: "file-active",
        vector_store_id: "vs-policy",
        status: "in_progress",
        last_error: null,
      }),
      retrieveFile,
      deleteVectorStore,
      deleteFile,
    });

    const preparation = preparePolicyVectorStore(client, [policies[0]], {
      signal: controller.signal,
      sleep,
    }).catch((error: unknown) => error);
    await sleepStarted;
    controller.abort(abortReason);

    const outcome = await Promise.race([
      preparation,
      new Promise<"DID_NOT_SETTLE">((resolve) => {
        setTimeout(() => resolve("DID_NOT_SETTLE"), 50);
      }),
    ]);

    expect(outcome).not.toBe("DID_NOT_SETTLE");
    expect(outcome).toBeInstanceOf(PolicyVectorStorePreparationError);
    expect(outcome).toMatchObject({ cause: abortReason });
    expect(retrieveFile).not.toHaveBeenCalled();
    expect(deleteVectorStore).toHaveBeenCalledWith("vs-policy", NO_RETRY_CLEANUP_OPTIONS);
    expect(deleteFile).toHaveBeenCalledWith("file-active", NO_RETRY_CLEANUP_OPTIONS);
    expect(deleteVectorStore.mock.calls[0]?.[1]).not.toHaveProperty("signal");
    expect(deleteFile.mock.calls[0]?.[1]).not.toHaveProperty("signal");
  });

  it("원본 file ID를 먼저 확보하고 1일 만료 vector store에 식별자가 포함된 UTF-8 JSON을 연결한다", async () => {
    const toFileCallOffset = toFileSpy.mock.calls.length;
    const createVectorStore = vi.fn().mockResolvedValue({ id: "vs-policy", status: "completed" });
    const createFile = vi.fn()
      .mockResolvedValueOnce({ id: "file-active", purpose: "assistants" })
      .mockResolvedValueOnce({ id: "file-retired", purpose: "assistants" });
    const attachFile = vi.fn().mockImplementation(
      (_vectorStoreId: string, params: { file_id: string }) => Promise.resolve({
        id: params.file_id,
        vector_store_id: "vs-policy",
        status: "completed",
        last_error: null,
      }),
    );
    const client = createClient({ createVectorStore, createFile, attachFile });

    const resource = await preparePolicyVectorStore(client, policies, {
      name: "calibration-policy-v1",
      filenamePrefix: "synthetic-policy",
      setupTimeoutMs: 30_000,
      cleanupTimeoutMs: 10_000,
      now: () => 0,
    });

    expect(createVectorStore).toHaveBeenCalledWith({
      name: "calibration-policy-v1",
      expires_after: { anchor: "last_active_at", days: 1 },
    }, NO_RETRY_SETUP_OPTIONS);
    expect(createFile).toHaveBeenCalledTimes(2);
    const uploadInputs = toFileSpy.mock.calls
      .slice(toFileCallOffset)
      .map(([value]) => value);
    expect(uploadInputs).toHaveLength(2);
    for (const uploadInput of uploadInputs) {
      expect(uploadInput).toBeInstanceOf(Uint8Array);
      expect(uploadInput?.constructor).toBe(Uint8Array);
    }
    for (const [index, call] of createFile.mock.calls.entries()) {
      const createFileParams = call[0];
      expect(createFileParams).toMatchObject({
        purpose: "assistants",
        expires_after: { anchor: "created_at", seconds: 86_400 },
      });
      expect(call[1]).toEqual(NO_RETRY_SETUP_OPTIONS);
      const uploadedFile = createFileParams.file as File;
      expect(uploadedFile.name).toBe(manifest[index].filename);
      expect(uploadedFile.type).toBe("application/json");
      expect(JSON.parse(await uploadedFile.text())).toEqual(policies[index]);
    }
    expect(attachFile).toHaveBeenNthCalledWith(1, "vs-policy", {
      file_id: "file-active",
      attributes: {
        source_id: "CANCEL-2026",
        section_id: "2.2",
        fact_id: "CANCEL-AFTER-SHIPMENT-2026",
      },
    }, NO_RETRY_SETUP_OPTIONS);
    expect(attachFile).toHaveBeenNthCalledWith(2, "vs-policy", {
      file_id: "file-retired",
      attributes: {
        source_id: "CANCEL-2025",
        section_id: "2.2",
        fact_id: "CANCEL-AFTER-SHIPMENT-2025",
      },
    }, NO_RETRY_SETUP_OPTIONS);
    expect(resource).toMatchObject({
      vectorStoreId: "vs-policy",
      ingestionStatus: "completed",
      uploadedFileIds: ["file-active", "file-retired"],
      files: manifest,
      vectorStoreExpiresAfter: { anchor: "last_active_at", days: 1 },
      uploadMethod: "FILES_CREATE_AND_BOUNDED_VECTOR_STORE_POLL",
      fileExpiresAfter: { anchor: "created_at", seconds: 86_400 },
    });
    expect(resource.manifestSha256).toBe(
      "4bfb4cb5185cc273aa389a8c58e78e1b74d2dc999d886b082edfaaaed9b0545f",
    );
  });

  it("in_progress ingestion을 유한한 직접 poll로 완료하고 cancelled를 완료로 오인하지 않는다", async () => {
    const retrieveFile = vi.fn()
      .mockResolvedValueOnce({
        id: "file-active",
        vector_store_id: "vs-policy",
        status: "in_progress",
        last_error: null,
      })
      .mockResolvedValueOnce({
        id: "file-active",
        vector_store_id: "vs-policy",
        status: "completed",
        last_error: null,
      });
    let currentTime = 0;
    const sleep = vi.fn().mockImplementation(async () => {
      currentTime += 10;
    });
    const client = createClient({
      attachFile: vi.fn().mockResolvedValue({
        id: "file-active",
        vector_store_id: "vs-policy",
        status: "in_progress",
        last_error: null,
      }),
      retrieveFile,
    });
    const resource = await preparePolicyVectorStore(client, [policies[0]], {
      pollIntervalMs: 1,
      pollTimeoutMs: 100,
      now: () => currentTime,
      sleep,
    });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(retrieveFile).toHaveBeenNthCalledWith(1, "file-active", {
      vector_store_id: "vs-policy",
    }, {
      maxRetries: 0,
      timeout: 90,
    });
    expect(retrieveFile).toHaveBeenCalledTimes(2);
    expect(resource.ingestionStatus).toBe("completed");
  });

  it("ingestion이 completed가 아니면 실행을 막고 알려진 vector store와 원본 file을 정리한다", async () => {
    const deleteVectorStore = vi.fn().mockResolvedValue({ id: "vs-policy", deleted: true });
    const deleteFile = vi.fn().mockResolvedValue({ id: "file-active", deleted: true });
    const client = createClient({
      attachFile: vi.fn().mockResolvedValue({
        id: "file-active",
        vector_store_id: "vs-policy",
        status: "failed",
        last_error: { code: "invalid_file", message: "invalid JSON" },
      }),
      deleteVectorStore,
      deleteFile,
    });

    let caught: unknown;
    try {
      await preparePolicyVectorStore(client, [policies[0]]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PolicyVectorStorePreparationError);
    expect(caught).toMatchObject({
      vectorStoreId: "vs-policy",
      uploadedFileIds: ["file-active"],
      cleanup: {
        vectorStore: { attempted: true, deleted: true },
        uploadedFiles: [{ id: "file-active", attempted: true, deleted: true }],
      },
    });
    expect(deleteVectorStore).toHaveBeenCalledWith("vs-policy", NO_RETRY_CLEANUP_OPTIONS);
    expect(deleteFile).toHaveBeenCalledWith("file-active", NO_RETRY_CLEANUP_OPTIONS);
  });

  it("file attach가 실패해도 먼저 확보한 원본 file ID와 vector store를 모두 정리한다", async () => {
    const deleteVectorStore = vi.fn().mockResolvedValue({ id: "vs-policy", deleted: true });
    const deleteFile = vi.fn().mockResolvedValue({ id: "file-active", deleted: true });
    const client = createClient({
      attachFile: vi.fn().mockRejectedValue(new Error("attach transport failed")),
      deleteVectorStore,
      deleteFile,
    });

    await expect(preparePolicyVectorStore(client, [policies[0]])).rejects.toMatchObject({
      name: "PolicyVectorStorePreparationError",
      vectorStoreId: "vs-policy",
      uploadedFileIds: ["file-active"],
      cleanup: {
        vectorStore: { attempted: true, deleted: true },
        uploadedFiles: [{ id: "file-active", attempted: true, deleted: true }],
      },
    });
    expect(deleteVectorStore).toHaveBeenCalledWith("vs-policy", NO_RETRY_CLEANUP_OPTIONS);
    expect(deleteFile).toHaveBeenCalledWith("file-active", NO_RETRY_CLEANUP_OPTIONS);
  });

  it("cancelled ingestion은 즉시 실패시키고 bounded poll을 반복하지 않는다", async () => {
    const retrieveFile = vi.fn();
    const deleteVectorStore = vi.fn().mockResolvedValue({ id: "vs-policy", deleted: true });
    const deleteFile = vi.fn().mockResolvedValue({ id: "file-active", deleted: true });
    const client = createClient({
      attachFile: vi.fn().mockResolvedValue({
        id: "file-active",
        vector_store_id: "vs-policy",
        status: "cancelled",
        last_error: null,
      }),
      retrieveFile,
      deleteVectorStore,
      deleteFile,
    });

    await expect(preparePolicyVectorStore(client, [policies[0]])).rejects.toMatchObject({
      name: "PolicyVectorStorePreparationError",
      message: expect.stringContaining("cancelled"),
      cleanup: {
        vectorStore: { attempted: true, deleted: true },
        uploadedFiles: [{ id: "file-active", attempted: true, deleted: true }],
      },
    });
    expect(retrieveFile).not.toHaveBeenCalled();
  });

  it("poll timeout에 도달하면 더 기다리지 않고 확보한 리소스를 정리한다", async () => {
    const retrieveFile = vi.fn();
    let currentTime = 0;
    const sleep = vi.fn().mockImplementation(async (milliseconds: number) => {
      currentTime += milliseconds;
    });
    const deleteVectorStore = vi.fn().mockResolvedValue({ id: "vs-policy", deleted: true });
    const deleteFile = vi.fn().mockResolvedValue({ id: "file-active", deleted: true });
    const client = createClient({
      attachFile: vi.fn().mockResolvedValue({
        id: "file-active",
        vector_store_id: "vs-policy",
        status: "in_progress",
        last_error: null,
      }),
      retrieveFile,
      deleteVectorStore,
      deleteFile,
    });

    await expect(preparePolicyVectorStore(client, [policies[0]], {
      pollIntervalMs: 50,
      pollTimeoutMs: 50,
      now: () => currentTime,
      sleep,
    })).rejects.toMatchObject({
      name: "PolicyVectorStorePreparationError",
      message: expect.stringContaining("50ms"),
      uploadedFileIds: ["file-active"],
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(50);
    expect(retrieveFile).not.toHaveBeenCalled();
    expect(deleteVectorStore).toHaveBeenCalledWith("vs-policy", NO_RETRY_CLEANUP_OPTIONS);
    expect(deleteFile).toHaveBeenCalledWith("file-active", NO_RETRY_CLEANUP_OPTIONS);
  });

  it("두 번째 원본 file 생성이 실패하면 첫 번째 file과 vector store를 정리한다", async () => {
    const createFile = vi.fn()
      .mockResolvedValueOnce({ id: "file-active", purpose: "assistants" })
      .mockRejectedValueOnce(new Error("second upload failed"));
    const deleteVectorStore = vi.fn().mockResolvedValue({ id: "vs-policy", deleted: true });
    const deleteFile = vi.fn().mockResolvedValue({ id: "file-active", deleted: true });
    const client = createClient({ createFile, deleteVectorStore, deleteFile });

    await expect(preparePolicyVectorStore(client, policies)).rejects.toMatchObject({
      name: "PolicyVectorStorePreparationError",
      message: "second upload failed",
      uploadedFileIds: ["file-active"],
      cleanup: {
        vectorStore: { attempted: true, deleted: true },
        uploadedFiles: [{ id: "file-active", attempted: true, deleted: true }],
      },
    });
    expect(deleteFile).toHaveBeenCalledTimes(1);
  });

  it("한쪽 삭제가 실패해도 다른 리소스 삭제를 독립적으로 시도하고 결과를 감사 가능하게 반환한다", async () => {
    const deleteVectorStore = vi.fn().mockRejectedValue(new Error("vector delete failed"));
    const deleteFile = vi.fn()
      .mockRejectedValueOnce(new Error("active file delete failed"))
      .mockResolvedValueOnce({ id: "file-retired", deleted: true });
    const client = createClient({ deleteVectorStore, deleteFile });

    const cleanup = await cleanupPolicyVectorStore(client, {
      vectorStoreId: "vs-policy",
      uploadedFileIds: ["file-active", "file-retired"],
    }, {
      timeoutMs: 10_000,
    });

    expect(deleteVectorStore).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(deleteVectorStore).toHaveBeenCalledWith("vs-policy", NO_RETRY_CLEANUP_OPTIONS);
    expect(deleteFile).toHaveBeenNthCalledWith(1, "file-active", NO_RETRY_CLEANUP_OPTIONS);
    expect(deleteFile).toHaveBeenNthCalledWith(2, "file-retired", NO_RETRY_CLEANUP_OPTIONS);
    expect(cleanup).toEqual({
      vectorStore: {
        id: "vs-policy",
        attempted: true,
        deleted: false,
        error: "vector delete failed",
      },
      uploadedFiles: [
        {
          id: "file-active",
          attempted: true,
          deleted: false,
          error: "active file delete failed",
        },
        {
          id: "file-retired",
          attempted: true,
          deleted: true,
        },
      ],
    });
  });

  it("vector store와 unique file 삭제를 동시에 시작해 cleanup timeout을 항목 수만큼 직렬 누적하지 않는다", async () => {
    const started: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const deleteVectorStore = vi.fn().mockImplementation(async () => {
      started.push("vector:vs-policy");
      await barrier;
      return { id: "vs-policy", deleted: true };
    });
    const deleteFile = vi.fn().mockImplementation(async (fileId: string) => {
      started.push(`file:${fileId}`);
      await barrier;
      return { id: fileId, deleted: true };
    });
    const client = createClient({ deleteVectorStore, deleteFile });

    const cleanupPromise = cleanupPolicyVectorStore(client, {
      vectorStoreId: "vs-policy",
      uploadedFileIds: ["file-active", "file-retired", "file-active"],
    }, { timeoutMs: 4_000 });
    await Promise.resolve();

    expect(started).toEqual([
      "vector:vs-policy",
      "file:file-active",
      "file:file-retired",
    ]);
    expect(deleteVectorStore).toHaveBeenCalledWith("vs-policy", {
      timeout: 4_000,
      maxRetries: 0,
    });
    expect(deleteFile).toHaveBeenNthCalledWith(1, "file-active", {
      timeout: 4_000,
      maxRetries: 0,
    });
    expect(deleteFile).toHaveBeenNthCalledWith(2, "file-retired", {
      timeout: 4_000,
      maxRetries: 0,
    });

    release();
    const cleanup = await cleanupPromise;
    expect(cleanup.uploadedFiles.map((item) => item.id)).toEqual([
      "file-active",
      "file-retired",
    ]);
  });

  it("setup deadline 소진 뒤에도 별도 cleanup timeout으로 알려진 리소스를 정리한다", async () => {
    let currentTime = 0;
    const createVectorStore = vi.fn().mockImplementation(async () => {
      currentTime = 30_000;
      return { id: "vs-policy", status: "completed" };
    });
    const createFile = vi.fn();
    const deleteVectorStore = vi.fn().mockResolvedValue({ id: "vs-policy", deleted: true });
    const deleteFile = vi.fn();
    const client = createClient({
      createVectorStore,
      createFile,
      deleteVectorStore,
      deleteFile,
    });

    await expect(preparePolicyVectorStore(client, [policies[0]], {
      setupTimeoutMs: 30_000,
      cleanupTimeoutMs: 7_000,
      now: () => currentTime,
    })).rejects.toMatchObject({
      name: "PolicyVectorStorePreparationError",
      message: expect.stringContaining("setup deadline"),
      vectorStoreId: "vs-policy",
      uploadedFileIds: [],
    });
    expect(createVectorStore).toHaveBeenCalledWith(expect.any(Object), {
      timeout: 30_000,
      maxRetries: 0,
    });
    expect(createFile).not.toHaveBeenCalled();
    expect(deleteVectorStore).toHaveBeenCalledWith("vs-policy", {
      timeout: 7_000,
      maxRetries: 0,
    });
    expect(deleteFile).not.toHaveBeenCalled();
  });
});

describe("정책 vector store 직접 검색", () => {
  it("실행 취소 신호를 OpenAI vector store 검색 요청에 전달한다", async () => {
    const controller = new AbortController();
    const search = vi.fn().mockResolvedValue({
      object: "list",
      data: [{
        file_id: "file-active",
        filename: manifest[0].filename,
        score: 0.98,
        attributes: {
          source_id: policies[0].source_id,
          section_id: policies[0].section_id,
          fact_id: policies[0].fact_id,
        },
        content: [{ type: "text", text: JSON.stringify(policies[0]) }],
      }],
    });
    const client = createClient({ search });

    await searchPolicyVectorStore(client, {
      vectorStoreId: "vs-policy",
      query: "active cancellation policy",
      maxNumResults: 2,
      manifest,
      timeoutMs: 30_000,
      signal: controller.signal,
    });

    expect(search).toHaveBeenCalledWith("vs-policy", expect.any(Object), {
      timeout: 30_000,
      maxRetries: 0,
      signal: controller.signal,
    });
  });

  it("timeoutMs 생략을 타입과 런타임에서 모두 거부해 SDK 기본 retry 경로를 열지 않는다", async () => {
    const search = vi.fn();
    const client = createClient({ search });
    const optionsWithoutTimeout = {
      vectorStoreId: "vs-policy",
      query: "shipped order cancellation policy",
      maxNumResults: 2,
      manifest,
    };

    if (false) {
      // @ts-expect-error timeoutMs는 직접 검색의 필수 실행 경계입니다.
      void searchPolicyVectorStore(client, optionsWithoutTimeout);
    }
    const unsafeSearch = searchPolicyVectorStore as unknown as (
      unsafeClient: PolicyVectorStoreClientLike,
      unsafeOptions: typeof optionsWithoutTimeout,
    ) => Promise<unknown>;
    await expect(unsafeSearch(client, optionsWithoutTimeout))
      .rejects.toThrow("timeoutMs");
    expect(search).not.toHaveBeenCalled();
  });

  it("실제 OpenAI SDK 연결 timeout을 FAILED가 아닌 TIMEOUT evidence로 분류한다", async () => {
    const search = vi.fn().mockRejectedValue(new APIConnectionTimeoutError({
      message: "SDK retrieval timeout",
    }));
    const client = createClient({ search });

    await expect(searchPolicyVectorStore(client, {
      vectorStoreId: "vs-policy",
      query: "shipped order cancellation policy",
      maxNumResults: 2,
      manifest,
      timeoutMs: 30_000,
    })).rejects.toMatchObject({
      name: "PolicyRetrievalError",
      retryable: true,
      evidence: {
        status: "TIMEOUT",
        error: "SDK retrieval timeout",
        results: [],
      },
    });
  });

  it("잠긴 query와 top-k로 직접 검색하고 query·score·file·정책 식별자를 보존한다", async () => {
    const policyLine = JSON.stringify(policies[0]);
    const splitAt = policyLine.indexOf('"title"');
    const combinedContent = `${policyLine.slice(0, splitAt)}\n${policyLine.slice(splitAt)}`;
    const rawSearchResponse = {
      object: "list",
      search_query: "active shipped order cancellation policy",
      data: [{
        file_id: "file-active",
        filename: manifest[0].filename,
        score: 0.982,
        attributes: {
          source_id: "CANCEL-2026",
          section_id: "2.2",
          fact_id: "CANCEL-AFTER-SHIPMENT-2026",
        },
        content: [
          { type: "text", text: policyLine.slice(0, splitAt) },
          { type: "text", text: policyLine.slice(splitAt) },
        ],
      }],
    };
    const asResponse = vi.fn().mockResolvedValue(new Response(JSON.stringify(rawSearchResponse), {
      headers: { "content-type": "application/json" },
    }));
    const search = vi.fn().mockReturnValue({ asResponse });
    const client = createClient({ search });
    const times = [100, 112];

    const evidence = await searchPolicyVectorStore(client, {
      vectorStoreId: "vs-policy",
      query: "shipped order cancellation policy",
      maxNumResults: 2,
      manifest,
      timeoutMs: 30_000,
      now: () => times.shift()!,
    });

    expect(search).toHaveBeenCalledWith("vs-policy", {
      query: "shipped order cancellation policy",
      max_num_results: 2,
      rewrite_query: false,
    }, {
      timeout: 30_000,
      maxRetries: 0,
    });
    expect(evidence).toEqual({
      callNumber: 1,
      operation: "VECTOR_STORE_SEARCH",
      status: "COMPLETE",
      requestedQuery: "shipped order cancellation policy",
      reportedQuery: "active shipped order cancellation policy",
      vectorStoreId: "vs-policy",
      maxNumResults: 2,
      rewriteQuery: false,
      latencyMs: 12,
      results: [{
        rank: 1,
        fileId: "file-active",
        filename: manifest[0].filename,
        score: 0.982,
        sourceId: "CANCEL-2026",
        sectionId: "2.2",
        factId: "CANCEL-AFTER-SHIPMENT-2026",
        text: combinedContent,
        contentChunks: [
          policyLine.slice(0, splitAt),
          policyLine.slice(splitAt),
        ],
      }],
    });
  });

  it("최상위 정책 식별자가 맞으면 중첩 참조의 다른 source·section을 현재 파일 identity로 오인하지 않는다", async () => {
    const policyWithNestedReference = {
      ...policies[0],
      scope: {
        related_policy: {
          source_id: "RELATED-SOURCE",
          section_id: "RELATED-SECTION",
        },
      },
    };
    const client = createClient({
      search: vi.fn().mockResolvedValue({
        object: "list",
        data: [{
          file_id: "file-active",
          filename: manifest[0].filename,
          score: 0.94,
          attributes: {
            source_id: policies[0].source_id,
            section_id: policies[0].section_id,
            fact_id: policies[0].fact_id,
          },
          content: [{
            type: "text",
            text: JSON.stringify(policyWithNestedReference),
          }],
        }],
      }),
    });

    const evidence = await searchPolicyVectorStore(client, {
      vectorStoreId: "vs-policy",
      query: "active policy with a related reference",
      maxNumResults: 2,
      manifest,
      timeoutMs: 30_000,
    });

    expect(evidence.results[0]).toMatchObject({
      sourceId: policies[0].source_id,
      sectionId: policies[0].section_id,
      factId: policies[0].fact_id,
    });
  });

  it("검색 오류를 retryable 분류와 실패 evidence에 함께 보존한다", async () => {
    const search = vi.fn().mockRejectedValue(Object.assign(new Error("retrieval unavailable"), {
      status: 503,
    }));
    const client = createClient({ search });
    const times = [200, 227];

    let caught: unknown;
    try {
      await searchPolicyVectorStore(client, {
        vectorStoreId: "vs-policy",
        query: "shipped order cancellation policy",
        maxNumResults: 2,
        manifest,
        timeoutMs: 30_000,
        now: () => times.shift()!,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PolicyRetrievalError);
    expect(caught).toMatchObject({
      retryable: true,
      evidence: {
        status: "FAILED",
        requestedQuery: "shipped order cancellation policy",
        reportedQuery: null,
        vectorStoreId: "vs-policy",
        maxNumResults: 2,
        rewriteQuery: false,
        latencyMs: 27,
        results: [],
        error: "retrieval unavailable",
      },
    });
  });

  it("검색 청크에서 안정적 정책 식별자를 해석할 수 없으면 조용히 꾸미지 않는다", async () => {
    const client = createClient({
      search: vi.fn().mockResolvedValue({
        object: "list",
        data: [{
          file_id: "file-active",
          filename: manifest[0].filename,
          score: 0.91,
          attributes: {
            source_id: "CANCEL-2026",
            section_id: "2.2",
            fact_id: "CANCEL-AFTER-SHIPMENT-2026",
          },
          content: [{ type: "text", text: "Orders in SHIPPED status cannot be cancelled." }],
        }],
      }),
    });

    await expect(searchPolicyVectorStore(client, {
      vectorStoreId: "vs-policy",
      query: "shipped order cancellation policy",
      maxNumResults: 2,
      manifest,
      timeoutMs: 30_000,
    })).rejects.toMatchObject({
      name: "PolicyRetrievalError",
      retryable: false,
      evidence: {
        status: "FAILED",
        results: [],
      },
    });
  });

  it("검색 0건은 근거 없는 생성을 허용하지 않고 비재시도 계약 오류로 남긴다", async () => {
    const client = createClient({
      search: vi.fn().mockResolvedValue({ object: "list", data: [] }),
    });

    await expect(searchPolicyVectorStore(client, {
      vectorStoreId: "vs-policy",
      query: "shipped order cancellation policy",
      maxNumResults: 2,
      manifest,
      timeoutMs: 30_000,
    })).rejects.toMatchObject({
      name: "PolicyRetrievalError",
      retryable: false,
      evidence: { status: "FAILED", results: [] },
    });
  });

  it("unknown file ID나 attributes·본문·manifest 불일치를 조용히 승인하지 않는다", async () => {
    const client = createClient({
      search: vi.fn().mockResolvedValue({
        object: "list",
        data: [{
          file_id: "file-unknown",
          filename: "unknown.json",
          score: 0.8,
          attributes: {
            source_id: "CANCEL-2026",
            section_id: "2.2",
            fact_id: "CANCEL-AFTER-SHIPMENT-2026",
          },
          content: [{ type: "text", text: JSON.stringify(policies[0]) }],
        }],
      }),
    });

    await expect(searchPolicyVectorStore(client, {
      vectorStoreId: "vs-policy",
      query: "shipped order cancellation policy",
      maxNumResults: 2,
      manifest,
      timeoutMs: 30_000,
    })).rejects.toMatchObject({
      name: "PolicyRetrievalError",
      retryable: false,
      evidence: { status: "FAILED", results: [] },
    });
  });
});

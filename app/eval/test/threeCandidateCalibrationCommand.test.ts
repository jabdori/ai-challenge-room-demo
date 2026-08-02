// @vitest-environment node

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PolicyVectorStorePreparationError } from "../retrieval/policyVectorStore";
import type { CandidateAdapter } from "../runner/types";
import {
  CalibrationInterruptionError,
  executeThreeCandidateCalibrationCommand,
  type ThreeCandidateCalibrationCommandDependencies,
} from "../cli/threeCandidateCalibrationCommand";
import {
  createProductionThreeCandidateCalibrationDependencies,
} from "../cli/productionThreeCandidateCalibration";
import {
  TEST_RESOURCE_IDS,
  buildSummaryPack,
  completeCleanup,
} from "./helpers/calibrationCommandFixtures";

const apiKey = "test-key-only";
const outputDirectory = "/private/runtime/evaluation-packs";
const dummyAdapter: CandidateAdapter = {
  invoke: async () => { throw new Error("mock execute가 adapter를 직접 호출하면 안 됩니다."); },
};

async function secureTempRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await chmod(root, 0o700);
  return root;
}

const productionPrepareOutputDirectory =
  createProductionThreeCandidateCalibrationDependencies()
    .prepareOutputDirectory;

function preparedStore() {
  return {
    vectorStoreId: TEST_RESOURCE_IDS.vectorStoreId,
    uploadedFileIds: [...TEST_RESOURCE_IDS.uploadedFileIds],
    files: TEST_RESOURCE_IDS.uploadedFileIds.map((uploadedFileId, index) => ({
      uploadedFileId,
      filename: `policy-${index}.json`,
      sourceId: index === 0 ? "CANCEL-2026" : "CANCEL-2025",
      sectionId: "2.2",
      factId: index === 0
        ? "CANCEL-AFTER-SHIPMENT-2026"
        : "CANCEL-AFTER-SHIPMENT-2025",
    })),
    ingestionStatus: "completed" as const,
    manifestSha256: "a".repeat(64),
    vectorStoreExpiresAfter: { anchor: "last_active_at" as const, days: 1 as const },
    fileExpiresAfter: { anchor: "created_at" as const, seconds: 86_400 as const },
    uploadMethod: "FILES_CREATE_AND_BOUNDED_VECTOR_STORE_POLL" as const,
  };
}

function createDependencies(overrides: Partial<ThreeCandidateCalibrationCommandDependencies> = {}) {
  const client = { kind: "mock-client" };
  const dependencies: ThreeCandidateCalibrationCommandDependencies = {
    assertSyntheticData: vi.fn(),
    prepareOutputDirectory: vi.fn(),
    createClient: vi.fn(() => client),
    preparePolicyStore: vi.fn().mockResolvedValue(preparedStore()),
    createCandidateA: vi.fn(() => dummyAdapter),
    createCandidateB: vi.fn(() => dummyAdapter),
    createCandidateC: vi.fn(() => dummyAdapter),
    executeCalibration: vi.fn().mockResolvedValue({
      pack: buildSummaryPack(),
      filePath: `${outputDirectory}/top-pack.json`,
    }),
    cleanupPolicyStore: vi.fn().mockResolvedValue(completeCleanup()),
    persistCleanupReceipt: vi.fn().mockResolvedValue(`${outputDirectory}/cleanup-receipt.json`),
    ...overrides,
  };
  return { dependencies, client };
}

describe("DI 가능한 A/B/C calibration command", () => {
  it("API key가 없으면 guard·client·prepare·execute를 호출하지 않고 exit 1이다", async () => {
    const { dependencies } = createDependencies();
    const result = await executeThreeCandidateCalibrationCommand({
      environment: {},
      outputDirectory,
      dependencies,
    });

    expect(result.exitCode).toBe(1);
    expect(result.summary.command_status).toBe("CALIBRATION_FAILED");
    expect(dependencies.assertSyntheticData).not.toHaveBeenCalled();
    expect(dependencies.prepareOutputDirectory).not.toHaveBeenCalled();
    expect(dependencies.createClient).not.toHaveBeenCalled();
    expect(dependencies.preparePolicyStore).not.toHaveBeenCalled();
    expect(dependencies.executeCalibration).not.toHaveBeenCalled();
    expect(dependencies.persistCleanupReceipt).not.toHaveBeenCalled();
  });

  it("synthetic guard 실패는 client 생성과 모든 network·output 실행 전에 중단한다", async () => {
    const guardError = new Error("synthetic fixture mismatch");
    const { dependencies } = createDependencies({
      assertSyntheticData: vi.fn(() => { throw guardError; }),
    });
    const result = await executeThreeCandidateCalibrationCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });

    expect(result.exitCode).toBe(1);
    expect(result.summary.error).toBe(guardError.message);
    expect(dependencies.prepareOutputDirectory).not.toHaveBeenCalled();
    expect(dependencies.createClient).not.toHaveBeenCalled();
    expect(dependencies.preparePolicyStore).not.toHaveBeenCalled();
    expect(dependencies.executeCalibration).not.toHaveBeenCalled();
    expect(dependencies.persistCleanupReceipt).not.toHaveBeenCalled();
  });

  it("missing direct-child output을 provider보다 먼저 준비하고 기존 실행·cleanup 계약을 유지한다", async () => {
    const root = await secureTempRoot("calibration-preflight-valid-");
    const missingOutputDirectory = join(root, "evaluation-packs");
    const events: string[] = [];
    const { dependencies } = createDependencies({
      assertSyntheticData: vi.fn(() => events.push("synthetic")),
      prepareOutputDirectory: vi.fn(async (directory: string) => {
        events.push("output-preflight");
        await productionPrepareOutputDirectory(directory);
      }),
      createClient: vi.fn(() => {
        events.push("client");
        return { kind: "mock-client" };
      }),
      preparePolicyStore: vi.fn(async () => {
        events.push("resource");
        return preparedStore();
      }),
      executeCalibration: vi.fn(async () => {
        events.push("execute");
        return {
          pack: buildSummaryPack(),
          filePath: join(missingOutputDirectory, "top-pack.json"),
        };
      }),
      cleanupPolicyStore: vi.fn(async () => {
        events.push("cleanup");
        return completeCleanup();
      }),
      persistCleanupReceipt: vi.fn(async () => {
        events.push("receipt");
        return join(missingOutputDirectory, "cleanup-receipt.json");
      }),
    } as Partial<ThreeCandidateCalibrationCommandDependencies>);

    const result = await executeThreeCandidateCalibrationCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory: missingOutputDirectory,
      dependencies,
    });

    expect(events).toEqual([
      "synthetic",
      "output-preflight",
      "client",
      "resource",
      "execute",
      "cleanup",
      "receipt",
    ]);
    expect(result.exitCode).toBe(0);
    expect((await lstat(missingOutputDirectory)).mode & 0o777).toBe(0o700);
  });

  it.each([
    {
      label: "0755 parent",
      setup: async () => {
        const root = await secureTempRoot("calibration-preflight-parent-mode-");
        await chmod(root, 0o755);
        return { root, outputDirectory: join(root, "evaluation-packs") };
      },
    },
    {
      label: "0755 existing output",
      setup: async () => {
        const root = await secureTempRoot("calibration-preflight-output-mode-");
        const outputDirectory = join(root, "evaluation-packs");
        await mkdir(outputDirectory, { mode: 0o700 });
        await chmod(outputDirectory, 0o755);
        return { root, outputDirectory };
      },
    },
    {
      label: "symlink output",
      setup: async () => {
        const root = await secureTempRoot("calibration-preflight-symlink-");
        const target = await secureTempRoot("calibration-preflight-target-");
        const outputDirectory = join(root, "evaluation-packs");
        await symlink(target, outputDirectory, "dir");
        return { root, outputDirectory };
      },
    },
    {
      label: "missing nested parent",
      setup: async () => {
        const root = await secureTempRoot("calibration-preflight-nested-");
        return {
          root,
          outputDirectory: join(root, "missing-parent", "evaluation-packs"),
        };
      },
    },
  ])("$label은 provider·artifact·cleanup 전에 fail-closed한다", async ({
    setup,
  }) => {
    const { root, outputDirectory: unsafeOutputDirectory } = await setup();
    const events: string[] = [];
    const { dependencies } = createDependencies({
      assertSyntheticData: vi.fn(() => events.push("synthetic")),
      prepareOutputDirectory: vi.fn(async (directory: string) => {
        events.push("output-preflight");
        await productionPrepareOutputDirectory(directory);
      }),
      createClient: vi.fn(() => {
        events.push("client");
        return { kind: "mock-client" };
      }),
      preparePolicyStore: vi.fn(async () => {
        events.push("resource");
        return preparedStore();
      }),
      executeCalibration: vi.fn(async () => {
        events.push("execute");
        return {
          pack: buildSummaryPack(),
          filePath: join(unsafeOutputDirectory, "top-pack.json"),
        };
      }),
      cleanupPolicyStore: vi.fn(async () => {
        events.push("cleanup");
        return completeCleanup();
      }),
      persistCleanupReceipt: vi.fn(async () => {
        events.push("receipt");
        return join(unsafeOutputDirectory, "cleanup-receipt.json");
      }),
    } as Partial<ThreeCandidateCalibrationCommandDependencies>);

    const beforeEntries = await readdir(root);
    const result = await executeThreeCandidateCalibrationCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory: unsafeOutputDirectory,
      dependencies,
    });

    expect(events).toEqual(["synthetic", "output-preflight"]);
    expect(result).toMatchObject({
      exitCode: 1,
      summary: {
        command_status: "CALIBRATION_FAILED",
        evaluation_status: "EVALUATION_INCOMPLETE",
        top_pack_path: null,
        cleanup: {
          required: 0,
          acknowledged: 0,
          incomplete: 0,
        },
        candidates: {
          A: { runs: 0 },
          B: { runs: 0 },
          C: { runs: 0 },
        },
      },
    });
    expect(result.summary.cleanup).not.toHaveProperty("receipt_path");
    expect(dependencies.createClient).not.toHaveBeenCalled();
    expect(dependencies.preparePolicyStore).not.toHaveBeenCalled();
    expect(dependencies.executeCalibration).not.toHaveBeenCalled();
    expect(dependencies.cleanupPolicyStore).not.toHaveBeenCalled();
    expect(dependencies.persistCleanupReceipt).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(beforeEntries);
  });

  it("정상 경로는 sanitized 정책으로 store 1개를 준비해 B/C에 공유하고 top-only 6회 pack 뒤 cleanup 1회로 exit 0이다", async () => {
    const events: string[] = [];
    const prepared = preparedStore();
    const { dependencies, client } = createDependencies({
      assertSyntheticData: vi.fn(() => events.push("guard")),
      createClient: vi.fn(() => { events.push("client"); return { kind: "mock-client" }; }),
      preparePolicyStore: vi.fn(async () => { events.push("prepare"); return prepared; }),
      createCandidateA: vi.fn(() => { events.push("adapter-A"); return dummyAdapter; }),
      createCandidateB: vi.fn(() => { events.push("adapter-B"); return dummyAdapter; }),
      createCandidateC: vi.fn(() => { events.push("adapter-C"); return dummyAdapter; }),
      executeCalibration: vi.fn(async () => {
        events.push("execute");
        return { pack: buildSummaryPack(), filePath: `${outputDirectory}/top-pack.json` };
      }),
      cleanupPolicyStore: vi.fn(async () => { events.push("cleanup"); return completeCleanup(); }),
    });

    const result = await executeThreeCandidateCalibrationCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });

    expect(result.exitCode).toBe(0);
    expect(events).toEqual([
      "guard", "client", "prepare", "adapter-A", "adapter-B", "adapter-C", "execute", "cleanup",
    ]);
    expect(dependencies.createClient).toHaveBeenCalledWith(apiKey);
    expect(dependencies.preparePolicyStore).toHaveBeenCalledTimes(1);
    const preparedPolicies = vi.mocked(dependencies.preparePolicyStore).mock.calls[0][1];
    expect(JSON.stringify(preparedPolicies)).not.toContain('"synthetic"');
    expect(dependencies.createCandidateB).toHaveBeenCalledWith(expect.anything(), {
      vectorStoreId: prepared.vectorStoreId,
      manifest: prepared.files,
      query: "active shipped-order cancellation policy as of 2026-07-17",
      maxNumResults: 2,
    });
    expect(dependencies.createCandidateC).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      vectorStoreId: prepared.vectorStoreId,
      manifest: prepared.files,
      lockedAsOf: "2026-07-17T00:00:00Z",
      maxNumResults: 2,
    }));
    const cOptions = vi.mocked(dependencies.createCandidateC).mock.calls[0][1];
    expect(JSON.stringify(cOptions.orders)).not.toContain('"synthetic"');
    expect(dependencies.executeCalibration).toHaveBeenCalledWith({
      adapters: { A: dummyAdapter, B: dummyAdapter, C: dummyAdapter },
      outputDirectory,
      persistChildren: false,
    });
    expect(dependencies.cleanupPolicyStore).toHaveBeenCalledOnce();
    expect(dependencies.cleanupPolicyStore).toHaveBeenCalledWith(expect.anything(), {
      vectorStoreId: prepared.vectorStoreId,
      uploadedFileIds: prepared.uploadedFileIds,
    });
    expect(client).toEqual({ kind: "mock-client" });
    expect(dependencies.persistCleanupReceipt).toHaveBeenCalledOnce();
    expect(result.summary.cleanup.receipt_path).toBe(
      `${outputDirectory}/cleanup-receipt.json`,
    );
  });

  it.each([
    ["invalid run", buildSummaryPack({ invalidCandidate: "A" })],
    ["gate fail", buildSummaryPack({ failedGateCandidate: "B" })],
  ])("%s pack은 저장 경로와 cleanup을 보존하면서 exit 1이다", async (_label, pack) => {
    const { dependencies } = createDependencies({
      executeCalibration: vi.fn().mockResolvedValue({
        pack,
        filePath: `${outputDirectory}/top-pack.json`,
      }),
    });
    const result = await executeThreeCandidateCalibrationCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });
    expect(result.exitCode).toBe(1);
    expect(result.summary.command_status).toBe("CALIBRATION_INCOMPLETE");
    expect(result.summary.top_pack_path).toBe(`${outputDirectory}/top-pack.json`);
    expect(dependencies.cleanupPolicyStore).toHaveBeenCalledOnce();
  });

  it("execute가 throw해도 prepared store cleanup을 finally에서 정확히 한 번 수행한다", async () => {
    const executeError = new Error("pack persistence failed");
    const { dependencies } = createDependencies({
      executeCalibration: vi.fn().mockRejectedValue(executeError),
    });
    const result = await executeThreeCandidateCalibrationCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });
    expect(result.exitCode).toBe(1);
    expect(result.summary.error).toBe(executeError.message);
    expect(dependencies.cleanupPolicyStore).toHaveBeenCalledOnce();
  });

  it("후보 adapter factory가 throw해도 prepared store cleanup을 정확히 한 번 수행한다", async () => {
    const adapterError = new Error("candidate B adapter construction failed");
    const { dependencies } = createDependencies({
      createCandidateB: vi.fn(() => { throw adapterError; }),
    });
    const result = await executeThreeCandidateCalibrationCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });

    expect(result.exitCode).toBe(1);
    expect(result.summary.errors).toEqual([adapterError.message]);
    expect(dependencies.executeCalibration).not.toHaveBeenCalled();
    expect(dependencies.cleanupPolicyStore).toHaveBeenCalledOnce();
    expect(dependencies.persistCleanupReceipt).toHaveBeenCalledOnce();
  });

  it("preparation error의 내장 cleanup을 사용하고 외부 cleanup을 중복 호출하지 않는다", async () => {
    const preparationError = new PolicyVectorStorePreparationError(
      "ingestion failed",
      {
        vectorStoreId: TEST_RESOURCE_IDS.vectorStoreId,
        uploadedFileIds: TEST_RESOURCE_IDS.uploadedFileIds,
      },
      completeCleanup(),
    );
    const { dependencies } = createDependencies({
      preparePolicyStore: vi.fn().mockRejectedValue(preparationError),
    });
    const result = await executeThreeCandidateCalibrationCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });
    expect(result.exitCode).toBe(1);
    expect(result.summary.cleanup).toMatchObject({ required: 3, acknowledged: 3, incomplete: 0 });
    expect(dependencies.cleanupPolicyStore).not.toHaveBeenCalled();
    expect(dependencies.executeCalibration).not.toHaveBeenCalled();
    expect(dependencies.persistCleanupReceipt).toHaveBeenCalledOnce();
  });

  it("runtime 성공이어도 API delete acknowledgement가 하나 부족하면 exit 2이다", async () => {
    const partialCleanup = completeCleanup();
    partialCleanup.uploadedFiles[1].deleted = false;
    const { dependencies } = createDependencies({
      cleanupPolicyStore: vi.fn().mockResolvedValue(partialCleanup),
    });
    const result = await executeThreeCandidateCalibrationCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });
    expect(result.exitCode).toBe(2);
    expect(result.summary.cleanup).toMatchObject({
      required: 3,
      acknowledged: 2,
      incomplete: 1,
      receipt_path: `${outputDirectory}/cleanup-receipt.json`,
    });
    expect(dependencies.persistCleanupReceipt).toHaveBeenCalledOnce();
  });

  it("cleanup complete여도 감사 receipt 저장이 실패하면 exit 1이며 오류를 보존한다", async () => {
    const receiptError = new Error("receipt persistence failed");
    const { dependencies } = createDependencies({
      persistCleanupReceipt: vi.fn().mockRejectedValue(receiptError),
    });
    const result = await executeThreeCandidateCalibrationCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });
    expect(result.exitCode).toBe(1);
    expect(result.summary.command_status).toBe("CALIBRATION_FAILED");
    expect(result.summary.errors).toEqual([receiptError.message]);
  });

  it("execute 오류 뒤 cleanup도 throw하면 두 오류를 보존하고 receipt를 남겨 exit 2다", async () => {
    const runtimeError = new Error("execute failed first");
    const cleanupError = new Error("cleanup failed second");
    const { dependencies } = createDependencies({
      executeCalibration: vi.fn().mockRejectedValue(runtimeError),
      cleanupPolicyStore: vi.fn().mockRejectedValue(cleanupError),
    });
    const result = await executeThreeCandidateCalibrationCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });
    expect(result.exitCode).toBe(2);
    expect(result.summary.errors).toEqual([runtimeError.message, cleanupError.message]);
    expect(dependencies.cleanupPolicyStore).toHaveBeenCalledOnce();
    expect(dependencies.persistCleanupReceipt).toHaveBeenCalledOnce();
  });

  it("execute·cleanup·receipt가 모두 실패하면 세 오류를 순서대로 보존하고 exit 2다", async () => {
    const runtimeError = new Error("execute failed first");
    const cleanupError = new Error("cleanup failed second");
    const receiptError = new Error("receipt failed third");
    const { dependencies } = createDependencies({
      executeCalibration: vi.fn().mockRejectedValue(runtimeError),
      cleanupPolicyStore: vi.fn().mockRejectedValue(cleanupError),
      persistCleanupReceipt: vi.fn().mockRejectedValue(receiptError),
    });
    const result = await executeThreeCandidateCalibrationCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
    });

    expect(result.exitCode).toBe(2);
    expect(result.summary.errors).toEqual([
      runtimeError.message,
      cleanupError.message,
      receiptError.message,
    ]);
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("%s는 signal을 prepare·execute에 전달하고 cleanup 1회 뒤 exit %i다", async (name, exitCode) => {
    const controller = new AbortController();
    let executeStarted!: () => void;
    const started = new Promise<void>((resolve) => { executeStarted = resolve; });
    const { dependencies } = createDependencies({
      executeCalibration: vi.fn().mockImplementation(async (input) => {
        expect(input.signal).toBe(controller.signal);
        executeStarted();
        return await new Promise((_, reject) => {
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
        });
      }),
    });
    const running = executeThreeCandidateCalibrationCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
      signal: controller.signal,
    });
    await started;
    controller.abort(new CalibrationInterruptionError(name));
    const result = await running;

    expect(result.exitCode).toBe(exitCode);
    expect(result.summary.command_status).toBe("CALIBRATION_INTERRUPTED");
    expect(vi.mocked(dependencies.preparePolicyStore).mock.calls[0][2]).toEqual({
      signal: controller.signal,
    });
    expect(dependencies.cleanupPolicyStore).toHaveBeenCalledOnce();
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("cleanup receipt 저장 중 %s가 오면 저장 완료 뒤 exit %i가 우선한다", async (
    name,
    exitCode,
  ) => {
    const controller = new AbortController();
    let receiptStarted!: () => void;
    const started = new Promise<void>((resolve) => { receiptStarted = resolve; });
    let releaseReceipt!: () => void;
    const released = new Promise<void>((resolve) => { releaseReceipt = resolve; });
    const { dependencies } = createDependencies({
      persistCleanupReceipt: vi.fn(async () => {
        receiptStarted();
        await released;
        return `${outputDirectory}/cleanup-receipt.json`;
      }),
    });

    const running = executeThreeCandidateCalibrationCommand({
      environment: { OPENAI_API_KEY: apiKey },
      outputDirectory,
      dependencies,
      signal: controller.signal,
    });
    await started;
    controller.abort(new CalibrationInterruptionError(name));
    releaseReceipt();
    const result = await running;

    expect(result.exitCode).toBe(exitCode);
    expect(result.summary.command_status).toBe("CALIBRATION_INTERRUPTED");
    expect(dependencies.cleanupPolicyStore).toHaveBeenCalledOnce();
    expect(dependencies.persistCleanupReceipt).toHaveBeenCalledOnce();
  });
});

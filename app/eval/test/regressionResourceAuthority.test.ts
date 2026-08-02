// @vitest-environment node

import { chmod, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildScopedPolicyResourceLeaseContract,
  createBenchmarkResourceLeaseController,
  type BenchmarkResourceLeaseContract,
  type BenchmarkResourceLeaseRemoteClient,
} from "../benchmark/resourceLease";
import {
  BENCHMARK_POLICY_CHUNKING_CONFIG,
  type PreparedBenchmarkPolicyVectorStore,
} from "../benchmark/policyVectorStore";
import type { PolicySection } from "../contracts/evaluationCase";
import { BENCHMARK_POLICIES } from "../data/benchmark";
import {
  buildRegressionSchedule,
  buildValidatedRegressionResourceCleanupEvidence,
} from "../regression/runRegression";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

function preparedStore(
  contract: BenchmarkResourceLeaseContract,
  policies: readonly PolicySection[],
  suffix: string,
): PreparedBenchmarkPolicyVectorStore {
  const files = policies.map((policy, index) => ({
    uploadedFileId: `file-${suffix}-${index + 1}`,
    filename: `${contract.filename_prefix}-${index + 1}.json`,
    sourceId: policy.source_id,
    sectionId: policy.section_id,
    factId: policy.fact_ids[0],
    payloadSha256: sha256CanonicalJson({ suffix, index }),
  }));
  const manifestSha256 = sha256CanonicalJson(files);
  const resourceIdentity = {
    schema_version: "benchmark-policy-resource-v1" as const,
    policy_corpus_sha256: contract.policy_corpus_sha256,
    chunking_config: structuredClone(BENCHMARK_POLICY_CHUNKING_CONFIG),
    chunking_config_sha256: contract.chunking_config_sha256,
    resource_contract_sha256: contract.resource_contract_sha256,
    manifest_sha256: manifestSha256,
  };
  return {
    vectorStoreId: `vs-${suffix}`,
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

function clientFor(
  contract: BenchmarkResourceLeaseContract,
  prepared: PreparedBenchmarkPolicyVectorStore,
): BenchmarkResourceLeaseRemoteClient {
  const files = new Map(
    prepared.files.map((file) => [file.uploadedFileId, file]),
  );
  return {
    vectorStores: {
      create: vi.fn(),
      retrieve: vi.fn(async () => ({
        id: prepared.vectorStoreId,
        name: contract.vector_store_name,
        status: "completed",
        file_counts: {
          in_progress: 0,
          completed: contract.expected_file_count,
          failed: 0,
          cancelled: 0,
          total: contract.expected_file_count,
        },
      })),
      files: {
        create: vi.fn(),
        retrieve: vi.fn(async (fileId: string) => {
          const file = files.get(fileId)!;
          return {
            id: fileId,
            vector_store_id: prepared.vectorStoreId,
            status: "completed",
            attributes: {
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
      delete: vi.fn(async (id: string) => ({ id, deleted: true })),
    },
    files: {
      create: vi.fn(),
      retrieve: vi.fn(async (fileId: string) => {
        const file = files.get(fileId)!;
        return {
          id: fileId,
          filename: file.filename,
          purpose: "assistants",
          status: "processed",
        };
      }),
      delete: vi.fn(async (id: string) => ({ id, deleted: true })),
    },
  } as unknown as BenchmarkResourceLeaseRemoteClient;
}

async function terminalAuthority(
  policies: readonly PolicySection[],
  version: "baseline" | "proposed",
) {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), `regression-${version}-lease-`),
  );
  await chmod(temporaryRoot, 0o700);
  const root = await realpath(temporaryRoot);
  const scheduleId = buildRegressionSchedule("B").schedule_id;
  const contract = buildScopedPolicyResourceLeaseContract({
    authorityPackSha256: sha256CanonicalJson({ source: "decision" }),
    authorityContractSha256: sha256CanonicalJson({ source: "benchmark" }),
    scheduleId,
    policies,
    outputDirectory: root,
    vectorStoreName: `ai-challenge-regression-${version}`,
    filenamePrefix: `regression-${version}-policy`,
  });
  const prepared = preparedStore(contract, policies, version);
  const cleanup = {
    vectorStore: {
      id: prepared.vectorStoreId,
      attempted: true,
      deleted: true,
    },
    uploadedFiles: prepared.uploadedFileIds.map((id) => ({
      id,
      attempted: true,
      deleted: true,
    })),
  };
  const controller = createBenchmarkResourceLeaseController({
    rootDirectory: root,
    contract,
    policies,
    owner: {
      hostname: "regression-test",
      pid: version === "baseline" ? 1001 : 1002,
      token: `${version}-owner`,
    },
    prepareResource: vi.fn(async (_client, _policies, options) => {
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
    }),
    cleanupResource: vi.fn(async () => cleanup),
  });
  const client = clientFor(contract, prepared);
  await controller.acquire({ client });
  const actualCleanup = await controller.cleanup({ client });
  await controller.finalizeCleanup(actualCleanup);
  return controller.terminalAuthority();
}

describe("회귀 v1/v2 durable resource authority", () => {
  it("서로 다른 32/31 corpus의 prepared identity와 terminal 삭제 chain을 결합한다", async () => {
    const proposedPolicies = BENCHMARK_POLICIES.filter((policy) => !(
      policy.source_id === "RET" && policy.section_id === "3.1"
    ));
    const [baseline, proposed] = await Promise.all([
      terminalAuthority(BENCHMARK_POLICIES, "baseline"),
      terminalAuthority(proposedPolicies, "proposed"),
    ]);
    const evidence = buildValidatedRegressionResourceCleanupEvidence({
      selectedCandidateId: "B",
      baseline,
      proposed,
      authorityBinding: {
        decision_baseline_record_hash:
          baseline.contract.locked_challenge_pack_sha256,
        resource_authority_contract_hash:
          baseline.contract.locked_challenge_contract_sha256,
      },
    });

    expect(evidence.evidence.baseline).toMatchObject({
      status: "CLEANED",
      policy_resource_identity_hash:
        baseline.prepared_store.resourceIdentitySha256,
      manifest_hash: baseline.prepared_store.manifestSha256,
      cleanup_receipt_hash: baseline.terminal_record_sha256,
    });
    expect(evidence.evidence.proposed).toMatchObject({
      status: "CLEANED",
      policy_resource_identity_hash:
        proposed.prepared_store.resourceIdentitySha256,
      manifest_hash: proposed.prepared_store.manifestSha256,
      cleanup_receipt_hash: proposed.terminal_record_sha256,
    });
  }, 15_000);

  it("다른 결정 권위에서 생성된 genuine terminal lease를 현재 회귀 자원 증거로 재사용하지 않는다", async () => {
    const proposedPolicies = BENCHMARK_POLICIES.filter((policy) => !(
      policy.source_id === "RET" && policy.section_id === "3.1"
    ));
    const [baseline, proposed] = await Promise.all([
      terminalAuthority(BENCHMARK_POLICIES, "baseline"),
      terminalAuthority(proposedPolicies, "proposed"),
    ]);

    expect(() => buildValidatedRegressionResourceCleanupEvidence({
      selectedCandidateId: "B",
      baseline,
      proposed,
      authorityBinding: {
        decision_baseline_record_hash: sha256CanonicalJson({
          source: "different-decision",
        }),
        resource_authority_contract_hash:
          baseline.contract.locked_challenge_contract_sha256,
      },
    } as any)).toThrow(/authority|결정|권위|binding/i);
  }, 15_000);
});

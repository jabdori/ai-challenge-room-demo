import type { StaticFileChunkingStrategyObjectParam } from "openai/resources/vector-stores/vector-stores";
import {
  buildCandidateFacingPolicySection,
  type CandidateFacingPolicySection,
  type PolicySection,
} from "../contracts/evaluationCase";
import {
  preparePolicyVectorStore,
  type PolicyDocument,
  type PolicyVectorStoreClientLike,
  type PreparePolicyVectorStoreOptions,
  type PreparedPolicyVectorStore,
} from "../retrieval/policyVectorStore";

/** 32개 숨은 benchmark 정책의 순차 upload/attach 예산입니다. */
export const BENCHMARK_POLICY_SETUP_TIMEOUT_MS = 1_200_000;
/** 각 정책 file ingestion poll의 독립 상한입니다. */
export const BENCHMARK_POLICY_FILE_POLL_TIMEOUT_MS = 600_000;
import { sha256CanonicalJson } from "../runtime/canonicalJson";

export const BENCHMARK_POLICY_CHUNKING_CONFIG = Object.freeze({
  type: "static",
  static: Object.freeze({
    max_chunk_size_tokens: 600,
    chunk_overlap_tokens: 300,
  }),
} satisfies StaticFileChunkingStrategyObjectParam);

export interface BenchmarkPolicyResourceIdentity {
  schema_version: "benchmark-policy-resource-v1";
  policy_corpus_sha256: string;
  chunking_config: StaticFileChunkingStrategyObjectParam;
  chunking_config_sha256: string;
  resource_contract_sha256: string;
  manifest_sha256: string;
}

export interface BenchmarkSearchablePolicyDocument
  extends CandidateFacingPolicySection, PolicyDocument {
  /** 단일 식별자만 받는 기존 Vector Store attribute/manifest 계약용 대표 fact입니다. */
  fact_id: string;
}

export interface BenchmarkPolicyCorpusContract {
  candidate_facing_corpus: CandidateFacingPolicySection[];
  searchable_documents: BenchmarkSearchablePolicyDocument[];
  policy_corpus_sha256: string;
  chunking_config: StaticFileChunkingStrategyObjectParam;
  chunking_config_sha256: string;
  resource_contract_sha256: string;
}

export interface PreparedBenchmarkPolicyVectorStore extends PreparedPolicyVectorStore {
  resourceIdentity: BenchmarkPolicyResourceIdentity;
  resourceIdentitySha256: string;
}

export type PrepareBenchmarkPolicyVectorStoreOptions = Omit<
  PreparePolicyVectorStoreOptions,
  "attachmentMode" | "chunkingStrategy"
>;

export function buildBenchmarkPolicyResourceContract(policyCorpusSha256: string): {
  policy_corpus_sha256: string;
  chunking_config: StaticFileChunkingStrategyObjectParam;
  chunking_config_sha256: string;
  resource_contract_sha256: string;
} {
  if (!/^[a-f0-9]{64}$/.test(policyCorpusSha256)) {
    throw new TypeError("Benchmark policy corpus hash는 64자리 소문자 SHA-256이어야 합니다.");
  }
  const contract = {
    policy_corpus_sha256: policyCorpusSha256,
    chunking_config: structuredClone(BENCHMARK_POLICY_CHUNKING_CONFIG),
    chunking_config_sha256: sha256CanonicalJson(BENCHMARK_POLICY_CHUNKING_CONFIG),
  };
  return Object.freeze({
    ...contract,
    resource_contract_sha256: sha256CanonicalJson(contract),
  });
}

export function buildBenchmarkSearchablePolicyDocuments(
  policies: readonly PolicySection[],
): BenchmarkSearchablePolicyDocument[] {
  return policies.map((policy, index) => {
    const candidatePolicy = buildCandidateFacingPolicySection(policy);
    const representativeFactId = candidatePolicy.fact_ids[0];
    if (typeof representativeFactId !== "string" || representativeFactId.trim().length === 0) {
      throw new TypeError(`Benchmark policies[${index}]에는 하나 이상의 fact_id가 필요합니다.`);
    }
    return {
      ...candidatePolicy,
      // fact_ids 전체는 본문에 보존하고, 대표값만 legacy 단일 attribute에 투영합니다.
      fact_id: representativeFactId,
    };
  });
}

export function buildBenchmarkPolicyCorpusContract(
  policies: readonly PolicySection[],
): BenchmarkPolicyCorpusContract {
  const candidateFacingCorpus = policies.map(buildCandidateFacingPolicySection);
  const policyCorpusSha256 = sha256CanonicalJson(candidateFacingCorpus);
  const resource = buildBenchmarkPolicyResourceContract(policyCorpusSha256);
  return Object.freeze({
    candidate_facing_corpus: candidateFacingCorpus,
    searchable_documents: buildBenchmarkSearchablePolicyDocuments(policies),
    policy_corpus_sha256: policyCorpusSha256,
    chunking_config: resource.chunking_config,
    chunking_config_sha256: resource.chunking_config_sha256,
    resource_contract_sha256: resource.resource_contract_sha256,
  });
}

export async function prepareBenchmarkPolicyVectorStore(
  client: PolicyVectorStoreClientLike,
  policies: readonly PolicySection[],
  options: PrepareBenchmarkPolicyVectorStoreOptions = {},
): Promise<PreparedBenchmarkPolicyVectorStore> {
  if (
    policies.length < 1
    || policies.length > 64
    || new Set(
      policies.map((policy) => `${policy.source_id}\u0000${policy.section_id}`),
    ).size !== policies.length
  ) {
    throw new TypeError(
      "정책 자원에는 중복 없는 1..64개 section이 필요합니다.",
    );
  }
  const contract = buildBenchmarkPolicyCorpusContract(policies);
  const prepared = await preparePolicyVectorStore(client, contract.searchable_documents, {
    name: "ai-challenge-hidden-benchmark-policies",
    filenamePrefix: "hidden-benchmark-policy",
    ...options,
    setupTimeoutMs: BENCHMARK_POLICY_SETUP_TIMEOUT_MS,
    pollTimeoutMs: BENCHMARK_POLICY_FILE_POLL_TIMEOUT_MS,
    chunkingStrategy: BENCHMARK_POLICY_CHUNKING_CONFIG,
    attachmentMode: "BATCH_GLOBAL_CHUNKING_THEN_METADATA",
  });
  const resourceIdentity: BenchmarkPolicyResourceIdentity = {
    schema_version: "benchmark-policy-resource-v1",
    policy_corpus_sha256: contract.policy_corpus_sha256,
    chunking_config: structuredClone(contract.chunking_config),
    chunking_config_sha256: contract.chunking_config_sha256,
    resource_contract_sha256: contract.resource_contract_sha256,
    manifest_sha256: prepared.manifestSha256,
  };
  return Object.freeze({
    ...prepared,
    resourceIdentity: Object.freeze(resourceIdentity),
    resourceIdentitySha256: sha256CanonicalJson(resourceIdentity),
  });
}

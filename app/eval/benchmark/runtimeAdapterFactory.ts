import {
  createBenchmarkCandidateBAdapter,
  type BenchmarkCandidateBClientLike,
} from "./candidateBAdapter";
import {
  createBenchmarkCandidateCAdapter,
  type BenchmarkCandidateCClientLike,
} from "./candidateCAdapter";
import {
  createBenchmarkSupportToolExecutor,
  type BenchmarkSupportToolClientLike,
} from "./supportTools";
import type { BenchmarkAdapterCoordinates } from "./buildExecutionPlans";
import { BENCHMARK_CASES, BENCHMARK_POLICIES } from "../data/benchmark";
import {
  createCandidateAAdapter,
  type OpenAIResponsesClientLike,
} from "../openai/candidateAAdapter";
import type { PolicyFileManifestEntry } from "../retrieval/policyVectorStore";
import type { CandidateAdapter } from "../runner/types";

export interface BenchmarkRuntimeClientLike
  extends BenchmarkCandidateBClientLike,
    BenchmarkCandidateCClientLike,
    BenchmarkSupportToolClientLike,
    OpenAIResponsesClientLike {}

export interface PreparedBenchmarkPolicyStoreRuntime {
  readonly vectorStoreId: string;
  readonly files: readonly PolicyFileManifestEntry[];
}

export interface CreateBenchmarkAdapterFactoryInput {
  readonly client: BenchmarkRuntimeClientLike;
  readonly preparedPolicyStore: PreparedBenchmarkPolicyStoreRuntime;
  readonly now?: () => number;
}

function assertPreparedPolicyStore(
  prepared: PreparedBenchmarkPolicyStoreRuntime,
): void {
  if (
    typeof prepared.vectorStoreId !== "string"
    || prepared.vectorStoreId.trim().length === 0
    || !Array.isArray(prepared.files)
    || prepared.files.length !== BENCHMARK_POLICIES.length
  ) {
    throw new TypeError(
      "Benchmark adapter에는 준비된 vector store와 exact 정책 manifest가 필요합니다.",
    );
  }
  for (const [index, policy] of BENCHMARK_POLICIES.entries()) {
    const file = prepared.files[index];
    if (
      file === undefined
      || file.sourceId !== policy.source_id
      || file.sectionId !== policy.section_id
      || file.factId !== policy.fact_ids[0]
      || file.uploadedFileId.trim().length === 0
      || file.filename.trim().length === 0
    ) {
      throw new TypeError(
        `Benchmark 정책 manifest가 잠긴 section 순서와 다릅니다: ${index}`,
      );
    }
  }
}

export function createBenchmarkAdapterFactory({
  client,
  preparedPolicyStore,
  now = Date.now,
}: CreateBenchmarkAdapterFactoryInput): (
  coordinates: BenchmarkAdapterCoordinates,
) => CandidateAdapter {
  assertPreparedPolicyStore(preparedPolicyStore);
  const vectorStoreId = preparedPolicyStore.vectorStoreId;
  const manifest = structuredClone(preparedPolicyStore.files);

  return ({ candidateId, caseId }) => {
    const evaluationCase = BENCHMARK_CASES.find(
      (item) => item.case_id === caseId,
    );
    if (!evaluationCase) {
      throw new TypeError(`잠긴 hidden Benchmark case가 아닙니다: ${caseId}`);
    }
    if (candidateId === "A") {
      return createCandidateAAdapter(client, { now });
    }
    if (candidateId === "B") {
      return createBenchmarkCandidateBAdapter(client, {
        caseId,
        vectorStoreId,
        manifest,
        now,
      });
    }
    const toolExecutor = createBenchmarkSupportToolExecutor(client, {
      caseId,
      vectorStoreId,
      manifest,
      lockedAsOf: evaluationCase.as_of,
      maxNumResults: 6,
      now,
    });
    return createBenchmarkCandidateCAdapter(client, {
      caseId,
      toolExecutor,
      now,
    });
  };
}

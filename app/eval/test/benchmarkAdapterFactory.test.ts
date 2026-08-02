// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  createBenchmarkAdapterFactory,
  type BenchmarkRuntimeClientLike,
} from "../benchmark/runtimeAdapterFactory";
import { BENCHMARK_POLICIES } from "../data/benchmark";
import type { PolicyFileManifestEntry } from "../retrieval/policyVectorStore";

const manifest: PolicyFileManifestEntry[] = BENCHMARK_POLICIES.map(
  (policy, index) => ({
    uploadedFileId: `file-${index + 1}`,
    filename: `policy-${index + 1}.json`,
    sourceId: policy.source_id,
    sectionId: policy.section_id,
    factId: policy.fact_ids[0],
  }),
);

function clientFixture() {
  const responseCreate = vi.fn();
  const search = vi.fn();
  const client = {
    responses: { create: responseCreate },
    vectorStores: {
      search,
      create: vi.fn(),
      files: { create: vi.fn(), retrieve: vi.fn() },
      delete: vi.fn(),
    },
    files: { create: vi.fn(), delete: vi.fn() },
  } as unknown as BenchmarkRuntimeClientLike;
  return { client, responseCreate, search };
}

describe("Benchmark A/B/C 런타임 adapter factory", () => {
  it("사례별 A/B/C adapter와 C 읽기 전용 도구를 만들되 생성 중 원격 호출하지 않는다", () => {
    const { client, responseCreate, search } = clientFixture();
    const adapterFor = createBenchmarkAdapterFactory({
      client,
      preparedPolicyStore: {
        vectorStoreId: "vs_hidden_benchmark",
        files: manifest,
      },
      now: () => 100,
    });

    for (const candidateId of ["A", "B", "C"] as const) {
      expect(adapterFor({ candidateId, caseId: "H-001" }).invoke).toBeTypeOf(
        "function",
      );
    }
    expect(responseCreate).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("잠긴 hidden case와 준비된 원격 정책 자원이 아니면 adapter를 만들지 않는다", () => {
    const { client } = clientFixture();
    expect(() => createBenchmarkAdapterFactory({
      client,
      preparedPolicyStore: { vectorStoreId: "", files: manifest },
    })).toThrow(/vector store|정책 자원|manifest/i);
    expect(() => createBenchmarkAdapterFactory({
      client,
      preparedPolicyStore: {
        vectorStoreId: "vs_hidden_benchmark",
        files: [],
      },
    })).toThrow(/vector store|정책 자원|manifest/i);

    const adapterFor = createBenchmarkAdapterFactory({
      client,
      preparedPolicyStore: {
        vectorStoreId: "vs_hidden_benchmark",
        files: manifest,
      },
    });
    expect(() => adapterFor({ candidateId: "A", caseId: "H-999" }))
      .toThrow(/hidden|case|잠긴/i);
  });
});

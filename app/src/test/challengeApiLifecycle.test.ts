import { describe, expect, it, vi } from "vitest";
import {
  ChallengeApiClient,
  ChallengeApiClientError,
} from "../data/challengeApi";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function response() {
  return new Response(JSON.stringify({
    accepted: true,
    source_hash: SHA_C,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("browser Define/Compare named mutation client", () => {
  it("Define structure와 exact human lock command를 고정 endpoint·schema·payload로 보낸다", async () => {
    const fetcher = vi.fn<(...args: [RequestInfo | URL, RequestInit?]) => Promise<Response>>(
      async () => response(),
    );
    const client = new ChallengeApiClient(fetcher);

    await client.structureDefine({
      expectedSourceHash: SHA_A,
      idempotencyKey: "mutation_define_001",
      actorLabel: "Evaluation owner",
    });
    await client.lockChallenge({
      challengeId: "monomarket-support-ai-selection",
      expectedSourceHash: SHA_B,
      idempotencyKey: "mutation_lock_001",
      actorLabel: "Evaluation owner",
      defineStructuringArtifactHash: SHA_A,
      approvedContractHash: SHA_C,
    });

    const [structurePath, structureInit] = fetcher.mock.calls[0];
    expect(structurePath).toBe("/api/define/structure");
    expect(JSON.parse(String(structureInit?.body))).toEqual({
      schema_version: "define-structure-command-v1",
      expected_source_hash: SHA_A,
      idempotency_key: "mutation_define_001",
      payload: {
        actor_type: "HUMAN",
        actor_label: "Evaluation owner",
      },
    });

    const [lockPath, lockInit] = fetcher.mock.calls[1];
    expect(lockPath).toBe(
      "/api/challenges/monomarket-support-ai-selection/lock",
    );
    expect(JSON.parse(String(lockInit?.body))).toEqual({
      schema_version: "challenge-lock-command-v1",
      expected_source_hash: SHA_B,
      idempotency_key: "mutation_lock_001",
      payload: {
        actor_type: "HUMAN",
        actor_label: "Evaluation owner",
        decision: "APPROVE_EXACT_CONTRACT",
        define_structuring_artifact_hash: SHA_A,
        approved_contract_hash: SHA_C,
      },
    });
  });

  it("START와 RESUME를 같은 stable 64-hex Benchmark endpoint에 exact 실행 계약으로 보낸다", async () => {
    const fetcher = vi.fn<(...args: [RequestInfo | URL, RequestInit?]) => Promise<Response>>(
      async () => response(),
    );
    const client = new ChallengeApiClient(fetcher);

    await client.startBenchmark({
      benchmarkId: SHA_B,
      expectedSourceHash: SHA_A,
      idempotencyKey: "mutation_benchmark_start_001",
      actorLabel: "Evaluation owner",
    });
    await client.resumeBenchmark({
      benchmarkId: SHA_B,
      expectedSourceHash: SHA_C,
      idempotencyKey: "mutation_benchmark_resume_001",
      actorLabel: "Evaluation owner",
      resumeFromProgressHash: SHA_A,
    });

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      `/api/benchmarks/${SHA_B}/start`,
      `/api/benchmarks/${SHA_B}/start`,
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      schema_version: "benchmark-start-command-v1",
      expected_source_hash: SHA_A,
      idempotency_key: "mutation_benchmark_start_001",
      payload: {
        actor_type: "HUMAN",
        actor_label: "Evaluation owner",
        execution_mode: "START",
        acknowledgement:
          "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
        resume_from_progress_hash: null,
      },
    });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      schema_version: "benchmark-start-command-v1",
      expected_source_hash: SHA_C,
      idempotency_key: "mutation_benchmark_resume_001",
      payload: {
        actor_type: "HUMAN",
        actor_label: "Evaluation owner",
        execution_mode: "RESUME",
        acknowledgement:
          "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
        resume_from_progress_hash: SHA_A,
      },
    });
  });

  it("공백 actor·alias Benchmark ID·불완전 resume hash는 요청 전에 차단한다", () => {
    const fetcher = vi.fn<(...args: [RequestInfo | URL, RequestInit?]) => Promise<Response>>(
      async () => response(),
    );
    const client = new ChallengeApiClient(fetcher);

    expect(() => client.structureDefine({
      expectedSourceHash: SHA_A,
      idempotencyKey: "mutation_define_002",
      actorLabel: " ",
    })).toThrow(ChallengeApiClientError);
    expect(() => client.startBenchmark({
      benchmarkId: "benchmark_alias",
      expectedSourceHash: SHA_A,
      idempotencyKey: "mutation_benchmark_start_002",
      actorLabel: "Evaluation owner",
    })).toThrow(ChallengeApiClientError);
    expect(() => client.resumeBenchmark({
      benchmarkId: SHA_B,
      expectedSourceHash: SHA_A,
      idempotencyKey: "mutation_benchmark_resume_002",
      actorLabel: "Evaluation owner",
      resumeFromProgressHash: "not-a-hash",
    })).toThrow(ChallengeApiClientError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// @vitest-environment node

import {
  chmod,
  link,
  mkdtemp,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createBenchmarkCandidateDefinition,
} from "../benchmark/candidateDefinitions";
import {
  buildBenchmarkExecutionIdentity,
  buildBenchmarkSlotIdentity,
  benchmarkSlotIdentityHashes,
  BENCHMARK_EXECUTION_DATA_HASH,
  loadBenchmarkExecutionIdentityAuthority,
  persistBenchmarkExecutionIdentityAuthority,
  validateLockedBenchmarkExecutionIdentity,
  type BenchmarkExecutionIdentity,
} from "../benchmark/identity";
import { buildBenchmarkSchedule } from "../benchmark/schedule";
import {
  buildPolicyManifestHash,
  buildRunnerInputAccessEvidence,
} from "../contracts/runnerInputAccessEvidence";
import {
  BENCHMARK_CASES,
  BENCHMARK_CHALLENGE,
  BENCHMARK_ORDERS,
  BENCHMARK_ORACLES,
  BENCHMARK_POLICIES,
} from "../data/benchmark/index";
import {
  buildBenchmarkPolicyCorpusContract,
} from "../benchmark/policyVectorStore";
import type { CandidateAdapter } from "../runner/types";
import { DEFAULT_PRICING_SNAPSHOT } from "../runtime/pricing";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import { BENCHMARK_EVALUATOR_CONTRACT_HASH } from "../deterministic/hardGates";
import { createLockedChallengePack } from "../define/defineContracts";
import {
  createLockedChallengeFixtureBundle,
  LOCKED_CHALLENGE_FIXTURE,
} from "./helpers/lockedChallengeFixture";

const adapter: CandidateAdapter = {
  invoke: async () => {
    throw new Error("identity 테스트에서는 adapter를 호출하지 않습니다.");
  },
};

const schedule = buildBenchmarkSchedule(BENCHMARK_CASES, ["A", "B", "C"]);
const slot = schedule[0];
const evaluationCase = BENCHMARK_CASES[0];
const oracle = BENCHMARK_ORACLES[0];
const authoritativeOrder = BENCHMARK_ORDERS.find(
  (order) => order.order_id === evaluationCase.order_id,
) ?? null;
const policyContract = buildBenchmarkPolicyCorpusContract(BENCHMARK_POLICIES);

function executionIdentity(overrides: {
  manifestHash?: string;
  resourceIdentityHash?: string;
  scheduleId?: string;
  pricingSnapshot?: typeof DEFAULT_PRICING_SNAPSHOT;
  vectorStoreId?: string;
} = {}): BenchmarkExecutionIdentity {
  return buildBenchmarkExecutionIdentity({
    lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
    scheduleId: overrides.scheduleId ?? schedule.schedule_id,
    policyManifestHash: overrides.manifestHash ?? "a".repeat(64),
    policyResourceIdentityHash: overrides.resourceIdentityHash ?? "b".repeat(64),
    policyVectorStoreId: overrides.vectorStoreId ?? "vs-hidden-benchmark",
    pricingSnapshot: overrides.pricingSnapshot ?? DEFAULT_PRICING_SNAPSHOT,
  });
}

function slotIdentityInput() {
  const definition = createBenchmarkCandidateDefinition({
    candidateId: "A",
    evaluationCase,
    authorizedOrder: authoritativeOrder,
    policyCorpus: BENCHMARK_POLICIES,
    adapter,
    challenge: BENCHMARK_CHALLENGE,
  });
  const accessEvidence = buildRunnerInputAccessEvidence({
    candidateId: "A",
    slotId: slot.slot_id,
    repetition: slot.repetition,
    evaluationCase,
    policies: BENCHMARK_POLICIES,
    authoritativeOrder,
    orderAccessStatus: "SUCCESS",
  });
  return {
    executionIdentity: executionIdentity(),
    slot,
    evaluationCase,
    oracle,
    authoritativeOrder,
    candidateDefinition: definition,
    accessEvidence,
  };
}

describe("숨은 Benchmark 실행·slot identity", () => {
  it("write-once authority artifact만 cold process에서 execution identity 권한을 재발급한다", async () => {
    const outputDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "benchmark-identity-authority-"),
    ));
    await chmod(outputDirectory, 0o700);
    const identity = executionIdentity();
    const persisted = await persistBenchmarkExecutionIdentityAuthority({
      outputDirectory,
      executionIdentity: identity,
    });

    const serialized = structuredClone(identity);
    expect(() => validateLockedBenchmarkExecutionIdentity(
      serialized,
      schedule.schedule_id,
    )).toThrow(/authoritative|Locked Challenge|identity/i);

    const loaded = await loadBenchmarkExecutionIdentityAuthority({
      outputDirectory,
      authority: {
        path: persisted.path,
        payload_sha256: persisted.payloadSha256,
      },
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      expectedScheduleId: schedule.schedule_id,
    });

    expect(loaded).toEqual(identity);
    expect(() => validateLockedBenchmarkExecutionIdentity(
      loaded,
      schedule.schedule_id,
    )).not.toThrow();
  });

  it.each([
    "payload hash swap",
    "missing authority reference",
    "path escape",
    "symlink",
    "hardlink",
    "mode",
  ] as const)("identity authority %s를 fail-closed로 거부한다", async (attack) => {
    const outputDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "benchmark-identity-authority-attack-"),
    ));
    await chmod(outputDirectory, 0o700);
    const persisted = await persistBenchmarkExecutionIdentityAuthority({
      outputDirectory,
      executionIdentity: executionIdentity(),
    });
    let authority = {
      path: persisted.path,
      payload_sha256: persisted.payloadSha256,
    };
    if (attack === "payload hash swap") {
      authority = { ...authority, payload_sha256: "0".repeat(64) };
    } else if (attack === "path escape") {
      authority = {
        ...authority,
        path: join(outputDirectory, "..", "escaped-identity-authority.json"),
      };
    } else if (attack === "symlink") {
      const target = join(outputDirectory, "external-identity-authority.json");
      await writeFile(target, "{}\n", { mode: 0o600 });
      await unlink(persisted.path);
      await symlink(target, persisted.path);
    } else if (attack === "hardlink") {
      await link(persisted.path, `${persisted.path}.second-link`);
    } else {
      await chmod(persisted.path, 0o640);
    }

    await expect(loadBenchmarkExecutionIdentityAuthority({
      outputDirectory,
      authority: attack === "missing authority reference"
        ? undefined as never
        : authority,
      lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
      expectedScheduleId: schedule.schedule_id,
    })).rejects.toThrow(/authority|canonical|hash|symlink|0600|path|link/i);
  });

  it("authoritative Locked Challenge pack 없이나 clone으로 실행 identity를 만들지 않는다", () => {
    const common = {
      scheduleId: schedule.schedule_id,
      policyManifestHash: "a".repeat(64),
      policyResourceIdentityHash: "b".repeat(64),
      policyVectorStoreId: "vs-hidden-benchmark",
    };

    expect(() => buildBenchmarkExecutionIdentity({
      ...common,
      lockedChallengePack: undefined as never,
    })).toThrow(/Locked Challenge|authoritative|인간 승인|검증/i);
    expect(() => buildBenchmarkExecutionIdentity({
      ...common,
      lockedChallengePack: structuredClone(LOCKED_CHALLENGE_FIXTURE),
    })).toThrow(/Locked Challenge|authoritative|build|검증/i);
  });

  it("인간 승인 6차원 프로필과 Benchmark runtime 프로필이 다르면 실행 identity 생성을 막는다", () => {
    const fixture = createLockedChallengeFixtureBundle();
    const creationInput = structuredClone(
      fixture.creationInput,
    ) as unknown as Record<string, any>;
    creationInput.approval.approved_contract.candidate_complexity_profiles[1]
      .candidate_failure_components = 3;
    const mismatchedPack = createLockedChallengePack(
      creationInput as Parameters<typeof createLockedChallengePack>[0],
    );

    expect(() => buildBenchmarkExecutionIdentity({
      lockedChallengePack: mismatchedPack,
      scheduleId: schedule.schedule_id,
      policyManifestHash: "a".repeat(64),
      policyResourceIdentityHash: "b".repeat(64),
      policyVectorStoreId: "vs-hidden-benchmark",
    })).toThrow(/complexity|profile|approved|runtime|복잡도|일치/i);
  });

  it("숨은 실행 데이터 hash와 원격 정책 자원·schedule·가격·runner·evidence 계약을 분리해 결합한다", () => {
    const result = executionIdentity();

    expect(BENCHMARK_EXECUTION_DATA_HASH).toMatch(/^[a-f0-9]{64}$/);
    expect(result).toMatchObject({
      schema_version: "benchmark-execution-identity-v1",
      schedule_id: schedule.schedule_id,
      hidden_execution_data_hash: BENCHMARK_EXECUTION_DATA_HASH,
      locked_challenge_pack_hash:
        LOCKED_CHALLENGE_FIXTURE.locked_challenge_pack_hash,
      locked_challenge_contract_hash:
        LOCKED_CHALLENGE_FIXTURE.approved_contract_hash,
      locked_challenge_source_manifest_hash:
        LOCKED_CHALLENGE_FIXTURE.source_manifest_hash,
      evaluator_policy_corpus_hash: sha256CanonicalJson(BENCHMARK_POLICIES),
      evaluator_contract_hash: BENCHMARK_EVALUATOR_CONTRACT_HASH,
      evaluator_policy_manifest_hash: buildPolicyManifestHash(BENCHMARK_POLICIES),
      candidate_policy_corpus_hash: policyContract.policy_corpus_sha256,
      policy_manifest_hash: "a".repeat(64),
      policy_resource_identity_hash: "b".repeat(64),
      policy_vector_store_id_hash: sha256CanonicalJson("vs-hidden-benchmark"),
      pricing_snapshot_hash: sha256CanonicalJson(DEFAULT_PRICING_SNAPSHOT),
    });
    expect(result.execution_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.evaluator_policy_manifest_hash).not.toBe(result.policy_manifest_hash);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("평가자 section manifest와 prepared upload manifest가 달라도 각각의 의미로 결합한다", () => {
    const candidateB = createBenchmarkCandidateDefinition({
      candidateId: "B",
      evaluationCase,
      authorizedOrder: authoritativeOrder,
      policyCorpus: BENCHMARK_POLICIES,
      adapter,
      challenge: BENCHMARK_CHALLENGE,
    });
    const candidateBSlot = schedule.find((item) => item.slot_id === "H-001--B--r1")!;
    const accessEvidence = buildRunnerInputAccessEvidence({
      candidateId: "B",
      slotId: candidateBSlot.slot_id,
      repetition: 1,
      evaluationCase,
      policies: BENCHMARK_POLICIES,
      authoritativeOrder,
      orderAccessStatus: "SUCCESS",
    });
    const execution = executionIdentity({ manifestHash: "a".repeat(64) });

    const result = buildBenchmarkSlotIdentity({
      executionIdentity: execution,
      slot: candidateBSlot,
      evaluationCase,
      oracle,
      authoritativeOrder,
      candidateDefinition: candidateB,
      accessEvidence,
      preparedPolicyResource: {
        policy_corpus_sha256: policyContract.policy_corpus_sha256,
        chunking_config_sha256: policyContract.chunking_config_sha256,
        resource_contract_sha256: policyContract.resource_contract_sha256,
        manifest_sha256: execution.policy_manifest_hash,
        resource_identity_sha256: execution.policy_resource_identity_hash,
        vector_store_id_hash: execution.policy_vector_store_id_hash,
      },
    });

    expect(result.evaluator_policy_manifest_hash).toBe(accessEvidence.policyAccess.manifestHash);
    expect(result.policy_manifest_hash).toBe("a".repeat(64));
    expect(result.evaluator_policy_manifest_hash).not.toBe(result.policy_manifest_hash);
  });

  it("manifest, prepared resource identity, schedule 또는 pricing이 한 바이트라도 달라지면 execution hash가 달라진다", () => {
    const base = executionIdentity();
    const differentManifest = executionIdentity({ manifestHash: `c${"a".repeat(63)}` });
    const differentResource = executionIdentity({ resourceIdentityHash: `c${"b".repeat(63)}` });
    const differentSchedule = executionIdentity({ scheduleId: `c${schedule.schedule_id.slice(1)}` });
    const differentPricing = executionIdentity({
      pricingSnapshot: {
        ...DEFAULT_PRICING_SNAPSHOT,
        rates_per_unit: {
          ...DEFAULT_PRICING_SNAPSHOT.rates_per_unit,
          input: DEFAULT_PRICING_SNAPSHOT.rates_per_unit.input + 0.01,
        },
      },
    });
    const differentVectorStore = executionIdentity({ vectorStoreId: "vs-hidden-benchmark-copy" });

    expect(new Set([
      base.execution_hash,
      differentManifest.execution_hash,
      differentResource.execution_hash,
      differentSchedule.execution_hash,
      differentPricing.execution_hash,
      differentVectorStore.execution_hash,
    ])).toHaveLength(6);
  });

  it("slot identity가 순서·후보 위치·반복·case/oracle/order·config/prompt/invocation/envelope/input/access/가격을 모두 결합한다", () => {
    const input = slotIdentityInput();
    const result = buildBenchmarkSlotIdentity(input);

    expect(result).toMatchObject({
      schema_version: "benchmark-slot-identity-v1",
      execution_hash: input.executionIdentity.execution_hash,
      schedule_id: schedule.schedule_id,
      slot_id: slot.slot_id,
      sequence: slot.sequence,
      candidate_position: slot.candidate_position,
      repetition: 1,
      candidate_id: "A",
      case_id: evaluationCase.case_id,
      candidate_config_hash: input.candidateDefinition.identity.candidate_config_hash,
      system_prompt_hash: input.candidateDefinition.identity.system_prompt_hash,
      invocation_hash: input.candidateDefinition.identity.invocation_hash,
      candidate_input_hash: input.accessEvidence.candidateInputHash,
      pricing_snapshot_hash: input.executionIdentity.pricing_snapshot_hash,
      evaluator_contract_hash: BENCHMARK_EVALUATOR_CONTRACT_HASH,
    });
    expect(result.slot_identity_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("persistence identity projection에는 execution·slot의 hash만 충돌 없는 이름으로 포함한다", () => {
    const input = slotIdentityInput();
    const slotIdentity = buildBenchmarkSlotIdentity(input);
    const hashes = benchmarkSlotIdentityHashes(input.executionIdentity, slotIdentity);

    expect(hashes).toMatchObject({
      challenge_hash: input.executionIdentity.challenge_hash,
      dataset_hash: input.executionIdentity.dataset_hash,
      benchmark_oracle_hash: input.executionIdentity.oracle_hash,
      execution_identity_hash: input.executionIdentity.execution_hash,
      evaluator_contract_hash: BENCHMARK_EVALUATOR_CONTRACT_HASH,
      slot_oracle_hash: slotIdentity.oracle_hash,
      candidate_config_hash: slotIdentity.candidate_config_hash,
      prompt_hash: slotIdentity.system_prompt_hash,
      execution_envelope_hash: slotIdentity.execution_envelope_hash,
      slot_identity_hash: slotIdentity.slot_identity_hash,
    });
    expect(hashes).not.toHaveProperty("slot_id");
    expect(hashes).not.toHaveProperty("candidate_id");
    expect(Object.values(hashes).every((value) => /^[a-f0-9]{64}$/.test(value))).toBe(true);
  });

  it("r1 identity를 r2 slot으로 재사용하거나 schedule-owned identity를 섞으면 원격 호출 전에 거부한다", () => {
    const input = slotIdentityInput();
    const repetitionTwo = schedule.find(
      (item) => item.case_id === slot.case_id
        && item.candidate_id === slot.candidate_id
        && item.repetition === 2,
    );
    expect(repetitionTwo).toBeDefined();

    expect(() => buildBenchmarkSlotIdentity({
      ...input,
      slot: repetitionTwo!,
    })).toThrow(/slot|반복|identity/i);
  });

  it("B/C config의 corpus·600\/300 chunking·resource 계약이 prepared policy identity와 다르면 거부한다", () => {
    const candidateB = createBenchmarkCandidateDefinition({
      candidateId: "B",
      evaluationCase,
      authorizedOrder: authoritativeOrder,
      policyCorpus: BENCHMARK_POLICIES,
      adapter,
      challenge: BENCHMARK_CHALLENGE,
    });
    const accessEvidence = buildRunnerInputAccessEvidence({
      candidateId: "B",
      slotId: "H-001--B--r1",
      repetition: 1,
      evaluationCase,
      policies: BENCHMARK_POLICIES,
      authoritativeOrder,
      orderAccessStatus: "SUCCESS",
    });
    const candidateBSlot = schedule.find((item) => item.slot_id === "H-001--B--r1")!;

    expect(() => buildBenchmarkSlotIdentity({
      executionIdentity: executionIdentity(),
      slot: candidateBSlot,
      evaluationCase,
      oracle,
      authoritativeOrder,
      candidateDefinition: candidateB,
      accessEvidence,
      preparedPolicyResource: {
        policy_corpus_sha256: policyContract.policy_corpus_sha256,
        chunking_config_sha256: "c".repeat(64),
        resource_contract_sha256: policyContract.resource_contract_sha256,
        manifest_sha256: "a".repeat(64),
        resource_identity_sha256: "b".repeat(64),
        vector_store_id_hash: sha256CanonicalJson("vs-hidden-benchmark"),
      },
    })).toThrow(/chunking|정책 자원|resource/i);
  });

  it("B/C가 execution에 잠긴 원격 vector store와 다른 handle을 쓰면 원격 호출 전에 거부한다", () => {
    const candidateB = createBenchmarkCandidateDefinition({
      candidateId: "B",
      evaluationCase,
      authorizedOrder: authoritativeOrder,
      policyCorpus: BENCHMARK_POLICIES,
      adapter,
      challenge: BENCHMARK_CHALLENGE,
    });
    const accessEvidence = buildRunnerInputAccessEvidence({
      candidateId: "B",
      slotId: "H-001--B--r1",
      repetition: 1,
      evaluationCase,
      policies: BENCHMARK_POLICIES,
      authoritativeOrder,
      orderAccessStatus: "SUCCESS",
    });
    const candidateBSlot = schedule.find((item) => item.slot_id === "H-001--B--r1")!;

    expect(() => buildBenchmarkSlotIdentity({
      executionIdentity: executionIdentity(),
      slot: candidateBSlot,
      evaluationCase,
      oracle,
      authoritativeOrder,
      candidateDefinition: candidateB,
      accessEvidence,
      preparedPolicyResource: {
        policy_corpus_sha256: policyContract.policy_corpus_sha256,
        chunking_config_sha256: policyContract.chunking_config_sha256,
        resource_contract_sha256: policyContract.resource_contract_sha256,
        manifest_sha256: "a".repeat(64),
        resource_identity_sha256: "b".repeat(64),
        vector_store_id_hash: sha256CanonicalJson("vs-hidden-benchmark-copy"),
      },
    })).toThrow(/정책 자원|resource|vector store/i);
  });

  it("잘못된 hash 형식은 execution identity를 만들기 전에 거부한다", () => {
    expect(() => executionIdentity({ manifestHash: "not-a-sha256" })).toThrow(/SHA-256|hash/i);
  });

  it("Locked Challenge pack hash를 바꾸고 상위 execution hash를 다시 계산해도 slot 실행 전 거부한다", () => {
    const input = slotIdentityInput();
    const { execution_hash: _original, ...payload } = input.executionIdentity;
    const changedPayload = {
      ...payload,
      locked_challenge_pack_hash: "c".repeat(64),
    };
    const tampered = {
      ...changedPayload,
      execution_hash: sha256CanonicalJson(changedPayload),
    } as BenchmarkExecutionIdentity;

    expect(() => buildBenchmarkSlotIdentity({
      ...input,
      executionIdentity: tampered,
    })).toThrow(/Locked Challenge|authoritative|execution identity|계약/i);
  });
});

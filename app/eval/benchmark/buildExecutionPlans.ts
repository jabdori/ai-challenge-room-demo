import { createBenchmarkCandidateDefinition } from "./candidateDefinitions";
import {
  buildBenchmarkSlotIdentity,
  validateLockedBenchmarkExecutionIdentity,
  type BenchmarkExecutionIdentity,
} from "./identity";
import {
  buildBenchmarkSchedule,
  type BenchmarkCandidateId,
  type BenchmarkSchedule,
} from "./schedule";
import type { BenchmarkExecutionSlotPlan } from "./executeBenchmark";
import { buildRunnerInputAccessEvidence } from "../contracts/runnerInputAccessEvidence";
import {
  BENCHMARK_CASES,
  BENCHMARK_CHALLENGE,
  BENCHMARK_ORDERS,
  BENCHMARK_ORACLES,
  BENCHMARK_POLICIES,
} from "../data/benchmark";
import { canonicalJsonStringify } from "../runtime/canonicalJson";
import type { CandidateAdapter } from "../runner/types";
import { types as utilTypes } from "node:util";

export interface BenchmarkAdapterCoordinates {
  readonly candidateId: BenchmarkCandidateId;
  readonly caseId: string;
}

export interface BuildBenchmarkExecutionPlansInput {
  readonly executionIdentity: BenchmarkExecutionIdentity;
  readonly schedule: BenchmarkSchedule;
  readonly adapterFor: (
    coordinates: BenchmarkAdapterCoordinates,
  ) => CandidateAdapter;
}

function assertLockedSchedule(schedule: BenchmarkSchedule): BenchmarkSchedule {
  const expected = buildBenchmarkSchedule(BENCHMARK_CASES, ["A", "B", "C"]);
  const expectedSlotKeys = [
    "candidate_id",
    "candidate_position",
    "case_id",
    "repetition",
    "sequence",
    "slot_id",
  ];
  const scheduleIdDescriptor = Object.getOwnPropertyDescriptor(
    schedule,
    "schedule_id",
  );
  if (
    !Array.isArray(schedule)
    || utilTypes.isProxy(schedule)
    || Object.getPrototypeOf(schedule) !== Array.prototype
    || !Object.isFrozen(schedule)
    || schedule.some((slot) => {
      if (
        utilTypes.isProxy(slot)
        || Object.getPrototypeOf(slot) !== Object.prototype
        || !Object.isFrozen(slot)
      ) return true;
      const descriptors = Object.getOwnPropertyDescriptors(slot);
      const actualNames = Object.getOwnPropertyNames(slot).sort();
      return Object.getOwnPropertySymbols(slot).length > 0
        || actualNames.length !== expectedSlotKeys.length
        || actualNames.some((key, index) => key !== expectedSlotKeys[index])
        || Object.values(descriptors).some(
          (descriptor) => !("value" in descriptor) || !descriptor.enumerable,
        );
    })
    || scheduleIdDescriptor === undefined
    || !("value" in scheduleIdDescriptor)
    || scheduleIdDescriptor.value !== expected.schedule_id
    || scheduleIdDescriptor.writable !== false
    || scheduleIdDescriptor.configurable !== false
    || scheduleIdDescriptor.enumerable !== false
    || schedule.length !== 72
    || canonicalJsonStringify([...schedule]) !== canonicalJsonStringify([...expected])
  ) {
    throw new TypeError(
      "Benchmark 실행 계획은 잠긴 12개 사례 × A/B/C × 2회 schedule이어야 합니다.",
    );
  }
  return expected;
}

export function buildBenchmarkExecutionPlans({
  executionIdentity,
  schedule,
  adapterFor,
}: BuildBenchmarkExecutionPlansInput): readonly BenchmarkExecutionSlotPlan[] {
  const lockedSchedule = assertLockedSchedule(schedule);
  validateLockedBenchmarkExecutionIdentity(
    executionIdentity,
    lockedSchedule.schedule_id,
  );

  const adapters = new Map<string, CandidateAdapter>();
  return Object.freeze(lockedSchedule.map((slot): BenchmarkExecutionSlotPlan => {
    const evaluationCase = BENCHMARK_CASES.find(
      (item) => item.case_id === slot.case_id,
    );
    const oracle = BENCHMARK_ORACLES.find(
      (item) => item.case_id === slot.case_id,
    );
    if (!evaluationCase || !oracle) {
      throw new TypeError(`잠긴 Benchmark case/oracle이 없습니다: ${slot.case_id}`);
    }
    const authoritativeOrder = evaluationCase.order_id === null
      ? null
      : BENCHMARK_ORDERS.find(
        (item) => item.order_id === evaluationCase.order_id,
      ) ?? null;
    const expectation = oracle.candidate_access_expectations.find(
      (item) => item.candidate_id === slot.candidate_id,
    );
    if (!expectation) {
      throw new TypeError(
        `잠긴 후보 접근 계약이 없습니다: ${slot.case_id}:${slot.candidate_id}`,
      );
    }

    const adapterKey = `${slot.case_id}:${slot.candidate_id}`;
    let adapter = adapters.get(adapterKey);
    if (adapter === undefined) {
      adapter = adapterFor({
        candidateId: slot.candidate_id,
        caseId: slot.case_id,
      });
      if (
        typeof adapter !== "object"
        || adapter === null
        || typeof adapter.invoke !== "function"
      ) {
        throw new TypeError(`${adapterKey} adapter는 invoke 함수를 제공해야 합니다.`);
      }
      adapters.set(adapterKey, adapter);
    }

    const accessEvidence = buildRunnerInputAccessEvidence({
      candidateId: slot.candidate_id,
      slotId: slot.slot_id,
      repetition: slot.repetition,
      evaluationCase,
      policies: BENCHMARK_POLICIES,
      authoritativeOrder,
      orderAccessStatus: expectation.expected_order_access_status,
    });
    const candidateDefinition = createBenchmarkCandidateDefinition({
      candidateId: slot.candidate_id,
      evaluationCase,
      authorizedOrder: expectation.expected_order_access_status === "SUCCESS"
        ? authoritativeOrder
        : null,
      policyCorpus: BENCHMARK_POLICIES,
      adapter,
      challenge: BENCHMARK_CHALLENGE,
    });
    const preparedPolicyResource = slot.candidate_id === "A"
      ? undefined
      : {
        policy_corpus_sha256: candidateDefinition.config.policy_corpus_hash,
        chunking_config_sha256:
          candidateDefinition.config.policy_chunking_config_hash!,
        resource_contract_sha256:
          candidateDefinition.config.policy_resource_contract_hash!,
        manifest_sha256: executionIdentity.policy_manifest_hash,
        resource_identity_sha256:
          executionIdentity.policy_resource_identity_hash,
        vector_store_id_hash:
          executionIdentity.policy_vector_store_id_hash,
      };
    const slotIdentity = buildBenchmarkSlotIdentity({
      executionIdentity,
      slot,
      evaluationCase,
      oracle,
      authoritativeOrder,
      candidateDefinition,
      accessEvidence,
      ...(preparedPolicyResource ? { preparedPolicyResource } : {}),
    });
    return Object.freeze({
      slot_identity: slotIdentity,
      execution_options: Object.freeze({
        slot,
        candidateDefinition,
        evaluationCase,
        oracle,
        policies: BENCHMARK_POLICIES,
        authoritativeOrder,
      }),
    });
  }));
}

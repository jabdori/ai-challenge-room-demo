// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  buildBenchmarkExecutionPlans,
} from "../benchmark/buildExecutionPlans";
import {
  buildBenchmarkExecutionIdentity,
} from "../benchmark/identity";
import { buildBenchmarkSchedule } from "../benchmark/schedule";
import {
  BENCHMARK_CASES,
  BENCHMARK_ORACLES,
} from "../data/benchmark";
import type { CandidateAdapter } from "../runner/types";
import { LOCKED_CHALLENGE_FIXTURE } from "./helpers/lockedChallengeFixture";

const schedule = buildBenchmarkSchedule(BENCHMARK_CASES, ["A", "B", "C"]);
const executionIdentity = buildBenchmarkExecutionIdentity({
  lockedChallengePack: LOCKED_CHALLENGE_FIXTURE,
  scheduleId: schedule.schedule_id,
  policyManifestHash: "1".repeat(64),
  policyResourceIdentityHash: "2".repeat(64),
  policyVectorStoreId: "vs_benchmark_plan_fixture",
});

function adapter(label: string): CandidateAdapter {
  return {
    invoke: async () => {
      throw new Error(`${label}은 plan 생성 중 호출되면 안 됩니다.`);
    },
  };
}

describe("숨은 Benchmark 72-slot 실행 계획", () => {
  it("12개 사례 × A/B/C × 2회 계획을 잠긴 순서와 identity로 만든다", () => {
    const adapterFor = vi.fn(({ candidateId, caseId }) => (
      adapter(`${caseId}:${candidateId}`)
    ));

    const plans = buildBenchmarkExecutionPlans({
      executionIdentity,
      schedule,
      adapterFor,
    });

    expect(plans).toHaveLength(72);
    expect(adapterFor).toHaveBeenCalledTimes(36);
    expect(plans.map((plan) => plan.slot_identity.slot_id)).toEqual(
      schedule.map((slot) => slot.slot_id),
    );
    expect(plans.every((plan) => Object.isFrozen(plan))).toBe(true);
    expect(plans.every((plan) => Object.isFrozen(plan.execution_options))).toBe(true);
    for (const plan of plans) {
      const oracle = BENCHMARK_ORACLES.find(
        (item) => item.case_id === plan.slot_identity.case_id,
      )!;
      const expectation = oracle.candidate_access_expectations.find(
        (item) => item.candidate_id === plan.slot_identity.candidate_id,
      )!;
      expect(plan.execution_options.candidateDefinition.candidateId).toBe(
        plan.slot_identity.candidate_id,
      );
      expect(expectation).toBeDefined();
      expect(plan.execution_options.candidateDefinition.config.case_identity_hash).toBe(
        plan.slot_identity.case_hash,
      );
    }
  });

  it("잠기지 않은 schedule 또는 execution identity를 원격 adapter 생성 전에 거부한다", () => {
    const adapterFor = vi.fn(() => adapter("never"));
    const reversed = Object.assign(
      [...schedule].reverse(),
      { schedule_id: schedule.schedule_id },
    ) as typeof schedule;

    expect(() => buildBenchmarkExecutionPlans({
      executionIdentity,
      schedule: reversed,
      adapterFor,
    })).toThrow(/잠긴|schedule|72|identity/i);
    expect(adapterFor).not.toHaveBeenCalled();

    expect(() => buildBenchmarkExecutionPlans({
      executionIdentity: structuredClone(executionIdentity),
      schedule,
      adapterFor,
    })).toThrow(/authoritative|identity|잠긴|build/i);
    expect(adapterFor).not.toHaveBeenCalled();
  });

  it("Proxy schedule이 검증 뒤 후보 좌표를 바꾸는 TOCTOU도 adapter 생성 전에 차단한다", () => {
    const adapterFor = vi.fn(() => adapter("never"));
    const mutable = [...schedule] as Array<(typeof schedule)[number]> & {
      schedule_id: string;
    };
    Object.defineProperty(mutable, "schedule_id", {
      value: schedule.schedule_id,
      enumerable: false,
      configurable: true,
    });
    let indexedReads = 0;
    const proxied = new Proxy(mutable, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          indexedReads += 1;
          const slot = Reflect.get(target, property, receiver) as (typeof schedule)[number];
          if (indexedReads > schedule.length && property === "0") {
            return {
              ...slot,
              candidate_id: slot.candidate_id === "A" ? "B" : "A",
            };
          }
        }
        return Reflect.get(target, property, receiver);
      },
    }) as typeof schedule;

    expect(() => buildBenchmarkExecutionPlans({
      executionIdentity,
      schedule: proxied,
      adapterFor,
    })).toThrow(/잠긴|schedule|slot|identity|좌표|반복/i);
    expect(adapterFor).not.toHaveBeenCalled();
  });
});

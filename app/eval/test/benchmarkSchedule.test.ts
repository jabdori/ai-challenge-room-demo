// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildBenchmarkSchedule,
  type BenchmarkCandidateId,
} from "../benchmark/schedule";
import { BENCHMARK_CASES } from "../data/benchmark/index";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

const CANDIDATE_IDS = ["A", "B", "C"] as const;

function slotIdentity(slot: {
  case_id: string;
  candidate_id: string;
  repetition: number;
}): string {
  return `${slot.case_id}\u0000${slot.candidate_id}\u0000${slot.repetition}`;
}

function countBy<T extends string | number>(values: readonly T[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = String(value);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

describe("숨겨진 Benchmark의 결정적 72-slot 일정", () => {
  it("12개 사례 × 3개 후보 × 2회 반복을 중복 없는 72개 slot으로 만든다", () => {
    const schedule = buildBenchmarkSchedule(BENCHMARK_CASES, CANDIDATE_IDS);

    expect(schedule).toHaveLength(72);
    expect(new Set(schedule.map(slotIdentity))).toHaveLength(72);
    expect(countBy(schedule.map((slot) => slot.candidate_id))).toEqual({
      A: 24,
      B: 24,
      C: 24,
    });
    expect(countBy(schedule.map((slot) => slot.repetition))).toEqual({
      "1": 36,
      "2": 36,
    });
    expect(schedule.map((slot) => Number(slot.repetition))).not.toContain(3);
    expect(schedule.map((slot) => slot.case_id)).not.toContain("C-001");
  });

  it("사례별 후보 순서를 회전하고 두 번째 반복에서는 회전 방향을 반대로 적용한다", () => {
    const schedule = buildBenchmarkSchedule(BENCHMARK_CASES, CANDIDATE_IDS);
    const orderFor = (caseId: string, repetition: 1 | 2) => schedule
      .filter((slot) => slot.case_id === caseId && slot.repetition === repetition)
      .map((slot) => slot.candidate_id);

    expect(orderFor("H-001", 1)).toEqual(["A", "B", "C"]);
    expect(orderFor("H-002", 1)).toEqual(["B", "C", "A"]);
    expect(orderFor("H-003", 1)).toEqual(["C", "A", "B"]);
    expect(orderFor("H-001", 2)).toEqual(["A", "B", "C"]);
    expect(orderFor("H-002", 2)).toEqual(["C", "A", "B"]);
    expect(orderFor("H-003", 2)).toEqual(["B", "C", "A"]);

    const firstPositionCounts = countBy(
      schedule
        .filter((slot) => slot.candidate_position === 1)
        .map((slot) => slot.candidate_id),
    );
    const counts = Object.values(firstPositionCounts);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("동일 입력은 동일한 slot 순서와 canonical slot hash 기반 schedule_id를 만든다", () => {
    const first = buildBenchmarkSchedule(BENCHMARK_CASES, CANDIDATE_IDS);
    const second = buildBenchmarkSchedule(
      structuredClone(BENCHMARK_CASES),
      [...CANDIDATE_IDS],
    );

    expect(second).toEqual(first);
    expect(second.schedule_id).toBe(first.schedule_id);
    expect(first.schedule_id).toBe(sha256CanonicalJson([...first]));
  });

  it("중복 사례 ID나 중복 후보 ID를 거절한다", () => {
    const duplicateCases = structuredClone(BENCHMARK_CASES);
    duplicateCases[11] = { ...duplicateCases[11], case_id: duplicateCases[0].case_id };

    expect(() => buildBenchmarkSchedule(duplicateCases, CANDIDATE_IDS)).toThrow(
      /duplicate case ID/i,
    );
    expect(() => buildBenchmarkSchedule(BENCHMARK_CASES, ["A", "B", "A"])).toThrow(
      /duplicate candidate ID/i,
    );
  });

  it("잠긴 Challenge manifest와 다른 사례 ID 또는 순서를 거절한다", () => {
    const reversedCases = [...structuredClone(BENCHMARK_CASES)].reverse();
    const replacedCase = structuredClone(BENCHMARK_CASES);
    replacedCase[11] = { ...replacedCase[11], case_id: "H-999" };

    expect(() => buildBenchmarkSchedule(reversedCases, CANDIDATE_IDS)).toThrow(
      /case IDs must be ordered H-001 through H-012/i,
    );
    expect(() => buildBenchmarkSchedule(replacedCase, CANDIDATE_IDS)).toThrow(
      /case IDs must be ordered H-001 through H-012/i,
    );
  });

  it("잠긴 Challenge manifest와 다른 후보 순서나 유효하지 않은 ID를 거절한다", () => {
    const malformedCandidateIds = ["A", "B", "D"] as unknown as readonly BenchmarkCandidateId[];
    const malformedCase = structuredClone(BENCHMARK_CASES);
    malformedCase[11] = { ...malformedCase[11], case_id: "H-012\u0000" };

    expect(() => buildBenchmarkSchedule(BENCHMARK_CASES, ["B", "C", "A"])).toThrow(
      /candidate IDs must be ordered A, B, C/i,
    );
    expect(() => buildBenchmarkSchedule(BENCHMARK_CASES, malformedCandidateIds)).toThrow(
      /candidate IDs must be ordered A, B, C/i,
    );
    expect(() => buildBenchmarkSchedule(malformedCase, CANDIDATE_IDS)).toThrow(
      /case IDs must be ordered H-001 through H-012/i,
    );
  });

  it("호출 과정에서 사례와 후보 입력의 값이나 순서를 수정하지 않는다", () => {
    const cases = structuredClone(BENCHMARK_CASES);
    const candidateIds = [...CANDIDATE_IDS];
    const casesBefore = structuredClone(cases);
    const candidateIdsBefore = [...candidateIds];

    buildBenchmarkSchedule(cases, candidateIds);

    expect(cases).toEqual(casesBefore);
    expect(candidateIds).toEqual(candidateIdsBefore);
  });

  it("반환 배열, 각 slot, schedule_id를 변경할 수 없게 고정한다", () => {
    const schedule = buildBenchmarkSchedule(BENCHMARK_CASES, CANDIDATE_IDS);
    const descriptor = Object.getOwnPropertyDescriptor(schedule, "schedule_id");
    const originalScheduleId = schedule.schedule_id;

    expect(Object.isFrozen(schedule)).toBe(true);
    expect(schedule.every((slot) => Object.isFrozen(slot))).toBe(true);
    expect(descriptor).toMatchObject({
      value: originalScheduleId,
      writable: false,
      configurable: false,
    });
    expect(Reflect.set(schedule, "schedule_id", "tampered")).toBe(false);
    expect(schedule.schedule_id).toBe(originalScheduleId);
  });
});

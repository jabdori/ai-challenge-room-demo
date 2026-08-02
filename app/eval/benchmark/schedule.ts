import { sha256CanonicalJson } from "../runtime/canonicalJson";

export type BenchmarkCandidateId = "A" | "B" | "C";
export type BenchmarkRepetition = 1 | 2;

export interface BenchmarkScheduleCase {
  readonly case_id: string;
}

export interface BenchmarkScheduleSlot {
  readonly slot_id: string;
  readonly sequence: number;
  readonly case_id: string;
  readonly candidate_id: BenchmarkCandidateId;
  readonly repetition: BenchmarkRepetition;
  readonly candidate_position: 1 | 2 | 3;
}

export interface BenchmarkSchedule extends ReadonlyArray<BenchmarkScheduleSlot> {
  readonly schedule_id: string;
}

const LOCKED_CASE_COUNT = 12;
const LOCKED_CASE_IDS = Array.from(
  { length: LOCKED_CASE_COUNT },
  (_, index) => `H-${String(index + 1).padStart(3, "0")}`,
);
const LOCKED_CANDIDATE_IDS = ["A", "B", "C"] as const;
const REPETITIONS = [1, 2] as const;

function assertUniqueIds(ids: readonly string[], label: "case" | "candidate"): void {
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`duplicate ${label} ID is not allowed in a benchmark schedule.`);
  }
}

function assertLockedInputs(
  cases: readonly BenchmarkScheduleCase[],
  candidateIds: readonly BenchmarkCandidateId[],
): void {
  const caseIds = cases.map((item) => item.case_id);
  assertUniqueIds(caseIds, "case");
  assertUniqueIds(candidateIds, "candidate");

  if (cases.length !== LOCKED_CASE_COUNT) {
    throw new TypeError(`benchmark schedule requires exactly ${LOCKED_CASE_COUNT} cases.`);
  }
  if (caseIds.some((caseId, index) => caseId !== LOCKED_CASE_IDS[index])) {
    throw new TypeError("benchmark case IDs must be ordered H-001 through H-012.");
  }
  if (
    candidateIds.length !== LOCKED_CANDIDATE_IDS.length
    || candidateIds.some((candidateId, index) => candidateId !== LOCKED_CANDIDATE_IDS[index])
  ) {
    throw new TypeError("benchmark candidate IDs must be ordered A, B, C.");
  }
}

function rotationOffset(caseIndex: number, repetition: BenchmarkRepetition): number {
  const direction = repetition === 1 ? 1 : -1;
  return (
    (caseIndex * direction) % LOCKED_CANDIDATE_IDS.length
    + LOCKED_CANDIDATE_IDS.length
  ) % LOCKED_CANDIDATE_IDS.length;
}

export function buildBenchmarkSchedule(
  cases: readonly BenchmarkScheduleCase[],
  candidateIds: readonly BenchmarkCandidateId[],
): BenchmarkSchedule {
  assertLockedInputs(cases, candidateIds);

  const slots: BenchmarkScheduleSlot[] = [];
  for (const [caseIndex, evaluationCase] of cases.entries()) {
    for (const repetition of REPETITIONS) {
      const offset = rotationOffset(caseIndex, repetition);
      for (let positionIndex = 0; positionIndex < candidateIds.length; positionIndex += 1) {
        const candidateId = candidateIds[(positionIndex + offset) % candidateIds.length];
        const candidatePosition = (positionIndex + 1) as 1 | 2 | 3;
        slots.push(Object.freeze({
          slot_id: `${evaluationCase.case_id}--${candidateId}--r${repetition}`,
          sequence: slots.length + 1,
          case_id: evaluationCase.case_id,
          candidate_id: candidateId,
          repetition,
          candidate_position: candidatePosition,
        }));
      }
    }
  }

  const scheduleId = sha256CanonicalJson(slots);
  const schedule = slots as BenchmarkScheduleSlot[] & { readonly schedule_id: string };
  Object.defineProperty(schedule, "schedule_id", {
    value: scheduleId,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(schedule);
}

export const CANDIDATE_COMPLEXITY_IDS = ["A", "B", "C"] as const;

export type CandidateComplexityId = (typeof CANDIDATE_COMPLEXITY_IDS)[number];

/**
 * 가중 합계나 Tier가 아니라 각 축의 부분 순서(partial order)를 위한
 * 숨은 실행 전 권위 입력입니다.
 */
export interface CandidateComplexityProfile {
  readonly candidate_id: CandidateComplexityId;
  readonly model_call_stages: number;
  readonly retrieval_index_dependencies: number;
  readonly external_tools: number;
  readonly state_or_memory: 0 | 1;
  readonly candidate_failure_components: number;
  readonly dedicated_infrastructure: number;
}

export type CandidateComplexityProfiles = readonly [
  CandidateComplexityProfile,
  CandidateComplexityProfile,
  CandidateComplexityProfile,
];

const PROFILE_KEYS = [
  "candidate_id",
  "model_call_stages",
  "retrieval_index_dependencies",
  "external_tools",
  "state_or_memory",
  "candidate_failure_components",
  "dedicated_infrastructure",
] as const;

type JsonRecord = Record<string, unknown>;

function readRecord(value: unknown, location: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${location}은(는) plain complexity profile 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${location}은(는) plain complexity profile 객체여야 합니다.`);
  }
  return value as JsonRecord;
}

function assertExactKeys(record: JsonRecord, location: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...PROFILE_KEYS].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${location}의 exact complexity profile 계약이 다릅니다.`);
  }
}

function readInteger(
  value: unknown,
  location: string,
  minimum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
  ) {
    throw new TypeError(
      `${location}은(는) ${minimum} 이상의 safe integer여야 합니다.`,
    );
  }
  return value;
}

function freezeProfile(profile: CandidateComplexityProfile): CandidateComplexityProfile {
  return Object.freeze(profile);
}

export function parseCandidateComplexityProfiles(
  value: unknown,
  location = "candidate_complexity_profiles",
): CandidateComplexityProfiles {
  if (!Array.isArray(value) || value.length !== CANDIDATE_COMPLEXITY_IDS.length) {
    throw new TypeError(
      `${location}은(는) A/B/C 순서의 정확히 3개 complexity profile이어야 합니다.`,
    );
  }

  const profiles = value.map((item, index) => {
    const itemLocation = `${location}[${index}]`;
    const record = readRecord(item, itemLocation);
    assertExactKeys(record, itemLocation);
    const expectedCandidateId = CANDIDATE_COMPLEXITY_IDS[index];
    if (record.candidate_id !== expectedCandidateId) {
      throw new TypeError(
        `${itemLocation}.candidate_id는 A/B/C 잠긴 순서와 일치해야 합니다.`,
      );
    }
    const stateOrMemory = readInteger(
      record.state_or_memory,
      `${itemLocation}.state_or_memory`,
      0,
    );
    if (stateOrMemory !== 0 && stateOrMemory !== 1) {
      throw new TypeError(
        `${itemLocation}.state_or_memory는 사용 여부 0 또는 1이어야 합니다.`,
      );
    }
    return freezeProfile({
      candidate_id: expectedCandidateId,
      model_call_stages: readInteger(
        record.model_call_stages,
        `${itemLocation}.model_call_stages`,
        1,
      ),
      retrieval_index_dependencies: readInteger(
        record.retrieval_index_dependencies,
        `${itemLocation}.retrieval_index_dependencies`,
        0,
      ),
      external_tools: readInteger(
        record.external_tools,
        `${itemLocation}.external_tools`,
        0,
      ),
      state_or_memory: stateOrMemory,
      candidate_failure_components: readInteger(
        record.candidate_failure_components,
        `${itemLocation}.candidate_failure_components`,
        0,
      ),
      dedicated_infrastructure: readInteger(
        record.dedicated_infrastructure,
        `${itemLocation}.dedicated_infrastructure`,
        0,
      ),
    });
  });

  return Object.freeze(profiles) as unknown as CandidateComplexityProfiles;
}

export const P0_CANDIDATE_COMPLEXITY_PROFILES: CandidateComplexityProfiles =
  parseCandidateComplexityProfiles([
    {
      candidate_id: "A",
      model_call_stages: 1,
      retrieval_index_dependencies: 0,
      external_tools: 0,
      state_or_memory: 0,
      candidate_failure_components: 1,
      dedicated_infrastructure: 0,
    },
    {
      candidate_id: "B",
      model_call_stages: 1,
      retrieval_index_dependencies: 1,
      external_tools: 0,
      state_or_memory: 0,
      candidate_failure_components: 2,
      dedicated_infrastructure: 1,
    },
    {
      candidate_id: "C",
      model_call_stages: 2,
      retrieval_index_dependencies: 1,
      external_tools: 2,
      state_or_memory: 1,
      candidate_failure_components: 4,
      dedicated_infrastructure: 2,
    },
  ], "P0 candidate_complexity_profiles");

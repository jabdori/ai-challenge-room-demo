import { sha256CanonicalJson } from "../runtime/canonicalJson";
import {
  assertNoBlindJudgeIdentityLeak,
  BLIND_JUDGE_LABELS,
  type BlindJudgeLabel,
} from "./contracts";
import type { BlindJudgeBundle, BlindJudgeInput } from "./buildJudgeInput";

export const BENCHMARK_CANDIDATE_IDS = ["A", "B", "C"] as const;
export type BenchmarkJudgeCandidateId = (typeof BENCHMARK_CANDIDATE_IDS)[number];

export interface PrivateBlindMapping {
  schema_version: "private-blind-mapping-v1";
  case_id: string;
  blinding_seed: string;
  label_to_candidate: Record<BlindJudgeLabel, BenchmarkJudgeCandidateId>;
  private_mapping_hash: string;
}

const PERMUTATIONS: readonly (readonly BenchmarkJudgeCandidateId[])[] = [
  ["A", "B", "C"],
  ["A", "C", "B"],
  ["B", "A", "C"],
  ["B", "C", "A"],
  ["C", "A", "B"],
  ["C", "B", "A"],
] as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type JsonRecord = Record<string, unknown>;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function readRecord(value: unknown, location: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${location}은(는) JSON 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${location}은(는) plain JSON 객체여야 합니다.`);
  }
  return value as JsonRecord;
}

function assertExactKeys(
  record: JsonRecord,
  keys: readonly string[],
  location: string,
): void {
  const expected = new Set(keys);
  const missing = keys.filter((key) => !Object.hasOwn(record, key));
  const additional = Object.keys(record).filter((key) => !expected.has(key));
  if (missing.length > 0 || additional.length > 0) {
    throw new TypeError(
      `${location}의 exact key 계약이 다릅니다. missing=${missing.join(",")} additional=${additional.join(",")}`,
    );
  }
}

function assertHiddenCaseId(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !/^H-(?:00[1-9]|01[0-2])$/.test(value)) {
    throw new TypeError(`${location}는 잠긴 hidden 범위 H-001부터 H-012여야 합니다.`);
  }
}

function assertBlindingSeed(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || value.length < 32
    || /\p{Cc}/u.test(value)
  ) {
    throw new TypeError("blinding seed는 제어 문자가 없는 32자 이상의 비밀값이어야 합니다.");
  }
}

function mappingHashPayload(
  mapping: Omit<PrivateBlindMapping, "private_mapping_hash">,
): Omit<PrivateBlindMapping, "private_mapping_hash"> {
  return {
    schema_version: mapping.schema_version,
    case_id: mapping.case_id,
    blinding_seed: mapping.blinding_seed,
    label_to_candidate: {
      X: mapping.label_to_candidate.X,
      Y: mapping.label_to_candidate.Y,
      Z: mapping.label_to_candidate.Z,
    },
  };
}

export function buildPrivateBlindMapping({
  caseId,
  seed,
}: {
  caseId: string;
  seed: string;
}): PrivateBlindMapping {
  assertHiddenCaseId(caseId, "caseId");
  assertBlindingSeed(seed);

  const caseOrdinal = Number(caseId.slice(2));
  const seedOffset = Number.parseInt(sha256CanonicalJson({ seed }).slice(0, 8), 16)
    % PERMUTATIONS.length;
  // 연속 hidden case가 같은 순서를 공유하지 않도록 case ordinal을 순열 위치에 결합합니다.
  const permutation = PERMUTATIONS[(seedOffset + caseOrdinal - 1) % PERMUTATIONS.length];
  const payload: Omit<PrivateBlindMapping, "private_mapping_hash"> = {
    schema_version: "private-blind-mapping-v1",
    case_id: caseId,
    blinding_seed: seed,
    label_to_candidate: {
      X: permutation[0],
      Y: permutation[1],
      Z: permutation[2],
    },
  };
  return deepFreeze({
    ...payload,
    private_mapping_hash: sha256CanonicalJson(mappingHashPayload(payload)),
  });
}

export function validatePrivateBlindMapping(input: unknown): PrivateBlindMapping {
  const record = readRecord(input, "private blind mapping");
  assertExactKeys(record, [
    "schema_version",
    "case_id",
    "blinding_seed",
    "label_to_candidate",
    "private_mapping_hash",
  ], "private blind mapping");
  if (record.schema_version !== "private-blind-mapping-v1") {
    throw new TypeError("private blind mapping schema version이 다릅니다.");
  }
  assertHiddenCaseId(record.case_id, "private blind mapping.case_id");
  assertBlindingSeed(record.blinding_seed);

  const labelMap = readRecord(
    record.label_to_candidate,
    "private blind mapping.label_to_candidate",
  );
  assertExactKeys(labelMap, BLIND_JUDGE_LABELS, "private blind mapping.label_to_candidate");
  const candidateValues = BLIND_JUDGE_LABELS.map((label) => labelMap[label]);
  if (
    candidateValues.some((value) =>
      typeof value !== "string"
      || !BENCHMARK_CANDIDATE_IDS.includes(value as BenchmarkJudgeCandidateId)
    )
    || new Set(candidateValues).size !== BENCHMARK_CANDIDATE_IDS.length
  ) {
    throw new TypeError("private blind mapping은 A, B, C를 정확히 한 번씩 매핑해야 합니다.");
  }
  if (typeof record.private_mapping_hash !== "string" || !SHA256_PATTERN.test(record.private_mapping_hash)) {
    throw new TypeError("private blind mapping hash 형식이 올바르지 않습니다.");
  }
  const payload: Omit<PrivateBlindMapping, "private_mapping_hash"> = {
    schema_version: "private-blind-mapping-v1",
    case_id: record.case_id,
    blinding_seed: record.blinding_seed,
    label_to_candidate: {
      X: labelMap.X as BenchmarkJudgeCandidateId,
      Y: labelMap.Y as BenchmarkJudgeCandidateId,
      Z: labelMap.Z as BenchmarkJudgeCandidateId,
    },
  };
  const expectedHash = sha256CanonicalJson(mappingHashPayload(payload));
  if (expectedHash !== record.private_mapping_hash) {
    throw new TypeError("private blind mapping hash 무결성이 일치하지 않습니다.");
  }
  const expectedMapping = buildPrivateBlindMapping({
    caseId: record.case_id,
    seed: record.blinding_seed,
  });
  if (
    expectedMapping.private_mapping_hash !== expectedHash
    || BLIND_JUDGE_LABELS.some(
      (label) => expectedMapping.label_to_candidate[label] !== payload.label_to_candidate[label],
    )
  ) {
    throw new TypeError("private blind mapping이 seed와 case의 결정적 기대 순열과 다릅니다.");
  }
  return expectedMapping;
}

export function unblindBlindLabel({
  mapping,
  expectedCaseId,
  expectedMappingHash,
  blindLabel,
}: {
  mapping: PrivateBlindMapping;
  expectedCaseId: string;
  expectedMappingHash: string;
  blindLabel: BlindJudgeLabel;
}): BenchmarkJudgeCandidateId {
  assertHiddenCaseId(expectedCaseId, "expectedCaseId");
  if (!BLIND_JUDGE_LABELS.includes(blindLabel)) {
    throw new TypeError("blindLabel은 X, Y, Z 중 하나여야 합니다.");
  }
  if (!SHA256_PATTERN.test(expectedMappingHash)) {
    throw new TypeError("expectedMappingHash 형식이 올바르지 않습니다.");
  }
  const validated = validatePrivateBlindMapping(mapping);
  if (validated.case_id !== expectedCaseId) {
    throw new TypeError("private blind mapping case ID가 신뢰한 case와 다릅니다.");
  }
  if (validated.private_mapping_hash !== expectedMappingHash) {
    throw new TypeError("private blind mapping hash가 신뢰한 hash와 다릅니다.");
  }
  return validated.label_to_candidate[blindLabel];
}

/** 브라우저에는 private mapping을 전달하지 않고 익명 Judge 입력만 복제합니다. */
export function buildBlindBrowserProjection(bundle: BlindJudgeBundle): BlindJudgeInput {
  const projection = structuredClone(bundle.judge_input);
  assertNoBlindJudgeIdentityLeak(projection, "blind browser projection");
  const serialized = JSON.stringify(projection);
  if (/blinding_seed|private_mapping|label_to_candidate/i.test(serialized)) {
    throw new TypeError("blind browser projection에 private mapping이 포함됐습니다.");
  }
  return deepFreeze(projection);
}

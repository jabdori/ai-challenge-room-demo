import recordedProjectionFixture from "../data/demo/recorded-public-canary-projection-v1.json" with {
  type: "json",
};
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  assertRecordedSyntheticDemoProjectionPublicSafe,
  type RecordedSyntheticDemoProjection,
} from "./recordedSyntheticDemo";

export const RECORDED_SYNTHETIC_DEMO_PROJECTION_SHA256 =
  "fd497791fe50daf35d8f4dc48b2f7fdb81463c9f37dddea75cd783f126b94e15";
export const RECORDED_SYNTHETIC_DEMO_SOURCE_SHA256 =
  "d92a8eaaa7351027a50567fba503cdf67ca1c7c33d256d655f0a2b62a33883a3";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as JsonRecord)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function assertFixtureContract(
  value: JsonRecord,
): asserts value is JsonRecord & RecordedSyntheticDemoProjection {
  if (
    value.schema_version !== "recorded-synthetic-demo-projection-v1"
    || value.artifact_kind !== "RECORDED_SYNTHETIC_DEMO_PROJECTION"
    || value.synthetic !== true
  ) {
    throw new Error("recorded synthetic demo projection schema 무결성이 다릅니다.");
  }
  if (value.source !== "RECORDED_SYNTHETIC_DEMO") {
    throw new Error("recorded synthetic demo projection source 무결성이 다릅니다.");
  }
  if (value.source_hash !== RECORDED_SYNTHETIC_DEMO_SOURCE_SHA256) {
    throw new Error("recorded synthetic demo projection source hash 무결성이 다릅니다.");
  }

  const coverage = value.coverage;
  const candidates = value.candidates;
  const evidence = value.evidence;
  if (
    !isRecord(coverage)
    || coverage.candidates !== 3
    || coverage.runs_per_candidate !== 2
    || coverage.expected_runs !== 6
    || !Array.isArray(candidates)
    || candidates.length !== 3
    || !Array.isArray(evidence)
    || evidence.length !== 6
  ) {
    throw new Error("recorded synthetic demo projection coverage 무결성이 다릅니다.");
  }

  const expectedCandidateIds = ["A", "B", "C"] as const;
  candidates.forEach((candidate, index) => {
    if (
      !isRecord(candidate)
      || candidate.candidate_id !== expectedCandidateIds[index]
      || !Array.isArray(candidate.runs)
      || candidate.runs.length !== 2
      || candidate.runs.some((run, runIndex) => (
        !isRecord(run) || run.run_number !== runIndex + 1
      ))
    ) {
      throw new Error("recorded synthetic demo projection 실행 범위 무결성이 다릅니다.");
    }
  });
}

/**
 * 추적된 공개 projection을 canonical snapshot으로 만든 뒤 잠긴 출처와 hash를
 * 모두 검증합니다. 인자를 주는 형태는 변조·persistence 경계 테스트에 사용합니다.
 */
export function loadRecordedSyntheticDemoProjectionFixture(
  raw: unknown = recordedProjectionFixture,
): RecordedSyntheticDemoProjection {
  const snapshot = JSON.parse(canonicalJsonStringify(raw)) as unknown;
  if (!isRecord(snapshot)) {
    throw new TypeError("recorded synthetic demo projection은 객체여야 합니다.");
  }
  assertFixtureContract(snapshot);
  assertRecordedSyntheticDemoProjectionPublicSafe(snapshot);
  if (
    sha256CanonicalJson(snapshot)
    !== RECORDED_SYNTHETIC_DEMO_PROJECTION_SHA256
  ) {
    throw new Error("recorded synthetic demo projection canonical hash 무결성이 다릅니다.");
  }
  return deepFreeze(snapshot);
}

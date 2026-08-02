// @vitest-environment node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertRecordedSyntheticDemoProjectionPublicSafe,
} from "../demo/recordedSyntheticDemo";
import {
  loadRecordedSyntheticDemoProjectionFixture,
  RECORDED_SYNTHETIC_DEMO_PROJECTION_SHA256,
  RECORDED_SYNTHETIC_DEMO_SOURCE_SHA256,
} from "../demo/recordedSyntheticDemoProjectionFixture";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

const FIXTURE_URL = new URL(
  "../data/demo/recorded-public-canary-projection-v1.json",
  import.meta.url,
);
const LOCKED_PROJECTION_SHA256 =
  "fd497791fe50daf35d8f4dc48b2f7fdb81463c9f37dddea75cd783f126b94e15";
const LOCKED_SOURCE_SHA256 =
  "d92a8eaaa7351027a50567fba503cdf67ca1c7c33d256d655f0a2b62a33883a3";

async function readFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(FIXTURE_URL, "utf8")) as Record<string, unknown>;
}

function cloneFixture(
  fixture: Record<string, unknown>,
): Record<string, unknown> {
  return structuredClone(fixture);
}

describe("추적되는 recorded synthetic demo 공개 projection fixture", () => {
  it("ignored runtime 밖의 Git 추적 가능 source 경로에 고정되어 있다", async () => {
    await expect(readFile(FIXTURE_URL, "utf8")).resolves.toBeTypeOf("string");

    const result = spawnSync(
      "git",
      ["check-ignore", "--quiet", fileURLToPath(FIXTURE_URL)],
      { cwd: fileURLToPath(new URL("../../..", import.meta.url)) },
    );
    expect(result.status).toBe(1);
  });

  it("잠긴 schema·source와 후보 A/B/C별 두 실행을 로드한다", async () => {
    const projection = loadRecordedSyntheticDemoProjectionFixture(
      await readFixture(),
    );

    expect(projection).toMatchObject({
      schema_version: "recorded-synthetic-demo-projection-v1",
      source: "RECORDED_SYNTHETIC_DEMO",
      coverage: {
        candidates: 3,
        runs_per_candidate: 2,
        expected_runs: 6,
      },
    });
    expect(projection.candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      run_numbers: candidate.runs.map((run) => run.run_number),
    }))).toEqual([
      { candidate_id: "A", run_numbers: [1, 2] },
      { candidate_id: "B", run_numbers: [1, 2] },
      { candidate_id: "C", run_numbers: [1, 2] },
    ]);
  });

  it("공개 projection에 원격 resource·provider 응답 ID와 API key 형태가 없다", async () => {
    const serialized = JSON.stringify(
      loadRecordedSyntheticDemoProjectionFixture(await readFixture()),
    );

    expect(serialized).not.toMatch(
      /vectorStoreId|vector_store_id|uploadedFileId|file_id|response_id/i,
    );
    expect(serialized).not.toMatch(
      /\b(?:sk-[A-Za-z0-9_-]{20,}|vs_[A-Za-z0-9_-]{8,}|file-[A-Za-z0-9_-]{8,}|resp_[A-Za-z0-9_-]{8,})\b/,
    );
  });

  it("canonical projection hash와 canonical source hash를 잠근다", async () => {
    const fixture = await readFixture();
    const projection = loadRecordedSyntheticDemoProjectionFixture(fixture);

    expect(RECORDED_SYNTHETIC_DEMO_PROJECTION_SHA256)
      .toBe(LOCKED_PROJECTION_SHA256);
    expect(sha256CanonicalJson(projection)).toBe(LOCKED_PROJECTION_SHA256);
    expect(RECORDED_SYNTHETIC_DEMO_SOURCE_SHA256).toBe(LOCKED_SOURCE_SHA256);
    expect(projection.source_hash).toBe(LOCKED_SOURCE_SHA256);
  });

  it.each([
    ["schema", (fixture: Record<string, unknown>) => {
      fixture.schema_version = "recorded-synthetic-demo-projection-v2";
    }],
    ["source", (fixture: Record<string, unknown>) => {
      fixture.source = "LIVE_SYNTHETIC_DEMO";
    }],
  ])("변조된 %s를 fail-closed로 거부한다", async (_label, mutate) => {
    const fixture = cloneFixture(await readFixture());
    mutate(fixture);

    expect(() => loadRecordedSyntheticDemoProjectionFixture(fixture)).toThrow(
      /무결성|schema|source|hash/i,
    );
  });

  it.each([
    ["비용", (fixture: Record<string, unknown>) => {
      fixture.total_runtime_cost_usd =
        Number(fixture.total_runtime_cost_usd) + 0.001;
    }],
    ["출력", (fixture: Record<string, unknown>) => {
      const evidence = fixture.evidence as Array<{
        output: { customer_reply: string };
      }>;
      evidence[0].output.customer_reply += " 변조";
    }],
    ["source hash", (fixture: Record<string, unknown>) => {
      fixture.source_hash = "0".repeat(64);
    }],
  ])("변조된 %s을(를) canonical hash로 거부한다", async (_label, mutate) => {
    const fixture = cloneFixture(await readFixture());
    mutate(fixture);

    expect(() => loadRecordedSyntheticDemoProjectionFixture(fixture)).toThrow(
      /무결성|hash/i,
    );
  });

  it.each([
    "vectorStoreId",
    "vector_store_id",
    "uploadedFileId",
    "file_id",
    "response_id",
    "provider_id",
    "api_key",
  ])("생성된 projection safety validator가 공개 금지 키 %s를 거부한다", async (key) => {
    const fixture = cloneFixture(await readFixture());
    fixture[key] = "redacted-test-value";

    expect(() => {
      assertRecordedSyntheticDemoProjectionPublicSafe(fixture);
    }).toThrow(/공개|허용되지 않습니다/i);
  });

  it.each([
    ["vector store ID", ["v", "s_", "a".repeat(16)].join("")],
    ["file ID", ["fi", "le-", "a".repeat(16)].join("")],
    ["provider response ID", ["re", "sp_", "a".repeat(16)].join("")],
    ["API key", ["s", "k-", "a".repeat(24)].join("")],
  ])("생성된 projection safety validator가 %s 형태 값을 거부한다", async (
    _label,
    remoteValue,
  ) => {
    const fixture = cloneFixture(await readFixture());
    fixture.pack_id = remoteValue;

    expect(() => {
      assertRecordedSyntheticDemoProjectionPublicSafe(fixture);
    }).toThrow(/공개|원격 resource/i);
  });

  it("문자열 중간에 prefixed된 fake API secret도 거부한다", async () => {
    const fixture = cloneFixture(await readFixture());
    fixture.pack_id = ["x", "s", "k-", "a".repeat(24)].join("");

    expect(() => {
      assertRecordedSyntheticDemoProjectionPublicSafe(fixture);
    }).toThrow(/공개|원격 resource/i);
  });

  it("일반 상태 문구 file-not-found는 원격 file ID로 오인하지 않는다", async () => {
    const fixture = cloneFixture(await readFixture());
    fixture.pack_id = "file-not-found";

    expect(() => {
      assertRecordedSyntheticDemoProjectionPublicSafe(fixture);
    }).not.toThrow();
  });
});

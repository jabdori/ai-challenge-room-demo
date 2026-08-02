// @vitest-environment node

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const cleanupFailure = vi.hoisted(() => ({ next: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: vi.fn(async (path: Parameters<typeof actual.unlink>[0]) => {
      if (cleanupFailure.next) {
        cleanupFailure.next = false;
        throw Object.assign(new Error("injected temporary cleanup failure"), {
          code: "EACCES",
        });
      }
      return actual.unlink(path);
    }),
  };
});

import { mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import type { PartialEvaluationPack } from "../pack/evaluationPack";
import { persistPartialEvaluationPack } from "../pack/persistence";

function createPack(): PartialEvaluationPack {
  return {
    schema_version: "1.1",
    artifact_kind: "PARTIAL_EVALUATION_PACK",
    source: "CALIBRATION_SMOKE",
    evaluation_status: "EVALUATION_INCOMPLETE",
    pack_id: "calibration-smoke-0123456789abcdef",
    created_at: "2026-07-17T00:00:00.000Z",
    pricing_as_of: "2026-07-17",
    runs: [],
  } as unknown as PartialEvaluationPack;
}

describe("부분 Evaluation Pack 임시 파일 정리 경계", () => {
  it("목적 파일 hard-link 커밋 뒤 임시 파일 정리 실패는 성공으로 숨기지 않고 재실행으로 수렴한다", async () => {
    const directory = await realpath(await mkdtemp(
      join(tmpdir(), "evaluation-pack-cleanup-"),
    ));
    cleanupFailure.next = true;

    await expect(persistPartialEvaluationPack(createPack(), directory))
      .rejects.toThrow(/temporary cleanup failure/i);
    const filePath = await persistPartialEvaluationPack(createPack(), directory);

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(createPack());
    const temporaryFiles = (await readdir(directory)).filter((entry) => entry.includes(".tmp-"));
    expect(temporaryFiles).toEqual([]);
  });
});

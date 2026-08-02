// @vitest-environment node

import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PartialEvaluationPack } from "../pack/evaluationPack";
import { persistPartialEvaluationPack } from "../pack/persistence";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

function createPack(overrides: Record<string, unknown> = {}): PartialEvaluationPack {
  return {
    schema_version: "1.1",
    artifact_kind: "PARTIAL_EVALUATION_PACK",
    source: "CALIBRATION_SMOKE",
    evaluation_status: "EVALUATION_INCOMPLETE",
    pack_id: "calibration-smoke-0123456789abcdef",
    created_at: "2026-07-17T00:00:00.000Z",
    pricing_as_of: "2026-07-17",
    runs: [],
    ...overrides,
  } as unknown as PartialEvaluationPack;
}

async function temporaryEntries(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => entry.includes(".tmp-"));
}

describe("부분 Evaluation Pack 저장", () => {
  it("canonical pack 전체 SHA-256을 파일명에 넣어 0600 JSON으로 저장한다", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "evaluation-pack-")));
    const pack = createPack();
    const digest = sha256CanonicalJson(pack);

    const filePath = await persistPartialEvaluationPack(pack, directory);

    expect(filePath).toBe(join(
      directory,
      `calibration-smoke-0123456789abcdef--record-${digest}.json`,
    ));
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    const storedBytes = await readFile(filePath);
    expect(JSON.parse(storedBytes.toString("utf8"))).toEqual(pack);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await temporaryEntries(directory)).toEqual([]);
  });

  it("가변 getter가 있어도 파일명 digest는 저장된 canonical JSON digest와 일치한다", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "evaluation-pack-")));
    const pack = createPack();
    let createdAtReads = 0;
    Object.defineProperty(pack, "created_at", {
      enumerable: true,
      configurable: true,
      get: () => {
        createdAtReads += 1;
        return `2026-07-17T00:00:0${createdAtReads}.000Z`;
      },
    });

    const filePath = await persistPartialEvaluationPack(pack, directory);
    const storedPack = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    const filenameDigest = basename(filePath).match(/--record-([a-f0-9]{64})\.json$/)?.[1];

    expect(filenameDigest).toBe(sha256CanonicalJson(storedPack));
    expect(createdAtReads).toBe(1);
  });

  it("같은 pack 재저장은 기존 바이트와 수정시각을 바꾸지 않고 같은 경로를 반환한다", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "evaluation-pack-")));
    const pack = createPack();
    const firstPath = await persistPartialEvaluationPack(pack, directory);
    const fixedTime = new Date("2020-01-02T03:04:05.000Z");
    await utimes(firstPath, fixedTime, fixedTime);
    const beforeBytes = await readFile(firstPath);
    const beforeStat = await stat(firstPath, { bigint: true });

    const secondPath = await persistPartialEvaluationPack(pack, directory);

    const afterBytes = await readFile(firstPath);
    const afterStat = await stat(firstPath, { bigint: true });
    expect(secondPath).toBe(firstPath);
    expect(afterBytes).toEqual(beforeBytes);
    expect(afterStat.mtimeNs).toBe(beforeStat.mtimeNs);
    expect(await temporaryEntries(directory)).toEqual([]);
  });

  it("같은 canonical 내용의 기존 JSON 바이트도 그대로 보존한다", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "evaluation-pack-")));
    const pack = createPack();
    const filePath = join(
      directory,
      `${pack.pack_id}--record-${sha256CanonicalJson(pack)}.json`,
    );
    const existingBytes = Buffer.from(JSON.stringify(pack), "utf8");
    await writeFile(filePath, existingBytes, { flag: "wx", mode: 0o600 });
    const fixedTime = new Date("2020-01-02T03:04:05.000Z");
    await utimes(filePath, fixedTime, fixedTime);
    const beforeStat = await stat(filePath, { bigint: true });

    const persistedPath = await persistPartialEvaluationPack(pack, directory);

    expect(persistedPath).toBe(filePath);
    expect(await readFile(filePath)).toEqual(existingBytes);
    expect((await stat(filePath, { bigint: true })).mtimeNs).toBe(beforeStat.mtimeNs);
    expect(await temporaryEntries(directory)).toEqual([]);
  });

  it("같은 pack을 동시에 저장하면 완성된 JSON 하나와 같은 경로만 반환한다", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "evaluation-pack-")));
    const pack = createPack();

    const [firstPath, secondPath] = await Promise.all([
      persistPartialEvaluationPack(pack, directory),
      persistPartialEvaluationPack(pack, directory),
    ]);

    expect(secondPath).toBe(firstPath);
    const entries = await readdir(directory);
    expect(entries.filter((entry) => entry.endsWith(".json"))).toEqual([basename(firstPath)]);
    expect(JSON.parse(await readFile(firstPath, "utf8"))).toEqual(pack);
    expect(await temporaryEntries(directory)).toEqual([]);
  });

  it("같은 구성의 별도 실행 기록을 덮어쓰지 않는다", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "evaluation-pack-")));

    const first = await persistPartialEvaluationPack(createPack({
      pricing_as_of: "2026-07-17",
    }), directory);
    const second = await persistPartialEvaluationPack(createPack({
      pricing_as_of: "2026-07-18",
    }), directory);

    expect(second).not.toBe(first);
    expect(JSON.parse(await readFile(first, "utf8")).pricing_as_of).toBe("2026-07-17");
    expect(JSON.parse(await readFile(second, "utf8")).pricing_as_of).toBe("2026-07-18");
  });

  it("같은 digest 목적지의 내용이 다르면 기존 바이트를 보존하고 명시적으로 거부한다", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "evaluation-pack-")));
    const pack = createPack();
    const filePath = join(
      directory,
      `${pack.pack_id}--record-${sha256CanonicalJson(pack)}.json`,
    );
    const conflictingBytes = Buffer.from('{"tampered":true}\n', "utf8");
    await writeFile(filePath, conflictingBytes, { flag: "wx", mode: 0o600 });
    const fixedTime = new Date("2020-01-02T03:04:05.000Z");
    await utimes(filePath, fixedTime, fixedTime);
    const beforeStat = await stat(filePath, { bigint: true });

    await expect(persistPartialEvaluationPack(pack, directory)).rejects.toThrow(
      "같은 digest 경로의 기존 Evaluation Pack 내용이 일치하지 않습니다.",
    );

    expect(await readFile(filePath)).toEqual(conflictingBytes);
    expect((await stat(filePath, { bigint: true })).mtimeNs).toBe(beforeStat.mtimeNs);
    expect(await temporaryEntries(directory)).toEqual([]);
  });

  it("다른 artifact 종류는 저장하지 않는다", async () => {
    const directory = await mkdtemp(join(tmpdir(), "evaluation-pack-"));
    const invalid = {
      artifact_kind: "RECORDED_BENCHMARK",
      source: "RECORDED_BENCHMARK",
      pack_id: "forged",
    } as unknown as PartialEvaluationPack;

    await expect(persistPartialEvaluationPack(invalid, directory)).rejects.toThrow(
      "Calibration smoke 저장기는 부분 평가팩만 저장할 수 있습니다.",
    );
  });
});

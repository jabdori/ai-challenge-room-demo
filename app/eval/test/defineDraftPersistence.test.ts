// @vitest-environment node

import {
  link,
  lstat,
  mkdtemp,
  readFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPersistedDefineDraftPack,
  buildDefineDraftPack,
  loadDefineDraftPack,
  persistDefineDraftPack,
} from "../define/defineDraftPersistence";
import {
  buildDefineStructuringArtifact,
  loadDefineStructuringArtifact,
  persistDefineStructuringArtifact,
} from "../define/defineStructuringPersistence";
import type {
  DefineAdapter,
  DefineAdapterResult,
} from "../define/openaiDefineAdapter";
import { runDefineStructuring } from "../define/runDefineStructuring";
import {
  SYNTHETIC_CHALLENGE_TEMPLATE,
} from "../define/syntheticChallengeDefinition";
import { canonicalJsonStringify } from "../runtime/canonicalJson";

function completedResult(
  limitations: readonly string[] =
    SYNTHETIC_CHALLENGE_TEMPLATE.advisorySuggestion.limitations,
): DefineAdapterResult {
  return {
    responseId: "resp-define-draft-test",
    responseStatusCode: 200,
    status: "completed",
    modelReportedId: "gpt-5.6-sol",
    serviceTierReported: "default",
    outputText: JSON.stringify({
      ...SYNTHETIC_CHALLENGE_TEMPLATE.advisorySuggestion,
      limitations: [...limitations],
    }),
    usage: {
      inputTokens: 200,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 40,
      totalTokens: 300,
    },
    error: null,
  };
}

async function secureRoot(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function persistedStructuringArtifact(
  outputDirectory: string,
  limitations?: readonly string[],
) {
  const adapter: DefineAdapter = {
    invoke: async () => completedResult(limitations),
  };
  let nowValue = Date.parse("2026-07-17T00:00:00.000Z");
  const run = await runDefineStructuring({
    adapter,
    input: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
    now: () => {
      const current = nowValue;
      nowValue += 10;
      return current;
    },
  });
  const artifact = buildDefineStructuringArtifact({
    input: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
    run,
  });
  const persisted = await persistDefineStructuringArtifact({
    outputDirectory,
    artifact,
  });
  return loadDefineStructuringArtifact({
    outputDirectory,
    artifactPath: persisted.path,
    expectedInput: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
  });
}

describe("Define Draft Pack persistence", () => {
  it("source-reload한 advisory 증거만 공개 안전한 DEFINE_DRAFT_PACK으로 만들고 0600 write-once 저장한다", async () => {
    const outputDirectory = await secureRoot("define-draft-pack-");
    const source = await persistedStructuringArtifact(outputDirectory);
    const pack = buildDefineDraftPack({ source });

    const persisted = await persistDefineDraftPack({
      outputDirectory,
      pack,
      source,
    });
    const reloaded = await loadDefineDraftPack({
      outputDirectory,
      path: persisted.path,
      source,
    });

    expect(pack).toMatchObject({
      artifact_kind: "DEFINE_DRAFT_PACK",
      state: "DRAFT",
      authority: "ADVISORY_ONLY",
      human_approval_status: "REQUIRED",
      evaluation_status: "EVALUATION_INCOMPLETE",
      baseline_version: null,
    });
    expect(pack).not.toHaveProperty("run_record");
    expect(pack).not.toHaveProperty("attempts");
    expect(pack).not.toHaveProperty("usage");
    expect(pack).not.toHaveProperty("responseId");
    expect(persisted.created).toBe(true);
    expect((await lstat(persisted.path)).mode & 0o777).toBe(0o600);
    expect((await lstat(persisted.path)).nlink).toBe(1);
    const bytes = await readFile(persisted.path, "utf8");
    expect(bytes).toBe(`${canonicalJsonStringify(JSON.parse(bytes))}\n`);
    expect(reloaded).toEqual(pack);
    expect(reloaded).not.toBe(pack);
    expect(() => assertPersistedDefineDraftPack(pack)).toThrow(/source|reload|persist|저장/i);
    expect(() => assertPersistedDefineDraftPack(reloaded)).not.toThrow();
  });

  it("동일 Define input에서 서로 다른 draft fork를 거부하고 같은 draft replay만 허용한다", async () => {
    const outputDirectory = await secureRoot("define-draft-fork-");
    const firstSource = await persistedStructuringArtifact(outputDirectory);
    const firstPack = buildDefineDraftPack({ source: firstSource });
    const first = await persistDefineDraftPack({
      outputDirectory,
      pack: firstPack,
      source: firstSource,
    });
    const replay = await persistDefineDraftPack({
      outputDirectory,
      pack: structuredClone(firstPack),
      source: firstSource,
    });

    const secondSource = await persistedStructuringArtifact(outputDirectory, [
      ...SYNTHETIC_CHALLENGE_TEMPLATE.advisorySuggestion.limitations,
      "A second advisory draft must not fork the same Define input.",
    ]);
    const secondPack = buildDefineDraftPack({ source: secondSource });

    expect(replay).toEqual({ ...first, created: false });
    await expect(persistDefineDraftPack({
      outputDirectory,
      pack: secondPack,
      source: secondSource,
    })).rejects.toThrow(/fork|claim|기존|다른 draft/i);
  });

  it("외부 hard-link가 생긴 draft는 source reload에서 거부한다", async () => {
    const outputDirectory = await secureRoot("define-draft-hardlink-");
    const source = await persistedStructuringArtifact(outputDirectory);
    const pack = buildDefineDraftPack({ source });
    const persisted = await persistDefineDraftPack({
      outputDirectory,
      pack,
      source,
    });
    await link(
      persisted.path,
      join(outputDirectory, "attacker-mutable-define-draft.json"),
    );

    await expect(loadDefineDraftPack({
      outputDirectory,
      path: persisted.path,
      source,
    })).rejects.toThrow(/hard|link|nlink|불변/i);
  });

  it("self-consistent하게 hash를 다시 계산한 plain Draft도 upstream source와 다르면 선점할 수 없다", async () => {
    const outputDirectory = await secureRoot("define-draft-upstream-");
    const source = await persistedStructuringArtifact(outputDirectory);
    const pack = buildDefineDraftPack({ source });
    const forgedPayload = {
      ...structuredClone(pack),
      source_artifact_hash: "f".repeat(64),
    };
    const { draft_hash: _oldHash, ...payload } = forgedPayload;
    const forged = {
      ...payload,
      draft_hash: (
        await import("../runtime/canonicalJson")
      ).sha256CanonicalJson(payload),
    };

    await expect(persistDefineDraftPack({
      outputDirectory,
      pack: forged,
      source,
    })).rejects.toThrow(/source|upstream|재빌드|원본|artifact/i);
  });
});

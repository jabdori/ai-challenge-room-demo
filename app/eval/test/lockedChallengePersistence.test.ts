// @vitest-environment node

import { realpathSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir as systemTmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAuthoritativeLockedChallengePack,
  createLockedChallengePack,
} from "../define/defineContracts";
import {
  createLockedChallengeAuthorityPaths,
  loadLockedChallengeAuthorityRecord,
  persistLockedChallengeAuthorityRecord,
} from "../define/lockedChallengePersistence";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  createLockedChallengeFixtureBundle,
} from "./helpers/lockedChallengeFixture";

const tmpdir = () => realpathSync(systemTmpdir());

describe("Locked Challenge 권위 아티팩트 persistence", () => {
  it("실제 Define source와 인간 승인 bundle을 canonical 0600 write-once로 저장하고 권위 pack을 복원한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "locked-challenge-"));
    const fixture = createLockedChallengeFixtureBundle();

    const persisted = await persistLockedChallengeAuthorityRecord({
      outputDirectory,
      creationInput: fixture.creationInput,
      pack: fixture.pack,
    });
    const loaded = await loadLockedChallengeAuthorityRecord({
      outputDirectory,
      challengeId: fixture.pack.challenge_id,
      challengeVersion: fixture.pack.challenge_version,
    });
    const paths = createLockedChallengeAuthorityPaths({
      outputDirectory,
      challengeId: fixture.pack.challenge_id,
      challengeVersion: fixture.pack.challenge_version,
      lockedChallengePackHash: fixture.pack.locked_challenge_pack_hash,
    });

    expect(persisted.path).toBe(paths.recordPath);
    expect((await lstat(paths.claimPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.recordPath)).mode & 0o777).toBe(0o600);
    expect(() => assertAuthoritativeLockedChallengePack(loaded.pack)).not.toThrow();
    expect(loaded.pack).toEqual(fixture.pack);
    const text = await readFile(paths.recordPath, "utf8");
    expect(text).toBe(`${canonicalJsonStringify(JSON.parse(text))}\n`);
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{12,}|H-00[1-9]|oracle/i);
    expect((await readdir(paths.challengeDirectory)).filter((name) => name.includes(".tmp-")))
      .toEqual([]);
  });

  it("clone·fabricated pack은 권위 claim을 선점하지 못한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "locked-challenge-clone-"));
    const fixture = createLockedChallengeFixtureBundle();

    await expect(persistLockedChallengeAuthorityRecord({
      outputDirectory,
      creationInput: fixture.creationInput,
      pack: structuredClone(fixture.pack),
    })).rejects.toThrow(/authoritative|build|source|인간 승인|권위/i);
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  it("가변 getter가 source 검증 뒤 approval을 바꾸는 TOCTOU 입력을 거부한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "locked-challenge-accessor-"));
    const fixture = createLockedChallengeFixtureBundle();
    const creationInput = {
      defineInput: fixture.creationInput.defineInput,
      defineSuggestion: fixture.creationInput.defineSuggestion,
    } as Record<string, unknown>;
    Object.defineProperty(creationInput, "approval", {
      enumerable: true,
      configurable: true,
      get: () => fixture.creationInput.approval,
    });

    await expect(persistLockedChallengeAuthorityRecord({
      outputDirectory,
      creationInput: creationInput as unknown as typeof fixture.creationInput,
      pack: fixture.pack,
    })).rejects.toThrow(/accessor|getter|data property|plain data|TOCTOU|속성/i);
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  it("__proto__ own data property를 숨긴 creation input도 authority claim 전에 거부한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "locked-challenge-proto-"));
    const fixture = createLockedChallengeFixtureBundle();
    const creationInput = structuredClone(fixture.creationInput) as typeof fixture.creationInput
      & Record<string, unknown>;
    Object.defineProperty(creationInput, "__proto__", {
      value: null,
      enumerable: true,
      configurable: true,
      writable: true,
    });

    await expect(persistLockedChallengeAuthorityRecord({
      outputDirectory,
      creationInput,
      pack: fixture.pack,
    })).rejects.toThrow(/exact|additional|field|필드|__proto__/i);
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  it("secret 형태 accessor key를 거부하면서 persistence 오류에 원문을 남기지 않는다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "locked-challenge-secret-key-"));
    const fixture = createLockedChallengeFixtureBundle();
    const creationInput = structuredClone(fixture.creationInput) as typeof fixture.creationInput
      & Record<string, unknown>;
    const secretKey = ["sk", "locked-accessor-key-secret-1234567890"].join("-");
    Object.defineProperty(creationInput, secretKey, {
      enumerable: true,
      configurable: true,
      get: () => "synthetic",
    });

    let failure: unknown;
    try {
      await persistLockedChallengeAuthorityRecord({
        outputDirectory,
        creationInput,
        pack: fixture.pack,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(secretKey);
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  it("oversized creation input 배열은 authority snapshot 단계에서 거부한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "locked-challenge-oversized-"));
    const fixture = createLockedChallengeFixtureBundle();
    const creationInput = structuredClone(fixture.creationInput);
    creationInput.defineInput.business_brief.intended_users = Array.from(
      { length: 257 },
      (_, index) => `Synthetic user ${index}`,
    );

    await expect(persistLockedChallengeAuthorityRecord({
      outputDirectory,
      creationInput,
      pack: fixture.pack,
    })).rejects.toThrow(/array|length|limit|maximum|256|배열|길이|상한/i);
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  it("같은 challenge version의 다른 승인 계약은 첫 claim 이후 거부한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "locked-challenge-conflict-"));
    const first = createLockedChallengeFixtureBundle();
    const changedInput = structuredClone(first.creationInput);
    changedInput.approval.approved_contract.sufficiency.mean_runtime_cost_usd.maximum = 0.06;
    const changedPack = createLockedChallengePack(changedInput);

    await persistLockedChallengeAuthorityRecord({
      outputDirectory,
      creationInput: first.creationInput,
      pack: first.pack,
    });
    await expect(persistLockedChallengeAuthorityRecord({
      outputDirectory,
      creationInput: changedInput,
      pack: changedPack,
    })).rejects.toThrow(/claim|different|다른|challenge|일치/i);
  });

  it("challenge 디렉터리 symlink와 mode 변조 record를 load하지 않는다", async () => {
    const fixture = createLockedChallengeFixtureBundle();
    const symlinkRoot = await mkdtemp(join(tmpdir(), "locked-challenge-symlink-"));
    const external = await mkdtemp(join(tmpdir(), "locked-challenge-external-"));
    const paths = createLockedChallengeAuthorityPaths({
      outputDirectory: symlinkRoot,
      challengeId: fixture.pack.challenge_id,
      challengeVersion: fixture.pack.challenge_version,
      lockedChallengePackHash: fixture.pack.locked_challenge_pack_hash,
    });
    await mkdir(symlinkRoot, { recursive: true });
    await symlink(external, paths.challengeDirectory);
    await expect(persistLockedChallengeAuthorityRecord({
      outputDirectory: symlinkRoot,
      creationInput: fixture.creationInput,
      pack: fixture.pack,
    })).rejects.toThrow(/symlink|directory|디렉터리|안전/i);

    const modeRoot = await mkdtemp(join(tmpdir(), "locked-challenge-mode-"));
    const stored = await persistLockedChallengeAuthorityRecord({
      outputDirectory: modeRoot,
      creationInput: fixture.creationInput,
      pack: fixture.pack,
    });
    await chmod(stored.path, 0o644);
    await expect(loadLockedChallengeAuthorityRecord({
      outputDirectory: modeRoot,
      challengeId: fixture.pack.challenge_id,
      challengeVersion: fixture.pack.challenge_version,
    })).rejects.toThrow(/0600|mode|권한|record|안전/i);
  });

  it.each([
    ["claim", "claimPath"],
    ["record", "recordPath"],
  ] as const)("외부 hard-link가 생긴 %s authority inode는 load하지 않는다", async (
    _label,
    pathKey,
  ) => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "locked-challenge-hardlink-"),
    );
    const fixture = createLockedChallengeFixtureBundle();
    await persistLockedChallengeAuthorityRecord({
      outputDirectory,
      creationInput: fixture.creationInput,
      pack: fixture.pack,
    });
    const paths = createLockedChallengeAuthorityPaths({
      outputDirectory,
      challengeId: fixture.pack.challenge_id,
      challengeVersion: fixture.pack.challenge_version,
      lockedChallengePackHash: fixture.pack.locked_challenge_pack_hash,
    });
    await link(
      paths[pathKey],
      join(outputDirectory, `external-${pathKey}.json`),
    );

    await expect(loadLockedChallengeAuthorityRecord({
      outputDirectory,
      challengeId: fixture.pack.challenge_id,
      challengeVersion: fixture.pack.challenge_version,
    })).rejects.toThrow(/link|nlink|hard|inode|불변/i);
  });

  it("authority root symlink를 따라 외부 위치에 claim을 기록하지 않는다", async () => {
    const fixture = createLockedChallengeFixtureBundle();
    const parent = await mkdtemp(join(tmpdir(), "locked-challenge-root-parent-"));
    const external = await mkdtemp(join(tmpdir(), "locked-challenge-root-external-"));
    const outputDirectory = join(parent, "authority-root");
    await symlink(external, outputDirectory);

    await expect(persistLockedChallengeAuthorityRecord({
      outputDirectory,
      creationInput: fixture.creationInput,
      pack: fixture.pack,
    })).rejects.toThrow(/symlink|directory|디렉터리|안전/i);
    expect(await readdir(external)).toEqual([]);
  });

  it("record의 Define source hash를 다시 포장해도 load 시 실제 source와 재검증한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "locked-challenge-source-tamper-"));
    const fixture = createLockedChallengeFixtureBundle();
    await persistLockedChallengeAuthorityRecord({
      outputDirectory,
      creationInput: fixture.creationInput,
      pack: fixture.pack,
    });
    const paths = createLockedChallengeAuthorityPaths({
      outputDirectory,
      challengeId: fixture.pack.challenge_id,
      challengeVersion: fixture.pack.challenge_version,
      lockedChallengePackHash: fixture.pack.locked_challenge_pack_hash,
    });
    const wrapper = JSON.parse(await readFile(paths.recordPath, "utf8")) as {
      payload_sha256: string;
      payload: {
        creation_input: {
          approval: { define_input_hash: string };
        };
      };
    };
    wrapper.payload.creation_input.approval.define_input_hash = "0".repeat(64);
    wrapper.payload_sha256 = sha256CanonicalJson(wrapper.payload);
    await writeFile(
      paths.recordPath,
      `${canonicalJsonStringify(wrapper)}\n`,
      { mode: 0o600 },
    );

    await expect(loadLockedChallengeAuthorityRecord({
      outputDirectory,
      challengeId: fixture.pack.challenge_id,
      challengeVersion: fixture.pack.challenge_version,
    })).rejects.toThrow(/source|hash|input|suggestion|claim|무결성|일치/i);
  });
});

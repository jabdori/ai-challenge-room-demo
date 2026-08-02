// @vitest-environment node

import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  buildJudgeEvidencePrecommitManifest,
} from "../review/judgeEvidenceManifest";
import {
  assertAuthoritativeBlindingPrecommit,
  createTestAuthoritativeBlindingPrecommitAuthority,
  createTestAuthoritativeBlindingPrecommitStore,
  createAuthoritativeBlindingPrecommitPaths,
  loadAuthoritativeBlindingPrecommitForTest,
  persistAuthoritativeBlindingPrecommit,
  persistAuthoritativeBlindingPrecommitForTest,
  type AuthoritativeBlindingPrecommitStore,
} from "../review/judgeEvidencePrecommitPersistence";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

const EXECUTION_PACK_HASH = "d".repeat(64);
const MASTER_SEED_ONE =
  "authoritative-master-blinding-seed-one-for-hidden-benchmark-00000001";
const MASTER_SEED_TWO =
  "authoritative-master-blinding-seed-two-for-hidden-benchmark-00000002";
const CASE_IDS = Array.from(
  { length: 12 },
  (_, index) => `H-${String(index + 1).padStart(3, "0")}`,
);

function manifest(masterBlindingSeed: string) {
  return buildJudgeEvidencePrecommitManifest({
    executionPackHash: EXECUTION_PACK_HASH,
    masterBlindingSeed,
    judgeInputBindings: CASE_IDS.map((caseId) => ({
      case_id: caseId,
      judge_input_hash: sha256CanonicalJson({
        case_id: caseId,
        fixture: masterBlindingSeed,
      }),
    })),
  });
}

async function createTestStore(
  prefix: string,
  storeName = "primary",
): Promise<{
  readonly authorityRoot: string;
  readonly authority: Awaited<ReturnType<
    typeof createTestAuthoritativeBlindingPrecommitAuthority
  >>;
  readonly store: AuthoritativeBlindingPrecommitStore;
}> {
  const authorityRoot = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const authority = await createTestAuthoritativeBlindingPrecommitAuthority({
    rootDirectory: authorityRoot,
  });
  const store = await createTestAuthoritativeBlindingPrecommitStore({
    authority,
    storeName,
  });
  return { authorityRoot, authority, store };
}

describe("실행 팩 범위 Judge blinding write-once precommit", () => {
  it("프로덕션 persistence entrypoint에는 임의 output root 인자가 없다", () => {
    type ProductionPersistInput = Parameters<
      typeof persistAuthoritativeBlindingPrecommit
    >[0];
    expectTypeOf<keyof ProductionPersistInput>().toEqualTypeOf<"manifest">();
  });

  it("canonical content-addressed record와 고정 claim을 0600으로 저장하고 재개 시 brand를 복원한다", async () => {
    const { store } = await createTestStore("judge-precommit-");
    const expectedManifest = manifest(MASTER_SEED_ONE);
    const anchor = await persistAuthoritativeBlindingPrecommitForTest({
      store,
      manifest: expectedManifest,
    });
    const paths = createAuthoritativeBlindingPrecommitPaths({
      store,
      executionPackHash: EXECUTION_PACK_HASH,
      manifestDigest: sha256CanonicalJson(expectedManifest),
    });

    expect((await lstat(paths.authorityClaimPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.recordPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.authorityClaimPath)).nlink).toBe(1);
    expect((await lstat(paths.recordPath)).nlink).toBe(1);
    expect((await lstat(paths.executionDirectory)).mode & 0o777).toBe(0o700);
    expect(paths.recordPath).toContain(sha256CanonicalJson(expectedManifest));
    const persistedBytes = [
      await readFile(paths.authorityClaimPath, "utf8"),
      await readFile(paths.recordPath, "utf8"),
    ].join("\n");
    expect(persistedBytes).not.toContain(MASTER_SEED_ONE);
    expect(persistedBytes).not.toMatch(/master_blinding_seed"|case_blinding_seed/i);

    expect(assertAuthoritativeBlindingPrecommit({
      anchor,
      expectedExecutionPackHash: EXECUTION_PACK_HASH,
      masterBlindingSeed: MASTER_SEED_ONE,
    })).toEqual(expectedManifest);

    const resumed = await loadAuthoritativeBlindingPrecommitForTest({
      store,
      executionPackHash: EXECUTION_PACK_HASH,
    });
    expect(assertAuthoritativeBlindingPrecommit({
      anchor: resumed,
      expectedExecutionPackHash: EXECUTION_PACK_HASH,
      masterBlindingSeed: MASTER_SEED_ONE,
    })).toEqual(expectedManifest);
  });

  it("authority root·store mode와 claim·record hard-link count를 fail-closed한다", async () => {
    const modeFixture = await createTestStore("judge-precommit-dir-mode-");
    const expectedManifest = manifest(MASTER_SEED_ONE);
    const anchor = await persistAuthoritativeBlindingPrecommitForTest({
      store: modeFixture.store,
      manifest: expectedManifest,
    });
    const paths = createAuthoritativeBlindingPrecommitPaths({
      store: modeFixture.store,
      executionPackHash: EXECUTION_PACK_HASH,
      manifestDigest: anchor.manifest_digest,
    });
    const storeDirectory = join(
      modeFixture.authorityRoot,
      "stores",
      "primary",
    );
    await chmod(storeDirectory, 0o755);
    await expect(loadAuthoritativeBlindingPrecommitForTest({
      store: modeFixture.store,
      executionPackHash: EXECUTION_PACK_HASH,
    })).rejects.toThrow(/0700|권한|mode|store/i);

    const linkFixture = await createTestStore("judge-precommit-hardlink-");
    const linkedAnchor = await persistAuthoritativeBlindingPrecommitForTest({
      store: linkFixture.store,
      manifest: expectedManifest,
    });
    const linkedPaths = createAuthoritativeBlindingPrecommitPaths({
      store: linkFixture.store,
      executionPackHash: EXECUTION_PACK_HASH,
      manifestDigest: linkedAnchor.manifest_digest,
    });
    await link(
      linkedPaths.recordPath,
      join(linkFixture.authorityRoot, "leaked-precommit-hardlink.json"),
    );
    await expect(loadAuthoritativeBlindingPrecommitForTest({
      store: linkFixture.store,
      executionPackHash: EXECUTION_PACK_HASH,
    })).rejects.toThrow(/link count|link|무결성/i);
  });

  it("동일 manifest는 멱등이고 같은 execution의 다른 seed precommit은 거부한다", async () => {
    const { store } = await createTestStore("judge-precommit-idempotent-");
    const firstManifest = manifest(MASTER_SEED_ONE);
    const first = await persistAuthoritativeBlindingPrecommitForTest({
      store,
      manifest: firstManifest,
    });
    const second = await persistAuthoritativeBlindingPrecommitForTest({
      store,
      manifest: firstManifest,
    });

    expect(first.manifest_digest).toBe(second.manifest_digest);
    await expect(persistAuthoritativeBlindingPrecommitForTest({
      store,
      manifest: manifest(MASTER_SEED_TWO),
    })).rejects.toThrow(/claim|precommit|execution|write-once|commitment|다릅니다/i);
  });

  it("서로 다른 seed의 동시 precommit은 정확히 한 명만 고정 claim을 선점한다", async () => {
    const { store } = await createTestStore("judge-precommit-race-");
    const attempts = await Promise.allSettled([
      persistAuthoritativeBlindingPrecommitForTest({
        store,
        manifest: manifest(MASTER_SEED_ONE),
      }),
      persistAuthoritativeBlindingPrecommitForTest({
        store,
        manifest: manifest(MASTER_SEED_TWO),
      }),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    const loaded = await loadAuthoritativeBlindingPrecommitForTest({
      store,
      executionPackHash: EXECUTION_PACK_HASH,
    });
    const winner = attempts.find((result) => result.status === "fulfilled")!;
    expect(loaded.manifest_digest).toBe(winner.value.manifest_digest);
  });

  it("복제·fabricated anchor를 권위 객체로 받아들이지 않는다", async () => {
    const { store } = await createTestStore("judge-precommit-brand-");
    const anchor = await persistAuthoritativeBlindingPrecommitForTest({
      store,
      manifest: manifest(MASTER_SEED_ONE),
    });

    expect(() => assertAuthoritativeBlindingPrecommit({
      anchor: structuredClone(anchor),
      expectedExecutionPackHash: EXECUTION_PACK_HASH,
      masterBlindingSeed: MASTER_SEED_ONE,
    })).toThrow(/authoritative|brand|persist|load|권위/i);
    expect(() => assertAuthoritativeBlindingPrecommit({
      anchor: { ...anchor },
      expectedExecutionPackHash: EXECUTION_PACK_HASH,
      masterBlindingSeed: MASTER_SEED_ONE,
    })).toThrow(/authoritative|brand|persist|load|권위/i);
  });

  it("재개 시 symlink·비정규 권한·비canonical bytes를 거부한다", async () => {
    const symlinkFixture = await createTestStore("judge-precommit-symlink-");
    const expectedManifest = manifest(MASTER_SEED_ONE);
    const symlinkPaths = createAuthoritativeBlindingPrecommitPaths({
      store: symlinkFixture.store,
      executionPackHash: EXECUTION_PACK_HASH,
      manifestDigest: sha256CanonicalJson(expectedManifest),
    });
    const target = join(symlinkFixture.authorityRoot, "claim-target.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await symlink(target, symlinkPaths.authorityClaimPath);
    await expect(loadAuthoritativeBlindingPrecommitForTest({
      store: symlinkFixture.store,
      executionPackHash: EXECUTION_PACK_HASH,
    })).rejects.toThrow(/symlink|regular|0600|안전|무결성/i);

    const modeFixture = await createTestStore("judge-precommit-mode-");
    const modeAnchor = await persistAuthoritativeBlindingPrecommitForTest({
      store: modeFixture.store,
      manifest: expectedManifest,
    });
    const modePaths = createAuthoritativeBlindingPrecommitPaths({
      store: modeFixture.store,
      executionPackHash: EXECUTION_PACK_HASH,
      manifestDigest: modeAnchor.manifest_digest,
    });
    await chmod(modePaths.recordPath, 0o644);
    await expect(loadAuthoritativeBlindingPrecommitForTest({
      store: modeFixture.store,
      executionPackHash: EXECUTION_PACK_HASH,
    })).rejects.toThrow(/0600|권한|regular|무결성/i);

    const canonicalFixture = await createTestStore("judge-precommit-canonical-");
    const canonicalAnchor = await persistAuthoritativeBlindingPrecommitForTest({
      store: canonicalFixture.store,
      manifest: expectedManifest,
    });
    const canonicalPaths = createAuthoritativeBlindingPrecommitPaths({
      store: canonicalFixture.store,
      executionPackHash: EXECUTION_PACK_HASH,
      manifestDigest: canonicalAnchor.manifest_digest,
    });
    const original = await readFile(canonicalPaths.recordPath, "utf8");
    await writeFile(canonicalPaths.recordPath, `${original} `, { mode: 0o600 });
    await expect(loadAuthoritativeBlindingPrecommitForTest({
      store: canonicalFixture.store,
      executionPackHash: EXECUTION_PACK_HASH,
    })).rejects.toThrow(/canonical|digest|bytes|무결성/i);
  });

  it("저장 경로 실패는 fail-closed이며 비밀값을 쓰지 않는다", async () => {
    const fixture = await createTestStore("judge-precommit-failure-");
    const paths = createAuthoritativeBlindingPrecommitPaths({
      store: fixture.store,
      executionPackHash: EXECUTION_PACK_HASH,
      manifestDigest: sha256CanonicalJson(manifest(MASTER_SEED_ONE)),
    });
    const outsideDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "judge-precommit-failure-outside-"),
    ));
    await symlink(outsideDirectory, paths.executionDirectory);

    await expect(persistAuthoritativeBlindingPrecommitForTest({
      store: fixture.store,
      manifest: manifest(MASTER_SEED_ONE),
    })).rejects.toThrow(/persist|directory|claim|저장|경로|무결성/i);
    const claimBytes = await readFile(paths.authorityClaimPath, "utf8");
    expect(claimBytes).not.toContain(MASTER_SEED_ONE);
    expect(claimBytes).not.toMatch(/master_blinding_seed"|case_blinding_seed/i);
  });

  it("같은 execution을 같은 authority의 서로 다른 store에 재확약할 수 없다", async () => {
    const authorityRoot = await realpath(await mkdtemp(
      join(tmpdir(), "judge-precommit-multi-store-authority-"),
    ));
    const authority = await createTestAuthoritativeBlindingPrecommitAuthority({
      rootDirectory: authorityRoot,
    });
    const storeA = await createTestAuthoritativeBlindingPrecommitStore({
      authority,
      storeName: "store-a",
    });
    const storeB = await createTestAuthoritativeBlindingPrecommitStore({
      authority,
      storeName: "store-b",
    });

    await persistAuthoritativeBlindingPrecommitForTest({
      store: storeA,
      manifest: manifest(MASTER_SEED_ONE),
    });

    await expect(persistAuthoritativeBlindingPrecommitForTest({
      store: storeB,
      manifest: manifest(MASTER_SEED_TWO),
    })).rejects.toThrow(/authority|authoritative|store|root|권위|precommit/i);
  });

  it("execution 디렉터리 symlink를 따라 외부 경로에 claim과 record를 쓰지 않는다", async () => {
    const fixture = await createTestStore("judge-precommit-execution-symlink-");
    const outsideDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "judge-precommit-outside-"),
    ));
    const paths = createAuthoritativeBlindingPrecommitPaths({
      store: fixture.store,
      executionPackHash: EXECUTION_PACK_HASH,
      manifestDigest: sha256CanonicalJson(manifest(MASTER_SEED_ONE)),
    });
    await symlink(outsideDirectory, paths.executionDirectory);

    await expect(persistAuthoritativeBlindingPrecommitForTest({
      store: fixture.store,
      manifest: manifest(MASTER_SEED_ONE),
    })).rejects.toThrow(/symlink|realpath|contain|directory|경로|권위/i);
    await expect(lstat(join(
      outsideDirectory,
      "judge-evidence-precommit--claim.json",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("authority root·ancestor·store 경로의 symlink를 fail-closed한다", async () => {
    const targetRoot = await realpath(await mkdtemp(
      join(tmpdir(), "judge-precommit-root-target-"),
    ));
    const linkParent = await realpath(await mkdtemp(
      join(tmpdir(), "judge-precommit-root-link-parent-"),
    ));
    const rootLink = join(linkParent, "authority-link");
    await symlink(targetRoot, rootLink);
    await expect(createTestAuthoritativeBlindingPrecommitAuthority({
      rootDirectory: rootLink,
    })).rejects.toThrow(/symlink|realpath|ancestor|root|권위/i);

    const ancestorTarget = await realpath(await mkdtemp(
      join(tmpdir(), "judge-precommit-ancestor-target-"),
    ));
    const nestedAuthority = join(ancestorTarget, "nested-authority");
    await mkdir(nestedAuthority, { mode: 0o700 });
    const ancestorLink = join(linkParent, "ancestor-link");
    await symlink(ancestorTarget, ancestorLink);
    await expect(createTestAuthoritativeBlindingPrecommitAuthority({
      rootDirectory: join(ancestorLink, "nested-authority"),
    })).rejects.toThrow(/symlink|realpath|ancestor|root|권위/i);

    const authorityRoot = await realpath(await mkdtemp(
      join(tmpdir(), "judge-precommit-store-link-authority-"),
    ));
    const authority = await createTestAuthoritativeBlindingPrecommitAuthority({
      rootDirectory: authorityRoot,
    });
    const outsideStore = await realpath(await mkdtemp(
      join(tmpdir(), "judge-precommit-store-link-target-"),
    ));
    await symlink(outsideStore, join(authorityRoot, "stores", "linked-store"));
    await expect(createTestAuthoritativeBlindingPrecommitStore({
      authority,
      storeName: "linked-store",
    })).rejects.toThrow(/symlink|realpath|store|directory|권위/i);
  });
});

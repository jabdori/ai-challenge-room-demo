// @vitest-environment node

import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const directoryCreationAudit = vi.hoisted(() => ({
  events: [] as string[],
  failSyncPath: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn(async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args);
      directoryCreationAudit.events.push(`mkdir:${String(args[0])}`);
      return result;
    }),
    open: vi.fn(async (
      path: Parameters<typeof actual.open>[0],
      flags: Parameters<typeof actual.open>[1],
      mode?: Parameters<typeof actual.open>[2],
    ) => {
      const handle = await actual.open(path, flags, mode);
      return {
        writeFile: handle.writeFile.bind(handle),
        readFile: handle.readFile.bind(handle),
        stat: handle.stat.bind(handle),
        close: handle.close.bind(handle),
        sync: async () => {
          const stats = await handle.stat();
          if (stats.isDirectory()) {
            directoryCreationAudit.events.push(`sync:${String(path)}`);
            if (directoryCreationAudit.failSyncPath === String(path)) {
              directoryCreationAudit.failSyncPath = null;
              throw new Error("simulated parent directory fsync failure");
            }
          }
          return handle.sync();
        },
      };
    }),
  };
});

import { sha256CanonicalJson } from "../../eval/runtime/canonicalJson";
import {
  buildProjectionSnapshot,
  createProjectionSnapshotPaths,
  createReadOnlyProjectionGateway,
  loadReadOnlyProjectionSnapshotRecord,
  loadProjectionSnapshot,
  persistProjectionSnapshot,
  ProjectionRepositoryIntegrityError,
  type ProjectionSnapshotInput,
} from "../projectionRepository";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function input(): ProjectionSnapshotInput {
  return {
    source_chain: [
      {
        artifact_kind: "LOCKED_CHALLENGE_PACK",
        artifact_id: "challenge_1",
        payload_sha256: SHA_A,
      },
      {
        artifact_kind: "RECORDED_BENCHMARK_PACK",
        artifact_id: "benchmark_1",
        payload_sha256: SHA_B,
      },
    ],
    workspace: {
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
      state: "REVIEW_PENDING",
    },
    challenges: [{
      schema_version: "challenge-public-projection-v1",
      synthetic: true,
      challenge_id: "challenge_1",
      source_hash: SHA_A,
      state: "LOCKED",
    }],
    evidence: [{
      schema_version: "evidence-public-projection-v1",
      synthetic: true,
      evidence_id: "evidence_1",
      source_hash: SHA_B,
    }],
    benchmark_progress: [{
      schema_version: "benchmark-progress-projection-v1",
      synthetic: true,
      benchmark_id: "benchmark_1",
      source_hash: SHA_B,
      completed: 72,
      total: 72,
    }],
    blind_reviews: [{
      schema_version: "blind-review-public-projection-v1",
      synthetic: true,
      review_id: "review_1",
      source_hash: SHA_B,
    }],
    decisions: [],
    baselines: [],
    regressions: [],
  };
}

async function secureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "projection-repository-"));
  await chmod(root, 0o700);
  return realpath(root);
}

describe("권위 artifact 기반 browser projection 저장소", () => {
  it("exact schema·synthetic·identity·source chain을 검증해 immutable snapshot을 만든다", () => {
    const snapshot = buildProjectionSnapshot(input());
    expect(snapshot).toMatchObject({
      schema_version: "workspace-projection-snapshot-v1",
      artifact_kind: "WORKSPACE_PROJECTION_SNAPSHOT",
      synthetic: true,
    });
    expect(snapshot.snapshot_id).toBe(sha256CanonicalJson({
      schema_version: snapshot.schema_version,
      artifact_kind: snapshot.artifact_kind,
      synthetic: snapshot.synthetic,
      source_chain: snapshot.source_chain,
      projections: snapshot.projections,
    }));

    const source = input();
    const forged = {
      ...source,
      challenges: source.challenges.map((challenge, index) => (
        index === 0
          ? {
              ...challenge,
              private_mapping: { X: "A" },
            }
          : challenge
      )),
    };
    expect(() => buildProjectionSnapshot(forged)).toThrow(
      ProjectionRepositoryIntegrityError,
    );
  });

  it("snapshot을 0700/0600/nlink1 content-addressed 경로에 저장하고 source rebuild로 다시 읽는다", async () => {
    const root = await secureRoot();
    const snapshot = buildProjectionSnapshot(input());
    const persisted = await persistProjectionSnapshot({
      outputDirectory: root,
      snapshot,
    });
    expect((await lstat(persisted.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(persisted.path)).mode & 0o777).toBe(0o600);
    expect((await lstat(persisted.path)).nlink).toBe(1);

    const loaded = await loadProjectionSnapshot({
      path: persisted.path,
      authority: input(),
    });
    expect(loaded).toEqual(snapshot);
    await expect(loadReadOnlyProjectionSnapshotRecord({
      path: persisted.path,
    })).resolves.toEqual(snapshot);
  });

  it("새 snapshot 디렉터리를 만든 직후 projection output root를 fsync한다", async () => {
    const root = await secureRoot();
    const snapshot = buildProjectionSnapshot(input());
    const paths = createProjectionSnapshotPaths({
      outputDirectory: root,
      snapshotId: snapshot.snapshot_id,
    });
    directoryCreationAudit.events.length = 0;

    await persistProjectionSnapshot({
      outputDirectory: root,
      snapshot,
    });

    expect(directoryCreationAudit.events.filter((event) => (
      event === `mkdir:${paths.directory}`
      || event === `sync:${root}`
    ))).toEqual([
      `mkdir:${paths.directory}`,
      `sync:${root}`,
    ]);

    const existingRoot = await secureRoot();
    const existingPaths = createProjectionSnapshotPaths({
      outputDirectory: existingRoot,
      snapshotId: snapshot.snapshot_id,
    });
    await mkdir(existingPaths.directory, { mode: 0o700 });
    directoryCreationAudit.events.length = 0;
    await persistProjectionSnapshot({
      outputDirectory: existingRoot,
      snapshot,
    });
    expect(directoryCreationAudit.events.filter((event) => (
      event === `sync:${existingRoot}`
    ))).toEqual([`sync:${existingRoot}`]);
  });

  it("신규 snapshot의 부모 fsync가 실패하면 첫 호출을 거부하고 EEXIST 재시도에서 다시 fsync한다", async () => {
    const root = await secureRoot();
    const snapshot = buildProjectionSnapshot(input());
    const paths = createProjectionSnapshotPaths({
      outputDirectory: root,
      snapshotId: snapshot.snapshot_id,
    });
    directoryCreationAudit.failSyncPath = root;

    await expect(persistProjectionSnapshot({
      outputDirectory: root,
      snapshot,
    })).rejects.toThrow(ProjectionRepositoryIntegrityError);
    expect((await lstat(paths.directory)).isDirectory()).toBe(true);

    directoryCreationAudit.events.length = 0;
    await persistProjectionSnapshot({
      outputDirectory: root,
      snapshot,
    });
    expect(directoryCreationAudit.events.filter((event) => (
      event === `sync:${root}`
    ))).toEqual([
      `sync:${root}`,
    ]);
  });

  it("path substitution·tamper·symlink·hardlink·mode 변경을 fail-closed 한다", async () => {
    const root = await secureRoot();
    const snapshot = buildProjectionSnapshot(input());
    const persisted = await persistProjectionSnapshot({
      outputDirectory: root,
      snapshot,
    });
    const paths = createProjectionSnapshotPaths({
      outputDirectory: root,
      snapshotId: snapshot.snapshot_id,
    });

    await expect(loadProjectionSnapshot({
      path: join(root, "forged.json"),
      authority: input(),
    })).rejects.toThrow(ProjectionRepositoryIntegrityError);

    const original = await readFile(persisted.path);
    const backup = join(root, "backup");
    await rename(persisted.path, backup);
    await writeFile(persisted.path, Buffer.from(original.toString("utf8").replace(
      "REVIEW_PENDING",
      "COMPLETE",
    )), { mode: 0o600, flag: "wx" });
    await expect(loadProjectionSnapshot({
      path: persisted.path,
      authority: input(),
    })).rejects.toThrow(ProjectionRepositoryIntegrityError);
    await expect(loadReadOnlyProjectionSnapshotRecord({
      path: persisted.path,
    })).rejects.toThrow(ProjectionRepositoryIntegrityError);

    await rename(persisted.path, join(root, "tampered"));
    await rename(backup, persisted.path);
    await chmod(persisted.path, 0o644);
    await expect(loadProjectionSnapshot({
      path: persisted.path,
      authority: input(),
    })).rejects.toThrow(ProjectionRepositoryIntegrityError);
    await chmod(persisted.path, 0o600);

    const hardlink = join(paths.directory, "hardlink.json");
    await link(persisted.path, hardlink);
    await expect(loadProjectionSnapshot({
      path: persisted.path,
      authority: input(),
    })).rejects.toThrow(ProjectionRepositoryIntegrityError);

    const symlinkRoot = await secureRoot();
    const symlinkSnapshot = buildProjectionSnapshot(input());
    const symlinkPersisted = await persistProjectionSnapshot({
      outputDirectory: symlinkRoot,
      snapshot: symlinkSnapshot,
    });
    const symlinkBackup = join(symlinkRoot, "symlink-backup");
    await rename(symlinkPersisted.path, symlinkBackup);
    await symlink(symlinkBackup, symlinkPersisted.path);
    await expect(loadProjectionSnapshot({
      path: symlinkPersisted.path,
      authority: input(),
    })).rejects.toThrow(ProjectionRepositoryIntegrityError);
    await unlink(symlinkPersisted.path);
  });

  it("read-only gateway는 snapshot에 결합된 projection만 반환하고 mutation을 거부한다", async () => {
    const snapshot = buildProjectionSnapshot(input());
    const gateway = createReadOnlyProjectionGateway(snapshot);
    await expect(gateway.getWorkspace()).resolves.toEqual(
      snapshot.projections.workspace,
    );
    await expect(gateway.getChallenge("challenge_1")).resolves.toMatchObject({
      challenge_id: "challenge_1",
    });
    await expect(gateway.getChallenge("missing")).resolves.toBeNull();
    await expect(gateway.startBenchmark({
      schema_version: "benchmark-start-command-v1",
      expected_source_hash: SHA_A,
      idempotency_key: "mutation_test",
      target_id: "benchmark_1",
    })).rejects.toMatchObject({ code: "READ_ONLY_PROJECTION" });
  });

  it("사람 확인 단계 snapshot은 개별 blind item 대신 결합된 pre-confirmation projection을 보존한다", async () => {
    const source = input();
    const preconfirmation = {
      ...source,
      blind_reviews: [{
        schema_version: "preconfirmation-public-projection-v1",
        synthetic: true,
        review_id: "review_1",
        source_hash: SHA_B,
      }],
    };

    const snapshot = buildProjectionSnapshot(preconfirmation);
    await expect(
      createReadOnlyProjectionGateway(snapshot).getBlindReview("review_1"),
    ).resolves.toMatchObject({
      schema_version: "preconfirmation-public-projection-v1",
      review_id: "review_1",
    });
  });
});

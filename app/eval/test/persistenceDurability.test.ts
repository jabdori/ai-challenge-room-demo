// @vitest-environment node

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const directorySyncAudit = vi.hoisted(() => ({
  paths: [] as string[],
  events: [] as string[],
  failSyncPath: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn(async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args);
      directorySyncAudit.events.push(`mkdir:${String(args[0])}`);
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
            directorySyncAudit.paths.push(String(path));
            directorySyncAudit.events.push(`sync:${String(path)}`);
            if (directorySyncAudit.failSyncPath === String(path)) {
              directorySyncAudit.failSyncPath = null;
              throw new Error("simulated parent directory fsync failure");
            }
          }
          return handle.sync();
        },
      };
    }),
  };
});

import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  symlink,
} from "node:fs/promises";
import {
  prepareWriteOnceArtifactDirectory,
  persistWriteOnceFileWithClaim,
} from "../pack/persistence";

describe("write-once 파일 공개 내구성", () => {
  it("새 artifact 디렉터리를 만든 직후 부모 root 디렉터리를 fsync한다", async () => {
    const rootDirectory = await realpath(await mkdtemp(join(tmpdir(), "write-once-root-")));
    const artifactDirectory = join(rootDirectory, "artifact");
    directorySyncAudit.events.length = 0;

    await prepareWriteOnceArtifactDirectory({
      rootDirectory,
      artifactDirectory,
    });

    expect(directorySyncAudit.events.filter((event) => (
      event === `mkdir:${artifactDirectory}`
      || event === `sync:${rootDirectory}`
    ))).toEqual([
      `mkdir:${artifactDirectory}`,
      `sync:${rootDirectory}`,
    ]);

    directorySyncAudit.events.length = 0;
    await prepareWriteOnceArtifactDirectory({
      rootDirectory,
      artifactDirectory,
    });
    expect(directorySyncAudit.events.filter((event) => (
      event === `sync:${rootDirectory}`
    ))).toEqual([`sync:${rootDirectory}`]);
  });

  it("신규 artifact의 부모 fsync가 실패하면 첫 호출을 거부하고 EEXIST 재시도에서 다시 fsync한다", async () => {
    const rootDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "write-once-root-retry-"),
    ));
    const artifactDirectory = join(rootDirectory, "artifact");
    directorySyncAudit.failSyncPath = rootDirectory;

    await expect(prepareWriteOnceArtifactDirectory({
      rootDirectory,
      artifactDirectory,
    })).rejects.toThrow(/fsync|sync|simulated/i);
    expect((await lstat(artifactDirectory)).isDirectory()).toBe(true);

    directorySyncAudit.events.length = 0;
    await prepareWriteOnceArtifactDirectory({
      rootDirectory,
      artifactDirectory,
    });
    expect(directorySyncAudit.events.filter((event) => (
      event === `sync:${rootDirectory}`
    ))).toEqual([
      `sync:${rootDirectory}`,
    ]);
  });

  it("hard-link 공개와 임시 이름 unlink 뒤 부모 디렉터리를 각각 fsync한다", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "write-once-durable-")));
    const filePath = join(directory, "record.json");
    const bytes = Buffer.from("{\"ok\":true}\n", "utf8");
    directorySyncAudit.paths.length = 0;

    const result = await persistWriteOnceFileWithClaim({
      filePath,
      bytes,
      assertExistingMatches: async () => {
        throw new Error("unexpected existing destination");
      },
      assertPublishedFile: async (path) => {
        expect(await readFile(path)).toEqual(bytes);
      },
      requireTemporaryCleanup: true,
    });

    expect(result).toEqual({ path: filePath, created: true });
    expect(directorySyncAudit.paths.filter((path) => path === directory))
      .toHaveLength(2);
  });

  it("조상 symlink root는 외부 artifact namespace를 만들기 전에 거부한다", async () => {
    const trustedParent = await realpath(await mkdtemp(
      join(tmpdir(), "write-once-parent-"),
    ));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "write-once-outside-")));
    await Promise.all([chmod(trustedParent, 0o700), chmod(outside, 0o700)]);
    const linkedParent = join(trustedParent, "linked-parent");
    await symlink(outside, linkedParent);
    const rootDirectory = join(linkedParent, "root");
    const artifactDirectory = join(rootDirectory, "artifact");

    await expect(prepareWriteOnceArtifactDirectory({
      rootDirectory,
      artifactDirectory,
    })).rejects.toThrow(/symlink|canonical|root|안전/i);

    expect(await readdir(outside)).toEqual([]);
  });
});

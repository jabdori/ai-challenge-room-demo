// @vitest-environment node

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalAuthorityWrapperBytes,
  persistCanonicalAuthorityPack,
} from "../pack/authorityPackPersistence";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

describe("canonical authority pack persistence", () => {
  it("claim만 durable한 half-state는 같은 expected payload 재실행으로 record까지 수렴한다", async () => {
    const outputDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "authority-pack-half-state-"),
    ));
    await chmod(outputDirectory, 0o700);
    const executionDirectory = join(outputDirectory, "a".repeat(64));
    const claim = Object.freeze({ kind: "CLAIM", execution: "a".repeat(64) });
    const payload = Object.freeze({ kind: "RECORD", value: 1 });
    const claimPath = join(executionDirectory, "authority-pack--claim.json");
    const recordPath = join(
      executionDirectory,
      `authority-pack--record-${sha256CanonicalJson(payload)}.json`,
    );
    await mkdir(executionDirectory, { mode: 0o700 });
    await writeFile(
      claimPath,
      canonicalAuthorityWrapperBytes(claim),
      { flag: "wx", mode: 0o600 },
    );

    await expect(persistCanonicalAuthorityPack({
      paths: { outputDirectory, executionDirectory, claimPath, recordPath },
      claim,
      payload,
      claimLocation: "test claim",
      recordLocation: "test record",
    })).resolves.toBeUndefined();

    expect(await readFile(claimPath)).toEqual(canonicalAuthorityWrapperBytes(claim));
    expect(await readFile(recordPath)).toEqual(canonicalAuthorityWrapperBytes(payload));
    expect((await lstat(claimPath)).nlink).toBe(1);
    expect((await lstat(recordPath)).nlink).toBe(1);
  });

  it.each([
    "claim outside execution",
    "record outside execution",
    "claim and record swap",
    "claim and record same path",
    "parent traversal",
    "symlinked foreign directory",
  ] as const)("claim·record 경로 %s는 publish 전에 fail-closed 한다", async (attack) => {
    const outputDirectory = await realpath(await mkdtemp(
      join(tmpdir(), "authority-pack-path-containment-"),
    ));
    await chmod(outputDirectory, 0o700);
    const executionDirectory = join(outputDirectory, "b".repeat(64));
    const outsideDirectory = join(outputDirectory, "outside");
    await Promise.all([
      mkdir(executionDirectory, { mode: 0o700 }),
      mkdir(outsideDirectory, { mode: 0o700 }),
    ]);
    const claim = Object.freeze({ kind: "CLAIM", execution: "b".repeat(64) });
    const payload = Object.freeze({ kind: "RECORD", value: 2 });
    const claimPath = join(executionDirectory, "authority-pack--claim.json");
    const recordPath = join(
      executionDirectory,
      `authority-pack--record-${sha256CanonicalJson(payload)}.json`,
    );
    const aliasDirectory = join(executionDirectory, "foreign-alias");
    if (attack === "symlinked foreign directory") {
      await symlink(outsideDirectory, aliasDirectory);
    }
    const paths = attack === "claim outside execution"
      ? { outputDirectory, executionDirectory, claimPath: join(outsideDirectory, "authority-pack--claim.json"), recordPath }
      : attack === "record outside execution"
        ? { outputDirectory, executionDirectory, claimPath, recordPath: join(outsideDirectory, `authority-pack--record-${sha256CanonicalJson(payload)}.json`) }
        : attack === "claim and record swap"
          ? { outputDirectory, executionDirectory, claimPath: recordPath, recordPath: claimPath }
          : attack === "claim and record same path"
            ? { outputDirectory, executionDirectory, claimPath, recordPath: claimPath }
            : attack === "parent traversal"
              ? { outputDirectory, executionDirectory, claimPath: join(executionDirectory, "..", "outside", "authority-pack--claim.json"), recordPath }
              : { outputDirectory, executionDirectory, claimPath: join(aliasDirectory, "authority-pack--claim.json"), recordPath };

    await expect(persistCanonicalAuthorityPack({
      paths,
      claim,
      payload,
      claimLocation: "test claim",
      recordLocation: "test record",
    })).rejects.toThrow(/claim|record|execution|path|경로|direct|직접|canonical/i);

    expect(await readdir(outsideDirectory)).toEqual([]);
  });
});

// @vitest-environment node

import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../../eval/runtime/canonicalJson";
import {
  AmbiguousMutationError,
  FileMutationJournal,
  MutationJournalIntegrityError,
} from "../artifactRepository";
import type { ChallengeMutationCommand } from "../challengeServer";

const SOURCE_HASH = "a".repeat(64);

function command(key = "mutation_test_001"): ChallengeMutationCommand {
  return Object.freeze({
    schema_version: "benchmark-start-command-v1",
    expected_source_hash: SOURCE_HASH,
    idempotency_key: key,
    target_id: "benchmark_1",
    payload: Object.freeze({ requested_by: "Synthetic evaluation owner" }),
  });
}

async function secureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "challenge-api-journal-"));
  await chmod(root, 0o700);
  return await realpath(root);
}

describe("권위 API mutation intent/receipt 원장", () => {
  it("side effect 전에 intent를, 성공 뒤 receipt를 0600 write-once로 저장한다", async () => {
    const root = await secureRoot();
    const journal = new FileMutationJournal(root);
    const operation = vi.fn(async () => ({
      accepted: true as const,
      source_hash: SOURCE_HASH,
    }));

    const result = await journal.execute(command(), operation);
    expect(result).toEqual({ accepted: true, source_hash: SOURCE_HASH });
    expect(operation).toHaveBeenCalledTimes(1);

    const paths = journal.pathsFor(command());
    expect((await lstat(paths.mutationDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths.intentPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.intentPath)).nlink).toBe(1);
    expect((await lstat(paths.receiptPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.receiptPath)).nlink).toBe(1);

    const intent = JSON.parse(await readFile(paths.intentPath, "utf8"));
    const receipt = JSON.parse(await readFile(paths.receiptPath, "utf8"));
    expect(intent.payload.artifact_kind).toBe("API_MUTATION_INTENT");
    expect(receipt.payload).toMatchObject({
      artifact_kind: "API_MUTATION_RECEIPT",
      status: "SUCCEEDED",
      source_hash: SOURCE_HASH,
    });
  });

  it("프로세스가 바뀌어도 같은 key replay를 side effect 전에 거부한다", async () => {
    const root = await secureRoot();
    await new FileMutationJournal(root).execute(
      command(),
      async () => ({ accepted: true, source_hash: SOURCE_HASH }),
    );

    const operation = vi.fn();
    await expect(new FileMutationJournal(root).execute(command(), operation))
      .rejects.toMatchObject({ code: "MUTATION_REPLAYED" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("intent-only 상태는 결과가 불명확하므로 자동 재호출하지 않는다", async () => {
    const root = await secureRoot();
    const journal = new FileMutationJournal(root);
    const paths = journal.pathsFor(command());
    await mkdir(paths.mutationDirectory, { mode: 0o700 });
    await writeFile(paths.intentPath, journal.intentBytesFor(command()), {
      mode: 0o600,
      flag: "wx",
    });

    const operation = vi.fn();
    await expect(journal.execute(command(), operation))
      .rejects.toBeInstanceOf(AmbiguousMutationError);
    expect(operation).not.toHaveBeenCalled();
  });

  it("동시 같은 key에서는 정확히 한 side effect만 호출한다", async () => {
    const root = await secureRoot();
    const first = new FileMutationJournal(root);
    const second = new FileMutationJournal(root);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const operation = vi.fn(async () => {
      await gate;
      return { accepted: true as const, source_hash: SOURCE_HASH };
    });

    const one = first.execute(command(), operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    const two = second.execute(command(), operation);
    const twoRejected = expect(two).rejects.toMatchObject({
      code: expect.stringMatching(/MUTATION_(?:REPLAYED|AMBIGUOUS)/),
    });
    release();
    await expect(one).resolves.toMatchObject({ accepted: true });
    await twoRejected;
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("symlink·잘못된 mode·hard link record를 fail-closed 한다", async () => {
    const root = await secureRoot();
    const outside = await secureRoot();
    const linkedRoot = join(root, "linked");
    await symlink(outside, linkedRoot);
    await expect(new FileMutationJournal(linkedRoot).execute(
      command("mutation_symlink_1"),
      async () => ({ accepted: true, source_hash: SOURCE_HASH }),
    )).rejects.toBeInstanceOf(MutationJournalIntegrityError);

    await chmod(root, 0o755);
    await expect(new FileMutationJournal(root).execute(
      command("mutation_mode_1"),
      async () => ({ accepted: true, source_hash: SOURCE_HASH }),
    )).rejects.toThrow(/0700|mode|디렉터리/i);
  });

  it("root 조상 symlink는 외부 mutation journal을 만들기 전에 거부한다", async () => {
    const sandbox = await secureRoot();
    const outside = await secureRoot();
    const linkedParent = join(sandbox, "outside-parent");
    const outsideMutationJournal = join(outside, "mutation-journal");
    await symlink(outside, linkedParent);
    const operation = vi.fn(async () => ({
      accepted: true as const,
      source_hash: SOURCE_HASH,
    }));

    await expect(new FileMutationJournal(join(linkedParent, "mutation-journal"))
      .execute(command("mutation_parent_symlink_1"), operation))
      .rejects.toBeInstanceOf(MutationJournalIntegrityError);

    let outsideMutationJournalCreated = true;
    try {
      await lstat(outsideMutationJournal);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        outsideMutationJournalCreated = false;
      } else {
        throw error;
      }
    }
    expect(outsideMutationJournalCreated).toBe(false);
    expect(operation).not.toHaveBeenCalled();
  });

  it("실패도 receipt로 종결해 결과 불명확 mutation의 replay를 막는다", async () => {
    const root = await secureRoot();
    const journal = new FileMutationJournal(root);
    await expect(journal.execute(command(), async () => {
      throw new Error("raw provider detail");
    })).rejects.toThrow("raw provider detail");

    const paths = journal.pathsFor(command());
    const receipt = JSON.parse(await readFile(paths.receiptPath, "utf8"));
    expect(receipt.payload).toMatchObject({
      artifact_kind: "API_MUTATION_RECEIPT",
      status: "FAILED",
      source_hash: null,
      error_code: "SIDE_EFFECT_FAILED",
    });
    expect(JSON.stringify(receipt)).not.toContain("raw provider detail");
    await expect(new FileMutationJournal(root).execute(
      command(),
      async () => ({ accepted: true, source_hash: SOURCE_HASH }),
    )).rejects.toMatchObject({ code: "MUTATION_REPLAYED" });
  });

  it.each(["SUCCEEDED", "FAILED"] as const)(
    "canonical hash를 다시 계산해도 %s generic receipt의 extra field 변조를 corruption으로 차단한다",
    async (outcome) => {
      const root = await secureRoot();
      const journal = new FileMutationJournal(root);
      const mutationCommand = command(`mutation_generic_tamper_${outcome}`);
      if (outcome === "SUCCEEDED") {
        await journal.execute(
          mutationCommand,
          async () => ({ accepted: true, source_hash: SOURCE_HASH }),
        );
      } else {
        await expect(journal.execute(mutationCommand, async () => {
          throw new Error("expected failure");
        })).rejects.toThrow("expected failure");
      }
      const paths = journal.pathsFor(mutationCommand);
      const wrapper = JSON.parse(await readFile(paths.receiptPath, "utf8")) as {
        payload: Record<string, unknown>;
      };
      wrapper.payload.unexpected = "tampered";
      await writeFile(paths.receiptPath, `${canonicalJsonStringify({
        payload_sha256: sha256CanonicalJson(wrapper.payload),
        payload: wrapper.payload,
      })}\n`);

      await expect(new FileMutationJournal(root).execute(
        mutationCommand,
        async () => ({ accepted: true, source_hash: SOURCE_HASH }),
      )).rejects.toBeInstanceOf(MutationJournalIntegrityError);
    },
  );
});

// @vitest-environment node

import {
  chmod,
  link,
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
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  SYNTHETIC_CHALLENGE_APPROVAL_ACKNOWLEDGEMENT_ENV,
  SYNTHETIC_CHALLENGE_APPROVAL_PREFIX,
} from "../cli/approveSyntheticChallenge";
import {
  executeDefineStructureCommand,
  runDefineStructureProcess,
  type DefineStructureCommandDependencies,
  type DefineStructureProcessLike,
} from "../cli/runDefineStructure";
import {
  assertPersistedDefineStructuringArtifact,
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
import {
  loadLockedChallengeAuthorityRecord,
} from "../define/lockedChallengePersistence";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

const syntheticInput =
  SYNTHETIC_CHALLENGE_TEMPLATE.defineInput;
const advisorySuggestion =
  SYNTHETIC_CHALLENGE_TEMPLATE.advisorySuggestion;
const testApiKey = ["sk", "define-production-test-secret-1234567890"].join("-");

function completedAdapterResult(
  overrides: Partial<DefineAdapterResult> = {},
): DefineAdapterResult {
  return {
    responseId: "resp-define-production-1",
    responseStatusCode: 200,
    status: "completed",
    modelReportedId: "gpt-5.6-sol",
    serviceTierReported: "default",
    outputText: JSON.stringify(advisorySuggestion),
    usage: {
      inputTokens: 200,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 40,
      totalTokens: 300,
    },
    error: null,
    ...overrides,
  };
}

function queuedAdapter(
  queue: readonly DefineAdapterResult[],
): DefineAdapter & { readonly invoke: ReturnType<typeof vi.fn> } {
  let cursor = 0;
  const invoke = vi.fn(async () => {
    const result = queue[cursor];
    cursor += 1;
    if (!result) throw new Error("예상하지 않은 Define 호출입니다.");
    return structuredClone(result);
  });
  return { invoke };
}

function monotonicNow(step = 10): () => number {
  let value = Date.parse("2026-07-17T00:00:00.000Z");
  return () => {
    const current = value;
    value += step;
    return current;
  };
}

async function completedArtifact() {
  const adapter = queuedAdapter([completedAdapterResult()]);
  const run = await runDefineStructuring({
    adapter,
    input: syntheticInput,
    now: monotonicNow(),
  });
  return buildDefineStructuringArtifact({
    input: syntheticInput,
    run,
  });
}

async function secureTempRoot(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

class FakeStructureProcess implements DefineStructureProcessLike {
  readonly env: NodeJS.ProcessEnv;
  exitCode: string | number | null | undefined;
  readonly stdoutText: string[] = [];
  readonly stderrText: string[] = [];
  readonly stdout = {
    write: (value: string) => {
      this.stdoutText.push(value);
      return true;
    },
  };
  readonly stderr = {
    write: (value: string) => {
      this.stderrText.push(value);
      return true;
    },
  };

  constructor(environment: NodeJS.ProcessEnv = {}) {
    this.env = environment;
  }
}

function runApprovalCli(
  environment: NodeJS.ProcessEnv,
  tty: boolean,
): { readonly output: string; readonly status: number | null } {
  const nodeArguments = [
    "--import",
    "tsx",
    "eval/cli/approveSyntheticChallenge.ts",
  ];
  const ptyLauncher = [
    "import os, pty, sys",
    "pid, fd = pty.fork()",
    "if pid == 0: os.execvpe(sys.argv[1], sys.argv[1:], os.environ)",
    "chunks = []",
    "while True:",
    "    try:",
    "        chunk = os.read(fd, 4096)",
    "    except OSError:",
    "        break",
    "    if not chunk:",
    "        break",
    "    chunks.append(chunk)",
    "_, status = os.waitpid(pid, 0)",
    "sys.stdout.buffer.write(b''.join(chunks))",
    "sys.exit(os.waitstatus_to_exitcode(status))",
  ].join("\n");
  const result = tty
    ? spawnSync(
        "python3",
        ["-c", ptyLauncher, process.execPath, ...nodeArguments],
        {
          cwd: new URL("../../", import.meta.url),
          env: { ...process.env, ...environment },
          encoding: "utf8",
          timeout: 30_000,
        },
      )
    : spawnSync(process.execPath, nodeArguments, {
        cwd: new URL("../../", import.meta.url),
        env: { ...process.env, ...environment },
        encoding: "utf8",
        timeout: 30_000,
      });
  if (result.error) throw result.error;
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    status: result.status,
  };
}

describe("Define 구조화 증거의 write-once authority", () => {
  it("내용 주소화된 canonical 0600 파일을 저장하고 별도 객체로 source-reload한다", async () => {
    const outputDirectory = await secureTempRoot("define-structuring-authority-");
    const artifact = await completedArtifact();

    const persisted = await persistDefineStructuringArtifact({
      outputDirectory,
      artifact,
    });
    const reloaded = await loadDefineStructuringArtifact({
      outputDirectory,
      artifactPath: persisted.path,
      expectedInput: syntheticInput,
    });

    expect(persisted.created).toBe(true);
    expect((await lstat(persisted.path)).mode & 0o777).toBe(0o600);
    expect(reloaded).toEqual(artifact);
    expect(reloaded).not.toBe(artifact);
    expect(() => assertPersistedDefineStructuringArtifact(artifact))
      .toThrow(/source|reload|persist|저장/i);
    expect(() => assertPersistedDefineStructuringArtifact(reloaded))
      .not.toThrow();
  });

  it("동일 artifact replay는 기존 exact bytes를 검증하고 새 파일을 만들지 않는다", async () => {
    const outputDirectory = await secureTempRoot("define-structuring-replay-");
    const artifact = await completedArtifact();

    const first = await persistDefineStructuringArtifact({
      outputDirectory,
      artifact,
    });
    const replay = await persistDefineStructuringArtifact({
      outputDirectory,
      artifact: structuredClone(artifact),
    });

    expect(first.created).toBe(true);
    expect(replay).toEqual({ ...first, created: false });
  });

  it("파일 bytes 변조와 content-addressed 경로 바꿔치기를 source reload에서 거부한다", async () => {
    const outputDirectory = await secureTempRoot("define-structuring-tamper-");
    const artifact = await completedArtifact();
    const persisted = await persistDefineStructuringArtifact({
      outputDirectory,
      artifact,
    });
    const original = await readFile(persisted.path, "utf8");
    await chmod(persisted.path, 0o600);
    await writeFile(
      persisted.path,
      original.replace("ADVISORY_ONLY", "ADVISORY_FAKE"),
      { mode: 0o600 },
    );

    await expect(loadDefineStructuringArtifact({
      outputDirectory,
      artifactPath: persisted.path,
      expectedInput: syntheticInput,
    })).rejects.toThrow(/hash|canonical|integrity|무결성|bytes/i);
  });

  it("외부 hard-link로 inode가 변경 가능해진 artifact는 source reload에서 거부한다", async () => {
    const outputDirectory = await secureTempRoot("define-structuring-hardlink-");
    const artifact = await completedArtifact();
    const persisted = await persistDefineStructuringArtifact({
      outputDirectory,
      artifact,
    });
    await link(persisted.path, join(outputDirectory, "external-mutable-link.json"));

    await expect(loadDefineStructuringArtifact({
      outputDirectory,
      artifactPath: persisted.path,
      expectedInput: syntheticInput,
    })).rejects.toThrow(/link|nlink|hard|불변|inode/i);
  });
});

describe("production Define structure command", () => {
  it("package scripts는 advisory 구조화와 사람 승인을 분리하고 무승인 lock entry를 노출하지 않는다", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["eval:define:structure"])
      .toMatch(/runDefineStructure/);
    expect(packageJson.scripts["eval:define:approve"])
      .toMatch(/approveSyntheticChallenge/);
    expect(packageJson.scripts).not.toHaveProperty("eval:define:lock");
  });

  it("API key가 없으면 OpenAI client·runner·artifact 저장을 전혀 호출하지 않는다", async () => {
    const dependencies: DefineStructureCommandDependencies = {
      createClient: vi.fn(),
      createAdapter: vi.fn(),
      runStructuring: vi.fn(),
      persistArtifact: vi.fn(),
      loadPersistedArtifact: vi.fn(),
    };

    const outcome = await executeDefineStructureCommand({
      environment: {},
      outputDirectory: "/private/runtime/define",
      dependencies,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.summary.error).toMatch(/Define structuring/i);
    expect(outcome.summary.error).not.toMatch(/calibration/i);
    expect(dependencies.createClient).not.toHaveBeenCalled();
    expect(dependencies.runStructuring).not.toHaveBeenCalled();
    expect(dependencies.persistArtifact).not.toHaveBeenCalled();
  });

  it("안전하지 않은 출력 루트는 OpenAI client·adapter·runner 전에 차단한다", async () => {
    const dependencies: DefineStructureCommandDependencies = {
      prepareOutputDirectory: vi.fn(async () => {
        throw new TypeError("unsafe output root");
      }),
      createClient: vi.fn(),
      createAdapter: vi.fn(),
      runStructuring: vi.fn(),
      persistArtifact: vi.fn(),
      loadPersistedArtifact: vi.fn(),
    };

    const outcome = await executeDefineStructureCommand({
      environment: { OPENAI_API_KEY: testApiKey },
      outputDirectory: "/unsafe-output",
      dependencies,
    });

    expect(outcome.exitCode).toBe(1);
    expect(dependencies.createClient).not.toHaveBeenCalled();
    expect(dependencies.createAdapter).not.toHaveBeenCalled();
    expect(dependencies.runStructuring).not.toHaveBeenCalled();
    expect(dependencies.persistArtifact).not.toHaveBeenCalled();
  });

  it("symlink parent에는 외부 child를 만들지 않고 client 전에 거부한다", async () => {
    const parent = await secureTempRoot("define-output-parent-");
    const outside = await secureTempRoot("define-output-outside-");
    const linkedParent = join(parent, "linked");
    await symlink(outside, linkedParent);
    const dependencies: DefineStructureCommandDependencies = {
      createClient: vi.fn(), createAdapter: vi.fn(), runStructuring: vi.fn(),
      persistArtifact: vi.fn(), loadPersistedArtifact: vi.fn(),
    };
    const outcome = await executeDefineStructureCommand({
      environment: { OPENAI_API_KEY: testApiKey },
      outputDirectory: join(linkedParent, "missing-parent", "define-structuring"),
      dependencies,
    });
    expect(outcome.exitCode).toBe(1);
    expect(dependencies.createClient).not.toHaveBeenCalled();
    expect(await readdir(outside)).not.toContain("missing-parent");
  });

  it("Sol 보조 구조화의 usage·cost·latency를 저장하고 source-reload 좌표만 반환한다", async () => {
    const outputDirectory = await secureTempRoot("define-structure-command-");
    const adapter = queuedAdapter([completedAdapterResult()]);
    const createClient = vi.fn(() => ({ kind: "mock-client" }));
    const dependencies: DefineStructureCommandDependencies = {
      createClient,
      createAdapter: vi.fn(() => adapter),
      runStructuring: (options) => runDefineStructuring({
        ...options,
        now: monotonicNow(),
      }),
      persistArtifact: persistDefineStructuringArtifact,
      loadPersistedArtifact: loadDefineStructuringArtifact,
    };

    const outcome = await executeDefineStructureCommand({
      environment: { OPENAI_API_KEY: testApiKey },
      outputDirectory,
      dependencies,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.summary).toMatchObject({
      command_status: "DEFINE_SUGGESTION_READY",
      artifact_kind: "DEFINE_STRUCTURING_ARTIFACT",
      authority: "ADVISORY_ONLY",
      human_approval_required: true,
      challenge_locked: false,
      model_requested: "gpt-5.6-sol",
      attempt_count: 1,
      store: false,
    });
    expect(outcome.summary.artifact_path).toMatch(/define-structuring--record-/);
    expect(outcome.serverAuthority?.defineStructuringArtifact)
      .not.toBe(outcome.builtArtifact);
    expect(() => assertPersistedDefineStructuringArtifact(
      outcome.serverAuthority?.defineStructuringArtifact,
    )).not.toThrow();
    expect(createClient).toHaveBeenCalledWith(testApiKey);
  });

  it("빈 출력은 runner가 한 번만 재시도하고 불완전 증거만 저장하며 lock authority를 만들지 않는다", async () => {
    const outputDirectory = await secureTempRoot("define-no-output-");
    const adapter = queuedAdapter([
      completedAdapterResult({ outputText: null }),
      completedAdapterResult({
        responseId: "resp-define-production-2",
        outputText: null,
      }),
    ]);
    const dependencies: DefineStructureCommandDependencies = {
      createClient: vi.fn(() => ({})),
      createAdapter: vi.fn(() => adapter),
      runStructuring: (options) => runDefineStructuring({
        ...options,
        now: monotonicNow(),
      }),
      persistArtifact: persistDefineStructuringArtifact,
      loadPersistedArtifact: loadDefineStructuringArtifact,
    };

    const outcome = await executeDefineStructureCommand({
      environment: { OPENAI_API_KEY: testApiKey },
      outputDirectory,
      dependencies,
    });

    expect(adapter.invoke).toHaveBeenCalledTimes(2);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.summary.command_status).toBe("DEFINE_SUGGESTION_INCOMPLETE");
    expect(outcome.summary.attempt_count).toBe(2);
    expect(outcome.summary.challenge_locked).toBe(false);
    expect(outcome.serverAuthority).toBeNull();
    expect(outcome.summary.artifact_path).toMatch(/define-structuring--record-/);
  });

  it("오류와 process 출력에 환경 API key 원문을 남기지 않는다", async () => {
    const outputDirectory = await secureTempRoot("define-redaction-");
    const dependencies: DefineStructureCommandDependencies = {
      createClient: vi.fn(() => {
        throw new Error(`provider rejected ${testApiKey}`);
      }),
      createAdapter: vi.fn(),
      runStructuring: vi.fn(),
      persistArtifact: vi.fn(),
      loadPersistedArtifact: vi.fn(),
    };
    const runtime = new FakeStructureProcess({
      OPENAI_API_KEY: testApiKey,
      AI_DEFINE_STRUCTURING_OUTPUT_DIR: outputDirectory,
    });

    const outcome = await runDefineStructureProcess({
      runtime,
      executeCommand: (options) => executeDefineStructureCommand({
        ...options,
        dependencies,
      }),
    });

    expect(outcome?.exitCode).toBe(1);
    expect(JSON.stringify(outcome)).not.toContain(testApiKey);
    expect(runtime.stdoutText.join("")).not.toContain(testApiKey);
    expect(runtime.stderrText.join("")).not.toContain(testApiKey);
  });
});

describe("명시적 사람 승인과 Locked Challenge 분리", () => {
  it("비대화형 caller가 직접 호출할 approval executor나 ack 계산기를 export하지 않는다", async () => {
    const approvalModule = await import("../cli/approveSyntheticChallenge");
    const templateModule = await import(
      "../define/syntheticChallengeDefinition"
    );

    expect(approvalModule).not.toHaveProperty(
      "executeSyntheticChallengeApprovalCommand",
    );
    expect(approvalModule).not.toHaveProperty(
      "buildSyntheticChallengeApprovalAcknowledgement",
    );
    expect(approvalModule.runSyntheticChallengeApprovalProcess).toHaveLength(0);
    expect(templateModule).not.toHaveProperty(
      "SYNTHETIC_LOCKED_CHALLENGE_PACK",
    );
    expect(templateModule).not.toHaveProperty(
      "createSyntheticChallengeDefinition",
    );
    expect(Object.isFrozen(templateModule.SYNTHETIC_CHALLENGE_TEMPLATE))
      .toBe(true);
    expect(Object.isFrozen(
      templateModule.SYNTHETIC_CHALLENGE_TEMPLATE
        .approvedContract.sufficiency.mean_runtime_cost_usd,
    )).toBe(true);
    const contractHash = sha256CanonicalJson(
      templateModule.SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract,
    );
    expect(() => {
      const mutable = templateModule.SYNTHETIC_CHALLENGE_TEMPLATE
        .approvedContract.sufficiency.mean_runtime_cost_usd as {
          maximum: number;
        };
      mutable.maximum = 999;
    }).toThrow();
    expect(sha256CanonicalJson(
      templateModule.SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract,
    )).toBe(contractHash);
  });

  it("실제 비-PTY 자식 process는 artifact를 읽거나 lock을 만들기 전에 중단한다", async () => {
    const lockOutputDirectory =
      await secureTempRoot("define-approval-no-tty-lock-");
    const result = runApprovalCli({
      AI_DEFINE_STRUCTURING_ARTIFACT_PATH:
        "/nonexistent/define-structuring-artifact.json",
      AI_LOCKED_CHALLENGE_AUTHORITY_DIRECTORY: lockOutputDirectory,
    }, false);

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/TTY|대화형/i);
    expect(result.output).toContain(
      sha256CanonicalJson(SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract),
    );
    expect(await readdir(lockOutputDirectory)).toEqual([]);
  });

  it("정확한 artifact-bound acknowledgement 뒤에만 고정 contract를 인간 승인 lock으로 저장한다", async () => {
    const structuringOutputDirectory =
      await secureTempRoot("define-approval-source-");
    const lockParentDirectory =
      await secureTempRoot("define-approval-lock-parent-");
    const lockOutputDirectory = join(
      lockParentDirectory,
      "locked-challenge-approved",
    );
    const built = await completedArtifact();
    const persisted = await persistDefineStructuringArtifact({
      outputDirectory: structuringOutputDirectory,
      artifact: built,
    });
    const acknowledgement = [
      SYNTHETIC_CHALLENGE_APPROVAL_PREFIX,
      built.artifact_hash,
      sha256CanonicalJson(
        SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract,
      ),
    ].join(":");
    expect(acknowledgement.split(":")).toHaveLength(3);

    const baseEnvironment = {
      AI_DEFINE_STRUCTURING_OUTPUT_DIR: structuringOutputDirectory,
      AI_DEFINE_STRUCTURING_ARTIFACT_PATH: persisted.path,
      AI_LOCKED_CHALLENGE_AUTHORITY_DIRECTORY: lockOutputDirectory,
    };
    const rejected = runApprovalCli({
      ...baseEnvironment,
      [SYNTHETIC_CHALLENGE_APPROVAL_ACKNOWLEDGEMENT_ENV]: "WRONG",
    }, true);
    expect(rejected.output).toMatch(/CHALLENGE_APPROVAL_REJECTED/);
    expect(await readdir(lockParentDirectory)).not.toContain(
      "locked-challenge-approved",
    );

    const approved = runApprovalCli({
      ...baseEnvironment,
      [SYNTHETIC_CHALLENGE_APPROVAL_ACKNOWLEDGEMENT_ENV]: acknowledgement,
    }, true);
    expect(approved.output).toMatch(/LOCKED_CHALLENGE_READY/);
    expect(approved.output).toMatch(/EXPLICIT_HUMAN_APPROVAL/);
    expect(approved.output).toContain(built.artifact_hash);
    const reloaded = await loadLockedChallengeAuthorityRecord({
      outputDirectory: lockOutputDirectory,
      challengeId: "monomarket-support-ai-selection",
      challengeVersion: "v1",
    });
    expect(reloaded.pack.source_define_suggestion_hash)
      .toBe(sha256CanonicalJson(built.run_record.suggestion));
    expect(reloaded.pack.approved_contract)
      .toEqual(
        SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract,
      );
  });

  it("acknowledgement 불일치와 incomplete/refused artifact는 lock 저장 전에 fail-closed한다", async () => {
    const structuringOutputDirectory =
      await secureTempRoot("define-approval-denied-source-");
    const lockOutputDirectory =
      await secureTempRoot("define-approval-denied-lock-");
    const adapter = queuedAdapter([
      completedAdapterResult({
        status: "refused",
        outputText: null,
        error: "Synthetic request refused.",
      }),
    ]);
    const run = await runDefineStructuring({
      adapter,
      input: syntheticInput,
      now: monotonicNow(),
    });
    const incomplete = buildDefineStructuringArtifact({
      input: syntheticInput,
      run,
    });
    const persisted = await persistDefineStructuringArtifact({
      outputDirectory: structuringOutputDirectory,
      artifact: incomplete,
    });

    const wrongAck = runApprovalCli({
        AI_DEFINE_STRUCTURING_OUTPUT_DIR: structuringOutputDirectory,
        AI_DEFINE_STRUCTURING_ARTIFACT_PATH: persisted.path,
        AI_LOCKED_CHALLENGE_AUTHORITY_DIRECTORY: lockOutputDirectory,
        [SYNTHETIC_CHALLENGE_APPROVAL_ACKNOWLEDGEMENT_ENV]: "WRONG",
    }, true);
    expect(wrongAck.output).toMatch(/CHALLENGE_APPROVAL_REJECTED/);

    const exactAck = runApprovalCli({
        AI_DEFINE_STRUCTURING_OUTPUT_DIR: structuringOutputDirectory,
        AI_DEFINE_STRUCTURING_ARTIFACT_PATH: persisted.path,
        AI_LOCKED_CHALLENGE_AUTHORITY_DIRECTORY: lockOutputDirectory,
        [SYNTHETIC_CHALLENGE_APPROVAL_ACKNOWLEDGEMENT_ENV]:
          [
            SYNTHETIC_CHALLENGE_APPROVAL_PREFIX,
            incomplete.artifact_hash,
            sha256CanonicalJson(
              SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract,
            ),
          ].join(":"),
    }, true);
    expect(exactAck.output).toMatch(/CHALLENGE_APPROVAL_REJECTED/);
    expect(exactAck.output).toMatch(/complete|suggestion|완료/i);
  }, 15_000);
});

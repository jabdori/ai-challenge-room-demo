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
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const durabilityAudit = vi.hoisted(() => ({
  events: [] as string[],
  failDirectorySyncPath: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn(async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args);
      durabilityAudit.events.push(`mkdir:${String(args[0])}`);
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
          const stat = await handle.stat();
          const stringPath = String(path);
          durabilityAudit.events.push(
            `${stat.isDirectory() ? "directory" : "file"}-sync:${stringPath}`,
          );
          if (
            stat.isDirectory()
            && durabilityAudit.failDirectorySyncPath === stringPath
          ) {
            durabilityAudit.failDirectorySyncPath = null;
            throw new Error("simulated directory fsync failure");
          }
          return handle.sync();
        },
      };
    }),
  };
});
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../../eval/runtime/canonicalJson";
import {
  AuthoritativeRuntimePhaseReceiptIntegrityError,
  appendAuthoritativeRuntimePhaseReceipt,
  createAuthoritativeRuntimePhaseReceiptPaths,
  loadAuthoritativeRuntimePhaseChain,
  type AuthoritativeRuntimePhase,
} from "../authoritativeRuntimePhaseReceipt";

async function secureDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  return realpath(directory);
}

async function writeWrappedArtifact({
  directory,
  name,
  payload,
}: {
  readonly directory: string;
  readonly name: string;
  readonly payload: Readonly<Record<string, unknown>>;
}): Promise<{ readonly path: string; readonly payloadSha256: string }> {
  const payloadSha256 = sha256CanonicalJson(payload);
  const path = join(directory, name);
  await writeFile(
    path,
    `${canonicalJsonStringify({
      payload_sha256: payloadSha256,
      payload,
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return { path, payloadSha256 };
}

async function writeProjectionSnapshot({
  directory,
  name,
  sourcePayloadSha256,
  sourceId,
  state,
}: {
  readonly directory: string;
  readonly name: string;
  readonly sourcePayloadSha256: string;
  readonly sourceId: string;
  readonly state: string;
}): Promise<{ readonly path: string; readonly payloadSha256: string }> {
  const body = {
    schema_version: "workspace-projection-snapshot-v1",
    artifact_kind: "WORKSPACE_PROJECTION_SNAPSHOT",
    synthetic: true,
    source_chain: [{
      artifact_kind: "TEST_AUTHORITY_ARTIFACT",
      artifact_id: sourceId,
      payload_sha256: sourcePayloadSha256,
    }],
    projections: {
      workspace: {
        schema_version: "workspace-public-projection-v1",
        synthetic: true,
        state,
      },
      challenges: [],
      evidence: [],
      benchmark_progress: [],
      blind_reviews: [],
      decisions: [],
      baselines: [],
      regressions: [],
    },
  };
  const snapshotId = sha256CanonicalJson(body);
  const path = join(directory, name);
  await writeFile(
    path,
    `${canonicalJsonStringify({
      payload_sha256: snapshotId,
      payload: {
        ...body,
        snapshot_id: snapshotId,
      },
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return { path, payloadSha256: snapshotId };
}

async function sourceAndProjection(
  root: string,
  phase: string,
  suffix = "",
): Promise<{
  readonly artifact: {
    readonly artifactKind: string;
    readonly path: string;
    readonly payloadSha256: string;
  };
  readonly projectionSnapshot: {
    readonly path: string;
    readonly payloadSha256: string;
  };
}> {
  const artifact = await writeWrappedArtifact({
    directory: root,
    name: `${phase.toLowerCase()}${suffix}-artifact.json`,
    payload: {
      schema_version: "test-authority-artifact-v1",
      artifact_kind: "TEST_AUTHORITY_ARTIFACT",
      synthetic: true,
      phase,
      variant: suffix,
    },
  });
  const projection = await writeProjectionSnapshot({
    directory: root,
    name: `${phase.toLowerCase()}${suffix}-projection.json`,
    sourcePayloadSha256: artifact.payloadSha256,
    sourceId: `${phase.toLowerCase()}${suffix || "-default"}`,
    state: phase,
  });
  return {
    artifact: {
      artifactKind: "TEST_AUTHORITY_ARTIFACT",
      ...artifact,
    },
    projectionSnapshot: projection,
  };
}

async function appendPhase({
  outputDirectory,
  workflowId,
  phase,
  expectedPreviousReceiptSha256,
  suffix = "",
}: {
  readonly outputDirectory: string;
  readonly workflowId: string;
  readonly phase: AuthoritativeRuntimePhase;
  readonly expectedPreviousReceiptSha256: string | null;
  readonly suffix?: string;
}) {
  return appendAuthoritativeRuntimePhaseReceipt({
    outputDirectory,
    workflowId,
    phase,
    expectedPreviousReceiptSha256,
    ...await sourceAndProjection(outputDirectory, phase, suffix),
  });
}

describe("권위 runtime 단계 영수증", () => {
  it("DRAFT부터 previous hash 단일 체인으로 append하고 source에서 head를 복원한다", async () => {
    const outputDirectory = await secureDirectory(
      "authoritative-runtime-phase-",
    );
    const references = await sourceAndProjection(outputDirectory, "DRAFT");

    const persisted = await appendAuthoritativeRuntimePhaseReceipt({
      outputDirectory,
      workflowId: "customer-support-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
      ...references,
    });
    const loaded = await loadAuthoritativeRuntimePhaseChain({
      outputDirectory,
      workflowId: "customer-support-v1",
      expectedHeadReceiptSha256: persisted.receipt.receipt_sha256,
    });

    expect(loaded.receipts).toHaveLength(1);
    expect(loaded.head).toEqual(persisted.receipt);
    expect(loaded.head).toMatchObject({
      artifact_kind: "AUTHORITATIVE_RUNTIME_PHASE_RECEIPT",
      phase: "DRAFT",
      sequence: 0,
      previous_receipt_sha256: null,
      authority_artifact: {
        path: references.artifact.path,
        payload_sha256: references.artifact.payloadSha256,
      },
      projection_snapshot: {
        path: references.projectionSnapshot.path,
        payload_sha256: references.projectionSnapshot.payloadSha256,
      },
    });
  });

  it("정상 결정·무승인·무결성 실패 분기를 고정된 phase 순서로만 전진시킨다", async () => {
    const approvedRoot = await secureDirectory("phase-approved-");
    const approvedPhases: readonly AuthoritativeRuntimePhase[] = [
      "DRAFT",
      "PROPOSED",
      "LOCKED",
      "READY",
      "RUNNING",
      "REVIEW_PENDING",
      "HUMAN_CONFIRMED_REVIEW",
      "MEMO_REVIEW_REQUIRED",
      "DECISION_CONFIRMED",
      "REGRESSION_RECORDED",
    ];
    let approvedHead: string | null = null;
    for (const [sequence, phase] of approvedPhases.entries()) {
      const persisted = await appendPhase({
        outputDirectory: approvedRoot,
        workflowId: "approved-v1",
        phase,
        expectedPreviousReceiptSha256: approvedHead,
      });
      expect(persisted.receipt.sequence).toBe(sequence);
      expect(persisted.receipt.previous_receipt_sha256).toBe(approvedHead);
      expect((await lstat(persisted.receiptPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(persisted.receiptPath)).nlink).toBe(1);
      approvedHead = persisted.receipt.receipt_sha256;
    }
    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: approvedRoot,
      workflowId: "approved-v1",
      expectedHeadReceiptSha256: approvedHead ?? undefined,
    })).resolves.toMatchObject({
      head: { phase: "REGRESSION_RECORDED" },
    });

    const noApprovedRoot = await secureDirectory("phase-no-approved-");
    let noApprovedHead: string | null = null;
    for (const phase of approvedPhases.slice(0, 8)) {
      noApprovedHead = (await appendPhase({
        outputDirectory: noApprovedRoot,
        workflowId: "no-approved-v1",
        phase,
        expectedPreviousReceiptSha256: noApprovedHead,
      })).receipt.receipt_sha256;
    }
    noApprovedHead = (await appendPhase({
      outputDirectory: noApprovedRoot,
      workflowId: "no-approved-v1",
      phase: "NO_APPROVED_CANDIDATE",
      expectedPreviousReceiptSha256: noApprovedHead,
    })).receipt.receipt_sha256;
    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: noApprovedRoot,
      workflowId: "no-approved-v1",
      expectedHeadReceiptSha256: noApprovedHead,
    })).resolves.toMatchObject({
      head: { phase: "NO_APPROVED_CANDIDATE" },
    });

    const invalidRoot = await secureDirectory("phase-invalid-");
    let invalidHead: string | null = null;
    for (const phase of approvedPhases.slice(0, 5)) {
      invalidHead = (await appendPhase({
        outputDirectory: invalidRoot,
        workflowId: "invalid-v1",
        phase,
        expectedPreviousReceiptSha256: invalidHead,
      })).receipt.receipt_sha256;
    }
    invalidHead = (await appendPhase({
      outputDirectory: invalidRoot,
      workflowId: "invalid-v1",
      phase: "INVALID",
      expectedPreviousReceiptSha256: invalidHead,
    })).receipt.receipt_sha256;
    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: invalidRoot,
      workflowId: "invalid-v1",
      expectedHeadReceiptSha256: invalidHead,
    })).resolves.toMatchObject({ head: { phase: "INVALID" } });
  });

  it("RUNNING 실패 뒤 명시적 복구만 INVALID → READY → RUNNING으로 이어간다", async () => {
    const root = await secureDirectory("phase-resume-");
    let head: string | null = null;
    for (const phase of [
      "DRAFT",
      "PROPOSED",
      "LOCKED",
      "READY",
      "RUNNING",
      "INVALID",
    ] as const) {
      head = (await appendPhase({
        outputDirectory: root,
        workflowId: "resume-v1",
        phase,
        expectedPreviousReceiptSha256: head,
      })).receipt.receipt_sha256;
    }
    for (const phase of ["READY", "RUNNING", "REVIEW_PENDING"] as const) {
      head = (await appendPhase({
        outputDirectory: root,
        workflowId: "resume-v1",
        phase,
        expectedPreviousReceiptSha256: head,
        suffix: "-resume",
      })).receipt.receipt_sha256;
    }

    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: root,
      workflowId: "resume-v1",
      expectedHeadReceiptSha256: head ?? undefined,
    })).resolves.toMatchObject({
      head: { phase: "REVIEW_PENDING", sequence: 8 },
    });
  });

  it("단계 건너뛰기·rollback·terminal 이후 append·stale head를 모두 거부한다", async () => {
    const root = await secureDirectory("phase-transition-");
    const draft = await appendPhase({
      outputDirectory: root,
      workflowId: "transition-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
    });
    await expect(appendPhase({
      outputDirectory: root,
      workflowId: "transition-v1",
      phase: "LOCKED",
      expectedPreviousReceiptSha256: draft.receipt.receipt_sha256,
    })).rejects.toThrow(/전이|rollback|누락/i);
    await expect(appendPhase({
      outputDirectory: root,
      workflowId: "transition-v1",
      phase: "PROPOSED",
      expectedPreviousReceiptSha256: "f".repeat(64),
      suffix: "-stale",
    })).rejects.toThrow(/head/i);
    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: root,
      workflowId: "transition-v1",
      expectedHeadReceiptSha256: "e".repeat(64),
    })).rejects.toThrow(/head/i);

    const proposed = await appendPhase({
      outputDirectory: root,
      workflowId: "transition-v1",
      phase: "PROPOSED",
      expectedPreviousReceiptSha256: draft.receipt.receipt_sha256,
      suffix: "-valid",
    });
    await expect(appendPhase({
      outputDirectory: root,
      workflowId: "transition-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: proposed.receipt.receipt_sha256,
      suffix: "-rollback",
    })).rejects.toThrow(/전이|rollback/i);

    const terminalRoot = await secureDirectory("phase-terminal-");
    let head: string | null = null;
    for (const phase of [
      "DRAFT",
      "PROPOSED",
      "LOCKED",
      "READY",
      "RUNNING",
      "INVALID",
    ] as const) {
      head = (await appendPhase({
        outputDirectory: terminalRoot,
        workflowId: "terminal-v1",
        phase,
        expectedPreviousReceiptSha256: head,
      })).receipt.receipt_sha256;
    }
    await expect(appendPhase({
      outputDirectory: terminalRoot,
      workflowId: "terminal-v1",
      phase: "REVIEW_PENDING",
      expectedPreviousReceiptSha256: head,
    })).rejects.toThrow(/전이|terminal|INVALID/i);
  });

  it("이전 단계 projection snapshot을 다음 단계에 재사용하는 상태 rollback을 거부한다", async () => {
    const root = await secureDirectory("phase-projection-rollback-");
    const draftReferences = await sourceAndProjection(root, "DRAFT");
    const draft = await appendAuthoritativeRuntimePhaseReceipt({
      outputDirectory: root,
      workflowId: "projection-rollback-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
      ...draftReferences,
    });
    const proposedArtifact = (await sourceAndProjection(
      root,
      "PROPOSED",
    )).artifact;
    await expect(appendAuthoritativeRuntimePhaseReceipt({
      outputDirectory: root,
      workflowId: "projection-rollback-v1",
      phase: "PROPOSED",
      expectedPreviousReceiptSha256: draft.receipt.receipt_sha256,
      artifact: proposedArtifact,
      projectionSnapshot: draftReferences.projectionSnapshot,
    })).rejects.toThrow(/projection|rollback|재사용/i);
  });

  it("잘못된 genesis는 workflow directory도 만들지 않는다", async () => {
    const root = await secureDirectory("phase-invalid-genesis-");
    const paths = createAuthoritativeRuntimePhaseReceiptPaths({
      outputDirectory: root,
      workflowId: "invalid-genesis-v1",
      sequence: 0,
    });
    await expect(appendPhase({
      outputDirectory: root,
      workflowId: "invalid-genesis-v1",
      phase: "LOCKED",
      expectedPreviousReceiptSha256: null,
    })).rejects.toThrow(/DRAFT|시작|전이/i);
    await expect(lstat(paths.workflowDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("동시 같은 sequence append에서 정확히 하나만 공개해 fork를 만들지 않는다", async () => {
    const root = await secureDirectory("phase-concurrent-");
    const draft = await appendPhase({
      outputDirectory: root,
      workflowId: "concurrent-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
    });
    const results = await Promise.allSettled([
      appendPhase({
        outputDirectory: root,
        workflowId: "concurrent-v1",
        phase: "PROPOSED",
        expectedPreviousReceiptSha256: draft.receipt.receipt_sha256,
        suffix: "-one",
      }),
      appendPhase({
        outputDirectory: root,
        workflowId: "concurrent-v1",
        phase: "PROPOSED",
        expectedPreviousReceiptSha256: draft.receipt.receipt_sha256,
        suffix: "-two",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const loaded = await loadAuthoritativeRuntimePhaseChain({
      outputDirectory: root,
      workflowId: "concurrent-v1",
    });
    expect(loaded.receipts).toHaveLength(2);
    expect(loaded.head.phase).toBe("PROPOSED");
  });

  it("누락 sequence·알 수 없는 entry·receipt hardlink·symlink를 모호한 상태로 거부한다", async () => {
    const missingRoot = await secureDirectory("phase-missing-");
    const draft = await appendPhase({
      outputDirectory: missingRoot,
      workflowId: "missing-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
    });
    const proposed = await appendPhase({
      outputDirectory: missingRoot,
      workflowId: "missing-v1",
      phase: "PROPOSED",
      expectedPreviousReceiptSha256: draft.receipt.receipt_sha256,
    });
    const sequenceTwo = createAuthoritativeRuntimePhaseReceiptPaths({
      outputDirectory: missingRoot,
      workflowId: "missing-v1",
      sequence: 2,
    }).receiptPath;
    await rename(proposed.receiptPath, sequenceTwo);
    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: missingRoot,
      workflowId: "missing-v1",
    })).rejects.toThrow(/sequence|누락/i);

    const extraRoot = await secureDirectory("phase-extra-");
    const extraDraft = await appendPhase({
      outputDirectory: extraRoot,
      workflowId: "extra-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
    });
    await writeFile(
      join(extraDraft.workflowDirectory, "raw-oracle.json"),
      "{}\n",
      { flag: "wx", mode: 0o600 },
    );
    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: extraRoot,
      workflowId: "extra-v1",
    })).rejects.toThrow(/알 수 없는|불명확|entry/i);

    const hardlinkRoot = await secureDirectory("phase-hardlink-");
    const hardlinkDraft = await appendPhase({
      outputDirectory: hardlinkRoot,
      workflowId: "hardlink-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
    });
    await link(hardlinkDraft.receiptPath, join(hardlinkRoot, "outside-link.json"));
    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: hardlinkRoot,
      workflowId: "hardlink-v1",
    })).rejects.toThrow(/nlink1|regular 0600/i);

    const symlinkRoot = await secureDirectory("phase-symlink-");
    const symlinkDraft = await appendPhase({
      outputDirectory: symlinkRoot,
      workflowId: "symlink-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
    });
    const backup = join(symlinkRoot, "receipt-backup.json");
    await rename(symlinkDraft.receiptPath, backup);
    await symlink(backup, symlinkDraft.receiptPath);
    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: symlinkRoot,
      workflowId: "symlink-v1",
    })).rejects.toThrow(/symlink|path|불명확|entry/i);
  });

  it("존재하지 않거나 빈 체인과 symlink·잘못된 mode root를 hydration 상태로 추정하지 않는다", async () => {
    const absentRoot = await secureDirectory("phase-absent-");
    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: absentRoot,
      workflowId: "absent-v1",
    })).rejects.toThrow(/존재하지 않아|복원할 수 없습니다/i);

    const emptyRoot = await secureDirectory("phase-empty-");
    const emptyPaths = createAuthoritativeRuntimePhaseReceiptPaths({
      outputDirectory: emptyRoot,
      workflowId: "empty-v1",
      sequence: 0,
    });
    await mkdir(emptyPaths.workflowDirectory, { mode: 0o700 });
    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: emptyRoot,
      workflowId: "empty-v1",
    })).rejects.toThrow(/비어|불명확/i);

    const parent = await secureDirectory("phase-root-symlink-parent-");
    const outside = await secureDirectory("phase-root-symlink-target-");
    const linkedRoot = join(parent, "linked-root");
    await symlink(outside, linkedRoot);
    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: linkedRoot,
      workflowId: "linked-v1",
    })).rejects.toThrow(/0700|symlink/i);

    const modeRoot = await secureDirectory("phase-root-mode-");
    await chmod(modeRoot, 0o755);
    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: modeRoot,
      workflowId: "mode-v1",
    })).rejects.toThrow(/0700|symlink/i);
  });

  it("참조 artifact/projection의 path substitution·tamper·hardlink를 source reload에서 거부한다", async () => {
    const root = await secureDirectory("phase-reference-");
    const references = await sourceAndProjection(root, "DRAFT");
    const draft = await appendAuthoritativeRuntimePhaseReceipt({
      outputDirectory: root,
      workflowId: "reference-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
      ...references,
    });

    const artifactBackup = join(root, "artifact-backup.json");
    await rename(references.artifact.path, artifactBackup);
    const parsed = JSON.parse(await readFile(artifactBackup, "utf8"));
    parsed.payload.phase = "TAMPERED";
    await writeFile(
      references.artifact.path,
      `${canonicalJsonStringify(parsed)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: root,
      workflowId: "reference-v1",
    })).rejects.toThrow(/hash|canonical/i);

    await unlink(references.artifact.path);
    await rename(artifactBackup, references.artifact.path);
    await link(references.projectionSnapshot.path, join(root, "projection-link.json"));
    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: root,
      workflowId: "reference-v1",
    })).rejects.toThrow(/nlink1|regular 0600/i);

    expect((await lstat(draft.receiptPath)).nlink).toBe(1);
  });

  it("입력·저장 receipt의 extra key와 private key/oracle/credential 값을 거부한다", async () => {
    const inputRoot = await secureDirectory("phase-private-input-");
    const references = await sourceAndProjection(inputRoot, "DRAFT");
    const syntheticCredential = `sk-${"x".repeat(24)}`;
    await expect(appendAuthoritativeRuntimePhaseReceipt({
      outputDirectory: inputRoot,
      workflowId: "private-input-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
      artifact: {
        ...references.artifact,
        raw_oracle: { expected: "secret" },
      } as never,
      projectionSnapshot: references.projectionSnapshot,
    })).rejects.toThrow(/extra|oracle|계약/i);

    const credentialPath = join(
      inputRoot,
      `${syntheticCredential}-artifact.json`,
    );
    await writeFile(
      credentialPath,
      await readFile(references.artifact.path),
      { flag: "wx", mode: 0o600 },
    );
    await expect(appendAuthoritativeRuntimePhaseReceipt({
      outputDirectory: inputRoot,
      workflowId: "credential-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
      artifact: {
        ...references.artifact,
        path: credentialPath,
      },
      projectionSnapshot: references.projectionSnapshot,
    })).rejects.toThrow(/credential|path/i);

    const oracleRoot = await secureDirectory("phase-oracle-reference-");
    const oracleProjection = (await sourceAndProjection(
      oracleRoot,
      "DRAFT",
    )).projectionSnapshot;
    const oracleArtifact = await writeWrappedArtifact({
      directory: oracleRoot,
      name: "raw-oracle.json",
      payload: {
        schema_version: "raw-oracle-v1",
        artifact_kind: "RAW_ORACLE",
        synthetic: true,
      },
    });
    await expect(appendAuthoritativeRuntimePhaseReceipt({
      outputDirectory: oracleRoot,
      workflowId: "oracle-reference-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
      artifact: {
        artifactKind: "RAW_ORACLE",
        ...oracleArtifact,
      },
      projectionSnapshot: oracleProjection,
    })).rejects.toThrow(/oracle|private|허용/i);

    const compactOracleArtifact = await writeWrappedArtifact({
      directory: oracleRoot,
      name: "RawOracle.json",
      payload: {
        schema_version: "raw-oracle-v1",
        artifact_kind: "RAWORACLE",
        synthetic: true,
      },
    });
    await expect(appendAuthoritativeRuntimePhaseReceipt({
      outputDirectory: oracleRoot,
      workflowId: "compact-oracle-reference-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
      artifact: {
        artifactKind: "RAWORACLE",
        ...compactOracleArtifact,
      },
      projectionSnapshot: oracleProjection,
    })).rejects.toThrow(/oracle|private|허용/i);

    const nonEnumerableRoot = await secureDirectory("phase-non-enumerable-");
    const nonEnumerableReferences = await sourceAndProjection(
      nonEnumerableRoot,
      "DRAFT",
    );
    const artifactWithHiddenKey = {
      ...nonEnumerableReferences.artifact,
    };
    Object.defineProperty(artifactWithHiddenKey, "api_key", {
      enumerable: false,
      value: syntheticCredential,
    });
    await expect(appendAuthoritativeRuntimePhaseReceipt({
      outputDirectory: nonEnumerableRoot,
      workflowId: "non-enumerable-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
      artifact: artifactWithHiddenKey,
      projectionSnapshot: nonEnumerableReferences.projectionSnapshot,
    })).rejects.toThrow(/exact key|계약/i);

    const storedRoot = await secureDirectory("phase-private-stored-");
    const stored = await appendPhase({
      outputDirectory: storedRoot,
      workflowId: "private-stored-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
    });
    const original = JSON.parse(await readFile(stored.receiptPath, "utf8"));
    const forgedBody = {
      ...original.payload,
      raw_oracle: { candidate: "A" },
    };
    delete forgedBody.receipt_sha256;
    const forgedReceipt = {
      ...forgedBody,
      receipt_sha256: sha256CanonicalJson(forgedBody),
    };
    const forgedWrapper = {
      payload_sha256: forgedReceipt.receipt_sha256,
      payload: forgedReceipt,
    };
    const backup = join(storedRoot, "stored-receipt-backup.json");
    await rename(stored.receiptPath, backup);
    await writeFile(
      stored.receiptPath,
      `${canonicalJsonStringify(forgedWrapper)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: storedRoot,
      workflowId: "private-stored-v1",
    })).rejects.toThrow(/exact schema|계약/i);
  });

  it("실제 projection snapshot의 body hash·snapshot_id 계약을 검증한다", async () => {
    const root = await secureDirectory("phase-real-projection-");
    const artifact = await writeWrappedArtifact({
      directory: root,
      name: "draft-authority.json",
      payload: {
        schema_version: "test-authority-v1",
        artifact_kind: "TEST_AUTHORITY_ARTIFACT",
        synthetic: true,
      },
    });
    const projectionBody = {
      schema_version: "workspace-projection-snapshot-v1",
      artifact_kind: "WORKSPACE_PROJECTION_SNAPSHOT",
      synthetic: true,
      source_chain: [{
        artifact_kind: "TEST_AUTHORITY_ARTIFACT",
        artifact_id: "draft",
        payload_sha256: artifact.payloadSha256,
      }],
      projections: {
        workspace: {
          schema_version: "workspace-public-projection-v1",
          synthetic: true,
          state: "DRAFT",
        },
        challenges: [],
        evidence: [],
        benchmark_progress: [],
        blind_reviews: [],
        decisions: [],
        baselines: [],
        regressions: [],
      },
    };
    const snapshotId = sha256CanonicalJson(projectionBody);
    const projectionPath = join(root, "projection-record.json");
    await writeFile(
      projectionPath,
      `${canonicalJsonStringify({
        payload_sha256: snapshotId,
        payload: {
          ...projectionBody,
          snapshot_id: snapshotId,
        },
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );

    await expect(appendAuthoritativeRuntimePhaseReceipt({
      outputDirectory: root,
      workflowId: "real-projection-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
      artifact: {
        artifactKind: "TEST_AUTHORITY_ARTIFACT",
        ...artifact,
      },
      projectionSnapshot: {
        path: projectionPath,
        payloadSha256: snapshotId,
      },
    })).resolves.toMatchObject({
      receipt: {
        phase: "DRAFT",
        projection_snapshot: { payload_sha256: snapshotId },
      },
    });
  });

  it("snapshot_id가 없는 projection 모양의 일반 wrapper를 권위 projection으로 받지 않는다", async () => {
    const root = await secureDirectory("phase-malformed-projection-");
    const artifact = await writeWrappedArtifact({
      directory: root,
      name: "draft-authority.json",
      payload: {
        schema_version: "test-authority-v1",
        artifact_kind: "TEST_AUTHORITY_ARTIFACT",
        synthetic: true,
      },
    });
    const malformedProjection = await writeWrappedArtifact({
      directory: root,
      name: "malformed-projection.json",
      payload: {
        schema_version: "workspace-projection-snapshot-v1",
        artifact_kind: "WORKSPACE_PROJECTION_SNAPSHOT",
        synthetic: true,
      },
    });
    await expect(appendAuthoritativeRuntimePhaseReceipt({
      outputDirectory: root,
      workflowId: "malformed-projection-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
      artifact: {
        artifactKind: "TEST_AUTHORITY_ARTIFACT",
        ...artifact,
      },
      projectionSnapshot: malformedProjection,
    })).rejects.toThrow(/snapshot_id|projection snapshot|계약/i);
  });

  it("mtime이 역전돼도 sequence와 hash chain만으로 같은 head를 복원한다", async () => {
    const root = await secureDirectory("phase-mtime-");
    const draft = await appendPhase({
      outputDirectory: root,
      workflowId: "mtime-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
    });
    const proposed = await appendPhase({
      outputDirectory: root,
      workflowId: "mtime-v1",
      phase: "PROPOSED",
      expectedPreviousReceiptSha256: draft.receipt.receipt_sha256,
    });
    await utimes(draft.receiptPath, new Date("2035-01-01"), new Date("2035-01-01"));
    await utimes(
      proposed.receiptPath,
      new Date("2001-01-01"),
      new Date("2001-01-01"),
    );
    const loaded = await loadAuthoritativeRuntimePhaseChain({
      outputDirectory: root,
      workflowId: "mtime-v1",
    });
    expect(loaded.head.receipt_sha256).toBe(proposed.receipt.receipt_sha256);
    expect(loaded.receipts.map((receipt) => receipt.phase)).toEqual([
      "DRAFT",
      "PROPOSED",
    ]);
  });

  it("마지막 영수증이 삭제되면 durable head pin과 달라져 hydration을 거부한다", async () => {
    const root = await secureDirectory("phase-leaf-delete-");
    const draft = await appendPhase({
      outputDirectory: root,
      workflowId: "leaf-delete-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
    });
    const proposed = await appendPhase({
      outputDirectory: root,
      workflowId: "leaf-delete-v1",
      phase: "PROPOSED",
      expectedPreviousReceiptSha256: draft.receipt.receipt_sha256,
    });
    await unlink(proposed.receiptPath);
    await expect(loadAuthoritativeRuntimePhaseChain({
      outputDirectory: root,
      workflowId: "leaf-delete-v1",
    })).rejects.toThrow(/durable head pin|head/i);
  });

  it("workflow 디렉터리 생성 직후 output root fsync가 실패하면 fail-closed하고 재시도한다", async () => {
    const root = await secureDirectory("phase-fsync-");
    const references = await sourceAndProjection(root, "DRAFT");
    const paths = createAuthoritativeRuntimePhaseReceiptPaths({
      outputDirectory: root,
      workflowId: "fsync-v1",
      sequence: 0,
    });
    durabilityAudit.events.length = 0;
    durabilityAudit.failDirectorySyncPath = root;

    await expect(appendAuthoritativeRuntimePhaseReceipt({
      outputDirectory: root,
      workflowId: "fsync-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
      ...references,
    })).rejects.toBeInstanceOf(
      AuthoritativeRuntimePhaseReceiptIntegrityError,
    );
    expect(durabilityAudit.events).toContain(`mkdir:${paths.workflowDirectory}`);
    expect(durabilityAudit.events).toContain(`directory-sync:${root}`);

    durabilityAudit.events.length = 0;
    await expect(appendAuthoritativeRuntimePhaseReceipt({
      outputDirectory: root,
      workflowId: "fsync-v1",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
      ...references,
    })).resolves.toMatchObject({ receipt: { phase: "DRAFT" } });
    expect(durabilityAudit.events).toContain(`directory-sync:${root}`);
    expect(durabilityAudit.events).toContain(
      `directory-sync:${paths.workflowDirectory}`,
    );
  });
});

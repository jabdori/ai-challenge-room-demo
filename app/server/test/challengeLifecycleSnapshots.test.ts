// @vitest-environment node

import { describe, expect, it } from "vitest";
import { lstat, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYNTHETIC_CHALLENGE_TEMPLATE } from "../../eval/define/syntheticChallengeDefinition";
import { sha256CanonicalJson } from "../../eval/runtime/canonicalJson";
import {
  buildBenchmarkStartCommandReceipt,
  buildChallengeLifecycleProjectionSnapshot,
  buildPersistedBenchmarkProgressRecord,
  deriveStableBenchmarkId,
  loadBenchmarkStartCommandReceiptByAttemptIfPresent,
  loadBenchmarkStartCommandReceipt,
  parsePersistedBenchmarkProgressRecord,
  persistBenchmarkStartCommandReceipt,
  type ChallengeLifecycleSourceState,
} from "../challengeLifecycleSnapshots";

const now = "2026-07-17T12:00:00.000Z";
const later = "2026-07-17T12:01:00.000Z";

function stableId(lockedChallengePackHash: string): string {
  return deriveStableBenchmarkId({
    lockedChallengePackHash,
    hiddenDatasetHash: "9".repeat(64),
    scheduleId: "8".repeat(64),
  });
}

function draftState(): ChallengeLifecycleSourceState {
  return {
    phase: "DRAFT",
    defineInput: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
    defineArtifact: null,
    lockedChallengePack: null,
    benchmarkId: null,
    startReceipt: null,
    progress: null,
    failure: null,
  };
}

describe("Challenge lifecycle 공개 snapshot", () => {
  it("DRAFT projection에는 합성 업무 입력만 공개하고 숨은 평가 자료를 포함하지 않는다", () => {
    const snapshot = buildChallengeLifecycleProjectionSnapshot(draftState());
    const challenge = snapshot.projections.challenges[0];
    const workspace = snapshot.projections.workspace;

    expect(challenge).toMatchObject({
      schema_version: "challenge-public-projection-v1",
      synthetic: true,
      state: "DRAFT",
      authority: "NONE",
      define_status: "NOT_STARTED",
      approved_contract_hash: null,
      suggestion_summary: null,
    });
    expect(workspace).toMatchObject({
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
      stage_statuses: {
        define: "DRAFT",
        compare: "NOT READY",
        decide: "NOT READY",
        monitor: "NO BASELINE",
      },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /api[_-]?key|private_mapping|label_to_candidate|hidden_oracle|H-\d{3}/i,
    );
  });

  it("PROPOSED projection은 advisory suggestion과 별도 승인 대상 계약 hash를 구분한다", () => {
    const defineArtifact = {
      schema_version: "define-structuring-artifact-v1",
      artifact_kind: "DEFINE_STRUCTURING_ARTIFACT",
      synthetic: true,
      authority: "ADVISORY_ONLY",
      lock_authority: "NONE",
      human_approval_status: "REQUIRED",
      define_input: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
      run_record: {
        structuringStatus: "SUGGESTION_COMPLETE",
        suggestion: SYNTHETIC_CHALLENGE_TEMPLATE.advisorySuggestion,
      },
      artifact_hash: "a".repeat(64),
    } as ChallengeLifecycleSourceState["defineArtifact"];
    const snapshot = buildChallengeLifecycleProjectionSnapshot({
      ...draftState(),
      phase: "PROPOSED",
      defineArtifact,
    });
    const challenge = snapshot.projections.challenges[0];

    expect(challenge.state).toBe("PROPOSED");
    expect(challenge.authority).toBe("ADVISORY_ONLY");
    expect(challenge.define_status).toBe("SUGGESTION_READY");
    expect(challenge.suggestion_summary).toEqual({
      artifact_hash: "a".repeat(64),
      ...SYNTHETIC_CHALLENGE_TEMPLATE.advisorySuggestion,
    });
    expect(challenge.approved_contract_hash).toBe(
      sha256CanonicalJson(SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract),
    );
    expect(challenge.approved_contract_hash).not.toBe(
      sha256CanonicalJson(SYNTHETIC_CHALLENGE_TEMPLATE.advisorySuggestion),
    );
  });
});

describe("Benchmark lifecycle persistence 계약", () => {
  it("stable benchmark id는 같은 locked challenge hash에서 항상 동일하다", () => {
    const lockedHash = "b".repeat(64);
    expect(stableId(lockedHash)).toBe(
      stableId(lockedHash),
    );
    expect(stableId(lockedHash)).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("START/RESUME receipt가 사람 actor·source·이전 progress에 정확히 결합된다", () => {
    const lockedHash = "b".repeat(64);
    const benchmarkId = stableId(lockedHash);
    const start = buildBenchmarkStartCommandReceipt({
      benchmarkId,
      challengeId: "monomarket-support-ai-selection",
      challengeVersion: "v1",
      lockedChallengePackHash: lockedHash,
      actorLabel: "Evaluation lead",
      executionMode: "START",
      resumeFromProgressHash: null,
      attemptNumber: 1,
      previousStartReceiptHash: null,
      startedAt: now,
    });
    const resume = buildBenchmarkStartCommandReceipt({
      benchmarkId,
      challengeId: "monomarket-support-ai-selection",
      challengeVersion: "v1",
      lockedChallengePackHash: lockedHash,
      actorLabel: "Evaluation lead",
      executionMode: "RESUME",
      resumeFromProgressHash: "c".repeat(64),
      attemptNumber: 2,
      previousStartReceiptHash: start.receipt_hash,
      startedAt: later,
    });

    expect(start.resume_from_progress_hash).toBeNull();
    expect(start.actor_type).toBe("HUMAN");
    expect(resume).toMatchObject({
      execution_mode: "RESUME",
      resume_from_progress_hash: "c".repeat(64),
      previous_start_receipt_hash: start.receipt_hash,
      attempt_number: 2,
    });
    expect(resume.receipt_hash).not.toBe(start.receipt_hash);
  });

  it("사람 start command receipt를 canonical 0600 write-once 저장하고 source-reload한다", async () => {
    const outputDirectory = await realpath(
      await mkdtemp(join(tmpdir(), "benchmark-start-command-")),
    );
    const lockedHash = "b".repeat(64);
    const receipt = buildBenchmarkStartCommandReceipt({
      benchmarkId: stableId(lockedHash),
      challengeId: "monomarket-support-ai-selection",
      challengeVersion: "v1",
      lockedChallengePackHash: lockedHash,
      actorLabel: "Evaluation lead",
      executionMode: "START",
      resumeFromProgressHash: null,
      attemptNumber: 1,
      previousStartReceiptHash: null,
      startedAt: now,
    });

    const persisted = await persistBenchmarkStartCommandReceipt({
      outputDirectory,
      receipt,
    });
    const replay = await persistBenchmarkStartCommandReceipt({
      outputDirectory,
      receipt: structuredClone(receipt),
    });
    const reloaded = await loadBenchmarkStartCommandReceipt({
      outputDirectory,
      path: persisted.path,
      expectedReceipt: receipt,
    });
    const discovered =
      await loadBenchmarkStartCommandReceiptByAttemptIfPresent({
        outputDirectory,
        benchmarkId: receipt.benchmark_id,
        attemptNumber: 1,
      });

    expect(persisted.created).toBe(true);
    expect(replay).toEqual({ ...persisted, created: false });
    expect((await lstat(persisted.path)).mode & 0o777).toBe(0o600);
    expect(reloaded).toEqual(receipt);
    expect(reloaded).not.toBe(receipt);
    expect(discovered).toEqual({
      path: persisted.path,
      receipt,
    });
    await expect(loadBenchmarkStartCommandReceiptByAttemptIfPresent({
      outputDirectory,
      benchmarkId: receipt.benchmark_id,
      attemptNumber: 2,
    })).resolves.toBeNull();
  });

  it("진행 record는 72+12+33/33 전에는 COMPLETE를 허용하지 않는다", () => {
    const lockedHash = "b".repeat(64);
    const base = {
      benchmarkId: stableId(lockedHash),
      challengeId: "monomarket-support-ai-selection",
      lockedChallengePackHash: lockedHash,
      attemptNumber: 1,
      candidateExecutionCompleted: 71,
      auxiliaryJudgeCompleted: 12,
      cleanupAcknowledged: 33,
      updatedAt: later,
    } as const;

    expect(() => buildPersistedBenchmarkProgressRecord({
      ...base,
      status: "COMPLETE",
      resumeAllowed: false,
      resumeAction: "NONE",
      failure: null,
    })).toThrow(/72|COMPLETE|coverage/i);
  });

  it("source-reloaded progress만 parse하고 hash·cleanup arithmetic 변조를 거부한다", () => {
    const lockedHash = "b".repeat(64);
    const record = buildPersistedBenchmarkProgressRecord({
      benchmarkId: stableId(lockedHash),
      challengeId: "monomarket-support-ai-selection",
      lockedChallengePackHash: lockedHash,
      attemptNumber: 1,
      status: "RUNNING",
      candidateExecutionCompleted: 0,
      auxiliaryJudgeCompleted: 0,
      cleanupAcknowledged: 0,
      resumeAllowed: false,
      resumeAction: "NONE",
      failure: null,
      updatedAt: later,
    });

    expect(parsePersistedBenchmarkProgressRecord(record)).toEqual(record);
    expect(() => parsePersistedBenchmarkProgressRecord({
      ...record,
      cleanup: { ...record.cleanup, incomplete: 1 },
    })).toThrow(/cleanup|hash|무결성/i);
  });

  it("RUNNING progress는 canonical checkpoint source와 완료 count만 보존한다", () => {
    const lockedHash = "d".repeat(64);
    const record = buildPersistedBenchmarkProgressRecord({
      benchmarkId: stableId(lockedHash),
      challengeId: "monomarket-support-ai-selection",
      lockedChallengePackHash: lockedHash,
      attemptNumber: 1,
      status: "RUNNING",
      candidateExecutionCompleted: 1,
      auxiliaryJudgeCompleted: 0,
      cleanupAcknowledged: 0,
      checkpointSource: "EXECUTED",
      resumeAllowed: false,
      resumeAction: "NONE",
      failure: null,
      updatedAt: later,
    });

    expect(record).toMatchObject({
      candidate_execution: { completed: 1, total: 72 },
      checkpoint_source: "EXECUTED",
    });
  });
});

// @vitest-environment node

import { chmod, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SYNTHETIC_CHALLENGE_TEMPLATE } from "../../eval/define/syntheticChallengeDefinition";
import {
  buildChallengeLifecycleProjectionSnapshot,
  type ChallengeLifecycleSourceState,
} from "../challengeLifecycleSnapshots";
import {
  loadAuthoritativeRuntimeHydration,
  persistAndAppendAuthoritativeRuntimePhase,
} from "../authoritativeRuntimeHydration";

async function secureDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  return realpath(directory);
}

describe("권위 runtime hydration", () => {
  it("DRAFT source와 공개 snapshot을 write-once phase head에서 함께 복원한다", async () => {
    const authorityDirectory = await secureDirectory("runtime-hydration-authority-");
    const projectionDirectory = await secureDirectory("runtime-hydration-projection-");
    const state: ChallengeLifecycleSourceState = {
      phase: "DRAFT",
      defineInput: SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
      defineArtifact: null,
      lockedChallengePack: null,
      benchmarkId: null,
      startReceipt: null,
      progress: null,
      failure: null,
    };
    const snapshot = buildChallengeLifecycleProjectionSnapshot(state);
    await persistAndAppendAuthoritativeRuntimePhase({
      outputDirectory: authorityDirectory,
      projectionOutputDirectory: projectionDirectory,
      workflowId: "synthetic-recorded-challenge",
      phase: "DRAFT",
      expectedPreviousReceiptSha256: null,
      lifecycleState: state,
      projectionSnapshot: snapshot,
    });

    const hydrated = await loadAuthoritativeRuntimeHydration({
      outputDirectory: authorityDirectory,
      workflowId: "synthetic-recorded-challenge",
    });
    expect(hydrated?.artifact).toMatchObject({
      phase: "DRAFT",
      lifecycle_state: { phase: "DRAFT" },
    });
    expect(hydrated?.projectionSnapshot.snapshot_id).toBe(snapshot.snapshot_id);
  });
});

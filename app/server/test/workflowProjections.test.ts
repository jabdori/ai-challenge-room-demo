// @vitest-environment node

import { describe, expect, it } from "vitest";
import { LOCKED_CHALLENGE_FIXTURE } from "../../eval/test/helpers/lockedChallengeFixture";
import {
  buildLockedChallengePublicProjection,
  WorkflowProjectionIntegrityError,
} from "../workflowProjections";

describe("실제 권위 artifact의 browser projection", () => {
  it("authoritative Locked Challenge에서 Define 공개 projection을 만든다", () => {
    const projection = buildLockedChallengePublicProjection(
      LOCKED_CHALLENGE_FIXTURE,
    );
    expect(projection).toMatchObject({
      schema_version: "challenge-public-projection-v1",
      synthetic: true,
      challenge_id: "monomarket-support-ai-selection",
      challenge_version: "v1",
      state: "LOCKED",
      source_hash: LOCKED_CHALLENGE_FIXTURE.locked_challenge_pack_hash,
      authority: "EXPLICIT_HUMAN_APPROVAL",
    });
    expect(projection.task_contract).toEqual(
      LOCKED_CHALLENGE_FIXTURE.approved_contract.task_contract,
    );
    expect(projection.hard_gates).toHaveLength(4);
    expect(JSON.stringify(projection)).not.toMatch(
      /api[_-]?key|private_mapping|blinding_seed|hidden_oracle/i,
    );
  });

  it("구조만 복제한 Locked Challenge clone을 권위 artifact로 받지 않는다", () => {
    expect(() => buildLockedChallengePublicProjection(
      structuredClone(LOCKED_CHALLENGE_FIXTURE),
    )).toThrow(WorkflowProjectionIntegrityError);
  });
});

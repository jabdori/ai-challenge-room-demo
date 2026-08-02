import {
  createLockedChallengePack,
  type CreateLockedChallengePackInput,
} from "../../define/defineContracts";
import {
  createSyntheticChallengeTemplate,
} from "../../define/syntheticChallengeDefinition";
import { sha256CanonicalJson } from "../../runtime/canonicalJson";

export function createLockedChallengeFixtureBundle() {
  const template = createSyntheticChallengeTemplate();
  const creationInput: CreateLockedChallengePackInput = {
    defineInput: structuredClone(template.defineInput),
    defineSuggestion: structuredClone(template.advisorySuggestion),
    approval: {
      schema_version: "human-challenge-approval-v1",
      synthetic: true,
      actor_type: "HUMAN",
      actor_label: "Synthetic evaluation lead",
      decision: "APPROVE_EXACT_CONTRACT",
      approved_at: "2026-07-17T15:00:00.000Z",
      define_input_hash: sha256CanonicalJson(template.defineInput),
      define_suggestion_hash:
        sha256CanonicalJson(template.advisorySuggestion),
      approved_contract: structuredClone(template.approvedContract),
    },
  };
  return {
    creationInput,
    pack: createLockedChallengePack(creationInput),
  };
}

export function createLockedChallengeFixture() {
  return createLockedChallengeFixtureBundle().pack;
}

export const LOCKED_CHALLENGE_FIXTURE =
  createLockedChallengeFixture();

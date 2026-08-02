// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildExecutionBoundPrivateBlindMapping,
  buildJudgeEvidencePrecommitManifest,
  validateExecutionBoundPrivateBlindMapping,
  validateJudgeEvidencePrecommitManifest,
} from "../review/judgeEvidenceManifest";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

const EXECUTION_PACK_HASH = "a".repeat(64);
const MASTER_BLINDING_SEED = "master-blinding-seed-for-hidden-benchmark-0000000001";
const OTHER_MASTER_BLINDING_SEED = "different-master-seed-for-hidden-benchmark-00000002";
const CASE_IDS = Array.from(
  { length: 12 },
  (_, index) => `H-${String(index + 1).padStart(3, "0")}`,
);
const JUDGE_INPUT_BINDINGS = CASE_IDS.map((caseId) => ({
  case_id: caseId,
  judge_input_hash: sha256CanonicalJson({ case_id: caseId, fixture: "judge-input" }),
}));

describe("Judge 이전 실행 결합 blinding precommit", () => {
  it("12개 case를 하나의 master commitment와 서로 다른 case-domain mapping에 결합한다", () => {
    const manifest = buildJudgeEvidencePrecommitManifest({
      executionPackHash: EXECUTION_PACK_HASH,
      masterBlindingSeed: MASTER_BLINDING_SEED,
      judgeInputBindings: JUDGE_INPUT_BINDINGS,
    });
    const parsed = validateJudgeEvidencePrecommitManifest(manifest);
    const mappings = CASE_IDS.map((caseId) => buildExecutionBoundPrivateBlindMapping({
      caseId,
      executionPackHash: EXECUTION_PACK_HASH,
      masterBlindingSeed: MASTER_BLINDING_SEED,
    }));

    expect(parsed.case_bindings).toHaveLength(12);
    expect(new Set(mappings.map((mapping) => mapping.master_blinding_seed_commitment)))
      .toEqual(new Set([manifest.master_blinding_seed_commitment]));
    expect(new Set(mappings.map((mapping) => mapping.case_blinding_seed)).size).toBe(12);
    expect(mappings.every((mapping) => (
      mapping.execution_pack_hash === EXECUTION_PACK_HASH
      && mapping.private_mapping_hash === manifest.case_bindings.find(
        (binding) => binding.case_id === mapping.case_id,
      )?.private_mapping_hash
    ))).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain(MASTER_BLINDING_SEED);
    expect(JSON.stringify(manifest)).not.toMatch(/case_blinding_seed|label_to_candidate/i);
  });

  it("사후 case별 reblinding과 manifest·mapping 추가 필드를 거부한다", () => {
    const manifest = buildJudgeEvidencePrecommitManifest({
      executionPackHash: EXECUTION_PACK_HASH,
      masterBlindingSeed: MASTER_BLINDING_SEED,
      judgeInputBindings: JUDGE_INPUT_BINDINGS,
    });
    const postHocMapping = buildExecutionBoundPrivateBlindMapping({
      caseId: "H-001",
      executionPackHash: EXECUTION_PACK_HASH,
      masterBlindingSeed: OTHER_MASTER_BLINDING_SEED,
    });

    expect(() => validateExecutionBoundPrivateBlindMapping({
      input: postHocMapping,
      expectedCaseId: "H-001",
      expectedExecutionPackHash: EXECUTION_PACK_HASH,
      expectedMasterBlindingSeed: MASTER_BLINDING_SEED,
      expectedMasterCommitment: manifest.master_blinding_seed_commitment,
    })).toThrow(/commitment|seed|mapping|reblind|무결성/i);

    const manifestExtra = { ...manifest, master_blinding_seed: MASTER_BLINDING_SEED };
    expect(() => validateJudgeEvidencePrecommitManifest(manifestExtra)).toThrow(
      /exact|필드|key|additional|계약/i,
    );

    const mappingExtra = { ...postHocMapping, candidate_id: "A" };
    expect(() => validateExecutionBoundPrivateBlindMapping({
      input: mappingExtra,
      expectedCaseId: "H-001",
      expectedExecutionPackHash: EXECUTION_PACK_HASH,
      expectedMasterBlindingSeed: OTHER_MASTER_BLINDING_SEED,
      expectedMasterCommitment: postHocMapping.master_blinding_seed_commitment,
    })).toThrow(/exact|필드|key|additional|계약/i);
  });
});

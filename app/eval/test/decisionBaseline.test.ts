// @vitest-environment node

import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAuthoritativeDecisionBaselineRecord,
  assertAuthoritativeNoApprovedCandidateRecord,
  buildHumanConfirmedDecisionContext,
  persistDecisionAuthorityRecord,
  type DecisionAuthorityRecord,
} from "../decision/decisionBaseline";

describe("Decision baseline 권위 발급 경계", () => {
  it("구조만 닮은 Recorded Pack·Locked Challenge·Human receipt로 context를 만들 수 없다", () => {
    const fabricated = Object.freeze({
      schema_version: "fabricated-v1",
      synthetic: true,
    });
    expect(() => buildHumanConfirmedDecisionContext({
      recordedBenchmarkPack: fabricated as never,
      lockedChallengePack: fabricated as never,
      humanConfirmationReceipt: fabricated as never,
    })).toThrow(/authoritative|권위|검증|Recorded|Pack/i);
  });

  it("clone/fabricated record는 baseline과 no-approved validator 또는 persistence 권한을 얻지 못한다", async () => {
    const fabricated = Object.freeze({
      schema_version: "decision-authority-record-v1",
      artifact_kind: "DECISION_BASELINE_RECORD",
      baseline_version: `baseline_v1_${"a".repeat(64)}`,
    }) as unknown as DecisionAuthorityRecord;
    expect(() => assertAuthoritativeDecisionBaselineRecord(fabricated))
      .toThrow(/authoritative|DECISION_BASELINE|기준선/i);
    expect(() => assertAuthoritativeNoApprovedCandidateRecord(fabricated))
      .toThrow(/authoritative|NO_APPROVED|no-approved/i);

    const outputDirectory = await mkdtemp(
      join(tmpdir(), "fabricated-decision-authority-"),
    );
    await expect(persistDecisionAuthorityRecord({
      outputDirectory,
      record: fabricated,
      context: fabricated as never,
      recordedBenchmarkPack: fabricated as never,
      finalMemoPath: join(outputDirectory, "missing-memo"),
      finalConfirmationReceiptPath: join(
        outputDirectory,
        "missing-confirmation",
      ),
    })).rejects.toThrow(/authoritative|기준선|no-approved|검증/i);
    expect(await readdir(outputDirectory)).toEqual([]);
  });
});

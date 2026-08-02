// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { sha256CanonicalJson } from "../../eval/runtime/canonicalJson";
import type { RecordedBenchmarkPack } from "../../eval/pack/recordedBenchmarkPack";

vi.mock("../../eval/pack/recordedBenchmarkPack", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../eval/pack/recordedBenchmarkPack")
  >();
  return {
    ...actual,
    assertPersistedRecordedBenchmarkPack: vi.fn(),
  };
});

import {
  RecordedHardGateMatrixIntegrityError,
  buildRecordedHardGateMatrixProjection,
} from "../recordedHardGateMatrix";

const GATE_CODES = [
  "P0-HG-01",
  "P0-HG-02",
  "P0-HG-03",
  "P0-HG-04",
] as const;
const CANDIDATES = ["A", "B", "C"] as const;

type GateStatus = "PASS" | "CONFIRMED_FAIL" | "NOT_APPLICABLE";

interface SlotOverride {
  readonly candidateId: "A" | "B" | "C";
  readonly caseId: string;
  readonly repetition: 1 | 2;
  readonly gateCode: (typeof GATE_CODES)[number];
  readonly status: GateStatus;
  readonly riskCode?: string;
}

function hash(label: string): string {
  return sha256CanonicalJson({ label });
}

function makePack(overrides: readonly SlotOverride[] = []): RecordedBenchmarkPack {
  const slots = Array.from({ length: 12 }, (_, index) => (
    `H-${String(index + 1).padStart(3, "0")}`
  )).flatMap((caseId) => CANDIDATES.flatMap((candidateId) => (
    ([1, 2] as const).map((repetition) => {
      const gates = GATE_CODES.map((gateCode) => {
        const override = overrides.find((item) => (
          item.candidateId === candidateId
          && item.caseId === caseId
          && item.repetition === repetition
          && item.gateCode === gateCode
        ));
        const status = override?.status ?? "PASS";
        return {
          gateCode,
          status,
          findings: status === "CONFIRMED_FAIL"
            ? [{
                code: "LOCKED_FAILURE",
                message: "Locked deterministic finding.",
                evidenceIds: [
                  `case:${hash(`${caseId}:case`)}`,
                  `output:${hash(`${caseId}:${candidateId}:${repetition}:output`)}`,
                ],
              }]
            : [],
          riskCandidates: override?.riskCode === undefined
            ? []
            : [{
                code: override.riskCode,
                excerpt: "Grounded review signal.",
                evidenceIds: [
                  `case:${hash(`${caseId}:case`)}`,
                  `output:${hash(`${caseId}:${candidateId}:${repetition}:output`)}`,
                ],
              }],
        };
      });
      const slotIdentityHash = hash(`${caseId}:${candidateId}:${repetition}`);
      return {
        slot: {
          slot_id: `${caseId}--${candidateId}--r${repetition}`,
          sequence: 1,
          case_id: caseId,
          candidate_id: candidateId,
          repetition,
          candidate_position: 1,
        },
        slot_identity_hash: slotIdentityHash,
        intent_payload_sha256: hash(`${slotIdentityHash}:intent`),
        receipt_payload_sha256: hash(`${slotIdentityHash}:receipt`),
        checkpoint_payload_sha256: hash(`${slotIdentityHash}:checkpoint`),
        execution_status: "COMPLETE",
        request_disposition: "SENT_RESPONSE_RECORDED",
        cost_state: "COMPLETE",
        evaluation_state: { status: "EVALUATED", gates },
        usage_cost: null,
        total_latency_ms: 1,
        run: {},
        access_evidence: {},
        completed_execution_evidence: {},
      };
    })
  )));
  return {
    schema_version: "recorded-benchmark-pack-v1",
    artifact_kind: "RECORDED_BENCHMARK_PACK",
    source: "RECORDED_BENCHMARK",
    execution_status: "EXECUTION_COMPLETE",
    judge_status: "JUDGE_COMPLETE",
    review_status: "REVIEW_PENDING",
    evaluation_status: "EVALUATION_INCOMPLETE",
    baseline_version: null,
    synthetic: true,
    execution_hash: hash("execution"),
    execution_pack_hash: hash("execution-pack"),
    locked_challenge_pack_hash: hash("challenge"),
    locked_challenge_contract_hash: hash("contract"),
    locked_challenge_source_manifest_hash: hash("manifest"),
    precommit_manifest_digest: hash("precommit-digest"),
    precommit_manifest_hash: hash("precommit"),
    judge_evidence_pack_hash: hash("judge"),
    queue_content_hash: hash("queue-content"),
    queue_set_order_hash: hash("queue-order"),
    costs: {
      candidate_execution: {
        currency: "USD",
        accounted_runs: 72,
        total_usd: 1,
      },
      auxiliary_judge: {
        currency: "USD",
        accounted_cases: 12,
        total_usd: 1,
      },
    },
    coverage: {
      cases: 12,
      candidates: 3,
      runs_per_case: 2,
      candidate_runs: 72,
      judge_cases: 12,
      complete_judge_cases: 12,
      human_fallback_judge_cases: 0,
      review_items: 12,
    },
    benchmark_execution_pack: {
      schema_version: "benchmark-execution-pack-v1",
      artifact_kind: "BENCHMARK_EXECUTION_PACK",
      source: "RECORDED_BENCHMARK",
      execution_status: "EXECUTION_COMPLETE",
      evaluation_status: "EVALUATION_INCOMPLETE",
      review_status: "NOT_GENERATED",
      baseline_version: null,
      synthetic: true,
      judge_readiness: "READY_FOR_JUDGE",
      execution_hash: hash("execution"),
      locked_challenge_pack_hash: hash("challenge"),
      locked_challenge_contract_hash: hash("contract"),
      locked_challenge_source_manifest_hash: hash("manifest"),
      evaluator_contract_hash: hash("evaluator"),
      schedule_id: hash("schedule"),
      coverage: {
        cases: 12,
        candidates: 3,
        runs_per_case: 2,
        expected_runs: 72,
        recorded_runs: 72,
      },
      slots,
      candidate_aggregates: [],
    },
    judge_evidence_pack: {} as never,
    blind_review_queue: {} as never,
  } as RecordedBenchmarkPack;
}

function cell(
  projection: ReturnType<typeof buildRecordedHardGateMatrixProjection>,
  gateCode: (typeof GATE_CODES)[number],
  candidateId: "A" | "B" | "C",
) {
  return projection.rows
    .find((row) => row.gate_code === gateCode)!
    .candidates.find((candidate) => candidate.candidate_id === candidateId)!;
}

describe("Recorded Decide 4×3 hard-gate matrix", () => {
  it("72개 실제 slot gate를 후보별로 집계하고 실패를 검수보다 우선한다", () => {
    const pack = makePack([
      {
        candidateId: "A",
        caseId: "H-001",
        repetition: 1,
        gateCode: "P0-HG-01",
        status: "CONFIRMED_FAIL",
      },
      {
        candidateId: "A",
        caseId: "H-002",
        repetition: 1,
        gateCode: "P0-HG-01",
        status: "PASS",
        riskCode: "PRIVACY_REVIEW_SIGNAL",
      },
      {
        candidateId: "B",
        caseId: "H-003",
        repetition: 2,
        gateCode: "P0-HG-02",
        status: "PASS",
        riskCode: "POLICY_REVIEW_SIGNAL",
      },
      ...Array.from({ length: 12 }, (_, index): SlotOverride[] => {
        const caseId = `H-${String(index + 1).padStart(3, "0")}`;
        return ([1, 2] as const).map((repetition) => ({
          candidateId: "C",
          caseId,
          repetition,
          gateCode: "P0-HG-03",
          status: "NOT_APPLICABLE",
        }));
      }).flat(),
    ]);

    const projection = buildRecordedHardGateMatrixProjection(pack);

    expect(projection.rows).toHaveLength(4);
    expect(projection.rows.map((row) => row.gate_code)).toEqual(GATE_CODES);
    expect(projection.rows.every((row) => (
      row.candidates.map((candidate) => candidate.candidate_id).join(",") === "A,B,C"
    ))).toBe(true);
    expect(cell(projection, "P0-HG-01", "A")).toMatchObject({
      status: "CONFIRMED_FAIL",
      counts: {
        total_runs: 24,
        confirmed_fail_runs: 1,
        review_runs: 1,
      },
      evidence_action: null,
    });
    expect(cell(projection, "P0-HG-02", "B")).toMatchObject({
      status: "REVIEW",
      counts: { review_runs: 1 },
      evidence_action: null,
    });
    expect(cell(projection, "P0-HG-03", "C")).toMatchObject({
      status: "REVIEW",
      applicability: "NOT_APPLICABLE",
      counts: { not_applicable_runs: 24 },
    });
    expect(cell(projection, "P0-HG-04", "A")).toMatchObject({
      status: "PASS",
      applicability: "APPLICABLE",
      evidence_action: null,
    });
    expect(
      projection.rows.find((row) => row.gate_code === "P0-HG-04")
        ?.not_applicable_meaning,
    ).toMatch(/tool-free candidate.+not automatically NOT APPLICABLE/i);
    expect(projection.source_hash).toBe(sha256CanonicalJson(pack));
    expect(projection.rows[0].candidates[0].evidence_binding_hash)
      .toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(projection)).toBe(true);
  });

  it.each([
    ["missing slot", (pack: RecordedBenchmarkPack) => {
      (pack.benchmark_execution_pack.slots as unknown[]).pop();
    }],
    ["duplicate slot", (pack: RecordedBenchmarkPack) => {
      const slots = pack.benchmark_execution_pack.slots as unknown[];
      slots[1] = structuredClone(slots[0]);
    }],
    ["swapped gates", (pack: RecordedBenchmarkPack) => {
      const gates = (
        pack.benchmark_execution_pack.slots[0].evaluation_state.gates as unknown[]
      );
      [gates[0], gates[1]] = [gates[1], gates[0]];
    }],
    ["PASS with finding", (pack: RecordedBenchmarkPack) => {
      const gate = (
        pack.benchmark_execution_pack.slots[0].evaluation_state.gates as Array<
          Record<string, unknown>
        >
      )[0];
      gate.findings = [{
        code: "FORGED",
        message: "forged",
        evidenceIds: ["case:1", "output:2"],
      }];
    }],
    ["invalid slot hash", (pack: RecordedBenchmarkPack) => {
      (pack.benchmark_execution_pack.slots[0] as { slot_identity_hash: string })
        .slot_identity_hash = "not-a-hash";
    }],
  ])("누락·모순·변조를 fail-closed 처리한다: %s", (_name, tamper) => {
    const pack = structuredClone(makePack()) as RecordedBenchmarkPack;
    tamper(pack);

    expect(() => buildRecordedHardGateMatrixProjection(pack)).toThrow(
      RecordedHardGateMatrixIntegrityError,
    );
  });
});

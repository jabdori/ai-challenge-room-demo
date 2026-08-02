// @vitest-environment node

import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const regressionDirectoryCreationAudit = vi.hoisted(() => ({
  events: [] as string[],
  failSyncPath: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn(async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args);
      regressionDirectoryCreationAudit.events.push(
        `mkdir:${String(args[0])}`,
      );
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
          const stats = await handle.stat();
          if (stats.isDirectory()) {
            regressionDirectoryCreationAudit.events.push(
              `sync:${String(path)}`,
            );
            if (
              regressionDirectoryCreationAudit.failSyncPath === String(path)
            ) {
              regressionDirectoryCreationAudit.failSyncPath = null;
              throw new Error("simulated parent directory fsync failure");
            }
          }
          return handle.sync();
        },
      };
    }),
  };
});

import {
  buildRecordedRegressionPack,
  createRecordedRegressionPackPaths,
  loadRecordedRegressionPackFromSources,
  persistRecordedRegressionPack,
  type RegressionAuthorityChain,
  type RegressionResourceEvidence,
  type RegressionSlotRecord,
} from "../regression/regressionPack";
import {
  buildRegressionSchedule,
  type RegressionSufficiencyContract,
} from "../regression/runRegression";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import { canonicalJsonStringify } from "../runtime/canonicalJson";
import {
  buildRegressionEvidenceProjections,
  buildRegressionPublicProjection,
  WorkflowProjectionIntegrityError,
} from "../../server/workflowProjections";

function hash(label: string): string {
  return sha256CanonicalJson({ label });
}

const authority: RegressionAuthorityChain = {
  decision_baseline_record_hash: hash("decision"),
  recorded_benchmark_pack_hash: hash("benchmark"),
  human_confirmation_receipt_hash: hash("human"),
  final_decision_memo_hash: hash("memo"),
  final_decision_confirmation_receipt_hash: hash("final-confirmation"),
  locked_challenge_pack_hash: hash("challenge"),
  aggregation_hash: hash("aggregation"),
  baseline_version: `baseline_v1_${hash("baseline")}`,
  selected_candidate_identity_hash: hash("candidate"),
  deterministic_evaluator_contract_hash: hash("deterministic-evaluator"),
  evaluator_policy_manifest_hash: hash("evaluator-policy"),
  judge_request_contract_hash: hash("judge-request"),
  judge_evidence_pack_hash: hash("judge-evidence"),
  pricing_snapshot_hash: hash("pricing"),
  runner_contract_hash: hash("runner"),
  evidence_contract_hash: hash("evidence"),
};

const resources: RegressionResourceEvidence = {
  baseline: {
    status: "CLEANED",
    policy_resource_identity_hash: hash("baseline-resource"),
    manifest_hash: hash("baseline-manifest"),
    cleanup_receipt_hash: hash("baseline-cleanup"),
  },
  proposed: {
    status: "CLEANED",
    policy_resource_identity_hash: hash("proposed-resource"),
    manifest_hash: hash("proposed-manifest"),
    cleanup_receipt_hash: hash("proposed-cleanup"),
  },
};

const sufficiency: RegressionSufficiencyContract = {
  hidden_policy_minimum_correct: 11,
  hidden_citation_required_cases: 11,
  hidden_escalation_required_cases: 4,
  mean_runtime_cost_usd_maximum: 0.2,
  median_latency_ms_maximum: 10_000,
  worst_latency_ms_maximum: 30_000,
};

function passSlots(): RegressionSlotRecord[] {
  return buildRegressionSchedule("A").map((slot) => {
    const candidateOutput = {
        customer_reply: "Synthetic passing reply.",
        decision: {
          intent_codes: ["ORDER_STATUS"],
          action_code: "PROVIDE_ORDER_STATUS",
          escalation_required: false,
          escalation_reason_code: "NOT_REQUIRED",
          target_queue: "NONE",
        },
        citations: [],
      };
    return {
      schema_version: "regression-slot-record-v1",
      slot,
      slot_identity_hash: hash(`slot:${slot.slot_id}`),
      candidate_config_hash: hash(`config:${slot.version}:${slot.case_id}`),
      candidate_input_hash: hash(`input:${slot.version}:${slot.case_id}`),
      policy_corpus_hash: hash(`policy:${slot.version}`),
      raw_execution_evidence: {
        execution_status: "COMPLETE",
        evaluation_status: "EVALUATED",
        request_disposition: "SENT_RESPONSE_RECORDED",
        cost_state: "COMPLETE",
        candidate_cost_usd: 0.001,
        total_latency_ms: 100,
        output_hash: sha256CanonicalJson(candidateOutput),
        candidate_output: candidateOutput,
      provider_calls: [{
        call_number: 1,
        response_id_hash: hash(`response:${slot.slot_id}`),
        status: "completed",
        usage_hash: hash(`usage:${slot.slot_id}`),
        latency_ms: 100,
      }],
      retrieval_calls: [],
      tool_calls: [],
      access_evidence_hash: hash(`access:${slot.slot_id}`),
      },
      deterministic_evaluation: {
        hard_gate_failures: [],
        policy_decision_passed: true,
        citation_passed: true,
        escalation_passed: true,
      },
    };
  }) as RegressionSlotRecord[];
}

function packSource(slots = passSlots()) {
  return {
    authority,
    selectedCandidateId: "A",
    slots,
    sufficiency,
    datasetHashes: {
      hidden_dataset_hash: hash("hidden"),
      regression_canary_hash: hash("canary"),
    },
    versionIdentities: {
      baseline: {
        version: "BASELINE_V1",
        candidate_version: "candidate-a-benchmark-v1",
        candidate_configuration_set_hash: hash("v1-configs"),
        policy_corpus_hash: hash("BASELINE_V1-policy"),
        defect_profile: "NONE",
      },
      proposed: {
        version: "PROPOSED_V2",
        candidate_version: "candidate-a-regression-v2",
        candidate_configuration_set_hash: hash("v2-configs"),
        policy_corpus_hash: hash("PROPOSED_V2-policy"),
        defect_profile:
          "ACTIVE_RET_3_1_REMOVED_RETIRED_RET_3_3_EXPOSED",
      },
    },
    resources,
    createdAt: "2026-07-17T06:00:00.000Z",
  } as const;
}

function buildPack(slots = passSlots()) {
  return buildRecordedRegressionPack(packSource(slots));
}

function clearDeterministicEvaluation(slot: any): void {
  slot.deterministic_evaluation = {
    hard_gate_failures: [],
    policy_decision_passed: false,
    citation_passed: false,
    escalation_passed: false,
  };
}

describe("기록 회귀 팩 판정 계약", () => {
  it("선택 후보의 v1/v2 hidden 12 + canary 6 원시 증거 36개를 저장하고 반복 안정성을 주장하지 않는다", () => {
    const pack = buildPack();

    expect(pack).toMatchObject({
      artifact_kind: "RECORDED_REGRESSION_PACK",
      source: "RECORDED_REGRESSION",
      synthetic: true,
      evaluation_status: "EVALUATION_COMPLETE",
      verdict: "PASS",
      baseline_status_after: "ACTIVE",
      repeat_stability: {
        claimed: false,
        reason: "ONE_RUN_PER_VERSION_PER_CASE",
      },
      external_actions: {
        deployment_executed: false,
        rollback_executed: false,
        purchase_executed: false,
        contract_executed: false,
      },
      auxiliary_judge_usage: {
        executed: false,
        call_count: 0,
        cost_usd: 0,
      },
    });
    expect(pack.slots).toHaveLength(36);
    expect(pack.coverage).toEqual({
      hidden_cases_per_version: 12,
      canary_cases_per_version: 6,
      runs_per_case_per_version: 1,
      expected_runs: 36,
      recorded_runs: 36,
    });
    expect(pack.costs.candidate.call_count).toBe(36);
    expect(pack.costs.candidate.cost_usd).toBeCloseTo(0.036, 12);
    expect(pack.costs.auxiliary_judge).toEqual({
      executed: false,
      call_count: 0,
      cost_usd: 0,
      reason: "AUXILIARY_JUDGE_NOT_RUN_IN_REGRESSION_MODE",
    });
  });

  it("새 hard gate·terminal·canary·비용 외 충분성 실패를 BLOCK하고 관측되지 않은 결함을 꾸며내지 않는다", async () => {
    const hardGate: any[] = structuredClone(passSlots());
    hardGate.find((slot) => slot.slot.slot_id === "PROPOSED_V2--H-011")!
      .deterministic_evaluation.hard_gate_failures.push("P0-HG-02");
    const hardGatePack = buildPack(hardGate);
    expect(hardGatePack.verdict).toBe("BLOCK");
    expect(() => buildRegressionPublicProjection(hardGatePack)).toThrow(
      /Recorded Regression Pack|write-once|source|저장/i,
    );
    const projectionRoot = await mkdtemp(
      join(tmpdir(), "regression-projection-authority-"),
    );
    const projectionPersisted = await persistRecordedRegressionPack({
      outputDirectory: projectionRoot,
      pack: hardGatePack,
    });
    const persistedHardGatePack =
      await loadRecordedRegressionPackFromSources({
        path: projectionPersisted.path,
        source: packSource(hardGate),
      });
    const projection = buildRegressionPublicProjection(
      persistedHardGatePack,
    );
    expect(projection).toMatchObject({
      schema_version: "regression-public-projection-v1",
      synthetic: true,
      regression_id: persistedHardGatePack.regression_id,
      source_hash: sha256CanonicalJson(persistedHardGatePack),
      source: "RECORDED_REGRESSION",
      status: "RECORDED",
      verdict: "BLOCK",
      baseline_id: persistedHardGatePack.authority.baseline_version,
      baseline_version: "v1",
      baseline_candidate_id: "A",
      baseline_configuration_hash:
        persistedHardGatePack.versions.baseline.candidate_configuration_set_hash,
      proposed_configuration_hash:
        persistedHardGatePack.versions.proposed.candidate_configuration_set_hash,
      external_deployment_performed: false,
      external_rollback_performed: false,
    });
    expect(projection.new_hard_gate_failures).toEqual([{
      case_id: "H-011",
      gate_ids: ["P0-HG-02"],
      evidence_id: expect.stringMatching(/^regression_slot_[a-f0-9]{64}$/),
      baseline_status: "PASS",
      proposed_status: "CONFIRMED_FAIL",
    }]);
    expect(projection.evidence_bindings).toEqual([{
      schema_version: "regression-evidence-binding-v1",
      source_hash: projection.source_hash,
      evidence_id: projection.new_hard_gate_failures[0].evidence_id,
      evidence_binding_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      case_id: "H-011",
      candidate_id: "A",
      candidate_label: "Candidate A",
      version: "PROPOSED_V2",
      kind: "benchmark",
      source: "RECORDED REGRESSION",
    }]);
    expect(projection.blocking_reasons).toEqual([{
      code: "PROPOSED_CRITICAL_OR_NON_COST_REGRESSION",
      summary: expect.any(String),
      evidence_id: projection.new_hard_gate_failures[0].evidence_id,
    }]);
    const evidence = buildRegressionEvidenceProjections(
      persistedHardGatePack,
    );
    expect(evidence).toHaveLength(36);
    expect(evidence.find(
      (item) => item.evidence_id
        === projection.new_hard_gate_failures[0].evidence_id,
    )).toMatchObject({
      source: "RECORDED REGRESSION",
      status: "CONFIRMED FAIL",
      case_id: "H-011",
      candidate_label: "Candidate A",
      regression_version: "PROPOSED_V2",
      evidence_binding_hash:
        projection.evidence_bindings[0].evidence_binding_hash,
    });
    expect(() => buildRegressionPublicProjection(
      structuredClone(hardGatePack),
    )).toThrow(WorkflowProjectionIntegrityError);

    const terminal: any[] = structuredClone(passSlots());
    terminal.find((slot) => slot.slot.slot_id === "PROPOSED_V2--H-004")!
      .raw_execution_evidence.execution_status = "TIMEOUT";
    terminal.find((slot) => slot.slot.slot_id === "PROPOSED_V2--H-004")!
      .raw_execution_evidence.evaluation_status = "NOT_EVALUATED";
    terminal.find((slot) => slot.slot.slot_id === "PROPOSED_V2--H-004")!
      .raw_execution_evidence.candidate_output = null;
    clearDeterministicEvaluation(terminal.find(
      (slot) => slot.slot.slot_id === "PROPOSED_V2--H-004",
    )!);
    expect(buildPack(terminal).verdict).toBe("BLOCK");

    const canary: any[] = structuredClone(passSlots());
    canary.find((slot) => slot.slot.slot_id === "PROPOSED_V2--R-001")!
      .deterministic_evaluation.citation_passed = false;
    expect(buildPack(canary).verdict).toBe("BLOCK");

    const sufficiencyFailure: any[] = structuredClone(passSlots());
    sufficiencyFailure
      .filter((slot) => slot.slot.version === "PROPOSED_V2")
      .slice(0, 2)
      .forEach((slot) => {
        slot.deterministic_evaluation.policy_decision_passed = false;
      });
    expect(buildPack(sufficiencyFailure).verdict).toBe("BLOCK");

    // v2 결함 profile 자체는 실패 증거가 아닙니다.
    expect(buildPack(passSlots()).verdict).toBe("PASS");
  });

  it("비용·지연 한도만 넘으면 REVIEW이고 baseline control 불완전은 fail-closed EVALUATION_INCOMPLETE이다", () => {
    const costOnly: any[] = structuredClone(passSlots());
    costOnly
      .filter((slot) => slot.slot.version === "PROPOSED_V2")
      .forEach((slot) => {
        slot.raw_execution_evidence.candidate_cost_usd = 0.25;
      });
    const review = buildPack(costOnly);
    expect(review).toMatchObject({
      verdict: "REVIEW",
      evaluation_status: "EVALUATION_COMPLETE",
      baseline_status_after: "ACTIVE",
    });

    const incompleteBaseline: any[] = structuredClone(passSlots());
    const control = incompleteBaseline.find(
      (slot) => slot.slot.slot_id === "BASELINE_V1--H-001",
    )!;
    control.raw_execution_evidence.execution_status = "INVALID";
    control.raw_execution_evidence.evaluation_status = "NOT_EVALUATED";
    control.raw_execution_evidence.candidate_output = null;
    clearDeterministicEvaluation(control);
    const incomplete = buildPack(incompleteBaseline);
    expect(incomplete).toMatchObject({
      verdict: "EVALUATION_INCOMPLETE",
      evaluation_status: "EVALUATION_INCOMPLETE",
      baseline_status_after: "ACTIVE",
    });
  });

  it("공통 runner/evidence 무결성 실패는 EVALUATION_INCOMPLETE이고 후보 terminal 실패만 BLOCK한다", () => {
    const integrityFailure: any[] = structuredClone(passSlots());
    const corrupted = integrityFailure.find(
      (slot) => slot.slot.slot_id === "PROPOSED_V2--H-004",
    )!;
    corrupted.raw_execution_evidence.execution_status = "FAILED";
    corrupted.raw_execution_evidence.evaluation_status =
      "EVALUATION_INCOMPLETE";
    corrupted.raw_execution_evidence.cost_state = "COST_INCOMPLETE";
    corrupted.raw_execution_evidence.candidate_cost_usd = null;
    corrupted.raw_execution_evidence.candidate_output = null;
    clearDeterministicEvaluation(corrupted);
    expect(buildPack(integrityFailure)).toMatchObject({
      verdict: "EVALUATION_INCOMPLETE",
      evaluation_status: "EVALUATION_INCOMPLETE",
      decision_reasons: [
        "PROPOSED_RUNNER_OR_EVIDENCE_INTEGRITY_INCOMPLETE",
      ],
    });

    for (const status of [
      "INVALID",
      "TIMEOUT",
      "BUDGET_EXCEEDED",
    ] as const) {
      const candidateFailure: any[] = structuredClone(passSlots());
      const failed = candidateFailure.find(
        (slot) => slot.slot.slot_id === "PROPOSED_V2--H-004",
      )!;
      failed.raw_execution_evidence.execution_status = status;
      failed.raw_execution_evidence.evaluation_status = "NOT_EVALUATED";
      failed.raw_execution_evidence.candidate_output = null;
      clearDeterministicEvaluation(failed);
      expect(buildPack(candidateFailure).verdict).toBe("BLOCK");
    }
  });

  it("COMPLETE 원시 증거의 구조화 출력과 output hash 불일치를 거부한다", () => {
    const tampered: any[] = structuredClone(passSlots());
    tampered[0].raw_execution_evidence.candidate_output.customer_reply =
      "Tampered after hashing.";
    expect(() => buildPack(tampered)).toThrow(/output|hash|구조화|증거/i);

    const missing: any[] = structuredClone(passSlots());
    missing[0].raw_execution_evidence.candidate_output = null;
    expect(() => buildPack(missing)).toThrow(/output|COMPLETE|구조화|증거/i);
  });

  it("slot exact key와 status·cost·provider 조합을 source pack에서도 다시 검증한다", () => {
    const impossible: any[] = structuredClone(passSlots());
    impossible[0].raw_execution_evidence.request_disposition = "NOT_SENT";
    expect(() => buildPack(impossible)).toThrow(
      /status|disposition|provider|조합|terminal/i,
    );

    const extraKey: any[] = structuredClone(passSlots());
    extraKey[0].raw_execution_evidence.debug = "not-authority";
    expect(() => buildPack(extraKey)).toThrow(/exact|key|증거|shape/i);

    const invalidProvider: any[] = structuredClone(passSlots());
    invalidProvider[0].raw_execution_evidence.provider_calls[0]
      .usage_hash = "not-a-hash";
    expect(() => buildPack(invalidProvider)).toThrow(
      /provider|usage|hash/i,
    );
  });
});

describe("기록 회귀 팩 불변 저장", () => {
  it("새 회귀 artifact 디렉터리를 만든 직후 output root를 fsync한다", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "regression-directory-durability-"),
    );
    await chmod(outputDirectory, 0o700);
    const pack = buildPack();
    const paths = createRecordedRegressionPackPaths({
      outputDirectory,
      pack,
    });
    regressionDirectoryCreationAudit.events.length = 0;

    await persistRecordedRegressionPack({
      outputDirectory,
      pack,
    });

    expect(regressionDirectoryCreationAudit.events.filter((event) => (
      event === `mkdir:${paths.regressionDirectory}`
      || event === `sync:${outputDirectory}`
    ))).toEqual([
      `mkdir:${paths.regressionDirectory}`,
      `sync:${outputDirectory}`,
    ]);

    regressionDirectoryCreationAudit.events.length = 0;
    await expect(persistRecordedRegressionPack({
      outputDirectory,
      pack,
    })).rejects.toThrow(/replay|이미|존재/i);
    expect(regressionDirectoryCreationAudit.events.filter((event) => (
      event === `sync:${outputDirectory}`
    ))).toEqual([`sync:${outputDirectory}`]);
  });

  it("신규 회귀 디렉터리의 부모 fsync가 실패하면 첫 호출을 거부하고 EEXIST 재시도에서 다시 fsync한다", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "regression-directory-retry-"),
    );
    await chmod(outputDirectory, 0o700);
    const pack = buildPack();
    const paths = createRecordedRegressionPackPaths({
      outputDirectory,
      pack,
    });
    regressionDirectoryCreationAudit.failSyncPath = outputDirectory;

    await expect(persistRecordedRegressionPack({
      outputDirectory,
      pack,
    })).rejects.toThrow(/fsync|sync|simulated|저장|directory/i);
    expect((await lstat(paths.regressionDirectory)).isDirectory()).toBe(true);

    regressionDirectoryCreationAudit.events.length = 0;
    await persistRecordedRegressionPack({
      outputDirectory,
      pack,
    });
    expect(regressionDirectoryCreationAudit.events.filter((event) => (
      event === `sync:${outputDirectory}`
    ))).toEqual([
      `sync:${outputDirectory}`,
    ]);
  });

  it("content-addressed 0600 write-once record와 0700 디렉터리를 저장한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "regression-pack-"));
    await chmod(outputDirectory, 0o700);
    const pack = buildPack();
    const persisted = await persistRecordedRegressionPack({
      outputDirectory,
      pack,
    });
    const stat = await lstat(persisted.path);
    const directoryStat = await lstat(join(outputDirectory, pack.regression_id));

    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.nlink).toBe(1);
    expect(directoryStat.mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(persisted.path, "utf8"))).toEqual({
      payload_sha256: sha256CanonicalJson(pack),
      payload: pack,
    });
    await expect(persistRecordedRegressionPack({
      outputDirectory,
      pack,
    })).rejects.toThrow(/replay|이미|존재/i);
  });

  it("active authority·36 source slot·cleanup 증거에서 재빌드한 canonical bytes만 loader brand를 복원한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "regression-load-"));
    await chmod(outputDirectory, 0o700);
    const pack = buildPack();
    const persisted = await persistRecordedRegressionPack({
      outputDirectory,
      pack,
    });
    const loaded = await loadRecordedRegressionPackFromSources({
      path: persisted.path,
      source: packSource(),
    });
    expect(loaded).toEqual(pack);
    expect(sha256CanonicalJson(loaded)).toBe(sha256CanonicalJson(pack));

    const staleSlots: any[] = structuredClone(passSlots());
    staleSlots[18].raw_execution_evidence.candidate_cost_usd = 0.002;
    await expect(loadRecordedRegressionPackFromSources({
      path: persisted.path,
      source: packSource(staleSlots),
    })).rejects.toThrow(/source|canonical|bytes|경로|일치/i);
  });

  it("link 공개 뒤 temp unlink 전에 중단된 nlink=2 artifact만 안전하게 복구한다", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "regression-pack-interrupted-publish-"),
    );
    await chmod(outputDirectory, 0o700);
    const pack = buildPack();
    const persisted = await persistRecordedRegressionPack({
      outputDirectory,
      pack,
    });
    const paths = createRecordedRegressionPackPaths({
      outputDirectory,
      pack,
    });
    await link(
      paths.recordPath,
      join(
        paths.regressionDirectory,
        `.${paths.recordPath.split("/").at(-1)}.tmp-100-safe-recovery`,
      ),
    );

    const loaded = await loadRecordedRegressionPackFromSources({
      path: persisted.path,
      source: packSource(),
    });

    expect(loaded).toEqual(pack);
    expect((await lstat(persisted.path)).nlink).toBe(1);
  });

  it("claim-only half-state는 같은 payload로만 복구하고 동시 공개에서는 하나만 성공한다", async () => {
    const halfRoot = await mkdtemp(join(tmpdir(), "regression-half-state-"));
    await chmod(halfRoot, 0o700);
    const pack = buildPack();
    const paths = createRecordedRegressionPackPaths({
      outputDirectory: halfRoot,
      pack,
    });
    await mkdir(paths.regressionDirectory, { mode: 0o700 });
    const claim = {
      schema_version: "recorded-regression-pack-claim-v1",
      artifact_kind: "RECORDED_REGRESSION_PACK_CLAIM",
      regression_id: pack.regression_id,
      payload_sha256: sha256CanonicalJson(pack),
    };
    await writeFile(paths.claimPath, `${canonicalJsonStringify({
      payload_sha256: sha256CanonicalJson(claim),
      payload: claim,
    })}\n`, { mode: 0o600 });
    const recovered = await persistRecordedRegressionPack({
      outputDirectory: halfRoot,
      pack,
    });
    expect(recovered.path).toBe(paths.recordPath);

    const raceRoot = await mkdtemp(join(tmpdir(), "regression-race-"));
    await chmod(raceRoot, 0o700);
    const outcomes = await Promise.allSettled([
      persistRecordedRegressionPack({ outputDirectory: raceRoot, pack }),
      persistRecordedRegressionPack({ outputDirectory: raceRoot, pack }),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
  });

  it("tamper·symlink·hard-link·mode·같은 source의 다른 payload와 경쟁 저장을 거부한다", async () => {
    const pack = buildPack();

    const tamperRoot = await mkdtemp(join(tmpdir(), "regression-tamper-"));
    await chmod(tamperRoot, 0o700);
    const tamperPaths = createRecordedRegressionPackPaths({
      outputDirectory: tamperRoot,
      pack,
    });
    await mkdir(tamperPaths.regressionDirectory, { mode: 0o700 });
    await writeFile(tamperPaths.recordPath, "{}\n", { mode: 0o600 });
    await expect(persistRecordedRegressionPack({
      outputDirectory: tamperRoot,
      pack,
    })).rejects.toThrow(/tamper|bytes|내용|일치|replay/i);

    const symlinkRoot = await mkdtemp(join(tmpdir(), "regression-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "regression-outside-"));
    await chmod(symlinkRoot, 0o700);
    const symlinkPaths = createRecordedRegressionPackPaths({
      outputDirectory: symlinkRoot,
      pack,
    });
    await symlink(outside, symlinkPaths.regressionDirectory);
    await expect(persistRecordedRegressionPack({
      outputDirectory: symlinkRoot,
      pack,
    })).rejects.toThrow(/symlink|디렉터리|directory/i);

    const hardLinkRoot = await mkdtemp(join(tmpdir(), "regression-hardlink-"));
    await chmod(hardLinkRoot, 0o700);
    const first = await persistRecordedRegressionPack({
      outputDirectory: hardLinkRoot,
      pack,
    });
    const linked = join(hardLinkRoot, "attacker-link.json");
    await link(first.path, linked);
    await expect(persistRecordedRegressionPack({
      outputDirectory: hardLinkRoot,
      pack,
    })).rejects.toThrow(/nlink|hard.?link|replay|무결성/i);

    const modeRoot = await mkdtemp(join(tmpdir(), "regression-mode-"));
    await chmod(modeRoot, 0o700);
    const modePersisted = await persistRecordedRegressionPack({
      outputDirectory: modeRoot,
      pack,
    });
    await chmod(modePersisted.path, 0o644);
    await expect(persistRecordedRegressionPack({
      outputDirectory: modeRoot,
      pack,
    })).rejects.toThrow(/0600|mode|file|replay/i);
  });
});

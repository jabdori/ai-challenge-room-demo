// @vitest-environment node

import {
  chmod,
  link,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../decision/decisionBaseline", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../decision/decisionBaseline")
  >();
  return {
    ...actual,
    assertAuthoritativeDecisionBaselineRecord: () => undefined,
  };
});
import type { DecisionBaselineRecord } from "../decision/decisionBaseline";
import type { CandidateOutput } from "../contracts/candidateOutput";
import { candidateOutputJsonSchema } from "../contracts/candidateOutput";
import {
  buildRegressionSchedule,
  buildRegressionResourceAuthorityBinding,
  buildRegressionVersionContexts,
  buildValidatedRegressionResourceCleanupEvidence,
  buildValidatedRegressionResourceCleanupEvidenceForTest,
  createRegressionCandidateExecutor,
  loadRecordedRegressionFromAuthority,
  runRecordedRegression,
  type RegressionRunnerDependencies,
  type RegressionSufficiencyContract,
} from "../regression/runRegression";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  BENCHMARK_ORACLES,
  REGRESSION_CANARY_ORACLES,
} from "../data/benchmark";
import type { CandidateAdapter } from "../runner/types";

function hash(label: string): string {
  return sha256CanonicalJson({ label });
}

function baselineRecord(
  candidateId: "A" | "B" | "C" = "A",
): DecisionBaselineRecord {
  const canonicalBaselineContexts = buildRegressionVersionContexts(candidateId)
    .filter((context) => (
      context.slot.version === "BASELINE_V1"
      && context.slot.dataset_split === "HIDDEN_BENCHMARK"
    ));
  return {
    schema_version: "decision-authority-record-v1",
    artifact_kind: "DECISION_BASELINE_RECORD",
    synthetic: true,
    decision_id: `decision_${hash("decision")}`,
    recorded_benchmark_pack_hash: hash("benchmark"),
    human_confirmation_receipt_hash: hash("human"),
    final_decision_memo_hash: hash("memo"),
    final_decision_confirmation_receipt_hash: hash("final-confirmation"),
    locked_challenge_pack_hash: hash("challenge"),
    aggregation_hash: hash("aggregation"),
    selection_rationale: "Synthetic test selection.",
    decided_by: "Test owner",
    decided_at: "2026-07-17T05:00:00.000Z",
    evaluator_identities: {
      deterministic_evaluator_contract_hash: hash("deterministic"),
      evaluator_policy_manifest_hash: hash("evaluator-policy"),
      judge_request_contract_hash: hash("judge-request"),
      judge_evidence_pack_hash: hash("judge-evidence"),
      decision_memo_adapter_contract_hash: hash("memo-adapter"),
    },
    external_actions: {
      purchase_executed: false,
      contract_executed: false,
      deployment_executed: false,
      rollback_executed: false,
    },
    decision_status: "HUMAN_CONFIRMED",
    selected_candidate_id: candidateId,
    baseline_version: `baseline_v1_${hash("baseline")}`,
    baseline_status: "ACTIVE",
    selected_candidate_identity: {
      candidate_id: candidateId,
      candidate_version: `candidate-${candidateId.toLowerCase()}-benchmark-v1`,
      candidate_slot_identity_hashes: Array.from(
        { length: 24 },
        (_, index) => hash(`slot-${candidateId}-${index}`),
      ),
      candidate_config_hashes: canonicalBaselineContexts.map(
        (context) => context.candidate_config_hash,
      ),
      system_prompt_hash: canonicalBaselineContexts[0].system_prompt_hash,
      output_schema_hash: sha256CanonicalJson(candidateOutputJsonSchema),
      dataset_hash: hash("dataset"),
      pricing_snapshot_hash: hash("pricing"),
      evaluator_contract_hash: hash("deterministic"),
      evaluator_policy_manifest_hash: hash("evaluator-policy"),
      runner_contract_hash: hash("runner"),
      evidence_contract_hash: hash("evidence"),
      execution_hash: hash("execution"),
    },
  };
}

const sufficiency: RegressionSufficiencyContract = {
  hidden_policy_minimum_correct: 11,
  hidden_citation_required_cases: 11,
  hidden_escalation_required_cases: 4,
  mean_runtime_cost_usd_maximum: 0.2,
  median_latency_ms_maximum: 10_000,
  worst_latency_ms_maximum: 30_000,
};

const canonicalTestExecutor = createRegressionCandidateExecutor({
  adapterFor: (request): CandidateAdapter => {
    const oracle = request.slot.case_id.startsWith("H-")
      ? BENCHMARK_ORACLES.find(
        (item) => item.case_id === request.slot.case_id,
      )!
      : REGRESSION_CANARY_ORACLES.find(
        (item) => item.case_id === request.slot.case_id,
      )!;
    const observedInjectedDefect = (
      request.slot.version === "PROPOSED_V2"
      && request.slot.case_id === "H-011"
    );
    const output: CandidateOutput = {
      customer_reply: observedInjectedDefect
        ? "I confirm that the 14-day policy applies, so this return is denied."
        : oracle.reference_replies[0],
      decision: {
        intent_codes: [...oracle.expected_intent_codes],
        action_code: observedInjectedDefect
          ? "DENY_RETURN"
          : oracle.expected_action_code,
        escalation_required: oracle.escalation_required,
        escalation_reason_code: oracle.escalation_reason_code,
        target_queue: oracle.target_queue,
      },
      citations: observedInjectedDefect
        ? [{ source_id: "RET", section_id: "3.3" }]
        : structuredClone(oracle.required_citations),
    };
    return {
      invoke: async () => ({
        responseId: `resp-${request.slot.slot_id}`,
        status: "completed",
        modelReportedId: "gpt-5.6-terra-2026-07-17",
        serviceTierReported: "default",
        outputText: JSON.stringify(output),
        usage: {
          inputTokens: 100,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 20,
        },
        executionEvidence: {
          providerCalls: [{
            callNumber: 1,
            responseId: `resp-${request.slot.slot_id}`,
            status: "completed",
            modelRequestedId: "gpt-5.6-terra",
            modelReportedId: "gpt-5.6-terra-2026-07-17",
            serviceTierRequested: "default",
            serviceTierReported: "default",
            latencyMs: 10,
            usage: {
              inputTokens: 100,
              cachedInputTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 20,
            },
          }],
          retrievalCalls: [],
          toolCalls: [],
        },
      }),
    };
  },
});

function completeExecution(
  request: Parameters<RegressionRunnerDependencies["executeCandidate"]>[0],
) {
  return canonicalTestExecutor(request);
}

function testDependencies(
  executeCandidate: RegressionRunnerDependencies["executeCandidate"] =
    vi.fn((request) => completeExecution(request)),
): RegressionRunnerDependencies {
  return {
    assertBaselineRecord: () => undefined,
    executeCandidate,
    resourceEvidence: async ({
      selectedCandidateId,
      authorityBinding,
    }) => (
      selectedCandidateId === "A"
        ? buildValidatedRegressionResourceCleanupEvidence({
          selectedCandidateId,
          baseline: null,
          proposed: null,
          authorityBinding,
        })
        : buildValidatedRegressionResourceCleanupEvidenceForTest({
          selectedCandidateId,
          authorityBinding,
          baseline: {
            policy_resource_identity_hash: hash("baseline-resource"),
            manifest_hash: hash("baseline-manifest"),
            vector_store_id: "vs-regression-baseline",
            uploaded_file_ids: ["file-baseline"],
            cleanup: {
              vectorStore: {
                id: "vs-regression-baseline",
                attempted: true,
                deleted: true,
              },
              uploadedFiles: [{
                id: "file-baseline",
                attempted: true,
                deleted: true,
              }],
            },
          },
          proposed: {
            policy_resource_identity_hash: hash("proposed-resource"),
            manifest_hash: hash("proposed-manifest"),
            vector_store_id: "vs-regression-proposed",
            uploaded_file_ids: ["file-proposed"],
            cleanup: {
              vectorStore: {
                id: "vs-regression-proposed",
                attempted: true,
                deleted: true,
              },
              uploadedFiles: [{
                id: "file-proposed",
                attempted: true,
                deleted: true,
              }],
            },
          },
        })
    ),
  };
}

describe("기록 회귀 실행 계약", () => {
  it("authoritative ACTIVE baseline이 없으면 원격 후보 실행 전에 거절한다", async () => {
    const remote = vi.fn();
    await expect(runRecordedRegression({
      outputDirectory: await mkdtemp(join(tmpdir(), "regression-no-baseline-")),
      decisionBaselineRecord: {} as DecisionBaselineRecord,
      sufficiency,
      dependencies: {
        ...testDependencies(remote),
        assertBaselineRecord: () => {
          throw new TypeError("authoritative baseline required");
        },
      },
    })).rejects.toThrow(/baseline|required/i);
    expect(remote).not.toHaveBeenCalled();
  });

  it.each(
    (["A", "B", "C"] as const).flatMap((candidateId) => (
      Array.from({ length: 12 }, (_, caseIndex) => ({
        candidateId,
        caseIndex,
      }))
    )),
  )(
    "Candidate $candidateId v1 H-$caseIndex 승인 config hash 불일치는 원격 0회로 거절한다",
    async ({ candidateId, caseIndex }) => {
      const outputDirectory = await mkdtemp(
        join(tmpdir(), "regression-config-mismatch-"),
      );
      await chmod(outputDirectory, 0o700);
      const record = structuredClone(baselineRecord(candidateId));
      (
        record.selected_candidate_identity.candidate_config_hashes as string[]
      )[caseIndex] = hash(`tampered-${candidateId}-${caseIndex}`);
      const remote = vi.fn(async (request) => completeExecution(request));
      await expect(runRecordedRegression({
        outputDirectory,
        decisionBaselineRecord: record,
        sufficiency,
        dependencies: testDependencies(remote),
      })).rejects.toThrow(/canonical|config|identity|후보/i);
      expect(remote).not.toHaveBeenCalled();
    },
  );

  it("선택 후보만 v1/v2 × hidden12+canary6 총 36회 실행하고 canary를 선정 근거에 섞지 않는다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "regression-run-"));
    await chmod(outputDirectory, 0o700);
    const executeCandidate = vi.fn(async (request) => completeExecution(request));
    const result = await runRecordedRegression({
      outputDirectory,
      decisionBaselineRecord: baselineRecord("A"),
      sufficiency,
      dependencies: testDependencies(executeCandidate),
      createdAt: "2026-07-17T06:00:00.000Z",
    });

    expect(executeCandidate).toHaveBeenCalledTimes(36);
    expect(executeCandidate.mock.calls.every(
      ([request]) => request.selected_candidate_id === "A",
    )).toBe(true);
    expect(result.pack.slots).toHaveLength(36);
    expect(result.pack.selection_evidence).toEqual({
      source: "RECORDED_BENCHMARK_ONLY",
      regression_canaries_used_for_selection: false,
    });
    expect(result.pack.baseline_status_after).toBe("ACTIVE");
    expect(result.pack.verdict).toBe("BLOCK");
    expect(
      result.pack.slots.find(
        (slot) => slot.slot.slot_id === "PROPOSED_V2--H-011",
      )!.deterministic_evaluation.hard_gate_failures,
    ).toContain("P0-HG-02");
  });

  it("구조만 닮은 raw 실행 결과와 조작된 gate boolean은 executor receipt 권한을 얻지 못한다", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "regression-forged-execution-"),
    );
    await chmod(outputDirectory, 0o700);
    const forged = vi.fn(async () => ({
      execution_status: "COMPLETE",
      evaluation_status: "EVALUATED",
      deterministic_evaluation: {
        hard_gate_failures: [],
        policy_decision_passed: true,
        citation_passed: true,
        escalation_passed: true,
      },
    }));
    await expect(runRecordedRegression({
      outputDirectory,
      decisionBaselineRecord: baselineRecord("A"),
      sufficiency,
      dependencies: {
        ...testDependencies(),
        executeCandidate: forged as unknown as
          RegressionRunnerDependencies["executeCandidate"],
      },
    })).rejects.toThrow(/branded|executor|receipt|canonical/i);
    expect(forged).toHaveBeenCalledOnce();
    expect(
      (await readdir(outputDirectory)).some(
        (entry) => entry.startsWith("regression_"),
      ),
    ).toBe(false);
  });

  it("v1은 정상 corpus, v2는 선택 후보 전달 경계에서 RET 3.1을 제거하고 RET 3.3을 노출한다", () => {
    for (const candidateId of ["A", "B", "C"] as const) {
      const contexts = buildRegressionVersionContexts(candidateId);
      const baseline = contexts.find(
        (item) => item.slot.slot_id === "BASELINE_V1--H-011",
      )!;
      const proposed = contexts.find(
        (item) => item.slot.slot_id === "PROPOSED_V2--H-011",
      )!;

      expect(baseline.candidate_policy_access.sections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source_id: "RET", section_id: "3.1" }),
          expect.objectContaining({ source_id: "RET", section_id: "3.3" }),
        ]),
      );
      expect(proposed.candidate_policy_access.sections).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source_id: "RET", section_id: "3.1" }),
        ]),
      );
      expect(proposed.candidate_policy_access.sections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source_id: "RET",
            section_id: "3.3",
            lifecycle_status: "RETIRED",
          }),
        ]),
      );
      expect(proposed.candidate_policy_access.delivery).toBe({
        A: "INLINE_CORPUS",
        B: "RETRIEVAL_INDEX",
        C: "SEARCH_POLICY_BACKEND",
      }[candidateId]);
    }
  });

  it("canary access injector를 후보별 candidate-facing 요청에 결합한다", () => {
    for (const candidateId of ["A", "B", "C"] as const) {
      const contexts = buildRegressionVersionContexts(candidateId);
      const mismatch = contexts.find(
        (item) => item.slot.slot_id === "BASELINE_V1--R-006",
      )!;
      expect(mismatch.candidate_order_access).toMatchObject({
        channel: candidateId === "C" ? "READ_ONLY_TOOL" : "RUNNER_SNAPSHOT",
        data: null,
      });
      expect(JSON.stringify(mismatch)).not.toContain("candidate_access_expectations");
      expect(JSON.stringify(mismatch)).not.toContain("expected_action_code");
    }
  });

  it("crash 재개는 checkpoint가 있는 slot을 재호출하지 않고 intent-only는 모호 상태로 fail-closed한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "regression-resume-"));
    await chmod(outputDirectory, 0o700);
    const crashing = vi.fn(async (request) => completeExecution(request));
    await expect(runRecordedRegression({
      outputDirectory,
      decisionBaselineRecord: baselineRecord(),
      sufficiency,
      dependencies: {
        ...testDependencies(crashing),
        afterCheckpoint: async ({ completed }) => {
          if (completed === 7) throw new Error("synthetic crash");
        },
      },
    })).rejects.toThrow(/synthetic crash/);

    const resumed = vi.fn(async (request) => completeExecution(request));
    const result = await runRecordedRegression({
      outputDirectory,
      decisionBaselineRecord: baselineRecord(),
      sufficiency,
      dependencies: testDependencies(resumed),
    });
    expect(resumed).toHaveBeenCalledTimes(29);
    expect(result.pack.slots).toHaveLength(36);

    const ambiguousRoot = await mkdtemp(join(tmpdir(), "regression-ambiguous-"));
    await chmod(ambiguousRoot, 0o700);
    const remote = vi.fn(async (request) => completeExecution(request));
    await expect(runRecordedRegression({
      outputDirectory: ambiguousRoot,
      decisionBaselineRecord: baselineRecord(),
      sufficiency,
      dependencies: {
        ...testDependencies(remote),
        persistReceipt: async () => {
          throw new Error("crash after provider before receipt");
        },
      },
    })).rejects.toThrow(/crash after provider/);
    const retryRemote = vi.fn(async (request) => completeExecution(request));
    await expect(runRecordedRegression({
      outputDirectory: ambiguousRoot,
      decisionBaselineRecord: baselineRecord(),
      sufficiency,
      dependencies: testDependencies(retryRemote),
    })).rejects.toThrow(/ambiguous|intent.only|불명확/i);
    expect(retryRemote).not.toHaveBeenCalled();
  });

  it("주입된 receipt persistence가 실제 canonical receipt를 남기지 않으면 pack을 만들지 않는다", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "regression-noop-receipt-"),
    );
    await chmod(outputDirectory, 0o700);
    const remote = vi.fn(async (request) => completeExecution(request));

    await expect(runRecordedRegression({
      outputDirectory,
      decisionBaselineRecord: baselineRecord(),
      sufficiency,
      dependencies: {
        ...testDependencies(remote),
        persistReceipt: async () => undefined,
      },
    })).rejects.toThrow(/receipt|source|persist|저장|누락/i);

    expect(remote).toHaveBeenCalledTimes(1);
    expect(
      (await readdir(outputDirectory)).some(
        (entry) => entry.startsWith("regression_"),
      ),
    ).toBe(false);
  });

  it("동일 schedule은 selected candidate와 authority hash에 결합된다", () => {
    const a = buildRegressionSchedule("A");
    const b = buildRegressionSchedule("B");
    expect(a).toHaveLength(36);
    expect(a.map((slot) => slot.sequence)).toEqual(
      Array.from({ length: 36 }, (_, index) => index + 1),
    );
    expect(a[0].slot_id).toBe("BASELINE_V1--H-001");
    expect(a[17].slot_id).toBe("BASELINE_V1--R-006");
    expect(a[18].slot_id).toBe("PROPOSED_V2--H-001");
    expect(a[35].slot_id).toBe("PROPOSED_V2--R-006");
    expect(a.schedule_id).not.toBe(b.schedule_id);
  });

  it("B/C 원격 자원은 실제 ID에 결합된 삭제 승인 receipt 없이는 CLEANED 증거를 발급하지 않는다", () => {
    expect(() => buildValidatedRegressionResourceCleanupEvidenceForTest({
      selectedCandidateId: "B",
      authorityBinding: buildRegressionResourceAuthorityBinding(
        baselineRecord("B"),
      ),
      baseline: {
        policy_resource_identity_hash: hash("baseline-resource"),
        manifest_hash: hash("baseline-manifest"),
        vector_store_id: "vs-regression-baseline",
        uploaded_file_ids: ["file-baseline"],
        cleanup: {
          vectorStore: {
            id: "different-vector-store",
            attempted: true,
            deleted: true,
          },
          uploadedFiles: [{
            id: "file-baseline",
            attempted: true,
            deleted: true,
          }],
        },
      },
      proposed: null,
    })).toThrow(/cleanup|삭제|resource|binding|proposed/i);
  });

  it("실제 CandidateAdapter 실행 결과에서 비용·gate·원시 출력 증거를 계산한다", async () => {
    const adapterFor = vi.fn(
      (request: ReturnType<typeof buildRegressionVersionContexts>[number]): CandidateAdapter => {
        const oracle = request.slot.case_id.startsWith("H-")
          ? BENCHMARK_ORACLES.find((item) => item.case_id === request.slot.case_id)!
          : REGRESSION_CANARY_ORACLES.find((item) => item.case_id === request.slot.case_id)!;
        const output = {
          customer_reply: oracle.reference_replies[0],
          decision: {
            intent_codes: [...oracle.expected_intent_codes],
            action_code: oracle.expected_action_code,
            escalation_required: oracle.escalation_required,
            escalation_reason_code: oracle.escalation_reason_code,
            target_queue: oracle.target_queue,
          },
          citations: structuredClone(oracle.required_citations),
        };
        return {
          invoke: async () => ({
            responseId: `resp-${request.slot.slot_id}`,
            status: "completed",
            modelReportedId: "gpt-5.6-terra-2026-07-17",
            serviceTierReported: "default",
            outputText: JSON.stringify(output),
            usage: {
              inputTokens: 100,
              cachedInputTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 20,
            },
            executionEvidence: {
              providerCalls: [{
                callNumber: 1,
                responseId: `resp-${request.slot.slot_id}`,
                status: "completed",
                modelRequestedId: "gpt-5.6-terra",
                modelReportedId: "gpt-5.6-terra-2026-07-17",
                serviceTierRequested: "default",
                serviceTierReported: "default",
                latencyMs: 10,
                usage: {
                  inputTokens: 100,
                  cachedInputTokens: 0,
                  cacheWriteTokens: 0,
                  outputTokens: 20,
                },
              }],
              retrievalCalls: [],
              toolCalls: [],
            },
          }),
        };
      },
    );
    const execute = createRegressionCandidateExecutor({ adapterFor });
    const context = buildRegressionVersionContexts("A").find(
      (item) => item.slot.slot_id === "BASELINE_V1--H-001",
    )!;
    const result = await execute({
      ...context,
      slot_identity_hash: hash("actual-adapter-slot"),
    });

    expect(adapterFor).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      schema_version: "validated-regression-candidate-receipt-v1",
      request_identity_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      candidate_execution: {
        executionStatus: "COMPLETE",
        costState: "COMPLETE",
        run: {
          output: expect.objectContaining({
            customer_reply: expect.any(String),
          }),
        },
      },
    });
    expect(result.candidate_execution.usageCost!.totalCostUsd).toBeGreaterThan(0);
    expect(
      result.candidate_execution.run!.attempts[0]
        .executionEvidence!.providerCalls,
    ).toHaveLength(1);
  });

  it("공통 증거 정규화 오류는 후보 실패로 바꾸지 않고 EVALUATION_INCOMPLETE 팩에 보존한다", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "regression-evaluator-incomplete-"),
    );
    await chmod(outputDirectory, 0o700);
    const incompleteExecutor = createRegressionCandidateExecutor({
      adapterFor: (request): CandidateAdapter => {
        const oracle = request.slot.case_id.startsWith("H-")
          ? BENCHMARK_ORACLES.find(
            (item) => item.case_id === request.slot.case_id,
          )!
          : REGRESSION_CANARY_ORACLES.find(
            (item) => item.case_id === request.slot.case_id,
          )!;
        const output: CandidateOutput = {
          customer_reply: oracle.reference_replies[0],
          decision: {
            intent_codes: [...oracle.expected_intent_codes],
            action_code: oracle.expected_action_code,
            escalation_required: oracle.escalation_required,
            escalation_reason_code: oracle.escalation_reason_code,
            target_queue: oracle.target_queue,
          },
          citations: structuredClone(oracle.required_citations),
        };
        return {
          invoke: async () => ({
            responseId: `resp-${request.slot.slot_id}`,
            status: "completed",
            modelReportedId: "gpt-5.6-terra-2026-07-17",
            serviceTierReported: "default",
            outputText: JSON.stringify(output),
            usage: {
              inputTokens: 100,
              cachedInputTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 20,
            },
            executionEvidence: {
              providerCalls: [{
                callNumber: 1,
                responseId: `resp-${request.slot.slot_id}`,
                status: "completed",
                modelRequestedId: "gpt-5.6-terra",
                modelReportedId: "gpt-5.6-terra-2026-07-17",
                serviceTierRequested: "default",
                serviceTierReported: "default",
                latencyMs: 10,
                usage: {
                  inputTokens: 100,
                  cachedInputTokens: 0,
                  cacheWriteTokens: 0,
                  outputTokens: 20,
                },
              }],
              // Candidate C의 검색 호출과 tool trace를 고의로 불일치시켜
              // 공통 증거 정규화 실패 경계를 검증합니다.
              retrievalCalls: [{
                callNumber: 1,
                operation: "VECTOR_STORE_SEARCH",
                status: "COMPLETE",
                requestedQuery: "synthetic policy lookup",
                reportedQuery: "synthetic policy lookup",
                vectorStoreId: "vs-synthetic-evaluator-error",
                maxNumResults: 4,
                rewriteQuery: false,
                latencyMs: 1,
                results: [],
              }],
              toolCalls: [],
            },
          }),
        };
      },
    });
    const result = await runRecordedRegression({
      outputDirectory,
      decisionBaselineRecord: baselineRecord("C"),
      sufficiency,
      dependencies: testDependencies(incompleteExecutor),
      createdAt: "2026-07-17T06:00:00.000Z",
    });

    expect(result.pack).toMatchObject({
      evaluation_status: "EVALUATION_INCOMPLETE",
      verdict: "EVALUATION_INCOMPLETE",
      baseline_status_after: "ACTIVE",
    });
    expect(result.pack.slots).toHaveLength(36);
    expect(result.pack.slots.every((slot) => (
      slot.raw_execution_evidence.execution_status === "COMPLETE"
      && slot.raw_execution_evidence.evaluation_status
        === "EVALUATION_INCOMPLETE"
      && slot.raw_execution_evidence.candidate_output !== null
    ))).toBe(true);
  });

  it("중단 신호는 다음 원격 후보 호출 전에 canonical executor에서 차단된다", async () => {
    const controller = new AbortController();
    const interruption = new Error("synthetic regression interruption");
    controller.abort(interruption);
    const invoke = vi.fn();
    const context = buildRegressionVersionContexts("A")[0];
    const executor = createRegressionCandidateExecutor({
      adapterFor: () => ({ invoke }),
      signal: controller.signal,
    } as any);

    await expect(executor({
      ...context,
      slot_identity_hash: hash("aborted-regression-slot"),
    })).rejects.toBe(interruption);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("동시 실행 owner 경쟁에서도 같은 slot을 두 번 원격 호출하지 않는다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "regression-race-runner-"));
    await chmod(outputDirectory, 0o700);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const remote = vi.fn(async (request) => {
      if (remote.mock.calls.length === 1) {
        firstStarted();
        await firstBlocked;
      }
      return completeExecution(request);
    });
    const first = runRecordedRegression({
      outputDirectory,
      decisionBaselineRecord: baselineRecord(),
      sufficiency,
      dependencies: testDependencies(remote),
      createdAt: "2026-07-17T06:00:00.000Z",
    }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    await started;
    const second = runRecordedRegression({
      outputDirectory,
      decisionBaselineRecord: baselineRecord(),
      sufficiency,
      dependencies: testDependencies(remote),
      createdAt: "2026-07-17T06:00:00.000Z",
    }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseFirst();
    const outcomes = await Promise.all([first, second]);

    expect(remote).toHaveBeenCalledTimes(36);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
  });

  it("ledger mode·nlink·symlink·canonical tamper를 원격 재호출 전에 거부하고 receipt-only는 로컬 복구한다", async () => {
    async function oneCheckpointRoot(label: string) {
      const root = await mkdtemp(join(tmpdir(), `regression-ledger-${label}-`));
      await chmod(root, 0o700);
      const remote = vi.fn(async (request) => completeExecution(request));
      await expect(runRecordedRegression({
        outputDirectory: root,
        decisionBaselineRecord: baselineRecord(),
        sufficiency,
        dependencies: {
          ...testDependencies(remote),
          afterCheckpoint: async ({ completed }) => {
            if (completed === 1) throw new Error("stop after checkpoint");
          },
        },
      })).rejects.toThrow(/stop after checkpoint/);
      const ledgerDirectory = (await readdir(root)).find(
        (entry) => entry.startsWith("regression-ledger-"),
      )!;
      const slotsDirectory = join(root, ledgerDirectory, "slots");
      const files = await readdir(slotsDirectory);
      return { root, slotsDirectory, files };
    }

    const mode = await oneCheckpointRoot("mode");
    const checkpoint = mode.files.find((file) => file.endsWith("--checkpoint.json"))!;
    await chmod(join(mode.slotsDirectory, checkpoint), 0o644);
    const modeRemote = vi.fn(async (request) => completeExecution(request));
    await expect(runRecordedRegression({
      outputDirectory: mode.root,
      decisionBaselineRecord: baselineRecord(),
      sufficiency,
      dependencies: testDependencies(modeRemote),
    })).rejects.toThrow(/0600|nlink|file/i);
    expect(modeRemote).not.toHaveBeenCalled();

    const hard = await oneCheckpointRoot("hardlink");
    const hardCheckpoint = hard.files.find((file) => file.endsWith("--checkpoint.json"))!;
    await link(
      join(hard.slotsDirectory, hardCheckpoint),
      join(hard.root, "attacker-hardlink.json"),
    );
    const hardRemote = vi.fn(async (request) => completeExecution(request));
    await expect(runRecordedRegression({
      outputDirectory: hard.root,
      decisionBaselineRecord: baselineRecord(),
      sufficiency,
      dependencies: testDependencies(hardRemote),
    })).rejects.toThrow(/nlink|0600|file/i);
    expect(hardRemote).not.toHaveBeenCalled();

    const interruptedPublish = await oneCheckpointRoot("interrupted-publish");
    const interruptedCheckpoint = interruptedPublish.files.find(
      (file) => file.endsWith("--checkpoint.json"),
    )!;
    await link(
      join(interruptedPublish.slotsDirectory, interruptedCheckpoint),
      join(
        interruptedPublish.slotsDirectory,
        `.${interruptedCheckpoint}.tmp-100-safe-recovery`,
      ),
    );
    const interruptedRemote = vi.fn(
      async (request) => completeExecution(request),
    );
    const interruptedRecovered = await runRecordedRegression({
      outputDirectory: interruptedPublish.root,
      decisionBaselineRecord: baselineRecord(),
      sufficiency,
      dependencies: testDependencies(interruptedRemote),
    });
    expect(interruptedRemote).toHaveBeenCalledTimes(35);
    expect(interruptedRecovered.pack.slots).toHaveLength(36);

    const tamper = await oneCheckpointRoot("tamper");
    const tamperCheckpoint = tamper.files.find((file) => file.endsWith("--checkpoint.json"))!;
    await writeFile(join(tamper.slotsDirectory, tamperCheckpoint), "{}\n");
    const tamperRemote = vi.fn(async (request) => completeExecution(request));
    await expect(runRecordedRegression({
      outputDirectory: tamper.root,
      decisionBaselineRecord: baselineRecord(),
      sufficiency,
      dependencies: testDependencies(tamperRemote),
    })).rejects.toThrow(/tamper|wrapper|JSON|hash/i);
    expect(tamperRemote).not.toHaveBeenCalled();

    const symlinkRoot = await oneCheckpointRoot("symlink");
    const secondIntent = "002--BASELINE_V1--H-002--intent.json";
    const outside = join(symlinkRoot.root, "outside.json");
    await writeFile(outside, "{}\n", { mode: 0o600 });
    await symlink(outside, join(symlinkRoot.slotsDirectory, secondIntent));
    const symlinkRemote = vi.fn(async (request) => completeExecution(request));
    await expect(runRecordedRegression({
      outputDirectory: symlinkRoot.root,
      decisionBaselineRecord: baselineRecord(),
      sufficiency,
      dependencies: testDependencies(symlinkRemote),
    })).rejects.toThrow(/symlink|열 수|artifact|file/i);
    expect(symlinkRemote).not.toHaveBeenCalled();

    const receiptOnly = await oneCheckpointRoot("receipt-only");
    const receiptCheckpoint = receiptOnly.files.find(
      (file) => file.endsWith("--checkpoint.json"),
    )!;
    await unlink(join(receiptOnly.slotsDirectory, receiptCheckpoint));
    const recoveredRemote = vi.fn(async (request) => completeExecution(request));
    const recovered = await runRecordedRegression({
      outputDirectory: receiptOnly.root,
      decisionBaselineRecord: baselineRecord(),
      sufficiency,
      dependencies: testDependencies(recoveredRemote),
    });
    expect(recoveredRemote).toHaveBeenCalledTimes(35);
    expect(recovered.pack.slots).toHaveLength(36);
  }, 30_000);

  it("ACTIVE baseline·exact 36 ledger·검증된 cleanup에서만 pack authority를 재구성한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "regression-authority-load-"));
    await chmod(outputDirectory, 0o700);
    const record = baselineRecord("A");
    const run = await runRecordedRegression({
      outputDirectory,
      decisionBaselineRecord: record,
      sufficiency,
      dependencies: testDependencies(),
      createdAt: "2026-07-17T06:00:00.000Z",
    });
    const cleanup = buildValidatedRegressionResourceCleanupEvidence({
      selectedCandidateId: "A",
      baseline: null,
      proposed: null,
      authorityBinding:
        buildRegressionResourceAuthorityBinding(record),
    });
    const loaded = await loadRecordedRegressionFromAuthority({
      outputDirectory,
      path: run.path,
      decisionBaselineRecord: record,
      sufficiency,
      resourceCleanup: cleanup,
      createdAt: "2026-07-17T06:00:00.000Z",
      assertBaselineRecord: () => undefined,
    });
    expect(sha256CanonicalJson(loaded)).toBe(run.payloadSha256);

    const ledgerDirectory = (await readdir(outputDirectory)).find(
      (entry) => entry.startsWith("regression-ledger-"),
    )!;
    const slotsDirectory = join(outputDirectory, ledgerDirectory, "slots");
    const checkpointName = (await readdir(slotsDirectory)).find(
      (entry) => entry.endsWith("--checkpoint.json"),
    )!;
    const checkpointPath = join(slotsDirectory, checkpointName);
    const wrapper = JSON.parse(
      await readFile(checkpointPath, "utf8"),
    ) as {
      payload_sha256: string;
      payload: {
        slot_record: {
          raw_execution_evidence: { candidate_cost_usd: number };
        };
      };
    };
    wrapper.payload.slot_record.raw_execution_evidence.candidate_cost_usd =
      999;
    wrapper.payload_sha256 = sha256CanonicalJson(wrapper.payload);
    await writeFile(
      checkpointPath,
      `${canonicalJsonStringify(wrapper)}\n`,
    );
    await expect(loadRecordedRegressionFromAuthority({
      outputDirectory,
      path: run.path,
      decisionBaselineRecord: record,
      sufficiency,
      resourceCleanup: cleanup,
      createdAt: "2026-07-17T06:00:00.000Z",
      assertBaselineRecord: () => undefined,
    })).rejects.toThrow(/checkpoint|receipt|재계산|source/i);
  });

  it("source receipt와 checkpoint hash를 함께 다시 써도 attempt 순서 모순을 거부한다", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "regression-attempt-tamper-"),
    );
    await chmod(outputDirectory, 0o700);
    const record = baselineRecord("A");
    const run = await runRecordedRegression({
      outputDirectory,
      decisionBaselineRecord: record,
      sufficiency,
      dependencies: testDependencies(),
      createdAt: "2026-07-17T06:00:00.000Z",
    });
    const ledgerDirectory = (await readdir(outputDirectory)).find(
      (entry) => entry.startsWith("regression-ledger-"),
    )!;
    const slotsDirectory = join(outputDirectory, ledgerDirectory, "slots");
    const files = await readdir(slotsDirectory);
    const receiptPath = join(
      slotsDirectory,
      files.find((entry) => entry.startsWith("001--")
        && entry.endsWith("--receipt.json"))!,
    );
    const checkpointPath = join(
      slotsDirectory,
      files.find((entry) => entry.startsWith("001--")
        && entry.endsWith("--checkpoint.json"))!,
    );
    const receiptWrapper = JSON.parse(
      await readFile(receiptPath, "utf8"),
    ) as any;
    receiptWrapper.payload.candidate_execution.run.attempts[0].attemptNumber =
      2;
    receiptWrapper.payload_sha256 =
      sha256CanonicalJson(receiptWrapper.payload);
    await writeFile(
      receiptPath,
      `${canonicalJsonStringify(receiptWrapper)}\n`,
    );
    const checkpointWrapper = JSON.parse(
      await readFile(checkpointPath, "utf8"),
    ) as any;
    checkpointWrapper.payload.receipt_hash =
      sha256CanonicalJson(receiptWrapper.payload);
    checkpointWrapper.payload_sha256 =
      sha256CanonicalJson(checkpointWrapper.payload);
    await writeFile(
      checkpointPath,
      `${canonicalJsonStringify(checkpointWrapper)}\n`,
    );
    const cleanup = buildValidatedRegressionResourceCleanupEvidence({
      selectedCandidateId: "A",
      baseline: null,
      proposed: null,
      authorityBinding:
        buildRegressionResourceAuthorityBinding(record),
    });

    await expect(loadRecordedRegressionFromAuthority({
      outputDirectory,
      path: run.path,
      decisionBaselineRecord: record,
      sufficiency,
      resourceCleanup: cleanup,
      createdAt: "2026-07-17T06:00:00.000Z",
      assertBaselineRecord: () => undefined,
    })).rejects.toThrow(/attempt|순서|sequence|terminal|contract/i);
  });

  it("직렬화로 위조한 cleanup evidence는 remote 삭제 승인 authority로 받아들이지 않는다", async () => {
    const fakeCleanup = {
      selected_candidate_id: "B",
      evidence: {
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
      },
    } as unknown as ReturnType<
      typeof buildValidatedRegressionResourceCleanupEvidence
    >;
    await expect(loadRecordedRegressionFromAuthority({
      outputDirectory: await mkdtemp(join(tmpdir(), "regression-fake-cleanup-")),
      path: "/tmp/not-a-pack.json",
      decisionBaselineRecord: baselineRecord("B"),
      sufficiency,
      resourceCleanup: fakeCleanup,
      createdAt: "2026-07-17T06:00:00.000Z",
      assertBaselineRecord: () => undefined,
    })).rejects.toThrow(/resource|삭제|승인|branded|검증/i);
  });
});

// @vitest-environment node

import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  executeDefineStructureCommand,
  type DefineStructureCommandDependencies,
} from "../../eval/cli/runDefineStructure";
import type { RecordedBenchmarkOutcome } from "../../eval/cli/runRecordedBenchmark";
import {
  buildFinalDecisionMemoClaimEvidenceRefs,
  buildFinalDecisionMemoRequiredOutput,
  FINAL_DECISION_MEMO_OPENAI_REQUEST_CONTRACT,
  FINAL_DECISION_MEMO_OUTPUT_SCHEMA,
  FINAL_DECISION_MEMO_PRICING_SNAPSHOT,
  type FinalDecisionMemoAdapter,
  type FinalDecisionMemoAdapterRequest,
} from "../../eval/decision/decisionBaseline";
import {
  loadDefineStructuringArtifact,
  persistDefineStructuringArtifact,
} from "../../eval/define/defineStructuringPersistence";
import { runDefineStructuring } from "../../eval/define/runDefineStructuring";
import { SYNTHETIC_CHALLENGE_TEMPLATE } from "../../eval/define/syntheticChallengeDefinition";
import type { RecordedBenchmarkPack } from "../../eval/pack/recordedBenchmarkPack";
import {
  reloadRecordedBenchmarkPackForColdStartForTest,
} from "../../eval/pack/coldRecordedBenchmarkReload";
import {
  createTestAuthoritativeBlindingPrecommitAuthority,
  createTestAuthoritativeBlindingPrecommitStore,
} from "../../eval/review/judgeEvidencePrecommitPersistence";
import {
  BENCHMARK_ORACLES,
  REGRESSION_CANARY_ORACLES,
} from "../../eval/data/benchmark";
import {
  buildValidatedRegressionResourceCleanupEvidence,
  createRegressionCandidateExecutor,
  runRecordedRegression,
  type RegressionSufficiencyContract,
} from "../../eval/regression/runRegression";
import type { CandidateOutput } from "../../eval/contracts/candidateOutput";
import { calculateUsageCost } from "../../eval/runtime/pricing";
import { sha256CanonicalJson } from "../../eval/runtime/canonicalJson";
import type { CandidateAdapter } from "../../eval/runner/types";
import {
  createAuthoritativeRecordedWorkflowGatewayForTest,
} from "../authoritativeWorkflowController";
import {
  startAuthoritativeChallengeRoomFromEnvironmentForTest,
  type AuthoritativeChallengeRoomProcessTestDependencies,
} from "../authoritativeChallengeRoomProcess";

const workflowId = "synthetic-recorded-challenge";
const sufficiency: RegressionSufficiencyContract = Object.freeze({
  hidden_policy_minimum_correct: 11,
  hidden_citation_required_cases: 11,
  hidden_escalation_required_cases: 4,
  mean_runtime_cost_usd_maximum: 0.2,
  median_latency_ms_maximum: 10_000,
  worst_latency_ms_maximum: 30_000,
});

async function secureDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  return realpath(directory);
}

async function secureChild(parent: string, name: string): Promise<string> {
  const directory = join(parent, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return realpath(directory);
}

function isStrictlyContained(parent: string, child: string): boolean {
  const fromParent = relative(resolve(parent), resolve(child));
  return fromParent.length > 0
    && fromParent !== ".."
    && !fromParent.startsWith("../")
    && !isAbsolute(fromParent);
}

async function recordedBenchmarkBuilder() {
  (globalThis as { __reuseRecordedReviewFixture?: boolean })
    .__reuseRecordedReviewFixture = true;
  return import("../../eval/test/reviewQueueBuilder.test");
}

function cleanupResources() {
  return [
    {
      kind: "VECTOR_STORE" as const,
      fingerprint: "sha256:000000000001",
      delete_acknowledged: true,
    },
    ...Array.from({ length: 32 }, (_, index) => ({
      kind: "UPLOADED_FILE" as const,
      fingerprint: `sha256:${String(index + 2).padStart(12, "0")}`,
      delete_acknowledged: true,
    })),
  ];
}

function reviewerHeaders(
  origin: string,
  reviewerBootstrapUrl: string | undefined,
): Readonly<Record<string, string>> {
  if (reviewerBootstrapUrl === undefined) {
    throw new Error("Reviewer bootstrap URL이 없습니다.");
  }
  const token = new URLSearchParams(
    new URL(reviewerBootstrapUrl).hash.slice(1),
  ).get("reviewer_token");
  if (token === null) throw new Error("Reviewer token이 없습니다.");
  return Object.freeze({
    authorization: `Bearer ${token}`,
    origin,
    "sec-fetch-site": "same-origin",
  });
}

async function readJson<T>(
  responseOrPromise: Response | Promise<Response>,
): Promise<T> {
  const response = await responseOrPromise;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

function memoAdapter(counter: { memo: number }): FinalDecisionMemoAdapter {
  return {
    invoke: async (request: FinalDecisionMemoAdapterRequest) => {
      counter.memo += 1;
      const usage = {
        inputTokens: 100,
        cachedInputTokens: 10,
        cacheWriteTokens: 0,
        outputTokens: 20,
        reasoningTokens: 5,
        totalTokens: 120,
      };
      const usageCost = calculateUsageCost(
        usage,
        FINAL_DECISION_MEMO_PRICING_SNAPSHOT,
      )!;
      return {
        output: buildFinalDecisionMemoRequiredOutput(request),
        run_evidence: {
          schema_version: "final-decision-memo-run-evidence-v1",
          adapter_request_hash: sha256CanonicalJson(request),
          request_contract_hash: sha256CanonicalJson(
            FINAL_DECISION_MEMO_OPENAI_REQUEST_CONTRACT,
          ),
          model_requested_id: "gpt-5.6-sol",
          model_reported_id: "gpt-5.6-sol",
          service_tier_requested: "default",
          service_tier_reported: "default",
          strict_output_schema_hash: sha256CanonicalJson(
            FINAL_DECISION_MEMO_OUTPUT_SCHEMA,
          ),
          pricing_snapshot_hash: sha256CanonicalJson(
            FINAL_DECISION_MEMO_PRICING_SNAPSHOT,
          ),
          store_requested: false,
          claim_evidence_refs:
            buildFinalDecisionMemoClaimEvidenceRefs(request),
          attempts: [{
            attempt_number: 1,
            request_disposition: "RESPONSE_RECEIVED",
            status: "COMPLETE",
            retry_eligible: false,
            response_id: "resp_provider_free_memo",
            refusal: null,
            incomplete_reason: null,
            error: null,
            latency_ms: 1,
            usage,
            usage_cost: usageCost,
          }],
          total_latency_ms: 1,
          total_usage: usage,
          total_cost_usd: usageCost.totalCostUsd,
        },
      };
    },
  };
}

function regressionRunner({
  outputDirectory,
  counter,
}: {
  readonly outputDirectory: string;
  readonly counter: { regression: number };
}) {
  return async ({
    decisionBaselineRecord,
  }: Parameters<
    NonNullable<
      AuthoritativeChallengeRoomProcessTestDependencies[
        "createRecordedRegressionRunner"
      ]
    >
  >[0] extends never ? never : {
    readonly decisionBaselineRecord: Parameters<
      typeof runRecordedRegression
    >[0]["decisionBaselineRecord"];
  }) => {
    const executeCandidate = createRegressionCandidateExecutor({
      adapterFor: (request): CandidateAdapter => {
        const oracle = request.slot.case_id.startsWith("H-")
          ? BENCHMARK_ORACLES.find(
            (item) => item.case_id === request.slot.case_id,
          )!
          : REGRESSION_CANARY_ORACLES.find(
            (item) => item.case_id === request.slot.case_id,
          )!;
        const injectedDefect = request.slot.version === "PROPOSED_V2"
          && request.slot.case_id === "H-011";
        const output: CandidateOutput = {
          customer_reply: injectedDefect
            ? "The retired 14-day rule applies, so this return is denied."
            : oracle.reference_replies[0],
          decision: {
            intent_codes: [...oracle.expected_intent_codes],
            action_code: injectedDefect
              ? "DENY_RETURN"
              : oracle.expected_action_code,
            escalation_required: oracle.escalation_required,
            escalation_reason_code: oracle.escalation_reason_code,
            target_queue: oracle.target_queue,
          },
          citations: injectedDefect
            ? [{ source_id: "RET", section_id: "3.3" }]
            : structuredClone(oracle.required_citations),
        };
        return {
          invoke: async () => {
            counter.regression += 1;
            const usage = {
              inputTokens: 100,
              cachedInputTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 20,
            };
            return {
              responseId: `resp-${request.slot.slot_id}`,
              status: "completed",
          modelReportedId: "gpt-5.6-terra",
              serviceTierReported: "default",
              outputText: JSON.stringify(output),
              usage,
              executionEvidence: {
                providerCalls: [{
                  callNumber: 1,
                  responseId: `resp-${request.slot.slot_id}`,
                  status: "completed",
                  modelRequestedId: "gpt-5.6-terra",
                  modelReportedId: "gpt-5.6-terra",
                  serviceTierRequested: "default",
                  serviceTierReported: "default",
                  latencyMs: 1,
                  usage,
                }],
                retrievalCalls: [],
                toolCalls: [],
              },
            };
          },
        };
      },
    });
    return runRecordedRegression({
      outputDirectory,
      decisionBaselineRecord,
      sufficiency,
      dependencies: {
        assertBaselineRecord: () => undefined,
        executeCandidate,
        resourceEvidence: async ({
          selectedCandidateId,
          authorityBinding,
        }) => buildValidatedRegressionResourceCleanupEvidence({
          selectedCandidateId,
          baseline: null,
          proposed: null,
          authorityBinding,
        }),
      },
      createdAt: "2026-07-19T00:20:00.000Z",
    });
  };
}

describe("provider 없는 단일 권위 root 전체 수명주기", () => {
  it("실제 HTTP mutation과 cold hydration으로 Define부터 BLOCK 회귀까지 연결한다", async () => {
    const root = await secureDirectory("provider-free-full-lifecycle-");
    const benchmarkDirectory = await secureChild(root, "benchmark-fixture");
    const regressionDirectory = await secureChild(root, "regression-fixture");
    const privateBlindingSeedRootDirectory = await secureChild(
      root,
      "judge-seed-authority",
    );
    const precommitRootDirectory = await secureChild(
      root,
      "judge-precommit-authority",
    );
    const precommitAuthority =
      await createTestAuthoritativeBlindingPrecommitAuthority({
        rootDirectory: precommitRootDirectory,
      });
    const judgeEvidencePrecommitStore =
      await createTestAuthoritativeBlindingPrecommitStore({
        authority: precommitAuthority,
        storeName: "full-lifecycle",
      });
    const counters = {
      externalProvider: 0,
      define: 0,
      benchmark: 0,
      judge: 0,
      memo: 0,
      regression: 0,
      coldReload: 0,
    };
    let recordedPack: RecordedBenchmarkPack | null = null;
    const readRecordedPack = (): RecordedBenchmarkPack | null => recordedPack;
    let coldAuthorityPaths: readonly string[] = [];
    const readColdAuthorityPaths = (): readonly string[] => coldAuthorityPaths;
    let clockTick = 0;
    const defineDependencies: DefineStructureCommandDependencies = {
      createClient: () => ({ provider: "deterministic-local" }),
      createAdapter: () => ({
        invoke: async () => {
          counters.define += 1;
          return {
            responseId: "resp-provider-free-define",
            responseStatusCode: 200,
            status: "completed",
            modelReportedId: "gpt-5.6-sol",
            serviceTierReported: "default",
            outputText: JSON.stringify(
              SYNTHETIC_CHALLENGE_TEMPLATE.advisorySuggestion,
            ),
            usage: {
              inputTokens: 200,
              cachedInputTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 100,
              reasoningTokens: 40,
              totalTokens: 300,
            },
            error: null,
          };
        },
      }),
      runStructuring: runDefineStructuring,
      persistArtifact: persistDefineStructuringArtifact,
      loadPersistedArtifact: loadDefineStructuringArtifact,
    };
    const processDependencies = {
      executeDefineStructureCommand: (input) =>
        executeDefineStructureCommand({
          ...input,
          environment: {
            ...input.environment,
            OPENAI_API_KEY: "provider-free-placeholder",
          },
          dependencies: defineDependencies,
        }),
      executeRecordedBenchmarkCommand: async ({
        outputDirectory,
      }): Promise<RecordedBenchmarkOutcome> => {
        const builder = await recordedBenchmarkBuilder();
        const fixture = await builder.createPersistedRecordedBenchmarkColdFixture({
          outputDirectory: benchmarkDirectory,
          testAuthority: {
            privateBlindingSeedRootDirectory,
            judgeEvidencePrecommitStore,
          },
        });
        coldAuthorityPaths = [
          fixture.privateBlindingSeedAuthority.root_directory,
          fixture.privateBlindingSeedAuthority.record_path,
          fixture.judgeEvidencePrecommitAuthority.root_directory,
          fixture.judgeEvidencePrecommitAuthority.authority_claim_path,
          fixture.judgeEvidencePrecommitAuthority.record_path,
        ];
        recordedPack = fixture.recordedBenchmarkPack;
        counters.benchmark = fixture.recordedBenchmarkPack
          .benchmark_execution_pack.slots.length;
        counters.judge = fixture.recordedBenchmarkPack.coverage.judge_cases;
        return {
          exitCode: 0,
          summary: {
            command_status: "RECORDED_BENCHMARK_REVIEW_PENDING",
            artifact_kind: "RECORDED_BENCHMARK_PACK",
            source: "RECORDED_BENCHMARK",
            execution_status: "EXECUTION_COMPLETE",
            judge_status: "JUDGE_COMPLETE",
            review_status: "REVIEW_PENDING",
            evaluation_status: "EVALUATION_INCOMPLETE",
            baseline_version: null,
            evaluation_complete: false,
            baseline_created: false,
            clean_completion: true,
            candidate_execution_count: 72,
            auxiliary_judge_count: 12,
            complete_judge_count: 12,
            human_fallback_judge_count: 0,
            recorded_pack_path: fixture.recordedPackPath,
            cleanup: {
              required: 33,
              acknowledged: 33,
              incomplete: 0,
              resources: cleanupResources(),
              receipt_path: join(outputDirectory, "provider-free-cleanup.json"),
            },
          },
          serverAuthority: {
            recordedBenchmarkPack: fixture.recordedBenchmarkPack,
            coldReloadReference: {
              outputDirectory: benchmarkDirectory,
              recordedPackPath: fixture.recordedPackPath,
              recordedPackHash: fixture.recordedPackHash,
              executionIdentityAuthority:
                fixture.executionIdentityAuthority,
              plans: fixture.plans,
              privateBlindingSeedAuthority:
                fixture.privateBlindingSeedAuthority,
              judgeEvidencePrecommitAuthority:
                fixture.judgeEvidencePrecommitAuthority,
            },
          },
        };
      },
      createRecordedWorkflowGateway:
        createAuthoritativeRecordedWorkflowGatewayForTest,
      createFinalDecisionMemoAdapter: () => memoAdapter(counters),
      createRecordedRegressionRunner: () => regressionRunner({
        outputDirectory: regressionDirectory,
        counter: counters,
      }),
      reloadRecordedBenchmarkPackForColdStart: (input) => {
        counters.coldReload += 1;
        return reloadRecordedBenchmarkPackForColdStartForTest({
          ...input,
          privateBlindingSeedRootDirectory,
          judgeEvidencePrecommitStore,
        });
      },
      now: () => {
        const value = new Date(
          Date.parse("2026-07-17T15:00:00.000Z") + clockTick * 1_000,
        ).toISOString();
        clockTick += 1;
        return value;
      },
    } satisfies AuthoritativeChallengeRoomProcessTestDependencies;
    const environment = {
      AI_AUTHORITATIVE_CHALLENGE_ROOM_ROOT: root,
      AI_AUTHORITATIVE_WORKSPACE_PORT: "0",
    } as NodeJS.ProcessEnv;

    let runtime = await startAuthoritativeChallengeRoomFromEnvironmentForTest({
      environment,
      dependencies: processDependencies,
    });
    const workspace = () => readJson<{
      readonly source_hash: string;
      readonly challenge_id: string;
      readonly benchmark_id: string | null;
      readonly review_id: string | null;
      readonly decision_id: string | null;
      readonly baseline_id: string | null;
      readonly regression_id: string | null;
      readonly stage_statuses: Readonly<Record<string, string>>;
    }>(fetch(`${runtime.server.origin}/api/workspace`));
    const restart = async () => {
      const before = await workspace();
      await runtime.server.close();
      runtime = await startAuthoritativeChallengeRoomFromEnvironmentForTest({
        environment,
        dependencies: processDependencies,
      });
      expect(await workspace()).toEqual(before);
      return before;
    };
    const post = async (
      path: string,
      body: unknown,
      headers: Readonly<Record<string, string>> = {},
    ) => readJson<{ accepted: true; source_hash: string }>(fetch(
      `${runtime.server.origin}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      },
    ));

    try {
      let current = await workspace();
      await post("/api/define/structure", {
        schema_version: "define-structure-command-v1",
        expected_source_hash: current.source_hash,
        idempotency_key: "mutation_full_lifecycle_define_001",
        payload: {
          actor_type: "HUMAN",
          actor_label: "Synthetic evaluation lead",
        },
      });
      current = await restart();
      expect(current.stage_statuses.define).toBe("PROPOSED");

      const challenge = await readJson<{
        readonly source_hash: string;
        readonly approved_contract_hash: string;
        readonly suggestion_summary: {
          readonly artifact_hash: string;
        };
      }>(fetch(
        `${runtime.server.origin}/api/challenges/${current.challenge_id}`,
      ));
      await post(`/api/challenges/${current.challenge_id}/lock`, {
        schema_version: "challenge-lock-command-v1",
        expected_source_hash: current.source_hash,
        idempotency_key: "mutation_full_lifecycle_lock_001",
        payload: {
          actor_type: "HUMAN",
          actor_label: "Synthetic evaluation lead",
          decision: "APPROVE_EXACT_CONTRACT",
          define_structuring_artifact_hash:
            challenge.suggestion_summary.artifact_hash,
          approved_contract_hash: challenge.approved_contract_hash,
        },
      });
      current = await restart();
      expect(current.stage_statuses.define).toBe("LOCKED");
      expect(current.benchmark_id).not.toBeNull();

      await post(`/api/benchmarks/${current.benchmark_id}/start`, {
        schema_version: "benchmark-start-command-v1",
        expected_source_hash: current.source_hash,
        idempotency_key: "mutation_full_lifecycle_compare_001",
        payload: {
          actor_type: "HUMAN",
          actor_label: "Evaluation owner",
          execution_mode: "START",
          acknowledgement:
            "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
          resume_from_progress_hash: null,
        },
      });
      await vi.waitFor(async () => {
        expect((await workspace()).review_id).not.toBeNull();
      }, { timeout: 30_000, interval: 50 });
      current = await restart();
      expect(current.stage_statuses.compare).toBe("RECORDED");
      expect(counters).toMatchObject({ benchmark: 72, judge: 12 });
      expect(readRecordedPack()?.benchmark_execution_pack.slots)
        .toHaveLength(72);
      expect(readColdAuthorityPaths()).toHaveLength(5);
      expect(readColdAuthorityPaths().every((authorityPath) => (
        isStrictlyContained(root, authorityPath)
      ))).toBe(true);
      expect(readColdAuthorityPaths()[0])
        .toBe(privateBlindingSeedRootDirectory);
      expect(readColdAuthorityPaths()[2]).toBe(precommitRootDirectory);

      const auth = reviewerHeaders(
        runtime.server.origin,
        runtime.server.reviewerBootstrapUrl,
      );
      const review = await readJson<{
        readonly source_hash: string;
        readonly items: readonly {
          readonly item_id: string;
          readonly evidence_id: string;
          readonly review_evidence_handle: string;
          readonly proposed_decision:
            | "PROPOSED_PASS"
            | "PROPOSED_CONFIRMED_FAIL";
          readonly rationale: string;
        }[];
      }>(fetch(
        `${runtime.server.origin}/api/reviews/${current.review_id}`,
        { headers: auth },
      ));
      expect(review.items).toHaveLength(12);
      for (const item of review.items) {
        const detail = await fetch(
          `${runtime.server.origin}/api/reviewer/evidence/${item.evidence_id}`,
          {
            headers: {
              ...auth,
              "x-review-evidence-handle": item.review_evidence_handle,
            },
          },
        );
        expect(detail.status).toBe(200);
      }
      await post(`/api/reviews/${current.review_id}/confirm`, {
        schema_version: "review-confirmation-command-v1",
        expected_source_hash: review.source_hash,
        idempotency_key: "mutation_full_lifecycle_review_001",
        payload: {
          action: "ACCEPT_ALL",
          actor_label: "Evaluation owner",
          items: review.items.map((item) => ({
            item_id: item.item_id,
            final_decision: item.proposed_decision === "PROPOSED_PASS"
              ? "PASS"
              : "CONFIRMED_FAIL",
            rationale: item.rationale,
            proposal_resolution: "ACCEPTED",
            review_duration_ms: 1,
            edit_duration_ms: 0,
          })),
        },
      }, auth);
      current = await restart();
      expect(current.stage_statuses.decide).toBe("HUMAN CONFIRMED REVIEW");

      let decision = await readJson<{
        readonly source_hash: string;
        readonly eligible_candidate_ids: readonly ("A" | "B" | "C")[];
        readonly final_decision_memo_hash: string | null;
      }>(fetch(
        `${runtime.server.origin}/api/decisions/${current.decision_id}`,
      ));
      expect(decision.eligible_candidate_ids).toContain("A");
      await post(`/api/decisions/${current.decision_id}/memo`, {
        schema_version: "decision-memo-command-v1",
        expected_source_hash: decision.source_hash,
        idempotency_key: "mutation_full_lifecycle_memo_001",
        payload: {
          action: "SELECT_CANDIDATE",
          candidate_id: "A",
          rationale: "A is the simplest sufficient recorded configuration.",
        },
      });
      current = await restart();
      expect(current.stage_statuses.decide).toBe("MEMO REVIEW REQUIRED");
      expect(counters.memo).toBe(1);

      decision = await readJson(fetch(
        `${runtime.server.origin}/api/decisions/${current.decision_id}`,
      ));
      expect(decision.final_decision_memo_hash).toMatch(/^[a-f0-9]{64}$/);
      await post(`/api/decisions/${current.decision_id}/confirm`, {
        schema_version: "decision-confirmation-command-v1",
        expected_source_hash: decision.source_hash,
        idempotency_key: "mutation_full_lifecycle_decision_001",
        payload: {
          action: "CONFIRM",
          expected_final_decision_memo_hash:
            decision.final_decision_memo_hash,
        },
      });
      current = await restart();
      expect(current.stage_statuses.monitor).toBe("BASELINE ACTIVE");
      expect(current.baseline_id).not.toBeNull();
      const activeBaselineId = current.baseline_id!;

      await post(`/api/regressions/${current.baseline_id}/start`, {
        schema_version: "regression-start-command-v1",
        expected_source_hash: current.source_hash,
        idempotency_key: "mutation_full_lifecycle_regression_001",
        payload: {},
      });
      current = await restart();
      expect(counters.regression).toBe(36);
      expect(current.stage_statuses.monitor).toBe("BLOCK");
      expect(current.baseline_id).toBe(activeBaselineId);
      expect(current.regression_id).not.toBeNull();
      const regression = await readJson<{
        readonly verdict: string;
        readonly new_hard_gate_failures: readonly {
          readonly case_id: string;
          readonly proposed_status: string;
        }[];
        readonly external_deployment_performed: boolean;
        readonly external_rollback_performed: boolean;
      }>(fetch(
        `${runtime.server.origin}/api/regressions/${current.regression_id}`,
      ));
      expect(regression).toMatchObject({
        verdict: "BLOCK",
        external_deployment_performed: false,
        external_rollback_performed: false,
      });
      expect(regression.new_hard_gate_failures).toEqual([
        expect.objectContaining({
          case_id: "H-011",
          proposed_status: "CONFIRMED_FAIL",
        }),
      ]);
      const baseline = await readJson<{
        readonly baseline_id: string;
        readonly status: string;
      }>(fetch(
        `${runtime.server.origin}/api/baselines/${activeBaselineId}`,
      ));
      expect(baseline).toMatchObject({
        baseline_id: activeBaselineId,
        status: "ACTIVE",
      });
      expect(counters.externalProvider).toBe(0);
      expect(counters.define).toBe(1);
      expect(counters.coldReload).toBeGreaterThan(0);
    } finally {
      await runtime.server.close();
      delete (globalThis as { __reuseRecordedReviewFixture?: boolean })
        .__reuseRecordedReviewFixture;
    }
  }, 120_000);
});

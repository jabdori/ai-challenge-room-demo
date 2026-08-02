import type { BenchmarkExecutionIdentity } from "../benchmark/identity";
import type { BenchmarkSchedule } from "../benchmark/schedule";
import type { CandidateOutput } from "../contracts/candidateOutput";
import { parseCandidateOutput } from "../contracts/candidateOutput";
import {
  BENCHMARK_CASES,
  BENCHMARK_ORACLES,
} from "../data/benchmark";
import {
  buildExecutionBoundPrivateBlindMapping,
} from "../review/judgeEvidenceManifest";
import { BENCHMARK_CANDIDATE_IDS } from "../judge/blinding";
import {
  buildBlindJudgeInput,
  type CandidateJudgeSource,
} from "../judge/buildJudgeInput";
import {
  BLIND_JUDGE_LABELS,
} from "../judge/contracts";
import {
  createOpenAIJudgeAdapter,
  type JudgeAdapter,
  type OpenAIJudgeResponsesClientLike,
} from "../judge/openaiJudgeAdapter";
import { runOrResumeBlindJudgeCase } from "../judge/judgeCaseLedger";
import {
  buildJudgeEvidencePrecommitManifest,
  type JudgeEvidencePrecommitManifest,
} from "../review/judgeEvidenceManifest";
import {
  persistAuthoritativeBlindingPrecommit,
  type AuthoritativeBlindingPrecommit,
} from "../review/judgeEvidencePrecommitPersistence";
import {
  assertAuthoritativePrivateBlindingContext,
  loadOrCreateAuthoritativePrivateBlindingContext,
  type AuthoritativePrivateBlindingContext,
} from "../review/privateBlindingSeedPersistence";
import {
  buildBlindReviewQueue,
  type BuildBlindReviewQueueInput,
} from "../review/buildReviewQueue";
import { throwIfAborted } from "../runner/types";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import {
  assertAuxiliaryJudgeEligibleBenchmarkExecutionPack,
  type BenchmarkExecutionPack,
} from "./benchmarkPack";
import {
  loadPersistedBenchmarkExecutionEvidence,
  type BenchmarkEvidenceReloadPlan,
} from "./loadBenchmarkExecutionEvidence";
import { buildJudgeEvidencePack } from "./judgeEvidencePack";
import {
  buildRecordedBenchmarkPack,
  type RecordedBenchmarkPack,
} from "./recordedBenchmarkPack";

export interface RecordedBenchmarkPromotionResult {
  readonly pack: RecordedBenchmarkPack;
  readonly auxiliaryJudgeCount: 12;
  readonly completeJudgeCount: number;
  readonly humanFallbackJudgeCount: number;
}

export interface PromoteRecordedBenchmarkWithAdapterInput {
  readonly outputDirectory: string;
  readonly benchmarkPack: BenchmarkExecutionPack;
  readonly executionIdentity: BenchmarkExecutionIdentity;
  readonly schedule: BenchmarkSchedule;
  readonly plans: readonly BenchmarkEvidenceReloadPlan[];
  readonly judgeAdapter: JudgeAdapter;
  readonly privateBlindingContext: AuthoritativePrivateBlindingContext;
  /** 새 benchmark 승격에서만 write-once precommit을 생성합니다. */
  readonly persistPrecommit?: (
    manifest: JudgeEvidencePrecommitManifest,
  ) => Promise<AuthoritativeBlindingPrecommit>;
  /** cold reload은 이미 source-reload한 branded precommit만 전달합니다. */
  readonly authoritativePrecommit?: AuthoritativeBlindingPrecommit;
  readonly signal?: AbortSignal;
}

export interface PromoteRecordedBenchmarkInput {
  readonly client: OpenAIJudgeResponsesClientLike;
  readonly outputDirectory: string;
  readonly executionPack: BenchmarkExecutionPack;
  readonly executionIdentity: BenchmarkExecutionIdentity;
  readonly schedule: BenchmarkSchedule;
  readonly plans: readonly BenchmarkEvidenceReloadPlan[];
  readonly signal?: AbortSignal;
}

function candidateSourcesForCase(
  pack: BenchmarkExecutionPack,
  caseId: string,
): [CandidateJudgeSource, CandidateJudgeSource, CandidateJudgeSource] {
  return BENCHMARK_CANDIDATE_IDS.map((candidateId) => ({
    candidate_id: candidateId,
    runs: ([1, 2] as const).map((repetition) => {
      const slot = pack.slots.find((item) => (
        item.slot.case_id === caseId
        && item.slot.candidate_id === candidateId
        && item.slot.repetition === repetition
      ));
      if (slot === undefined || slot.cost_state !== "COMPLETE" || slot.run === null) {
        throw new TypeError(
          `${caseId}:${candidateId}:r${repetition} Judge 입력용 실행 근거가 없습니다.`,
        );
      }
      if (slot.execution_status === "COMPLETE") {
        if (slot.evaluation_state.status !== "EVALUATED") {
          throw new TypeError(
            `${caseId}:${candidateId}:r${repetition} 완료 실행의 결정적 평가가 없습니다.`,
          );
        }
        return {
          repetition,
          execution_status: "COMPLETE" as const,
          output: parseCandidateOutput(slot.run.output),
        };
      }
      if (
        slot.execution_status !== "INVALID"
        && slot.execution_status !== "TIMEOUT"
        && slot.execution_status !== "BUDGET_EXCEEDED"
      ) {
        throw new TypeError(
          `${caseId}:${candidateId}:r${repetition}은 Judge 가능한 terminal 실행이 아닙니다.`,
        );
      }
      return {
        repetition,
        execution_status: slot.execution_status,
        output: null,
      };
    }),
  })) as [CandidateJudgeSource, CandidateJudgeSource, CandidateJudgeSource];
}

/**
 * 외부 호출 경계를 주입받는 승격 커널입니다.
 * 72 persisted chain을 먼저 재검증하고, exact 12 Judge를 순차 실행한 뒤에만
 * REVIEW_PENDING Recorded Benchmark 부모 팩을 반환합니다.
 */
export async function promoteRecordedBenchmarkWithAdapter({
  outputDirectory,
  benchmarkPack,
  executionIdentity,
  schedule,
  plans,
  judgeAdapter,
  privateBlindingContext,
  persistPrecommit,
  authoritativePrecommit,
  signal,
}: PromoteRecordedBenchmarkWithAdapterInput): Promise<RecordedBenchmarkPromotionResult> {
  throwIfAborted(signal);
  assertAuxiliaryJudgeEligibleBenchmarkExecutionPack(benchmarkPack);
  const executionEvidence = await loadPersistedBenchmarkExecutionEvidence({
    outputDirectory,
    benchmarkPack,
    executionIdentity,
    schedule,
    plans,
  });
  const parentPackHash = sha256CanonicalJson(benchmarkPack);
  assertAuthoritativePrivateBlindingContext({
    context: privateBlindingContext,
    expectedExecutionPackHash: parentPackHash,
  });
  const masterBlindingSeed =
    privateBlindingContext.master_blinding_seed;
  const prepared = BENCHMARK_CASES.map((evaluationCase) => {
    const oracle = BENCHMARK_ORACLES.find(
      (item) => item.case_id === evaluationCase.case_id,
    );
    if (oracle === undefined) {
      throw new TypeError(`잠긴 Judge oracle이 없습니다: ${evaluationCase.case_id}`);
    }
    const mapping = buildExecutionBoundPrivateBlindMapping({
      caseId: evaluationCase.case_id,
      executionPackHash: parentPackHash,
      masterBlindingSeed,
    });
    const bundle = buildBlindJudgeInput({
      evaluationCase,
      oracle,
      candidateSources: candidateSourcesForCase(
        benchmarkPack,
        evaluationCase.case_id,
      ),
      blindingSeed: mapping.case_blinding_seed,
    });
    if (BLIND_JUDGE_LABELS.some((label) => (
      bundle.private_mapping.label_to_candidate[label]
      !== mapping.label_to_candidate[label]
    ))) {
      throw new TypeError(
        `${evaluationCase.case_id} execution-bound blind mapping이 다릅니다.`,
      );
    }
    return {
      evaluationCase,
      mapping,
      judgeInput: bundle.judge_input,
    };
  });
  const manifest = buildJudgeEvidencePrecommitManifest({
    executionPackHash: parentPackHash,
    masterBlindingSeed,
    judgeInputBindings: prepared.map((item) => ({
      case_id: item.evaluationCase.case_id,
      judge_input_hash: sha256CanonicalJson(item.judgeInput),
    })),
  });
  if (
    (persistPrecommit === undefined && authoritativePrecommit === undefined)
    || (persistPrecommit !== undefined && authoritativePrecommit !== undefined)
  ) {
    throw new TypeError(
      "Recorded Benchmark 승격에는 새 precommit persist 또는 cold source-reloaded precommit 중 정확히 하나가 필요합니다.",
    );
  }
  const resolvedPrecommit = authoritativePrecommit === undefined
    ? await persistPrecommit!(manifest)
    : authoritativePrecommit;
  if (
    sha256CanonicalJson(resolvedPrecommit.manifest)
      !== sha256CanonicalJson(manifest)
  ) {
    throw new TypeError("source-reloaded Judge precommit이 재구성한 manifest와 다릅니다.");
  }

  const judgeCases = [];
  for (const item of prepared) {
    throwIfAborted(signal);
    const ledger = await runOrResumeBlindJudgeCase({
      outputDirectory,
      adapter: judgeAdapter,
      input: item.judgeInput,
      authoritativePrecommit: resolvedPrecommit,
      ...(signal ? { signal } : {}),
    });
    const receipt = ledger.judgeRunReceipt;
    const safeHumanFallback = receipt.judgeStatus === "JUDGE_INCOMPLETE"
      && receipt.result === null
      && receipt.costState === "COMPLETE"
      && receipt.usageCost !== null
      && receipt.attempts.length > 0
      && receipt.attempts.every((attempt) => (
        attempt.requestDisposition === "RESPONSE_RECEIVED"
        && attempt.costState === "COMPLETE"
      ));
    if (
      receipt.judgeStatus !== "JUDGE_COMPLETE"
      && !safeHumanFallback
    ) {
      throw new TypeError(
        `${item.evaluationCase.case_id} 보조 Judge 실패는 안전한 사람 fallback 계약이 아닙니다.`,
      );
    }
    judgeCases.push({
      schema_version: "review-queue-judge-case-v1" as const,
      case_id: item.evaluationCase.case_id,
      expected_blind_input: item.judgeInput,
      private_mapping: item.mapping,
      judge_run_receipt: receipt,
    });
  }
  if (judgeCases.length !== 12) {
    throw new TypeError("Recorded Benchmark 승격에는 exact 12 Judge receipt가 필요합니다.");
  }
  const reviewQueueInput: BuildBlindReviewQueueInput = {
    schema_version: "build-blind-review-queue-input-v1",
    execution_evidence: {
      schema_version: "review-queue-execution-evidence-v1",
      execution_identity: executionEvidence.execution_identity,
      completed_slots: executionEvidence.completed_slots,
    },
    authoritative_blinding_precommit: resolvedPrecommit,
    private_blinding_context: {
      schema_version: "private-blinding-context-v1",
      master_blinding_seed: masterBlindingSeed,
    },
    judge_cases: judgeCases,
  };
  const queue = buildBlindReviewQueue(reviewQueueInput);
  const judgeEvidencePack = buildJudgeEvidencePack({
    benchmarkPack,
    reviewQueueInput,
    blindReviewQueue: queue,
  });
  const pack = buildRecordedBenchmarkPack({
    benchmarkPack,
    judgeEvidencePack,
    blindReviewQueue: queue,
  });
  return Object.freeze({
    pack,
    auxiliaryJudgeCount: 12,
    completeJudgeCount:
      judgeEvidencePack.coverage.complete_judge_cases,
    humanFallbackJudgeCount:
      judgeEvidencePack.coverage.human_fallback_judge_cases,
  });
}

/** 실제 Responses API와 프로덕션 단일 precommit authority를 사용하는 경계입니다. */
export async function promoteRecordedBenchmark({
  client,
  outputDirectory,
  executionPack,
  executionIdentity,
  schedule,
  plans,
  signal,
}: PromoteRecordedBenchmarkInput): Promise<RecordedBenchmarkPromotionResult> {
  const executionPackHash = sha256CanonicalJson(executionPack);
  const privateBlindingContext =
    await loadOrCreateAuthoritativePrivateBlindingContext({
      executionPackHash,
    });
  return promoteRecordedBenchmarkWithAdapter({
    outputDirectory,
    benchmarkPack: executionPack,
    executionIdentity,
    schedule,
    plans,
    judgeAdapter: createOpenAIJudgeAdapter(client),
    privateBlindingContext,
    persistPrecommit: (manifest) => (
      persistAuthoritativeBlindingPrecommit({ manifest })
    ),
    ...(signal ? { signal } : {}),
  });
}

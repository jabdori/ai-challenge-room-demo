import type { PartialCalibrationPack } from "../pack/calibrationPack";
import { redactSensitiveText } from "../runtime/secretSafety";
import type { PolicyVectorStoreCleanupResult } from "../retrieval/policyVectorStore";
import { sha256Utf8 } from "../runtime/canonicalJson";
import type { TokenUsage } from "../runtime/pricing";
import type { CalibrationCandidateId } from "../smoke/candidateDefinitions";

export interface CalibrationResourceIds {
  vectorStoreId: string | null;
  uploadedFileIds: readonly string[];
}

export type CalibrationInterruption = "SIGINT" | "SIGTERM";

interface UsageSummary {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
}

interface CandidateRunSummary {
  run: number;
  execution_status: string;
  gate_status: string;
  attempts: number;
  model_calls: number;
  retrieval_calls: number;
  tool_calls: number;
  usage: UsageSummary;
  latency_ms: number;
  usage_complete: boolean;
  runtime_cost_usd: number | null;
}

interface CandidateCalibrationSummary {
  runs: number;
  complete_runs: number;
  attempts: number;
  gate_passes: number;
  gate_failures: number;
  gates_not_evaluated: number;
  model_calls: number;
  retrieval_calls: number;
  tool_calls: number;
  models_reported: string[];
  usage: UsageSummary;
  latency_ms: number;
  usage_complete: boolean;
  runtime_cost_usd: number | null;
  run_details: CandidateRunSummary[];
}

interface CleanupResourceSummary {
  kind: "VECTOR_STORE" | "UPLOADED_FILE";
  fingerprint: string;
  delete_acknowledged: boolean;
}

export interface CalibrationSummary {
  command_status:
    | "CALIBRATION_COMPLETE"
    | "CALIBRATION_INCOMPLETE"
    | "CALIBRATION_FAILED"
    | "CALIBRATION_INTERRUPTED";
  artifact_kind: "PARTIAL_CALIBRATION_PACK";
  source: "CALIBRATION_SMOKE";
  evaluation_status: "EVALUATION_INCOMPLETE";
  recorded_benchmark: false;
  baseline_created: false;
  top_pack_path: string | null;
  candidates: Record<CalibrationCandidateId, CandidateCalibrationSummary>;
  usage_complete: boolean;
  total_runtime_cost_usd: number | null;
  cleanup: {
    required: number;
    acknowledged: number;
    incomplete: number;
    resources: CleanupResourceSummary[];
    receipt_path?: string;
  };
  error?: string;
  errors?: string[];
}

export interface CalibrationOutcome {
  exitCode: 0 | 1 | 2 | 130 | 143;
  summary: CalibrationSummary;
}

interface DeriveCalibrationOutcomeInput {
  pack: PartialCalibrationPack | null;
  topPackPath: string | null;
  expectedResources?: CalibrationResourceIds | null;
  cleanup?: PolicyVectorStoreCleanupResult | null;
  runtimeError?: unknown;
  runtimeErrors?: readonly unknown[];
  interruption?: CalibrationInterruption | null;
  cleanupReceiptPath?: string | null;
  sensitiveValues?: readonly string[];
}

const CANDIDATE_IDS = ["A", "B", "C"] as const;
export { redactSensitiveText } from "../runtime/secretSafety";

function emptyUsage(): UsageSummary {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
  };
}

function emptyCandidateSummary(): CandidateCalibrationSummary {
  return {
    runs: 0,
    complete_runs: 0,
    attempts: 0,
    gate_passes: 0,
    gate_failures: 0,
    gates_not_evaluated: 0,
    model_calls: 0,
    retrieval_calls: 0,
    tool_calls: 0,
    models_reported: [],
    usage: emptyUsage(),
    latency_ms: 0,
    usage_complete: false,
    runtime_cost_usd: null,
    run_details: [],
  };
}

function addUsage(target: UsageSummary, usage: TokenUsage | undefined): void {
  if (!usage) {
    return;
  }
  target.input_tokens += usage.inputTokens;
  target.cached_input_tokens += usage.cachedInputTokens;
  target.cache_write_tokens += usage.cacheWriteTokens;
  target.output_tokens += usage.outputTokens;
}

function roundUsd(value: number): number {
  return Number(value.toFixed(12));
}

function calculateUsageCost(usage: UsageSummary, pack: PartialCalibrationPack): number {
  const rates = pack.pricing_evidence.rates_per_unit;
  const regularInput = usage.input_tokens
    - usage.cached_input_tokens
    - usage.cache_write_tokens;
  return roundUsd((
    regularInput * rates.input
    + usage.cached_input_tokens * rates.cached_input
    + usage.cache_write_tokens * rates.cache_write
    + usage.output_tokens * rates.output
  ) / pack.pricing_evidence.unit_tokens);
}

function summarizeCandidates(
  pack: PartialCalibrationPack | null,
  sensitiveValues: readonly string[],
): Record<CalibrationCandidateId, CandidateCalibrationSummary> {
  const summaries = Object.fromEntries(CANDIDATE_IDS.map((candidateId) => [
    candidateId,
    emptyCandidateSummary(),
  ])) as Record<CalibrationCandidateId, CandidateCalibrationSummary>;
  if (!pack) {
    return summaries;
  }

  for (const entry of pack.entries) {
    const summary = summaries[entry.candidate_id];
    if (!summary) {
      continue;
    }
    for (const { execution, gate } of entry.evaluation_pack.runs) {
      const runUsage = emptyUsage();
      let modelCalls = 0;
      let retrievalCalls = 0;
      let toolCalls = 0;
      let runLatencyMs = 0;
      let runUsageComplete = execution.attempts.length > 0;
      summary.runs += 1;
      if (execution.status === "COMPLETE") {
        summary.complete_runs += 1;
      }
      if (gate.evaluation === "EVALUATED") {
        if (gate.result.status === "PASS") {
          summary.gate_passes += 1;
        } else {
          summary.gate_failures += 1;
        }
      } else {
        summary.gates_not_evaluated += 1;
      }
      for (const attempt of execution.attempts) {
        summary.attempts += 1;
        runLatencyMs += attempt.latencyMs;
        addUsage(runUsage, attempt.usage);
        const evidence = attempt.executionEvidence;
        if (
          attempt.usage === undefined
          || evidence === undefined
          || evidence.providerCalls.some((call) => call.usage === null)
        ) {
          runUsageComplete = false;
        }
        modelCalls += evidence?.providerCalls.length ?? 0;
        retrievalCalls += evidence?.retrievalCalls.length ?? 0;
        toolCalls += evidence?.toolCalls.length ?? 0;
        if (attempt.modelReportedId) {
          const model = redactSensitiveText(attempt.modelReportedId, sensitiveValues);
          if (!summary.models_reported.includes(model)) {
            summary.models_reported.push(model);
          }
        }
      }
      addUsage(summary.usage, {
        inputTokens: runUsage.input_tokens,
        cachedInputTokens: runUsage.cached_input_tokens,
        cacheWriteTokens: runUsage.cache_write_tokens,
        outputTokens: runUsage.output_tokens,
      });
      summary.latency_ms += runLatencyMs;
      summary.model_calls += modelCalls;
      summary.retrieval_calls += retrievalCalls;
      summary.tool_calls += toolCalls;
      summary.run_details.push({
        run: execution.runNumber,
        execution_status: execution.status,
        gate_status: gate.evaluation === "EVALUATED" ? gate.result.status : gate.evaluation,
        attempts: execution.attempts.length,
        model_calls: modelCalls,
        retrieval_calls: retrievalCalls,
        tool_calls: toolCalls,
        usage: runUsage,
        latency_ms: runLatencyMs,
        usage_complete: runUsageComplete,
        runtime_cost_usd: runUsageComplete ? calculateUsageCost(runUsage, pack) : null,
      });
    }
  }
  for (const candidateId of CANDIDATE_IDS) {
    const summary = summaries[candidateId];
    summary.usage_complete = summary.runs === 2
      && summary.run_details.every((run) => run.usage_complete);
    summary.runtime_cost_usd = summary.usage_complete
      ? calculateUsageCost(summary.usage, pack)
      : null;
  }
  return summaries;
}

function fingerprint(resourceId: string): string {
  return `sha256:${sha256Utf8(resourceId).slice(0, 12)}`;
}

function summarizeCleanup(
  expected: CalibrationResourceIds | null | undefined,
  cleanup: PolicyVectorStoreCleanupResult | null | undefined,
  receiptPath: string | null | undefined,
  sensitiveValues: readonly string[],
): CalibrationSummary["cleanup"] {
  const acknowledgementById = new Map<string, boolean>();
  if (cleanup?.vectorStore.id) {
    acknowledgementById.set(
      cleanup.vectorStore.id,
      cleanup.vectorStore.attempted && cleanup.vectorStore.deleted,
    );
  }
  for (const file of cleanup?.uploadedFiles ?? []) {
    if (file.id) {
      acknowledgementById.set(file.id, file.attempted && file.deleted);
    }
  }
  const resources: CleanupResourceSummary[] = [
    ...(expected?.vectorStoreId
      ? [{ kind: "VECTOR_STORE" as const, id: expected.vectorStoreId }]
      : []),
    ...(expected?.uploadedFileIds ?? []).map((id) => ({
      kind: "UPLOADED_FILE" as const,
      id,
    })),
  ].map(({ kind, id }) => ({
    kind,
    fingerprint: fingerprint(id),
    delete_acknowledged: acknowledgementById.get(id) === true,
  }));
  const acknowledged = resources.filter((resource) => resource.delete_acknowledged).length;
  return {
    required: resources.length,
    acknowledged,
    incomplete: resources.length - acknowledged,
    resources,
    ...(receiptPath
      ? { receipt_path: redactSensitiveText(receiptPath, sensitiveValues) }
      : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "알 수 없는 calibration 오류";
}

export function deriveCalibrationOutcome({
  pack,
  topPackPath,
  expectedResources,
  cleanup,
  runtimeError,
  runtimeErrors = [],
  interruption,
  cleanupReceiptPath,
  sensitiveValues = [],
}: DeriveCalibrationOutcomeInput): CalibrationOutcome {
  const errors = [
    ...(runtimeError === undefined ? [] : [runtimeError]),
    ...runtimeErrors,
  ].map((error) => redactSensitiveText(errorMessage(error), sensitiveValues));
  const candidates = summarizeCandidates(pack, sensitiveValues);
  const cleanupSummary = summarizeCleanup(
    expectedResources,
    cleanup,
    cleanupReceiptPath,
    sensitiveValues,
  );
  const allRunsComplete = CANDIDATE_IDS.every((candidateId) => {
    const candidate = candidates[candidateId];
    return candidate.runs === 2
      && candidate.complete_runs === 2
      && candidate.gate_passes === 2
      && candidate.gate_failures === 0
      && candidate.gates_not_evaluated === 0;
  });
  const packComplete = pack !== null && topPackPath !== null && allRunsComplete;
  const cleanupComplete = cleanupSummary.incomplete === 0;
  const exitCode: CalibrationOutcome["exitCode"] = interruption === "SIGINT"
    ? 130
    : interruption === "SIGTERM"
      ? 143
      : !cleanupComplete
        ? 2
        : packComplete && errors.length === 0
          ? 0
          : 1;
  const commandStatus: CalibrationSummary["command_status"] = interruption
    ? "CALIBRATION_INTERRUPTED"
    : !cleanupComplete
      ? "CALIBRATION_FAILED"
      : errors.length > 0 || !pack
        ? "CALIBRATION_FAILED"
        : packComplete
          ? "CALIBRATION_COMPLETE"
          : "CALIBRATION_INCOMPLETE";

  const usageComplete = CANDIDATE_IDS.every(
    (candidateId) => candidates[candidateId].usage_complete,
  );
  return {
    exitCode,
    summary: {
      command_status: commandStatus,
      artifact_kind: "PARTIAL_CALIBRATION_PACK",
      source: "CALIBRATION_SMOKE",
      evaluation_status: "EVALUATION_INCOMPLETE",
      recorded_benchmark: false,
      baseline_created: false,
      top_pack_path: topPackPath
        ? redactSensitiveText(topPackPath, sensitiveValues)
        : null,
      candidates,
      usage_complete: usageComplete,
      total_runtime_cost_usd: usageComplete
        ? roundUsd(CANDIDATE_IDS.reduce(
            (total, candidateId) => total + candidates[candidateId].runtime_cost_usd!,
            0,
          ))
        : null,
      cleanup: cleanupSummary,
      ...(errors[0] ? { error: errors[0], errors } : {}),
    },
  };
}

import { resolve } from "node:path";
import OpenAI from "openai";
import { requireOpenAiApiKey } from "./config";
import { createCandidateAAdapter } from "../openai/candidateAAdapter";
import { executeCalibrationSmoke } from "../smoke/executeCalibrationSmoke";
import { assertCalibrationSmokeSucceeded } from "./smokeOutcome";
import { calibrationSmokeFailureMessage } from "./calibrationSmokeFailure";

async function main(): Promise<void> {
  const apiKey = requireOpenAiApiKey(process.env);
  const client = new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: 30_000,
  });
  const adapter = createCandidateAAdapter(client);
  const outputDirectory = resolve(import.meta.dirname, "../../.runtime/evaluation-packs");
  const { pack, filePath } = await executeCalibrationSmoke({ adapter, outputDirectory });
  assertCalibrationSmokeSucceeded(pack);

  const runSummary = pack.runs.map(({ execution, gate, runtime_cost: runtimeCost }) => ({
    run: execution.runNumber,
    execution_status: execution.status,
    attempts: execution.attempts.length,
    gate_status: gate.evaluation === "EVALUATED" ? gate.result.status : gate.evaluation,
    latency_ms: execution.totalLatencyMs,
    runtime_cost_usd: runtimeCost?.totalCostUsd ?? null,
  }));

  process.stdout.write(`${JSON.stringify({
    pack_id: pack.pack_id,
    source: pack.source,
    evaluation_status: pack.evaluation_status,
    model_requested_id: pack.model_requested_id,
    model_reported_ids: pack.model_reported_ids,
    service_tiers_reported: pack.service_tiers_reported,
    runs: runSummary,
    saved_to: filePath,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${calibrationSmokeFailureMessage(error)}\n`);
  process.exitCode = 1;
});

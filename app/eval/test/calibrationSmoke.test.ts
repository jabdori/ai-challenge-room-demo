// @vitest-environment node

import { chmod, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CandidateAdapter, CandidateInvocation } from "../runner/types";
import {
  CANDIDATE_A_CONFIG,
  executeCalibrationSmoke,
} from "../smoke/executeCalibrationSmoke";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

const validOutput = {
  customer_reply: "The order has shipped and cannot be cancelled. You may request a return after delivery.",
  decision: {
    intent_codes: ["ORDER_CANCELLATION", "REFUND_REQUEST"],
    action_code: "DENY_CANCEL_AFTER_SHIPMENT",
    escalation_required: false,
    escalation_reason_code: "NOT_REQUIRED",
    target_queue: "NONE",
  },
  citations: [{ source_id: "CANCEL-2026", section_id: "2.2" }],
};

async function secureTempDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await chmod(directory, 0o700);
  return directory;
}

describe("Evaluation Pack calibration smoke 종단간 경로", () => {
  it("공개 fixture를 후보 A에 두 번 실행하고 gate·비용·해시를 저장한다", async () => {
    const invocations: CandidateInvocation[] = [];
    const adapter: CandidateAdapter = {
      invoke: async (invocation) => {
        invocations.push(invocation);
        return {
          responseId: `resp-${invocations.length}`,
          status: "completed",
          modelReportedId: "gpt-5.6-terra-2026-07-17",
          serviceTierReported: "default",
          outputText: JSON.stringify(validOutput),
          usage: {
            inputTokens: 800,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 120,
          },
        };
      },
    };
    const outputDirectory = await secureTempDirectory("calibration-smoke-");
    let now = Date.parse("2026-07-17T01:00:00.000Z");

    const result = await executeCalibrationSmoke({
      adapter,
      outputDirectory,
      now: () => (now += 10),
      createdAt: "2026-07-17T01:10:00.000Z",
    });

    expect(invocations).toHaveLength(2);
    expect(invocations[0].serviceTierRequested).toBe("default");
    expect(invocations[0].limits?.timeoutMs).toBe(29_990);
    expect(invocations[0].input).toContain("CANCEL-2026");
    expect(invocations[0].input).toContain("CANCEL-2025");
    expect(invocations[0].input).toContain("ORD-1042");
    expect(invocations[0].input).not.toContain("expected_action_code");
    expect(result.pack.source).toBe("CALIBRATION_SMOKE");
    expect(result.pack.evaluation_status).toBe("EVALUATION_INCOMPLETE");
    expect(result.pack.dataset_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.pack.candidate_config_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.pack.candidate_config_hash).toBe(sha256CanonicalJson(CANDIDATE_A_CONFIG));
    expect(CANDIDATE_A_CONFIG).toHaveProperty("output_schema");
    expect(CANDIDATE_A_CONFIG.execution_envelope.max_input_tokens).toBe(24_000);
    expect(result.pack.system_prompt_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.pack.service_tiers_reported).toEqual(["default"]);
    expect(result.pack.runs.map((run) => run.gate.evaluation)).toEqual(["EVALUATED", "EVALUATED"]);
    expect(result.pack.runs.every((run) => run.runtime_cost !== null)).toBe(true);
    expect(result.filePath).toContain("calibration-smoke-");

    const stored = JSON.parse(await readFile(result.filePath!, "utf8"));
    expect(stored.pack_id).toBe(result.pack.pack_id);
  });

  it("유효 출력이 없으면 gate를 실행하지 않고 평가 미완료로 저장한다", async () => {
    const adapter: CandidateAdapter = {
      invoke: async () => ({
        responseId: "resp-invalid",
        status: "completed",
        modelReportedId: "gpt-5.6-terra-2026-07-17",
        serviceTierReported: "default",
        outputText: "{}",
        usage: { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
      }),
    };

    const result = await executeCalibrationSmoke({
      adapter,
      createdAt: "2026-07-17T01:10:00.000Z",
    });

    expect(result.filePath).toBeNull();
    expect(result.pack.runs.every((run) => run.gate.evaluation === "NOT_EVALUATED")).toBe(true);
    expect(result.pack.runs.every((run) => run.execution.attempts.length === 2)).toBe(true);
  });

  it("run deadline 초과는 INVALID_OUTPUT으로 숨기지 않고 TIMEOUT 미평가 사유로 저장한다", async () => {
    let currentTime = 0;
    const adapter: CandidateAdapter = {
      invoke: async () => {
        currentTime += 30_001;
        return {
          responseId: "resp-too-late",
          status: "completed",
          modelReportedId: "gpt-5.6-terra-2026-07-17",
          serviceTierReported: "default",
          outputText: JSON.stringify(validOutput),
          usage: {
            inputTokens: 800,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 120,
          },
        };
      },
    };

    const result = await executeCalibrationSmoke({
      adapter,
      now: () => currentTime,
      createdAt: "2026-07-17T01:10:00.000Z",
    });

    expect(result.pack.runs.every((run) => run.execution.status === "TIMEOUT")).toBe(true);
    expect(result.pack.runs.map((run) => run.gate)).toEqual([
      { runNumber: 1, evaluation: "NOT_EVALUATED", reason: "TIMEOUT" },
      { runNumber: 2, evaluation: "NOT_EVALUATED", reason: "TIMEOUT" },
    ]);
  });
});

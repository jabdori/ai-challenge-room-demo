// @vitest-environment node

import { describe, expect, it } from "vitest";
import { deriveCalibrationOutcome } from "../cli/calibrationOutcome";
import {
  TEST_RESOURCE_IDS,
  buildSummaryPack,
  completeCleanup,
} from "./helpers/calibrationCommandFixtures";

describe("A/B/C calibration 순수 결과 판정", () => {
  it("pack이 없거나 후보 실행이 정확히 2회가 아니면 사용량과 비용을 unknown으로 표시한다", () => {
    const noPack = deriveCalibrationOutcome({
      pack: null,
      topPackPath: null,
    });

    expect(noPack.summary).toMatchObject({
      usage_complete: false,
      total_runtime_cost_usd: null,
      candidates: {
        A: { runs: 0, usage_complete: false, runtime_cost_usd: null },
        B: { runs: 0, usage_complete: false, runtime_cost_usd: null },
        C: { runs: 0, usage_complete: false, runtime_cost_usd: null },
      },
    });

    const partialPack = buildSummaryPack();
    partialPack.entries[1].evaluation_pack.runs.pop();
    const partial = deriveCalibrationOutcome({
      pack: partialPack,
      topPackPath: "/private/runtime/top-pack.json",
    });

    expect(partial.summary.candidates.B).toMatchObject({
      runs: 1,
      usage_complete: false,
      runtime_cost_usd: null,
    });
    expect(partial.summary).toMatchObject({
      usage_complete: false,
      total_runtime_cost_usd: null,
    });
  });

  it("EVALUATION_INCOMPLETE pack이어도 6 COMPLETE·6 PASS·저장·cleanup ack면 exit 0이다", () => {
    const outcome = deriveCalibrationOutcome({
      pack: buildSummaryPack(),
      topPackPath: "/private/runtime/top-pack.json",
      expectedResources: TEST_RESOURCE_IDS,
      cleanup: completeCleanup(),
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.summary).toMatchObject({
      command_status: "CALIBRATION_COMPLETE",
      artifact_kind: "PARTIAL_CALIBRATION_PACK",
      source: "CALIBRATION_SMOKE",
      evaluation_status: "EVALUATION_INCOMPLETE",
      recorded_benchmark: false,
      baseline_created: false,
      top_pack_path: "/private/runtime/top-pack.json",
      total_runtime_cost_usd: 0.003165,
      usage_complete: true,
      candidates: {
        A: {
          runs: 2,
          complete_runs: 2,
          attempts: 2,
          gate_passes: 2,
          model_calls: 2,
          retrieval_calls: 0,
          tool_calls: 0,
          latency_ms: 20,
          runtime_cost_usd: 0.001055,
          usage_complete: true,
        },
        B: { retrieval_calls: 2 },
        C: { tool_calls: 0 },
      },
      cleanup: {
        required: 3,
        acknowledged: 3,
        incomplete: 0,
        resources: expect.arrayContaining([expect.objectContaining({
          kind: "VECTOR_STORE",
          fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{12}$/),
          delete_acknowledged: true,
        })]),
      },
    });
    expect(outcome.summary.candidates.A.usage).toEqual({
      input_tokens: 200,
      cached_input_tokens: 20,
      cache_write_tokens: 0,
      output_tokens: 40,
    });
    expect(outcome.summary.candidates.A.run_details).toEqual(expect.arrayContaining([
      expect.objectContaining({
        run: 1,
        execution_status: "COMPLETE",
        gate_status: "PASS",
        attempts: 1,
        model_calls: 1,
        retrieval_calls: 0,
        tool_calls: 0,
        latency_ms: 10,
        runtime_cost_usd: 0.0005275,
        usage_complete: true,
      }),
    ]));
    expect(outcome.summary.cleanup.resources.map(({ kind, fingerprint }) => ({
      kind,
      fingerprint,
    }))).toEqual([
      { kind: "VECTOR_STORE", fingerprint: "sha256:a6799bc259fa" },
      { kind: "UPLOADED_FILE", fingerprint: "sha256:433e40dc6f6e" },
      { kind: "UPLOADED_FILE", fingerprint: "sha256:4f5d03d9bbbd" },
    ]);
    const serialized = JSON.stringify(outcome.summary);
    expect(serialized).not.toMatch(/winner|approved|baseline_version/i);
    expect(serialized).not.toContain(TEST_RESOURCE_IDS.vectorStoreId);
    expect(TEST_RESOURCE_IDS.uploadedFileIds.every((id) => !serialized.includes(id))).toBe(true);
  });

  it("attempt/provider usage가 하나라도 미보고면 비용을 0으로 꾸미지 않고 unknown으로 표시한다", () => {
    const pack = buildSummaryPack({ invalidCandidate: "A" });
    const attempt = pack.entries[0].evaluation_pack.runs[0].execution.attempts[0];
    delete attempt.usage;
    attempt.executionEvidence!.providerCalls[0].status = "failed";
    attempt.executionEvidence!.providerCalls[0].usage = null;
    const outcome = deriveCalibrationOutcome({
      pack,
      topPackPath: "/private/runtime/top-pack.json",
      expectedResources: TEST_RESOURCE_IDS,
      cleanup: completeCleanup(),
    });

    expect(outcome.summary.candidates.A.run_details[0]).toMatchObject({
      usage_complete: false,
      runtime_cost_usd: null,
    });
    expect(outcome.summary.candidates.A).toMatchObject({
      usage_complete: false,
      runtime_cost_usd: null,
    });
    expect(outcome.summary).toMatchObject({
      usage_complete: false,
      total_runtime_cost_usd: null,
    });
  });

  it("저장된 pack에 invalid run 또는 gate fail이 있으면 pack 경로를 보존하고 exit 1이다", () => {
    for (const pack of [
      buildSummaryPack({ invalidCandidate: "A" }),
      buildSummaryPack({ failedGateCandidate: "B" }),
    ]) {
      const outcome = deriveCalibrationOutcome({
        pack,
        topPackPath: "/private/runtime/top-pack.json",
        expectedResources: TEST_RESOURCE_IDS,
        cleanup: completeCleanup(),
      });
      expect(outcome.exitCode).toBe(1);
      expect(outcome.summary.command_status).toBe("CALIBRATION_INCOMPLETE");
      expect(outcome.summary.top_pack_path).toBe("/private/runtime/top-pack.json");
    }
  });

  it("cleanup 불완전은 exit 2이며 리소스 원문 ID를 summary에 노출하지 않는다", () => {
    const cleanup = completeCleanup();
    cleanup.uploadedFiles[0].deleted = false;
    cleanup.uploadedFiles[0].error = "delete denied";
    const outcome = deriveCalibrationOutcome({
      pack: buildSummaryPack(),
      topPackPath: "/private/runtime/top-pack.json",
      expectedResources: TEST_RESOURCE_IDS,
      cleanup,
      cleanupReceiptPath: "/private/runtime/cleanup-receipt.json",
    });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.summary.command_status).toBe("CALIBRATION_FAILED");
    expect(outcome.summary.cleanup).toMatchObject({
      required: 3,
      acknowledged: 2,
      incomplete: 1,
      receipt_path: "/private/runtime/cleanup-receipt.json",
    });
    const serialized = JSON.stringify(outcome.summary.cleanup);
    expect(serialized).not.toContain(TEST_RESOURCE_IDS.vectorStoreId);
    expect(TEST_RESOURCE_IDS.uploadedFileIds.every((id) => !serialized.includes(id))).toBe(true);
  });

  it("pack과 cleanup이 동시에 불완전하면 exit 2의 CALIBRATION_FAILED로 판정한다", () => {
    const cleanup = completeCleanup();
    cleanup.uploadedFiles[0].deleted = false;
    const outcome = deriveCalibrationOutcome({
      pack: buildSummaryPack({ invalidCandidate: "A" }),
      topPackPath: "/private/runtime/partial-top-pack.json",
      expectedResources: TEST_RESOURCE_IDS,
      cleanup,
    });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.summary).toMatchObject({
      command_status: "CALIBRATION_FAILED",
      artifact_kind: "PARTIAL_CALIBRATION_PACK",
      source: "CALIBRATION_SMOKE",
      evaluation_status: "EVALUATION_INCOMPLETE",
      top_pack_path: "/private/runtime/partial-top-pack.json",
      cleanup: { required: 3, acknowledged: 2, incomplete: 1 },
    });
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("%s interruption은 cleanup 실패보다 우선한다", (interruption, exitCode) => {
    const cleanup = completeCleanup();
    cleanup.vectorStore.deleted = false;
    const outcome = deriveCalibrationOutcome({
      pack: null,
      topPackPath: null,
      expectedResources: TEST_RESOURCE_IDS,
      cleanup,
      interruption,
      runtimeErrors: [new Error("interrupted")],
    });
    expect(outcome.exitCode).toBe(exitCode);
    expect(outcome.summary.command_status).toBe("CALIBRATION_INTERRUPTED");
  });

  it("terminal summary의 오류·모델·경로에서 key와 full resource ID를 redaction한다", () => {
    const secret = ["sk", "terminal-malicious-secret-1234567890"].join("-");
    const pack = buildSummaryPack();
    pack.entries[0].evaluation_pack.runs[0].execution.attempts[0].modelReportedId = secret;
    const outcome = deriveCalibrationOutcome({
      pack,
      topPackPath: `/tmp/${secret}/${TEST_RESOURCE_IDS.vectorStoreId}.json`,
      expectedResources: TEST_RESOURCE_IDS,
      cleanup: completeCleanup(),
      runtimeErrors: [new Error(`failed ${secret} ${TEST_RESOURCE_IDS.uploadedFileIds[0]}`)],
      sensitiveValues: [secret, TEST_RESOURCE_IDS.vectorStoreId, ...TEST_RESOURCE_IDS.uploadedFileIds],
    });
    const terminalJson = JSON.stringify(outcome.summary);
    expect(terminalJson).not.toContain(secret);
    expect(terminalJson).not.toContain(TEST_RESOURCE_IDS.vectorStoreId);
    expect(TEST_RESOURCE_IDS.uploadedFileIds.every((id) => !terminalJson.includes(id))).toBe(true);
    expect(terminalJson).toContain("[REDACTED]");
  });
});

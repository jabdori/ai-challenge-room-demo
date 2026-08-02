// @vitest-environment node

import { realpathSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir as systemTmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BenchmarkPersistenceIntegrityError,
  claimBenchmarkSlotExecutionIntent,
  createBenchmarkSlotArtifactPaths,
  loadBenchmarkSlotResumeState,
  persistBenchmarkSlotArtifact,
  type BenchmarkSlotCoordinates,
  type BenchmarkSlotExecutionCheckpoint,
  type BenchmarkSlotExecutionIntent,
  type BenchmarkSlotExecutionReceipt,
  type BenchmarkSlotExpectedIdentity,
} from "../pack/benchmarkPersistence";
import {
  benchmarkSlotIdentityHashes,
  type BenchmarkExecutionIdentity,
  type BenchmarkSlotIdentity,
} from "../benchmark/identity";
import { persistContentAddressedJson } from "../pack/persistence";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import { calculateUsageCost, DEFAULT_PRICING_SNAPSHOT } from "../runtime/pricing";

const EXECUTION_HASH = "e".repeat(64);
const SCHEDULE_ID = "3".repeat(64);
const tmpdir = () => realpathSync(systemTmpdir());

const slot = {
  slot_id: "H-001--A--r1",
  sequence: 1,
  repetition: 1 as const,
} satisfies BenchmarkSlotCoordinates;

const executionIdentity = {
  schema_version: "benchmark-execution-identity-v1",
  challenge_hash: "a".repeat(64),
  dataset_hash: "b".repeat(64),
  oracle_hash: "c".repeat(64),
  hidden_execution_data_hash: "d".repeat(64),
  locked_challenge_pack_hash: "e".repeat(64),
  locked_challenge_contract_hash: "f".repeat(64),
  locked_challenge_source_manifest_hash: "0".repeat(64),
  evaluator_policy_corpus_hash: "5".repeat(64),
  evaluator_contract_hash: "f".repeat(64),
  candidate_policy_corpus_hash: "6".repeat(64),
  evaluator_policy_manifest_hash: "7".repeat(64),
  policy_manifest_hash: "8".repeat(64),
  policy_resource_identity_hash: "9".repeat(64),
  policy_vector_store_id_hash: "0".repeat(64),
  orders_hash: "1".repeat(64),
  schedule_id: SCHEDULE_ID,
  output_schema_hash: "2".repeat(64),
  pricing_snapshot_hash: "3".repeat(64),
  runner_contract_hash: "4".repeat(64),
  evidence_contract_hash: "a".repeat(64),
  execution_hash: EXECUTION_HASH,
} satisfies BenchmarkExecutionIdentity;

const slotIdentityPayload = {
  schema_version: "benchmark-slot-identity-v1",
  execution_hash: EXECUTION_HASH,
  schedule_id: SCHEDULE_ID,
  slot_id: slot.slot_id,
  sequence: slot.sequence,
  case_id: "H-001",
  candidate_id: "A",
  repetition: slot.repetition,
  candidate_position: 1,
  case_hash: "b".repeat(64),
  oracle_hash: "c".repeat(64),
  authoritative_order_hash: "d".repeat(64),
  candidate_config_hash: "e".repeat(64),
  system_prompt_hash: "f".repeat(64),
  invocation_hash: "4".repeat(64),
  execution_envelope_hash: "0".repeat(64),
  invocation_input_hash: "1".repeat(64),
  candidate_input_hash: "2".repeat(64),
  input_access_hash: "3".repeat(64),
  output_schema_hash: executionIdentity.output_schema_hash,
  pricing_snapshot_hash: executionIdentity.pricing_snapshot_hash,
  policy_manifest_hash: executionIdentity.policy_manifest_hash,
  evaluator_policy_manifest_hash: executionIdentity.evaluator_policy_manifest_hash,
  evaluator_contract_hash: executionIdentity.evaluator_contract_hash,
  policy_resource_identity_hash: executionIdentity.policy_resource_identity_hash,
  policy_vector_store_id_hash: executionIdentity.policy_vector_store_id_hash,
} satisfies Omit<BenchmarkSlotIdentity, "slot_identity_hash">;

const slotIdentity = {
  ...slotIdentityPayload,
  slot_identity_hash: sha256CanonicalJson(slotIdentityPayload),
} satisfies BenchmarkSlotIdentity;
const SLOT_IDENTITY_HASH = slotIdentity.slot_identity_hash;

const identityHashes = benchmarkSlotIdentityHashes(executionIdentity, slotIdentity);

const expectedIdentity: BenchmarkSlotExpectedIdentity = {
  scheduleId: SCHEDULE_ID,
  slotIdentityHash: SLOT_IDENTITY_HASH,
  identityHashes,
};

interface IntentExecution {
  schema_version: "benchmark-slot-intent-v1";
  candidate_id: "A";
  run_number: 1;
  invocation_hash: string;
}

interface ReceiptExecution {
  schema_version: "benchmark-slot-receipt-v1";
  slot_result: Readonly<Record<string, unknown>>;
}

interface CheckpointExecution {
  schema_version: "benchmark-slot-checkpoint-v1";
  evaluation_state: Readonly<Record<string, unknown>>;
}

type IntentArtifact = BenchmarkSlotExecutionIntent<IntentExecution>;
type ReceiptArtifact = BenchmarkSlotExecutionReceipt<ReceiptExecution> & {
  readonly intent_payload_sha256: string;
};
type CheckpointArtifact = BenchmarkSlotExecutionCheckpoint<CheckpointExecution> & {
  readonly intent_payload_sha256: string;
  readonly receipt_payload_sha256: string;
};

function createGate(gateCode: "P0-HG-01" | "P0-HG-02" | "P0-HG-03" | "P0-HG-04") {
  return {
    gateCode,
    status: "PASS" as const,
    findings: [],
    riskCandidates: [],
  };
}

function createEvaluationState() {
  return {
    status: "EVALUATED" as const,
    gates: [
      createGate("P0-HG-01"),
      createGate("P0-HG-02"),
      createGate("P0-HG-03"),
      createGate("P0-HG-04"),
    ],
  };
}

function createSlotResult() {
  const output = {
    customer_reply: "The authorized order is in transit.",
    decision: {
      intent_codes: ["ORDER_STATUS"],
      action_code: "PROVIDE_ORDER_STATUS",
      escalation_required: false,
      escalation_reason_code: "NOT_REQUIRED",
      target_queue: "NONE",
    },
    citations: [{ source_id: "POL-SHIP", section_id: "SHIP-1" }],
  };
  const usage = {
    inputTokens: 100,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 20,
  };
  const providerCall = {
    callNumber: 1,
    responseId: "resp-benchmark-1",
    status: "completed" as const,
    modelRequestedId: "gpt-5.6-terra",
    modelReportedId: "gpt-5.6-terra-2026-07-17",
    serviceTierRequested: "default",
    serviceTierReported: "default",
    latencyMs: 12,
    usage,
  };
  const executionEvidence = {
    providerCalls: [providerCall],
    retrievalCalls: [],
    toolCalls: [],
  };
  return {
    slot: {
      slot_id: slot.slot_id,
      sequence: slot.sequence,
      case_id: "H-001",
      candidate_id: "A" as const,
      repetition: slot.repetition,
      candidate_position: 1 as const,
    },
    executionStatus: "COMPLETE" as const,
    requestDisposition: "SENT_RESPONSE_RECORDED" as const,
    costState: "COMPLETE" as const,
    usageCost: calculateUsageCost(usage, DEFAULT_PRICING_SNAPSHOT),
    totalLatencyMs: 12,
    run: {
      runNumber: 1,
      status: "COMPLETE" as const,
      attempts: [{
        attemptNumber: 1,
        status: "COMPLETE" as const,
        startedAt: "2026-07-17T00:00:00.000Z",
        latencyMs: 12,
        responseId: providerCall.responseId,
        modelReportedId: providerCall.modelReportedId,
        serviceTierReported: providerCall.serviceTierReported,
        usage,
        executionEvidence,
      }],
      output,
      totalLatencyMs: 12,
    },
    accessEvidence: {
      schemaVersion: "runner-input-access-evidence-v1",
      slotId: slot.slot_id,
      repetition: slot.repetition,
      caseId: "H-001",
      candidateId: "A" as const,
      evaluationCaseHash: identityHashes.slot_case_hash,
      candidateInputHash: identityHashes.candidate_input_hash,
      orderAccess: {
        channel: "RUNNER_SNAPSHOT",
        status: "SUCCESS",
        resultCode: "OK",
        snapshotHash: "6".repeat(64),
      },
      policyAccess: {
        mode: "INLINE_CORPUS",
        corpusHash: identityHashes.evaluator_policy_corpus_hash,
        manifestHash: identityHashes.evaluator_policy_manifest_hash,
      },
    },
    completedExecutionEvidence: {
      slotId: slot.slot_id,
      repetition: slot.repetition,
      caseId: "H-001",
      candidateId: "A" as const,
      finalStatus: "COMPLETE" as const,
      finalOutputHash: sha256CanonicalJson(output),
      providerCalls: [providerCall],
      retrievalCalls: [],
      toolCalls: [],
    },
  };
}

function createIntent(
  overrides: Partial<IntentArtifact> = {},
): IntentArtifact {
  return {
    artifact_kind: "BENCHMARK_SLOT_EXECUTION_INTENT",
    execution_hash: EXECUTION_HASH,
    schedule_id: SCHEDULE_ID,
    slot_identity_hash: SLOT_IDENTITY_HASH,
    slot_id: slot.slot_id,
    sequence: slot.sequence,
    repetition: slot.repetition,
    identity_hashes: identityHashes,
    execution: {
      schema_version: "benchmark-slot-intent-v1",
      candidate_id: "A",
      run_number: 1,
      invocation_hash: identityHashes.invocation_hash,
    },
    ...overrides,
  };
}

function createReceipt(
  overrides: Partial<ReceiptArtifact> = {},
  intent: IntentArtifact = createIntent(),
): ReceiptArtifact {
  return {
    artifact_kind: "BENCHMARK_SLOT_EXECUTION_RECEIPT",
    execution_hash: EXECUTION_HASH,
    schedule_id: SCHEDULE_ID,
    slot_identity_hash: SLOT_IDENTITY_HASH,
    slot_id: slot.slot_id,
    sequence: slot.sequence,
    repetition: slot.repetition,
    identity_hashes: identityHashes,
    intent_payload_sha256: sha256CanonicalJson(intent),
    execution: {
      schema_version: "benchmark-slot-receipt-v1",
      slot_result: createSlotResult(),
    },
    ...overrides,
  };
}

function createCheckpoint(
  overrides: Partial<CheckpointArtifact> = {},
  intent: IntentArtifact = createIntent(),
  receipt: ReceiptArtifact = createReceipt({}, intent),
): CheckpointArtifact {
  return {
    artifact_kind: "BENCHMARK_SLOT_EXECUTION_CHECKPOINT",
    execution_hash: EXECUTION_HASH,
    schedule_id: SCHEDULE_ID,
    slot_identity_hash: SLOT_IDENTITY_HASH,
    slot_id: slot.slot_id,
    sequence: slot.sequence,
    repetition: slot.repetition,
    identity_hashes: identityHashes,
    intent_payload_sha256: sha256CanonicalJson(intent),
    receipt_payload_sha256: sha256CanonicalJson(receipt),
    execution: {
      schema_version: "benchmark-slot-checkpoint-v1",
      evaluation_state: createEvaluationState(),
    },
    ...overrides,
  };
}

function canonicalArtifactBytes(payload: unknown): string {
  return `${canonicalJsonStringify({
    payload_sha256: sha256CanonicalJson(payload),
    payload,
  })}\n`;
}

async function writeRawArtifact(
  filePath: string,
  payload: unknown,
  wrapperOverrides: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(join(filePath, ".."), { recursive: true });
  const wrapper = {
    payload_sha256: sha256CanonicalJson(payload),
    payload,
    ...wrapperOverrides,
  };
  await writeFile(filePath, `${canonicalJsonStringify(wrapper)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

async function expectIntegrityFailure(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error("무결성 오류가 발생해야 합니다.");
  } catch (error) {
    expect(error).toBeInstanceOf(BenchmarkPersistenceIntegrityError);
    expect(error).toMatchObject({
      evaluationStatus: "EVALUATION_INCOMPLETE",
    });
  }
}

describe("공통 content-addressed JSON 저장 원시 함수", () => {
  it("기대 canonical SHA-256으로 기존 보정 형식과 같은 pretty JSON 경로를 만든다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "content-addressed-json-"));
    const artifact = { artifact_kind: "TEST_ARTIFACT", nested: { value: 1 } };
    const artifactId = sha256CanonicalJson(artifact);

    const filePath = await persistContentAddressedJson({
      artifact,
      outputDirectory,
      filenamePrefix: "test-artifact--record",
      expectedArtifactId: artifactId,
    });

    expect(filePath).toBe(join(
      outputDirectory,
      `test-artifact--record-${artifactId}.json`,
    ));
    expect(await readFile(filePath, "utf8")).toBe(`${JSON.stringify(artifact, null, 2)}\n`);
    expect((await lstat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("호출자가 제시한 artifact ID가 canonical 내용과 다르면 기록 전에 거부한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "content-addressed-json-"));

    await expect(persistContentAddressedJson({
      artifact: { value: 1 },
      outputDirectory,
      filenamePrefix: "test-artifact--record",
      expectedArtifactId: "0".repeat(64),
    })).rejects.toThrow(/artifact ID|SHA-256|canonical/i);

    expect(await readdir(outputDirectory)).toEqual([]);
  });
});

describe("Benchmark 슬롯 산출물 경로와 write-once 저장", () => {
  it("실행 해시 아래에 3자리 순번과 슬롯 ID가 포함된 안정 경로를 만든다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-persistence-"));

    const paths = createBenchmarkSlotArtifactPaths({
      outputDirectory,
      executionHash: EXECUTION_HASH,
      slot,
    });

    expect(paths.executionDirectory).toBe(join(outputDirectory, EXECUTION_HASH));
    expect(paths.slotsDirectory).toBe(join(outputDirectory, EXECUTION_HASH, "slots"));
    expect(paths.intentPath).toBe(join(
      outputDirectory,
      EXECUTION_HASH,
      "slots",
      "001--H-001--A--r1--intent.json",
    ));
    expect(paths.receiptPath).toBe(paths.intentPath.replace("--intent.json", "--receipt.json"));
    expect(paths.checkpointPath).toBe(
      paths.intentPath.replace("--intent.json", "--checkpoint.json"),
    );
  });

  it("payload SHA-256 래퍼를 canonical bytes와 0600 모드로 원자 저장한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-persistence-"));
    const intent = createIntent();

    const filePath = await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });

    const paths = createBenchmarkSlotArtifactPaths({
      outputDirectory,
      executionHash: EXECUTION_HASH,
      slot,
    });
    expect(filePath).toBe(paths.intentPath);
    expect(await readFile(filePath, "utf8")).toBe(canonicalArtifactBytes(intent));
    const fileStat = await lstat(filePath);
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.isSymbolicLink()).toBe(false);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect((await readdir(paths.slotsDirectory)).filter((name) => name.includes(".tmp-")))
      .toEqual([]);
  });

  it("slots 디렉터리 symlink를 따라 외부 위치에 intent를 기록하지 않는다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-persistence-symlink-parent-"));
    const externalDirectory = await mkdtemp(join(tmpdir(), "benchmark-persistence-external-"));
    const paths = createBenchmarkSlotArtifactPaths({
      outputDirectory,
      executionHash: EXECUTION_HASH,
      slot,
    });
    await mkdir(paths.executionDirectory, { recursive: true });
    await symlink(externalDirectory, paths.slotsDirectory);

    await expectIntegrityFailure(persistBenchmarkSlotArtifact({
      outputDirectory,
      artifact: createIntent(),
    }));
    expect(await readdir(externalDirectory)).toEqual([]);
  });

  it("동일 내용을 다시 또는 동시에 저장해도 기존 inode 수정시각과 단일 파일을 보존한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-persistence-"));
    const intent = createIntent();
    const firstPath = await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });
    const fixedTime = new Date("2020-01-02T03:04:05.000Z");
    await utimes(firstPath, fixedTime, fixedTime);
    const before = await lstat(firstPath, { bigint: true });

    const paths = await Promise.all(Array.from({ length: 8 }, () => (
      persistBenchmarkSlotArtifact({ outputDirectory, artifact: structuredClone(intent) })
    )));

    expect(new Set(paths)).toEqual(new Set([firstPath]));
    expect((await lstat(firstPath, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
    expect(await readFile(firstPath, "utf8")).toBe(canonicalArtifactBytes(intent));
    expect((await readdir(join(outputDirectory, EXECUTION_HASH, "slots"))))
      .toEqual(["001--H-001--A--r1--intent.json"]);
  });

  it("동시 intent claim 중 생성 승자 정확히 하나만 원격 호출 권한을 얻는다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-intent-claim-"));
    const intent = createIntent();
    const remoteInvoke = vi.fn(async () => "provider-response");

    const claims = await Promise.all(Array.from({ length: 8 }, async () => {
      const claim = await claimBenchmarkSlotExecutionIntent({
        outputDirectory,
        artifact: structuredClone(intent),
      });
      if (claim.allowRemoteCall) {
        await remoteInvoke();
      }
      return claim;
    }));

    expect(claims.filter((claim) => claim.created)).toHaveLength(1);
    expect(claims.filter((claim) => claim.allowRemoteCall)).toHaveLength(1);
    expect(new Set(claims.map((claim) => claim.path))).toHaveLength(1);
    expect(claims.every((claim) => claim.allowRemoteCall === claim.created)).toBe(true);
    expect(remoteInvoke).toHaveBeenCalledOnce();
  });

  it("같은 안정 경로의 다른 bytes 충돌을 거부하고 임시 파일을 남기지 않는다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-persistence-"));
    const original = createIntent();
    const filePath = await persistBenchmarkSlotArtifact({ outputDirectory, artifact: original });
    const before = await readFile(filePath);

    await expectIntegrityFailure(persistBenchmarkSlotArtifact({
      outputDirectory,
      artifact: createIntent({
        execution: { request: "different request" } as unknown as IntentExecution,
      }),
    }));

    expect(await readFile(filePath)).toEqual(before);
    expect((await readdir(join(outputDirectory, EXECUTION_HASH, "slots")))
      .filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it.each([
    ["symbolic link", "symlink"],
    ["directory", "directory"],
    ["wrong mode", "wrong-mode"],
  ] as const)("기존 목적지가 %s이면 같은 내용이어도 거부한다", async (_label, setup) => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-persistence-"));
    const intent = createIntent();
    const paths = createBenchmarkSlotArtifactPaths({
      outputDirectory,
      executionHash: EXECUTION_HASH,
      slot,
    });
    await mkdir(paths.slotsDirectory, { recursive: true });

    if (setup === "symlink") {
      const target = join(outputDirectory, "target.json");
      await writeFile(target, canonicalArtifactBytes(intent), { mode: 0o600 });
      await symlink(target, paths.intentPath);
    } else if (setup === "directory") {
      await mkdir(paths.intentPath);
    } else {
      await writeFile(paths.intentPath, canonicalArtifactBytes(intent), { mode: 0o600 });
      await chmod(paths.intentPath, 0o644);
    }

    await expectIntegrityFailure(persistBenchmarkSlotArtifact({
      outputDirectory,
      artifact: intent,
    }));
    expect((await readdir(paths.slotsDirectory)).filter((name) => name.includes(".tmp-")))
      .toEqual([]);
  });

  it("artifact kind마다 잠긴 execution exact shape가 아닌 generic payload를 거부한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-shape-"));

    await expectIntegrityFailure(persistBenchmarkSlotArtifact({
      outputDirectory,
      artifact: createIntent({
        execution: { request: "generic request" } as unknown as IntentExecution,
      }),
    }));

    await expectIntegrityFailure(persistBenchmarkSlotArtifact({
      outputDirectory,
      artifact: createReceipt({
        execution: { response: "generic response" } as unknown as ReceiptExecution,
      }),
    }));

    await expectIntegrityFailure(persistBenchmarkSlotArtifact({
      outputDirectory,
      artifact: createCheckpoint({
        execution: { gates: ["P0-HG-01"] } as unknown as CheckpointExecution,
      }),
    }));

    expect(await readdir(outputDirectory).catch(() => [])).toEqual([]);
  });

  it("receipt의 중첩 비용 자료도 잠긴 런타임 스키마가 아니면 거부한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-nested-shape-"));
    const intent = createIntent();
    const malformedReceipt = createReceipt({
      execution: {
        schema_version: "benchmark-slot-receipt-v1",
        slot_result: {
          ...createSlotResult(),
          usageCost: "canonical JSON이지만 UsageCost가 아닌 값",
        },
      },
    }, intent);
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });

    await expectIntegrityFailure(persistBenchmarkSlotArtifact({
      outputDirectory,
      artifact: malformedReceipt,
    }));
  });

  it("canonical key 정렬로 비용 항목 순서가 바뀌어도 동일한 고정 순서 합계를 검증한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-cost-order-"));
    const intent = createIntent();
    const usage = {
      inputTokens: 2,
      cachedInputTokens: 1,
      cacheWriteTokens: 0,
      outputTokens: 165,
    };
    const slotResult = structuredClone(createSlotResult());
    slotResult.usageCost = calculateUsageCost(usage, DEFAULT_PRICING_SNAPSHOT);
    slotResult.run.attempts[0].usage = usage;
    slotResult.run.attempts[0].executionEvidence.providerCalls[0].usage = usage;
    slotResult.completedExecutionEvidence.providerCalls[0].usage = usage;
    const receipt = createReceipt({
      execution: {
        schema_version: "benchmark-slot-receipt-v1",
        slot_result: slotResult,
      },
    }, intent);

    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });
    const receiptPath = await persistBenchmarkSlotArtifact({
      outputDirectory,
      artifact: receipt,
    });

    expect(receiptPath).toMatch(/--receipt\.json$/);
  });

  it("provider 호출 전 로컬 BUDGET_EXCEEDED는 NOT_SENT·COMPLETE·null 비용 receipt로 저장한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-local-budget-"));
    const intent = createIntent();
    const result = createSlotResult() as unknown as Record<string, unknown>;
    const run = result.run as Record<string, unknown>;
    const attempt = (run.attempts as Array<Record<string, unknown>>)[0];
    result.executionStatus = "BUDGET_EXCEEDED";
    result.requestDisposition = "NOT_SENT";
    result.costState = "COMPLETE";
    result.usageCost = null;
    run.status = "BUDGET_EXCEEDED";
    attempt.status = "BUDGET_EXCEEDED";
    delete attempt.responseId;
    delete attempt.modelReportedId;
    delete attempt.serviceTierReported;
    delete attempt.usage;
    delete attempt.executionEvidence;
    delete run.output;
    result.completedExecutionEvidence = null;
    const receipt = createReceipt({
      execution: {
        schema_version: "benchmark-slot-receipt-v1",
        slot_result: result,
      },
    }, intent);

    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });
    await expect(persistBenchmarkSlotArtifact({
      outputDirectory,
      artifact: receipt,
    })).resolves.toEqual(expect.stringContaining("--receipt.json"));
  });

  it("response metadata만 남긴 zero-call BUDGET은 known-free receipt를 위조할 수 없다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-forged-local-budget-"));
    const intent = createIntent();
    const result = createSlotResult() as unknown as Record<string, unknown>;
    const run = result.run as Record<string, unknown>;
    const attempt = (run.attempts as Array<Record<string, unknown>>)[0];
    result.executionStatus = "BUDGET_EXCEEDED";
    result.requestDisposition = "NOT_SENT";
    result.costState = "COMPLETE";
    result.usageCost = null;
    run.status = "BUDGET_EXCEEDED";
    attempt.status = "BUDGET_EXCEEDED";
    // responseId는 지우되 model/service metadata와 비용 원장 제거를 조합한 위조 입력입니다.
    delete attempt.responseId;
    delete attempt.usage;
    delete attempt.executionEvidence;
    delete run.output;
    result.completedExecutionEvidence = null;
    const receipt = createReceipt({
      execution: {
        schema_version: "benchmark-slot-receipt-v1",
        slot_result: result,
      },
    }, intent);

    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });
    await expectIntegrityFailure(persistBenchmarkSlotArtifact({
      outputDirectory,
      artifact: receipt,
    }));
  });

  it("provider usage가 있는 BUDGET_EXCEEDED는 SENT_RESPONSE_RECORDED 유료 경계를 유지한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-paid-budget-"));
    const intent = createIntent();
    const result = createSlotResult() as unknown as Record<string, unknown>;
    const run = result.run as Record<string, unknown>;
    const attempt = (run.attempts as Array<Record<string, unknown>>)[0];
    result.executionStatus = "BUDGET_EXCEEDED";
    run.status = "BUDGET_EXCEEDED";
    attempt.status = "BUDGET_EXCEEDED";
    delete run.output;
    result.completedExecutionEvidence = null;
    const receipt = createReceipt({
      execution: {
        schema_version: "benchmark-slot-receipt-v1",
        slot_result: result,
      },
    }, intent);

    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });
    await expect(persistBenchmarkSlotArtifact({
      outputDirectory,
      artifact: receipt,
    })).resolves.toEqual(expect.stringContaining("--receipt.json"));
  });

  it("이전 전송 결과가 불명인 BUDGET_EXCEEDED는 COST_INCOMPLETE이고 임의 zero-call null 우회는 거부한다", async () => {
    const unknownDirectory = await mkdtemp(join(tmpdir(), "benchmark-unknown-budget-"));
    const unknownIntent = createIntent();
    const unknownResult = createSlotResult() as unknown as Record<string, unknown>;
    const unknownRun = unknownResult.run as Record<string, unknown>;
    const attempts = unknownRun.attempts as Array<Record<string, unknown>>;
    const terminalAttempt = attempts[0];
    terminalAttempt.attemptNumber = 2;
    terminalAttempt.status = "BUDGET_EXCEEDED";
    delete terminalAttempt.responseId;
    delete terminalAttempt.modelReportedId;
    delete terminalAttempt.serviceTierReported;
    delete terminalAttempt.usage;
    delete terminalAttempt.executionEvidence;
    attempts.unshift({
      attemptNumber: 1,
      status: "TRANSPORT_ERROR",
      startedAt: "2026-07-17T00:00:00.000Z",
      latencyMs: 3,
      error: "Synthetic request outcome unknown.",
    });
    unknownRun.status = "BUDGET_EXCEEDED";
    unknownRun.totalLatencyMs = (unknownRun.totalLatencyMs as number) + 3;
    delete unknownRun.output;
    unknownResult.executionStatus = "BUDGET_EXCEEDED";
    unknownResult.requestDisposition = "SENT_OUTCOME_UNKNOWN";
    unknownResult.costState = "COST_INCOMPLETE";
    unknownResult.usageCost = null;
    unknownResult.totalLatencyMs = unknownRun.totalLatencyMs;
    unknownResult.completedExecutionEvidence = null;
    const unknownReceipt = createReceipt({
      execution: {
        schema_version: "benchmark-slot-receipt-v1",
        slot_result: unknownResult,
      },
    }, unknownIntent);
    await persistBenchmarkSlotArtifact({ outputDirectory: unknownDirectory, artifact: unknownIntent });
    await expect(persistBenchmarkSlotArtifact({
      outputDirectory: unknownDirectory,
      artifact: unknownReceipt,
    })).resolves.toEqual(expect.stringContaining("--receipt.json"));

    const bypassDirectory = await mkdtemp(join(tmpdir(), "benchmark-null-cost-bypass-"));
    const bypassIntent = createIntent();
    const bypassResult = createSlotResult() as unknown as Record<string, unknown>;
    const bypassRun = bypassResult.run as Record<string, unknown>;
    const bypassAttempt = (bypassRun.attempts as Array<Record<string, unknown>>)[0];
    bypassResult.executionStatus = "INVALID";
    bypassResult.requestDisposition = "NOT_SENT";
    bypassResult.costState = "COMPLETE";
    bypassResult.usageCost = null;
    bypassRun.status = "INVALID";
    bypassAttempt.status = "INVALID_OUTPUT";
    delete bypassAttempt.responseId;
    delete bypassAttempt.modelReportedId;
    delete bypassAttempt.serviceTierReported;
    delete bypassAttempt.usage;
    delete bypassAttempt.executionEvidence;
    delete bypassRun.output;
    bypassResult.completedExecutionEvidence = null;
    const bypassReceipt = createReceipt({
      execution: {
        schema_version: "benchmark-slot-receipt-v1",
        slot_result: bypassResult,
      },
    }, bypassIntent);
    await persistBenchmarkSlotArtifact({ outputDirectory: bypassDirectory, artifact: bypassIntent });
    await expectIntegrityFailure(persistBenchmarkSlotArtifact({
      outputDirectory: bypassDirectory,
      artifact: bypassReceipt,
    }));
  });

  it.each([
    {
      label: "run 추가 키",
      mutate: (result: ReturnType<typeof createSlotResult>) => ({
        ...result,
        run: { ...result.run, unexpected: true },
      }),
    },
    {
      label: "attempt 추가 키",
      mutate: (result: ReturnType<typeof createSlotResult>) => ({
        ...result,
        run: {
          ...result.run,
          attempts: [{ ...result.run.attempts[0], unexpected: true }],
        },
      }),
    },
    {
      label: "access evidence 추가 키",
      mutate: (result: ReturnType<typeof createSlotResult>) => ({
        ...result,
        accessEvidence: { ...result.accessEvidence, unexpected: true },
      }),
    },
    {
      label: "completed evidence 추가 키",
      mutate: (result: ReturnType<typeof createSlotResult>) => ({
        ...result,
        completedExecutionEvidence: {
          ...result.completedExecutionEvidence,
          unexpected: true,
        },
      }),
    },
  ])("receipt의 $label를 exact runtime schema 위반으로 거부한다", async ({ mutate }) => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-nested-shape-"));
    const intent = createIntent();
    const receipt = createReceipt({
      execution: {
        schema_version: "benchmark-slot-receipt-v1",
        slot_result: mutate(createSlotResult()),
      },
    }, intent);
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });

    await expectIntegrityFailure(persistBenchmarkSlotArtifact({ outputDirectory, artifact: receipt }));
  });

  it("receipt는 선행 intent와 그 payload SHA-256이 모두 일치해야만 저장된다", async () => {
    const withoutIntentDirectory = await mkdtemp(join(tmpdir(), "benchmark-chain-"));
    await expectIntegrityFailure(persistBenchmarkSlotArtifact({
      outputDirectory: withoutIntentDirectory,
      artifact: createReceipt(),
    }));

    const mismatchDirectory = await mkdtemp(join(tmpdir(), "benchmark-chain-"));
    const intent = createIntent();
    await persistBenchmarkSlotArtifact({ outputDirectory: mismatchDirectory, artifact: intent });
    await expectIntegrityFailure(persistBenchmarkSlotArtifact({
      outputDirectory: mismatchDirectory,
      artifact: createReceipt({ intent_payload_sha256: "9".repeat(64) }, intent),
    }));
  });

  it("checkpoint는 선행 intent·receipt와 두 causal hash를 요구한다", async () => {
    const missingReceiptDirectory = await mkdtemp(join(tmpdir(), "benchmark-chain-"));
    const orphanIntent = createIntent();
    const orphanReceipt = createReceipt({}, orphanIntent);
    await persistBenchmarkSlotArtifact({
      outputDirectory: missingReceiptDirectory,
      artifact: orphanIntent,
    });
    await expectIntegrityFailure(persistBenchmarkSlotArtifact({
      outputDirectory: missingReceiptDirectory,
      artifact: createCheckpoint({}, orphanIntent, orphanReceipt),
    }));

    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-chain-"));
    const intent = createIntent();
    const receipt = createReceipt({}, intent);
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: receipt });

    await expectIntegrityFailure(persistBenchmarkSlotArtifact({
      outputDirectory,
      artifact: createCheckpoint({ receipt_payload_sha256: "8".repeat(64) }, intent, receipt),
    }));

  });

  it("checkpoint gate의 finding·risk도 exact runtime schema로 검증한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-gate-shape-"));
    const intent = createIntent();
    const receipt = createReceipt({}, intent);
    const gates = createEvaluationState().gates;
    const malformedCheckpoint = createCheckpoint({
      execution: {
        schema_version: "benchmark-slot-checkpoint-v1",
        evaluation_state: {
          status: "EVALUATED",
          gates: [{
            ...gates[0],
            status: "CONFIRMED_FAIL",
            findings: [{
              code: "POLICY_FAILURE",
              message: "confirmed",
              evidenceIds: ["case:H-001", "output:H-001"],
              unexpected: true,
            }],
          }, ...gates.slice(1)],
        },
      },
    }, intent, receipt);
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: receipt });

    await expectIntegrityFailure(persistBenchmarkSlotArtifact({
      outputDirectory,
      artifact: malformedCheckpoint,
    }));
  });

  it("EVALUATED checkpoint는 COMPLETE receipt와 실행·접근 증거를 요구한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-chain-"));
    const intent = createIntent();
    const receipt = createReceipt({
      execution: {
        schema_version: "benchmark-slot-receipt-v1",
        slot_result: {
          ...createSlotResult(),
          executionStatus: "FAILED",
          requestDisposition: "SENT_OUTCOME_UNKNOWN",
          costState: "COST_INCOMPLETE",
          usageCost: null,
          totalLatencyMs: 0,
          run: null,
          accessEvidence: null,
          completedExecutionEvidence: null,
        },
      },
    }, intent);
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: receipt });

    await expectIntegrityFailure(persistBenchmarkSlotArtifact({
      outputDirectory,
      artifact: createCheckpoint({}, intent, receipt),
    }));
  });

  it("일치하는 intent→receipt→checkpoint만 순서대로 저장한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-chain-"));
    const intent = createIntent();
    const receipt = createReceipt({}, intent);
    const checkpoint = createCheckpoint({}, intent, receipt);

    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: receipt });
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: checkpoint });

    const paths = createBenchmarkSlotArtifactPaths({
      outputDirectory,
      executionHash: EXECUTION_HASH,
      slot,
    });
    expect(await readdir(paths.slotsDirectory)).toEqual([
      "001--H-001--A--r1--checkpoint.json",
      "001--H-001--A--r1--intent.json",
      "001--H-001--A--r1--receipt.json",
    ]);
  });
});

describe("Benchmark 슬롯 재개 상태 검증", () => {
  function load(outputDirectory: string, overrides: {
    executionHash?: string;
    slot?: BenchmarkSlotCoordinates;
    expectedIdentity?: BenchmarkSlotExpectedIdentity;
  } = {}) {
    return loadBenchmarkSlotResumeState({
      outputDirectory,
      executionHash: overrides.executionHash ?? EXECUTION_HASH,
      slot: overrides.slot ?? slot,
      expectedIdentity: overrides.expectedIdentity ?? expectedIdentity,
    });
  }

  it("산출물이 없으면 NONE을 반환한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-"));

    await expect(load(outputDirectory)).resolves.toEqual({ state: "NONE" });
  });

  it("intent만 있으면 원격 호출을 재시도하지 않는 AMBIGUOUS_IN_FLIGHT 상태다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-"));
    const intent = createIntent();
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });

    await expect(load(outputDirectory)).resolves.toEqual({
      state: "INTENT_ONLY",
      resolution: "AMBIGUOUS_IN_FLIGHT",
      allowRemoteCall: false,
      intent,
    });
  });

  it("intent와 receipt가 있으면 원격 호출 없이 gate를 재계산한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-"));
    const intent = createIntent();
    const receipt = createReceipt();
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: receipt });

    await expect(load(outputDirectory)).resolves.toEqual({
      state: "RECEIPT_ONLY",
      resolution: "RECOMPUTE_GATES",
      allowRemoteCall: false,
      intent,
      receipt,
    });
  });

  it("intent, receipt, checkpoint가 모두 있으면 검증된 checkpoint를 재사용한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-"));
    const intent = createIntent();
    const receipt = createReceipt();
    const checkpoint = createCheckpoint();
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: receipt });
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: checkpoint });

    await expect(load(outputDirectory)).resolves.toEqual({
      state: "CHECKPOINT",
      resolution: "REUSE",
      intent,
      receipt,
      checkpoint,
    });
  });

  it("intent 없는 receipt 또는 receipt 없는 checkpoint의 gap을 거부한다", async () => {
    const receiptOnlyDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-gap-"));
    const receiptOnlyPaths = createBenchmarkSlotArtifactPaths({
      outputDirectory: receiptOnlyDirectory,
      executionHash: EXECUTION_HASH,
      slot,
    });
    await writeRawArtifact(receiptOnlyPaths.receiptPath, createReceipt());
    await expectIntegrityFailure(load(receiptOnlyDirectory));

    const checkpointGapDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-gap-"));
    const gapIntent = createIntent();
    await persistBenchmarkSlotArtifact({ outputDirectory: checkpointGapDirectory, artifact: gapIntent });
    const gapReceipt = createReceipt({}, gapIntent);
    const checkpointGapPaths = createBenchmarkSlotArtifactPaths({
      outputDirectory: checkpointGapDirectory,
      executionHash: EXECUTION_HASH,
      slot,
    });
    await writeRawArtifact(
      checkpointGapPaths.checkpointPath,
      createCheckpoint({}, gapIntent, gapReceipt),
    );
    await expectIntegrityFailure(load(checkpointGapDirectory));
  });

  it("정상 wrapper라도 다른 반복에서 복사한 산출물은 replay로 거부한다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-replay-"));
    const sourcePath = await persistBenchmarkSlotArtifact({
      outputDirectory,
      artifact: createIntent(),
    });
    const replaySlot = {
      slot_id: "H-001--A--r2",
      sequence: 2,
      repetition: 2 as const,
    };
    const replayPaths = createBenchmarkSlotArtifactPaths({
      outputDirectory,
      executionHash: EXECUTION_HASH,
      slot: replaySlot,
    });
    await copyFile(sourcePath, replayPaths.intentPath);
    await chmod(replayPaths.intentPath, 0o600);

    await expectIntegrityFailure(load(outputDirectory, { slot: replaySlot }));
  });

  it("한 byte 변조, wrapper 추가 키, identity mismatch를 모두 불완전 평가 무결성 오류로 거부한다", async () => {
    const tamperDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-tamper-"));
    const tamperedPath = await persistBenchmarkSlotArtifact({
      outputDirectory: tamperDirectory,
      artifact: createIntent(),
    });
    const originalBytes = await readFile(tamperedPath, "utf8");
    await writeFile(tamperedPath, `${originalBytes.trimEnd()} \n`, { mode: 0o600 });
    await expectIntegrityFailure(load(tamperDirectory));

    const extraKeyDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-extra-"));
    const extraPaths = createBenchmarkSlotArtifactPaths({
      outputDirectory: extraKeyDirectory,
      executionHash: EXECUTION_HASH,
      slot,
    });
    await writeRawArtifact(extraPaths.intentPath, createIntent(), { unexpected: true });
    await expectIntegrityFailure(load(extraKeyDirectory));

    const mismatchDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-identity-"));
    await persistBenchmarkSlotArtifact({
      outputDirectory: mismatchDirectory,
      artifact: createIntent(),
    });
    await expectIntegrityFailure(load(mismatchDirectory, {
      expectedIdentity: {
        ...expectedIdentity,
        identityHashes: {
          ...identityHashes,
          prompt_hash: "9".repeat(64),
        },
      },
    }));
  });

  it("평가자 계약 hash가 다른 재개 요청은 기존 checkpoint를 재사용하지 않는다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-evaluator-contract-"));
    const intent = createIntent();
    const receipt = createReceipt({}, intent);
    const checkpoint = createCheckpoint({}, intent, receipt);
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: receipt });
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: checkpoint });

    await expectIntegrityFailure(load(outputDirectory, {
      expectedIdentity: {
        ...expectedIdentity,
        identityHashes: {
          ...identityHashes,
          evaluator_contract_hash: "0".repeat(64),
        },
      },
    }));
  });

  it("wrapper와 payload hash가 유효해도 causal hash가 끊긴 receipt를 로드할 수 없다", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-chain-"));
    const intent = createIntent();
    await persistBenchmarkSlotArtifact({ outputDirectory, artifact: intent });
    const paths = createBenchmarkSlotArtifactPaths({
      outputDirectory,
      executionHash: EXECUTION_HASH,
      slot,
    });
    await writeRawArtifact(paths.receiptPath, createReceipt({
      intent_payload_sha256: "7".repeat(64),
    }, intent));

    await expectIntegrityFailure(load(outputDirectory));
  });

  it("파일 kind/slot ID가 경로 역할과 다르거나 temp가 남아 있으면 거부한다", async () => {
    const wrongKindDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-kind-"));
    const wrongKindPaths = createBenchmarkSlotArtifactPaths({
      outputDirectory: wrongKindDirectory,
      executionHash: EXECUTION_HASH,
      slot,
    });
    await writeRawArtifact(wrongKindPaths.intentPath, createReceipt());
    await expectIntegrityFailure(load(wrongKindDirectory));

    const wrongSlotDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-slot-"));
    const wrongSlotPaths = createBenchmarkSlotArtifactPaths({
      outputDirectory: wrongSlotDirectory,
      executionHash: EXECUTION_HASH,
      slot,
    });
    await writeRawArtifact(wrongSlotPaths.intentPath, createIntent({
      slot_id: "H-999--A--r1",
    }));
    await expectIntegrityFailure(load(wrongSlotDirectory));

    const leakedTempDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-temp-"));
    const leakedTempPaths = createBenchmarkSlotArtifactPaths({
      outputDirectory: leakedTempDirectory,
      executionHash: EXECUTION_HASH,
      slot,
    });
    await mkdir(leakedTempPaths.slotsDirectory, { recursive: true });
    await writeFile(join(
      leakedTempPaths.slotsDirectory,
      ".001--H-001--A--r1--intent.json.tmp-leaked",
    ), "partial", { mode: 0o600 });
    await expectIntegrityFailure(load(leakedTempDirectory));
  });

  it("읽을 때 symlink, 비정규 파일, 0600 이외 모드를 거부한다", async () => {
    const symlinkDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-symlink-"));
    const symlinkPaths = createBenchmarkSlotArtifactPaths({
      outputDirectory: symlinkDirectory,
      executionHash: EXECUTION_HASH,
      slot,
    });
    await mkdir(symlinkPaths.slotsDirectory, { recursive: true });
    const target = join(symlinkDirectory, "target.json");
    await writeFile(target, canonicalArtifactBytes(createIntent()), { mode: 0o600 });
    await symlink(target, symlinkPaths.intentPath);
    await expectIntegrityFailure(load(symlinkDirectory));

    const directoryEntryRoot = await mkdtemp(join(tmpdir(), "benchmark-resume-directory-"));
    const directoryEntryPaths = createBenchmarkSlotArtifactPaths({
      outputDirectory: directoryEntryRoot,
      executionHash: EXECUTION_HASH,
      slot,
    });
    await mkdir(directoryEntryPaths.intentPath, { recursive: true });
    await expectIntegrityFailure(load(directoryEntryRoot));

    const wrongModeDirectory = await mkdtemp(join(tmpdir(), "benchmark-resume-mode-"));
    const wrongModePath = await persistBenchmarkSlotArtifact({
      outputDirectory: wrongModeDirectory,
      artifact: createIntent(),
    });
    await chmod(wrongModePath, 0o644);
    await expectIntegrityFailure(load(wrongModeDirectory));
  });
});

// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  loadRecordedSyntheticDemoProjectionFixture,
} from "../../../eval/demo/recordedSyntheticDemoProjectionFixture";
import type {
  LiveSyntheticDemoProjection,
} from "../../../eval/demo/liveSyntheticDemoProjection";
import type { BlindJudgeResult } from "../../../eval/judge/contracts";
import type {
  DemoDecisionMemoOutput,
} from "../../../eval/demo/demoOpenAiArtifacts";
import {
  parseHackathonDemoState,
} from "../../../shared/hackathonDemo";
import {
  createLiveDemoWorkflowService,
  LiveDemoWorkflowError,
  type LiveComparisonRunner,
} from "../liveDemoWorkflowService";
import {
  InMemoryDemoStateRepository,
} from "../inMemoryDemoStateRepository";
import type {
  DemoArtifactReference,
  DemoArtifactStore,
} from "../demoContracts";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../../../eval/runtime/canonicalJson";
import type {
  LiveComparisonResult,
} from "../../../eval/demo/executeLiveComparison";
import {
  applyDemoJudgeResult,
  applyDemoMemoFailure,
  applyDemoMemoSuccess,
  applyDemoReview,
  applyDemoSelection,
  buildDemoBlindJudgeInput,
  buildDemoDecisionMemoInput,
  createInitialDemoState,
  eligibleDemoCandidateIds,
  replayDemoRepresentativeDefect,
  validateDemoReview,
  validateDemoSelection,
} from "../../hackathonDemoController";

function liveProjection(
  sourceHash = "a".repeat(64),
): LiveSyntheticDemoProjection {
  const recorded = loadRecordedSyntheticDemoProjectionFixture();
  const candidates = recorded.candidates.map((candidate) => {
    const sourceRun = candidate.runs[0]!;
    const run = {
      ...structuredClone(sourceRun),
      source: "LIVE_SYNTHETIC_DEMO" as const,
      source_hash: sourceHash,
      run_number: 1 as const,
    };
    return {
      candidate_id: candidate.candidate_id,
      candidate_version: candidate.candidate_version,
      total_runtime_cost_usd: sourceRun.cost_usd,
      summed_latency_ms: sourceRun.summed_latency_ms,
      provider_call_count: sourceRun.provider_call_count,
      retrieval_call_count: sourceRun.retrieval_call_count,
      tool_call_count: sourceRun.tool_call_count,
      runs: [run],
    };
  }) as unknown as LiveSyntheticDemoProjection["candidates"];
  return {
    schema_version: "live-synthetic-demo-projection-v1",
    artifact_kind: "LIVE_SYNTHETIC_DEMO_PROJECTION",
    synthetic: true,
    source: "LIVE_SYNTHETIC_DEMO",
    evaluation_status: "EVALUATION_INCOMPLETE",
    pack_id: "live-demo-pack-test-fixture",
    source_hash: sourceHash,
    challenge_version: recorded.challenge_version,
    baseline_version: null,
    stability: "SINGLE_RUN_NOT_MEASURED",
    case: structuredClone(recorded.case),
    coverage: {
      cases: 1,
      candidates: 3,
      runs_per_candidate: 1,
      completed_runs: candidates.filter(
        (candidate) => candidate.runs[0].execution_status === "COMPLETE",
      ).length,
      expected_runs: 3,
    },
    total_runtime_cost_usd: candidates.reduce(
      (total, candidate) => total + (candidate.total_runtime_cost_usd ?? 0),
      0,
    ),
    cost_evidence_status: "COMPLETE",
    summed_latency_ms: candidates.reduce(
      (total, candidate) => total + candidate.summed_latency_ms,
      0,
    ),
    candidates,
    evidence: candidates.map((candidate) => candidate.runs[0]) as unknown as
      LiveSyntheticDemoProjection["evidence"],
  };
}

function judgeResult(): BlindJudgeResult {
  return {
    case_id: "C-001",
    candidates: (["X", "Y", "Z"] as const).map((blindLabel) => ({
      blind_label: blindLabel,
      criteria: [{
        criterion_id: "CITATION_RELEVANCE_RISK",
        status: blindLabel === "Z" ? "RISK" : "NO_RISK",
        severity: blindLabel === "Z" ? "LOW" : null,
        failure_type: blindLabel === "Z" ? "CITATION_NOT_RELEVANT" : null,
        concerning_field: blindLabel === "Z" ? "CITATION_SOURCE_ID" : null,
        concerning_excerpt: blindLabel === "Z" ? "fixture excerpt" : "",
        evidence_ids: blindLabel === "Z" ? ["Z:RUN:1"] : [],
        rationale: "테스트용 보조 위험 신호입니다.",
      }],
    })),
  } as BlindJudgeResult;
}

const JUDGE_METADATA = Object.freeze({
  model_reported_id: "fixture-model",
  latency_ms: 17,
});

class MemoryArtifactStore implements DemoArtifactStore {
  readonly values = new Map<string, Uint8Array>();

  async putContentAddressed(input: {
    readonly namespace: DemoArtifactReference["namespace"];
    readonly canonicalBytes: Uint8Array;
    readonly sha256: string;
  }): Promise<DemoArtifactReference> {
    const objectKey = `${input.namespace}/sha256/${input.sha256}.json`;
    this.values.set(objectKey, new Uint8Array(input.canonicalBytes));
    return {
      namespace: input.namespace,
      objectKey,
      sha256: input.sha256,
      byteLength: input.canonicalBytes.byteLength,
    };
  }

  async getVerified(reference: DemoArtifactReference): Promise<Uint8Array> {
    const value = this.values.get(reference.objectKey);
    if (!value || value.byteLength !== reference.byteLength) {
      throw new Error("ARTIFACT_NOT_FOUND");
    }
    return new Uint8Array(value);
  }
}

async function putArtifact<
  Namespace extends DemoArtifactReference["namespace"],
>(
  store: DemoArtifactStore,
  namespace: Namespace,
  value: unknown,
): Promise<DemoArtifactReference & { readonly namespace: Namespace }> {
  const canonical = canonicalJsonStringify(value);
  const reference = await store.putContentAddressed({
    namespace,
    canonicalBytes: new TextEncoder().encode(canonical),
    sha256: sha256CanonicalJson(value),
  });
  return {
    ...reference,
    namespace,
  };
}

function successfulRunner(): LiveComparisonRunner {
  return async ({ artifactStore, onProgress }) => {
    await onProgress({ kind: "ENVIRONMENT_PREPARING" });
    await onProgress({ kind: "ENVIRONMENT_PREPARED" });
    await onProgress({
      kind: "CANDIDATE_ATTEMPT_STARTED",
      candidateId: "A",
      runNumber: 1,
      attemptNumber: 1,
    });
    await onProgress({
      kind: "CANDIDATE_A_RESPONSE_STARTED",
      candidateId: "A",
    });
    await onProgress({
      kind: "CANDIDATE_A_RESPONSE_FINISHED",
      candidateId: "A",
      outcome: "COMPLETE",
    });
    await onProgress({
      kind: "CANDIDATE_ATTEMPT_FINISHED",
      candidateId: "A",
      runNumber: 1,
      attemptNumber: 1,
      status: "COMPLETE",
    });
    await onProgress({
      kind: "CANDIDATE_ATTEMPT_STARTED",
      candidateId: "B",
      runNumber: 1,
      attemptNumber: 1,
    });
    await onProgress({
      kind: "CANDIDATE_B_RETRIEVAL_STARTED",
      candidateId: "B",
    });
    await onProgress({
      kind: "CANDIDATE_B_RETRIEVAL_FINISHED",
      candidateId: "B",
      outcome: "COMPLETE",
    });
    await onProgress({
      kind: "CANDIDATE_ATTEMPT_FINISHED",
      candidateId: "B",
      runNumber: 1,
      attemptNumber: 1,
      status: "INVALID_OUTPUT",
    });
    await onProgress({
      kind: "CANDIDATE_RETRY_STARTED",
      candidateId: "B",
      runNumber: 1,
      attemptNumber: 2,
    });
    await onProgress({
      kind: "CANDIDATE_ATTEMPT_STARTED",
      candidateId: "B",
      runNumber: 1,
      attemptNumber: 2,
    });
    await onProgress({
      kind: "CANDIDATE_B_RESPONSE_STARTED",
      candidateId: "B",
    });
    await onProgress({
      kind: "CANDIDATE_B_RESPONSE_FINISHED",
      candidateId: "B",
      outcome: "COMPLETE",
    });
    await onProgress({
      kind: "CANDIDATE_ATTEMPT_FINISHED",
      candidateId: "B",
      runNumber: 1,
      attemptNumber: 2,
      status: "COMPLETE",
    });
    await onProgress({
      kind: "CANDIDATE_RETRY_FINISHED",
      candidateId: "B",
      runNumber: 1,
      attemptNumber: 2,
      status: "COMPLETE",
    });
    await onProgress({
      kind: "CANDIDATE_ATTEMPT_STARTED",
      candidateId: "C",
      runNumber: 1,
      attemptNumber: 1,
    });
    await onProgress({
      kind: "CANDIDATE_C_MODEL_TURN_STARTED",
      candidateId: "C",
      modelTurn: 1,
    });
    for (
      const [callNumber, toolName] of [
        [1, "get_order"],
        [2, "search_policy"],
      ] as const
    ) {
      await onProgress({
        kind: "CANDIDATE_C_TOOL_STARTED",
        candidateId: "C",
        modelTurn: 1,
        callNumber,
        toolName,
      });
      await onProgress({
        kind: "CANDIDATE_C_TOOL_FINISHED",
        candidateId: "C",
        modelTurn: 1,
        callNumber,
        toolName,
        outcome: "COMPLETE",
      });
    }
    await onProgress({
      kind: "CANDIDATE_C_MODEL_TURN_FINISHED",
      candidateId: "C",
      modelTurn: 1,
      outcome: "COMPLETE",
    });
    await onProgress({
      kind: "CANDIDATE_C_RESPONSE_FINISHED",
      candidateId: "C",
      modelTurn: 1,
      outcome: "COMPLETE",
    });
    await onProgress({
      kind: "CANDIDATE_ATTEMPT_FINISHED",
      candidateId: "C",
      runNumber: 1,
      attemptNumber: 1,
      status: "COMPLETE",
    });
    await onProgress({ kind: "HARD_GATES_STARTED" });
    await onProgress({ kind: "HARD_GATES_FINISHED" });
    await onProgress({ kind: "RESULTS_PERSISTING" });
    const pack = {
      schema_version: "fake-live-pack-v1",
      artifact_kind: "LIVE_DEMO_EVALUATION_PACK",
      synthetic: true,
    };
    const packReference = await putArtifact(
      artifactStore as DemoArtifactStore,
      "live-evaluation-packs",
      pack,
    );
    const projection = liveProjection(packReference.sha256);
    const cleanupReceipt = {
      schema_version: "fake-cleanup-v1",
      deletion_semantics:
        "API_ACKNOWLEDGEMENT_ONLY_NO_PHYSICAL_DELETION_CLAIM",
    };
    const cleanupReceiptReference = await putArtifact(
      artifactStore as DemoArtifactStore,
      "cleanup-receipts",
      cleanupReceipt,
    );
    await onProgress({ kind: "RESULTS_PERSISTED" });
    await onProgress({ kind: "REMOTE_CLEANUP_STARTED" });
    await onProgress({ kind: "REMOTE_CLEANUP_FINISHED" });
    return {
      status: "RESULTS_READY",
      judgeEligible: true,
      errorCode: null,
      pack: pack as never,
      projection,
      packReference,
      privateFailureEvidence: null,
      privateFailureReference: null,
      cleanupReceipt: cleanupReceipt as never,
      cleanupReceiptReference,
      actualCostUsd: 0.012345,
    } satisfies LiveComparisonResult;
  };
}

function platformFailureRunner(): LiveComparisonRunner {
  return async ({ artifactStore, onProgress }) => {
    await onProgress({ kind: "ENVIRONMENT_PREPARING" });
    await onProgress({ kind: "REMOTE_CLEANUP_STARTED" });
    const cleanupReceipt = {
      schema_version: "fake-cleanup-v1",
      deletion_semantics:
        "API_ACKNOWLEDGEMENT_ONLY_NO_PHYSICAL_DELETION_CLAIM",
    };
    const cleanupReceiptReference = await putArtifact(
      artifactStore as DemoArtifactStore,
      "cleanup-receipts",
      cleanupReceipt,
    );
    const privateFailureEvidence = {
      schema_version: "live-comparison-private-failure-v1",
      artifact_kind: "LIVE_COMPARISON_PRIVATE_FAILURE",
      created_at: "2026-07-19T00:00:00.000Z",
      source_pack_sha256: null,
      error_name: "FakePlatformError",
      error_message: "private provider details",
      captured_evidence: null,
    } as const;
    const privateFailureReference = await putArtifact(
      artifactStore as DemoArtifactStore,
      "errors",
      privateFailureEvidence,
    );
    return {
      status: "FAILED_PLATFORM",
      judgeEligible: false,
      errorCode: "FAILED_PLATFORM",
      pack: null,
      projection: null,
      packReference: null,
      privateFailureEvidence,
      privateFailureReference,
      cleanupReceipt: cleanupReceipt as never,
      cleanupReceiptReference,
      actualCostUsd: 0.001,
    } satisfies LiveComparisonResult;
  };
}

function unexpectedThrowRunner(): LiveComparisonRunner {
  return async ({ onProgress }) => {
    await onProgress({ kind: "ENVIRONMENT_PREPARING" });
    await onProgress({ kind: "REMOTE_CLEANUP_STARTED" });
    throw new Error("fixture runner contract violation");
  };
}

function candidateFailureRunner(): LiveComparisonRunner {
  const runSuccessfulComparison = successfulRunner();
  return async (input) => {
    const result = await runSuccessfulComparison(input);
    const projection = structuredClone(result.projection!);
    const candidates = projection.candidates.map((candidate, index) => (
      index === 0
        ? {
            ...candidate,
            runs: [{
              ...candidate.runs[0],
              deterministic_gate: {
                evaluation_status: "EVALUATED",
                gate_code: "P0-HG-02",
                status: "CONFIRMED_FAIL",
                findings: [],
              },
            }],
          }
        : candidate
    )) as unknown as LiveSyntheticDemoProjection["candidates"];
    const failedProjection = {
      ...projection,
      candidates,
      evidence: candidates.map((candidate) => candidate.runs[0]),
    } as unknown as LiveSyntheticDemoProjection;
    return {
      ...result,
      projection: failedProjection,
    };
  };
}

async function workflowFixture(
  runner: LiveComparisonRunner = successfulRunner(),
) {
  const repository = new InMemoryDemoStateRepository();
  const artifactStore = new MemoryArtifactStore();
  let nowMs = Date.UTC(2026, 6, 19, 12);
  let id = 0;
  await repository.createSession({
    sessionTokenDigest: "session-owner",
    createdAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60 * 60_000,
    revokedAtMs: null,
    successfulLiveRuns: 0,
    operationalRetryCount: 0,
    currentExecutionId: null,
  });
  await repository.createSession({
    sessionTokenDigest: "session-other",
    createdAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60 * 60_000,
    revokedAtMs: null,
    successfulLiveRuns: 0,
    operationalRetryCount: 0,
    currentExecutionId: null,
  });
  const riskAdapter = {
    invoke: vi.fn(async () => ({
      output: judgeResult(),
      metadata: JUDGE_METADATA,
    })),
  };
  const memoAdapter = {
    invoke: vi.fn(async (input: ReturnType<typeof buildDemoDecisionMemoInput>) => ({
      output: {
        case_id: input.case_id,
        selected_candidate_id: input.human_decision.selected_candidate_id,
        decision_summary: "다음 통제 PoC의 후보를 기록합니다.",
        human_selection_rationale: input.human_decision.rationale,
        human_review_evidence: input.human_review,
        candidate_evidence: input.candidate_evidence,
        known_limitations: ["단일 합성 사례만 평가했습니다."],
        next_poc_scope: "더 넓은 비공개 평가를 수행합니다.",
        external_action_statement: input.required_external_action_statement,
      },
      metadata: {
        model_reported_id: "fixture-model",
        latency_ms: 19,
      },
    })),
  };
  const options = {
    repository,
    artifactStore,
    runLiveComparison: runner,
    riskAdapter,
    memoAdapter,
    recordedProjection: loadRecordedSyntheticDemoProjectionFixture(),
    now: () => {
      nowMs += 1;
      return nowMs;
    },
    executionId: () => `cmp_${String(++id).padStart(24, "0")}`,
    token: () => `token-${String(id).padStart(24, "0")}`,
  } as const;
  return {
    repository,
    artifactStore,
    riskAdapter,
    memoAdapter,
    options,
    service: createLiveDemoWorkflowService(options),
  };
}

async function advanceLiveWorkflowToSelection(
  fixture: Awaited<ReturnType<typeof workflowFixture>>,
) {
  const execution = await fixture.service.createLiveComparison({
    sessionTokenDigest: "session-owner",
    idempotencyKey: `advance-${fixture.options.executionId()}`,
  });
  await fixture.service.runComparison({
    sessionTokenDigest: "session-owner",
    executionId: execution.execution_id,
  });
  const judged = await fixture.service.runJudge({
    sessionTokenDigest: "session-owner",
    executionId: execution.execution_id,
  });
  const reviewed = await fixture.service.confirmReviews({
    sessionTokenDigest: "session-owner",
    executionId: execution.execution_id,
    review: {
      reviewer: "Workflow reviewer",
      rationale: "모든 잠긴 블라인드 증거를 확인했습니다.",
      decisions: judged.blind_review.candidates.map((candidate) => ({
        blind_label: candidate.blind_label,
        decision: "PASS" as const,
      })),
    },
  });
  const selected = await fixture.service.selectCandidate({
    sessionTokenDigest: "session-owner",
    executionId: execution.execution_id,
    selection: {
      selected_candidate_id: reviewed.eligible_candidate_ids[0]!,
      rationale: "결정적 gate와 사람 검수를 통과한 후보입니다.",
    },
  });
  return { execution, judged, reviewed, selected };
}

describe("Sites 영속 workflow service 계약", () => {
  it("memory controller와 D1 service가 공유할 순수 전이를 공개한다", () => {
    expect([
      createInitialDemoState,
      buildDemoBlindJudgeInput,
      applyDemoJudgeResult,
      validateDemoReview,
      applyDemoReview,
      eligibleDemoCandidateIds,
      validateDemoSelection,
      applyDemoSelection,
      buildDemoDecisionMemoInput,
      applyDemoMemoSuccess,
      applyDemoMemoFailure,
      replayDemoRepresentativeDefect,
    ].every((value) => typeof value === "function")).toBe(true);
  });

  it("시간·난수·Task 7 orchestrator를 주입하는 service factory를 공개한다", () => {
    expect(createLiveDemoWorkflowService).toBeTypeOf("function");
  });

  it("recorded 2회와 live 1회 projection을 같은 초기 전이로 만든다", () => {
    const recorded = createInitialDemoState(
      loadRecordedSyntheticDemoProjectionFixture(),
    );
    const live = createInitialDemoState(liveProjection());

    expect(recorded).toMatchObject({
      source: "RECORDED_FALLBACK",
      status: "JUDGE_REQUIRED",
      canary: { artifact_kind: "PARTIAL_CALIBRATION_PACK" },
    });
    expect(recorded.canary.candidates.every(
      (candidate) => candidate.runs.length === 2,
    )).toBe(true);
    expect(live).toMatchObject({
      source: "LIVE_SYNTHETIC_DEMO",
      status: "JUDGE_REQUIRED",
      canary: { artifact_kind: "LIVE_DEMO_EVALUATION_PACK" },
    });
    expect(live.canary.candidates.every(
      (candidate) => candidate.runs.length === 1,
    )).toBe(true);
  });

  it("Judge 입력은 source 실행 수를 유지하고 후보 identity를 숨긴다", () => {
    const input = buildDemoBlindJudgeInput(liveProjection());

    expect(input.blind_candidates.map((candidate) => ({
      blind_label: candidate.blind_label,
      runs: candidate.runs.length,
    }))).toEqual([
      { blind_label: "X", runs: 1 },
      { blind_label: "Y", runs: 1 },
      { blind_label: "Z", runs: 1 },
    ]);
    expect(JSON.stringify(input)).not.toMatch(
      /candidate_[iI][dD]|Candidate [ABC]|Single LLM|RAG|agent/,
    );
  });

  it("결정적 gate를 바꾸지 않고 Judge 결과와 사람 검수를 순수 적용한다", () => {
    const initial = createInitialDemoState(liveProjection());
    const originalGates = initial.canary.candidates.map(
      (candidate) => candidate.hard_gate,
    );
    const judged = applyDemoJudgeResult(initial, judgeResult(), JUDGE_METADATA);
    const review = validateDemoReview({
      reviewer: "테스트 검수자",
      rationale: "세 블라인드 결과를 실제 증거와 대조했습니다.",
      decisions: [
        { blind_label: "X", decision: "PASS" },
        { blind_label: "Y", decision: "PASS" },
        { blind_label: "Z", decision: "CONFIRMED_FAIL" },
      ],
    });
    const reviewed = applyDemoReview(judged, review);

    expect(judged.status).toBe("REVIEW_REQUIRED");
    expect(judged.canary.candidates.map(
      (candidate) => candidate.hard_gate,
    )).toEqual(originalGates);
    expect(reviewed.status).toBe("DECISION_REQUIRED");
    expect(JSON.stringify(reviewed)).not.toContain("revealed_mapping");
    expect(reviewed.eligible_candidate_ids).toEqual(
      eligibleDemoCandidateIds(reviewed),
    );
    expect(reviewed.eligible_candidate_ids).not.toContain("C");

    const leaked = structuredClone(reviewed) as unknown as {
      human_review: Record<string, unknown>;
    };
    leaked.human_review.revealed_mapping = [{
      blind_label: "X",
      candidate_id: "B",
    }];
    expect(() => parseHackathonDemoState(leaked)).toThrow(/공개|mapping/i);
  });

  it("검수 뒤 eligible 후보만 별도 선택하고 그 선택으로 Memo 입력을 만든다", () => {
    const judged = applyDemoJudgeResult(
      createInitialDemoState(liveProjection()),
      judgeResult(),
      JUDGE_METADATA,
    );
    const reviewed = applyDemoReview(judged, validateDemoReview({
      reviewer: "테스트 검수자",
      rationale: "모든 블라인드 결과를 확인했습니다.",
      decisions: [
        { blind_label: "X", decision: "PASS" },
        { blind_label: "Y", decision: "PASS" },
        { blind_label: "Z", decision: "PASS" },
      ],
    }));
    const candidateId = eligibleDemoCandidateIds(reviewed)[0]!;
    const selection = validateDemoSelection(reviewed, {
      selected_candidate_id: candidateId,
      rationale: "이 합성 사례에 충분한 가장 단순한 후보입니다.",
    });
    const selected = applyDemoSelection(reviewed, selection);
    const memoInput = buildDemoDecisionMemoInput(selected);

    expect(selected.status).toBe("SELECTION_RECORDED");
    expect(selected.memo).toBeNull();
    expect(memoInput.human_decision).toEqual({
      selected_candidate_id: candidateId,
      rationale: selection.rationale,
    });
    expect(memoInput.candidate_evidence).toHaveLength(3);
  });

  it("사람 검수를 통과한 후보가 없으면 플랫폼 실패가 아닌 정상 terminal로 끝난다", () => {
    const judged = applyDemoJudgeResult(
      createInitialDemoState(liveProjection()),
      judgeResult(),
      JUDGE_METADATA,
    );
    const reviewed = applyDemoReview(judged, validateDemoReview({
      reviewer: "테스트 검수자",
      rationale: "모든 블라인드 출력을 확인했지만 승인할 후보가 없습니다.",
      decisions: [
        { blind_label: "X", decision: "CONFIRMED_FAIL" },
        { blind_label: "Y", decision: "CONFIRMED_FAIL" },
        { blind_label: "Z", decision: "CONFIRMED_FAIL" },
      ],
    }));

    expect(reviewed).toMatchObject({
      status: "NO_APPROVED_CANDIDATE",
      eligible_candidate_ids: [],
      selection: null,
      memo: null,
    });
    expect(reviewed.status).not.toBe("FAILED");
    expect(() => validateDemoSelection(reviewed, {
      selected_candidate_id: "A",
      rationale: "선택할 수 없어야 합니다.",
    })).toThrow(/선택할 수 없습니다/);
    expect(() => buildDemoDecisionMemoInput(reviewed)).toThrow(/선택/);
  });

  it("Memo 실패는 선택을 유지하고 BASELINE_NOT_CREATED로 재조정한다", () => {
    const judged = applyDemoJudgeResult(
      createInitialDemoState(liveProjection()),
      judgeResult(),
      JUDGE_METADATA,
    );
    const reviewed = applyDemoReview(judged, validateDemoReview({
      reviewer: "테스트 검수자",
      rationale: "모든 블라인드 결과를 확인했습니다.",
      decisions: [
        { blind_label: "X", decision: "PASS" },
        { blind_label: "Y", decision: "PASS" },
        { blind_label: "Z", decision: "PASS" },
      ],
    }));
    const selected = applyDemoSelection(reviewed, validateDemoSelection(
      reviewed,
      {
        selected_candidate_id: eligibleDemoCandidateIds(reviewed)[0]!,
        rationale: "테스트 선택 근거입니다.",
      },
    ));

    const failed = applyDemoMemoFailure(selected);

    expect(failed).toMatchObject({
      status: "MEMO_FAILED",
      selection: selected.selection,
      memo: {
        status: "FAILED",
        error_code: "BASELINE_NOT_CREATED",
      },
    });
  });

  it("Memo 성공 뒤에만 대표 결함을 같은 gate로 재생해 BLOCK한다", () => {
    const judged = applyDemoJudgeResult(
      createInitialDemoState(liveProjection()),
      judgeResult(),
      JUDGE_METADATA,
    );
    const reviewed = applyDemoReview(judged, validateDemoReview({
      reviewer: "테스트 검수자",
      rationale: "모든 블라인드 결과를 확인했습니다.",
      decisions: [
        { blind_label: "X", decision: "PASS" },
        { blind_label: "Y", decision: "PASS" },
        { blind_label: "Z", decision: "PASS" },
      ],
    }));
    const selected = applyDemoSelection(reviewed, validateDemoSelection(
      reviewed,
      {
        selected_candidate_id: eligibleDemoCandidateIds(reviewed)[0]!,
        rationale: "테스트 선택 근거입니다.",
      },
    ));
    expect(() => replayDemoRepresentativeDefect(selected)).toThrow(/Memo/);

    const memoOutput = {
      case_id: selected.canary.case_id,
      selected_candidate_id: selected.selection?.candidate_id ?? null,
      decision_summary: "통제된 다음 PoC에 선택 후보를 사용합니다.",
      human_selection_rationale: selected.selection?.rationale ?? "",
      human_review_evidence: buildDemoDecisionMemoInput(selected).human_review,
      candidate_evidence: buildDemoDecisionMemoInput(selected).candidate_evidence,
      known_limitations: ["단일 합성 사례만 평가했습니다."],
      next_poc_scope: "더 넓은 비공개 평가를 수행합니다.",
      external_action_statement:
        "No purchase, contract, deployment, or rollback was executed.",
    } satisfies DemoDecisionMemoOutput;
    const ready = applyDemoMemoSuccess(selected, memoOutput, {
      model_reported_id: "fixture-model",
      latency_ms: 21,
    });
    const blocked = replayDemoRepresentativeDefect(ready);

    expect(blocked).toMatchObject({
      status: "BLOCK",
      selection: ready.selection,
      regression: {
        status: "BLOCK",
        recorded_decision_remains_unchanged: true,
      },
    });
  });
});

describe("Sites 영속 workflow service 행동", () => {
  it("live create부터 BLOCK까지 영속화하고 새 service instance가 같은 snapshot을 복원한다", async () => {
    const fixture = await workflowFixture();
    const execution = await fixture.service.createLiveComparison({
      sessionTokenDigest: "session-owner",
      idempotencyKey: "live-lifecycle-001",
    });
    expect(execution).toMatchObject({
      source: "LIVE",
      status: "READY",
    });

    await expect(fixture.service.runComparison({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).resolves.toMatchObject({
      status: "RESULTS_READY",
      cleanup_status: "ACKNOWLEDGED",
      artifacts: {
        evaluation_pack_persisted: true,
        public_projection_persisted: true,
        cleanup_receipt_persisted: true,
      },
    });
    const references: string[] = [];
    const captureReference = async () => {
      const stored = await fixture.repository.readOwnedExecution(
        execution.execution_id,
        "session-owner",
      );
      const sha256 = stored?.publicProjectionReference?.sha256;
      expect(sha256).toMatch(/^[a-f0-9]{64}$/);
      references.push(sha256!);
      return stored!;
    };
    const afterRun = await captureReference();
    expect(afterRun.evaluationPackReference?.namespace)
      .toBe("live-evaluation-packs");
    expect(afterRun.cleanupReceiptReference?.namespace)
      .toBe("cleanup-receipts");
    expect(afterRun.publicProjectionReference?.namespace)
      .toBe("candidate-evidence");

    const judged = await fixture.service.runJudge({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    });
    expect(judged.status).toBe("REVIEW_REQUIRED");
    await captureReference();

    const reviewed = await fixture.service.confirmReviews({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
      review: {
        reviewer: "Judge owner",
        rationale: "잠긴 증거와 세 블라인드 응답을 모두 확인했습니다.",
        decisions: judged.blind_review.candidates.map((candidate) => ({
          blind_label: candidate.blind_label,
          decision: "PASS" as const,
        })),
      },
    });
    expect(reviewed.status).toBe("DECISION_REQUIRED");
    expect(JSON.stringify(reviewed)).not.toContain("revealed_mapping");
    const storedReviews = await fixture.repository.readHumanReviews(
      execution.execution_id,
    );
    expect(storedReviews.map((review) => review.reviewDurationMs))
      .toEqual([0, 0, 0]);
    expect(storedReviews.map((review) => review.editDurationMs))
      .toEqual([0, 0, 0]);
    expect(storedReviews.reduce(
      (total, review) => total + review.editDurationMs,
      0,
    )).toBe(0);
    expect(reviewed.human_review).toMatchObject({
      review_time: "NOT_MEASURED",
      edit_time: "NOT_MEASURED",
    });
    await captureReference();

    const selected = await fixture.service.selectCandidate({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
      selection: {
        selected_candidate_id: reviewed.eligible_candidate_ids[0]!,
        rationale: "결정적 gate를 통과한 가장 단순한 후보입니다.",
      },
    });
    expect(selected.status).toBe("SELECTION_RECORDED");
    await captureReference();

    const memoReady = await fixture.service.createDecisionMemo({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    });
    expect(memoReady).toMatchObject({
      status: "MEMO_READY",
      memo: {
        status: "COMPLETE",
        error_code: null,
      },
    });
    await captureReference();
    const memoRecord = await fixture.repository.readMemoState(
      execution.execution_id,
    );
    expect(memoRecord).toMatchObject({
      status: "READY",
      sourcePackHash: afterRun.sourceHash,
    });
    expect(memoRecord?.reviewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(memoRecord?.selectionHash).toMatch(/^[a-f0-9]{64}$/);

    const blocked = await fixture.service.replayRegression({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    });
    expect(blocked).toMatchObject({
      status: "BLOCK",
      regression: {
        status: "BLOCK",
        recorded_decision_remains_unchanged: true,
        external_action_statement:
          "No external deployment or rollback was executed.",
      },
    });
    await captureReference();
    expect(new Set(references)).toHaveLength(6);

    const restarted = createLiveDemoWorkflowService(fixture.options);
    await expect(restarted.getResults({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).resolves.toEqual(blocked);
    expect(fixture.riskAdapter.invoke).toHaveBeenCalledTimes(1);
    expect(fixture.memoAdapter.invoke).toHaveBeenCalledTimes(1);
  });

  it("Task 7 진행 이벤트를 권위 execution view의 단계·후보·완료·재시도에 반영한다", async () => {
    const fixture = await workflowFixture();
    const updates: Array<{
      progressStep: string;
      currentCandidate: "A" | "B" | "C" | null;
      completedCandidateCount: number;
      retryCount: number;
    }> = [];
    const updateExecution = fixture.repository.updateExecution.bind(
      fixture.repository,
    );
    vi.spyOn(fixture.repository, "updateExecution").mockImplementation(
      async (record, guard) => {
        updates.push({
          progressStep: record.progressStep,
          currentCandidate: record.currentCandidate,
          completedCandidateCount: record.completedCandidateCount,
          retryCount: record.retryCount,
        });
        return updateExecution(record, guard);
      },
    );
    const execution = await fixture.service.createLiveComparison({
      sessionTokenDigest: "session-owner",
      idempotencyKey: "progress-mapping-001",
    });

    const completed = await fixture.service.runComparison({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    });

    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        progressStep: "ENVIRONMENT_PREPARING",
        currentCandidate: null,
      }),
      expect.objectContaining({
        progressStep: "CANDIDATE_A_RESPONSE_STARTED",
        currentCandidate: "A",
      }),
      expect.objectContaining({
        progressStep: "CANDIDATE_B_RETRIEVAL_STARTED",
        currentCandidate: "B",
      }),
      expect.objectContaining({
        progressStep: "CANDIDATE_B_RESPONSE_STARTED",
        currentCandidate: "B",
      }),
      expect.objectContaining({
        progressStep: "CANDIDATE_C_TOOL_STARTED:get_order",
        currentCandidate: "C",
      }),
      expect.objectContaining({
        progressStep: "CANDIDATE_C_TOOL_STARTED:search_policy",
        currentCandidate: "C",
      }),
      expect.objectContaining({
        progressStep: "CANDIDATE_C_RESPONSE_FINISHED",
        currentCandidate: "C",
      }),
      expect.objectContaining({
        progressStep: "HARD_GATES_STARTED",
        currentCandidate: null,
      }),
      expect.objectContaining({
        progressStep: "RESULTS_PERSISTING",
        currentCandidate: null,
      }),
      expect.objectContaining({
        progressStep: "REMOTE_CLEANUP_STARTED",
        currentCandidate: null,
      }),
    ]));
    expect(updates.find(
      (update) => update.progressStep === "CANDIDATE_RETRY_STARTED",
    )).toMatchObject({
      currentCandidate: "B",
      completedCandidateCount: 1,
      retryCount: 1,
    });
    expect(completed).toMatchObject({
      status: "RESULTS_READY",
      progress_step: "RESULTS_READY",
      completed_candidate_count: 3,
      retry_count: 1,
    });
  });

  it("Judge 외부 대기를 JUDGE_RUNNING으로 보이고 실패 후 명시 재시도를 허용한다", async () => {
    const fixture = await workflowFixture();
    const execution = await fixture.service.createLiveComparison({
      sessionTokenDigest: "session-owner",
      idempotencyKey: "judge-progress-retry-001",
    });
    await fixture.service.runComparison({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    });

    let rejectJudge!: (reason?: unknown) => void;
    fixture.riskAdapter.invoke.mockImplementationOnce(() => new Promise(
      (_resolve, reject) => {
        rejectJudge = reject;
      },
    ));
    const firstAttempt = fixture.service.runJudge({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    });
    await vi.waitFor(async () => {
      await expect(fixture.service.getExecution({
        sessionTokenDigest: "session-owner",
        executionId: execution.execution_id,
      })).resolves.toMatchObject({
        status: "RESULTS_READY",
        progress_step: "JUDGE_RUNNING",
      });
    });

    rejectJudge(new Error("fixture judge transport failure"));
    await expect(firstAttempt).rejects.toThrow(
      "fixture judge transport failure",
    );
    await expect(fixture.service.getExecution({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).resolves.toMatchObject({
      status: "RESULTS_READY",
      progress_step: "JUDGE_FAILED",
    });

    await expect(fixture.service.runJudge({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).resolves.toMatchObject({
      status: "REVIEW_REQUIRED",
      judge: { status: "COMPLETE" },
    });
    expect(fixture.riskAdapter.invoke).toHaveBeenCalledTimes(2);
  });

  it("Judge 실패는 한 번만 재시도하고 두 번째 실패 뒤 유료 호출을 영구 차단한다", async () => {
    const fixture = await workflowFixture();
    fixture.riskAdapter.invoke.mockRejectedValue(
      new Error("fixture persistent judge failure"),
    );
    const execution = await fixture.service.createLiveComparison({
      sessionTokenDigest: "session-owner",
      idempotencyKey: "judge-retry-cap-001",
    });
    await fixture.service.runComparison({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    });

    await expect(fixture.service.runJudge({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).rejects.toThrow("fixture persistent judge failure");
    await expect(fixture.service.getExecution({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).resolves.toMatchObject({
      status: "RESULTS_READY",
      progress_step: "JUDGE_FAILED",
    });

    await expect(fixture.service.runJudge({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).rejects.toThrow("fixture persistent judge failure");
    await expect(fixture.service.getExecution({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).resolves.toMatchObject({
      status: "RESULTS_READY",
      progress_step: "JUDGE_FAILED_FINAL",
    });

    await expect(fixture.service.runJudge({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(fixture.riskAdapter.invoke).toHaveBeenCalledTimes(2);
    await expect(fixture.repository.readAuxiliaryCallAttempt(
      execution.execution_id,
      "JUDGE",
      1,
    )).resolves.toMatchObject({ status: "FAILED" });
    await expect(fixture.repository.readAuxiliaryCallAttempt(
      execution.execution_id,
      "JUDGE",
      2,
    )).resolves.toMatchObject({ status: "FAILED" });
  });

  it("새 세션을 만들어도 전역 Judge·Memo 호출 시도 상한을 우회하지 못하고 adapter를 추가 호출하지 않는다", async () => {
    const fixture = await workflowFixture();
    const service = createLiveDemoWorkflowService({
      ...fixture.options,
      maxAuxiliaryCallsPerBucket: 1,
    });
    const first = await service.selectRecordedFallback({
      sessionTokenDigest: "session-owner",
    });
    await expect(service.runJudge({
      sessionTokenDigest: "session-owner",
      executionId: first.execution.execution_id,
    })).resolves.toMatchObject({ status: "REVIEW_REQUIRED" });

    const second = await service.selectRecordedFallback({
      sessionTokenDigest: "session-other",
    });
    await expect(service.runJudge({
      sessionTokenDigest: "session-other",
      executionId: second.execution.execution_id,
    })).rejects.toMatchObject({ code: "RUN_CAP_REACHED" });
    expect(fixture.riskAdapter.invoke).toHaveBeenCalledTimes(1);
  });

  it("Judge 완료 기록이 실패해도 이미 예약한 호출 시도는 소비되고 같은 실행을 재호출하지 않는다", async () => {
    const fixture = await workflowFixture();
    const service = createLiveDemoWorkflowService({
      ...fixture.options,
      maxAuxiliaryCallsPerBucket: 1,
    });
    const first = await service.selectRecordedFallback({
      sessionTokenDigest: "session-owner",
    });
    vi.spyOn(fixture.repository, "completeAuxiliaryCallAttempt")
      .mockResolvedValueOnce(false);

    await expect(service.runJudge({
      sessionTokenDigest: "session-owner",
      executionId: first.execution.execution_id,
    })).rejects.toMatchObject({ code: "STALE_EXECUTION" });
    await expect(service.runJudge({
      sessionTokenDigest: "session-owner",
      executionId: first.execution.execution_id,
    })).rejects.toMatchObject({ code: "INVALID_STATE" });

    const second = await service.selectRecordedFallback({
      sessionTokenDigest: "session-other",
    });
    await expect(service.runJudge({
      sessionTokenDigest: "session-other",
      executionId: second.execution.execution_id,
    })).rejects.toMatchObject({ code: "RUN_CAP_REACHED" });
    expect(fixture.riskAdapter.invoke).toHaveBeenCalledTimes(1);
  });

  it("Judge provider 성공 뒤 의미 검증이 실패하면 호출을 재실행하지 않고 안전한 terminal 상태로 조정한다", async () => {
    const fixture = await workflowFixture();
    const execution = await fixture.service.createLiveComparison({
      sessionTokenDigest: "session-owner",
      idempotencyKey: "judge-postprocess-failure-001",
    });
    await fixture.service.runComparison({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    });
    fixture.riskAdapter.invoke.mockResolvedValueOnce({
      output: {
        ...judgeResult(),
        case_id: "wrong-case-id",
      },
      metadata: JUDGE_METADATA,
    });

    await expect(fixture.service.runJudge({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(fixture.service.getExecution({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).resolves.toMatchObject({
      status: "RESULTS_READY",
      progress_step: "JUDGE_FAILED_FINAL",
    });
    await expect(fixture.repository.readAuxiliaryCallAttempt(
      execution.execution_id,
      "JUDGE",
      1,
    )).resolves.toMatchObject({ status: "COMPLETE" });
    await expect(fixture.service.runJudge({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(fixture.riskAdapter.invoke).toHaveBeenCalledTimes(1);
  });

  it("Memo 실패 snapshot과 선택을 유지하고 명시 재시도에서 성공한다", async () => {
    const fixture = await workflowFixture();
    fixture.memoAdapter.invoke.mockRejectedValueOnce(
      new Error("fixture memo failure"),
    );
    const { execution, selected } = await advanceLiveWorkflowToSelection(
      fixture,
    );
    const before = await fixture.repository.readOwnedExecution(
      execution.execution_id,
      "session-owner",
    );

    const failed = await fixture.service.createDecisionMemo({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    });
    expect(failed).toMatchObject({
      status: "MEMO_FAILED",
      selection: selected.selection,
      memo: {
        status: "FAILED",
        error_code: "BASELINE_NOT_CREATED",
      },
    });
    const afterFailure = await fixture.repository.readOwnedExecution(
      execution.execution_id,
      "session-owner",
    );
    expect(afterFailure).toMatchObject({
      status: "MEMO_FAILED",
    });
    expect(afterFailure?.publicProjectionReference?.sha256)
      .not.toBe(before?.publicProjectionReference?.sha256);
    expect(await fixture.repository.readSelection(execution.execution_id))
      .toMatchObject({
        candidateId: selected.selection?.candidate_id,
      });

    await expect(fixture.service.createDecisionMemo({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).resolves.toMatchObject({
      status: "MEMO_READY",
      selection: selected.selection,
      memo: { status: "COMPLETE" },
    });
    expect(fixture.memoAdapter.invoke).toHaveBeenCalledTimes(2);
  });

  it("Memo provider 성공 뒤 artifact 저장이 실패하면 첫 호출은 COMPLETE로 소비하고 허용된 한 번의 재시도만 수행한다", async () => {
    const fixture = await workflowFixture();
    const { execution } = await advanceLiveWorkflowToSelection(fixture);
    const originalPut = fixture.artifactStore.putContentAddressed.bind(
      fixture.artifactStore,
    );
    let rejectFirstMemoArtifact = true;
    vi.spyOn(fixture.artifactStore, "putContentAddressed")
      .mockImplementation(async (input) => {
        if (
          input.namespace === "decision-memos"
          && rejectFirstMemoArtifact
        ) {
          rejectFirstMemoArtifact = false;
          throw new Error("fixture decision memo artifact failure");
        }
        return originalPut(input);
      });

    await expect(fixture.service.createDecisionMemo({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).resolves.toMatchObject({ status: "MEMO_FAILED" });
    await expect(fixture.repository.readMemoState(execution.execution_id))
      .resolves.toMatchObject({
        status: "FAILED",
        reconciliationReason:
          "MEMO_FAILED_RETRY_AVAILABLE_SELECTION_PRESERVED_NO_BASELINE_CREATED",
      });
    await expect(fixture.repository.readAuxiliaryCallAttempt(
      execution.execution_id,
      "MEMO",
      1,
    )).resolves.toMatchObject({ status: "COMPLETE" });

    await expect(fixture.service.createDecisionMemo({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).resolves.toMatchObject({ status: "MEMO_READY" });
    await expect(fixture.repository.readAuxiliaryCallAttempt(
      execution.execution_id,
      "MEMO",
      2,
    )).resolves.toMatchObject({ status: "COMPLETE" });
    expect(fixture.memoAdapter.invoke).toHaveBeenCalledTimes(2);
  });

  it("Memo 실패는 한 번만 재시도하고 두 번째 실패 뒤 선택을 보존한 채 차단한다", async () => {
    const fixture = await workflowFixture();
    const { execution, selected } = await advanceLiveWorkflowToSelection(
      fixture,
    );
    fixture.memoAdapter.invoke.mockRejectedValue(
      new Error("fixture persistent memo failure"),
    );

    await expect(fixture.service.createDecisionMemo({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).resolves.toMatchObject({
      status: "MEMO_FAILED",
      selection: selected.selection,
    });
    await expect(fixture.service.createDecisionMemo({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).resolves.toMatchObject({
      status: "MEMO_FAILED",
      selection: selected.selection,
    });
    await expect(fixture.repository.readMemoState(execution.execution_id))
      .resolves.toMatchObject({
        status: "FAILED",
        reconciliationReason:
          "MEMO_FAILED_FINAL_SELECTION_PRESERVED_NO_BASELINE_CREATED",
      });

    await expect(fixture.service.createDecisionMemo({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(fixture.memoAdapter.invoke).toHaveBeenCalledTimes(2);
    await expect(fixture.repository.readAuxiliaryCallAttempt(
      execution.execution_id,
      "MEMO",
      1,
    )).resolves.toMatchObject({ status: "FAILED" });
    await expect(fixture.repository.readAuxiliaryCallAttempt(
      execution.execution_id,
      "MEMO",
      2,
    )).resolves.toMatchObject({ status: "FAILED" });
  });

  it("전 후보를 사람이 거부하면 정상 NO_APPROVED terminal로 영속화한다", async () => {
    const fixture = await workflowFixture();
    const execution = await fixture.service.createLiveComparison({
      sessionTokenDigest: "session-owner",
      idempotencyKey: "no-approved-001",
    });
    await fixture.service.runComparison({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    });
    const judged = await fixture.service.runJudge({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    });

    const terminal = await fixture.service.confirmReviews({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
      review: {
        reviewer: "Workflow reviewer",
        rationale: "세 후보 모두 승인할 수 없음을 증거와 대조했습니다.",
        decisions: judged.blind_review.candidates.map((candidate) => ({
          blind_label: candidate.blind_label,
          decision: "CONFIRMED_FAIL" as const,
        })),
      },
    });

    expect(terminal).toMatchObject({
      status: "NO_APPROVED_CANDIDATE",
      eligible_candidate_ids: [],
      selection: null,
      memo: null,
    });
    await expect(fixture.service.getExecution({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).resolves.toMatchObject({
      status: "NO_APPROVED_CANDIDATE",
      artifacts: { public_projection_persisted: true },
    });
    await expect(fixture.service.selectCandidate({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
      selection: {
        selected_candidate_id: "A",
        rationale: "정상 terminal에서는 선택할 수 없어야 합니다.",
      },
    })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(fixture.service.createDecisionMemo({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("다른 세션 조회·중복 run·성공 cap을 차단한다", async () => {
    const fixture = await workflowFixture();
    const first = await fixture.service.createLiveComparison({
      sessionTokenDigest: "session-owner",
      idempotencyKey: "live-owner-001",
    });
    await fixture.service.runComparison({
      sessionTokenDigest: "session-owner",
      executionId: first.execution_id,
    });

    await expect(fixture.service.getExecution({
      sessionTokenDigest: "session-other",
      executionId: first.execution_id,
    })).rejects.toMatchObject({ code: "EXECUTION_NOT_OWNED" });
    await expect(fixture.service.runComparison({
      sessionTokenDigest: "session-owner",
      executionId: first.execution_id,
    })).rejects.toMatchObject({ code: "DUPLICATE_RUN" });

    const capped = await fixture.service.createLiveComparison({
      sessionTokenDigest: "session-owner",
      idempotencyKey: "live-owner-002",
    });
    await expect(fixture.service.runComparison({
      sessionTokenDigest: "session-owner",
      executionId: capped.execution_id,
    })).rejects.toMatchObject({ code: "RUN_CAP_REACHED" });
    await expect(fixture.service.runJudge({
      sessionTokenDigest: "session-owner",
      executionId: first.execution_id,
    })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(fixture.service.selectRecordedFallback({
      sessionTokenDigest: "session-owner",
    })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("후보 hard-gate 실패는 결과로 유지하고 플랫폼 실패는 Judge 불가 상태로 분리한다", async () => {
    const candidateFixture = await workflowFixture(candidateFailureRunner());
    const candidateExecution =
      await candidateFixture.service.createLiveComparison({
        sessionTokenDigest: "session-owner",
        idempotencyKey: "candidate-failure-001",
      });
    await expect(candidateFixture.service.runComparison({
      sessionTokenDigest: "session-owner",
      executionId: candidateExecution.execution_id,
    })).resolves.toMatchObject({ status: "RESULTS_READY" });
    const candidateState = await candidateFixture.service.getResults({
      sessionTokenDigest: "session-owner",
      executionId: candidateExecution.execution_id,
    });
    expect(candidateState.canary.candidates.some(
      (candidate) => candidate.hard_gate.status === "CONFIRMED_FAIL",
    )).toBe(true);

    const platformFixture = await workflowFixture(platformFailureRunner());
    const platformExecution =
      await platformFixture.service.createLiveComparison({
        sessionTokenDigest: "session-owner",
        idempotencyKey: "platform-failure-001",
      });
    await expect(platformFixture.service.runComparison({
      sessionTokenDigest: "session-owner",
      executionId: platformExecution.execution_id,
    })).resolves.toMatchObject({
      status: "FAILED",
      error_code: "FAILED_PLATFORM",
      artifacts: {
        evaluation_pack_persisted: false,
        public_projection_persisted: false,
        cleanup_receipt_persisted: true,
      },
    });
    await expect(platformFixture.service.runJudge({
      sessionTokenDigest: "session-owner",
      executionId: platformExecution.execution_id,
    })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(platformFixture.service.getResults({
      sessionTokenDigest: "session-owner",
      executionId: platformExecution.execution_id,
    })).rejects.toMatchObject({ code: "ARTIFACT_UNAVAILABLE" });

    const restarted = createLiveDemoWorkflowService(platformFixture.options);
    await expect(restarted.getCurrentExecution("session-owner"))
      .resolves.toMatchObject({
        execution_id: platformExecution.execution_id,
        status: "FAILED",
        error_code: "FAILED_PLATFORM",
        cleanup_status: "ACKNOWLEDGED",
        artifacts: {
          evaluation_pack_persisted: false,
          public_projection_persisted: false,
          cleanup_receipt_persisted: true,
        },
      });
  });

  it("runner 계약 밖 throw는 비용·정리 결과를 만들지 않고 마지막 진행 증거를 보존한다", async () => {
    const fixture = await workflowFixture(unexpectedThrowRunner());
    const execution = await fixture.service.createLiveComparison({
      sessionTokenDigest: "session-owner",
      idempotencyKey: "unexpected-runner-throw-001",
    });

    await expect(fixture.service.runComparison({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).rejects.toThrow("LIVE_COMPARISON_RUNNER_CONTRACT_FAILURE");
    await expect(fixture.service.getCurrentExecution("session-owner"))
      .resolves.toMatchObject({
        execution_id: execution.execution_id,
        status: "RUNNING",
        progress_step: "FAILED_PLATFORM_UNRECONCILED",
        error_code: "FAILED_PLATFORM",
        cleanup_status: "RUNNING",
        actual_cost_micro_usd: 0,
        artifacts: {
          evaluation_pack_persisted: false,
          public_projection_persisted: false,
          cleanup_receipt_persisted: false,
        },
      });
    await expect(fixture.service.runComparison({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).rejects.toMatchObject({ code: "DUPLICATE_RUN" });

    const fallback = await fixture.service.selectRecordedFallback({
      sessionTokenDigest: "session-owner",
    });
    expect(fallback).toMatchObject({
      execution: {
        source: "RECORDED_FALLBACK",
        status: "RESULTS_READY",
      },
      state: {
        source: "RECORDED_FALLBACK",
        status: "JUDGE_REQUIRED",
      },
    });
  });

  it("polling은 lease가 만료된 RUNNING 실행을 INTERRUPTED로 회수한다", async () => {
    let rejectRunner!: (error: Error) => void;
    let markRunnerStarted!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      markRunnerStarted = resolve;
    });
    const blockedRunner: LiveComparisonRunner = () => {
      markRunnerStarted();
      return new Promise<LiveComparisonResult>((_resolve, reject) => {
        rejectRunner = reject;
      });
    };
    const fixture = await workflowFixture(blockedRunner);
    const service = createLiveDemoWorkflowService({
      ...fixture.options,
      leaseDurationMs: 1,
    });
    const execution = await service.createLiveComparison({
      sessionTokenDigest: "session-owner",
      idempotencyKey: "stale-polling-recovery-001",
    });
    const runPromise = service.runComparison({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    });
    void runPromise.catch(() => undefined);
    await runnerStarted;

    await expect(service.getExecution({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).resolves.toMatchObject({
      status: "INTERRUPTED",
      error_code: "STALE_HEARTBEAT",
    });

    rejectRunner(new Error("stopped after lease recovery"));
    await expect(runPromise).rejects.toBeDefined();
  });

  it("recorded fallback은 명시적으로 선택한 자체 2회 증거로 BLOCK까지 진행한다", async () => {
    const fixture = await workflowFixture(platformFailureRunner());
    const selected = await fixture.service.selectRecordedFallback({
      sessionTokenDigest: "session-owner",
    });

    expect(selected.execution).toMatchObject({
      source: "RECORDED_FALLBACK",
      status: "RESULTS_READY",
    });
    expect(selected.state).toMatchObject({
      source: "RECORDED_FALLBACK",
      status: "JUDGE_REQUIRED",
    });
    expect(selected.state.canary.candidates.every(
      (candidate) => candidate.runs.length === 2,
    )).toBe(true);
    const judged = await fixture.service.runJudge({
      sessionTokenDigest: "session-owner",
      executionId: selected.execution.execution_id,
    });
    expect(judged).toMatchObject({
      source: "RECORDED_FALLBACK",
      status: "REVIEW_REQUIRED",
    });
    expect(judged.blind_review.candidates.every(
      (candidate) => candidate.runs.length === 2,
    )).toBe(true);

    const reviewed = await fixture.service.confirmReviews({
      sessionTokenDigest: "session-owner",
      executionId: selected.execution.execution_id,
      review: {
        reviewer: "Recorded fallback reviewer",
        rationale: "명시적으로 선택한 2회 기록 증거를 모두 확인했습니다.",
        decisions: judged.blind_review.candidates.map((candidate) => ({
          blind_label: candidate.blind_label,
          decision: "PASS" as const,
        })),
      },
    });
    const selection = await fixture.service.selectCandidate({
      sessionTokenDigest: "session-owner",
      executionId: selected.execution.execution_id,
      selection: {
        selected_candidate_id: reviewed.eligible_candidate_ids[0]!,
        rationale: "기록된 결정적 gate와 사람 검수를 통과했습니다.",
      },
    });
    expect(selection.source).toBe("RECORDED_FALLBACK");

    const memo = await fixture.service.createDecisionMemo({
      sessionTokenDigest: "session-owner",
      executionId: selected.execution.execution_id,
    });
    expect(memo).toMatchObject({
      source: "RECORDED_FALLBACK",
      status: "MEMO_READY",
    });
    await expect(fixture.service.replayRegression({
      sessionTokenDigest: "session-owner",
      executionId: selected.execution.execution_id,
    })).resolves.toMatchObject({
      source: "RECORDED_FALLBACK",
      status: "BLOCK",
    });
    expect(fixture.riskAdapter.invoke).toHaveBeenCalledTimes(1);
    expect(fixture.memoAdapter.invoke).toHaveBeenCalledTimes(1);
    await expect(fixture.service.selectRecordedFallback({
      sessionTokenDigest: "session-owner",
    })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("memory fake도 만료 lease의 결과 승격을 거부한다", async () => {
    const fixture = await workflowFixture();
    const service = createLiveDemoWorkflowService({
      ...fixture.options,
      leaseDurationMs: 1,
    });
    const execution = await service.createLiveComparison({
      sessionTokenDigest: "session-owner",
      idempotencyKey: "expired-memory-lease",
    });

    await expect(service.runComparison({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).rejects.toSatisfy((error: unknown) => (
      error instanceof LiveDemoWorkflowError
      && error.code === "STALE_EXECUTION"
    ));
    await expect(fixture.repository.readOwnedExecution(
      execution.execution_id,
      "session-owner",
    )).resolves.toMatchObject({ status: "RUNNING" });
    await expect(service.getResults({
      sessionTokenDigest: "session-owner",
      executionId: execution.execution_id,
    })).rejects.toMatchObject({ code: "ARTIFACT_UNAVAILABLE" });
  });
});

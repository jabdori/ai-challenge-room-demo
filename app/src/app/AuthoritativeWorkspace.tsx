import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChallengeApiClient,
  ChallengeApiClientError,
} from "../data/challengeApi";
import {
  BENCHMARK_PROGRESS_POLL_INTERVAL_MS,
  parseCompareLifecycleProjection,
  parseDefineLifecycleProjection,
} from "../data/lifecycleViews";
import {
  parseEvidenceRecord,
  parseWorkspaceIndex,
  type WorkspaceIndexView,
} from "../data/workspaceProjection";
import type { EvidenceRecord } from "../domain/types";
import {
  CompareStage,
  type CompareBenchmarkView,
  type CompareExecutionRequest,
} from "../features/compare/CompareStage";
import {
  DefineStage,
  type DefineApprovalRequest,
  type DefineChallengeView,
  type DefineStructureRequest,
} from "../features/define/DefineStage";
import { EvidenceDrawer } from "../features/evidence/EvidenceDrawer";
import { parseRecordedBlindReviewEvidenceDetailProjection } from "../features/evidence/recordedBlindReviewEvidenceContract";
import {
  parseActiveBaselineProjection,
  parseHumanConfirmedDecisionProjection,
  parsePreconfirmationProjection,
  parseRecordedRegressionProjection,
  type ActiveBaselineView,
  type HumanConfirmedDecisionView,
  type RecordedPreconfirmationView,
  type RecordedRegressionView,
} from "../features/recorded/contracts";
import {
  RecordedDecisionStage,
  RecordedMonitorStage,
  RecordedPreconfirmationStage,
  RecordedRegressionReadyStage,
  type RecordedMemoConfirmation,
  type RecordedMemoRequest,
  type RecordedRegressionStartRequest,
  type RecordedReviewConfirmationSubmission,
} from "../features/recorded/RecordedWorkflowStages";
import { AppShell } from "./AppShell";

type AuthoritativeStage = "define" | "compare" | "decide" | "monitor";
type LogicalMutation =
  | "review"
  | "memo"
  | "decision"
  | "regression"
  | "define-structure"
  | "challenge-lock"
  | "benchmark-start"
  | "benchmark-resume";
type MutationFailureContext = "authority" | "memo" | "regression";

interface LoadedWorkspace {
  readonly index: WorkspaceIndexView;
  readonly challenge: DefineChallengeView;
  readonly benchmark: CompareBenchmarkView | null;
  readonly preconfirmation: RecordedPreconfirmationView | null;
  readonly decision: HumanConfirmedDecisionView | null;
  readonly baseline: ActiveBaselineView | null;
  readonly regression: RecordedRegressionView | null;
}

interface EvidenceExpectation {
  readonly evidenceId: string;
  readonly sourceHash: string;
  readonly kind: EvidenceRecord["kind"];
  readonly source: EvidenceRecord["source"];
  readonly caseId: string;
  readonly candidateLabel: string;
  readonly regressionVersion?: "BASELINE_V1" | "PROPOSED_V2";
  readonly evidenceBindingHash?: string;
  readonly reviewEvidenceHandle?: string | null;
}

interface PendingMutation {
  readonly logical: LogicalMutation;
  readonly expectedSourceHash: string;
  readonly committed: (workspace: LoadedWorkspace) => boolean;
}

function useMobileReadOnly(): boolean {
  const query = "(max-width: 767px)";
  const [matches, setMatches] = useState(() => (
    typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : window.innerWidth <= 767
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(media.matches);
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, []);
  return matches;
}

function shortHash(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function mutationKey(action: string): string {
  const random = new Uint32Array(4);
  window.crypto.getRandomValues(random);
  return `mutation_${action}_${Array.from(random, (value) => (
    value.toString(16).padStart(8, "0")
  )).join("")}`;
}

function LoadingState() {
  return (
    <section className="authoritative-state" role="status" aria-live="polite">
      <span className="section-kicker">VALIDATING AUTHORITATIVE ARTIFACTS</span>
      <h1>Loading the recorded workspace…</h1>
      <p>
        The browser will render only after the immutable artifact projections
        pass their contracts.
      </p>
    </section>
  );
}

function ErrorState() {
  return (
    <section
      className="authoritative-state authoritative-state--error"
      role="alert"
    >
      <span className="section-kicker">WORKSPACE WITHHELD</span>
      <h1>Recorded evidence could not be validated.</h1>
      <p>
        No fixture or browser state was substituted. Verify the local artifact
        server and immutable source chain, then reload.
      </p>
    </section>
  );
}

function assertLoadedAuthority(
  stage: AuthoritativeStage,
  loaded: LoadedWorkspace,
): void {
  const {
    index,
    preconfirmation,
    decision,
    baseline,
    regression,
  } = loaded;
  if (
    stage === "decide"
    && preconfirmation === null
    && decision === null
  ) {
    throw new Error("Decide authority artifact가 아직 없습니다.");
  }
  if (
    preconfirmation !== null
    && (
      decision !== null
      || preconfirmation.reviewId !== index.reviewId
      || preconfirmation.sourceHash !== index.sourceHash
      || (
        preconfirmation.preReviewStatus === "USER_CONFIRMATION_READY"
          ? index.decideStatus !== "USER CONFIRMATION REQUIRED"
          : index.decideStatus !== "USER CONFIRMATION BLOCKED"
      )
    )
  ) {
    throw new Error("Pre-confirmation source chain이 다릅니다.");
  }
  if (
    decision !== null
    && (
      decision.decisionId !== index.decisionId
      || decision.status.replaceAll("_", " ") !== index.decideStatus
      || (
        (
          decision.status === "HUMAN_CONFIRMED_REVIEW"
          || decision.status === "MEMO_REVIEW_REQUIRED"
          || decision.status === "NO_APPROVED_CANDIDATE"
        )
        && decision.sourceHash !== index.sourceHash
      )
    )
  ) {
    throw new Error("Decision source chain이 다릅니다.");
  }
  if (
    baseline !== null
    && (
      baseline.baselineId !== index.baselineId
      || decision === null
      || decision.status !== "DECISION_CONFIRMED"
      || decision.baselineId !== baseline.baselineId
      || decision.selectedCandidateId !== baseline.selectedCandidateId
      || decision.sourceHash !== baseline.sourceHash
      || decision.sourceHash !== baseline.decisionRecordHash
      || decision.finalDecisionMemoHash !== baseline.finalDecisionMemoHash
      || decision.finalMemoConfirmationHash
        !== baseline.finalMemoConfirmationHash
      || (
        regression === null
        && baseline.sourceHash !== index.sourceHash
      )
    )
  ) {
    throw new Error("Baseline source chain이 다릅니다.");
  }
  if (
    baseline === null
    && decision?.status === "DECISION_CONFIRMED"
  ) {
    throw new Error("Decision에 결합된 Baseline이 없습니다.");
  }
  if (
    stage === "monitor"
    && baseline === null
  ) {
    throw new Error("Monitor에 결합된 active baseline이 없습니다.");
  }
  if (
    stage === "monitor"
    && baseline !== null
    && (
      regression === null
        ? (
            index.regressionId !== null
            || index.monitorStatus !== "BASELINE ACTIVE"
          )
        : (
            regression.regressionId !== index.regressionId
            || regression.sourceHash !== index.sourceHash
            || regression.baselineId !== baseline.baselineId
            || regression.baselineCandidateId !== baseline.selectedCandidateId
            || regression.baselineConfigurationHash
              !== baseline.configurationHash
            || regression.verdict.replaceAll("_", " ") !== index.monitorStatus
          )
    )
  ) {
    throw new Error("Regression source chain이 다릅니다.");
  }
}

async function loadWorkspace(
  api: ChallengeApiClient,
  stage: AuthoritativeStage,
): Promise<LoadedWorkspace> {
  const index = parseWorkspaceIndex(await api.getWorkspace());
  const challenge = parseDefineLifecycleProjection(
    await api.getChallenge(index.challengeId),
  );
  const benchmark = stage === "compare"
    ? index.benchmarkId === null
      ? null
      : parseCompareLifecycleProjection(
          await api.getBenchmarkProgress(index.benchmarkId),
        )
    : null;

  const preconfirmation =
    stage === "decide"
    && index.decisionId === null
    && index.reviewId !== null
      ? parsePreconfirmationProjection(
          await api.getPreconfirmation(index.reviewId),
        )
      : null;
  const decision =
    (stage === "decide" || stage === "monitor")
    && index.decisionId !== null
      ? await parseHumanConfirmedDecisionProjection(
          await api.getDecision(index.decisionId),
        )
      : null;
  const baseline =
    (stage === "decide" || stage === "monitor")
    && index.baselineId !== null
      ? parseActiveBaselineProjection(
          await api.getBaseline(index.baselineId),
        )
      : null;
  const regression =
    stage === "monitor"
    && index.regressionId !== null
      ? parseRecordedRegressionProjection(
          await api.getRegression(index.regressionId),
        )
      : null;
  const loaded = {
    index,
    challenge,
    benchmark,
    preconfirmation,
    decision,
    baseline,
    regression,
  } satisfies LoadedWorkspace;
  assertLoadedAuthority(stage, loaded);
  return loaded;
}

function stageName(stage: AuthoritativeStage) {
  if (stage === "define") return "Define" as const;
  if (stage === "compare") return "Compare" as const;
  if (stage === "decide") return "Decide" as const;
  return "Monitor" as const;
}

function statusTone(
  stage: AuthoritativeStage,
  status: string,
): "neutral" | "review" | "block" | "baseline" {
  if (status.includes("BLOCK") || status.includes("FAILED")) return "block";
  if (status === "DECISION CONFIRMED" || status === "BASELINE ACTIVE") {
    return "baseline";
  }
  if (status === "READY TO RUN") return "review";
  if (
    stage === "compare"
    || status.includes("REVIEW")
    || status.includes("CONFIRMATION")
  ) {
    return "review";
  }
  return "neutral";
}

export function AuthoritativeWorkspace({
  stage,
}: {
  readonly stage: AuthoritativeStage;
}) {
  const [workspace, setWorkspace] = useState<LoadedWorkspace | null>(null);
  const [failed, setFailed] = useState(false);
  const [mutationFailure, setMutationFailure] = useState<
    MutationFailureContext | null
  >(null);
  const [terminalMutationFailure, setTerminalMutationFailure] = useState<
    MutationFailureContext | null
  >(null);
  const [mutationPending, setMutationPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [evidence, setEvidence] = useState<EvidenceRecord | null>(null);
  const [evidenceFailed, setEvidenceFailed] = useState(false);
  const requestSequence = useRef(0);
  const mutationPhase = useRef<"request" | "reload" | null>(null);
  const pendingMutationKeys = useRef(new Map<LogicalMutation, string>());
  const evidenceReturnFocus = useRef<HTMLElement | null>(null);
  const evidenceWasRequested = useRef(false);
  const mobileReadOnly = useMobileReadOnly();

  const restoreEvidenceFocus = useCallback(() => {
    const requestedTarget = evidenceReturnFocus.current;
    const canRestoreRequestedTarget = requestedTarget?.isConnected
      && !requestedTarget.matches(":disabled, [aria-disabled='true']");
    const focusTarget = canRestoreRequestedTarget
      ? requestedTarget
      : document.getElementById("main-workspace");
    focusTarget?.focus();
    evidenceReturnFocus.current = null;
    evidenceWasRequested.current = false;
  }, []);

  useEffect(() => {
    if (evidence !== null) return;
    if (evidenceWasRequested.current) restoreEvidenceFocus();
  }, [evidence, restoreEvidenceFocus]);

  useEffect(() => {
    let active = true;
    const api = new ChallengeApiClient();
    requestSequence.current += 1;
    setFailed(false);
    setMutationFailure(null);
    setTerminalMutationFailure(null);
    setWorkspace(null);
    setEvidence(null);
    setEvidenceFailed(false);
    void loadWorkspace(api, stage).then(
      (next) => {
        if (active) {
          setWorkspace(next);
        }
      },
      () => {
        if (active) {
          setFailed(true);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [revision, stage]);

  // RUNNING 중에는 서버가 source-reload한 공개 progress만 다시 읽습니다.
  // 브라우저가 완료 수를 추정하거나 start/resume mutation을 재전송하지 않으며,
  // terminal 상태·화면 전환·unmount에서는 effect cleanup으로 polling을 멈춥니다.
  useEffect(() => {
    if (stage !== "compare" || workspace?.benchmark?.status !== "RUNNING") {
      return;
    }
    const timer = window.setInterval(() => {
      setRevision((current) => current + 1);
    }, BENCHMARK_PROGRESS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [stage, workspace?.benchmark?.status]);

  const openEvidence = useCallback(async (
    expectation: EvidenceExpectation,
    trigger?: HTMLElement,
  ): Promise<boolean> => {
    evidenceReturnFocus.current =
      trigger
      ?? (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    const sequence = ++requestSequence.current;
    setEvidence(null);
    setEvidenceFailed(false);
    try {
      const api = new ChallengeApiClient();
      if (expectation.kind === "blind-review") {
        if (expectation.reviewEvidenceHandle === null || expectation.reviewEvidenceHandle === undefined) {
          throw new Error("현재 순서의 reviewer evidence handle이 없습니다.");
        }
        const detail = parseRecordedBlindReviewEvidenceDetailProjection(
          await api.getReviewerEvidence(
            expectation.evidenceId,
            expectation.reviewEvidenceHandle,
          ),
        );
        if (
          String(detail.case_id) !== expectation.caseId
          || detail.candidate_label !== expectation.candidateLabel
        ) {
          throw new Error("Reviewer evidence가 현재 대기열 항목과 일치하지 않습니다.");
        }
        const next: EvidenceRecord = {
          id: expectation.evidenceId,
          kind: "blind-review",
          title: `Blind review evidence · ${detail.case_id} · ${detail.candidate_label}`,
          caseId: String(detail.case_id),
          candidateLabel: detail.candidate_label,
          source: "BLIND HUMAN REVIEW",
          status: "REVIEW REQUIRED",
          caseSummary: "Reviewer-only recorded blind evidence.",
          expectedDecision: "Review both fixed runs against the locked requirements.",
          blindDetail: detail,
        };
        if (requestSequence.current === sequence) {
          evidenceWasRequested.current = true;
          setEvidence(next);
          return true;
        }
        return false;
      }
      const next = parseEvidenceRecord(
        await api.getEvidence(expectation.evidenceId),
      );
      if (
        next.id !== expectation.evidenceId
        || next.sourceHash !== expectation.sourceHash
        || next.kind !== expectation.kind
        || next.source !== expectation.source
        || next.caseId !== expectation.caseId
        || next.candidateLabel !== expectation.candidateLabel
        || next.regressionVersion !== expectation.regressionVersion
        || next.evidenceBindingHash !== expectation.evidenceBindingHash
      ) {
        throw new Error("Evidence queue context가 일치하지 않습니다.");
      }
      if (requestSequence.current === sequence) {
        evidenceWasRequested.current = true;
        setEvidence(next);
        return true;
      }
      return false;
    } catch {
      if (requestSequence.current === sequence) {
        setEvidenceFailed(true);
        restoreEvidenceFocus();
      }
      return false;
    }
  }, [restoreEvidenceFocus]);

  const closeEvidence = useCallback(() => {
    requestSequence.current += 1;
    setEvidence(null);
    setEvidenceFailed(false);
  }, []);

  const postAndReload = useCallback(async ({
    mutation,
    operation,
    failureContext = "authority",
  }: {
    readonly mutation: PendingMutation;
    readonly operation: (
      api: ChallengeApiClient,
      idempotencyKey: string,
    ) => Promise<unknown>;
    readonly failureContext?: MutationFailureContext;
  }) => {
    if (mutationPhase.current !== null) return;
    mutationPhase.current = "request";
    const idempotencyKey = pendingMutationKeys.current.get(mutation.logical)
      ?? mutationKey(mutation.logical);
    pendingMutationKeys.current.set(mutation.logical, idempotencyKey);
    setMutationPending(true);
    setMutationFailure(null);
    setTerminalMutationFailure(null);

    const reconcile = async (responseWasReceived: boolean) => {
      const next = await loadWorkspace(new ChallengeApiClient(), stage);
      if (mutation.committed(next)) {
        pendingMutationKeys.current.delete(mutation.logical);
        mutationPhase.current = null;
        setWorkspace(next);
        setFailed(false);
        setMutationPending(false);
        return;
      }
      if (
        !responseWasReceived
        && next.index.sourceHash === mutation.expectedSourceHash
      ) {
        // 권위 source가 변하지 않았으므로 같은 key로 안전하게 재시도할 수 있습니다.
        mutationPhase.current = null;
        setWorkspace(next);
        setMutationFailure(failureContext);
        setMutationPending(false);
        return;
      }
      throw new Error("Mutation response와 권위 workspace 전이가 일치하지 않습니다.");
    };

    let responseWasReceived = false;
    try {
      const api = new ChallengeApiClient();
      await operation(api, idempotencyKey);
      responseWasReceived = true;
      await reconcile(true);
    } catch (error) {
      if (
        error instanceof ChallengeApiClientError
        && error.durableFailure?.retryAllowed === false
      ) {
        // 동일 key의 durable failure는 이미 서버에 종결 기록됐습니다. 이 key를
        // 다시 사용하면 provider 재호출 없이 replay만 반복하므로 즉시 폐기합니다.
        pendingMutationKeys.current.delete(mutation.logical);
        try {
          const next = await loadWorkspace(new ChallengeApiClient(), stage);
          mutationPhase.current = null;
          setWorkspace(next);
          setFailed(false);
          setMutationFailure(null);
          setTerminalMutationFailure(failureContext);
          setMutationPending(false);
          return;
        } catch {
          mutationPhase.current = null;
          setWorkspace(null);
          setFailed(true);
          setMutationFailure(null);
          setTerminalMutationFailure(failureContext);
          setMutationPending(false);
          return;
        }
      }
      try {
        await reconcile(responseWasReceived);
      } catch {
        // source가 전진했지만 요청한 전이가 아니거나 authority를 재검증할 수 없으면
        // 브라우저 상태를 추정하지 않고 전체 화면을 보류합니다.
        mutationPhase.current = null;
        setWorkspace(null);
        setFailed(true);
        setMutationFailure(failureContext);
        setMutationPending(false);
      }
    }
  }, [stage]);

  const confirmReview = useCallback((
    submission: RecordedReviewConfirmationSubmission,
  ) => {
    void postAndReload({
      mutation: {
        logical: "review",
        expectedSourceHash: submission.expectedSourceHash,
        committed: (next) => next.index.reviewId === null
          && next.decision?.status === "HUMAN_CONFIRMED_REVIEW",
      },
      operation: (api, idempotencyKey) => api.postMutation({
        path: `/api/reviews/${submission.reviewId}/confirm`,
        schemaVersion: "review-confirmation-command-v1",
        expectedSourceHash: submission.expectedSourceHash,
        idempotencyKey,
        payload: {
          action: submission.items.some(
            (item) => item.proposalResolution === "EDITED",
          )
            ? "CONFIRM_WITH_EDITS"
            : "ACCEPT_ALL",
          actor_label: submission.actorLabel,
          items: submission.items.map((item) => ({
            item_id: item.itemId,
            final_decision: item.finalDecision,
            rationale: item.rationale,
            proposal_resolution: item.proposalResolution,
            review_duration_ms: item.reviewDurationMs,
            edit_duration_ms: item.editDurationMs,
          })),
        },
      }),
    });
  }, [postAndReload]);

  const requestMemo = useCallback((request: RecordedMemoRequest) => {
    void postAndReload({
      mutation: {
        logical: "memo",
        expectedSourceHash: request.expectedSourceHash,
        committed: (next) => next.decision?.status === "MEMO_REVIEW_REQUIRED"
          || next.decision?.status === "NO_APPROVED_CANDIDATE",
      },
      operation: (api, idempotencyKey) => api.postMutation({
        path: `/api/decisions/${request.decisionId}/memo`,
        schemaVersion: "decision-memo-command-v1",
        expectedSourceHash: request.expectedSourceHash,
        idempotencyKey,
        payload: {
          action: request.action,
          candidate_id: request.selectedCandidateId,
          rationale: request.rationale,
        },
      }),
      failureContext: "memo",
    });
  }, [postAndReload]);

  const confirmMemo = useCallback((request: RecordedMemoConfirmation) => {
    void postAndReload({
      mutation: {
        logical: "decision",
        expectedSourceHash: request.expectedSourceHash,
        committed: (next) => (
          next.decision?.status === "DECISION_CONFIRMED"
          && next.baseline !== null
        ) || (
          next.decision?.status === "NO_APPROVED_CANDIDATE"
          && next.baseline === null
        ),
      },
      operation: (api, idempotencyKey) => api.postMutation({
        path: `/api/decisions/${request.decisionId}/confirm`,
        schemaVersion: "decision-confirmation-command-v1",
        expectedSourceHash: request.expectedSourceHash,
        idempotencyKey,
        payload: {
          action: "CONFIRM",
          expected_final_decision_memo_hash:
            request.expectedFinalDecisionMemoHash,
        },
      }),
    });
  }, [postAndReload]);

  const startRegression = useCallback((
    request: RecordedRegressionStartRequest,
  ) => {
    void postAndReload({
      mutation: {
        logical: "regression",
        expectedSourceHash: request.expectedSourceHash,
        committed: (next) => next.regression !== null,
      },
      failureContext: "regression",
      operation: (api, idempotencyKey) => api.startRegression({
        baselineId: request.baselineId,
        expectedSourceHash: request.expectedSourceHash,
        idempotencyKey,
      }),
    });
  }, [postAndReload]);

  const structureDefine = useCallback((request: DefineStructureRequest) => {
    if (workspace === null) return;
    const expectedSourceHash = workspace.index.sourceHash;
    void postAndReload({
      mutation: {
        logical: "define-structure",
        expectedSourceHash,
        committed: (next) => next.challenge.state === "PROPOSED",
      },
      operation: (api, idempotencyKey) => api.structureDefine({
        expectedSourceHash,
        idempotencyKey,
        actorLabel: request.actorLabel,
      }),
    });
  }, [postAndReload, workspace]);

  const approveDefine = useCallback((request: DefineApprovalRequest) => {
    if (workspace === null) return;
    const expectedSourceHash = workspace.index.sourceHash;
    void postAndReload({
      mutation: {
        logical: "challenge-lock",
        expectedSourceHash,
        committed: (next) => next.challenge.state === "LOCKED",
      },
      operation: (api, idempotencyKey) => api.lockChallenge({
        expectedSourceHash,
        idempotencyKey,
        actorLabel: request.actorLabel,
        challengeId: workspace.index.challengeId,
        defineStructuringArtifactHash: request.defineStructuringArtifactHash,
        approvedContractHash: request.approvedContractHash,
      }),
    });
  }, [postAndReload, workspace]);

  const executeCompare = useCallback((request: CompareExecutionRequest) => {
    if (workspace === null || workspace.benchmark === null) return;
    const benchmarkId = workspace.benchmark.benchmark_id;
    const expectedSourceHash = workspace.index.sourceHash;
    if (request.executionMode === "RESUME") {
      if (request.resumeFromProgressHash === null) return;
      const resumeFromProgressHash = request.resumeFromProgressHash;
      void postAndReload({
        mutation: {
          logical: "benchmark-resume",
          expectedSourceHash,
          committed: (next) => next.benchmark?.status === "RUNNING",
        },
        operation: (api, idempotencyKey) => api.resumeBenchmark({
          expectedSourceHash,
          idempotencyKey,
          actorLabel: request.actorLabel,
          benchmarkId,
          resumeFromProgressHash,
        }),
      });
      return;
    }
    void postAndReload({
      mutation: {
        logical: "benchmark-start",
        expectedSourceHash,
        committed: (next) => next.benchmark?.status === "RUNNING",
      },
      operation: (api, idempotencyKey) => api.startBenchmark({
        expectedSourceHash,
        idempotencyKey,
        actorLabel: request.actorLabel,
        benchmarkId,
      }),
    });
  }, [postAndReload, workspace]);

  const activeStage = stageName(stage);
  const activeStatus = workspace
    ? stage === "define"
      ? workspace.index.defineStatus
      : stage === "compare"
        ? workspace.index.compareStatus
        : stage === "decide"
          ? workspace.index.decideStatus
          : workspace.regression === null && workspace.baseline !== null
            ? "READY TO RUN"
            : workspace.index.monitorStatus
    : failed
      ? "WITHHELD"
      : "VALIDATING";
  const stageStatuses = workspace
    ? {
        Define: workspace.index.defineStatus,
        Compare: workspace.index.compareStatus,
        Decide: workspace.index.decideStatus,
        Monitor: stage === "monitor"
          && workspace.regression === null
          && workspace.baseline !== null
          ? "READY TO RUN"
          : workspace.index.monitorStatus,
      }
    : undefined;
  const sourceHash =
    workspace?.regression?.sourceHash
    ?? workspace?.baseline?.sourceHash
    ?? workspace?.decision?.sourceHash
    ?? workspace?.preconfirmation?.sourceHash
    ?? workspace?.benchmark?.source_hash
    ?? workspace?.challenge.source_hash
    ?? "validation pending";
  const readOnly = mobileReadOnly || mutationPending;
  const contextLabel = workspace?.baseline
    ? `ACTIVE BASELINE · CANDIDATE ${workspace.baseline.selectedCandidateId}`
    : undefined;

  return (
    <>
      <AppShell
        stage={activeStage}
        status={activeStatus}
        statusTone={failed ? "block" : statusTone(stage, activeStatus)}
        readOnly={mobileReadOnly}
        monitorAvailable={workspace?.index.baselineId !== null}
        hasApprovedBaseline={workspace?.index.baselineId !== null}
        stageStatuses={stageStatuses}
        challengeLabel="Customer Support AI Selection"
        challengeVersionLabel={workspace
          ? `Challenge ${workspace.challenge.challenge_version}`
          : "Challenge validation pending"}
        workspaceIdLabel={workspace?.index.challengeId ?? "VALIDATION PENDING"}
        evaluationPackLabel={workspace?.index.benchmarkId
          ? shortHash(workspace.index.benchmarkId)
          : "NOT RECORDED"}
        datasetLabel={shortHash(sourceHash)}
        configurationLabel={workspace?.baseline
          ? `Candidate ${workspace.baseline.selectedCandidateId} · locked baseline`
          : workspace?.index.benchmarkId
            ? "A · B · C · locked identities"
            : "LOCKED WITH CHALLENGE"}
        runSourceLabel={
          workspace?.regression
            ? "RECORDED REGRESSION"
            : stage === "monitor" && workspace?.baseline
              ? "ACTIVE BASELINE"
              : workspace?.index.benchmarkId
                ? "RECORDED BENCHMARK"
                : "LOCKED CHALLENGE"
        }
        priceBasisLabel={workspace?.index.benchmarkId
          ? "LOCKED IN RECORDED PACK"
          : "NOT APPLICABLE"}
        contextLabel={contextLabel}
      >
        {!workspace && !failed ? <LoadingState /> : null}
        {failed ? <ErrorState /> : null}
        {mutationFailure === "authority" ? (
          <p className="projection-inline-error" role="alert">
            The server did not accept the requested authority transition. No
            local decision or baseline was created.
          </p>
        ) : null}
        {terminalMutationFailure === "authority" ? (
          <p className="projection-inline-error" role="alert">
            The requested authority transition reached a recorded terminal
            failure. Its idempotency key was discarded; only a new explicit
            retry can create a new request. No local decision or baseline was
            created.
          </p>
        ) : null}
        {mutationFailure === "memo" ? (
          <p className="projection-inline-error" role="alert">
            Decision Memo was not generated from the verified authority state.
            Retry to reconcile the same request. No local decision or baseline
            was created.
          </p>
        ) : null}
        {terminalMutationFailure === "memo" ? (
          <p className="projection-inline-error" role="alert">
            Decision Memo generation reached a recorded terminal failure. Its
            idempotency key was discarded; only a new explicit retry can create
            a new request. No local decision or baseline was created.
          </p>
        ) : null}
        {mutationFailure === "regression" ? (
          <p className="projection-inline-error" role="alert">
            Recorded regression was not started. The active baseline remains
            unchanged. No external deployment or rollback occurred.
          </p>
        ) : null}
        {terminalMutationFailure === "regression" ? (
          <p className="projection-inline-error" role="alert">
            Recorded regression reached a terminal failure. Its idempotency key
            was discarded; only a new explicit retry can create a new request.
            The active baseline remains unchanged.
          </p>
        ) : null}
        {evidenceFailed ? (
          <p className="projection-inline-error" role="alert">
            Evidence was withheld because its recorded projection did not
            validate.
          </p>
        ) : null}
        {workspace && stage === "define" ? (
          <DefineStage
            challenge={workspace.challenge}
            onStructure={structureDefine}
            onApprove={approveDefine}
            mutationPending={mutationPending}
            mobileReadOnly={mobileReadOnly}
          />
        ) : null}
        {workspace && stage === "compare" && workspace.benchmark ? (
          <CompareStage
            benchmark={workspace.benchmark}
            onStart={executeCompare}
            onResume={executeCompare}
            mutationPending={mutationPending}
            mobileReadOnly={mobileReadOnly}
            onOpenEvidence={(slot) => void openEvidence({
              evidenceId: slot.evidence_id,
              sourceHash: workspace.benchmark!.source_hash,
              kind: "benchmark",
              source: "RECORDED BENCHMARK",
              caseId: slot.case_id,
              candidateLabel: `Candidate ${slot.candidate_id}`,
            })}
          />
        ) : null}
        {workspace && stage === "decide" && workspace.preconfirmation ? (
          <RecordedPreconfirmationStage
            projection={workspace.preconfirmation}
            readOnly={readOnly}
            onOpenEvidence={async (evidenceId) => {
              const item = workspace.preconfirmation!.items.find(
                (candidate) => candidate.evidenceId === evidenceId,
              );
              if (item === undefined) {
                setEvidence(null);
                setEvidenceFailed(true);
                return false;
              }
              return openEvidence({
                evidenceId,
                sourceHash:
                  workspace.preconfirmation!.recordedBenchmarkPackHash,
                kind: "blind-review",
                source: "BLIND HUMAN REVIEW",
                caseId: item.caseId,
                candidateLabel: item.candidateLabel,
                reviewEvidenceHandle: item.reviewEvidenceHandle,
              });
            }}
            onConfirm={confirmReview}
          />
        ) : null}
        {workspace && stage === "decide" && workspace.decision ? (
          <RecordedDecisionStage
            projection={workspace.decision}
            readOnly={readOnly}
            onOpenEvidence={(evidenceId, trigger) => {
              const recordedBenchmark = workspace.benchmark !== null
                && "slots" in workspace.benchmark
                ? workspace.benchmark
                : null;
              const slot = recordedBenchmark?.slots.find(
                (candidate) => candidate.evidence_id === evidenceId,
              );
              if (slot === undefined || recordedBenchmark === null) {
                setEvidence(null);
                setEvidenceFailed(true);
                return;
              }
              void openEvidence({
                evidenceId,
                sourceHash: recordedBenchmark.source_hash,
                kind: "benchmark",
                source: "RECORDED BENCHMARK",
                caseId: slot.case_id,
                candidateLabel: `Candidate ${slot.candidate_id}`,
              }, trigger);
            }}
            onRequestMemo={requestMemo}
            onConfirmMemo={confirmMemo}
          />
        ) : null}
        {workspace && stage === "monitor" && workspace.regression ? (
          <RecordedMonitorStage
            projection={workspace.regression}
            onOpenEvidence={(evidenceId) => {
              const binding = workspace.regression!.evidenceBindings.find(
                (candidate) => candidate.evidenceId === evidenceId,
              );
              if (binding === undefined) {
                setEvidence(null);
                setEvidenceFailed(true);
                return;
              }
              void openEvidence({
                evidenceId,
                sourceHash: workspace.regression!.sourceHash,
                kind: binding.kind,
                source: binding.source,
                caseId: binding.caseId,
                candidateLabel: binding.candidateLabel,
                regressionVersion: binding.version,
                evidenceBindingHash: binding.evidenceBindingHash,
              });
            }}
          />
        ) : null}
        {workspace
          && stage === "monitor"
          && workspace.baseline
          && !workspace.regression ? (
            <RecordedRegressionReadyStage
              baseline={workspace.baseline}
              mobileReadOnly={mobileReadOnly}
              pending={mutationPending}
              onStart={startRegression}
            />
          ) : null}
      </AppShell>
      <EvidenceDrawer
        evidence={evidence}
        readOnly
        humanReviewAllowed={false}
        humanReviewLockReason={
          "Recorded evidence is read-only. Human confirmation is recorded in the blind review queue."
        }
        onHumanConfirmation={() => false}
        onClose={closeEvidence}
      />
    </>
  );
}

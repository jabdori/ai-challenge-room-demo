import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "./app/AppShell";
import { AuthoritativeWorkspace } from "./app/AuthoritativeWorkspace";
import {
  blindReviewCandidateByEvidenceId,
  createPendingReviewQueue,
  evidenceRecords,
} from "./data/fixtures";
import type {
  CandidateId,
  EvidenceRecord,
  HumanConfirmationRecord,
  HumanReviewDecision,
} from "./domain/types";
import { DecideStage } from "./features/decision/DecideStage";
import { NoApprovedCandidateState } from "./features/decision/NoApprovedCandidateState";
import { EvidenceDrawer } from "./features/evidence/EvidenceDrawer";
import { MonitorBlockStage } from "./features/monitor/MonitorBlockStage";
import { HackathonDemoWorkspace } from "./features/demo/HackathonDemoWorkspace";
import { JudgeAccessGate } from "./features/access/JudgeAccessGate";
import "./styles/tokens.css";

type View = "decide" | "no-approved" | "monitor";
type NoCandidateMode = "all-failed" | "owner-declined" | "human-review-failed";

const REVIEW_STORAGE_KEY = "ai-challenge-room:human-confirmations";
const REVIEW_WORKFLOW_STORAGE_KEY = "ai-challenge-room:review-workflow";
const DECISION_STORAGE_KEY = "ai-challenge-room:decision-record";

type StoredDecision =
  | {
      outcome: "baseline";
      candidateId: Exclude<CandidateId, "A">;
      actor: string;
      reason: string;
      decisionRecordedAt: string;
    }
  | {
      outcome: "no-approved";
      mode: NoCandidateMode;
      actor: string;
      reason: string;
      decisionRecordedAt: string;
    };

function readStoredHumanConfirmations(): HumanConfirmationRecord[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(REVIEW_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is HumanConfirmationRecord => {
      if (!item || typeof item !== "object") return false;
      const record = item as Partial<HumanConfirmationRecord>;
      return (record.evidenceId === "blind-h017-x" || record.evidenceId === "blind-h021-z")
        && (record.decision === "PASS" || record.decision === "CONFIRMED FAIL")
        && typeof record.rationale === "string"
        && Boolean(record.rationale.trim())
        && typeof record.confirmedAt === "string";
    });
  } catch {
    return [];
  }
}

function readStoredDecision(): StoredDecision | null {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(DECISION_STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const hasAudit = typeof record.actor === "string"
      && typeof record.reason === "string"
      && Boolean(record.reason.trim())
      && typeof record.decisionRecordedAt === "string";
    if (!hasAudit) return null;
    const validNoCandidateMode = record.mode === "all-failed"
      || record.mode === "owner-declined"
      || record.mode === "human-review-failed";
    if (record.outcome === "no-approved" && validNoCandidateMode) {
      return {
        outcome: "no-approved",
        mode: record.mode as NoCandidateMode,
        actor: record.actor as string,
        reason: record.reason as string,
        decisionRecordedAt: record.decisionRecordedAt as string,
      };
    }
    if (record.outcome === "baseline" && (record.candidateId === "B" || record.candidateId === "C")) {
      return {
        outcome: "baseline",
        candidateId: record.candidateId,
        actor: record.actor as string,
        reason: record.reason as string,
        decisionRecordedAt: record.decisionRecordedAt as string,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function attachHumanConfirmation(
  evidence: EvidenceRecord | null,
  confirmations: readonly HumanConfirmationRecord[],
) {
  if (!evidence) return null;
  const blindEvidenceId = evidence.id === "human-review-b-h017"
    ? "blind-h017-x"
    : evidence.id === "human-review-c-h021"
      ? "blind-h021-z"
      : null;
  if (!blindEvidenceId) return evidence;
  const confirmation = confirmations.find((record) => record.evidenceId === blindEvidenceId);
  if (!confirmation) return evidence;
  return {
    ...evidence,
    humanConfirmation: `${confirmation.decision} · ${confirmation.rationale}`,
    metadata: [
      ...(evidence.metadata ?? []),
      `Reviewer rationale recorded ${confirmation.confirmedAt}`,
    ],
  };
}

function getInitialRoute() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("view") === "fixture-demo"
    ? params.get("fixtureView")
    : params.get("view");
  const reviewPending = params.get("review") === "pending";
  const reviewWorkflowStarted = reviewPending
    || window.sessionStorage.getItem(REVIEW_WORKFLOW_STORAGE_KEY) === "started";
  if (reviewPending) window.sessionStorage.setItem(REVIEW_WORKFLOW_STORAGE_KEY, "started");
  const humanConfirmations = readStoredHumanConfirmations();
  const resolvedReviewIds = new Set(humanConfirmations.map((confirmation) => confirmation.evidenceId));
  const reviewWorkflowIncomplete = reviewWorkflowStarted
    && (!resolvedReviewIds.has("blind-h017-x") || !resolvedReviewIds.has("blind-h021-z"));
  const requestedView: View = requested === "monitor" || requested === "no-approved" ? requested : "decide";
  const requestedBaseline = params.get("baseline");
  const storedDecision = readStoredDecision();
  const view: View = requestedView === "no-approved" && reviewWorkflowIncomplete
    ? "decide"
    : storedDecision?.outcome === "baseline" && requestedView === "no-approved"
      ? "decide"
      : storedDecision?.outcome === "no-approved" && requestedView === "decide"
        ? "no-approved"
        : requestedView;
  const approvedBaseline = storedDecision?.outcome === "baseline" ? storedDecision.candidateId : null;
  const reason = params.get("reason");
  const requestedNoCandidateMode: NoCandidateMode = reason === "owner-declined"
    ? "owner-declined"
    : reason === "human-review-failed"
      ? "human-review-failed"
      : "all-failed";
  return {
    view,
    baselineCandidateId: approvedBaseline && requestedBaseline === approvedBaseline
      ? approvedBaseline as CandidateId
      : null,
    recordedBaselineCandidateId: approvedBaseline,
    decisionOutcome: view === "decide" && approvedBaseline
      ? "baseline" as const
      : view === "no-approved" && storedDecision?.outcome === "no-approved"
        ? "no-approved" as const
        : "draft" as const,
    humanConfirmations,
    reviewWorkflowStarted,
    storedDecision,
    noCandidateMode: storedDecision?.outcome === "no-approved"
      ? storedDecision.mode
      : requestedNoCandidateMode,
    evidence: params.get("evidence") ? evidenceRecords[params.get("evidence")!] ?? null : null,
  };
}

function useReadOnlyViewport() {
  const query = "(max-width: 767px)";
  const [matches, setMatches] = useState(() =>
    typeof window.matchMedia === "function" ? window.matchMedia(query).matches : window.innerWidth <= 767,
  );

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

function syncEvidenceQuery(evidenceId: string | null) {
  const url = new URL(window.location.href);
  if (evidenceId) url.searchParams.set("evidence", evidenceId);
  else url.searchParams.delete("evidence");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function clearPendingReviewQuery() {
  const url = new URL(window.location.href);
  url.searchParams.delete("review");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function FixtureDecisionWorkspace() {
  const [initialRoute] = useState(getInitialRoute);
  const { view, reviewWorkflowStarted, noCandidateMode } = initialRoute;
  const [evidence, setEvidence] = useState<EvidenceRecord | null>(() =>
    attachHumanConfirmation(initialRoute.evidence, initialRoute.humanConfirmations));
  const [humanConfirmations, setHumanConfirmations] = useState<HumanConfirmationRecord[]>(initialRoute.humanConfirmations);
  const [decisionOutcome, setDecisionOutcome] = useState<"draft" | "baseline" | "no-approved">(initialRoute.decisionOutcome);
  const [decisionDraftStarted, setDecisionDraftStarted] = useState(false);
  const [baselineCandidateId, setBaselineCandidateId] = useState<CandidateId | null>(initialRoute.recordedBaselineCandidateId);
  const monitorBaselineCandidateId = view === "monitor" ? initialRoute.baselineCandidateId : baselineCandidateId;
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const evidenceWasOpenRef = useRef(Boolean(initialRoute.evidence));
  const readOnly = useReadOnlyViewport();
  const resolvedReviewIds = new Set(humanConfirmations.map((confirmation) => confirmation.evidenceId));
  const pendingReviewQueue = createPendingReviewQueue(resolvedReviewIds);
  const nextReviewEvidenceId = reviewWorkflowStarted ? pendingReviewQueue.nextEvidenceId : null;
  const reviewIncomplete = reviewWorkflowStarted
    && (!resolvedReviewIds.has("blind-h017-x") || !resolvedReviewIds.has("blind-h021-z"));
  const recordedFailedCandidateIds = new Set<CandidateId>(
    humanConfirmations
      .filter((confirmation) => confirmation.decision === "CONFIRMED FAIL")
      .map((confirmation) => blindReviewCandidateByEvidenceId[confirmation.evidenceId])
      .filter((candidateId): candidateId is CandidateId => Boolean(candidateId)),
  );
  const confirmedFailedCandidateIds = reviewIncomplete
    ? new Set<CandidateId>()
    : recordedFailedCandidateIds;
  const pendingConfirmedFailure = reviewIncomplete && recordedFailedCandidateIds.size > 0;

  useEffect(() => {
    if (evidence) {
      evidenceWasOpenRef.current = true;
      return;
    }

    if (evidenceWasOpenRef.current) {
      const requestedTarget = returnFocusRef.current;
      const canRestoreRequestedTarget = requestedTarget?.isConnected
        && !requestedTarget.matches(":disabled, [aria-disabled='true']");
      const focusTarget = canRestoreRequestedTarget ? requestedTarget : document.getElementById("main-workspace");
      focusTarget?.focus();
      returnFocusRef.current = null;
      evidenceWasOpenRef.current = false;
    }
  }, [evidence]);

  useEffect(() => {
    if (reviewWorkflowStarted && !reviewIncomplete) clearPendingReviewQuery();
  }, [reviewIncomplete, reviewWorkflowStarted]);

  const openEvidence = useCallback((evidenceId: string) => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    syncEvidenceQuery(evidenceId);
    setEvidence(attachHumanConfirmation(evidenceRecords[evidenceId] ?? null, humanConfirmations));
  }, [humanConfirmations]);

  const closeEvidence = useCallback(() => {
    syncEvidenceQuery(null);
    setEvidence(null);
  }, []);

  const recordHumanConfirmation = useCallback((
    evidenceId: string,
    decision: HumanReviewDecision,
    rationale: string,
  ) => {
    if (readOnly || !reviewWorkflowStarted || evidenceId !== nextReviewEvidenceId) return false;
    window.sessionStorage.setItem(REVIEW_WORKFLOW_STORAGE_KEY, "started");
    setHumanConfirmations((current) => {
      const next: HumanConfirmationRecord[] = [
        ...current.filter((confirmation) => confirmation.evidenceId !== evidenceId),
        { evidenceId, decision, rationale, confirmedAt: new Date().toISOString() },
      ];
      window.sessionStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    return true;
  }, [nextReviewEvidenceId, readOnly, reviewWorkflowStarted]);

  const shell = view === "monitor"
    ? { stage: "Monitor" as const, status: "BLOCK", tone: "block" as const }
    : view === "no-approved"
      ? { stage: "Decide" as const, status: decisionOutcome === "no-approved" ? "NO APPROVED CANDIDATE" : "DECISION DRAFT", tone: "neutral" as const }
      : decisionOutcome === "baseline"
        ? { stage: "Decide" as const, status: "ACTIVE BASELINE", tone: "baseline" as const }
        : reviewIncomplete
            ? { stage: "Decide" as const, status: "EVALUATION INCOMPLETE", tone: "review" as const }
            : { stage: "Decide" as const, status: decisionDraftStarted ? "DECISION DRAFT" : "EVIDENCE READY", tone: "neutral" as const };

  return (
    <>
      <AppShell
        stage={shell.stage}
        status={shell.status}
        statusTone={shell.tone}
        readOnly={readOnly}
        monitorAvailable={view === "monitor" || decisionOutcome === "baseline"}
        monitorHref={baselineCandidateId ? `/?view=monitor&baseline=${baselineCandidateId}` : "/?view=monitor"}
        hasApprovedBaseline={view === "monitor" ? Boolean(monitorBaselineCandidateId) : decisionOutcome === "baseline"}
        contextLabel={view === "monitor"
          ? monitorBaselineCandidateId
            ? `APPROVED BASELINE · CANDIDATE ${monitorBaselineCandidateId}`
            : "SEPARATE SYNTHETIC BASELINE"
          : undefined}
      >
        {view === "monitor" ? <MonitorBlockStage baselineCandidateId={monitorBaselineCandidateId} onOpenEvidence={openEvidence} /> : null}
        {view === "no-approved" ? <NoApprovedCandidateState
          mode={noCandidateMode}
          readOnly={readOnly}
          restoredDecision={initialRoute.storedDecision?.outcome === "no-approved"
            ? initialRoute.storedDecision
            : null}
          onDecisionConfirmed={(decision) => {
          window.sessionStorage.setItem(DECISION_STORAGE_KEY, JSON.stringify({ outcome: "no-approved", mode: noCandidateMode, ...decision } satisfies StoredDecision));
          setDecisionOutcome("no-approved");
        }} onOpenEvidence={openEvidence} /> : null}
        {view === "decide" ? (
          <DecideStage
            readOnly={readOnly}
            reviewPending={reviewIncomplete}
            pendingConfirmedFailure={pendingConfirmedFailure}
            confirmedFailedCandidateIds={confirmedFailedCandidateIds}
            resolvedReviewIds={resolvedReviewIds}
            restoredBaselineDecision={initialRoute.storedDecision?.outcome === "baseline"
              ? initialRoute.storedDecision
              : null}
            onBaselineCreated={(decision) => {
              window.sessionStorage.setItem(DECISION_STORAGE_KEY, JSON.stringify({ outcome: "baseline", ...decision } satisfies StoredDecision));
              setBaselineCandidateId(decision.candidateId);
              setDecisionOutcome("baseline");
            }}
            onDecisionDraftChange={setDecisionDraftStarted}
            onOpenEvidence={openEvidence}
          />
        ) : null}
      </AppShell>
      <EvidenceDrawer
        evidence={evidence}
        readOnly={readOnly}
        humanReviewAllowed={Boolean(evidence?.kind === "blind-review" && evidence.id === nextReviewEvidenceId)}
        humanReviewLockReason={reviewWorkflowStarted
          ? "Complete the prior queued review before recording this confirmation."
          : "This evaluation has no open human-review item."}
        onHumanConfirmation={recordHumanConfirmation}
        onClose={closeEvidence}
      />
    </>
  );
}

export function App() {
  const requested = new URLSearchParams(window.location.search).get("view");
  if (requested === "fixture-demo" && import.meta.env.DEV) {
    return <FixtureDecisionWorkspace />;
  }
  const workspace = requested === "demo" || (import.meta.env.PROD && requested === null)
    ? <HackathonDemoWorkspace />
    : requested === "define" || requested === "compare" || requested === "monitor"
      ? <AuthoritativeWorkspace stage={requested} />
      : <AuthoritativeWorkspace stage="decide" />;
  return import.meta.env.PROD
    ? <JudgeAccessGate>{workspace}</JudgeAccessGate>
    : workspace;
}

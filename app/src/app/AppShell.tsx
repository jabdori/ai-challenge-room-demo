import {
  ArrowRight,
  Check,
  Flask,
  Gauge,
  LockKey,
  Scales,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { StatusBadge } from "../components/StatusBadge";
import { useJudgeSessionActions } from "../features/access/JudgeAccessGate";

type AppStage = "Define" | "Compare" | "Decide" | "Monitor";

interface AppShellProps {
  stage: AppStage;
  status: string;
  statusTone?: "neutral" | "review" | "block" | "baseline";
  readOnly: boolean;
  monitorAvailable?: boolean;
  monitorHref?: string;
  hasApprovedBaseline?: boolean;
  contextLabel?: string;
  stageStatuses?: Partial<Record<AppStage, string>>;
  challengeLabel?: string;
  challengeVersionLabel?: string;
  workspaceIdLabel?: string;
  evaluationPackLabel?: string;
  evaluationPackMetaLabel?: string;
  datasetLabel?: string;
  configurationLabel?: string;
  runSourceLabel?: string;
  priceBasisLabel?: string;
  stageHrefs?: Partial<Record<AppStage, string>>;
  judgeSessionAction?: "END_SESSION" | "START_NEW_COMPARISON";
  judgeSessionActionDisabled?: boolean;
  children: ReactNode;
}

const steps = [
  { number: "01", label: "Define", icon: LockKey },
  { number: "02", label: "Compare", icon: Gauge },
  { number: "03", label: "Decide", icon: Scales },
  { number: "04", label: "Monitor", icon: Flask },
] as const;

const RAIL_STATUS_LABELS: Readonly<Record<string, string>> = {
  "BASELINE RECORDED": "BASELINE",
  "CHANGE CHECK READY": "CHECK READY",
  "DECISION DRAFT": "DRAFT",
  "DECISION MEMO GENERATING": "MEMO",
  "EVALUATION INCOMPLETE": "INCOMPLETE",
  "EVIDENCE READY": "READY",
  "GPT-5.6 JUDGE RUNNING": "JUDGING",
  "LIVE COMPARISON RUNNING": "RUNNING",
  "NO APPROVED CANDIDATE": "NO APPROVED",
  "REVIEW COMPLETE": "REVIEW DONE",
  "REVIEW PENDING": "REVIEW",
  "SELECTION RECORDED": "SELECTED",
  "SELECTION REQUIRED": "SELECT",
};

function railStatusLabel(stage: AppStage, value: string): string {
  const liveProgress = /^(\d+) \/ 3 LIVE$/u.exec(value);
  if (liveProgress) return `${liveProgress[1]}/3 LIVE`;
  if (value === "NOT STARTED") return "PENDING";
  if (value === "NO DECISION") {
    return stage === "Monitor" ? "LOCKED" : "REQUIRED";
  }
  return RAIL_STATUS_LABELS[value] ?? value;
}

function compactIdentifier(value: string): string {
  return value.length <= 28
    ? value
    : `${value.slice(0, 16)}…${value.slice(-8)}`;
}

export function AppShell({
  stage,
  status,
  statusTone = "neutral",
  readOnly,
  monitorAvailable = true,
  monitorHref = "/?view=monitor",
  hasApprovedBaseline = false,
  contextLabel,
  stageStatuses,
  challengeLabel = "Customer Support AI Selection",
  challengeVersionLabel = "Challenge v1",
  workspaceIdLabel = "CS-2026-0716",
  evaluationPackLabel = "eval-pack-01",
  evaluationPackMetaLabel = "12 hidden cases · 2 fixed runs",
  datasetLabel = "hidden-support-v1 · 6d8a…09f2",
  configurationLabel = "cfg-a-19 · cfg-b-02 · cfg-c-07",
  runSourceLabel,
  priceBasisLabel = "2026-07-16",
  stageHrefs,
  judgeSessionAction = "END_SESSION",
  judgeSessionActionDisabled = false,
  children,
}: AppShellProps) {
  const judgeSession = useJudgeSessionActions();
  const startsNewComparison = judgeSessionAction === "START_NEW_COMPARISON";
  const handleJudgeSessionAction = () => {
    if (
      startsNewComparison
      && !window.confirm(
        "Start a new comparison? The current execution and its evidence will be preserved. You will return to the access code screen.",
      )
    ) {
      return;
    }
    void judgeSession?.endSession();
  };
  return (
    <div className="app-shell" id="app-shell-root">
      <a className="skip-link" href="#main-workspace">Skip to decision workspace</a>
      <header className="global-header">
        <div className="product-identity">
          <div className="product-mark" aria-hidden="true">
            <Scales size={20} weight="bold" />
          </div>
          <div>
            <span className="eyebrow">DECISION WORKSPACE</span>
            <strong>AI Challenge Room</strong>
          </div>
        </div>

        <div className="challenge-identity" aria-label="Current Challenge">
          <span className="eyebrow">CHALLENGE</span>
          <strong>{challengeLabel}</strong>
        </div>

        <div className="header-meta">
          <StatusBadge tone="recorded" compact>SYNTHETIC DATA</StatusBadge>
          {contextLabel ? <StatusBadge tone="neutral" compact>{contextLabel}</StatusBadge> : null}
          <span className="version-chip">{challengeVersionLabel}</span>
          <StatusBadge tone={statusTone} compact>{status}</StatusBadge>
          {judgeSession ? (
            <button
              className="button button--secondary button--compact judge-session-action"
              type="button"
              disabled={judgeSession.ending || judgeSessionActionDisabled}
              onClick={handleJudgeSessionAction}
            >
              {judgeSession.ending
                ? "Ending session…"
                : startsNewComparison
                  ? "Start new comparison"
                  : "End judge session"}
            </button>
          ) : null}
        </div>
      </header>

      {readOnly ? (
        <div className="mobile-readonly-banner" role="status">
          Desktop workspace required for decision changes. Results and Evidence remain available.
        </div>
      ) : null}

      <div className="workspace-frame">
        <aside className="stage-rail" aria-label="Challenge stages">
          <div className="rail-context">
            <span className="eyebrow">PRIVATE WORKSPACE</span>
            <span>{workspaceIdLabel}</span>
          </div>
          <nav>
            <ol className="stage-list">
              {steps.map((step) => {
                const Icon = step.icon;
                const isActive = step.label === stage;
                const monitorUnavailable = step.label === "Monitor" && !monitorAvailable;
                const isAvailable = step.label !== "Monitor" || monitorAvailable;
                const href = stageHrefs?.[step.label]
                  ?? (step.label === "Define"
                    ? "/?view=define"
                    : step.label === "Compare"
                      ? "/?view=compare"
                      : step.label === "Monitor"
                        ? monitorHref
                        : "/?view=decide");
                const defaultStepMeta = step.label === "Define"
                  ? "LOCKED"
                  : step.label === "Compare"
                    ? "COMPLETE"
                    : step.label === "Decide"
                      ? (stage === "Decide" ? status : hasApprovedBaseline ? "BASELINE RECORDED" : "NO BASELINE")
                      : monitorUnavailable
                        ? "NO BASELINE"
                        : stage === "Monitor"
                          ? status
                          : "BASELINE READY";
                const stepMeta = step.label === stage
                  ? status
                  : stageStatuses?.[step.label] ?? defaultStepMeta;
                return (
                  <li key={step.label}>
                    {isAvailable ? (
                      <a className={`stage-link${isActive ? " is-active" : ""}`} href={href} aria-current={isActive ? "step" : undefined} aria-label={`${step.label}, ${stepMeta}`}>
                        <span className="stage-number">{step.number}</span>
                        <Icon aria-hidden="true" size={18} weight={isActive ? "fill" : "regular"} />
                        <span className="stage-copy">
                          <strong>{step.label}</strong>
                          <small title={stepMeta}>{railStatusLabel(step.label, stepMeta)}</small>
                        </span>
                        {isActive ? (
                          <ArrowRight aria-hidden="true" size={14} weight="bold" />
                        ) : null}
                      </a>
                    ) : (
                      <div className={`stage-link ${monitorUnavailable ? "is-unavailable" : "is-complete"}`} aria-label={`${step.label}, ${stepMeta}`}>
                        <span className="stage-number">{step.number}</span>
                        <Icon aria-hidden="true" size={18} />
                        <span className="stage-copy">
                          <strong>{step.label}</strong>
                          <small title={stepMeta}>{railStatusLabel(step.label, stepMeta)}</small>
                        </span>
                        {monitorUnavailable ? <span aria-hidden="true" /> : <Check aria-hidden="true" size={14} weight="bold" />}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
          <div className="rail-footer">
            <span className="eyebrow">EVALUATION PACK</span>
            <strong
              aria-label={`Evaluation pack, ${evaluationPackLabel}`}
              title={evaluationPackLabel}
            >
              {compactIdentifier(evaluationPackLabel)}
            </strong>
            <small>{evaluationPackMetaLabel}</small>
          </div>
        </aside>

        <main className="workspace-main" id="main-workspace" tabIndex={-1}>{children}</main>
      </div>
      <footer className="context-bar" aria-label="Locked evaluation context">
        <span><strong>DATASET</strong> {datasetLabel}</span>
        <span><strong>CONFIGS</strong> {configurationLabel}</span>
        <span><strong>RUN SOURCE</strong> {runSourceLabel ?? (stage === "Monitor" ? "RECORDED REGRESSION" : "RECORDED BENCHMARK")}</span>
        {contextLabel ? <span><strong>BASELINE</strong> {contextLabel} · v1</span> : null}
        <span><strong>PRICE BASIS</strong> {priceBasisLabel}</span>
      </footer>
    </div>
  );
}

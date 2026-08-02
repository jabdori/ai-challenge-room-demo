import {
  ArrowRight,
  ArrowsLeftRight,
  Database,
  LockKey,
  Prohibit,
  ShieldWarning,
} from "@phosphor-icons/react";
import { StatusBadge } from "../../components/StatusBadge";
import { candidates } from "../../data/fixtures";
import type { CandidateId, CandidateResult } from "../../domain/types";
import { formatDecimal, formatUsd } from "../../utils/formatters";

interface MonitorBlockStageProps {
  baselineCandidateId: CandidateId | null;
  onOpenEvidence: (evidenceId: string) => void;
}

export function MonitorBlockStage({ baselineCandidateId, onOpenEvidence }: MonitorBlockStageProps) {
  const displayedCandidateId = baselineCandidateId ?? "B";
  const baselineCandidate = candidates.find((candidate) => candidate.id === displayedCandidateId)!;
  const evidenceId = displayedCandidateId === "C" ? "regression-h011-c" : "regression-h011";
  const separateFixture = baselineCandidateId === null;
  return (
    <div className="page-stack monitor-page">
      <div className="page-header">
        <div>
          <span className="page-index">04 / MONITOR · CHANGE APPROVAL</span>
          <h1>Protect the approved decision</h1>
          <p>Run the same locked evaluation pack before accepting a prompt, retrieval, model, or workflow change.</p>
        </div>
        <div className="page-header__status">
          <div className="page-status-badges">
            <StatusBadge tone="neutral">{separateFixture ? "SEPARATE SYNTHETIC BASELINE" : `APPROVED BASELINE · CANDIDATE ${displayedCandidateId}`}</StatusBadge>
            <StatusBadge tone="recorded">RECORDED REGRESSION</StatusBadge>
          </div>
          <span>eval-pack-01 · proposed change {displayedCandidateId} v2</span>
        </div>
      </div>

      <section className="block-verdict" aria-labelledby="block-title" role="status">
        <div className="block-verdict__icon" aria-hidden="true"><Prohibit size={30} weight="bold" /></div>
        <div className="block-verdict__copy">
          <span className="section-kicker">CHANGE APPROVAL VERDICT</span>
          <div className="block-title-row">
            <h2 id="block-title">BLOCK</h2>
            <span className="recorded-source-label">RUN SOURCE · RECORDED REGRESSION</span>
          </div>
          <p>Change approval blocked. Baseline v1 remains active.</p>
          <small>This workspace has not deployed, rolled back, or changed any external production system.</small>
          <small>{separateFixture
            ? "This regression frame uses a separate synthetic baseline fixture."
            : `This regression frame continues the approved Candidate ${displayedCandidateId} v1 decision record.`}</small>
        </div>
        <div className="verdict-rule">
          <span>Locked rule</span>
          <strong>Any new hard-gate failure blocks approval.</strong>
        </div>
      </section>

      <section className="section-panel regression-failure" aria-labelledby="new-failure-title">
        <div className="section-heading section-heading--split">
          <div>
            <span className="section-kicker"><ShieldWarning aria-hidden="true" size={14} weight="bold" /> FIRST NEW FAILURE</span>
            <h2 id="new-failure-title">Active policy coverage failed in H-011</h2>
            <p>Proposed v2 removed the active rare-item exception and retrieved a retired final-sale policy.</p>
          </div>
          <StatusBadge tone="fail">CONFIRMED FAIL</StatusBadge>
        </div>
        <div className="failure-callout-grid">
          <div><span>Locked gate</span><strong>Active policy</strong></div>
          <div><span>Case</span><strong>H-011 · Rare-item return</strong></div>
          <div><span>Baseline</span><strong>PASS</strong></div>
          <div><span>Proposed</span><strong>CONFIRMED FAIL</strong></div>
          <button type="button" className="button button--secondary" aria-label="Open regression evidence for H-011" onClick={() => onOpenEvidence(evidenceId)}>
            Open case Evidence <ArrowRight aria-hidden="true" size={16} weight="bold" />
          </button>
        </div>
      </section>

      <section className="section-panel" aria-labelledby="configuration-diff-title">
        <div className="section-heading">
          <span className="section-kicker"><ArrowsLeftRight aria-hidden="true" size={14} weight="bold" /> CONTROLLED COMPARISON</span>
          <h2 id="configuration-diff-title">Baseline v1 vs proposed v2</h2>
          <p>The comparison uses the same candidate, evaluation pack, thresholds, and measurement boundary.</p>
        </div>
        <div className="baseline-comparison">
          <article className="baseline-column">
            <div className="baseline-column__header">
              <div><span className="eyebrow">APPROVED CONFIGURATION</span><h3>Baseline v1</h3></div>
              <StatusBadge tone="baseline">ACTIVE BASELINE</StatusBadge>
            </div>
            <ComparisonRows variant="baseline" candidate={baselineCandidate} />
          </article>
          <div className="comparison-divider" aria-hidden="true"><ArrowsLeftRight size={22} /></div>
          <article className="baseline-column baseline-column--blocked">
            <div className="baseline-column__header">
              <div><span className="eyebrow">PROPOSED CONFIGURATION</span><h3>Proposed v2</h3></div>
              <StatusBadge tone="block">CHANGE BLOCKED</StatusBadge>
            </div>
            <ComparisonRows variant="proposed" candidate={baselineCandidate} />
          </article>
        </div>
      </section>

      <section className="section-panel" aria-labelledby="answer-diff-title">
        <div className="section-heading section-heading--split">
          <div>
            <span className="section-kicker"><Database aria-hidden="true" size={14} weight="bold" /> EVIDENCE DIFF</span>
            <h2 id="answer-diff-title">Answer and citation change</h2>
            <p>The new failure is readable without relying on red or strikethrough alone.</p>
          </div>
          <button className="icon-text-button" type="button" onClick={() => onOpenEvidence(evidenceId)}>Full regression Evidence <ArrowRight aria-hidden="true" /></button>
        </div>
        <div className="inline-diff">
          <div className="diff-answer diff-answer--baseline">
            <span className="diff-label diff-label--baseline">Baseline</span>
            <p>This item is covered by the current rare-item exception. I will route the request for manual review under <mark>POL-RET-7.3</mark>.</p>
          </div>
          <div className="diff-answer diff-answer--failed">
            <span className="diff-label diff-label--failed">Failed</span>
            <p>This item cannot be returned because limited-release items are final sale under <mark>POL-RET-5.1</mark>.</p>
          </div>
          <dl className="diff-facts">
            <div><dt>Removed</dt><dd>Active exception · POL-RET-7.3</dd></div>
            <div><dt>Added</dt><dd>Retired final-sale section · POL-RET-5.1</dd></div>
            <div><dt>Changed</dt><dd>Manual review → categorical denial</dd></div>
            <div><dt>Failed</dt><dd>Active policy and citation validity gates</dd></div>
          </dl>
        </div>
      </section>

      <section className="continuity-strip" aria-label="Evaluation pack continuity">
        <div className="continuity-strip__icon"><LockKey aria-hidden="true" size={22} weight="duotone" /></div>
        <div>
          <span className="section-kicker">FROM DECISION TO CONTINUOUS CONTROL</span>
          <h2>One challenge becomes decision evidence today and a regression baseline tomorrow.</h2>
          <p>Reuse the same evaluation pack for procurement evidence and continuous regression checks.</p>
        </div>
        <span className="continuity-path">CHALLENGE <ArrowRight aria-hidden="true" /> DECISION <ArrowRight aria-hidden="true" /> BASELINE</span>
      </section>
    </div>
  );
}

function ComparisonRows({ variant, candidate }: { variant: "baseline" | "proposed"; candidate: CandidateResult }) {
  const baseline = variant === "baseline";
  const rows = [
    ["Candidate configuration", `${candidate.name} · ${candidate.shortName.toLowerCase()}`],
    ["Policy index", baseline ? "support-policy · 8c21…dd74" : "support-policy · 4fe0…102b"],
    ["Hard gates", baseline ? "4 / 4 PASS" : "2 new failures"],
    ["Decision basis", baseline
      ? candidate.id === "C"
        ? "Full policy coverage prioritized; added tool complexity accepted"
        : "Least complex sufficient configuration"
      : "Same architecture; altered index content"],
    ["Mean runtime cost", `${formatUsd(baseline ? candidate.cost : candidate.cost + 0.0004)} / ticket`],
    ["Median / worst latency", baseline
      ? `${formatDecimal(candidate.medianLatency, 1)} / ${formatDecimal(candidate.worstLatency, 1)} s`
      : `${formatDecimal(candidate.medianLatency + 0.2, 1)} / ${formatDecimal(candidate.worstLatency + 0.3, 1)} s`],
  ];
  return <dl className="comparison-rows">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

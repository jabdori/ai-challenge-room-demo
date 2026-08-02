import { useState } from "react";
import {
  ArrowRight,
  CheckCircle,
  FileText,
  LockKey,
  MagicWand,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react";
import { StatusBadge } from "../../components/StatusBadge";

export interface DefineSourceItem {
  readonly source_id: string;
  readonly source_type: string;
  readonly title: string;
  readonly content_sha256: string;
  readonly synthetic: true;
}

export interface LockedChallengeView {
  readonly challenge_id: string;
  readonly challenge_version: string;
  readonly state: "LOCKED";
  readonly source_hash: string;
  readonly locked_at: string;
  readonly approved_by: string;
  readonly approved_contract_hash: string;
  readonly task_contract: {
    readonly decision: string;
    readonly input_contract: readonly string[];
    readonly output_contract: readonly string[];
    readonly allowed_source_ids: readonly string[];
    readonly operating_constraints: readonly string[];
  };
  readonly constraints: readonly {
    readonly constraint_id: string;
    readonly text: string;
  }[];
  readonly prohibited_actions: readonly {
    readonly prohibition_id: string;
    readonly text: string;
  }[];
  readonly source_manifest: {
    readonly manifest_version: string;
    readonly sources: readonly DefineSourceItem[];
  };
  readonly evaluation_criteria: readonly {
    readonly criterion_id: string;
    readonly description: string;
    readonly evidence_required: readonly string[];
  }[];
  readonly hard_gates: readonly {
    readonly gate_id: string;
    readonly failure_condition: string;
    readonly required_evidence: readonly string[];
  }[];
  readonly sufficiency: {
    readonly critical_failures: { readonly maximum: number; readonly total_cases: number };
    readonly valid_runs: { readonly minimum: number; readonly total_runs: number };
    readonly repeat_stability: { readonly minimum_stable: number; readonly total_cases: number };
    readonly open_reviews: { readonly maximum: number };
    readonly mean_runtime_cost_usd: { readonly maximum: number };
    readonly latency_ms: { readonly median_maximum: number; readonly worst_maximum: number };
  };
}

export interface DefineBusinessBriefView {
  readonly title: string;
  readonly decision: string;
  readonly workflow: string;
  readonly intended_users: readonly string[];
  readonly locale: "en-US";
}

export interface DefineConstraintView {
  readonly constraint_id: string;
  readonly text: string;
}

export interface DefineProhibitedActionView {
  readonly prohibition_id: string;
  readonly text: string;
}

export interface DefineTaskContractSuggestionView {
  readonly decision: string;
  readonly input_contract: readonly string[];
  readonly output_contract: readonly string[];
  readonly allowed_source_ids: readonly string[];
  readonly operating_constraints: readonly string[];
}

export interface DefineCriterionSuggestionView {
  readonly criterion_id: string;
  readonly description: string;
  readonly evidence_required: readonly string[];
}

export interface DefineHardGateSuggestionView {
  readonly gate_id: string;
  readonly failure_condition: string;
  readonly required_evidence: readonly string[];
}

export interface DefineSuggestionSummaryView {
  readonly artifact_hash: string;
  readonly artifact_kind: "DEFINE_SUGGESTION";
  readonly authority: "ADVISORY_ONLY";
  readonly task_contract: DefineTaskContractSuggestionView;
  readonly evaluation_criteria: readonly DefineCriterionSuggestionView[];
  readonly hard_gates: readonly DefineHardGateSuggestionView[];
  readonly limitations: readonly string[];
}

interface DefineLifecycleBaseView {
  readonly challenge_id: string;
  readonly challenge_version: string;
  readonly source_hash: string;
  readonly title: string;
  readonly business_brief: DefineBusinessBriefView;
  readonly constraints: readonly DefineConstraintView[];
  readonly prohibited_actions: readonly DefineProhibitedActionView[];
  readonly source_manifest: {
    readonly manifest_version: "define-source-manifest-v1";
    readonly sources: readonly DefineSourceItem[];
  };
}

export interface DefineDraftView extends DefineLifecycleBaseView {
  readonly state: "DRAFT";
  readonly authority: "NONE";
  readonly define_status: "NOT_STARTED" | "STRUCTURING" | "INVALID";
  readonly suggestion_summary: null;
  readonly approved_contract_hash: null;
}

export interface DefineProposedView extends DefineLifecycleBaseView {
  readonly state: "PROPOSED";
  readonly authority: "ADVISORY_ONLY";
  readonly define_status: "SUGGESTION_READY";
  readonly suggestion_summary: DefineSuggestionSummaryView;
  readonly approved_contract_hash: string;
}

export type DefineChallengeView =
  | DefineDraftView
  | DefineProposedView
  | LockedChallengeView;

export interface DefineStructureRequest {
  readonly actorLabel: string;
}

export interface DefineApprovalRequest {
  readonly actorLabel: string;
  readonly decision: "APPROVE_EXACT_CONTRACT";
  readonly defineStructuringArtifactHash: string;
  readonly approvedContractHash: string;
}

const EXACT_APPROVAL_PHRASE = "APPROVE EXACT CONTRACT";

function shortHash(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function ContractList({ items }: { readonly items: readonly string[] }) {
  return (
    <ul className="define-list">
      {items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  );
}

function DefineDraftStage({
  challenge,
  onStructure,
  mutationPending,
  mobileReadOnly,
}: {
  readonly challenge: DefineDraftView;
  readonly onStructure?: (request: DefineStructureRequest) => void;
  readonly mutationPending: boolean;
  readonly mobileReadOnly: boolean;
}) {
  const [actorLabel, setActorLabel] = useState("");
  const structuring = mutationPending || challenge.define_status === "STRUCTURING";
  const canStructure = onStructure !== undefined
    && !mobileReadOnly
    && !structuring
    && actorLabel.trim().length > 0;

  return (
    <div className="page-stack define-stage define-lifecycle">
      <header className="page-header">
        <div>
          <span className="page-index">01 / DEFINE · PRIVATE AI CHALLENGE</span>
          <h1>Structure the work before comparing AI systems.</h1>
          <p>
            Review the synthetic business brief, constraints, and fatal
            boundaries before asking GPT-5.6 for an advisory contract draft.
          </p>
        </div>
        <div className="page-header__status">
          <div className="page-status-badges">
            <StatusBadge
              tone={challenge.define_status === "INVALID" ? "fail" : "neutral"}
              compact
            >
              DRAFT
            </StatusBadge>
            <StatusBadge tone="recorded" compact>SYNTHETIC DATA</StatusBadge>
          </div>
          <span>{challenge.challenge_version} · {shortHash(challenge.source_hash)}</span>
        </div>
      </header>

      <section className="define-draft-grid" aria-label="Synthetic Challenge draft">
        <article className="section-panel define-card define-card--primary">
          <div className="section-heading">
            <span className="section-kicker"><FileText size={14} /> BUSINESS TASK</span>
            <h2>{challenge.business_brief.title}</h2>
            <p>{challenge.business_brief.workflow}</p>
          </div>
          <div className="define-card__body define-brief-ledger">
            <div>
              <span>Decision to make</span>
              <strong>{challenge.business_brief.decision}</strong>
            </div>
            <div>
              <span>Intended users</span>
              <strong>{challenge.business_brief.intended_users.join(" · ")}</strong>
            </div>
            <div>
              <span>Evidence boundary</span>
              <strong>{challenge.source_manifest.sources.length} approved synthetic source families</strong>
            </div>
          </div>
        </article>

        <article className="section-panel define-card">
          <div className="section-heading">
            <span className="section-kicker"><ShieldCheck size={14} /> CONSTRAINTS</span>
            <h2>Conditions every candidate must respect</h2>
          </div>
          <div className="define-card__body">
            <ul className="define-boundary-list">
              {challenge.constraints.map((constraint) => (
                <li key={constraint.constraint_id}>
                  <span>{constraint.constraint_id}</span>
                  <strong>{constraint.text}</strong>
                </li>
              ))}
            </ul>
          </div>
        </article>

        <article className="section-panel define-card">
          <div className="section-heading">
            <span className="section-kicker"><Warning size={14} /> FATAL BOUNDARIES</span>
            <h2>Prohibited actions become hard-gate inputs</h2>
          </div>
          <div className="define-card__body">
            <ul className="define-boundary-list define-boundary-list--fatal">
              {challenge.prohibited_actions.map((prohibition) => (
                <li key={prohibition.prohibition_id}>
                  <span>{prohibition.prohibition_id}</span>
                  <strong>{prohibition.text}</strong>
                </li>
              ))}
            </ul>
          </div>
        </article>
      </section>

      <section className="section-panel define-action-panel">
        <div className="section-heading section-heading--split">
          <div>
            <span className="section-kicker"><MagicWand size={14} /> ADVISORY STRUCTURING</span>
            <h2>Draft the evaluation contract with GPT-5.6</h2>
            <p>
              The response remains advisory. It cannot lock the Challenge,
              approve a candidate, or create a Benchmark.
            </p>
          </div>
          <StatusBadge tone={structuring ? "live" : "neutral"} compact>
            {structuring ? "STRUCTURING" : challenge.define_status.replaceAll("_", " ")}
          </StatusBadge>
        </div>
        <form
          className="lifecycle-action-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canStructure) return;
            onStructure({ actorLabel: actorLabel.trim() });
          }}
        >
          <label>
            <span>Define decision owner</span>
            <input
              aria-label="Define decision owner"
              autoComplete="off"
              disabled={mobileReadOnly || structuring}
              onChange={(event) => setActorLabel(event.target.value)}
              value={actorLabel}
            />
          </label>
          <button
            className="button button--primary"
            disabled={!canStructure}
            type="submit"
          >
            {structuring ? "Structuring…" : "Structure with GPT-5.6"}
            {!structuring && <ArrowRight aria-hidden="true" size={16} weight="bold" />}
          </button>
        </form>
        {mobileReadOnly && (
          <p className="lifecycle-mobile-boundary">
            Changes are disabled on mobile. Review this draft here and continue
            from a desktop workspace.
          </p>
        )}
      </section>
    </div>
  );
}

function DefineProposedStage({
  challenge,
  onApprove,
  mutationPending,
  mobileReadOnly,
}: {
  readonly challenge: DefineProposedView;
  readonly onApprove?: (request: DefineApprovalRequest) => void;
  readonly mutationPending: boolean;
  readonly mobileReadOnly: boolean;
}) {
  const [actorLabel, setActorLabel] = useState("");
  const [approvalPhrase, setApprovalPhrase] = useState("");
  const suggestion = challenge.suggestion_summary;
  const canApprove = onApprove !== undefined
    && !mobileReadOnly
    && !mutationPending
    && actorLabel.trim().length > 0
    && approvalPhrase === EXACT_APPROVAL_PHRASE;

  return (
    <div className="page-stack define-stage define-lifecycle">
      <header className="page-header">
        <div>
          <span className="page-index">01 / DEFINE · HUMAN APPROVAL BOUNDARY</span>
          <h1>Review the advisory draft before locking the contract.</h1>
          <p>
            GPT-5.6 proposed a structure. A named human owner must review the
            exact task, fatal failures, and contract hash before v1 can be locked.
          </p>
        </div>
        <div className="page-header__status">
          <div className="page-status-badges">
            <StatusBadge tone="review" compact>PROPOSED</StatusBadge>
            <StatusBadge tone="review" compact>ADVISORY ONLY</StatusBadge>
          </div>
          <span>{challenge.challenge_version} · {shortHash(challenge.source_hash)}</span>
        </div>
      </header>

      <section className="define-advisory-banner" aria-label="Advisory authority boundary">
        <MagicWand size={22} weight="fill" />
        <div>
          <strong>GPT suggestion — ADVISORY ONLY</strong>
          <span>
            This suggestion cannot approve or lock the Challenge. The human
            owner approves the exact contract hash shown below.
          </span>
        </div>
      </section>

      <section className="define-proposal-grid">
        <article className="section-panel define-card">
          <div className="section-heading">
            <span className="section-kicker">ORIGINAL BUSINESS BRIEF</span>
            <h2>{challenge.business_brief.title}</h2>
            <p>{challenge.business_brief.workflow}</p>
          </div>
          <div className="define-card__body define-brief-ledger">
            <div>
              <span>Constraints</span>
              <strong>{challenge.constraints.length} locked inputs</strong>
            </div>
            <div>
              <span>Prohibited actions</span>
              <strong>{challenge.prohibited_actions.length} fatal boundaries</strong>
            </div>
            <div>
              <span>Suggestion evidence</span>
              <strong data-numeric="true">{shortHash(suggestion.artifact_hash)}</strong>
            </div>
          </div>
        </article>

        <article className="section-panel define-card define-card--primary">
          <div className="section-heading">
            <span className="section-kicker"><LockKey size={14} /> EXACT CONTRACT PROPOSED FOR LOCK</span>
            <h2>{suggestion.task_contract.decision}</h2>
            <p>These values, not the model prose, define the approval target.</p>
          </div>
          <div className="define-card__body define-contract-sections">
            <section>
              <h3>Inputs</h3>
              <ContractList items={suggestion.task_contract.input_contract} />
            </section>
            <section>
              <h3>Required outputs</h3>
              <ContractList items={suggestion.task_contract.output_contract} />
            </section>
            <section>
              <h3>Operating constraints</h3>
              <ContractList items={suggestion.task_contract.operating_constraints} />
            </section>
          </div>
        </article>
      </section>

      <section className="section-panel" aria-labelledby="proposed-gates-title">
        <div className="section-heading section-heading--split">
          <div>
            <span className="section-kicker"><ShieldCheck size={14} /> HARD GATES BEFORE AVERAGES</span>
            <h2 id="proposed-gates-title">Four fatal failure conditions</h2>
            <p>
              {suggestion.evaluation_criteria.length} separate criteria remain
              outside these non-compensable gates.
            </p>
          </div>
          <span className="locked-rule">
            Contract {shortHash(challenge.approved_contract_hash)}
          </span>
        </div>
        <ol className="hard-gate-list define-proposed-gates">
          {suggestion.hard_gates.map((gate) => (
            <li key={gate.gate_id}>
              <span data-numeric="true">{gate.gate_id}</span>
              <strong>{gate.failure_condition}</strong>
              <small>{gate.required_evidence.join(" · ")}</small>
            </li>
          ))}
        </ol>
        <div className="define-limitations">
          <strong>Known limits</strong>
          <ContractList items={suggestion.limitations} />
        </div>
      </section>

      <section className="section-panel define-approval-panel">
        <div className="section-heading">
          <span className="section-kicker"><LockKey size={14} /> EXPLICIT HUMAN APPROVAL</span>
          <h2>Approve this exact contract and lock Challenge v1</h2>
          <p>
            Enter the accountable owner and the exact phrase. Any later contract
            change requires a new Challenge version and Benchmark.
          </p>
        </div>
        <form
          className="lifecycle-action-form lifecycle-action-form--approval"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canApprove) return;
            onApprove({
              actorLabel: actorLabel.trim(),
              decision: "APPROVE_EXACT_CONTRACT",
              defineStructuringArtifactHash: suggestion.artifact_hash,
              approvedContractHash: challenge.approved_contract_hash,
            });
          }}
        >
          <label>
            <span>Challenge approval owner</span>
            <input
              aria-label="Challenge approval owner"
              autoComplete="off"
              disabled={mobileReadOnly || mutationPending}
              onChange={(event) => setActorLabel(event.target.value)}
              value={actorLabel}
            />
          </label>
          <label>
            <span>Type {EXACT_APPROVAL_PHRASE}</span>
            <input
              aria-label="Exact approval phrase"
              autoComplete="off"
              disabled={mobileReadOnly || mutationPending}
              onChange={(event) => setApprovalPhrase(event.target.value)}
              value={approvalPhrase}
            />
          </label>
          <button
            className="button button--primary"
            disabled={!canApprove}
            type="submit"
          >
            {mutationPending ? "Locking exact contract…" : "Approve exact contract and lock v1"}
            {!mutationPending && <ArrowRight aria-hidden="true" size={16} weight="bold" />}
          </button>
        </form>
        {mobileReadOnly && (
          <p className="lifecycle-mobile-boundary">
            Changes are disabled on mobile. Exact contract approval requires
            the desktop workspace.
          </p>
        )}
      </section>
    </div>
  );
}

export function DefineStage({
  challenge,
  onStructure,
  onApprove,
  mutationPending = false,
  mobileReadOnly = false,
}: {
  readonly challenge: DefineChallengeView;
  readonly onStructure?: (request: DefineStructureRequest) => void;
  readonly onApprove?: (request: DefineApprovalRequest) => void;
  readonly mutationPending?: boolean;
  readonly mobileReadOnly?: boolean;
}) {
  if (challenge.state === "DRAFT") {
    return (
      <DefineDraftStage
        challenge={challenge}
        mobileReadOnly={mobileReadOnly}
        mutationPending={mutationPending}
        onStructure={onStructure}
      />
    );
  }
  if (challenge.state === "PROPOSED") {
    return (
      <DefineProposedStage
        challenge={challenge}
        mobileReadOnly={mobileReadOnly}
        mutationPending={mutationPending}
        onApprove={onApprove}
      />
    );
  }

  return (
    <div className="page-stack define-stage">
      <header className="page-header">
        <div>
          <span className="page-index">01 / DEFINE · PRIVATE AI CHALLENGE</span>
          <h1>Turn a real business task into a private AI challenge.</h1>
          <p>
            The work contract, fatal failures, evidence rules, and operating limits are
            locked before any candidate sees the hidden Benchmark.
          </p>
        </div>
        <div className="page-header__status">
          <div className="page-status-badges">
            <StatusBadge tone="pass" compact>LOCKED</StatusBadge>
            <StatusBadge tone="recorded" compact>SYNTHETIC DATA</StatusBadge>
          </div>
          <span>{challenge.challenge_version} · {shortHash(challenge.source_hash)}</span>
        </div>
      </header>

      <section className="define-grid" aria-label="Locked Challenge definition">
        <article className="section-panel define-card">
          <div className="section-heading">
            <span className="section-kicker"><FileText size={14} /> SOURCE</span>
            <h2>Approved synthetic evidence</h2>
            <p>Only these source families may support candidate outputs.</p>
          </div>
          <div className="define-card__body">
            <dl className="source-ledger">
              {challenge.source_manifest.sources.map((source) => (
                <div key={source.source_id}>
                  <dt>{source.title}</dt>
                  <dd>{source.source_type.replaceAll("_", " ")}</dd>
                  <dd data-numeric="true">{shortHash(source.content_sha256)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </article>

        <article className="section-panel define-card define-card--primary">
          <div className="section-heading">
            <span className="section-kicker"><LockKey size={14} /> TASK CONTRACT</span>
            <h2>{challenge.task_contract.decision}</h2>
            <p>Human-approved and immutable for this Benchmark identity.</p>
          </div>
          <div className="define-card__body define-contract-sections">
            <section>
              <h3>Inputs</h3>
              <ContractList items={challenge.task_contract.input_contract} />
            </section>
            <section>
              <h3>Required outputs</h3>
              <ContractList items={challenge.task_contract.output_contract} />
            </section>
            <section>
              <h3>Operating constraints</h3>
              <ContractList items={challenge.task_contract.operating_constraints} />
            </section>
          </div>
        </article>

        <article className="section-panel define-card">
          <div className="section-heading">
            <span className="section-kicker"><ShieldCheck size={14} /> FATAL FAILURES</span>
            <h2>Hard gates before averages</h2>
            <p>A confirmed violation cannot be offset by quality, cost, or speed.</p>
          </div>
          <div className="define-card__body">
            <ol className="hard-gate-list">
              {challenge.hard_gates.map((gate) => (
                <li key={gate.gate_id}>
                  <span data-numeric="true">{gate.gate_id}</span>
                  <strong>{gate.failure_condition}</strong>
                  <small>{gate.required_evidence.join(" · ")}</small>
                </li>
              ))}
            </ol>
          </div>
        </article>
      </section>

      <section className="section-panel" aria-labelledby="define-sufficiency-title">
        <div className="section-heading section-heading--split">
          <div>
            <span className="section-kicker">SUFFICIENCY CONTRACT</span>
            <h2 id="define-sufficiency-title">Minimum evidence required to make a decision</h2>
            <p>Separate locked thresholds; no composite score or automatic winner.</p>
          </div>
          <span className="locked-rule"><CheckCircle size={16} weight="fill" /> Human approved by {challenge.approved_by}</span>
        </div>
        <div className="table-scroll">
          <table className="data-table define-threshold-table">
            <thead>
              <tr><th>Boundary</th><th>Locked requirement</th><th>Decision effect</th></tr>
            </thead>
            <tbody>
              <tr><th>Critical failures</th><td>0 / {challenge.sufficiency.critical_failures.total_cases}</td><td>Any confirmed failure excludes the candidate</td></tr>
              <tr><th>Valid executions</th><td>{challenge.sufficiency.valid_runs.minimum} / {challenge.sufficiency.valid_runs.total_runs}</td><td>Incomplete evidence cannot be approved</td></tr>
              <tr><th>Repeat stability</th><td>{challenge.sufficiency.repeat_stability.minimum_stable} / {challenge.sufficiency.repeat_stability.total_cases}</td><td>Both fixed runs must agree</td></tr>
              <tr><th>Open reviews</th><td>≤ {challenge.sufficiency.open_reviews.maximum}</td><td>Human review must close first</td></tr>
              <tr><th>Runtime cost</th><td>≤ ${challenge.sufficiency.mean_runtime_cost_usd.maximum.toFixed(3)} / ticket</td><td>Shown separately from quality</td></tr>
              <tr><th>Latency</th><td>Median ≤ {challenge.sufficiency.latency_ms.median_maximum.toLocaleString()} ms · worst ≤ {challenge.sufficiency.latency_ms.worst_maximum.toLocaleString()} ms</td><td>Operational boundary</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <footer className="define-lock-receipt" aria-label="Challenge lock receipt">
        <LockKey size={18} weight="fill" />
        <div>
          <strong>Challenge contract locked</strong>
          <span>{new Date(challenge.locked_at).toLocaleString("en-US", { timeZone: "UTC" })} UTC · contract {shortHash(challenge.approved_contract_hash)}</span>
        </div>
        <span>Changing this contract requires a new Challenge version and Benchmark.</span>
      </footer>
    </div>
  );
}

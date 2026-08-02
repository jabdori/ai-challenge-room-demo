"use client";

import { useMemo, useState } from "react";

type Stage = "define" | "compare" | "review" | "decide" | "memo" | "monitor";
type CandidateId = "A" | "B" | "C";
type ReviewDecision = "PASS" | "CONFIRMED FAIL";

const stages: { id: Stage; label: string }[] = [
  { id: "define", label: "Define" },
  { id: "compare", label: "Compare" },
  { id: "review", label: "Review" },
  { id: "decide", label: "Decide" },
  { id: "memo", label: "Memo" },
  { id: "monitor", label: "Monitor" },
];

const candidates = [
  {
    id: "A" as const,
    blind: "X",
    name: "Single LLM",
    tier: "T1",
    access: "Task context only",
    gate: "PASS",
    cost: "$0.003990",
    latency: "1.74 s",
    quality: "Sufficient",
    calls: "1 model",
    reply: "I’m sorry, but because order ORD-1042 has already shipped, it can’t be cancelled or refunded now. Once it’s delivered, you may request a return.",
    citation: "CANCEL-2026 §2.2",
  },
  {
    id: "B" as const,
    blind: "Y",
    name: "Retrieval RAG",
    tier: "T2",
    access: "Locked policy search",
    gate: "PASS",
    cost: "$0.005586",
    latency: "3.30 s",
    quality: "Sufficient",
    calls: "1 model · 1 retrieval",
    reply: "I’m sorry, but order ORD-1042 has already shipped and can’t be cancelled or refunded now. Once it is delivered, you may request a return.",
    citation: "CANCEL-2026 §2.2",
  },
  {
    id: "C" as const,
    blind: "Z",
    name: "Read-only tool agent",
    tier: "T3",
    access: "Policy search + order lookup",
    gate: "PASS",
    cost: "$0.011151",
    latency: "5.04 s",
    quality: "Sufficient",
    calls: "3 model · 1 retrieval · 2 tools",
    reply: "I’m sorry, but shipped orders can’t be cancelled. Once it’s delivered, you may request a return.",
    citation: "CANCEL-2026 §2.2",
  },
];

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "pass" | "warn" | "block" }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

function StaticNotice() {
  return (
    <div className="static-notice" role="note">
      <span className="static-notice__dot" aria-hidden="true" />
      <strong>STATIC RECORDED DEMO</strong>
      <span>No live AI calls · synthetic data only · nothing is deployed or purchased</span>
    </div>
  );
}

export default function Home() {
  const [stage, setStage] = useState<Stage>("define");
  const [evidence, setEvidence] = useState<CandidateId | null>(null);
  const [reviews, setReviews] = useState<Partial<Record<string, ReviewDecision>>>({});
  const [reviewRationale, setReviewRationale] = useState("");
  const [selected, setSelected] = useState<CandidateId | null>(null);
  const [selectionRationale, setSelectionRationale] = useState("");

  const stageIndex = stages.findIndex((item) => item.id === stage);
  const selectedCandidate = useMemo(
    () => candidates.find((candidate) => candidate.id === selected) ?? null,
    [selected],
  );
  const reviewComplete = candidates.every((candidate) => reviews[candidate.blind])
    && reviewRationale.trim().length > 0;

  const go = (next: Stage) => {
    setStage(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const reset = () => {
    setStage("define");
    setEvidence(null);
    setReviews({});
    setReviewRationale("");
    setSelected(null);
    setSelectionRationale("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="AI Challenge Room home">
          <span className="brand__mark">AC</span>
          <span><strong>AI Challenge Room</strong><small>Evidence-first AI selection</small></span>
        </a>
        <button className="text-button" type="button" onClick={reset}>Restart static demo</button>
      </header>

      <StaticNotice />

      <div className="workspace" id="top">
        <aside className="rail" aria-label="Demo stages">
          <p className="eyebrow">ONE SYNTHETIC CHALLENGE</p>
          <nav>
            {stages.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={stage === item.id ? "rail-step is-active" : "rail-step"}
                disabled={index > stageIndex}
                onClick={() => go(item.id)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                {item.label}
                {index < stageIndex ? <b aria-label="completed">✓</b> : null}
              </button>
            ))}
          </nav>
          <div className="rail-boundary">
            <strong>Evidence boundary</strong>
            <p>Recorded examples demonstrate the workflow. They are not a benchmark or a production approval.</p>
          </div>
        </aside>

        <section className="content">
          {stage === "define" ? (
            <div className="page-stack">
              <header className="page-heading">
                <div><p className="eyebrow">01 / DEFINE</p><h1>Start with the job, not the model.</h1></div>
                <Badge>LOCKED</Badge>
              </header>
              <p className="lead">A single synthetic customer-support task is evaluated under one policy, one failure definition, and one measurement envelope.</p>

              <section className="panel challenge-card">
                <div className="panel-heading"><div><p className="eyebrow">ACTUAL WORK INPUT</p><h2>Shipped-order cancellation request</h2></div><Badge>C-001</Badge></div>
                <dl className="fact-list">
                  <div><dt>Ticket</dt><dd>“My order ORD-1042 has already shipped, but I no longer want it. Please cancel the order and refund me now.”</dd></div>
                  <div><dt>Fatal failure</dt><dd>Wrong action, retired-policy citation, missing active citation, or unsupported completion promise.</dd></div>
                  <div><dt>Decision rule</dt><dd>Hard gate first; then human review; then choose the simplest sufficient configuration.</dd></div>
                  <div><dt>External action</dt><dd>No purchase, contract, deployment, rollback, or customer contact.</dd></div>
                </dl>
              </section>

              <section className="candidate-preview" aria-label="Candidate configurations">
                {candidates.map((candidate) => (
                  <article key={candidate.id}>
                    <span>{candidate.id}</span><div><strong>{candidate.name}</strong><small>{candidate.access}</small></div><Badge>{candidate.tier}</Badge>
                  </article>
                ))}
              </section>

              <div className="action-row"><button className="primary-button" type="button" onClick={() => go("compare")}>Load recorded comparison <span>→</span></button></div>
            </div>
          ) : null}

          {stage === "compare" ? (
            <div className="page-stack">
              <header className="page-heading">
                <div><p className="eyebrow">02 / COMPARE</p><h1>Critical failures before averages.</h1></div>
                <Badge tone="pass">3 / 3 GATE PASS</Badge>
              </header>
              <p className="lead">These measurements are recorded synthetic evidence from one prior run per candidate. Repetition stability is not measured.</p>

              <section className="gate-strip">
                <div><span className="gate-icon">✓</span><p><strong>Deterministic policy gate</strong><small>No wrong action, retired citation, or unsupported promise detected.</small></p></div>
                <Badge tone="pass">AUTHORITATIVE PASS</Badge>
              </section>

              <div className="candidate-grid">
                {candidates.map((candidate) => (
                  <article className="candidate-card" key={candidate.id}>
                    <header><span className="candidate-letter">{candidate.id}</span><div><h2>{candidate.name}</h2><p>{candidate.access}</p></div><Badge tone="pass">{candidate.gate}</Badge></header>
                    <dl>
                      <div><dt>Observed quality</dt><dd>{candidate.quality}</dd></div>
                      <div><dt>Runtime cost</dt><dd>{candidate.cost}</dd></div>
                      <div><dt>Latency</dt><dd>{candidate.latency}</dd></div>
                      <div><dt>Complexity</dt><dd>{candidate.tier}</dd></div>
                    </dl>
                    <p className="single-run">Single run · stability not measured</p>
                    <button className="secondary-button" type="button" onClick={() => setEvidence(candidate.id)}>Inspect evidence</button>
                  </article>
                ))}
              </div>

              <section className="panel tradeoff-panel">
                <div className="panel-heading"><div><p className="eyebrow">QUALITY–COST TRADE-OFF</p><h2>Complexity must earn its place.</h2></div><span className="quiet">No composite score</span></div>
                <div className="tradeoff-bars">
                  {candidates.map((candidate, index) => (
                    <div key={candidate.id}><span>{candidate.id}</span><div><i style={{ width: `${42 + index * 24}%` }} /></div><strong>{candidate.cost}</strong><small>{candidate.tier}</small></div>
                  ))}
                </div>
                <p className="method-note">Candidate A meets the locked one-ticket requirement with the lowest complexity and observed cost. This is a bounded demo result, not a general model ranking.</p>
              </section>

              <section className="panel auxiliary-panel">
                <div className="panel-heading"><div><p className="eyebrow">RECORDED GPT-5.6 AUXILIARY SIGNALS</p><h2>Blinded qualitative risk check</h2></div><Badge>ADVISORY ONLY</Badge></div>
                <p className="method-note">The original system sent X/Y/Z evidence to GPT-5.6. This public demo only displays the recorded example; it makes no model call.</p>
                <div className="risk-grid">
                  {candidates.map((candidate) => <article key={candidate.blind}><strong>Candidate {candidate.blind}</strong><Badge tone="pass">NO ADDITIONAL RISK</Badge><p>No qualitative risk beyond the deterministic evidence was recorded.</p></article>)}
                </div>
              </section>

              <div className="action-row"><button className="primary-button" type="button" onClick={() => go("review")}>Open blind human review <span>→</span></button></div>
            </div>
          ) : null}

          {stage === "review" ? (
            <div className="page-stack">
              <header className="page-heading"><div><p className="eyebrow">03 / REVIEW</p><h1>Review the evidence, not the architecture.</h1></div><Badge tone="warn">IDENTITY BLINDED</Badge></header>
              <p className="lead">X/Y/Z labels hide candidate architecture until the human review closes. Recorded GPT-5.6 signals cannot clear or fail a hard gate.</p>
              <div className="review-grid">
                {candidates.map((candidate) => (
                  <article className="review-card" key={candidate.blind}>
                    <header><span className="blind-letter">{candidate.blind}</span><div><strong>Case C-001</strong><small>Deterministic gate · PASS</small></div></header>
                    <blockquote>{candidate.reply}</blockquote>
                    <p><strong>Evidence:</strong> active policy cited; no unsupported completion promise.</p>
                    <fieldset><legend>Human decision</legend>{(["PASS", "CONFIRMED FAIL"] as ReviewDecision[]).map((decision) => <label key={decision}><input type="radio" name={`review-${candidate.blind}`} checked={reviews[candidate.blind] === decision} onChange={() => setReviews((current) => ({ ...current, [candidate.blind]: decision }))} />{decision}</label>)}</fieldset>
                  </article>
                ))}
              </div>
              <label className="field"><span>Human review rationale</span><textarea rows={3} value={reviewRationale} onChange={(event) => setReviewRationale(event.target.value)} placeholder="Explain the evidence used for your judgments." /></label>
              <div className="action-row"><button className="primary-button" type="button" disabled={!reviewComplete} onClick={() => go("decide")}>Reveal candidates and decide <span>→</span></button></div>
            </div>
          ) : null}

          {stage === "decide" ? (
            <div className="page-stack">
              <header className="page-heading"><div><p className="eyebrow">04 / DECIDE</p><h1>The recommendation is not the decision.</h1></div><Badge tone="pass">HUMAN REVIEW COMPLETE</Badge></header>
              <section className="recommendation">
                <span>R</span><div><p className="eyebrow">SYSTEM RECOMMENDATION · ADVISORY</p><h2>Candidate A is the simplest sufficient option for this bounded task.</h2><p>All candidates passed. A used task context only and had the lowest observed cost and latency.</p></div><Badge>A · T1</Badge>
              </section>
              <section className="panel decision-panel">
                <div className="panel-heading"><div><p className="eyebrow">HUMAN SELECTION</p><h2>Choose an eligible candidate.</h2></div><span className="quiet">No option is preselected</span></div>
                <div className="selection-grid">{candidates.map((candidate) => <label className={selected === candidate.id ? "is-selected" : ""} key={candidate.id}><input type="radio" name="selection" checked={selected === candidate.id} onChange={() => setSelected(candidate.id)} /><span>{candidate.id}</span><div><strong>{candidate.name}</strong><small>{candidate.tier} · {candidate.cost}</small></div></label>)}</div>
                <label className="field"><span>Why is this candidate sufficient?</span><textarea rows={3} value={selectionRationale} onChange={(event) => setSelectionRationale(event.target.value)} placeholder="Record the accepted cost, latency, and complexity trade-off." /></label>
              </section>
              <div className="action-row"><button className="primary-button" type="button" disabled={!selected || !selectionRationale.trim()} onClick={() => go("memo")}>Record decision and open Memo <span>→</span></button></div>
            </div>
          ) : null}

          {stage === "memo" && selectedCandidate ? (
            <div className="page-stack">
              <header className="page-heading"><div><p className="eyebrow">05 / DECISION MEMO</p><h1>Evidence packaged for human approval.</h1></div><Badge>RECORDED EXAMPLE</Badge></header>
              <p className="lead">This Memo is assembled locally from a recorded template and your selection. GPT-5.6 is not called in this public demo.</p>
              <section className="memo-sheet">
                <header><div><p className="eyebrow">AI ADOPTION DECISION</p><h2>Select Candidate {selectedCandidate.id} · {selectedCandidate.name}</h2></div><span>DM-001</span></header>
                <dl>
                  <div><dt>Decision</dt><dd>Approve Candidate {selectedCandidate.id} as the provisional baseline for this synthetic one-ticket evaluation.</dd></div>
                  <div><dt>Evidence basis</dt><dd>Deterministic policy gate passed. Human review confirmed the recorded evidence. Observed cost was {selectedCandidate.cost} with {selectedCandidate.latency} latency.</dd></div>
                  <div><dt>Accepted trade-off</dt><dd>{selectionRationale}</dd></div>
                  <div><dt>Limitations</dt><dd>One synthetic case and one recorded run per candidate. Stability, production security, and operational performance were not measured.</dd></div>
                  <div><dt>Next step</dt><dd>Preserve this evidence as the static baseline and test a representative defective change against the same hard gate.</dd></div>
                </dl>
                <footer><span>Human decision owner</span><strong>Portfolio visitor · recorded locally</strong></footer>
              </section>
              <div className="action-row"><button className="primary-button" type="button" onClick={() => go("monitor")}>Confirm baseline and replay defect <span>→</span></button></div>
            </div>
          ) : null}

          {stage === "monitor" && selectedCandidate ? (
            <div className="page-stack">
              <header className="page-heading"><div><p className="eyebrow">06 / MONITOR</p><h1>A new critical failure blocks the change.</h1></div><Badge tone="block">BLOCK</Badge></header>
              <section className="block-alert"><span>!</span><div><p className="eyebrow">DETERMINISTIC REGRESSION</p><h2>Unsupported refund completion promise detected.</h2><p>The recorded auxiliary signal cannot override this new hard-gate failure.</p></div><Badge tone="block">P0-HG-02</Badge></section>
              <div className="diff-grid">
                <section className="panel"><div className="panel-heading"><div><p className="eyebrow">BASELINE V1</p><h2>Candidate {selectedCandidate.id}</h2></div><Badge tone="pass">PASS</Badge></div><blockquote>{selectedCandidate.reply}</blockquote><p className="diff-line diff-line--good">+ Active policy citation · {selectedCandidate.citation}</p></section>
                <section className="panel"><div className="panel-heading"><div><p className="eyebrow">PROPOSED V2 · DEFECT INJECTED</p><h2>Representative change replay</h2></div><Badge tone="block">FAIL</Badge></div><blockquote>“Your order has been cancelled and the refund is complete.”</blockquote><p className="diff-line diff-line--bad">− Unsupported action and completion promise</p></section>
              </div>
              <section className="baseline-kept"><div><p className="eyebrow">CHANGE DECISION</p><h2>Baseline v1 remains active.</h2><p>No external deployment or rollback occurred. This is an evaluation-only decision.</p></div><Badge tone="block">PROPOSED V2 BLOCKED</Badge></section>
              <div className="action-row"><button className="secondary-button" type="button" onClick={reset}>Restart static demo</button><a className="primary-button" href="https://github.com/jabdori/ai-challenge-room-demo">View source on GitHub <span>↗</span></a></div>
            </div>
          ) : null}
        </section>
      </div>

      {evidence ? (
        <div className="drawer-backdrop" role="presentation" onMouseDown={() => setEvidence(null)}>
          <aside className="evidence-drawer" role="dialog" aria-modal="true" aria-labelledby="evidence-title" onMouseDown={(event) => event.stopPropagation()}>
            {(() => {
              const candidate = candidates.find((item) => item.id === evidence)!;
              return <><header><div><p className="eyebrow">RECORDED EVIDENCE</p><h2 id="evidence-title">Candidate {candidate.id} · {candidate.name}</h2></div><button type="button" onClick={() => setEvidence(null)} aria-label="Close evidence">×</button></header><StaticNotice /><section><h3>Candidate output</h3><blockquote>{candidate.reply}</blockquote></section><dl className="evidence-facts"><div><dt>Deterministic gate</dt><dd><Badge tone="pass">PASS</Badge></dd></div><div><dt>Policy evidence</dt><dd>{candidate.citation}</dd></div><div><dt>Observed cost</dt><dd>{candidate.cost}</dd></div><div><dt>Observed latency</dt><dd>{candidate.latency}</dd></div><div><dt>Execution calls</dt><dd>{candidate.calls}</dd></div><div><dt>Stability</dt><dd>Single run · not measured</dd></div></dl><section><h3>Authority note</h3><p>This drawer shows recorded synthetic evidence. No provider, retrieval, or tool request is made by this public demo.</p></section></>;
            })()}
          </aside>
        </div>
      ) : null}
    </main>
  );
}

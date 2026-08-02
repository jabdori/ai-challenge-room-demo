import {
  ArrowRight,
  CheckCircle,
  Eye,
  EyeSlash,
  FileText,
  Prohibit,
  Scales,
  ShieldWarning,
} from "@phosphor-icons/react";
import { useMemo, useRef, useState } from "react";
import { StatusBadge } from "../../components/StatusBadge";
import { RecordedHardGateMatrix } from "../decision/RecordedHardGateMatrix";
import type {
  ActiveBaselineView,
  HumanConfirmedDecisionView,
  RecordedPreconfirmationView,
  RecordedRegressionView,
} from "./contracts";
import "./RecordedWorkflowStages.css";

type CandidateId = "A" | "B" | "C";
type FinalReviewDecision = "PASS" | "CONFIRMED_FAIL";

export interface RecordedReviewConfirmationSubmission {
  readonly reviewId: string;
  readonly actorLabel: string;
  readonly expectedSourceHash: string;
  readonly expectedRecordedBenchmarkPackHash: string;
  readonly expectedAiPreReviewReceiptHash: string;
  readonly expectedProvisionalDecisionMemoHash: string;
  readonly expectedQueueContentHash: string;
  readonly expectedQueueSetOrderHash: string;
  readonly items: readonly {
    readonly itemId: string;
    readonly finalDecision: FinalReviewDecision;
    readonly rationale: string;
    readonly proposalResolution: "ACCEPTED" | "EDITED";
    readonly reviewDurationMs: number;
    readonly editDurationMs: number;
  }[];
}

interface RecordedPreconfirmationStageProps {
  readonly projection: RecordedPreconfirmationView;
  readonly readOnly: boolean;
  /** detail 요청·파싱·현재 queue item 결합을 모두 통과했을 때만 true입니다. */
  readonly onOpenEvidence: (evidenceId: string) => Promise<boolean>;
  readonly onConfirm: (
    submission: RecordedReviewConfirmationSubmission,
  ) => void;
  readonly now?: () => number;
}

function HashFact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="recorded-hash">{value}</dd>
    </div>
  );
}

function proposalToDecision(
  proposal: RecordedPreconfirmationView["items"][number]["proposedDecision"],
): FinalReviewDecision | null {
  if (proposal === "PROPOSED_PASS") return "PASS";
  if (proposal === "PROPOSED_CONFIRMED_FAIL") return "CONFIRMED_FAIL";
  return null;
}

export function RecordedPreconfirmationStage(
  props: RecordedPreconfirmationStageProps,
) {
  return (
    <RecordedPreconfirmationStageForm
      key={props.projection.sourceHash}
      {...props}
    />
  );
}

function RecordedPreconfirmationStageForm({
  projection,
  readOnly,
  onOpenEvidence,
  onConfirm,
  now = () => performance.now(),
}: RecordedPreconfirmationStageProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [actorLabel, setActorLabel] = useState("");
  const [decisions, setDecisions] = useState(
    () => new Map<string, FinalReviewDecision | null>(
      projection.items.map((item) => [item.itemId, null]),
    ),
  );
  const [rationales, setRationales] = useState(() => new Map(
    projection.items.map((item) => [item.itemId, ""]),
  ));
  const [openedItemIds, setOpenedItemIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const reviewStartedAt = useRef(new Map<string, number>());
  const editStartedAt = useRef(new Map<string, number>());
  const accumulatedEditMs = useRef(new Map<string, number>());
  const editedItems = useRef(new Set<string>());
  const canConfirm = projection.confirmationAllowed
    && !readOnly
    && acknowledged
    && actorLabel.trim().length > 0
    && projection.items.every((item) => (
      openedItemIds.has(item.itemId)
      && decisions.get(item.itemId) !== null
      && (rationales.get(item.itemId)?.trim().length ?? 0) > 0
    ));

  const submit = () => {
    if (!canConfirm) return;
    const confirmedAt = now();
    onConfirm({
      reviewId: projection.reviewId,
      actorLabel: actorLabel.trim(),
      expectedSourceHash: projection.sourceHash,
      expectedRecordedBenchmarkPackHash:
        projection.recordedBenchmarkPackHash,
      expectedAiPreReviewReceiptHash: projection.aiPreReviewReceiptHash,
      expectedProvisionalDecisionMemoHash:
        projection.provisionalDecisionMemoHash,
      expectedQueueContentHash: projection.queueContentHash,
      expectedQueueSetOrderHash: projection.queueSetOrderHash,
      items: projection.items.map((item) => {
        const accepted =
          decisions.get(item.itemId)
            === proposalToDecision(item.proposedDecision)
          && rationales.get(item.itemId)?.trim() === item.rationale;
        return {
          itemId: item.itemId,
          finalDecision: decisions.get(item.itemId)!,
          rationale: rationales.get(item.itemId)!.trim(),
          proposalResolution: accepted ? "ACCEPTED" : "EDITED",
          reviewDurationMs: Math.max(
            1,
            Math.round(
              confirmedAt - reviewStartedAt.current.get(item.itemId)!,
            ),
          ),
          editDurationMs: !accepted
            && editedItems.current.has(item.itemId)
            ? Math.max(
                1,
                Math.round(
                  accumulatedEditMs.current.get(item.itemId) ?? 0,
                ),
              )
            : 0,
        };
      }),
    });
  };

  return (
    <div className="page-stack recorded-review-page">
      <header className="page-header">
        <div>
          <span className="page-index">03 / DECIDE · BLIND HUMAN REVIEW</span>
          <h1>Confirm the evidence, not the evaluator.</h1>
          <p>
            Review two fixed runs under X/Y/Z labels. The auxiliary proposal
            cannot approve a candidate or create a baseline.
          </p>
        </div>
        <div className="page-header__status">
          <StatusBadge tone={projection.confirmationAllowed ? "review" : "block"}>
            {projection.preReviewStatus.replaceAll("_", " ")}
          </StatusBadge>
          <span>{projection.remaining} human decisions remain</span>
        </div>
      </header>

      <section
        className="section-panel recorded-review-queue"
        aria-label="Recorded blind review queue"
      >
        <div className="section-heading section-heading--split">
          <div>
            <span className="section-kicker">
              <EyeSlash aria-hidden="true" size={14} weight="bold" />
              IDENTITY BLINDED
            </span>
            <h2>Recorded blind review queue</h2>
            <p>
              Queue order and evidence handles come from the immutable
              Recorded Benchmark pack.
            </p>
          </div>
          <StatusBadge tone="review">
            {`${projection.completed} / ${projection.total} HUMAN CONFIRMED`}
          </StatusBadge>
        </div>

        <ol className="recorded-review-list">
          {projection.items.map((item) => {
            const decision = decisions.get(item.itemId);
            const rationale = rationales.get(item.itemId) ?? "";
            return (
              <li key={item.itemId}>
                <div className="recorded-review-list__identity">
                  <span className="queue-index">{item.queueIndex}</span>
                  <div>
                    <strong>{item.caseId} · {item.candidateLabel}</strong>
                    <small>{item.queueReason.replaceAll("_", " ")}</small>
                  </div>
                  <button
                    type="button"
                    className="icon-text-button"
                    aria-label={`Open blind Evidence for ${item.caseId}, ${item.candidateLabel}`}
                    onClick={() => {
                      void onOpenEvidence(item.evidenceId).then((opened) => {
                        // 실패한 요청·파싱·context 결합은 검수 완료나 시간으로
                        // 기록하지 않습니다. 성공한 detail만 최초 열람 시각을 만듭니다.
                        if (!opened || reviewStartedAt.current.has(item.itemId)) return;
                        reviewStartedAt.current.set(item.itemId, now());
                        setOpenedItemIds((current) => new Set(current).add(item.itemId));
                      }, () => {
                        // caller는 false를 반환해야 하지만, reject도 opened 상태를
                        // 만들지 않는 실패로만 취급합니다.
                      });
                    }}
                  >
                    Evidence <Eye aria-hidden="true" />
                  </button>
                </div>
                <div className="recorded-advisory">
                  <div>
                    <span className="eyebrow">
                      SUBAGENT PROPOSAL · ADVISORY · NOT HUMAN CONFIRMED
                    </span>
                    <strong>{item.proposedDecision.replaceAll("_", " ")}</strong>
                  </div>
                  <p>{item.rationale}</p>
                  <small>{item.evidenceHandles.join(" · ")}</small>
                </div>
                {projection.confirmationAllowed ? (
                  <div className="recorded-review-decision">
                    <fieldset disabled={readOnly}>
                      <legend>Human decision for {item.caseId} · {item.candidateLabel}</legend>
                      {(["PASS", "CONFIRMED_FAIL"] as const).map((value) => (
                        <label key={value}>
                          <input
                            type="radio"
                            name={`review-${item.itemId}`}
                            value={value}
                            aria-label={`${value.replace("_", " ")} for ${item.caseId}, ${item.candidateLabel}`}
                            checked={decision === value}
                            onChange={() => {
                              setAcknowledged(false);
                              setDecisions((current) => new Map(current).set(
                                item.itemId,
                                value,
                              ));
                            }}
                          />
                          <span>{value.replace("_", " ")}</span>
                        </label>
                      ))}
                    </fieldset>
                    <label className="recorded-rationale">
                      <span>Human rationale</span>
                      <textarea
                        aria-label={`Human rationale for ${item.caseId}, ${item.candidateLabel}`}
                        value={rationale}
                        disabled={readOnly}
                        onFocus={() => {
                          if (!editStartedAt.current.has(item.itemId)) {
                            editStartedAt.current.set(item.itemId, now());
                          }
                        }}
                        onBlur={() => {
                          const startedAt = editStartedAt.current.get(item.itemId);
                          if (startedAt === undefined) return;
                          const elapsed = Math.max(0, now() - startedAt);
                          accumulatedEditMs.current.set(
                            item.itemId,
                            (accumulatedEditMs.current.get(item.itemId) ?? 0)
                              + elapsed,
                          );
                          editStartedAt.current.delete(item.itemId);
                        }}
                        onChange={(event) => {
                          setAcknowledged(false);
                          editedItems.current.add(item.itemId);
                          setRationales((current) => new Map(current).set(
                            item.itemId,
                            event.target.value,
                          ));
                        }}
                      />
                    </label>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>

      <section className="section-panel recorded-artifact-bindings">
        <div className="section-heading">
          <span className="section-kicker">
            <FileText aria-hidden="true" size={14} weight="bold" />
            EXACT CONFIRMATION BINDINGS
          </span>
          <h2>Artifacts this human action will bind</h2>
          <p>Changing any source hash requires a new confirmation.</p>
        </div>
        <dl>
          <HashFact
            label="Recorded Benchmark pack"
            value={projection.recordedBenchmarkPackHash}
          />
          <HashFact
            label="Confirmation source"
            value={projection.sourceHash}
          />
          <HashFact
            label="AI pre-review receipt"
            value={projection.aiPreReviewReceiptHash}
          />
          <HashFact
            label="Provisional Decision Memo"
            value={projection.provisionalDecisionMemoHash}
          />
          <HashFact label="Queue content" value={projection.queueContentHash} />
          <HashFact label="Queue order" value={projection.queueSetOrderHash} />
        </dl>

        {projection.confirmationAllowed ? (
          <div className="recorded-confirmation">
            <label className="recorded-rationale">
              <span>Reviewer label</span>
              <input
                type="text"
                aria-label="Reviewer label"
                value={actorLabel}
                disabled={readOnly}
                onChange={(event) => {
                  setAcknowledged(false);
                  setActorLabel(event.target.value);
                }}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={readOnly}
                aria-label="I reviewed every blind item and the exact artifact hashes"
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                <strong>I reviewed every blind item and the exact artifact hashes</strong>
                <small>
                  This records human decisions. It does not select a candidate,
                  create a baseline, purchase, or deploy anything.
                </small>
              </span>
            </label>
            <button
              type="button"
              className="button button--primary"
              aria-label="Confirm the blind review against the exact artifacts"
              disabled={!canConfirm}
              onClick={submit}
            >
              Confirm exact blind review <ArrowRight aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div className="recorded-blocking-callout" role="alert">
            <ShieldWarning aria-hidden="true" weight="fill" />
            <div>
              <strong>User confirmation is blocked.</strong>
              <p>{projection.blockingReasons.join(" · ")}</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export interface RecordedMemoRequest {
  readonly decisionId: string;
  readonly expectedSourceHash: string;
  readonly action:
    | "SELECT_CANDIDATE"
    | "SELECT_NO_APPROVED_CANDIDATE";
  readonly selectedCandidateId: CandidateId | null;
  readonly rationale: string;
}

export interface RecordedMemoConfirmation {
  readonly decisionId: string;
  readonly expectedSourceHash: string;
  readonly expectedFinalDecisionMemoHash: string;
}

interface RecordedDecisionStageProps {
  readonly projection: HumanConfirmedDecisionView;
  readonly readOnly: boolean;
  readonly onRequestMemo: (request: RecordedMemoRequest) => void;
  readonly onConfirmMemo: (request: RecordedMemoConfirmation) => void;
  readonly onOpenEvidence?: (
    evidenceId: string,
    trigger: HTMLButtonElement,
  ) => void;
}

type DecisionChoice = CandidateId | "NO_APPROVED" | null;

function formatUsd(value: number | null): string {
  return value === null ? "NOT MEASURED" : `$${value.toFixed(6)}`;
}

function RecordedQualityCostTradeOff({
  projection,
}: {
  readonly projection: HumanConfirmedDecisionView;
}) {
  const measuredCosts = projection.candidates.flatMap((candidate) => (
    candidate.observed.averageRuntimeCostUsd === null
      ? []
      : [candidate.observed.averageRuntimeCostUsd]
  ));
  const maximumCost = Math.max(...measuredCosts, 0.001);
  const x = (cost: number) => 72 + (cost / maximumCost) * 420;
  const y = (quality: number) => 208 - (quality / 12) * 156;

  return (
    <section
      className="section-panel recorded-quality-cost"
      aria-labelledby="recorded-quality-cost-title"
    >
      <div className="section-heading section-heading--split">
        <div>
          <span className="section-kicker">QUALITY–COST TRADE-OFF</span>
          <h2 id="recorded-quality-cost-title">
            Compare observed trade-offs without an automatic winner.
          </h2>
          <p>
            This chart exposes quality, cost, gate status, and complexity. It
            does not select a candidate.
          </p>
        </div>
        <StatusBadge tone="neutral">NO COMPOSITE SCORE</StatusBadge>
        </div>
        <div className="tradeoff-layout">
        <figure className="tradeoff-figure">
          <div
            className="tradeoff-chart-scroll"
            tabIndex={0}
            aria-label="Scrollable recorded quality–cost chart"
          >
            <svg
              viewBox="0 0 560 250"
              role="img"
              aria-label="Recorded quality–cost trade-off"
            >
              <title>Recorded quality–cost trade-off</title>
              <desc>
                Each point shows locked policy-success case count against mean
                runtime cost. Gate status and complexity remain separate.
              </desc>
              <g className="plot-grid">
                {[4, 8, 12].map((tick) => (
                  <line
                    key={tick}
                    x1="70"
                    x2="520"
                    y1={y(tick)}
                    y2={y(tick)}
                  />
                ))}
                {[0.25, 0.5, 0.75, 1].map((fraction) => (
                  <line
                    key={fraction}
                    x1={x(maximumCost * fraction)}
                    x2={x(maximumCost * fraction)}
                    y1="42"
                    y2="208"
                  />
                ))}
              </g>
              <g className="plot-axis">
                <line x1="70" y1="208" x2="520" y2="208" />
                <line x1="70" y1="42" x2="70" y2="208" />
                {[4, 8, 12].map((tick) => (
                  <text
                    key={tick}
                    x="55"
                    y={y(tick) + 4}
                    textAnchor="end"
                  >
                    {tick}
                  </text>
                ))}
                {[0.25, 0.5, 0.75, 1].map((fraction) => (
                  <text
                    key={fraction}
                    x={x(maximumCost * fraction)}
                    y="228"
                    textAnchor="middle"
                  >
                    {formatUsd(maximumCost * fraction)}
                  </text>
                ))}
                <text x="295" y="247" textAnchor="middle">
                  Mean runtime cost per ticket
                </text>
                <text
                  transform="translate(16 132) rotate(-90)"
                  textAnchor="middle"
                >
                  Policy-success cases
                </text>
              </g>
              {projection.candidates.map((candidate) => {
                const cost = candidate.observed.averageRuntimeCostUsd;
                if (cost === null) return null;
                const pointTone = candidate.gateStatus === "PASS"
                  ? "pass"
                  : candidate.gateStatus === "REVIEW_REQUIRED"
                    ? "review"
                    : "fail";
                return (
                  <g
                    key={candidate.candidateId}
                    className={`plot-point plot-point--${pointTone}`}
                    aria-label={`Candidate ${candidate.candidateId}, ${candidate.observed.policySuccessCases} policy-success cases, ${formatUsd(cost)} mean runtime cost, ${candidate.gateStatus}, ${candidate.complexityProfile.candidateFailureComponents} complexity components`}
                  >
                    <circle
                      cx={x(cost)}
                      cy={y(candidate.observed.policySuccessCases)}
                      r="8"
                    />
                    <text
                      x={x(cost) + 14}
                      y={y(candidate.observed.policySuccessCases) - 10}
                    >
                      {candidate.candidateId} · C
                      {candidate.complexityProfile.candidateFailureComponents}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
          <figcaption>
            Gate failures cannot be offset by quality or cost. Complexity is
            displayed as a separate component count.
          </figcaption>
        </figure>
        <div className="tradeoff-table-wrap table-scroll" tabIndex={0}>
          <table
            className="data-table tradeoff-table"
            aria-label="Accessible recorded quality–cost trade-off"
          >
            <thead>
              <tr>
                <th scope="col">Candidate</th>
                <th scope="col">Gate</th>
                <th scope="col">Policy cases</th>
                <th scope="col">Cost / ticket</th>
                <th scope="col">Complexity</th>
              </tr>
            </thead>
            <tbody>
              {projection.candidates.map((candidate) => (
                <tr key={candidate.candidateId}>
                  <th scope="row">Candidate {candidate.candidateId}</th>
                  <td>{candidate.gateStatus.replace("_", " ")}</td>
                  <td>{candidate.observed.policySuccessCases} / 12</td>
                  <td>
                    {formatUsd(candidate.observed.averageRuntimeCostUsd)}
                  </td>
                  <td>
                    {candidate.complexityProfile.candidateFailureComponents}
                    {" "}components
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function RecordedFinalDecisionMemo({
  projection,
  readOnly,
  memoAcknowledged,
  onAcknowledgedChange,
  onConfirmMemo,
}: {
  readonly projection: HumanConfirmedDecisionView;
  readonly readOnly: boolean;
  readonly memoAcknowledged: boolean;
  readonly onAcknowledgedChange: (acknowledged: boolean) => void;
  readonly onConfirmMemo: (request: RecordedMemoConfirmation) => void;
}) {
  const memo = projection.finalDecisionMemo;
  const confirmationReady =
    projection.status === "MEMO_REVIEW_REQUIRED"
    && memo !== null
    && memo.bodyIntegrityVerified === true
    && projection.finalDecisionMemoHash === memo.sourceHash
    && projection.sourceHash === memo.decisionProjectionSourceHash;
  return (
    <section
      className="section-panel recorded-final-memo"
      aria-labelledby="recorded-final-memo-title"
    >
      <div className="section-heading section-heading--split">
        <div>
          <span className="section-kicker">
            <FileText aria-hidden="true" size={14} weight="bold" />
            SOURCE-VERIFIED DECISION EVIDENCE
          </span>
          <h2 id="recorded-final-memo-title">Final Decision Memo</h2>
          <p>
            The exact persisted Memo body is shown before any confirmation.
          </p>
        </div>
        <StatusBadge tone={memo === null ? "neutral" : "recorded"}>
          {memo === null ? "NOT GENERATED" : "FINAL · HASH VERIFIED"}
        </StatusBadge>
      </div>
      {memo === null ? (
        <div className="recorded-memo-empty" role="status">
          <strong>No Final Decision Memo has been generated.</strong>
          <p>
            Select an eligible outcome and record the human rationale first.
            No Memo review or confirmation is available in this state.
          </p>
        </div>
      ) : (
        <>
          <dl className="recorded-memo-body">
            <div>
              <dt>Decision summary</dt>
              <dd>{memo.decisionSummary}</dd>
            </div>
            <div>
              <dt>Rejected alternatives</dt>
              <dd>
                <ul>
                  {memo.rejectedAlternatives.map((alternative) => (
                    <li key={alternative.candidateId}>
                      <strong>Candidate {alternative.candidateId}</strong>
                      {": "}
                      {alternative.reason}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
            <div>
              <dt>Known limitations</dt>
              <dd>
                <ul>
                  {memo.knownLimitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              </dd>
            </div>
            <div>
              <dt>Next PoC scope</dt>
              <dd>{memo.nextPocScope}</dd>
            </div>
            <div>
              <dt>Procurement handoff</dt>
              <dd>{memo.procurementHandoff}</dd>
            </div>
            <div>
              <dt>External-action boundary</dt>
              <dd>{memo.externalActionStatement}</dd>
            </div>
          </dl>
          <div className="recorded-memo-tradeoffs">
            <span className="eyebrow">CANDIDATE TRADE-OFFS</span>
            {memo.candidateTradeOffs.map((tradeOff) => (
              <article key={tradeOff.candidateId}>
                <div>
                  <strong>Candidate {tradeOff.candidateId}</strong>
                  <StatusBadge
                    tone={tradeOff.disposition === "SELECTED"
                      ? "baseline"
                      : "neutral"}
                    compact
                  >
                    {tradeOff.disposition.replace("_", " ")}
                  </StatusBadge>
                </div>
                <p>{tradeOff.summary}</p>
                <small>
                  Critical failed cases:{" "}
                  {tradeOff.criticalFailedCaseIds.length === 0
                    ? "0"
                    : tradeOff.criticalFailedCaseIds.join(", ")}
                </small>
              </article>
            ))}
          </div>
          <dl className="recorded-memo-hash">
            <HashFact
              label="Final Decision Memo SHA-256"
              value={memo.sourceHash}
            />
          </dl>
        </>
      )}
      {confirmationReady ? (
        <div className="recorded-memo-confirmation">
          <label>
            <input
              type="checkbox"
              checked={memoAcknowledged}
              disabled={readOnly}
              aria-label="I reviewed the exact validated Final Decision Memo"
              onChange={(event) => (
                onAcknowledgedChange(event.target.checked)
              )}
            />
            <span>
              <strong>
                I reviewed the exact validated Final Decision Memo
              </strong>
              <small>
                A changed body or source hash requires a new explicit
                confirmation.
              </small>
            </span>
          </label>
          <button
            type="button"
            className="button button--primary"
            aria-label={projection.selectedCandidateId === null
              ? "Confirm the exact no-approved decision"
              : "Confirm the exact Decision Memo and create baseline"}
            disabled={!memoAcknowledged || readOnly}
            onClick={() => onConfirmMemo({
              decisionId: projection.decisionId,
              expectedSourceHash: projection.sourceHash,
              expectedFinalDecisionMemoHash: memo.sourceHash,
            })}
          >
            {projection.selectedCandidateId === null
              ? "Confirm no-approved decision"
              : "Confirm Memo and create baseline"}{" "}
            <ArrowRight aria-hidden="true" />
          </button>
          <p>
            {projection.selectedCandidateId === null
              ? "The browser creates no fallback or baseline and waits for the validated terminal projection."
              : "The browser does not activate a baseline locally. It waits for a new validated server projection."}
          </p>
        </div>
      ) : null}
    </section>
  );
}

export function RecordedDecisionStage(
  props: RecordedDecisionStageProps,
) {
  return (
    <RecordedDecisionStageForm
      key={props.projection.sourceHash}
      {...props}
    />
  );
}

function RecordedDecisionStageForm({
  projection,
  readOnly,
  onRequestMemo,
  onConfirmMemo,
  onOpenEvidence,
}: RecordedDecisionStageProps) {
  const [decisionChoice, setDecisionChoice] = useState<DecisionChoice>(
    projection.selectedCandidateId
      ?? (projection.selectionRationale === null ? null : "NO_APPROVED"),
  );
  const [rationale, setRationale] = useState(
    projection.selectionRationale ?? "",
  );
  const [memoAcknowledged, setMemoAcknowledged] = useState(false);
  const selectable = projection.status === "HUMAN_CONFIRMED_REVIEW";
  const noEligibleCandidate = projection.eligibleCandidateIds.length === 0;
  const ownerDeclinedPassingCandidates =
    projection.status === "NO_APPROVED_CANDIDATE"
    && !noEligibleCandidate;
  const noApprovedSelected = decisionChoice === "NO_APPROVED";
  const selectedCandidate = decisionChoice === "A"
    || decisionChoice === "B"
    || decisionChoice === "C"
    ? decisionChoice
    : null;
  const canRequestMemo = selectable
    && !readOnly
    && rationale.trim().length > 0
    && (
      noApprovedSelected
      || (
        selectedCandidate !== null
        && projection.eligibleCandidateIds.includes(selectedCandidate)
      )
    );
  const recommendation = projection.recommendedCandidateId;
  const decisionStatusLabel = projection.status.replaceAll("_", " ");
  const decisionStatusTone = projection.status === "DECISION_CONFIRMED"
    ? "baseline"
    : projection.status === "NO_APPROVED_CANDIDATE"
      ? "neutral"
      : projection.status === "MEMO_REVIEW_REQUIRED"
        ? "review"
        : "baseline";

  return (
    <div className="page-stack recorded-decision-page">
      <header className="page-header">
        <div>
          <span className="page-index">03 / DECIDE · RECORDED EVIDENCE</span>
          <h1>Choose the simplest sufficient configuration.</h1>
          <p>
            Fatal failures cannot be offset by average quality. The system
            recommendation remains separate from the decision owner’s choice.
          </p>
        </div>
        <div className="page-header__status">
          <StatusBadge tone={decisionStatusTone}>
            {decisionStatusLabel}
          </StatusBadge>
          <span>{projection.review.completed} / {projection.review.total} · 0 remaining</span>
        </div>
      </header>

      {projection.hardGateMatrix !== undefined && onOpenEvidence !== undefined ? (
        <RecordedHardGateMatrix
          matrix={projection.hardGateMatrix}
          onOpenEvidence={onOpenEvidence}
        />
      ) : null}

      <section
        className="section-panel recorded-gate-outcomes"
        aria-label="Recorded hard-gate outcomes"
      >
        <div className="section-heading">
          <span className="section-kicker">
            <ShieldWarning aria-hidden="true" size={14} weight="bold" />
            HARD GATES FIRST
          </span>
          <h2>Confirmed failure and sufficiency outcomes</h2>
        </div>
        <div className="recorded-candidate-gates">
          {projection.candidates.map((candidate) => (
            <article key={candidate.candidateId}>
              <div>
                <strong>Candidate {candidate.candidateId}</strong>
                <StatusBadge
                  tone={candidate.gateStatus === "PASS"
                    ? "pass"
                    : candidate.gateStatus === "REVIEW_REQUIRED"
                      ? "review"
                      : "fail"}
                  compact
                >
                  {candidate.gateStatus.replace("_", " ")}
                </StatusBadge>
              </div>
              <p>
                {candidate.criticalFailedCaseIds.length} critical failed case
                {candidate.criticalFailedCaseIds.length === 1 ? "" : "s"}
              </p>
              <small>
                {candidate.failedSufficiencyRules.length === 0
                  ? "All locked sufficiency rules passed"
                  : candidate.failedSufficiencyRules.join(" · ")}
              </small>
            </article>
          ))}
        </div>
      </section>

      <section className="section-panel recorded-candidate-metrics">
        <div className="section-heading">
          <span className="section-kicker">SEPARATE DECISION DIMENSIONS</span>
          <h2>Quality, cost, speed, stability, and complexity</h2>
          <p>No single weighted winner is generated.</p>
        </div>
        <div
          className="table-scroll"
          tabIndex={0}
          aria-label="Scrollable recorded candidate metrics"
        >
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Candidate</th>
                <th scope="col">Policy cases</th>
                <th scope="col">Citations</th>
                <th scope="col">Escalations</th>
                <th scope="col">Stability</th>
                <th scope="col">Cost / ticket</th>
                <th scope="col">Median / worst</th>
                <th scope="col">Complexity components</th>
              </tr>
            </thead>
            <tbody>
              {projection.candidates.map((candidate) => (
                <tr key={candidate.candidateId}>
                  <th scope="row">Candidate {candidate.candidateId}</th>
                  <td>{candidate.observed.policySuccessCases}</td>
                  <td>{candidate.observed.citationSuccessCases}</td>
                  <td>{candidate.observed.escalationSuccessCases}</td>
                  <td>{candidate.observed.stableCases}</td>
                  <td>{formatUsd(candidate.observed.averageRuntimeCostUsd)}</td>
                  <td>
                    {candidate.observed.medianLatencyMs} / {candidate.observed.worstLatencyMs} ms
                  </td>
                  <td>{candidate.complexityProfile.candidateFailureComponents}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <RecordedQualityCostTradeOff projection={projection} />

      {projection.status === "NO_APPROVED_CANDIDATE" ? (
        <section className="section-panel recorded-no-approved">
          <div className="recorded-blocking-callout">
            <ShieldWarning aria-hidden="true" weight="fill" />
            <div>
              <span className="section-kicker">VALID DECISION OUTCOME</span>
              <h2>No approved candidate</h2>
              <p>
                {ownerDeclinedPassingCandidates
                  ? "Passing candidates were not approved by the human decision owner."
                  : "No candidate passed every locked requirement."}
              </p>
              <small>
                {ownerDeclinedPassingCandidates
                  ? "The passing evaluation results remain unchanged."
                  : "No fallback candidate or regression baseline was created."}
              </small>
            </div>
          </div>
          {projection.selectionRationale !== null ? (
            <div
              className="recorded-no-approved__rationale"
              aria-label="Recorded no-approved decision rationale"
            >
              <span className="eyebrow">RECORDED HUMAN RATIONALE</span>
              <p>{projection.selectionRationale}</p>
            </div>
          ) : null}
        </section>
      ) : (
        <>
          <section className="recorded-recommendation" aria-label="System recommendation">
            <div>
              <span className="section-kicker"><Scales aria-hidden="true" /> System recommendation</span>
              <h2>
                {noEligibleCandidate
                  ? "No candidate is eligible for approval."
                  : recommendation === null
                  ? "No single minimum-complexity recommendation"
                  : `Candidate ${recommendation} is the minimum-complexity sufficient option.`}
              </h2>
              <p>
                This recommendation does not select a candidate and cannot create a
                Decision Memo or baseline.
              </p>
            </div>
            <StatusBadge tone={recommendation === null ? "review" : "pass"}>
              {recommendation === null ? "CONDITIONAL ALTERNATIVES" : "RECOMMENDATION READY"}
            </StatusBadge>
          </section>

          <section className="section-panel recorded-human-decision">
            <div className="section-heading">
              <span className="section-kicker">DECISION OWNER ACTION</span>
              <h2>Make the human selection</h2>
              <p>Only candidates marked eligible by the recorded server aggregation can be selected.</p>
            </div>
            {noEligibleCandidate ? (
              <div className="recorded-blocking-callout" role="status">
                <Prohibit aria-hidden="true" weight="fill" />
                <div>
                  <strong>No candidate can be selected.</strong>
                  <p>
                    Record an explicit no-approved decision. The system will
                    not create a fallback candidate or a baseline.
                  </p>
                </div>
              </div>
            ) : null}
            <fieldset disabled={!selectable || readOnly}>
              <legend>Human decision</legend>
              {noEligibleCandidate
                ? null
                : projection.candidates.map((candidate) => (
                  <label key={candidate.candidateId}>
                    <input
                      type="radio"
                      name="recorded-selected-candidate"
                      value={candidate.candidateId}
                      checked={decisionChoice === candidate.candidateId}
                      disabled={!selectable || readOnly || !candidate.eligible}
                      onChange={() => setDecisionChoice(candidate.candidateId)}
                    />
                    <span>
                      <strong>Candidate {candidate.candidateId}</strong>
                      <small>
                        {candidate.eligible
                          ? "Eligible · passes hard gates and sufficiency"
                          : "Not eligible"}
                      </small>
                    </span>
                  </label>
                ))}
              <label>
                <input
                  type="radio"
                  name="recorded-selected-candidate"
                  value="NO_APPROVED"
                  checked={noApprovedSelected}
                  disabled={!selectable || readOnly}
                  aria-label="Record no approved candidate instead"
                  onChange={() => setDecisionChoice("NO_APPROVED")}
                />
                <span>
                  <strong>Record no approved candidate instead</strong>
                  <small>
                    No fallback candidate or regression baseline will be
                    created.
                  </small>
                </span>
              </label>
            </fieldset>
            <label className="recorded-rationale">
              <span>Decision rationale</span>
              <textarea
                aria-label="Decision rationale"
                value={rationale}
                disabled={!selectable || readOnly}
                onChange={(event) => setRationale(event.target.value)}
              />
            </label>

            {projection.status === "HUMAN_CONFIRMED_REVIEW" ? (
              <button
                type="button"
                className="button button--primary"
                disabled={!canRequestMemo}
                onClick={() => {
                  if (!canRequestMemo) return;
                  onRequestMemo({
                    decisionId: projection.decisionId,
                    expectedSourceHash: projection.sourceHash,
                    action: noApprovedSelected
                      ? "SELECT_NO_APPROVED_CANDIDATE"
                      : "SELECT_CANDIDATE",
                    selectedCandidateId: noApprovedSelected
                      ? null
                      : selectedCandidate,
                    rationale: rationale.trim(),
                  });
                }}
              >
                {noEligibleCandidate || noApprovedSelected
                  ? "Generate no-approved Decision Memo"
                  : "Generate recorded Decision Memo"}{" "}
                <ArrowRight aria-hidden="true" />
              </button>
            ) : null}

          </section>
        </>
      )}

      <RecordedFinalDecisionMemo
        projection={projection}
        readOnly={readOnly}
        memoAcknowledged={memoAcknowledged}
        onAcknowledgedChange={setMemoAcknowledged}
        onConfirmMemo={onConfirmMemo}
      />

      <section className="recorded-hash-chain" aria-label="Decision evidence hashes">
        <HashFact
          label="Recorded Benchmark pack"
          value={projection.recordedBenchmarkPackHash}
        />
        <HashFact
          label="AI pre-review receipt"
          value={projection.aiPreReviewReceiptHash}
        />
        <HashFact
          label="Provisional Memo"
          value={projection.provisionalDecisionMemoHash}
        />
        <HashFact
          label="Human confirmation receipt"
          value={projection.humanConfirmationReceiptHash}
        />
      </section>
    </div>
  );
}

interface RecordedMonitorStageProps {
  readonly projection: RecordedRegressionView;
  readonly onOpenEvidence: (evidenceId: string) => void;
}

export interface RecordedRegressionStartRequest {
  readonly baselineId: string;
  readonly expectedSourceHash: string;
}

export function RecordedRegressionReadyStage({
  baseline,
  mobileReadOnly,
  pending,
  onStart,
}: {
  readonly baseline: ActiveBaselineView;
  readonly mobileReadOnly: boolean;
  readonly pending: boolean;
  readonly onStart: (request: RecordedRegressionStartRequest) => void;
}) {
  return (
    <div className="page-stack recorded-regression-ready">
      <header className="page-header">
        <div>
          <span className="page-index">
            04 / MONITOR · ACTIVE BASELINE
          </span>
          <h1>Run the recorded regression against the active baseline.</h1>
          <p>
            The approved baseline is authoritative. A recorded regression has
            not been created for the proposed change yet.
          </p>
        </div>
        <div className="page-header__status">
          <StatusBadge tone="review">READY TO RUN</StatusBadge>
          <span>Baseline {baseline.version} remains active</span>
        </div>
      </header>

      <section className="section-panel">
        <div className="section-heading">
          <span className="section-kicker">EXACT BASELINE BINDING</span>
          <h2>Recorded change-approval evaluation</h2>
          <p>
            The runner will use the persisted baseline and the same locked
            evaluation contract. Browser state cannot create a regression
            result.
          </p>
        </div>
        <dl className="recorded-regression-ready__facts">
          <HashFact label="Baseline ID" value={baseline.baselineId} />
          <HashFact
            label="Selected candidate"
            value={`Candidate ${baseline.selectedCandidateId}`}
          />
          <HashFact
            label="Baseline source hash"
            value={baseline.sourceHash}
          />
          <HashFact
            label="Configuration hash"
            value={baseline.configurationHash}
          />
        </dl>
      </section>

      <section
        className="recorded-regression-ready__boundary"
        aria-label="Regression execution boundary"
      >
        <ShieldWarning aria-hidden="true" weight="fill" />
        <div>
          <strong>Internal approval evidence only</strong>
          <p>
            This action does not deploy, roll back, or alter any external
            system. The active baseline remains unchanged until a separately
            reviewed decision.
          </p>
        </div>
      </section>

      <div className="recorded-regression-ready__action">
        <button
          type="button"
          className="button button--primary"
          aria-label={pending
            ? "Starting recorded regression"
            : "Run recorded regression"}
          disabled={mobileReadOnly || pending}
          onClick={() => onStart({
            baselineId: baseline.baselineId,
            expectedSourceHash: baseline.sourceHash,
          })}
        >
          {pending
            ? "Starting recorded regression…"
            : "Run recorded regression"}{" "}
          <ArrowRight aria-hidden="true" />
        </button>
        {mobileReadOnly ? (
          <p>
            Use the desktop workspace to start this recorded regression.
            Results remain available read-only on mobile.
          </p>
        ) : pending ? (
          <p role="status" aria-live="polite">
            The server is creating recorded evidence. Duplicate execution is
            blocked.
          </p>
        ) : (
          <p>
            The result will appear only after the authoritative workspace and
            regression projection validate.
          </p>
        )}
      </div>
    </div>
  );
}

function ComparisonFacts({
  side,
}: {
  readonly side: RecordedRegressionView["comparison"]["baseline"];
}) {
  return (
    <dl className="comparison-rows">
      <div><dt>Hard-gate failures</dt><dd>{side.hardGateFailures}</dd></div>
      <div><dt>Mean runtime cost</dt><dd>{formatUsd(side.meanRuntimeCostUsd)}</dd></div>
      <div><dt>Median latency</dt><dd>{side.medianLatencyMs === null ? "NOT MEASURED" : `${side.medianLatencyMs} ms`}</dd></div>
      <div><dt>Worst latency</dt><dd>{side.worstLatencyMs === null ? "NOT MEASURED" : `${side.worstLatencyMs} ms`}</dd></div>
    </dl>
  );
}

export function RecordedMonitorStage({
  projection,
  onOpenEvidence,
}: RecordedMonitorStageProps) {
  const firstFailure = projection.newHardGateFailures[0] ?? null;
  const verdictTone = projection.verdict === "BLOCK"
    ? "block"
    : projection.verdict === "PASS"
      ? "pass"
      : "review";
  const verdictDescription = useMemo(() => {
    if (projection.verdict === "BLOCK") {
      return "The proposed change is not approved. Baseline v1 remains active.";
    }
    if (projection.verdict === "PASS") {
      return "The recorded evaluation found no blocking reason. Human change approval remains separate.";
    }
    if (projection.verdict === "REVIEW") {
      return "The recorded result requires a human change review. It is not an automatic block or approval.";
    }
    return "The recorded evaluation is incomplete. No change approval can be issued.";
  }, [projection.verdict]);
  const verdictIcon = projection.verdict === "BLOCK"
    ? (
        <span aria-label="Block verdict icon">
          <Prohibit aria-hidden="true" size={30} weight="bold" />
        </span>
      )
    : projection.verdict === "PASS"
      ? (
          <span aria-label="Pass verdict icon">
            <CheckCircle aria-hidden="true" size={30} weight="fill" />
          </span>
        )
      : projection.verdict === "REVIEW"
        ? (
            <span aria-label="Review verdict icon">
              <ShieldWarning aria-hidden="true" size={30} weight="fill" />
            </span>
          )
        : (
            <span aria-label="Incomplete verdict icon">
              <ShieldWarning aria-hidden="true" size={30} weight="regular" />
            </span>
          );

  return (
    <div className="page-stack recorded-monitor-page">
      <header className="page-header">
        <div>
          <span className="page-index">04 / MONITOR · RECORDED REGRESSION</span>
          <h1>Protect the exact approved baseline.</h1>
          <p>
            Compare the proposed configuration with the same locked evaluation
            boundary before a human change decision.
          </p>
        </div>
        <div className="page-header__status">
          <StatusBadge tone="recorded">RECORDED REGRESSION</StatusBadge>
          <span>{projection.baselineId} · {projection.baselineVersion}</span>
        </div>
      </header>

      <section className="block-verdict" role="status">
        <div className="block-verdict__icon">
          {verdictIcon}
        </div>
        <div className="block-verdict__copy">
          <span className="section-kicker">CHANGE APPROVAL VERDICT</span>
          <h2>{projection.verdict.replaceAll("_", " ")}</h2>
          <p>{verdictDescription}</p>
          <small>
            This product did not deploy, roll back, or change any external production system.
          </small>
        </div>
        <StatusBadge tone={verdictTone}>{projection.status}</StatusBadge>
      </section>

      {firstFailure ? (
        <section
          className="section-panel recorded-first-failure"
          aria-label="First new hard-gate failure"
        >
          <div className="section-heading section-heading--split">
            <div>
              <span className="section-kicker">
                <ShieldWarning aria-hidden="true" size={14} weight="fill" />
                FIRST NEW HARD-GATE FAILURE
              </span>
              <h2>{firstFailure.caseId}</h2>
              <p>{firstFailure.gateIds.join(" · ")}</p>
            </div>
            <StatusBadge tone="fail">CONFIRMED FAIL</StatusBadge>
          </div>
          <dl className="failure-callout-grid">
            <div><dt>Baseline</dt><dd>{firstFailure.baselineStatus}</dd></div>
            <div><dt>Proposed</dt><dd>{firstFailure.proposedStatus.replace("_", " ")}</dd></div>
          </dl>
          <button
            type="button"
            className="button button--secondary"
            aria-label={`Open recorded regression Evidence for ${firstFailure.caseId}`}
            onClick={() => onOpenEvidence(firstFailure.evidenceId)}
          >
            Open recorded Evidence <ArrowRight aria-hidden="true" />
          </button>
        </section>
      ) : null}

      {projection.blockingReasons.length > 0 ? (
        <section
          className="section-panel recorded-decision-reasons"
          aria-label="Recorded blocking and review reasons"
        >
          <div className="section-heading">
            <span className="section-kicker">
              <ShieldWarning aria-hidden="true" size={14} weight="fill" />
              RECORDED DECISION REASONS
            </span>
            <h2>Every independent blocking or review reason</h2>
            <p>No reason is averaged away or hidden behind the first failure.</p>
          </div>
          <ol className="recorded-reason-list">
            {projection.blockingReasons.map((reason, index) => (
              <li key={`${reason.code}:${index}`}>
                <div>
                  <strong>{reason.code.replaceAll("_", " ")}</strong>
                  <p>{reason.summary}</p>
                </div>
                {reason.evidenceId ? (
                  <button
                    type="button"
                    className="button button--secondary"
                    aria-label={`Open recorded Evidence for ${reason.code.replaceAll("_", " ")}`}
                    onClick={() => onOpenEvidence(reason.evidenceId!)}
                  >
                    Open recorded Evidence <ArrowRight aria-hidden="true" />
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section
        className="section-panel recorded-regression-comparison"
        aria-label="Recorded regression comparison"
      >
        <div className="section-heading">
          <span className="section-kicker">SAME MEASUREMENT BOUNDARY</span>
          <h2>Baseline v1 vs proposed configuration</h2>
          <p>Gate failures remain separate from cost and latency observations.</p>
        </div>
        <div className="baseline-comparison">
          <article className="baseline-column">
            <span className="eyebrow">ACTIVE BASELINE</span>
            <h3>{projection.comparison.baseline.label}</h3>
            <ComparisonFacts side={projection.comparison.baseline} />
            <small className="recorded-hash">
              {projection.baselineConfigurationHash}
            </small>
          </article>
          <article className="baseline-column baseline-column--blocked">
            <span className="eyebrow">PROPOSED CONFIGURATION</span>
            <h3>{projection.comparison.proposed.label}</h3>
            <ComparisonFacts side={projection.comparison.proposed} />
            <small className="recorded-hash">
              {projection.proposedConfigurationHash}
            </small>
          </article>
        </div>
      </section>
    </div>
  );
}

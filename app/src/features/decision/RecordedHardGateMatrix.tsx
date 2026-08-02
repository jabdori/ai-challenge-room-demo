import {
  ArrowSquareOut,
  ShieldCheck,
  ShieldWarning,
} from "@phosphor-icons/react";
import { StatusBadge } from "../../components/StatusBadge";
import type {
  RecordedHardGateCellView,
  RecordedHardGateMatrixView,
} from "./recordedHardGateMatrixContract";
import "./RecordedHardGateMatrix.css";

function tone(
  status: RecordedHardGateCellView["status"],
): "pass" | "fail" | "review" {
  if (status === "CONFIRMED_FAIL") return "fail";
  if (status === "REVIEW") return "review";
  return "pass";
}

function statusLabel(status: RecordedHardGateCellView["status"]): string {
  return status.replaceAll("_", " ");
}

function observationSummary(cell: RecordedHardGateCellView): string {
  const parts = [
    `${cell.counts.passRuns} pass`,
    `${cell.counts.confirmedFailRuns} failed`,
    `${cell.counts.reviewRuns} review`,
  ];
  if (cell.counts.notApplicableRuns > 0) {
    parts.push(`${cell.counts.notApplicableRuns} N/A`);
  }
  return parts.join(" · ");
}

export function RecordedHardGateMatrix({
  matrix,
  onOpenEvidence,
}: {
  readonly matrix: RecordedHardGateMatrixView;
  readonly onOpenEvidence: (
    evidenceId: string,
    trigger: HTMLButtonElement,
  ) => void;
}) {
  const failedCells = matrix.rows.flatMap((row) => (
    row.candidates
      .filter((candidate) => candidate.status === "CONFIRMED_FAIL")
      .map((candidate) => `${row.gateCode} · Candidate ${candidate.candidateId}`)
  ));

  return (
    <section
      className="section-panel recorded-hard-gate-matrix"
      aria-labelledby="recorded-hard-gate-matrix-title"
    >
      <div className="recorded-hard-gate-matrix__heading">
        <div>
          <span className="section-kicker">
            <ShieldCheck aria-hidden="true" size={14} weight="bold" />
            DETERMINISTIC AUTHORITY
          </span>
          <h2 id="recorded-hard-gate-matrix-title">
            Hard gates before averages
          </h2>
          <p>
            Four locked failure classes across three candidates. Fatal findings
            cannot be offset by quality, cost, speed, or a Judge score.
          </p>
        </div>
        <span className="recorded-hard-gate-matrix__source">
          RECORDED · {matrix.sourceHash.slice(0, 10)}…
        </span>
      </div>

      {failedCells.length > 0 ? (
        <div
          className="recorded-hard-gate-matrix__critical"
          role="alert"
          aria-label="Deterministic hard-gate failures"
        >
          <ShieldWarning aria-hidden="true" size={22} weight="fill" />
          <div>
            <strong>Confirmed failures remain disqualifying</strong>
            <span>{failedCells.join(" · ")}</span>
          </div>
        </div>
      ) : (
        <div className="recorded-hard-gate-matrix__clear">
          <ShieldCheck aria-hidden="true" size={20} />
          <div>
            <strong>No deterministic hard-gate failure recorded</strong>
            <span>Review signals still require human judgment.</span>
          </div>
        </div>
      )}

      <div className="recorded-hard-gate-matrix__scroll">
        <table aria-label="Recorded hard-gate matrix">
          <thead>
            <tr>
              <th scope="col">Locked gate</th>
              {(["A", "B", "C"] as const).map((candidateId) => (
                <th key={candidateId} scope="col">
                  Candidate {candidateId}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => (
              <tr key={row.gateCode}>
                <th scope="row">
                  <span>{row.gateCode}</span>
                  <strong>{row.label}</strong>
                  <small>{row.decisionRule}</small>
                </th>
                {row.candidates.map((candidate) => (
                  <td
                    key={candidate.candidateId}
                    data-status={candidate.status.toLowerCase()}
                  >
                    <StatusBadge tone={tone(candidate.status)} compact>
                      {statusLabel(candidate.status)}
                    </StatusBadge>
                    <span className="recorded-hard-gate-matrix__counts">
                      {observationSummary(candidate)}
                    </span>
                    <span className="recorded-hard-gate-matrix__applicability">
                      {candidate.applicability.replaceAll("_", " ")}
                    </span>
                    {candidate.evidenceAction === null ? null : (
                      <button
                        type="button"
                        onClick={(event) => onOpenEvidence(
                          candidate.evidenceAction!.primaryEvidenceId,
                          event.currentTarget,
                        )}
                        aria-label={`Open ${
                          candidate.status === "CONFIRMED_FAIL"
                            ? "failure"
                            : "review"
                        } evidence for ${row.gateCode}, Candidate ${candidate.candidateId}`}
                      >
                        Evidence
                        <ArrowSquareOut aria-hidden="true" size={14} />
                      </button>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <aside className="recorded-hard-gate-matrix__na-note">
        <strong>Tool / evidence N/A boundary</strong>
        <span>
          {matrix.rows[3].notApplicableMeaning}
        </span>
      </aside>
    </section>
  );
}

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { evidenceRecords } from "../data/fixtures";
import { HumanReviewQueue } from "../features/decision/HumanReviewQueue";
import type { ReviewQueueState } from "../domain/types";

function renderView(path: string) {
  const url = new URL(path, "http://localhost");
  const fixtureView = url.searchParams.get("view") ?? "decide";
  url.searchParams.set("view", "fixture-demo");
  url.searchParams.set("fixtureView", fixtureView);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  return render(<App />);
}

describe("AI Challenge Room high-fidelity vertical slice", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("renders the English-first decision workspace without a repeated marketing hero", () => {
    const { container } = renderView("/?view=decide");

    expect(screen.getByRole("link", { name: "Skip to decision workspace" })).toHaveAttribute("href", "#main-workspace");
    expect(screen.getByRole("banner")).toHaveTextContent("AI Challenge Room");
    expect(screen.getByRole("banner")).toHaveTextContent("Customer Support AI Selection");
    expect(screen.getByRole("banner")).toHaveTextContent("SYNTHETIC DATA");
    expect(screen.getByRole("contentinfo", { name: "Locked evaluation context" })).toHaveTextContent("hidden-support-v1");
    expect(screen.getByRole("heading", { name: "Decide with evidence" })).toBeVisible();
    expect(screen.getByText("SELECTION REQUIRED")).toBeVisible();
    expect(screen.getByText("No human decision draft yet")).toBeVisible();
    expect(screen.getByLabelText("Monitor, NO BASELINE")).toBeVisible();
    expect(screen.getByRole("link", { name: "Record no approved candidate instead" })).toHaveAttribute("href", "/?view=no-approved&reason=owner-declined");
    expect(screen.queryByText("Turn a real business task into a private AI challenge.")).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/[\u3131-\uD79D]/u);
  });

  it("shows completed required and judge-flagged blind review work", () => {
    renderView("/?view=decide");

    const queue = screen.getByRole("region", { name: "Blind human review queue" });
    expect(within(queue).getByText("Required reviews")).toBeVisible();
    expect(within(queue).getByText("12 / 12")).toBeVisible();
    expect(within(queue).getByText("Judge-flagged reviews")).toBeVisible();
    expect(within(queue).getByText("2 / 2")).toBeVisible();
    expect(within(queue).getByText("Remaining")).toBeVisible();
    expect(within(queue).getByText("0")).toBeVisible();
    expect(within(queue).getByRole("button", { name: "Open next review" })).toBeDisabled();
  });

  it("shows the P0 quality-cost trade-off without a Pareto frontier", () => {
    const { container } = renderView("/?view=decide");
    const tradeoffTable = screen.getByRole("table", { name: "Accessible quality–cost data" });

    expect(screen.getByRole("heading", { name: "Quality–cost trade-off" })).toBeVisible();
    expect(screen.queryByText("Observed Pareto frontier")).not.toBeInTheDocument();
    expect(container.querySelector(".frontier-line")).not.toBeInTheDocument();
    expect(within(tradeoffTable).getByText("T1")).toBeVisible();
    expect(within(tradeoffTable).getByText("T2")).toBeVisible();
    expect(within(tradeoffTable).getByText("T3")).toBeVisible();
    expect(within(tradeoffTable).queryByText("Tier 1")).not.toBeInTheDocument();
  });

  it("requires a blind PASS or CONFIRMED FAIL rationale before saving", async () => {
    const user = userEvent.setup();
    let decisionView = renderView("/?view=decide&review=pending");

    expect(evidenceRecords["blind-h017-x"].blindDetail?.runs).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Open next review" }));
    const dialog = screen.getByRole("dialog", { name: /Blind review H-017 · Candidate X · Status REVIEW REQUIRED/ });

    expect(within(dialog).getByText("Run 1")).toBeVisible();
    expect(within(dialog).getByText("Run 2")).toBeVisible();
    expect(within(dialog).queryByText(/RAG|Agent|Candidate B/i)).not.toBeInTheDocument();
    const save = within(dialog).getByRole("button", { name: "Save human confirmation" });
    expect(save).toBeDisabled();

    await user.click(within(dialog).getByRole("radio", { name: "PASS" }));
    await user.type(within(dialog).getByLabelText("Required rationale"), "Both runs follow the cited active policy.");
    expect(save).toBeEnabled();

    await user.click(save);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const queueAfterFirstReview = screen.getByRole("region", { name: "Blind human review queue" });
    expect(within(queueAfterFirstReview).getByText("12 / 12")).toBeVisible();
    expect(within(queueAfterFirstReview).getByText("13 / 14")).toBeVisible();
    expect(within(queueAfterFirstReview).getByText("1")).toBeVisible();
    expect(within(queueAfterFirstReview).getAllByText("H-021 · Candidate Z").length).toBeGreaterThan(0);

    decisionView.unmount();
    decisionView = renderView("/?view=decide");
    expect(screen.getAllByText("EVALUATION INCOMPLETE").length).toBeGreaterThan(0);
    const restoredQueue = screen.getByRole("region", { name: "Blind human review queue" });
    expect(within(restoredQueue).getByText("13 / 14")).toBeVisible();
    expect(within(restoredQueue).getAllByText("H-021 · Candidate Z").length).toBeGreaterThan(0);

    await user.click(within(restoredQueue).getByRole("button", { name: "Open next review" }));
    const secondDialog = screen.getByRole("dialog", { name: /Blind review H-021 · Candidate Z · Status REVIEW REQUIRED/ });
    await user.click(within(secondDialog).getByRole("radio", { name: "PASS" }));
    await user.type(within(secondDialog).getByLabelText("Required rationale"), "Both runs preserve the required escalation boundary.");
    await user.click(within(secondDialog).getByRole("button", { name: "Save human confirmation" }));

    expect(screen.getByText("Candidate B is the least complex sufficient configuration.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm decision and set baseline" })).toBeDisabled();
    expect(new URLSearchParams(window.location.search).has("review")).toBe(false);
  });

  it("removes the failed candidate and recommends the remaining sufficient configuration", async () => {
    const user = userEvent.setup();
    const decisionView = renderView("/?view=decide&review=pending");

    await user.click(screen.getByRole("button", { name: "Open next review" }));
    const firstDialog = screen.getByRole("dialog", { name: /Blind review H-017 · Candidate X · Status REVIEW REQUIRED/ });
    await user.click(within(firstDialog).getByRole("radio", { name: "CONFIRMED FAIL" }));
    await user.type(within(firstDialog).getByLabelText("Required rationale"), "Run 2 implies an external action before the locked tool confirms it.");
    await user.click(within(firstDialog).getByRole("button", { name: "Save human confirmation" }));

    expect(screen.getByText("Candidate identities remain blinded")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Sufficiency, cost, and reliability" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open evidence for Candidate B, Safety escalation, CONFIRMED FAIL" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open next review" }));
    const secondDialog = screen.getByRole("dialog", { name: /Blind review H-021 · Candidate Z · Status REVIEW REQUIRED/ });
    await user.click(within(secondDialog).getByRole("radio", { name: "PASS" }));
    await user.type(within(secondDialog).getByLabelText("Required rationale"), "Both runs preserve the locked evidence-review boundary.");
    await user.click(within(secondDialog).getByRole("button", { name: "Save human confirmation" }));

    expect(screen.getAllByText("EVIDENCE READY").length).toBeGreaterThan(0);
    expect(screen.getByText("Candidate C is the only configuration that remains sufficient.")).toBeVisible();
    expect(screen.queryByRole("radio", { name: /Deterministic RAG/ })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Read-only tool workflow/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open evidence for Candidate B, Safety escalation, CONFIRMED FAIL" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm decision and set baseline" })).toBeDisabled();
    expect(screen.getByRole("main")).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Open evidence for Candidate B, Safety escalation, CONFIRMED FAIL" }));
    const failureEvidence = screen.getByRole("dialog", { name: /Human-confirmed evidence · H-017 · Candidate B · Status CONFIRMED FAIL/ });
    expect(within(failureEvidence).getByText(/Run 2 implies an external action before the locked tool confirms it/)).toBeVisible();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("radio", { name: /Read-only tool workflow/ }));
    expect(screen.getByText(/Candidate B became ineligible after a blind human review confirmed the H-017/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Inspect decision rule" }));
    const decisionEvidence = screen.getByRole("dialog", { name: /Decision evidence · Candidate C · sole eligible · Status PASS/ });
    expect(within(decisionEvidence).getByText(/Candidate B became ineligible after the H-017 blind review/)).toBeVisible();
    await user.keyboard("{Escape}");

    decisionView.unmount();
    renderView("/?view=decide");
    expect(screen.getByText("Candidate C is the only configuration that remains sufficient.")).toBeVisible();
    expect(screen.queryByRole("radio", { name: /Deterministic RAG/ })).not.toBeInTheDocument();
  });

  it("routes to a no-approved decision when both eligible candidates fail blind review", async () => {
    const user = userEvent.setup();
    renderView("/?view=decide&review=pending");

    await user.click(screen.getByRole("button", { name: "Open next review" }));
    let dialog = screen.getByRole("dialog", { name: /Blind review H-017 · Candidate X · Status REVIEW REQUIRED/ });
    await user.click(within(dialog).getByRole("radio", { name: "CONFIRMED FAIL" }));
    await user.type(within(dialog).getByLabelText("Required rationale"), "The response crosses the locked action boundary.");
    await user.click(within(dialog).getByRole("button", { name: "Save human confirmation" }));

    await user.click(screen.getByRole("button", { name: "Open next review" }));
    dialog = screen.getByRole("dialog", { name: /Blind review H-021 · Candidate Z · Status REVIEW REQUIRED/ });
    await user.click(within(dialog).getByRole("radio", { name: "CONFIRMED FAIL" }));
    await user.type(within(dialog).getByLabelText("Required rationale"), "The response implies an unsupported order-state change.");
    await user.click(within(dialog).getByRole("button", { name: "Save human confirmation" }));

    expect(screen.getByText("No candidate passed every locked requirement.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Record no approved candidate" })).toHaveAttribute(
      "href",
      "/?view=no-approved&reason=human-review-failed",
    );
    expect(screen.queryByRole("button", { name: "Confirm decision and set baseline" })).not.toBeInTheDocument();
  });

  it("keeps Candidate B as the only sufficient option when Candidate C fails blind review", async () => {
    const user = userEvent.setup();
    renderView("/?view=decide&review=pending");

    await user.click(screen.getByRole("button", { name: "Open next review" }));
    let dialog = screen.getByRole("dialog", { name: /Blind review H-017 · Candidate X · Status REVIEW REQUIRED/ });
    await user.click(within(dialog).getByRole("radio", { name: "PASS" }));
    await user.type(within(dialog).getByLabelText("Required rationale"), "Both drafts stay inside the action boundary.");
    await user.click(within(dialog).getByRole("button", { name: "Save human confirmation" }));

    await user.click(screen.getByRole("button", { name: "Open next review" }));
    dialog = screen.getByRole("dialog", { name: /Blind review H-021 · Candidate Z · Status REVIEW REQUIRED/ });
    await user.click(within(dialog).getByRole("radio", { name: "CONFIRMED FAIL" }));
    await user.type(within(dialog).getByLabelText("Required rationale"), "One draft implies an unsupported order-state change.");
    await user.click(within(dialog).getByRole("button", { name: "Save human confirmation" }));

    expect(screen.getByText("Candidate B is the only configuration that remains sufficient.")).toBeVisible();
    expect(screen.getByRole("radio", { name: /Deterministic RAG/ })).toBeVisible();
    expect(screen.queryByRole("radio", { name: /Read-only tool workflow/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open evidence for Candidate C, Tool evidence consistency, CONFIRMED FAIL" })).toBeVisible();

    await user.click(screen.getByRole("radio", { name: /Deterministic RAG/ }));
    expect(screen.getByText(/Candidate C became ineligible after a blind human review confirmed the H-021/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Inspect decision rule" }));
    expect(screen.getByRole("dialog", { name: /Decision evidence · Candidate B · sole eligible · Status PASS/ })).toBeVisible();
  });

  it("does not allow a deep link to bypass the deterministic blind-review order", () => {
    renderView("/?view=decide&review=pending&evidence=blind-h021-z");

    const dialog = screen.getByRole("dialog", { name: /Blind review H-021 · Candidate Z · Status REVIEW REQUIRED/ });
    expect(within(dialog).getByText("Complete the prior queued review before recording this confirmation.")).toBeVisible();
    expect(within(dialog).getByRole("radio", { name: "PASS" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Save human confirmation" })).toBeDisabled();
  });

  it("withholds recommendation and decision actions while human review is incomplete", () => {
    renderView("/?view=decide&review=pending");

    expect(screen.getAllByText("EVALUATION INCOMPLETE").length).toBeGreaterThan(0);
    expect(screen.getByText("Recommendation withheld until human review is complete.")).toBeVisible();
    expect(screen.getByText("Decision actions locked")).toBeVisible();
    expect(screen.queryByText("Candidate B is the least complex sufficient configuration.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm decision and set baseline" })).not.toBeInTheDocument();
  });

  it("records a decision and baseline atomically with no intermediate recorded state", async () => {
    const user = userEvent.setup();
    const decisionView = renderView("/?view=decide");

    expect(screen.getAllByText("EVIDENCE READY").length).toBeGreaterThan(0);
    expect(screen.queryByText("DECISION RECORDED")).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Deterministic RAG/ }));
    expect(screen.getAllByText("DECISION DRAFT").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("checkbox", { name: "I reviewed the Decision Memo" }));
    await user.click(screen.getByRole("button", { name: "Confirm decision and set baseline" }));

    expect(screen.getAllByText("ACTIVE BASELINE").length).toBeGreaterThan(0);
    expect(screen.getByText("Baseline B v1")).toBeVisible();
    expect(screen.getByRole("banner")).toHaveTextContent("ACTIVE BASELINE");
    expect(screen.getByText(/Decision recorded at/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Review proposed change" })).toHaveAttribute("href", "/?view=monitor&baseline=B");
    expect(screen.queryByText("DECISION RECORDED")).not.toBeInTheDocument();

    decisionView.unmount();
    renderView("/?view=decide");
    expect(screen.getByRole("banner")).toHaveTextContent("ACTIVE BASELINE");
    expect(screen.getByRole("link", { name: /Monitor/ })).toHaveAttribute("href", "/?view=monitor&baseline=B");
    expect(screen.getByText("Baseline B v1")).toBeVisible();
    expect(screen.queryByRole("radio", { name: /Deterministic RAG/ })).not.toBeInTheDocument();
  });

  it("requires the Decision Memo to be reviewed again after rationale changes", async () => {
    const user = userEvent.setup();
    renderView("/?view=decide");

    await user.click(screen.getByRole("radio", { name: /Deterministic RAG/ }));
    const memoReviewed = screen.getByRole("checkbox", { name: "I reviewed the Decision Memo" });
    await user.click(memoReviewed);
    expect(memoReviewed).toBeChecked();

    await user.type(screen.getByLabelText("Required decision rationale"), " The owner also accepts the documented retrieval dependency.");
    expect(memoReviewed).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Confirm decision and set baseline" })).toBeDisabled();
  });

  it("confirms no approved candidate without creating a baseline", async () => {
    const user = userEvent.setup();
    const decisionView = renderView("/?view=no-approved");

    expect(screen.getByRole("heading", { name: "No approved candidate" })).toBeVisible();
    expect(screen.getByText("All candidates failed hard gates or sufficiency requirements")).toBeVisible();
    expect(screen.getByText("Regression baseline: Not created")).toBeVisible();
    expect(screen.queryByRole("link", { name: /Monitor/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Monitor, NO BASELINE")).toBeVisible();
    expect(screen.getByLabelText("Required decision rationale")).not.toHaveAttribute("readonly");
    await user.click(screen.getByRole("checkbox", { name: "I reviewed the no-candidate Decision Memo" }));
    await user.click(screen.getByRole("button", { name: "Confirm no approved candidate" }));

    expect(screen.getAllByText("NO APPROVED CANDIDATE").length).toBeGreaterThan(0);
    expect(screen.getByRole("banner")).toHaveTextContent("NO APPROVED CANDIDATE");
    expect(screen.queryByText("ACTIVE BASELINE")).not.toBeInTheDocument();

    decisionView.unmount();
    const restoredView = renderView("/?view=no-approved");
    expect(screen.getByRole("banner")).toHaveTextContent("NO APPROVED CANDIDATE");
    expect(screen.getByText("Decision closed without a baseline")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm no approved candidate" })).not.toBeInTheDocument();

    restoredView.unmount();
    renderView("/?view=no-approved&reason=owner-declined");
    expect(screen.getByRole("heading", { name: "All candidates failed hard gates or sufficiency requirements" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Passing candidates were not approved by the decision owner" })).not.toBeInTheDocument();
  });

  it("does not let a pending review deep-link bypass completion through the no-approved route", () => {
    renderView("/?view=no-approved&review=pending");

    expect(screen.getByRole("heading", { name: "Decide with evidence" })).toBeVisible();
    expect(screen.getAllByText("EVALUATION INCOMPLETE").length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "No approved candidate" })).not.toBeInTheDocument();
  });

  it("renders the human-review all-failed record with candidate-matched Evidence", async () => {
    const user = userEvent.setup();
    renderView("/?view=no-approved&reason=human-review-failed");

    expect(screen.getByRole("heading", { name: "All candidates failed after blind human confirmation" })).toBeVisible();
    expect(screen.getByRole("row", { name: /Candidate B CONFIRMED FAIL Blind human confirmation/ })).toBeVisible();
    expect(screen.getByRole("row", { name: /Candidate C CONFIRMED FAIL Blind human confirmation/ })).toBeVisible();
    expect(screen.getByLabelText("Required decision rationale")).not.toHaveAttribute("readonly");

    await user.click(screen.getByRole("button", { name: "Open Evidence for Candidate B H-017" }));
    expect(screen.getByRole("dialog", { name: /Human-confirmed evidence · H-017 · Candidate B · Status CONFIRMED FAIL/ })).toBeVisible();
  });

  it("opens candidate- and case-matched Evidence from the no-approved table", async () => {
    const user = userEvent.setup();
    renderView("/?view=no-approved");

    await user.click(screen.getByRole("button", { name: "Open Evidence for Candidate B H-017" }));
    const candidateBEvidence = screen.getByRole("dialog", { name: /Evidence · H-017 · Candidate B · Status CONFIRMED FAIL/ });
    expect(candidateBEvidence).toBeVisible();
    expect(within(candidateBEvidence).getByText("CONFIRMED FAIL")).toBeVisible();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Open Evidence for Candidate C H-020" }));
    const budgetEvidence = screen.getByRole("dialog", { name: /Evidence · H-020 · Candidate C · Status BUDGET EXCEEDED/ });
    expect(within(budgetEvidence).getByText("BUDGET EXCEEDED")).toBeVisible();
    expect(within(budgetEvidence).queryByText("Candidate A · Run 2")).not.toBeInTheDocument();
  });

  it("preserves passing evaluation results when the decision owner declines every eligible candidate", () => {
    renderView("/?view=no-approved&reason=owner-declined");

    expect(screen.getByRole("heading", { name: "Passing candidates were not approved by the decision owner" })).toBeVisible();
    const candidateBRow = screen.getByRole("row", { name: /Candidate B PASS Passed the locked evaluation/ });
    const candidateCRow = screen.getByRole("row", { name: /Candidate C PASS Passed the locked evaluation/ });
    expect(within(candidateBRow).getByText("PASS")).toBeVisible();
    expect(within(candidateCRow).getByText("PASS")).toBeVisible();
    expect(screen.getByText(/Candidate B and C remain PASS/)).toBeVisible();
  });

  it("keeps the selected candidate, rationale, and Decision Memo internally consistent", async () => {
    const user = userEvent.setup();
    renderView("/?view=decide");

    await user.click(screen.getByRole("radio", { name: /Read-only tool workflow/ }));

    expect(screen.getByLabelText("Required decision rationale")).toHaveValue(
      "Candidate C is the selected passing configuration because the decision owner prioritizes full policy-case coverage and accepts the documented cost, latency, and read-only tool dependencies.",
    );
    expect(screen.getByText("Approve Candidate C (Read-only tool workflow) for a controlled PoC.")).toBeVisible();
    expect(screen.getByText(/Candidate B also passes and is lower complexity/)).toBeVisible();
    expect(screen.queryByText(/Candidate C passes but adds tool/)).not.toBeInTheDocument();
  });

  it("lets the owner record an explicit reason when passing candidates are declined", async () => {
    const user = userEvent.setup();
    renderView("/?view=no-approved&reason=owner-declined");

    expect(screen.getByText("The evaluation produced passing candidates; the owner approval boundary remains a separate decision record.")).toBeVisible();
    const rationale = screen.getByLabelText("Required decision rationale");
    expect(rationale).not.toHaveAttribute("readonly");
    await user.clear(rationale);
    await user.type(rationale, "Security review must close before Candidate B or C can enter a controlled PoC.");
    expect(screen.getAllByText("Security review must close before Candidate B or C can enter a controlled PoC.").length).toBeGreaterThan(0);
  });

  it("changes Evidence content by invocation and restores focus after Escape", async () => {
    const user = userEvent.setup();
    renderView("/?view=decide");

    const trigger = screen.getByRole("button", { name: "Open evidence for Candidate A, Active policy, CONFIRMED FAIL" });
    trigger.focus();
    await user.click(trigger);
    expect(new URLSearchParams(window.location.search).get("evidence")).toBe("gate-a-policy");
    const dialog = screen.getByRole("dialog", { name: /Evidence · H-009 · Candidate A · Status CONFIRMED FAIL/ });
    expect(within(dialog).getByText("RECORDED BENCHMARK")).toBeVisible();
    expect(within(dialog).getByText("POL-RET-4.2")).toBeVisible();
    expect(within(dialog).getByText(/auxiliary signal/i)).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).has("evidence")).toBe(false);
    expect(trigger).toHaveFocus();
  });

  it("opens recommendation and chart Evidence that matches the selected candidate context", async () => {
    const user = userEvent.setup();
    renderView("/?view=decide");

    await user.click(screen.getByRole("button", { name: "Inspect decision rule" }));
    const recommendationEvidence = screen.getByRole("dialog", { name: /Decision evidence · Candidate B · Status PASS/ });
    expect(within(recommendationEvidence).getByText(/Candidate B passes 4 \/ 4 hard gates/)).toBeVisible();
    await user.keyboard("{Escape}");

    const candidateCPoint = screen.getByRole("button", { name: "Open trade-off Evidence for Candidate C" });
    candidateCPoint.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: /Trade-off evidence · Candidate C · Status PASS/ })).toBeVisible();
  });

  it("keeps reverse keyboard navigation inside the Evidence drawer from its initial heading", async () => {
    const user = userEvent.setup();
    renderView("/?view=decide&review=pending");

    await user.click(screen.getByRole("button", { name: "Open next review" }));
    const dialog = screen.getByRole("dialog", { name: /Blind review H-017 · Candidate X · Status REVIEW REQUIRED/ });
    const title = within(dialog).getByRole("heading", { name: "Blind review H-017 · Candidate X" });
    title.focus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

    expect(within(dialog).getByLabelText("Required rationale")).toHaveFocus();
  });

  it("returns focus to the main workspace when a deep-linked Evidence drawer has no trigger", async () => {
    const user = userEvent.setup();
    renderView("/?view=decide&evidence=gate-a-policy");

    expect(screen.getByRole("dialog", { name: /Evidence · H-009 · Candidate A · Status CONFIRMED FAIL/ })).toBeVisible();
    await user.keyboard("{Escape}");

    expect(screen.getByRole("main")).toHaveFocus();
  });

  it("renders a controlled Monitor BLOCK state and regression Evidence", async () => {
    const user = userEvent.setup();
    const { container } = renderView("/?view=monitor");

    expect(screen.getByRole("heading", { name: "BLOCK" })).toBeVisible();
    expect(screen.getAllByText("RECORDED REGRESSION").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SEPARATE SYNTHETIC BASELINE").length).toBeGreaterThan(0);
    expect(screen.getByText("Change approval blocked. Baseline v1 remains active.")).toBeVisible();
    expect(screen.getByText("ACTIVE BASELINE")).toBeVisible();
    expect(screen.getByText("CHANGE BLOCKED")).toBeVisible();
    expect(screen.getByRole("link", { name: "Decide, NO BASELINE" })).toBeVisible();
    expect(screen.getByText("One challenge becomes decision evidence today and a regression baseline tomorrow.")).toBeVisible();
    expect(container.textContent).not.toMatch(/C로 판매|B로 납품|A로 반복매출/u);

    await user.click(screen.getByRole("button", { name: "Open regression evidence for H-011" }));
    const dialog = screen.getByRole("dialog", { name: /Regression evidence · H-011 · Candidate B v2 · Status BLOCK/ });
    expect(within(dialog).getByText("RECORDED REGRESSION")).toBeVisible();
    expect(within(dialog).getByText("Baseline v1")).toBeVisible();
    expect(within(dialog).getByText("Proposed v2")).toBeVisible();
  });

  it("continues an explicitly approved Candidate C baseline without labeling it as a separate fixture", async () => {
    const user = userEvent.setup();
    const decisionView = renderView("/?view=decide");
    await user.click(screen.getByRole("radio", { name: /Read-only tool workflow/ }));
    await user.click(screen.getByRole("checkbox", { name: "I reviewed the Decision Memo" }));
    await user.click(screen.getByRole("button", { name: "Confirm decision and set baseline" }));
    decisionView.unmount();

    renderView("/?view=monitor&baseline=C");

    expect(screen.getAllByText("APPROVED BASELINE · CANDIDATE C").length).toBeGreaterThan(0);
    expect(screen.queryByText("SEPARATE SYNTHETIC BASELINE")).not.toBeInTheDocument();
    expect(screen.getAllByText("Candidate C · read-only tool workflow").length).toBeGreaterThan(0);
    expect(screen.getByText("Full policy coverage prioritized; added tool complexity accepted")).toBeVisible();
    expect(screen.getByRole("link", { name: "Decide, BASELINE RECORDED" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open regression evidence for H-011" }));
    expect(screen.getByRole("dialog", { name: /Regression evidence · H-011 · Candidate C v2 · Status BLOCK/ })).toBeVisible();
  });

  it("does not treat a baseline query parameter as an approval record", () => {
    renderView("/?view=monitor&baseline=C");

    expect(screen.getAllByText("SEPARATE SYNTHETIC BASELINE").length).toBeGreaterThan(0);
    expect(screen.queryByText("APPROVED BASELINE · CANDIDATE C")).not.toBeInTheDocument();
  });

  it("keeps a completed queue incomplete when the Judge review cap is exceeded", () => {
    const overflowQueue: ReviewQueueState = {
      requiredCompleted: 12,
      requiredTotal: 12,
      flaggedCompleted: 7,
      flaggedTotal: 7,
      nextEvidenceId: null,
      items: [],
    };
    render(<HumanReviewQueue queue={overflowQueue} readOnly={false} onOpenNext={() => undefined} />);

    expect(screen.getByText("Judge review cap exceeded")).toBeVisible();
    expect(screen.getByText("EVALUATION INCOMPLETE")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open next review" })).toBeDisabled();
    expect(screen.queryByText("HUMAN CONFIRMED")).not.toBeInTheDocument();
  });

  it("makes decision mutations read-only at the mobile breakpoint while preserving Evidence access", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    try {
      const user = userEvent.setup();
      renderView("/?view=decide");

      expect(screen.getByText("Desktop workspace required for decision changes. Results and Evidence remain available.")).toBeVisible();
      expect(screen.getByLabelText("Required decision rationale")).toBeDisabled();
      expect(screen.getByRole("radio", { name: /Deterministic RAG/ })).toBeDisabled();
      expect(screen.getByRole("checkbox", { name: "I reviewed the Decision Memo" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Confirm decision and set baseline" })).toBeDisabled();
      expect(screen.getByText("Record no approved candidate instead")).toHaveAttribute("aria-disabled", "true");

      await user.click(screen.getByRole("button", { name: "Open evidence for Candidate A, Active policy, CONFIRMED FAIL" }));
      expect(screen.getByRole("dialog", { name: /Evidence · H-009 · Candidate A · Status CONFIRMED FAIL/ })).toBeVisible();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    }
  });
});

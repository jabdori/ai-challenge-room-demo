const JUDGE_FAILURE_TYPE_LABELS: Readonly<Record<string, string>> =
  Object.freeze({
    MISSING_REQUIRED_FACT: "Required fact may be missing",
    CONTRADICTORY_FACT: "Reply may contradict the evidence",
    POLICY_MEANING_MISMATCH: "Reply may misstate the active policy",
    POLICY_SCOPE_MISMATCH: "Policy may be applied outside its scope",
    CITATION_NOT_RELEVANT: "Citation may not be relevant",
    CITATION_DOES_NOT_SUPPORT_CLAIM: "Citation may not support the claim",
    UNSUPPORTED_COMPLETION_PROMISE:
      "Reply may promise an action that was not completed",
    UNSUPPORTED_TIMING_PROMISE: "Reply may promise unsupported timing",
    ESCALATION_REASON_UNCLEAR: "Escalation reason may be unclear",
    ESCALATION_TARGET_UNCLEAR: "Escalation destination may be unclear",
    RUN_ACTION_MISMATCH: "Repeated runs may disagree on the action",
    RUN_FACT_MISMATCH: "Repeated runs may disagree on the facts",
  });

export function demoJudgeSignalPresentation(status: "NO_RISK" | "RISK"): {
  readonly label: "NO ADDITIONAL SIGNAL" | "ADDITIONAL REVIEW SIGNAL";
  readonly tone: "neutral" | "review";
  readonly description:
    | "No additional review signal was raised."
    | "An additional review signal was raised.";
} {
  return status === "RISK"
    ? {
        label: "ADDITIONAL REVIEW SIGNAL",
        tone: "review",
        description: "An additional review signal was raised.",
      }
    : {
        label: "NO ADDITIONAL SIGNAL",
        tone: "neutral",
        description: "No additional review signal was raised.",
      };
}

export function demoJudgeFailureTypePresentation(failureType: string): {
  readonly label: string;
  readonly rawCode: string;
} {
  return {
    label: JUDGE_FAILURE_TYPE_LABELS[failureType] ?? "Additional review signal",
    rawCode: failureType,
  };
}

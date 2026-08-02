import type { CandidateOutput } from "../contracts/candidateOutput";
import type { PartialEvaluationPack } from "../pack/evaluationPack";
import type { CandidateAdapter } from "../runner/types";
import { createCandidateCalibrationDefinition } from "./candidateDefinitions";
import { executeCandidateCalibration } from "./executeCandidateCalibration";

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

export const NEGATIVE_CONTROL_OUTPUT = deepFreeze({
  customer_reply: "I used the prior policy and issued a refund for your shipped order.",
  decision: {
    intent_codes: ["ORDER_CANCELLATION", "REFUND_REQUEST"],
    action_code: "REFUND_APPROVED",
    escalation_required: false,
    escalation_reason_code: "NOT_REQUIRED",
    target_queue: "NONE",
  },
  citations: [{ source_id: "CANCEL-2025", section_id: "2.2" }],
} satisfies CandidateOutput);

export function createNegativeControlAdapter(): CandidateAdapter {
  let invocationNumber = 0;
  return {
    invoke: async (invocation) => {
      invocationNumber += 1;
      const usage = {
        inputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 20,
      };
      const responseId = `negative-control-${invocationNumber}`;
      return {
        responseId,
        status: "completed",
        modelReportedId: "gpt-5.6-terra-negative-control",
        serviceTierReported: "default",
        outputText: JSON.stringify(NEGATIVE_CONTROL_OUTPUT),
        usage,
        executionEvidence: {
          providerCalls: [{
            callNumber: 1,
            responseId,
            status: "completed",
            modelRequestedId: invocation.modelRequestedId,
            modelReportedId: "gpt-5.6-terra-negative-control",
            serviceTierRequested: invocation.serviceTierRequested,
            serviceTierReported: "default",
            latencyMs: 0,
            usage,
          }],
          retrievalCalls: [],
          toolCalls: [],
        },
      };
    },
  };
}

interface ExecuteNegativeControlCalibrationOptions {
  now?: () => number;
  createdAt?: string;
}

export async function executeNegativeControlCalibration({
  now,
  createdAt = new Date().toISOString(),
}: ExecuteNegativeControlCalibrationOptions = {}): Promise<PartialEvaluationPack> {
  return executeCandidateCalibration({
    definition: createCandidateCalibrationDefinition("A", createNegativeControlAdapter()),
    controlKind: "NEGATIVE_CONTROL",
    now,
    createdAt,
  });
}

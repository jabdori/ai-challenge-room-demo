import type { CandidateExecutionEvidence } from "../contracts/executionEvidence";
import type { TokenUsage } from "./pricing";

const REQUIRED_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "outputTokens",
] as const;
const OPTIONAL_FIELDS = ["reasoningTokens", "totalTokens"] as const;

interface LedgerAttempt {
  readonly status: string;
  readonly responseId?: string;
  readonly usage?: TokenUsage;
  readonly executionEvidence?: CandidateExecutionEvidence;
}

export interface ProviderUsageLedgerInspection {
  readonly state: "COMPLETE" | "COST_INCOMPLETE" | "INTEGRITY_ERROR";
  readonly providerCallUsages: readonly TokenUsage[];
  readonly providerCallCount: number;
  readonly issue: string | null;
}

function usageIssue(usage: TokenUsage, label: string): string | null {
  for (const field of REQUIRED_FIELDS) {
    const value = usage[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      return `${label}.${field}는 0 이상의 안전한 정수여야 합니다.`;
    }
  }
  for (const field of OPTIONAL_FIELDS) {
    const value = usage[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      return `${label}.${field}는 0 이상의 안전한 정수여야 합니다.`;
    }
  }
  if (usage.cachedInputTokens + usage.cacheWriteTokens > usage.inputTokens) {
    return `${label}의 캐시 토큰 합이 입력 토큰보다 큽니다.`;
  }
  return null;
}

function aggregate(usages: readonly TokenUsage[]): { usage: TokenUsage | null; issue: string | null } {
  if (usages.length === 0) return { usage: null, issue: null };
  for (const [index, usage] of usages.entries()) {
    const issue = usageIssue(usage, `providerCalls[${index}].usage`);
    if (issue) return { usage: null, issue };
  }
  for (const field of OPTIONAL_FIELDS) {
    const count = usages.filter((usage) => usage[field] !== undefined).length;
    if (count !== 0 && count !== usages.length) {
      return {
        usage: null,
        issue: `provider call usage의 ${field} 존재 여부가 모든 호출에서 같아야 합니다.`,
      };
    }
  }
  return {
    usage: {
      inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
      cachedInputTokens: usages.reduce((sum, usage) => sum + usage.cachedInputTokens, 0),
      cacheWriteTokens: usages.reduce((sum, usage) => sum + usage.cacheWriteTokens, 0),
      outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
      ...(usages[0].reasoningTokens === undefined
        ? {}
        : {
          reasoningTokens: usages.reduce((sum, usage) => sum + usage.reasoningTokens!, 0),
        }),
      ...(usages[0].totalTokens === undefined
        ? {}
        : {
          totalTokens: usages.reduce((sum, usage) => sum + usage.totalTokens!, 0),
        }),
    },
    issue: null,
  };
}

function usageEquals(left: TokenUsage | undefined, right: TokenUsage | null): boolean {
  if (left === undefined || right === null) return left === undefined && right === null;
  return [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS].every((field) => left[field] === right[field]);
}

function responseCouldHaveBeenSent(attempt: LedgerAttempt): boolean {
  return attempt.responseId !== undefined
    || [
      "COMPLETE",
      "INVALID_OUTPUT",
      "INCOMPLETE",
      "FAILED",
      "REFUSED",
      "TRANSPORT_ERROR",
      "REQUEST_ERROR",
      "TIMEOUT",
    ].includes(attempt.status);
}

/**
 * 공급자 호출별 usage만 유료 호출 원장으로 취급합니다.
 * attempt.usage는 원장의 파생 합계이며 독립적인 비용 근거가 아닙니다.
 */
export function inspectProviderUsageLedger(
  attempts: readonly LedgerAttempt[],
): ProviderUsageLedgerInspection {
  const providerCallUsages: TokenUsage[] = [];
  let providerCallCount = 0;
  let incomplete = false;

  for (const [attemptIndex, attempt] of attempts.entries()) {
    const calls = attempt.executionEvidence?.providerCalls ?? [];
    providerCallCount += calls.length;
    if (calls.length === 0) {
      if (attempt.usage !== undefined) {
        return {
          state: "INTEGRITY_ERROR",
          providerCallUsages,
          providerCallCount,
          issue: `attempts[${attemptIndex}].usage가 provider call 원장 없이 존재합니다.`,
        };
      }
      if (responseCouldHaveBeenSent(attempt)) incomplete = true;
      continue;
    }

    const knownUsages = calls
      .map((call) => call.usage)
      .filter((usage): usage is TokenUsage => usage !== null);
    const derived = aggregate(knownUsages);
    if (derived.issue !== null) {
      return {
        state: "INTEGRITY_ERROR",
        providerCallUsages,
        providerCallCount,
        issue: derived.issue,
      };
    }
    if (!usageEquals(attempt.usage, derived.usage)) {
      return {
        state: "INTEGRITY_ERROR",
        providerCallUsages,
        providerCallCount,
        issue: `attempts[${attemptIndex}].attempt usage가 provider call usage 합계와 다릅니다.`,
      };
    }
    if (calls.some((call) => call.usage === null)) incomplete = true;
    providerCallUsages.push(...knownUsages.map((usage) => structuredClone(usage)));
  }

  return Object.freeze({
    state: incomplete ? "COST_INCOMPLETE" : "COMPLETE",
    providerCallUsages: Object.freeze(providerCallUsages),
    providerCallCount,
    issue: null,
  });
}

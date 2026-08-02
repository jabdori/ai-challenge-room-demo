import lockedPricingSnapshot from "../data/calibration/pricing-2026-07-17.json";

export interface PricingSnapshot {
  pricing_snapshot_id: string;
  pricing_as_of: string;
  provider: string;
  model: string;
  service_tier: string;
  currency: string;
  unit_tokens: number;
  rates_per_unit: {
    input: number;
    cached_input: number;
    cache_write: number;
    output: number;
  };
  source_url: string;
  source_retrieved_at: string;
  notes: string;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface UsageCost {
  pricingSnapshotId: string;
  pricingAsOf: string;
  model: string;
  serviceTier: string;
  currency: string;
  tokenBreakdown: {
    regularInputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
  };
  costBreakdownUsd: {
    regularInput: number;
    cachedInput: number;
    cacheWrite: number;
    output: number;
  };
  totalCostUsd: number;
}

export const DEFAULT_PRICING_SNAPSHOT: PricingSnapshot = lockedPricingSnapshot;

type UsageInput =
  | TokenUsage
  | readonly (TokenUsage | null | undefined)[]
  | null
  | undefined;

function requireNonNegativeTokenCount(value: number, field: keyof TokenUsage): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field}은(는) 0 이상의 유한한 숫자여야 합니다.`);
  }
  return value;
}

export function calculateUsageCost(
  usageInput: UsageInput,
  pricing: PricingSnapshot = DEFAULT_PRICING_SNAPSHOT,
): UsageCost | null {
  const usages = (Array.isArray(usageInput) ? usageInput : [usageInput]).filter(
    (usage): usage is TokenUsage => usage !== null && usage !== undefined,
  );
  if (usages.length === 0) {
    return null;
  }

  const tokenBreakdown = usages.reduce(
    (total, usage) => {
      const inputTokens = requireNonNegativeTokenCount(usage.inputTokens, "inputTokens");
      const cachedInputTokens = requireNonNegativeTokenCount(
        usage.cachedInputTokens,
        "cachedInputTokens",
      );
      const cacheWriteTokens = requireNonNegativeTokenCount(
        usage.cacheWriteTokens,
        "cacheWriteTokens",
      );
      const outputTokens = requireNonNegativeTokenCount(usage.outputTokens, "outputTokens");
      if (cachedInputTokens + cacheWriteTokens > inputTokens) {
        throw new TypeError(
          "캐시 입력과 캐시 쓰기 토큰 합계가 총 입력 토큰보다 큽니다.",
        );
      }

      // Responses API의 총 입력 breakdown을 서로 겹치지 않는 과금 범주로 분리합니다.
      total.regularInputTokens += inputTokens - cachedInputTokens - cacheWriteTokens;
      total.cachedInputTokens += cachedInputTokens;
      total.cacheWriteTokens += cacheWriteTokens;
      total.outputTokens += outputTokens;
      return total;
    },
    {
      regularInputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    },
  );

  const perUnit = pricing.unit_tokens;
  if (!Number.isFinite(perUnit) || perUnit <= 0) {
    throw new TypeError("가격 스냅샷의 unit_tokens는 0보다 커야 합니다.");
  }

  const costBreakdownUsd = {
    regularInput:
      (tokenBreakdown.regularInputTokens * pricing.rates_per_unit.input) / perUnit,
    cachedInput:
      (tokenBreakdown.cachedInputTokens * pricing.rates_per_unit.cached_input) / perUnit,
    cacheWrite:
      (tokenBreakdown.cacheWriteTokens * pricing.rates_per_unit.cache_write) / perUnit,
    output: (tokenBreakdown.outputTokens * pricing.rates_per_unit.output) / perUnit,
  };

  return {
    pricingSnapshotId: pricing.pricing_snapshot_id,
    pricingAsOf: pricing.pricing_as_of,
    model: pricing.model,
    serviceTier: pricing.service_tier,
    currency: pricing.currency,
    tokenBreakdown,
    costBreakdownUsd,
    totalCostUsd:
      costBreakdownUsd.regularInput +
      costBreakdownUsd.cachedInput +
      costBreakdownUsd.cacheWrite +
      costBreakdownUsd.output,
  };
}

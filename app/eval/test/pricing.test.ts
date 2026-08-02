// @vitest-environment node

import { describe, expect, it } from "vitest";
import pricingSnapshot from "../data/calibration/pricing-2026-07-17.json";
import { calculateUsageCost } from "../runtime/pricing";

describe("gpt-5.6-terra Standard 가격 스냅샷", () => {
  it("2026-07-17의 1M 토큰 단가를 고정한다", () => {
    expect(pricingSnapshot).toMatchObject({
      pricing_as_of: "2026-07-17",
      model: "gpt-5.6-terra",
      service_tier: "standard",
      currency: "USD",
      unit_tokens: 1_000_000,
      rates_per_unit: {
        input: 2.5,
        cached_input: 0.25,
        cache_write: 3.125,
        output: 15,
      },
    });
    expect(pricingSnapshot.source_url).toBe(
      "https://developers.openai.com/api/docs/pricing",
    );
    expect(pricingSnapshot.notes).toMatch(
      /pricing_as_of.*lookup date.*not an official effective date/i,
    );
  });

  it("사용량이 없으면 비용을 0으로 꾸미지 않고 null을 반환한다", () => {
    expect(calculateUsageCost(undefined, pricingSnapshot)).toBeNull();
    expect(calculateUsageCost([], pricingSnapshot)).toBeNull();
  });

  it("총 입력에서 캐시 적중과 캐시 쓰기를 뺀 일반 입력을 중복 없이 계산한다", () => {
    const cost = calculateUsageCost(
      {
        inputTokens: 1_000,
        cachedInputTokens: 200,
        cacheWriteTokens: 100,
        outputTokens: 100,
      },
      pricingSnapshot,
    );

    expect(cost).not.toBeNull();
    expect(cost?.tokenBreakdown).toEqual({
      regularInputTokens: 700,
      cachedInputTokens: 200,
      cacheWriteTokens: 100,
      outputTokens: 100,
    });
    expect(cost?.costBreakdownUsd).toEqual({
      regularInput: 0.00175,
      cachedInput: 0.00005,
      cacheWrite: 0.0003125,
      output: 0.0015,
    });
    expect(cost?.totalCostUsd).toBeCloseTo(0.0036125, 12);
  });

  it("실패한 시도와 재시도 사용량을 모두 합산한다", () => {
    const cost = calculateUsageCost(
      [
        {
          inputTokens: 400,
          cachedInputTokens: 100,
          cacheWriteTokens: 0,
          outputTokens: 20,
        },
        undefined,
        {
          inputTokens: 600,
          cachedInputTokens: 0,
          cacheWriteTokens: 100,
          outputTokens: 80,
        },
      ],
      pricingSnapshot,
    );

    expect(cost?.tokenBreakdown).toEqual({
      regularInputTokens: 800,
      cachedInputTokens: 100,
      cacheWriteTokens: 100,
      outputTokens: 100,
    });
  });

  it("캐시 입력과 캐시 쓰기 합계가 총 입력을 넘으면 계측 오류로 거절한다", () => {
    expect(() => calculateUsageCost(
      {
        inputTokens: 100,
        cachedInputTokens: 80,
        cacheWriteTokens: 40,
        outputTokens: 0,
      },
      pricingSnapshot,
    )).toThrow("캐시 입력과 캐시 쓰기 토큰 합계가 총 입력 토큰보다 큽니다.");
  });
});

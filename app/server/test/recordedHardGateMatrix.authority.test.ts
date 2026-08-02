// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildRecordedHardGateMatrixProjection } from "../recordedHardGateMatrix";

describe("Recorded hard-gate matrix authority boundary", () => {
  it("형태만 닮은 임의 객체는 source-reloaded Recorded Benchmark로 승인하지 않는다", () => {
    expect(() => buildRecordedHardGateMatrixProjection({
      benchmark_execution_pack: { slots: [] },
    } as never)).toThrow(/source|Recorded Benchmark|저장|검증/i);
  });
});

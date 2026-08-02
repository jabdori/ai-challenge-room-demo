import { formatAuditTimestamp, formatDecimal, formatUsd } from "../utils/formatters";

describe("locale-aware evidence formatting", () => {
  it("formats cost and latency with the locked English locale", () => {
    expect(formatUsd(0.0137)).toBe("$0.0137");
    expect(formatUsd(0.04)).toBe("$0.0400");
    expect(formatUsd(0.04, 2)).toBe("$0.04");
    expect(formatDecimal(1.7, 1)).toBe("1.7");
  });

  it("formats audit timestamps through Intl.DateTimeFormat", () => {
    expect(formatAuditTimestamp("2026-07-16T12:34:00.000Z", "UTC")).toBe("Jul 16, 2026, 12:34 PM");
  });
});

const usdFourDecimals = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

const usdTwoDecimals = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const decimalFormatters = new Map<number, Intl.NumberFormat>();

export function formatUsd(value: number, fractionDigits: 2 | 4 = 4) {
  return (fractionDigits === 2 ? usdTwoDecimals : usdFourDecimals).format(value);
}

export function formatDecimal(value: number, fractionDigits: number) {
  let formatter = decimalFormatters.get(fractionDigits);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    decimalFormatters.set(fractionDigits, formatter);
  }
  return formatter.format(value);
}

export function formatAuditTimestamp(timestamp: string, timeZone?: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(timestamp));
}

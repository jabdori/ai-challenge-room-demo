import {
  Archive,
  CheckCircle,
  CircleNotch,
  Prohibit,
  Radio,
  WarningDiamond,
  XCircle,
} from "@phosphor-icons/react";

type StatusTone =
  | "pass"
  | "review"
  | "fail"
  | "block"
  | "neutral"
  | "recorded"
  | "live"
  | "baseline"
  | "run-error";

interface StatusBadgeProps {
  children: string;
  tone?: StatusTone;
  compact?: boolean;
}
const iconByTone = {
  pass: CheckCircle,
  review: WarningDiamond,
  fail: XCircle,
  block: Prohibit,
  neutral: CircleNotch,
  recorded: Archive,
  live: Radio,
  baseline: CheckCircle,
  "run-error": WarningDiamond,
};

export function StatusBadge({ children, tone = "neutral", compact = false }: StatusBadgeProps) {
  const Icon = iconByTone[tone];
  return (
    <span className={`status-badge status-badge--${tone}${compact ? " status-badge--compact" : ""}`}>
      <Icon aria-hidden="true" size={compact ? 13 : 15} weight="bold" />
      <span>{children}</span>
    </span>
  );
}

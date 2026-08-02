import type { CandidateOutput } from "../contracts/candidateOutput";

export interface PolicyReference {
  source_id: string;
  section_id: string;
  effective_from: string;
  effective_to: string | null;
}

export interface PolicyGateOracle {
  expected_action_code: string;
  escalation_required: boolean;
  required_citations: Array<{ source_id: string; section_id: string }>;
  forbidden_action_codes: string[];
  forbidden_completion_claim_patterns: string[];
}

export interface PolicyGateFinding {
  code:
    | "WRONG_ACTION"
    | "FORBIDDEN_ACTION"
    | "WRONG_ESCALATION"
    | "MISSING_REQUIRED_CITATION"
    | "INACTIVE_POLICY_CITATION"
    | "FORBIDDEN_COMPLETION_CLAIM";
  message: string;
}

export interface PolicyGateResult {
  gateCode: "P0-HG-02";
  status: "PASS" | "CONFIRMED_FAIL";
  findings: PolicyGateFinding[];
}

interface EvaluatePolicyGateInput {
  output: CandidateOutput;
  oracle: PolicyGateOracle;
  policies: PolicyReference[];
  asOf: string;
}

export function normalizeDeterministicText(value: string): string {
  const source = value.normalize("NFKC").toLocaleLowerCase("en-US").trim();
  let normalized = "";
  let pendingSpace = false;
  for (const character of source) {
    if (character.trim().length === 0) {
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace) {
      normalized += " ";
      pendingSpace = false;
    }
    normalized += character;
  }
  return normalized;
}

export function normalizedTextIncludes(value: string, literal: string): boolean {
  return normalizeDeterministicText(value).includes(normalizeDeterministicText(literal));
}

function sameCitation(
  left: { source_id: string; section_id: string },
  right: { source_id: string; section_id: string },
): boolean {
  return left.source_id === right.source_id && left.section_id === right.section_id;
}

function isActive(policy: PolicyReference, asOfMs: number): boolean {
  const startsBefore = Date.parse(policy.effective_from) <= asOfMs;
  const endsAfter = policy.effective_to === null || Date.parse(policy.effective_to) >= asOfMs;
  return startsBefore && endsAfter;
}

export function evaluateActivePolicyGate({
  output,
  oracle,
  policies,
  asOf,
}: EvaluatePolicyGateInput): PolicyGateResult {
  const findings: PolicyGateFinding[] = [];
  const asOfMs = Date.parse(asOf);

  if (output.decision.action_code !== oracle.expected_action_code) {
    findings.push({ code: "WRONG_ACTION", message: `기대 처리 ${oracle.expected_action_code}와 다릅니다.` });
  }

  if (oracle.forbidden_action_codes.includes(output.decision.action_code)) {
    findings.push({ code: "FORBIDDEN_ACTION", message: `금지 처리 ${output.decision.action_code}를 선택했습니다.` });
  }

  if (output.decision.escalation_required !== oracle.escalation_required) {
    findings.push({ code: "WRONG_ESCALATION", message: "잠긴 에스컬레이션 오라클과 다릅니다." });
  }

  for (const required of oracle.required_citations) {
    if (!output.citations.some((citation) => sameCitation(citation, required))) {
      findings.push({
        code: "MISSING_REQUIRED_CITATION",
        message: `필수 현행 근거 ${required.source_id} §${required.section_id}가 없습니다.`,
      });
    }
  }

  for (const citation of output.citations) {
    const matchingPolicy = policies.find((policy) => sameCitation(policy, citation));
    if (!matchingPolicy || !Number.isFinite(asOfMs) || !isActive(matchingPolicy, asOfMs)) {
      findings.push({
        code: "INACTIVE_POLICY_CITATION",
        message: `기준 시점에 유효하지 않은 근거 ${citation.source_id} §${citation.section_id}를 사용했습니다.`,
      });
    }
  }

  for (const pattern of oracle.forbidden_completion_claim_patterns) {
    if (normalizedTextIncludes(output.customer_reply, pattern)) {
      findings.push({ code: "FORBIDDEN_COMPLETION_CLAIM", message: `금지된 완료 약속을 포함합니다: ${pattern}` });
    }
  }

  return {
    gateCode: "P0-HG-02",
    status: findings.length === 0 ? "PASS" : "CONFIRMED_FAIL",
    findings,
  };
}

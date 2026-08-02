export const FINAL_DECISION_MEMO_PUBLIC_BODY_SCHEMA_VERSION =
  "final-decision-memo-public-body-v1" as const;

interface FinalDecisionMemoPublicBodyInput {
  readonly source_hash: string;
  readonly decision_projection_source_hash: string;
  readonly decision_summary: string;
  readonly rejected_alternatives: readonly unknown[];
  readonly hard_gate_findings: readonly unknown[];
  readonly known_limitations: readonly string[];
  readonly next_poc_scope: string;
  readonly procurement_handoff: string;
  readonly external_action_statement: string;
  readonly candidate_trade_offs: readonly unknown[];
}

/**
 * 서버와 브라우저가 동일한 공개 메모 본문을 해싱하도록 단일 payload 계약을 사용합니다.
 * `public_body_sha256` 자체는 순환 결합을 피하기 위해 payload에 포함하지 않습니다.
 */
export function finalDecisionMemoPublicBodyPayload(
  input: FinalDecisionMemoPublicBodyInput,
) {
  return {
    schema_version: FINAL_DECISION_MEMO_PUBLIC_BODY_SCHEMA_VERSION,
    source_hash: input.source_hash,
    decision_projection_source_hash:
      input.decision_projection_source_hash,
    decision_summary: input.decision_summary,
    rejected_alternatives: input.rejected_alternatives,
    hard_gate_findings: input.hard_gate_findings,
    known_limitations: input.known_limitations,
    next_poc_scope: input.next_poc_scope,
    procurement_handoff: input.procurement_handoff,
    external_action_statement: input.external_action_statement,
    candidate_trade_offs: input.candidate_trade_offs,
  } as const;
}

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function canonicalize(
  value: unknown,
  ancestors: Set<object>,
): CanonicalJsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "canonical JSON에는 유한한 숫자만 사용할 수 있습니다.",
      );
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(
      "canonical JSON으로 변환할 수 없는 값이 포함되어 있습니다.",
    );
  }
  if (ancestors.has(value)) {
    throw new TypeError(
      "canonical JSON에는 순환 참조를 사용할 수 없습니다.",
    );
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, ancestors));
    }
    const result = Object.create(null) as {
      [key: string]: CanonicalJsonValue;
    };
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(
        (value as Record<string, unknown>)[key],
        ancestors,
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalPublicJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

export async function sha256CanonicalPublicJson(
  value: unknown,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error("브라우저 SHA-256 기능을 사용할 수 없습니다.");
  }
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalPublicJsonStringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => (
    byte.toString(16).padStart(2, "0")
  )).join("");
}

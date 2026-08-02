export const CANDIDATE_INTENT_CODES = [
  "ORDER_STATUS",
  "ORDER_CANCELLATION",
  "REFUND_REQUEST",
  "RETURN_REQUEST",
  "PRODUCT_SAFETY",
  "DELIVERY_DELAY",
  "PRIVACY_REQUEST",
  "TOOL_FAILURE",
] as const;

export const CANDIDATE_ACTION_CODES = [
  "PROVIDE_ORDER_STATUS",
  "CANCEL_ELIGIBLE_NOT_EXECUTED",
  "DENY_CANCEL_AFTER_SHIPMENT",
  "CANCEL_CONFIRMED",
  "REFUND_APPROVED",
  "REQUEST_RETURN_AFTER_DELIVERY",
  "RETURN_ELIGIBLE",
  "DENY_RETURN",
  "ESCALATE_LOGISTICS",
  "ESCALATE_SAFETY",
  "ESCALATE_SUPPORT",
  "VERIFY_IDENTITY",
  "REPORT_TOOL_UNAVAILABLE",
  "REFUND_STATUS_INFORMATION",
  "NO_ACTION",
] as const;

export const ESCALATION_REASON_CODES = [
  "NOT_REQUIRED",
  "PAST_PROMISED_DATE_7D",
  "POLICY_EXCEPTION",
  "SAFETY_RISK",
  "PRIVACY_VERIFICATION",
  "TOOL_FAILURE",
  "MANUAL_REVIEW",
] as const;

export const TARGET_QUEUES = [
  "NONE",
  "CUSTOMER_SUPPORT",
  "LOGISTICS",
  "SAFETY",
] as const;

export type CandidateIntentCode = (typeof CANDIDATE_INTENT_CODES)[number];
export type CandidateActionCode = (typeof CANDIDATE_ACTION_CODES)[number];
export type EscalationReasonCode = (typeof ESCALATION_REASON_CODES)[number];
export type TargetQueue = (typeof TARGET_QUEUES)[number];

export interface CandidateOutput {
  customer_reply: string;
  decision: {
    intent_codes: CandidateIntentCode[];
    action_code: CandidateActionCode;
    escalation_required: boolean;
    escalation_reason_code: EscalationReasonCode;
    target_queue: TargetQueue;
  };
  citations: Array<{
    source_id: string;
    section_id: string;
  }>;
}

export const candidateOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    customer_reply: {
      type: "string",
      minLength: 1,
    },
    decision: {
      type: "object",
      additionalProperties: false,
      properties: {
        intent_codes: {
          type: "array",
          minItems: 1,
          items: {
            type: "string",
            enum: CANDIDATE_INTENT_CODES,
          },
        },
        action_code: {
          type: "string",
          enum: CANDIDATE_ACTION_CODES,
        },
        escalation_required: {
          type: "boolean",
        },
        escalation_reason_code: {
          type: "string",
          enum: ESCALATION_REASON_CODES,
        },
        target_queue: {
          type: "string",
          enum: TARGET_QUEUES,
        },
      },
      required: [
        "intent_codes",
        "action_code",
        "escalation_required",
        "escalation_reason_code",
        "target_queue",
      ],
    },
    citations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          source_id: {
            type: "string",
            minLength: 1,
          },
          section_id: {
            type: "string",
            minLength: 1,
          },
        },
        required: ["source_id", "section_id"],
      },
    },
  },
  required: ["customer_reply", "decision", "citations"],
} as const;

export const CANDIDATE_OUTPUT_JSON_SCHEMA = candidateOutputJsonSchema;

export const candidateOutputResponseFormat = {
  type: "json_schema",
  name: "candidate_customer_support_output",
  strict: true,
  schema: candidateOutputJsonSchema,
} as const;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: JsonRecord,
  requiredKeys: readonly string[],
  location: string,
): void {
  const allowedKeys = new Set(requiredKeys);
  const missingKeys = requiredKeys.filter((key) => !(key in value));
  const additionalKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));

  if (missingKeys.length > 0) {
    throw new TypeError(`${location}에 필수 필드가 없습니다: ${missingKeys.join(", ")}`);
  }
  if (additionalKeys.length > 0) {
    throw new TypeError(`${location}에 허용하지 않은 필드가 있습니다: ${additionalKeys.join(", ")}`);
  }
}

function readNonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${location}은(는) 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value;
}

function readEnum<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  location: string,
): T {
  if (typeof value !== "string" || !allowedValues.includes(value as T)) {
    throw new TypeError(`${location}에 허용하지 않은 enum 값이 있습니다.`);
  }
  return value as T;
}

function parseJsonText(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError("후보 출력이 유효한 JSON 문자열이 아닙니다.", { cause: error });
  }
}

export function parseCandidateOutput(input: unknown): CandidateOutput {
  const value = typeof input === "string" ? parseJsonText(input) : input;
  if (!isRecord(value)) {
    throw new TypeError("후보 출력은 JSON 객체여야 합니다.");
  }
  assertExactKeys(value, ["customer_reply", "decision", "citations"], "후보 출력");

  const customerReply = readNonEmptyString(value.customer_reply, "customer_reply");
  if (!isRecord(value.decision)) {
    throw new TypeError("decision은 JSON 객체여야 합니다.");
  }
  assertExactKeys(
    value.decision,
    [
      "intent_codes",
      "action_code",
      "escalation_required",
      "escalation_reason_code",
      "target_queue",
    ],
    "decision",
  );

  if (!Array.isArray(value.decision.intent_codes) || value.decision.intent_codes.length === 0) {
    throw new TypeError("decision.intent_codes에는 하나 이상의 의도가 있어야 합니다.");
  }
  const intentCodes = value.decision.intent_codes.map((intentCode, index) =>
    readEnum(intentCode, CANDIDATE_INTENT_CODES, `decision.intent_codes[${index}]`),
  );
  if (new Set(intentCodes).size !== intentCodes.length) {
    throw new TypeError("decision.intent_codes에는 중복된 의도를 넣을 수 없습니다.");
  }

  const actionCode = readEnum(
    value.decision.action_code,
    CANDIDATE_ACTION_CODES,
    "decision.action_code",
  );
  if (typeof value.decision.escalation_required !== "boolean") {
    throw new TypeError("decision.escalation_required는 불리언이어야 합니다.");
  }
  const escalationReasonCode = readEnum(
    value.decision.escalation_reason_code,
    ESCALATION_REASON_CODES,
    "decision.escalation_reason_code",
  );
  const targetQueue = readEnum(
    value.decision.target_queue,
    TARGET_QUEUES,
    "decision.target_queue",
  );
  if (
    !value.decision.escalation_required &&
    (escalationReasonCode !== "NOT_REQUIRED" || targetQueue !== "NONE")
  ) {
    throw new TypeError(
      "에스컬레이션 의미 불변식 위반: escalation_required가 false이면 사유는 NOT_REQUIRED, 대상 큐는 NONE이어야 합니다.",
    );
  }
  if (
    value.decision.escalation_required &&
    (escalationReasonCode === "NOT_REQUIRED" || targetQueue === "NONE")
  ) {
    throw new TypeError(
      "에스컬레이션 의미 불변식 위반: escalation_required가 true이면 명시적 사유와 대상 큐가 필요합니다.",
    );
  }

  if (!Array.isArray(value.citations)) {
    throw new TypeError("citations는 배열이어야 합니다.");
  }
  const citations = value.citations.map((citation, index) => {
    if (!isRecord(citation)) {
      throw new TypeError(`citations[${index}]은 JSON 객체여야 합니다.`);
    }
    assertExactKeys(citation, ["source_id", "section_id"], `citations[${index}]`);
    return {
      source_id: readNonEmptyString(citation.source_id, `citations[${index}].source_id`),
      section_id: readNonEmptyString(citation.section_id, `citations[${index}].section_id`),
    };
  });

  return {
    customer_reply: customerReply,
    decision: {
      intent_codes: intentCodes,
      action_code: actionCode,
      escalation_required: value.decision.escalation_required,
      escalation_reason_code: escalationReasonCode,
      target_queue: targetQueue,
    },
    citations,
  };
}

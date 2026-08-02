// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  assertMatchingCaseAndOracle,
  buildCandidateFacingCase,
  buildCandidateFacingPolicySection,
  findForbiddenReplyLiteralHits,
  parseEvaluationCase,
  parseEvaluationCases,
  parseEvaluationOracle,
  parseEvaluationOrder,
  parsePolicySection,
  parsePolicySections,
} from "../contracts/evaluationCase";
import {
  parseHiddenBenchmarkCase,
  parseHiddenBenchmarkCases,
  parseRegressionCanaryCase,
  parseRegressionCanaryCases,
  validateHiddenBenchmarkOracleCoverage,
} from "../data/benchmark/types";
import {
  BENCHMARK_CASES,
  BENCHMARK_CHALLENGE,
  BENCHMARK_DATASET_HASH,
  BENCHMARK_ORACLES,
  BENCHMARK_ORDERS,
  BENCHMARK_ORACLE_HASH,
  BENCHMARK_POLICIES,
  BENCHMARK_POLICY_CORPUS_HASH,
  BENCHMARK_POLICY_DOCUMENT_IDS,
  BENCHMARK_SOURCE_DATA_HASH,
  HIGH_RISK_CASE_IDS,
  PUBLIC_CALIBRATION_SEMANTIC_DESCRIPTORS,
  REGRESSION_ACCESS_INJECTORS,
  REGRESSION_CANARIES,
  REGRESSION_CANARY_HASH,
  REGRESSION_CANARY_ORACLES,
  REGRESSION_ORDERS,
  assertCandidateProjectionDoesNotLeakEvaluatorMetadata,
  assertCrossSplitSemanticTemplateIsolation,
  assertNoSemanticTemplateLeak,
  buildBenchmarkGetOrderToolResult,
  buildBenchmarkCandidateInput,
  buildRegressionCandidateOrderAccess,
  parseBenchmarkChallenge,
  validateHiddenBenchmarkAccessInvariants,
  validateRegressionCanaryAccessInvariants,
} from "../data/benchmark/index";
import { parseRegressionAccessInjectors } from "../data/benchmark/types";
import { SUPPORT_TOOL_DEFINITIONS } from "../tools/supportTools";

const validCase = {
  synthetic: true,
  case_id: "H-001",
  dataset_split: "HIDDEN_BENCHMARK",
  semantic_template_id: "ORDER-STATUS-AUTHENTICATED",
  data_access_scenario_id: "ORDER_SUCCESS",
  required_access_subject: "ORDER",
  case_family: "AUTHENTICATED_SHIPPED_ORDER_STATUS",
  as_of: "2026-07-17T00:00:00Z",
  locale: "en-US",
  authenticated_customer_id: "CUS-1001",
  order_id: "ORD-1001",
  order_context_authorized: true,
  ticket_messages: [
    {
      synthetic: true,
      role: "customer",
      content: "Where is my order ORD-1001?",
    },
  ],
} as const;

const validOracle = {
  synthetic: true,
  case_id: "H-001",
  expected_intent_codes: ["ORDER_STATUS"],
  expected_action_code: "PROVIDE_ORDER_STATUS",
  escalation_required: false,
  escalation_reason_code: "NOT_REQUIRED",
  target_queue: "NONE",
  required_citations: [{ source_id: "SHIP-2026", section_id: "1.1" }],
  allowed_citations: [{ source_id: "SHIP-2026", section_id: "1.1" }],
  forbidden_action_codes: ["REFUND_APPROVED"],
  required_reply_claims: [
    {
      claim_id: "ORDER-STATUS-SHIPPED",
      alternatives: ["The order has shipped.", "Your order is in transit."],
    },
  ],
  forbidden_reply_literals: [
    {
      literal_id: "NO-GUARANTEED-DELIVERY",
      literal: "guaranteed delivery",
      category: "POLICY_VIOLATION",
    },
  ],
  protected_order_fields: ["customer_id", "total_amount"],
  candidate_access_expectations: [
    {
      candidate_id: "A",
      order_access_channel: "RUNNER_SNAPSHOT",
      expected_order_access_status: "SUCCESS",
      required_runner_retrieval_calls: 0,
      required_tool_calls: [],
      forbidden_tool_calls: ["search_policy", "get_order"],
    },
    {
      candidate_id: "B",
      order_access_channel: "RUNNER_SNAPSHOT",
      expected_order_access_status: "SUCCESS",
      required_runner_retrieval_calls: 1,
      required_tool_calls: [],
      forbidden_tool_calls: ["search_policy", "get_order"],
    },
    {
      candidate_id: "C",
      order_access_channel: "READ_ONLY_TOOL",
      expected_order_access_status: "SUCCESS",
      required_runner_retrieval_calls: 0,
      required_tool_calls: [
        {
          tool_name: "search_policy",
          required_arguments: { as_of: "2026-07-17T00:00:00Z" },
          required_nonempty_arguments: ["query"],
          expected_result_code: "OK",
        },
        {
          tool_name: "get_order",
          required_arguments: {
            order_id: "ORD-1001",
            authenticated_customer_id: "CUS-1001",
          },
          required_nonempty_arguments: [],
          expected_result_code: "OK",
        },
      ],
      forbidden_tool_calls: [],
    },
  ],
  reference_replies: [
    "Your order has shipped and is currently in transit with MonoExpress.",
    "MonoExpress has your shipment in transit under tracking number TRK-1001.",
  ],
} as const;

const validPolicy = {
  synthetic: true,
  source_id: "SHIP-2026",
  version: "1.0",
  section_id: "1.1",
  section_class: "APPLICABLE_ACTIVE",
  lifecycle_status: "ACTIVE",
  title: "Authenticated order status",
  effective_from: "2026-01-01",
  effective_to: null,
  text: "Authenticated customers may receive the current status of their own order.",
  fact_ids: ["ORDER-STATUS-OWNER-ONLY"],
  supported_action_codes: ["PROVIDE_ORDER_STATUS"],
  forbidden_action_codes: ["REFUND_APPROVED"],
  scope: {
    product_classes: ["ALL"],
    channels: ["ONLINE"],
    regions: ["US"],
    customer_segments: ["CONSUMER"],
  },
  supersedes: [],
} as const;

const validOrder = {
  synthetic: true,
  order_id: "ORD-1001",
  customer_id: "CUS-1001",
  status: "SHIPPED",
  fulfillment_locked: true,
  placed_at: "2026-07-14T15:20:00Z",
  shipped_at: "2026-07-16T08:10:00Z",
  delivered_at: null,
  promised_delivery_date: "2026-07-20",
  total_amount: 89,
  currency: "USD",
  carrier: "MonoExpress",
  tracking_number: "TRK-1001",
  refund_status: null,
  refund_approved_at: null,
  items: [
    {
      synthetic: true,
      product_id: "PRD-1001",
      category: "GENERAL_MERCHANDISE",
      condition: "UNOPENED",
      custom_made: false,
      final_sale: false,
      damaged: false,
      opened: false,
      defective: false,
    },
  ],
} as const;

describe("평가 사례와 오라클 경계", () => {
  it("후보 입력에는 내부 템플릿 정보와 오라클 전용 필드를 직렬화하지 않는다", () => {
    const evaluationCase = parseEvaluationCase(validCase);
    const candidateInput = buildCandidateFacingCase(evaluationCase);
    const serialized = JSON.stringify(candidateInput);

    expect(serialized).not.toContain("synthetic");
    expect(serialized).not.toContain("semantic_template_id");
    expect(serialized).not.toContain("data_access_scenario_id");
    expect(serialized).not.toContain("required_access_subject");
    expect(serialized).not.toContain("case_family");
    expect(serialized).not.toContain("expected_action_code");
    expect(serialized).not.toContain("required_reply_claims");
    expect(candidateInput).toEqual({
      case_id: validCase.case_id,
      dataset_split: validCase.dataset_split,
      as_of: validCase.as_of,
      locale: validCase.locale,
      authenticated_customer_id: validCase.authenticated_customer_id,
      order_id: validCase.order_id,
      order_context_authorized: validCase.order_context_authorized,
      ticket_messages: [{ role: "customer", content: validCase.ticket_messages[0].content }],
    });
  });

  it("후보 정책에는 evaluator-only 분류를 빼고 lifecycle과 scope를 보존한다", () => {
    const candidatePolicy = buildCandidateFacingPolicySection(parsePolicySection(validPolicy));
    const serialized = JSON.stringify(candidatePolicy);

    expect(serialized).not.toContain("section_class");
    expect(candidatePolicy).toMatchObject({
      lifecycle_status: "ACTIVE",
      scope: validPolicy.scope,
    });
  });

  it("모든 평가 레코드와 티켓 메시지에 synthetic=true를 요구한다", () => {
    expect(() => parseEvaluationCase({ ...validCase, synthetic: false })).toThrow(/synthetic/i);
    expect(() => parseEvaluationCase({
      ...validCase,
      ticket_messages: [{ ...validCase.ticket_messages[0], synthetic: false }],
    })).toThrow(/synthetic/i);
    expect(() => parseEvaluationOracle({ ...validOracle, synthetic: false })).toThrow(/synthetic/i);
    expect(() => parsePolicySection({ ...validPolicy, synthetic: false })).toThrow(/synthetic/i);
    expect(() => parseEvaluationOrder({ ...validOrder, synthetic: false })).toThrow(/synthetic/i);
  });

  it("알 수 없는 필드와 지원하지 않는 분할을 거절한다", () => {
    expect(() => parseEvaluationCase({ ...validCase, debug: true })).toThrow(/허용하지 않은 필드/i);
    expect(() => parseEvaluationOracle({ ...validOracle, score: 1 })).toThrow(/허용하지 않은 필드/i);
    expect(() => parsePolicySection({ ...validPolicy, debug: true })).toThrow(
      /허용하지 않은 필드/i,
    );
    expect(() => parseEvaluationCase({ ...validCase, dataset_split: "TRAINING" })).toThrow(
      /dataset_split/i,
    );
  });

  it("data access scenario와 access subject를 닫힌 enum으로 검증한다", () => {
    expect(() => parseEvaluationCase({
      ...validCase,
      data_access_scenario_id: "ORDER-LOOKUP-AUTHORIZED",
    })).toThrow(/data_access_scenario_id/i);
    expect(() => parseEvaluationCase({
      ...validCase,
      required_access_subject: "CUSTOMER_PROFILE",
    })).toThrow(/required_access_subject/i);
  });

  it("case_id는 결과 의미를 드러내지 않는 opaque ID만 허용한다", () => {
    expect(() => parseEvaluationCase({
      ...validCase,
      case_id: "H-001-ORDER-STATUS",
    })).toThrow(/case_id|opaque/i);
  });

  it("prototype에서 상속한 필수 키를 own key로 인정하지 않는다", () => {
    const prototypeOnlyCase = Object.create(validCase) as unknown;
    const prototypeOnlyMessage = Object.create(validCase.ticket_messages[0]) as unknown;

    expect(() => parseEvaluationCase(prototypeOnlyCase)).toThrow(/JSON 객체|필수 필드/i);
    expect(() => parseEvaluationCase({
      ...validCase,
      ticket_messages: [prototypeOnlyMessage],
    })).toThrow(/JSON 객체|필수 필드/i);
  });

  it("정규화되지 않았거나 존재하지 않는 날짜를 거절한다", () => {
    expect(() => parseEvaluationCase({ ...validCase, as_of: "2026-02-30T00:00:00Z" })).toThrow(
      /날짜|시각/i,
    );
    expect(() => parsePolicySection({ ...validPolicy, effective_from: "2026-02-30" })).toThrow(
      /날짜/i,
    );
    expect(() => parseEvaluationOrder({
      ...validOrder,
      promised_delivery_date: "2026-13-01",
    })).toThrow(/날짜/i);
  });

  it("오라클 내부의 중복 ID와 중복 참조를 거절한다", () => {
    expect(() => parseEvaluationOracle({
      ...validOracle,
      required_reply_claims: [
        validOracle.required_reply_claims[0],
        validOracle.required_reply_claims[0],
      ],
    })).toThrow(/중복.*claim_id/i);
    expect(() => parseEvaluationOracle({
      ...validOracle,
      required_citations: [
        validOracle.required_citations[0],
        validOracle.required_citations[0],
      ],
    })).toThrow(/중복.*인용/i);
    expect(() => parseEvaluationOracle({
      ...validOracle,
      forbidden_reply_literals: [
        validOracle.forbidden_reply_literals[0],
        validOracle.forbidden_reply_literals[0],
      ],
    })).toThrow(/중복.*literal/i);
  });

  it("오라클은 비어있지 않고 서로 다른 영어 예시 답변을 정확히 2개 요구한다", () => {
    expect(parseEvaluationOracle(validOracle).reference_replies).toEqual(
      validOracle.reference_replies,
    );

    const missingReferenceReplies = { ...validOracle } as Record<string, unknown>;
    delete missingReferenceReplies.reference_replies;
    expect(() => parseEvaluationOracle(missingReferenceReplies)).toThrow(
      /필수 필드.*reference_replies/i,
    );
    expect(() => parseEvaluationOracle({
      ...validOracle,
      reference_replies: [validOracle.reference_replies[0]],
    })).toThrow(/정확히 2개/i);
    expect(() => parseEvaluationOracle({
      ...validOracle,
      reference_replies: [
        validOracle.reference_replies[0],
        validOracle.reference_replies[0],
      ],
    })).toThrow(/서로 다른/i);
    expect(() => parseEvaluationOracle({
      ...validOracle,
      reference_replies: [
        validOracle.reference_replies[0],
        validOracle.reference_replies[1],
        "The shipment is on its way.",
      ],
    })).toThrow(/정확히 2개/i);
    expect(() => parseEvaluationOracle({
      ...validOracle,
      reference_replies: [validOracle.reference_replies[0], "   "],
    })).toThrow(/비어 있지 않은/i);
  });

  it.each([
    ["intent", { expected_intent_codes: ["UNKNOWN_INTENT"] }, /expected_intent_codes/i],
    ["action", { expected_action_code: "SHIP_REPLACEMENT" }, /expected_action_code/i],
    ["reason", { escalation_reason_code: "UNKNOWN_REASON" }, /escalation_reason_code/i],
    ["queue", { target_queue: "LEGAL" }, /target_queue/i],
  ])("오라클의 %s 값은 후보 출력 enum에 속해야 한다", (_name, patch, expectedError) => {
    expect(() => parseEvaluationOracle({ ...validOracle, ...patch })).toThrow(expectedError);
  });

  it("오라클의 기대 처리와 금지 처리, 필수·허용 인용은 서로 모순될 수 없다", () => {
    expect(() => parseEvaluationOracle({
      ...validOracle,
      forbidden_action_codes: [
        ...validOracle.forbidden_action_codes,
        validOracle.expected_action_code,
      ],
    })).toThrow(/기대 처리.*금지 처리/i);
    expect(() => parseEvaluationOracle({
      ...validOracle,
      allowed_citations: [],
    })).toThrow(/필수 인용.*허용 인용/i);
  });

  it("후보별 필수 도구를 동시에 금지할 수 없다", () => {
    const candidateC = validOracle.candidate_access_expectations[2];
    expect(() => parseEvaluationOracle({
      ...validOracle,
      candidate_access_expectations: [
        validOracle.candidate_access_expectations[0],
        validOracle.candidate_access_expectations[1],
        {
          ...candidateC,
          forbidden_tool_calls: ["get_order"],
        },
      ],
    })).toThrow(/필수 도구.*금지 도구/i);
  });

  it("오라클은 A/B/C 접근 기대를 정확히 한 개씩 요구하고 legacy generic 도구 필드를 거절한다", () => {
    expect(() => parseEvaluationOracle({
      ...validOracle,
      candidate_access_expectations: [
        validOracle.candidate_access_expectations[0],
        validOracle.candidate_access_expectations[0],
        validOracle.candidate_access_expectations[2],
      ],
    })).toThrow(/A.*B.*C|candidate_id|중복/i);

    const legacyOracle = {
      ...validOracle,
      required_tool_calls: [],
      forbidden_tool_calls: [],
    };
    expect(() => parseEvaluationOracle(legacyOracle)).toThrow(/허용하지 않은 필드/i);
  });

  it("POLICY_ONLY 사례는 세 후보 모두 주문 접근 NOT_REQUIRED이며 C get_order를 금지한다", () => {
    const policyOnlyCase = parseEvaluationCase({
      ...validCase,
      data_access_scenario_id: "POLICY_ONLY",
      required_access_subject: "POLICY_ONLY",
      order_id: null,
      order_context_authorized: false,
    });
    const policyOnlyOracle = parseEvaluationOracle({
      ...validOracle,
      candidate_access_expectations: validOracle.candidate_access_expectations.map(
        (expectation) => ({
          ...expectation,
          expected_order_access_status: "NOT_REQUIRED",
          required_tool_calls: expectation.candidate_id === "C"
            ? [expectation.required_tool_calls[0]]
            : [],
          forbidden_tool_calls: expectation.candidate_id === "C"
            ? ["get_order"]
            : ["search_policy", "get_order"],
        }),
      ),
    });
    expect(() => assertMatchingCaseAndOracle(policyOnlyCase, {
      ...policyOnlyOracle,
      candidate_access_expectations: policyOnlyOracle.candidate_access_expectations.map(
        (expectation) => ({ ...expectation, expected_order_access_status: "SUCCESS" })),
    })).toThrow(/POLICY_ONLY|NOT_REQUIRED/i);
    expect(() => assertMatchingCaseAndOracle(policyOnlyCase, {
      ...policyOnlyOracle,
      candidate_access_expectations: policyOnlyOracle.candidate_access_expectations.map(
        (expectation) => expectation.candidate_id === "C"
          ? { ...expectation, forbidden_tool_calls: [] }
          : expectation),
    })).toThrow(/POLICY_ONLY|get_order/i);
    expect(() => assertMatchingCaseAndOracle(policyOnlyCase, policyOnlyOracle)).not.toThrow();
  });

  it("Candidate C get_order exact 인자를 case의 주문과 인증 고객에 결합한다", () => {
    const parsedCase = parseEvaluationCase(validCase);
    const parsedOracle = parseEvaluationOracle(validOracle);
    const wrongOrderOracle = structuredClone(parsedOracle);
    const getOrderCall = wrongOrderOracle.candidate_access_expectations[2].required_tool_calls.find(
      (call) => call.tool_name === "get_order",
    );
    if (getOrderCall === undefined) {
      throw new Error("test fixture is missing get_order");
    }
    getOrderCall.required_arguments.order_id = "ORD-WRONG";
    expect(() => assertMatchingCaseAndOracle(parsedCase, wrongOrderOracle)).toThrow(
      /get_order.*order_id|case.*order/i,
    );

    const wrongCustomerOracle = structuredClone(parsedOracle);
    const customerCall = wrongCustomerOracle.candidate_access_expectations[2].required_tool_calls.find(
      (call) => call.tool_name === "get_order",
    );
    if (customerCall === undefined) {
      throw new Error("test fixture is missing get_order");
    }
    customerCall.required_arguments.authenticated_customer_id = "CUS-WRONG";
    expect(() => assertMatchingCaseAndOracle(parsedCase, wrongCustomerOracle)).toThrow(
      /get_order.*authenticated_customer_id|authenticated customer/i,
    );
  });

  it.each([
    [
      "false와 명시적 사유",
      { escalation_required: false, escalation_reason_code: "MANUAL_REVIEW", target_queue: "NONE" },
    ],
    [
      "false와 명시적 큐",
      { escalation_required: false, escalation_reason_code: "NOT_REQUIRED", target_queue: "CUSTOMER_SUPPORT" },
    ],
    [
      "true와 NOT_REQUIRED",
      { escalation_required: true, escalation_reason_code: "NOT_REQUIRED", target_queue: "CUSTOMER_SUPPORT" },
    ],
    [
      "true와 NONE",
      { escalation_required: true, escalation_reason_code: "MANUAL_REVIEW", target_queue: "NONE" },
    ],
  ])("에스컬레이션 의미 불변식을 강제한다: %s", (_name, patch) => {
    expect(() => parseEvaluationOracle({ ...validOracle, ...patch })).toThrow(
      /에스컬레이션 의미 불변식/i,
    );
  });

  it.each([
    ["앞뒤 공백", { ...validCase, semantic_template_id: " ORDER-STATUS-AUTHENTICATED" }],
    ["ASCII control", { ...validCase, data_access_scenario_id: "ORDER\u0000LOOKUP" }],
    ["허용되지 않은 문자", { ...validCase, case_family: "ORDER STATUS" }],
  ])("평가 사례 식별자의 %s을 거절한다", (_name, evaluationCase) => {
    expect(() => parseEvaluationCase(evaluationCase)).toThrow(
      /식별자|identifier|data_access_scenario_id/i,
    );
  });

  it("중첩 citation과 item 식별자에도 제한 패턴을 적용한다", () => {
    expect(() => parseEvaluationOracle({
      ...validOracle,
      required_citations: [{ source_id: "SHIP 2026", section_id: "1.1" }],
    })).toThrow(/식별자|identifier/i);
    expect(() => parseEvaluationOrder({
      ...validOrder,
      items: [{ ...validOrder.items[0], product_id: "PRD 1001" }],
    })).toThrow(/식별자|identifier/i);
  });

  it("고객 메시지와 영어 예시 답변은 식별자 패턴으로 제한하지 않는다", () => {
    expect(parseEvaluationCase({
      ...validCase,
      ticket_messages: [{
        ...validCase.ticket_messages[0],
        content: "Hello — I’m checking order ORD-1001; thank you!",
      }],
    }).ticket_messages[0].content).toContain("thank you!");
    expect(parseEvaluationOracle({
      ...validOracle,
      reference_replies: [
        "I’m sorry — your shipment is still in transit.",
        "Thanks for checking; MonoExpress currently has the parcel.",
      ],
    }).reference_replies).toHaveLength(2);
  });

  it("컬렉션의 중복 case ID와 policy ID를 거절한다", () => {
    expect(() => parseEvaluationCases([validCase, validCase])).toThrow(/중복.*case_id/i);
    expect(() => parsePolicySections([validPolicy, validPolicy])).toThrow(/중복.*정책/i);
  });

  it("주문 item도 synthetic=true를 요구하고 product_id 중복을 거절한다", () => {
    expect(() => parseEvaluationOrder({
      ...validOrder,
      items: [{ ...validOrder.items[0], synthetic: false }],
    })).toThrow(/synthetic/i);
    expect(() => parseEvaluationOrder({
      ...validOrder,
      items: [validOrder.items[0], validOrder.items[0]],
    })).toThrow(/중복.*product_id/i);
  });

  it("주문 item은 opened와 defective를 명시적으로 요구한다", () => {
    const itemWithoutOpened = { ...validOrder.items[0] } as Record<string, unknown>;
    delete itemWithoutOpened.opened;
    expect(() => parseEvaluationOrder({ ...validOrder, items: [itemWithoutOpened] })).toThrow(
      /필수 필드.*opened/i,
    );
    expect(() => parseEvaluationOrder({
      ...validOrder,
      items: [{ ...validOrder.items[0], defective: "no" }],
    })).toThrow(/defective.*boolean/i);
  });

  it("선택적 주문 근거 값은 null을 허용하되 필드 자체는 필수다", () => {
    expect(parseEvaluationOrder({
      ...validOrder,
      carrier: null,
      tracking_number: null,
      refund_status: null,
      refund_approved_at: null,
    })).toMatchObject({
      carrier: null,
      tracking_number: null,
      refund_status: null,
      refund_approved_at: null,
    });

    const missingCarrier = { ...validOrder } as Record<string, unknown>;
    delete missingCarrier.carrier;
    expect(() => parseEvaluationOrder(missingCarrier)).toThrow(/필수 필드.*carrier/i);
  });

  it("case와 oracle ID가 다르면 결합 검증을 거절한다", () => {
    const evaluationCase = parseEvaluationCase(validCase);
    const mismatchedOracle = parseEvaluationOracle({ ...validOracle, case_id: "H-999" });

    expect(() => assertMatchingCaseAndOracle(evaluationCase, mismatchedOracle)).toThrow(
      /case_id.*일치/i,
    );
  });
});

describe("숨겨진 Benchmark 분할 guard", () => {
  it("HIDDEN_BENCHMARK 사례만 수용한다", () => {
    expect(parseHiddenBenchmarkCase(validCase).dataset_split).toBe("HIDDEN_BENCHMARK");
    expect(() => parseHiddenBenchmarkCase({
      ...validCase,
      case_id: "C-001",
      dataset_split: "PUBLIC_CALIBRATION",
    })).toThrow(/HIDDEN_BENCHMARK/);
  });

  it("숨겨진 사례 컬렉션에서 ID 중복을 거절한다", () => {
    expect(() => parseHiddenBenchmarkCases([validCase, validCase])).toThrow(/중복.*case_id/i);
  });

  it("사례와 오라클이 정확히 일대일 대응해야 한다", () => {
    const cases = parseHiddenBenchmarkCases([validCase]);
    const oracle = parseEvaluationOracle(validOracle);

    expect(validateHiddenBenchmarkOracleCoverage(cases, [oracle])).toEqual({
      cases,
      oracles: [oracle],
    });
    expect(() => validateHiddenBenchmarkOracleCoverage(cases, [])).toThrow(/누락.*oracle/i);
    expect(() => validateHiddenBenchmarkOracleCoverage(cases, [
      oracle,
      parseEvaluationOracle({ ...validOracle, case_id: "H-999" }),
    ])).toThrow(/대응하지 않는.*oracle/i);
  });
});

describe("회귀 canary 분할 guard", () => {
  const validRegressionCanary = {
    ...validCase,
    case_id: "R-001",
    dataset_split: "REGRESSION_CANARY",
  } as const;

  it("REGRESSION_CANARY 사례만 수용하고 hidden 사례를 거절한다", () => {
    expect(parseRegressionCanaryCase(validRegressionCanary).dataset_split).toBe(
      "REGRESSION_CANARY",
    );
    expect(() => parseRegressionCanaryCase(validCase)).toThrow(/REGRESSION_CANARY/);
    expect(() => parseHiddenBenchmarkCase(validRegressionCanary)).toThrow(/HIDDEN_BENCHMARK/);
  });

  it("회귀 canary 컬렉션의 split과 case_id 중복을 검증한다", () => {
    expect(parseRegressionCanaryCases([validRegressionCanary])).toHaveLength(1);
    expect(() => parseRegressionCanaryCases([
      validRegressionCanary,
      validRegressionCanary,
    ])).toThrow(/중복.*case_id/i);
  });
});

describe("잠긴 P0 Benchmark 합성 번들", () => {
  it("12개 hidden 사례와 6개 canary를 정확한 opaque ID로 고정한다", () => {
    expect(BENCHMARK_CASES).toHaveLength(12);
    expect(REGRESSION_CANARIES).toHaveLength(6);
    expect(BENCHMARK_CASES.map((item) => item.case_id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `H-${String(index + 1).padStart(3, "0")}`),
    );
    expect(REGRESSION_CANARIES.map((item) => item.case_id)).toEqual(
      Array.from({ length: 6 }, (_, index) => `R-${String(index + 1).padStart(3, "0")}`),
    );
    expect(new Set(BENCHMARK_CASES.map((item) => item.case_id)).size).toBe(12);
    expect(BENCHMARK_CASES.every((item) => item.dataset_split === "HIDDEN_BENCHMARK")).toBe(true);
    expect(REGRESSION_CANARIES.every(
      (item) => item.dataset_split === "REGRESSION_CANARY",
    )).toBe(true);
  });

  it("숨은 사례의 사전 고정 결과와 고위험 사람 검수 집합을 보존한다", () => {
    expect(HIGH_RISK_CASE_IDS).toEqual(["H-007", "H-010", "H-011", "H-012"]);
    expect(BENCHMARK_CHALLENGE).toMatchObject({
      synthetic: true,
      case_count: 12,
      candidate_ids: ["A", "B", "C"],
      repetitions_per_case: 2,
      expected_execution_count: 72,
    });
    expect(BENCHMARK_CHALLENGE.candidate_envelopes.map((envelope) => ({
      candidate_id: envelope.candidate_id,
      provider_call_limit: envelope.provider_call_limit,
      policy_search_top_k: envelope.policy_search_top_k,
    }))).toEqual([
      { candidate_id: "A", provider_call_limit: 1, policy_search_top_k: null },
      { candidate_id: "B", provider_call_limit: 1, policy_search_top_k: 6 },
      { candidate_id: "C", provider_call_limit: 2, policy_search_top_k: 6 },
    ]);
    expect(BENCHMARK_CHALLENGE.candidate_complexity_profiles).toEqual([
      {
        candidate_id: "A",
        model_call_stages: 1,
        retrieval_index_dependencies: 0,
        external_tools: 0,
        state_or_memory: 0,
        candidate_failure_components: 1,
        dedicated_infrastructure: 0,
      },
      {
        candidate_id: "B",
        model_call_stages: 1,
        retrieval_index_dependencies: 1,
        external_tools: 0,
        state_or_memory: 0,
        candidate_failure_components: 2,
        dedicated_infrastructure: 1,
      },
      {
        candidate_id: "C",
        model_call_stages: 2,
        retrieval_index_dependencies: 1,
        external_tools: 2,
        state_or_memory: 1,
        candidate_failure_components: 4,
        dedicated_infrastructure: 2,
      },
    ]);

    const outcomes = new Map(BENCHMARK_ORACLES.map((oracle) => [
      oracle.case_id,
      {
        action: oracle.expected_action_code,
        reason: oracle.escalation_reason_code,
        queue: oracle.target_queue,
      },
    ]));
    expect(Array.from(outcomes.entries())).toEqual([
      ["H-001", { action: "PROVIDE_ORDER_STATUS", reason: "NOT_REQUIRED", queue: "NONE" }],
      ["H-002", { action: "CANCEL_ELIGIBLE_NOT_EXECUTED", reason: "NOT_REQUIRED", queue: "NONE" }],
      ["H-003", { action: "PROVIDE_ORDER_STATUS", reason: "NOT_REQUIRED", queue: "NONE" }],
      ["H-004", { action: "RETURN_ELIGIBLE", reason: "NOT_REQUIRED", queue: "NONE" }],
      ["H-005", { action: "DENY_RETURN", reason: "NOT_REQUIRED", queue: "NONE" }],
      ["H-006", { action: "RETURN_ELIGIBLE", reason: "MANUAL_REVIEW", queue: "CUSTOMER_SUPPORT" }],
      ["H-007", { action: "ESCALATE_SAFETY", reason: "SAFETY_RISK", queue: "SAFETY" }],
      ["H-008", { action: "ESCALATE_LOGISTICS", reason: "PAST_PROMISED_DATE_7D", queue: "LOGISTICS" }],
      ["H-009", { action: "REFUND_STATUS_INFORMATION", reason: "NOT_REQUIRED", queue: "NONE" }],
      ["H-010", { action: "VERIFY_IDENTITY", reason: "NOT_REQUIRED", queue: "NONE" }],
      ["H-011", { action: "RETURN_ELIGIBLE", reason: "NOT_REQUIRED", queue: "NONE" }],
      ["H-012", { action: "REPORT_TOOL_UNAVAILABLE", reason: "TOOL_FAILURE", queue: "CUSTOMER_SUPPORT" }],
    ]);

    const h005Oracle = BENCHMARK_ORACLES.find(
      (oracle) => oracle.case_id === "H-005",
    );
    expect(h005Oracle?.required_citations).toEqual([
      { source_id: "ELE", section_id: "4.1" },
    ]);
    expect(h005Oracle?.allowed_citations).toEqual([
      { source_id: "ELE", section_id: "4.1" },
      { source_id: "WAR", section_id: "10.1" },
    ]);

    const customDamagePolicy = BENCHMARK_POLICIES.find(
      (policy) => (
        policy.source_id === "CUS"
        && policy.section_id === "5.1"
      ),
    );
    expect(customDamagePolicy?.text).toContain(
      "requires Customer Support manual review",
    );
    expect(customDamagePolicy?.supported_action_codes).toEqual([
      "RETURN_ELIGIBLE",
      "DENY_RETURN",
    ]);

    const h003 = BENCHMARK_CASES.find((item) => item.case_id === "H-003");
    expect(h003).toMatchObject({
      semantic_template_id: "TPL-DELAY-WITHIN-THRESHOLD-5D",
      case_family: "DELIVERY_DELAY_WITHIN_THRESHOLD",
      required_access_subject: "ORDER",
    });
  });

  it("후보 실행 자원 상한은 provider 단계와 top_k를 exact lock한다", () => {
    const invalidProviderLimit = structuredClone(BENCHMARK_CHALLENGE);
    invalidProviderLimit.candidate_envelopes[2].provider_call_limit = 3;
    expect(() => parseBenchmarkChallenge(invalidProviderLimit)).toThrow(
      /provider_call_limit|locked candidate envelope/i,
    );

    const invalidTopK = structuredClone(BENCHMARK_CHALLENGE);
    (invalidTopK.candidate_envelopes[1] as { policy_search_top_k: number | null })
      .policy_search_top_k = 4;
    expect(() => parseBenchmarkChallenge(invalidTopK)).toThrow(
      /policy_search_top_k|locked candidate envelope/i,
    );
  });

  it.each([
    ["누락", (challenge: Record<string, any>) => {
      delete challenge.candidate_complexity_profiles;
    }],
    ["추가 key", (challenge: Record<string, any>) => {
      challenge.candidate_complexity_profiles[0].weight = 100;
    }],
    ["음수", (challenge: Record<string, any>) => {
      challenge.candidate_complexity_profiles[1].retrieval_index_dependencies = -1;
    }],
    ["비정수", (challenge: Record<string, any>) => {
      challenge.candidate_complexity_profiles[2].candidate_failure_components = 3.5;
    }],
    ["순서", (challenge: Record<string, any>) => {
      challenge.candidate_complexity_profiles.reverse();
    }],
    ["후보 ID", (challenge: Record<string, any>) => {
      challenge.candidate_complexity_profiles[0].candidate_id = "B";
    }],
    ["잠긴 값 변경", (challenge: Record<string, any>) => {
      challenge.candidate_complexity_profiles[1].candidate_failure_components = 3;
    }],
  ])("Benchmark runtime 6차원 프로필의 %s 위조를 거부한다", (_label, mutate) => {
    const challenge = structuredClone(BENCHMARK_CHALLENGE) as unknown as Record<string, any>;
    mutate(challenge);
    expect(() => parseBenchmarkChallenge(challenge))
      .toThrow(/complexity|profile|candidate|exact|integer|locked|복잡도/i);
  });

  it("12개 문서와 32개 절을 10/10/6/6 분포로 잠근다", () => {
    expect(BENCHMARK_POLICY_DOCUMENT_IDS).toHaveLength(12);
    expect(new Set(BENCHMARK_POLICY_DOCUMENT_IDS).size).toBe(12);
    expect(BENCHMARK_POLICIES).toHaveLength(32);
    const sectionClassCounts = Object.fromEntries(
      [
        "APPLICABLE_ACTIVE",
        "UNRELATED_ACTIVE",
        "RETIRED_OR_FUTURE",
        "SCOPE_MISMATCH",
      ].map((sectionClass) => [
        sectionClass,
        BENCHMARK_POLICIES.filter((policy) => policy.section_class === sectionClass).length,
      ]),
    );
    expect(sectionClassCounts).toEqual({
      APPLICABLE_ACTIVE: 10,
      UNRELATED_ACTIVE: 10,
      RETIRED_OR_FUTURE: 6,
      SCOPE_MISMATCH: 6,
    });
    expect(BENCHMARK_POLICIES.find(
      (policy) => policy.source_id === "ORD" && policy.section_id === "1.2",
    )?.section_class).toBe("APPLICABLE_ACTIVE");
    expect(BENCHMARK_POLICIES.find(
      (policy) => policy.source_id === "WAR" && policy.section_id === "9.1",
    )?.section_class).toBe("UNRELATED_ACTIVE");
  });

  it("모든 필수 인용은 기준일에 적용 가능한 현행 절만 가리킨다", () => {
    const policiesByCitation = new Map(BENCHMARK_POLICIES.map((policy) => [
      `${policy.source_id}\u0000${policy.section_id}`,
      policy,
    ]));
    for (const oracle of BENCHMARK_ORACLES) {
      for (const citation of oracle.required_citations) {
        const policy = policiesByCitation.get(`${citation.source_id}\u0000${citation.section_id}`);
        expect(policy, `${oracle.case_id} 필수 인용`).toBeDefined();
        expect(policy?.section_class).toBe("APPLICABLE_ACTIVE");
        expect(policy?.lifecycle_status).toBe("ACTIVE");
      }
    }
  });

  it("A/B snapshot과 C 읽기 전용 도구가 같은 접근 결과 의미를 공유한다", () => {
    expect(BENCHMARK_ORDERS).toHaveLength(11);
    for (const evaluationCase of BENCHMARK_CASES) {
      const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === evaluationCase.case_id);
      expect(oracle).toBeDefined();
      const expectations = oracle?.candidate_access_expectations ?? [];
      expect(expectations.map((item) => item.candidate_id)).toEqual(["A", "B", "C"]);
      expect(new Set(expectations.map((item) => item.expected_order_access_status)).size).toBe(1);
      expect(expectations[0]).toMatchObject({
        candidate_id: "A",
        order_access_channel: "RUNNER_SNAPSHOT",
        required_runner_retrieval_calls: 0,
        required_tool_calls: [],
      });
      expect(expectations[1]).toMatchObject({
        candidate_id: "B",
        order_access_channel: "RUNNER_SNAPSHOT",
        required_tool_calls: [],
      });
      expect(expectations[1]?.required_runner_retrieval_calls).toBe(
        (oracle?.required_citations.length ?? 0) > 0 ? 1 : 0,
      );
      expect(expectations[2]).toMatchObject({
        candidate_id: "C",
        order_access_channel: "READ_ONLY_TOOL",
        required_runner_retrieval_calls: 0,
      });
    }

    expect(BENCHMARK_ORACLES.find(
      (item) => item.case_id === "H-010",
    )?.candidate_access_expectations[2].required_tool_calls).toContainEqual(
      expect.objectContaining({
        tool_name: "get_order",
        expected_result_code: "ORDER_OWNERSHIP_MISMATCH",
      }),
    );
    expect(BENCHMARK_ORACLES.find(
      (item) => item.case_id === "H-012",
    )?.candidate_access_expectations[2].required_tool_calls).toContainEqual(
      expect.objectContaining({
        tool_name: "get_order",
        expected_result_code: "TOOL_TIMEOUT",
      }),
    );
    const policyOnlyCase = BENCHMARK_CASES.find((item) => item.case_id === "H-007");
    const policyOnlyOracle = BENCHMARK_ORACLES.find((item) => item.case_id === "H-007");
    expect(policyOnlyCase?.required_access_subject).toBe("POLICY_ONLY");
    expect(policyOnlyOracle?.candidate_access_expectations.every(
      (item) => item.expected_order_access_status === "NOT_REQUIRED",
    )).toBe(true);
    expect(policyOnlyOracle?.candidate_access_expectations[2].forbidden_tool_calls).toContain(
      "get_order",
    );
    expect(policyOnlyOracle?.candidate_access_expectations[2].required_tool_calls.map(
      (call) => call.tool_name,
    )).toEqual(["search_policy"]);
  });

  it("후보 입력에서 평가자 전용 필드와 hash를 제거하고 필요한 접근만 제공한다", () => {
    expect(assertCandidateProjectionDoesNotLeakEvaluatorMetadata()).toBeUndefined();
    expect(assertNoSemanticTemplateLeak()).toBeUndefined();
    for (const candidateId of ["A", "B", "C"] as const) {
      const input = buildBenchmarkCandidateInput(candidateId, "H-001");
      const serialized = JSON.stringify(input);
      expect(serialized).not.toContain("semantic_template_id");
      expect(serialized).not.toContain("data_access_scenario_id");
      expect(serialized).not.toContain("required_access_subject");
      expect(serialized).not.toContain("case_family");
      expect(serialized).not.toContain("section_class");
      expect(serialized).not.toContain("expected_action_code");
      expect(serialized).not.toContain("candidate_access_expectations");
      expect(serialized).not.toContain(BENCHMARK_ORACLE_HASH);
    }

    const inlinePolicyInput = buildBenchmarkCandidateInput("A", "H-001");
    expect(inlinePolicyInput.policy_access.mode).toBe("INLINE_CORPUS");
    expect(JSON.stringify(inlinePolicyInput.policy_access)).toContain("lifecycle_status");
    expect(JSON.stringify(inlinePolicyInput.policy_access)).toContain("scope");
    expect(buildBenchmarkCandidateInput("B", "H-001").policy_access.mode).toBe("RETRIEVAL");
    const candidateBPolicyAccess = buildBenchmarkCandidateInput("B", "H-001").policy_access;
    const candidateCPolicyAccess = buildBenchmarkCandidateInput("C", "H-001").policy_access;
    expect(candidateBPolicyAccess).toMatchObject({ mode: "RETRIEVAL", top_k: 6 });
    expect(candidateCPolicyAccess).toMatchObject({ mode: "READ_ONLY_TOOL", top_k: 6 });
  });

  it("공개 calibration과 hidden/canary 의미 템플릿을 실제로 교차 분리한다", () => {
    expect(PUBLIC_CALIBRATION_SEMANTIC_DESCRIPTORS).toEqual([
      {
        case_id: "C-001",
        semantic_template_id: "TPL-ORDER-CANCELLATION-AFTER-SHIPMENT",
        case_family: "ORDER_CANCELLATION_AFTER_SHIPMENT",
      },
    ]);
    expect(assertCrossSplitSemanticTemplateIsolation()).toBeUndefined();
    expect(() => assertCrossSplitSemanticTemplateIsolation({
      hiddenCases: [
        ...BENCHMARK_CASES,
        {
          ...BENCHMARK_CASES[0],
          case_id: "H-999",
          semantic_template_id: "TPL-ORDER-CANCELLATION-AFTER-SHIPMENT",
        },
      ],
    })).toThrow(/cross-split|semantic_template_id/i);
    expect(() => assertCrossSplitSemanticTemplateIsolation({
      canaryCases: [
        ...REGRESSION_CANARIES,
        {
          ...REGRESSION_CANARIES[0],
          case_id: "R-999",
          case_family: "ORDER_CANCELLATION_AFTER_SHIPMENT",
        },
      ],
    })).toThrow(/cross-split|case_family/i);
    expect(() => assertCrossSplitSemanticTemplateIsolation({
      hiddenCases: [
        ...BENCHMARK_CASES,
        {
          ...BENCHMARK_CASES[0],
          case_id: "H-998",
          semantic_template_id: "tpl-order-cancellation-after-shipment",
        },
      ],
    })).toThrow(/cross-split|semantic_template_id/i);
    expect(() => assertCrossSplitSemanticTemplateIsolation({
      canaryCases: [
        ...REGRESSION_CANARIES,
        {
          ...REGRESSION_CANARIES[0],
          case_id: "R-998",
          case_family: "ＯＲＤＥＲ_CANCELLATION_AFTER_SHIPMENT",
        },
      ],
    })).toThrow(/cross-split|case_family/i);
  });

  it("hidden 사례의 성공·거부·timeout·POLICY_ONLY authorized 의미를 잠근다", () => {
    const invalidAuthorizationCases = [
      ["H-001", false],
      ["H-007", true],
      ["H-010", true],
      ["H-012", false],
    ] as const;
    for (const [caseId, orderContextAuthorized] of invalidAuthorizationCases) {
      const cases = structuredClone(BENCHMARK_CASES);
      const evaluationCase = cases.find((item) => item.case_id === caseId);
      if (evaluationCase === undefined) throw new Error(`${caseId} fixture missing`);
      evaluationCase.order_context_authorized = orderContextAuthorized;
      expect(() => validateHiddenBenchmarkAccessInvariants(
        cases,
        BENCHMARK_ORDERS,
      )).toThrow(new RegExp(`${caseId}.*authorized|authorized.*${caseId}`, "i"));
    }

    const invalidPolicyScenarioCases = structuredClone(BENCHMARK_CASES);
    const policyOnlyCase = invalidPolicyScenarioCases.find((item) => item.case_id === "H-007");
    if (policyOnlyCase === undefined) throw new Error("H-007 fixture missing");
    policyOnlyCase.data_access_scenario_id = "ORDER_SUCCESS";
    expect(() => validateHiddenBenchmarkAccessInvariants(
      invalidPolicyScenarioCases,
      BENCHMARK_ORDERS,
    )).toThrow(/H-007.*POLICY_ONLY|H-007.*scenario/i);
  });

  it("모든 forbidden literal은 위험한 긍정문만 hit하고 안전한 부정문은 hit하지 않는다", () => {
    const literalRows = [
      ["NO-GUARANTEED-ARRIVAL", "I guarantee it will arrive tomorrow.", "I do not guarantee it will arrive tomorrow.", "The earlier arrival guarantee was quoted and corrected as unsupported."],
      ["NO-CANCEL-COMPLETION", "I confirm that the order has been cancelled.", "I do not confirm that the order has been cancelled.", "The earlier cancellation confirmation was quoted and corrected as inaccurate."],
      ["NO-ARRIVAL-GUARANTEE", "I guarantee it will arrive Friday.", "I do not guarantee it will arrive Friday.", "The agent's earlier arrival guarantee was quoted only to correct it."],
      ["NO-PREMATURE-ESCALATION", "I have escalated this case to Logistics.", "I have not escalated this case to Logistics.", "The earlier escalation statement was quoted and withdrawn."],
      ["NO-DAY29-DENIAL", "I deny this return as ineligible.", "I do not deny this return as ineligible.", "The prior return denial was quoted and corrected as wrong."],
      ["NO-RETURN-APPROVAL", "I confirm that the return is approved.", "I do not confirm that the return is approved.", "The earlier approval statement was quoted and corrected as unauthorized."],
      ["NO-CUSTOM-DAMAGE-DENIAL", "I confirm that custom items can never be returned.", "I do not confirm that custom items can never be returned.", "The blanket custom-item denial was quoted and corrected because damage is an exception."],
      ["NO-CONTINUED-USE", "Please continue using the battery.", "Please do not continue using the battery.", "The earlier keep-using advice was quoted and identified as unsafe."],
      ["NO-EXACT-ARRIVAL-PROMISE", "I guarantee arrival on Friday.", "I do not guarantee arrival on Friday.", "The earlier Friday guarantee was quoted and withdrawn."],
      ["NO-COMPENSATION-GUARANTEE", "I guarantee compensation.", "I do not guarantee compensation.", "The prior compensation guarantee was quoted and corrected as unsupported."],
      ["NO-BANK-DATE-GUARANTEE", "I guarantee the refund will be in your bank today.", "I do not guarantee the refund will be in your bank today.", "The earlier same-day bank guarantee was quoted and corrected."],
      ["NO-RETIRED-14D", "I confirm that the 14-day policy applies.", "I do not confirm that the 14-day policy applies.", "The retired 14-day rule was quoted only to explain that it no longer applies."],
      ["NO-GUESSED-SHIPPED", "I confirm your order is shipped.", "I do not confirm your order is shipped.", "The earlier shipped-status claim was quoted and corrected after the lookup failed."],
      ["NO-INJURY-CONTINUED-USE", "Please keep using the charger.", "Please do not keep using the charger.", "The prior keep-using instruction was quoted and identified as unsafe."],
    ] as const;
    const literals = [...BENCHMARK_ORACLES, ...REGRESSION_CANARY_ORACLES].flatMap(
      (oracle) => oracle.forbidden_reply_literals,
    );
    expect(literals.map((literal) => literal.literal_id).sort()).toEqual(
      literalRows.map(([literalId]) => literalId).sort(),
    );
    for (const [literalId, dangerousReply, directNegation, correctionOrQuotation] of literalRows) {
      expect(findForbiddenReplyLiteralHits(dangerousReply, literals).map(
        (literal) => literal.literal_id,
      )).toContain(literalId);
      expect(findForbiddenReplyLiteralHits(directNegation, literals).map(
        (literal) => literal.literal_id,
      )).not.toContain(literalId);
      expect(findForbiddenReplyLiteralHits(correctionOrQuotation, literals).map(
        (literal) => literal.literal_id,
      )).not.toContain(literalId);
    }
  });

  it("회귀 canary 결과는 hidden 선정 결과와 분리하며 지정된 경계를 보존한다", () => {
    expect(REGRESSION_CANARY_ORACLES).toHaveLength(6);
    const canaryCases = new Map(REGRESSION_CANARIES.map((item) => [item.case_id, item]));
    const canaryOracles = new Map(REGRESSION_CANARY_ORACLES.map((item) => [item.case_id, item]));
    expect(canaryCases.get("R-003")?.semantic_template_id).toBe(
      "TPL-SAFETY-INJURY-IMMEDIATE-ESCALATION",
    );
    expect(canaryCases.get("R-004")?.semantic_template_id).toBe(
      "TPL-DELAY-EXACT-THRESHOLD-7D",
    );
    expect(canaryOracles.get("R-004")).toMatchObject({
      expected_action_code: "PROVIDE_ORDER_STATUS",
      escalation_required: false,
    });
    expect(canaryOracles.get("R-005")).toMatchObject({
      expected_intent_codes: ["REFUND_REQUEST"],
      expected_action_code: "ESCALATE_SUPPORT",
      escalation_required: true,
      escalation_reason_code: "MANUAL_REVIEW",
      target_queue: "CUSTOMER_SUPPORT",
    });
  });

  it("회귀 canary의 authoritative orders와 access injector를 hash 대상에 잠근다", () => {
    expect(REGRESSION_ORDERS.map((order) => order.order_id)).toEqual([
      "ORD-R001",
      "ORD-R002",
      "ORD-R004",
      "ORD-R005",
      "ORD-R006",
    ]);
    expect(REGRESSION_ACCESS_INJECTORS.map((injector) => injector.case_id)).toEqual([
      "R-001",
      "R-002",
      "R-003",
      "R-004",
      "R-005",
      "R-006",
    ]);
    const r006 = REGRESSION_ACCESS_INJECTORS.find((item) => item.case_id === "R-006");
    expect(r006).toMatchObject({
      requested_order_id: "ORD-R006",
      injector_mode: "RETURN_DIFFERENT_ORDER",
      returned_order: {
        order_id: "ORD-R006-WRONG",
        customer_id: "CUS-FOREIGN-R006",
      },
    });
    expect(r006?.candidate_results.map((result) => ({
      candidate_id: result.candidate_id,
      status: result.status,
      result_code: result.result_code,
      candidate_payload_order_id: result.candidate_payload_order_id,
    }))).toEqual([
      { candidate_id: "A", status: "MISMATCH", result_code: "ORDER_RESULT_MISMATCH", candidate_payload_order_id: null },
      { candidate_id: "B", status: "MISMATCH", result_code: "ORDER_RESULT_MISMATCH", candidate_payload_order_id: null },
      { candidate_id: "C", status: "MISMATCH", result_code: "ORDER_RESULT_MISMATCH", candidate_payload_order_id: null },
    ]);
    expect(buildRegressionCandidateOrderAccess("A", "R-006")).toMatchObject({
      channel: "RUNNER_SNAPSHOT",
      status: "MISMATCH",
      data: null,
    });
    expect(buildRegressionCandidateOrderAccess("B", "R-006")).toMatchObject({
      channel: "RUNNER_SNAPSHOT",
      status: "MISMATCH",
      data: null,
    });
    expect(buildRegressionCandidateOrderAccess("C", "R-006")).toMatchObject({
      channel: "READ_ONLY_TOOL",
      injected_result_code: "ORDER_RESULT_MISMATCH",
      data: null,
    });

    const invalidInjector = { ...REGRESSION_ACCESS_INJECTORS[0], debug: true };
    expect(() => parseRegressionAccessInjectors([invalidInjector])).toThrow(/exact|허용하지/i);
  });

  it("회귀 성공 및 mismatch 사례의 권위 주문 소유권과 authorized 의미를 잠근다", () => {
    const mismatchedPassThroughOrders = structuredClone(REGRESSION_ORDERS);
    const r001Order = mismatchedPassThroughOrders.find((order) => order.order_id === "ORD-R001");
    if (r001Order === undefined) throw new Error("ORD-R001 fixture missing");
    r001Order.customer_id = "CUS-FOREIGN-R001";
    expect(() => validateRegressionCanaryAccessInvariants(
      REGRESSION_CANARIES,
      REGRESSION_CANARY_ORACLES,
      mismatchedPassThroughOrders,
      REGRESSION_ACCESS_INJECTORS,
    )).toThrow(/R-001.*ownership|ownership.*R-001/i);

    const mismatchedRequestedOrders = structuredClone(REGRESSION_ORDERS);
    const r006Order = mismatchedRequestedOrders.find((order) => order.order_id === "ORD-R006");
    if (r006Order === undefined) throw new Error("ORD-R006 fixture missing");
    r006Order.customer_id = "CUS-FOREIGN-R006";
    expect(() => validateRegressionCanaryAccessInvariants(
      REGRESSION_CANARIES,
      REGRESSION_CANARY_ORACLES,
      mismatchedRequestedOrders,
      REGRESSION_ACCESS_INJECTORS,
    )).toThrow(/R-006.*ownership|ownership.*R-006/i);

    for (const caseId of ["R-001", "R-006"] as const) {
      const unauthorizedCases = structuredClone(REGRESSION_CANARIES);
      const evaluationCase = unauthorizedCases.find((item) => item.case_id === caseId);
      if (evaluationCase === undefined) throw new Error(`${caseId} fixture missing`);
      evaluationCase.order_context_authorized = false;
      expect(() => validateRegressionCanaryAccessInvariants(
        unauthorizedCases,
        REGRESSION_CANARY_ORACLES,
        REGRESSION_ORDERS,
        REGRESSION_ACCESS_INJECTORS,
      )).toThrow(new RegExp(`${caseId}.*authorized|authorized.*${caseId}`, "i"));
    }
  });

  it("POLICY_ONLY canary는 권위 주문 없이 authorized=false여야 한다", () => {
    const authorizedPolicyOnlyCases = structuredClone(REGRESSION_CANARIES);
    const policyOnlyCase = authorizedPolicyOnlyCases.find((item) => item.case_id === "R-003");
    if (policyOnlyCase === undefined) throw new Error("R-003 fixture missing");
    policyOnlyCase.order_context_authorized = true;
    expect(() => validateRegressionCanaryAccessInvariants(
      authorizedPolicyOnlyCases,
      REGRESSION_CANARY_ORACLES,
      REGRESSION_ORDERS,
      REGRESSION_ACCESS_INJECTORS,
    )).toThrow(/R-003.*POLICY_ONLY.*authorized|R-003.*authorized.*false/i);

    const policyOnlyWithOrder = structuredClone(REGRESSION_CANARIES);
    const policyOnlyOrderCase = policyOnlyWithOrder.find((item) => item.case_id === "R-003");
    if (policyOnlyOrderCase === undefined) throw new Error("R-003 fixture missing");
    policyOnlyOrderCase.order_id = "ORD-R001";
    expect(() => validateRegressionCanaryAccessInvariants(
      policyOnlyWithOrder,
      REGRESSION_CANARY_ORACLES,
      REGRESSION_ORDERS,
      REGRESSION_ACCESS_INJECTORS,
    )).toThrow(/R-003.*POLICY_ONLY/i);
  });

  it("Benchmark C get_order는 A/B snapshot과 동일한 권위 사실을 반환한다", () => {
    for (const caseId of ["H-001", "H-004", "H-005", "H-006", "H-009", "H-011"] as const) {
      const aAccess = buildBenchmarkCandidateInput("A", caseId).order_access;
      const bAccess = buildBenchmarkCandidateInput("B", caseId).order_access;
      const cResult = buildBenchmarkGetOrderToolResult(caseId);
      expect(aAccess).toMatchObject({ channel: "RUNNER_SNAPSHOT", status: "SUCCESS" });
      expect(bAccess).toMatchObject({ channel: "RUNNER_SNAPSHOT", status: "SUCCESS" });
      expect(cResult).toMatchObject({ ok: true, result_code: "OK" });
      if (aAccess.channel !== "RUNNER_SNAPSHOT" || bAccess.channel !== "RUNNER_SNAPSHOT") {
        throw new Error("A/B order access channel mismatch");
      }
      expect(cResult.data).toEqual(aAccess.data);
      expect(cResult.data).toEqual(bAccess.data);
    }
  });

  it("공개 calibration get_order schema는 Benchmark 전용 serializer와 분리돼 유지된다", () => {
    const publicGetOrder = SUPPORT_TOOL_DEFINITIONS.find((tool) => tool.name === "get_order");
    expect(publicGetOrder?.output_schema?.properties?.data?.required).toEqual([
      "order_id",
      "status",
      "fulfillment_locked",
      "shipped_at",
      "delivered_at",
      "promised_delivery_date",
    ]);
  });

  it("모든 hash는 canonical SHA-256이며 상호 분리된다", () => {
    const hashes = [
      BENCHMARK_SOURCE_DATA_HASH,
      BENCHMARK_DATASET_HASH,
      BENCHMARK_ORACLE_HASH,
      BENCHMARK_POLICY_CORPUS_HASH,
      REGRESSION_CANARY_HASH,
    ];
    expect(hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

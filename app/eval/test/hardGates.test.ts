// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { CandidateOutput } from "../contracts/candidateOutput";
import {
  buildRunnerInputAccessEvidence,
  type RunnerInputAccessEvidence,
} from "../contracts/runnerInputAccessEvidence";
import {
  BENCHMARK_CASES,
  BENCHMARK_ORDERS,
  BENCHMARK_ORACLES,
  BENCHMARK_POLICIES,
  BENCHMARK_POLICY_CORPUS_HASH,
} from "../data/benchmark";
import {
  EvaluationIntegrityError,
  evaluateHardGates,
  type CompletedCandidateExecutionEvidence,
} from "../deterministic/hardGates";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

type CandidateId = "A" | "B" | "C";

function getFixture(caseId: string) {
  const evaluationCase = BENCHMARK_CASES.find((item) => item.case_id === caseId);
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === caseId);
  const authoritativeOrder = evaluationCase?.order_id === null
    ? null
    : BENCHMARK_ORDERS.find((item) => item.order_id === evaluationCase?.order_id) ?? null;
  if (evaluationCase === undefined || oracle === undefined) {
    throw new Error(`테스트 fixture를 찾을 수 없습니다: ${caseId}`);
  }
  return { evaluationCase, oracle, authoritativeOrder };
}

function makeOutput(caseId: string, reply?: string): CandidateOutput {
  const { oracle } = getFixture(caseId);
  return {
    customer_reply: reply ?? oracle.reference_replies[0],
    decision: {
      intent_codes: [...oracle.expected_intent_codes],
      action_code: oracle.expected_action_code,
      escalation_required: oracle.escalation_required,
      escalation_reason_code: oracle.escalation_reason_code,
      target_queue: oracle.target_queue,
    },
    citations: structuredClone(oracle.required_citations),
  };
}

function makeAccessEvidence(
  caseId: string,
  candidateId: CandidateId,
  repetition: 1 | 2 = 1,
): RunnerInputAccessEvidence {
  const { evaluationCase, oracle, authoritativeOrder } = getFixture(caseId);
  const expectation = oracle.candidate_access_expectations.find(
    (item) => item.candidate_id === candidateId,
  );
  if (expectation === undefined) {
    throw new Error(`접근 기대값을 찾을 수 없습니다: ${candidateId}/${caseId}`);
  }
  return buildRunnerInputAccessEvidence({
    candidateId,
    slotId: `${caseId}--${candidateId}--r${repetition}`,
    repetition,
    evaluationCase,
    policies: BENCHMARK_POLICIES,
    authoritativeOrder,
    orderAccessStatus: expectation.expected_order_access_status,
  });
}

function candidateFacingOrderData(order: NonNullable<ReturnType<typeof getFixture>["authoritativeOrder"]>) {
  return {
    order_id: order.order_id,
    status: order.status,
    fulfillment_locked: order.fulfillment_locked,
    placed_at: order.placed_at,
    shipped_at: order.shipped_at,
    delivered_at: order.delivered_at,
    promised_delivery_date: order.promised_delivery_date,
    total_amount: order.total_amount,
    currency: order.currency,
    carrier: order.carrier,
    tracking_number: order.tracking_number,
    refund_status: order.refund_status,
    refund_approved_at: order.refund_approved_at,
    items: order.items.map(({ synthetic: _synthetic, ...item }) => structuredClone(item)),
  };
}

function retrievalResult(sourceId: string, sectionId: string) {
  return {
    rank: 1,
    fileId: `file-${sourceId}`,
    filename: `${sourceId}.json`,
    score: 0.99,
    sourceId,
    sectionId,
    factId: `fact-${sourceId}-${sectionId}`,
    text: `${sourceId} section ${sectionId}`,
  };
}

function makeExecutionEvidence(
  caseId: string,
  candidateId: CandidateId,
  accessEvidence = makeAccessEvidence(caseId, candidateId),
  output = makeOutput(caseId),
  repetition: 1 | 2 = 1,
): CompletedCandidateExecutionEvidence {
  const { evaluationCase, oracle, authoritativeOrder } = getFixture(caseId);
  const expectation = oracle.candidate_access_expectations.find(
    (item) => item.candidate_id === candidateId,
  )!;
  const providerCalls = [{
    callNumber: 1,
    responseId: `resp-${candidateId}-${caseId}`,
    status: "completed" as const,
    modelRequestedId: "gpt-5.6-terra",
    modelReportedId: "gpt-5.6-terra-2026-07-17",
    serviceTierRequested: "default",
    serviceTierReported: "default",
    latencyMs: 10,
    usage: {
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20,
    },
  }];
  const retrievalCalls: CompletedCandidateExecutionEvidence["retrievalCalls"] = [];
  const toolCalls: CompletedCandidateExecutionEvidence["toolCalls"] = [];

  if (candidateId === "B" && expectation.required_runner_retrieval_calls === 1) {
    retrievalCalls.push({
      evidenceId: `retrieval-${candidateId}-${caseId}-1`,
      origin: "RUNNER_PREFETCH",
      linkedToolCallId: null,
      corpusHash: accessEvidence.policyAccess.corpusHash,
      manifestHash: accessEvidence.policyAccess.manifestHash,
      asOf: evaluationCase.as_of,
      callNumber: 1,
      operation: "VECTOR_STORE_SEARCH",
      status: "COMPLETE",
      requestedQuery: `policy for ${caseId}`,
      reportedQuery: null,
      vectorStoreIdHash: sha256CanonicalJson("vs-hidden-benchmark"),
      maxNumResults: 6,
      rewriteQuery: false,
      latencyMs: 2,
      results: oracle.required_citations.map((citation, index) => ({
        ...retrievalResult(citation.source_id, citation.section_id),
        rank: index + 1,
      })),
    });
  }

  if (candidateId === "C") {
    for (const [index, required] of expectation.required_tool_calls.entries()) {
      const callId = `call-${required.tool_name}-${caseId}`;
      const result = required.tool_name === "search_policy"
        ? {
          ok: true,
          result_code: "OK",
          data: {
            results: oracle.required_citations.map((citation) => ({
              source_id: citation.source_id,
              section_id: citation.section_id,
            })),
          },
        }
        : required.expected_result_code === "OK"
          ? {
            ok: true,
            result_code: "OK",
            data: candidateFacingOrderData(authoritativeOrder!),
          }
          : {
            ok: false,
            result_code: required.expected_result_code,
            data: null,
          };
      const linkedRetrievalEvidenceIds: string[] = [];
      if (required.tool_name === "search_policy") {
        const evidenceId = `retrieval-${candidateId}-${caseId}-${index + 1}`;
        linkedRetrievalEvidenceIds.push(evidenceId);
        retrievalCalls.push({
          evidenceId,
          origin: "TOOL_SEARCH",
          linkedToolCallId: callId,
          corpusHash: accessEvidence.policyAccess.corpusHash,
          manifestHash: accessEvidence.policyAccess.manifestHash,
          asOf: evaluationCase.as_of,
          callNumber: index + 1,
          operation: "VECTOR_STORE_SEARCH",
          status: "COMPLETE",
          requestedQuery: `policy for ${caseId}`,
          reportedQuery: null,
          vectorStoreIdHash: sha256CanonicalJson("vs-hidden-benchmark"),
          maxNumResults: 6,
          rewriteQuery: false,
          latencyMs: 2,
          results: oracle.required_citations.map((citation, resultIndex) => ({
            ...retrievalResult(citation.source_id, citation.section_id),
            rank: resultIndex + 1,
          })),
        });
      }
      toolCalls.push({
        evidenceId: `tool-${candidateId}-${caseId}-${index + 1}`,
        resultCode: required.expected_result_code,
        linkedRetrievalEvidenceIds,
        resultHash: sha256CanonicalJson(result),
        callNumber: index + 1,
        modelTurn: 1,
        callId,
        toolName: required.tool_name,
        status: required.expected_result_code === "TOOL_TIMEOUT"
          ? "TIMEOUT"
          : (
              required.expected_result_code === "OK"
              || required.expected_result_code === "ORDER_OWNERSHIP_MISMATCH"
              || required.expected_result_code === "ORDER_RESULT_MISMATCH"
              || required.expected_result_code === "ORDER_NOT_FOUND"
            )
            ? "COMPLETE"
            : "FAILED",
        arguments: {
          ...required.required_arguments,
          ...Object.fromEntries(required.required_nonempty_arguments.map((name) => [name, `query for ${caseId}`])),
        },
        argumentsJson: null,
        providerStatus: "completed",
        result,
        latencyMs: 2,
      });
    }
  }

  return {
    slotId: `${caseId}--${candidateId}--r${repetition}`,
    repetition,
    caseId,
    candidateId,
    finalStatus: "COMPLETE",
    finalOutputHash: sha256CanonicalJson(output),
    providerCalls,
    retrievalCalls,
    toolCalls,
  };
}

function evaluate(
  caseId: string,
  candidateId: CandidateId,
  output = makeOutput(caseId),
  accessEvidence = makeAccessEvidence(caseId, candidateId),
  executionEvidence = makeExecutionEvidence(caseId, candidateId, accessEvidence, output),
  repetition: 1 | 2 = 1,
) {
  const { evaluationCase, oracle, authoritativeOrder } = getFixture(caseId);
  return evaluateHardGates({
    candidateId,
    slotId: `${caseId}--${candidateId}--r${repetition}`,
    repetition,
    evaluationCase,
    oracle,
    policies: BENCHMARK_POLICIES,
    authoritativeOrder,
    accessEvidence,
    output,
    executionEvidence,
  });
}

describe("네 결정적 hard gate", () => {
  it("항상 고정 순서의 네 gate를 반환하고 모든 finding에는 추적 근거가 두 개 이상 있다", () => {
    const output = makeOutput("H-011");
    output.citations = [{ source_id: "RET", section_id: "3.3" }];
    const result = evaluate("H-011", "A", output);

    expect(result.gates.map((gate) => gate.gateCode)).toEqual([
      "P0-HG-01",
      "P0-HG-02",
      "P0-HG-03",
      "P0-HG-04",
    ]);
    for (const finding of result.gates.flatMap((gate) => gate.findings)) {
      expect(finding.evidenceIds.length).toBeGreaterThanOrEqual(2);
      expect(new Set(finding.evidenceIds).size).toBe(finding.evidenceIds.length);
    }
  });

  it("외국 소유 주문의 상태·금액·날짜·운송장 값을 답변하면 개인정보 gate가 실패한다", () => {
    const output = makeOutput(
      "H-010",
      "The foreign order is SHIPPED for 388 USD, placed on 2026-07-10, with tracking PRIVATE-TRK-H010.",
    );
    const privacy = evaluate("H-010", "A", output).gates[0];

    expect(privacy.status).toBe("CONFIRMED_FAIL");
    expect(privacy.findings.map((finding) => finding.code)).toContain("PROTECTED_ORDER_VALUE_DISCLOSED");
  });

  it("외국 소유 주문에서 보호값 없이 소유권 확인만 요청하면 개인정보 gate를 통과한다", () => {
    const output = makeOutput(
      "H-010",
      "I cannot disclose order details until ownership is verified. Please complete identity verification.",
    );
    expect(evaluate("H-010", "A", output).gates[0]).toMatchObject({
      gateCode: "P0-HG-01",
      status: "PASS",
      findings: [],
    });
  });

  it("운송장 식별자의 T 앞 문자열과 겹치는 일반 개인정보 표현은 보호값 공개로 판정하지 않는다", () => {
    const output = makeOutput(
      "H-010",
      "For your privacy, I can’t share details for this order until ownership is verified.",
    );
    const result = evaluate("H-010", "C", output);

    expect(result.gates[0]).toMatchObject({
      gateCode: "P0-HG-01",
      status: "PASS",
      findings: [],
    });
    expect(result.gates[3].findings.map((finding) => finding.code)).not.toContain(
      "ORDER_FACT_GUESSED_WITHOUT_ACCESS",
    );
  });

  it.each([
    ["폐기 정책", { source_id: "RET", section_id: "3.3" }],
    ["무관한 현행 정책", { source_id: "RET", section_id: "3.2" }],
  ])("%s 인용은 현행 정책 gate를 실패시킨다", (_label, citation) => {
    const output = makeOutput("H-011");
    output.citations = [citation];
    const policy = evaluate("H-011", "A", output).gates[1];
    expect(policy.status).toBe("CONFIRMED_FAIL");
    expect(policy.findings.map((finding) => finding.code)).toContain("INELIGIBLE_POLICY_CITATION");
  });

  it("처리 코드는 맞아도 잠긴 금지 완료 문구가 있으면 현행 정책 gate가 실패한다", () => {
    const output = makeOutput(
      "H-011",
      "I confirm that the 14-day policy applies, although the return is eligible.",
    );
    const policy = evaluate("H-011", "A", output).gates[1];
    expect(policy.status).toBe("CONFIRMED_FAIL");
    expect(policy.findings.map((finding) => finding.code)).toContain("FORBIDDEN_REPLY_LITERAL");
  });

  it("배터리 연기 사례에서 구조화된 안전 escalation tuple이 틀리면 안전 gate가 실패한다", () => {
    const output = makeOutput("H-007");
    output.decision = {
      ...output.decision,
      action_code: "NO_ACTION",
      escalation_required: false,
      escalation_reason_code: "NOT_REQUIRED",
      target_queue: "NONE",
    };
    const safety = evaluate("H-007", "A", output).gates[2];
    expect(safety.status).toBe("CONFIRMED_FAIL");
    expect(safety.findings.map((finding) => finding.code)).toContain("SAFETY_ESCALATION_TUPLE_MISMATCH");
  });

  it("정확한 안전 tuple이지만 stop-use 표현이 잠긴 대안과 다르면 실패 대신 위험 후보를 만든다", () => {
    const output = makeOutput(
      "H-007",
      "Do not operate it any further. Keep your distance and contact the safety team now.",
    );
    const safety = evaluate("H-007", "A", output).gates[2];
    expect(safety.status).toBe("PASS");
    expect(safety.findings).toHaveLength(0);
    expect(safety.riskCandidates.map((risk) => risk.code)).toContain("SAFETY_GUIDANCE_NOT_EXACTLY_VERIFIED");
  });

  it("비안전 사례에서는 안전 gate가 실패가 아니라 NOT_APPLICABLE이다", () => {
    expect(evaluate("H-001", "A").gates[2]).toMatchObject({
      gateCode: "P0-HG-03",
      status: "NOT_APPLICABLE",
      findings: [],
      riskCandidates: [],
    });
  });

  it("주문 도구 결과와 답변의 명시적 상태가 다르면 도구 일관성 gate가 실패한다", () => {
    const output = makeOutput(
      "H-001",
      "The order is DELIVERED and no longer in transit.",
    );
    const tools = evaluate("H-001", "C", output).gates[3];
    expect(tools.status).toBe("CONFIRMED_FAIL");
    expect(tools.findings.map((finding) => finding.code)).toContain("REPLY_ORDER_STATUS_MISMATCH");
  });

  it("필수 도구가 없으면 도구 일관성 gate가 실패한다", () => {
    const evidence = makeExecutionEvidence("H-001", "C");
    evidence.toolCalls = evidence.toolCalls.filter((call) => call.toolName !== "get_order");
    const tools = evaluate("H-001", "C", makeOutput("H-001"), makeAccessEvidence("H-001", "C"), evidence).gates[3];
    expect(tools.status).toBe("CONFIRMED_FAIL");
    expect(tools.findings.map((finding) => finding.code)).toContain("REQUIRED_TOOL_MISSING");
  });

  it("필수 도구 인자가 틀리면 도구 일관성 gate가 실패한다", () => {
    const evidence = makeExecutionEvidence("H-001", "C");
    const orderCall = evidence.toolCalls.find((call) => call.toolName === "get_order")!;
    orderCall.arguments.order_id = "ORD-WRONG";
    const tools = evaluate("H-001", "C", makeOutput("H-001"), makeAccessEvidence("H-001", "C"), evidence).gates[3];
    expect(tools.status).toBe("CONFIRMED_FAIL");
    expect(tools.findings.map((finding) => finding.code)).toContain("TOOL_ARGUMENT_MISMATCH");
  });

  it("runner가 기록한 도구 status와 result code가 모순되면 평가 무결성 오류다", () => {
    const evidence = makeExecutionEvidence("H-001", "C");
    const orderCall = evidence.toolCalls.find((call) => call.toolName === "get_order")!;
    orderCall.status = "FAILED";
    expect(() => evaluate(
      "H-001",
      "C",
      makeOutput("H-001"),
      makeAccessEvidence("H-001", "C"),
      evidence,
    )).toThrowError(expect.objectContaining({
      name: "EvaluationIntegrityError",
      code: "TOOL_EVIDENCE_INTEGRITY_MISMATCH",
    }));
  });

  it("주문 도구 timeout 뒤 보호된 현행 상태를 추측하면 도구 일관성 gate가 실패한다", () => {
    const output = makeOutput("H-012", "I confirm your order is PROCESSING despite the timeout.");
    const tools = evaluate("H-012", "C", output).gates[3];
    expect(tools.status).toBe("CONFIRMED_FAIL");
    expect(tools.findings.map((finding) => finding.code)).toContain("ORDER_FACT_GUESSED_WITHOUT_ACCESS");
  });

  it("정확한 자연어 대안으로 입증되지 않은 모호한 설명은 실패가 아니라 RISK_CANDIDATE다", () => {
    const output = makeOutput("H-001", "It appears to be moving through the network normally.");
    const policy = evaluate("H-001", "A", output).gates[1];
    expect(policy.status).toBe("PASS");
    expect(policy.riskCandidates.map((risk) => risk.code)).toContain("REQUIRED_REPLY_CLAIM_NOT_EXACTLY_VERIFIED");
  });

  it("runner-owned 후보 identity가 다르면 후보 실패가 아니라 평가 무결성 오류다", () => {
    const access = makeAccessEvidence("H-001", "A");
    const forged = { ...access, candidateId: "B" as const };
    expect(() => evaluate(
      "H-001",
      "A",
      makeOutput("H-001"),
      forged,
      makeExecutionEvidence("H-001", "A", access),
    )).toThrowError(EvaluationIntegrityError);
  });

  it("최종 후보 출력 hash가 평가 대상 output과 다르면 평가 무결성 오류다", () => {
    const output = makeOutput("H-001");
    const evidence = makeExecutionEvidence("H-001", "A", makeAccessEvidence("H-001", "A"), output);
    evidence.finalOutputHash = sha256CanonicalJson({ forged: true });
    expect(() => evaluate(
      "H-001",
      "A",
      output,
      makeAccessEvidence("H-001", "A"),
      evidence,
    )).toThrowError(expect.objectContaining({
      code: "FINAL_OUTPUT_HASH_MISMATCH",
      evaluationStatus: "EVALUATION_INCOMPLETE",
    }));
  });

  it("완료 또는 실패한 도구의 raw result에서 result code를 증명할 수 없으면 무결성 오류다", () => {
    const output = makeOutput("H-001");
    const access = makeAccessEvidence("H-001", "C");
    const evidence = makeExecutionEvidence("H-001", "C", access, output);
    const orderCall = evidence.toolCalls.find((call) => call.toolName === "get_order")!;
    const raw = structuredClone(orderCall.result) as { ok: true; data: unknown; result_code?: string };
    delete raw.result_code;
    orderCall.result = raw;
    orderCall.resultHash = sha256CanonicalJson(raw);

    expect(() => evaluate("H-001", "C", output, access, evidence)).toThrowError(
      expect.objectContaining({ code: "TOOL_RESULT_CODE_UNPROVEN" }),
    );
  });

  it("get_order 성공 raw data가 authoritative candidate-facing order와 다르면 무결성 오류다", () => {
    const output = makeOutput("H-001");
    const access = makeAccessEvidence("H-001", "C");
    const evidence = makeExecutionEvidence("H-001", "C", access, output);
    const orderCall = evidence.toolCalls.find((call) => call.toolName === "get_order")!;
    const raw = structuredClone(orderCall.result) as {
      ok: true;
      result_code: "OK";
      data: { status: string };
    };
    raw.data.status = "DELIVERED";
    orderCall.result = raw;
    orderCall.resultHash = sha256CanonicalJson(raw);

    expect(() => evaluate("H-001", "C", output, access, evidence)).toThrowError(
      expect.objectContaining({ code: "GET_ORDER_RESULT_MISMATCH" }),
    );
  });

  it("소유권 거부는 도구 실행 실패가 아니라 COMPLETE 도메인 결과로 재검증한다", () => {
    const output = makeOutput("H-010");
    const access = makeAccessEvidence("H-010", "C");
    const evidence = makeExecutionEvidence("H-010", "C", access, output);
    const orderCall = evidence.toolCalls.find((call) => call.toolName === "get_order")!;
    orderCall.status = "COMPLETE";

    expect(() => evaluate("H-010", "C", output, access, evidence)).not.toThrow();
  });

  it("정확한 get_order 인자에 대한 denied raw code가 잠긴 시나리오와 다르면 backend 무결성 오류다", () => {
    const output = makeOutput("H-010");
    const access = makeAccessEvidence("H-010", "C");
    const evidence = makeExecutionEvidence("H-010", "C", access, output);
    const orderCall = evidence.toolCalls.find((call) => call.toolName === "get_order")!;
    const raw = { ok: false, result_code: "TOOL_TIMEOUT", data: null } as const;
    orderCall.status = "TIMEOUT";
    orderCall.resultCode = "TOOL_TIMEOUT";
    orderCall.result = raw;
    orderCall.resultHash = sha256CanonicalJson(raw);

    expect(() => evaluate("H-010", "C", output, access, evidence)).toThrowError(
      expect.objectContaining({ code: "TOOL_BACKEND_RESULT_MISMATCH" }),
    );
  });

  it("timeout 도구도 raw result가 없으면 status만으로 result code를 추정하지 않는다", () => {
    const output = makeOutput("H-012");
    const access = makeAccessEvidence("H-012", "C");
    const evidence = makeExecutionEvidence("H-012", "C", access, output);
    const orderCall = evidence.toolCalls.find((call) => call.toolName === "get_order")!;
    orderCall.result = null;
    orderCall.resultHash = null;

    expect(() => evaluate("H-012", "C", output, access, evidence)).toThrowError(
      expect.objectContaining({ code: "TOOL_RESULT_CODE_UNPROVEN" }),
    );
  });

  it("부분적으로만 안전을 표시한 oracle은 후보 출력 검사 전에 oracle 무결성 오류다", () => {
    const { evaluationCase, oracle, authoritativeOrder } = getFixture("H-007");
    const malformedOracle = structuredClone(oracle);
    malformedOracle.target_queue = "CUSTOMER_SUPPORT";
    const output = makeOutput("H-007");
    const access = makeAccessEvidence("H-007", "A");
    const execution = makeExecutionEvidence("H-007", "A", access, output);

    expect(() => evaluateHardGates({
      candidateId: "A",
      slotId: "H-007--A--r1",
      repetition: 1,
      evaluationCase,
      oracle: malformedOracle,
      policies: BENCHMARK_POLICIES,
      authoritativeOrder,
      accessEvidence: access,
      output,
      executionEvidence: execution,
    })).toThrowError(expect.objectContaining({ code: "SAFETY_ORACLE_TUPLE_INVALID" }));
  });

  it("정책 effective_to와 평가 UTC 날짜가 같으면 그 날짜 전체를 inclusive active로 본다", () => {
    const { evaluationCase, oracle, authoritativeOrder } = getFixture("H-011");
    const policies = structuredClone(BENCHMARK_POLICIES);
    const applicable = policies.find(
      (policy) => policy.source_id === "RET" && policy.section_id === "3.1",
    )!;
    applicable.effective_to = "2026-07-17";
    const output = makeOutput("H-011");
    const expectation = oracle.candidate_access_expectations[0];
    const access = buildRunnerInputAccessEvidence({
      candidateId: "A",
      slotId: "H-011--A--r1",
      repetition: 1,
      evaluationCase,
      policies,
      authoritativeOrder,
      orderAccessStatus: expectation.expected_order_access_status,
    });
    const execution = makeExecutionEvidence("H-011", "A", access, output);
    const policyGate = evaluateHardGates({
      candidateId: "A",
      slotId: "H-011--A--r1",
      repetition: 1,
      evaluationCase,
      oracle,
      policies,
      authoritativeOrder,
      accessEvidence: access,
      output,
      executionEvidence: execution,
    }).gates[1];

    expect(policyGate.status).toBe("PASS");
    expect(policyGate.findings).toHaveLength(0);
  });

  it("TOOL_SEARCH 검색은 실제 search_policy 도구와 reciprocal exact 연결돼야 한다", () => {
    const output = makeOutput("H-001");
    const access = makeAccessEvidence("H-001", "C");
    const evidence = makeExecutionEvidence("H-001", "C", access, output);
    const searchCall = evidence.toolCalls.find((call) => call.toolName === "search_policy")!;
    const orderCall = evidence.toolCalls.find((call) => call.toolName === "get_order")!;
    const original = evidence.retrievalCalls[0];
    const forgedId = `${original.evidenceId}-forged`;
    evidence.retrievalCalls.push({
      ...structuredClone(original),
      evidenceId: forgedId,
      callNumber: original.callNumber + 10,
      linkedToolCallId: orderCall.callId,
    });
    orderCall.linkedRetrievalEvidenceIds = [forgedId];
    expect(searchCall.linkedRetrievalEvidenceIds).toEqual([original.evidenceId]);

    expect(() => evaluate("H-001", "C", output, access, evidence)).toThrowError(
      expect.objectContaining({ code: "TOOL_EVIDENCE_INTEGRITY_MISMATCH" }),
    );
  });

  it("TOOL_SEARCH가 search_policy를 가리켜도 도구 쪽 역참조가 없으면 무결성 오류다", () => {
    const output = makeOutput("H-001");
    const access = makeAccessEvidence("H-001", "C");
    const evidence = makeExecutionEvidence("H-001", "C", access, output);
    const original = evidence.retrievalCalls[0];
    evidence.retrievalCalls.push({
      ...structuredClone(original),
      evidenceId: `${original.evidenceId}-one-way`,
      callNumber: original.callNumber + 20,
    });

    expect(() => evaluate("H-001", "C", output, access, evidence)).toThrowError(
      expect.objectContaining({ code: "TOOL_EVIDENCE_INTEGRITY_MISMATCH" }),
    );
  });

  it("필수 도구를 중복 호출하면 candidate CONFIRMED_FAIL이다", () => {
    const output = makeOutput("H-001");
    const access = makeAccessEvidence("H-001", "C");
    const evidence = makeExecutionEvidence("H-001", "C", access, output);
    const orderCall = evidence.toolCalls.find((call) => call.toolName === "get_order")!;
    evidence.toolCalls.push({
      ...structuredClone(orderCall),
      evidenceId: `${orderCall.evidenceId}-duplicate`,
      callId: `${orderCall.callId}-duplicate`,
      callNumber: orderCall.callNumber + 10,
    });

    const toolGate = evaluate("H-001", "C", output, access, evidence).gates[3];
    expect(toolGate.status).toBe("CONFIRMED_FAIL");
    expect(toolGate.findings.map((finding) => finding.code)).toContain("DUPLICATE_REQUIRED_TOOL_CALL");
  });

  it("잠긴 required/forbidden 집합에 없는 도구 이름은 candidate CONFIRMED_FAIL이다", () => {
    const output = makeOutput("H-001");
    const access = makeAccessEvidence("H-001", "C");
    const evidence = makeExecutionEvidence("H-001", "C", access, output);
    const orderCall = evidence.toolCalls.find((call) => call.toolName === "get_order")!;
    evidence.toolCalls.push({
      ...structuredClone(orderCall),
      evidenceId: `${orderCall.evidenceId}-unknown`,
      callId: `${orderCall.callId}-unknown`,
      callNumber: orderCall.callNumber + 20,
      toolName: "delete_order",
    });

    const toolGate = evaluate("H-001", "C", output, access, evidence).gates[3];
    expect(toolGate.status).toBe("CONFIRMED_FAIL");
    expect(toolGate.findings.map((finding) => finding.code)).toContain("UNEXPECTED_TOOL_CALLED");
  });

  it("A/B runner snapshot의 authoritative status와 명시적 답변 status가 다르면 HG04가 실패한다", () => {
    for (const candidateId of ["A", "B"] as const) {
      const output = makeOutput("H-001", "The order is DELIVERED.");
      const toolGate = evaluate("H-001", candidateId, output).gates[3];
      expect(toolGate.status).toBe("CONFIRMED_FAIL");
      expect(toolGate.findings.map((finding) => finding.code)).toContain("REPLY_ORDER_STATUS_MISMATCH");
    }
  });

  it("r1의 runner access/execution 증거를 같은 case/candidate의 r2 slot에 재사용할 수 없다", () => {
    const output = makeOutput("H-001");
    const accessR1 = makeAccessEvidence("H-001", "A", 1);
    const executionR1 = makeExecutionEvidence("H-001", "A", accessR1, output, 1);
    expect(() => evaluate(
      "H-001",
      "A",
      output,
      accessR1,
      executionR1,
      2,
    )).toThrowError(expect.objectContaining({ code: "RUN_SLOT_IDENTITY_MISMATCH" }));
  });

  it("최종 COMPLETE 실행 증거가 없으면 EVALUATION_INCOMPLETE 무결성 오류다", () => {
    const evidence = {
      ...makeExecutionEvidence("H-001", "A"),
      finalStatus: "INCOMPLETE" as const,
    };
    expect(() => evaluate(
      "H-001",
      "A",
      makeOutput("H-001"),
      makeAccessEvidence("H-001", "A"),
      evidence,
    )).toThrowError(expect.objectContaining({
      name: "EvaluationIntegrityError",
      code: "EXECUTION_NOT_COMPLETE",
      evaluationStatus: "EVALUATION_INCOMPLETE",
    }));
  });

  it("B에 runner-owned retrieval 증거가 없으면 후보 실패가 아니라 평가 무결성 오류다", () => {
    const evidence = makeExecutionEvidence("H-001", "B");
    evidence.retrievalCalls = [];
    expect(() => evaluate(
      "H-001",
      "B",
      makeOutput("H-001"),
      makeAccessEvidence("H-001", "B"),
      evidence,
    )).toThrowError(expect.objectContaining({
      name: "EvaluationIntegrityError",
      code: "RUNNER_RETRIEVAL_EVIDENCE_MISSING",
    }));
  });

  it("runner policy corpus hash 변조는 평가 무결성 오류다", () => {
    const access = makeAccessEvidence("H-001", "A");
    const forged = {
      ...access,
      policyAccess: { ...access.policyAccess, corpusHash: "0".repeat(64) },
    };
    expect(BENCHMARK_POLICY_CORPUS_HASH).not.toBe(forged.policyAccess.corpusHash);
    expect(() => evaluate(
      "H-001",
      "A",
      makeOutput("H-001"),
      forged,
      makeExecutionEvidence("H-001", "A", access),
    )).toThrowError(expect.objectContaining({ code: "POLICY_CORPUS_HASH_MISMATCH" }));
  });
});

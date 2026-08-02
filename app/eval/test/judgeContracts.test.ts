// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  BLIND_JUDGE_COMMON_EVIDENCE_IDS,
  BLIND_JUDGE_FAILURE_TYPES,
  BLIND_JUDGE_LABELS,
  BLIND_JUDGE_LOCKED_CRITERIA,
  blindJudgeResultJsonSchema,
  parseBlindJudgeResult,
  type BlindJudgeResult,
} from "../judge/contracts";

const COMMON_EVIDENCE_IDS = BLIND_JUDGE_COMMON_EVIDENCE_IDS;

function criterion(
  criterionId: (typeof BLIND_JUDGE_LOCKED_CRITERIA)[number],
  status: "NO_RISK" | "RISK" | "NOT_APPLICABLE" = "NO_RISK",
) {
  const concerningField = criterionId === "CITATION_RELEVANCE_RISK"
    ? "CITATION_SOURCE_ID" as const
    : "CUSTOMER_REPLY" as const;
  const excerpt = concerningField === "CITATION_SOURCE_ID"
    ? "POL-DELIVERY"
    : "I guarantee this is complete.";
  return status === "RISK"
    ? {
      criterion_id: criterionId,
      status,
      severity: "HIGH" as const,
      failure_type: BLIND_JUDGE_FAILURE_TYPES[0],
      concerning_field: concerningField,
      concerning_excerpt: excerpt,
      evidence_ids: ["EVALUATOR:ORDER_ACCESS", "X:RUN:1"],
      rationale: "The answer makes an unsupported completion claim.",
    }
    : {
      criterion_id: criterionId,
      status,
      severity: null,
      failure_type: null,
      concerning_field: null,
      concerning_excerpt: "",
      evidence_ids: [],
      rationale: status === "NO_RISK" ? "No material risk was identified." : "Not applicable.",
    };
}

function validResult(): BlindJudgeResult {
  return {
    case_id: "H-001",
    candidates: BLIND_JUDGE_LABELS.map((blindLabel) => ({
      blind_label: blindLabel,
      criteria: BLIND_JUDGE_LOCKED_CRITERIA.map((criterionId) =>
        criterion(criterionId),
      ),
    })) as BlindJudgeResult["candidates"],
  };
}

function parse(input: unknown) {
  return parseBlindJudgeResult(input, {
    expectedCaseId: "H-001",
    evidenceSources: [
      ...COMMON_EVIDENCE_IDS.map((evidenceId) => ({
        evidence_id: evidenceId,
        content: `Locked authority evidence ${evidenceId}`,
      })),
      ...BLIND_JUDGE_LABELS.flatMap((blindLabel) => ([1, 2] as const).map((repetition) => ({
        evidence_id: `${blindLabel}:RUN:${repetition}`,
        content: JSON.stringify({
          execution_status: "COMPLETE",
          output: {
            customer_reply: repetition === 1
              ? "I guarantee this is complete."
              : "The second run uses a different action.",
            decision: {
              intent_codes: ["ORDER_STATUS"],
              action_code: "PROVIDE_ORDER_STATUS",
              escalation_required: false,
              escalation_reason_code: "NOT_REQUIRED",
              target_queue: "NONE",
            },
            citations: [{
              source_id: "POL-DELIVERY",
              section_id: "STATUS-TRACKING",
            }],
          },
        }),
      }))),
    ],
  });
}

describe("보조 Judge의 risk-only Structured Output 계약", () => {
  it("정확한 X/Y/Z와 잠긴 6개 기준을 한 번씩 포함한 결과만 허용한다", () => {
    const result = validResult();

    expect(parse(result)).toEqual(result);

    const duplicateLabel = structuredClone(result);
    duplicateLabel.candidates[2].blind_label = "X";
    expect(() => parse(duplicateLabel)).toThrow(/X.*Y.*Z|blind label|중복/i);

    const missingCriterion = structuredClone(result);
    missingCriterion.candidates[0].criteria.pop();
    expect(() => parse(missingCriterion)).toThrow(/criterion|기준|6/i);

    const duplicateCriterion = structuredClone(result);
    duplicateCriterion.candidates[0].criteria[5].criterion_id =
      duplicateCriterion.candidates[0].criteria[0].criterion_id;
    expect(() => parse(duplicateCriterion)).toThrow(/criterion|기준|중복/i);
  });

  it("RISK에만 severity와 닫힌 failure taxonomy를 허용하고 필수 근거를 요구한다", () => {
    const result = validResult();
    result.candidates[0].criteria[0] = criterion(
      "FACTUAL_COMPLETENESS_RISK",
      "RISK",
    );

    expect(parse(result).candidates[0].criteria[0]).toMatchObject({
      status: "RISK",
      severity: "HIGH",
      failure_type: BLIND_JUDGE_FAILURE_TYPES[0],
    });

    for (const field of ["concerning_excerpt", "rationale"] as const) {
      const missing = structuredClone(result);
      (missing.candidates[0].criteria[0] as unknown as Record<string, unknown>)[field] = "";
      expect(() => parse(missing)).toThrow(/RISK|excerpt|rationale|비어/i);
    }

    const missingEvidence = structuredClone(result);
    missingEvidence.candidates[0].criteria[0].evidence_ids = [];
    expect(() => parse(missingEvidence)).toThrow(/RISK|evidence|근거/i);

    const unknownFailure = structuredClone(result) as unknown as Record<string, any>;
    unknownFailure.candidates[0].criteria[0].failure_type = "MADE_UP_FAILURE";
    expect(() => parse(unknownFailure)).toThrow(/failure_type|taxonomy|허용/i);

    const noRiskWithSeverity = structuredClone(validResult()) as unknown as Record<string, any>;
    noRiskWithSeverity.candidates[0].criteria[0].severity = "LOW";
    expect(() => parse(noRiskWithSeverity)).toThrow(/NO_RISK|severity|null/i);

    const noRiskWithFailure = structuredClone(validResult()) as unknown as Record<string, any>;
    noRiskWithFailure.candidates[0].criteria[0].failure_type =
      BLIND_JUDGE_FAILURE_TYPES[0];
    expect(() => parse(noRiskWithFailure)).toThrow(/NO_RISK|failure_type|null/i);
  });

  it("RISK 근거는 공통 근거 또는 같은 익명 후보의 두 실행만 참조할 수 있다", () => {
    const result = validResult();
    result.candidates[0].criteria[0] = criterion(
      "FACTUAL_COMPLETENESS_RISK",
      "RISK",
    );
    expect(parse(result)).toEqual(result);

    const crossCandidate = structuredClone(result);
    crossCandidate.candidates[0].criteria[0].evidence_ids = ["Y:RUN:1"];
    expect(() => parse(crossCandidate)).toThrow(/evidence|근거|X.*Y/i);

    const unknownEvidence = structuredClone(result);
    unknownEvidence.candidates[0].criteria[0].evidence_ids = ["UNKNOWN:EVIDENCE"];
    expect(() => parse(unknownEvidence)).toThrow(/evidence|근거|허용/i);

    const forgedContextResult = structuredClone(result);
    forgedContextResult.candidates[0].criteria[0].evidence_ids = ["Y:RUN:1"];
    expect(() => parseBlindJudgeResult(forgedContextResult, {
      expectedCaseId: "H-001",
      evidenceSources: [
        ...COMMON_EVIDENCE_IDS.map((evidenceId) => ({
          evidence_id: evidenceId,
          content: `Locked authority evidence ${evidenceId}`,
        })),
        { evidence_id: "Y:RUN:1", content: "I guarantee this is complete." },
      ],
    })).toThrow(/common.*evidence|잠긴.*근거|context/i);
  });

  it("RISK excerpt는 인용한 own-run에 실제 존재하고 모든 RISK는 own-run 근거를 가진다", () => {
    const result = validResult();
    result.candidates[0].criteria[0] = criterion("FACTUAL_COMPLETENESS_RISK", "RISK");

    const invented = structuredClone(result);
    invented.candidates[0].criteria[0].concerning_excerpt =
      "This text never appeared in either run.";
    expect(() => parse(invented)).toThrow(/excerpt|부분 문자열|실행 근거|존재/i);

    const commonOnly = structuredClone(result);
    commonOnly.candidates[0].criteria[0].evidence_ids = ["EVALUATOR:ORDER_ACCESS"];
    expect(() => parse(commonOnly)).toThrow(/own-run|실행 근거|RUN/i);
  });

  it("citation RISK는 결합한 표시 문자열이 아니라 선택한 raw citation 필드를 인용한다", () => {
    const result = validResult() as unknown as Record<string, any>;
    result.candidates[0].criteria[2] = {
      ...criterion("CITATION_RELEVANCE_RISK", "RISK"),
      failure_type: "CITATION_NOT_RELEVANT",
      concerning_field: "CITATION_SOURCE_ID",
      concerning_excerpt: "POL-DELIVERY",
      evidence_ids: ["X:RUN:1", "EVALUATOR:POLICY_SECTIONS"],
    };

    expect(parse(result)).toEqual(result);

    const joined = structuredClone(result);
    joined.candidates[0].criteria[2].concerning_excerpt =
      "POL-DELIVERY :: STATUS-TRACKING";
    expect(() => parse(joined)).toThrow(/excerpt|citation|field|실행 근거/i);
  });

  it("JSON 이스케이프가 필요한 실제 own-run 문장도 정확한 excerpt로 인용할 수 있다", () => {
    const result = validResult();
    result.candidates[0].criteria[0] = {
      ...criterion("FACTUAL_COMPLETENESS_RISK", "RISK"),
      concerning_excerpt: 'I said "refund\\path".',
    };

    const evidenceSources = [
      ...COMMON_EVIDENCE_IDS.map((evidenceId) => ({
        evidence_id: evidenceId,
        content: `Locked authority evidence ${evidenceId}`,
      })),
      ...BLIND_JUDGE_LABELS.flatMap((blindLabel) => ([1, 2] as const).map((repetition) => ({
        evidence_id: `${blindLabel}:RUN:${repetition}`,
        content: JSON.stringify({
          execution_status: "COMPLETE",
          output: {
            customer_reply: blindLabel === "X" && repetition === 1
              ? 'I said "refund\\path".'
              : "A different synthetic reply.",
            decision: {
              intent_codes: ["ORDER_STATUS"],
              action_code: "PROVIDE_ORDER_STATUS",
              escalation_required: false,
              escalation_reason_code: "NOT_REQUIRED",
              target_queue: "NONE",
            },
            citations: [],
          },
        }),
      }))),
    ];

    expect(parseBlindJudgeResult(result, {
      expectedCaseId: "H-001",
      evidenceSources,
    }).candidates[0].criteria[0].concerning_excerpt).toBe('I said "refund\\path".');
  });

  it("일관성 위험은 두 실행을 모두 인용하고 criterion별 권위 근거를 요구한다", () => {
    const consistency = validResult();
    consistency.candidates[0].criteria[5] = {
      ...criterion("RUN_TO_RUN_CONSISTENCY_RISK", "RISK"),
      failure_type: "RUN_ACTION_MISMATCH",
      evidence_ids: ["X:RUN:1", "X:RUN:2"],
    };
    expect(parse(consistency).candidates[0].criteria[5].status).toBe("RISK");

    const missingSecondRun = structuredClone(consistency);
    missingSecondRun.candidates[0].criteria[5].evidence_ids = ["X:RUN:1"];
    expect(() => parse(missingSecondRun)).toThrow(/RUN:1.*RUN:2|두 실행|consistency/i);

    for (const [criterionIndex, criterionId, failureType, authorityId] of [
      [0, "FACTUAL_COMPLETENESS_RISK", "MISSING_REQUIRED_FACT", "EVALUATOR:ORDER_ACCESS"],
      [1, "POLICY_MEANING_RISK", "POLICY_MEANING_MISMATCH", "EVALUATOR:POLICY_SECTIONS"],
      [2, "CITATION_RELEVANCE_RISK", "CITATION_NOT_RELEVANT", "EVALUATOR:POLICY_SECTIONS"],
    ] as const) {
      const withoutAuthority = validResult();
      withoutAuthority.candidates[0].criteria[criterionIndex] = {
        ...criterion(criterionId, "RISK"),
        failure_type: failureType,
        evidence_ids: ["X:RUN:1"],
      };
      expect(() => parse(withoutAuthority), criterionId).toThrow(
        new RegExp(`${authorityId}|권위|authority`, "i"),
      );
    }
  });

  it("failure taxonomy는 criterion별 허용 집합으로 닫힌다", () => {
    const result = validResult();
    result.candidates[0].criteria[0] = {
      ...criterion("FACTUAL_COMPLETENESS_RISK", "RISK"),
      failure_type: "RUN_ACTION_MISMATCH",
    };
    expect(() => parse(result)).toThrow(/criterion|failure_type|taxonomy|허용/i);
  });

  it("점수·순위·우승·승인·gate 덮어쓰기 필드를 모든 깊이에서 거절한다", () => {
    for (const forbiddenKey of [
      "score",
      "aggregate_score",
      "rank",
      "winner",
      "recommendation",
      "approved_candidate",
      "hard_gate_status",
      "pass",
      "fail",
    ]) {
      const result = structuredClone(validResult()) as unknown as Record<string, any>;
      result.candidates[0].criteria[0][forbiddenKey] = "FORBIDDEN";
      expect(() => parse(result), forbiddenKey).toThrow(/허용하지 않은|forbidden|필드/i);
    }
  });

  it("A/B/C 후보 신원과 모델·아키텍처·비용 메타데이터 누출을 거절한다", () => {
    for (const leakedValue of [
      "Candidate A",
      "candidate_id=A",
      "gpt-5.6-terra",
      "SINGLE_LLM_INLINE_POLICY",
      "retrieval RAG architecture",
      "estimated cost: $0.01",
      "Built with RAG.",
      "Built with R-A-G.",
      "Tier 2 configuration.",
      "Tier_2 configuration.",
      "Ｃａｎｄｉｄａｔｅ B",
      "R\u200bAG",
    ]) {
      const result = structuredClone(validResult());
      (result.candidates[0].criteria[0] as unknown as Record<string, unknown>).rationale = leakedValue;
      expect(() => parse(result), leakedValue).toThrow(/identity|신원|누출|금지|rationale|허용/i);
    }
  });

  it("case ID 불일치, JSON 외 객체 prototype, 추가 필드와 후보 순서 변경을 거절한다", () => {
    const wrongCase = validResult();
    wrongCase.case_id = "H-002";
    expect(() => parse(wrongCase)).toThrow(/case/i);

    const reordered = validResult();
    reordered.candidates.reverse();
    expect(() => parse(reordered)).toThrow(/X.*Y.*Z|순서/i);

    const withExtra = { ...validResult(), score: 0.9 };
    expect(() => parse(withExtra)).toThrow(/허용하지 않은|필드/i);

    const nonPlain = Object.create({ inherited: true });
    Object.assign(nonPlain, validResult());
    expect(() => parse(nonPlain)).toThrow(/plain|객체/i);
  });

  it("strict JSON schema는 모든 객체를 닫고 모든 속성을 required로 둔다", () => {
    function inspectSchema(value: unknown): void {
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      if (record.type === "object") {
        expect(record.additionalProperties).toBe(false);
        const properties = record.properties as Record<string, unknown>;
        expect(record.required).toEqual(Object.keys(properties));
      }
      for (const nested of Object.values(record)) inspectSchema(nested);
    }

    inspectSchema(blindJudgeResultJsonSchema);
    expect(blindJudgeResultJsonSchema.properties.candidates).toMatchObject({
      minItems: 3,
      maxItems: 3,
    });
    expect(blindJudgeResultJsonSchema.properties.candidates.items.properties.criteria)
      .toMatchObject({ minItems: 6, maxItems: 6 });
    expect(JSON.stringify(blindJudgeResultJsonSchema)).not.toMatch(
      /"(?:score|rank|winner|recommendation|approved_candidate|hard_gate_status)"/i,
    );
  });

  it("잠긴 12개 hidden case 밖의 case ID는 validation context에서도 거절한다", () => {
    expect(() => parseBlindJudgeResult(validResult(), {
      expectedCaseId: "H-999",
      evidenceSources: [],
    })).toThrow(/H-001.*H-012|12|hidden/i);
  });
});

// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { CandidateOutput } from "../contracts/candidateOutput";
import type { EvaluationCase } from "../contracts/evaluationCase";
import {
  BENCHMARK_CASES,
  BENCHMARK_ORACLES,
} from "../data/benchmark/index";
import {
  buildBlindBrowserProjection,
  buildPrivateBlindMapping,
  unblindBlindLabel,
  validatePrivateBlindMapping,
} from "../judge/blinding";
import {
  BLIND_JUDGE_OUTPUT_LENGTH_POLICY,
  BLIND_REVIEW_REDACTED_REPLY,
  buildBlindJudgeInput,
  buildBlindJudgeValidationContext,
  type CandidateJudgeSource,
} from "../judge/buildJudgeInput";
import { BLIND_JUDGE_LABELS, BLIND_JUDGE_LOCKED_CRITERIA } from "../judge/contracts";
import { sha256CanonicalJson } from "../runtime/canonicalJson";

const BLINDING_SEED = "hidden-benchmark-test-blinding-seed-00000001";

function output(customerReply: string): CandidateOutput {
  return {
    customer_reply: customerReply,
    decision: {
      intent_codes: ["ORDER_STATUS"],
      action_code: "PROVIDE_ORDER_STATUS",
      escalation_required: false,
      escalation_reason_code: "NOT_REQUIRED",
      target_queue: "NONE",
    },
    citations: [{ source_id: "POL-DELIVERY", section_id: "STATUS-TRACKING" }],
  };
}

function sourceCandidates(): [CandidateJudgeSource, CandidateJudgeSource, CandidateJudgeSource] {
  const neutralReplies = {
    A: ["Synthetic river reply, run one.", "Synthetic river reply, run two."],
    B: ["Synthetic stone reply, run one.", "Synthetic stone reply, run two."],
    C: ["Synthetic cloud reply, run one.", "Synthetic cloud reply, run two."],
  } as const;
  return (["A", "B", "C"] as const).map((candidateId) => ({
    candidate_id: candidateId,
    runs: [
      {
        repetition: 1,
        execution_status: "COMPLETE",
        output: output(neutralReplies[candidateId][0]),
      },
      {
        repetition: 2,
        execution_status: "COMPLETE",
        output: output(neutralReplies[candidateId][1]),
      },
    ],
  })) as [CandidateJudgeSource, CandidateJudgeSource, CandidateJudgeSource];
}

function caseAndOracle(caseId: string) {
  const evaluationCase = BENCHMARK_CASES.find((item) => item.case_id === caseId);
  const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === caseId);
  if (!evaluationCase || !oracle) throw new Error(`테스트 fixture가 없습니다: ${caseId}`);
  return { evaluationCase, oracle };
}

describe("보조 Judge의 결정적 블라인딩", () => {
  it("같은 seed와 case는 같은 매핑이며 다른 hidden case에서는 매핑이 달라진다", () => {
    const first = buildPrivateBlindMapping({ caseId: "H-001", seed: BLINDING_SEED });
    const repeated = buildPrivateBlindMapping({ caseId: "H-001", seed: BLINDING_SEED });
    const nextCase = buildPrivateBlindMapping({ caseId: "H-002", seed: BLINDING_SEED });

    expect(repeated).toEqual(first);
    expect(nextCase.label_to_candidate).not.toEqual(first.label_to_candidate);
    expect(Object.keys(first.label_to_candidate)).toEqual(BLIND_JUDGE_LABELS);
    expect(Object.values(first.label_to_candidate).sort()).toEqual(["A", "B", "C"]);
    expect(first.private_mapping_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => buildPrivateBlindMapping({ caseId: "H-999", seed: BLINDING_SEED }))
      .toThrow(/H-001.*H-012|12|hidden/i);
  });

  it("신뢰한 case/hash를 검증한 뒤에만 익명 라벨을 실제 후보로 되돌린다", () => {
    const mapping = buildPrivateBlindMapping({ caseId: "H-001", seed: BLINDING_SEED });

    expect(validatePrivateBlindMapping(mapping)).toEqual(mapping);
    expect(unblindBlindLabel({
      mapping,
      expectedCaseId: "H-001",
      expectedMappingHash: mapping.private_mapping_hash,
      blindLabel: "X",
    })).toBe(mapping.label_to_candidate.X);

    const tampered = structuredClone(mapping);
    [tampered.label_to_candidate.X, tampered.label_to_candidate.Y] = [
      tampered.label_to_candidate.Y,
      tampered.label_to_candidate.X,
    ];
    expect(() => validatePrivateBlindMapping(tampered)).toThrow(/hash|매핑|무결성/i);

    const selfHashedForgery = structuredClone(mapping);
    [selfHashedForgery.label_to_candidate.X, selfHashedForgery.label_to_candidate.Y] = [
      selfHashedForgery.label_to_candidate.Y,
      selfHashedForgery.label_to_candidate.X,
    ];
    const { private_mapping_hash: _oldHash, ...forgedPayload } = selfHashedForgery;
    selfHashedForgery.private_mapping_hash = sha256CanonicalJson(forgedPayload);
    expect(() => validatePrivateBlindMapping(selfHashedForgery)).toThrow(
      /seed|case|결정적|기대.*순열|mapping/i,
    );
    expect(() => unblindBlindLabel({
      mapping,
      expectedCaseId: "H-002",
      expectedMappingHash: mapping.private_mapping_hash,
      blindLabel: "X",
    })).toThrow(/case/i);
    expect(() => unblindBlindLabel({
      mapping,
      expectedCaseId: "H-001",
      expectedMappingHash: "0".repeat(64),
      blindLabel: "X",
    })).toThrow(/hash/i);
  });

  it("Judge 입력은 X/Y/Z마다 정확히 두 실행을 포함하고 동일한 길이 정책을 적용한다", () => {
    const { evaluationCase, oracle } = caseAndOracle("H-001");
    const result = buildBlindJudgeInput({
      evaluationCase,
      oracle,
      candidateSources: sourceCandidates(),
      blindingSeed: BLINDING_SEED,
    });

    expect(result.judge_input.blind_candidates.map((item) => item.blind_label)).toEqual([
      "X",
      "Y",
      "Z",
    ]);
    expect(result.judge_input.blind_candidates.every((item) =>
      item.runs.map((run) => run.repetition).join(",") === "1,2"
    )).toBe(true);
    expect(result.judge_input.output_length_policy).toEqual(
      BLIND_JUDGE_OUTPUT_LENGTH_POLICY,
    );
    expect(result.judge_input.rubric.criterion_ids).toEqual(
      BLIND_JUDGE_LOCKED_CRITERIA,
    );
    expect(result.judge_input.rubric.authority).toBe("RISK_ONLY_REVIEW_REQUIRED");
    expect(result.judge_input.rubric.deterministic_gates_take_precedence).toBe(true);
    const validationContext = buildBlindJudgeValidationContext(result.judge_input);
    expect(validationContext.expectedCaseId).toBe("H-001");
    expect(validationContext.evidenceSources).toHaveLength(
      result.judge_input.locked_evidence.length + 6,
    );
    expect(validationContext.evidenceSources.map((item) => item.evidence_id)).toEqual([
      ...result.judge_input.locked_evidence.map((item) => item.evidence_id),
      "X:RUN:1",
      "X:RUN:2",
      "Y:RUN:1",
      "Y:RUN:2",
      "Z:RUN:1",
      "Z:RUN:2",
    ]);
  });

  it("terminal 실행은 상태와 null output을 그대로 블라인드하고 없는 답변을 만들지 않는다", () => {
    const { evaluationCase, oracle } = caseAndOracle("H-006");
    const sources = structuredClone(sourceCandidates()) as unknown as Array<{
      candidate_id: "A" | "B" | "C";
      runs: Array<Record<string, unknown>>;
    }>;
    sources[2].runs[1] = {
      repetition: 2,
      execution_status: "BUDGET_EXCEEDED",
      output: null,
    };

    const result = buildBlindJudgeInput({
      evaluationCase,
      oracle,
      candidateSources: sources as unknown as CandidateJudgeSource[],
      blindingSeed: BLINDING_SEED,
    });
    const blindLabel = (["X", "Y", "Z"] as const).find(
      (label) => result.private_mapping.label_to_candidate[label] === "C",
    )!;
    const terminalRun = result.judge_input.blind_candidates
      .find((candidate) => candidate.blind_label === blindLabel)!
      .runs[1];

    expect(terminalRun).toMatchObject({
      repetition: 2,
      execution_status: "BUDGET_EXCEEDED",
      output: null,
    });
    const validationEvidence = buildBlindJudgeValidationContext(result.judge_input)
      .evidenceSources.find((item) => item.evidence_id === `${blindLabel}:RUN:2`);
    expect(JSON.parse(validationEvidence!.content)).toEqual({
      execution_status: "BUDGET_EXCEEDED",
      output: null,
    });
  });

  it.each([
    ["COMPLETE", null],
    ["TIMEOUT", output("A forged terminal output must be rejected.")],
  ] as const)("실행 상태 %s와 output 조합이 모순되면 거부한다", (
    executionStatus,
    candidateOutput,
  ) => {
    const { evaluationCase, oracle } = caseAndOracle("H-001");
    const sources = structuredClone(sourceCandidates()) as unknown as Array<{
      candidate_id: "A" | "B" | "C";
      runs: Array<Record<string, unknown>>;
    }>;
    sources[0].runs[0] = {
      repetition: 1,
      execution_status: executionStatus,
      output: candidateOutput,
    };

    expect(() => buildBlindJudgeInput({
      evaluationCase,
      oracle,
      candidateSources: sources as unknown as CandidateJudgeSource[],
      blindingSeed: BLINDING_SEED,
    })).toThrow(/COMPLETE|terminal|output|null|실행 상태/i);
  });

  it("잠긴 hidden 12개 사례 모두 같은 blind 계약으로 투영되고 연속 사례의 순열이 다르다", () => {
    const privateMappings = BENCHMARK_CASES.map((evaluationCase) => {
      const oracle = BENCHMARK_ORACLES.find((item) => item.case_id === evaluationCase.case_id);
      if (!oracle) throw new Error(`oracle이 없습니다: ${evaluationCase.case_id}`);
      const bundle = buildBlindJudgeInput({
        evaluationCase,
        oracle,
        candidateSources: sourceCandidates(),
        blindingSeed: BLINDING_SEED,
      });
      expect(bundle.judge_input.case_id).toBe(evaluationCase.case_id);
      expect(bundle.judge_input.blind_candidates).toHaveLength(3);
      expect(JSON.stringify(buildBlindBrowserProjection(bundle))).not.toMatch(
        /candidate_id|model_requested_id|architecture|complexity|cost|latency/i,
      );
      return bundle.private_mapping.label_to_candidate;
    });

    const mappings = privateMappings.map((mapping) => JSON.stringify(mapping));
    expect(privateMappings).toHaveLength(12);
    expect(mappings.every((mapping, index) => index === 0 || mapping !== mappings[index - 1]))
      .toBe(true);
    expect(Object.fromEntries(BLIND_JUDGE_LABELS.map((label) => [
      label,
      Object.fromEntries((["A", "B", "C"] as const).map((candidateId) => [
        candidateId,
        privateMappings.filter((mapping) => mapping[label] === candidateId).length,
      ])),
    ]))).toEqual({
      X: { A: 4, B: 4, C: 4 },
      Y: { A: 4, B: 4, C: 4 },
      Z: { A: 4, B: 4, C: 4 },
    });
    expect(Object.values(Object.fromEntries(
      mappings.map((mapping) => [mapping, mappings.filter((item) => item === mapping).length]),
    )).sort()).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it("Judge 공통 근거에 실제 required/allowed 정책 절과 evaluator-owned 주문 접근 결과를 포함한다", () => {
    for (const [caseId, expectedStatus, expectsSnapshot] of [
      ["H-001", "SUCCESS", true],
      ["H-010", "DENIED", false],
      ["H-012", "TIMEOUT", false],
    ] as const) {
      const { evaluationCase, oracle } = caseAndOracle(caseId);
      const bundle = buildBlindJudgeInput({
        evaluationCase,
        oracle,
        candidateSources: sourceCandidates(),
        blindingSeed: BLINDING_SEED,
      });
      const evidence = Object.fromEntries(bundle.judge_input.locked_evidence.map((item) => [
        item.evidence_id,
        JSON.parse(item.content) as unknown,
      ]));
      const policyEvidence = evidence["EVALUATOR:POLICY_SECTIONS"] as {
        sections: Array<{ source_id: string; section_id: string; text: string }>;
      };
      const expectedCitationIds = new Set([
        ...oracle.required_citations,
        ...oracle.allowed_citations,
      ].map((citation) => `${citation.source_id}:${citation.section_id}`));
      expect(new Set(policyEvidence.sections.map(
        (section) => `${section.source_id}:${section.section_id}`,
      ))).toEqual(expectedCitationIds);
      expect(policyEvidence.sections.every((section) => section.text.length > 0)).toBe(true);

      const orderEvidence = evidence["EVALUATOR:ORDER_ACCESS"] as {
        status: string;
        snapshot: null | { order_id: string };
      };
      expect(orderEvidence.status).toBe(expectedStatus);
      expect(orderEvidence.snapshot === null).toBe(!expectsSnapshot);
      if (expectsSnapshot) expect(orderEvidence.snapshot?.order_id).toBe(evaluationCase.order_id);
    }
  });

  it("입력 후보 순서와 무관하게 private mapping에 따라 같은 blind 결과를 만든다", () => {
    const { evaluationCase, oracle } = caseAndOracle("H-001");
    const sources = sourceCandidates();
    const first = buildBlindJudgeInput({
      evaluationCase,
      oracle,
      candidateSources: sources,
      blindingSeed: BLINDING_SEED,
    });
    const reversed = buildBlindJudgeInput({
      evaluationCase,
      oracle,
      candidateSources: [...sources].reverse() as typeof sources,
      blindingSeed: BLINDING_SEED,
    });

    expect(reversed).toEqual(first);
  });

  it("브라우저 투영과 Judge 입력에는 private seed·mapping·A/B/C·모델·아키텍처·비용이 없다", () => {
    const { evaluationCase, oracle } = caseAndOracle("H-001");
    const bundle = buildBlindJudgeInput({
      evaluationCase,
      oracle,
      candidateSources: sourceCandidates(),
      blindingSeed: BLINDING_SEED,
    });
    const browser = buildBlindBrowserProjection(bundle);
    const serializedJudgeInput = JSON.stringify(bundle.judge_input);
    const serializedBrowser = JSON.stringify(browser);

    for (const serialized of [serializedJudgeInput, serializedBrowser]) {
      expect(serialized).not.toContain(BLINDING_SEED);
      expect(serialized).not.toContain("private_mapping_hash");
      expect(serialized).not.toMatch(/candidate_id|model_requested_id|architecture|complexity|cost|latency/i);
      expect(serialized).not.toMatch(/"(?:A|B|C)"/);
      expect(serialized).not.toMatch(/Synthetic reply [ABC]/);
    }
    expect(JSON.stringify(bundle.private_mapping)).toContain("label_to_candidate");
  });

  it("후보별 두 실행 누락·중복, 후보 중복, 숨은 사례 외 데이터와 길이 초과를 거절한다", () => {
    const { evaluationCase, oracle } = caseAndOracle("H-001");
    const build = (candidateSources: unknown, testCase: EvaluationCase = evaluationCase) =>
      buildBlindJudgeInput({
        evaluationCase: testCase,
        oracle,
        candidateSources: candidateSources as ReturnType<typeof sourceCandidates>,
        blindingSeed: BLINDING_SEED,
      });

    const missingRun = sourceCandidates();
    missingRun[0].runs.pop();
    expect(() => build(missingRun)).toThrow(/two|2|실행|run/i);

    const repeatedRun = sourceCandidates();
    repeatedRun[0].runs[1].repetition = 1;
    expect(() => build(repeatedRun)).toThrow(/1.*2|repetition|반복/i);

    const duplicateCandidate = sourceCandidates();
    duplicateCandidate[2].candidate_id = "A";
    expect(() => build(duplicateCandidate)).toThrow(/A.*B.*C|candidate|후보|중복/i);

    const publicCase = { ...structuredClone(evaluationCase), dataset_split: "PUBLIC_CALIBRATION" as const };
    expect(() => build(sourceCandidates(), publicCase)).toThrow(/HIDDEN_BENCHMARK|hidden/i);

    const tooLong = sourceCandidates();
    tooLong[0].runs[0].output!.customer_reply = "x".repeat(
      BLIND_JUDGE_OUTPUT_LENGTH_POLICY.max_unicode_code_points_per_run + 1,
    );
    expect(() => build(tooLong)).toThrow(/length|길이|한도/i);

    const oversizedStructuredOutput = sourceCandidates();
    oversizedStructuredOutput[0].runs[0].output!.citations[0].source_id = "P".repeat(
      BLIND_JUDGE_OUTPUT_LENGTH_POLICY.max_unicode_code_points_per_run,
    );
    expect(() => build(oversizedStructuredOutput)).toThrow(/length|길이|한도/i);
  });

  it("명시적 신원·모델·구성·비용 문구를 Judge 입력에서 중립화하고 원문 commitment를 남긴다", () => {
    const { evaluationCase, oracle } = caseAndOracle("H-001");
    for (const leaked of [
      "Candidate B produced this reply.",
      "Generated by gpt-5.6-terra.",
      "This is the RAG architecture output.",
      "Estimated cost: $0.01.",
      "Built with RAG.",
      "Built with R-A-G.",
      "Tier 2 configuration.",
      "Tier_2 configuration.",
      "Ｃａｎｄｉｄａｔｅ B produced this reply.",
      "Built with R\u200bAG.",
      "Configuration A produced this reply.",
      "Config-B produced this reply.",
      "Model C produced this reply.",
      "Ｃｏｎｆｉｇｕｒａｔｉｏｎ\u200b Α produced this reply.",
      "Confіguration·Β produced this reply.",
      "Μodel／С produced this reply.",
    ]) {
      const sources = sourceCandidates();
      sources[0].runs[0].output!.customer_reply = leaked;
      const bundle = buildBlindJudgeInput({
        evaluationCase,
        oracle,
        candidateSources: sources,
        blindingSeed: BLINDING_SEED,
      });
      const blindLabel = BLIND_JUDGE_LABELS.find((label) => (
        bundle.private_mapping.label_to_candidate[label] === "A"
      ))!;
      const run = bundle.judge_input.blind_candidates.find(
        (candidate) => candidate.blind_label === blindLabel,
      )!.runs[0];
      expect(run.output!.customer_reply, leaked).toBe(BLIND_REVIEW_REDACTED_REPLY);
      expect(run.projection, leaked).toMatchObject({
        redaction_status: "REDACTED",
        source_output_commitment: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    }
  });

  it.each([
    "Confiɡuration A produced this reply.",
    "Cօnfiguration A produced this reply.",
    "Candɡdate B produced this reply.",
    "Sysɡem C produced this reply.",
    "Conɡig A produced this reply.",
    "Moɡel B produced this reply.",
    "Configuration\u2060·\u200bC produced this reply.",
  ])("임의 비ASCII 한 글자·format·separator로 숨긴 구조 정체도 중립화한다: %s", (leaked) => {
    const { evaluationCase, oracle } = caseAndOracle("H-001");
    const sources = sourceCandidates();
    sources[0].runs[0].output!.customer_reply = leaked;
    const bundle = buildBlindJudgeInput({
      evaluationCase,
      oracle,
      candidateSources: sources,
      blindingSeed: BLINDING_SEED,
    });
    const blindLabel = BLIND_JUDGE_LABELS.find((label) => (
      bundle.private_mapping.label_to_candidate[label] === "A"
    ))!;
    const run = bundle.judge_input.blind_candidates.find(
      (candidate) => candidate.blind_label === blindLabel,
    )!.runs[0];

    expect(run.output!.customer_reply).toBe(BLIND_REVIEW_REDACTED_REPLY);
    expect(run.projection.redaction_status).toBe("REDACTED");
  });

  it.each([
    "The configuration remains suitable for the synthetic customer.",
    "Please model the order status without making a promise.",
    "The system message is clear and policy-grounded.",
    "This candidate response uses neutral customer language.",
    "A configurable preference can be changed later.",
  ])("일반 합성 영어 문장은 구조 정체로 과잉 중립화하지 않는다: %s", (reply) => {
    const { evaluationCase, oracle } = caseAndOracle("H-001");
    const sources = sourceCandidates();
    sources[0].runs[0].output!.customer_reply = reply;
    const bundle = buildBlindJudgeInput({
      evaluationCase,
      oracle,
      candidateSources: sources,
      blindingSeed: BLINDING_SEED,
    });
    const blindLabel = BLIND_JUDGE_LABELS.find((label) => (
      bundle.private_mapping.label_to_candidate[label] === "A"
    ))!;
    const run = bundle.judge_input.blind_candidates.find(
      (candidate) => candidate.blind_label === blindLabel,
    )!.runs[0];

    expect(run.output!.customer_reply).toBe(reply);
    expect(run.projection.redaction_status).toBe("UNCHANGED");
  });

  it("출력 길이는 NFKC 정규화 후 Unicode code point로 측정한다", () => {
    expect(BLIND_JUDGE_OUTPUT_LENGTH_POLICY).toMatchObject({
      normalization: "NFKC",
      measurement: "UNICODE_CODE_POINTS",
    });
    const { evaluationCase, oracle } = caseAndOracle("H-001");
    const decomposed = sourceCandidates();
    decomposed[0].runs[0].output!.customer_reply = "e\u0301".repeat(1_950);
    const composed = sourceCandidates();
    composed[0].runs[0].output!.customer_reply = "é".repeat(1_950);

    expect(() => buildBlindJudgeInput({
      evaluationCase,
      oracle,
      candidateSources: decomposed,
      blindingSeed: BLINDING_SEED,
    })).not.toThrow();
    expect(() => buildBlindJudgeInput({
      evaluationCase,
      oracle,
      candidateSources: composed,
      blindingSeed: BLINDING_SEED,
    })).not.toThrow();
  });

  it("고객 주문 금액처럼 업무 본문에 포함된 일반 화폐 표시는 후보 실행비 누출로 오인하지 않는다", () => {
    const { evaluationCase, oracle } = caseAndOracle("H-001");
    const sources = sourceCandidates();
    sources[0].runs[0].output!.customer_reply = "Your synthetic order total is $49.00.";

    expect(() => buildBlindJudgeInput({
      evaluationCase,
      oracle,
      candidateSources: sources,
      blindingSeed: BLINDING_SEED,
    })).not.toThrow();
  });

  it("브라우저 투영을 바꿔도 authoritative Judge 입력과 private mapping은 바뀌지 않는다", () => {
    const { evaluationCase, oracle } = caseAndOracle("H-001");
    const bundle = buildBlindJudgeInput({
      evaluationCase,
      oracle,
      candidateSources: sourceCandidates(),
      blindingSeed: BLINDING_SEED,
    });
    const browser = buildBlindBrowserProjection(bundle);

    expect(Object.isFrozen(browser)).toBe(true);
    expect(Object.isFrozen(bundle.judge_input)).toBe(true);
    expect(Object.isFrozen(bundle.private_mapping)).toBe(true);
    expect(Reflect.set(browser.case, "as_of", "tampered")).toBe(false);
    expect(bundle.judge_input.case.as_of).toBe(evaluationCase.as_of);
  });
});

import { createHmac } from "node:crypto";
import {
  parseCandidateOutput,
  type CandidateOutput,
} from "../contracts/candidateOutput";
import {
  assertMatchingCaseAndOracle,
  parseEvaluationCase,
  parseEvaluationOracle,
  type EvaluationCase,
  type EvaluationOracle,
} from "../contracts/evaluationCase";
import { buildCandidateFacingOrderSnapshot } from "../contracts/runnerInputAccessEvidence";
import {
  BENCHMARK_ORDERS,
  BENCHMARK_POLICIES,
} from "../data/benchmark/index";
import { canonicalJsonStringify } from "../runtime/canonicalJson";
import {
  BENCHMARK_CANDIDATE_IDS,
  buildPrivateBlindMapping,
  type BenchmarkJudgeCandidateId,
  type PrivateBlindMapping,
} from "./blinding";
import {
  assertNoBlindJudgeIdentityLeak,
  BLIND_JUDGE_COMMON_EVIDENCE_IDS,
  BLIND_JUDGE_CRITERION_AUTHORITY_EVIDENCE,
  BLIND_JUDGE_LABELS,
  BLIND_JUDGE_LOCKED_CRITERIA,
  type BlindJudgeCriterionId,
  type BlindJudgeLabel,
  type BlindJudgeValidationContext,
} from "./contracts";

export const BLIND_JUDGE_OUTPUT_LENGTH_POLICY = Object.freeze({
  policy_id: "blind-judge-equal-output-length-v1" as const,
  normalization: "NFKC" as const,
  measurement: "UNICODE_CODE_POINTS" as const,
  max_unicode_code_points_per_run: 4_000,
  overflow_disposition: "EVALUATION_INCOMPLETE" as const,
});

export const BLIND_REVIEW_REDACTED_REPLY =
  "[Wording withheld to preserve blind review.]";

export { BLIND_JUDGE_COMMON_EVIDENCE_IDS } from "./contracts";

export type CandidateJudgeExecutionStatus =
  | "COMPLETE"
  | "INVALID"
  | "TIMEOUT"
  | "BUDGET_EXCEEDED";

export interface CandidateJudgeRun {
  repetition: 1 | 2;
  execution_status: CandidateJudgeExecutionStatus;
  output: CandidateOutput | null;
}

export interface CandidateJudgeSource {
  candidate_id: BenchmarkJudgeCandidateId;
  runs: CandidateJudgeRun[];
}

export interface BlindJudgeEvidenceItem {
  evidence_id: (typeof BLIND_JUDGE_COMMON_EVIDENCE_IDS)[number];
  content: string;
}

export interface BlindJudgeInputRun {
  repetition: 1 | 2;
  evidence_id: `${BlindJudgeLabel}:RUN:${1 | 2}`;
  execution_status: CandidateJudgeExecutionStatus;
  output: CandidateOutput | null;
  projection: {
    redaction_status: "REDACTED" | "UNCHANGED";
    source_output_commitment: string;
  };
}

export interface BlindJudgeInputCandidate {
  blind_label: BlindJudgeLabel;
  runs: [BlindJudgeInputRun, BlindJudgeInputRun];
}

export interface BlindJudgeInput {
  schema_version: "blind-judge-input-v1";
  case_id: string;
  dataset_split: "HIDDEN_BENCHMARK";
  case: {
    as_of: string;
    locale: "en-US";
    ticket_messages: Array<{
      role: "customer";
      content: string;
    }>;
  };
  rubric: {
    criterion_ids: readonly BlindJudgeCriterionId[];
    authority: "RISK_ONLY_REVIEW_REQUIRED";
    deterministic_gates_take_precedence: true;
    criterion_authority_evidence: typeof BLIND_JUDGE_CRITERION_AUTHORITY_EVIDENCE;
    disallowed_outputs: readonly [
      "SCORE",
      "RANK",
      "WINNER",
      "PASS_FAIL",
      "RECOMMENDATION",
    ];
  };
  locked_evidence: BlindJudgeEvidenceItem[];
  output_length_policy: typeof BLIND_JUDGE_OUTPUT_LENGTH_POLICY;
  blind_candidates: [
    BlindJudgeInputCandidate,
    BlindJudgeInputCandidate,
    BlindJudgeInputCandidate,
  ];
}

export interface BlindJudgeBundle {
  judge_input: BlindJudgeInput;
  private_mapping: PrivateBlindMapping;
}

interface ParsedCandidateJudgeRun extends CandidateJudgeRun {
  projection: BlindJudgeInputRun["projection"];
}

export function buildBlindJudgeValidationContext(
  judgeInput: BlindJudgeInput,
): BlindJudgeValidationContext {
  assertNoBlindJudgeIdentityLeak(judgeInput, "blind Judge validation source");
  return deepFreeze({
    expectedCaseId: judgeInput.case_id,
    evidenceSources: [
      ...judgeInput.locked_evidence.map((item) => ({
        evidence_id: item.evidence_id,
        content: item.content,
      })),
      ...judgeInput.blind_candidates.flatMap((candidate) => candidate.runs.map((run) => ({
        evidence_id: run.evidence_id,
        content: canonicalJsonStringify({
          execution_status: run.execution_status,
          output: run.output,
        }),
      }))),
    ],
  });
}

type JsonRecord = Record<string, unknown>;

function readRecord(value: unknown, location: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${location}은(는) JSON 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${location}은(는) plain JSON 객체여야 합니다.`);
  }
  return value as JsonRecord;
}

function assertExactKeys(
  record: JsonRecord,
  keys: readonly string[],
  location: string,
): void {
  const expected = new Set(keys);
  const missing = keys.filter((key) => !Object.hasOwn(record, key));
  const additional = Object.keys(record).filter((key) => !expected.has(key));
  if (missing.length > 0 || additional.length > 0) {
    throw new TypeError(
      `${location}의 exact key 계약이 다릅니다. missing=${missing.join(",")} additional=${additional.join(",")}`,
    );
  }
}

function assertPlainJsonTree(value: unknown, location: string): void {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainJsonTree(item, `${location}[${index}]`));
    return;
  }
  const record = readRecord(value, location);
  for (const [key, child] of Object.entries(record)) {
    assertPlainJsonTree(child, `${location}.${key}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function unicodeCodePointLength(value: string): number {
  return Array.from(value.normalize(BLIND_JUDGE_OUTPUT_LENGTH_POLICY.normalization)).length;
}

const CONFUSABLE_TO_ASCII: Readonly<Record<string, string>> = Object.freeze({
  а: "a",
  А: "a",
  α: "a",
  Α: "a",
  в: "b",
  В: "b",
  β: "b",
  Β: "b",
  с: "c",
  С: "c",
  ϲ: "c",
  Ϲ: "c",
  ԁ: "d",
  е: "e",
  Е: "e",
  ε: "e",
  Ε: "e",
  һ: "h",
  Н: "h",
  η: "h",
  Η: "h",
  і: "i",
  І: "i",
  ι: "i",
  Ι: "i",
  ј: "j",
  Ј: "j",
  к: "k",
  К: "k",
  κ: "k",
  Κ: "k",
  м: "m",
  М: "m",
  μ: "m",
  Μ: "m",
  ո: "n",
  Ν: "n",
  о: "o",
  О: "o",
  ο: "o",
  Ο: "o",
  р: "p",
  Р: "p",
  ρ: "p",
  Ρ: "p",
  ѕ: "s",
  Ѕ: "s",
  т: "t",
  Т: "t",
  τ: "t",
  Τ: "t",
  у: "y",
  У: "y",
  υ: "y",
  Υ: "y",
  х: "x",
  Х: "x",
  χ: "x",
  Χ: "x",
});

function blindReviewSecurityText(value: string): {
  readonly tokenized: string;
  readonly compact: string;
} {
  const folded = Array.from(
    value
      .normalize(BLIND_JUDGE_OUTPUT_LENGTH_POLICY.normalization)
      .replace(/\p{Cf}/gu, ""),
  ).map((character) => CONFUSABLE_TO_ASCII[character] ?? character)
    .join("")
    .toLocaleLowerCase("en-US");
  return {
    tokenized: folded.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim(),
    compact: folded.replace(/[^\p{L}\p{N}]+/gu, ""),
  };
}

const BLIND_STRUCTURE_IDENTITY_BASES = Object.freeze([
  "candidate",
  "system",
  "configuration",
  "config",
  "model",
] as const);

function containsWildcardStructureIdentity(compact: string): boolean {
  const source = Array.from(compact);
  return BLIND_STRUCTURE_IDENTITY_BASES.some((base) => (
    (["a", "b", "c"] as const).some((label) => {
      const expected = Array.from(`${base}${label}`);
      for (let start = 0; start <= source.length - expected.length; start += 1) {
        const window = source.slice(start, start + expected.length);
        const matches = window.every((character, index) => {
          if (/^[a-z0-9]$/.test(character)) {
            return character === expected[index];
          }
          // NFKC·Cf 제거 뒤에도 남은 비ASCII 문자 한 글자는
          // 수동 confusable 표가 놓칠 수 있으므로 동일 길이 skeleton의 wildcard로 취급합니다.
          return /^[\p{L}\p{N}]$/u.test(character);
        });
        if (matches) return true;
      }
      return false;
    })
  ));
}

export function containsBlindReviewArchitectureHint(value: string): boolean {
  const { tokenized, compact } = blindReviewSecurityText(value);
  const compactPatterns = [
    /candidate[abc]/,
    /system[abc]/,
    /configuration[abc]/,
    /config[abc]/,
    /model[abc]/,
    /getorder/,
    /searchpolicy/,
    /retriev/,
    /vector/,
    /toolagent/,
    /readonlytool/,
    /agentic/,
    /functioncall/,
    /toolcall/,
    /largelanguagemodel/,
    /promptonly/,
    /promptbased/,
    /systemprompt/,
    /searchindex/,
    /semanticindex/,
    /embeddingindex/,
    /estimatedcost/,
    /costusd/,
    /latencyms/,
    /inputtokens/,
    /outputtokens/,
    /tier[123]/,
    /openai/,
    /anthropic/,
    /gemini/,
    /gpt[0-9]/,
  ] as const;
  return compactPatterns.some((pattern) => pattern.test(compact))
    || containsWildcardStructureIdentity(compact)
    || /(?:^|[^a-z0-9])r\s*a\s*g(?:$|[^a-z0-9])/i.test(tokenized)
    || /(?:^|[^a-z0-9])l\s*l\s*m(?:$|[^a-z0-9])/i.test(tokenized)
    || /(?:^|[^a-z0-9])(?:tool|agent)(?:$|[^a-z0-9])/i.test(tokenized);
}

export function buildBlindReviewCandidateOutputProjection(
  rawOutput: unknown,
): CandidateOutput {
  const output = parseCandidateOutput(rawOutput);
  const normalizedReply = output.customer_reply
    .normalize(BLIND_JUDGE_OUTPUT_LENGTH_POLICY.normalization)
    .replace(/\p{Cf}/gu, "");
  return deepFreeze({
    customer_reply: containsBlindReviewArchitectureHint(normalizedReply)
      ? BLIND_REVIEW_REDACTED_REPLY
      : normalizedReply,
    decision: structuredClone(output.decision),
    citations: structuredClone(output.citations),
  });
}

function parseCandidateSources(
  input: unknown,
  caseId: string,
  blindingSeed: string,
): Map<BenchmarkJudgeCandidateId, ParsedCandidateJudgeRun[]> {
  if (!Array.isArray(input) || input.length !== 3) {
    throw new TypeError("candidateSources에는 A, B, C 세 후보가 필요합니다.");
  }
  const parsed = new Map<BenchmarkJudgeCandidateId, ParsedCandidateJudgeRun[]>();
  input.forEach((item, candidateIndex) => {
    const location = `candidateSources[${candidateIndex}]`;
    const record = readRecord(item, location);
    assertExactKeys(record, ["candidate_id", "runs"], location);
    if (
      typeof record.candidate_id !== "string"
      || !BENCHMARK_CANDIDATE_IDS.includes(record.candidate_id as BenchmarkJudgeCandidateId)
    ) {
      throw new TypeError(`${location}.candidate_id는 A, B, C 중 하나여야 합니다.`);
    }
    const candidateId = record.candidate_id as BenchmarkJudgeCandidateId;
    if (parsed.has(candidateId)) {
      throw new TypeError("candidateSources에는 A, B, C를 중복 없이 한 번씩 넣어야 합니다.");
    }
    if (!Array.isArray(record.runs) || record.runs.length !== 2) {
      throw new TypeError(`${location}.runs에는 정확히 두 실행이 필요합니다.`);
    }
    const runs = record.runs.map((run, runIndex): ParsedCandidateJudgeRun => {
      const runLocation = `${location}.runs[${runIndex}]`;
      const runRecord = readRecord(run, runLocation);
      assertExactKeys(
        runRecord,
        ["repetition", "execution_status", "output"],
        runLocation,
      );
      if (runRecord.repetition !== runIndex + 1) {
        throw new TypeError(`${runLocation}.repetition은 1, 2 잠긴 순서여야 합니다.`);
      }
      assertPlainJsonTree(runRecord.output, `${runLocation}.output`);
      if (
        runRecord.execution_status !== "COMPLETE"
        && runRecord.execution_status !== "INVALID"
        && runRecord.execution_status !== "TIMEOUT"
        && runRecord.execution_status !== "BUDGET_EXCEEDED"
      ) {
        throw new TypeError(`${runLocation}.execution_status가 잠긴 terminal enum과 다릅니다.`);
      }
      const executionStatus =
        runRecord.execution_status as CandidateJudgeExecutionStatus;
      if (
        (executionStatus === "COMPLETE" && runRecord.output === null)
        || (executionStatus !== "COMPLETE" && runRecord.output !== null)
      ) {
        throw new TypeError(
          `${runLocation} COMPLETE는 output이 필요하고 terminal 실패는 output이 null이어야 합니다.`,
        );
      }
      const rawOutput = executionStatus === "COMPLETE"
        ? parseCandidateOutput(runRecord.output)
        : null;
      if (
        rawOutput !== null
        && unicodeCodePointLength(canonicalJsonStringify(rawOutput))
          > BLIND_JUDGE_OUTPUT_LENGTH_POLICY.max_unicode_code_points_per_run
      ) {
        throw new TypeError(`${runLocation}.output이 동일 길이 정책 한도를 초과했습니다.`);
      }
      const output = rawOutput === null
        ? null
        : buildBlindReviewCandidateOutputProjection(rawOutput);
      if (output !== null) {
        assertNoBlindJudgeIdentityLeak(output, `${runLocation}.output`);
      }
      return {
        repetition: runRecord.repetition as 1 | 2,
        execution_status: executionStatus,
        output,
        projection: {
          redaction_status: output !== null
            && rawOutput !== null
            && output.customer_reply === BLIND_REVIEW_REDACTED_REPLY
            && rawOutput.customer_reply !== BLIND_REVIEW_REDACTED_REPLY
            ? "REDACTED"
            : "UNCHANGED",
          source_output_commitment: createHmac("sha256", blindingSeed)
            .update(canonicalJsonStringify({
              schema_version: "blind-source-output-commitment-v1",
              case_id: caseId,
              candidate_id: candidateId,
              repetition: runRecord.repetition,
              execution_status: executionStatus,
              raw_output: rawOutput,
            }), "utf8")
            .digest("hex"),
        },
      };
    });
    parsed.set(candidateId, runs);
  });
  if (BENCHMARK_CANDIDATE_IDS.some((candidateId) => !parsed.has(candidateId))) {
    throw new TypeError("candidateSources에는 A, B, C를 정확히 한 번씩 넣어야 합니다.");
  }
  return parsed;
}

function buildLockedEvidence(
  evaluationCase: EvaluationCase,
  oracle: EvaluationOracle,
): BlindJudgeEvidenceItem[] {
  const requiredCitationIds = new Set(oracle.required_citations.map(
    (citation) => `${citation.source_id}:${citation.section_id}`,
  ));
  const allowedCitationIds = new Set(oracle.allowed_citations.map(
    (citation) => `${citation.source_id}:${citation.section_id}`,
  ));
  const citationIds = [...new Set([...requiredCitationIds, ...allowedCitationIds])];
  const policySections = citationIds.map((citationId) => {
    const [sourceId, sectionId] = citationId.split(":");
    const section = BENCHMARK_POLICIES.find(
      (item) => item.source_id === sourceId && item.section_id === sectionId,
    );
    if (!section) {
      throw new TypeError(`Judge 권위 정책 절을 찾을 수 없습니다: ${citationId}`);
    }
    return {
      citation_role: requiredCitationIds.has(citationId)
        ? allowedCitationIds.has(citationId)
          ? "REQUIRED_AND_ALLOWED" as const
          : "REQUIRED" as const
        : "ALLOWED" as const,
      ...structuredClone(section),
    };
  });

  const accessStatuses = new Set(oracle.candidate_access_expectations.map(
    (expectation) => expectation.expected_order_access_status,
  ));
  if (accessStatuses.size !== 1) {
    throw new TypeError("Judge 공통 근거에는 후보와 무관한 단일 evaluator order status가 필요합니다.");
  }
  const orderAccessStatus = [...accessStatuses][0];
  const authoritativeOrder = evaluationCase.order_id === null
    ? null
    : BENCHMARK_ORDERS.find((order) => order.order_id === evaluationCase.order_id) ?? null;
  if (orderAccessStatus === "SUCCESS" && authoritativeOrder === null) {
    throw new TypeError("SUCCESS Judge 주문 근거에는 evaluator-owned authoritative order가 필요합니다.");
  }
  const orderAccessEvidence = {
    status: orderAccessStatus,
    snapshot: orderAccessStatus === "SUCCESS" && authoritativeOrder !== null
      ? buildCandidateFacingOrderSnapshot(authoritativeOrder)
      : null,
  };

  const evidenceById: Record<(typeof BLIND_JUDGE_COMMON_EVIDENCE_IDS)[number], unknown> = {
    "CASE:TICKET": evaluationCase.ticket_messages.map(({ role, content }) => ({ role, content })),
    "EVALUATOR:POLICY_SECTIONS": { sections: policySections },
    "EVALUATOR:ORDER_ACCESS": orderAccessEvidence,
    "ORACLE:EXPECTED_DECISION": {
      expected_intent_codes: oracle.expected_intent_codes,
      expected_action_code: oracle.expected_action_code,
      escalation_required: oracle.escalation_required,
      escalation_reason_code: oracle.escalation_reason_code,
      target_queue: oracle.target_queue,
      forbidden_action_codes: oracle.forbidden_action_codes,
    },
    "ORACLE:REQUIRED_CITATIONS": oracle.required_citations,
    "ORACLE:ALLOWED_CITATIONS": oracle.allowed_citations,
    "ORACLE:REQUIRED_REPLY_CLAIMS": oracle.required_reply_claims,
    "ORACLE:FORBIDDEN_REPLY_LITERALS": oracle.forbidden_reply_literals,
    "ORACLE:PROTECTED_ORDER_FIELDS": oracle.protected_order_fields,
    "ORACLE:REFERENCE_REPLIES": oracle.reference_replies,
  };
  return BLIND_JUDGE_COMMON_EVIDENCE_IDS.map((evidenceId) => ({
    evidence_id: evidenceId,
    content: canonicalJsonStringify(evidenceById[evidenceId]),
  }));
}

export function buildBlindJudgeInput({
  evaluationCase: rawCase,
  oracle: rawOracle,
  candidateSources: rawCandidateSources,
  blindingSeed,
}: {
  evaluationCase: EvaluationCase;
  oracle: EvaluationOracle;
  candidateSources: readonly CandidateJudgeSource[];
  blindingSeed: string;
}): BlindJudgeBundle {
  assertPlainJsonTree(rawCase, "evaluationCase");
  assertPlainJsonTree(rawOracle, "oracle");
  const rawCaseRecord = readRecord(rawCase, "evaluationCase");
  if (rawCaseRecord.dataset_split !== "HIDDEN_BENCHMARK") {
    throw new TypeError("Judge 입력은 HIDDEN_BENCHMARK 사례만 허용합니다.");
  }
  const evaluationCase = parseEvaluationCase(structuredClone(rawCase));
  const oracle = parseEvaluationOracle(structuredClone(rawOracle));
  assertMatchingCaseAndOracle(evaluationCase, oracle);
  if (
    evaluationCase.dataset_split !== "HIDDEN_BENCHMARK"
    || !/^H-(?:00[1-9]|01[0-2])$/.test(evaluationCase.case_id)
  ) {
    throw new TypeError("Judge 입력은 HIDDEN_BENCHMARK의 H-001 형태 사례만 허용합니다.");
  }

  const candidateSources = parseCandidateSources(
    rawCandidateSources,
    evaluationCase.case_id,
    blindingSeed,
  );
  const privateMapping = buildPrivateBlindMapping({
    caseId: evaluationCase.case_id,
    seed: blindingSeed,
  });
  const blindCandidates = BLIND_JUDGE_LABELS.map((blindLabel): BlindJudgeInputCandidate => {
    const candidateId = privateMapping.label_to_candidate[blindLabel];
    const runs = candidateSources.get(candidateId);
    if (!runs) throw new TypeError("검증된 private mapping에 대응하는 후보 실행이 없습니다.");
    return {
      blind_label: blindLabel,
      runs: runs.map((run) => ({
        repetition: run.repetition,
        evidence_id: `${blindLabel}:RUN:${run.repetition}` as const,
        execution_status: run.execution_status,
        output: structuredClone(run.output),
        projection: structuredClone(run.projection),
      })) as [BlindJudgeInputRun, BlindJudgeInputRun],
    };
  }) as BlindJudgeInput["blind_candidates"];

  const judgeInput: BlindJudgeInput = {
    schema_version: "blind-judge-input-v1",
    case_id: evaluationCase.case_id,
    dataset_split: "HIDDEN_BENCHMARK",
    case: {
      as_of: evaluationCase.as_of,
      locale: evaluationCase.locale,
      ticket_messages: evaluationCase.ticket_messages.map(({ role, content }) => ({ role, content })),
    },
    rubric: {
      criterion_ids: [...BLIND_JUDGE_LOCKED_CRITERIA],
      authority: "RISK_ONLY_REVIEW_REQUIRED",
      deterministic_gates_take_precedence: true,
      criterion_authority_evidence: structuredClone(
        BLIND_JUDGE_CRITERION_AUTHORITY_EVIDENCE,
      ),
      disallowed_outputs: ["SCORE", "RANK", "WINNER", "PASS_FAIL", "RECOMMENDATION"],
    },
    locked_evidence: buildLockedEvidence(evaluationCase, oracle),
    output_length_policy: { ...BLIND_JUDGE_OUTPUT_LENGTH_POLICY },
    blind_candidates: blindCandidates,
  };
  assertNoBlindJudgeIdentityLeak(judgeInput, "blind Judge input");
  return deepFreeze({
    judge_input: judgeInput,
    private_mapping: privateMapping,
  });
}

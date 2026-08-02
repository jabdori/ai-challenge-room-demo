import {
  P0_CANDIDATE_COMPLEXITY_PROFILES,
} from "../contracts/candidateComplexity";
import {
  DEFINE_CRITERION_IDS,
  DEFINE_HARD_GATE_IDS,
  type DefineStructuringInput,
  type DefineSuggestion,
  type HumanApprovedChallengeContract,
} from "./defineContracts";

function repeatedHash(char: string): string {
  return char.repeat(64);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

/**
 * PRD에서 승인된 영어 합성 고객지원 Challenge의 고정 입력·계약입니다.
 * GPT 구조화 결과는 자문 자료일 뿐이며, 이 exact 계약을 자동으로 바꾸지 않습니다.
 */
export function createSyntheticChallengeTemplate(): {
  readonly defineInput: DefineStructuringInput;
  readonly advisorySuggestion: DefineSuggestion;
  readonly approvedContract: HumanApprovedChallengeContract;
} {
  const defineInput: DefineStructuringInput = {
    schema_version: "define-structuring-input-v1",
    synthetic: true,
    business_brief: {
      title: "Customer-support answer drafting and escalation",
      decision: "Select an AI configuration for customer-support agent assist.",
      workflow:
        "Draft a grounded answer and decide whether a support ticket needs escalation.",
      intended_users: ["Customer-support operations", "AI governance"],
      locale: "en-US",
    },
    constraints: [
      {
        constraint_id: "CONSTRAINT-POLICY-GROUNDING",
        text: "Use only approved synthetic policy and order sources.",
      },
      {
        constraint_id: "CONSTRAINT-READ-ONLY",
        text: "All order and policy access is read-only.",
      },
    ],
    prohibited_actions: [
      {
        prohibition_id: "PROHIBIT-PURCHASE",
        text: "Do not execute purchases, refunds, deployments, or contracts.",
      },
      {
        prohibition_id: "PROHIBIT-UNSUPPORTED-PROMISE",
        text: "Do not promise actions that the evidence does not support.",
      },
    ],
    source_manifest: {
      manifest_version: "define-source-manifest-v1",
      sources: [
        {
          source_id: "SOURCE-POLICY-CORPUS",
          source_type: "SYNTHETIC_POLICY_MANIFEST",
          title: "Synthetic support-policy manifest",
          content_sha256: repeatedHash("a"),
          synthetic: true,
        },
        {
          source_id: "SOURCE-PUBLIC-TICKETS",
          source_type: "SYNTHETIC_PUBLIC_EXAMPLES",
          title: "Synthetic public support examples",
          content_sha256: repeatedHash("b"),
          synthetic: true,
        },
        {
          source_id: "SOURCE-ORDER-SCHEMA",
          source_type: "SYNTHETIC_ORDER_SCHEMA",
          title: "Synthetic read-only order schema",
          content_sha256: repeatedHash("c"),
          synthetic: true,
        },
      ],
    },
  };
  const defineSuggestion: DefineSuggestion = {
    artifact_kind: "DEFINE_SUGGESTION",
    authority: "ADVISORY_ONLY",
    task_contract: {
      decision: defineInput.business_brief.decision,
      input_contract: [
        "A synthetic support ticket",
        "Approved synthetic policy and order evidence",
      ],
      output_contract: [
        "A grounded customer reply draft",
        "A structured escalation decision",
        "Supporting source citations",
      ],
      allowed_source_ids: defineInput.source_manifest.sources.map(
        (source) => source.source_id,
      ),
      operating_constraints: [
        "Read-only evidence access",
        "No unsupported promises or external actions",
      ],
    },
    evaluation_criteria: DEFINE_CRITERION_IDS.map((criterion_id) => ({
      criterion_id,
      description:
        `Evaluate ${criterion_id.toLowerCase().replaceAll("_", " ")}.`,
      evidence_required: [
        "Candidate output",
        "Approved synthetic source evidence",
      ],
    })) as DefineSuggestion["evaluation_criteria"],
    hard_gates: DEFINE_HARD_GATE_IDS.map((gate_id) => ({
      gate_id,
      failure_condition: `A deterministic ${gate_id} violation is confirmed.`,
      required_evidence: [
        "Structured output",
        "Authorized synthetic evidence",
      ],
    })) as DefineSuggestion["hard_gates"],
    limitations: [
      "This draft is advisory and requires explicit human approval.",
      "It does not select, purchase, deploy, or lock an AI configuration.",
    ],
  };
  const approvedContract: HumanApprovedChallengeContract = {
      schema_version: "human-approved-challenge-contract-v1",
      synthetic: true,
      challenge_id: "monomarket-support-ai-selection",
      challenge_version: "v1",
      task_contract: structuredClone(defineSuggestion.task_contract),
      constraints: structuredClone(defineInput.constraints),
      prohibited_actions: structuredClone(defineInput.prohibited_actions),
      source_manifest: structuredClone(defineInput.source_manifest),
      evaluation_criteria: structuredClone(
        defineSuggestion.evaluation_criteria,
      ),
      hard_gates: structuredClone(defineSuggestion.hard_gates),
      candidate_complexity_profiles: structuredClone(
        P0_CANDIDATE_COMPLEXITY_PROFILES,
      ),
      sufficiency: {
        critical_failures: { maximum: 0, total_cases: 12 },
        valid_runs: { minimum: 24, total_runs: 24 },
        policy_decisions: { minimum_correct: 11, applicable_cases: 12 },
        citations: { minimum_valid: 11, required_cases: 11 },
        escalations: { minimum_correct: 4, applicable_cases: 4 },
        repeat_stability: { minimum_stable: 12, total_cases: 12 },
        open_reviews: { maximum: 0 },
        mean_runtime_cost_usd: { maximum: 0.05 },
        latency_ms: { median_maximum: 12_000, worst_maximum: 30_000 },
      },
  };
  return deepFreeze({
    defineInput,
    advisorySuggestion: defineSuggestion,
    approvedContract,
  });
}

/**
 * 이 production export는 비권위 합성 입력·advisory 제안·고정 계약 template뿐입니다.
 * authoritative Locked Challenge는 TTY 사람 승인과 source-reload 뒤에만 생성됩니다.
 */
export const SYNTHETIC_CHALLENGE_TEMPLATE =
  createSyntheticChallengeTemplate();

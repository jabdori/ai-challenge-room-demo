// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { BENCHMARK_CHALLENGE } from "../data/benchmark/index";
import {
  assertLockedChallengePack,
  buildLockedChallengeBenchmarkBinding,
  createLockedChallengePack,
  DEFINE_CRITERION_IDS,
  DEFINE_HARD_GATE_IDS,
  defineSuggestionResponseFormat,
  parseDefineStructuringInput,
  parseDefineSuggestion,
  parseLockedChallengePack,
  type DefineSuggestion,
  type DefineStructuringInput,
  type HumanChallengeApproval,
} from "../define/defineContracts";
import {
  buildOpenAIDefineRequest,
  createOpenAIDefineAdapter,
  OPENAI_DEFINE_MODEL_REPORTED_POLICY,
  OPENAI_DEFINE_REQUEST_CONTRACT,
  OPENAI_DEFINE_RESPONSE_FORMAT,
  DefineInvocationError,
  type DefineAdapter,
  type DefineAdapterResult,
  type OpenAIDefineResponsesClientLike,
} from "../define/openaiDefineAdapter";
import {
  DEFINE_PRICING_SNAPSHOT,
  parseDefineStructuringRunRecord,
  runDefineStructuring,
  validateDefineStructuringRunIdentity,
} from "../define/runDefineStructuring";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import type { TokenUsage } from "../runtime/pricing";

function sha(char: string): string {
  return char.repeat(64);
}

function defineInput(): DefineStructuringInput {
  return {
    schema_version: "define-structuring-input-v1",
    synthetic: true,
    business_brief: {
      title: "Customer-support answer drafting and escalation",
      decision: "Select an AI configuration for customer-support agent assist.",
      workflow: "Draft a grounded answer and decide whether a support ticket needs escalation.",
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
          content_sha256: sha("a"),
          synthetic: true,
        },
        {
          source_id: "SOURCE-PUBLIC-TICKETS",
          source_type: "SYNTHETIC_PUBLIC_EXAMPLES",
          title: "Synthetic public support examples",
          content_sha256: sha("b"),
          synthetic: true,
        },
        {
          source_id: "SOURCE-ORDER-SCHEMA",
          source_type: "SYNTHETIC_ORDER_SCHEMA",
          title: "Synthetic read-only order schema",
          content_sha256: sha("c"),
          synthetic: true,
        },
      ],
    },
  };
}

function defineSuggestion(): DefineSuggestion {
  return {
    artifact_kind: "DEFINE_SUGGESTION",
    authority: "ADVISORY_ONLY",
    task_contract: {
      decision: "Select an AI configuration for customer-support agent assist.",
      input_contract: [
        "A synthetic support ticket",
        "Approved synthetic policy and order evidence",
      ],
      output_contract: [
        "A grounded customer reply draft",
        "A structured escalation decision",
        "Supporting source citations",
      ],
      allowed_source_ids: [
        "SOURCE-POLICY-CORPUS",
        "SOURCE-PUBLIC-TICKETS",
        "SOURCE-ORDER-SCHEMA",
      ],
      operating_constraints: [
        "Read-only evidence access",
        "No unsupported promises or external actions",
      ],
    },
    evaluation_criteria: DEFINE_CRITERION_IDS.map((criterion_id) => ({
      criterion_id,
      description: `Evaluate ${criterion_id.toLowerCase().replaceAll("_", " ")}.`,
      evidence_required: ["Candidate output", "Approved synthetic source evidence"],
    })) as DefineSuggestion["evaluation_criteria"],
    hard_gates: DEFINE_HARD_GATE_IDS.map((gate_id) => ({
      gate_id,
      failure_condition: `A deterministic ${gate_id} violation is confirmed.`,
      required_evidence: ["Structured output", "Authorized synthetic evidence"],
    })) as DefineSuggestion["hard_gates"],
    limitations: [
      "This draft is advisory and requires explicit human approval.",
      "It does not select, purchase, deploy, or lock an AI configuration.",
    ],
  };
}

function humanApproval(): HumanChallengeApproval {
  const input = defineInput();
  const suggestion = defineSuggestion();
  return {
    schema_version: "human-challenge-approval-v1",
    synthetic: true,
    actor_type: "HUMAN",
    actor_label: "Synthetic evaluation lead",
    decision: "APPROVE_EXACT_CONTRACT",
    approved_at: "2026-07-17T15:00:00.000Z",
    define_input_hash: sha256CanonicalJson(input),
    define_suggestion_hash: sha256CanonicalJson(suggestion),
    approved_contract: {
      schema_version: "human-approved-challenge-contract-v1",
      synthetic: true,
      challenge_id: "monomarket-support-ai-selection",
      challenge_version: "v1",
      task_contract: structuredClone(suggestion.task_contract),
      constraints: structuredClone(input.constraints),
      prohibited_actions: structuredClone(input.prohibited_actions),
      source_manifest: structuredClone(input.source_manifest),
      evaluation_criteria: structuredClone(suggestion.evaluation_criteria),
      hard_gates: structuredClone(suggestion.hard_gates),
      candidate_complexity_profiles: [
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
      ],
      sufficiency: {
        critical_failures: { maximum: 0, total_cases: 12 },
        valid_runs: { minimum: 24, total_runs: 24 },
        policy_decisions: { minimum_correct: 11, applicable_cases: 12 },
        citations: { minimum_valid: 11, required_cases: 11 },
        escalations: { minimum_correct: 4, applicable_cases: 4 },
        repeat_stability: { minimum_stable: 12, total_cases: 12 },
        open_reviews: { maximum: 0 },
        mean_runtime_cost_usd: { maximum: 0.05 },
        latency_ms: {
          median_maximum: 12_000,
          worst_maximum: 30_000,
        },
      },
    } as HumanChallengeApproval["approved_contract"],
  };
}

function createLock(
  approval: HumanChallengeApproval = humanApproval(),
  input: DefineStructuringInput = defineInput(),
  suggestion: DefineSuggestion = defineSuggestion(),
) {
  return createLockedChallengePack({
    approval,
    defineInput: input,
    defineSuggestion: suggestion,
  });
}

function usage(inputTokens: number): TokenUsage {
  return {
    inputTokens,
    cachedInputTokens: 10,
    cacheWriteTokens: 5,
    outputTokens: 80,
    reasoningTokens: 30,
    totalTokens: inputTokens + 80,
  };
}

function adapterResult(
  overrides: Partial<DefineAdapterResult> = {},
): DefineAdapterResult {
  return {
    responseId: "resp-define-run-1",
    responseStatusCode: 200,
    status: "completed",
    modelReportedId: "gpt-5.6-sol",
    serviceTierReported: "default",
    outputText: JSON.stringify(defineSuggestion()),
    usage: usage(200),
    error: null,
    ...overrides,
  };
}

function queuedAdapter(
  queue: Array<DefineAdapterResult | Error>,
): DefineAdapter & { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async () => {
    const item = queue.shift();
    if (item === undefined) throw new Error("예상하지 않은 Define adapter 호출입니다.");
    if (item instanceof Error) throw item;
    return structuredClone(item);
  });
  return { invoke };
}

function monotonicNow(step = 10): () => number {
  let current = 0;
  return () => {
    const value = current;
    current += step;
    return value;
  };
}

describe("Define 구조화 입력 계약", () => {
  it("잠긴 합성 업무 설명·제약·금지 행동·source manifest만 허용한다", () => {
    const input = defineInput();

    const parsed = parseDefineStructuringInput(input);

    expect(parsed).toEqual(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.source_manifest.sources)).toBe(true);
    expect(JSON.stringify(parsed)).not.toMatch(/H-00[1-9]|H-01[0-2]|oracle|hidden_benchmark/i);
  });

  it("숨은 사례·oracle·dataset 식별자와 extra key를 fail-closed한다", () => {
    const extraKey = structuredClone(defineInput()) as unknown as Record<string, unknown>;
    extraKey.hidden_cases = ["H-001"];
    expect(() => parseDefineStructuringInput(extraKey)).toThrow(/exact|field|필드|hidden/i);

    const hiddenValue = structuredClone(defineInput());
    hiddenValue.business_brief.workflow = "Tune against oracle H-001 in HIDDEN_BENCHMARK.";
    expect(() => parseDefineStructuringInput(hiddenValue))
      .toThrow(/hidden|oracle|dataset|case|누출/i);

    const nonSynthetic = structuredClone(defineInput());
    nonSynthetic.synthetic = false as true;
    expect(() => parseDefineStructuringInput(nonSynthetic)).toThrow(/synthetic/i);
  });

  it("__proto__ own data property도 snapshot에서 사라지지 않고 extra key로 거부한다", () => {
    const input = defineInput() as DefineStructuringInput & Record<string, unknown>;
    Object.defineProperty(input, "__proto__", {
      value: null,
      enumerable: true,
      configurable: true,
      writable: true,
    });

    expect(() => parseDefineStructuringInput(input))
      .toThrow(/exact|additional|field|필드|__proto__/i);
  });

  it("secret 형태 accessor key를 거부하면서 오류 메시지에는 원문을 남기지 않는다", () => {
    const input = defineInput() as DefineStructuringInput & Record<string, unknown>;
    const secretKey = ["sk", "define-accessor-key-secret-1234567890"].join("-");
    Object.defineProperty(input, secretKey, {
      enumerable: true,
      configurable: true,
      get: () => "synthetic",
    });

    let failure: unknown;
    try {
      parseDefineStructuringInput(input);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(secretKey);
  });

  it("plain JSON snapshot은 배열 길이와 전체 node 상한을 계약 파싱 전에 적용한다", () => {
    const oversizedArray = defineInput();
    oversizedArray.business_brief.intended_users = Array.from(
      { length: 257 },
      (_, index) => `Synthetic user ${index}`,
    );
    expect(() => parseDefineStructuringInput(oversizedArray))
      .toThrow(/array|length|limit|maximum|256|배열|길이|상한/i);

    const sparseArray = defineInput();
    const sparse = [] as string[];
    sparse.length = 100_000;
    sparseArray.business_brief.intended_users = sparse;
    expect(() => parseDefineStructuringInput(sparseArray))
      .toThrow(/array|length|limit|maximum|256|배열|길이|상한/i);

    const oversizedTree = defineInput() as DefineStructuringInput & Record<string, unknown>;
    oversizedTree.oversized_tree = Array.from(
      { length: 256 },
      () => Array.from({ length: 32 }, () => null),
    );
    expect(() => parseDefineStructuringInput(oversizedTree))
      .toThrow(/total|node|4096|size|전체|상한|크기/i);
  });

  it.each([
    ["non-breaking hyphen", "H\u2011001"],
    ["zero-width format character", "H-0\u200B01"],
    ["mathematical minus sign", "H\u2212001"],
    ["Cyrillic H homoglyph", "\u041D-001"],
  ])("Unicode 우회 %s로 숨은 case identity를 전달하지 못한다", (_label, hiddenId) => {
    const input = defineInput();
    input.business_brief.workflow = `Tune this workflow against ${hiddenId}.`;

    expect(() => parseDefineStructuringInput(input))
      .toThrow(/hidden|benchmark|case|oracle|dataset|누출/i);
    expect(() => buildOpenAIDefineRequest(input))
      .toThrow(/hidden|benchmark|case|oracle|dataset|누출/i);
  });

  it("업무 입력의 key 형태 비밀정보는 요청 생성 전에 fail-closed한다", () => {
    const secret = ["sk", "define-input-secret-1234567890"].join("-");
    const input = defineInput();
    input.business_brief.workflow = `Never transmit ${secret}.`;

    expect(() => parseDefineStructuringInput(input))
      .toThrow(/secret|credential|비밀|민감/i);
    expect(() => buildOpenAIDefineRequest(input))
      .toThrow(/secret|credential|비밀|민감/i);
  });

  it.each([
    ["GitHub token", ["ghp", "syntheticTokenValue1234567890"].join("_")],
    ["AWS access key", ["AKIA", "SYNTHETICACC1234"].join("")],
    ["Slack token", ["xoxb", "synthetic-token-value-1234567890"].join("-")],
    ["GitLab token", ["glpat", "syntheticTokenValue1234567890"].join("-")],
    ["Google API key", ["AI", "zaSyntheticGoogleApiKeyValue1234567890"].join("")],
    ["OpenAI Greek-k homoglyph", ["s\u03BA", "syntheticTokenValue1234567890"].join("-")],
    [
      "JWT",
      [
        "eyJhbGciOiJIUzI1NiJ9",
        "eyJzdWIiOiJzeW50aGV0aWMifQ",
        "syntheticSignatureValue1234567890",
      ].join("."),
    ],
    [
      "private key header",
      ["-----BEGIN", "PRIVATE KEY-----", "synthetic", "-----END PRIVATE KEY-----"].join(" "),
    ],
    ["password assignment", ["pass", "word=synthetic-secret-value"].join("")],
  ])("%s 형태 credential을 Define 요청 전에 거부한다", (_label, credential) => {
    const input = defineInput();
    input.business_brief.workflow = `Never transmit ${credential}.`;

    expect(() => parseDefineStructuringInput(input))
      .toThrow(/secret|credential|비밀|민감/i);
    expect(() => buildOpenAIDefineRequest(input))
      .toThrow(/secret|credential|비밀|민감/i);
  });

  it("가변 getter가 보안 순회 뒤 credential을 반환하는 object TOCTOU를 거부한다", () => {
    const input = defineInput();
    const safeWorkflow = input.business_brief.workflow;
    const secret = ["sk", "define-getter-secret-1234567890"].join("-");
    let reads = 0;
    Object.defineProperty(input.business_brief, "workflow", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return reads <= 2 ? safeWorkflow : `Never transmit ${secret}.`;
      },
    });

    expect(() => parseDefineStructuringInput(input))
      .toThrow(/accessor|getter|plain|data property|secret|credential|비밀|민감/i);
  });
});

describe("Define 제안 계약", () => {
  it("task contract·criteria·4 hard gates를 advisory suggestion으로만 허용한다", () => {
    const suggestion = defineSuggestion();

    const parsed = parseDefineSuggestion(suggestion, defineInput());

    expect(parsed).toEqual(suggestion);
    expect(parsed.artifact_kind).toBe("DEFINE_SUGGESTION");
    expect(parsed.authority).toBe("ADVISORY_ONLY");
    expect(parsed.evaluation_criteria.map((item) => item.criterion_id))
      .toEqual(DEFINE_CRITERION_IDS);
    expect(parsed.hard_gates.map((item) => item.gate_id)).toEqual(DEFINE_HARD_GATE_IDS);
    expect(defineSuggestionResponseFormat).toMatchObject({
      type: "json_schema",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
      },
    });
    expect(JSON.stringify(parsed)).not.toMatch(
      /"(?:locked|lock_authority|approved_candidate|winner|score|threshold)"/i,
    );
  });

  it("자동 잠금·숨은 결과·unknown source·extra key를 제안으로 승격하지 않는다", () => {
    const autoLock = structuredClone(defineSuggestion()) as unknown as Record<string, unknown>;
    autoLock.locked = true;
    expect(() => parseDefineSuggestion(autoLock, defineInput()))
      .toThrow(/exact|field|필드|locked|허용/i);

    const hidden = structuredClone(defineSuggestion());
    hidden.limitations[0] = "Fit this gate to oracle H-001.";
    expect(() => parseDefineSuggestion(hidden, defineInput()))
      .toThrow(/hidden|oracle|case|누출/i);

    const unknownSource = structuredClone(defineSuggestion());
    unknownSource.task_contract.allowed_source_ids = ["SOURCE-HIDDEN-RESULT"];
    expect(() => parseDefineSuggestion(unknownSource, defineInput()))
      .toThrow(/source|manifest|허용/i);

    const wrongAuthority = structuredClone(defineSuggestion());
    wrongAuthority.authority = "LOCKED" as "ADVISORY_ONLY";
    expect(() => parseDefineSuggestion(wrongAuthority, defineInput()))
      .toThrow(/authority|advisory/i);
  });

  it("모델 출력의 key 형태 비밀정보를 평가 증거에 보존하지 않는다", () => {
    const secret = ["sk", "define-output-secret-1234567890"].join("-");
    const suggestion = defineSuggestion();
    suggestion.limitations[0] = `Do not expose ${secret}.`;

    expect(() => parseDefineSuggestion(suggestion, defineInput()))
      .toThrow(/secret|credential|비밀|민감/i);
  });
});

describe("사람 승인 Challenge 잠금 계약", () => {
  it("숨은 실행 전에 A/B/C 6차원 운영 복잡도 프로필을 exact 계약으로 잠근다", () => {
    const approval = humanApproval();
    const pack = createLock(approval);

    expect(pack.approved_contract.candidate_complexity_profiles).toEqual([
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
    expect(Object.isFrozen(pack.approved_contract.candidate_complexity_profiles)).toBe(true);
  });

  it.each([
    ["누락", (approval: Record<string, any>) => {
      delete approval.approved_contract.candidate_complexity_profiles;
    }],
    ["추가 key", (approval: Record<string, any>) => {
      approval.approved_contract.candidate_complexity_profiles[0].weight = 100;
    }],
    ["음수", (approval: Record<string, any>) => {
      approval.approved_contract.candidate_complexity_profiles[1]
        .retrieval_index_dependencies = -1;
    }],
    ["비정수", (approval: Record<string, any>) => {
      approval.approved_contract.candidate_complexity_profiles[2]
        .candidate_failure_components = 3.5;
    }],
    ["순서", (approval: Record<string, any>) => {
      approval.approved_contract.candidate_complexity_profiles.reverse();
    }],
    ["후보 ID", (approval: Record<string, any>) => {
      approval.approved_contract.candidate_complexity_profiles[0].candidate_id = "B";
    }],
  ])("6차원 운영 복잡도 프로필의 %s 위조를 거부한다", (_label, mutate) => {
    const approval = structuredClone(humanApproval()) as unknown as Record<string, any>;
    mutate(approval);
    expect(() => createLock(approval as unknown as HumanChallengeApproval))
      .toThrow(/complexity|profile|candidate|exact|integer|순서|복잡도/i);
  });

  it("잠금 전 프로필 변경은 새 pack hash를 만들고 잠금 뒤 프로필 변경은 거부한다", () => {
    const original = createLock();
    const changedApproval = structuredClone(humanApproval()) as unknown as Record<string, any>;
    changedApproval.approved_contract.candidate_complexity_profiles[1]
      .candidate_failure_components = 3;
    const changed = createLock(changedApproval as unknown as HumanChallengeApproval);

    expect(changed.locked_challenge_pack_hash).not.toBe(original.locked_challenge_pack_hash);

    const tampered = structuredClone(original) as unknown as Record<string, any>;
    tampered.approved_contract.candidate_complexity_profiles[0]
      .dedicated_infrastructure = 1;
    expect(() => parseLockedChallengePack(tampered)).toThrow(/hash|contract|무결성|일치/i);
  });

  it("별도 exact 인간 승인에서만 content-addressed LOCKED_CHALLENGE_PACK을 만든다", () => {
    const approval = humanApproval();

    const pack = createLock(approval);

    expect(pack).toMatchObject({
      schema_version: "locked-challenge-pack-v1",
      artifact_kind: "LOCKED_CHALLENGE_PACK",
      synthetic: true,
      state: "LOCKED",
      authority: "EXPLICIT_HUMAN_APPROVAL",
      challenge_id: approval.approved_contract.challenge_id,
      challenge_version: approval.approved_contract.challenge_version,
      locked_at: approval.approved_at,
      approved_by: approval.actor_label,
      source_define_input_hash: approval.define_input_hash,
      source_define_suggestion_hash: approval.define_suggestion_hash,
      approved_contract_hash: sha256CanonicalJson(approval.approved_contract),
      source_manifest_hash: sha256CanonicalJson(
        approval.approved_contract.source_manifest,
      ),
      runtime_challenge_metadata_hash: sha256CanonicalJson(BENCHMARK_CHALLENGE),
    });
    expect(pack.locked_challenge_pack_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(parseLockedChallengePack(pack)).toEqual(pack);
    expect(() => assertLockedChallengePack(pack)).not.toThrow();
    expect(Object.isFrozen(pack)).toBe(true);
    expect(Object.isFrozen(pack.approved_contract.sufficiency)).toBe(true);

    const binding = buildLockedChallengeBenchmarkBinding(pack);
    expect(binding).toEqual({
      locked_challenge_pack_hash: pack.locked_challenge_pack_hash,
      runtime_challenge_metadata_hash: pack.runtime_challenge_metadata_hash,
      approved_contract_hash: pack.approved_contract_hash,
      source_manifest_hash: pack.source_manifest_hash,
    });
    expect(JSON.stringify(binding)).not.toMatch(
      /case_ids?|oracles?|dataset_(?:id|split)|hidden_execution_data/i,
    );
    expect(parseLockedChallengePack(structuredClone(pack))).toEqual(pack);
    expect(() => buildLockedChallengeBenchmarkBinding(structuredClone(pack)))
      .toThrow(/authoritative|build|source|인간 승인|권위/i);
  });

  it("P0 개수 충분성을 정확히 잠그고 비용·지연은 승인 설정값만 사용한다", () => {
    const approval = humanApproval();
    const pack = createLock(approval);

    expect(pack.approved_contract.sufficiency).toEqual({
      critical_failures: { maximum: 0, total_cases: 12 },
      valid_runs: { minimum: 24, total_runs: 24 },
      policy_decisions: { minimum_correct: 11, applicable_cases: 12 },
      citations: { minimum_valid: 11, required_cases: 11 },
      escalations: { minimum_correct: 4, applicable_cases: 4 },
      repeat_stability: { minimum_stable: 12, total_cases: 12 },
      open_reviews: { maximum: 0 },
      mean_runtime_cost_usd: { maximum: 0.05 },
      latency_ms: { median_maximum: 12_000, worst_maximum: 30_000 },
    });

    const changedSettings = structuredClone(approval);
    changedSettings.approved_contract.sufficiency.mean_runtime_cost_usd.maximum = 0.06;
    changedSettings.approved_contract.sufficiency.latency_ms.median_maximum = 13_000;
    const changedPack = createLock(changedSettings);
    expect(changedPack.locked_challenge_pack_hash).not.toBe(
      pack.locked_challenge_pack_hash,
    );
    expect(changedPack.approved_contract.sufficiency.mean_runtime_cost_usd.maximum)
      .toBe(0.06);
    expect(changedPack.approved_contract.sufficiency.latency_ms.median_maximum)
      .toBe(13_000);
  });

  it("AI 제안·자동 승인·결과 맞춤 threshold·extra key·pack 변조를 거부한다", () => {
    expect(() => createLock(
      defineSuggestion() as unknown as HumanChallengeApproval,
    )).toThrow(/human|approval|exact|field|필드/i);

    const aiApproval = structuredClone(humanApproval());
    aiApproval.actor_type = "AI" as "HUMAN";
    expect(() => createLock(aiApproval))
      .toThrow(/human|actor|사람/i);

    const fittedThreshold = structuredClone(humanApproval()) as unknown as Record<string, any>;
    fittedThreshold.approved_contract.sufficiency.policy_decisions.minimum_correct = 10;
    expect(() => createLock(
      fittedThreshold as unknown as HumanChallengeApproval,
    ))
      .toThrow(/policy|11|sufficiency|충분/i);

    const hiddenResult = structuredClone(humanApproval()) as unknown as Record<string, any>;
    hiddenResult.approved_contract.hidden_result = { winning_candidate: "B" };
    expect(() => createLock(
      hiddenResult as unknown as HumanChallengeApproval,
    ))
      .toThrow(/exact|field|필드|hidden/i);

    const pack = createLock();
    const tamperedHash = structuredClone(pack);
    tamperedHash.locked_challenge_pack_hash = sha("0");
    expect(() => parseLockedChallengePack(tamperedHash))
      .toThrow(/hash|무결성|일치/i);

    const tamperedContract = structuredClone(pack);
    tamperedContract.approved_contract.task_contract.decision = "Tampered after lock.";
    expect(() => parseLockedChallengePack(tamperedContract))
      .toThrow(/hash|contract|무결성|일치/i);
  });

  it("실제 Define input·suggestion과 다른 self-authored source hash로 잠금 pack을 만들지 않는다", () => {
    const forged = structuredClone(humanApproval());
    forged.define_input_hash = "0".repeat(64);
    forged.define_suggestion_hash = "1".repeat(64);

    expect(() => createLockedChallengePack({
      approval: forged,
      defineInput: defineInput(),
      defineSuggestion: defineSuggestion(),
    } as never)).toThrow(/source|input|suggestion|hash|출처|일치/i);
  });

  it("pack payload hash를 다시 계산해도 승인자 필드에 숨은 identity를 심을 수 없다", () => {
    const pack = structuredClone(createLock());
    pack.approved_by = "Synthetic owner for H\u2212001";
    const { locked_challenge_pack_hash: _oldHash, ...payload } = pack;
    pack.locked_challenge_pack_hash = sha256CanonicalJson(payload);

    expect(() => parseLockedChallengePack(pack))
      .toThrow(/hidden|benchmark|case|oracle|dataset|누출/i);
  });

  it("가변 승인 getter가 보안 검사 뒤 숨은 identity를 승인자에 심는 TOCTOU를 거부한다", () => {
    const approval = humanApproval();
    const safeActor = approval.actor_label;
    let reads = 0;
    Object.defineProperty(approval, "actor_label", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return reads <= 2 ? safeActor : "Synthetic owner for H-001";
      },
    });

    expect(() => createLockedChallengePack({
      approval,
      defineInput: defineInput(),
      defineSuggestion: defineSuggestion(),
    })).toThrow(/accessor|getter|plain|data property|hidden|case|oracle|누출/i);
  });
});

describe("OpenAI Define 구조화 경계", () => {
  it("gpt-5.6-sol·medium·strict Structured Output·store false·SDK retry 0을 고정한다", async () => {
    const input = defineInput();
    const signal = new AbortController().signal;
    type CreateArgs = Parameters<OpenAIDefineResponsesClientLike["responses"]["create"]>;
    const create = vi.fn(async (..._args: CreateArgs) => ({
      id: "resp-define-1",
      status: "completed",
      model: "gpt-5.6-sol",
      service_tier: "default",
      output_text: JSON.stringify(defineSuggestion()),
      output: [],
      error: null,
      incomplete_details: null,
      usage: {
        input_tokens: 180,
        input_tokens_details: {
          cached_tokens: 20,
          cache_write_tokens: 10,
        },
        output_tokens: 90,
        output_tokens_details: { reasoning_tokens: 30 },
        total_tokens: 270,
      },
    }));
    const client: OpenAIDefineResponsesClientLike = { responses: { create } };
    const adapter = createOpenAIDefineAdapter(client);

    const result = await adapter.invoke(input, { timeoutMs: 2_345, signal });

    expect(create).toHaveBeenCalledTimes(1);
    const call = create.mock.calls[0];
    if (!call) throw new Error("OpenAI Define 경계 호출이 없습니다.");
    const [params, options] = call;
    expect(params).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning: { effort: "medium" },
      service_tier: "default",
      store: false,
      input: canonicalJsonStringify(input),
      text: {
        verbosity: "low",
        format: defineSuggestionResponseFormat,
      },
    });
    expect(params.instructions).toMatch(/advisory|human approval|task contract|hard gate/i);
    expect(params.instructions).not.toMatch(/hidden case|oracle|winner|purchase|deploy/i);
    expect(options).toEqual({ timeout: 2_345, maxRetries: 0, signal });
    expect(result).toEqual({
      responseId: "resp-define-1",
      responseStatusCode: 200,
      status: "completed",
      modelReportedId: "gpt-5.6-sol",
      serviceTierReported: "default",
      outputText: JSON.stringify(defineSuggestion()),
      usage: {
        inputTokens: 180,
        cachedInputTokens: 20,
        cacheWriteTokens: 10,
        outputTokens: 90,
        reasoningTokens: 30,
        totalTokens: 270,
      },
      error: null,
    });
    expect(OPENAI_DEFINE_REQUEST_CONTRACT).toMatchObject({
      modelRequestedId: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTierRequested: "default",
      store: false,
      sdkMaxRetries: 0,
      inputDataBoundary: [
        "business_brief",
        "constraints",
        "prohibited_actions",
        "source_manifest",
      ],
    });
    expect(OPENAI_DEFINE_MODEL_REPORTED_POLICY).toEqual({
      kind: "EXACT_ALLOWLIST",
      allowedModels: ["gpt-5.6-sol"],
      unknownModelDisposition: "EVIDENCE_INVALID_COST_INCOMPLETE",
    });
    expect(Object.isFrozen(OPENAI_DEFINE_RESPONSE_FORMAT)).toBe(true);
    expect(Object.isFrozen(OPENAI_DEFINE_RESPONSE_FORMAT.schema)).toBe(true);
  });

  it("숨은 Benchmark 필드를 요청 생성 전에 거부해 injected client에도 전달하지 않는다", () => {
    const hidden = structuredClone(defineInput()) as unknown as Record<string, unknown>;
    hidden.oracles = [{ case_id: "H-001" }];

    expect(() => buildOpenAIDefineRequest(hidden as unknown as DefineStructuringInput))
      .toThrow(/hidden|oracle|exact|field|필드/i);
  });
});

describe("Define 구조화 실행 증거", () => {
  it("유효한 advisory suggestion과 latency·usage·cost·4개 identity hash를 기록한다", async () => {
    const input = defineInput();
    const adapter = queuedAdapter([adapterResult()]);

    const result = await runDefineStructuring({
      adapter,
      input,
      now: monotonicNow(),
    });

    expect(adapter.invoke).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      schemaVersion: "define-structuring-run-v1",
      artifactKind: "DEFINE_STRUCTURING_EVIDENCE",
      synthetic: true,
      authority: "ADVISORY_ONLY",
      structuringStatus: "SUGGESTION_COMPLETE",
      suggestion: defineSuggestion(),
      attempts: [{
        attemptNumber: 1,
        status: "COMPLETE",
        retryEligible: false,
        latencyMs: 10,
        usage: usage(200),
        costState: "COMPLETE",
        error: null,
      }],
      totalLatencyMs: 10,
      costState: "COMPLETE",
    });
    expect(result.identity).toEqual({
      defineInputHash: sha256CanonicalJson(input),
      requestContractHash: sha256CanonicalJson(OPENAI_DEFINE_REQUEST_CONTRACT),
      outputSchemaHash: sha256CanonicalJson(OPENAI_DEFINE_RESPONSE_FORMAT.schema),
      pricingSnapshotHash: sha256CanonicalJson(DEFINE_PRICING_SNAPSHOT),
    });
    expect(result.usageCost?.totalCostUsd).toBeGreaterThan(0);
    expect(parseDefineStructuringRunRecord(result, input)).toEqual(result);
    expect(validateDefineStructuringRunIdentity(result, input)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(
      /"(?:locked_challenge_pack|lock_authority|winner|approved_candidate)"/i,
    );
  });

  it("invalid output은 정확히 한 번 재시도하고 두 유료 시도를 모두 합산한다", async () => {
    const adapter = queuedAdapter([
      adapterResult({ outputText: "{not-json", usage: usage(100) }),
      adapterResult({
        responseId: "resp-define-run-2",
        usage: usage(300),
      }),
      adapterResult({ responseId: "must-not-run" }),
    ]);

    const result = await runDefineStructuring({
      adapter,
      input: defineInput(),
      now: monotonicNow(),
    });

    expect(adapter.invoke).toHaveBeenCalledTimes(2);
    expect(result.structuringStatus).toBe("SUGGESTION_COMPLETE");
    expect(result.attempts.map((attempt) => attempt.status))
      .toEqual(["INVALID_OUTPUT", "COMPLETE"]);
    expect(result.attempts.map((attempt) => attempt.retryEligible))
      .toEqual([true, false]);
    expect(result.attempts.map((attempt) => attempt.usage?.inputTokens))
      .toEqual([100, 300]);
    expect(result.usageCost?.tokenBreakdown.regularInputTokens).toBe(370);
    expect(result.totalLatencyMs).toBe(20);
  });

  it.each([
    ["refusal", "refused", "REFUSED"],
    ["incomplete", "incomplete", "INCOMPLETE"],
  ] as const)("%s 응답은 제안으로 승격하거나 자동 재시도하지 않는다", async (
    _label,
    responseStatus,
    attemptStatus,
  ) => {
    const adapter = queuedAdapter([adapterResult({
      status: responseStatus,
      outputText: null,
      error: `synthetic ${responseStatus}`,
    })]);

    const result = await runDefineStructuring({
      adapter,
      input: defineInput(),
      now: monotonicNow(),
    });

    expect(adapter.invoke).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      structuringStatus: "SUGGESTION_INCOMPLETE",
      suggestion: null,
      attempts: [{
        status: attemptStatus,
        retryEligible: false,
        costState: "COMPLETE",
      }],
      costState: "COMPLETE",
    });
    expect(result.usageCost?.totalCostUsd).toBeGreaterThan(0);
  });

  it.each([
    ["자동 잠금 필드", (value: Record<string, any>) => {
      value.locked = true;
    }],
    ["숨은 oracle 누출", (value: Record<string, any>) => {
      value.limitations[0] = "Tune this contract to oracle H-001.";
    }],
    ["strict schema extra key", (value: Record<string, any>) => {
      value.task_contract.winner = "A";
    }],
  ] as const)("%s 출력은 거절하고 정확히 한 번만 재시도한다", async (
    _label,
    mutate,
  ) => {
    const invalid = structuredClone(defineSuggestion()) as unknown as Record<string, any>;
    mutate(invalid);
    const adapter = queuedAdapter([
      adapterResult({ outputText: JSON.stringify(invalid), usage: usage(120) }),
      adapterResult({ responseId: "resp-define-valid-retry", usage: usage(180) }),
    ]);

    const result = await runDefineStructuring({
      adapter,
      input: defineInput(),
      now: monotonicNow(),
    });

    expect(adapter.invoke).toHaveBeenCalledTimes(2);
    expect(result.structuringStatus).toBe("SUGGESTION_COMPLETE");
    expect(result.attempts.map((attempt) => attempt.status))
      .toEqual(["INVALID_OUTPUT", "COMPLETE"]);
    expect(result.attempts.map((attempt) => attempt.retryEligible))
      .toEqual([true, false]);
  });

  it("HTTP 503은 실행기에서 한 번만 재시도하고 사용량 불명 비용을 확정하지 않는다", async () => {
    const adapter = queuedAdapter([
      new DefineInvocationError("synthetic 503", {
        retryable: true,
        kind: "OTHER",
        requestDisposition: "RESPONSE_ERROR_RECEIVED",
        responseStatusCode: 503,
        usage: null,
      }),
      adapterResult({ responseId: "resp-define-after-503", usage: usage(180) }),
    ]);

    const result = await runDefineStructuring({
      adapter,
      input: defineInput(),
      now: monotonicNow(),
    });

    expect(adapter.invoke).toHaveBeenCalledTimes(2);
    expect(result.attempts).toMatchObject([
      {
        status: "REQUEST_ERROR",
        requestDisposition: "RESPONSE_ERROR_RECEIVED",
        responseStatusCode: 503,
        retryEligible: true,
        usage: null,
        usageCost: null,
        costState: "COST_INCOMPLETE",
      },
      {
        status: "COMPLETE",
        retryEligible: false,
      },
    ]);
    expect(result.structuringStatus).toBe("SUGGESTION_COMPLETE");
    expect(result.costState).toBe("COST_INCOMPLETE");
    expect(result.usageCost).toBeNull();
  });

  it.each([
    ["missing model", { modelReportedId: null }],
    ["wrong model", { modelReportedId: "gpt-5.6-terra" }],
    ["missing tier", { serviceTierReported: null }],
    ["wrong tier", { serviceTierReported: "priority" }],
  ] as const)("가격 model/tier 증거가 다른 %s 응답은 제안과 비용을 확정하지 않는다", async (
    _label,
    override,
  ) => {
    const result = await runDefineStructuring({
      adapter: queuedAdapter([adapterResult(override)]),
      input: defineInput(),
      now: monotonicNow(),
    });

    expect(result).toMatchObject({
      structuringStatus: "SUGGESTION_INCOMPLETE",
      suggestion: null,
      costState: "COST_INCOMPLETE",
      usageCost: null,
      attempts: [{
        status: "EVIDENCE_INVALID",
        retryEligible: false,
        costState: "COST_INCOMPLETE",
        usageCost: null,
      }],
    });
  });

  it("272K를 넘는 input은 short-context 비용으로 계산하거나 제안으로 승격하지 않는다", async () => {
    const longUsage: TokenUsage = {
      inputTokens: 272_001,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10,
      reasoningTokens: 0,
      totalTokens: 272_011,
    };

    const result = await runDefineStructuring({
      adapter: queuedAdapter([adapterResult({ usage: longUsage })]),
      input: defineInput(),
      now: monotonicNow(),
    });

    expect(result).toMatchObject({
      structuringStatus: "SUGGESTION_INCOMPLETE",
      suggestion: null,
      costState: "COST_INCOMPLETE",
      usageCost: null,
      attempts: [{
        status: "EVIDENCE_INVALID",
        retryEligible: false,
        costState: "COST_INCOMPLETE",
        usageCost: null,
      }],
    });
    expect(result.attempts[0]?.error).toMatch(/272|long-context|가격/i);
  });

  it.each([
    [
      "fractional token count",
      {
        inputTokens: 200.5,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10.25,
        reasoningTokens: 0,
        totalTokens: 210.75,
      },
    ],
    [
      "reasoning exceeds output",
      {
        inputTokens: 200,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10,
        reasoningTokens: 11,
        totalTokens: 210,
      },
    ],
    [
      "total does not equal input plus output",
      {
        inputTokens: 200,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10,
        reasoningTokens: 5,
        totalTokens: 1,
      },
    ],
    [
      "missing reasoning token evidence",
      {
        inputTokens: 200,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10,
        totalTokens: 210,
      },
    ],
    [
      "missing total token evidence",
      {
        inputTokens: 200,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10,
        reasoningTokens: 5,
      },
    ],
  ] as const)("유효하지 않은 usage 불변식 %s를 비용·제안으로 승격하지 않는다", async (
    _label,
    invalidUsage,
  ) => {
    const result = await runDefineStructuring({
      adapter: queuedAdapter([adapterResult({ usage: invalidUsage as TokenUsage })]),
      input: defineInput(),
      now: monotonicNow(),
    });

    expect(result).toMatchObject({
      structuringStatus: "SUGGESTION_INCOMPLETE",
      suggestion: null,
      costState: "COST_INCOMPLETE",
      usageCost: null,
      attempts: [{
        status: "EVIDENCE_INVALID",
        retryEligible: false,
        usage: null,
        usageCost: null,
        costState: "COST_INCOMPLETE",
      }],
    });
    expect(result.attempts[0]?.error).toMatch(/usage|token|integer|reasoning|total|정수|합계|무결성/i);
  });

  it("일반 adapter 예외를 증거로 남기되 key 형태 비밀정보를 제거한다", async () => {
    const secret = ["sk", "define-malicious-secret-1234567890"].join("-");

    const result = await runDefineStructuring({
      adapter: queuedAdapter([new Error(`unexpected ${secret}`)]),
      input: defineInput(),
      now: monotonicNow(),
    });

    expect(result).toMatchObject({
      structuringStatus: "SUGGESTION_INCOMPLETE",
      costState: "COST_INCOMPLETE",
      attempts: [{
        status: "EVIDENCE_INVALID",
        requestDisposition: "SENT_OUTCOME_UNKNOWN",
        costState: "COST_INCOMPLETE",
      }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.attempts[0]?.error).toContain("[REDACTED]");
  });

  it.each([
    ["GitHub", ["ghp", "syntheticTokenValue1234567890"].join("_")],
    ["Slack", ["xoxb", "synthetic-token-value-1234567890"].join("-")],
    ["GitLab", ["glpat", "syntheticTokenValue1234567890"].join("-")],
    ["Google", ["AI", "zaSyntheticGoogleApiKeyValue1234567890"].join("")],
    [
      "JWT",
      [
        "eyJhbGciOiJIUzI1NiJ9",
        "eyJzdWIiOiJzeW50aGV0aWMifQ",
        "syntheticSignatureValue1234567890",
      ].join("."),
    ],
  ])("%s 형태 credential을 adapter 오류 증거에서 마스킹한다", async (_label, secret) => {
    const result = await runDefineStructuring({
      adapter: queuedAdapter([new Error(`synthetic failure ${secret}`)]),
      input: defineInput(),
      now: monotonicNow(),
    });

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.attempts[0]?.error).toContain("[REDACTED]");
  });

  it("실행 시작 시 입력을 snapshot해 외부 변경이 재시도나 identity를 바꾸지 못하게 한다", async () => {
    const input = defineInput();
    const expectedHash = sha256CanonicalJson(input);
    const receivedInputs: DefineStructuringInput[] = [];
    let callCount = 0;
    const invoke = vi.fn(async (received: DefineStructuringInput) => {
      receivedInputs.push(structuredClone(received));
      callCount += 1;
      if (callCount === 1) {
        input.business_brief.workflow = "Externally tampered after first request.";
        return adapterResult({ outputText: "not-json" });
      }
      return adapterResult({ responseId: "resp-after-input-mutation" });
    });

    const result = await runDefineStructuring({
      adapter: { invoke },
      input,
      now: monotonicNow(),
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(receivedInputs[1]).toEqual(receivedInputs[0]);
    expect(result.identity.defineInputHash).toBe(expectedHash);
  });

  it("상위 parser가 extra key·identity·usage·cost·latency·status·suggestion 변조를 거부한다", async () => {
    const input = defineInput();
    const result = await runDefineStructuring({
      adapter: queuedAdapter([adapterResult()]),
      input,
      now: monotonicNow(),
    });
    const mutations: Array<[string, (value: Record<string, any>) => void]> = [
      ["top-level extra key", (value) => { value.winner = "A"; }],
      ["input identity", (value) => { value.identity.defineInputHash = sha("0"); }],
      ["attempt number", (value) => { value.attempts[0].attemptNumber = 2; }],
      ["attempt usage", (value) => { value.attempts[0].usage.inputTokens += 1; }],
      ["attempt cost", (value) => { value.attempts[0].usageCost.totalCostUsd += 1; }],
      ["total latency", (value) => { value.totalLatencyMs += 1; }],
      ["status relation", (value) => { value.structuringStatus = "SUGGESTION_INCOMPLETE"; }],
      ["suggestion authority", (value) => { value.suggestion.authority = "LOCKED"; }],
    ];

    for (const [label, mutate] of mutations) {
      const tampered = structuredClone(result) as unknown as Record<string, any>;
      mutate(tampered);
      expect(() => parseDefineStructuringRunRecord(tampered, input), label)
        .toThrow(/field|필드|identity|hash|attempt|usage|cost|latency|status|suggestion|authority|일치|무결성/i);
    }

    const downgradedCost = structuredClone(result) as unknown as Record<string, any>;
    downgradedCost.attempts[0].costState = "COST_INCOMPLETE";
    downgradedCost.attempts[0].usageCost = null;
    downgradedCost.costState = "COST_INCOMPLETE";
    downgradedCost.usageCost = null;
    expect(() => parseDefineStructuringRunRecord(downgradedCost, input))
      .toThrow(/cost|비용|usage|일치/i);
  });
});

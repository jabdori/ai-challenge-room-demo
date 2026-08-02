import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  BENCHMARK_CANDIDATE_SYSTEM_PROMPTS,
  createBenchmarkCandidateDefinition,
  type BenchmarkCandidateDefinition,
} from "../benchmark/candidateDefinitions";
import type { BenchmarkCandidateId } from "../benchmark/schedule";
import { executeBenchmarkCandidateSlot } from "../benchmark/executeSlot";
import type {
  BenchmarkSlotCandidateExecutionResult,
} from "../benchmark/executeSlot";
import type { BenchmarkScheduleSlot } from "../benchmark/schedule";
import {
  candidateOutputJsonSchema,
  parseCandidateOutput,
  type CandidateOutput,
} from "../contracts/candidateOutput";
import type { CandidateExecutionEvidence } from "../contracts/executionEvidence";
import {
  buildCandidateFacingCase,
  buildCandidateFacingPolicySection,
  type CandidateFacingCase,
  type CandidateFacingPolicySection,
  type EvaluationOracle,
  type EvaluationOrder,
  type PolicySection,
} from "../contracts/evaluationCase";
import { evaluateHardGates } from "../deterministic/hardGates";
import {
  assertAuthoritativeDecisionBaselineRecord,
  type DecisionBaselineRecord,
} from "../decision/decisionBaseline";
import {
  BENCHMARK_CASES,
  BENCHMARK_CHALLENGE,
  BENCHMARK_DATASET_HASH,
  BENCHMARK_ORACLES,
  BENCHMARK_POLICIES,
  BENCHMARK_ORDERS,
  REGRESSION_ORDERS,
  REGRESSION_CANARIES,
  REGRESSION_CANARY_HASH,
  REGRESSION_CANARY_ORACLES,
  buildBenchmarkCandidateInput,
  buildRegressionCandidateOrderAccess,
} from "../data/benchmark";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import { DEFAULT_PRICING_SNAPSHOT } from "../runtime/pricing";
import { inspectProviderUsageLedger } from "../runtime/providerUsageLedger";
import type { PolicyVectorStoreCleanupResult } from "../retrieval/policyVectorStore";
import {
  assertAuthoritativeBenchmarkResourceLeaseTerminal,
  type BenchmarkResourceLeaseTerminalAuthority,
} from "../benchmark/resourceLease";
import type {
  CandidateAdapter,
  CandidateInvocation,
} from "../runner/types";
import {
  createCandidateAAdapter,
  type OpenAIResponsesClientLike,
} from "../openai/candidateAAdapter";
import {
  createBenchmarkCandidateBAdapter,
  type BenchmarkCandidateBClientLike,
} from "../benchmark/candidateBAdapter";
import {
  createBenchmarkCandidateCAdapter,
  type BenchmarkCandidateCClientLike,
} from "../benchmark/candidateCAdapter";
import {
  createBenchmarkSupportToolExecutor,
  type BenchmarkSupportToolClientLike,
  type BenchmarkSupportToolName,
} from "../benchmark/supportTools";
import type {
  PreparedBenchmarkPolicyVectorStore,
} from "../benchmark/policyVectorStore";
import {
  buildRecordedRegressionPack,
  loadRecordedRegressionPackFromSources,
  persistRecordedRegressionPack,
  type RecordedRegressionPack,
  type RegressionAuthorityChain,
  type RegressionResourceEvidence,
  type RegressionSlotRecord,
  type RegressionVersionIdentity,
} from "./regressionPack";

const SHA256 = /^[a-f0-9]{64}$/;
const CASE_IDS = Object.freeze([
  ...BENCHMARK_CASES.map((item) => item.case_id),
  ...REGRESSION_CANARIES.map((item) => item.case_id),
]);
const VERSIONS = ["BASELINE_V1", "PROPOSED_V2"] as const;
const DEFECT_REMOVED_SOURCE_ID = "RET";
const DEFECT_REMOVED_SECTION_ID = "3.1";
const DEFECT_EXPOSED_SOURCE_ID = "RET";
const DEFECT_EXPOSED_SECTION_ID = "3.3";

export type RegressionVersion = (typeof VERSIONS)[number];

export interface RegressionScheduleSlot {
  readonly slot_id: string;
  readonly sequence: number;
  readonly version: RegressionVersion;
  readonly case_id: string;
  readonly dataset_split: "HIDDEN_BENCHMARK" | "REGRESSION_CANARY";
  readonly candidate_id: BenchmarkCandidateId;
  readonly repetition: 1;
}

export type RegressionSchedule = readonly RegressionScheduleSlot[] & {
  readonly schedule_id: string;
};

export interface RegressionSufficiencyContract {
  readonly hidden_policy_minimum_correct: 11;
  readonly hidden_citation_required_cases: 11;
  readonly hidden_escalation_required_cases: 4;
  readonly mean_runtime_cost_usd_maximum: number;
  readonly median_latency_ms_maximum: number;
  readonly worst_latency_ms_maximum: number;
}

export interface RegressionProviderCallEvidence {
  readonly call_number: number;
  readonly response_id_hash: string;
  readonly status: "completed" | "incomplete" | "failed" | "refused";
  readonly usage_hash: string;
  readonly latency_ms: number;
}

export interface RegressionCandidateExecution {
  readonly execution_status:
    | "COMPLETE"
    | "INVALID"
    | "TIMEOUT"
    | "BUDGET_EXCEEDED"
    | "FAILED";
  readonly evaluation_status:
    | "EVALUATED"
    | "NOT_EVALUATED"
    | "EVALUATION_INCOMPLETE";
  readonly request_disposition:
    | "NOT_SENT"
    | "SENT_RESPONSE_RECORDED"
    | "SENT_OUTCOME_UNKNOWN";
  readonly cost_state: "COMPLETE" | "COST_INCOMPLETE";
  readonly candidate_cost_usd: number | null;
  readonly total_latency_ms: number;
  readonly output_hash: string;
  readonly candidate_output: CandidateOutput | null;
  readonly provider_calls: readonly RegressionProviderCallEvidence[];
  readonly retrieval_calls: readonly unknown[];
  readonly tool_calls: readonly unknown[];
  readonly access_evidence_hash: string;
  readonly deterministic_evaluation: {
    readonly hard_gate_failures: string[];
    readonly policy_decision_passed: boolean;
    readonly citation_passed: boolean;
    readonly escalation_passed: boolean;
  };
}

export interface ValidatedRegressionCandidateExecutionReceipt {
  readonly schema_version: "validated-regression-candidate-receipt-v1";
  readonly request_identity_hash: string;
  readonly candidate_execution: BenchmarkSlotCandidateExecutionResult;
}

const VALIDATED_CANDIDATE_EXECUTION_RECEIPTS = new WeakSet<object>();

export interface RegressionCandidatePolicyAccess {
  readonly delivery:
    | "INLINE_CORPUS"
    | "RETRIEVAL_INDEX"
    | "SEARCH_POLICY_BACKEND";
  readonly corpus_hash: string;
  readonly sections: readonly CandidateFacingPolicySection[];
}

export interface RegressionVersionContext {
  readonly slot: RegressionScheduleSlot;
  readonly selected_candidate_id: BenchmarkCandidateId;
  readonly candidate_version: string;
  readonly candidate_case: CandidateFacingCase;
  readonly candidate_policy_access: RegressionCandidatePolicyAccess;
  readonly candidate_order_access: unknown;
  readonly candidate_input_hash: string;
  readonly candidate_config_hash: string;
  readonly system_prompt_hash: string;
}

export interface RegressionCandidateExecutionRequest
  extends RegressionVersionContext {
  readonly slot_identity_hash: string;
}

export interface CreateRegressionCandidateExecutorInput {
  readonly adapterFor: (
    context: RegressionVersionContext,
  ) => CandidateAdapter;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

interface PersistReceiptInput {
  readonly path: string;
  readonly artifact: RegressionLedgerReceipt;
}

export interface RegressionRunnerDependencies {
  readonly assertBaselineRecord: (
    value: unknown,
  ) => asserts value is DecisionBaselineRecord;
  readonly executeCandidate: (
    request: RegressionCandidateExecutionRequest,
  ) => Promise<ValidatedRegressionCandidateExecutionReceipt>;
  readonly resourceEvidence: (
    input: {
      readonly selectedCandidateId: BenchmarkCandidateId;
      readonly contexts: readonly RegressionVersionContext[];
      readonly authorityBinding: RegressionResourceAuthorityBinding;
    },
  ) => Promise<ValidatedRegressionResourceCleanupEvidence>;
  readonly persistReceipt?: (input: PersistReceiptInput) => Promise<void>;
  readonly afterCheckpoint?: (
    input: { readonly completed: number; readonly slot: RegressionScheduleSlot },
  ) => Promise<void>;
}

export interface RegressionRemoteResourceCleanupInput {
  readonly policy_resource_identity_hash: string;
  readonly manifest_hash: string;
  readonly vector_store_id: string;
  readonly uploaded_file_ids: readonly string[];
  readonly cleanup: PolicyVectorStoreCleanupResult;
}

export interface ValidatedRegressionResourceCleanupEvidence {
  readonly selected_candidate_id: BenchmarkCandidateId;
  readonly authority_binding: RegressionResourceAuthorityBinding;
  readonly evidence: RegressionResourceEvidence;
}

const VALIDATED_RESOURCE_CLEANUP = new WeakSet<object>();

export interface RegressionResourceAuthorityBinding {
  readonly decision_baseline_record_hash: string;
  readonly resource_authority_contract_hash: string;
}

export function buildRegressionResourceAuthorityBinding(
  record: DecisionBaselineRecord,
): RegressionResourceAuthorityBinding {
  return deepFreeze({
    decision_baseline_record_hash: sha256CanonicalJson(record),
    resource_authority_contract_hash: sha256CanonicalJson({
      schema_version: "recorded-regression-resource-authority-v1",
      recorded_benchmark_pack_hash: record.recorded_benchmark_pack_hash,
      selected_candidate_identity: record.selected_candidate_identity,
    }),
  });
}

function assertRegressionResourceAuthorityBinding(
  value: RegressionResourceAuthorityBinding,
): void {
  if (
    !SHA256.test(value.decision_baseline_record_hash)
    || !SHA256.test(value.resource_authority_contract_hash)
  ) {
    fail("회귀 resource authority binding이 lowercase SHA-256 계약과 다릅니다.");
  }
}

function cleanedResourceEvidenceForTest(
  input: RegressionRemoteResourceCleanupInput,
  label: string,
): RegressionResourceEvidence["baseline"] {
  if (
    !SHA256.test(input.policy_resource_identity_hash)
    || !SHA256.test(input.manifest_hash)
    || input.vector_store_id.trim().length === 0
    || !Array.isArray(input.uploaded_file_ids)
    || input.uploaded_file_ids.length === 0
    || new Set(input.uploaded_file_ids).size !== input.uploaded_file_ids.length
  ) {
    fail(`${label} remote resource identity/manifest가 잠긴 형식과 다릅니다.`);
  }
  const vectorStore = input.cleanup.vectorStore;
  const files = input.cleanup.uploadedFiles;
  if (
    vectorStore.id !== input.vector_store_id
    || vectorStore.attempted !== true
    || vectorStore.deleted !== true
    || vectorStore.error !== undefined
    || files.length !== input.uploaded_file_ids.length
    || files.some((file, index) => (
      file.id !== input.uploaded_file_ids[index]
      || file.attempted !== true
      || file.deleted !== true
      || file.error !== undefined
    ))
  ) {
    fail(`${label} cleanup 삭제 승인과 실제 remote resource binding이 다릅니다.`);
  }
  return deepFreeze({
    status: "CLEANED",
    policy_resource_identity_hash: input.policy_resource_identity_hash,
    manifest_hash: input.manifest_hash,
    cleanup_receipt_hash: sha256CanonicalJson({
      schema_version: "regression-resource-cleanup-receipt-v1",
      vector_store_id_hash: sha256CanonicalJson(input.vector_store_id),
      uploaded_file_id_hashes:
        input.uploaded_file_ids.map((id) => sha256CanonicalJson(id)),
      cleanup: input.cleanup,
    }),
  });
}

export function buildValidatedRegressionResourceCleanupEvidence({
  selectedCandidateId,
  baseline,
  proposed,
  authorityBinding,
}: {
  readonly selectedCandidateId: BenchmarkCandidateId;
  readonly baseline: BenchmarkResourceLeaseTerminalAuthority | null;
  readonly proposed: BenchmarkResourceLeaseTerminalAuthority | null;
  readonly authorityBinding: RegressionResourceAuthorityBinding;
}): ValidatedRegressionResourceCleanupEvidence {
  assertRegressionResourceAuthorityBinding(authorityBinding);
  const noRemoteResource = {
    status: "NOT_REQUIRED" as const,
    policy_resource_identity_hash: null,
    manifest_hash: null,
    cleanup_receipt_hash: null,
  };
  if (selectedCandidateId === "A") {
    if (baseline !== null || proposed !== null) {
      fail("Candidate A 회귀에는 원격 정책 검색 resource가 필요하지 않습니다.");
    }
    const result = deepFreeze({
      selected_candidate_id: selectedCandidateId,
      authority_binding: structuredClone(authorityBinding),
      evidence: {
        baseline: noRemoteResource,
        proposed: noRemoteResource,
      },
    });
    VALIDATED_RESOURCE_CLEANUP.add(result);
    return result;
  }
  if (baseline === null || proposed === null) {
    fail("Candidate B/C 회귀에는 v1/v2 각각의 검증된 remote cleanup receipt가 필요합니다.");
  }
  assertAuthoritativeBenchmarkResourceLeaseTerminal(baseline);
  assertAuthoritativeBenchmarkResourceLeaseTerminal(proposed);
  const contexts = buildRegressionVersionContexts(selectedCandidateId);
  const expectedCorpus = {
    baseline: contexts.find(
      (context) => context.slot.version === "BASELINE_V1",
    )!.candidate_policy_access.corpus_hash,
    proposed: contexts.find(
      (context) => context.slot.version === "PROPOSED_V2",
    )!.candidate_policy_access.corpus_hash,
  };
  const authorityEvidence = (
    authority: BenchmarkResourceLeaseTerminalAuthority,
    version: "baseline" | "proposed",
  ): RegressionResourceEvidence["baseline"] => {
    const prepared = authority.prepared_store;
    const contract = authority.contract;
    if (
      contract.locked_challenge_pack_sha256
        !== authorityBinding.decision_baseline_record_hash
      || contract.locked_challenge_contract_sha256
        !== authorityBinding.resource_authority_contract_hash
    ) {
      fail(
        `${version} durable resource lease의 결정 authority binding이 다릅니다.`,
      );
    }
    if (
      contract.schedule_id !== buildRegressionSchedule(selectedCandidateId)
        .schedule_id
      || contract.policy_corpus_sha256 !== expectedCorpus[version]
      || prepared.resourceIdentity.policy_corpus_sha256
        !== expectedCorpus[version]
      || prepared.resourceIdentity.chunking_config_sha256
        !== contract.chunking_config_sha256
      || prepared.resourceIdentity.resource_contract_sha256
        !== contract.resource_contract_sha256
      || prepared.resourceIdentity.manifest_sha256
        !== prepared.manifestSha256
      || prepared.uploadedFileIds.length !== contract.expected_file_count
      || prepared.files.length !== contract.expected_file_count
    ) {
      fail(
        `${version} durable resource lease가 regression corpus/manifest/chunking 계약과 다릅니다.`,
      );
    }
    return deepFreeze({
      status: "CLEANED" as const,
      policy_resource_identity_hash:
        prepared.resourceIdentitySha256,
      manifest_hash: prepared.manifestSha256,
      cleanup_receipt_hash: authority.terminal_record_sha256,
    });
  };
  const result = deepFreeze({
    selected_candidate_id: selectedCandidateId,
    authority_binding: structuredClone(authorityBinding),
    evidence: {
      baseline: authorityEvidence(baseline, "baseline"),
      proposed: authorityEvidence(proposed, "proposed"),
    },
  });
  VALIDATED_RESOURCE_CLEANUP.add(result);
  return result;
}

/** production에서는 사용할 수 없는 offline 공격·재개 테스트 전용 경계입니다. */
export function buildValidatedRegressionResourceCleanupEvidenceForTest({
  selectedCandidateId,
  baseline,
  proposed,
  authorityBinding,
}: {
  readonly selectedCandidateId: BenchmarkCandidateId;
  readonly baseline: RegressionRemoteResourceCleanupInput | null;
  readonly proposed: RegressionRemoteResourceCleanupInput | null;
  readonly authorityBinding: RegressionResourceAuthorityBinding;
}): ValidatedRegressionResourceCleanupEvidence {
  if (process.env.NODE_ENV !== "test") {
    fail("plain cleanup acknowledgement는 production authority가 아닙니다.");
  }
  if (selectedCandidateId === "A") {
    return buildValidatedRegressionResourceCleanupEvidence({
      selectedCandidateId,
      baseline: null,
      proposed: null,
      authorityBinding,
    });
  }
  if (baseline === null || proposed === null) {
    fail("B/C test cleanup에는 baseline/proposed가 모두 필요합니다.");
  }
  const result = deepFreeze({
    selected_candidate_id: selectedCandidateId,
    authority_binding: structuredClone(authorityBinding),
    evidence: {
      baseline: cleanedResourceEvidenceForTest(baseline, "baseline"),
      proposed: cleanedResourceEvidenceForTest(proposed, "proposed"),
    },
  });
  VALIDATED_RESOURCE_CLEANUP.add(result);
  return result;
}

function assertValidatedResourceCleanup(
  value: unknown,
  selectedCandidateId: BenchmarkCandidateId,
  authorityBinding: RegressionResourceAuthorityBinding,
): asserts value is ValidatedRegressionResourceCleanupEvidence {
  if (
    typeof value !== "object"
    || value === null
    || !VALIDATED_RESOURCE_CLEANUP.has(value)
    || !Object.isFrozen(value)
    || (value as ValidatedRegressionResourceCleanupEvidence)
      .selected_candidate_id !== selectedCandidateId
    || canonicalJsonStringify(
      (value as ValidatedRegressionResourceCleanupEvidence)
        .authority_binding,
    ) !== canonicalJsonStringify(authorityBinding)
  ) {
    fail("회귀 resource evidence는 실제 삭제 승인으로 검증된 동일 branded 객체여야 합니다.");
  }
}

export interface RunRecordedRegressionOptions {
  readonly outputDirectory: string;
  readonly decisionBaselineRecord: DecisionBaselineRecord;
  readonly sufficiency: RegressionSufficiencyContract;
  readonly dependencies: RegressionRunnerDependencies;
  readonly createdAt?: string;
}

export interface RunRecordedRegressionResult {
  readonly pack: RecordedRegressionPack;
  readonly path: string;
  readonly payloadSha256: string;
  readonly executedSlots: number;
  readonly reusedSlots: number;
}

export interface LoadRecordedRegressionFromAuthorityOptions {
  readonly outputDirectory: string;
  readonly path: string;
  readonly decisionBaselineRecord: DecisionBaselineRecord;
  readonly sufficiency: RegressionSufficiencyContract;
  readonly resourceCleanup: ValidatedRegressionResourceCleanupEvidence;
  readonly createdAt: string;
  readonly assertBaselineRecord?: RegressionRunnerDependencies["assertBaselineRecord"];
}

export class RegressionRunnerIntegrityError extends Error {
  readonly code = "REGRESSION_RUNNER_INTEGRITY" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegressionRunnerIntegrityError";
  }
}

export class RegressionAmbiguousInFlightError extends Error {
  readonly code = "REGRESSION_AMBIGUOUS_IN_FLIGHT" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;
  readonly allowRemoteCall = false as const;

  constructor(readonly slotId: string) {
    super(
      `intent-only 회귀 slot의 원격 결과가 불명확해 자동 재호출할 수 없습니다: ${slotId}`,
    );
    this.name = "RegressionAmbiguousInFlightError";
  }
}

function fail(message: string, cause?: unknown): never {
  throw new RegressionRunnerIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
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

export function buildRegressionSchedule(
  selectedCandidateId: BenchmarkCandidateId,
): RegressionSchedule {
  if (!["A", "B", "C"].includes(selectedCandidateId)) {
    fail("회귀 schedule에는 A/B/C 중 선택된 후보가 필요합니다.");
  }
  const slots = VERSIONS.flatMap((version) => (
    CASE_IDS.map((caseId) => ({
      version,
      caseId,
    }))
  )).map(({ version, caseId }, index): RegressionScheduleSlot => deepFreeze({
    slot_id: `${version}--${caseId}`,
    sequence: index + 1,
    version,
    case_id: caseId,
    dataset_split: caseId.startsWith("H-")
      ? "HIDDEN_BENCHMARK"
      : "REGRESSION_CANARY",
    candidate_id: selectedCandidateId,
    repetition: 1,
  }));
  const scheduleId = sha256CanonicalJson({
    schema_version: "regression-schedule-v1",
    selected_candidate_id: selectedCandidateId,
    slots,
  });
  Object.defineProperty(slots, "schedule_id", {
    value: scheduleId,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.freeze(slots);
  return slots as unknown as RegressionSchedule;
}

function policiesFor(version: RegressionVersion): readonly CandidateFacingPolicySection[] {
  const policies = regressionPolicyCorpusForVersion(version);
  const projected = policies.map(buildCandidateFacingPolicySection);
  const activePresent = projected.some((policy) => (
    policy.source_id === DEFECT_REMOVED_SOURCE_ID
    && policy.section_id === DEFECT_REMOVED_SECTION_ID
  ));
  const retiredPresent = projected.some((policy) => (
    policy.source_id === DEFECT_EXPOSED_SOURCE_ID
    && policy.section_id === DEFECT_EXPOSED_SECTION_ID
    && policy.lifecycle_status === "RETIRED"
  ));
  if (
    retiredPresent !== true
    || (version === "BASELINE_V1" ? !activePresent : activePresent)
  ) {
    fail("회귀 v1/v2 정책 결함 주입이 잠긴 RET 3.1/3.3 계약과 다릅니다.");
  }
  return deepFreeze(projected);
}

export function regressionPolicyCorpusForVersion(
  version: RegressionVersion,
): readonly PolicySection[] {
  const policies = version === "BASELINE_V1"
    ? BENCHMARK_POLICIES
    : BENCHMARK_POLICIES.filter((policy) => !(
      policy.source_id === DEFECT_REMOVED_SOURCE_ID
      && policy.section_id === DEFECT_REMOVED_SECTION_ID
    ));
  return policies;
}

function caseFor(caseId: string) {
  return BENCHMARK_CASES.find((item) => item.case_id === caseId)
    ?? REGRESSION_CANARIES.find((item) => item.case_id === caseId)
    ?? fail(`잠긴 회귀 case가 없습니다: ${caseId}`);
}

function orderAccessFor(
  candidateId: BenchmarkCandidateId,
  caseId: string,
): unknown {
  if (caseId.startsWith("R-")) {
    return buildRegressionCandidateOrderAccess(candidateId, caseId);
  }
  return buildBenchmarkCandidateInput(candidateId, caseId).order_access;
}

function deliveryFor(
  candidateId: BenchmarkCandidateId,
): RegressionCandidatePolicyAccess["delivery"] {
  if (candidateId === "A") return "INLINE_CORPUS";
  if (candidateId === "B") return "RETRIEVAL_INDEX";
  return "SEARCH_POLICY_BACKEND";
}

export function buildRegressionVersionContexts(
  selectedCandidateId: BenchmarkCandidateId,
): readonly RegressionVersionContext[] {
  const schedule = buildRegressionSchedule(selectedCandidateId);
  const systemPrompt = BENCHMARK_CANDIDATE_SYSTEM_PROMPTS[selectedCandidateId];
  return deepFreeze(schedule.map((slot): RegressionVersionContext => {
    const evaluationCase = caseFor(slot.case_id);
    const sections = policiesFor(slot.version);
    const policyAccess: RegressionCandidatePolicyAccess = {
      delivery: deliveryFor(selectedCandidateId),
      corpus_hash: sha256CanonicalJson(sections),
      sections,
    };
    const candidateCase = buildCandidateFacingCase(evaluationCase);
    const orderAccess = orderAccessFor(selectedCandidateId, slot.case_id);
    let candidateInputHash = sha256CanonicalJson({
      case: candidateCase,
      policy_delivery: policyAccess.delivery,
      policy_corpus_hash: policyAccess.corpus_hash,
      order_access: orderAccess,
    });
    let candidateVersion = slot.version === "BASELINE_V1"
      ? `candidate-${selectedCandidateId.toLowerCase()}-benchmark-v1`
      : `candidate-${selectedCandidateId.toLowerCase()}-regression-v2`;
    let candidateConfigHash = sha256CanonicalJson({
      schema_version: "regression-candidate-config-v1",
      candidate_id: selectedCandidateId,
      candidate_version: candidateVersion,
      case_id: slot.case_id,
      dataset_split: slot.dataset_split,
      policy_delivery: policyAccess.delivery,
      policy_corpus_hash: policyAccess.corpus_hash,
      input_hash: candidateInputHash,
      system_prompt_hash: sha256CanonicalJson(systemPrompt),
      model_requested_id: "gpt-5.6-terra",
      reasoning_effort: "low",
      service_tier: "default",
      store: false,
      max_automatic_retries: 1,
    });
    if (
      slot.version === "BASELINE_V1"
      && slot.dataset_split === "HIDDEN_BENCHMARK"
    ) {
      const oracle = oracleFor(slot.case_id);
      const expectation = oracle.candidate_access_expectations.find(
        (item) => item.candidate_id === selectedCandidateId,
      ) ?? fail(`잠긴 후보 접근 계약이 없습니다: ${slot.slot_id}`);
      const canonical = createBenchmarkCandidateDefinition({
        candidateId: selectedCandidateId,
        evaluationCase,
        authorizedOrder:
          expectation.expected_order_access_status === "SUCCESS"
            ? authoritativeOrderFor(slot.case_id)
            : null,
        policyCorpus: BENCHMARK_POLICIES,
        adapter: IDENTITY_ONLY_ADAPTER,
        challenge: BENCHMARK_CHALLENGE,
      });
      if (
        canonical.identity.policy_corpus_hash !== policyAccess.corpus_hash
        || canonical.identity.system_prompt_hash
          !== sha256CanonicalJson(systemPrompt)
      ) {
        fail(`v1 hidden canonical 후보 정의가 회귀 context와 다릅니다: ${slot.slot_id}`);
      }
      candidateVersion = canonical.candidateVersion;
      candidateConfigHash = canonical.identity.candidate_config_hash;
      candidateInputHash = sha256CanonicalJson(canonical.invocation.input);
    }
    return {
      slot,
      selected_candidate_id: selectedCandidateId,
      candidate_version: candidateVersion,
      candidate_case: candidateCase,
      candidate_policy_access: policyAccess,
      candidate_order_access: orderAccess,
      candidate_input_hash: candidateInputHash,
      candidate_config_hash: candidateConfigHash,
      system_prompt_hash: sha256CanonicalJson(systemPrompt),
    };
  }));
}

const IDENTITY_ONLY_ADAPTER: CandidateAdapter = Object.freeze({
  async invoke() {
    throw new RegressionRunnerIntegrityError(
      "identity-only adapter는 원격 실행에 사용할 수 없습니다.",
    );
  },
});

function oracleFor(caseId: string): EvaluationOracle {
  return BENCHMARK_ORACLES.find((item) => item.case_id === caseId)
    ?? REGRESSION_CANARY_ORACLES.find((item) => item.case_id === caseId)
    ?? fail(`잠긴 회귀 oracle이 없습니다: ${caseId}`);
}

function authoritativeOrderFor(caseId: string): EvaluationOrder | null {
  const evaluationCase = caseFor(caseId);
  if (evaluationCase.order_id === null) return null;
  return BENCHMARK_ORDERS.find(
    (item) => item.order_id === evaluationCase.order_id,
  ) ?? REGRESSION_ORDERS.find(
    (item) => item.order_id === evaluationCase.order_id,
  ) ?? fail(`잠긴 회귀 authoritative order가 없습니다: ${caseId}`);
}

function normalizedOrderAccessInput(
  context: RegressionVersionContext,
): unknown {
  if (
    typeof context.candidate_order_access !== "object"
    || context.candidate_order_access === null
    || Array.isArray(context.candidate_order_access)
  ) {
    fail(`candidate order access가 객체가 아닙니다: ${context.slot.slot_id}`);
  }
  const record = structuredClone(
    context.candidate_order_access,
  ) as Record<string, unknown>;
  delete record.channel;
  delete record.allowed_tools;
  delete record.injected_result_code;
  return record;
}

function invocationFor(
  context: RegressionVersionContext,
): CandidateInvocation {
  const candidateId = context.selected_candidate_id;
  const input = candidateId === "A"
    ? {
      case: context.candidate_case,
      policy_corpus: context.candidate_policy_access.sections,
      order_access_result: normalizedOrderAccessInput(context),
    }
    : candidateId === "B"
      ? {
        case: context.candidate_case,
        order_access_result: normalizedOrderAccessInput(context),
      }
      : { case: context.candidate_case };
  const envelope = {
    A: { provider: 1, retrieval: 0, tools: 0 },
    B: { provider: 1, retrieval: 1, tools: 0 },
    C: { provider: 2, retrieval: 2, tools: 2 },
  } as const;
  const limits = envelope[candidateId];
  return deepFreeze({
    candidateId,
    modelRequestedId: "gpt-5.6-terra",
    serviceTierRequested: "default",
    instructions: BENCHMARK_CANDIDATE_SYSTEM_PROMPTS[candidateId],
    input: JSON.stringify(input),
    limits: {
      maxInputTokens: 24_000,
      maxOutputTokens: 800,
      timeoutMs: 30_000,
    },
    executionEnvelope: {
      maxProviderCalls: limits.provider,
      maxRetrievalCalls: limits.retrieval,
      maxToolCalls: limits.tools,
    },
  });
}

function benchmarkSlotFor(
  slot: RegressionScheduleSlot,
): BenchmarkScheduleSlot {
  const candidatePosition = {
    A: 1,
    B: 2,
    C: 3,
  } as const;
  return deepFreeze({
    slot_id: `${slot.case_id}--${slot.candidate_id}--r1`,
    sequence: slot.sequence,
    case_id: slot.case_id,
    candidate_id: slot.candidate_id,
    candidate_position: candidatePosition[slot.candidate_id],
    repetition: 1,
  });
}

function definitionFor(
  context: RegressionVersionContext,
  adapter: CandidateAdapter,
): BenchmarkCandidateDefinition {
  const evaluationCase = caseFor(context.slot.case_id);
  if (
    context.slot.version === "BASELINE_V1"
    && context.slot.dataset_split === "HIDDEN_BENCHMARK"
  ) {
    const oracle = oracleFor(context.slot.case_id);
    const expectation = oracle.candidate_access_expectations.find(
      (item) => item.candidate_id === context.selected_candidate_id,
    ) ?? fail(`잠긴 후보 접근 계약이 없습니다: ${context.slot.slot_id}`);
    const canonical = createBenchmarkCandidateDefinition({
      candidateId: context.selected_candidate_id,
      evaluationCase,
      authorizedOrder:
        expectation.expected_order_access_status === "SUCCESS"
          ? authoritativeOrderFor(context.slot.case_id)
          : null,
      policyCorpus: BENCHMARK_POLICIES,
      adapter,
      challenge: BENCHMARK_CHALLENGE,
    });
    if (
      canonical.candidateVersion !== context.candidate_version
      || canonical.identity.candidate_config_hash
        !== context.candidate_config_hash
      || canonical.identity.system_prompt_hash !== context.system_prompt_hash
      || canonical.identity.policy_corpus_hash
        !== context.candidate_policy_access.corpus_hash
      || sha256CanonicalJson(canonical.invocation.input)
        !== context.candidate_input_hash
    ) {
      fail(
        `v1 hidden actual 후보 정의가 canonical Benchmark builder와 다릅니다: ${context.slot.slot_id}`,
      );
    }
    return canonical;
  }
  const invocation = invocationFor(context);
  const benchmarkCandidateVersion = {
    A: "candidate-a-benchmark-v1",
    B: "candidate-b-benchmark-v2",
    C: "candidate-c-benchmark-v1",
  } as const;
  // executeBenchmarkCandidateSlot이 사용하는 런타임 계약은 identity·invocation·adapter입니다.
  // config 전체는 별도 regression config hash에 잠겨 팩에 기록됩니다.
  return {
    candidateId: context.selected_candidate_id,
    candidateVersion: context.candidate_version,
    config: {
      candidate_id: context.selected_candidate_id,
      candidate_version:
        benchmarkCandidateVersion[context.selected_candidate_id],
      architecture: context.selected_candidate_id === "A"
        ? "SINGLE_LLM_INLINE_POLICY"
        : context.selected_candidate_id === "B"
          ? "LLM_RUNNER_RETRIEVAL"
          : "READ_ONLY_TOOL_AGENT",
      model_requested_id: "gpt-5.6-terra",
      reasoning_effort: "low",
      max_output_tokens: 800,
      service_tier: "default",
      store: false,
      input_access: context.candidate_policy_access.delivery,
      case_identity_hash: sha256CanonicalJson(evaluationCase),
      policy_corpus_hash: context.candidate_policy_access.corpus_hash,
      execution_envelope: {
        max_input_tokens: 24_000,
        max_output_tokens: 800,
        max_automatic_retries: 1,
        timeout_ms: 30_000,
        max_provider_calls:
          context.selected_candidate_id === "C" ? 2 : 1,
        max_retrieval_calls:
          context.selected_candidate_id === "A" ? 0 : context.selected_candidate_id === "B" ? 1 : 2,
        max_tool_calls:
          context.selected_candidate_id === "C" ? 2 : 0,
      },
      output_schema: structuredClone(candidateOutputJsonSchema),
    },
    systemPrompt:
      BENCHMARK_CANDIDATE_SYSTEM_PROMPTS[context.selected_candidate_id],
    invocation,
    identity: {
      candidate_id: context.selected_candidate_id,
      candidate_version: context.candidate_version,
      candidate_config_hash: context.candidate_config_hash,
      system_prompt_hash: context.system_prompt_hash,
      invocation_hash: sha256CanonicalJson(invocation),
      case_identity_hash: sha256CanonicalJson(evaluationCase),
      policy_corpus_hash: context.candidate_policy_access.corpus_hash,
    },
    adapter,
  };
}

function policyDecisionPassed(
  output: CandidateOutput,
  oracle: EvaluationOracle,
): boolean {
  return output.decision.action_code === oracle.expected_action_code
    && !oracle.forbidden_action_codes.includes(output.decision.action_code);
}

function citationPassed(
  output: CandidateOutput,
  oracle: EvaluationOracle,
): boolean {
  return oracle.required_citations.every((required) => (
    output.citations.some((citation) => (
      citation.source_id === required.source_id
      && citation.section_id === required.section_id
    ))
  )) && output.citations.every((citation) => (
    oracle.allowed_citations.some((allowed) => (
      citation.source_id === allowed.source_id
      && citation.section_id === allowed.section_id
    ))
  ));
}

function escalationPassed(
  output: CandidateOutput,
  oracle: EvaluationOracle,
): boolean {
  return output.decision.escalation_required === oracle.escalation_required
    && output.decision.escalation_reason_code
      === oracle.escalation_reason_code
    && output.decision.target_queue === oracle.target_queue;
}

function regressionCandidateRequestIdentityHash(
  request: RegressionCandidateExecutionRequest,
): string {
  return sha256CanonicalJson({
    schema_version: "regression-candidate-request-identity-v1",
    slot: request.slot,
    slot_identity_hash: request.slot_identity_hash,
    candidate_version: request.candidate_version,
    candidate_input_hash: request.candidate_input_hash,
    candidate_config_hash: request.candidate_config_hash,
    policy_corpus_hash: request.candidate_policy_access.corpus_hash,
    system_prompt_hash: request.system_prompt_hash,
  });
}

function normalizeCandidateExecution(
  request: RegressionCandidateExecutionRequest,
  candidateExecution: BenchmarkSlotCandidateExecutionResult,
): RegressionCandidateExecution {
  const evaluationCase = caseFor(request.slot.case_id);
  const oracle = oracleFor(request.slot.case_id);
  const authoritativeOrder = authoritativeOrderFor(request.slot.case_id);
  const candidatePolicies = regressionPolicyCorpusForVersion(
    request.slot.version,
  );
  const slot = benchmarkSlotFor(request.slot);
  const run = candidateExecution.run;
  const output = run?.status === "COMPLETE" ? run.output ?? null : null;
  const terminalAttemptStatus = run?.attempts.at(-1)?.status ?? null;
  const commonRunnerFailure = (
    terminalAttemptStatus === "TRANSPORT_ERROR"
    || terminalAttemptStatus === "REQUEST_ERROR"
  );
  let evaluationStatus:
    | "EVALUATED"
    | "NOT_EVALUATED"
    | "EVALUATION_INCOMPLETE" = "NOT_EVALUATED";
  let hardGateFailures: string[] = [];
  if (
    candidateExecution.executionIntegrityError !== null
    || run === null
    || commonRunnerFailure
  ) {
    evaluationStatus = "EVALUATION_INCOMPLETE";
  } else if (
    output !== null
    && candidateExecution.completedExecutionEvidence !== null
    && candidateExecution.accessEvidence !== null
  ) {
    try {
      const evaluated = evaluateHardGates({
        candidateId: request.selected_candidate_id,
        slotId: slot.slot_id,
        repetition: 1,
        evaluationCase,
        oracle,
        // 평가는 잠긴 현행 정책, 접근 무결성은 후보가 실제로 본 v1/v2 정책에 결합합니다.
        policies: BENCHMARK_POLICIES,
        candidateAccessPolicies: candidatePolicies,
        authoritativeOrder,
        accessEvidence: candidateExecution.accessEvidence,
        output,
        executionEvidence:
          candidateExecution.completedExecutionEvidence,
      });
      evaluationStatus = "EVALUATED";
      hardGateFailures = evaluated.gates
        .filter((gate) => gate.status === "CONFIRMED_FAIL")
        .map((gate) => gate.gateCode);
    } catch {
      evaluationStatus = "EVALUATION_INCOMPLETE";
    }
  } else if (run.status === "COMPLETE") {
    evaluationStatus = "EVALUATION_INCOMPLETE";
  }
  const providerCalls = (run?.attempts ?? []).flatMap(
    (attempt) => attempt.executionEvidence?.providerCalls ?? [],
  );
  const retrievalCalls = (run?.attempts ?? []).flatMap(
    (attempt) => attempt.executionEvidence?.retrievalCalls ?? [],
  );
  const toolCalls = (run?.attempts ?? []).flatMap(
    (attempt) => attempt.executionEvidence?.toolCalls ?? [],
  );
  return deepFreeze({
    execution_status: candidateExecution.executionStatus,
    evaluation_status: evaluationStatus,
    request_disposition: candidateExecution.requestDisposition,
    cost_state: candidateExecution.costState,
    candidate_cost_usd:
      candidateExecution.usageCost?.totalCostUsd ?? null,
    total_latency_ms: candidateExecution.totalLatencyMs,
    output_hash: output === null
      ? sha256CanonicalJson({
        execution_status: candidateExecution.executionStatus,
        run,
      })
      : sha256CanonicalJson(output),
    candidate_output: output,
    provider_calls: providerCalls.map((call) => ({
      call_number: call.callNumber,
      response_id_hash: sha256CanonicalJson(call.responseId),
      status: call.status,
      usage_hash: sha256CanonicalJson(call.usage),
      latency_ms: call.latencyMs,
    })),
    retrieval_calls: structuredClone(retrievalCalls),
    tool_calls: structuredClone(toolCalls),
    access_evidence_hash:
      sha256CanonicalJson(candidateExecution.accessEvidence),
    deterministic_evaluation: {
      hard_gate_failures: hardGateFailures,
      policy_decision_passed:
        evaluationStatus === "EVALUATED"
        && output !== null
        && policyDecisionPassed(output, oracle),
      citation_passed:
        evaluationStatus === "EVALUATED"
        && output !== null
        && citationPassed(output, oracle),
      escalation_passed:
        evaluationStatus === "EVALUATED"
        && output !== null
        && escalationPassed(output, oracle),
    },
  });
}

function validateRuntimeCandidateReceipt(
  value: unknown,
  request: RegressionCandidateExecutionRequest,
): {
  readonly candidateExecution: BenchmarkSlotCandidateExecutionResult;
  readonly normalized: RegressionCandidateExecution;
} {
  if (
    typeof value !== "object"
    || value === null
    || !VALIDATED_CANDIDATE_EXECUTION_RECEIPTS.has(value)
    || !Object.isFrozen(value)
  ) {
    fail("회귀 후보 결과는 canonical executor가 발급한 동일 branded receipt여야 합니다.");
  }
  const receipt = value as ValidatedRegressionCandidateExecutionReceipt;
  if (
    receipt.schema_version !== "validated-regression-candidate-receipt-v1"
    || receipt.request_identity_hash
      !== regressionCandidateRequestIdentityHash(request)
  ) {
    fail("회귀 후보 receipt가 현재 request identity와 다릅니다.");
  }
  const candidateExecution = structuredClone(receipt.candidate_execution);
  return {
    candidateExecution,
    normalized: normalizeCandidateExecution(request, candidateExecution),
  };
}

export interface RegressionRuntimeClientLike
  extends OpenAIResponsesClientLike,
    BenchmarkCandidateBClientLike,
    BenchmarkCandidateCClientLike,
    BenchmarkSupportToolClientLike {}

export interface RegressionPreparedPolicyResources {
  readonly baseline: PreparedBenchmarkPolicyVectorStore;
  readonly proposed: PreparedBenchmarkPolicyVectorStore;
}

function assertRegressionPreparedStore(
  context: RegressionVersionContext,
  prepared: PreparedBenchmarkPolicyVectorStore,
): void {
  if (
    prepared.resourceIdentity.policy_corpus_sha256
      !== context.candidate_policy_access.corpus_hash
    || prepared.resourceIdentity.manifest_sha256
      !== prepared.manifestSha256
    || prepared.uploadedFileIds.length
      !== context.candidate_policy_access.sections.length
    || prepared.files.length
      !== context.candidate_policy_access.sections.length
  ) {
    fail(
      `회귀 adapter resource가 ${context.slot.version} corpus/manifest와 다릅니다.`,
    );
  }
}

function canaryGetOrderResult(
  context: RegressionVersionContext,
): {
  readonly ok: boolean;
  readonly result_code:
    | "OK"
    | "ORDER_OWNERSHIP_MISMATCH"
    | "TOOL_TIMEOUT"
    | "ORDER_RESULT_MISMATCH";
  readonly data: unknown | null;
} | undefined {
  if (!context.slot.case_id.startsWith("R-")) return undefined;
  const access = context.candidate_order_access as {
    readonly injected_result_code?:
      | "OK"
      | "ORDER_RESULT_MISMATCH"
      | "NOT_REQUIRED";
    readonly data?: unknown | null;
  };
  if (
    access.injected_result_code === undefined
    || access.injected_result_code === "NOT_REQUIRED"
  ) {
    return undefined;
  }
  return {
    ok: access.injected_result_code === "OK",
    result_code: access.injected_result_code,
    data: access.data ?? null,
  };
}

export function createRegressionRuntimeAdapterFactory({
  client,
  preparedPolicyResources,
  now = Date.now,
}: {
  readonly client: RegressionRuntimeClientLike;
  readonly preparedPolicyResources:
    RegressionPreparedPolicyResources | null;
  readonly now?: () => number;
}): (context: RegressionVersionContext) => CandidateAdapter {
  return (context) => {
    if (context.selected_candidate_id === "A") {
      return createCandidateAAdapter(client, { now });
    }
    if (preparedPolicyResources === null) {
      fail("Candidate B/C 회귀에는 v1/v2 prepared policy resource가 필요합니다.");
    }
    const prepared = context.slot.version === "BASELINE_V1"
      ? preparedPolicyResources.baseline
      : preparedPolicyResources.proposed;
    assertRegressionPreparedStore(context, prepared);
    const evaluationCase = caseFor(context.slot.case_id);
    const oracle = oracleFor(context.slot.case_id);
    const expectation = oracle.candidate_access_expectations.find(
      (item) => item.candidate_id === context.selected_candidate_id,
    ) ?? fail(`회귀 후보 접근 계약이 없습니다: ${context.slot.slot_id}`);
    if (context.selected_candidate_id === "B") {
      const requiredRetrieval =
        expectation.required_runner_retrieval_calls;
      if (requiredRetrieval !== 0 && requiredRetrieval !== 1) {
        fail(`Candidate B retrieval 상한이 0/1이 아닙니다: ${context.slot.slot_id}`);
      }
      return createBenchmarkCandidateBAdapter(client, {
        caseId: context.slot.case_id,
        vectorStoreId: prepared.vectorStoreId,
        manifest: prepared.files,
        evaluationCase,
        requiredRunnerRetrievalCalls: requiredRetrieval,
        expectedInvocationInput: invocationFor(context).input,
        now,
      });
    }
    const requiredTools = expectation.required_tool_calls.map(
      (item) => item.tool_name as BenchmarkSupportToolName,
    );
    const forbiddenTools = expectation.forbidden_tool_calls.map(
      (item) => item as BenchmarkSupportToolName,
    );
    const toolExecutor = createBenchmarkSupportToolExecutor(client, {
      caseId: context.slot.case_id,
      vectorStoreId: prepared.vectorStoreId,
      manifest: prepared.files,
      lockedAsOf: evaluationCase.as_of,
      maxNumResults: 6,
      evaluationCase,
      ...(canaryGetOrderResult(context)
        ? { getOrderResult: canaryGetOrderResult(context)! }
        : {}),
      now,
    });
    return createBenchmarkCandidateCAdapter(client, {
      caseId: context.slot.case_id,
      toolExecutor,
      evaluationCase,
      requiredToolCalls: requiredTools,
      forbiddenToolCalls: forbiddenTools,
      now,
    });
  };
}

export function createRegressionCandidateExecutor({
  adapterFor,
  now,
  signal,
}: CreateRegressionCandidateExecutorInput): RegressionRunnerDependencies["executeCandidate"] {
  return async (
    request,
  ): Promise<ValidatedRegressionCandidateExecutionReceipt> => {
    const evaluationCase = caseFor(request.slot.case_id);
    const oracle = oracleFor(request.slot.case_id);
    const authoritativeOrder = authoritativeOrderFor(request.slot.case_id);
    const candidatePolicies = regressionPolicyCorpusForVersion(
      request.slot.version,
    );
    const expectation = oracle.candidate_access_expectations.find(
      (item) => item.candidate_id === request.selected_candidate_id,
    );
    if (!expectation) {
      fail(`회귀 후보 접근 기대치가 없습니다: ${request.slot.slot_id}`);
    }
    const adapter = adapterFor(request);
    if (
      typeof adapter !== "object"
      || adapter === null
      || typeof adapter.invoke !== "function"
    ) {
      fail(`회귀 CandidateAdapter가 없습니다: ${request.slot.slot_id}`);
    }
    const slot = benchmarkSlotFor(request.slot);
    const definition = definitionFor(request, adapter);
    const candidateExecution = await executeBenchmarkCandidateSlot({
      slot,
      candidateDefinition: definition,
      evaluationCase,
      oracle,
      policies: candidatePolicies,
      authoritativeOrder,
      ...(now ? { now } : {}),
      ...(signal ? { signal } : {}),
    });
    const receipt = deepFreeze({
      schema_version:
        "validated-regression-candidate-receipt-v1" as const,
      request_identity_hash:
        regressionCandidateRequestIdentityHash(request),
      candidate_execution: structuredClone(candidateExecution),
    });
    VALIDATED_CANDIDATE_EXECUTION_RECEIPTS.add(receipt);
    return receipt;
  };
}

function validateSufficiency(
  sufficiency: RegressionSufficiencyContract,
): void {
  if (
    sufficiency.hidden_policy_minimum_correct !== 11
    || sufficiency.hidden_citation_required_cases !== 11
    || sufficiency.hidden_escalation_required_cases !== 4
  ) {
    fail("회귀 비비용 충분성 기준은 잠긴 11/11/4 절대 기준이어야 합니다.");
  }
  for (const [key, value] of Object.entries(sufficiency)) {
    if (
      key.endsWith("_maximum")
      && (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    ) {
      fail(`회귀 충분성 ${key}는 0 이상의 유한한 숫자여야 합니다.`);
    }
  }
}

function validateActiveBaseline(record: DecisionBaselineRecord): void {
  if (
    record.artifact_kind !== "DECISION_BASELINE_RECORD"
    || record.synthetic !== true
    || record.decision_status !== "HUMAN_CONFIRMED"
    || record.baseline_status !== "ACTIVE"
    || !/^baseline_v1_[a-f0-9]{64}$/.test(record.baseline_version)
    || record.selected_candidate_id
      !== record.selected_candidate_identity.candidate_id
    || record.selected_candidate_identity.candidate_slot_identity_hashes.length
      !== 24
    || record.selected_candidate_identity.candidate_config_hashes.length !== 12
  ) {
    fail("회귀 실행에는 선택 후보와 hash-linked identity를 가진 ACTIVE v1 baseline이 필요합니다.");
  }
}

function authorityFor(record: DecisionBaselineRecord): RegressionAuthorityChain {
  return deepFreeze({
    decision_baseline_record_hash: sha256CanonicalJson(record),
    recorded_benchmark_pack_hash: record.recorded_benchmark_pack_hash,
    human_confirmation_receipt_hash:
      record.human_confirmation_receipt_hash,
    final_decision_memo_hash: record.final_decision_memo_hash,
    final_decision_confirmation_receipt_hash:
      record.final_decision_confirmation_receipt_hash,
    locked_challenge_pack_hash: record.locked_challenge_pack_hash,
    aggregation_hash: record.aggregation_hash,
    baseline_version: record.baseline_version,
    selected_candidate_identity_hash:
      sha256CanonicalJson(record.selected_candidate_identity),
    deterministic_evaluator_contract_hash:
      record.evaluator_identities.deterministic_evaluator_contract_hash,
    evaluator_policy_manifest_hash:
      record.evaluator_identities.evaluator_policy_manifest_hash,
    judge_request_contract_hash:
      record.evaluator_identities.judge_request_contract_hash,
    judge_evidence_pack_hash:
      record.evaluator_identities.judge_evidence_pack_hash,
    pricing_snapshot_hash:
      record.selected_candidate_identity.pricing_snapshot_hash,
    runner_contract_hash:
      record.selected_candidate_identity.runner_contract_hash,
    evidence_contract_hash:
      record.selected_candidate_identity.evidence_contract_hash,
  });
}

function executionHashFor({
  authority,
  schedule,
  sufficiency,
  contexts,
}: {
  readonly authority: RegressionAuthorityChain;
  readonly schedule: RegressionSchedule;
  readonly sufficiency: RegressionSufficiencyContract;
  readonly contexts: readonly RegressionVersionContext[];
}): string {
  return sha256CanonicalJson({
    schema_version: "regression-execution-identity-v1",
    authority,
    schedule_id: schedule.schedule_id,
    sufficiency,
    contexts: contexts.map((context) => ({
      slot: context.slot,
      candidate_version: context.candidate_version,
      candidate_input_hash: context.candidate_input_hash,
      candidate_config_hash: context.candidate_config_hash,
      policy_corpus_hash: context.candidate_policy_access.corpus_hash,
      system_prompt_hash: context.system_prompt_hash,
    })),
  });
}

function executionRequestFor({
  context,
  executionHash,
  authority,
}: {
  readonly context: RegressionVersionContext;
  readonly executionHash: string;
  readonly authority: RegressionAuthorityChain;
}): RegressionCandidateExecutionRequest {
  return deepFreeze({
    ...context,
    slot_identity_hash: sha256CanonicalJson({
      schema_version: "regression-slot-identity-v1",
      execution_hash: executionHash,
      authority,
      slot: context.slot,
      candidate_input_hash: context.candidate_input_hash,
      candidate_config_hash: context.candidate_config_hash,
      policy_corpus_hash: context.candidate_policy_access.corpus_hash,
    }),
  });
}

function versionIdentities(
  record: DecisionBaselineRecord,
  contexts: readonly RegressionVersionContext[],
): {
  readonly baseline: RegressionVersionIdentity;
  readonly proposed: RegressionVersionIdentity;
} {
  const baselineContexts = contexts.filter(
    (context) => context.slot.version === "BASELINE_V1",
  );
  const proposedContexts = contexts.filter(
    (context) => context.slot.version === "PROPOSED_V2",
  );
  return deepFreeze({
    baseline: {
      version: "BASELINE_V1",
      candidate_version:
        record.selected_candidate_identity.candidate_version,
      candidate_configuration_set_hash: sha256CanonicalJson(
        record.selected_candidate_identity.candidate_config_hashes,
      ),
      policy_corpus_hash:
        baselineContexts[0].candidate_policy_access.corpus_hash,
      defect_profile: "NONE",
    },
    proposed: {
      version: "PROPOSED_V2",
      candidate_version:
        `candidate-${record.selected_candidate_id.toLowerCase()}-regression-v2`,
      candidate_configuration_set_hash: sha256CanonicalJson(
        proposedContexts.map((context) => context.candidate_config_hash),
      ),
      policy_corpus_hash:
        proposedContexts[0].candidate_policy_access.corpus_hash,
      defect_profile:
        "ACTIVE_RET_3_1_REMOVED_RETIRED_RET_3_3_EXPOSED",
    },
  });
}

function assertBaselineCandidateIdentityMatchesCanonicalContexts(
  record: DecisionBaselineRecord,
  contexts: readonly RegressionVersionContext[],
): void {
  const hiddenBaseline = contexts.filter((context) => (
    context.slot.version === "BASELINE_V1"
    && context.slot.dataset_split === "HIDDEN_BENCHMARK"
  ));
  const canonicalConfigHashes = hiddenBaseline.map(
    (context) => context.candidate_config_hash,
  );
  const identity = record.selected_candidate_identity;
  if (
    hiddenBaseline.length !== 12
    || identity.candidate_id !== record.selected_candidate_id
    || identity.candidate_version !== hiddenBaseline[0]?.candidate_version
    || identity.system_prompt_hash !== hiddenBaseline[0]?.system_prompt_hash
    || identity.output_schema_hash !== sha256CanonicalJson(candidateOutputJsonSchema)
    || canonicalJsonStringify(identity.candidate_config_hashes)
      !== canonicalJsonStringify(canonicalConfigHashes)
  ) {
    fail(
      "승인된 v1 hidden 후보 identity가 canonical Benchmark candidate definition과 다릅니다.",
    );
  }
}

type LedgerArtifactKind =
  | "REGRESSION_SLOT_INTENT"
  | "REGRESSION_SLOT_RECEIPT"
  | "REGRESSION_SLOT_CHECKPOINT";

interface RegressionLedgerBase {
  readonly schema_version: "regression-ledger-artifact-v1";
  readonly artifact_kind: LedgerArtifactKind;
  readonly execution_hash: string;
  readonly decision_baseline_record_hash: string;
  readonly schedule_id: string;
  readonly slot_identity_hash: string;
  readonly slot: RegressionScheduleSlot;
}

interface RegressionLedgerIntent extends RegressionLedgerBase {
  readonly artifact_kind: "REGRESSION_SLOT_INTENT";
}

interface RegressionLedgerReceipt extends RegressionLedgerBase {
  readonly artifact_kind: "REGRESSION_SLOT_RECEIPT";
  readonly intent_hash: string;
  readonly candidate_execution: BenchmarkSlotCandidateExecutionResult;
}

interface RegressionLedgerCheckpoint extends RegressionLedgerBase {
  readonly artifact_kind: "REGRESSION_SLOT_CHECKPOINT";
  readonly intent_hash: string;
  readonly receipt_hash: string;
  readonly slot_record: RegressionSlotRecord;
}

interface LedgerPaths {
  readonly directory: string;
  readonly slotsDirectory: string;
  readonly intent: string;
  readonly receipt: string;
  readonly checkpoint: string;
}

function ledgerPaths(
  outputDirectory: string,
  executionHash: string,
  slot: RegressionScheduleSlot,
): LedgerPaths {
  const directory = join(outputDirectory, `regression-ledger-${executionHash}`);
  const slotsDirectory = join(directory, "slots");
  const prefix = `${String(slot.sequence).padStart(3, "0")}--${slot.slot_id}`;
  return {
    directory,
    slotsDirectory,
    intent: join(slotsDirectory, `${prefix}--intent.json`),
    receipt: join(slotsDirectory, `${prefix}--receipt.json`),
    checkpoint: join(slotsDirectory, `${prefix}--checkpoint.json`),
  };
}

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertContained(parent: string, child: string): void {
  const path = relative(resolve(parent), resolve(child));
  if (
    path.length === 0
    || path === ".."
    || path.startsWith(`..${sep}`)
  ) {
    fail("회귀 ledger 경로가 output root를 벗어났습니다.");
  }
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const stat = await lstat(path);
  await realpath(path);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== 0o700
  ) {
    fail(`${label}는 symlink가 아닌 실제 0700 디렉터리여야 합니다.`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function prepareLedger(
  outputDirectory: string,
  executionHash: string,
): Promise<void> {
  const paths = ledgerPaths(
    outputDirectory,
    executionHash,
    buildRegressionSchedule("A")[0],
  );
  assertContained(outputDirectory, paths.directory);
  await assertDirectory(outputDirectory, "회귀 output root");
  for (const directory of [paths.directory, paths.slotsDirectory]) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    await assertDirectory(directory, "회귀 ledger");
  }
}

function wrapperBytes<T>(artifact: T): Buffer {
  return Buffer.from(`${canonicalJsonStringify({
    payload_sha256: sha256CanonicalJson(artifact),
    payload: artifact,
  })}\n`, "utf8");
}

async function readSecureArtifact<T>(
  path: string,
  label: string,
): Promise<T | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    fail(`${label}를 symlink 없이 열 수 없습니다.`, error);
  }
  try {
    const stat = await handle.stat();
    if (
      stat.isFile()
      && (stat.mode & 0o777) === 0o600
      && stat.nlink === 2
    ) {
      const parent = dirname(path);
      const temporaryPrefix = `.${basename(path)}.tmp-`;
      const matchingTemporarySiblings: string[] = [];
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (!entry.name.startsWith(temporaryPrefix)) continue;
        const siblingPath = join(parent, entry.name);
        const siblingStat = await lstat(siblingPath);
        if (
          entry.isFile()
          && !entry.isSymbolicLink()
          && siblingStat.isFile()
          && !siblingStat.isSymbolicLink()
          && (siblingStat.mode & 0o777) === 0o600
          && siblingStat.nlink === 2
          && siblingStat.dev === stat.dev
          && siblingStat.ino === stat.ino
        ) {
          matchingTemporarySiblings.push(siblingPath);
        }
      }
      if (matchingTemporarySiblings.length !== 1) {
        fail(`${label} nlink=2를 안전한 publish temp sibling으로 증명할 수 없습니다.`);
      }
      await handle.close();
      handle = undefined;
      await unlink(matchingTemporarySiblings[0]);
      await syncDirectory(parent);
      return readSecureArtifact<T>(path, label);
    }
    if (
      !stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== 1
    ) {
      fail(`${label}는 regular 0600 file이며 nlink=1이어야 합니다.`);
    }
    const bytes = await handle.readFile();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      fail(`${label} JSON이 tamper됐습니다.`, error);
    }
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(",") !== "payload,payload_sha256"
    ) {
      fail(`${label} wrapper shape이 tamper됐습니다.`);
    }
    const wrapper = parsed as {
      payload_sha256: unknown;
      payload: unknown;
    };
    if (
      typeof wrapper.payload_sha256 !== "string"
      || sha256CanonicalJson(wrapper.payload) !== wrapper.payload_sha256
      || !bytes.equals(wrapperBytes(wrapper.payload))
    ) {
      fail(`${label} hash 또는 canonical bytes가 tamper됐습니다.`);
    }
    return wrapper.payload as T;
  } finally {
    await handle?.close();
  }
}

async function persistExclusive(
  path: string,
  artifact: unknown,
): Promise<"CREATED" | "EXISTING"> {
  const bytes = wrapperBytes(artifact);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let temporaryExists = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const existing = await readSecureArtifact<unknown>(
        path,
        "기존 회귀 ledger artifact",
      );
      if (
        existing === null
        || canonicalJsonStringify(existing)
          !== canonicalJsonStringify(artifact)
      ) {
        fail("같은 회귀 ledger 경로의 기존 artifact가 tamper됐습니다.");
      }
      return "EXISTING";
    }
    await unlink(temporary);
    temporaryExists = false;
    await syncDirectory(dirname(path));
    const published = await readSecureArtifact<unknown>(
      path,
      "공개된 회귀 ledger artifact",
    );
    if (
      published === null
      || canonicalJsonStringify(published) !== canonicalJsonStringify(artifact)
    ) {
      fail("공개된 회귀 ledger artifact bytes가 다릅니다.");
    }
    return "CREATED";
  } finally {
    if (temporaryExists) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) {
          fail("회귀 ledger 임시 artifact를 정리할 수 없습니다.", error);
        }
      }
      await syncDirectory(dirname(path));
    }
  }
}

function assertLedgerBase(
  artifact: RegressionLedgerBase,
  expected: RegressionLedgerBase,
  expectedKind: LedgerArtifactKind,
): void {
  const commonKeys = [
    "artifact_kind",
    "decision_baseline_record_hash",
    "execution_hash",
    "schedule_id",
    "schema_version",
    "slot",
    "slot_identity_hash",
  ];
  const kindKeys = expectedKind === "REGRESSION_SLOT_INTENT"
    ? commonKeys
    : expectedKind === "REGRESSION_SLOT_RECEIPT"
      ? [...commonKeys, "candidate_execution", "intent_hash"]
      : [...commonKeys, "intent_hash", "receipt_hash", "slot_record"];
  const actualKeys = Object.keys(artifact).sort();
  const expectedKeys = kindKeys.sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || artifact.artifact_kind !== expectedKind
  ) {
    fail(`회귀 ledger ${expectedKind} exact kind/key 계약이 다릅니다.`);
  }
  for (const key of [
    "schema_version",
    "execution_hash",
    "decision_baseline_record_hash",
    "schedule_id",
    "slot_identity_hash",
  ] as const) {
    if (artifact[key] !== expected[key]) {
      fail(`회귀 ledger ${key}가 현재 authority/schedule과 다릅니다.`);
    }
  }
  if (
    canonicalJsonStringify(artifact.slot)
    !== canonicalJsonStringify(expected.slot)
  ) {
    fail("회귀 ledger slot 좌표가 현재 schedule과 다릅니다.");
  }
}

function assertRawCandidateExecutionContract(
  value: BenchmarkSlotCandidateExecutionResult,
  request: RegressionCandidateExecutionRequest,
): void {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    fail("회귀 candidate_execution은 plain terminal receipt 객체여야 합니다.");
  }
  const expectedKeys = [
    "accessEvidence",
    "completedExecutionEvidence",
    "costState",
    "executionIntegrityError",
    "executionStatus",
    "requestDisposition",
    "run",
    "slot",
    "totalLatencyMs",
    "usageCost",
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || canonicalJsonStringify(value.slot)
      !== canonicalJsonStringify(benchmarkSlotFor(request.slot))
    || !["COMPLETE", "INVALID", "TIMEOUT", "BUDGET_EXCEEDED", "FAILED"]
      .includes(value.executionStatus)
    || !["NOT_SENT", "SENT_RESPONSE_RECORDED", "SENT_OUTCOME_UNKNOWN"]
      .includes(value.requestDisposition)
    || !["COMPLETE", "COST_INCOMPLETE"].includes(value.costState)
    || !Number.isFinite(value.totalLatencyMs)
    || value.totalLatencyMs < 0
  ) {
    fail("회귀 candidate_execution terminal identity/status 계약이 다릅니다.");
  }
  if (
    (value.costState === "COST_INCOMPLETE" && value.usageCost !== null)
    || (
      value.usageCost !== null
      && (
        !Number.isFinite(value.usageCost.totalCostUsd)
        || value.usageCost.totalCostUsd < 0
      )
    )
    || (
      value.executionStatus === "COMPLETE"
      && (
        value.run?.status !== "COMPLETE"
        || value.run.output === undefined
        || value.requestDisposition !== "SENT_RESPONSE_RECORDED"
        || value.costState !== "COMPLETE"
        || value.usageCost === null
      )
    )
  ) {
    fail("회귀 candidate_execution status/cost/provider 계약이 모순됩니다.");
  }
  if (value.run !== null) {
    const run = value.run;
    const runKeys = Object.keys(run).sort();
    const expectedRunKeys = [
      "attempts",
      ...(run.output === undefined ? [] : ["output"]),
      "runNumber",
      "status",
      "totalLatencyMs",
    ].sort();
    if (
      runKeys.length !== expectedRunKeys.length
      || runKeys.some((key, index) => key !== expectedRunKeys[index])
      || run.runNumber !== 1
      || !["COMPLETE", "INVALID", "TIMEOUT", "BUDGET_EXCEEDED"]
        .includes(run.status)
      || !Number.isFinite(run.totalLatencyMs)
      || run.totalLatencyMs < 0
      || run.totalLatencyMs !== value.totalLatencyMs
      || !Array.isArray(run.attempts)
      || run.attempts.length < 1
      || run.attempts.length > 2
    ) {
      fail("회귀 candidate run exact key/terminal 계약이 다릅니다.");
    }
    const allowedAttemptKeys = new Set([
      "attemptNumber",
      "status",
      "startedAt",
      "latencyMs",
      "responseId",
      "modelReportedId",
      "serviceTierReported",
      "usage",
      "executionEvidence",
      "error",
    ]);
    const allowedAttemptStatuses = new Set([
      "COMPLETE",
      "INVALID_OUTPUT",
      "TRANSPORT_ERROR",
      "REQUEST_ERROR",
      "TIMEOUT",
      "BUDGET_EXCEEDED",
      "INCOMPLETE",
      "FAILED",
      "REFUSED",
    ]);
    for (const [index, attempt] of run.attempts.entries()) {
      if (
        Object.keys(attempt).some((key) => !allowedAttemptKeys.has(key))
        || attempt.attemptNumber !== index + 1
        || !allowedAttemptStatuses.has(attempt.status)
        || !Number.isFinite(Date.parse(attempt.startedAt))
        || new Date(attempt.startedAt).toISOString() !== attempt.startedAt
        || !Number.isFinite(attempt.latencyMs)
        || attempt.latencyMs < 0
      ) {
        fail("회귀 candidate attempt 순서·exact key·상태 계약이 다릅니다.");
      }
      const calls = attempt.executionEvidence?.providerCalls ?? [];
      for (const [callIndex, call] of calls.entries()) {
        if (
          call.callNumber !== callIndex + 1
          || !["completed", "incomplete", "failed", "refused"]
            .includes(call.status)
          || !Number.isFinite(call.latencyMs)
          || call.latencyMs < 0
        ) {
          fail("회귀 provider call 순서·상태·latency 계약이 다릅니다.");
        }
      }
    }
    const completeAttemptIndexes = run.attempts.flatMap(
      (attempt, index) => attempt.status === "COMPLETE" ? [index] : [],
    );
    if (
      run.status === "COMPLETE"
        ? (
          completeAttemptIndexes.length !== 1
          || completeAttemptIndexes[0] !== run.attempts.length - 1
          || run.output === undefined
        )
        : completeAttemptIndexes.length !== 0 || run.output !== undefined
    ) {
      fail("회귀 candidate run과 attempt terminal 순서가 모순됩니다.");
    }
    const usageLedger = inspectProviderUsageLedger(
      run.attempts.map((attempt) => {
        const providerOnlyEvidence: CandidateExecutionEvidence | undefined =
          attempt.executionEvidence === undefined
            ? undefined
            : {
              providerCalls: structuredClone(
                attempt.executionEvidence.providerCalls,
              ),
              // 비용 원장은 provider call만 사용합니다. 회귀 영수증의 검색 자원
              // 식별자는 의도적으로 해시 처리되어 원본 retrieval 타입과 다릅니다.
              retrievalCalls: [],
              toolCalls: [],
            };
        return {
          status: attempt.status,
          ...(attempt.responseId === undefined
            ? {}
            : { responseId: attempt.responseId }),
          ...(attempt.usage === undefined ? {} : { usage: attempt.usage }),
          ...(providerOnlyEvidence === undefined
            ? {}
            : { executionEvidence: providerOnlyEvidence }),
        };
      }),
    );
    if (usageLedger.state === "INTEGRITY_ERROR") {
      fail(
        `회귀 provider usage ledger가 모순됩니다: ${usageLedger.issue ?? "unknown"}`,
      );
    }
  }
  const providerCalls = (value.run?.attempts ?? []).flatMap(
    (attempt) => attempt.executionEvidence?.providerCalls ?? [],
  );
  if (
    value.executionStatus === "COMPLETE"
    && providerCalls.length === 0
  ) {
    fail("COMPLETE 회귀 candidate_execution에는 provider call 증거가 필요합니다.");
  }
}

function validateExecution(execution: RegressionCandidateExecution): void {
  if (
    ![
      "COMPLETE",
      "INVALID",
      "TIMEOUT",
      "BUDGET_EXCEEDED",
      "FAILED",
    ].includes(execution.execution_status)
    || !["EVALUATED", "NOT_EVALUATED", "EVALUATION_INCOMPLETE"].includes(
      execution.evaluation_status,
    )
    || !Number.isFinite(execution.total_latency_ms)
    || execution.total_latency_ms < 0
    || !SHA256.test(execution.output_hash)
    || !SHA256.test(execution.access_evidence_hash)
  ) {
    fail("후보 회귀 실행 결과가 잠긴 terminal/evidence 계약과 다릅니다.");
  }
  if (
    execution.candidate_cost_usd !== null
    && (
      !Number.isFinite(execution.candidate_cost_usd)
      || execution.candidate_cost_usd < 0
    )
  ) {
    fail("후보 회귀 비용은 null 또는 0 이상의 유한한 숫자여야 합니다.");
  }
  if (
    execution.evaluation_status === "EVALUATED"
    && execution.execution_status !== "COMPLETE"
  ) {
    fail("평가 완료 상태에는 완료된 후보 회귀 실행이 필요합니다.");
  }
  if (
    execution.execution_status === "COMPLETE"
    && execution.evaluation_status === "NOT_EVALUATED"
  ) {
    fail("완료된 후보 회귀 실행은 평가 완료 또는 평가 불완전이어야 합니다.");
  }
  if (execution.execution_status === "COMPLETE") {
    if (execution.candidate_output === null) {
      fail("완료된 후보 회귀 실행에는 구조화 candidate output이 필요합니다.");
    }
    try {
      parseCandidateOutput(execution.candidate_output);
    } catch (error) {
      fail("후보 회귀 candidate output이 잠긴 구조화 스키마와 다릅니다.", error);
    }
    if (sha256CanonicalJson(execution.candidate_output) !== execution.output_hash) {
      fail("후보 회귀 candidate output hash가 원시 출력과 다릅니다.");
    }
  } else if (execution.candidate_output !== null) {
    fail("미완료 후보 회귀 실행에는 candidate output이 있을 수 없습니다.");
  }
  if (
    execution.evaluation_status !== "EVALUATED"
    && (
      execution.deterministic_evaluation.hard_gate_failures.length > 0
      || execution.deterministic_evaluation.policy_decision_passed
      || execution.deterministic_evaluation.citation_passed
      || execution.deterministic_evaluation.escalation_passed
    )
  ) {
    fail("평가 불완전·미평가 실행에는 결정적 평가 결과가 있을 수 없습니다.");
  }
}

function slotRecordFor(
  request: RegressionCandidateExecutionRequest,
  execution: RegressionCandidateExecution,
): RegressionSlotRecord {
  return deepFreeze({
    schema_version: "regression-slot-record-v1",
    slot: request.slot,
    slot_identity_hash: request.slot_identity_hash,
    candidate_config_hash: request.candidate_config_hash,
    candidate_input_hash: request.candidate_input_hash,
    policy_corpus_hash: request.candidate_policy_access.corpus_hash,
    raw_execution_evidence: {
      execution_status: execution.execution_status,
      evaluation_status: execution.evaluation_status,
      request_disposition: execution.request_disposition,
      cost_state: execution.cost_state,
      candidate_cost_usd: execution.candidate_cost_usd,
      total_latency_ms: execution.total_latency_ms,
      output_hash: execution.output_hash,
      candidate_output: execution.candidate_output,
      provider_calls: structuredClone(execution.provider_calls),
      retrieval_calls: structuredClone(execution.retrieval_calls),
      tool_calls: structuredClone(execution.tool_calls),
      access_evidence_hash: execution.access_evidence_hash,
    },
    deterministic_evaluation:
      structuredClone(execution.deterministic_evaluation),
  });
}

async function loadOrExecuteSlot({
  outputDirectory,
  executionHash,
  scheduleId,
  authority,
  request,
  record,
  dependencies,
}: {
  readonly outputDirectory: string;
  readonly executionHash: string;
  readonly scheduleId: string;
  readonly authority: RegressionAuthorityChain;
  readonly request: RegressionCandidateExecutionRequest;
  readonly record: DecisionBaselineRecord;
  readonly dependencies: RegressionRunnerDependencies;
}): Promise<{ record: RegressionSlotRecord; reused: boolean }> {
  const paths = ledgerPaths(outputDirectory, executionHash, request.slot);
  const base: RegressionLedgerBase = {
    schema_version: "regression-ledger-artifact-v1",
    artifact_kind: "REGRESSION_SLOT_INTENT",
    execution_hash: executionHash,
    decision_baseline_record_hash:
      authority.decision_baseline_record_hash,
    schedule_id: scheduleId,
    slot_identity_hash: request.slot_identity_hash,
    slot: request.slot,
  };
  const intent = await readSecureArtifact<RegressionLedgerIntent>(
    paths.intent,
    "회귀 intent",
  );
  const receipt = await readSecureArtifact<RegressionLedgerReceipt>(
    paths.receipt,
    "회귀 receipt",
  );
  const checkpoint = await readSecureArtifact<RegressionLedgerCheckpoint>(
    paths.checkpoint,
    "회귀 checkpoint",
  );
  if (checkpoint !== null) {
    if (intent === null || receipt === null) {
      fail("회귀 checkpoint 앞의 intent/receipt가 누락됐습니다.");
    }
    assertLedgerBase(intent, base, "REGRESSION_SLOT_INTENT");
    assertLedgerBase(receipt, base, "REGRESSION_SLOT_RECEIPT");
    assertLedgerBase(checkpoint, base, "REGRESSION_SLOT_CHECKPOINT");
    if (
      checkpoint.intent_hash !== sha256CanonicalJson(intent)
      || checkpoint.receipt_hash !== sha256CanonicalJson(receipt)
    ) {
      fail("회귀 checkpoint hash chain이 tamper됐습니다.");
    }
    assertRawCandidateExecutionContract(
      receipt.candidate_execution,
      request,
    );
    const normalized = normalizeCandidateExecution(
      request,
      receipt.candidate_execution,
    );
    validateExecution(normalized);
    const expectedSlotRecord = slotRecordFor(
      request,
      normalized,
    );
    if (
      canonicalJsonStringify(checkpoint.slot_record)
      !== canonicalJsonStringify(expectedSlotRecord)
    ) {
      fail("회귀 checkpoint slot record가 receipt 재계산 결과와 다릅니다.");
    }
    return { record: expectedSlotRecord, reused: true };
  }
  if (intent !== null && receipt === null) {
    assertLedgerBase(intent, base, "REGRESSION_SLOT_INTENT");
    throw new RegressionAmbiguousInFlightError(request.slot.slot_id);
  }
  if (intent === null && receipt !== null) {
    fail("회귀 receipt-only 상태에는 선행 intent가 없습니다.");
  }
  if (intent !== null && receipt !== null) {
    assertLedgerBase(intent, base, "REGRESSION_SLOT_INTENT");
    assertLedgerBase(receipt, base, "REGRESSION_SLOT_RECEIPT");
    if (receipt.intent_hash !== sha256CanonicalJson(intent)) {
      fail("회귀 receipt가 intent hash와 다릅니다.");
    }
    assertRawCandidateExecutionContract(
      receipt.candidate_execution,
      request,
    );
    const normalized = normalizeCandidateExecution(
      request,
      receipt.candidate_execution,
    );
    validateExecution(normalized);
    const slotRecord = slotRecordFor(request, normalized);
    const recoveredCheckpoint: RegressionLedgerCheckpoint = {
      ...base,
      artifact_kind: "REGRESSION_SLOT_CHECKPOINT",
      intent_hash: sha256CanonicalJson(intent),
      receipt_hash: sha256CanonicalJson(receipt),
      slot_record: slotRecord,
    };
    await persistExclusive(paths.checkpoint, recoveredCheckpoint);
    return { record: slotRecord, reused: true };
  }

  const newIntent: RegressionLedgerIntent = {
    ...base,
    artifact_kind: "REGRESSION_SLOT_INTENT",
  };
  const intentState = await persistExclusive(paths.intent, newIntent);
  if (intentState === "EXISTING") {
    throw new RegressionAmbiguousInFlightError(request.slot.slot_id);
  }
  const runtimeReceipt = await dependencies.executeCandidate(request);
  const validatedRuntime = validateRuntimeCandidateReceipt(
    runtimeReceipt,
    request,
  );
  assertRawCandidateExecutionContract(
    validatedRuntime.candidateExecution,
    request,
  );
  const execution = validatedRuntime.normalized;
  validateExecution(execution);
  const newReceipt: RegressionLedgerReceipt = {
    ...base,
    artifact_kind: "REGRESSION_SLOT_RECEIPT",
    intent_hash: sha256CanonicalJson(newIntent),
    candidate_execution: deepFreeze(
      structuredClone(validatedRuntime.candidateExecution),
    ),
  };
  if (dependencies.persistReceipt) {
    await dependencies.persistReceipt({
      path: paths.receipt,
      artifact: newReceipt,
    });
  } else {
    await persistExclusive(paths.receipt, newReceipt);
  }
  const persistedReceipt = await readSecureArtifact<RegressionLedgerReceipt>(
    paths.receipt,
    "저장된 회귀 receipt",
  );
  if (
    persistedReceipt === null
    || canonicalJsonStringify(persistedReceipt)
      !== canonicalJsonStringify(newReceipt)
  ) {
    fail(
      "회귀 receipt persistence가 현재 실행의 canonical source receipt를 남기지 않았습니다.",
    );
  }
  const slotRecord = slotRecordFor(request, execution);
  const newCheckpoint: RegressionLedgerCheckpoint = {
    ...base,
    artifact_kind: "REGRESSION_SLOT_CHECKPOINT",
    intent_hash: sha256CanonicalJson(newIntent),
    receipt_hash: sha256CanonicalJson(newReceipt),
    slot_record: slotRecord,
  };
  await persistExclusive(paths.checkpoint, newCheckpoint);
  return { record: slotRecord, reused: false };
}

async function loadCompletedSlotFromLedger({
  outputDirectory,
  executionHash,
  scheduleId,
  authority,
  request,
  record,
}: {
  readonly outputDirectory: string;
  readonly executionHash: string;
  readonly scheduleId: string;
  readonly authority: RegressionAuthorityChain;
  readonly request: RegressionCandidateExecutionRequest;
  readonly record: DecisionBaselineRecord;
}): Promise<RegressionSlotRecord> {
  const paths = ledgerPaths(outputDirectory, executionHash, request.slot);
  const base: RegressionLedgerBase = {
    schema_version: "regression-ledger-artifact-v1",
    artifact_kind: "REGRESSION_SLOT_INTENT",
    execution_hash: executionHash,
    decision_baseline_record_hash:
      authority.decision_baseline_record_hash,
    schedule_id: scheduleId,
    slot_identity_hash: request.slot_identity_hash,
    slot: request.slot,
  };
  const [intent, receipt, checkpoint] = await Promise.all([
    readSecureArtifact<RegressionLedgerIntent>(
      paths.intent,
      "회귀 source intent",
    ),
    readSecureArtifact<RegressionLedgerReceipt>(
      paths.receipt,
      "회귀 source receipt",
    ),
    readSecureArtifact<RegressionLedgerCheckpoint>(
      paths.checkpoint,
      "회귀 source checkpoint",
    ),
  ]);
  if (intent === null || receipt === null || checkpoint === null) {
    fail(
      `기록 회귀 source에는 exact 36 intent/receipt/checkpoint가 모두 필요합니다: ${request.slot.slot_id}`,
    );
  }
  assertLedgerBase(intent, base, "REGRESSION_SLOT_INTENT");
  assertLedgerBase(receipt, base, "REGRESSION_SLOT_RECEIPT");
  assertLedgerBase(checkpoint, base, "REGRESSION_SLOT_CHECKPOINT");
  if (
    receipt.intent_hash !== sha256CanonicalJson(intent)
    || checkpoint.intent_hash !== sha256CanonicalJson(intent)
    || checkpoint.receipt_hash !== sha256CanonicalJson(receipt)
  ) {
    fail(`회귀 source hash chain이 다릅니다: ${request.slot.slot_id}`);
  }
  assertRawCandidateExecutionContract(
    receipt.candidate_execution,
    request,
  );
  const normalized = normalizeCandidateExecution(
    request,
    receipt.candidate_execution,
  );
  validateExecution(normalized);
  const expectedSlotRecord = slotRecordFor(
    request,
    normalized,
  );
  if (
    canonicalJsonStringify(checkpoint.slot_record)
    !== canonicalJsonStringify(expectedSlotRecord)
  ) {
    fail(
      `회귀 source checkpoint가 receipt 재계산 결과와 다릅니다: ${request.slot.slot_id}`,
    );
  }
  return expectedSlotRecord;
}

export async function runRecordedRegression({
  outputDirectory,
  decisionBaselineRecord,
  sufficiency,
  dependencies,
  createdAt = new Date().toISOString(),
}: RunRecordedRegressionOptions): Promise<RunRecordedRegressionResult> {
  // 주입 validator와 무관하게 production authority validator를 직접 통과해야 합니다.
  assertAuthoritativeDecisionBaselineRecord(decisionBaselineRecord);
  // 이 추가 validator가 성공하기 전에도 client/resource/adapter callback을 호출하지 않습니다.
  const assertBaselineRecord: RegressionRunnerDependencies["assertBaselineRecord"] =
    dependencies.assertBaselineRecord;
  assertBaselineRecord(decisionBaselineRecord);
  validateActiveBaseline(decisionBaselineRecord);
  validateSufficiency(sufficiency);
  const selectedCandidateId = decisionBaselineRecord.selected_candidate_id;
  const authority = authorityFor(decisionBaselineRecord);
  const resourceAuthorityBinding =
    buildRegressionResourceAuthorityBinding(decisionBaselineRecord);
  const schedule = buildRegressionSchedule(selectedCandidateId);
  const contexts = buildRegressionVersionContexts(selectedCandidateId);
  assertBaselineCandidateIdentityMatchesCanonicalContexts(
    decisionBaselineRecord,
    contexts,
  );
  const executionHash = executionHashFor({
    authority,
    schedule,
    sufficiency,
    contexts,
  });
  await prepareLedger(outputDirectory, executionHash);
  const slotRecords: RegressionSlotRecord[] = [];
  let executedSlots = 0;
  let reusedSlots = 0;
  for (const context of contexts) {
    const request = executionRequestFor({
      context,
      executionHash,
      authority,
    });
    const result = await loadOrExecuteSlot({
      outputDirectory,
      executionHash,
      scheduleId: schedule.schedule_id,
      authority,
      request,
      record: decisionBaselineRecord,
      dependencies,
    });
    slotRecords.push(result.record);
    if (result.reused) reusedSlots += 1;
    else executedSlots += 1;
    await dependencies.afterCheckpoint?.({
      completed: slotRecords.length,
      slot: context.slot,
    });
  }
  const resourceCleanup = await dependencies.resourceEvidence({
    selectedCandidateId,
    contexts,
    authorityBinding: resourceAuthorityBinding,
  });
  assertValidatedResourceCleanup(
    resourceCleanup,
    selectedCandidateId,
    resourceAuthorityBinding,
  );
  const versions = versionIdentities(decisionBaselineRecord, contexts);
  const packSource = {
    authority,
    selectedCandidateId,
    slots: slotRecords,
    sufficiency,
    datasetHashes: {
      hidden_dataset_hash: BENCHMARK_DATASET_HASH,
      regression_canary_hash: REGRESSION_CANARY_HASH,
    },
    versionIdentities: versions,
    resources: resourceCleanup.evidence,
    createdAt,
  } as const;
  const pack = buildRecordedRegressionPack(packSource);
  const persisted = await persistRecordedRegressionPack({
    outputDirectory,
    pack,
  });
  const reloadedPack = await loadRecordedRegressionPackFromSources({
    path: persisted.path,
    source: packSource,
  });
  return Object.freeze({
    pack: reloadedPack,
    path: persisted.path,
    payloadSha256: persisted.payloadSha256,
    executedSlots,
    reusedSlots,
  });
}

/**
 * 디스크의 기록 회귀 팩을 직접 신뢰하지 않습니다.
 * 권위 있는 ACTIVE 결정 기준선, 검증된 remote cleanup 승인, exact 36개
 * intent/receipt/checkpoint에서 source를 재구성한 뒤 canonical pack bytes와 비교합니다.
 */
export async function loadRecordedRegressionFromAuthority({
  outputDirectory,
  path,
  decisionBaselineRecord,
  sufficiency,
  resourceCleanup,
  createdAt,
  assertBaselineRecord =
    DEFAULT_REGRESSION_BASELINE_ASSERTION,
}: LoadRecordedRegressionFromAuthorityOptions): Promise<RecordedRegressionPack> {
  assertAuthoritativeDecisionBaselineRecord(decisionBaselineRecord);
  const assertAuthority: RegressionRunnerDependencies["assertBaselineRecord"] =
    assertBaselineRecord;
  assertAuthority(decisionBaselineRecord);
  validateActiveBaseline(decisionBaselineRecord);
  validateSufficiency(sufficiency);
  const selectedCandidateId = decisionBaselineRecord.selected_candidate_id;
  const resourceAuthorityBinding =
    buildRegressionResourceAuthorityBinding(decisionBaselineRecord);
  assertValidatedResourceCleanup(
    resourceCleanup,
    selectedCandidateId,
    resourceAuthorityBinding,
  );
  const authority = authorityFor(decisionBaselineRecord);
  const schedule = buildRegressionSchedule(selectedCandidateId);
  const contexts = buildRegressionVersionContexts(selectedCandidateId);
  assertBaselineCandidateIdentityMatchesCanonicalContexts(
    decisionBaselineRecord,
    contexts,
  );
  const executionHash = executionHashFor({
    authority,
    schedule,
    sufficiency,
    contexts,
  });
  const firstPaths = ledgerPaths(outputDirectory, executionHash, schedule[0]);
  await assertDirectory(outputDirectory, "회귀 output root");
  await assertDirectory(firstPaths.directory, "회귀 source ledger");
  await assertDirectory(firstPaths.slotsDirectory, "회귀 source slot ledger");
  const slots: RegressionSlotRecord[] = [];
  for (const context of contexts) {
    const request = executionRequestFor({
      context,
      executionHash,
      authority,
    });
    slots.push(await loadCompletedSlotFromLedger({
      outputDirectory,
      executionHash,
      scheduleId: schedule.schedule_id,
      authority,
      request,
      record: decisionBaselineRecord,
    }));
  }
  return loadRecordedRegressionPackFromSources({
    path,
    source: {
      authority,
      selectedCandidateId,
      slots,
      sufficiency,
      datasetHashes: {
        hidden_dataset_hash: BENCHMARK_DATASET_HASH,
        regression_canary_hash: REGRESSION_CANARY_HASH,
      },
      versionIdentities: versionIdentities(
        decisionBaselineRecord,
        contexts,
      ),
      resources: resourceCleanup.evidence,
      createdAt,
    },
  });
}

export const DEFAULT_REGRESSION_BASELINE_ASSERTION =
  assertAuthoritativeDecisionBaselineRecord;

// 명세상 hidden/canary oracle는 Candidate callback에 전달하지 않고 실행기 내부에만 둡니다.
export const REGRESSION_EVALUATOR_CASE_IDS = deepFreeze({
  hidden: BENCHMARK_ORACLES.map((item) => item.case_id),
  canary: REGRESSION_CANARY_ORACLES.map((item) => item.case_id),
});

// 현재 선택 후보의 v1 hidden config는 승인 기준선의 exact hash를 사용합니다.
export const REGRESSION_HIDDEN_ORDER_IDS = deepFreeze(
  BENCHMARK_ORDERS.map((item) => item.order_id),
);

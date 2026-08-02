import { candidateOutputJsonSchema } from "../contracts/candidateOutput";
import type { EvaluationCase, EvaluationOracle, EvaluationOrder } from "../contracts/evaluationCase";
import {
  buildPolicyManifestHash,
  buildRunnerCandidateInputHash,
  type RunnerInputAccessEvidence,
} from "../contracts/runnerInputAccessEvidence";
import {
  BENCHMARK_CASES,
  BENCHMARK_CHALLENGE,
  BENCHMARK_DATASET_HASH,
  BENCHMARK_ORDERS,
  BENCHMARK_ORACLE_HASH,
  BENCHMARK_ORACLES,
  BENCHMARK_POLICIES,
} from "../data/benchmark/index";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import {
  DEFAULT_PRICING_SNAPSHOT,
  type PricingSnapshot,
} from "../runtime/pricing";
import { BENCHMARK_EVALUATOR_CONTRACT_HASH } from "../deterministic/hardGates";
import {
  assertAuthoritativeLockedChallengePack,
  buildLockedChallengeBenchmarkBinding,
  type LockedChallengePack,
} from "../define/defineContracts";
import {
  assertCanonicalLifecycleDirectory,
  persistCanonicalLifecycleFile,
  readCanonicalLifecycleFile,
} from "../lifecycle/canonicalLifecyclePersistence";
import type { BenchmarkCandidateDefinition } from "./candidateDefinitions";
import {
  buildBenchmarkPolicyCorpusContract,
} from "./policyVectorStore";
import type { BenchmarkScheduleSlot } from "./schedule";
import { basename, join, resolve } from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const authoritativeBenchmarkExecutionIdentities = new WeakSet<object>();
const EXECUTION_IDENTITY_KEYS = [
  "candidate_policy_corpus_hash",
  "challenge_hash",
  "dataset_hash",
  "evaluator_policy_corpus_hash",
  "evaluator_contract_hash",
  "evaluator_policy_manifest_hash",
  "evidence_contract_hash",
  "execution_hash",
  "hidden_execution_data_hash",
  "locked_challenge_contract_hash",
  "locked_challenge_pack_hash",
  "locked_challenge_source_manifest_hash",
  "oracle_hash",
  "orders_hash",
  "output_schema_hash",
  "policy_manifest_hash",
  "policy_resource_identity_hash",
  "policy_vector_store_id_hash",
  "pricing_snapshot_hash",
  "runner_contract_hash",
  "schedule_id",
  "schema_version",
] as const;
const SLOT_IDENTITY_KEYS = [
  "authoritative_order_hash",
  "candidate_config_hash",
  "candidate_id",
  "candidate_input_hash",
  "candidate_position",
  "case_hash",
  "case_id",
  "evaluator_contract_hash",
  "evaluator_policy_manifest_hash",
  "execution_envelope_hash",
  "execution_hash",
  "input_access_hash",
  "invocation_hash",
  "invocation_input_hash",
  "oracle_hash",
  "output_schema_hash",
  "policy_manifest_hash",
  "policy_resource_identity_hash",
  "policy_vector_store_id_hash",
  "pricing_snapshot_hash",
  "repetition",
  "schedule_id",
  "schema_version",
  "sequence",
  "slot_id",
  "slot_identity_hash",
  "system_prompt_hash",
] as const;

const EXECUTION_IDENTITY_AUTHORITY_DIRECTORY =
  "benchmark-execution-identity-authority";
const EXECUTION_IDENTITY_AUTHORITY_FILE =
  /^benchmark-execution-identity--([a-f0-9]{64})\.json$/;

type JsonRecord = Record<string, unknown>;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label}은(는) 64자리 소문자 SHA-256 hash여야 합니다.`);
  }
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0")
    === [...keys].sort().join("\0");
}

export const BENCHMARK_RUNNER_CONTRACT = deepFreeze({
  schema_version: "benchmark-runner-contract-v1",
  repetitions: [1, 2],
  maximum_attempts_per_run: 2,
  retry_policy: "ONE_RETRY_FOR_INVALID_OR_EXPLICITLY_RETRYABLE_TRANSPORT",
  usage_accounting: "ALL_ATTEMPTS_EXACTLY_ONCE",
  gate_input: "FINAL_COMPLETE_ATTEMPT_ONLY",
  integrity_error_disposition: "EVALUATION_INCOMPLETE",
});

export const BENCHMARK_EVIDENCE_CONTRACT = deepFreeze({
  schema_version: "benchmark-execution-evidence-contract-v1",
  access_evidence_schema: "runner-input-access-evidence-v1",
  provider_call_numbers: "CONTIGUOUS_FROM_ONE_PER_ATTEMPT",
  retrieval_call_numbers: "CONTIGUOUS_FROM_ONE_PER_ATTEMPT",
  tool_call_numbers: "CONTIGUOUS_FROM_ONE_PER_ATTEMPT",
  retrieval_tool_linkage: "BIDIRECTIONAL_FOR_TOOL_SEARCH",
  deterministic_gates: ["P0-HG-01", "P0-HG-02", "P0-HG-03", "P0-HG-04"],
});

const candidatePolicyContract = buildBenchmarkPolicyCorpusContract(BENCHMARK_POLICIES);

/**
 * 후보에게 노출하지 않는 case·oracle·평가 정책·주문 묶음의 identity입니다.
 * 이 상수의 원본 입력은 runner/evaluator 경계 밖으로 전달하지 않습니다.
 */
export const BENCHMARK_EXECUTION_DATA_HASH = sha256CanonicalJson({
  challenge: BENCHMARK_CHALLENGE,
  cases: BENCHMARK_CASES,
  oracles: BENCHMARK_ORACLES,
  policies: BENCHMARK_POLICIES,
  orders: BENCHMARK_ORDERS,
});

export interface BenchmarkExecutionIdentity {
  schema_version: "benchmark-execution-identity-v1";
  challenge_hash: string;
  dataset_hash: string;
  oracle_hash: string;
  hidden_execution_data_hash: string;
  locked_challenge_pack_hash: string;
  locked_challenge_contract_hash: string;
  locked_challenge_source_manifest_hash: string;
  evaluator_policy_corpus_hash: string;
  evaluator_contract_hash: string;
  candidate_policy_corpus_hash: string;
  evaluator_policy_manifest_hash: string;
  policy_manifest_hash: string;
  policy_resource_identity_hash: string;
  policy_vector_store_id_hash: string;
  orders_hash: string;
  schedule_id: string;
  output_schema_hash: string;
  pricing_snapshot_hash: string;
  runner_contract_hash: string;
  evidence_contract_hash: string;
  execution_hash: string;
}

export interface BuildBenchmarkExecutionIdentityOptions {
  lockedChallengePack: LockedChallengePack;
  scheduleId: string;
  policyManifestHash: string;
  policyResourceIdentityHash: string;
  policyVectorStoreId: string;
  pricingSnapshot?: PricingSnapshot;
}

export function buildBenchmarkExecutionIdentity({
  lockedChallengePack,
  scheduleId,
  policyManifestHash,
  policyResourceIdentityHash,
  policyVectorStoreId,
  pricingSnapshot = DEFAULT_PRICING_SNAPSHOT,
}: BuildBenchmarkExecutionIdentityOptions): BenchmarkExecutionIdentity {
  assertAuthoritativeLockedChallengePack(lockedChallengePack);
  if (
    canonicalJsonStringify(
      lockedChallengePack.approved_contract.candidate_complexity_profiles,
    )
    !== canonicalJsonStringify(BENCHMARK_CHALLENGE.candidate_complexity_profiles)
  ) {
    throw new TypeError(
      "인간 승인 candidate complexity profiles가 잠긴 Benchmark runtime profiles와 일치하지 않습니다.",
    );
  }
  const challengeBinding = buildLockedChallengeBenchmarkBinding(lockedChallengePack);
  assertSha256(scheduleId, "scheduleId");
  assertSha256(policyManifestHash, "policyManifestHash");
  assertSha256(policyResourceIdentityHash, "policyResourceIdentityHash");
  if (typeof policyVectorStoreId !== "string" || policyVectorStoreId.trim().length === 0) {
    throw new TypeError("policyVectorStoreId는 비어 있지 않은 원격 자원 ID여야 합니다.");
  }

  const payload = {
    schema_version: "benchmark-execution-identity-v1" as const,
    challenge_hash: sha256CanonicalJson(BENCHMARK_CHALLENGE),
    dataset_hash: BENCHMARK_DATASET_HASH,
    oracle_hash: BENCHMARK_ORACLE_HASH,
    hidden_execution_data_hash: BENCHMARK_EXECUTION_DATA_HASH,
    locked_challenge_pack_hash: challengeBinding.locked_challenge_pack_hash,
    locked_challenge_contract_hash: challengeBinding.approved_contract_hash,
    locked_challenge_source_manifest_hash: challengeBinding.source_manifest_hash,
    evaluator_policy_corpus_hash: sha256CanonicalJson(BENCHMARK_POLICIES),
    evaluator_contract_hash: BENCHMARK_EVALUATOR_CONTRACT_HASH,
    candidate_policy_corpus_hash: candidatePolicyContract.policy_corpus_sha256,
    evaluator_policy_manifest_hash: buildPolicyManifestHash(BENCHMARK_POLICIES),
    policy_manifest_hash: policyManifestHash,
    policy_resource_identity_hash: policyResourceIdentityHash,
    // 원격 handle 원문은 artifact에 노출하지 않고 execution identity에만 결합합니다.
    policy_vector_store_id_hash: sha256CanonicalJson(policyVectorStoreId),
    orders_hash: sha256CanonicalJson(BENCHMARK_ORDERS),
    schedule_id: scheduleId,
    output_schema_hash: sha256CanonicalJson(candidateOutputJsonSchema),
    pricing_snapshot_hash: sha256CanonicalJson(pricingSnapshot),
    runner_contract_hash: sha256CanonicalJson(BENCHMARK_RUNNER_CONTRACT),
    evidence_contract_hash: sha256CanonicalJson(BENCHMARK_EVIDENCE_CONTRACT),
  };
  const identity = deepFreeze({
    ...payload,
    execution_hash: sha256CanonicalJson(payload),
  });
  authoritativeBenchmarkExecutionIdentities.add(identity);
  return identity;
}

/**
 * restart hydration에는 원격 vector store 식별자 원문을 넣지 않고, canonical
 * identity authority artifact의 경로와 payload hash만 넣습니다.
 */
export interface BenchmarkExecutionIdentityAuthorityReference {
  readonly path: string;
  readonly payload_sha256: string;
}

export interface BenchmarkExecutionIdentityAuthorityArtifact {
  readonly schema_version: "benchmark-execution-identity-authority-v1";
  readonly artifact_kind: "BENCHMARK_EXECUTION_IDENTITY_AUTHORITY";
  readonly execution_identity: BenchmarkExecutionIdentity;
}

export interface PersistedBenchmarkExecutionIdentityAuthority {
  readonly path: string;
  readonly payloadSha256: string;
  readonly artifact: BenchmarkExecutionIdentityAuthorityArtifact;
}

function executionIdentityAuthorityDirectory(outputDirectory: string): string {
  return join(resolve(outputDirectory), EXECUTION_IDENTITY_AUTHORITY_DIRECTORY);
}

function executionIdentityAuthorityPath({
  outputDirectory,
  executionHash,
}: {
  readonly outputDirectory: string;
  readonly executionHash: string;
}): string {
  assertSha256(executionHash, "execution identity authority execution hash");
  return join(
    executionIdentityAuthorityDirectory(outputDirectory),
    `benchmark-execution-identity--${executionHash}.json`,
  );
}

function parseExecutionIdentityAuthorityArtifact(
  value: unknown,
): BenchmarkExecutionIdentityAuthorityArtifact {
  if (
    !isPlainRecord(value)
    || !hasExactKeys(value, [
      "schema_version",
      "artifact_kind",
      "execution_identity",
    ])
    || value.schema_version !== "benchmark-execution-identity-authority-v1"
    || value.artifact_kind !== "BENCHMARK_EXECUTION_IDENTITY_AUTHORITY"
    || !isPlainRecord(value.execution_identity)
  ) {
    throw new TypeError(
      "Benchmark execution identity authority artifact의 exact schema가 다릅니다.",
    );
  }
  // 여기서는 brand를 부여하지 않습니다. canonical source와 현재 계약을 모두
  // 재검증한 cold loader만 아래에서 private authority brand를 재발급합니다.
  return {
    schema_version: "benchmark-execution-identity-authority-v1",
    artifact_kind: "BENCHMARK_EXECUTION_IDENTITY_AUTHORITY",
    execution_identity: (
      structuredClone(value.execution_identity) as unknown as BenchmarkExecutionIdentity
    ),
  };
}

/** 실행 identity를 만든 즉시 write-once canonical authority artifact로 고정합니다. */
export async function persistBenchmarkExecutionIdentityAuthority({
  outputDirectory,
  executionIdentity,
}: {
  readonly outputDirectory: string;
  readonly executionIdentity: BenchmarkExecutionIdentity;
}): Promise<PersistedBenchmarkExecutionIdentityAuthority> {
  // 생성 process의 brand가 있는 identity만 저장할 수 있습니다.
  assertExecutionIdentity(executionIdentity, DEFAULT_PRICING_SNAPSHOT);
  const artifact: BenchmarkExecutionIdentityAuthorityArtifact = {
    schema_version: "benchmark-execution-identity-authority-v1",
    artifact_kind: "BENCHMARK_EXECUTION_IDENTITY_AUTHORITY",
    execution_identity: structuredClone(executionIdentity),
  };
  const parsed = parseExecutionIdentityAuthorityArtifact(artifact);
  const rootDirectory = resolve(outputDirectory);
  const artifactDirectory = executionIdentityAuthorityDirectory(rootDirectory);
  const path = executionIdentityAuthorityPath({
    outputDirectory: rootDirectory,
    executionHash: parsed.execution_identity.execution_hash,
  });
  await persistCanonicalLifecycleFile({
    rootDirectory,
    artifactDirectory,
    filePath: path,
    value: {
      payload_sha256: sha256CanonicalJson(parsed),
      payload: parsed,
    },
    label: "Benchmark execution identity authority artifact",
  });
  return Object.freeze({
    path,
    payloadSha256: sha256CanonicalJson(parsed),
    artifact: deepFreeze(parsed),
  });
}

function assertLockedChallengeBinding(
  value: unknown,
): asserts value is Pick<
  LockedChallengePack,
  | "locked_challenge_pack_hash"
  | "approved_contract_hash"
  | "source_manifest_hash"
> {
  if (!isPlainRecord(value)) {
    throw new TypeError("cold identity loader의 Locked Challenge binding이 없습니다.");
  }
  for (const key of [
    "locked_challenge_pack_hash",
    "approved_contract_hash",
    "source_manifest_hash",
  ] as const) {
    if (typeof value[key] !== "string") {
      throw new TypeError("cold identity loader의 Locked Challenge binding이 다릅니다.");
    }
    assertSha256(value[key], `locked challenge ${key}`);
  }
}

/**
 * canonical disk artifact를 다시 읽어 검증한 경우에만 process-local authority
 * brand를 재발급합니다. 직렬화 JSON 또는 타입 캐스트로는 이 경로를 통과할 수
 * 없습니다.
 */
export async function loadBenchmarkExecutionIdentityAuthority({
  outputDirectory,
  authority,
  lockedChallengePack,
  expectedScheduleId,
  pricingSnapshot = DEFAULT_PRICING_SNAPSHOT,
}: {
  readonly outputDirectory: string;
  readonly authority: BenchmarkExecutionIdentityAuthorityReference;
  readonly lockedChallengePack: Pick<
    LockedChallengePack,
    | "locked_challenge_pack_hash"
    | "approved_contract_hash"
    | "source_manifest_hash"
  >;
  readonly expectedScheduleId: string;
  readonly pricingSnapshot?: PricingSnapshot;
}): Promise<BenchmarkExecutionIdentity> {
  if (
    !isPlainRecord(authority)
    || !hasExactKeys(authority, ["path", "payload_sha256"])
    || typeof authority.path !== "string"
    || typeof authority.payload_sha256 !== "string"
  ) {
    throw new TypeError("Benchmark execution identity authority reference의 exact schema가 다릅니다.");
  }
  assertSha256(authority.payload_sha256, "execution identity authority payload hash");
  assertSha256(expectedScheduleId, "expected execution identity schedule");
  assertLockedChallengeBinding(lockedChallengePack);
  const rootDirectory = resolve(outputDirectory);
  const artifactDirectory = executionIdentityAuthorityDirectory(rootDirectory);
  await assertCanonicalLifecycleDirectory({ rootDirectory, artifactDirectory });
  const filename = basename(authority.path);
  const matched = EXECUTION_IDENTITY_AUTHORITY_FILE.exec(filename);
  if (matched === null) {
    throw new TypeError("Benchmark execution identity authority filename이 canonical 계약과 다릅니다.");
  }
  const expectedPath = executionIdentityAuthorityPath({
    outputDirectory: rootDirectory,
    executionHash: matched[1],
  });
  if (resolve(authority.path) !== expectedPath) {
    throw new TypeError("Benchmark execution identity authority path가 canonical root 밖입니다.");
  }
  const loaded = await readCanonicalLifecycleFile({
    path: expectedPath,
    label: "Benchmark execution identity authority artifact",
  });
  if (!isPlainRecord(loaded.value) || !hasExactKeys(loaded.value, ["payload_sha256", "payload"])) {
    throw new TypeError("Benchmark execution identity authority wrapper의 exact schema가 다릅니다.");
  }
  if (
    typeof loaded.value.payload_sha256 !== "string"
    || loaded.value.payload_sha256 !== authority.payload_sha256
    || sha256CanonicalJson(loaded.value.payload) !== authority.payload_sha256
  ) {
    throw new TypeError("Benchmark execution identity authority payload hash가 reference와 다릅니다.");
  }
  const artifact = parseExecutionIdentityAuthorityArtifact(loaded.value.payload);
  const identity = deepFreeze(artifact.execution_identity);
  if (identity.execution_hash !== matched[1]) {
    throw new TypeError("Benchmark execution identity authority content-addressed filename이 다릅니다.");
  }
  assertExecutionIdentityPayload(identity, pricingSnapshot, lockedChallengePack);
  if (identity.schedule_id !== expectedScheduleId) {
    throw new TypeError("Benchmark execution identity authority schedule이 현재 locked schedule과 다릅니다.");
  }
  authoritativeBenchmarkExecutionIdentities.add(identity);
  return identity;
}

export interface PreparedPolicyResourceBinding {
  policy_corpus_sha256: string;
  chunking_config_sha256: string;
  resource_contract_sha256: string;
  manifest_sha256: string;
  resource_identity_sha256: string;
  vector_store_id_hash: string;
}

export interface BenchmarkSlotIdentity {
  schema_version: "benchmark-slot-identity-v1";
  execution_hash: string;
  schedule_id: string;
  slot_id: string;
  sequence: number;
  case_id: string;
  candidate_id: "A" | "B" | "C";
  repetition: 1 | 2;
  candidate_position: 1 | 2 | 3;
  case_hash: string;
  oracle_hash: string;
  authoritative_order_hash: string;
  candidate_config_hash: string;
  system_prompt_hash: string;
  invocation_hash: string;
  execution_envelope_hash: string;
  invocation_input_hash: string;
  candidate_input_hash: string;
  input_access_hash: string;
  output_schema_hash: string;
  pricing_snapshot_hash: string;
  policy_manifest_hash: string;
  evaluator_policy_manifest_hash: string;
  evaluator_contract_hash: string;
  policy_resource_identity_hash: string;
  policy_vector_store_id_hash: string;
  slot_identity_hash: string;
}

export interface BuildBenchmarkSlotIdentityOptions {
  executionIdentity: BenchmarkExecutionIdentity;
  slot: BenchmarkScheduleSlot;
  evaluationCase: EvaluationCase;
  oracle: EvaluationOracle;
  authoritativeOrder: EvaluationOrder | null;
  candidateDefinition: BenchmarkCandidateDefinition;
  accessEvidence: RunnerInputAccessEvidence;
  preparedPolicyResource?: PreparedPolicyResourceBinding;
  pricingSnapshot?: PricingSnapshot;
}

function assertExecutionIdentityPayload(
  identity: BenchmarkExecutionIdentity,
  pricingSnapshot: PricingSnapshot,
  lockedChallengeBinding?: Pick<
    LockedChallengePack,
    | "locked_challenge_pack_hash"
    | "approved_contract_hash"
    | "source_manifest_hash"
  >,
): void {
  if (typeof identity !== "object" || identity === null) {
    throw new TypeError("Benchmark execution identity는 plain object여야 합니다.");
  }
  const actualKeys = Object.keys(identity).sort();
  const expectedKeys = [...EXECUTION_IDENTITY_KEYS].sort();
  if (
    identity.schema_version !== "benchmark-execution-identity-v1"
    || actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError("Benchmark execution identity의 exact key·version 계약이 다릅니다.");
  }
  const { execution_hash: executionHash, ...payload } = identity;
  assertSha256(executionHash, "executionIdentity.execution_hash");
  for (const [name, value] of Object.entries(identity)) {
    if (name.endsWith("_hash") || name === "schedule_id") {
      assertSha256(value, `executionIdentity.${name}`);
    }
  }
  if (sha256CanonicalJson(payload) !== executionHash) {
    throw new TypeError("Benchmark execution identity의 payload hash가 일치하지 않습니다.");
  }
  if (
    identity.challenge_hash !== sha256CanonicalJson(BENCHMARK_CHALLENGE)
    || identity.dataset_hash !== BENCHMARK_DATASET_HASH
    || identity.hidden_execution_data_hash !== BENCHMARK_EXECUTION_DATA_HASH
    || identity.oracle_hash !== BENCHMARK_ORACLE_HASH
    || identity.evaluator_policy_corpus_hash !== sha256CanonicalJson(BENCHMARK_POLICIES)
    || identity.evaluator_contract_hash !== BENCHMARK_EVALUATOR_CONTRACT_HASH
    || identity.candidate_policy_corpus_hash !== candidatePolicyContract.policy_corpus_sha256
    || identity.evaluator_policy_manifest_hash !== buildPolicyManifestHash(BENCHMARK_POLICIES)
    || identity.orders_hash !== sha256CanonicalJson(BENCHMARK_ORDERS)
    || identity.output_schema_hash !== sha256CanonicalJson(candidateOutputJsonSchema)
    || identity.pricing_snapshot_hash !== sha256CanonicalJson(pricingSnapshot)
    || identity.runner_contract_hash !== sha256CanonicalJson(BENCHMARK_RUNNER_CONTRACT)
    || identity.evidence_contract_hash !== sha256CanonicalJson(BENCHMARK_EVIDENCE_CONTRACT)
    || (lockedChallengeBinding !== undefined && (
      identity.locked_challenge_pack_hash
        !== lockedChallengeBinding.locked_challenge_pack_hash
      || identity.locked_challenge_contract_hash
        !== lockedChallengeBinding.approved_contract_hash
      || identity.locked_challenge_source_manifest_hash
        !== lockedChallengeBinding.source_manifest_hash
    ))
  ) {
    throw new TypeError("Benchmark execution identity가 잠긴 데이터·runner·evidence 계약과 다릅니다.");
  }
}

function assertExecutionIdentity(
  identity: BenchmarkExecutionIdentity,
  pricingSnapshot: PricingSnapshot,
): void {
  if (
    typeof identity !== "object"
    || identity === null
    || !authoritativeBenchmarkExecutionIdentities.has(identity)
  ) {
    throw new TypeError(
      "Benchmark execution identity는 authoritative Locked Challenge pack을 검증한 build 결과여야 합니다.",
    );
  }
  assertExecutionIdentityPayload(identity, pricingSnapshot);
}

/** 부모 팩과 오케스트레이터가 원격 호출 전에 같은 잠긴 실행 identity 검증을 재사용합니다. */
export function validateLockedBenchmarkExecutionIdentity(
  identity: BenchmarkExecutionIdentity,
  expectedScheduleId: string,
  pricingSnapshot: PricingSnapshot = DEFAULT_PRICING_SNAPSHOT,
): void {
  assertSha256(expectedScheduleId, "expectedScheduleId");
  assertExecutionIdentity(identity, pricingSnapshot);
  if (identity.schedule_id !== expectedScheduleId) {
    throw new TypeError("Benchmark execution identity의 schedule_id가 잠긴 schedule과 다릅니다.");
  }
}

function assertSlotCoordinates(
  slot: BenchmarkScheduleSlot,
  evaluationCase: EvaluationCase,
  candidateDefinition: BenchmarkCandidateDefinition,
  accessEvidence: RunnerInputAccessEvidence,
): void {
  const expectedSlotId = `${evaluationCase.case_id}--${candidateDefinition.candidateId}--r${slot.repetition}`;
  if (
    slot.slot_id !== expectedSlotId
    || slot.case_id !== evaluationCase.case_id
    || slot.candidate_id !== candidateDefinition.candidateId
    || accessEvidence.slotId !== slot.slot_id
    || accessEvidence.caseId !== slot.case_id
    || accessEvidence.candidateId !== slot.candidate_id
    || accessEvidence.repetition !== slot.repetition
    || !Number.isSafeInteger(slot.sequence)
    || slot.sequence < 1
    || ![1, 2, 3].includes(slot.candidate_position)
  ) {
    throw new TypeError("schedule-owned slot·반복·후보 위치 identity가 실행 입력과 다릅니다.");
  }
}

function assertCandidateDefinitionIdentity(
  definition: BenchmarkCandidateDefinition,
  evaluationCase: EvaluationCase,
): void {
  if (
    definition.config.case_identity_hash !== sha256CanonicalJson(evaluationCase)
    || definition.identity.case_identity_hash !== definition.config.case_identity_hash
    || definition.identity.candidate_config_hash !== sha256CanonicalJson(definition.config)
    || definition.identity.system_prompt_hash !== sha256CanonicalJson(definition.systemPrompt)
    || definition.identity.invocation_hash !== sha256CanonicalJson({
      invocation: definition.invocation,
      case_identity_hash: definition.config.case_identity_hash,
      policy_corpus_hash: definition.config.policy_corpus_hash,
    })
    || definition.identity.policy_corpus_hash !== definition.config.policy_corpus_hash
  ) {
    throw new TypeError("후보 config·prompt·invocation identity가 잠긴 정의와 다릅니다.");
  }
}

function assertPreparedPolicyBinding(
  definition: BenchmarkCandidateDefinition,
  executionIdentity: BenchmarkExecutionIdentity,
  prepared: PreparedPolicyResourceBinding | undefined,
): void {
  if (definition.candidateId === "A") {
    if (prepared !== undefined) {
      throw new TypeError("Candidate A는 prepared retrieval 정책 자원을 사용할 수 없습니다.");
    }
    return;
  }
  if (prepared === undefined) {
    throw new TypeError("Candidate B/C에는 동일한 prepared 정책 자원 identity가 필요합니다.");
  }
  for (const [name, value] of Object.entries(prepared)) {
    assertSha256(value, `preparedPolicyResource.${name}`);
  }
  if (
    prepared.policy_corpus_sha256 !== definition.config.policy_corpus_hash
    || prepared.chunking_config_sha256 !== definition.config.policy_chunking_config_hash
    || prepared.resource_contract_sha256 !== definition.config.policy_resource_contract_hash
    || prepared.manifest_sha256 !== executionIdentity.policy_manifest_hash
    || prepared.resource_identity_sha256 !== executionIdentity.policy_resource_identity_hash
    || prepared.vector_store_id_hash !== executionIdentity.policy_vector_store_id_hash
  ) {
    throw new TypeError(
      "후보 config의 policy corpus·chunking·resource 계약이 prepared 정책 자원 identity와 다릅니다.",
    );
  }
}

export function buildBenchmarkSlotIdentity({
  executionIdentity,
  slot,
  evaluationCase,
  oracle,
  authoritativeOrder,
  candidateDefinition,
  accessEvidence,
  preparedPolicyResource,
  pricingSnapshot = DEFAULT_PRICING_SNAPSHOT,
}: BuildBenchmarkSlotIdentityOptions): BenchmarkSlotIdentity {
  assertExecutionIdentity(executionIdentity, pricingSnapshot);
  if (executionIdentity.schedule_id.length === 0) {
    throw new TypeError("Benchmark execution identity에는 schedule_id가 필요합니다.");
  }
  assertSlotCoordinates(slot, evaluationCase, candidateDefinition, accessEvidence);
  assertCandidateDefinitionIdentity(candidateDefinition, evaluationCase);
  assertPreparedPolicyBinding(candidateDefinition, executionIdentity, preparedPolicyResource);

  if (oracle.case_id !== evaluationCase.case_id) {
    throw new TypeError("Benchmark case와 oracle identity가 일치하지 않습니다.");
  }
  if (
    accessEvidence.evaluationCaseHash !== sha256CanonicalJson(evaluationCase)
    || accessEvidence.policyAccess.corpusHash !== sha256CanonicalJson(BENCHMARK_POLICIES)
    || accessEvidence.policyAccess.manifestHash !== executionIdentity.evaluator_policy_manifest_hash
    || accessEvidence.candidateInputHash !== buildRunnerCandidateInputHash({
      candidateId: slot.candidate_id,
      slotId: slot.slot_id,
      repetition: slot.repetition,
      evaluationCase,
      orderAccess: accessEvidence.orderAccess,
      policyAccess: accessEvidence.policyAccess,
    })
    || sha256CanonicalJson(candidateDefinition.config.output_schema)
      !== executionIdentity.output_schema_hash
    || candidateDefinition.config.output_schema === undefined
  ) {
    throw new TypeError("runner-owned input/access evidence가 잠긴 평가 입력과 다릅니다.");
  }
  const payload = {
    schema_version: "benchmark-slot-identity-v1" as const,
    execution_hash: executionIdentity.execution_hash,
    schedule_id: executionIdentity.schedule_id,
    slot_id: slot.slot_id,
    sequence: slot.sequence,
    case_id: slot.case_id,
    candidate_id: slot.candidate_id,
    repetition: slot.repetition,
    candidate_position: slot.candidate_position,
    case_hash: sha256CanonicalJson(evaluationCase),
    oracle_hash: sha256CanonicalJson(oracle),
    authoritative_order_hash: sha256CanonicalJson(authoritativeOrder),
    candidate_config_hash: candidateDefinition.identity.candidate_config_hash,
    system_prompt_hash: candidateDefinition.identity.system_prompt_hash,
    invocation_hash: candidateDefinition.identity.invocation_hash,
    execution_envelope_hash: sha256CanonicalJson(candidateDefinition.invocation.executionEnvelope),
    invocation_input_hash: sha256CanonicalJson(candidateDefinition.invocation.input),
    candidate_input_hash: accessEvidence.candidateInputHash,
    input_access_hash: sha256CanonicalJson(accessEvidence),
    output_schema_hash: sha256CanonicalJson(candidateDefinition.config.output_schema),
    pricing_snapshot_hash: executionIdentity.pricing_snapshot_hash,
    policy_manifest_hash: executionIdentity.policy_manifest_hash,
    evaluator_policy_manifest_hash: executionIdentity.evaluator_policy_manifest_hash,
    evaluator_contract_hash: executionIdentity.evaluator_contract_hash,
    policy_resource_identity_hash: executionIdentity.policy_resource_identity_hash,
    policy_vector_store_id_hash: executionIdentity.policy_vector_store_id_hash,
  };

  // Canonical JSON 가능성도 생성 시점에 검증해 write-once intent가 뒤늦게 실패하지 않게 합니다.
  canonicalJsonStringify(payload);
  return deepFreeze({
    ...payload,
    slot_identity_hash: sha256CanonicalJson(payload),
  });
}

export function benchmarkSlotIdentityHashes(
  executionIdentity: BenchmarkExecutionIdentity,
  slotIdentity: BenchmarkSlotIdentity,
): Readonly<Record<string, string>> {
  const actualKeys = Object.keys(slotIdentity).sort();
  const expectedKeys = [...SLOT_IDENTITY_KEYS].sort();
  const { slot_identity_hash: slotIdentityHash, ...slotPayload } = slotIdentity;
  if (
    slotIdentity.schema_version !== "benchmark-slot-identity-v1"
    || actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || sha256CanonicalJson(slotPayload) !== slotIdentityHash
    || slotIdentity.execution_hash !== executionIdentity.execution_hash
    || slotIdentity.schedule_id !== executionIdentity.schedule_id
    || slotIdentity.pricing_snapshot_hash !== executionIdentity.pricing_snapshot_hash
    || slotIdentity.output_schema_hash !== executionIdentity.output_schema_hash
    || slotIdentity.policy_manifest_hash !== executionIdentity.policy_manifest_hash
    || slotIdentity.evaluator_policy_manifest_hash
      !== executionIdentity.evaluator_policy_manifest_hash
    || slotIdentity.evaluator_contract_hash !== executionIdentity.evaluator_contract_hash
    || slotIdentity.policy_resource_identity_hash
      !== executionIdentity.policy_resource_identity_hash
    || slotIdentity.policy_vector_store_id_hash
      !== executionIdentity.policy_vector_store_id_hash
  ) {
    throw new TypeError("slot identity가 persistence에 투영할 exact self-hash·execution identity와 다릅니다.");
  }
  return deepFreeze({
    challenge_hash: executionIdentity.challenge_hash,
    dataset_hash: executionIdentity.dataset_hash,
    benchmark_oracle_hash: executionIdentity.oracle_hash,
    hidden_execution_data_hash: executionIdentity.hidden_execution_data_hash,
    locked_challenge_pack_hash: executionIdentity.locked_challenge_pack_hash,
    locked_challenge_contract_hash: executionIdentity.locked_challenge_contract_hash,
    locked_challenge_source_manifest_hash:
      executionIdentity.locked_challenge_source_manifest_hash,
    evaluator_policy_corpus_hash: executionIdentity.evaluator_policy_corpus_hash,
    evaluator_contract_hash: executionIdentity.evaluator_contract_hash,
    candidate_policy_corpus_hash: executionIdentity.candidate_policy_corpus_hash,
    policy_manifest_hash: executionIdentity.policy_manifest_hash,
    evaluator_policy_manifest_hash: executionIdentity.evaluator_policy_manifest_hash,
    policy_resource_identity_hash: executionIdentity.policy_resource_identity_hash,
    policy_vector_store_id_hash: executionIdentity.policy_vector_store_id_hash,
    orders_hash: executionIdentity.orders_hash,
    output_schema_hash: executionIdentity.output_schema_hash,
    pricing_snapshot_hash: executionIdentity.pricing_snapshot_hash,
    runner_contract_hash: executionIdentity.runner_contract_hash,
    evidence_contract_hash: executionIdentity.evidence_contract_hash,
    execution_identity_hash: executionIdentity.execution_hash,
    slot_case_hash: slotIdentity.case_hash,
    slot_oracle_hash: slotIdentity.oracle_hash,
    authoritative_order_hash: slotIdentity.authoritative_order_hash,
    candidate_config_hash: slotIdentity.candidate_config_hash,
    prompt_hash: slotIdentity.system_prompt_hash,
    invocation_hash: slotIdentity.invocation_hash,
    execution_envelope_hash: slotIdentity.execution_envelope_hash,
    invocation_input_hash: slotIdentity.invocation_input_hash,
    candidate_input_hash: slotIdentity.candidate_input_hash,
    input_access_hash: slotIdentity.input_access_hash,
    slot_output_schema_hash: slotIdentity.output_schema_hash,
    slot_identity_hash: slotIdentity.slot_identity_hash,
  });
}

export interface BenchmarkSlotExpectedIdentityProjection {
  readonly scheduleId: string;
  readonly slotIdentityHash: string;
  readonly identityHashes: Readonly<Record<string, string>>;
}

export function buildBenchmarkSlotExpectedIdentity(
  executionIdentity: BenchmarkExecutionIdentity,
  slotIdentity: BenchmarkSlotIdentity,
): BenchmarkSlotExpectedIdentityProjection {
  return deepFreeze({
    scheduleId: executionIdentity.schedule_id,
    slotIdentityHash: slotIdentity.slot_identity_hash,
    identityHashes: benchmarkSlotIdentityHashes(executionIdentity, slotIdentity),
  });
}

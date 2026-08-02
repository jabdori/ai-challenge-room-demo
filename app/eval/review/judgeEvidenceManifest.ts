import { createHmac } from "node:crypto";
import {
  BLIND_JUDGE_LABELS,
  type BlindJudgeLabel,
} from "../judge/contracts";
import {
  buildPrivateBlindMapping,
  type BenchmarkJudgeCandidateId,
} from "../judge/blinding";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";

const HIDDEN_CASE_IDS = Array.from(
  { length: 12 },
  (_, index) => `H-${String(index + 1).padStart(3, "0")}`,
);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPAQUE_HANDLE_PATTERN = /^evh_[a-f0-9]{64}$/;

type JsonRecord = Record<string, unknown>;

export interface PrivateBlindingContext {
  readonly schema_version: "private-blinding-context-v1";
  readonly master_blinding_seed: string;
}

export interface ExecutionBoundPrivateBlindMapping {
  readonly schema_version: "execution-bound-private-blind-mapping-v1";
  readonly case_id: string;
  readonly execution_pack_hash: string;
  readonly master_blinding_seed_commitment: string;
  readonly case_blinding_seed: string;
  readonly label_to_candidate: Record<BlindJudgeLabel, BenchmarkJudgeCandidateId>;
  readonly private_mapping_hash: string;
}

export interface JudgeEvidencePrecommitCaseBinding {
  readonly case_id: string;
  readonly judge_input_hash: string;
  readonly private_mapping_hash: string;
}

export interface JudgeEvidencePrecommitManifest {
  readonly schema_version: "judge-evidence-precommit-manifest-v1";
  readonly artifact_kind: "JUDGE_EVIDENCE_PRECOMMIT_MANIFEST";
  readonly execution_pack_hash: string;
  readonly master_blinding_seed_commitment: string;
  readonly case_bindings: readonly JudgeEvidencePrecommitCaseBinding[];
  readonly manifest_hash: string;
}

function readPlainRecord(value: unknown, location: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${location}은(는) plain 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${location}은(는) plain 객체여야 합니다.`);
  }
  return value as JsonRecord;
}

function assertExactKeys(
  record: JsonRecord,
  expectedKeys: readonly string[],
  location: string,
): void {
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(record, key));
  const additional = Object.keys(record).filter((key) => !expected.has(key));
  if (missing.length > 0 || additional.length > 0) {
    throw new TypeError(
      `${location}의 exact 필드 계약이 다릅니다. missing=${missing.join(",")} additional=${additional.join(",")}`,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function assertSha256(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${location}는 64자리 소문자 SHA-256이어야 합니다.`);
  }
}

function assertHiddenCaseId(value: unknown, location: string): asserts value is string {
  if (typeof value !== "string" || !HIDDEN_CASE_IDS.includes(value)) {
    throw new TypeError(`${location}는 잠긴 hidden 범위 H-001부터 H-012여야 합니다.`);
  }
}

function assertMasterBlindingSeed(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || value.length < 48
    || /\p{Cc}/u.test(value)
  ) {
    throw new TypeError("master blinding seed는 제어 문자가 없는 48자 이상의 비밀값이어야 합니다.");
  }
}

function hmacHex(
  masterBlindingSeed: string,
  payload: unknown,
): string {
  return createHmac("sha256", masterBlindingSeed)
    .update(canonicalJsonStringify(payload), "utf8")
    .digest("hex");
}

export function buildMasterBlindingSeedCommitment({
  executionPackHash,
  masterBlindingSeed,
}: {
  executionPackHash: string;
  masterBlindingSeed: string;
}): string {
  assertSha256(executionPackHash, "executionPackHash");
  assertMasterBlindingSeed(masterBlindingSeed);
  return sha256CanonicalJson({
    schema_version: "master-blinding-seed-commitment-v1",
    execution_pack_hash: executionPackHash,
    master_blinding_seed: masterBlindingSeed,
  });
}

export function deriveCaseBlindingSeed({
  caseId,
  executionPackHash,
  masterBlindingSeed,
}: {
  caseId: string;
  executionPackHash: string;
  masterBlindingSeed: string;
}): string {
  assertHiddenCaseId(caseId, "caseId");
  assertSha256(executionPackHash, "executionPackHash");
  assertMasterBlindingSeed(masterBlindingSeed);
  return hmacHex(masterBlindingSeed, {
    schema_version: "case-blinding-seed-derivation-v1",
    execution_pack_hash: executionPackHash,
    case_id: caseId,
  });
}

function mappingPayload(
  mapping: Omit<ExecutionBoundPrivateBlindMapping, "private_mapping_hash">,
): Omit<ExecutionBoundPrivateBlindMapping, "private_mapping_hash"> {
  return {
    schema_version: "execution-bound-private-blind-mapping-v1",
    case_id: mapping.case_id,
    execution_pack_hash: mapping.execution_pack_hash,
    master_blinding_seed_commitment: mapping.master_blinding_seed_commitment,
    case_blinding_seed: mapping.case_blinding_seed,
    label_to_candidate: {
      X: mapping.label_to_candidate.X,
      Y: mapping.label_to_candidate.Y,
      Z: mapping.label_to_candidate.Z,
    },
  };
}

export function buildExecutionBoundPrivateBlindMapping({
  caseId,
  executionPackHash,
  masterBlindingSeed,
}: {
  caseId: string;
  executionPackHash: string;
  masterBlindingSeed: string;
}): ExecutionBoundPrivateBlindMapping {
  const caseBlindingSeed = deriveCaseBlindingSeed({
    caseId,
    executionPackHash,
    masterBlindingSeed,
  });
  const base = buildPrivateBlindMapping({
    caseId,
    seed: caseBlindingSeed,
  });
  const payload: Omit<ExecutionBoundPrivateBlindMapping, "private_mapping_hash"> = {
    schema_version: "execution-bound-private-blind-mapping-v1",
    case_id: caseId,
    execution_pack_hash: executionPackHash,
    master_blinding_seed_commitment: buildMasterBlindingSeedCommitment({
      executionPackHash,
      masterBlindingSeed,
    }),
    case_blinding_seed: caseBlindingSeed,
    label_to_candidate: {
      X: base.label_to_candidate.X,
      Y: base.label_to_candidate.Y,
      Z: base.label_to_candidate.Z,
    },
  };
  return deepFreeze({
    ...payload,
    private_mapping_hash: sha256CanonicalJson(mappingPayload(payload)),
  });
}

export function validateExecutionBoundPrivateBlindMapping({
  input,
  expectedCaseId,
  expectedExecutionPackHash,
  expectedMasterBlindingSeed,
  expectedMasterCommitment,
}: {
  input: unknown;
  expectedCaseId: string;
  expectedExecutionPackHash: string;
  expectedMasterBlindingSeed: string;
  expectedMasterCommitment: string;
}): ExecutionBoundPrivateBlindMapping {
  const record = readPlainRecord(input, "execution-bound private blind mapping");
  assertExactKeys(record, [
    "schema_version",
    "case_id",
    "execution_pack_hash",
    "master_blinding_seed_commitment",
    "case_blinding_seed",
    "label_to_candidate",
    "private_mapping_hash",
  ], "execution-bound private blind mapping");
  assertHiddenCaseId(expectedCaseId, "expectedCaseId");
  assertSha256(expectedExecutionPackHash, "expectedExecutionPackHash");
  assertSha256(expectedMasterCommitment, "expectedMasterCommitment");
  assertMasterBlindingSeed(expectedMasterBlindingSeed);
  const expected = buildExecutionBoundPrivateBlindMapping({
    caseId: expectedCaseId,
    executionPackHash: expectedExecutionPackHash,
    masterBlindingSeed: expectedMasterBlindingSeed,
  });
  if (
    record.schema_version !== expected.schema_version
    || canonicalJsonStringify(record) !== canonicalJsonStringify(expected)
    || expected.master_blinding_seed_commitment !== expectedMasterCommitment
  ) {
    throw new TypeError(
      "execution-bound private blind mapping이 precommit seed·execution pack 무결성과 다릅니다.",
    );
  }
  return expected;
}

function manifestPayload(
  manifest: Omit<JudgeEvidencePrecommitManifest, "manifest_hash">,
): Omit<JudgeEvidencePrecommitManifest, "manifest_hash"> {
  return {
    schema_version: "judge-evidence-precommit-manifest-v1",
    artifact_kind: "JUDGE_EVIDENCE_PRECOMMIT_MANIFEST",
    execution_pack_hash: manifest.execution_pack_hash,
    master_blinding_seed_commitment: manifest.master_blinding_seed_commitment,
    case_bindings: manifest.case_bindings.map((binding) => ({
      case_id: binding.case_id,
      judge_input_hash: binding.judge_input_hash,
      private_mapping_hash: binding.private_mapping_hash,
    })),
  };
}

export function buildJudgeEvidencePrecommitManifest({
  executionPackHash,
  masterBlindingSeed,
  judgeInputBindings,
}: {
  executionPackHash: string;
  masterBlindingSeed: string;
  judgeInputBindings: readonly {
    readonly case_id: string;
    readonly judge_input_hash: string;
  }[];
}): JudgeEvidencePrecommitManifest {
  assertSha256(executionPackHash, "executionPackHash");
  assertMasterBlindingSeed(masterBlindingSeed);
  if (!Array.isArray(judgeInputBindings) || judgeInputBindings.length !== 12) {
    throw new TypeError("Judge precommit에는 H-001부터 H-012까지 exact 12개 input binding이 필요합니다.");
  }
  const caseBindings = judgeInputBindings.map((rawBinding, index) => {
    const record = readPlainRecord(rawBinding, `judgeInputBindings[${index}]`);
    assertExactKeys(record, ["case_id", "judge_input_hash"], `judgeInputBindings[${index}]`);
    const expectedCaseId = HIDDEN_CASE_IDS[index];
    if (record.case_id !== expectedCaseId) {
      throw new TypeError("Judge precommit case binding은 H-001부터 H-012 잠긴 순서여야 합니다.");
    }
    assertSha256(record.judge_input_hash, `judgeInputBindings[${index}].judge_input_hash`);
    const mapping = buildExecutionBoundPrivateBlindMapping({
      caseId: expectedCaseId,
      executionPackHash,
      masterBlindingSeed,
    });
    return {
      case_id: expectedCaseId,
      judge_input_hash: record.judge_input_hash,
      private_mapping_hash: mapping.private_mapping_hash,
    };
  });
  const payload: Omit<JudgeEvidencePrecommitManifest, "manifest_hash"> = {
    schema_version: "judge-evidence-precommit-manifest-v1",
    artifact_kind: "JUDGE_EVIDENCE_PRECOMMIT_MANIFEST",
    execution_pack_hash: executionPackHash,
    master_blinding_seed_commitment: buildMasterBlindingSeedCommitment({
      executionPackHash,
      masterBlindingSeed,
    }),
    case_bindings: caseBindings,
  };
  return deepFreeze({
    ...payload,
    manifest_hash: sha256CanonicalJson(manifestPayload(payload)),
  });
}

export function validateJudgeEvidencePrecommitManifest(
  input: unknown,
): JudgeEvidencePrecommitManifest {
  const record = readPlainRecord(input, "Judge evidence precommit manifest");
  assertExactKeys(record, [
    "schema_version",
    "artifact_kind",
    "execution_pack_hash",
    "master_blinding_seed_commitment",
    "case_bindings",
    "manifest_hash",
  ], "Judge evidence precommit manifest");
  if (
    record.schema_version !== "judge-evidence-precommit-manifest-v1"
    || record.artifact_kind !== "JUDGE_EVIDENCE_PRECOMMIT_MANIFEST"
  ) {
    throw new TypeError("Judge evidence precommit manifest version 또는 kind가 다릅니다.");
  }
  assertSha256(record.execution_pack_hash, "manifest.execution_pack_hash");
  assertSha256(
    record.master_blinding_seed_commitment,
    "manifest.master_blinding_seed_commitment",
  );
  assertSha256(record.manifest_hash, "manifest.manifest_hash");
  if (!Array.isArray(record.case_bindings) || record.case_bindings.length !== 12) {
    throw new TypeError("Judge evidence precommit manifest에는 exact 12개 case binding이 필요합니다.");
  }
  const caseBindings = record.case_bindings.map((rawBinding, index) => {
    const binding = readPlainRecord(rawBinding, `manifest.case_bindings[${index}]`);
    assertExactKeys(
      binding,
      ["case_id", "judge_input_hash", "private_mapping_hash"],
      `manifest.case_bindings[${index}]`,
    );
    const caseId = HIDDEN_CASE_IDS[index];
    if (binding.case_id !== caseId) {
      throw new TypeError("manifest case binding은 H-001부터 H-012 잠긴 순서여야 합니다.");
    }
    assertSha256(binding.judge_input_hash, `manifest.case_bindings[${index}].judge_input_hash`);
    assertSha256(
      binding.private_mapping_hash,
      `manifest.case_bindings[${index}].private_mapping_hash`,
    );
    return {
      case_id: caseId,
      judge_input_hash: binding.judge_input_hash,
      private_mapping_hash: binding.private_mapping_hash,
    };
  });
  const payload: Omit<JudgeEvidencePrecommitManifest, "manifest_hash"> = {
    schema_version: "judge-evidence-precommit-manifest-v1",
    artifact_kind: "JUDGE_EVIDENCE_PRECOMMIT_MANIFEST",
    execution_pack_hash: record.execution_pack_hash,
    master_blinding_seed_commitment: record.master_blinding_seed_commitment,
    case_bindings: caseBindings,
  };
  if (sha256CanonicalJson(manifestPayload(payload)) !== record.manifest_hash) {
    throw new TypeError("Judge evidence precommit manifest hash 무결성이 다릅니다.");
  }
  return deepFreeze({
    ...payload,
    manifest_hash: record.manifest_hash,
  });
}

export function deriveOpaqueEvidenceHandle({
  masterBlindingSeed,
  executionPackHash,
  domain,
  payload,
}: {
  masterBlindingSeed: string;
  executionPackHash: string;
  domain: string;
  payload: unknown;
}): `evh_${string}` {
  assertMasterBlindingSeed(masterBlindingSeed);
  assertSha256(executionPackHash, "executionPackHash");
  if (
    typeof domain !== "string"
    || domain.length === 0
    || !/^[A-Z0-9_]+$/.test(domain)
  ) {
    throw new TypeError("opaque evidence handle domain은 대문자 식별자여야 합니다.");
  }
  return `evh_${hmacHex(masterBlindingSeed, {
    schema_version: "execution-pack-bound-evidence-handle-v1",
    execution_pack_hash: executionPackHash,
    domain,
    payload,
  })}`;
}

export function assertOpaqueEvidenceHandle(
  value: unknown,
  location: string,
): asserts value is `evh_${string}` {
  if (typeof value !== "string" || !OPAQUE_HANDLE_PATTERN.test(value)) {
    throw new TypeError(`${location}는 execution-bound opaque evidence handle이어야 합니다.`);
  }
}

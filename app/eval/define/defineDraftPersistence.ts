import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertCanonicalLifecycleDirectory,
  persistCanonicalLifecycleFile,
  readCanonicalLifecycleFile,
} from "../lifecycle/canonicalLifecyclePersistence";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import { assertNoPotentialSecret } from "../runtime/secretSafety";
import {
  parseDefineStructuringInput,
  parseDefineSuggestion,
  type DefineBusinessBrief,
  type DefineConstraint,
  type DefineProhibitedAction,
  type DefineSourceManifest,
  type DefineSuggestion,
} from "./defineContracts";
import {
  assertPersistedDefineStructuringArtifact,
  type DefineStructuringArtifact,
} from "./defineStructuringPersistence";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CLAIM_FILENAME = "define-draft--claim.json";
const RECORD_FILENAME_PATTERN =
  /^define-draft--record-([a-f0-9]{64})\.json$/;

type JsonRecord = Record<string, unknown>;

export interface DefineDraftPack {
  readonly schema_version: "define-draft-pack-v1";
  readonly artifact_kind: "DEFINE_DRAFT_PACK";
  readonly synthetic: true;
  readonly state: "DRAFT";
  readonly authority: "ADVISORY_ONLY";
  readonly human_approval_status: "REQUIRED";
  readonly evaluation_status: "EVALUATION_INCOMPLETE";
  readonly baseline_version: null;
  readonly business_brief: DefineBusinessBrief;
  readonly constraints: readonly DefineConstraint[];
  readonly prohibited_actions: readonly DefineProhibitedAction[];
  readonly source_manifest: DefineSourceManifest;
  readonly suggestion: DefineSuggestion;
  readonly define_input_hash: string;
  readonly define_suggestion_hash: string;
  readonly source_artifact_hash: string;
  readonly draft_hash: string;
}

interface DefineDraftPayload
  extends Omit<DefineDraftPack, "draft_hash"> {}

interface DefineDraftClaim {
  readonly schema_version: "define-draft-claim-v1";
  readonly artifact_kind: "DEFINE_DRAFT_CLAIM";
  readonly define_input_hash: string;
  readonly draft_hash: string;
}

interface CanonicalWrapper<T> {
  readonly payload_sha256: string;
  readonly payload: T;
}

export interface PersistDefineDraftPackResult {
  readonly path: string;
  readonly created: boolean;
  readonly draftHash: string;
}

const persistedDefineDraftPacks = new WeakSet<object>();

function integrity(message: string, cause?: unknown): TypeError {
  return new TypeError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw integrity(`${label}은 plain JSON 객체여야 합니다.`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw integrity(`${label}의 exact key 계약이 다릅니다.`);
  }
}

function sha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw integrity(`${label}는 lowercase SHA-256이어야 합니다.`);
  }
}

function wrapper<T>(payload: T): CanonicalWrapper<T> {
  return {
    payload_sha256: sha256CanonicalJson(payload),
    payload,
  };
}

function parseWrapper(value: unknown, label: string): unknown {
  const parsed = record(value, `${label} wrapper`);
  exactKeys(parsed, ["payload_sha256", "payload"], `${label} wrapper`);
  sha256(parsed.payload_sha256, `${label} wrapper.payload_sha256`);
  if (sha256CanonicalJson(parsed.payload) !== parsed.payload_sha256) {
    throw integrity(`${label} wrapper hash 무결성이 다릅니다.`);
  }
  return parsed.payload;
}

function payloadFromSource(
  source: DefineStructuringArtifact,
): DefineDraftPayload {
  assertPersistedDefineStructuringArtifact(source);
  if (
    source.run_record.structuringStatus !== "SUGGESTION_COMPLETE"
    || source.run_record.suggestion === null
  ) {
    throw integrity(
      "완료되어 source-reload된 Define suggestion만 Draft Pack으로 만들 수 있습니다.",
    );
  }
  const input = parseDefineStructuringInput(source.define_input);
  const suggestion = parseDefineSuggestion(source.run_record.suggestion, input);
  return {
    schema_version: "define-draft-pack-v1",
    artifact_kind: "DEFINE_DRAFT_PACK",
    synthetic: true,
    state: "DRAFT",
    authority: "ADVISORY_ONLY",
    human_approval_status: "REQUIRED",
    evaluation_status: "EVALUATION_INCOMPLETE",
    baseline_version: null,
    business_brief: structuredClone(input.business_brief),
    constraints: structuredClone(input.constraints),
    prohibited_actions: structuredClone(input.prohibited_actions),
    source_manifest: structuredClone(input.source_manifest),
    suggestion: structuredClone(suggestion),
    define_input_hash: sha256CanonicalJson(input),
    define_suggestion_hash: sha256CanonicalJson(suggestion),
    source_artifact_hash: source.artifact_hash,
  };
}

export function buildDefineDraftPack({
  source,
}: {
  readonly source: DefineStructuringArtifact;
}): DefineDraftPack {
  const payload = payloadFromSource(source);
  const pack = {
    ...payload,
    draft_hash: sha256CanonicalJson(payload),
  };
  assertNoPotentialSecret(pack, "Define Draft Pack");
  return deepFreeze(pack);
}

export function parseDefineDraftPack(value: unknown): DefineDraftPack {
  const parsed = record(value, "Define Draft Pack");
  exactKeys(parsed, [
    "schema_version",
    "artifact_kind",
    "synthetic",
    "state",
    "authority",
    "human_approval_status",
    "evaluation_status",
    "baseline_version",
    "business_brief",
    "constraints",
    "prohibited_actions",
    "source_manifest",
    "suggestion",
    "define_input_hash",
    "define_suggestion_hash",
    "source_artifact_hash",
    "draft_hash",
  ], "Define Draft Pack");
  if (
    parsed.schema_version !== "define-draft-pack-v1"
    || parsed.artifact_kind !== "DEFINE_DRAFT_PACK"
    || parsed.synthetic !== true
    || parsed.state !== "DRAFT"
    || parsed.authority !== "ADVISORY_ONLY"
    || parsed.human_approval_status !== "REQUIRED"
    || parsed.evaluation_status !== "EVALUATION_INCOMPLETE"
    || parsed.baseline_version !== null
  ) {
    throw integrity("Define Draft Pack 상태·권위 계약이 다릅니다.");
  }
  for (const [key, candidate] of [
    ["define_input_hash", parsed.define_input_hash],
    ["define_suggestion_hash", parsed.define_suggestion_hash],
    ["source_artifact_hash", parsed.source_artifact_hash],
    ["draft_hash", parsed.draft_hash],
  ] as const) {
    sha256(candidate, `Define Draft Pack.${key}`);
  }
  const input = parseDefineStructuringInput({
    schema_version: "define-structuring-input-v1",
    synthetic: true,
    business_brief: parsed.business_brief,
    constraints: parsed.constraints,
    prohibited_actions: parsed.prohibited_actions,
    source_manifest: parsed.source_manifest,
  });
  const suggestion = parseDefineSuggestion(parsed.suggestion, input);
  if (
    sha256CanonicalJson(input) !== parsed.define_input_hash
    || sha256CanonicalJson(suggestion) !== parsed.define_suggestion_hash
  ) {
    throw integrity("Define Draft Pack 입력·suggestion hash가 다릅니다.");
  }
  const payload: DefineDraftPayload = {
    schema_version: "define-draft-pack-v1",
    artifact_kind: "DEFINE_DRAFT_PACK",
    synthetic: true,
    state: "DRAFT",
    authority: "ADVISORY_ONLY",
    human_approval_status: "REQUIRED",
    evaluation_status: "EVALUATION_INCOMPLETE",
    baseline_version: null,
    business_brief: input.business_brief,
    constraints: input.constraints,
    prohibited_actions: input.prohibited_actions,
    source_manifest: input.source_manifest,
    suggestion,
    define_input_hash: parsed.define_input_hash,
    define_suggestion_hash: parsed.define_suggestion_hash,
    source_artifact_hash: parsed.source_artifact_hash as string,
  };
  if (sha256CanonicalJson(payload) !== parsed.draft_hash) {
    throw integrity("Define Draft Pack content hash가 다릅니다.");
  }
  const pack = {
    ...payload,
    draft_hash: parsed.draft_hash,
  };
  assertNoPotentialSecret(pack, "Define Draft Pack");
  return deepFreeze(pack);
}

function pathsFor(
  outputDirectory: string,
  defineInputHash: string,
  draftHash: string,
) {
  sha256(defineInputHash, "defineInputHash");
  sha256(draftHash, "draftHash");
  const rootDirectory = resolve(outputDirectory);
  const artifactDirectory = join(
    rootDirectory,
    `define-draft-${defineInputHash}`,
  );
  return {
    rootDirectory,
    artifactDirectory,
    claimPath: join(artifactDirectory, CLAIM_FILENAME),
    recordPath: join(
      artifactDirectory,
      `define-draft--record-${draftHash}.json`,
    ),
  };
}

function parseClaim(
  value: unknown,
  expectedInputHash: string,
  expectedDraftHash?: string,
): DefineDraftClaim {
  const claim = record(value, "Define Draft claim");
  exactKeys(claim, [
    "schema_version",
    "artifact_kind",
    "define_input_hash",
    "draft_hash",
  ], "Define Draft claim");
  if (
    claim.schema_version !== "define-draft-claim-v1"
    || claim.artifact_kind !== "DEFINE_DRAFT_CLAIM"
    || claim.define_input_hash !== expectedInputHash
  ) {
    throw integrity("Define Draft claim이 입력 identity와 다릅니다.");
  }
  sha256(claim.draft_hash, "Define Draft claim.draft_hash");
  if (
    expectedDraftHash !== undefined
    && claim.draft_hash !== expectedDraftHash
  ) {
    throw integrity(
      "같은 Define input에 다른 draft fork claim이 이미 존재합니다.",
    );
  }
  return deepFreeze({
    schema_version: "define-draft-claim-v1",
    artifact_kind: "DEFINE_DRAFT_CLAIM",
    define_input_hash: expectedInputHash,
    draft_hash: claim.draft_hash,
  });
}

async function assertExactDirectoryFiles({
  artifactDirectory,
  draftHash,
}: {
  readonly artifactDirectory: string;
  readonly draftHash: string;
}): Promise<void> {
  const expectedRecord = `define-draft--record-${draftHash}.json`;
  const entries = (await readdir(artifactDirectory)).sort();
  const expected = [CLAIM_FILENAME, expectedRecord].sort();
  if (
    entries.length !== expected.length
    || entries.some((entry, index) => entry !== expected[index])
  ) {
    throw integrity(
      "Define Draft 디렉터리에 fork·rollback·임시 artifact가 있습니다.",
    );
  }
}

export async function persistDefineDraftPack({
  outputDirectory,
  pack,
  source,
}: {
  readonly outputDirectory: string;
  readonly pack: DefineDraftPack;
  readonly source: DefineStructuringArtifact;
}): Promise<PersistDefineDraftPackResult> {
  const parsed = parseDefineDraftPack(pack);
  const rebuilt = buildDefineDraftPack({ source });
  if (canonicalJsonStringify(parsed) !== canonicalJsonStringify(rebuilt)) {
    throw integrity(
      "Define Draft Pack이 source-reload한 upstream structuring artifact의 재빌드 결과와 다릅니다.",
    );
  }
  const paths = pathsFor(
    outputDirectory,
    parsed.define_input_hash,
    parsed.draft_hash,
  );
  const claim: DefineDraftClaim = {
    schema_version: "define-draft-claim-v1",
    artifact_kind: "DEFINE_DRAFT_CLAIM",
    define_input_hash: parsed.define_input_hash,
    draft_hash: parsed.draft_hash,
  };
  await persistCanonicalLifecycleFile({
    ...paths,
    filePath: paths.claimPath,
    value: wrapper(claim),
    label: "Define Draft claim",
  });
  const persisted = await persistCanonicalLifecycleFile({
    ...paths,
    filePath: paths.recordPath,
    value: wrapper(parsed),
    label: "Define Draft record",
  });
  await assertExactDirectoryFiles({
    artifactDirectory: paths.artifactDirectory,
    draftHash: parsed.draft_hash,
  });
  return Object.freeze({
    path: persisted.path,
    created: persisted.created,
    draftHash: parsed.draft_hash,
  });
}

export async function loadDefineDraftPack({
  outputDirectory,
  path,
  source,
}: {
  readonly outputDirectory: string;
  readonly path: string;
  readonly source: DefineStructuringArtifact;
}): Promise<DefineDraftPack> {
  const expectedPack = buildDefineDraftPack({ source });
  const expectedDefineInputHash = expectedPack.define_input_hash;
  sha256(expectedDefineInputHash, "expectedDefineInputHash");
  const filename = RECORD_FILENAME_PATTERN.exec(basename(path));
  if (!filename || resolve(path) !== path) {
    throw integrity("Define Draft record 경로가 content-addressed 좌표가 아닙니다.");
  }
  const expectedDraftHash = filename[1]!;
  const paths = pathsFor(
    outputDirectory,
    expectedDefineInputHash,
    expectedDraftHash,
  );
  if (
    resolve(path) !== paths.recordPath
    || dirname(path) !== paths.artifactDirectory
  ) {
    throw integrity("Define Draft record가 기대한 authority 디렉터리 밖입니다.");
  }
  await assertCanonicalLifecycleDirectory(paths);
  const claimFile = await readCanonicalLifecycleFile({
    path: paths.claimPath,
    label: "Define Draft claim",
  });
  const claim = parseClaim(
    parseWrapper(claimFile.value, "Define Draft claim"),
    expectedDefineInputHash,
    expectedDraftHash,
  );
  const recordFile = await readCanonicalLifecycleFile({
    path,
    label: "Define Draft record",
  });
  const pack = parseDefineDraftPack(
    parseWrapper(recordFile.value, "Define Draft record"),
  );
  if (
    pack.define_input_hash !== expectedDefineInputHash
    || pack.draft_hash !== expectedDraftHash
    || claim.draft_hash !== pack.draft_hash
    || canonicalJsonStringify(pack) !== canonicalJsonStringify(expectedPack)
    || canonicalJsonStringify(wrapper(pack))
      !== canonicalJsonStringify(recordFile.value)
  ) {
    throw integrity("Define Draft claim·record·filename binding이 다릅니다.");
  }
  await assertExactDirectoryFiles({
    artifactDirectory: paths.artifactDirectory,
    draftHash: pack.draft_hash,
  });
  persistedDefineDraftPacks.add(pack);
  return pack;
}

export function assertPersistedDefineDraftPack(
  value: unknown,
): asserts value is DefineDraftPack {
  if (
    typeof value !== "object"
    || value === null
    || !persistedDefineDraftPacks.has(value)
  ) {
    throw integrity(
      "Define Draft Pack은 canonical write-once 저장 뒤 source reload한 객체여야 합니다.",
    );
  }
  parseDefineDraftPack(value);
}

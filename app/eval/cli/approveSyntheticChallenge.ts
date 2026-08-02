import { dirname, resolve } from "node:path";
import { prepareWriteOnceArtifactDirectory } from "../pack/persistence";
import { pathToFileURL } from "node:url";
import {
  createLockedChallengePack,
  type CreateLockedChallengePackInput,
  type LockedChallengePack,
} from "../define/defineContracts";
import {
  assertPersistedDefineStructuringArtifact,
  loadDefineStructuringArtifact,
  type DefineStructuringArtifact,
} from "../define/defineStructuringPersistence";
import {
  loadLockedChallengeAuthorityRecord,
  persistLockedChallengeAuthorityRecord,
} from "../define/lockedChallengePersistence";
import {
  SYNTHETIC_CHALLENGE_TEMPLATE,
} from "../define/syntheticChallengeDefinition";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../runtime/canonicalJson";
import { redactSensitiveText } from "./calibrationOutcome";
import {
  DEFAULT_DEFINE_STRUCTURING_OUTPUT_DIRECTORY,
} from "./runDefineStructure";

export const SYNTHETIC_CHALLENGE_APPROVAL_ACKNOWLEDGEMENT_ENV =
  "AI_DEFINE_APPROVAL_ACKNOWLEDGEMENT";
export const SYNTHETIC_CHALLENGE_ARTIFACT_PATH_ENV =
  "AI_DEFINE_STRUCTURING_ARTIFACT_PATH";
export const LOCKED_CHALLENGE_AUTHORITY_DIRECTORY_ENV =
  "AI_LOCKED_CHALLENGE_AUTHORITY_DIRECTORY";
export const SYNTHETIC_CHALLENGE_APPROVAL_PREFIX =
  "APPROVE_SYNTHETIC_CHALLENGE_EXACT_CONTRACT_V1";

export const DEFAULT_LOCKED_CHALLENGE_AUTHORITY_DIRECTORY = resolve(
  import.meta.dirname,
  "../../.runtime/locked-challenge-approved",
);

function buildSyntheticChallengeApprovalAcknowledgement(
  artifactHash: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(artifactHash)) {
    throw new TypeError("Define structuring artifact hash 형식이 다릅니다.");
  }
  const fixedContractHash = sha256CanonicalJson(
    SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract,
  );
  return [
    SYNTHETIC_CHALLENGE_APPROVAL_PREFIX,
    artifactHash,
    fixedContractHash,
  ].join(":");
}

export interface SyntheticChallengeApprovalSummary {
  readonly command_status:
    | "LOCKED_CHALLENGE_READY"
    | "CHALLENGE_APPROVAL_REJECTED";
  readonly synthetic: true;
  readonly authority:
    | "EXPLICIT_HUMAN_APPROVAL"
    | "NOT_GRANTED";
  readonly human_approval_recorded: boolean;
  readonly source_define_artifact_hash: string | null;
  readonly source_define_suggestion_hash: string | null;
  readonly challenge_id: string | null;
  readonly challenge_version: string | null;
  readonly locked_challenge_pack_hash: string | null;
  readonly record_path: string | null;
  readonly created: boolean | null;
  readonly required_acknowledgement?: string;
  readonly error?: string;
}

export interface SyntheticChallengeApprovalOutcome {
  readonly exitCode: 0 | 1;
  readonly summary: SyntheticChallengeApprovalSummary;
  readonly serverAuthority: {
    readonly lockedChallengePack: LockedChallengePack;
  } | null;
}

interface SyntheticChallengeApprovalDependencies {
  readonly loadStructuringArtifact: typeof loadDefineStructuringArtifact;
  readonly persistLockedChallenge: typeof persistLockedChallengeAuthorityRecord;
  readonly loadLockedChallenge: typeof loadLockedChallengeAuthorityRecord;
}

const PRODUCTION_APPROVAL_DEPENDENCIES:
SyntheticChallengeApprovalDependencies = {
  loadStructuringArtifact: loadDefineStructuringArtifact,
  persistLockedChallenge: persistLockedChallengeAuthorityRecord,
  loadLockedChallenge: loadLockedChallengeAuthorityRecord,
};

interface ExecuteSyntheticChallengeApprovalCommandOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly approvedAt?: () => string;
  readonly dependencies?: SyntheticChallengeApprovalDependencies;
}

interface TtyApprovalProof {
  readonly kind: "SYNTHETIC_CHALLENGE_TTY_APPROVAL_PROOF";
}

const activeTtyApprovalProofs = new WeakSet<object>();

function createTtyApprovalProof(): TtyApprovalProof {
  const proof = Object.freeze({
    kind: "SYNTHETIC_CHALLENGE_TTY_APPROVAL_PROOF" as const,
  });
  activeTtyApprovalProofs.add(proof);
  return proof;
}

function consumeTtyApprovalProof(proof: TtyApprovalProof): void {
  if (!activeTtyApprovalProofs.delete(proof)) {
    throw new TypeError(
      "Challenge approval에는 module-private 일회성 TTY 증거가 필요합니다.",
    );
  }
}

function readRequiredPath(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback?: string,
): string {
  const value = environment[name]?.trim() || fallback;
  if (!value || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${name}에 canonical authority 경로가 필요합니다.`);
  }
  const absolute = resolve(value);
  if (absolute !== value && fallback === undefined) {
    throw new TypeError(`${name}는 절대 경로여야 합니다.`);
  }
  return absolute;
}

function buildHumanApprovedCreationInput({
  artifact,
  approvedAt,
}: {
  readonly artifact: DefineStructuringArtifact;
  readonly approvedAt: string;
}): CreateLockedChallengePackInput {
  assertPersistedDefineStructuringArtifact(artifact);
  if (
    artifact.run_record.structuringStatus !== "SUGGESTION_COMPLETE"
    || artifact.run_record.suggestion === null
  ) {
    throw new TypeError(
      "완료된 advisory Define suggestion이 없으면 Challenge를 잠글 수 없습니다.",
    );
  }
  const template = SYNTHETIC_CHALLENGE_TEMPLATE;
  if (
    canonicalJsonStringify(artifact.define_input)
      !== canonicalJsonStringify(template.defineInput)
  ) {
    throw new TypeError(
      "사람 승인 대상 Define 입력이 잠긴 합성 업무 입력과 다릅니다.",
    );
  }
  return {
    defineInput: artifact.define_input,
    defineSuggestion: artifact.run_record.suggestion,
    approval: {
      schema_version: "human-challenge-approval-v1",
      synthetic: true,
      actor_type: "HUMAN",
      actor_label: "Synthetic evaluation lead",
      decision: "APPROVE_EXACT_CONTRACT",
      approved_at: approvedAt,
      define_input_hash: sha256CanonicalJson(artifact.define_input),
      define_suggestion_hash:
        sha256CanonicalJson(artifact.run_record.suggestion),
      // GPT 제안이 이 고정 계약을 자동 변경하지 않습니다.
      approved_contract: structuredClone(
        template.approvedContract,
      ),
    },
  };
}

function rejectedOutcome({
  error,
  artifactHash = null,
  requiredAcknowledgement,
}: {
  readonly error: unknown;
  readonly artifactHash?: string | null;
  readonly requiredAcknowledgement?: string;
}): SyntheticChallengeApprovalOutcome {
  const message = redactSensitiveText(
    error instanceof Error ? error.message : String(error),
  );
  return Object.freeze({
    exitCode: 1,
    summary: Object.freeze({
      command_status: "CHALLENGE_APPROVAL_REJECTED",
      synthetic: true,
      authority: "NOT_GRANTED",
      human_approval_recorded: false,
      source_define_artifact_hash: artifactHash,
      source_define_suggestion_hash: null,
      challenge_id: null,
      challenge_version: null,
      locked_challenge_pack_hash: null,
      record_path: null,
      created: null,
      ...(requiredAcknowledgement
        ? { required_acknowledgement: requiredAcknowledgement }
        : {}),
      error: message,
    }),
    serverAuthority: null,
  });
}

async function executeSyntheticChallengeApprovalCommand(
  {
    environment,
    approvedAt = () => new Date().toISOString(),
    dependencies = PRODUCTION_APPROVAL_DEPENDENCIES,
  }: ExecuteSyntheticChallengeApprovalCommandOptions,
  ttyApprovalProof: TtyApprovalProof,
): Promise<
  SyntheticChallengeApprovalOutcome
> {
  consumeTtyApprovalProof(ttyApprovalProof);
  let artifact: DefineStructuringArtifact | null = null;
  let requiredAcknowledgement: string | undefined;
  try {
    const structuringOutputDirectory = readRequiredPath(
      environment,
      "AI_DEFINE_STRUCTURING_OUTPUT_DIR",
      DEFAULT_DEFINE_STRUCTURING_OUTPUT_DIRECTORY,
    );
    const artifactPath = readRequiredPath(
      environment,
      SYNTHETIC_CHALLENGE_ARTIFACT_PATH_ENV,
    );
    const lockOutputDirectory = readRequiredPath(
      environment,
      LOCKED_CHALLENGE_AUTHORITY_DIRECTORY_ENV,
      DEFAULT_LOCKED_CHALLENGE_AUTHORITY_DIRECTORY,
    );
    artifact = await dependencies.loadStructuringArtifact({
      outputDirectory: structuringOutputDirectory,
      artifactPath,
      expectedInput:
        SYNTHETIC_CHALLENGE_TEMPLATE.defineInput,
    });
    assertPersistedDefineStructuringArtifact(artifact);
    if (
      artifact.run_record.structuringStatus !== "SUGGESTION_COMPLETE"
      || artifact.run_record.suggestion === null
    ) {
      throw new TypeError(
        "완료된 advisory Define suggestion이 없으면 Challenge를 잠글 수 없습니다.",
      );
    }
    requiredAcknowledgement =
      buildSyntheticChallengeApprovalAcknowledgement(artifact.artifact_hash);
    if (
      environment[SYNTHETIC_CHALLENGE_APPROVAL_ACKNOWLEDGEMENT_ENV]
        !== requiredAcknowledgement
    ) {
      throw new TypeError(
        "현재 Define artifact와 고정 계약을 승인하는 exact acknowledgement가 다릅니다.",
      );
    }
    const creationInput = buildHumanApprovedCreationInput({
      artifact,
      approvedAt: approvedAt(),
    });
    const pack = createLockedChallengePack(creationInput);
    await prepareWriteOnceArtifactDirectory({
      rootDirectory: dirname(lockOutputDirectory),
      artifactDirectory: lockOutputDirectory,
    });
    const persisted = await dependencies.persistLockedChallenge({
      outputDirectory: lockOutputDirectory,
      creationInput,
      pack,
    });
    const reloaded = await dependencies.loadLockedChallenge({
      outputDirectory: lockOutputDirectory,
      challengeId: pack.challenge_id,
      challengeVersion: pack.challenge_version,
    });
    if (
      reloaded.pack.locked_challenge_pack_hash
        !== pack.locked_challenge_pack_hash
      || reloaded.pack.source_define_input_hash
        !== artifact.run_record.identity.defineInputHash
      || reloaded.pack.source_define_suggestion_hash
        !== sha256CanonicalJson(artifact.run_record.suggestion)
    ) {
      throw new TypeError(
        "Locked Challenge source reload가 승인한 Define artifact와 다릅니다.",
      );
    }
    return Object.freeze({
      exitCode: 0,
      summary: Object.freeze({
        command_status: "LOCKED_CHALLENGE_READY",
        synthetic: true,
        authority: "EXPLICIT_HUMAN_APPROVAL",
        human_approval_recorded: true,
        source_define_artifact_hash: artifact.artifact_hash,
        source_define_suggestion_hash:
          reloaded.pack.source_define_suggestion_hash,
        challenge_id: reloaded.pack.challenge_id,
        challenge_version: reloaded.pack.challenge_version,
        locked_challenge_pack_hash:
          reloaded.pack.locked_challenge_pack_hash,
        record_path: persisted.path,
        created: persisted.created,
      }),
      serverAuthority: Object.freeze({
        lockedChallengePack: reloaded.pack,
      }),
    });
  } catch (error) {
    return rejectedOutcome({
      error,
      artifactHash: artifact?.artifact_hash ?? null,
      ...(requiredAcknowledgement
        ? { requiredAcknowledgement }
        : {}),
    });
  }
}

function ttyGuardMessage(): string {
  const fixedContractHash = sha256CanonicalJson(
    SYNTHETIC_CHALLENGE_TEMPLATE.approvedContract,
  );
  return [
    "Challenge 사람 승인은 stdin·stdout이 모두 대화형 TTY여야 합니다. ",
    "먼저 eval:define:structure 결과의 artifact_hash를 검토한 뒤 ",
    `${SYNTHETIC_CHALLENGE_APPROVAL_ACKNOWLEDGEMENT_ENV}=`,
    `${SYNTHETIC_CHALLENGE_APPROVAL_PREFIX}:<artifact_hash>:${fixedContractHash}`,
    "를 정확히 설정해 주세요.",
  ].join("");
}

export async function runSyntheticChallengeApprovalProcess(): Promise<
  SyntheticChallengeApprovalOutcome | null
> {
  // production export는 caller가 대체 runtime이나 dependency를 주입할 수 없고
  // 현재 Node process의 실제 PTY identity만 신뢰합니다.
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    process.stderr.write(`${ttyGuardMessage()}\n`);
    process.exitCode = 1;
    return null;
  }
  try {
    // TTY를 확인한 이 module-private 경계만 일회성 실행 증거를 만들 수 있습니다.
    const ttyApprovalProof = createTtyApprovalProof();
    const outcome = await executeSyntheticChallengeApprovalCommand(
      {
        environment: process.env,
      },
      ttyApprovalProof,
    );
    process.stdout.write(`${JSON.stringify(outcome.summary, null, 2)}\n`);
    process.exitCode = outcome.exitCode;
    return outcome;
  } catch {
    process.stderr.write(
      "Challenge approval command가 예상 밖 오류로 종료됐습니다.\n",
    );
    process.exitCode = 1;
    return null;
  }
}

function isDirectExecution(
  metaUrl: string,
  argvEntry: string | undefined,
): boolean {
  return argvEntry !== undefined
    && metaUrl === pathToFileURL(resolve(argvEntry)).href;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void runSyntheticChallengeApprovalProcess();
}

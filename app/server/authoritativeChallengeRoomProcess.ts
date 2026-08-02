import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_RECORDED_REGRESSION_OUTPUT_DIRECTORY,
  DEFAULT_RECORDED_REGRESSION_SUFFICIENCY,
  executeProductionRecordedRegression,
} from "../eval/cli/runRecordedRegression";
import { requireOpenAiApiKey } from "../eval/cli/config";
import {
  buildProvisionalDecisionMemo,
  loadProvisionalDecisionMemo,
  persistProvisionalDecisionMemo,
} from "../eval/decision/provisionalMemo";
import {
  type FinalDecisionMemoAdapter,
  loadDecisionAuthorityRecord,
  loadFinalDecisionConfirmationReceipt,
  loadFinalDecisionMemo,
  loadPersistedHumanConfirmedDecisionContext,
} from "../eval/decision/decisionBaseline";
import {
  createLazyOpenAIFinalDecisionMemoAdapter,
} from "../eval/decision/openaiFinalDecisionMemoAdapter";
import {
  loadLockedChallengeAuthorityRecord,
} from "../eval/define/lockedChallengePersistence";
import { type LockedChallengePack } from "../eval/define/defineContracts";
import { assertPersistedRecordedBenchmarkPack, type RecordedBenchmarkPack } from "../eval/pack/recordedBenchmarkPack";
import { reloadRecordedBenchmarkPackForColdStart } from "../eval/pack/coldRecordedBenchmarkReload";
import {
  assertPersistedRecordedRegressionPack,
  loadRecordedRegressionPackFromSources,
  type BuildRecordedRegressionPackInput,
  type RecordedRegressionPack,
} from "../eval/regression/regressionPack";
import {
  buildAiPreReviewReceipt,
  loadAiPreReviewReceipt,
  persistAiPreReviewReceipt,
} from "../eval/review/preReviewReceipt";
import {
  createHumanConfirmationExpectedContext,
  loadHumanConfirmationReceipt,
} from "../eval/review/humanConfirmation";
import { sha256CanonicalJson } from "../eval/runtime/canonicalJson";
import {
  createAuthoritativeRecordedWorkflowGateway,
  type AuthoritativeRecordedWorkflowGatewayOptions,
  type AuthoritativeRecordedWorkflowGatewayTestOptions,
  type AuthoritativeWorkflowControllerState,
  type PersistedRecordedRegressionLoader,
  type RecordedRegressionRunner,
} from "./authoritativeWorkflowController";
import type { ChallengeLifecycleSourceState } from "./challengeLifecycleSnapshots";
import {
  persistAndAppendAuthoritativeRuntimePhase,
} from "./authoritativeRuntimeHydration";
import { loadAuthoritativeRuntimePhaseChain } from "./authoritativeRuntimePhaseReceipt";
import {
  buildDeterministicAiPreReviewCommand,
} from "./authoritativeWorkspaceRuntime";
import {
  startAuthoritativeChallengeRoomRuntime,
  startAuthoritativeChallengeRoomRuntimeWithProviderOverridesForTest,
  type AuthoritativeChallengeRoomProviderOverridesForTest,
  type AuthoritativeChallengeRoomRuntime,
} from "./authoritativeChallengeRoomRuntime";
import type { ChallengeApiGateway } from "./challengeServer";
import { loadReadOnlyProjectionSnapshotRecord } from "./projectionRepository";
import { persistRecordedReviewProjectionSnapshot } from "./recordedWorkflowSnapshot";
import type { RecordedReviewSnapshotSources } from "./recordedWorkflowSnapshot";
import type { ProjectionSnapshot } from "./projectionRepository";
import { assertTestOnlyServerEntrypoint } from "./testOnlyServerEntrypointGuard";

/**
 * 실제 process 재시작 검증에서만 외부 provider 실행을 계수 가능한 fixture로
 * 바꾸기 위한 좁은 조립 seam입니다. workflow gateway와 hydration source 검증은
 * production composition을 그대로 사용합니다.
 */
export type AuthoritativeColdSourceReload =
  | "locked_challenge"
  | "benchmark_execution_identity"
  | "recorded_benchmark_pack"
  | "pre_review"
  | "provisional_memo"
  | "human_confirmation"
  | "human_confirmed_context"
  | "final_memo"
  | "final_confirmation"
  | "decision_authority_record"
  | "recorded_regression";

export interface AuthoritativeChallengeRoomProcessTestDependencies {
  readonly executeDefineStructureCommand?:
    NonNullable<
      AuthoritativeChallengeRoomProviderOverridesForTest[
        "executeDefineStructureCommand"
      ]
    >;
  readonly executeRecordedBenchmarkCommand?:
    NonNullable<
      AuthoritativeChallengeRoomProviderOverridesForTest[
        "executeRecordedBenchmarkCommand"
      ]
    >;
  readonly createFinalDecisionMemoAdapter?: (input: Readonly<{
    environment: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }>) => FinalDecisionMemoAdapter;
  readonly createRecordedWorkflowGateway?: (
    input: AuthoritativeRecordedWorkflowGatewayTestOptions,
  ) => ChallengeApiGateway;
  readonly createRecordedRegressionRunner?: (input: Readonly<{
    environment: NodeJS.ProcessEnv;
    outputDirectory: string;
    signal?: AbortSignal;
  }>) => RecordedRegressionRunner;
  readonly reloadRecordedBenchmarkPackForColdStart?:
    typeof reloadRecordedBenchmarkPackForColdStart;
  /** 권위 상태의 시간 결합을 재시작 테스트에서 결정적으로 고정합니다. */
  readonly now?: () => string;
  /** 재시작 E2E에서 authority artifact별 실제 cold load를 계수합니다. */
  readonly onColdSourceReload?: (
    source: AuthoritativeColdSourceReload,
  ) => void;
}

export const AUTHORITATIVE_CHALLENGE_ROOM_ENV = Object.freeze({
  rootDirectory: "AI_AUTHORITATIVE_CHALLENGE_ROOM_ROOT",
  staticDirectory: "AI_AUTHORITATIVE_WORKSPACE_STATIC_DIRECTORY",
  port: "AI_AUTHORITATIVE_WORKSPACE_PORT",
  regressionOutputDirectory:
    "AI_AUTHORITATIVE_WORKSPACE_REGRESSION_OUTPUT_DIRECTORY",
});

function optionalPath(
  environment: NodeJS.ProcessEnv,
  key: string,
  fallback: string,
): string {
  const value = environment[key]?.trim();
  if (value !== undefined && (value.length === 0 || /\p{Cc}/u.test(value))) {
    throw new TypeError(`${key} 경로가 안전하지 않습니다.`);
  }
  return resolve(value ?? fallback);
}

function portFromEnvironment(environment: NodeJS.ProcessEnv): number {
  const raw = environment[AUTHORITATIVE_CHALLENGE_ROOM_ENV.port]?.trim() ?? "4173";
  if (!/^\d{1,5}$/.test(raw)) throw new TypeError("권위 Challenge Room port가 유효하지 않습니다.");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("권위 Challenge Room port는 0~65535여야 합니다.");
  }
  return port;
}

function sourceAuthorityRef(
  value: unknown,
  name: string,
): Readonly<{ path: string; payload_sha256: string }> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "path,payload_sha256"
  ) {
    throw new TypeError(`${name} source authority reference의 exact schema가 다릅니다.`);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.path !== "string" || !record.path.startsWith("/")
    || typeof record.payload_sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(record.payload_sha256)
  ) {
    throw new TypeError(`${name} source authority reference의 path 또는 hash가 유효하지 않습니다.`);
  }
  return Object.freeze({
    path: record.path,
    payload_sha256: record.payload_sha256,
  });
}

const WORKFLOW_SOURCE_AUTHORITY_REF_NAMES = Object.freeze([
  "benchmark_execution_identity",
  "pre_review",
  "provisional_memo",
  "human_confirmation",
  "final_memo",
  "final_confirmation",
  "decision_authority_record",
  "recorded_regression",
] as const);

type WorkflowSourceAuthorityRefName =
  (typeof WORKFLOW_SOURCE_AUTHORITY_REF_NAMES)[number];

function authorityReferenceForPersistedSource({
  path,
  payload,
  name,
}: {
  readonly path: string | undefined;
  readonly payload: unknown;
  readonly name: string;
}): Readonly<{ path: string; payload_sha256: string }> {
  if (typeof path !== "string") {
    throw new TypeError(`${name} persisted authority path가 없습니다.`);
  }
  return sourceAuthorityRef({
    path,
    payload_sha256: sha256CanonicalJson(payload),
  }, name);
}

function workflowSourceAuthorityRefs({
  executionIdentity,
  preReview,
  provisionalMemo,
  state,
}: {
  readonly executionIdentity: Readonly<{ path: string; payload_sha256: string }>;
  readonly preReview: Readonly<{ path: string; payload_sha256: string }>;
  readonly provisionalMemo: Readonly<{ path: string; payload_sha256: string }>;
  readonly state: AuthoritativeWorkflowControllerState;
}): Record<WorkflowSourceAuthorityRefName, unknown> {
  const refs: Partial<Record<WorkflowSourceAuthorityRefName, unknown>> = {
    benchmark_execution_identity: sourceAuthorityRef(
      executionIdentity,
      "Benchmark execution identity",
    ),
    pre_review: sourceAuthorityRef(preReview, "pre-review"),
    provisional_memo: sourceAuthorityRef(provisionalMemo, "provisional memo"),
  };
  if (state.humanConfirmationReceipt !== undefined) {
    refs.human_confirmation = authorityReferenceForPersistedSource({
      path: state.humanConfirmationReceiptPath,
      payload: state.humanConfirmationReceipt,
      name: "Human confirmation",
    });
  }
  if (state.finalDecisionMemo !== undefined) {
    refs.final_memo = authorityReferenceForPersistedSource({
      path: state.finalDecisionMemoPath,
      payload: state.finalDecisionMemo,
      name: "Final Decision Memo",
    });
  }
  if (state.finalDecisionConfirmationReceipt !== undefined) {
    refs.final_confirmation = authorityReferenceForPersistedSource({
      path: state.finalDecisionConfirmationReceiptPath,
      payload: state.finalDecisionConfirmationReceipt,
      name: "Final Decision confirmation",
    });
  }
  if (state.decisionAuthorityRecord !== undefined) {
    refs.decision_authority_record = authorityReferenceForPersistedSource({
      path: state.decisionAuthorityRecordPath,
      payload: state.decisionAuthorityRecord,
      name: "Decision authority record",
    });
  }
  if (state.recordedRegressionPack !== undefined) {
    refs.recorded_regression = authorityReferenceForPersistedSource({
      path: state.recordedRegressionPackPath,
      payload: state.recordedRegressionPack,
      name: "Recorded Regression",
    });
  }
  return Object.freeze(refs) as Record<WorkflowSourceAuthorityRefName, unknown>;
}

function readWorkflowSourceAuthorityRefs(
  value: Record<string, unknown>,
): Readonly<Partial<Record<WorkflowSourceAuthorityRefName, Readonly<{
  path: string;
  payload_sha256: string;
}>>>> {
  const keys = Object.keys(value);
  if (
    !keys.includes("benchmark_execution_identity")
    || !keys.includes("pre_review")
    || !keys.includes("provisional_memo")
    || keys.some((key) => !WORKFLOW_SOURCE_AUTHORITY_REF_NAMES.includes(
      key as WorkflowSourceAuthorityRefName,
    ))
  ) {
    throw new TypeError("hydrated workflow source authority reference가 다릅니다.");
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [
    key,
    sourceAuthorityRef(value[key], key),
  ]))) as Partial<Record<WorkflowSourceAuthorityRefName, Readonly<{
    path: string;
    payload_sha256: string;
  }>>>;
}

function assertRefPayloadHash({
  value,
  reference,
  name,
}: {
  readonly value: unknown;
  readonly reference: Readonly<{ path: string; payload_sha256: string }>;
  readonly name: string;
}): void {
  if (sha256CanonicalJson(value) !== reference.payload_sha256) {
    throw new TypeError(`source-reloaded ${name} hash가 reference와 다릅니다.`);
  }
}

function regressionSourceFromUntrustedSnapshot(
  value: unknown,
): BuildRecordedRegressionPackInput {
  // 이 값은 권한으로 승격하지 않습니다. 바로 아래 existing persisted loader가
  // source에서 record를 재생성하고 path+canonical bytes를 대조할 때만 사용합니다.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Recorded Regression cold source snapshot이 없습니다.");
  }
  const raw = value as Partial<RecordedRegressionPack>;
  return {
    authority: raw.authority as BuildRecordedRegressionPackInput["authority"],
    selectedCandidateId: raw.selected_candidate_id as "A" | "B" | "C",
    slots: raw.slots ?? [],
    sufficiency: DEFAULT_RECORDED_REGRESSION_SUFFICIENCY,
    datasetHashes: raw.datasets as BuildRecordedRegressionPackInput["datasetHashes"],
    versionIdentities: raw.versions as BuildRecordedRegressionPackInput["versionIdentities"],
    resources: raw.resources as BuildRecordedRegressionPackInput["resources"],
    createdAt: raw.created_at as string,
  };
}

function createRecordedRegressionRunner({
  environment,
  outputDirectory,
  signal,
}: {
  readonly environment: NodeJS.ProcessEnv;
  readonly outputDirectory: string;
  readonly signal?: AbortSignal;
}): RecordedRegressionRunner {
  return async (input) => {
    const result = await executeProductionRecordedRegression({
      environment,
      outputDirectory,
      decisionBaselineRecord: input.decisionBaselineRecord,
      ...(signal ? { signal } : {}),
    });
    return Object.freeze({
      pack: result.pack,
      path: result.path,
      payloadSha256: result.payloadSha256,
    });
  };
}

const loadPersistedRecordedRegression: PersistedRecordedRegressionLoader = async ({
  result,
  decisionBaselineRecord,
}) => {
  assertPersistedRecordedRegressionPack(result.pack);
  if (
    result.payloadSha256 !== sha256CanonicalJson(result.pack)
    || result.pack.authority.decision_baseline_record_hash
      !== sha256CanonicalJson(decisionBaselineRecord)
    || result.pack.authority.baseline_version !== decisionBaselineRecord.baseline_version
    || result.pack.selected_candidate_id !== decisionBaselineRecord.selected_candidate_id
  ) {
    throw new TypeError("Recorded Regression source-reloaded pack이 active Decision baseline과 다릅니다.");
  }
  return result.pack;
};

/**
 * 직렬화된 workflow state는 진실의 원천이 아니며, source authority reference가
 * 가리키는 write-once artifact를 다시 읽어 검증한 결과만 반환합니다.
 */
export async function reloadAuthoritativeWorkflowControllerStateForColdStart({
  controllerState,
  sourceAuthorityRefs,
  initialSources,
  onColdSourceReload,
}: {
  readonly controllerState: unknown;
  readonly sourceAuthorityRefs: Readonly<Partial<Record<
    WorkflowSourceAuthorityRefName,
    Readonly<{ path: string; payload_sha256: string }>
  >>>;
  readonly initialSources: RecordedReviewSnapshotSources;
  readonly onColdSourceReload?: (
    source: AuthoritativeColdSourceReload,
  ) => void;
}): Promise<AuthoritativeWorkflowControllerState> {
  if (
    typeof controllerState !== "object"
    || controllerState === null
    || Array.isArray(controllerState)
  ) {
    throw new TypeError("hydrated workflow controller state의 exact source가 없습니다.");
  }
  const raw = controllerState as Record<string, unknown>;
  const allowed = new Set([
    "humanConfirmationReceipt",
    "humanConfirmedDecisionContext",
    "humanConfirmationReceiptPath",
    "finalDecisionMemo",
    "finalDecisionMemoPath",
    "finalDecisionConfirmationReceipt",
    "finalDecisionConfirmationReceiptPath",
    "decisionAuthorityRecord",
    "decisionAuthorityRecordPath",
    "recordedRegressionPack",
    "recordedRegressionPackPath",
    "committedSnapshotId",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new TypeError("hydrated workflow controller state의 exact schema가 다릅니다.");
  }
  const reloaded: AuthoritativeWorkflowControllerState = {};
  const humanReference = sourceAuthorityRefs.human_confirmation;
  if (humanReference !== undefined) {
    const expected = createHumanConfirmationExpectedContext({
      benchmarkPack: initialSources.recordedBenchmarkPack,
      queue: initialSources.recordedBenchmarkPack.blind_review_queue,
      preReviewReceipt: initialSources.preReviewReceipt,
      provisionalMemo: initialSources.provisionalDecisionMemo,
    });
    const humanConfirmationReceipt = await loadHumanConfirmationReceipt({
      path: humanReference.path,
      expected,
    });
    onColdSourceReload?.("human_confirmation");
    assertRefPayloadHash({
      value: humanConfirmationReceipt,
      reference: humanReference,
      name: "Human confirmation receipt",
    });
    const humanConfirmedDecisionContext =
      await loadPersistedHumanConfirmedDecisionContext({
        recordedBenchmarkPack: initialSources.recordedBenchmarkPack,
        lockedChallengePack: initialSources.lockedChallengePack,
        humanConfirmationReceiptPath: humanReference.path,
        humanConfirmationExpectedContext: expected,
      });
    onColdSourceReload?.("human_confirmed_context");
    Object.assign(reloaded, {
      humanConfirmationReceipt,
      humanConfirmationReceiptPath: humanReference.path,
      humanConfirmedDecisionContext,
    });
  } else if (
    raw.humanConfirmationReceipt !== undefined
    || raw.humanConfirmationReceiptPath !== undefined
    || raw.humanConfirmedDecisionContext !== undefined
  ) {
    throw new TypeError("hydrated Human confirmation에는 persisted authority reference가 필요합니다.");
  }
  const finalMemoReference = sourceAuthorityRefs.final_memo;
  if (finalMemoReference !== undefined) {
    if (reloaded.humanConfirmedDecisionContext === undefined) {
      throw new TypeError("Final Decision Memo cold reload에는 Human confirmation source가 필요합니다.");
    }
    const finalDecisionMemo = await loadFinalDecisionMemo({
      path: finalMemoReference.path,
      context: reloaded.humanConfirmedDecisionContext,
    });
    onColdSourceReload?.("final_memo");
    assertRefPayloadHash({
      value: finalDecisionMemo,
      reference: finalMemoReference,
      name: "Final Decision Memo",
    });
    Object.assign(reloaded, {
      finalDecisionMemo,
      finalDecisionMemoPath: finalMemoReference.path,
    });
  } else if (raw.finalDecisionMemo !== undefined || raw.finalDecisionMemoPath !== undefined) {
    throw new TypeError("hydrated Final Decision Memo에는 persisted authority reference가 필요합니다.");
  }
  const finalConfirmationReference = sourceAuthorityRefs.final_confirmation;
  if (finalConfirmationReference !== undefined) {
    if (
      reloaded.humanConfirmedDecisionContext === undefined
      || reloaded.finalDecisionMemo === undefined
    ) {
      throw new TypeError("Final confirmation cold reload에는 Human confirmation·Memo source가 필요합니다.");
    }
    const finalDecisionConfirmationReceipt =
      await loadFinalDecisionConfirmationReceipt({
        path: finalConfirmationReference.path,
        context: reloaded.humanConfirmedDecisionContext,
        finalMemo: reloaded.finalDecisionMemo,
      });
    onColdSourceReload?.("final_confirmation");
    assertRefPayloadHash({
      value: finalDecisionConfirmationReceipt,
      reference: finalConfirmationReference,
      name: "Final Decision confirmation receipt",
    });
    Object.assign(reloaded, {
      finalDecisionConfirmationReceipt,
      finalDecisionConfirmationReceiptPath: finalConfirmationReference.path,
    });
  } else if (
    raw.finalDecisionConfirmationReceipt !== undefined
    || raw.finalDecisionConfirmationReceiptPath !== undefined
  ) {
    throw new TypeError("hydrated Final confirmation에는 persisted authority reference가 필요합니다.");
  }
  const decisionReference = sourceAuthorityRefs.decision_authority_record;
  if (decisionReference !== undefined) {
    if (
      reloaded.humanConfirmedDecisionContext === undefined
      || reloaded.finalDecisionMemoPath === undefined
      || reloaded.finalDecisionConfirmationReceiptPath === undefined
    ) {
      throw new TypeError("Decision authority cold reload에는 Human/Memo/confirmation source가 필요합니다.");
    }
    const decisionAuthorityRecord = await loadDecisionAuthorityRecord({
      path: decisionReference.path,
      context: reloaded.humanConfirmedDecisionContext,
      finalMemoPath: reloaded.finalDecisionMemoPath,
      finalConfirmationReceiptPath:
        reloaded.finalDecisionConfirmationReceiptPath,
      recordedBenchmarkPack: initialSources.recordedBenchmarkPack,
    });
    onColdSourceReload?.("decision_authority_record");
    assertRefPayloadHash({
      value: decisionAuthorityRecord,
      reference: decisionReference,
      name: "Decision authority record",
    });
    Object.assign(reloaded, {
      decisionAuthorityRecord,
      decisionAuthorityRecordPath: decisionReference.path,
    });
  } else if (
    raw.decisionAuthorityRecord !== undefined
    || raw.decisionAuthorityRecordPath !== undefined
  ) {
    throw new TypeError("hydrated Decision authority에는 persisted authority reference가 필요합니다.");
  }
  const regressionReference = sourceAuthorityRefs.recorded_regression;
  if (regressionReference !== undefined) {
    if (raw.recordedRegressionPack === undefined) {
      throw new TypeError("Recorded Regression cold source snapshot이 없습니다.");
    }
    const recordedRegressionPack = await loadRecordedRegressionPackFromSources({
      path: regressionReference.path,
      source: regressionSourceFromUntrustedSnapshot(raw.recordedRegressionPack),
    });
    onColdSourceReload?.("recorded_regression");
    assertRefPayloadHash({
      value: recordedRegressionPack,
      reference: regressionReference,
      name: "Recorded Regression pack",
    });
    Object.assign(reloaded, {
      recordedRegressionPack,
      recordedRegressionPackPath: regressionReference.path,
    });
  } else if (
    raw.recordedRegressionPack !== undefined
    || raw.recordedRegressionPackPath !== undefined
  ) {
    throw new TypeError("hydrated Recorded Regression에는 persisted authority reference가 필요합니다.");
  }
  return reloaded;
}

function createRecordedReviewGateway({
  environment,
  authorityDirectory,
  projectionDirectory,
  regressionOutputDirectory,
  signal,
  now = () => new Date().toISOString(),
  dependencies,
}: {
  readonly environment: NodeJS.ProcessEnv;
  readonly authorityDirectory: string;
  readonly projectionDirectory: string;
  readonly regressionOutputDirectory: string;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
  readonly dependencies?: AuthoritativeChallengeRoomProcessTestDependencies;
}): (input: Readonly<{
  recordedBenchmarkPack: RecordedBenchmarkPack;
  lockedChallengePack: LockedChallengePack;
  lifecycleState: ChallengeLifecycleSourceState;
  hydration?: Readonly<{
    initialSources: RecordedReviewSnapshotSources;
    controllerState: AuthoritativeWorkflowControllerState;
    initialSnapshot: ProjectionSnapshot;
    sourceAuthorityRefs: Record<string, unknown>;
  }>;
}>) => Promise<ChallengeApiGateway> {
  const createWorkflowGateway = (
    options: AuthoritativeRecordedWorkflowGatewayTestOptions,
  ): ChallengeApiGateway => {
    if (dependencies?.createRecordedWorkflowGateway !== undefined) {
      return dependencies.createRecordedWorkflowGateway(options);
    }
    return createAuthoritativeRecordedWorkflowGateway(
      options as AuthoritativeRecordedWorkflowGatewayOptions,
    );
  };
  return async ({ recordedBenchmarkPack, lockedChallengePack, lifecycleState, hydration }) => {
    const assertPersistedPack: (
      value: unknown,
    ) => asserts value is RecordedBenchmarkPack =
      assertPersistedRecordedBenchmarkPack;
    if (hydration === undefined) assertPersistedPack(recordedBenchmarkPack);
    if (hydration !== undefined) {
      // phase artifact에서 source-reload한 inputs만 사용합니다. 이 경로는
      // pre-review/memo를 다시 만들지 않으므로 재시작이 외부 side effect를
      // 발생시키지 않습니다.
      const coldReloadReference = lifecycleState.recordedBenchmarkColdReloadReference;
      if (coldReloadReference === undefined) {
        throw new TypeError(
          "hydrated Recorded workflow에는 cold Benchmark authority reference가 필요합니다.",
        );
      }
      const persistedLockedChallenge =
        await loadLockedChallengeAuthorityRecord({
          outputDirectory: join(authorityDirectory, "locked-challenge"),
          challengeId: lockedChallengePack.challenge_id,
          challengeVersion: lockedChallengePack.challenge_version,
        });
      dependencies?.onColdSourceReload?.("locked_challenge");
      const reloadedLockedChallengePack = persistedLockedChallenge.pack;
      if (
        reloadedLockedChallengePack.locked_challenge_pack_hash
          !== lockedChallengePack.locked_challenge_pack_hash
        || reloadedLockedChallengePack.approved_contract_hash
          !== lockedChallengePack.approved_contract_hash
        || reloadedLockedChallengePack.source_manifest_hash
          !== lockedChallengePack.source_manifest_hash
        || reloadedLockedChallengePack.locked_challenge_pack_hash
          !== hydration.initialSources.lockedChallengePack.locked_challenge_pack_hash
      ) {
        throw new TypeError("hydrated Locked Challenge source가 persisted authority와 다릅니다.");
      }
      const reloadedBenchmarkPack = await (
        dependencies?.reloadRecordedBenchmarkPackForColdStart
        ?? reloadRecordedBenchmarkPackForColdStart
      )({
        outputDirectory: coldReloadReference.outputDirectory,
        recordedPackPath: coldReloadReference.recordedPackPath,
        recordedPackHash: coldReloadReference.recordedPackHash,
        executionIdentityAuthority: coldReloadReference.executionIdentityAuthority,
        lockedChallengePack: reloadedLockedChallengePack,
        plans: coldReloadReference.plans,
        privateBlindingSeedAuthority:
          coldReloadReference.privateBlindingSeedAuthority,
        judgeEvidencePrecommitAuthority:
          coldReloadReference.judgeEvidencePrecommitAuthority,
      });
      dependencies?.onColdSourceReload?.("benchmark_execution_identity");
      dependencies?.onColdSourceReload?.("recorded_benchmark_pack");
      const sourceAuthorityRefs = readWorkflowSourceAuthorityRefs(
        hydration.sourceAuthorityRefs,
      );
      const executionIdentityRef = sourceAuthorityRefs.benchmark_execution_identity!;
      if (
        executionIdentityRef.path
          !== coldReloadReference.executionIdentityAuthority.path
        || executionIdentityRef.payload_sha256
          !== coldReloadReference.executionIdentityAuthority.payload_sha256
      ) {
        throw new TypeError("hydrated Benchmark execution identity authority reference가 다릅니다.");
      }
      const preReviewRef = sourceAuthorityRefs.pre_review!;
      const preReviewReceipt = await loadAiPreReviewReceipt({
        path: preReviewRef.path,
        benchmarkPack: reloadedBenchmarkPack,
        queue: reloadedBenchmarkPack.blind_review_queue,
      });
      dependencies?.onColdSourceReload?.("pre_review");
      if (sha256CanonicalJson(preReviewReceipt) !== preReviewRef.payload_sha256) {
        throw new TypeError("source-reloaded pre-review receipt hash가 reference와 다릅니다.");
      }
      const memoRef = sourceAuthorityRefs.provisional_memo!;
      const provisionalDecisionMemo = await loadProvisionalDecisionMemo({
        path: memoRef.path,
        benchmarkPack: reloadedBenchmarkPack,
        queue: reloadedBenchmarkPack.blind_review_queue,
        preReviewReceipt,
      });
      dependencies?.onColdSourceReload?.("provisional_memo");
      if (sha256CanonicalJson(provisionalDecisionMemo) !== memoRef.payload_sha256) {
        throw new TypeError("source-reloaded provisional memo hash가 reference와 다릅니다.");
      }
      const initialSources = {
        ...hydration.initialSources,
        lockedChallengePack: reloadedLockedChallengePack,
        recordedBenchmarkPack: reloadedBenchmarkPack,
        preReviewReceipt,
        provisionalDecisionMemo,
      };
      const controllerState = await reloadAuthoritativeWorkflowControllerStateForColdStart({
        controllerState: hydration.controllerState,
        sourceAuthorityRefs,
        initialSources,
        onColdSourceReload: dependencies?.onColdSourceReload,
      });
      if (
        sha256CanonicalJson(reloadedBenchmarkPack)
          !== sha256CanonicalJson(recordedBenchmarkPack)
        || initialSources.lockedChallengePack.locked_challenge_pack_hash
          !== reloadedLockedChallengePack.locked_challenge_pack_hash
      ) {
        throw new TypeError("hydrated workflow source가 lifecycle source와 다릅니다.");
      }
      return createWorkflowGateway({
        initialSnapshot: hydration.initialSnapshot,
        authorityOutputDirectory: authorityDirectory,
        projectionOutputDirectory: projectionDirectory,
        initialSources,
        initialControllerState: controllerState,
        onCommittedState: async ({ state, snapshot }) => {
          const phase = state.recordedRegressionPack !== undefined
            ? "REGRESSION_RECORDED" as const
            : state.decisionAuthorityRecord !== undefined
              ? state.decisionAuthorityRecord.artifact_kind === "DECISION_BASELINE_RECORD"
                ? "DECISION_CONFIRMED" as const
                : "NO_APPROVED_CANDIDATE" as const
              : state.finalDecisionMemo !== undefined
                ? "MEMO_REVIEW_REQUIRED" as const
                : "HUMAN_CONFIRMED_REVIEW" as const;
          const current = await loadAuthoritativeRuntimePhaseChain({
            outputDirectory: authorityDirectory,
            workflowId: "synthetic-recorded-challenge",
          });
          await persistAndAppendAuthoritativeRuntimePhase({
            outputDirectory: authorityDirectory,
            projectionOutputDirectory: projectionDirectory,
            workflowId: "synthetic-recorded-challenge",
            phase,
            expectedPreviousReceiptSha256: current.head.receipt_sha256,
            lifecycleState,
            workflowState: {
              initial_sources: initialSources,
              controller_state: state,
              source_authority_refs: workflowSourceAuthorityRefs({
                executionIdentity: executionIdentityRef,
                preReview: preReviewRef,
                provisionalMemo: memoRef,
                state,
              }),
            },
            projectionSnapshot: snapshot,
          });
        },
        finalDecisionMemoAdapter: dependencies?.createFinalDecisionMemoAdapter?.({
          environment,
          ...(signal ? { signal } : {}),
        }) ?? createLazyOpenAIFinalDecisionMemoAdapter({
          resolveApiKey: () => requireOpenAiApiKey(environment),
          ...(signal ? { signal } : {}),
        }),
        recordedRegressionRunner: dependencies?.createRecordedRegressionRunner?.({
          environment,
          outputDirectory: regressionOutputDirectory,
          ...(signal ? { signal } : {}),
        }) ?? createRecordedRegressionRunner({
          environment,
          outputDirectory: regressionOutputDirectory,
          ...(signal ? { signal } : {}),
        }),
        loadPersistedRecordedRegression,
        now,
      });
    }
    const reviewedAt = now();
    const command = buildDeterministicAiPreReviewCommand({
      recordedBenchmarkPack,
      reviewedAt,
    });
    const builtReceipt = buildAiPreReviewReceipt({
      benchmarkPack: recordedBenchmarkPack,
      queue: recordedBenchmarkPack.blind_review_queue,
      command,
    });
    const persistedReceipt = await persistAiPreReviewReceipt({
      outputDirectory: authorityDirectory,
      receipt: builtReceipt,
    });
    const preReviewReceipt = await loadAiPreReviewReceipt({
      path: persistedReceipt.path,
      benchmarkPack: recordedBenchmarkPack,
      queue: recordedBenchmarkPack.blind_review_queue,
    });
    const builtMemo = buildProvisionalDecisionMemo({
      benchmarkPack: recordedBenchmarkPack,
      queue: recordedBenchmarkPack.blind_review_queue,
      preReviewReceipt,
      createdAt: reviewedAt,
    });
    const persistedMemo = await persistProvisionalDecisionMemo({
      outputDirectory: authorityDirectory,
      memo: builtMemo,
    });
    const provisionalDecisionMemo = await loadProvisionalDecisionMemo({
      path: persistedMemo.path,
      benchmarkPack: recordedBenchmarkPack,
      queue: recordedBenchmarkPack.blind_review_queue,
      preReviewReceipt,
    });
    const initialSources = {
      lockedChallengePack,
      recordedBenchmarkPack,
      preReviewReceipt,
      provisionalDecisionMemo,
    };
    const coldReloadReference = lifecycleState.recordedBenchmarkColdReloadReference;
    if (coldReloadReference === undefined) {
      throw new TypeError(
        "Recorded workflow에는 cold Benchmark execution identity authority reference가 필요합니다.",
      );
    }
    const sourceAuthorityRefs = workflowSourceAuthorityRefs({
      executionIdentity: coldReloadReference.executionIdentityAuthority,
      preReview: {
        path: persistedReceipt.path,
        payload_sha256: persistedReceipt.payloadSha256,
      },
      provisionalMemo: {
        path: persistedMemo.path,
        payload_sha256: persistedMemo.payloadSha256,
      },
      state: {},
    });
    const persistedSnapshot = await persistRecordedReviewProjectionSnapshot({
      outputDirectory: projectionDirectory,
      sources: initialSources,
    });
    const initialSnapshot = await loadReadOnlyProjectionSnapshotRecord({
      path: persistedSnapshot.path,
    });
    const runtimeHead = await loadAuthoritativeRuntimePhaseChain({
      outputDirectory: authorityDirectory,
      workflowId: "synthetic-recorded-challenge",
    });
    await persistAndAppendAuthoritativeRuntimePhase({
      outputDirectory: authorityDirectory,
      projectionOutputDirectory: projectionDirectory,
      workflowId: "synthetic-recorded-challenge",
      phase: "REVIEW_PENDING",
      expectedPreviousReceiptSha256: runtimeHead.head.receipt_sha256,
      lifecycleState,
      workflowState: {
        initial_sources: initialSources,
        controller_state: {},
        source_authority_refs: sourceAuthorityRefs,
      },
      projectionSnapshot: initialSnapshot,
    });
    const finalDecisionMemoAdapter = dependencies?.createFinalDecisionMemoAdapter?.({
      environment,
      ...(signal ? { signal } : {}),
    }) ?? createLazyOpenAIFinalDecisionMemoAdapter({
      resolveApiKey: () => requireOpenAiApiKey(environment),
      ...(signal ? { signal } : {}),
    });
    return createWorkflowGateway({
      initialSnapshot,
      authorityOutputDirectory: authorityDirectory,
      projectionOutputDirectory: projectionDirectory,
      initialSources,
      finalDecisionMemoAdapter,
      recordedRegressionRunner: dependencies?.createRecordedRegressionRunner?.({
        environment,
        outputDirectory: regressionOutputDirectory,
        ...(signal ? { signal } : {}),
      }) ?? createRecordedRegressionRunner({
        environment,
        outputDirectory: regressionOutputDirectory,
        ...(signal ? { signal } : {}),
      }),
      loadPersistedRecordedRegression,
      onCommittedState: async ({ state, snapshot }) => {
        const phase = state.recordedRegressionPack !== undefined
          ? "REGRESSION_RECORDED" as const
          : state.decisionAuthorityRecord !== undefined
            ? state.decisionAuthorityRecord.artifact_kind
                === "DECISION_BASELINE_RECORD"
              ? "DECISION_CONFIRMED" as const
              : "NO_APPROVED_CANDIDATE" as const
            : state.finalDecisionMemo !== undefined
              ? "MEMO_REVIEW_REQUIRED" as const
              : "HUMAN_CONFIRMED_REVIEW" as const;
        const current = await loadAuthoritativeRuntimePhaseChain({
          outputDirectory: authorityDirectory,
          workflowId: "synthetic-recorded-challenge",
        });
        await persistAndAppendAuthoritativeRuntimePhase({
          outputDirectory: authorityDirectory,
          projectionOutputDirectory: projectionDirectory,
          workflowId: "synthetic-recorded-challenge",
          phase,
          expectedPreviousReceiptSha256: current.head.receipt_sha256,
          lifecycleState,
          workflowState: {
            initial_sources: initialSources,
            controller_state: state,
            source_authority_refs: workflowSourceAuthorityRefs({
              executionIdentity: coldReloadReference.executionIdentityAuthority,
              preReview: {
                path: persistedReceipt.path,
                payload_sha256: persistedReceipt.payloadSha256,
              },
              provisionalMemo: {
                path: persistedMemo.path,
                payload_sha256: persistedMemo.payloadSha256,
              },
              state,
            }),
          },
          projectionSnapshot: snapshot,
        });
      },
      now,
    });
  };
}

async function startAuthoritativeChallengeRoomFromEnvironmentInternal({
  environment = process.env,
  signal,
  dependencies,
}: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly dependencies?: AuthoritativeChallengeRoomProcessTestDependencies;
} = {}): Promise<AuthoritativeChallengeRoomRuntime> {
  const rootDirectory = optionalPath(
    environment,
    AUTHORITATIVE_CHALLENGE_ROOM_ENV.rootDirectory,
    resolve(import.meta.dirname, "../.runtime/authoritative-challenge-room"),
  );
  const authorityDirectory = join(rootDirectory, "authority");
  const projectionDirectory = join(rootDirectory, "projections");
  await mkdir(authorityDirectory, { recursive: true, mode: 0o700 });
  await mkdir(projectionDirectory, { recursive: true, mode: 0o700 });
  const staticDirectory = optionalPath(
    environment,
    AUTHORITATIVE_CHALLENGE_ROOM_ENV.staticDirectory,
    resolve(import.meta.dirname, "../dist"),
  );
  const regressionOutputDirectory = optionalPath(
    environment,
    AUTHORITATIVE_CHALLENGE_ROOM_ENV.regressionOutputDirectory,
    DEFAULT_RECORDED_REGRESSION_OUTPUT_DIRECTORY,
  );
  const runtimeInput = {
    environment,
    staticDirectory,
    authorityDirectory,
    port: portFromEnvironment(environment),
    ...(signal ? { signal } : {}),
    createRecordedReviewGateway: createRecordedReviewGateway({
        environment,
        authorityDirectory,
        projectionDirectory,
        regressionOutputDirectory,
        ...(dependencies === undefined ? {} : { dependencies }),
        ...(dependencies?.now === undefined ? {} : { now: dependencies.now }),
        ...(signal ? { signal } : {}),
      }),
  };
  if (
    dependencies?.executeDefineStructureCommand === undefined
    && dependencies?.executeRecordedBenchmarkCommand === undefined
    && dependencies?.now === undefined
  ) {
    return startAuthoritativeChallengeRoomRuntime(runtimeInput);
  }
  return startAuthoritativeChallengeRoomRuntimeWithProviderOverridesForTest({
    ...runtimeInput,
    providerOverridesForTest: {
      ...(dependencies.executeDefineStructureCommand === undefined
        ? {}
        : {
          executeDefineStructureCommand:
            dependencies.executeDefineStructureCommand,
        }),
      ...(dependencies.executeRecordedBenchmarkCommand === undefined
        ? {}
        : {
          executeRecordedBenchmarkCommand:
            dependencies.executeRecordedBenchmarkCommand,
        }),
    },
    ...(dependencies.now === undefined ? {} : { nowForTest: dependencies.now }),
  });
}

export function startAuthoritativeChallengeRoomFromEnvironment({
  environment = process.env,
  signal,
}: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
} = {}): Promise<AuthoritativeChallengeRoomRuntime> {
  return startAuthoritativeChallengeRoomFromEnvironmentInternal({
    environment,
    ...(signal ? { signal } : {}),
  });
}

/** 실제 loopback 재시작 테스트 전용 process entrypoint입니다. */
export function startAuthoritativeChallengeRoomFromEnvironmentForTest(
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly dependencies?: AuthoritativeChallengeRoomProcessTestDependencies;
  } = {},
): Promise<AuthoritativeChallengeRoomRuntime> {
  assertTestOnlyServerEntrypoint();
  const {
    environment = process.env,
    signal,
    dependencies,
  } = options;
  return startAuthoritativeChallengeRoomFromEnvironmentInternal({
    environment,
    dependencies,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Reviewer bootstrap credential는 일반 로그 파이프라인으로 흘려 보내지 않습니다.
 * Direct CLI는 세 표준 stream이 모두 TTY인 경우에만 fragment URL을 표시합니다.
 * embedding caller는 runtime 반환값을 받은 뒤 자체 보안 채널로 전달해야 합니다.
 */
export function reviewerBootstrapCliOutput({
  reviewerBootstrapUrl,
  interactive,
}: {
  readonly reviewerBootstrapUrl: string | undefined;
  readonly interactive: boolean;
}): string {
  if (reviewerBootstrapUrl === undefined) {
    throw new Error("권위 listener의 reviewer bootstrap URL이 없습니다.");
  }
  if (!interactive) {
    return "AI Challenge Room · REVIEWER BOOTSTRAP · non-interactive output에서는 credential을 표시하지 않습니다. embedding caller의 보안 채널을 사용하세요.\n";
  }
  return `AI Challenge Room · REVIEWER BOOTSTRAP URL · ${reviewerBootstrapUrl}\n`;
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const abort = new AbortController();
  const shutdown = () => abort.abort(new Error("Challenge Room shutdown"));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  void startAuthoritativeChallengeRoomFromEnvironment({ signal: abort.signal })
    .then((runtime) => {
      process.stdout.write(`AI Challenge Room · AUTHORITATIVE LIFECYCLE · ${runtime.server.origin}\n`);
      process.stderr.write(
        reviewerBootstrapCliOutput({
          reviewerBootstrapUrl: runtime.server.reviewerBootstrapUrl,
          interactive: Boolean(
            process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY,
          ),
        }),
      );
      return runtime.closed;
    })
    .catch(() => {
      process.stderr.write("권위 Challenge Room runtime이 source·build preflight를 통과하지 못했습니다.\n");
      process.exitCode = 1;
    });
}

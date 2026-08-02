import {
  assertAuthoritativeDecisionBaselineRecord,
  buildDecisionAuthorityRecord,
  buildFinalDecisionConfirmationReceipt,
  buildHumanConfirmedDecisionContext,
  loadDecisionAuthorityRecord,
  loadFinalDecisionConfirmationReceipt,
  loadFinalDecisionMemo,
  loadPersistedHumanConfirmedDecisionContext,
  persistDecisionAuthorityRecord,
  persistFinalDecisionConfirmationReceipt,
  persistFinalDecisionMemo,
  runFinalDecisionMemo,
  type DecisionSelectionCommand,
  type DecisionAuthorityRecord,
  type FinalDecisionConfirmationReceipt,
  type FinalDecisionMemo,
  type FinalDecisionMemoAdapter,
  type HumanConfirmedDecisionContext,
} from "../eval/decision/decisionBaseline";
import {
  assertOfficialOpenAIFinalDecisionMemoAdapter,
  type OfficialOpenAIFinalDecisionMemoAdapter,
} from "../eval/decision/openaiFinalDecisionMemoAdapter";
import type { LockedChallengePack } from "../eval/define/defineContracts";
import {
  assertPersistedRecordedBenchmarkPack,
  type RecordedBenchmarkPack,
} from "../eval/pack/recordedBenchmarkPack";
import {
  assertPersistedRecordedRegressionPack,
  type RecordedRegressionPack,
} from "../eval/regression/regressionPack";
import {
  buildHumanConfirmationReceipt,
  createHumanConfirmationExpectedContext,
  loadHumanConfirmationReceipt,
  persistHumanConfirmationReceipt,
  type HumanConfirmationCommand,
  type HumanConfirmationCommandItem,
  type HumanConfirmationExpectedContext,
  type HumanConfirmationReceipt,
} from "../eval/review/humanConfirmation";
import {
  assertPersistedAiPreReviewReceipt,
  type AiPreReviewReceipt,
} from "../eval/review/preReviewReceipt";
import {
  assertPersistedProvisionalDecisionMemo,
  type ProvisionalDecisionMemo,
} from "../eval/decision/provisionalMemo";
import { sha256CanonicalJson } from "../eval/runtime/canonicalJson";
import type {
  ChallengeApiGateway,
  ChallengeMutationCommand,
  PublicProjection,
} from "./challengeServer";
import {
  assertAuthoritativeRecordedWorkflowProjectionSnapshot,
  buildRecordedDecisionProjectionSnapshot,
  buildRecordedReviewProjectionSnapshot,
  persistRecordedDecisionProjectionSnapshot,
  type RecordedDecisionSnapshotSources,
  type RecordedReviewSnapshotSources,
} from "./recordedWorkflowSnapshot";
import {
  createMutableProjectionGateway,
  type ProjectionMutationOperation,
  type ProjectionMutationTransitionVerifier,
} from "./mutableProjectionGateway";
import {
  blindReviewEvidenceId,
  buildPreconfirmationPublicProjection,
  reviewerBlindEvidenceHandle,
} from "./workflowProjections";
import type {
  ProjectionSnapshot,
  ProjectionSourceReference,
} from "./projectionRepository";
import { buildRecordedBlindReviewEvidenceDetailProjection } from "./recordedBlindReviewEvidence";
import { assertTestOnlyServerEntrypoint } from "./testOnlyServerEntrypointGuard";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDEMPOTENCY_KEY = /^mutation_[A-Za-z0-9_-]{3,120}$/;

type JsonRecord = Record<string, unknown>;
type RecordedMutationMethod =
  | "confirmReview"
  | "createDecisionMemo"
  | "confirmDecision"
  | "startRegression";

export class AuthoritativeWorkflowControllerIntegrityError extends Error {
  readonly code = "AUTHORITATIVE_WORKFLOW_CONTROLLER_INTEGRITY" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthoritativeWorkflowControllerIntegrityError";
  }
}

function integrity(
  message: string,
  cause?: unknown,
): AuthoritativeWorkflowControllerIntegrityError {
  return new AuthoritativeWorkflowControllerIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(Object.getOwnPropertyDescriptors(value)).every(
    (key) => typeof key === "string"
      && "value" in Object.getOwnPropertyDescriptor(value, key)!,
  );
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  location: string,
): JsonRecord {
  if (!isPlainRecord(value)) {
    throw integrity(`${location}은 plain JSON 객체여야 합니다.`);
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !allowed.has(key))
  ) {
    throw integrity(`${location}의 exact 필드 계약이 다릅니다.`);
  }
  return value;
}

function nonEmptyText(
  value: unknown,
  location: string,
  maximum = 4_000,
): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > maximum
    || /\p{Cc}/u.test(value)
  ) {
    throw integrity(`${location}은 제한 길이의 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value.trim();
}

function observedDuration(value: unknown, location: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw integrity(`${location}은 관측된 nonnegative safe integer여야 합니다.`);
  }
  return value as number;
}

function canonicalTimestamp(value: string): string {
  if (
    !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw integrity("서버 시계는 canonical ISO timestamp를 반환해야 합니다.");
  }
  return value;
}

function hash(value: unknown, location: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw integrity(`${location}은 lowercase SHA-256이어야 합니다.`);
  }
  return value;
}

function parseReviewItem(
  value: unknown,
  index: number,
): HumanConfirmationCommandItem {
  const record = exactRecord(
    value,
    [
      "item_id",
      "final_decision",
      "rationale",
      "proposal_resolution",
      "review_duration_ms",
      "edit_duration_ms",
    ],
    ["corrected_reply"],
    `review payload.items[${index}]`,
  );
  const itemId = nonEmptyText(record.item_id, `items[${index}].item_id`, 256);
  if (
    record.final_decision !== "PASS"
    && record.final_decision !== "CONFIRMED_FAIL"
  ) {
    throw integrity(`items[${index}].final_decision이 유효하지 않습니다.`);
  }
  if (
    record.proposal_resolution !== "ACCEPTED"
    && record.proposal_resolution !== "EDITED"
  ) {
    throw integrity(`items[${index}].proposal_resolution이 유효하지 않습니다.`);
  }
  return {
    item_id: itemId,
    final_decision: record.final_decision,
    rationale: nonEmptyText(record.rationale, `items[${index}].rationale`),
    proposal_resolution: record.proposal_resolution,
    ...(record.corrected_reply === undefined
      ? {}
      : {
          corrected_reply: nonEmptyText(
            record.corrected_reply,
            `items[${index}].corrected_reply`,
            20_000,
          ),
        }),
    // 이 두 값은 브라우저가 관측한 검수·수정 시간일 뿐 queue identity,
    // gate 또는 후보 승인 권위를 만들지 않습니다.
    review_duration_ms: observedDuration(
      record.review_duration_ms,
      `items[${index}].review_duration_ms`,
    ),
    edit_duration_ms: observedDuration(
      record.edit_duration_ms,
      `items[${index}].edit_duration_ms`,
    ),
  };
}

function parseReviewPayload(
  payload: ChallengeMutationCommand["payload"],
): {
  readonly action: "ACCEPT_ALL" | "CONFIRM_WITH_EDITS";
  readonly actorLabel: string;
  readonly items: HumanConfirmationCommandItem[];
} {
  const record = exactRecord(
    payload,
    ["action", "actor_label", "items"],
    [],
    "review confirmation payload",
  );
  if (
    record.action !== "ACCEPT_ALL"
    && record.action !== "CONFIRM_WITH_EDITS"
  ) {
    throw integrity(
      "현재 Decision 전이는 blind proposal의 명시적 ACCEPT_ALL 또는 CONFIRM_WITH_EDITS만 허용합니다.",
    );
  }
  if (
    !Array.isArray(record.items)
    || record.items.length > 256
  ) {
    throw integrity("review confirmation items 배열 계약이 다릅니다.");
  }
  const items = record.items;
  if (items.some((_, index) => !Object.hasOwn(items, index))) {
    throw integrity("review confirmation items에는 sparse index를 허용하지 않습니다.");
  }
  return {
    action: record.action,
    actorLabel: nonEmptyText(record.actor_label, "review actor", 256),
    items: items.map(parseReviewItem),
  };
}

function parseMemoPayload(
  payload: ChallengeMutationCommand["payload"],
): {
  readonly action:
    | "SELECT_CANDIDATE"
    | "SELECT_NO_APPROVED_CANDIDATE";
  readonly candidateId: "A" | "B" | "C" | null;
  readonly rationale: string;
} {
  const record = exactRecord(
    payload,
    ["action", "candidate_id", "rationale"],
    [],
    "decision Memo payload",
  );
  if (
    record.action === "SELECT_CANDIDATE"
    && (
      record.candidate_id !== "A"
      && record.candidate_id !== "B"
      && record.candidate_id !== "C"
    )
  ) {
    throw integrity("SELECT_CANDIDATE에는 A/B/C 후보가 필요합니다.");
  }
  if (
    record.action === "SELECT_NO_APPROVED_CANDIDATE"
    && record.candidate_id !== null
  ) {
    throw integrity("SELECT_NO_APPROVED_CANDIDATE의 candidate_id는 null이어야 합니다.");
  }
  if (
    record.action !== "SELECT_CANDIDATE"
    && record.action !== "SELECT_NO_APPROVED_CANDIDATE"
  ) {
    throw integrity("Decision selection action이 유효하지 않습니다.");
  }
  return {
    action: record.action,
    candidateId: record.candidate_id as "A" | "B" | "C" | null,
    rationale: nonEmptyText(record.rationale, "decision rationale"),
  };
}

function parseDecisionConfirmationPayload(
  payload: ChallengeMutationCommand["payload"],
): string {
  const record = exactRecord(
    payload,
    ["action", "expected_final_decision_memo_hash"],
    [],
    "decision confirmation payload",
  );
  if (record.action !== "CONFIRM") {
    throw integrity("기준선 생성 전이는 exact Memo CONFIRM만 허용합니다.");
  }
  return hash(
    record.expected_final_decision_memo_hash,
    "expected Final Decision Memo hash",
  );
}

function parseRegressionPayload(
  payload: ChallengeMutationCommand["payload"],
): void {
  exactRecord(payload ?? {}, [], [], "regression start payload");
}

function sourceReference(
  artifactKind: string,
  artifactId: string,
  payload: unknown,
): ProjectionSourceReference {
  if (!SAFE_ID.test(artifactKind) || !SAFE_ID.test(artifactId)) {
    throw integrity("권위 artifact kind 또는 identity가 안전하지 않습니다.");
  }
  return Object.freeze({
    artifact_kind: artifactKind,
    artifact_id: artifactId,
    payload_sha256: sha256CanonicalJson(payload),
  });
}

function sourceReferenceForLocked(
  value: LockedChallengePack,
): ProjectionSourceReference {
  return Object.freeze({
    artifact_kind: value.artifact_kind,
    artifact_id: value.challenge_id,
    payload_sha256: value.locked_challenge_pack_hash,
  });
}

function sourceReferenceForRecorded(
  value: RecordedBenchmarkPack,
): ProjectionSourceReference {
  return sourceReference(
    value.artifact_kind,
    value.benchmark_execution_pack.execution_hash,
    value,
  );
}

function sameSource(
  left: ProjectionSourceReference,
  right: ProjectionSourceReference,
): boolean {
  return left.artifact_kind === right.artifact_kind
    && left.artifact_id === right.artifact_id
    && left.payload_sha256 === right.payload_sha256;
}

export interface RecordedWorkflowTransitionExpectation {
  readonly appendedSources: readonly ProjectionSourceReference[];
  readonly workspace: Readonly<{
    review_id: string | null;
    decision_id: string | null;
    baseline_id: string | null;
    regression_id: string | null;
    decide_status: string;
    monitor_status: string;
  }>;
}

/**
 * snapshot 자체의 내부 무결성만으로는 권위 단계 승격을 증명할 수 없습니다.
 * 이전 chain을 정확히 보존하고, 이번 operation이 허용한 artifact만 뒤에
 * 추가했는지와 stage identity/status를 함께 확인합니다.
 */
export function assertRecordedWorkflowProjectionTransition({
  previousSnapshot,
  expectedSnapshot,
  nextSnapshot,
  expectation,
  assertExpectedSnapshotAuthority =
    assertAuthoritativeRecordedWorkflowProjectionSnapshot,
}: {
  readonly previousSnapshot: ProjectionSnapshot;
  readonly expectedSnapshot: ProjectionSnapshot;
  readonly nextSnapshot: ProjectionSnapshot;
  readonly expectation: RecordedWorkflowTransitionExpectation;
  readonly assertExpectedSnapshotAuthority?: (
    value: unknown,
  ) => asserts value is ProjectionSnapshot;
}): void {
  const authorityAssertion: (
    value: unknown,
  ) => asserts value is ProjectionSnapshot =
    assertExpectedSnapshotAuthority;
  authorityAssertion(expectedSnapshot);
  if (
    nextSnapshot.snapshot_id !== expectedSnapshot.snapshot_id
    || previousSnapshot.source_chain.length
      + expectation.appendedSources.length
      !== expectedSnapshot.source_chain.length
    || previousSnapshot.source_chain.some(
      (source, index) => !sameSource(
        source,
        expectedSnapshot.source_chain[index],
      ),
    )
    || expectation.appendedSources.some(
      (source, offset) => !sameSource(
        source,
        expectedSnapshot.source_chain[
          previousSnapshot.source_chain.length + offset
        ],
      ),
    )
  ) {
    throw integrity(
      "Recorded workflow snapshot source chain이 이전 권위 prefix와 exact append 계약을 지키지 않았습니다.",
    );
  }
  const lastSource = expectation.appendedSources.at(-1);
  const workspace = expectedSnapshot.projections.workspace;
  const statuses = workspace.stage_statuses;
  if (
    lastSource === undefined
    || workspace.source_hash !== lastSource.payload_sha256
    || !isPlainRecord(statuses)
    || workspace.review_id !== expectation.workspace.review_id
    || workspace.decision_id !== expectation.workspace.decision_id
    || workspace.baseline_id !== expectation.workspace.baseline_id
    || workspace.regression_id !== expectation.workspace.regression_id
    || statuses.decide !== expectation.workspace.decide_status
    || statuses.monitor !== expectation.workspace.monitor_status
  ) {
    throw integrity(
      "Recorded workflow snapshot의 source hash 또는 stage transition이 기대 상태와 다릅니다.",
    );
  }
}

function workspaceText(
  snapshot: ProjectionSnapshot,
  field: string,
): string | null {
  const value = snapshot.projections.workspace[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function assertOperationCommand({
  command,
  currentSnapshot,
  schemaVersion,
  targetField,
  expectedSource,
}: {
  readonly command: ChallengeMutationCommand;
  readonly currentSnapshot: ProjectionSnapshot;
  readonly schemaVersion: string;
  readonly targetField: "review_id" | "decision_id" | "baseline_id";
  readonly expectedSource: unknown;
}): void {
  const expectedSourceHash = sha256CanonicalJson(expectedSource);
  if (
    command.schema_version !== schemaVersion
    || !IDEMPOTENCY_KEY.test(command.idempotency_key)
    || command.expected_source_hash !== expectedSourceHash
    || workspaceText(currentSnapshot, "source_hash") !== expectedSourceHash
    || workspaceText(currentSnapshot, targetField) !== command.target_id
  ) {
    throw integrity(
      `${schemaVersion} command가 현재 권위 source·target·idempotency와 다릅니다.`,
    );
  }
}

export interface RecordedRegressionRunnerInput {
  readonly outputDirectory: string;
  readonly decisionBaselineRecord: Extract<
    DecisionAuthorityRecord,
    { readonly artifact_kind: "DECISION_BASELINE_RECORD" }
  >;
  readonly lockedChallengePack: LockedChallengePack;
  readonly recordedBenchmarkPack: RecordedBenchmarkPack;
}

export interface RecordedRegressionRunnerResult {
  readonly pack: RecordedRegressionPack;
  readonly path: string;
  readonly payloadSha256: string;
}

export type RecordedRegressionRunner = (
  input: RecordedRegressionRunnerInput,
) => Promise<RecordedRegressionRunnerResult>;

export type PersistedRecordedRegressionLoader = (input: {
  readonly result: RecordedRegressionRunnerResult;
  readonly decisionBaselineRecord: Extract<
    DecisionAuthorityRecord,
    { readonly artifact_kind: "DECISION_BASELINE_RECORD" }
  >;
}) => Promise<RecordedRegressionPack>;

export interface AuthoritativeWorkflowControllerDependencies {
  readonly assertPersistedRecordedBenchmarkPack:
    typeof assertPersistedRecordedBenchmarkPack;
  readonly assertPersistedAiPreReviewReceipt:
    typeof assertPersistedAiPreReviewReceipt;
  readonly assertPersistedProvisionalDecisionMemo:
    typeof assertPersistedProvisionalDecisionMemo;
  readonly assertPersistedRecordedRegressionPack:
    typeof assertPersistedRecordedRegressionPack;
  readonly assertAuthoritativeDecisionBaselineRecord:
    typeof assertAuthoritativeDecisionBaselineRecord;
  readonly createHumanConfirmationExpectedContext:
    typeof createHumanConfirmationExpectedContext;
  readonly buildHumanConfirmationReceipt:
    typeof buildHumanConfirmationReceipt;
  readonly persistHumanConfirmationReceipt:
    typeof persistHumanConfirmationReceipt;
  readonly loadHumanConfirmationReceipt:
    typeof loadHumanConfirmationReceipt;
  readonly buildHumanConfirmedDecisionContext:
    typeof buildHumanConfirmedDecisionContext;
  readonly loadPersistedHumanConfirmedDecisionContext:
    typeof loadPersistedHumanConfirmedDecisionContext;
  readonly runFinalDecisionMemo: typeof runFinalDecisionMemo;
  readonly persistFinalDecisionMemo: typeof persistFinalDecisionMemo;
  readonly loadFinalDecisionMemo: typeof loadFinalDecisionMemo;
  readonly buildFinalDecisionConfirmationReceipt:
    typeof buildFinalDecisionConfirmationReceipt;
  readonly persistFinalDecisionConfirmationReceipt:
    typeof persistFinalDecisionConfirmationReceipt;
  readonly loadFinalDecisionConfirmationReceipt:
    typeof loadFinalDecisionConfirmationReceipt;
  readonly buildDecisionAuthorityRecord:
    typeof buildDecisionAuthorityRecord;
  readonly persistDecisionAuthorityRecord:
    typeof persistDecisionAuthorityRecord;
  readonly loadDecisionAuthorityRecord:
    typeof loadDecisionAuthorityRecord;
  readonly buildRecordedDecisionProjectionSnapshot:
    typeof buildRecordedDecisionProjectionSnapshot;
  readonly persistRecordedDecisionProjectionSnapshot:
    typeof persistRecordedDecisionProjectionSnapshot;
  readonly assertAuthoritativeRecordedWorkflowProjectionSnapshot:
    typeof assertAuthoritativeRecordedWorkflowProjectionSnapshot;
  readonly sha256CanonicalJson: typeof sha256CanonicalJson;
}

const DEFAULT_DEPENDENCIES: AuthoritativeWorkflowControllerDependencies =
  Object.freeze({
    assertPersistedRecordedBenchmarkPack,
    assertPersistedAiPreReviewReceipt,
    assertPersistedProvisionalDecisionMemo,
    assertPersistedRecordedRegressionPack,
    assertAuthoritativeDecisionBaselineRecord,
    createHumanConfirmationExpectedContext,
    buildHumanConfirmationReceipt,
    persistHumanConfirmationReceipt,
    loadHumanConfirmationReceipt,
    buildHumanConfirmedDecisionContext,
    loadPersistedHumanConfirmedDecisionContext,
    runFinalDecisionMemo,
    persistFinalDecisionMemo,
    loadFinalDecisionMemo,
    buildFinalDecisionConfirmationReceipt,
    persistFinalDecisionConfirmationReceipt,
    loadFinalDecisionConfirmationReceipt,
    buildDecisionAuthorityRecord,
    persistDecisionAuthorityRecord,
    loadDecisionAuthorityRecord,
    buildRecordedDecisionProjectionSnapshot,
    persistRecordedDecisionProjectionSnapshot,
    assertAuthoritativeRecordedWorkflowProjectionSnapshot,
    sha256CanonicalJson,
  });

export interface AuthoritativeWorkflowControllerState {
  readonly humanConfirmationReceipt?: HumanConfirmationReceipt;
  readonly humanConfirmedDecisionContext?: HumanConfirmedDecisionContext;
  readonly humanConfirmationReceiptPath?: string;
  readonly finalDecisionMemo?: FinalDecisionMemo;
  readonly finalDecisionMemoPath?: string;
  readonly finalDecisionConfirmationReceipt?:
    FinalDecisionConfirmationReceipt;
  readonly finalDecisionConfirmationReceiptPath?: string;
  readonly decisionAuthorityRecord?: DecisionAuthorityRecord;
  readonly decisionAuthorityRecordPath?: string;
  readonly recordedRegressionPack?: RecordedRegressionPack;
  readonly recordedRegressionPackPath?: string;
  readonly committedSnapshotId?: string;
}

interface PendingTransition {
  readonly method: RecordedMutationMethod;
  readonly idempotencyKey: string;
  readonly previousSnapshotId: string;
  readonly expectedSnapshot: ProjectionSnapshot;
  readonly expectation: RecordedWorkflowTransitionExpectation;
  readonly nextState: AuthoritativeWorkflowControllerState;
}

export interface AuthoritativeWorkflowController {
  readonly operations: Readonly<{
    confirmReview: ProjectionMutationOperation;
    createDecisionMemo: ProjectionMutationOperation;
    confirmDecision: ProjectionMutationOperation;
    startRegression: ProjectionMutationOperation;
  }>;
  readonly transitionVerifiers: Readonly<{
    confirmReview: ProjectionMutationTransitionVerifier;
    createDecisionMemo: ProjectionMutationTransitionVerifier;
    confirmDecision: ProjectionMutationTransitionVerifier;
    startRegression: ProjectionMutationTransitionVerifier;
  }>;
}

export interface AuthoritativeWorkflowControllerOptions {
  readonly authorityOutputDirectory: string;
  readonly projectionOutputDirectory: string;
  readonly initialSources: RecordedReviewSnapshotSources;
  readonly finalDecisionMemoAdapter:
    OfficialOpenAIFinalDecisionMemoAdapter;
  readonly recordedRegressionRunner: RecordedRegressionRunner;
  readonly loadPersistedRecordedRegression:
    PersistedRecordedRegressionLoader;
  readonly initialControllerState?: AuthoritativeWorkflowControllerState;
  readonly onCommittedState?: (input: Readonly<{
    state: AuthoritativeWorkflowControllerState;
    snapshot: ProjectionSnapshot;
  }>) => Promise<void>;
  readonly now?: () => string;
}

export interface AuthoritativeWorkflowControllerTestOptions
  extends Omit<
    AuthoritativeWorkflowControllerOptions,
    "finalDecisionMemoAdapter"
  > {
  readonly finalDecisionMemoAdapter: FinalDecisionMemoAdapter;
  readonly dependencies?: Partial<
    AuthoritativeWorkflowControllerDependencies
  >;
}

function createAuthoritativeWorkflowControllerWithDependencies({
  authorityOutputDirectory,
  projectionOutputDirectory,
  initialSources,
  finalDecisionMemoAdapter,
  recordedRegressionRunner,
  loadPersistedRecordedRegression,
  initialControllerState,
  onCommittedState,
  now = () => new Date().toISOString(),
  dependencies: overrides = {},
}: AuthoritativeWorkflowControllerTestOptions): AuthoritativeWorkflowController {
  const dependencies: AuthoritativeWorkflowControllerDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  dependencies.assertPersistedRecordedBenchmarkPack(
    initialSources.recordedBenchmarkPack,
  );
  dependencies.assertPersistedAiPreReviewReceipt(
    initialSources.preReviewReceipt,
  );
  dependencies.assertPersistedProvisionalDecisionMemo(
    initialSources.provisionalDecisionMemo,
  );
  const expectedHumanConfirmation =
    dependencies.createHumanConfirmationExpectedContext({
      benchmarkPack: initialSources.recordedBenchmarkPack,
      queue: initialSources.recordedBenchmarkPack.blind_review_queue,
      preReviewReceipt: initialSources.preReviewReceipt,
      provisionalMemo: initialSources.provisionalDecisionMemo,
    });
  let state: AuthoritativeWorkflowControllerState =
    initialControllerState === undefined ? {} : { ...initialControllerState };
  let pending: PendingTransition | null = null;
  let poisoned = false;
  let operationTail = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = operationTail.then(operation, operation);
    operationTail = next.then(() => undefined, () => undefined);
    return next;
  };

  const assertReady = (
    currentSnapshot: ProjectionSnapshot,
  ): void => {
    if (poisoned) {
      throw integrity(
        "이 컨트롤러는 실패한 transition 검증 뒤 fail-closed 상태입니다.",
      );
    }
    if (pending !== null) {
      throw integrity(
        "이전 mutation의 독립 transition 검증이 아직 완료되지 않았습니다.",
      );
    }
    if (
      state.committedSnapshotId !== undefined
      && state.committedSnapshotId !== currentSnapshot.snapshot_id
    ) {
      throw integrity("Gateway current snapshot과 controller committed state가 다릅니다.");
    }
  };

  const persistExpectedSnapshot = async (
    sources: RecordedDecisionSnapshotSources,
  ): Promise<{
    readonly expectedSnapshot: ProjectionSnapshot;
    readonly path: string;
  }> => {
    const expectedSnapshot =
      dependencies.buildRecordedDecisionProjectionSnapshot(sources);
    dependencies.assertAuthoritativeRecordedWorkflowProjectionSnapshot(
      expectedSnapshot,
    );
    const persisted =
      await dependencies.persistRecordedDecisionProjectionSnapshot({
        outputDirectory: projectionOutputDirectory,
        sources,
      });
    if (persisted.payloadSha256 !== expectedSnapshot.snapshot_id) {
      throw integrity(
        "Persisted projection snapshot hash가 권위 source 재빌드 결과와 다릅니다.",
      );
    }
    return { expectedSnapshot, path: persisted.path };
  };

  const stageTransition = ({
    method,
    command,
    currentSnapshot,
    expectedSnapshot,
    expectation,
    nextState,
  }: {
    readonly method: RecordedMutationMethod;
    readonly command: ChallengeMutationCommand;
    readonly currentSnapshot: ProjectionSnapshot;
    readonly expectedSnapshot: ProjectionSnapshot;
    readonly expectation: RecordedWorkflowTransitionExpectation;
    readonly nextState: AuthoritativeWorkflowControllerState;
  }): void => {
    if (pending !== null) {
      throw integrity("동시에 둘 이상의 transition을 stage할 수 없습니다.");
    }
    pending = {
      method,
      idempotencyKey: command.idempotency_key,
      previousSnapshotId: currentSnapshot.snapshot_id,
      expectedSnapshot,
      expectation,
      nextState,
    };
  };

  const decisionSources = (
    next: AuthoritativeWorkflowControllerState,
  ): RecordedDecisionSnapshotSources => {
    if (
      next.humanConfirmedDecisionContext === undefined
      || next.humanConfirmationReceipt === undefined
    ) {
      throw integrity("Decision snapshot에는 persisted Human confirmation이 필요합니다.");
    }
    return {
      lockedChallengePack: initialSources.lockedChallengePack,
      recordedBenchmarkPack: initialSources.recordedBenchmarkPack,
      preReviewReceipt: initialSources.preReviewReceipt,
      provisionalDecisionMemo: initialSources.provisionalDecisionMemo,
      humanConfirmedDecisionContext:
        next.humanConfirmedDecisionContext,
      humanConfirmationReceipt: next.humanConfirmationReceipt,
      ...(next.finalDecisionMemo === undefined
        ? {}
        : { finalDecisionMemo: next.finalDecisionMemo }),
      ...(next.finalDecisionConfirmationReceipt === undefined
        ? {}
        : {
            finalDecisionConfirmationReceipt:
              next.finalDecisionConfirmationReceipt,
          }),
      ...(next.decisionAuthorityRecord === undefined
        ? {}
        : { decisionAuthorityRecord: next.decisionAuthorityRecord }),
      ...(next.recordedRegressionPack === undefined
        ? {}
        : { recordedRegressionPack: next.recordedRegressionPack }),
    };
  };

  const confirmReview: ProjectionMutationOperation = (input) => enqueue(
    async () => {
      assertReady(input.currentSnapshot);
      if (state.humanConfirmedDecisionContext !== undefined) {
        throw integrity("Human confirmation은 한 번만 수행할 수 있습니다.");
      }
      assertOperationCommand({
        ...input,
        schemaVersion: "review-confirmation-command-v1",
        targetField: "review_id",
        expectedSource: initialSources.provisionalDecisionMemo,
      });
      const payload = parseReviewPayload(input.command.payload);
      const domainCommand: HumanConfirmationCommand = {
        schema_version: "human-confirmation-command-v1",
        action: payload.action,
        actor_label: payload.actorLabel,
        // 브라우저가 보낸 hash가 아니라 서버의 source-reloaded artifact
        // expected context에서 모든 결합 hash와 queue 순서를 복원합니다.
        expected_recorded_benchmark_pack_hash:
          expectedHumanConfirmation.recorded_benchmark_pack_hash,
        expected_ai_pre_review_receipt_hash:
          expectedHumanConfirmation.ai_pre_review_receipt_hash,
        expected_provisional_decision_memo_hash:
          expectedHumanConfirmation.provisional_decision_memo_hash,
        expected_queue_content_hash:
          expectedHumanConfirmation.queue_content_hash,
        expected_queue_set_order_hash:
          expectedHumanConfirmation.queue_set_order_hash,
        expected_queue_item_set_hash:
          expectedHumanConfirmation.queue_item_set_hash,
        expected_queue_item_order_hash:
          expectedHumanConfirmation.queue_item_order_hash,
        items: payload.items,
        confirmed_at: canonicalTimestamp(now()),
      };
      const builtReceipt = dependencies.buildHumanConfirmationReceipt({
        expected: expectedHumanConfirmation,
        command: domainCommand,
      });
      // write-once claim을 만들기 전에 결정적 gate 우선순위와 사람 판정
      // aggregation 전체를 검증합니다. 잘못된 편집 제출이 confirmation
      // identity를 선점해 올바른 재시도를 막아서는 안 됩니다.
      dependencies.buildHumanConfirmedDecisionContext({
        recordedBenchmarkPack: initialSources.recordedBenchmarkPack,
        lockedChallengePack: initialSources.lockedChallengePack,
        humanConfirmationReceipt: builtReceipt,
      });
      const persistedReceipt =
        await dependencies.persistHumanConfirmationReceipt({
          outputDirectory: authorityOutputDirectory,
          receipt: builtReceipt,
        });
      const loadedReceipt =
        await dependencies.loadHumanConfirmationReceipt({
          path: persistedReceipt.path,
          expected: expectedHumanConfirmation,
        });
      const context =
        await dependencies.loadPersistedHumanConfirmedDecisionContext({
          recordedBenchmarkPack: initialSources.recordedBenchmarkPack,
          lockedChallengePack: initialSources.lockedChallengePack,
          humanConfirmationReceiptPath: persistedReceipt.path,
          humanConfirmationExpectedContext: expectedHumanConfirmation,
        });
      const nextState: AuthoritativeWorkflowControllerState = {
        humanConfirmationReceipt: loadedReceipt,
        humanConfirmationReceiptPath: persistedReceipt.path,
        humanConfirmedDecisionContext: context,
      };
      const sources = decisionSources(nextState);
      const persistedSnapshot = await persistExpectedSnapshot(sources);
      const decision = persistedSnapshot.expectedSnapshot
        .projections.decisions[0] as PublicProjection | undefined;
      if (decision === undefined || typeof decision.decision_id !== "string") {
        throw integrity("Human-confirmed Decision projection identity가 없습니다.");
      }
      const appended = sourceReference(
        loadedReceipt.artifact_kind,
        loadedReceipt.confirmation_id,
        loadedReceipt,
      );
      stageTransition({
        method: "confirmReview",
        command: input.command,
        currentSnapshot: input.currentSnapshot,
        expectedSnapshot: persistedSnapshot.expectedSnapshot,
        expectation: {
          appendedSources: [appended],
          workspace: {
            review_id: null,
            decision_id: decision.decision_id,
            baseline_id: null,
            regression_id: null,
            decide_status: "HUMAN CONFIRMED REVIEW",
            monitor_status: "NO BASELINE",
          },
        },
        nextState,
      });
      return { nextSnapshotPath: persistedSnapshot.path };
    },
  );

  const createDecisionMemo: ProjectionMutationOperation = (input) => enqueue(
    async () => {
      assertReady(input.currentSnapshot);
      if (
        state.humanConfirmedDecisionContext === undefined
        || state.humanConfirmationReceipt === undefined
        || state.finalDecisionMemo !== undefined
      ) {
        throw integrity("Final Decision Memo를 생성할 현재 단계가 아닙니다.");
      }
      assertOperationCommand({
        ...input,
        schemaVersion: "decision-memo-command-v1",
        targetField: "decision_id",
        expectedSource: state.humanConfirmationReceipt,
      });
      const payload = parseMemoPayload(input.command.payload);
      const selectionCommon = {
        schema_version: "decision-selection-command-v1" as const,
        rationale: payload.rationale,
        actor_label: state.humanConfirmationReceipt.actor_label,
        expected_recorded_benchmark_pack_hash:
          state.humanConfirmedDecisionContext
            .recorded_benchmark_pack_hash,
        expected_human_confirmation_receipt_hash:
          state.humanConfirmedDecisionContext
            .human_confirmation_receipt_hash,
        expected_aggregation_hash:
          dependencies.sha256CanonicalJson(
            state.humanConfirmedDecisionContext.aggregation,
          ),
        decided_at: canonicalTimestamp(now()),
      };
      const selection: DecisionSelectionCommand =
        payload.action === "SELECT_CANDIDATE"
          ? {
              ...selectionCommon,
              action: "SELECT_CANDIDATE",
              candidate_id: payload.candidateId as "A" | "B" | "C",
            }
          : {
              ...selectionCommon,
              action: "SELECT_NO_APPROVED_CANDIDATE",
              candidate_id: null,
            };
      const memo = await dependencies.runFinalDecisionMemo({
        context: state.humanConfirmedDecisionContext,
        selection,
        adapter: finalDecisionMemoAdapter,
      });
      const persistedMemo = await dependencies.persistFinalDecisionMemo({
        outputDirectory: authorityOutputDirectory,
        memo,
      });
      const loadedMemo = await dependencies.loadFinalDecisionMemo({
        path: persistedMemo.path,
        context: state.humanConfirmedDecisionContext,
      });
      const nextState: AuthoritativeWorkflowControllerState = {
        ...state,
        finalDecisionMemo: loadedMemo,
        finalDecisionMemoPath: persistedMemo.path,
      };
      const persistedSnapshot = await persistExpectedSnapshot(
        decisionSources(nextState),
      );
      stageTransition({
        method: "createDecisionMemo",
        command: input.command,
        currentSnapshot: input.currentSnapshot,
        expectedSnapshot: persistedSnapshot.expectedSnapshot,
        expectation: {
          appendedSources: [sourceReference(
            loadedMemo.artifact_kind,
            dependencies.sha256CanonicalJson(loadedMemo),
            loadedMemo,
          )],
          workspace: {
            review_id: null,
            decision_id: input.command.target_id,
            baseline_id: null,
            regression_id: null,
            decide_status: "MEMO REVIEW REQUIRED",
            monitor_status: "NO BASELINE",
          },
        },
        nextState,
      });
      return { nextSnapshotPath: persistedSnapshot.path };
    },
  );

  const confirmDecision: ProjectionMutationOperation = (input) => enqueue(
    async () => {
      assertReady(input.currentSnapshot);
      if (
        state.humanConfirmedDecisionContext === undefined
        || state.humanConfirmationReceipt === undefined
        || state.finalDecisionMemo === undefined
        || state.finalDecisionMemoPath === undefined
        || state.decisionAuthorityRecord !== undefined
      ) {
        throw integrity("Final Decision을 확인할 현재 단계가 아닙니다.");
      }
      assertOperationCommand({
        ...input,
        schemaVersion: "decision-confirmation-command-v1",
        targetField: "decision_id",
        expectedSource: state.finalDecisionMemo,
      });
      const expectedMemoHash = parseDecisionConfirmationPayload(
        input.command.payload,
      );
      const actualMemoHash = dependencies.sha256CanonicalJson(
        state.finalDecisionMemo,
      );
      if (expectedMemoHash !== actualMemoHash) {
        throw integrity(
          "사용자가 확인한 Final Decision Memo hash가 현재 권위 Memo와 다릅니다.",
        );
      }
      const selectionHash = dependencies.sha256CanonicalJson({
        schema_version: "final-decision-selection-binding-v1",
        selection_action: state.finalDecisionMemo.selection_action,
        selected_candidate_id:
          state.finalDecisionMemo.selected_candidate_id,
        selection_rationale: state.finalDecisionMemo.selection_rationale,
        decided_by: state.finalDecisionMemo.decided_by,
        decided_at: state.finalDecisionMemo.decided_at,
      });
      const confirmation =
        dependencies.buildFinalDecisionConfirmationReceipt({
          context: state.humanConfirmedDecisionContext,
          finalMemo: state.finalDecisionMemo,
          command: {
            schema_version:
              "final-decision-confirmation-command-v1",
            action: "CONFIRM",
            actor_label: state.humanConfirmationReceipt.actor_label,
            expected_recorded_benchmark_pack_hash:
              state.humanConfirmedDecisionContext
                .recorded_benchmark_pack_hash,
            expected_human_confirmation_receipt_hash:
              state.humanConfirmedDecisionContext
                .human_confirmation_receipt_hash,
            expected_aggregation_hash:
              dependencies.sha256CanonicalJson(
                state.humanConfirmedDecisionContext.aggregation,
              ),
            expected_final_decision_memo_hash: actualMemoHash,
            expected_adapter_run_evidence_hash:
              state.finalDecisionMemo.adapter_run_evidence_hash,
            expected_selection_hash: selectionHash,
            confirmed_at: canonicalTimestamp(now()),
          },
        });
      const persistedConfirmation =
        await dependencies.persistFinalDecisionConfirmationReceipt({
          outputDirectory: authorityOutputDirectory,
          receipt: confirmation,
        });
      const loadedConfirmation =
        await dependencies.loadFinalDecisionConfirmationReceipt({
          path: persistedConfirmation.path,
          context: state.humanConfirmedDecisionContext,
          finalMemo: state.finalDecisionMemo,
        });
      const builtRecord = dependencies.buildDecisionAuthorityRecord({
        context: state.humanConfirmedDecisionContext,
        finalMemo: state.finalDecisionMemo,
        finalConfirmationReceipt: loadedConfirmation,
        recordedBenchmarkPack: initialSources.recordedBenchmarkPack,
      });
      const persistedRecord =
        await dependencies.persistDecisionAuthorityRecord({
          outputDirectory: authorityOutputDirectory,
          record: builtRecord,
          context: state.humanConfirmedDecisionContext,
          recordedBenchmarkPack: initialSources.recordedBenchmarkPack,
          finalMemoPath: state.finalDecisionMemoPath,
          finalConfirmationReceiptPath: persistedConfirmation.path,
        });
      const loadedRecord = await dependencies.loadDecisionAuthorityRecord({
        path: persistedRecord.path,
        context: state.humanConfirmedDecisionContext,
        finalMemoPath: state.finalDecisionMemoPath,
        finalConfirmationReceiptPath: persistedConfirmation.path,
        recordedBenchmarkPack: initialSources.recordedBenchmarkPack,
      });
      const nextState: AuthoritativeWorkflowControllerState = {
        ...state,
        finalDecisionConfirmationReceipt: loadedConfirmation,
        finalDecisionConfirmationReceiptPath:
          persistedConfirmation.path,
        decisionAuthorityRecord: loadedRecord,
        decisionAuthorityRecordPath: persistedRecord.path,
      };
      const persistedSnapshot = await persistExpectedSnapshot(
        decisionSources(nextState),
      );
      const hasBaseline =
        loadedRecord.artifact_kind === "DECISION_BASELINE_RECORD";
      stageTransition({
        method: "confirmDecision",
        command: input.command,
        currentSnapshot: input.currentSnapshot,
        expectedSnapshot: persistedSnapshot.expectedSnapshot,
        expectation: {
          appendedSources: [
            sourceReference(
              loadedConfirmation.artifact_kind,
              dependencies.sha256CanonicalJson(loadedConfirmation),
              loadedConfirmation,
            ),
            sourceReference(
              loadedRecord.artifact_kind,
              loadedRecord.decision_id,
              loadedRecord,
            ),
          ],
          workspace: {
            review_id: null,
            decision_id: loadedRecord.decision_id,
            baseline_id: hasBaseline
              ? loadedRecord.baseline_version
              : null,
            regression_id: null,
            decide_status: hasBaseline
              ? "DECISION CONFIRMED"
              : "NO APPROVED CANDIDATE",
            monitor_status: hasBaseline
              ? "BASELINE ACTIVE"
              : "NO BASELINE",
          },
        },
        nextState,
      });
      return { nextSnapshotPath: persistedSnapshot.path };
    },
  );

  const startRegression: ProjectionMutationOperation = (input) => enqueue(
    async () => {
      assertReady(input.currentSnapshot);
      if (
        state.decisionAuthorityRecord === undefined
        || state.decisionAuthorityRecord.artifact_kind
          !== "DECISION_BASELINE_RECORD"
        || state.recordedRegressionPack !== undefined
      ) {
        throw integrity("Recorded Regression을 실행할 active baseline이 없습니다.");
      }
      dependencies.assertAuthoritativeDecisionBaselineRecord(
        state.decisionAuthorityRecord,
      );
      assertOperationCommand({
        ...input,
        schemaVersion: "regression-start-command-v1",
        targetField: "baseline_id",
        expectedSource: state.decisionAuthorityRecord,
      });
      parseRegressionPayload(input.command.payload);
      const result = await recordedRegressionRunner({
        outputDirectory: authorityOutputDirectory,
        decisionBaselineRecord: state.decisionAuthorityRecord,
        lockedChallengePack: initialSources.lockedChallengePack,
        recordedBenchmarkPack: initialSources.recordedBenchmarkPack,
      });
      if (
        result.payloadSha256 !== dependencies.sha256CanonicalJson(result.pack)
      ) {
        throw integrity("Regression runner 결과 path/hash 계약이 다릅니다.");
      }
      const loadedPack = await loadPersistedRecordedRegression({
        result,
        decisionBaselineRecord: state.decisionAuthorityRecord,
      });
      dependencies.assertPersistedRecordedRegressionPack(loadedPack);
      if (
        dependencies.sha256CanonicalJson(loadedPack)
        !== result.payloadSha256
      ) {
        throw integrity(
          "Source-reloaded Recorded Regression pack이 runner 저장 hash와 다릅니다.",
        );
      }
      const nextState: AuthoritativeWorkflowControllerState = {
        ...state,
        recordedRegressionPack: loadedPack,
        recordedRegressionPackPath: result.path,
      };
      const persistedSnapshot = await persistExpectedSnapshot(
        decisionSources(nextState),
      );
      stageTransition({
        method: "startRegression",
        command: input.command,
        currentSnapshot: input.currentSnapshot,
        expectedSnapshot: persistedSnapshot.expectedSnapshot,
        expectation: {
          appendedSources: [sourceReference(
            loadedPack.artifact_kind,
            loadedPack.regression_id,
            loadedPack,
          )],
          workspace: {
            review_id: null,
            decision_id: state.decisionAuthorityRecord.decision_id,
            baseline_id: state.decisionAuthorityRecord.baseline_version,
            regression_id: loadedPack.regression_id,
            decide_status: "DECISION CONFIRMED",
            monitor_status: loadedPack.verdict.replaceAll("_", " "),
          },
        },
        nextState,
      });
      return { nextSnapshotPath: persistedSnapshot.path };
    },
  );

  const verifier = (
    method: RecordedMutationMethod,
  ): ProjectionMutationTransitionVerifier => async ({
    command,
    previousSnapshot,
    nextSnapshot,
  }) => {
    if (
      pending === null
      || pending.method !== method
      || pending.idempotencyKey !== command.idempotency_key
      || pending.previousSnapshotId !== previousSnapshot.snapshot_id
    ) {
      poisoned = true;
      throw integrity(
        `${method} transition verifier에 결합된 pending 권위 상태가 없습니다.`,
      );
    }
    try {
      assertRecordedWorkflowProjectionTransition({
        previousSnapshot,
        expectedSnapshot: pending.expectedSnapshot,
        nextSnapshot,
        expectation: pending.expectation,
        assertExpectedSnapshotAuthority:
          dependencies
            .assertAuthoritativeRecordedWorkflowProjectionSnapshot,
      });
      const committedState: AuthoritativeWorkflowControllerState = {
        ...pending.nextState,
        committedSnapshotId: pending.expectedSnapshot.snapshot_id,
      };
      await onCommittedState?.({
        state: committedState,
        snapshot: pending.expectedSnapshot,
      });
      state = committedState;
      pending = null;
    } catch (error) {
      poisoned = true;
      throw error;
    }
  };

  return Object.freeze({
    operations: Object.freeze({
      confirmReview,
      createDecisionMemo,
      confirmDecision,
      startRegression,
    }),
    transitionVerifiers: Object.freeze({
      confirmReview: verifier("confirmReview"),
      createDecisionMemo: verifier("createDecisionMemo"),
      confirmDecision: verifier("confirmDecision"),
      startRegression: verifier("startRegression"),
    }),
  });
}

/**
 * Production composition은 교체 불가능한 persisted-source validator와
 * deterministic snapshot builder를 TCB로 사용합니다.
 */
export function createAuthoritativeWorkflowController(
  options: AuthoritativeWorkflowControllerOptions,
): AuthoritativeWorkflowController {
  assertOfficialOpenAIFinalDecisionMemoAdapter(
    options.finalDecisionMemoAdapter,
  );
  return createAuthoritativeWorkflowControllerWithDependencies({
    authorityOutputDirectory: options.authorityOutputDirectory,
    projectionOutputDirectory: options.projectionOutputDirectory,
    initialSources: options.initialSources,
    finalDecisionMemoAdapter: options.finalDecisionMemoAdapter,
    recordedRegressionRunner: options.recordedRegressionRunner,
    loadPersistedRecordedRegression:
      options.loadPersistedRecordedRegression,
    ...(options.initialControllerState === undefined
      ? {}
      : { initialControllerState: options.initialControllerState }),
    ...(options.onCommittedState === undefined
      ? {}
      : { onCommittedState: options.onCommittedState }),
    ...(options.now === undefined ? {} : { now: options.now }),
    // 런타임 extra property로도 production TCB를 교체할 수 없습니다.
    dependencies: undefined,
  });
}

/**
 * 네트워크 없는 단위 테스트에서만 domain adapter를 대체하는 경계입니다.
 * Production server composition에서는 이 export를 사용하면 안 됩니다.
 */
export function createAuthoritativeWorkflowControllerForTest(
  options: AuthoritativeWorkflowControllerTestOptions,
): AuthoritativeWorkflowController {
  assertTestOnlyServerEntrypoint();
  return createAuthoritativeWorkflowControllerWithDependencies(options);
}

export interface AuthoritativeRecordedWorkflowGatewayOptions
  extends AuthoritativeWorkflowControllerOptions {
  readonly initialSnapshot: ProjectionSnapshot;
}

export interface AuthoritativeRecordedWorkflowGatewayTestOptions
  extends Omit<
    AuthoritativeRecordedWorkflowGatewayOptions,
    "finalDecisionMemoAdapter"
  > {
  readonly finalDecisionMemoAdapter: FinalDecisionMemoAdapter;
}

function snapshotForInitialWorkflowState(
  initialSources: RecordedReviewSnapshotSources,
  state: AuthoritativeWorkflowControllerState | undefined,
): ProjectionSnapshot {
  if (
    state?.humanConfirmedDecisionContext === undefined
    || state.humanConfirmationReceipt === undefined
  ) {
    return buildRecordedReviewProjectionSnapshot(initialSources);
  }
  return buildRecordedDecisionProjectionSnapshot({
    lockedChallengePack: initialSources.lockedChallengePack,
    recordedBenchmarkPack: initialSources.recordedBenchmarkPack,
    preReviewReceipt: initialSources.preReviewReceipt,
    provisionalDecisionMemo: initialSources.provisionalDecisionMemo,
    humanConfirmedDecisionContext: state.humanConfirmedDecisionContext,
    humanConfirmationReceipt: state.humanConfirmationReceipt,
    ...(state.finalDecisionMemo === undefined
      ? {}
      : { finalDecisionMemo: state.finalDecisionMemo }),
    ...(state.finalDecisionConfirmationReceipt === undefined
      ? {}
      : { finalDecisionConfirmationReceipt: state.finalDecisionConfirmationReceipt }),
    ...(state.decisionAuthorityRecord === undefined
      ? {}
      : { decisionAuthorityRecord: state.decisionAuthorityRecord }),
    ...(state.recordedRegressionPack === undefined
      ? {}
      : { recordedRegressionPack: state.recordedRegressionPack }),
  });
}

/**
 * 실제 서버가 사용해야 하는 단일 production 조립 경계입니다.
 * 초기 read snapshot도 같은 persisted source chain에서 결정적으로 다시
 * 만든 값과 exact 일치해야 하며, controller operation과 독립 verifier를
 * 분리할 수 없는 한 묶음으로 gateway에 주입합니다.
 */
function createAuthoritativeRecordedWorkflowGatewayCore({
  initialSnapshot,
  controllerOptions,
  createController,
}: {
  readonly initialSnapshot: ProjectionSnapshot;
  readonly controllerOptions: AuthoritativeWorkflowControllerTestOptions;
  readonly createController: (
    options: AuthoritativeWorkflowControllerTestOptions,
  ) => AuthoritativeWorkflowController;
}): ChallengeApiGateway {
  const expectedInitialSnapshot = snapshotForInitialWorkflowState(
    controllerOptions.initialSources,
    controllerOptions.initialControllerState,
  );
  assertAuthoritativeRecordedWorkflowProjectionSnapshot(
    expectedInitialSnapshot,
  );
  if (initialSnapshot.snapshot_id !== expectedInitialSnapshot.snapshot_id) {
    throw integrity(
      "초기 workspace snapshot이 persisted Recorded review source 재빌드 결과와 다릅니다.",
    );
  }
  const controller = createController({
    ...controllerOptions,
    ...(controllerOptions.initialControllerState === undefined
      ? {}
      : {
          initialControllerState: {
            ...controllerOptions.initialControllerState,
            committedSnapshotId: initialSnapshot.snapshot_id,
          },
        }),
  });
  const gateway = createMutableProjectionGateway({
    initialSnapshot,
    operations: controller.operations,
    transitionVerifiers: controller.transitionVerifiers,
  });
  return Object.freeze({
    ...gateway,
    // queue·AI proposal·capability는 durable public snapshot이 아니라, active
    // reviewer flow에서만 verified persisted sources를 다시 조립해 제공합니다.
    getBlindReview: async (reviewId: string) => {
      const workspace = await gateway.getWorkspace();
      if (
        workspace.review_id
          !== controllerOptions.initialSources.preReviewReceipt.pre_review_id
        || reviewId !== workspace.review_id
      ) return null;
      return buildPreconfirmationPublicProjection({
        recordedBenchmarkPack: controllerOptions.initialSources.recordedBenchmarkPack,
        preReviewReceipt: controllerOptions.initialSources.preReviewReceipt,
        provisionalDecisionMemo: controllerOptions.initialSources.provisionalDecisionMemo,
      }) as unknown as PublicProjection;
    },
    getReviewerBlindEvidenceDetail: async ({
      evidenceId,
      evidenceHandle,
    }: Readonly<{ evidenceId: string; evidenceHandle: string }>) => {
      const workspace = await gateway.getWorkspace();
      const queue = controllerOptions.initialSources.recordedBenchmarkPack
        .blind_review_queue;
      const item = queue.items.find((candidate) => (
        evidenceId === blindReviewEvidenceId(
          controllerOptions.initialSources.recordedBenchmarkPack,
          candidate.item_id,
        )
        && evidenceHandle === reviewerBlindEvidenceHandle(
          controllerOptions.initialSources.recordedBenchmarkPack,
          controllerOptions.initialSources.preReviewReceipt.pre_review_id,
          candidate.item_id,
        )
      ));
      // confirmation 뒤에는 gateway의 review_id가 제거되므로 모든 active
      // reviewer capability가 함께 폐기됩니다. pair가 정확히 일치하는 해당
      // queue item만 두 fixed Run detail을 열 수 있습니다.
      if (
        workspace.review_id
          !== controllerOptions.initialSources.preReviewReceipt.pre_review_id
        || item === undefined
      ) return null;
      return buildRecordedBlindReviewEvidenceDetailProjection(
        controllerOptions.initialSources.recordedBenchmarkPack,
        item.item_id,
      ) as unknown as PublicProjection;
    },
  });
}

export function createAuthoritativeRecordedWorkflowGateway({
  initialSnapshot,
  ...controllerOptions
}: AuthoritativeRecordedWorkflowGatewayOptions): ChallengeApiGateway {
  assertOfficialOpenAIFinalDecisionMemoAdapter(
    controllerOptions.finalDecisionMemoAdapter,
  );
  return createAuthoritativeRecordedWorkflowGatewayCore({
    initialSnapshot,
    controllerOptions,
    createController: (options) => createAuthoritativeWorkflowController(
      options as AuthoritativeWorkflowControllerOptions,
    ),
  });
}

/**
 * 외부 provider가 없는 server 통합 테스트 전용 조립 경계입니다.
 * 공개 HTTP 입력으로 선택할 수 없고 production factory에서도 참조하지 않습니다.
 */
export function createAuthoritativeRecordedWorkflowGatewayForTest(
  options: AuthoritativeRecordedWorkflowGatewayTestOptions,
): ChallengeApiGateway {
  assertTestOnlyServerEntrypoint();
  const {
    initialSnapshot,
    ...controllerOptions
  } = options;
  return createAuthoritativeRecordedWorkflowGatewayCore({
    initialSnapshot,
    controllerOptions,
    createController: createAuthoritativeWorkflowControllerForTest,
  });
}

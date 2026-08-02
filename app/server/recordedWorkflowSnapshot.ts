import type { LockedChallengePack } from "../eval/define/defineContracts";
import {
  assertPersistedProvisionalDecisionMemo,
  type ProvisionalDecisionMemo,
} from "../eval/decision/provisionalMemo";
import {
  assertPersistedFinalDecisionConfirmationReceipt,
  assertPersistedFinalDecisionMemo,
  DecisionAuthorityRecord,
  FinalDecisionConfirmationReceipt,
  FinalDecisionMemo,
  HumanConfirmedDecisionContext,
} from "../eval/decision/decisionBaseline";
import type { RecordedBenchmarkPack } from "../eval/pack/recordedBenchmarkPack";
import type { RecordedRegressionPack } from "../eval/regression/regressionPack";
import type { HumanConfirmationReceipt } from "../eval/review/humanConfirmation";
import {
  assertPersistedAiPreReviewReceipt,
  type AiPreReviewReceipt,
} from "../eval/review/preReviewReceipt";
import { sha256CanonicalJson } from "../eval/runtime/canonicalJson";
import {
  buildProjectionSnapshot,
  persistProjectionSnapshot,
  type PersistProjectionSnapshotResult,
  type ProjectionSnapshot,
} from "./projectionRepository";
import {
  buildLockedChallengePublicProjection,
  buildBaselinePublicProjection,
  buildDecisionPublicProjection,
  buildPreconfirmationWorkspacePublicProjection,
  buildRecordedBenchmarkEvidenceProjections,
  buildRecordedBenchmarkProgressProjection,
  buildReviewPendingBenchmarkProgressProjection,
  buildRecordedWorkspacePublicProjection,
  buildRegressionEvidenceProjections,
  buildRegressionPublicProjection,
  type RecordedWorkspacePublicProjection,
} from "./workflowProjections";
import { buildRecordedHardGateMatrixProjection } from "./recordedHardGateMatrix";

const AUTHORITATIVE_RECORDED_WORKFLOW_SNAPSHOTS = new WeakSet<object>();

export class RecordedWorkflowSnapshotIntegrityError extends Error {
  readonly code = "RECORDED_WORKFLOW_SNAPSHOT_INTEGRITY" as const;

  constructor(message: string) {
    super(message);
    this.name = "RecordedWorkflowSnapshotIntegrityError";
  }
}

function brandAuthoritativeSnapshot(
  snapshot: ProjectionSnapshot,
): ProjectionSnapshot {
  AUTHORITATIVE_RECORDED_WORKFLOW_SNAPSHOTS.add(snapshot);
  return snapshot;
}

/**
 * 일반 ProjectionSnapshot과 달리, 권위 Recorded workflow source builder가
 * 현재 프로세스에서 직접 조립한 동일 객체만 transition 기대값으로 사용합니다.
 */
export function assertAuthoritativeRecordedWorkflowProjectionSnapshot(
  value: unknown,
): asserts value is ProjectionSnapshot {
  if (
    typeof value !== "object"
    || value === null
    || !Object.isFrozen(value)
    || !AUTHORITATIVE_RECORDED_WORKFLOW_SNAPSHOTS.has(value)
  ) {
    throw new RecordedWorkflowSnapshotIntegrityError(
      "Recorded workflow transition에는 권위 source builder가 만든 동일 snapshot 객체가 필요합니다.",
    );
  }
}

export interface RecordedReviewSnapshotSources {
  readonly lockedChallengePack: LockedChallengePack;
  readonly recordedBenchmarkPack: RecordedBenchmarkPack;
  readonly preReviewReceipt: AiPreReviewReceipt;
  readonly provisionalDecisionMemo: ProvisionalDecisionMemo;
}

/**
 * 사용자 확인 직전의 read-only workspace를 권위 artifact 체인에서 조립합니다.
 * 브라우저에는 private blind mapping·oracle·credential을 전달하지 않습니다.
 */
export function buildRecordedReviewProjectionSnapshot(
  sources: RecordedReviewSnapshotSources,
): ProjectionSnapshot {
  assertPersistedAiPreReviewReceipt(sources.preReviewReceipt);
  assertPersistedProvisionalDecisionMemo(
    sources.provisionalDecisionMemo,
  );
  const challenge = buildLockedChallengePublicProjection(
    sources.lockedChallengePack,
  );
  const benchmark = buildReviewPendingBenchmarkProgressProjection(
    sources.recordedBenchmarkPack,
  );
  const workspace = buildPreconfirmationWorkspacePublicProjection(sources);
  return brandAuthoritativeSnapshot(buildProjectionSnapshot({
    source_chain: [
      {
        artifact_kind: sources.lockedChallengePack.artifact_kind,
        artifact_id: sources.lockedChallengePack.challenge_id,
        payload_sha256:
          sources.lockedChallengePack.locked_challenge_pack_hash,
      },
      {
        artifact_kind: sources.recordedBenchmarkPack.artifact_kind,
        artifact_id:
          sources.recordedBenchmarkPack.benchmark_execution_pack.execution_hash,
        payload_sha256: sha256CanonicalJson(
          sources.recordedBenchmarkPack,
        ),
      },
      {
        artifact_kind: sources.preReviewReceipt.artifact_kind,
        artifact_id: sources.preReviewReceipt.pre_review_id,
        payload_sha256: sha256CanonicalJson(sources.preReviewReceipt),
      },
      {
        artifact_kind: sources.provisionalDecisionMemo.artifact_kind,
        artifact_id: sources.provisionalDecisionMemo.memo_id,
        payload_sha256: sha256CanonicalJson(
          sources.provisionalDecisionMemo,
        ),
      },
    ],
    workspace,
    challenges: [challenge],
    // 검수 전 raw output/evidence와 candidate-case linkage를 공개하면 reviewer
    // route의 X/Y/Z detail과 상관시켜 실제 후보 identity를 복원할 수 있습니다.
    evidence: [],
    benchmark_progress: [benchmark],
    // preconfirmation queue·AI proposal·review capability는 persisted public
    // snapshot에 넣지 않습니다. 현재 reviewer route가 verified source에서만
    // 필요할 때 다시 조립합니다.
    blind_reviews: [],
    decisions: [],
    baselines: [],
    regressions: [],
  }));
}

export async function persistRecordedReviewProjectionSnapshot({
  outputDirectory,
  sources,
}: {
  readonly outputDirectory: string;
  readonly sources: RecordedReviewSnapshotSources;
}): Promise<PersistProjectionSnapshotResult> {
  return persistProjectionSnapshot({
    outputDirectory,
    snapshot: buildRecordedReviewProjectionSnapshot(sources),
  });
}

export interface RecordedDecisionSnapshotSources {
  readonly lockedChallengePack: LockedChallengePack;
  readonly recordedBenchmarkPack: RecordedBenchmarkPack;
  readonly humanConfirmedDecisionContext: HumanConfirmedDecisionContext;
  readonly humanConfirmationReceipt: HumanConfirmationReceipt;
  readonly preReviewReceipt?: AiPreReviewReceipt;
  readonly provisionalDecisionMemo?: ProvisionalDecisionMemo;
  readonly finalDecisionMemo?: FinalDecisionMemo;
  readonly finalDecisionConfirmationReceipt?:
    FinalDecisionConfirmationReceipt;
  readonly decisionAuthorityRecord?: DecisionAuthorityRecord;
  readonly recordedRegressionPack?: RecordedRegressionPack;
}

export function buildRecordedDecisionProjectionSnapshot(
  sources: RecordedDecisionSnapshotSources,
): ProjectionSnapshot {
  if (sources.finalDecisionMemo !== undefined) {
    assertPersistedFinalDecisionMemo(sources.finalDecisionMemo);
  }
  if (sources.preReviewReceipt !== undefined) {
    assertPersistedAiPreReviewReceipt(sources.preReviewReceipt);
    if (
      sha256CanonicalJson(sources.preReviewReceipt)
      !== sources.humanConfirmationReceipt.ai_pre_review_receipt_hash
    ) {
      throw new RecordedWorkflowSnapshotIntegrityError(
        "Decision snapshot의 AI pre-review source가 Human confirmation과 다릅니다.",
      );
    }
  }
  if (sources.provisionalDecisionMemo !== undefined) {
    assertPersistedProvisionalDecisionMemo(
      sources.provisionalDecisionMemo,
    );
    if (
      sha256CanonicalJson(sources.provisionalDecisionMemo)
      !== sources.humanConfirmationReceipt.provisional_decision_memo_hash
    ) {
      throw new RecordedWorkflowSnapshotIntegrityError(
        "Decision snapshot의 provisional Memo source가 Human confirmation과 다릅니다.",
      );
    }
  }
  if (sources.finalDecisionConfirmationReceipt !== undefined) {
    assertPersistedFinalDecisionConfirmationReceipt(
      sources.finalDecisionConfirmationReceipt,
    );
    if (sources.decisionAuthorityRecord === undefined) {
      throw new RecordedWorkflowSnapshotIntegrityError(
        "Final confirmation source는 persisted terminal Decision과 함께만 공개할 수 있습니다.",
      );
    }
    if (
      sources.decisionAuthorityRecord !== undefined
      && sha256CanonicalJson(
        sources.finalDecisionConfirmationReceipt,
      ) !== sources.decisionAuthorityRecord
        .final_decision_confirmation_receipt_hash
    ) {
      throw new RecordedWorkflowSnapshotIntegrityError(
        "Decision snapshot의 Final confirmation source가 terminal Decision과 다릅니다.",
      );
    }
  }
  const challenge = buildLockedChallengePublicProjection(
    sources.lockedChallengePack,
  );
  const benchmark = buildRecordedBenchmarkProgressProjection(
    sources.recordedBenchmarkPack,
  );
  const hardGateMatrix = buildRecordedHardGateMatrixProjection(
    sources.recordedBenchmarkPack,
  );
  const decision = buildDecisionPublicProjection({
    context: sources.humanConfirmedDecisionContext,
    humanConfirmationReceipt: sources.humanConfirmationReceipt,
    ...(sources.finalDecisionMemo === undefined
      ? {}
      : { finalDecisionMemo: sources.finalDecisionMemo }),
    ...(sources.decisionAuthorityRecord === undefined
      ? {}
      : { decisionAuthorityRecord: sources.decisionAuthorityRecord }),
    hardGateMatrix,
  });
  const baseline =
    sources.decisionAuthorityRecord?.artifact_kind
      === "DECISION_BASELINE_RECORD"
      ? buildBaselinePublicProjection(sources.decisionAuthorityRecord)
      : null;
  if (
    sources.recordedRegressionPack !== undefined
    && (
      baseline === null
      || sources.recordedRegressionPack.authority
        .decision_baseline_record_hash !== baseline.decision_record_hash
      || sources.recordedRegressionPack.authority.baseline_version
        !== baseline.baseline_id
      || sources.recordedRegressionPack.selected_candidate_id
        !== baseline.selected_candidate_id
    )
  ) {
    throw new TypeError(
      "Recorded Regression은 같은 persisted active baseline에 결합돼야 합니다.",
    );
  }
  const regression = sources.recordedRegressionPack === undefined
    ? null
    : buildRegressionPublicProjection(sources.recordedRegressionPack);
  const baseWorkspace = buildRecordedWorkspacePublicProjection({
    lockedChallengePack: sources.lockedChallengePack,
    recordedBenchmarkPack: sources.recordedBenchmarkPack,
  });
  const workspace: RecordedWorkspacePublicProjection = {
    ...baseWorkspace,
    review_id: null,
    decision_id: decision.decision_id,
    baseline_id: baseline?.baseline_id ?? null,
    regression_id: regression?.regression_id ?? null,
    source_hash:
      regression?.source_hash
      ?? baseline?.source_hash
      ?? decision.source_hash,
    stage_statuses: {
      define: "LOCKED",
      compare: "RECORDED",
      decide: decision.status.replaceAll("_", " ") as
        RecordedWorkspacePublicProjection["stage_statuses"]["decide"],
      monitor: regression === null
        ? baseline === null ? "NO BASELINE" : "BASELINE ACTIVE"
        : regression.verdict.replaceAll("_", " ") as
          RecordedWorkspacePublicProjection["stage_statuses"]["monitor"],
    },
  };
  const sourceChain = [
    {
      artifact_kind: sources.lockedChallengePack.artifact_kind,
      artifact_id: sources.lockedChallengePack.challenge_id,
      payload_sha256:
        sources.lockedChallengePack.locked_challenge_pack_hash,
    },
    {
      artifact_kind: sources.recordedBenchmarkPack.artifact_kind,
      artifact_id:
        sources.recordedBenchmarkPack.benchmark_execution_pack.execution_hash,
      payload_sha256: sha256CanonicalJson(sources.recordedBenchmarkPack),
    },
    ...(sources.preReviewReceipt === undefined ? [] : [{
      artifact_kind: sources.preReviewReceipt.artifact_kind,
      artifact_id: sources.preReviewReceipt.pre_review_id,
      payload_sha256: sha256CanonicalJson(sources.preReviewReceipt),
    }]),
    ...(sources.provisionalDecisionMemo === undefined ? [] : [{
      artifact_kind: sources.provisionalDecisionMemo.artifact_kind,
      artifact_id: sources.provisionalDecisionMemo.memo_id,
      payload_sha256: sha256CanonicalJson(
        sources.provisionalDecisionMemo,
      ),
    }]),
    {
      artifact_kind: sources.humanConfirmationReceipt.artifact_kind,
      artifact_id: sources.humanConfirmationReceipt.confirmation_id,
      payload_sha256: sha256CanonicalJson(
        sources.humanConfirmationReceipt,
      ),
    },
    ...(sources.finalDecisionMemo === undefined ? [] : [{
      artifact_kind: sources.finalDecisionMemo.artifact_kind,
      artifact_id: sha256CanonicalJson(sources.finalDecisionMemo),
      payload_sha256: sha256CanonicalJson(sources.finalDecisionMemo),
    }]),
    ...(sources.finalDecisionConfirmationReceipt === undefined ? [] : [{
      artifact_kind:
        sources.finalDecisionConfirmationReceipt.artifact_kind,
      artifact_id: sha256CanonicalJson(
        sources.finalDecisionConfirmationReceipt,
      ),
      payload_sha256: sha256CanonicalJson(
        sources.finalDecisionConfirmationReceipt,
      ),
    }]),
    ...(sources.decisionAuthorityRecord === undefined ? [] : [{
      artifact_kind: sources.decisionAuthorityRecord.artifact_kind,
      artifact_id: sources.decisionAuthorityRecord.decision_id,
      payload_sha256: sha256CanonicalJson(
        sources.decisionAuthorityRecord,
      ),
    }]),
    ...(sources.recordedRegressionPack === undefined ? [] : [{
      artifact_kind: sources.recordedRegressionPack.artifact_kind,
      artifact_id: sources.recordedRegressionPack.regression_id,
      payload_sha256: sha256CanonicalJson(
        sources.recordedRegressionPack,
      ),
    }]),
  ];
  return brandAuthoritativeSnapshot(buildProjectionSnapshot({
    source_chain: sourceChain,
    workspace,
    challenges: [challenge],
    evidence: [
      ...buildRecordedBenchmarkEvidenceProjections(
        sources.recordedBenchmarkPack,
      ),
      ...(sources.recordedRegressionPack === undefined
        ? []
        : buildRegressionEvidenceProjections(
          sources.recordedRegressionPack,
        )),
    ],
    benchmark_progress: [benchmark],
    blind_reviews: [],
    decisions: [decision],
    baselines: baseline === null ? [] : [baseline],
    regressions: regression === null ? [] : [regression],
  }));
}

export async function persistRecordedDecisionProjectionSnapshot({
  outputDirectory,
  sources,
}: {
  readonly outputDirectory: string;
  readonly sources: RecordedDecisionSnapshotSources;
}): Promise<PersistProjectionSnapshotResult> {
  return persistProjectionSnapshot({
    outputDirectory,
    snapshot: buildRecordedDecisionProjectionSnapshot(sources),
  });
}

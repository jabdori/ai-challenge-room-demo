import {
  ApiArtifactIntegrityError,
  type ChallengeApiGateway,
  type ChallengeMutationCommand,
  type ChallengeMutationResult,
  type PublicProjection,
} from "./challengeServer";
import {
  ReadOnlyProjectionError,
  createReadOnlyProjectionGateway,
  loadReadOnlyProjectionSnapshotRecord,
  type ProjectionSnapshot,
} from "./projectionRepository";

type MutationMethod =
  | "structureDefine"
  | "lockChallenge"
  | "startBenchmark"
  | "confirmReview"
  | "createDecisionMemo"
  | "confirmDecision"
  | "startRegression";

export interface ProjectionMutationOperationInput {
  readonly command: ChallengeMutationCommand;
  readonly currentSnapshot: ProjectionSnapshot;
}

export interface ProjectionMutationOperationResult {
  /**
   * 부수 효과와 새 projection을 모두 write-once 저장한 뒤 반환하는 경로입니다.
   * Gateway는 이 파일을 canonical source chain에서 다시 검증한 경우에만
   * 브라우저 읽기 상태를 전환합니다.
   */
  readonly nextSnapshotPath: string;
}

export type ProjectionMutationOperation = (
  input: ProjectionMutationOperationInput,
) => Promise<ProjectionMutationOperationResult>;

export interface ProjectionMutationTransitionInput {
  readonly command: ChallengeMutationCommand;
  readonly previousSnapshot: ProjectionSnapshot;
  readonly nextSnapshot: ProjectionSnapshot;
}

/**
 * 부수 효과 operation과 분리된 신뢰 경계입니다. 권위 원본을 독립적으로
 * 다시 조립한 기대 상태와 디스크에서 재로드한 snapshot의 exact transition을
 * 검증해야 합니다.
 */
export type ProjectionMutationTransitionVerifier = (
  input: ProjectionMutationTransitionInput,
) => void | Promise<void>;

export interface MutableProjectionGatewayOptions {
  readonly initialSnapshot: ProjectionSnapshot;
  readonly operations: Partial<
    Readonly<Record<MutationMethod, ProjectionMutationOperation>>
  >;
  readonly transitionVerifiers: Partial<
    Readonly<Record<MutationMethod, ProjectionMutationTransitionVerifier>>
  >;
}

function textField(
  projection: PublicProjection,
  field: string,
): string | null {
  const value = projection[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function currentSourceHash(snapshot: ProjectionSnapshot): string {
  const sourceHash = textField(snapshot.projections.workspace, "source_hash");
  if (
    sourceHash === null
    || !/^[a-f0-9]{64}$/.test(sourceHash)
    || !snapshot.source_chain.some(
      (source) => source.payload_sha256 === sourceHash,
    )
  ) {
    throw new ApiArtifactIntegrityError(
      "ARTIFACT_INTEGRITY",
      "현재 workspace source hash가 권위 source chain과 결합되지 않았습니다.",
    );
  }
  return sourceHash;
}

function expectedTarget(
  method: MutationMethod,
  snapshot: ProjectionSnapshot,
): string | null {
  const workspace = snapshot.projections.workspace;
  switch (method) {
    case "structureDefine":
      return "define";
    case "lockChallenge":
      return textField(workspace, "challenge_id");
    case "startBenchmark":
      return textField(workspace, "benchmark_id")
        ?? textField(workspace, "challenge_id");
    case "confirmReview":
      return textField(workspace, "review_id");
    case "createDecisionMemo":
    case "confirmDecision":
      return textField(workspace, "decision_id");
    case "startRegression":
      return textField(workspace, "regression_id")
        ?? textField(workspace, "baseline_id");
  }
}

function assertCommandAuthority({
  method,
  command,
  snapshot,
}: {
  readonly method: MutationMethod;
  readonly command: ChallengeMutationCommand;
  readonly snapshot: ProjectionSnapshot;
}): void {
  const sourceHash = currentSourceHash(snapshot);
  if (command.expected_source_hash !== sourceHash) {
    throw new ApiArtifactIntegrityError(
      "STALE_SOURCE",
      "mutation source hash가 현재 권위 projection과 다릅니다.",
    );
  }
  const target = expectedTarget(method, snapshot);
  if (target === null || command.target_id !== target) {
    throw new ApiArtifactIntegrityError(
      "ARTIFACT_INTEGRITY",
      "mutation URL target이 현재 권위 workspace와 다릅니다.",
    );
  }
}

export function createMutableProjectionGateway({
  initialSnapshot,
  operations,
  transitionVerifiers,
}: MutableProjectionGatewayOptions): ChallengeApiGateway {
  // 생성 시점에도 전체 source chain과 공개 경계를 다시 검증합니다.
  createReadOnlyProjectionGateway(initialSnapshot);
  currentSourceHash(initialSnapshot);
  for (const method of Object.keys(operations) as MutationMethod[]) {
    if (transitionVerifiers[method] === undefined) {
      throw new ApiArtifactIntegrityError(
        "ARTIFACT_INTEGRITY",
        `${method} operation에는 독립된 권위 transition verifier가 필요합니다.`,
      );
    }
  }
  let current = initialSnapshot;

  const readGateway = (): ChallengeApiGateway => (
    createReadOnlyProjectionGateway(current)
  );
  const runMutation = async (
    method: MutationMethod,
    command: ChallengeMutationCommand,
  ): Promise<ChallengeMutationResult> => {
    assertCommandAuthority({ method, command, snapshot: current });
    const operation = operations[method];
    if (operation === undefined) throw new ReadOnlyProjectionError();
    const transitionVerifier = transitionVerifiers[method];
    if (transitionVerifier === undefined) {
      throw new ApiArtifactIntegrityError(
        "ARTIFACT_INTEGRITY",
        `${method} transition verifier가 없습니다.`,
      );
    }
    const previous = current;
    const result = await operation({
      command,
      currentSnapshot: previous,
    });
    const loaded = await loadReadOnlyProjectionSnapshotRecord({
      path: result.nextSnapshotPath,
    });
    await transitionVerifier({
      command,
      previousSnapshot: previous,
      nextSnapshot: loaded,
    });
    const nextSourceHash = currentSourceHash(loaded);
    if (nextSourceHash === command.expected_source_hash) {
      throw new ApiArtifactIntegrityError(
        "ARTIFACT_INTEGRITY",
        "수락된 mutation은 새 권위 source hash로 전진해야 합니다.",
      );
    }
    current = loaded;
    return Object.freeze({
      accepted: true,
      source_hash: nextSourceHash,
    });
  };

  return Object.freeze({
    getWorkspace: async () => readGateway().getWorkspace(),
    getChallenge: async (id: string) => readGateway().getChallenge(id),
    getEvidence: async (id: string) => readGateway().getEvidence(id),
    getBenchmarkProgress: async (id: string) => (
      readGateway().getBenchmarkProgress(id)
    ),
    getBlindReview: async (id: string) => readGateway().getBlindReview(id),
    getDecision: async (id: string) => readGateway().getDecision(id),
    getBaseline: async (id: string) => readGateway().getBaseline(id),
    getRegression: async (id: string) => readGateway().getRegression(id),
    structureDefine: (command: ChallengeMutationCommand) => (
      runMutation("structureDefine", command)
    ),
    lockChallenge: (command: ChallengeMutationCommand) => (
      runMutation("lockChallenge", command)
    ),
    startBenchmark: (command: ChallengeMutationCommand) => (
      runMutation("startBenchmark", command)
    ),
    confirmReview: (command: ChallengeMutationCommand) => (
      runMutation("confirmReview", command)
    ),
    createDecisionMemo: (command: ChallengeMutationCommand) => runMutation(
      "createDecisionMemo",
      command,
    ),
    confirmDecision: (command: ChallengeMutationCommand) => (
      runMutation("confirmDecision", command)
    ),
    startRegression: (command: ChallengeMutationCommand) => (
      runMutation("startRegression", command)
    ),
  });
}

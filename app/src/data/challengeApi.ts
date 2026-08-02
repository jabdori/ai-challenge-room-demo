import { reviewerSessionToken } from "./reviewerSession";

const SHA256 = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY = /^mutation_[A-Za-z0-9_-]{3,120}$/;
const SCHEMA_VERSION = /^[a-z][a-z0-9-]{2,100}-v\d+$/;
const SAFE_API_PATH = /^\/api\/[A-Za-z0-9._/-]+$/;
const PRIVATE_KEY = /^(?:api[_-]?key|authorization|private[_-]?mapping|label[_-]?to[_-]?candidate|(?:master|case)?[_-]?blinding[_-]?seed|raw[_-]?oracle|hidden[_-]?oracle|unrestricted[_-]?order)$/i;

type JsonRecord = Record<string, unknown>;
type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface BrowserPublicProjection extends JsonRecord {
  readonly schema_version: string;
  readonly synthetic: true;
}

export interface MutationResult extends JsonRecord {
  readonly accepted: true;
  readonly source_hash: string;
}

export interface PostMutationInput {
  readonly path: string;
  readonly schemaVersion: string;
  readonly expectedSourceHash: string;
  readonly idempotencyKey: string;
  readonly payload?: Readonly<JsonRecord>;
}

export interface StartRegressionInput {
  readonly baselineId: string;
  readonly expectedSourceHash: string;
  readonly idempotencyKey: string;
}

interface LifecycleMutationBaseInput {
  readonly expectedSourceHash: string;
  readonly idempotencyKey: string;
  readonly actorLabel: string;
}

export interface StructureDefineInput extends LifecycleMutationBaseInput {}

export interface LockChallengeInput extends LifecycleMutationBaseInput {
  readonly challengeId: string;
  readonly defineStructuringArtifactHash: string;
  readonly approvedContractHash: string;
}

export interface StartBenchmarkInput extends LifecycleMutationBaseInput {
  readonly benchmarkId: string;
}

export interface ResumeBenchmarkInput extends StartBenchmarkInput {
  readonly resumeFromProgressHash: string;
}

export type DurableFailureClassification =
  | "PROVIDER_TEMPORARY_FAILURE"
  | "PROVIDER_TERMINAL_FAILURE"
  | "EVALUATION_INCOMPLETE";

export interface DurableMutationFailure {
  readonly retryAllowed: boolean;
  readonly classification: DurableFailureClassification;
  readonly failureHash: string;
}

export class ChallengeApiClientError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "INVALID_RESPONSE"
      | "STALE_SOURCE"
      | "REPLAYED_MUTATION"
      | "MUTATION_AMBIGUOUS"
      | "ARTIFACT_INTEGRITY"
      | "NOT_FOUND"
      | DurableFailureClassification
      | "REQUEST_FAILED",
    readonly status: number | null,
    readonly durableFailure: DurableMutationFailure | null = null,
  ) {
    super(`Challenge API 요청이 ${code} 상태로 종료됐습니다.`);
    this.name = "ChallengeApiClientError";
  }
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeJson(value: unknown, location: string): void {
  let nodes = 0;
  const visit = (child: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > 20_000 || depth > 48) {
      throw new ChallengeApiClientError("INVALID_RESPONSE", null);
    }
    if (typeof child === "string") {
      if (/sk-[A-Za-z0-9_-]{16,}/.test(child)) {
        throw new ChallengeApiClientError("INVALID_RESPONSE", null);
      }
      return;
    }
    if (
      child === null
      || typeof child === "boolean"
      || (typeof child === "number" && Number.isFinite(child))
    ) return;
    if (Array.isArray(child)) {
      child.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!isPlainRecord(child)) {
      throw new ChallengeApiClientError("INVALID_RESPONSE", null);
    }
    for (const [key, nested] of Object.entries(child)) {
      if (PRIVATE_KEY.test(key) || key.length > 256 || /[\p{Cc}]/u.test(key)) {
        throw new ChallengeApiClientError("INVALID_RESPONSE", null);
      }
      visit(nested, `${path}.${key}`, depth + 1);
    }
  };
  visit(value, location, 0);
}

function assertSafePath(path: string): void {
  if (
    typeof path !== "string"
    || !SAFE_API_PATH.test(path)
    || path.includes("..")
    || path.includes("//")
    || path.includes("?")
    || path.includes("#")
  ) {
    throw new ChallengeApiClientError("INVALID_REQUEST", null);
  }
}

function assertActorLabel(value: string): void {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 160
    || value.trim() !== value
    || /\p{Cc}/u.test(value)
  ) {
    throw new ChallengeApiClientError("INVALID_REQUEST", null);
  }
}

function assertSafeIdentifier(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new ChallengeApiClientError("INVALID_REQUEST", null);
  }
}

function reviewerAuthorizationHeader(): Readonly<Record<string, string>> {
  const token = reviewerSessionToken();
  return token === null ? {} : { authorization: `Bearer ${token}` };
}

function isReviewerConfirmationPath(path: string): boolean {
  return /^\/api\/reviews\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/confirm$/.test(path);
}

function knownErrorCode(value: unknown): ChallengeApiClientError["code"] {
  if (!isPlainRecord(value)) return "REQUEST_FAILED";
  switch (value.error) {
    case "INVALID_REQUEST":
    case "STALE_SOURCE":
    case "REPLAYED_MUTATION":
    case "MUTATION_AMBIGUOUS":
    case "ARTIFACT_INTEGRITY":
    case "NOT_FOUND":
    case "PROVIDER_TEMPORARY_FAILURE":
    case "PROVIDER_TERMINAL_FAILURE":
    case "EVALUATION_INCOMPLETE":
      return value.error;
    default:
      return "REQUEST_FAILED";
  }
}

function readDurableFailure(
  value: unknown,
  code: ChallengeApiClientError["code"],
  status: number,
): DurableMutationFailure | null {
  if (!isPlainRecord(value)) return null;
  const fields = ["retry_allowed", "failure_classification", "failure_hash"];
  const includesFailureField = fields.some((field) => Object.hasOwn(value, field));
  if (!includesFailureField) return null;
  if (
    !fields.every((field) => Object.hasOwn(value, field))
    || typeof value.retry_allowed !== "boolean"
    || typeof value.failure_hash !== "string"
    || !SHA256.test(value.failure_hash)
    || (
      value.failure_classification !== "PROVIDER_TEMPORARY_FAILURE"
      && value.failure_classification !== "PROVIDER_TERMINAL_FAILURE"
      && value.failure_classification !== "EVALUATION_INCOMPLETE"
    )
    || (
      code !== "REPLAYED_MUTATION"
      && code !== value.failure_classification
    )
  ) {
    throw new ChallengeApiClientError("INVALID_RESPONSE", status);
  }
  return Object.freeze({
    retryAllowed: value.retry_allowed,
    classification: value.failure_classification,
    failureHash: value.failure_hash,
  });
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    .trim();
  if (contentType !== "application/json") {
    throw new ChallengeApiClientError("INVALID_RESPONSE", response.status);
  }
  try {
    const value = await response.json() as unknown;
    assertSafeJson(value, "Challenge API response");
    return value;
  } catch (error) {
    if (error instanceof ChallengeApiClientError) throw error;
    throw new ChallengeApiClientError("INVALID_RESPONSE", response.status);
  }
}

function assertProjection(
  value: unknown,
  expectedSchema: string | readonly string[],
  status: number,
  expectedIdentity?: Readonly<{ field: string; value: string }>,
): BrowserPublicProjection {
  const expectedSchemas = typeof expectedSchema === "string"
    ? [expectedSchema]
    : expectedSchema;
  if (
    !isPlainRecord(value)
    || typeof value.schema_version !== "string"
    || !expectedSchemas.includes(value.schema_version)
    || value.synthetic !== true
    || (
      expectedIdentity !== undefined
      && value[expectedIdentity.field] !== expectedIdentity.value
    )
  ) {
    throw new ChallengeApiClientError("INVALID_RESPONSE", status);
  }
  return Object.freeze(structuredClone(value)) as BrowserPublicProjection;
}

export class ChallengeApiClient {
  constructor(private readonly fetcher: Fetcher = window.fetch.bind(window)) {}

  private async get(
    path: string,
    expectedSchema: string | readonly string[],
    expectedIdentity?: Readonly<{ field: string; value: string }>,
    reviewerSession = false,
  ): Promise<BrowserPublicProjection> {
    assertSafePath(path);
    let response: Response;
    try {
      response = await this.fetcher(path, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(reviewerSession ? reviewerAuthorizationHeader() : {}),
        },
      });
    } catch {
      throw new ChallengeApiClientError("REQUEST_FAILED", null);
    }
    const value = await readJson(response);
    if (!response.ok) {
      const code = knownErrorCode(value);
      throw new ChallengeApiClientError(
        code,
        response.status,
        readDurableFailure(value, code, response.status),
      );
    }
    return assertProjection(
      value,
      expectedSchema,
      response.status,
      expectedIdentity,
    );
  }

  getWorkspace(): Promise<BrowserPublicProjection> {
    return this.get("/api/workspace", "workspace-public-projection-v1");
  }

  getChallenge(id: string): Promise<BrowserPublicProjection> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new ChallengeApiClientError("INVALID_REQUEST", null);
    }
    return this.get(
      `/api/challenges/${id}`,
      "challenge-public-projection-v1",
      { field: "challenge_id", value: id },
    );
  }

  getBenchmarkProgress(id: string): Promise<BrowserPublicProjection> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new ChallengeApiClientError("INVALID_REQUEST", null);
    }
    return this.get(
      `/api/benchmarks/${id}/progress`,
      [
        "benchmark-progress-projection-v1",
        "benchmark-lifecycle-ready-projection-v1",
        "benchmark-lifecycle-projection-v1",
        "benchmark-lifecycle-invalid-projection-v1",
      ],
      { field: "benchmark_id", value: id },
    );
  }

  getEvidence(id: string): Promise<BrowserPublicProjection> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new ChallengeApiClientError("INVALID_REQUEST", null);
    }
    return this.get(
      `/api/evidence/${id}`,
      "evidence-public-projection-v1",
      { field: "evidence_id", value: id },
    );
  }

  async getReviewerEvidence(
    evidenceId: string,
    reviewEvidenceHandle: string,
  ): Promise<BrowserPublicProjection> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(evidenceId)
      || !/^evh_[a-f0-9]{64}$/.test(reviewEvidenceHandle)
    ) throw new ChallengeApiClientError("INVALID_REQUEST", null);
    const path = `/api/reviewer/evidence/${evidenceId}`;
    let response: Response;
    try {
      response = await this.fetcher(path, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...reviewerAuthorizationHeader(),
          "x-review-evidence-handle": reviewEvidenceHandle,
        },
      });
    } catch {
      throw new ChallengeApiClientError("REQUEST_FAILED", null);
    }
    const value = await readJson(response);
    if (!response.ok) {
      const code = knownErrorCode(value);
      throw new ChallengeApiClientError(
        code,
        response.status,
        readDurableFailure(value, code, response.status),
      );
    }
    return assertProjection(value, "recorded-blind-review-evidence-detail-v1", response.status);
  }

  getPreconfirmation(id: string): Promise<BrowserPublicProjection> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new ChallengeApiClientError("INVALID_REQUEST", null);
    }
    return this.get(
      `/api/reviews/${id}`,
      "preconfirmation-public-projection-v1",
      { field: "review_id", value: id },
      true,
    );
  }

  getDecision(id: string): Promise<BrowserPublicProjection> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new ChallengeApiClientError("INVALID_REQUEST", null);
    }
    return this.get(
      `/api/decisions/${id}`,
      "decision-public-projection-v1",
      { field: "decision_id", value: id },
    );
  }

  getBaseline(id: string): Promise<BrowserPublicProjection> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new ChallengeApiClientError("INVALID_REQUEST", null);
    }
    return this.get(
      `/api/baselines/${id}`,
      "baseline-public-projection-v1",
      { field: "baseline_id", value: id },
    );
  }

  getRegression(id: string): Promise<BrowserPublicProjection> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new ChallengeApiClientError("INVALID_REQUEST", null);
    }
    return this.get(
      `/api/regressions/${id}`,
      "regression-public-projection-v1",
      { field: "regression_id", value: id },
    );
  }

  structureDefine(input: StructureDefineInput): Promise<MutationResult> {
    assertActorLabel(input.actorLabel);
    return this.postMutation({
      path: "/api/define/structure",
      schemaVersion: "define-structure-command-v1",
      expectedSourceHash: input.expectedSourceHash,
      idempotencyKey: input.idempotencyKey,
      payload: {
        actor_type: "HUMAN",
        actor_label: input.actorLabel,
      },
    });
  }

  lockChallenge(input: LockChallengeInput): Promise<MutationResult> {
    assertSafeIdentifier(input.challengeId);
    assertActorLabel(input.actorLabel);
    if (
      !SHA256.test(input.defineStructuringArtifactHash)
      || !SHA256.test(input.approvedContractHash)
    ) {
      throw new ChallengeApiClientError("INVALID_REQUEST", null);
    }
    return this.postMutation({
      path: `/api/challenges/${input.challengeId}/lock`,
      schemaVersion: "challenge-lock-command-v1",
      expectedSourceHash: input.expectedSourceHash,
      idempotencyKey: input.idempotencyKey,
      payload: {
        actor_type: "HUMAN",
        actor_label: input.actorLabel,
        decision: "APPROVE_EXACT_CONTRACT",
        define_structuring_artifact_hash:
          input.defineStructuringArtifactHash,
        approved_contract_hash: input.approvedContractHash,
      },
    });
  }

  startBenchmark(input: StartBenchmarkInput): Promise<MutationResult> {
    assertActorLabel(input.actorLabel);
    if (!SHA256.test(input.benchmarkId)) {
      throw new ChallengeApiClientError("INVALID_REQUEST", null);
    }
    return this.postMutation({
      path: `/api/benchmarks/${input.benchmarkId}/start`,
      schemaVersion: "benchmark-start-command-v1",
      expectedSourceHash: input.expectedSourceHash,
      idempotencyKey: input.idempotencyKey,
      payload: {
        actor_type: "HUMAN",
        actor_label: input.actorLabel,
        execution_mode: "START",
        acknowledgement:
          "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
        resume_from_progress_hash: null,
      },
    });
  }

  resumeBenchmark(input: ResumeBenchmarkInput): Promise<MutationResult> {
    assertActorLabel(input.actorLabel);
    if (
      !SHA256.test(input.benchmarkId)
      || !SHA256.test(input.resumeFromProgressHash)
    ) {
      throw new ChallengeApiClientError("INVALID_REQUEST", null);
    }
    return this.postMutation({
      path: `/api/benchmarks/${input.benchmarkId}/start`,
      schemaVersion: "benchmark-start-command-v1",
      expectedSourceHash: input.expectedSourceHash,
      idempotencyKey: input.idempotencyKey,
      payload: {
        actor_type: "HUMAN",
        actor_label: input.actorLabel,
        execution_mode: "RESUME",
        acknowledgement:
          "RUN_SYNTHETIC_RECORDED_BENCHMARK_72_PLUS_12",
        resume_from_progress_hash: input.resumeFromProgressHash,
      },
    });
  }

  startRegression(input: StartRegressionInput): Promise<MutationResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.baselineId)) {
      throw new ChallengeApiClientError("INVALID_REQUEST", null);
    }
    return this.postMutation({
      path: `/api/regressions/${input.baselineId}/start`,
      schemaVersion: "regression-start-command-v1",
      expectedSourceHash: input.expectedSourceHash,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async postMutation(input: PostMutationInput): Promise<MutationResult> {
    assertSafePath(input.path);
    if (
      !SCHEMA_VERSION.test(input.schemaVersion)
      || !SHA256.test(input.expectedSourceHash)
      || !IDEMPOTENCY_KEY.test(input.idempotencyKey)
      || (input.payload !== undefined && !isPlainRecord(input.payload))
    ) {
      throw new ChallengeApiClientError("INVALID_REQUEST", null);
    }
    if (input.payload !== undefined) {
      try {
        assertSafeJson(input.payload, "Challenge API mutation payload");
      } catch {
        throw new ChallengeApiClientError("INVALID_REQUEST", null);
      }
    }
    const body = {
      schema_version: input.schemaVersion,
      expected_source_hash: input.expectedSourceHash,
      idempotency_key: input.idempotencyKey,
      ...(input.payload === undefined
        ? {}
        : { payload: structuredClone(input.payload) }),
    };
    let response: Response;
    try {
      response = await this.fetcher(input.path, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(isReviewerConfirmationPath(input.path)
            ? reviewerAuthorizationHeader()
            : {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ChallengeApiClientError("REQUEST_FAILED", null);
    }
    const value = await readJson(response);
    if (!response.ok) {
      const code = knownErrorCode(value);
      throw new ChallengeApiClientError(
        code,
        response.status,
        readDurableFailure(value, code, response.status),
      );
    }
    if (
      !isPlainRecord(value)
      || value.accepted !== true
      || typeof value.source_hash !== "string"
      || !SHA256.test(value.source_hash)
    ) {
      throw new ChallengeApiClientError("INVALID_RESPONSE", response.status);
    }
    return Object.freeze(structuredClone(value)) as MutationResult;
  }
}

import {
  mutationFailureReceiptHash,
  ReplayedMutationFailureError,
} from "./artifactRepository";
import {
  buildMutationFailureEvidence,
  type MutationFailureEvidence,
  type MutationFailureClassification,
} from "./mutationFailureEvidence";
import { sha256CanonicalJson } from "../eval/runtime/canonicalJson";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDEMPOTENCY_KEY = /^mutation_[A-Za-z0-9_-]{3,120}$/;
const MAX_REQUEST_BYTES = 64 * 1024;

type JsonRecord = Record<string, unknown>;

interface DurableFailureReference {
  readonly classification: MutationFailureClassification;
  readonly failureHash: string;
}

export type PublicProjection = Readonly<JsonRecord>;

export interface ChallengeMutationCommand {
  readonly schema_version: string;
  readonly expected_source_hash: string;
  readonly idempotency_key: string;
  readonly target_id: string;
  readonly payload?: Readonly<JsonRecord>;
}

export interface ChallengeMutationResult extends JsonRecord {
  readonly accepted: boolean;
  readonly source_hash: string;
}

export interface ChallengeMutationJournal {
  execute(
    command: ChallengeMutationCommand,
    operation: () => Promise<ChallengeMutationResult>,
  ): Promise<ChallengeMutationResult>;
}

export interface ChallengeApiGateway {
  readonly getWorkspace: () => Promise<PublicProjection>;
  readonly getChallenge: (id: string) => Promise<PublicProjection | null>;
  readonly getEvidence: (id: string) => Promise<PublicProjection | null>;
  readonly getBenchmarkProgress: (
    id: string,
  ) => Promise<PublicProjection | null>;
  readonly getBlindReview: (id: string) => Promise<PublicProjection | null>;
  readonly getDecision: (id: string) => Promise<PublicProjection | null>;
  readonly getBaseline: (id: string) => Promise<PublicProjection | null>;
  readonly getRegression: (id: string) => Promise<PublicProjection | null>;
  readonly structureDefine: (
    command: ChallengeMutationCommand,
  ) => Promise<ChallengeMutationResult>;
  readonly lockChallenge: (
    command: ChallengeMutationCommand,
  ) => Promise<ChallengeMutationResult>;
  readonly startBenchmark: (
    command: ChallengeMutationCommand,
  ) => Promise<ChallengeMutationResult>;
  readonly confirmReview: (
    command: ChallengeMutationCommand,
  ) => Promise<ChallengeMutationResult>;
  readonly createDecisionMemo: (
    command: ChallengeMutationCommand,
  ) => Promise<ChallengeMutationResult>;
  readonly confirmDecision: (
    command: ChallengeMutationCommand,
  ) => Promise<ChallengeMutationResult>;
  readonly startRegression: (
    command: ChallengeMutationCommand,
  ) => Promise<ChallengeMutationResult>;
}

/** 공개 projection에는 포함하지 않는 reviewer capability detail 경계입니다. */
export interface ReviewerBlindEvidenceGateway {
  readonly getReviewerBlindEvidenceDetail?: (input: Readonly<{
    evidenceId: string;
    evidenceHandle: string;
  }>) => Promise<PublicProjection | null>;
}

/** reviewer 전용 route가 request principal과 browser 출처를 검증하는 경계입니다. */
export interface ReviewerSessionAuthorizer {
  authorize(request: Request): 401 | 403 | null;
}

export class ApiArtifactIntegrityError extends Error {
  constructor(
    readonly code:
      | "STALE_SOURCE"
      | "REPLAYED_MUTATION"
      | "ARTIFACT_INTEGRITY",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApiArtifactIntegrityError";
  }
}

interface MutationRoute {
  readonly pattern: RegExp;
  readonly expectedSchema: string;
  readonly invoke: keyof Pick<
    ChallengeApiGateway,
    | "structureDefine"
    | "lockChallenge"
    | "startBenchmark"
    | "confirmReview"
    | "createDecisionMemo"
    | "confirmDecision"
    | "startRegression"
  >;
}

const MUTATION_ROUTES: readonly MutationRoute[] = Object.freeze([
  {
    pattern: /^\/api\/define\/structure$/,
    expectedSchema: "define-structure-command-v1",
    invoke: "structureDefine",
  },
  {
    pattern: /^\/api\/challenges\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/lock$/,
    expectedSchema: "challenge-lock-command-v1",
    invoke: "lockChallenge",
  },
  {
    pattern: /^\/api\/benchmarks\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/start$/,
    expectedSchema: "benchmark-start-command-v1",
    invoke: "startBenchmark",
  },
  {
    pattern: /^\/api\/reviews\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/confirm$/,
    expectedSchema: "review-confirmation-command-v1",
    invoke: "confirmReview",
  },
  {
    pattern: /^\/api\/decisions\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/memo$/,
    expectedSchema: "decision-memo-command-v1",
    invoke: "createDecisionMemo",
  },
  {
    pattern: /^\/api\/decisions\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/confirm$/,
    expectedSchema: "decision-confirmation-command-v1",
    invoke: "confirmDecision",
  },
  {
    pattern: /^\/api\/regressions\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/start$/,
    expectedSchema: "regression-start-command-v1",
    invoke: "startRegression",
  },
]);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new TypeError("mutation command의 exact 필드 계약이 다릅니다.");
  }
}

function assertPlainJson(
  value: unknown,
  location: string,
  depth = 0,
  state: { nodes: number } = { nodes: 0 },
): void {
  state.nodes += 1;
  if (state.nodes > 4_096 || depth > 32) {
    throw new TypeError(`${location}의 JSON 크기 또는 깊이가 제한을 초과합니다.`);
  }
  if (
    value === null
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && value.length <= 100_000)
  ) return;
  if (Array.isArray(value)) {
    if (value.length > 256) {
      throw new TypeError(`${location} 배열이 제한을 초과합니다.`);
    }
    value.forEach((item, index) => {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`${location}에는 sparse 배열을 허용하지 않습니다.`);
      }
      assertPlainJson(item, `${location}[${index}]`, depth + 1, state);
    });
    return;
  }
  if (!isPlainRecord(value) || Object.keys(value).length > 256) {
    throw new TypeError(`${location}은 제한된 plain JSON이어야 합니다.`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.length > 256 || /[\p{Cc}]/u.test(key)) {
      throw new TypeError(`${location}에 안전하지 않은 key가 있습니다.`);
    }
    assertPlainJson(child, `${location}.${key}`, depth + 1, state);
  }
}

const PRIVATE_RESPONSE_KEY = /^(?:api[_-]?key|authorization|private[_-]?mapping|label[_-]?to[_-]?candidate|(?:master|case)?[_-]?blinding[_-]?seed|raw[_-]?oracle|hidden[_-]?oracle|unrestricted[_-]?order)$/i;

function assertBrowserSafe(value: unknown, location = "response"): void {
  assertPlainJson(value, location);
  const visit = (child: unknown, path: string): void => {
    if (typeof child === "string" && /sk-[A-Za-z0-9_-]{16,}/.test(child)) {
      throw new ApiArtifactIntegrityError(
        "ARTIFACT_INTEGRITY",
        `${path}에 credential 형태가 있습니다.`,
      );
    }
    if (Array.isArray(child)) {
      child.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!isPlainRecord(child)) return;
    for (const [key, nested] of Object.entries(child)) {
      if (PRIVATE_RESPONSE_KEY.test(key)) {
        throw new ApiArtifactIntegrityError(
          "ARTIFACT_INTEGRITY",
          `${path}.${key}는 browser projection에 허용되지 않습니다.`,
        );
      }
      visit(nested, `${path}.${key}`);
    }
  };
  visit(value, location);
}

function assertPublicProjection(
  value: PublicProjection,
  expectedSchemaVersion: string | readonly string[],
  expectedIdentity?: Readonly<{ field: string; value: string }>,
): void {
  const expectedSchemas = typeof expectedSchemaVersion === "string"
    ? [expectedSchemaVersion]
    : expectedSchemaVersion;
  assertBrowserSafe(value);
  if (
    typeof value.schema_version !== "string"
    || !expectedSchemas.includes(value.schema_version)
    || value.synthetic !== true
    || (
      !expectedSchemas.includes("workspace-public-projection-v1")
      && (typeof value.source_hash !== "string" || !SHA256.test(value.source_hash))
    )
    || (
      expectedIdentity !== undefined
      && value[expectedIdentity.field] !== expectedIdentity.value
    )
  ) {
    throw new ApiArtifactIntegrityError(
      "ARTIFACT_INTEGRITY",
      "browser projection의 schema·synthetic·identity 계약이 다릅니다.",
    );
  }
}

function assertLoopback(url: URL): void {
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname)) {
    throw new TypeError("Challenge API는 loopback 요청만 허용합니다.");
  }
}

async function readCommand(
  request: Request,
  route: MutationRoute,
  targetId: string,
): Promise<ChallengeMutationCommand> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim()
    !== "application/json") {
    throw new TypeError("mutation은 application/json만 허용합니다.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new TypeError("mutation body가 64 KiB 제한을 초과합니다.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TypeError("mutation body는 JSON 객체여야 합니다.", { cause: error });
  }
  assertPlainJson(parsed, "mutation command");
  if (!isPlainRecord(parsed)) {
    throw new TypeError("mutation command는 JSON 객체여야 합니다.");
  }
  assertExactKeys(
    parsed,
    ["schema_version", "expected_source_hash", "idempotency_key"],
    ["payload"],
  );
  if (
    parsed.schema_version !== route.expectedSchema
    || typeof parsed.expected_source_hash !== "string"
    || !SHA256.test(parsed.expected_source_hash)
    || typeof parsed.idempotency_key !== "string"
    || !IDEMPOTENCY_KEY.test(parsed.idempotency_key)
    || !SAFE_ID.test(targetId)
    || (parsed.payload !== undefined && !isPlainRecord(parsed.payload))
  ) {
    throw new TypeError("mutation command의 version·hash·idempotency 계약이 다릅니다.");
  }
  return Object.freeze({
    schema_version: parsed.schema_version,
    expected_source_hash: parsed.expected_source_hash,
    idempotency_key: parsed.idempotency_key,
    target_id: targetId,
    ...(parsed.payload === undefined
      ? {}
      : { payload: Object.freeze(structuredClone(parsed.payload)) }),
  });
}

function unrecordedFailureReference(
  evidence: MutationFailureEvidence,
): DurableFailureReference {
  return Object.freeze({
    classification: evidence.classification,
    // 지속 artifact가 없는 순수 handler seam에서도 private provider evidence가
    // 아닌 고정된 공개 분류만 hash 입력으로 사용합니다.
    failureHash: sha256CanonicalJson({
      schema_version: "public-durable-mutation-failure-v1",
      classification: evidence.classification,
      retry_allowed: false,
    }),
  });
}

function sanitizedError(
  error: unknown,
  recordedFailure?: DurableFailureReference,
): Response {
  if (error instanceof ReplayedMutationFailureError) {
    const failureHash = error.failureReceiptHash
      ?? recordedFailure?.failureHash;
    if (failureHash === undefined) return json({ error: "ARTIFACT_INTEGRITY" }, 500);
    return json({
      error: "REPLAYED_MUTATION",
      retry_allowed: false,
      failure_classification: error.classification,
      failure_hash: failureHash,
    }, 409);
  }
  const providerFailure = buildMutationFailureEvidence(error);
  if (providerFailure !== null) {
    const failure = recordedFailure ?? unrecordedFailureReference(providerFailure);
    const status = providerFailure.classification
      === "PROVIDER_TEMPORARY_FAILURE"
      ? 503
      : 422;
    return json({
      error: providerFailure.classification,
      evaluation_status: "EVALUATION_INCOMPLETE",
      retry_allowed: false,
      failure_classification: failure.classification,
      failure_hash: failure.failureHash,
    }, status);
  }
  if (error instanceof ApiArtifactIntegrityError) {
    const status = error.code === "STALE_SOURCE"
      || error.code === "REPLAYED_MUTATION"
      ? 409
      : 500;
    return json({ error: error.code }, status);
  }
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (
      error.code === "MUTATION_REPLAYED"
      || error.code === "MUTATION_AMBIGUOUS"
    )
  ) {
    return json({
      error: error.code === "MUTATION_REPLAYED"
        ? "REPLAYED_MUTATION"
        : "MUTATION_AMBIGUOUS",
    }, 409);
  }
  if (error instanceof TypeError) return json({ error: "INVALID_REQUEST" }, 400);
  return json({ error: "ARTIFACT_INTEGRITY" }, 500);
}

export function createChallengeApiHandler({
  gateway,
  mutationJournal,
  reviewerAuthorizer,
}: {
  readonly gateway: ChallengeApiGateway;
  readonly mutationJournal?: ChallengeMutationJournal;
  readonly reviewerAuthorizer?: ReviewerSessionAuthorizer;
}): (request: Request) => Promise<Response> {
  const acceptedMutationKeys = new Set<string>();
  const failedMutations = new Map<string, DurableFailureReference>();
  const recordedFailures = new WeakMap<object, DurableFailureReference>();
  let mutationTail: Promise<void> = Promise.resolve();

  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const authorizeReviewer = (request: Request): Response | null => {
    // reviewer principal을 조립하지 않은 handler는 reviewer-private route를
    // fail-closed 합니다. 공개 workspace/Compare route에는 영향을 주지 않습니다.
    const status = reviewerAuthorizer === undefined
      ? 401
      : reviewerAuthorizer.authorize(request);
    if (status === null) return null;
    return json({ error: status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" }, status);
  };

  return async (request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      assertLoopback(url);
      if (request.method === "GET" && url.search === "") {
        if (url.pathname === "/api/workspace") {
          const projection = await gateway.getWorkspace();
          assertPublicProjection(projection, "workspace-public-projection-v1");
          return json(projection);
        }
        const challengeMatch = /^\/api\/challenges\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/
          .exec(url.pathname);
        if (challengeMatch) {
          const projection = await gateway.getChallenge(challengeMatch[1]);
          if (projection === null) return json({ error: "NOT_FOUND" }, 404);
          assertPublicProjection(
            projection,
            "challenge-public-projection-v1",
            { field: "challenge_id", value: challengeMatch[1] },
          );
          return json(projection);
        }
        const evidenceMatch = /^\/api\/evidence\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/
          .exec(url.pathname);
        if (evidenceMatch) {
          const projection = await gateway.getEvidence(evidenceMatch[1]);
          if (projection === null) return json({ error: "NOT_FOUND" }, 404);
          assertPublicProjection(
            projection,
            "evidence-public-projection-v1",
            { field: "evidence_id", value: evidenceMatch[1] },
          );
          return json(projection);
        }
        const reviewerEvidenceMatch = /^\/api\/reviewer\/evidence\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(url.pathname);
        if (reviewerEvidenceMatch) {
          const authorizationFailure = authorizeReviewer(request);
          if (authorizationFailure !== null) return authorizationFailure;
          const handle = request.headers.get("x-review-evidence-handle");
          if (handle === null || !/^evh_[a-f0-9]{64}$/.test(handle)) {
            return json({ error: "NOT_FOUND" }, 404);
          }
          const loader = (gateway as ReviewerBlindEvidenceGateway)
            .getReviewerBlindEvidenceDetail;
          if (loader === undefined) return json({ error: "NOT_FOUND" }, 404);
          const detail = await loader({
            evidenceId: reviewerEvidenceMatch[1],
            evidenceHandle: handle,
          });
          if (detail === null) return json({ error: "NOT_FOUND" }, 404);
          return json(detail);
        }
        const reviewMatch = /^\/api\/reviews\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(
          url.pathname,
        );
        if (reviewMatch) {
          const authorizationFailure = authorizeReviewer(request);
          if (authorizationFailure !== null) return authorizationFailure;
          const projection = await gateway.getBlindReview(reviewMatch[1]);
          if (projection === null) return json({ error: "NOT_FOUND" }, 404);
          assertPublicProjection(
            projection,
            [
              "blind-review-public-projection-v1",
              "preconfirmation-public-projection-v1",
            ],
            { field: "review_id", value: reviewMatch[1] },
          );
          return json(projection);
        }
        const progressMatch = /^\/api\/benchmarks\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/progress$/
          .exec(url.pathname);
        if (progressMatch) {
          const projection = await gateway.getBenchmarkProgress(progressMatch[1]);
          if (projection === null) return json({ error: "NOT_FOUND" }, 404);
          assertPublicProjection(
            projection,
            [
              "benchmark-progress-projection-v1",
              "benchmark-lifecycle-ready-projection-v1",
              "benchmark-lifecycle-projection-v1",
              "benchmark-lifecycle-invalid-projection-v1",
            ],
            { field: "benchmark_id", value: progressMatch[1] },
          );
          return json(projection);
        }
        const readRoutes = [
          {
            pattern: /^\/api\/decisions\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/,
            loader: gateway.getDecision,
            schema: "decision-public-projection-v1",
            identityField: "decision_id",
          },
          {
            pattern: /^\/api\/baselines\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/,
            loader: gateway.getBaseline,
            schema: "baseline-public-projection-v1",
            identityField: "baseline_id",
          },
          {
            pattern: /^\/api\/regressions\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/,
            loader: gateway.getRegression,
            schema: "regression-public-projection-v1",
            identityField: "regression_id",
          },
        ] as const;
        for (const route of readRoutes) {
          const match = route.pattern.exec(url.pathname);
          if (!match) continue;
          const projection = await route.loader(match[1]);
          if (projection === null) return json({ error: "NOT_FOUND" }, 404);
          assertPublicProjection(projection, route.schema, {
            field: route.identityField,
            value: match[1],
          });
          return json(projection);
        }
      }

      if (request.method === "POST") {
        if (url.search !== "") {
          throw new TypeError("mutation query string은 권위 입력으로 허용되지 않습니다.");
        }
        for (const route of MUTATION_ROUTES) {
          const match = route.pattern.exec(url.pathname);
          if (!match) continue;
          if (route.invoke === "confirmReview") {
            const authorizationFailure = authorizeReviewer(request);
            if (authorizationFailure !== null) return authorizationFailure;
          }
          const targetId = match[1] ?? "define";
          const command = await readCommand(request, route, targetId);
          return await serialize(async () => {
            if (acceptedMutationKeys.has(command.idempotency_key)) {
              const failureClassification = failedMutations.get(
                command.idempotency_key,
              );
              if (failureClassification !== undefined) {
                throw new ReplayedMutationFailureError(
                  command.idempotency_key,
                  failureClassification.classification,
                  failureClassification.failureHash,
                );
              }
              throw new ApiArtifactIntegrityError(
                "REPLAYED_MUTATION",
                "이미 수락한 mutation key입니다.",
              );
            }
            const operation = gateway[route.invoke] as (
              value: ChallengeMutationCommand,
            ) => Promise<ChallengeMutationResult>;
            let result: ChallengeMutationResult;
            if (mutationJournal) {
              try {
                result = await mutationJournal.execute(
                  command,
                  () => operation(command),
                );
              } catch (error) {
                const failure = buildMutationFailureEvidence(error);
                if (failure !== null && typeof error === "object" && error !== null) {
                  recordedFailures.set(error, Object.freeze({
                    classification: failure.classification,
                    failureHash: mutationFailureReceiptHash(command, failure),
                  }));
                }
                throw error;
              }
            } else {
              // 테스트/순수 handler 경계에서도 호출 전에 선점해 같은 프로세스 replay를 막습니다.
              acceptedMutationKeys.add(command.idempotency_key);
              try {
                result = await operation(command);
              } catch (error) {
                const failure = buildMutationFailureEvidence(error);
                if (failure !== null) {
                  failedMutations.set(
                    command.idempotency_key,
                    unrecordedFailureReference(failure),
                  );
                }
                throw error;
              }
            }
            assertBrowserSafe(result);
            if (
              result.accepted !== true
              || typeof result.source_hash !== "string"
              || !SHA256.test(result.source_hash)
            ) {
              throw new ApiArtifactIntegrityError(
                "ARTIFACT_INTEGRITY",
                "mutation 결과가 권위 source hash를 제공하지 않습니다.",
              );
            }
            return json(result);
          });
        }
      }
      return json({ error: "NOT_FOUND" }, 404);
    } catch (error) {
      return sanitizedError(
        error,
        typeof error === "object" && error !== null
          ? recordedFailures.get(error)
          : undefined,
      );
    }
  };
}

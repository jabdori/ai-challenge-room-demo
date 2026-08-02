import type {
  ConfirmDemoReviewInput,
  CreateDemoMemoInput,
} from "../hackathonDemoController";
import type {
  DemoBlindLabel,
} from "../../shared/hackathonDemo";
import type {
  LiveDemoWorkflowErrorCode,
  LiveDemoWorkflowService,
} from "./liveDemoWorkflowService";
import type {
  JudgeAccessAuth,
} from "./judgeAccessAuth";
import {
  assertPublicDemoProjection,
} from "./publicProjectionGuard";

const MAX_JSON_BODY_BYTES = 64 * 1_024;
const JSON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
});
const EXECUTION_ID = /^cmp_[A-Za-z0-9][A-Za-z0-9_-]{7,123}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const BLIND_LABEL_ORDER = ["X", "Y", "Z"] as const;
const BLIND_LABELS = new Set<DemoBlindLabel>(BLIND_LABEL_ORDER);
const CANDIDATE_IDS = new Set(["A", "B", "C"]);

type JsonRecord = Record<string, unknown>;
type PublicErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "NOT_FOUND"
  | "INTERNAL_ERROR"
  | Exclude<LiveDemoWorkflowErrorCode, "EXECUTION_NOT_OWNED">;

const WORKFLOW_PUBLIC_ERRORS: Readonly<Record<
  LiveDemoWorkflowErrorCode,
  { readonly code: PublicErrorCode; readonly status: number }
>> = Object.freeze({
  EXECUTION_NOT_FOUND: { code: "EXECUTION_NOT_FOUND", status: 404 },
  EXECUTION_NOT_OWNED: { code: "EXECUTION_NOT_FOUND", status: 404 },
  INVALID_STATE: { code: "INVALID_STATE", status: 409 },
  DUPLICATE_RUN: { code: "DUPLICATE_RUN", status: 409 },
  LIVE_RESULTS_REQUIRED: { code: "LIVE_RESULTS_REQUIRED", status: 409 },
  RUN_CAP_REACHED: { code: "RUN_CAP_REACHED", status: 429 },
  ARTIFACT_UNAVAILABLE: { code: "ARTIFACT_UNAVAILABLE", status: 503 },
  STALE_EXECUTION: { code: "STALE_EXECUTION", status: 409 },
});

export const SITES_DEMO_API_ROUTES = Object.freeze({
  public: [
    "GET /api/auth/session",
    "POST /api/auth/login",
  ],
  protected: [
    "POST /api/auth/logout",
    "GET /api/challenge",
    "POST /api/live-comparisons",
    "POST /api/live-comparisons/:executionId/run",
    "GET /api/live-comparisons/current",
    "GET /api/live-comparisons/:executionId",
    "GET /api/live-comparisons/:executionId/results",
    "POST /api/live-comparisons/:executionId/judge",
    "GET /api/live-comparisons/:executionId/evidence/:blindLabel",
    "POST /api/live-comparisons/:executionId/reviews",
    "POST /api/live-comparisons/:executionId/selection",
    "POST /api/live-comparisons/:executionId/memo",
    "POST /api/live-comparisons/:executionId/regression",
    "POST /api/recorded-demo/select",
  ],
} as const);

export interface SitesDemoApiOptions {
  readonly auth: JudgeAccessAuth;
  readonly service: LiveDemoWorkflowService;
}

export type SitesDemoApi = (request: Request) => Promise<Response>;

class RequestContractError extends Error {
  readonly code: "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE";

  constructor(code: RequestContractError["code"]) {
    super(code);
    this.name = "RequestContractError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: JsonRecord,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actualKeys.length === expected.length
    && actualKeys.every((key, index) => key === expected[index]);
}

function isBoundedText(
  value: unknown,
  maximumLength = 4_096,
): value is string {
  return typeof value === "string"
    && value.length <= maximumLength
    && value.trim().length > 0
    && !/\p{Cc}/u.test(value);
}

function assertSameOriginMutation(request: Request): void {
  const requestUrl = new URL(request.url);
  if (request.headers.get("origin") !== requestUrl.origin) {
    throw new RequestContractError("INVALID_REQUEST");
  }
}

function assertJsonContentType(request: Request): void {
  const mediaType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new RequestContractError("INVALID_REQUEST");
  }
}

async function readBodyBytes(request: Request): Promise<Uint8Array> {
  const rawLength = request.headers.get("content-length");
  if (rawLength !== null) {
    const contentLength = Number(rawLength);
    if (
      !Number.isSafeInteger(contentLength)
      || contentLength < 0
    ) {
      throw new RequestContractError("INVALID_REQUEST");
    }
    if (contentLength > MAX_JSON_BODY_BYTES) {
      throw new RequestContractError("PAYLOAD_TOO_LARGE");
    }
  }
  if (request.body === null) {
    throw new RequestContractError("INVALID_REQUEST");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new RequestContractError("PAYLOAD_TOO_LARGE");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJsonMutation(request: Request): Promise<unknown> {
  assertSameOriginMutation(request);
  assertJsonContentType(request);
  try {
    const bytes = await readBodyBytes(request);
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ) as unknown;
  } catch (error) {
    if (error instanceof RequestContractError) throw error;
    throw new RequestContractError("INVALID_REQUEST");
  }
}

function assertEmptyBody(value: unknown): void {
  if (!isRecord(value) || !hasExactKeys(value, [])) {
    throw new RequestContractError("INVALID_REQUEST");
  }
}

function parseCreateBody(value: unknown): string {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["idempotency_key"])
    || typeof value.idempotency_key !== "string"
    || !IDEMPOTENCY_KEY.test(value.idempotency_key)
  ) {
    throw new RequestContractError("INVALID_REQUEST");
  }
  return value.idempotency_key;
}

function parseReviewBody(value: unknown): ConfirmDemoReviewInput {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "reviewer",
      "rationale",
      "decisions",
    ])
    || !isBoundedText(value.reviewer)
    || !isBoundedText(value.rationale)
    || !Array.isArray(value.decisions)
    || value.decisions.length !== BLIND_LABEL_ORDER.length
  ) {
    throw new RequestContractError("INVALID_REQUEST");
  }

  const decisions: Array<{
    readonly blind_label: DemoBlindLabel;
    readonly decision: "PASS" | "CONFIRMED_FAIL";
  }> = [];
  for (const decision of value.decisions) {
    if (
      !isRecord(decision)
      || !hasExactKeys(decision, ["blind_label", "decision"])
      || typeof decision.blind_label !== "string"
      || !BLIND_LABELS.has(decision.blind_label as DemoBlindLabel)
      || (
        decision.decision !== "PASS"
        && decision.decision !== "CONFIRMED_FAIL"
      )
    ) {
      throw new RequestContractError("INVALID_REQUEST");
    }
    decisions.push({
      blind_label: decision.blind_label as DemoBlindLabel,
      decision: decision.decision,
    });
  }
  if (decisions.some(
    (decision, index) => decision.blind_label !== BLIND_LABEL_ORDER[index],
  )) {
    throw new RequestContractError("INVALID_REQUEST");
  }
  return {
    reviewer: value.reviewer,
    rationale: value.rationale,
    decisions,
  };
}

function parseSelectionBody(value: unknown): CreateDemoMemoInput {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["selected_candidate_id", "rationale"])
    || typeof value.selected_candidate_id !== "string"
    || !CANDIDATE_IDS.has(value.selected_candidate_id)
    || !isBoundedText(value.rationale)
  ) {
    throw new RequestContractError("INVALID_REQUEST");
  }
  return {
    selected_candidate_id: value.selected_candidate_id as "A" | "B" | "C",
    rationale: value.rationale,
  };
}

function parseExecutionId(value: string): string {
  if (!EXECUTION_ID.test(value)) {
    throw new RequestContractError("INVALID_REQUEST");
  }
  return value;
}

function parseBlindLabel(value: string): DemoBlindLabel {
  if (!BLIND_LABELS.has(value as DemoBlindLabel)) {
    throw new RequestContractError("INVALID_REQUEST");
  }
  return value as DemoBlindLabel;
}

function json(value: unknown, status = 200, setCookie?: string): Response {
  assertPublicDemoProjection(value);
  const headers = new Headers(JSON_HEADERS);
  if (setCookie) headers.set("set-cookie", setCookie);
  return new Response(JSON.stringify(value), {
    status,
    headers,
  });
}

function publicError(code: PublicErrorCode, status: number): Response {
  return json({ error: { code } }, status);
}

async function projectAuthResponse(response: Response | null): Promise<Response> {
  if (response === null) return publicError("NOT_FOUND", 404);
  const contentType = response.headers.get("content-type")
    ?.toLowerCase();
  if (!contentType?.startsWith("application/json")) {
    throw new Error("AUTH_RESPONSE_NOT_JSON");
  }
  const value = await response.json() as unknown;
  return json(value, response.status, response.headers.get("set-cookie") ?? undefined);
}

function workflowErrorResponse(error: unknown): Response | null {
  if (
    !(error instanceof Error)
    || error.name !== "LiveDemoWorkflowError"
    || typeof (error as Error & { code?: unknown }).code !== "string"
  ) {
    return null;
  }
  const mapped = WORKFLOW_PUBLIC_ERRORS[
    (error as Error & { code: string }).code as LiveDemoWorkflowErrorCode
  ];
  return mapped ? publicError(mapped.code, mapped.status) : null;
}

async function routeProtectedRequest(
  request: Request,
  sessionTokenDigest: string,
  service: LiveDemoWorkflowService,
  auth: JudgeAccessAuth,
): Promise<Response> {
  const { pathname, search } = new URL(request.url);
  if (search !== "") {
    throw new RequestContractError("INVALID_REQUEST");
  }
  const method = request.method;
  let body: unknown = undefined;
  if (method === "POST") {
    body = await readJsonMutation(request);
  }

  if (method === "POST" && pathname === "/api/auth/logout") {
    assertEmptyBody(body);
    return projectAuthResponse(await auth.handleAuthRoute(request));
  }
  if (method === "GET" && pathname === "/api/challenge") {
    return json(service.getChallenge());
  }
  if (method === "POST" && pathname === "/api/live-comparisons") {
    return json(await service.createLiveComparison({
      sessionTokenDigest,
      idempotencyKey: parseCreateBody(body),
    }));
  }
  if (
    method === "GET"
    && pathname === "/api/live-comparisons/current"
  ) {
    return json(await service.getCurrentExecution(sessionTokenDigest));
  }
  if (
    method === "POST"
    && pathname === "/api/recorded-demo/select"
  ) {
    assertEmptyBody(body);
    return json(await service.selectRecordedFallback({
      sessionTokenDigest,
    }));
  }

  const livePath = pathname.match(
    /^\/api\/live-comparisons\/([^/]+)(?:\/(.*))?$/,
  );
  if (livePath === null) return publicError("NOT_FOUND", 404);
  const executionId = parseExecutionId(livePath[1] ?? "");
  const suffix = livePath[2];

  if (method === "GET" && suffix === undefined) {
    return json(await service.getExecution({
      sessionTokenDigest,
      executionId,
    }));
  }
  if (method === "POST" && suffix === "run") {
    assertEmptyBody(body);
    return json(await service.runComparison({
      sessionTokenDigest,
      executionId,
    }));
  }
  if (method === "GET" && suffix === "results") {
    return json(await service.getResults({
      sessionTokenDigest,
      executionId,
    }));
  }
  if (method === "POST" && suffix === "judge") {
    assertEmptyBody(body);
    return json(await service.runJudge({
      sessionTokenDigest,
      executionId,
    }));
  }
  if (method === "POST" && suffix === "reviews") {
    return json(await service.confirmReviews({
      sessionTokenDigest,
      executionId,
      review: parseReviewBody(body),
    }));
  }
  if (method === "POST" && suffix === "selection") {
    return json(await service.selectCandidate({
      sessionTokenDigest,
      executionId,
      selection: parseSelectionBody(body),
    }));
  }
  if (method === "POST" && suffix === "memo") {
    assertEmptyBody(body);
    return json(await service.createDecisionMemo({
      sessionTokenDigest,
      executionId,
    }));
  }
  if (method === "POST" && suffix === "regression") {
    assertEmptyBody(body);
    return json(await service.replayRegression({
      sessionTokenDigest,
      executionId,
    }));
  }

  const evidencePath = suffix?.match(/^evidence\/([^/]+)$/);
  if (method === "GET" && evidencePath) {
    return json(await service.getEvidence({
      sessionTokenDigest,
      executionId,
      blindLabel: parseBlindLabel(evidencePath[1] ?? ""),
    }));
  }
  return publicError("NOT_FOUND", 404);
}

export function createSitesDemoApi(
  options: SitesDemoApiOptions,
): SitesDemoApi {
  return async (request) => {
    try {
      const { pathname, search } = new URL(request.url);
      const publicSession = request.method === "GET"
        && pathname === "/api/auth/session";
      const publicLogin = request.method === "POST"
        && pathname === "/api/auth/login";

      if (publicSession) {
        if (search !== "") {
          throw new RequestContractError("INVALID_REQUEST");
        }
        return await projectAuthResponse(
          await options.auth.handleAuthRoute(request),
        );
      }
      if (publicLogin) {
        if (search !== "") {
          throw new RequestContractError("INVALID_REQUEST");
        }
        await readJsonMutation(request.clone());
        return await projectAuthResponse(
          await options.auth.handleAuthRoute(request),
        );
      }

      const session = await options.auth.authenticate(request);
      if (session === null) {
        return publicError("UNAUTHORIZED", 401);
      }
      return await routeProtectedRequest(
        request,
        session.sessionTokenDigest,
        options.service,
        options.auth,
      );
    } catch (error) {
      if (error instanceof RequestContractError) {
        return error.code === "PAYLOAD_TOO_LARGE"
          ? publicError("PAYLOAD_TOO_LARGE", 413)
          : publicError("INVALID_REQUEST", 400);
      }
      return workflowErrorResponse(error)
        ?? publicError("INTERNAL_ERROR", 500);
    }
  };
}

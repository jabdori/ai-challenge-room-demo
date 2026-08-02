import {
  assertDemoProjectionPublicSafe,
} from "../../eval/demo/publicProjectionSafety";
import {
  parseHackathonDemoState,
} from "../../shared/hackathonDemo";
import type {
  DemoBlindLabel,
  DemoCandidateId,
  HackathonDemoState,
} from "../../shared/hackathonDemo";

export interface JudgeAuthSession {
  readonly authenticated: boolean;
}

export interface LiveDemoChallenge {
  readonly schema_version: "live-demo-challenge-v1";
  readonly synthetic: true;
  readonly locked: true;
  readonly case_id: string;
  readonly as_of: string;
  readonly ticket: string;
  readonly candidates: readonly ["A", "B", "C"];
  readonly runs_per_candidate: 1;
  readonly external_action_statement:
    "No purchase, contract, deployment, or rollback was executed.";
}

export interface LiveDemoExecution {
  readonly schema_version: "live-demo-execution-v1";
  readonly execution_id: string;
  readonly source: "LIVE" | "RECORDED_FALLBACK";
  readonly status:
    | "READY"
    | "RUNNING"
    | "INTERRUPTED"
    | "FAILED"
    | "RESULTS_READY"
    | "JUDGE_READY"
    | "REVIEW_READY"
    | "NO_APPROVED_CANDIDATE"
    | "SELECTION_RECORDED"
    | "MEMO_RUNNING"
    | "MEMO_FAILED"
    | "MEMO_READY"
    | "REGRESSION_BLOCK";
  readonly progress_step: string;
  readonly current_candidate: DemoCandidateId | null;
  readonly completed_candidate_count: number;
  readonly created_at_ms: number;
  readonly started_at_ms: number | null;
  readonly heartbeat_at_ms: number | null;
  readonly completed_at_ms: number | null;
  readonly retry_count: number;
  readonly error_code: string | null;
  readonly cleanup_status: "NOT_STARTED" | "RUNNING" | "ACKNOWLEDGED" | "FAILED";
  readonly actual_cost_micro_usd: number;
  readonly artifacts: {
    readonly evaluation_pack_persisted: boolean;
    readonly public_projection_persisted: boolean;
    readonly cleanup_receipt_persisted: boolean;
  };
}

export interface LiveDemoEvidence {
  readonly case_id: string;
  readonly blind_label: DemoBlindLabel;
  readonly runs: ReadonlyArray<{
    readonly repetition: 1 | 2;
    readonly customer_reply: string;
    readonly citations: readonly string[];
  }>;
  readonly judge_risk: {
    readonly blind_label: DemoBlindLabel;
    readonly status: "NO_RISK" | "RISK";
    readonly failure_types: readonly string[];
  } | null;
}

export interface ConfirmLiveDemoReviewsInput {
  readonly reviewer: string;
  readonly rationale: string;
  readonly decisions: readonly [
    {
      readonly blind_label: "X";
      readonly decision: "PASS" | "CONFIRMED_FAIL";
    },
    {
      readonly blind_label: "Y";
      readonly decision: "PASS" | "CONFIRMED_FAIL";
    },
    {
      readonly blind_label: "Z";
      readonly decision: "PASS" | "CONFIRMED_FAIL";
    },
  ];
}

export interface SelectLiveDemoCandidateInput {
  readonly selected_candidate_id: DemoCandidateId;
  readonly rationale: string;
}

export interface RecordedDemoSelection {
  readonly execution: LiveDemoExecution;
  readonly state: HackathonDemoState;
}

export const JUDGE_ACCESS_ERROR_MESSAGE =
  "Judge access could not be verified. Please try again.";

export class AuthExpiredError extends Error {
  constructor() {
    super("Judge session expired.");
    this.name = "AuthExpiredError";
  }
}

export class SitesDemoApiError extends Error {
  constructor() {
    super(JUDGE_ACCESS_ERROR_MESSAGE);
    this.name = "SitesDemoApiError";
  }
}

type JsonRecord = Record<string, unknown>;

const EXECUTION_ID = /^cmp_[A-Za-z0-9][A-Za-z0-9_-]{7,123}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const CANDIDATE_IDS = new Set<DemoCandidateId>(["A", "B", "C"]);
const BLIND_LABELS = new Set<DemoBlindLabel>(["X", "Y", "Z"]);
const EXECUTION_STATUSES = new Set<LiveDemoExecution["status"]>([
  "READY",
  "RUNNING",
  "INTERRUPTED",
  "FAILED",
  "RESULTS_READY",
  "JUDGE_READY",
  "REVIEW_READY",
  "NO_APPROVED_CANDIDATE",
  "SELECTION_RECORDED",
  "MEMO_RUNNING",
  "MEMO_FAILED",
  "MEMO_READY",
  "REGRESSION_BLOCK",
]);
const CLEANUP_STATUSES = new Set<LiveDemoExecution["cleanup_status"]>([
  "NOT_STARTED",
  "RUNNING",
  "ACKNOWLEDGED",
  "FAILED",
]);
const SENSITIVE_PUBLIC_KEYS = new Set([
  "apikey",
  "accesscodehash",
  "demoaccesscodehash",
  "fileid",
  "idempotencykey",
  "leasetokendigest",
  "networkfingerprint",
  "openaiapikey",
  "providerid",
  "providerrequestid",
  "providerresponseid",
  "remoteid",
  "remoteresourceid",
  "requestid",
  "responseid",
  "sessiontokendigest",
  "uploadedfileid",
  "vectorstoreid",
]);
const EXTERNAL_ACTION_STATEMENT =
  "No purchase, contract, deployment, or rollback was executed." as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeKey(key: string): string {
  return key.normalize("NFKC").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isSensitivePublicKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_PUBLIC_KEYS.has(normalized)
    || normalized === "token"
    || (normalized.endsWith("token") && !normalized.endsWith("tokens"))
    || normalized.includes("secret")
    || normalized.includes("credential")
    || normalized.includes("password")
    || normalized.includes("authorization")
    || normalized.includes("private")
    || normalized.includes("revealed")
    || (
      normalized.includes("candidate")
      && (
        normalized.includes("mapping")
        || normalized.endsWith("map")
        || normalized.includes("label")
        || normalized.includes("blind")
      )
    );
}

function isStructuralCandidateMapping(value: JsonRecord): boolean {
  const keys = new Set(Object.keys(value).map(normalizeKey));
  if (
    keys.has("blindlabel")
    && (keys.has("candidateid") || keys.has("candidateidentity"))
  ) {
    return true;
  }
  const entries = Object.entries(value);
  return entries.length === 3 && entries.every(([key, child]) => (
    ["x", "y", "z"].includes(normalizeKey(key))
    && typeof child === "string"
    && ["a", "b", "c"].includes(normalizeKey(child))
  ));
}

function assertBrowserPublicProjection(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      assertBrowserPublicProjection(child, `${path}[${index}]`);
    });
    return;
  }
  if (!isRecord(value)) return;
  if (isStructuralCandidateMapping(value)) {
    throw new SitesDemoApiError();
  }
  for (const [key, child] of Object.entries(value)) {
    if (isSensitivePublicKey(key)) {
      throw new SitesDemoApiError();
    }
    assertBrowserPublicProjection(child, `${path}.${key}`);
  }
}

function assertPublicProjection(value: unknown): void {
  try {
    assertDemoProjectionPublicSafe(value);
    assertBrowserPublicProjection(value);
  } catch (error) {
    if (error instanceof SitesDemoApiError) throw error;
    throw new SitesDemoApiError();
  }
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index]);
}

function isText(value: unknown, maximumLength = 32_768): value is string {
  return typeof value === "string"
    && value.length <= maximumLength
    && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

function requireExecutionId(value: string): string {
  if (!EXECUTION_ID.test(value)) throw new SitesDemoApiError();
  return value;
}

function requireIdempotencyKey(value: string): string {
  if (!IDEMPOTENCY_KEY.test(value)) throw new SitesDemoApiError();
  return value;
}

function requireBlindLabel(value: string): DemoBlindLabel {
  if (!BLIND_LABELS.has(value as DemoBlindLabel)) {
    throw new SitesDemoApiError();
  }
  return value as DemoBlindLabel;
}

function parseChallenge(value: unknown): LiveDemoChallenge {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "schema_version",
      "synthetic",
      "locked",
      "case_id",
      "as_of",
      "ticket",
      "candidates",
      "runs_per_candidate",
      "external_action_statement",
    ])
    || value.schema_version !== "live-demo-challenge-v1"
    || value.synthetic !== true
    || value.locked !== true
    || !isText(value.case_id, 256)
    || !isText(value.as_of, 128)
    || !isText(value.ticket)
    || !Array.isArray(value.candidates)
    || value.candidates.length !== 3
    || value.candidates[0] !== "A"
    || value.candidates[1] !== "B"
    || value.candidates[2] !== "C"
    || value.runs_per_candidate !== 1
    || value.external_action_statement !== EXTERNAL_ACTION_STATEMENT
  ) {
    throw new SitesDemoApiError();
  }
  return value as unknown as LiveDemoChallenge;
}

function parseExecution(value: unknown): LiveDemoExecution {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "schema_version",
      "execution_id",
      "source",
      "status",
      "progress_step",
      "current_candidate",
      "completed_candidate_count",
      "created_at_ms",
      "started_at_ms",
      "heartbeat_at_ms",
      "completed_at_ms",
      "retry_count",
      "error_code",
      "cleanup_status",
      "actual_cost_micro_usd",
      "artifacts",
    ])
    || value.schema_version !== "live-demo-execution-v1"
    || typeof value.execution_id !== "string"
    || !EXECUTION_ID.test(value.execution_id)
    || (value.source !== "LIVE" && value.source !== "RECORDED_FALLBACK")
    || typeof value.status !== "string"
    || !EXECUTION_STATUSES.has(value.status as LiveDemoExecution["status"])
    || !isText(value.progress_step, 256)
    || (
      value.current_candidate !== null
      && (
        typeof value.current_candidate !== "string"
        || !CANDIDATE_IDS.has(value.current_candidate as DemoCandidateId)
      )
    )
    || !isNonNegativeInteger(value.completed_candidate_count)
    || (value.completed_candidate_count as number) > 3
    || !isNonNegativeInteger(value.created_at_ms)
    || !isNullableNonNegativeInteger(value.started_at_ms)
    || !isNullableNonNegativeInteger(value.heartbeat_at_ms)
    || !isNullableNonNegativeInteger(value.completed_at_ms)
    || !isNonNegativeInteger(value.retry_count)
    || (
      value.error_code !== null
      && !isText(value.error_code, 256)
    )
    || typeof value.cleanup_status !== "string"
    || !CLEANUP_STATUSES.has(
      value.cleanup_status as LiveDemoExecution["cleanup_status"],
    )
    || !isNonNegativeInteger(value.actual_cost_micro_usd)
    || !isRecord(value.artifacts)
    || !hasExactKeys(value.artifacts, [
      "evaluation_pack_persisted",
      "public_projection_persisted",
      "cleanup_receipt_persisted",
    ])
    || typeof value.artifacts.evaluation_pack_persisted !== "boolean"
    || typeof value.artifacts.public_projection_persisted !== "boolean"
    || typeof value.artifacts.cleanup_receipt_persisted !== "boolean"
  ) {
    throw new SitesDemoApiError();
  }
  return value as unknown as LiveDemoExecution;
}

function parseExpectedExecution(
  value: unknown,
  executionId: string,
): LiveDemoExecution {
  const parsed = parseExecution(value);
  if (parsed.execution_id !== executionId) throw new SitesDemoApiError();
  return parsed;
}

function parseLiveExecution(value: unknown): LiveDemoExecution {
  const parsed = parseExecution(value);
  if (parsed.source !== "LIVE") throw new SitesDemoApiError();
  return parsed;
}

function parseExpectedLiveExecution(
  value: unknown,
  executionId: string,
): LiveDemoExecution {
  const parsed = parseExpectedExecution(value, executionId);
  if (parsed.source !== "LIVE") throw new SitesDemoApiError();
  return parsed;
}

function parseCurrentExecution(value: unknown): LiveDemoExecution | null {
  return value === null ? null : parseExecution(value);
}

function parseDemoState(value: unknown): HackathonDemoState {
  try {
    return parseHackathonDemoState(value);
  } catch {
    throw new SitesDemoApiError();
  }
}

function parseEvidenceRun(value: unknown, index: number): LiveDemoEvidence["runs"][number] {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["repetition", "customer_reply", "citations"])
    || value.repetition !== index + 1
    || !isText(value.customer_reply)
    || !Array.isArray(value.citations)
    || value.citations.some((citation) => !isText(citation, 1_024))
  ) {
    throw new SitesDemoApiError();
  }
  return value as unknown as LiveDemoEvidence["runs"][number];
}

function parseEvidence(
  value: unknown,
  expectedBlindLabel: DemoBlindLabel,
): LiveDemoEvidence {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "case_id",
      "blind_label",
      "runs",
      "judge_risk",
    ])
    || !isText(value.case_id, 256)
    || value.blind_label !== expectedBlindLabel
    || !Array.isArray(value.runs)
    || value.runs.length < 1
    || value.runs.length > 2
  ) {
    throw new SitesDemoApiError();
  }
  const runs = value.runs.map(parseEvidenceRun);
  let judgeRisk: LiveDemoEvidence["judge_risk"] = null;
  if (value.judge_risk !== null) {
    const risk = value.judge_risk;
    if (
      !isRecord(risk)
      || !hasExactKeys(risk, [
        "blind_label",
        "status",
        "failure_types",
      ])
      || risk.blind_label !== expectedBlindLabel
      || (risk.status !== "NO_RISK" && risk.status !== "RISK")
      || !Array.isArray(risk.failure_types)
      || risk.failure_types.some((failureType) => !isText(failureType, 256))
    ) {
      throw new SitesDemoApiError();
    }
    judgeRisk = risk as unknown as NonNullable<LiveDemoEvidence["judge_risk"]>;
  }
  return {
    case_id: value.case_id,
    blind_label: expectedBlindLabel,
    runs,
    judge_risk: judgeRisk,
  };
}

function parseReviewInput(value: unknown): ConfirmLiveDemoReviewsInput {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "reviewer",
      "rationale",
      "decisions",
    ])
    || !isText(value.reviewer, 4_096)
    || !isText(value.rationale, 4_096)
    || !Array.isArray(value.decisions)
    || value.decisions.length !== 3
  ) {
    throw new SitesDemoApiError();
  }
  const expectedLabels = ["X", "Y", "Z"] as const;
  value.decisions.forEach((decision, index) => {
    if (
      !isRecord(decision)
      || !hasExactKeys(decision, ["blind_label", "decision"])
      || decision.blind_label !== expectedLabels[index]
      || (
        decision.decision !== "PASS"
        && decision.decision !== "CONFIRMED_FAIL"
      )
    ) {
      throw new SitesDemoApiError();
    }
  });
  return value as unknown as ConfirmLiveDemoReviewsInput;
}

function parseSelectionInput(value: unknown): SelectLiveDemoCandidateInput {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["selected_candidate_id", "rationale"])
    || typeof value.selected_candidate_id !== "string"
    || !CANDIDATE_IDS.has(value.selected_candidate_id as DemoCandidateId)
    || !isText(value.rationale, 4_096)
  ) {
    throw new SitesDemoApiError();
  }
  return value as unknown as SelectLiveDemoCandidateInput;
}

function parseRecordedSelection(value: unknown): RecordedDemoSelection {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["execution", "state"])
  ) {
    throw new SitesDemoApiError();
  }
  const execution = parseExecution(value.execution);
  const state = parseDemoState(value.state);
  if (
    execution.source !== "RECORDED_FALLBACK"
    || state.source !== "RECORDED_FALLBACK"
  ) {
    throw new SitesDemoApiError();
  }
  return { execution, state };
}

function parseJudgeAuthSession(value: unknown): JudgeAuthSession {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || typeof (value as { authenticated?: unknown }).authenticated !== "boolean"
  ) {
    throw new SitesDemoApiError();
  }
  return {
    authenticated: (value as { authenticated: boolean }).authenticated,
  };
}

export async function requestJson<T>(
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...init.headers,
      },
    });
  } catch {
    throw new SitesDemoApiError();
  }
  if (response.status === 401) throw new AuthExpiredError();
  if (!response.ok) throw new SitesDemoApiError();
  const responseMediaType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (responseMediaType !== "application/json") {
    throw new SitesDemoApiError();
  }
  try {
    const value = await response.json() as unknown;
    assertPublicProjection(value);
    return parse(value);
  } catch (error) {
    if (error instanceof SitesDemoApiError) throw error;
    throw new SitesDemoApiError();
  }
}

export function getSession(): Promise<JudgeAuthSession> {
  return requestJson("/api/auth/session", { method: "GET" }, parseJudgeAuthSession);
}

export function login(accessCode: string): Promise<JudgeAuthSession> {
  return requestJson(
    "/api/auth/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_code: accessCode }),
    },
    parseJudgeAuthSession,
  );
}

export function logout(): Promise<JudgeAuthSession> {
  return requestJson(
    "/api/auth/logout",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
    parseJudgeAuthSession,
  );
}

function get<T>(path: string, parse: (value: unknown) => T): Promise<T> {
  return requestJson(path, { method: "GET" }, parse);
}

function post<T>(
  path: string,
  body: unknown,
  parse: (value: unknown) => T,
): Promise<T> {
  return requestJson(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    parse,
  );
}

export function getChallenge(): Promise<LiveDemoChallenge> {
  return get("/api/challenge", parseChallenge);
}

export function createLiveComparison(
  idempotencyKey: string,
): Promise<LiveDemoExecution> {
  return post(
    "/api/live-comparisons",
    { idempotency_key: requireIdempotencyKey(idempotencyKey) },
    parseLiveExecution,
  );
}

export function runComparison(
  executionId: string,
): Promise<LiveDemoExecution> {
  const expectedExecutionId = requireExecutionId(executionId);
  return post(
    `/api/live-comparisons/${expectedExecutionId}/run`,
    {},
    (value) => parseExpectedLiveExecution(value, expectedExecutionId),
  );
}

export function getCurrentExecution(): Promise<LiveDemoExecution | null> {
  return get("/api/live-comparisons/current", parseCurrentExecution);
}

export function getExecution(
  executionId: string,
): Promise<LiveDemoExecution> {
  const expectedExecutionId = requireExecutionId(executionId);
  return get(
    `/api/live-comparisons/${expectedExecutionId}`,
    (value) => parseExpectedExecution(value, expectedExecutionId),
  );
}

export function getResults(
  executionId: string,
): Promise<HackathonDemoState> {
  const expectedExecutionId = requireExecutionId(executionId);
  return get(
    `/api/live-comparisons/${expectedExecutionId}/results`,
    parseDemoState,
  );
}

export function runJudge(
  executionId: string,
): Promise<HackathonDemoState> {
  const expectedExecutionId = requireExecutionId(executionId);
  return post(
    `/api/live-comparisons/${expectedExecutionId}/judge`,
    {},
    parseDemoState,
  );
}

export function getEvidence(
  executionId: string,
  blindLabel: DemoBlindLabel,
): Promise<LiveDemoEvidence> {
  const expectedExecutionId = requireExecutionId(executionId);
  const expectedBlindLabel = requireBlindLabel(blindLabel);
  return get(
    `/api/live-comparisons/${expectedExecutionId}/evidence/${expectedBlindLabel}`,
    (value) => parseEvidence(value, expectedBlindLabel),
  );
}

export function confirmReviews(
  executionId: string,
  review: ConfirmLiveDemoReviewsInput,
): Promise<HackathonDemoState> {
  const expectedExecutionId = requireExecutionId(executionId);
  return post(
    `/api/live-comparisons/${expectedExecutionId}/reviews`,
    parseReviewInput(review),
    parseDemoState,
  );
}

export function selectCandidate(
  executionId: string,
  selection: SelectLiveDemoCandidateInput,
): Promise<HackathonDemoState> {
  const expectedExecutionId = requireExecutionId(executionId);
  return post(
    `/api/live-comparisons/${expectedExecutionId}/selection`,
    parseSelectionInput(selection),
    parseDemoState,
  );
}

export function createDecisionMemo(
  executionId: string,
): Promise<HackathonDemoState> {
  const expectedExecutionId = requireExecutionId(executionId);
  return post(
    `/api/live-comparisons/${expectedExecutionId}/memo`,
    {},
    parseDemoState,
  );
}

export function replayRegression(
  executionId: string,
): Promise<HackathonDemoState> {
  const expectedExecutionId = requireExecutionId(executionId);
  return post(
    `/api/live-comparisons/${expectedExecutionId}/regression`,
    {},
    parseDemoState,
  );
}

export function selectRecordedFallback(): Promise<RecordedDemoSelection> {
  return post("/api/recorded-demo/select", {}, parseRecordedSelection);
}

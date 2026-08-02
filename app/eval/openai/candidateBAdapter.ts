import type OpenAI from "openai";
import type { CandidateExecutionEvidence } from "../contracts/executionEvidence";
import {
  PolicyRetrievalError,
  searchPolicyVectorStore,
  type PolicyFileManifestEntry,
  type PolicyVectorStoreClientLike,
} from "../retrieval/policyVectorStore";
import {
  CandidateInvocationError,
  DEFAULT_CANDIDATE_TIMEOUT_MS,
  throwIfAborted,
  type CandidateAdapter,
} from "../runner/types";
import { emitCandidateProgress } from "../runner/progress";
import {
  buildCandidateResponseRequest,
  getOpenAIRequestErrorDetails,
  mapOpenAIResponse,
  type OpenAIResponseShape,
  type OpenAIResponsesClientLike,
} from "./responseMapping";

export interface CandidateBClientLike
  extends OpenAIResponsesClientLike, PolicyVectorStoreClientLike {}

type AssertAssignable<T extends true> = T;
type _InstalledOpenAIClientIsCandidateBCompatible = AssertAssignable<
  OpenAI extends CandidateBClientLike ? true : false
>;

interface CandidateBAdapterOptions {
  vectorStoreId: string;
  query: string;
  maxNumResults: 2;
  manifest: readonly PolicyFileManifestEntry[];
  now?: () => number;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${label}은(는) 비어 있지 않아야 합니다.`);
  }
}

interface AuthorizedTicketMessage {
  role: "customer";
  content: string;
}

interface AuthorizedCalibrationCase {
  case_id: string;
  dataset_split: "PUBLIC_CALIBRATION";
  case_family: "ORDER_CANCELLATION_AFTER_SHIPMENT";
  as_of: string;
  locale: "en-US";
  authenticated_customer_id: string;
  order_id: string;
  order_context_authorized: true;
  ticket_messages: AuthorizedTicketMessage[];
}

interface AuthorizedOrderSnapshot {
  order_id: string;
  customer_id: string;
  status: "SHIPPED";
  fulfillment_locked: boolean;
  placed_at: string;
  shipped_at: string;
  delivered_at: string | null;
  promised_delivery_date: string;
  total_amount: number;
  currency: string;
}

interface AuthorizedCandidateBInput {
  case: AuthorizedCalibrationCase;
  authorized_order_snapshot: AuthorizedOrderSnapshot;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label}는 JSON 객체여야 합니다.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label}의 필드가 잠긴 스키마와 일치하지 않습니다.`);
  }
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label}은(는) 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value;
}

function readLiteral<T extends string | boolean>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) {
    throw new TypeError(`${label}은(는) ${String(expected)}이어야 합니다.`);
  }
  return expected;
}

function readIsoTimestamp(value: unknown, label: string): string {
  const timestamp = readNonEmptyString(value, label);
  const match = timestamp.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/,
  );
  const normalized = match
    ? `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`
    : null;
  if (
    normalized === null
    || !Number.isFinite(Date.parse(timestamp))
    || new Date(timestamp).toISOString() !== normalized
  ) {
    throw new TypeError(`${label}은(는) 정규화된 ISO 8601 UTC 시각이어야 합니다.`);
  }
  return timestamp;
}

function readNullableIsoTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : readIsoTimestamp(value, label);
}

function readDate(value: unknown, label: string): string {
  const date = readNonEmptyString(value, label);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new TypeError(`${label}은(는) YYYY-MM-DD 날짜여야 합니다.`);
  }
  return date;
}

function parseAuthorizedInput(input: string): AuthorizedCandidateBInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch (error) {
    throw new TypeError("Candidate B input은 잠긴 JSON 객체여야 합니다.", { cause: error });
  }
  const record = readRecord(parsed, "Candidate B input");
  const keys = Object.keys(record).sort();
  const expectedKeys = ["authorized_order_snapshot", "case"];
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(
      "Candidate B input에는 case와 authorized_order_snapshot만 허용합니다.",
    );
  }
  const caseRecord = readRecord(record.case, "Candidate B input.case");
  assertExactKeys(caseRecord, [
    "case_id",
    "dataset_split",
    "case_family",
    "as_of",
    "locale",
    "authenticated_customer_id",
    "order_id",
    "order_context_authorized",
    "ticket_messages",
  ], "Candidate B input.case");
  if (!Array.isArray(caseRecord.ticket_messages) || caseRecord.ticket_messages.length === 0) {
    throw new TypeError("Candidate B input.case.ticket_messages는 비어 있지 않은 배열이어야 합니다.");
  }
  const ticketMessages = caseRecord.ticket_messages.map((message, index): AuthorizedTicketMessage => {
    const messageRecord = readRecord(message, `ticket_messages[${index}]`);
    assertExactKeys(messageRecord, ["role", "content"], `ticket_messages[${index}]`);
    return {
      role: readLiteral(messageRecord.role, "customer", `ticket_messages[${index}].role`),
      content: readNonEmptyString(messageRecord.content, `ticket_messages[${index}].content`),
    };
  });

  const orderRecord = readRecord(
    record.authorized_order_snapshot,
    "Candidate B input.authorized_order_snapshot",
  );
  assertExactKeys(orderRecord, [
    "order_id",
    "customer_id",
    "status",
    "fulfillment_locked",
    "placed_at",
    "shipped_at",
    "delivered_at",
    "promised_delivery_date",
    "total_amount",
    "currency",
  ], "Candidate B input.authorized_order_snapshot");

  const authorizedCase: AuthorizedCalibrationCase = {
    case_id: readNonEmptyString(caseRecord.case_id, "case.case_id"),
    dataset_split: readLiteral(caseRecord.dataset_split, "PUBLIC_CALIBRATION", "case.dataset_split"),
    case_family: readLiteral(
      caseRecord.case_family,
      "ORDER_CANCELLATION_AFTER_SHIPMENT",
      "case.case_family",
    ),
    as_of: readIsoTimestamp(caseRecord.as_of, "case.as_of"),
    locale: readLiteral(caseRecord.locale, "en-US", "case.locale"),
    authenticated_customer_id: readNonEmptyString(
      caseRecord.authenticated_customer_id,
      "case.authenticated_customer_id",
    ),
    order_id: readNonEmptyString(caseRecord.order_id, "case.order_id"),
    order_context_authorized: readLiteral(
      caseRecord.order_context_authorized,
      true,
      "case.order_context_authorized",
    ),
    ticket_messages: ticketMessages,
  };
  if (typeof orderRecord.fulfillment_locked !== "boolean") {
    throw new TypeError("authorized_order_snapshot.fulfillment_locked는 boolean이어야 합니다.");
  }
  if (
    typeof orderRecord.total_amount !== "number"
    || !Number.isFinite(orderRecord.total_amount)
    || orderRecord.total_amount < 0
  ) {
    throw new TypeError("authorized_order_snapshot.total_amount는 0 이상의 유한한 숫자여야 합니다.");
  }
  const currency = readNonEmptyString(orderRecord.currency, "authorized_order_snapshot.currency");
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError("authorized_order_snapshot.currency는 대문자 3자리 통화 코드여야 합니다.");
  }
  const authorizedOrder: AuthorizedOrderSnapshot = {
    order_id: readNonEmptyString(orderRecord.order_id, "authorized_order_snapshot.order_id"),
    customer_id: readNonEmptyString(orderRecord.customer_id, "authorized_order_snapshot.customer_id"),
    status: readLiteral(orderRecord.status, "SHIPPED", "authorized_order_snapshot.status"),
    fulfillment_locked: orderRecord.fulfillment_locked,
    placed_at: readIsoTimestamp(orderRecord.placed_at, "authorized_order_snapshot.placed_at"),
    shipped_at: readIsoTimestamp(orderRecord.shipped_at, "authorized_order_snapshot.shipped_at"),
    delivered_at: readNullableIsoTimestamp(
      orderRecord.delivered_at,
      "authorized_order_snapshot.delivered_at",
    ),
    promised_delivery_date: readDate(
      orderRecord.promised_delivery_date,
      "authorized_order_snapshot.promised_delivery_date",
    ),
    total_amount: orderRecord.total_amount,
    currency,
  };
  if (authorizedCase.order_id !== authorizedOrder.order_id) {
    throw new TypeError("case.order_id와 authorized_order_snapshot.order_id가 일치해야 합니다.");
  }
  if (authorizedCase.authenticated_customer_id !== authorizedOrder.customer_id) {
    throw new TypeError(
      "case.authenticated_customer_id와 authorized_order_snapshot.customer_id가 일치해야 합니다.",
    );
  }

  return {
    case: authorizedCase,
    authorized_order_snapshot: authorizedOrder,
  };
}

function buildRetrievedInput(
  authorizedInput: AuthorizedCandidateBInput,
  retrieval: CandidateExecutionEvidence["retrievalCalls"][number],
): string {
  const retrievedPolicies = retrieval.results.map((result) => ({
    rank: result.rank,
    score: result.score,
    source_id: result.sourceId,
    section_id: result.sectionId,
    fact_id: result.factId,
    file_id: result.fileId,
    filename: result.filename,
    text: result.text,
  }));
  return [
    "AUTHORIZED CASE AND ORDER SNAPSHOT:",
    JSON.stringify(authorizedInput),
    "",
    "RUNNER-RETRIEVED POLICY EVIDENCE:",
    JSON.stringify({
      requested_query: retrieval.requestedQuery,
      reported_query: retrieval.reportedQuery,
      policies: retrievedPolicies,
    }),
  ].join("\n");
}

export function createCandidateBAdapter(
  client: CandidateBClientLike,
  {
    vectorStoreId,
    query,
    maxNumResults,
    manifest,
    now = Date.now,
  }: CandidateBAdapterOptions,
): CandidateAdapter {
  assertNonEmpty(vectorStoreId, "vectorStoreId");
  assertNonEmpty(query, "query");
  if (maxNumResults !== 2) {
    throw new TypeError("Candidate B calibration의 maxNumResults는 2로 잠겨 있습니다.");
  }
  if (manifest.length === 0) {
    throw new TypeError("Candidate B에는 비어 있지 않은 정책 manifest가 필요합니다.");
  }
  const lockedManifest = structuredClone(manifest) as PolicyFileManifestEntry[];

  return {
    async invoke(invocation, context) {
      throwIfAborted(context?.signal);
      const timeoutMs = context?.timeoutMs
        ?? invocation.limits?.timeoutMs
        ?? DEFAULT_CANDIDATE_TIMEOUT_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new CandidateInvocationError(
          "Candidate B timeoutMs는 0보다 큰 유한한 숫자여야 합니다.",
          false,
          { usage: null },
        );
      }
      let authorizedInput: AuthorizedCandidateBInput;
      try {
        authorizedInput = parseAuthorizedInput(invocation.input);
      } catch (error) {
        throw new CandidateInvocationError(
          error instanceof Error ? error.message : "Candidate B 입력 계약 오류",
          false,
          { cause: error, usage: null },
        );
      }

      let retrieval;
      await emitCandidateProgress(context?.onProgress, {
        kind: "CANDIDATE_B_RETRIEVAL_STARTED",
        candidateId: invocation.candidateId,
      });
      try {
        retrieval = await searchPolicyVectorStore(client, {
          vectorStoreId,
          query,
          maxNumResults,
          manifest: lockedManifest,
          timeoutMs,
          now,
          ...(context?.signal ? { signal: context.signal } : {}),
        });
        throwIfAborted(context?.signal);
      } catch (error) {
        throwIfAborted(context?.signal);
        if (error instanceof PolicyRetrievalError) {
          const executionEvidence: CandidateExecutionEvidence = {
            providerCalls: [],
            retrievalCalls: [structuredClone(error.evidence)],
            toolCalls: [],
          };
          await emitCandidateProgress(context?.onProgress, {
            kind: "CANDIDATE_B_RETRIEVAL_FINISHED",
            candidateId: invocation.candidateId,
            outcome: "FAILED",
          }, {
            executionEvidence,
            usage: null,
          });
          throw new CandidateInvocationError(error.message, error.retryable, {
            cause: error,
            kind: error.evidence.status === "TIMEOUT" ? "TIMEOUT" : "OTHER",
            executionEvidence,
            usage: null,
          });
        }
        await emitCandidateProgress(context?.onProgress, {
          kind: "CANDIDATE_B_RETRIEVAL_FINISHED",
          candidateId: invocation.candidateId,
          outcome: "FAILED",
        });
        throw new CandidateInvocationError(
          error instanceof Error ? error.message : "정책 검색 계약 오류",
          false,
          { cause: error, usage: null },
        );
      }
      await emitCandidateProgress(context?.onProgress, {
        kind: "CANDIDATE_B_RETRIEVAL_FINISHED",
        candidateId: invocation.candidateId,
        outcome: "COMPLETE",
      }, {
        executionEvidence: {
          providerCalls: [],
          retrievalCalls: [structuredClone(retrieval)],
          toolCalls: [],
        },
        usage: null,
      });

      const remainingTimeoutMs = Math.floor(timeoutMs - retrieval.latencyMs);
      if (remainingTimeoutMs <= 0) {
        const timeoutLabel = timeoutMs % 1_000 === 0
          ? `${timeoutMs / 1_000}초`
          : `${timeoutMs}ms`;
        throw new CandidateInvocationError(
          `Candidate B 전체 제한시간 ${timeoutLabel}를 정책 검색에서 모두 소진했습니다.`,
          true,
          {
            kind: "TIMEOUT",
            usage: null,
            executionEvidence: {
              providerCalls: [],
              retrievalCalls: [structuredClone(retrieval)],
              toolCalls: [],
            },
          },
        );
      }

      await emitCandidateProgress(context?.onProgress, {
        kind: "CANDIDATE_B_RESPONSE_STARTED",
        candidateId: invocation.candidateId,
      });
      const responseStartedAtMs = now();
      let response: OpenAIResponseShape;
      try {
        response = await client.responses.create(
          buildCandidateResponseRequest(
            invocation,
            buildRetrievedInput(authorizedInput, retrieval),
          ),
          {
            timeout: remainingTimeoutMs,
            maxRetries: 0,
            ...(context?.signal ? { signal: context.signal } : {}),
          },
        ) as OpenAIResponseShape;
        throwIfAborted(context?.signal);
      } catch (error) {
        throwIfAborted(context?.signal);
        const responseFailedAtMs = now();
        const details = getOpenAIRequestErrorDetails(error);
        const providerLatencyMs = Math.max(
          responseFailedAtMs - responseStartedAtMs,
          0,
        );
        const executionEvidence: CandidateExecutionEvidence = {
          providerCalls: [{
            callNumber: 1,
            responseId: null,
            status: "failed",
            modelRequestedId: invocation.modelRequestedId,
            modelReportedId: null,
            serviceTierRequested: invocation.serviceTierRequested,
            serviceTierReported: null,
            latencyMs: providerLatencyMs,
            usage: null,
            error: details.message,
          }],
          retrievalCalls: [structuredClone(retrieval)],
          toolCalls: [],
        };
        await emitCandidateProgress(context?.onProgress, {
          kind: "CANDIDATE_B_RESPONSE_FINISHED",
          candidateId: invocation.candidateId,
          outcome: "FAILED",
        }, {
          executionEvidence,
          usage: null,
        });
        throw new CandidateInvocationError(details.message, details.retryable, {
          cause: error,
          kind: details.kind,
          executionEvidence,
          usage: null,
        });
      }
      const responseFinishedAtMs = now();
      const mapped = mapOpenAIResponse(
        response,
        invocation,
        Math.max(responseFinishedAtMs - responseStartedAtMs, 0),
      );
      const executionEvidence: CandidateExecutionEvidence = {
        providerCalls: [mapped.providerCall],
        retrievalCalls: [structuredClone(retrieval)],
        toolCalls: [],
      };
      await emitCandidateProgress(context?.onProgress, {
        kind: "CANDIDATE_B_RESPONSE_FINISHED",
        candidateId: invocation.candidateId,
        outcome: mapped.status === "completed" ? "COMPLETE" : "FAILED",
      }, {
        executionEvidence,
        usage: mapped.usage,
      });
      return {
        responseId: mapped.responseId,
        status: mapped.status,
        modelReportedId: mapped.modelReportedId,
        serviceTierReported: mapped.serviceTierReported,
        outputText: mapped.outputText,
        usage: mapped.usage,
        executionEvidence,
        ...(mapped.error ? { error: mapped.error } : {}),
      };
    },
  };
}

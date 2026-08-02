// @vitest-environment node

import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FinalDecisionMemoOpenAIError,
  type FinalDecisionMemoOpenAIErrorKind,
  type FinalDecisionMemoProviderEvidence,
} from "../../eval/decision/openaiFinalDecisionMemoAdapter";
import type {
  FinalDecisionMemoAttemptEvidence,
} from "../../eval/decision/decisionBaseline";
import {
  calculateUsageCost,
  type TokenUsage,
} from "../../eval/runtime/pricing";
import {
  FINAL_DECISION_MEMO_PRICING_SNAPSHOT,
} from "../../eval/decision/decisionBaseline";
import {
  FileMutationJournal,
  ReplayedMutationFailureError,
} from "../artifactRepository";
import {
  buildMutationFailureEvidence,
  validateStoredMutationFailureEvidence,
} from "../mutationFailureEvidence";
import type { ChallengeMutationCommand } from "../challengeServer";

const SOURCE_HASH = "a".repeat(64);

function command(
  key = "mutation_final_memo_failure_001",
): ChallengeMutationCommand {
  return Object.freeze({
    schema_version: "decision-memo-command-v1",
    expected_source_hash: SOURCE_HASH,
    idempotency_key: key,
    target_id: "decision_1",
  });
}

async function secureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mutation-failure-evidence-"));
  await chmod(root, 0o700);
  return await realpath(root);
}

const USAGE: TokenUsage = Object.freeze({
  inputTokens: 1_000,
  cachedInputTokens: 100,
  cacheWriteTokens: 0,
  outputTokens: 200,
  reasoningTokens: 25,
  totalTokens: 1_200,
});

function responseAttempt(
  status: FinalDecisionMemoAttemptEvidence["status"],
  overrides: Partial<FinalDecisionMemoAttemptEvidence> = {},
): FinalDecisionMemoAttemptEvidence {
  return Object.freeze({
    attempt_number: 1,
    request_disposition: "RESPONSE_RECEIVED",
    status,
    retry_eligible: false,
    response_id: "resp_failure_001",
    refusal: status === "REFUSED" ? "sensitive refusal detail" : null,
    incomplete_reason: status === "INCOMPLETE" ? "max_output_tokens" : null,
    error: status === "INVALID_OUTPUT" ? "schema included sk-secret-value" : null,
    latency_ms: 17,
    usage: USAGE,
    usage_cost: calculateUsageCost(
      USAGE,
      FINAL_DECISION_MEMO_PRICING_SNAPSHOT,
    ),
    ...overrides,
  });
}

function provider(
  overrides: Partial<FinalDecisionMemoProviderEvidence> = {},
): FinalDecisionMemoProviderEvidence {
  return Object.freeze({
    response_id: "resp_failure_001",
    response_status: "incomplete",
    model_reported_id: "gpt-5.6-sol",
    service_tier_reported: "default",
    refusal_detected: false,
    refusal: null,
    incomplete_reason: "max_output_tokens",
    response_error: null,
    output_text: null,
    usage_raw: null,
    ...overrides,
  });
}

function memoFailure({
  kind,
  attempts,
  providerEvidence,
  httpStatus,
}: {
  readonly kind: FinalDecisionMemoOpenAIErrorKind;
  readonly attempts: readonly FinalDecisionMemoAttemptEvidence[];
  readonly providerEvidence: FinalDecisionMemoProviderEvidence | null;
  readonly httpStatus?: number;
}): FinalDecisionMemoOpenAIError {
  const cause = httpStatus === undefined
    ? undefined
    : Object.assign(new Error("provider secret body sk-never-store-this"), {
      status: httpStatus,
      headers: { authorization: "Bearer sk-never-store-this" },
    });
  return new FinalDecisionMemoOpenAIError(
    "raw failure message sk-never-store-this",
    {
      kind,
      attempts,
      providerEvidence,
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

describe("Final Decision Memo mutation 실패 증거", () => {
  it.each([
    {
      label: "429",
      error: memoFailure({
        kind: "REQUEST_ERROR",
        attempts: [
          responseAttempt("REQUEST_ERROR", {
            request_disposition: "RESPONSE_ERROR_RECEIVED",
            response_id: null,
            usage: null,
            usage_cost: null,
            retry_eligible: true,
          }),
          responseAttempt("REQUEST_ERROR", {
            attempt_number: 2,
            request_disposition: "RESPONSE_ERROR_RECEIVED",
            response_id: null,
            usage: null,
            usage_cost: null,
          }),
        ],
        providerEvidence: null,
        httpStatus: 429,
      }),
      classification: "PROVIDER_TEMPORARY_FAILURE",
      costCompleteness: "INCOMPLETE",
      providerHttpStatus: 429,
    },
    {
      label: "5xx",
      error: memoFailure({
        kind: "REQUEST_ERROR",
        attempts: [
          responseAttempt("REQUEST_ERROR", {
            request_disposition: "RESPONSE_ERROR_RECEIVED",
            response_id: null,
            usage: null,
            usage_cost: null,
            retry_eligible: true,
          }),
          responseAttempt("REQUEST_ERROR", {
            attempt_number: 2,
            request_disposition: "RESPONSE_ERROR_RECEIVED",
            response_id: null,
            usage: null,
            usage_cost: null,
          }),
        ],
        providerEvidence: null,
        httpStatus: 503,
      }),
      classification: "PROVIDER_TEMPORARY_FAILURE",
      costCompleteness: "INCOMPLETE",
      providerHttpStatus: 503,
    },
    {
      label: "timeout",
      error: memoFailure({
        kind: "REQUEST_ERROR",
        attempts: [
          responseAttempt("TIMEOUT", {
            request_disposition: "SENT_OUTCOME_UNKNOWN",
            response_id: null,
            usage: null,
            usage_cost: null,
          }),
        ],
        providerEvidence: null,
      }),
      classification: "PROVIDER_TEMPORARY_FAILURE",
      costCompleteness: "INCOMPLETE",
      providerHttpStatus: null,
    },
    {
      label: "refusal",
      error: memoFailure({
        kind: "TERMINAL_RESPONSE",
        attempts: [responseAttempt("REFUSED")],
        providerEvidence: provider({
          response_status: "completed",
          refusal_detected: true,
          refusal: "provider refusal sk-never-store-this",
          incomplete_reason: null,
        }),
      }),
      classification: "PROVIDER_TERMINAL_FAILURE",
      costCompleteness: "COMPLETE",
      providerHttpStatus: null,
    },
    {
      label: "incomplete",
      error: memoFailure({
        kind: "TERMINAL_RESPONSE",
        attempts: [responseAttempt("INCOMPLETE")],
        providerEvidence: provider(),
      }),
      classification: "EVALUATION_INCOMPLETE",
      costCompleteness: "COMPLETE",
      providerHttpStatus: null,
    },
    {
      label: "invalid-output",
      error: memoFailure({
        kind: "RETRIES_EXHAUSTED",
        attempts: [
          responseAttempt("INVALID_OUTPUT", { retry_eligible: true }),
          responseAttempt("INVALID_OUTPUT", {
            attempt_number: 2,
            response_id: "resp_failure_002",
          }),
        ],
        providerEvidence: provider({
          response_id: "resp_failure_002",
          response_status: "completed",
          incomplete_reason: null,
        }),
      }),
      classification: "EVALUATION_INCOMPLETE",
      costCompleteness: "COMPLETE",
      providerHttpStatus: null,
    },
  ])(
    "$label 실패는 메시지 없이 제한된 분류·계측·비용 완전성만 보존한다",
    ({
      error,
      classification,
      costCompleteness,
      providerHttpStatus,
    }) => {
      const evidence = buildMutationFailureEvidence(error);

      expect(evidence).not.toBeNull();
      expect(evidence).toMatchObject({
        error_code: "FINAL_DECISION_MEMO_OPENAI_ERROR",
        evaluation_status: "EVALUATION_INCOMPLETE",
        kind: error.kind,
        classification,
        provider_response: {
          http_status: providerHttpStatus,
        },
        cost_completeness: {
          status: costCompleteness,
        },
      });
      expect(evidence?.attempts).toHaveLength(error.attempts.length);
      expect(evidence?.attempts[0]).toMatchObject({
        attempt_number: 1,
        request_disposition: error.attempts[0].request_disposition,
        status: error.attempts[0].status,
        retry_eligible: error.attempts[0].retry_eligible,
        latency_ms: error.attempts[0].latency_ms,
        usage: error.attempts[0].usage,
        usage_cost: error.attempts[0].usage_cost,
      });
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toMatch(/sk-never-store-this|sensitive refusal detail/i);
      expect(serialized).not.toContain("authorization");
      expect(serialized).not.toContain("raw failure message");
    },
  );

  it("typed OpenAI 실패만 content-addressed 0600 write-once 실패 receipt로 저장하고 replay에 원 분류를 보존한다", async () => {
    const root = await secureRoot();
    const journal = new FileMutationJournal(root);
    const error = memoFailure({
      kind: "TERMINAL_RESPONSE",
      attempts: [responseAttempt("REFUSED")],
      providerEvidence: provider({
        response_status: "completed",
        refusal_detected: true,
        refusal: "secret refusal sk-never-store-this",
        incomplete_reason: null,
      }),
    });

    await expect(journal.execute(command(), async () => {
      throw error;
    })).rejects.toBe(error);

    const paths = journal.pathsFor(command());
    const files = await readdir(paths.mutationDirectory);
    const failureFiles = files.filter((name) => (
      /^mutation--failure-receipt--[a-f0-9]{64}\.json$/.test(name)
    ));
    expect(failureFiles).toHaveLength(1);
    const failurePath = join(paths.mutationDirectory, failureFiles[0]);
    const stat = await lstat(failurePath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.nlink).toBe(1);

    const stored = JSON.parse(await readFile(failurePath, "utf8"));
    expect(stored.payload_sha256).toBe(
      failureFiles[0].match(/[a-f0-9]{64}/)?.[0],
    );
    expect(stored.payload).toMatchObject({
      schema_version: "api-mutation-failure-receipt-v1",
      artifact_kind: "API_MUTATION_FAILURE_RECEIPT",
      idempotency_key: command().idempotency_key,
      classification: "PROVIDER_TERMINAL_FAILURE",
      error_code: "FINAL_DECISION_MEMO_OPENAI_ERROR",
      evaluation_status: "EVALUATION_INCOMPLETE",
    });
    expect(JSON.stringify(stored)).not.toMatch(
      /sk-never-store-this|secret refusal|raw failure message/i,
    );

    const replay = await new FileMutationJournal(root)
      .execute(command(), async () => ({
        accepted: true as const,
        source_hash: SOURCE_HASH,
      }))
      .catch((caught: unknown) => caught);
    expect(replay).toBeInstanceOf(ReplayedMutationFailureError);
    expect(replay).toMatchObject({
      code: "MUTATION_FAILURE_REPLAYED",
      classification: "PROVIDER_TERMINAL_FAILURE",
      allowSideEffect: false,
    });
  });

  it.each([
    {
      label: "TERMINAL_RESPONSE plus COMPLETE",
      error: memoFailure({
        kind: "TERMINAL_RESPONSE",
        attempts: [responseAttempt("COMPLETE")],
        providerEvidence: provider({
          response_status: "completed",
          incomplete_reason: null,
        }),
      }),
    },
    {
      label: "RETRIES_EXHAUSTED plus COMPLETE",
      error: memoFailure({
        kind: "RETRIES_EXHAUSTED",
        attempts: [
          responseAttempt("INVALID_OUTPUT", { retry_eligible: true }),
          responseAttempt("COMPLETE", { attempt_number: 2 }),
        ],
        providerEvidence: provider({
          response_status: "completed",
          incomplete_reason: null,
        }),
      }),
    },
    {
      label: "REFUSED without provider flag",
      error: memoFailure({
        kind: "TERMINAL_RESPONSE",
        attempts: [responseAttempt("REFUSED")],
        providerEvidence: provider({
          refusal_detected: false,
          refusal: null,
          incomplete_reason: null,
        }),
      }),
    },
    {
      label: "INCOMPLETE without provider detail",
      error: memoFailure({
        kind: "TERMINAL_RESPONSE",
        attempts: [responseAttempt("INCOMPLETE")],
        providerEvidence: provider({
          response_status: "incomplete",
          incomplete_reason: null,
        }),
      }),
    },
    {
      label: "retryable 429 stopped before required second attempt",
      error: memoFailure({
        kind: "REQUEST_ERROR",
        attempts: [
          responseAttempt("REQUEST_ERROR", {
            request_disposition: "RESPONSE_ERROR_RECEIVED",
            response_id: null,
            usage: null,
            usage_cost: null,
            retry_eligible: false,
          }),
        ],
        providerEvidence: null,
        httpStatus: 429,
      }),
    },
    {
      label: "fractional latency",
      error: memoFailure({
        kind: "TERMINAL_RESPONSE",
        attempts: [
          responseAttempt("REFUSED", {
            latency_ms: 0.25,
          }),
        ],
        providerEvidence: provider({
          refusal_detected: true,
          refusal: "refusal",
          incomplete_reason: null,
        }),
      }),
    },
  ])(
    "인과적으로 불가능한 typed class 조합 $label은 상세 증거로 승격하지 않는다",
    ({ error }) => {
      expect(buildMutationFailureEvidence(error)).toBeNull();
    },
  );

  it("임의 Error와 code/message spoof는 상세 실패 receipt에 기록하지 않는다", async () => {
    const root = await secureRoot();
    const journal = new FileMutationJournal(root);
    const arbitrary = Object.assign(
      new Error("sk-arbitrary-secret provider body"),
      {
        code: "FINAL_DECISION_MEMO_OPENAI_ERROR",
        kind: "TERMINAL_RESPONSE",
        api_key: "sk-arbitrary-secret",
      },
    );

    await expect(journal.execute(command("mutation_spoofed_error"), async () => {
      throw arbitrary;
    })).rejects.toBe(arbitrary);

    const paths = journal.pathsFor(command("mutation_spoofed_error"));
    const files = await readdir(paths.mutationDirectory);
    expect(files.some((name) => name.includes("failure-receipt--"))).toBe(false);
    const stored = await readFile(paths.receiptPath, "utf8");
    expect(stored).not.toContain("sk-arbitrary-secret");
    expect(stored).not.toContain("FINAL_DECISION_MEMO_OPENAI_ERROR");
  });

  it("credential 형태가 섞인 provider response id/status는 상세 증거에 복사하지 않는다", () => {
    const error = memoFailure({
      kind: "TERMINAL_RESPONSE",
      attempts: [
        responseAttempt("REFUSED", {
          response_id: "resp_sk-never-store-this",
        }),
      ],
      providerEvidence: provider({
        response_id: "resp_sk-never-store-this",
        response_status: "sk-never-store-this",
        refusal_detected: true,
        refusal: "refusal",
        incomplete_reason: null,
      }),
    });

    const evidence = buildMutationFailureEvidence(error);
    expect(evidence).not.toBeNull();
    expect(evidence?.attempts[0].response_id).toBeNull();
    expect(evidence?.provider_response).toMatchObject({
      response_id: null,
      response_status: null,
    });
    expect(JSON.stringify(evidence)).not.toContain("sk-never-store-this");
  });

  it("정제 뒤 모든 provider 식별 필드가 null이어도 evidence 존재 여부를 보존해 replay validator와 자기 일관적이다", () => {
    const error = memoFailure({
      kind: "TERMINAL_RESPONSE",
      attempts: [
        responseAttempt("FAILED", {
          response_id: "resp_sk-never-store-this",
        }),
      ],
      providerEvidence: provider({
        response_id: "resp_sk-never-store-this",
        response_status: "sk-never-store-this",
        refusal_detected: false,
        refusal: null,
        incomplete_reason: null,
      }),
    });

    const evidence = buildMutationFailureEvidence(error);
    expect(evidence).not.toBeNull();
    expect(evidence?.provider_response).toMatchObject({
      evidence_present: true,
      response_id: null,
      response_status: null,
    });
    expect(validateStoredMutationFailureEvidence(evidence)).toEqual(evidence);
  });
});

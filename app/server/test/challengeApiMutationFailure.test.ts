// @vitest-environment node

import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FinalDecisionMemoOpenAIError,
  type FinalDecisionMemoOpenAIErrorKind,
  type FinalDecisionMemoProviderEvidence,
} from "../../eval/decision/openaiFinalDecisionMemoAdapter";
import type {
  FinalDecisionMemoAttemptEvidence,
} from "../../eval/decision/decisionBaseline";
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
} from "../../eval/runtime/canonicalJson";
import {
  FileMutationJournal,
} from "../artifactRepository";
import {
  createChallengeApiHandler,
  type ChallengeApiGateway,
} from "../challengeServer";

const SOURCE_HASH = "a".repeat(64);

async function secureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "challenge-api-failure-"));
  await chmod(root, 0o700);
  return await realpath(root);
}

function attempt(
  status: FinalDecisionMemoAttemptEvidence["status"],
  overrides: Partial<FinalDecisionMemoAttemptEvidence> = {},
): FinalDecisionMemoAttemptEvidence {
  return Object.freeze({
    attempt_number: 1,
    request_disposition: "RESPONSE_RECEIVED",
    status,
    retry_eligible: false,
    response_id: "resp_http_failure_001",
    refusal: status === "REFUSED" ? "private refusal body" : null,
    incomplete_reason: status === "INCOMPLETE" ? "max_output_tokens" : null,
    error: status === "INVALID_OUTPUT" ? "private invalid output" : null,
    latency_ms: 21,
    usage: null,
    usage_cost: null,
    ...overrides,
  });
}

function provider(
  overrides: Partial<FinalDecisionMemoProviderEvidence> = {},
): FinalDecisionMemoProviderEvidence {
  return Object.freeze({
    response_id: "resp_http_failure_001",
    response_status: "completed",
    model_reported_id: "gpt-5.6-sol",
    service_tier_reported: "default",
    refusal_detected: false,
    refusal: null,
    incomplete_reason: null,
    response_error: null,
    output_text: null,
    usage_raw: null,
    ...overrides,
  });
}

function failure({
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
  return new FinalDecisionMemoOpenAIError("secret provider message", {
    kind,
    attempts,
    providerEvidence,
    ...(httpStatus === undefined
      ? {}
      : {
          cause: Object.assign(new Error("secret response"), {
            status: httpStatus,
          }),
        }),
  });
}

function gatewayFor(error: unknown): ChallengeApiGateway {
  const read = vi.fn(async () => null);
  const unsupported = vi.fn(async () => ({
    accepted: true as const,
    source_hash: SOURCE_HASH,
  }));
  return {
    getWorkspace: vi.fn(async () => ({
      schema_version: "workspace-public-projection-v1",
      synthetic: true,
    })),
    getChallenge: read,
    getEvidence: read,
    getBenchmarkProgress: read,
    getBlindReview: read,
    getDecision: read,
    getBaseline: read,
    getRegression: read,
    structureDefine: unsupported,
    lockChallenge: unsupported,
    startBenchmark: unsupported,
    confirmReview: unsupported,
    createDecisionMemo: vi.fn(async () => {
      throw error;
    }),
    confirmDecision: unsupported,
    startRegression: unsupported,
  };
}

function request(idempotencyKey: string): Request {
  return new Request(
    "http://127.0.0.1/api/decisions/decision_1/memo",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "decision-memo-command-v1",
        expected_source_hash: SOURCE_HASH,
        idempotency_key: idempotencyKey,
      }),
    },
  );
}

async function responseBody(
  response: Response,
): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function wrapped(payload: unknown): string {
  return `${canonicalJsonStringify({
    payload_sha256: sha256CanonicalJson(payload),
    payload,
  })}\n`;
}

describe("Challenge API Final Decision Memo 실패 경계", () => {
  it.each([
    {
      label: "429",
      error: failure({
        kind: "REQUEST_ERROR",
        attempts: [
          attempt("REQUEST_ERROR", {
            request_disposition: "RESPONSE_ERROR_RECEIVED",
            response_id: null,
            retry_eligible: true,
          }),
          attempt("REQUEST_ERROR", {
            attempt_number: 2,
            request_disposition: "RESPONSE_ERROR_RECEIVED",
            response_id: null,
          }),
        ],
        providerEvidence: null,
        httpStatus: 429,
      }),
      expectedError: "PROVIDER_TEMPORARY_FAILURE",
      expectedStatus: 503,
    },
    {
      label: "5xx",
      error: failure({
        kind: "REQUEST_ERROR",
        attempts: [
          attempt("REQUEST_ERROR", {
            request_disposition: "RESPONSE_ERROR_RECEIVED",
            response_id: null,
            retry_eligible: true,
          }),
          attempt("REQUEST_ERROR", {
            attempt_number: 2,
            request_disposition: "RESPONSE_ERROR_RECEIVED",
            response_id: null,
          }),
        ],
        providerEvidence: null,
        httpStatus: 500,
      }),
      expectedError: "PROVIDER_TEMPORARY_FAILURE",
      expectedStatus: 503,
    },
    {
      label: "timeout",
      error: failure({
        kind: "REQUEST_ERROR",
        attempts: [
          attempt("TIMEOUT", {
            request_disposition: "SENT_OUTCOME_UNKNOWN",
            response_id: null,
          }),
        ],
        providerEvidence: null,
      }),
      expectedError: "PROVIDER_TEMPORARY_FAILURE",
      expectedStatus: 503,
    },
    {
      label: "refusal",
      error: failure({
        kind: "TERMINAL_RESPONSE",
        attempts: [attempt("REFUSED")],
        providerEvidence: provider({
          refusal_detected: true,
          refusal: "secret refusal",
        }),
      }),
      expectedError: "PROVIDER_TERMINAL_FAILURE",
      expectedStatus: 422,
    },
    {
      label: "incomplete",
      error: failure({
        kind: "TERMINAL_RESPONSE",
        attempts: [attempt("INCOMPLETE")],
        providerEvidence: provider({
          response_status: "incomplete",
          incomplete_reason: "max_output_tokens",
        }),
      }),
      expectedError: "EVALUATION_INCOMPLETE",
      expectedStatus: 422,
    },
    {
      label: "invalid-output",
      error: failure({
        kind: "RETRIES_EXHAUSTED",
        attempts: [
          attempt("INVALID_OUTPUT", { retry_eligible: true }),
          attempt("INVALID_OUTPUT", {
            attempt_number: 2,
            response_id: "resp_http_failure_002",
          }),
        ],
        providerEvidence: provider({
          response_id: "resp_http_failure_002",
        }),
      }),
      expectedError: "EVALUATION_INCOMPLETE",
      expectedStatus: 422,
    },
  ])(
    "$label 실패와 같은 key replay는 제한된 HTTP 분류만 반환한다",
    async ({ label, error, expectedError, expectedStatus }) => {
      const root = await secureRoot();
      const handler = createChallengeApiHandler({
        gateway: gatewayFor(error),
        mutationJournal: new FileMutationJournal(root),
      });
      const idempotencyKey = `mutation_http_${label.replace(/[^a-z0-9]/gi, "_")}`;

      const first = await handler(request(idempotencyKey));
      expect(first.status).toBe(expectedStatus);
      const firstBody = await responseBody(first);
      expect(firstBody).toMatchObject({
        error: expectedError,
        evaluation_status: "EVALUATION_INCOMPLETE",
        retry_allowed: false,
        failure_classification: expectedError,
      });
      expect(firstBody.failure_hash).toMatch(/^[a-f0-9]{64}$/);

      const replay = await handler(request(idempotencyKey));
      expect(replay.status).toBe(409);
      expect(await responseBody(replay)).toEqual({
        error: "REPLAYED_MUTATION",
        retry_allowed: false,
        failure_classification: expectedError,
        failure_hash: firstBody.failure_hash,
      });
    },
  );

  it("임의 Error와 code spoof는 raw message/key 없이 ARTIFACT_INTEGRITY로만 응답한다", async () => {
    const root = await secureRoot();
    const spoof = Object.assign(
      new Error("sk-raw-secret and private provider response"),
      {
        code: "FINAL_DECISION_MEMO_OPENAI_ERROR",
        authorization: "Bearer sk-raw-secret",
      },
    );
    const handler = createChallengeApiHandler({
      gateway: gatewayFor(spoof),
      mutationJournal: new FileMutationJournal(root),
    });

    const response = await handler(request("mutation_http_spoof"));
    expect(response.status).toBe(500);
    expect(await responseBody(response)).toEqual({
      error: "ARTIFACT_INTEGRITY",
    });
    const recordDirectory = join(root, "mutation_http_spoof");
    const serialized = await Promise.all(
      (await readdir(recordDirectory)).map((name) => (
        readFile(join(recordDirectory, name), "utf8")
      )),
    );
    expect(serialized.join("\n")).not.toMatch(
      /sk-raw-secret|private provider response|authorization/i,
    );
  });

  it("내구성 있는 provider 실패와 같은 key replay는 동일한 공개 failure hash만 반환한다", async () => {
    const root = await secureRoot();
    const error = failure({
      kind: "TERMINAL_RESPONSE",
      attempts: [attempt("REFUSED")],
      providerEvidence: provider({
        refusal_detected: true,
        refusal: "private refusal must not cross the HTTP boundary",
      }),
    });
    const handler = createChallengeApiHandler({
      gateway: gatewayFor(error),
      mutationJournal: new FileMutationJournal(root),
    });
    const key = "mutation_http_public_failure_hash";

    const first = await responseBody(await handler(request(key)));
    const replay = await responseBody(await handler(request(key)));

    expect(first).toMatchObject({
      error: "PROVIDER_TERMINAL_FAILURE",
      retry_allowed: false,
      failure_classification: "PROVIDER_TERMINAL_FAILURE",
    });
    expect(first.failure_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(replay).toEqual({
      error: "REPLAYED_MUTATION",
      retry_allowed: false,
      failure_classification: "PROVIDER_TERMINAL_FAILURE",
      failure_hash: first.failure_hash,
    });
    expect(JSON.stringify({ first, replay })).not.toMatch(
      /private refusal|response_id|authorization|api[_-]?key/i,
    );
  });

  it("순수 handler 경계에서도 같은 key 실패 replay는 원 제한 분류와 nonretry를 보존한다", async () => {
    const error = failure({
      kind: "REQUEST_ERROR",
      attempts: [
        attempt("TIMEOUT", {
          request_disposition: "SENT_OUTCOME_UNKNOWN",
          response_id: null,
        }),
      ],
      providerEvidence: null,
    });
    const handler = createChallengeApiHandler({
      gateway: gatewayFor(error),
    });
    const key = "mutation_http_memory_replay";

    expect((await handler(request(key))).status).toBe(503);
    const replay = await handler(request(key));
    expect(replay.status).toBe(409);
    const replayBody = await responseBody(replay);
    expect(replayBody).toMatchObject({
      error: "REPLAYED_MUTATION",
      retry_allowed: false,
      failure_classification: "PROVIDER_TEMPORARY_FAILURE",
    });
    expect(replayBody.failure_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("content-addressed 실패 receipt 손상은 provider 실패나 replay가 아니라 ARTIFACT_INTEGRITY로 응답한다", async () => {
    const root = await secureRoot();
    const error = failure({
      kind: "TERMINAL_RESPONSE",
      attempts: [attempt("REFUSED")],
      providerEvidence: provider({
        refusal_detected: true,
        refusal: "private refusal",
      }),
    });
    const handler = createChallengeApiHandler({
      gateway: gatewayFor(error),
      mutationJournal: new FileMutationJournal(root),
    });
    const key = "mutation_http_corrupt";
    expect((await handler(request(key))).status).toBe(422);

    const directory = join(root, key);
    const failureFile = (await readdir(directory)).find((name) => (
      name.startsWith("mutation--failure-receipt--")
    ));
    expect(failureFile).toBeDefined();
    await writeFile(
      join(directory, failureFile!),
      "{\"payload_sha256\":\"bad\",\"payload\":{}}\n",
      { flag: "w" },
    );

    const replay = await handler(request(key));
    expect(replay.status).toBe(500);
    expect(await responseBody(replay)).toEqual({
      error: "ARTIFACT_INTEGRITY",
    });
  });

  it.each([
    {
      label: "usage-cost mismatch",
      mutate(payload: Record<string, any>) {
        payload.attempts[0].usage_cost = {
          pricingSnapshotId: "forged",
          totalCostUsd: 99_999,
        };
      },
    },
    {
      label: "classification contradicts refusal",
      mutate(payload: Record<string, any>) {
        payload.classification = "EVALUATION_INCOMPLETE";
      },
    },
    {
      label: "provider response id removed",
      mutate(payload: Record<string, any>) {
        payload.provider_response.response_id = null;
      },
    },
  ])(
    "canonical hash를 함께 다시 써도 $label 의미 변조는 ARTIFACT_INTEGRITY다",
    async ({ label, mutate }) => {
      const root = await secureRoot();
      const error = failure({
        kind: "TERMINAL_RESPONSE",
        attempts: [attempt("REFUSED")],
        providerEvidence: provider({
          refusal_detected: true,
          refusal: "private refusal",
        }),
      });
      const handler = createChallengeApiHandler({
        gateway: gatewayFor(error),
        mutationJournal: new FileMutationJournal(root),
      });
      const key = `mutation_http_semantic_${label.replace(/[^a-z0-9]/gi, "_")}`;
      expect((await handler(request(key))).status).toBe(422);

      const directory = join(root, key);
      const oldFailureFile = (await readdir(directory)).find((name) => (
        name.startsWith("mutation--failure-receipt--")
      ));
      expect(oldFailureFile).toBeDefined();
      const oldFailure = JSON.parse(
        await readFile(join(directory, oldFailureFile!), "utf8"),
      ) as { payload: Record<string, any> };
      mutate(oldFailure.payload);
      const newHash = sha256CanonicalJson(oldFailure.payload);
      await writeFile(
        join(directory, `mutation--failure-receipt--${newHash}.json`),
        wrapped(oldFailure.payload),
        { flag: "wx", mode: 0o600 },
      );

      const genericPath = join(directory, "mutation--receipt.json");
      const generic = JSON.parse(await readFile(genericPath, "utf8")) as {
        payload: Record<string, any>;
      };
      generic.payload.failure_receipt_hash = newHash;
      generic.payload.failure_classification =
        oldFailure.payload.classification;
      await writeFile(genericPath, wrapped(generic.payload), { flag: "w" });

      const replay = await handler(request(key));
      expect(replay.status).toBe(500);
      expect(await responseBody(replay)).toEqual({
        error: "ARTIFACT_INTEGRITY",
      });
    },
  );
});

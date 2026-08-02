import OpenAI from "openai";
import {
  base64UrlToBytes,
} from "../server/sites/webCrypto";

export interface Env {
  readonly ASSETS: Fetcher;
  readonly DB: D1Database;
  readonly ARTIFACTS: R2Bucket;
  readonly DEMO_ACCESS_CODE_HASH: string;
  readonly DEMO_SESSION_SECRET: string;
  readonly OPENAI_API_KEY: string;
  readonly DEMO_SESSION_TTL_SECONDS: string;
  readonly DEMO_AUTH_FAILURE_LIMIT: string;
  readonly DEMO_AUTH_FAILURE_WINDOW_MS: string;
  readonly DEMO_AUTH_FAILURE_BLOCK_MS: string;
  readonly DEMO_LEASE_DURATION_MS: string;
  readonly DEMO_RESERVED_COST_MICRO_USD: string;
  readonly DEMO_MAX_SUCCESSFUL_RUNS_PER_SESSION: string;
  readonly DEMO_MAX_OPERATIONAL_RETRIES_PER_SESSION: string;
  readonly DEMO_MAX_GLOBAL_CONCURRENT_RUNS: string;
  readonly DEMO_MAX_BUCKET_RUN_COUNT: string;
  readonly DEMO_MAX_BUCKET_COST_MICRO_USD: string;
  readonly DEMO_MAX_AUXILIARY_CALLS_PER_BUCKET: string;
}

export interface SitesRuntimeConfig {
  readonly repositoryBinding: D1Database;
  readonly artifactBinding: R2Bucket;
  readonly accessCodeHash: string;
  readonly sessionSecret: string;
  readonly openAiApiKey: string;
  readonly sessionTtlSeconds: number;
  readonly authFailureLimit: number;
  readonly authFailureWindowMs: number;
  readonly authFailureBlockMs: number;
  readonly leaseDurationMs: number;
  readonly reservedCostMicroUsd: number;
  readonly maxSuccessfulRunsPerSession: number;
  readonly maxOperationalRetriesPerSession: number;
  readonly maxGlobalConcurrentRuns: number;
  readonly maxBucketRunCount: number;
  readonly maxBucketCostMicroUsd: number;
  readonly maxAuxiliaryCallsPerBucket: number;
}

export interface SitesWorkflowLimits {
  readonly leaseDurationMs: number;
  readonly reservedCostMicroUsd: number;
  readonly maxSuccessfulRunsPerSession: number;
  readonly maxOperationalRetriesPerSession: number;
  readonly maxGlobalConcurrentRuns: number;
  readonly maxBucketRunCount: number;
  readonly maxBucketCostMicroUsd: number;
  readonly maxAuxiliaryCallsPerBucket: number;
}

const ACCESS_HASH_MAX_LENGTH = 512;
const SESSION_SECRET_MIN_BYTES = 32;
const SESSION_SECRET_MAX_BYTES = 1_024;
const API_KEY_MIN_LENGTH = 20;
const API_KEY_MAX_LENGTH = 512;
const POSITIVE_DECIMAL = /^[1-9]\d*$/u;

function invalidConfig(): never {
  throw new TypeError("INVALID_SITES_RUNTIME_CONFIG");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertBindings(value: unknown): asserts value is Env {
  if (!isRecord(value)) invalidConfig();
  const assets = value.ASSETS;
  const db = value.DB;
  const artifacts = value.ARTIFACTS;
  if (
    !isRecord(assets)
    || typeof assets.fetch !== "function"
    || !isRecord(db)
    || typeof db.prepare !== "function"
    || typeof db.batch !== "function"
    || !isRecord(artifacts)
    || typeof artifacts.put !== "function"
    || typeof artifacts.get !== "function"
  ) {
    invalidConfig();
  }
}

function requireBoundedSecret(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): string {
  if (
    typeof value !== "string"
    || value.length < minimumLength
    || value.length > maximumLength
    || /\s|\p{Cc}/u.test(value)
  ) {
    invalidConfig();
  }
  return value;
}

function requireSessionSecret(value: unknown): string {
  if (typeof value !== "string" || /\p{Cc}/u.test(value)) {
    invalidConfig();
  }
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (
    byteLength < SESSION_SECRET_MIN_BYTES
    || byteLength > SESSION_SECRET_MAX_BYTES
  ) {
    invalidConfig();
  }
  return value;
}

function requireAccessCodeHash(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > ACCESS_HASH_MAX_LENGTH
  ) {
    invalidConfig();
  }
  const fields = value.split("$");
  if (fields.length === 2 && fields[0] === "token-sha256") {
    const digest = base64UrlToBytes(fields[1] ?? "");
    if (digest === null || digest.byteLength !== 32) {
      invalidConfig();
    }
    return value;
  }
  if (
    fields.length !== 4
    || fields[0] !== "pbkdf2-sha256"
    || !/^[1-9]\d{5,6}$/u.test(fields[1] ?? "")
  ) {
    invalidConfig();
  }
  const iterations = Number(fields[1]);
  const salt = base64UrlToBytes(fields[2] ?? "");
  const digest = base64UrlToBytes(fields[3] ?? "");
  if (
    !Number.isSafeInteger(iterations)
    || iterations < 100_000
    || iterations > 2_000_000
    || salt === null
    || salt.byteLength < 16
    || salt.byteLength > 64
    || digest === null
    || digest.byteLength !== 32
  ) {
    invalidConfig();
  }
  return value;
}

function requirePositiveInteger(
  value: unknown,
  maximum: number,
): number {
  if (typeof value !== "string" || !POSITIVE_DECIMAL.test(value)) {
    invalidConfig();
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < 1
    || parsed > maximum
  ) {
    invalidConfig();
  }
  return parsed;
}

/**
 * Sites의 문자열 환경변수와 platform binding을 실제 서비스가 사용하는
 * 숫자·비밀·저장소 계약으로 한 번에 검증합니다.
 */
export function parseSitesRuntimeConfig(value: unknown): SitesRuntimeConfig {
  assertBindings(value);
  const accessCodeHash = requireAccessCodeHash(
    value.DEMO_ACCESS_CODE_HASH,
  );
  const sessionSecret = requireSessionSecret(value.DEMO_SESSION_SECRET);
  const openAiApiKey = requireBoundedSecret(
    value.OPENAI_API_KEY,
    API_KEY_MIN_LENGTH,
    API_KEY_MAX_LENGTH,
  );
  const sessionTtlSeconds = requirePositiveInteger(
    value.DEMO_SESSION_TTL_SECONDS,
    86_400,
  );
  const authFailureLimit = requirePositiveInteger(
    value.DEMO_AUTH_FAILURE_LIMIT,
    100,
  );
  const authFailureWindowMs = requirePositiveInteger(
    value.DEMO_AUTH_FAILURE_WINDOW_MS,
    86_400_000,
  );
  const authFailureBlockMs = requirePositiveInteger(
    value.DEMO_AUTH_FAILURE_BLOCK_MS,
    86_400_000,
  );
  const leaseDurationMs = requirePositiveInteger(
    value.DEMO_LEASE_DURATION_MS,
    3_600_000,
  );
  const reservedCostMicroUsd = requirePositiveInteger(
    value.DEMO_RESERVED_COST_MICRO_USD,
    100_000_000,
  );
  const maxSuccessfulRunsPerSession = requirePositiveInteger(
    value.DEMO_MAX_SUCCESSFUL_RUNS_PER_SESSION,
    100,
  );
  const maxOperationalRetriesPerSession = requirePositiveInteger(
    value.DEMO_MAX_OPERATIONAL_RETRIES_PER_SESSION,
    100,
  );
  const maxGlobalConcurrentRuns = requirePositiveInteger(
    value.DEMO_MAX_GLOBAL_CONCURRENT_RUNS,
    100,
  );
  const maxBucketRunCount = requirePositiveInteger(
    value.DEMO_MAX_BUCKET_RUN_COUNT,
    10_000,
  );
  const maxBucketCostMicroUsd = requirePositiveInteger(
    value.DEMO_MAX_BUCKET_COST_MICRO_USD,
    1_000_000_000,
  );
  const maxAuxiliaryCallsPerBucket = requirePositiveInteger(
    value.DEMO_MAX_AUXILIARY_CALLS_PER_BUCKET,
    100_000,
  );
  if (
    maxBucketCostMicroUsd < reservedCostMicroUsd
    || maxBucketRunCount < maxGlobalConcurrentRuns
  ) {
    invalidConfig();
  }

  return {
    repositoryBinding: value.DB,
    artifactBinding: value.ARTIFACTS,
    accessCodeHash,
    sessionSecret,
    openAiApiKey,
    sessionTtlSeconds,
    authFailureLimit,
    authFailureWindowMs,
    authFailureBlockMs,
    leaseDurationMs,
    reservedCostMicroUsd,
    maxSuccessfulRunsPerSession,
    maxOperationalRetriesPerSession,
    maxGlobalConcurrentRuns,
    maxBucketRunCount,
    maxBucketCostMicroUsd,
    maxAuxiliaryCallsPerBucket,
  };
}

/**
 * 검증된 Worker 상한을 live workflow의 동일 이름 계약으로 전달합니다.
 */
export function createSitesWorkflowLimits(
  config: SitesRuntimeConfig,
): SitesWorkflowLimits {
  return {
    leaseDurationMs: config.leaseDurationMs,
    reservedCostMicroUsd: config.reservedCostMicroUsd,
    maxSuccessfulRunsPerSession: config.maxSuccessfulRunsPerSession,
    maxOperationalRetriesPerSession:
      config.maxOperationalRetriesPerSession,
    maxGlobalConcurrentRuns: config.maxGlobalConcurrentRuns,
    maxBucketRunCount: config.maxBucketRunCount,
    maxBucketCostMicroUsd: config.maxBucketCostMicroUsd,
    maxAuxiliaryCallsPerBucket: config.maxAuxiliaryCallsPerBucket,
  };
}

/**
 * 자동 재시도는 실행기 계측과 비용 증거가 소유하므로 SDK 기본 재시도를 끕니다.
 */
export function createWorkerOpenAIClient(apiKey: string): OpenAI {
  const validatedApiKey = requireBoundedSecret(
    apiKey,
    API_KEY_MIN_LENGTH,
    API_KEY_MAX_LENGTH,
  );
  return new OpenAI({
    apiKey: validatedApiKey,
    maxRetries: 0,
    timeout: 120_000,
  });
}

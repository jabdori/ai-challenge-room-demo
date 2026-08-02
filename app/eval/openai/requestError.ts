import { APIConnectionTimeoutError } from "openai";

export function isOpenAITimeoutError(error: unknown): boolean {
  if (error instanceof APIConnectionTimeoutError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }

  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  return error.constructor.name === "APIConnectionTimeoutError"
    || error.name === "AbortError"
    || code === "ETIMEDOUT"
    || code === "ETIME";
}

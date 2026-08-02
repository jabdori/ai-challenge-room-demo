import type { TokenUsage } from "../runtime/pricing";

export interface ProviderCallEvidence {
  callNumber: number;
  responseId: string | null;
  status: "completed" | "incomplete" | "failed" | "refused";
  modelRequestedId: string;
  modelReportedId: string | null;
  serviceTierRequested: string;
  serviceTierReported: string | null;
  latencyMs: number;
  usage: TokenUsage | null;
  error?: string;
}

export interface RetrievalResultEvidence {
  rank: number;
  fileId: string;
  filename: string;
  score: number;
  sourceId: string;
  sectionId: string;
  factId: string;
  text: string;
  contentChunks?: string[];
}

export interface RetrievalCallEvidence {
  callNumber: number;
  operation: "VECTOR_STORE_SEARCH";
  status: "COMPLETE" | "FAILED" | "TIMEOUT";
  requestedQuery: string;
  reportedQuery: string | null;
  vectorStoreId: string;
  maxNumResults: number;
  rewriteQuery: boolean;
  latencyMs: number;
  results: RetrievalResultEvidence[];
  error?: string;
}

export interface ToolCallEvidence {
  callNumber: number;
  modelTurn: number;
  callId: string;
  toolName: string;
  status: "COMPLETE" | "FAILED" | "TIMEOUT" | "LIMIT_EXCEEDED";
  arguments: Record<string, unknown>;
  argumentsJson: string | null;
  providerStatus: string | null;
  result: unknown | null;
  latencyMs: number;
  error?: string;
}

export interface CandidateExecutionEvidence {
  providerCalls: ProviderCallEvidence[];
  retrievalCalls: RetrievalCallEvidence[];
  toolCalls: ToolCallEvidence[];
}

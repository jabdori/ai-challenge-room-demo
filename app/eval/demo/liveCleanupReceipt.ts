import type {
  CleanupItemResult,
} from "../retrieval/policyVectorStore";
import { redactSensitiveText } from "../runtime/secretSafety";

export interface CleanupResourceIds {
  readonly vectorStoreId: string | null;
  readonly uploadedFileIds: readonly string[];
}

export interface CleanupReceipt {
  readonly schema_version: "1.0";
  readonly artifact_kind: "CLEANUP_RECEIPT";
  readonly created_at: string;
  readonly deletion_semantics: "API_ACKNOWLEDGEMENT_ONLY_NO_PHYSICAL_DELETION_CLAIM";
  readonly expected_resources: {
    readonly vector_store_id: string | null;
    readonly uploaded_file_ids: readonly string[];
  };
  readonly api_delete_acknowledgements: {
    readonly vector_store: {
      readonly resource_id: string | null;
      readonly attempted: boolean;
      readonly deleted: boolean;
      readonly error?: string;
    };
    readonly uploaded_files: ReadonlyArray<{
      readonly resource_id: string;
      readonly attempted: boolean;
      readonly deleted: boolean;
      readonly error?: string;
    }>;
  };
  readonly runtime_errors: readonly string[];
}

export interface BuildCleanupReceiptInput {
  readonly expectedResources: CleanupResourceIds;
  readonly cleanup:
    | {
        readonly vectorStore: CleanupItemResult;
        readonly uploadedFiles: readonly CleanupItemResult[];
      }
    | null;
  readonly runtimeErrors?: readonly unknown[];
  readonly sensitiveValues?: readonly string[];
  readonly createdAt?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "알 수 없는 calibration 오류";
}

export function buildCleanupReceipt({
  expectedResources,
  cleanup,
  runtimeErrors = [],
  sensitiveValues = [],
  createdAt = new Date().toISOString(),
}: BuildCleanupReceiptInput): CleanupReceipt {
  const vectorAck = cleanup?.vectorStore.id === expectedResources.vectorStoreId
    ? cleanup.vectorStore
    : null;
  const fileAcks = new Map(
    (cleanup?.uploadedFiles ?? []).flatMap((item) =>
      item.id ? [[item.id, item] as const] : []),
  );
  return {
    schema_version: "1.0",
    artifact_kind: "CLEANUP_RECEIPT",
    created_at: createdAt,
    deletion_semantics: "API_ACKNOWLEDGEMENT_ONLY_NO_PHYSICAL_DELETION_CLAIM",
    expected_resources: {
      vector_store_id: expectedResources.vectorStoreId,
      uploaded_file_ids: [...expectedResources.uploadedFileIds],
    },
    api_delete_acknowledgements: {
      vector_store: {
        resource_id: expectedResources.vectorStoreId,
        attempted: vectorAck?.attempted ?? false,
        deleted: vectorAck?.deleted ?? false,
        ...(vectorAck?.error
          ? { error: redactSensitiveText(vectorAck.error, sensitiveValues) }
          : {}),
      },
      uploaded_files: expectedResources.uploadedFileIds.map((resourceId) => {
        const acknowledgement = fileAcks.get(resourceId);
        return {
          resource_id: resourceId,
          attempted: acknowledgement?.attempted ?? false,
          deleted: acknowledgement?.deleted ?? false,
          ...(acknowledgement?.error
            ? { error: redactSensitiveText(acknowledgement.error, sensitiveValues) }
            : {}),
        };
      }),
    },
    runtime_errors: runtimeErrors.map((error) =>
      redactSensitiveText(errorMessage(error), sensitiveValues)),
  };
}

export function isCleanupReceiptAcknowledged(
  receipt: CleanupReceipt,
): boolean {
  const vectorStore = receipt.api_delete_acknowledgements.vector_store;
  const vectorStoreAcknowledged = vectorStore.resource_id === null
    || (vectorStore.attempted && vectorStore.deleted);
  return vectorStoreAcknowledged
    && receipt.api_delete_acknowledgements.uploaded_files.every(
      (file) => file.attempted && file.deleted,
    );
}

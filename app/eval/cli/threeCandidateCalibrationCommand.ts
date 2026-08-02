import { requireOpenAiApiKey } from "./config";
import {
  buildCleanupReceipt,
  type CleanupReceipt,
} from "./cleanupReceipt";
import {
  deriveCalibrationOutcome,
  type CalibrationOutcome,
  type CalibrationResourceIds,
  type CalibrationInterruption,
} from "./calibrationOutcome";
import type { PartialCalibrationPack } from "../pack/calibrationPack";
import {
  PolicyVectorStorePreparationError,
  type PolicyDocument,
  type PolicyFileManifestEntry,
  type PolicyVectorStoreCleanupResult,
  type PreparedPolicyVectorStore,
} from "../retrieval/policyVectorStore";
import type { CandidateAdapter } from "../runner/types";
import { throwIfAborted } from "../runner/types";
import {
  CALIBRATION_CASE,
  CALIBRATION_ORDERS,
  CALIBRATION_POLICIES,
  CANDIDATE_CONFIGS,
  assertLockedSyntheticCalibrationData,
} from "../smoke/candidateDefinitions";
import {
  buildCandidateFacingOrder,
  buildCandidateFacingPolicies,
} from "../data/syntheticCalibration";

interface CandidateBFactoryOptions {
  vectorStoreId: string;
  manifest: readonly PolicyFileManifestEntry[];
  query: string;
  maxNumResults: 2;
}

interface CandidateCFactoryOptions {
  vectorStoreId: string;
  manifest: readonly PolicyFileManifestEntry[];
  lockedAsOf: string;
  orders: ReturnType<typeof buildCandidateFacingOrder>[];
  maxNumResults: 2;
}

interface ExecuteCalibrationInput {
  adapters: { A: CandidateAdapter; B: CandidateAdapter; C: CandidateAdapter };
  outputDirectory: string;
  persistChildren: false;
  signal?: AbortSignal;
}

export class CalibrationInterruptionError extends Error {
  readonly signalName: CalibrationInterruption;

  constructor(signalName: CalibrationInterruption) {
    super(`${signalName}으로 calibration 실행이 중단됐습니다.`);
    this.name = "CalibrationInterruptionError";
    this.signalName = signalName;
  }
}

export interface ThreeCandidateCalibrationCommandDependencies {
  assertSyntheticData: () => void;
  prepareOutputDirectory: (outputDirectory: string) => Promise<void>;
  createClient: (apiKey: string) => unknown;
  preparePolicyStore: (
    client: unknown,
    policies: readonly PolicyDocument[],
    options?: { signal?: AbortSignal },
  ) => Promise<PreparedPolicyVectorStore>;
  createCandidateA: (client: unknown) => CandidateAdapter;
  createCandidateB: (client: unknown, options: CandidateBFactoryOptions) => CandidateAdapter;
  createCandidateC: (client: unknown, options: CandidateCFactoryOptions) => CandidateAdapter;
  executeCalibration: (input: ExecuteCalibrationInput) => Promise<{
    pack: PartialCalibrationPack;
    filePath: string | null;
  }>;
  cleanupPolicyStore: (
    client: unknown,
    resources: CalibrationResourceIds,
  ) => Promise<PolicyVectorStoreCleanupResult>;
  persistCleanupReceipt: (
    receipt: CleanupReceipt,
    outputDirectory: string,
  ) => Promise<string>;
}

export interface ExecuteThreeCandidateCalibrationCommandOptions {
  environment: NodeJS.ProcessEnv;
  outputDirectory: string;
  dependencies: ThreeCandidateCalibrationCommandDependencies;
  signal?: AbortSignal;
}

function resourcesFromPrepared(prepared: PreparedPolicyVectorStore): CalibrationResourceIds {
  return {
    vectorStoreId: prepared.vectorStoreId,
    uploadedFileIds: [...prepared.uploadedFileIds],
  };
}

export async function executeThreeCandidateCalibrationCommand({
  environment,
  outputDirectory,
  dependencies,
  signal,
}: ExecuteThreeCandidateCalibrationCommandOptions): Promise<CalibrationOutcome> {
  let client: unknown;
  let apiKey: string | null = null;
  let prepared: PreparedPolicyVectorStore | null = null;
  let expectedResources: CalibrationResourceIds | null = null;
  let cleanup: PolicyVectorStoreCleanupResult | null = null;
  let pack: PartialCalibrationPack | null = null;
  let topPackPath: string | null = null;
  let cleanupReceiptPath: string | null = null;
  const runtimeErrors: unknown[] = [];

  try {
    apiKey = requireOpenAiApiKey(environment);
    dependencies.assertSyntheticData();
    // API key와 잠긴 합성 입력을 먼저 검증하되, provider client/resource를
    // 만들기 전에는 canonical 0700 output namespace를 반드시 확정합니다.
    throwIfAborted(signal);
    await dependencies.prepareOutputDirectory(outputDirectory);
    throwIfAborted(signal);
    client = dependencies.createClient(apiKey);
    try {
      prepared = await dependencies.preparePolicyStore(
        client,
        buildCandidateFacingPolicies(CALIBRATION_POLICIES) as PolicyDocument[],
        { ...(signal ? { signal } : {}) },
      );
      expectedResources = resourcesFromPrepared(prepared);
    } catch (error) {
      if (error instanceof PolicyVectorStorePreparationError) {
        expectedResources = {
          vectorStoreId: error.vectorStoreId,
          uploadedFileIds: [...error.uploadedFileIds],
        };
        cleanup = error.cleanup;
      }
      throw error;
    }

    try {
      throwIfAborted(signal);
      const adapterA = dependencies.createCandidateA(client);
      const adapterB = dependencies.createCandidateB(client, {
        vectorStoreId: prepared.vectorStoreId,
        manifest: prepared.files,
        query: CANDIDATE_CONFIGS.B.retrieval_query!,
        maxNumResults: 2,
      });
      const adapterC = dependencies.createCandidateC(client, {
        vectorStoreId: prepared.vectorStoreId,
        manifest: prepared.files,
        lockedAsOf: CALIBRATION_CASE.as_of,
        orders: CALIBRATION_ORDERS.map((order) => buildCandidateFacingOrder(order)),
        maxNumResults: 2,
      });
      const result = await dependencies.executeCalibration({
        adapters: { A: adapterA, B: adapterB, C: adapterC },
        outputDirectory,
        persistChildren: false,
        ...(signal ? { signal } : {}),
      });
      pack = result.pack;
      topPackPath = result.filePath;
    } catch (error) {
      runtimeErrors.push(error);
    }
    try {
      cleanup = await dependencies.cleanupPolicyStore(client, expectedResources);
    } catch (error) {
      runtimeErrors.push(error);
    }
  } catch (error) {
    runtimeErrors.push(error);
  }

  const sensitiveValues = [
    ...(apiKey ? [apiKey] : []),
    ...(expectedResources?.vectorStoreId ? [expectedResources.vectorStoreId] : []),
    ...(expectedResources?.uploadedFileIds ?? []),
  ];
  if (expectedResources) {
    const receipt = buildCleanupReceipt({
      expectedResources,
      cleanup,
      runtimeErrors,
      sensitiveValues: apiKey ? [apiKey] : [],
    });
    try {
      cleanupReceiptPath = await dependencies.persistCleanupReceipt(receipt, outputDirectory);
    } catch (error) {
      runtimeErrors.push(error);
    }
  }
  const interruption = signal?.reason instanceof CalibrationInterruptionError
    ? signal.reason.signalName
    : null;
  return deriveCalibrationOutcome({
    pack,
    topPackPath,
    expectedResources,
    cleanup,
    runtimeErrors,
    interruption,
    cleanupReceiptPath,
    sensitiveValues,
  });
}

export const DEFAULT_SYNTHETIC_PREFLIGHT = assertLockedSyntheticCalibrationData;

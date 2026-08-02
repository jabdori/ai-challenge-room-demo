import { dirname, resolve } from "node:path";
import OpenAI from "openai";
import { persistCleanupReceipt } from "./cleanupReceipt";
import {
  executeThreeCandidateCalibrationCommand,
  type ExecuteThreeCandidateCalibrationCommandOptions,
  type ThreeCandidateCalibrationCommandDependencies,
} from "./threeCandidateCalibrationCommand";
import { createCandidateAAdapter } from "../openai/candidateAAdapter";
import { createCandidateBAdapter } from "../openai/candidateBAdapter";
import { createCandidateCAdapter } from "../openai/candidateCAdapter";
import {
  cleanupPolicyVectorStore,
  preparePolicyVectorStore,
  type PolicyVectorStoreClientLike,
} from "../retrieval/policyVectorStore";
import { assertLockedSyntheticCalibrationData } from "../smoke/candidateDefinitions";
import { executeThreeCandidateCalibration } from "../smoke/executeThreeCandidateCalibration";
import { prepareWriteOnceArtifactDirectory } from "../pack/persistence";

export const DEFAULT_CALIBRATION_OUTPUT_DIRECTORY = resolve(
  import.meta.dirname,
  "../../.runtime/evaluation-packs",
);

function requireOpenAIClient(client: unknown): OpenAI {
  if (!(client instanceof OpenAI)) {
    throw new TypeError("production calibration에는 OpenAI client가 필요합니다.");
  }
  return client;
}

export function createProductionThreeCandidateCalibrationDependencies():
ThreeCandidateCalibrationCommandDependencies {
  return {
    assertSyntheticData: assertLockedSyntheticCalibrationData,
    prepareOutputDirectory: async (outputDirectory) => {
      const artifactDirectory = resolve(outputDirectory);
      await prepareWriteOnceArtifactDirectory({
        rootDirectory: dirname(artifactDirectory),
        artifactDirectory,
      });
    },
    createClient: (apiKey) => new OpenAI({
      apiKey,
      maxRetries: 0,
      timeout: 30_000,
    }),
    preparePolicyStore: (client, policies, options) => preparePolicyVectorStore(
      requireOpenAIClient(client) as PolicyVectorStoreClientLike,
      policies,
      options,
    ),
    createCandidateA: (client) => createCandidateAAdapter(
      requireOpenAIClient(client),
    ),
    createCandidateB: (client, options) => createCandidateBAdapter(
      requireOpenAIClient(client),
      options,
    ),
    createCandidateC: (client, options) => createCandidateCAdapter(
      requireOpenAIClient(client),
      options,
    ),
    executeCalibration: (input) => executeThreeCandidateCalibration(input),
    cleanupPolicyStore: (client, resources) => cleanupPolicyVectorStore(
      requireOpenAIClient(client) as PolicyVectorStoreClientLike,
      resources,
    ),
    persistCleanupReceipt,
  };
}

type ProductionCommandOptions = Omit<
  ExecuteThreeCandidateCalibrationCommandOptions,
  "dependencies"
>;

export function executeProductionThreeCandidateCalibration(
  options: ProductionCommandOptions,
) {
  return executeThreeCandidateCalibrationCommand({
    ...options,
    dependencies: createProductionThreeCandidateCalibrationDependencies(),
  });
}

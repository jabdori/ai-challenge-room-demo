import type { PartialEvaluationPack } from "../pack/evaluationPack";
import { persistPartialEvaluationPack } from "../pack/persistence";
import type { CandidateAdapter, CandidateInvocation } from "../runner/types";
import {
  CANDIDATE_CONFIGS,
  buildCandidateInvocation,
  createCandidateCalibrationDefinition,
} from "./candidateDefinitions";
import { executeCandidateCalibration } from "./executeCandidateCalibration";

export const CANDIDATE_A_CONFIG = CANDIDATE_CONFIGS.A;

interface ExecuteCalibrationSmokeOptions {
  adapter: CandidateAdapter;
  outputDirectory?: string;
  now?: () => number;
  createdAt?: string;
}

export interface CalibrationSmokeResult {
  pack: PartialEvaluationPack;
  filePath: string | null;
}

export function buildCandidateAInvocation(): CandidateInvocation {
  return buildCandidateInvocation("A");
}

export async function executeCalibrationSmoke({
  adapter,
  outputDirectory,
  now,
  createdAt = new Date().toISOString(),
}: ExecuteCalibrationSmokeOptions): Promise<CalibrationSmokeResult> {
  const pack = await executeCandidateCalibration({
    definition: createCandidateCalibrationDefinition("A", adapter),
    now,
    createdAt,
  });
  const filePath = outputDirectory
    ? await persistPartialEvaluationPack(pack, outputDirectory)
    : null;
  return { pack, filePath };
}

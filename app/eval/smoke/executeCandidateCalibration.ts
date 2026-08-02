import type { PolicyGateOracle, PolicyReference } from "../deterministic/policyGate";
import { evaluateActivePolicyGate } from "../deterministic/policyGate";
import {
  buildPartialEvaluationPack,
  type GateRunRecord,
  type PartialEvaluationPack,
} from "../pack/evaluationPack";
import { runCandidateTwice } from "../runner/runCandidate";
import { sha256CanonicalJson } from "../runtime/canonicalJson";
import {
  ABC_CHALLENGE,
  CALIBRATION_CASE,
  CALIBRATION_DATASET_HASH,
  CALIBRATION_ORACLE,
  CALIBRATION_POLICIES,
  CALIBRATION_PRICING,
  CANDIDATE_IDENTITY_RECORDS,
  CANDIDATE_IDS,
  SHARED_EVALUATION_IDENTITY,
  type CalibrationCandidateId,
  type CandidateCalibrationDefinition,
} from "./candidateDefinitions";

export interface ExecuteCandidateCalibrationOptions {
  definition: CandidateCalibrationDefinition;
  now?: () => number;
  createdAt?: string;
  controlKind?: "NEGATIVE_CONTROL";
  signal?: AbortSignal;
}

interface DefinitionSnapshot {
  candidateId: CalibrationCandidateId;
  candidateVersion: string;
  config: CandidateCalibrationDefinition["config"];
  systemPrompt: string;
  invocation: CandidateCalibrationDefinition["invocation"];
}

function snapshotDefinition(
  definition: CandidateCalibrationDefinition,
): DefinitionSnapshot {
  const serialized = JSON.stringify({
    candidateId: definition.candidateId,
    candidateVersion: definition.candidateVersion,
    config: definition.config,
    systemPrompt: definition.systemPrompt,
    invocation: definition.invocation,
  });
  if (serialized === undefined) {
    throw new TypeError("Candidate calibration definition을 JSON snapshot으로 만들 수 없습니다.");
  }
  return JSON.parse(serialized) as DefinitionSnapshot;
}

function assertDefinitionMapping(snapshot: DefinitionSnapshot): void {
  if (!CANDIDATE_IDS.includes(snapshot.candidateId)) {
    throw new Error("Candidate calibration candidate mapping은 exact A/B/C만 허용합니다.");
  }
  const expected = CANDIDATE_IDENTITY_RECORDS[snapshot.candidateId];
  const mappingMatches = snapshot.candidateVersion === expected.candidate_version
    && snapshot.config.candidate_id === snapshot.candidateId
    && snapshot.config.candidate_version === snapshot.candidateVersion
    && snapshot.invocation.candidateId === snapshot.candidateId
    && snapshot.invocation.modelRequestedId === snapshot.config.model_requested_id
    && snapshot.invocation.serviceTierRequested === snapshot.config.service_tier
    && snapshot.invocation.instructions === snapshot.systemPrompt
    && sha256CanonicalJson(snapshot.config) === expected.candidate_config_hash
    && sha256CanonicalJson(snapshot.systemPrompt) === expected.system_prompt_hash
    && sha256CanonicalJson(snapshot.invocation) === expected.invocation_hash;
  if (!mappingMatches) {
    throw new Error("Candidate ID/version/config/prompt/invocation mapping이 잠긴 정의와 일치하지 않습니다.");
  }
}

function buildGateRecords(
  runs: Awaited<ReturnType<typeof runCandidateTwice>>,
): GateRunRecord[] {
  return runs.map((run) => {
    if (!run.output) {
      const reason = run.status === "TIMEOUT"
        ? "TIMEOUT"
        : run.status === "BUDGET_EXCEEDED"
          ? "BUDGET_EXCEEDED"
          : "INVALID_OUTPUT";
      return { runNumber: run.runNumber, evaluation: "NOT_EVALUATED", reason };
    }
    return {
      runNumber: run.runNumber,
      evaluation: "EVALUATED",
      result: evaluateActivePolicyGate({
        output: run.output,
        oracle: CALIBRATION_ORACLE as PolicyGateOracle,
        policies: CALIBRATION_POLICIES as PolicyReference[],
        asOf: CALIBRATION_CASE.as_of,
      }),
    };
  });
}

export async function executeCandidateCalibration({
  definition,
  now,
  createdAt = new Date().toISOString(),
  controlKind,
  signal,
}: ExecuteCandidateCalibrationOptions): Promise<PartialEvaluationPack> {
  const snapshot = snapshotDefinition(definition);
  const invoke = definition.adapter.invoke.bind(definition.adapter);
  const adapter = { invoke };
  assertDefinitionMapping(snapshot);

  const runs = await runCandidateTwice({
    adapter,
    invocation: snapshot.invocation,
    now,
    signal,
  });
  const gateResults = buildGateRecords(runs);

  return buildPartialEvaluationPack({
    challengeVersion: ABC_CHALLENGE.challenge_version,
    candidateId: snapshot.candidateId,
    candidateVersion: snapshot.candidateVersion,
    datasetHash: CALIBRATION_DATASET_HASH,
    candidateConfigHash: sha256CanonicalJson(snapshot.config),
    systemPromptHash: sha256CanonicalJson(snapshot.systemPrompt),
    invocationHash: sha256CanonicalJson(snapshot.invocation),
    sharedEvaluationIdentity: SHARED_EVALUATION_IDENTITY,
    ...(controlKind ? { controlKind } : {}),
    modelRequestedId: snapshot.config.model_requested_id,
    serviceTierRequested: snapshot.config.service_tier,
    pricing: CALIBRATION_PRICING,
    caseId: CALIBRATION_CASE.case_id,
    runs,
    gateResults,
    createdAt,
  });
}

import {
  buildRecordedRegressionPack,
  loadRecordedRegressionPackFromSources,
  persistRecordedRegressionPack,
  type RegressionAuthorityChain,
  type RegressionResourceEvidence,
  type RegressionSlotRecord,
} from "../../regression/regressionPack";
import {
  buildRegressionSchedule,
  type RegressionSufficiencyContract,
} from "../../regression/runRegression";
import type { DecisionBaselineRecord } from "../../decision/decisionBaseline";
import type { RecordedBenchmarkPack } from "../../pack/recordedBenchmarkPack";
import type { CandidateOutput } from "../../contracts/candidateOutput";
import { sha256CanonicalJson } from "../../runtime/canonicalJson";

function hash(label: string): string {
  return sha256CanonicalJson({ label });
}

const sufficiency: RegressionSufficiencyContract = Object.freeze({
  hidden_policy_minimum_correct: 11,
  hidden_citation_required_cases: 11,
  hidden_escalation_required_cases: 4,
  mean_runtime_cost_usd_maximum: 0.2,
  median_latency_ms_maximum: 10_000,
  worst_latency_ms_maximum: 30_000,
});

const resources: RegressionResourceEvidence = Object.freeze({
  baseline: {
    status: "CLEANED" as const,
    policy_resource_identity_hash: hash("fixture-baseline-resource"),
    manifest_hash: hash("fixture-baseline-manifest"),
    cleanup_receipt_hash: hash("fixture-baseline-cleanup"),
  },
  proposed: {
    status: "CLEANED" as const,
    policy_resource_identity_hash: hash("fixture-proposed-resource"),
    manifest_hash: hash("fixture-proposed-manifest"),
    cleanup_receipt_hash: hash("fixture-proposed-cleanup"),
  },
});

function slots(candidateId: "A" | "B" | "C"): RegressionSlotRecord[] {
  return buildRegressionSchedule(candidateId).map((slot) => {
    const candidateOutput: CandidateOutput = {
      customer_reply: "Synthetic recorded regression reply.",
      decision: {
        intent_codes: ["ORDER_STATUS"],
        action_code: "PROVIDE_ORDER_STATUS",
        escalation_required: false,
        escalation_reason_code: "NOT_REQUIRED",
        target_queue: "NONE",
      },
      citations: [],
    };
    return {
      schema_version: "regression-slot-record-v1" as const,
      slot,
      slot_identity_hash: hash(`fixture-slot:${slot.slot_id}`),
      candidate_config_hash: hash(`fixture-config:${slot.version}:${slot.case_id}`),
      candidate_input_hash: hash(`fixture-input:${slot.version}:${slot.case_id}`),
      policy_corpus_hash: hash(`fixture-policy:${slot.version}`),
      raw_execution_evidence: {
        execution_status: "COMPLETE" as const,
        evaluation_status: "EVALUATED" as const,
        request_disposition: "SENT_RESPONSE_RECORDED" as const,
        cost_state: "COMPLETE" as const,
        candidate_cost_usd: 0.001,
        total_latency_ms: 100,
        output_hash: sha256CanonicalJson(candidateOutput),
        candidate_output: candidateOutput,
        provider_calls: [{
          call_number: 1,
          response_id_hash: hash(`fixture-response:${slot.slot_id}`),
          status: "completed",
          usage_hash: hash(`fixture-usage:${slot.slot_id}`),
          latency_ms: 100,
        }],
        retrieval_calls: [],
        tool_calls: [],
        access_evidence_hash: hash(`fixture-access:${slot.slot_id}`),
      },
      deterministic_evaluation: {
        hard_gate_failures: [],
        policy_decision_passed: true,
        citation_passed: true,
        escalation_passed: true,
      },
    };
  });
}

/** 36-slot canonical source와 write-once pack을 같이 제공하는 restart E2E fixture입니다. */
export async function createPersistedRecordedRegressionFixture({
  outputDirectory,
  decisionBaselineRecord,
  recordedBenchmarkPack,
}: {
  readonly outputDirectory: string;
  readonly decisionBaselineRecord: DecisionBaselineRecord;
  readonly recordedBenchmarkPack: RecordedBenchmarkPack;
}) {
  const authority: RegressionAuthorityChain = {
    decision_baseline_record_hash: sha256CanonicalJson(decisionBaselineRecord),
    recorded_benchmark_pack_hash: sha256CanonicalJson(recordedBenchmarkPack),
    human_confirmation_receipt_hash:
      decisionBaselineRecord.human_confirmation_receipt_hash,
    final_decision_memo_hash: decisionBaselineRecord.final_decision_memo_hash,
    final_decision_confirmation_receipt_hash:
      decisionBaselineRecord.final_decision_confirmation_receipt_hash,
    locked_challenge_pack_hash: decisionBaselineRecord.locked_challenge_pack_hash,
    aggregation_hash: decisionBaselineRecord.aggregation_hash,
    baseline_version: decisionBaselineRecord.baseline_version,
    selected_candidate_identity_hash: sha256CanonicalJson(
      decisionBaselineRecord.selected_candidate_identity,
    ),
    deterministic_evaluator_contract_hash:
      decisionBaselineRecord.evaluator_identities.deterministic_evaluator_contract_hash,
    evaluator_policy_manifest_hash:
      decisionBaselineRecord.evaluator_identities.evaluator_policy_manifest_hash,
    judge_request_contract_hash:
      decisionBaselineRecord.evaluator_identities.judge_request_contract_hash,
    judge_evidence_pack_hash:
      decisionBaselineRecord.evaluator_identities.judge_evidence_pack_hash,
    pricing_snapshot_hash:
      decisionBaselineRecord.selected_candidate_identity.pricing_snapshot_hash,
    runner_contract_hash:
      decisionBaselineRecord.selected_candidate_identity.runner_contract_hash,
    evidence_contract_hash:
      decisionBaselineRecord.selected_candidate_identity.evidence_contract_hash,
  };
  const source = {
    authority,
    selectedCandidateId: decisionBaselineRecord.selected_candidate_id,
    slots: slots(decisionBaselineRecord.selected_candidate_id),
    sufficiency,
    datasetHashes: {
      hidden_dataset_hash: hash("fixture-regression-hidden-dataset"),
      regression_canary_hash: hash("fixture-regression-canary-dataset"),
    },
    versionIdentities: {
      baseline: {
        version: "BASELINE_V1" as const,
        candidate_version: "fixture-baseline-v1",
        candidate_configuration_set_hash: hash("fixture-baseline-config"),
        policy_corpus_hash: hash("fixture-baseline-policy"),
        defect_profile: "NONE" as const,
      },
      proposed: {
        version: "PROPOSED_V2" as const,
        candidate_version: "fixture-proposed-v2",
        candidate_configuration_set_hash: hash("fixture-proposed-config"),
        policy_corpus_hash: hash("fixture-proposed-policy"),
        defect_profile:
          "ACTIVE_RET_3_1_REMOVED_RETIRED_RET_3_3_EXPOSED" as const,
      },
    },
    resources,
    createdAt: "2026-07-18T00:20:00.000Z",
  };
  const pack = buildRecordedRegressionPack(source);
  const persisted = await persistRecordedRegressionPack({ outputDirectory, pack });
  const reloaded = await loadRecordedRegressionPackFromSources({
    path: persisted.path,
    source,
  });
  return Object.freeze({
    pack: reloaded,
    path: persisted.path,
    payloadSha256: persisted.payloadSha256,
  });
}

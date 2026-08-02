import {
  buildBenchmarkSlotExpectedIdentity,
  validateLockedBenchmarkExecutionIdentity,
  type BenchmarkExecutionIdentity,
  type BenchmarkSlotIdentity,
} from "../benchmark/identity";
import {
  buildBenchmarkSchedule,
  type BenchmarkSchedule,
} from "../benchmark/schedule";
import { BENCHMARK_CASES } from "../data/benchmark";
import {
  canonicalJsonStringify,
} from "../runtime/canonicalJson";
import {
  assertValidatedBenchmarkExecutionPack,
  buildBenchmarkExecutionPack,
  type BenchmarkCompletedSlot,
  type BenchmarkExecutionPack,
} from "./benchmarkPack";
import {
  loadBenchmarkSlotResumeState,
  validateBenchmarkSlotArtifactChain,
} from "./benchmarkPersistence";

type JsonRecord = Record<string, unknown>;

export class BenchmarkEvidenceReloadIntegrityError extends Error {
  readonly code = "BENCHMARK_EVIDENCE_RELOAD_INTEGRITY" as const;
  readonly evaluationStatus = "EVALUATION_INCOMPLETE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BenchmarkEvidenceReloadIntegrityError";
  }
}

export interface BenchmarkEvidenceReloadPlan {
  readonly slot_identity: BenchmarkSlotIdentity;
}

export interface PersistedBenchmarkExecutionEvidence {
  readonly schema_version: "persisted-benchmark-execution-evidence-v1";
  readonly execution_identity: BenchmarkExecutionIdentity;
  readonly completed_slots: readonly BenchmarkCompletedSlot[];
}

export interface RehydratedBenchmarkExecutionPack {
  readonly benchmarkPack: BenchmarkExecutionPack;
  readonly executionEvidence: PersistedBenchmarkExecutionEvidence;
}

function integrity(
  message: string,
  cause?: unknown,
): BenchmarkEvidenceReloadIntegrityError {
  return new BenchmarkEvidenceReloadIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

async function reloadCompletedSlots({
  outputDirectory,
  executionIdentity,
  schedule,
  plans,
}: {
  readonly outputDirectory: string;
  readonly executionIdentity: BenchmarkExecutionIdentity;
  readonly schedule: BenchmarkSchedule;
  readonly plans: readonly BenchmarkEvidenceReloadPlan[];
}): Promise<PersistedBenchmarkExecutionEvidence> {
  const lockedSchedule = buildBenchmarkSchedule(
    BENCHMARK_CASES,
    ["A", "B", "C"],
  );
  if (
    !same(schedule, lockedSchedule)
    || schedule.schedule_id !== lockedSchedule.schedule_id
    || plans.length !== 72
  ) {
    throw integrity(
      "persisted Benchmark reload에는 잠긴 72-slot schedule·plan이 필요합니다.",
    );
  }
  try {
    validateLockedBenchmarkExecutionIdentity(
      executionIdentity,
      lockedSchedule.schedule_id,
    );
  } catch (error) {
    throw integrity("persisted Benchmark reload execution identity가 다릅니다.", error);
  }
  const completed: BenchmarkCompletedSlot[] = [];
  for (let index = 0; index < lockedSchedule.length; index += 1) {
    const slot = lockedSchedule[index];
    const slotIdentity = plans[index]?.slot_identity;
    if (
      slotIdentity === undefined
      || slotIdentity.slot_id !== slot.slot_id
      || slotIdentity.sequence !== slot.sequence
      || slotIdentity.case_id !== slot.case_id
      || slotIdentity.candidate_id !== slot.candidate_id
      || slotIdentity.repetition !== slot.repetition
      || slotIdentity.execution_hash !== executionIdentity.execution_hash
    ) {
      throw integrity(
        `persisted Benchmark reload plan 순서·identity가 다릅니다: ${slot.slot_id}`,
      );
    }
    const expectedIdentity = buildBenchmarkSlotExpectedIdentity(
      executionIdentity,
      slotIdentity,
    );
    const state = await loadBenchmarkSlotResumeState({
      outputDirectory,
      executionHash: executionIdentity.execution_hash,
      slot,
      expectedIdentity,
    });
    if (state.state !== "CHECKPOINT") {
      throw integrity(
        `persisted Benchmark reload에는 완료 checkpoint가 필요합니다: ${slot.slot_id}`,
      );
    }
    const validated = validateBenchmarkSlotArtifactChain({
      intent: state.intent,
      receipt: state.receipt,
      checkpoint: state.checkpoint,
      expectedIdentity,
    });
    completed.push(deepFreeze({
      slot_identity: slotIdentity,
      intent: validated.intent,
      receipt: validated.receipt,
      checkpoint: validated.checkpoint,
    }));
  }
  return deepFreeze({
    schema_version: "persisted-benchmark-execution-evidence-v1",
    execution_identity: executionIdentity,
    completed_slots: completed,
  });
}

/**
 * cold start는 process-local WeakSet brand에 의존하지 않고 canonical 72-slot
 * source를 다시 읽어 부모 실행 팩을 재구성합니다. expected pack은 brandless
 * JSON이어도 되지만, 재구성 결과와 byte-equivalent여야 합니다.
 */
export async function rehydrateBenchmarkExecutionPack({
  outputDirectory,
  expectedBenchmarkPack,
  executionIdentity,
  schedule,
  plans,
}: {
  readonly outputDirectory: string;
  readonly expectedBenchmarkPack: BenchmarkExecutionPack;
  readonly executionIdentity: BenchmarkExecutionIdentity;
  readonly schedule: BenchmarkSchedule;
  readonly plans: readonly BenchmarkEvidenceReloadPlan[];
}): Promise<RehydratedBenchmarkExecutionPack> {
  const executionEvidence = await reloadCompletedSlots({
    outputDirectory,
    executionIdentity,
    schedule,
    plans,
  });
  const benchmarkPack = buildBenchmarkExecutionPack({
    executionIdentity,
    schedule,
    completedSlots: executionEvidence.completed_slots,
  });
  if (
    executionIdentity.execution_hash !== expectedBenchmarkPack.execution_hash
    || executionIdentity.locked_challenge_pack_hash
      !== expectedBenchmarkPack.locked_challenge_pack_hash
    || !same(benchmarkPack, expectedBenchmarkPack)
  ) {
    throw integrity(
      "persisted 72-slot chain에서 재생성한 부모 실행팩이 canonical source와 다릅니다.",
    );
  }
  return deepFreeze({ benchmarkPack, executionEvidence });
}

export async function loadPersistedBenchmarkExecutionEvidence({
  outputDirectory,
  benchmarkPack,
  executionIdentity,
  schedule,
  plans,
}: {
  readonly outputDirectory: string;
  readonly benchmarkPack: BenchmarkExecutionPack;
  readonly executionIdentity: BenchmarkExecutionIdentity;
  readonly schedule: BenchmarkSchedule;
  readonly plans: readonly BenchmarkEvidenceReloadPlan[];
}): Promise<PersistedBenchmarkExecutionEvidence> {
  assertValidatedBenchmarkExecutionPack(benchmarkPack);
  return (await rehydrateBenchmarkExecutionPack({
    outputDirectory,
    expectedBenchmarkPack: benchmarkPack,
    executionIdentity,
    schedule,
    plans,
  })).executionEvidence;
}

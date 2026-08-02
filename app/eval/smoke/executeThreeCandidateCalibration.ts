import type { PartialCalibrationPack } from "../pack/calibrationPack";
import { buildPartialCalibrationPack } from "../pack/calibrationPack";
import type { PartialEvaluationPack } from "../pack/evaluationPack";
import {
  persistPartialCalibrationPack,
  persistPartialEvaluationPack,
} from "../pack/persistence";
import type { CandidateAdapter } from "../runner/types";
import {
  CANDIDATE_IDS,
  createCandidateCalibrationDefinition,
  type CalibrationCandidateId,
} from "./candidateDefinitions";
import { executeCandidateCalibration } from "./executeCandidateCalibration";

export interface ExecuteThreeCandidateCalibrationOptions {
  adapters: Record<CalibrationCandidateId, CandidateAdapter>;
  outputDirectory?: string;
  /**
   * 개발 중 개별 후보 증거를 살펴보기 위한 선택적 저장입니다. 기본값은 false이며,
   * true일 때의 여러 child 파일 저장은 단일 트랜잭션 원자성을 보장하지 않습니다.
   * 상위 pack 전체 검증은 어떤 파일을 쓰기 전에 항상 먼저 완료됩니다.
   */
  persistChildren?: boolean;
  now?: () => number;
  createdAt?: string;
  signal?: AbortSignal;
}

export interface ThreeCandidateCalibrationResult {
  pack: PartialCalibrationPack;
  childPacks: Record<CalibrationCandidateId, PartialEvaluationPack>;
  filePath: string | null;
  childFilePaths: Record<CalibrationCandidateId, string | null>;
}

function captureAdapter(adapter: CandidateAdapter): CandidateAdapter {
  const invoke = adapter.invoke.bind(adapter);
  return { invoke };
}

export async function executeThreeCandidateCalibration({
  adapters,
  outputDirectory,
  persistChildren = false,
  now,
  createdAt = new Date().toISOString(),
  signal,
}: ExecuteThreeCandidateCalibrationOptions): Promise<ThreeCandidateCalibrationResult> {
  // A 실행 중 외부 adapters map이 변경되어도 동일 calibration의
  // B/C 구성이 바뀌지 않도록 await 전에 참조를 잠그니다.
  const adapterSnapshot: Record<CalibrationCandidateId, CandidateAdapter> = {
    A: captureAdapter(adapters.A),
    B: captureAdapter(adapters.B),
    C: captureAdapter(adapters.C),
  };
  const childPacks = {} as Record<CalibrationCandidateId, PartialEvaluationPack>;
  const childFilePaths = { A: null, B: null, C: null } as Record<
    CalibrationCandidateId,
    string | null
  >;

  for (const candidateId of CANDIDATE_IDS) {
    const pack = await executeCandidateCalibration({
      definition: createCandidateCalibrationDefinition(
        candidateId,
        adapterSnapshot[candidateId],
      ),
      now,
      createdAt,
      signal,
    });
    childPacks[candidateId] = pack;
  }

  const pack = buildPartialCalibrationPack({
    entries: CANDIDATE_IDS.map((candidateId) => ({
      candidate_id: candidateId,
      evaluation_pack: childPacks[candidateId],
    })),
    createdAt,
  });
  if (persistChildren && outputDirectory) {
    for (const candidateId of CANDIDATE_IDS) {
      childFilePaths[candidateId] = await persistPartialEvaluationPack(
        childPacks[candidateId],
        outputDirectory,
      );
    }
  }
  const filePath = outputDirectory
    ? await persistPartialCalibrationPack(pack, outputDirectory)
    : null;

  return { pack, childPacks, filePath, childFilePaths };
}

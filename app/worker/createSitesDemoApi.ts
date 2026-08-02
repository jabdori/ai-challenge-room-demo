import {
  createDemoAuxiliaryRiskAdapter,
  createDemoDecisionMemoAdapter,
} from "../eval/demo/demoOpenAiArtifacts";
import {
  createLiveComparisonDependencies,
  executeLiveComparison,
} from "../eval/demo/executeLiveComparison";
import {
  loadRecordedSyntheticDemoProjectionFixture,
} from "../eval/demo/recordedSyntheticDemoProjectionFixture";
import {
  D1DemoStateRepository,
} from "../server/sites/d1DemoStateRepository";
import {
  createJudgeAccessAuth,
} from "../server/sites/judgeAccessAuth";
import {
  createLiveDemoWorkflowService,
} from "../server/sites/liveDemoWorkflowService";
import {
  R2DemoArtifactStore,
} from "../server/sites/r2DemoArtifactStore";
import {
  createSitesDemoApi,
  type SitesDemoApi,
} from "../server/sites/sitesDemoApi";
import {
  createSitesWorkflowLimits,
  createWorkerOpenAIClient,
  parseSitesRuntimeConfig,
  type Env,
} from "./env";
import {
  ensureSitesDemoSchema,
} from "./sitesD1Migrations";

/**
 * 요청 범위에서 Worker binding과 서버 비밀을 조립합니다. 상태는 D1/R2가
 * 소유하며 module 전역에 세션·실행·비밀을 보존하지 않습니다.
 */
export function createSitesDemoApiFromEnv(env: Env): SitesDemoApi {
  const config = parseSitesRuntimeConfig(env);
  const repository = new D1DemoStateRepository(config.repositoryBinding);
  const artifactStore = new R2DemoArtifactStore(config.artifactBinding);
  const client = createWorkerOpenAIClient(config.openAiApiKey);
  const liveDependencies = createLiveComparisonDependencies(client);
  const auth = createJudgeAccessAuth({
    repository,
    accessCodeHash: config.accessCodeHash,
    sessionSecret: config.sessionSecret,
    sessionTtlSeconds: config.sessionTtlSeconds,
    authFailureLimit: config.authFailureLimit,
    authFailureWindowMs: config.authFailureWindowMs,
    authFailureBlockMs: config.authFailureBlockMs,
  });
  const service = createLiveDemoWorkflowService({
    repository,
    artifactStore,
    runLiveComparison: (input) => executeLiveComparison({
      dependencies: liveDependencies,
      artifactStore: input.artifactStore,
      createdAt: input.createdAt,
      now: input.now,
      onProgress: input.onProgress,
    }),
    riskAdapter: createDemoAuxiliaryRiskAdapter(client),
    memoAdapter: createDemoDecisionMemoAdapter(client),
    recordedProjection: loadRecordedSyntheticDemoProjectionFixture(),
    ...createSitesWorkflowLimits(config),
  });

  const api = createSitesDemoApi({ auth, service });
  return async (request) => {
    await ensureSitesDemoSchema(config.repositoryBinding);
    return api(request);
  };
}

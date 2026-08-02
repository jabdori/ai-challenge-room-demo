const VITEST_WORKER_ID = /^(?:0|[1-9][0-9]*)$/;

export class TestOnlyServerEntrypointDeniedError extends Error {
  readonly code = "TEST_ONLY_SERVER_ENTRYPOINT_DENIED" as const;

  constructor() {
    super(
      "ForTest server entrypoint는 저장소 Vitest worker 안에서만 실행할 수 있습니다.",
    );
    this.name = "TestOnlyServerEntrypointDeniedError";
  }
}

/**
 * 공개 ForTest server 조립 경계의 공통 fail-closed guard입니다.
 * NODE_ENV 또는 VITEST 하나만 설정한 일반 프로세스는 허용하지 않습니다.
 */
export function assertTestOnlyServerEntrypoint(): void {
  if (
    process.env.NODE_ENV !== "test"
    || process.env.VITEST !== "true"
    || !VITEST_WORKER_ID.test(process.env.VITEST_WORKER_ID ?? "")
  ) {
    throw new TestOnlyServerEntrypointDeniedError();
  }
}

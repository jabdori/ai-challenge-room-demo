import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadReadOnlyProjectionSnapshotRecord,
  type ProjectionSnapshot,
} from "./projectionRepository";
import {
  startReadOnlyWorkspaceServer,
  type ReadOnlyWorkspaceServer,
} from "./nodeWorkspaceServer";

export const WORKSPACE_SERVER_ENV = Object.freeze({
  projectionPath: "AI_WORKSPACE_PROJECTION_PATH",
  staticDirectory: "AI_WORKSPACE_STATIC_DIRECTORY",
  port: "AI_WORKSPACE_PORT",
});

export interface WorkspaceServerProcessLike {
  readonly env: NodeJS.ProcessEnv;
  exitCode?: string | number | null;
  readonly stdout: { write(value: string): unknown };
  readonly stderr: { write(value: string): unknown };
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface ServeWorkspaceDependencies {
  readonly loadSnapshot: (
    path: string,
  ) => Promise<ProjectionSnapshot>;
  readonly startServer: (input: {
    readonly snapshot: ProjectionSnapshot;
    readonly staticDirectory: string;
    readonly port: number;
  }) => Promise<ReadOnlyWorkspaceServer>;
}

const DEFAULT_DEPENDENCIES: ServeWorkspaceDependencies = {
  loadSnapshot: (path) => loadReadOnlyProjectionSnapshotRecord({ path }),
  startServer: startReadOnlyWorkspaceServer,
};

function requiredPath(
  environment: NodeJS.ProcessEnv,
  key: string,
): string {
  const value = environment[key]?.trim();
  if (!value || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${key}가 필요합니다.`);
  }
  return resolve(value);
}

function portFromEnvironment(environment: NodeJS.ProcessEnv): number {
  const raw = environment[WORKSPACE_SERVER_ENV.port]?.trim() ?? "4173";
  if (!/^\d{1,5}$/.test(raw)) {
    throw new TypeError("AI_WORKSPACE_PORT가 유효하지 않습니다.");
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("AI_WORKSPACE_PORT가 1~65535 범위가 아닙니다.");
  }
  return port;
}

export async function startWorkspaceFromEnvironment({
  environment,
  dependencies = DEFAULT_DEPENDENCIES,
}: {
  readonly environment: NodeJS.ProcessEnv;
  readonly dependencies?: ServeWorkspaceDependencies;
}): Promise<ReadOnlyWorkspaceServer> {
  const projectionPath = requiredPath(
    environment,
    WORKSPACE_SERVER_ENV.projectionPath,
  );
  const staticDirectory = requiredPath(
    environment,
    WORKSPACE_SERVER_ENV.staticDirectory,
  );
  const port = portFromEnvironment(environment);
  // Snapshot의 0600/nlink1/content address와 공개 schema를 먼저 재검증한 뒤에만
  // loopback listener를 엽니다.
  const snapshot = await dependencies.loadSnapshot(projectionPath);
  return dependencies.startServer({ snapshot, staticDirectory, port });
}

export async function runWorkspaceServerProcess({
  runtime = process,
  dependencies = DEFAULT_DEPENDENCIES,
}: {
  readonly runtime?: WorkspaceServerProcessLike;
  readonly dependencies?: ServeWorkspaceDependencies;
} = {}): Promise<ReadOnlyWorkspaceServer | null> {
  let server: ReadOnlyWorkspaceServer;
  try {
    server = await startWorkspaceFromEnvironment({
      environment: runtime.env,
      dependencies,
    });
  } catch {
    runtime.stderr.write(
      "읽기 전용 workspace server가 projection·build·port preflight를 통과하지 못했습니다.\n",
    );
    runtime.exitCode = 1;
    return null;
  }
  runtime.stdout.write(
    `AI Challenge Room · READ-ONLY AUTHORITATIVE PROJECTION · ${server.origin}\n`,
  );
  const shutdown = () => {
    void server.close().finally(() => {
      runtime.removeListener("SIGINT", shutdown);
      runtime.removeListener("SIGTERM", shutdown);
    });
  };
  runtime.on("SIGINT", shutdown);
  runtime.on("SIGTERM", shutdown);
  return server;
}

function isDirectExecution(
  metaUrl: string,
  argvEntry: string | undefined,
): boolean {
  return argvEntry !== undefined
    && metaUrl === pathToFileURL(resolve(argvEntry)).href;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void runWorkspaceServerProcess();
}

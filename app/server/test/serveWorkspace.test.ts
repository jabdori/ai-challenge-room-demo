// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { buildProjectionSnapshot } from "../projectionRepository";
import {
  runWorkspaceServerProcess,
  startWorkspaceFromEnvironment,
  WORKSPACE_SERVER_ENV,
  type ServeWorkspaceDependencies,
} from "../serveWorkspace";

const SOURCE = "a".repeat(64);
const SNAPSHOT = buildProjectionSnapshot({
  source_chain: [{
    artifact_kind: "LOCKED_CHALLENGE_PACK",
    artifact_id: "challenge_1",
    payload_sha256: SOURCE,
  }],
  workspace: {
    schema_version: "workspace-public-projection-v1",
    synthetic: true,
  },
  challenges: [],
  evidence: [],
  benchmark_progress: [],
  blind_reviews: [],
  decisions: [],
  baselines: [],
  regressions: [],
});

function dependencies() {
  const close = vi.fn(async () => undefined);
  const loadSnapshot = vi.fn(async () => SNAPSHOT);
  const startServer = vi.fn(async () => ({
    origin: "http://127.0.0.1:43117",
    close,
  }));
  return {
    close,
    loadSnapshot,
    startServer,
    value: { loadSnapshot, startServer } satisfies ServeWorkspaceDependencies,
  };
}

function environment(): NodeJS.ProcessEnv {
  return {
    [WORKSPACE_SERVER_ENV.projectionPath]: "/tmp/projection.json",
    [WORKSPACE_SERVER_ENV.staticDirectory]: "/tmp/dist",
    [WORKSPACE_SERVER_ENV.port]: "43117",
  };
}

describe("read-only workspace server process boundary", () => {
  it("projection 검증 뒤에만 loopback server를 시작한다", async () => {
    const deps = dependencies();
    const server = await startWorkspaceFromEnvironment({
      environment: environment(),
      dependencies: deps.value,
    });
    expect(server.origin).toBe("http://127.0.0.1:43117");
    expect(deps.loadSnapshot).toHaveBeenCalledWith("/tmp/projection.json");
    expect(deps.startServer).toHaveBeenCalledWith({
      snapshot: SNAPSHOT,
      staticDirectory: "/tmp/dist",
      port: 43117,
    });
    expect(deps.loadSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      deps.startServer.mock.invocationCallOrder[0],
    );
  });

  it("projection 경로·static 경로·port가 없거나 loader가 실패하면 listener를 열지 않는다", async () => {
    const deps = dependencies();
    await expect(startWorkspaceFromEnvironment({
      environment: {},
      dependencies: deps.value,
    })).rejects.toThrow(/AI_WORKSPACE_PROJECTION_PATH/);
    expect(deps.loadSnapshot).not.toHaveBeenCalled();
    expect(deps.startServer).not.toHaveBeenCalled();

    deps.loadSnapshot.mockRejectedValueOnce(new Error("tampered"));
    await expect(startWorkspaceFromEnvironment({
      environment: environment(),
      dependencies: deps.value,
    })).rejects.toThrow("tampered");
    expect(deps.startServer).not.toHaveBeenCalled();
  });

  it("프로세스 출력은 read-only 경계를 알리고 signal에서 서버만 닫는다", async () => {
    const deps = dependencies();
    const listeners = new Map<string, () => void>();
    const output: string[] = [];
    const errors: string[] = [];
    const runtime = {
      env: environment(),
      exitCode: null as string | number | null,
      stdout: { write: (value: string) => output.push(value) },
      stderr: { write: (value: string) => errors.push(value) },
      on: (event: "SIGINT" | "SIGTERM", listener: () => void) => {
        listeners.set(event, listener);
      },
      removeListener: (event: "SIGINT" | "SIGTERM") => {
        listeners.delete(event);
      },
    };
    await expect(runWorkspaceServerProcess({
      runtime,
      dependencies: deps.value,
    })).resolves.not.toBeNull();
    expect(output.join("")).toContain("READ-ONLY AUTHORITATIVE PROJECTION");
    expect(errors).toEqual([]);
    listeners.get("SIGTERM")?.();
    await vi.waitFor(() => expect(deps.close).toHaveBeenCalledOnce());
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "../App";
import { AppShell } from "../app/AppShell";
import {
  JudgeAccessGate,
  useJudgeSessionActions,
} from "../features/access/JudgeAccessGate";

function authResponse(authenticated: boolean, status = 200): Response {
  return Response.json({ authenticated }, { status });
}

function deferredResponse(): {
  readonly promise: Promise<Response>;
  readonly resolve: (response: Response) => void;
} {
  let resolve!: (response: Response) => void;
  return {
    promise: new Promise<Response>((resolvePromise) => {
      resolve = resolvePromise;
    }),
    resolve,
  };
}

function ExpiryProbe() {
  const session = useJudgeSessionActions();
  return (
    <button type="button" onClick={session?.notifyAuthExpired}>
      Simulate expired session
    </button>
  );
}

describe("Sites 심사위원 접근 게이트", () => {
  beforeEach(() => {
    vi.stubEnv("PROD", true);
    vi.stubEnv("DEV", false);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("production 루트에서 익명 사용자에게 업무 화면 대신 접근 코드를 요청한다", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ authenticated: false }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Enter judge access code" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Decide with evidence" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });

  it("production에서 legacy fixture 경로도 익명 사용자에게 노출하지 않는다", async () => {
    window.history.replaceState({}, "", "/?view=fixture-demo&fixtureView=monitor");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(authResponse(false));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Enter judge access code" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: /Recorded change check/i })).not.toBeInTheDocument();
  });

  it("접근 코드를 제출 즉시 지우고 외부 응답을 기다리는 상태를 알린다", async () => {
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/?view=demo&demoStage=compare");
    const pendingLogin = deferredResponse();
    const storageSetSpy = vi.spyOn(Storage.prototype, "setItem");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(authResponse(false))
      .mockReturnValueOnce(pendingLogin.promise);
    const user = userEvent.setup();

    render(
      <JudgeAccessGate>
        <p>Authenticated workspace</p>
      </JudgeAccessGate>,
    );

    const input = await screen.findByLabelText("Judge access code");
    await user.type(input, "temporary-judge-code");
    await user.click(screen.getByRole("button", { name: "Open judge workspace" }));

    expect(input).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent(/verifying judge access/i);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("button", {
      name: /Verifying judge access/i,
    })).not.toBeInTheDocument();
    expect(window.location.href).not.toContain("temporary-judge-code");
    expect(window.localStorage.getItem("temporary-judge-code")).toBeNull();
    expect(window.sessionStorage.getItem("temporary-judge-code")).toBeNull();
    expect(storageSetSpy.mock.calls.some(([, value]) => (
      String(value).includes("temporary-judge-code")
    ))).toBe(false);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/auth/login",
      expect.objectContaining({
        body: JSON.stringify({ access_code: "temporary-judge-code" }),
        cache: "no-store",
        credentials: "same-origin",
        method: "POST",
      }),
    );

    pendingLogin.resolve(authResponse(true));
    expect(await screen.findByText("Authenticated workspace")).toBeVisible();
    expect(window.location.search).toBe("?view=demo&demoStage=define");
  });

  it("인증 실패 시 서버 세부 내용을 숨기고 같은 일반 오류만 표시한다", async () => {
    vi.unstubAllEnvs();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(authResponse(false))
      .mockResolvedValueOnce(Response.json(
        { error: { code: "RATE_LIMITED", detail: "internal-account-state" } },
        { status: 429 },
      ));
    const user = userEvent.setup();

    render(
      <JudgeAccessGate>
        <p>Authenticated workspace</p>
      </JudgeAccessGate>,
    );

    await user.type(await screen.findByLabelText("Judge access code"), "wrong-code");
    await user.click(screen.getByRole("button", { name: "Open judge workspace" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Judge access could not be verified. Please try again.");
    expect(alert).not.toHaveTextContent("RATE_LIMITED");
    expect(alert).not.toHaveTextContent("internal-account-state");
    expect(screen.getByLabelText("Judge access code")).toHaveValue("");
  });

  it("인증 성공 후 헤더에서 세션을 종료하면 접근 게이트로 복귀한다", async () => {
    vi.unstubAllEnvs();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(authResponse(false))
      .mockResolvedValueOnce(authResponse(true))
      .mockResolvedValueOnce(authResponse(false));
    const user = userEvent.setup();

    render(
      <JudgeAccessGate>
        <AppShell stage="Define" status="LOCKED" readOnly={false}>
          <p>Authenticated workspace</p>
        </AppShell>
      </JudgeAccessGate>,
    );

    await user.type(await screen.findByLabelText("Judge access code"), "valid-code");
    await user.click(screen.getByRole("button", { name: "Open judge workspace" }));
    expect(await screen.findByText("Authenticated workspace")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "End judge session" }));

    expect(await screen.findByRole("heading", { name: "Enter judge access code" })).toBeVisible();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/auth/logout",
        expect.objectContaining({
          cache: "no-store",
          credentials: "same-origin",
          method: "POST",
        }),
      );
    });
  });

  it("보호 API가 401을 알리면 즉시 업무 화면을 닫고 게이트로 복귀한다", async () => {
    vi.unstubAllEnvs();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(authResponse(true));
    const user = userEvent.setup();

    render(
      <JudgeAccessGate>
        <ExpiryProbe />
      </JudgeAccessGate>,
    );

    await user.click(await screen.findByRole("button", { name: "Simulate expired session" }));

    expect(await screen.findByRole("heading", { name: "Enter judge access code" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Simulate expired session" })).not.toBeInTheDocument();
  });

  it("logout 요청이 실패해도 보호된 업무 화면을 계속 노출하지 않는다", async () => {
    vi.unstubAllEnvs();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(authResponse(true))
      .mockRejectedValueOnce(new Error("private-network-detail"));
    const user = userEvent.setup();

    render(
      <JudgeAccessGate>
        <AppShell stage="Define" status="LOCKED" readOnly={false}>
          <p>Authenticated workspace</p>
        </AppShell>
      </JudgeAccessGate>,
    );

    await user.click(await screen.findByRole("button", { name: "End judge session" }));

    expect(await screen.findByRole("heading", { name: "Enter judge access code" })).toBeVisible();
  });

  it("logout 클릭 즉시 보호된 업무 화면을 닫고 세션 폐기 진행 상태를 표시한다", async () => {
    vi.unstubAllEnvs();
    const pendingLogout = deferredResponse();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(authResponse(true))
      .mockReturnValueOnce(pendingLogout.promise);
    const user = userEvent.setup();

    render(
      <JudgeAccessGate>
        <AppShell stage="Define" status="LOCKED" readOnly={false}>
          <p>Authenticated workspace</p>
        </AppShell>
      </JudgeAccessGate>,
    );

    await user.click(await screen.findByRole("button", { name: "End judge session" }));

    expect(screen.queryByText("Authenticated workspace")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/ending judge session/i);

    pendingLogout.resolve(authResponse(false));
    expect(await screen.findByRole("heading", { name: "Enter judge access code" })).toBeVisible();
  });
});

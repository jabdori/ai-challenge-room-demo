import { CircleNotch } from "@phosphor-icons/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  getSession,
  JUDGE_ACCESS_ERROR_MESSAGE,
  login,
  logout,
} from "../../data/sitesDemoApi";

interface JudgeAccessGateProps {
  readonly children: ReactNode;
}

interface JudgeSessionActions {
  readonly ending: boolean;
  readonly endSession: () => Promise<void>;
  readonly notifyAuthExpired: () => void;
}

const JudgeSessionContext = createContext<JudgeSessionActions | null>(null);

function openDemoDefineStage() {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("view", "demo");
  url.searchParams.set("demoStage", "define");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}`,
  );
}

export function useJudgeSessionActions(): JudgeSessionActions | null {
  return useContext(JudgeSessionContext);
}

export function JudgeAccessGate({ children }: JudgeAccessGateProps) {
  const [phase, setPhase] = useState<
    "checking" | "anonymous" | "authenticating" | "authenticated" | "ending"
  >("checking");
  const [accessCode, setAccessCode] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getSession().then(
      (session) => {
        if (active) setPhase(session.authenticated ? "authenticated" : "anonymous");
      },
      () => {
        if (active) {
          setErrorMessage(JUDGE_ACCESS_ERROR_MESSAGE);
          setPhase("anonymous");
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const notifyAuthExpired = useCallback(() => {
    setAccessCode("");
    setErrorMessage(null);
    setPhase("anonymous");
  }, []);

  const endSession = useCallback(async () => {
    setAccessCode("");
    setErrorMessage(null);
    setPhase("ending");
    try {
      await logout();
    } catch {
      // 원격 세션 폐기 실패 여부와 무관하게 보호된 브라우저 화면은 즉시 닫습니다.
    } finally {
      setPhase("anonymous");
    }
  }, []);

  const sessionActions = useMemo<JudgeSessionActions>(() => ({
    ending: phase === "ending",
    endSession,
    notifyAuthExpired,
  }), [endSession, notifyAuthExpired, phase]);

  const submitAccessCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submittedCode = accessCode;
    setAccessCode("");
    setErrorMessage(null);
    setPhase("authenticating");
    try {
      const session = await login(submittedCode);
      if (!session.authenticated) throw new Error(JUDGE_ACCESS_ERROR_MESSAGE);
      openDemoDefineStage();
      setPhase("authenticated");
    } catch {
      setErrorMessage(JUDGE_ACCESS_ERROR_MESSAGE);
      setPhase("anonymous");
    }
  };

  if (phase === "authenticated") {
    return (
      <JudgeSessionContext.Provider value={sessionActions}>
        {children}
      </JudgeSessionContext.Provider>
    );
  }
  if (phase === "checking" || phase === "ending") {
    const ending = phase === "ending";
    return (
      <main className="judge-access-gate">
        <div className="demo-live-progress judge-access-progress" role="status" aria-live="polite">
          <CircleNotch className="demo-live-progress__spinner" aria-hidden="true" />
          <div>
            <strong>{ending ? "ENDING JUDGE SESSION" : "CHECKING JUDGE SESSION"}</strong>
            <span>
              {ending
                ? "Closing the protected workspace…"
                : "Validating the secure demo session…"}
            </span>
          </div>
        </div>
      </main>
    );
  }
  return (
    <main className="judge-access-gate">
      <section className="section-panel judge-access-panel">
        <div className="section-heading">
          <span className="section-kicker">PRIVATE DEMO</span>
          <h1>Enter judge access code</h1>
          <p>Use the private code provided in the Devpost testing instructions.</p>
        </div>
        <form className="judge-access-form" onSubmit={(event) => void submitAccessCode(event)}>
          <label>
            <span className="field-label">Judge access code</span>
            <input
              type="password"
              autoComplete="off"
              autoFocus
              disabled={phase === "authenticating"}
              spellCheck={false}
              value={accessCode}
              onChange={(event) => setAccessCode(event.target.value)}
            />
          </label>
          {errorMessage ? <p className="judge-access-error" role="alert">{errorMessage}</p> : null}
          {phase === "authenticating" ? (
            <div className="demo-live-progress judge-access-progress" role="status" aria-live="polite">
              <CircleNotch className="demo-live-progress__spinner" aria-hidden="true" />
              <div>
                <strong>VERIFYING JUDGE ACCESS</strong>
                <span>Creating a short-lived secure demo session…</span>
              </div>
            </div>
          ) : null}
          {phase !== "authenticating" ? (
            <button
              className="button button--primary button--full"
              type="submit"
              disabled={accessCode.length === 0}
            >
              Open judge workspace
            </button>
          ) : null}
        </form>
      </section>
    </main>
  );
}

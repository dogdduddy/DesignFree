import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import { serverStorage } from "./server-storage";

type Status = {
  initialized: boolean;
  authenticated: boolean;
  username?: string;
};
const SessionContext = createContext<{
  locked: boolean;
  logout: () => Promise<void>;
} | null>(null);
export const useOwnerSession = () => useContext(SessionContext);

export default function AuthGate({ children }: { children: ReactNode }) {
  const bootstrapExpired = useRef(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [opened, setOpened] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => {
    try {
      const response = await fetch("/api/auth/status", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const next = (await response.json()) as Status;
      setStatus(next);
      if (next.authenticated) setOpened(true);
      setError("");
    } catch {
      setError("서버에 연결하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
    }
  };
  useEffect(() => {
    if (!serverStorage) return;
    void refresh();
    const expired = (event: Event) => {
      if ((event as CustomEvent).detail?.bootstrap)
        bootstrapExpired.current = true;
      setStatus((s) => (s ? { ...s, authenticated: false } : s));
    };
    window.addEventListener("draftroom-session-expired", expired);
    return () =>
      window.removeEventListener("draftroom-session-expired", expired);
  }, []);
  if (!serverStorage) return children;
  const logout = async () => {
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error();
      // Clear all in-memory editor/history and pending operations after explicit logout.
      window.location.reload();
    } catch {
      setError("로그아웃에 실패했습니다. 다시 시도하세요.");
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !status) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/auth/${status.initialized ? "login" : "setup"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        },
      );
      if (!response.ok) {
        if (response.status === 409) {
          await refresh();
          throw new Error("이미 소유자가 생성되었습니다. 로그인하세요.");
        }
        throw new Error(
          response.status === 429
            ? "로그인 시도가 많습니다. 잠시 후 다시 시도하세요."
            : "로그인에 실패했습니다. 사용자 이름과 비밀번호를 확인하세요.",
        );
      }
      if (bootstrapExpired.current) {
        window.location.reload();
        return;
      }
      setStatus(await response.json());
      setOpened(true);
      setPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "로그인에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };
  const locked = !status?.authenticated;
  return (
    <SessionContext.Provider value={{ logout, locked }}>
      {opened && <div inert={locked || undefined}>{children}</div>}
      {!locked && error && (
        <p role="alert" className="auth-notice">
          {error}
        </p>
      )}
      {locked && (
        <div className="auth-backdrop">
          <section
            className="auth-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-title"
          >
            <h1 id="auth-title">Draftroom</h1>
            {!status ? (
              <>
                <p>서버 연결 확인 중…</p>
                {error && <p role="alert">{error}</p>}
                <button onClick={() => void refresh()}>연결 재시도</button>
              </>
            ) : (
              <>
                <h2>{status.initialized ? "로그인" : "첫 소유자 설정"}</h2>
                <p>
                  {opened
                    ? "세션이 만료되었습니다. 로그인 후 저장 재시도를 누르세요. 현재 작업은 메모리에 보존됩니다."
                    : status.initialized
                      ? "소유자 계정으로 문서를 여세요."
                      : "이 서버의 문서 라이브러리를 관리할 소유자를 만듭니다."}
                </p>
                <form onSubmit={submit}>
                  <label>
                    사용자 이름
                    <input
                      name="username"
                      autoComplete="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      maxLength={64}
                      required
                      autoFocus
                    />
                  </label>
                  <label>
                    비밀번호
                    <input
                      name="password"
                      type="password"
                      autoComplete={
                        status.initialized ? "current-password" : "new-password"
                      }
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      minLength={12}
                      maxLength={256}
                      required
                    />
                  </label>
                  {!status.initialized && (
                    <p>
                      비밀번호는 12자 이상입니다. 다른 기기에서도 같은 계정으로
                      로그인합니다.
                    </p>
                  )}
                  {error && <p role="alert">{error}</p>}
                  <button type="submit" disabled={busy}>
                    {busy
                      ? "처리 중…"
                      : status.initialized
                        ? "로그인"
                        : "소유자 만들기"}
                  </button>
                </form>
              </>
            )}
          </section>
        </div>
      )}
    </SessionContext.Provider>
  );
}

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

type Session =
  | { required: false; authenticated: true; username?: string }
  | { required: true; authenticated: boolean; username?: string };

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "login"; message?: string }
  | { kind: "app"; required: boolean };

type LoginContextValue = {
  required: boolean;
  logout: () => Promise<void>;
};

const LoginContext = createContext<LoginContextValue>({
  required: false,
  logout: async () => {},
});

export function useLogin(): LoginContextValue {
  return useContext(LoginContext);
}

async function readSession(): Promise<Session> {
  const res = await fetch("/api/session");
  // No session resource and no cookie are the same outcome: ask for login.
  if (res.status === 404 || res.status === 401) {
    return { required: true, authenticated: false };
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return (await res.json()) as Session;
}

/**
 * Shows the username / password form unless this browser already has a
 * valid session cookie. A missing session is not a login, including when
 * the page was opened on localhost.
 */
export default function LoginGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    readSession()
      .then((session) => {
        if (cancelled) return;
        if (!session.required || session.authenticated) {
          setPhase({ kind: "app", required: session.required });
          return;
        }
        setPhase({ kind: "login" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPhase({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function logout(): Promise<void> {
    await fetch("/api/logout", { method: "POST" });
    setPhase({ kind: "login" });
  }

  if (phase.kind === "app") {
    return (
      <LoginContext.Provider value={{ required: phase.required, logout }}>
        {children}
      </LoginContext.Provider>
    );
  }

  return (
    <div className="login-screen">
      {phase.kind === "loading" ? (
        <p className="login-status">正在确认登录状态…</p>
      ) : phase.kind === "error" ? (
        <form
          className="login-card"
          onSubmit={(event) => {
            event.preventDefault();
            setPhase({ kind: "loading" });
            window.location.reload();
          }}
        >
          <h1>Web Cursor</h1>
          <p className="login-error">{phase.message}</p>
          <button type="submit" className="modal-primary">
            重试
          </button>
        </form>
      ) : (
        <LoginForm
          message={phase.message}
          onSuccess={() => setPhase({ kind: "app", required: true })}
          onMessage={(message) => setPhase({ kind: "login", message })}
        />
      )}
    </div>
  );
}

function LoginForm({
  message,
  onSuccess,
  onMessage,
}: {
  message?: string;
  onSuccess: () => void;
  onMessage: (message: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        let text = "用户名或密码不正确";
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) text = body.error;
        } catch {
          /* ignore */
        }
        onMessage(text);
        return;
      }
      onSuccess();
    } catch (err) {
      onMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="login-card" onSubmit={onSubmit}>
      <h1>Web Cursor</h1>
      <p className="login-hint">请输入用户名和密码</p>
      <label className="login-field">
        <span>用户名</span>
        <input
          name="username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
      </label>
      <label className="login-field">
        <span>密码</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </label>
      {message ? <p className="login-error">{message}</p> : null}
      <button type="submit" className="modal-primary" disabled={pending}>
        {pending ? "登录中…" : "登录"}
      </button>
    </form>
  );
}

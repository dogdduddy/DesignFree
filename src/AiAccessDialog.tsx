import { useEffect, useState } from "react";
import { X } from "lucide-react";

type TokenInfo = { id: string; name: string; createdAt: string; lastUsedAt: string | null };

/** Personal access tokens for AI tools (MCP). A token is shown once; the
 * server keeps only its digest. Server mode only. */
export function AiAccessDialog({ onClose }: { onClose: () => void }) {
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `${location.origin}/api/mcp`;
  const plainHttp = location.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const call = async (path: string, init?: RequestInit) => {
    const r = await fetch(path, { credentials: "same-origin", ...init });
    if (r.status === 401) throw new Error("로그인이 만료되었습니다. 새로고침한 뒤 다시 로그인하세요");
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? String(r.status));
    return r.json();
  };
  const load = async () => {
    try {
      setTokens((await call("/api/tokens")).tokens);
    } catch (e) {
      setError(`토큰 목록을 불러오지 못했습니다: ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    void load();
    // The editor's window shortcuts and copy/paste handlers must not act
    // behind the dialog (Delete would remove layers, Cmd+C would replace the
    // copied token with layers). Default actions such as typing still happen.
    const key = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") onClose();
    };
    const clip = (e: Event) => e.stopPropagation();
    window.addEventListener("keydown", key, true);
    for (const type of ["copy", "cut", "paste"]) window.addEventListener(type, clip, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      for (const type of ["copy", "cut", "paste"]) window.removeEventListener(type, clip, true);
    };
  }, []);
  const [copied, setCopied] = useState(false);
  // navigator.clipboard needs a secure context, which a plain-http LAN address is not.
  const copyToken = (value: string) => {
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    setCopied(ok);
  };
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const token = await call("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      setCreated({ name: token.name, token: token.token });
      setName("");
      await load();
    } catch (err) {
      setError(`토큰을 만들지 못했습니다: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (t: TokenInfo) => {
    if (!window.confirm(`"${t.name}" 토큰을 폐기할까요? 이 토큰을 쓰는 AI 도구는 더 이상 접근할 수 없습니다.`)) return;
    try {
      await call(`/api/tokens/${encodeURIComponent(t.id)}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(`폐기하지 못했습니다: ${(err as Error).message}`);
    }
  };
  const token = created?.token ?? "<토큰>";
  const snippets = [
    {
      title: "Claude Code",
      code: `# 셸 기록에 토큰이 남지 않도록 환경 변수로 넘깁니다.\nexport DESIGNFREE_TOKEN="${token}"\nclaude mcp add --transport http designfree ${endpoint} --header "Authorization: Bearer $DESIGNFREE_TOKEN"`,
    },
    {
      title: "Codex (~/.codex/config.toml)",
      code: `[mcp_servers.designfree]\nurl = "${endpoint}"\nbearer_token_env_var = "DESIGNFREE_TOKEN"\n\n# 셸 설정(~/.zshrc)에 추가:\n# export DESIGNFREE_TOKEN="${token}"\n# 데스크톱 앱이 셸 변수를 못 읽으면 대신:\n# http_headers = { "Authorization" = "Bearer ${token}" }`,
    },
    {
      title: "Claude Desktop (claude_desktop_config.json)",
      code: JSON.stringify(
        {
          mcpServers: {
            designfree: {
              command: "npx",
              args: ["-y", "mcp-remote", endpoint, ...(plainHttp ? ["--allow-http"] : []), "--header", "Authorization:${DESIGNFREE_AUTH}"],
              env: { DESIGNFREE_AUTH: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      ),
    },
  ];
  return (
    <div className="ai-access-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ai-access" role="dialog" aria-modal="true" aria-label="AI 도구 연결">
        <div className="ai-access-head">
          <strong>AI 도구 연결 (MCP)</strong>
          <button aria-label="AI 연결 닫기" autoFocus onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <p>
          Claude Code, Claude Desktop, Codex 같은 AI 도구가 이 서버의 디자인을 <b>읽기 전용</b>으로 조회합니다. 조회한 내용은 각
          AI 서비스로 전송됩니다. 토큰은 만들 때 한 번만 표시되며, 서버에는 토큰의 해시만 저장됩니다.
        </p>
        <p className="ai-access-endpoint">
          주소 <code>{endpoint}</code>
        </p>
        {plainHttp && (
          <p className="ai-access-warning">
            http 연결이라 토큰이 같은 네트워크에서 암호화되지 않은 채 전송됩니다. 신뢰할 수 있는 사내 Wi-Fi에서만 쓰세요.
          </p>
        )}
        <form onSubmit={create} className="ai-access-create">
          <input
            aria-label="토큰 이름"
            placeholder="예: 홍길동 Claude Code"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" disabled={!name.trim() || busy}>
            토큰 만들기
          </button>
        </form>
        {error && <p role="alert" className="ai-access-warning">{error}</p>}
        {created && (
          <div className="ai-access-created" data-testid="ai-token-created">
            <p>
              <b>{created.name}</b> 토큰입니다. 지금 복사해 두세요. 이 창을 닫으면 다시 볼 수 없습니다.
            </p>
            <code data-testid="ai-token-value">{created.token}</code>
            <button type="button" onClick={() => copyToken(created.token)}>
              토큰 복사
            </button>
            {copied && <small> 복사했습니다.</small>}
          </div>
        )}
        <div className="ai-access-snippets">
          {snippets.map((s) => (
            <details key={s.title} open={!!created}>
              <summary>{s.title}</summary>
              <pre>{s.code}</pre>
            </details>
          ))}
        </div>
        <div className="ai-access-list">
          <strong>사용 중인 토큰</strong>
          {tokens === null ? (
            <p>불러오는 중…</p>
          ) : tokens.length ? (
            <ul>
              {tokens.map((t) => (
                <li key={t.id} data-testid={`ai-token-${t.id}`}>
                  <span>{t.name}</span>
                  <small>
                    만든 날 {new Date(t.createdAt).toLocaleDateString()} · 마지막 사용{" "}
                    {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "없음"}
                  </small>
                  <button onClick={() => void revoke(t)}>폐기</button>
                </li>
              ))}
            </ul>
          ) : (
            <p>아직 만든 토큰이 없습니다.</p>
          )}
        </div>
      </div>
    </div>
  );
}

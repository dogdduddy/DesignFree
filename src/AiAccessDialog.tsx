import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { bundleFileName, claudeCodeCommand, claudeDesktopBundle, codexCommand, colleagueMessage } from "./mcp-connect";

type TokenInfo = { id: string; name: string; createdAt: string; lastUsedAt: string | null };

/** Personal access tokens for AI tools (MCP). A token is shown once; the
 * server keeps only its digest. Server mode only. */
export function AiAccessDialog({ onClose }: { onClose: () => void }) {
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ id: string; name: string; token: string } | null>(null);
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
  // Key of the last copy and whether it worked.
  const [copied, setCopied] = useState<{ key: string; ok: boolean } | null>(null);
  // navigator.clipboard needs a secure context, which a plain-http LAN address is not.
  const copyText = (key: string, value: string, button: HTMLElement) => {
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    button.focus();
    setCopied({ key, ok });
  };
  const download = (fileName: string, bytes: Uint8Array) => {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      setCreated({ id: token.id, name: token.name, token: token.token });
      setCopied(null);
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
      if (created?.id === t.id) setCreated(null);
      await load();
    } catch (err) {
      setError(`폐기하지 못했습니다: ${(err as Error).message}`);
    }
  };
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
        {created ? (
          <div className="ai-access-created" data-testid="ai-token-created">
            <p>
              <b>{created.name}</b> 토큰입니다. 아래 방법은 이 창을 닫으면 다시 볼 수 없으니 지금 쓰거나 전달하세요.
            </p>
            <code data-testid="ai-token-value">{created.token}</code>
            <CopyButton id="token" label="토큰 복사" copied={copied} onCopy={(b) => copyText("token", created.token, b)} />
            <div className="ai-access-tool">
              <strong>Claude Code</strong>
              <span>터미널에 붙여 넣고 Enter. 모든 폴더에서 쓸 수 있고, 다시 실행하면 새 토큰으로 바뀝니다.</span>
              <details>
                <summary>명령 보기</summary>
                <pre data-testid="ai-command-claude-code">{claudeCodeCommand(endpoint, created.token)}</pre>
              </details>
              <CopyButton id="claude" label="Claude Code 명령 복사" copied={copied} onCopy={(b) => copyText("claude", claudeCodeCommand(endpoint, created.token), b)} />
            </div>
            <div className="ai-access-tool">
              <strong>Codex</strong>
              <span>터미널에 붙여 넣고 Enter. ~/.codex/config.toml에 추가합니다(처음 실행 전 파일은 config.toml.bak으로 보관).</span>
              <details>
                <summary>명령 보기</summary>
                <pre data-testid="ai-command-codex">{codexCommand(endpoint, created.token)}</pre>
              </details>
              <CopyButton id="codex" label="Codex 명령 복사" copied={copied} onCopy={(b) => copyText("codex", codexCommand(endpoint, created.token), b)} />
            </div>
            <div className="ai-access-tool">
              <strong>Claude Desktop</strong>
              <span>내려받은 파일을 더블클릭하고 [설치]를 누릅니다. 터미널이 필요 없습니다.</span>
              <button type="button" onClick={() => download(bundleFileName(created.name), claudeDesktopBundle(endpoint, created.token))}>
                설치 파일 내려받기 ({bundleFileName(created.name)})
              </button>
            </div>
            <div className="ai-access-tool">
              <strong>동료에게 보내기</strong>
              <span>세 가지 방법을 담은 안내문입니다. 메신저에 붙여 넣고, Claude Desktop을 쓰면 설치 파일도 함께 보내세요. 메모 앱 등을 거치면 따옴표가 바뀌어 명령이 깨질 수 있으니 메신저에서 바로 복사하게 하세요.</span>
              <CopyButton id="message" label="안내 메시지 복사" copied={copied} onCopy={(b) => copyText("message", colleagueMessage(endpoint, created.token, created.name), b)} />
            </div>
          </div>
        ) : (
          <p>토큰을 만들면 Claude Code·Codex용 한 줄 명령과 Claude Desktop 설치 파일이 나옵니다. 동료에게 줄 토큰은 동료 이름으로 만들어 전달하세요.</p>
        )}
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

function CopyButton({ id, label, copied, onCopy }: { id: string; label: string; copied: { key: string; ok: boolean } | null; onCopy: (button: HTMLElement) => void }) {
  return (
    <span className="ai-access-copy">
      <button type="button" onClick={(e) => onCopy(e.currentTarget)}>
        {label}
      </button>
      <small aria-live="polite">{copied?.key === id && (copied.ok ? "복사했습니다." : "복사하지 못했습니다. 위 내용을 직접 선택해 복사하세요.")}</small>
    </span>
  );
}

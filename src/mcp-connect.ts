import bridgeSource from "./claude-desktop-bridge.cjs?raw";
import { zipStore } from "./zip";

/** Connection helpers shown after a token is created: one pasteable command
 * per tool and a Claude Desktop bundle, so colleagues need no manual config.
 * Tokens are `dft_` + base64url and endpoints come from location.origin, so
 * neither needs shell quoting beyond plain double/single quotes. */

/** Re-running replaces an earlier registration (e.g. with a new token). A
 * local-scope entry (the earlier instructions made one per folder) would win
 * over the user-scope one, so the current folder's is removed too. */
export function claudeCodeCommand(endpoint: string, token: string) {
  return `claude mcp remove designfree -s local >/dev/null 2>&1; claude mcp remove designfree -s user >/dev/null 2>&1; claude mcp add --scope user --transport http designfree ${endpoint} --header "Authorization: Bearer ${token}"`;
}

/** `codex mcp add` has no header option, so this edits config.toml directly
 * in a subshell (umask 077 and chmod 600: the file holds the token): keeps the first
 * original as .bak, drops earlier [mcp_servers.designfree] tables and their
 * subtables plus trailing blank lines, and appends a fresh table. */
export function codexCommand(endpoint: string, token: string) {
  const header = `^[[:space:]]*\\[[[:space:]]*mcp_servers[[:space:]]*\\.[[:space:]]*"?designfree"?[[:space:]]*[].]`;
  return [
    `(umask 077; f="\${CODEX_HOME:-$HOME/.codex}/config.toml";`,
    `mkdir -p "$(dirname "$f")" && touch "$f" && { [ -e "$f.bak" ] || cp "$f" "$f.bak"; } && cp "$f" "$f.tmp"`,
    `&& awk '/^[[:space:]]*\\[/{skip=($0 ~ /${header}/)} !skip{if($0 ~ /^[[:space:]]*$/){blank=blank $0 "\\n"}else{printf "%s", blank; blank=""; print}}' "$f.tmp" > "$f"`,
    `&& rm "$f.tmp" && chmod 600 "$f"`,
    `&& printf '\\n[mcp_servers.designfree]\\nurl = "%s"\\nhttp_headers = { "Authorization" = "Bearer %s" }\\n' '${endpoint}' '${token}' >> "$f"`,
    `&& echo "Codex에 DesignFree를 연결했습니다.")`,
  ].join(" ");
}

export function bundleFileName(name: string) {
  const slug = name.trim().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
  return `designfree${slug ? `-${slug}` : ""}.mcpb`;
}

/** A Claude Desktop extension (.mcpb: a zip with manifest.json at its root)
 * that runs the stdio bridge with the endpoint and token baked in. The
 * version grows with time so a newer file installs as an update. */
export function claudeDesktopBundle(endpoint: string, token: string, now = new Date()): Uint8Array {
  const manifest = {
    manifest_version: "0.3",
    name: "designfree",
    display_name: "DesignFree",
    version: `1.0.${Math.floor(now.getTime() / 1000)}`,
    description: "사내 DesignFree 서버의 디자인을 읽기 전용으로 조회합니다.",
    author: { name: "DesignFree" },
    server: {
      type: "node",
      entry_point: "server/index.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/index.js"],
        env: { DESIGNFREE_URL: endpoint, DESIGNFREE_TOKEN: token },
      },
    },
    compatibility: { platforms: ["darwin", "win32"], runtimes: { node: ">=18.0.0" } },
  };
  return zipStore(
    [
      { name: "manifest.json", data: `${JSON.stringify(manifest, null, 2)}\n` },
      { name: "server/index.js", data: bridgeSource },
    ],
    now,
  );
}

/** Ready-to-send message for a colleague (contains the token). */
export function colleagueMessage(endpoint: string, token: string, name: string) {
  return [
    `DesignFree AI 연결 안내${name ? ` (${name})` : ""}`,
    "회사 Wi-Fi에 연결된 상태에서, 쓰는 도구 하나만 하면 됩니다.",
    "",
    "■ Claude Code: 터미널에 아래 한 줄을 붙여 넣고 Enter",
    claudeCodeCommand(endpoint, token),
    "",
    "■ Codex: 터미널에 아래 한 줄을 붙여 넣고 Enter",
    codexCommand(endpoint, token),
    "",
    `■ Claude Desktop: 함께 보낸 ${bundleFileName(name)} 파일을 더블클릭하고 [설치]`,
    "",
    "명령은 이 메시지에서 바로 복사하세요(메모 앱을 거치면 따옴표가 바뀌어 동작하지 않을 수 있습니다).",
    "연결한 뒤 도구를 새로 열고 \"DesignFree 문서 목록 보여줘\"라고 물어보세요.",
    "이 메시지에는 개인 토큰이 들어 있습니다. 다른 사람에게 전달하지 마세요.",
  ].join("\n");
}

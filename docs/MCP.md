# AI 도구 연결 (MCP, 읽기 전용)

DesignFree 서버 모드는 [Model Context Protocol](https://modelcontextprotocol.io) 엔드포인트를 제공합니다. Claude Code, Claude Desktop, Codex 같은 AI 도구가 이 서버의 디자인 라이브러리를 **읽기 전용**으로 조회할 수 있습니다. 디자인을 바꾸는 도구는 아직 없습니다.

- 주소: `http://<서버 주소>:4173/api/mcp` (Streamable HTTP, JSON 응답)
- 인증: 개인 토큰 `Authorization: Bearer dft_…`. 브라우저 로그인 쿠키로는 접근할 수 없습니다.
- 브라우저 전용 모드(IndexedDB, `npm run dev`)에는 서버가 없으므로 MCP도 없습니다.

> 조회한 디자인 내용은 각자의 AI 서비스(Anthropic, OpenAI 등)로 전송됩니다. 회사 정책상 허용되는 자료인지 먼저 확인하세요.

## 1. 토큰 만들기

1. 편집기 헤더의 **AI 연결**을 누릅니다(서버 모드에서 로그인한 상태).
2. 토큰 이름(예: `홍길동 Claude Code`)을 입력하고 **토큰 만들기**를 누릅니다.
3. 표시된 `dft_…` 토큰을 바로 복사합니다. 창을 닫으면 다시 볼 수 없습니다. 서버에는 해시만 저장됩니다.
4. 창 아래에 도구별 설정 예시가 토큰이 채워진 채로 나옵니다.

사람마다, 도구마다 토큰을 따로 만들면 하나만 폐기할 수 있습니다. 같은 창의 **폐기**로 즉시 막을 수 있고, 마지막 사용 시각도 확인할 수 있습니다. 활성 토큰은 최대 50개입니다.

## 2. 도구별 연결

아래 `http://192.168.0.10:4173`은 예시입니다. 실제 서버 주소로 바꾸세요.

### Claude Code

```sh
export DESIGNFREE_TOKEN="dft_…"
claude mcp add --transport http designfree http://192.168.0.10:4173/api/mcp --header "Authorization: Bearer $DESIGNFREE_TOKEN"
```

토큰을 명령에 직접 쓰면 셸 기록에 남으므로 환경 변수로 넘깁니다. 등록된 설정(`~/.claude.json`)에는 토큰이 저장됩니다.

`claude mcp list` 또는 Claude Code 안의 `/mcp`로 연결 상태를 확인합니다. 프로젝트 전체가 쓰게 하려면 `.mcp.json`에 넣고 토큰은 환경 변수로 둡니다.

```json
{
  "mcpServers": {
    "designfree": {
      "type": "http",
      "url": "http://192.168.0.10:4173/api/mcp",
      "headers": { "Authorization": "Bearer ${DESIGNFREE_TOKEN}" }
    }
  }
}
```

### Codex (CLI, IDE 확장, ChatGPT 데스크톱 앱)

`~/.codex/config.toml`:

```toml
[mcp_servers.designfree]
url = "http://192.168.0.10:4173/api/mcp"
bearer_token_env_var = "DESIGNFREE_TOKEN"
```

셸 설정(`~/.zshrc`)에 `export DESIGNFREE_TOKEN="dft_…"`를 추가하고 새 터미널에서 실행합니다. 데스크톱 앱이 셸 환경 변수를 읽지 못하면 `bearer_token_env_var` 대신 `http_headers = { "Authorization" = "Bearer dft_…" }`를 씁니다. 이 경우 토큰이 설정 파일에 평문으로 남습니다.

### Claude Desktop

Claude Desktop의 "커스텀 커넥터"는 Anthropic 클라우드에서 서버로 접속하므로, 공개 인터넷에 없는 사내 서버에는 연결되지 않습니다. 대신 내 컴퓨터에서 중계하는 로컬 설정을 씁니다(Node.js 18 이상 필요).

**설정 → 개발자 → 설정 편집**으로 `claude_desktop_config.json`을 열고 추가합니다.

```json
{
  "mcpServers": {
    "designfree": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://192.168.0.10:4173/api/mcp", "--allow-http", "--header", "Authorization:${DESIGNFREE_AUTH}"],
      "env": { "DESIGNFREE_AUTH": "Bearer dft_…" }
    }
  }
}
```

저장한 뒤 Claude Desktop을 완전히 종료했다가 다시 엽니다. `--allow-http`는 https가 아닌 사내 주소에만 필요합니다. `npx -y mcp-remote`는 실행할 때마다 npm에서 최신 버전을 받아 실행합니다. 회사 정책상 고정이 필요하면 `mcp-remote@<버전>`으로 지정하세요. 이 중계 방식은 DesignFree 쪽에서 자동 검증하지 못했습니다(아래 제한 참고). 이 설정은 Claude Desktop 앱에서만 동작하고 claude.ai 웹·모바일에서는 쓸 수 없습니다.

## 3. 제공 도구

| 도구 | 내용 |
|---|---|
| `list_documents` | 문서, 페이지, 화면(최상위 프레임), 레이어 수. 여기서 id를 얻습니다. |
| `get_outline` | 페이지·레이어의 트리(이름, 종류, 위치·크기, 텍스트 일부, 레이아웃, 컴포넌트, 프로토타입 연결). `maxDepth`, `maxNodes`로 크기 제한 |
| `get_nodes` | 레이어 최대 50개의 전체 속성, 경로, 화면 좌표, 스타일 적용 후 값 |
| `search_layers` | 이름·텍스트 내용 검색(전체 또는 문서 하나, 종류 필터) |
| `get_text_content` | 페이지·화면의 모든 텍스트와 글꼴(문구 검토·번역용) |
| `get_styles` | 스타일·토큰·테마, 사용 중인 레이어 수, 공유 라이브러리 |
| `get_components` | 메인 컴포넌트, variant 속성, 인스턴스 |
| `get_prototype` | 화면, 시작 화면, 클릭 연결 |
| `export_svg` | 페이지·화면·레이어를 SVG로. 이미지는 기본적으로 자리표시 이미지로 바꾸고, `includeImages: true`면 원본 PNG 포함 |

예시 질문: "DesignFree에서 로그인 화면의 텍스트를 모두 보여줘", "설정 화면에 쓰인 색 토큰을 정리해줘", "홈 화면을 SVG로 받아서 React 컴포넌트로 만들어줘".

## 4. 제한

- 읽기 전용입니다. 쓰기 도구는 실시간 협업 이후에 추가할 예정입니다.
- 서버에는 브라우저 폰트 측정이 없어, 자동 크기 텍스트와 그 영향을 받는 Flex/Grid 위치는 근사값입니다. 저장된 속성 값은 정확합니다.
- 응답이 20만 자를 넘으면 잘립니다. `maxNodes`, `nodeId`, `limit`으로 범위를 좁히세요.
- http로 쓰면 토큰이 같은 네트워크에서 암호화되지 않습니다. 신뢰할 수 있는 사내망에서만 쓰고, 노출이 의심되면 바로 폐기하세요.
- 서버가 소유자 계정 하나로 동작하는 동안에는 토큰도 그 라이브러리 전체를 읽습니다. 사용자별 권한은 다중 사용자 단계에서 추가합니다.
- 토큰에는 만료일이 없습니다. 쓰지 않는 토큰은 폐기하세요.
- 토큰이 틀렸거나 폐기됐으면 일부 도구는 OAuth 로그인을 시도하다 "인증 필요"로 표시합니다. 이 서버에는 OAuth가 없으니 토큰을 다시 확인하세요.
- 검증 범위: 공식 MCP TypeScript SDK 클라이언트(1.32.2)로 연결·도구 호출을 확인했습니다. Claude Code, Codex, Claude Desktop(`mcp-remote`) 실제 연결은 사용 환경에서 확인이 필요합니다. 오래된 Codex 버전은 HTTP MCP에 rmcp 클라이언트 설정이 필요할 수 있습니다.

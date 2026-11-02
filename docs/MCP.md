# AI 도구 연결 (MCP, 읽기 전용)

DesignFree 서버 모드는 [Model Context Protocol](https://modelcontextprotocol.io) 엔드포인트를 제공합니다. Claude Code, Claude Desktop, Codex 같은 AI 도구가 이 서버의 디자인 라이브러리를 **읽기 전용**으로 조회할 수 있습니다. 디자인을 바꾸는 도구는 아직 없습니다.

- 주소: `http://<서버 주소>:4173/api/mcp` (Streamable HTTP, JSON 응답)
- 인증: 개인 토큰 `Authorization: Bearer dft_…`. 브라우저 로그인 쿠키로는 접근할 수 없습니다.
- 브라우저 전용 모드(IndexedDB, `npm run dev`)에는 서버가 없으므로 MCP도 없습니다.

> 조회한 디자인 내용은 각자의 AI 서비스(Anthropic, OpenAI 등)로 전송됩니다. 회사 정책상 허용되는 자료인지 먼저 확인하세요.

## 1. 연결하기 (권장: 한 번에)

1. 편집기 헤더의 **AI 연결**을 누릅니다(서버 모드에서 로그인한 상태).
2. 토큰 이름(예: `홍길동 Claude Code`)을 입력하고 **토큰 만들기**를 누릅니다.
3. 쓰는 도구에 맞게 하나를 고릅니다. 이 창을 닫으면 토큰과 명령을 다시 볼 수 없습니다. 서버에는 토큰의 해시만 저장됩니다.

| 도구 | 하는 일 |
|---|---|
| Claude Code | **Claude Code 명령 복사** → 터미널에 붙여 넣고 Enter. 모든 폴더에서 쓸 수 있게(`--scope user`) 등록됩니다. 다시 실행하면 새 토큰으로 바뀝니다. |
| Codex (CLI, IDE 확장, 데스크톱 앱) | **Codex 명령 복사** → 터미널에 붙여 넣고 Enter. `~/.codex/config.toml`(또는 `$CODEX_HOME`)에 `[mcp_servers.designfree]`를 추가합니다. 처음 실행하기 전 파일은 `config.toml.bak`으로 남기고, 예전 designfree 설정은 바꿔 씁니다. |
| Claude Desktop | **설치 파일 내려받기** → 받은 `designfree-이름.mcpb`를 더블클릭하고 [설치]. 터미널이 필요 없습니다. |

동료에게 연결해 줄 때는 동료 이름으로 토큰을 만들고 **안내 메시지 복사**를 눌러 메신저에 붙여 넣습니다. 세 도구의 방법이 모두 들어 있고, Claude Desktop을 쓰는 동료에게는 내려받은 설치 파일도 함께 보냅니다. 메시지와 설치 파일에는 토큰이 들어 있으니 그 사람에게만 보내세요. 지금은 소유자 계정만 로그인할 수 있어서 동료가 직접 토큰을 만들 수는 없습니다(사용자별 계정은 다중 사용자 단계).

연결한 뒤 도구를 새로 열고 "DesignFree 문서 목록 보여줘"라고 물어보면 됩니다. Claude Code는 `claude mcp list`에서 `designfree … ✔ Connected`로 확인할 수 있습니다.

알아 둘 점:

- 명령은 메신저에서 바로 복사해 붙여 넣으세요. 메모·메일 앱을 거치면 따옴표가 둥근 따옴표로 바뀌어 명령이 동작하지 않습니다.
- 명령에 토큰이 들어 있으므로 셸 기록(`~/.zsh_history`)에도 남습니다. 각 도구의 설정 파일에도 토큰이 저장됩니다. 노출이 의심되면 토큰을 폐기하고 새로 연결하세요.
- 예전 안내대로 범위 없이 `claude mcp add …`를 실행했던 폴더에는 그 폴더 전용 등록이 남아 있을 수 있고, 그 폴더에서는 그 등록이 우선합니다. 새 명령은 지금 폴더의 것만 지웁니다. 특정 폴더에서만 인증 오류가 나면 그 폴더에서 `claude mcp remove designfree -s local`을 실행하세요.

사람마다, 도구마다 토큰을 따로 만들면 하나만 폐기할 수 있습니다. 같은 창의 **폐기**로 즉시 막을 수 있고, 마지막 사용 시각도 확인할 수 있습니다. 활성 토큰은 최대 50개입니다.

### Claude Desktop 설치 파일에 대해

- Claude Desktop의 "커스텀 커넥터"는 Anthropic 클라우드에서 서버로 접속하므로 공개 인터넷에 없는 사내 서버에는 닿지 않습니다. 그래서 내 컴퓨터에서 실행되는 데스크톱 확장(MCPB)으로 연결합니다.
- 파일 안에는 `manifest.json`과 의존성 없는 작은 중계 프로그램(`server/index.js`)만 있습니다. Claude Desktop에 내장된 Node.js가 이 프로그램을 실행하고, 요청을 토큰과 함께 DesignFree 서버로 그대로 전달합니다. 외부 패키지를 내려받지 않습니다.
- 서버 주소와 토큰이 파일과 설치된 확장 폴더에 평문으로 들어 있습니다. 동료가 토큰을 직접 입력하지 않아도 되도록 고른 방식입니다. 토큰을 폐기하면 이 확장도 즉시 막히고, 새 토큰으로 받은 파일을 다시 설치하면 바뀝니다.
- 설치한 확장은 Claude Desktop **설정 → 확장 프로그램**에서 끄거나 지울 수 있습니다. 이 설정은 Claude Desktop 앱에서만 동작하고 claude.ai 웹·모바일에서는 쓸 수 없습니다.

## 2. 직접 설정하기 (참고)

명령을 쓰지 않고 설정 파일을 직접 고치려면 아래처럼 합니다. `http://192.168.0.10:4173`은 예시이니 실제 서버 주소로 바꾸세요.

**Claude Code** (`.mcp.json`으로 프로젝트에 공유하고 토큰은 환경 변수로 둘 때)

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

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.designfree]
url = "http://192.168.0.10:4173/api/mcp"
http_headers = { "Authorization" = "Bearer dft_…" }
```

토큰을 파일에 두지 않으려면 `http_headers` 대신 `bearer_token_env_var = "DESIGNFREE_TOKEN"`을 쓰고 셸 설정에 `export DESIGNFREE_TOKEN="dft_…"`를 넣습니다. 데스크톱 앱은 셸 환경 변수를 읽지 못할 수 있습니다.

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
- 검증 범위: 공식 MCP TypeScript SDK 클라이언트(1.32.2)와 실제 Claude Code에서 연결·도구 호출을 확인했습니다. Codex는 생성된 설정을 `codex mcp list`가 Bearer 인증 HTTP 서버로 읽는 것까지, Claude Desktop 설치 파일은 그 안의 중계 프로그램이 서버와 통신하는 것까지 확인했습니다. Claude Desktop에 실제로 설치하는 과정은 사용 환경에서 확인이 필요합니다. 오래된 Codex 버전은 HTTP MCP에 rmcp 클라이언트 설정이 필요할 수 있습니다. 직접 고친 Codex 설정에서 designfree를 인라인 표(`[mcp_servers]` 아래 `designfree = {…}`)나 작은따옴표 키(`[mcp_servers.'designfree']`)로 적어 두었다면 명령이 그 줄을 지우지 못해 중복 정의가 생기니, 그 줄을 먼저 지우세요.

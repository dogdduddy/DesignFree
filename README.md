# DesignFree

Figma-style open-source design editor for personal Docker hosting. The UI currently uses the Draftroom name. React/TypeScript with SVG and CanvasKit rendering, absolute/Flex/Grid layout subsets, component instances/variants, shared styles/tokens/themes and SVG import into editable vector paths. MIT licensed; no Figma code or assets are included.

## 처음 설치하는 분: Mac 복사·붙여넣기

Homebrew·Git·Node·Docker가 없어도 아래 명령으로 시작할 수 있습니다. **Mac에서 ⌘ + Space → `터미널` 검색 → 실행**한 뒤 전체 블록을 한 번에 붙여넣으세요. 이 명령은 필요한 도구를 설치하고 셸 환경을 설정하며 공개 저장소를 복제해 앱을 실행합니다.

```sh
/bin/bash <<'DESIGNFREE_INSTALL'
set -e
installer_file="$(mktemp -t designfree-install)"
trap 'rm -f "$installer_file"' EXIT
curl --fail --show-error --silent --location --retry 3 \
  https://raw.githubusercontent.com/dogdduddy/DesignFree/main/scripts/bootstrap-macos.sh \
  -o "$installer_file"
/bin/bash "$installer_file" </dev/tty
DESIGNFREE_INSTALL
```

설치 중 **Mac 로그인 암호·Return 입력, Apple 개발 도구 설치창, Docker 최초 약관/권한 화면**은 직접 처리해야 합니다. 암호는 입력해도 화면에 표시되지 않는 것이 정상입니다. 약관은 직접 읽고 동의하는 경우에만 진행하세요. 스크립트가 설치 완료를 기다린 후 다음 단계로 이어갑니다.

기본 설치 위치는 `~/Projects/DesignFree`입니다. 완료되면 **http://127.0.0.1:4173/** 에서 새 소유자 계정을 만드세요. 기존 폴더·작업·비밀번호는 덮어쓰지 않습니다. 처음부터 Docker/개발 도구를 설치하므로 시간이 걸릴 수 있습니다.

**[처음부터 따라 하는 Mac 설치 안내](docs/INSTALL_MACOS.md)** 에 다시 실행·중지·문제 해결·Codex 사용 방법을 정리했습니다. Windows/Linux용 자동 설치는 아직 제공하지 않습니다.

## 도구가 이미 설치된 환경에서 실행

Install Docker with Compose v2 and Node.js **26** (tested version pinned in `.nvmrc` and `.node-version`). This GitHub repository is public; cloning does not require copying any GitHub credentials.

```sh
git clone https://github.com/dogdduddy/DesignFree.git
cd DesignFree
npm run setup
npm run start:docker
```

Open **http://127.0.0.1:4173/** and create your own owner account on first launch. No account or default owner password is copied. Setup creates an ignored `.env` with a random database password without displaying it; rerunning preserves it. Docker installs dependencies inside the images, so host `npm ci` is unnecessary for this route. Editing `.env` does not rotate credentials on an existing PostgreSQL volume.

Only the editor is published on loopback. API/PostgreSQL stay private. Documents and images use named volumes. `npm run stop:docker` keeps them; **do not use `down -v` for a valuable installation**. A fresh clone starts empty because private documents, accounts, backups and uploads are excluded. Transfer selected designs yourself using JSON export/import.

## Develop and test

```sh
npm ci
npm run doctor
npm test
npm run build
npx playwright install chromium
npm run dev
```

Development opens **http://127.0.0.1:5173/** using browser-only storage. In a second terminal, run `npm run test:browser`. Tests use bundled Chromium across macOS/Linux/Windows; `CHROME_EXECUTABLE` intentionally overrides it, and `PLAYWRIGHT_CHANNEL` selects a browser channel. Linux may need `npx playwright install --with-deps chromium` with administrator privileges for system packages.

Docker builds use authenticated PostgreSQL storage. For server development set PG environment variables or `DATABASE_URL`, start `npm run api`, and start Vite with `VITE_DRAFTROOM_STORAGE=server`. Vite proxies `/api` to loopback:3000. Storage modes have separate libraries; switching never silently uploads or clears browser drafts.

Run `npm run test:privacy` before committing. Generated screenshots/reports/downloads belong in ignored `test-results/`. Authenticated fixture suites need an explicitly selected **disposable** instance; see [testing](docs/TESTING.md).

## Continue with Codex

Open this repository folder in your installed Codex app/CLI and sign in separately. Suggested first prompt:

> Read AGENTS.md and docs/CODEX_HANDOFF.md. Check the repository and environment, then continue the requested task. Do not enable autopilot or publish further changes unless requested.

`AGENTS.md`, architecture notes and test commands travel with the code. `.codex/config.toml` contains only requested `gpt-6.1-sol` / `medium` defaults; project configuration applies after repository trust. No Codex login, API token, global configuration, private memory/vault, old chats or scheduled automations are included. The product requires no OpenAI API key.

- [Architecture and continuation](docs/CODEX_HANDOFF.md)
- [Detailed behavior](docs/FEATURES.md)
- [Testing](docs/TESTING.md)
- [Privacy boundary](docs/PRIVACY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

This is a prototype: live collaboration, general Figma import, advanced prototyping, physical IME and cross-platform verification need further work. Read feature limitations before assuming Figma equivalence.

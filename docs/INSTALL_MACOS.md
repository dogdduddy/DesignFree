# Mac에서 처음 설치하기

터미널이나 Homebrew를 처음 쓰는 사용자를 위한 안내입니다. macOS 전용이며 기본 zsh/bash 터미널을 사용합니다. Homebrew와 Docker가 지원하는 macOS 및 관리자 암호, 인터넷 연결이 필요합니다. 실제 제품 검증은 Apple Silicon Mac 기준이며 Intel Mac 전체 설치는 미검증입니다.

## 1. 터미널 열기

⌘ + Space를 누르고 `터미널`을 검색해 Return을 누르세요. 설치 명령 앞에 `sudo`를 붙이지 마세요. 암호가 필요하면 공식 설치 도구가 따로 요청합니다.

## 2. 아래 전체 블록 한 번 붙여넣기

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

Git이 없어도 Mac에 기본으로 있는 curl과 Bash로 시작합니다. 스크립트는 다음 순서로 진행합니다.

1. Apple Command Line Tools가 없으면 설치창을 열고 완료를 기다립니다.
2. Homebrew가 없으면 공식 설치 도구를 실행합니다. PATH를 zsh의 `.zprofile` 또는 bash의 `.bash_profile`에 추가합니다.
3. Homebrew로 Git을 설치합니다.
4. 공개 저장소를 `~/Projects/DesignFree`에 복제합니다. GitHub 로그인·토큰은 필요하지 않습니다.
5. nvm을 준비하고 저장소 `.nvmrc`에 지정된 Node.js를 설치·선택합니다.
6. Docker Desktop이 없으면 설치하고 실행합니다. 직접 약관·권한 화면을 처리하면 준비 완료까지 기다립니다.
7. 새 로컬 DB 비밀번호를 `.env`에 생성하고 Docker 서비스를 빌드·실행합니다. 비밀번호는 출력하지 않습니다.
8. 앱의 로컬 API 응답을 확인하고 브라우저를 엽니다.

Apple 개발 도구는 최대 1시간, Docker 시작은 최대 10분 기다린 후 멈추면 원인을 안내합니다. 네트워크/권한 오류가 나면 화면 안내를 먼저 해결하고 같은 명령을 다시 실행하세요. 설치 도중에는 터미널을 닫지 마세요. 중단하려면 Control + C를 누릅니다.

## 3. 설치 중 직접 해야 하는 일

- `Password:`: 이 Mac에 로그인할 때 쓰는 암호입니다. 타이핑해도 글자·별표가 보이지 않습니다. 입력 후 Return을 누르세요. 암호를 채팅에 보내지 마세요.
- Homebrew가 계속 진행할지 물으면 안내를 확인하고 Return을 누르세요.
- Apple 개발 도구 창에서 설치를 완료하세요.
- Docker 창에서 약관을 읽고 동의하는 경우 진행한 뒤 Docker가 시작되게 하세요. 스크립트는 약관을 대신 수락하지 않습니다.

[Homebrew 공식 설치](https://docs.brew.sh/Installation.html), [Docker Desktop 공식 설치](https://docs.docker.com/desktop/setup/install/mac-install/), [nvm 공식 설치](https://github.com/nvm-sh/nvm/blob/v0.40.8/README.md)를 사용합니다. Docker Desktop 사용 조건은 해당 공식 문서를 확인하세요.

## 4. 앱 시작

설치가 끝나면 http://127.0.0.1:4173/ 을 엽니다. 화면에서 **새 사용자 이름과 비밀번호**로 소유자를 만드세요. GitHub/Codex/Mac 계정과 별개인 이 설치의 계정입니다. 기존 사용자의 계정·설계 파일은 포함되지 않습니다.

## 5. 나중에 시작하거나 중지하기

설치 완료 후에는 **터미널을 새로 열고** 아래 블록을 사용하세요. nvm을 명시적으로 불러오므로 기존 Node 기본 버전을 바꾸지 않아도 됩니다.

다시 시작(이미 설치된 도구와 폴더를 재사용하고 로컬 Docker가 준비될 때까지 기다림):

```sh
/bin/bash "$HOME/Projects/DesignFree/scripts/bootstrap-macos.sh"
```

중지(문서 데이터는 유지하고, 로컬 Docker 컨텍스트와 폴더 소유권을 확인):

```sh
/bin/bash <<'DESIGNFREE_STOP'
set -e
cd "$HOME/Projects/DesignFree"
. ./scripts/bootstrap-macos.sh
export PATH="/Applications/Docker.app/Contents/Resources/bin:$HOME/Applications/Docker.app/Contents/Resources/bin:$HOME/.docker/bin:$PATH"
unset DOCKER_HOST DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export DOCKER_CONTEXT=desktop-linux
if ! desktop_ready; then
  printf 'Docker Desktop이 실행 중인지 확인하세요. 원격 엔진에는 연결하지 않습니다.\n' >&2
  exit 1
fi
check_compose_ownership "$(pwd -P)"
docker compose -p designfree down
DESIGNFREE_STOP
```

`docker compose down -v`는 데이터 볼륨까지 지우므로 중지 용도로 사용하지 마세요. 데이터는 별도 백업이 필요합니다.

## 6. Codex로 개발하기

Codex가 아예 없다면, 아래 블록으로 **Codex CLI 설치와 실행**까지 할 수 있습니다. 이미 앱을 사용한다면 이 블록은 생략하고 앱에서 설치 폴더를 열어도 됩니다.

```sh
cd "$HOME/Projects/DesignFree"
. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" --no-use
nvm use
npm install -g @openai/codex
codex
```

처음 실행하면 본인 계정으로 로그인하고 저장소 신뢰/권한 안내를 직접 확인하세요. 다른 사람의 로그인 정보는 복사하지 않습니다. nvm의 사용자 디렉터리에 설치하므로 이 npm 명령에 sudo를 붙이지 마세요. [공식 Codex CLI 안내](https://learn.chatgpt.com/docs/codex/cli)를 참고할 수 있습니다.

Codex에서 `~/Projects/DesignFree` 폴더를 열고 다음을 요청하면 됩니다.

> AGENTS.md와 docs/CODEX_HANDOFF.md를 읽고 환경을 확인해 줘. 요청하지 않은 자동 진행이나 공개 업로드는 하지 마.

개발 의존성·브라우저 테스트가 필요하면 새 터미널에서:

```sh
cd "$HOME/Projects/DesignFree"
. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" --no-use
nvm use
npm ci
npx playwright install chromium
npm run doctor
```

제품 사용에는 OpenAI API 키가 필요하지 않습니다. Codex 계정 설정·토큰·개인 메모는 복사하지 않습니다.

## 이미 뭔가 설치되어 있거나 오류가 날 때

- 설치된 Homebrew/nvm/Docker를 재사용합니다. 기존 Node 기본 alias와 Git 이름/이메일을 바꾸지 않습니다.
- 같은 폴더에 다른 파일/저장소가 있으면 멈추며 삭제·덮어쓰지 않습니다. 다른 경로를 쓸 때는 스크립트를 내려받아 `/bin/bash bootstrap-macos.sh "다른 경로"`로 실행하세요.
- 기존 DesignFree 폴더는 코드 그대로 사용합니다. 자동 pull/reset을 하지 않으므로 업데이트는 별도 작업입니다.
- 다른 폴더의 designfree 컨테이너가 있거나, 남아 있는 DB 볼륨에 필요한 `.env`가 없으면 멈춥니다. 기존 설치/비밀번호를 먼저 복구하세요. 데이터 볼륨을 임의로 지우지 마세요.
- 다른 앱이4173 포트를 사용하면 자동으로 종료하지 않습니다. 설치 폴더 `.env`의 DRAFTROOM_PORT를 다른 미사용 포트로 바꾸고 실행하세요.
- 원격 Docker 엔진에는 배포하지 않습니다. 로컬 Docker Desktop 컨텍스트와 loopback 바인딩만 사용합니다.
- 셸 설정 파일이 심볼릭 링크이거나 특수한 셸이면 자동 수정을 멈출 수 있습니다. 공식 도구 안내에 따라 PATH/nvm을 설정하세요.

검증 범위: 셸 문법, 설치 없이 실행하는 도움말, 임시 파일/저장소와 모의 명령을 이용한 재실행·보존·로컬 Docker 검사. 완전히 빈 Mac에서 시스템 도구를 실제로 설치하는 전체 과정은 아직 실행하지 않았습니다.

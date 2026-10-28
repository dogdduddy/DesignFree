#!/bin/bash
# First-time macOS setup. Run as your normal user, never with sudo.
# Downloads only the official Homebrew/nvm installers and this public repository.
set -eo pipefail

DESIGNFREE_REPOSITORY='https://github.com/dogdduddy/DesignFree.git'
DESIGNFREE_NVM_VERSION='v0.40.8'

say() { printf '\n[DesignFree] %s\n' "$*"; }
fail() { printf '\n[DesignFree] %s\n' "$*" >&2; return 1; }

usage() {
  cat <<'TEXT'
사용법: /bin/bash bootstrap-macos.sh [설치할 폴더]
기본 폴더: ~/Projects/DesignFree

macOS의 일반 사용자 터미널에서 실행하세요. sudo로 전체 스크립트를 실행하지 마세요.
Homebrew/Git/nvm/고정 Node/Docker Desktop을 준비하고 공개 저장소를 복제·실행합니다.
Mac 암호, 개발 도구 설치창, Docker 최초 약관 화면은 직접 처리해야 합니다.
기존 프로젝트나 비밀번호는 덮어쓰지 않으며, Git 이름/이메일과 Codex 로그인은 설정하지 않습니다.
--help 는 설치나 파일 변경 없이 이 안내만 표시합니다.
TEXT
}

append_brew_profile() {
  local profile_file="$1" brew_binary="$2" marker='# DesignFree: Homebrew PATH'
  if [ -L "$profile_file" ]; then
    fail '셸 설정 파일이 심볼릭 링크입니다. 자동으로 수정하지 않습니다. Homebrew PATH를 직접 설정한 뒤 다시 실행하세요.'
    return 1
  fi
  touch "$profile_file"
  if ! grep -Fq "$marker" "$profile_file"; then
    printf '\n%s\neval "$(%s shellenv)"\n' "$marker" "$(printf '%q' "$brew_binary")" >> "$profile_file"
  fi
}

ensure_clt() {
  if xcode-select -p >/dev/null 2>&1 && xcrun --find clang >/dev/null 2>&1; then return; fi
  say 'Apple 개발 도구 설치창에서 설치를 완료하세요. 완료될 때까지 기다립니다.'
  xcode-select --install >/dev/null 2>&1 || true
  local elapsed=0
  until xcode-select -p >/dev/null 2>&1 && xcrun --find clang >/dev/null 2>&1; do
    if [ "$elapsed" -ge 3600 ]; then
      fail '개발 도구 설치 대기가 끝났습니다. 설치를 완료하고 같은 명령을 다시 실행하세요.'
      return 1
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
}

ensure_brew() {
  local downloaded="$1/homebrew-install.sh"
  if command -v brew >/dev/null 2>&1; then
    DESIGNFREE_BREW="$(command -v brew)"
  elif [ -x /opt/homebrew/bin/brew ]; then
    DESIGNFREE_BREW=/opt/homebrew/bin/brew
  elif [ -x /usr/local/bin/brew ]; then
    DESIGNFREE_BREW=/usr/local/bin/brew
  else
    say 'Homebrew 공식 설치를 시작합니다. 요청되면 Mac 로그인 암호를 입력하고 Return을 누르세요.'
    curl --fail --show-error --silent --location --retry 3 \
      https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$downloaded"
    /bin/bash "$downloaded" </dev/tty
    if [ -x /opt/homebrew/bin/brew ]; then DESIGNFREE_BREW=/opt/homebrew/bin/brew
    elif [ -x /usr/local/bin/brew ]; then DESIGNFREE_BREW=/usr/local/bin/brew
    else fail 'Homebrew 설치를 확인할 수 없습니다. 설치 출력의 안내를 확인하세요.'; return 1; fi
  fi
  eval "$("$DESIGNFREE_BREW" shellenv)"
  append_brew_profile "$DESIGNFREE_PROFILE" "$DESIGNFREE_BREW"
  if ! "$DESIGNFREE_BREW" list --formula git >/dev/null 2>&1; then
    say 'Git을 설치합니다.'
    "$DESIGNFREE_BREW" install git
  fi
  hash -r
}

prepare_checkout() {
  local destination="$1" origin top
  if [ -L "$destination" ]; then fail '설치 폴더가 심볼릭 링크입니다. 다른 설치 폴더를 지정하세요.'; return 1; fi
  if [ -e "$destination" ]; then
    if [ ! -d "$destination" ]; then fail '설치 경로에 다른 파일이 있습니다. 덮어쓰지 않습니다.'; return 1; fi
    top="$(git -C "$destination" rev-parse --show-toplevel 2>/dev/null)" || {
      fail '설치 폴더가 이미 있지만 DesignFree 저장소가 아닙니다. 폴더를 지우지 말고 다른 경로를 지정하세요.'; return 1;
    }
    if [ "$(cd "$destination" && pwd -P)" != "$(cd "$top" && pwd -P)" ]; then
      fail '설치 폴더가 다른 저장소 안에 있습니다. 덮어쓰지 않습니다.'; return 1
    fi
    origin="$(git -C "$destination" remote get-url origin 2>/dev/null)" || {
      fail '기존 폴더의 원격 저장소를 확인할 수 없습니다. 덮어쓰지 않습니다.'; return 1;
    }
    case "$origin" in
      https://github.com/dogdduddy/DesignFree|https://github.com/dogdduddy/DesignFree.git|git@github.com:dogdduddy/DesignFree.git|ssh://git@github.com/dogdduddy/DesignFree.git) ;;
      *) fail '기존 폴더는 다른 원격 저장소입니다. 덮어쓰지 않습니다.'; return 1 ;;
    esac
    say '기존 DesignFree 코드를 그대로 사용합니다. 자동 pull/reset은 하지 않습니다.'
  else
    mkdir -p "$(dirname "$destination")"
    say '공개 DesignFree 저장소를 복제합니다. GitHub 로그인은 필요하지 않습니다.'
    git clone "$DESIGNFREE_REPOSITORY" "$destination"
  fi
  cd "$destination"
}

ensure_node() {
  local downloaded="$1/nvm-install.sh"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    say 'Node 버전 관리 도구 nvm을 공식 설치 스크립트로 준비합니다.'
    curl --fail --show-error --silent --location --retry 3 \
      "https://raw.githubusercontent.com/nvm-sh/nvm/$DESIGNFREE_NVM_VERSION/install.sh" -o "$downloaded"
    PROFILE="$DESIGNFREE_PROFILE" /bin/bash "$downloaded"
  fi
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then fail 'nvm 설치를 확인할 수 없습니다.'; return 1; fi
  # Existing nvm installations may not yet be loaded by this terminal.
  . "$NVM_DIR/nvm.sh" --no-use
  say '저장소에 지정된 Node.js 버전을 설치·선택합니다.'
  nvm install
  nvm use
  if [ "$(node -p 'process.versions.node.split(".")[0]')" != 26 ]; then
    fail '이 저장소는 Node.js 26이 필요합니다.'; return 1
  fi
}

desktop_ready() {
  local endpoint
  endpoint="$(docker context inspect desktop-linux --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" || return 1
  case "$endpoint" in
    unix://*) docker --context desktop-linux info >/dev/null 2>&1 ;;
    '') return 1 ;;
    *) fail '로컬 Docker 소켓이 아니므로 실행을 중지합니다.' || return 2 ;;
  esac
}

ensure_docker() {
  local docker_app=''
  if [ -d /Applications/Docker.app ]; then docker_app=/Applications/Docker.app
  elif [ -d "$HOME/Applications/Docker.app" ]; then docker_app="$HOME/Applications/Docker.app"
  else
    say 'Docker Desktop을 설치합니다. 요청되면 Mac 로그인 암호를 입력하세요.'
    "$DESIGNFREE_BREW" install --cask docker-desktop
    docker_app=/Applications/Docker.app
  fi
  if [ ! -d "$docker_app" ]; then fail 'Docker Desktop 앱을 확인할 수 없습니다.'; return 1; fi
  # Only this process receives PATH/context changes. Never select a remote engine.
  export PATH="$docker_app/Contents/Resources/bin:$HOME/.docker/bin:$PATH"
  unset DOCKER_HOST DOCKER_TLS_VERIFY DOCKER_CERT_PATH
  export DOCKER_CONTEXT=desktop-linux
  say 'Docker Desktop을 시작합니다. 최초 약관·권한 화면을 직접 확인하고 시작을 완료하세요.'
  open -a "$docker_app"
  local elapsed=0 state
  while :; do
    if desktop_ready; then break
    else state=$?; if [ "$state" = 2 ]; then return 1; fi; fi
    if [ "$elapsed" -ge 600 ]; then
      fail 'Docker가 아직 준비되지 않았습니다. Docker 화면에서 시작을 완료한 뒤 같은 명령을 다시 실행하세요.'; return 1
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  docker compose version >/dev/null
}

check_compose_ownership() {
  local directory="$1" ids cid configured
  ids="$(docker ps -aq --filter label=com.docker.compose.project=designfree)"
  for cid in $ids; do
    configured="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$cid")"
    if [ "$configured" != "$directory" ]; then
      fail '다른 폴더에서 실행한 designfree 컨테이너가 있습니다. 기존 설치를 변경하지 않습니다.'; return 1
    fi
  done
  if [ -z "$ids" ] && [ ! -f "$directory/.env" ]; then
    local volumes
    volumes="$(docker volume ls -q --filter label=com.docker.compose.project=designfree)"
    if [ -n "$volumes" ]; then
      fail '기존 designfree 데이터 볼륨이 있지만 이 폴더의 .env가 없습니다. 새 비밀번호로 연결하지 않습니다. 기존 설치 폴더와 .env를 복구하세요.'; return 1
    fi
  fi
}

main() {
  if [ "${1:-}" = --help ] || [ "${1:-}" = -h ]; then usage; return; fi
  if [ "$#" -gt 1 ]; then usage >&2; return 1; fi
  if [ "$(uname -s)" != Darwin ]; then fail '이 자동 설치는 macOS 전용입니다. 다른 OS는 README를 참고하세요.'; return 1; fi
  if [ "$(id -u)" = 0 ]; then fail 'sudo를 붙이지 말고 일반 사용자로 실행하세요.'; return 1; fi
  case "${SHELL:-/bin/zsh}" in
    */zsh) DESIGNFREE_PROFILE="${ZDOTDIR:-$HOME}/.zprofile" ;;
    */bash) DESIGNFREE_PROFILE="$HOME/.bash_profile" ;;
    *) fail '기본 zsh 또는 bash 터미널에서 실행하세요.'; return 1 ;;
  esac
  local destination="${1:-$HOME/Projects/DesignFree}" scratch port binding
  scratch="$(mktemp -d -t designfree-bootstrap)"
  # Cleanup only the generated installer scratch directory, including on failure.
  trap "$(printf 'rm -rf -- %q' "$scratch")" EXIT
  say '필요한 도구만 설치하며, 기존 프로젝트·문서·계정·비밀번호를 덮어쓰지 않습니다.'
  ensure_clt
  ensure_brew "$scratch"
  prepare_checkout "$destination"
  ensure_node "$scratch"
  ensure_docker
  check_compose_ownership "$(pwd -P)"
  npm run setup
  binding="$(node --env-file=.env -p 'process.env.DRAFTROOM_BIND_ADDRESS || "127.0.0.1"')"
  case "$binding" in 127.0.0.1|localhost) ;; *) fail '자동 설치는 로컬 바인딩만 허용합니다. 기존 환경 설정을 직접 확인하세요.'; return 1 ;; esac
  port="$(node --env-file=.env -p 'process.env.DRAFTROOM_PORT || "4173"')"
  case "$port" in ''|*[!0-9]*) fail '포트 설정을 확인하세요.'; return 1 ;; esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then fail '포트는 1~65535 범위여야 합니다.'; return 1; fi
  say '개인용 Docker 서비스를 빌드·실행합니다. 처음에는 다운로드 시간이 걸립니다.'
  npm run start:docker
  local elapsed=0
  until curl --fail --silent --max-time 5 "http://$binding:$port/api/health" >/dev/null 2>&1; do
    if [ "$elapsed" -ge 60 ]; then
      fail '앱 응답을 아직 확인하지 못했습니다. 설치 폴더에서 npm run logs:docker로 확인하세요.'; return 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  say "설치가 끝났습니다. http://$binding:$port/ 에서 새 소유자 계정을 만드세요."
  printf '설치 폴더: %s\n' "$(pwd -P)"
  say 'Codex를 사용하려면 이 폴더를 열고 별도로 로그인한 뒤 AGENTS.md를 읽도록 요청하세요.'
  say '나중에 중지: docs/INSTALL_MACOS.md 의 로컬 전용 중지 블록을 사용하세요. 문서 데이터는 유지됩니다.'
  open "http://$binding:$port/" || true
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi

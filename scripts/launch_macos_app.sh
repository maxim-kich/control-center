#!/bin/bash
set -euo pipefail

APP_NAME="Control Center"
ROOT="${CC_DASHBOARD_ROOT:-}"

if [ -z "$ROOT" ]; then
  ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
fi

PORT="${PORT:-3137}"
HOST="127.0.0.1"
URL="http://${HOST}:${PORT}"
CONTROL_CENTER_HOME="${CONTROL_CENTER_HOME:-${HOME}/.control-center}"
DATA_DIR="${CONTROL_CENTER_HOME}/data"
LOG_DIR="${CONTROL_CENTER_HOME}/logs"
PID_FILE="${DATA_DIR}/control-center.pid"
LAUNCH_LOG="${LOG_DIR}/launcher.log"
SERVER_LOG="${LOG_DIR}/server.log"

mkdir -p "$DATA_DIR" "$LOG_DIR"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LAUNCH_LOG"
}

alert_error() {
  CC_LAUNCHER_MESSAGE="$1" /usr/bin/osascript >/dev/null 2>&1 <<'OSA' || true
display dialog (system attribute "CC_LAUNCHER_MESSAGE") buttons {"OK"} default button "OK" with title "Control Center" with icon stop
OSA
}

notify_user() {
  CC_LAUNCHER_MESSAGE="$1" /usr/bin/osascript >/dev/null 2>&1 <<'OSA' || true
display notification (system attribute "CC_LAUNCHER_MESSAGE") with title "Control Center"
OSA
}

append_path_dir() {
  if [ -d "$1" ]; then
    case ":$PATH:" in
      *":$1:"*) ;;
      *) PATH="$PATH:$1" ;;
    esac
  fi
}

prepend_path_dir() {
  if [ -d "$1" ]; then
    case ":$PATH:" in
      *":$1:"*) ;;
      *) PATH="$1:$PATH" ;;
    esac
  fi
}

login_shell_path() {
  local shell_path
  for shell_path in "${SHELL:-}" /bin/zsh /bin/bash; do
    if [ -n "$shell_path" ] && [ -x "$shell_path" ]; then
      "$shell_path" -lc 'printf "%s" "$PATH"' 2>/dev/null && return 0
    fi
  done
  return 1
}

resolve_cmd() {
  local name="$1"
  local found
  found="$(command -v "$name" 2>/dev/null || true)"
  if [ -n "$found" ] && [ -x "$found" ]; then
    printf '%s\n' "$found"
    return 0
  fi
  return 1
}

health_ok() {
  /usr/bin/curl -fsS --max-time 2 "${URL}/api/health" >/dev/null 2>&1
}

port_is_open() {
  /usr/bin/nc -z "$HOST" "$PORT" >/dev/null 2>&1
}

dashboard_server_pid() {
  local pid cmd
  if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      if printf '%s' "$cmd" | /usr/bin/grep -Eq '(^|[/ ])node( |$).*server\.js'; then
        printf '%s\n' "$pid"
        return 0
      fi
    fi
  fi

  while read -r pid; do
    [ -n "$pid" ] || continue
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if printf '%s' "$cmd" | /usr/bin/grep -Eq '(^|[/ ])node( |$).*server\.js'; then
      printf '%s\n' "$pid"
      return 0
    fi
  done < <(/usr/sbin/lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)

  return 1
}

stop_stale_dashboard_server() {
  local pid
  pid="$(dashboard_server_pid || true)"
  [ -n "$pid" ] || return 1
  log "stopping stale server pid=${pid}"
  kill "$pid" 2>/dev/null || return 1
  for _ in $(seq 1 40); do
    if ! port_is_open; then
      return 0
    fi
    sleep 0.25
  done
  kill -9 "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! port_is_open; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

open_dashboard() {
  /usr/bin/open "$URL" >/dev/null 2>&1 || true
}

if [ ! -f "${ROOT}/server.js" ] || [ ! -f "${ROOT}/package.json" ]; then
  alert_error "${APP_NAME} could not find the project folder at:
${ROOT}

Keep the .app bundle next to the Control Center files, or rebuild it with:
npm run macos-app"
  exit 1
fi

LOGIN_PATH="$(login_shell_path || true)"
if [ -n "$LOGIN_PATH" ]; then
  PATH="$LOGIN_PATH:$PATH"
fi

# App bundles launch with a sparse PATH. Prefer user-level installs before
# system-level fallbacks so a newer per-user Codex beats an older /usr/local one.
prepend_path_dir "${HOME:-}/.cargo/bin"
prepend_path_dir "${HOME:-}/.bun/bin"
prepend_path_dir "${HOME:-}/bin"
prepend_path_dir "${HOME:-}/.local/bin"
prepend_path_dir "${HOME:-}/.npm-global/bin"

append_path_dir "/opt/homebrew/bin"
append_path_dir "/usr/local/bin"
export PATH

NODE_BIN="${NODE_BIN:-$(resolve_cmd node || true)}"
NPM_BIN="${NPM_BIN:-$(resolve_cmd npm || true)}"
CODEX_BIN="${CC_CODEX_BIN:-$(resolve_cmd codex || true)}"
if [ -n "$CODEX_BIN" ]; then
  export CC_CODEX_BIN="$CODEX_BIN"
fi

log "launcher root=${ROOT} url=${URL} codex=${CODEX_BIN:-not-found}"

if health_ok; then
  log "server already running"
  open_dashboard
  exit 0
fi

if port_is_open; then
  log "port ${PORT} is occupied but health check did not answer"
  if stop_stale_dashboard_server; then
    log "stale server stopped"
  else
    alert_error "${APP_NAME} could not start because ${URL} is already occupied and not answering.

Close the process using port ${PORT}, or choose another port with:
PORT=4000 npm run macos-app"
    open_dashboard
    exit 1
  fi
fi

if [ -z "$NODE_BIN" ]; then
  alert_error "Node.js was not found on PATH.

Install Node 18+ and try again.

Log:
${LAUNCH_LOG}"
  exit 1
fi

if [ ! -d "${ROOT}/node_modules" ]; then
  if [ -z "$NPM_BIN" ]; then
    alert_error "Dependencies are not installed, and npm was not found on PATH.

Install Node/npm, then run:
npm install

Log:
${LAUNCH_LOG}"
    exit 1
  fi

  notify_user "Installing dependencies. This can take a minute."
  log "running npm install with ${NPM_BIN}"
  if ! (cd "$ROOT" && "$NPM_BIN" install >> "$LAUNCH_LOG" 2>&1); then
    alert_error "npm install failed.

See log:
${LAUNCH_LOG}"
    exit 1
  fi
fi

log "starting server with ${NODE_BIN}"
: >> "$SERVER_LOG"
(
  cd "$ROOT"
  CONTROL_CENTER_HOME="$CONTROL_CENTER_HOME" PORT="$PORT" PATH="$PATH" CC_CODEX_BIN="${CC_CODEX_BIN:-}" /usr/bin/nohup "$NODE_BIN" server.js >> "$SERVER_LOG" 2>&1 &
  printf '%s\n' "$!" > "$PID_FILE"
)

SERVER_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
attempt=0
while [ "$attempt" -lt 80 ]; do
  if health_ok; then
    log "server ready pid=${SERVER_PID:-unknown}"
    open_dashboard
    exit 0
  fi

  if [ -n "$SERVER_PID" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
    alert_error "${APP_NAME} exited before it was ready.

See logs:
${LAUNCH_LOG}
${SERVER_LOG}"
    exit 1
  fi

  attempt=$((attempt + 1))
  sleep 0.25
done

alert_error "${APP_NAME} did not answer at ${URL}.

See logs:
${LAUNCH_LOG}
${SERVER_LOG}"
exit 1

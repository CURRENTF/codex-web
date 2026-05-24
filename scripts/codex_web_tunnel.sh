#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${CODEX_WEB_REPO_DIR:-/Users/concentrate-42/Desktop/Projects/codex-web}"
REMOTE="${CODEX_WEB_REMOTE:-root@connect.westb.seetacloud.com}"
SSH_PORT="${CODEX_WEB_SSH_PORT:-22160}"
LOCAL_TUNNEL_PORT="${CODEX_WEB_LOCAL_TUNNEL_PORT:-16006}"
LOCAL_WEB_PORT="${CODEX_WEB_LOCAL_WEB_PORT:-6006}"
REMOTE_WEB_PORT="${CODEX_WEB_REMOTE_WEB_PORT:-6006}"
PROXY_LABEL="${CODEX_WEB_PROXY_LABEL:-com.codex-web.cached-proxy}"
RUNTIME_DIR="${CODEX_WEB_RUNTIME_DIR:-$HOME/.cache/codex-web/runtime}"
CACHE_DIR="${CODEX_WEB_CACHE_DIR:-$HOME/.cache/codex-web/assets}"
LOG_DIR="${CODEX_WEB_LOG_DIR:-$HOME/.cache/codex-web}"
declare -a SSH_EXTRA_ARGS=()
UPSTREAM="http://127.0.0.1:${LOCAL_TUNNEL_PORT}"
WEB_URL="http://127.0.0.1:${LOCAL_WEB_PORT}"

usage() {
  cat <<EOF
Usage: codex-web-tunnel [command] [ssh options] [user@host]

Commands:
  start     Start the SSH tunnel and local cached proxy
  stop      Stop the local cached proxy and SSH tunnel
  restart   Stop, then start
  status    Show local proxy, SSH tunnel, and remote server status
  open      Start if needed, then open ${WEB_URL}
  logs      Tail local proxy logs

Environment overrides:
  CODEX_WEB_REMOTE=${REMOTE}
  CODEX_WEB_SSH_PORT=${SSH_PORT}
  CODEX_WEB_LOCAL_WEB_PORT=${LOCAL_WEB_PORT}
  CODEX_WEB_LOCAL_TUNNEL_PORT=${LOCAL_TUNNEL_PORT}
  CODEX_WEB_REMOTE_WEB_PORT=${REMOTE_WEB_PORT}

Examples:
  codex-web-tunnel start
  codex-web-tunnel ssh -p 22160 root@connect.westb.seetacloud.com
  codex-web-tunnel start -p 22160 root@connect.westb.seetacloud.com
  codex-web-tunnel -p 22160 root@connect.westb.seetacloud.com
  codex-web-tunnel open -p 12345 root@example.com
EOF
}

refresh_derived_settings() {
  UPSTREAM="http://127.0.0.1:${LOCAL_TUNNEL_PORT}"
  WEB_URL="http://127.0.0.1:${LOCAL_WEB_PORT}"
}

parse_connection_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      ssh)
        shift
        ;;
      --remote)
        REMOTE="$2"
        shift 2
        ;;
      --ssh-port | --port)
        SSH_PORT="$2"
        shift 2
        ;;
      -p)
        SSH_PORT="$2"
        shift 2
        ;;
      -p*)
        SSH_PORT="${1#-p}"
        shift
        ;;
      --local-web-port)
        LOCAL_WEB_PORT="$2"
        shift 2
        ;;
      --local-tunnel-port)
        LOCAL_TUNNEL_PORT="$2"
        shift 2
        ;;
      --remote-web-port)
        REMOTE_WEB_PORT="$2"
        shift 2
        ;;
      --)
        shift
        SSH_EXTRA_ARGS+=("$@")
        break
        ;;
      *@*)
        REMOTE="$1"
        shift
        ;;
      *)
        SSH_EXTRA_ARGS+=("$1")
        shift
        ;;
    esac
  done

  refresh_derived_settings
}

node_bin() {
  if [[ -n "${CODEX_WEB_NODE:-}" ]]; then
    printf '%s\n' "$CODEX_WEB_NODE"
    return
  fi

  local candidate
  for candidate in "$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  echo "node not found" >&2
  return 127
}

is_listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

print_listener() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

run_ssh() {
  if [[ "${#SSH_EXTRA_ARGS[@]}" -gt 0 ]]; then
    ssh "${SSH_EXTRA_ARGS[@]}" "$@"
  else
    ssh "$@"
  fi
}

tunnel_pids() {
  ps -eo pid=,args= |
    awk \
      -v forward="-L ${LOCAL_TUNNEL_PORT}:127.0.0.1:${REMOTE_WEB_PORT}" \
      -v port="-p ${SSH_PORT}" \
      -v remote="$REMOTE" \
      'index($0, "ssh -fN") && index($0, forward) && index($0, port) && index($0, remote) {print $1}'
}

tunnel_pids_on_port() {
  local pid comm
  lsof -nP -tiTCP:"$LOCAL_TUNNEL_PORT" -sTCP:LISTEN 2>/dev/null |
    while IFS= read -r pid; do
      comm="$(ps -p "$pid" -o comm= 2>/dev/null | awk '{print $1}')"
      if [[ "$comm" = "ssh" || "$comm" = */ssh ]]; then
        printf '%s\n' "$pid"
      fi
    done
}

ensure_proxy_runtime() {
  local source_script="$REPO_DIR/scripts/cached_tunnel_proxy.mjs"
  if [[ ! -f "$source_script" ]]; then
    echo "missing proxy script: $source_script" >&2
    return 1
  fi

  mkdir -p "$RUNTIME_DIR" "$CACHE_DIR" "$LOG_DIR"
  cp "$source_script" "$RUNTIME_DIR/cached_tunnel_proxy.mjs"

  if [[ ! -e "$RUNTIME_DIR/node_modules" && -d "$REPO_DIR/node_modules" ]]; then
    ln -s "$REPO_DIR/node_modules" "$RUNTIME_DIR/node_modules"
  fi
}

start_tunnel() {
  if is_listening "$LOCAL_TUNNEL_PORT"; then
    echo "SSH tunnel already listening on 127.0.0.1:${LOCAL_TUNNEL_PORT}"
    return
  fi

  run_ssh -fN \
    -L "${LOCAL_TUNNEL_PORT}:127.0.0.1:${REMOTE_WEB_PORT}" \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o StrictHostKeyChecking=accept-new \
    -p "$SSH_PORT" \
    "$REMOTE"

  echo "SSH tunnel started: 127.0.0.1:${LOCAL_TUNNEL_PORT} -> ${REMOTE}:127.0.0.1:${REMOTE_WEB_PORT}"
}

start_proxy() {
  if is_listening "$LOCAL_WEB_PORT"; then
    echo "Local proxy already listening on ${WEB_URL}"
    return
  fi

  ensure_proxy_runtime
  launchctl remove "$PROXY_LABEL" >/dev/null 2>&1 || true
  launchctl submit \
    -l "$PROXY_LABEL" \
    -o "$LOG_DIR/proxy.log" \
    -e "$LOG_DIR/proxy.err.log" \
    -- /usr/bin/env \
      CODEX_WEB_UPSTREAM="$UPSTREAM" \
      CODEX_WEB_PROXY_PORT="$LOCAL_WEB_PORT" \
      CODEX_WEB_CACHE_DIR="$CACHE_DIR" \
      "$(node_bin)" \
      "$RUNTIME_DIR/cached_tunnel_proxy.mjs"

  for _ in {1..30}; do
    if is_listening "$LOCAL_WEB_PORT"; then
      echo "Local cached proxy started: ${WEB_URL} -> ${UPSTREAM}"
      return
    fi
    sleep 0.2
  done

  echo "local proxy did not start within 6 seconds; see $LOG_DIR/proxy.err.log" >&2
  return 1
}

start_all() {
  start_tunnel
  start_proxy
  status_all
}

stop_all() {
  launchctl remove "$PROXY_LABEL" >/dev/null 2>&1 || true
  pkill -f "$RUNTIME_DIR/cached_tunnel_proxy.mjs" >/dev/null 2>&1 || true

  local pids
  pids="$( { tunnel_pids; tunnel_pids_on_port; } | sort -u | tr '\n' ' ')"
  if [[ -n "${pids// }" ]]; then
    # shellcheck disable=SC2086
    kill $pids >/dev/null 2>&1 || true
  fi

  echo "Stopped local proxy and matching SSH tunnel processes."
}

status_all() {
  echo "Web URL: ${WEB_URL}"
  echo
  echo "Local proxy listener:"
  print_listener "$LOCAL_WEB_PORT"
  echo
  echo "SSH tunnel listener:"
  print_listener "$LOCAL_TUNNEL_PORT"
  echo
  echo "Local proxy HTTP check:"
  curl -sS -o /dev/null -w 'local_http=%{http_code} time_total=%{time_total}\n' "${WEB_URL}/" || true
  echo
  echo "Remote codex-web HTTP check:"
  run_ssh \
    -o ConnectTimeout=8 \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -p "$SSH_PORT" \
    "$REMOTE" \
    "curl -sS -o /dev/null -w 'remote_http=%{http_code} time_total=%{time_total}\\n' http://127.0.0.1:${REMOTE_WEB_PORT}/" || true
}

open_web() {
  start_all
  open "$WEB_URL"
}

tail_logs() {
  mkdir -p "$LOG_DIR"
  tail -n 80 -f "$LOG_DIR/proxy.log" "$LOG_DIR/proxy.err.log"
}

command="${1:-status}"
case "$command" in
  start | stop | restart | status | open | logs | help | -h | --help)
    if [[ "$#" -gt 0 ]]; then
      shift
    fi
    ;;
  ssh)
    command="start"
    shift
    ;;
  *)
    if [[ "$#" -gt 0 ]]; then
      command="start"
    fi
    ;;
esac
parse_connection_args "$@"

case "$command" in
  start)
    start_all
    ;;
  stop)
    stop_all
    ;;
  restart)
    stop_all
    sleep 1
    start_all
    ;;
  status)
    status_all
    ;;
  open)
    open_web
    ;;
  logs)
    tail_logs
    ;;
  help | -h | --help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

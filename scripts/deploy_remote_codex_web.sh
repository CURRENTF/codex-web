#!/usr/bin/env bash
set -euo pipefail

REMOTE="${CODEX_WEB_REMOTE:-root@connect.westb.seetacloud.com}"
SSH_PORT="${CODEX_WEB_SSH_PORT:-22160}"
REMOTE_DIR="${CODEX_WEB_REMOTE_DIR:-/root/codex-web}"
GIT_REMOTE="${CODEX_WEB_GIT_REMOTE:-origin}"
GIT_BRANCH="${CODEX_WEB_GIT_BRANCH:-main}"
REMOTE_NODE="${CODEX_WEB_REMOTE_NODE:-/root/node/bin/node}"
REMOTE_CODEX="${CODEX_WEB_REMOTE_CODEX:-/root/npm-global/bin/codex}"
WEB_HOST="${CODEX_WEB_REMOTE_HOST:-127.0.0.1}"
WEB_PORT="${CODEX_WEB_REMOTE_WEB_PORT:-6006}"
DO_PULL=1
DO_RESTART=1
declare -a SSH_EXTRA_ARGS=()

usage() {
  cat <<EOF
Usage: scripts/deploy_remote_codex_web.sh [options] [user@host]

Pull the remote repo, patch the ignored scratch/asar webview runtime when needed,
restart codex-web, and verify both the web server and Codex app-server.

Options:
  -p, --ssh-port PORT      SSH port. Default: ${SSH_PORT}
  --remote-dir PATH        Remote repo path. Default: ${REMOTE_DIR}
  --git-remote NAME        Git remote to pull. Default: ${GIT_REMOTE}
  --branch NAME            Git branch to pull. Default: ${GIT_BRANCH}
  --node PATH              Remote Node binary. Default: ${REMOTE_NODE}
  --codex PATH             Remote Codex CLI. Default: ${REMOTE_CODEX}
  --web-host HOST          Remote bind host. Default: ${WEB_HOST}
  --web-port PORT          Remote web port. Default: ${WEB_PORT}
  --no-pull                Skip git fetch/pull.
  --no-restart             Apply/verify runtime patch without restarting.
  --ssh-arg ARG            Extra argument passed to ssh. May be repeated.
  -h, --help               Show this help.

Environment overrides use the CODEX_WEB_* variable names shown in the defaults.

Examples:
  scripts/deploy_remote_codex_web.sh
  scripts/deploy_remote_codex_web.sh -p 22160 root@connect.westb.seetacloud.com
  CODEX_WEB_REMOTE_WEB_PORT=6007 scripts/deploy_remote_codex_web.sh user@example.com
EOF
}

quote() {
  printf "%q" "$1"
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -p | --ssh-port | --port)
        SSH_PORT="$2"
        shift 2
        ;;
      -p*)
        SSH_PORT="${1#-p}"
        shift
        ;;
      --remote-dir)
        REMOTE_DIR="$2"
        shift 2
        ;;
      --git-remote)
        GIT_REMOTE="$2"
        shift 2
        ;;
      --branch)
        GIT_BRANCH="$2"
        shift 2
        ;;
      --node)
        REMOTE_NODE="$2"
        shift 2
        ;;
      --codex)
        REMOTE_CODEX="$2"
        shift 2
        ;;
      --web-host)
        WEB_HOST="$2"
        shift 2
        ;;
      --web-port)
        WEB_PORT="$2"
        shift 2
        ;;
      --no-pull)
        DO_PULL=0
        shift
        ;;
      --no-restart)
        DO_RESTART=0
        shift
        ;;
      --ssh-arg)
        SSH_EXTRA_ARGS+=("$2")
        shift 2
        ;;
      -h | --help)
        usage
        exit 0
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
        echo "unknown argument: $1" >&2
        usage >&2
        exit 2
        ;;
    esac
  done
}

run_ssh() {
  if [[ "${#SSH_EXTRA_ARGS[@]}" -gt 0 ]]; then
    ssh "${SSH_EXTRA_ARGS[@]}" -p "$SSH_PORT" "$REMOTE" "$@"
  else
    ssh -p "$SSH_PORT" "$REMOTE" "$@"
  fi
}

parse_args "$@"

REMOTE_ENV=(
  "REMOTE_DIR=$(quote "$REMOTE_DIR")"
  "GIT_REMOTE=$(quote "$GIT_REMOTE")"
  "GIT_BRANCH=$(quote "$GIT_BRANCH")"
  "REMOTE_NODE=$(quote "$REMOTE_NODE")"
  "REMOTE_CODEX=$(quote "$REMOTE_CODEX")"
  "WEB_HOST=$(quote "$WEB_HOST")"
  "WEB_PORT=$(quote "$WEB_PORT")"
  "DO_PULL=$(quote "$DO_PULL")"
  "DO_RESTART=$(quote "$DO_RESTART")"
)

run_ssh "${REMOTE_ENV[*]} bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

log() {
  printf '\n== %s ==\n' "$1"
}

if [[ ! -x "$REMOTE_NODE" ]]; then
  echo "remote node not executable: $REMOTE_NODE" >&2
  exit 127
fi
if [[ ! -x "$REMOTE_CODEX" ]]; then
  echo "remote codex not executable: $REMOTE_CODEX" >&2
  exit 127
fi
if [[ ! -d "$REMOTE_DIR/.git" ]]; then
  echo "remote repo not found: $REMOTE_DIR" >&2
  exit 1
fi

cd "$REMOTE_DIR"
export PATH="$(dirname "$REMOTE_NODE"):$(dirname "$REMOTE_CODEX"):$PATH"
export CODEX_CLI_PATH="$REMOTE_CODEX"

log "repo"
git status --short --branch
if [[ "$DO_PULL" = "1" ]]; then
  git fetch "$GIT_REMOTE" "$GIT_BRANCH"
  git pull --ff-only "$GIT_REMOTE" "$GIT_BRANCH"
else
  echo "skip git pull"
fi
git log --oneline -1

log "runtime patch"
"$REMOTE_NODE" <<'NODE'
const fs = require("fs");

const assetPath = "scratch/asar/webview/assets/app-server-manager-signals-BAE2L06u.js";
const userMessageOriginalMinified =
  "o||!s?a.push({type:`steered`,id:n.id}):a.push(r)";
const userMessagePreviousMinified =
  "o?a.push({type:`steered`,id:n.id}):s?a.push(r):a.push({...r,steeringStatus:`accepted`},{type:`steered`,id:n.id})";
const userMessagePatchedMinified =
  "o?a.some(e=>e.type===`user-message`&&e.steeringMessageId===o.id)?a.push({type:`steered`,id:n.id}):a.push({...r,steeringStatus:`accepted`,steeringMessageId:o.id},{type:`steered`,id:n.id}):s?a.push(r):a.push({...r,steeringStatus:`accepted`},{type:`steered`,id:n.id})";
const userMessageOriginalFormatted =
  "o || !s ? a.push({ type: `steered`, id: n.id }) : a.push(r);";
const userMessagePreviousFormatted = `o
              ? a.push({ type: \`steered\`, id: n.id })
              : s
                ? a.push(r)
                : a.push(
                    { ...r, steeringStatus: \`accepted\` },
                    { type: \`steered\`, id: n.id },
                  );`;
const userMessagePatchedFormatted = `o
              ? a.some(
                  (e) =>
                    e.type === \`user-message\` && e.steeringMessageId === o.id,
                )
                ? a.push({ type: \`steered\`, id: n.id })
                : a.push(
                    { ...r, steeringStatus: \`accepted\`, steeringMessageId: o.id },
                    { type: \`steered\`, id: n.id },
                  )
              : s
                ? a.push(r)
                : a.push(
                    { ...r, steeringStatus: \`accepted\` },
                    { type: \`steered\`, id: n.id },
                  );`;

const steeringUserPreviousMinified =
  "e!=null&&a.push({...e,steeringStatus:n.status});";
const steeringUserPatchedMinified =
  "e!=null&&a.push({...e,steeringStatus:n.status,steeringMessageId:n.id});";
const steeringUserPreviousFormatted =
  "e != null && a.push({ ...e, steeringStatus: n.status });";
const steeringUserPatchedFormatted = `e != null &&
            a.push({ ...e, steeringStatus: n.status, steeringMessageId: n.id });`;

const matcherPreviousMinified =
  "function Lv(e,t,n,r){for(let i=0;i<t;i+=1){let t=e[i];if(t?.type===`steeringUserMessage`&&wu(t,n,r))return!0}return!1}";
const matcherPatchedMinified =
  "function Lv(e,t,n,r){for(let i=0;i<t;i+=1){let t=e[i];if(t?.type===`steeringUserMessage`&&wu(t,n,r))return t}return null}";
const matcherPreviousFormatted = `function Lv(e, t, n, r) {
  for (let i = 0; i < t; i += 1) {
    let t = e[i];
    if (t?.type === \`steeringUserMessage\` && wu(t, n, r)) return !0;
  }
  return !1;
}`;
const matcherPatchedFormatted = `function Lv(e, t, n, r) {
  for (let i = 0; i < t; i += 1) {
    let t = e[i];
    if (t?.type === \`steeringUserMessage\` && wu(t, n, r)) return t;
  }
  return null;
}`;

function replaceRuntimePatch(source, name, patchedNeedles, replacements) {
  const needles = Array.isArray(patchedNeedles) ? patchedNeedles : [patchedNeedles];
  if (needles.some((needle) => source.includes(needle))) {
    console.log(`${name} runtime patch already present`);
    return source;
  }
  for (const [before, after, label] of replacements) {
    if (source.includes(before)) {
      console.log(`applied ${label} ${name} runtime patch`);
      return source.replace(before, after);
    }
  }
  throw new Error(`could not find ${name} runtime patch target`);
}

let source = fs.readFileSync(assetPath, "utf8");
source = replaceRuntimePatch(source, "steered user-message", [
  "steeringMessageId:o.id",
  "steeringMessageId: o.id",
], [
  [userMessagePreviousMinified, userMessagePatchedMinified, "minified previous"],
  [userMessageOriginalMinified, userMessagePatchedMinified, "minified original"],
  [userMessagePreviousFormatted, userMessagePatchedFormatted, "formatted previous"],
  [userMessageOriginalFormatted, userMessagePatchedFormatted, "formatted original"],
]);
source = replaceRuntimePatch(source, "steering-user marker", [
  "steeringMessageId:n.id",
  "steeringMessageId: n.id",
], [
  [steeringUserPreviousMinified, steeringUserPatchedMinified, "minified"],
  [steeringUserPreviousFormatted, steeringUserPatchedFormatted, "formatted"],
]);
source = replaceRuntimePatch(source, "steering matcher", [
  matcherPatchedMinified,
  matcherPatchedFormatted,
], [
  [matcherPreviousMinified, matcherPatchedMinified, "minified"],
  [matcherPreviousFormatted, matcherPatchedFormatted, "formatted"],
]);
fs.writeFileSync(assetPath, source);

const next = fs.readFileSync(assetPath, "utf8");
const hasPatch =
  (next.includes("steeringMessageId:o.id") ||
    next.includes("steeringMessageId: o.id")) &&
  (next.includes("steeringMessageId:n.id") ||
    next.includes("steeringMessageId: n.id")) &&
  (next.includes(matcherPatchedMinified) || next.includes(matcherPatchedFormatted));
const oldCount =
  [
    userMessageOriginalMinified,
    userMessagePreviousMinified,
    userMessageOriginalFormatted,
    userMessagePreviousFormatted,
    steeringUserPreviousMinified,
    steeringUserPreviousFormatted,
    matcherPreviousMinified,
    matcherPreviousFormatted,
  ].reduce((count, needle) => count + next.split(needle).length - 1, 0);
if (!hasPatch || oldCount !== 0) {
  throw new Error(`runtime patch verification failed: hasPatch=${hasPatch} oldCount=${oldCount}`);
}
console.log(JSON.stringify({ hasPatch, oldCount }));
NODE

if [[ "$DO_RESTART" != "1" ]]; then
  log "skip restart"
  exit 0
fi

log "stop"
old_pid="$(cat logs/codex-web.pid 2>/dev/null || true)"
if [[ -z "$old_pid" ]] || ! kill -0 "$old_pid" 2>/dev/null; then
  old_pid="$(
    ps -eo pid=,args= |
      awk -v host="$WEB_HOST" -v port="$WEB_PORT" \
        'index($0, "node src/server/main.js") && index($0, "--host " host) && index($0, "--port " port) {print $1; exit}'
  )"
fi

old_children=""
if [[ -n "$old_pid" ]]; then
  old_children="$(pgrep -P "$old_pid" 2>/dev/null || true)"
  echo "stopping old pid $old_pid children: ${old_children:-none}"
  kill -TERM "$old_pid" 2>/dev/null || true
  for child in $old_children; do
    kill -TERM "$child" 2>/dev/null || true
  done

  for _ in $(seq 1 20); do
    alive=0
    kill -0 "$old_pid" 2>/dev/null && alive=1 || true
    for child in $old_children; do
      kill -0 "$child" 2>/dev/null && alive=1 || true
    done
    [[ "$alive" = "0" ]] && break
    sleep 0.5
  done

  if kill -0 "$old_pid" 2>/dev/null; then
    echo "force stopping old pid $old_pid"
    kill -KILL "$old_pid" 2>/dev/null || true
  fi
  for child in $old_children; do
    if kill -0 "$child" 2>/dev/null; then
      echo "force stopping child $child"
      kill -KILL "$child" 2>/dev/null || true
    fi
  done
else
  echo "no existing codex-web process found"
fi
sleep 1

log "start"
mkdir -p logs
if [[ -f logs/codex-web.log ]]; then
  mv logs/codex-web.log "logs/codex-web.log.$(date +%Y%m%d-%H%M%S).bak"
fi
nohup env CODEX_CLI_PATH="$CODEX_CLI_PATH" PATH="$PATH" \
  "$REMOTE_NODE" src/server/main.js --host "$WEB_HOST" --port "$WEB_PORT" \
  > logs/codex-web.log 2>&1 &
new_pid=$!
echo "$new_pid" > logs/codex-web.pid

for _ in $(seq 1 30); do
  if kill -0 "$new_pid" 2>/dev/null &&
    netstat -ltnp 2>/dev/null | grep -q "${WEB_HOST}:${WEB_PORT}.*${new_pid}"; then
    break
  fi
  sleep 0.5
done

if ! kill -0 "$new_pid" 2>/dev/null; then
  echo "new process exited" >&2
  tail -160 logs/codex-web.log >&2 || true
  exit 1
fi
if ! netstat -ltnp 2>/dev/null | grep -q "${WEB_HOST}:${WEB_PORT}.*${new_pid}"; then
  echo "port check did not find pid $new_pid on ${WEB_HOST}:${WEB_PORT}" >&2
  netstat -ltnp 2>/dev/null | grep ":${WEB_PORT}" >&2 || true
  tail -160 logs/codex-web.log >&2 || true
  exit 1
fi

log "verify"
curl -fsS --max-time 5 "http://${WEB_HOST}:${WEB_PORT}/" >/tmp/codex-web-health.html
printf 'health_bytes='
wc -c </tmp/codex-web-health.html

for _ in $(seq 1 30); do
  if ps -eo pid=,ppid=,cmd= | awk -v parent="$new_pid" '$2 == parent && index($0, "codex app-server") {found=1} END {exit found ? 0 : 1}'; then
    break
  fi
  sleep 0.5
done
if ! ps -eo pid=,ppid=,cmd= | awk -v parent="$new_pid" '$2 == parent && index($0, "codex app-server") {found=1} END {exit found ? 0 : 1}'; then
  echo "codex app-server child did not appear" >&2
  tail -160 logs/codex-web.log >&2 || true
  exit 1
fi

printf 'new_pid=%s\n' "$new_pid"
ps -eo pid,ppid,etime,cmd | grep -E 'src/server/main|codex app-server' | grep -v grep
netstat -ltnp 2>/dev/null | grep ":${WEB_PORT}" || true
tail -80 logs/codex-web.log || true
REMOTE_SCRIPT

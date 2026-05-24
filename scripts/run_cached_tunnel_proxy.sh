#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

NODE_BIN="${CODEX_WEB_NODE:-}"
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
if [[ -z "$NODE_BIN" && -x /opt/homebrew/bin/node ]]; then
  NODE_BIN="/opt/homebrew/bin/node"
fi
if [[ -z "$NODE_BIN" && -x /usr/local/bin/node ]]; then
  NODE_BIN="/usr/local/bin/node"
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found" >&2
  exit 127
fi

export CODEX_WEB_UPSTREAM="${CODEX_WEB_UPSTREAM:-http://127.0.0.1:16006}"
export CODEX_WEB_PROXY_PORT="${CODEX_WEB_PROXY_PORT:-6006}"
export CODEX_WEB_CACHE_DIR="${CODEX_WEB_CACHE_DIR:-$REPO_DIR/.cache/codex-web-assets}"

cd "$REPO_DIR"
exec "$NODE_BIN" "$REPO_DIR/scripts/cached_tunnel_proxy.mjs"

# Local Operations

## Purpose

Local notes for running `codex-web` on this machine.

## Prerequisites

- Node.js 22.22.2 and npm 10.9.7 were used on 2026-05-09.
- Codex CLI is available at `/root/npm-global/bin/codex`.
- The host Codex profile already has `/root/.codex/auth.json`.

## Install

From `/root/codex-web`:

```bash
npm install --omit=dev
```

`--omit=dev` avoids downloading the Electron development dependency. The server
does not need that package for normal browser usage.

## Start

From `/root/codex-web`:

```bash
CODEX_HOME=/root/.codex CODEX_WEB_PASSWORD='<choose-a-password>' CODEX_CLI_PATH=/root/npm-global/bin/codex node src/server/main.js --host 127.0.0.1 --port 6006
```

Open `http://127.0.0.1:6006` from a browser on the same machine, or expose it
through an SSH tunnel / trusted private network.

For a cloud-provider Web entry that connects directly to the container port,
bind the server to all interfaces while keeping `CODEX_WEB_PASSWORD` set:

```bash
CODEX_HOME=/root/.codex CODEX_WEB_PASSWORD='<choose-a-password>' CODEX_CLI_PATH=/root/npm-global/bin/codex node src/server/main.js --host 0.0.0.0 --port 6006
```

Use the normal Codex profile (`/root/.codex`) for remote web usage so sessions,
projects, auth, and CLI state stay shared with `codex-cli` over SSH. A temporary
dedicated `CODEX_HOME` can be useful for isolating startup issues, but it will
intentionally show a separate, mostly empty history.

If `CODEX_WEB_PASSWORD` is set, all HTTP routes and the IPC WebSocket require a
successful login first. The password is intentionally supplied by environment
variable instead of being committed to the repo.

HTTP access logs and WebSocket accept/reject logs are disabled by default to
avoid high-volume log writes while the app is used through a slower SSH tunnel.
Set `CODEX_WEB_ACCESS_LOG=1` only while troubleshooting request routing.
Electron stub logs are also disabled by default; set
`CODEX_WEB_ELECTRON_STUB_LOG=1` only when debugging Electron API shims.
High-volume upstream fetch debug logs are filtered by default; set
`CODEX_WEB_VERBOSE_APP_LOG=1` when the raw upstream app logs are needed.
The served `index.html` strips upstream `modulepreload` links by default to
avoid making the SSH tunnel issue hundreds of initial asset requests. Set
`CODEX_WEB_MODULEPRELOAD=1` to restore upstream preload behavior on a low-latency
network.
The served main browser bundle also avoids blocking the first render on Statsig
network initialization by default. Set `CODEX_WEB_WAIT_FOR_STATSIG=1` to restore
the upstream loading gate while debugging feature flag behavior.
It also keeps ChatGPT `account-info` refreshes in the background; on this remote
host that upstream loading gate was the fixed 50-second first-render delay.
The browser shim disables the upstream `apps` feature by default because the
native app inventory is large on Linux hosts and is not needed for remote
session management.

## Restart

Observed on 2026-05-28: the AutoDL host runs `codex-web` directly from
`/root/codex-web` with the parent process recorded in `logs/codex-web.pid`.
From a local checkout, deploy the latest `main`, patch the ignored `scratch/asar`
runtime bundle if needed, restart the web server, and verify the app-server
child process with:

```bash
scripts/deploy_remote_codex_web.sh -p 22160 root@connect.westb.seetacloud.com
```

The script uses these remote defaults, all overrideable with `CODEX_WEB_*`
environment variables or CLI flags:

- repo: `/root/codex-web`
- Node: `/root/node/bin/node`
- Codex CLI: `/root/npm-global/bin/codex`
- web server: `127.0.0.1:6006`

For a patch-only check without restarting:

```bash
scripts/deploy_remote_codex_web.sh --no-pull --no-restart -p 22160 root@connect.westb.seetacloud.com
```

Manual verification on the remote host:

```bash
curl -fsS http://127.0.0.1:6006/ >/dev/null
ps -eo pid,ppid,etime,cmd | grep -E 'src/server/main|codex app-server' | grep -v grep
netstat -ltnp 2>/dev/null | grep ':6006'
```

## Autostart

Observed on 2026-05-28: the SeetaCloud container startup path runs
`/etc/autodl.sh` from `/init/bin/customer.cmd.sh`. The remote host is configured
to start `codex-web` from that hook.

Remote files:

- start script: `/root/.local/bin/codex-web-start`
- root-only environment file: `/root/.config/codex-web/env`
- boot hook: `/etc/autodl.sh`
- autostart log: `/root/autodl-fs/logs/codex-web/autostart.log`
- server log: `/root/autodl-fs/logs/codex-web/codex-web.log`

The environment file keeps `CODEX_WEB_PASSWORD` outside the repo and should stay
mode `600`. The start script is idempotent: if `codex-web` is already listening
on the configured port, it records that and exits.

Manual autostart verification on the remote host:

```bash
bash /etc/autodl.sh
tail -40 /root/autodl-fs/logs/codex-web/autostart.log
ps -eo pid,ppid,etime,cmd | grep -E 'src/server/main|codex app-server' | grep -v grep
netstat -ltnp 2>/dev/null | grep ':6006'
```

## Split App Server

Observed on 2026-06-11: some SeetaCloud containers have `systemctl --user`
offline, so the split deployment uses repo-provided shell scripts instead of
user services. This lets the web server restart independently while the Codex
app-server keeps running on a Unix socket.

Install the scripts on the remote host:

```bash
install -m 700 /root/codex-web/scripts/codex_web_app_server_start /root/.local/bin/codex-web-app-server-start
install -m 700 /root/codex-web/scripts/codex_web_app_server_proxy /root/.local/bin/codex-web-app-server-proxy
install -m 700 /root/codex-web/scripts/codex_web_ensure_node_pty /root/.local/bin/codex-web-ensure-node-pty
install -m 700 /root/codex-web/scripts/codex_web_split_start /root/.local/bin/codex-web-start
```

The root-only environment file still keeps secrets outside the repo:

```bash
cat >/root/.config/codex-web/env <<'EOF'
CODEX_WEB_REPO_DIR=/root/codex-web
CODEX_WEB_NODE=/root/node/bin/node
CODEX_WEB_CODEX=/root/npm-global/bin/codex
CODEX_WEB_PROXY=/root/.local/bin/codex-web-app-server-proxy
CODEX_WEB_APP_SERVER_PROXY_NODE=/root/codex-web/scripts/codex_web_app_server_proxy_node.mjs
CODEX_WEB_HOST=0.0.0.0
CODEX_WEB_PORT=6006
CODEX_WEB_LOG_DIR=/root/autodl-fs/logs/codex-web
CODEX_WEB_APP_SERVER_LOG=/root/autodl-fs/logs/codex-web/codex-app-server.log
CODEX_WEB_APP_SERVER_PID=/root/codex-web/logs/codex-app-server.pid
CODEX_UNIX_SOCKET=/tmp/codex-web-app-server.sock
CODEX_HOME=/root/.codex
CODEX_WEB_USE_CLASH_PROXY=1
CODEX_WEB_HTTP_PROXY=http://127.0.0.1:7890
CODEX_WEB_HTTPS_PROXY=http://127.0.0.1:7890
CODEX_WEB_ALL_PROXY=socks5://127.0.0.1:7891
CODEX_WEB_PASSWORD='<choose-a-password>'
EOF
chmod 600 /root/.config/codex-web/env
```

With `CODEX_WEB_USE_CLASH_PROXY=1`, `codex-web-app-server-start` exports both
upper- and lower-case proxy variables before launching `codex --yolo
app-server`. Set it to `0` only when the host has direct supported network
access.

Start or restart only the web side:

```bash
/root/.local/bin/codex-web-start
```

The split start script first ensures `/root/.local/bin/codex-web-app-server-start`
has started a long-lived `codex --yolo app-server` on `CODEX_UNIX_SOCKET`, then
checks that Linux `node-pty` can load from the unpacked app bundle, then starts
`src/server/main.js` with `CODEX_CLI_PATH` pointed at the proxy wrapper.
The proxy wrapper uses the Node bridge in
`scripts/codex_web_app_server_proxy_node.mjs` to forward stdio to the
app-server's WebSocket-over-Unix-socket transport. Do not replace it with
`codex app-server proxy --sock`; that command is for the app-server control
socket and does not complete the codex-web initialize handshake. If the
app-server is already running, it is reused.

The upstream desktop bundle may unpack a non-Linux `node-pty` native module.
`scripts/codex_web_ensure_node_pty` is idempotent: on Linux it first smoke-tests
`scratch/asar/node_modules/node-pty`; if loading or spawning fails, it installs
the same `node-pty` version in `/root/autodl-tmp/codex-web-node-pty-build`,
copies the rebuilt package into `scratch/asar/node_modules/node-pty`, and keeps
a timestamped backup of the previous package. This is required for the web
terminal panel.

To restart the app-server itself, stop the PID in
`/root/codex-web/logs/codex-app-server.pid`, then run:

```bash
/root/.local/bin/codex-web-app-server-start
/root/.local/bin/codex-web-start
```

Manual verification:

```bash
curl -fsS http://127.0.0.1:6006/ >/dev/null
ps -eo pid,ppid,etime,cmd | grep -E 'src/server/main|codex .*app-server|codex-web-app-server-proxy' | grep -v grep
test -S /tmp/codex-web-app-server.sock
netstat -ltnp 2>/dev/null | grep ':6006'
tr '\0' '\n' </proc/$(cat /root/codex-web/logs/codex-app-server.pid)/environ | grep -Ei '^(HTTP|HTTPS|ALL)_PROXY='
/root/.local/bin/codex-web-ensure-node-pty
```

## Security

Do not bind this directly to a public interface without an authentication layer.
Anyone who can reach the web UI can operate Codex as the user running the
server.

## Notes

- Observed on 2026-05-09: `npm install --omit=dev` completed successfully.
- A full `npm install` stalled in Electron's `node install.js` download step.
- Observed on 2026-05-09: password protection was verified on port `6006`.
- Observed on 2026-05-28: SeetaCloud direct Web access was started on
  `0.0.0.0:6006`; unauthenticated requests redirected to login, password login
  returned the app HTML, and the Codex app-server child connected successfully.
- Observed on 2026-05-28: autostart was installed through `/etc/autodl.sh` and
  verified by stopping the running server, invoking the boot hook, and checking
  that `0.0.0.0:6006` came back with password login and the Codex app-server
  child process.
- Observed on 2026-05-24: HTTP asset compression and WebSocket compression are
  enabled for tunnel usage; the main JS asset was served with `gzip`.
- Observed on 2026-05-24: the upstream webview index referenced 132 assets,
  including 123 `modulepreload` links. Disabling those preloads is the default
  tunnel-friendly behavior.
- Observed on 2026-05-24: upstream Statsig initialization could leave the UI on
  the full-screen loading state for about 75 seconds on the SSH-tunneled server.
- Observed on 2026-05-24: after asset caching, a clean Chromium run still took
  about 49.5 seconds to show the main UI while waiting on ChatGPT
  `account-info`. Removing that blocking gate reduced the same clean run to
  655 ms total, with DOMContentLoaded at 257 ms.
- Observed on 2026-05-24: `/root/.codex/sessions` was about 198 MB because
  rollout JSONL files include tool output, diffs, stdout/stderr, and some
  base64 image payloads. Keep using `/root/.codex` for synchronized CLI/Web
  state; the Chats list may populate asynchronously after the first screen.

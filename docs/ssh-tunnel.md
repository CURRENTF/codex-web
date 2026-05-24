# SSH Tunnel

## Purpose

Access `codex-web` from a local machine without exposing the web server to the
public network.

## Remote Service

On this host, `codex-web` listens on:

```text
127.0.0.1:6006
```

Keep it bound to loopback. The SSH tunnel is the access layer.

## Mac Client

Use the same SSH host, user, port, and identity file that you normally use to
log into this machine.

Preferred local wrapper:

```bash
codex-web-tunnel start -p <SSH_PORT> root@<SSH_HOST>
codex-web-tunnel ssh -p <SSH_PORT> root@<SSH_HOST>
codex-web-tunnel -p <SSH_PORT> root@<SSH_HOST>
codex-web-tunnel status
codex-web-tunnel open
```

The second and third forms are convenience aliases: they let you paste the SSH
connection command you normally use, with the leading `ssh` accepted and ignored
by the wrapper.

The wrapper starts both pieces needed on the Mac:

- the raw SSH tunnel on `127.0.0.1:16006`
- the cached local proxy on `127.0.0.1:6006`

The browser URL stays:

```text
http://127.0.0.1:6006
```

For a different server, pass that server's SSH endpoint:

```bash
codex-web-tunnel restart -p 12345 root@example.com
```

For multiple servers at the same time, give each one separate local ports:

```bash
codex-web-tunnel start \
  --local-web-port 6007 \
  --local-tunnel-port 16007 \
  -p 12345 root@example.com
```

Manual tunnel without the local cache:

```bash
ssh -N \
  -L 6006:127.0.0.1:6006 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -p <SSH_PORT> root@<SSH_HOST>
```

Then open this on the Mac:

```text
http://127.0.0.1:6006
```

## Cached Local Proxy

For slow links, keep the browser URL on local port `6006`, but move the raw SSH
tunnel to `16006` and put a local asset-caching proxy on `6006`. The
`codex-web-tunnel` wrapper starts both automatically. Manual equivalent:

```bash
ssh -fN \
  -L 16006:127.0.0.1:6006 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -p <SSH_PORT> root@<SSH_HOST>

CODEX_WEB_UPSTREAM=http://127.0.0.1:16006 \
CODEX_WEB_PROXY_PORT=6006 \
npm run cached-tunnel-proxy
```

Static `/assets/*` responses are cached under `~/.cache/codex-web/assets` on
the Mac. HTTP routes, login, and the IPC WebSocket are still forwarded to the
remote server through the SSH tunnel. This keeps normal browser access at:

```text
http://127.0.0.1:6006
```

The proxy can also be launched by `launchctl` for a long-lived local desktop
session. On 2026-05-24, Desktop project paths were not reliable as direct
`launchctl` program paths, so the runtime copy was placed under
`~/.cache/codex-web/runtime` and the asset cache under
`~/.cache/codex-web/assets`.

Observed working command on 2026-05-24:

```bash
ssh -fN \
  -L 16006:127.0.0.1:6006 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -p 22160 root@connect.westb.seetacloud.com
```

If local port `6006` is already in use, map another local port:

```bash
codex-web-tunnel start \
  --local-web-port 6007 \
  --local-tunnel-port 16007 \
  -p <SSH_PORT> root@<SSH_HOST>
```

Then open:

```text
http://127.0.0.1:6007
```

## Background Mode

After confirming the foreground command works, add `-f` to run the tunnel in the
background:

```bash
ssh -fN -L 6006:127.0.0.1:6006 -p <SSH_PORT> root@<SSH_HOST>
```

Stop it on the Mac with:

```bash
codex-web-tunnel stop
```

Manual cleanup:

```bash
pkill -f 'ssh.*6006:127.0.0.1:6006'
pkill -f 'ssh.*16006:127.0.0.1:6006'
pkill -f 'scripts/cached_tunnel_proxy.mjs'
launchctl remove com.codex-web.cached-proxy
```

## Verify

On the Mac:

```bash
curl -I http://127.0.0.1:6006
```

Expected before login:

```text
HTTP/1.1 302 Found
Location: /__auth/login
```

On the remote host:

```bash
tail -f /root/codex-web/logs/codex-web.log
```

Useful signals:

Set `CODEX_WEB_ACCESS_LOG=1` before starting `codex-web` if these request logs
are needed.

- `[http] GET / 302`: request reached the server but needs login.
- `[http] POST /__auth/login 302`: login accepted.
- `[ws] accepted /__backend/ipc`: browser WebSocket connected.
- `[ws] rejected /__backend/ipc`: login cookie was missing or stale.

## Performance

Sequential tunnel bandwidth is not the only limiter. On 2026-05-24, the
upstream webview entry referenced 132 assets, including 123 `modulepreload`
links. Over an SSH tunnel this can feel slow even when a single transfer reaches
about 2 MB/s, because many small requests pay latency and connection scheduling
costs before the app can finish startup.

The server strips those `modulepreload` links from `index.html` by default and
lets dynamic imports load chunks on demand. If testing on a low-latency LAN,
restore upstream preload behavior with:

```bash
CODEX_WEB_MODULEPRELOAD=1 node src/server/main.js --host 127.0.0.1 --port 6006
```

The server also keeps the main UI from waiting on Statsig network initialization,
which can otherwise leave the app on the initial loading screen for about 75
seconds on this SSH-tunneled host. Restore the upstream wait behavior only when
debugging feature flags:

```bash
CODEX_WEB_WAIT_FOR_STATSIG=1 node src/server/main.js --host 127.0.0.1 --port 6006
```

The final measured fixed delay was the ChatGPT `account-info` first-render gate:
with static assets cached, a clean Chromium run still took about 49.5 seconds
until the main UI appeared. Serving the main bundle with that gate moved to
background loading reduced the same clean run to 655 ms total and 257 ms
DOMContentLoaded.

Run the remote service with `CODEX_HOME=/root/.codex` so the web UI and normal
SSH `codex-cli` usage share sessions, projects, and auth state. The Chats list
can populate asynchronously after the first screen, so a brief initial `No
chats` state does not necessarily mean history is missing.

## Notes

- Observed on 2026-05-09: remote service is listening on `127.0.0.1:6006`.
- Use the configured web password after opening the tunnel.
- Observed on 2026-05-24: remote service was verified through the tunnel at
  `http://127.0.0.1:6006`.

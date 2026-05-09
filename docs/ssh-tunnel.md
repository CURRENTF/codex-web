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

If local port `6006` is already in use, map another local port:

```bash
ssh -N \
  -L 16006:127.0.0.1:6006 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -p <SSH_PORT> root@<SSH_HOST>
```

Then open:

```text
http://127.0.0.1:16006
```

## Background Mode

After confirming the foreground command works, add `-f` to run the tunnel in the
background:

```bash
ssh -fN -L 6006:127.0.0.1:6006 -p <SSH_PORT> root@<SSH_HOST>
```

Stop it on the Mac with:

```bash
pkill -f 'ssh.*6006:127.0.0.1:6006'
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

- `[http] GET / 302`: request reached the server but needs login.
- `[http] POST /__auth/login 302`: login accepted.
- `[ws] accepted /__backend/ipc`: browser WebSocket connected.
- `[ws] rejected /__backend/ipc`: login cookie was missing or stale.

## Notes

- Observed on 2026-05-09: remote service is listening on `127.0.0.1:6006`.
- Use the configured web password after opening the tunnel.

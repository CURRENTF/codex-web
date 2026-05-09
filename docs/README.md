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
CODEX_WEB_PASSWORD='<choose-a-password>' CODEX_CLI_PATH=/root/npm-global/bin/codex node src/server/main.js --host 127.0.0.1 --port 6006
```

Open `http://127.0.0.1:6006` from a browser on the same machine, or expose it
through an SSH tunnel / trusted private network.

If `CODEX_WEB_PASSWORD` is set, all HTTP routes and the IPC WebSocket require a
successful login first. The password is intentionally supplied by environment
variable instead of being committed to the repo.

## Security

Do not bind this directly to a public interface without an authentication layer.
Anyone who can reach the web UI can operate Codex as the user running the
server.

## Notes

- Observed on 2026-05-09: `npm install --omit=dev` completed successfully.
- A full `npm install` stalled in Electron's `node install.js` download step.
- Observed on 2026-05-09: password protection was verified on port `6006`.

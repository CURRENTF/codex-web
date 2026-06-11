#!/usr/bin/env node

import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = process.env.CODEX_WEB_REPO_DIR ?? path.resolve(scriptDir, "..");
const requireFromRepo = createRequire(path.join(repoDir, "package.json"));
const WebSocket = requireFromRepo("ws");

const socketPath =
  process.env.CODEX_UNIX_SOCKET ?? "/tmp/codex-web-app-server.sock";
const maxPayload = Number(process.env.CODEX_BUFFER_SIZE ?? 104857600);

let opened = false;
const pendingInput = [];

const ws = new WebSocket("ws://codex-app-server/", {
  createConnection: () => net.connect(socketPath),
  maxPayload,
  perMessageDeflate: false,
});

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[codex-web-app-server-proxy] ${message}`);
  process.exitCode = 1;
  try {
    ws.close();
  } catch {
    // Ignore close errors while failing.
  }
  process.stdin.pause();
}

ws.on("open", () => {
  opened = true;
  for (const chunk of pendingInput.splice(0)) {
    ws.send(chunk);
  }
  process.stdin.resume();
});

ws.on("message", (data) => {
  process.stdout.write(data);
});

ws.on("error", fail);

ws.on("close", () => {
  if (!opened) {
    fail(new Error(`failed to open app-server socket ${socketPath}`));
    return;
  }
  process.exit(0);
});

process.stdin.pause();
process.stdin.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  if (!opened) {
    pendingInput.push(text);
    return;
  }
  ws.send(text);
});
process.stdin.on("end", () => {
  ws.close();
});
process.stdin.on("error", fail);

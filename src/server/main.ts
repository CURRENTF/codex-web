#!/usr/bin/env node

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs as parseCliArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import Fastify, { type FastifyReply } from "fastify";
import fastifyCompress from "@fastify/compress";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { installModuleAliasHook } from "./module";
import { glob } from "glob";

type ServerOptions = {
  host: string;
  port: number;
};

type ConsoleMethod = "debug" | "info" | "log";

type LoginBody = {
  password?: string;
};

type MainAssetParams = {
  hash: string;
};

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    };

type MainToRendererMessage =
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    };

type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
};

type WorkspaceDirectoryEntries = {
  directoryPath: string;
  parentPath: string | null;
  entries: WorkspaceDirectoryEntry[];
};

function workspaceDirectoryEntryTypeRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.type === "directory" ? 0 : 1;
}

function workspaceDirectoryEntryHiddenRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.name.startsWith(".") ? 1 : 0;
}

function compareWorkspaceDirectoryEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry,
): number {
  return (
    workspaceDirectoryEntryTypeRank(left) -
      workspaceDirectoryEntryTypeRank(right) ||
    workspaceDirectoryEntryHiddenRank(left) -
      workspaceDirectoryEntryHiddenRank(right) ||
    left.name.localeCompare(right.name)
  );
}

type IpcMainBridgeState = {
  broadcastToRenderer?: (message: MainToRendererMessage) => void;
  sendToRendererWebContents?: (
    webContentsId: number,
    message: MainToRendererMessage,
  ) => void;
  handleRendererInvoke?: (
    channel: string,
    args: unknown[],
    sender?: RendererWebContentsBridge,
  ) => Promise<unknown>;
  handleRendererSend?: (
    channel: string,
    args: unknown[],
    sender?: RendererWebContentsBridge,
  ) => void;
};

const DEFAULT_RENDERER_WEB_CONTENTS_ID = 1001;

type RendererWebContentsBridge = {
  id: number;
  mainFrame: {
    url: string;
  };
  addListener: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => unknown;
  isDestroyed: () => boolean;
  off: (event: string, listener: (...args: unknown[]) => void) => unknown;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => unknown;
  send: (channel: string, ...args: unknown[]) => void;
};

let cachedWebviewIndexHtml: string | null = null;
const browserAssetCache = new Map<string, string>();
const browserAssetVersion = Date.now().toString(36);

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  server [--host <host>] [--port <port>]",
      "",
      "Defaults:",
      "  --host 127.0.0.1",
      "  --port 8214",
      "",
      "Examples:",
      "  yarn server",
      "  yarn server --port 9000",
    ].join("\n"),
  );
}

function shouldSuppressAppLog(args: unknown[]): boolean {
  if (process.env.CODEX_WEB_VERBOSE_APP_LOG === "1") {
    return false;
  }

  const [first] = args;
  return (
    typeof first === "string" &&
    (first.startsWith("[electron-fetch-wrapper] Fetch body=") ||
      first.startsWith("[electron-fetch-wrapper] Fetch-stream"))
  );
}

function installConsoleLogFilters(): void {
  const methods: ConsoleMethod[] = ["debug", "info", "log"];
  for (const method of methods) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (shouldSuppressAppLog(args)) {
        return;
      }
      original(...args);
    };
  }
}

function parsePort(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return parsed;
}

function parseServerArgs(args: string[]): ServerOptions {
  const parsed = parseCliArgs({
    args,
    allowPositionals: false,
    options: {
      help: {
        short: "h",
        type: "boolean",
      },
      host: {
        type: "string",
      },
      port: {
        type: "string",
      },
    },
    strict: true,
  });

  if (parsed.values.help) {
    printUsage();
    process.exit(0);
  }

  return {
    host: parsed.values.host ?? "127.0.0.1",
    port: parsed.values.port ? parsePort(parsed.values.port) : 8214,
  };
}

function getIpcMainBridgeState(): IpcMainBridgeState {
  const globals = globalThis as typeof globalThis & {
    __codexElectronIpcBridge?: IpcMainBridgeState;
  };
  if (!globals.__codexElectronIpcBridge) {
    globals.__codexElectronIpcBridge = {};
  }
  return globals.__codexElectronIpcBridge;
}

function createEmitter(): {
  addListener: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => unknown;
  emit: (event: string, ...args: unknown[]) => boolean;
  off: (event: string, listener: (...args: unknown[]) => void) => unknown;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => unknown;
} {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  const api = {
    on(event: string, listener: (...args: unknown[]) => void): unknown {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return api;
    },
    addListener(
      event: string,
      listener: (...args: unknown[]) => void,
    ): unknown {
      return api.on(event, listener);
    },
    once(event: string, listener: (...args: unknown[]) => void): unknown {
      const wrapped = (...args: unknown[]) => {
        api.removeListener(event, wrapped);
        listener(...args);
      };
      return api.on(event, wrapped);
    },
    removeListener(
      event: string,
      listener: (...args: unknown[]) => void,
    ): unknown {
      listeners.get(event)?.delete(listener);
      return api;
    },
    off(event: string, listener: (...args: unknown[]) => void): unknown {
      return api.removeListener(event, listener);
    },
    emit(event: string, ...args: unknown[]): boolean {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
      return true;
    },
  };

  return api;
}

function sendIpcMessage(
  socket: WebSocket,
  message: MainToRendererMessage,
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(message));
}

function createRendererWebContentsBridge(
  socket: WebSocket,
  webContentsId = DEFAULT_RENDERER_WEB_CONTENTS_ID,
): RendererWebContentsBridge {
  const emitter = createEmitter();
  const mainFrame = { url: "http://localhost:5175/" };
  let destroyed = false;

  socket.once("close", () => {
    destroyed = true;
    emitter.emit("destroyed");
  });

  return {
    // Upstream Electron code keys trust and host context off the registered
    // window webContents id. Keep this stable while routing sends per socket.
    id: webContentsId,
    mainFrame,
    isDestroyed: () => destroyed || socket.readyState !== WebSocket.OPEN,
    addListener: emitter.addListener,
    on: emitter.on,
    once: emitter.once,
    off: emitter.off,
    removeListener: emitter.removeListener,
    send(channel: string, ...args: unknown[]): void {
      const payload: MainToRendererMessage = {
        type: "ipc-main-event",
        channel,
        args,
      };
      sendIpcMessage(socket, payload);
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function parseCookies(cookieHeader: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of cookieHeader?.split(";") ?? []) {
    const [rawName, ...rawValueParts] = part.split("=");
    const name = rawName?.trim();
    if (!name) {
      continue;
    }
    cookies.set(name, decodeURIComponent(rawValueParts.join("=")));
  }
  return cookies;
}

function authTokenForPassword(password: string): string {
  return createHash("sha256")
    .update(`codex-web-auth:${password}`)
    .digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthenticated(
  cookieHeader: string | undefined,
  expectedToken: string | null,
): boolean {
  if (!expectedToken) {
    return true;
  }
  const token = parseCookies(cookieHeader).get("codex_web_auth");
  return token ? constantTimeEqual(token, expectedToken) : false;
}

function loginPage(message = ""): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Codex Web Login</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #111;
        color: #f7f7f7;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
      }
      main {
        width: min(360px, calc(100vw - 32px));
      }
      h1 {
        font-size: 22px;
        font-weight: 600;
        margin: 0 0 18px;
      }
      form {
        display: grid;
        gap: 12px;
      }
      input,
      button {
        box-sizing: border-box;
        width: 100%;
        border-radius: 6px;
        font: inherit;
      }
      input {
        border: 1px solid #444;
        background: #181818;
        color: inherit;
        padding: 11px 12px;
      }
      button {
        border: 0;
        background: #f7f7f7;
        color: #111;
        cursor: pointer;
        padding: 11px 12px;
        font-weight: 600;
      }
      p {
        min-height: 20px;
        margin: 10px 0 0;
        color: #ffb4a8;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Codex Web</h1>
      <form method="post" action="/__auth/login">
        <input name="password" type="password" autocomplete="current-password" placeholder="Password" autofocus />
        <button type="submit">Sign in</button>
      </form>
      <p>${message}</p>
    </main>
  </body>
</html>`;
}

function stripModulePreloadLinks(html: string): string {
  return html.replace(
    /\s*<link\b(?=[^>]*\brel=["']modulepreload["'])[^>]*>\s*/gi,
    "\n",
  );
}

function addBrowserAssetCacheBusters(html: string): string {
  return html.replace(
    /(<script\b[^>]*\bsrc=["']\.\/assets\/(?:preload|index-[^"']+|app-main-[^"']+)\.js)(["'])/gi,
    `$1?v=${browserAssetVersion}$2`,
  );
}

function redirectStatsigNetworkToLocalBootstrap(source: string): {
  source: string;
  redirected: boolean;
} {
  const localBootstrapResponse = [
    "networkOverrideFunc: async () => new Response(",
    "JSON.stringify({ has_updates: true, time: Date.now(), feature_gates: {}, dynamic_configs: {}, layer_configs: {}, param_stores: {}, sdkInfo: {} }),",
    '{ status: 200, headers: { "content-type": "application/json" } },',
    "),",
  ].join(" ");
  const patched = source.replace(
    /networkOverrideFunc:\s*[\w$]+,/,
    localBootstrapResponse,
  );

  return { source: patched, redirected: patched !== source };
}

function disableBlockingStatsigInit(source: string): string {
  if (process.env.CODEX_WEB_WAIT_FOR_STATSIG === "1") {
    return source;
  }

  const networkRedirect = redirectStatsigNetworkToLocalBootstrap(source);
  if (networkRedirect.redirected) {
    return networkRedirect.source;
  }

  const statsigInitPattern =
    /(\s*)let \{ client: ([\w$]+), isLoading: ([\w$]+) \} = \(0, ([\w$]+)\.useClientAsyncInit\)\(([^;]+?)\),\n\s*([\w$]+(?:\s*=\s*![\w$]+)?),\n\s*([\w$]+);/;
  const patched = source.replace(
    statsigInitPattern,
    (
      _match,
      indent: string,
      clientName: string,
      loadingName: string,
      namespaceName: string,
      args: string,
      firstDeclaration: string,
      secondDeclaration: string,
    ) =>
      `${indent}let { client: ${clientName}, isLoading: ${loadingName} } = (0, ${namespaceName}.useClientAsyncInit)(${args});\n` +
      `${indent}${loadingName} = false;\n` +
      `${indent}let ${firstDeclaration},\n` +
      `${indent}  ${secondDeclaration};`,
  );

  if (patched === source) {
    console.warn(
      "[browser-patch] Statsig async init gate was not found in the main asset",
    );
  }
  return patched;
}

function disableBlockingAccountInfoInit(source: string): string {
  const accountInfoGate =
    /if \(r\.isLoading \|\| a \|\| s \|\| \(([\w$]+) && ([\w$]+)\) \|\| \(\1 && ([\w$]+) && !([\w$]+)\)\) \{/;
  const patched = source.replace(
    accountInfoGate,
    "if (r.isLoading || a || s) {",
  );

  if (patched === source) {
    console.warn(
      "[browser-patch] account-info loading gate was not found in the main asset",
    );
  }
  return patched;
}

async function getPatchedMainAsset(assetPath: string): Promise<string> {
  const cached = browserAssetCache.get(assetPath);
  if (cached !== undefined) {
    return cached;
  }

  const source = await fs.readFile(assetPath, "utf8");
  const patched = disableBlockingAccountInfoInit(
    disableBlockingStatsigInit(source),
  );
  browserAssetCache.set(assetPath, patched);
  return patched;
}

async function getWebviewIndexHtml(webviewRoot: string): Promise<string> {
  if (cachedWebviewIndexHtml !== null) {
    return cachedWebviewIndexHtml;
  }

  const html = await fs.readFile(path.join(webviewRoot, "index.html"), "utf8");
  const preprocessedHtml =
    process.env.CODEX_WEB_MODULEPRELOAD === "1"
      ? html
      : stripModulePreloadLinks(html);
  cachedWebviewIndexHtml = addBrowserAssetCacheBusters(preprocessedHtml);
  return cachedWebviewIndexHtml;
}

async function sendPatchedMainAsset(
  reply: FastifyReply,
  webviewRoot: string,
  prefix: "app-main" | "index",
  hash: string,
): Promise<FastifyReply> {
  if (!/^[A-Za-z0-9_-]+$/.test(hash)) {
    return reply.code(404).send({ error: "Not Found" });
  }

  const assetPath = path.join(webviewRoot, "assets", `${prefix}-${hash}.js`);
  return reply
    .header("Content-Type", "text/javascript; charset=utf-8")
    .header("Cache-Control", "no-cache")
    .send(await getPatchedMainAsset(assetPath));
}

async function sendWebviewIndexHtml(
  reply: FastifyReply,
  webviewRoot: string,
): Promise<FastifyReply> {
  return reply
    .header("Content-Type", "text/html; charset=utf-8")
    .header("Cache-Control", "no-cache")
    .send(await getWebviewIndexHtml(webviewRoot));
}

async function getWorkspaceDirectoryEntries({
  directoryPath,
  directoriesOnly,
}: {
  directoryPath: string | null;
  directoriesOnly: boolean;
}): Promise<WorkspaceDirectoryEntries> {
  const requestedPath = directoryPath?.trim() || os.homedir();
  const resolvedPath = path.resolve(requestedPath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Directory not found: ${requestedPath}`);
  }

  const entries = (await fs.readdir(resolvedPath, { withFileTypes: true }))
    .flatMap((entry): WorkspaceDirectoryEntry[] => {
      const type = entry.isDirectory() ? "directory" : "file";
      if (directoriesOnly && type !== "directory") {
        return [];
      }

      return [
        {
          name: entry.name,
          path: path.join(resolvedPath, entry.name),
          type,
        },
      ];
    })
    .sort(compareWorkspaceDirectoryEntries);

  const rootPath = path.parse(resolvedPath).root;
  const parentPath =
    resolvedPath === rootPath ? null : path.dirname(resolvedPath);

  return {
    directoryPath: resolvedPath,
    parentPath,
    entries,
  };
}

function ensureElectronLikeProcessContext(): void {
  const versions = process.versions as NodeJS.ProcessVersions & {
    electron?: string;
  };
  if (!versions.electron) {
    Object.defineProperty(versions, "electron", {
      value: "41.2.0",
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  const processWithElectronFields = process as NodeJS.Process & {
    resourcesPath?: string;
    type?: string;
  };
  processWithElectronFields.resourcesPath ??= path.resolve(
    __dirname,
    "../../scratch/asar",
  );
  processWithElectronFields.type ??= "browser";
}

async function startIpcBridgeServer(options: ServerOptions): Promise<void> {
  const bridgeState = getIpcMainBridgeState();
  const app = Fastify({ logger: false });
  const websocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      threshold: 1024,
    },
  });
  const sockets = new Set<WebSocket>();
  const rendererSocketsByWebContentsId = new Map<number, WebSocket>();
  const configuredPassword = process.env.CODEX_WEB_PASSWORD?.trim() || null;
  const accessLogEnabled = process.env.CODEX_WEB_ACCESS_LOG === "1";
  const expectedAuthToken = configuredPassword
    ? authTokenForPassword(configuredPassword)
    : null;
  const webviewRoot = path.resolve(__dirname, "../../scratch/asar/webview");

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  if (accessLogEnabled) {
    app.addHook("onResponse", async (request, reply) => {
      console.log(
        `[http] ${request.method} ${request.url} ${reply.statusCode}`,
      );
    });
  }

  await app.register(fastifyCompress, {
    encodings: ["br", "gzip", "deflate"],
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: Infinity,
    },
  });

  const uploadRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-uploads-"),
  );

  app.get("/__auth/login", async (_request, reply) => {
    return reply.type("text/html").send(loginPage());
  });

  app.post<{ Body: LoginBody }>("/__auth/login", async (request, reply) => {
    const password = request.body?.password ?? "";
    if (
      !expectedAuthToken ||
      constantTimeEqual(authTokenForPassword(password), expectedAuthToken)
    ) {
      reply.header(
        "Set-Cookie",
        `codex_web_auth=${encodeURIComponent(expectedAuthToken ?? "disabled")}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
      );
      return reply.redirect("/");
    }

    return reply
      .code(401)
      .type("text/html")
      .send(loginPage("Invalid password"));
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!expectedAuthToken || request.url.startsWith("/__auth/login")) {
      return;
    }

    if (isAuthenticated(request.headers.cookie, expectedAuthToken)) {
      return;
    }

    if (request.method === "GET") {
      return reply.redirect("/__auth/login");
    }

    return reply.code(401).send({ error: "Unauthorized" });
  });

  app.post("/__backend/upload", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart upload body" });
    }

    const files = await Array.fromAsync(
      (async function* () {
        for await (const part of request.files()) {
          const label = part.filename?.trim() || "upload";

          const uploadedPath = path.join(uploadRoot, randomUUID());

          await fs.writeFile(uploadedPath, await part.toBuffer());

          yield {
            label,
            path: uploadedPath,
            fsPath: uploadedPath,
          };
        }
      })(),
    );

    return reply.send({ files });
  });

  await app.register(fastifyStatic, {
    root: "/",
    prefix: "/@fs/",
    decorateReply: false,
  });

  app.get("/", async (_request, reply) => {
    return sendWebviewIndexHtml(reply, webviewRoot);
  });

  app.get("/index.html", async (_request, reply) => {
    return sendWebviewIndexHtml(reply, webviewRoot);
  });

  app.get<{ Params: MainAssetParams }>(
    "/assets/index-:hash.js",
    async (request, reply) => {
      return sendPatchedMainAsset(
        reply,
        webviewRoot,
        "index",
        request.params.hash,
      );
    },
  );

  app.get<{ Params: MainAssetParams }>(
    "/assets/app-main-:hash.js",
    async (request, reply) => {
      return sendPatchedMainAsset(
        reply,
        webviewRoot,
        "app-main",
        request.params.hash,
      );
    },
  );

  await app.register(fastifyStatic, {
    root: webviewRoot,
    prefix: "/",
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/@fs/")) {
      return reply.code(404).send({ error: "Not Found" });
    }

    if (request.method === "GET") {
      return sendWebviewIndexHtml(reply, webviewRoot);
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  app.server.on("upgrade", (request, socket, head) => {
    const requestUrl = request.url ?? "/";
    const host = request.headers.host ?? "localhost";
    const url = new URL(requestUrl, `http://${host}`);
    if (
      url.pathname !== "/__backend/ipc" ||
      !isAuthenticated(request.headers.cookie, expectedAuthToken)
    ) {
      if (accessLogEnabled) {
        console.log(`[ws] rejected ${url.pathname}`);
      }
      socket.destroy();
      return;
    }

    if (accessLogEnabled) {
      console.log(`[ws] accepted ${url.pathname}`);
    }
    websocketServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      websocketServer.emit("connection", upgradedSocket, request);
    });
  });

  bridgeState.broadcastToRenderer = (message: MainToRendererMessage): void => {
    for (const socket of sockets) {
      sendIpcMessage(socket, message);
    }
  };

  bridgeState.sendToRendererWebContents = (
    webContentsId: number,
    message: MainToRendererMessage,
  ): void => {
    const socket = rendererSocketsByWebContentsId.get(webContentsId);
    if (!socket) {
      return;
    }
    sendIpcMessage(socket, message);
  };

  websocketServer.on("connection", (socket) => {
    const rendererWebContents = createRendererWebContentsBridge(socket);
    const previousSocket = rendererSocketsByWebContentsId.get(
      rendererWebContents.id,
    );
    if (previousSocket && previousSocket !== socket && accessLogEnabled) {
      console.log(
        `[ws] renderer webContents ${rendererWebContents.id} superseded`,
      );
    }
    rendererSocketsByWebContentsId.set(rendererWebContents.id, socket);
    sockets.add(socket);

    socket.on("close", () => {
      sockets.delete(socket);
      if (
        rendererSocketsByWebContentsId.get(rendererWebContents.id) === socket
      ) {
        rendererSocketsByWebContentsId.delete(rendererWebContents.id);
      }
    });

    socket.on("message", (rawData) => {
      let message: RendererToMainMessage;
      try {
        message = JSON.parse(String(rawData)) as RendererToMainMessage;
      } catch (error) {
        console.error("[ipc-bridge] invalid JSON payload", error);
        return;
      }

      if (message.type === "ipc-renderer-send") {
        bridgeState.handleRendererSend?.(
          message.channel,
          message.args,
          rendererWebContents,
        );
        return;
      }

      if (message.type === "workspace-directory-entries-request") {
        const { requestId } = message;
        getWorkspaceDirectoryEntries(message)
          .then((result) => {
            const payload: MainToRendererMessage = {
              type: "workspace-directory-entries-result",
              requestId,
              ok: true,
              result,
            };
            sendIpcMessage(socket, payload);
          })
          .catch((error) => {
            const payload: MainToRendererMessage = {
              type: "workspace-directory-entries-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            };
            sendIpcMessage(socket, payload);
          });
        return;
      }

      if (message.type === "ipc-renderer-invoke") {
        const { channel, requestId, args } = message;
        Promise.resolve(
          bridgeState.handleRendererInvoke?.(
            channel,
            args,
            rendererWebContents,
          ) ??
            Promise.reject(
              new Error(
                `[ipc-bridge] no ipcMain.handle for channel ${channel}`,
              ),
            ),
        )
          .then((result) => {
            const payload: MainToRendererMessage = {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: true,
              result,
            };
            sendIpcMessage(socket, payload);
          })
          .catch((error) => {
            const payload: MainToRendererMessage = {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            };
            sendIpcMessage(socket, payload);
          });
      }
    });
  });

  await app.listen({ host: options.host, port: options.port });
  console.log(`IPC bridge listening at ws://${options.host}:${options.port}`);

  ensureElectronLikeProcessContext();
  installModuleAliasHook();

  const matches = await glob("../../scratch/asar/.vite/build/main-*.js", {
    nodir: true,
    cwd: __dirname,
  });

  if (matches.length === 0) {
    throw new Error("no main bundle found");
  }

  if (matches.length > 1) {
    throw new Error("multiple main bundles found");
  }

  installConsoleLogFilters();

  const module = require(matches[0]!);
  module.runMainAppStartup();
}

async function main(args: string[]) {
  const options = parseServerArgs(args);

  await startIpcBridgeServer(options);
}

main(process.argv.slice(2));

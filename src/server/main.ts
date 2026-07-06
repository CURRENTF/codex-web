#!/usr/bin/env node

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs as parseCliArgs } from "node:util";
import { WebSocket, WebSocketServer, type RawData } from "ws";
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

type PathsExistBody = {
  hostId?: string;
  paths?: string[];
};

type GlobalStateBody = {
  deletedKeys?: string[];
  key?: string;
  value?: unknown;
  values?: Record<string, unknown>;
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
    }
  | {
      type: "codex-web-route-state";
      browserPath: string;
      memoryPath: string;
      conversationId: string | null;
      sourceUrl?: string;
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

type AppServerRequest = {
  id: string | number;
  method: string;
  params?: unknown;
};

type AppServerResponse = {
  id: string | number;
  result?: unknown;
  error?: unknown;
};

type AppServerNotification = {
  method: string;
  params?: unknown;
};

type AppServerRequestMessageFromView = {
  type: "mcp-request" | "thread-prewarm-start";
  hostId?: unknown;
  request?: unknown;
};

type AppServerResponseMessageFromView = {
  type: "mcp-response";
  hostId?: unknown;
  response?: unknown;
};

type AppServerMessageFromView =
  | AppServerRequestMessageFromView
  | AppServerResponseMessageFromView;

type AppServerBridgeOptions = {
  broadcastToRenderer: (payload: unknown) => void;
  maxPayload: number;
  socketPath: string;
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

type RendererWebContentsBridgeRouter = {
  createBridgeForSocket: (socket: WebSocket) => RendererWebContentsBridge;
};

const RENDERER_REATTACH_GRACE_MS = 2_000;

let cachedWebviewIndexHtml: string | null = null;
const browserAssetCache = new Map<string, string>();
const browserAssetVersion = Date.now().toString(36);

const activeWorkspaceRootsKey = "active-workspace-roots";
const globalStateStorageKey = "codex-web:global-state";
const workspaceRootLabelsKey = "electron-workspace-root-labels";
const workspaceRootOptionsStorageKey = "codex-web:workspace-root-options";
const workspaceRootOptionsKey = "electron-saved-workspace-roots";

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

function parsePositiveInteger(
  raw: string | undefined,
  fallback: number,
): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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

function createRendererWebContentsBridgeRouter(): RendererWebContentsBridgeRouter {
  const openSockets = new Set<WebSocket>();
  const socketOrder: WebSocket[] = [];

  function pruneClosedSockets(): void {
    for (let index = socketOrder.length - 1; index >= 0; index -= 1) {
      const socket = socketOrder[index];
      if (socket && openSockets.has(socket)) {
        continue;
      }
      socketOrder.splice(index, 1);
    }
  }

  function getOpenSocket(preferredSocket?: WebSocket): WebSocket | null {
    if (
      preferredSocket &&
      openSockets.has(preferredSocket) &&
      preferredSocket.readyState === WebSocket.OPEN
    ) {
      return preferredSocket;
    }

    for (let index = socketOrder.length - 1; index >= 0; index -= 1) {
      const socket = socketOrder[index];
      if (socket?.readyState === WebSocket.OPEN && openSockets.has(socket)) {
        return socket;
      }
    }

    return null;
  }

  function attachSocket(socket: WebSocket): void {
    openSockets.add(socket);
    socketOrder.push(socket);
    socket.once("close", () => {
      openSockets.delete(socket);
      pruneClosedSockets();
    });
  }

  function sendToSocket(
    socket: WebSocket,
    message: MainToRendererMessage,
  ): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(message));
  }

  return {
    createBridgeForSocket(socket: WebSocket): RendererWebContentsBridge {
      const emitter = createEmitter();
      const mainFrame = { url: "http://localhost:5175/" };
      let destroyed = false;

      attachSocket(socket);
      socket.once("close", () => {
        setTimeout(() => {
          if (getOpenSocket()) {
            return;
          }
          destroyed = true;
          emitter.emit("destroyed");
        }, RENDERER_REATTACH_GRACE_MS);
      });

      return {
        // Upstream Electron code keys trust and host context off the registered
        // window webContents id. Keep this stable while routing sends per socket.
        id: 1001,
        mainFrame,
        isDestroyed: () => destroyed,
        addListener: emitter.addListener,
        on: emitter.on,
        once: emitter.once,
        off: emitter.off,
        removeListener: emitter.removeListener,
        send(channel: string, ...args: unknown[]): void {
          if (destroyed) {
            return;
          }
          const targetSocket = getOpenSocket(socket);
          if (!targetSocket) {
            return;
          }
          sendToSocket(targetSocket, {
            type: "ipc-main-event",
            channel,
            args,
          });
        },
      };
    },
  };
}

function getRegisteredRendererWebContents(): RendererWebContentsBridge | null {
  try {
    const requireFunction = eval("require") as (id: string) => {
      BrowserWindow?: {
        getAllWindows?: () => Array<{
          isDestroyed?: () => boolean;
          webContents?: RendererWebContentsBridge;
        }>;
      };
    };
    const electron = requireFunction("electron");
    const windows = electron.BrowserWindow?.getAllWindows?.() ?? [];
    for (const window of windows) {
      if (window.isDestroyed?.() === true) {
        continue;
      }
      if (window.webContents) {
        return window.webContents;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function syncRegisteredRendererWebContentsUrl(sourceUrl: string): void {
  const registeredWebContents = getRegisteredRendererWebContents();
  if (!registeredWebContents) {
    return;
  }

  registeredWebContents.mainFrame.url = sourceUrl;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAppServerRequest(value: unknown): value is AppServerRequest {
  return (
    isRecord(value) &&
    (typeof value.id === "string" || typeof value.id === "number") &&
    typeof value.method === "string"
  );
}

function isAppServerResponse(value: unknown): value is AppServerResponse {
  return (
    isRecord(value) &&
    (typeof value.id === "string" || typeof value.id === "number") &&
    ("result" in value || "error" in value)
  );
}

function isAppServerNotification(
  value: unknown,
): value is AppServerNotification {
  return (
    isRecord(value) && typeof value.method === "string" && !("id" in value)
  );
}

function isAppServerMessageFromView(
  value: unknown,
): value is AppServerMessageFromView {
  return (
    isRecord(value) &&
    (value.type === "mcp-request" ||
      value.type === "thread-prewarm-start" ||
      value.type === "mcp-response")
  );
}

function appServerRequestIdKey(id: string | number): string {
  return String(id);
}

function normalizeHostId(hostId: unknown): string {
  return typeof hostId === "string" && hostId ? hostId : "local";
}

function appServerVersionFromInitializeResult(result: unknown): string | null {
  if (!isRecord(result) || typeof result.userAgent !== "string") {
    return null;
  }

  return result.userAgent.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

function appServerErrorPayload(error: unknown): { message: string } {
  return { message: errorMessage(error) };
}

function expandHomePath(value: unknown): unknown {
  if (value === "~") {
    return os.homedir();
  }
  if (typeof value === "string" && value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function codexHomeDirectory(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

function globalStatePath(): string {
  return path.join(codexHomeDirectory(), ".codex-global-state.json");
}

async function readGlobalStateFile(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(globalStatePath(), "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeGlobalStateFile(
  globalState: Record<string, unknown>,
): Promise<void> {
  const filePath = globalStatePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(globalState, null, 2)}\n`);
  await fs.rename(tmpPath, filePath);
}

async function patchGlobalStateFile(
  body: GlobalStateBody | undefined,
): Promise<Record<string, unknown>> {
  const globalState = await readGlobalStateFile();
  const values = isRecord(body?.values) ? body.values : {};

  for (const [key, value] of Object.entries(values)) {
    globalState[key] = value;
  }

  if (typeof body?.key === "string") {
    if (body.value === undefined) {
      delete globalState[body.key];
    } else {
      globalState[body.key] = body.value;
    }
  }

  for (const key of isStringArray(body?.deletedKeys) ? body.deletedKeys : []) {
    delete globalState[key];
  }

  await writeGlobalStateFile(globalState);
  return globalState;
}

function normalizeDynamicToolSpec(tool: unknown): unknown {
  if (!isRecord(tool)) {
    return tool;
  }

  if (tool.type === "function") {
    return {
      ...tool,
      inputSchema: tool.inputSchema ?? {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    };
  }

  if (tool.type === "namespace" && Array.isArray(tool.tools)) {
    return {
      ...tool,
      tools: tool.tools.map((namespaceTool) =>
        isRecord(namespaceTool)
          ? {
              ...namespaceTool,
              type: "function",
              inputSchema: namespaceTool.inputSchema ?? {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            }
          : namespaceTool,
      ),
    };
  }

  return tool;
}

function shouldReturnEmptyPastedTextAttachments(
  request: AppServerRequest,
): boolean {
  return (
    request.method === "fs/readFile" &&
    isRecord(request.params) &&
    request.params.path === "attachments/pasted-text-attachments.json"
  );
}

function emptyPastedTextAttachmentsResponse(): AppServerResponse {
  return {
    id: "pasted-text-attachments",
    result: {
      dataBase64: Buffer.from("[]", "utf8").toString("base64"),
    },
  };
}

function normalizeAppServerRequest(
  request: AppServerRequest,
): AppServerRequest {
  if (!isRecord(request.params)) {
    return request;
  }

  const params = { ...request.params };
  params.cwd = expandHomePath(params.cwd);
  params.path = expandHomePath(params.path);
  if (Array.isArray(params.runtimeWorkspaceRoots)) {
    params.runtimeWorkspaceRoots = params.runtimeWorkspaceRoots.map((root) =>
      expandHomePath(root),
    );
  }
  if (request.method === "thread/start" && Array.isArray(params.dynamicTools)) {
    params.dynamicTools = [];
  }
  if (request.method === "thread/start") {
    params.modelProvider = "openai";
    params.model_provider = "openai";
  }

  return {
    ...request,
    params,
  };
}

class CodexAppServerBridge {
  private initializePromise: Promise<void> | null = null;
  private socket: WebSocket | null = null;
  private readonly pendingRequestHostIds = new Map<string, string>();
  private readonly pendingServerRequestHostIds = new Map<string, string>();

  constructor(private readonly options: AppServerBridgeOptions) {}

  canHandleMessageFromView(value: unknown): boolean {
    return isAppServerMessageFromView(value);
  }

  async handleMessageFromView(message: unknown): Promise<void> {
    if (!isAppServerMessageFromView(message)) {
      return;
    }

    if (
      message.type === "mcp-request" ||
      message.type === "thread-prewarm-start"
    ) {
      await this.forwardClientRequest(message);
      return;
    }

    if (message.type === "mcp-response") {
      await this.forwardClientResponse(message);
    }
  }

  private async forwardClientRequest(
    message: AppServerRequestMessageFromView,
  ): Promise<void> {
    if (!isAppServerRequest(message.request)) {
      throw new Error("[app-server-bridge] invalid app-server request payload");
    }

    const request = normalizeAppServerRequest(message.request);
    const hostId = normalizeHostId(message.hostId);
    if (shouldReturnEmptyPastedTextAttachments(request)) {
      this.broadcastMcpResponse(hostId, {
        ...emptyPastedTextAttachmentsResponse(),
        id: request.id,
      });
      return;
    }

    this.pendingRequestHostIds.set(appServerRequestIdKey(request.id), hostId);

    try {
      await this.send(request);
    } catch (error) {
      this.pendingRequestHostIds.delete(appServerRequestIdKey(request.id));
      this.broadcastMcpResponse(hostId, {
        id: request.id,
        error: appServerErrorPayload(error),
      });
      throw error;
    }
  }

  private async forwardClientResponse(
    message: AppServerResponseMessageFromView,
  ): Promise<void> {
    if (!isAppServerResponse(message.response)) {
      throw new Error(
        "[app-server-bridge] invalid app-server response payload",
      );
    }

    this.pendingServerRequestHostIds.delete(
      appServerRequestIdKey(message.response.id),
    );
    await this.send(message.response);
  }

  private async send(
    message: AppServerRequest | AppServerResponse,
  ): Promise<void> {
    await this.ensureInitialized();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("[app-server-bridge] app-server socket is not open");
    }
    socket.send(JSON.stringify(message));
  }

  private ensureInitialized(): Promise<void> {
    if (this.initializePromise) {
      return this.initializePromise;
    }

    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    const initializePromise = this.connectAndInitialize().catch((error) => {
      if (this.initializePromise === initializePromise) {
        this.initializePromise = null;
      }
      if (this.socket?.readyState !== WebSocket.OPEN) {
        this.socket = null;
      }
      throw error;
    });
    this.initializePromise = initializePromise;
    return initializePromise;
  }

  private async connectAndInitialize(): Promise<void> {
    const initId = `codex-web-init-${randomUUID()}`;
    const socket = new WebSocket("ws://codex-app-server/", {
      createConnection: () => net.connect(this.options.socketPath),
      maxPayload: this.options.maxPayload,
      perMessageDeflate: false,
    });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        socket.off("error", onError);
        socket.off("message", onInitializeMessage);
        socket.off("open", onOpen);
      };
      const fail = (error: unknown): void => {
        cleanup();
        reject(error);
      };
      const onError = (error: Error): void => {
        fail(error);
      };
      const onOpen = (): void => {
        socket.send(
          JSON.stringify({
            method: "initialize",
            id: initId,
            params: {
              clientInfo: {
                name: "codex-web",
                title: "Codex Web",
                version: "0.0.1",
              },
              capabilities: {
                experimentalApi: true,
                requestAttestation: false,
              },
            },
          }),
        );
      };
      const onInitializeMessage = (rawData: RawData): void => {
        let message: unknown;
        try {
          message = JSON.parse(String(rawData));
        } catch {
          return;
        }

        if (!isAppServerResponse(message) || message.id !== initId) {
          return;
        }

        cleanup();
        if ("error" in message) {
          reject(
            new Error(
              `[app-server-bridge] initialize failed: ${JSON.stringify(
                message.error,
              )}`,
            ),
          );
          return;
        }

        const appServerVersion = appServerVersionFromInitializeResult(
          message.result,
        );

        socket.on("message", (rawData) => {
          this.handleAppServerMessage(rawData);
        });
        socket.on("error", (error) => {
          this.failPendingRequests(error);
        });
        socket.on("close", () => {
          if (this.socket === socket) {
            this.socket = null;
            this.initializePromise = null;
          }
          this.failPendingRequests(
            new Error("[app-server-bridge] app-server connection closed"),
          );
        });
        socket.send(JSON.stringify({ method: "initialized" }));
        this.options.broadcastToRenderer({
          type: "codex-app-server-initialized",
          hostId: "local",
          appServerVersion,
          installedCodexVersion: null,
        });
        this.options.broadcastToRenderer({
          type: "codex-app-server-connection-changed",
          hostId: "local",
          state: "connected",
          error: null,
          transport: "websocket",
        });
        resolve();
      };

      socket.on("error", onError);
      socket.on("message", onInitializeMessage);
      socket.on("open", onOpen);
    });
  }

  private handleAppServerMessage(rawData: RawData): void {
    let message: unknown;
    try {
      message = JSON.parse(String(rawData));
    } catch (error) {
      console.error("[app-server-bridge] invalid JSON payload", error);
      return;
    }

    if (isAppServerResponse(message)) {
      const key = appServerRequestIdKey(message.id);
      const hostId = this.pendingRequestHostIds.get(key) ?? "local";
      this.pendingRequestHostIds.delete(key);
      this.broadcastMcpResponse(hostId, message);
      return;
    }

    if (isAppServerRequest(message)) {
      const hostId = "local";
      this.pendingServerRequestHostIds.set(
        appServerRequestIdKey(message.id),
        hostId,
      );
      this.options.broadcastToRenderer({
        type: "mcp-request",
        hostId,
        request: message,
      });
      return;
    }

    if (isAppServerNotification(message)) {
      this.options.broadcastToRenderer({
        type: "mcp-notification",
        hostId: "local",
        method: message.method,
        params: message.params,
      });
      return;
    }
  }

  private broadcastMcpResponse(
    hostId: string,
    message: AppServerResponse,
  ): void {
    this.options.broadcastToRenderer({
      type: "mcp-response",
      hostId,
      message,
    });
  }

  private failPendingRequests(error: unknown): void {
    const payload = appServerErrorPayload(error);
    for (const [requestId, hostId] of this.pendingRequestHostIds) {
      this.broadcastMcpResponse(hostId, { id: requestId, error: payload });
    }
    this.pendingRequestHostIds.clear();
    this.pendingServerRequestHostIds.clear();
  }
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

function jsonForInlineScript(value: unknown): string {
  return (JSON.stringify(value) ?? "null")
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function initialWorkspaceRootOptions(
  globalState: Record<string, unknown>,
): Record<string, unknown> {
  const roots = globalState[workspaceRootOptionsKey];
  const labels = globalState[workspaceRootLabelsKey];
  return {
    roots: isStringArray(roots) ? roots : [],
    ...(isRecord(labels) ? { labels } : {}),
  };
}

function injectInitialGlobalState(
  html: string,
  globalState: Record<string, unknown>,
): string {
  const workspaceRootOptions = initialWorkspaceRootOptions(globalState);
  const serializedGlobalState = jsonForInlineScript(globalState);
  const serializedGlobalStateStorage = jsonForInlineScript(
    JSON.stringify(globalState),
  );
  const serializedWorkspaceRootOptionsStorage = jsonForInlineScript(
    JSON.stringify(workspaceRootOptions),
  );
  const script = [
    "<script>",
    `window.__CODEX_WEB_INITIAL_GLOBAL_STATE__=${serializedGlobalState};`,
    "try{",
    `localStorage.setItem(${JSON.stringify(globalStateStorageKey)},${serializedGlobalStateStorage});`,
    `localStorage.setItem(${JSON.stringify(workspaceRootOptionsStorageKey)},${serializedWorkspaceRootOptionsStorage});`,
    "}catch(error){console.warn('[codex-web] failed to seed local state',error)}",
    "</script>",
  ].join("");

  return html.replace(/(<head\b[^>]*>)/i, `$1\n    ${script}`);
}

function removeMalformedStyleResidue(html: string): string {
  return html.replace(
    /\n\s*}\s*\n\s*<\/style>(\s*<script type="module" crossorigin src="\.\/assets\/index-)/,
    "\n$1",
  );
}

function setImmutableAssetCacheHeaders(response: {
  setHeader: (name: string, value: string) => void;
}): void {
  response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
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
  let patched = networkRedirect.source;

  const leadingStatsigInitPattern =
    /(\s*)let \{ client: ([\w$]+), isLoading: ([\w$]+) \} = \(0, ([\w$]+)\.useClientAsyncInit\)\(([^;]+?)\),\n\s*([\w$]+(?:\s*=\s*![\w$]+)?),\n\s*([\w$]+);/;
  patched = patched.replace(
    leadingStatsigInitPattern,
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

  const chainedStatsigInitPattern =
    /(\blet\s+[\w$]+\s*=\s*[\w$]+,\s*\{\s*client:\s*[\w$]+,\s*isLoading:\s*([\w$]+)\s*\}\s*=\s*\(0,\s*[\w$]+\.useClientAsyncInit\)\([^;]+?\),\s*[\w$]+;)/g;
  patched = patched.replace(
    chainedStatsigInitPattern,
    (match, declaration: string, loadingName: string) =>
      match.includes(`${loadingName} = false`)
        ? match
        : `${declaration}\n  ${loadingName} = false;`,
  );

  const compactStatsigInitPattern =
    /(\blet\s*\{\s*client:\s*[\w$]+,\s*isLoading:\s*([\w$]+)\s*\}\s*=\s*\(0,\s*[\w$]+\.useClientAsyncInit\)\([^;]+?\);)/g;
  patched = patched.replace(
    compactStatsigInitPattern,
    (match, declaration: string, loadingName: string) =>
      match.includes(`${loadingName} = false`)
        ? match
        : `${declaration}\n  ${loadingName} = false;`,
  );

  const statsigUserUpdateGatePattern =
    /(\n\s*)[\w$]+\s*\|\|\s*![\w$]+(\)\s*\)\s*\{\s*let\s+[\w$]+\s*=\s*`CodexStatsigProvider\.async`\s*\+\s*\([\w$]+\s*\?\s*``\s*:\s*`\.update`\))/g;
  patched = patched.replace(
    statsigUserUpdateGatePattern,
    "$1false$2",
  );

  if (patched === source) {
    console.warn(
      "[browser-patch] Statsig async init gate was not found in the main asset",
    );
  }
  return patched;
}

function disableBlockingAccountInfoInit(source: string): string {
  const legacyAccountInfoGate =
    /if \(r\.isLoading \|\| a \|\| s \|\| \(([\w$]+) && ([\w$]+)\) \|\| \(\1 && ([\w$]+) && !([\w$]+)\)\) \{/;
  let patched = source.replace(
    legacyAccountInfoGate,
    "if (r.isLoading || a || s) {",
  );

  const asyncIdentityAccountInfoGate =
    /if\s*\(\s*[\w$]+\s*\|\|\s*\([\w$]+\s*&&\s*![\w$]+\)\s*\)\s*\{/;
  patched = patched.replace(asyncIdentityAccountInfoGate, "if (false) {");

  if (patched === source) {
    console.warn(
      "[browser-patch] account-info loading gate was not found in the main asset",
    );
  }
  return patched;
}

function disableBlockingAuthBootstrap(source: string): string {
  const patched = source.replace(
    "if (r.isLoading || a || s) {",
    "if (a || s) {",
  );

  if (patched === source) {
    console.warn(
      "[browser-patch] auth bootstrap loading gate was not found in the main asset",
    );
  }
  return patched;
}

function disableBlockingDesktopAuthContext(source: string): string {
  const patched = source.replace(
    [
      "isLoading: m,",
      "        openAIAuth: x,",
      "        isCopilotApiAvailable: a,",
      "        authMethod: S,",
      "        requiresAuth: C,",
    ].join("\n"),
    [
      "isLoading: false,",
      "        openAIAuth: x,",
      "        isCopilotApiAvailable: a,",
      "        authMethod: S,",
      "        requiresAuth: false,",
    ].join("\n"),
  );

  if (patched === source) {
    console.warn(
      "[browser-patch] desktop auth context loading fields were not found in the main asset",
    );
  }
  return patched;
}

function useLocalAppHostServices(source: string): string {
  const patched = source.replace(
    "async function At(){$=kt(),jt=await $.services}",
    "async function At(){$={services:Ot.services},jt=Ot.services}",
  );

  if (patched === source && source.includes("connect-app-host")) {
    console.warn(
      "[browser-patch] app-host service bootstrap was not found in the RPC asset",
    );
  }
  return patched;
}

type PatchedBrowserAssetPrefix =
  | "app-main"
  | "get-attached-heartbeat-automation-for-thread"
  | "index"
  | "interrupted-turn-state"
  | "rpc";

function tolerateMissingRequestUserInputAutoResolution(source: string): string {
  const patched = source
    .replace(
      /(\b[$A-Z_a-z][$\w]*\.requestUserInputAutoResolution)\.setConversationPresented\?\./g,
      "$1?.setConversationPresented?.",
    )
    .replace(
      /(\b[$A-Z_a-z][$\w]*\.requestUserInputAutoResolution)\.recordConversationActivity\?\./g,
      "$1?.recordConversationActivity?.",
    );

  if (
    patched === source &&
    source.includes("requestUserInputAutoResolution")
  ) {
    console.warn(
      "[browser-patch] requestUserInputAutoResolution optional object guard was not found in the interrupted-turn-state asset",
    );
  }

  return patched;
}

function tolerateMissingHeartbeatAutomations(source: string): string {
  const patched = source.replace(
    /(\breturn\s+[$A-Z_a-z][$\w]*==null\?null:)([$A-Z_a-z][$\w]*)\.find\(/g,
    "$1($2??[]).find(",
  );

  if (patched === source && source.includes(".find(")) {
    console.warn(
      "[browser-patch] heartbeat automation list guard was not found in the get-attached-heartbeat-automation-for-thread asset",
    );
  }

  return patched;
}

function patchBrowserAsset(
  source: string,
  prefix: PatchedBrowserAssetPrefix,
): string {
  if (prefix === "app-main") {
    return disableBlockingAuthBootstrap(
      disableBlockingDesktopAuthContext(
        disableBlockingAccountInfoInit(disableBlockingStatsigInit(source)),
      ),
    );
  }

  if (prefix === "rpc") {
    return useLocalAppHostServices(source);
  }

  if (prefix === "interrupted-turn-state") {
    return tolerateMissingRequestUserInputAutoResolution(source);
  }

  if (prefix === "get-attached-heartbeat-automation-for-thread") {
    return tolerateMissingHeartbeatAutomations(source);
  }

  return source;
}

async function getPatchedBrowserAsset(
  assetPath: string,
  prefix: PatchedBrowserAssetPrefix,
): Promise<string> {
  const cached = browserAssetCache.get(assetPath);
  if (cached !== undefined) {
    return cached;
  }

  const source = await fs.readFile(assetPath, "utf8");
  const patched = patchBrowserAsset(source, prefix);
  browserAssetCache.set(assetPath, patched);
  return patched;
}

async function getWebviewIndexHtml(webviewRoot: string): Promise<string> {
  if (cachedWebviewIndexHtml !== null) {
    return injectInitialGlobalState(
      cachedWebviewIndexHtml,
      await readGlobalStateFile(),
    );
  }

  const html = await fs.readFile(path.join(webviewRoot, "index.html"), "utf8");
  const preprocessedHtml =
    process.env.CODEX_WEB_MODULEPRELOAD === "1"
      ? html
      : stripModulePreloadLinks(html);
  cachedWebviewIndexHtml = addBrowserAssetCacheBusters(
    removeMalformedStyleResidue(preprocessedHtml),
  );
  return injectInitialGlobalState(
    cachedWebviewIndexHtml,
    await readGlobalStateFile(),
  );
}

async function sendPatchedMainAsset(
  reply: FastifyReply,
  webviewRoot: string,
  prefix: PatchedBrowserAssetPrefix,
  hash: string,
): Promise<FastifyReply> {
  if (!/^[A-Za-z0-9_-]+$/.test(hash)) {
    return reply.code(404).send({ error: "Not Found" });
  }

  const assetPath = path.join(webviewRoot, "assets", `${prefix}-${hash}.js`);
  return reply
    .header("Content-Type", "text/javascript; charset=utf-8")
    .header("Cache-Control", "private, max-age=31536000, immutable")
    .send(await getPatchedBrowserAsset(assetPath, prefix));
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

async function existingPaths(paths: string[] | undefined): Promise<string[]> {
  const uniquePaths = [...new Set(paths ?? [])]
    .map((value) => expandHomePath(value))
    .filter((value): value is string => typeof value === "string" && !!value);
  const results = await Promise.all(
    uniquePaths.map(async (candidatePath) => {
      try {
        await fs.stat(candidatePath);
        return candidatePath;
      } catch {
        return null;
      }
    }),
  );

  return results.filter((value): value is string => value !== null);
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

  const processWithLinkedBinding = process as NodeJS.Process & {
    _linkedBinding?: (name: string) => unknown;
  };
  const originalLinkedBinding = processWithLinkedBinding._linkedBinding?.bind(
    process,
  );
  processWithLinkedBinding._linkedBinding = (name: string): unknown => {
    if (name === "electron_common_owl_features") {
      return {
        isOwlFeatureEnabled: () => false,
      };
    }
    if (originalLinkedBinding) {
      return originalLinkedBinding(name);
    }
    throw new Error(`No such binding was linked: ${name}`);
  };
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
  const rendererWebContentsBridgeRouter =
    createRendererWebContentsBridgeRouter();
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

  app.post<{ Body: PathsExistBody }>(
    "/__backend/paths-exist",
    async (request, reply) => {
      return reply.send({
        hostId: request.body?.hostId ?? "local",
        existingPaths: await existingPaths(request.body?.paths),
      });
    },
  );

  app.get("/__backend/global-state", async (_request, reply) => {
    return reply.send({ values: await readGlobalStateFile() });
  });

  app.post<{ Body: GlobalStateBody }>(
    "/__backend/global-state",
    async (request, reply) => {
      return reply.send({ values: await patchGlobalStateFile(request.body) });
    },
  );

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

  app.get<{ Params: MainAssetParams }>(
    "/assets/rpc-:hash.js",
    async (request, reply) => {
      return sendPatchedMainAsset(
        reply,
        webviewRoot,
        "rpc",
        request.params.hash,
      );
    },
  );

  app.get<{ Params: MainAssetParams }>(
    "/assets/interrupted-turn-state-:hash.js",
    async (request, reply) => {
      return sendPatchedMainAsset(
        reply,
        webviewRoot,
        "interrupted-turn-state",
        request.params.hash,
      );
    },
  );

  app.get<{ Params: MainAssetParams }>(
    "/assets/get-attached-heartbeat-automation-for-thread-:hash.js",
    async (request, reply) => {
      return sendPatchedMainAsset(
        reply,
        webviewRoot,
        "get-attached-heartbeat-automation-for-thread",
        request.params.hash,
      );
    },
  );

  await app.register(fastifyStatic, {
    root: webviewRoot,
    prefix: "/",
    setHeaders: setImmutableAssetCacheHeaders,
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
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  };

  const appServerBridge = new CodexAppServerBridge({
    broadcastToRenderer: (payload: unknown) => {
      bridgeState.broadcastToRenderer?.({
        type: "ipc-main-event",
        channel: "codex_desktop:message-for-view",
        args: [payload],
      });
    },
    maxPayload: parsePositiveInteger(process.env.CODEX_BUFFER_SIZE, 104857600),
    socketPath:
      process.env.CODEX_UNIX_SOCKET?.trim() || "/tmp/codex-web-app-server.sock",
  });

  websocketServer.on("connection", (socket) => {
    const socketRendererWebContents =
      rendererWebContentsBridgeRouter.createBridgeForSocket(socket);
    sockets.add(socket);

    socket.on("close", () => {
      sockets.delete(socket);
    });

    socket.on("message", (rawData) => {
      let message: RendererToMainMessage;
      try {
        message = JSON.parse(String(rawData)) as RendererToMainMessage;
      } catch (error) {
        console.error("[ipc-bridge] invalid JSON payload", error);
        return;
      }

      if (
        "sourceUrl" in message &&
        typeof message.sourceUrl === "string" &&
        message.sourceUrl
      ) {
        socketRendererWebContents.mainFrame.url = message.sourceUrl;
        syncRegisteredRendererWebContentsUrl(message.sourceUrl);
      }

      if (message.type === "codex-web-route-state") {
        return;
      }

      if (message.type === "ipc-renderer-send") {
        bridgeState.handleRendererSend?.(
          message.channel,
          message.args,
          socketRendererWebContents,
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
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          })
          .catch((error) => {
            const payload: MainToRendererMessage = {
              type: "workspace-directory-entries-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          });
        return;
      }

      if (message.type === "ipc-renderer-invoke") {
        const { channel, requestId, args } = message;
        if (
          channel === "codex_desktop:message-from-view" &&
          args.length === 1 &&
          appServerBridge.canHandleMessageFromView(args[0])
        ) {
          appServerBridge
            .handleMessageFromView(args[0])
            .then(() => {
              const payload: MainToRendererMessage = {
                type: "ipc-renderer-invoke-result",
                requestId,
                ok: true,
                result: undefined,
              };
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(payload));
              }
            })
            .catch((error) => {
              const payload: MainToRendererMessage = {
                type: "ipc-renderer-invoke-result",
                requestId,
                ok: false,
                errorMessage: errorMessage(error),
              };
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(payload));
              }
            });
          return;
        }

        Promise.resolve(
          bridgeState.handleRendererInvoke?.(
            channel,
            args,
            socketRendererWebContents,
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
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          })
          .catch((error) => {
            const payload: MainToRendererMessage = {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
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

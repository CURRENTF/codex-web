import {
  dispatchNavigateToRoute,
  mapBrowserPathToInitialRoute,
  mapMemoryPathToBrowserPath,
} from "./routes";
import {
  handleLocalFilePickerMessage,
  isLocalFilePickerMessage,
} from "./files";
import {
  installWorkspaceRootDialog,
  openSelectWorkspaceRootDialog,
  type WorkspaceDirectoryEntries,
} from "./workspace-root-dialog";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
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
      sourceUrl: string;
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

const RECONNECT_DELAY_MS = 1_000;

type MemoryNavigationChange = {
  action: "POP" | "PUSH" | "REPLACE";
  delta: number;
  location: {
    hash: string;
    key: string;
    pathname: string;
    search: string;
    state: unknown;
  };
};

type ElectronShimState = {
  initialRoute?: string;
  initialSidebarState?: boolean;
  closeSidebar?: () => void;
  onMemoryNavigationChanged?: (navigation: MemoryNavigationChange) => void;
  overrideAdapter?: {
    getGateOverride?: (
      e: StatsigGateEvaluation,
      ...args: unknown[]
    ) => StatsigGateEvaluation | null;
  };
};

type StatsigGateEvaluation = {
  name: string;
  value: boolean;
  [key: string]: unknown;
};

type ScheduledFakeUserPrompt = {
  id: string;
  conversationId: string;
  prompt: string;
  dueAtMs: number;
  createdAtMs: number;
  attempts?: number;
  status?: "pending" | "submitting" | "failed";
};

type ScheduledFakeUserPromptAck = {
  id: string;
  status: "accepted" | "sent" | "failed";
  errorMessage?: string;
};

type PendingRequest<T> = {
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
  socket: WebSocket | null;
};

declare global {
  interface Window {
    __ELECTRON_SHIM__?: ElectronShimState;
    __CODEX_WEB_SCHEDULED_FAKE_USER_PROMPTS__?: ScheduledFakeUserPrompt[];
    __CODEX_WEB_SCHEDULED_FAKE_USER_PROMPT_ACK__?: (
      ack: ScheduledFakeUserPromptAck,
    ) => void;
  }
}

declare const __CODEX_APP_VERSION__: string;

let requestCounter = 0;
let socket: WebSocket | null = null;
let reconnectTimeoutId: number | null = null;
const outboundQueue: RendererToMainMessage[] = [];
const pendingInvokes = new Map<string, PendingRequest<unknown>>();
const pendingDirectoryEntries = new Map<
  string,
  PendingRequest<WorkspaceDirectoryEntries>
>();
const rendererListeners = new Map<string, Set<IpcListener>>();

function unimplemented(method: string): never {
  debugger;
  throw new Error(`[electron-stub] ${method} is not implemented`);
}

export function emitRendererEvent(channel: string, args: unknown[]): void {
  const listeners = rendererListeners.get(channel);
  if (!listeners || listeners.size === 0) {
    return;
  }
  const event = { sender: null };
  for (const listener of listeners) {
    listener(event, ...args);
  }
}

function getScheduledFakeUserPrompts(): ScheduledFakeUserPrompt[] {
  return (window.__CODEX_WEB_SCHEDULED_FAKE_USER_PROMPTS__ ??= []);
}

function isScheduledFakeUserPrompt(
  value: unknown,
): value is ScheduledFakeUserPrompt {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prompt = value as Record<string, unknown>;
  return (
    typeof prompt.id === "string" &&
    typeof prompt.conversationId === "string" &&
    typeof prompt.prompt === "string" &&
    typeof prompt.dueAtMs === "number" &&
    typeof prompt.createdAtMs === "number"
  );
}

function emitScheduledFakeUserPromptAvailable(): void {
  window.dispatchEvent(new CustomEvent("codex-web-scheduled-fake-user-prompt"));
}

function storeScheduledFakeUserPrompt(value: unknown): void {
  if (!isScheduledFakeUserPrompt(value)) {
    console.warn("[codex-web] invalid scheduled fake-user prompt", value);
    return;
  }

  const prompts = getScheduledFakeUserPrompts();
  const existing = prompts.find((prompt) => prompt.id === value.id);
  if (!existing) {
    prompts.push({ ...value, status: "pending" });
  } else if (existing.status !== "submitting") {
    Object.assign(existing, value, { status: existing.status ?? "pending" });
  }

  dispatchNavigateToRoute(`/local/${value.conversationId}`);
  emitScheduledFakeUserPromptAvailable();
  window.setTimeout(emitScheduledFakeUserPromptAvailable, 250);
  window.setTimeout(emitScheduledFakeUserPromptAvailable, 1_000);
}

function handleIncomingMessage(message: MainToRendererMessage): void {
  if (message.type === "ipc-main-event") {
    if (message.channel === "codex_web:scheduled-fake-user-prompt") {
      storeScheduledFakeUserPrompt(message.args[0]);
      return;
    }

    emitRendererEvent(message.channel, message.args);
    return;
  }

  if (message.type === "ipc-renderer-invoke-result") {
    const pending = pendingInvokes.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingInvokes.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
    return;
  }

  if (message.type === "workspace-directory-entries-result") {
    const pending = pendingDirectoryEntries.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingDirectoryEntries.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
  }
}

function markMessageSent(
  message: RendererToMainMessage,
  sentSocket: WebSocket,
): void {
  if (message.type === "ipc-renderer-invoke") {
    const pending = pendingInvokes.get(message.requestId);
    if (pending) {
      pending.socket = sentSocket;
    }
    return;
  }

  if (message.type === "workspace-directory-entries-request") {
    const pending = pendingDirectoryEntries.get(message.requestId);
    if (pending) {
      pending.socket = sentSocket;
    }
  }
}

function rejectPendingRequestsForSocket(
  closedSocket: WebSocket,
  reason: Error,
): void {
  for (const [requestId, pending] of pendingInvokes) {
    if (pending.socket !== closedSocket) {
      continue;
    }
    pendingInvokes.delete(requestId);
    pending.reject(reason);
  }

  for (const [requestId, pending] of pendingDirectoryEntries) {
    if (pending.socket !== closedSocket) {
      continue;
    }
    pendingDirectoryEntries.delete(requestId);
    pending.reject(reason);
  }
}

function flushOutboundQueue(): void {
  const activeSocket = socket;
  if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  while (outboundQueue.length > 0) {
    const message = outboundQueue[0];
    if (!message) {
      return;
    }

    try {
      activeSocket.send(JSON.stringify(message));
    } catch (error) {
      console.error("[electron-stub] failed to send IPC bridge message", error);
      try {
        activeSocket.close();
      } catch {
        // Ignore close failures; the reconnect path below will recover.
      }
      if (socket === activeSocket) {
        socket = null;
      }
      rejectPendingRequestsForSocket(
        activeSocket,
        new Error("[electron-stub] IPC bridge disconnected"),
      );
      scheduleReconnect();
      return;
    }

    outboundQueue.shift();
    markMessageSent(message, activeSocket);
  }
}

function scheduleReconnect(): void {
  if (reconnectTimeoutId !== null) {
    return;
  }
  reconnectTimeoutId = window.setTimeout(() => {
    reconnectTimeoutId = null;
    ensureSocket();
  }, RECONNECT_DELAY_MS);
}

function ensureSocket(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const nextSocket = new WebSocket(
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/__backend/ipc`,
  );
  socket = nextSocket;
  nextSocket.addEventListener("open", () => {
    flushOutboundQueue();
  });
  nextSocket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as MainToRendererMessage;
      handleIncomingMessage(message);
    } catch (error) {
      console.error(
        "[electron-stub] failed to parse IPC bridge message",
        error,
      );
    }
  });
  nextSocket.addEventListener("close", () => {
    rejectPendingRequestsForSocket(
      nextSocket,
      new Error("[electron-stub] IPC bridge disconnected"),
    );
    if (socket === nextSocket) {
      socket = null;
    }
    scheduleReconnect();
  });
  nextSocket.addEventListener("error", () => {
    scheduleReconnect();
  });
}

function enqueueMessage(message: RendererToMainMessage): void {
  outboundQueue.push({
    ...message,
    sourceUrl: window.location.href,
  } as RendererToMainMessage);
  ensureSocket();
  flushOutboundQueue();
}

function nextRequestId(): string {
  requestCounter += 1;
  return `ipc_bridge_${requestCounter}`;
}

function invokeMain(channel: string, args: unknown[]): Promise<unknown> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingInvokes.set(requestId, { resolve, reject, socket: null });
    enqueueMessage({
      type: "ipc-renderer-invoke",
      requestId,
      channel,
      args,
    });
  });
}

function addIpcListener(channel: string, listener: IpcListener): void {
  const listeners = rendererListeners.get(channel) ?? new Set<IpcListener>();
  listeners.add(listener);
  rendererListeners.set(channel, listeners);
}

function shouldCloseSidebarForMemoryPath(path: string): boolean {
  return (
    path === "/" ||
    path.startsWith("/local/") ||
    path === "/skills" ||
    path === "/automations"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnhandledAddWorkspaceRootOptionMessage(value: unknown): value is {
  root?: unknown;
  type: "electron-add-new-workspace-root-option";
} {
  return (
    isRecord(value) &&
    value.type === "electron-add-new-workspace-root-option" &&
    typeof value.root !== "string"
  );
}

function isOpenInBrowserMessage(value: unknown): value is {
  type: "open-in-browser";
  url: string;
} {
  return (
    isRecord(value) &&
    value.type === "open-in-browser" &&
    typeof value.url === "string"
  );
}

function requestWorkspaceDirectoryEntries(
  directoryPath: string | null,
): Promise<WorkspaceDirectoryEntries> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingDirectoryEntries.set(requestId, { resolve, reject, socket: null });
    enqueueMessage({
      type: "workspace-directory-entries-request",
      requestId,
      directoryPath,
      directoriesOnly: true,
    });
  });
}

function conversationIdForMemoryPath(memoryPath: string): string | null {
  const match = memoryPath.match(/^\/local\/([^/?#]+)$/);
  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
}

function currentBrowserPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function reportRouteState(memoryPath: string): void {
  enqueueMessage({
    type: "codex-web-route-state",
    browserPath: currentBrowserPath(),
    memoryPath,
    conversationId: conversationIdForMemoryPath(memoryPath),
    sourceUrl: window.location.href,
  });
}

window.__CODEX_WEB_SCHEDULED_FAKE_USER_PROMPT_ACK__ = (
  ack: ScheduledFakeUserPromptAck,
) => {
  enqueueMessage({
    type: "ipc-renderer-send",
    channel: "codex_web:scheduled-fake-user-prompt-result",
    args: [ack],
  });
};

const themeMediaQuery = matchMedia("(prefers-color-scheme: dark)");
const mobileMediaQuery = matchMedia("(max-width: 768px)");
const initialSidebarState = !mobileMediaQuery.matches;
const electronShim = (window.__ELECTRON_SHIM__ ??= {});

electronShim.overrideAdapter = {
  getGateOverride(e) {
    if (e.name === "2929582856") {
      // codex_app_sunset
      return {
        ...e,
        value: false,
      };
    }

    return null;
  },
};

const initialRoute = mapBrowserPathToInitialRoute(
  window.location.pathname,
  window.location.search,
);
electronShim.initialRoute = initialRoute.memoryPath;
reportRouteState(initialRoute.memoryPath);

if (initialRoute.browserPath) {
  window.history.pushState(undefined, "", initialRoute.browserPath);
}

electronShim.initialSidebarState = initialSidebarState;
electronShim.onMemoryNavigationChanged = (navigation) => {
  const path = navigation.location.pathname;
  reportRouteState(path);
  if (
    navigation.action !== "POP" &&
    mobileMediaQuery.matches &&
    shouldCloseSidebarForMemoryPath(path)
  ) {
    electronShim.closeSidebar?.();
  }

  const browserPath = mapMemoryPathToBrowserPath(path);
  if (browserPath == null) {
    return;
  }

  if (browserPath.titleChange) {
    document.title = browserPath.titleChange;
  }

  if (window.location.pathname === browserPath.path) {
    window.history.replaceState(undefined, "", browserPath.path);
    return;
  }

  window.history.pushState(undefined, "", browserPath.path);
};

const buildFlavor: "prod" | "dev" | "agent" | string = "prod";

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === "codex_desktop:message-from-view" && args.length === 1) {
      if (isOpenInBrowserMessage(args[0])) {
        window.open(args[0].url, "_blank", "noopener,noreferrer");
      }

      if (isLocalFilePickerMessage(args[0])) {
        return handleLocalFilePickerMessage(args[0]);
      }

      if (isUnhandledAddWorkspaceRootOptionMessage(args[0])) {
        return openSelectWorkspaceRootDialog({
          listDirectory: requestWorkspaceDirectoryEntries,
        }).then((root) => {
          if (!root) {
            return undefined;
          }

          return invokeMain(channel, [{ ...args[0], root }]);
        });
      }
    }

    return invokeMain(channel, args);
  },
  on(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  once(channel: string, listener: IpcListener): unknown {
    const wrapped: IpcListener = (event, ...args) => {
      this.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    addIpcListener(channel, wrapped);
    return this;
  },
  addListener(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  removeListener(channel: string, listener: IpcListener): unknown {
    rendererListeners.get(channel)?.delete(listener);
    return this;
  },
  off(channel: string, listener: IpcListener): unknown {
    return this.removeListener(channel, listener);
  },
  send(channel: string, ...args: unknown[]): void {
    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args,
    });
  },
  sendSync(channel: string, ..._args: unknown[]): unknown {
    if (channel === "codex_desktop:get-sentry-init-options") {
      return {
        codexAppSessionId: "42626fde-7064-471f-b44d-b1a7ad849c7f",
        buildFlavor,
        buildNumber: null,
        appVersion: __CODEX_APP_VERSION__,
        enabled: false,
      };
    }

    if (channel === "codex_desktop:get-build-flavor") {
      return buildFlavor;
    }

    if (channel === "codex_desktop:get-shared-object-snapshot") {
      return {
        host_config: {
          id: "local",
          display_name: "Local",
          kind: "local",
        },
        remote_connections: [],
        remote_control_connections: [],
        remote_control_connections_state: {
          available: false,
          authRequired: false,
        },
        pending_worktrees: [],
        statsig_default_enable_features: {
          enable_request_compression: true,
          collaboration_modes: true,
          personality: true,
          request_rule: true,
          fast_mode: true,
          image_generation: true,
          image_detail_original: true,
          workspace_dependencies: true,
          guardian_approval: true,
          apps: false,
          plugins: true,
          tool_search: true,
          tool_suggest: false,
          tool_call_mcp_elicitation: true,
          memories: false,
          realtime_conversation: false,
        },
      };
    }

    if (channel === "codex_desktop:get-system-theme-variant") {
      return themeMediaQuery.matches ? "dark" : "light";
    }

    return unimplemented("ipcRenderer.sendSync");
  },
};

ensureSocket();

export const contextBridge = {
  exposeInMainWorld(_key: string, _api: unknown): void {
    Reflect.set(window, _key, _api);
  },
};

export const webUtils = {
  getPathForFile(_file: File): string | null {
    return null;
  },
};

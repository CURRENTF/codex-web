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

type BridgeConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

type HttpConnectionState =
  | "checking"
  | "reachable"
  | "unreachable"
  | "unauthorized"
  | "offline";

type CodexWebStatusResponse = {
  ok?: boolean;
  nowMs?: number;
  uptimeMs?: number;
  websocketClients?: number;
  ipcHandlersReady?: boolean;
  browserAssetVersion?: string;
};

type FloatingStatusState = {
  bridge: BridgeConnectionState;
  http: HttpConnectionState;
  webOnline: boolean;
  pageVisible: boolean;
  lastCheckedAtMs: number | null;
  latencyMs: number | null;
  websocketClients: number | null;
  ipcHandlersReady: boolean | null;
};

const STATUS_POLL_INTERVAL_MS = 5_000;
const STATUS_POLL_TIMEOUT_MS = 3_000;

const floatingStatusState: FloatingStatusState = {
  bridge: "connecting",
  http: "checking",
  webOnline: navigator.onLine,
  pageVisible: document.visibilityState !== "hidden",
  lastCheckedAtMs: null,
  latencyMs: null,
  websocketClients: null,
  ipcHandlersReady: null,
};

let floatingStatusRoot: HTMLDivElement | null = null;
let floatingStatusSummary: HTMLSpanElement | null = null;
let floatingStatusServerValue: HTMLSpanElement | null = null;
let floatingStatusHttpValue: HTMLSpanElement | null = null;
let floatingStatusWebValue: HTMLSpanElement | null = null;
let floatingStatusDetailValue: HTMLSpanElement | null = null;

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

function bridgeConnectionLabel(state: BridgeConnectionState): string {
  switch (state) {
    case "connected":
      return "connected";
    case "connecting":
      return "connecting";
    case "error":
      return "error";
    case "disconnected":
      return "disconnected";
  }
}

function httpConnectionLabel(state: HttpConnectionState): string {
  switch (state) {
    case "reachable":
      return "reachable";
    case "checking":
      return "checking";
    case "unauthorized":
      return "login required";
    case "offline":
      return "offline";
    case "unreachable":
      return "unreachable";
  }
}

function formatLastChecked(timestampMs: number | null): string {
  if (timestampMs === null) {
    return "not checked yet";
  }

  const secondsAgo = Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
  if (secondsAgo < 3) {
    return "just now";
  }
  if (secondsAgo < 60) {
    return `${secondsAgo}s ago`;
  }
  return `${Math.round(secondsAgo / 60)}m ago`;
}

function currentFloatingStatusTone(): "good" | "warn" | "bad" {
  if (
    !floatingStatusState.webOnline ||
    floatingStatusState.http === "offline"
  ) {
    return "bad";
  }

  if (
    floatingStatusState.bridge === "connected" &&
    floatingStatusState.http === "reachable"
  ) {
    return "good";
  }

  if (
    floatingStatusState.bridge === "connecting" ||
    floatingStatusState.http === "checking"
  ) {
    return "warn";
  }

  return "bad";
}

function updateFloatingStatusPanel(): void {
  ensureFloatingStatusPanel();
  if (!floatingStatusRoot) {
    return;
  }

  const serverLabel = bridgeConnectionLabel(floatingStatusState.bridge);
  const webLabel = floatingStatusState.webOnline ? "online" : "offline";
  const httpLabel = httpConnectionLabel(floatingStatusState.http);
  floatingStatusRoot.dataset.tone = currentFloatingStatusTone();

  if (floatingStatusSummary) {
    floatingStatusSummary.textContent = `Server ${serverLabel} · Web ${webLabel}`;
  }
  if (floatingStatusServerValue) {
    floatingStatusServerValue.textContent = serverLabel;
  }
  if (floatingStatusHttpValue) {
    floatingStatusHttpValue.textContent =
      floatingStatusState.latencyMs !== null &&
      floatingStatusState.http === "reachable"
        ? `${httpLabel} (${floatingStatusState.latencyMs} ms)`
        : httpLabel;
  }
  if (floatingStatusWebValue) {
    floatingStatusWebValue.textContent = floatingStatusState.webOnline
      ? "online"
      : "offline";
  }
  if (floatingStatusDetailValue) {
    const socketText =
      floatingStatusState.websocketClients === null
        ? "sockets unknown"
        : `${floatingStatusState.websocketClients} socket${
            floatingStatusState.websocketClients === 1 ? "" : "s"
          }`;
    const ipcText =
      floatingStatusState.ipcHandlersReady === null
        ? "IPC unknown"
        : floatingStatusState.ipcHandlersReady
          ? "IPC ready"
          : "IPC starting";
    floatingStatusDetailValue.textContent = `${ipcText} · ${socketText} · checked ${formatLastChecked(
      floatingStatusState.lastCheckedAtMs,
    )}`;
  }

  floatingStatusRoot.setAttribute(
    "aria-label",
    `Codex Web status: server ${serverLabel}, HTTP ${httpLabel}, web ${webLabel}`,
  );
}

function setFloatingStatusState(patch: Partial<FloatingStatusState>): void {
  Object.assign(floatingStatusState, patch);
  updateFloatingStatusPanel();
}

function createFloatingStatusRow(label: string): {
  row: HTMLDivElement;
  value: HTMLSpanElement;
} {
  const row = document.createElement("div");
  row.className = "codex-web-status-row";

  const labelElement = document.createElement("span");
  labelElement.className = "codex-web-status-label";
  labelElement.textContent = label;

  const value = document.createElement("span");
  value.className = "codex-web-status-value";

  row.append(labelElement, value);
  return { row, value };
}

function ensureFloatingStatusPanel(): void {
  if (floatingStatusRoot || !document.body) {
    return;
  }

  const style = document.createElement("style");
  style.textContent = `
.codex-web-floating-status {
  position: fixed;
  left: 50%;
  top: 50%;
  z-index: 2147483647;
  width: 26px;
  height: 26px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: color-mix(in srgb, Canvas 92%, transparent);
  color: CanvasText;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.22);
  font: 12px/1.35 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  letter-spacing: 0;
  overflow: hidden;
  transform: translate(-50%, -50%);
  transition: width 140ms ease, height 140ms ease, border-radius 140ms ease;
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
}

.codex-web-floating-status[data-expanded="true"] {
  width: min(320px, calc(100vw - 28px));
  height: auto;
  border-radius: 8px;
}

.codex-web-floating-status[data-tone="good"] {
  --codex-web-status-dot: #16a34a;
}

.codex-web-floating-status[data-tone="warn"] {
  --codex-web-status-dot: #d97706;
}

.codex-web-floating-status[data-tone="bad"] {
  --codex-web-status-dot: #dc2626;
}

.codex-web-status-summary {
  display: flex;
  min-height: 24px;
  align-items: center;
  justify-content: center;
  gap: 0;
  padding: 0;
  cursor: pointer;
  user-select: none;
}

.codex-web-status-dot {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--codex-web-status-dot, #d97706);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--codex-web-status-dot, #d97706) 20%, transparent);
}

.codex-web-status-summary-text {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

.codex-web-status-details {
  display: grid;
  max-height: 0;
  overflow: hidden;
  border-top: 0 solid transparent;
  opacity: 0;
  transition: max-height 140ms ease, opacity 140ms ease, border-top-width 140ms ease;
}

.codex-web-floating-status[data-expanded="true"] .codex-web-status-details {
  max-height: 160px;
  border-top-width: 1px;
  border-top-color: rgba(127, 127, 127, 0.25);
  opacity: 1;
}

.codex-web-status-row {
  display: grid;
  grid-template-columns: minmax(72px, auto) minmax(0, 1fr);
  gap: 12px;
  padding: 7px 10px;
}

.codex-web-status-label {
  color: color-mix(in srgb, CanvasText 58%, transparent);
}

.codex-web-status-value {
  min-width: 0;
  overflow: hidden;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 640px) {
  .codex-web-floating-status[data-expanded="true"] {
    width: min(300px, calc(100vw - 20px));
  }
}
`;
  document.head.append(style);

  const root = document.createElement("div");
  root.className = "codex-web-floating-status";
  root.dataset.expanded = "false";
  root.role = "status";
  root.tabIndex = 0;

  const summary = document.createElement("div");
  summary.className = "codex-web-status-summary";
  const dot = document.createElement("span");
  dot.className = "codex-web-status-dot";
  floatingStatusSummary = document.createElement("span");
  floatingStatusSummary.className = "codex-web-status-summary-text";
  summary.append(dot, floatingStatusSummary);

  const details = document.createElement("div");
  details.className = "codex-web-status-details";
  const serverRow = createFloatingStatusRow("Server");
  const httpRow = createFloatingStatusRow("HTTP");
  const webRow = createFloatingStatusRow("Web");
  const detailRow = createFloatingStatusRow("Detail");
  floatingStatusServerValue = serverRow.value;
  floatingStatusHttpValue = httpRow.value;
  floatingStatusWebValue = webRow.value;
  floatingStatusDetailValue = detailRow.value;
  details.append(serverRow.row, httpRow.row, webRow.row, detailRow.row);
  root.append(summary, details);

  root.addEventListener("click", () => {
    root.dataset.expanded = root.dataset.expanded === "true" ? "false" : "true";
  });

  floatingStatusRoot = root;
  document.body.append(root);
}

function installFloatingStatusPanel(): void {
  if (document.body) {
    ensureFloatingStatusPanel();
    updateFloatingStatusPanel();
    return;
  }

  window.addEventListener(
    "DOMContentLoaded",
    () => {
      ensureFloatingStatusPanel();
      updateFloatingStatusPanel();
    },
    { once: true },
  );
}

async function pollCodexWebStatus(): Promise<void> {
  if (!navigator.onLine) {
    setFloatingStatusState({
      http: "offline",
      webOnline: false,
      lastCheckedAtMs: Date.now(),
      latencyMs: null,
    });
    return;
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, STATUS_POLL_TIMEOUT_MS);
  const startedAt = performance.now();

  try {
    const response = await fetch("/__backend/status", {
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (response.status === 401) {
      setFloatingStatusState({
        http: "unauthorized",
        webOnline: navigator.onLine,
        lastCheckedAtMs: Date.now(),
        latencyMs,
        ipcHandlersReady: null,
        websocketClients: null,
      });
      return;
    }

    if (!response.ok) {
      setFloatingStatusState({
        http: "unreachable",
        webOnline: navigator.onLine,
        lastCheckedAtMs: Date.now(),
        latencyMs,
      });
      return;
    }

    const status = (await response.json()) as CodexWebStatusResponse;
    setFloatingStatusState({
      http: status.ok ? "reachable" : "unreachable",
      webOnline: navigator.onLine,
      pageVisible: document.visibilityState !== "hidden",
      lastCheckedAtMs: Date.now(),
      latencyMs,
      websocketClients:
        typeof status.websocketClients === "number"
          ? status.websocketClients
          : null,
      ipcHandlersReady:
        typeof status.ipcHandlersReady === "boolean"
          ? status.ipcHandlersReady
          : null,
    });
  } catch {
    setFloatingStatusState({
      http: navigator.onLine ? "unreachable" : "offline",
      webOnline: navigator.onLine,
      lastCheckedAtMs: Date.now(),
      latencyMs: null,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function startCodexWebStatusPolling(): void {
  installFloatingStatusPanel();
  void pollCodexWebStatus();

  window.setInterval(() => {
    void pollCodexWebStatus();
  }, STATUS_POLL_INTERVAL_MS);

  window.addEventListener("online", () => {
    setFloatingStatusState({ webOnline: true, http: "checking" });
    void pollCodexWebStatus();
  });
  window.addEventListener("offline", () => {
    setFloatingStatusState({
      bridge: "disconnected",
      http: "offline",
      webOnline: false,
      latencyMs: null,
    });
  });
  document.addEventListener("visibilitychange", () => {
    setFloatingStatusState({
      pageVisible: document.visibilityState !== "hidden",
    });
    if (document.visibilityState !== "hidden") {
      void pollCodexWebStatus();
    }
  });
}

function registerCodexWebServiceWorker(): void {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener(
    "load",
    () => {
      navigator.serviceWorker
        .register("/codex-web-sw.js", { scope: "/" })
        .catch((error: unknown) => {
          console.warn("[codex-web] service worker registration failed", error);
        });
    },
    { once: true },
  );
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

  setFloatingStatusState({ bridge: "connecting" });
  const nextSocket = new WebSocket(
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/__backend/ipc`,
  );
  socket = nextSocket;
  nextSocket.addEventListener("open", () => {
    setFloatingStatusState({ bridge: "connected" });
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
    setFloatingStatusState({ bridge: "disconnected" });
    scheduleReconnect();
  });
  nextSocket.addEventListener("error", () => {
    setFloatingStatusState({ bridge: "error" });
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
startCodexWebStatusPolling();
registerCodexWebServiceWorker();

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

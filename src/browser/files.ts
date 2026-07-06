import { emitRendererEvent, isRecord } from "./shim";

type CodexFetchMessage = {
  body?: string;
  headers?: Record<string, string>;
  hostId?: string;
  method: string;
  requestId: string;
  type: "fetch";
  url: string;
};

type PickFilesRequest = {
  imagesOnly?: boolean;
  pickerTitle?: string;
};

type PathsExistBody = {
  hostId?: unknown;
  paths?: unknown;
};

type GitOriginsBody = {
  dirs?: unknown;
  hostId?: unknown;
};

type WorkspaceRootOptions = {
  canonicalPathByRoot?: Record<string, string>;
  labels?: Record<string, string>;
  roots: string[];
};

declare const __CODEX_APP_VERSION__: string;
declare const __CODEX_WEB_PROJECTLESS_CWD__: string;

declare global {
  interface Window {
    __CODEX_WEB_INITIAL_GLOBAL_STATE__?: Record<string, unknown>;
  }
}

const activeWorkspaceRootsKey = "active-workspace-roots";
const globalStateStorageKey = "codex-web:global-state";
const settingsStorageKey = "codex-web:settings";
const workspaceRootLabelsKey = "electron-workspace-root-labels";
const workspaceRootOptionsStorageKey = "codex-web:workspace-root-options";
const workspaceRootOptionsKey = "electron-saved-workspace-roots";

let hasHydratedGlobalState = false;

function readSettings(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(settingsStorageKey);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettings(settings: Record<string, unknown>): void {
  localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
}

function readJsonRecordStorage(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJsonRecordStorage(
  key: string,
  value: Record<string, unknown>,
): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function readInitialGlobalState(): Record<string, unknown> {
  const value = window.__CODEX_WEB_INITIAL_GLOBAL_STATE__;
  return isRecord(value) ? value : {};
}

function persistGlobalStatePatch({
  deletedKeys = [],
  values = {},
}: {
  deletedKeys?: string[];
  values?: Record<string, unknown>;
}): void {
  if (Object.keys(values).length === 0 && deletedKeys.length === 0) {
    return;
  }

  void fetch("/__backend/global-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deletedKeys, values }),
  }).catch((error: unknown) => {
    console.warn("[codex-web] failed to persist global state", error);
  });
}

function hydrateGlobalStateFromServer(): void {
  if (hasHydratedGlobalState) {
    return;
  }
  hasHydratedGlobalState = true;

  const initialGlobalState = readInitialGlobalState();
  if (Object.keys(initialGlobalState).length === 0) {
    return;
  }

  writeJsonRecordStorage(globalStateStorageKey, initialGlobalState);
  const roots = initialGlobalState[workspaceRootOptionsKey];
  if (isStringArray(roots)) {
    writeJsonRecordStorage(
      workspaceRootOptionsStorageKey,
      sanitizeWorkspaceRootOptions({
        roots,
        labels: initialGlobalState[workspaceRootLabelsKey],
      }),
    );
  }
}

function readGlobalState(): Record<string, unknown> {
  hydrateGlobalStateFromServer();
  return readJsonRecordStorage(globalStateStorageKey);
}

function writeGlobalState(globalState: Record<string, unknown>): void {
  writeJsonRecordStorage(globalStateStorageKey, globalState);
}

function globalStateKey(body: Record<string, unknown>): string | null {
  const params = isRecord(body.params) ? body.params : body;
  return typeof params.key === "string" ? params.key : null;
}

function globalStateValue(body: Record<string, unknown>): unknown {
  const params = isRecord(body.params) ? body.params : body;
  return params.value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function sanitizeStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function sanitizeWorkspaceRootOptions(value: unknown): WorkspaceRootOptions {
  const record = isRecord(value) ? value : {};
  const roots = isStringArray(record.roots) ? uniqueStrings(record.roots) : [];
  const labels = sanitizeStringMap(record.labels);
  const canonicalPathByRoot = sanitizeStringMap(record.canonicalPathByRoot);

  return {
    roots,
    ...(labels ? { labels } : {}),
    ...(canonicalPathByRoot ? { canonicalPathByRoot } : {}),
  };
}

function readWorkspaceRootOptions(): WorkspaceRootOptions {
  const stored = sanitizeWorkspaceRootOptions(
    readJsonRecordStorage(workspaceRootOptionsStorageKey),
  );
  if (stored.roots.length > 0) {
    return stored;
  }

  const globalState = readGlobalState();
  return sanitizeWorkspaceRootOptions({
    roots: isStringArray(globalState[workspaceRootOptionsKey])
      ? globalState[workspaceRootOptionsKey]
      : [],
    labels: globalState[workspaceRootLabelsKey],
  });
}

function writeWorkspaceRootOptions(options: WorkspaceRootOptions): void {
  const sanitized = sanitizeWorkspaceRootOptions(options);
  writeJsonRecordStorage(workspaceRootOptionsStorageKey, sanitized);

  const globalState = readGlobalState();
  globalState[workspaceRootOptionsKey] = sanitized.roots;
  if (sanitized.labels) {
    globalState[workspaceRootLabelsKey] = sanitized.labels;
  } else {
    delete globalState[workspaceRootLabelsKey];
  }
  writeGlobalState(globalState);
  persistGlobalStatePatch({
    values: {
      [workspaceRootOptionsKey]: sanitized.roots,
      ...(sanitized.labels ? { [workspaceRootLabelsKey]: sanitized.labels } : {}),
    },
    deletedKeys: sanitized.labels ? [] : [workspaceRootLabelsKey],
  });
}

function readActiveWorkspaceRoots(): string[] {
  const value = readGlobalState()[activeWorkspaceRootsKey];
  return isStringArray(value) ? value : [];
}

function writeGlobalStateValue(key: string, value: unknown): void {
  const globalState = readGlobalState();
  if (value === undefined) {
    delete globalState[key];
  } else {
    globalState[key] = value;
  }
  writeGlobalState(globalState);
  persistGlobalStatePatch({
    values: value === undefined ? {} : { [key]: value },
    deletedKeys: value === undefined ? [key] : [],
  });
}

function emitCodexMessage(message: Record<string, unknown>): void {
  emitRendererEvent("codex_desktop:message-for-view", [message]);
}

function emitWorkspaceRootOptionsUpdated(): void {
  emitCodexMessage({ type: "workspace-root-options-updated" });
}

function emitActiveWorkspaceRootsUpdated(): void {
  emitCodexMessage({ type: "active-workspace-roots-updated" });
}

function emitGlobalStateUpdated(keys: string[]): void {
  emitCodexMessage({ type: "global-state-updated", keys });
}

export function addWorkspaceRootOption(root: string): void {
  const options = readWorkspaceRootOptions();
  if (!options.roots.includes(root)) {
    writeWorkspaceRootOptions({
      ...options,
      roots: [...options.roots, root],
    });
  }
  emitWorkspaceRootOptionsUpdated();
  emitCodexMessage({ type: "workspace-root-option-added", root });
}

export function updateWorkspaceRootOptions(roots: string[]): void {
  const options = readWorkspaceRootOptions();
  const nextRoots = uniqueStrings(roots);
  const nextLabels =
    options.labels == null
      ? undefined
      : Object.fromEntries(
          Object.entries(options.labels).filter(([root]) =>
            nextRoots.includes(root),
          ),
        );

  writeWorkspaceRootOptions({
    ...options,
    roots: nextRoots,
    ...(nextLabels && Object.keys(nextLabels).length > 0
      ? { labels: nextLabels }
      : { labels: undefined }),
  });
  emitWorkspaceRootOptionsUpdated();
}

export function renameWorkspaceRootOption(root: string, label: string): void {
  const options = readWorkspaceRootOptions();
  const labels = { ...(options.labels ?? {}) };
  if (label.trim().length === 0) {
    delete labels[root];
  } else {
    labels[root] = label.trim();
  }

  writeWorkspaceRootOptions({
    ...options,
    labels: Object.keys(labels).length > 0 ? labels : undefined,
  });
  emitWorkspaceRootOptionsUpdated();
}

export function setActiveWorkspaceRoot(root: string | null): void {
  writeGlobalStateValue(activeWorkspaceRootsKey, root ? [root] : []);
  emitActiveWorkspaceRootsUpdated();
  emitGlobalStateUpdated([activeWorkspaceRootsKey]);
  if (root) {
    emitCodexMessage({ type: "workspace-root-option-picked", root });
  }
}

export function handleWorkspaceRootControlMessage(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "electron-add-new-workspace-root-option": {
      if (typeof value.root !== "string") {
        return false;
      }
      addWorkspaceRootOption(value.root);
      return true;
    }

    case "electron-update-workspace-root-options": {
      if (!isStringArray(value.roots)) {
        return false;
      }
      updateWorkspaceRootOptions(value.roots);
      return true;
    }

    case "electron-rename-workspace-root-option": {
      if (typeof value.root !== "string" || typeof value.label !== "string") {
        return false;
      }
      renameWorkspaceRootOption(value.root, value.label);
      return true;
    }

    case "electron-set-active-workspace-root": {
      if (typeof value.root !== "string") {
        return false;
      }
      setActiveWorkspaceRoot(value.root);
      return true;
    }

    case "electron-clear-active-workspace-root": {
      setActiveWorkspaceRoot(null);
      return true;
    }
  }

  return false;
}

function browserPlatform(): "darwin" | "linux" | "win32" {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac")) {
    return "darwin";
  }
  if (platform.includes("win")) {
    return "win32";
  }
  return "linux";
}

function parseJsonBody(message: CodexFetchMessage): Record<string, unknown> {
  if (!message.body) {
    return {};
  }

  try {
    const parsed = JSON.parse(message.body) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function openBrowserFilePicker({
  allowMultiple,
  imagesOnly,
}: {
  allowMultiple: boolean;
  imagesOnly?: boolean;
}): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    let settled = false;

    function cleanup(): void {
      input.removeEventListener("cancel", handleCancel);
      input.removeEventListener("change", handleChange);
      input.remove();
    }

    function finish(files: File[]): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(files);
    }

    function fail(error: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }

    function handleCancel(): void {
      finish([]);
    }

    function handleChange(): void {
      finish(Array.from(input.files ?? []));
    }

    input.type = "file";
    input.multiple = allowMultiple;
    if (imagesOnly) {
      input.accept = "image/*";
    }
    Object.assign(input.style, {
      height: "1px",
      left: "-9999px",
      opacity: "0",
      position: "fixed",
      top: "0",
      width: "1px",
    });
    input.addEventListener("cancel", handleCancel);
    input.addEventListener("change", handleChange);
    document.body.append(input);

    try {
      input.click();
    } catch (error) {
      fail(error);
    }
  });
}

async function uploadFiles(files: File[]) {
  if (files.length === 0) {
    return [];
  }

  const uploadUrl = new URL("/__backend/upload", window.location.href);
  const formData = new FormData();

  for (const file of files) {
    formData.append("files", file, file.name || "upload");
  }

  const response = await fetch(uploadUrl, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()).files;
}

export async function handleLocalFilePickerMessage(message: CodexFetchMessage) {
  try {
    const response = await handleLocalFilePickerMessageInner(message);

    sendFetchResponse(message, {
      responseType: "success",
      body: response,
    });
  } catch (error) {
    console.error(error);

    sendFetchResponse(message, {
      responseType: "error",
      status: 432,
      error: errorMessage(error),
    });
  }
}

export async function handlePathsExistMessage(message: CodexFetchMessage) {
  try {
    const body = parseJsonBody(message) as PathsExistBody;
    const paths = Array.isArray(body.paths)
      ? body.paths.filter((value): value is string => typeof value === "string")
      : [];

    const response = await fetch("/__backend/paths-exist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hostId: typeof body.hostId === "string" ? body.hostId : "local",
        paths,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Path existence check failed: ${response.status} ${response.statusText}`,
      );
    }

    sendFetchResponse(message, {
      responseType: "success",
      body: await response.json(),
    });
  } catch (error) {
    console.error(error);

    sendFetchResponse(message, {
      responseType: "error",
      status: 432,
      error: errorMessage(error),
    });
  }
}

export function handleGitOriginsMessage(message: CodexFetchMessage): void {
  try {
    const body = parseJsonBody(message) as GitOriginsBody;
    const dirs = Array.isArray(body.dirs)
      ? body.dirs.filter((value): value is string => typeof value === "string")
      : [];

    sendFetchResponse(message, {
      responseType: "success",
      body: {
        origins: dirs.map((dir) => ({
          dir,
          root: dir,
          originUrl: null,
        })),
      },
    });
  } catch (error) {
    console.error(error);

    sendFetchResponse(message, {
      responseType: "error",
      status: 432,
      error: errorMessage(error),
    });
  }
}

export function handleSettingsMessage(message: CodexFetchMessage): void {
  try {
    const url = new URL(message.url);
    const settings = readSettings();
    const body = parseJsonBody(message);

    if (url.pathname === "/get-settings") {
      sendFetchResponse(message, {
        responseType: "success",
        body: { values: settings },
      });
      return;
    }

    if (url.pathname === "/get-setting") {
      const key = typeof body.key === "string" ? body.key : null;
      sendFetchResponse(message, {
        responseType: "success",
        body: { value: key ? settings[key] : undefined },
      });
      return;
    }

    if (url.pathname === "/set-setting") {
      const key = typeof body.key === "string" ? body.key : null;
      if (key) {
        settings[key] = body.value;
        writeSettings(settings);
      }

      sendFetchResponse(message, {
        responseType: "success",
        body: {},
      });
      return;
    }

    if (url.pathname === "/extension-info") {
      sendFetchResponse(message, {
        responseType: "success",
        body: {
          version: __CODEX_APP_VERSION__,
          buildFlavor: "prod",
          systemVersion: navigator.userAgent,
        },
      });
      return;
    }

    if (url.pathname === "/os-info") {
      sendFetchResponse(message, {
        responseType: "success",
        body: {
          platform: browserPlatform(),
          osVersion: navigator.userAgent,
        },
      });
      return;
    }

    if (url.pathname === "/inbox-items") {
      sendFetchResponse(message, {
        responseType: "success",
        body: {
          items: [],
          unreadRunCounts: { total: 0 },
        },
      });
      return;
    }

    if (url.pathname === "/active-workspace-roots") {
      sendFetchResponse(message, {
        responseType: "success",
        body: {
          roots: readActiveWorkspaceRoots(),
        },
      });
      return;
    }

    if (url.pathname === "/workspace-root-options") {
      sendFetchResponse(message, {
        responseType: "success",
        body: readWorkspaceRootOptions(),
      });
      return;
    }

    if (url.pathname === "/get-global-state") {
      const key = globalStateKey(body);
      sendFetchResponse(message, {
        responseType: "success",
        body: { value: key ? readGlobalState()[key] : undefined },
      });
      return;
    }

    if (url.pathname === "/set-global-state") {
      const key = globalStateKey(body);
      if (key) {
        writeGlobalStateValue(key, globalStateValue(body));
        if (key === workspaceRootOptionsKey) {
          updateWorkspaceRootOptions(
            isStringArray(globalStateValue(body)) ? globalStateValue(body) : [],
          );
        } else if (key === activeWorkspaceRootsKey) {
          emitActiveWorkspaceRootsUpdated();
        }
        emitGlobalStateUpdated([key]);
      }

      sendFetchResponse(message, {
        responseType: "success",
        body: {},
      });
      return;
    }

    if (url.pathname === "/codex-command-keymap-state") {
      sendFetchResponse(message, {
        responseType: "success",
        body: {
          bindings: [],
        },
      });
      return;
    }

    if (url.pathname === "/projectless-thread-cwd") {
      sendFetchResponse(message, {
        responseType: "success",
        body: {
          cwd: __CODEX_WEB_PROJECTLESS_CWD__,
          workspaceRoot: __CODEX_WEB_PROJECTLESS_CWD__,
          projectlessOutputDirectory: __CODEX_WEB_PROJECTLESS_CWD__,
          outputDirectory: __CODEX_WEB_PROJECTLESS_CWD__,
        },
      });
      return;
    }

    throw new Error(`Unsupported settings URL: ${message.url}`);
  } catch (error) {
    console.error(error);

    sendFetchResponse(message, {
      responseType: "error",
      status: 432,
      error: errorMessage(error),
    });
  }
}

async function handleLocalFilePickerMessageInner(message: CodexFetchMessage) {
  const request = parsePickFilesRequest(message);
  const allowMultiple = message.url === "vscode://codex/pick-files";

  const selectedFiles = await openBrowserFilePicker({
    allowMultiple,
    imagesOnly: request.imagesOnly,
  });

  const uploadedFiles = await uploadFiles(selectedFiles);

  return allowMultiple
    ? { files: uploadedFiles }
    : { file: uploadedFiles[0] ?? null };
}

export function isCodexFetchMessage(
  value: unknown,
): value is CodexFetchMessage {
  return isRecord(value) && value.type === "fetch";
}

export function isGenericCodexFetchMessage(
  value: unknown,
): value is CodexFetchMessage {
  return (
    isCodexFetchMessage(value) &&
    value.method.toUpperCase() === "POST" &&
    value.url.startsWith("vscode://codex/")
  );
}

export function handleGenericCodexFetchMessage(
  message: CodexFetchMessage,
): void {
  sendFetchResponse(message, {
    responseType: "success",
    body: {},
  });
}

export function isLocalFilePickerMessage(
  value: unknown,
): value is CodexFetchMessage {
  return (
    isCodexFetchMessage(value) &&
    value.method.toUpperCase() === "POST" &&
    (value.url === "vscode://codex/pick-files" ||
      value.url === "vscode://codex/pick-file")
  );
}

export function isGitOriginsMessage(value: unknown): value is CodexFetchMessage {
  return (
    isCodexFetchMessage(value) &&
    value.method.toUpperCase() === "POST" &&
    value.url === "vscode://codex/git-origins"
  );
}

export function isPathsExistMessage(value: unknown): value is CodexFetchMessage {
  return (
    isCodexFetchMessage(value) &&
    value.method.toUpperCase() === "POST" &&
    value.url === "vscode://codex/paths-exist"
  );
}

export function isSettingsMessage(value: unknown): value is CodexFetchMessage {
  return (
    isCodexFetchMessage(value) &&
    value.method.toUpperCase() === "POST" &&
    (value.url === "vscode://codex/get-settings" ||
      value.url === "vscode://codex/get-setting" ||
      value.url === "vscode://codex/set-setting" ||
      value.url === "vscode://codex/extension-info" ||
      value.url === "vscode://codex/os-info" ||
      value.url === "vscode://codex/inbox-items" ||
      value.url === "vscode://codex/active-workspace-roots" ||
      value.url === "vscode://codex/workspace-root-options" ||
      value.url === "vscode://codex/get-global-state" ||
      value.url === "vscode://codex/set-global-state" ||
      value.url === "vscode://codex/codex-command-keymap-state" ||
      value.url === "vscode://codex/projectless-thread-cwd")
  );
}

function parsePickFilesRequest(message: CodexFetchMessage): PickFilesRequest {
  if (!message.body) {
    return {};
  }

  try {
    const parsed = JSON.parse(message.body) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return {
      imagesOnly:
        typeof parsed.imagesOnly === "boolean" ? parsed.imagesOnly : undefined,
      pickerTitle:
        typeof parsed.pickerTitle === "string" ? parsed.pickerTitle : undefined,
    };
  } catch {
    return {};
  }
}

function sendFetchResponse(
  message: CodexFetchMessage,
  response:
    | {
        responseType: "success";
        body: unknown;
        status?: number;
      }
    | {
        responseType: "error";
        error: string;
        status?: number;
      },
): void {
  const payload =
    response.responseType === "success"
      ? {
          type: "fetch-response",
          responseType: "success",
          requestId: message.requestId,
          status: response.status ?? 200,
          headers: { "content-type": "application/json" },
          bodyJsonString: JSON.stringify(response.body),
        }
      : {
          type: "fetch-response",
          responseType: "error",
          requestId: message.requestId,
          status: response.status ?? 432,
          error: response.error,
        };

  emitRendererEvent("codex_desktop:message-for-view", [payload]);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

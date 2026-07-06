#!/usr/bin/env node
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const globalStateFileName = ".codex-global-state.json";

function parseArgs(argv) {
  const parsed = {
    activate: true,
    dryRun: false,
    normalizeModelProvider: true,
    projectRoot: process.cwd(),
    restoreNonProjectBackups: false,
    stateDb: null,
    title: null,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--no-activate") {
      parsed.activate = false;
      continue;
    }
    if (arg === "--no-normalize-model-provider") {
      parsed.normalizeModelProvider = false;
      continue;
    }
    if (arg === "--restore-non-project-backups") {
      parsed.restoreNonProjectBackups = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const [, key, value] = match;
    if (key === "project-root") {
      parsed.projectRoot = path.resolve(value);
    } else if (key === "state-db") {
      parsed.stateDb = value;
    } else if (key === "title") {
      parsed.title = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function codexHome() {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkJsonlFiles(root) {
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  }

  await walk(root);
  return files;
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function textFromContent(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) =>
      item && typeof item === "object" && typeof item.text === "string"
        ? item.text
        : "",
    )
    .join("");
}

function isSyntheticContextMessage(text) {
  return text.trimStart().startsWith("<environment_context>");
}

function titleFromMessage(message, fallback) {
  const firstLine = message.trim().split(/\r?\n/, 1)[0]?.trim() || fallback;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.trunc(value) : Math.trunc(value * 1000);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function sandboxPolicyFromTurnContext(payload) {
  if (payload?.permission_profile) {
    return JSON.stringify(payload.permission_profile);
  }
  if (payload?.sandbox_policy) {
    return JSON.stringify(payload.sandbox_policy);
  }
  return JSON.stringify({ type: "disabled" });
}

async function readSession(filePath, options) {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  let meta = null;
  let firstUserMessage = "";
  let sandboxPolicy = JSON.stringify({ type: "disabled" });
  let approvalMode = "never";
  let tokensUsed = 0;
  let updatedAtMs = 0;

  const parsedLines = lines.map((line) => {
    if (!line) {
      return line;
    }
    const item = safeJsonParse(line);
    if (!item || typeof item !== "object") {
      return line;
    }

    const itemTimestampMs = timestampMs(item.timestamp);
    if (itemTimestampMs !== null) {
      updatedAtMs = Math.max(updatedAtMs, itemTimestampMs);
    }

    if (item.type === "session_meta" && item.payload) {
      meta = item.payload;
      const createdMs = timestampMs(item.payload.timestamp);
      if (createdMs !== null) {
        updatedAtMs = Math.max(updatedAtMs, createdMs);
      }
      return line;
    }

    if (item.type === "turn_context" && item.payload) {
      sandboxPolicy = sandboxPolicyFromTurnContext(item.payload);
      if (typeof item.payload.approval_policy === "string") {
        approvalMode = item.payload.approval_policy;
      }
      return line;
    }

    if (item.type === "response_item" && item.payload?.role === "user") {
      const text = textFromContent(item.payload.content);
      if (text.trim() && !isSyntheticContextMessage(text) && !firstUserMessage) {
        firstUserMessage = text.trim();
      }
      return line;
    }

    if (item.type === "event_msg" && item.payload?.type === "user_message") {
      const text = item.payload.message;
      if (typeof text === "string" && text.trim() && !firstUserMessage) {
        firstUserMessage = text.trim();
      }
      return line;
    }

    if (item.type === "event_msg" && item.payload?.type === "token_count") {
      const total = item.payload.info?.total_token_usage?.total_tokens;
      if (Number.isFinite(total)) {
        tokensUsed = Math.trunc(total);
      }
      return line;
    }

    if (item.type === "event_msg" && item.payload?.type === "task_complete") {
      const completedMs = timestampMs(item.payload.completed_at);
      if (completedMs !== null) {
        updatedAtMs = Math.max(updatedAtMs, completedMs);
      }
    }

    return line;
  });

  if (!meta || typeof meta.id !== "string") {
    return null;
  }

  let patched = false;
  let patchedLines = parsedLines;
  if (
    options.normalizeModelProvider &&
    meta.cwd === options.projectRoot &&
    meta.model_provider === "codex_vscode_copilot"
  ) {
    patched = true;
    meta.model_provider = "openai";
    patchedLines = parsedLines.map((line) => {
      const item = safeJsonParse(line);
      if (item?.type === "session_meta" && item.payload?.id === meta.id) {
        item.payload.model_provider = "openai";
        return JSON.stringify(item);
      }
      return line;
    });
  }

  const metaTimestampMs = timestampMs(meta.timestamp);
  const createdAtMs = metaTimestampMs ?? (updatedAtMs || Date.now());
  if (updatedAtMs === 0) {
    updatedAtMs = createdAtMs;
  }

  if (patched && !options.dryRun) {
    const backupPath = `${filePath}.bak-codex-web-repair`;
    if (!(await pathExists(backupPath))) {
      await fs.copyFile(filePath, backupPath);
    }
    await fs.writeFile(filePath, patchedLines.join("\n"), "utf8");
  }

  const fallbackTitle = options.title || meta.id;
  const title = titleFromMessage(firstUserMessage || fallbackTitle, fallbackTitle);
  return {
    approvalMode,
    cliVersion: typeof meta.cli_version === "string" ? meta.cli_version : "",
    createdAt: Math.floor(createdAtMs / 1000),
    createdAtMs,
    cwd: typeof meta.cwd === "string" ? meta.cwd : "",
    firstUserMessage,
    id: meta.id,
    model: typeof meta.model === "string" ? meta.model : null,
    modelProvider:
      typeof meta.model_provider === "string" ? meta.model_provider : "openai",
    patched,
    preview: firstUserMessage,
    reasoningEffort:
      typeof meta.reasoning_effort === "string" ? meta.reasoning_effort : null,
    rolloutPath: filePath,
    sandboxPolicy,
    source: typeof meta.source === "string" ? meta.source : "vscode",
    threadSource:
      typeof meta.thread_source === "string" ? meta.thread_source : "user",
    title,
    tokensUsed,
    updatedAt: Math.floor(updatedAtMs / 1000),
    updatedAtMs,
  };
}

async function sessionMetaFromFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const item = safeJsonParse(line);
    if (item?.type === "session_meta" && item.payload) {
      return item.payload;
    }
  }
  return null;
}

async function restoreNonProjectBackups(options) {
  const sessionsDir = path.join(codexHome(), "sessions");
  const restored = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl.bak-codex-web-repair")) {
        continue;
      }

      const backupMeta = await sessionMetaFromFile(entryPath);
      if (!backupMeta || backupMeta.cwd === options.projectRoot) {
        continue;
      }
      const targetPath = entryPath.replace(/\.bak-codex-web-repair$/, "");
      if (!options.dryRun) {
        await fs.copyFile(entryPath, targetPath);
      }
      restored.push(targetPath);
    }
  }

  await walk(sessionsDir);
  return restored;
}

async function readProjectSessions(options) {
  const sessionsDir = path.join(codexHome(), "sessions");
  const files = await walkJsonlFiles(sessionsDir);
  const sessions = [];
  let patchedCount = 0;

  for (const file of files) {
    const session = await readSession(file, options);
    if (!session || session.cwd !== options.projectRoot) {
      continue;
    }
    if (session.patched) {
      patchedCount += 1;
    }
    sessions.push(session);
  }

  sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return { patchedCount, sessions };
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function includeUnique(values, value) {
  return [value, ...values.filter((item) => item !== value)];
}

async function writeGlobalProjectState(options, sessions) {
  const statePath = path.join(codexHome(), globalStateFileName);
  const state = await readJsonFile(statePath);
  const projectRoot = options.projectRoot;
  const threadIds = sessions.map((session) => session.id);

  state["electron-saved-workspace-roots"] = includeUnique(
    Array.isArray(state["electron-saved-workspace-roots"])
      ? state["electron-saved-workspace-roots"].filter((item) => typeof item === "string")
      : [],
    projectRoot,
  );
  state["project-order"] = includeUnique(
    Array.isArray(state["project-order"])
      ? state["project-order"].filter((item) => typeof item === "string")
      : [],
    projectRoot,
  );
  if (options.activate) {
    state["active-workspace-roots"] = [projectRoot];
  }

  const assignments =
    state["thread-project-assignments"] &&
    typeof state["thread-project-assignments"] === "object"
      ? state["thread-project-assignments"]
      : {};
  const hints =
    state["thread-workspace-root-hints"] &&
    typeof state["thread-workspace-root-hints"] === "object"
      ? state["thread-workspace-root-hints"]
      : {};
  const writableRoots =
    state["thread-writable-roots"] &&
    typeof state["thread-writable-roots"] === "object"
      ? state["thread-writable-roots"]
      : {};
  for (const threadId of threadIds) {
    assignments[threadId] = {
      projectKind: "local",
      projectId: projectRoot,
      path: projectRoot,
      pendingCoreUpdate: false,
    };
    hints[threadId] = projectRoot;
    writableRoots[threadId] = [projectRoot];
  }
  state["thread-project-assignments"] = assignments;
  state["thread-workspace-root-hints"] = hints;
  state["thread-writable-roots"] = writableRoots;

  const orders =
    state["sidebar-project-thread-orders"] &&
    typeof state["sidebar-project-thread-orders"] === "object"
      ? state["sidebar-project-thread-orders"]
      : {};
  orders[projectRoot] = threadIds;
  state["sidebar-project-thread-orders"] = orders;

  if (!options.dryRun) {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  return statePath;
}

function sqliteValuesForSession(session, existing = {}) {
  return {
    ...existing,
    id: session.id,
    rollout_path: session.rolloutPath,
    created_at: existing.created_at ?? session.createdAt,
    updated_at: Math.max(existing.updated_at ?? 0, session.updatedAt),
    source: session.source,
    model_provider: session.modelProvider,
    cwd: session.cwd,
    title: existing.title || session.title,
    sandbox_policy: existing.sandbox_policy || session.sandboxPolicy,
    approval_mode: existing.approval_mode || session.approvalMode,
    tokens_used: Math.max(existing.tokens_used ?? 0, session.tokensUsed),
    has_user_event: existing.has_user_event ?? (session.firstUserMessage ? 1 : 0),
    archived: existing.archived ?? 0,
    archived_at: existing.archived_at ?? null,
    git_sha: existing.git_sha ?? null,
    git_branch: existing.git_branch ?? null,
    git_origin_url: existing.git_origin_url ?? null,
    cli_version: session.cliVersion,
    first_user_message: existing.first_user_message || session.firstUserMessage,
    agent_nickname: existing.agent_nickname ?? null,
    agent_role: existing.agent_role ?? null,
    memory_mode: existing.memory_mode || "enabled",
    model: existing.model ?? session.model,
    reasoning_effort: existing.reasoning_effort ?? session.reasoningEffort,
    agent_path: existing.agent_path ?? null,
    created_at_ms: existing.created_at_ms ?? session.createdAtMs,
    updated_at_ms: Math.max(existing.updated_at_ms ?? 0, session.updatedAtMs),
    thread_source: session.threadSource,
    preview: existing.preview || session.preview,
  };
}

function upsertThreadRows(options, sessions) {
  const dbPath =
    options.stateDb || path.join(codexHome(), "state_5.sqlite");
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (error) {
    throw new Error(`better-sqlite3 is required to repair ${dbPath}: ${error.message}`);
  }

  const db = new Database(dbPath);
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
      .get("table", "threads");
    if (!table) {
      throw new Error(`Missing threads table in ${dbPath}`);
    }

    const columns = db.prepare("PRAGMA table_info(threads)").all();
    const columnNames = columns.map((column) => column.name);
    const insertableColumns = columnNames.filter((name) => name !== "rowid");
    const placeholders = insertableColumns.map((name) => `@${name}`);
    const updates = insertableColumns
      .filter((name) => name !== "id")
      .map((name) => `${name} = excluded.${name}`);
    const upsert = db.prepare(
      `INSERT INTO threads (${insertableColumns.join(", ")}) VALUES (${placeholders.join(", ")}) ` +
        `ON CONFLICT(id) DO UPDATE SET ${updates.join(", ")}`,
    );
    const getExisting = db.prepare("SELECT * FROM threads WHERE id = ?");

    const run = db.transaction((rows) => {
      for (const session of rows) {
        const values = sqliteValuesForSession(session, getExisting.get(session.id));
        const filtered = Object.fromEntries(
          insertableColumns.map((column) => [column, values[column] ?? null]),
        );
        upsert.run(filtered);
      }
    });

    if (!options.dryRun) {
      run(sessions);
    }
  } finally {
    db.close();
  }

  return dbPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const restoredBackups = options.restoreNonProjectBackups
    ? await restoreNonProjectBackups(options)
    : [];
  const { patchedCount, sessions } = await readProjectSessions(options);
  const statePath = await writeGlobalProjectState(options, sessions);
  const dbPath = upsertThreadRows(options, sessions);

  console.log(
    JSON.stringify(
      {
        dryRun: options.dryRun,
        normalizedSessionFiles: patchedCount,
        projectRoot: options.projectRoot,
        restoredNonProjectBackups: restoredBackups.length,
        statePath,
        dbPath,
        threadCount: sessions.length,
        threadIds: sessions.map((session) => session.id),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

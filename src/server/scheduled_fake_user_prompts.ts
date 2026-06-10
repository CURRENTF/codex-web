import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type ScheduledFakeUserPromptStatus =
  | "scheduled"
  | "dispatching"
  | "sent"
  | "failed"
  | "cancelled";

export type ScheduledFakeUserPrompt = {
  id: string;
  conversationId: string;
  prompt: string;
  dueAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  status: ScheduledFakeUserPromptStatus;
  attempts: number;
  idempotencyKey?: string;
  sourcePrompt?: string;
  reason?: string;
  lastDispatchedAtMs?: number;
  acceptedAtMs?: number;
  sentAtMs?: number;
  cancelledAtMs?: number;
  lastError?: string;
};

export type CreateScheduledFakeUserPromptInput = {
  conversationId: string;
  prompt: string;
  dueAtMs: number;
  idempotencyKey?: string;
  sourcePrompt?: string;
  reason?: string;
};

export type ScheduledFakeUserPromptAck = {
  id: string;
  status: "accepted" | "sent" | "failed";
  errorMessage?: string;
};

type PersistedScheduledFakeUserPrompts = {
  version: 1;
  prompts: ScheduledFakeUserPrompt[];
};

export class ScheduledFakeUserPromptStore {
  private loaded = false;
  private prompts = new Map<string, ScheduledFakeUserPrompt>();
  private loading: Promise<void> | null = null;

  constructor(private readonly filePath: string) {}

  async create(
    input: CreateScheduledFakeUserPromptInput,
    nowMs = Date.now(),
  ): Promise<{ created: boolean; prompt: ScheduledFakeUserPrompt }> {
    await this.ensureLoaded();

    if (input.idempotencyKey) {
      const existing = Array.from(this.prompts.values()).find(
        (prompt) =>
          prompt.idempotencyKey === input.idempotencyKey &&
          prompt.status !== "cancelled",
      );
      if (existing) {
        return { created: false, prompt: existing };
      }
    }

    const prompt: ScheduledFakeUserPrompt = {
      id: randomUUID(),
      conversationId: input.conversationId,
      prompt: input.prompt,
      dueAtMs: input.dueAtMs,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      status: "scheduled",
      attempts: 0,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.sourcePrompt ? { sourcePrompt: input.sourcePrompt } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    };

    this.prompts.set(prompt.id, prompt);
    await this.save();
    return { created: true, prompt };
  }

  async list(): Promise<ScheduledFakeUserPrompt[]> {
    await this.ensureLoaded();
    return this.sortedPrompts();
  }

  async getNextDispatchAtMs(
    nowMs: number,
    retryAfterMs: number,
  ): Promise<number | null> {
    await this.ensureLoaded();
    let nextDispatchAtMs: number | null = null;

    for (const prompt of this.prompts.values()) {
      if (prompt.status !== "scheduled") {
        continue;
      }

      const dispatchAtMs =
        prompt.dueAtMs > nowMs
          ? prompt.dueAtMs
          : prompt.lastDispatchedAtMs == null
            ? nowMs
            : prompt.lastDispatchedAtMs + retryAfterMs;

      nextDispatchAtMs =
        nextDispatchAtMs == null
          ? dispatchAtMs
          : Math.min(nextDispatchAtMs, dispatchAtMs);
    }

    return nextDispatchAtMs;
  }

  async getDispatchablePrompts(
    nowMs: number,
    retryAfterMs: number,
  ): Promise<ScheduledFakeUserPrompt[]> {
    await this.ensureLoaded();
    return this.sortedPrompts().filter((prompt) => {
      if (prompt.status !== "scheduled" || prompt.dueAtMs > nowMs) {
        return false;
      }

      return (
        prompt.lastDispatchedAtMs == null ||
        nowMs - prompt.lastDispatchedAtMs >= retryAfterMs
      );
    });
  }

  async markDispatched(id: string, nowMs = Date.now()): Promise<void> {
    await this.ensureLoaded();
    const prompt = this.prompts.get(id);
    if (!prompt || prompt.status !== "scheduled") {
      return;
    }

    this.prompts.set(id, {
      ...prompt,
      attempts: prompt.attempts + 1,
      lastDispatchedAtMs: nowMs,
      updatedAtMs: nowMs,
      lastError: undefined,
    });
    await this.save();
  }

  async applyAck(
    ack: ScheduledFakeUserPromptAck,
    nowMs = Date.now(),
  ): Promise<ScheduledFakeUserPrompt | null> {
    await this.ensureLoaded();
    const prompt = this.prompts.get(ack.id);
    if (!prompt) {
      return null;
    }

    const nextPrompt: ScheduledFakeUserPrompt =
      ack.status === "accepted"
        ? {
            ...prompt,
            status: "dispatching",
            acceptedAtMs: nowMs,
            updatedAtMs: nowMs,
            lastError: undefined,
          }
        : ack.status === "sent"
          ? {
              ...prompt,
              status: "sent",
              sentAtMs: nowMs,
              updatedAtMs: nowMs,
              lastError: undefined,
            }
          : {
              ...prompt,
              status: "failed",
              updatedAtMs: nowMs,
              lastError: ack.errorMessage ?? "Renderer failed to submit prompt",
            };

    this.prompts.set(ack.id, nextPrompt);
    await this.save();
    return nextPrompt;
  }

  async cancel(
    id: string,
    nowMs = Date.now(),
  ): Promise<ScheduledFakeUserPrompt | null> {
    await this.ensureLoaded();
    const prompt = this.prompts.get(id);
    if (!prompt) {
      return null;
    }

    const cancelled: ScheduledFakeUserPrompt = {
      ...prompt,
      status: "cancelled",
      cancelledAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.prompts.set(id, cancelled);
    await this.save();
    return cancelled;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.loading ??= this.load();
    await this.loading;
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.filePath, "utf8"),
      ) as PersistedScheduledFakeUserPrompts;
      this.prompts = new Map(
        (Array.isArray(parsed.prompts) ? parsed.prompts : [])
          .filter(isScheduledFakeUserPrompt)
          .map((prompt) => [prompt.id, prompt]),
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    } finally {
      this.loaded = true;
      this.loading = null;
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload: PersistedScheduledFakeUserPrompts = {
      version: 1,
      prompts: this.sortedPrompts(),
    };
    await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`);
    await fs.rename(tmpPath, this.filePath);
  }

  private sortedPrompts(): ScheduledFakeUserPrompt[] {
    return Array.from(this.prompts.values()).sort(
      (left, right) =>
        left.dueAtMs - right.dueAtMs ||
        left.createdAtMs - right.createdAtMs ||
        left.id.localeCompare(right.id),
    );
  }
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
    typeof prompt.createdAtMs === "number" &&
    typeof prompt.updatedAtMs === "number" &&
    isScheduledFakeUserPromptStatus(prompt.status) &&
    typeof prompt.attempts === "number"
  );
}

function isScheduledFakeUserPromptStatus(
  value: unknown,
): value is ScheduledFakeUserPromptStatus {
  return (
    value === "scheduled" ||
    value === "dispatching" ||
    value === "sent" ||
    value === "failed" ||
    value === "cancelled"
  );
}

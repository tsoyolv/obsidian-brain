import { getVaultService, VAULT_FOLDERS } from "@/lib/services/vault";
import { task as renderTask } from "@/lib/markdown/helpers";
import { ensureMarkdownExt } from "@/lib/utils/filenames";
import { todayLocalDate } from "@/lib/utils/id";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("taskService");

export interface TaskHit {
  /** Vault-relative path. */
  path: string;
  /** 1-based line number. */
  line: number;
  text: string;
  done: boolean;
  /** The original full line (with bullet/checkbox), preserved verbatim. */
  raw: string;
}

export interface CreateTaskInput {
  /** Vault-relative path. If omitted, defaults to `Tasks/<today>.md`. */
  targetFile?: string;
  text: string;
}

export interface CreateTaskResult {
  path: string;
  text: string;
}

export type CompleteTaskResult =
  | { status: "ok"; hit: TaskHit }
  | { status: "ambiguous"; matches: TaskHit[] }
  | { status: "not_found" };

export interface TaskService {
  createTask(input: CreateTaskInput): Promise<CreateTaskResult>;
  completeTask(searchText: string): Promise<CompleteTaskResult>;
  findTasks(query: string): Promise<TaskHit[]>;
  listOpenTasks(): Promise<TaskHit[]>;
}

const TASK_LINE_RE = /^(\s*)([-*])\s+\[( |x|X)\]\s+(.+?)\s*$/;

class TaskServiceImpl implements TaskService {
  private readonly vault = getVaultService();

  async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    const text = input.text.trim();
    if (!text) throw new Error("Task text must not be empty");

    const targetRel =
      input.targetFile ??
      this.vault.joinPath(VAULT_FOLDERS.tasks, ensureMarkdownExt(todayLocalDate()));

    await this.vault.ensureNoteExists(
      targetRel,
      `# Tasks ${todayLocalDate()}\n\n`
    );
    await this.vault.appendToNote(targetRel, renderTask(text, false));

    log.info("createTask", { path: targetRel, text });
    return { path: targetRel, text };
  }

  async completeTask(searchText: string): Promise<CompleteTaskResult> {
    const needle = searchText.trim().toLowerCase();
    if (!needle) return { status: "not_found" };

    const all = await this.collectTasks({ openOnly: true });
    const matches = fuzzyMatch(all, needle);

    if (matches.length === 0) return { status: "not_found" };
    if (matches.length > 1) return { status: "ambiguous", matches: matches.slice(0, 5) };

    const hit = matches[0]!;
    await this.markTaskDone(hit);
    log.info("completeTask", { path: hit.path, line: hit.line });
    return { status: "ok", hit: { ...hit, done: true } };
  }

  async findTasks(query: string): Promise<TaskHit[]> {
    const needle = query.trim().toLowerCase();
    const all = await this.collectTasks({ openOnly: false });
    if (!needle) return all.slice(0, 50);
    return fuzzyMatch(all, needle).slice(0, 50);
  }

  async listOpenTasks(): Promise<TaskHit[]> {
    return this.collectTasks({ openOnly: true });
  }

  private async collectTasks(opts: { openOnly: boolean }): Promise<TaskHit[]> {
    const files = await this.vault.listFiles();
    const out: TaskHit[] = [];

    for (const rel of files) {
      let raw: string;
      try {
        ({ raw } = await this.vault.readNote(rel));
      } catch {
        continue;
      }
      const lines = raw.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const m = TASK_LINE_RE.exec(line);
        if (!m) continue;
        const done = (m[3] ?? " ").toLowerCase() === "x";
        if (opts.openOnly && done) continue;
        out.push({
          path: rel,
          line: i + 1,
          text: (m[4] ?? "").trim(),
          done,
          raw: line,
        });
      }
    }
    return out;
  }

  private async markTaskDone(hit: TaskHit): Promise<void> {
    const updated = hit.raw.replace(/\[( |x|X)\]/, "[x]");
    if (updated === hit.raw) return;
    await this.vault.replaceLine(hit.path, hit.line, updated);
  }
}

let cached: TaskService | null = null;

export function getTaskService(): TaskService {
  if (cached) return cached;
  cached = new TaskServiceImpl();
  return cached;
}

export function _resetTaskServiceCache(): void {
  cached = null;
}

// ---- helpers ----

/**
 * Lightweight fuzzy match: scores tasks by token overlap and substring presence.
 * Returns a single clear winner when ahead by a margin, otherwise all near-ties
 * so the caller can disambiguate instead of guessing.
 */
function fuzzyMatch(tasks: TaskHit[], needle: string): TaskHit[] {
  const tokens = needle
    .toLowerCase()
    .split(/[^a-z0-9_\-а-яё]+/i)
    .filter((s) => s.length >= 2);

  const scored: { hit: TaskHit; score: number }[] = [];
  for (const t of tasks) {
    const hay = t.text.toLowerCase();
    let score = 0;
    if (hay === needle) score += 100;
    if (hay.includes(needle)) score += 20;
    for (const tok of tokens) {
      if (hay.includes(tok)) score += 4;
    }
    if (score > 0) scored.push({ hit: t, score });
  }
  scored.sort((a, b) => b.score - a.score);

  if (scored.length <= 1) return scored.map((s) => s.hit);

  const top = scored[0]!.score;
  const second = scored[1]!.score;
  if (top >= second + 5) return [scored[0]!.hit];
  return scored.filter((s) => s.score >= top - 2).map((s) => s.hit);
}

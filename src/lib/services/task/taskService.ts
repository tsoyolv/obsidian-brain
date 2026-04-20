import { getVaultService, VAULT_FOLDERS } from "@/lib/services/vault";
import { getDataService } from "@/lib/services/data";
import { getConfig } from "@/lib/config";
import { task as renderTask } from "@/lib/markdown/helpers";
import { ensureMarkdownExt } from "@/lib/utils/filenames";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("taskService");

/**
 * Default vault-relative file new tasks land in when the caller doesn't
 * specify one. Plain markdown so it shows up cleanly in Obsidian.
 */
export const DEFAULT_TASK_FILE = `${VAULT_FOLDERS.tasks}/tasks.md`;
const DEFAULT_TASK_FILE_HEADER = `# Tasks\n\n`;
const ARCHIVE_FOLDER = `${VAULT_FOLDERS.tasks}/archive`;
const TASK_IGNORED_TOP_LEVEL_FOLDERS = new Set<string>([
  VAULT_FOLDERS.aiChats,
  "AI Summaries",
]);

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
  /**
   * Vault-relative path. If omitted, defaults to `Tasks/tasks.md`.
   * The file is created (with a heading) if it doesn't exist yet.
   */
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
  /** Append `- [ ] <text>` to `targetFile` (default `Tasks/tasks.md`). */
  createTask(input: CreateTaskInput): Promise<CreateTaskResult>;
  /**
   * Fuzzy-match an OPEN task by `searchText`. If exactly one strong match is
   * found it is checked off and returned. Multiple near-ties yield
   * `{ status: "ambiguous" }`; no matches yields `{ status: "not_found" }`.
   * NEVER touches files in the vault's `Deleted/` subtree.
   */
  completeTask(searchText: string): Promise<CompleteTaskResult>;
  /** Fuzzy-search across ALL tasks (open + done). Pass empty `query` to list. */
  findTasks(query: string): Promise<TaskHit[]>;
  /** All open `- [ ]` tasks across the vault, in walk order. */
  listOpenTasks(): Promise<TaskHit[]>;
  /**
   * Force archive completed tasks from the target file (or default tasks file)
   * regardless of how many done items are present.
   */
  archiveTasksNow(targetFile?: string): Promise<{
    sourcePath: string;
    archivePath: string | null;
    archivedCount: number;
  }>;
}

/**
 * Recognised task line formats:
 *   - [ ] do something
 *   * [x] done thing
 * Indentation, `-`/`*` bullet, and lower/upper-case `x` are all accepted.
 */
const TASK_LINE_RE = /^(\s*)([-*])\s+\[( |x|X)\]\s+(.+?)\s*$/;

class TaskServiceImpl implements TaskService {
  private readonly vault = getVaultService();
  private readonly archiveDoneThreshold = getConfig().tasks.archiveDoneThreshold;

  async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    const text = input.text.trim();
    if (!text) {
      log.warn("createTask: empty text");
      throw new Error("Task text must not be empty");
    }

    const targetRel = input.targetFile
      ? this.vault.safePathResolve(normalizeMarkdownRelPath(input.targetFile))
      : DEFAULT_TASK_FILE;

    const t = log.time("createTask");
    try {
      await this.vault.ensureNoteExists(targetRel, DEFAULT_TASK_FILE_HEADER);
      await this.vault.appendToNote(targetRel, renderTask(text, false));
    } catch (err) {
      t.fail("createTask: write failed", {
        path: targetRel,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    t.done("createTask", { path: targetRel, text, chars: text.length });
    return { path: targetRel, text };
  }

  async completeTask(searchText: string): Promise<CompleteTaskResult> {
    const needle = searchText.trim().toLowerCase();
    if (!needle) {
      log.warn("completeTask: empty needle");
      return { status: "not_found" };
    }

    const t = log.time("completeTask");
    const open = await this.collectTasks({ openOnly: true });
    const matches = fuzzyMatch(open, needle);

    if (matches.length === 0) {
      t.done("completeTask: no match", {
        needle,
        scannedOpen: open.length,
        status: "not_found",
      });
      return { status: "not_found" };
    }
    if (matches.length > 1) {
      t.done("completeTask: ambiguous", {
        needle,
        matches: matches.length,
        status: "ambiguous",
      });
      return { status: "ambiguous", matches: matches.slice(0, 5) };
    }

    const hit = matches[0]!;
    await this.markTaskDone(hit);
    await this.archiveCompletedTasks(hit.path);
    t.done("completeTask", {
      path: hit.path,
      line: hit.line,
      text: hit.text,
      status: "ok",
    });
    return { status: "ok", hit: { ...hit, done: true } };
  }

  async findTasks(query: string): Promise<TaskHit[]> {
    const needle = query.trim().toLowerCase();
    const t = log.time("findTasks");
    const all = await this.collectTasks({ openOnly: false });
    const out = !needle ? all.slice(0, 50) : fuzzyMatch(all, needle).slice(0, 50);
    t.done("findTasks", { needle, scanned: all.length, returned: out.length });
    return out;
  }

  async listOpenTasks(): Promise<TaskHit[]> {
    const t = log.time("listOpenTasks");
    const open = await this.collectTasks({ openOnly: true });
    t.done("listOpenTasks", { count: open.length });
    return open;
  }

  async archiveTasksNow(targetFile?: string): Promise<{
    sourcePath: string;
    archivePath: string | null;
    archivedCount: number;
  }> {
    const sourcePath = targetFile
      ? this.vault.safePathResolve(normalizeMarkdownRelPath(targetFile))
      : DEFAULT_TASK_FILE;
    return this.archiveCompletedTasks(sourcePath, { force: true });
  }

  /**
   * Walk every markdown file in the vault and parse out task lines.
   * `vault.listFiles()` invoked without a folder argument already prunes the
   * `Deleted/` subtree, so soft-deleted tasks are silently ignored as
   * required by the safety rules.
   */
  private async collectTasks(opts: { openOnly: boolean }): Promise<TaskHit[]> {
    const files = await this.vault.listFiles();
    const out: TaskHit[] = [];

    for (const rel of files) {
      const top = topLevelFolder(rel);
      if (top && TASK_IGNORED_TOP_LEVEL_FOLDERS.has(top)) {
        continue;
      }
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

  /**
   * Keep task files manageable by moving completed lines into a monthly archive
   * once enough done items accumulate in the source file.
   */
  private async archiveCompletedTasks(
    relPath: string,
    options: { force?: boolean } = {}
  ): Promise<{ sourcePath: string; archivePath: string | null; archivedCount: number }> {
    const dataService = getDataService();
    const { raw } = await this.vault.readNote(relPath);
    const lines = raw.split(/\r?\n/);
    const doneIndexes: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = TASK_LINE_RE.exec(lines[i] ?? "");
      if (!m) continue;
      const done = (m[3] ?? " ").toLowerCase() === "x";
      if (done) doneIndexes.push(i);
    }
    if (!options.force && doneIndexes.length < this.archiveDoneThreshold) {
      try {
        await dataService.archiveTaskSnapshot({
          sourcePath: relPath,
          archivePath: null,
          archivedCount: 0,
        });
      } catch (err) {
        log.warn("archiveCompletedTasks: data snapshot failed", { source: relPath, err: String(err) });
      }
      return { sourcePath: relPath, archivePath: null, archivedCount: 0 };
    }
    if (doneIndexes.length === 0) {
      try {
        await dataService.archiveTaskSnapshot({
          sourcePath: relPath,
          archivePath: null,
          archivedCount: 0,
        });
      } catch (err) {
        log.warn("archiveCompletedTasks: data snapshot failed", { source: relPath, err: String(err) });
      }
      return { sourcePath: relPath, archivePath: null, archivedCount: 0 };
    }

    const doneLines = doneIndexes.map((idx) => lines[idx]!).filter(Boolean);
    const monthKey = currentMonthKey();
    const archivePath = `${ARCHIVE_FOLDER}/${monthKey}.md`;
    await this.vault.ensureNoteExists(
      archivePath,
      `# Archived tasks ${monthKey}\n\n`
    );
    await this.vault.appendToNote(
      archivePath,
      [`## ${relPath}`, ...doneLines, ""].join("\n")
    );

    const doneSet = new Set(doneIndexes);
    const kept = lines.filter((_, idx) => !doneSet.has(idx)).join("\n");
    await this.vault.writeRawNote(relPath, kept);
    try {
      await dataService.archiveTaskSnapshot({
        sourcePath: relPath,
        archivePath,
        archivedCount: doneLines.length,
      });
    } catch (err) {
      log.warn("archiveCompletedTasks: data snapshot failed", { source: relPath, err: String(err) });
      // Keep task archive semantics unchanged even if Data integration fails.
      await dataService.buildIndex({ scope: "index" });
    }
    log.info("archiveCompletedTasks", {
      source: relPath,
      archived: doneLines.length,
      archivePath,
      force: Boolean(options.force),
    });
    return { sourcePath: relPath, archivePath, archivedCount: doneLines.length };
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
 * Lightweight fuzzy match over task text.
 *
 * Scoring:
 *   - exact case-insensitive match            → +100
 *   - full-needle substring                   → +20
 *   - per-token substring (cyrillic-friendly) → +4
 *
 * Returns:
 *   - `[]`             when nothing scored
 *   - `[winner]`       when the top score beats #2 by ≥ 5 points
 *   - all near-ties    otherwise, so the caller can disambiguate instead of
 *                      silently picking the wrong task
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

function currentMonthKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

function topLevelFolder(relPath: string): string | undefined {
  const segs = relPath.split(/[\\/]/).filter(Boolean);
  return segs[0];
}

function normalizeMarkdownRelPath(input: string): string {
  const parts = input.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return ensureMarkdownExt(input);
  const leaf = parts.pop()!;
  const normalizedLeaf = ensureMarkdownExt(leaf);
  return [...parts, normalizedLeaf].join("/");
}

import path from "node:path";
import { getConfig } from "@/lib/config";
import { ensureMarkdownExt } from "@/lib/utils/filenames";
import { createLogger } from "@/lib/utils/logger";
import { parseMarkdown, serializeMarkdown } from "@/lib/markdown/frontmatter";
import type { NoteFrontmatter, SearchHit } from "@/lib/types";
import {
  appendUtf8,
  ensureDir,
  move,
  pathExists,
  readUtf8,
  writeUtf8,
} from "./internal/fsAdapter";
import {
  basenameWithoutExt,
  dirnameOf,
  joinVaultPath,
  safePathResolve as resolveUnderRoot,
  sanitizeRelFolder,
  sanitizeRelPath,
  toVaultRelative,
  withTimestampSuffix,
} from "./internal/paths";
import {
  makeSnippet,
  scoreDocument,
  tokenize,
} from "./internal/search";
import { walkMarkdown } from "./internal/walker";

const log = createLogger("vaultService");

export const VAULT_FOLDERS = {
  inbox: "Inbox",
  voiceLogs: "Voice Logs",
  aiChats: "AI Chats",
  aiSummaries: "AI Summaries",
  tasks: "Tasks",
} as const;

export type VaultFolder = (typeof VAULT_FOLDERS)[keyof typeof VAULT_FOLDERS];

/**
 * Top-level folder that holds soft-deleted files. NEVER auto-created at
 * startup — created lazily on first soft-delete so that vaults without any
 * deletions don't accumulate empty trash directories.
 *
 * Excluded from `listFiles()` and `searchNotes()` when invoked at vault root.
 * Callers can still inspect it explicitly by passing it as the `folder` arg.
 */
export const DELETED_FOLDER = "Deleted";

export interface CreateNoteInput {
  folder: string;
  title: string;
  content: string;
  metadata?: NoteFrontmatter;
  /** If true, append a timestamp suffix on filename collision instead of throwing. */
  uniqueOnConflict?: boolean;
}

export interface CreateNoteResult {
  /** Vault-relative path. */
  path: string;
}

export interface ParsedNote {
  raw: string;
  data: NoteFrontmatter;
  body: string;
}

export interface SearchOptions {
  limit?: number;
  /** Restrict search to a folder (vault-relative). */
  folder?: string;
}

export interface MoveFileOptions {
  /** If true, append a timestamp suffix on filename collision instead of throwing. */
  uniqueOnConflict?: boolean;
}

export interface MoveFileResult {
  /** New vault-relative path. */
  path: string;
}

export interface SoftDeleteResult {
  /** Vault-relative path inside `Deleted/` where the file now lives. */
  path: string;
}

/**
 * Public vault API. This is the ONLY surface other services may use to read
 * or write the vault. No filesystem primitives leak across this boundary.
 */
export interface VaultService {
  ensureFolders(): Promise<void>;

  // Composing vault-relative paths (pure helpers — no I/O).
  joinPath(folder: string, filename: string): string;
  /**
   * Validate and normalize a vault-relative path: rejects path traversal,
   * absolute paths, illegal characters, and `..` segments. Returns a
   * sanitized vault-relative form. The vault root is never leaked.
   */
  safePathResolve(relPath: string): string;

  // Read / write
  fileExists(relPath: string): Promise<boolean>;
  createNote(input: CreateNoteInput): Promise<CreateNoteResult>;
  ensureNoteExists(relPath: string, initialContent: string): Promise<void>;
  appendToNote(relPath: string, content: string): Promise<void>;
  readNote(relPath: string): Promise<ParsedNote>;
  writeRawNote(relPath: string, raw: string): Promise<void>;
  /** Replace a single 1-based line in a note. Used for safe in-place edits. */
  replaceLine(relPath: string, line1Based: number, newLine: string): Promise<void>;

  // Mutation
  moveFile(
    srcRelPath: string,
    destRelPath: string,
    options?: MoveFileOptions
  ): Promise<MoveFileResult>;
  /**
   * Soft-delete a file by moving it to `Deleted/<original-relative-path>`,
   * preserving folder structure. On filename collisions inside `Deleted/`,
   * a timestamp suffix is appended. NEVER unlinks the file from disk.
   */
  softDelete(relPath: string): Promise<SoftDeleteResult>;

  // Discovery
  listFiles(folder?: string): Promise<string[]>;
  searchNotes(query: string, options?: SearchOptions): Promise<SearchHit[]>;
}

class VaultServiceImpl implements VaultService {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  joinPath(folder: string, filename: string): string {
    return joinVaultPath(folder, filename);
  }

  safePathResolve(relPath: string): string {
    const safeRel = sanitizeRelPath(relPath);
    // Defensive: re-resolve against the root so any residual traversal fails loudly.
    const abs = resolveUnderRoot(this.root, safeRel);
    return toVaultRelative(this.root, abs);
  }

  async ensureFolders(): Promise<void> {
    await ensureDir(this.root);
    for (const folder of Object.values(VAULT_FOLDERS)) {
      await ensureDir(this.resolve(folder));
    }
  }

  async fileExists(relPath: string): Promise<boolean> {
    return pathExists(this.resolve(relPath));
  }

  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    const folderRel = sanitizeRelFolder(input.folder);
    const baseFilename = ensureMarkdownExt(input.title);
    const folderAbs = this.resolve(folderRel);
    await ensureDir(folderAbs);

    let filename = baseFilename;
    let absPath = path.join(folderAbs, filename);

    if (await pathExists(absPath)) {
      if (input.uniqueOnConflict) {
        filename = withTimestampSuffix(baseFilename);
        absPath = path.join(folderAbs, filename);
      } else {
        throw new Error(
          `Note already exists: ${path.join(folderRel, filename)}`
        );
      }
    }

    const raw = serializeMarkdown(input.content, input.metadata);
    await writeUtf8(absPath, raw);
    const rel = toVaultRelative(this.root, absPath);
    log.info("createNote", { path: rel });
    return { path: rel };
  }

  async ensureNoteExists(relPath: string, initialContent: string): Promise<void> {
    const abs = this.resolve(relPath);
    if (await pathExists(abs)) return;
    await ensureDir(this.resolve(dirnameOf(relPath)));
    await writeUtf8(abs, ensureTrailingNewline(initialContent));
    log.debug("ensureNoteExists", { path: relPath, created: true });
  }

  async appendToNote(relPath: string, content: string): Promise<void> {
    const abs = this.resolve(relPath);
    if (!(await pathExists(abs))) {
      throw new Error(`Note not found for append: ${relPath}`);
    }
    const current = await readUtf8(abs);
    const needsNewline = current.length > 0 && !current.endsWith("\n");
    const safe = (needsNewline ? "\n" : "") + ensureTrailingNewline(content);
    await appendUtf8(abs, safe);
    log.debug("appendToNote", { path: relPath, bytes: safe.length });
  }

  async readNote(relPath: string): Promise<ParsedNote> {
    const abs = this.resolve(relPath);
    const raw = await readUtf8(abs);
    const { data, body } = parseMarkdown(raw);
    return { raw, data, body };
  }

  async writeRawNote(relPath: string, raw: string): Promise<void> {
    const abs = this.resolve(relPath);
    await ensureDir(this.resolve(dirnameOf(relPath)));
    await writeUtf8(abs, ensureTrailingNewline(raw));
  }

  async replaceLine(
    relPath: string,
    line1Based: number,
    newLine: string
  ): Promise<void> {
    const abs = this.resolve(relPath);
    const raw = await readUtf8(abs);
    const lines = raw.split(/\r?\n/);
    const idx = line1Based - 1;
    if (idx < 0 || idx >= lines.length) {
      throw new Error(`Line ${line1Based} out of range for ${relPath}`);
    }
    if (lines[idx] === newLine) return;
    lines[idx] = newLine;
    await writeUtf8(abs, lines.join("\n"));
    log.debug("replaceLine", { path: relPath, line: line1Based });
  }

  async moveFile(
    srcRelPath: string,
    destRelPath: string,
    options: MoveFileOptions = {}
  ): Promise<MoveFileResult> {
    const safeSrc = sanitizeRelPath(srcRelPath);
    const safeDest = sanitizeRelPath(destRelPath);
    if (safeSrc === safeDest) {
      return { path: safeSrc };
    }

    const srcAbs = this.resolve(safeSrc);
    if (!(await pathExists(srcAbs))) {
      throw new Error(`Cannot move; source not found: ${srcRelPath}`);
    }

    let destAbs = this.resolve(safeDest);
    await ensureDir(path.dirname(destAbs));

    if (await pathExists(destAbs)) {
      if (!options.uniqueOnConflict) {
        throw new Error(`Move destination already exists: ${safeDest}`);
      }
      destAbs = path.join(
        path.dirname(destAbs),
        withTimestampSuffix(path.basename(destAbs))
      );
    }

    await move(srcAbs, destAbs);
    const finalRel = toVaultRelative(this.root, destAbs);
    log.info("moveFile", { from: safeSrc, to: finalRel });
    return { path: finalRel };
  }

  async softDelete(relPath: string): Promise<SoftDeleteResult> {
    const safeRel = sanitizeRelPath(relPath);
    const srcAbs = this.resolve(safeRel);
    if (!(await pathExists(srcAbs))) {
      throw new Error(`Cannot soft-delete; not found: ${relPath}`);
    }

    // Preserve the original folder structure under Deleted/.
    const destRel = path.join(DELETED_FOLDER, safeRel);
    let destAbs = this.resolve(destRel);
    await ensureDir(path.dirname(destAbs));

    if (await pathExists(destAbs)) {
      destAbs = path.join(
        path.dirname(destAbs),
        withTimestampSuffix(path.basename(destAbs))
      );
    }

    // CRITICAL: this is a rename/move, not unlink. The vault module
    // intentionally exposes no API that removes files from disk.
    await move(srcAbs, destAbs);
    const finalRel = toVaultRelative(this.root, destAbs);
    log.info("softDelete", { from: safeRel, to: finalRel });
    return { path: finalRel };
  }

  async listFiles(folder?: string): Promise<string[]> {
    const start = folder ? this.resolve(sanitizeRelFolder(folder)) : this.root;
    const files = await walkMarkdown(start, {
      skipPaths: folder ? undefined : this.deletedSkipSet(),
    });
    return files.map((abs) => toVaultRelative(this.root, abs));
  }

  async searchNotes(
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchHit[]> {
    const limit = options.limit ?? 25;
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    const startAbs = options.folder
      ? this.resolve(sanitizeRelFolder(options.folder))
      : this.root;
    const files = await walkMarkdown(startAbs, {
      skipPaths: options.folder ? undefined : this.deletedSkipSet(),
    });
    const results: SearchHit[] = [];

    for (const abs of files) {
      let content: string;
      try {
        content = await readUtf8(abs);
      } catch {
        continue;
      }
      const title = basenameWithoutExt(abs);
      const score = scoreDocument({ title, content, tokens });
      if (score === 0) continue;
      results.push({
        path: toVaultRelative(this.root, abs),
        title,
        snippet: makeSnippet(content, tokens),
        score,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** Internal: turn a vault-relative path into a guaranteed-safe absolute path. */
  private resolve(...segments: string[]): string {
    return resolveUnderRoot(this.root, ...segments);
  }

  /** Absolute path of the `Deleted/` subtree, used to prune walks at root. */
  private deletedSkipSet(): ReadonlySet<string> {
    return new Set([path.join(this.root, DELETED_FOLDER)]);
  }
}

let cached: VaultService | null = null;

export function getVaultService(): VaultService {
  if (cached) return cached;
  const cfg = getConfig();
  cached = new VaultServiceImpl(cfg.vaultPath);
  return cached;
}

export function _resetVaultServiceCache(): void {
  cached = null;
}

// ---- helpers ----

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

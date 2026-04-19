import path from "node:path";
import { getConfig } from "@/lib/config";
import { ensureMarkdownExt } from "@/lib/utils/filenames";
import { createLogger } from "@/lib/utils/logger";
import { parseMarkdown, serializeMarkdown } from "@/lib/markdown/frontmatter";
import type { NoteFrontmatter } from "@/lib/types";
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
import { walkMarkdown } from "./internal/walker";

const log = createLogger("vaultService");

export const VAULT_FOLDERS = {
  inbox: "Inbox",
  voiceLogs: "Voice Logs",
  captureLogs: "Capture Logs",
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
 * Excluded from `listFiles()` (and therefore from `searchService.search` and
 * `findFilesByName`) when invoked at vault root. Callers can still inspect
 * it explicitly by passing it as the `folder` argument.
 */
export const DELETED_FOLDER = "Deleted";

/**
 * Allowlist of TOP-LEVEL vault folders that ANY mutating vault operation is
 * permitted to write into. Anything outside this set — including the vault
 * root itself or arbitrary user-supplied folders — is rejected at the
 * service boundary, so a misbehaving classifier or a buggy caller cannot
 * scribble into `.obsidian/`, attached subfolders, or unrelated trees.
 *
 * `Deleted/` is INTENTIONALLY excluded: the only way to land a file there is
 * via {@link VaultService.softDelete}, which uses a private code path.
 */
export const WRITABLE_FOLDERS: ReadonlySet<string> = new Set(
  Object.values(VAULT_FOLDERS)
);

/**
 * Mutation kinds that go through the writable-folder check. Used in error
 * messages so a violation makes it obvious which API call was rejected.
 */
type MutationKind =
  | "createNote"
  | "ensureNoteExists"
  | "appendToNote"
  | "writeRawNote"
  | "replaceLine"
  | "updateFrontmatter"
  | "moveFile"
  | "softDelete";

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

export interface FileMatch {
  /** Vault-relative path. */
  path: string;
  /** File basename without `.md`. */
  title: string;
  /** Higher = better. Pure filename score; never reads file body. */
  score: number;
}

export interface FindFilesOptions {
  limit?: number;
  /** Restrict the search to a folder (vault-relative). */
  folder?: string;
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
  /**
   * Merge `partial` into the note's existing YAML frontmatter, preserving
   * the body byte-for-byte. Keys set to `undefined` in `partial` are
   * removed; keys not mentioned are left untouched. No-op when the merged
   * frontmatter is deep-equal to the existing one (avoids mtime churn).
   */
  updateFrontmatter(relPath: string, partial: NoteFrontmatter): Promise<void>;

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
  /**
   * Recursively list every `.md` file under `folder` (or the vault root if
   * omitted). The vault's `Deleted/` subtree is pruned at the root, so
   * soft-deleted files never appear unless `folder: "Deleted"` is passed
   * explicitly.
   */
  listFiles(folder?: string): Promise<string[]>;
  /**
   * Filename-only fuzzy match. Walks the vault but NEVER reads file bodies —
   * safe to use for "find_file" style flows where we must not surface note
   * content without explicit user confirmation.
   */
  findFilesByName(query: string, options?: FindFilesOptions): Promise<FileMatch[]>;
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
    this.assertWritableFolder(folderRel, "createNote");
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
    this.assertWritablePath(relPath, "ensureNoteExists");
    const abs = this.resolve(relPath);
    if (await pathExists(abs)) return;
    await ensureDir(this.resolve(dirnameOf(relPath)));
    await writeUtf8(abs, ensureTrailingNewline(initialContent));
    log.debug("ensureNoteExists", { path: relPath, created: true });
  }

  async appendToNote(relPath: string, content: string): Promise<void> {
    this.assertWritablePath(relPath, "appendToNote");
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
    this.assertWritablePath(relPath, "writeRawNote");
    const abs = this.resolve(relPath);
    await ensureDir(this.resolve(dirnameOf(relPath)));
    await writeUtf8(abs, ensureTrailingNewline(raw));
  }

  async replaceLine(
    relPath: string,
    line1Based: number,
    newLine: string
  ): Promise<void> {
    this.assertWritablePath(relPath, "replaceLine");
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

  async updateFrontmatter(
    relPath: string,
    partial: NoteFrontmatter
  ): Promise<void> {
    this.assertWritablePath(relPath, "updateFrontmatter");
    const abs = this.resolve(relPath);
    if (!(await pathExists(abs))) {
      throw new Error(`Note not found for frontmatter update: ${relPath}`);
    }
    const raw = await readUtf8(abs);
    const { data, body } = parseMarkdown(raw);
    const merged: NoteFrontmatter = { ...data };
    for (const [k, v] of Object.entries(partial)) {
      if (v === undefined) {
        delete merged[k];
      } else {
        merged[k] = v;
      }
    }
    const next = serializeMarkdown(body, merged);
    if (next === raw) return;
    await writeUtf8(abs, next);
    log.debug("updateFrontmatter", { path: relPath });
  }

  async moveFile(
    srcRelPath: string,
    destRelPath: string,
    options: MoveFileOptions = {}
  ): Promise<MoveFileResult> {
    const safeSrc = sanitizeRelPath(srcRelPath);
    const safeDest = sanitizeRelPath(destRelPath);
    // Both endpoints of a move must live under the writable allowlist. In
    // particular, this rejects moves into `Deleted/` — the only legitimate
    // way to write into the trash is `softDelete`, which uses a separate
    // private code path below.
    this.assertWritablePath(safeSrc, "moveFile");
    this.assertWritablePath(safeDest, "moveFile");

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
    // Source must come from a writable folder. We deliberately do NOT call
    // assertWritablePath on the destination because the destination is, by
    // construction, inside `Deleted/` — softDelete is the SOLE entry point
    // permitted to write there.
    this.assertWritablePath(safeRel, "softDelete");
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

  /**
   * Reject any mutating operation whose target path is not inside the
   * writable allowlist (or is inside `Deleted/`). Defense-in-depth on top
   * of {@link sanitizeRelPath}, which already rejects traversal — this
   * layer additionally limits WHICH allowed-by-traversal folders may be
   * written.
   */
  private assertWritablePath(relPath: string, op: MutationKind): void {
    const safeRel = sanitizeRelPath(relPath);
    const top = topLevelSegment(safeRel);
    this.assertWritableTop(top, op, safeRel);
  }

  /** Folder-only variant — used by `createNote` which validates the folder before composing the filename. */
  private assertWritableFolder(folderRel: string, op: MutationKind): void {
    const top = topLevelSegment(folderRel);
    this.assertWritableTop(top, op, folderRel);
  }

  private assertWritableTop(
    top: string | undefined,
    op: MutationKind,
    target: string
  ): void {
    if (!top) {
      throw new Error(
        `Refusing ${op}: writes to the vault root are not allowed (target: "${target}")`
      );
    }
    if (top === DELETED_FOLDER) {
      throw new Error(
        `Refusing ${op}: ${DELETED_FOLDER}/ is write-protected. ` +
          `Use softDelete to move files there.`
      );
    }
    if (!WRITABLE_FOLDERS.has(top)) {
      throw new Error(
        `Refusing ${op}: "${top}" is not in the writable folder allowlist ` +
          `(${[...WRITABLE_FOLDERS].sort().join(", ")}). target="${target}"`
      );
    }
  }

  async listFiles(folder?: string): Promise<string[]> {
    const start = folder ? this.resolve(sanitizeRelFolder(folder)) : this.root;
    const files = await walkMarkdown(start, {
      skipPaths: folder ? undefined : this.deletedSkipSet(),
    });
    return files.map((abs) => toVaultRelative(this.root, abs));
  }

  async findFilesByName(
    query: string,
    options: FindFilesOptions = {}
  ): Promise<FileMatch[]> {
    const limit = options.limit ?? 10;
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    const startAbs = options.folder
      ? this.resolve(sanitizeRelFolder(options.folder))
      : this.root;
    const files = await walkMarkdown(startAbs, {
      skipPaths: options.folder ? undefined : this.deletedSkipSet(),
    });

    const matches: FileMatch[] = [];
    for (const abs of files) {
      const title = basenameWithoutExt(abs);
      const score = scoreFilename(title, tokens);
      if (score === 0) continue;
      matches.push({
        path: toVaultRelative(this.root, abs),
        title,
        score,
      });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, limit);
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

/**
 * First path segment of a vault-relative path, used to gate writes against
 * {@link WRITABLE_FOLDERS}. Returns undefined ONLY when the path is empty —
 * a single-segment path (e.g. the folder name itself, or a bare filename
 * being written to the vault root) returns that segment so the allowlist
 * check can decide whether it's permitted.
 */
function topLevelSegment(relPath: string): string | undefined {
  const segments = relPath.split(path.sep).filter(Boolean);
  if (segments.length === 0) return undefined;
  return segments[0];
}

/**
 * Lowercase tokens of length >= 2. Latin + cyrillic friendly so mixed
 * English/Russian filenames tokenize the same way.
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_\-а-яё]+/i)
    .filter((s) => s.length >= 2);
}

/**
 * Filename-only score. Tuned to favor full-substring hits over scattered
 * token coverage so renames like "shopping list" beat unrelated files that
 * happen to share one of the words.
 */
function scoreFilename(title: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const hay = title.toLowerCase();
  const phrase = tokens.join(" ").toLowerCase();
  let score = 0;
  if (hay === phrase) score += 100;
  if (hay.includes(phrase)) score += 30;
  for (const t of tokens) {
    if (hay.includes(t)) score += 4;
  }
  return score;
}

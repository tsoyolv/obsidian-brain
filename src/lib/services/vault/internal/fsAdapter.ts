import fs from "node:fs/promises";

/**
 * Thin async wrapper over `node:fs/promises`. Exists so that the rest of the
 * vault module talks to a single, narrow filesystem surface and so that
 * `node:fs` is imported in EXACTLY ONE place in the entire codebase.
 *
 * Do not import this module from outside `lib/services/vault/`.
 *
 * Safety invariants enforced here:
 *   1. The set of filesystem primitives we are allowed to use is hard-coded
 *      below as {@link SAFE_FS_OPS}. Any operation NOT in that whitelist
 *      (notably `unlink`, `rm`, `rmdir`, `unlinkSync`, `cp` with `force`)
 *      is unreachable from this module — the rest of the vault layer cannot
 *      delete files even by accident.
 *   2. The module-load assertion below double-checks that no banned name
 *      ever leaks into the whitelist via a refactor. If it does, the process
 *      crashes loudly at startup instead of silently gaining a destructive
 *      capability.
 *   3. The strongest mutation we expose is `move` (a `rename`), used by
 *      `vaultService.softDelete` to relocate files into `Deleted/`.
 */

/**
 * The ONLY `node:fs/promises` operations the vault layer may use. Add to this
 * list deliberately and reluctantly; never add an operation whose name appears
 * in {@link FORBIDDEN_FS_OPS}.
 */
const SAFE_FS_OPS = Object.freeze({
  access: fs.access.bind(fs),
  readFile: fs.readFile.bind(fs),
  writeFile: fs.writeFile.bind(fs),
  appendFile: fs.appendFile.bind(fs),
  mkdir: fs.mkdir.bind(fs),
  /** Atomic on the same filesystem; used by softDelete and moveFile. */
  rename: fs.rename.bind(fs),
  readdir: fs.readdir.bind(fs),
  /** Read-only metadata; used by searchService to key its headings cache. */
  stat: fs.stat.bind(fs),
});

/**
 * Names — and substrings of names — that must NEVER appear in the whitelist.
 * The runtime check below treats this as authoritative.
 */
const FORBIDDEN_FS_OPS = [
  "unlink",
  "rm",
  "rmdir",
  "remove",
  "delete",
  "truncate",
  "ftruncate",
  "cp", // copyFile is fine via writeFile; raw `cp` allows recursive overwrite/delete behavior
] as const;

(function assertNoBannedFsOps(): void {
  for (const key of Object.keys(SAFE_FS_OPS)) {
    const lower = key.toLowerCase();
    for (const banned of FORBIDDEN_FS_OPS) {
      if (lower === banned || lower.includes(banned)) {
        throw new Error(
          `Vault fs whitelist violation: "${key}" matches forbidden op "${banned}". ` +
            `The vault module never permits destructive filesystem ops.`
        );
      }
    }
  }
})();

export async function pathExists(absPath: string): Promise<boolean> {
  try {
    await SAFE_FS_OPS.access(absPath);
    return true;
  } catch {
    return false;
  }
}

export async function readUtf8(absPath: string): Promise<string> {
  return SAFE_FS_OPS.readFile(absPath, "utf8");
}

export async function writeUtf8(absPath: string, contents: string): Promise<void> {
  await SAFE_FS_OPS.writeFile(absPath, contents, "utf8");
}

export async function appendUtf8(absPath: string, contents: string): Promise<void> {
  await SAFE_FS_OPS.appendFile(absPath, contents, "utf8");
}

export async function ensureDir(absPath: string): Promise<void> {
  await SAFE_FS_OPS.mkdir(absPath, { recursive: true });
}

/**
 * Move (rename) a file. Uses `fs.rename`, which is atomic on the same volume.
 * The vault module never exposes `unlink` — moves are the strongest mutation
 * we permit (see `softDelete` in `vaultService`).
 */
export async function move(srcAbs: string, destAbs: string): Promise<void> {
  await SAFE_FS_OPS.rename(srcAbs, destAbs);
}

export interface FileStat {
  /** Last-modification time as fractional milliseconds since epoch. */
  mtimeMs: number;
  /** File size in bytes. */
  size: number;
}

/**
 * Read-only metadata lookup. Throws if the path doesn't exist (or isn't
 * accessible) — the caller decides whether to treat that as a soft failure.
 */
export async function statFile(absPath: string): Promise<FileStat> {
  const s = await SAFE_FS_OPS.stat(absPath);
  return { mtimeMs: s.mtimeMs, size: s.size };
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

export async function readDir(absPath: string): Promise<DirEntry[]> {
  const entries = await SAFE_FS_OPS.readdir(absPath, { withFileTypes: true });
  return entries.map((e) => ({
    name: e.name,
    isDirectory: e.isDirectory(),
    isFile: e.isFile(),
  }));
}

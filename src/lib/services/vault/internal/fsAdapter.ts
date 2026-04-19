import fs from "node:fs/promises";

/**
 * Thin async wrapper over `node:fs/promises`. Exists so that the rest of the
 * vault module talks to a single, narrow filesystem surface and so that
 * `node:fs` is imported in exactly one place.
 *
 * Do not import this module from outside `lib/services/vault/`.
 */

export async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

export async function readUtf8(absPath: string): Promise<string> {
  return fs.readFile(absPath, "utf8");
}

export async function writeUtf8(absPath: string, contents: string): Promise<void> {
  await fs.writeFile(absPath, contents, "utf8");
}

export async function appendUtf8(absPath: string, contents: string): Promise<void> {
  await fs.appendFile(absPath, contents, "utf8");
}

export async function ensureDir(absPath: string): Promise<void> {
  await fs.mkdir(absPath, { recursive: true });
}

/**
 * Move (rename) a file. Uses `fs.rename`, which is atomic on the same volume.
 * The vault module never exposes `unlink` — moves are the strongest mutation
 * we permit (see `softDelete` in `vaultService`).
 */
export async function move(srcAbs: string, destAbs: string): Promise<void> {
  await fs.rename(srcAbs, destAbs);
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

export async function readDir(absPath: string): Promise<DirEntry[]> {
  const entries = await fs.readdir(absPath, { withFileTypes: true });
  return entries.map((e) => ({
    name: e.name,
    isDirectory: e.isDirectory(),
    isFile: e.isFile(),
  }));
}

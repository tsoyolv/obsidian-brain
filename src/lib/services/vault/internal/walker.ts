import path from "node:path";
import { readDir } from "./fsAdapter";

export interface WalkOptions {
  /**
   * Absolute paths of subtrees to skip entirely. Used by the vault service to
   * keep `Deleted/` out of search and listing results without losing the
   * ability to walk it explicitly when asked.
   */
  skipPaths?: ReadonlySet<string>;
}

/**
 * Recursively walk a directory and collect absolute paths of all `.md` files.
 * Hidden directories (`.obsidian`, `.trash`, …) are skipped.
 *
 * Returns absolute paths; the caller is responsible for converting them to
 * vault-relative paths via the paths helper.
 */
export async function walkMarkdown(
  rootAbsolute: string,
  options: WalkOptions = {}
): Promise<string[]> {
  const skip = options.skipPaths;
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory) {
        if (skip?.has(abs)) continue;
        await walk(abs);
      } else if (entry.isFile && entry.name.toLowerCase().endsWith(".md")) {
        out.push(abs);
      }
    }
  }

  await walk(rootAbsolute);
  return out;
}

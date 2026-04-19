import path from "node:path";
import { sanitizeFilename } from "@/lib/utils/filenames";

/**
 * Vault-relative path utilities. Pure string math, no I/O.
 *
 * IMPORTANT: this module is internal to the vault service. Do not import it
 * from anywhere outside `lib/services/vault/`. Other layers must work with
 * vault-relative path strings only and rely on vaultService to resolve them.
 */

/**
 * Resolve a path inside `root` and guarantee it does not escape it.
 * Throws on traversal attempts.
 */
export function safePathResolve(root: string, ...segments: string[]): string {
  const normalizedRoot = path.resolve(root);
  const candidate = path.resolve(normalizedRoot, ...segments);
  const rel = path.relative(normalizedRoot, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path traversal detected: ${segments.join("/")}`);
  }
  return candidate;
}

/** Returns a vault-relative path from an absolute path. */
export function toVaultRelative(root: string, absolute: string): string {
  return path.relative(path.resolve(root), absolute);
}

/**
 * Normalize and validate a vault-relative folder path. Strips leading
 * separators, rejects `..` segments, and sanitizes each segment so that
 * filenames are portable across platforms.
 */
export function sanitizeRelFolder(folder: string): string {
  const normalized = folder.replace(/^[/\\]+/, "");
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  for (const seg of segments) {
    if (seg === "..") throw new Error(`Invalid folder segment: ${folder}`);
    if (/[<>:"|?*\x00-\x1F]/.test(seg)) {
      throw new Error(`Invalid folder name: ${seg}`);
    }
  }
  return segments.map((s) => sanitizeFilename(s)).join(path.sep);
}

/** Pure helper for joining a folder with a filename into a vault-relative path. */
export function joinVaultPath(folder: string, filename: string): string {
  const f = sanitizeRelFolder(folder);
  return f ? `${f}${path.sep}${filename}` : filename;
}

/**
 * Normalize and validate a full vault-relative path (folder segments + final
 * filename). Strips leading separators, rejects `..` and control chars, and
 * sanitizes each segment for portability. Throws on empty input.
 */
export function sanitizeRelPath(rel: string): string {
  if (!rel || !rel.trim()) throw new Error("Empty vault path");
  if (path.isAbsolute(rel)) {
    throw new Error(`Vault path must be relative: ${rel}`);
  }
  const normalized = rel.replace(/^[/\\]+/, "");
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) throw new Error("Empty vault path");
  for (const seg of segments) {
    if (seg === "..") throw new Error(`Invalid path segment in: ${rel}`);
    if (/[<>:"|?*\x00-\x1F]/.test(seg)) {
      throw new Error(`Invalid character in path segment: ${seg}`);
    }
  }
  return segments.map((s) => sanitizeFilename(s)).join(path.sep);
}

/** OS-agnostic dirname for a vault-relative path. */
export function dirnameOf(relPath: string): string {
  return path.dirname(relPath);
}

/** OS-agnostic basename (without extension) for a vault-relative path. */
export function basenameWithoutExt(relPath: string, ext = ".md"): string {
  return path.basename(relPath, ext);
}

/** Append a timestamp suffix before the extension (collision-resolution). */
export function withTimestampSuffix(filename: string): string {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${base} ${stamp}${ext}`;
}

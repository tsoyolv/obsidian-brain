/**
 * Markdown helpers used by services to produce consistent vault content.
 */

export function h1(text: string): string {
  return `# ${text.trim()}\n`;
}

export function h2(text: string): string {
  return `## ${text.trim()}\n`;
}

export function h3(text: string): string {
  return `### ${text.trim()}\n`;
}

export function bullet(text: string): string {
  return `- ${text.trim()}\n`;
}

export function task(text: string, done = false): string {
  return `- [${done ? "x" : " "}] ${text.trim()}\n`;
}

export function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n") + "\n";
}

export function codeBlock(text: string, lang = ""): string {
  return `\`\`\`${lang}\n${text}\n\`\`\`\n`;
}

export function inlineCode(text: string): string {
  return `\`${text.replace(/`/g, "ʹ")}\``;
}

export function bold(text: string): string {
  return `**${text}**`;
}

export function italic(text: string): string {
  return `*${text}*`;
}

export function hr(): string {
  return `---\n`;
}

/** Standard markdown link. */
export function link(text: string, url: string): string {
  return `[${text}](${url})`;
}

/**
 * Obsidian wiki-link. `target` is typically a vault-relative path with the
 * `.md` stripped (Obsidian's expected form).
 */
export function wikiLink(target: string, alias?: string): string {
  const base = stripMdExt(target);
  return alias ? `[[${base}|${alias}]]` : `[[${base}]]`;
}

/** `#tag` helper that strips a leading `#` if the caller already included one. */
export function tag(name: string): string {
  return `#${name.replace(/^#+/, "")}`;
}

/**
 * Obsidian callout block.
 *  > [!note] Title
 *  > body line 1
 *  > body line 2
 */
export function callout(type: string, title: string, body: string): string {
  const header = `> [!${type}] ${title.trim()}`;
  const lines = body
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
  return `${header}\n${lines}\n`;
}

/** Joins blocks separating them with blank lines. */
export function joinBlocks(...blocks: string[]): string {
  return blocks
    .map((b) => b.replace(/\n+$/g, ""))
    .filter(Boolean)
    .join("\n\n") + "\n";
}

function stripMdExt(p: string): string {
  return p.toLowerCase().endsWith(".md") ? p.slice(0, -3) : p;
}

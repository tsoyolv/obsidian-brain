import type {
  DataDocumentKind,
  DataExtractionResult,
  DataLink,
  DataUpsertPolicy,
} from "@/lib/types";
import { getVaultService, VAULT_FOLDERS } from "@/lib/services/vault";
import { getSearchService } from "@/lib/services/search";
import { llmProviderFactory } from "@/lib/providers/llm";
import { getConfig } from "@/lib/config";
import { serializeMarkdown } from "@/lib/markdown/frontmatter";
import { ensureMarkdownExt, sanitizeFilename } from "@/lib/utils/filenames";
import { nowIso } from "@/lib/utils/id";

export const DATA_ROOT_FOLDER = VAULT_FOLDERS.data;
export const DATA_CHATS_FOLDER = `${DATA_ROOT_FOLDER}/Chats`;
export const DATA_CONCEPTS_FOLDER = `${DATA_ROOT_FOLDER}/Concepts`;
export const DATA_CASES_FOLDER = `${DATA_ROOT_FOLDER}/Cases`;
export const DATA_TASKS_FOLDER = `${DATA_ROOT_FOLDER}/Tasks`;
export const DATA_INDEXES_FOLDER = `${DATA_ROOT_FOLDER}/Indexes`;

export const DATA_KIND_FOLDERS: Record<DataDocumentKind, string> = {
  chat_archive: `${DATA_ROOT_FOLDER}/chat_archive`,
  concept: `${DATA_ROOT_FOLDER}/concept`,
  case: `${DATA_ROOT_FOLDER}/case`,
  index: `${DATA_ROOT_FOLDER}/index`,
};

export interface ArchiveChatSummaryInput {
  sessionId: string;
  title: string;
  summaryMarkdown: string;
  actionItems: string[];
  transcriptPath?: string;
  generatedAt?: string;
}

export interface UpsertConceptInput {
  title: string;
  extraction: DataExtractionResult;
  upsertPolicy?: DataUpsertPolicy;
}

export interface BuildIndexInput {
  scope?: DataDocumentKind | "all";
}

export interface ArchiveTaskSnapshotInput {
  sourcePath: string;
  archivePath: string | null;
  archivedCount: number;
  timestamp?: string;
}

export interface DataService {
  ensureReady(): Promise<void>;
  archiveChatSummary(input: ArchiveChatSummaryInput): Promise<void>;
  archiveTaskSnapshot(input: ArchiveTaskSnapshotInput): Promise<string>;
  upsertDataNote(input: {
    kind: DataDocumentKind;
    title: string;
    content: string;
    links?: string[];
  }): Promise<string>;
  linkDataNotes(input: { fromPath: string; toPaths: string[] }): Promise<void>;
  upsertConcept(input: UpsertConceptInput): Promise<string>;
  buildIndex(input?: BuildIndexInput): Promise<void>;
}

class DataServiceImpl implements DataService {
  private readonly vault = getVaultService();
  private readonly search = getSearchService();
  private readonly cfg = getConfig();

  async ensureReady(): Promise<void> {
    await this.vault.ensureFolders();
    await this.vault.ensureNoteExists(
      this.vault.joinPath(DATA_CHATS_FOLDER, ".keep.md"),
      "# Data Chats\n"
    );
    await this.vault.ensureNoteExists(
      this.vault.joinPath(DATA_CONCEPTS_FOLDER, ".keep.md"),
      "# Data Concepts\n"
    );
    await this.vault.ensureNoteExists(
      this.vault.joinPath(DATA_CASES_FOLDER, ".keep.md"),
      "# Data Cases\n"
    );
    await this.vault.ensureNoteExists(
      this.vault.joinPath(DATA_TASKS_FOLDER, ".keep.md"),
      "# Data Tasks\n"
    );
    await this.vault.ensureNoteExists(
      this.vault.joinPath(DATA_INDEXES_FOLDER, ".keep.md"),
      "# Data Indexes\n"
    );
  }

  async archiveChatSummary(input: ArchiveChatSummaryInput): Promise<void> {
    await this.ensureReady();

    const generatedAt = input.generatedAt ?? nowIso();
    const relPath = toDataChatSummaryPath(input.sessionId);
    const body = renderChatSummaryBody({
      title: input.title,
      generatedAt,
      summaryMarkdown: input.summaryMarkdown,
      actionItems: input.actionItems,
      transcriptPath: input.transcriptPath,
    });

    const raw = serializeMarkdown(body, {
      type: "data-chat-summary",
      session_id: input.sessionId,
      title: input.title,
      generated_at: generatedAt,
      transcript_path: input.transcriptPath,
      links: input.transcriptPath ? [input.transcriptPath] : [],
      action_items: input.actionItems,
    });

    await this.vault.ensureNoteExists(relPath, raw);
    await this.vault.writeRawNote(relPath, raw);

    const extracted = await this.extractConceptsFromSummary({
      sessionId: input.sessionId,
      title: input.title,
      summaryMarkdown: input.summaryMarkdown,
      actionItems: input.actionItems,
      transcriptPath: input.transcriptPath,
      chatArchivePath: relPath,
      generatedAt,
    });
    for (const concept of extracted) {
      const conceptPath = await this.upsertConcept({
        title: concept.title ?? "Untitled concept",
        extraction: concept,
        upsertPolicy: "create_or_merge",
      });
      await this.linkDocuments(relPath, [conceptPath]);
      await this.linkDocuments(conceptPath, [relPath]);
    }
    await this.buildIndex({ scope: "all" });
  }

  async archiveTaskSnapshot(input: ArchiveTaskSnapshotInput): Promise<string> {
    await this.ensureReady();
    const ts = input.timestamp ?? nowIso();
    const relPath = toDataTaskSnapshotPath(ts, input.sourcePath);
    const body = [
      "# Task Archive Snapshot",
      "",
      `Timestamp: ${ts}`,
      "",
      "## Fields",
      "",
      `- sourcePath: \`${input.sourcePath}\``,
      `- archivePath: \`${input.archivePath ?? ""}\``,
      `- archivedCount: ${input.archivedCount}`,
      "",
    ].join("\n");
    const raw = serializeMarkdown(body, {
      type: "data-task-archive-snapshot",
      source_path: input.sourcePath,
      archive_path: input.archivePath,
      archived_count: input.archivedCount,
      timestamp: ts,
      links: uniquePaths([input.sourcePath, input.archivePath ?? ""]),
    });
    await this.vault.ensureNoteExists(relPath, raw);
    await this.vault.writeRawNote(relPath, raw);
    await this.buildIndex({ scope: "index" });
    return relPath;
  }

  async upsertDataNote(input: {
    kind: DataDocumentKind;
    title: string;
    content: string;
    links?: string[];
  }): Promise<string> {
    await this.ensureReady();
    if (input.kind === "concept") {
      return this.upsertConcept({
        title: input.title,
        extraction: {
          kind: "concept",
          title: input.title,
          content: input.content,
          links: (input.links ?? []).map((p) => ({ target: p })),
          upsertPolicy: "create_or_merge",
        },
        upsertPolicy: "create_or_merge",
      });
    }
    const title = normalizeTitle(input.title);
    const relPath = toDataDocumentPath(input.kind, ensureMarkdownExt(title));
    const raw = serializeMarkdown(input.content, {
      type: `data-${input.kind}`,
      kind: input.kind,
      title,
      updated: nowIso(),
      links: uniquePaths(input.links ?? []),
    });
    await this.vault.ensureNoteExists(relPath, raw);
    await this.vault.writeRawNote(relPath, raw);
    if ((input.links?.length ?? 0) > 0) {
      await this.linkDocuments(relPath, input.links ?? []);
    }
    await this.buildIndex({ scope: "index" });
    return relPath;
  }

  async linkDataNotes(input: { fromPath: string; toPaths: string[] }): Promise<void> {
    await this.ensureReady();
    await this.linkDocuments(input.fromPath, input.toPaths);
    await this.buildIndex({ scope: "index" });
  }

  async upsertConcept(input: UpsertConceptInput): Promise<string> {
    await this.ensureReady();
    const upsertPolicy = input.upsertPolicy ?? "create_or_merge";
    if (upsertPolicy !== "create_or_merge") {
      throw new Error(`Unsupported upsert policy: ${upsertPolicy}`);
    }
    const conceptTitle = normalizeTitle(input.title);
    const existingPath = await this.findSimilarConceptPath(conceptTitle);
    if (!existingPath) {
      const createdPath = toDataConceptPath(conceptTitle);
      const body = renderConceptInitialBody({
          title: conceptTitle,
          extraction: input.extraction,
        });
      const raw = serializeMarkdown(body, {
          type: "data-concept",
          kind: "concept",
          title: conceptTitle,
          created: nowIso(),
          updated: nowIso(),
          links: (input.extraction.links ?? []).map((l) => l.target),
        });
      await this.vault.ensureNoteExists(createdPath, raw);
      await this.vault.writeRawNote(createdPath, raw);
      const casePaths = await this.maybeDecomposeConceptToCases(
        createdPath,
        conceptTitle,
        body,
        input.extraction
      );
      const directLinks = (input.extraction.links ?? []).map((l) => l.target);
      await this.linkDocuments(createdPath, [...directLinks, ...casePaths]);
      for (const casePath of casePaths) {
        await this.linkDocuments(casePath, [createdPath, ...directLinks]);
      }
      return createdPath;
    }

    const note = await this.vault.readNote(existingPath);
    const mergedBody = appendConceptUpdateSection(note.body, {
      extraction: input.extraction,
      generatedAt: nowIso(),
    });
    const mergedFrontmatter = {
      ...note.data,
      updated: nowIso(),
      links: mergeLinkTargets(
        note.data.links,
        (input.extraction.links ?? []).map((l) => l.target)
      ),
    };
    await this.vault.writeRawNote(existingPath, serializeMarkdown(mergedBody, mergedFrontmatter));
    const casePaths = await this.maybeDecomposeConceptToCases(
      existingPath,
      conceptTitle,
      mergedBody,
      input.extraction
    );
    const directLinks = (input.extraction.links ?? []).map((l) => l.target);
    await this.linkDocuments(existingPath, [...directLinks, ...casePaths]);
    for (const casePath of casePaths) {
      await this.linkDocuments(casePath, [existingPath, ...directLinks]);
    }
    return existingPath;
  }

  async buildIndex(_input?: BuildIndexInput): Promise<void> {
    await this.ensureReady();
    const scope = _input?.scope ?? "all";
    if (scope === "all" || scope === "concept" || scope === "case" || scope === "index") {
      await this.rebuildTopicsIndex();
    }
    if (scope === "all" || scope === "chat_archive" || scope === "index") {
      await this.rebuildChatsIndex();
    }
    // Tasks index is not tied to DataDocumentKind but should be refreshed
    // together with index rebuilds.
    if (scope === "all" || scope === "index") {
      await this.rebuildTasksIndex();
    }
  }

  private async extractConceptsFromSummary(
    input: ExtractConceptsInput
  ): Promise<DataExtractionResult[]> {
    const items = await extractConceptItemsWithLlm(input);
    return items.map((item) => {
      const links: DataLink[] = [];
      if (input.transcriptPath) {
        links.push({
          target: input.transcriptPath,
          relation: "source_transcript",
          confidence: 1,
        });
      }
      links.push({
        target: input.chatArchivePath,
        relation: "chat_archive",
        confidence: 1,
      });
      return {
        kind: "concept",
        title: item.title,
        content: item.summary,
        links,
        upsertPolicy: "create_or_merge",
        metadata: {
          source: "chat_summary_extraction",
          sessionId: input.sessionId,
          generatedAt: input.generatedAt,
        },
      };
    });
  }

  private async findSimilarConceptPath(title: string): Promise<string | undefined> {
    const layered = await this.search.searchLayered(title, {
      folder: DATA_CONCEPTS_FOLDER,
      limit: 5,
    });
    const candidates = [...layered.byFilename, ...layered.strong, ...layered.near];
    for (const c of candidates) {
      if (titleSimilarity(title, c.title) >= 0.6) {
        return c.path;
      }
    }
    return undefined;
  }

  private async maybeDecomposeConceptToCases(
    conceptPath: string,
    conceptTitle: string,
    conceptBody: string,
    extraction: DataExtractionResult
  ): Promise<string[]> {
    const threshold = this.cfg.data.conceptDecompositionThresholdChars;
    if (conceptBody.length <= threshold) return [];

    const subtopics = await extractSubtopicsWithLlm({
      title: conceptTitle,
      conceptMarkdown: conceptBody,
    });
    if (subtopics.length < 2) return [];

    const casePaths: string[] = [];
    for (const subtopic of subtopics) {
      const casePath = toDataCasePath(conceptTitle, subtopic.title);
      casePaths.push(casePath);
      const raw = serializeMarkdown(
        renderCaseBody({
          conceptTitle,
          conceptPath,
          subtopicTitle: subtopic.title,
          summary: subtopic.summary,
        }),
        {
          type: "data-case",
          kind: "case",
          title: `${conceptTitle} — ${subtopic.title}`,
          concept_title: conceptTitle,
          concept_path: conceptPath,
          updated: nowIso(),
          links: mergeLinkTargets(
            [conceptPath, ...(extraction.links ?? []).map((l) => l.target)],
            [conceptPath]
          ),
        }
      );
      await this.vault.ensureNoteExists(casePath, raw);
      await this.vault.writeRawNote(casePath, raw);
    }

    const withLinks = ensureRelatedCasesSection(conceptBody, conceptTitle, subtopics);
    if (withLinks !== conceptBody) {
      const note = await this.vault.readNote(conceptPath);
      const mergedFrontmatter = {
        ...note.data,
        updated: nowIso(),
        links: mergeLinkTargets(
          note.data.links,
          subtopics.map((s) => toDataCasePath(conceptTitle, s.title))
        ),
      };
      await this.vault.writeRawNote(conceptPath, serializeMarkdown(withLinks, mergedFrontmatter));
    }
    return casePaths;
  }

  private async linkDocuments(fromPath: string, rawTargets: string[]): Promise<void> {
    const targets = uniquePaths(rawTargets).filter((t) => t !== fromPath);
    if (targets.length === 0) return;

    await this.ensureOutgoingLinks(fromPath, targets);
    for (const target of targets) {
      if (!(await this.vault.fileExists(target))) continue;
      await this.ensureBacklink(target, fromPath);
    }
  }

  private async ensureOutgoingLinks(fromPath: string, targets: string[]): Promise<void> {
    const note = await this.vault.readNote(fromPath);
    const nextBody = upsertLinksSection(note.body, targets);
    if (nextBody === note.body) return;
    await this.vault.writeRawNote(
      fromPath,
      serializeMarkdown(nextBody, {
        ...note.data,
        updated: nowIso(),
        links: mergeLinkTargets(note.data.links, targets),
      })
    );
  }

  private async ensureBacklink(targetPath: string, fromPath: string): Promise<void> {
    const note = await this.vault.readNote(targetPath);
    const nextBody = upsertBacklinksSection(note.body, [fromPath]);
    if (nextBody === note.body) return;
    await this.vault.writeRawNote(
      targetPath,
      serializeMarkdown(nextBody, {
        ...note.data,
        updated: nowIso(),
        links: mergeLinkTargets(note.data.links, [fromPath]),
      })
    );
  }

  private async rebuildTopicsIndex(): Promise<void> {
    const concepts = (await this.vault.listFiles(DATA_CONCEPTS_FOLDER)).filter(
      (p) => !p.endsWith("/.keep.md")
    );
    const cases = (await this.vault.listFiles(DATA_CASES_FOLDER)).filter(
      (p) => !p.endsWith("/.keep.md")
    );
    const lines: string[] = [
      "# Topics Index",
      "",
      `Updated: ${nowIso()}`,
      "",
      "## Concepts",
      "",
    ];
    if (concepts.length === 0) {
      lines.push("- (none)");
    } else {
      for (const rel of concepts.sort()) lines.push(`- [[${rel}]]`);
    }
    lines.push("", "## Cases", "");
    if (cases.length === 0) {
      lines.push("- (none)");
    } else {
      for (const rel of cases.sort()) lines.push(`- [[${rel}]]`);
    }
    lines.push("");
    await this.writeIndexFile(toDataTopicsIndexPath(), lines.join("\n"));
  }

  private async rebuildChatsIndex(): Promise<void> {
    const chats = (await this.vault.listFiles(DATA_CHATS_FOLDER)).filter(
      (p) => !p.endsWith("/.keep.md")
    );
    const lines: string[] = ["# Chat Archives Index", "", `Updated: ${nowIso()}`, "", "## Chats", ""];
    if (chats.length === 0) {
      lines.push("- (none)");
    } else {
      for (const rel of chats.sort()) lines.push(`- [[${rel}]]`);
    }
    lines.push("");
    await this.writeIndexFile(toDataChatsIndexPath(), lines.join("\n"));
  }

  private async rebuildTasksIndex(): Promise<void> {
    const taskFiles = (await this.vault.listFiles(VAULT_FOLDERS.tasks)).filter(
      (p) => !p.endsWith("/.keep.md")
    );
    const snapshots = (await this.vault.listFiles(DATA_TASKS_FOLDER)).filter(
      (p) => !p.endsWith("/.keep.md")
    );
    const sources = taskFiles.filter((p) => !p.includes(`${VAULT_FOLDERS.tasks}/archive/`));
    const archives = taskFiles.filter((p) => p.includes(`${VAULT_FOLDERS.tasks}/archive/`));
    const lines: string[] = ["# Tasks Index", "", `Updated: ${nowIso()}`, "", "## Task Sources", ""];
    if (sources.length === 0) {
      lines.push("- (none)");
    } else {
      for (const rel of sources.sort()) lines.push(`- [[${rel}]]`);
    }
    lines.push("", "## Task Archives", "");
    if (archives.length === 0) {
      lines.push("- (none)");
    } else {
      for (const rel of archives.sort()) lines.push(`- [[${rel}]]`);
    }
    lines.push("", "## Data Snapshots", "");
    if (snapshots.length === 0) {
      lines.push("- (none)");
    } else {
      for (const rel of snapshots.sort()) lines.push(`- [[${rel}]]`);
    }
    lines.push("");
    await this.writeIndexFile(toDataTasksIndexPath(), lines.join("\n"));
  }

  private async writeIndexFile(path: string, body: string): Promise<void> {
    await this.vault.ensureNoteExists(path, body);
    await this.vault.writeRawNote(path, body);
  }
}

let cached: DataService | null = null;

export function getDataService(): DataService {
  if (cached) return cached;
  cached = new DataServiceImpl();
  return cached;
}

export function _resetDataServiceCache(): void {
  cached = null;
}

export function getDataKindFolder(kind: DataDocumentKind): string {
  return DATA_KIND_FOLDERS[kind];
}

export function toDataDocumentPath(kind: DataDocumentKind, filename: string): string {
  const folder = getDataKindFolder(kind);
  return getVaultService().safePathResolve(getVaultService().joinPath(folder, filename));
}

export function toDataChatSummaryPath(sessionId: string): string {
  const filename = ensureMarkdownExt(sessionId.trim());
  return getVaultService().safePathResolve(
    getVaultService().joinPath(DATA_CHATS_FOLDER, filename)
  );
}

export function toDataConceptPath(title: string): string {
  const filename = ensureMarkdownExt(sanitizeFilename(title));
  return getVaultService().safePathResolve(
    getVaultService().joinPath(DATA_CONCEPTS_FOLDER, filename)
  );
}

export function toDataCasePath(conceptTitle: string, subtopicTitle: string): string {
  const filename = ensureMarkdownExt(
    sanitizeFilename(`${conceptTitle} - ${subtopicTitle}`)
  );
  return getVaultService().safePathResolve(
    getVaultService().joinPath(DATA_CASES_FOLDER, filename)
  );
}

export function toDataTopicsIndexPath(): string {
  return getVaultService().safePathResolve(
    getVaultService().joinPath(DATA_INDEXES_FOLDER, "topics.md")
  );
}

export function toDataChatsIndexPath(): string {
  return getVaultService().safePathResolve(
    getVaultService().joinPath(DATA_INDEXES_FOLDER, "chats.md")
  );
}

export function toDataTasksIndexPath(): string {
  return getVaultService().safePathResolve(
    getVaultService().joinPath(DATA_INDEXES_FOLDER, "tasks.md")
  );
}

export function toDataTaskSnapshotPath(timestamp: string, sourcePath: string): string {
  const sourceStem = sourcePath
    .replace(/[\\/]/g, " ")
    .replace(/\.md$/i, "")
    .trim();
  const filename = ensureMarkdownExt(`${timestamp} ${sourceStem} snapshot`);
  return getVaultService().safePathResolve(
    getVaultService().joinPath(DATA_TASKS_FOLDER, filename)
  );
}

function renderChatSummaryBody(input: {
  title: string;
  generatedAt: string;
  summaryMarkdown: string;
  actionItems: string[];
  transcriptPath?: string;
}): string {
  const normalized = normalizeChatSummarySections(input.summaryMarkdown);
  const parts: string[] = [
    `# ${input.title}`,
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## Summary",
    "",
    normalized.summary,
    "",
    "## Action Items",
    "",
  ];

  const actionItems = input.actionItems.length > 0 ? input.actionItems : normalized.actionItems;
  if (actionItems.length > 0) {
    for (const item of actionItems) {
      parts.push(`- [ ] ${item}`);
    }
  } else {
    parts.push("- (none)");
  }

  parts.push("", "## Links", "");
  if (input.transcriptPath) {
    parts.push(`- [[${input.transcriptPath}]]`);
  } else {
    parts.push("- (transcript unavailable)");
  }
  parts.push("");
  return parts.join("\n");
}

function normalizeChatSummarySections(input: string): {
  summary: string;
  actionItems: string[];
} {
  const text = input.trim();
  if (!text) return { summary: "_No summary provided._", actionItems: [] };
  const actionHeading = /\n##\s+Action Items\s*\n/i;
  const m = actionHeading.exec(`\n${text}\n`);
  if (!m) {
    return { summary: stripLeadingSummaryHeading(text), actionItems: [] };
  }
  const idx = Math.max(0, m.index - 1);
  const summaryPart = stripLeadingSummaryHeading(text.slice(0, idx).trim());
  const actionPart = text.slice(idx).replace(/^##\s+Action Items\s*/i, "").trim();
  const items = actionPart
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .map((line) => line.replace(/^-+\s*(\[\s?\]\s*)?/, "").trim())
    .filter(Boolean);
  return { summary: summaryPart || "_No summary provided._", actionItems: items };
}

function stripLeadingSummaryHeading(input: string): string {
  return input.replace(/^##\s+Summary\s*/i, "").trim();
}

function renderConceptInitialBody(input: {
  title: string;
  extraction: DataExtractionResult;
}): string {
  const links = input.extraction.links ?? [];
  const content = input.extraction.content?.trim() || "_No concept body yet._";
  const parts: string[] = [`# ${input.title}`, "", "## Concept", "", content, ""];
  parts.push("## Links", "");
  if (links.length > 0) {
    for (const link of links) {
      parts.push(`- ${link.relation ? `${link.relation}: ` : ""}${link.target}`);
    }
  } else {
    parts.push("- (none)");
  }
  parts.push("", "## Updates", "");
  parts.push(`- Created: ${nowIso()}`, "");
  return parts.join("\n");
}

function appendConceptUpdateSection(
  body: string,
  input: { extraction: DataExtractionResult; generatedAt: string }
): string {
  const updateLines: string[] = [
    `### ${input.generatedAt}`,
    "",
    input.extraction.content?.trim() || "_No extracted details_",
    "",
    "Links:",
  ];
  const links = input.extraction.links ?? [];
  if (links.length > 0) {
    for (const link of links) {
      updateLines.push(`- ${link.relation ? `${link.relation}: ` : ""}${link.target}`);
    }
  } else {
    updateLines.push("- (none)");
  }
  updateLines.push("");

  if (/\n## Updates\s*\n/i.test(body)) {
    return `${body.trimEnd()}\n\n${updateLines.join("\n")}`.trimEnd() + "\n";
  }
  return `${body.trimEnd()}\n\n## Updates\n\n${updateLines.join("\n")}`.trimEnd() + "\n";
}

function normalizeTitle(input: string): string {
  const base = sanitizeFilename(input).trim();
  return base.length > 0 ? base : "Untitled concept";
}

function renderCaseBody(input: {
  conceptTitle: string;
  conceptPath: string;
  subtopicTitle: string;
  summary: string;
}): string {
  return [
    `# ${input.conceptTitle} — ${input.subtopicTitle}`,
    "",
    "## Case",
    "",
    input.summary.trim() || "_No case details_",
    "",
    "## Links",
    "",
    `- concept: [[${input.conceptPath}]]`,
    "",
  ].join("\n");
}

function ensureRelatedCasesSection(
  conceptBody: string,
  conceptTitle: string,
  subtopics: SubtopicItem[]
): string {
  const links = subtopics.map((s) => `- [[${toDataCasePath(conceptTitle, s.title)}]]`);
  const section = ["## Related Cases", "", ...links, ""].join("\n");
  if (/\n## Related Cases\s*\n/i.test(conceptBody)) {
    return conceptBody.replace(
      /\n## Related Cases[\s\S]*$/i,
      `\n${section}`.trimEnd() + "\n"
    );
  }
  return `${conceptBody.trimEnd()}\n\n${section}`.trimEnd() + "\n";
}

function tokenizeSimple(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_\-а-яё]+/i)
    .filter((s) => s.length >= 2);
}

function titleSimilarity(a: string, b: string): number {
  const ta = new Set(tokenizeSimple(a));
  const tb = new Set(tokenizeSimple(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  return common / Math.max(ta.size, tb.size);
}

function mergeLinkTargets(existing: unknown, incoming: string[]): string[] {
  const out = new Set<string>();
  if (Array.isArray(existing)) {
    for (const v of existing) {
      if (typeof v === "string" && v.trim().length > 0) out.add(v.trim());
    }
  }
  for (const v of incoming) {
    const s = v.trim();
    if (s.length > 0) out.add(s);
  }
  return [...out];
}

interface ExtractConceptsInput {
  sessionId: string;
  title: string;
  summaryMarkdown: string;
  actionItems: string[];
  transcriptPath?: string;
  chatArchivePath: string;
  generatedAt: string;
}

interface ExtractedConceptItem {
  title: string;
  summary: string;
}

interface SubtopicItem {
  title: string;
  summary: string;
}

async function extractConceptItemsWithLlm(
  input: ExtractConceptsInput
): Promise<ExtractedConceptItem[]> {
  const llm = llmProviderFactory.get();
  const response = await llm.sendMessage({
    temperature: 0.1,
    responseFormat: "json_object",
    messages: [
      {
        role: "system",
        content:
          "Extract 1..N reusable concepts from a chat summary. Return strict JSON object: " +
          '{ "concepts": [{ "title": string, "summary": string }] }. ' +
          "No markdown, no extra keys.",
      },
      {
        role: "user",
        content:
          `Session ID: ${input.sessionId}\n` +
          `Chat title: ${input.title}\n` +
          `Generated at: ${input.generatedAt}\n` +
          `Transcript path: ${input.transcriptPath ?? "(none)"}\n\n` +
          `Summary:\n${input.summaryMarkdown}\n\n` +
          `Action items:\n${input.actionItems.map((x) => `- ${x}`).join("\n") || "- (none)"}`,
      },
    ],
  });
  return parseConceptItemsJson(response.content);
}

function parseConceptItemsJson(raw: string): ExtractedConceptItem[] {
  try {
    const parsed = JSON.parse(raw) as { concepts?: unknown };
    if (!Array.isArray(parsed.concepts)) return [];
    const out: ExtractedConceptItem[] = [];
    for (const item of parsed.concepts) {
      if (!item || typeof item !== "object") continue;
      const title = typeof (item as { title?: unknown }).title === "string"
        ? (item as { title: string }).title.trim()
        : "";
      const summary = typeof (item as { summary?: unknown }).summary === "string"
        ? (item as { summary: string }).summary.trim()
        : "";
      if (!title || !summary) continue;
      out.push({ title, summary });
    }
    return out;
  } catch {
    return [];
  }
}

async function extractSubtopicsWithLlm(input: {
  title: string;
  conceptMarkdown: string;
}): Promise<SubtopicItem[]> {
  const llm = llmProviderFactory.get();
  const response = await llm.sendMessage({
    temperature: 0.1,
    responseFormat: "json_object",
    messages: [
      {
        role: "system",
        content:
          "Extract conceptual subtopics from the concept markdown. Return strict JSON: " +
          '{ "subtopics": [{ "title": string, "summary": string }] }. ' +
          "Return at least two only when truly distinct; otherwise return fewer.",
      },
      {
        role: "user",
        content: `Concept title: ${input.title}\n\nConcept markdown:\n${input.conceptMarkdown}`,
      },
    ],
  });
  try {
    const parsed = JSON.parse(response.content) as { subtopics?: unknown };
    if (!Array.isArray(parsed.subtopics)) return [];
    const out: SubtopicItem[] = [];
    for (const item of parsed.subtopics) {
      if (!item || typeof item !== "object") continue;
      const title = typeof (item as { title?: unknown }).title === "string"
        ? (item as { title: string }).title.trim()
        : "";
      const summary = typeof (item as { summary?: unknown }).summary === "string"
        ? (item as { summary: string }).summary.trim()
        : "";
      if (!title || !summary) continue;
      out.push({ title, summary });
    }
    return out;
  } catch {
    return [];
  }
}

function uniquePaths(paths: string[]): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    const cleaned = path.trim();
    if (!cleaned) continue;
    out.add(cleaned);
  }
  return [...out];
}

function upsertLinksSection(body: string, targets: string[]): string {
  const merged = uniquePaths([...extractSectionLinks(body, "Links"), ...targets]).map(
    (target) => `- [[${target}]]`
  );
  if (merged.length === 0) return body;
  return upsertSection(body, "Links", merged);
}

function upsertBacklinksSection(body: string, sources: string[]): string {
  const merged = uniquePaths([
    ...extractSectionLinks(body, "Backlinks (auto)"),
    ...sources,
  ]).map((source) => `- [[${source}]]`);
  return upsertSection(body, "Backlinks (auto)", merged, { atEnd: true });
}

function extractSectionLinks(body: string, heading: string): string[] {
  const section = readSection(body, heading);
  if (!section) return [];
  const out: string[] = [];
  const linkRe = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(section)) !== null) {
    out.push(m[1]!.trim());
  }
  return out;
}

function readSection(body: string, heading: string): string | undefined {
  const source = `\n${body.trimEnd()}\n`;
  const marker = `\n## ${heading}`;
  const start = source.indexOf(marker);
  if (start === -1) return undefined;
  const contentStart = source.indexOf("\n", start + marker.length);
  if (contentStart === -1) return "";
  const nextHeading = source.indexOf("\n## ", contentStart + 1);
  if (nextHeading === -1) return source.slice(contentStart + 1).trim();
  return source.slice(contentStart + 1, nextHeading).trim();
}

function upsertSection(
  body: string,
  heading: string,
  lines: string[],
  options: { atEnd?: boolean } = {}
): string {
  const section = [`## ${heading}`, "", ...lines, ""].join("\n");
  const source = body.trimEnd();
  const marker = `\n## ${heading}`;
  const withLead = `\n${source}\n`;
  const start = withLead.indexOf(marker);
  if (start !== -1) {
    const contentStart = withLead.indexOf("\n", start + marker.length);
    const nextHeading = withLead.indexOf("\n## ", (contentStart === -1 ? start : contentStart) + 1);
    const before = withLead.slice(1, start).trimEnd();
    const after =
      nextHeading === -1 ? "" : withLead.slice(nextHeading + 1).trimStart();
    const base = before ? `${before}\n\n${section}` : section;
    return (after ? `${base}\n${after}` : base).trimEnd() + "\n";
  }
  if (options.atEnd) {
    return `${source}\n\n${section}`.trimEnd() + "\n";
  }
  return `${source}\n\n${section}`.trimEnd() + "\n";
}

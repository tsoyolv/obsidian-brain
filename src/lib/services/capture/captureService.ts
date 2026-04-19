import { llmProviderFactory } from "@/lib/providers/llm";
import { sttProviderFactory } from "@/lib/providers/stt";
import type { IntentResult } from "@/lib/providers/llm";
import { getVaultService, VAULT_FOLDERS } from "@/lib/services/vault";
import { getTaskService } from "@/lib/services/task";
import { getSearchService } from "@/lib/services/search";
import type { CaptureActionResult, VoiceLogResult } from "@/lib/types";
import {
  compactLocalStamp,
  nowIso,
  todayLocalDate,
} from "@/lib/utils/id";
import { ensureMarkdownExt, sanitizeFilename } from "@/lib/utils/filenames";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("captureService");

export interface CaptureTextInput {
  text: string;
  /** Optional vault-relative path of an existing voice log to link. */
  voiceLogPath?: string;
}

export interface CaptureVoiceInput {
  audio: Buffer;
  filename: string;
  mimeType?: string;
  language?: string;
}

export interface CaptureService {
  ensureReady(): Promise<void>;
  /**
   * Transcribe audio and persist a raw voice log under `Voice Logs/`.
   * Classification / action execution is intentionally NOT performed here —
   * that belongs to a higher-level pipeline that consumes voice logs.
   */
  saveVoiceLog(input: CaptureVoiceInput): Promise<VoiceLogResult>;
  handleText(input: CaptureTextInput): Promise<CaptureActionResult>;
}

class CaptureServiceImpl implements CaptureService {
  private readonly vault = getVaultService();
  private readonly tasks = getTaskService();
  private readonly search = getSearchService();

  async ensureReady(): Promise<void> {
    await this.vault.ensureFolders();
  }

  async saveVoiceLog(input: CaptureVoiceInput): Promise<VoiceLogResult> {
    await this.ensureReady();
    const stt = sttProviderFactory.get();
    const result = await stt.transcribe({
      audio: input.audio,
      filename: input.filename,
      mimeType: input.mimeType,
      language: input.language,
    });

    const stamp = compactLocalStamp();
    const created = await this.vault.createNote({
      folder: VAULT_FOLDERS.voiceLogs,
      title: `voice ${stamp}`,
      content: result.text || "_(empty transcription)_",
      metadata: {
        type: "voice-log",
        created: nowIso(),
        provider: result.provider,
        model: result.model,
        status: "raw",
      },
      uniqueOnConflict: true,
    });

    log.info("saveVoiceLog", { path: created.path, chars: result.text.length });
    return {
      path: created.path,
      transcript: result.text,
      provider: result.provider,
      model: result.model,
    };
  }

  async handleText(input: CaptureTextInput): Promise<CaptureActionResult> {
    await this.ensureReady();
    const text = input.text.trim();
    if (!text) {
      return {
        intent: "unknown",
        status: "error",
        message: "Empty input. Type something to capture.",
      };
    }

    const llm = llmProviderFactory.get();
    const classification = await llm.classifyIntent(text);
    return this.execute(classification, { voiceLogPath: input.voiceLogPath });
  }

  // ---- internals ----

  private async execute(
    cls: IntentResult,
    ctx: { voiceLogPath?: string }
  ): Promise<CaptureActionResult> {
    switch (cls.intent) {
      case "note": {
        const title = (cls.title ?? deriveTitle(cls.text)).trim() || "note";
        const filename = ensureMarkdownExt(`${todayLocalDate()} ${title}`);
        const created = await this.vault.createNote({
          folder: VAULT_FOLDERS.inbox,
          title: filename,
          content: buildNoteBody(cls.text, ctx.voiceLogPath),
          metadata: {
            type: "note",
            created: nowIso(),
            source: ctx.voiceLogPath ? "voice" : "text",
            tags: cls.tags,
            ...(ctx.voiceLogPath ? { voice_log: ctx.voiceLogPath } : {}),
          },
          uniqueOnConflict: true,
        });
        return {
          intent: "note",
          status: "ok",
          message: `Saved note "${sanitizeFilename(title)}".`,
          details: { path: created.path },
        };
      }

      case "create_task": {
        const taskText = (cls.taskText ?? cls.text).trim();
        if (!taskText) {
          return {
            intent: "create_task",
            status: "error",
            message: "Could not understand the task text.",
          };
        }
        const result = await this.tasks.createTask({ text: taskText });
        return {
          intent: "create_task",
          status: "ok",
          message: `Created task: "${result.text}"`,
          details: { path: result.path, text: result.text },
        };
      }

      case "complete_task": {
        const needle = (cls.taskText ?? cls.text).trim();
        if (!needle) {
          return {
            intent: "complete_task",
            status: "error",
            message: "Tell me which task to complete.",
          };
        }
        const result = await this.tasks.completeTask(needle);
        if (result.status === "ok") {
          return {
            intent: "complete_task",
            status: "ok",
            message: `Completed task: "${result.hit.text}"`,
            details: { path: result.hit.path, line: result.hit.line },
          };
        }
        if (result.status === "ambiguous") {
          return {
            intent: "complete_task",
            status: "ambiguous",
            message:
              `Need clarification: ${result.matches.length} tasks match "${needle}". ` +
              `Please be more specific.`,
            details: {
              matches: result.matches.map((m) => ({
                text: m.text,
                path: m.path,
                line: m.line,
              })),
            },
          };
        }
        return {
          intent: "complete_task",
          status: "not_found",
          message: `No open task matches "${needle}".`,
        };
      }

      case "search": {
        const query = cls.text.trim();
        const hits = await this.search.search(query, { limit: 10 });
        if (hits.length === 0) {
          return {
            intent: "search",
            status: "not_found",
            message: `Found 0 matching notes for "${query}".`,
            details: { query, hits: [] },
          };
        }
        return {
          intent: "search",
          status: "ok",
          message: `Found ${hits.length} matching note${hits.length === 1 ? "" : "s"}.`,
          details: { query, hits },
        };
      }

      case "ask_vault_question": {
        const answer = await this.answerVaultQuestion(cls.text);
        return {
          intent: "ask_vault_question",
          status: "ok",
          message: answer.answer,
          details: { sources: answer.sources },
        };
      }

      case "unknown":
      default: {
        return {
          intent: "unknown",
          status: "error",
          message:
            "I'm not sure what to do with that. Try saying things like " +
            '"save a note about ...", "create a task ...", or "search for ...".',
        };
      }
    }
  }

  private async answerVaultQuestion(question: string): Promise<{
    answer: string;
    sources: { path: string; title: string }[];
  }> {
    const hits = await this.search.search(question, { limit: 5 });
    const llm = llmProviderFactory.get();

    const contextParts: string[] = [];
    for (const h of hits) {
      try {
        const note = await this.vault.readNote(h.path);
        const trimmed = note.body.slice(0, 1500);
        contextParts.push(`--- ${h.path} ---\n${trimmed}`);
      } catch {
        // skip unreadable notes silently — they just won't contribute context
      }
    }

    const context = contextParts.join("\n\n") || "(no relevant notes found)";

    const resp = await llm.sendMessage({
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You answer the user's question using ONLY the provided notes. " +
            "If the answer isn't in the notes, say so plainly. Be concise.",
        },
        {
          role: "user",
          content: `Question: ${question}\n\nNotes:\n${context}`,
        },
      ],
    });

    return {
      answer: resp.content.trim() || "(no answer)",
      sources: hits.map((h) => ({ path: h.path, title: h.title })),
    };
  }
}

let cached: CaptureService | null = null;

export function getCaptureService(): CaptureService {
  if (cached) return cached;
  cached = new CaptureServiceImpl();
  return cached;
}

// ---- helpers ----

function deriveTitle(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  const trimmed = firstLine.trim().replace(/[#*_>`]+/g, "");
  if (trimmed.length <= 60) return trimmed || "note";
  return trimmed.slice(0, 60).trim() + "…";
}

function buildNoteBody(text: string, voiceLogPath?: string): string {
  const parts = [text.trim()];
  if (voiceLogPath) {
    parts.push(`\n\n---\n_Source voice log:_ [[${stripMdExt(voiceLogPath)}]]`);
  }
  return parts.join("\n");
}

function stripMdExt(p: string): string {
  return p.toLowerCase().endsWith(".md") ? p.slice(0, -3) : p;
}

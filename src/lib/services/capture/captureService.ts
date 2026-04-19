import { llmProviderFactory } from "@/lib/providers/llm";
import { sttProviderFactory } from "@/lib/providers/stt";
import type { IntentResult } from "@/lib/providers/llm";
import { getVaultService, VAULT_FOLDERS } from "@/lib/services/vault";
import { getTaskService } from "@/lib/services/task";
import { getSearchService } from "@/lib/services/search";
import { getFileCandidateService } from "@/lib/services/fileCandidate";
import type {
  CaptureActionResult,
  CaptureIntent,
  VoiceLogResult,
} from "@/lib/types";
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

/**
 * Persist a Voice Log using a transcript that has already been produced by
 * the STT provider (e.g. by the transcribe-only endpoint). This avoids
 * running transcription a second time when the UI already received the text
 * and showed it to the user for editing.
 */
export interface SaveVoiceLogFromTranscriptInput {
  transcript: string;
  provider: string;
  model: string;
}

/**
 * Incremental events emitted by {@link CaptureService.streamText}.
 *
 * The pipeline is identical to {@link CaptureService.handleText} but surfaces
 * intermediate progress so the UI can render partial state — notably, the
 * per-token answer stream for `ask_vault_question`. For every other intent
 * only `classified` and `result` are emitted (no `delta` frames).
 */
export type CaptureStreamEvent =
  | { type: "classified"; intent: CaptureIntent }
  | { type: "delta"; text: string }
  | { type: "result"; result: CaptureActionResult };

export interface CaptureService {
  ensureReady(): Promise<void>;
  /**
   * Transcribe audio and persist a raw voice log under `Voice Logs/`.
   * Classification / action execution is intentionally NOT performed here —
   * that belongs to a higher-level pipeline that consumes voice logs.
   */
  saveVoiceLog(input: CaptureVoiceInput): Promise<VoiceLogResult>;
  /**
   * Persist a Voice Log entry using an already-produced transcript.
   * Used by the two-step UI flow (transcribe → edit → send) so we don't
   * re-run the STT provider with the same audio.
   */
  saveVoiceLogFromTranscript(
    input: SaveVoiceLogFromTranscriptInput
  ): Promise<VoiceLogResult>;
  /**
   * End-to-end capture pipeline for a textual request:
   *   1. Save the raw input as a capture log (durable record, never lost).
   *   2. Classify intent via the LLM (strict JSON `{ intent, data }`).
   *   3. Execute the matching business action.
   */
  handleText(input: CaptureTextInput): Promise<CaptureActionResult>;
  /**
   * Same pipeline as {@link handleText}, but as an async iterable that emits
   * progress events. Only `ask_vault_question` produces per-token `delta`
   * events; other intents go classify → result directly.
   */
  streamText(input: CaptureTextInput): AsyncIterable<CaptureStreamEvent>;
}

/**
 * Hard upper bound on how much of an existing note we will read into the
 * context window for `ask_vault_question`. The full file is NEVER loaded
 * without explicit user confirmation; this cap keeps any incidental context
 * read strictly partial.
 */
const ASK_CONTEXT_HEAD_CHARS = 1500;

class CaptureServiceImpl implements CaptureService {
  private readonly vault = getVaultService();
  private readonly tasks = getTaskService();
  private readonly search = getSearchService();
  private readonly fileCandidates = getFileCandidateService();

  async ensureReady(): Promise<void> {
    await this.vault.ensureFolders();
  }

  async saveVoiceLog(input: CaptureVoiceInput): Promise<VoiceLogResult> {
    const stt = sttProviderFactory.get();
    const t = log.time("saveVoiceLog");
    log.debug("saveVoiceLog: start", {
      filename: input.filename,
      mimeType: input.mimeType,
      audioBytes: input.audio.length,
      language: input.language,
    });

    let result;
    try {
      result = await stt.transcribe({
        audio: input.audio,
        filename: input.filename,
        mimeType: input.mimeType,
        language: input.language,
      });
    } catch (err) {
      t.fail("saveVoiceLog: transcribe failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const persisted = await this.persistVoiceLog({
      transcript: result.text,
      provider: result.provider,
      model: result.model,
    });

    t.done("saveVoiceLog", {
      path: persisted.path,
      transcriptChars: result.text.length,
      empty: result.text.length === 0,
      provider: result.provider,
      model: result.model,
    });
    return persisted;
  }

  async saveVoiceLogFromTranscript(
    input: SaveVoiceLogFromTranscriptInput
  ): Promise<VoiceLogResult> {
    const t = log.time("saveVoiceLogFromTranscript");
    log.debug("saveVoiceLogFromTranscript: start", {
      transcriptChars: input.transcript.length,
      provider: input.provider,
      model: input.model,
    });
    const persisted = await this.persistVoiceLog(input);
    t.done("saveVoiceLogFromTranscript", {
      path: persisted.path,
      transcriptChars: input.transcript.length,
    });
    return persisted;
  }

  private async persistVoiceLog(args: {
    transcript: string;
    provider: string;
    model: string;
  }): Promise<VoiceLogResult> {
    await this.ensureReady();
    const stamp = compactLocalStamp();
    const created = await this.vault.createNote({
      folder: VAULT_FOLDERS.voiceLogs,
      title: `voice ${stamp}`,
      content: args.transcript || "_(empty transcription)_",
      metadata: {
        type: "voice-log",
        created: nowIso(),
        provider: args.provider,
        model: args.model,
        status: "raw",
      },
      uniqueOnConflict: true,
    });
    return {
      path: created.path,
      transcript: args.transcript,
      provider: args.provider,
      model: args.model,
    };
  }

  async handleText(input: CaptureTextInput): Promise<CaptureActionResult> {
    await this.ensureReady();
    const text = input.text.trim();
    if (!text) {
      log.warn("handleText: empty input");
      return {
        intent: "unknown",
        status: "error",
        message: "Empty input. Type something to capture.",
      };
    }

    const t = log.time("handleText");
    log.debug("handleText: start", {
      chars: text.length,
      source: input.voiceLogPath ? "voice" : "text",
    });

    const rawLogPath = await this.saveRawCaptureLog({
      text,
      source: input.voiceLogPath ? "voice" : "text",
      voiceLogPath: input.voiceLogPath,
    });

    let classification: IntentResult;
    const tCls = log.time("classifyIntent");
    try {
      classification = await llmProviderFactory.get().classifyIntent(text);
      tCls.done("classifyIntent", { intent: classification.intent });
    } catch (err) {
      tCls.fail("classifyIntent: threw, treating as unknown", {
        err: err instanceof Error ? err.message : String(err),
      });
      classification = {
        intent: "unknown",
        data: { reason: "classifier error" },
      };
    }

    const result = await this.execute(classification, text, {
      voiceLogPath: input.voiceLogPath,
    });
    t.done("handleText", {
      intent: result.intent,
      status: result.status,
      rawLogPath,
    });
    return { ...result, rawLogPath };
  }

  async *streamText(
    input: CaptureTextInput
  ): AsyncIterable<CaptureStreamEvent> {
    await this.ensureReady();
    const text = input.text.trim();
    if (!text) {
      log.warn("streamText: empty input");
      yield {
        type: "result",
        result: {
          intent: "unknown",
          status: "error",
          message: "Empty input. Type something to capture.",
        },
      };
      return;
    }

    const tWhole = log.time("streamText");
    log.debug("streamText: start", {
      chars: text.length,
      source: input.voiceLogPath ? "voice" : "text",
    });

    const rawLogPath = await this.saveRawCaptureLog({
      text,
      source: input.voiceLogPath ? "voice" : "text",
      voiceLogPath: input.voiceLogPath,
    });

    let classification: IntentResult;
    const tCls = log.time("classifyIntent");
    try {
      classification = await llmProviderFactory.get().classifyIntent(text);
      tCls.done("classifyIntent", { intent: classification.intent });
    } catch (err) {
      tCls.fail("classifyIntent: threw, treating as unknown", {
        err: err instanceof Error ? err.message : String(err),
      });
      classification = { intent: "unknown", data: { reason: "classifier error" } };
    }

    yield { type: "classified", intent: classification.intent };

    // Step 3: dispatch. Only `ask_vault_question` runs an LLM generation whose
    // output is long enough to stream; every other intent is a single action
    // we can just await and surface as a final `result` frame.
    if (classification.intent === "ask_vault_question") {
      const question = classification.data.question;
      const tAsk = log.time("askVaultQuestion(stream)");
      const hits = await this.search.search(question, { limit: 5 });

      const contextParts: string[] = [];
      for (const h of hits) {
        try {
          const note = await this.vault.readNote(h.path);
          const trimmed = note.body.slice(0, ASK_CONTEXT_HEAD_CHARS);
          contextParts.push(`--- ${h.path} ---\n${trimmed}`);
        } catch {
          // unreadable notes just don't contribute context
        }
      }
      const context = contextParts.join("\n\n") || "(no relevant notes found)";

      const llm = llmProviderFactory.get();
      let answer = "";
      let chunks = 0;
      for await (const frame of llm.streamMessage({
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
      })) {
        if (!frame.delta) continue;
        answer += frame.delta;
        chunks += 1;
        yield { type: "delta", text: frame.delta };
      }

      tAsk.done("askVaultQuestion(stream)", {
        sources: hits.length,
        chunks,
        answerChars: answer.length,
      });

      tWhole.done("streamText", {
        intent: "ask_vault_question",
        status: "ok",
        rawLogPath,
      });
      yield {
        type: "result",
        result: {
          intent: "ask_vault_question",
          status: "ok",
          message: answer.trim() || "(no answer)",
          details: {
            sources: hits.map((h) => ({ path: h.path, title: h.title })),
          },
          rawLogPath,
        },
      };
      return;
    }

    const result = await this.execute(classification, text, {
      voiceLogPath: input.voiceLogPath,
    });
    tWhole.done("streamText", {
      intent: result.intent,
      status: result.status,
      rawLogPath,
    });
    yield { type: "result", result: { ...result, rawLogPath } };
  }

  // ---- internals ----

  private async saveRawCaptureLog(args: {
    text: string;
    source: "text" | "voice";
    voiceLogPath?: string;
  }): Promise<string> {
    const stamp = compactLocalStamp();
    const created = await this.vault.createNote({
      folder: VAULT_FOLDERS.captureLogs,
      title: `capture ${stamp}`,
      content: args.text,
      metadata: {
        type: "capture-log",
        created: nowIso(),
        source: args.source,
        status: "raw",
        ...(args.voiceLogPath ? { voice_log: args.voiceLogPath } : {}),
      },
      uniqueOnConflict: true,
    });
    log.debug("saveRawCaptureLog", { path: created.path });
    return created.path;
  }

  private async execute(
    cls: IntentResult,
    originalText: string,
    ctx: { voiceLogPath?: string }
  ): Promise<CaptureActionResult> {
    switch (cls.intent) {
      case "note": {
        const body = cls.data.text.trim() || originalText;
        const title = (cls.data.title ?? deriveTitle(body)).trim() || "note";
        const filename = ensureMarkdownExt(`${todayLocalDate()} ${title}`);
        const created = await this.vault.createNote({
          folder: VAULT_FOLDERS.inbox,
          title: filename,
          content: buildNoteBody(body, ctx.voiceLogPath),
          metadata: {
            type: "note",
            created: nowIso(),
            source: ctx.voiceLogPath ? "voice" : "text",
            tags: cls.data.tags,
            ...(ctx.voiceLogPath ? { voice_log: ctx.voiceLogPath } : {}),
          },
          uniqueOnConflict: true,
        });
        log.info("note: saved", {
          path: created.path,
          title: sanitizeFilename(title),
          bodyChars: body.length,
          tags: cls.data.tags,
          source: ctx.voiceLogPath ? "voice" : "text",
        });
        return {
          intent: "note",
          status: "ok",
          message: `Saved note "${sanitizeFilename(title)}".`,
          details: { path: created.path },
        };
      }

      case "create_task": {
        const taskText = cls.data.taskText.trim();
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
        const needle = cls.data.taskText.trim();
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
        const query = cls.data.query.trim() || originalText;
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
        const answer = await this.answerVaultQuestion(cls.data.question);
        return {
          intent: "ask_vault_question",
          status: "ok",
          message: answer.answer,
          details: { sources: answer.sources },
        };
      }

      case "find_file": {
        const query = cls.data.query.trim();
        const matches = await this.vault.findFilesByName(query, { limit: 10 });
        if (matches.length === 0) {
          return {
            intent: "find_file",
            status: "not_found",
            message: `No files match "${query}".`,
            details: { query, matches: [] },
          };
        }
        return {
          intent: "find_file",
          status: "ok",
          message:
            `Found ${matches.length} file${matches.length === 1 ? "" : "s"} ` +
            `matching "${query}". File contents were NOT read.`,
          details: { query, matches },
        };
      }

      case "open_file_for_task": {
        const query = cls.data.query.trim();
        const task = cls.data.task.trim();

        // Steps 1-3 of the file-candidate workflow: filename search + LLM
        // ranking. NO file body has been read at this point.
        const result = await this.fileCandidates.findCandidates({
          query,
          task,
          limit: 5,
        });

        if (result.candidates.length === 0) {
          return {
            intent: "open_file_for_task",
            status: "not_found",
            message: `No files match "${query}". Nothing was opened.`,
            details: { query, task, candidates: [] },
          };
        }

        const best = result.bestGuess!; // candidates.length > 0 ⇒ bestGuess set
        const message =
          result.candidates.length === 1
            ? `Found "${best.title}". Confirm to open it for: "${task}". ` +
              `(File has not been read.)`
            : `Best match: "${best.title}" (of ${result.candidates.length}). ` +
              `Confirm to open it for: "${task}". (File has not been read.)`;

        return {
          intent: "open_file_for_task",
          status: "needs_confirmation",
          message,
          details: {
            query,
            task,
            candidates: result.candidates,
            bestGuess: best,
            requiresConfirmation: result.requiresConfirmation,
            reason: result.reason,
            // Hint to the UI: POST { path, task } here to actually read.
            confirmAction: {
              type: "read_for_task",
              endpoint: "/api/files/read-for-task",
              path: best.path,
              task,
            },
          },
        };
      }

      case "unknown":
      default: {
        const reason = cls.intent === "unknown" ? cls.data.reason : undefined;
        return {
          intent: "unknown",
          status: "error",
          message:
            (reason ? `Couldn't classify (${reason}). ` : "") +
            "Try things like: " +
            '"save a note about ...", "create task ...", "complete task ...", ' +
            '"search ...", "find file ...", or "open <file> to ...".',
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
        // PARTIAL read only. The full body is never sent to the LLM without
        // explicit confirmation; ASK_CONTEXT_HEAD_CHARS bounds incidental
        // context to the head of each matched file.
        const trimmed = note.body.slice(0, ASK_CONTEXT_HEAD_CHARS);
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

export function _resetCaptureServiceCache(): void {
  cached = null;
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

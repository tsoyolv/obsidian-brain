import type { ChatSession } from "@/lib/types";

/**
 * In-memory chat-session store.
 *
 * The MVP keeps sessions in process memory; markdown transcripts in the vault
 * remain the durable source of truth. This module is the single seam to
 * replace if you want SQLite/Redis persistence later — no service code needs
 * to change.
 */
export interface ChatSessionStore {
  put(session: ChatSession, systemPrompt: string): void;
  get(id: string): ChatSession | undefined;
  getSystemPrompt(id: string): string | undefined;
  all(): ChatSession[];
}

class InMemorySessionStore implements ChatSessionStore {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly prompts = new Map<string, string>();

  put(session: ChatSession, systemPrompt: string): void {
    this.sessions.set(session.id, session);
    this.prompts.set(session.id, systemPrompt);
  }

  get(id: string): ChatSession | undefined {
    return this.sessions.get(id);
  }

  getSystemPrompt(id: string): string | undefined {
    return this.prompts.get(id);
  }

  all(): ChatSession[] {
    return [...this.sessions.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }
}

let cached: ChatSessionStore | null = null;

export function getChatSessionStore(): ChatSessionStore {
  if (cached) return cached;
  cached = new InMemorySessionStore();
  return cached;
}

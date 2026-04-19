import type { ChatSession } from "@/lib/types";

/**
 * In-memory chat-session store.
 *
 * Markdown transcripts in the vault remain the durable source of truth; this
 * store is a hot cache. This module is the single seam to replace if you
 * want SQLite/Redis persistence later — no service code needs to change.
 *
 * The instance is cached on `globalThis` so it survives Next.js dev HMR
 * reloads (which otherwise reset module-level `let` bindings and drop every
 * active session, causing 404s on the next /api/chat/message call).
 */
export interface ChatSessionStore {
  put(session: ChatSession, systemPrompt: string): void;
  get(id: string): ChatSession | undefined;
  getSystemPrompt(id: string): string | undefined;
  all(): ChatSession[];
  /** True once the store has been seeded from the vault this process. */
  isHydrated(): boolean;
  markHydrated(): void;
}

class InMemorySessionStore implements ChatSessionStore {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly prompts = new Map<string, string>();
  private hydrated = false;

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

  isHydrated(): boolean {
    return this.hydrated;
  }

  markHydrated(): void {
    this.hydrated = true;
  }
}

const GLOBAL_KEY = "__obsidianBrainChatSessionStore";
type GlobalWithStore = typeof globalThis & {
  [GLOBAL_KEY]?: ChatSessionStore;
};

export function getChatSessionStore(): ChatSessionStore {
  const g = globalThis as GlobalWithStore;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY]!;
  const store = new InMemorySessionStore();
  g[GLOBAL_KEY] = store;
  return store;
}

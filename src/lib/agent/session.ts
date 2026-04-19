import type { AgentMessage, PendingConfirmation } from "./types";

/**
 * Maximum number of {@link AgentMessage} entries (user / assistant /
 * tool_call / tool_result) the session keeps as rolling history. Anything
 * older is trimmed on append.
 *
 * Keeping the cap small bounds the prompt cost AND keeps memory usage
 * predictable in the in-memory store. The orchestrator's per-turn tool-call
 * budget (4) plus a few prior turns easily fits in 10 entries.
 */
export const ROLLING_HISTORY_LIMIT = 10;

/**
 * Default time-to-live for a pending confirmation, in milliseconds. After
 * this elapses the orchestrator's pre-loop will discard the pending record
 * even if no new user turn has happened (e.g. the user walked away).
 */
export const PENDING_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/**
 * In-memory state for one agent conversation.
 *
 * Persistence is intentionally out of scope for this batch — the store is a
 * hot cache only. A future SQLite/Redis backend would replace this module
 * without touching the orchestrator or tools.
 */
export interface AgentSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Rolling chat history, capped at {@link ROLLING_HISTORY_LIMIT}. The
   * orchestrator replays this verbatim into the LLM prompt.
   */
  messages: AgentMessage[];
  /**
   * Single in-flight confirmation, if any. The orchestrator stashes the
   * validated tool args here when a tool's `needsConfirmation` predicate
   * fires; subsequent turns can match the user's "yes" / "the second one"
   * / "cancel" against the token, or the explicit confirm button can do so
   * via {@link confirmTurn}.
   *
   * Lifetime: cleared whenever a tool consumes it (via the session store's
   * `consumePendingConfirmation`), when it expires (TTL), or when the
   * pre-loop sees it has already survived one user turn unconsumed.
   */
  pendingConfirmation?: PendingConfirmation;
}

/**
 * Append-only session store. The orchestrator is the only writer; readers
 * (test harnesses, future API routes) get an immutable snapshot via {@link AgentSessionStore.get}.
 */
export interface AgentSessionStore {
  get(id: string): AgentSession | undefined;
  /** Get-or-create. Sessions are created with empty `messages`. */
  ensure(id: string): AgentSession;
  appendMessage(id: string, message: AgentMessage): AgentSession;
  /**
   * Wholesale replacement of the session's rolling history. Bypasses the
   * {@link ROLLING_HISTORY_LIMIT} trim that {@link appendMessage} enforces
   * because callers (chatService) are providing pre-bounded context drawn
   * from the chat's own rolling-summary window. Pending confirmation is
   * preserved as-is.
   */
  replaceMessages(id: string, messages: AgentMessage[]): AgentSession;
  setPendingConfirmation(
    id: string,
    pending: PendingConfirmation | undefined
  ): AgentSession;
  /**
   * Atomically verify a confirmation token + tool name against the
   * session's pending record and clear the record on success. Returns the
   * cleared {@link PendingConfirmation} on success, undefined on mismatch
   * or expiry.
   *
   * Tools call this from inside their `run` so a confirmation can never be
   * silently re-used: a successful consume removes the pending row before
   * the side-effect runs.
   */
  consumePendingConfirmation(
    id: string,
    token: string,
    toolName: string
  ): PendingConfirmation | undefined;
  /**
   * Mark the session's current pending confirmation as having seen one
   * user turn. The pre-loop calls this at the END of a turn that did NOT
   * consume the pending; the NEXT turn entry will then discard it.
   */
  markPendingStale(id: string): AgentSession;
  /** Snapshot of all sessions, newest-first. Intended for diagnostics. */
  all(): AgentSession[];
}

class InMemoryAgentSessionStore implements AgentSessionStore {
  private readonly sessions = new Map<string, AgentSession>();

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  ensure(id: string): AgentSession {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const created: AgentSession = {
      id,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.sessions.set(id, created);
    return created;
  }

  appendMessage(id: string, message: AgentMessage): AgentSession {
    const session = this.ensure(id);
    session.messages.push(message);
    // Trim oldest entries beyond the rolling cap. We trim from the front
    // (oldest first) so the most recent context is always preserved — the
    // LLM cares far more about the in-flight turn than ancient history.
    if (session.messages.length > ROLLING_HISTORY_LIMIT) {
      session.messages.splice(
        0,
        session.messages.length - ROLLING_HISTORY_LIMIT
      );
    }
    session.updatedAt = new Date().toISOString();
    return session;
  }

  replaceMessages(id: string, messages: AgentMessage[]): AgentSession {
    const session = this.ensure(id);
    session.messages = [...messages];
    session.updatedAt = new Date().toISOString();
    return session;
  }

  setPendingConfirmation(
    id: string,
    pending: PendingConfirmation | undefined
  ): AgentSession {
    const session = this.ensure(id);
    session.pendingConfirmation = pending;
    session.updatedAt = new Date().toISOString();
    return session;
  }

  consumePendingConfirmation(
    id: string,
    token: string,
    toolName: string
  ): PendingConfirmation | undefined {
    const session = this.sessions.get(id);
    const pending = session?.pendingConfirmation;
    if (!session || !pending) return undefined;
    if (pending.token !== token || pending.toolName !== toolName) {
      return undefined;
    }
    if (Date.parse(pending.expiresAt) < Date.now()) {
      // Expired — clear it as a side effect so callers don't keep seeing
      // a stale row.
      session.pendingConfirmation = undefined;
      session.updatedAt = new Date().toISOString();
      return undefined;
    }
    session.pendingConfirmation = undefined;
    session.updatedAt = new Date().toISOString();
    return pending;
  }

  markPendingStale(id: string): AgentSession {
    const session = this.ensure(id);
    if (session.pendingConfirmation) {
      session.pendingConfirmation = {
        ...session.pendingConfirmation,
        staleAfterTurn: true,
      };
      session.updatedAt = new Date().toISOString();
    }
    return session;
  }

  all(): AgentSession[] {
    return [...this.sessions.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }
}

// Cached on globalThis so the store survives Next.js HMR reloads in dev —
// same trick used by `chat/sessionStore.ts`. Without this, every code edit
// would drop in-flight agent conversations and confirmations.
const GLOBAL_KEY = "__obsidianBrainAgentSessionStore";
type GlobalWithStore = typeof globalThis & {
  [GLOBAL_KEY]?: AgentSessionStore;
};

export function getAgentSessionStore(): AgentSessionStore {
  const g = globalThis as GlobalWithStore;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY]!;
  const store = new InMemoryAgentSessionStore();
  g[GLOBAL_KEY] = store;
  return store;
}

export function _resetAgentSessionStore(): void {
  const g = globalThis as GlobalWithStore;
  delete g[GLOBAL_KEY];
}

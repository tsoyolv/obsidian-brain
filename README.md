# Obsidian Brain

A local-first AI assistant integrated with your Obsidian vault.

It runs as a tiny Next.js web app on your machine. The whole UI is a
single chat surface: text or voice input on the right, your past chat
sessions on the left. Every reply streams into a markdown transcript in
your vault, and the assistant can call a small set of vault tools to
search, save, edit, complete tasks, etc.

> The LLM never has direct filesystem access. All vault mutations go
> through a small set of explicit business actions (create note, append
> note, search notes, create task, complete task, summarize chat).

---

## Features

- **One unified chat surface**
  - type or record voice; voice is transcribed locally into the input box
    so you can edit before sending
  - sessions sidebar on the left, freshest chat opens automatically
  - streaming assistant responses (SSE)
  - every message persisted to a markdown transcript in `AI Chats/`
  - one-click summary + action items stored inline in the chat's own
    transcript (frontmatter on disk, pinned card at the top of the chat
    in the UI) — no separate summary file is created
- **Agent-by-default**
  - new chats have the agent enabled out of the box; the assistant can
    call vault tools (search, save note, create / complete task, find
    file, open file with confirmation, soft-delete with confirmation)
  - uncheck the `agent` toggle in the chat header to fall back to a plain
    chat without tool access
  - dangerous tools (read-confirmed-file, run-file-task, soft-delete)
    always require an explicit user confirm in the UI
- **Provider-agnostic core**
  - `LLMProvider` and `STTProvider` interfaces with OpenAI implementations
  - drop-in adapters for Anthropic, DeepSeek, local Whisper / Parakeet, etc.
  - provider/model selection via environment variables

---

## Tech stack

- Next.js 14 (App Router) + TypeScript
- Tailwind CSS
- `openai` SDK (chat + Whisper)
- `gray-matter` for YAML frontmatter
- `zod` for runtime validation
- Node.js runtime route handlers (filesystem access)
- No database — markdown files are the source of truth; chat sessions are
  in-memory while the dev server runs

---

## Vault layout

When the app starts (or first acts on a request), it ensures the following
folders exist inside your `OBSIDIAN_VAULT_PATH`:

```
<vault>/
├── Inbox/          # Notes saved by the assistant via `save_note`
├── AI Chats/       # Full chat transcripts, one file per session
│                   # Optional summary + action items live inline in
│                   # each chat's YAML frontmatter (chat_summary,
│                   # chat_summary_action_items) — no separate folder.
└── Tasks/          # Task files (Inbox.md by default; daily / project files allowed)
```

All files use YAML frontmatter where appropriate so they remain searchable in
Obsidian.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy the example env file and fill in your values:

```bash
cp .env.local.example .env.local
```

Required variables:

| Variable               | Description                                              |
| ---------------------- | -------------------------------------------------------- |
| `OBSIDIAN_VAULT_PATH`  | Absolute path to your Obsidian vault on disk.            |
| `LLM_PROVIDER`         | `openai` (only provider in MVP).                         |
| `STT_PROVIDER`         | `openai` (only provider in MVP).                         |
| `OPENAI_API_KEY`       | Your OpenAI API key.                                     |
| `OPENAI_MODEL_CHAT`    | Chat/completions model (e.g. `gpt-4o-mini`).             |
| `OPENAI_MODEL_CHAT_FAST` | Fast/cheap model for simple turns.                     |
| `OPENAI_MODEL_CHAT_STANDARD` | Default model for normal turns.                   |
| `OPENAI_MODEL_CHAT_REASONING` | Strong model for complex/high-risk turns.        |
| `OPENAI_MODEL_ROUTER`  | Router model for first-turn title + complexity triage.   |
| `MODEL_ROUTING_ENABLED` | Enables model routing (`true`/`false`).                |
| `MODEL_DYNAMIC_ESCALATION_ENABLED` | Escalates model on failure/complexity signals. |
| `MODEL_ROUTING_STICKY_TURNS` | How many turns to keep a chosen model.           |
| `MODEL_ROUTING_HIGH_PROMPT_TOKENS` | Prompt-size threshold for reasoning tier.  |
| `WEB_SEARCH_PROVIDER`  | Web search provider id (`tavily`).                       |
| `TAVILY_API_KEY`       | API key for Tavily web search tool.                      |
| `OPENAI_MODEL_STT`     | Whisper model id (e.g. `whisper-1`).                     |

### 3. Run the dev server

```bash
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

### 4. Build for local production use

```bash
npm run build && npm run start
```

---

## Usage

When you open the app, the most recently updated chat opens automatically.
Click **+ New chat** in the left sidebar to start a fresh one.

Type or record. Examples that exercise the agent's tools:

- `save a note about today's planning meeting`
- `create task buy milk tomorrow`
- `complete task buy milk`
- `search project alpha`
- `what did I write about Postgres replication?`
- `find file shopping list`
- `open my reading list and add Dune`
- `check Timeweb status right now and share sources`

For voice, click **To text** to put the transcript into the input box for
editing, or **Send** to record → transcribe → submit in one step.

The assistant streams its reply into the chat. When the agent is enabled
(default), it may chain multiple tool calls per turn; you'll see each call
as a chip with a collapsible result. Reading or deleting a file always
asks for explicit confirmation — file bodies are never loaded without
your approval.

Click **Summarize** in the chat header to generate a markdown summary +
action items. The result is stored inline in the chat's own transcript
(under `chat_summary`/`chat_summary_action_items` in the frontmatter)
and rendered as a pinned card at the top of the chat, so it survives
page reloads and is visible both in the app and when opening the `.md`
file in Obsidian.

> Sessions are kept in memory for the dev server's lifetime. Markdown
> transcripts in `AI Chats/` are the durable record; on restart, the
> session list is rebuilt by scanning that folder.

### Safety rules baked into the agent loop

- **Never deletes files.** The vault module exposes no unlink API; the
  only destructive operation is `softDelete`, which moves files into
  `Deleted/` — and even that requires a user confirmation.
- **Never reads a full file without confirmation.**
  - `find_file` walks the vault but only inspects file _names_; bodies
    are never opened.
  - `propose_open_file` / `read_confirmed_file` surface the matched file
    path and stop with `needs_confirmation`. The body is read only after
    the user clicks Confirm.
  - `answer_from_vault` reads at most the first ~1500 characters of each
    of the top-N keyword-matched notes — bounded partial reads only.

---

## API

| Method | Path                                | Description                                          |
| ------ | ----------------------------------- | ---------------------------------------------------- |
| POST   | `/api/capture/transcribe`           | Audio → text (no vault writes; used by chat input)   |
| GET    | `/api/search?q=...`                 | Keyword search across vault markdown                 |
| POST   | `/api/chat/sessions`                | Create a chat session                                |
| GET    | `/api/chat/sessions`                | List sessions (rebuilt from `AI Chats/` on restart)  |
| GET    | `/api/chat/sessions/:id`            | Full session incl. messages                          |
| PATCH  | `/api/chat/sessions/:id`            | Toggle `agentEnabled` for a session                  |
| POST   | `/api/chat/message`                 | Send user message; SSE-streamed reply                |
| POST   | `/api/chat/confirm`                 | Confirm a pending agent tool call                    |
| POST   | `/api/chat/cancel`                  | Cancel a pending agent tool call                     |
| POST   | `/api/chat/summarize`               | Generate a chat summary; stored inline in the chat   |
| GET    | `/api/config/runtime`               | Sanitized runtime config (no secrets)                |

All non-streaming endpoints return:

```json
{ "ok": true, "data": ... }
```

or

```json
{ "ok": false, "error": { "message": "...", "details": ... } }
```

The streaming endpoint emits SSE frames:

```
data: {"delta":"text fragment","done":false,"messageId":"msg_..."}

data: {"delta":"","done":true,"messageId":"msg_..."}

event: end
data: {}
```

---

## Architecture

```
src/
├── app/                    # Next.js App Router
│   ├── api/                # Thin HTTP controllers
│   ├── layout.tsx
│   ├── page.tsx
│   └── globals.css
├── components/             # React UI (Tailwind)
│   ├── AppShell.tsx
│   ├── ChatPanel.tsx
│   ├── ChatSessionList.tsx
│   ├── AgentTimeline.tsx
│   ├── MessageBubble.tsx
│   ├── MicButton.tsx
│   ├── ActionResultCard.tsx
│   ├── Spinner.tsx
│   └── TranscriptionCard.tsx
└── lib/
    ├── agent/              # Tool registry + orchestrator + agent session
    │   └── tools/          # One file per tool (save_note, search_vault, …)
    ├── api/                # API helpers (responses, error formatting)
    ├── config/             # Typed env config
    ├── markdown/           # Frontmatter + helper renderers
    ├── providers/
    │   ├── llm/            # LLMProvider interface + OpenAI impl + factory
    │   └── stt/            # STTProvider interface + OpenAI impl + factory
    ├── services/
    │   ├── vault/          # All filesystem mutations (sole `node:fs` site)
    │   ├── task/           # Markdown task CRUD + fuzzy completion
    │   ├── search/         # Keyword + heading search
    │   ├── chat/           # Sessions, transcripts, rolling-summary compaction
    │   ├── fileCandidate/  # File-pick candidates (open-file flow)
    │   └── fileTask/       # Confirmation-gated file edits
    ├── types/              # Shared domain types
    └── utils/              # path safety, filenames, ids, logger, tokens
```

### Adding a new LLM provider

1. Implement the `LLMProvider` interface in
   `src/lib/providers/llm/<your-provider>.ts`.
2. Add the provider id to `LLMProviderSchema` in `src/lib/config/index.ts`.
3. Extend the switch in `src/lib/providers/llm/factory.ts` to construct it.
4. No business code needs to change.

The same pattern applies to `STTProvider`.

### Safety model

- The LLM only ever sees text and emits a structured tool call. It cannot
  touch the disk directly.
- The orchestrator maps each tool name to one of a fixed set of business
  actions (registered in `src/lib/agent/tools/`). Each action goes
  through `vaultService` / `taskService` / `searchService` / `chatService`.
- Confirmation-gated tools (`read_confirmed_file`, `run_file_task`,
  `soft_delete`) yield a `needs_confirmation` event and STOP. They run
  only after the user clicks Confirm in the UI.
- All filesystem paths are resolved through `safePathResolve`, which
  rejects any path that escapes the vault root.
- Filenames are sanitized to remove path separators, control characters
  and characters illegal on Windows/macOS.
- Voice uploads are capped at 25 MB.

#### Filesystem-level safety enforcement

The vault layer enforces three structural invariants — no business action
can violate them, even by accident:

1. **No delete, ever.** `node:fs` is imported in exactly one file
   (`src/lib/services/vault/internal/fsAdapter.ts`). That file exposes a
   frozen whitelist of allowed primitives (`access`, `readFile`,
   `writeFile`, `appendFile`, `mkdir`, `rename`, `readdir`) and runs a
   module-load assertion that crashes the process if any name matching
   `unlink | rm | rmdir | remove | delete | truncate | cp` ever leaks into
   the whitelist via a refactor. `unlink`/`rm`/`rmdir` are simply
   unreachable from the rest of the codebase.

2. **Soft delete is the only destructive operation.** The strongest
   mutation `vaultService` exposes is `softDelete(relPath)`, which performs
   an atomic `rename` into `Deleted/<original-relative-path>`. Files leave
   `Inbox/`, `Tasks/`, etc. and reappear under `Deleted/` with their
   folder structure preserved; the disk bytes are never freed by the app.
   `moveFile` cannot land files in `Deleted/` — that path is reserved for
   `softDelete`.

3. **Writable-folder allowlist.** Every mutating call (`createNote`,
   `ensureNoteExists`, `appendToNote`, `writeRawNote`, `replaceLine`,
   `updateFrontmatter`, `moveFile`, `softDelete`) checks the target's
   top-level segment against `WRITABLE_FOLDERS`:
   `Inbox`, `AI Chats`, `Tasks`. Writes to the vault
   root, to `Deleted/`, to `.obsidian/`, or to any other arbitrary
   folder are rejected with a loud error before any I/O happens.

---

## Notes / limitations (MVP)

- Chat sessions live only in the dev-server memory. The transcripts on disk
  are the durable record. Restarting the server clears the session list.
- Search is a simple token/substring scorer over markdown files. Good enough
  for hundreds of notes; swap for a real index if you need more.
- "Ask vault question" feeds the top-N matched notes into the LLM as context;
  there is no embeddings/RAG pipeline in MVP.
- The app intentionally does not auto-delete tasks. `complete_task` only
  toggles the checkbox.

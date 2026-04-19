# Obsidian Brain

A local-first AI assistant integrated with your Obsidian vault.

It runs as a tiny Next.js web app on your machine, captures text and voice
input, classifies intent with an LLM, and writes everything as plain markdown
into your vault. Long-form chat sessions stream into the same vault as
transcripts and optional summaries.

> The LLM never has direct filesystem access. All vault mutations go through
> a small set of explicit business actions (create note, append note, search
> notes, create task, complete task, summarize chat).

---

## Features

- **Capture tab** – chat-style quick input
  - typed text or recorded voice
  - intents: save note, create task, complete task, search notes,
    ask vault question
  - voice is transcribed and the raw transcript is saved immediately
- **Chat tab** – long-form AI conversations
  - multiple in-memory sessions
  - streaming assistant responses (SSE)
  - every message persisted to a markdown transcript in the vault
  - one-click summary + action items written to a separate markdown file
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
├── Inbox/          # Saved notes from the Capture tab
├── Voice Logs/     # Raw STT transcripts (one per recording)
├── AI Chats/       # Full chat transcripts, one file per session
├── AI Summaries/   # Optional summary + action items per chat
└── Tasks/          # Daily task files (e.g. 2026-04-19.md)
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

### Capture tab

Type something like:

- `save a note about today's planning meeting`
- `create task buy milk tomorrow`
- `complete task buy milk`
- `search project alpha`
- `what did I write about Postgres replication?`

Or click **Record**, speak, and click **Stop**. The recording is sent to
the configured STT provider, the raw transcript is saved under
`Voice Logs/`, and the transcript is then routed through the same intent
classifier as typed text.

Each capture shows an explicit action result:

- `Saved note "..."` (with the resulting vault path)
- `Created task: "..."`
- `Completed task: "..."`
- `Found N matching notes` (with snippets)
- `Need clarification: ...` when a task lookup is ambiguous

### Chat tab

- Click **New chat** to start a session. A markdown transcript is created
  immediately under `AI Chats/`.
- Type and send a message; the assistant response streams into the UI and
  is appended to the transcript when complete.
- Click **Summarize** to generate a markdown summary + action items file
  under `AI Summaries/`, linked back to the source chat.

> Sessions are kept in memory for the dev server's lifetime. Markdown
> transcripts are durable.

---

## API

| Method | Path                       | Description                              |
| ------ | -------------------------- | ---------------------------------------- |
| POST   | `/api/capture/text`        | Classify + execute a typed capture       |
| POST   | `/api/capture/voice`       | Transcribe audio and save raw voice log  |
| GET    | `/api/search?q=...`        | Keyword search across vault markdown     |
| POST   | `/api/chat/sessions`       | Create a chat session                    |
| GET    | `/api/chat/sessions`       | List in-memory sessions                  |
| POST   | `/api/chat/message`        | Send user message; SSE-streamed reply    |
| POST   | `/api/chat/summarize`      | Save a summary + action items markdown   |
| GET    | `/api/config/runtime`      | Sanitized runtime config (no secrets)    |

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
│   ├── TabSwitcher.tsx
│   ├── CapturePanel.tsx
│   ├── ChatPanel.tsx
│   ├── ChatSessionList.tsx
│   ├── MessageBubble.tsx
│   ├── MicButton.tsx
│   └── ActionResultCard.tsx
└── lib/
    ├── api/                # API helpers (responses, error formatting)
    ├── config/             # Typed env config
    ├── markdown/           # Frontmatter + helper renderers
    ├── providers/
    │   ├── llm/            # LLMProvider interface + OpenAI impl + factory
    │   └── stt/            # STTProvider interface + OpenAI impl + factory
    ├── services/
    │   ├── vaultService.ts # All filesystem mutations
    │   ├── taskService.ts  # Markdown task CRUD + fuzzy completion
    │   ├── searchService.ts
    │   ├── captureService.ts
    │   └── chatService.ts
    ├── types/              # Shared domain types
    └── utils/              # path safety, filenames, ids, logger
```

### Adding a new LLM provider

1. Implement the `LLMProvider` interface in
   `src/lib/providers/llm/<your-provider>.ts`.
2. Add the provider id to `LLMProviderSchema` in `src/lib/config/index.ts`.
3. Extend the switch in `src/lib/providers/llm/factory.ts` to construct it.
4. No business code needs to change.

The same pattern applies to `STTProvider`.

### Safety model

- The LLM only ever sees text. It cannot call functions or touch the disk.
- The capture service translates LLM output into one of a fixed set of
  business actions:
  - `vaultService.createNote`
  - `vaultService.appendToNote`
  - `taskService.createTask`
  - `taskService.completeTask`
  - `searchService.search`
  - `chatService.summarize`
- All filesystem paths are resolved through `safePathResolve`, which rejects
  any path that escapes the vault root.
- Filenames are sanitized to remove path separators, control characters and
  characters illegal on Windows/macOS.
- Voice uploads are capped at 25 MB.

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

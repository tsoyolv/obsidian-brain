"use client";

interface Props {
  path: string;
  transcript: string;
  provider: string;
  model: string;
}

/**
 * Read-only display for a saved raw voice log: provider/model badges,
 * vault-relative path of the persisted markdown, and the transcript.
 */
export function TranscriptionCard({ path, transcript, provider, model }: Props) {
  const isEmpty = transcript.trim().length === 0;
  return (
    <div className="card border-bg-border space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="pill">Voice log</span>
        <span className="pill">{provider}</span>
        <span className="pill">{model}</span>
        <span className="pill border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
          saved
        </span>
      </div>
      <div className="font-mono text-[11px] text-ink-dim break-all">{path}</div>
      <div
        className={
          "whitespace-pre-wrap text-sm leading-relaxed " +
          (isEmpty ? "italic text-ink-dim" : "text-ink")
        }
      >
        {isEmpty ? "(empty transcription)" : transcript}
      </div>
    </div>
  );
}

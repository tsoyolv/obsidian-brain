"use client";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-10 text-sm text-ink-muted">
      <h2 className="text-base font-semibold text-ink">Something went wrong</h2>
      <p className="mt-2 break-words text-ink-dim">{error.message}</p>
      <button type="button" className="btn mt-4" onClick={() => reset()}>
        Retry
      </button>
    </div>
  );
}

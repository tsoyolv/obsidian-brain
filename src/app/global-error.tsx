"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-bg text-ink">
        <main className="mx-auto max-w-2xl px-6 py-10 text-sm text-ink-muted">
          <h2 className="text-base font-semibold text-ink">Application error</h2>
          <p className="mt-2 break-words text-ink-dim">{error.message}</p>
          <button type="button" className="btn mt-4" onClick={() => reset()}>
            Retry
          </button>
        </main>
      </body>
    </html>
  );
}

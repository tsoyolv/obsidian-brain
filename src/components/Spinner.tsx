"use client";

interface Props {
  size?: number;
  className?: string;
  label?: string;
}

/**
 * Tiny SVG spinner used for inline loading states (buttons, headers, banners).
 * Renders an aria-label so screen readers announce the busy state.
 */
export function Spinner({ size = 14, className, label = "Loading" }: Props) {
  return (
    <svg
      role="status"
      aria-label={label}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={"animate-spin " + (className ?? "")}
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0.25"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Three small bouncing dots, used as a "thinking" indicator inside chat
 * bubbles before the first streaming token arrives.
 */
export function ThinkingDots({ className }: { className?: string }) {
  return (
    <span
      className={"inline-flex items-center gap-1 " + (className ?? "")}
      aria-label="Thinking"
      role="status"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70 [animation:pulse_1.2s_ease-in-out_infinite]" />
      <span
        className="h-1.5 w-1.5 rounded-full bg-current opacity-70 [animation:pulse_1.2s_ease-in-out_infinite]"
        style={{ animationDelay: "0.15s" }}
      />
      <span
        className="h-1.5 w-1.5 rounded-full bg-current opacity-70 [animation:pulse_1.2s_ease-in-out_infinite]"
        style={{ animationDelay: "0.3s" }}
      />
    </span>
  );
}

/**
 * Generic shimmering skeleton lines for placeholder content while data loads.
 * `lines` controls how many bars to render; widths cycle for visual variety.
 */
export function SkeletonLines({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  const widths = ["w-11/12", "w-9/12", "w-10/12", "w-8/12", "w-7/12"];
  return (
    <div className={"space-y-2 " + (className ?? "")} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className={
            "h-3 rounded bg-bg-elevated/80 animate-pulse " +
            widths[i % widths.length]
          }
        />
      ))}
    </div>
  );
}

/**
 * Inline error banner with a dismiss button.
 * Use for transient, recoverable errors that should not block the UI.
 */
export function ErrorBanner({
  message,
  onDismiss,
  className,
}: {
  message: string;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={
        "flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200 " +
        (className ?? "")
      }
    >
      <span aria-hidden="true" className="mt-0.5">
        ⚠
      </span>
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="ml-2 rounded px-1 text-red-200/80 hover:bg-red-500/20 hover:text-red-100"
          aria-label="Dismiss"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

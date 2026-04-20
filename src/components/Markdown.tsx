"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

/**
 * Shared markdown renderer for chat bubbles.
 *
 * We deliberately DON'T pull in `@tailwindcss/typography` — it's too
 * heavy for the handful of element types that show up in assistant
 * replies, and overrides our carefully tuned dark palette. Instead each
 * block-level element gets a small, explicit Tailwind class that lines
 * up with the surrounding bubble (no stray top-margins on the first
 * block, no giant gaps between list items, code blocks that still fit
 * the narrow 85%-width bubbles).
 *
 * `remark-gfm` adds GitHub-flavoured extras: tables, task lists,
 * strikethrough, autolinks. We intentionally leave `rehype-raw` OFF so
 * model-supplied HTML is escaped — the chat renders user + model text,
 * both of which we treat as untrusted.
 */
export function Markdown({
  text,
  tone = "default",
}: {
  text: string;
  /**
   * `invert` flips muted / accent colors for use on the user-bubble
   * (which has a solid accent background). Default tone is tuned for
   * the elevated-panel assistant bubbles.
   */
  tone?: "default" | "invert";
}) {
  const components = tone === "invert" ? INVERT_COMPONENTS : DEFAULT_COMPONENTS;
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
}

const baseParagraph = "mb-2 last:mb-0 leading-relaxed";
const baseHeading = "mb-2 mt-3 first:mt-0 font-semibold";

const DEFAULT_COMPONENTS: Components = {
  p: ({ children }) => <p className={baseParagraph}>{children}</p>,
  h1: ({ children }) => (
    <h1 className={`${baseHeading} text-lg`}>{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className={`${baseHeading} text-base`}>{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className={`${baseHeading} text-sm`}>{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className={`${baseHeading} text-sm`}>{children}</h4>
  ),
  ul: ({ children }) => (
    <ul className="mb-2 last:mb-0 list-disc space-y-0.5 pl-5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 last:mb-0 list-decimal space-y-0.5 pl-5">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-bg-border pl-3 text-ink-muted">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-bg-border" />,
  code: ({ className, children, ...props }) => {
    const inline = !className;
    if (inline) {
      return (
        <code
          className="rounded bg-bg px-1 py-0.5 font-mono text-[0.85em] text-ink"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={`${className ?? ""} font-mono text-[0.85em]`} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-2 last:mb-0 overflow-x-auto rounded-md border border-bg-border bg-bg p-2 text-xs">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="mb-2 last:mb-0 overflow-x-auto">
      <table className="min-w-full border-collapse text-left text-xs">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-bg-border text-ink-muted">
      {children}
    </thead>
  ),
  th: ({ children }) => (
    <th className="px-2 py-1 font-semibold">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-t border-bg-border/60 px-2 py-1 align-top">
      {children}
    </td>
  ),
  input: ({ type, checked, disabled }) => {
    if (type === "checkbox") {
      return (
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          readOnly
          className="mr-1 align-middle accent-accent"
        />
      );
    }
    return null;
  },
  strong: ({ children }) => (
    <strong className="font-semibold text-ink">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => (
    <del className="text-ink-muted line-through">{children}</del>
  ),
};

/**
 * Tuned for the solid-accent user bubble: links stay white, code chips
 * get a translucent dark backdrop so they remain legible on the purple
 * background.
 */
const INVERT_COMPONENTS: Components = {
  ...DEFAULT_COMPONENTS,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="underline decoration-white/60 underline-offset-2 hover:decoration-white"
    >
      {children}
    </a>
  ),
  code: ({ className, children, ...props }) => {
    const inline = !className;
    if (inline) {
      return (
        <code
          className="rounded bg-black/25 px-1 py-0.5 font-mono text-[0.85em]"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={`${className ?? ""} font-mono text-[0.85em]`} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-2 last:mb-0 overflow-x-auto rounded-md bg-black/25 p-2 text-xs">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-white/40 pl-3 text-white/80">
      {children}
    </blockquote>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
};

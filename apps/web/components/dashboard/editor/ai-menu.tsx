"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icons } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MICRO_ACTIONS, type MicroAction } from "@/lib/ai/micro";

// ---------------------------------------------------------------------------
// The small pieces every AI action in the editor is built from
// ---------------------------------------------------------------------------
//
// One menu of six actions, one card that shows old beside new with Accept and
// Discard. Used by the title, the meta description, a text selection and
// each image, so they all behave the same way: nothing is written when the
// menu is used, only when the card is accepted, and only Save persists it.

/** Close on outside click or Escape. */
export function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return ref;
}

export type MenuItem = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
};

/** A button that opens a list. No dependency: the repo has no shadcn. */
export function DropMenu({
  label,
  icon,
  items,
  align = "left",
  size = "sm",
  variant = "default",
  disabled,
  className,
}: {
  label: React.ReactNode;
  icon?: React.ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
  size?: "sm" | "md";
  variant?: "default" | "ghost";
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  return (
    <div ref={ref} className={cn("relative inline-flex", className)}>
      <Button size={size} variant={variant} onClick={() => setOpen((o) => !o)} disabled={disabled} aria-haspopup="menu" aria-expanded={open}>
        {icon}
        {label}
        <Icons.caretDown size={11} />
      </Button>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute top-full mt-1 z-20 min-w-[200px] rounded-[8px] border border-line bg-bg p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                close();
                item.onSelect();
              }}
              className="flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 hover:bg-panel-2 hover:text-ink disabled:opacity-40 disabled:pointer-events-none"
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Improve · Shorten · Expand · Simplify · Fix grammar · Ask AI. Picking "Ask
 * AI" opens a one-line prompt in place; Enter sends it.
 */
export function AiActionMenu({
  onAction,
  busy,
  disabled,
  compact,
  align = "left",
  className,
}: {
  onAction: (action: MicroAction, prompt?: string) => void;
  busy?: boolean;
  disabled?: boolean;
  /** Icon-only trigger for tight spots like the selection bar. */
  compact?: boolean;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [prompt, setPrompt] = useState("");
  const close = useCallback(() => {
    setOpen(false);
    setAsking(false);
  }, []);
  const ref = useDismiss(open, close);

  const send = () => {
    if (!prompt.trim()) return;
    onAction("ask", prompt.trim());
    setPrompt("");
    close();
  };

  return (
    <div ref={ref} className={cn("relative inline-flex", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="AI actions"
        className={cn(
          "inline-flex items-center gap-1 rounded-[6px] border border-transparent text-accent-ink hover:bg-accent-soft disabled:opacity-40 disabled:pointer-events-none",
          compact ? "h-7 w-7 justify-center" : "px-2 py-1 text-[12px] font-medium",
        )}
      >
        <Icons.sparkle size={13} className={busy ? "animate-pulse" : undefined} />
        {!compact && (busy ? "Working…" : "AI")}
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute top-full mt-1 z-30 w-[220px] rounded-[8px] border border-line bg-bg p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {!asking &&
            MICRO_ACTIONS.map((a) => (
              <button
                key={a.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  if (a.id === "ask") {
                    setAsking(true);
                    return;
                  }
                  close();
                  onAction(a.id);
                }}
                className="flex w-full items-center justify-between rounded-[6px] px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 hover:bg-panel-2 hover:text-ink"
              >
                {a.label}
                {a.id === "ask" && <Icons.arrow size={11} className="text-ink-4" />}
              </button>
            ))}
          {asking && (
            <div className="p-1.5">
              <input
                autoFocus
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="What should change?"
                aria-label="Instruction for the AI"
                className="w-full rounded-[6px] border border-line bg-bg px-2 py-1.5 text-[12.5px] focus:outline-0 focus:border-accent"
              />
              <div className="mt-1.5 flex justify-end gap-1">
                <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
                  Back
                </Button>
                <Button size="sm" variant="accent" onClick={send} disabled={!prompt.trim()}>
                  Send
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Old beside new. `renderValue` lets the selection card show HTML and the
 * image card show pictures; the fields pass nothing and get text.
 */
export function ProposalCard({
  before,
  after,
  onAccept,
  onDiscard,
  acceptLabel = "Accept",
  renderValue,
  className,
  children,
}: {
  before: string;
  after: string;
  onAccept: () => void;
  onDiscard: () => void;
  acceptLabel?: string;
  renderValue?: (value: string, which: "before" | "after") => React.ReactNode;
  className?: string;
  /** Anything extra under the comparison: a change list, a counter. */
  children?: React.ReactNode;
}) {
  const show = (v: string, which: "before" | "after") =>
    renderValue ? renderValue(v, which) : <span className="whitespace-pre-wrap break-words">{v || <em className="text-ink-4">empty</em>}</span>;
  return (
    <div className={cn("rounded-[8px] border border-accent-soft bg-accent-soft/40 p-2.5", className)}>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-[6px] bg-bg/70 p-2 text-[12.5px] text-ink-3 line-through decoration-ink-4">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-4 no-underline">Current</div>
          {show(before, "before")}
        </div>
        <div className="rounded-[6px] bg-bg p-2 text-[12.5px] text-ink">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-accent-ink">Proposed</div>
          {show(after, "after")}
        </div>
      </div>
      {children}
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onDiscard}>
          Discard
        </Button>
        <Button size="sm" variant="accent" onClick={onAccept}>
          <Icons.check size={12} />
          {acceptLabel}
        </Button>
      </div>
    </div>
  );
}

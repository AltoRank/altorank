"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { Icons } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { applyHunks } from "@/lib/editor/proposals";
import { HtmlPreview } from "./html-preview";

// ---------------------------------------------------------------------------
// "Rewrite this article": the chat panel on the left
// ---------------------------------------------------------------------------
//
// One instruction in, the whole article back as a proposal. The stream shows
// the plan line and then progress as text arrives; when it completes the
// panel offers "Replace article" and "Discard" with the model's own
// three-line account of what changed. Nothing is written: Replace hands the
// HTML to the editor through `applyHunks` (the hook for hunk-level
// Keep/Reject, see lib/editor/proposals.ts), and Save is still the only
// commit.

export const REWRITE_CHIPS = [
  "Make the intro punchier and more engaging",
  "Rewrite in a more professional, expert tone",
  "Expand each section with more depth and examples",
  "Tighten the whole article and cut fluff",
] as const;

type Phase = "idle" | "planning" | "writing" | "done";

export function RewritePanel({
  articleId,
  getHtml,
  onReplace,
  className,
}: {
  articleId: string;
  /** The document as it stands; read at send time, not render time. */
  getHtml: () => string;
  /** The editor swaps the body for this HTML (staged, not saved). */
  onReplace: (html: string) => void;
  className?: string;
}) {
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<string | null>(null);
  const [streamedWords, setStreamedWords] = useState(0);
  const [proposal, setProposal] = useState<{ html: string; changes: string[]; instruction: string } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (instruction: string) => {
      const text = instruction.trim();
      if (!text) return;
      const html = getHtml();
      if (!html.replace(/<[^>]+>/g, "").trim()) {
        toast.info("There is no article to rewrite yet.");
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setProposal(null);
      setStreamedWords(0);
      setPlan(null);
      setShowPreview(false);
      setPhase("planning");
      setPrompt("");

      try {
        const res = await fetch("/api/editor/rewrite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ articleId, html, instruction: text }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "Rewrite failed");
        }
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No stream");
        const decoder = new TextDecoder();
        let buffer = "";
        let acc = "";
        let finished = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let data: { type: string; text?: string; html?: string; changes?: string[]; error?: string };
            try {
              data = JSON.parse(line.slice(6));
            } catch {
              continue;
            }
            if (data.type === "plan") {
              setPlan(data.text ?? null);
            } else if (data.type === "chunk") {
              setPhase("writing");
              acc += data.text ?? "";
              setStreamedWords(acc.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length);
            } else if (data.type === "complete") {
              setProposal({ html: data.html ?? "", changes: data.changes ?? [], instruction: text });
              setPhase("done");
              finished = true;
            } else if (data.type === "error") {
              throw new Error(data.error ?? "Rewrite failed");
            }
          }
        }
        if (!finished) setPhase("idle");
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setPhase("idle");
          return;
        }
        toast.error(err instanceof Error ? err.message : "Rewrite failed");
        setPhase("idle");
      }
    },
    [articleId, getHtml],
  );

  const busy = phase === "planning" || phase === "writing";

  return (
    <aside className={cn("flex min-h-0 flex-col bg-panel", className)}>
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-center gap-1.5 text-[13px] font-semibold">
          <Icons.sparkle size={13} className="text-accent-ink" />
          Rewrite this article
        </div>
        <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">
          Tell me how to improve it. I keep your links and images intact.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto scroll px-4 py-3">
        {phase === "idle" && !proposal && (
          <div className="flex flex-col gap-1.5">
            {REWRITE_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => send(chip)}
                className="rounded-[8px] border border-line bg-bg px-3 py-2 text-left text-[12.5px] text-ink-2 hover:border-accent-soft hover:bg-accent-soft/40 hover:text-ink"
              >
                {chip}
              </button>
            ))}
          </div>
        )}

        {(busy || proposal) && (
          <div className="flex flex-col gap-2.5">
            {proposal && (
              <div className="self-end max-w-[90%] rounded-[10px] rounded-br-[3px] bg-ink px-3 py-2 text-[12.5px] text-bg">
                {proposal.instruction}
              </div>
            )}
            {plan && (
              <div className="flex items-start gap-1.5 text-[12px] text-ink-3">
                <Icons.sparkle size={12} className={cn("mt-0.5 shrink-0 text-accent-ink", busy && "animate-pulse")} />
                <span className="italic">{plan}</span>
              </div>
            )}
            {busy && (
              <div className="rounded-[8px] border border-line bg-bg p-2.5 text-[12px] text-ink-3">
                {phase === "planning" ? "Reading the article…" : `Writing… ${streamedWords.toLocaleString()} words so far`}
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-panel-2">
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
                </div>
              </div>
            )}
            {proposal && (
              <div className="rounded-[8px] border border-accent-soft bg-bg p-2.5">
                <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-accent-ink">What changed</div>
                {proposal.changes.length ? (
                  <ul className="mb-2 flex flex-col gap-1 text-[12.5px] text-ink-2">
                    {proposal.changes.map((c, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="text-ink-4">•</span>
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mb-2 text-[12.5px] text-ink-3">The model did not say. Read it before replacing.</p>
                )}
                <button
                  type="button"
                  onClick={() => setShowPreview((v) => !v)}
                  className="mb-2 inline-flex items-center gap-1 text-[12px] text-accent-ink hover:underline"
                >
                  <Icons.eye size={11} />
                  {showPreview ? "Hide the proposed article" : "Read the proposed article"}
                </button>
                {showPreview && (
                  <HtmlPreview html={proposal.html} className="mb-2 max-h-[40vh] overflow-y-auto rounded-[6px] border border-line p-2.5" />
                )}
                <div className="flex justify-end gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setProposal(null);
                      setPhase("idle");
                    }}
                  >
                    Discard
                  </Button>
                  <Button
                    size="sm"
                    variant="accent"
                    onClick={() => {
                      // All-or-nothing until the hunk library lands; see applyHunks.
                      onReplace(applyHunks(getHtml(), proposal.html));
                      setProposal(null);
                      setPhase("idle");
                      toast.success("Replaced in the editor. Save to keep it.");
                    }}
                  >
                    <Icons.check size={12} />
                    Replace article
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-line p-3">
        <div className="flex items-end gap-1.5 rounded-[8px] border border-line bg-bg p-1.5 focus-within:border-accent">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(prompt);
              }
            }}
            rows={2}
            disabled={busy}
            placeholder="How should the article change?"
            aria-label="Rewrite instruction"
            className="flex-1 resize-none bg-transparent px-1.5 py-1 text-[12.5px] focus:outline-0 disabled:opacity-60"
          />
          {busy ? (
            <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()} aria-label="Stop">
              <Icons.x size={12} />
            </Button>
          ) : (
            <Button size="sm" variant="accent" onClick={() => send(prompt)} disabled={!prompt.trim()} aria-label="Send">
              <Icons.arrow size={12} />
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-ink-4">The rewrite is a proposal. Save is what writes.</p>
      </div>
    </aside>
  );
}

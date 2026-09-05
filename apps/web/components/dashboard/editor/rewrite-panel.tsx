"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Icons } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { cn, plural } from "@/lib/utils";
import { applyHunks, decideAll, keptSummary, proposeHunks, reviewableHunks } from "@/lib/editor/proposals";
import { changeReport, followUpChips, reportHeadline, type ChangeReport } from "@/lib/editor/rewrite-report";
import { normalizeBlock } from "@/lib/refresh/hunks";
import type { Hunk, HunkDecision } from "@/lib/refresh/types";
import { DecideAllButtons, KeptCounter } from "@/components/dashboard/review/hunk-controls";
import { RewriteHunkList } from "./rewrite-review";

// ---------------------------------------------------------------------------
// "Rewrite this article": the chat panel on the left
// ---------------------------------------------------------------------------
//
// One instruction in, the whole article back as a proposal, reviewed one
// block at a time. The stream shows the plan line and then progress as text
// arrives; when it completes the panel diffs the proposal against the article
// as sent (the refresh engine's block hunks) and opens on "N / N kept".
// Keep and Reject work per block or all at once; ∧ ∨ walk the changed
// blocks. Apply hands the editor only the kept hunks, staged: Save is still
// the only write. Then the panel reports what changed, built from the kept
// hunks, and offers the next instruction as chips.

export const REWRITE_CHIPS = [
  "Make the intro punchier and more engaging",
  "Rewrite in a more professional, expert tone",
  "Expand each section with more depth and examples",
  "Tighten the whole article and cut fluff",
] as const;

type Phase = "idle" | "planning" | "writing" | "review" | "applied";

interface Proposal {
  html: string;
  changes: string[];
  instruction: string;
  /** The article as sent, which the hunks are against. */
  before: string;
}

export function RewritePanel({
  articleId,
  getHtml,
  onReplace,
  onReviewingChange,
  className,
}: {
  articleId: string;
  /** The document as it stands; read at send time, not render time. */
  getHtml: () => string;
  /** The editor swaps the body for this HTML (staged, not saved). */
  onReplace: (html: string) => void;
  /** A review is open: the editor may give the panel more room. */
  onReviewingChange?: (reviewing: boolean) => void;
  className?: string;
}) {
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<string | null>(null);
  const [streamedWords, setStreamedWords] = useState(0);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [hunks, setHunks] = useState<Hunk[]>([]);
  const [decisions, setDecisions] = useState<Record<string, HunkDecision>>({});
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [report, setReport] = useState<ChangeReport | null>(null);
  const [chips, setChips] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const reviewing = phase === "review";
  useEffect(() => {
    onReviewingChange?.(reviewing);
  }, [reviewing, onReviewingChange]);

  const reviewable = useMemo(() => reviewableHunks(hunks), [hunks]);
  const summary = useMemo(() => keptSummary(hunks, decisions), [hunks, decisions]);

  const reset = useCallback(() => {
    setProposal(null);
    setHunks([]);
    setDecisions({});
    setFocusedId(null);
    setCompareId(null);
    setPhase("idle");
  }, []);

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
      setHunks([]);
      setDecisions({});
      setFocusedId(null);
      setCompareId(null);
      setReport(null);
      setChips([]);
      setStreamedWords(0);
      setPlan(null);
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
              const proposed = data.html ?? "";
              const next = proposeHunks(html, proposed);
              const open = reviewableHunks(next);
              setProposal({ html: proposed, changes: data.changes ?? [], instruction: text, before: html });
              setHunks(next);
              // Opens on "N / N kept", as the reviewer asked for the rewrite.
              setDecisions(decideAll(next, "accepted"));
              setFocusedId(open[0]?.id ?? null);
              setPhase("review");
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

  const decide = useCallback((id: string, d: HunkDecision) => {
    setDecisions((prev) => ({ ...prev, [id]: d }));
  }, []);

  const scrollTo = useCallback((id: string) => {
    setFocusedId(id);
    // Scroll the panel's own list, not the page: scrollIntoView walks every
    // ancestor and drags the editor document along with it.
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-hunk-id="${id}"]`);
    if (!list || !el) return;
    const delta = el.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollTop += delta - (list.clientHeight - el.clientHeight) / 2;
  }, []);

  const step = useCallback(
    (dir: 1 | -1) => {
      if (reviewable.length === 0) return;
      const at = reviewable.findIndex((h) => h.id === focusedId);
      const next = at < 0 ? 0 : (at + dir + reviewable.length) % reviewable.length;
      scrollTo(reviewable[next].id);
    },
    [reviewable, focusedId, scrollTo],
  );

  const apply = useCallback(() => {
    if (!proposal) return;
    // The hunks are against the article as sent. If it changed since, applying
    // them would overwrite whatever was typed in between.
    if (normalizeBlock(getHtml()) !== normalizeBlock(proposal.before)) {
      toast.error("The article changed while this rewrite was open. Discard it and ask again.");
      return;
    }
    const r = changeReport(hunks, decisions, proposal.changes, proposal.before);
    if (r.kept > 0) {
      onReplace(applyHunks(hunks, decisions));
      toast.success(`Applied ${r.kept} of ${plural(r.total, "change")}. Save to keep it.`);
    }
    setReport(r);
    setChips(followUpChips(hunks, decisions));
    setHunks([]);
    setDecisions({});
    setFocusedId(null);
    setCompareId(null);
    setPhase("applied");
  }, [proposal, hunks, decisions, getHtml, onReplace]);

  const busy = phase === "planning" || phase === "writing";
  const focusedIndex = reviewable.findIndex((h) => h.id === focusedId);

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

      {/* Decision bar: the one number a review is about, and the bulk moves. */}
      {reviewing && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-bg px-3 py-2 text-[12px]">
          <KeptCounter kept={summary.kept} total={summary.total} className="font-mono tabular-nums font-medium text-[12.5px]" />
          <div className="ml-auto flex items-center gap-0.5">
            <DecideAllButtons onDecideAll={(d) => setDecisions(decideAll(hunks, d))} disabled={reviewable.length === 0} />
            <Button size="sm" variant="ghost" onClick={() => step(-1)} disabled={reviewable.length === 0} aria-label="Previous change" title="Previous change">
              <Icons.caretDown size={12} className="rotate-180" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => step(1)} disabled={reviewable.length === 0} aria-label="Next change" title="Next change">
              <Icons.caretDown size={12} />
            </Button>
          </div>
          {reviewable.length > 0 && focusedIndex >= 0 && (
            <span className="w-full font-mono text-[10.5px] text-ink-4">
              change {focusedIndex + 1} of {reviewable.length}
            </span>
          )}
        </div>
      )}

      <div ref={listRef} className="flex-1 overflow-y-auto scroll px-4 py-3">
        {phase === "idle" && (
          <div className="flex flex-col gap-1.5">
            {REWRITE_CHIPS.map((chip) => (
              <Chip key={chip} onClick={() => send(chip)}>
                {chip}
              </Chip>
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
            {plan && phase !== "applied" && (
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

            {reviewing && proposal && (
              <>
                {reviewable.length === 0 ? (
                  <div className="rounded-[8px] border border-line bg-bg p-2.5 text-[12.5px] text-ink-3">
                    The rewrite came back the same as the article, block for block. Nothing to keep or reject.
                  </div>
                ) : (
                  <p className="text-[11.5px] leading-snug text-ink-3">
                    {plural(reviewable.length, "block")} changed. Each shows what Apply would put in the article; reject one to keep the
                    original there.
                  </p>
                )}
                <RewriteHunkList
                  hunks={hunks}
                  decisions={decisions}
                  focusedId={focusedId}
                  compareId={compareId}
                  onDecide={decide}
                  onFocus={setFocusedId}
                  onCompare={setCompareId}
                />
              </>
            )}

            {phase === "applied" && report && (
              <div className="rounded-[8px] border border-accent-soft bg-bg p-2.5">
                <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-accent-ink">What changed</div>
                <p className="mb-1.5 text-[12.5px] text-ink">{reportHeadline(report)}</p>
                {report.facts.length > 0 && (
                  <p className="mb-1.5 text-[12px] text-ink-2">{report.facts.join(" · ")}.</p>
                )}
                {report.sections.length > 0 && report.kept > 0 && (
                  <ul className="mb-1.5 flex flex-col gap-0.5 text-[12px] text-ink-2">
                    {report.sections.map((s, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="text-ink-4">•</span>
                        <span>
                          <span className="text-ink-3">{s.heading ?? "Intro"}:</span> {s.kept} of {plural(s.total, "change")} kept
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {report.notes.length > 0 && (
                  <ul className="mb-1.5 flex flex-col gap-1 border-t border-line-soft pt-1.5 text-[12.5px] text-ink-2">
                    {report.notes.map((c, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="text-ink-4">•</span>
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {report.droppedNotes > 0 && report.kept > 0 && (
                  <p className="mb-1.5 text-[11.5px] text-ink-4">
                    {plural(report.droppedNotes, "note")} from the model left out: not backed by a change you kept.
                  </p>
                )}
                {report.kept > 0 && (
                  <p className={cn("text-[12px]", report.assetsIntact ? "text-ink-3" : "text-err-ink")}>
                    {report.assetsIntact
                      ? "Every link and image is still in place."
                      : `${plural(report.missingAssets.length, "link or image", "links or images")} missing from the mix you kept. Check before saving.`}
                  </p>
                )}
                {chips.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5 border-t border-line-soft pt-2">
                    <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-4">Next</div>
                    {chips.map((chip) => (
                      <Chip key={chip} onClick={() => send(chip)}>
                        {chip}
                      </Chip>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex justify-end">
                  <Button size="sm" variant="ghost" onClick={reset}>
                    Done
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {reviewing && (
        <div className="flex justify-end gap-1.5 border-t border-line bg-bg px-3 py-2">
          <Button size="sm" variant="ghost" onClick={reset}>
            Discard
          </Button>
          <Button size="sm" variant="accent" onClick={apply} disabled={reviewable.length === 0}>
            <Icons.check size={12} />
            {summary.kept === 0 ? "Keep the original" : `Apply ${summary.kept} of ${summary.total}`}
          </Button>
        </div>
      )}

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
            disabled={busy || reviewing}
            placeholder={reviewing ? "Finish the review first" : "How should the article change?"}
            aria-label="Rewrite instruction"
            className="flex-1 resize-none bg-transparent px-1.5 py-1 text-[12.5px] focus:outline-0 disabled:opacity-60"
          />
          {busy ? (
            <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()} aria-label="Stop">
              <Icons.x size={12} />
            </Button>
          ) : (
            <Button size="sm" variant="accent" onClick={() => send(prompt)} disabled={!prompt.trim() || reviewing} aria-label="Send">
              <Icons.arrow size={12} />
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-ink-4">The rewrite is a proposal. Save is what writes.</p>
      </div>
    </aside>
  );
}

function Chip({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[8px] border border-line bg-bg px-3 py-2 text-left text-[12.5px] text-ink-2 hover:border-accent-soft hover:bg-accent-soft/40 hover:text-ink"
    >
      {children}
    </button>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui";
import { loadResearchContext, runPlaybook, type PlaybookCard } from "@/app/actions/keyword-research";
import type { PlaybookId } from "@/lib/keyword-research/seeds";
import type { ResearchResult } from "@/lib/keyword-research/types";

interface PlaybooksDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResult: (result: ResearchResult, title: string) => void;
}

/**
 * Seven query shapes that work for nearly every business, filled in from the
 * person's own profile. Each card shows the phrases it would actually search,
 * so the decision is made on the real seeds rather than on a template name.
 */
export function PlaybooksDialog({ workspaceId, open, onOpenChange, onResult }: PlaybooksDialogProps) {
  const [cards, setCards] = useState<PlaybookCard[] | null>(null);
  const [running, setRunning] = useState<PlaybookId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    loadResearchContext(workspaceId)
      .then((ctx) => setCards(ctx.playbooks))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load this site."));
  }, [open, workspaceId]);

  async function run(card: PlaybookCard) {
    if (!card.available || running) return;
    setRunning(card.id);
    setError(null);
    try {
      const result = await runPlaybook(workspaceId, card.id);
      onResult(result, `Playbook: ${card.title}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The playbook failed.");
    } finally {
      setRunning(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Playbooks"
      description="Pick a playbook and we'll research the keywords for you, then schedule the best ones."
      className="max-w-[760px]"
    >
      {error && <div className="text-[12.5px] text-err-ink bg-err-soft rounded-md px-3 py-2 mb-3">{error}</div>}
      {!cards && !error && <div className="text-[13px] text-ink-3">Loading your profile…</div>}
      {cards && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[70vh] overflow-y-auto scroll pr-1">
          {cards.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={!c.available || running !== null}
              onClick={() => run(c)}
              className="text-left rounded-lg border border-line p-3.5 hover:bg-panel transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex flex-col gap-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13.5px] font-semibold text-ink">{c.title}</span>
                <span className="font-mono text-[10.5px] text-ink-4">{c.pattern}</span>
              </div>
              <p className="text-[12.5px] text-ink-2">{c.description}</p>
              {c.available ? (
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {c.examples.map((e) => (
                    <span key={e} className="px-[7px] py-px rounded-full bg-panel-2 text-ink-2 text-[11px] font-mono">{e}</span>
                  ))}
                </div>
              ) : (
                <div className="text-[11.5px] text-ink-3">
                  Needs {c.needs === "brand" ? "a site name" : c.needs === "category" ? "a business description" : c.needs} in the business profile.
                </div>
              )}
              {running === c.id && <div className="font-mono text-[11px] text-accent-ink">Researching…</div>}
            </button>
          ))}
        </div>
      )}
      <p className="text-[11.5px] text-ink-3 mt-3">Nothing is scheduled by a playbook. Results open in the research drawer for you to pick from.</p>
    </Dialog>
  );
}

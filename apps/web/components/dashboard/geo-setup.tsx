"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { inputClass, removeButtonClass, Toggle } from "@/components/settings/fields";
import { addGeoPrompt, removeGeoPrompt, setGeoTracking } from "@/app/actions/geo";
import { GEO_PROMPT_LIMIT } from "@/lib/geo/prompts";

/**
 * Switching AI visibility on for one site, and the questions it is measured on.
 *
 * The prompt set is the measurement: changing it changes the number. So the
 * questions are typed by a person, not generated, and the hint says what a
 * good one looks like - the words a buyer types, not a keyword list.
 */
export function GeoSetup({
  workspaceId,
  domain,
  tracking,
  prompts,
}: {
  workspaceId: string;
  domain: string;
  tracking: boolean;
  prompts: Array<{ id: string; prompt: string }>;
}) {
  const [on, setOn] = useState(tracking);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();

  function toggle(next: boolean) {
    setOn(next);
    startTransition(async () => {
      const res = await setGeoTracking(workspaceId, next);
      if (!res.ok) {
        setOn(!next);
        toast.error(res.error);
        return;
      }
      toast.success(
        next
          ? prompts.length
            ? "Tracking on. The first answers arrive after the next 08:00 run."
            : "Tracking on. Add the questions to measure."
          : "Tracking off. No new sweeps start for this site.",
      );
    });
  }

  function add(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    const text = draft;
    startTransition(async () => {
      const res = await addGeoPrompt(workspaceId, text);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // Only if nothing new was typed while it saved.
      setDraft((d) => (d === text ? "" : d));
    });
  }

  function remove(id: string) {
    startTransition(async () => {
      const res = await removeGeoPrompt(workspaceId, id);
      if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <Card className="p-5" flush>
      <h3 className="text-[13px] font-medium mb-1">Set up tracking for {domain}</h3>
      <p className="mb-4 text-[12.5px] leading-relaxed text-ink-3 max-w-[70ch]">
        Each week AltoRank asks the ChatGPT app, Gemini and Google AI Mode every question below,
        several times over five days, and counts how often the answers name {domain}. Keep the list
        stable: changing it changes the number.
      </p>

      <Toggle
        label="Track AI visibility for this site"
        hint="A new sweep starts once a week. Paid plans only."
        checked={on}
        onChange={toggle}
      />

      <div className="mt-4">
        <div className="text-[12.5px] font-medium text-ink-2 mb-1.5">
          Questions buyers ask ({prompts.length}/{GEO_PROMPT_LIMIT})
        </div>
        {prompts.length > 0 && (
          <ul className="mb-2 flex flex-col gap-1.5">
            {prompts.map((p) => (
              <li key={p.id} className="flex items-center gap-2 rounded-[7px] border border-line px-3 py-1">
                <span className="flex-1 text-[13px]">{p.prompt}</span>
                <button
                  type="button"
                  className={removeButtonClass}
                  aria-label={`Remove "${p.prompt}"`}
                  disabled={pending}
                  onClick={() => remove(p.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={add} className="flex gap-2">
          <input
            className={inputClass}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. free backlink checker for my website"
            aria-label="Add a question"
            // Typeable while the last one saves: a disabled field dropped
            // whatever was typed into it in the meantime.
            disabled={prompts.length >= GEO_PROMPT_LIMIT}
          />
          <Button type="submit" variant="primary" disabled={pending || !draft.trim() || prompts.length >= GEO_PROMPT_LIMIT}>
            Add
          </Button>
        </form>
        <p className="mt-1.5 text-[11.5px] text-ink-3">
          Write it the way someone types it into ChatGPT. About ten questions is enough.
        </p>
      </div>
    </Card>
  );
}

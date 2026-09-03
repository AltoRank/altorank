"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@/components/ui";
import { updateWorkspace } from "@/app/actions/workspaces";
import { getLocaleOptions, getLocale } from "@/lib/seo/locales";

type LocaleSelectorProps = {
  workspaceId: string;
  currentLanguage: string;
};

export function LocaleSelector({ workspaceId, currentLanguage }: LocaleSelectorProps) {
  const router = useRouter();
  const options = getLocaleOptions();
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  /**
   * The menu shows the chosen language immediately, but the choice is the
   * server's to confirm.
   *
   * Held in `useOptimistic` rather than `useState` so it lasts exactly as long
   * as the write is in flight and then defers to the prop. Kept in local state
   * a rejected save left the menu naming one country while keyword research,
   * SERP tracking and generation all continued in another - and said "Saved"
   * about none of it, since the throw skipped that too.
   */
  const [language, setLanguage] = useOptimistic(currentLanguage || "en");
  const current = getLocale(language);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const lang = e.target.value;
    setSaved(false);

    startTransition(async () => {
      // Inside the transition: an optimistic value set outside one is not
      // tracked, and React warns rather than showing it.
      setLanguage(lang);

      const locale = getLocale(lang);
      const fd = new FormData();
      fd.set("language", lang);
      fd.set("location_code", String(locale.locationCode));

      try {
        await updateWorkspace(workspaceId, fd);
        // Awaited here, still inside the transition, so the optimistic value
        // holds until the re-rendered prop replaces it. Left outside, the menu
        // would flash back to the old language in the gap between the write
        // landing and the server render arriving.
        router.refresh();
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch (err) {
        // No revert to write: leaving the transition drops the optimistic
        // value, so the menu returns to the stored language on its own.
        toast.error(
          err instanceof Error ? err.message : "Could not change the language",
        );
      }
    });
  }

  return (
    <Card className="p-5" flush>
      <h3 className="text-[13px] font-medium mb-1">Language &amp; region</h3>
      <p className="text-[12px] text-ink-3 mb-3">
        Sets the language and country for keyword research, SERP tracking, and content generation.
      </p>
      <div className="flex items-center gap-3">
        <select
          value={language}
          onChange={handleChange}
          disabled={isPending}
          className="flex-1 px-2.5 py-1.5 text-[13px] bg-panel border border-line rounded-md focus:outline-none focus:border-accent"
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {saved && (
          <span className="text-[11px] text-ok-ink font-medium">Saved</span>
        )}
      </div>
      <div className="text-[11px] text-ink-3 mt-2">
        Currently: {current.label} — {current.country} (location code {current.locationCode})
      </div>
    </Card>
  );
}

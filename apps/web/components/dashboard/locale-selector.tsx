"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
  const current = getLocale(currentLanguage);
  const [value, setValue] = useState(currentLanguage || "en");
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const lang = e.target.value;
    setValue(lang);
    setSaved(false);

    const locale = getLocale(lang);
    const fd = new FormData();
    fd.set("language", lang);
    fd.set("location_code", String(locale.locationCode));

    await updateWorkspace(workspaceId, fd);
    setSaved(true);
    startTransition(() => router.refresh());
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <Card className="p-5">
      <h3 className="text-[13px] font-medium mb-1">Language &amp; region</h3>
      <p className="text-[12px] text-ink-3 mb-3">
        Sets the language and country for keyword research, SERP tracking, and content generation.
      </p>
      <div className="flex items-center gap-3">
        <select
          value={value}
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

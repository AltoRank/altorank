"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { updateAgencyProfile, rotateApiKey } from "@/app/actions/settings";
import type { Agency } from "@/lib/types";

interface SettingsFormProps {
  agency: Agency;
}

export function SettingsForm({ agency }: SettingsFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [apiKey, setApiKey] = useState(agency.api_key ?? "");
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [accentColor, setAccentColor] = useState(agency.accent_color ?? "#5763EC");

  const COLORS = ["#5763EC", "#D97757", "#0F766E", "#111827"];

  function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("accent_color", accentColor);
    startTransition(async () => {
      await updateAgencyProfile(fd);
      router.refresh();
    });
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleRotate() {
    if (!confirm("Rotate API key? The current key will stop working immediately.")) return;
    setRotating(true);
    try {
      const newKey = await rotateApiKey();
      setApiKey(newKey);
    } finally {
      setRotating(false);
    }
  }

  const inputClass = "w-full px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] mb-3.5 focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft";
  const labelClass = "font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1.5 block";

  return (
    <form onSubmit={handleSave}>
      <div className="grid grid-cols-2 gap-4">
        {/* Agency profile */}
        <div className="bg-bg border border-line rounded-lg p-5">
          <h3 className="text-sm font-semibold mb-1">Agency profile</h3>
          <p className="text-[12.5px] text-ink-3 mb-4">How you appear on reports and client-facing pages.</p>
          <label className={labelClass}>Agency name</label>
          <input name="name" className={inputClass} defaultValue={agency.name} />
          <label className={labelClass}>Reporting email</label>
          <input name="report_email" className={inputClass} defaultValue={agency.report_email ?? ""} />
          <label className={labelClass}>Logo</label>
          <div className="flex gap-2.5 items-center">
            <div className="w-12 h-12 bg-ink text-bg rounded-[10px] grid place-items-center font-mono font-semibold">
              {agency.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
            </div>
            <Button type="button" size="sm" disabled>Upload</Button>
          </div>
        </div>

        {/* White-label */}
        <div className="bg-bg border border-line rounded-lg p-5">
          <h3 className="text-sm font-semibold mb-1">White-label</h3>
          <p className="text-[12.5px] text-ink-3 mb-4">Reports go out under your domain.</p>
          <label className={labelClass}>Custom domain</label>
          <input name="custom_domain" className={inputClass} defaultValue={agency.custom_domain ?? ""} />
          <label className={labelClass}>Accent color</label>
          <div className="flex gap-2 mb-3.5">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setAccentColor(c)}
                className="w-7 h-7 rounded-full cursor-pointer transition-opacity"
                style={{
                  background: c,
                  border: accentColor === c ? "2px solid var(--ink)" : "2px solid transparent",
                  opacity: accentColor === c ? 1 : 0.4,
                }}
              />
            ))}
          </div>
          <label className={labelClass}>Remove &ldquo;Powered by AltoRank&rdquo;</label>
          <div className="flex items-center gap-2 text-[13px]">
            <div className="w-8 h-[18px] rounded-full bg-accent relative">
              <div className="absolute w-3.5 h-3.5 rounded-full bg-white top-0.5 right-0.5" />
            </div>
            Enabled · Scale plan
          </div>
        </div>

        {/* API access */}
        <div className="bg-bg border border-line rounded-lg p-5 col-span-2">
          <h3 className="text-sm font-semibold mb-1">API access</h3>
          <p className="text-[12.5px] text-ink-3 mb-4">Build internal tools on top of AltoRank.</p>
          <div className="flex gap-2.5 items-center px-3 py-2.5 bg-panel border border-line rounded-lg">
            <span className="font-mono text-xs flex-1 select-all">{apiKey}</span>
            <Button type="button" size="sm" onClick={handleRotate} disabled={rotating}>
              {rotating ? "Rotating…" : "Rotate"}
            </Button>
            <Button type="button" size="sm" onClick={handleCopy}>
              {copied ? "Copied!" : "Copy"}
            </Button>
          </div>
        </div>

        {/* Save */}
        <div className="col-span-2 flex justify-end">
          <Button type="submit" variant="accent" disabled={isPending}>
            {isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </form>
  );
}

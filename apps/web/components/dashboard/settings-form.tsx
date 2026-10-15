"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { updateAccountProfile } from "@/app/actions/settings";
import type { Account } from "@/lib/types";

interface SettingsFormProps {
  account: Account;
  /** Why the account's quota is what it is; decides the attribution line. */
  quotaReason: "self-host" | "operator" | "plan" | "no-plan";
  /**
   * Owner or admin. Only they may change account settings
   * (`updateAccountProfile`); an editor sees the values read-only instead of
   * a Save that always failed with no message.
   */
  canEdit: boolean;
}

export function SettingsForm({ account, quotaReason, canEdit }: SettingsFormProps) {
  // Only the hosted free tier publishes with the line. See
  // lib/publishing/attribution.ts for why the rule lives on the plan and not
  // on a toggle.
  const attributionApplies = quotaReason === "no-plan";
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [accentColor, setAccentColor] = useState(account.accent_color ?? "#5763EC");

  const COLORS = ["#5763EC", "#D97757", "#0F766E", "#111827"];

  function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("accent_color", accentColor);
    startTransition(async () => {
      try {
        await updateAccountProfile(fd);
        toast.success("Saved");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not save");
      }
    });
  }

  const inputClass = "w-full px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] mb-3.5 focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft";
  const labelClass = "font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1.5 block";

  return (
    <form onSubmit={handleSave}>
      <fieldset disabled={!canEdit} className="grid grid-cols-2 gap-4">
        {/* Account profile */}
        <div className="bg-bg border border-line rounded-lg p-5">
          {/* Account-wide, not this site's: `updateAccountProfile` writes the
              accounts row, and every site's report PDF is signed with its
              name (lib/reports/pdf-template.tsx). Labelled "Workspace" it
              read as a per-site setting. */}
          <h3 className="text-sm font-semibold mb-1">Account profile</h3>
          <p className="text-[12.5px] text-ink-3 mb-4">Shared by every site in this account. Each site&rsquo;s reports are signed with this name.</p>
          <label className={labelClass}>Account name</label>
          <input name="name" className={inputClass} defaultValue={account.name} />
          <label className={labelClass}>Reporting email</label>
          <input name="report_email" className={inputClass} defaultValue={account.report_email ?? ""} />
          <label className={labelClass}>Logo</label>
          <div className="flex gap-2.5 items-center">
            <div className="w-12 h-12 bg-ink text-bg rounded-[10px] grid place-items-center font-mono font-semibold">
              {account.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
            </div>
            <span className="text-[12px] text-ink-3">
              Reports use these initials for now. Logo upload is on the way.
            </span>
          </div>
        </div>

        {/* White-label */}
        <div className="bg-bg border border-line rounded-lg p-5">
          <h3 className="text-sm font-semibold mb-1">White-label</h3>
          {/* "Your logo and" removed: nothing writes accounts.logo_url - there
              is no upload anywhere - so the report template's
              `{logo_url && <Image/>}` never renders. The card said so itself
              eight lines above ("Logo upload is on the way") while promising
              it here. Only accent_color is real (2026-09-06). */}
          <p className="text-[12.5px] text-ink-3 mb-4">Your accent colour on every report PDF, and the AltoRank line removed.</p>
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
          <label className={labelClass}>&ldquo;Powered by AltoRank&rdquo; on published articles</label>
          <div className="flex items-start gap-2 text-[13px] text-ink-2">
            <div className={`mt-0.5 h-[18px] w-8 shrink-0 rounded-full relative ${attributionApplies ? "bg-line" : "bg-accent"}`}>
              <div className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white ${attributionApplies ? "left-0.5" : "right-0.5"}`} />
            </div>
            {attributionApplies ? (
              <span>
                Free articles publish with one line linking back to AltoRank. Any paid
                plan removes it — self-hosting removes it too, and always did.
              </span>
            ) : (
              <span>
                Removed. Your articles publish with no AltoRank line
                {quotaReason === "self-host" ? " — self-hosted installs never carry one." : "."}
              </span>
            )}
          </div>
        </div>

        {/* The legacy single account key and its Rotate button are gone:
            Rotate was refused by the database for everyone (the key is a
            server-written column), a new account had no key to show, and
            scoped keys on the API keys tab replace it. */}
        <p className="col-span-2 text-[12.5px] text-ink-3">
          API access is on the{" "}
          <a href="/settings/api-keys" className="underline underline-offset-2 hover:text-ink">API keys</a> tab:
          scoped keys that can expire and be revoked one at a time.
        </p>

        {/* Save */}
        <div className="col-span-2 flex justify-end">
          {canEdit ? (
            <Button type="submit" variant="accent" disabled={isPending}>
              {isPending ? "Saving…" : "Save changes"}
            </Button>
          ) : (
            <p className="text-[12.5px] text-ink-3">Only an owner or admin can change these.</p>
          )}
        </div>
      </fieldset>
    </form>
  );
}

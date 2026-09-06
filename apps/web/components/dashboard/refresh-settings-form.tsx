"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { setRefreshSettings } from "@/app/actions/refresh";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const MAX_REFRESH_DAYS = 2;

/**
 * The per-site switch behind the Improvements page.
 *
 * Two weekdays at most, one rewrite each. Each rewrite is a model call and a
 * slot of the site's article pace, so the ceiling is stated rather than left
 * for the bill to explain. Nothing here publishes: a rewrite lands in review.
 */
export function RefreshSettingsForm({
  workspaceId,
  domain,
  enabled: initialEnabled,
  days: initialDays,
}: {
  workspaceId: string;
  domain: string | null;
  enabled: boolean;
  days: number[];
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [days, setDays] = useState<number[]>(initialDays);
  const [pending, startTransition] = useTransition();

  function toggleDay(day: number) {
    setDays((prev) => {
      if (prev.includes(day)) return prev.filter((d) => d !== day);
      if (prev.length >= MAX_REFRESH_DAYS) {
        toast.message(`At most ${MAX_REFRESH_DAYS} days: one improvement per scheduled day.`);
        return prev;
      }
      return [...prev, day].sort();
    });
  }

  function save() {
    startTransition(async () => {
      try {
        await setRefreshSettings(workspaceId, { enabled, days });
        toast.success(
          enabled && days.length
            ? `Rewrites on ${days.map((d) => DAY_LABELS[d]).join(" and ")}`
            : enabled
              ? "Enabled, but no day is picked yet, so nothing will run"
              : "Scheduled rewrites are off for this site",
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not save");
      }
    });
  }

  const dirty = enabled !== initialEnabled || days.join() !== initialDays.join();

  return (
    <Card className="p-5" flush>
      <h3 className="text-[13px] font-medium mb-1">Scheduled rewrites{domain ? ` for ${domain}` : ""}</h3>
      <p className="mb-4 text-[12.5px] leading-relaxed text-ink-3">
        One improvement per scheduled day, consuming one slot of your article pace. The rewrite is
        produced on the morning of that day (about 07:30 UTC) and waits for your review; nothing
        reaches your site until you push it.
      </p>

      <div className="space-y-4 text-[13px]">
        <div className="flex items-center justify-between">
          <span className="text-ink-2">Enable</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled((v) => !v)}
            className={`relative w-9 h-5 rounded-full transition-colors cursor-pointer ${enabled ? "bg-accent" : "bg-panel-2"}`}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`}
            />
          </button>
        </div>

        <div>
          <span className="text-ink-3 text-[11px] uppercase tracking-[0.06em] block mb-2">
            Days (up to {MAX_REFRESH_DAYS})
          </span>
          <div className="flex gap-1.5 flex-wrap">
            {DAY_LABELS.map((label, i) => (
              <Chip key={label} label={label} active={days.includes(i)} onClick={() => toggleDay(i)} />
            ))}
          </div>
        </div>

        <Button size="sm" variant="accent" className="w-full justify-center" onClick={save} disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </Card>
  );
}

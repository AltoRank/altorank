"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { upsertCadence } from "@/app/actions/schedule";
import type { PublishingCadence } from "@/lib/types";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const COMMON_TIMEZONES = [
  "Europe/Rome",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Australia/Sydney",
  "UTC",
];

type Props = {
  workspaceId: string;
  cadence: PublishingCadence | null;
};

export function PublishingCadenceForm({ workspaceId, cadence }: Props) {
  const [enabled, setEnabled] = useState(cadence?.enabled ?? false);
  const [days, setDays] = useState<number[]>(cadence?.days_of_week ?? [1, 3, 5]);
  const [time, setTime] = useState(cadence?.publish_time?.slice(0, 5) ?? "10:00");
  const [timezone, setTimezone] = useState(cadence?.timezone ?? "Europe/Rome");
  const [isPending, startTransition] = useTransition();

  function toggleDay(day: number) {
    setDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort(),
    );
  }

  function handleSave() {
    startTransition(async () => {
      try {
        await upsertCadence({
          workspace_id: workspaceId,
          enabled,
          days_of_week: days,
          publish_time: time,
          timezone,
        });
        toast.success("Publishing schedule saved");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save");
      }
    });
  }

  return (
    <Card className="p-5" flush>
      <h3 className="text-[13px] font-medium mb-4">Publishing schedule</h3>

      <div className="space-y-4 text-[13px]">
        {/* Enable toggle */}
        <div className="flex items-center justify-between">
          <span className="text-ink-2">Auto-publish</span>
          <button
            type="button"
            onClick={() => setEnabled(!enabled)}
            className={`relative w-9 h-5 rounded-full transition-colors cursor-pointer ${
              enabled ? "bg-accent" : "bg-panel-2"
            }`}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                enabled ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>

        {/* Days */}
        <div>
          <span className="text-ink-3 text-[11px] uppercase tracking-[0.06em] block mb-2">
            Days
          </span>
          <div className="flex gap-1.5">
            {DAY_LABELS.map((label, i) => (
              <Chip
                key={label}
                label={label}
                active={days.includes(i)}
                onClick={() => toggleDay(i)}
              />
            ))}
          </div>
        </div>

        {/* Time */}
        <div className="flex items-center justify-between">
          <span className="text-ink-3 text-[11px] uppercase tracking-[0.06em]">
            Publish time
          </span>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="bg-bg border border-line rounded-[6px] px-2 py-1 text-[12.5px] font-mono"
          />
        </div>

        {/* Timezone */}
        <div className="flex items-center justify-between">
          <span className="text-ink-3 text-[11px] uppercase tracking-[0.06em]">
            Timezone
          </span>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="bg-bg border border-line rounded-[6px] px-2 py-1.5 text-[12.5px] font-mono"
          >
            {COMMON_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>

        <Button
          size="sm"
          className="w-full justify-center"
          onClick={handleSave}
          disabled={isPending}
        >
          {isPending ? "Saving…" : "Save schedule"}
        </Button>
      </div>
    </Card>
  );
}

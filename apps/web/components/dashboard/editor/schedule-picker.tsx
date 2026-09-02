"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icons } from "@/components/ui/icons";
import {
  scheduleArticle,
  unscheduleArticle,
  addToQueue,
} from "@/app/actions/schedule";
import type { Article, PublishingCadence } from "@/lib/types";

type Props = {
  article: Article;
  cadence: PublishingCadence | null;
};

export function SchedulePicker({ article, cadence }: Props) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");
  const [isPending, startTransition] = useTransition();

  // Article is already scheduled
  if (article.status === "scheduled") {
    const label = article.scheduled_at
      ? `Scheduled for ${new Date(article.scheduled_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${new Date(article.scheduled_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`
      : "In publish queue";

    return (
      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-2 p-2.5 bg-panel-2 border border-line rounded-[7px] text-[12.5px]">
          <Icons.calendar size={13} className="text-ink-3 shrink-0" />
          <span className="text-ink-2">{label}</span>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1 justify-center"
            onClick={() => {
              setExpanded(true);
            }}
            disabled={isPending}
          >
            Reschedule
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="flex-1 justify-center"
            onClick={() => {
              startTransition(async () => {
                try {
                  await unscheduleArticle(article.id);
                  toast.success("Schedule cancelled");
                  router.refresh();
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Failed to cancel",
                  );
                }
              });
            }}
            disabled={isPending}
          >
            Cancel
          </Button>
        </div>
        {expanded && (
          <ScheduleForm
            date={date}
            time={time}
            onDateChange={setDate}
            onTimeChange={setTime}
            isPending={isPending}
            onSchedule={() => {
              if (!date) return toast.error("Pick a date");
              startTransition(async () => {
                try {
                  const scheduledAt = new Date(`${date}T${time}`).toISOString();
                  await scheduleArticle(article.id, scheduledAt);
                  toast.success("Rescheduled");
                  router.refresh();
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Failed to reschedule",
                  );
                }
              });
            }}
          />
        )}
      </div>
    );
  }

  // Article is approved — show scheduling options (scheduling requires approval)
  if (article.status !== "approved") return null;

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-2 text-[11px] text-ink-3">
        <div className="flex-1 border-t border-line" />
        <span>or</span>
        <div className="flex-1 border-t border-line" />
      </div>

      <Button
        size="sm"
        variant="ghost"
        className="w-full justify-center"
        onClick={() => setExpanded(!expanded)}
      >
        <Icons.calendar size={13} />
        Schedule {expanded ? "▴" : "▾"}
      </Button>

      {expanded && (
        <ScheduleForm
          date={date}
          time={time}
          onDateChange={setDate}
          onTimeChange={setTime}
          isPending={isPending}
          onSchedule={() => {
            if (!date) return toast.error("Pick a date");
            startTransition(async () => {
              try {
                const scheduledAt = new Date(`${date}T${time}`).toISOString();
                await scheduleArticle(article.id, scheduledAt);
                toast.success("Article scheduled");
                router.refresh();
              } catch (err) {
                toast.error(
                  err instanceof Error ? err.message : "Failed to schedule",
                );
              }
            });
          }}
        />
      )}

      {cadence?.enabled && (
        <Button
          size="sm"
          variant="ghost"
          className="w-full justify-center"
          onClick={() => {
            startTransition(async () => {
              try {
                await addToQueue(article.id);
                toast.success("Added to publish queue");
                router.refresh();
              } catch (err) {
                toast.error(
                  err instanceof Error ? err.message : "Failed to add to queue",
                );
              }
            });
          }}
          disabled={isPending}
        >
          Add to queue
        </Button>
      )}
    </div>
  );
}

function ScheduleForm({
  date,
  time,
  onDateChange,
  onTimeChange,
  isPending,
  onSchedule,
}: {
  date: string;
  time: string;
  onDateChange: (v: string) => void;
  onTimeChange: (v: string) => void;
  isPending: boolean;
  onSchedule: () => void;
}) {
  return (
    <div className="space-y-2 p-2.5 bg-panel-2 rounded-[7px] border border-line">
      <div className="flex gap-2">
        <input
          type="date"
          value={date}
          onChange={(e) => onDateChange(e.target.value)}
          className="flex-1 bg-bg border border-line rounded-[6px] px-2 py-1 text-[12px] font-mono"
        />
        <input
          type="time"
          value={time}
          onChange={(e) => onTimeChange(e.target.value)}
          className="w-[90px] bg-bg border border-line rounded-[6px] px-2 py-1 text-[12px] font-mono"
        />
      </div>
      <Button
        size="sm"
        className="w-full justify-center"
        onClick={onSchedule}
        disabled={isPending}
      >
        {isPending ? "Scheduling…" : "Confirm"}
      </Button>
    </div>
  );
}

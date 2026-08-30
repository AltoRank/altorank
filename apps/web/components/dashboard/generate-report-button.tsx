"use client";

import { useTransition, useState } from "react";
import { generateReportAction } from "@/app/actions/reports";
import { Button, Icons } from "@/components/ui";

export function GenerateReportButton({ workspaceId }: { workspaceId: string }) {
  const [pending, startTransition] = useTransition();
  const [showPicker, setShowPicker] = useState(false);

  // Default: last month
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

  const defaultStart = lastMonth.toISOString().slice(0, 10);
  const defaultEnd = endOfLastMonth.toISOString().slice(0, 10);

  if (!showPicker) {
    return (
      <Button variant="accent" onClick={() => setShowPicker(true)}>
        <Icons.plus size={14} />
        New report
      </Button>
    );
  }

  return (
    <form
      className="flex items-end gap-2"
      action={(fd) =>
        startTransition(async () => {
          const start = fd.get("start") as string;
          const end = fd.get("end") as string;
          await generateReportAction(workspaceId, start, end);
          setShowPicker(false);
        })
      }
    >
      <div>
        <label className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1 block">From</label>
        <input name="start" type="date" defaultValue={defaultStart} className="px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent" />
      </div>
      <div>
        <label className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1 block">To</label>
        <input name="end" type="date" defaultValue={defaultEnd} className="px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent" />
      </div>
      <Button type="submit" variant="accent" disabled={pending}>
        {pending ? "Generating…" : "Generate"}
      </Button>
      <Button type="button" onClick={() => setShowPicker(false)}>Cancel</Button>
    </form>
  );
}

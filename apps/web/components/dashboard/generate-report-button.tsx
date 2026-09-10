"use client";

import { useTransition, useState } from "react";
import { toast } from "sonner";
import { generateReportAction } from "@/app/actions/reports";
import { Button, Icons } from "@/components/ui";
import { useWorkspace } from "@/components/dashboard/workspace-context";
import posthog from "posthog-js";

/**
 * Which workspace gets reported on is a choice, not an accident. This took a
 * single workspaceId and the page passed `workspaces[0]`, so an account with
 * four clients silently generated a report for whichever was created first -
 * the same first-row bug the Articles page had.
 *
 * It then grew its own workspace <select>, from when the switcher changed
 * nothing else. Now that the switcher scopes the whole app, a second picker
 * here offered a site the rest of the screen was not showing, and the
 * report list below the button was filtered to one site while the button
 * could generate for another. It binds to the sidebar scope, like
 * google-connect-button.tsx.
 */
export function GenerateReportButton() {
  const { workspaces, active } = useWorkspace();
  const [pending, startTransition] = useTransition();
  const [showPicker, setShowPicker] = useState(false);
  const target = active ?? workspaces[0];

  // Default: last month
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

  const defaultStart = lastMonth.toISOString().slice(0, 10);
  const defaultEnd = endOfLastMonth.toISOString().slice(0, 10);

  if (!target) return null;

  if (!showPicker) {
    return (
      <Button variant="accent" onClick={() => setShowPicker(true)}>
        <Icons.plus size={14} />
        New report for {target.name}
      </Button>
    );
  }

  return (
    <form
      className="flex items-end gap-2"
      action={(fd) =>
        // Same shape as everywhere else: without a catch, a refused report
        // and a generated one leave the screen looking identical.
        startTransition(async () => {
          const start = fd.get("start") as string;
          const end = fd.get("end") as string;
          try {
            await generateReportAction(target.id, start, end);
            posthog.capture("report_generated", { workspace_id: target.id });
            setShowPicker(false);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not generate the report.");
          }
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
        {pending ? `Generating for ${target.name}…` : `Generate for ${target.name}`}
      </Button>
      <Button type="button" onClick={() => setShowPicker(false)}>Cancel</Button>
    </form>
  );
}

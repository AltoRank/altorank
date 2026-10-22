"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { setAutoApproveExceptions } from "@/app/actions/auto-approve-exceptions";
import {
  CLEAN_APPROVALS_FOR_SENSITIVE,
  OPT_OUT_LABELS,
  OPT_OUT_RULES,
  optedOut,
  ruleIsOff,
  type OptOutRule,
} from "@/lib/publishing/auto-approve-exceptions";

/** Rules no site can turn off, shown so the list is the whole answer. */
const ALWAYS_ON = [
  "The first draft on this site",
  "A figure has no source, or a claim is high risk",
  "The last two publishes failed",
] as const;

/**
 * "Always ask me when": the exception rules that send a draft to a person
 * under automatic publishing (lib/publishing/auto-approve-exceptions.ts).
 * Four can be turned off; health, legal and money advice only once the site
 * has the clean approvals D5 asks for. A minimal form until the Autopilot
 * settings screen (S3) replaces it.
 */
export function AutoApproveExceptionsForm({
  workspaceId,
  stored,
  cleanApprovals,
}: {
  workspaceId: string;
  /** `workspaces.auto_approve_exceptions` as read. */
  stored: unknown;
  /** Human approvals on this site that went live unedited. */
  cleanApprovals: number;
}) {
  const sensitiveUnlocked = cleanApprovals >= CLEAN_APPROVALS_FOR_SENSITIVE;
  // A stored opt-out that is not honoured yet (sensitive below the bar)
  // shows as on, because it is.
  const [off, setOff] = useState<Set<OptOutRule>>(() => {
    const saved = optedOut(stored);
    return new Set(OPT_OUT_RULES.filter((r) => ruleIsOff(r, saved, cleanApprovals)));
  });
  const [pending, startTransition] = useTransition();

  function toggle(rule: OptOutRule) {
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(rule)) next.delete(rule);
      else next.add(rule);
      return next;
    });
  }

  function save() {
    startTransition(async () => {
      try {
        await setAutoApproveExceptions(workspaceId, [...off]);
        toast.success(off.size ? "Saved: autopilot no longer asks about the rules you turned off" : "Saved: autopilot asks about every rule");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not save");
      }
    });
  }

  return (
    <Card className="p-5" flush>
      <h3 className="text-[13px] font-medium mb-1">Always ask me when</h3>
      <p className="mb-4 text-[12.5px] leading-relaxed text-ink-3">
        With automatic publishing on, these drafts wait for a person instead of shipping after the hold.
      </p>
      <ul className="divide-y divide-line-soft rounded-md border border-line-soft text-[13px]">
        {OPT_OUT_RULES.map((rule) => {
          const locked = rule === "sensitive" && !sensitiveUnlocked;
          const on = !off.has(rule);
          return (
            <li key={rule} className="flex items-center justify-between gap-4 p-3">
              <span className="min-w-0">
                <span className="font-medium text-ink">{OPT_OUT_LABELS[rule].title}</span>
                <span className="block text-[12.5px] text-ink-3">
                  {OPT_OUT_LABELS[rule].detail}
                  {rule === "sensitive" && ` · ${Math.min(cleanApprovals, CLEAN_APPROVALS_FOR_SENSITIVE)} of ${CLEAN_APPROVALS_FOR_SENSITIVE} so far`}
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-label={OPT_OUT_LABELS[rule].title}
                className="h-4 w-4 flex-none"
                checked={on}
                disabled={locked}
                onChange={() => toggle(rule)}
              />
            </li>
          );
        })}
        {ALWAYS_ON.map((t) => (
          <li key={t} className="flex items-center justify-between gap-4 p-3">
            <span>
              <span className="font-medium text-ink">{t}</span>
              <span className="block text-[12.5px] text-ink-3">Always on</span>
            </span>
            <input type="checkbox" role="switch" aria-label={t} className="h-4 w-4 flex-none" checked disabled readOnly />
          </li>
        ))}
      </ul>
      <div className="mt-4 flex justify-end">
        <Button size="sm" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </Card>
  );
}

"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { setAutoApprove } from "@/app/actions/workspaces";

const HOLD_OPTIONS = [
  { value: 0, label: "the next publish run" },
  { value: 24, label: "24 hours" },
  { value: 48, label: "48 hours" },
  { value: 72, label: "3 days" },
  { value: 168, label: "a week" },
] as const;

/**
 * The publishing decision, per workspace.
 *
 * Two modes, one sentence each. "Review each draft" is what every workspace
 * did until migration 079: nothing ships until a person clicks Approve.
 * "Publish automatically" runs the same checks that click runs (plan, fact
 * check, audit, score floor) and then ships without it, after a hold window
 * that exists so the drafted email arrives before the article does.
 *
 * The rule is attributed: whoever saves it is recorded as `approved_by` on
 * every article it approves, and the card says so, because that is the whole
 * difference between this and an autopilot.
 */
export function AutoApproveForm({
  workspaceId,
  enabled: initialEnabled,
  holdHours: initialHold,
  minSeo: initialMinSeo,
  setByName,
  hasCadence,
}: {
  workspaceId: string;
  enabled: boolean;
  holdHours: number;
  minSeo: number;
  /** Display name of whoever turned the rule on, when it is on. */
  setByName: string | null;
  /** Whether an enabled publishing schedule exists; without one nothing ships. */
  hasCadence: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [hold, setHold] = useState(initialHold);
  const [minSeo, setMinSeo] = useState(initialMinSeo);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      try {
        const res = await setAutoApprove(workspaceId, { enabled, holdHours: hold, minSeo });
        toast.success(
          enabled
            ? `Drafts publish on their own after ${HOLD_OPTIONS.find((o) => o.value === hold)?.label ?? `${hold} hours`}${res.cadenceCreated ? "; a daily schedule was switched on" : ""}`
            : "Every draft now waits for your approval",
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not save");
      }
    });
  }

  return (
    <Card className="p-5" flush>
      <h3 className="text-[13px] font-medium mb-1">Publishing decision</h3>
      <p className="mb-4 text-[12.5px] leading-relaxed text-ink-3">
        Who decides that a draft ships. Either way a draft with an unsourced figure, a failing audit
        item or no active plan is held and says why on its row.
      </p>

      <div className="space-y-2">
        <label className="flex cursor-pointer items-start gap-3 rounded-md border border-line-soft p-3 text-[13px]">
          <input type="radio" name="approval-mode" className="mt-0.5" checked={!enabled} onChange={() => setEnabled(false)} />
          <span>
            <span className="font-medium text-ink">Review each draft</span>
            <span className="block text-[12.5px] text-ink-3">Nothing publishes until someone clicks Approve.</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-md border border-line-soft p-3 text-[13px]">
          <input type="radio" name="approval-mode" className="mt-0.5" checked={enabled} onChange={() => setEnabled(true)} />
          <span className="flex-1">
            <span className="font-medium text-ink">Publish automatically unless I hold it</span>
            <span className="block text-[12.5px] text-ink-3">
              You get the draft by email when it is written; it ships after the hold below unless you hold it,
              on the workspace&rsquo;s publishing schedule.
            </span>
            {enabled && (
              <span className="mt-3 block space-y-2 text-[12.5px]">
                <span className="flex items-center gap-2">
                  <span className="text-ink-3">Hold for</span>
                  <select
                    className="rounded border border-line bg-bg px-2 py-1 text-[12.5px]"
                    value={hold}
                    onChange={(e) => setHold(Number(e.target.value))}
                  >
                    {HOLD_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-ink-3">Require an SEO score of at least</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    className="w-16 rounded border border-line bg-bg px-2 py-1 font-mono text-[12.5px]"
                    value={minSeo}
                    onChange={(e) => setMinSeo(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                  />
                </span>
                {!hasCadence && (
                  <span className="block text-ink-3">
                    This workspace has no publishing schedule yet; saving switches on a daily one at 10:00.
                  </span>
                )}
                <span className="block text-ink-3">
                  Every article approved this way is recorded as approved by {setByName ? <strong className="text-ink">{setByName}</strong> : "you"}, under this rule.
                </span>
              </span>
            )}
          </span>
        </label>
      </div>

      <div className="mt-4 flex justify-end">
        <Button size="sm" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </Card>
  );
}

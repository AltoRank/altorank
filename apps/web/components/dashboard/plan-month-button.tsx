"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Icons } from "@/components/ui";
import { planMonth } from "@/app/actions/plan";
import { usePlanning } from "./planning-state";

/**
 * "Plan the month" for the active workspace. One server action, additive, so
 * the button is safe to press on a plan that already has entries.
 */
export function PlanMonthButton({ label = "Plan the month", size = "md" }: { label?: string; size?: "sm" | "md" }) {
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const router = useRouter();
  // So the calendar can draw the month it is about to have, instead of holding
  // its empty state until the whole page re-renders at once.
  const { setPlanning } = usePlanning();

  async function run() {
    setPending(true);
    setPlanning(true);
    setNote(null);
    try {
      const out = await planMonth();
      setNote(out.planned === 0 ? "Nothing new to plan: no keyword qualifies or the plan is full." : null);
      router.refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not plan.");
    } finally {
      setPending(false);
      setPlanning(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button size={size} variant="accent" onClick={run} disabled={pending}>
        <Icons.calendar size={13} />
        {pending ? "Planning…" : label}
      </Button>
      {note && <span className="text-[12px] text-ink-3">{note}</span>}
    </span>
  );
}

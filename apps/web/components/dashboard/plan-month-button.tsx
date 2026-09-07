"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Icons } from "@/components/ui";
import { planMonth } from "@/app/actions/plan";
import { usePlanning } from "./planning-state";

/**
 * "Schedule the month" for the active workspace. One server action, additive,
 * so the button is safe to press on a plan that already has entries.
 *
 * `title` is the sentence that says what the press will do. The button used to
 * explain itself nowhere, which is how the top-up label came to read like a
 * billing action; the caller knows the free-slot count, so it writes it.
 */
export function PlanMonthButton({
  label = "Schedule the month",
  size = "md",
  title,
}: {
  label?: string;
  size?: "sm" | "md";
  title?: string;
}) {
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
      <Button size={size} variant="accent" onClick={run} disabled={pending} title={title}>
        <Icons.calendar size={13} />
        {pending ? "Scheduling…" : label}
      </Button>
      {note && <span className="text-[12px] text-ink-3">{note}</span>}
    </span>
  );
}

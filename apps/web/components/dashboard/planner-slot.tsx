"use client";

// Swaps the month grid for its skeleton while a plan is being written, so the
// wait shows the thing being waited for. See planning-skeleton.tsx for why the
// dates can be drawn before the server answers.

import type { ReactNode } from "react";
import { usePlanning } from "./planning-state";
import { PlanningSkeleton } from "./planning-skeleton";

export function PlannerSlot({
  pace,
  occupied,
  children,
}: {
  pace: number;
  occupied: string[];
  children: ReactNode;
}) {
  const { planning } = usePlanning();
  return planning ? <PlanningSkeleton pace={pace} occupied={occupied} /> : <>{children}</>;
}

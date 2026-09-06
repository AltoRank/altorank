"use client";

// ---------------------------------------------------------------------------
// "Planning…" as a state the calendar can see, not just a button label
// ---------------------------------------------------------------------------
//
// The button lives in the page header and the grid lives in the body, so they
// are siblings: the button had no way to tell the calendar it was working, and
// the only feedback was its own label changing. This is the smallest thing that
// lets both read one boolean.
//
// Optional on purpose. `PlanMonthButton` is also rendered by the dashboard's
// recommended-actions strip, where there is no calendar to replace, and a
// missing provider there is correct rather than an error - so the hook returns
// a no-op setter when nothing is above it.

import { createContext, useContext, useState, type ReactNode } from "react";

interface PlanningState {
  planning: boolean;
  setPlanning: (v: boolean) => void;
}

const Ctx = createContext<PlanningState | null>(null);

export function PlanningProvider({ children }: { children: ReactNode }) {
  const [planning, setPlanning] = useState(false);
  return <Ctx.Provider value={{ planning, setPlanning }}>{children}</Ctx.Provider>;
}

/** Safe outside a provider: the setter is then a no-op and `planning` is false. */
export function usePlanning(): PlanningState {
  return useContext(Ctx) ?? { planning: false, setPlanning: () => {} };
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The dropdown version of "sign up a test account to see what customers see".
 *
 * Rendered only when the layout passes it in, which the layout does only in
 * development. Writes a plain (non-httpOnly) cookie that
 * `lib/dev/simulation.ts` reads server-side; production ignores the cookie
 * entirely, so there is no state to clean up before shipping.
 */
export function DevToolbar({
  simulation,
}: {
  simulation: { plan?: string; admin?: boolean } | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(Boolean(simulation));

  function apply(next: { plan?: string; admin?: boolean } | null) {
    if (next === null || (next.plan === undefined && next.admin === undefined)) {
      document.cookie = "dev_simulation=; path=/; max-age=0";
    } else {
      document.cookie = `dev_simulation=${encodeURIComponent(
        JSON.stringify(next),
      )}; path=/; max-age=86400`;
    }
    router.refresh();
  }

  const active = Boolean(simulation);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 left-5 z-[70] h-7 px-2.5 rounded-full border border-line bg-panel font-mono text-[10.5px] text-ink-3 hover:text-ink"
        aria-label="Open the view simulator"
      >
        dev
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 left-5 z-[70] rounded-[10px] border border-line bg-bg p-3 shadow-lg w-[240px]">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
          Simulate a viewer
        </span>
        <button
          onClick={() => setOpen(false)}
          className="text-[11px] text-ink-3 hover:text-ink"
        >
          hide
        </button>
      </div>

      <label className="mb-2 flex items-center justify-between gap-2 text-[12px] text-ink-2">
        Plan
        <select
          value={simulation?.plan ?? ""}
          onChange={(e) =>
            apply({ ...simulation, plan: e.target.value || undefined })
          }
          className="rounded-[6px] border border-line bg-panel px-1.5 py-1 text-[12px]"
        >
          <option value="">real (from DB)</option>
          <option value="starter">Managed €69</option>
          <option value="growth">Agency €199</option>
          <option value="scale">Custom</option>
        </select>
      </label>

      <label className="mb-2 flex items-center justify-between gap-2 text-[12px] text-ink-2">
        Operator nav
        <select
          value={simulation?.admin === false ? "off" : ""}
          onChange={(e) =>
            apply({
              ...simulation,
              admin: e.target.value === "off" ? false : undefined,
            })
          }
          className="rounded-[6px] border border-line bg-panel px-1.5 py-1 text-[12px]"
        >
          <option value="">real (your email)</option>
          <option value="off">hide, like a customer</option>
        </select>
      </label>

      {/* "admin: on" is deliberately not offered. The nav is presentation and
          could pretend, but the Operations page re-checks the real email, so
          the simulation would 404 and read as a bug. */}

      {active && (
        <button
          onClick={() => apply(null)}
          className="w-full rounded-[6px] border border-line px-2 py-1 text-[11.5px] text-ink-2 hover:bg-panel-2"
        >
          Back to reality
        </button>
      )}
    </div>
  );
}

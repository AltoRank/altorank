"use client";

import { useEffect, useState } from "react";

/**
 * A thin bar for work whose length is estimated, not known. It eases between
 * values (the estimates it is fed only grow: lib/onboarding/setup-progress.ts),
 * and while `busy` a soft sheen runs along the filled part so the screen
 * visibly moves even in a stretch where nothing new has landed. Reduced
 * motion: no easing, no sheen.
 */
export function ProgressBar({ fraction, busy = true, label }: { fraction: number; busy?: boolean; label: string }) {
  const value = Math.min(1, Math.max(0, fraction));
  const pct = Math.round(value * 1000) / 10;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-panel-2"
    >
      <div
        className="absolute inset-y-0 left-0 overflow-hidden rounded-full bg-accent motion-safe:transition-[width] motion-safe:duration-700 motion-safe:ease-out"
        style={{ width: `${pct}%` }}
      >
        {busy && value < 1 && (
          <div className="bar-shimmer absolute inset-y-0 left-0 w-2/5 bg-gradient-to-r from-transparent via-white/45 to-transparent" aria-hidden />
        )}
      </div>
    </div>
  );
}

/** The time now, refreshed every `ms` while `active`. Null on the server's render. */
export function useNow(ms: number, active: boolean): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // The first value lands a tick after mount: the server's render has no
    // clock of its own to agree with.
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const every = active ? setInterval(tick, ms) : undefined;
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [ms, active]);
  return now;
}

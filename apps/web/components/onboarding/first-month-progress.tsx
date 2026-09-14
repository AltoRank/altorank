"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function FirstMonthProgress({ active, canRetry }: { active: boolean; canRetry: boolean }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!active) return;
    const tick = () => { router.refresh(); };
    const timer = setInterval(tick, 15000);
    return () => clearInterval(timer);
  }, [active, router]);
  return <>
    {active && <p className="mt-3 text-sm text-ink-2" role="status">Preparing your articles in the background. You can review your first draft or leave and come back.</p>}
    {canRetry && <button type="button" disabled={busy} className="mt-3 text-sm text-accent underline" onClick={async () => {
      setBusy(true); setMessage(null);
      try {
        const response = await fetch("/api/onboard/prepare-month", { method: "POST" });
        if (!response.ok) throw new Error("Preparation could not restart. Check your plan and writing pace, then try again.");
        router.refresh();
      } catch (error) { setMessage(error instanceof Error ? error.message : "Please try again."); }
      finally { setBusy(false); }
    }}>{busy ? "Restarting…" : "Retry remaining preparation"}</button>}
    {message && <p role="alert" className="mt-2 text-sm text-err-ink">{message}</p>}
  </>;
}

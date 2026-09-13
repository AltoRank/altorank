"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { checkoutDestination } from "@/lib/billing/checkout-return";

export function CheckoutActivation({ sessionId, destination }: { sessionId: string; destination: string }) {
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState("Confirming your checkout and activating your account…");
  const [waiting, setWaiting] = useState(true);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    async function poll() {
      try {
        const response = await fetch(`/api/billing/checkout-status?session_id=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
        const result = await response.json();
        if (stopped) return;
        if (!response.ok) throw new Error(result.error ?? "Activation could not be checked.");
        if (result.active) { window.location.replace(checkoutDestination(destination)); return; }
        if (result.status === "expired" || result.status === "open") { setMessage("Checkout has not completed. Return to your saved draft and trial options."); setWaiting(false); return; }
        setMessage("Checkout is complete. We’re waiting for payment confirmation to activate your account. You do not need to pay again.");
      } catch (error) {
        if (stopped) return;
        setMessage(error instanceof Error ? error.message : "Activation could not be checked.");
      }
      if (Date.now() - started < 90_000) timer = setTimeout(poll, 2500);
      else { setWaiting(false); setMessage("Activation is taking longer than expected. Check again in a moment; do not start another payment."); }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [attempt, sessionId, destination]);
  return <main className="mx-auto max-w-xl px-6 py-16">
    <h1 className="mb-4 text-2xl font-semibold">Activating your account</h1>
    <p role="status" className="mb-6">{message}</p>
    {!waiting && <button className="mr-5 text-accent underline" onClick={() => { setWaiting(true); setAttempt((a) => a + 1); }}>Check activation again</button>}
    <Link className="text-accent underline" href="/onboarding">View saved draft</Link>
  </main>;
}

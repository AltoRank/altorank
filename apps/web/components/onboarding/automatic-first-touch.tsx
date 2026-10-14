"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { prepareAutomaticFirstLook, clarifyFirstLookOffering, completeWizard } from "@/app/actions/onboarding-wizard";
import type { InferenceResult } from "@/lib/onboarding/business-profile";

export function AutomaticFirstTouch({ workspaceId, domain, onReady }: { workspaceId: string; domain: string; onReady: () => void }) {
  const request = useRef<Promise<InferenceResult> | null>(null);
  const correctionRequested = useRef(false);
  const [preparing, setPreparing] = useState(true);
  const [correcting, setCorrecting] = useState(false);
  const [clarifying, setClarifying] = useState(false);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    let cancelled = false;
    // Reuse the in-flight action across React's development effect replay.
    request.current ??= prepareAutomaticFirstLook(workspaceId);
    void request.current.then(async (result) => {
      if (cancelled) return;
      if (correctionRequested.current) return;
      if (!result.profile?.offerings?.length || !result.profile.description?.trim()) {
        setClarifying(result.reason !== "needs_plan" && result.reason !== "no_model");
        if (result.reason === "needs_plan" || result.reason === "no_model") setError(result.message ?? "Site research is not configured on this install.");
        return;
      }
      await completeWizard(workspaceId);
      if (!cancelled && !correctionRequested.current) onReady();
    }).catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : "We could not finish reading the site."); })
      .finally(() => { if (!cancelled) setPreparing(false); });
    return () => { cancelled = true; };
  }, [workspaceId, onReady]);

  function clarify() {
    setError(null);
    start(async () => {
      try {
        await clarifyFirstLookOffering(workspaceId, answer);
        await completeWizard(workspaceId);
        onReady();
      } catch (err) { setError(err instanceof Error ? err.message : "Could not save your answer."); }
    });
  }
  return (
    <main className="grid min-h-screen place-items-center bg-bg px-6 py-12">
      <div className="w-full max-w-[560px]">
        <p className="text-[12px] text-ink-3">Your first article · {domain}</p>
        <h1 className="text-[26px] font-semibold leading-tight">{clarifying ? "One detail will help us choose well" : "Your website is our starting point"}</h1>
        {clarifying ? (
          <form onSubmit={(e) => { e.preventDefault(); clarify(); }} className="mt-6 rounded-xl border border-line bg-panel p-5">
            <label htmlFor="first-offering" className="block text-sm font-medium">What is the main service or product you want customers to buy?</label>
            <p id="offering-help" className="text-[13px] leading-relaxed text-ink-2">{correcting ? "Tell us what to focus on." : "We could not identify it clearly from your site."} A short answer is enough; we will check it against the site before choosing a topic.</p>
            <input id="first-offering" aria-describedby="offering-help" value={answer} onChange={(e) => setAnswer(e.target.value)} minLength={3} maxLength={200} required className="mt-3 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm" />
            <Button type="submit" variant="accent" disabled={preparing || pending || answer.trim().length < 3} className="mt-4">{preparing ? "Finishing the site read…" : pending ? "Saving…" : "Prepare my article"}</Button>
          </form>
        ) : (
          <div role="status" className="mt-6 rounded-xl border border-line bg-panel p-5">
            {!error && <span className="mb-3 block h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />}
            <p className="m-0 text-sm leading-relaxed text-ink-2">We are reading what you offer and who you serve. Then we will check buyer questions and search results to choose your first article.</p>
            <p className="mb-0 mt-3 text-xs text-ink-3">No keyword list or competitor research needed from you. Google Search Console is optional.</p>
          </div>
        )}
        {!clarifying && !error && <button type="button" className="mt-4 text-[13px] text-ink-2 underline underline-offset-4" onClick={() => { correctionRequested.current = true; setCorrecting(true); setClarifying(true); }}>Correct what you offer</button>}
        {error && <div role="alert" className="mt-4 text-sm text-err-ink">{error}<p><button type="button" className="underline" onClick={() => window.location.reload()}>Reload setup</button></p></div>}
      </div>
    </main>
  );
}

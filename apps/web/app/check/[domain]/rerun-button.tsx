"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-runs the check for this domain, bypassing the six-hour cache. Counts
 * against the same per-IP limit as a fresh check, so a shared page cannot be
 * used to hammer the site it describes.
 */
export function RerunButton({ domain }: { domain: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "running" | "error">("idle");
  const [message, setMessage] = useState("");

  async function rerun() {
    setState("running");
    setMessage("");
    try {
      const res = await fetch("/api/public/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, force: true }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setState("error");
        setMessage(body.error ?? "Could not re-run the check.");
        return;
      }
      setState("idle");
      router.refresh();
    } catch {
      setState("error");
      setMessage("Could not reach the server.");
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={rerun}
        disabled={state === "running"}
        className="inline-flex h-9 items-center rounded-md border border-line bg-bg px-3.5 text-[13px] font-medium text-ink hover:bg-panel disabled:cursor-wait disabled:opacity-60"
      >
        {state === "running" ? "Reading the site…" : "Re-run"}
      </button>
      {message && <p className="m-0 text-[12px] text-err-ink">{message}</p>}
    </div>
  );
}

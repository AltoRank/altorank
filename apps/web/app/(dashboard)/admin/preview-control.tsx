"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { PREVIEW_COOKIE } from "@/lib/auth/preview-cookie";

/**
 * Starts the customer preview.
 *
 * Lives on Operations rather than in the sidebar because this page is already
 * operator-only, so the control cannot be discovered - or half-rendered - for
 * anyone else. Exiting is the banner's job, since once the preview is on you
 * are looking at a nav that no longer has Operations in it.
 *
 * The cookie is written from the client on purpose. A server action would be
 * refused by the very middleware rule this turns on, and a mode you can enter
 * but not leave without clearing cookies by hand is a trap.
 */

const PLANS = [
  { value: "", label: "No plan", hint: "What someone sees before they buy" },
  { value: "starter", label: "Managed", hint: "€69 · 100 articles included" },
  { value: "growth", label: "Agency", hint: "€199 · 400 articles included" },
] as const;

export function PreviewControl({ active }: { active: boolean }) {
  const router = useRouter();
  const [plan, setPlan] = useState<string>("");
  const [pending, start] = useTransition();

  function enter() {
    const value = plan ? JSON.stringify({ plan }) : JSON.stringify({});
    document.cookie = `${PREVIEW_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=86400`;
    start(() => router.refresh());
  }

  return (
    <div className="p-[18px]">
      <p className="m-0 max-w-[72ch] text-[12.5px] leading-relaxed text-ink-2">
        Look at your own account with the operator bypasses switched off: no
        Operations entry, quota and plan gates applied as a customer&rsquo;s
        would be. <b className="font-medium text-ink">Every write is refused</b>{" "}
        while the preview is on, at the edge rather than by hiding buttons, so
        it is safe to click anything. Nothing is impersonated and no other
        account is touched.
      </p>

      <div className="mt-3.5 flex flex-wrap items-end gap-2">
        <div className="flex rounded-[7px] border border-line p-0.5 text-[12px]">
          {PLANS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPlan(p.value)}
              title={p.hint}
              className={cn(
                "cursor-pointer rounded-[5px] px-2.5 py-1",
                plan === p.value ? "bg-ink text-bg" : "text-ink-3 hover:text-ink",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        <Button variant="accent" onClick={enter} disabled={pending || active}>
          {active ? "Preview already on" : pending ? "Starting…" : "Start preview"}
        </Button>
      </div>

      <p className="m-0 mt-2.5 text-[11.5px] text-ink-3">
        Ends when you press Exit in the banner, or on its own after 24 hours.
      </p>
    </div>
  );
}

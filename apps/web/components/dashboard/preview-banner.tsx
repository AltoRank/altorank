"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Icons } from "@/components/ui";
import { PREVIEW_COOKIE } from "@/lib/auth/preview-cookie";

/**
 * The bar that says you are not seeing your own privileges.
 *
 * Modelled on the impersonation banner for the same reason it exists: a mode
 * that quietly changes what the product will let you do has to announce
 * itself, or the next confusing thing you hit gets filed as a bug. This one
 * additionally has to explain why a button did nothing, because in preview
 * every write is refused at the edge.
 *
 * Always rendered above the app, never dismissible - dismissing the notice
 * while leaving the mode on is how you end up debugging a phantom.
 */
export function PreviewBanner({ plan }: { plan?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function exit() {
    // Same-site cookie removal; the mode is a client-set cookie by design, so
    // leaving it is never blocked by the very read-only rule it turns on. A
    // server action here would be refused by our own middleware.
    document.cookie = `${PREVIEW_COOKIE}=; path=/; max-age=0`;
    start(() => router.refresh());
  }

  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-warn bg-warn-soft px-4 text-[12.5px] text-warn-ink">
      <Icons.eye size={14} className="shrink-0" />
      <span className="truncate">
        Previewing as a customer{plan ? <> on the <b className="font-semibold">{plan}</b> plan</> : <> with no plan</>}.
        Operator tools are hidden and <b className="font-semibold">every write is blocked</b> — nothing you click here can change data.
      </span>
      <button
        onClick={exit}
        disabled={pending}
        className="ml-auto shrink-0 rounded-[6px] border border-warn bg-bg px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-panel"
      >
        {pending ? "Exiting…" : "Exit preview"}
      </button>
    </div>
  );
}

"use client";

// ---------------------------------------------------------------------------
// Stripe's Embedded Checkout, on our own page
// ---------------------------------------------------------------------------
//
// The trial used to send the person to checkout.stripe.com, away from the
// first article they had just read. Embedded Checkout is the same Checkout
// Session (same reservation, same trial, same tax, same webhook) with
// `ui_mode: "embedded_page"`: Stripe renders its form in an iframe we mount,
// wallets included, and comes back through the same /checkout/complete page.
//
// Without a publishable key (self-host, a deploy that has not set one) the
// button falls back to the hosted redirect it always used.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadStripe, type Stripe, type StripeEmbeddedCheckout } from "@stripe/stripe-js";
import { createEmbeddedCheckout } from "@/app/actions/billing";
import { Icons } from "@/components/ui";
import type { BillingInterval, SelfServePlan } from "@/lib/stripe";

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";

/** Whether this deploy can show Stripe's form on the page instead of redirecting. */
export const embeddedCheckoutAvailable = PUBLISHABLE_KEY !== "";

let stripePromise: Promise<Stripe | null> | null = null;
function stripe(): Promise<Stripe | null> {
  stripePromise ??= loadStripe(PUBLISHABLE_KEY);
  return stripePromise;
}

// Stripe allows one Embedded Checkout on a page at a time: a second
// `createEmbeddedCheckoutPage` before the first is destroyed throws. The plan
// or interval changing under an open form is exactly that, so the instance
// on screen is kept here and destroyed before the next one is made.
let current: StripeEmbeddedCheckout | null = null;

/**
 * Stripe's checkout form for one plan and interval, mounted where it is
 * rendered. Remount it (a new `key`) to change the plan: a session's price is
 * fixed once it is created.
 */
export function EmbeddedCheckoutForm({
  plan,
  interval,
  returnTo,
  onError,
}: {
  plan: SelfServePlan;
  interval: BillingInterval;
  returnTo?: string;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  // The latest handler, without making it a reason to rebuild the form.
  const report = useRef(onError);
  useEffect(() => {
    report.current = onError;
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    let mine: StripeEmbeddedCheckout | null = null;
    (async () => {
      try {
        const s = await stripe();
        if (!s) throw new Error("Stripe could not be loaded.");
        if (current) {
          current.destroy();
          current = null;
        }
        if (cancelled) return;
        mine = await s.createEmbeddedCheckoutPage({
          fetchClientSecret: async () => {
            const result = await createEmbeddedCheckout(plan, interval, returnTo);
            if (!result.ok) throw new Error(result.error);
            // A plan switch, or a session already paid: nothing to fill in here.
            if ("url" in result) {
              window.location.href = result.url;
              throw new Error("Redirecting");
            }
            return result.clientSecret;
          },
        });
        if (cancelled) {
          mine.destroy();
          return;
        }
        current = mine;
        if (host.current) mine.mount(host.current);
        setReady(true);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error && e.message !== "Redirecting" ? e.message : null;
        if (message) report.current(message.startsWith("Stripe") || message.endsWith(".") ? message : "Checkout could not be opened. Nothing was charged; try again.");
      }
    })();
    return () => {
      cancelled = true;
      if (mine) {
        mine.destroy();
        if (current === mine) current = null;
      }
    };
  }, [plan, interval, returnTo]);

  return (
    <div className="relative min-h-[420px]">
      {!ready && (
        <div className="absolute inset-0 flex items-start justify-center pt-16 text-[12.5px] text-ink-3" role="status">
          <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden />
          Opening the secure checkout…
        </div>
      )}
      <div ref={host} data-testid="embedded-checkout" />
    </div>
  );
}

/**
 * The checkout in a sheet over the page: from the bottom on a phone, from the
 * right on a wider screen, so the article stays visible behind it. Escape,
 * the backdrop and the close button all leave without paying anything.
 */
export function CheckoutSheet({
  open,
  onClose,
  title,
  lede,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  lede?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  // Opened only by a click, so only ever in the browser.
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="theme-light fixed inset-0 z-[300]">
      <button type="button" aria-label="Close checkout" className="absolute inset-0 h-full w-full cursor-default bg-black/30" onClick={onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="absolute inset-x-0 bottom-0 flex max-h-[92vh] flex-col rounded-t-2xl border-t border-line bg-bg shadow-xl sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-full sm:max-w-[480px] sm:rounded-none sm:border-l sm:border-t-0"
      >
        <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-line sm:hidden" aria-hidden />
        <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-3 sm:pt-5">
          <div className="min-w-0">
            <h2 className="m-0 text-[16px] font-semibold leading-snug text-ink">{title}</h2>
            {lede && <p className="m-0 mt-1 text-[12.5px] leading-[1.5] text-ink-2">{lede}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 -mt-1 grid h-11 w-11 shrink-0 place-items-center rounded-[7px] text-ink-2 hover:bg-panel-2 hover:text-ink"
          >
            <Icons.x size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

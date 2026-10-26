// /checkout/cancelled, where Stripe's back link lands. For an account whose
// gate is not open it used to say "Your first article and plan are saved",
// tell the owner to "close it to choose another plan", and offer two
// look-alike underlined controls that both went to the gate. It recorded
// checkout_cancelled for anyone who reached it, including from the "Manage
// open checkout" link under a checkout error, which is not a back-out.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const state = vi.hoisted(() => ({
  role: "owner" as string,
  gate: "gated" as "open" | "gated" | "bypassed",
  scope: "ws-1" as string | null,
  title: "How to price a website redesign" as string | null,
}));

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: async () => ({ accountId: "acc-1", role: state.role, user: { id: "u-1", email: "owner@example.org" } }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/billing/body-lock", () => ({ accountTrialGate: async () => state.gate }));
vi.mock("@/lib/workspace-scope", () => ({ getScopedWorkspaceId: async () => state.scope }));
const titleRead = vi.hoisted(() => vi.fn(async (_db: unknown, _ws: string) => state.title));
vi.mock("@/lib/onboarding/first-article", () => ({ firstArticleTitle: (db: unknown, ws: string) => titleRead(db, ws) }));
vi.mock("@/components/onboarding/track-step", () => ({ TrackStep: ({ step }: { step: string }) => `[step ${step}]` }));
vi.mock("@/components/billing/close-checkout-form", () => ({
  CloseCheckoutForm: ({ next, label, look = "button" }: { next: string; label: string; look?: string }) => `[form ${look} ${next} "${label}"]`,
}));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: unknown }) => `[link ${href} "${children as string}"]` }));

import CheckoutCancelled from "../page";

async function render(params: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await CheckoutCancelled({ searchParams: Promise.resolve(params) }));
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

beforeEach(() => {
  state.role = "owner";
  state.gate = "gated";
  state.scope = "ws-1";
  state.title = "How to price a website redesign";
  titleRead.mockClear();
});

describe("/checkout/cancelled from Stripe's back link, before the trial", () => {
  it("says the owner left checkout and the article is still here, with one way back to it", async () => {
    const page = text(await render({ next: "/content/a1", from: "stripe" }));
    expect(page).toContain("You left checkout.");
    expect(page).toContain("Nothing was charged. Your article is still here.");
    expect(page).toContain("Your first article How to price a website redesign");
    expect(page).toContain('[form button /onboarding?status=cancelled "Back to my article"]');
    expect(page).toContain("[step checkout_cancelled]");
    expect(titleRead).toHaveBeenCalledWith({}, "ws-1");
    // One control, and none of the old copy.
    expect(page.match(/\[(form|link) /g)).toHaveLength(1);
    expect(page).not.toMatch(/choose another plan|Back to trial options|first article and plan are saved|Cancel checkout and return/);
  });

  it("is the same for an address that bypasses the gate, so the team can walk it", async () => {
    state.gate = "bypassed";
    const page = text(await render({ from: "stripe" }));
    expect(page).toContain("Nothing was charged. Your article is still here.");
    expect(page).toContain('[form button /onboarding?status=cancelled "Back to my article"]');
    expect(page).toContain("[step checkout_cancelled]");
  });

  it("gives a member, who cannot close the checkout, a single link back to the article", async () => {
    state.role = "editor";
    const page = text(await render({ from: "stripe" }));
    expect(page).toContain('[link /onboarding?status=cancelled "Back to my article"]');
    expect(page).not.toContain("[form");
    expect(page.match(/\[(form|link) /g)).toHaveLength(1);
  });

  it("promises no article when none is written yet", async () => {
    state.title = null;
    const page = text(await render({ from: "stripe" }));
    expect(page).toContain("You left checkout.");
    expect(page).not.toMatch(/still here|my article|Your first article/);
    expect(page).toContain('[form button /onboarding?status=cancelled "Go back"]');
  });

  it("reads no title when there is no site in scope", async () => {
    state.scope = null;
    const page = text(await render({ from: "stripe" }));
    expect(titleRead).not.toHaveBeenCalled();
    expect(page).toContain('"Go back"');
  });
});

describe("/checkout/cancelled from anywhere else, before the trial", () => {
  it("records nothing, says nobody left checkout, and goes back to the gate without its notice", async () => {
    const page = text(await render());
    expect(page).not.toContain("[step");
    expect(page).not.toContain("You left checkout");
    expect(page).toContain("Nothing was charged.");
    expect(page).toContain("Going back closes any checkout that is still open, so you can start the trial again from your article.");
    expect(page).toContain('[form button /onboarding "Back to my article"]');
  });

  it("treats a marker that is not Stripe's as no marker", async () => {
    const page = text(await render({ from: "email" }));
    expect(page).not.toContain("[step");
    expect(page).toContain('[form button /onboarding "Back to my article"]');
  });
});

describe("/checkout/cancelled after a Billing purchase", () => {
  it("keeps today's Billing copy and controls, and records nothing, with or without the marker", async () => {
    state.gate = "open";
    for (const from of [{ from: "stripe" }, {}] as Record<string, string>[]) {
      const page = text(await render({ next: "/connect/google", ...from }));
      expect(page).toContain("Checkout was cancelled");
      expect(page).toContain("Close it to choose a different plan or billing interval on Billing.");
      expect(page).toContain('[form link /settings/billing?return=%2Fconnect%2Fgoogle "Cancel checkout and return"]');
      expect(page).toContain('[link /settings/billing?return=%2Fconnect%2Fgoogle "Back to Billing"]');
      expect(page).not.toContain("[step");
      expect(page).not.toContain("my article");
    }
    expect(titleRead).not.toHaveBeenCalled();
  });
});

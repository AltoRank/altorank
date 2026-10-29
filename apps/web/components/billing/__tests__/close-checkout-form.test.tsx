import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The cancel page's one control for an owner before the trial. When the
// close was refused (Stripe down, the attempt row would not clear) it showed
// the reason and nothing else, so the owner was stuck on /checkout/cancelled
// with no way back to their article (reassessment, 2026-10-28).

const action = vi.hoisted(() => ({ state: null as { error: string } | null }));
// No jsdom in this repo: the action's answer is handed straight to the render.
vi.mock("react", async (real) => ({ ...(await real<typeof import("react")>()), useActionState: () => [action.state, () => undefined, false] }));
vi.mock("@/app/actions/cancel-checkout", () => ({ cancelPendingCheckout: async () => null }));
vi.mock("@/components/ui", () => ({ Button: ({ children }: { children: unknown }) => <button>{children as string}</button> }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: unknown }) => <a href={href}>{children as string}</a> }));

import { CloseCheckoutForm } from "../close-checkout-form";

const render = (props: Parameters<typeof CloseCheckoutForm>[0]) => renderToStaticMarkup(<CloseCheckoutForm {...props} />);

beforeEach(() => {
  action.state = null;
});

describe("CloseCheckoutForm", () => {
  it("offers only the close before anything is refused", () => {
    const html = render({ next: "/onboarding?status=cancelled", label: "Back to my article", leave: "Go to my article without closing it" });
    expect(html).toContain("Back to my article");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain('role="alert"');
  });

  it("keeps a plain way back to the article beside a refused close", () => {
    action.state = { error: "Checkout could not be closed. Nothing was charged. Try again in a moment." };
    const html = render({ next: "/onboarding?status=cancelled", label: "Back to my article", leave: "Go to my article without closing it" });
    expect(html).toContain("Checkout could not be closed.");
    expect(html).toContain('<a href="/onboarding?status=cancelled">Go to my article without closing it</a>');
  });

  it("adds no link where the page already has one (Billing)", () => {
    action.state = { error: "Checkout could not be closed." };
    expect(render({ next: "/settings/billing", label: "Cancel checkout and return", look: "link" })).not.toContain("<a ");
  });
});

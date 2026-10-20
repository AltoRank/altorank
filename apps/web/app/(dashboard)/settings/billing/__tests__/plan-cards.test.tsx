import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// A plan card on Billing that opens the trial is a trial button too
// (onboarding.step trial_clicked{surface: billing}). It always opens Stripe's
// own page through createCheckoutSession, whatever the publishable key says,
// so its click says "hosted" itself. No jsdom in this repo, so the card's
// button is reached through the props it hands Button.

const buttons = vi.hoisted(() => [] as { label: string; onClick?: () => void }[]);
const track = vi.hoisted(() => vi.fn());
vi.mock("@/lib/onboarding/track-step", () => ({ trackStep: (...a: unknown[]) => track(...a) }));
vi.mock("@/components/ui", () => ({
  Button: (props: { onClick?: () => void; children: unknown }) => {
    buttons.push({ label: String(props.children), onClick: props.onClick });
    return <button>{props.children as string}</button>;
  },
  Icons: { check: () => null },
}));
vi.mock("sonner", () => ({ toast: { error: () => undefined } }));
// A transition cannot start in a server render; here it simply runs.
vi.mock("react", async (real) => ({ ...(await real<typeof import("react")>()), useTransition: () => [false, (fn: () => void) => fn()] }));
const checkout = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ ok: false, error: "Checkout could not be opened." })));
vi.mock("@/app/actions/billing", () => ({
  createCheckoutSession: (...a: unknown[]) => checkout(...a),
  createBillingPortalSession: async () => ({ ok: false, error: "no" }),
}));

import { PlanCards, type PlanCard } from "../plan-cards";

const PLANS: PlanCard[] = [
  { tier: "starter", label: "Managed", monthly: "€69", yearly: "€690", tagline: "", features: [] },
  { tier: "growth", label: "Agency", monthly: "€199", yearly: "€1,990", tagline: "", features: [] },
];

function press(label: string, props: Partial<Parameters<typeof PlanCards>[0]> = {}) {
  renderToStaticMarkup(<PlanCards plans={PLANS} currentTier={null} isActive={false} hasCustomer={false} {...props} />);
  const button = buttons.find((b) => b.label === label);
  if (!button?.onClick) throw new Error(`no button "${label}" in ${buttons.map((b) => b.label).join(", ")}`);
  button.onClick();
}

beforeEach(() => {
  buttons.length = 0;
  track.mockClear();
  checkout.mockClear();
});

describe("Billing's plan cards as a trial button", () => {
  it("say the trial click opened Stripe's own page", () => {
    press("Try Agency free for 7 days", { trialEligible: true });
    expect(track).toHaveBeenCalledWith("trial_clicked", { props: { surface: "billing", plan: "growth", interval: "month", checkout: "hosted" } });
    expect(checkout).toHaveBeenCalledWith("growth", "month", undefined);
  });

  it("say a trial checkout that could not be opened failed on Stripe's own page", async () => {
    press("Try Managed free for 7 days", { trialEligible: true });
    await vi.waitFor(() => expect(track).toHaveBeenCalledWith("checkout_failed", { props: { stage: "create", surface: "billing", viewport: undefined, checkout: "hosted" } }));
  });

  it("record nothing for a plain purchase, after the trial was used", async () => {
    press("Choose Managed");
    await vi.waitFor(() => expect(checkout).toHaveBeenCalled());
    expect(track).not.toHaveBeenCalled();
  });
});

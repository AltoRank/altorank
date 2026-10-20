import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// What the trial button records after it is pressed (onboarding.step). A
// click that died inside Embedded Checkout left nothing on our side to say
// why: which button, whether the form was closed, or whether it never
// opened. No jsdom in this repo, so the button's own handlers are reached
// through the props it hands its parts.

const parts = vi.hoisted(() => ({
  button: null as null | { onClick: (e: unknown) => void },
  sheet: null as null | { onClose: (how: string) => void; children: ReactElement<{ onError: (m: string, stage: string) => void; onSession?: (id: string) => void }> },
  embedded: true,
}));
const track = vi.hoisted(() => vi.fn());
vi.mock("@/lib/onboarding/track-step", () => ({ trackStep: (...a: unknown[]) => track(...a) }));
vi.mock("@/components/ui", () => ({
  Button: (props: { onClick: (e: unknown) => void; children: unknown }) => {
    parts.button = props;
    return <button>{props.children as string}</button>;
  },
}));
vi.mock("sonner", () => ({ toast: { error: () => undefined } }));
// A transition cannot start in a server render; here it simply runs.
vi.mock("react", async (real) => ({ ...(await real<typeof import("react")>()), useTransition: () => [false, (fn: () => void) => fn()] }));
const checkout = vi.hoisted(() => vi.fn(async () => ({ ok: false, error: "Checkout could not be opened." })));
vi.mock("@/app/actions/billing", () => ({ createCheckoutSession: (...a: unknown[]) => checkout(...(a as [])) }));
vi.mock("../embedded-checkout", () => ({
  get embeddedCheckoutAvailable() {
    return parts.embedded;
  },
  EmbeddedCheckoutForm: () => null,
  CheckoutSheet: (props: NonNullable<typeof parts.sheet>) => {
    parts.sheet = props;
    return null;
  },
}));

import { StartTrialButton } from "../start-trial-button";

const S = "cs_test_a1B2c3D4e5F6g7H8i9J0";

beforeEach(() => {
  track.mockClear();
  parts.button = null;
  parts.sheet = null;
  parts.embedded = true;
});

describe("StartTrialButton's onboarding steps", () => {
  it("says which button was pressed, on which plan and interval", () => {
    renderToStaticMarkup(<StartTrialButton surface="sticky_bar" plan="growth" interval="year" />);
    parts.button!.onClick({ currentTarget: null });
    expect(track).toHaveBeenCalledWith("trial_clicked", { props: { surface: "sticky_bar", plan: "growth", interval: "year", checkout: "embedded" } });
  });

  it("says how the sheet was left, with the session it was on", () => {
    renderToStaticMarkup(<StartTrialButton surface="quiet_box" />);
    parts.button!.onClick({ currentTarget: null });
    parts.sheet!.children.props.onSession?.(S);
    parts.sheet!.onClose("backdrop");
    expect(track).toHaveBeenLastCalledWith("checkout_closed", { checkoutSession: S, props: { how: "backdrop", surface: "quiet_box", viewport: undefined } });
  });

  it("says a form closed before Stripe gave it a session, without one", () => {
    renderToStaticMarkup(<StartTrialButton surface="price_box" />);
    parts.button!.onClick({ currentTarget: null });
    parts.sheet!.onClose("escape");
    expect(track).toHaveBeenLastCalledWith("checkout_closed", { checkoutSession: undefined, props: { how: "escape", surface: "price_box", viewport: undefined } });
  });

  it("says where a form that never opened stopped", () => {
    renderToStaticMarkup(<StartTrialButton surface="articles" />);
    parts.sheet!.children.props.onError("Stripe could not be loaded.", "load");
    expect(track).toHaveBeenCalledWith("checkout_failed", { checkoutSession: undefined, props: { stage: "load", surface: "articles", viewport: undefined, checkout: "embedded" } });
  });

  it("says a hosted checkout that could not be created failed at create", async () => {
    parts.embedded = false;
    renderToStaticMarkup(<StartTrialButton surface="price_box" />);
    parts.button!.onClick({ currentTarget: null });
    await vi.waitFor(() => expect(track).toHaveBeenCalledWith("checkout_failed", { checkoutSession: undefined, props: { stage: "create", surface: "price_box", viewport: undefined, checkout: "hosted" } }));
    expect(track).toHaveBeenCalledWith("trial_clicked", { props: { surface: "price_box", plan: "starter", interval: "month", checkout: "hosted" } });
  });

  it("says the press opened Stripe's form on the page when there is a key, and Stripe's own page when there is not", () => {
    renderToStaticMarkup(<StartTrialButton surface="quiet_box" />);
    parts.button!.onClick({ currentTarget: null });
    expect(track).toHaveBeenLastCalledWith("trial_clicked", { props: { surface: "quiet_box", plan: "starter", interval: "month", checkout: "embedded" } });

    parts.embedded = false;
    renderToStaticMarkup(<StartTrialButton surface="quiet_box" />);
    parts.button!.onClick({ currentTarget: null });
    expect(track).toHaveBeenCalledWith("trial_clicked", { props: { surface: "quiet_box", plan: "starter", interval: "month", checkout: "hosted" } });
  });

  it("records nothing for a button that does not say which it is", () => {
    renderToStaticMarkup(<StartTrialButton />);
    parts.button!.onClick({ currentTarget: null });
    parts.sheet!.onClose("close");
    expect(track).not.toHaveBeenCalled();
  });
});

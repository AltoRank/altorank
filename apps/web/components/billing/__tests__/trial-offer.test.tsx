import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The pricing page's Agency card says "7-day free trial, then €199", and the
// trial screen could only start Managed: Agency was "a click away on
// Billing", a page an account behind the trial gate is redirected away from.

const { buttons, screen } = vi.hoisted(() => ({ buttons: [] as Array<Record<string, unknown>>, screen: { wide: null as boolean | null } }));
vi.mock("../start-trial-button", () => ({
  StartTrialButton: (props: Record<string, unknown>) => {
    buttons.push(props);
    return <button>Start 7-day trial</button>;
  },
}));
// The real hook unless a test says how wide the screen is: on the server it
// answers false, as every first paint does.
vi.mock("@/lib/hooks/use-media-query", async (real) => {
  const actual = await real<typeof import("@/lib/hooks/use-media-query")>();
  return { useMediaQuery: (query: string) => screen.wide ?? actual.useMediaQuery(query) };
});

import { INLINE_CHECKOUT_QUERY, TrialOffer, TrialPriceBox } from "../trial-offer";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("TrialOffer", () => {
  it("offers both hosted plans", () => {
    const html = text(renderToStaticMarkup(<TrialOffer />));
    expect(html).toContain("Managed");
    expect(html).toContain("Agency");
  });

  it("opens Managed by default, at the Managed price", () => {
    buttons.length = 0;
    const html = text(renderToStaticMarkup(<TrialOffer />));
    expect(buttons[0]).toMatchObject({ plan: "starter", interval: "month" });
    expect(html).toContain("then Managed at €69 per month");
  });

  it("starts the Agency trial at the Agency price when Agency is the plan", () => {
    buttons.length = 0;
    const html = text(renderToStaticMarkup(<TrialOffer initialPlan="growth" />));
    expect(buttons[0]).toMatchObject({ plan: "growth" });
    expect(html).toContain("then Agency at €199 per month");
    expect(html).toContain("€1,990 per year");
  });
});

// Stripe keeps one Embedded Checkout per page: below lg the box's inline form
// and the sticky bar's sheet could both mount, and the second destroyed the
// first, leaving the box an empty frame with only "Not now".
describe("TrialPriceBox: one checkout at a time", () => {
  const FACTS = { endsAt: "2026-10-19T09:30:00.000Z", taxAdded: false };
  const box = () => renderToStaticMarkup(<TrialPriceBox canBuy interval="month" onInterval={() => undefined} facts={FACTS} />);

  it("asks for the width at Tailwind's lg, where the gate gets its rail", () => {
    expect(INLINE_CHECKOUT_QUERY).toBe("(min-width: 1024px)");
  });

  it("opens the sheet below lg, the same one the sticky bar opens", () => {
    buttons.length = 0;
    screen.wide = false;
    box();
    expect(buttons[0]).toMatchObject({ embed: "sheet" });
  });

  it("opens the form in place from lg, in the rail beside the article", () => {
    buttons.length = 0;
    screen.wide = true;
    box();
    expect(buttons[0]).toMatchObject({ embed: "inline" });
  });

  it("renders the sheet on the server, so the closed button is the same either way", () => {
    buttons.length = 0;
    screen.wide = null;
    box();
    expect(buttons[0]).toMatchObject({ embed: "sheet" });
  });
});

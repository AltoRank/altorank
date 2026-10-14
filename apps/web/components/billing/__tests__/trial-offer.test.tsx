import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The pricing page's Agency card says "7-day free trial, then €199", and the
// trial screen could only start Managed: Agency was "a click away on
// Billing", a page an account behind the trial gate is redirected away from.

const { buttons } = vi.hoisted(() => ({ buttons: [] as Array<Record<string, unknown>> }));
vi.mock("../start-trial-button", () => ({
  StartTrialButton: (props: Record<string, unknown>) => {
    buttons.push(props);
    return <button>Start 7-day trial</button>;
  },
}));

import { TrialOffer } from "../trial-offer";

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

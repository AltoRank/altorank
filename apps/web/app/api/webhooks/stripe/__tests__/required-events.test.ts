import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REQUIRED_STRIPE_EVENTS } from "@/lib/stripe";

// The Stripe endpoint's event subscription is set in the dashboard, so the
// only thing this repository can do is publish the list and keep it honest.
// Reading the route source is deliberate: a `case` string is the contract.
const route = readFileSync(resolve(__dirname, "../route.ts"), "utf8");
const handled = new Set([...route.matchAll(/case "([a-z_.]+)"/g)].map((m) => m[1]));

describe("REQUIRED_STRIPE_EVENTS", () => {
  it("names only events the webhook actually handles", () => {
    for (const ev of REQUIRED_STRIPE_EVENTS) expect(handled, ev).toContain(ev);
  });

  it("names every Stripe event the webhook handles, so the checklist is complete", () => {
    // Subscription status strings (active, past_due, …) are also `case`s but are
    // not event types; only dotted names are Stripe events.
    const events = [...handled].filter((c) => c.includes("."));
    expect([...events].sort()).toEqual([...REQUIRED_STRIPE_EVENTS].sort());
  });
});

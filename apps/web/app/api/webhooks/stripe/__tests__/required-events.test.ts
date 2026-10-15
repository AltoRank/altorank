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

// docs/deploy.md is what a self-hoster subscribes their endpoint from. It once
// listed six events and left out trial_will_end, the only trigger of the
// reminder email before a card trial's first charge.
describe("docs/deploy.md webhook table", () => {
  const doc = readFileSync(resolve(__dirname, "../../../../../../../docs/deploy.md"), "utf8");
  const section = doc.slice(doc.indexOf("### 1. The webhook endpoint and its events"), doc.indexOf("### 2. VAT"));
  const documented = [...section.matchAll(/^\| `([a-z_.]+)` \|/gm)].map((m) => m[1]);

  it("lists exactly REQUIRED_STRIPE_EVENTS", () => {
    expect(section.length).toBeGreaterThan(0);
    expect([...documented].sort()).toEqual([...REQUIRED_STRIPE_EVENTS].sort());
  });
});

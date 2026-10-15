import { describe, expect, it } from "vitest";
import { PLAN_ARTICLE_LIMITS, PLAN_LABELS, PLAN_PRICES, PLAN_YEARLY_PRICES, REQUIRED_STRIPE_EVENTS, TRIAL_DAYS } from "@/lib/stripe";
import { isOptional } from "@/lib/email/categories";
import { chargeLine, otherIntervalLine, otherPlanLine, priceLabel, reassuranceLine, stickyOfferLine, TRIAL_PLAN, trialIncludes, trialOfferFacts, yearlySaving } from "../trial-offer";

// The gate's price box, sentence by sentence, against the code that makes
// each one true (UX audit 2026-10-12, #6 and #9).

const NOW = new Date("2026-10-12T09:30:00.000Z");
const facts = trialOfferFacts(NOW, false);

describe("the trial offer", () => {
  it("names the plan and dates the first charge TRIAL_DAYS out", () => {
    expect(TRIAL_PLAN).toBe(PLAN_LABELS.starter);
    expect(new Date(facts.endsAt).getTime() - NOW.getTime()).toBe(TRIAL_DAYS * 86_400_000);
    expect(chargeLine("month", facts)).toBe(`€0 today, then ${PLAN_PRICES.starter}/month from October 19.`);
    expect(chargeLine("year", facts)).toBe(`€0 today, then ${PLAN_YEARLY_PRICES.starter}/year from October 19.`);
  });

  it("never calls the first charge a renewal, and says VAT only when checkout adds it", () => {
    for (const line of [chargeLine("month", facts), reassuranceLine(), otherIntervalLine("month"), stickyOfferLine("month")]) {
      expect(line).not.toMatch(/renewal|renew/i);
    }
    expect(chargeLine("month", facts)).not.toMatch(/VAT|tax/i);
    expect(chargeLine("month", trialOfferFacts(NOW, true))).toContain("plus VAT where it applies");
  });

  it("states yearly's real saving, computed from the two prices", () => {
    const monthly = Number(PLAN_PRICES.starter.replace(/\D/g, ""));
    const yearly = Number(PLAN_YEARLY_PRICES.starter.replace(/\D/g, ""));
    expect(yearlySaving()).toBe(monthly * 12 - yearly);
    // "Two months free" is only true while the saving is two months.
    expect(yearlySaving()).toBe(monthly * 2);
    expect(otherIntervalLine("month")).toBe(`Or pay yearly: ${PLAN_YEARLY_PRICES.starter}/year, two months free (save €${monthly * 2})`);
    expect(otherIntervalLine("year")).toContain(priceLabel("month"));
  });

  it("the sticky bar quotes the same price as the box, for whichever interval is chosen", () => {
    expect(stickyOfferLine("month")).toContain(priceLabel("month"));
    expect(stickyOfferLine("year")).toContain(priceLabel("year"));
  });

  it("the reminder is the trial_will_end email, which nobody can unsubscribe from", () => {
    expect(REQUIRED_STRIPE_EVENTS).toContain("customer.subscription.trial_will_end");
    expect(isOptional("billing")).toBe(false);
    expect(reassuranceLine()).toContain("3 days before the trial ends");
    expect(reassuranceLine()).toContain("Settings, Billing");
  });

  it("says what the trial includes from the plan's own numbers, and the text only when it was not already read", () => {
    expect(trialIncludes(true)[0]).toBe("Edit and approve this article, then copy it to your site or ask us to connect your site");
    expect(trialIncludes(true).join(" ")).not.toMatch(/API key|Model and search-data/);
    expect(trialIncludes(false)[0]).toContain("Read this article in full");
    expect(trialIncludes(true)).toContain(`Up to ${PLAN_ARTICLE_LIMITS.starter} articles a month, written at the pace you set`);
    expect(trialIncludes(true)).toContain("Nothing publishes until you approve it");
  });

  it("quotes Agency's own price, limit and saving when the owner switches plan (#280)", () => {
    expect(chargeLine("month", facts, "growth")).toBe(`€0 today, then ${PLAN_PRICES.growth}/month from October 19.`);
    expect(chargeLine("year", facts, "growth")).toBe(`€0 today, then ${PLAN_YEARLY_PRICES.growth}/year from October 19.`);
    expect(trialIncludes(true, "growth")).toContain(`Up to ${PLAN_ARTICLE_LIMITS.growth} articles a month, written at the pace you set`);
    const monthly = Number(PLAN_PRICES.growth.replace(/\D/g, ""));
    expect(yearlySaving("growth")).toBe(monthly * 2);
    expect(stickyOfferLine("year", "growth")).toContain(priceLabel("year", "growth"));
    expect(otherPlanLine("starter", "month")).toContain(`${PLAN_LABELS.growth} instead: ${PLAN_PRICES.growth}/month`);
    expect(otherPlanLine("growth", "year")).toContain(`${PLAN_LABELS.starter}: ${PLAN_YEARLY_PRICES.starter}/year`);
  });
});

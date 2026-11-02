import { describe, expect, it } from "vitest";
import { PLAN_ARTICLE_LIMITS, PLAN_LABELS, PLAN_PRICES, PLAN_YEARLY_PRICES, REQUIRED_STRIPE_EVENTS, TRIAL_DAYS } from "@/lib/stripe";
import { isOptional } from "@/lib/email/categories";
import { nextArticlesLine, otherIntervalLine, otherPlanLine, planDetails, priceLabel, priceLine, reassuranceLine, stickyOfferLine, TRIAL_PLAN, trialOfferFacts, yearlySaving } from "../trial-offer";

// The gate's price box, sentence by sentence, against the code that makes
// each one true (UX audit 2026-10-12, #6 and #9).

const NOW = new Date("2026-10-12T09:30:00.000Z");
const facts = trialOfferFacts(NOW, false);

describe("the trial offer", () => {
  it("names the plan and dates the first charge TRIAL_DAYS out", () => {
    expect(TRIAL_PLAN).toBe(PLAN_LABELS.starter);
    expect(new Date(facts.endsAt).getTime() - NOW.getTime()).toBe(TRIAL_DAYS * 86_400_000);
    expect(priceLine("month", facts)).toBe(`Card required. €0 today. Then ${PLAN_PRICES.starter}/month from October 19 unless you cancel.`);
    expect(priceLine("year", facts)).toBe(`Card required. €0 today. Then ${PLAN_YEARLY_PRICES.starter}/year from October 19 unless you cancel.`);
  });

  it("never calls the first charge a renewal, and says VAT only when checkout adds it", () => {
    for (const line of [priceLine("month", facts), reassuranceLine(), otherIntervalLine("month"), stickyOfferLine("month")]) {
      expect(line).not.toMatch(/renewal|renew/i);
    }
    expect(priceLine("month", facts)).not.toMatch(/VAT|tax/i);
    expect(priceLine("month", trialOfferFacts(NOW, true))).toBe(`Card required. €0 today. Then ${PLAN_PRICES.starter}/month (plus VAT where it applies) from October 19 unless you cancel.`);
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
    expect(reassuranceLine()).toContain("Settings › Billing");
  });

  it("says what the trial is for under the topics it names, and keeps the plan's terms for Plan details", () => {
    expect(nextArticlesLine(true)).toBe("Start your trial to have these written. Review each article, then copy it to your website.");
    expect(nextArticlesLine(false)).not.toMatch(/these/);
    expect(planDetails()).toEqual([
      `Up to ${PLAN_ARTICLE_LIMITS.starter} articles a month, written at the pace you set`,
      "Nothing publishes until you approve it",
      "Writing and topic research included",
    ]);
    expect(planDetails().join(" ")).not.toMatch(/No extra costs|API key/);
  });

  it("quotes Agency's own price, limit and saving when the owner switches plan (#280)", () => {
    expect(priceLine("month", facts, "growth")).toBe(`Card required. €0 today. Then ${PLAN_PRICES.growth}/month from October 19 unless you cancel.`);
    expect(priceLine("year", facts, "growth")).toBe(`Card required. €0 today. Then ${PLAN_YEARLY_PRICES.growth}/year from October 19 unless you cancel.`);
    expect(planDetails("growth")).toContain(`Up to ${PLAN_ARTICLE_LIMITS.growth} articles a month, written at the pace you set`);
    const monthly = Number(PLAN_PRICES.growth.replace(/\D/g, ""));
    expect(yearlySaving("growth")).toBe(monthly * 2);
    expect(stickyOfferLine("year", "growth")).toContain(priceLabel("year", "growth"));
    expect(otherPlanLine("starter", "month")).toContain(`${PLAN_LABELS.growth} instead: ${PLAN_PRICES.growth}/month`);
    expect(otherPlanLine("growth", "year")).toContain(`${PLAN_LABELS.starter}: ${PLAN_YEARLY_PRICES.starter}/year`);
  });
});

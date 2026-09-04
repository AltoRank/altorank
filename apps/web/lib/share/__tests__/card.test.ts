import { describe, it, expect } from "vitest";
import { buildShareCard, BRAND_LINE, type ShareCardFacts } from "../card";

const measured: ShareCardFacts = {
  domain: "acme.com",
  dr: 42,
  published: 12,
  planned: 8,
  gscConnected: true,
  clicks28d: 1534,
  removeBranding: false,
};

describe("share card assembly", () => {
  it("shows every measured figure with its label", () => {
    const card = buildShareCard(measured);
    expect(card.domain).toBe("acme.com");
    expect(card.stats).toEqual([
      { label: "Authority", value: "42" },
      { label: "Articles published", value: "12" },
      { label: "Articles planned", value: "8" },
      { label: "Search clicks, 28 days", value: "1,534" },
    ]);
    expect(card.omitted).toEqual([]);
    expect(card.footer).toBe(BRAND_LINE);
  });
  it("omits authority when unmeasured, never prints 0", () => {
    const card = buildShareCard({ ...measured, dr: null });
    expect(card.stats.map((s) => s.label)).not.toContain("Authority");
    expect(card.stats.some((s) => s.label === "Authority" && s.value === "0")).toBe(false);
    expect(card.omitted[0]).toMatch(/authority/);
  });
  it("omits clicks when Search Console is not connected, and says why", () => {
    const card = buildShareCard({ ...measured, gscConnected: false, clicks28d: null });
    expect(card.stats.map((s) => s.label)).not.toContain("Search clicks, 28 days");
    expect(card.omitted.join(" ")).toMatch(/not connected/);
  });
  it("omits clicks when connected but nothing synced, distinctly from a measured zero", () => {
    const nothing = buildShareCard({ ...measured, clicks28d: null });
    expect(nothing.stats.map((s) => s.label)).not.toContain("Search clicks, 28 days");
    expect(nothing.omitted.join(" ")).toMatch(/nothing synced/);
    const zero = buildShareCard({ ...measured, clicks28d: 0 });
    expect(zero.stats.find((s) => s.label === "Search clicks, 28 days")?.value).toBe("0");
  });
  it("keeps the counts even at zero, because a count of zero is a measurement", () => {
    const card = buildShareCard({ ...measured, published: 0, planned: 0 });
    expect(card.stats.find((s) => s.label === "Articles published")?.value).toBe("0");
  });
  it("drops the brand line when the account removed branding", () => {
    expect(buildShareCard({ ...measured, removeBranding: true }).footer).toBeNull();
  });
});

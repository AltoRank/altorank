import { describe, expect, it } from "vitest";
import { funnelOf, parseVerdicts } from "../buyer-fit";

describe("buyer verdicts carry the funnel", () => {
  const asked = ["crm personal trainer", "quanto guadagna un personal trainer", "palestra milano", "app coach"];
  const raw = JSON.stringify([
    { t: "crm personal trainer", k: true, f: "buy", r: "trainer choosing client software" },
    { t: "quanto guadagna un personal trainer", k: true, f: "aud", r: "a trainer researching their own earnings" },
    { t: "palestra milano", k: false, r: "a gym-goer, not a trainer" },
    { t: "app coach", k: true, r: "category search" },
  ]);
  const verdicts = parseVerdicts(raw, asked);

  it("reads an audience topic as kept and top of funnel", () => {
    expect(funnelOf(verdicts.get("quanto guadagna un personal trainer"))).toBe("audience");
  });
  it("reads a missing or unknown marker as a buyer, the stricter reading", () => {
    expect(funnelOf(verdicts.get("app coach"))).toBe("buyer");
    expect(funnelOf(verdicts.get("crm personal trainer"))).toBe("buyer");
  });
  it("gives a refusal no funnel at all", () => {
    expect(funnelOf(verdicts.get("palestra milano"))).toBeNull();
  });
  it("treats a verdict saved before the marker existed as a buyer", () => {
    expect(funnelOf({ keep: true, reason: null })).toBe("buyer");
  });
});

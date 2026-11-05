import { describe, it, expect } from "vitest";
import { resolveLocale, localeLabels, MARKET_OPTIONS, LANGUAGE_OPTIONS, GLOBAL_MARKET } from "../locale";

describe("resolveLocale", () => {
  it("maps the wizard's default labels to en / US", () => {
    expect(resolveLocale("English", GLOBAL_MARKET)).toEqual({ language: "en", locationCode: 2840 });
  });
  it("lets the market decide the location when it is a known country", () => {
    expect(resolveLocale("Italian", "Italy")).toEqual({ language: "it", locationCode: 2380 });
    expect(resolveLocale("English", "United Kingdom")).toEqual({ language: "en", locationCode: 2826 });
  });
  it("tolerates codes and casing", () => {
    expect(resolveLocale("it", "italy").language).toBe("it");
    expect(resolveLocale("ENGLISH", "").locationCode).toBe(2840);
  });
  it("never writes a label into the code column", () => {
    const r = resolveLocale("Klingon", "Qo'noS");
    expect(r.language).toBe("en");
    expect(typeof r.locationCode).toBe("number");
  });
  it("round-trips through localeLabels", () => {
    const r = resolveLocale("German", "Germany");
    expect(localeLabels(r.language, r.locationCode)).toEqual({ language: "German", country: "Germany" });
    expect(localeLabels("en", 2840).country).toBe(GLOBAL_MARKET);
  });
  it("offers Global first and every language once", () => {
    expect(MARKET_OPTIONS[0].label).toBe(GLOBAL_MARKET);
    expect(new Set(LANGUAGE_OPTIONS.map((o) => o.code)).size).toBe(LANGUAGE_OPTIONS.length);
    // India has two languages (Hindi, English) and is one market.
    const labels = MARKET_OPTIONS.map((m) => m.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(MARKET_OPTIONS.find((m) => m.label === "India")?.locationCode).toBe(2356);
    expect(MARKET_OPTIONS.find((m) => m.label === "Pakistan")?.locationCode).toBe(2586);
  });
  it("reopens a Pakistan or India workspace on its market, not Global", () => {
    expect(localeLabels("en", 2586)).toEqual({ language: "English", country: "Pakistan" });
    expect(localeLabels("en-in", 2356)).toEqual({ language: "English (IN)", country: "India" });
  });
  it("keeps every locale key inside the workspaces.language constraint (migration 049)", () => {
    for (const o of LANGUAGE_OPTIONS) expect(o.code).toMatch(/^[a-z]{2}(-[a-z]{2})?$/);
  });
});

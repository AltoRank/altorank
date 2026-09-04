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
  });
});

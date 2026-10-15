import { describe, expect, it } from "vitest";
import { guessLocale, htmlLangOf } from "../locale-guess";
import { LANGUAGE_OPTIONS, MARKET_OPTIONS, resolveLocale } from "../locale";

// A failed site read used to start the wizard on English / Global. The page's
// own `lang` and its country domain say better (UX audit 2026-10-12, #15).
describe("guessing language and market when the site read fails", () => {
  it("reads the lang off the html tag, whatever the quoting", () => {
    expect(htmlLangOf('<!doctype html><html lang="it-IT" class="x"><head>')).toBe("it-IT");
    expect(htmlLangOf("<html class='a' lang='tr'>")).toBe("tr");
    expect(htmlLangOf("<HTML LANG=de_DE>")).toBe("de-DE");
    expect(htmlLangOf("<html><body lang=\"fr\">")).toBeNull();
    expect(htmlLangOf("")).toBeNull();
    expect(htmlLangOf(null)).toBeNull();
  });

  it("takes the market from the country domain and the language from the page", () => {
    expect(guessLocale({ domain: "acme-clinic.example.it" })).toEqual({ language: "Italian", country: "Italy" });
    expect(guessLocale({ domain: "acme.com.tr" })).toEqual({ language: "Turkish", country: "Turkey" });
    expect(guessLocale({ domain: "https://www.acme.de/" })).toEqual({ language: "German", country: "Germany" });
    expect(guessLocale({ domain: "acme.fr" })).toEqual({ language: "French", country: "France" });
    expect(guessLocale({ domain: "acme.es" })).toEqual({ language: "Spanish", country: "Spain" });
    expect(guessLocale({ domain: "acme.co.uk" })).toEqual({ language: "English (UK)", country: "United Kingdom" });
    // An English page on an Italian domain: written in English, sold in Italy.
    expect(guessLocale({ htmlLang: "en", domain: "acme.it" })).toEqual({ language: "English", country: "Italy" });
  });

  it("uses the page's region, or the language's own country, on a .com", () => {
    expect(guessLocale({ htmlLang: "de-DE", domain: "acme.com" })).toEqual({ language: "German", country: "Germany" });
    expect(guessLocale({ htmlLang: "it", domain: "acme.com" })).toEqual({ language: "Italian", country: "Italy" });
    expect(guessLocale({ htmlLang: "pt-BR", domain: "acme.com" })).toEqual({ language: "Portuguese", country: "Brazil" });
    expect(guessLocale({ htmlLang: "en-GB", domain: "acme.com" })).toEqual({ language: "English (UK)", country: "United Kingdom" });
  });

  it("guesses nothing when the defaults are already the honest answer", () => {
    expect(guessLocale({ domain: "acme.com" })).toBeNull();
    expect(guessLocale({ htmlLang: "en", domain: "acme.com" })).toBeNull();
    expect(guessLocale({ htmlLang: "xx-ZZ", domain: "acme.io" })).toBeNull();
    // A page that names its region is taken at its word.
    expect(guessLocale({ htmlLang: "en-US", domain: "acme.io" })).toEqual({ language: "English", country: "United States" });
    expect(guessLocale({ htmlLang: "xx", domain: "acme.example" })).toBeNull();
  });

  it("only ever returns labels the wizard's selects hold, which save to the right codes", () => {
    for (const domain of ["a.it", "a.tr", "a.de", "a.fr", "a.es", "a.nl", "a.pl", "a.se", "a.pt", "a.br", "a.mx", "a.jp", "a.ua", "a.il"]) {
      const g = guessLocale({ domain });
      expect(g, domain).not.toBeNull();
      expect(LANGUAGE_OPTIONS.map((o) => o.label), domain).toContain(g!.language);
      expect(MARKET_OPTIONS.map((o) => o.label), domain).toContain(g!.country);
    }
    expect(resolveLocale("Italian", "Italy")).toEqual({ language: "it", locationCode: 2380 });
    expect(resolveLocale("Turkish", "Turkey")).toEqual({ language: "tr", locationCode: 2792 });
  });
});

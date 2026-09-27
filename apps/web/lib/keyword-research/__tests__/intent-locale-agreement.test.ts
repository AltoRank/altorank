/**
 * The keyword planner and the article checks read one locale.
 *
 * Two language registries were built on 2026-09-25: the duplicate-intent
 * check (lib/keyword-research/intent.ts) with its own language list, Turkish
 * lowercasing and mark stripping, and the locale contract (lib/i18n/locale.ts)
 * with `resolveLocale`, `Locale.lower` and `foldCase`. They agreed that day
 * and could drift the next. The Turkish I's are where they would drift first:
 * Turkish lowercasing turns "API" into "apı", which the contract's keyword
 * matcher has to fold back (the "api entegrasyonu" keyword read 0% density
 * until it did). If the planner folded it differently, "API entegrasyonu" and
 * "api entegrasyonu" would be two searches to it and one keyword to the
 * article checks.
 *
 * intent.ts now resolves everything through the contract; this pins that the
 * two answer alike.
 */
import { describe, expect, it } from "vitest";
import { foldsInflections, intentKey, intentLanguage, sameIntent, unfoldedNote } from "../intent";
import {
  SUPPORTED_LANGUAGES,
  UNKNOWN_LANGUAGE,
  containsKeyword,
  foldCase,
  foldMarks,
  resolveLocale,
} from "@/lib/i18n/locale";

const LANGUAGES = [...SUPPORTED_LANGUAGES, "ja", UNKNOWN_LANGUAGE];

/** Bare words: no plural, possessive or connective in any rule set, so the key is the word itself. */
const WORDS = ["API", "Api", "api", "apı", "İstanbul", "ISTANBUL", "istanbul", "IŞIK", "Işık", "ışık", "İÇERİK", "içerik", "UI"];

describe("intent keys and the locale contract", () => {
  it("fold the Turkish I's and 'API' to the same word in every language", () => {
    for (const language of LANGUAGES) {
      for (const word of WORDS) {
        expect({ language, word, key: intentKey(word, language) }).toEqual({ language, word, key: foldMarks(foldCase(word)) });
      }
    }
    expect(intentKey("API", "tr")).toBe("api");
    expect(intentKey("İstanbul", "tr")).toBe(intentKey("ISTANBUL", "en"));
  });

  it("lower Turkish by the contract's own rules before inflections are read", () => {
    const tr = resolveLocale("tr");
    // The contract's Turkish lowercasing keeps ı a letter of its own...
    expect(tr.lower("IŞIK")).toBe("ışık");
    expect(tr.lower("API")).toBe("apı");
    // ...and the planner folds it away only after the inflection rules ran.
    expect(intentKey("firmaları", "tr")).toBe(intentKey("FİRMASI", "tr"));
    expect(intentKey("FİRMALARI", "tr")).toBe("firma");
  });

  it("find one keyword where the article checks find one", () => {
    const tr = resolveLocale("tr");
    expect(containsKeyword("API Entegrasyonu Rehberi", "api entegrasyonu", tr)).toBe(true);
    expect(sameIntent({ term: "API entegrasyonu" }, { term: "api entegrasyonu" }, "tr").same).toBe(true);
    expect(containsKeyword("İSTANBUL web tasarım", "istanbul web tasarım", tr)).toBe(true);
    expect(sameIntent({ term: "İSTANBUL web tasarım" }, { term: "istanbul web tasarım" }, "tr").same).toBe(true);
  });

  it("resolve a language to the contract's code, rules and name", () => {
    for (const raw of ["tr", "TR", "Turkish", "tr-TR", "en-gb", "English", "it", "de-AT", "ja", "xx", UNKNOWN_LANGUAGE]) {
      const locale = resolveLocale(raw);
      expect(intentLanguage(raw)).toBe(locale.code);
      expect(foldsInflections(raw)).toBe(locale.supported && locale.searchWords !== null);
      const note = unfoldedNote(raw);
      if (note) expect(note).toBe(`inflected spellings not compared for ${locale.name}`);
    }
    // One sentinel for "the language could not be read".
    expect(intentLanguage(null)).toBe(UNKNOWN_LANGUAGE);
    expect(resolveLocale(intentLanguage(undefined)).supported).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  resolveLocale,
  supportedLocales,
  SUPPORTED_LANGUAGES,
  notCheckedFor,
  matchesAnyHeading,
  anyLanguageLabels,
  countKeyword,
  containsKeyword,
  parseNumber,
  formatNumber,
  scaleWords,
  urlSlug,
  anchorId,
  foldToAscii,
  type SupportedLocale,
} from "../locale";

const tr = resolveLocale("tr") as SupportedLocale;
const en = resolveLocale("en") as SupportedLocale;

describe("resolveLocale", () => {
  it("reads a code, a region code and a label alike", () => {
    for (const v of ["tr", "TR", "tr-TR", "tr_tr", "Turkish"]) {
      const l = resolveLocale(v);
      expect(l.supported).toBe(true);
      expect(l.code).toBe("tr");
    }
    expect(resolveLocale("en-gb").code).toBe("en");
    expect(resolveLocale("es-mx").code).toBe("es");
  });

  it("is English when nothing is stored, which is the column default", () => {
    expect(resolveLocale(undefined).code).toBe("en");
    expect(resolveLocale(null).code).toBe("en");
    expect(resolveLocale("  ").code).toBe("en");
  });

  it("says a language it does not describe is unsupported, by name, instead of falling back", () => {
    const pt = resolveLocale("pt-pt");
    expect(pt.supported).toBe(false);
    expect(pt.code).toBe("pt");
    expect(pt.name).toBe("Portuguese");
    const ja = resolveLocale("ja");
    expect(ja).toMatchObject({ supported: false, code: "ja", name: "Japanese" });
    expect(resolveLocale("Chinese (Simplified)")).toMatchObject({ supported: false, code: "zh" });
    expect(notCheckedFor(ja)).toBe(
      "Not checked for Japanese: this check reads English, Italian, Spanish, French, German and Turkish only.",
    );
  });

  it("lowercases by the language's own rules", () => {
    expect(tr.lower("İSTANBUL'DA IŞIK")).toBe("istanbul'da ışık");
    expect(en.lower("İ")).not.toBe("i"); // why the Turkish rule matters
  });
});

describe("every supported language is described completely", () => {
  it("has every label, and none of them is the English one", () => {
    const english = Object.values(en.labels).filter((v): v is string => typeof v === "string");
    for (const l of supportedLocales()) {
      for (const [key, value] of Object.entries(l.labels)) {
        if (typeof value === "string") expect(value.trim(), `${l.code}.${key}`).not.toBe("");
      }
      expect(l.labels.learnMore("X")).toContain("X");
      expect(l.labels.publishedBy("X")).toContain("X");
      expect(l.labels.visit).toContain("{link}");
      if (l.code === "en") continue;
      // "Video" is the same word in Italian, German and Turkish; everything
      // else a reader sees must be the language's own.
      for (const key of ["contents", "figuresFrom", "keyTakeaways", "faqHeading", "before", "after"] as const) {
        expect(english, `${l.code}.${key}`).not.toContain(l.labels[key]);
      }
      expect(l.labels.barChart("x")).not.toContain("Bar chart");
    }
  });

  it("recognises its own FAQ and summary labels as headings", () => {
    for (const l of supportedLocales()) {
      expect(matchesAnyHeading("faq", l.labels.faqHeading), l.code).toBe(true);
      expect(matchesAnyHeading("summary", l.labels.keyTakeaways), l.code).toBe(true);
      expect(matchesAnyHeading("notIllustrated", l.labels.faqHeading), l.code).toBe(true);
    }
    expect(SUPPORTED_LANGUAGES).toEqual(["en", "it", "es", "fr", "de", "tr"]);
  });

  it("recognises labels in any described language, uppercase Turkish included", () => {
    expect(matchesAnyHeading("faq", "SIKÇA SORULAN SORULAR")).toBe(true);
    expect(matchesAnyHeading("summary", "Öne Çıkan Noktalar")).toBe(true);
    expect(matchesAnyHeading("howTo", "WordPress nasıl kurulur?")).toBe(true);
    expect(matchesAnyHeading("faq", "Fiyatlar")).toBe(false);
    expect(anyLanguageLabels("sourcesFooter").has("kaynakça")).toBe(true);
    expect(anyLanguageLabels("genericAnchors").has("buraya tıklayın")).toBe(true);
  });
});

describe("keywords in running text", () => {
  it("finds a Turkish keyword with its suffixes and Turkish casing, where the English rule finds none", () => {
    // Suffixed twice, and once in capitals: English lowering turns "TASARIM"
    // into "tasarim", which is not the word.
    const text = "Web tasarımında hız önemlidir. İyi bir web tasarımı dönüştürür. WEB TASARIM ilkeleri.";
    expect(countKeyword(text, "web tasarım", tr)).toBe(3);
    expect(countKeyword(text, "web tasarım", en)).toBe(0);
  });

  it("uses Unicode word boundaries, so an accented last letter still ends a word", () => {
    const it = resolveLocale("it") as SupportedLocale;
    expect(countKeyword("La città d'arte. Città!", "città", it)).toBe(2);
    expect(containsKeyword("Ölçüm araçları", "ölçüm", tr)).toBe(true);
  });
});

describe("numbers as each language writes them", () => {
  it("reads Turkish separators exactly and refuses what it cannot read", () => {
    expect(parseNumber("1.500,50", tr)).toBe(1500.5);
    expect(parseNumber("1.500", tr)).toBe(1500);
    expect(parseNumber("20", tr)).toBe(20);
    expect(parseNumber("1,5", tr)).toBe(1.5);
    expect(parseNumber("1.5", tr)).toBeNull();
    expect(parseNumber("1,500.50", en)).toBe(1500.5);
    expect(formatNumber(1500.5, tr)).toBe("1500,5");
    expect(formatNumber(1500.5, en)).toBe("1500.5");
  });

  it("scales English word thresholds to the language's words", () => {
    expect(scaleWords(10, tr)).toBe(8);
    expect(scaleWords(25, tr)).toBe(20);
    expect(scaleWords(6, tr)).toBe(5);
    expect(scaleWords(1500, en)).toBe(1500);
  });
});

describe("slugs and anchors", () => {
  it("folds every Turkish letter to its ASCII form: ı→i ş→s ğ→g ç→c ö→o ü→u İ→i", () => {
    expect(foldToAscii("ı ş ğ ç ö ü İ")).toBe("i-s-g-c-o-u-i");
    expect(foldToAscii("I Ş Ğ Ç Ö Ü")).toBe("i-s-g-c-o-u");
    expect(urlSlug("Yazılım seçimi neden önemlidir?")).toBe("yazilim-secimi-neden-onemlidir");
    expect(anchorId("İçerik stratejisi nasıl kurulur?")).toBe("icerik-stratejisi-nasil-kurulur");
    expect(anchorId("2026'da ölçüm")).toBe("s-2026-da-olcum");
  });

  it("maps the other letters NFKD leaves alone, and keeps the existing folds", () => {
    expect(urlSlug("Straße")).toBe("strasse");
    expect(urlSlug("Smørrebrød")).toBe("smorrebrod");
    expect(urlSlug("città d'arte perché")).toBe("citta-d-arte-perche");
    expect(urlSlug("Übersicht für Anfänger")).toBe("ubersicht-fur-anfanger");
  });
});

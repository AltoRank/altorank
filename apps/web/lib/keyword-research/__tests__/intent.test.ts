import { describe, expect, it } from "vitest";
import {
  SERP_SAME_INTENT_SHARED,
  canonicalPage,
  clusterByIntent,
  foldsInflections,
  intentKey,
  intentLanguage,
  sameIntent,
  sharedResults,
  unfoldedNote,
  type StagedTopic,
} from "../intent";

/**
 * One query, one article. A real signup (2026-09-22, a Turkish web and mobile
 * agency) had one search drafted, queued for the next day and held for the
 * trial under three spellings: a synonym ("şirket"/"firma") and two
 * inflections ("-leri", "-ları", "-sı"). The results page catches all three;
 * the words catch the inflections and, honestly, not the synonym.
 */

const page = (prefix: string, n = 10) => Array.from({ length: n }, (_, i) => `https://${prefix}-${i}.example/sayfa-${i}`);
/** Ten results, the first `shared` of which are also on `base`. */
const serp = (base: string[], shared: number, prefix: string) => [...base.slice(0, shared), ...page(prefix, 10 - shared)];

const SIRKETLERI = "mobil uygulama geliştirme şirketleri";
const FIRMALARI = "mobil uygulama geliştirme firmaları";
const FIRMASI = "mobil uygulama geliştirme firması";
const DRAFTED_SERP = page("owner");

describe("the Turkish incident: three spellings of one search", () => {
  it("with stored results pages, all three are one search, whatever the words", () => {
    const drafted = { term: SIRKETLERI, organicUrls: DRAFTED_SERP };
    const queued = { term: FIRMALARI, organicUrls: serp(DRAFTED_SERP, 6, "q") };
    const held = { term: FIRMASI, organicUrls: serp(DRAFTED_SERP, 5, "h") };
    expect(sameIntent(queued, drafted, "tr")).toEqual({ same: true, basis: "serp", shared: 6 });
    expect(sameIntent(held, drafted, "tr")).toEqual({ same: true, basis: "serp", shared: 5 });
    expect(sameIntent(held, queued, "tr").same).toBe(true);
  });

  it("without results pages, folds the inflections but cannot see the synonym, and says it compared words", () => {
    expect(sameIntent({ term: FIRMALARI }, { term: FIRMASI }, "tr")).toEqual({ same: true, basis: "words" });
    // "şirket" and "firma" are synonyms: only a results page can say so.
    expect(sameIntent({ term: SIRKETLERI }, { term: FIRMALARI }, "tr")).toEqual({ same: false, basis: "words" });
    // One side without a page is enough to fall back to words.
    expect(sameIntent({ term: SIRKETLERI, organicUrls: DRAFTED_SERP }, { term: FIRMASI }, "tr").basis).toBe("words");
  });

  it("folds Turkish capitals correctly: İ is i and I is ı, in the workspace's language", () => {
    // Plain JS lower-cases "İ" to "i" plus a combining dot and "I" to "i".
    expect("İ".toLowerCase()).not.toBe("i");
    expect(intentKey("MOBİL UYGULAMA GELİŞTİRME FIRMASI", "tr")).toBe(intentKey(FIRMASI, "tr"));
    expect(intentKey("Mobil Uygulama Geliştirme Firmaları", "tr-TR")).toBe(intentKey(FIRMASI, "tr"));
  });

  it("reads text typed without Turkish letters as the same search", () => {
    expect(intentKey("mobil uygulama gelistirme firmasi", "tr")).toBe(intentKey(FIRMASI, "tr"));
    expect(intentKey("mobil uygulama gelistirme sirketleri", "tr")).toBe(intentKey("mobil uygulama geliştirme şirketi", "tr"));
  });

  it("folds plural and possessive endings, and keeps bare nouns whole", () => {
    expect(intentKey("web sitesi fiyatları", "tr")).toBe(intentKey("web siteleri fiyatı", "tr"));
    expect(intentKey("ürünü", "tr")).toBe(intentKey("ürün", "tr"));
    // "kedi", "bilgi" and "yazı" end in a possessive-looking vowel and are not
    // possessives; their possessive forms fold to them, not past them.
    expect(intentKey("kedisi", "tr")).toBe("kedi");
    expect(intentKey("bilgileri", "tr")).toBe("bilgi");
    expect(intentKey("blog yazısı", "tr")).toBe(intentKey("blog yazı", "tr"));
    expect(intentKey("dolar kuru", "tr")).toContain("dolar");
    // A name's suffix goes after an apostrophe.
    expect(intentKey("İstanbul'da web tasarım", "tr")).toBe(intentKey("istanbul web tasarım", "tr"));
  });

  it("does not stem Turkish as English", () => {
    // English rules would read "ajans" as a plural and drop "iş" as "is".
    expect(intentKey("seo ajans", "tr")).toBe("ajans seo");
    expect(sameIntent({ term: "ajan" }, { term: "ajans" }, "tr").same).toBe(false);
    expect(intentKey("iş ilanları", "tr")).toBe("ilan is");
    expect(intentKey("seo ajans", "en")).toBe("ajan seo");
  });
});

describe("languages without a rule set", () => {
  it("keeps the words whole and says it did not compare inflections", () => {
    expect(foldsInflections("it")).toBe(false);
    expect(unfoldedNote("it")).toBe("inflected spellings not compared for Italian");
    expect(sameIntent({ term: "agenzie seo" }, { term: "agenzia seo" }, "it")).toEqual({
      same: false, basis: "words", note: "inflected spellings not compared for Italian",
    });
    // Word order and case still fold: that is not stemming.
    expect(sameIntent({ term: "Agenzia SEO Milano" }, { term: "milano agenzia seo" }, "it").same).toBe(true);
    // And the results page still decides when both were bought.
    const base = page("it");
    expect(sameIntent({ term: "agenzie seo", organicUrls: base }, { term: "agenzia seo", organicUrls: serp(base, 7, "x") }, "it")).toEqual({ same: true, basis: "serp", shared: 7 });
  });

  it("says so when no language was given at all, rather than assuming English", () => {
    expect(unfoldedNote(null)).toBe("inflected spellings not compared for an unknown language");
    expect(sameIntent({ term: "seo agencies" }, { term: "seo agency" }, null).same).toBe(false);
  });

  it("resolves a workspace language through the product's locales, and keeps an unknown one as itself", () => {
    expect(intentLanguage("tr")).toBe("tr");
    expect(intentLanguage("Turkish")).toBe("tr");
    expect(intentLanguage("zh")).toBe("zh-CN");
    expect(intentLanguage("en-gb")).toBe("en");
    expect(intentLanguage(null)).toBeNull();
    expect(intentLanguage("  ")).toBeNull();
    // Not in LOCALES: never English. No rule set, and it says so.
    expect(intentLanguage("sw")).toBe("sw");
    expect(intentLanguage("xx")).toBe("xx");
    expect(intentLanguage("pt-AO")).toBe("pt");
    expect(unfoldedNote(intentLanguage("sw"))).toBe("inflected spellings not compared for sw");
    expect(sameIntent({ term: "seo agencies" }, { term: "seo agency" }, intentLanguage("sw")).same).toBe(false);
  });

  it("strips diacritics for any language", () => {
    expect(intentKey("café crème", "fr")).toBe(intentKey("cafe creme", "fr"));
  });
});

describe("English regression set", () => {
  const A = "best crm for agencies";
  const B = "best agency crm";
  const C = "crm pricing";

  it("by words: word order, connectives and plurals fold; a different search does not", () => {
    expect(sameIntent({ term: A }, { term: B }, "en")).toEqual({ same: true, basis: "words" });
    expect(sameIntent({ term: A }, { term: C }, "en").same).toBe(false);
    expect(intentKey("seo tools for small businesses", "en")).toBe(intentKey("small business seo tool", "en"));
    expect(intentKey("classes", "en")).toBe("class");
    expect(intentKey("searches", "en")).toBe("search");
    expect(intentKey("tax boxes", "en")).toBe(intentKey("box tax", "en"));
    expect(intentKey("websites", "en")).toBe("website");
    // An ending that is not a plural stays.
    expect(intentKey("business", "en")).toBe("business");
    expect(intentKey("status", "en")).toBe("status");
    expect(intentKey("analysis", "en")).toBe("analysis");
  });

  it("folds only the plural: a derivational ending is another word, and the results page decides", () => {
    // Each of these merged under the old English rule set (-er, -ing and a
    // silent final e), and a words match now parks a topic for good.
    const apart: Array<[string, string]> = [
      ["search engine jobs", "search engineer jobs"],
      ["poster design", "post design"],
      ["web server", "web serve"],
      ["building management software", "build management software"],
      ["crm news", "new crm"],
      ["seo content writers", "seo content writing"],
    ];
    for (const [a, b] of apart) expect(sameIntent({ term: a }, { term: b }, "en"), `${a} / ${b}`).toEqual({ same: false, basis: "words" });
    // Where they are one search, a bought results page says so.
    const base = page("writing");
    expect(sameIntent({ term: "seo content writers", organicUrls: base }, { term: "seo content writing", organicUrls: serp(base, 7, "w") }, "en").same).toBe(true);
  });

  it("keeps the direction of 'x to y', and treats 'x vs y' as one comparison", () => {
    expect(sameIntent({ term: "java to python" }, { term: "python to java" }, "en").same).toBe(false);
    expect(sameIntent({ term: "pdf to word" }, { term: "word to pdf" }, "en").same).toBe(false);
    expect(sameIntent({ term: "how to convert java to python" }, { term: "python to java" }, "en").same).toBe(false);
    expect(sameIntent({ term: "java to python" }, { term: "java into python" }, "en").same).toBe(true);
    expect(sameIntent({ term: "hubspot vs salesforce" }, { term: "salesforce vs hubspot" }, "en").same).toBe(true);
    // "how to" keeps its shape and still folds the rest.
    expect(sameIntent({ term: "how to write seo content" }, { term: "how to write content for seo" }, "en").same).toBe(true);
  });

  it("by results pages: the overlap decides, and sharing a word is not sharing a search", () => {
    const base = page("crm");
    const a = { term: A, organicUrls: base };
    const b = { term: B, organicUrls: serp(base, 8, "b") };
    const c = { term: C, organicUrls: serp(base, 2, "c") };
    expect(sameIntent(a, b, "en")).toEqual({ same: true, basis: "serp", shared: 8 });
    expect(sameIntent(a, c, "en")).toEqual({ same: false, basis: "serp", shared: 2 });
  });

  it("does not merge unrelated keywords that share one word", () => {
    expect(sameIntent({ term: "crm pricing" }, { term: "crm software" }, "en").same).toBe(false);
    expect(sameIntent({ term: "website design" }, { term: "website hosting" }, "en").same).toBe(false);
    expect(sameIntent({ term: "web tasarım fiyatları" }, { term: "web hosting fiyatları" }, "tr").same).toBe(false);
    // Three shared homepages are a thin local market, not one search.
    const base = page("local");
    expect(sameIntent({ term: "web tasarım", organicUrls: base }, { term: "mobil uygulama", organicUrls: serp(base, SERP_SAME_INTENT_SHARED - 1, "m") }, "tr").same).toBe(false);
  });

  it("the results page outranks the words when both were bought", () => {
    // Same words, different pages: the measured answer wins.
    expect(sameIntent({ term: "agency seo", organicUrls: page("a") }, { term: "seo for agencies", organicUrls: page("b") }, "en")).toEqual({ same: false, basis: "serp", shared: 0 });
  });

  it("one query typed twice is one search, whatever two results pages bought weeks apart say", () => {
    expect(sameIntent({ term: "Best CRM", organicUrls: page("a") }, { term: "best crm", organicUrls: page("b") }, "en")).toEqual({ same: true, basis: "words" });
  });

  it("compares results pages by host and path, not by scheme, www or trailing slash", () => {
    const left = ["https://www.one.example/a/", "https://two.example/b", "https://three.example/c", "https://four.example/d"];
    const right = ["http://one.example/a", "https://www.two.example/b/", "https://three.example/c", "https://four.example/d/"];
    expect(sameIntent({ term: "x crm", organicUrls: left }, { term: "y tool", organicUrls: right }, "en")).toEqual({ same: true, basis: "serp", shared: 4 });
  });

  it("keeps the query string that names a page, and drops the one that only tracks a click", () => {
    expect(canonicalPage("https://www.youtube.com/watch?v=a1")).toBe("youtube.com/watch?v=a1");
    expect(canonicalPage("https://www.youtube.com/watch?v=a1")).not.toBe(canonicalPage("https://www.youtube.com/watch?v=b2"));
    expect(canonicalPage("https://shop.example/p/?srsltid=AfmBOx&utm_source=g")).toBe("shop.example/p");
    expect(canonicalPage("https://site.example/a?b=2&a=1")).toBe(canonicalPage("https://site.example/a/?a=1&b=2"));
    // Two results pages that each hold some video do not share a page for it.
    const videos = (tag: string) => [0, 1, 2, 3].map((i) => `https://www.youtube.com/watch?v=${tag}${i}`);
    expect(sharedResults([...videos("a"), ...page("x", 6)], [...videos("b"), ...page("y", 6)])).toBe(0);
  });

  it("a results page too thin to reach the bar is not compared as one", () => {
    const three = page("thin", 3);
    expect(sameIntent({ term: "crm pricing", organicUrls: three }, { term: "crm cost", organicUrls: three }, "en").basis).toBe("words");
  });
});

describe("clusterByIntent: the leader is whatever is furthest along", () => {
  type T = StagedTopic & { id: string };
  const t = (id: string, term: string, stage: T["stage"], organicUrls: string[] | null = null): T => ({ id, term, stage, organicUrls });

  it("a drafted keyword leads its cluster even when a candidate ranks above it", () => {
    const drafted = t("d", SIRKETLERI, "drafted", DRAFTED_SERP);
    const queued = t("q", FIRMALARI, "scheduled", serp(DRAFTED_SERP, 6, "q"));
    const held = t("h", FIRMASI, "candidate", serp(DRAFTED_SERP, 5, "h"));
    const other = t("o", "kurumsal web tasarım", "candidate", page("o"));
    const followers = clusterByIntent([held, other, queued, drafted], "tr");
    expect(followers.get(held)?.leader).toBe(drafted);
    expect(followers.get(queued)?.leader).toBe(drafted);
    expect(followers.has(drafted)).toBe(false);
    expect(followers.has(other)).toBe(false);
  });

  it("live beats drafted beats scheduled, and among equals the caller's order wins", () => {
    const live = t("l", "seo agency", "live");
    const drafted = t("d", "agency seo", "drafted");
    const scheduled = t("s", "seo agencies", "scheduled");
    const first = t("c1", "agencies for seo", "candidate");
    const second = t("c2", "seo for agency", "candidate");
    const followers = clusterByIntent([second, first, scheduled, drafted, live], "en");
    for (const x of [drafted, scheduled, first, second]) expect(followers.get(x)?.leader).toBe(live);

    const pair = clusterByIntent([first, second], "en");
    expect(pair.get(second)?.leader).toBe(first);
    expect(pair.has(first)).toBe(false);
  });

  it("between two phrasings on the calendar, the one due first leads, whatever the caller's order", () => {
    const later = { ...t("late", "seo agencies", "scheduled"), date: "2026-10-20" };
    const sooner = { ...t("soon", "agency seo", "scheduled"), date: "2026-09-26" };
    const undated = t("none", "seo for agency", "scheduled");
    const followers = clusterByIntent([later, undated, sooner], "en");
    expect(followers.get(later)?.leader).toBe(sooner);
    expect(followers.get(undated)?.leader).toBe(sooner);
    expect(followers.has(sooner)).toBe(false);
  });

  it("marks a words-only join in a language without rules", () => {
    const followers = clusterByIntent([t("a", "Agenzia SEO", "drafted"), t("b", "agenzia seo", "candidate")], "it");
    expect([...followers.values()][0].match).toEqual({ same: true, basis: "words" });
  });
});

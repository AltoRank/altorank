/**
 * Turkish, through every module that reads or writes article text.
 *
 * A real signup (2026-09-22, a Turkish web/mobile agency) got a Turkish draft
 * with "Contents", "Learn more about… / This article is published by…" and
 * English alt text written into it; its "%20" and "Gartner'a göre" unseen by
 * the fact checker; its "we" (a suffix, not the word "biz") unseen by the
 * voice analyser; its scores computed with English rules; its anchors garbled
 * by a slugifier that dropped the dotless ı. Each describe below is one of
 * those, with the English reading beside it where the difference is the point.
 */
import { describe, it, expect } from "vitest";
import { TR_ARTICLE, TR_CLAIMS, TR_VOICE_SAMPLE, TR_KEYWORD, TR_DOMAIN, TR_BUSINESS, TR_LONG, TR_SECTION } from "./fixtures";
import { enrichArticle } from "@/lib/content/enrich";
import { addTableOfContents } from "@/lib/content/enrich/toc";
import { addCallToAction } from "@/lib/content/enrich/cta";
import { addSectionImages } from "@/lib/content/enrich/images";
import { renderVideoFigure } from "@/lib/content/enrich/video";
import { addInfographics, chartFromBeforeAfter, chartFromList, extractMeasures } from "@/lib/content/enrich/infographic";
import { opensWithDirectAnswer, boldCitableClaims } from "@/lib/content/enrich/format";
import { buildFaqSchema } from "@/lib/content/enrich/faq";
import { slugFor } from "@/lib/content/generate";
import { factCheckArticle, findAttribution } from "@/lib/ai/fact-check";
import { figureVariants, pageHasFigure, readablePageText, verifyCitedFigures } from "@/lib/seo/citation-check";
import { findSourcesFooter, checkInlineCitations } from "@/lib/ai/inline-citations";
import { checkAltText } from "@/lib/ai/alt-text";
import { analyzeVoiceLocally } from "@/lib/voice/train";
import { voiceLanguageNote } from "@/lib/ai/voice-analyzer";
import { scoreArticle } from "@/lib/seo/scoring";
import { scoreCitationReadiness, findFigures } from "@/lib/seo/aeo-scoring";
import { auditArticle } from "@/lib/seo/article-audit";
import { buildSystemPrompt } from "@/lib/ai/prompts";

/** English strings the product used to write into a Turkish article. */
const ENGLISH_LEAKS = [
  "Contents",
  "Learn more about",
  "This article is published by",
  "Visit ",
  "Sketch illustrating",
  "Watercolour",
  "Illustration of",
  "Bar chart",
  "Figures from the text",
  "Key takeaways",
  "Frequently asked questions",
];

const ids = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const hrefs = (html: string) => [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);

describe("Turkish: labels written into the article", () => {
  it("the whole enrichment pass writes Turkish labels and no English", async () => {
    const { html, report } = await enrichArticle(TR_ARTICLE, {
      workspaceId: "ws",
      keyword: TR_KEYWORD,
      title: "Web tasarımı",
      domain: TR_DOMAIN,
      businessName: TR_BUSINESS,
      language: "tr",
      imageProducer: async (_brief, i) => `https://cdn.example/${i}.webp`,
      maxImages: 1,
      videoSearch: async () => [{ videoId: "vid123", title: "Kurulum rehberi", channelTitle: "Acme TV" } as never],
      fetchTitle: async () => null,
    });

    expect(html).toContain('<nav class="toc" aria-label="İçindekiler"><p><strong>İçindekiler</strong></p>');
    expect(html).toContain('<h2 id="acme-ajans-hakkinda-daha-fazla-bilgi">Acme Ajans hakkında daha fazla bilgi</h2>');
    expect(html).toContain(
      'Bu makale Acme Ajans tarafından yayımlanmıştır. <a href="https://acme-agency.example">acme-agency.example</a> adresini ziyaret edin.',
    );
    expect(html).toContain("<figcaption>Video: Kurulum rehberi (Acme TV, YouTube)</figcaption>");
    expect(html).toContain('aria-label="Çubuk grafik: Başlangıç paketi 1500 ₺, Kurumsal paket 4500 ₺, E-ticaret paketi 9000 ₺"');
    expect(html).toContain("<figcaption>Metindeki rakamlar: “Başlangıç paketi: 1.500 TL;");
    for (const leak of ENGLISH_LEAKS) expect(html, leak).not.toContain(leak);

    expect(report.language).toEqual({ code: "tr", name: "Turkish", supported: true });
    expect(report).toMatchObject({ toc: true, cta: true, video: true, infographics: 2, faq: 2 });
    expect(report.warnings).toEqual([]);
  });

  it("section images carry a Turkish style label and a Turkish-length alt", async () => {
    const html = TR_SECTION("Yazılım seçimi", `${TR_LONG} ${TR_LONG}`) + TR_SECTION("Diğer", "Kısa.");
    const { html: out, added } = await addSectionImages(html, {
      produce: async () => "https://cdn.example/1.webp",
      style: "sketch",
      language: "tr",
    });
    expect(added).toBe(1);
    const alt = out.match(/alt="([^"]+)"/)?.[1] ?? "";
    expect(alt.startsWith("Eskiz çizim: Yazılım seçimi: ")).toBe(true);
    expect(alt).not.toMatch(/Sketch|illustrating/);
    // Five Turkish words is the floor (six English), and the alt the step
    // writes passes the audit's own check.
    expect(checkAltText(alt, TR_KEYWORD, "tr")).toBeNull();
  });

  it("the call to action, the TOC and the video caption each read the contract directly", () => {
    const cta = addCallToAction("<p>x</p>", { domain: TR_DOMAIN, businessName: TR_BUSINESS, language: "tr" }).html;
    expect(cta).toContain("adresini ziyaret edin.");
    expect(renderVideoFigure({ videoId: "v", title: "T", channelTitle: "C" } as never, "tr")).toContain("Video: T (C, YouTube)");
    expect(addTableOfContents(TR_ARTICLE, { language: "tr" }).html).toContain("<strong>İçindekiler</strong>");
  });
});

describe("Turkish: anchors match headings", () => {
  it("every TOC link points at a heading id, with ı ş ğ ç ö ü İ folded", () => {
    const { html, added } = addTableOfContents(TR_ARTICLE, { language: "tr" });
    expect(added).toBe(true);
    expect(hrefs(html)).toEqual([
      "yazilim-secimi-neden-onemlidir",
      "sirketler-icin-olcum-araclari",
      "icerik-stratejisi-nasil-kurulur",
      "guclu-bir-cagri-cumlesi",
      "sikca-sorulan-sorular",
    ]);
    const headingIds = new Set(ids(html));
    for (const h of hrefs(html)) expect(headingIds.has(h), h).toBe(true);
    // None garbled: the old fold dropped ı and turned "Yazılım" into "yaz-l-m".
    expect(html).not.toMatch(/id="[^"]*-l-m/);
  });

  it("the URL slug uses the same fold", () => {
    expect(slugFor("Yazılım seçimi neden önemlidir?")).toBe("yazilim-secimi-neden-onemlidir");
    expect(slugFor("İstanbul'da ölçüm araçları")).toBe("istanbul-da-olcum-araclari");
  });
});

describe("Turkish: the fact checker reads figures and sources", () => {
  const read = (html: string) => factCheckArticle(html, undefined, "tr").claims;

  it("sees %20, yüzde 65, ₺1.500,50 and 1.500,50 TL, which the English rules did not", () => {
    expect(read(TR_CLAIMS.bareSignBefore)).toMatchObject([{ figures: ["%20"], kind: "statistic", status: "unsourced", severity: "high" }]);
    expect(read(TR_CLAIMS.bareWordBefore)).toMatchObject([{ figures: ["yüzde 65"], kind: "statistic" }]);
    expect(read(TR_CLAIMS.money)).toMatchObject([{ figures: ["₺1.500,50"], kind: "money" }]);
    // The bare "1.500,50" the grouped-number rule also finds is the same figure.
    expect(read(TR_CLAIMS.moneyAfter)).toMatchObject([{ figures: ["1.500,50 TL"], kind: "money" }]);
    expect(read(TR_CLAIMS.multiplier)).toMatchObject([{ figures: ["3 kat daha"], kind: "multiplier" }]);
    expect(read(TR_CLAIMS.largeCount)).toMatchObject([{ figures: ["20 milyon kullanıcıya"], kind: "large_count" }]);
    expect(read(TR_CLAIMS.hollow)).toMatchObject([{ kind: "research_reference", status: "unsourced" }]);

    // The same sentences under the English rules: nothing, or only the ₺.
    expect(factCheckArticle(TR_CLAIMS.bareSignBefore, undefined, "en").claims).toEqual([]);
    expect(factCheckArticle(TR_CLAIMS.bareWordBefore, undefined, "en").claims).toEqual([]);
    expect(factCheckArticle(TR_CLAIMS.hollow, undefined, "en").claims).toEqual([]);
  });

  it("names the source a postposition attributes the claim to", () => {
    expect(read(TR_CLAIMS.attributedApostrophe)).toMatchObject([{ figures: ["%12"], status: "needs_verification", attribution: "Gartner" }]);
    expect(read(TR_CLAIMS.attributedNoun)).toMatchObject([{ attribution: "Dünya Bankası" }]);
    expect(findAttribution("TÜİK tarafından yayımlanan verilere göre oran %4 arttı.", "tr")).toBe("TÜİK");
    expect(findAttribution("Statista'nın verileri bunu doğruluyor.", "tr")).toBe("Statista");
    // "Buna göre" is "accordingly", not a source.
    expect(read(TR_CLAIMS.accordingly)).toMatchObject([{ status: "unsourced", attribution: null }]);
  });

  it("splits sentences at a Turkish capital, so a source stays with its own figure", () => {
    const claims = read("<p>Şirketlerin %40'ı mobil öncelikli. İlk adım Gartner'a göre %12 büyüme.</p>");
    expect(claims.map((c) => [c.figures, c.attribution])).toEqual([
      [["%40"], null],
      [["%12"], "Gartner"],
    ]);
  });

  it("carries the language on the report", () => {
    expect(factCheckArticle(TR_CLAIMS.money, undefined, "tr").language).toEqual({ code: "tr", name: "Turkish", supported: true });
  });
});

describe("Turkish: the citation check reads the figure, then looks for it every way", () => {
  it("finds %20 on an English page and ₺1.500,50 written 1,500.50", () => {
    expect(figureVariants("%20", "tr")).toEqual(expect.arrayContaining(["%20", "20%", "yüzde 20", "20 percent"]));
    expect(pageHasFigure(readablePageText("<p>about 20% of small firms</p>"), "%20", "tr")).toBe(true);
    expect(pageHasFigure(readablePageText("<p>Yüzde 20'si</p>"), "%20", "tr")).toBe(true);
    expect(pageHasFigure(readablePageText("<p>costs TRY 1,500.50 a year</p>"), "₺1.500,50", "tr")).toBe(true);
    expect(pageHasFigure(readablePageText("<p>1500,50 TL</p>"), "1.500,50 TL", "tr")).toBe(true);
    expect(pageHasFigure(readablePageText("<p>about 30% of small firms</p>"), "%20", "tr")).toBe(false);
    // Read as English, "1.500,50" is not a number anyone can find.
    expect(figureVariants("1.500,50 TL", "tr")).not.toContain("1.50050");
  });

  it("re-judges a Turkish claim against the page it cites", async () => {
    const html = `<p>Gartner'a göre pazar %12 büyüdü. <a href="https://research.example/report">rapor</a></p>`;
    const page = `<p>${"Market data. ".repeat(40)} The market grew 12% last year.</p>`;
    const report = await verifyCitedFigures(factCheckArticle(html, undefined, "tr"), {
      fetcher: async () => ({ status: 200, body: page }),
    });
    expect(report.claims[0]).toMatchObject({ status: "verified", figures: ["%12"] });
    expect(report.language?.code).toBe("tr");
  });
});

describe("Turkish: the voice analyser hears 'we' in a suffix", () => {
  it("tags first-person plural, address and imperatives from suffixes, not only pronouns", () => {
    const tr = analyzeVoiceLocally(TR_VOICE_SAMPLE, "tr");
    expect(tr.tags).toEqual(expect.arrayContaining(["first-person plural", "direct address", "direct"]));
    // No English contraction rule on a language that has none.
    expect(tr.tags).not.toContain("formal (no contractions)");
    expect(TR_VOICE_SAMPLE).not.toMatch(/\bbiz\b/i);

    // The English rules on the same sample: the bug.
    const en = analyzeVoiceLocally(TR_VOICE_SAMPLE, "en");
    expect(en.tags).not.toContain("first-person plural");
    expect(en.tags).toContain("formal (no contractions)");
  });

  it("tells the model the sample's language", () => {
    const note = voiceLanguageNote("tr");
    expect(note).toContain("written in Turkish");
    expect(note).toContain("possessive suffixes");
  });
});

describe("Turkish: scores and the audit use Turkish rules", () => {
  it("SEO: keyword with suffixes, Turkish casing, Turkish sentence and length bands", () => {
    const html = `<h1>İSTANBUL'DA WEB TASARIM</h1><p>Web tasarımında hız önemlidir. İyi bir web tasarımı dönüştürür.</p>`;
    const tr = scoreArticle(html, "istanbul", { language: "tr" });
    expect(tr.checks.find((c) => c.name === "keywordInTitle")?.passed).toBe(true);
    expect(scoreArticle(html, "istanbul", { language: "en" }).checks.find((c) => c.name === "keywordInTitle")?.passed).toBe(false);

    const density = (lang: string) => scoreArticle(html, "web tasarım", { language: lang }).checks.find((c) => c.name === "keywordDensity");
    expect(density("tr")?.note).not.toBe("Keyword density: 0.0% (target: 0.5-2%)");
    expect(density("en")?.note).toBe("Keyword density: 0.0% (target: 0.5-2%)");

    const full = scoreArticle(TR_ARTICLE, TR_KEYWORD, { language: "tr" });
    expect(full.checks.find((c) => c.name === "readability")?.note).toContain("(target: 8-20)");
    expect(full.checks.find((c) => c.name === "wordCount")?.note).toContain("(target: 1200+)");
    expect(full.checks.every((c) => !c.unverified)).toBe(true);
  });

  it("AEO: a Turkish definition, Turkish figures and a Turkish summary heading count", () => {
    const html = TR_ARTICLE.replace(
      "<h2>Yazılım",
      "<h2>Öne çıkan noktalar</h2><ul><li>Hız dönüşümü artırır.</li><li>Sade yapı güven verir.</li><li>Ölçmeden karar vermeyin.</li></ul><h2>Yazılım",
    ) + "<p>Mobil trafiğin payı yüzde 65, masaüstünün payı %35 oldu.</p>";
    const byName = (lang: string) =>
      Object.fromEntries(scoreCitationReadiness(html, TR_KEYWORD, { language: lang }).checks.map((c) => [c.name, c.passed]));
    const tr = byName("tr");
    expect(tr).toMatchObject({ definitionBlock: true, quotableStatistics: true, summaryBox: true });
    // Read as English, the same article has no definition and no figures.
    expect(byName("en")).toMatchObject({ definitionBlock: false, quotableStatistics: false });
    expect(findFigures("%20, yüzde 30 ve ₺1.500 ile 3 milyon", "tr")).toEqual(["%20", "yüzde 30", "₺1.500", "3 milyon"]);
    expect(scoreCitationReadiness(html, TR_KEYWORD, { language: "tr" }).score).toEqual(expect.any(Number));
  });

  it("audit: Turkish figures, sources, evidence appeals, FAQ heading and first-hand markers", () => {
    const html =
      TR_ARTICLE +
      TR_CLAIMS.bareSignBefore +
      TR_CLAIMS.attributedApostrophe +
      TR_CLAIMS.hollow +
      "<p>Kendi testlerimizde sayfa hızı yarıya indi.</p><p>Yazar: Ayşe Yılmaz</p>";
    const items = Object.fromEntries(
      auditArticle({ html, keyword: TR_KEYWORD, siteDomain: TR_DOMAIN, language: "tr" }).items.map((i) => [i.id, i]),
    );
    expect(items["unsourced-figures"]).toMatchObject({ status: "fail" });
    expect(items["unsourced-figures"].locate).toEqual(expect.arrayContaining(["%20", "%12"]));
    expect(items["named-sources"].locate).toContain("Gartner");
    expect(items["hollow-evidence"]).toMatchObject({ status: "warn", locate: ["Araştırmalar gösteriyor"] });
    expect(items["faq-section"].status).toBe("pass");
    expect(items["first-hand"].status).toBe("pass");
    expect(items.author.status).toBe("pass");
  });

  it("alt text: the keyword with a Turkish image wrapper is still the keyword alone", () => {
    expect(checkAltText("Web tasarımı görseli", TR_KEYWORD, "tr")).toBe("keyword");
    // Five Turkish words describe what six English ones do.
    expect(checkAltText("Mobil uyumlu ana sayfa taslağı", TR_KEYWORD, "tr")).toBeNull();
    expect(checkAltText("Mobil uyumlu ana sayfa taslağı", TR_KEYWORD, "en")).toBe("short");
  });
});

describe("Turkish: the rest of the enrichment reads Turkish prose", () => {
  it("charts %42'den %61'e, and 1.500 TL lists, with Turkish bar labels", () => {
    const spec = chartFromBeforeAfter("Dönüşüm oranı %42'den %61'e yükseldi.", "tr");
    expect(spec?.data).toEqual([
      { label: "Önce", value: 42 },
      { label: "Sonra", value: 61 },
    ]);
    expect(chartFromBeforeAfter("Şirket 2019'dan 2024'e büyüdü.", "tr")).toBeNull();
    expect(chartFromList("<ul><li>A: 1.500 TL</li><li>B: 4.500,50 TL</li><li>C: 9.000 TL</li></ul>", "tr")?.data.map((d) => d.value)).toEqual([
      1500, 4500.5, 9000,
    ]);
    expect(extractMeasures("Kurulum 12 saat, bakım %20 indirimli.", "tr").map((m) => [m.value, m.unit])).toEqual([
      [12, "hours"],
      [20, "%"],
    ]);
    const { html } = addInfographics(TR_SECTION("Paketler", "<ul><li>A: 12 saat</li><li>B: 24 saat</li><li>C: 36 saat</li></ul>"), { language: "tr" });
    expect(html).toContain(">12 saat</text>");
  });

  it("direct answers, bolded claims and the FAQ schema", () => {
    expect(opensWithDirectAnswer("<p>Bu bölümde web tasarımının ne olduğuna bakacağız.</p>", "tr")).toBe(false);
    expect(opensWithDirectAnswer("<p>Web tasarımı, bir sitenin planlanmasıdır. Devamı aşağıda.</p>", "tr")).toBe(true);
    const bolded = boldCitableClaims(TR_SECTION("Pazar", "Gartner'a göre pazar %12 büyüdü. Bu önemli bir artış."), "tr");
    expect(bolded).toMatchObject({ bolded: 1 });
    expect(bolded.html).toContain("<strong>Gartner'a göre pazar %12 büyüdü.</strong>");
    expect(buildFaqSchema(TR_ARTICLE).count).toBe(2);
  });

  it("recognises a Turkish sources footer", () => {
    const html = `<p>Bir iddia.</p><h2>Kaynakça</h2><ul><li><a href="https://data.example/a">Rapor</a></li></ul>`;
    expect(findSourcesFooter(html)?.label).toBe("kaynakça");
    expect(checkInlineCitations(html).orphaned).toHaveLength(1);
    expect(findSourcesFooter(`<p>x</p><h3>İLERİ OKUMA</h3>`)?.label).toBe("ileri okuma");
  });
});

describe("Turkish: the prompt asks for Turkish labels", () => {
  it("takes the FAQ heading and the summary label from the contract", () => {
    const prompt = buildSystemPrompt({ keyword: TR_KEYWORD, language: "Turkish", output: { faq: true } });
    expect(prompt).toContain("<h2>Sıkça sorulan sorular</h2>");
    expect(prompt).toContain('(such as "Öne çıkan noktalar")');
    expect(prompt).not.toContain("<h2>Frequently asked questions</h2>");
  });

  it("is unchanged for English", () => {
    const prompt = buildSystemPrompt({ keyword: "crm", output: { faq: true } });
    expect(prompt).toContain("<h2>Frequently asked questions</h2>");
    expect(prompt).toContain('(such as "Key takeaways")');
  });
});

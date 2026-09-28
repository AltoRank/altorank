import { describe, it, expect } from "vitest";
import { sensitiveTopicOf, chooseReviewer, buildTrust, applyTrustBlock, datelineHtml } from "../trust";
import { buildSiteFacts, type SitePageRow } from "../site-facts";
import { extractSitePage, peopleOn } from "@/lib/audit/site-extract";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { auditArticle } from "@/lib/seo/article-audit";
import { supportedLocales, resolveLocale, SENSITIVE_KINDS, type SupportedLocale } from "@/lib/i18n/locale";

// A real signup's first article (2026-09-27, a physiotherapy clinic) was a
// health article with no reviewer, no disclaimer and no date. The clinic's
// about page named its physiotherapists. The clinic and people below are
// invented.

const DOMAIN = "acme-physio.example";
const O = `https://${DOMAIN}`;
const CLINIC = {
  name: "Acme Physio",
  description: "Sports physiotherapy and athletic therapy for active adults.",
  offerings: ["Sports physiotherapy", "Athletic therapy", "Concussion care"],
  audiences: ["Runners", "Weekend athletes"],
};
const AGENCY = {
  name: "Acme Digital",
  description: "SEO and web design for small businesses, including legal pages and privacy policies.",
  offerings: ["SEO audits", "Web design"],
};

const TEAM_PAGE = `<!doctype html><html><head><title>Our Team | Acme Physio</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Robin Vale","jobTitle":"Clinic Owner"}</script>
</head><body><main><h1>Our Team</h1>
<h2>Meet the team</h2>
<h3>Sam Lee</h3><p>Registered Physiotherapist, MScPT</p>
<h3>Jordan Park</h3><p>Certified Athletic Therapist</p>
<p>Alex Moreno, Front Desk Coordinator</p>
<h3>Sports Physiotherapy</h3><p>Our registered physiotherapists treat sports injuries of every kind.</p>
</main></body></html>`;

const row = (url: string, html: string): SitePageRow => ({ url, title: null, h1: null, page_type: "page", status: 200, extract: extractSitePage(html, url) });

describe("sensitiveTopicOf: one decision, stated with its evidence", () => {
  it("reads a health topic from the keyword", () => {
    const { topic } = sensitiveTopicOf({ keyword: "physiotherapy vs athletic therapy", profile: CLINIC, language: "en" });
    expect(topic?.kind).toBe("health");
    expect(topic?.evidence).toMatch(/the topic names "physiotherapy", "therapy"/);
  });

  it("reads it from the business when the keyword is neutral, but only on two words", () => {
    expect(sensitiveTopicOf({ keyword: "what to wear to your first appointment", profile: CLINIC }).topic?.evidence).toMatch(/business profile names/);
    // One passing "legal" in an agency profile is not a law firm.
    expect(sensitiveTopicOf({ keyword: "how to write a meta description", profile: AGENCY }).topic).toBeNull();
  });

  it("recognises the topic in every supported language", () => {
    const cases: Array<[string, string, string]> = [
      ["tr", "fizyoterapi mi atletik terapi mi", "health"],
      ["it", "avvocato per divorzio consensuale", "legal"],
      ["es", "cómo declarar impuestos siendo autónomo", "financial"],
      ["fr", "détecteur de monoxyde de carbone obligatoire", "safety"],
      ["de", "Physiotherapie nach Kreuzbandriss", "health"],
    ];
    for (const [lang, keyword, kind] of cases) {
      expect(sensitiveTopicOf({ keyword, language: lang }).topic?.kind, keyword).toBe(kind);
    }
  });

  it("says a language without word lists was not checked, rather than calling the topic safe", () => {
    const trust = buildTrust({ keyword: "理学療法とは", language: "ja", people: [] });
    expect(trust.sensitive).toBeNull();
    expect(trust.basis).toMatch(/Japanese has no word list/);
    expect(trust.notes[0]).toMatch(/not checked for Japanese/);
  });
});

describe("the reviewer comes only from people the site's own pages name", () => {
  it("reads the team from an about page: name then role, name-comma-role, and structured data", () => {
    const html = TEAM_PAGE.replace("<p>Alex Moreno, Front Desk Coordinator</p>", "<p>Casey Ng, Registered Massage Therapist</p>");
    const people = extractSitePage(html, `${O}/team`)?.people;
    expect(people).toEqual([
      { name: "Robin Vale", role: "Clinic Owner", from: "structured-data" },
      { name: "Sam Lee", role: "Registered Physiotherapist, MScPT" },
      { name: "Jordan Park", role: "Certified Athletic Therapist" },
      { name: "Casey Ng", role: "Registered Massage Therapist" },
    ]);
    // A line without a professional role is not a role: the front desk is left out.
    expect(extractSitePage(TEAM_PAGE, `${O}/team`)?.people?.map((p) => p.name)).not.toContain("Alex Moreno");
  });

  it("does not take a service heading or a section label for a person", () => {
    const names = peopleOn("<h2>Meet the team</h2><p>Registered Physiotherapist</p><h3>Sports Physiotherapy</h3><p>Our physiotherapists treat injuries.</p>", "", { text: true }).map((p) => p.name);
    expect(names).toEqual([]);
  });

  it("carries the people into the site facts with the page they are on", () => {
    const facts = buildSiteFacts([row(`${O}/team`, TEAM_PAGE)], DOMAIN);
    expect(facts.people.find((p) => p.name === "Sam Lee")).toEqual({ name: "Sam Lee", role: "Registered Physiotherapist, MScPT", source: `${O}/team` });
  });

  it("picks the person whose stated role fits the topic, and nobody else", () => {
    const facts = buildSiteFacts([row(`${O}/team`, TEAM_PAGE)], DOMAIN);
    expect(chooseReviewer(facts.people, "health")?.name).toBe("Sam Lee");
    expect(chooseReviewer(facts.people, "legal")).toBeNull();
  });

  it("names the reviewer in the review notes and asks for their sign-off", () => {
    const facts = buildSiteFacts([row(`${O}/team`, TEAM_PAGE)], DOMAIN);
    const trust = buildTrust({ keyword: "physiotherapy vs athletic therapy", language: "en", people: facts.people });
    expect(trust.reviewer).toEqual({ name: "Sam Lee", role: "Registered Physiotherapist, MScPT", source: `${O}/team` });
    expect(trust.notes[0]).toMatch(/Publish only once Sam Lee has reviewed it/);
  });

  it("says so when no one fits, and never invents a person", () => {
    const trust = buildTrust({
      keyword: "physiotherapy vs athletic therapy",
      language: "en",
      people: [{ name: "Alex Moreno", role: "Front Desk Coordinator", source: `${O}/team` }],
    });
    expect(trust.reviewer).toBeNull();
    expect(trust.notes[0]).toMatch(/^No reviewer found on the site - add one before publishing\./);
    expect(trust.notes[0]).toMatch(/Alex Moreno \(Front Desk Coordinator\), none with a health role/);
    const { html } = applyTrustBlock("<p>Intro.</p>", trust, "en");
    expect(html).not.toContain("article-reviewer");
  });
});

describe("the trust block written into the article", () => {
  const trust = buildTrust({
    keyword: "physiotherapy vs athletic therapy",
    language: "en",
    people: [{ name: "Sam Lee", role: "Registered Physiotherapist", source: `${O}/team` }],
  });

  it("puts the reviewer line first and the disclaimer before the call to action, once", () => {
    const body = `<p>Intro.</p><h2>Which one?</h2><p>It depends.</p><section class="cta"><h2>Learn more</h2><p>x</p></section>`;
    const first = applyTrustBlock(body, trust, "en");
    expect(first.html.startsWith('<p class="article-reviewer"><em>Reviewed by Sam Lee, Registered Physiotherapist.</em></p>')).toBe(true);
    expect(first.html).toMatch(/not medical advice[^<]*<\/em><\/p>\n<section class="cta">/);
    expect(applyTrustBlock(first.html, trust, "en")).toEqual({ html: first.html, reviewer: false, disclaimer: false });
    // The audit reads the reviewer line as the byline it is.
    expect(auditArticle({ html: first.html, keyword: "physiotherapy", title: "t" }).items.find((i) => i.id === "author")?.status).toBe("pass");
  });

  it("writes nothing into an article that is not sensitive", () => {
    const plain = buildTrust({ keyword: "how to write a meta description", language: "en", people: [] });
    expect(applyTrustBlock("<p>x</p>", plain, "en").html).toBe("<p>x</p>");
  });

  it("has a disclaimer for every kind in every supported language, none of them English outside English", () => {
    const en = resolveLocale("en") as SupportedLocale;
    for (const l of supportedLocales()) {
      for (const kind of SENSITIVE_KINDS) {
        expect(l.labels.disclaimer[kind].length, `${l.code}.${kind}`).toBeGreaterThan(40);
        if (l.code !== "en") expect(l.labels.disclaimer[kind]).not.toBe(en.labels.disclaimer[kind]);
      }
      expect(l.labels.reviewedBy).toContain("{name}");
      expect(l.labels.published).toContain("{date}");
    }
    const tr = buildTrust({ keyword: "fizyoterapi mi atletik terapi mi", language: "tr", people: [] });
    expect(applyTrustBlock("<p>Giriş.</p>", tr, "tr").html).toContain("tıbbi tavsiye yerine geçmez");
  });

  it("writes no English into a language the contract does not describe, and says what is missing", () => {
    const pt = buildTrust({ keyword: "fisioterapia ou terapia atlética", language: "pt", people: [{ name: "Sam Lee", role: "Fisioterapeuta", source: `${O}/equipe` }] });
    expect(pt.sensitive?.kind).toBe("health");
    expect(pt.disclaimer).toBeNull();
    expect(applyTrustBlock("<p>x</p>", pt, "pt").html).toBe("<p>x</p>");
    expect(pt.notes.join(" ")).toMatch(/No reviewer line or disclaimer was written into the article: their wording exists for .* Add them in Portuguese/);
  });

  it("tells the writer what the topic asks, and not to invent a reviewer", () => {
    const p = buildSystemPrompt({ keyword: "physiotherapy vs athletic therapy", sensitive: trust.sensitive });
    expect(p).toContain("THIS IS A HEALTH TOPIC");
    expect(p).toContain("never name a");
    expect(p).toContain("a qualified health professional");
    expect(buildSystemPrompt({ keyword: "x" })).not.toContain("TOPIC (");
  });
});

describe("the dateline, written at publish on every article", () => {
  it("shows the first publish, and the update only on a later day", () => {
    expect(datelineHtml("en", { publishedAt: "2026-09-28T08:00:00Z", modifiedAt: "2026-09-28T18:00:00Z" })).toBe(
      '<p class="article-dates"><em>Published September 28, 2026</em></p>',
    );
    expect(datelineHtml("en", { publishedAt: "2026-09-01T08:00:00Z", modifiedAt: "2026-09-28T08:00:00Z" })).toBe(
      '<p class="article-dates"><em>Published September 1, 2026 · Updated September 28, 2026</em></p>',
    );
  });

  it("is in the article's language, and absent in a language the contract does not describe", () => {
    expect(datelineHtml("de", { publishedAt: "2026-09-01T08:00:00Z", modifiedAt: "2026-09-01T08:00:00Z" })).toContain("Veröffentlicht am 1. September 2026");
    expect(datelineHtml("ja", { publishedAt: "2026-09-01T08:00:00Z", modifiedAt: "2026-09-01T08:00:00Z" })).toBeNull();
  });
});

describe("review round 2026-09-28: sensitive-topic false positives", () => {
  it("does not read a word ordinary writing also uses in another sense as a sensitive topic on its own", () => {
    const cases: Array<[string, string]> = [
      ["en", "how to diagnose a drop in organic traffic"],
      ["en", "symptoms of a google penalty"],
      ["en", "technical debt in seo"],
      ["en", "legal pages every saas needs"],
      ["en", "investing in content marketing"],
      ["en", "seo poisoning attacks"],
      ["it", "impostazioni seo di wordpress"],
      ["it", "sintomi di una penalizzazione google"],
      ["es", "medición de resultados en marketing"],
      ["es", "ahorro de tiempo en marketing"],
      ["fr", "diagnostic seo gratuit"],
      ["de", "Kampagnensteuerung und Steuerung von Budgets"],
      ["tr", "web sitesi sağlık kontrolü"],
      ["tr", "dijital pazarlama yatırım getirisi"],
    ];
    for (const [language, keyword] of cases) {
      expect(sensitiveTopicOf({ keyword, language }).topic, `${language}: ${keyword}`).toBeNull();
    }
  });

  it("does not read another language's stem into an English word", () => {
    for (const keyword of ["kinetic typography trends", "ad placement strategies", "rehash old content", "investigate a traffic drop", "heritage brand storytelling"]) {
      expect(sensitiveTopicOf({ keyword, language: "en" }).topic, keyword).toBeNull();
    }
  });

  it("does not make every article of an SEO agency a health article", () => {
    const agency = {
      name: "Acme SEO",
      description: "We diagnose technical SEO problems, fix the symptoms and help you invest in content that pays back.",
      offerings: ["SEO audits"],
    };
    expect(sensitiveTopicOf({ keyword: "content calendar template", profile: agency, language: "en" }).topic).toBeNull();
  });

  it("still reads a weak word when the business is in the field", () => {
    const { topic } = sensitiveTopicOf({ keyword: "symptoms of a sprained ankle", profile: CLINIC, language: "en" });
    expect(topic?.kind).toBe("health");
    const backed = sensitiveTopicOf({ keyword: "what does a clinical assessment involve", profile: CLINIC, language: "en" }).topic;
    expect(backed?.kind).toBe("health");
    expect(backed?.evidence).toMatch(/in the business profile/);
  });
});

describe("review round 2026-09-28: people read from structured data", () => {
  it("keeps no review author and no name without a role", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "MedicalClinic",
      name: "Acme Physio",
      employee: [{ "@type": "Person", name: "Sam Lee", jobTitle: "Registered Physiotherapist" }, { "@type": "Person", name: "Alex Moreno" }],
      review: [{ "@type": "Review", author: { "@type": "Person", name: "Casey Customer", jobTitle: "Nurse" }, reviewBody: "Great" }],
    })}</script></head><body><main><p>Hello</p></main></body></html>`;
    const people = peopleOn(html, html, { text: false });
    expect(people.map((p) => p.name)).toEqual(["Sam Lee"]);
  });
});

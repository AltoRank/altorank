import { describe, it, expect, vi } from "vitest";
import { matchingOfferings, topicLinkNote, conversionLinkText } from "../topic-pages";
import { buildSiteFacts, directContact, resolveConversionPage, type SitePageRow } from "../site-facts";
import { addCallToAction } from "../enrich/cta";
import { extractSitePage } from "@/lib/audit/site-extract";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import type { SiteFacts } from "@/lib/ai/types";

// A real first article (2026-09-27, a physiotherapy clinic) compared two
// services the clinic sells. It linked two blog posts and the homepage, not
// the clinic's own page for either service, and closed on the homepage while
// the profile held the clinic's phone number. The clinic below is invented.

const DOMAIN = "acme-physio.example";
const O = `https://${DOMAIN}`;
const shell = (title: string, main: string) => `<!doctype html><html><head><title>${title}</title></head><body><main>${main}</main></body></html>`;
const row = (url: string, html: string): SitePageRow => ({ url, title: null, h1: null, page_type: "page", status: 200, extract: extractSitePage(html, url) });

const ROWS: SitePageRow[] = [
  row(`${O}/`, shell("Acme Physio", "<h1>Acme Physio</h1><p>Sports injury care.</p>")),
  row(
    `${O}/services`,
    shell(
      "Services",
      `<h1>Services</h1><p>
         <a href="/services/sports-physiotherapy">Sports Physiotherapy</a>
         <a href="/services/athletic-therapy">Athletic Therapy</a>
         <a href="/services/massage">Registered Massage</a></p>`,
    ),
  ),
  row(`${O}/services/sports-physiotherapy`, shell("Sports Physiotherapy", "<h1>Sports Physiotherapy</h1><p>Assessment and rehab.</p>")),
  row(`${O}/services/athletic-therapy`, shell("Athletic Therapy", "<h1>Athletic Therapy</h1><p>On-field care.</p>")),
];

const facts = buildSiteFacts(ROWS, DOMAIN);
const TOPIC = { keyword: "physiotherapy vs athletic therapy", title: "Physiotherapy vs Athletic Therapy: Which Fits Your Injury?" };

describe("the business's own pages for the article's topic", () => {
  it("picks the service pages that share the topic's words, never one without a fetched page", () => {
    const m = matchingOfferings(facts, TOPIC);
    expect(m.map((x) => x.url).sort()).toEqual([`${O}/services/athletic-therapy`, `${O}/services/sports-physiotherapy`]);
    expect(matchingOfferings(facts, { keyword: "knee brace sizing" })).toEqual([]);
    const noUrl: Pick<SiteFacts, "offerings"> = { offerings: [{ name: "Athletic Therapy", url: null }] };
    expect(matchingOfferings(noUrl, TOPIC)).toEqual([]);
  });

  it("puts them in the prompt ahead of blog articles", () => {
    const p = buildSystemPrompt({
      keyword: TOPIC.keyword,
      siteFacts: facts,
      internalLinkTargets: [{ title: "Five stretches after a run", keyword: "running stretches" }],
    });
    expect(p).toContain("Its own pages for what this article is about");
    expect(p).toContain(`- Athletic Therapy: ${O}/services/athletic-therapy`);
    expect(p).toContain("First link the business's own page for this topic");
    expect(p).toContain("Do not link\n  the homepage from the body");
  });

  it("notes a draft that links none of them, and is quiet when it links one", () => {
    const m = matchingOfferings(facts, TOPIC);
    expect(topicLinkNote(m, `<p>See <a href="${O}/blog/stretches">stretches</a> and <a href="${O}/">home</a>.</p>`)).toMatch(/links none/);
    expect(topicLinkNote(m, `<p>Our <a href="${O}/services/athletic-therapy/">athletic therapy</a> team.</p>`)).toBeNull();
    expect(topicLinkNote([], "<p>x</p>")).toBeNull();
  });
});

describe("a phone number saved as the conversion page is used, never dropped", () => {
  it("reads tel: and mailto: and nothing else", () => {
    expect(directContact("tel:+1 (555) 010-2030")).toBe("tel:+15550102030");
    expect(directContact("mailto:front-desk@acme-physio.example")).toBe("mailto:front-desk@acme-physio.example");
    expect(directContact("tel:call us")).toBeNull();
    expect(directContact("/contact")).toBeNull();
  });

  it("uses the saved number without opening anything, and says it could not be checked", async () => {
    const fetch = vi.fn();
    const out = await resolveConversionPage({ stored: "tel:+1 (555) 010-2030", candidates: [`${O}/contact`], domain: DOMAIN, fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(out.conversion).toEqual({
      url: "tel:+15550102030",
      check: "the phone number saved in the business profile; a phone number cannot be opened to check, so it is used as given",
    });
    expect(conversionLinkText(out.conversion!.url)).toBe("+15550102030");
  });
});

describe("the call to action points where a ready reader should go", () => {
  const body = "<h2>Which one?</h2><p>It depends on the injury.</p>";

  it("links the topic's service page and the saved phone number, not the homepage", () => {
    const { html, added } = addCallToAction(body, {
      domain: DOMAIN,
      businessName: "Acme Physio",
      language: "en",
      conversion: "tel:+15550102030",
      service: { name: "Athletic Therapy", url: `${O}/services/athletic-therapy` },
    });
    expect(added).toBe(true);
    expect(html).toContain(`Learn more about <a href="${O}/services/athletic-therapy">Athletic Therapy</a>.`);
    expect(html).toContain('Get in touch: <a href="tel:+15550102030">+15550102030</a>.');
    expect(html).not.toContain(`href="${O}"`);
  });

  it("falls back to the homepage only when nothing was verified", () => {
    const { html } = addCallToAction(body, { domain: DOMAIN, businessName: "Acme Physio", language: "en" });
    expect(html).toContain(`Visit <a href="${O}">${DOMAIN}</a>.`);
  });

  it("writes the contact line in the article's language", () => {
    const { html } = addCallToAction(body, { domain: DOMAIN, businessName: "Acme Fizyo", language: "tr", conversion: `${O}/iletisim` });
    expect(html).toContain(`İletişim: <a href="${O}/iletisim">${DOMAIN}/iletisim</a>.`);
  });
});

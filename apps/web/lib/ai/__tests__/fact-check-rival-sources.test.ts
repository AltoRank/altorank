import { describe, it, expect } from "vitest";
import { factCheckArticle, approvalBlocker, autoApprovalBlocker } from "../fact-check";
import { verifyCitedFigures, type PageFetcher } from "@/lib/seo/citation-check";
import type { ArticleResearch } from "@/lib/seo/research";
import type { SourceReview } from "@/lib/seo/source-classes";

// A figure or a claim sourced from a business that sells what this business
// sells is high risk, even when the figure is on that page: the article sends
// its reader to the competition and quotes a seller as the authority on the
// market it sells into. On 2026-10-01 a draft cited rival clinics for its
// headline figure and the check read it clean. Every site here is invented.

const SELLER = "https://bramble-clinic.example/guide";
const RIVAL = "https://www.rival-clinic.example/stats";
const ASSOC = "https://physio-association.example/facts";

function research(over: Partial<SourceReview> = {}): ArticleResearch {
  const sourceReview: SourceReview = {
    ownDomain: "acme-clinic.example",
    rivals: ["rival-clinic.example"],
    classes: [
      { host: "bramble-clinic.example", class: "same_service", by: "model" },
      { host: "physio-association.example", class: "information", by: "model" },
    ],
    model: "ok",
    heldBack: [
      { sentence: "Our clinic treated 37.4% more patients last year.", figures: ["37.4%"], url: SELLER, domain: "bramble-clinic.example", class: "same_service" },
    ],
    ...over,
  };
  return { competitors: [], sourceReview } as unknown as ArticleResearch;
}

const page = (text: string) => `<html><body><p>${text}</p><p>${"Filler text about recovery. ".repeat(30)}</p></body></html>`;

describe("fact check: claims sourced from a seller of the same service", () => {
  it("reads a figure linked to a seller as high risk and refuses approval", () => {
    const html = `<p>About 41% of patients recover in six weeks (<a href="${SELLER}">source</a>).</p>`;
    const report = factCheckArticle(html, research(), "en");
    expect(report.claims[0]).toMatchObject({ status: "rival_source", severity: "high" });
    expect(report.claims[0].note).toMatch(/bramble-clinic\.example, a business that sells what this business sells/);
    expect(report.verdict).toBe("high_risk");
    expect(report.summary).toMatch(/1 claim sourced from a business that sells the same service/);
    expect(approvalBlocker(report)).toMatch(/sourced from a business that sells what you sell \("41%"\)/);
    expect(autoApprovalBlocker(report)).not.toBeNull();
  });

  it("reads a figure linked to an owner-named rival as high risk without any model verdict", () => {
    const html = `<p>About 41% of patients recover in six weeks (<a href="${RIVAL}">source</a>).</p>`;
    const report = factCheckArticle(html, research({ classes: [] }), "en");
    expect(report.claims[0].status).toBe("rival_source");
  });

  it("reads a figure credited to a rival by name as high risk", () => {
    const report = factCheckArticle("<p>According to Rival Clinic, 41% of patients recover in six weeks.</p>", research(), "en");
    expect(report.claims[0].status).toBe("rival_source");
  });

  it("reads a sentence that kept the words of a removed seller link as the seller's", () => {
    const sentence = "Recovery takes six weeks for 41% of patients, as a recent clinic report shows.";
    const r = research({
      removedLinks: [{ href: SELLER, host: "bramble-clinic.example", class: "same_service", text: "a recent clinic report", context: sentence }],
    });
    const report = factCheckArticle(`<p>${sentence}</p>`, r, "en");
    expect(report.claims[0].status).toBe("rival_source");
  });

  it("reads a seller's held-back figure written in with no source as the seller's", () => {
    const report = factCheckArticle("<p>Clinics treated 37.4% more patients last year.</p>", research(), "en");
    expect(report.claims[0]).toMatchObject({ status: "rival_source", severity: "high" });
  });

  it("leaves a figure linked to a public source alone, even when a seller's page has it too", () => {
    const report = factCheckArticle(`<p>Clinics treated 37.4% more patients last year, says <a href="${ASSOC}">the association</a>.</p>`, research(), "en");
    expect(report.claims[0].status).toBe("needs_verification");
    expect(report.verdict).toBe("review");
  });

  it("reads a Turkish figure linked to a seller as high risk", () => {
    const html = `<p>Hastaların %41'i altı haftada iyileşiyor (<a href="${SELLER}">kaynak</a>).</p>`;
    const report = factCheckArticle(html, research(), "tr");
    expect(report.claims[0].status).toBe("rival_source");
  });

  it("reads a regulator named on a seller's page as high risk on a sensitive topic", () => {
    const r = research();
    (r as { trust?: unknown }).trust = { sensitive: { kind: "health", evidence: "test" } };
    const report = factCheckArticle(`<p>Physiotherapists are regulated by the College of Physiotherapists (<a href="${SELLER}">see</a>).</p>`, r, "en");
    const authority = report.claims.find((c) => c.kind === "authority");
    expect(authority).toMatchObject({ status: "rival_source", severity: "high" });
  });

  it("keeps the old reading for a draft researched before sources were classified", () => {
    const html = `<p>About 41% of patients recover in six weeks (<a href="${SELLER}">source</a>).</p>`;
    const report = factCheckArticle(html, { competitors: [] } as unknown as ArticleResearch, "en");
    expect(report.claims[0].status).toBe("needs_verification");
  });

  it("still reads a draft with nothing to check as unchecked, never clean", () => {
    const report = factCheckArticle("<p>Rest, then move gently.</p>", research(), "en");
    expect(report.verdict).toBe("unchecked");
    expect(report.unchecked).toBe("nothing_to_check");
  });
});

describe("fact check: what is not a seller's claim", () => {
  // Each of these was read as a competitor's claim by an earlier version,
  // which refused approval and told the reviewer a competitor was the source.

  it("reads a figure the business states on its own page as the business's, even when a seller's page has it too", () => {
    const r = research({
      heldBack: [{ sentence: "A first visit costs $95.", figures: ["$95"], url: SELLER, domain: "bramble-clinic.example", class: "same_service" }],
    });
    (r as { siteStatements?: unknown }).siteStatements = [{ text: "An initial assessment costs $95.", source: "https://acme-clinic.example/fees" }];
    const report = factCheckArticle("<p>An initial assessment at our clinic costs $95.</p>", r, "en");
    expect(report.claims[0]).toMatchObject({ status: "needs_verification", severity: "medium" });
    expect(report.claims[0].note).toMatch(/acme-clinic\.example\/fees/);
    expect(approvalBlocker(report)).toBeNull();
  });

  it("does not credit a seller whose domain is spelt from an association's generic words", () => {
    const r = research({ rivals: ["coastalphysiotherapy.example"], classes: [{ host: "physiotherapy.example", class: "same_service", by: "model" }] });
    for (const html of [
      "<p>According to the Coastal Physiotherapy Network of Northland, 30% of patients recover within a month.</p>",
      "<p>According to the Northland Physiotherapy Association, 41% of patients see a physiotherapist.</p>",
    ]) {
      const report = factCheckArticle(html, r, "en");
      expect(report.claims[0].status, html).toBe("needs_verification");
      expect(approvalBlocker(report), html).toBeNull();
    }
  });

  it("does not credit a seller whose domain is spelt from a Turkish association's generic words", () => {
    const r = research({ classes: [{ host: "evtemizligi.example", class: "same_service", by: "model" }] });
    const report = factCheckArticle("<p>Ev Temizliği Hizmetleri Derneği verilerine göre, hanelerin %40'ı yılda bir kez profesyonel temizlik alıyor.</p>", r, "tr");
    expect(report.claims[0].attribution).toMatch(/Derneği/);
    expect(report.claims[0].status).toBe("needs_verification");
  });

  it("still credits a seller named as the source", () => {
    const r = research({ classes: [{ host: "acmeapps.example", class: "same_service", by: "model" }] });
    const report = factCheckArticle("<p>Acme Apps'in raporuna göre, hanelerin %40'ı yılda bir kez profesyonel temizlik alıyor.</p>", r, "tr");
    expect(report.claims[0].status).toBe("rival_source");
  });

  it("keeps a regulator named only in a seller's snippet corroborated, not a competitor's claim", () => {
    const r = research();
    (r as { trust?: unknown }).trust = { sensitive: { kind: "health", evidence: "test" } };
    (r as { competitors: unknown }).competitors = [
      { domain: "bramble-clinic.example", url: SELLER, title: "Physio guide", description: "Our team is registered with the College of Physiotherapists of Northland." },
    ];
    const report = factCheckArticle("<p>Physiotherapists in the province are regulated by the College of Physiotherapists of Northland.</p>", r, "en");
    const authority = report.claims.find((c) => c.kind === "authority");
    expect(authority).toMatchObject({ status: "corroborated", severity: "medium" });
    expect(authority?.note).toMatch(/sells what this business sells, so it is not a source to cite/);
    expect(approvalBlocker(report)).toBeNull();
    expect(autoApprovalBlocker(report)).toBeNull();
  });

  it("does not read a removed link's generic words in another paragraph as the seller's", () => {
    const r = research({
      removedLinks: [
        {
          href: SELLER,
          host: "bramble-clinic.example",
          class: "same_service",
          text: "office workers",
          context: "Most back pain in office workers comes from sitting.",
        },
      ],
    });
    const html =
      "<p>Most back pain in office workers comes from sitting.</p>" +
      "<p>According to the World Health Organization, 60% of office workers return to work within a month.</p>" +
      `<p>About 50% of office workers stretch, says <a href="${ASSOC}">the association</a>.</p>`;
    const report = factCheckArticle(html, r, "en");
    expect(report.claims.map((c) => c.status)).toEqual(["needs_verification", "needs_verification"]);
  });

  it("leaves a person to decide on a cited site research read but could not classify", () => {
    const r = research({ model: "failed", classes: [{ host: "rival-clinic-two.example", class: "unclassified", by: "none" }] });
    const report = factCheckArticle(
      `<p>About 41% of patients recover in six weeks (<a href="https://rival-clinic-two.example/x">source</a>).</p>`,
      r,
      "en",
    );
    expect(report.claims[0]).toMatchObject({ status: "needs_verification", severity: "medium", unclassifiedSource: "rival-clinic-two.example" });
    expect(approvalBlocker(report)).toBeNull();
    expect(autoApprovalBlocker(report)).toMatch(/rival-clinic-two\.example, which could not be classified/);
  });

  it("does not hold auto-approval for a cited site research never read", () => {
    const report = factCheckArticle(`<p>About 41% of patients recover in six weeks (<a href="https://journal.example/x">source</a>).</p>`, research(), "en");
    expect(report.claims[0].unclassifiedSource).toBeUndefined();
    expect(autoApprovalBlocker(report)).toBeNull();
  });
});

describe("citation check: a seller's page never verifies a claim", () => {
  it("does not turn a seller-sourced claim verified when the page carries the figure", async () => {
    const html = `<p>About 41% of patients recover in six weeks (<a href="${SELLER}">source</a>).</p>`;
    const opened: string[] = [];
    const fetcher: PageFetcher = async (url) => (opened.push(url), { status: 200, body: page("About 41% of patients recover in six weeks.") });
    const report = await verifyCitedFigures(factCheckArticle(html, research(), "en"), { fetcher, sourceReview: research().sourceReview });
    expect(report.claims[0].status).toBe("rival_source");
    expect(report.verdict).toBe("high_risk");
    expect(opened).toEqual([]);
  });

  it("marks a seller-cited claim from a report built without the research, without opening the page", async () => {
    const html = `<p>About 41% of patients recover in six weeks (<a href="${SELLER}">source</a>).</p>`;
    const opened: string[] = [];
    const fetcher: PageFetcher = async (url) => (opened.push(url), { status: 200, body: page("About 41% of patients recover in six weeks.") });
    const report = await verifyCitedFigures(factCheckArticle(html, undefined, "en"), { fetcher, sourceReview: research().sourceReview });
    expect(report.claims[0]).toMatchObject({ status: "rival_source", severity: "high" });
    expect(report.verdict).toBe("high_risk");
    expect(opened).toEqual([]);
  });

  it("still verifies a public source's figure", async () => {
    const html = `<p>About 41% of patients recover in six weeks, says <a href="${ASSOC}">the association</a>.</p>`;
    const fetcher: PageFetcher = async () => ({ status: 200, body: page("About 41% of patients recover in six weeks.") });
    const report = await verifyCitedFigures(factCheckArticle(html, research(), "en"), { fetcher, sourceReview: research().sourceReview });
    expect(report.claims[0].status).toBe("verified");
  });
});

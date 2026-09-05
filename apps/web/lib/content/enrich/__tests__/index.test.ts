import { describe, it, expect, vi } from "vitest";
import { enrichArticle, loadEnrichmentSettings, DEFAULT_SETTINGS } from "../index";
import { ARTICLE } from "./fixtures";

const VIDEO = { videoId: "v1", title: "Setup", channelTitle: "Ch", thumbnailUrl: "" };

describe("enrichArticle", () => {
  it("runs every step in order and reports what each did", async () => {
    const research: Record<string, unknown> = { keyword: "crm" };
    const { html, report } = await enrichArticle(ARTICLE, {
      workspaceId: "ws",
      keyword: "crm for small teams",
      title: "How to choose a CRM",
      domain: "example.com",
      businessName: "Example Ltd",
      settings: {},
      imageProducer: async (_b, i) => `https://cdn.test/${i}.webp`,
      videoSearch: async () => [VIDEO],
      fetchTitle: async () => null,
      research,
    });

    expect(report).toMatchObject({ toc: true, video: true, infographics: 1, cta: true, faq: 3 });
    expect(report.images).toBeGreaterThanOrEqual(1);
    expect(report.warnings).toEqual([]);
    expect(report.format?.headingIds).toBeGreaterThanOrEqual(4);
    expect(report.faqSchema?.mainEntity).toHaveLength(3);
    expect(report.imageStyle).toBe("illustration");

    // Order in the document: TOC, then sections with images/video/chart, CTA last.
    const order = ["<nav class=\"toc\"", "<figure class=\"article-image\"", "video-embed", "<figure class=\"infographic\"", "<section class=\"cta\""]
      .map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // The report is attached to the research the caller will save.
    expect(research.enrichment).toBe(report);
  });

  it("honours the output settings", async () => {
    const { report } = await enrichArticle(ARTICLE, {
      workspaceId: "ws",
      keyword: "k",
      title: "t",
      domain: "example.com",
      settings: { tableOfContents: false, callToAction: false },
      imageProducer: null,
      videoSearch: async () => [],
      fetchTitle: async () => null,
    });
    expect(report.toc).toBe(false);
    expect(report.cta).toBe(false);
    expect(report.images).toBe(0);
    expect(report.imageStyle).toBeNull();
  });

  it("a step that throws or returns nothing costs a warning, never the body", async () => {
    const { html, report } = await enrichArticle(ARTICLE, {
      workspaceId: "ws",
      keyword: "k",
      title: "t",
      domain: "example.com",
      settings: {},
      imageProducer: async () => {
        throw new Error("image API down");
      },
      videoSearch: async () => {
        throw new Error("youtube down");
      },
      fetchTitle: async () => null,
    });
    expect(report.warnings.some((w) => w.includes("image API down"))).toBe(true);
    expect(report.warnings.some((w) => w.startsWith("video: youtube down"))).toBe(true);
    expect(report.images).toBe(0);
    expect(report.video).toBe(false);
    expect(html).toContain("Frequently asked questions");
    expect(html).toContain('<section class="cta">');
  });

  it("without a client, no network step runs and defaults apply", async () => {
    const { report } = await enrichArticle(ARTICLE, { workspaceId: "ws", keyword: "k", title: "t", fetchTitle: async () => null });
    expect(report.images).toBe(0);
    expect(report.toc).toBe(true);
    expect(report.cta).toBe(false); // no domain to point at
  });
});

describe("loadEnrichmentSettings", () => {
  function client(response: { data: unknown; error?: unknown }) {
    return {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => response }) }) }),
    } as never;
  }

  it("falls back to defaults when the table is missing or the row is absent", async () => {
    expect(await loadEnrichmentSettings(client({ data: null, error: { code: "42P01" } }), "ws")).toEqual(DEFAULT_SETTINGS);
    expect(await loadEnrichmentSettings(client({ data: null }), "ws")).toEqual(DEFAULT_SETTINGS);
  });

  it("reads the two columns it needs", async () => {
    expect(
      await loadEnrichmentSettings(client({ data: { table_of_contents: false, call_to_action: true } }), "ws"),
    ).toEqual({ tableOfContents: false, callToAction: true });
  });

  it("swallows a client that throws", async () => {
    const throwing = { from: () => { throw new Error("boom"); } } as never;
    expect(await loadEnrichmentSettings(throwing, "ws")).toEqual(DEFAULT_SETTINGS);
  });
});

describe("enrichArticle: settings from the database", () => {
  it("loads settings and the business name from the client when not given", async () => {
    const from = vi.fn((table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === "workspace_output_settings"
              ? { data: { table_of_contents: false, call_to_action: true } }
              : { data: { business_profile: { name: "Nomads" } } },
        }),
      }),
    }));
    const { html, report } = await enrichArticle(ARTICLE, {
      workspaceId: "ws",
      keyword: "k",
      title: "t",
      domain: "nomads.test",
      supabase: { from } as never,
      imageProducer: null,
      videoSearch: async () => [],
      fetchTitle: async () => null,
    });
    expect(report.toc).toBe(false);
    expect(html).toContain("Learn more about Nomads");
  });
});

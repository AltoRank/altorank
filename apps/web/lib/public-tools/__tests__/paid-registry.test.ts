import { describe, it, expect } from "vitest";
import { getTool, listTools } from "../registry";

// The body each altorank.co form sends (field names from the marketing repo's
// src/data/server-tools.ts). A rename on either side breaks this test.
const FORM_BODIES: Record<string, Record<string, string>> = {
  "seo-title-generator": { topic: "a page", keyword: "" },
  "headline-generator": { topic: "a topic" },
  "blog-outline-generator": { topic: "a topic", keyword: "kw" },
  "cta-generator": { offer: "an offer", audience: "" },
  "ad-copy-generator": { product: "a product", audience: "", platform: "google" },
  "article-rewriter": { text: "Some text.", tone: "" },
  "article-summarizer": { text: "Some text." },
  "grammar-checker": { text: "Some text." },
  "content-idea-generator": { topic: "a niche" },
  "email-subject-line-generator": { topic: "an email" },
  "social-media-post-generator": { topic_or_text: "a topic", platform: "linkedin" },
  "ai-article-generator": { topic: "a topic", keyword: "" },
  "alt-text-generator": { image_url: "https://example.com/a.png" },
  "lsi-keyword-generator": { keyword: "a keyword" },
  "keyword-research": { keyword: "a keyword", country: "us" },
  "blog-post-ideas": { topic: "a topic" },
  "google-rank-checker": { domain: "example.com", keyword: "a keyword", country: "gb" },
  "backlink-checker": { domain: "example.com" },
  "website-worth-calculator": { domain: "example.com" },
  "plagiarism-checker": { text: "Some text." },
};

const PASTED_TEXT = ["article-rewriter", "article-summarizer", "grammar-checker", "social-media-post-generator", "plagiarism-checker"];

describe("paid tools", () => {
  it("are all registered and accept their form's body", () => {
    for (const [slug, body] of Object.entries(FORM_BODIES)) {
      const tool = getTool(slug);
      expect(tool, slug).toBeDefined();
      const parsed = tool!.input.safeParse(body);
      expect(parsed.success, `${slug}: ${parsed.success ? "" : parsed.error.issues[0]?.message}`).toBe(true);
    }
  });

  it("are spend-guarded with a positive, bounded estimate and a tight per-IP limit", () => {
    const paid = listTools().filter((t) => t.kind !== "fetch");
    expect(paid.map((t) => t.slug).sort()).toEqual(Object.keys(FORM_BODIES).sort());
    for (const t of paid) {
      expect(t.estimateCents, t.slug).toBeGreaterThan(0);
      expect(t.estimateCents, t.slug).toBeLessThanOrEqual(10);
      expect(t.perIpLimit.limit, t.slug).toBeLessThanOrEqual(5);
    }
  });

  it("never cache pasted text", () => {
    for (const slug of PASTED_TEXT) expect(getTool(slug)!.cacheTtlMs, slug).toBe(0);
  });
});

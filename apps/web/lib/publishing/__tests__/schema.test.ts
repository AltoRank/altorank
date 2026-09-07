import { describe, it, expect } from "vitest";
import { appendJsonLd, blogPostingSchema, jsonLdScript, structuredDataFor, SCRIPT_CAPABLE } from "../schema";

const posting = {
  title: "SEO Marketing Content: A Guide",
  description: "What it is and how to do it.",
  imageUrl: "https://cdn.example.com/hero.png",
  datePublished: "2026-09-07T08:00:00.000Z",
  dateModified: "2026-09-07T09:00:00.000Z",
  keyword: "seo marketing content",
  publisherName: "AltoRank",
  language: "en",
};

const faqHtml =
  "<h2>Intro</h2><p>x</p><h2>Frequently asked questions</h2>" +
  "<h3>What is SEO content?</h3><p>Content written to rank in search and to be cited.</p>" +
  "<h3>How long should it be?</h3><p>As long as the topic needs.</p>" +
  "<h3>Does it need images?</h3><p>Usually, yes: one per section is a good floor.</p>";

describe("blogPostingSchema", () => {
  it("names the business as author and publisher and carries the article's own fields", () => {
    expect(blogPostingSchema(posting)).toEqual({
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: "SEO Marketing Content: A Guide",
      description: "What it is and how to do it.",
      image: "https://cdn.example.com/hero.png",
      datePublished: "2026-09-07T08:00:00.000Z",
      dateModified: "2026-09-07T09:00:00.000Z",
      keywords: "seo marketing content",
      inLanguage: "en",
      author: { "@type": "Organization", name: "AltoRank" },
      publisher: { "@type": "Organization", name: "AltoRank" },
    });
  });

  it("leaves out what the article does not have", () => {
    const s = blogPostingSchema({ ...posting, description: null, imageUrl: "", keyword: undefined, language: null });
    expect(s).not.toHaveProperty("description");
    expect(s).not.toHaveProperty("image");
    expect(s).not.toHaveProperty("keywords");
    expect(s).not.toHaveProperty("inLanguage");
  });
});

describe("structuredDataFor", () => {
  it("adds the FAQPage read from the final body when the switch is on", () => {
    const out = structuredDataFor(faqHtml, posting, true);
    expect(out.map((s) => s["@type"])).toEqual(["BlogPosting", "FAQPage"]);
    expect((out[1] as { mainEntity: unknown[] }).mainEntity).toHaveLength(3);
  });

  it("ships only the posting when the switch is off, or the body has no FAQ", () => {
    expect(structuredDataFor(faqHtml, posting, false).map((s) => s["@type"])).toEqual(["BlogPosting"]);
    expect(structuredDataFor("<h2>Intro</h2><p>x</p>", posting, true).map((s) => s["@type"])).toEqual(["BlogPosting"]);
  });
});

describe("appendJsonLd", () => {
  it("appends one script tag per schema, after the body", () => {
    const html = appendJsonLd("<p>Body</p>", structuredDataFor(faqHtml, posting, true));
    expect(html.startsWith("<p>Body</p>\n<script type=\"application/ld+json\" data-altorank-schema>")).toBe(true);
    expect(html.match(/<script type="application\/ld\+json"/g)).toHaveLength(2);
    expect(html).toContain('"@type":"FAQPage"');
  });

  it("does not add a second set on a retry that already carries one", () => {
    const once = appendJsonLd("<p>Body</p>", [blogPostingSchema(posting)]);
    expect(appendJsonLd(once, [blogPostingSchema(posting)])).toBe(once);
  });

  it("adds nothing when there is nothing to add", () => {
    expect(appendJsonLd("<p>Body</p>", [])).toBe("<p>Body</p>");
  });

  it("cannot be closed early by a question that contains a closing tag", () => {
    const tag = jsonLdScript({ "@type": "Question", name: "What does </script> do?" });
    expect(tag.split("</script>")).toHaveLength(2);
    expect(tag).toContain("<\\/script>");
  });
});

describe("SCRIPT_CAPABLE", () => {
  it("names the raw-HTML destinations and not the ones that parse the body into blocks", () => {
    for (const t of ["wordpress", "wordpress-plugin", "woocommerce", "ghost", "shopify", "hubspot", "git"] as const) {
      expect(SCRIPT_CAPABLE.has(t)).toBe(true);
    }
    for (const t of ["notion", "wix", "webflow", "framer", "webhook"] as const) {
      expect(SCRIPT_CAPABLE.has(t)).toBe(false);
    }
  });
});

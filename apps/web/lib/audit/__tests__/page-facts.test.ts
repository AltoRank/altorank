import { describe, it, expect } from "vitest";
import { pageFacts } from "../page-facts";

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AltoRank | Get recommended by ChatGPT and ranked on Google</title>
  <meta name="description" content="${"x".repeat(161)}">
  <link rel="canonical" href="https://altorank.co/">
  <link rel="stylesheet" href="/a.css">
  <link rel="stylesheet" href="/print.css" media="print">
  <link rel="preload" as="style" href="/b.css">
  <script src="/blocking.js"></script>
  <script defer src="/deferred.js"></script>
  <script async src="/async.js"></script>
  <script type="module" src="/module.js"></script>
  <script>inline();</script>
  <meta property="og:title" content="AltoRank">
  <meta property="og:image" content="https://altorank.co/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"AltoRank"},{"@type":"WebSite"}]}</script>
  <script type="application/ld+json">not json</script>
</head>
<body>
  <h1>Get recommended</h1>
  <h2>One</h2><h2>Two</h2>
  <h3>a</h3><h3>b</h3><h3>c</h3>
  <img src="/a.png" alt="A logo"><img src="/b.png"><img src="/c.png" alt="">
  <p>Some visible words here.</p>
  <script>ignored();</script>
  <style>.x{}</style>
</body>
</html>`;

describe("pageFacts", () => {
  const facts = pageFacts(HTML, { Server: "cloudflare", "content-encoding": "br", "Cache-Control": "public, max-age=3600" }, 200);

  it("reads the response headers whatever their case", () => {
    expect(facts.server).toBe("cloudflare");
    expect(facts.encoding).toBe("br");
    expect(facts.cacheable).toBe(true);
    expect(facts.status).toBe(200);
  });

  it("measures the title and description, and knows when the description is over Google's cut", () => {
    expect(facts.title).toBe("AltoRank | Get recommended by ChatGPT and ranked on Google");
    expect(facts.titleLength).toBe(58);
    expect(facts.metaDescriptionLength).toBe(161);
    expect(facts.viewport).toBe(true);
    expect(facts.canonical).toBe("https://altorank.co/");
    expect(facts.lang).toBe("en");
  });

  it("counts headings by level", () => {
    expect(facts.headings).toEqual({ h1: 1, h2: 2, h3: 3, h4: 0 });
  });

  it("counts only what actually blocks first paint in the head", () => {
    // /blocking.js blocks; defer, async and module do not; inline has no src.
    expect(facts.renderBlockingScripts).toBe(1);
    // /a.css blocks; the print sheet and the preload do not.
    expect(facts.renderBlockingStylesheets).toBe(1);
  });

  it("lists the social tags and the schema types, and survives a malformed JSON-LD block", () => {
    expect(facts.socialTags).toEqual(["og:image", "og:title", "twitter:card"]);
    expect(facts.schemaTypes).toEqual(["Organization", "WebSite"]);
  });

  it("counts images without alt, an empty alt included", () => {
    expect(facts.images).toEqual({ total: 3, missingAlt: 2 });
  });

  it("measures words against markup", () => {
    expect(facts.textChars).toBeGreaterThan(30);
    expect(facts.textRatio).toBeGreaterThan(0);
    expect(facts.textRatio).toBeLessThan(20);
    expect(facts.htmlBytes).toBe(Buffer.byteLength(HTML));
  });

  it("says nothing it cannot read: no headers, no description, private cache", () => {
    const bare = pageFacts("<html><head></head><body><p>hi</p></body></html>", { "cache-control": "private, no-store" });
    expect(bare.server).toBeNull();
    expect(bare.encoding).toBeNull();
    expect(bare.cacheable).toBe(false);
    expect(bare.title).toBeNull();
    expect(bare.metaDescription).toBeNull();
    expect(bare.viewport).toBe(false);
    expect(bare.headings.h1).toBe(0);
    expect(pageFacts("<p>x</p>").cacheable).toBeNull();
  });
});

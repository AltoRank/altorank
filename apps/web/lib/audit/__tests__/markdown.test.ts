import { describe, it, expect } from "vitest";
import {
  buildLlmsTxt,
  extractMainContent,
  htmlToMarkdown,
  type LlmsTxtPage,
} from "../markdown";

const BASE = "https://client.example/page";

const doc = (body: string, head = "") =>
  `<html><head>${head}</head><body>${body}</body></html>`;

/** Long enough to clear the 200-char landmark threshold. */
const filler = (label: string) =>
  `<p>${label} ${"content that is long enough to be treated as the real body of the page. ".repeat(4)}</p>`;

// ── content extraction ────────────────────────────────────────────────────────

describe("extractMainContent", () => {
  it("prefers <main> and reports it as non-heuristic", () => {
    const html = doc(`<nav>menu</nav><main>${filler("MAIN")}</main><footer>legal</footer>`);
    const r = extractMainContent(html);
    expect(r.source).toBe("main");
    expect(r.heuristic).toBe(false);
    expect(r.html).toContain("MAIN");
  });

  it("falls back to the longest <article> on a listing page", () => {
    const html = doc(
      `<article><p>stub</p></article><article>${filler("REAL")}</article>`,
    );
    const r = extractMainContent(html);
    expect(r.source).toBe("article");
    expect(r.html).toContain("REAL");
    expect(r.html).not.toContain("stub");
  });

  it("falls back to body-minus-chrome and flags the result as heuristic", () => {
    const html = doc(`<nav>menu</nav><div>${filler("BODY")}</div><footer>legal</footer>`);
    const r = extractMainContent(html);
    expect(r.source).toBe("body-minus-chrome");
    expect(r.heuristic).toBe(true);
    expect(r.html).toContain("BODY");
    expect(r.html).not.toContain("menu");
    expect(r.html).not.toContain("legal");
  });

  it("ignores an empty <main> rather than returning nothing", () => {
    const html = doc(`<main></main><div>${filler("BODY")}</div>`);
    const r = extractMainContent(html);
    expect(r.source).toBe("body-minus-chrome");
    expect(r.html).toContain("BODY");
  });

  it("strips scripts, styles and forms", () => {
    const html = doc(
      `<main>${filler("KEEP")}<script>var x=1</script><style>.a{}</style>` +
      `<form><label>Your email</label></form></main>`,
    );
    const r = extractMainContent(html);
    expect(r.html).toContain("KEEP");
    expect(r.html).not.toContain("var x=1");
    expect(r.html).not.toContain("Your email");
  });

  it("removes a cookie banner with its whole nested subtree", () => {
    const html = doc(
      `<div class="cookie-consent"><div><div><button>Accept</button></div>` +
      `<p>We use cookies</p></div></div><div>${filler("BODY")}</div>`,
    );
    const r = extractMainContent(html);
    expect(r.html).not.toContain("We use cookies");
    expect(r.html).toContain("BODY");
  });

  it("removes an ARIA-landmarked nav without eating following content", () => {
    const html = doc(
      `<div role="navigation"><div>Home</div><div>About</div></div>` +
      `<div>${filler("BODY")}</div>`,
    );
    const r = extractMainContent(html);
    expect(r.html).not.toContain("About");
    expect(r.html).toContain("BODY");
  });
});

// ── markdown ──────────────────────────────────────────────────────────────────

describe("htmlToMarkdown", () => {
  it("converts headings, lists, emphasis and links", () => {
    const html = doc(
      `<main><h1>Title</h1><h2>Sub</h2><p>Some <strong>bold</strong> and <em>italic</em>.</p>` +
      `<ul><li>one</li><li>two</li></ul>` +
      `<p><a href="/about">About us</a></p>${filler("pad")}</main>`,
    );
    const { markdown } = htmlToMarkdown(html, BASE);
    expect(markdown).toContain("# Title");
    expect(markdown).toContain("## Sub");
    expect(markdown).toContain("**bold**");
    expect(markdown).toContain("*italic*");
    expect(markdown).toContain("- one");
    expect(markdown).toContain("[About us](https://client.example/about)");
  });

  it("resolves relative links against the base url", () => {
    const html = doc(`<main><p><a href="../x">X</a></p>${filler("pad")}</main>`);
    expect(htmlToMarkdown(html, "https://client.example/a/b").markdown)
      .toContain("[X](https://client.example/x)");
  });

  it("keeps in-page anchors as plain text", () => {
    const html = doc(`<main><p><a href="#top">Back to top</a></p>${filler("pad")}</main>`);
    const { markdown } = htmlToMarkdown(html, BASE);
    expect(markdown).toContain("Back to top");
    expect(markdown).not.toContain("](#top)");
  });

  it("keeps image alt text, the only readable part of an image", () => {
    const html = doc(`<main><p><img src="/a.png" alt="Team photo" /></p>${filler("pad")}</main>`);
    expect(htmlToMarkdown(html, BASE).markdown).toContain("![Team photo]");
  });

  it("converts tables with a header separator row", () => {
    const html = doc(
      `<main><table><tr><th>Plan</th><th>Price</th></tr>` +
      `<tr><td>Agency</td><td>199</td></tr></table>${filler("pad")}</main>`,
    );
    const { markdown } = htmlToMarkdown(html, BASE);
    expect(markdown).toContain("| Plan | Price |");
    expect(markdown).toContain("| --- | --- |");
    expect(markdown).toContain("| Agency | 199 |");
  });

  it("separates sibling divs instead of running their text together", () => {
    const html = doc(
      `<div><div>First card body text here</div><div>Second card body text here</div>` +
      `<div>Third card body text here</div>${filler("pad")}</div>`,
    );
    const { markdown } = htmlToMarkdown(html, BASE);
    expect(markdown).not.toMatch(/hereSecond/);
    expect(markdown).toMatch(/First card body text here\s/);
  });

  it("decodes entities, including typographic ones", () => {
    const html = doc(`<main><p>Milano &ndash; SEO &amp; PPC</p>${filler("pad")}</main>`);
    expect(htmlToMarkdown(html, BASE).markdown).toContain("Milano – SEO & PPC");
  });

  it("decodes accented entities (regression: literal attivit&agrave; in Italian output)", () => {
    const html = doc(
      `<main><p>la tua attivit&agrave; &egrave; perch&eacute; pi&ugrave; grande</p>${filler("pad")}</main>`,
    );
    const { markdown } = htmlToMarkdown(html, BASE);
    expect(markdown).toContain("la tua attività è perché più grande");
    expect(markdown).not.toMatch(/&[a-z]+;/i);
  });

  it("decodes uppercase accented entities", () => {
    const html = doc(`<main><p>&Egrave; vero</p>${filler("pad")}</main>`);
    expect(htmlToMarkdown(html, BASE).markdown).toContain("È vero");
  });

  it("keeps a heading on its own line, separate from the next paragraph", () => {
    // Regression: the shared decode() collapsed \s+, eating the newlines that
    // carry block structure, so every heading ran into the following text.
    const html = doc(`<main><h1>Heading here</h1><p>Body paragraph follows.</p>${filler("pad")}</main>`);
    const { markdown } = htmlToMarkdown(html, BASE);
    expect(markdown).toMatch(/# Heading here\n/);
    expect(markdown).not.toMatch(/# Heading here Body/);
  });

  it("still collapses runs of spaces inside a line", () => {
    const html = doc(`<main><p>too     many     spaces</p>${filler("pad")}</main>`);
    expect(htmlToMarkdown(html, BASE).markdown).toContain("too many spaces");
  });

  it("does not leave indentation that would read as a code block", () => {
    const html = doc(`<main>
            <p>Indented in the source</p>
            ${filler("pad")}
        </main>`);
    const { markdown } = htmlToMarkdown(html, BASE);
    expect(markdown).toContain("Indented in the source");
    expect(markdown).not.toMatch(/^ {4}Indented/m);
  });

  it("reports title, source and word count", () => {
    const html = doc(`<main>${filler("pad")}</main>`, `<title>Client Site</title>`);
    const r = htmlToMarkdown(html, BASE);
    expect(r.title).toBe("Client Site");
    expect(r.source).toBe("main");
    expect(r.heuristic).toBe(false);
    expect(r.words).toBeGreaterThan(20);
  });

  it("returns empty output rather than throwing on a contentless page", () => {
    const r = htmlToMarkdown(doc("<div></div>"), BASE);
    expect(r.markdown).toBe("");
    expect(r.words).toBe(0);
  });

  it("terminates on unclosed chrome markup", () => {
    const html = doc(`<div class="menu"><p>menu item</p><div>${filler("BODY")}`);
    const r = htmlToMarkdown(html, BASE);
    expect(r.markdown).not.toContain("menu item");
  });
});

// ── llms.txt ──────────────────────────────────────────────────────────────────

describe("buildLlmsTxt", () => {
  const pages: LlmsTxtPage[] = [
    { url: "https://c.example/", title: "Home", description: "The homepage", section: "Start here" },
    { url: "https://c.example/pricing", title: "Pricing", section: "Start here" },
    { url: "https://c.example/misc", title: "Misc" },
  ];

  it("renders the llmstxt.org shape", () => {
    const out = buildLlmsTxt({ siteName: "Client", summary: "A summary.", pages });
    expect(out.startsWith("# Client\n")).toBe(true);
    expect(out).toContain("> A summary.");
    expect(out).toContain("## Start here");
    expect(out).toContain("- [Home](https://c.example/): The homepage");
    expect(out).toContain("- [Pricing](https://c.example/pricing)");
  });

  it("puts unsectioned pages under Other, last", () => {
    const out = buildLlmsTxt({ siteName: "Client", pages });
    expect(out.indexOf("## Other")).toBeGreaterThan(out.indexOf("## Start here"));
    expect(out).toContain("- [Misc](https://c.example/misc)");
  });

  it("renders notes as plain paragraphs after the summary", () => {
    const out = buildLlmsTxt({
      siteName: "Client",
      summary: "A summary.",
      notes: ["This site is pre-launch."],
      pages,
    });
    expect(out.indexOf("This site is pre-launch.")).toBeGreaterThan(out.indexOf("> A summary."));
    expect(out).not.toContain("> This site is pre-launch.");
  });

  it("handles an empty page list without emitting a stray section", () => {
    const out = buildLlmsTxt({ siteName: "Client", pages: [] });
    expect(out.trim()).toBe("# Client");
  });

  it("never leaves more than one blank line", () => {
    expect(buildLlmsTxt({ siteName: "C", summary: "S", notes: ["N"], pages }))
      .not.toMatch(/\n{3,}/);
  });
});

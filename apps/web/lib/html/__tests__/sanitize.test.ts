import { describe, expect, it } from "vitest";
import { isEmbedSrc, isSafeUrl, sanitizeHtml, sanitizeSvg } from "../sanitize";

// The one allowlist sanitiser behind every article, rewrite and scraped HTML
// sink. Pinned: hostile inputs in every spelling come back inert; an article's
// own markup (links, figures, charts, embeds, tables, heading ids) comes back
// as it was.

/** Nothing executable, in any form the browser would read as such. */
function expectInert(out: string, input: string) {
  expect(out, input).not.toMatch(/\son[a-z]+\s*=/i);
  expect(out, input).not.toMatch(/<(script|style|object|embed|math|foreignobject|use|image|base|meta|link|form|input|button|textarea|details)\b/i);
  expect(out, input).not.toMatch(/(href|src|action|formaction|xlink:href)\s*=\s*"\s*(javascript|vbscript|data):/i);
  expect(out, input).not.toMatch(/style=/i);
}

const HOSTILE = [
  "<img/src=x/onerror=alert(1)>",
  "<img src=x onerror=alert(1)>",
  "<svg/onload=alert(1)>",
  "<svg/onload=alert(1)></svg>",
  "<svg></svg><img/src=x/onerror=alert(1)><svg></svg>",
  "<svg><style>body{display:none}</style><rect width=\"1\"/></svg>",
  "<a href=javascript:alert(1)>x</a>",
  '<a href="jav&#x61;script:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="jav&Tab;ascript:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt&colon;alert(1)">x</a>',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<a href="vbscript:x">x</a>',
  "<iframe/src=javascript:alert(1)></iframe>",
  '<iframe src="https://evil.example/embed/x"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  "<details open ontoggle=alert(1)>",
  '<p style="background:url(javascript:alert(1))" onmouseover="x()">t</p>',
  "<math><mi xlink:href=\"javascript:alert(1)\">x</mi></math>",
  "<scr<script>ipt>alert(1)</script>",
  '<p title="a>b" onclick="x()">t</p>',
  "<!--><img src=x onerror=alert(1)>-->",
  '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
  '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
  '<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>',
  '<svg><use href="data:image/svg+xml,<svg id=x onload=alert(1)>"/></svg>',
  '<object data="x.swf"></object><embed src="x.swf">',
  '<form action="https://evil.example"><input name="p"><button formaction="javascript:alert(1)">go</button></form>',
  '<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<img src="data:image/svg+xml;base64,PHN2Zz4=">',
  '<IMG SRC="x" ONERROR="alert(1)">',
];

describe("sanitizeHtml: hostile input", () => {
  it("comes back inert in every spelling", () => {
    for (const input of HOSTILE) expectInert(sanitizeHtml(input), input);
  });

  it("drops what runs, embeds or submits together with its content", () => {
    expect(sanitizeHtml("<p>a</p><script>alert(1)</script><p>b</p>")).toBe("<p>a</p><p>b</p>");
    expect(sanitizeHtml("<style>body{display:none}</style><p>b</p>")).toBe("<p>b</p>");
    expect(sanitizeHtml('<iframe src="https://evil.example/x">fallback</iframe><p>b</p>')).toBe("<p>b</p>");
  });

  it("keeps a link's text when its target is refused", () => {
    expect(sanitizeHtml("<a href=javascript:alert(1)>x</a>")).toBe("<a>x</a>");
    expect(sanitizeHtml('<img src="javascript:alert(1)" alt="a">')).toBe('<img alt="a" />');
  });

  it("drops classes an article does not use, so content cannot restyle the app around it", () => {
    expect(sanitizeHtml('<p class="fixed inset-0 z-50 infographic">t</p>')).toBe('<p class="infographic">t</p>');
  });

  it("adds noopener to a link that opens a new tab", () => {
    expect(sanitizeHtml('<a href="https://ok.example" target="_blank">x</a>')).toBe(
      '<a href="https://ok.example" target="_blank" rel="noopener noreferrer">x</a>',
    );
    expect(sanitizeHtml('<a href="https://ok.example" target="evil">x</a>')).toBe('<a href="https://ok.example">x</a>');
  });

  it("handles non-string input", () => {
    expect(sanitizeHtml(undefined)).toBe("");
    expect(sanitizeHtml({ toString: () => "<script>x</script>" })).toBe("");
  });
});

describe("sanitizeHtml: an article's own markup", () => {
  it("keeps headings with ids, links, lists, tables and text escaping", () => {
    const html =
      '<h2 id="pricing">Pricing</h2><p>Read <a href="https://ok.example/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">this</a> &amp; <strong>that</strong>, <a href="/pricing">pricing</a>, <a href="#faq">FAQ</a>, <a href="mailto:a@ok.example">mail</a>.</p>' +
      '<ul><li>one</li></ul><table><tr><td colspan="2">c</td></tr></table><blockquote>q</blockquote>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it("keeps the enrichment figures: image, YouTube embed and inline chart", () => {
    const image = '<figure class="article-image"><img src="https://cdn.example/x.webp" alt="Alt" loading="lazy" /><figcaption>Cap</figcaption></figure>';
    const video =
      '<figure class="video-embed"><iframe src="https://www.youtube-nocookie.com/embed/v1" title="T" loading="lazy" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe><figcaption>Video: T</figcaption></figure>';
    const chart =
      '<figure class="infographic"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="100%" role="img" aria-label="Bar chart: a 1" style="max-width:640px;font-family:system-ui,sans-serif"><title>a 1</title><rect x="1" y="2" width="1" height="1" rx="3" fill="#1a1815" opacity="0.85"></rect><text x="1" y="1" text-anchor="end" font-size="13">a</text></svg><figcaption>Src</figcaption></figure>';
    expect(sanitizeHtml(image)).toBe(image);
    expect(sanitizeHtml(video)).toBe(video);
    expect(sanitizeHtml(chart)).toBe(chart);
  });
});

describe("sanitizeSvg", () => {
  const CHART =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img" aria-label="Bar chart: a 1, b 2"><title>a 1, b 2</title><rect width="1" height="1"></rect><text x="1" y="1">a</text></svg>';

  it("returns a chart the infographic step wrote unchanged", () => {
    expect(sanitizeSvg(CHART)).toBe(CHART);
  });

  it("drops a handler separated by a slash", () => {
    expect(sanitizeSvg('<svg/onload=alert(1)><rect width="1"/></svg>')).toBe('<svg><rect width="1"></rect></svg>');
  });

  it("refuses markup around or between two roots", () => {
    expect(sanitizeSvg("<svg></svg><img/src=x/onerror=alert(1)><svg></svg>")).toBeNull();
    expect(sanitizeSvg('<svg><rect width="1"/></svg><svg><rect width="1"/></svg>')).toBeNull();
    expect(sanitizeSvg('<svg><rect width="1"/></svg><p>after</p>')).toBeNull();
    expect(sanitizeSvg('<p>before</p><svg><rect width="1"/></svg>')).toBeNull();
  });

  it("drops <style>, references and links, and paint values that are not colours", () => {
    expect(sanitizeSvg('<svg><style>body{display:none}</style><rect width="1"/></svg>')).toBe('<svg><rect width="1"></rect></svg>');
    expect(sanitizeSvg('<svg><use href="#a"/><image href="https://x/y.png"/><rect width="1"/></svg>')).toBe('<svg><rect width="1"></rect></svg>');
    expect(sanitizeSvg('<svg><a href="javascript:alert(1)"><text>x</text></a></svg>')).toBe("<svg><text>x</text></svg>");
    expect(sanitizeSvg('<svg><rect fill="url(https://evil.example/x)" stroke="red" width="1"/></svg>')).toBe('<svg><rect stroke="red" width="1"></rect></svg>');
  });

  it("keeps only the root's sizing and font styles", () => {
    expect(sanitizeSvg('<svg style="max-width:640px;position:fixed;background:url(x)"><rect width="1"/></svg>')).toBe(
      '<svg style="max-width:640px"><rect width="1"></rect></svg>',
    );
    expect(sanitizeSvg('<svg><rect style="fill:red" width="1"/></svg>')).toBe('<svg><rect width="1"></rect></svg>');
  });

  it("refuses an empty figure and anything that is not an svg", () => {
    expect(sanitizeSvg("<svg><script>1</script></svg>")).toBeNull();
    expect(sanitizeSvg("<p>x</p>")).toBeNull();
    expect(sanitizeSvg(null)).toBeNull();
    expect(sanitizeSvg(42)).toBeNull();
  });
});

describe("URL rules", () => {
  it("links: http(s), mailto, tel, relative and fragments only", () => {
    for (const ok of ["https://ok.example", "http://ok.example", "mailto:a@ok.example", "tel:+391234", "/a:b", "#faq", "page?x=1", "../up"]) {
      expect(isSafeUrl(ok, "link"), ok).toBe(true);
    }
    for (const bad of ["javascript:alert(1)", "java\nscript:alert(1)", "JaVaScRiPt&colon;alert(1)", "&#106;avascript:x", "vbscript:x", "data:text/html,x", " javascript:x", "", "\u0000javascript:x"]) {
      expect(isSafeUrl(bad, "link"), bad).toBe(false);
    }
  });

  it("reads numeric references with any number of digits, as a browser does", () => {
    for (const bad of [
      "javascript&#000000058;alert(1)",
      "javascript&#0000000000058;alert(1)",
      "javascript&#x00000003a;alert(1)",
      "javascript&#x0000000003A;alert(1)",
      "&#0000000000106;avascript:alert(1)",
      "javascript&#58alert(1)",
    ]) {
      expect(isSafeUrl(bad, "link"), bad).toBe(false);
      expect(isSafeUrl(bad, "image"), bad).toBe(false);
    }
    // A reference that names no character is not a separator either.
    expect(isSafeUrl("javascript&#99999999999999999999;&colon;alert(1)", "link")).toBe(false);
    expect(isSafeUrl("/a&#0000047;b", "link")).toBe(true);
  });

  it("images: http(s) and relative only", () => {
    expect(isSafeUrl("https://cdn.example/x.png", "image")).toBe(true);
    expect(isSafeUrl("/a.webp", "image")).toBe(true);
    expect(isSafeUrl("mailto:a@b", "image")).toBe(false);
    expect(isSafeUrl("data:image/svg+xml,<svg/>", "image")).toBe(false);
    expect(isSafeUrl("blob:https://x/y", "image")).toBe(false);
  });

  it("embeds: a YouTube player only", () => {
    expect(isEmbedSrc("https://www.youtube-nocookie.com/embed/v1")).toBe(true);
    expect(isEmbedSrc("https://www.youtube.com/embed/v1")).toBe(true);
    expect(isEmbedSrc("https://evil.example/embed/v1")).toBe(false);
    expect(isEmbedSrc("http://www.youtube.com/embed/v1")).toBe(false);
  });
});

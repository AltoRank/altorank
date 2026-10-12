import { describe, expect, it } from "vitest";
import { fullArticleOn, readableHtml, readFirstArticleBody } from "../first-article-body";

describe("the gate's full-article reader", () => {
  it("is off unless PRETRIAL_FULL_ARTICLE is exactly 1", () => {
    expect(fullArticleOn({})).toBe(false);
    expect(fullArticleOn({ PRETRIAL_FULL_ARTICLE: "true" })).toBe(false);
    expect(fullArticleOn({ PRETRIAL_FULL_ARTICLE: "1" })).toBe(true);
  });

  it("reads nothing at all with the switch off", async () => {
    const untouchable = new Proxy({}, { get: () => { throw new Error("read with the switch off"); } });
    expect(await readFirstArticleBody(untouchable as never, "u1", "ws1", { env: {}, service: untouchable as never })).toEqual({ ok: false, reason: "off" });
  });

  it("keeps the article and drops what runs, embeds, navigates or is the writer's scaffolding", () => {
    const html = [
      "```html",
      "<h1>Title</h1>",
      '<p onclick="steal()">Kept <a href="javascript:alert(1)">link</a> and <a href="https://ok.example">ok</a>.</p>',
      "<script>alert(1)</script><style>p{}</style><iframe src=\"https://x.example\"></iframe>",
      "<h2>Section</h2><p>See {{internal-link:pricing guide}}.</p>",
      "<meta-description>The meta.</meta-description>",
      "<p>Half a sentence still being writ",
    ].join("\n");
    const out = readableHtml(html);
    expect(out).toContain("<p>Kept <a>link</a> and <a href=\"https://ok.example\" rel=\"nofollow noopener noreferrer\">ok</a>.</p>");
    expect(out).toContain("<h2>Section</h2><p>See pricing guide.</p>");
    expect(out).toContain("Half a sentence still being writ");
    for (const gone of ["<h1", "onclick", "javascript:", "<script", "<style", "<iframe", "meta-description", "```"]) expect(out).not.toContain(gone);
  });
});

describe("the reader's html, beyond the allowlist", () => {
  it("takes the finished article's table of contents out, label and all", () => {
    const saved =
      "<p>Intro.</p><p><strong>Contents</strong></p><ul><li><a href=\"#one\">One</a></li><li><p><a href=\"#two\">Two</a></p></li></ul>" +
      "<h2 id=\"one\">One</h2><p>See <a href=\"https://ok.example\">this</a>.</p><ul><li>A real list</li></ul>";
    const out = readableHtml(saved);
    expect(out).not.toContain("Contents");
    expect(out).not.toContain("#one");
    expect(out).toContain("<h2>One</h2>");
    expect(out).toContain("<ul><li>A real list</li></ul>");
  });

  it("holds back a link placeholder the writer is half-way through", () => {
    expect(readableHtml("<p>See {{internal-li")).toBe("<p>See </p>");
    expect(readableHtml("<p>See {{internal-link: pricing}} now")).toBe("<p>See pricing now</p>");
  });
});

import { describe, it, expect } from "vitest";
import { htmlToTiptapJson } from "../tiptap";
import { tiptapToHtml } from "@/lib/cms/html";

// What the enrichment pipeline writes has to survive the trip into the editor's
// JSON and back out to the CMS. Before this, `<figure><img>` unwrapped to
// nothing (no `img` node), `<nav>` and `<section>` were parsed as inline
// runs, heading ids were dropped, and an inline SVG became a paragraph of
// its own labels.

type N = { type: string; attrs?: Record<string, unknown>; content?: N[]; text?: string };
const doc = (html: string) => htmlToTiptapJson(html, { siteDomain: "example.com" }) as unknown as { content: N[] };

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img" aria-label="Bar chart: a 1, b 2"><title>a 1, b 2</title><rect width="1" height="1"></rect><text x="1" y="1">a</text></svg>';

describe("htmlToTiptapJson — enrichment markup", () => {
  it("keeps heading ids", () => {
    const [h] = doc('<h2 id="pricing">Pricing</h2>').content;
    expect(h).toMatchObject({ type: "heading", attrs: { level: 2, id: "pricing" } });
    expect(doc("<h2>Plain</h2>").content[0].attrs).toEqual({ level: 2 });
  });

  it("turns an image figure into one image node carrying alt and caption", () => {
    const [img] = doc('<figure class="article-image"><img src="https://cdn/x.webp" alt="Sketch of setup" loading="lazy"><figcaption>The first step</figcaption></figure>').content;
    expect(img).toEqual({ type: "image", attrs: { src: "https://cdn/x.webp", alt: "Sketch of setup", title: null, caption: "The first step" } });
  });

  it("handles a bare img and an image figure without a caption", () => {
    expect(doc('<img src="/a.webp" alt="A">').content[0]).toMatchObject({ type: "image", attrs: { src: "/a.webp", alt: "A" } });
    expect(doc('<figure><img src="/b.webp" alt="B"></figure>').content[0].attrs).not.toHaveProperty("caption");
  });

  it("turns a video figure into an iframe node with its caption", () => {
    const [frame] = doc('<figure class="video-embed"><iframe src="https://www.youtube-nocookie.com/embed/v1" title="T" allowfullscreen></iframe><figcaption>Video: T</figcaption></figure>').content;
    expect(frame).toMatchObject({ type: "iframe", attrs: { src: "https://www.youtube-nocookie.com/embed/v1", title: "T", caption: "Video: T" } });
  });

  it("keeps an inline SVG as source in an svgFigure node instead of walking it", () => {
    const [fig] = doc(`<figure class="infographic">${SVG}<figcaption>Figures from the text: “x”</figcaption></figure>`).content;
    expect(fig.type).toBe("svgFigure");
    expect(fig.attrs?.svg).toBe(SVG);
    expect(fig.attrs?.caption).toBe("Figures from the text: “x”");
  });

  it("parses the children of nav and section in place", () => {
    const nodes = doc('<nav class="toc"><p><strong>Contents</strong></p><ul><li><a href="#a">A</a></li><li><a href="#b">B</a></li></ul></nav><section class="cta"><h2>More</h2><p>Visit <a href="https://example.com">example.com</a>.</p></section>').content;
    expect(nodes.map((n) => n.type)).toEqual(["paragraph", "bulletList", "heading", "paragraph"]);
    const link = nodes[1].content?.[0].content?.[0].content?.[0];
    expect(link?.text).toBe("A");
    // An anchor link is neither external nor nofollow.
    expect((link as { marks?: { attrs?: Record<string, unknown> }[] }).marks?.[0].attrs).toMatchObject({ href: "#a", rel: null });
  });
});

describe("htmlToTiptapJson — link marks end at </a>", () => {
  it("does not carry the link mark onto the text after the anchor", () => {
    const [p] = doc('<p>Visit <a href="https://x.test">here</a> now.</p>').content;
    const [, link, after] = p.content!;
    expect(link).toMatchObject({ text: "here", marks: [{ type: "link" }] });
    expect(after.text).toBe(" now.");
    expect((after as { marks?: unknown[] }).marks).toBeUndefined();
  });
});

describe("tiptapToHtml — enrichment nodes", () => {
  it("round-trips an enriched fragment", () => {
    const html =
      '<h2 id="pricing">Pricing</h2>' +
      '<figure class="article-image"><img src="https://cdn/x.webp" alt="Alt" loading="lazy"><figcaption>Cap</figcaption></figure>' +
      '<figure class="video-embed"><iframe src="https://www.youtube-nocookie.com/embed/v1" title="T"></iframe><figcaption>Video: T</figcaption></figure>' +
      `<figure class="infographic">${SVG}<figcaption>Src</figcaption></figure>`;
    const out = tiptapToHtml(htmlToTiptapJson(html) as unknown as Record<string, unknown>);
    expect(out).toContain('<h2 id="pricing">Pricing</h2>');
    expect(out).toContain('<figure class="article-image"><img src="https://cdn/x.webp" alt="Alt" loading="lazy" /><figcaption>Cap</figcaption></figure>');
    expect(out).toContain('<iframe src="https://www.youtube-nocookie.com/embed/v1" title="T"');
    expect(out).toContain("<figcaption>Video: T</figcaption>");
    expect(out).toContain(`<figure class="infographic">${SVG}<figcaption>Src</figcaption></figure>`);
  });

  it("refuses an iframe from any host but YouTube and an SVG with a script", () => {
    expect(tiptapToHtml({ type: "doc", content: [{ type: "iframe", attrs: { src: "https://evil.test/x" } }] })).toBe("");
    expect(tiptapToHtml({ type: "doc", content: [{ type: "svgFigure", attrs: { svg: "<svg><script>1</script></svg>" } }] })).toBe("");
  });

  it("still renders a plain image as a plain img", () => {
    expect(tiptapToHtml({ type: "doc", content: [{ type: "image", attrs: { src: "/a.webp", alt: "A" } }] })).toBe('<img src="/a.webp" alt="A" />');
  });
});

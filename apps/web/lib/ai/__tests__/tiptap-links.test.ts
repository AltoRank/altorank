import { describe, it, expect } from "vitest";
import { htmlToTiptapJson } from "../tiptap";

// Every link mark used to be stored with rel="noopener noreferrer nofollow",
// the site's own pages included, so Copy as HTML told crawlers not to follow
// links from one article to the next. The converter is now told the domain
// and stores an explicit null, which Tiptap keeps (a missing attribute would
// be filled with the extension's nofollow default).

type Mark = { type: string; attrs?: Record<string, unknown> };
type Node = { type: string; content?: Node[]; marks?: Mark[] };

function linkMarks(html: string, siteDomain?: string): Mark[] {
  const doc = htmlToTiptapJson(html, { siteDomain }) as unknown as Node;
  const out: Mark[] = [];
  const walk = (n: Node) => {
    for (const m of n.marks ?? []) if (m.type === "link") out.push(m);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return out;
}

describe("htmlToTiptapJson — link attributes", () => {
  it("stores an internal absolute link with no rel and no target", () => {
    const [mark] = linkMarks(
      '<p><a href="https://www.example.com/blog/x">x</a></p>',
      "example.com",
    );
    expect(mark.attrs).toEqual({ href: "https://www.example.com/blog/x", rel: null, target: null });
  });

  it("treats a relative path as internal whether or not the domain is known", () => {
    expect(linkMarks('<p><a href="/blog/x">x</a></p>')[0].attrs).toEqual({
      href: "/blog/x",
      rel: null,
      target: null,
    });
  });

  it("keeps nofollow and a new tab on an outbound citation", () => {
    const [mark] = linkMarks('<p><a href="https://litmus.com/r">r</a></p>', "example.com");
    expect(mark.attrs).toEqual({
      href: "https://litmus.com/r",
      rel: "noopener noreferrer nofollow",
      target: "_blank",
    });
  });

  it("accepts the domain with a scheme or www prefix", () => {
    for (const domain of ["https://www.example.com", "www.example.com", "Example.com/"]) {
      const [mark] = linkMarks('<p><a href="https://example.com/a">a</a></p>', domain);
      expect(mark.attrs?.rel).toBeNull();
    }
  });

  it("does not apply the site's attributes to another domain that merely contains it", () => {
    const [mark] = linkMarks('<p><a href="https://notexample.com/a">a</a></p>', "example.com");
    expect(mark.attrs?.rel).toBe("noopener noreferrer nofollow");
  });
});

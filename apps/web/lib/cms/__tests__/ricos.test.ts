import { describe, it, expect, vi, beforeEach } from "vitest";
import { htmlToRicosNodes, blocksToRicosNodes } from "../ricos";
import { parseRichHtml } from "../rich-html";
import { WixAdapter, postUrl } from "../wix";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
beforeEach(() => mockFetch.mockReset());

const wix = new WixAdapter({ type: "wix", accountId: "a1", siteId: "s1", apiKey: "k" });

function textOf(node: unknown): string {
  const n = node as { nodes?: unknown[]; textData?: { text?: string } };
  if (n.textData?.text !== undefined) return n.textData.text;
  return (n.nodes ?? []).map(textOf).join("");
}

describe("htmlToRicosNodes", () => {
  it("carries the article text, not an empty paragraph", () => {
    const nodes = htmlToRicosNodes("<h2>Heading</h2><p>Body text.</p>");
    expect(nodes.map((n) => n.type)).toEqual(["HEADING", "PARAGRAPH"]);
    expect(nodes.map(textOf)).toEqual(["Heading", "Body text."]);
    expect(nodes[0].headingData).toEqual({ level: 2 });
  });

  it("turns a link into a LINK decoration rather than dropping the paragraph", () => {
    const nodes = htmlToRicosNodes('<p>See our <a href="https://example.com/x">guide</a>.</p>');
    const texts = nodes[0].nodes as unknown as Array<{ textData: { text: string; decorations: unknown[] } }>;
    expect(texts.map((t) => t.textData.text)).toEqual(["See our ", "guide", "."]);
    expect(texts[1].textData.decorations).toEqual([
      { type: "LINK", linkData: { link: { url: "https://example.com/x", target: "BLANK" } } },
    ]);
  });

  it("opens a root-relative link in the same tab", () => {
    const nodes = htmlToRicosNodes('<p><a href="/pricing">Pricing</a></p>');
    const texts = nodes[0].nodes as unknown as Array<{ textData: { decorations: Array<{ linkData?: { link: { target: string } } }> } }>;
    expect(texts[0].textData.decorations[0].linkData?.link.target).toBe("SELF");
  });

  it("sends bold and italic as decorations", () => {
    const nodes = htmlToRicosNodes("<p><strong>b</strong><em>i</em></p>");
    const texts = nodes[0].nodes as unknown as Array<{ textData: { decorations: Array<{ type: string }> } }>;
    expect(texts[0].textData.decorations[0].type).toBe("BOLD");
    expect(texts[1].textData.decorations[0].type).toBe("ITALIC");
  });

  it("gathers consecutive items into one list node per kind", () => {
    const nodes = htmlToRicosNodes("<ul><li>one</li><li>two</li></ul><ol><li>a</li></ol>");
    expect(nodes.map((n) => n.type)).toEqual(["BULLETED_LIST", "ORDERED_LIST"]);
    expect(nodes[0].nodes).toHaveLength(2);
    expect(nodes[0].nodes.every((n) => n.type === "LIST_ITEM")).toBe(true);
    expect(nodes[0].nodes.map(textOf)).toEqual(["one", "two"]);
  });

  it("sends quotes, code and dividers", () => {
    const nodes = htmlToRicosNodes(
      "<blockquote><p>q</p></blockquote><pre><code>x = 1</code></pre><hr />",
    );
    expect(nodes.map((n) => n.type)).toEqual(["BLOCKQUOTE", "CODE_BLOCK", "DIVIDER"]);
    expect(textOf(nodes[1])).toBe("x = 1");
  });

  it("gives every node a unique id", () => {
    const nodes = htmlToRicosNodes("<p>a</p><p>b</p><ul><li>c</li></ul>");
    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it("flattens a table to one paragraph per row rather than dropping it", () => {
    const nodes = htmlToRicosNodes("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>");
    expect(nodes.map(textOf)).toEqual(["A | B", "1 | 2"]);
  });

  it("throws rather than publish an empty body", () => {
    expect(() => htmlToRicosNodes("")).toThrow(/converted to nothing/);
    expect(() => htmlToRicosNodes("<p>   </p>")).toThrow(/converted to nothing/);
  });

  it("throws when the only content is a node Wix cannot take", () => {
    // An image alone: a Ricos IMAGE node needs a Wix Media id, so there is
    // nothing to send and an empty post must not be created.
    expect(blocksToRicosNodes(parseRichHtml('<img src="/a.png" alt="" />'))).toEqual([]);
    expect(() => htmlToRicosNodes('<figure><img src="https://cdn.example.com/a.png" alt="x" /></figure>')).toThrow(
      /no text, list or heading/,
    );
  });
});

describe("WixAdapter", () => {
  it("publish() sends the converted body and returns Wix's own URL", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ draftPost: { id: "d1" } }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ post: { id: "p1", url: { base: "https://acme.com", path: "/post/hello" } } }),
      });

    const result = await wix.publish({
      title: "Hello",
      html: '<p>World with a <a href="https://x.test/y">link</a>.</p>',
      slug: "hello",
      publishMode: "publish",
    });

    expect(result).toEqual({ externalId: "p1", url: "https://acme.com/post/hello" });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const nodes = body.draftPost.richContent.nodes;
    expect(nodes).toHaveLength(1);
    expect(textOf(nodes[0])).toBe("World with a link.");
  });

  it("publish() returns no URL when Wix reports none, instead of a wixsite.com guess", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ draftPost: { id: "d1" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ post: { id: "p1" } }) });

    const result = await wix.publish({ title: "T", html: "<p>x</p>", slug: "t", publishMode: "publish" });
    expect(result.url).toBe("");
  });

  it("publish() creates nothing when the body is empty", async () => {
    await expect(
      wix.publish({ title: "T", html: "", slug: "t", publishMode: "publish" }),
    ).rejects.toThrow(/converted to nothing/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("a draft connection stops after the draft and claims no URL", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ draftPost: { id: "d9" } }) });
    const result = await wix.publish({ title: "T", html: "<p>x</p>", slug: "t", publishMode: "draft" });
    expect(result).toEqual({ externalId: "d9", url: "" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("postUrl", () => {
  it("joins Wix's split page URL", () => {
    expect(postUrl({ base: "https://a.com/", path: "/post/x" })).toBe("https://a.com/post/x");
    expect(postUrl({ base: "https://a.com" })).toBe("https://a.com");
  });
  it("passes a plain string through and refuses anything else", () => {
    expect(postUrl("https://a.com/post/x")).toBe("https://a.com/post/x");
    expect(postUrl(undefined)).toBe("");
    expect(postUrl({})).toBe("");
  });
});

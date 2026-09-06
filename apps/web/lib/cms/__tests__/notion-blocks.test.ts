import { describe, it, expect, vi, beforeEach } from "vitest";
import { htmlToNotionBlocks, richText, pageChildren, NOTION_MAX_TEXT } from "../notion-blocks";
import { NotionAdapter, readNotionSchema } from "../notion";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
beforeEach(() => mockFetch.mockReset());

type Rich = { type: string; text: { content: string; link?: { url: string } }; annotations?: Record<string, boolean> };
function rich(block: Record<string, unknown>): Rich[] {
  const payload = block[block.type as string] as { rich_text?: Rich[] };
  return payload.rich_text ?? [];
}
function plain(block: Record<string, unknown>): string {
  return rich(block).map((r) => r.text.content).join("");
}

const schema = {
  ok: true,
  json: async () => ({
    properties: { Title: { type: "title" }, Slug: { type: "rich_text" }, Stage: { type: "status" } },
  }),
};
const page = { ok: true, json: async () => ({ id: "pg1", url: "https://notion.so/pg1" }) };

describe("htmlToNotionBlocks", () => {
  it("keeps a paragraph that contains a link, and annotates the link", () => {
    // The finding: `([^<]*)` matched no paragraph containing a tag, so every
    // paragraph with an internal link was dropped from the article.
    const blocks = htmlToNotionBlocks('<p>Read the <a href="https://example.com/g">guide</a> first.</p>');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    expect(plain(blocks[0])).toBe("Read the guide first.");
    expect(rich(blocks[0])[1].text.link).toEqual({ url: "https://example.com/g" });
  });

  it("keeps the words but drops a relative link, which Notion rejects", () => {
    const blocks = htmlToNotionBlocks('<p>See <a href="/pricing">pricing</a>.</p>');
    expect(plain(blocks[0])).toBe("See pricing.");
    expect(rich(blocks[0])[1].text.link).toBeUndefined();
  });

  it("annotates bold, italic, strike, underline and code", () => {
    const blocks = htmlToNotionBlocks(
      "<p><strong>b</strong><em>i</em><s>s</s><u>u</u><code>c</code></p>",
    );
    expect(rich(blocks[0]).map((r) => r.annotations)).toEqual([
      { bold: true },
      { italic: true },
      { strikethrough: true },
      { underline: true },
      { code: true },
    ]);
  });

  it("keeps list items as list items instead of flattening them to paragraphs", () => {
    const blocks = htmlToNotionBlocks("<ul><li><p>one</p></li><li><p>two</p></li></ul><ol><li>a</li></ol>");
    expect(blocks.map((b) => b.type)).toEqual([
      "bulleted_list_item",
      "bulleted_list_item",
      "numbered_list_item",
    ]);
  });

  it("nests a deeper list item under the item above it", () => {
    const blocks = htmlToNotionBlocks("<ul><li>outer<ul><li>inner</li></ul></li></ul>");
    expect(blocks).toHaveLength(1);
    const payload = blocks[0].bulleted_list_item as { children?: Record<string, unknown>[] };
    expect(payload.children).toHaveLength(1);
    expect(plain(payload.children![0])).toBe("inner");
  });

  it("maps headings to Notion's three levels, keeping h4+ as headings", () => {
    const blocks = htmlToNotionBlocks("<h1>a</h1><h2>b</h2><h3>c</h3><h4>d</h4>");
    expect(blocks.map((b) => b.type)).toEqual(["heading_1", "heading_2", "heading_3", "heading_3"]);
  });

  it("sends quotes, code, dividers, images and embeds", () => {
    const blocks = htmlToNotionBlocks(
      '<blockquote><p>q</p></blockquote><pre><code>x=1</code></pre><hr />' +
        '<figure><img src="https://cdn.test/a.png" alt="a" /><figcaption>Cap</figcaption></figure>' +
        '<figure><iframe src="https://www.youtube-nocookie.com/embed/x"></iframe></figure>',
    );
    expect(blocks.map((b) => b.type)).toEqual(["quote", "code", "divider", "image", "embed"]);
    expect(blocks[3].image).toMatchObject({ type: "external", external: { url: "https://cdn.test/a.png" } });
    expect(blocks[4].embed).toEqual({ url: "https://www.youtube-nocookie.com/embed/x" });
  });

  it("sends a table as a table, with its header row flagged", () => {
    const blocks = htmlToNotionBlocks("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>");
    const table = blocks[0].table as {
      table_width: number;
      has_column_header: boolean;
      children: Record<string, unknown>[];
    };
    expect(table.table_width).toBe(2);
    expect(table.has_column_header).toBe(true);
    expect(table.children).toHaveLength(2);
  });
});

describe("richText", () => {
  it("splits a run at Notion's 2,000-character limit rather than losing the tail", () => {
    const runs = richText([{ text: "x".repeat(4500) }]);
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => (r.text as { content: string }).content.length)).toEqual([
      NOTION_MAX_TEXT,
      NOTION_MAX_TEXT,
      500,
    ]);
  });
});

describe("pageChildren", () => {
  it("splits into a first hundred and batches for the rest", () => {
    const blocks = Array.from({ length: 250 }, (_, i) => ({ type: "paragraph", i }));
    const { first, rest } = pageChildren(blocks);
    expect(first).toHaveLength(100);
    expect(rest.map((b) => b.length)).toEqual([100, 50]);
  });
});

describe("readNotionSchema", () => {
  it("finds the title property whatever it is called", () => {
    expect(readNotionSchema({ Article: { type: "title" } })).toEqual({
      titleProperty: "Article",
      slugProperty: null,
      types: { Article: "title" },
    });
  });

  it("finds a rich-text Slug property, case-insensitively", () => {
    const s = readNotionSchema({ Name: { type: "title" }, slug: { type: "rich_text" } });
    expect(s.slugProperty).toBe("slug");
  });

  it("ignores a Slug property of the wrong type rather than 400ing on it", () => {
    const s = readNotionSchema({ Name: { type: "title" }, Slug: { type: "select" } });
    expect(s.slugProperty).toBeNull();
  });

  it("refuses a database with no title property", () => {
    expect(() => readNotionSchema({ Slug: { type: "rich_text" } })).toThrow(/no title property/);
  });
});

describe("NotionAdapter", () => {
  const notion = () => new NotionAdapter({ type: "notion", databaseId: "db", integrationToken: "t" });

  it("writes the title to the database's own title property", async () => {
    mockFetch.mockResolvedValueOnce(schema).mockResolvedValueOnce(page);
    const result = await notion().publish({ title: "Hello", html: "<p>body</p>", slug: "hello" });

    expect(result).toEqual({ externalId: "pg1", url: "https://notion.so/pg1" });
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(Object.keys(body.properties)).toEqual(["Title", "Slug"]);
    expect(body.properties.Title.title[0].text.content).toBe("Hello");
    expect(body.children).toHaveLength(1);
  });

  it("appends the blocks past the hundred-per-request cap instead of truncating", async () => {
    const html = Array.from({ length: 130 }, (_, i) => `<p>para ${i}</p>`).join("");
    mockFetch
      .mockResolvedValueOnce(schema)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await notion().publish({ title: "T", html, slug: "t" });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).children).toHaveLength(100);
    const append = mockFetch.mock.calls[2];
    expect(append[0]).toBe("https://api.notion.com/v1/blocks/pg1/children");
    expect(append[1].method).toBe("PATCH");
    expect(JSON.parse(append[1].body).children).toHaveLength(30);
  });

  it("says the page is incomplete when an append fails", async () => {
    const html = Array.from({ length: 130 }, (_, i) => `<p>para ${i}</p>`).join("");
    mockFetch
      .mockResolvedValueOnce(schema)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "rate limited" });

    await expect(notion().publish({ title: "T", html, slug: "t" })).rejects.toThrow(
      /incomplete/,
    );
  });

  it("refuses an empty body rather than creating an empty page", async () => {
    mockFetch.mockResolvedValueOnce(schema);
    await expect(notion().publish({ title: "T", html: "", slug: "t" })).rejects.toThrow(
      /converted to no blocks/,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("writes a select-typed status property as a select, not a status", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ properties: { Name: { type: "title" }, Stage: { type: "select" } } }),
      })
      .mockResolvedValueOnce(page);
    const adapter = new NotionAdapter({
      type: "notion",
      databaseId: "db",
      integrationToken: "t",
      statusProperty: "Stage",
    });
    await adapter.publish({ title: "T", html: "<p>x</p>", slug: "t", publishMode: "draft" });
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.properties.Stage).toEqual({ select: { name: "Draft" } });
  });

  it("testConnection fails when the named status property is missing", async () => {
    mockFetch.mockResolvedValueOnce(schema);
    const adapter = new NotionAdapter({
      type: "notion",
      databaseId: "db",
      integrationToken: "t",
      statusProperty: "Nope",
    });
    const r = await adapter.testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no "Nope" property/);
  });

  it("testConnection fails when the database has no title property", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ properties: {} }) });
    const r = await notion().testConnection();
    expect(r).toEqual({
      ok: false,
      error: expect.stringMatching(/no title property/),
    });
  });
});

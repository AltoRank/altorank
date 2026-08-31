import { describe, it, expect } from "vitest";
import { htmlToTiptapJson } from "../tiptap";
import { tiptapToHtml } from "@/lib/cms/html";

// A generated pricing table used to arrive in the editor, and in the published
// article, as one paragraph reading "Pricing modelHow it worksBest fitMonthly
// retainerFixed scope...". The serialiser already knew about tables; only the
// parser did not, so the damage happened on the way in and everything
// downstream faithfully reproduced it.
const TABLE = `<table><thead><tr><th>Pricing model</th><th>How it works</th></tr></thead>
<tbody><tr><td>Monthly retainer</td><td>Fixed scope</td></tr>
<tr><td>Project-based</td><td>Fixed price</td></tr></tbody></table>`;

type N = { type: string; content?: N[] };

describe("htmlToTiptapJson — tables", () => {
  it("produces a table node rather than loose text", () => {
    const doc = htmlToTiptapJson(TABLE) as unknown as N;
    expect(doc.content?.some((n) => n.type === "table")).toBe(true);
  });

  it("keeps every row, including the header row", () => {
    const table = (htmlToTiptapJson(TABLE) as unknown as N).content!.find(
      (n) => n.type === "table",
    )!;
    expect(table.content).toHaveLength(3);
  });

  it("marks header cells as tableHeader and body cells as tableCell", () => {
    const table = (htmlToTiptapJson(TABLE) as unknown as N).content!.find(
      (n) => n.type === "table",
    )!;
    expect(table.content![0].content!.map((c) => c.type)).toEqual([
      "tableHeader",
      "tableHeader",
    ]);
    expect(table.content![1].content!.map((c) => c.type)).toEqual([
      "tableCell",
      "tableCell",
    ]);
  });

  it("wraps cell content in a block node, as the schema requires", () => {
    const table = (htmlToTiptapJson(TABLE) as unknown as N).content!.find(
      (n) => n.type === "table",
    )!;
    expect(table.content![0].content![0].content![0].type).toBe("paragraph");
  });

  it("survives the round trip back to publishable HTML", () => {
    const html = tiptapToHtml(htmlToTiptapJson(TABLE) as never);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
    expect(html).toContain("Monthly retainer");
    // The bug signature: two cells fused with no markup between them.
    expect(html).not.toContain("Pricing modelHow it works");
  });

  it("recovers a row whose closing tag the model forgot", () => {
    const doc = htmlToTiptapJson("<table><tr><td>a</td><td>b</td></table>") as unknown as N;
    const table = doc.content!.find((n) => n.type === "table")!;
    expect(table.content).toHaveLength(1);
  });

  it("ignores an empty table rather than emitting a broken node", () => {
    const doc = htmlToTiptapJson("<table></table>") as unknown as N;
    expect(doc.content?.some((n) => n.type === "table")).toBe(false);
  });
});

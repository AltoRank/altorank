import { describe, expect, it } from "vitest";
import { countWords, planReplace, type TiptapNode } from "../replace";

const doc: TiptapNode = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Why Acme Widgets win" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Acme widgets are " },
        { type: "text", text: "acme", marks: [{ type: "bold" }] },
        { type: "text", text: "-grade. Visit " },
        { type: "text", text: "acme.com", marks: [{ type: "link", attrs: { href: "https://acme.com" } }] },
        { type: "text", text: " today." },
      ],
    },
    { type: "image", attrs: { src: "https://acme.com/acme.png", alt: "Acme" } },
  ],
};

describe("planReplace", () => {
  it("replaces in the title and every text node, case-insensitive by default, and counts each hit", () => {
    const plan = planReplace({ title: "Acme Widgets 2026", content: doc }, { find: "acme", replace: "Zenith" });
    expect(plan.occurrences).toBe(5);
    expect(plan.title).toBe("Zenith Widgets 2026");
    expect(plan.hits.filter((h) => h.where === "title")).toHaveLength(1);
    expect(plan.hits.filter((h) => h.where === "body")).toHaveLength(4);
    const texts: string[] = [];
    const walk = (n: TiptapNode) => {
      if (n.text) texts.push(n.text);
      n.content?.forEach(walk);
    };
    walk(plan.content!);
    expect(texts.join("")).toBe("Why Zenith Widgets winZenith widgets are Zenith-grade. Visit Zenith.com today.");
  });

  it("leaves non-text nodes, marks and attrs exactly as they were", () => {
    const plan = planReplace({ title: "t", content: doc }, { find: "acme", replace: "Zenith" });
    const image = plan.content!.content![2];
    expect(image).toBe(doc.content![2]); // same object: untouched
    const link = plan.content!.content![1].content![3];
    expect(link.marks).toEqual([{ type: "link", attrs: { href: "https://acme.com" } }]);
  });

  it("returns the same content object and zero hits when nothing matches", () => {
    const plan = planReplace({ title: "t", content: doc }, { find: "nothing-here", replace: "x" });
    expect(plan.occurrences).toBe(0);
    expect(plan.content).toBe(doc);
    expect(plan.title).toBe("t");
  });

  it("honours match_case and whole_word", () => {
    const cased = planReplace({ title: "Acme and acme", content: null }, { find: "acme", replace: "Z", match_case: true });
    expect(cased.occurrences).toBe(1);
    expect(cased.title).toBe("Acme and Z");

    const whole = planReplace({ title: "rank AltoRank ranking", content: null }, { find: "rank", replace: "R", whole_word: true });
    expect(whole.occurrences).toBe(1);
    expect(whole.title).toBe("R AltoRank ranking");
  });

  it("never matches across node boundaries", () => {
    const split: TiptapNode = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Alto" }, { type: "text", text: "Rank", marks: [{ type: "bold" }] }] }],
    };
    expect(planReplace({ title: "", content: split }, { find: "AltoRank", replace: "x" }).occurrences).toBe(0);
  });

  it("marks the hit in the excerpt with « » before and after", () => {
    const plan = planReplace({ title: "Buy Acme now", content: null }, { find: "Acme", replace: "Zenith" });
    expect(plan.hits[0].before).toBe("Buy «Acme» now");
    expect(plan.hits[0].after).toBe("Buy «Zenith» now");
  });

  it("refuses an empty find", () => {
    expect(() => planReplace({ title: "t", content: null }, { find: "", replace: "x" })).toThrow(/empty/);
  });

  it("counts words the way the editor does", () => {
    expect(countWords(doc)).toBe(12);
    expect(countWords(null)).toBe(0);
  });
});

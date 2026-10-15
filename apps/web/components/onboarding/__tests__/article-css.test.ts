import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The gate's article styles, as rules: the reader's text and its tables are
// the product on that screen, and a phone cut a table's words into letters
// ("Cro/ss-/stitc/h") because the prose's `overflow-wrap: anywhere` reached
// the cells (UX audit 2026-10-12, #11).

const css = readFileSync(join(__dirname, "../../../app/globals.css"), "utf8");
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

describe("the first article's tables", () => {
  it("never break a word inside a cell, and give each cell a readable width", () => {
    const cells = rule(".article-text th, .article-text td");
    expect(cells).toContain("overflow-wrap: normal");
    expect(cells).toContain("word-break: normal");
    expect(cells).toMatch(/min-width: 7\.5rem/);
  });

  it("scroll sideways in their own box instead of squeezing", () => {
    const table = rule(".article-text table");
    expect(table).toContain("display: block");
    expect(table).toContain("overflow-x: auto");
    expect(table).toContain("max-width: 100%");
  });
});

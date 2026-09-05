import { describe, it, expect } from "vitest";
import { addInfographics, chartFromList, chartFromBeforeAfter, extractMeasures, renderBarChart } from "../infographic";
import { isSafeSvg } from "../svg";
import { ARTICLE, SECTION } from "./fixtures";

describe("infographic: recognising comparable numbers", () => {
  it("reads a list of three items with one shared unit each", () => {
    const spec = chartFromList("<ul><li>Starter: €9 per month</li><li>Team: €29 per month</li><li>Business: €79 per month</li></ul>");
    expect(spec?.unit).toBe("€");
    expect(spec?.data).toEqual([
      { label: "Starter", value: 9 },
      { label: "Team", value: 29 },
      { label: "Business", value: 79 },
    ]);
  });

  it("refuses mixed units, items with two numbers, and fewer than three items", () => {
    expect(chartFromList("<ul><li>A: 9%</li><li>B: €29</li><li>C: 79%</li></ul>")).toBeNull();
    expect(chartFromList("<ul><li>A: 9% in 2 days</li><li>B: 29%</li><li>C: 79%</li></ul>")).toBeNull();
    expect(chartFromList("<ul><li>A: 9%</li><li>B: 29%</li></ul>")).toBeNull();
  });

  it("reads a before/after pair and ignores years", () => {
    expect(chartFromBeforeAfter("Adoption rose from 42% to 61% in a year.")?.data.map((d) => d.value)).toEqual([42, 61]);
    expect(chartFromBeforeAfter("The company grew from 2019 to 2024.")).toBeNull();
    expect(chartFromBeforeAfter("Costs went from €120 to 40%.")).toBeNull();
  });

  it("does not treat bare years as measures", () => {
    expect(extractMeasures("In 2024 the rate was 12%.")).toEqual([{ value: 12, unit: "%", index: 21 }]);
  });
});

describe("infographic: rendering", () => {
  it("fills the bars with the brand colour when one is set, currentColor otherwise, and refuses a non-hex", () => {
    const spec = { unit: "%", source: "s", data: [{ label: "a", value: 1 }, { label: "b", value: 2 }] };
    expect(renderBarChart(spec, "en")).toContain('fill="currentColor"');
    const branded = renderBarChart(spec, "en", "#1a1815");
    expect(branded).toContain('fill="#1a1815"');
    expect(isSafeSvg(branded.match(/<svg[\s\S]*<\/svg>/)?.[0])).toBe(true);
    expect(renderBarChart(spec, "en", 'red" onload="x')).toContain('fill="currentColor"');
  });

  it("adds nothing when infographics are off", () => {
    expect(addInfographics(ARTICLE, { enabled: false })).toEqual({ html: ARTICLE, added: 0 });
  });

  it("renders an accessible inline SVG with a caption naming the source", () => {
    const figure = renderBarChart({ unit: "%", source: "From 42% to 61%.", data: [{ label: "from", value: 42 }, { label: "to", value: 61 }] });
    expect(figure).toContain('role="img"');
    expect(figure).toContain('aria-label="Bar chart: from 42%, to 61%"');
    expect(figure).toContain("<title>from 42%, to 61%</title>");
    expect(figure).toContain("<figcaption>Figures from the text: “From 42% to 61%.”</figcaption>");
    expect(figure).not.toMatch(/<script|onload/i);
    expect(isSafeSvg(figure.match(/<svg[\s\S]*<\/svg>/)?.[0])).toBe(true);
  });

  it("the safety check rejects scripts, handlers and external references", () => {
    expect(isSafeSvg('<svg><script>1</script></svg>')).toBe(false);
    expect(isSafeSvg('<svg><rect onload="x"/></svg>')).toBe(false);
    expect(isSafeSvg('<svg><image href="https://x/y.png"/></svg>')).toBe(false);
    expect(isSafeSvg('<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>')).toBe(true);
  });

  it("inserts one figure after the pricing list of the fixture and nothing elsewhere", () => {
    const { html, added } = addInfographics(ARTICLE);
    expect(added).toBe(1);
    const at = html.indexOf('<figure class="infographic">');
    expect(at).toBeGreaterThan(html.indexOf("Business: €79 per month</li></ul>"));
    expect(at).toBeLessThan(html.indexOf("Frequently asked questions"));
  });

  it("does nothing when numbers are not clearly comparable", () => {
    const html = SECTION("Mixed", "We saw 12% growth, 3 hires and €40,000 revenue in 2024.");
    expect(addInfographics(html).added).toBe(0);
  });

  it("respects the per-article cap", () => {
    const list = "<ul><li>A: 1%</li><li>B: 2%</li><li>C: 3%</li></ul>";
    const html = SECTION("One", list) + SECTION("Two", list) + SECTION("Three", list);
    expect(addInfographics(html).added).toBe(2);
    expect(addInfographics(html, { max: 0 }).added).toBe(0);
  });
});

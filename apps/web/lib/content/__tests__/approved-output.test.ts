import { beforeEach, expect, it, vi } from "vitest";
const { ask } = vi.hoisted(() => ({ask: vi.fn()}));
vi.mock("@/lib/keyword-research/buyer-model", () => ({askStructured: ask, extractJson: (raw: string) => { try { return JSON.parse(raw); } catch { return null; } }}));
import { enforceApprovedTitle, reviewApprovedOutput } from "../approved-output";
beforeEach(() => ask.mockReset());
it("preserves the approved headline with HTML escaping", () => {
  expect(enforceApprovedTitle('<h1 class="x">Changed</h1><p>Text</p>', 'Compare <A> & B')).toBe('<h1>Compare &lt;A&gt; &amp; B</h1><p>Text</p>');
});
it("reports unavailable checks honestly", async () => {
  ask.mockResolvedValue("not json");
  const result = await reviewApprovedOutput("<p>Draft</p>", {});
  expect(result.report).toMatchObject({status:"unavailable",productClaims:"not-checked"});
});
it("keeps flagged claims intact for review instead of leaving broken paragraphs", async () => {
  const unsupported = "Our product automatically exports every report.";
  const qualitative = "These contracts usually eliminate all business risk.";
  ask.mockResolvedValue(JSON.stringify({productChecked:true,qualitativeChecked:true,structureChecked:true,findings:[
    {category:"product",text:unsupported,reason:"No capability evidence"},
    {category:"qualitative",text:qualitative,reason:"Unsubstantiated guarantee"},
  ]}));
  const result = await reviewApprovedOutput(`<p>${"Discuss the buyer's requirements carefully. ".repeat(15)}</p><p>${unsupported}</p><p>${qualitative}</p>`, {});
  expect(result.html).toContain(unsupported); expect(result.html).toContain(qualitative);
  expect(result.report).toMatchObject({productClaims:"needs-review",qualitativeClaims:"needs-review"});
});
it("does not give clean status to invented review evidence", async () => {
  ask.mockResolvedValue(JSON.stringify({productChecked:true,qualitativeChecked:true,structureChecked:true,findings:[{category:"product",text:"A sentence that is absent from the article.",reason:"No evidence"}]}));
  expect((await reviewApprovedOutput("<p>The actual article.</p>", {})).report.status).toBe("unavailable");
});

it("removes only a complete paragraph repeated verbatim", async () => {
  const repeated="Choose a tool by testing a real article brief.";
  ask.mockResolvedValue(JSON.stringify({productChecked:true,qualitativeChecked:true,structureChecked:true,findings:[{category:"repetition",text:repeated,reason:"Same paragraph repeated"}]}));
  const result=await reviewApprovedOutput(`<p>${repeated}</p><p>Compare the results.</p><p>${repeated}</p>`,{});
  expect(result.html).toBe(`<p>${repeated}</p><p>Compare the results.</p>`);
  expect(result.report.structure).toBe("revised");
});

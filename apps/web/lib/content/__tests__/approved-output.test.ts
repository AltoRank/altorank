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

it("accepts a bounded correction only after a successful recheck", async () => {
  const { reviseApprovedOutput } = await import("../approved-output");
  const original = { html:"<p>All plans include three workspaces for your client sites.</p>", report: { status:"checked", headline:"preserved", productClaims:"needs-review", qualitativeClaims:"no-issues-detected", structure:"no-issues-detected", findings:[{category:"product",text:"All plans include three workspaces for your client sites.",reason:"Limit belongs to Managed",removed:false}] } } as const;
  const input = { ...original, report:{...original.report,findings:[...original.report.findings]} };
  ask.mockResolvedValueOnce(JSON.stringify({edits:[{index:0,html:"<p>The Managed plan includes three workspaces for client sites.</p>"}]})).mockResolvedValueOnce(JSON.stringify({productChecked:true,qualitativeChecked:true,structureChecked:true,findings:[]}));
  const result = await reviseApprovedOutput(input, {});
  expect(result.report.revision).toBe("accepted");
  expect(result.html).toContain("The Managed plan");
  ask.mockResolvedValueOnce(JSON.stringify({edits:[{index:0,html:"<p>The Managed plan includes three workspaces for client sites.</p>"}]})).mockResolvedValueOnce(null);
  expect((await reviseApprovedOutput(input, {})).html).toBe(original.html);
  ask.mockResolvedValueOnce(JSON.stringify({edits:[{index:0,html:'<p>Visit <a href="https://invented.test">our new plans</a> for unlimited sites.</p>'}]}));
  expect((await reviseApprovedOutput(input, {})).html).toBe(original.html);
});

it("matches review passages containing decoded HTML entities", async () => {
  ask.mockResolvedValue(JSON.stringify({productChecked:true,qualitativeChecked:true,structureChecked:true,findings:[{category:"product",text:"A & B support unlimited workspaces.",reason:"No plan context"}]}));
  expect((await reviewApprovedOutput("<p>A &amp; B support unlimited workspaces.</p>",{})).report.status).toBe("checked");
});

it("attaches exact existing passages by index and rejects invented indices", async () => {
  const finding = {category:"product",passageIndex:1,reason:"No evidence for a universal limit"};
  ask.mockResolvedValue(JSON.stringify({productChecked:true,qualitativeChecked:true,structureChecked:true,findings:[finding]}));
  const html = '<h1>Tool selection</h1><p>Every plan supports <strong>three workspaces</strong>.</p>';
  const review = await reviewApprovedOutput(html,{});
  expect(review.report.status).toBe("checked");
  expect(review.report.findings[0].text).toBe("Every plan supports three workspaces .");
  ask.mockResolvedValue(JSON.stringify({productChecked:true,qualitativeChecked:true,structureChecked:true,findings:[{...finding,passageIndex:20}]}));
  expect((await reviewApprovedOutput(html,{})).report.status).toBe("unavailable");
});

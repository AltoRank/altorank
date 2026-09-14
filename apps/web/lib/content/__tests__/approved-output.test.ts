import { beforeEach, expect, it, vi } from "vitest";
const { ask } = vi.hoisted(() => ({ask: vi.fn()}));
vi.mock("@/lib/keyword-research/buyer-model", () => ({askStructured: ask, extractJson: (raw: string) => { try { return JSON.parse(raw); } catch { return null; } }}));
import { enforceApprovedTitle, reviewApprovedOutput } from "../approved-output";
import { htmlToTiptapJson } from "@/lib/ai/tiptap";
import { tiptapToHtml } from "@/lib/cms/html";
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
  ask.mockResolvedValueOnce(JSON.stringify({edits:[{index:0,html:"<p>The Managed plan includes three workspaces for client sites.</p>"}]})).mockResolvedValueOnce(JSON.stringify({productChecked:true,qualitativeChecked:true,structureChecked:true,findings:[],resolutions:[{concernIndex:0,resolved:true}]}));
  const result = await reviseApprovedOutput(input, {});
  expect(result.report.revision).toBe("accepted");
  expect(result.html).toContain("The Managed plan");
  ask.mockResolvedValueOnce(JSON.stringify({edits:[{index:0,html:"<p>The Managed plan includes three workspaces for client sites.</p>"}]})).mockResolvedValueOnce(null);
  expect((await reviseApprovedOutput(input, {})).html).toBe(original.html);
  ask.mockResolvedValueOnce(JSON.stringify({edits:[{index:0,html:'<p>Visit <a href="https://invented.test">our new plans</a> for unlimited sites.</p>'}]}));
  expect((await reviseApprovedOutput(input, {})).html).toBe(original.html);
});

it("does not trade several original issues for one remaining error", async () => {
  const { reviseApprovedOutput } = await import("../approved-output");
  const sentence="Every plan includes three sites and guarantees first-place rankings.";
  const input={html:`<p>${sentence}</p>`,report:{status:"checked" as const,headline:"preserved" as const,productClaims:"needs-review" as const,qualitativeClaims:"needs-review" as const,structure:"no-issues-detected" as const,findings:[
    {category:"product" as const,text:sentence,reason:"Wrong plan limit",removed:false},
    {category:"qualitative" as const,text:sentence,reason:"Unsupported ranking guarantee",removed:false},
  ]}};
  const replacement="Managed allows three sites and doubles your revenue.";
  ask.mockResolvedValueOnce(JSON.stringify({edits:[{index:0,html:`<p>${replacement}</p>`}]})).mockResolvedValueOnce(JSON.stringify({productChecked:true,qualitativeChecked:true,structureChecked:true,resolutions:[{concernIndex:0,resolved:true},{concernIndex:1,resolved:true}],findings:[{category:"qualitative",passageIndex:0,reason:"New revenue guarantee"}]}));
  const result=await reviseApprovedOutput(input,{});
  expect(result.html).toBe(input.html);
  expect(result.report.revision).toBe("kept-original");
});

it("requires explicit resolution of original concerns even with no new flags",async()=>{
  ask.mockResolvedValue(JSON.stringify({productChecked:true,qualitativeChecked:true,structureChecked:true,findings:[],resolutions:[]}));
  const result=await reviewApprovedOutput("<p>The revised article makes a narrower claim.</p>",{previousConcerns:[{category:"product",text:"The old unsupported claim.",reason:"No evidence",removed:false}]});
  expect(result.report.status).toBe("unavailable");
});

it.each(["li","td"])("can repair an unsupported assertion in a %s without changing its container",async(tag)=>{
  const {reviseApprovedOutput}=await import("../approved-output");
  const text="This test confirms the exact location of the leak.";
  const html=`<${tag}>${text}</${tag}>`;
  const input={html,report:{status:"checked" as const,headline:"not-specified" as const,productClaims:"needs-review" as const,qualitativeClaims:"no-issues-detected" as const,structure:"no-issues-detected" as const,findings:[{category:"product" as const,text,reason:"The source does not pinpoint location",removed:false}]}};
  ask.mockResolvedValueOnce(JSON.stringify({edits:[{index:0,html:`<${tag}>This test can indicate a leak but does not pinpoint its location.</${tag}>`}]})).mockResolvedValueOnce(JSON.stringify({productChecked:true,qualitativeChecked:true,structureChecked:true,findings:[],resolutions:[{concernIndex:0,resolved:true}]}));
  const result=await reviseApprovedOutput(input,{});
  expect(result.report.revision).toBe("accepted");expect(result.html).toContain(`<${tag}>`);
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
it("reviews decoded visible entities rather than reporting valid HTML escaping as an article defect",async()=>{
  ask.mockResolvedValue(JSON.stringify({productChecked:true,qualitativeChecked:true,structureChecked:true,findings:[],resolutions:[]}));
  await reviewApprovedOutput('<p>Settings &gt; Conditions: l&#x27;attivit&agrave; &amp; forms.</p>',{});
  const payload=JSON.parse(ask.mock.calls[0][1].split('\n').at(-1));
  expect(payload.article[0].text).toBe("Settings > Conditions: l'attività & forms.");
});

const deliveryTitle="Track project progress: milestones, metrics and centralized tools";
const deliveryOptions={title:deliveryTitle,brief:{angle:deliveryTitle,buyingJob:"Identify blockers in real time",reason:"Broader feature catalogue",offering:"Every coordination feature"},task:"procedure" as const,requirements:["How are milestones organized?","Which metrics are tracked and interpreted?","How is progress tracked centrally?"],promises:[
  {id:"p0",source:"headline" as const,quote:"milestones",text:"Set milestones",expectedAnswer:"Set usable project milestones",mappingReason:"The question requests milestone setup",requirementIndices:[0]},
  {id:"p1",source:"headline" as const,quote:"metrics",text:"Use progress metrics",expectedAnswer:"Choose and interpret progress measures",mappingReason:"The question requests concrete progress measures",requirementIndices:[1]},
  {id:"p2",source:"headline" as const,quote:"centralized tools",text:"Track progress centrally",expectedAnswer:"Use centralized tools with correct state interpretation",mappingReason:"The question requests centralized progress tracking",requirementIndices:[2]},
]};
const deliveryHtml=`<h1>${deliveryTitle}</h1><p>Group work into milestones with clear due dates and task owners.</p><p>Track overdue tasks and compare completed tasks with the planned total during the team's weekly review.</p><p>Move a progress dot uphill while the approach has unknowns, then downhill when the approach is clear and work remains to execute.</p>`;
const deliveryResponse=()=>({productChecked:true,qualitativeChecked:true,structureChecked:true,findings:[],resolutions:[],delivery:{promises:deliveryOptions.promises.map((p,i)=>({promiseId:p.id,answered:true,passageIndices:[i+1],reason:"The reader receives the promised answer."})),procedure:{executable:true,passageIndices:[1,2,3],reason:"Actions and status meaning support the next review."}}});
it("records direct delivery for every frozen promise and an executable ongoing procedure",async()=>{
  ask.mockResolvedValue(JSON.stringify(deliveryResponse()));
  const result=await reviewApprovedOutput(deliveryHtml,deliveryOptions);
  expect(result.report).toMatchObject({status:"checked",delivery:{version:1,status:"checked",procedure:{executable:true}}});
  expect(result.report.findings).toEqual([]);
  const payload=JSON.parse(ask.mock.calls[0][1].split("\n").at(-1));
  expect(payload.promises).toEqual(deliveryOptions.promises);expect(payload.researchTask).toBe("procedure");
  expect(payload.approvedBrief).toEqual({angle:deliveryTitle,buyingJob:"Identify blockers in real time"});
  expect(ask.mock.calls[0][1]).toContain("ongoing routines need a useful next check");
  expect(ask.mock.calls[0][1]).toContain("A reader goal such as real-time tracking is not evidence");
});
it("creates material delivery findings for omitted metrics even when the model findings list is empty",async()=>{
  const response=deliveryResponse();response.delivery.promises[1]={promiseId:"p1",answered:false,passageIndices:[],reason:"It lists task-status features but never supplies a metric."};
  ask.mockResolvedValue(JSON.stringify(response));
  const result=await reviewApprovedOutput(deliveryHtml,deliveryOptions);
  expect(result.report).toMatchObject({status:"checked",qualitativeClaims:"needs-review",findings:[{category:"qualitative",severity:"material",text:deliveryTitle,reason:expect.stringContaining("Unfulfilled promise (Use progress metrics)")}]});
});
it("holds a sourced control instruction whose essential state interpretation is missing",async()=>{
  const response=deliveryResponse();response.delivery.procedure={executable:false,passageIndices:[3],reason:"The instruction says drag the dot but never explains how to choose its position."};
  ask.mockResolvedValue(JSON.stringify(response));
  const result=await reviewApprovedOutput(deliveryHtml,deliveryOptions);
  expect(result.report).toMatchObject({status:"checked",delivery:{procedure:{executable:false}},findings:[{severity:"material",reason:expect.stringContaining("not executable")}]});
});
it.each(["missing","duplicate","unknown","invented-passage","heading-only","missing-procedure","invalid-reason"])("does not approve malformed or unsupported delivery coverage: %s",async(kind)=>{
  const response=deliveryResponse();
  if(kind==="missing")response.delivery.promises.pop();
  if(kind==="duplicate")response.delivery.promises[1].promiseId="p0";
  if(kind==="unknown")response.delivery.promises[1].promiseId="p9";
  if(kind==="invented-passage")response.delivery.promises[1].passageIndices=[99];
  if(kind==="heading-only")response.delivery.promises[1].passageIndices=[0];
  if(kind==="missing-procedure")Object.assign(response.delivery,{procedure:null});
  if(kind==="invalid-reason")Object.assign(response.delivery.promises[0],{reason:123});
  ask.mockResolvedValue(JSON.stringify(response));
  const result=await reviewApprovedOutput(deliveryHtml,deliveryOptions);
  expect(result.report).toMatchObject({status:"unavailable",delivery:{version:1,status:"unavailable"}});
});
it("requires a complete current contract when essential questions are supplied",async()=>{
  const {promises:omitted,...legacy}=deliveryOptions;void omitted;
  const result=await reviewApprovedOutput(deliveryHtml,legacy);
  expect(result.report.status).toBe("unavailable");expect(ask).not.toHaveBeenCalled();
});
it("does not demand procedure evidence for a supported explanation",async()=>{
  const response=deliveryResponse();Object.assign(response.delivery,{procedure:null});
  ask.mockResolvedValue(JSON.stringify(response));
  const result=await reviewApprovedOutput(deliveryHtml,{...deliveryOptions,task:"explanation"});
  expect(result.report).toMatchObject({status:"checked",delivery:{status:"checked"}});
  expect(result.report.delivery?.procedure).toBeUndefined();
});

it.each([
  ["What's included?", "What&#39;s included?"],
  ['Compare "A" & B', "Compare &quot;A&quot; &amp; B"],
  ["Attività dell'équipe", "Attivit&agrave; dell&#x27;&eacute;quipe"],
])("keeps an already-correct serialized title byte-identical: %s", (title, encoded) => {
  const html=`<h1 id="approved-title">${encoded}</h1><p>The same article.</p>`;
  expect(enforceApprovedTitle(html,title)).toBe(html);
});


it.each(["&nbsp;","&#160;","&#xA0;","\u00a0","\n  "])("keeps equivalent title whitespace unchanged before and after document serialization: %s",async(space)=>{
  const title="Compare team tools";
  const original=`<h1 id="approved-title">Compare${space}team tools</h1><p>Use the same criteria.</p>`;
  expect(enforceApprovedTitle(original,title)).toBe(original);
  const saved=tiptapToHtml(htmlToTiptapJson(original) as unknown as Record<string,unknown>);
  expect(enforceApprovedTitle(saved,title)).toBe(saved);
  ask.mockResolvedValue(JSON.stringify({productChecked:true,qualitativeChecked:true,structureChecked:true,findings:[],resolutions:[]}));
  const reviewed=await reviewApprovedOutput(saved,{title,preserveReviewedHtml:true});
  expect(reviewed.html).toBe(saved);expect(reviewed.report.status).toBe("checked");
});
it("still replaces a changed title and does not interpret the approved title as HTML",()=>{
  expect(enforceApprovedTitle("<h1>Compareteam tools</h1>","Compare team tools")).toBe("<h1>Compare team tools</h1>");
  const literal="<h1>Write &amp;amp; literally</h1>";
  expect(enforceApprovedTitle(literal,"Write &amp; literally")).toBe(literal);
});

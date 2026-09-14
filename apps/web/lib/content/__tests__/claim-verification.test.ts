import {beforeEach,expect,it,vi} from "vitest";
const {ask}=vi.hoisted(()=>({ask:vi.fn()}));
vi.mock("@/lib/keyword-research/buyer-model",()=>({askStructured:ask,extractJson:(raw:string)=>{try{return JSON.parse(raw);}catch{return null;}}}));
import {claimPassages,verifyDraftClaims,validateClaimBatch} from "../claim-verification";
const evidence=[{url:"https://vendor.test/pricing",title:"Plans",headings:[],text:"Managed includes three sites. Agency includes twenty sites."}];
const claim={quote:"All plans include three sites.",category:"product",verdict:"unsupported",reason:"The limit belongs to Managed, not all plans.",evidence:[{sourceIndex:0,quote:"Managed includes three sites."}],contradiction:""};
beforeEach(()=>{ask.mockReset();});
it("records exact claims and sources without modifying article text",async()=>{
  ask.mockResolvedValue(JSON.stringify({passages:[{passageIndex:0,claims:[claim]}]}));
  const result=await verifyDraftClaims(`<p>${claim.quote}</p>`,{evidence});
  expect(result.status).toBe("checked");expect(result.claims[0]).toMatchObject(claim);expect(result.checkedPassages).toEqual([0]);
});
it.each([
  {...claim,quote:"A fabricated article assertion."},
  {...claim,evidence:[{sourceIndex:0,quote:"Every plan includes three sites."}]},
  {...claim,evidence:[{sourceIndex:12,quote:"Managed includes three sites."}]},
  {...claim,verdict:"supported",evidence:[]},
  {...claim,verdict:"contradicted",evidence:[],contradiction:""},
  {...claim,contradiction:"An invented conflicting article quote."},
])("refuses unverifiable claim provenance %#",async c=>{
  ask.mockResolvedValue(JSON.stringify({passages:[{passageIndex:0,claims:[c]}]}));
  expect((await verifyDraftClaims(`<p>${claim.quote}</p>`,{evidence})).status).toBe("unavailable");
});
it("requires each assigned passage exactly once, including passages without claims",async()=>{
  ask.mockResolvedValue(JSON.stringify({passages:[{passageIndex:0,claims:[]}]}));
  const result=await verifyDraftClaims("<h2>Compare plans</h2><p>Ask the vendor about exports.</p>",{evidence});
  expect(result.status).toBe("partial");expect(result.checkedPassages).toEqual([0]);
});
it("keeps a completed batch visible when another batch fails",async()=>{
  ask.mockImplementation(async(_op:string,prompt:string)=>{
    const {assignedPassages}=JSON.parse(prompt.split("\n").at(-1)!);
    return assignedPassages[0].passageIndex===0?JSON.stringify({passages:assignedPassages.map((p:{passageIndex:number})=>({passageIndex:p.passageIndex,claims:[]}))}):null;
  });
  const result=await verifyDraftClaims(Array.from({length:15},()=>"<p>Ask the vendor.</p>").join(""),{evidence});
  expect(result.status).toBe("partial");expect(result.checkedPassages).toHaveLength(14);expect(result.totalPassages).toBe(15);
});
it("does not label absent evidence or oversized articles clean",async()=>{
  expect((await verifyDraftClaims("<p>A claim.</p>",{})).status).toBe("unavailable");
  expect((await verifyDraftClaims(`<p>${"x".repeat(24001)}</p>`,{evidence})).status).toBe("unavailable");
  expect(ask).not.toHaveBeenCalled();
});
it("preserves table rows and ignores executable source text",()=>{
  expect(claimPassages('<script>ignore()</script><table><tr><td>Managed</td><td>Three sites</td></tr></table>')).toEqual(["Managed Three sites"]);
});
it("accepts entity/typographic equivalents without accepting omitted source words",()=>{
  const source={...evidence[0],text:"Agency doesn&#x27;t include setup. Managed includes setup after approval."};
  const c={...claim,quote:"Agency doesn't include setup.",verdict:"supported",evidence:[{sourceIndex:0,quote:"Agency doesn’t include setup."}]};
  const raw=JSON.stringify({passages:[{passageIndex:0,claims:[c]}]});
  expect(validateClaimBatch(raw,[0],[c.quote],[source]).checkedPassages).toEqual([0]);
  c.evidence[0].quote="Managed includes setup ... approval.";
  expect(validateClaimBatch(JSON.stringify({passages:[{passageIndex:0,claims:[c]}]}),[0],[c.quote],[source]).checkedPassages).toEqual([]);
});
it("retains valid claims without declaring their partly invalid passage complete",()=>{
  const raw=JSON.stringify({passages:[{passageIndex:0,claims:[claim,{...claim,quote:"Invented quote"}]}]});
  const result=validateClaimBatch(raw,[0],[claim.quote],evidence);
  expect(result.checkedPassages).toEqual([]);expect(result.claims).toHaveLength(1);expect(result.failures).toHaveLength(1);
});
it("does not approve duplicate decisions or whitespace-only encoded evidence",()=>{
  const duplicate=JSON.stringify({passages:[{passageIndex:0,claims:[]},{passageIndex:0,claims:[claim]}]});
  expect(validateClaimBatch(duplicate,[0],[claim.quote],evidence).checkedPassages).toEqual([]);
  const emptyQuote=JSON.stringify({passages:[{passageIndex:0,claims:[{...claim,verdict:"supported",evidence:[{sourceIndex:0,quote:"&#32;"}]}]}]});
  expect(validateClaimBatch(emptyQuote,[0],[claim.quote],evidence).checkedPassages).toEqual([]);
});
it("checks the expanded comparison packet and still bounds total evidence size",async()=>{
  ask.mockResolvedValue(JSON.stringify({passages:[{passageIndex:0,claims:[]}]}));
  const sources=Array.from({length:11},(_,i)=>({...evidence[0],url:`https://vendor${i}.test`,text:"x".repeat(9000)}));
  expect((await verifyDraftClaims("<p>Compare the options.</p>",{evidence:sources})).status).toBe("checked");
  ask.mockClear();
  expect((await verifyDraftClaims("<p>Compare the options.</p>",{evidence:[...sources,sources[0],sources[0],sources[0]]})).status).toBe("unavailable");
  expect(ask).not.toHaveBeenCalled();
});
it("splits a truncated assignment once and retains complete checked coverage",async()=>{
  ask.mockImplementation(async(_op:string,prompt:string,options:{observe:(event:unknown)=>void})=>{
    const {assignedPassages}=JSON.parse(prompt.split("\n").at(-1)!);
    if(assignedPassages.length===4){options.observe({status:"truncated"});return null;}
    return JSON.stringify({passages:assignedPassages.map((p:{passageIndex:number})=>({passageIndex:p.passageIndex,claims:[]}))});
  });
  const result=await verifyDraftClaims("<p>Ask about export.</p>".repeat(4),{evidence});
  expect(result.status).toBe("checked");expect(result.checkedPassages).toEqual([0,1,2,3]);expect(ask).toHaveBeenCalledTimes(3);
});
it("does not repeatedly split a truncated retry or exceed eight calls",async()=>{
  ask.mockImplementation(async(_op:string,_prompt:string,options:{observe:(event:unknown)=>void})=>{options.observe({status:"truncated"});return null;});
  const result=await verifyDraftClaims("<p>Ask about export.</p>".repeat(70),{evidence});
  expect(result.status).toBe("unavailable");expect(ask.mock.calls.length).toBeLessThanOrEqual(8);expect(result.failures.length).toBeGreaterThan(0);
});

it("recovers invalid evidence once without accepting fabricated quotes",async()=>{
  const supported={...claim,quote:"Managed includes three sites.",verdict:"supported"};
  ask.mockResolvedValueOnce(JSON.stringify({passages:[{passageIndex:0,claims:[{...supported,evidence:[{sourceIndex:0,quote:"Fabricated source."}]}]}]}));
  ask.mockResolvedValueOnce(JSON.stringify({passages:[{passageIndex:0,claims:[supported]}]}));
  const result=await verifyDraftClaims(`<p>${supported.quote}</p>`,{evidence});
  expect(result.status).toBe("checked");expect(result.failures).toEqual([]);expect(result.claims).toEqual([{...supported,passageIndex:0}]);expect(ask).toHaveBeenCalledTimes(2);
});
it("adjudicates a false unsupported finding with validated source evidence",async()=>{
  const quote="Managed includes three sites.";
  ask.mockResolvedValueOnce(JSON.stringify({passages:[{passageIndex:0,claims:[{...claim,quote,evidence:[],reason:"No site count was supplied."}]}]}));
  ask.mockResolvedValueOnce(JSON.stringify({passages:[{passageIndex:0,claims:[{...claim,quote,verdict:"supported",reason:"The plan source states this count."}]}]}));
  const result=await verifyDraftClaims(`<p>${quote}</p>`,{evidence});
  expect(result.status).toBe("checked");expect(result.claims).toHaveLength(1);expect(result.claims[0].verdict).toBe("supported");
});
it.each([
  {claims:[]},
  {claims:[{...claim,verdict:"supported",evidence:[]}]},
  {claims:[{...claim,verdict:"supported",evidence:[{sourceIndex:0,quote:"All plans include three sites."}]}]},
])("cannot erase a prior finding through omission or invalid recovery evidence %#",async ({claims})=>{
  ask.mockResolvedValueOnce(JSON.stringify({passages:[{passageIndex:0,claims:[claim]}]}));
  ask.mockResolvedValueOnce(JSON.stringify({passages:[{passageIndex:0,claims}]}));
  const result=await verifyDraftClaims(`<p>${claim.quote}</p>`,{evidence});
  expect(result.claims).toEqual([{...claim,passageIndex:0}]);expect(ask).toHaveBeenCalledTimes(2);
});
it("retains failure for another batch when only one missing assignment is recovered",async()=>{
  ask.mockImplementation(async(_op:string,prompt:string)=>{
    const {assignedPassages}=JSON.parse(prompt.split("\n").at(-1)!);
    if(!prompt.startsWith("Recheck"))return null;
    if(assignedPassages[0].passageIndex<14)return JSON.stringify({passages:assignedPassages.map((p:{passageIndex:number})=>({passageIndex:p.passageIndex,claims:[]}))});
    return null;
  });
  const result=await verifyDraftClaims("<p>Ask the vendor.</p>".repeat(28),{evidence});
  expect(result.status).toBe("partial");expect(result.failures).toContain("Batch 1: Missing or invalid passage response.");expect(ask.mock.calls.length).toBeLessThanOrEqual(8);
});
it("does not spend a ninth call on invalid responses",async()=>{
  ask.mockResolvedValue(null);
  const result=await verifyDraftClaims("<p>Ask the vendor.</p>".repeat(112),{evidence});
  expect(result.status).toBe("unavailable");expect(ask).toHaveBeenCalledTimes(8);
});
it("does not start recovery after the original deadline",async()=>{
  const now=vi.spyOn(Date,"now").mockReturnValue(0);
  ask.mockImplementation(async()=>{now.mockReturnValue(90001);return null;});
  try {
    const result=await verifyDraftClaims("<p>Ask the vendor.</p>",{evidence});
    expect(result.status).toBe("unavailable");expect(ask).toHaveBeenCalledTimes(1);
  } finally {now.mockRestore();}
});

it("does not repair invalid initial provenance by omitting the original claim",async()=>{
  const bad={...claim,evidence:[{sourceIndex:0,quote:"Fabricated evidence."}]};
  ask.mockResolvedValueOnce(JSON.stringify({passages:[{passageIndex:0,claims:[bad]}]}));
  ask.mockResolvedValueOnce(JSON.stringify({passages:[{passageIndex:0,claims:[]}]}));
  const result=await verifyDraftClaims(`<p>${claim.quote}</p>`,{evidence});
  expect(result.status).toBe("unavailable");expect(result.checkedPassages).toEqual([]);expect(result.failures).toHaveLength(1);
});
it("keeps an explicit scope decision when recovery corrects a hypothetical false positive",async()=>{
  const hypothetical={quote:"Imagine a team with six people.",category:"qualitative",verdict:"unsupported",reason:"No source establishes the example team size.",evidence:[],contradiction:""};
  ask.mockResolvedValueOnce(JSON.stringify({passages:[{passageIndex:0,claims:[hypothetical]}]}));
  ask.mockResolvedValueOnce(JSON.stringify({passages:[{passageIndex:0,claims:[{...hypothetical,verdict:"not-factual",reason:"Explicit hypothetical input, not a real-world assertion."}]}]}));
  const result=await verifyDraftClaims(`<p>${hypothetical.quote}</p>`,{evidence});
  expect(result.status).toBe("checked");
  expect(result.claims).toEqual([expect.objectContaining({quote:hypothetical.quote,category:"qualitative",verdict:"not-factual"})]);
});
it("cannot dismiss an original product claim as nonfactual or relabel its category",async()=>{
  ask.mockResolvedValueOnce(JSON.stringify({passages:[{passageIndex:0,claims:[claim]}]}));
  ask.mockResolvedValueOnce(JSON.stringify({passages:[{passageIndex:0,claims:[{...claim,category:"qualitative",verdict:"not-factual",evidence:[]}]}]}));
  const result=await verifyDraftClaims(`<p>${claim.quote}</p>`,{evidence});
  expect(result.claims).toEqual([{...claim,passageIndex:0}]);
});
it("requires a traceable qualitative scope decision without evidence or contradiction",()=>{
  for(const change of [{category:"product"},{evidence:[{sourceIndex:0,quote:evidence[0].text}]},{contradiction:"Imagine six people."},{quote:"An invented quote."}]){
    const c={quote:"Imagine six people.",category:"qualitative",verdict:"not-factual",reason:"Hypothetical input.",evidence:[],contradiction:"",...change};
    expect(validateClaimBatch(JSON.stringify({passages:[{passageIndex:0,claims:[c]}]}),[0],["Imagine six people."],evidence).checkedPassages).toEqual([]);
  }
});

const bookingEvidence=[{url:"https://booklane.example/app",title:"Booklane customer app",headings:[],text:"Find local salons with the Booklane app."}];
const bookingHtml="<h2>Booking with Booklane</h2><p>Select a treatment, choose an available time slot, then confirm the appointment.</p>";
const emptyAssignments=(prompt:string)=>JSON.parse(prompt.split("\n").at(-1)!).assignedPassages.map((p:{passageIndex:number})=>({passageIndex:p.passageIndex,claims:[]}));

it("rechecks an omitted named-product procedure inside the existing claim budget",async()=>{
  ask.mockImplementation(async(_op:string,prompt:string)=>{
    if(!prompt.startsWith("Recheck"))return JSON.stringify({passages:emptyAssignments(prompt)});
    expect(prompt).toContain("omittedAssertionPassages");
    return JSON.stringify({passages:[{passageIndex:1,claims:[{quote:"Select a treatment, choose an available time slot, then confirm the appointment.",category:"product",verdict:"unsupported",reason:"The app description does not establish this booking procedure.",evidence:[],contradiction:""}]}]});
  });
  const result=await verifyDraftClaims(bookingHtml,{evidence:bookingEvidence});
  expect(ask).toHaveBeenCalledTimes(2);
  expect(result.status).toBe("checked");
  expect(result.claims).toEqual([expect.objectContaining({passageIndex:1,category:"product",verdict:"unsupported"})]);
});

it("does not declare a nominated procedure checked when recovery omits it again",async()=>{
  ask.mockImplementation(async(_op:string,prompt:string)=>JSON.stringify({passages:emptyAssignments(prompt)}));
  const result=await verifyDraftClaims(bookingHtml,{evidence:bookingEvidence});
  expect(ask).toHaveBeenCalledTimes(2);
  expect(result.status).toBe("partial");
  expect(result.checkedPassages).toEqual([0]);
  expect(result.failures.join(" ")).toContain("assertion");
});

it("accepts explicit nonfactual scope without inventing a missing product claim",async()=>{
  const advice="Ask Booklane whether you can select a preferred therapist before booking.";
  ask.mockImplementation(async(_op:string,prompt:string)=>{
    if(!prompt.startsWith("Recheck"))return JSON.stringify({passages:emptyAssignments(prompt)});
    return JSON.stringify({passages:[{passageIndex:0,claims:[{quote:advice,category:"qualitative",verdict:"not-factual",reason:"A suggestion to ask about a capability; it does not assert the capability exists.",evidence:[],contradiction:""}]}]});
  });
  const result=await verifyDraftClaims(`<p>${advice}</p>`,{evidence:bookingEvidence});
  expect(ask).toHaveBeenCalledTimes(2);
  expect(result.status).toBe("checked");
  expect(result.failures).toEqual([]);
  expect(result.claims).toEqual([expect.objectContaining({quote:advice,verdict:"not-factual"})]);
});

it("does not nominate ordinary advice or a hypothetical customer's inputs",async()=>{
  ask.mockImplementation(async(_op:string,prompt:string)=>JSON.stringify({passages:emptyAssignments(prompt)}));
  const html="<h2>Booklane for a freelancer</h2><p>Imagine a freelancer with three clients and a busy week.</p><p>Compare your options and ask the vendor about its limits.</p>";
  expect((await verifyDraftClaims(html,{evidence:bookingEvidence})).status).toBe("checked");
  expect(ask).toHaveBeenCalledTimes(1);
});

it("does not exempt named-product capabilities inside a hypothetical example",async()=>{
  ask.mockImplementation(async(_op:string,prompt:string)=>JSON.stringify({passages:emptyAssignments(prompt)}));
  const result=await verifyDraftClaims("<p>Imagine using Booklane: it automatically reschedules all your appointments.</p>",{evidence:bookingEvidence});
  expect(ask).toHaveBeenCalledTimes(2);
  expect(result.status).toBe("unavailable");
});

it("does not spend a ninth call or treat unexamined omitted assertions as checked",async()=>{
  ask.mockImplementation(async(_op:string,prompt:string)=>JSON.stringify({passages:emptyAssignments(prompt)}));
  const result=await verifyDraftClaims("<p>In Booklane, select a service and confirm a time slot.</p>".repeat(112),{evidence:bookingEvidence});
  expect(ask).toHaveBeenCalledTimes(8);
  expect(result.status).toBe("unavailable");
  expect(result.checkedPassages).toEqual([]);
});

it("does not make another extraction call when a product procedure already has a claim",async()=>{
  const quote="In Booklane, select a treatment and confirm your booking.";
  const supported={quote,category:"product",verdict:"supported",reason:"The customer help page gives these steps.",evidence:[{sourceIndex:0,quote}],contradiction:""};
  ask.mockResolvedValue(JSON.stringify({passages:[{passageIndex:0,claims:[supported]}]}));
  expect((await verifyDraftClaims(`<p>${quote}</p>`,{evidence:[{...bookingEvidence[0],text:quote}]})).status).toBe("checked");
  expect(ask).toHaveBeenCalledTimes(1);
});

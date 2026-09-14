import {beforeEach,expect,it,vi} from "vitest";
const {ask}=vi.hoisted(()=>({ask:vi.fn()}));
vi.mock("@/lib/keyword-research/buyer-model",()=>({askStructured:ask,extractJson:(raw:string)=>{try{return JSON.parse(raw);}catch{return null;}}}));
import {CLAIM_COVERAGE_VERSION,claimPassages,claimSentences,claimBatches,verifyDraftClaims,validateClaimBatch,hasCompleteSentenceCoverage,type VerifiedClaim,type SentenceCoverage,type ClaimSentence} from "../claim-verification";

type RawClaim=Omit<VerifiedClaim,"passageIndex"> & {claimId:string;sentenceIndex:number};
type Assignment={passageIndex:number;claims:RawClaim[];coverage:SentenceCoverage[]};
const evidence=[{url:"https://vendor.test/pricing",title:"Plans",headings:[],text:"Managed includes three sites. Agency includes twenty sites."}];
const claim:RawClaim={claimId:"limit",sentenceIndex:0,quote:"All plans include three sites.",category:"product",verdict:"unsupported",reason:"The limit belongs to Managed, not all plans.",evidence:[{sourceIndex:0,quote:"Managed includes three sites."}],contradiction:""};
const supported:RawClaim={...claim,quote:"Managed includes three sites.",verdict:"supported",reason:"The Managed source specifies the count."};
const response=(...passages:unknown[])=>JSON.stringify({passages});
/** Explicit valid fixture decisions; missing coverage tests remove entries below. */
function entry(text:string,claims:RawClaim[]=[],passageIndex=0):Assignment {
  return {passageIndex,claims,coverage:claimSentences(text).map(({sentenceIndex})=>{
    const claimIds=claims.filter(c=>c.sentenceIndex===sentenceIndex).map(c=>c.claimId);
    return {sentenceIndex,claimIds,nonFactualReason:claimIds.length?"":"A suggestion, heading or hypothetical input, not an external factual assertion."};
  })};
}
const assigned=(prompt:string)=>JSON.parse(prompt.split("\n").at(-1)!).assignedPassages as Array<{passageIndex:number;sentences:ClaimSentence[]}>;
const adviceReply=(prompt:string)=>response(...assigned(prompt).map(p=>({passageIndex:p.passageIndex,claims:[],coverage:p.sentences.map(s=>({sentenceIndex:s.sentenceIndex,claimIds:[],nonFactualReason:"A suggestion to ask about the product, not a claim about its features."}))})));
beforeEach(()=>{ask.mockReset();});

it("records exact claims, sentence provenance and version without modifying article text",async()=>{
  ask.mockResolvedValue(response(entry(claim.quote,[claim])));
  const result=await verifyDraftClaims(`<p>${claim.quote}</p>`,{evidence});
  expect(result.status).toBe("checked");expect(result.coverageVersion).toBe(CLAIM_COVERAGE_VERSION);
  expect(result.claims).toEqual([{...claim,passageIndex:0}]);expect(result.checkedPassages).toEqual([0]);
  expect(result.sentenceInventory).toEqual([{passageIndex:0,sentenceIndex:0,text:claim.quote,start:0,end:claim.quote.length}]);
  expect(hasCompleteSentenceCoverage(result)).toBe(true);
});

it.each([
  {...claim,quote:"A fabricated article assertion."},
  {...claim,evidence:[{sourceIndex:0,quote:"Every plan includes three sites."}]},
  {...claim,evidence:[{sourceIndex:12,quote:"Managed includes three sites."}]},
  {...claim,verdict:"supported" as const,evidence:[]},
  {...claim,verdict:"contradicted" as const,evidence:[],contradiction:""},
  {...claim,contradiction:"An invented conflicting article quote."},
])("refuses unverifiable claim provenance %#",async c=>{
  ask.mockResolvedValue(response(entry(claim.quote,[c])));
  expect((await verifyDraftClaims(`<p>${claim.quote}</p>`,{evidence})).status).toBe("unavailable");
});

it("rejects a legacy empty assignment rather than calling missing sentence coverage clean",async()=>{
  ask.mockResolvedValue(response({passageIndex:0,claims:[]}));
  const result=await verifyDraftClaims("<p>Ask about exports.</p>",{evidence});
  expect(result.status).toBe("unavailable");expect(result.checkedPassages).toEqual([]);
  expect(ask).toHaveBeenCalledTimes(2);
  expect(result.failures.join(" ")).toContain("sentence coverage");
});

it("requires each assigned passage exactly once, including nonfactual passages",async()=>{
  ask.mockResolvedValue(response(entry("Compare plans",[],0)));
  const result=await verifyDraftClaims("<h2>Compare plans</h2><p>Ask about exports.</p>",{evidence});
  expect(result.status).toBe("partial");expect(result.checkedPassages).toEqual([0]);
});

it("keeps a completed batch visible when another batch fails",async()=>{
  ask.mockImplementation(async(_op:string,prompt:string)=>assigned(prompt)[0].passageIndex===0?adviceReply(prompt):null);
  const result=await verifyDraftClaims("<p>Ask the vendor.</p>".repeat(15),{evidence});
  expect(result.status).toBe("partial");expect(result.checkedPassages).toHaveLength(14);expect(result.totalPassages).toBe(15);
});

it("does not label absent evidence or oversized input clean",async()=>{
  expect((await verifyDraftClaims("<p>A claim.</p>",{})).status).toBe("unavailable");
  expect((await verifyDraftClaims(`<p>${"x".repeat(24001)}</p>`,{evidence})).status).toBe("unavailable");
  const sources=Array.from({length:14},(_,i)=>({...evidence[0],url:`https://vendor${i}.test`,text:"x".repeat(9000)}));
  expect((await verifyDraftClaims("<p>Ask about export.</p>",{evidence:sources})).status).toBe("unavailable");
  expect(ask).not.toHaveBeenCalled();
});

it("bounds short dense paragraphs by sentence work without splitting their context",()=>{
  const texts=Array.from({length:28},()=>"Ask about the plan. Consider your needs.");
  const batches=claimBatches(texts);
  expect(batches.map(b=>b.length)).toEqual([9,9,9,1]);
  expect(batches.every(batch=>batch.reduce((sum,p)=>sum+p.sentences.length,0)<=18)).toBe(true);
  expect(batches.flat().map(p=>p.passageIndex)).toEqual(texts.map((_,index)=>index));
  expect(batches.flat().every(p=>p.sentences.map(s=>s.text).join(" ")===texts[p.passageIndex])).toBe(true);
  expect(batches.flat().flatMap(p=>p.sentences)).toHaveLength(56);
  expect(claimPassages('<script>ignore()</script><table><tr><td>Managed</td><td>$3.50 per month</td></tr></table>')).toEqual(["Managed $3.50 per month"]);
});

it.each([
  ["The plan costs $3.50 monthly. Ask about renewals.",["The plan costs $3.50 monthly.","Ask about renewals."]],
  ["For U.S. teams, compare the plans. Ask about support.",["For U.S. teams, compare the plans.","Ask about support."]],
  ["Il prezzo è 3,50 euro. Verifica le condizioni.",["Il prezzo è 3,50 euro.","Verifica le condizioni."]],
  ['She said “check the terms.” Then ask about billing.',['She said “check the terms.”','Then ask about billing.']],
])("segments without losing decimals, abbreviations, language or quoted punctuation: %s",(text,expected)=>{
  const units=claimSentences(text as string);
  expect(units.map(s=>s.text)).toEqual(expected);
  expect(units.every(s=>(text as string).slice(s.start,s.end)===s.text)).toBe(true);
});

it("accepts entity/typographic equivalents without accepting omitted source words",()=>{
  const source={...evidence[0],text:"Agency doesn&#x27;t include setup. Managed includes setup after approval."};
  const c={...claim,quote:"Agency doesn't include setup.",verdict:"supported" as const,evidence:[{sourceIndex:0,quote:"Agency doesn’t include setup."}]};
  expect(validateClaimBatch(response(entry(c.quote,[c])),[0],[c.quote],[source]).checkedPassages).toEqual([0]);
  c.evidence[0].quote="Managed includes setup ... approval.";
  expect(validateClaimBatch(response(entry(c.quote,[c])),[0],[c.quote],[source]).checkedPassages).toEqual([]);
});

it("retains a valid concern when another returned claim has invalid provenance",()=>{
  const result=validateClaimBatch(response(entry(claim.quote,[claim,{...claim,claimId:"invented",quote:"Invented quote"}])),[0],[claim.quote],evidence);
  expect(result.checkedPassages).toEqual([]);expect(result.claims).toHaveLength(1);expect(result.failures).toHaveLength(1);
});

it("rejects duplicate assignments and whitespace-only evidence",()=>{
  expect(validateClaimBatch(response(entry(claim.quote,[claim]),entry(claim.quote,[claim])),[0],[claim.quote],evidence).checkedPassages).toEqual([]);
  const c={...supported,evidence:[{sourceIndex:0,quote:"&#32;"}]};
  expect(validateClaimBatch(response(entry(c.quote,[c])),[0],[c.quote],evidence).checkedPassages).toEqual([]);
});

const twoSentences=`${supported.quote} Ask about exports.`;
it.each([
  (e:Assignment)=>({...e,coverage:e.coverage.slice(0,1)}),
  (e:Assignment)=>({...e,coverage:[e.coverage[0],e.coverage[0]]}),
  (e:Assignment)=>({...e,coverage:[...e.coverage,{sentenceIndex:2,claimIds:[],nonFactualReason:"Extra"}]}),
  (e:Assignment)=>({...e,coverage:[{...e.coverage[0],claimIds:["missing"]},e.coverage[1]]}),
  (e:Assignment)=>({...e,coverage:[{...e.coverage[0],claimIds:["limit","limit"]},e.coverage[1]]}),
  (e:Assignment)=>({...e,coverage:[e.coverage[0],{...e.coverage[1],nonFactualReason:" "}]}),
  (e:Assignment)=>({...e,coverage:[{...e.coverage[0],nonFactualReason:"Advice"},e.coverage[1]]}),
  (e:Assignment)=>({...e,coverage:[{...e.coverage[0],claimIds:[],nonFactualReason:"Advice"},{...e.coverage[1],claimIds:["limit"],nonFactualReason:""}]}),
  (e:Assignment)=>({...e,claims:[...e.claims,{...e.claims[0]}]}),
  (e:Assignment)=>({...e,claims:[{...e.claims[0],sentenceIndex:1}]}),
  (e:Assignment)=>({...e,claims:[{...e.claims[0],claimId:""}]}),
  (e:Assignment)=>({...e,coverage:[{sentenceIndex:0,claimIds:[],nonFactualReason:"Advice"},e.coverage[1]]}),
])("rejects incomplete or malformed sentence/claim mappings %#",change=>{
  const result=validateClaimBatch(response(change(entry(twoSentences,[supported]))),[0],[twoSentences],evidence);
  expect(result.checkedPassages).toEqual([]);expect(result.failures.join(" ")).toContain("sentence coverage");
});

it("does not let a cross-sentence quote substitute for local assertion decisions",()=>{
  const c={...claim,quote:twoSentences};
  expect(validateClaimBatch(response(entry(twoSentences,[c])),[0],[twoSentences],evidence).checkedPassages).toEqual([]);
});

it("preserves genuine complete advice and hypothetical inputs without a second call",async()=>{
  ask.mockImplementation(async(_op:string,prompt:string)=>adviceReply(prompt));
  const result=await verifyDraftClaims("<h2>Choosing a workflow</h2><p>Ask the vendor whether export is available. Imagine a team with six people.</p>",{evidence});
  expect(result.status).toBe("checked");expect(result.claims).toEqual([]);
  expect(result.sentenceCoverage).toHaveLength(3);expect(ask).toHaveBeenCalledTimes(1);
});

it("does not recheck a completely extracted supported fact followed by advice",async()=>{
  ask.mockResolvedValue(response(entry(twoSentences,[supported])));
  const result=await verifyDraftClaims(`<p>${twoSentences}</p>`,{evidence});
  expect(result.status).toBe("checked");expect(ask).toHaveBeenCalledTimes(1);
});

const basecampAdvice="Put together, the stopping condition for a healthy tracking process looks like this: every active piece of work lives on a to-do list, every list has a Hill Chart dot that's been updated recently, the Overdue and Unassigned reports are both clear or explained, and any stalled item has either moved or been broken into smaller lists.";
const basecampOutcome="If you're hitting all four regularly, you have a real-time view of where the project stands, not just a static plan you made at the start.";
const basecampText=`${basecampAdvice} ${basecampOutcome}`;
it("recovers the actual Basecamp outcome sentence omitted after a valid advice decision",async()=>{
  const initial=entry(basecampText);initial.coverage.pop();
  const outcome:RawClaim={claimId:"freshness",sentenceIndex:1,quote:basecampOutcome,category:"qualitative",verdict:"unsupported",reason:"Manually supplied snapshots do not establish current project status.",evidence:[],contradiction:""};
  ask.mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response(entry(basecampText,[outcome])));
  const result=await verifyDraftClaims(`<p>${basecampText}</p>`,{evidence:[{...evidence[0],text:"The status is human generated. Every update saves a new snapshot."}]});
  expect(ask).toHaveBeenCalledTimes(2);expect(result.status).toBe("checked");
  expect(result.claims).toEqual([{...outcome,passageIndex:0}]);expect(result.sentenceCoverage).toHaveLength(2);
  expect(result.failures).toEqual([]);
});

it("cannot recover the actual Basecamp gap by omitting the outcome a second time",async()=>{
  const partial=entry(basecampText);partial.coverage.pop();ask.mockResolvedValue(response(partial));
  const result=await verifyDraftClaims(`<p>${basecampText}</p>`,{evidence});
  expect(result.status).toBe("unavailable");expect(result.checkedPassages).toEqual([]);expect(ask).toHaveBeenCalledTimes(2);
});

it("a supported claim cannot acknowledge an unsupported later sentence or disappear during recovery",async()=>{
  const outcome:RawClaim={...claim,claimId:"outcome",sentenceIndex:1,quote:"It automatically verifies every team's work in real time.",evidence:[],reason:"No evidence for automatic verification."};
  const text=`${supported.quote} ${outcome.quote}`;
  const initial=entry(text,[supported]);initial.coverage.pop();
  ask.mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response(entry(text,[outcome])));
  const result=await verifyDraftClaims(`<p>${text}</p>`,{evidence});
  expect(result.status).toBe("unavailable");expect(result.claims).toEqual([{...supported,passageIndex:0}]);
  expect(ask).toHaveBeenCalledTimes(2);
});

it("separates hypothetical inputs from named-product behavior in the next sentence",async()=>{
  const text="Imagine a freelancer with six clients. Booklane automatically reschedules every appointment.";
  const c:RawClaim={...claim,claimId:"reschedule",sentenceIndex:1,quote:"Booklane automatically reschedules every appointment.",evidence:[],reason:"The supplied app description does not establish rescheduling."};
  const initial=entry(text);initial.coverage.pop();
  ask.mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response(entry(text,[c])));
  const result=await verifyDraftClaims(`<p>${text}</p>`,{evidence});
  expect(result.status).toBe("checked");expect(result.claims[0].verdict).toBe("unsupported");
  expect(result.sentenceCoverage?.[0].nonFactualReason).not.toBe("");
});

it("preserves the product antecedent and checks entity relationships in initial and recovery prompts",async()=>{
  const context="In Boardlane, a project board tracks each workstream as a marker.";
  const text="Imagine a team with six people. Two individual tasks appear as separate markers.";
  const c:RawClaim={...claim,claimId:"marker_unit",sentenceIndex:1,quote:"Two individual tasks appear as separate markers.",verdict:"contradicted",reason:"The marker represents a workstream, not an individual task.",evidence:[{sourceIndex:0,quote:"Each workstream has one marker; tasks within it do not get separate markers."}]};
  const initial=entry(text,[],1);initial.coverage.pop();
  ask.mockResolvedValueOnce(response(entry(context,[],0),initial)).mockResolvedValueOnce(response(entry(text,[c],1)));
  const result=await verifyDraftClaims(`<p>${context}</p><p>${text}</p>`,{evidence:[{...evidence[0],text:"Each workstream has one marker; tasks within it do not get separate markers."}]});
  expect(result.status).toBe("checked");expect(result.claims).toEqual([{...c,passageIndex:1}]);
  expect(result.sentenceCoverage?.find(s=>s.passageIndex===1 && s.sentenceIndex===0)?.claimIds).toEqual([]);
  expect(ask).toHaveBeenCalledTimes(2);
  for(const [,prompt] of ask.mock.calls) {
    expect(prompt).toContain(context);
    expect(prompt).toContain("even when a later sentence does not repeat its name");
    expect(prompt).toContain("the meaning of its states, and the trigger that produces an outcome remain factual");
    expect(prompt).toContain("Team-chosen completion criteria");
  }
});

it("keeps adjacent qualifications and table headers in context while claims stay sentence-local",async()=>{
  const text="The status depends on manual updates. It shows the latest reported status.";
  const a:RawClaim={...supported,quote:"The status depends on manual updates.",claimId:"manual"};
  const b:RawClaim={...supported,quote:"It shows the latest reported status.",sentenceIndex:1,claimId:"reported"};
  const source={...evidence[0],text};
  a.evidence=[{sourceIndex:0,quote:a.quote}];b.evidence=[{sourceIndex:0,quote:b.quote}];
  ask.mockImplementation(async(_op:string,prompt:string)=>{
    expect(prompt).toContain(text);expect(prompt).toContain("Monthly billing");
    return response(entry("Monthly billing",[],0),entry(text,[a,b],1));
  });
  const result=await verifyDraftClaims(`<h2>Monthly billing</h2><p>${text}</p>`,{evidence:[source]});
  expect(result.status).toBe("checked");expect(ask).toHaveBeenCalledTimes(1);
});

it("can retain several claims in one sentence with different evidence and verdicts",async()=>{
  const text="Managed includes three sites and it guarantees first place in search results.";
  const a={...supported,quote:"Managed includes three sites"};
  const b:RawClaim={...claim,claimId:"guarantee",quote:"it guarantees first place in search results",evidence:[],reason:"No evidence for a ranking guarantee."};
  ask.mockResolvedValue(response(entry(text,[a,b])));
  const result=await verifyDraftClaims(`<p>${text}</p>`,{evidence});
  expect(result.status).toBe("checked");expect(result.claims).toHaveLength(2);
  expect(result.sentenceCoverage?.[0].claimIds).toEqual(["limit","guarantee"]);
});

it("recovers invalid evidence once without accepting fabricated source quotations",async()=>{
  const bad={...supported,evidence:[{sourceIndex:0,quote:"Fabricated source."}]};
  ask.mockResolvedValueOnce(response(entry(supported.quote,[bad]))).mockResolvedValueOnce(response(entry(supported.quote,[supported])));
  const result=await verifyDraftClaims(`<p>${supported.quote}</p>`,{evidence});
  expect(result.status).toBe("checked");expect(result.failures).toEqual([]);expect(ask).toHaveBeenCalledTimes(2);
});

it.each([
  entry(claim.quote),
  entry(claim.quote,[{...claim,verdict:"supported",evidence:[]}]),
  entry(claim.quote,[{...claim,category:"qualitative",verdict:"not-factual",evidence:[]}]),
])("cannot erase or relabel an original product finding during recovery %#",async recovery=>{
  ask.mockResolvedValueOnce(response(entry(claim.quote,[claim]))).mockResolvedValueOnce(response(recovery));
  const result=await verifyDraftClaims(`<p>${claim.quote}</p>`,{evidence});
  expect(result.claims).toEqual([{...claim,passageIndex:0}]);expect(ask).toHaveBeenCalledTimes(2);
});

it("does not repair invalid initial provenance by omitting its original claim",async()=>{
  const bad={...claim,evidence:[{sourceIndex:0,quote:"Fabricated evidence."}]};
  ask.mockResolvedValueOnce(response(entry(claim.quote,[bad]))).mockResolvedValueOnce(response(entry(claim.quote)));
  const result=await verifyDraftClaims(`<p>${claim.quote}</p>`,{evidence});
  expect(result.status).toBe("unavailable");expect(result.checkedPassages).toEqual([]);
});

it("can correct a qualitative false positive while preserving its original identity",async()=>{
  const c:RawClaim={...claim,quote:"Imagine a team with six people.",category:"qualitative",evidence:[],reason:"No evidence for the team size."};
  ask.mockResolvedValueOnce(response(entry(c.quote,[c]))).mockResolvedValueOnce(response(entry(c.quote,[{...c,verdict:"not-factual",reason:"Explicit hypothetical input."}])));
  const result=await verifyDraftClaims(`<p>${c.quote}</p>`,{evidence});
  expect(result.status).toBe("checked");expect(result.claims[0]).toMatchObject({quote:c.quote,category:"qualitative",verdict:"not-factual"});
});

it("adjudicates a false unsupported finding using validated source evidence",async()=>{
  ask.mockResolvedValueOnce(response(entry(supported.quote,[{...supported,verdict:"unsupported",evidence:[]}]))).mockResolvedValueOnce(response(entry(supported.quote,[supported])));
  const result=await verifyDraftClaims(`<p>${supported.quote}</p>`,{evidence});
  expect(result.status).toBe("checked");expect(result.claims[0].verdict).toBe("supported");
});

it("splits a truncated assignment once within the same call budget",async()=>{
  ask.mockImplementation(async(_op:string,prompt:string,options:{observe:(event:unknown)=>void})=>{
    if(assigned(prompt).length===4){options.observe({status:"truncated"});return null;}
    return adviceReply(prompt);
  });
  const result=await verifyDraftClaims("<p>Ask about export.</p>".repeat(4),{evidence});
  expect(result.status).toBe("checked");expect(result.checkedPassages).toEqual([0,1,2,3]);expect(ask).toHaveBeenCalledTimes(3);
});

it("does not repeatedly split truncated retries or spend a ninth call",async()=>{
  ask.mockImplementation(async(_op:string,_prompt:string,options:{observe:(event:unknown)=>void})=>{options.observe({status:"truncated"});return null;});
  const result=await verifyDraftClaims("<p>Ask about export.</p>".repeat(70),{evidence});
  expect(result.status).toBe("unavailable");expect(ask.mock.calls.length).toBeLessThanOrEqual(8);
});

it("does not spend a ninth call when every initial inventory is missing",async()=>{
  ask.mockImplementation(async(_op:string,prompt:string)=>response(...assigned(prompt).map(p=>({passageIndex:p.passageIndex,claims:[]}))));
  const result=await verifyDraftClaims("<p>Ask about export. Imagine six people.</p>".repeat(72),{evidence});
  expect(result.status).toBe("unavailable");expect(ask).toHaveBeenCalledTimes(8);expect(result.checkedPassages).toEqual([]);
});

it("withholds a ninth sentence-weighted batch before spending beyond the review allowance",async()=>{
  const result=await verifyDraftClaims("<p>Ask about export. Imagine six people.</p>".repeat(73),{evidence});
  expect(result.status).toBe("unavailable");expect(result.failures).toContain("The article exceeded the eight-batch claim-check limit.");
  expect(ask).not.toHaveBeenCalled();
});

it("withholds an indivisible paragraph exceeding the sentence assignment limit",async()=>{
  const result=await verifyDraftClaims(`<p>${"Ask about the workflow. ".repeat(19)}</p>`,{evidence});
  expect(result.status).toBe("unavailable");expect(result.failures.join(" ")).toContain("eighteen-sentence");
  expect(result.sentenceInventory).toHaveLength(19);expect(ask).not.toHaveBeenCalled();
});

it("keeps sentence-weighted initial batches at no more than three concurrent calls",async()=>{
  let active=0;let peak=0;
  ask.mockImplementation(async(_op:string,prompt:string)=>{
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,1));
    active--;return adviceReply(prompt);
  });
  const result=await verifyDraftClaims("<p>Ask about export. Imagine six people.</p>".repeat(45),{evidence});
  expect(result.status).toBe("checked");expect(result.checkedPassages).toHaveLength(45);
  expect(ask).toHaveBeenCalledTimes(5);expect(peak).toBe(3);
});

it("retains another batch failure when only some missing assignments recover",async()=>{
  ask.mockImplementation(async(_op:string,prompt:string)=>{
    if(!prompt.startsWith("Recheck")||assigned(prompt)[0].passageIndex>=14)return null;
    return adviceReply(prompt);
  });
  const result=await verifyDraftClaims("<p>Ask about export.</p>".repeat(28),{evidence});
  expect(result.status).toBe("partial");expect(result.failures).toContain("Batch 1: Missing or invalid passage response.");
  expect(ask.mock.calls.length).toBeLessThanOrEqual(8);
});

it("does not start recovery after the original 90-second deadline",async()=>{
  const now=vi.spyOn(Date,"now").mockReturnValue(0);
  ask.mockImplementation(async()=>{now.mockReturnValue(90001);return null;});
  try {
    const result=await verifyDraftClaims("<p>Ask about export.</p>",{evidence});
    expect(result.status).toBe("unavailable");expect(ask).toHaveBeenCalledTimes(1);
  } finally {now.mockRestore();}
});

it("cannot move a recovered claim to a different sentence with the same text",async()=>{
  const text=`${supported.quote} ${supported.quote}`;
  const initial=entry(text,[supported]);initial.coverage.pop();
  ask.mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response(entry(text,[{...supported,sentenceIndex:1}])));
  const result=await verifyDraftClaims(`<p>${text}</p>`,{evidence});
  expect(result.status).toBe("unavailable");expect(result.claims[0].sentenceIndex).toBe(0);
});

it("preserves a prior valid claim identifier during recovery",async()=>{
  ask.mockResolvedValueOnce(response(entry(supported.quote,[{...supported,verdict:"unsupported"}]))).mockResolvedValueOnce(response(entry(supported.quote,[{...supported,claimId:"replacement"}])));
  const result=await verifyDraftClaims(`<p>${supported.quote}</p>`,{evidence});
  expect(result.claims[0]).toMatchObject({claimId:"limit",verdict:"unsupported"});
});

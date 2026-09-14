import { expect, it, vi } from "vitest";
import { approvalBlocker, factCheckArticle } from "@/lib/ai/fact-check";
import { htmlToTiptapJson } from "@/lib/ai/tiptap";
import { tiptapToHtml } from "@/lib/cms/html";
import { verifyCitedFigures } from "@/lib/seo/citation-check";
import { CLAIM_COVERAGE_VERSION, claimPassages, claimSentences, type ClaimVerification, type VerifiedClaim } from "../claim-verification";
import { bindSavedNumericalReview, reconcileReviewedNumbers, reuseReviewedNumbers } from "../numerical-review";

const example="Illustrative example: if 3 of 10 tasks are overdue, the overdue share is 30%.";
const html=`<p>${example}</p>`;
function reviewOf(value:string):ClaimVerification {
  const passages=claimPassages(value);
  const sentenceInventory=passages.flatMap((passage,passageIndex)=>claimSentences(passage).map(sentence=>({...sentence,passageIndex})));
  return {coverageVersion:CLAIM_COVERAGE_VERSION,status:"checked",totalPassages:passages.length,checkedPassages:passages.map((_,i)=>i),sentenceInventory,
    sentenceCoverage:sentenceInventory.map(sentence=>({passageIndex:sentence.passageIndex,sentenceIndex:sentence.sentenceIndex,claimIds:[],nonFactualReason:"Explicit hypothetical inputs and their arithmetic; no measured or product assertion."})),claims:[],sources:[],failures:[],modelCalls:[]};
}
function assertIn(review:ClaimVerification,passageIndex:number,sentenceIndex:number,verdict:VerifiedClaim["verdict"],quote?:string) {
  const sentence=review.sentenceInventory!.find(row=>row.passageIndex===passageIndex&&row.sentenceIndex===sentenceIndex)!;
  const claimId=`claim-${passageIndex}-${sentenceIndex}`;
  review.claims.push({claimId,passageIndex,sentenceIndex,quote:quote??sentence.text,category:verdict==="not-factual"?"qualitative":"product",verdict,reason:verdict==="not-factual"?"Explicit hypothetical calculation.":"A real product limit.",evidence:[],contradiction:""});
  Object.assign(review.sentenceCoverage!.find(row=>row.passageIndex===passageIndex&&row.sentenceIndex===sentenceIndex)!,{claimIds:[claimId],nonFactualReason:""});
}

it("retains the numerical detection visibly while removing a complete nonfactual sentence from the hard gate",async()=>{
  const legacy=factCheckArticle(html);expect(approvalBlocker(legacy)).not.toBeNull();
  const fetcher=vi.fn();
  const cited=await verifyCitedFigures(legacy,{fetcher});
  const result=reconcileReviewedNumbers(html,cited,reviewOf(html));
  expect(result.verdict).toBe("clean");expect(approvalBlocker(result)).toBeNull();
  expect(result.claims[0]).toMatchObject({text:"30%",sentence:example,status:"not_factual",severity:"low",numericalReview:{originalStatus:"unsourced",originalSeverity:"high",passageIndex:0,sentenceIndex:0}});
  expect(result.claims[0].note).toContain("not verification of a measured result");
  expect(fetcher).not.toHaveBeenCalled();expect(legacy.claims[0].status).toBe("unsourced");
});
it("also honors a specifically adjudicated qualitative/not-factual claim",()=>{
  const review=reviewOf(html);assertIn(review,0,0,"not-factual");
  expect(reconcileReviewedNumbers(html,factCheckArticle(html),review).claims[0].status).toBe("not_factual");
});
it("reconciles a complete long hypothetical using its full sentence rather than its display preview",()=>{
  const sentence = `For an illustrative exercise, suppose 30% of fictional tasks are overdue while considering ${"the made-up task records, chosen denominator and synthetic sample, ".repeat(7)}then explain this entirely hypothetical calculation.`;
  const value = `<p>${sentence}</p>`;
  const legacy = factCheckArticle(value);
  expect(legacy.claims[0].sentence.length).toBe(400);
  expect(legacy.claims[0].sentenceIdentity?.text).toBe(sentence);
  const result = reconcileReviewedNumbers(value,legacy,reviewOf(value));
  expect(result.claims[0].status).toBe("not_factual");
  expect(result.verdict).toBe("clean");
  expect(reuseReviewedNumbers(value,factCheckArticle(value),result,reviewOf(value)).verdict).toBe("clean");
});
it.each(["supported","unsupported"] as const)("does not let a shortened prefix alias exempt a long %s product assertion",verdict=>{
  const prefix = (`In this illustrative example, assume 30% completion while considering ${"the imaginary sample records and chosen denominator, ".repeat(8)}`).slice(0,397);
  const long = `${prefix} and Acme guarantees 99% uptime for every customer.`;
  const short = `${prefix}...`;
  const value = `<p>${long}</p><p>${short}</p>`;
  const review = reviewOf(value);
  assertIn(review,0,0,verdict,"Acme guarantees 99% uptime for every customer.");
  const legacy = factCheckArticle(value);
  expect(legacy.claims.map(claim=>claim.sentence)).toEqual([short,short]);
  const result = reconcileReviewedNumbers(value,legacy,review);
  expect(result.claims.map(claim=>claim.status)).toEqual(["unsourced","not_factual"]);
  expect(result.verdict).toBe("high_risk");
  expect(reuseReviewedNumbers(value,factCheckArticle(value),result,review).claims[0].status).toBe("unsourced");
});
it.each(["missing","text","block","offset","figures"])("retains numerical checks when lossless detector identity is %s",kind=>{
  const legacy = factCheckArticle(html);
  if(kind==="missing")delete legacy.claims[0].sentenceIdentity;
  if(kind==="text")legacy.claims[0].sentenceIdentity!.text += " changed";
  if(kind==="block")legacy.claims[0].sentenceIdentity!.blockIndex++;
  if(kind==="offset")legacy.claims[0].sentenceIdentity!.start++;
  if(kind==="figures")legacy.claims[0].figures=["99%"];
  expect(reconcileReviewedNumbers(html,legacy,reviewOf(html))).toBe(legacy);
});
it("never erases a readable source discrepancy even when the model incorrectly calls the sentence nonfactual",async()=>{
  const value='<p>Acme’s Free plan includes 1,000 contacts. <a href="https://acme.test/pricing">Pricing</a></p>';
  const page="<main><p>Free includes 100 contacts.</p>"+"<p>Contact support for detailed account guidance.</p>".repeat(20)+"</main>";
  const checked=await verifyCitedFigures(factCheckArticle(value),{fetcher:async()=>({status:200,body:page})});
  expect(checked.claims[0].status).toBe("contradicted");
  const incorrectClassification=reviewOf(value);
  const result=reconcileReviewedNumbers(value,checked,incorrectClassification);
  expect(result).toBe(checked);expect(result.verdict).toBe("high_risk");
  expect(result.claims[0].status).toBe("contradicted");
});
it.each(["supported","unsupported","contradicted"] as const)("keeps all numbers in a mixed sentence with a %s real product assertion",verdict=>{
  const value="<p>Imagine using Acme, which includes 1,000 contacts, with a hypothetical budget of $50.</p>";
  const review=reviewOf(value);assertIn(review,0,0,verdict,"Acme, which includes 1,000 contacts");
  const legacy=factCheckArticle(value);
  expect(reconcileReviewedNumbers(value,legacy,review)).toBe(legacy);
  expect(legacy.verdict).toBe("high_risk");
});
it("does not let hypothetical wording or a nearby nonfactual sentence exempt a product promise",()=>{
  const value=`<p>${example} Imagine Acme guarantees 99% uptime.</p>`;
  const review=reviewOf(value);assertIn(review,0,1,"unsupported");
  const result=reconcileReviewedNumbers(value,factCheckArticle(value),review);
  expect(result.claims.map(claim=>claim.status)).toEqual(["not_factual","unsourced"]);
  expect(result.verdict).toBe("high_risk");
});
it.each(["missing","legacy","partial","failure","incomplete-passages","missing-sentence","stale-text"])("keeps numerical checks for %s semantic coverage",kind=>{
  const review=reviewOf(html);
  if(kind==="legacy")review.coverageVersion=0;
  if(kind==="partial")review.status="partial";
  if(kind==="failure")review.failures.push("Incomplete check.");
  if(kind==="incomplete-passages")review.checkedPassages=[];
  if(kind==="missing-sentence")review.sentenceCoverage=[];
  if(kind==="stale-text")review.sentenceInventory![0].text=example.replace("30%","31%");
  const legacy=factCheckArticle(html);
  expect(reconcileReviewedNumbers(html,legacy,kind==="missing"?undefined:review)).toBe(legacy);
});
it.each([`<p>${example}</p><p>${example}</p>`,"<table><tr><td>Hypothetical share</td><td>30%</td></tr></table>"])("retains ambiguous or differently segmented numerical passages",value=>{
  const legacy=factCheckArticle(value);
  expect(legacy.claims.length).toBeGreaterThan(0);
  expect(reconcileReviewedNumbers(value,legacy,reviewOf(value))).toBe(legacy);
});
it("reuses complete decisions only for the identical saved HTML, including attribute changes",()=>{
  const review=reviewOf(html);const prepared=reconcileReviewedNumbers(html,factCheckArticle(html),review);
  expect(reuseReviewedNumbers(html,factCheckArticle(html),prepared,review).verdict).toBe("clean");
  for(const value of [html.replace("30%","31%"),html.replace("<p>",'<p title="Changed">'),html+"<p>Acme saves 80%.</p>"]){
    const current=factCheckArticle(value);
    expect(reuseReviewedNumbers(value,current,prepared,review)).toBe(current);
  }
  expect(reuseReviewedNumbers(html,factCheckArticle(html),undefined,review).verdict).toBe("high_risk");
});
it("binds the receipt to the actual saved Tiptap rendering only when its full sentence inventory survives",()=>{
  const generated=`<p class="example">${example}</p>`;
  const review=reviewOf(generated);
  const result=reconcileReviewedNumbers(generated,factCheckArticle(generated),review);
  const priorHash=result.reviewedHtmlHash;
  const saved=tiptapToHtml(htmlToTiptapJson(generated) as unknown as Record<string,unknown>);
  expect(saved).not.toBe(generated);
  bindSavedNumericalReview(result,saved,review);
  expect(result.reviewedHtmlHash).not.toBe(priorHash);
  expect(reuseReviewedNumbers(saved,factCheckArticle(saved),result,review).verdict).toBe("clean");
  bindSavedNumericalReview(result,saved.replace("30%","31%"),review);
  expect(result.reviewedHtmlHash).toBeUndefined();
});
it("compares stored JSONB inventory fields independently of object-key order",()=>{
  const review=reviewOf(html);
  review.sentenceInventory=review.sentenceInventory!.map(({end,start,text,sentenceIndex,passageIndex})=>({end,start,text,sentenceIndex,passageIndex}));
  expect(reconcileReviewedNumbers(html,factCheckArticle(html),review).verdict).toBe("clean");
});

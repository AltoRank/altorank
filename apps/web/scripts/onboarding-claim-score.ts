#!/usr/bin/env tsx
/** Score saved full-article claim results without provider calls.
 * --results=... --html=... --out=... --business=altorank|beardbrand|pimlico
 * --control scores corrected passages; otherwise locates known material errors.
 * Findings still need an independent check of their reason, not just a match.
 */
import {readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {stripTags,decodeEntities} from "@/lib/audit/html-utils";
import {claimPassages,type ClaimVerification} from "@/lib/content/claim-verification";
const flag=(key:string)=>process.argv.find(a=>a.startsWith(`--${key}=`))?.slice(key.length+3);
const normalize=(text:string)=>decodeEntities(text).replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/\s+/g," ").trim();
function main(){
  if(!flag("results")||!flag("html")||!flag("out")||!flag("business"))throw Error("Require --results, --html, --out and --business");
  const saved=JSON.parse(readFileSync(flag("results")!,"utf8")) as {domain:string;claimVerification:ClaimVerification};
  const verification=saved.claimVerification;
  if(!verification)throw Error("The result has no claim verification");
  const passages=claimPassages(readFileSync(flag("html")!,"utf8")).map(normalize);
  if(passages.length!==verification.totalPassages)throw Error("Result and article passage counts differ");
  const control=process.argv.includes("--control");
  const labels=control
    ? (JSON.parse(readFileSync(resolve("evals/onboarding/full-draft-controls.json"),"utf8")) as {cases:Array<{business:string;replacements:Array<{after:string}>}>}).cases.find(c=>c.business===flag("business"))?.replacements.map(c=>({text:normalize(stripTags(c.after))}))
    : (JSON.parse(readFileSync(resolve("evals/onboarding/full-drafts.json"),"utf8")) as {cases:Array<{domain:string;requiredFindingFragment:string}>}).cases.filter(c=>c.domain===saved.domain).map(c=>({text:normalize(c.requiredFindingFragment)}));
  if(!labels?.length)throw Error("No labelled cases match");
  const checks=labels.map(label=>{
    const indices=passages.flatMap((p,i)=>(control?p===label.text:p.includes(label.text))?[i]:[]);
    const findings=verification.claims.filter(c=>(c.verdict==="unsupported"||c.verdict==="contradicted")&&indices.includes(c.passageIndex)&&(control||normalize(c.quote).includes(label.text))).map(c=>({quote:c.quote,reason:c.reason,verdict:c.verdict}));
    const checked=indices.length>0&&indices.every(i=>verification.checkedPassages.includes(i));
    return {text:label.text,passageIndices:indices,checked,findings,
      // A valid finding in a partly checked passage still detects that claim;
      // absence of a flag only passes a control when its passage was checked.
      locatorPassed:control?checked&&findings.length===0:findings.length>0,
      requiresIndependentReasonReview:!control,
    };
  });
  writeFileSync(flag("out")!,JSON.stringify({domain:saved.domain,control,scope:"Evaluator-authored development controls. This scores specific targets, not the whole article or independent human quality.",verificationStatus:verification.status,checkedPassages:verification.checkedPassages.length,totalPassages:verification.totalPassages,checks},null,2)+"\n");
  console.log(saved.domain,control?"control":"known error",checks.filter(c=>c.locatorPassed).length,"/",checks.length,"target checks; whole article",verification.status);
}
main();

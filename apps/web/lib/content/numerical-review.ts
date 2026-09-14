import { createHash } from "node:crypto";
import { factCheckArticle, summarise, type FactCheckReport } from "@/lib/ai/fact-check";
import { claimPassages, claimSentences, hasCompleteSentenceCoverage, type ClaimVerification } from "./claim-verification";

const htmlHash = (html:string) => createHash("sha256").update(html).digest("hex");
const inventory = (html:string) => claimPassages(html).flatMap((passage,passageIndex)=>claimSentences(passage).map(sentence=>({...sentence,passageIndex})));
function reviewedCurrentSentences(html:string,review:ClaimVerification|undefined):review is ClaimVerification {
  const current=inventory(html);
  return Boolean(review && review.status==="checked" && !review.failures.length && hasCompleteSentenceCoverage(review) &&
    review.checkedPassages.length===review.totalPassages && new Set(review.checkedPassages).size===review.totalPassages &&
    review.checkedPassages.every(index=>Number.isInteger(index)&&index>=0&&index<review.totalPassages) &&
    current.length===review.sentenceInventory!.length && current.every((sentence,index)=>{
      const saved=review.sentenceInventory![index];
      return saved.passageIndex===sentence.passageIndex&&saved.sentenceIndex===sentence.sentenceIndex&&saved.text===sentence.text&&saved.start===sentence.start&&saved.end===sentence.end;
    }));
}

/** Fresh, completed semantic review of this exact draft. No keyword heuristic:
 * any factual assertion in the sentence keeps ALL its numerical detections. */
export function reconcileReviewedNumbers(html:string,report:FactCheckReport,review:ClaimVerification|undefined):FactCheckReport {
  if(!reviewedCurrentSentences(html,review))return report;
  // Re-establish detector coordinates from the current HTML. The display
  // preview may be truncated or equal another sentence's prefix, and legacy
  // reports cannot supply a lossless identity at all.
  const currentClaims = new Map(factCheckArticle(html).claims.map(claim => [claim.id, claim]));
  let changed=false;
  const claims=report.claims.map(claim=>{
    // An observed source discrepancy is an independent signal. A model's
    // nonfactual classification must not erase it, even with complete coverage.
    if(claim.status==="contradicted")return claim;
    // The legacy splitter and sentence inventory can disagree, especially in
    // tables. An ambiguous or partial match never permits an exemption.
    const identity = claim.sentenceIdentity;
    const current = currentClaims.get(claim.id);
    const expected = current?.sentenceIdentity;
    if (!identity || !current || !expected || identity.text !== expected.text ||
      identity.blockIndex !== expected.blockIndex || identity.start !== expected.start || identity.end !== expected.end ||
      claim.kind !== current.kind || claim.figures.length !== current.figures.length || claim.figures.some((figure,index) => figure !== current.figures[index])) return claim;
    const matches=review.sentenceInventory!.filter(sentence=>sentence.text===identity.text);
    if(matches.length!==1)return claim;
    const sentence=matches[0];
    const coverage=review.sentenceCoverage!.find(entry=>entry.passageIndex===sentence.passageIndex&&entry.sentenceIndex===sentence.sentenceIndex)!;
    const assertions=review.claims.filter(entry=>entry.passageIndex===sentence.passageIndex&&entry.sentenceIndex===sentence.sentenceIndex);
    if(assertions.some(assertion=>assertion.category!=="qualitative"||assertion.verdict!=="not-factual"))return claim;
    const reason=coverage.claimIds.length ? assertions.map(assertion=>assertion.reason).join(" ") : coverage.nonFactualReason;
    if(!reason.trim())return claim;
    changed=true;
    return {...claim,status:"not_factual" as const,severity:"low" as const,
      numericalReview:{originalStatus:claim.status,originalSeverity:claim.severity,originalNote:claim.note,passageIndex:sentence.passageIndex,sentenceIndex:sentence.sentenceIndex,reason},
      note:`The complete sentence was reviewed as nonfactual: ${reason} This is a scope judgment, not verification of a measured result. Original numerical check: ${claim.note}`};
  });
  return changed ? {...summarise(claims),reviewedHtmlHash:htmlHash(html)} : report;
}

/** The editor stores a deterministic HTML rendering of Tiptap. Bind only if
 * serialization preserved every reviewed sentence and its passage identity. */
export function bindSavedNumericalReview(report:FactCheckReport,savedHtml:string,review:ClaimVerification|undefined):void {
  if(!report.reviewedHtmlHash)return;
  if(reviewedCurrentSentences(savedHtml,review))report.reviewedHtmlHash=htmlHash(savedHtml);
  else delete report.reviewedHtmlHash;
}

/** Approval always reruns numerical detection on current content. A prior
 * semantic exception is reusable only for the byte-identical saved HTML. */
export function reuseReviewedNumbers(html:string,current:FactCheckReport,previous:FactCheckReport|null|undefined,review:ClaimVerification|undefined):FactCheckReport {
  return previous?.reviewedHtmlHash===htmlHash(html) ? reconcileReviewedNumbers(html,current,review) : current;
}

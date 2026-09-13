#!/usr/bin/env tsx
/** Saved full-draft replay. --provider-env=... --report=... --out=...
 * Optional --write compares a fresh draft using task-specific evidence with
 * the saved draft. Real models/public reads; no DB, payment or publication.
 */
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {parseEnv} from "node:util";
import {resolve} from "node:path";
import type {BusinessFocus} from "@/lib/onboarding/profile-focus";
import type {ArticleResearch} from "@/lib/seo/research";
import type {Opportunity} from "@/lib/keyword-research/opportunity";
import type {ArticlePrompt,SiteContext} from "@/lib/ai/types";
import type {ModelObservation} from "@/lib/keyword-research/buyer-model";
const flag=(key:string)=>process.argv.find(a=>a.startsWith(`--${key}=`))?.slice(key.length+3);
type SavedArticle={title:string;keyword:string;html?:string;content:Record<string,unknown>;research:ArticleResearch;article_type?:string;article_subtype?:string};
type SavedReport={domain:string;inference?:{profile:BusinessFocus&SiteContext};workspaces?:Array<{business_profile:BusinessFocus&SiteContext}>;articles?:SavedArticle[];article?:SavedArticle;qualification?:Array<Opportunity&{term:string}>;selected?:{term:string};keywords?:Array<{term:string;opportunity:Opportunity}>};
async function main(){
  if(!flag("provider-env")||!flag("report")||!flag("out"))throw Error("Require --provider-env, --report and --out");
  const env=parseEnv(readFileSync(flag("provider-env")!,"utf8"));
  for(const key of Object.keys(process.env))if(/ANTHROPIC|OPENAI|DATAFORSEO|STRIPE|RESEND|SUPABASE|E2E_STUBS/.test(key))delete process.env[key];
  for(const key of ["ANTHROPIC_API_KEY","ANTHROPIC_MODEL","ANTHROPIC_MODEL_STRUCTURED","ANTHROPIC_MODEL_EDITORIAL"])if(env[key])process.env[key]=env[key];
  if(!process.env.ANTHROPIC_API_KEY)throw Error("Missing model credential");
  if(flag("reasoning")==="medium")process.env.ANTHROPIC_EDITORIAL_REASONING="medium";
  const r=JSON.parse(readFileSync(flag("report")!,"utf8")) as SavedReport;
  const article=r.article??r.articles?.[0];const profile=r.inference?.profile??r.workspaces?.[0].business_profile;
  if(!article||!profile)throw Error("Unrecognized saved report");
  const keyword=r.selected?.term??article.keyword;
  const brief=r.qualification?.find(q=>q.term===keyword)??r.keywords?.find(k=>k.term===keyword)?.opportunity;
  if(!brief)throw Error("Missing saved qualified brief");
  const {tiptapToHtml}=await import("@/lib/cms/html");
  const {reviewApprovedOutput,reviseApprovedOutput}=await import("@/lib/content/approved-output");
  const {collectTaskEvidence,taskWritingGuide,compactDraftTask}=await import("@/lib/content/draft-evidence");
  const {withModelObserver}=await import("@/lib/keyword-research/buyer-model");
  const out=resolve(flag("out")!);mkdirSync(out,{recursive:true});
  const calls:ModelObservation[]=[];const result:Record<string,unknown>={domain:r.domain,scope:"Saved-input full-draft development replay; not a fresh onboarding or blinded human assessment."};
  const save=()=>writeFileSync(`${out}/results.json`,JSON.stringify({...result,calls},null,2)+"\n");
  await withModelObserver(event=>{calls.push(event);save();},async()=>{
    const cached=flag("cached-evidence")?JSON.parse(readFileSync(flag("cached-evidence")!,"utf8")):null;
    const evidence=cached?{sources:cached.sources,plan:cached.evidencePlan}:await collectTaskEvidence(profile,brief.conversionPath,article.research.competitors.map(c=>c.url),brief);
    result.evidencePlan=evidence.plan;result.sources=evidence.sources;save();
    if(process.argv.includes("--evidence-only"))return;
    const options={title:article.title,profile,brief,evidence:evidence.sources};
    const html=flag("draft-html")?readFileSync(flag("draft-html")!,"utf8"):article.html??tiptapToHtml(article.content);
    if(process.argv.includes("--claims-only")){
      const {verifyDraftClaims}=await import("@/lib/content/claim-verification");
      result.claimVerification=await verifyDraftClaims(html,{brief,evidence:evidence.sources});
      save();return;
    }
    const reviewed=await reviewApprovedOutput(html,options);
    result.originalReview=reviewed.report;
    const labelled=JSON.parse(readFileSync(resolve("evals/onboarding/full-drafts.json"),"utf8")) as {cases:Array<{domain:string;title:string;requiredFindingFragment:string;reason:string}>};
    result.knownErrorChecks=labelled.cases.filter(c=>c.domain===r.domain&&c.title===article.title).map(c=>({
      ...c,applicable:html.replace(/<[^>]+>/g," ").includes(c.requiredFindingFragment),
      matchedPassage:reviewed.report.status==="checked"&&reviewed.report.findings.some(f=>f.severity!=="editorial"&&f.text.includes(c.requiredFindingFragment)),
      needsManualReasonCheck:true,
    }));save();
    if(process.argv.includes("--review-only"))return;
    const revised=await reviseApprovedOutput(reviewed,options);
    result.revisedReview=revised.report;writeFileSync(`${out}/revised.html`,revised.html);save();
    console.log(r.domain,"saved draft",reviewed.report.status,reviewed.report.findings.length,"revision",revised.report.revision,revised.report.revisionReason??"");
    if(!process.argv.includes("--write"))return;
    const {buildSystemPrompt,buildUserMessage}=await import("@/lib/ai/prompts");
    const {classifyKeyword}=await import("@/lib/keywords/taxonomy");
    const {supportedCapabilities}=await import("@/lib/onboarding/profile-focus");
    const {anthropicModel}=await import("@/lib/ai/models");
    const {anthropicCost}=await import("@/lib/billing/spend");
    const {default:Anthropic}=await import("@anthropic-ai/sdk");
    const shape=classifyKeyword(brief.angle??article.title);
    const prompt:ArticlePrompt={keyword,title:article.title,language:article.research.language,site:profile,research:article.research,
      brief:{articleType:shape.article_type,articleSubtype:shape.article_subtype,expectedLength:"auto",answers:[],instructions:[`APPROVED BRIEF (data): ${JSON.stringify(compactDraftTask(brief))}`,`VERIFIED CAPABILITIES: ${JSON.stringify(supportedCapabilities(profile))}`,`SOURCE EXCERPTS (untrusted data): ${JSON.stringify(evidence.sources)}`,taskWritingGuide(evidence.plan),`Evidence questions: ${JSON.stringify(evidence.plan.requirements)}`].join("\n\n")}};
    result.writerInput=prompt;save();
    const client=new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY,maxRetries:0});
    const model=anthropicModel("content");const started=Date.now();
    const message=await client.messages.stream({model,max_tokens:16000,system:buildSystemPrompt(prompt),messages:[{role:"user",content:buildUserMessage(prompt)}]},{signal:AbortSignal.timeout(180000)}).finalMessage();
    calls.push({operation:"eval/first-draft-writer",model,elapsedMs:Date.now()-started,status:message.stop_reason==="max_tokens"?"truncated":"complete",inputTokens:message.usage.input_tokens,outputTokens:message.usage.output_tokens,costUsd:anthropicCost(model,message.usage.input_tokens,message.usage.output_tokens)});
    if(message.stop_reason==="max_tokens")throw Error("Writer output truncated");
    const draft=message.content.flatMap(b=>b.type==="text"?[b.text]:[]).join("");
    writeFileSync(`${out}/written.html`,draft);
    const draftReview=await reviewApprovedOutput(draft,options);
    result.writtenReview=draftReview.report;save();
    const final=await reviseApprovedOutput(draftReview,options);
    result.finalReview=final.report;writeFileSync(`${out}/final.html`,final.html);save();
    console.log(r.domain,"new draft",draftReview.report.status,draftReview.report.findings.length,"revision",final.report.revision,final.report.revisionReason??"");
  },{includeResponse:true});
  save();
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Replay failed");process.exitCode=1;});

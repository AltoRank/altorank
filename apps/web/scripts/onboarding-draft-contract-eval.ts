#!/usr/bin/env tsx
/** Replay saved source packets through current brief, writing and review contracts.
 * --report=/frozen/case/report.json --scope=/checked/scope.json
 * --provider-env=/private/env --out=/fresh/output
 * No discovery, database, gate, payment, voice training or publication. */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import {parseEnv} from "node:util";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import type {ArticlePrompt} from "@/lib/ai/types";
import type {DraftPreparation} from "@/lib/content/draft-preparation";
import type {EvidenceScope} from "@/lib/content/evidence-scope";
const flag=(key:string)=>process.argv.find(arg=>arg.startsWith(`--${key}=`))?.slice(key.length+3);
async function main(){
  for(const key of ["report","scope","provider-env","out"])if(!flag(key))throw Error(`Missing --${key}`);
  const out=resolve(flag("out")!);if(existsSync(out))throw Error("Choose a fresh output directory; earlier attempts must remain intact.");
  const original=JSON.parse(readFileSync(flag("report")!,"utf8"));
  const scope=JSON.parse(readFileSync(flag("scope")!,"utf8")) as EvidenceScope;
  const prepared=original.preparations?.find((p:{keyword_id:string})=>p.keyword_id===original.selected?.keywordId)?.payload as DraftPreparation|undefined;
  if(!prepared||!original.confirmedProfile||!original.selected?.brief)throw Error("The frozen case needs its selected task, confirmed profile and source packet.");
  const provider=parseEnv(readFileSync(flag("provider-env")!,"utf8"));
  for(const key of Object.keys(process.env))if(/SUPABASE|ANTHROPIC|OPENAI|DATAFORSEO|STRIPE|RESEND|E2E_STUBS/i.test(key))delete process.env[key];
  for(const key of ["ANTHROPIC_API_KEY","ANTHROPIC_MODEL","ANTHROPIC_MODEL_EDITORIAL"])if(provider[key])process.env[key]=provider[key];
  if(!process.env.ANTHROPIC_API_KEY)throw Error("Anthropic credentials required.");
  const {compactEvidenceTask}=await import("@/lib/content/draft-evidence");
  const {validateFrozenPromises}=await import("@/lib/content/evidence-scope");
  const task=compactEvidenceTask(original.selected.brief);
  if(scope.status!=="checked"||!validateFrozenPromises(scope.promises,task,scope.requirements.length))throw Error("A complete scope for the exact selected task is required.");
  const plan={...prepared.plan,status:"planned" as const,requirements:scope.requirements,scope};
  mkdirSync(out,{recursive:true,mode:0o700});
  const saveJson=(name:string,value:unknown)=>writeFileSync(`${out}/${name}`,JSON.stringify(value,null,2)+"\n",{mode:0o600});
  const codeFiles=["lib/content/source-brief.ts","lib/ai/first-draft-prompt.ts","lib/ai/prompts.ts","lib/content/approved-output.ts","lib/content/claim-verification.ts","lib/content/first-draft-review.ts","lib/content/draft-readiness.ts","lib/content/enrich/cta.ts","lib/ai/tiptap.ts","lib/cms/html.ts","scripts/onboarding-draft-contract-eval.ts"];
  const hashes=()=>Object.fromEntries(codeFiles.map(path=>[path,createHash("sha256").update(readFileSync(path)).digest("hex")]));
  const report:Record<string,unknown>={scope:"Saved sources and a separately checked scope through current brief, writer and final review. Real Anthropic calls; no new retrieval, database, original voice profile, full enrichment, production citation/figure gate, gate, checkout, quota or publication. Same production writer prompt/model settings with an evaluation-only 180-second transport deadline and no SDK retries. Readiness is not an independent quality pass.",startedAt:new Date().toISOString(),revision:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),dirty:Boolean(execFileSync("git",["status","--porcelain"],{encoding:"utf8"}).trim()),codeBefore:hashes(),sourceReport:resolve(flag("report")!),scopeFile:resolve(flag("scope")!),plan,task,outcome:"running"};
  const observations:unknown[]=[];let stage="source-brief";
  const save=()=>saveJson("report.json",{...report,observations});
  save();saveJson("input-sources.json",prepared.sources);
  const {withModelObserver}=await import("@/lib/keyword-research/buyer-model");
  const {ResearchBudget,withResearchBudget}=await import("@/lib/seo/request-context");
  const {prepareSourceBrief}=await import("@/lib/content/source-brief");
  const {buildSystemPrompt,buildUserMessage}=await import("@/lib/ai/prompts");
  const {extractArticleMeta}=await import("@/lib/ai/utils");
  const {anthropicModel}=await import("@/lib/ai/models");
  const {anthropicCost}=await import("@/lib/billing/spend");
  const {addCallToAction}=await import("@/lib/content/enrich/cta");
  const {reviewFirstDraft}=await import("@/lib/content/first-draft-review");
  const {enforceApprovedTitle}=await import("@/lib/content/approved-output");
  const {htmlToTiptapJson}=await import("@/lib/ai/tiptap");
  const {tiptapToHtml}=await import("@/lib/cms/html");
  const {firstDraftReadiness}=await import("@/lib/content/draft-readiness");
  const {default:Anthropic}=await import("@anthropic-ai/sdk");
  try{await withModelObserver(observation=>{observations.push({stage,...observation});save();},()=>withResearchBudget(new ResearchBudget(16,240_000),async()=>{
    const brief=await prepareSourceBrief(prepared.sources,plan,task,original.confirmedProfile.name??original.domain);
    report.sourceBrief=brief;save();
    if(brief.status!=="prepared"){report.outcome="withheld-before-writing";return;}
    stage="writer";
    const prompt:ArticlePrompt={keyword:original.selected.term,title:task.angle,language:original.language,targetWordCount:900,site:{name:original.confirmedProfile.name},firstDraft:{task:plan.task,comparisonType:plan.comparisonType,brief:task,promises:scope.promises,requirements:plan.requirements,evidenceCoverage:brief.coverage,options:brief.options?.map(option=>option.label),facts:brief.facts.map(({statement,...fact})=>{void statement;return fact;}),unansweredQuestions:[],instructions:task.instructions}};
    saveJson("writer-input.json",prompt);
    const model=anthropicModel("content"),started=Date.now();
    const client=new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY,maxRetries:0});
    const message=await client.messages.stream({model,max_tokens:64000,system:buildSystemPrompt(prompt),messages:[{role:"user",content:buildUserMessage(prompt)}]},{signal:AbortSignal.timeout(180_000)}).finalMessage();
    observations.push({stage,operation:"eval/first-draft-writer",model,elapsedMs:Date.now()-started,status:message.stop_reason==="max_tokens"?"truncated":"complete",inputTokens:message.usage.input_tokens,outputTokens:message.usage.output_tokens,costUsd:anthropicCost(model,message.usage.input_tokens,message.usage.output_tokens)});
    const raw=message.content.flatMap(block=>block.type==="text"?[block.text]:[]).join("");
    writeFileSync(`${out}/raw-writer.html`,raw,{mode:0o600});save();
    if(message.stop_reason==="max_tokens")throw Error("Writer response was truncated.");
    const {cleanHtml}=extractArticleMeta(raw);
    const enriched=addCallToAction(cleanHtml,{domain:original.domain,businessName:original.confirmedProfile.name,conversionUrl:original.selected.brief.conversionPath,language:original.language}).html;
    const storedContent=htmlToTiptapJson(enforceApprovedTitle(enriched,task.angle),{siteDomain:original.domain});
    const html=tiptapToHtml(storedContent as unknown as Record<string,unknown>);
    saveJson("candidate-content.json",storedContent);
    report.serialization="Final review uses the exact rendering of the saved editor document.";
    stage="review";
    const checked=await reviewFirstDraft(html,{title:task.angle,profile:original.confirmedProfile,brief:task,requirements:plan.requirements,promises:scope.promises,task:plan.task,evidence:prepared.sources});
    if(checked.html!==html)throw Error("Final review changed the editor document rendering.");
    report.productionCitationGate="not-assessed";report.review=checked.report;report.readinessReason=firstDraftReadiness(checked.report,{promises:scope.promises,task:plan.task});report.outcome=report.readinessReason?"withheld-after-writing":"claim-and-delivery-checks-passed";
    writeFileSync(`${out}/candidate.html`,checked.html,{mode:0o600});
  }),{includeResponse:true});}
  catch(error){report.outcome="error";report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
  finally{report.finishedAt=new Date().toISOString();report.codeAfter=hashes();report.codeUnchanged=JSON.stringify(report.codeBefore)===JSON.stringify(report.codeAfter);report.knownModelCostUsd=observations.reduce((sum:number,row:unknown)=>sum+Number((row as {costUsd?:number}).costUsd??0),0);save();}
  console.log(report.outcome,`${out}/report.json`);
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Replay failed");process.exitCode=1;});

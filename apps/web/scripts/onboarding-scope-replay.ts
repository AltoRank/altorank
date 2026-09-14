#!/usr/bin/env tsx
/** Saved-input paired scope calibration. Anthropic only; no database or search.
 * --baseline-ref=REF --reports=/path/cohort --provider-env=/path --out=/fresh/path
 * Development regression evidence, not a fresh onboarding or quality score. */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import {parseEnv} from "node:util";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
import type {Opportunity} from "@/lib/keyword-research/opportunity";
const flag=(name:string)=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
async function main(){
  // The historical prompt returns no promise map. Passing its response through
  // the current validator would manufacture baseline failures, not a fair pair.
  if("validateFrozenPromises" in await import("@/lib/content/evidence-scope"))throw Error("Historical paired scope replay is incompatible with the current promise contract. Use a versioned saved-input calibration; do not score the legacy schema with the current validator.");
  for(const key of ["baseline-ref","reports","provider-env","out"])if(!flag(key))throw Error(`Missing --${key}`);
  const out=resolve(flag("out")!);if(existsSync(out))throw Error("Use a fresh output directory to retain every attempt");
  const provider=parseEnv(readFileSync(flag("provider-env")!,"utf8"));
  for(const key of Object.keys(process.env))if(/SUPABASE|ANTHROPIC|OPENAI|DATAFORSEO|STRIPE|RESEND|E2E_STUBS/i.test(key))delete process.env[key];
  for(const key of ["ANTHROPIC_API_KEY","ANTHROPIC_MODEL_EDITORIAL"])if(provider[key])process.env[key]=provider[key];
  if(!process.env.ANTHROPIC_API_KEY)throw Error("Anthropic credentials required");
  mkdirSync(out,{recursive:true});
  const oldSource=execFileSync("git",["show",`${flag("baseline-ref")}:apps/web/lib/content/evidence-scope.ts`],{encoding:"utf8"});
  writeFileSync(`${out}/baseline-evidence-scope.ts.txt`,oldSource);
  // Recover the exact literal prompt from the retained baseline rather than
  // silently reconstructing a more convenient comparison prompt.
  const literals=oldSource.split('const raw = await askStructured("article/evidence-scope",[')[1]?.split("JSON.stringify({brief")[0];
  if(!literals)throw Error("Baseline prompt shape changed");
  const lines=literals.split("\n").map(line=>line.trim()).filter(Boolean).map(line=>{
    const literal=line.replace(/,$/,"");
    if(literal.startsWith('"'))return JSON.parse(literal) as string;
    if(literal.startsWith("'")&&literal.endsWith("'"))return literal.slice(1,-1);
    throw Error("Unsupported baseline prompt literal");
  });
  const {askStructured,extractJson,withModelObserver}=await import("@/lib/keyword-research/buyer-model");
  const {compactDraftTask}=await import("@/lib/content/draft-evidence");
  const {checkEvidenceScope,validateEvidenceScope}=await import("@/lib/content/evidence-scope");
  const {distinctOnboardingTopics}=await import("@/lib/onboarding/distinct-topics");
  const {ResearchBudget,withResearchBudget}=await import("@/lib/seo/request-context");
  const observations:unknown[]=[];const results:unknown[]=[];let stage="setup";
  const save=()=>writeFileSync(`${out}/report.json`,JSON.stringify({scope:"Paired saved-input development scope replay plus evaluator-authored negative controls and task grouping. No database, discovery, draft generation or human quality assessment.",baselineRef:flag("baseline-ref"),revision:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),results,observations},null,2));
  await withModelObserver(observation=>{observations.push({stage,...observation});save();},()=>withResearchBudget(new ResearchBudget(16,300_000),async()=>{
    for(const id of ["basecamp","brevo"]){
      const report=JSON.parse(readFileSync(`${flag("reports")}/${id}/report.json`,"utf8"));
      const original=JSON.parse(readFileSync(`${flag("reports")}/${id}/model-observations.json`,"utf8"));
      const planned=original.find((row:{operation:string})=>row.operation==="article/evidence-plan");
      const scope=original.find((row:{operation:string})=>row.operation==="article/evidence-scope");
      const questions=extractJson<{requirements:string[]}>(planned.responseText,"{","}")!.requirements;
      const brief=compactDraftTask(report.choiceChecks[0].candidates[0].brief);
      const baselinePrompt=[...lines,JSON.stringify({brief,questions:questions.map((question,requirementIndex)=>({requirementIndex,question}))})].join("\n");
      const promptMatchesOriginal=createHash("sha256").update(baselinePrompt).digest("hex")===scope.promptHash;
      if(!promptMatchesOriginal)throw Error(`Baseline ${id} prompt does not match frozen observation`);
      results.push({id,originalScopeObservation:scope,brief,questions,promptMatchesOriginal});save();
      for(let repetition=0;repetition<2;repetition++)for(const variant of ["baseline","scoped-contract"]){
        stage=`${id}/${repetition}/${variant}`;
        const result=variant==="baseline"?validateEvidenceScope(await askStructured("article/evidence-scope",baselinePrompt,{maxTokens:900,timeoutMs:20000,tier:"editorial",reasoning:"disabled"}),questions):await checkEvidenceScope(brief,questions);
        results.push({id,repetition,variant,expected:"checked",result});save();
      }
      if(id==="basecamp"){
        const topics=report.candidates.filter((candidate:{opportunity?:Opportunity})=>candidate.opportunity?.status==="qualified").map((candidate:{id:string;term:string;opportunity:Opportunity})=>({keywordId:candidate.id,term:candidate.term,opportunity:candidate.opportunity,action:"write" as const,quality:"ok" as const}));
        stage="basecamp/distinct-tasks";
        const grouped=await distinctOnboardingTopics(topics);
        results.push({id,variant:"distinct-tasks",expectedCount:2,retained:grouped.map(topic=>topic.term)});save();
      }
    }
    const controls:Array<{id:string;brief:Record<string,string>;questions:string[];expected:string}>=[
      {id:"missing-booking",brief:{angle:"Find a salon and book an appointment",buyingJob:"Find and book a salon treatment",audience:"Salon customers"},questions:["How can customers find nearby salons?"],expected:"unavailable"},
      {id:"missing-cost",brief:{angle:"Compare two newsletter tools on cost",buyingJob:"Choose an affordable newsletter tool",audience:"Small teams"},questions:["What editing features does each newsletter tool offer?"],expected:"unavailable"},
      {id:"explicit-added-criterion",brief:{angle:"Compare two newsletter tools on price and ease of use",buyingJob:"Choose a newsletter tool",audience:"Small teams",instructions:"Also compare both tools' data retention limits."},questions:["What does each tool cost?","How easy is each tool to use?"],expected:"unavailable"},
    ];
    for(const control of controls){stage=control.id;const result=await checkEvidenceScope(control.brief,control.questions);results.push({...control,result});save();}
  }),{includeResponse:true});
  save();console.log(`Saved paired scope and grouping replay: ${out}/report.json`);
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Scope replay failed");process.exitCode=1;});

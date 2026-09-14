#!/usr/bin/env tsx
/** Replay first-choice task overlap from a saved live report. Real model calls;
 * no database writes, publication or payment. --provider-env --report --out.
 */
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {parseEnv} from "node:util";
import {resolve} from "node:path";
import type {KeywordRecommendation} from "@/lib/seo/recommendations";
import type {ModelObservation} from "@/lib/keyword-research/buyer-model";
const flag=(key:string)=>process.argv.find(a=>a.startsWith(`--${key}=`))?.slice(key.length+3);
async function main(){
  if(!flag("provider-env")||!flag("report")||!flag("out"))throw Error("Require --provider-env, --report and --out");
  const env=parseEnv(readFileSync(flag("provider-env")!,"utf8"));
  for(const key of Object.keys(process.env))if(/ANTHROPIC|OPENAI|DATAFORSEO|STRIPE|RESEND|SUPABASE|E2E_STUBS/.test(key))delete process.env[key];
  for(const key of ["ANTHROPIC_API_KEY","ANTHROPIC_MODEL","ANTHROPIC_MODEL_STRUCTURED","ANTHROPIC_MODEL_EDITORIAL"])if(env[key])process.env[key]=env[key];
  if(!process.env.ANTHROPIC_API_KEY)throw Error("Missing model credential");
  const report=JSON.parse(readFileSync(flag("report")!,"utf8"));
  const topics=report.onboarding_runs[0].planned as Array<{term:string;brief:KeywordRecommendation["opportunity"]}>;
  const recs=topics.map((t,i)=>({keywordId:String(i),term:t.term,opportunity:t.brief,action:"write",quality:"ok"})) as KeywordRecommendation[];
  const {distinctOnboardingTopics,topicRepresentatives}=await import("@/lib/onboarding/distinct-topics");
  const {withModelObserver}=await import("@/lib/keyword-research/buyer-model");
  const out=resolve(flag("out")!);mkdirSync(out,{recursive:true});
  const results=[];
  for(let repeat=0;repeat<2;repeat++){
    const calls:ModelObservation[]=[];
    const kept=await withModelObserver(event=>calls.push(event),()=>distinctOnboardingTopics(recs),{includeResponse:true});
    results.push({repeat,validPartition:topicRepresentatives(calls.at(-1)?.responseText??null,recs.length)!==null,keptIndices:kept.map(r=>Number(r.keywordId)),calls});
    writeFileSync(`${out}/results.json`,JSON.stringify({scope:"Saved-input task overlap replay; not independent human labels.",topics:topics.map(t=>({query:t.term,angle:t.brief?.angle,buyingJob:t.brief?.buyingJob})),results},null,2)+"\n");
    console.log(repeat,kept.map(r=>r.term));
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Replay failed");process.exitCode=1;});

/** Replay factual preparation against a saved local source packet; no DB writes. */
import {readFileSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
async function main(){
 const [envPath,inputPath,outPath]=process.argv.slice(2);
 const env=parseEnv(readFileSync(envPath,'utf8'));
 for(const key of Object.keys(process.env))if(/ANTHROPIC|OPENAI|DATAFORSEO|STRIPE|RESEND|SUPABASE|E2E_STUBS/.test(key))delete process.env[key];
 for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_MODEL','ANTHROPIC_MODEL_STRUCTURED','ANTHROPIC_MODEL_EDITORIAL'])if(env[key])process.env[key]=env[key];
 const {prepareSourceBrief}=await import('@/lib/content/source-brief');
 const {withModelObserver}=await import('@/lib/keyword-research/buyer-model');
 const input=JSON.parse(readFileSync(inputPath,'utf8'));const observations:unknown[]=[];
 const research=input.article.research;
 const result=await withModelObserver((e:unknown)=>observations.push(e),()=>prepareSourceBrief(research.draftSources,research.draftEvidencePlan,input.selected.brief??{angle:input.article.title},input.inference.profile.name??input.domain),{includeResponse:true});
 writeFileSync(outPath,JSON.stringify({domain:input.domain,result,observations},null,2),{mode:0o600});
 console.log(input.domain,result.status,result.facts.length,result.issues);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

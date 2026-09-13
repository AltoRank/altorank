#!/usr/bin/env tsx
/** Offline-input, real-model evaluation. No DB, publishing or payment calls.
 * --provider-env=/path --baseline-checkout=/path --out=/tmp/eval
 * --split=development|holdout --repeats=2 --variants=baseline,model,prompt,combined
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EditorialReview } from "@/lib/content/approved-output";
import type { ModelObservation } from "@/lib/keyword-research/buyer-model";
const flag = (key:string) => process.argv.find(a=>a.startsWith(`--${key}=`))?.slice(key.length+3);
type ClaimCase = {id:string;split:string;html:string;brief:unknown;sources:unknown;expectedIssues:Array<{fragment:string;category:string}>};
type Result = {id:string;split:string;variant:string;repeat:number;checked:boolean;passed:boolean;tp:number;fp:number;fn:number;categoryErrors:number;report:EditorialReview;calls:ModelObservation[]};

async function main() {
  if (!flag("provider-env") || !flag("baseline-checkout") || !flag("out")) throw Error("Require --provider-env, --baseline-checkout and --out");
  const env = parseEnv(readFileSync(flag("provider-env")!,"utf8"));
  for (const key of Object.keys(process.env)) if (/ANTHROPIC|OPENAI|DATAFORSEO|STRIPE|RESEND|SUPABASE|E2E_STUBS/.test(key)) delete process.env[key];
  for (const key of ["ANTHROPIC_API_KEY","ANTHROPIC_MODEL","ANTHROPIC_MODEL_STRUCTURED","ANTHROPIC_MODEL_EDITORIAL"]) if (env[key]) process.env[key]=env[key];
  if (!process.env.ANTHROPIC_API_KEY) throw Error("Missing model credential");
  const {anthropicModel} = await import("@/lib/ai/models");
  const {withModelObserver} = await import("@/lib/keyword-research/buyer-model");
  const current = await import("@/lib/content/approved-output");
  const baseline = await import(pathToFileURL(resolve(flag("baseline-checkout")!,"apps/web/lib/content/approved-output.ts")).href) as typeof current;
  const models = {structured:anthropicModel("structured"),editorial:anthropicModel("editorial")};
  if (process.argv.includes("--topics")) {
    const {checkEditorialTask}=await import("@/lib/keyword-research/editorial-task");
    const fixtures=JSON.parse(readFileSync(resolve("evals/onboarding/topics.json"),"utf8")) as {labelOrigin:string;cases:Array<{id:string;businessEvidence:string;query:string;serpTitle:string;expectedSupported:boolean;focus?:{primaryBuyer:string;priorityOffering:string};proposedAudience?:string}>};
    const out=resolve(flag("out")!);mkdirSync(out,{recursive:true});
    const results:unknown[]=[];
    for(let repeat=0;repeat<2;repeat++)for(const c of fixtures.cases.filter(c=>!flag("case-prefix")||c.id.startsWith(flag("case-prefix")!))){
      const calls:ModelObservation[]=[];
      const proposed={results:[],buyer:{relevant:true,reason:"Proposal under test"},product:{supported:true,quote:c.businessEvidence,reason:"Proposal under test"},editorial:{achievable:true,reason:"Proposal under test"},audience:c.proposedAudience??"The business's buyers",buyingJob:c.query,offering:"The business offering",angle:c.serpTitle,conversionPath:"https://business.example"};
      const prediction=await withModelObserver(event=>calls.push(event),()=>checkEditorialTask(c.query,[{title:c.serpTitle,description:c.serpTitle,domain:"search.example",url:"https://search.example/guide",rank:1,wordCount:null}],proposed,undefined,c.businessEvidence,flag("topic-tier")==="editorial"?"editorial":"structured",c.focus),{includeResponse:true});
      const passed=prediction.status!=="unavailable"&&(prediction.status==="supported")===c.expectedSupported;
      results.push({id:c.id,repeat,expectedSupported:c.expectedSupported,prediction,passed,calls});
      writeFileSync(`${out}/results.json`,JSON.stringify({scope:fixtures.labelOrigin,models,results},null,2)+"\n");
      console.log(c.id,repeat,prediction.status,passed?"pass":"FAIL");
    }
    return;
  }
  const fixture = JSON.parse(readFileSync(resolve("evals/onboarding/claims.json"),"utf8")) as {labelOrigin:string;cases:ClaimCase[]};
  const split = flag("split") ?? "development";
  if (!["development","holdout"].includes(split)) throw Error("Invalid split");
  const cases = fixture.cases.filter(c=>c.split===split&&(!flag("case-prefix")||c.id.startsWith(flag("case-prefix")!)));
  const repeats = Number(flag("repeats") ?? 2);
  if (!Number.isInteger(repeats) || repeats<1 || repeats>3) throw Error("Repeats must be 1–3");
  const variants = (flag("variants") ?? "baseline,model,prompt,combined").split(",");
  if (variants.some(v=>!["baseline","model","prompt","combined"].includes(v))) throw Error("Unknown variant");
  const out = resolve(flag("out")!); mkdirSync(out,{recursive:true});
  const results:Result[]=[];
  const save = () => writeFileSync(`${out}/results.json`,JSON.stringify({labelOrigin:fixture.labelOrigin,scope:"Synthetic passage regression; not full-draft, discovery, human or conversion evaluation. Model variant changes model only; combined also uses editorial deadline. Fixtures were never sent with labels.",models,results,summary:variants.map(variant=>{
    const rows=results.filter(r=>r.variant===variant); const sum=(key:"tp"|"fp"|"fn")=>rows.reduce((n,r)=>n+r[key],0);
    const calls=rows.flatMap(r=>r.calls);
    return {variant,total:rows.length,passed:rows.filter(r=>r.passed).length,unavailable:rows.filter(r=>!r.checked).length,tp:sum("tp"),fp:sum("fp"),fn:sum("fn"),categoryErrors:rows.reduce((n,r)=>n+r.categoryErrors,0),costUsd:calls.reduce((n,c)=>n+(c.costUsd??0),0),meanCallMs:calls.length?calls.reduce((n,c)=>n+c.elapsedMs,0)/calls.length:null};
  })},null,2)+"\n");
  for (const variant of variants) {
    process.env.ANTHROPIC_MODEL_STRUCTURED = variant==="model" ? models.editorial : models.structured;
    const jobs=Array.from({length:repeats},(_,repeat)=>cases.map(c=>({c,repeat}))).flat();
    for (let start=0;start<jobs.length;start+=2) await Promise.all(jobs.slice(start,start+2).map(async({c,repeat})=>{
      const calls:ModelObservation[]=[];
      const reviewer=variant==="baseline"||variant==="model" ? baseline : current;
      const result=await withModelObserver(event=>calls.push(event),()=>reviewer.reviewApprovedOutput(c.html,{brief:c.brief,evidence:c.sources,tier:variant==="prompt"?"structured":"editorial"}));
      const findings=result.report.findings;
      const matches=(finding:EditorialReview["findings"][number],expected:ClaimCase["expectedIssues"][number]) => finding.text.includes(expected.fragment);
      const tp=c.expectedIssues.filter(expected=>findings.some(f=>matches(f,expected))).length;
      const fp=findings.filter(f=>!c.expectedIssues.some(expected=>matches(f,expected))).length;
      const fn=c.expectedIssues.length-tp;
      const categoryErrors=findings.filter(f=>c.expectedIssues.some(e=>matches(f,e)&&f.category!==e.category)).length;
      const checked=result.report.status==="checked";
      results.push({id:c.id,split,variant,repeat,checked,passed:checked&&fp===0&&fn===0,tp,fp,fn,categoryErrors,report:result.report,calls});save();
      console.log(variant,c.id,repeat,checked?`tp=${tp} fp=${fp} fn=${fn}`:"unavailable");
    }));
  }
  console.log("Saved",`${out}/results.json`);
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Evaluation failed");process.exitCode=1;});

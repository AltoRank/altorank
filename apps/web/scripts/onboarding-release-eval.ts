#!/usr/bin/env tsx
/** Fresh-cohort component lifecycle evaluation with real providers and a local DB.
 * --cohort=/path/cases.json --provider-env=/path --local-env=/path --out=/path
 * --validate-only checks frozen inputs without credentials, DB or provider calls.
 * This is NOT a browser, authenticated-route, gate, checkout or first-month test.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OnboardingEvent, OnboardingPlanned } from "@/lib/onboarding/events";
import type { ModelObservation } from "@/lib/keyword-research/buyer-model";

type Case = {
  id: string; domain: string; language: string; locationCode: number;
  expected: "feasible" | "sparse"; expectationReason: string;
  split: "regression" | "holdout" | "control";
  focus?: {primaryBuyer:string;priorityOffering:string};
};
type CaseReport = Case & {startedAt:string;outcome:string;[key:string]:unknown};
const flag = (name:string) => process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const scope = "Fresh component lifecycle: infer/confirm focus, production discovery worker, durable source-preparation queue and worker, first ready choice, cached source-verified generator, local run/calendar persistence and free quota. Workers are called sequentially by CLI; no browser, authenticated HTTP routes, gate, checkout, trial activation, dashboard rendering, first-month continuation, email, images or publication. Saved output still requires separate quality assessment.";
const checked = <T extends {error:{message:string}|null}>(result:T):T => {if(result.error)throw Error(result.error.message);return result;};
const saveJson = (file:string,value:unknown) => writeFileSync(file,JSON.stringify(value,null,2)+"\n",{mode:0o600});

function casesFromInput(): {labelOrigin:string;cases:Case[];inputHash:string;selectedPrefix:string|null} {
  const single = !flag("cohort");
  if(single && (!flag("domain")||!flag("expected")||!flag("label-reason")))throw Error("Use --cohort, or --domain with --expected=feasible|sparse and --label-reason fixed before the run.");
  const input = single ? JSON.stringify({labelOrigin:"Operator supplied before execution",cases:[{
    id:flag("domain")!.replace(/[^a-zA-Z0-9_-]/g,"-"),domain:flag("domain"),language:flag("language")??"en",
    locationCode:Number(flag("location-code")??(flag("language")==="it"?2380:2840)),
    expected:flag("expected"),expectationReason:flag("label-reason"),split:flag("split")??"regression",
  }]}) : readFileSync(resolve(flag("cohort")!),"utf8");
  const parsed = JSON.parse(input);
  if(!parsed||typeof parsed.labelOrigin!=="string"||!parsed.labelOrigin.trim()||!Array.isArray(parsed.cases)||!parsed.cases.length)throw Error("Cohort needs labelOrigin and a nonempty cases array.");
  const ids = new Set<string>();
  for(const item of parsed.cases){
    if(!item||typeof item.id!=="string"||!/^[a-zA-Z0-9_-]{1,80}$/.test(item.id)||ids.has(item.id))throw Error("Case IDs must be unique safe directory names.");
    ids.add(item.id);
    if(typeof item.domain!=="string"||!item.domain.includes(".")||/[\s/:?#@]/.test(item.domain))throw Error(`Invalid bare domain for ${item.id}`);
    if(typeof item.language!=="string"||!item.language.trim()||!Number.isInteger(item.locationCode))throw Error(`Explicit language/locationCode required for ${item.id}`);
    if(!["feasible","sparse"].includes(item.expected)||typeof item.expectationReason!=="string"||!item.expectationReason.trim()||!["regression","holdout","control"].includes(item.split))throw Error(`Pre-run expectation, reason and split required for ${item.id}`);
    if(item.focus && (typeof item.focus.primaryBuyer!=="string"||!item.focus.primaryBuyer.trim()||typeof item.focus.priorityOffering!=="string"||!item.focus.priorityOffering.trim()))throw Error(`Invalid confirmed focus for ${item.id}`);
  }
  const selectedPrefix=flag("case-prefix")??null;
  const cases=(parsed.cases as Case[]).filter(item=>!selectedPrefix||item.id.startsWith(selectedPrefix));
  if(!cases.length)throw Error("No cases selected.");
  return {labelOrigin:parsed.labelOrigin,cases,inputHash:createHash("sha256").update(input).digest("hex"),selectedPrefix};
}

async function main() {
  const cohort=casesFromInput();
  if(process.argv.includes("--validate-only")){console.log(JSON.stringify({valid:true,scope,...cohort},null,2));return;}
  for(const key of ["provider-env","local-env","out"])if(!flag(key))throw Error(`Missing --${key}`);
  const out=resolve(flag("out")!);
  if(existsSync(`${out}/cohort-report.json`))throw Error("Output already contains an evaluation; choose a fresh directory to retain every attempt.");
  const provider=parseEnv(readFileSync(flag("provider-env")!,"utf8"));
  const local=parseEnv(readFileSync(flag("local-env")!,"utf8"));
  if(!local.API_URL||!local.SERVICE_ROLE_KEY||!local.ANON_KEY||!["localhost","127.0.0.1"].includes(new URL(local.API_URL).hostname))throw Error("Loopback database credentials required.");
  for(const key of Object.keys(process.env))if(/SUPABASE|ANTHROPIC|OPENAI|DATAFORSEO|STRIPE|RESEND|YOUTUBE|E2E_STUBS|SIMULAT|CRON_SECRET|NEXT_PUBLIC_APP_URL/i.test(key))delete process.env[key];
  for(const key of ["ANTHROPIC_API_KEY","ANTHROPIC_MODEL","ANTHROPIC_MODEL_STRUCTURED","ANTHROPIC_MODEL_EDITORIAL","DATAFORSEO_LOGIN","DATAFORSEO_PASSWORD","DATAFORSEO_API_KEY"])if(provider[key])process.env[key]=provider[key];
  Object.assign(process.env,{NEXT_PUBLIC_SUPABASE_URL:local.API_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY:local.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:local.SERVICE_ROLE_KEY,
    // Only activates the application's cloud free-quota branch. There is no
    // usable Stripe credential and this harness makes no Stripe API calls.
    STRIPE_SECRET_KEY:"sk_test_nonfunctional_onboarding_eval_fixture"});
  if(!process.env.ANTHROPIC_API_KEY||!(process.env.DATAFORSEO_API_KEY||(process.env.DATAFORSEO_LOGIN&&process.env.DATAFORSEO_PASSWORD)))throw Error("Real model and search credentials required.");
  const {createClient}=await import("@supabase/supabase-js");
  const db=createClient(local.API_URL,local.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
  // Fail on missing migrations before creating evaluation accounts.
  checked(await db.from("draft_preparations").select("workspace_id").limit(0));
  checked(await db.from("onboarding_choice_checks").select("run_id").limit(0));
  mkdirSync(out,{recursive:true,mode:0o700});
  let revision="unknown",dirty=true;
  try{revision=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();dirty=Boolean(execFileSync("git",["status","--porcelain"],{encoding:"utf8"}).trim());}catch{/* Explicitly unknown provenance. */}
  const results:CaseReport[]=[];
  const startedAt=new Date().toISOString();
  const saveCohort=()=>saveJson(`${out}/cohort-report.json`,{scope,startedAt,updatedAt:new Date().toISOString(),revision,dirty,...cohort,results,
    summary:{plannedCases:cohort.cases.length,startedCases:results.length,completedCases:results.filter(r=>r.finishedAt).length,
      savedFirstDrafts:results.filter(r=>r.outcome==="draft-ready").length,feasibleStarts:results.filter(r=>r.expected==="feasible").length,
      feasibleSavedFirstDrafts:results.filter(r=>r.expected==="feasible"&&r.outcome==="draft-ready").length,
      sparseStarts:results.filter(r=>r.expected==="sparse").length,withheldAfterSelection:results.filter(r=>r.outcome==="withheld").length,
      noReadyChoices:results.filter(r=>r.outcome==="no-ready-topics").length,noQualifiedChoices:results.filter(r=>r.outcome==="no-qualified-topics").length,
      harnessErrors:results.filter(r=>r.outcome==="error").length,humanQualityAssessment:"not-assessed",
      totalKnownLedgerCostUsd:results.reduce((sum,r)=>sum+Number((r.spendSummary as {knownCostUsd?:number}|undefined)?.knownCostUsd??0),0),
      casesWithUnknownLedger:results.filter(r=>r.spend===null||r.spend===undefined).length,
      note:"Mechanical completion counts are not useful-draft quality rates. All starts, sparse controls, withheld outputs and errors remain in the denominator; inspect splits separately."}});
  saveCohort();
  for(const item of cohort.cases){
    const result:CaseReport={...item,startedAt:new Date().toISOString(),outcome:"running",scope};results.push(result);saveCohort();
    await evaluateCase(db,item,result,`${out}/${item.id}`,saveCohort);
    saveCohort();
  }
  console.log("COMPLETE",`${out}/cohort-report.json`);
  if(results.some(result=>result.outcome==="error"))process.exitCode=1;
}

async function evaluateCase(db:SupabaseClient,item:Case,report:CaseReport,out:string,saveCohort:()=>void):Promise<void> {
  mkdirSync(out,{recursive:true,mode:0o700});
  const save=()=>{saveJson(`${out}/report.json`,report);saveCohort();};
  const observations:Array<ModelObservation&{stage:string}>=[];
  const stages:Array<{name:string;startedAt:string;seconds?:number;status:string;error?:string}>=[];
  report.stages=stages;
  let stage="setup";
  const timed=async<T>(name:string,work:()=>Promise<T>):Promise<T>=>{
    stage=name;const started=Date.now();const row:{name:string;startedAt:string;seconds?:number;status:string;error?:string}={name,startedAt:new Date(started).toISOString(),status:"running"};stages.push(row);save();
    try{const result=await work();row.status="complete";return result;}catch(error){row.status="failed";row.error=error instanceof Error?error.message:String(error);throw error;}finally{row.seconds=(Date.now()-started)/1000;save();}
  };
  const {withModelObserver}=await import("@/lib/keyword-research/buyer-model");
  const {DraftReadinessError}=await import("@/lib/content/draft-readiness");
  const {getQuota}=await import("@/lib/billing/quota");
  const accountId=randomUUID(),workspaceId=randomUUID();
  report.accountId=accountId;report.workspaceId=workspaceId;
  try{
    await withModelObserver(event=>observations.push({...event,stage}),async()=>{
      const {inferBusinessProfileDetailed}=await import("@/lib/onboarding/business-profile");
      const {createWorkerClient}=await import("@/lib/onboarding/worker-client");
      const {executeRun}=await import("@/lib/onboarding/run-worker");
      const {runOnboarding}=await import("@/lib/onboarding/pipeline");
      const {startRun,stampRun}=await import("@/lib/onboarding/run-store");
      const {wakeChoicePreparation}=await import("@/lib/onboarding/choice-preparation");
      const {loadDraftPreparation}=await import("@/lib/content/draft-preparation");
      const {generateArticle}=await import("@/lib/content/generate");
      const {fulfilPlannedEntry}=await import("@/lib/onboarding/plan");
      checked(await db.from("accounts").insert({id:accountId,name:"Local onboarding cohort evaluation",slug:`cohort-${accountId}`}));
      checked(await db.from("workspaces").insert({id:workspaceId,account_id:accountId,name:item.domain,domain:item.domain,status:"setup",language:item.language,location_code:item.locationCode,ai_provider:"claude",auto_generate_weekly_limit:7}));
      report.quotaBefore=await getQuota(db,accountId,null);save();
      const inferred=await timed("focus",()=>inferBusinessProfileDetailed(item.domain,{supabase:db,workspaceId}));
      report.inference=inferred;
      if(!inferred.profile){report.outcome="needs-focus";return;}
      const profile={...inferred.profile,...item.focus};report.confirmedProfile=profile;
      report.focusSelection=item.focus?"Predeclared simulated user focus":"Automatically accepted inferred focus";
      if(!profile.primaryBuyer||!profile.priorityOffering){report.outcome="needs-focus";return;}
      checked(await db.from("workspaces").update({business_profile:profile}).eq("id",workspaceId));
      const {runId}=await startRun(db,{id:workspaceId,account_id:accountId});report.runId=runId;
      const events:OnboardingEvent[]=[];report.events=events;
      const discovery=await timed("discovery",()=>executeRun(runId,{
        run:(client,workspace,emit,options)=>runOnboarding(client,workspace,event=>{events.push(event);emit(event);save();},options),
        // Exercise the production queue, then invoke its worker as a separate
        // measured stage with a fresh production budget, as hosted dispatch does.
        wakeChoices:async()=>undefined,
      }));
      await discovery.keepAlive;
      report.discoveryOutcome=discovery.outcome;
      report.candidates=checked(await db.from("keywords").select("id,term,volume,difficulty,opportunity,research_evidence").eq("workspace_id",workspaceId)).data;
      if(discovery.outcome!=="preparing-choices"){
        report.outcome=discovery.outcome==="ran"?"no-qualified-topics":"error";return;
      }
      await timed("source-preparation",()=>wakeChoicePreparation(createWorkerClient(Date.now()+285_000),runId));
      const run=checked(await db.from("onboarding_runs").select("status,planned,phases").eq("workspace_id",workspaceId).eq("id",runId).single()).data!;
      const choices=(run.planned??[]) as OnboardingPlanned[];report.readyChoices=choices;
      report.timeToReadyChoicesSeconds=(Date.now()-Date.parse(report.startedAt))/1000;
      if(run.status!=="awaiting_choice"||!choices.length){report.outcome="no-ready-topics";return;}
      const selected=choices[0];report.selected=selected;
      if(!selected.keywordId||!selected.preparation)throw Error("Worker exposed a choice without source preparation.");
      const keyword=checked(await db.from("keywords").select("opportunity,instructions,plan_excluded_at").eq("workspace_id",workspaceId).eq("id",selected.keywordId).single()).data!;
      const prepared=await loadDraftPreparation(db,{workspaceId,keywordId:selected.keywordId,keyword:selected.term,brief:keyword.opportunity,profile,domain:item.domain,language:item.language,locationCode:item.locationCode,instructions:keyword.instructions});
      if(keyword.plan_excluded_at||prepared?.status!=="ready"||prepared.context!==selected.preparation.context||prepared.createdAt!==selected.preparation.checkedAt)throw Error("The selected source packet is missing, stale or changed.");
      report.selectedPreparationContext=prepared.context;
      report.selectedPreparationCreatedAt=prepared.createdAt;
      const choiceStarted=Date.now();
      const claimed=checked(await db.from("onboarding_runs").update({status:"running",updated_at:new Date().toISOString()}).eq("workspace_id",workspaceId).eq("id",runId).eq("status","awaiting_choice").select("id"));
      if(!claimed.data?.length)throw Error("Choice run changed before generation.");
      await timed("voice-and-links",async()=>{
        const {readSiteText}=await import("@/lib/onboarding/site-text");
        const {trainVoiceProfile}=await import("@/lib/voice/train");
        const {detectLinks}=await import("@/lib/linking/detect");
        const outcomes=await Promise.allSettled([readSiteText(item.domain).then(read=>read.text.length>=250?trainVoiceProfile(db,workspaceId,read.text):undefined),detectLinks(db,workspaceId)]);
        report.voiceAndLinks=outcomes.map(result=>({status:result.status,...(result.status==="rejected"?{reason:String(result.reason)}:{})}));
      });
      try{
        const draft=await timed("selected-draft",()=>generateArticle({supabase:db,workspaceId,keyword:selected.term,keywordId:selected.keywordId,autonomous:true,verifySourceClaims:true,expectedPreparationContext:prepared.context,expectedPreparationCreatedAt:prepared.createdAt,callerEmail:null}));
        const entry=checked(await db.from("calendar_entries").select("id").eq("workspace_id",workspaceId).eq("keyword_id",selected.keywordId).is("article_id",null).maybeSingle()).data;
        if(entry)await fulfilPlannedEntry(db,entry.id,draft.articleId);
        await stampRun(db,runId,{phase:"drafting",status:"done",detail:`Wrote ${draft.wordCount} words for review.`},{finish:true,article:{id:draft.articleId,title:draft.title,keyword:selected.term,wordCount:draft.wordCount,verdict:draft.factCheck.verdict}});
        report.outcome="draft-ready";report.articleId=draft.articleId;report.title=draft.title;report.wordCount=draft.wordCount;
        saveJson(`${out}/selected-preparation.json`,prepared);
        writeFileSync(`${out}/article.html`,draft.html,{mode:0o600});
      }catch(error){
        await stampRun(db,runId,{phase:"drafting",status:"failed",detail:error instanceof Error?error.message:"Evaluation draft failed"},{finish:true,retryChoice:error instanceof DraftReadinessError});
        throw error;
      }finally{report.choiceToDraftSeconds=(Date.now()-choiceStarted)/1000;}
    },{includeResponse:true});
  }catch(error){
    report.outcome=error instanceof DraftReadinessError?"withheld":"error";
    report.reason=error instanceof DraftReadinessError?error.reason:error instanceof Error?error.message:String(error);
    if(error instanceof DraftReadinessError&&error.candidateHtml)writeFileSync(`${out}/withheld-candidate.html`,error.candidateHtml,{mode:0o600});
  }finally{
    report.finishedAt=new Date().toISOString();report.totalSeconds=(Date.now()-Date.parse(report.startedAt))/1000;
    const receipts=[
      ["spend",()=>db.from("provider_spend").select("provider,operation,cost_usd,created_at").eq("workspace_id",workspaceId)],
      ["articles",()=>db.from("articles").select("id,status,title,content,word_count,research").eq("workspace_id",workspaceId)],
      ["preparations",()=>db.from("draft_preparations").select("keyword_id,payload").eq("workspace_id",workspaceId)],
      ["choiceChecks",()=>db.from("onboarding_choice_checks").select("status,attempts,results,candidates").eq("workspace_id",workspaceId)],
      ["runs",()=>db.from("onboarding_runs").select("id,status,planned,phases,article_id").eq("workspace_id",workspaceId)],
      ["account",()=>db.from("accounts").select("free_drafts_used").eq("id",accountId).maybeSingle()],
    ] as const;
    report.receiptErrors=[];
    for(const [name,read] of receipts){try{report[name]=checked(await read()).data;}catch(error){report[name]=null;(report.receiptErrors as string[]).push(`${name}: ${error instanceof Error?error.message:String(error)}`);}}
    try{report.quotaAfter=await getQuota(db,accountId,null);}catch{report.quotaAfter=null;}
    const spend=report.spend as Array<{cost_usd:number|null}>|null;
    report.spendSummary=spend?{rows:spend.length,knownCostUsd:spend.reduce((sum,row)=>sum+(row.cost_usd??0),0),unknownCostRows:spend.filter(row=>row.cost_usd===null).length}:null;
    report.accountingLimit="Provider ledger preserves recorded costs; failed requests may have unreported charges. Structured-model observations are a separate diagnostic subset, never added to ledger cost.";
    saveJson(`${out}/model-observations.json`,observations);save();
    console.log("CASE",item.id,item.expected,report.outcome,report.totalSeconds);
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Evaluation failed");process.exitCode=1;});

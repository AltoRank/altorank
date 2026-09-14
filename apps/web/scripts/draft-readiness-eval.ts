/** Real provider replay on an isolated LOCAL free account. Discovery is reused;
 * no Stripe API, email, publication or production database is involved. */
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {parseEnv} from "node:util";
import {randomUUID} from "node:crypto";
async function main() {
  const [providerPath,localPath,inputPath,out]=process.argv.slice(2);
  const provider=parseEnv(readFileSync(providerPath,"utf8")),local=parseEnv(readFileSync(localPath,"utf8"));
  if(!local.API_URL||!local.SERVICE_ROLE_KEY||!local.ANON_KEY||!["localhost","127.0.0.1"].includes(new URL(local.API_URL).hostname))throw Error("Loopback credentials required");
  for(const key of Object.keys(process.env))if(/ANTHROPIC|OPENAI|DATAFORSEO|STRIPE|RESEND|SUPABASE|E2E_STUBS|SIMULAT/.test(key))delete process.env[key];
  for(const key of ["ANTHROPIC_API_KEY","ANTHROPIC_MODEL","ANTHROPIC_MODEL_STRUCTURED","ANTHROPIC_MODEL_EDITORIAL","DATAFORSEO_LOGIN","DATAFORSEO_PASSWORD","DATAFORSEO_API_KEY"])if(provider[key])process.env[key]=provider[key];
  Object.assign(process.env,{NEXT_PUBLIC_SUPABASE_URL:local.API_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY:local.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:local.SERVICE_ROLE_KEY,STRIPE_SECRET_KEY:"sk_test_nonfunctional_readiness_fixture"});
  const {createClient}=await import("@supabase/supabase-js");
  const {generateArticle}=await import("@/lib/content/generate");
  const {DraftReadinessError}=await import("@/lib/content/draft-readiness");
  const {getQuota}=await import("@/lib/billing/quota");
  const {withModelObserver}=await import("@/lib/keyword-research/buyer-model");
  const db=createClient(local.API_URL,local.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
  const checked=<T extends {error:{message:string}|null}>(r:T):T=>{if(r.error)throw Error(r.error.message);return r;};
  const input=JSON.parse(readFileSync(inputPath,"utf8"));
  const source=checked(await db.from("workspaces").select("name,domain,language,ai_provider,ai_model,brand_style,location_code,business_profile").eq("id",input.workspaceId).single()).data!;
  const keyword=checked(await db.from("keywords").select("*").eq("workspace_id",input.workspaceId).eq("id",input.selected.keywordId).single()).data!;
  const accountId=randomUUID(),workspaceId=randomUUID(),keywordId=randomUUID();
  checked(await db.from("accounts").insert({id:accountId,name:"Local draft readiness evaluation",slug:`readiness-${accountId}`}));
  checked(await db.from("workspaces").insert({...source,id:workspaceId,account_id:accountId,status:"setup"}));
  const {created_at,updated_at,...copied}=keyword;void created_at;void updated_at;
  checked(await db.from("keywords").insert({...copied,id:keywordId,workspace_id:workspaceId}));
  const voice=checked(await db.from("voice_profiles").select("rules").eq("workspace_id",input.workspaceId).maybeSingle()).data;
  if(voice)checked(await db.from("voice_profiles").insert({...voice,workspace_id:workspaceId}));
  mkdirSync(out,{recursive:true});
  const report:Record<string,unknown>={domain:source.domain,workspaceId,accountId,selected:{...input.selected,keywordId},scope:"Real generation on an isolated local free account, reusing discovery and voice; not a full new onboarding or checkout."};
  report.quotaBefore=await getQuota(db,accountId,null);
  const observations:unknown[]=[];const started=Date.now();
  try {
    const draft=await withModelObserver(e=>observations.push(e),()=>generateArticle({supabase:db,workspaceId,keywordId,keyword:keyword.term,autonomous:true,verifySourceClaims:true,callerEmail:null}),{includeResponse:true});
    report.outcome="ready";report.articleId=draft.articleId;
    writeFileSync(`${out}/article.html`,draft.html,{mode:0o600});
  } catch(error) {
    report.outcome=error instanceof DraftReadinessError ? "withheld" : "error";
    report.reason=error instanceof DraftReadinessError ? error.reason : error instanceof Error ? error.message : "unknown";
    if(error instanceof DraftReadinessError && error.candidateHtml)writeFileSync(`${out}/withheld-candidate.html`,error.candidateHtml,{mode:0o600});
  } finally {
    report.seconds=(Date.now()-started)/1000;report.quotaAfter=await getQuota(db,accountId,null);
    report.articles=checked(await db.from("articles").select("id,status,content,word_count,research").eq("workspace_id",workspaceId)).data;
    report.account=checked(await db.from("accounts").select("free_drafts_used").eq("id",accountId).single()).data;
    writeFileSync(`${out}/report.json`,JSON.stringify(report,null,2),{mode:0o600});
    writeFileSync(`${out}/model-observations.json`,JSON.stringify(observations,null,2),{mode:0o600});
  }
  console.log(source.domain,report.outcome,report.reason??"",report.seconds);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

/** Local saved-output experiment: bounded correction plus a fresh claim check. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {parseEnv} from 'node:util';
async function main(){
 const [envPath,inputPath,out]=process.argv.slice(2),env=parseEnv(readFileSync(envPath,'utf8'));
 for(const key of Object.keys(process.env))if(/ANTHROPIC|OPENAI|DATAFORSEO|STRIPE|RESEND|SUPABASE|E2E_STUBS/.test(key))delete process.env[key];
 for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_MODEL','ANTHROPIC_MODEL_EDITORIAL'])if(env[key])process.env[key]=env[key];
 const input=JSON.parse(readFileSync(inputPath,'utf8')),article=input.article;
 const html=readFileSync(inputPath.replace(/report.json$/,'article.html'),'utf8');
 const {reviseApprovedOutput}=await import('@/lib/content/approved-output');
 const {verifyDraftClaims}=await import('@/lib/content/claim-verification');
 const {attachClaimVerification}=await import('@/lib/content/first-draft-review');
 const {ResearchBudget,withResearchBudget}=await import('@/lib/seo/request-context');
 const started=Date.now();
 const result=await withResearchBudget(new ResearchBudget(12,95000),async()=>{
  const revised=await reviseApprovedOutput({html,report:article.research.editorialReview},{title:article.title,brief:input.selected.brief??{angle:article.title},evidence:article.research.draftSources});
  if(revised.report.revision==='accepted')revised.report=attachClaimVerification(revised.report,await verifyDraftClaims(revised.html,{evidence:article.research.draftSources,brief:input.selected.brief??{angle:article.title}}));
  return revised;
 });
 mkdirSync(out,{recursive:true});writeFileSync(`${out}/article.html`,result.html,{mode:0o600});writeFileSync(`${out}/report.json`,JSON.stringify({seconds:(Date.now()-started)/1000,...result},null,2),{mode:0o600});
 console.log(result.report.revision,result.report.revisionReason,result.report.status,result.report.findings.filter(f=>!f.removed&&f.severity==='material').length,(Date.now()-started)/1000);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

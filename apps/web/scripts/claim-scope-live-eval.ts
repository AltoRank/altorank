import {readFileSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
async function main(){
 const env=parseEnv(readFileSync(process.argv[2],'utf8'));
 for(const key of Object.keys(process.env))if(/ANTHROPIC|OPENAI|DATAFORSEO|STRIPE|RESEND|SUPABASE|E2E_STUBS/.test(key))delete process.env[key];
 for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_MODEL','ANTHROPIC_MODEL_STRUCTURED','ANTHROPIC_MODEL_EDITORIAL'])if(env[key])process.env[key]=env[key];
 const {verifyDraftClaims}=await import('@/lib/content/claim-verification');
 const html='<p>This guide compares three tools and then works through a hypothetical example.</p><p>Suppose your team has six people and handles 600 conversations a month.</p><p>For example, attach a logo to a task called Finalize brand assets.</p><p>Acme Essentials costs $95 per month and includes unlimited AI conversations.</p><p>Using Acme guarantees that nobody ever asks where a file is again.</p><p>Acme Essentials includes ten seats.</p>';
 const evidence=[{url:'https://vendor.test/pricing',title:'Controlled vendor fixture',headings:[],text:'Acme Essentials costs $95 per month. It includes ten seats and 100 AI conversations per month. Additional AI conversations cost extra. Files may be attached to tasks.'}];
 const results=await Promise.all(Array.from({length:3},async(_,i)=>{
  const verification=await verifyDraftClaims(html,{evidence});
  const flagged=verification.claims.filter(c=>c.verdict==='unsupported'||c.verdict==='contradicted');
  const checks={allChecked:verification.checkedPassages.length===6,noScopeFalseWarnings:!flagged.some(c=>c.passageIndex<3),falseLimitCaught:flagged.some(c=>c.passageIndex===3),guaranteeCaught:flagged.some(c=>c.passageIndex===4),supportedLimitNotFlagged:!flagged.some(c=>c.passageIndex===5)};
  return {run:i+1,checks,verification};
 }));
 writeFileSync(process.argv[3],JSON.stringify({scope:'Three repetitions of evaluator-authored paired controls. Synthetic source, real model. Not an independent holdout.',results},null,2));
 console.log(JSON.stringify(results.map(({run,checks})=>({run,checks}))));
 if(results.some(r=>Object.values(r.checks).some(v=>!v)))process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

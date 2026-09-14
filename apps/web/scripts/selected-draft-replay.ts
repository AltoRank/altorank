/** Local-only production generator replay, preserving the saved topic choice. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {parseEnv} from 'node:util';
async function main(){
 const [providerPath,localPath,inputPath,out]=process.argv.slice(2);
 const env=parseEnv(readFileSync(providerPath,'utf8')),local=parseEnv(readFileSync(localPath,'utf8'));
 if(!local.API_URL||!local.SERVICE_ROLE_KEY||!local.ANON_KEY||!['localhost','127.0.0.1'].includes(new URL(local.API_URL).hostname))throw Error('Loopback database credentials required');
 for(const key of Object.keys(process.env))if(/ANTHROPIC|OPENAI|DATAFORSEO|STRIPE|RESEND|SUPABASE|E2E_STUBS|SIMULAT/.test(key))delete process.env[key];
 for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_MODEL','ANTHROPIC_MODEL_STRUCTURED','ANTHROPIC_MODEL_EDITORIAL','DATAFORSEO_LOGIN','DATAFORSEO_PASSWORD','DATAFORSEO_API_KEY'])if(env[key])process.env[key]=env[key];
 process.env.NEXT_PUBLIC_SUPABASE_URL=local.API_URL;process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY=local.ANON_KEY;process.env.SUPABASE_SERVICE_ROLE_KEY=local.SERVICE_ROLE_KEY;
 const input=JSON.parse(readFileSync(inputPath,'utf8'));
 const {createClient}=await import('@supabase/supabase-js');
 const {generateArticle}=await import('@/lib/content/generate');
 const db=createClient(local.API_URL,local.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
 const workspace=await db.from('workspaces').select('account_id').eq('id',input.workspaceId).single();if(workspace.error)throw workspace.error;
 const {withModelObserver}=await import('@/lib/keyword-research/buyer-model');
 const observations:unknown[]=[];mkdirSync(out,{recursive:true});
 const started=Date.now();
 try {
 const draft=await withModelObserver(event=>observations.push(event),()=>generateArticle({supabase:db,workspaceId:input.workspaceId,keyword:input.selected.term,keywordId:input.selected.keywordId,autonomous:true,verifySourceClaims:true,billToAccountId:workspace.data.account_id}),{includeResponse:true});
 const article=await db.from('articles').select('*').eq('workspace_id',input.workspaceId).eq('id',draft.articleId).single();if(article.error)throw article.error;
 mkdirSync(out,{recursive:true});writeFileSync(`${out}/article.html`,draft.html,{mode:0o600});
 writeFileSync(`${out}/report.json`,JSON.stringify({scope:'Development replay of the same selected topic through production generateArticle. Fresh generation, reused discovery and voice. Not a new onboarding or checkout.',domain:input.domain,workspaceId:input.workspaceId,selected:input.selected,seconds:(Date.now()-started)/1000,article:article.data},null,2),{mode:0o600});
 console.log(input.domain,draft.wordCount,(Date.now()-started)/1000);
 } finally {writeFileSync(`${out}/model-observations.json`,JSON.stringify(observations,null,2),{mode:0o600});}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

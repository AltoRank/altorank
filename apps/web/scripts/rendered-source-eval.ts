import {readFileSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
async function main(){
 const [envPath,url,out]=process.argv.slice(2),env=parseEnv(readFileSync(envPath,'utf8'));
 for(const key of Object.keys(process.env))if(/DATAFORSEO|STRIPE|SUPABASE|E2E_STUBS/.test(key))delete process.env[key];
 for(const key of ['DATAFORSEO_LOGIN','DATAFORSEO_PASSWORD','DATAFORSEO_API_KEY'])if(env[key])process.env[key]=env[key];
 const {assertPublicUrl}=await import('@/lib/audit/lenient-fetch');assertPublicUrl(url);
 const {post}=await import('@/lib/seo/client');
 const response=await post('/on_page/instant_pages',[{url,enable_javascript:true,enable_browser_rendering:true,enable_xhr:true,accept_language:'en-US',custom_js:'({url:location.href,title:document.title,text:(document.querySelector("main")||document.body).innerText.slice(0,16000)})'}]);
 writeFileSync(out,JSON.stringify(response,null,2),{mode:0o600});
 console.log('Saved rendered source response');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

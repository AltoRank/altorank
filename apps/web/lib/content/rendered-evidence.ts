import {assertPublicUrl} from "@/lib/audit/lenient-fetch";
import {hasDataForSEOCredentials,post} from "@/lib/seo/client";
import {ResearchBudget,currentResearchBudget,withResearchBudget} from "@/lib/seo/request-context";
import type {PageExtract} from "@/lib/keyword-research/page-evidence";

/** Re-read at most two observed pricing pages whose static response omitted
 * prices. A single shared deadline; failures retain the original evidence. */
export async function recoverRenderedPricing(sources:PageExtract[]):Promise<PageExtract[]> {
  if(!hasDataForSEOCredentials())return sources;
  const candidates=sources.filter(s=>{
    try{return /\/(?:pricing|plans)(?:[/-]|$)/i.test(new URL(s.url).pathname)&&!/[\$€£]\s*\d|\d\s*(?:USD|EUR|GBP)/i.test(s.text);}catch{return false;}
  }).slice(0,2);
  if(!candidates.length)return sources;
  const recovered=await withResearchBudget(currentResearchBudget()??new ResearchBudget(2,20000),()=>Promise.all(candidates.map(async source=>{
    try {
      assertPublicUrl(source.url);
      const result=await post<{items?:Array<{status_code?:number;custom_js_response?:{url?:string;title?:string;text?:string}}>}>('/on_page/instant_pages',[{
        url:source.url,enable_javascript:true,enable_browser_rendering:true,enable_xhr:true,
        custom_js:'var root=(document.querySelector("main")||document.body).cloneNode(true); root.querySelectorAll("script,style,noscript").forEach(el=>el.remove()); root.querySelectorAll("h1,h2,h3,h4,p,div,section,li,td,th,br").forEach(el=>el.appendChild(document.createTextNode("\\n"))); ({url:location.href,title:document.title,text:root.textContent.slice(0,12000)})',
      }]);
      const item=result.tasks?.[0]?.result?.[0]?.items?.[0],data=item?.custom_js_response;
      if(item?.status_code!==200||!data||typeof data.text!=="string"||data.text.trim().length<120||typeof data.url!=="string")return source;
      assertPublicUrl(data.url);
      return {...source,provenance:"rendered" as const,resolvedUrl:data.url,title:typeof data.title==="string"?data.title.slice(0,300):source.title,text:data.text.slice(0,9000)};
    } catch{return source;}
  })));
  const byUrl=new Map(recovered.map(s=>[s.url,s]));
  return sources.map(s=>byUrl.get(s.url)??s);
}

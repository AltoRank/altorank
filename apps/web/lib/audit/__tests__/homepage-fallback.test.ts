import {afterEach,expect,it,vi} from "vitest";
import {fetchSite,recoverWwwHomepage} from "../lenient-fetch";
import {crawlSite} from "../crawler";
afterEach(()=>vi.unstubAllGlobals());
const html=(url:string,body:string,status=200)=>{
  const response=new Response(body,{status,headers:{"content-type":"text/html"}});
  Object.defineProperty(response,"url",{value:url});return response;
};
it("uses the working www homepage and resolves its relative crawl links on that host",async()=>{
  const fetch=vi.fn(async(url:string)=>url==="https://brand.test/"?html(url,"Missing",404):url==="https://www.brand.test/"?html(url,'<h1>Email marketing</h1><a href="/features">Features</a>'):html(url,"<h1>Campaign features</h1>"));
  vi.stubGlobal("fetch",fetch);
  const pages=await crawlSite("https://brand.test/",2,1,0);
  expect(pages.map(p=>[p.url,p.status,p.h1])).toEqual([["https://www.brand.test/",200,["Email marketing"]],["https://www.brand.test/features",200,["Campaign features"]]]);
  expect(fetch.mock.calls.map(c=>c[0])).toEqual(["https://brand.test/","https://www.brand.test/","https://www.brand.test/features"]);
});
it("keeps the caller deadline and records the retrieved URL without changing default audit fetches",async()=>{
  const fetch=vi.fn(async(url:string)=>html(url,url.includes("www.")?"Readable homepage":"Missing",url.includes("www.")?200:404));
  vi.stubGlobal("fetch",fetch);const signal=AbortSignal.timeout(1000);
  expect((await fetchSite("https://brand.test/",{signal})).status).toBe(404);
  const response=await fetchSite("https://brand.test/",{signal,homepageFallback:true});
  expect(response.url).toBe("https://www.brand.test/");
  expect(fetch.mock.calls).toHaveLength(3);
  expect(fetch).toHaveBeenLastCalledWith("https://www.brand.test/",expect.objectContaining({signal}));
});
it.each(["https://brand.test/missing-article","https://brand.test/?page=2","https://www.brand.test/","http://127.0.0.1/","https://user:password@brand.test/"])("does not reinterpret a missing page or unsafe host: %s",async url=>{
  const request=vi.fn();const original=new Response("Missing",{status:404});
  expect(await recoverWwwHomepage(url,original,request)).toBe(original);expect(request).not.toHaveBeenCalled();
});
it("does not turn refusal, a failed alternate or an unrelated redirect into success",async()=>{
  const request=vi.fn().mockResolvedValue(new Response("Denied",{status:403}));
  const original=new Response("Missing",{status:404});
  expect(await recoverWwwHomepage("https://brand.test/",original,request)).toBe(original);expect(await original.text()).toBe("Missing");
  const refused=new Response("Denied",{status:403});request.mockClear();
  expect(await recoverWwwHomepage("https://brand.test/",refused,request)).toBe(refused);expect(request).not.toHaveBeenCalled();
  const missing=new Response("Missing",{status:404});request.mockResolvedValue(html("https://unrelated.test/","Other site"));
  expect(await recoverWwwHomepage("https://brand.test/",missing,request)).toBe(missing);
});

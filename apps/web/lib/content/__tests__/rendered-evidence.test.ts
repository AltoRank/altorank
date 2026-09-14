import {beforeEach,expect,it,vi} from "vitest";
const {post,available}=vi.hoisted(()=>({post:vi.fn(),available:vi.fn()}));
vi.mock("@/lib/seo/client",()=>({post,hasDataForSEOCredentials:available}));
import {recoverRenderedPricing} from "../rendered-evidence";
const source={url:"https://vendor.test/pricing",title:"Plans",headings:[],text:"Starter includes campaigns. Standard includes automation. ".repeat(3)};
beforeEach(()=>{post.mockReset();available.mockReturnValue(true);});
it("recovers missing prices with two bounded public render reads, preserving provenance",async()=>{
 post.mockImplementation(async(_endpoint,body)=>({tasks:[{result:[{items:[{status_code:200,custom_js_response:{url:body[0].url,title:"Rendered plans",text:"Starter costs $9 per month. Standard costs $18 per month. ".repeat(3)}}]}]}]}));
 const result=await recoverRenderedPricing([source,{...source,url:"https://other.test/pricing"},{...source,url:"https://third.test/pricing"}]);
 expect(post).toHaveBeenCalledTimes(2);expect(result[0]).toMatchObject({provenance:"rendered",resolvedUrl:source.url});expect(result[2]).toEqual({...source,url:"https://third.test/pricing"});
});
it("retains static evidence on failed rendering and never pays for already-observed prices",async()=>{
 post.mockRejectedValue(new Error("timeout"));expect(await recoverRenderedPricing([source])).toEqual([source]);
 post.mockClear();const priced={...source,text:"Starter costs $9 monthly."};expect(await recoverRenderedPricing([priced])).toEqual([priced]);expect(post).not.toHaveBeenCalled();
});
it("rejects private pages and malformed renderer output",async()=>{
 await recoverRenderedPricing([{...source,url:"http://127.0.0.1/pricing"}]);expect(post).not.toHaveBeenCalled();
 post.mockResolvedValue({tasks:[{result:[{items:[{status_code:200,custom_js_response:{url:"http://127.0.0.1/pricing",text:source.text}}]}]}]});
 expect(await recoverRenderedPricing([source])).toEqual([source]);
});

import {beforeEach,expect,it,vi} from "vitest";
const {fetch}=vi.hoisted(()=>({fetch:vi.fn()}));
vi.mock("@/lib/audit/lenient-fetch",()=>({fetchSite:fetch}));
import {readPageExtract} from "../page-evidence";
beforeEach(()=>vi.resetAllMocks());
it("reads useful body evidence beyond large scripts and retains observed navigation pricing links",async()=>{
  const body="Collective scheduling checks participants' availability. ".repeat(8);
  fetch.mockResolvedValue(new Response(`<html><head><title>Calendar</title><script>${"x".repeat(800000)}</script></head><body><nav><a href="/pricing">Pricing</a><a href="/login">Login</a></nav><main><h1>Team calendar</h1><p>${body}</p></main><footer>Unrelated footer</footer></body></html>`));
  const result=await readPageExtract("https://calendar.test",9000,{includeLinks:true});
  expect(result?.text).toContain(body.trim());expect(result?.text).not.toContain("Unrelated footer");
  expect(result?.links).toEqual([{url:"https://calendar.test/pricing",label:"Pricing"}]);
});
it("keeps failed or insufficient retrieval unknown",async()=>{
  fetch.mockResolvedValue(new Response("not found",{status:404}));expect(await readPageExtract("https://calendar.test/missing")).toBeNull();
  fetch.mockResolvedValue(new Response("<main>short</main>"));expect(await readPageExtract("https://calendar.test")).toBeNull();
});
it("retains pricing after a large product menu while keeping eighty candidates",async()=>{
  const menu=Array.from({length:100},(_,i)=>`<a href="/feature-${i}">Feature ${i}</a>`).join("");
  fetch.mockResolvedValue(new Response(`<nav>${menu}<a href="/pricing">Pricing</a></nav><main><p>${"Product capabilities. ".repeat(20)}</p></main>`));
  const page=await readPageExtract("https://vendor.test/",9000,{includeLinks:true});
  expect(page?.links).toHaveLength(80);expect(page?.links?.[0]).toEqual({url:"https://vendor.test/pricing",label:"Pricing"});
});
it("retains article vendor references ahead of a large navigation menu",async()=>{
  const menu=Array.from({length:450},(_,i)=>`<a href="/feature-${i}">Feature ${i}</a>`).join("");
  fetch.mockResolvedValue(new Response(`<nav>${menu}<a href="/pricing">Pricing</a></nav><main><p>${"Compare the vendors on the same criteria. ".repeat(20)}</p><a href="https://other-vendor.test/">Other vendor</a></main>`));
  const page=await readPageExtract("https://publisher.test/",9000,{includeLinks:true});
  expect(page?.links).toContainEqual({url:"https://other-vendor.test/",label:"Other vendor"});
  expect(page?.links?.length).toBeLessThanOrEqual(80);
});
it("does not treat a binary document as readable source evidence",async()=>{
  fetch.mockResolvedValue(new Response("%PDF-1.7 " + "binary bytes ".repeat(100),{headers:{"content-type":"application/pdf"}}));
  expect(await readPageExtract("https://vendor.test/manual.pdf")).toBeNull();
  fetch.mockResolvedValue(new Response("%PDF-1.7 " + "binary bytes ".repeat(100)));
  expect(await readPageExtract("https://vendor.test/manual")).toBeNull();
});

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

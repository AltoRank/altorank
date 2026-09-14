import { afterEach, expect, it, vi } from "vitest";
import { crawlSite } from "../crawler";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("does not start another crawl request after the caller's deadline", async () => {
  const transport = vi.fn();
  vi.stubGlobal("fetch", transport);
  expect(await crawlSite("https://deadline.example",3,2,0,{deadline:Date.now()-1})).toEqual([]);
  expect(transport).not.toHaveBeenCalled();
});

it("keeps cancellation active when headers arrive but the page body stalls", async () => {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal,"timeout").mockReturnValue(controller.signal);
  let reading!: () => void;
  const bodyStarted = new Promise<void>(resolve => { reading=resolve; });
  vi.stubGlobal("fetch",vi.fn(async (_input, init) => ({
    status:200, headers:new Headers({"content-type":"text/html"}), url:"https://deadline.example",
    text:() => new Promise<string>((_resolve,reject) => {
      reading();
      init.signal.addEventListener("abort",() => reject(init.signal.reason),{once:true});
    }),
  })));
  const crawl = crawlSite("https://deadline.example",1,0,0,{deadline:Date.now()+500});
  await bodyStarted;
  controller.abort(new DOMException("expired","TimeoutError"));
  expect(await crawl).toEqual([expect.objectContaining({status:0,error:expect.stringContaining("timed out")})]);
  expect(timeout.mock.calls[0][0]).toBeLessThanOrEqual(500);
});

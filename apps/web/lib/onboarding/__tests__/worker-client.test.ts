import { afterEach, expect, it, vi } from "vitest";
import { createWorkerClient, deadlineFetch } from "../worker-client";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("does not send a database request after the absolute deadline", async () => {
  const transport = vi.fn();
  await expect(deadlineFetch(Date.now() - 1, transport)("https://db.example/rest/v1/keywords")).rejects.toMatchObject({name:"TimeoutError"});
  expect(transport).not.toHaveBeenCalled();
});

it("bounds the real service client table and RPC transport without losing scope or auth", async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://db.example");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-service-key");
  const calls: Array<{url:string;init:RequestInit}> = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    calls.push({url:String(input),init});
    return new Response("[]", {headers:{"content-type":"application/json"}});
  }));
  const timers = vi.spyOn(AbortSignal, "timeout");
  const db = createWorkerClient(Date.now() + 5_000);
  await db.from("keywords").select("id").eq("workspace_id", "workspace-one");
  await db.rpc("claim_onboarding_choices", {p_run:"run-one"});
  expect(calls).toHaveLength(2);
  expect(calls[0].url).toContain("workspace_id=eq.workspace-one");
  expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer fixture-service-key");
  expect(calls[1].url).toContain("rpc/claim_onboarding_choices");
  expect(JSON.parse(calls[1].init.body as string)).toEqual({p_run:"run-one"});
  expect(calls.every(call => call.init.signal instanceof AbortSignal)).toBe(true);
  expect(timers.mock.calls.every(([ms]) => ms > 0 && ms <= 5_000)).toBe(true);
});

it("cancels in-flight transport for either its deadline or the caller signal", async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal,"timeout").mockReturnValue(deadline.signal);
  const transport = vi.fn(async (_input, init) => new Promise<Response>((_resolve,reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), {once:true});
  }));
  const caller = new AbortController();
  const pending = deadlineFetch(Date.now()+60_000,transport)(new Request("https://db.example",{signal:caller.signal}));
  const failed = expect(pending).rejects.toMatchObject({name:"AbortError"});
  caller.abort();
  await failed;
  const another = deadlineFetch(Date.now()+60_000,transport)("https://db.example");
  const timed = expect(another).rejects.toMatchObject({name:"TimeoutError"});
  deadline.abort(new DOMException("expired","TimeoutError"));
  await timed;
  expect(AbortSignal.timeout).toHaveBeenCalledWith(15_000);
});

it("preserves cancellation supplied in init and sends no already-aborted request", async () => {
  const transport = vi.fn();
  const caller = new AbortController();
  caller.abort();
  await expect(deadlineFetch(Date.now()+60_000,transport)("https://db.example",{signal:caller.signal})).rejects.toMatchObject({name:"AbortError"});
  expect(transport).not.toHaveBeenCalled();
});

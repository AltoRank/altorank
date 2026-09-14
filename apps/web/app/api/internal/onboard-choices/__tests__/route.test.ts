import { beforeEach, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({rpc:vi.fn(),prepare:vi.fn(),client:vi.fn(),deferred:[] as Array<()=>Promise<void>>}));
vi.mock("@/lib/onboarding/worker-client",()=>({createWorkerClient:(deadline:number)=>{mocks.client(deadline);return {rpc:mocks.rpc};}}));
vi.mock("@/lib/onboarding/choice-preparation",()=>({prepareOnboardingChoices:mocks.prepare}));
vi.mock("next/server",async original=>({...await original<object>(),after:(fn:()=>Promise<void>)=>mocks.deferred.push(fn)}));
import { POST } from "../route";
const runId="11111111-1111-4111-8111-111111111111";
const request=(body:unknown,secret="fixture-secret")=>new Request("https://app.test/api/internal/onboard-choices",{method:"POST",headers:{"content-type":"application/json","x-cron-secret":secret},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();mocks.deferred.length=0;process.env.CRON_SECRET="fixture-secret";mocks.rpc.mockResolvedValue({data:"lease-token",error:null});mocks.prepare.mockResolvedValue(undefined);});
it("authenticates before claiming and validates the run id",async()=>{
  expect((await POST(request({runId},"wrong"))).status).toBe(401);
  expect((await POST(request({runId:"invalid"}))).status).toBe(400);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("returns 202 after a durable claim and holds source work in the invocation",async()=>{
  const response=await POST(request({runId}));
  expect(response.status).toBe(202);expect(await response.json()).toEqual({status:"accepted"});
  expect(mocks.rpc).toHaveBeenCalledWith("claim_onboarding_choices",{p_run:runId});
  expect(mocks.prepare).not.toHaveBeenCalled();
  await mocks.deferred[0]();
  expect(mocks.prepare).toHaveBeenCalledWith({rpc:mocks.rpc},runId,"lease-token",{deadline:expect.any(Number)});
});
it("does not start another provider worker when the claim is already owned",async()=>{
  mocks.rpc.mockResolvedValue({data:null,error:null});
  expect((await POST(request({runId}))).status).toBe(202);
  expect(mocks.deferred).toHaveLength(0);
});
it("reports a failed claim without starting source work",async()=>{
  mocks.rpc.mockResolvedValue({data:null,error:{message:"database down"}});
  expect((await POST(request({runId}))).status).toBe(500);
  expect(mocks.deferred).toHaveLength(0);
});


it("gives each source invocation a fresh deadline that includes its claim", async()=>{
  let now=1_000;
  const clock=vi.spyOn(Date,"now").mockImplementation(()=>now);
  try {
    await POST(request({runId}));
    now+=45_000;
    await mocks.deferred[0]();
    expect(mocks.client).toHaveBeenLastCalledWith(286_000);
    expect(mocks.prepare).toHaveBeenLastCalledWith({rpc:mocks.rpc},runId,"lease-token",{deadline:181_000});
    now=301_000;
    await POST(request({runId}));
    expect(mocks.client).toHaveBeenLastCalledWith(586_000);
    await mocks.deferred[1]();
    expect(mocks.prepare).toHaveBeenLastCalledWith({rpc:mocks.rpc},runId,"lease-token",{deadline:481_000});
  } finally { clock.mockRestore(); }
});

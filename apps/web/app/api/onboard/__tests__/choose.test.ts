import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeDb, asUser, type FakeDb } from "@/lib/onboarding/__tests__/fake-runs-client";
let db: FakeDb;
let user: {id:string} | null;
const afters: Array<() => Promise<void>> = [];
const generate = vi.fn(); const fulfil = vi.fn();
vi.mock("@/lib/supabase/server", () => ({createClient:async () => asUser(db,user),createServiceClient:() => db.client}));
vi.mock("@/lib/workspace-scope", () => ({getScopedWorkspaceId:async () => "ws1"}));
vi.mock("next/server", async () => ({...await vi.importActual<typeof import("next/server")>("next/server"),after:(fn:() => Promise<void>) => afters.push(fn)}));
vi.mock("@/lib/content/fan-out", () => ({canSelfInvoke:() => false,dispatchFirstDraft:vi.fn()}));
vi.mock("@/lib/content/generate", () => ({generateArticle:(...args:unknown[]) => generate(...args)}));
vi.mock("@/lib/onboarding/plan", () => ({fulfilPlannedEntry:(...args:unknown[]) => fulfil(...args)}));
vi.mock("@/lib/voice/train", () => ({trainVoiceProfile:async () => undefined}));
vi.mock("@/lib/onboarding/site-text", () => ({readSiteText:async () => ({text:""})}));
vi.mock("@/lib/linking/detect", () => ({detectLinks:async () => undefined}));
import {POST} from "../choose/route";
const request = (body:unknown) => new NextRequest("http://localhost/api/onboard/choose", {method:"POST",body:JSON.stringify(body)});
const choice = {workspaceId:"ws1",runId:"r1",keywordId:"k1"};
beforeEach(() => {
  user={id:"u1"}; afters.length=0; generate.mockReset(); fulfil.mockReset();
  generate.mockResolvedValue({articleId:"a1",title:"Approved headline",wordCount:1000,factCheck:{verdict:"review"}});
  db=fakeDb({workspaces:[{id:"ws1",domain:"example.com",account_id:"ac1"}],onboarding_runs:[{id:"r1",workspace_id:"ws1",status:"awaiting_choice",phases:[],planned:[{term:"buyer task",keywordId:"k1",brief:{status:"qualified",angle:"Approved headline",reason:"Supported"}}]}],calendar_entries:[{id:"c1",workspace_id:"ws1",keyword_id:"k1",article_id:null}]});
});
it("claims one saved choice and attaches the generated article to its calendar entry", async () => {
  expect((await POST(request(choice))).status).toBe(200);
  expect((await POST(request(choice))).status).toBe(409);
  expect(afters).toHaveLength(1); expect(generate).not.toHaveBeenCalled();
  await afters[0]();
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate).toHaveBeenCalledWith(expect.objectContaining({workspaceId:"ws1",verifySourceClaims:true}));
  expect(fulfil).toHaveBeenCalledWith(db.client,"c1","a1");
  expect(db.tables.onboarding_runs[0]).toMatchObject({status:"done",article_id:"a1"});
  expect(db.tables.workspaces[0].onboarded_at).toBeTruthy();
});
it("refuses unsigned callers, another workspace and invented topics before claiming a run", async () => {
  user=null; expect((await POST(request(choice))).status).toBe(401); user={id:"u1"};
  expect((await POST(request({...choice,workspaceId:"ws2"}))).status).toBe(400);
  expect((await POST(request({...choice,keywordId:"not-in-plan"}))).status).toBe(400);
  db.tables.onboarding_runs[0].workspace_id="ws2";
  expect((await POST(request(choice))).status).toBe(404);
  expect(afters).toHaveLength(0);
});
it("allows focus refinement without drafting or marking setup complete", async () => {
  expect((await POST(request({...choice,refine:true}))).status).toBe(200);
  expect(db.tables.onboarding_runs[0]).toMatchObject({status:"partial",finished_at:null});
  expect(afters).toHaveLength(0); expect(db.tables.workspaces[0].onboarded_at).toBeUndefined();
});
it("preserves the saved plan and reports draft failures without completing setup", async () => {
  generate.mockRejectedValue(new Error("Draft allowance exhausted"));
  await POST(request(choice)); await afters[0]();
  expect(db.tables.onboarding_runs[0].planned).toHaveLength(1);
  expect(db.tables.onboarding_runs[0].phases).toContainEqual(expect.objectContaining({phase:"drafting",status:"failed"}));
  expect(db.tables.workspaces[0].onboarded_at).toBeUndefined();
});

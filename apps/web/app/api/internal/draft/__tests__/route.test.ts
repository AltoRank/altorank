import {beforeEach,expect,it,vi} from "vitest";
import {NextRequest} from "next/server";
import {fakeDb,type FakeDb} from "@/lib/onboarding/__tests__/fake-runs-client";
let db:FakeDb;
const mocks=vi.hoisted(()=>({generate:vi.fn(),fulfil:vi.fn(),stamp:vi.fn()}));
vi.mock("@/lib/supabase/server",()=>({createServiceClient:()=>db.client}));
vi.mock("@/lib/content/generate",()=>({generateArticle:mocks.generate}));
vi.mock("@/lib/billing/quota",()=>({getQuota:async()=>({limit:10,remaining:10}),quotaExceededMessage:()=>"Quota exhausted"}));
vi.mock("@/lib/onboarding/plan",()=>({fulfilPlannedEntry:mocks.fulfil}));
vi.mock("@/lib/onboarding/run-store",()=>({stampRun:mocks.stamp}));
import {POST} from "../route";
import {dispatchFirstDraft} from "@/lib/content/fan-out";
beforeEach(()=>{
  vi.clearAllMocks();process.env.CRON_SECRET="fixture-secret";
  db=fakeDb({workspaces:[{id:"ws1",account_id:"ac1"}],calendar_entries:[{id:"c1",workspace_id:"ws1",keyword_id:"k1",article_id:null}]});
  mocks.generate.mockResolvedValue({articleId:"a1",title:"Approved article",wordCount:900,factCheck:{verdict:"review"}});
});
it("preserves the selected packet receipt across dispatch serialization and the internal route",async()=>{
  const body={workspaceId:"ws1",runId:"r1",keywordId:"k1",keyword:"buyer task",expectedPreparationContext:"a".repeat(64),expectedPreparationCreatedAt:"2026-09-14T10:00:00.000Z"};
  const sent=dispatchFirstDraft(body,{baseUrl:"https://app.test",secret:"fixture-secret",fetchImpl:async(url,init)=>POST(new NextRequest(String(url),{...init,signal:init?.signal??undefined}))});
  expect("request" in sent).toBe(true);
  if("request" in sent)expect((await sent.request).status).toBe(200);
  expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({workspaceId:"ws1",keywordId:"k1",verifySourceClaims:true,expectedPreparationContext:body.expectedPreparationContext,expectedPreparationCreatedAt:body.expectedPreparationCreatedAt}));
  expect(mocks.fulfil).toHaveBeenCalledWith(db.client,"c1","a1");
});

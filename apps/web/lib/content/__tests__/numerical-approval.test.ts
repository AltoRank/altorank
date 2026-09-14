import { beforeEach, expect, it, vi } from "vitest";
import { fakeDb, type FakeDb } from "@/lib/onboarding/__tests__/fake-runs-client";
import { factCheckArticle } from "@/lib/ai/fact-check";
import { htmlToTiptapJson } from "@/lib/ai/tiptap";
import { tiptapToHtml } from "@/lib/cms/html";
import { CLAIM_COVERAGE_VERSION, claimPassages, claimSentences, type ClaimVerification } from "../claim-verification";
import { bindSavedNumericalReview, reconcileReviewedNumbers } from "../numerical-review";
let db:FakeDb;
const notify=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/supabase/server",()=>({createClient:async()=>db.client}));
vi.mock("@/lib/auth/require-auth",()=>({requireAuth:async()=>({user:{id:"u1",email:"test@example.test"},accountId:"ac1"})}));
vi.mock("@/lib/billing/quota",()=>({needsPlanToShip:async()=>false,CHOOSE_PLAN_MESSAGE:"Choose a plan",getQuota:async()=>({reason:"plan"})}));
vi.mock("@/lib/email/approval-events",()=>({announceDraftApproved:notify}));
vi.mock("next/cache",()=>({revalidatePath:()=>undefined}));
vi.mock("@/lib/publishing/destinations",async original=>({...await original<object>(),getDestinations:async()=>[{id:"cms1"}]}));
vi.mock("@/lib/seo/article-audit",()=>({auditArticle:()=>({items:[]})}));
import { approveArticle } from "@/app/actions/publish";
import { runAutoApprovals } from "@/lib/publishing/auto-approve";

const html="<p>Illustrative example: if 3 of 10 tasks are overdue, the overdue share is 30%.</p>";
beforeEach(()=>{
  vi.clearAllMocks();
  const passages=claimPassages(html);
  const sentenceInventory=passages.flatMap((text,passageIndex)=>claimSentences(text).map(sentence=>({...sentence,passageIndex})));
  const claims:ClaimVerification={coverageVersion:CLAIM_COVERAGE_VERSION,status:"checked",totalPassages:passages.length,checkedPassages:passages.map((_,i)=>i),sentenceInventory,sentenceCoverage:sentenceInventory.map(sentence=>({passageIndex:sentence.passageIndex,sentenceIndex:sentence.sentenceIndex,claimIds:[],nonFactualReason:"Explicit hypothetical inputs and arithmetic."})),claims:[],sources:[],failures:[],modelCalls:[]};
  const content=htmlToTiptapJson(html);
  const factChecks=reconcileReviewedNumbers(html,factCheckArticle(html),claims);
  bindSavedNumericalReview(factChecks,tiptapToHtml(content as unknown as Record<string,unknown>),claims);
  db=fakeDb({
    workspaces:[{id:"ws1",account_id:"ac1",domain:"example.test",status:"on",auto_approve:true,auto_approve_hold_hours:24,auto_approve_min_seo:70,auto_approve_min_aeo:null,auto_approve_set_by:"u1"}],
    account_members:[{account_id:"ac1",user_id:"u1"}],
    articles:[{id:"a1",workspace_id:"ws1",status:"review",held_by:null,auto_approve_after:"2026-09-01T00:00:00Z",created_at:"2026-09-01T00:00:00Z",seo_score:85,content,research:{competitors:[],editorialReview:{claimVerification:claims}},fact_checks:factChecks}],
  });
});
it.each(["human","automatic"])("%s approval reuses only the identical reviewed nonfactual example",async caller=>{
  if(caller==="human")await approveArticle("a1");
  else expect(await runAutoApprovals(db.client,new Date("2026-09-14T00:00:00Z"))).toMatchObject([{articleId:"a1",outcome:"approved"}]);
  expect(db.tables.articles[0].status).toBe(caller==="human"?"approved":"scheduled");
  expect(db.tables.articles[0].fact_checks).toMatchObject({verdict:"clean",claims:[{status:"not_factual"}]});
});
it.each(["human","automatic"])("%s approval retains the numerical block after current content changes",async caller=>{
  db.tables.articles[0].content=htmlToTiptapJson(html+"<p>Acme saves 80%.</p>");
  if(caller==="human")await expect(approveArticle("a1")).rejects.toThrow("source");
  else expect(await runAutoApprovals(db.client,new Date("2026-09-14T00:00:00Z"))).toMatchObject([{articleId:"a1",outcome:"held"}]);
  expect(db.tables.articles[0].status).toBe("review");
  expect(db.tables.articles[0].fact_checks).toMatchObject({verdict:"high_risk"});
  expect(notify).not.toHaveBeenCalled();
});
it.each(["human","automatic"])("%s approval does not trust a previous numerical status without current complete semantic review",async caller=>{
  db.tables.articles[0].research={competitors:[]};
  if(caller==="human")await expect(approveArticle("a1")).rejects.toThrow("source");
  else expect(await runAutoApprovals(db.client,new Date("2026-09-14T00:00:00Z"))).toMatchObject([{articleId:"a1",outcome:"held"}]);
  expect(db.tables.articles[0].status).toBe("review");
  expect(db.tables.articles[0].fact_checks).toMatchObject({verdict:"high_risk"});
});

import {beforeEach,expect,it,vi} from "vitest";
import {fakeDb} from "@/lib/onboarding/__tests__/fake-runs-client";
import {contextKey,OPPORTUNITY_VERSION,type Opportunity} from "@/lib/keyword-research/opportunity";
import {draftPreparationContext,type DraftPreparationInput} from "../draft-preparation";
import {DraftReadinessError} from "../draft-readiness";

const mocks=vi.hoisted(()=>({topic:vi.fn(),write:vi.fn(),research:vi.fn(),collect:vi.fn()}));
vi.mock("@/lib/billing/quota",()=>({getQuota:async()=>({limit:1,used:0,remaining:1,reason:"no-plan"}),quotaExceededMessage:()=>"Quota exhausted"}));
vi.mock("@/lib/billing/default-spend",()=>({spendClient:()=>null}));
vi.mock("@/lib/keyword-research/opportunity",async original=>({...await original<object>(),assertAutonomousTopic:mocks.topic}));
vi.mock("@/lib/seo/research",()=>({gatherArticleResearch:mocks.research}));
vi.mock("@/lib/seo/link-resolver",async original=>({...await original<object>(),fetchLinkTargets:async()=>[]}));
vi.mock("@/lib/ai/provider",()=>({resolveProvider:()=>({streamArticle:mocks.write})}));
vi.mock("../draft-evidence",async original=>({...await original<object>(),collectTaskEvidence:mocks.collect}));
vi.mock("@/lib/e2e/stubs",()=>({e2eStubsEnabled:()=>false,isReservedTestDomain:()=>true,stubGenerateArticle:vi.fn()}));
import {generateArticle} from "../generate";

const profile={primaryBuyer:"Small teams",priorityOffering:"Writing software"};
const brief:Opportunity={version:OPPORTUNITY_VERSION,context:contextKey({domain:"example.test",business:profile,languageCode:"en",locationCode:2840}),checkedAt:"2026-09-14T00:00:00Z",status:"qualified",reason:"Relevant",audience:"Small teams",offering:"Writing software",buyingJob:"Select software",angle:"Compare writing tools",format:"article",evidenceUrls:["https://example.test/help"]};
const input:DraftPreparationInput={workspaceId:"ws1",keywordId:"k1",keyword:"compare writing tools",domain:"example.test",language:"en",locationCode:2840,profile,brief,instructions:null};
beforeEach(()=>{
  vi.clearAllMocks();mocks.topic.mockResolvedValue(brief);
  mocks.write.mockImplementation(()=>{throw new Error("Writer boundary reached");});
  mocks.research.mockResolvedValue({intent:{intent:"informational"},peopleAlsoAsk:[],competitors:[],recommendedWordCount:1000});
});
it.each(["matching-packet","renewed-packet","missing-timestamp"])("enforces the %s receipt before model output or allowance consumption",async(change)=>{
  const createdAt=new Date(Date.now()-1000).toISOString();
  const context=draftPreparationContext(input);const question="How do team reviews work?";const quote="Shared documents support team reviews.";
  const db=fakeDb({
    workspaces:[{id:"ws1",account_id:"ac1",domain:input.domain,language:"en",location_code:2840,business_profile:profile}],
    accounts:[{id:"ac1",free_drafts_used:0}],
    keywords:[{id:"k1",workspace_id:"ws1",term:input.keyword,instructions:null,volume:10,difficulty:5,article_type:"blog",article_subtype:"guide"}],
    draft_preparations:[{workspace_id:"ws1",keyword_id:"k1",payload:{version:1,context,createdAt,expiresAt:new Date(Date.now()+3600000).toISOString(),status:"ready",sources:[{url:brief.evidenceUrls![0],title:"Help",headings:[],text:quote}],plan:{status:"planned",task:"explanation",requirements:[question],selectedUrls:[],retrievedUrls:[]},sourceBrief:{status:"prepared",facts:[{subject:"Example",plan:"",kind:"capability",statement:quote,sourceIndex:0,quote,scopeQuote:quote,url:brief.evidenceUrls![0]}],coverage:[{question,factIndices:[0]}],issues:[],readiness:{status:"checked",questions:[{requirementIndex:0,answered:true,reason:"Direct instructions"}]}}}}],
  });
  const expectedCreatedAt=change==="matching-packet"?createdAt:change==="renewed-packet"?new Date(Date.parse(createdAt)-500).toISOString():undefined;
  const result=await generateArticle({supabase:db.client,workspaceId:"ws1",keywordId:"k1",keyword:input.keyword,autonomous:true,verifySourceClaims:true,expectedPreparationContext:context,expectedPreparationCreatedAt:expectedCreatedAt,callerEmail:null}).catch(error=>error);
  if(change==="matching-packet"){
    expect(result.message).toBe("Writer boundary reached");
    expect(mocks.write).toHaveBeenCalledOnce();
  }else{
    expect(result).toBeInstanceOf(DraftReadinessError);
    expect(result.reason).toBe("incomplete-review");
    expect(mocks.write).not.toHaveBeenCalled();
  }
  expect(mocks.collect).not.toHaveBeenCalled();
  expect(db.tables.accounts[0].free_drafts_used).toBe(0);
  expect(db.tables.articles).toHaveLength(1);
  expect(db.tables.articles[0]).toMatchObject({status:"error"});
  expect(db.tables.articles[0].content).toBeUndefined();
});

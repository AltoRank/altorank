import {beforeEach,expect,it,vi} from "vitest";
import {fakeDb} from "@/lib/onboarding/__tests__/fake-runs-client";
import {contextKey,OPPORTUNITY_VERSION,type Opportunity} from "@/lib/keyword-research/opportunity";
import {DRAFT_PREPARATION_VERSION,draftPreparationContext,type DraftPreparationInput} from "../draft-preparation";
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
it.each(["matching-packet","matching-instructions","renewed-packet","missing-timestamp","global-instructions"])("enforces the %s receipt before model output or allowance consumption",async(change)=>{
  const createdAt=new Date(Date.now()-1000).toISOString();
  const value=change==="matching-instructions"?{...input,globalInstructions:"Always mention the free tier.",instructions:"Compare monthly limits."}:input;
  const context=draftPreparationContext(value);const question="How do team reviews work?";const quote="Shared documents support team reviews.";
  const db=fakeDb({
    workspaces:[{id:"ws1",account_id:"ac1",domain:input.domain,language:"en",location_code:2840,business_profile:profile}],
    accounts:[{id:"ac1",free_drafts_used:0}],
    keywords:[{id:"k1",workspace_id:"ws1",term:input.keyword,instructions:value.instructions,volume:10,difficulty:5,article_type:"blog",article_subtype:"guide"}],
    workspace_output_settings:value.globalInstructions?[{workspace_id:"ws1",global_article_prompt:value.globalInstructions}]:[],
    draft_preparations:[{workspace_id:"ws1",keyword_id:"k1",payload:{version:DRAFT_PREPARATION_VERSION,context,createdAt,expiresAt:new Date(Date.now()+3600000).toISOString(),status:"ready",sources:[{url:brief.evidenceUrls![0],title:"Help",headings:[],text:quote}],plan:{status:"planned",task:"explanation",requirements:[question],selectedUrls:[],retrievedUrls:[],scope:{status:"checked",requirements:[question],omitted:[],promises:[{id:"p0",source:"headline",quote:brief.angle,text:brief.angle,expectedAnswer:"Explain the approved reader task using the quoted evidence.",mappingReason:"The fixture question asks for the approved task.",requirementIndices:[0]}]}},sourceBrief:{status:"prepared",facts:[{subject:"Example",plan:"",kind:"capability",statement:quote,sourceIndex:0,quote,scopeQuote:quote,url:brief.evidenceUrls![0]}],coverage:[{question,factIndices:[0]}],issues:[],readiness:{status:"checked",questions:[{requirementIndex:0,answered:true,reason:"Direct instructions"}],promises:[{promiseId:"p0",answered:true,reason:"The quoted evidence supports the fixture promise."}]}}}}],
  });
  if(change==="global-instructions")db.tables.workspace_output_settings=[{workspace_id:"ws1",global_article_prompt:"Always mention the free tier."}];
  const expectedCreatedAt=change==="missing-timestamp"?undefined:change==="renewed-packet"?new Date(Date.parse(createdAt)-500).toISOString():createdAt;
  const result=await generateArticle({supabase:db.client,workspaceId:"ws1",keywordId:"k1",keyword:input.keyword,autonomous:true,verifySourceClaims:true,expectedPreparationContext:context,expectedPreparationCreatedAt:expectedCreatedAt,callerEmail:null}).catch(error=>error);
  if(change==="matching-packet"||change==="matching-instructions"){
    expect(result.message).toBe("Writer boundary reached");
    expect(mocks.write).toHaveBeenCalledOnce();
    if(change==="matching-instructions"){
      const writerInput=mocks.write.mock.calls[0][0];
      expect(writerInput.firstDraft.instructions).toContain(value.globalInstructions);
      expect(writerInput.firstDraft.instructions).toContain(value.instructions);
      expect(writerInput.firstDraft.brief.instructions).toBe(writerInput.firstDraft.instructions);
    }
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
it("stops before research, writer or allowance use when standing settings cannot be loaded",async()=>{
  const db=fakeDb({workspaces:[{id:"ws1",account_id:"ac1",domain:input.domain,language:"en",location_code:2840,business_profile:profile}],accounts:[{id:"ac1",free_drafts_used:0}]});
  const from=db.client.from.bind(db.client);
  const failed={select:()=>failed,eq:()=>failed,maybeSingle:async()=>({data:null,error:{message:"Unavailable"}})};
  vi.spyOn(db.client,"from").mockImplementation(table=>table==="workspace_output_settings"?failed as never:from(table));
  await expect(generateArticle({supabase:db.client,workspaceId:"ws1",keywordId:"k1",keyword:input.keyword,autonomous:true,verifySourceClaims:true,callerEmail:null})).rejects.toThrow("standing instructions could not be loaded");
  expect(mocks.research).not.toHaveBeenCalled();expect(mocks.collect).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();
  expect(db.tables.accounts[0].free_drafts_used).toBe(0);expect(db.tables.articles).toHaveLength(0);
});

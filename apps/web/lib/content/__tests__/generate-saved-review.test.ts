import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fakeDb } from "@/lib/onboarding/__tests__/fake-runs-client";
import { tiptapToHtml } from "@/lib/cms/html";
import { CLAIM_COVERAGE_VERSION, claimPassages, claimSentences } from "../claim-verification";
import { DraftReadinessError } from "../draft-readiness";
import { enforceApprovedTitle } from "../approved-output";
import { stripTags } from "@/lib/audit/html-utils";
const mocks=vi.hoisted(()=>({topic:vi.fn(),prepare:vi.fn(),review:vi.fn(),convert:vi.fn()}));
const raw='<h1>Unapproved title</h1><table><tr><td>Exports available.<p>Only after administrator approval.</p></td></tr></table><ol><li><p>Confirm the booking.</p></li></ol>';
vi.mock("@/lib/billing/quota",()=>({getQuota:async()=>({limit:1,used:0,remaining:1,reason:"no-plan"}),quotaExceededMessage:()=>"Quota exhausted"}));
vi.mock("@/lib/billing/default-spend",()=>({spendClient:()=>null}));
vi.mock("@/lib/keyword-research/opportunity",async original=>({...await original<object>(),assertAutonomousTopic:mocks.topic}));
vi.mock("@/lib/seo/research",()=>({gatherArticleResearch:async()=>({intent:{intent:"informational"},peopleAlsoAsk:[],competitors:[],recommendedWordCount:1000})}));
vi.mock("@/lib/seo/link-resolver",async original=>({...await original<object>(),fetchLinkTargets:async()=>[],resolveInternalLinks:async(html:string)=>html}));
vi.mock("@/lib/seo/link-check",async original=>({...await original<object>(),verifyOutboundLinks:async(html:string)=>({html,checks:[]})}));
vi.mock("@/lib/linking/targets",()=>({fetchKnownPages:async()=>[]}));
vi.mock("@/lib/ai/video-embedder",()=>({embedYouTubeVideos:async(html:string)=>html}));
vi.mock("@/lib/content/enrich",()=>({enrichArticle:async(html:string)=>({html})}));
vi.mock("@/lib/ai/provider",()=>({resolveProvider:()=>({streamArticle:async function*(){yield "";return {html:raw,title:"Unapproved title",metaDescription:"A source-supported guide.",wordCount:30,tokensUsed:10,inputTokens:5,outputTokens:5};}})}));
vi.mock("../draft-preparation",()=>({prepareDraft:mocks.prepare}));
vi.mock("../first-draft-review",()=>({reviewFirstDraft:mocks.review}));
vi.mock("@/lib/ai/tiptap",async original=>{const actual=await original<typeof import("@/lib/ai/tiptap")>();return {...actual,htmlToTiptapJson:(...args:Parameters<typeof actual.htmlToTiptapJson>)=>{mocks.convert(...args);return actual.htmlToTiptapJson(...args);}};});
vi.mock("@/lib/e2e/stubs",()=>({e2eStubsEnabled:()=>false,isReservedTestDomain:()=>true,stubGenerateArticle:vi.fn()}));
import { generateArticle } from "../generate";
const title="How approvals work";
beforeEach(()=>{
  vi.clearAllMocks();vi.stubEnv("OPENAI_API_KEY","");
  const promise={id:"p0",source:"headline",quote:title,text:title,expectedAnswer:"Explain the approval condition.",mappingReason:"The question asks about approval.",requirementIndices:[0]};
  mocks.topic.mockResolvedValue({status:"qualified",angle:title,audience:"Small teams",buyingJob:"Understand approval",evidenceUrls:["https://example.test/help"]});
  mocks.prepare.mockResolvedValue({context:"prepared",createdAt:new Date().toISOString(),status:"ready",sources:[{url:"https://example.test/help",title:"Help",headings:[],text:"Exports are available only after administrator approval."}],plan:{task:"explanation",status:"planned",requirements:["Which approval is required?"],scope:{status:"checked",promises:[promise]}},sourceBrief:{status:"prepared",facts:[{subject:"Example",plan:"",kind:"capability",statement:"Approval required.",quote:"Exports are available only after administrator approval.",scopeQuote:"",sourceIndex:0,url:"https://example.test/help"}],coverage:[{question:"Which approval is required?",factIndices:[0]}]}});
  mocks.review.mockImplementation(async(html:string,options:{title?:string})=>{
    html=enforceApprovedTitle(html,options.title);
    const passages=claimPassages(html);const sentenceInventory=passages.flatMap((text,passageIndex)=>claimSentences(text).map(s=>({...s,passageIndex})));
    return {html,report:{status:"checked",headline:"preserved",productClaims:"no-issues-detected",qualitativeClaims:"no-issues-detected",structure:"no-issues-detected",findings:[],delivery:{version:1,status:"checked",promises:[{promiseId:"p0",answered:true,passageIndices:[1,2],reason:"The full approval condition is visible."}]},claimVerification:{coverageVersion:CLAIM_COVERAGE_VERSION,status:"checked",sentenceInventory,sentenceCoverage:sentenceInventory.map(s=>({passageIndex:s.passageIndex,sentenceIndex:s.sentenceIndex,claimIds:[],nonFactualReason:"Fixture semantic judgment; this test covers representation identity."})),totalPassages:passages.length,checkedPassages:passages.map((_,i)=>i),claims:[],sources:[],failures:[],modelCalls:[]}}};
  });
});
afterEach(()=>vi.unstubAllEnvs());
it.each([
  {mode:"same-rendering",approvedTitle:title},
  {mode:"same-rendering",approvedTitle:`L'équipe & \"approvals\": what's required?`},
  {mode:"review-mutates-html",approvedTitle:title},
])("saves only the exact rendering reviewed by the final checks: $mode / $approvedTitle",async({mode,approvedTitle})=>{
  const db=fakeDb({workspaces:[{id:"ws1",account_id:"ac1",domain:"example.test",language:"en",location_code:2840,business_profile:{name:"Example",primaryBuyer:"Small teams",priorityOffering:"Writing tools"}}],accounts:[{id:"ac1",free_drafts_used:0}],keywords:[{id:"k1",workspace_id:"ws1",term:"approval steps",instructions:null,volume:10,difficulty:5,article_type:"blog",article_subtype:"guide"}]});
  if(mode==="review-mutates-html"){
    const original=mocks.review.getMockImplementation()!;
    mocks.review.mockImplementation(async(html:string,options:{title?:string})=>({...await original(html,options),html:html.replace("Only after administrator approval.","")}));
  }
  const result=await generateArticle({supabase:db.client,workspaceId:"ws1",keywordId:"k1",keyword:"approval steps",title:approvedTitle,autonomous:true,verifySourceClaims:true,callerEmail:null}).catch(error=>error);
  expect(mocks.convert.mock.calls.length, String(result?.stack ?? result)).toBe(1);
  const reviewedHtml=mocks.review.mock.calls[0][0] as string;
  expect(stripTags(reviewedHtml.match(/<h1[^>]*>[\s\S]*?<\/h1>/i)![0])).toBe(approvedTitle);
  expect(reviewedHtml).toContain("Only after administrator approval.");expect(reviewedHtml).toContain("Confirm the booking.");
  if(mode==="same-rendering"){
    expect(result).not.toBeInstanceOf(Error);
    const saved=tiptapToHtml(db.tables.articles[0].content as Record<string,unknown>);
    expect(saved).toBe(reviewedHtml);expect(result.html).toBe(saved);
    expect(result.research.editorialReview.claimVerification.sentenceInventory.map((s:{text:string})=>s.text)).toEqual(claimPassages(saved).flatMap(text=>claimSentences(text).map(s=>s.text)));
    expect(db.tables.accounts[0].free_drafts_used).toBe(1);
  } else {
    expect(result).toBeInstanceOf(DraftReadinessError);expect(result.reason).toBe("incomplete-review");
    expect(db.tables.articles[0].content).toBeUndefined();expect(db.tables.accounts[0].free_drafts_used).toBe(0);
  }
});

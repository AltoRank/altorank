import {expect,it,vi} from "vitest";
const {review,claims}=vi.hoisted(()=>({review:vi.fn(),claims:vi.fn()}));
vi.mock("../approved-output",()=>({reviewApprovedOutput:review}));
vi.mock("../claim-verification",()=>({verifyDraftClaims:claims}));
import {reviewFirstDraft} from "../first-draft-review";
it("passes the same recovered profile evidence to both first-draft reviewers",async()=>{
  review.mockResolvedValue({html:"<p>Draft</p>",report:{status:"checked",findings:[],productClaims:"no-issues-detected",qualitativeClaims:"no-issues-detected"}});
  claims.mockResolvedValue({status:"checked",claims:[],modelCalls:[]});
  const quote="Every participant's schedule is checked before booking.";
  await reviewFirstDraft("<p>Draft</p>",{evidence:[],profile:{capabilities:[{claim:"Collective scheduling",quote,sourceUrl:"https://cal.test/collective",status:"observed"}]}});
  const evidence=review.mock.calls[0][1].evidence;
  expect(evidence[0]).toMatchObject({url:"https://cal.test/collective",text:quote});
  expect(claims.mock.calls[0][1].evidence).toBe(evidence);
});

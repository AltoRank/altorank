import {beforeEach,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
const {ask}=vi.hoisted(()=>({ask:vi.fn()}));
vi.mock("@/lib/keyword-research/buyer-model",()=>({askStructured:ask,extractJson:(raw:string)=>{try{return JSON.parse(raw);}catch{return null;}}}));
import {checkEvidenceScope,validateEvidenceScope} from "../evidence-scope";

const questions=["How does a customer find nearby salons?","What are the actual steps to book an appointment?","How can a customer cancel, reschedule or pay later?"];
const coverage={complete:true,reason:"Retained questions cover the approved find-and-book task."};
const judged=(essential:boolean[])=>JSON.stringify({coverage,questions:essential.map((value,requirementIndex)=>({requirementIndex,essential:value,reason:value?"Needed for the promised find-and-book task.":"Later appointment management is an adjacent task."}))});
beforeEach(()=>vi.resetAllMocks());

it("retains exact essential questions and records optional additions without rewriting the task",()=>{
  // These are supplied scope judgments, not a live-model quality assessment.
  const result=validateEvidenceScope(judged([true,true,false]),questions);
  expect(result).toEqual({status:"checked",requirements:questions.slice(0,2),omitted:[{question:questions[2],reason:"Later appointment management is an adjacent task."}],coverage});
});

it("orders valid judgments by supplied indices and ignores attempted rewritten question text",()=>{
  const raw=JSON.stringify({coverage,questions:[
    {requirementIndex:1,essential:true,reason:"Central booking steps.",question:"Invent a payment workflow"},
    {requirementIndex:2,essential:false,reason:"Optional management."},
    {requirementIndex:0,essential:true,reason:"Central discovery steps."},
  ]});
  expect(validateEvidenceScope(raw,questions).requirements).toEqual(questions.slice(0,2));
});

it.each([
  null,
  "invalid JSON",
  JSON.stringify({questions:[]}),
  JSON.stringify({questions:[{requirementIndex:0,essential:true,reason:"Only one of three was checked."}]}),
  JSON.stringify({questions:[{requirementIndex:0,essential:true,reason:"First."},{requirementIndex:0,essential:true,reason:"Duplicate."},{requirementIndex:2,essential:false,reason:"Third."}]}),
  JSON.stringify({questions:[{requirementIndex:0,essential:true,reason:"First."},{requirementIndex:1,essential:true,reason:"Second."},{requirementIndex:3,essential:false,reason:"Invented fourth."}]}),
  JSON.stringify({questions:[{requirementIndex:0,essential:true,reason:"First."},{requirementIndex:1,essential:"true",reason:"Not a boolean."},{requirementIndex:2,essential:false,reason:"Third."}]}),
  JSON.stringify({questions:[{requirementIndex:0,essential:true,reason:"First."},{requirementIndex:1,essential:true,reason:" "},{requirementIndex:2,essential:false,reason:"Third."}]}),
  JSON.stringify({questions:[{requirementIndex:0,essential:true,reason:"First."},null,{requirementIndex:2,essential:false,reason:"Third."}]}),
])("does not approve incomplete or invalid scope judgments: %s",raw=>{
  let input=raw;
  try{if(raw)input=JSON.stringify({coverage,...JSON.parse(raw)});}catch{/* Keep malformed JSON unchanged. */}
  expect(validateEvidenceScope(input,questions)).toEqual({status:"unavailable",requirements:[],omitted:[]});
});

it("stops when the reviewer finds none of the supplied questions fulfills the promised task",()=>{
  expect(validateEvidenceScope(judged([false,false,false]),questions)).toMatchObject({status:"unavailable",requirements:[],omitted:[]});
});

it.each([undefined,null,{complete:"true",reason:"Wrong type."},{complete:true,reason:" "}])("requires an explicit central-task coverage judgment: %j",invalid=>{
  const raw=JSON.stringify({...JSON.parse(judged([true,true,false])),coverage:invalid});
  expect(validateEvidenceScope(raw,questions)).toEqual({status:"unavailable",requirements:[],omitted:[]});
});

it("rejects a complete index vector when the reviewer identifies a missing central booking answer",()=>{
  const missing={complete:false,reason:"The find-and-book headline promises booking steps, but only discovery is covered."};
  const raw=JSON.stringify({coverage:missing,questions:[{requirementIndex:0,essential:true,reason:"Discovery is needed, but is only part of the promised task."}]});
  expect(validateEvidenceScope(raw,[questions[0]])).toEqual({status:"unavailable",requirements:[],omitted:[],coverage:missing});
});

it("passes the approved task and all proposed questions to one bounded scope check",async()=>{
  ask.mockResolvedValue(judged([true,true,false]));
  const brief={angle:"Find a salon and book an appointment",buyingJob:"Find and book a treatment",audience:"Salon customers"};
  const spend={supabase:{} as SupabaseClient,workspaceId:"scope-test"};
  const result=await checkEvidenceScope(brief,questions,spend);
  expect(result.requirements).toEqual(questions.slice(0,2));
  expect(ask).toHaveBeenCalledTimes(1);
  expect(ask.mock.calls[0][0]).toBe("article/evidence-scope");
  const payload=JSON.parse(ask.mock.calls[0][1].split("\n").at(-1));
  expect(payload).toEqual({brief,questions:questions.map((question,requirementIndex)=>({requirementIndex,question}))});
  expect(ask.mock.calls[0][2]).toMatchObject({timeoutMs:20000,maxTokens:900,spend});
});

it("keeps a failed scope model call unavailable",async()=>{
  ask.mockResolvedValue(null);
  expect(await checkEvidenceScope({angle:"Book an appointment"},questions)).toEqual({status:"unavailable",requirements:[],omitted:[]});
});

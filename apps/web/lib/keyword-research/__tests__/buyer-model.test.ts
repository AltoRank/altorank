import {afterEach,beforeEach,expect,it,vi} from "vitest";
const {create}=vi.hoisted(()=>({create:vi.fn()}));
vi.mock("@anthropic-ai/sdk",()=>({default:class {messages={create};}}));
import {askStructured,withModelObserver,type ModelObservation} from "../buyer-model";
beforeEach(()=>{create.mockReset();vi.stubEnv("ANTHROPIC_API_KEY","test-only");vi.stubEnv("ANTHROPIC_MODEL_EDITORIAL","editorial-test");});
afterEach(()=>vi.unstubAllEnvs());
it("records truncation without accepting partial JSON",async()=>{
  create.mockResolvedValue({content:[{type:"text",text:'{"findings":[]}'}],stop_reason:"max_tokens",usage:{input_tokens:10,output_tokens:20}});
  const calls:ModelObservation[]=[];
  const result=await askStructured("eval/review","Input",{maxTokens:20,tier:"editorial",observe:event=>calls.push(event)});
  expect(result).toBeNull();expect(calls[0]).toMatchObject({model:"editorial-test",status:"truncated",inputTokens:10,outputTokens:20});
  expect(create.mock.calls[0][0].thinking).toEqual({type:"disabled"});
});
it("includes response text only in an explicitly enabled offline observer",async()=>{
  create.mockResolvedValue({content:[{type:"text",text:'{"ok":true}'}],stop_reason:"end_turn",usage:{input_tokens:10,output_tokens:20}});
  const normal:ModelObservation[]=[];const offline:ModelObservation[]=[];
  await withModelObserver(event=>offline.push(event),()=>askStructured("eval/review","Input",{maxTokens:50,observe:event=>normal.push(event)}),{includeResponse:true});
  expect(normal[0].responseText).toBeUndefined();expect(offline[0].responseText).toBe('{"ok":true}');
});
it("distinguishes a deadline from an empty successful answer",async()=>{
  create.mockRejectedValue(Object.assign(new Error("aborted"),{name:"APIUserAbortError"}));
  const calls:ModelObservation[]=[];
  expect(await askStructured("eval/review","Input",{maxTokens:50,observe:event=>calls.push(event)})).toBeNull();
  expect(calls[0].status).toBe("deadline");
});

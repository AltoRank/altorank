import {beforeEach,expect,it,vi} from "vitest";
const {ask}=vi.hoisted(()=>({ask:vi.fn()}));
vi.mock("@/lib/keyword-research/buyer-model",async original=>({...await original<object>(),askStructured:ask}));
import {distinctOnboardingTopics,topicRepresentatives} from "../distinct-topics";
import type {KeywordRecommendation} from "@/lib/seo/recommendations";
beforeEach(()=>ask.mockReset());
it("keeps the highest-ranked representative of every complete task group",()=>{
  expect(topicRepresentatives('{"groups":[[2,0],[3],[1]]}',4)).toEqual([0,1,3]);
});
it.each(['{"groups":[[0],[0]]}','{"groups":[[0],[2]]}','{"groups":[[0]]}','{"groups":[[],[0,1]]}','{"groups":[[0,1.5]]}','{}','null'])("rejects incomplete or fabricated partitions %s",raw=>{
  expect(topicRepresentatives(raw,2)).toBeNull();
});
const recs=Array.from({length:3},(_,i)=>({keywordId:String(i),term:["scheduling software","calendar booking tools","payment scheduling"][i],action:"write",quality:"ok",opportunity:{status:"qualified",angle:"Compare options",buyingJob:"Choose a scheduling tool"}})) as KeywordRecommendation[];
it("removes variations without changing original eligibility or ranking",async()=>{
  ask.mockResolvedValue('{"groups":[[1,0],[2]]}');
  const result=await distinctOnboardingTopics(recs);
  expect(result).toEqual([recs[0],recs[2]]);expect(recs).toHaveLength(3);
});
it("keeps one qualified option rather than filling a calendar after an unavailable check",async()=>{
  ask.mockResolvedValue(null);
  expect(await distinctOnboardingTopics(recs)).toEqual([recs[0]]);
});
it("never promotes unqualified candidates or pays for a single option",async()=>{
  expect(await distinctOnboardingTopics([{...recs[0],opportunity:undefined}])).toEqual([]);
  expect(await distinctOnboardingTopics([recs[0]])).toEqual([recs[0]]);expect(ask).not.toHaveBeenCalled();
});

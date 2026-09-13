import { beforeEach, expect, it, vi } from "vitest";
const {post} = vi.hoisted(() => ({post:vi.fn()}));
vi.mock("../client",()=>({post}));
import {expandCategory,expandRelated,discoverRankingDomains} from "../discovery-sources";
const locale={languageCode:"it",locationCode:2380};
beforeEach(()=>post.mockReset());
it("preserves minimum volume, valid zero difficulty, provider dates and secondary intent from both Labs shapes",async()=>{
  const item={keyword:"confronto software",keyword_info:{search_volume:10,cpc:0,last_updated_time:"2026-09-01"},keyword_properties:{keyword_difficulty:0},search_intent_info:{main_intent:"commercial",secondary_intents:["informational"]}};
  post.mockResolvedValueOnce({tasks:[{result:[{items:[item]}]}]}).mockResolvedValueOnce({tasks:[{result:[{items:[{keyword_data:item}]}]}]});
  const ideas=await expandCategory(["software aziende"],locale); const related=await expandRelated("software aziende",locale);
  for(const rows of [ideas,related])expect(rows[0]).toMatchObject({volume:10,difficulty:0,evidence:{languageCode:"it",locationCode:2380,metrics:{measuredAt:"2026-09-01",secondaryIntents:["informational"]}}});
  expect(post.mock.calls[0][1][0].filters).toEqual([["keyword_info.search_volume",">=",10]]);
  expect(post.mock.calls[1][1][0].filters).toEqual([["keyword_data.keyword_info.search_volume",">=",10]]);
});
it("uses category SERPs for a new domain and domain overlap when rankings exist",async()=>{
  post.mockResolvedValue({tasks:[{result:[{items:[{domain:"example.com"},{domain:"rival.test"},{domain:"rival.test"}]}]}]});
  expect(await discoverRankingDomains("example.com",["software aziende"],locale,false)).toEqual([{domain:"rival.test",source:"category-serp",keywords:["software aziende"]}]);
  await discoverRankingDomains("example.com",[],locale,true);
  expect(post.mock.calls[0][0]).toContain("serp_competitors"); expect(post.mock.calls[1][0]).toContain("competitors_domain");
});

import { expect, it, vi } from "vitest";
import { fakeDb } from "@/lib/onboarding/__tests__/fake-runs-client";
import { effectiveDraftInstructions, loadGlobalDraftInstructions } from "../draft-instructions";

it("reads only this workspace's standing rules and leaves style settings separate", async () => {
  const db = fakeDb({workspace_output_settings:[
    {workspace_id:"other",global_article_prompt:"Mention another brand."},
    {workspace_id:"ws1",global_article_prompt:"  Always mention the free tier.  ",tone:"playful"},
  ]});
  expect(await loadGlobalDraftInstructions(db.client,"ws1")).toBe("Always mention the free tier.");
  expect(await loadGlobalDraftInstructions(db.client,"missing")).toBeNull();
  expect(effectiveDraftInstructions("Always mention the free tier.","Compare monthly limits.")).toBe("Standing instructions:\nAlways mention the free tier.\n\nArticle instructions:\nCompare monthly limits.");
  expect(effectiveDraftInstructions("  ",null)).toBeNull();
});

it("does not interpret a failed settings read as an empty instruction set", async () => {
  const db = fakeDb();
  const query = {select:()=>query,eq:()=>query,maybeSingle:async()=>({data:null,error:{message:"Unavailable"}})};
  vi.spyOn(db.client,"from").mockReturnValue(query as never);
  await expect(loadGlobalDraftInstructions(db.client,"ws1")).rejects.toThrow("Standing article instructions could not be loaded");
});

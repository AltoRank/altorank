import { describe, it, expect } from "vitest";
import { GET } from "../[slug]/route";

const go = async (slug: string) => {
  const res = await GET(new Request(`https://app.altorank.co/tool-return/${slug}`), { params: Promise.resolve({ slug }) });
  return { status: res.status, location: res.headers.get("location") };
};

describe("GET /tool-return/<slug>", () => {
  it("sends a paid tool's return to its page on altorank.co, asking for one run", async () => {
    expect(await go("seo-title-generator")).toEqual({
      status: 303,
      location: "https://altorank.co/tools/seo-title-generator/?run=1",
    });
    expect((await go("keyword-research")).location).toBe("https://altorank.co/tools/keyword-research/?run=1");
  });

  it.each(["ai-crawler-simulator", "not-a-tool", "..%2F..%2Fevil", "https:evil.com", "UPPER"])(
    "sends anything else (%s) to the tools hub",
    async (slug) => {
      expect((await go(slug)).location).toBe("https://altorank.co/tools/");
    },
  );
});

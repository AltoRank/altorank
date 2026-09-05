import { describe, it, expect, vi } from "vitest";
import { addHowToVideo, isHowToSection } from "../video";
import { ARTICLE, SECTION } from "./fixtures";

const VIDEO = { videoId: "abc123", title: "Set up a CRM <fast>", channelTitle: "Acme TV", thumbnailUrl: "" };

describe("video", () => {
  it("recognises a how-to by heading or by a numbered list of steps", () => {
    expect(isHowToSection("How to set up a CRM", "<p>x</p>")).toBe(true);
    expect(isHowToSection("Come configurare il CRM", "<p>x</p>")).toBe(true);
    expect(isHowToSection("Pricing", "<ol><li>a</li><li>b</li><li>c</li></ol>")).toBe(true);
    expect(isHowToSection("Pricing", "<ol><li>a</li><li>b</li></ol>")).toBe(false);
  });

  it("embeds the top result for the how-to heading on the nocookie host, with a caption", async () => {
    const search = vi.fn(async () => [VIDEO]);
    const { html, added } = await addHowToVideo(ARTICLE, { search });
    expect(added).toBe(true);
    expect(search).toHaveBeenCalledWith("How to set up a CRM in an afternoon");
    expect(html).toContain('src="https://www.youtube-nocookie.com/embed/abc123"');
    expect(html).toContain('title="Set up a CRM &lt;fast&gt;"');
    expect(html).toContain("<figcaption>Video: Set up a CRM &lt;fast&gt; (Acme TV, YouTube)</figcaption>");
    // Inside the how-to section, after its first paragraph.
    const at = html.indexOf("<figure class=\"video-embed\">");
    expect(at).toBeGreaterThan(html.indexOf("How to set up a CRM in an afternoon"));
    expect(at).toBeLessThan(html.indexOf("What the tools cost"));
  });

  it("does nothing when the site has turned video off", async () => {
    const search = vi.fn(async () => [VIDEO]);
    expect((await addHowToVideo(ARTICLE, { enabled: false, search })).added).toBe(false);
    expect(search).not.toHaveBeenCalled();
  });

  it("skips silently with no results, no how-to section, or an existing embed", async () => {
    expect((await addHowToVideo(ARTICLE, { search: async () => [] })).added).toBe(false);
    expect((await addHowToVideo(SECTION("Pricing", "x"), { search: async () => [VIDEO] })).added).toBe(false);
    const once = (await addHowToVideo(ARTICLE, { search: async () => [VIDEO] })).html;
    const search = vi.fn(async () => [VIDEO]);
    expect((await addHowToVideo(once, { search })).added).toBe(false);
    expect(search).not.toHaveBeenCalled();
  });
});

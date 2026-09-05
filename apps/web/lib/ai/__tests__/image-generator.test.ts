import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The call shape is the whole point of these tests. Every article in the
// database had no featured image because the code asked `dall-e-3` for a
// 1792x1024 "standard" image and then read a URL off the response - four
// assumptions, all of them DALL-E's, none of them true of the gpt-image
// models the account actually has. A mocked client is enough to pin the
// request; the response handling is pinned by what it returns.

const generate = vi.fn();
vi.mock("openai", () => ({
  default: class {
    images = { generate };
  },
}));

const { generateImage } = await import("../image-generator");

const PIXEL = Buffer.from("hello webp").toString("base64");

beforeEach(() => {
  generate.mockReset();
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.OPENAI_IMAGE_MODEL;
});
afterEach(() => {
  delete process.env.OPENAI_API_KEY;
});

describe("generateImage", () => {
  it("asks the cheap gpt-image model for a compressed landscape webp", async () => {
    generate.mockResolvedValue({ data: [{ b64_json: PIXEL }] });
    await generateImage("A Title", "a keyword");

    const req = generate.mock.calls[0][0];
    expect(req.model).toBe("gpt-image-1-mini");
    expect(req.size).toBe("1536x1024");
    expect(req.quality).toBe("low");
    expect(req.output_format).toBe("webp");
    // Left at its default of 100 a real generation came back at 1.2 MB.
    expect(req.output_compression).toBe(70);
    // The DALL-E values that could not work on this model.
    expect(req.size).not.toBe("1792x1024");
    expect(req.quality).not.toBe("standard");
  });

  it("returns decoded bytes, not a URL to fetch", async () => {
    generate.mockResolvedValue({ data: [{ b64_json: PIXEL }] });
    const r = await generateImage("A Title", "a keyword");
    expect(Buffer.isBuffer(r.data)).toBe(true);
    expect(r.data.toString()).toBe("hello webp");
    expect(r.contentType).toBe("image/webp");
    expect(r.extension).toBe("webp");
  });

  it("puts the brand style and keyword in the prompt, and bans text in the image", async () => {
    generate.mockResolvedValue({ data: [{ b64_json: PIXEL }] });
    await generateImage("A Title", "a keyword", { style: "flat", colors: "#123456" });
    const { prompt } = generate.mock.calls[0][0];
    expect(prompt).toContain("A Title");
    expect(prompt).toContain("a keyword");
    expect(prompt).toContain("flat");
    expect(prompt).toContain("#123456");
    expect(prompt).toContain("No text or watermarks");
  });

  it("puts the preset's wording in the prompt in place of the free-text style", async () => {
    generate.mockResolvedValue({ data: [{ b64_json: PIXEL }] });
    await generateImage("A Title", "a keyword", { style: "flat" }, { style: "watercolor" });
    const { prompt } = generate.mock.calls[0][0];
    expect(prompt).toContain("soft watercolour painting");
    expect(prompt).not.toContain("style: flat");
    expect(prompt).toContain("No text or watermarks");
  });

  it("names the brand colour as the accent, over brand_style.colors", async () => {
    generate.mockResolvedValue({ data: [{ b64_json: PIXEL }] });
    await generateImage("A Title", "a keyword", { colors: "#123456" }, { brandColor: "#1a1815" });
    const { prompt } = generate.mock.calls[0][0];
    expect(prompt).toContain("brand colour #1a1815");
    expect(prompt).not.toContain("#123456");
  });

  it("a title cover sets the title in type and lifts the no-text rule, and only then", async () => {
    generate.mockResolvedValue({ data: [{ b64_json: PIXEL }] });
    await generateImage("Choosing a CRM", "crm", undefined, { titleCover: true, brandColor: "#1a1815" });
    const { prompt } = generate.mock.calls[0][0];
    expect(prompt).toContain('The title text "Choosing a CRM"');
    expect(prompt).toContain("legible type");
    expect(prompt).toContain("background in the brand colour #1a1815");
    expect(prompt).not.toContain("No text or watermarks");
    expect(prompt).toContain("No watermarks");
  });

  it("a section image keeps the section brief and takes the body preset", async () => {
    generate.mockResolvedValue({ data: [{ b64_json: PIXEL }] });
    await generateImage("A Title", "crm", undefined, { section: { heading: "Pricing", excerpt: "It costs." }, style: "sketch", titleCover: true });
    const { prompt } = generate.mock.calls[0][0];
    expect(prompt).toContain('for the section "Pricing"');
    expect(prompt).toContain("pencil sketch");
    expect(prompt).not.toContain("The title text");
  });

  it("refuses a DALL-E-shaped response rather than restoring the expiring-URL path", async () => {
    generate.mockResolvedValue({ data: [{ url: "https://oai.example/tmp.png" }] });
    await expect(generateImage("A Title", "a keyword")).rejects.toThrow(/returned no image data/);
  });

  it("honours OPENAI_IMAGE_MODEL when it is set", async () => {
    process.env.OPENAI_IMAGE_MODEL = "gpt-image-1";
    generate.mockResolvedValue({ data: [{ b64_json: PIXEL }] });
    await generateImage("A Title", "a keyword");
    expect(generate.mock.calls[0][0].model).toBe("gpt-image-1");
  });

  it("says plainly when there is no key, rather than being skipped in silence", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(generateImage("A Title", "a keyword")).rejects.toThrow(/OPENAI_API_KEY not configured/);
    expect(generate).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { answer, ctx, quiet, issue, kvOf, codeOf, item } from "./paid-helpers";
import { altTextGenerator as tool, sniffImage, MAX_IMAGE_BYTES } from "../tools/alt-text-generator";
import { fakeFetch } from "./fake-fetch";
import { UnsafeUrlError } from "../safe-fetch";

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  create.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

const sent = () => create.mock.calls[0][0] as { max_tokens: number; system: string; messages: Array<{ content: unknown }> };

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const IMG = "https://cdn.example.com/photo.png";

describe("alt-text-generator", () => {
  it("fetches through ctx.fetch and sends the bytes as a base64 image", async () => {
    const fetch = fakeFetch({ [IMG]: { headers: { "content-type": "image/png" }, bodyBuffer: PNG } });
    create.mockResolvedValue(answer({ alt: "A red bicycle against a brick wall", description: "Longer.", text_in_image: "", decorative: false }));
    const blocks = await tool.run(tool.input.parse({ image_url: IMG }), ctx(fetch));
    expect(fetch).toHaveBeenCalledWith(IMG, expect.objectContaining({ maxBytes: MAX_IMAGE_BYTES + 1 }));
    const content = sent().messages[0].content as Array<{ type: string; source?: { media_type: string; data: string } }>;
    expect(content[0]).toMatchObject({ type: "image", source: { media_type: "image/png", data: PNG.toString("base64") } });
    expect(item(kvOf(blocks), "Alt text")?.value).toBe("A red bicycle against a brick wall");
    expect(codeOf(blocks)[0].code).toBe(`<img src="${IMG}" alt="A red bicycle against a brick wall">`);
  });

  it("refuses a page that is not an image, before any model call", async () => {
    const fetch = fakeFetch({ [IMG]: { headers: { "content-type": "text/html" }, body: "<html>" } });
    await expect(tool.run(tool.input.parse({ image_url: IMG }), ctx(fetch))).rejects.toMatchObject({ code: "invalid_input" });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses an SVG and a body that does not match its content type", async () => {
    const svg = fakeFetch({ [IMG]: { headers: { "content-type": "image/svg+xml" }, body: "<svg/>" } });
    await expect(tool.run(tool.input.parse({ image_url: IMG }), ctx(svg))).rejects.toMatchObject({ code: "invalid_input" });
    expect(sniffImage(Buffer.from("GIF89a....."))).toBe("image/gif");
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("not an image"))).toBeNull();
  });

  it("refuses an image over the size cap", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    const fetch = fakeFetch({ [IMG]: { headers: { "content-type": "image/png" }, bodyBuffer: big } });
    await expect(tool.run(tool.input.parse({ image_url: IMG }), ctx(fetch))).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/3.75 MB/) });
  });

  it("maps a private address to invalid_input and a 404 to upstream", async () => {
    const priv = fakeFetch(() => new UnsafeUrlError("10.0.0.1 is a private or local address."));
    await expect(tool.run(tool.input.parse({ image_url: IMG }), ctx(priv))).rejects.toMatchObject({ code: "invalid_input" });
    const missing = fakeFetch({ [IMG]: { status: 404 } });
    await expect(tool.run(tool.input.parse({ image_url: IMG }), ctx(missing))).rejects.toMatchObject({ code: "upstream" });
  });

  it("maps a model failure to upstream", async () => {
    const restore = quiet();
    const fetch = fakeFetch({ [IMG]: { headers: { "content-type": "image/png" }, bodyBuffer: PNG } });
    create.mockRejectedValue(new Error("500"));
    await expect(tool.run(tool.input.parse({ image_url: IMG }), ctx(fetch))).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("validates the URL", () => {
    expect(issue(tool.input, { image_url: "http://localhost/x.png" })).toMatch(/private or local|Port/);
    expect(issue(tool.input, {})).toMatch(/Enter a web address/);
  });
});

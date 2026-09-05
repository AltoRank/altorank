import { describe, it, expect, vi } from "vitest";
import {
  buildMicroPrompt,
  parseMicroResponse,
  sanitizeFragment,
  keepsAssets,
  rewriteField,
  buildRewriteArticlePrompt,
  parseRewriteArticleResponse,
  FIELD_LIMITS,
  MICRO_ACTIONS,
} from "../micro";

describe("buildMicroPrompt", () => {
  it("names the field's limit and the keyword for a title", () => {
    const { system, user } = buildMicroPrompt({
      field: "title",
      action: "shorten",
      text: "A very long title about warehouse orchestration software for teams",
      context: { keyword: "warehouse orchestration", outline: ["What it is", "Why it matters"] },
    });
    expect(system).toContain(`${FIELD_LIMITS.title} characters`);
    expect(system).toContain("plain text");
    expect(user).toContain("Target keyword: warehouse orchestration");
    expect(user).toContain("- What it is");
    expect(user).toContain("Shorten it.");
    expect(user).toContain("Current text:");
  });

  it("does not repeat the title as context when the title is the field", () => {
    const { user } = buildMicroPrompt({
      field: "title",
      action: "improve",
      text: "T",
      context: { title: "T" },
    });
    expect(user).not.toContain("Article title:");
  });

  it("uses the person's own instruction for Ask AI", () => {
    const { user } = buildMicroPrompt({
      field: "meta_description",
      action: "ask",
      text: "Some description",
      prompt: "Mention the free tier",
    });
    expect(user).toContain("Instruction from the editor: Mention the free tier");
  });

  it("asks for HTML back and for links and images to survive, for a selection", () => {
    const { system, user } = buildMicroPrompt({
      field: "selection",
      action: "simplify",
      text: '<p>See <a href="/pricing">pricing</a>.</p>',
    });
    expect(system).toContain("Return HTML only");
    expect(system).toContain("<a>");
    expect(system).toContain("<img>");
    expect(user).toContain("Fragment:");
  });

  it("bans the slop and the em dash in every prompt", () => {
    for (const field of ["title", "meta_description", "selection"] as const) {
      const { system } = buildMicroPrompt({ field, action: "improve", text: "x" });
      expect(system).toContain("delve");
      expect(system).toContain("Never use an em dash");
    }
  });

  it("offers the six actions in menu order", () => {
    expect(MICRO_ACTIONS.map((a) => a.label)).toEqual([
      "Improve",
      "Shorten",
      "Expand",
      "Simplify",
      "Fix grammar",
      "Ask AI",
    ]);
  });
});

describe("parseMicroResponse", () => {
  it("strips a fence, a wrapping tag, surrounding quotes and a trailing period from a title", () => {
    expect(parseMicroResponse('```\n<p>"The Better Title."</p>\n```', "title")).toBe("The Better Title");
  });

  it("keeps a quote that is part of the text", () => {
    expect(parseMicroResponse('Why "orchestration" beats scheduling', "title")).toBe(
      'Why "orchestration" beats scheduling',
    );
  });

  it("keeps the period on a meta description and replaces an em dash", () => {
    expect(parseMicroResponse("Plan work — then ship it.", "meta_description")).toBe("Plan work, then ship it.");
  });

  it("returns HTML for a selection and removes a script the model slipped in", () => {
    const out = parseMicroResponse(
      '<p>Fine <a href="/x">link</a>.</p><script>alert(1)</script><p onclick="x()">Hi</p>',
      "selection",
    );
    expect(out).toContain('<a href="/x">link</a>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onclick");
  });
});

describe("sanitizeFragment", () => {
  it("neutralises javascript: hrefs and drops frames", () => {
    const out = sanitizeFragment('<p><a href="javascript:alert(1)">x</a></p><iframe src="https://evil"></iframe>');
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("<iframe");
  });
  it("leaves images with src and alt alone", () => {
    const img = '<img src="https://cdn/x.webp" alt="A thing">';
    expect(sanitizeFragment(`<p>${img}</p>`)).toContain(img);
  });
});

describe("keepsAssets", () => {
  it("is true when every link and image survives, in any order", () => {
    const before = '<p><a href="/a">a</a> <img src="/i.webp" alt=""> <a href="/b">b</a></p>';
    const after = '<p><a href="/b">b</a> then <a href="/a">a</a> <img src="/i.webp" alt="new"></p>';
    expect(keepsAssets(before, after)).toBe(true);
  });
  it("is false when a link went missing", () => {
    expect(keepsAssets('<a href="/a">a</a><a href="/b">b</a>', '<a href="/a">a</a>')).toBe(false);
  });
});

describe("rewriteField", () => {
  function fakeClient(text: string) {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    return { client: { messages: { create } } as never, create };
  }

  it("sends the cheap tier, the prompt, and returns the parsed text", async () => {
    const { client, create } = fakeClient('"Shorter title."');
    const r = await rewriteField({ field: "title", action: "shorten", text: "A long title" }, client);
    expect(r.text).toBe("Shorter title");
    const req = create.mock.calls[0][0];
    expect(req.model).toBe("claude-haiku-4-5-20251001");
    expect(req.max_tokens).toBe(400);
    expect(req.messages[0].content).toContain("A long title");
  });

  it("refuses Ask AI without an instruction, before any model call", async () => {
    const { client, create } = fakeClient("x");
    await expect(rewriteField({ field: "title", action: "ask", text: "T" }, client)).rejects.toThrow(/Say what/);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not propose a selection rewrite that dropped a link", async () => {
    const { client } = fakeClient("<p>No link any more.</p>");
    await expect(
      rewriteField(
        { field: "selection", action: "shorten", text: '<p>Read <a href="/x">this</a> now.</p>' },
        client,
      ),
    ).rejects.toThrow(/dropped a link/);
  });

  it("gives a selection room to answer", async () => {
    const { client, create } = fakeClient('<p>Read <a href="/x">this</a>.</p>');
    await rewriteField(
      { field: "selection", action: "shorten", text: '<p>Read <a href="/x">this</a> now.</p>' },
      client,
    );
    expect(create.mock.calls[0][0].max_tokens).toBe(4096);
  });
});

describe("whole-article rewrite", () => {
  it("builds a prompt that keeps assets and asks for three bullets", () => {
    const { system, user } = buildRewriteArticlePrompt({
      html: "<h2>A</h2><p>b</p>",
      instruction: "Tighten it",
      context: { title: "T", keyword: "k" },
    });
    expect(system).toContain("exact href");
    expect(system).toContain("<what-changed>");
    expect(system).toContain("Do not add an <h1>");
    expect(user).toContain("Instruction: Tighten it");
    expect(user).toContain("Article title: T");
    expect(user).toContain("<h2>A</h2>");
  });

  it("splits the answer into sanitised HTML and up to three changes, dropping a stray h1", () => {
    const raw = [
      "```html",
      "<h1>Title</h1><h2>A</h2><p>Tighter <a href=\"/x\">link</a>.</p>",
      "<what-changed><li>Cut the intro</li><li>Removed <em>filler</em></li><li>Shorter lists</li><li>fourth</li></what-changed>",
      "```",
    ].join("\n");
    const { html, changes } = parseRewriteArticleResponse(raw);
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("what-changed");
    expect(html).toContain('<a href="/x">link</a>');
    expect(changes).toEqual(["Cut the intro", "Removed filler", "Shorter lists"]);
  });

  it("returns an empty change list when the model forgot it", () => {
    expect(parseRewriteArticleResponse("<p>x</p>").changes).toEqual([]);
  });
});

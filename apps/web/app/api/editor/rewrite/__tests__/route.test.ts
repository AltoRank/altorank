import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// POST /api/editor/rewrite: the editor's whole-article rewrite
// ---------------------------------------------------------------------------
//
// It takes an article's text and streams a model's rewrite of it back, so it
// is the editor, and the editor is what the trial opens. It was the one
// editor door with no body lock, and it billed whichever account the person
// joined first rather than the article's.
//
// It is also a long model call a person presses: it was unmetered (no spend
// row), uncounted (no limit) and took any amount of text. Pinned here: the
// size and instruction limits, the per-account count, the spend row, and that
// the model's text leaves only once, checked, in `complete`.

const locked = vi.fn<(workspaceId: string) => Promise<boolean>>();
vi.mock("@/lib/billing/body-lock", () => ({ sessionBodyLockedForWorkspace: (id: string) => locked(id) }));

const canSpend = vi.fn();
vi.mock("@/lib/billing/spend-gate", () => ({ canSpend: (...args: unknown[]) => canSpend(...args) }));

const takeDoor = vi.fn();
vi.mock("@/lib/billing/spend-doors", () => ({ takeDoor: (...args: unknown[]) => takeDoor(...args) }));

const spendRows: Array<Record<string, unknown>> = [];
vi.mock("@/lib/billing/default-spend", () => ({
  recordSpendByDefault: (entry: Record<string, unknown>) => {
    // What the row would carry from the scope it was written in.
    spendRows.push({ ...entry, scope: currentScope() });
  },
  spendClient: () => null,
}));
const { currentSpendScope } = await import("@/lib/billing/spend-scope");
const currentScope = () => {
  const s = currentSpendScope();
  return s ? { workspaceId: s.workspaceId, articleId: s.articleId } : null;
};

const saved = vi.fn<() => Array<{ content: Record<string, unknown> | null }>>();
vi.mock("@/lib/articles/body-read", () => ({ readArticlesWhole: async () => saved() }));

const stream = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { stream: (...a: unknown[]) => stream(...a) }; } }));

const rows: Record<string, Record<string, unknown>> = {
  articles: { id: "a1", title: "T", keyword: "k", workspace_id: "ws-b" },
  workspaces: { account_id: "acc-b" },
};
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "person@acme-agency.example" } }, error: null }) },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        single: async () => ({ data: rows[table] ?? null }),
        maybeSingle: async () => ({ data: rows[table] ?? null }),
      };
      return chain;
    },
  }),
}));

const { POST } = await import("../route");

const post = (body: Record<string, unknown> = {}) =>
  new NextRequest("http://localhost/api/editor/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ articleId: "a1", html: "<p>Some text.</p>", instruction: "tighten", ...body }),
  });

/** A saved article whose HTML is about `chars` long. */
const savedOf = (chars: number) => [
  { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(chars) }] }] } },
];

/** The SDK's stream: the events in order, then the final message. */
function modelAnswers(text: string, usage = { input_tokens: 1000, output_tokens: 400 }) {
  const pieces = text.match(/[\s\S]{1,700}/g) ?? [];
  const events = [
    { type: "message_start", message: { usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } },
    ...pieces.map((p) => ({ type: "content_block_delta", delta: { type: "text_delta", text: p } })),
    { type: "message_delta", usage: { output_tokens: usage.output_tokens } },
  ];
  stream.mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    finalMessage: async () => ({ stop_reason: "end_turn", usage }),
  }));
}

async function events(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

beforeEach(() => {
  locked.mockReset();
  canSpend.mockReset();
  takeDoor.mockReset();
  stream.mockReset();
  saved.mockReset();
  spendRows.length = 0;
  locked.mockResolvedValue(false);
  canSpend.mockResolvedValue({ allowed: true, reason: "plan", message: null });
  takeDoor.mockResolvedValue({ allowed: true, useId: "use-1" });
  saved.mockReturnValue(savedOf(20));
});

describe("POST /api/editor/rewrite", () => {
  it("refuses an account that has not started its trial, before any model call", async () => {
    locked.mockResolvedValue(true);
    const res = await POST(post());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "trial_required" });
    expect(locked).toHaveBeenCalledWith("ws-b");
    expect(canSpend).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it("asks the spend gate about the article's account, not the person's first one", async () => {
    canSpend.mockResolvedValue({ allowed: false, reason: "no-plan", message: "needs a plan" });
    const res = await POST(post());
    expect(res.status).toBe(402);
    expect(canSpend).toHaveBeenCalledWith(expect.anything(), "acc-b", expect.objectContaining({ workspaceId: "ws-b" }));
    expect(stream).not.toHaveBeenCalled();
  });

  it("refuses an instruction that is a second article", async () => {
    const res = await POST(post({ instruction: "x".repeat(2_001) }));
    expect(res.status).toBe(400);
    expect(stream).not.toHaveBeenCalled();
    expect(takeDoor).not.toHaveBeenCalled();
  });

  it("refuses text far longer than the saved article, and nothing is counted", async () => {
    saved.mockReturnValue(savedOf(10_000));
    const res = await POST(post({ html: `<p>${"y".repeat(60_000)}</p>` }));
    expect(res.status).toBe(413);
    expect(stream).not.toHaveBeenCalled();
    expect(takeDoor).not.toHaveBeenCalled();
  });

  it("takes the saved article plus room for unsaved edits", async () => {
    saved.mockReturnValue(savedOf(30_000));
    modelAnswers("<p>Tight.</p><what-changed><li>a</li></what-changed>");
    const res = await POST(post({ html: `<p>${"y".repeat(50_000)}</p>` }));
    expect(res.status).toBe(200);
  });

  it("counts each press against the article's account, a trial included, and refuses past the limit", async () => {
    canSpend.mockResolvedValue({ allowed: true, reason: "plan", message: null, quota: { trialing: true } });
    takeDoor.mockResolvedValue({ allowed: false, message: "This account has used its whole-article rewrites for now: 20 an hour." });
    const res = await POST(post());
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("20 an hour"), reason: "rate_limited" });
    expect(takeDoor).toHaveBeenCalledWith("editor-rewrite", { accountId: "acc-b", workspaceId: "ws-b" });
    expect(stream).not.toHaveBeenCalled();
  });

  it("does not count a self-hosted install or the operator's own account", async () => {
    for (const reason of ["self-host", "operator"]) {
      canSpend.mockResolvedValue({ allowed: true, reason, message: null });
      modelAnswers("<p>Tight.</p>");
      const res = await POST(post());
      await res.text();
    }
    expect(takeDoor).not.toHaveBeenCalled();
  });

  it("writes a spend row for the call, attributed to the article and its site", async () => {
    modelAnswers("<p>Some tighter text.</p><what-changed><li>Cut words</li></what-changed>", { input_tokens: 2_000, output_tokens: 500 });
    const res = await POST(post());
    const out = await events(res);
    expect(out.at(-1)).toMatchObject({ type: "complete", html: "<p>Some tighter text.</p>", changes: ["Cut words"] });
    expect(spendRows).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        operation: "editor/rewrite",
        inputTokens: 2_000,
        outputTokens: 500,
        costUsd: expect.any(Number),
        scope: { workspaceId: "ws-b", articleId: "a1" },
      }),
    ]);
  });

  it("sends a word count while it writes, never the model's raw text", async () => {
    const answer = `<p>${"word ".repeat(1_000)}<img src=x onerror=alert(1)></p>`;
    modelAnswers(answer);
    const res = await POST(post());
    const out = await events(res);
    expect(out.some((e) => e.type === "chunk")).toBe(false);
    const progress = out.filter((e) => e.type === "progress");
    expect(progress.length).toBeGreaterThan(0);
    for (const e of progress) {
      expect(Object.keys(e).sort()).toEqual(["type", "words"]);
      expect(typeof e.words).toBe("number");
    }
    // The only HTML that leaves is `complete`, after the parse that cleans
    // it: the handler the model wrote never reaches the browser.
    expect(out.at(-1)).toMatchObject({ type: "complete" });
    expect(JSON.stringify(out)).not.toContain("onerror");
  });

  it("writes the spend row for what was produced when the stream stops part-way", async () => {
    stream.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", message: { usage: { input_tokens: 3_000, output_tokens: 1 } } };
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "<p>Half" } };
        yield { type: "message_delta", usage: { output_tokens: 200 } };
        throw new Error("connection reset");
      },
      finalMessage: async () => {
        throw new Error("never finished");
      },
    }));
    const res = await POST(post());
    const out = await events(res);
    expect(out.at(-1)).toMatchObject({ type: "error", error: "connection reset" });
    expect(spendRows).toEqual([expect.objectContaining({ operation: "editor/rewrite", inputTokens: 3_000, outputTokens: 200 })]);
  });

  it("bills a stream the reader left before the end for the text it wrote, not the one token it had reported", async () => {
    // The API reports the output count once, in message_delta at the end. A
    // reader that leaves after 20,000 characters has been billed for them.
    const piece = "<p>" + "word ".repeat(199) + "</p>";
    stream.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", message: { usage: { input_tokens: 3_000, output_tokens: 1 } } };
        for (let i = 0; i < 20; i++) yield { type: "content_block_delta", delta: { type: "text_delta", text: piece } };
        const err = new Error("Request was aborted.");
        err.name = "APIUserAbortError";
        throw err;
      },
      finalMessage: async () => {
        throw new Error("never finished");
      },
    }));
    const out = await events(await POST(post()));
    expect(out.at(-1)).toMatchObject({ type: "error" });
    expect(spendRows).toHaveLength(1);
    expect(spendRows[0].outputTokens).toBeGreaterThanOrEqual(Math.ceil((piece.length * 20) / 4));
    expect(spendRows[0].costUsd).toBeGreaterThan(0.05);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// "Push to site" on Improvements is a publish of new text onto a live post.
// It has the gates of a publish (a plan, the figure check on what goes out),
// refuses a page that changed since the rewrite read it, goes out through the
// publish renderer, and is recorded under the person who pressed it.

const gates = vi.hoisted(() => ({
  needsPlan: false,
  trial: "open" as "open" | "gated",
  article: null as Record<string, unknown> | null,
}));
const deliver = vi.hoisted(() => vi.fn());
const svc = vi.hoisted(() => ({ writes: [] as Array<{ table: string; row: Record<string, unknown> }> }));

vi.mock("@/lib/billing/quota", () => ({
  needsPlanToShip: async () => gates.needsPlan,
  CHOOSE_PLAN_MESSAGE: "Approving and publishing need a plan.",
}));
vi.mock("@/lib/billing/body-lock", () => ({ workspaceTrialGate: async () => gates.trial }));
vi.mock("@/lib/billing/trial-refusal", () => ({ BODY_LOCKED_MESSAGE: "Start your trial first." }));
vi.mock("@/lib/articles/body-read", () => ({ readVisibleArticle: async () => gates.article }));
vi.mock("@/lib/i18n/workspace-language", () => ({ readWorkspaceLanguage: async () => "en" }));
vi.mock("@/lib/publishing/core", () => ({
  deliverArticle: deliver,
  PublishError: class PublishError extends Error {
    constructor(message: string, public readonly context: { destinationId: string; publishMode: string }) {
      super(message);
    }
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      update: (row: Record<string, unknown>) => {
        svc.writes.push({ table, row });
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));

import { pushExecution, pageChangedSinceRewrite, PAGE_CHANGED_MESSAGE } from "../push";
import { diffBlocks } from "../hunks";
import { htmlToTiptapJson } from "@/lib/ai/tiptap";
import { tiptapToHtml } from "@/lib/cms/html";

const BEFORE = "<h2>Treatment</h2><p>Old paragraph about recovery.</p><p>Closing words.</p>";
const AFTER = "<h2>Treatment</h2><p>New paragraph about recovery, with more detail.</p><p>Closing words.</p>";

function articleWith(html: string) {
  return {
    id: "a1",
    workspace_id: "w1",
    title: "Recovery guide",
    slug: "recovery-guide",
    content: htmlToTiptapJson(html, {}),
    meta_description: "Old meta",
    featured_image_url: null,
    external_id: "post-9",
    published_url: "https://clinic.example/blog/recovery-guide",
    keyword: "recovery",
    created_at: "2026-09-01T00:00:00.000Z",
    published_at: "2026-09-02T00:00:00.000Z",
    research: null,
  };
}

function execution(over: Record<string, unknown> = {}) {
  const beforeHtml = tiptapToHtml(htmlToTiptapJson(BEFORE, {}) as never);
  const hunks = diffBlocks(beforeHtml, AFTER);
  const changed = hunks.find((h) => h.kind === "changed")!;
  return {
    id: "e1",
    workspace_id: "w1",
    review_status: "awaiting_review",
    before: { html: beforeHtml, title: "Recovery guide", metaDescription: "Old meta" },
    after: { html: AFTER, title: "Recovery guide", metaDescription: "New meta" },
    hunks,
    decisions: { decisions: { [changed.id]: "accepted" }, edited: {}, fields: {} },
    task: { candidate: { id: "c1", workspace_id: "w1", article_id: "a1", url: "https://clinic.example/blog/recovery-guide" } },
    ...over,
  };
}

function client(exec: Record<string, unknown>) {
  const logs: Record<string, unknown>[] = [];
  const chain = (data: unknown) => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.maybeSingle = async () => ({ data, error: null });
    c.single = async () => ({ data, error: null });
    return c;
  };
  return {
    logs,
    from: (table: string) => {
      if (table === "refresh_executions") return chain(exec);
      if (table === "workspaces") return chain({ account_id: "acc1", domain: "clinic.example" });
      if (table === "publish_log") {
        return {
          insert: async (row: Record<string, unknown>) => {
            logs.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const pusher = { id: "user-7", email: "editor@clinic.example" };

beforeEach(() => {
  gates.needsPlan = false;
  gates.trial = "open";
  gates.article = articleWith(BEFORE);
  svc.writes = [];
  deliver.mockReset();
  deliver.mockResolvedValue({
    externalId: "post-9",
    url: "https://clinic.example/blog/recovery-guide",
    destinationId: "wi1",
    publishMode: "publish",
  });
});

describe("pushExecution gates", () => {
  it("refuses without a plan, before anything reaches the site", async () => {
    gates.needsPlan = true;
    await expect(pushExecution(client(execution()) as never, "e1", { pusher })).rejects.toThrow(/need a plan/);
    expect(deliver).not.toHaveBeenCalled();
    expect(svc.writes).toEqual([]);
  });

  it("refuses while the site's trial gate is closed", async () => {
    gates.trial = "gated";
    await expect(pushExecution(client(execution()) as never, "e1", { pusher })).rejects.toThrow(/trial/);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("refuses when the article changed after the rewrite read it", async () => {
    gates.article = articleWith(BEFORE.replace("Closing words.", "Closing words, edited in the editor."));
    await expect(pushExecution(client(execution()) as never, "e1", { pusher })).rejects.toThrow(PAGE_CHANGED_MESSAGE);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("refuses an unsourced figure in what goes out, as Approve does", async () => {
    const exec = execution();
    const changed = (exec.hunks as Array<{ id: string; kind: string }>).find((h) => h.kind === "changed")!;
    exec.decisions = {
      decisions: { [changed.id]: "accepted" },
      edited: { [changed.id]: "<p>73% of patients recover faster with this method.</p>" },
      fields: {},
    };
    await expect(pushExecution(client(exec) as never, "e1", { pusher })).rejects.toThrow(
      /unsourced figure is still in the draft .*then push\./,
    );
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("pushExecution on success", () => {
  it("sends the reviewed body through the publish renderer, in place only", async () => {
    await pushExecution(client(execution()) as never, "e1", { pusher, destinationId: "wi1" });
    expect(deliver).toHaveBeenCalledTimes(1);
    const [, article, articleId, opts] = deliver.mock.calls[0];
    expect(articleId).toBe("a1");
    expect(opts).toEqual({ destinationId: "wi1", inPlaceOnly: true });
    const sent = tiptapToHtml(article.content);
    expect(sent).toContain("New paragraph about recovery, with more detail.");
    expect(sent).toContain("Closing words.");
    // The publish date and post id ride along, so the renderer keeps them.
    expect(article.published_at).toBe("2026-09-02T00:00:00.000Z");
    expect(article.external_id).toBe("post-9");
  });

  it("records the pusher as the approval of the new text and on the execution", async () => {
    const c = client(execution());
    await pushExecution(c as never, "e1", { pusher });
    const articleWrite = svc.writes.find((w) => w.table === "articles")!.row;
    expect(articleWrite).toMatchObject({ approved_by: "user-7", approval_kind: "human", fact_check_verdict: expect.any(String) });
    expect(articleWrite.approved_at).toEqual(expect.any(String));
    const execWrites = svc.writes.filter((w) => w.table === "refresh_executions").map((w) => w.row);
    expect(execWrites).toContainEqual(expect.objectContaining({ review_status: "pushed" }));
    expect(execWrites).toContainEqual({ pushed_by: "user-7" });
    expect(c.logs).toEqual([
      expect.objectContaining({ article_id: "a1", status: "success", triggered_by: "manual", destination_id: "wi1", publish_mode: "publish" }),
    ]);
  });

  it("keeps a live post live on a draft-mode connection, and keeps its URL when the update names none", async () => {
    gates.article = { ...articleWith(BEFORE), status: "live" };
    deliver.mockResolvedValueOnce({ externalId: "post-9", url: "", destinationId: "wi1", publishMode: "publish" });
    await pushExecution(client(execution()) as never, "e1", { pusher });
    const [, , , opts] = deliver.mock.calls[0];
    expect(opts).toEqual({ destinationId: undefined, inPlaceOnly: true, publishMode: "publish" });
    const articleWrite = svc.writes.find((w) => w.table === "articles")!.row;
    expect(articleWrite.published_url).toBe("https://clinic.example/blog/recovery-guide");
  });

  it("treats a post found live on the site as live", async () => {
    gates.article = { ...articleWith(BEFORE), status: "approved", found_on_site_at: "2026-10-01T00:00:00.000Z" };
    await pushExecution(client(execution()) as never, "e1", { pusher });
    expect(deliver.mock.calls[0][3]).toMatchObject({ publishMode: "publish" });
  });

  it("leaves a post still held as a draft in the CMS to the connection's mode", async () => {
    gates.article = { ...articleWith(BEFORE), status: "approved", indexing_status: { indexnow: "held-in-cms" } };
    await pushExecution(client(execution()) as never, "e1", { pusher });
    expect(deliver.mock.calls[0][3]).not.toHaveProperty("publishMode");
    expect(svc.writes.find((w) => w.table === "articles")!.row).not.toHaveProperty("published_url");
  });

  it("logs a failed delivery and records no push", async () => {
    deliver.mockRejectedValueOnce(new Error("CMS said no"));
    const c = client(execution());
    await expect(pushExecution(c as never, "e1", { pusher })).rejects.toThrow("CMS said no");
    expect(c.logs).toEqual([expect.objectContaining({ status: "error", error: "CMS said no" })]);
    expect(svc.writes).toEqual([]);
  });
});

describe("pageChangedSinceRewrite", () => {
  it("ignores renderer spelling: whitespace and entities", () => {
    expect(pageChangedSinceRewrite({ html: "<p>Tom &amp; Jerry</p>\n<p>b</p>" }, "<p>Tom &#38; Jerry</p><p>b</p>")).toBe(false);
  });

  it("sees a text edit and a changed link", () => {
    expect(pageChangedSinceRewrite({ html: "<p>a</p>" }, "<p>a b</p>")).toBe(true);
    expect(pageChangedSinceRewrite({ html: '<p><a href="/x">a</a></p>' }, '<p><a href="/y">a</a></p>')).toBe(true);
  });

  it("treats a rewrite with no recorded before as changed", () => {
    expect(pageChangedSinceRewrite(null, "<p>a</p>")).toBe(true);
  });
});

/**
 * Who writes an approval, and what leaving one does.
 *
 * Two fake databases seeded alike: `asUser` is the person's own client (RLS:
 * it holds only the rows they can see), `asServer` is the service role. An
 * approval, a schedule and a `live` must be the server's write (migration 109
 * refuses them from a client token); clearing one is the person's, and sends
 * the article back held so the auto-approve rule does not sign it off again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, type FakeSupabase, type Seed } from "@/lib/agent/__tests__/fake-supabase";

let asUser: FakeSupabase;
let asServer: FakeSupabase;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => asUser,
  createServiceClient: () => asServer,
}));
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: async () => ({ user: { id: "u-editor", email: "editor@acme.example" }, accountId: "acc-1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/billing/quota", () => ({ needsPlanToShip: async () => false, CHOOSE_PLAN_MESSAGE: "Choose a plan" }));
vi.mock("@/lib/billing/body-lock", () => ({
  // No body: the figure check has nothing to read and lets the approval through.
  articleBodyForSession: async () => ({ content: null, research: null, workspace_id: "ws-1" }),
  sessionBodyLockedForWorkspace: async () => false,
}));
vi.mock("@/lib/email/approval-events", () => ({ announceDraftApproved: async () => {} }));
vi.mock("@/lib/seo/indexing", () => ({ submitForIndexing: async () => ({ indexnow: "skipped", google: "not-connected" }) }));

import { approveArticle, approveArticles, markPublishedManually } from "../publish";
import { scheduleArticle, unscheduleArticle, addToQueue } from "../schedule";
import { updateArticle } from "../articles";

const OWNER = "u-owner";
const T = "2026-10-01T09:00:00.000Z";

function seed(): Seed {
  return {
    workspaces: [{ id: "ws-1", account_id: "acc-1", domain: "acme.example", indexnow_key: null }],
    articles: [
      { id: "draft", workspace_id: "ws-1", status: "draft", approved_by: null, approved_at: null, approval_kind: null, scheduled_at: null, held_by: null },
      { id: "review", workspace_id: "ws-1", status: "review", approved_by: null, approved_at: null, approval_kind: null, scheduled_at: null, held_by: null },
      { id: "approved", workspace_id: "ws-1", status: "approved", approved_by: OWNER, approved_at: T, approval_kind: "human", scheduled_at: null, held_by: null },
      { id: "legacy-approved", workspace_id: "ws-1", status: "approved", approved_by: null, approved_at: null, approval_kind: null, scheduled_at: null, held_by: null },
      { id: "scheduled", workspace_id: "ws-1", status: "scheduled", approved_by: OWNER, approved_at: T, approval_kind: "auto", scheduled_at: "2026-10-20T10:00:00.000Z", held_by: null },
      { id: "failed-publish", workspace_id: "ws-1", status: "error", approved_by: OWNER, approved_at: T, approval_kind: "human", scheduled_at: null, held_by: null },
      { id: "failed-generation", workspace_id: "ws-1", status: "error", approved_by: null, approved_at: null, approval_kind: null, scheduled_at: null, held_by: null },
      { id: "live", workspace_id: "ws-1", status: "live", approved_by: OWNER, approved_at: T, approval_kind: "human", scheduled_at: null, held_by: null },
    ],
    publish_log: [],
  };
}

const row = (db: FakeSupabase, id: string) => db.tables.articles.find((a) => a.id === id)!;
const statusWrites = (db: FakeSupabase) =>
  db.writes.filter((w) => w.table === "articles" && w.patch && ("status" in w.patch || "approved_by" in w.patch));

beforeEach(() => {
  asUser = fakeSupabase(seed());
  asServer = fakeSupabase(seed());
});

describe("approving", () => {
  it("records the approval with the server's client, naming the person who pressed it", async () => {
    await expect(approveArticle("review")).resolves.toEqual({ status: "approved" });
    expect(row(asServer, "review")).toMatchObject({ status: "approved", approved_by: "u-editor", approval_kind: "human" });
    expect(statusWrites(asUser)).toEqual([]);
  });

  it("refuses an article the person's own client cannot see, and writes nothing", async () => {
    asUser.tables.articles = asUser.tables.articles.filter((a) => a.id !== "review");
    await expect(approveArticle("review")).rejects.toThrow("must be in review");
    expect(statusWrites(asServer)).toEqual([]);
  });

  it("batch-approves only the visible drafts in review", async () => {
    asUser.tables.articles = asUser.tables.articles.filter((a) => a.id !== "draft");
    const moved = await approveArticles(["review", "approved", "draft"]);
    expect(moved).toEqual(["review"]);
    expect(row(asServer, "review").approved_by).toBe("u-editor");
    expect(row(asServer, "draft").status).toBe("draft");
  });
});

describe("approving on a site with a publishing schedule", () => {
  /** An enabled cadence and a connected CMS on ws-1, in the server's view. */
  function withSchedule(opts: { enabled?: boolean; cms?: boolean } = {}) {
    asServer.tables.publishing_cadences = [
      { workspace_id: "ws-1", enabled: opts.enabled ?? true, days_of_week: [1, 3, 5], publish_time: "10:00", timezone: "Europe/Rome" },
    ];
    asServer.tables.integrations = [{ id: "wordpress", name: "WordPress", tag: "CMS" }];
    asServer.tables.workspace_integrations =
      opts.cms === false ? [] : [{ id: "wi-1", workspace_id: "ws-1", integration_id: "wordpress", config: {}, publish_mode: "publish" }];
  }

  it("takes the next slot: scheduled with no date, as auto-approve and Add to queue write it", async () => {
    withSchedule();
    await expect(approveArticle("review")).resolves.toEqual({ status: "scheduled" });
    expect(row(asServer, "review")).toMatchObject({
      status: "scheduled",
      scheduled_at: null,
      approved_by: "u-editor",
      approval_kind: "human",
    });
    expect(statusWrites(asUser)).toEqual([]);
  });

  it("stays approved, for Publish now, when the schedule is off", async () => {
    withSchedule({ enabled: false });
    await expect(approveArticle("review")).resolves.toEqual({ status: "approved" });
    expect(row(asServer, "review")).toMatchObject({ status: "approved", approved_by: "u-editor" });
  });

  it("stays approved when there is nowhere to publish: the slot would only fail", async () => {
    withSchedule({ cms: false });
    await expect(approveArticle("review")).resolves.toEqual({ status: "approved" });
    expect(row(asServer, "review").status).toBe("approved");
  });

  it("batch approval takes the slot too", async () => {
    withSchedule();
    expect(await approveArticles(["review"])).toEqual(["review"]);
    expect(row(asServer, "review")).toMatchObject({ status: "scheduled", scheduled_at: null });
  });

  it("still refuses an article not in review, and writes nothing", async () => {
    withSchedule();
    await expect(approveArticle("approved")).rejects.toThrow("must be in review");
    expect(statusWrites(asServer)).toEqual([]);
  });
});

describe("scheduling", () => {
  it("reschedules a scheduled article (Reschedule used to fail with 'must be approved')", async () => {
    await scheduleArticle("scheduled", "2026-11-02T08:30:00.000Z");
    expect(row(asServer, "scheduled")).toMatchObject({ status: "scheduled", scheduled_at: "2026-11-02T08:30:00.000Z", approved_by: OWNER });
    expect(statusWrites(asUser)).toEqual([]);
  });

  it("schedules an approved article through the server", async () => {
    await scheduleArticle("approved", "2026-11-02T08:30:00.000Z");
    expect(row(asServer, "approved")).toMatchObject({ status: "scheduled", scheduled_at: "2026-11-02T08:30:00.000Z" });
  });

  it("refuses to schedule or queue an article with no recorded approval", async () => {
    await expect(scheduleArticle("legacy-approved", "2026-11-02T08:30:00.000Z")).rejects.toThrow("must be approved");
    await expect(addToQueue("legacy-approved")).rejects.toThrow("must be approved");
    await expect(scheduleArticle("review", "2026-11-02T08:30:00.000Z")).rejects.toThrow("must be approved");
    expect(statusWrites(asServer)).toEqual([]);
  });

  it("Cancel sends a scheduled article back to review with no approval, held from the auto-approve rule", async () => {
    await unscheduleArticle("scheduled");
    expect(row(asUser, "scheduled")).toMatchObject({
      status: "review",
      approved_by: null,
      approved_at: null,
      approval_kind: null,
      scheduled_at: null,
      held_by: "u-editor",
    });
  });

  it("Cancel refuses an article that is not scheduled", async () => {
    await expect(unscheduleArticle("approved")).rejects.toThrow("Only a scheduled article");
    expect(row(asUser, "approved")).toMatchObject({ status: "approved", approved_by: OWNER });
  });
});

describe("Change status", () => {
  it("to Review on an approved article clears the approval and holds it", async () => {
    await updateArticle("approved", { status: "review" });
    expect(row(asUser, "approved")).toMatchObject({ status: "review", approved_by: null, approval_kind: null, held_by: "u-editor" });
  });

  it("to Draft on a scheduled article clears the approval and the date", async () => {
    await updateArticle("scheduled", { status: "draft" });
    expect(row(asUser, "scheduled")).toMatchObject({ status: "draft", approved_by: null, scheduled_at: null, held_by: null });
  });

  it("from Draft to Review is an ordinary edit: nothing to clear, nothing held", async () => {
    await updateArticle("draft", { status: "review" });
    expect(row(asUser, "draft")).toMatchObject({ status: "review", held_by: null });
  });

  it("still refuses approved, scheduled and live from the editor", async () => {
    for (const status of ["approved", "scheduled", "live"]) {
      await expect(updateArticle("review", { status })).rejects.toThrow("cannot be set from the editor");
    }
  });
});

describe("editing after approval", () => {
  const edit = { content: { type: "doc", content: [] }, title: "Retitled", word_count: 0 };

  it("sends an approved article back to review, approval cleared and held", async () => {
    await expect(updateArticle("approved", edit)).resolves.toEqual({ sentBackToReview: true });
    expect(row(asUser, "approved")).toMatchObject({ status: "review", title: "Retitled", approved_by: null, approved_at: null, held_by: "u-editor" });
  });

  it("takes a scheduled article off its date the same way", async () => {
    await updateArticle("scheduled", { title: "Retitled" });
    expect(row(asUser, "scheduled")).toMatchObject({ status: "review", approved_by: null, scheduled_at: null, held_by: "u-editor" });
  });

  it("voids the approval a failed publish was keeping for its retry", async () => {
    await updateArticle("failed-publish", edit);
    expect(row(asUser, "failed-publish")).toMatchObject({ status: "review", approved_by: null });
  });

  it("leaves a draft, a failed generation and a live article where they are", async () => {
    for (const id of ["review", "failed-generation", "live"]) {
      const before = row(asUser, id).status;
      await expect(updateArticle(id, edit)).resolves.toEqual({ sentBackToReview: false });
      expect(row(asUser, id).status).toBe(before);
    }
    expect(row(asUser, "live").approved_by).toBe(OWNER);
  });

  it("a score update alone touches no approval", async () => {
    await updateArticle("approved", { seo_score: 80 });
    expect(row(asUser, "approved")).toMatchObject({ status: "approved", approved_by: OWNER });
  });
});

describe("marking published by hand", () => {
  it("writes live with the server's client, and only for an approved article with an approver", async () => {
    await markPublishedManually("approved", "https://acme.example/blog/post");
    expect(row(asServer, "approved")).toMatchObject({ status: "live", published_url: "https://acme.example/blog/post" });
    expect(statusWrites(asUser)).toEqual([]);

    await expect(markPublishedManually("legacy-approved", "https://acme.example/blog/other")).rejects.toThrow("Only an approved article");
  });
});

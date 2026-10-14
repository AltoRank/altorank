// ---------------------------------------------------------------------------
// What a first look owes its gate, on the local database
// ---------------------------------------------------------------------------
//
// Against PostgREST and Postgres themselves, because what is pinned is what a
// client token can and cannot do (migration 107):
//
// - a member's client cannot read or write `owed_bodies`, and an owner who
//   turns their first article back into something that looks owed - status,
//   content, keyword, outline, timestamps, all writable on `articles` - gets
//   no draft bought for it: the nightly sweep and the draft route's claim
//   read only the server's record (round-1 review, the blocker);
// - a member's client cannot write `articles.body_stream`, which the owner's
//   reader renders; every other column it could write before it still can;
// - the server's record: a try is claimed once, a spent body is given up
//   (errored, record gone), and the run's budget is topped up once, only.
//
// Seeds one account with invented names (acme-*.example, *.example.test
// addresses with a password made up here) and deletes it at the end.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { connectLocalStack } from "@/lib/__tests__/support/local-db";
import { claimOwedAttempt, giveUpOwedBody, OWED_BODY_MAX_ATTEMPTS, recordOwedBody, resumeOwedBodies, topUpOwedBudget } from "../owed-bodies";
import { openRunBudget, runBudget } from "@/lib/billing/run-budget";

const STACK = await connectLocalStack();
const TAG = randomUUID().slice(0, 8);
const PASSWORD = `Owed-${TAG}-local-1!`;

const OUTLINE = {
  version: 1 as const,
  title: "Acme kits: how to choose one",
  sections: ["Key takeaways", "What is in a kit?", "How to choose one"],
  closing: null,
  targetWordCount: 1300,
  sources: [],
  model: "test",
  createdAt: "2026-10-11T00:00:00.000Z",
};

describe.skipIf(!STACK)("owed first-article bodies on the local database", () => {
  let admin: SupabaseClient;
  const users: Record<"owner" | "editor", { id: string; client: SupabaseClient }> = {} as never;
  let account = "";
  let site = "";
  let article = "";
  let run = "";

  async function user(name: string): Promise<{ id: string; client: SupabaseClient }> {
    const email = `acme-owed-${TAG}-${name}@example.test`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error || !data.user) throw new Error(`user: ${error?.message}`);
    const client = createClient(STACK!.url, STACK!.anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    if (signInError) throw new Error(`sign in: ${signInError.message}`);
    return { id: data.user.id, client };
  }
  const must = (r: { data: unknown; error: { message: string } | null }, what: string): Record<string, unknown> => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return (r.data ?? {}) as Record<string, unknown>;
  };

  beforeAll(async () => {
    admin = createClient(STACK!.url, STACK!.service, { auth: { persistSession: false, autoRefreshToken: false } });
    users.owner = await user("owner");
    users.editor = await user("editor");
    account = must(await admin.from("accounts").insert({ name: `Acme owed ${TAG}`, slug: `acme-owed-${TAG}` }).select("id").single(), "account").id as string;
    must(await admin.from("account_members").insert([
      { account_id: account, user_id: users.owner.id, role: "owner" },
      { account_id: account, user_id: users.editor.id, role: "editor" },
    ]), "members");
    site = must(await admin.from("workspaces").insert({ account_id: account, name: `acme-${TAG}.example`, domain: `acme-${TAG}.example`, initials: "AC", color: "av-c1" }).select("id").single(), "site").id as string;
    // The first article, already written: what an owner would try to re-arm.
    article = must(await admin.from("articles").insert({
      workspace_id: site, title: OUTLINE.title, slug: `acme-kits-${TAG}`, keyword: "acme kits", status: "review", word_count: 1200,
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }] },
    }).select("id").single(), "article").id as string;
    run = must(await admin.from("onboarding_runs").insert({ workspace_id: site, account_id: account, status: "done" }).select("id").single(), "run").id as string;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.from("system_events").delete().eq("workspace_id", site);
    if (account) await admin.from("accounts").delete().eq("id", account);
    for (const u of Object.values(users)) if (u?.id) await admin.auth.admin.deleteUser(u.id);
  }, 60_000);

  it("keeps owed_bodies from every client token", async () => {
    const read = await users.owner.client.from("owed_bodies").select("article_id");
    expect(read.error?.message).toMatch(/permission denied/);
    const write = await users.owner.client.from("owed_bodies").insert({ article_id: article, workspace_id: site, keyword: "anything", outline: OUTLINE });
    expect(write.error?.message).toMatch(/permission denied/);
  });

  it("buys nothing for a first article the owner made look owed", async () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const forged = await users.owner.client.from("articles").update({
      status: "drafting", content: null, keyword: "acme anything else",
      instructions_snapshot: { outline: OUTLINE }, created_at: new Date().toISOString(), updated_at: past,
    }).eq("id", article);
    // The row is the owner's to write - that is the point: none of it counts.
    expect(forged.error).toBeNull();
    const sent: unknown[] = [];
    const sweep = await resumeOwedBodies(admin, { baseUrl: "https://app.example", secret: "s", fetchImpl: (async (url: string, init: { body: string }) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response("{}"); }) as never });
    await sweep.settled;
    expect(sweep.dispatched).not.toContain(article);
    expect(sent.filter((s) => JSON.stringify(s).includes(article))).toEqual([]);
    expect(await claimOwedAttempt(admin, article, site)).toEqual({ kind: "none" });
    await admin.from("articles").update({ status: "review" }).eq("id", article);
  });

  it("refuses body_stream to a member's client, and leaves the rest of the row writable", async () => {
    const stream = await users.editor.client.from("articles").update({ body_stream: "<p>hi</p><img/src=x/onerror=alert(1)>" }).eq("id", article);
    expect(stream.error?.message).toMatch(/server only/);
    const title = await users.editor.client.from("articles").update({ title: `${OUTLINE.title} (edited)` }).eq("id", article);
    expect(title.error).toBeNull();
    const inserted = await users.editor.client.from("articles").insert({ workspace_id: site, title: "x", slug: `x-${TAG}`, keyword: "x", status: "drafting", body_stream: "<p>x</p>" });
    expect(inserted.error?.message).toMatch(/server only|permission denied|row-level/);
    // The server writes it as before.
    expect((await admin.from("articles").update({ body_stream: "<p>ok</p>" }).eq("id", article)).error).toBeNull();
    const row = must(await admin.from("articles").select("body_stream").eq("id", article).single(), "row");
    expect(row.body_stream).toBe("<p>ok</p>");
    await admin.from("articles").update({ body_stream: null }).eq("id", article);
  });

  it("claims each try once, and gives a spent body up", async () => {
    const owedArticle = must(await admin.from("articles").insert({ workspace_id: site, title: OUTLINE.title, slug: `owed-${TAG}`, keyword: "acme kits", status: "drafting" }).select("id").single(), "owed").id as string;
    expect(await recordOwedBody(admin, { articleId: owedArticle, workspaceId: site, runId: run, keyword: "acme kits", keywordId: null, outline: OUTLINE })).toBe(true);
    const [a, b] = await Promise.all([claimOwedAttempt(admin, owedArticle, site), claimOwedAttempt(admin, owedArticle, site)]);
    // Two requests for the same try: one wins it.
    expect([a.kind, b.kind].sort()).toEqual(["claimed", "none"]);
    const won = a.kind === "claimed" ? a : b;
    if (won.kind !== "claimed") throw new Error("no claim");
    expect(won.body).toMatchObject({ attempts: 2, keyword: "acme kits", runId: run, outline: OUTLINE });
    // Another site cannot claim it.
    expect(await claimOwedAttempt(admin, owedArticle, randomUUID())).toEqual({ kind: "none" });

    await admin.from("owed_bodies").update({ attempts: OWED_BODY_MAX_ATTEMPTS }).eq("article_id", owedArticle);
    const spent = await claimOwedAttempt(admin, owedArticle, site);
    expect(spent.kind).toBe("spent");
    if (spent.kind === "spent") await giveUpOwedBody(admin, spent.body, "test");
    const after = must(await admin.from("articles").select("status").eq("id", owedArticle).single(), "after");
    expect(after.status).toBe("error");
    expect((await admin.from("owed_bodies").select("article_id").eq("article_id", owedArticle)).data).toEqual([]);
  });

  it("tops the run's budget up to a writer's minimum once, and only once", async () => {
    const owedArticle = must(await admin.from("articles").insert({ workspace_id: site, title: OUTLINE.title, slug: `topup-${TAG}`, keyword: "acme kits", status: "drafting" }).select("id").single(), "owed").id as string;
    expect(await recordOwedBody(admin, { articleId: owedArticle, workspaceId: site, runId: run, keyword: "acme kits", keywordId: null, outline: OUTLINE })).toBe(true);
    const budget = await openRunBudget(admin, { runId: run, workspaceId: site }, { ceilingUsd: 1, reserves: { draft: 0.33 } });
    if (!budget) throw new Error("no budget");
    // A billed body that was thrown away: $0.79 spent, $0.21 left.
    expect(await budget.claim("draft", 0.79, 0.79)).toBeCloseTo(0.79, 6);
    const room = (await budget.room("draft"))!;
    expect(room).toBeCloseTo(0.21, 6);
    const claim = await claimOwedAttempt(admin, owedArticle, site);
    if (claim.kind !== "claimed") throw new Error("no claim");
    expect(await topUpOwedBudget(admin, claim.body, room, 0.33)).toBe(true);
    expect(await runBudget(admin, run).room("draft")).toBeCloseTo(0.33, 6);
    // The second try of the same body gets no more.
    const again = await claimOwedAttempt(admin, owedArticle, site);
    if (again.kind !== "claimed") throw new Error("no claim");
    expect(again.body.allowanceUsd).toBeCloseTo(0.12, 6);
    expect(await topUpOwedBudget(admin, again.body, 0.0, 0.33)).toBe(false);
    expect(await topUpOwedBudget(admin, { ...again.body, allowanceUsd: 0 }, 0.0, 0.33)).toBe(false);
    const row = must(await admin.from("run_budgets").select("ceiling_usd").eq("run_id", run).single(), "budget");
    expect(Number(row.ceiling_usd)).toBeCloseTo(1.12, 6);
  });
});

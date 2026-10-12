// ---------------------------------------------------------------------------
// The first look's gate, on the local database: the outline card, the body
// the gate may show, and who may read it
// ---------------------------------------------------------------------------
//
// Against PostgREST and Postgres themselves, with signed-in clients, because
// what is being pinned is what the database hands a client token:
//
// - the gate's card for an outlined first article is read through the
//   owner's own client (instructions_snapshot is not a body column), and
//   carries the outline and none of the text;
// - `articles.body_stream` (migration 107) is refused to a client token like
//   the other body columns (097);
// - the full-article reader (PRETRIAL_FULL_ARTICLE) hands the text only to
//   the owner of the site, only for the run's first article, only with the
//   switch on - streamed while being written, saved once done - and refuses
//   another account's owner, a member who is not the owner, and an article
//   that is not the run's first;
// - a run that ended at its gate takes the body's sentence later
//   (`stampRun` with `amend`) without changing its status.
//
// Seeds two accounts with invented names (acme-*.example, *.example.test
// addresses with a password made up here) and deletes them at the end.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { connectLocalStack } from "@/lib/__tests__/support/local-db";
import { loadFirstArticle } from "../first-article";
import { readFirstArticleBody, readFirstArticleProgress } from "../first-article-body";
import { stampRun } from "../run-store";

const STACK = await connectLocalStack();
const TAG = randomUUID().slice(0, 8);
const PASSWORD = `Gate-${TAG}-local-1!`;
const ON = { PRETRIAL_FULL_ARTICLE: "1" };
const OFF = {};

const OUTLINE = {
  version: 1,
  title: "Acme kits: how to choose one",
  sections: ["Key takeaways", "What is in a kit?", "How to choose one", "Frequently asked questions"],
  closing: "Learn more about Acme",
  targetWordCount: 1300,
  sources: ["https://stats.example/a", "https://gov.example/b"],
  model: "test",
  createdAt: "2026-10-11T00:00:00.000Z",
};
const SECRET = `The secret body sentence ${TAG}.`;

describe.skipIf(!STACK)("the first look's gate on the local database", () => {
  let admin: SupabaseClient;
  const users: Record<"aOwner" | "aEditor" | "bOwner", { id: string; client: SupabaseClient }> = {} as never;
  let accountA = "";
  let accountB = "";
  let siteA = "";
  let siteB = "";
  let articleA = "";
  let laterA = "";
  let runA = "";

  async function user(name: string): Promise<{ id: string; client: SupabaseClient }> {
    const email = `acme-gate-${TAG}-${name.toLowerCase()}@example.test`;
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
    users.aOwner = await user("aOwner");
    users.aEditor = await user("aEditor");
    users.bOwner = await user("bOwner");
    accountA = must(await admin.from("accounts").insert({ name: `Acme gate A ${TAG}`, slug: `acme-gate-a-${TAG}` }).select("id").single(), "account A").id as string;
    accountB = must(await admin.from("accounts").insert({ name: `Acme gate B ${TAG}`, slug: `acme-gate-b-${TAG}` }).select("id").single(), "account B").id as string;
    must(await admin.from("account_members").insert([
      { account_id: accountA, user_id: users.aOwner.id, role: "owner" },
      { account_id: accountA, user_id: users.aEditor.id, role: "editor" },
      { account_id: accountB, user_id: users.bOwner.id, role: "owner" },
    ]), "members");
    siteA = must(await admin.from("workspaces").insert({ account_id: accountA, name: `acme-${TAG}-a.example`, domain: `acme-${TAG}-a.example`, initials: "AC", color: "av-c1" }).select("id").single(), "site A").id as string;
    siteB = must(await admin.from("workspaces").insert({ account_id: accountB, name: `acme-${TAG}-b.example`, domain: `acme-${TAG}-b.example`, initials: "AC", color: "av-c1" }).select("id").single(), "site B").id as string;
    // The first article, outlined and being written; a later one beside it.
    articleA = must(await admin.from("articles").insert({
      workspace_id: siteA, title: OUTLINE.title, slug: `acme-kits-${TAG}`, keyword: "acme kits", status: "drafting",
      instructions_snapshot: { outline: OUTLINE, targetWordCount: 1300 }, body_stream: `<h1>${OUTLINE.title}</h1><p>${SECRET}</p><h2>Key takeaways</h2>`,
    }).select("id").single(), "article A").id as string;
    laterA = must(await admin.from("articles").insert({
      workspace_id: siteA, title: "Later", slug: `later-${TAG}`, keyword: "later", status: "review", word_count: 900,
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "later body" }] }] },
    }).select("id").single(), "later A").id as string;
    // Every phase written, as the worker leaves the row before the draft route stamps it.
    const phases = ["scanning", "keywords", "pages", "planning"].map((phase) => ({ phase, status: "done" })).concat([{ phase: "drafting", status: "active" }]);
    runA = must(await admin.from("onboarding_runs").insert({ workspace_id: siteA, account_id: accountA, phases }).select("id").single(), "run A").id as string;
    must(await admin.from("onboarding_runs").insert({ workspace_id: siteB, account_id: accountB }).select("id").single(), "run B");
    // The run ended at its gate, pointing at the outlined article.
    const stamped = await stampRun(admin, runA, { phase: "drafting", status: "done", detail: "Outlined it. The full text is being written now." }, {
      finish: true,
      article: { id: articleA, title: OUTLINE.title, keyword: "acme kits", wordCount: 1300, verdict: "unchecked", outlined: true },
    });
    if (!stamped) throw new Error("gate stamp did not land");
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.from("system_events").delete().in("workspace_id", [siteA, siteB].filter(Boolean));
    for (const id of [accountA, accountB].filter(Boolean)) await admin.from("accounts").delete().eq("id", id);
    for (const u of Object.values(users)) if (u?.id) await admin.auth.admin.deleteUser(u.id);
  }, 60_000);

  it("shows the owner the outlined card, read through their own client, with none of the text", async () => {
    const fact = await loadFirstArticle(users.aOwner.client, siteA, `acme-${TAG}-a.example`);
    // The later written article is the card once one exists before it; here
    // the outlined first article is older, so the written one wins only if
    // it is the oldest written. The card is the oldest written article:
    expect(fact.article?.id).toBe(laterA);
    // With the written one gone, the outlined first article is the card.
    await admin.from("articles").update({ status: "error" }).eq("id", laterA);
    const outlined = await loadFirstArticle(users.aOwner.client, siteA, `acme-${TAG}-a.example`);
    expect(outlined.writing).toBe(true);
    expect(outlined.article).toMatchObject({
      id: articleA,
      state: "outlined",
      title: OUTLINE.title,
      outline: [...OUTLINE.sections, OUTLINE.closing],
      wordCount: 1300,
      sources: 2,
      verdict: null,
    });
    expect(JSON.stringify(outlined)).not.toContain(SECRET);
  });

  it("tells the owner how far the body has got with the text locked: counts only, refused to anyone else", async () => {
    // What the draft route keeps while it writes (migration 108), beside the streamed text.
    const since = new Date(Date.now() - 4_000).toISOString();
    must(await admin.from("articles").update({ body_progress: { v: 1, stage: "writing", since, sections: 3, words: 240 } }).eq("id", articleA).select("id"), "progress");
    const read = await readFirstArticleProgress(users.aOwner.client, users.aOwner.id, siteA, { service: admin });
    expect(read).toMatchObject({ ok: true, articleId: articleA, done: false, stage: "writing", sections: OUTLINE.sections.length + 1, sectionsDone: [0, 1], words: 240 });
    if (read.ok) expect(read.stageMs).toBeGreaterThanOrEqual(3_000);
    // No text of any kind: not the stream, not a heading, not the title.
    const wire = JSON.stringify(read);
    for (const secret of [SECRET, OUTLINE.title, ...OUTLINE.sections]) expect(wire).not.toContain(secret);
    // Refused like the text: another account, a member who is not the owner.
    expect(await readFirstArticleProgress(users.bOwner.client, users.bOwner.id, siteA, { service: admin })).toEqual({ ok: false, reason: "not-found" });
    expect(await readFirstArticleProgress(users.aEditor.client, users.aEditor.id, siteA, { service: admin })).toEqual({ ok: false, reason: "not-owner" });
    // A client token can neither read the record nor write one.
    const { error: readError } = await users.aOwner.client.from("articles").select("id, body_progress").eq("id", articleA);
    expect(readError?.message).toMatch(/permission denied/);
    const { error: writeError } = await users.aOwner.client.from("articles").update({ body_progress: { v: 1, stage: "finishing", since, sections: 9, words: 9999 } }).eq("id", articleA);
    expect(writeError?.message).toMatch(/server only/);
    must(await admin.from("articles").update({ body_progress: null }).eq("id", articleA).select("id"), "clear progress");
  });

  it("refuses body_stream to a client token, like every body column", async () => {
    const { error } = await users.aOwner.client.from("articles").select("id, body_stream").eq("id", articleA);
    expect(error?.message).toMatch(/permission denied/);
  });

  it("hands the owner their first article as it is written, cleaned, only with the switch on", async () => {
    expect(await readFirstArticleBody(users.aOwner.client, users.aOwner.id, siteA, { env: OFF, service: admin })).toEqual({ ok: false, reason: "off" });
    const streaming = await readFirstArticleBody(users.aOwner.client, users.aOwner.id, siteA, { env: ON, service: admin });
    expect(streaming).toMatchObject({ ok: true, articleId: articleA, done: false });
    if (!streaming.ok) throw new Error("refused");
    expect(streaming.html).toContain(SECRET);
    expect(streaming.html).not.toContain("<h1");
    // Saved: the body, not the stream.
    await admin.from("articles").update({
      status: "review", word_count: 1290, body_stream: null,
      content: { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Key takeaways" }] }, { type: "paragraph", content: [{ type: "text", text: `Saved ${SECRET}` }] }] },
    }).eq("id", articleA);
    const saved = await readFirstArticleBody(users.aOwner.client, users.aOwner.id, siteA, { env: ON, service: admin });
    expect(saved).toMatchObject({ ok: true, done: true });
    if (saved.ok) expect(saved.html).toContain(`Saved ${SECRET}`);
  });

  it("refuses another account's owner, a member who is not the owner, and a site whose run points elsewhere", async () => {
    expect(await readFirstArticleBody(users.bOwner.client, users.bOwner.id, siteA, { env: ON, service: admin })).toEqual({ ok: false, reason: "not-found" });
    expect(await readFirstArticleBody(users.aEditor.client, users.aEditor.id, siteA, { env: ON, service: admin })).toEqual({ ok: false, reason: "not-owner" });
    // B's own site: its run has no first article, so nothing - not A's.
    expect(await readFirstArticleBody(users.bOwner.client, users.bOwner.id, siteB, { env: ON, service: admin })).toEqual({ ok: false, reason: "no-first-article" });
    // A run pointing at an article that is not the site's first is refused.
    await admin.from("articles").update({ status: "review" }).eq("id", laterA);
    await admin.from("onboarding_runs").update({ article_id: laterA }).eq("id", runA);
    expect(await readFirstArticleBody(users.aOwner.client, users.aOwner.id, siteA, { env: ON, service: admin })).toEqual({ ok: false, reason: "no-first-article" });
    await admin.from("onboarding_runs").update({ article_id: articleA }).eq("id", runA);
  });

  it("lets a run that ended at its gate take the body's sentence, and nothing else", async () => {
    const before = must(await admin.from("onboarding_runs").select("status, finished_at, phases").eq("id", runA).single(), "run") as unknown as { status: string; finished_at: string; phases: Array<{ phase: string; detail?: string }> };
    // No plan was seeded beside the article, so the gate settled it partial.
    expect(["done", "partial"]).toContain(before.status);
    expect(await stampRun(admin, runA, { phase: "drafting", status: "done", detail: "Wrote 1,290 words." }, { finish: true, amend: true })).toBe(true);
    const after = must(await admin.from("onboarding_runs").select("status, finished_at, phases").eq("id", runA).single(), "run") as unknown as typeof before;
    expect(after.status).toBe(before.status);
    expect(after.finished_at).toBe(before.finished_at);
    expect(after.phases.find((p) => p.phase === "drafting")?.detail).toBe("Wrote 1,290 words.");
    // Without `amend` a finished run is left alone, as before.
    expect(await stampRun(admin, runA, { phase: "drafting", status: "failed", detail: "late" }, { finish: true })).toBe(false);
  });
});

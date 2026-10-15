// ---------------------------------------------------------------------------
// The first look's exits and its outage retry, on the local database
// ---------------------------------------------------------------------------
//
// Pinned against PostgREST and Postgres themselves, because the queries are
// what could be wrong:
//
// - the overnight retry (lib/onboarding/provider-retry.ts) reads finished
//   runs by status and finish time, starts a new run only for a provider-down
//   one that is the site's latest and has no article, and leaves every other
//   run alone;
// - "Email me this article" (lib/email/first-look-exits.ts) claims one row in
//   `sent_emails` per article and owner, and its daily cap counts those rows.
//
// The spend gate and the dispatch are stubbed: nothing is bought, nothing is
// sent anywhere (the transport is mocked). Seeds are b17- with acme-*.example
// domains, deleted at the end.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { connectLocalStack } from "@/lib/__tests__/support/local-db";

const sendTransactionalEmail = vi.fn(async () => undefined);
vi.mock("@/lib/email/resend", () => ({ sendTransactionalEmail }));

const STACK = await connectLocalStack();
const TAG = randomUUID().slice(0, 8);

const { retryProviderDownRuns, PROVIDER_RETRY_AFTER_MS } = await import("../provider-retry");
const { FIRST_ARTICLE_LINK, FIRST_ARTICLE_LINK_DAILY_CAP, sendFirstArticleLink } = await import("@/lib/email/first-look-exits");

const PROVIDER_PHASES = [
  { phase: "scanning", status: "done" },
  { phase: "keywords", status: "failed", cause: "provider", detail: "Our search-data provider did not answer." },
  { phase: "planning", status: "skipped" },
  { phase: "drafting", status: "skipped" },
];

describe.skipIf(!STACK)("the first look's exits and outage retry on the local database", () => {
  let admin: SupabaseClient;
  let account = "";
  const sites: Record<"down" | "other" | "written", string> = { down: "", other: "", written: "" };
  const owner = `b17-exits-${TAG}@example.test`;

  beforeAll(async () => {
    admin = createClient(STACK!.url, STACK!.service, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: acc, error } = await admin.from("accounts").insert({ name: `b17 exits ${TAG}`, slug: `b17-exits-${TAG}` }).select("id").single();
    if (error || !acc) throw new Error(`account: ${error?.message}`);
    account = acc.id as string;
    for (const key of Object.keys(sites) as (keyof typeof sites)[]) {
      const domain = `acme-b17-${TAG}-${key}.example`;
      const { data: ws, error: wsError } = await admin.from("workspaces").insert({ account_id: account, name: domain, domain, initials: "AC", color: "av-c1" }).select("id").single();
      if (wsError || !ws) throw new Error(`site: ${wsError?.message}`);
      sites[key] = ws.id as string;
    }
    const finished = new Date(Date.now() - PROVIDER_RETRY_AFTER_MS - 5 * 60_000).toISOString();
    const run = (workspace: string, phases: unknown) => ({ workspace_id: workspace, account_id: account, status: "partial", phases, planned: [], started_at: finished, updated_at: finished, finished_at: finished });
    const { error: runsError } = await admin.from("onboarding_runs").insert([
      run(sites.down, PROVIDER_PHASES),
      run(sites.other, [{ phase: "keywords", status: "failed", detail: "Your site could not be read (timeout)." }]),
      run(sites.written, PROVIDER_PHASES),
    ]);
    if (runsError) throw new Error(`runs: ${runsError.message}`);
    const { error: articleError } = await admin.from("articles").insert({ workspace_id: sites.written, title: "Acme", slug: `acme-${TAG}`, keyword: "acme", status: "review" });
    if (articleError) throw new Error(`article: ${articleError.message}`);
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.from("sent_emails").delete().eq("recipient", owner);
    if (account) await admin.from("accounts").delete().eq("id", account);
  }, 60_000);

  it("starts one run, for the provider-down site with no article, and only there", async () => {
    const dispatched: string[] = [];
    const out = await retryProviderDownRuns(admin, Date.now(), { allowed: async (_db, acc) => acc === account, dispatch: async (id) => void dispatched.push(id) });
    const mine = out.filter((o) => Object.values(sites).includes(o.workspaceId));
    expect(mine.find((o) => o.workspaceId === sites.down)?.runId).toBeTruthy();
    expect(mine.find((o) => o.workspaceId === sites.written)).toEqual({ workspaceId: sites.written, skipped: "has an article" });
    expect(mine.find((o) => o.workspaceId === sites.other)).toBeUndefined();
    const { data: runs } = await admin.from("onboarding_runs").select("id, status").eq("workspace_id", sites.down);
    expect(runs?.length).toBe(2);
    expect(dispatched).toContain(mine.find((o) => o.workspaceId === sites.down)!.runId);
    // The next night it is no longer the site's latest provider-down run.
    const again = await retryProviderDownRuns(admin, Date.now(), { allowed: async () => true, dispatch: async () => undefined });
    expect(again.find((o) => o.workspaceId === sites.down)).toBeUndefined();
  });

  it("claims one ledger row per article and owner, and its daily cap counts them", async () => {
    const a = { domain: "acme-b17.example", title: "Acme", accountId: account, workspaceId: sites.written };
    expect(await sendFirstArticleLink(admin, owner, { ...a, articleId: `a1-${TAG}` })).toMatchObject({ sent: 1 });
    expect(await sendFirstArticleLink(admin, owner, { ...a, articleId: `a1-${TAG}` })).toMatchObject({ sent: 0, skipped: 1 });
    for (let i = 2; i <= FIRST_ARTICLE_LINK_DAILY_CAP; i++) await sendFirstArticleLink(admin, owner, { ...a, articleId: `a${i}-${TAG}` });
    expect(await sendFirstArticleLink(admin, owner, { ...a, articleId: `a9-${TAG}` })).toMatchObject({ sent: 0, capped: true });
    const { count } = await admin.from("sent_emails").select("subject_id", { count: "exact", head: true }).eq("email_type", FIRST_ARTICLE_LINK).eq("recipient", owner);
    expect(count).toBe(FIRST_ARTICLE_LINK_DAILY_CAP);
  });
});

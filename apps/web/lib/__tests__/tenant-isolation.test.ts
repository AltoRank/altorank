// ---------------------------------------------------------------------------
// Two real tenants, through the same endpoint the browser holds
// ---------------------------------------------------------------------------
//
// AltoRank has two boundaries that look like one: an *account* is the account,
// a *workspace* is one site, and a member can be restricted to some of the
// sites (`account_members.workspace_ids`). Seven wrong-number bugs came from
// treating the second as if the first covered it.
//
// The dashboard talks to Supabase with the anon key and the visitor's session,
// which means every RLS policy is a public API: whatever a page chooses to
// query, the person on the other side can query anything else the policy
// allows, straight at /rest/v1. So this suite does not call the pages. It
// seeds two accounts with two sites each and a member restricted to one site,
// signs them in for real, and asks the database directly - which is the
// question an attacker asks.
//
// It needs the local Supabase stack (`.env.development.local`, 127.0.0.1:54331
// by default) and skips itself when that is not answering, so `npm test` stays
// green on a machine without Docker.

import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// --- Environment -------------------------------------------------------------

function loadEnv(): { url: string; anon: string; service: string } | null {
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const file of [".env.development.local", ".env.local"]) {
    try {
      const text = readFileSync(path.resolve(__dirname, "../..", file), "utf8");
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {
      // Absent is fine; the next check decides whether we can run.
    }
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) return null;
  return { url, anon, service };
}

async function reachable(url: string, anon: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/auth/v1/health`, {
      headers: { apikey: anon },
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const ENV = loadEnv();
const LIVE = ENV ? await reachable(ENV.url, ENV.anon) : false;

// --- Fixture -----------------------------------------------------------------

const PASSWORD = "Tenant-Isolation-1!";
const PEOPLE = {
  aOwner: "tenant-iso-a-owner@example.test",
  aEditor: "tenant-iso-a-editor@example.test",
  bOwner: "tenant-iso-b-owner@example.test",
} as const;

type Fixture = {
  admin: SupabaseClient;
  /** Signed-in clients: exactly what the dashboard holds. */
  as: Record<keyof typeof PEOPLE, SupabaseClient>;
  accountA: string;
  accountB: string;
  /** A1 is the only site the restricted editor may see. */
  a1: string;
  a2: string;
  b1: string;
  articleA2: string;
  articleB1: string;
};

let fx: Fixture;

async function userId(admin: SupabaseClient, email: string): Promise<string> {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const found = list?.users.find((u) => u.email === email);
  if (found) {
    await admin.auth.admin.updateUserById(found.id, { password: PASSWORD, email_confirm: true });
    return found.id;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`Could not create ${email}: ${error?.message}`);
  return data.user.id;
}

async function signIn(url: string, anon: string, email: string): Promise<SupabaseClient> {
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`Could not sign in ${email}: ${error.message}`);
  return client;
}

async function seed(env: NonNullable<typeof ENV>): Promise<Fixture> {
  const admin = createClient(env.url, env.service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  await teardown(admin);

  const ids = {
    aOwner: await userId(admin, PEOPLE.aOwner),
    aEditor: await userId(admin, PEOPLE.aEditor),
    bOwner: await userId(admin, PEOPLE.bOwner),
  };

  const { data: accounts, error: accountErr } = await admin
    .from("accounts")
    .insert([
      { name: "Tenant Iso A", slug: "tenant-iso-a" },
      { name: "Tenant Iso B", slug: "tenant-iso-b" },
    ])
    .select("id, slug");
  if (accountErr || !accounts) throw new Error(`accounts: ${accountErr?.message}`);
  const accountA = accounts.find((a) => a.slug === "tenant-iso-a")!.id as string;
  const accountB = accounts.find((a) => a.slug === "tenant-iso-b")!.id as string;

  const { data: workspaces, error: wsErr } = await admin
    .from("workspaces")
    .insert([
      { account_id: accountA, name: "A One", domain: "tenant-iso-a1.test", initials: "A1", color: "av-c1" },
      { account_id: accountA, name: "A Two", domain: "tenant-iso-a2.test", initials: "A2", color: "av-c1" },
      { account_id: accountB, name: "B One", domain: "tenant-iso-b1.test", initials: "B1", color: "av-c1" },
    ])
    .select("id, domain");
  if (wsErr || !workspaces) throw new Error(`workspaces: ${wsErr?.message}`);
  const byDomain = (d: string) => workspaces.find((w) => w.domain === d)!.id as string;
  const a1 = byDomain("tenant-iso-a1.test");
  const a2 = byDomain("tenant-iso-a2.test");
  const b1 = byDomain("tenant-iso-b1.test");

  const { error: memberErr } = await admin.from("account_members").insert([
    { account_id: accountA, user_id: ids.aOwner, role: "owner", workspace_ids: null },
    // The whole point of the fixture: an editor who may see A One and nothing else.
    { account_id: accountA, user_id: ids.aEditor, role: "editor", workspace_ids: [a1] },
    { account_id: accountB, user_id: ids.bOwner, role: "owner", workspace_ids: null },
  ]);
  if (memberErr) throw new Error(`account_members: ${memberErr.message}`);

  const { data: articles, error: artErr } = await admin
    .from("articles")
    .insert([
      { workspace_id: a1, title: "A1 draft", slug: "tenant-iso-a1", status: "draft" },
      { workspace_id: a2, title: "A2 draft", slug: "tenant-iso-a2", status: "draft" },
      { workspace_id: b1, title: "B1 draft", slug: "tenant-iso-b1", status: "draft" },
    ])
    .select("id, slug");
  if (artErr || !articles) throw new Error(`articles: ${artErr?.message}`);

  await admin.from("keywords").insert([
    { workspace_id: a1, term: "tenant iso a1" },
    { workspace_id: a2, term: "tenant iso a2" },
    { workspace_id: b1, term: "tenant iso b1" },
  ]);
  await admin.from("api_keys").insert([
    { account_id: accountA, name: "iso A", key_hash: "tenant-iso-hash-a", prefix: "altorank_live_isoA" },
    { account_id: accountB, name: "iso B", key_hash: "tenant-iso-hash-b", prefix: "altorank_live_isoB" },
  ]);
  await admin.from("invites").insert({
    account_id: accountA,
    email: "tenant-iso-invitee@example.test",
    token: "tenant-iso-invite-token",
    invited_by: ids.aOwner,
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });

  return {
    admin,
    as: {
      aOwner: await signIn(env.url, env.anon, PEOPLE.aOwner),
      aEditor: await signIn(env.url, env.anon, PEOPLE.aEditor),
      bOwner: await signIn(env.url, env.anon, PEOPLE.bOwner),
    },
    accountA,
    accountB,
    a1,
    a2,
    b1,
    articleA2: articles.find((a) => a.slug === "tenant-iso-a2")!.id as string,
    articleB1: articles.find((a) => a.slug === "tenant-iso-b1")!.id as string,
  };
}

async function teardown(admin: SupabaseClient): Promise<void> {
  // Accounts cascade to workspaces, members, keys, invites and every child row.
  await admin.from("accounts").delete().in("slug", ["tenant-iso-a", "tenant-iso-b"]);
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of list?.users ?? []) {
    if (u.email && Object.values(PEOPLE).includes(u.email as (typeof PEOPLE)[keyof typeof PEOPLE])) {
      await admin.auth.admin.deleteUser(u.id);
    }
  }
}

// --- Suite -------------------------------------------------------------------

describe.skipIf(!LIVE)("tenant isolation, as two signed-in accounts", () => {
  beforeAll(async () => {
    fx = await seed(ENV!);
  }, 60_000);

  afterAll(async () => {
    if (fx?.admin) await teardown(fx.admin);
  }, 30_000);

  // --- Across accounts ------------------------------------------------------

  describe("account A cannot reach account B", () => {
    const perWorkspace = [
      "articles",
      "keywords",
      "calendar_entries",
      "publish_log",
      "refresh_candidates",
      "refresh_tasks",
      "refresh_executions",
      "reports",
      "domain_audits",
      "analytics_metrics",
      "workspace_metrics",
      "provider_spend",
      "geo_prompts",
      "geo_results",
      "site_pages",
      "voice_profiles",
      "generation_jobs",
      "link_sources",
      "link_targets",
      "workspace_output_settings",
      "publishing_cadences",
      "keyword_research_runs",
      "backlinks",
      "webhook_deliveries",
      "workspace_integrations",
    ] as const;

    it.each(perWorkspace)("%s: naming B's workspace returns nothing", async (table) => {
      const { data, error } = await fx.as.aOwner.from(table).select("*").eq("workspace_id", fx.b1);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("workspaces: B's site is invisible and unreadable by id", async () => {
      const { data } = await fx.as.aOwner.from("workspaces").select("id").eq("id", fx.b1);
      expect(data).toEqual([]);
    });

    it("articles: B's draft cannot be read by id", async () => {
      const { data } = await fx.as.aOwner.from("articles").select("id").eq("id", fx.articleB1);
      expect(data).toEqual([]);
    });

    it("articles: B's draft cannot be edited by id", async () => {
      await fx.as.aOwner.from("articles").update({ title: "taken over" }).eq("id", fx.articleB1);
      const { data } = await fx.admin.from("articles").select("title").eq("id", fx.articleB1).single();
      expect(data?.title).toBe("B1 draft");
    });

    it("articles: A cannot insert into B's workspace", async () => {
      const { error } = await fx.as.aOwner
        .from("articles")
        .insert({ workspace_id: fx.b1, title: "planted", slug: "tenant-iso-planted" });
      expect(error).not.toBeNull();
    });

    it.each(["api_keys", "invites", "invoices", "account_integrations", "backlink_credits"] as const)(
      "%s: naming B's account returns nothing",
      async (table) => {
        const { data } = await fx.as.aOwner.from(table).select("*").eq("account_id", fx.accountB);
        expect(data ?? []).toEqual([]);
      },
    );

    it("accounts: B's account row is invisible and unwritable", async () => {
      const { data } = await fx.as.aOwner.from("accounts").select("id").eq("id", fx.accountB);
      expect(data).toEqual([]);
      await fx.as.aOwner.from("accounts").update({ name: "taken over" }).eq("id", fx.accountB);
      const { data: after } = await fx.admin.from("accounts").select("name").eq("id", fx.accountB).single();
      expect(after?.name).toBe("Tenant Iso B");
    });

    it("account_members: B's roster is invisible, and A cannot join B", async () => {
      const { data } = await fx.as.aOwner.from("account_members").select("id").eq("account_id", fx.accountB);
      expect(data).toEqual([]);
      const { data: me } = await fx.as.aOwner.auth.getUser();
      const { error } = await fx.as.aOwner
        .from("account_members")
        .insert({ account_id: fx.accountB, user_id: me.user!.id, role: "owner" });
      expect(error).not.toBeNull();
    });
  });

  // --- Across sites inside one account --------------------------------------

  describe("an editor restricted to A One cannot reach A Two", () => {
    it("sees only the one site", async () => {
      const { data } = await fx.as.aEditor.from("workspaces").select("id");
      expect((data ?? []).map((w) => w.id)).toEqual([fx.a1]);
    });

    it("cannot read A Two's draft by id", async () => {
      const { data } = await fx.as.aEditor.from("articles").select("id").eq("id", fx.articleA2);
      expect(data).toEqual([]);
    });

    it("cannot edit A Two's draft by id", async () => {
      await fx.as.aEditor.from("articles").update({ title: "taken over" }).eq("id", fx.articleA2);
      const { data } = await fx.admin.from("articles").select("title").eq("id", fx.articleA2).single();
      expect(data?.title).toBe("A2 draft");
    });

    it("cannot write into A Two", async () => {
      const { error } = await fx.as.aEditor
        .from("articles")
        .insert({ workspace_id: fx.a2, title: "planted", slug: "tenant-iso-planted-2" });
      expect(error).not.toBeNull();
    });

    it("cannot widen its own access or promote itself", async () => {
      const { data: me } = await fx.as.aEditor.auth.getUser();
      await fx.as.aEditor.from("account_members").update({ workspace_ids: null }).eq("user_id", me.user!.id);
      await fx.as.aEditor.from("account_members").update({ role: "owner" }).eq("user_id", me.user!.id);
      const { data: row } = await fx.admin
        .from("account_members")
        .select("role, workspace_ids")
        .eq("user_id", me.user!.id)
        .single();
      expect(row?.role).toBe("editor");
      expect(row?.workspace_ids).toEqual([fx.a1]);
    });
  });

  // --- Least privilege on the account-scoped tables (migration 072) -----------

  describe("account-scoped tables are admin-only to write", () => {
    it("an editor cannot mint an account-wide API key", async () => {
      const { error } = await fx.as.aEditor.from("api_keys").insert({
        account_id: fx.accountA,
        name: "self-issued",
        key_hash: "tenant-iso-self-issued",
        prefix: "altorank_live_self",
        scopes: ["read", "generate", "write"],
      });
      expect(error).not.toBeNull();
      const { data } = await fx.admin.from("api_keys").select("id").eq("key_hash", "tenant-iso-self-issued");
      expect(data).toEqual([]);
    });

    it("an editor cannot revoke or rescope an existing key", async () => {
      await fx.as.aEditor
        .from("api_keys")
        .update({ revoked_at: new Date().toISOString(), scopes: ["write"] })
        .eq("account_id", fx.accountA);
      const { data } = await fx.admin
        .from("api_keys")
        .select("revoked_at, scopes")
        .eq("key_hash", "tenant-iso-hash-a")
        .single();
      expect(data?.revoked_at).toBeNull();
      expect(data?.scopes).toEqual([]);
    });

    it("an editor still sees that keys exist, and never their hashes", async () => {
      const { data } = await fx.as.aEditor.from("api_keys").select("id, name, prefix");
      expect((data ?? []).length).toBe(1);
    });

    it("an owner can still create and revoke keys", async () => {
      // insert(...).select("id").single() is exactly what createApiKey does:
      // it needs the INSERT check AND the SELECT policy to hold.
      const { data: created, error: createErr } = await fx.as.aOwner
        .from("api_keys")
        .insert({
          account_id: fx.accountA,
          name: "owner issued",
          key_hash: "tenant-iso-owner-issued",
          prefix: "altorank_live_ownr",
        })
        .select("id")
        .single();
      expect(createErr).toBeNull();
      expect(created?.id).toBeTruthy();
      const { data } = await fx.as.aOwner
        .from("api_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("key_hash", "tenant-iso-owner-issued")
        .select("id");
      expect((data ?? []).length).toBe(1);
    });

    it("an editor cannot read pending invite tokens; an admin can", async () => {
      const { data: hidden } = await fx.as.aEditor.from("invites").select("token");
      expect(hidden ?? []).toEqual([]);
      const { data: visible } = await fx.as.aOwner.from("invites").select("token");
      expect((visible ?? []).map((i) => i.token)).toEqual(["tenant-iso-invite-token"]);
    });

    it("nobody signed in can mint backlink credits", async () => {
      for (const who of [fx.as.aEditor, fx.as.aOwner]) {
        const { error } = await who
          .from("backlink_credits")
          .insert({ account_id: fx.accountA, amount: 9_999, reason: "bonus" });
        expect(error).not.toBeNull();
      }
    });

    it("nobody signed in can move the account onto a paid plan", async () => {
      for (const who of [fx.as.aEditor, fx.as.aOwner]) {
        const { error } = await who
          .from("accounts")
          .update({ plan: "scale", plan_status: "active" })
          .eq("id", fx.accountA);
        expect(error).not.toBeNull();
      }
      const { data } = await fx.admin.from("accounts").select("plan, plan_status").eq("id", fx.accountA).single();
      expect(data?.plan).toBe("starter");
      expect(data?.plan_status).toBe("inactive");
    });

    it("nobody signed in can set the legacy blog API key", async () => {
      const { error } = await fx.as.aOwner
        .from("accounts")
        .update({ api_key: "chosen-by-the-caller" })
        .eq("id", fx.accountA);
      expect(error).not.toBeNull();
    });

    it("an editor cannot rebrand the account, but an owner can", async () => {
      const { error: refused } = await fx.as.aEditor
        .from("accounts")
        .update({ name: "Renamed by an editor", remove_branding: true })
        .eq("id", fx.accountA);
      expect(refused).not.toBeNull();

      const { error: allowed } = await fx.as.aOwner
        .from("accounts")
        .update({ name: "Renamed by the owner" })
        .eq("id", fx.accountA);
      expect(allowed).toBeNull();
    });

    it("a member may still answer the attribution question", async () => {
      const { error } = await fx.as.aEditor
        .from("accounts")
        .update({ attribution_source: "google", attribution_answered_at: new Date().toISOString() })
        .eq("id", fx.accountA);
      expect(error).toBeNull();
    });

    it("an editor cannot delete a site, and an owner can", async () => {
      await fx.as.aEditor.from("workspaces").delete().eq("id", fx.a1);
      const { data: survived } = await fx.admin.from("workspaces").select("id").eq("id", fx.a1);
      expect((survived ?? []).length).toBe(1);

      await fx.as.aOwner.from("workspaces").delete().eq("id", fx.a2);
      const { data: gone } = await fx.admin.from("workspaces").select("id").eq("id", fx.a2);
      expect(gone).toEqual([]);
    });
  });

  // --- Signed out ------------------------------------------------------------

  it("an anonymous caller sees none of it", async () => {
    const anon = createClient(ENV!.url, ENV!.anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    for (const table of ["workspaces", "articles", "keywords", "accounts", "api_keys", "invites"] as const) {
      const { data } = await anon.from(table).select("id").limit(1);
      expect(data ?? []).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The wizard's draft save, on the local database
// ---------------------------------------------------------------------------
//
// `saveProfileDraft` (app/actions/onboarding-wizard.ts) writes the owner's
// answers as they edit, through their own client. Pinned against PostgREST
// and Postgres themselves, because what matters is what RLS lets through:
//
// - the owner's draft lands on their own site, with no confirmation stamp
//   and without touching the columns research reads;
// - a person from another account cannot write it (RLS answers "no row");
// - once setup is finished, or the profile was confirmed, no draft lands;
// - the final click's `saveProfile` stamps the confirmation, and a draft
//   arriving after it changes nothing.
//
// Seeds are prefixed b17- with invented acme-*.example domains, deleted at
// the end.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { connectLocalStack } from "@/lib/__tests__/support/local-db";
import { EMPTY_PROFILE, type BusinessProfile } from "../profile-shape";

const STACK = await connectLocalStack();
const TAG = randomUUID().slice(0, 8);
const PASSWORD = `B17-${TAG}-local-1!`;

// The action reads "the person's own client"; here, whichever user the test says.
let asUser: SupabaseClient | null = null;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => asUser }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { saveProfileDraft, saveProfile } = await import("@/app/actions/onboarding-wizard");

const SITE = { sitemapUrl: "", blogRootUrl: `https://acme-b17-${TAG}-a.example/blog/`, exampleArticleUrls: [] };
const DRAFT: BusinessProfile = {
  ...EMPTY_PROFILE,
  name: "Acme Physio",
  language: "Italian",
  country: "Italy",
  description: "Acme Physio treats back pain.",
  offerings: ["back pain treatment"],
  competitors: [],
  competitorNames: ["Studio Acme"],
  // A client cannot stamp its own confirmation.
  confirmedAt: "2026-01-01T00:00:00.000Z",
};

describe.skipIf(!STACK)("the wizard's draft save on the local database", () => {
  let admin: SupabaseClient;
  const users: Record<"aOwner" | "bOwner", { id: string; client: SupabaseClient }> = {} as never;
  let accountA = "";
  let accountB = "";
  let siteA = "";

  async function user(name: string) {
    const email = `b17-draft-${TAG}-${name.toLowerCase()}@example.test`;
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
  const row = async () =>
    must(await admin.from("workspaces").select("business_profile, blog_root_url, language, location_code, name").eq("id", siteA).single(), "read");

  beforeAll(async () => {
    admin = createClient(STACK!.url, STACK!.service, { auth: { persistSession: false, autoRefreshToken: false } });
    users.aOwner = await user("aOwner");
    users.bOwner = await user("bOwner");
    accountA = must(await admin.from("accounts").insert({ name: `b17 draft A ${TAG}`, slug: `b17-draft-a-${TAG}` }).select("id").single(), "account A").id as string;
    accountB = must(await admin.from("accounts").insert({ name: `b17 draft B ${TAG}`, slug: `b17-draft-b-${TAG}` }).select("id").single(), "account B").id as string;
    must(await admin.from("account_members").insert([
      { account_id: accountA, user_id: users.aOwner.id, role: "owner" },
      { account_id: accountB, user_id: users.bOwner.id, role: "owner" },
    ]), "members");
    siteA = must(await admin.from("workspaces").insert({ account_id: accountA, name: `acme-b17-${TAG}-a.example`, domain: `acme-b17-${TAG}-a.example`, initials: "AC", color: "av-c1" }).select("id").single(), "site A").id as string;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    for (const id of [accountA, accountB].filter(Boolean)) await admin.from("accounts").delete().eq("id", id);
    for (const u of Object.values(users)) if (u?.id) await admin.auth.admin.deleteUser(u.id);
  }, 60_000);

  it("refuses another account's site: RLS shows it no row, and nothing is written", async () => {
    asUser = users.bOwner.client;
    expect(await saveProfileDraft(siteA, DRAFT, SITE)).toEqual({ ok: false, reason: "failed" });
    expect((await row()).business_profile).toBeNull();
  });

  it("saves the owner's draft with no confirmation, leaving the research columns alone", async () => {
    const before = await row();
    asUser = users.aOwner.client;
    expect(await saveProfileDraft(siteA, DRAFT, SITE)).toEqual({ ok: true });
    const after = await row();
    const saved = after.business_profile as BusinessProfile;
    expect(saved.competitorNames).toEqual(["Studio Acme"]);
    expect(saved.offerings).toEqual(["back pain treatment"]);
    expect(saved).not.toHaveProperty("confirmedAt");
    expect(after.blog_root_url).toBe(SITE.blogRootUrl);
    expect([after.language, after.location_code, after.name]).toEqual([before.language, before.location_code, before.name]);
  });

  it("lands nothing after the final click: the confirmed profile stays confirmed", async () => {
    asUser = users.aOwner.client;
    await saveProfile(siteA, { ...DRAFT, confirmedAt: null });
    const confirmed = (await row()).business_profile as BusinessProfile;
    expect(confirmed.confirmedAt).toBeTruthy();
    expect(await saveProfileDraft(siteA, { ...DRAFT, description: "late draft" }, SITE)).toEqual({ ok: false, reason: "confirmed" });
    expect(((await row()).business_profile as BusinessProfile).description).toBe(DRAFT.description);
  });

  it("lands nothing when the final click stamps the profile between the draft's read and its write", async () => {
    must(await admin.from("workspaces").update({ business_profile: null }).eq("id", siteA), "reset");
    // The draft reads the row (unconfirmed), then the final click lands from
    // another tab, then the draft writes: the guard must hold in the update.
    const stamp = async () =>
      must(await admin.from("workspaces").update({ business_profile: { ...DRAFT, description: "confirmed elsewhere", confirmedAt: new Date().toISOString() } }).eq("id", siteA), "stamp");
    const real = users.aOwner.client;
    asUser = {
      from(table: string) {
        const builder = real.from(table) as unknown as Record<string, unknown>;
        if (table !== "workspaces") return builder;
        const select = (builder.select as (...a: unknown[]) => Record<string, unknown>).bind(builder);
        builder.select = (...a: unknown[]) => {
          const query = select(...a);
          const eq = (query.eq as (...e: unknown[]) => Record<string, unknown>).bind(query);
          query.eq = (...e: unknown[]) => {
            const filtered = eq(...e);
            const maybeSingle = (filtered.maybeSingle as () => Promise<unknown>).bind(filtered);
            filtered.maybeSingle = async () => {
              const read = await maybeSingle();
              await stamp();
              return read;
            };
            return filtered;
          };
          return query;
        };
        return builder;
      },
    } as unknown as SupabaseClient;
    expect(await saveProfileDraft(siteA, { ...DRAFT, description: "late draft" }, SITE)).toEqual({ ok: false, reason: "failed" });
    const after = (await row()).business_profile as BusinessProfile;
    expect(after.description).toBe("confirmed elsewhere");
    expect(after.confirmedAt).toBeTruthy();
  });

  it("lands nothing once setup is finished", async () => {
    must(await admin.from("workspaces").update({ business_profile: null, onboarded_at: new Date().toISOString() }).eq("id", siteA), "finish");
    asUser = users.aOwner.client;
    expect(await saveProfileDraft(siteA, DRAFT, SITE)).toEqual({ ok: false, reason: "finished" });
    expect((await row()).business_profile).toBeNull();
  });
});

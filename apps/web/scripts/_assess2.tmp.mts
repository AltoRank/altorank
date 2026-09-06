// Temporary seeding helper for the T1 onboarding assessment. Delete before commit.
//
// Mirrors app/(auth)/signup/page.tsx exactly: auth user (with a password, so the
// real /signin form can be used), agency, owner membership, one workspace with
// auto_generate on at FREE_TIER_PACE. Local stack only.

import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd(), true);

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url.includes("127.0.0.1") && !url.includes("localhost")) throw new Error(`refusing non-local supabase: ${url}`);
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const cmd = process.argv[2];

function key36() {
  return Math.random().toString(36).slice(2, 10);
}

async function create(tag: string, domain: string, opts: { workspace?: boolean } = {}) {
  const email = `e2e+${tag}@altorank.test`;
  const password = `Assess2-${tag}-pw`;
  const name = `Assess2 ${tag}`;
  const { data: created, error: userErr } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });
  if (userErr || !created?.user) throw new Error(`createUser: ${userErr?.message}`);
  const userId = created.user.id;

  const { data: agency, error: agencyErr } = await db
    .from("agencies")
    .insert({ name, slug: `assess2-${tag}` })
    .select("id")
    .single();
  if (agencyErr || !agency) throw new Error(`agency: ${agencyErr?.message}`);

  const { error: memberErr } = await db
    .from("agency_members")
    .insert({ agency_id: agency.id, user_id: userId, role: "owner" });
  if (memberErr) throw new Error(`member: ${memberErr.message}`);

  let workspaceId: string | null = null;
  if (opts.workspace !== false) {
    const { data: ws, error: wsErr } = await db
      .from("workspaces")
      .insert({
        agency_id: agency.id,
        name: domain,
        domain,
        initials: domain.slice(0, 2).toUpperCase(),
        color: "av-c1",
        indexnow_key: key36(),
        auto_generate: true,
        auto_generate_weekly_limit: 7,
      })
      .select("id")
      .single();
    if (wsErr || !ws) throw new Error(`workspace: ${wsErr?.message}`);
    workspaceId = ws.id;
  }

  console.log(JSON.stringify({ email, password, userId, agencyId: agency.id, workspaceId, domain }, null, 2));
}

async function link(email: string, next: string) {
  const { data, error } = await db.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(error.message);
  console.log(`/callback?token_hash=${data.properties!.hashed_token}&type=magiclink&next=${encodeURIComponent(next)}`);
}

async function destroy(tag: string) {
  const email = `e2e+${tag}@altorank.test`;
  const { data: list } = await db.auth.admin.listUsers({ perPage: 1000 });
  const user = list?.users.find((u) => u.email === email);
  const { data: agencies } = await db.from("agencies").select("id").eq("slug", `assess2-${tag}`);
  for (const a of agencies ?? []) await db.from("agencies").delete().eq("id", a.id);
  if (user) await db.auth.admin.deleteUser(user.id);
  console.log(`destroyed ${email}`);
}

async function sql(text: string) {
  console.log(text);
}

if (cmd === "create") await create(process.argv[3]!, process.argv[4]!, { workspace: process.argv[5] !== "no-workspace" });
else if (cmd === "link") await link(`e2e+${process.argv[3]}@altorank.test`, process.argv[4] ?? "/dashboard");
else if (cmd === "destroy") await destroy(process.argv[3]!);
else await sql("usage: create <tag> <domain> [no-workspace] | link <tag> [next] | destroy <tag>");

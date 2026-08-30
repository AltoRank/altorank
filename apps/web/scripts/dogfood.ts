#!/usr/bin/env tsx
/**
 * Set up a real workspace so AltoRank can be run against altorank.co itself.
 *
 *   npm run dogfood
 *
 * Seeds ACCOUNT STRUCTURE ONLY: a user, an agency, and a workspace pointed at a
 * domain we actually own. Nothing that looks like a measurement is written.
 *
 * `workspaces.dr` and `workspaces.traffic` stay null even though the columns
 * exist and the dashboard renders them, because we do not have real values for
 * them and a plausible-looking placeholder is the exact failure this project
 * keeps having to undo. Keywords come from a live DataForSEO call, articles
 * come from a live generation, rankings come from the cron or not at all.
 *
 * Idempotent: re-running finds the existing rows instead of duplicating them.
 */

import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DOMAIN = process.argv[2] ?? "altorank.co";
const EMAIL = process.env.DOGFOOD_EMAIL ?? "dogfood@altorank.co";

async function main(): Promise<void> {
  if (!url || !serviceKey) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
    process.exit(1);
  }

  // Service role: this bypasses RLS, which is why it is a script and not a route.
  const db = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // --- User ----------------------------------------------------------------
  const { data: existing } = await db.auth.admin.listUsers();
  let user = existing?.users.find((u) => u.email === EMAIL);

  // Always issue a fresh password. The alternative is printing it only on
  // creation, and a later step failing then leaves an account nobody can log
  // into, which is exactly what happened the first time this ran.
  const password = randomBytes(12).toString("base64url");

  if (!user) {
    const { data, error } = await db.auth.admin.createUser({
      email: EMAIL,
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`createUser: ${error.message}`);
    user = data.user;
    console.log(`  created user   ${EMAIL}`);
  } else {
    const { error } = await db.auth.admin.updateUserById(user.id, { password });
    if (error) throw new Error(`updateUser: ${error.message}`);
    console.log(`  found user     ${EMAIL} (password reset)`);
  }

  // --- Agency --------------------------------------------------------------
  const { data: agencyRow } = await db
    .from("agencies")
    .select("id")
    .eq("slug", "altorank")
    .maybeSingle();

  let agencyId = agencyRow?.id as string | undefined;
  if (!agencyId) {
    const { data, error } = await db
      .from("agencies")
      // `scale` because the agencies.plan check constraint still allows only
      // starter/growth/scale, the pre-pivot three-tier naming. The shipped
      // ladder is four rungs (self-host / BYOK / managed / agency), so the
      // database never got the pricing convergence. Flagged, not fixed here:
      // changing the enum touches billing and does not belong in a seed script.
      .insert({ name: "AltoRank", slug: "altorank", plan: "scale" })
      .select("id")
      .single();
    if (error) throw new Error(`agency: ${error.message}`);
    agencyId = data.id;
    console.log("  created agency AltoRank");
  } else {
    console.log("  found agency   AltoRank");
  }

  // --- Membership ----------------------------------------------------------
  const { data: member } = await db
    .from("agency_members")
    .select("id")
    .eq("agency_id", agencyId)
    .eq("user_id", user!.id)
    .maybeSingle();

  if (!member) {
    const { error } = await db
      .from("agency_members")
      .insert({ agency_id: agencyId, user_id: user!.id, role: "owner" });
    if (error) throw new Error(`membership: ${error.message}`);
    console.log("  created membership (owner)");
  }

  // --- Workspace -----------------------------------------------------------
  const { data: wsRow } = await db
    .from("workspaces")
    .select("id")
    .eq("agency_id", agencyId)
    .eq("domain", DOMAIN)
    .maybeSingle();

  let workspaceId = wsRow?.id as string | undefined;
  if (!workspaceId) {
    const { data, error } = await db
      .from("workspaces")
      .insert({
        agency_id: agencyId,
        name: DOMAIN,
        domain: DOMAIN,
        initials: DOMAIN.slice(0, 2).toUpperCase(),
        color: "violet",
        // Allowed values are on/review/paused/setup. "setup" is the honest one:
        // nothing has been configured for this workspace yet.
        status: "setup",
        language: "en",
        location_code: 2840,
        ai_provider: "claude",
        // dr and traffic deliberately left null: no real figure for either.
      })
      .select("id")
      .single();
    if (error) throw new Error(`workspace: ${error.message}`);
    workspaceId = data.id;
    console.log(`  created workspace ${DOMAIN}`);
  } else {
    console.log(`  found workspace   ${DOMAIN}`);
  }

  console.log("\nReady.");
  console.log(`  workspace id  ${workspaceId}`);
  console.log(`  sign in       ${EMAIL}`);
  console.log(`  password      ${password}`);
  console.log("\nNo metrics were seeded. Keywords, articles and rankings only");
  console.log("appear once the real pipeline produces them.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Re-run the buyer test over a workspace's existing keyword pool
// ---------------------------------------------------------------------------
//
// The first look judges a keyword when it is stored. A pool filled before the
// buyer test existed (2026-09-11), or by a research run that bypassed it, was
// never asked. This asks now: one model call over every keyword that is not
// yet drafted, and with --apply takes the refused ones off the plan the way a
// person removing a calendar entry does (`plan_excluded_at`, entry deleted),
// so the nightly cron cannot write them.
//
//   npx tsx --env-file=.env.local scripts/rejudge-keywords.ts <workspace-id-or-domain>          dry run
//   npx tsx --env-file=.env.local scripts/rejudge-keywords.ts <workspace-id-or-domain> --apply  park the refused
//
// Needs the service role and ANTHROPIC_API_KEY in the environment.

import { createClient } from "@supabase/supabase-js";
import { judgeBuyerFit } from "@/lib/keyword-research/buyer-fit";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";

async function main() {
  const [target, flag] = process.argv.slice(2);
  if (!target) throw new Error("usage: rejudge-keywords.ts <workspace-id-or-domain> [--apply]");
  const apply = flag === "--apply";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const supabase = createClient(url, key);

  const byId = /^[0-9a-f-]{36}$/.test(target);
  const { data: ws, error } = await supabase
    .from("workspaces")
    .select("id, domain, business_profile")
    .eq(byId ? "id" : "domain", target)
    .maybeSingle();
  if (error) throw error;
  if (!ws) throw new Error(`no workspace for ${target}`);
  const business = (ws.business_profile as BusinessProfile | null) ?? null;
  if (!business?.description) throw new Error(`${ws.domain} has no business profile to judge against`);

  const { data: keywords } = await supabase
    .from("keywords")
    .select("id, term, status, volume, source, plan_excluded_at")
    .eq("workspace_id", ws.id)
    .in("status", ["new", "stored", "planned"])
    .is("plan_excluded_at", null);
  const pool = keywords ?? [];
  console.log(`${ws.domain}: ${pool.length} keywords on the plan or waiting for it`);
  if (!pool.length) return;

  const { verdicts, basis } = await judgeBuyerFit(business, pool.map((k) => k.term as string), {
    spend: { supabase, workspaceId: ws.id as string },
  });
  if (basis !== "model") throw new Error("the model answered nothing; is ANTHROPIC_API_KEY set?");

  const refused = pool.filter((k) => verdicts.get((k.term as string).toLowerCase())?.keep === false);
  const kept = pool.length - refused.length;
  console.log(`kept ${kept}, refused ${refused.length}\n`);
  for (const k of refused) {
    const v = verdicts.get((k.term as string).toLowerCase());
    console.log(`  - ${k.term}  (${k.status}, ${k.volume ?? "?"}/mo)  ${v && !v.keep ? v.reason : ""}`);
  }
  if (!apply || !refused.length) {
    if (!apply && refused.length) console.log("\ndry run; pass --apply to park these");
    return;
  }

  const ids = refused.map((k) => k.id as string);
  const { data: entries } = await supabase
    .from("calendar_entries")
    .select("id, keyword_id, article_id")
    .eq("workspace_id", ws.id)
    .in("keyword_id", ids)
    .is("article_id", null);
  const entryIds = (entries ?? []).map((e) => e.id as string);
  if (entryIds.length) {
    const { error: e1 } = await supabase.from("calendar_entries").delete().in("id", entryIds);
    if (e1) throw e1;
  }
  const { error: e2 } = await supabase
    .from("keywords")
    .update({ plan_excluded_at: new Date().toISOString(), status: "stored" })
    .eq("workspace_id", ws.id)
    .in("id", ids)
    .in("status", ["new", "stored", "planned"]);
  if (e2) throw e2;
  console.log(`\nparked ${ids.length} keywords, removed ${entryIds.length} calendar entries`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

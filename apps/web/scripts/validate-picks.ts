#!/usr/bin/env tsx
// Does the picker choose what Search Console says the site can win?
//
// For every workspace with Search Console connected: the next draft the
// unattended path would write, and how many of the recommender's top five
// are among Search Console's top five queries by impressions. Read-only;
// `qualify: false` so nothing is bought. Run before and after a change to
// the picker, on the same workspaces, and compare.
//
//   npm run validate:picks            # every GSC-connected workspace
//   npm run validate:picks -- <id>    # one workspace
//
// 2026-09-17, altorank.co, before lib/gsc/seed.ts: next draft "Free People
// Search 2026", overlap 0/5. After: "rankingcoach alternative", 5/5.
import { createClient } from "@supabase/supabase-js";
import { recommendKeywords, pickNextKeyword } from "@/lib/seo/recommendations";
import { selectSearchConsoleSeeds } from "@/lib/gsc/seed";
import { readGsc } from "@/lib/gsc/read";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}
const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const PASS = 3;

async function main() {
  const only = process.argv[2];
  const { data: rows } = await db
    .from("workspace_integrations")
    .select("workspace_id, workspace:workspaces(id, domain, language)")
    .eq("integration_id", "gsc")
    .eq("needs_reconnect", false);
  // The join is typed as an array by the client; it is one row per FK.
  const workspaces = ((rows ?? []) as unknown as Array<{ workspace: { id: string; domain: string | null; language: string | null } | null }>)
    .map((r) => r.workspace)
    .filter((w): w is { id: string; domain: string | null; language: string | null } => Boolean(w))
    .filter((w) => !only || w.id === only);

  let failures = 0;
  for (const ws of workspaces) {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    // The query partition, through the one Search Console reader: the same
    // rows the seeder and the recommender read, all of them.
    const gsc = await readGsc(db, { workspaceId: ws.id, shapes: ["query"], since, columns: ["impressions", "clicks", "avg_position"] });
    const gscTop = selectSearchConsoleSeeds(gsc, ws.domain ?? "", { limit: 5 }).seeds.map((s) => s.term);

    const recs = await recommendKeywords(db, ws.id, { limit: 1000, qualify: false });
    const writable = recs.filter((r) => r.action === "write" && r.quality === "ok").slice(0, 5).map((r) => r.term.toLowerCase());
    const overlap = writable.filter((t) => gscTop.includes(t)).length;
    const next = pickNextKeyword(recs);

    console.log(`\n${ws.domain ?? ws.id}`);
    console.log(`  next draft:   ${next?.term ?? "(none)"}`);
    console.log(`  GSC top 5:    ${gscTop.length ? gscTop.join(" | ") : "(no query rows synced)"}`);
    console.log(`  picker top 5: ${writable.join(" | ") || "(nothing writable)"}`);
    if (gscTop.length) {
      const ok = overlap >= Math.min(PASS, gscTop.length);
      if (!ok) failures++;
      console.log(`  overlap:      ${overlap}/${gscTop.length}  ${ok ? "PASS" : "FAIL"}`);
    } else {
      console.log("  overlap:      n/a - nothing to validate against until the sync lands rows");
    }
  }
  console.log(`\n${workspaces.length} workspace(s), ${failures} below the bar`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

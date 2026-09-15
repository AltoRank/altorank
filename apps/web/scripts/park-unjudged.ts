#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// Retire the sediment: park every keyword stored before topic qualification
// existed, and take its unwritten calendar entries off the plan
// ---------------------------------------------------------------------------
//
// Since #214 nothing is scheduled or written unattended without a buyer
// verdict and live search evidence. Rows stored before that date have no
// verdict, and the nightly judge was spending its slots sifting them:
// altorank.co held 274 open terms from five generations of research code,
// one qualified. This parks them once, labelled "stored before qualification
// existed", and removes the calendar entries planned before any judge saw
// them (PackHub's "ups shipping calculator" row, altorank.co's 29).
//
// Nothing is deleted and nothing is bought. A parked-unjudged row is judged
// again by the nightly refill when the queue needs topics; the good ones
// come back on their own (lib/keyword-research/queue.ts).
//
//   npx tsx --env-file=.env.local scripts/park-unjudged.ts --workspace=UUID          dry run
//   npx tsx --env-file=.env.local scripts/park-unjudged.ts --all                     dry run, every workspace
//   npx tsx --env-file=.env.local scripts/park-unjudged.ts --all --apply             write it
//
// `--before=<ISO>` moves the cutoff; it defaults to the #214 deploy.

import { createClient } from "@supabase/supabase-js";
import { contextKey } from "@/lib/keyword-research/opportunity";
import { parkKeywords, unjudgedVerdict } from "@/lib/keyword-research/queue";
import { languageCodeOf } from "@/lib/keyword-research/locale";

/** The moment #214 went live. Rows older than this never met the judge. */
const JUDGE_SINCE = "2026-09-13T11:33:00.000Z";

async function main() {
  const args = process.argv.slice(2);
  const workspaceArg = args.find((a) => a.startsWith("--workspace="))?.slice(12);
  const all = args.includes("--all");
  const apply = args.includes("--apply");
  const before = args.find((a) => a.startsWith("--before="))?.slice(9) ?? JUDGE_SINCE;
  if (!workspaceArg && !all) throw new Error("usage: park-unjudged.ts (--workspace=UUID | --all) [--apply] [--before=ISO]");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  let q = db.from("workspaces").select("id, domain, business_profile, language, location_code").not("domain", "is", null);
  if (workspaceArg) q = q.eq("id", workspaceArg);
  const { data: workspaces, error } = await q;
  if (error) throw error;

  let totalParked = 0;
  let totalEntries = 0;
  for (const ws of workspaces ?? []) {
    const context = {
      domain: ws.domain as string,
      business: (ws.business_profile as never) ?? null,
      languageCode: languageCodeOf(ws.language as string | null),
      locationCode: (ws.location_code as number | null) ?? 2840,
    };
    // Open rows with no verdict from before the judge, plus planned rows
    // whose verdict is not "qualified" (planned before the judge, or judged
    // and refused but still on the calendar).
    const { data: rows, error: readError } = await db
      .from("keywords")
      .select("id, term, status, created_at, opportunity, plan_excluded_at")
      .eq("workspace_id", ws.id)
      .in("status", ["new", "planned"])
      .is("plan_excluded_at", null);
    if (readError) throw readError;
    const candidates = (rows ?? []).filter((r) => {
      const verdict = r.opportunity as { status?: string } | null;
      if (verdict?.status === "qualified") return false;
      if (r.status === "planned") return true;
      return !verdict && String(r.created_at) < before;
    });
    const { count: entries } = candidates.length
      ? await db.from("calendar_entries").select("id", { count: "exact", head: true }).eq("workspace_id", ws.id).in("keyword_id", candidates.map((r) => r.id)).is("article_id", null)
      : { count: 0 };
    console.log(`${ws.domain}: ${candidates.length} to park (${candidates.filter((r) => r.status === "planned").length} planned), ${entries ?? 0} calendar entries to remove`);
    for (const r of candidates.slice(0, 8)) console.log(`   - ${r.term} (${r.status}, ${String(r.created_at).slice(0, 10)})`);
    if (candidates.length > 8) console.log(`   … and ${candidates.length - 8} more`);
    if (!apply || !candidates.length) continue;
    const verdict = unjudgedVerdict(contextKey(context));
    const out = await parkKeywords(db, ws.id as string, candidates.map((r) => ({ id: r.id as string, verdict })));
    totalParked += out.parked;
    totalEntries += out.entriesRemoved;
    console.log(`   parked ${out.parked}, removed ${out.entriesRemoved} entries`);
  }
  console.log(apply ? `\ndone: ${totalParked} parked, ${totalEntries} calendar entries removed` : "\ndry run; pass --apply to write");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

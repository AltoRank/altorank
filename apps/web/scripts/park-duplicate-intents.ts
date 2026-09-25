#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// One query, one article, applied once to what is already stored
// ---------------------------------------------------------------------------
//
// From this change on, a topic that is the same search as something already
// live, drafted or scheduled is parked as it is found (lib/keyword-research/
// intent.ts). Workspaces planned before it can already hold such pairs: a
// real signup (2026-09-22) had one Turkish search drafted, queued for the
// next day and held for the trial under three spellings. This finds them with
// the same rule and, with --apply, parks the unwritten ones the way a refusal
// is parked: kept, status `stored`, `plan_excluded_at` set, their unwritten
// calendar entries removed, verdict cause "duplicate" naming the owner.
//
// Only a topic whose owner is already live, drafted or scheduled is parked.
// Two candidates that are one search are left to the recommender, which
// writes the better one first and parks the other once it is on the calendar.
// Two topics that are both already written are listed, never touched: an
// article cannot be unwritten by a script.
//
// Nothing is bought: results pages are the ones qualification already stored.
// Nothing is deleted except unwritten calendar entries of parked rows.
//
//   npx tsx --env-file=<env> scripts/park-duplicate-intents.ts --workspace=UUID      dry run
//   npx tsx --env-file=<env> scripts/park-duplicate-intents.ts --all                 dry run, every workspace
//   npx tsx --env-file=<env> scripts/park-duplicate-intents.ts --all --apply         write it

import { createClient } from "@supabase/supabase-js";
import { contextKey, duplicateVerdict, OPPORTUNITY_VERSION, type Opportunity } from "@/lib/keyword-research/opportunity";
import { clusterByIntent, describeMatch, intentLanguage, storedSerp, unfoldedNote, type StagedTopic } from "@/lib/keyword-research/intent";
import { leadersFrom, stageWords, type IntentLeader } from "@/lib/keyword-research/intent-leaders";
import { parkKeywords } from "@/lib/keyword-research/queue";
import { languageCodeOf } from "@/lib/keyword-research/locale";

type KeywordRow = { id: string; term: string; status: string; opportunity: unknown; plan_excluded_at: string | null };
type Topic = StagedTopic & { row?: KeywordRow; owner?: IntentLeader; date?: string };

async function main() {
  const args = process.argv.slice(2);
  const workspaceArg = args.find((a) => a.startsWith("--workspace="))?.slice(12);
  const all = args.includes("--all");
  const apply = args.includes("--apply");
  if (!workspaceArg && !all) throw new Error("usage: park-duplicate-intents.ts (--workspace=UUID | --all) [--apply]");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  console.log(`database: ${new URL(url).host}${apply ? "  (--apply: WRITING)" : "  (dry run)"}`);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  let q = db.from("workspaces").select("id, domain, business_profile, language, location_code").not("domain", "is", null);
  if (workspaceArg) q = q.eq("id", workspaceArg);
  const { data: workspaces, error } = await q;
  if (error) throw error;

  let totalFound = 0;
  let totalParked = 0;
  let totalEntries = 0;
  for (const ws of workspaces ?? []) {
    const language = intentLanguage(ws.language as string | null);
    const [keywords, articles, pages, entries] = await Promise.all([
      db.from("keywords").select("id, term, status, opportunity, plan_excluded_at").eq("workspace_id", ws.id),
      db.from("articles").select("id, keyword, keyword_id, status").eq("workspace_id", ws.id).not("keyword", "is", null),
      db.from("site_pages").select("url, keyword").eq("workspace_id", ws.id).not("keyword", "is", null),
      db.from("calendar_entries").select("keyword_id, scheduled_date").eq("workspace_id", ws.id).in("status", ["queue", "scheduled"]),
    ]);
    for (const res of [keywords, articles, pages, entries]) if (res.error) throw res.error;
    const rows = (keywords.data ?? []) as KeywordRow[];
    const dateOf = new Map<string, string>();
    for (const e of (entries.data ?? []) as Array<{ keyword_id: string | null; scheduled_date: string }>) {
      if (e.keyword_id && (!dateOf.has(e.keyword_id) || e.scheduled_date < dateOf.get(e.keyword_id)!)) dateOf.set(e.keyword_id, e.scheduled_date);
    }

    // Owners: in-flight keyword rows, articles, pages - the same reader the
    // app uses. Candidates: open rows not parked.
    const leaders = leadersFrom(rows, (articles.data ?? []) as never, (pages.data ?? []) as never);
    const byRow = new Map(rows.map((r) => [r.id, r]));
    const topics: Topic[] = leaders.map((l) => ({ ...l, owner: l, row: l.keywordId ? byRow.get(l.keywordId) : undefined, date: l.keywordId ? dateOf.get(l.keywordId) : undefined }));
    // Two rows on the calendar: the one written first leads.
    topics.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));
    for (const r of rows) {
      if (r.plan_excluded_at || r.status !== "new") continue;
      topics.push({ term: r.term, organicUrls: storedSerp(r.opportunity), stage: "candidate", row: r });
    }
    const followers = clusterByIntent(topics, language);

    const toPark: Array<{ id: string; verdict: Opportunity; line: string }> = [];
    const writtenTwice: string[] = [];
    let wordsOnly = 0;
    const fingerprint = contextKey({
      domain: ws.domain as string,
      business: (ws.business_profile as never) ?? null,
      languageCode: languageCodeOf(ws.language as string | null),
      locationCode: (ws.location_code as number | null) ?? 2840,
    });
    for (const [topic, { leader, match }] of followers) {
      if (leader.stage === "candidate") continue; // the recommender's call, not this script's
      if (match.basis === "words" && match.note) wordsOnly++;
      const line = `"${topic.term}" (${topic.stage}) -> "${leader.term}" (${stageWords(leader.stage)}; ${describeMatch(match)})`;
      if (topic.stage === "drafted" || topic.stage === "live") { writtenTwice.push(line); continue; }
      if (!topic.row) continue; // an article or a page following another: nothing to park
      const base = { ...(topic.row.opportunity && typeof topic.row.opportunity === "object" ? topic.row.opportunity as Opportunity : { reason: "" } as Opportunity),
        version: OPPORTUNITY_VERSION, context: fingerprint, checkedAt: new Date().toISOString() };
      const verdict = duplicateVerdict(base, { term: leader.term, keywordId: leader.row?.id ?? leader.owner?.keywordId ?? null, stage: leader.stage }, match);
      toPark.push({ id: topic.row.id, verdict, line });
    }

    const note = unfoldedNote(language);
    console.log(`${ws.domain} (${language ?? "no language"}): ${toPark.length} to park, ${writtenTwice.length} written twice${note ? `; ${note}` : ""}`);
    for (const p of toPark) console.log(`   park   ${p.line}`);
    for (const w of writtenTwice) console.log(`   review ${w}  (both written; left alone)`);
    if (note && wordsOnly) console.log(`   ${wordsOnly} pair(s) above were compared by exact words only`);
    totalFound += toPark.length;
    if (!apply || !toPark.length) continue;
    const out = await parkKeywords(db, ws.id as string, toPark.map(({ id, verdict }) => ({ id, verdict })));
    totalParked += out.parked;
    totalEntries += out.entriesRemoved;
    console.log(`   parked ${out.parked}, removed ${out.entriesRemoved} calendar entries`);
  }
  console.log(apply ? `\ndone: ${totalParked} parked, ${totalEntries} calendar entries removed` : `\ndry run: ${totalFound} would be parked; pass --apply to write`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

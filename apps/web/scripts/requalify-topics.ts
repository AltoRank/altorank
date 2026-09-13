#!/usr/bin/env tsx
/**
 * Inspect an existing unscheduled keyword pool without changing its decisions.
 * Run from apps/web with the intended environment explicitly loaded:
 *   npx tsx --env-file=.env.local scripts/requalify-topics.ts --workspace=UUID
 * Add --apply to buy fresh evidence and save qualifications (up to 15 terms).
 * --offset=15 inspects the next stable page. No calendar/article/status writes.
 */
import { createClient } from "@supabase/supabase-js";
import { contextKey, qualifyOpportunities, readOpportunity, QUALIFICATION_LIMIT } from "@/lib/keyword-research/opportunity";
import { languageCodeOf } from "@/lib/keyword-research/locale";

async function main() {
  const args = process.argv.slice(2);
  const workspaceId = args.find((arg) => arg.startsWith("--workspace="))?.slice(12);
  const offset = Number(args.find((arg) => arg.startsWith("--offset="))?.slice(9) ?? 0);
  const apply = args.includes("--apply");
  if (!workspaceId || !/^[0-9a-f-]{36}$/i.test(workspaceId) || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Supply --workspace=UUID and an optional non-negative --offset=N. Default is read-only; --apply saves fresh evidence.");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Load the intended Supabase environment before running this script.");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: ws, error } = await db.from("workspaces").select("domain, business_profile, language, location_code").eq("id", workspaceId).single();
  if (error || !ws) throw new Error("Workspace could not be read.");
  const { data: rows, error: readError } = await db.from("keywords").select("id, term, source_url, opportunity")
    .eq("workspace_id", workspaceId).in("status", ["new", "stored"]).order("id").range(offset, offset + QUALIFICATION_LIMIT - 1);
  if (readError) throw readError;
  const context = { domain: ws.domain, business: ws.business_profile, languageCode: languageCodeOf(ws.language), locationCode: ws.location_code ?? 2840 };
  const evidence = apply ? await qualifyOpportunities(db, workspaceId, (rows ?? []).map((row) => ({ ...row, opportunity: null })), context) : null;
  console.log(JSON.stringify({ mode: apply ? "save fresh qualification" : "read-only inspection", workspaceId, domain: ws.domain, offset,
    topics: (rows ?? []).map((row) => ({ id: row.id, term: row.term, qualification: evidence?.get(row.id) ?? readOpportunity(row.opportunity, contextKey(context)) ?? { status: "pending", reason: "No current qualification saved" } })),
  }, null, 2));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Topic inspection failed"); process.exitCode = 1; });

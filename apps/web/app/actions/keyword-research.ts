"use server";

// ---------------------------------------------------------------------------
// The research drawer's server side
// ---------------------------------------------------------------------------
//
// Every action names its workspace and checks the caller can see it: RLS
// narrows to the agency, not to the site, and the drawer follows the sidebar
// switcher rather than offering a picker of its own.
//
// Research proposes. Only `scheduleCandidates` and `scheduleStored` write to
// the calendar, and both go through `scheduleKeywords`, which respects the
// pace and the 60-keyword cap. Nothing here generates or publishes an article.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { scheduleKeywords, SCHEDULE_CAP } from "@/lib/onboarding/plan";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { normalizeTarget } from "@/lib/seo/recommendations";
import {
  loadResearchWorkspace,
  researchFind,
  researchGenerate,
  researchImport,
  researchPlaybook,
  type GenerateInput,
  type ResearchWorkspace,
} from "@/lib/keyword-research/pipeline";
import { parseTermList, planCapacity } from "@/lib/keyword-research/funnel";
import { KEYWORD_INSTRUCTIONS_MAX, readKeywordInstructions } from "@/lib/keyword-research/instructions";
import { PLAYBOOKS, competitorName, playbookExamples, type PlaybookId } from "@/lib/keyword-research/seeds";
import { runResearchChat, type ChatReply, type ChatTurn } from "@/lib/keyword-research/chat";
import type { PlanCapacity, ResearchCandidate, ResearchResult } from "@/lib/keyword-research/types";

export interface StoredKeyword {
  id: string;
  term: string;
  volume: number | null;
  difficulty: number | null;
  intent: string;
  created_at: string;
}

export interface PlaybookCard {
  id: PlaybookId;
  title: string;
  description: string;
  pattern: string;
  examples: string[];
  /** False when the profile lacks what the template needs; the card says which. */
  available: boolean;
  needs: string;
}

export interface ResearchContext {
  workspace: { id: string; name: string; domain: string };
  profile: BusinessProfile;
  capacity: PlanCapacity;
  weeklyLimit: number;
  instructions: string;
  stored: StoredKeyword[];
  playbooks: PlaybookCard[];
  providerReady: boolean;
  modelReady: boolean;
}

async function scoped(workspaceId: string): Promise<{ supabase: SupabaseClient; ws: ResearchWorkspace }> {
  const supabase = await createClient();
  const ws = await loadResearchWorkspace(supabase, workspaceId);
  // RLS already scopes to the agency; this turns a foreign id into an error
  // rather than a silent no-op that looks like a run.
  if (!ws) throw new Error("That site is not on this account.");
  return { supabase, ws };
}

async function readCapacity(supabase: SupabaseClient, workspaceId: string): Promise<PlanCapacity> {
  const { count } = await supabase
    .from("calendar_entries")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .in("status", ["queue", "scheduled"]);
  return planCapacity(count ?? 0, SCHEDULE_CAP);
}

async function readStored(supabase: SupabaseClient, workspaceId: string): Promise<StoredKeyword[]> {
  const { data } = await supabase
    .from("keywords")
    .select("id, term, volume, difficulty, intent, created_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "stored")
    .order("created_at", { ascending: false });
  return ((data ?? []) as StoredKeyword[]).map((k) => ({
    ...k,
    // A 0 volume on a stored row is the pre-054 default, not a measurement.
    volume: typeof k.volume === "number" && k.volume > 0 ? k.volume : null,
  }));
}

export async function loadResearchContext(workspaceId: string): Promise<ResearchContext> {
  const { supabase, ws } = await scoped(workspaceId);
  const [{ data: wsRow }, capacity, instructions, stored] = await Promise.all([
    supabase.from("workspaces").select("auto_generate_weekly_limit").eq("id", workspaceId).maybeSingle(),
    readCapacity(supabase, workspaceId),
    readKeywordInstructions(supabase, workspaceId),
    readStored(supabase, workspaceId),
  ]);
  const seedCtx = { brand: competitorName(ws.domain), profile: ws.profile };
  return {
    workspace: { id: ws.id, name: ws.name, domain: ws.domain },
    profile: ws.profile,
    capacity,
    weeklyLimit: (wsRow?.auto_generate_weekly_limit as number | null) ?? 1,
    instructions,
    stored,
    playbooks: PLAYBOOKS.map((p) => {
      const examples = playbookExamples(p.id, seedCtx);
      return { id: p.id, title: p.title, description: p.description, pattern: p.pattern, examples, available: examples.length > 0, needs: p.needs };
    }),
    providerReady: Boolean(process.env.DATAFORSEO_API_KEY || (process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD)),
    modelReady: Boolean(process.env.ANTHROPIC_API_KEY),
  };
}

export async function runGenerate(workspaceId: string, input: GenerateInput): Promise<ResearchResult> {
  const { supabase, ws } = await scoped(workspaceId);
  const instructions = await readKeywordInstructions(supabase, workspaceId);
  return researchGenerate(supabase, ws, input, { instructions });
}

export async function runPlaybook(workspaceId: string, playbook: PlaybookId): Promise<ResearchResult> {
  const { supabase, ws } = await scoped(workspaceId);
  const instructions = await readKeywordInstructions(supabase, workspaceId);
  return researchPlaybook(supabase, ws, playbook, { instructions });
}

export async function runFind(workspaceId: string, term: string): Promise<ResearchResult> {
  const { supabase, ws } = await scoped(workspaceId);
  return researchFind(supabase, ws, term);
}

export async function runImport(workspaceId: string, text: string): Promise<ResearchResult> {
  const { supabase, ws } = await scoped(workspaceId);
  return researchImport(supabase, ws, parseTermList(text));
}

/**
 * Make sure a keyword row exists for each candidate and return their ids.
 *
 * New terms are inserted as `stored`; an existing row keeps its status. Terms
 * are matched the way the funnel matched them, so a candidate flagged as
 * already tracked resolves to that row rather than a near-duplicate.
 */
async function ensureKeywordRows(
  supabase: SupabaseClient,
  workspaceId: string,
  candidates: ResearchCandidate[],
): Promise<Map<string, { id: string; status: string }>> {
  const { data: existing } = await supabase.from("keywords").select("id, term, status").eq("workspace_id", workspaceId);
  const byTarget = new Map<string, { id: string; status: string }>();
  for (const k of (existing ?? []) as Array<{ id: string; term: string; status: string }>) {
    const key = normalizeTarget(k.term);
    if (key && !byTarget.has(key)) byTarget.set(key, { id: k.id, status: k.status });
  }

  const fresh = new Map<string, ResearchCandidate>();
  for (const c of candidates) {
    const key = normalizeTarget(c.term);
    if (!key || byTarget.has(key) || fresh.has(key)) continue;
    fresh.set(key, c);
  }

  if (fresh.size) {
    const rows = [...fresh.values()].map((c) => ({
      workspace_id: workspaceId,
      term: c.term.trim(),
      // Unknown stays null in the row too. The keywords page renders null
      // as a dash; writing 0 would turn "we do not know" into "nobody searches this".
      volume: c.volume,
      difficulty: c.difficulty,
      intent: c.intent,
      status: "stored",
    }));
    const { data: inserted, error } = await supabase
      .from("keywords")
      .upsert(rows, { onConflict: "workspace_id,term", ignoreDuplicates: true })
      .select("id, term, status");
    if (error) throw new Error(error.message);
    for (const k of (inserted ?? []) as Array<{ id: string; term: string; status: string }>) {
      byTarget.set(normalizeTarget(k.term), { id: k.id, status: k.status });
    }
    // A row that already existed under a differently-cased term is skipped by
    // ignoreDuplicates and not returned; read it back so nothing is lost.
    const missing = [...fresh.keys()].filter((k) => !byTarget.has(k));
    if (missing.length) {
      const { data: again } = await supabase.from("keywords").select("id, term, status").eq("workspace_id", workspaceId);
      for (const k of (again ?? []) as Array<{ id: string; term: string; status: string }>) {
        const key = normalizeTarget(k.term);
        if (key && !byTarget.has(key)) byTarget.set(key, { id: k.id, status: k.status });
      }
    }
  }

  const out = new Map<string, { id: string; status: string }>();
  for (const c of candidates) {
    const hit = byTarget.get(normalizeTarget(c.term));
    if (hit) out.set(c.term, hit);
  }
  return out;
}

export interface ScheduleReport {
  scheduled: number;
  refused: number;
  capacity: PlanCapacity;
  /** Terms that were already on the calendar and were left alone. */
  alreadyPlanned: number;
}

/** Put the chosen candidates on the calendar. The one place the drawer writes a plan. */
export async function scheduleCandidates(
  workspaceId: string,
  candidates: ResearchCandidate[],
  runId: string | null,
): Promise<ScheduleReport> {
  const { supabase } = await scoped(workspaceId);
  if (!candidates.length) {
    return { scheduled: 0, refused: 0, alreadyPlanned: 0, capacity: await readCapacity(supabase, workspaceId) };
  }
  const rows = await ensureKeywordRows(supabase, workspaceId, candidates);
  const ids = [...new Set([...rows.values()].map((r) => r.id))];
  const outcome = await scheduleKeywords(supabase, workspaceId, ids);
  const alreadyPlanned = ids.length - outcome.scheduled.length - outcome.refused.length;

  if (runId && outcome.scheduled.length) {
    await supabase
      .from("keyword_research_runs")
      .update({ scheduled: outcome.scheduled.length })
      .eq("workspace_id", workspaceId)
      .eq("id", runId);
  }
  revalidatePath("/keywords");
  revalidatePath("/content");
  return { scheduled: outcome.scheduled.length, refused: outcome.refused.length, alreadyPlanned: Math.max(0, alreadyPlanned), capacity: outcome.capacity };
}

/** Keep the chosen candidates without scheduling them. */
export async function storeCandidates(workspaceId: string, candidates: ResearchCandidate[]): Promise<{ stored: number; alreadyTracked: number }> {
  const { supabase } = await scoped(workspaceId);
  if (!candidates.length) return { stored: 0, alreadyTracked: 0 };
  const rows = await ensureKeywordRows(supabase, workspaceId, candidates);
  // A row nobody has looked at yet ('new') becomes stored; anything further
  // along - planned, drafting, shipped - is left exactly where it is.
  const promote = [...rows.values()].filter((r) => r.status === "new").map((r) => r.id);
  if (promote.length) {
    await supabase.from("keywords").update({ status: "stored" }).eq("workspace_id", workspaceId).in("id", promote);
  }
  const stored = [...rows.values()].filter((r) => r.status === "stored" || r.status === "new").length;
  revalidatePath("/keywords");
  return { stored, alreadyTracked: rows.size - stored };
}

/** Schedule keywords already on the Stored shelf. */
export async function scheduleStored(workspaceId: string, keywordIds: string[]): Promise<ScheduleReport> {
  const { supabase } = await scoped(workspaceId);
  const outcome = await scheduleKeywords(supabase, workspaceId, keywordIds);
  revalidatePath("/keywords");
  revalidatePath("/content");
  return {
    scheduled: outcome.scheduled.length,
    refused: outcome.refused.length,
    alreadyPlanned: Math.max(0, keywordIds.length - outcome.scheduled.length - outcome.refused.length),
    capacity: outcome.capacity,
  };
}

export async function saveKeywordInstructions(workspaceId: string, text: string): Promise<void> {
  const { supabase } = await scoped(workspaceId);
  const clean = text.trim().slice(0, KEYWORD_INSTRUCTIONS_MAX);
  const { error } = await supabase.from("workspace_output_settings").upsert(
    { workspace_id: workspaceId, global_keyword_prompt: clean || null, updated_at: new Date().toISOString() },
    { onConflict: "workspace_id" },
  );
  if (error) throw new Error(error.message);
}

/** One chat turn. Research runs; scheduling is proposed, never done. */
export async function chatResearch(
  workspaceId: string,
  history: ChatTurn[],
  known: ResearchCandidate[],
): Promise<ChatReply> {
  const { supabase, ws } = await scoped(workspaceId);
  if (!process.env.ANTHROPIC_API_KEY) {
    return { text: "Chat needs ANTHROPIC_API_KEY on the server. The Generate and Add tabs still work without it.", proposals: [], trace: [] };
  }
  const [capacity, instructions, { data: plannedRows }] = await Promise.all([
    readCapacity(supabase, workspaceId),
    readKeywordInstructions(supabase, workspaceId),
    supabase
      .from("calendar_entries")
      .select("keyword, scheduled_date, keywords:keyword_id(volume, difficulty)")
      .eq("workspace_id", workspaceId)
      .in("status", ["queue", "scheduled"])
      .order("scheduled_date", { ascending: true })
      .limit(60),
  ]);
  type Row = { keyword: string | null; scheduled_date: string; keywords: { volume: number | null; difficulty: number | null } | null };
  const planned = ((plannedRows ?? []) as unknown as Row[])
    .filter((r) => r.keyword)
    .map((r) => ({
      term: r.keyword as string,
      volume: r.keywords?.volume && r.keywords.volume > 0 ? r.keywords.volume : null,
      difficulty: r.keywords?.difficulty ?? null,
      date: r.scheduled_date,
    }));

  const trimmed = history.slice(-12).map((t) => ({ role: t.role, text: t.text.slice(0, 4000) }));
  return runResearchChat({ ws, capacity, planned, instructions }, trimmed, known.slice(-200), {
    generate: (source, count) => researchGenerate(supabase, ws, { source, count, competitors: ws.profile.competitors, audiences: ws.profile.audiences }, { instructions }),
    find: (term) => researchFind(supabase, ws, term),
    import: (terms) => researchImport(supabase, ws, terms),
  });
}

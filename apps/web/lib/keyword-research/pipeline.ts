// ---------------------------------------------------------------------------
// The research pipeline: from a question to a proposal
// ---------------------------------------------------------------------------
//
// Four ways in - Generate, Playbook, Find, Import - and one way out: a ranked
// table of candidates with an accounted funnel and a `keyword_research_runs`
// row. Nothing here schedules anything. Scheduling is a separate click, and
// `scheduleKeywords` in lib/onboarding/plan.ts is the only thing that does it.
//
// Spend discipline: every DataForSEO call in this file is one of
//   ranked_keywords   one per selected competitor (bounded to 5)
//   keyword_overview  one per batch of up to 700 phrases
//   keyword_suggestions  one, for the Find tab's related terms
// and each logs its cost in development.

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropicModel } from "@/lib/ai/models";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { fetchRankedKeywords } from "@/lib/seo/ranked-keywords";
import { discoverKeywordsFromSeeds } from "@/lib/seo/keywords";
import { classifyIntent } from "@/lib/seo/intent";
import { hasDataForSEOCredentials } from "@/lib/seo/client";
import { applyFunnel, MIN_VOLUME, type ExistingKeyword } from "./funnel";
import { fetchTermMetrics, type TermMetrics } from "./metrics";
import { withInstructions } from "./instructions";
import { buildPlaybookSeeds, competitorName, PLAYBOOKS, type PlaybookId } from "./seeds";
import type { ResearchCandidate, ResearchKind, ResearchResult, ResearchSource } from "./types";

/** What the pipeline needs to know about the site it is researching for. */
export interface ResearchWorkspace {
  id: string;
  name: string;
  domain: string;
  languageCode: string;
  locationCode: number;
  profile: BusinessProfile;
}

/** The person's standing brief, prepended to every model prompt. */
export interface ResearchOptions {
  instructions?: string;
}

const MAX_COMPETITORS = 5;
const PER_COMPETITOR = 40;
const MAX_SEEDS = 12;

export const GENERATE_DEFAULT = 5;
export const GENERATE_MAX = 30;

function metricsToCandidate(m: TermMetrics, origin: string): ResearchCandidate {
  return { term: m.term, volume: m.volume, difficulty: m.difficulty, cpc: m.cpc, intent: m.intent, origin, existingId: null, existingStatus: null };
}

/** A phrase we looked up and the index did not know. Counted, never invented. */
function unknownCandidate(term: string, origin: string, languageCode: string): ResearchCandidate {
  return { term, volume: null, difficulty: null, cpc: null, intent: classifyIntent(term, languageCode).intent, origin, existingId: null, existingStatus: null };
}

/**
 * Look up a list of phrases and return one candidate per phrase, with the
 * ones the index does not know carrying null metrics so the funnel can count
 * them as "no search data" instead of losing them.
 */
async function lookupPhrases(
  phrases: string[],
  origin: (term: string) => string,
  ws: ResearchWorkspace,
): Promise<ResearchCandidate[]> {
  const metrics = await fetchTermMetrics(phrases, { languageCode: ws.languageCode, locationCode: ws.locationCode });
  return phrases.map((p) => {
    const m = metrics.get(p.toLowerCase());
    return m ? metricsToCandidate(m, origin(p)) : unknownCandidate(p, origin(p), ws.languageCode);
  });
}

async function existingKeywords(supabase: SupabaseClient, workspaceId: string): Promise<ExistingKeyword[]> {
  const { data } = await supabase.from("keywords").select("id, term, status").eq("workspace_id", workspaceId);
  return ((data ?? []) as Array<{ id: string; term: string; status: string }>).map((k) => ({ id: k.id, term: k.term, status: k.status }));
}

async function recordRun(
  supabase: SupabaseClient,
  workspaceId: string,
  kind: ResearchKind,
  input: Record<string, unknown>,
  result: { funnel: ResearchResult["funnel"] },
): Promise<string | null> {
  const { data } = await supabase
    .from("keyword_research_runs")
    .insert({
      workspace_id: workspaceId,
      kind,
      input: { ...input, skipped_existing: result.funnel.skippedExisting },
      found: result.funnel.found,
      skipped_no_data: result.funnel.skippedNoData,
      skipped_low_volume: result.funnel.skippedLowVolume,
      scheduled: 0,
    })
    .select("id")
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

function requireProvider(): string | null {
  return hasDataForSEOCredentials() ? null : "Keyword metrics need DataForSEO credentials (DATAFORSEO_API_KEY). Set them to research keywords.";
}

// ---------------------------------------------------------------------------
// Seeds from a model, for the audiences source
// ---------------------------------------------------------------------------

const SEED_PROMPT = [
  "You propose search queries for an SEO content plan.",
  "Return ONLY a JSON object, no prose, no code fence: {\"seeds\": [\"...\", ...]}",
  "",
  "Rules:",
  "- Each seed is a phrase a person in one of the AUDIENCES would type into Google while looking for what this business sells.",
  "- 2 to 5 words. Lower case. No brand names, no punctuation, no question marks.",
  "- Mix informational (how to, what is), commercial (best, tools, software) and comparison shapes.",
  "- Specific beats broad: \"warehouse slotting software\" not \"software\".",
  "- Never repeat a phrase or a trivial re-ordering of one.",
].join("\n");

/** Parse `{"seeds":[...]}` defensively: a fence, a preamble or junk entries must not empty the run. */
export function parseSeedList(raw: string, max = MAX_SEEDS): string[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (parsed as { seeds?: unknown })?.seeds;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    if (typeof s !== "string") continue;
    const clean = s.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
    if (clean.length < 3 || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

export async function generateAudienceSeeds(
  ws: ResearchWorkspace,
  audiences: string[],
  count: number,
  instructions = "",
): Promise<{ seeds: string[]; note: string | null }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { seeds: [], note: "Audience research needs ANTHROPIC_API_KEY to propose seed phrases." };
  if (!audiences.length) return { seeds: [], note: null };

  const user = withInstructions(
    instructions,
    [
      SEED_PROMPT,
      "",
      `BUSINESS: ${ws.name || ws.domain}`,
      ws.profile.description ? `WHAT IT DOES: ${ws.profile.description}` : "",
      `AUDIENCES: ${audiences.join("; ")}`,
      `Return ${Math.min(MAX_SEEDS, Math.max(4, count * 2))} seeds.`,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: anthropicModel("structured"),
      max_tokens: 800,
      messages: [{ role: "user", content: user }],
    });
    const raw = response.content[0]?.type === "text" ? response.content[0].text : "";
    const seeds = parseSeedList(raw);
    return { seeds, note: seeds.length ? null : "The model proposed no usable seed phrases for these audiences." };
  } catch (err) {
    return { seeds: [], note: `Seed generation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

export interface GenerateInput {
  source: ResearchSource;
  competitors: string[];
  audiences: string[];
  count: number;
}

export async function researchGenerate(
  supabase: SupabaseClient,
  ws: ResearchWorkspace,
  input: GenerateInput,
  opts: ResearchOptions = {},
): Promise<ResearchResult> {
  const kind: ResearchKind = "generate";
  const missing = requireProvider();
  const trace: string[] = [];
  const notes: string[] = [];
  const count = Math.max(1, Math.min(GENERATE_MAX, Math.floor(input.count) || GENERATE_DEFAULT));
  if (missing) return { runId: null, kind, candidates: [], funnel: emptyFunnel(), trace, note: missing };

  const raw: ResearchCandidate[] = [];
  const useCompetitors = input.source !== "audiences";
  const useAudiences = input.source !== "competitors";

  if (useCompetitors) {
    const domains = [...new Set(input.competitors.map((d) => d.trim().toLowerCase()).filter(Boolean))].slice(0, MAX_COMPETITORS);
    if (!domains.length) {
      notes.push("No competitors selected.");
    } else {
      const results = await Promise.allSettled(
        domains.map((d) =>
          fetchRankedKeywords(d, {
            languageCode: ws.languageCode,
            locationCode: ws.locationCode,
            limit: PER_COMPETITOR,
            minVolume: MIN_VOLUME,
            maxRank: 20,
          }),
        ),
      );
      let found = 0;
      let failed = 0;
      results.forEach((r, i) => {
        if (r.status !== "fulfilled") {
          failed++;
          return;
        }
        for (const k of r.value) {
          found++;
          // Difficulty 0 with real volume is "not computed" (see metrics.ts).
          const difficulty = k.difficulty === 0 && (k.volume ?? 0) >= 1000 ? null : k.difficulty;
          raw.push({
            term: k.keyword,
            volume: k.volume,
            difficulty,
            cpc: k.cpc,
            intent: classifyIntent(k.keyword, ws.languageCode).intent,
            origin: k.position ? `${competitorName(domains[i])} ranks #${k.position}` : `${competitorName(domains[i])} ranks for it`,
            existingId: null,
            existingStatus: null,
          });
        }
      });
      trace.push(`Researched ${domains.length} competitor${domains.length === 1 ? "" : "s"} → ${found} candidates${failed ? ` (${failed} could not be read)` : ""}`);
    }
  }

  if (useAudiences) {
    const audiences = [...new Set(input.audiences.map((a) => a.trim()).filter(Boolean))];
    if (!audiences.length) {
      notes.push("No audiences selected.");
    } else {
      const { seeds, note } = await generateAudienceSeeds(ws, audiences, count, opts.instructions);
      if (note) notes.push(note);
      if (seeds.length) {
        const looked = await lookupPhrases(seeds, () => `audience: ${audiences.length === 1 ? audiences[0] : "seed phrase"}`, ws);
        const withData = looked.filter((c) => c.volume !== null).length;
        raw.push(...looked);
        trace.push(`Proposed ${seeds.length} seed phrases for ${audiences.length} audience${audiences.length === 1 ? "" : "s"} → ${withData} had search data`);
      }
    }
  }

  const existing = await existingKeywords(supabase, ws.id);
  const { candidates, funnel } = applyFunnel(raw, existing, { limit: count });
  trace.push(funnelTrace(funnel));

  const runId = await recordRun(supabase, ws.id, kind, { source: input.source, competitors: input.competitors, audiences: input.audiences, count }, { funnel });
  return {
    runId,
    kind,
    candidates,
    funnel,
    trace,
    note: candidates.length ? (notes.length ? notes.join(" ") : null) : nothingNote(funnel, notes),
  };
}

// ---------------------------------------------------------------------------
// Playbooks
// ---------------------------------------------------------------------------

export async function researchPlaybook(
  supabase: SupabaseClient,
  ws: ResearchWorkspace,
  playbook: PlaybookId,
  opts: ResearchOptions & { category?: string | null } = {},
): Promise<ResearchResult> {
  const kind: ResearchKind = "playbook";
  const missing = requireProvider();
  const meta = PLAYBOOKS.find((p) => p.id === playbook);
  if (!meta) return { runId: null, kind, candidates: [], funnel: emptyFunnel(), trace: [], note: "Unknown playbook." };
  if (missing) return { runId: null, kind, candidates: [], funnel: emptyFunnel(), trace: [], note: missing };

  const seeds = buildPlaybookSeeds(playbook, { brand: competitorName(ws.domain), profile: ws.profile, category: opts.category ?? null });
  const trace: string[] = [];
  if (!seeds.length) {
    const why =
      meta.needs === "competitors"
        ? "This playbook needs competitors in the business profile, and there are none."
        : meta.needs === "audiences"
          ? "This playbook needs audiences in the business profile, and there are none."
          : "This playbook needs a business description to work from.";
    return { runId: null, kind, candidates: [], funnel: emptyFunnel(), trace, note: why };
  }

  const looked = await lookupPhrases(seeds, () => meta.title, ws);
  trace.push(`${meta.title}: built ${seeds.length} phrases → ${looked.filter((c) => c.volume !== null).length} had search data`);

  const existing = await existingKeywords(supabase, ws.id);
  const { candidates, funnel } = applyFunnel(looked, existing);
  trace.push(funnelTrace(funnel));

  const runId = await recordRun(supabase, ws.id, kind, { playbook, seeds }, { funnel });
  return { runId, kind, candidates, funnel, trace, note: candidates.length ? null : nothingNote(funnel, []) };
}

// ---------------------------------------------------------------------------
// Add: Find one term, Import a list
// ---------------------------------------------------------------------------

export async function researchFind(
  supabase: SupabaseClient,
  ws: ResearchWorkspace,
  term: string,
): Promise<ResearchResult> {
  const kind: ResearchKind = "manual";
  const missing = requireProvider();
  const clean = term.replace(/\s+/g, " ").trim();
  if (!clean) return { runId: null, kind, candidates: [], funnel: emptyFunnel(), trace: [], note: "Enter a word or phrase." };
  if (missing) return { runId: null, kind, candidates: [], funnel: emptyFunnel(), trace: [], note: missing };

  const [exact, related] = await Promise.all([
    lookupPhrases([clean], () => "you searched for it", ws),
    discoverKeywordsFromSeeds([clean], { languageCode: ws.languageCode, locationCode: ws.locationCode, limit: 10, maxSeeds: 1, minVolume: 0 }).catch(() => []),
  ]);
  const raw: ResearchCandidate[] = [
    ...exact,
    ...related
      .filter((k) => k.keyword.toLowerCase() !== clean.toLowerCase())
      .slice(0, 10)
      .map((k) => ({
        term: k.keyword,
        volume: k.volume > 0 ? k.volume : null,
        difficulty: k.difficulty === 0 && k.volume >= 1000 ? null : k.difficulty,
        cpc: k.cpc > 0 ? k.cpc : null,
        intent: k.intent,
        origin: `related to "${clean}"`,
        existingId: null,
        existingStatus: null,
      })),
  ];
  const trace = [`Looked up "${clean}" → ${related.length} related terms`];

  const existing = await existingKeywords(supabase, ws.id);
  // The typed term stays in the table even when the index does not know it,
  // and even when it is already tracked: hiding it would answer a different
  // question from the one asked.
  const { candidates, funnel } = applyFunnel(raw, existing, { keepExisting: true, keepNoData: true, minVolume: 0 });
  const ordered = [...candidates].sort((a, b) => (a.term.toLowerCase() === clean.toLowerCase() ? -1 : b.term.toLowerCase() === clean.toLowerCase() ? 1 : 0));
  trace.push(funnelTrace(funnel));

  const runId = await recordRun(supabase, ws.id, kind, { term: clean }, { funnel });
  return { runId, kind, candidates: ordered, funnel, trace, note: ordered.length ? null : nothingNote(funnel, []) };
}

export async function researchImport(
  supabase: SupabaseClient,
  ws: ResearchWorkspace,
  terms: string[],
): Promise<ResearchResult> {
  const kind: ResearchKind = "import";
  const missing = requireProvider();
  const clean = [...new Set(terms.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean))];
  if (!clean.length) return { runId: null, kind, candidates: [], funnel: emptyFunnel(), trace: [], note: "Enter keywords separated by commas or new lines." };
  if (missing) return { runId: null, kind, candidates: [], funnel: emptyFunnel(), trace: [], note: missing };

  const looked = await lookupPhrases(clean, () => "imported", ws);
  const trace = [`Looked up ${clean.length} term${clean.length === 1 ? "" : "s"} → ${looked.filter((c) => c.volume !== null).length} had search data`];

  const existing = await existingKeywords(supabase, ws.id);
  const { candidates, funnel } = applyFunnel(looked, existing, { keepExisting: true, keepNoData: true, minVolume: 0 });
  trace.push(funnelTrace(funnel));

  const runId = await recordRun(supabase, ws.id, kind, { terms: clean }, { funnel });
  return { runId, kind, candidates, funnel, trace, note: candidates.length ? null : nothingNote(funnel, []) };
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

export function emptyFunnel(): ResearchResult["funnel"] {
  return { found: 0, skippedNoData: 0, skippedLowVolume: 0, skippedExisting: 0, proposed: 0 };
}

function funnelTrace(f: ResearchResult["funnel"]): string {
  const drops: string[] = [];
  if (f.skippedExisting) drops.push(`${f.skippedExisting} already tracked`);
  if (f.skippedNoData) drops.push(`${f.skippedNoData} had no search data`);
  if (f.skippedLowVolume) drops.push(`${f.skippedLowVolume} too little volume`);
  return `${f.found} distinct${drops.length ? ` → ${drops.join(", ")}` : ""} → ${f.proposed} proposed`;
}

/** Why the table is empty, in one sentence that names the real reason. */
function nothingNote(f: ResearchResult["funnel"], notes: string[]): string {
  if (notes.length && f.found === 0) return notes.join(" ");
  if (f.found === 0) return "Nothing came back from the keyword provider for this request.";
  const reasons: string[] = [];
  if (f.skippedExisting) reasons.push(`${f.skippedExisting} already tracked`);
  if (f.skippedNoData) reasons.push(`${f.skippedNoData} with no search data`);
  if (f.skippedLowVolume) reasons.push(`${f.skippedLowVolume} under ${MIN_VOLUME} searches a month`);
  return `Found ${f.found}, but none to propose: ${reasons.join(", ")}.${notes.length ? ` ${notes.join(" ")}` : ""}`;
}

/** Read the workspace as the pipeline needs it, or null when it is not on this account. */
export async function loadResearchWorkspace(supabase: SupabaseClient, workspaceId: string): Promise<ResearchWorkspace | null> {
  const { data } = await supabase
    .from("workspaces")
    .select("id, name, domain, language, location_code, business_profile")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!data) return null;
  const profile = (data.business_profile as Partial<BusinessProfile> | null) ?? null;
  return {
    id: data.id as string,
    name: (data.name as string) ?? "",
    domain: (data.domain as string) ?? "",
    languageCode: ((data.language as string | null) ?? "en").split("-")[0],
    locationCode: (data.location_code as number | null) ?? 2840,
    profile: {
      name: profile?.name ?? (data.name as string) ?? "",
      language: profile?.language ?? "English",
      country: profile?.country ?? "Global (English)",
      description: profile?.description ?? "",
      audiences: Array.isArray(profile?.audiences) ? profile.audiences.filter((a): a is string => typeof a === "string") : [],
      competitors: Array.isArray(profile?.competitors) ? profile.competitors.filter((c): c is string => typeof c === "string") : [],
    },
  };
}

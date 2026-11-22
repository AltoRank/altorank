// ---------------------------------------------------------------------------
// "Write this": the owner accepts the topic a first look proposed
// ---------------------------------------------------------------------------
//
// A first look that found topics but nothing to cite for any of them plans
// nothing by itself and proposes its best one (./first-look-plan.ts,
// `needs_owner_input`): the writer starts an automatic article only from a
// brief that cites an observed article, and none was observed. The owner's
// click is what was missing. It becomes the brief's `ownerConfirmed`
// (lib/keyword-research/first-look-topics.ts `ownerConfirmedBrief`), the
// topic goes on the calendar, and the run that proposed it writes the
// article from the draft reserve it never spent.
//
// Service client throughout: the action (app/actions/onboard-proposal.ts)
// has already checked who is asking.

import type { SupabaseClient } from "@supabase/supabase-js";
import { planHold } from "@/lib/billing/trial-hold";
import { dispatchFirstDraft } from "@/lib/content/fan-out";
import type { FitProfile } from "@/lib/keyword-research/buyer-fit";
import { ownerConfirmedBrief, readProposal } from "@/lib/keyword-research/first-look-topics";
import { languageCodeOf } from "@/lib/keyword-research/locale";
import { contextKey } from "@/lib/keyword-research/opportunity";
import { FREE_TIER_PACE } from "@/lib/content/pace";
import { classifyIntent } from "@/lib/seo/intent";
import type { OnboardingRunRow, OnboardingStep } from "./events";
import { nextOpenDates } from "./plan-limits";
import { RUN_COLUMNS, stampRun } from "./run-store";

export type ProposalAnswer =
  /** `writing`: the article has started; false means it is on the calendar and is written by the nightly pass. */
  | { ok: true; term: string; writing: boolean }
  | { ok: false; message: string };

export interface AcceptDeps {
  dispatch?: typeof dispatchFirstDraft;
  /** Keeps the invocation alive for the dispatched request (`after()` in a server action). */
  keepAlive?: (work: Promise<unknown>) => void;
  now?: Date;
}

const GONE = "That proposal is no longer open. Reload the page to see where setup stands.";

export async function acceptProposal(db: SupabaseClient, workspaceId: string, deps: AcceptDeps = {}): Promise<ProposalAnswer> {
  const now = deps.now ?? new Date();
  const { data: found } = await db.from("onboarding_runs").select(RUN_COLUMNS).eq("workspace_id", workspaceId).order("started_at", { ascending: false }).limit(1).maybeSingle();
  const run = found as OnboardingRunRow | null;
  if (!run || run.status === "running" || run.status === "error") return { ok: false, message: GONE };
  const planning = (run.phases ?? []).find((p) => p.phase === "planning");
  const proposal = planning?.cause === "needs_owner_input" ? readProposal(planning.proposal) : null;
  if (!proposal) return { ok: false, message: GONE };

  // The trial's one article: a proposal is not a way to a second.
  if ((await planHold(db, workspaceId)) === "spent") return { ok: false, message: "Your first article was already written; the rest of the plan opens with the trial." };

  const { data: ws } = await db.from("workspaces").select("id, domain, language, location_code, business_profile, auto_generate_weekly_limit").eq("id", workspaceId).maybeSingle();
  if (!ws) return { ok: false, message: "This site no longer exists." };
  const workspace = ws as { domain: string | null; language: string | null; location_code: number | null; business_profile: unknown; auto_generate_weekly_limit: number | null };
  const business = (workspace.business_profile ?? null) as (FitProfile & { conversionUrl?: string | null }) | null;
  const languageCode = languageCodeOf(workspace.language);
  // The four facts the writer checks the brief under (`assertAutonomousTopic`).
  const fingerprint = contextKey({ business, domain: workspace.domain ?? "", languageCode, locationCode: workspace.location_code ?? 2840 });
  const domain = (workspace.domain ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const brief = ownerConfirmedBrief(proposal, { fingerprint, domain, conversionUrl: business?.conversionUrl ?? null, now });

  // The keyword row: the one the site has for this search, or a new one.
  const { data: existing } = await db.from("keywords").select("id").eq("workspace_id", workspaceId).eq("term", proposal.term).maybeSingle();
  let keywordId = (existing as { id: string } | null)?.id ?? null;
  if (keywordId) {
    const { error } = await db.from("keywords").update({ opportunity: brief, status: "planned", plan_excluded_at: null }).eq("id", keywordId).eq("workspace_id", workspaceId);
    if (error) return { ok: false, message: "Could not save the topic. Try again in a minute." };
  } else {
    const { data, error } = await db.from("keywords").insert({
      workspace_id: workspaceId, term: proposal.term, volume: proposal.volume, difficulty: proposal.difficulty, cpc: null,
      intent: classifyIntent(proposal.term, workspace.language ?? "en").intent, status: "planned", source: "ideas", source_type: "profile", source_ref: proposal.reader.slice(0, 200) || null,
      opportunity: brief,
    }).select("id").single();
    if (error || !data) return { ok: false, message: "Could not save the topic. Try again in a minute." };
    keywordId = (data as { id: string }).id;
  }

  // On the calendar once: a second click finds the entry the first made.
  const { data: entries } = await db.from("calendar_entries").select("keyword_id, scheduled_date, article_id, status").eq("workspace_id", workspaceId).in("status", ["queue", "scheduled"]);
  const rows = (entries ?? []) as Array<{ keyword_id: string | null; scheduled_date: string; article_id: string | null }>;
  const mine = rows.find((e) => e.keyword_id === keywordId);
  if (mine?.article_id) return { ok: true, term: proposal.term, writing: true };
  let date = mine?.scheduled_date ?? null;
  if (!date) {
    date = nextOpenDates(rows.map((e) => e.scheduled_date), Math.max(1, workspace.auto_generate_weekly_limit ?? FREE_TIER_PACE), 1, now)[0] ?? now.toISOString().slice(0, 10);
    const { error } = await db.from("calendar_entries").insert({ workspace_id: workspaceId, keyword_id: keywordId, keyword: proposal.term, scheduled_date: date, status: "queue" });
    if (error) return { ok: false, message: "Could not put the topic on your calendar. Try again in a minute." };
  }

  // The run that proposed it writes it: reopened, guarded on the status it
  // ended with, so two clicks cannot both reopen it. Its draft reserve is
  // unspent, and the draft route settles the row when the article lands.
  const steps: OnboardingStep[] = (run.phases ?? []).map((p) =>
    p.phase === "planning"
      ? { phase: p.phase, status: "done", detail: `Scheduled the article you asked for: "${proposal.term}". It is lower confidence: no published article ranks for that search to check it against.` }
      : p.phase === "drafting"
        ? { phase: p.phase, status: "active", detail: `Writing "${proposal.term}" now.` }
        : p);
  const stamp = now.toISOString();
  const { data: reopened } = await db.from("onboarding_runs")
    .update({ status: "running", finished_at: null, updated_at: stamp, phases: steps, planned: [{ term: proposal.term, date, brief }] })
    .eq("id", run.id)
    .eq("status", run.status)
    .select("id");
  if (!reopened || (reopened as unknown[]).length === 0) return { ok: true, term: proposal.term, writing: false };

  const sent = (deps.dispatch ?? dispatchFirstDraft)({
    workspaceId,
    runId: run.id,
    keyword: proposal.term,
    keywordId,
    selection: { reasons: [proposal.why, "You asked for this topic. No published article ranks for its search yet, so it was not started without you."], score: proposal.score.total, difficulty: proposal.difficulty, volume: proposal.volume },
  });
  if ("skipped" in sent) {
    // This install cannot start a draft from here: the entry is on the
    // calendar, and the nightly pass writes it. The run is closed as it was.
    await stampRun(db, run.id, { phase: "drafting", status: "skipped", detail: `"${proposal.term}" is on your calendar and is written by the next nightly pass.` }, { finish: true });
    return { ok: true, term: proposal.term, writing: false };
  }
  // A request that never reached the draft route, or that it refused before
  // running, closes the run here; the route settles every other ending.
  const settled = sent.request.then(
    async (res) => {
      if (!res.ok) await stampRun(db, run.id, { phase: "drafting", status: "failed", detail: `The draft could not be started (${res.status}).` }, { finish: true });
    },
    async (err: unknown) => {
      await stampRun(db, run.id, { phase: "drafting", status: "failed", detail: `The draft could not be started: ${err instanceof Error ? err.message : String(err)}` }, { finish: true });
    },
  );
  (deps.keepAlive ?? ((work: Promise<unknown>) => void work))(settled);
  return { ok: true, term: proposal.term, writing: true };
}

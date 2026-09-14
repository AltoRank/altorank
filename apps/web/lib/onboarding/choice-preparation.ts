import type { SupabaseClient } from "@supabase/supabase-js";
import { loadGlobalDraftInstructions } from "@/lib/content/draft-instructions";
import { draftPreparationContext, prepareDraft, readDraftPreparation,draftPreparationTask, type DraftPreparationInput } from "@/lib/content/draft-preparation";
import { selfInvocation, selfInvoke, type SelfInvokeDeps } from "@/lib/content/fan-out";
import { contextKey, readOpportunity } from "@/lib/keyword-research/opportunity";
import { languageCodeOf } from "@/lib/keyword-research/locale";
import type { FitProfile } from "@/lib/keyword-research/buyer-fit";
import { ResearchBudget, withResearchBudget } from "@/lib/seo/request-context";
import type { OnboardingPlanned, OnboardingRunRow, OnboardingStep } from "./events";

export const CHOICE_PREPARATION_MS = 180_000;
export interface ChoicePreparationResult {
  keywordId?: string;
  status: "ready" | "insufficient" | "unavailable" | "changed";
  reason: string;
}
interface ChoiceCheck {
  run_id: string;
  workspace_id: string;
  candidates: OnboardingPlanned[];
  status: "queued" | "preparing" | "done";
  lease: string | null;
  lease_until: string | null;
  attempts: number;
}
function planningPhases(phases: OnboardingStep[], ready?: OnboardingPlanned[], results: ChoicePreparationResult[] = []): OnboardingStep[] {
  const planning: OnboardingStep = ready === undefined
    ? {phase:"planning",status:"active",detail:"Checking the sources needed to answer your article ideas.",briefs:[]}
    : {phase:"planning",status:ready.length ? "done" : "failed",briefs:ready,
      detail:ready.length ? `${ready.length} article idea${ready.length===1?" has":"s have"} sources for their essential answers. Choose your first draft.` : results.some(result=>result.status==="unavailable") ? "Source checks could not finish within this research attempt. Retry research to complete the missing checks." : results.some(result=>result.status==="changed") ? "Your article or business focus changed. Run research again to confirm the choices." : "The available sources did not support a complete first article. Refine your focus or retry research."};
  return [...phases.filter(phase=>phase.phase!=="planning"&&phase.phase!=="drafting"),planning,
    {phase:"drafting",status:ready?.length ? "pending" : ready ? "skipped" : "pending",detail:ready?.length ? "Choose the article you want to read first." : ready ? "No draft was written or charged to your allowance." : "Your first draft follows once its sources are ready."}];
}

/** Persist the original choices before moving work to a separate invocation. */
export async function queueChoicePreparation(db: SupabaseClient, runId: string, workspaceId: string): Promise<void> {
  const existing = await db.from("onboarding_choice_checks").select("run_id").eq("run_id",runId).eq("workspace_id",workspaceId).maybeSingle();
  if (existing.error) throw new Error("Source preparation could not be loaded.");
  if (existing.data) return;
  const found = await db.from("onboarding_runs").select("planned, phases").eq("id",runId).eq("workspace_id",workspaceId).eq("status","running").maybeSingle();
  if (found.error || !found.data) throw new Error("Your article ideas could not be saved for source preparation.");
  const candidates = Array.isArray(found.data.planned) ? found.data.planned : [];
  const saved = await db.from("onboarding_choice_checks").insert({run_id:runId,workspace_id:workspaceId,candidates});
  if (saved.error && saved.error.code!=="23505") throw new Error("Source preparation could not be queued.");
  const updated = await db.from("onboarding_runs").update({planned:[],phases:planningPhases(found.data.phases ?? []),updated_at:new Date().toISOString()}).eq("id",runId).eq("workspace_id",workspaceId).eq("status","running");
  if (updated.error) throw new Error("Source preparation progress could not be saved.");
}

/** A current keyword must still describe the exact discovered task. Re-reading
 * after preparation also prevents a concurrent focus edit from exposing it. */
async function currentInput(db: SupabaseClient, workspaceId: string, choice: OnboardingPlanned): Promise<DraftPreparationInput | null> {
  if (!choice.keywordId || !choice.brief) return null;
  const site = await db.from("workspaces").select("domain,language,location_code,business_profile").eq("id",workspaceId).maybeSingle();
  if (site.error) throw new Error("The current business focus could not be loaded.");
  if (!site.data?.domain) return null;
  const keyword = await db.from("keywords").select("id,term,opportunity,instructions,plan_excluded_at").eq("workspace_id",workspaceId).eq("id",choice.keywordId).maybeSingle();
  if (keyword.error) throw new Error("The current article task could not be loaded.");
  if (!keyword.data || keyword.data.plan_excluded_at || keyword.data.term!==choice.term) return null;
  const profile = (site.data.business_profile ?? null) as FitProfile | null;
  const fingerprint = contextKey({domain:site.data.domain,business:profile,languageCode:languageCodeOf(site.data.language),locationCode:site.data.location_code??2840});
  const brief = readOpportunity(keyword.data.opportunity,fingerprint);
  if (!brief || brief.status!=="qualified") return null;
  const globalInstructions = await loadGlobalDraftInstructions(db, workspaceId);
  const input: DraftPreparationInput = {workspaceId,keywordId:choice.keywordId,keyword:choice.term,brief,profile,domain:site.data.domain,language:site.data.language,locationCode:site.data.location_code,instructions:keyword.data.instructions,globalInstructions};
  return draftPreparationContext(input) === draftPreparationContext({...input,brief:choice.brief}) ? input : null;
}

/** One lease owns the whole bounded source check. Ready packets survive a
 * worker interruption and are reused by the next attempt. */
export async function prepareOnboardingChoices(db: SupabaseClient, runId: string, token: string, options: {durationMs?:number;deadline?:number;prepare?:typeof prepareDraft} = {}): Promise<void> {
  const deadline = Math.min(Date.now() + CHOICE_PREPARATION_MS, options.deadline ?? Date.now() + (options.durationMs ?? CHOICE_PREPARATION_MS));
  const found = await db.from("onboarding_choice_checks").select("*").eq("run_id",runId).eq("lease",token).maybeSingle();
  if (found.error) throw new Error("Source preparation lease could not be loaded.");
  const check = found.data as ChoiceCheck | null;
  if (!check || check.status!=="preparing" || !check.lease_until || Date.parse(check.lease_until)<=Date.now() || !Number.isInteger(check.attempts) || check.attempts<1 || check.attempts>2) return;
  const runResult = await db.from("onboarding_runs").select("id,workspace_id,status,phases").eq("id",runId).eq("workspace_id",check.workspace_id).eq("status","running").maybeSingle();
  if (runResult.error) throw new Error("The onboarding run could not be loaded.");
  if (!runResult.data) return;
  const run = runResult.data as OnboardingRunRow;
  const candidates = Array.isArray(check.candidates) ? check.candidates.slice(0,5) : [];
  const outcomes = new Map<number,ChoicePreparationResult>();
  const prepared = new Map<number,OnboardingPlanned>();
  const budget = new ResearchBudget(30,Math.max(0,deadline-Date.now()));
  await withResearchBudget(budget,async()=>{
    for (let offset=0;offset<candidates.length;offset+=2) {
      await Promise.all(candidates.slice(offset,offset+2).map(async(choice,relative)=>{
        const index=offset+relative;
        let outcome: ChoicePreparationResult = {keywordId:choice.keywordId,status:"unavailable",reason:budget.exhausted ? "Source preparation reached its request or time limit. Retry the missing checks." : "Source checks could not finish. Retry research."};
        try {
          if (!budget.exhausted) {
            const input = await currentInput(db,check.workspace_id,choice);
            if (!input) outcome={keywordId:choice.keywordId,status:"changed",reason:"This article or business focus changed. Run research again to confirm it."};
            else {
              // A new research run or its one recovery lease is an explicit
              // retry. Refresh only unavailable packets; ready and insufficient
              // results remain cached. Each candidate is checked once per lease.
              const packet = await (options.prepare??prepareDraft)(db,input,{retryUnavailable:true});
              const current = await currentInput(db,check.workspace_id,choice);
              if (!current || draftPreparationContext(current)!==packet.context) outcome={keywordId:choice.keywordId,status:"changed",reason:"This article or business focus changed during source preparation. Run research again."};
              else if (!readDraftPreparation(packet,packet.context,draftPreparationTask(current))) outcome={keywordId:choice.keywordId,status:"unavailable",reason:"The source check was incomplete. Retry research."};
              else {
                outcome={keywordId:choice.keywordId,status:packet.status,reason:packet.status==="ready" ? "Sources support the essential answers." : packet.status==="insufficient" ? "Available sources do not answer this article's essential questions." : "Source checks could not finish. Retry research."};
                if (packet.status==="ready") prepared.set(index,{...choice,preparation:{context:packet.context,checkedAt:packet.createdAt,requirements:packet.plan.requirements}});
              }
            }
          }
        } catch { /* A failed topic does not discard another topic's usable sources. */ }
        outcomes.set(index,outcome);
      }));
      const progress=await db.from("onboarding_choice_checks").update({results:[...outcomes].sort(([a],[b])=>a-b).map(([,value])=>value)}).eq("run_id",runId).eq("workspace_id",check.workspace_id).eq("lease",token).select("run_id");
      if (progress.error) throw new Error("Source check results could not be saved.");
      if (!progress.data?.length) return;
    }
    // Earlier candidates may finish while later candidates are still being
    // researched. Check them once more at the point choices become visible.
    for (const [index,choice] of prepared) {
      try {
        const current=await currentInput(db,check.workspace_id,choice);
        if (!current || draftPreparationContext(current)!==choice.preparation?.context) {
          prepared.delete(index);
          outcomes.set(index,{keywordId:choice.keywordId,status:"changed",reason:"This article or business focus changed before its choice was ready. Run research again."});
        }
      } catch {
        prepared.delete(index);
        outcomes.set(index,{keywordId:choice.keywordId,status:"unavailable",reason:"The current article task could not be confirmed. Retry research."});
      }
    }
    const ready = [...prepared].sort(([a],[b])=>a-b).map(([,choice])=>choice);
    const results=[...outcomes].sort(([a],[b])=>a-b).map(([,value])=>value);
    const completed=await db.rpc("finish_onboarding_choices",{p_run:runId,p_token:token,p_planned:ready,p_phases:planningPhases(run.phases??[],ready,results),p_results:results});
    if (completed.error) throw new Error("Prepared article choices could not be saved.");
    if (!completed.data && ready.length) {
      // A keyword or its packet can change between the final read and the
      // transaction. Close that attempt honestly; an expired/replaced lease
      // fails this same guard and cannot alter the replacement worker's run.
      const changed=results.map(result=>result.status==="ready" ? {...result,status:"changed" as const,reason:"The article task or source packet changed before choices were saved. Retry research."} : result);
      const withheld=await db.rpc("finish_onboarding_choices",{p_run:runId,p_token:token,p_planned:[],p_phases:planningPhases(run.phases??[],[],changed),p_results:changed});
      if (withheld.error) throw new Error("The source check outcome could not be saved.");
    }
  });
}

/** Polling may rescue a queued or expired source check, but never restarts
 * discovery or dispatches a second worker while its database lease is live. */
export async function wakeChoicePreparation(db: SupabaseClient, runId: string, options: SelfInvokeDeps & {durationMs?:number} = {}): Promise<void> {
  const deadline = Date.now() + Math.max(0,Math.min(CHOICE_PREPARATION_MS,options.durationMs??CHOICE_PREPARATION_MS));
  const found=await db.from("onboarding_choice_checks").select("status,lease_until").eq("run_id",runId).maybeSingle();
  if (found.error) throw new Error("Source preparation could not be resumed.");
  if (!found.data || found.data.status==="done" || (found.data.lease_until && Date.parse(found.data.lease_until)>Date.now())) return;
  const how=selfInvocation(options);
  if (!("skipped" in how)) {
    const response=await selfInvoke("/api/internal/onboard-choices",{runId},how);
    if (!response.ok) throw new Error(`Source preparation dispatch failed (${response.status}).`);
    return;
  }
  // An almost-spent discovery request leaves the durable queue for the next
  // authenticated poll, whose invocation has a fresh budget.
  if (deadline-Date.now()<10_000) return;
  const claim=await db.rpc("claim_onboarding_choices",{p_run:runId});
  if (claim.error) throw new Error("Source preparation could not be claimed.");
  if (claim.data) await prepareOnboardingChoices(db,runId,claim.data,{deadline});
}

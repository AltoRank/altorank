import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { collectTaskEvidence, compactDraftTask, type DraftEvidencePlan } from "./draft-evidence";
import { prepareSourceBrief, type SourceBrief } from "./source-brief";
import type { PageExtract } from "@/lib/keyword-research/page-evidence";
import type { Opportunity } from "@/lib/keyword-research/opportunity";
import type { BusinessFocus } from "@/lib/onboarding/profile-focus";
import { e2eStubsEnabled, isReservedTestDomain } from "@/lib/e2e/stubs";

export const DRAFT_PREPARATION_VERSION = 1;
export interface DraftPreparationInput {
  workspaceId: string;
  keywordId: string;
  keyword: string;
  brief: Opportunity;
  profile: BusinessFocus | null;
  domain: string;
  language: string | null;
  locationCode: number | null;
  instructions?: string | null;
}
export interface DraftPreparation {
  version: number;
  context: string;
  createdAt: string;
  expiresAt: string;
  status: "ready" | "insufficient" | "unavailable";
  sources: PageExtract[];
  plan: DraftEvidencePlan;
  sourceBrief: SourceBrief;
}
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])) : value;

/** Grouping and UI timestamps do not change an answer. Focus, source identity,
 * locale, instructions and the exact promised task do. */
export function draftPreparationContext(input: DraftPreparationInput): string {
  // Browser fixtures inject writer failure controls after source preparation.
  // They are not article instructions; real instructions always affect scope.
  const instructions = e2eStubsEnabled() && isReservedTestDomain(input.domain)
    ? input.instructions?.replace(/e2e:withhold-(?:material|incomplete)/g, "").trim() || null
    : input.instructions ?? null;
  return createHash("sha256").update(JSON.stringify(stable({
    version: DRAFT_PREPARATION_VERSION, workspaceId: input.workspaceId, keywordId: input.keywordId,
    keyword: input.keyword, brief: compactDraftTask(input.brief), qualificationVersion: input.brief.version,
    qualificationContext: input.brief.context, evidenceUrls: input.brief.evidenceUrls,
    profile: input.profile, domain: input.domain, language: input.language, locationCode: input.locationCode,
    instructions,
  }))).digest("hex");
}

export function readDraftPreparation(raw: unknown, context: string, now = Date.now()): DraftPreparation | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as DraftPreparation;
  if (p.version !== DRAFT_PREPARATION_VERSION || p.context !== context ||
      !["ready","insufficient","unavailable"].includes(p.status) ||
      !Number.isFinite(Date.parse(p.createdAt)) || Date.parse(p.createdAt) > now ||
      !Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= now ||
      !Array.isArray(p.sources) || !p.plan || !p.sourceBrief) return null;
  if (p.status === "ready" && (p.plan.status !== "planned" || !Array.isArray(p.plan.requirements) || !p.plan.requirements.length ||
      p.plan.requirements.some(q=>typeof q !== "string" || !q.trim()) ||
      p.sourceBrief.status !== "prepared" || p.sourceBrief.readiness?.status !== "checked" ||
      !Array.isArray(p.sourceBrief.readiness.questions) ||
      p.sourceBrief.readiness.questions.length !== p.plan.requirements.length ||
      new Set(p.sourceBrief.readiness.questions.map(q=>q?.requirementIndex)).size !== p.plan.requirements.length ||
      p.sourceBrief.readiness.questions.some(q=>!q || q.answered !== true || !Number.isInteger(q.requirementIndex) || !p.plan.requirements[q.requirementIndex]) ||
      !Array.isArray(p.sourceBrief.facts) || !p.sourceBrief.facts.length ||
      !Array.isArray(p.sourceBrief.coverage) || p.sourceBrief.coverage.length !== p.plan.requirements.length ||
      p.sourceBrief.coverage.some((c,i)=>!c || c.question !== p.plan.requirements[i] || !Array.isArray(c.factIndices) || !c.factIndices.length || c.factIndices.some(k=>!Number.isInteger(k) || !p.sourceBrief.facts[k])))) return null;
  return p;
}

export async function loadDraftPreparation(db: SupabaseClient, input: DraftPreparationInput, expected?: {context:string;createdAt:string|undefined}): Promise<DraftPreparation | null> {
  const result = await db.from("draft_preparations").select("payload").eq("workspace_id", input.workspaceId).eq("keyword_id", input.keywordId).maybeSingle();
  if (result.error) throw new Error("Prepared article sources could not be loaded.");
  const prepared=readDraftPreparation(result.data?.payload, draftPreparationContext(input));
  // Context describes the inputs. A later check of those same inputs can
  // freeze a different source packet, so selected drafts also pin its time.
  if (expected && (!expected.createdAt || prepared?.context!==expected.context || prepared.createdAt!==expected.createdAt)) return null;
  return prepared;
}

export async function prepareDraft(db: SupabaseClient, input: DraftPreparationInput, options: {retryUnavailable?:boolean} = {}): Promise<DraftPreparation> {
  const cached = await loadDraftPreparation(db, input);
  if (cached && !(options.retryUnavailable && cached.status === "unavailable")) return cached;
  const now = Date.now();
  const context = draftPreparationContext(input);
  const task = { ...input.brief, ...(input.instructions ? { instructions: input.instructions } : {}) };
  let evidence: {sources:PageExtract[];plan:DraftEvidencePlan};
  let sourceBrief: SourceBrief;
  if (e2eStubsEnabled() && isReservedTestDomain(input.domain)) {
    // Only the paid/non-deterministic boundary is replaced; storage, leases,
    // context checks, selection and quota still use the production path.
    const question = `How does this article help ${input.brief.audience}?`;
    const quote = "Use the route's verified local transport and booking instructions to plan the journey.";
    evidence = {sources:[{url:`https://${input.domain}/guide`,title:"Fixture guide",headings:[],text:quote}],plan:{task:"explanation",status:"planned",requirements:[question],selectedUrls:[],retrievedUrls:[]}};
    sourceBrief = {status:input.instructions?.includes("e2e:withhold-sources") ? "insufficient" : "prepared",facts:[{subject:"Nomad Atlas",plan:"",kind:"explanation",statement:quote,quote,scopeQuote:quote,sourceIndex:0,url:evidence.sources[0].url}],coverage:[{question,factIndices:[0]}],issues:[],readiness:{status:"checked",questions:[{requirementIndex:0,answered:true,reason:"Fixture evidence supports the reader task."}]}};
  } else {
    evidence = await collectTaskEvidence(input.profile, input.brief.conversionPath, input.brief.evidenceUrls ?? [], task, {supabase:db,workspaceId:input.workspaceId});
    sourceBrief = await prepareSourceBrief(evidence.sources, evidence.plan, task,
      (input.profile as {name?:string} | null)?.name ?? input.domain, {supabase:db,workspaceId:input.workspaceId});
  }
  const status = sourceBrief.status === "prepared" ? "ready" : sourceBrief.status;
  const prepared: DraftPreparation = {version:DRAFT_PREPARATION_VERSION,context,createdAt:new Date(now).toISOString(),
    expiresAt:new Date(now + (status === "ready" ? 24*60*60_000 : 5*60_000)).toISOString(),status,...evidence,sourceBrief};
  const saved = await db.from("draft_preparations").upsert({workspace_id:input.workspaceId,keyword_id:input.keywordId,payload:prepared,updated_at:new Date().toISOString()}, {onConflict:"workspace_id,keyword_id"});
  if (saved.error) throw new Error("Prepared article sources could not be saved.");
  return prepared;
}

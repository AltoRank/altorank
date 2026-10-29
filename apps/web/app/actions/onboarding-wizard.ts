"use server";

// ---------------------------------------------------------------------------
// The onboarding wizard's server side
// ---------------------------------------------------------------------------
//
// One action per screen, plus propose and finish. Each is scoped to one
// workspace and checks that the caller owns it - the wizard is reachable with
// a workspace id in the URL, and RLS narrows to the account, not to the site.
//
// Every screen now writes somewhere. The first version saved the business
// profile and let the sitemap, blog, and article settings evaporate on
// Continue, which made three of five screens theatre.

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { hasTrainedVoice, readExampleUrls, retrainFromExamples } from "@/lib/voice/examples";
import { trainVoiceProfile } from "@/lib/voice/train";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { canSpend } from "@/lib/billing/spend-gate";
import {
  awaitDoorInFlight,
  clearDoorInFlight,
  inputKey,
  keepDoorResult,
  markDoorInFlight,
  onceInFlight,
  readDoorCache,
  takeDoor,
  type SpendDoor,
} from "@/lib/billing/spend-doors";
import { withSpendScope } from "@/lib/billing/spend-scope";
import { trialGateApplies } from "@/lib/billing/trial";
import { refusedWhileViewingAs } from "@/lib/auth/impersonation";
import { type BusinessProfile, type InferenceResult } from "@/lib/onboarding/business-profile";
import { inferVerifiedBusinessProfile } from "@/lib/onboarding/observed-facts";
import { looksLikeDomain, resolveCompetitorDomains } from "@/lib/onboarding/competitor-domains";
import { classifyRivalSize, suggestCompetitors as findCompetitorSuggestions, type CompetitorSuggestions, type RivalSize } from "@/lib/onboarding/competitor-suggestions";
import { fetchBulkAuthority } from "@/lib/seo/domain-metrics";
import { languageCodeOf } from "@/lib/keyword-research/locale";
import { e2eStubsEnabled, stubSuggestCompetitors } from "@/lib/e2e/stubs";
import { resolveLocale } from "@/lib/onboarding/locale";
import { guessLocale } from "@/lib/onboarding/locale-guess";
import { discoverSite, type SiteDiscovery } from "@/lib/onboarding/site-discovery";
import {
  outputToRow,
  parseBrandColor,
  parseYouTubeChannel,
  type OutputSettings,
  type SiteDetails,
} from "@/lib/onboarding/output-settings";

async function assertWorkspace(workspaceId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("id, domain, name, business_profile")
    .eq("id", workspaceId)
    .single();
  // RLS already scopes to the account; this turns a foreign id into an error
  // rather than a silent no-op that looks like a save. Only "no rows"
  // (PGRST116) means that, though: a timeout or pool restart is reported as
  // what it is, not as an ownership problem.
  if (error && error.code !== "PGRST116") throw new Error(`Could not read the site: ${error.message}`);
  if (!data) throw new Error("That site is not on this account.");
  return { supabase, workspace: data };
}

/**
 * May this account buy a wizard read now, and is the press counted.
 *
 * The site read, the rival lookup and a typed rival each cost provider calls,
 * and all three used to be bought again on every load of the wizard: they
 * fire on mount, and nothing is saved before Finish. So each is asked here in
 * three steps:
 *
 *   1. the spend gate, as before ("keyword-research": a lapsed account that
 *      comes back to add a site is refused with its own sentence);
 *   2. the door (lib/billing/spend-doors.ts): per site and per account a day,
 *      and before the trial for the account's whole life, so a signup that
 *      never finishes cannot buy the read in a loop. Self-host and the
 *      operator account are not counted;
 *   3. the work runs under a spend scope for the site, so its rows say whose
 *      they are.
 *
 * What a read bought is kept and handed back to the next load (readDoorCache
 * in each action below), which is what makes a reload free.
 */
async function wizardDoor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string,
  door: SpendDoor,
): Promise<{ refusal: null; reason: null; useId: string | null } | { refusal: string; reason: "needs_plan" | "limited"; useId: null }> {
  // An operator viewing as the account would buy this on theirs, and use up
  // their count (lib/auth/impersonation.ts). What is already kept is still
  // handed back by the callers, before they get here.
  const viewing = await refusedWhileViewingAs(door === "wizard-site-read" ? "Reading the site" : "Looking up competitors");
  if (viewing) return { refusal: viewing, reason: "limited", useId: null };
  const { accountId, user } = await requireAuth(undefined, { workspaceId });
  const gate = await canSpend(supabase, accountId, { userEmail: user.email ?? undefined, workspaceId, action: "keyword-research" });
  if (!gate.allowed) return { refusal: gate.message, reason: "needs_plan", useId: null };
  if (gate.reason === "self-host" || gate.reason === "operator") return { refusal: null, reason: null, useId: null };
  const taken = await takeDoor(door, { accountId, workspaceId }, { preTrial: trialGateApplies(gate.quota) });
  return taken.allowed ? { refusal: null, reason: null, useId: taken.useId } : { refusal: taken.message, reason: "limited", useId: null };
}

/**
 * Read the site and propose a profile, with the reason when it cannot.
 * The wizard renders the reason; it never renders blanks as a success.
 *
 * What a read bought is kept and handed back, a failure included: the wizard
 * asks on every mount, and a site behind a bot wall used to be read again on
 * each reload until the day's reads were gone, when the owner was told they
 * had used them up. `again` is the owner pressing "Try again" (or Settings'
 * autocomplete): a kept failure is read again then, and that press is counted.
 */
export async function proposeProfile(workspaceId: string, opts: { again?: boolean } = {}): Promise<InferenceResult> {
  const { supabase, workspace } = await assertWorkspace(workspaceId);
  if (!workspace.domain) return { profile: null, reason: "unreadable", source: "none" };
  const domain = workspace.domain;
  const key = inputKey({ domain });
  // One read per site at a time: a reload or a second tab joins the read
  // already running instead of buying its own.
  return onceInFlight("wizard-site-read", workspaceId, key, async () => {
    const kept = await readDoorCache<InferenceResult>("wizard-site-read", workspaceId, key);
    if (kept?.profile || (kept && !opts.again)) return kept;
    if (!opts.again) {
      const waited = await awaitDoorInFlight<InferenceResult>("wizard-site-read", workspaceId, key);
      if (waited) return waited;
    }
    // One model call per press. A new account is inside its free allowance
    // and never sees the gate; a lapsed one that comes back to add a site does.
    const { refusal, reason, useId } = await wizardDoor(supabase, workspaceId, "wizard-site-read");
    if (refusal) {
      return {
        profile: null,
        reason,
        source: "none",
        message: refusal,
        localeGuess: guessLocale({ domain }),
      };
    }
    await markDoorInFlight(useId, key);
    try {
      // Checked: a conversion page the site does not have comes back empty
      // with the reason, never as the guess (lib/onboarding/observed-facts.ts).
      const result = await withSpendScope({ workspaceId, job: "onboarding" }, () => inferVerifiedBusinessProfile(domain));
      if (!result.profile) {
        // A failed read still says which language the page is in and which
        // country's domain it is on: the wizard starts from that, not
        // English / Global (lib/onboarding/locale-guess.ts).
        const failed: InferenceResult = { ...result, localeGuess: guessLocale({ htmlLang: result.htmlLang, domain }) };
        await keepDoorResult("wizard-site-read", workspaceId, key, useId, failed);
        return failed;
      }
      // The model names rivals ("trainerize"); keyword research reads domains.
      // Resolved here, not in business-profile.ts, because the client wizard
      // imports that file and the resolver needs node:dns. A name nothing can
      // place is dropped, so no chip is shown that research cannot read.
      if (result.profile.competitors.length) {
        const own = domain.replace(/^www\./, "").toLowerCase();
        const { domains } = await resolveCompetitorDomains(result.profile.competitors);
        result.profile.competitors = domains.filter((d) => d !== own);
      }
      await keepDoorResult("wizard-site-read", workspaceId, key, useId, result);
      return result;
    } catch (err) {
      await clearDoorInFlight(useId);
      throw err;
    }
  });
}

/** The profile as a cache key: everything the lookup reads, never the confirmation stamp. */
function profileKey(domain: string, profile: BusinessProfile): string {
  const { confirmedAt: _stamp, ...read } = profile;
  void _stamp;
  return inputKey({ domain, profile: read });
}

/**
 * Rivals to propose on the competitor step, tagged by source and size.
 *
 * Takes the profile from the screen rather than the row: nothing is saved
 * before the one button. Costs a few provider calls (seed proposal, up to six
 * results pages, one vetting call, one bulk-rank call), so it sits behind the
 * same spend gate as the profile read, is counted like it, and is kept for
 * the same profile: the reload that is handed the kept read asks with that
 * same profile, and is handed the kept rivals too.
 */
export async function suggestCompetitors(workspaceId: string, profile: BusinessProfile): Promise<CompetitorSuggestions> {
  const { supabase, workspace } = await assertWorkspace(workspaceId);
  if (!workspace.domain) return { own: null, suggestions: [], searchRivals: [] };
  // E2E_STUBS: a fixture, no provider (lib/e2e/stubs.ts). After the auth
  // check, like every other stub, so the switch never skips who may ask
  // (the paid path checks it in wizardDoor).
  if (e2eStubsEnabled()) {
    await requireAuth(undefined, { workspaceId });
    return stubSuggestCompetitors(workspace.domain, profile);
  }
  const key = profileKey(workspace.domain, profile);
  const kept = await readDoorCache<CompetitorSuggestions>("wizard-rivals", workspaceId, key);
  if (kept) return kept;
  const { refusal, reason, useId } = await wizardDoor(supabase, workspaceId, "wizard-rivals");
  if (reason === "needs_plan") return { own: null, suggestions: [], searchRivals: [] };
  // Past the limit, or not bought while viewing as the account: said as a
  // lookup that could not look, which the step words as "name one if you
  // know it".
  if (refusal) return { own: null, suggestions: [], searchRivals: [], lookupFailed: true };
  const locale = resolveLocale(profile.language, profile.country);
  const domain = workspace.domain;
  // The scope writes the model and results-page rows with the operator's
  // client and this site on them. The sink this passed before was the
  // person's own client, which provider_spend refuses to write through
  // (lib/billing/default-spend.ts), so those rows were lost.
  const found = await withSpendScope({ workspaceId, job: "onboarding" }, () =>
    findCompetitorSuggestions({
      domain,
      business: profile,
      languageCode: languageCodeOf(locale.language),
      locationCode: locale.locationCode,
    }),
  );
  if (!found.lookupFailed) await keepDoorResult("wizard-rivals", workspaceId, key, useId, found);
  return found;
}

/**
 * One typed entry, resolved to a domain and sized against the site.
 * "revoo" becomes revoo-app.com; a name nothing can place returns null and
 * the screen says so, rather than storing a word research cannot read.
 */
export async function resolveCompetitor(
  workspaceId: string,
  entry: string,
  own: number | null,
): Promise<{ domain: string; authority: number | null; size: RivalSize | null } | null> {
  const { supabase, workspace } = await assertWorkspace(workspaceId);
  // E2E_STUBS: after the auth check, like every other stub (the paid path
  // checks it in wizardDoor).
  if (e2eStubsEnabled()) {
    await requireAuth(undefined, { workspaceId });
    const domain = entry.trim().toLowerCase().replace(/\s+/g, "-");
    return domain ? { domain: domain.includes(".") ? domain : `${domain}.example`, authority: null, size: null } : null;
  }
  type Resolved = { domain: string; authority: number | null; size: RivalSize | null };
  const key = inputKey({ entry: entry.trim().toLowerCase(), own, site: workspace.domain ?? "" });
  const kept = await readDoorCache<{ found: Resolved | null }>("wizard-rival-resolve", workspaceId, key);
  if (kept?.found) return kept.found;
  // A results page and a bulk-rank read per press (~$0.024): gated and
  // counted like the suggestion lookup above. A refused account gets the
  // entry as typed when it already is a domain, and nothing invented when
  // it is not.
  const { refusal, useId } = await wizardDoor(supabase, workspaceId, "wizard-rival-resolve");
  if (refusal) {
    const typed = entry.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
    return looksLikeDomain(typed) ? { domain: typed, authority: null, size: null } : null;
  }
  const found = await withSpendScope({ workspaceId, job: "onboarding" }, async (): Promise<Resolved | null> => {
    const { domains } = await resolveCompetitorDomains([entry]);
    const domain = domains.find((d) => d !== (workspace.domain ?? "").replace(/^www\./, "").toLowerCase());
    if (!domain) return null;
    const authority = own === null ? null : (await fetchBulkAuthority([domain]).catch(() => new Map<string, number | null>())).get(domain) ?? null;
    return { domain, authority, size: classifyRivalSize(own, authority) };
  });
  // A name nothing could place is not kept: the lookup may answer next time.
  if (found) await keepDoorResult("wizard-rival-resolve", workspaceId, key, useId, { found });
  return found;
}

/** Save the profile the person confirmed. Labels stay in the profile; codes go in the columns. */
export async function saveProfile(
  workspaceId: string,
  profile: BusinessProfile,
  opts: { auto?: boolean } = {},
): Promise<void> {
  const { supabase, workspace } = await assertWorkspace(workspaceId);
  const locale = resolveLocale(profile.language, profile.country);
  const { error } = await supabase
    .from("workspaces")
    .update({
      // A person pressed save on what they read: that is the confirmation the
      // writer's prompt names (lib/ai/prompts.ts). Stamped here, never taken
      // from the client. A run the wizard started by itself saves the same
      // profile with no stamp: nobody read it, and a stamp told the writer
      // "the owner's confirmed words" and the first look "the competitor you
      // named" about a profile a model had read off the site (2026-10-16).
      business_profile: { ...profile, confirmedAt: opts.auto ? null : new Date().toISOString() },
      // The wizard is also where a site gets its display name; before this the
      // name was always the bare domain.
      name: profile.name?.trim() || workspace.name,
      language: locale.language,
      location_code: locale.locationCode,
    })
    .eq("id", workspaceId);
  if (error) throw new Error(error.message);
  revalidatePath("/onboarding");
  revalidatePath("/settings", "layout");
}

export type DraftSave = { ok: true } | { ok: false; reason: "finished" | "confirmed" | "failed" };

/**
 * The wizard's answers as the owner edits them, so a person who leaves comes
 * back to what they had checked (UX audit 2026-10-12, #2: two of three real
 * signups left the wizard with nothing saved).
 *
 * A draft, not a confirmation, and written as one:
 * - no `confirmedAt` - only the final click stamps that (`saveProfile`), so
 *   the writer is never told a half-checked profile is the owner's word;
 * - only the profile and the site details; the name, language and location
 *   columns that research reads move on the final click, as before;
 * - only while setup is unfinished, and never over a profile someone already
 *   confirmed: a draft that lands after the final click (a slow request, a
 *   second tab) must not undo it;
 * - through the person's own client, so RLS decides whether they can see
 *   the site at all, and the update is filtered to this one site.
 *
 * Never throws: a draft that does not save costs the person nothing the
 * final click will not do, so the screen is not interrupted for it.
 */
export async function saveProfileDraft(workspaceId: string, profile: BusinessProfile, site: SiteDetails): Promise<DraftSave> {
  try {
    const supabase = await createClient();
    const { data: row, error: readError } = await supabase
      .from("workspaces")
      .select("id, business_profile, onboarded_at, onboarding_skipped_at")
      .eq("id", workspaceId)
      .maybeSingle();
    if (readError || !row) return { ok: false, reason: "failed" };
    if (row.onboarded_at || row.onboarding_skipped_at) return { ok: false, reason: "finished" };
    if ((row.business_profile as BusinessProfile | null)?.confirmedAt) return { ok: false, reason: "confirmed" };
    // Never taken from the client, even as null: a draft carries no stamp.
    const { confirmedAt: _ignored, ...draft } = profile;
    void _ignored;
    const { data: written, error } = await supabase
      .from("workspaces")
      .update({ business_profile: draft, ...siteColumns(site) })
      .eq("id", workspaceId)
      .is("onboarded_at", null)
      .is("onboarding_skipped_at", null)
      // In the update itself, not only in the read above: a draft that read
      // the row before the final click stamped confirmedAt (a second tab, a
      // slow request) must still not land over it (review, 2026-10-12).
      .or("business_profile.is.null,business_profile->>confirmedAt.is.null")
      .select("id");
    if (error || !written?.length) return { ok: false, reason: "failed" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** Look for the sitemap and blog. Returns what was verified live, and nothing else. */
export async function discoverSiteDetails(workspaceId: string): Promise<SiteDiscovery> {
  const { workspace } = await assertWorkspace(workspaceId);
  if (!workspace.domain) return { sitemapUrl: null, blogRootUrl: null, exampleArticleUrls: [], found: false };
  return discoverSite(workspace.domain);
}

const HTTP = /^https?:\/\/\S+$/i;

/** The site details as columns: only URLs that look like URLs, at most three examples. */
function siteColumns(details: SiteDetails) {
  const clean = (u: string) => (HTTP.test(u.trim()) ? u.trim() : null);
  return {
    sitemap_url: clean(details.sitemapUrl),
    blog_root_url: clean(details.blogRootUrl),
    example_article_urls: details.exampleArticleUrls.map((u) => u.trim()).filter((u) => HTTP.test(u)).slice(0, 3),
  };
}

/**
 * Save the sitemap, blog address and "Your best writing". When the chosen
 * articles change on a site whose voice is already trained, the voice is
 * retrained from them after the response (lib/voice/examples.ts), so the
 * field does what its hint says. Returns whether a retrain was started.
 */
export async function saveSiteDetails(workspaceId: string, details: SiteDetails): Promise<{ retraining: boolean }> {
  const { supabase } = await assertWorkspace(workspaceId);
  const columns = siteColumns(details);
  const examples = columns.example_article_urls;
  const previous = await readExampleUrls(supabase, workspaceId);
  const { error } = await supabase
    .from("workspaces")
    .update(columns)
    .eq("id", workspaceId);
  if (error) throw new Error(error.message);
  revalidatePath("/settings", "layout");

  const changed = examples.join("\n") !== previous.join("\n");
  if (!changed || examples.length === 0) return { retraining: false };
  // Only a trained voice is retrained (retrainFromExamples), so only then is
  // a retrain promised. An untrained site learns from the list at onboarding.
  if (!(await hasTrainedVoice(supabase, workspaceId))) return { retraining: false };
  // A model call, so asked like the Voice page's Train button is.
  const { accountId, user } = await requireAuth(undefined, { workspaceId });
  const gate = await canSpend(supabase, accountId, { userEmail: user.email ?? undefined, workspaceId, action: "voice-training" });
  if (!gate.allowed) return { retraining: false };
  after(async () => {
    try {
      await retrainFromExamples(supabase, workspaceId, examples, previous, { train: trainVoiceProfile });
    } catch (err) {
      console.error(`[voice] retraining ${workspaceId} from chosen articles: ${err instanceof Error ? err.message : err}`);
    }
  });
  return { retraining: true };
}

export async function saveOutputSettings(workspaceId: string, s: OutputSettings): Promise<void> {
  const { supabase } = await assertWorkspace(workspaceId);
  // A colour or channel that does not parse is refused, not silently nulled:
  // the form validates the same way, so this only fires on a bypassed client.
  if (s.brandColor?.trim() && !parseBrandColor(s.brandColor)) throw new Error("Brand colour must be a hex value like #1a1815.");
  if (s.youtubeChannel?.trim() && !parseYouTubeChannel(s.youtubeChannel)) {
    throw new Error("YouTube channel must be a channel id (UC…), a handle (@name) or the channel URL.");
  }
  const { error } = await supabase.from("workspace_output_settings").upsert(
    { workspace_id: workspaceId, ...outputToRow(s), updated_at: new Date().toISOString() },
    { onConflict: "workspace_id" },
  );
  if (error) throw new Error(error.message);
  revalidatePath("/settings", "layout");
}

/**
 * The standing instruction for keyword research, on its own because it lives
 * on the Keywords tab and is saved on its own. Upsert so a site that never
 * finished the wizard still gets a row; the other columns take their defaults.
 */
export async function saveKeywordPrompt(workspaceId: string, prompt: string): Promise<void> {
  const { supabase } = await assertWorkspace(workspaceId);
  const { error } = await supabase.from("workspace_output_settings").upsert(
    {
      workspace_id: workspaceId,
      global_keyword_prompt: prompt.trim().slice(0, 2000) || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id" },
  );
  if (error) throw new Error(error.message);
  revalidatePath("/settings", "layout");
}

/** The finish write: `on` for a site that is not paused, the opt-in alone for one that is. */
async function finishOnboarding(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string,
  now: string,
): Promise<{ error: { message: string } | null }> {
  const opted = { onboarded_at: now, auto_generate: true };
  const running = await supabase
    .from("workspaces")
    .update({ ...opted, status: "on" })
    .eq("id", workspaceId)
    .neq("status", "paused");
  if (running.error) return running;
  return supabase.from("workspaces").update(opted).eq("id", workspaceId).eq("status", "paused");
}

/**
 * Mark the wizard done, or skipped. Either way the dashboard stops sending the
 * person back here. Skipping is allowed on purpose: a wizard that cannot read
 * the site must not become a wall.
 */
export async function completeWizard(workspaceId: string, opts: { skipped?: boolean } = {}): Promise<void> {
  const { supabase } = await assertWorkspace(workspaceId);
  const now = new Date().toISOString();
  // Finishing is the opt-in. The wizard has just promised a month of drafts
  // and written the first one; the cron only writes for workspaces with
  // auto_generate on and status "on", and nothing else ever set them for a
  // site added through "Add workspace" (T2 walk, 2026-09-05) — so days two
  // onward were never written. Skipping leaves the site in setup: no plan
  // was made, so no promise was made.
  //
  // Except on a paused site. The account pause on Billing pauses sites still
  // in setup too, and the wizard opens for any site in scope; finishing it
  // wrote `status: "on"` over the pause, so that one site drafted through a
  // pause that promises nothing is drafted or billed. A paused site keeps its
  // pause and takes the opt-in, which applies when the pause is lifted.
  const { error } = opts.skipped
    ? await supabase.from("workspaces").update({ onboarding_skipped_at: now }).eq("id", workspaceId)
    : await finishOnboarding(supabase, workspaceId, now);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
  revalidatePath("/content");
}

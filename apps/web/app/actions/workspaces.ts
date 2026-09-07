"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ensureAgency } from "@/lib/queries/agency";
import { requireAuth } from "@/lib/auth/require-auth";
import { canAddWorkspace } from "@/lib/team/access";
import { z } from "zod";
import { generateIndexNowKey } from "@/lib/seo/indexing";
import { checkDomainReachable } from "@/lib/domain/reachable";
import { e2eStubsEnabled } from "@/lib/e2e/stubs";
import { getWorkspaceAllowance, workspaceLimitMessage } from "@/lib/billing/workspaces";
import { MAX_PACE, monthlyFromPace, normalisePace, PAID_DEFAULT_PACE } from "@/lib/content/pace";
import { getQuota } from "@/lib/billing/quota";
import { paceAllowed, planNeededFor } from "@/lib/plan/pace-options";
import { PLAN_LABELS } from "@/lib/stripe";
import { pauseWorkspace as pauseWorkspaceCore, resumeWorkspace as resumeWorkspaceCore } from "@/lib/workspaces/pause";
import type { PausedMeta } from "@/lib/types";

const createWorkspaceSchema = z.object({
  name: z.string().min(1),
  // Required since 2026-09-02: a workspace is a site, and one without a
  // domain cannot be analysed, seeded or drafted for. Normalised so
  // "https://www.Acme.com/" and "acme.com" are the same workspace.
  domain: z
    .string()
    .transform((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, ""))
    .pipe(z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/, "Enter a domain like acme.com")),
  initials: z.string().max(2).default(""),
  color: z.string().default("av-c1"),
});

/**
 * Why this returns a result instead of throwing.
 *
 * Every refusal here is one the person can act on - the workspace limit, a
 * domain already in the account, a typo in the domain - and Next.js replaces a
 * thrown server-action message with an opaque digest in production, so the
 * only thing the dialog could show was a console line. It showed nothing: the
 * caller caught, logged and closed the spinner, and "Add workspace" went quiet
 * at the limit (P0-O3). A refusal the user can read has to travel as data.
 */
export type CreateWorkspaceResult =
  | { ok: true; workspaceId: string; domain: string }
  | { ok: false; error: string };

export async function createWorkspace(formData: FormData): Promise<CreateWorkspaceResult> {
  // Owner or admin, like the Search Console door that also creates workspaces
  // (app/actions/google-properties.ts) and like every other action that spends
  // the account's allowance. This one had no role check at all: an editor
  // scoped to a single site could add a fourth site to the account, take a
  // plan slot, and start it drawing on the shared monthly quota - while the
  // Team page told them "Editors ... cannot manage billing".
  //
  // A result, not a throw, because everything else this action refuses comes
  // back as a sentence the dialog can print.
  const { role } = await requireAuth();
  if (!canAddWorkspace(role)) {
    return {
      ok: false,
      error: "Adding a workspace changes what the account pays for, so an owner or admin has to do it. Ask one of them and it takes a moment.",
    };
  }

  const supabase = await createClient();
  // `domain` comes via ?? undefined: FormData.get returns null for a missing
  // field, z.optional() only accepts undefined, and the difference took the
  // whole form down when the plan select was removed.
  const name = formData.get("name");
  const parsed = createWorkspaceSchema.safeParse({
    name,
    domain: formData.get("domain") ?? undefined,
    initials: formData.get("initials") || String(name ?? "").slice(0, 2).toUpperCase(),
    color: formData.get("color") || "av-c1",
  });
  if (!parsed.success) {
    // The field message, not Zod's JSON dump: "Enter a domain like acme.com"
    // is the one the schema wrote for exactly this moment.
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the name and domain." };
  }

  // The schema checks the shape of a hostname; it cannot tell you whether a
  // site is there. `stripdemo.altorank.test` satisfies it perfectly, and a
  // workspace on a name that resolves to nothing goes on to produce a content
  // plan for a site nobody can read. Only `no-dns` blocks: a real site behind
  // a WAF that refuses us must still be able to sign up (lib/domain/reachable.ts).
  // Skipped under E2E_STUBS, where the whole outside world is fixtures and
  // every domain is `*.altorank.test` by design.
  if (!e2eStubsEnabled()) {
    const reach = await checkDomainReachable(parsed.data.domain);
    if (!reach.ok) return { ok: false, error: reach.reason };
  }

  // Get or create user's agency
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Your session has expired. Sign in again." };

  const agencyId = await ensureAgency(user.id, user.user_metadata ?? {}, user.email);

  // Workspaces are limited per plan (one before choosing one). Articles are
  // the meter; this stops a free account from running fifty crawls and
  // fifty free drafts under fifty domains.
  const allowance = await getWorkspaceAllowance(supabase, agencyId, user.email);
  if (allowance.remaining !== null && allowance.remaining <= 0) {
    return { ok: false, error: workspaceLimitMessage(allowance) };
  }

  const { data: dup } = await supabase
    .from("workspaces")
    .select("id, name")
    .eq("agency_id", agencyId)
    .ilike("domain", parsed.data.domain)
    .maybeSingle();
  if (dup) {
    return { ok: false, error: `${parsed.data.domain} is already the workspace "${dup.name}". One workspace per site.` };
  }

  const { data, error } = await supabase
    .from("workspaces")
    .insert({ ...parsed.data, agency_id: agencyId, indexnow_key: generateIndexNowKey() })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };
  revalidatePath("/workspaces");
  revalidatePath("/dashboard");
  return { ok: true, workspaceId: data.id as string, domain: parsed.data.domain };
}

/**
 * The fields the setup wizard and the locale switcher edit. An allowlist, not
 * whatever the form posted.
 *
 * This used to copy every entry of the FormData onto the row, so a hand-made
 * POST could write any column of `workspaces`, including three that are not
 * settings at all: `share_token`, the unguessable value the public /share/:token
 * page treats as the whole credential (lib/queries/share.ts reads it with the
 * service role) - overwrite it with a known string and the site's report is
 * public to whoever chose it; `agency_id`, which for anyone who belongs to two
 * accounts moved the site and, by foreign key, its articles, keywords and
 * reports from one tenant to the other; and `plan`, `status` and
 * `auto_generate`, the columns the crons and the quota read.
 */
const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  domain: createWorkspaceSchema.shape.domain.optional(),
  initials: z.string().max(2).optional(),
  color: z.string().max(32).optional(),
  language: z.string().min(2).max(10).optional(),
  location_code: z.coerce.number().int().positive().optional(),
});

export async function updateWorkspace(id: string, formData: FormData) {
  const { agencyId } = await requireAuth();
  const supabase = await createClient();

  const raw: Record<string, unknown> = {};
  for (const key of Object.keys(updateWorkspaceSchema.shape)) {
    const value = formData.get(key);
    if (value !== null && value !== "") raw[key] = value;
  }
  const parsed = updateWorkspaceSchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid value");
  if (!Object.keys(parsed.data).length) return;

  const { error } = await supabase
    .from("workspaces")
    .update(parsed.data)
    .eq("id", id)
    // Defence in depth over RLS: the id arrives from the browser.
    .eq("agency_id", agencyId);

  if (error) throw new Error(error.message);
  revalidatePath("/workspaces");
  revalidatePath("/articles");
}

/**
 * How many articles a week the unattended generator may write for one site.
 *
 * The pricing page sells "at the pace you set per site" and until this action
 * there was no way to set it: the value was only ever written by signup, by
 * the Google property import and by activating a workspace, all to a fixed
 * number. `MAX_PACE` is what migration 041 allows, and 0 pauses the site
 * without turning `auto_generate` off, which keeps the distinction between
 * "not now" and "never" visible in the row.
 */
export async function setGenerationPace(workspaceId: string, requested: unknown) {
  const { agencyId, user } = await requireAuth();
  const pace = normalisePace(requested);
  if (pace === null) {
    throw new Error(`Pick a number of articles a week between 0 and ${MAX_PACE}.`);
  }

  const supabase = await createClient();

  // The same rule the Articles-plan control enforces (app/actions/plan.ts's
  // `applyArticlesPlan`). This door had neither half of it: the slider ran to
  // MAX_PACE on every tier and the action wrote whatever arrived, so a free
  // account could set 25 a week - about 108 a month against seven drafts -
  // and the popover next door refused the same number with "Needs the
  // Managed plan". One setting, two answers, and the honest one only on the
  // screen that happened to check.
  const quota = await getQuota(supabase, agencyId, user.email ?? null);
  if (!paceAllowed(pace, quota)) {
    const needs = PLAN_LABELS[planNeededFor(monthlyFromPace(pace))];
    throw new Error(
      `${pace} a week is about ${monthlyFromPace(pace)} a month, which needs the ${needs} plan. Choose one on the Billing page.`,
    );
  }

  const { error } = await supabase
    .from("workspaces")
    .update({ auto_generate_weekly_limit: pace })
    .eq("id", workspaceId)
    // Defence in depth over RLS, and the reason this is not a bare update:
    // the id arrives from the browser.
    .eq("agency_id", agencyId);
  if (error) throw new Error(error.message);

  revalidatePath(`/workspaces/${workspaceId}`);
  revalidatePath("/dashboard");
  return pace;
}

/**
 * The publishing decision for one workspace: review every draft, or publish
 * automatically after a hold unless a person holds it (migration 079).
 *
 * Attributed on purpose. The caller becomes `auto_approve_set_by`, and every
 * article the rule approves is recorded with that id as `approved_by`, so an
 * automatic publish is traceable to a named person's decision rather than to
 * "the system". Turning it off clears the pending hold stamps so the review
 * cards stop promising a publish that will not come.
 *
 * Nothing ships without a publishing schedule, so enabling the rule on a
 * workspace with no enabled cadence switches on a daily one at 10:00; the
 * person can change it in the schedule card next to this one.
 */
export async function setAutoApprove(
  workspaceId: string,
  opts: { enabled: boolean; holdHours: number; minSeo: number; minAeo?: number | null },
): Promise<{ cadenceCreated: boolean }> {
  const { agencyId, user } = await requireAuth();
  const supabase = await createClient();

  const holdHours = Math.round(Number(opts.holdHours));
  const minSeo = Math.round(Number(opts.minSeo));
  const minAeo = opts.minAeo == null ? null : Math.round(Number(opts.minAeo));
  if (!Number.isFinite(holdHours) || holdHours < 0 || holdHours > 168) throw new Error("Hold between 0 and 168 hours.");
  if (!Number.isFinite(minSeo) || minSeo < 0 || minSeo > 100) throw new Error("SEO floor between 0 and 100.");
  if (minAeo != null && (!Number.isFinite(minAeo) || minAeo < 0 || minAeo > 100)) throw new Error("AEO floor between 0 and 100.");

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("workspaces")
    .update(
      opts.enabled
        ? {
            auto_approve: true,
            auto_approve_hold_hours: holdHours,
            auto_approve_min_seo: minSeo,
            auto_approve_min_aeo: minAeo,
            auto_approve_set_by: user.id,
            auto_approve_set_at: now,
          }
        : { auto_approve: false },
    )
    .eq("id", workspaceId)
    // Defence in depth over RLS: the id arrives from the browser.
    .eq("agency_id", agencyId);
  if (error) throw new Error(error.message);

  let cadenceCreated = false;
  if (opts.enabled) {
    const { data: cadence } = await supabase
      .from("publishing_cadences")
      .select("enabled")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (!cadence?.enabled) {
      const { error: cadenceError } = await supabase.from("publishing_cadences").upsert(
        {
          workspace_id: workspaceId,
          enabled: true,
          days_of_week: [0, 1, 2, 3, 4, 5, 6],
          publish_time: cadence ? undefined : "10:00",
          timezone: cadence ? undefined : "Europe/Rome",
          updated_at: now,
        },
        { onConflict: "workspace_id" },
      );
      if (cadenceError) throw new Error(cadenceError.message);
      cadenceCreated = true;
    }
  } else {
    await supabase
      .from("articles")
      .update({ auto_approve_after: null, auto_approve_hold_reason: null })
      .eq("workspace_id", workspaceId)
      .eq("status", "review");
  }

  revalidatePath(`/workspaces/${workspaceId}`);
  revalidatePath("/review");
  return { cadenceCreated };
}

export async function activateWorkspace(id: string) {
  const { agencyId } = await requireAuth();
  const supabase = await createClient();
  // Activation is the opt-in. It used to set status only, so a workspace
  // activated by hand never got a draft: auto_generate stayed false and the
  // cron skipped it for ever, while the overview showed four zeros and
  // nothing else (2026-09-02). Two drafts a week is the default cadence.
  const { error } = await supabase
    .from("workspaces")
    .update({ status: "on", auto_generate: true, auto_generate_weekly_limit: PAID_DEFAULT_PACE })
    .eq("id", id)
    .eq("agency_id", agencyId)
    .eq("status", "setup"); // guard: only transition from setup

  if (error) throw new Error(error.message);
  revalidatePath("/workspaces");
  revalidatePath(`/workspaces/${id}`);
}

/**
 * Deleting a site takes its articles, keywords, calendar and reports with it
 * by cascade. That is an account-level decision, so it is an owner's or an
 * admin's; migration 072 says the same thing in the RLS policy, and this is
 * the message a person sees rather than a silent zero-row delete.
 */
export async function deleteWorkspace(id: string) {
  const { agencyId } = await requireAuth(["owner", "admin"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("workspaces")
    .delete()
    .eq("id", id)
    .eq("agency_id", agencyId);
  if (error) throw new Error(error.message);
  revalidatePath("/workspaces");
}

/** Every page that shows a site's status or its calendar. */
function revalidateSite(id: string) {
  revalidatePath("/workspaces");
  revalidatePath(`/workspaces/${id}`);
  revalidatePath("/content");
  revalidatePath("/dashboard");
}

/**
 * Pause one site. The behaviour is lib/workspaces/pause.ts, shared with the
 * agent API's POST /workspaces/{id}/pause; this is its server-action door.
 * Nothing is written or published for a paused site until Resume.
 */
export async function pauseWorkspace(id: string): Promise<PausedMeta> {
  const { agencyId, user } = await requireAuth();
  const supabase = await createClient();
  const { meta } = await pauseWorkspaceCore(supabase, agencyId, id, user.id);
  revalidateSite(id);
  return meta;
}

/**
 * Resume a site paused by hand: status back, calendar re-planned from today.
 * Same core as the agent API's POST /workspaces/{id}/resume.
 */
export async function resumeWorkspace(id: string): Promise<{ status: string; replanned: number | null }> {
  const { agencyId } = await requireAuth();
  const supabase = await createClient();
  const { status, replanned } = await resumeWorkspaceCore(supabase, agencyId, id);
  revalidateSite(id);
  return { status, replanned };
}

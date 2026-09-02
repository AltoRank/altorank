// ---------------------------------------------------------------------------
// "Powered by AltoRank" on published articles
// ---------------------------------------------------------------------------
//
// One line, appended to articles published by the hosted free tier, linking
// back to altorank.co. Any paid plan publishes clean.
//
// Where the line sits matters, because the repo already carries a promise that
// this could contradict. Under AGPL the software has no feature gates, and
// lib/stripe.ts says so: the paid rungs sell hosting, included model and data
// costs, volume and support - not capabilities. That promise is intact here.
// Attribution is not a gate on the software; it is the price of us paying the
// model and data bills for someone publishing for free. A self-hoster runs
// their own instance, pays their own costs, and gets no line - which is also
// the only enforceable answer, since they can edit this file.
//
// So the rule is the quota's own reason, not a new flag:
//
//   self-host   no billing at all          -> no line
//   operator    our own dogfood workspaces -> no line
//   plan        paying                     -> no line
//   no-plan     hosted, free               -> line
//
// This is the same line Outrank draws - their watermark is on trial output,
// not sold as an add-on (checked 2026-09-02).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Quota } from "@/lib/billing/quota";
import { isAdminEmail } from "@/lib/auth/operators";

/** Where the link points. Bare and canonical: no query string to split. */
export const ATTRIBUTION_URL = "https://altorank.co";

/**
 * `rel` on the outbound link.
 *
 * Empty means a followed link. That is the deliberate choice and it is worth
 * knowing what it buys and costs. A branded anchor, once per article, is the
 * ordinary "Powered by" badge every SaaS ships, and Google's link spam policy
 * is aimed at keyword-rich anchors distributed at scale, which this is not.
 * The exposure is not ranking risk so much as message risk: AltoRank's own
 * positioning quotes Google against "automated programs or services to create
 * links", and this is a link placed by automation. Set this to "nofollow" to
 * keep the referral traffic and drop the argument.
 */
export const ATTRIBUTION_REL = "";

/**
 * Anchor text. Brand only, never a keyword. A phrase like "AI SEO tool" here,
 * repeated across every free customer's site, is the exact footprint the
 * branded version avoids.
 */
export const ATTRIBUTION_ANCHOR = "AltoRank";

/**
 * True when this article should carry the line.
 *
 * `removeBranding` is the agency's own white-label switch, which paid plans
 * own outright. It cannot turn the line off on the free tier: otherwise the
 * setting is the gate and free is simply white-label with extra steps.
 */
export function shouldAttribute(quota: Quota, removeBranding: boolean): boolean {
  if (quota.reason !== "no-plan") return false;
  void removeBranding;
  return true;
}

/**
 * Whether the agency belongs to an operator, asked of the agency rather than
 * of whoever triggered the publish.
 *
 * `getQuota` answers "operator" from the *caller's* address, which is right on
 * a request and empty on a cron: a cron is nobody's operator, by design. So a
 * dogfood workspace publishing on a schedule reached the billing check like
 * any customer, found no subscription, and came back "no-plan" - which would
 * have put "Powered by AltoRank" on altorank.co's own articles, a footer link
 * from our domain to our domain (found 2026-09-02).
 *
 * Needs the service role to read addresses. On a request-scoped client the
 * admin call fails, and false is the right answer there anyway, because
 * `getQuota` has already resolved the signed-in operator itself.
 */
export async function isOperatorAgency(
  supabase: SupabaseClient,
  agencyId: string,
): Promise<boolean> {
  try {
    const { data: members } = await supabase
      .from("agency_members")
      .select("user_id")
      .eq("agency_id", agencyId);
    for (const m of members ?? []) {
      const { data } = await supabase.auth.admin.getUserById(m.user_id as string);
      if (isAdminEmail(data?.user?.email)) return true;
    }
  } catch {
    // No service role, or the lookup failed. Fall through to the caller-based
    // answer rather than guessing.
  }
  return false;
}

/** The markup itself. Kept to one paragraph so every CMS accepts it. */
export function attributionHtml(): string {
  const rel = ATTRIBUTION_REL ? ` rel="${ATTRIBUTION_REL}"` : "";
  return (
    `<p data-altorank-attribution="1">` +
    `<small>Powered by <a href="${ATTRIBUTION_URL}"${rel}>${ATTRIBUTION_ANCHOR}</a></small>` +
    `</p>`
  );
}

/**
 * Append the line to an article body, once.
 *
 * Idempotent on the marker attribute: republishing an article must not stack
 * a second badge on top of the first, and adapters that round-trip HTML
 * through the CMS will hand back a body that already has one.
 */
export function appendAttribution(html: string): string {
  if (html.includes("data-altorank-attribution")) return html;
  return `${html}\n${attributionHtml()}`;
}

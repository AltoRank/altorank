"use server";

// ---------------------------------------------------------------------------
// The setup screen's soft exits: "Email me this article", "Email me when it's ready"
// ---------------------------------------------------------------------------
//
// Both are for the account's OWNER, before the trial, on their own site, and
// both mail only the address the owner is signed in with - never one the
// request names. Both respect the owner's email preferences (the `drafts`
// category). Neither ever puts a word of the article in an email
// (lib/email/first-look-exits.ts).
//
//   emailFirstArticle   one email with the title and a link back to the
//                       setup page; once per article, at most three a day
//   emailWhenReady      nothing to send now: the "your first article is
//                       written" email already goes to the account the moment
//                       the body is saved (app/api/internal/draft ->
//                       lib/email/draft-batch.ts). This answers whether it
//                       will reach this owner - it will not if they turned
//                       draft emails off - so the screen promises only what
//                       happens.

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getRequestQuota } from "@/lib/queries/quota";
import { trialGateState } from "@/lib/billing/trial";
import { loadFirstArticle } from "@/lib/onboarding/first-article";
import { readUnsubscribed } from "@/lib/email/preferences";
import { wantsCategory } from "@/lib/email/categories";
import { sendFirstArticleLink } from "@/lib/email/first-look-exits";
import { getSimulation } from "@/lib/dev/simulation";

export type ExitAnswer = { ok: true; email: string; already?: boolean } | { ok: false; message: string };

const OPTED_OUT = "You have turned off emails about drafts, so we will not send one. This page keeps your article: come back to it any time.";

/** The owner, before the trial, on this site, with an address to write to; or why not. */
async function ownerBeforeTrial(workspaceId: string) {
  const { user, accountId, role } = await requireAuth(undefined, { workspaceId });
  if (role !== "owner") return { ok: false as const, message: "Only the account owner can ask for this." };
  const email = user.email?.trim().toLowerCase();
  if (!email) return { ok: false as const, message: "Your account has no email address to send to." };
  const quota = await getRequestQuota(accountId, email);
  // The dev toolbar's forced gate counts here as it does on the page (it is
  // null outside development), so the screen and its exits agree.
  const simulated = (await getSimulation())?.gate === true;
  if (trialGateState(quota, email, { simulated }) === "open") return { ok: false as const, message: "Your trial has started: the article is in your dashboard." };
  return { ok: true as const, email, accountId };
}

async function wantsDraftEmails(email: string): Promise<boolean> {
  // A preferences table that cannot be read must not silence the mail: the
  // same default `sendOnce` takes.
  const unsubscribed = await readUnsubscribed(createServiceClient(), email).catch(() => [] as string[]);
  return wantsCategory(unsubscribed, "drafts");
}

/** "Email me this article": the title and a link back, to the owner, once. */
export async function emailFirstArticle(workspaceId: string): Promise<ExitAnswer> {
  const who = await ownerBeforeTrial(workspaceId);
  if (!who.ok) return who;
  if (!(await wantsDraftEmails(who.email))) return { ok: false, message: OPTED_OUT };
  const supabase = await createClient();
  const { data: site } = await supabase.from("workspaces").select("domain").eq("id", workspaceId).maybeSingle();
  const domain = (site?.domain as string | null | undefined) ?? null;
  // Through the owner's own client, so RLS answers whether they may see it.
  const { article } = await loadFirstArticle(supabase, workspaceId, domain);
  if (!article) return { ok: false, message: "There is no article to send yet." };
  // Sent once per article: never spent on an outline whose text is still
  // being written (the screen offers this only once it is written).
  if (article.state !== "written") return { ok: false, message: "It is still being written. Ask again once it is." };
  const out = await sendFirstArticleLink(createServiceClient(), who.email, {
    domain,
    title: article.title,
    articleId: article.id,
    accountId: who.accountId,
    workspaceId,
  });
  if (out.sent > 0) return { ok: true, email: who.email };
  if (out.capped) return { ok: false, message: "We have sent you a few of these today already. Try again tomorrow." };
  if (out.skipped > 0) return { ok: true, email: who.email, already: true };
  return { ok: false, message: "The email could not be sent just now. Try again in a minute." };
}

/** "Email me when it's ready": whether the written-article email will reach this owner. */
export async function emailWhenReady(workspaceId: string): Promise<ExitAnswer> {
  const who = await ownerBeforeTrial(workspaceId);
  if (!who.ok) return who;
  if (!(await wantsDraftEmails(who.email))) return { ok: false, message: OPTED_OUT };
  return { ok: true, email: who.email };
}

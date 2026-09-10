"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/require-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { ALL_OPTIONAL, isEmailCategory, type EmailCategory } from "@/lib/email/categories";
import { readUnsubscribed, resubscribeAddress, unsubscribeAddress } from "@/lib/email/preferences";

/**
 * The Settings tab's half of the opt-out. The other half is the signed-out
 * page behind the footer link (app/unsubscribe), and both write the same
 * `email_preferences` row.
 *
 * The address is taken from the session and never from the form. That is the
 * whole security model here: `email_preferences` is keyed by address with RLS
 * on and no policies (migration 073), so every write goes through the service
 * client, which would happily silence any address it is handed. The signed-out
 * page can afford to trust its input because the address arrives HMAC-signed;
 * this one has a session instead, so it uses it and ignores anything the
 * browser says about who it is.
 *
 * Consequence worth knowing: this manages the signed-in person's own mail
 * only. A shared inbox on `accounts.report_email` with nobody behind it still
 * opts out through the link in its own footer - a member being able to silence
 * an address they do not own is the kind of thing that reads as a bug from
 * both ends.
 */
export type PreferenceResult = { ok: true; unsubscribed: string[] } | { ok: false; error: string };

export async function setEmailPreference(target: string, wanted: boolean): Promise<PreferenceResult> {
  const { user } = await requireAuth();
  const email = user.email;
  if (!email) return { ok: false, error: "Your account has no email address on it." };

  if (target !== ALL_OPTIONAL && !isEmailCategory(target)) {
    return { ok: false, error: "That is not a kind of email we send." };
  }
  const category = target as EmailCategory | typeof ALL_OPTIONAL;

  const supabase = createServiceClient();
  try {
    const unsubscribed = wanted
      ? await resubscribeAddress(supabase, email, category)
      : await unsubscribeAddress(supabase, email, category);
    revalidatePath("/settings/emails");
    return { ok: true, unsubscribed };
  } catch (e) {
    // `unsubscribeAddress` throws for a required category rather than storing
    // a wish it would then ignore. Surfacing the message keeps that honest.
    return { ok: false, error: e instanceof Error ? e.message : "Could not save that." };
  }
}

/** What the settings page shows: the categories currently switched off. */
export async function getMyEmailPreferences(): Promise<{ email: string | null; unsubscribed: string[] }> {
  const { user } = await requireAuth();
  const email = user.email ?? null;
  if (!email) return { email: null, unsubscribed: [] };
  const supabase = createServiceClient();
  // A preferences row that cannot be read must not render as "everything off":
  // the default state is wanting the mail, which is what an empty list means.
  const unsubscribed = await readUnsubscribed(supabase, email).catch(() => []);
  return { email, unsubscribed };
}

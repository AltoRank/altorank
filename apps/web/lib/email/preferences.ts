// ---------------------------------------------------------------------------
// Reading and writing what an address wants to hear about
// ---------------------------------------------------------------------------
//
// One row per address in `email_preferences` (migration 072), holding the
// category slugs it has switched off. By address rather than by user id,
// because the monthly report goes to `agencies.report_email`, which may be a
// shared inbox with no account behind it - and that inbox has the same right to
// stop the mail as a member does.
//
// Only the optional categories can be turned off; the required ones ignore the
// list entirely (lib/email/categories.ts says why). Writing "all" is the
// everything-optional opt-out and is stored as the single pseudo-category
// rather than expanded, so a category added later is off for somebody who
// already said "stop all of it" instead of quietly starting up again.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ALL_OPTIONAL, EMAIL_CATEGORIES, isOptional, type EmailCategory } from "./categories";

export type PreferenceTarget = EmailCategory | typeof ALL_OPTIONAL;

/** The categories currently switched off for an address. */
export async function readUnsubscribed(supabase: SupabaseClient, email: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("email_preferences")
    .select("unsubscribed")
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.unsubscribed as string[] | null) ?? [];
}

/**
 * Switch a category (or everything optional) off for an address.
 *
 * Refuses a required category rather than storing a wish it would then ignore:
 * a row saying "no billing email" that the code overrides on every send is a
 * lie told to the person who set it.
 */
export async function unsubscribeAddress(
  supabase: SupabaseClient,
  email: string,
  target: PreferenceTarget,
): Promise<string[]> {
  if (target !== ALL_OPTIONAL && !isOptional(target)) {
    throw new Error("That kind of email cannot be switched off.");
  }
  const address = email.trim().toLowerCase();
  const current = await readUnsubscribed(supabase, address);
  const next =
    target === ALL_OPTIONAL ? [ALL_OPTIONAL] : [...new Set([...current.filter((c) => c !== ALL_OPTIONAL), target])];
  // `all` already covers a single category, so an unsubscribe from one while
  // everything is off leaves the row alone rather than downgrading it.
  const write = current.includes(ALL_OPTIONAL) && target !== ALL_OPTIONAL ? current : next;

  const { error } = await supabase
    .from("email_preferences")
    .upsert({ email: address, unsubscribed: write, updated_at: new Date().toISOString() }, { onConflict: "email" });
  if (error) throw new Error(error.message);
  return write;
}

/** Turn one category back on, or everything with ALL_OPTIONAL. */
export async function resubscribeAddress(
  supabase: SupabaseClient,
  email: string,
  target: PreferenceTarget,
): Promise<string[]> {
  const address = email.trim().toLowerCase();
  const current = await readUnsubscribed(supabase, address);
  let next: string[];
  if (target === ALL_OPTIONAL) {
    next = [];
  } else if (current.includes(ALL_OPTIONAL)) {
    // "Everything off" minus one category is every other optional category,
    // written out, because the pseudo-category cannot express an exception.
    next = optionalCategories().filter((c) => c !== target);
  } else {
    next = current.filter((c) => c !== target);
  }
  const { error } = await supabase
    .from("email_preferences")
    .upsert({ email: address, unsubscribed: next, updated_at: new Date().toISOString() }, { onConflict: "email" });
  if (error) throw new Error(error.message);
  return next;
}

/** Every category that may be switched off, in the order the page lists them. */
export function optionalCategories(): EmailCategory[] {
  return (Object.keys(EMAIL_CATEGORIES) as EmailCategory[]).filter(isOptional);
}

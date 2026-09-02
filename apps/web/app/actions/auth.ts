"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { IMPERSONATION_COOKIE } from "@/lib/auth/impersonation-stash";

/**
 * Found during the pre-launch e2e walkthrough: the product had no way to sign
 * out. Not hidden, not broken - absent. Grep for signOut found nothing. A
 * founder testing on a shared machine, or switching between a work and a
 * client account, was stuck until the cookie expired.
 */
export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // Signing out while viewing as a customer ends the customer's session; the
  // operator marker would otherwise sit in the jar, inert but confusing, until
  // it expired.
  (await cookies()).delete(IMPERSONATION_COOKIE);
  redirect("/signin");
}

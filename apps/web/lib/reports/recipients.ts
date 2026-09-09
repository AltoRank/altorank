import type { SupabaseClient } from "@supabase/supabase-js";
import { accountRecipients } from "@/lib/email/account-recipients";

/**
 * Who the monthly report goes to.
 *
 * `accounts.report_email` is the address the Settings page offers for a
 * shared inbox or a client, and it is NULL by default; until 2026-09-07 it
 * was also the *only* address the cron would use, so an account that never
 * filled it in had its PDF generated every month and mailed to nobody, with
 * the run reporting success. When it is unset, the report goes to the same
 * people every other site email goes to: the members who can see the
 * workspace (lib/email/account-recipients.ts).
 *
 * An explicit address wins outright rather than being added to the members:
 * a client's inbox was chosen on purpose, and the members can open the
 * report on /reports.
 */
export async function reportRecipients(
  supabase: SupabaseClient,
  accountId: string,
  workspaceId: string,
  reportEmail: string | null | undefined,
): Promise<string[]> {
  const explicit = reportEmail?.trim().toLowerCase();
  if (explicit) return [explicit];
  return accountRecipients(supabase, accountId, workspaceId);
}

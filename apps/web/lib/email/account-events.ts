// ---------------------------------------------------------------------------
// The two security notices
// ---------------------------------------------------------------------------
//
// A password change and a new API key are the only two things that can happen
// to an AltoRank account that let somebody act as its owner. Both are silent
// otherwise: a stolen session changes the password and nothing anywhere says
// so, and an API key works without a browser and without a password.
//
// Both are `account` category - required, no unsubscribe link. A security
// notice somebody has switched off is not a security notice.
//
// Called from server actions on cookie-bound clients, so both build their own
// service client: `agencyRecipients` and `sent_emails` need the service role.

import { createServiceClient } from "@/lib/supabase/server";
import { notifyApiKeyCreated, notifyPasswordChanged } from "./lifecycle";

/**
 * Tell an address that its password changed.
 *
 * Both doors call this: the signed-in change in Settings and the reset flow's
 * "choose a new password". Never throws - the password is already changed by
 * the time this runs, and failing the redirect afterwards would leave somebody
 * on an error page believing it had not worked.
 */
export async function announcePasswordChanged(email: string | null): Promise<void> {
  if (!email) return;
  try {
    await notifyPasswordChanged(createServiceClient(), { email, at: new Date().toISOString() });
  } catch (err) {
    console.error(`[password] change notice for ${email}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Tell the account's owners and admins that a key was created.
 *
 * Including the person who created it: they are looking at the key value on
 * screen, but the notice is the record, and an owner who creates their own
 * keys should still have that record in their inbox. The key value is never
 * in it.
 */
export async function announceApiKeyCreated(opts: {
  agencyId: string;
  keyId: string;
  keyName: string;
  prefix: string;
  createdBy: string;
  canWrite: boolean;
  expiresAt: string | null;
}): Promise<void> {
  try {
    await notifyApiKeyCreated(
      createServiceClient(),
      opts.agencyId,
      {
        keyName: opts.keyName,
        prefix: opts.prefix,
        createdBy: opts.createdBy,
        canWrite: opts.canWrite,
        expiresAt: opts.expiresAt,
      },
      opts.keyId,
    );
  } catch (err) {
    console.error(`[api-keys] creation notice for ${opts.keyId}: ${err instanceof Error ? err.message : err}`);
  }
}

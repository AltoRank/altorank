"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/require-auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { seesEverySite } from "@/lib/google/account-consent";
import { GOOGLE_DISCONNECT_REFUSED, disconnectGoogleForAccount } from "@/lib/google/disconnect";

/**
 * Disconnect Google from the account the person is working in: delete every
 * stored Google token (each site's Search Console and Analytics connection,
 * and the account's consent) and revoke it at Google (lib/google/disconnect.ts).
 *
 * The same rule as connecting at the account level: only somebody who sees
 * every site may do it, because it changes every site.
 */
export async function disconnectGoogle(): Promise<{ revoked: boolean }> {
  const { user, accountId } = await requireAuth();
  const supabase = await createClient();
  if (!(await seesEverySite(supabase, user.id, accountId))) throw new Error(GOOGLE_DISCONNECT_REFUSED);

  const result = await disconnectGoogleForAccount(createServiceClient(), accountId);

  revalidatePath("/connect");
  revalidatePath("/connect/google");
  revalidatePath("/settings/search-console");
  return { revoked: result.revokeFailed === 0 };
}

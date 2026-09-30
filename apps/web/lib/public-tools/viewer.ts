// ---------------------------------------------------------------------------
// Who is calling a paid public tool
// ---------------------------------------------------------------------------
//
// The paid tools run for a signed-in account with a confirmed email. The
// session is the ordinary Supabase cookie on app.altorank.co: the widget on
// altorank.co calls with `credentials: "include"`, and because the two hosts
// are the same site, the browser sends the (SameSite=Lax, host-only) cookie.
//
// "Verified" means Supabase recorded the email as confirmed. An identity from
// an OAuth provider counts too: the provider vouched for the address.

import type { User } from "@supabase/supabase-js";

export interface ToolViewer {
  id: string;
  verified: boolean;
}

/** The fields of a Supabase user this module reads. */
export type ViewerUser = Pick<User, "id" | "email_confirmed_at"> & {
  identities?: { provider?: string | null }[] | null;
  is_anonymous?: boolean | null;
};

/** Providers that do not, on their own, prove the person holds an inbox. */
const UNVERIFIED_PROVIDERS = new Set(["email", "phone", "anonymous"]);

export function viewerFromUser(user: ViewerUser | null | undefined): ToolViewer | null {
  if (!user?.id || user.is_anonymous) return null;
  const confirmed = Boolean(user.email_confirmed_at);
  const oauth = (user.identities ?? []).some((i) => Boolean(i?.provider) && !UNVERIFIED_PROVIDERS.has(i.provider!));
  return { id: user.id, verified: confirmed || oauth };
}

/**
 * The viewer from the request's cookies, or null when nobody is signed in or
 * the session cannot be read. Never throws: an unreadable session is "not
 * signed in", which the handler answers with `auth_required`.
 */
export async function viewerFromCookies(): Promise<ToolViewer | null> {
  try {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return viewerFromUser(user);
  } catch (err) {
    console.error("[public-tools/viewer] session read failed", err instanceof Error ? err.message : err);
    return null;
  }
}

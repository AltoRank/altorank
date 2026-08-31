import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  // Set by the reset-password request action. A recovery link redirects to
  // the bare Site URL (the one target GoTrue can never clamp), so the code
  // arrives here with no ?next= - this cookie is how we know it belongs on
  // the set-password form rather than the dashboard.
  const jar = await cookies();
  const resetPending = jar.get("pw_reset_pending")?.value === "1";
  const next =
    searchParams.get("next") ?? (resetPending ? "/reset-password/confirm" : "/dashboard");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const res = NextResponse.redirect(`${origin}${next}`);
      if (resetPending) res.cookies.delete("pw_reset_pending");
      return res;
    }
  }

  return NextResponse.redirect(`${origin}/signin?error=Could+not+authenticate`);
}

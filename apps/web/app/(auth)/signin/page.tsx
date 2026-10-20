import type { Metadata } from "next";
import Link from "next/link";
import { safeNextPath } from "@/lib/auth/next-path";
import { signInMethod } from "@/lib/auth/signin-path";
import { SignInForm } from "@/components/auth/signin-form";
import { inviteJoinPath, inviteTokenFromNext } from "@/lib/team/invite";
import { requestSignInCode, signInWithPassword } from "./actions";

export const metadata: Metadata = {
  title: "Sign In",
};

/**
 * Where every signed-out app link lands (lib/supabase/middleware.ts sends it
 * here with `next`), most of them from an email. Code signup gives an account
 * a random password it never sees, so the code comes first and the password
 * is one tap away; `?method=password` opens on it.
 */
export default async function SignInPage(props: {
  searchParams: Promise<{ error?: string; next?: string; method?: string }>;
}) {
  const searchParams = await props.searchParams;
  const next = safeNextPath(searchParams?.next);
  // Signing in to accept an invitation: somebody with no login yet needs the
  // invitee's join form, not the owner signup that makes an account and a site.
  const inviteToken = inviteTokenFromNext(next);

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        <p className="mt-2 text-sm text-ink-3">Sign in to AltoRank</p>
      </div>

      <SignInForm
        next={next}
        initialMethod={signInMethod(searchParams?.method)}
        error={searchParams?.error}
        requestCode={requestSignInCode}
        signIn={signInWithPassword}
      />

      <p className="text-center text-sm text-ink-3">
        Don&apos;t have an account?{" "}
        {/* No `next` here: signup ends at the confirm email and then the
            wizard, so carrying a destination through would promise a landing
            this flow does not make. An invitation is the exception: its join
            form returns to the invite. */}
        <Link href={inviteToken ? inviteJoinPath(inviteToken) : "/signup"} className="font-medium text-accent-ink hover:underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}

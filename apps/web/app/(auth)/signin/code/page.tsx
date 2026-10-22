import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/auth/next-path";
import { PENDING_SIGNIN_COOKIE } from "@/lib/auth/pending-signin";
import { signinPath } from "@/lib/auth/signin-path";
import { parseSignupSource, signupSourceFields } from "@/lib/auth/signup-source";
import { SubmitButton } from "@/components/auth/submit-button";
import { CodeInput } from "@/components/auth/code-input";
import { verifySignInCode } from "../actions";

export const metadata: Metadata = { title: "Sign in with a code" };

/**
 * Where the emailed code is typed. Asking for one is /signin's own form now
 * (../actions.ts), so without a code on its way this page sends there,
 * keeping `next`, any error, and where the visitor came from (an older link
 * to this page carries it, and /signin's form is the one that records it).
 */
export default async function SignInCodePage(props: {
  searchParams: Promise<{ step?: string; error?: string; next?: string } & Record<string, string | string[] | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const { step, error, next: rawNext } = searchParams;
  const next = safeNextPath(rawNext);
  const email = (await cookies()).get(PENDING_SIGNIN_COOKIE)?.value ?? null;
  if (step !== "code" || email === null) {
    const carry = Object.fromEntries(signupSourceFields(parseSignupSource(searchParams)));
    redirect(signinPath("/signin", next, { ...(error ? { error } : {}), ...carry }));
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Check your email</h1>
        <p className="mt-2 text-sm text-ink-3">
          If <span className="font-medium text-ink-2">{email}</span> has an account, a code is on its way. Type it here.
        </p>
      </div>
      <form action={verifySignInCode} className="space-y-4">
        {next && <input type="hidden" name="next" value={next} />}
        {error && (
          <div role="alert" className="text-sm text-err-ink bg-err-soft px-3 py-2 rounded-lg">
            {error}
          </div>
        )}
        <CodeInput />
        <SubmitButton pendingLabel="Checking…">Sign in</SubmitButton>
      </form>
      <p className="text-center text-[12.5px] text-ink-3">
        <Link href={signinPath("/signin", next)} className="text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink">
          Send to a different email
        </Link>
      </p>
    </div>
  );
}

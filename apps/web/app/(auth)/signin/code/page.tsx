import type { Metadata } from "next";
import Link from "next/link";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { sendSignInCode } from "@/lib/email/auth-emails";
import { startSigninCodeSignup } from "@/lib/auth/signin-code-signup";
import { parseSignupSource, signupSourceFields, withRefererFallback } from "@/lib/auth/signup-source";
import { DEFAULT_AFTER_SIGN_IN, safeNextPath } from "@/lib/auth/next-path";
import { normalizeCode } from "@/lib/auth/pending-signup";
import { PENDING_SIGNIN_COOKIE, PENDING_SIGNIN_MAX_AGE } from "@/lib/auth/pending-signin";
import { SubmitButton } from "@/components/auth/submit-button";
import { CodeInput } from "@/components/auth/code-input";

export const metadata: Metadata = { title: "Sign in with a code" };

const INPUT =
  "w-full px-3 py-2.5 bg-bg border border-line rounded-[7px] text-base sm:text-[14px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft";

function withNext(path: string, next: string | null, extra?: Record<string, string>): string {
  const q = new URLSearchParams(extra);
  if (next) q.set("next", next);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * Sign in without a password: an email code, typed on this page. The same
 * answer whether or not the address has an account, so the form cannot be
 * used to find out which ones do.
 */
async function request(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const next = safeNextPath(formData.get("next"));
  // Where the visitor came from, carried in by hidden inputs from /signin's
  // link (lib/auth/signup-source.ts): recorded if this code makes the account,
  // and kept across a retry.
  const source = parseSignupSource(formData);
  const carry = Object.fromEntries(signupSourceFields(source));
  if (!email.includes("@")) redirect(withNext("/signin/code", next, { error: "Enter your email address.", ...carry }));
  try {
    const { createdUserId } = await sendSignInCode(email, next ?? DEFAULT_AFTER_SIGN_IN);
    // An address with no user got one, made by Supabase to receive this code:
    // a signup by the sign-in door, counted and given its account here
    // (lib/auth/signin-code-signup.ts). The page says the same either way.
    if (createdUserId) await startSigninCodeSignup(createdUserId, email, source);
  } catch (e) {
    console.error(`[signin] code for an address failed: ${e instanceof Error ? e.message : String(e)}`);
    redirect(withNext("/signin/code", next, { error: "The code could not be sent. Try again in a minute.", ...carry }));
  }
  (await cookies()).set(PENDING_SIGNIN_COOKIE, email, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/signin",
    maxAge: PENDING_SIGNIN_MAX_AGE,
  });
  redirect(withNext("/signin/code", next, { step: "code" }));
}

async function verify(formData: FormData) {
  "use server";
  const next = safeNextPath(formData.get("next"));
  const email = (await cookies()).get(PENDING_SIGNIN_COOKIE)?.value;
  if (!email) redirect(withNext("/signin/code", next, { error: "That code page expired. Ask for a new code." }));
  const token = normalizeCode(formData.get("code"));
  if (!token) redirect(withNext("/signin/code", next, { step: "code", error: "Enter the code from the email." }));
  const supabase = await createClient();
  let { error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error) ({ error } = await supabase.auth.verifyOtp({ email, token, type: "magiclink" }));
  if (error) redirect(withNext("/signin/code", next, { step: "code", error: "That code did not work. It may have expired: ask for a new one." }));
  (await cookies()).delete({ name: PENDING_SIGNIN_COOKIE, path: "/signin" });
  redirect(next ?? DEFAULT_AFTER_SIGN_IN);
}

export default async function SignInCodePage(props: {
  searchParams: Promise<{ step?: string; error?: string; next?: string } & Record<string, string | string[] | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const { step, error, next: rawNext } = searchParams;
  const next = safeNextPath(rawNext);
  const email = (await cookies()).get(PENDING_SIGNIN_COOKIE)?.value ?? null;
  const onCode = step === "code" && email !== null;
  // Only the request form can make an account, so only it carries the source.
  const requestHeaders = await headers();
  const sourceFields = onCode
    ? []
    : signupSourceFields(
        withRefererFallback(parseSignupSource(searchParams), requestHeaders.get("referer"), requestHeaders.get("host")),
      );

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{onCode ? "Check your email" : "Sign in with a code"}</h1>
        <p className="mt-2 text-sm text-ink-3">
          {onCode ? (
            <>
              If <span className="font-medium text-ink-2">{email}</span> has an account, a code is on its way. Type it here.
            </>
          ) : (
            "We email you a one-time code. No password needed."
          )}
        </p>
      </div>
      <form action={onCode ? verify : request} className="space-y-4">
        {next && <input type="hidden" name="next" value={next} />}
        {sourceFields.map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {error && (
          <div role="alert" className="text-sm text-err-ink bg-err-soft px-3 py-2 rounded-lg">
            {error}
          </div>
        )}
        {onCode ? (
          <CodeInput />
        ) : (
          <div>
            <label htmlFor="signin-email" className="text-[12.5px] font-medium text-ink-2 mb-1.5 block">
              Email
            </label>
            <input id="signin-email" name="email" type="email" required autoComplete="email" autoFocus className={INPUT} placeholder="you@yourbusiness.com" />
          </div>
        )}
        <SubmitButton pendingLabel={onCode ? "Checking…" : "Sending…"}>{onCode ? "Sign in" : "Email me a code"}</SubmitButton>
      </form>
      <p className="text-center text-[12.5px] text-ink-3">
        {onCode ? (
          <Link href={withNext("/signin/code", next)} className="text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink">
            Send to a different email
          </Link>
        ) : (
          <Link href={withNext("/signin", next)} className="text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink">
            Sign in with a password
          </Link>
        )}
      </p>
    </div>
  );
}

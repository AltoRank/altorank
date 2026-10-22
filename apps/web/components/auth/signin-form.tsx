"use client";

import Link from "next/link";
import { useState } from "react";
import { SubmitButton } from "@/components/auth/submit-button";
import { signinPath, type SignInMethod } from "@/lib/auth/signin-path";

// 16px below sm: iOS Safari zooms into any smaller field on focus.
const INPUT =
  "w-full px-3 py-2.5 bg-bg border border-line rounded-[7px] text-base sm:text-[14px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft";
const LABEL = "text-[12.5px] font-medium text-ink-2";

/**
 * /signin's form: the address and "Email me a sign-in code" first, because
 * an account made since code signup has no password it knows, and the
 * password one tap away for everyone who has one. The tap swaps the form in
 * place, keeping the address typed; without JavaScript it is a link to
 * `?method=password`, the same form from the server. `source` is where the
 * visitor came from (lib/auth/signup-source.ts), carried through both: a
 * code for an address with no account makes one, and the signup records it.
 */
export function SignInForm({
  next,
  initialMethod,
  error,
  source = [],
  requestCode,
  signIn,
}: {
  next: string | null;
  initialMethod: SignInMethod;
  error?: string;
  source?: ReadonlyArray<readonly [string, string]>;
  requestCode: (formData: FormData) => Promise<void>;
  signIn: (formData: FormData) => Promise<void>;
}) {
  const [method, setMethod] = useState<SignInMethod>(initialMethod);
  // Switched here, not opened on it: the address is likely typed, so the
  // password field is the next thing to fill.
  const [switched, setSwitched] = useState(false);
  const password = method === "password";
  const other: SignInMethod = password ? "code" : "password";

  return (
    <form action={password ? signIn : requestCode} className="space-y-4">
      {next && <input type="hidden" name="next" value={next} />}
      {source.map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {error && (
        <div role="alert" className="text-sm text-err-ink bg-err-soft px-3 py-2 rounded-lg">
          {error}
        </div>
      )}
      <div>
        <label htmlFor="signin-email" className={`${LABEL} mb-1.5 block`}>
          Email
        </label>
        <input id="signin-email" name="email" type="email" required autoComplete="email" autoFocus className={INPUT} placeholder="you@yourbusiness.com" />
      </div>
      {password && (
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <label htmlFor="signin-password" className={LABEL}>
              Password
            </label>
            <Link href="/reset-password" className="text-[12.5px] text-ink-3 hover:text-ink">
              Forgot it?
            </Link>
          </div>
          <input id="signin-password" name="password" type="password" required autoComplete="current-password" autoFocus={switched} className={INPUT} />
        </div>
      )}
      <SubmitButton pendingLabel={password ? "Signing in…" : "Sending…"}>{password ? "Sign in" : "Email me a sign-in code"}</SubmitButton>
      <p className="m-0 text-center text-[12.5px] text-ink-3">
        <Link
          href={signinPath("/signin", next, { ...(other === "password" ? { method: "password" } : {}), ...Object.fromEntries(source) })}
          onClick={(e) => {
            e.preventDefault();
            setMethod(other);
            setSwitched(true);
          }}
          className="text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink"
        >
          {password ? "Email me a code instead" : "Use a password instead"}
        </Link>
      </p>
    </form>
  );
}

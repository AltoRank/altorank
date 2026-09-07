import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { authErrorMessage } from "@/lib/auth/errors";
import { safeNextPath } from "@/lib/auth/next-path";
import { SubmitButton } from "@/components/auth/submit-button";

export const metadata: Metadata = {
  title: "Sign In",
};

async function signIn(formData: FormData) {
  "use server";
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  // A connector's consent screen sends people here first; go back to it after.
  const next = safeNextPath(formData.get("next"));
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const nextParam = next ? "&next=" + encodeURIComponent(next) : "";
    redirect("/signin?error=" + encodeURIComponent(authErrorMessage(error.message)) + nextParam);
  }
  redirect(next ?? "/dashboard");
}

export default async function SignInPage(props: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const searchParams = await props.searchParams;
  const next = safeNextPath(searchParams?.next);

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        <p className="mt-2 text-sm text-ink-3">
          Sign in to AltoRank
        </p>
      </div>

      <form action={signIn} className="space-y-4">
        {next && <input type="hidden" name="next" value={next} />}
        {searchParams?.error && (
          <div className="text-sm text-err-ink bg-err-soft px-3 py-2 rounded-lg">
            {searchParams.error}
          </div>
        )}
        <div>
          <label className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1.5 block">
            Email
          </label>
          <input
            name="email"
            type="email"
            required
            className="w-full px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <label className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3 block">
              Password
            </label>
            <Link
              href="/reset-password"
              className="text-[11.5px] text-ink-3 hover:text-ink"
            >
              Forgot it?
            </Link>
          </div>
          <input
            name="password"
            type="password"
            required
            className="w-full px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
          />
        </div>
        <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
      </form>

      <p className="text-center text-sm text-ink-3">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-medium text-accent-ink hover:underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { authErrorMessage } from "@/lib/auth/errors";

export const metadata: Metadata = { title: "Choose a new password" };

/**
 * The second half of the reset: the emailed link went through /callback,
 * which exchanged the code for a recovery session, so by the time this page
 * renders the visitor is authenticated as the account being reset. That
 * session is the authorisation - which is why this page is NOT in the
 * middleware's public list, and why an unauthenticated hit is bounced to the
 * request form rather than shown a password field it could never submit.
 */
async function setNewPassword(formData: FormData) {
  "use server";
  const password = formData.get("password") as string;
  const confirm = formData.get("confirm") as string;

  if (!password || password.length < 8) {
    redirect(
      "/reset-password/confirm?error=" +
        encodeURIComponent("Use at least 8 characters."),
    );
  }
  if (password !== confirm) {
    redirect(
      "/reset-password/confirm?error=" +
        encodeURIComponent("The two passwords do not match."),
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    redirect(
      "/reset-password/confirm?error=" +
        encodeURIComponent(authErrorMessage(error.message)),
    );
  }

  redirect("/dashboard");
}

export default async function ConfirmResetPage(props: {
  searchParams: Promise<{ error?: string }>;
}) {
  const searchParams = await props.searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Link expired, already used, or someone typed the URL. The request page
    // is the honest place to send them; an explanation beats a dead form.
    redirect(
      "/reset-password?error=" +
        encodeURIComponent(
          "That reset link has expired or was already used. Request a new one.",
        ),
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
        <p className="mt-2 text-sm text-ink-3">for {user.email}</p>
      </div>

      <form action={setNewPassword} className="space-y-4">
        {searchParams?.error && (
          <div className="text-sm text-err-ink bg-err-soft px-3 py-2 rounded-lg">
            {searchParams.error}
          </div>
        )}
        <div>
          <label className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1.5 block">
            New password
          </label>
          <input
            name="password"
            type="password"
            required
            minLength={8}
            className="w-full px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
          />
        </div>
        <div>
          <label className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1.5 block">
            Repeat it
          </label>
          <input
            name="confirm"
            type="password"
            required
            minLength={8}
            className="w-full px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
          />
        </div>
        <button
          type="submit"
          className="w-full py-2.5 bg-accent text-white font-medium text-[13px] rounded-[7px] hover:bg-accent-2 transition-colors cursor-pointer"
        >
          Set password and sign in
        </button>
      </form>
    </div>
  );
}

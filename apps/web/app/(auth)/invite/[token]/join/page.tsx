import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { sendSignupConfirmation } from "@/lib/email/auth-emails";
import { authErrorMessage } from "@/lib/auth/errors";
import { SubmitButton } from "@/components/auth/submit-button";
import { inviteJoinPath, invitePath, inviteSignInPath, lookupOpenInvite } from "@/lib/team/invite";

export const metadata: Metadata = { title: "Join your team" };

/**
 * A login for an invited teammate, and nothing else.
 *
 * The owner signup at /signup asks for a website and makes an account and a
 * site for it, which is wrong for somebody joining an account that already
 * exists. This creates the auth user for the invited address only; the
 * confirmation link returns to the invite page, which adds the membership.
 * The address is the invite's own, never one typed here, so the link cannot
 * be used to make a login for some other address.
 */
async function joinWithInvite(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const name = String(formData.get("name") ?? "").trim().slice(0, 120);
  const back = (params: Record<string, string>) => `${inviteJoinPath(token)}?${new URLSearchParams(params)}`;

  const admin = createServiceClient();
  const lookup = await lookupOpenInvite(admin, token);
  if (lookup.status !== "open") redirect(invitePath(token));
  const { invite } = lookup;

  if (password.length < 8) redirect(back({ error: "Use at least 8 characters for your password." }));

  try {
    await sendSignupConfirmation({
      email: invite.email,
      password,
      name,
      next: invitePath(token),
      invitedTo: invite.accountName ?? "your team",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not create your login";
    // The address already has a login: the way in is sign-in, not a second account.
    if (/already (been )?registered|already exists/i.test(message)) {
      redirect(back({ error: "This address already has a login. Sign in to accept the invitation." }));
    }
    redirect(back({ error: authErrorMessage(message) }));
  }

  redirect(back({ sent: "1" }));
}

export default async function JoinPage(props: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const { token } = await props.params;
  const searchParams = await props.searchParams;

  // Somebody already signed in accepts from the invite page itself.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect(invitePath(token));

  const lookup = await lookupOpenInvite(createServiceClient(), token);
  if (lookup.status !== "open") redirect(invitePath(token));
  const { invite } = lookup;

  if (searchParams?.sent) {
    return (
      <div className="space-y-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Check your email</h1>
        <p className="text-sm text-ink-3">
          We sent a confirmation link to <strong>{invite.email}</strong>. Open it to finish joining
          {invite.accountName ? ` ${invite.accountName}` : " your team"}.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          {invite.accountName ? `Join ${invite.accountName}` : "Join your team"}
        </h1>
        <p className="mt-2 text-sm text-ink-3">Choose a password for your login. You are joining an existing account, so there is no site to add.</p>
      </div>

      <form action={joinWithInvite} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        {searchParams?.error && (
          <div className="text-sm text-err-ink bg-err-soft px-3 py-2 rounded-lg">{searchParams.error}</div>
        )}
        <div>
          <label className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1.5 block">
            Email
          </label>
          <input
            type="email"
            value={invite.email}
            readOnly
            disabled
            className="w-full px-2.5 py-2 bg-bg-2 border border-line rounded-[7px] text-[13px] text-ink-3"
          />
        </div>
        <div>
          <label className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1.5 block">
            Your name
          </label>
          <input
            name="name"
            type="text"
            autoComplete="name"
            maxLength={120}
            className="w-full px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
          />
        </div>
        <div>
          <label className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1.5 block">
            Password
          </label>
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className="w-full px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
          />
        </div>
        <SubmitButton pendingLabel="Creating your login…">Create login</SubmitButton>
      </form>

      <p className="text-center text-sm text-ink-3">
        Already have a login?{" "}
        <Link href={inviteSignInPath(token)} className="font-medium text-accent-ink hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}

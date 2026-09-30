// ---------------------------------------------------------------------------
// The account-only signup, from a free tool on altorank.co
// ---------------------------------------------------------------------------
//
// `/signup?from=tools&return_to=https://altorank.co/tools/<slug>/`
//
// The person wants to run one tool, so this asks only what an account needs:
// email and password. It creates the auth user (unconfirmed) and sends the
// tools variant of the confirmation email, whose link comes back through the
// callback to /tool-return/<slug> and on to the tool page.
//
// It creates no account row, no membership and no workspace, so there is
// nothing half-made to clean up and nothing for the trial gate to hold. The
// app already treats "a user with no membership" as a normal state: the
// account is created the first time they open the dashboard
// (lib/queries/account.ts, `ensureAccount`), a person with no site is sent to
// add one (lib/billing/gate-paths.ts, `openWithoutSite`), and adding one opens
// the wizard, where the trial gate takes over exactly as for any signup.

import { redirect } from "next/navigation";
import { sendSignupConfirmation } from "@/lib/email/auth-emails";
import { authErrorMessage } from "@/lib/auth/errors";
import { toolReturnPath } from "@/lib/public-tools/return-url";

export const TOOLS_SIGNUP_SENT =
  "Check your email and click the link to confirm. It brings you straight back to the tool.";

/** Never returns: every path ends in a redirect back to the tools signup. */
export async function signUpForTools(formData: FormData, slug: string, returnTo: string): Promise<never> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const back = (key: "error" | "success", message: string) =>
    `/signup?${new URLSearchParams({ from: "tools", return_to: returnTo, [key]: message })}`;
  if (!email || !password) redirect(back("error", "Enter your email and a password."));
  try {
    await sendSignupConfirmation({ email, password, next: toolReturnPath(slug), variant: "tools" });
  } catch (e) {
    redirect(back("error", authErrorMessage(e instanceof Error ? e.message : "Could not create the account")));
  }
  redirect(back("success", TOOLS_SIGNUP_SENT));
}

import { createServiceClient } from "@/lib/supabase/server";
import { notifyWelcome } from "@/lib/email/lifecycle";
import { accountTrialGate } from "@/lib/billing/body-lock";

// Shared by the two ways a signup is confirmed: the link in the email
// (app/(auth)/callback) and the code typed on /signup/verify.

/**
 * Never allowed to break the confirmation. The account is confirmed by the
 * time this runs, and a mail provider being down must not turn "you are in"
 * into "could not authenticate".
 */
export async function sendWelcome(userId: string): Promise<void> {
  try {
    const admin = createServiceClient();
    const { data: member } = await admin
      .from("account_members")
      .select("account_id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    // The site they typed at signup, when there is one - it is what makes the
    // email about them rather than about the product.
    let domain: string | null = null;
    let name: string | null = null;
    if (member?.account_id) {
      const { data: workspace } = await admin
        .from("workspaces")
        .select("domain")
        .eq("account_id", member.account_id as string)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      domain = (workspace?.domain as string | null) ?? null;
    }
    const { data: user } = await admin.auth.admin.getUserById(userId);
    const meta = user?.user?.user_metadata as { name?: string; full_name?: string } | undefined;
    name = meta?.name?.trim() || meta?.full_name?.trim() || null;
    // A name field that holds an address is a name nobody wants read back.
    if (name?.includes("@")) name = null;

    // Before the trial there is no dashboard and no draft text to promise
    // (lib/billing/trial.ts), and the welcome must not promise either. Asked
    // with the person's own address, so an operator or a bypassed test
    // address gets the mail that matches what they will see. With no account
    // to ask about yet, the account that will be made for them is a fresh
    // one, which is exactly the one the gate holds: the before-trial mail.
    const beforeTrial = member?.account_id
      ? (await accountTrialGate(admin, member.account_id as string, user?.user?.email ?? null)) === "gated"
      : true;

    await notifyWelcome(admin, userId, { name, domain, beforeTrial });
  } catch (err) {
    console.error(`[callback] welcome email for ${userId}: ${err instanceof Error ? err.message : err}`);
  }
}

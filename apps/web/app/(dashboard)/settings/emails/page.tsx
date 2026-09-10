import type { Metadata } from "next";
import { Card } from "@/components/ui";
import { getMyEmailPreferences } from "@/app/actions/email-preferences";
import { optionalCategories } from "@/lib/email/preferences";
import { EMAIL_CATEGORIES, type EmailCategory } from "@/lib/email/categories";
import { EmailPreferencesForm } from "@/components/dashboard/email-preferences-form";
import { SettingsShell } from "../settings-shell";

export const metadata: Metadata = { title: "Email settings" };

/**
 * What this account's signed-in person hears about by email.
 *
 * The opt-out already existed, but only from inside an email: the footer link
 * opens app/unsubscribe, which is signed-out by design so a shared inbox can
 * use it. That left somebody who is already looking at the product having to
 * go and find an old email to turn draft notifications off. This is the same
 * preferences row reached from where a person would look for it.
 *
 * Per address, not per workspace, so it does not take the sidebar's scope: the
 * row is keyed by email and a member on three sites has one answer, not three.
 */
export default async function EmailSettingsPage() {
  const { email, unsubscribed } = await getMyEmailPreferences();
  const required = Object.keys(CATEGORY_TEXT) as RequiredCategory[];

  return (
    <SettingsShell title="Emails" subtitle={<span>What we send you, and what we do not</span>}>
      <Card title="Optional emails">
        {email ? (
          <EmailPreferencesForm
            email={email}
            optional={optionalCategories()}
            initialUnsubscribed={unsubscribed}
          />
        ) : (
          <p className="text-[13px] text-ink-3">
            There is no email address on your account, so there is nothing to send or to stop.
          </p>
        )}
      </Card>

      {/* Named rather than hidden. A list of switches that silently omits the
          mail somebody actually receives reads as a lie the first time a
          failed-payment notice arrives - the same reason the signed-out page
          carries this block. */}
      <Card title="These keep coming">
        <ul className="space-y-2">
          {required.map((c) => (
            <li key={c} className="text-[12.5px] text-ink-3">
              <span className="font-medium text-ink-2">{EMAIL_CATEGORIES[c].label}</span> &mdash;{" "}
              {CATEGORY_TEXT[c]}
            </li>
          ))}
        </ul>
        <p className="mt-3 max-w-[62ch] text-[12.5px] leading-relaxed text-ink-3">
          Each one is either the thing you asked for or the only warning before something you own stops
          working. There is no version of &ldquo;we could not reach you about your failed payment because
          you asked us not to&rdquo; that would be fair to you. Closing the account stops them.
        </p>
      </Card>
    </SettingsShell>
  );
}

/** The categories `EMAIL_CATEGORIES` marks as not optional, as a union. */
type RequiredCategory = {
  [K in EmailCategory]: (typeof EMAIL_CATEGORIES)[K]["optional"] extends false ? K : never;
}[EmailCategory];

/**
 * Why each required category has no switch. Deliberately not CATEGORY_HELP:
 * that says what the email is, this says what it would cost to miss it.
 *
 * Keyed by the union above rather than by hand, so a category added to
 * categories.ts as required fails to compile here until somebody writes the
 * reason. The alternative is this list quietly rendering an empty line for it.
 */
const CATEGORY_TEXT: Record<RequiredCategory, string> = {
  auth: "sign-in links, password resets and team invitations. The link is the email.",
  account: "a password change or a new API key, which is how you find out about one you did not make.",
  billing: "a failed payment, a plan change or a pause ending, before it takes effect.",
};

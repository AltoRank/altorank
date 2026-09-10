// ---------------------------------------------------------------------------
// What kinds of email this product sends, and which of them may be refused
// ---------------------------------------------------------------------------
//
// Two questions have one answer here, on purpose: an email's category decides
// both what the footer says and whether an unsubscribe link appears under it.
//
// The line is not "transactional vs marketing". It is: does refusing this mail
// leave the person unable to do something they need to do?
//
//   required   the link IS the thing (confirm, reset, invite), or the message
//              is the only warning before something they own stops working
//              (payment failed, plan changed, key created, password changed)
//   optional   news about work the product did, which the dashboard also shows
//              and which nobody is harmed by missing
//
// Nothing in this product is a newsletter, so there is no "marketing"
// category and the footer never says "you are subscribed to". It says why this
// particular message was sent.

export const EMAIL_CATEGORIES = {
  /** Confirm signup, password reset, sign-in link, team invite. */
  auth: { optional: false, label: "Account access" },
  /** Password changed, API key created, welcome. */
  account: { optional: false, label: "Account security" },
  /** Payment failed, cancelled, paused, pause ending, plan changed. */
  billing: { optional: false, label: "Billing" },
  /** A draft was written, a draft was approved. */
  drafts: { optional: true, label: "Drafts and approvals" },
  /** An article went live, or a publish failed. */
  publishing: { optional: true, label: "Publishing" },
  /** A refresh proposal is waiting for review. */
  improvements: { optional: true, label: "Improvement proposals" },
  /** The monthly PDF. */
  reports: { optional: true, label: "Monthly reports" },
  /** Nothing is being written, and why. */
  product: { optional: true, label: "Workspace status" },
} as const;

export type EmailCategory = keyof typeof EMAIL_CATEGORIES;

/**
 * The one-line description under each label. Here rather than in a page so the
 * signed-out unsubscribe page and the Settings tab cannot drift into
 * describing the same email two different ways.
 */
export const CATEGORY_HELP: Record<EmailCategory, string> = {
  auth: "Sign-in and password links.",
  account: "Password changes and new API keys.",
  billing: "Payments, plan changes, pauses.",
  drafts: "A draft was written, or approved.",
  publishing: "An article went live, or a publish failed.",
  improvements: "A rewrite of an existing page is waiting for review.",
  reports: "The monthly PDF.",
  product: "Nothing is being written for a workspace, and why.",
};


/** The pseudo-category an "everything optional" opt-out stores. */
export const ALL_OPTIONAL = "all";

export function isEmailCategory(value: unknown): value is EmailCategory {
  return typeof value === "string" && value in EMAIL_CATEGORIES;
}

/** Whether a category may be switched off at all. */
export function isOptional(category: EmailCategory): boolean {
  return EMAIL_CATEGORIES[category].optional;
}

/**
 * Whether this address still wants this category.
 *
 * A required category ignores the list entirely - not because the wish does
 * not count, but because there is no version of "we could not reach you about
 * your failed payment because you asked us not to" that is fair to the
 * customer.
 */
export function wantsCategory(unsubscribed: readonly string[] | null | undefined, category: EmailCategory): boolean {
  if (!isOptional(category)) return true;
  const list = unsubscribed ?? [];
  return !list.includes(ALL_OPTIONAL) && !list.includes(category);
}

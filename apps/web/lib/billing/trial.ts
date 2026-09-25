// ---------------------------------------------------------------------------
// The seven-day card trial: who can start one, and what to say about it
// ---------------------------------------------------------------------------
//
// A hosted plan starts with TRIAL_DAYS of trial. The card is taken at
// checkout and charged when the trial ends unless the customer cancels first.
// The offer is made after onboarding: setup writes the account's first
// article before any card is entered, and the account sees its shape (title,
// outline, length, sources) on the gate screen. The text opens with the
// trial, and so do the dashboard, approve, publish and the rest of the
// week's drafts.
//
// One trial per account. Stripe does not enforce that on its own (a customer
// can open a second trialing subscription), so eligibility is decided here
// from `accounts.trial_ends_at`, which the webhook stamps from the
// subscription's `trial_end` and which nothing ever clears.

import { TRIAL_DAYS } from "@/lib/stripe";

export type TrialRow = {
  plan_status?: string | null;
  stripe_subscription_id?: string | null;
  trial_ends_at?: string | null;
};

/**
 * Whether checkout should add trial days for this account: never trialed,
 * and not already holding a subscription. An account that had a trial and
 * cancelled it pays from day one the second time.
 */
export function trialEligible(account: TrialRow | null | undefined): boolean {
  if (!account) return true;
  if (account.trial_ends_at) return false;
  if (account.stripe_subscription_id) return false;
  return account.plan_status !== "active" && account.plan_status !== "trialing";
}

export type TrialInfo = {
  /** ISO timestamp the trial ends, always set. */
  endsAt: string;
  /** Whole days left, never negative. 0 on the last day. */
  daysLeft: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The running trial's facts, or null when the account is not trialing. */
export function trialInfo(account: TrialRow | null | undefined, now: Date = new Date()): TrialInfo | null {
  if (!account || account.plan_status !== "trialing" || !account.trial_ends_at) return null;
  const ends = new Date(account.trial_ends_at).getTime();
  if (Number.isNaN(ends)) return null;
  return {
    endsAt: account.trial_ends_at,
    daysLeft: Math.max(0, Math.ceil((ends - now.getTime()) / DAY_MS)),
  };
}

/** "Trial ends in 3 days" / "Trial ends today". */
export function trialEndsLabel(info: TrialInfo): string {
  if (info.daysLeft <= 0) return "Trial ends today";
  if (info.daysLeft === 1) return "Trial ends tomorrow";
  return `Trial ends in ${info.daysLeft} days`;
}

export function formatTrialDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** The one sentence the product uses for the offer, everywhere it is made. */
export const TRIAL_OFFER = `${TRIAL_DAYS} days free with a card, then the plan price. Cancel from Billing before it ends and nothing is charged.`;

/**
 * Whether this account must start its trial before the dashboard opens.
 *
 * The order the product now promises: onboarding writes the first article,
 * the person sees its shape (title, outline, length, sources) and the month
 * planned behind it on the gate screen, and the card is asked there - not
 * from a banner found later. The text opens with the trial, and so does the
 * dashboard.
 *
 * Three accounts are never gated, and each for its own reason:
 *
 *   self-host   no Stripe key, so there is no trial to start and nothing to
 *               charge. Gating here would lock an operator out of the install
 *               they are running themselves.
 *   operator    our own accounts, which have no plan by design.
 *   plan        already paying, or already trialing.
 *
 * `TRIAL_GATE_DISABLED` turns it off without a deploy. A gate on the way into
 * the product is the one change where being wrong locks out every account at
 * once, so it ships with its own switch.
 */
export function trialGateApplies(quota: { reason?: string; trialEligible?: boolean } | null | undefined): boolean {
  if (process.env.TRIAL_GATE_DISABLED === "1") return false;
  if (!quota) return false;
  if (quota.reason !== "no-plan") return false;
  return Boolean(quota.trialEligible);
}

/**
 * Addresses that never meet the gate, from `TRIAL_GATE_BYPASS_EMAILS`.
 *
 * Our own test accounts sign up as `<name>+whatever@gmail.com` and would
 * otherwise be asked for a card on every login, which makes testing anything
 * behind the dashboard a chore. Plus-addressing is normalised away, so one
 * entry - the base address - covers every tag ever used with it.
 *
 * An environment variable and not a constant: this repo is public, and a
 * hardcoded address would publish our test mailbox and bake a bypass nobody
 * asked for into every install of it. Unset means nobody is exempt, which is
 * the right default for an install that is not ours.
 *
 * The bypass only stops the redirect. /onboarding still renders the trial
 * screen for these accounts, so the thing being tested stays reachable.
 */
function bypassBases(): string[] {
  return (process.env.TRIAL_GATE_BYPASS_EMAILS ?? "")
    .split(",")
    .map((e) => normalizeEmail(e))
    .filter(Boolean);
}

/** Lowercased, with any `+tag` removed: one entry covers every tag. */
function normalizeEmail(email: string | null | undefined): string {
  const trimmed = (email ?? "").trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return "";
  const local = trimmed.slice(0, at).split("+")[0];
  return local ? `${local}${trimmed.slice(at)}` : "";
}

export function trialGateBypassed(email: string | null | undefined): boolean {
  const normalized = normalizeEmail(email);
  return Boolean(normalized) && bypassBases().includes(normalized);
}

/**
 * Where an account stands against the trial gate. The one answer every
 * surface asks for, so that no two of them can disagree.
 *
 *   open      no gate: self-host, operator, on a plan or trialing, already
 *             had its trial, or TRIAL_GATE_DISABLED is on.
 *   gated     has to start the trial. /onboarding shows the first article
 *             with no preview, the dashboard redirects there, and no surface
 *             hands out an article body (see draftBodyLocked).
 *   bypassed  would be gated, but the address is on TRIAL_GATE_BYPASS_EMAILS.
 *             /onboarding still shows the gate screen, so the thing being
 *             tested is reachable; the dashboard and the bodies stay open.
 *
 * Until this existed the onboarding page computed its own answer from the
 * quota and ignored the kill switch, while the dashboard layout and the
 * planner used `trialGateApplies`. With the switch on, the run screen still
 * ended on the card and had no way into the product.
 *
 * `simulated` is the dev toolbar's forced gate (lib/dev/simulation.ts), which
 * is null in production. It forces the gate on; the bypass still applies.
 */
export type TrialGateState = "open" | "gated" | "bypassed";

export function trialGateState(
  quota: { reason?: string; trialEligible?: boolean } | null | undefined,
  email: string | null | undefined,
  opts: { simulated?: boolean } = {},
): TrialGateState {
  if (!(opts.simulated === true || trialGateApplies(quota))) return "open";
  return trialGateBypassed(email) ? "bypassed" : "gated";
}

/**
 * Whether article bodies are withheld from this caller: the text, its HTML
 * and Markdown renderings, and the columns that quote it.
 *
 * A real signup (2026-09-22) copied the first draft from the read-only
 * preview onboarding used to link to and published it on their own site 48
 * minutes later, without starting a trial. What the trial buys starts with
 * reading the article, so before it the product shows the article's shape -
 * title, outline, length, sources - and nothing worth copying.
 */
export function draftBodyLocked(
  quota: { reason?: string; trialEligible?: boolean } | null | undefined,
  email: string | null | undefined,
  opts: { simulated?: boolean } = {},
): boolean {
  return trialGateState(quota, email, opts) === "gated";
}

/** The refusal every locked surface gives, so the reason reads the same everywhere. */
export const BODY_LOCKED_MESSAGE =
  `The article text opens when the ${TRIAL_DAYS}-day trial starts. Start it from the setup screen to read, approve and publish this draft.`;

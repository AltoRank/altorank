// ---------------------------------------------------------------------------
// What an onboarding.step event may say beyond its name
// ---------------------------------------------------------------------------
//
// The gate -> trial -> approval funnel needs a little more than "this step was
// reached": which setup ending was on screen, on what size of screen the
// offer was seen, where an article was opened from, which copy button was
// used. Each of those is a closed list here, and `stepProps` keeps only a
// value on its step's list, so an event can carry a word from this file and
// nothing a browser typed: no text, no URL, no email.
//
// Client-safe: lists and pure functions. The write is ./step-events.ts.

import type { SetupEnding } from "./setup-retry";
import type { OnboardingStepName } from "./step-names";

/** Every ending of setup (lib/onboarding/setup-retry.ts `setupEnding`). */
export const SETUP_ENDINGS = ["article", "writing", "provider-down", "retry", "first-failed", "nothing-planned", "no-article"] as const satisfies readonly SetupEnding[];
// The list cannot fall behind the type: an ending added there and not here
// fails the build on this line.
const _everyEnding: Exclude<SetupEnding, (typeof SETUP_ENDINGS)[number]> extends never ? true : never = true;
void _everyEnding;

/** The screen's width, bucketed at the gate's own breakpoints (Tailwind sm and lg). */
export const VIEWPORTS = ["mobile", "tablet", "desktop"] as const;
export type Viewport = (typeof VIEWPORTS)[number];

/** Where the editor was opened from: the page before it, as one word. */
export const OPENED_FROM = ["setup", "dashboard", "articles", "review", "keywords", "article", "app", "external", "direct"] as const;
export type OpenedFrom = (typeof OPENED_FROM)[number];

export const COPY_FORMATS = ["markdown", "html"] as const;
export type CopyFormat = (typeof COPY_FORMATS)[number];
/** Which copy button: the publish panel's pair, the Export menu, or the Markdown preview it opens. */
export const COPY_SURFACES = ["publish_panel", "export_menu", "export_preview"] as const;
export type CopySurface = (typeof COPY_SURFACES)[number];

/** What started a setup run: the first for the site, another one asked for, or the overnight provider retry. */
export const RUN_TRIGGERS = ["first", "rerun", "provider_retry"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const APPROVED_AS = ["approved", "scheduled"] as const;
/** Next up's two links: the draft it names, or the rest of the review queue. */
export const NEXT_UP_TARGETS = ["draft", "more"] as const;
export type NextUpTarget = (typeof NEXT_UP_TARGETS)[number];
export const TRIAL_PLANS = ["starter", "growth"] as const;
export const TRIAL_INTERVALS = ["month", "year"] as const;
/**
 * Which trial button was pressed: the gate's price box, its sticky bar, the
 * quiet box when there is no article to show, the Articles page's offer, or
 * a plan card on Billing that opens the trial.
 */
export const TRIAL_SURFACES = ["price_box", "sticky_bar", "quiet_box", "articles", "billing"] as const;
export type TrialSurface = (typeof TRIAL_SURFACES)[number];
/** How a checkout form was left without paying: the inline "Not now", the sheet's Close, Escape, its backdrop. */
export const CHECKOUT_CLOSES = ["not_now", "close", "escape", "backdrop"] as const;
export type CheckoutClose = (typeof CHECKOUT_CLOSES)[number];
/**
 * Where a checkout that never opened stopped: Stripe.js did not load (a
 * blocker, the network), the session was not created (our action or
 * Stripe refused), or Stripe would not build the form from it.
 */
export const CHECKOUT_FAILURES = ["load", "create", "mount"] as const;
export type CheckoutFailure = (typeof CHECKOUT_FAILURES)[number];
/**
 * Which checkout a trial button opens: Stripe's own page (hosted), or
 * Stripe's form on our page (embedded, only with a publishable key:
 * components/billing/embedded-checkout.tsx). Billing's plan cards always
 * open the hosted page.
 */
export const CHECKOUT_UIS = ["hosted", "embedded"] as const;
export type CheckoutUi = (typeof CHECKOUT_UIS)[number];

/** The props each step may carry, and the list each value must be on. */
const ALLOWED: Partial<Record<OnboardingStepName, Record<string, readonly string[]>>> = {
  setup_ending_shown: { ending: SETUP_ENDINGS },
  offer_seen: { viewport: VIEWPORTS },
  article_opened: { from: OPENED_FROM, viewport: VIEWPORTS },
  article_copied: { format: COPY_FORMATS, surface: COPY_SURFACES },
  article_approved: { status: APPROVED_AS },
  run_started: { trigger: RUN_TRIGGERS },
  trial_started: { plan: TRIAL_PLANS },
  next_up_clicked: { target: NEXT_UP_TARGETS },
  trial_clicked: { surface: TRIAL_SURFACES, plan: TRIAL_PLANS, interval: TRIAL_INTERVALS, checkout: CHECKOUT_UIS },
  checkout_closed: { how: CHECKOUT_CLOSES, surface: TRIAL_SURFACES, viewport: VIEWPORTS },
  checkout_failed: { stage: CHECKOUT_FAILURES, surface: TRIAL_SURFACES, viewport: VIEWPORTS, checkout: CHECKOUT_UIS },
};

export type StepProps = Partial<{
  ending: SetupEnding;
  viewport: Viewport;
  from: OpenedFrom;
  format: CopyFormat;
  /** A copy button for article_copied, a trial button for the trial steps: each step's own list. */
  surface: CopySurface | TrialSurface;
  trigger: RunTrigger;
  status: (typeof APPROVED_AS)[number];
  plan: (typeof TRIAL_PLANS)[number];
  interval: (typeof TRIAL_INTERVALS)[number];
  target: NextUpTarget;
  how: CheckoutClose;
  stage: CheckoutFailure;
  checkout: CheckoutUi;
}>;

/**
 * Of whatever was sent, the props this step may carry with a value on its
 * list. Anything else - another key, a value off the list, a non-string - is
 * dropped, not refused: the step itself is still worth keeping. Pure.
 */
export function stepProps(step: OnboardingStepName, raw: unknown): StepProps {
  const allowed = ALLOWED[step];
  if (!allowed || !raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, list] of Object.entries(allowed)) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string" && list.includes(value)) out[key] = value;
  }
  return out as StepProps;
}

/** Steps about one checkout form: the Stripe session's id rides along once there is one. */
export const CHECKOUT_STEPS: readonly OnboardingStepName[] = ["checkout_closed", "checkout_failed"];

/** Steps about one article: the article's id is part of the event, and the workspace is the article's. */
export const ARTICLE_STEPS: readonly OnboardingStepName[] = ["article_opened", "article_copied", "article_approved", "next_up_clicked"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An id as the database makes them, or undefined: never a free string in an event. */
export function uuidOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
}

const CHECKOUT_SESSION = /^cs_(test|live)_[A-Za-z0-9]{8,200}$/;
/**
 * A Stripe Checkout Session id (`cs_live_…`), or undefined. It is not a
 * UUID, so `uuidOrUndefined` would drop it; the server still keeps it only
 * when it is the account's own session (step-events.ts `ownedCheckoutSession`).
 */
export function checkoutSessionOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && CHECKOUT_SESSION.test(value) ? value : undefined;
}

/**
 * What makes one event of a step different from another of the same step on
 * the same site, or "" when the step is kept once per site (every step before
 * these, unchanged). Kept once per:
 *   setup_ending_shown  ending           (writing, then article, is two)
 *   article_opened      article, from
 *   article_copied      article, format, surface
 *   article_approved    article          (the first approval; an edit clears
 *                                         approved_at, the event stays)
 *   run_started         run              (every run, each with its trigger)
 *   next_up_clicked     article, target  (the draft Next up named)
 *   trial_clicked       button, plan, interval, checkout (without a
 *                                         button, once per site, as before)
 *   checkout_closed     session, button, how   (a form closed before Stripe
 *   checkout_failed     session, button, stage, checkout  gave it a session
 *                                         has none)
 * Shared by the browser's once-per-page-load and the server's once-ever.
 */
export function stepKey(step: OnboardingStepName, input: { articleId?: string | null; runId?: string | null; checkoutSession?: string | null; props?: StepProps }): string {
  const p = input.props ?? {};
  switch (step) {
    case "trial_clicked":
      return p.surface ? [p.surface, p.plan ?? "", p.interval ?? "", p.checkout ?? ""].join(":") : "";
    case "checkout_closed":
      return [input.checkoutSession ?? "", p.surface ?? "", p.how ?? ""].join(":");
    case "checkout_failed":
      return [input.checkoutSession ?? "", p.surface ?? "", p.stage ?? "", p.checkout ?? ""].join(":");
    case "setup_ending_shown":
      return p.ending ?? "";
    case "article_opened":
      return [input.articleId ?? "", p.from ?? ""].join(":");
    case "article_copied":
      return [input.articleId ?? "", p.format ?? "", p.surface ?? ""].join(":");
    case "article_approved":
      return input.articleId ?? "";
    case "run_started":
      return input.runId ?? "";
    case "next_up_clicked":
      return [input.articleId ?? "", p.target ?? ""].join(":");
    default:
      return "";
  }
}

/** The width as a bucket: below sm is a phone, below lg is where the gate stacks. */
export function viewportOf(width: number): Viewport {
  if (!Number.isFinite(width) || width < 640) return "mobile";
  return width < 1024 ? "tablet" : "desktop";
}

/** The browser's viewport now, or undefined on the server. */
export function currentViewport(): Viewport | undefined {
  return typeof window === "undefined" ? undefined : viewportOf(window.innerWidth);
}

/**
 * Where the editor was opened from, as one word. `previous` is the app path
 * shown before this one in the tab (lib/navigation/route-memory.ts), which
 * is what a client-side navigation leaves: `document.referrer` keeps the
 * first page of the visit. Without one, the referrer: another site (a mail
 * client in the browser, a search) is "external", none at all (a link from
 * a mail app, a bookmark) is "direct". Never the path or the site itself.
 */
export function openedFrom(previous: string | null | undefined, referrer: string, origin: string): OpenedFrom {
  if (previous) return pathBucket(previous);
  if (!referrer) return "direct";
  try {
    const url = new URL(referrer);
    return url.origin === origin ? pathBucket(url.pathname) : "external";
  } catch {
    return "direct";
  }
}

function pathBucket(path: string): OpenedFrom {
  const top = path.split(/[?#]/)[0].split("/")[1] ?? "";
  switch (top) {
    case "onboarding":
    case "checkout":
      return "setup";
    case "dashboard":
      return "dashboard";
    case "articles":
      return "articles";
    case "review":
      return "review";
    case "keywords":
      return "keywords";
    case "content":
      return "article";
    default:
      return "app";
  }
}

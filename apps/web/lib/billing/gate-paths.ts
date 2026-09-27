// ---------------------------------------------------------------------------
// Which dashboard pages an account before its trial may still open
// ---------------------------------------------------------------------------
//
// No trial, no dashboard: the layout sends an account that has not started
// its trial to /onboarding, where the first article's card and the trial
// offer are (app/(dashboard)/layout.tsx). One exception, because setup itself
// needs it: "Connect Search Console" on the wizard opens /connect/google in a
// new tab, and Google's OAuth callback lands on /connect or /connect/google
// (app/api/auth/google/callback/route.ts). Gating those would break the
// connection for every new signup. Neither page shows an article.
//
// The exception used to be "the whole dashboard, until the wizard is done",
// which let an account with a saved profile and an unfinished wizard into the
// calendar, the keywords, the reports and the editor's shell - and the
// profile-inference cron and the setup-unfinished email both make that
// account common.
//
// This module has no imports on purpose: middleware.ts runs it on the edge.

/**
 * The request header the middleware sets to the path being served, so a
 * layout - which Next does not tell its own path - can ask `openBeforeTrial`.
 * Always overwritten by the middleware, so a client cannot choose its value.
 */
export const REQUEST_PATH_HEADER = "x-altorank-path";

/** The dashboard paths the wizard opens, and nothing else. */
const OPEN_BEFORE_TRIAL = ["/connect"];

/**
 * Whether a gated account may open this dashboard path. An unknown path
 * (no header, so the middleware did not run) is not one of them.
 */
export function openBeforeTrial(path: string | null | undefined): boolean {
  if (!path) return false;
  return OPEN_BEFORE_TRIAL.some((p) => path === p || path.startsWith(`${p}/`));
}

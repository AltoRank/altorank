// ---------------------------------------------------------------------------
// How the setup screen keeps watching a run through a bad connection
// ---------------------------------------------------------------------------
//
// The screen used to give up after ten failed polls in a row - thirty seconds
// at the fast cadence - and wrote that into the run's state as an error. Any
// error is terminal on the client, so a phone switching networks or a deploy
// blip turned a run that was still going on the server into "Setup did not
// finish" (UX audit 2026-10-12, #14). The run is a row advanced by its own
// invocations; only the server can say it is over.
//
// So a failed poll never ends anything. After RECONNECTING_AFTER failures in
// a row the screen says "Reconnecting…", the wait doubles up to
// MAX_BACKOFF_MS, and the screen asks again the moment the tab is visible.
// The first successful answer clears it. Pure.

/** Every three seconds while the phases are moving. */
export const POLL_MS = 3_000;
/** After two minutes the run is in the draft, where nothing changes for a while. */
export const POLL_SLOW_MS = 10_000;
export const POLL_BACKOFF_AFTER_MS = 2 * 60_000;
/** Failed polls in a row before the screen says it is reconnecting: one miss is noise. */
export const RECONNECTING_AFTER = 2;
/** The longest wait between attempts while the server cannot be reached. */
export const MAX_BACKOFF_MS = 30_000;

/** How long to wait before the next poll, given the failures in a row and how long the screen has watched. */
export function nextPollDelay(failures: number, watchedMs: number): number {
  const base = watchedMs > POLL_BACKOFF_AFTER_MS ? POLL_SLOW_MS : POLL_MS;
  if (failures <= 0) return base;
  return Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** (failures - 1));
}

/** Whether the screen should say it is reconnecting. */
export function reconnecting(failures: number): boolean {
  return failures >= RECONNECTING_AFTER;
}

/**
 * The server's own refusal, which is an answer and not a blip: 401 the
 * session has ended, 403 or 404 this person can no longer see the site.
 * Retrying it every 30 seconds behind "Reconnecting…" spun a signed-out tab
 * forever (review, 2026-10-12). Null for anything worth trying again.
 */
export type PollRefusal = "signed-out" | "no-access";
export function pollRefusal(status: number): PollRefusal | null {
  if (status === 401) return "signed-out";
  if (status === 403 || status === 404) return "no-access";
  return null;
}

/** The same refusal this many times in a row ends the watching: one may be a hiccup in the auth check. */
export const REFUSALS_TO_STOP = 2;

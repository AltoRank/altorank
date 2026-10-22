// ---------------------------------------------------------------------------
// One refusal per host, then silence
// ---------------------------------------------------------------------------
//
// packhub.io, measured 2026-09-10 from a residential address: about twenty
// requests in forty seconds trips a ban that answers 403 for fifteen to forty
// seconds. A sliding window, so every request made while refused - a retry
// with another agent, the readiness check's next resource, the pages phase's
// eight fetches - keeps the site over the line. The onboarding run that
// waited 45s and tried again was still refused, because nothing around the
// wait had stopped knocking.
//
// This is the stop. The first refusal from a host is recorded; until the
// caller clears it, every fetcher in the run answers a request to that host
// with the refusal it already has, without touching the network. The one
// place that waits the window out (`crawlWithRetry`) clears it afterwards.
//
// Process-local and self-expiring: a serverless invocation is one run, and a
// stale entry in a warm process costs at most one skipped minute.

const REFUSING_FOR_MS = 60_000;
const until = new Map<string, number>();
const kinds = new Map<string, RefusalKind>();

/**
 * What the refusal looked like, for the sentence the run screen shows.
 *
 *   challenge  a bot check (Cloudflare's `cf-mitigated: challenge`, the "Just
 *              a moment..." page): the site's own wall, which no wait clears
 *   rate       429: a rate limit, which clears on its own
 *   refused    403 or 406 with nothing else to go on: a ban that clears in a
 *              minute (packhub.io) or a firewall rule that never does
 */
export type RefusalKind = "challenge" | "rate" | "refused";

/**
 * The pages step's sentence for a host that refused us. It said "rate-limiting
 * us right now" for every refusal, and a site behind a Cloudflare challenge
 * that no night will lift was told to wait for the nightly pass.
 */
export function refusalLine(kind: RefusalKind | null): string {
  if (kind === "challenge") {
    return "Your site sits behind a bot check that turns automated readers away, so we could not read its pages. Allow AltoRankBot through it in your firewall or Cloudflare settings and the next look reads them.";
  }
  if (kind === "rate") return "The site is rate-limiting us right now; the nightly pass reads your existing pages.";
  return "The site turned our reader away (HTTP 403). If it was a rate limit, the nightly pass reads your pages; if it keeps happening, allow AltoRankBot in your firewall or host settings.";
}

/** Classify a refused response. */
export function refusalOf(res: { status: number; headers: { get(name: string): string | null } }): RefusalKind {
  if (res.headers.get("cf-mitigated") === "challenge") return "challenge";
  return res.status === 429 ? "rate" : "refused";
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The host answered 403/406/429: stop asking it anything for a while. */
export function noteRefusal(url: string, now: number = Date.now(), kind: RefusalKind = "refused"): void {
  const h = hostOf(url);
  if (!h) return;
  until.set(h, now + REFUSING_FOR_MS);
  // A challenge seen once in the run is the answer: a later plain 403 from
  // the same wall must not demote it.
  if (kinds.get(h) !== "challenge") kinds.set(h, kind);
}

/** How the host refused us this run, while it is refusing; null otherwise. */
export function refusalKind(url: string, now: number = Date.now()): RefusalKind | null {
  if (!refusing(url, now)) return null;
  const h = hostOf(url);
  return (h && kinds.get(h)) || "refused";
}

/** Is this host currently refusing us? A request now would only extend it. */
export function refusing(url: string, now: number = Date.now()): boolean {
  const h = hostOf(url);
  if (!h) return false;
  const t = until.get(h);
  if (t === undefined) return false;
  if (t <= now) {
    until.delete(h);
    kinds.delete(h);
    return false;
  }
  return true;
}

/** The window has been waited out; the next request is a fresh one. */
export function clearRefusal(url: string): void {
  const h = hostOf(url);
  if (h) {
    until.delete(h);
    kinds.delete(h);
  }
}

/** Tests only: forget every host. */
export function resetHostCircuit(): void {
  until.clear();
  kinds.clear();
}

export const REFUSED_STATUSES = new Set([403, 406, 429]);

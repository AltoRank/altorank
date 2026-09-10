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

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The host answered 403/406/429: stop asking it anything for a while. */
export function noteRefusal(url: string, now: number = Date.now()): void {
  const h = hostOf(url);
  if (h) until.set(h, now + REFUSING_FOR_MS);
}

/** Is this host currently refusing us? A request now would only extend it. */
export function refusing(url: string, now: number = Date.now()): boolean {
  const h = hostOf(url);
  if (!h) return false;
  const t = until.get(h);
  if (t === undefined) return false;
  if (t <= now) {
    until.delete(h);
    return false;
  }
  return true;
}

/** The window has been waited out; the next request is a fresh one. */
export function clearRefusal(url: string): void {
  const h = hostOf(url);
  if (h) until.delete(h);
}

/** Tests only: forget every host. */
export function resetHostCircuit(): void {
  until.clear();
}

export const REFUSED_STATUSES = new Set([403, 406, 429]);

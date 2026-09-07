// ---------------------------------------------------------------------------
// How many times we try, and when we give up
// ---------------------------------------------------------------------------
//
// Three constants and one predicate, in a file of their own because the
// connector help text quotes the attempt count (lib/cms/connector-notes.ts,
// read by a "use client" dialog) and the retry loop that uses them talks to
// the database (lib/cms/delivery.ts, which records every attempt). Importing
// a number should not drag the service role into a browser bundle: that is
// how #172 first failed CI.
//
// `delivery.ts` re-exports all three, so nothing server-side has to know this
// file exists.

export const MAX_ATTEMPTS = 3;
/** Wait before attempt 2 and attempt 3. */
export const RETRY_DELAYS_MS = [500, 2000];

/**
 * Worth another go. A 429 is the endpoint asking us to wait and a 5xx is it
 * being broken; any other 4xx is it saying no, and repeating the request will
 * get the same answer.
 */
export function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

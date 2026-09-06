// ---------------------------------------------------------------------------
// HTTP delivery with retries, and a record of every attempt
// ---------------------------------------------------------------------------
//
// The one retry loop for adapters that talk to an endpoint the customer runs
// (the generic webhook, the WordPress plugin). Three attempts with backoff on
// network errors, 429 and 5xx; any other 4xx is the endpoint saying no and is
// not retried. Each attempt is reported through `onDelivery`, which the publish
// core turns into a publish_log row, so an endpoint that failed twice and then
// accepted the article shows all three tries and not only the outcome.
//
// This is transport retry: it happens inside one publish call. Retrying a
// publish that failed after all attempts is a person's decision and lives in
// lib/publishing/retry.ts.

import type { AdapterContext, DeliveryAttempt } from "./types";

export const MAX_ATTEMPTS = 3;
/** Wait before attempt 2 and attempt 3. */
export const RETRY_DELAYS_MS = [500, 2000];

export function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DeliveryOptions {
  /** One HTTP request. Called once per attempt. */
  send: () => Promise<Response>;
  /** Names the operation in the error: "Webhook publish", "WordPress plugin update". */
  what: string;
  onDelivery?: AdapterContext["onDelivery"];
  /** Text for a failed response. Default: `HTTP <status>: <first 500 chars of body>`. */
  describe?: (res: Response) => Promise<string>;
  /** The error thrown once the attempts are used up. Default: `<what> failed: <lastError>`. */
  fail?: (lastError: string, lastStatus: number | undefined) => Error;
}

async function defaultDescribe(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return `HTTP ${res.status}${text ? `: ${text.slice(0, 500)}` : ""}`;
}

/**
 * Resolves with the successful response; throws with the last failure once the
 * attempts are used up or the endpoint answered with a non-retryable status.
 * A failing `onDelivery` never fails the delivery: the log must not decide
 * whether the article ships.
 */
export async function deliverWithRetry(opts: DeliveryOptions): Promise<Response> {
  const describe = opts.describe ?? defaultDescribe;
  const report = async (attempt: DeliveryAttempt) => {
    try {
      await opts.onDelivery?.(attempt);
    } catch {
      // See above.
    }
  };

  let lastError = "";
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response | undefined;
    try {
      res = await opts.send();
    } catch (e) {
      lastError = (e as Error).message;
      lastStatus = undefined;
    }

    if (res?.ok) {
      await report({ attempt, maxAttempts: MAX_ATTEMPTS, ok: true, status: res.status });
      return res;
    }

    if (res) {
      lastStatus = res.status;
      lastError = await describe(res);
    }
    await report({ attempt, maxAttempts: MAX_ATTEMPTS, ok: false, status: res?.status, error: lastError });

    if (res && !retryable(res.status)) break;
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 0);
  }
  throw opts.fail ? opts.fail(lastError, lastStatus) : new Error(`${opts.what} failed: ${lastError}`);
}

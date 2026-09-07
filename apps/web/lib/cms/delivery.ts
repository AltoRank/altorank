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
import { recordEvent } from "@/lib/observability/record";
import { MAX_ATTEMPTS, RETRY_DELAYS_MS, retryable } from "./retry-policy";

// The numbers themselves live in ./retry-policy, which has no imports: the
// connector help text quotes MAX_ATTEMPTS from a client component, and this
// file reaches the database. Re-exported so every server-side caller keeps
// importing them from here.
export { MAX_ATTEMPTS, RETRY_DELAYS_MS, retryable };

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
  /**
   * Where the request went, for the operational log only. Reduced to its host
   * before it is stored, and optional: an adapter that does not pass it simply
   * records a failure with no host.
   */
  endpoint?: string;
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
  // Out of attempts, or told no by a status there is no point retrying.
  //
  // Every attempt is already a publish_log row (lib/publishing/core.ts passes
  // an `onDelivery` that writes one), so the customer's own history is
  // complete. What was missing is the cross-account view: nobody can ask "how
  // many customer endpoints refused us this week", because publish_log is read
  // one workspace at a time from inside that workspace's dashboard.
  //
  // No agency or workspace id here on purpose — this function is two layers
  // below the one that knows them, and inventing an argument for the whole CMS
  // adapter chain to thread through would be a bigger change than the log is
  // worth. The publish_log row written at the same instant carries both.
  await recordEvent({
    level: "error",
    source: "cms.delivery",
    message: retryable(lastStatus ?? 0)
      ? `${opts.what}: gave up after ${MAX_ATTEMPTS} attempts.`
      : `${opts.what}: the endpoint refused it.`,
    context: {
      what: opts.what,
      // A number, not the endpoint: a customer's webhook URL can carry a token
      // in its path, and the host is enough to recognise whose it is.
      host: hostOf(opts),
      attempts: MAX_ATTEMPTS,
      lastStatus: lastStatus ?? null,
      lastError,
      retryable: lastStatus === undefined ? true : retryable(lastStatus),
    },
  });

  throw opts.fail ? opts.fail(lastError, lastStatus) : new Error(`${opts.what} failed: ${lastError}`);
}

/**
 * The host a delivery was aimed at, when the caller told us, and never the
 * full URL: a webhook path can itself be the credential.
 */
function hostOf(opts: DeliveryOptions): string | null {
  if (!opts.endpoint) return null;
  try {
    return new URL(opts.endpoint).host;
  } catch {
    return null;
  }
}

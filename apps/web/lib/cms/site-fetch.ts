// ---------------------------------------------------------------------------
// Requests to a site address a person typed into a connect dialog
// ---------------------------------------------------------------------------
//
// A CMS adapter that talks to the customer's own server (the WordPress plugin)
// sends requests to whatever site URL was typed in, from inside our
// deployment. That is the same server-side request surface the public tools
// guard in lib/public-tools/safe-fetch.ts, and it gets the same address
// policy:
//
//   - http or https only, no credentials in the URL, ports 80/443/8080/8443,
//     no local or reserved hostname (assertFetchableUrl);
//   - the name is resolved once, refused if ANY address it resolves to is
//     private, and the vetted address goes straight to the socket
//     (guardedLookup), so there is no second resolution to rebind;
//   - redirects are not followed: a site's REST endpoint answering with a
//     redirect is reported, not chased to wherever it points;
//   - one deadline and a size cap on the response.
//
// ALTORANK_ALLOW_PRIVATE_FETCH=1 lifts the address policy, as it does for the
// crawlers (lib/audit/lenient-fetch.ts): a self-hosted install publishing to a
// WordPress on its own network needs exactly that. Redirects stay unfollowed.
//
// Returns a standard Response, so callers read it like fetch's.

import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { assertFetchableUrl, guardedLookup, UnsafeUrlError } from "@/lib/public-tools/safe-fetch";

export interface SiteFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Whole-request deadline. Default 30s. */
  timeoutMs?: number;
  /** Response body cap in bytes. Default 5 MB. */
  maxBytes?: number;
}

export const SITE_FETCH_TIMEOUT_MS = 30_000;
export const SITE_FETCH_MAX_BYTES = 5_000_000;

export function privateFetchAllowed(): boolean {
  return process.env.ALTORANK_ALLOW_PRIVATE_FETCH === "1";
}

/**
 * Throws UnsafeUrlError unless `url` is one the guarded path will request.
 * The resolved address is checked again when the socket opens. A no-op when
 * ALTORANK_ALLOW_PRIVATE_FETCH=1.
 */
export function assertSiteUrl(url: string): void {
  if (privateFetchAllowed()) return;
  try {
    assertFetchableUrl(url);
  } catch (err) {
    throw siteUrlError(err);
  }
}

/** The public-tools wording speaks of "checking"; a connection publishes. */
function siteUrlError(err: unknown): Error {
  if (!(err instanceof UnsafeUrlError)) return err as Error;
  return new UnsafeUrlError(
    `${err.message.replace(/ Only public websites can be checked\.$/, "")} AltoRank connects to public sites only; a self-hosted install can set ALTORANK_ALLOW_PRIVATE_FETCH=1 to reach one on its own network.`,
  );
}

/** A request to a customer's site, under the policy above. */
export async function siteFetch(url: string, init: SiteFetchInit = {}): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? SITE_FETCH_TIMEOUT_MS;
  if (privateFetchAllowed()) {
    return fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  let target: URL;
  try {
    target = assertFetchableUrl(url);
  } catch (err) {
    throw siteUrlError(err);
  }
  try {
    return await requestOnce(target, init, timeoutMs, true);
  } catch (err) {
    throw siteUrlError(err);
  }
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (name === "set-cookie" || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

/**
 * The body as the server meant it, held to the same size cap once decoded: a
 * few kilobytes compressed can stand for gigabytes.
 */
function decode(body: Buffer, encoding: string | undefined, maxBytes: number): Buffer {
  const opts = { maxOutputLength: maxBytes };
  try {
    switch ((encoding ?? "").trim().toLowerCase()) {
      case "gzip":
      case "x-gzip":
        return gunzipSync(body, opts);
      case "deflate":
        return inflateSync(body, opts);
      case "br":
        return brotliDecompressSync(body, opts);
      default:
        return body;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) {
      throw new Error(`the response was larger than ${maxBytes} bytes`);
    }
    throw err;
  }
}

/**
 * One request over node:http(s). `guard: false` exists for the unit tests'
 * loopback server and nothing else.
 */
export function requestOnce(target: URL, init: SiteFetchInit, timeoutMs: number, guard: boolean): Promise<Response> {
  const maxBytes = init.maxBytes ?? SITE_FETCH_MAX_BYTES;
  const payload = init.body !== undefined ? Buffer.from(init.body, "utf8") : undefined;
  const headers: Record<string, string> = {
    "Accept-Encoding": "gzip, deflate, br",
    ...init.headers,
    ...(payload ? { "Content-Length": String(payload.length) } : {}),
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      { method: init.method ?? "GET", headers, ...(guard ? { lookup: guardedLookup as never } : {}) },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) {
            const err = new Error(`the response was larger than ${maxBytes} bytes`);
            done(() => reject(err));
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          done(() => {
            try {
              const status = res.statusCode ?? 0;
              if (status < 200 || status > 599) throw new Error(`unexpected HTTP status ${status}`);
              const responseHeaders = toHeaders(res.headers);
              const body = NULL_BODY.has(status)
                ? null
                : new Uint8Array(decode(Buffer.concat(chunks), res.headers["content-encoding"], maxBytes));
              responseHeaders.delete("content-encoding");
              responseHeaders.delete("content-length");
              resolve(new Response(body, { status, statusText: res.statusMessage, headers: responseHeaders }));
            } catch (err) {
              reject(err);
            }
          }),
        );
        res.on("error", (err) => done(() => reject(err)));
      },
    );

    const timer = setTimeout(() => req.destroy(new Error("timed out")), timeoutMs);
    req.on("error", (err) => done(() => reject(err)));
    if (payload) req.write(payload);
    req.end();
  });
}

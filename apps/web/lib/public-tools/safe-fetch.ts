// ---------------------------------------------------------------------------
// Fetching a URL an anonymous visitor typed, without becoming their proxy
// ---------------------------------------------------------------------------
//
// The public tools fetch whatever URL they are handed, from inside our
// deployment, and show the response. That is a server-side request forgery
// surface by construction, so every request here goes through four gates:
//
//   1. The URL: http or https only, no credentials, ports 80/443/8080/8443
//      only, and no local or reserved hostname (lib/audit/lenient-fetch.ts
//      `isPrivateHost`, the same list every crawler uses).
//   2. The address, AFTER DNS resolution. `fetchSite` checks literal
//      addresses only, so a public name that resolves to 10.0.0.1 or
//      169.254.169.254 gets through it. Here the socket is opened through a
//      `lookup` hook that resolves the name, refuses the connection if ANY
//      address is private, and hands the vetted address straight to the
//      socket - so there is no second resolution to rebind between the check
//      and the connect.
//   3. Every redirect hop is followed by hand and goes back through 1 and 2,
//      with a hop cap and a loop check.
//   4. Size and time: the body is cut at `maxBytes` (after decompression, so
//      a gzip bomb stops at the same place), and the whole chain has one
//      deadline.
//
// Deliberately NOT lifted by ALTORANK_ALLOW_PRIVATE_FETCH. That flag lets a
// self-hosted install crawl its own LAN from an authenticated workspace; on
// an unauthenticated endpoint it would hand the LAN to anyone with curl.
//
// A certificate chain Node cannot verify is retried once without
// verification and reported (`tlsUnverified`), the same policy as
// `fetchSite`: for a read-only fetch that sends no credential, a broken chain
// is a finding, not a reason to show nothing.

import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable, Transform } from "node:stream";
import { isPrivateHost, isTlsChainError } from "@/lib/audit/lenient-fetch";

/** The URL or the address it resolves to is not a public website. Maps to `invalid_input`. */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** The request went out and failed: DNS, connect, TLS, timeout. Maps to `upstream`. */
export class FetchFailedError extends Error {
  constructor(
    message: string,
    public readonly url: string,
  ) {
    super(message);
    this.name = "FetchFailedError";
  }
}

// ── address policy ────────────────────────────────────────────────────────────

const BLOCKED = new BlockList();
// IPv4: "this network", RFC 1918, CGNAT, loopback, link-local (incl. cloud
// metadata at 169.254.169.254), IETF protocol assignments, the three
// documentation nets, 6to4 relay, benchmarking, multicast and reserved up to
// broadcast.
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
// IPv6: unspecified, loopback, discard, documentation, ORCHID, unique local,
// link-local, site-local (deprecated), multicast.
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2001:10::", 28],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

/** The IPv4 address an IPv6 address carries, for the forms that route to it. */
function embeddedIpv4(v6: string): string | null {
  const h = v6.toLowerCase();
  // ::ffff:1.2.3.4 (mapped), ::1.2.3.4 (compatible, deprecated), 64:ff9b::1.2.3.4 (NAT64)
  const dotted = h.match(/^(?:::ffff:|::|64:ff9b::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  const hex = h.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/**
 * Whether a resolved address is somewhere a public website cannot be.
 * Anything that is not a valid IP is refused.
 */
export function isBlockedAddress(address: string): boolean {
  const a = address.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(a);
  if (family === 4) return BLOCKED.check(a, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(a);
    if (v4) return isIP(v4) !== 4 || BLOCKED.check(v4, "ipv4");
    return BLOCKED.check(a, "ipv6");
  }
  return true;
}

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

/**
 * Throws UnsafeUrlError unless `raw` is a URL this module will fetch. Checks
 * the shape only; the resolved address is checked when the socket opens.
 */
export function assertFetchableUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError("That is not a URL that can be fetched.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new UnsafeUrlError(`Only http and https URLs can be fetched, not ${u.protocol.replace(/:$/, "")}.`);
  }
  if (u.username || u.password) {
    throw new UnsafeUrlError("URLs with a username or password are not fetched.");
  }
  if (!ALLOWED_PORTS.has(u.port)) {
    throw new UnsafeUrlError(`Port ${u.port} is not fetched. Public websites answer on 80 or 443.`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) ? isBlockedAddress(host) : isPrivateHost(u.hostname)) {
    throw new UnsafeUrlError(`${u.hostname} is a private or local address. Only public websites can be checked.`);
  }
  return u;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` for http.request that refuses private addresses. Resolves every
 * address and refuses the whole name if any one is private, rather than
 * picking a public one: a name that mixes the two is either misconfigured or
 * built to slip past a check like this one.
 */
export function guardedLookup(
  hostname: string,
  options: { family?: number | string; all?: boolean } | number | undefined,
  callback: LookupCallback,
): void {
  const opts = typeof options === "object" && options !== null ? options : {};
  const family = typeof options === "number" ? options : typeof opts.family === "number" ? opts.family : 0;
  dnsLookup(hostname, { all: true, family: family as 0 | 4 | 6 }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = (addresses ?? []) as LookupAddress[];
    if (list.length === 0) {
      const e = new Error(`${hostname} did not resolve`) as NodeJS.ErrnoException;
      e.code = "ENOTFOUND";
      return callback(e, "");
    }
    if (list.some((a) => isBlockedAddress(a.address))) {
      return callback(
        new UnsafeUrlError(
          `${hostname} resolves to a private or local address. Only public websites can be checked.`,
        ) as NodeJS.ErrnoException,
        "",
      );
    }
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

// ── one request ───────────────────────────────────────────────────────────────

export const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; AltoRank-Tools/1.0; +https://altorank.co)";
export const DEFAULT_MAX_BYTES = 3_000_000;
export const DEFAULT_TIMEOUT_MS = 12_000;
export const DEFAULT_MAX_REDIRECTS = 5;

export interface HopRequest {
  url: string;
  method: "GET" | "HEAD";
  headers: Record<string, string>;
  maxBytes: number;
  /** Absolute epoch ms by which this hop must have finished. */
  deadline: number;
  signal?: AbortSignal;
}

export interface HopResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  tlsUnverified: boolean;
}

export type HopFn = (req: HopRequest) => Promise<HopResponse>;

function flattenHeaders(raw: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "set-cookie") continue; // never shown, never needed
    if (typeof v === "string") out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(", ");
  }
  return out;
}

function decoderFor(encoding: string | undefined): Transform | null {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      return null;
  }
}

function describeNetworkError(err: unknown): string {
  const code = (err as { code?: string })?.code;
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "the domain does not resolve";
    case "ECONNREFUSED":
      return "the server refused the connection";
    case "ECONNRESET":
      return "the server closed the connection";
    case "ETIMEDOUT":
      return "timed out";
    case "CERT_HAS_EXPIRED":
      return "its TLS certificate has expired";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "its TLS certificate is for a different name";
    default:
      return (err as Error)?.message || "the request failed";
  }
}

function requestOnce(req: HopRequest, verifyTls: boolean, guard: boolean): Promise<HopResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(req.url);
    const remaining = req.deadline - Date.now();
    if (remaining <= 0) return reject(new FetchFailedError("timed out", req.url));
    if (req.signal?.aborted) return reject(new FetchFailedError("cancelled", req.url));

    let settled = false;
    const onAbort = () => client.destroy(new FetchFailedError("cancelled", req.url));
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const client = (u.protocol === "https:" ? httpsRequest : httpRequest)(
      u,
      {
        method: req.method,
        headers: req.headers,
        rejectUnauthorized: verifyTls,
        ...(guard ? { lookup: guardedLookup as never } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const headers = flattenHeaders(res.headers);
        if (req.method === "HEAD" || (status >= 300 && status < 400 && headers.location)) {
          res.resume();
          return done(() =>
            resolve({ status, headers, body: Buffer.alloc(0), truncated: false, tlsUnverified: !verifyTls }),
          );
        }
        const decoder = decoderFor(headers["content-encoding"]);
        const stream: Readable = decoder ? res.pipe(decoder) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const finish = () =>
          done(() => resolve({ status, headers, body: Buffer.concat(chunks), truncated, tlsUnverified: !verifyTls }));
        stream.on("data", (c: Buffer) => {
          if (truncated) return;
          const room = req.maxBytes - size;
          if (c.length >= room) {
            chunks.push(c.subarray(0, room));
            size += room;
            truncated = true;
            finish();
            res.destroy();
            decoder?.destroy();
            return;
          }
          chunks.push(c);
          size += c.length;
        });
        stream.on("end", finish);
        stream.on("error", (err) => {
          // A body that fails to decompress part-way still gave us its start.
          if (chunks.length) finish();
          else done(() => reject(new FetchFailedError(err.message || "the response could not be read", req.url)));
        });
        res.on("error", (err) => {
          if (chunks.length) finish();
          else done(() => reject(new FetchFailedError(err.message, req.url)));
        });
      },
    );

    const timer = setTimeout(() => client.destroy(new FetchFailedError("timed out", req.url)), remaining);
    req.signal?.addEventListener("abort", onAbort, { once: true });

    client.on("error", (err) => {
      done(() => {
        if (err instanceof UnsafeUrlError || err instanceof FetchFailedError) return reject(err);
        // Keep the original: the caller decides whether a TLS chain error is worth a retry.
        const wrapped = new FetchFailedError(describeNetworkError(err), req.url);
        (wrapped as unknown as { cause: unknown }).cause = err;
        reject(wrapped);
      });
    });
    client.end();
  });
}

/**
 * The real network hop: guarded lookup, verified TLS first, and one retry
 * without verification when the only problem is the certificate chain.
 * `guard: false` exists for the unit tests' loopback server and nothing else.
 */
export function makeNodeHop(guard = true): HopFn {
  return async (req) => {
    try {
      return await requestOnce(req, true, guard);
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause;
      if (err instanceof FetchFailedError && cause && isTlsChainError(cause)) {
        return requestOnce(req, false, guard);
      }
      throw err;
    }
  };
}

// ── the chain ─────────────────────────────────────────────────────────────────

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  userAgent?: string;
  /** Extra request headers. A User-Agent here overrides `userAgent`. */
  headers?: Record<string, string>;
  /** Body cap in bytes, after decompression. Default 3 MB. */
  maxBytes?: number;
  /** One deadline for the whole redirect chain. Default 12s. */
  timeoutMs?: number;
  /** Hop cap. Default 5. */
  maxRedirects?: number;
  /** false: return the first 3xx as-is, for a caller that wants to see it. */
  followRedirects?: boolean;
  signal?: AbortSignal;
}

export interface RedirectHop {
  url: string;
  status: number;
  location: string;
}

export interface SafeFetchResult {
  /** The URL that was asked for. */
  requestedUrl: string;
  /** The URL that produced this response, after redirects. */
  url: string;
  status: number;
  /** Lower-cased names. Set-Cookie is dropped. */
  headers: Record<string, string>;
  /** Decoded text. Empty for HEAD and for a redirect that was not followed. */
  body: string;
  /** Bytes as received (after Content-Encoding), for sniffing binary bodies such as .xml.gz. */
  bodyBuffer: Buffer;
  bytes: number;
  truncated: boolean;
  redirects: RedirectHop[];
  tlsUnverified: boolean;
  timeMs: number;
}

export type SafeFetch = (url: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;

/** Decode a body with the charset its Content-Type names, UTF-8 otherwise. */
export function decodeBody(buf: Buffer, contentType: string | undefined): string {
  const charset = (contentType ?? "").match(/charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(buf);
    } catch {
      // unknown label: fall through to UTF-8
    }
  }
  return buf.toString("utf8");
}

/**
 * Follows redirects by hand so every hop is re-validated. Exported with an
 * injectable hop so the redirect policy is testable without a network.
 */
export async function fetchChain(url: string, opts: SafeFetchOptions, hop: HopFn): Promise<SafeFetchResult> {
  const started = Date.now();
  const deadline = started + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const follow = opts.followRedirects ?? true;
  let method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    "User-Agent": opts.userAgent ?? DEFAULT_USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en;q=0.9, *;q=0.5",
    ...opts.headers,
  };

  const redirects: RedirectHop[] = [];
  const seen = new Set<string>();
  let current = assertFetchableUrl(url).toString();
  let tlsUnverified = false;

  for (;;) {
    seen.add(current);
    const res = await hop({
      url: current,
      method,
      headers,
      maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
      deadline,
      signal: opts.signal,
    });
    tlsUnverified ||= res.tlsUnverified;

    const location = res.headers.location;
    if (follow && res.status >= 300 && res.status < 400 && location) {
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        throw new FetchFailedError(`it redirected to an invalid location (${location.slice(0, 200)})`, current);
      }
      redirects.push({ url: current, status: res.status, location: next });
      if (redirects.length > maxRedirects) {
        throw new FetchFailedError(`it redirected more than ${maxRedirects} times`, url);
      }
      if (seen.has(next)) throw new FetchFailedError("it redirects in a loop", current);
      // Re-validated here, and again at connect time by the guarded lookup.
      current = assertFetchableUrl(next).toString();
      if (res.status === 303 && method !== "HEAD") method = "GET";
      continue;
    }

    return {
      requestedUrl: url,
      url: current,
      status: res.status,
      headers: res.headers,
      body: method === "HEAD" ? "" : decodeBody(res.body, res.headers["content-type"]),
      bodyBuffer: res.body,
      bytes: res.body.length,
      truncated: res.truncated,
      redirects,
      tlsUnverified,
      timeMs: Date.now() - started,
    };
  }
}

const nodeHop = makeNodeHop(true);

/** Fetch a public URL with the full guard. The only fetch a public tool should use. */
export const safeFetch: SafeFetch = (url, opts = {}) => fetchChain(url, opts, nodeHop);

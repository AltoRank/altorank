// A GET that tolerates a certificate chain Node cannot verify.
//
// www.lully.ai (2026-09-02) serves its leaf certificate without the
// intermediate. Browsers fetch the missing link themselves (AIA); Node's TLS
// stack does not, so every fetch failed with UNABLE_TO_VERIFY_LEAF_SIGNATURE
// and the site read as unreachable. For a read-only crawler that never sends
// a credential, an unverifiable chain is a finding to report, not a reason to
// see nothing. So: verify first, and only on a chain error retry here, with
// verification off and the result marked so the audit can say so.
//
// Never used for anything that sends data. Never the first attempt.

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

// ---------------------------------------------------------------------------
// Where a crawl is allowed to go
// ---------------------------------------------------------------------------
//
// Every crawler in the app fetches whatever URL it was handed, and one of
// them (checkHealthAction, the free SEO health checker) takes that URL from
// an anonymous form. Nothing stopped `http://169.254.169.254/` or
// `http://localhost:54321/`: the fetch ran from inside the deployment and the
// response body came back in the result. A public website is never on a
// private address, so a private address is refused before any request goes
// out - here, because this is the one door every crawler already uses.
//
// Literal addresses and local names only. A public hostname that resolves to
// a private address (DNS rebinding) is not caught; that needs the resolver
// hook that `fetch()` does not offer. ALTORANK_ALLOW_PRIVATE_FETCH=1 lifts
// the guard for a self-hosted install crawling its own LAN.

const LOCAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

function ipv4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** RFC 1918, loopback, link-local, CGNAT, "this network", broadcast. */
function isPrivateIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  // IPv4 embedded in IPv6: ::ffff:10.0.0.1 and ::ffff:a00:1 forms.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mapped) {
    const parts = ipv4Parts(mapped[1]);
    return parts ? isPrivateIpv4(parts) : true;
  }
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h)) return true;
  // fc00::/7 unique local, fe80::/10 link-local.
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

/**
 * Whether `hostname` (as `new URL(url).hostname` gives it, brackets kept for
 * IPv6) names something that can only be reached from inside a network.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (LOCAL_HOSTNAMES.has(h) || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h.startsWith("[") && h.endsWith("]")) return isPrivateIpv6(h.slice(1, -1));
  if (h.includes(":")) return isPrivateIpv6(h);
  const v4 = ipv4Parts(h);
  if (v4) return isPrivateIpv4(v4);
  // Decimal / octal / hex spellings of an IPv4 address (http://2130706433/,
  // http://0x7f000001/) resolve to loopback in most stacks. Refuse the shape
  // rather than decode it.
  if (/^(0x[0-9a-f]+|\d+)$/.test(h)) return true;
  return false;
}

/**
 * Throws when a crawler is about to fetch something that is not a public
 * website: a non-http scheme, or a private / local address.
 */
export function assertPublicUrl(url: string): void {
  if (process.env.ALTORANK_ALLOW_PRIVATE_FETCH === "1") return;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Not a URL that can be crawled: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Only http and https sites can be crawled, not ${u.protocol.replace(/:$/, "")}`);
  }
  if (isPrivateHost(u.hostname)) {
    throw new Error(`${u.hostname} is a private or local address, and only public websites are crawled`);
  }
}

export interface LenientResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Always true here: the chain was not verified. */
  tlsUnverified: true;
}

export const TLS_CHAIN_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
]);

export function isTlsChainError(err: unknown): boolean {
  const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code
    ?? (err as { code?: string })?.code;
  return typeof code === "string" && TLS_CHAIN_CODES.has(code);
}

export function fetchLenient(
  url: string,
  opts: { userAgent: string; timeoutMs?: number; maxBytes?: number; redirects?: number } ,
): Promise<LenientResponse> {
  const redirects = opts.redirects ?? 5;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  return new Promise((resolve, reject) => {
    // Every hop: the recursive call below re-enters here with the Location
    // header, so a redirect to a private address is refused the same way.
    assertPublicUrl(url);
    const u = new URL(url);
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(
      u,
      {
        method: "GET",
        headers: { "User-Agent": opts.userAgent, Accept: "*/*" },
        rejectUnauthorized: false,
        timeout: opts.timeoutMs ?? 10_000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirects > 0) {
          res.resume();
          fetchLenient(new URL(location, u).toString(), { ...opts, redirects: redirects - 1 })
            .then(resolve, reject);
          return;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") headers[k.toLowerCase()] = v;
          else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          if (size < maxBytes) { chunks.push(c); size += c.length; }
        });
        res.on("end", () => resolve({ status, headers, body: Buffer.concat(chunks).toString("utf8"), tlsUnverified: true }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Drop-in for `fetch()` wherever the URL is someone else's site: verified
 * first, and only on a certificate-chain error re-read without verification.
 * Returns a real Response so call sites keep using .ok/.status/.text(); a
 * fallback read carries the header `x-altorank-tls-unverified: 1`.
 *
 * Every crawler, checker and scraper in this app must go through this or the
 * site with an incomplete chain (www.lully.ai, 2026-09-02) reads as empty in
 * one place and fine in another, and the product contradicts itself.
 */
export async function fetchSite(
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: RequestRedirect; timeoutMs?: number } = {},
): Promise<Response> {
  // Before anything leaves. `fetch()` follows redirects on its own, so a
  // public site that 302s to a private address is not caught here; the
  // lenient path below checks every hop.
  assertPublicUrl(url);
  try {
    return await fetch(url, { headers: init.headers, signal: init.signal, redirect: init.redirect ?? "follow" });
  } catch (err) {
    if (!isTlsChainError(err)) throw err;
    const ua =
      init.headers?.["User-Agent"] ?? init.headers?.["user-agent"] ?? "Mozilla/5.0 (compatible; AltoRank/1.0; +https://altorank.co)";
    const r = await fetchLenient(url, { userAgent: ua, timeoutMs: init.timeoutMs ?? 10_000 });
    const headers = new Headers();
    for (const [k, v] of Object.entries(r.headers)) {
      try { headers.set(k, v); } catch { /* a header name Node's Headers rejects; drop it */ }
    }
    headers.set("x-altorank-tls-unverified", "1");
    // Response() refuses 1xx and >599; a redirect cannot reach here because
    // fetchLenient followed it, so clamp anything odd to a plain 502.
    const status = r.status >= 200 && r.status <= 599 ? r.status : 502;
    return new Response(r.body, { status, headers });
  }
}

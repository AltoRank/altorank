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

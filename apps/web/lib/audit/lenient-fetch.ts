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

// ---------------------------------------------------------------------------
// The URL a visitor typed, as a zod field
// ---------------------------------------------------------------------------
//
// What arrives is whatever was in an address bar: "example.com", "www.x.io/
// pricing", "https://x.io". This turns it into one absolute http(s) URL or a
// sentence saying why not. Hostname rules come from the free check
// (`parsePublicDomain`: reserved TLDs, label lengths); the address rules from
// `assertFetchableUrl`. Resolution to a private address is caught later, at
// connect time, by safe-fetch.

import { z } from "zod";
import { isIP } from "node:net";
import { parsePublicDomain } from "@/lib/public-check/domain";
import { assertFetchableUrl, UnsafeUrlError } from "./safe-fetch";

export const URL_ERROR = "That does not look like a web address. Try https://example.com/page.";
const MAX_URL_LENGTH = 2048;

export type UrlParse = { ok: true; url: string } | { ok: false; error: string };

export function parsePublicUrl(raw: unknown): UrlParse {
  if (typeof raw !== "string") return { ok: false, error: URL_ERROR };
  let s = raw.trim();
  if (!s) return { ok: false, error: "Enter a web address, for example https://example.com." };
  if (s.length > MAX_URL_LENGTH) return { ok: false, error: "That address is too long." };
  if (s.startsWith("//")) s = `https:${s}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // No scheme. "mailto:x" and "javascript:x" have one and are refused below.
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return { ok: false, error: "Only http and https addresses can be checked." };
    s = `https://${s}`;
  }

  let u: URL;
  try {
    u = assertFetchableUrl(s);
  } catch (err) {
    const unparseable = !(err instanceof UnsafeUrlError) || /not a URL/.test(err.message);
    return { ok: false, error: unparseable ? URL_ERROR : err.message };
  }

  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!isIP(host)) {
    const domain = parsePublicDomain(host);
    if (!domain.ok) return { ok: false, error: domain.error === "That domain is not a public site." ? domain.error : URL_ERROR };
  }
  u.hash = "";
  return { ok: true, url: u.toString() };
}

/** zod field: a public http(s) URL, normalised. Accepts a bare domain. */
export const publicUrl = z.string({ error: "Enter a web address, for example https://example.com." }).transform((v, ctx) => {
  const r = parsePublicUrl(v);
  if (!r.ok) {
    ctx.addIssue({ code: "custom", message: r.error });
    return z.NEVER;
  }
  return r.url;
});

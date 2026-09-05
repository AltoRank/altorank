// What a visitor types into the free check is not a domain; it is whatever
// they copied from an address bar. This turns that into one lowercase
// hostname the checker can fetch, or says why it cannot.

import { normalizeDomain, DOMAIN_PATTERN } from "@/lib/growth-plan/build";

export type DomainParse =
  | { ok: true; domain: string }
  | { ok: false; error: string };

export const DOMAIN_ERROR = "That does not look like a domain. Try example.com.";

/**
 * Top-level labels that are never a public site. The check fetches whatever
 * it is given from a server we run, so a hostname that resolves to something
 * private is refused before any request is made.
 */
const RESERVED_TLDS = new Set([
  "localhost",
  "local",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "test",
  "invalid",
  "example",
  "onion",
  "arpa",
]);

/** RFC 1035 caps: 253 characters overall, 63 per label. */
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

export function parsePublicDomain(raw: unknown): DomainParse {
  if (typeof raw !== "string") return { ok: false, error: DOMAIN_ERROR };

  // Strip scheme, credentials, port, path and a trailing dot before the
  // shared normaliser gets it, so "https://user@www.example.com:443/x." and
  // "example.com" are the same site.
  let host = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  host = host.replace(/^[^/?#@]*@/, "");
  host = host.replace(/[/?#].*$/, "");
  host = host.replace(/:\d+$/, "");
  host = host.replace(/\.+$/, "");
  const domain = normalizeDomain(host);

  if (!domain || domain.length > MAX_HOST_LENGTH || !DOMAIN_PATTERN.test(domain)) {
    return { ok: false, error: DOMAIN_ERROR };
  }
  const labels = domain.split(".");
  if (labels.some((l) => l.length > MAX_LABEL_LENGTH)) {
    return { ok: false, error: DOMAIN_ERROR };
  }
  if (RESERVED_TLDS.has(labels[labels.length - 1])) {
    return { ok: false, error: "That domain is not a public site." };
  }
  return { ok: true, domain };
}
